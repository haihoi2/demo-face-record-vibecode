#!/usr/bin/env bash
# MT replay harness: MediaMTX + FFmpeg publishers on the Docker test network.
#
#   harness.sh up                         start MediaMTX (container mediamtx-<suffix>)
#   harness.sh publish <path> <clip> [loop|once] [start-delay-s]
#                                         publish a clip as rtsp://mediamtx-<suffix>:8554/<path>
#   harness.sh stop-publish <path>        stop that publisher (simulates a camera drop)
#   harness.sh ready <path>               print the path's readyTime (ISO, from the MediaMTX API)
#   harness.sh url <path>                 print the RTSP URL a gateway on the network should use
#   harness.sh status                     list harness containers
#   harness.sh down                       remove every harness container of this suffix
#
# Environment:
#   HARNESS_SUFFIX   container-name suffix, default "rt-mt" (names are always <role>-<suffix>)
#   HARNESS_NETWORK  Docker network, default "smartface-network"
#   HARNESS_IMAGE    image that carries ffmpeg, default "smartface-tests:<suffix>"
#   HARNESS_CPUS     CPU limit per publisher, default 0.5 (-c copy costs almost nothing)
#   CLIP_DIR         host directory holding the clips, default /data/test-clips
#
# Safety: the harness only ever creates, stops and removes containers whose
# names end in "-<suffix>". It never publishes a host port and never reads
# from a camera or NVR: publishers read local files only (-re paced, -c copy).
set -euo pipefail

SUFFIX="${HARNESS_SUFFIX:-rt-mt}"
NETWORK="${HARNESS_NETWORK:-smartface-network}"
IMAGE="${HARNESS_IMAGE:-smartface-tests:${SUFFIX}}"
CPUS="${HARNESS_CPUS:-0.5}"
CLIP_DIR="${CLIP_DIR:-/data/test-clips}"
MTX_IMAGE="${HARNESS_MTX_IMAGE:-bluenviron/mediamtx:1.21.1}"
MTX_NAME="mediamtx-${SUFFIX}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$SUFFIX" in
  *[!a-z0-9-]*|"") echo "HARNESS_SUFFIX must be [a-z0-9-]+" >&2; exit 2 ;;
esac

die() { echo "harness: $*" >&2; exit 1; }

publisher_name() {
  local path="$1"
  case "$path" in *[!a-zA-Z0-9_-]*|"") die "path must be [a-zA-Z0-9_-]+" ;; esac
  echo "pub-${path}-${SUFFIX}"
}

mtx_image() {
  # The pinned tag is preferred; fall back to a local :latest when offline.
  if docker image inspect "$MTX_IMAGE" >/dev/null 2>&1; then echo "$MTX_IMAGE"; return; fi
  if docker pull -q "$MTX_IMAGE" >/dev/null 2>&1; then echo "$MTX_IMAGE"; return; fi
  echo "bluenviron/mediamtx:latest"
}

cmd_up() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network $NETWORK not found"
  if docker ps --format '{{.Names}}' | grep -qx "$MTX_NAME"; then echo "$MTX_NAME already running"; return; fi
  docker rm -f "$MTX_NAME" >/dev/null 2>&1 || true
  # Unprivileged uid: MediaMTX watches its config with inotify, and the host's
  # per-uid inotify instance quota for root is often exhausted by other stacks.
  docker run -d --name "$MTX_NAME" --network "$NETWORK" --cpus 1 --user "$(id -u):$(id -g)" \
    -v "$HERE/mediamtx.yml:/mediamtx.yml:ro" "$(mtx_image)" >/dev/null
  # Wait for the API (inside the network, through a throwaway curl-less node probe).
  for _ in $(seq 1 30); do
    if api_get "/v3/paths/list" >/dev/null 2>&1; then echo "$MTX_NAME up (rtsp://$MTX_NAME:8554/<path>)"; return; fi
    sleep 1
  done
  docker logs --tail 20 "$MTX_NAME" >&2 || true
  die "MediaMTX did not come up"
}

# GET on the MediaMTX API from inside the test network (no host port is published).
api_get() {
  docker run --rm --network "$NETWORK" --cpus 0.25 --entrypoint node "$IMAGE" -e \
    "fetch('http://${MTX_NAME}:9997'+process.argv[1]).then(async r=>{const t=await r.text();if(!r.ok){console.error(r.status,t);process.exit(1)}process.stdout.write(t)}).catch(e=>{console.error(String(e));process.exit(1)})" \
    "$1"
}

cmd_publish() {
  local path="$1" clip="$2" mode="${3:-loop}" delay="${4:-0}"
  [ -n "$path" ] && [ -n "$clip" ] || die "usage: publish <path> <clip> [loop|once] [start-delay-s]"
  local name; name="$(publisher_name "$path")"
  local abs
  case "$clip" in /*) abs="$clip" ;; *) abs="$CLIP_DIR/$clip" ;; esac
  [ -r "$abs" ] || die "clip not readable: $abs"
  local dir base; dir="$(dirname "$abs")"; base="$(basename "$abs")"
  local loop=()
  [ "$mode" = "loop" ] && loop=(-stream_loop -1)
  docker rm -f "$name" >/dev/null 2>&1 || true
  # -re paces at the clip's own frame rate; -c copy keeps codec, resolution and
  # GOP exactly as recorded (HEVC 4K / 1080p, keyframe interval of the source).
  docker run -d --name "$name" --network "$NETWORK" --cpus "$CPUS" --entrypoint sh \
    -v "$dir:/clips:ro" "$IMAGE" -c \
    "sleep $delay; exec ffmpeg -hide_banner -loglevel warning -re ${loop[*]:-} -i /clips/$base -map 0:v -c copy -an -f rtsp -rtsp_transport tcp rtsp://${MTX_NAME}:8554/${path}" \
    >/dev/null
  echo "rtsp://${MTX_NAME}:8554/${path}"
}

cmd_stop_publish() {
  docker rm -f "$(publisher_name "$1")" >/dev/null 2>&1 || true
}

cmd_ready() {
  api_get "/v3/paths/get/$1" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const p=JSON.parse(s);console.log(p.ready?p.readyTime:"not-ready")})' 2>/dev/null \
    || api_get "/v3/paths/get/$1"
}

cmd_status() {
  docker ps -a --filter "name=-${SUFFIX}\$" --format '{{.Names}}\t{{.Status}}' | grep -E "^(mediamtx|pub)-" || true
}

cmd_down() {
  local names
  names="$(docker ps -a --format '{{.Names}}' | grep -E "^(mediamtx|pub-[a-zA-Z0-9_-]+)-${SUFFIX}\$" || true)"
  [ -z "$names" ] || docker rm -f $names >/dev/null
  echo "harness ${SUFFIX} down"
}

sub="${1:-}"; shift || true
case "$sub" in
  up) cmd_up ;;
  publish) cmd_publish "${1:-}" "${2:-}" "${3:-loop}" "${4:-0}" ;;
  stop-publish) cmd_stop_publish "${1:-}" ;;
  ready) cmd_ready "${1:-}" ;;
  url) echo "rtsp://${MTX_NAME}:8554/${1:?path}" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac

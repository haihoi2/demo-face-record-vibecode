#!/usr/bin/env bash
# One replay run of the scripted (or exported) clips through an ISOLATED gateway.
#
#   tests/master/baseline/run-replay.sh [--name legacy] [--clips-dir /data/test-clips/scripted]
#                                       [--db pg|sqlite] [--off-s 45] [--idle-s 90]
#
# Environment passed through to the gateway: PIPELINE_MODE_ENTRY, PIPELINE_MODE_EXIT
# (acceptance runs of the new pipeline), FACE_DETECT_SIZE, FACE_MIN_SIZE_PX.
# MT_DECISIONS=shadow scores the pipeline_shadow_result stream instead of access logs.
#
# What it does (all containers are suffixed -rt-mt; nothing live is touched):
#   1. fresh throwaway PostgreSQL (tmpfs) + fresh gateway on :3116 (127.0.0.1 only)
#   2. MediaMTX harness; collector enrols the fixtures and points both gates at it
#   3. phase "off"  : watchers off, nothing published           -> CPU floor
#   4. phase "idle" : empty scene published, watchers on        -> CPU idle, look cadence
#   5. phase "busy" : the passage sequence, published once      -> decisions vs ground truth
#   6. analyze -> <out>/<name>.json + <name>.md; tear everything down
#
# Results go to /data/test-clips/results/<timestamp>-<name>/ (0700). The metrics
# JSON holds passage ids and fixture labels only, no names or employee ids.
set -euo pipefail

NAME=legacy; CLIPS_DIR=/data/test-clips/scripted; DB=pg; OFF_S=45; IDLE_S=90
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --clips-dir) CLIPS_DIR="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --off-s) OFF_S="$2"; shift 2 ;;
    --idle-s) IDLE_S="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

SUFFIX=rt-mt; PORT=3116; NET=smartface-network
IMAGE="${MT_IMAGE:-smartface-tests:rt-mt}"
MODELS="${MT_MODELS:-/tmp/claude-1001/-opt-etonlab-dev-demo-face-record-vibecode/5a527302-7339-49c6-9657-dcb498390bb8/scratchpad/models}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS="$WT/tests/master/harness/harness.sh"
GW=smartface-verify-$SUFFIX; PG=smartface-verify-pg-$SUFFIX; SSE=mt-sse-$SUFFIX
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/data/test-clips/results/$TS-$NAME"
umask 077; mkdir -p "$OUT"
log() { echo "[run-replay $(date -u +%H:%M:%S)] $*"; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

cleanup() {
  set +e
  [ -n "${CPU_PID:-}" ] && kill "$CPU_PID" 2>/dev/null
  docker rm -f "$SSE" >/dev/null 2>&1
  docker logs "$GW" > "$OUT/gateway.log" 2>&1
  docker rm -f -v "$GW" "$PG" >/dev/null 2>&1
  HARNESS_SUFFIX=$SUFFIX "$HARNESS" down >/dev/null 2>&1
}
trap cleanup EXIT

collect() {
  docker run --rm --network "$NET" --cpus 1 --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$WT/tests/master:/app/tests/master:ro" -v "$WT/tests/integration:/app/tests/integration:ro" \
    -v "$CLIPS_DIR:/clips:ro" -v "$OUT:/out" \
    -e APP_URL="http://$GW:3000" -e OPERATOR_TOKEN=integration-operator-token \
    "$IMAGE" node --import tsx tests/master/baseline/collect.ts "$@"
}

[ -r "$CLIPS_DIR/clips.json" ] || { echo "missing $CLIPS_DIR/clips.json" >&2; exit 1; }
df -h / | awk 'NR==2 { gsub("%","",$5); if ($5+0 >= 85) { print "root disk at " $5 "% - refusing" > "/dev/stderr"; exit 1 } }'

log "fresh gateway ($DB) on 127.0.0.1:$PORT"
docker rm -f -v "$GW" "$PG" >/dev/null 2>&1 || true
DBURL=""
if [ "$DB" = pg ]; then
  docker run -d --name "$PG" --network "$NET" --cpus 1 --tmpfs /var/lib/postgresql:rw,size=1g \
    -e POSTGRES_USER=itest -e POSTGRES_PASSWORD=itest-only -e POSTGRES_DB=itest postgres:18-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U itest -d itest >/dev/null 2>&1 && break; sleep 1; done
  DBURL="postgresql://itest:itest-only@$PG:5432/itest"
fi
docker run -d --name "$GW" --network "$NET" -p "127.0.0.1:$PORT:3000" --cpus 2 --tmpfs /tmp/v:rw,size=512m \
  -v "$MODELS:/models:ro" \
  -e NODE_ENV=production -e ALLOW_SIMULATED_RECOGNITION=false -e ENABLE_DEMO_STRANGER_SEEDS=false -e ENABLE_DEMO_DATA=false \
  -e OPERATOR_ID=itest-operator -e OPERATOR_TOKEN=integration-operator-token -e VIEWER_ID=itest-viewer -e VIEWER_TOKEN=integration-viewer-token \
  -e OPERATOR_SESSION_SECRET=integration-session-secret-123456789 -e DEVICE_INGEST_TOKEN=integration-device-token \
  -e INTERNAL_API_TOKEN=integration-internal-token -e CORS_ALLOWED_ORIGINS=http://allowed.test -e FACE_MODEL_DIR=/models \
  -e PIPELINE_MODE_ENTRY="${PIPELINE_MODE_ENTRY:-}" -e PIPELINE_MODE_EXIT="${PIPELINE_MODE_EXIT:-}" \
  ${FACE_DETECT_SIZE:+-e FACE_DETECT_SIZE=$FACE_DETECT_SIZE} ${FACE_MIN_SIZE_PX:+-e FACE_MIN_SIZE_PX=$FACE_MIN_SIZE_PX} \
  -e DATABASE_URL="$DBURL" -e DATA_DIR=/tmp/v "$IMAGE" npx tsx server.ts >/dev/null
for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
sleep 6

log "harness up"
HARNESS_SUFFIX=$SUFFIX "$HARNESS" up
collect setup --clips /clips/clips.json --state /out/state.json --rtsp-base "rtsp://mediamtx-$SUFFIX:8554"

# CPU sampler: epoch-ms,cpu% of the gateway container, ~every 2 s.
( while true; do
    v="$(docker stats --no-stream --format '{{.CPUPerc}}' "$GW" 2>/dev/null || true)"
    [ -n "$v" ] && echo "$(now_ms),$v" >> "$OUT/cpu.csv"
    sleep 1
  done ) & CPU_PID=$!

phase() { echo "{\"name\":\"$1\",\"startMs\":$2,\"endMs\":$3}"; }
PHASES=()

log "phase off (${OFF_S}s)"
collect watch --off
T0=$(now_ms); sleep "$OFF_S"; PHASES+=("$(phase off "$T0" "$(now_ms)")")

log "phase idle (${IDLE_S}s): empty scene, watchers on"
HARNESS_SUFFIX=$SUFFIX "$HARNESS" publish entry "$CLIPS_DIR/entry-empty.mp4" loop >/dev/null
HARNESS_SUFFIX=$SUFFIX "$HARNESS" publish exit "$CLIPS_DIR/exit-empty.mp4" loop >/dev/null
sleep 3
collect watch --on --interval 3 --frames 1
T0=$(now_ms)
docker run -d --name "$SSE" --network "$NET" --cpus 0.5 --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$WT/tests/master:/app/tests/master:ro" -v "$OUT:/out" -e APP_URL="http://$GW:3000" -e OPERATOR_TOKEN=integration-operator-token \
  "$IMAGE" node --import tsx tests/master/baseline/collect.ts record --seconds "$IDLE_S" --out /out/sse-idle.jsonl >/dev/null
sleep "$IDLE_S"; PHASES+=("$(phase idle "$T0" "$(now_ms)")")
docker rm -f "$SSE" >/dev/null 2>&1 || true
collect watch --off

log "phase busy: passage sequence, published once"
HARNESS_SUFFIX=$SUFFIX "$HARNESS" stop-publish entry
HARNESS_SUFFIX=$SUFFIX "$HARNESS" stop-publish exit
sleep 2
DUR_S="$(node -e 'const d=require(process.argv[1]);console.log(Math.max(...d.clips.map(c=>c.durationS)))' "$CLIPS_DIR/clips.json")"
HARNESS_SUFFIX=$SUFFIX "$HARNESS" publish entry "$CLIPS_DIR/entry-sequence.mp4" once >/dev/null
HARNESS_SUFFIX=$SUFFIX "$HARNESS" publish exit "$CLIPS_DIR/exit-sequence.mp4" once >/dev/null
READY_ENTRY=""; READY_EXIT=""
for _ in $(seq 1 30); do
  READY_ENTRY="$(HARNESS_SUFFIX=$SUFFIX "$HARNESS" ready entry 2>/dev/null || true)"
  READY_EXIT="$(HARNESS_SUFFIX=$SUFFIX "$HARNESS" ready exit 2>/dev/null || true)"
  case "$READY_ENTRY$READY_EXIT" in *not-ready*|"") sleep 0.5 ;; *) break ;; esac
done
log "ready ENTRY=$READY_ENTRY EXIT=$READY_EXIT; sequence ${DUR_S}s"
collect watch --on --interval 3 --frames 1
T0=$(now_ms)
REC_S=$(( ${DUR_S%.*} + 20 ))
docker run -d --name "$SSE" --network "$NET" --cpus 0.5 --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$WT/tests/master:/app/tests/master:ro" -v "$OUT:/out" -e APP_URL="http://$GW:3000" -e OPERATOR_TOKEN=integration-operator-token \
  "$IMAGE" node --import tsx tests/master/baseline/collect.ts record --seconds "$REC_S" --out /out/sse-busy.jsonl >/dev/null
sleep "$REC_S"; PHASES+=("$(phase busy "$T0" "$(now_ms)")")
docker rm -f "$SSE" >/dev/null 2>&1 || true
collect watch --off
kill "$CPU_PID" 2>/dev/null || true; CPU_PID=""

( IFS=,; echo "[${PHASES[*]}]" ) > "$OUT/phases.json"
cat "$OUT/sse-idle.jsonl" "$OUT/sse-busy.jsonl" > "$OUT/sse.jsonl" 2>/dev/null || true
collect analyze --clips /clips/clips.json --state /out/state.json --ready "ENTRY=$READY_ENTRY,EXIT=$READY_EXIT" \
  --sse /out/sse.jsonl --cpu /out/cpu.csv --phases /out/phases.json --decisions "${MT_DECISIONS:-logs}" \
  --name "$NAME" --out "/out/$NAME.json" --md "/out/$NAME.md"
log "results in $OUT"

#!/usr/bin/env bash
# Export the candidate passages from the NVR's playback as test clips.
# FOR AN AUTHORISED OPERATOR: it needs the NVR view login, which this script
# never reads from the database itself.
#
#   NVR_URL_FILE=/path/0600-file  tests/master/harness/export-nvr-clips.sh [candidates.json] [out-dir]
#
#   NVR_URL_FILE  a 0600 file holding ONE line: rtsp://<login>@192.168.60.1:554  (no path)
#   candidates    default /data/test-clips/candidates.json (from select-passages.py)
#   out-dir       default /data/test-clips/nvr
#
# Rules it enforces (brief + owner decision 2026-09-26):
#  - one NVR session at a time, each FFmpeg hard-killed after duration + 25 s;
#  - playback times in UTC (YYYYMMDDTHHMMSSZ), video only (-map 0:v -c copy, no G.711 audio);
#  - the URL never appears on a command line (FFmpeg reads it from a 0600 concat list
#    in a private temp dir) and every line of FFmpeg output is redacted;
#  - clips land in a 0700 directory; delete them 30 days after export.
set -euo pipefail

CANDIDATES="${1:-/data/test-clips/candidates.json}"
OUT="${2:-/data/test-clips/nvr}"
FFMPEG="${FFMPEG_PATH:-ffmpeg}"
: "${NVR_URL_FILE:?set NVR_URL_FILE to a 0600 file holding rtsp://<login>@<nvr>:554}"

[ -r "$NVR_URL_FILE" ] || { echo "cannot read NVR_URL_FILE" >&2; exit 1; }
perm="$(stat -c %a "$NVR_URL_FILE")"
case "$perm" in 600|400) ;; *) echo "NVR_URL_FILE must be mode 0600 (is $perm)" >&2; exit 1 ;; esac
BASE="$(head -n1 "$NVR_URL_FILE" | tr -d '\r\n' | sed -E 's#/+$##')"
case "$BASE" in rtsp://*) ;; *) echo "NVR_URL_FILE must hold an rtsp:// origin" >&2; exit 1 ;; esac
case "$BASE" in rtsp://*/*) echo "NVR_URL_FILE must hold the origin only (no path)" >&2; exit 1 ;; esac

redact() { sed -E 's#rtsp://[^ "'"'"'@/]*@#rtsp://<login>@#g'; }

umask 077
mkdir -p "$OUT"; chmod 700 "$OUT"
PRIV="$(mktemp -d)"; chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT

count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["candidates"]))' "$CANDIDATES")"
echo "exporting $count clip(s) to $OUT (one NVR session at a time)"
ok=0; fail=0
for i in $(seq 0 $((count - 1))); do
  read -r gate ch start end dur < <(python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))["candidates"][int(sys.argv[2])]
print(c["gate"], c["nvrChannel"], c["startUtc"], c["endUtc"], int(round(c["durationS"])))' "$CANDIDATES" "$i")
  case "$ch" in *[!0-9]*|"") echo "bad channel" >&2; exit 1 ;; esac
  case "$start$end" in *[!0-9TZ]*) echo "bad time" >&2; exit 1 ;; esac
  name="$(printf '%03d' "$i")-${gate,,}-${ch}-${start}.mp4"
  [ -s "$OUT/$name" ] && { echo "skip $name (exists)"; ok=$((ok + 1)); continue; }
  list="$PRIV/in.txt"
  {
    echo "ffconcat version 1.0"
    printf "file '%s/Streaming/tracks/%s?starttime=%s&endtime=%s'\n" "$BASE" "$ch" "$start" "$end"
    echo "option rtsp_transport tcp"
    echo "option timeout 10000000"
  } > "$list"
  chmod 600 "$list"
  if timeout -s KILL $((dur + 25)) "$FFMPEG" -hide_banner -loglevel error -y \
      -f concat -safe 0 -protocol_whitelist file,rtsp,rtp,tcp,udp \
      -i "$list" -map 0:v -c copy -an -t "$dur" "$OUT/$name" 2> >(redact >&2); then
    ok=$((ok + 1)); echo "ok   $name"
  else
    fail=$((fail + 1)); rm -f "$OUT/$name"; echo "FAIL $name"
  fi
  rm -f "$list"
  sleep 2   # let the NVR close the playback session before the next one
done
echo "done: $ok ok, $fail failed. Delete after $(date -u -d '+30 days' +%F)."

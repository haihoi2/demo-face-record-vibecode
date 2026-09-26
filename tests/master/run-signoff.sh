#!/usr/bin/env bash
# Master-test sign-off run for a release candidate of the real-time pipeline.
#
#   tests/master/run-signoff.sh <rc-label> [--replay] [--keep-image]
#
#   <rc-label>   e.g. rc1  -> docs/agent-handoffs/<date>-rt-<rc-label>-signoff.md
#   --replay     also run legacy vs pipeline replays + the acceptance suite
#                (needs /data/test-clips/<set>/clips.json; ~20 min per replay)
#   --keep-image keep smartface-tests:<suffix> afterwards
#
# Env: MT_SUFFIX (default rt-mt), MT_PORT (3116), MT_CLIPS_DIR (/data/test-clips/scripted),
#      MT_MODELS (model dir), MT_WAIVE (finding ids reported as TODO, owner decision only).
#
# Everything runs in containers suffixed -<suffix> on the Docker test network:
# fresh SQLite and PostgreSQL gateways, a fail-closed gateway, the MediaMTX
# harness. Nothing live (gateway :8080, smartface-postgres-18, NVR, cameras,
# door controller) is touched. Report counts come from the TAP summaries.
set -uo pipefail

RC="${1:?usage: run-signoff.sh <rc-label> [--replay] [--keep-image]}"; shift
REPLAY=0; KEEP_IMAGE=0
for a in "$@"; do case "$a" in --replay) REPLAY=1 ;; --keep-image) KEEP_IMAGE=1 ;; *) echo "unknown $a" >&2; exit 2 ;; esac; done

SUFFIX="${MT_SUFFIX:-rt-mt}"; PORT="${MT_PORT:-3116}"; NET=smartface-network
IMAGE="smartface-tests:$SUFFIX"
MODELS="${MT_MODELS:-/tmp/claude-1001/-opt-etonlab-dev-demo-face-record-vibecode/5a527302-7339-49c6-9657-dcb498390bb8/scratchpad/models}"
CLIPS_DIR="${MT_CLIPS_DIR:-/data/test-clips/scripted}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$WT/tests/master/harness/harness.sh"
DATE="$(date -u +%F)"; TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/data/test-clips/results/$TS-signoff-$RC"; umask 077; mkdir -p "$OUT"
REPORT="$WT/docs/agent-handoffs/$DATE-rt-$RC-signoff.md"
GW=smartface-verify-$SUFFIX; PG=smartface-verify-pg-$SUFFIX; FC=smartface-failclosed-$SUFFIX
log() { echo "[signoff $(date -u +%H:%M:%S)] $*"; }

declare -A RESULT
tap_counts() { # file -> "pass/fail/skipped/todo"
  local f="$1"
  printf '%s/%s/%s/%s' \
    "$(grep -E '^# pass ' "$f" | tail -1 | awk '{print $3}')" "$(grep -E '^# fail ' "$f" | tail -1 | awk '{print $3}')" \
    "$(grep -E '^# skipped ' "$f" | tail -1 | awk '{print $3}')" "$(grep -E '^# todo ' "$f" | tail -1 | awk '{print $3}')"
}
run_step() { # name, command...
  local name="$1"; shift
  log "$name"
  "$@" > "$OUT/$name.log" 2>&1; local rc=$?
  RESULT[$name]="exit $rc"
  grep -qE '^# pass ' "$OUT/$name.log" && RESULT[$name]="exit $rc, pass/fail/skipped/todo $(tap_counts "$OUT/$name.log")"
  log "$name -> ${RESULT[$name]}"
  return $rc
}

GWENV=(-e NODE_ENV=production -e ALLOW_SIMULATED_RECOGNITION=false -e ENABLE_DEMO_STRANGER_SEEDS=false -e ENABLE_DEMO_DATA=false
  -e OPERATOR_ID=itest-operator -e OPERATOR_TOKEN=integration-operator-token -e VIEWER_ID=itest-viewer -e VIEWER_TOKEN=integration-viewer-token
  -e OPERATOR_SESSION_SECRET=integration-session-secret-123456789 -e DEVICE_INGEST_TOKEN=integration-device-token
  -e INTERNAL_API_TOKEN=integration-internal-token -e CORS_ALLOWED_ORIGINS=http://allowed.test)
TESTENV=(-e APP_URL="http://$GW:3000" -e OPERATOR_TOKEN=integration-operator-token -e VIEWER_TOKEN=integration-viewer-token
  -e DEVICE_INGEST_TOKEN=integration-device-token -e INTERNAL_API_TOKEN=integration-internal-token -e CORS_TEST_ALLOWED_ORIGIN=http://allowed.test)

start_gateway() { # name, db-url, extra env...
  local name="$1" dburl="$2"; shift 2
  docker rm -f -v "$name" >/dev/null 2>&1
  docker run -d --name "$name" --network "$NET" --cpus 2 --tmpfs /tmp/v:rw,size=512m -v "$MODELS:/models:ro" \
    "${GWENV[@]}" -e FACE_MODEL_DIR=/models -e DATABASE_URL="$dburl" -e DATA_DIR=/tmp/v "$@" "$IMAGE" npx tsx server.ts >/dev/null
  for _ in $(seq 1 120); do
    docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e "fetch('http://$name:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 6
}
start_pg() {
  docker rm -f -v "$PG" >/dev/null 2>&1
  docker run -d --name "$PG" --network "$NET" --cpus 1 --tmpfs /var/lib/postgresql:rw,size=1g \
    -e POSTGRES_USER=itest -e POSTGRES_PASSWORD=itest-only -e POSTGRES_DB=itest postgres:18-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U itest -d itest >/dev/null 2>&1 && break; sleep 1; done
}
in_tests() { # extra docker args..., -- , command...
  local extra=(); while [ "$1" != "--" ]; do extra+=("$1"); shift; done; shift
  docker run --rm --cpus 2 --network "$NET" --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$MODELS:/models:ro" -e FACE_MODEL_DIR=/models "${extra[@]}" "$IMAGE" "$@"
}
cleanup() {
  docker rm -f -v "$GW" "$PG" "$FC" >/dev/null 2>&1
  HARNESS_SUFFIX=$SUFFIX "$HARNESS" down >/dev/null 2>&1
  [ "$KEEP_IMAGE" = 1 ] || docker rmi "$IMAGE" >/dev/null 2>&1
}
trap cleanup EXIT

df -h / | awk 'NR==2 { gsub("%","",$5); if ($5+0 >= 85) { print "root disk at " $5 "% - refusing" > "/dev/stderr"; exit 1 } }' || exit 1
BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"; SHA="$(git -C "$WT" rev-parse HEAD)"
DIRTY="$(git -C "$WT" status --porcelain | wc -l)"

run_step build-image docker build -q --target tester -t "$IMAGE" "$WT"
run_step typecheck docker run --rm --cpus 2 "$IMAGE" npm run typecheck
run_step unit docker run --rm --cpus 2 "$IMAGE" npm test
run_step mt-unit docker run --rm --cpus 2 "$IMAGE" node --import tsx --test "tests/master/unit/*.test.ts"
run_step build docker run --rm --cpus 2 "$IMAGE" npm run build

HARNESS_SUFFIX=$SUFFIX HARNESS_IMAGE=$IMAGE "$HARNESS" up >/dev/null 2>&1
NVRURLS=""
if [ -r "$CLIPS_DIR/exit-empty.mp4" ]; then
  HARNESS_SUFFIX=$SUFFIX HARNESS_IMAGE=$IMAGE "$HARNESS" publish itest-1 "$CLIPS_DIR/exit-empty.mp4" loop >/dev/null
  HARNESS_SUFFIX=$SUFFIX HARNESS_IMAGE=$IMAGE "$HARNESS" publish itest-2 "$CLIPS_DIR/exit-empty.mp4" loop >/dev/null
  NVRURLS="rtsp://mediamtx-$SUFFIX:8554/itest-1,rtsp://mediamtx-$SUFFIX:8554/itest-2"
fi

# ---- regression on SQLite ----
start_gateway "$GW" ""
run_step integration-sqlite in_tests "${TESTENV[@]}" -e INTEGRATION_NVR_RTSP_URLS="$NVRURLS" -- npm run test:integration
docker logs "$GW" > "$OUT/gateway-sqlite.log" 2>&1

# ---- regression + security on PostgreSQL ----
start_pg
start_gateway "$GW" "postgresql://itest:itest-only@$PG:5432/itest"
run_step integration-pg in_tests "${TESTENV[@]}" -e INTEGRATION_NVR_RTSP_URLS="$NVRURLS" -- npm run test:integration
start_gateway "$FC" "" -e FACE_ENGINE=onnx -e FACE_MODEL_DIR=/nonexistent-models
run_step mt-security in_tests "${TESTENV[@]}" -e FAILCLOSED_APP_URL="http://$FC:3000" -e MT_WAIVE="${MT_WAIVE:-}" -- \
  node --import tsx --test --test-concurrency=1 "tests/master/security/*.test.ts"
run_step mt-contract in_tests -e MT_MTX_RTSP="rtsp://mediamtx-$SUFFIX:8554" -e MT_RESULTS_DIR=/out -v "$OUT:/out" -- \
  node --import tsx --test --test-concurrency=1 "tests/master/contract/*.test.ts"
docker logs "$GW" > "$OUT/gateway-pg.log" 2>&1
docker logs "$FC" > "$OUT/gateway-failclosed.log" 2>&1

# ---- log scan: planted secrets and credential-bearing URLs must never be logged ----
LEAKS="$(cat "$OUT"/gateway-*.log | grep -cE 'MtCanary-|rtsp://[^ /"@]+:[^ /"@]+@' || true)"
RECORDING_AUDIT="$(cat "$OUT"/gateway-*.log | grep -c '\[Recording\].*mở đoạn ghi' || true)"
RESULT[log-scan]="credential leaks in gateway logs: $LEAKS; recording-view audit lines: $RECORDING_AUDIT"
log "${RESULT[log-scan]}"
docker rm -f -v "$GW" "$PG" "$FC" >/dev/null 2>&1

# ---- replay: legacy vs pipeline + acceptance ----
LEGACY_MD="(not run: pass --replay)"; PIPE_MD=""
if [ "$REPLAY" = 1 ]; then
  MT_IMAGE=$IMAGE MT_MODELS=$MODELS "$WT/tests/master/baseline/run-replay.sh" --name legacy --clips-dir "$CLIPS_DIR" > "$OUT/replay-legacy.log" 2>&1
  LEG_DIR="$(ls -d /data/test-clips/results/*-legacy | tail -1)"
  PIPELINE_MODE_ENTRY=live PIPELINE_MODE_EXIT=live MT_IMAGE=$IMAGE MT_MODELS=$MODELS \
    "$WT/tests/master/baseline/run-replay.sh" --name pipeline --clips-dir "$CLIPS_DIR" > "$OUT/replay-pipeline.log" 2>&1
  PIPE_DIR="$(ls -d /data/test-clips/results/*-pipeline | tail -1)"
  run_step mt-acceptance in_tests -v "$LEG_DIR:/leg:ro" -v "$PIPE_DIR:/pipe:ro" -v "$OUT:/out:ro" \
    -e MT_METRICS_LEGACY=/leg/legacy.json -e MT_METRICS_PIPELINE=/pipe/pipeline.json -e MT_RECOVERY_JSON=/out/recovery.json -- \
    node --import tsx --test "tests/master/acceptance/*.test.ts"
  LEGACY_MD="$(cat "$LEG_DIR/legacy.md" 2>/dev/null)"; PIPE_MD="$(cat "$PIPE_DIR/pipeline.md" 2>/dev/null)"
fi

# ---- report ----
{
  echo "# Sign-off: real-time pipeline $RC ($DATE)"
  echo
  echo "- **Branch / SHA:** \`$BRANCH\` @ \`$SHA\` (uncommitted files: $DIRTY)"
  echo "- **Runner:** \`tests/master/run-signoff.sh $RC$( [ $REPLAY = 1 ] && echo ' --replay')\`, image \`$IMAGE\`, raw logs in \`$OUT\` (0700, not committed)"
  echo "- **Waived findings (MT_WAIVE):** ${MT_WAIVE:-none}"
  echo
  echo "## Gates"
  echo
  echo "| Step | Result |"
  echo "|---|---|"
  for k in build-image typecheck unit mt-unit build integration-sqlite integration-pg mt-security mt-contract mt-acceptance log-scan; do
    [ -n "${RESULT[$k]:-}" ] && echo "| $k | ${RESULT[$k]} |"
  done
  echo
  echo "## Metrics (section 1)"
  echo
  echo "$LEGACY_MD"
  echo
  echo "$PIPE_MD"
  echo
  echo "## Failing / todo cases"
  echo
  echo '```text'
  grep -hE '^not ok|# TODO' "$OUT"/*.log 2>/dev/null | sed -E 's/^ +//' | sort | uniq -c | head -60
  echo '```'
  echo
  echo "## Decision"
  echo
  echo "- [ ] MT signs off \`$SHA\` for tagging (every gate green, no unwaived security failure, acceptance met)"
  echo "- Open risks:"
  echo "- Reviewer:"
} > "$REPORT"
log "report: $REPORT"

# Master test unit (MT) — real-time pipeline

Owner: MT (plan `docs/plans/2026-09-26-realtime-pipeline.md`, section 6). Nothing is tagged
without an MT sign-off report (`docs/agent-handoffs/<date>-rt-<rc>-signoff.md`).

Everything here runs against **isolated** containers suffixed `-rt-mt` on the Docker test
network. Never point any of it at the live gateway (`:8080`), `smartface-postgres-18`, the NVR,
a camera or the door controller. `collect.ts` refuses `:8080` and the public hostnames.

## Layout

| Path | What |
|---|---|
| `harness/harness.sh` | MediaMTX (`mediamtx-rt-mt`) + FFmpeg publishers (`pub-<path>-rt-mt`): clips as RTSP, `-re`, `-c copy`, loop or once; `stop-publish` simulates a camera drop; `ready` gives the MediaMTX readyTime that anchors ground truth to wall-clock time |
| `harness/mediamtx.yml` | harness config (TCP RTSP, API on the network only, no host ports) |
| `harness/scripted.ts` | renders scripted passages (HEVC, site resolution/fps/GOP, camera-like bitrate) from face stills listed in a local `faces.json`; ground truth exact by construction |
| `harness/verify-scripted.ts` | checks the rendered faces with the real detector at the scheduled 60 px moments |
| `harness/select-passages.py` | picks ~50 candidate passages from `access_logs` (READ-ONLY SELECT) balanced over gate x people x outcome x day/evening, plus empty scenes |
| `harness/export-nvr-clips.sh` | exports the candidates from the NVR playback — **for an authorised operator** holding the NVR view login in a 0600 file; one session at a time, hard timeouts, `-map 0:v -c copy`, URL never on a command line, output redacted |
| `harness/build-nvr-truth.ts` | exported clips -> replayable per-gate sequences + `clips.json` (weak labels, measured first-usable time) |
| `clips.schema.json`, `clips.example.json` | ground-truth format + synthetic example (the real file lives in `/data/test-clips`) |
| `lib/groundTruth.ts`, `lib/metrics.ts` | validator and section-1 metrics (pure, unit-tested) |
| `lib/probe.ts` | canary secrets, SSRF listener, SSE capture, JPEG size |
| `baseline/collect.ts` | drives an isolated gateway: enrol fixtures, point gates at the harness, watch on/off, record SSE, analyze |
| `baseline/run-replay.sh` | one full replay run (off / idle / busy phases, CPU sampling) -> metrics JSON + table |
| `unit/` | unit tests of the MT libraries (`node --import tsx --test "tests/master/unit/*.test.ts"`) |
| `security/` | security suite (RBAC, credentials, SSRF, malformed input, fail-closed, shadow, crops) |
| `contract/` | pipeline-contract suite (FrameSource over the harness; tracker scenarios) |
| `acceptance/` | section-1 targets, legacy vs pipeline on the same clips |
| `run-signoff.sh` | full gate run + sign-off report |
| `results/` | committed metrics of reference runs (no personal data): `2026-09-26-legacy-scripted.*` is the W1 baseline |

`tests/integration/pipelineWatch.test.ts` is the part of the suite that joins the regular
integration regression (always runnable, no harness needed).

## Data rules

- Clips, stills, enrolment images and `clips.json` with real identities live only in
  `/data/test-clips` (0700). Never commit them. Delete them 30 days after export
  (`deleteAfter` in each `clips.json`).
- Result folders under `/data/test-clips/results/` keep raw gateway logs; the metrics JSON holds
  passage ids and fixture labels only. Only those metrics may be copied into `results/`.
- Gateways and throwaway PostgreSQL run on tmpfs, so enrolled fixtures vanish with the container.

## Typical commands (from the worktree)

```bash
docker build -q --target tester -t smartface-tests:rt-mt .
# scripted clips (once; ~30 min on 2 cores)
docker run --rm --cpus 2 --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/tests/master:/app/tests/master:ro" \
  -v /data/test-clips:/clips smartface-tests:rt-mt node --import tsx tests/master/harness/scripted.ts \
  --faces /clips/scripted/faces.json --out /clips/scripted --cycles 4
# legacy baseline on the scripted set (~22 min)
tests/master/baseline/run-replay.sh --name legacy --clips-dir /data/test-clips/scripted
# pipeline on the same clips (after W2)
PIPELINE_MODE_ENTRY=live PIPELINE_MODE_EXIT=live tests/master/baseline/run-replay.sh --name pipeline
# everything + report
tests/master/run-signoff.sh rc1 --replay
```

`faces.json` (local only) names four stills: `A` (enrolled employee), `Ah` (another view of A),
`B`, `C` (strangers), each with the face box `[x1, y1, x2, y2]` in that still.

## Measurement notes

- Ground truth of scripted clips: a face grows 40 -> 110 px over 3.5 s and is gone at 4 s, so it
  is >= 60 px for exactly 3 s from `appear + 1.0 s`; the detector check agrees within ~0.1 s.
- The legacy watcher decodes keyframes only (entry GOP 4 s), so cycle c shifts every face by
  0/1/2/3 s: a uniform sample of the keyframe phase, as random arrivals give on site (a 3 s usable
  window then holds an entry keyframe 3 times in 4). Without it the baseline is biased
  (`results/*-v1-phase-biased.json`, kept for reference; its exit half is unaffected).
- Passage order keeps the legacy cooldowns (grant 20 s, stranger 60 s) from hiding repeats.
- Decision latency = access-log timestamp - first >= 60 px moment; logs are attributed per
  passage window (see `lib/metrics.ts`). Strangers are attributed by order (logs carry no identity).
- CPU = `docker stats` of the gateway container (limited to 2 cores, like the brief) per phase.

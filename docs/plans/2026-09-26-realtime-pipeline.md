# Plan: real-time gate recognition, built by parallel agents

Status: proposed 2026-09-26. Base: `main` @ `633d995` (live on dev/staging).
Integration owner: Hermes (backend-integrator) unless the owner names another.

## 1. Goal and acceptance

Today each gate is looked at once every ~5 s (entry: grab 1.2 s + processing 0.9 s + 3 s gap;
exit: ~4.5 s). Every look reconnects to the camera and waits for a keyframe. A person in the
≥ 60 px zone for 2-3 s is often seen once or not at all.

Target, measured by the master test unit on recorded clips (section 6):

| Metric | Legacy (baseline, measure in W0) | Target |
|---|---|---|
| First ≥ 60 px face → decision, p50 / p95 | ~2-7 s | ≤ 0.8 s / ≤ 1.5 s |
| People missed per passage | measure | ≤ 5% and ≤ half of legacy |
| Logs per person per passage | 1-n (cooldown heuristics) | exactly 1 |
| False accepts on the impostor clip set | 0 | 0 |
| Gateway CPU, both gates busy / idle | ~1.4 cores | ≤ 3.5 / ≤ 0.5 cores |
| Recovery after NVR/camera drop | n/a | ≤ 10 s, surfaced as watcher error |

Security invariants that must hold throughout: server-owned thresholds and fusion; fail closed
when the ONNX engine is unavailable; no NVR/camera credentials in logs, SSE or responses; only
face crops stored and shown; shadow mode never unlocks and never writes access logs.

## 2. Target architecture (four steps)

```
NVR/camera ──RTSP kept open──▶ [1] StreamReader ──raw frames (gate area, 8 fps)──▶ ring buffer
                                                                                  │ newest only
                                                        motion check on gate area ▼
                         [4] SCRFD (INT8/OpenVINO) on gate area ──boxes ≥ 60 px, frontal──▶
                         [2] Tracker (ByteTrack-style) ──per track: best 3-5 frames──▶ ArcFace
                         [2] TrackDecision (existing fusion rules) ──ONE outcome per person──▶
                         [3] best-frame FACE CROP + exact capture time + recording channel ──▶ access log
```

1. **StreamReader** - one FFmpeg per gate, started once, raw RGB frames of fixed size through a
   pipe, ring buffer, newest-frame-only hand-off, stale-frame detection (> 1 s → reconnect),
   back-off reconnect, motion gate on a downscaled gate area.
2. **Tracker + TrackDecision** - one track per person (box overlap + Kalman prediction, face
   similarity 0.45 as tie-breaker), 60 px + clear-face per frame, quality-weighted embedding of the
   best frames, existing thresholds (0.55 single, 0.45 fused, 2 agreeing, margin 0.08), decision
   as soon as evidence suffices; strangers decided at track end, once.
3. **Face crops + capture time** - store a 2× face-box crop (≥ 224 px, JPEG, ~15-40 KB) of the
   track's best frame instead of the frame; store the frame's capture time and recording channel
   so the "Đoạn ghi" playback is exact. Validate that quick-register/merge still enrol from crops.
4. **Speed + gate area UI** - INT8 (ONNX Runtime, VNNI) or OpenVINO for SCRFD/ArcFace with a
   benchmark and a cosine-drift check; per-camera gate-area (ROI) editor in the UI.

Rollout switch, per gate: `PIPELINE_MODE_ENTRY` / `PIPELINE_MODE_EXIT` = `legacy` (today) |
`shadow` (new pipeline runs, decisions only logged to a comparison stream, no unlock, no access
log) | `live` (new pipeline acts, legacy watcher off). Switching back to `legacy` needs no redeploy.

## 3. Contracts first (Wave 0)

The integrator writes `src/server/pipeline/contracts.ts` before anyone else starts. Every other
agent codes against it; changes after W0 go through the integrator.

```ts
export interface Frame { streamId: string; gate: "ENTRY" | "EXIT"; capturedAtMs: number;
  width: number; height: number; roi: [x: number, y: number, w: number, h: number];
  rgb: Uint8Array; seq: number }
export interface FrameSource { start(): void; stop(): void; latest(): Frame | null;
  on(ev: "frame", cb: (f: Frame) => void): void; on(ev: "state", cb: (s: SourceState) => void): void }
export interface FaceDetection { box: [number, number, number, number]; landmarks: [number, number][];
  score: number; sizePx: number; clear: boolean; unclearReason?: string }
export interface TrackUpdate { trackId: string; frame: Frame; detection: FaceDetection;
  embedding?: Float32Array; quality: number }
export type TrackOutcome =
  | { kind: "employee"; trackId: string; employeeId: string; fused: FusionEvidence; best: BestFrame }
  | { kind: "stranger"; trackId: string; embedding: Float32Array; best: BestFrame }
  | { kind: "insufficient"; trackId: string };
export interface BestFrame { frame: Frame; detection: FaceDetection; crop?: Buffer }
```

## 4. Agents, ownership and deliverables

One writer per hotspot (AGENTS.md). Each agent works in its own worktree
`../demo-face-record-vibecode-wt/rt-<agent>` on branch `feat/rt-<agent>` from the W0 commit.

| Agent (type) | Step | Owns (may write) | Must not touch | Delivers |
|---|---|---|---|---|
| **INT** integrator (backend-integrator) | W0, W2 | `server.ts`, `src/server/pipeline/contracts.ts`, `src/server/pipeline/index.ts`, `.env.example`, `docker-compose.yml` | engine internals of other agents | contracts, `PIPELINE_MODE_*` flag, wiring in shadow/live, SSE fields, readiness |
| **STR** stream reader (general-purpose, backend scope) | 1 | `src/server/pipeline/streamReader.ts`, `motion.ts`, `ringBuffer.ts`, their unit tests | `server.ts`, `db.ts`, `types.ts` | FrameSource impl, reconnect/back-off, stale detection, CPU numbers per gate |
| **TRK** tracker (face-engine) | 2 | `src/server/pipeline/tracker.ts`, `trackDecision.ts`, unit tests | `faceEmbedding.ts` (owned by PERF), `server.ts` | tracks, best-frame selection, per-track fused decision using `faceFusion.ts` rules unchanged |
| **DAT** data (data-migrations) | 3 | `src/server/db.ts`, `src/types.ts`, migrations, persistence tests | `server.ts` | `access_logs.capturedAt`, `trackId`, `recordingChannel` (nullable, additive), migration + rollback + retention notes, `getAccessLogMetaById` returns them |
| **PERF** engine speed + crops (face-engine, 2nd instance) | 3, 4 | `src/server/faceEmbedding.ts`, `src/server/pipeline/faceCrop.ts`, model files, benchmarks | `tracker.ts`, `server.ts` | INT8/OpenVINO path behind `FACE_ENGINE_BACKEND`, benchmark + cosine drift ≤ 0.02 vs FP32, crop function + enrol-from-crop proof on real captures |
| **UI** frontend | 3, 4 | `src/components/**`, `src/utils/**` (except `api.ts` contract changes via INT) | backend files | crop thumbnails everywhere, no full frames, ROI editor per camera, watcher panel (looks/s, latency, mode) |
| **MT** master test unit (security-tester) | all | `tests/master/**`, `tests/integration/pipeline*.test.ts`, replay harness under `tests/master/harness/` | production files | replay harness, acceptance + security suites, baseline, sign-off report per release candidate |
| **REL** release (build-release) | W3 | merge train, tags, deploy scripts/notes, `docs/agent-handoffs/*` release notes | feature code | merges in order, tags, dev deploy, rollback, post-deploy checks |

Hotspot writers for this wave: `server.ts` → INT; `db.ts` + `types.ts` → DAT;
`faceEmbedding.ts` → PERF; shared context (`AGENTS.md`, `CLAUDE.md`, `.claude/**`) → INT only.
A non-owner who needs a hotspot change writes the exact change in their handoff; the owner applies it.

## 5. Waves and order

| Wave | Who | Work | Exit criteria |
|---|---|---|---|
| **W0** (~0.5 day) | INT, MT | contracts, mode flag stub (all gates `legacy`), `release/rt-pipeline` branch; MT builds the replay harness skeleton and measures the legacy baseline; STR reads each channel's fps/GOP and the NVR's RTSP session limit (read-only) | contracts merged to `release/rt-pipeline`; baseline numbers recorded |
| **W1** (parallel, ~2-3 days) | STR, TRK, DAT, PERF, UI, MT | steps 1-4 against the contracts; MT writes acceptance tests against contracts and the replay harness | each branch: typecheck + unit + build green, own tests added, handoff filed |
| **W2** (~1 day) | INT (+ MT) | merge order below, wire pipeline behind `PIPELINE_MODE_*`, shadow comparison stream (SSE `pipeline_shadow_result` + JSON log) | integration branch green on the master suite (SQLite + PostgreSQL) |
| **W3** (~1 day + soak) | MT, REL | sign-off, tag, dev deploy in shadow, 24 h soak comparison, then `live` on EXIT, then ENTRY | shadow report meets section 1 targets; owner approves each switch |

Merge order into `release/rt-pipeline` (each rebased on the previous, gates rerun after each):
`contracts (INT)` → `DAT` (additive schema) → `STR` → `PERF` → `TRK` → `UI` → `INT wiring` → `MT suite`.

## 6. Master test unit (MT)

One agent owns one suite; nothing is tagged without its sign-off.

- **Replay harness:** a MediaMTX (or FFmpeg `-re`) container serves recorded clips as RTSP on the
  test network, so the pipeline runs exactly as against the NVR, repeatably. Clips are exported with
  the existing NVR playback path: passages with 1, 2 and 3+ people, both gates, day/evening, plus
  an impostor set (non-employees, photos held up). Ground truth (who, entry/exit time, first 60 px
  frame) is labelled once in `tests/master/clips.json`.
- **Biometric data:** real clips live in `/data/test-clips` (0700), never committed, retention
  30 days; CI on GitHub uses synthetic clips only.
- **Suites:**
  - `acceptance` - every section-1 metric, legacy vs new on the same clips, report as JSON + table;
  - `pipeline-contract` - FrameSource/Tracker/Decision behaviour on synthetic streams (drop,
    stall, reconnect, burst, crossing people, occlusion);
  - `security` - shadow never unlocks or logs; fail-closed engine; no credentials in logs/SSE/API;
    crops only; RBAC on new routes; audit of footage/crop reads;
  - `regression` - the existing unit (273) and integration (167) suites.
- **Gates:**
  - per agent branch: typecheck, unit, build, own tests;
  - `release/rt-pipeline`: full regression on SQLite **and** PostgreSQL gateways, contract suite,
    security suite, acceptance on replay;
  - after dev deploy: live checks against the **PostgreSQL** dev gateway (lesson from 2026-09-26:
    an SQLite-only live check missed a PostgreSQL-only bug).
- **Sign-off report:** `docs/agent-handoffs/<date>-rt-<rc>-signoff.md` with commands, counts,
  metrics table, open risks.

## 7. Merge, tag, deploy on dev (REL)

1. MT signs off `release/rt-pipeline` @ SHA.
2. REL fast-forwards `main`, creates annotated tag `v1.1.0-rt.<n>` (release candidate), pushes
   `main` and the tag after the owner's OK.
3. Dev deploy (existing flow): back up config/identity tables, `docker tag` the running image
   `smartface-rollback:pre-rt<n>-<ts>`, `docker compose build smartface-app`,
   `docker compose up -d --no-deps smartface-app` with `PIPELINE_MODE_ENTRY=shadow`,
   `PIPELINE_MODE_EXIT=shadow`.
4. Post-deploy: health, storage-status (PostgreSQL), watchers, `/api/face-engine/status`, pipeline
   state (fps, reconnects, CPU), MT live checks, no credentials in logs.
5. 24 h shadow soak → MT comparison report → owner approves `live` on EXIT (env change + restart,
   no rebuild) → next day ENTRY → tag `v1.1.0` when both gates are live and stable.
6. Rollback at any time: set the gate back to `legacy` (restart only); full rollback = redeploy the
   rollback image; the schema change is additive, so no down-migration is needed to roll back.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Continuous 4K HEVC decode costs ~1.5-2 cores | set entry channel to 8-10 fps on the NVR/camera if allowed; ROI crop in FFmpeg; measure in W0/W1 |
| NVR RTSP session limit | one long session per gate replaces ~1,500 reconnects/day; confirm limit in W0 |
| Tracker ID switches when people cross | similarity tie-break; MT crossing clips; decision needs 2 agreeing frames |
| INT8 accuracy drift | cosine drift ≤ 0.02 vs FP32 on the calibration set, else keep FP32 |
| Crops too tight for enrolment | PERF proves enrol-from-crop on real captures before UI switches |
| Disk at 76% on root | clips and model artifacts on `/data`; test image removed after gates |
| Shadow mode acting by mistake | MT security suite asserts no unlock/log in shadow; INT code review |

## 9. Owner decisions needed before W1

- Approve this plan and the agent/ownership table.
- Approve exporting ~50 real passages from the NVR as test clips (biometric data, kept on `/data`).
- Whether the entry camera's frame rate may be lowered to 8-10 fps on the NVR/camera.
- Strangers: crops stored for every detected face ≥ 60 px (recommended), or employees only.

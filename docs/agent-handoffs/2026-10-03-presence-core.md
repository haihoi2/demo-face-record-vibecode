# Agent handoff

## Task

- **Title:** Presence P2 core: detectors, tracker, rules, detector workers and host (shadow).
- **Owner/agent:** face-engine agent. Integration owner: Hermes (INT).
- **Acceptance criteria** (INT brief 2026-10-03; owner approved P2 with UNION-LOWRATE, 3 s working / 1 s after hours, shadow only, entry first, crops 7 days):
  1. `detectors.ts`: YOLOX-Nano and RTMDet-tiny in onnxruntime-node 1.30, with the P1 pre/post-processing ported exactly:
     - letterbox/resize to 960 px wide, normalisation per model, decoding, per-model threshold, person class only;
     - NMS 0.5 merge across models; boxes returned in source pixels;
     - configurable overlay mask (OSD clock, logo);
     - sha256 check of the model file (a mismatch is refused).
  2. `tracker.ts` (2 s linking) and `presenceCore.ts`, pure rules producing PresenceEventDraft:
     - qualify at 3 s (working hours) / 1 s (after hours), Asia/Ho_Chi_Minh, injectable clock;
     - peakPersons and best frame;
     - a final draft when the track ends.
  3. `presenceWorker.ts` (worker thread) and `presenceHost.ts` (main thread), modelled on gatePipeline/pipelineWorker:
     - newest frame only, never queued;
     - YOLOX on every frame; RTMDet on every 4th, asynchronous so YOLOX never waits;
     - restart with back-off, and stats;
     - fail closed on a missing or mismatched model;
     - frames from a FrameSource-like interface.
  4. Tests:
     - unit tests: pre/post-processing, NMS, mask, tracker, rules, worker lifecycle with a fake engine;
     - an offline parity check with the real models against P1b.
  5. Model files in `/data/models/presence/` (0644, with `.sha256` files); default `PRESENCE_MODEL_DIR=/app/models/presence`.
- **Scope explicitly excluded:** `server.ts`, `src/server/db.ts`, `src/types.ts`, `contracts.ts`, `streamReader.ts`, server wiring, routes, storage, UI, deploy.

## Source control

- **Branch/worktree:** `feat/presence-core` in `/opt/etonlab/dev/demo-face-record-vibecode/.claude/worktrees/agent-a87784e1f9ac10216`.
- **Base SHA:** started on `10fc8ee`; rebased onto the `feat/presence-p2` tip `070935e` (INT's stream third output, store, routes, UI). `contracts.ts` is unchanged there.
- **Commit SHA(s)** (after the rebase; see `git log 070935e..feat/presence-core`):
  - `8553659` feat(presence): YOLOX-Nano / RTMDet-tiny detectors and presence settings
  - `3ea426f` feat(presence): tracker and presence rules (PresenceEventDraft)
  - `89c8c2a` feat(presence): detector workers and presence host (shadow)
  - `798b455` tools(presence-eval): P2 parity replay through the production presence path
  - `5ff6db2` docs(handoff): this file
  - `b56f3ce` fix(presence): host stats lastEventAt string|null; ignore a re-offered frame
  - plus the commit updating this file
- **Rebased/updated before handoff:** yes, and the gates were re-run after the rebase. **Not pushed** (INT pushes).

## Ownership

- **Files owned (all new):**
  - `src/server/presence/{detectors,presenceConfig,tracker,presenceCore,presenceProtocol,presenceDetectorCore,presenceWorker,presenceHost}.ts`
  - `tests/presence{Detectors,Core,Host}.test.ts`
  - `tools/presence-eval/parity.ts`
  - this file
- **Files forbidden/not touched:** `server.ts`, `src/server/db.ts`, `src/types.ts`, `src/server/presence/contracts.ts`, `src/server/pipeline/**`, `package.json`, `Dockerfile`, `docker-compose.yml`.
- **`server.ts` touched:** no.
- **Other hotspot touched:** no (only this new handoff file).

## Changes

### Design note: two detector threads, not one async worker
onnxruntime-node 1.30's `session.run` BLOCKS the calling JS thread, and two sessions in one thread do NOT overlap. Measured in the tester image:
- RTMDet 960: 601 ms with 1 event-loop tick;
- YOLOX + RTMDet: 845 ms together vs 883 ms one after the other.

So "RTMDet asynchronous, YOLOX never waits" requires **two worker threads per gate**, one ONNX session each at 1 intra-op thread. `presenceWorker.ts` is a generic detector worker; the host starts it twice ("yolox-nano", "rtmdet-tiny"). The cheap parts run on the host (main thread): cross-model NMS, tracker and rules (a few boxes per frame, microseconds). **Contract text to adjust:** "a second ONNX session" becomes "a second worker thread".

### Behaviour
- `detectors.ts`:
  - `inputGeometry`, `resizeRgb`, `fillTensor`, `decodeDetections`, `nmsDetections`, `applyMask`, `mergeDetections` are ported from the P1 harness;
  - `OnnxPersonDetector` refuses a file whose sha256 differs, a missing file, a path in the file name, or an empty sha.
- `presenceConfig.ts`:
  - the P1b operating point: YOLOX 0.55 and RTMDet 0.30 at 960 px; pinned sha256 values;
  - entry/exit masks; 07:00-19:00 Asia/Ho_Chi_Minh; 3 s / 1 s; 2 s linking;
  - `presenceSettingsFromEnv()` reads the PRESENCE_* variables of contracts.ts.
- `tracker.ts`, `presenceCore.ts`:
  - per-person tracks with detections up to 2 s apart linked; late RTMDet boxes are merged by cross-model NMS with the same frame's YOLOX boxes;
  - in view = last − first + one frame period, so 6 frames at 2 fps = 3.0 s, as in P1b;
  - the period is taken at the latest detection;
  - a qualified draft, then a final draft; unqualified tracks end silently;
  - no track ends while a frame that could extend it is still in a detector.
- `presenceDetectorCore.ts`, `presenceWorker.ts`:
  - the worker lowers its own thread priority (PRESENCE_WORKER_NICE, default 19) before loading;
  - a failed load is retried every 30 s; every frame gets exactly one answer;
  - `createInProcessDetectorWorker()` is for tests and tools.
- `presenceHost.ts`: newest frame only; YOLOX on every frame; RTMDet on every 4th (if RTMDet is still busy, the slot moves to the next frame and is counted).
  - **Fail closed:** nothing is processed unless both workers report their model loaded and verified.
  - **Recovery:** crash or hang (20 s) → restart with back-off from 1 s to 30 s.
  - **Crops:** a JPEG body crop of the best frame, through `pipeline/faceCrop` (ffmpeg).
  - **Events:** delivered in order; final drafts are also delivered on `stop()`.

### API (no contract change; additive)
```ts
import { PresenceHost } from "./src/server/presence/presenceHost";
const host = new PresenceHost({
  gateId: "entry",                                    // invalid -> throws
  onDraft: (draft: PresenceEventDraft, crop: Buffer | null) => { /* store (shadow) */ },
  onError: (message: string) => { /* log */ },        // optional
  source,   // optional { latest(), on("frame", fn), off?("frame", fn) }; or push with host.offer(frame)
  // optional: settings (default presenceSettingsFromEnv()), mask (default per gate), cropper (null = no crops),
  //   createWorker, now, tickMs 250, statsMs 1000, frameTimeoutMs 20000, restartBackoffInitialMs 1000 / MaxMs 30000 /
  //   ResetMs 60000, stopTimeoutMs 3000, modelRetryMs 30000, maxFrameAgeMs 5000
});
host.start();
host.offer({ width: 960, height: 540, rgb, capturedAtMs, sourceWidth: 3840, sourceHeight: 2160 });
host.stats();       // PresenceHostStats
await host.stop();  // final drafts for open qualified tracks are delivered before it resolves
```

**Draft delivery:** `onDraft` is called once when a track qualifies (`final: false`) and once when it ends (`final: true`), in order; the crop comes with each. Boxes are in SOURCE pixels when `sourceWidth/sourceHeight` are given.

**Stats** (`PresenceHostStats`): `gateId`, `running`, `engineReady`, plus:
- frames and timing: `fps` (last 10 s), `framesReceived`, `framesProcessed`, `framesDroppedBusy`, `framesSkippedNotReady`, `framesRejected`, `lastFrameAt`, `lastFrameAgeMs`;
- detections: `detections{yolox-nano, rtmdet-tiny}`, `rtmdetRuns`, `rtmdetSkippedBusy`;
- tracks and events: `openTracks`, `tracks`, `qualified`, `finals`, `droppedUnqualified`, `lastEventAt` (string, or null before the first draft);
- errors: `errors`, `lastError`;
- models: `models[{id, file, sha256, threshold, inputWidth, tag}]`;
- per worker: `workers{<model>: {state, restarts, ready, tag, loadError?, runs, lastRunMs?, lastLoopMs?}}`;
- `worker {state, restarts, models[]}`: the shape `GET /api/presence/status` uses.

### Unchanged
- **API/event contracts:** none changed; all of the above is additive.
- **Schema/migration:** none.
- **Environment:** the contract's PRESENCE_* variables only. New, dev-only: `PRESENCE_WORKER_PATH`, a worker entry override like `PIPELINE_WORKER_PATH`.

### Security/privacy impact
- Shadow only: nothing is sent, and nothing reaches a door.
- Frames and crops stay in memory on the host: a ring of 12 frames at 960×540×3 (about 19 MB), plus one frame reference per open track.
- Crops go only to `onDraft`. No embeddings, no identity.

## Verification

All runs in the repo's tester image (onnxruntime-node 1.30.0), with this branch's `src/`, `tests/`, `tools/`, `server.ts` and `package.json` mounted, `--cpus 2.5`, one job at a time.

```text
After the rebase onto 070935e:
command: docker run ... presence-p1-tester npm run lint         (tsc --noEmit)
result: exit 0
command: docker run ... presence-p1-tester npm test             (WITHOUT nice)
result: exit 0 - tests 1157, suites 242, pass 1148, fail 0, cancelled 0, skipped 9
        (8 pre-existing skips + the real-model test, which needs PRESENCE_TEST_MODEL_DIR)
command: docker run ... presence-p1-tester npm run build
result: exit 0 (client, server.cjs 795 kB, faceWorker.cjs, pipelineWorker.cjs; PresenceHost is not wired into server.ts yet)
Before the rebase (on 10fc8ee): lint exit 0; npm test 1121 tests, 1112 pass, 0 fail, 9 skipped; build exit 0.
command: ... npx esbuild src/server/presence/presenceWorker.ts --bundle --platform=node --format=cjs --packages=external --outfile=/tmp/presenceWorker.cjs
result: bundles (the build:presence-worker step INT needs to add)
command: PRESENCE_TEST_MODEL_DIR=/models/presence node --import tsx --test --test-name-pattern "real models" tests/presenceDetectors.test.ts
result: pass (both real models load with the pinned sha256, run at 960x544, blank frame -> no person)
```

**New tests** (52; 51 run in the gate):
- `presenceDetectors`: geometry, tensor fill per model, resize, IoU/NMS/mask/merge, decode → source pixels, sha256 refusal cases, settings/env.
- `presenceCore`: period boundaries 06:59:59 / 07:00 / 18:59:59 / 19:00 and the midnight-wrap case, association, 2 s linking, qualification at 3 s and 1 s, boundary crossings, the end rule incl. pending frames, late RTMDet, cross-model best box, peakPersons, endAll, rounding.
- `presenceHost`:
  - with fake engines: every-frame / every-4th scheduling, drafts with crops (frame-pixel crop box), newest-only, rejected frames, stop() finals, gate validation, sha256-mismatch fail-closed, crash restart, hung-worker restart;
  - with real worker threads: the entry resolves under tsx; without models both fail closed, nothing is processed, and stop() is clean.

**Offline parity** (`tools/presence-eval/parity.ts`, real models through `PresenceHost`):
- **Data:** the 23 reviewed entry clips: the 21 P1b day/evening clips plus the 2 Oct 05:07 and 05:20 clips.
- **Decode:** from the original video, `fps=4,scale=960:540:flags=area`, processed at 2 fps.
- **Detector parity vs the saved P1 runs:**
  - YOLOX: presence agrees on 1566/1580 frames; boxes 473 (production) vs 475 (P1), 467 matched (IoU ≥ 0.5); |score diff| median 0.003, p95 0.021;
  - RTMDet: presence agrees on 395/398 frames; boxes 226 vs 226, 223 matched; median 0.003, p95 0.012.
  - The small differences come from P1's intermediate 1920 px JPEG step.
- **Person recall ≥ 3 s** (UNION-LOWRATE, same code for both):
  - all 23 clips: production 30/61, P1 detections 30/61; 2 persons differ, one each way;
  - the P1b 21-clip set: production 20/48, P1 detections 21/48 (P1b: 21/48). One person in clip 003 is missed.
- **Production events, replayed at 10:00 local (3 s rule):** 31 qualified, **31 on a real person**, 0 false; 31 finals; 0 frames dropped; 0 errors.
- **Replayed at 22:00 local (1 s rule):** 45 qualified, 42 matched to the ground truth. Of the 3 others:
  - **1 genuine false alarm:** the cartoon-patterned bag on the bench, YOLOX 0.568 on two frames;
  - 1 box between two people standing side by side;
  - 1 dawn person 0.5 s before the pooled label starts.
- **Not run and why:** `docker compose --profile test ...`: a compose build cannot be held to the 2.5-CPU cap. The equivalent commands ran in the tester image built from this repo.
- **Manual verification:** the 3 after-hours "false" events were checked against the ground truth (see above).

## Data and deployment

- **Model files:** `/data/models/presence/yolox_nano_person.onnx` and `/data/models/presence/rtmdet_tiny_person.onnx`.
  - Mode 0644, with `.sha256` files; `sha256sum -c` passes.
  - The sha256 values equal those pinned in `presenceConfig.ts` and in the P1 report.
- **Forward migration / rollback:** none / revert the commits (new files only).
- **Backward compatibility:** no existing module changed.
- **Data retention:** nothing is stored by this code. INT's store keeps crops 7 days.
- **Deployment/restart required:** no (not wired). Wiring and deploy belong to INT.

## Risks and follow-up

- **Worker bundle (INT, `package.json` is not in my scope):**
  - add `"build:presence-worker": "esbuild src/server/presence/presenceWorker.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/presenceWorker.cjs"`;
  - append `&& npm run build:presence-worker` to `build`.
  - Without it, production cannot find the worker: the host fails closed with "Presence worker entry not found" and keeps retrying with back-off.
- **Third stream output (INT, `streamReader.ts` at `514e63b`):** compatible. Its `PresenceFrame` {width, height, rgb, capturedAtMs} is accepted as is, and a fresh buffer per frame is safe for the host's crop references. Two requests:
  - add `:flags=area` to the `[pres]scale=...` filter: the parity and P1 used area downscaling; the default bicubic aliases small, far people differently (not measured);
  - wire it as `reader.on("presence-frame", (f) => host.offer({ ...f, sourceWidth, sourceHeight }))` with the reader's source size, so boxes come back in source pixels as the contract says. Without them, boxes are in 960 px frame pixels.
- **`PresenceHostHandle` in server.ts:** `PresenceHost` satisfies it (`stop()`; `stats()` has `fps: number`, `worker`, `lastEventAt: string | null`).
- **Mount:** `/data/models/presence` → `/app/models/presence:ro`.
- **CPU:** about 0.7 core per gate (P1b), in two threads at nice 19. Watch the live streams' fps when switching on.
- **The 1 s after-hours rule** produced 1 genuine false event (the bench bag) in 19 min of replay. Before P3 sends messages, consider one of:
  - a minimum of 3 frames;
  - a per-gate exclusion mask fed by the "false alarm" labels.
- **Night recall** is still measured on only one IR person (P1b).
- **Unresolved questions:**
  - contracts.ts wording: "second ONNX session" vs two worker threads;
  - whether INT wants `PresenceFrame` moved into contracts.ts.
- **Dependencies:** INT's third stream output, the server wiring, `presence_events` storage, and the `build:presence-worker` script.
- **Requested integration action:**
  1. Review and merge `feat/presence-core` after `feat/presence-p2`.
  2. Add the build script and the model mount.
  3. Wire `PresenceHost` per gate behind `PRESENCE_MODE_<GATE>=shadow`.
  4. Re-run the full gates on the integrated branch.

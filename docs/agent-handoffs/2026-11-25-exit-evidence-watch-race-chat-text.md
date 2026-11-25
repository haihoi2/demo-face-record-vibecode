# Agent handoff

## Task

- **Title:** Exit shadow pipeline evidence fix (#523), gate-watch reconfigure race, plain-text chat messages
- **Owner/agent:** INT (Hermes), single writer of every hotspot in this wave
- **Acceptance criteria:**
  1. A watch-config POST during an in-flight scan never leaves a gate watcher enabled with no timer.
  2. Chat-room messages are one copyable text field, no attachment card.
  3. On the real exit pass of 2026-11-25 12:04:53 local, the shadow pipeline names the enrolled walker as employee instead of ending every track as insufficient, with no wrong employee in any tested configuration.
  4. The worker reports enough counters to judge the fix on live without reading logs.
- **Scope explicitly excluded:** deploy, restart, live `.env` change, a separate embedding thread (option C below), switching any gate out of shadow, the heap leak, frontend display of the new counters.

## Source control

- **Branch/worktree:** `fix/exit-evidence-and-watch-race`, worktree `.claude/worktrees/exit-evidence`
- **Base SHA:** be55e9c (= origin/main at handoff)
- **Commit SHA(s):**
  - 25c3624 fix(watch): a reconfigure during an in-flight scan no longer stops the gate watcher
  - 0715f94 feat(webhook): chat messages are plain text, no attachment
  - ce30915 fix(pipeline): keep a fast walker in one track and spend the embedding budget on evidence (#523)
  - e9a22c5 feat(pipeline): PIPELINE_MIN_FACE_PX_BY_GATE sets the worker's face floor per gate (#523)
  - 48ee111 feat(pipeline): worker reports track and embedding counters in the gate status (#523)
- **Rebased/updated before handoff:** yes (origin/main fetched, still be55e9c; the branch is 5 commits ahead, fast-forward)

## Ownership

- **Files owned:** `server.ts`, `src/types.ts`, `src/server/chatText.ts`, `src/server/pipeline/{tracker,trackDecision,pipelineCore,pipelineProtocol,gatePipeline}.ts`, `src/components/WebhookIntegration.tsx`, `.env.example`, `docker-compose.yml`, `README.md`, the tests listed below, this handoff.
- **Files forbidden/not touched:** `src/server/db.ts`, `src/server/faceEmbedding.ts`, `src/server/faceFusion.ts`, door-controller code, `src/utils/offlineEngine.ts`, `src/utils/pipelineStatus.ts`.
- **`server.ts` touched:** yes
- **Other hotspot touched (`src/server/db.ts`, `src/types.ts`, shared context):** `src/types.ts` (optional `worker.tracks`, chat payload type); shared context: this handoff only.

## Changes

- **Files changed:** 19 files, +1153 / -125 (`git diff --stat be55e9c..48ee111`).
- **Behavior changed:**
  - Watch (25c3624): the restarted watcher's first tick used to return without rescheduling when the previous generation's scan was still running, and that scan did not reschedule either. The tick now retries after `GATE_WATCH_BUSY_RETRY_MS` = 250 ms. Scans still never overlap.
  - Chat (0715f94): every outgoing chat message (employee, stranger, presence, presence-health, channel test) is `{ text }` only. Line shape: `[[CỔNG RA]] <name> (<code>) - HH:MM:SS DD/MM/YYYY`, detail lines, then the link.
  - Tracker (ce30915): motion association stage for unmatched detections (mutual, unambiguous, reach grows with the frame gap); a tentative track ends on a missed frame or after `tentativeGraceMs` 1200 ms, not after 500 ms of wall time; embedding budget 3 -> 8 with evidence-short tracks first and new faces last; uncertain embeddings do not charge the budget (bounded by `maxConflictsPerTrack` 3); `reseed` restarts a weak reference and the decider drops the earlier evidence; one embedding per frame; a young track that names a nearby established track ends as `merged` and owes no outcome; decided tracks stay out of the motion stage.
  - Per-gate floor (e9a22c5): unset means unchanged behaviour.
  - Counters (48ee111): diagnostics only, no decision reads them.
- **API/event contracts added or changed:**
  - Outgoing chat webhook body is `{ "text": string }`; `attachments` is gone.
  - `GET /api/camera-streams/watch`: `watchers[].pipelineStats.worker.tracks` (optional) = `{ ended, unconfirmed, merged, embeddingsUnconfirmed, conflicts, reseeds }`, six non-negative integers, cumulative since the worker started. The host drops the object unless all six are valid.
  - Track end reason `merged` and embedding status `reseed` inside the worker (not exposed in any route).
- **Schema/migration changed:** none.
- **Environment/configuration changed:** new optional `PIPELINE_MIN_FACE_PX_BY_GATE` (`gate:px` pairs, comma separated, px 24..2000, for example `exit:60`), passed through `docker-compose.yml`, documented in `.env.example`. It overrides `PIPELINE_MIN_FACE_PX` for the named gate's worker only. Intended live value: `exit:60`. That is a live `.env` change and needs owner approval with the deploy.
- **Security/privacy impact:** no door path touched; both gates stay in shadow and the pipeline cannot open a door. No new data stored. Counters carry no identity, image or embedding. Chat text carries the same fields the attachment carried.

## Verification

Image built from the clean worktree at 48ee111 with its own tag so other sessions' `smartface-tests:latest` is not replaced. Containers capped at 2 CPUs (shared host). Logs in `/home/dev-admin/build-exit-evidence/`.

```text
command: docker build --target tester -t smartface-tests:exit-evidence .
result:  exit 0

command: docker run --rm --network none --cpus 2 --memory 4g --entrypoint npm smartface-tests:exit-evidence test
result:  exit 0; tests 1573, pass 1564, fail 0, skipped 9 (need model files or ffmpeg in the image), cancelled 0

command: docker run --rm --network none --cpus 2 --memory 4g --entrypoint npm smartface-tests:exit-evidence run lint
result:  exit 0

command: docker run --rm --network none --cpus 2 --memory 4g --entrypoint npm smartface-tests:exit-evidence run build
result:  exit 0

command: itest.sh <worktree> itest-final.log tests/integration/*.test.ts
         (disposable server `ee-itest` on docker network `itest-ee`, SQLite, FACE_ENGINE=onnx with /data/models,
          fixture operator/viewer/device/internal tokens, login rate limit raised; never :8080 or the live PG;
          runner: node --import tsx --test --test-concurrency=1)
result:  exit 1; tests 447, pass 400, fail 3, skipped 44, cancelled 0
```

- The 3 integration failures exist on the base commit be55e9c in the same harness (base source extracted with `git archive`, same image):
  - `nGatesSecurity.test.ts` "path case variants fail closed" and "entry/exit: undeletable under any spelling": `GET /API/GATES` answers 403 where the test accepts 404 or the SPA shell. Base: same 2 failures (81 tests, 79 pass).
  - `faceEngineStatusRedaction.test.ts` "failedByCode keys are error codes": the test regex `/^[a-z-]+$/` rejects the real code `not_ready`. Passes alone (4 of 4 on the branch), fails once an earlier file has produced a `not_ready`. Base: same failure when run after the same earlier files (107 tests, 1 fail).
  - Not fixed here: both are outside this task. Proposal: allow `_` in the test regex; decide whether 403 is the intended answer for a re-spelled route and align the test.
- Integration skips: 39 need `PERSISTENCE_PG_URL` (throwaway PostgreSQL), 4 need RTSP or NVR fixtures, 1 needs a dedicated rate-limit gateway. This wave changes no persistence code.
- New or changed tests: `tests/tracker.test.ts`, `tests/trackDecision.test.ts`, `tests/pipelineWorker.test.ts`, `tests/pipelineHost.test.ts`, `tests/chatText.test.ts`, `tests/integration/gateWatch.test.ts` (regression for the race), `tests/integration/strangerWebhook.test.ts`.
- **Not run and why:**
  - No integration test covers `pipelineStats.worker.tracks` in the watch route: the pipeline needs a camera stream. Unit tests cover the worker counters, the protocol check and the host.
  - PG persistence integration tests (skipped as above).
  - Nothing was run on the live gateway. Loop timing with 4 ORT threads on live is not measured.
- **Manual verification:** offline, on dev, with the real exit clip of 2026-11-25 12:04:53 local pulled from the NVR, 58 people and 1001 templates read through a pipe (never printed). The three exit templates enrolled on 25/11 were excluded on purpose.

  Decision thresholds: acceptSingle 0.55, minEvidence 0.35, acceptFused 0.45, minAgreeing 2, minMargin 0.08.

  Real-time replay through the real worker bundle, 2.5 CPUs:

  | Worker | Floor | ORT threads | Result |
  |---|---|---|---|
  | live c94472c | 40 (live setting) | 2 | 4 results, all insufficient |
  | live c94472c | 60 | 2 | 7 results, all insufficient, 0 embeddings used |
  | branch | 60 | 2 | 3 runs: walker = employee in 3 of 3, fused 0.501 / 0.499 / 0.477; second person stranger in 2 runs, insufficient in 1 |
  | branch | 40 | 2 | walker = employee (single 0.569), 1 stranger, 2 insufficient fragments |
  | branch | 60 | 1 | 0 employees, both insufficient (loop median 333 ms, p90 994 ms) |

  Branch at floor 60 with 2 threads: about 30 of 251 frames processed, loop median 215 to 234 ms, p90 609 to 685 ms, a frame with one embedding takes 560 to 660 ms, 6 embeddings in the pass.

  Simulator (cached detections and embeddings, synthetic timing), floor / detect ms / embed ms / stride: the walker is employee in 10 of 11 configurations, fused 0.46 to 0.533, no wrong employee anywhere. The failing one is 60/400/600/1, a 1 s frame gap.

  Ablations in the simulator: budget 5 breaks 40/110/200/3; `tentativeGraceMs` 500 breaks 40/300/500/1; `motionMaxSpeed` 0 breaks most configurations, so the motion stage is the essential part; `refreshAfterMs` 0 changes no outcome, so refresh has no measured effect; ungating the first-sight embedding changes nothing.

  Live gate health after the replays and gates (07:30 UTC): entry 8.3 fps, 250 reconnects; exit 8 fps, 8 reconnects; both unchanged, `totalRuns` rising.

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** tag the running image before the deploy (`docker tag smartface-app:latest smartface-app:pre-exit-evidence`); to roll back, retag it as `latest`, remove `PIPELINE_MIN_FACE_PX_BY_GATE` from `.env`, `docker compose up -d` without `--build`. About 1 minute, same gap in scanning as any restart. No data to restore.
- **Backward compatibility:** `worker.tracks` is optional and additive. The chat body change is not backward compatible for a receiver that reads `attachments`; none is known, see risks.
- **Data retention/deletion impact:** none in the product. The replay clip, ROI frames and embedding cache used for verification were deleted on 2026-11-25 07:13 UTC.
- **Deployment/restart required:** yes, a rebuild and container restart, plus the `.env` line for `exit:60`. Needs the owner's explicit "deploy" in the performing session. A restart also resets the heap that crashed on 19/11 after 10.9 days.

## Risks and follow-up

- **Known risks:**
  - The embedding still blocks the worker loop. It is now bounded to one per frame. The fix works when a frame with an embedding stays under about 0.7 s and fails at about 1 s. Live exit runs 4 ORT threads with a 155 to 170 ms detect loop, so it should be inside the working range, but that is not measured.
  - Margins over `acceptFused` 0.45 are thin (0.46 to 0.53) without the 25/11 templates.
  - Reseed: a face from another person in the 0.25 to 0.45 band with a clearly better selection score can take over a track. The decider then uses only the new evidence and the earlier person gets no outcome. Shadow only.
  - Floor 40 at the exit produces fragment tracks; hence `exit:60`.
  - Chat: unknown whether the chat-room webhook or a downstream reader depends on `attachments`. Verify right after deploy with the admin channel test ("Tin thử").
- **Unresolved questions:**
  - Option C, a second worker thread for embeddings (about +170 to 250 MB per gate, pattern in `src/server/faceExtractWorker.ts`). Not built. Trigger: after one day in shadow, build it if a frame with an embedding exceeds about 0.7 s on live, or the exit insufficient share (84% before the fix) stays high while `tracks.unconfirmed` stays high.
  - The two pre-existing integration failures above.
- **Dependencies on other agents/commits:** none.
- **Requested integration action/order:** fast-forward main to 48ee111 plus this handoff; deploy only on the owner's word; then set `PIPELINE_MIN_FACE_PX_BY_GATE=exit:60`, confirm `/api/health`, rising `totalRuns` on both gates, `worker.tracks` present, and one "Tin thử" message in the chat room.

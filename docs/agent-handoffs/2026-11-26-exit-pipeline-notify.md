# Agent handoff

## Task

- **Title:** Real-time pipeline posts the employee chat message on a chosen gate (plan step 3, Taiga #523)
- **Owner/agent:** INT (Hermes), integration owner; owner hai.vo said "go 3" on 2026-11-26.
- **Acceptance criteria:**
  - A gate in `PIPELINE_NOTIFY_GATES` sends the same chat message as the door scan when its real-time pipeline recognises an employee.
  - One passage gives one message, whichever path sees it first: at most one message per gate and employee per `PIPELINE_NOTIFY_DEDUPE_SECONDS` (default 60).
  - The pipeline never unlocks, never writes an access-log row and never stores an image.
  - The door scan keeps recording: its access-log row, SSE event and unlock do not depend on the claim.
  - A gate not in the list behaves exactly as before.
- **Scope explicitly excluded:** access-log rows or attendance records from the pipeline; stranger alerts from the pipeline; the entry gate (pipeline recall there is 23%, it needs its own work); turning off the door scan; UI changes; any deploy.

## Source control

- **Branch/worktree:** `feat/exit-pipeline-notify`, `.claude/worktrees/pipeline-notify`
- **Base SHA:** `1bc2263` (origin/main)
- **Commit SHA(s):** `4d77e1f` (feature), this handoff commit
- **Rebased/updated before handoff:** yes, origin/main is still `1bc2263`.

## Ownership

- **Files owned:** `src/server/pipelineNotify.ts` (new), `server.ts`, `tests/pipelineNotify.test.ts` (new), `.env.example`, `docker-compose.yml`, this handoff.
- **Files forbidden/not touched:** `src/server/db.ts`, `src/types.ts`, `src/components/**`, `src/App.tsx`.
- **`server.ts` touched:** yes (INT is the designated backend integrator).
- **Other hotspot touched:** none.

## Changes

- **Files changed:** see the file list above.
- **Behavior changed:**
  - `reportPipelineResult`: an `employee` outcome on a gate whose pipeline runs and that is in `PIPELINE_NOTIFY_GATES` calls `notifyFromPipeline`.
  - `notifyFromPipeline` looks up the employee and the gate's direction, claims the slot, and calls `sendEtonWebhook`. It sends a message only.
  - `applyRecognitionOutcome` (door-scan grant): on such a gate, it claims the same slot before `sendEtonWebhook`. When the claim is refused, it logs `[Webhook] <gate>: bỏ tin trùng cho <code>, luồng <source> đã gửi Ns trước.` The row, SSE event, unlock and mobile notification are unchanged.
  - Both claims use `Date.now()`, the same clock.
  - At startup it logs `[Pipeline] Gửi tin nhắn từ luồng thời gian thực: exit, chống trùng 60s.` when the list is set, and it names any ignored values.
- **API/event contracts added or changed:** the `pipeline_shadow_result` SSE payload and the shadow log line gain an optional `notify: "sent" | "duplicate" | "skipped"`. The field is additive and present only on notify gates. No HTTP API change.
- **Schema/migration changed:** none.
- **Environment/configuration changed:**
  - `PIPELINE_NOTIFY_GATES` takes gate ids, comma or space separated. Blank means off. Values that are not gate ids are ignored and logged.
  - `PIPELINE_NOTIFY_DEDUPE_SECONDS` takes whole seconds from 1 to 3600 and defaults to 60.
  - Both are passed through in `docker-compose.yml` and documented in `.env.example`.
- **Security/privacy impact:** no new data is stored or sent. The message text and destination are the existing door-scan ones, and the same webhook destination guard applies. The pipeline identity decision gains a consequence, a chat message, but no door action. The door invariants are unchanged: nothing from the pipeline reaches `unlockDoor`, `saveAccessLog` or image storage, and a wiring test asserts it.

## Verification

```text
command: docker build --target tester -t smartface-tests:pipeline-notify .
result: exit 0

command: docker run --rm --network none --cpus 2.5 smartface-tests:pipeline-notify npm test
result: exit 0; tests 1587, pass 1577, fail 0, skipped 10
        (the new skip: the compose pass-through check, docker-compose.yml is not in the image build context)

command: same image with the host docker-compose.yml mounted: node --import tsx --test tests/pipelineNotify.test.ts
result: tests 14, pass 14, fail 0, skipped 0

command: npm run lint (tsc --noEmit) in the image
result: exit 0

command: npm run build in the image
result: exit 0

command: integration, full suite, disposable server on an isolated network (never :8080)
         /home/dev-admin/build-pipeline-notify/itest.sh <worktree> <log> tests/integration/*.test.ts
result: tests 447, pass 400, fail 3, skipped 44. The 3 failures are the ones that already fail on be55e9c and 1bc2263
        (nGatesSecurity "path case variants fail closed", nGatesSecurity "entry/exit: undeletable under any spelling",
        faceEngineStatusRedaction "faceExtract and bestOf are counters ..."); see the 2026-11-25 handoff.
```

- **Not run and why:** no integration test drives a camera stream through the pipeline; that needs a stream fixture. It was covered by the dev end-to-end run below.
- **Manual verification (dev end-to-end):**
  - **Setup:** an internal Docker network with no route out. The fake camera was mediamtx serving a 20 s NVR clip of one exit passage, looped. A webhook sink printed each message. The gateway was built from this branch: JSON store, gate area 0.1/0.3/0.8/0.7, INT8 pipeline detector, `FACE_DETECT_TILES=auto` like live, `PIPELINE_MIN_FACE_PX_BY_GATE=exit:60`.
  - **Dev-only thresholds:** a single "Dev Test Ra" employee was enrolled from crops of the clip with a 0.4 quality gate. The accept thresholds were lowered (door 0.45, pipeline 0.5) so both paths recognise the crop-enrolled person often. This tests the plumbing, not accuracy.
  - **Notify on, final revision, 4 min:** the door scan wrote 4 GRANTED rows. The sink got 3 messages, 76 s and 75 s apart. Pipeline decisions alternated sent and duplicate. Door-scan grants inside the window were skipped and logged, both "door-scan đã gửi 59s trước" and "pipeline đã gửi 28s trước".
  - **Control, notify off:** the pipeline recognised the person 4 times and sent 0 messages, with no `notify` field. The door scan wrote 1 GRANTED row and sent 1 message.
  - **Cleanup:** clip, frames and crops were deleted after each run, and the containers and network were removed.

## Data and deployment

- **Forward migration:** none.
- **Rollback or compensation:** remove `PIPELINE_NOTIFY_GATES` from `.env` and run `docker compose up -d --no-deps smartface-app`, about 1 minute with about 20 s without scanning. For a code rollback, retag the previous image. Nothing to restore.
- **Backward compatibility:** with the variable blank, which is the default, behaviour is identical to `1bc2263`.
- **Data retention/deletion impact:** none.
- **Deployment/restart required:** yes, a rebuild plus `.env` `PIPELINE_NOTIFY_GATES=exit`. It needs the owner's explicit "deploy".

## Risks and follow-up

- **Known risks:**
  - The pipeline names about 129 more exit passages per day than the door scan. Those people will now get a message where there was none. That is the intent, but it is a visible change.
  - The NVR spot check (14/14) is a machine cross-check with the same recogniser family, not a human look.
  - A person who walks out, comes back and walks out again within 60 s at the same gate gets one message.
  - The dedupe registry lives in memory. A restart within a passage can give one repeat message.
  - The message time is the send time, as with the door scan.
- **Unresolved questions:**
  - Should pipeline-only passages also become access-log or attendance records? They do not today, so the weekly counts still come from the door scan only.
  - The entry gate needs its own investigation: recall 23%, and 30 short reconnects on 25/11 from 21:29 local.
- **Dependencies on other agents/commits:** none.
- **Requested integration action/order:** fast-forward main. Deploy on the owner's word with `PIPELINE_NOTIFY_GATES=exit`. After deploy, check the startup line, `totalRuns` rising, and a real exit message. Then compare daily exit message counts with the door-scan GRANTED counts for a few days.

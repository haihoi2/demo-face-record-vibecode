# Agent handoff

## Task

- **Title:** Admin switch for a gate's pipeline chat messages in the app, plus the in-app admin guide for adding a gate. Taiga [#580](https://taiga.eton.vn/project/ithelpdesk-2026/task/580).
- **Owner/agent:** Hermes (integration owner).
- **Acceptance criteria:**
  - An admin turns the real-time pipeline's chat messages on or off per gate in Cấu Hình AI. The change takes effect without a restart.
  - `PIPELINE_NOTIFY_GATES` stays the default. `null` goes back to it.
  - Viewers and operators get 403. The operator's config save can neither set nor drop the value.
  - The guide is served at `/huong-dan/them-cong.html` and linked from Luồng Camera.
- **Scope explicitly excluded:**
  - Deployment.
  - Taiga [#581](https://taiga.eton.vn/project/ithelpdesk-2026/task/581): enrol once, use at many cameras. That task is a plan only.

## Source control

- **Branch/worktree:** `feat/pipeline-notify-toggle`, worktree `.claude/worktrees/pipeline-notify`. It is stacked on `feat/admin-guide-page`.
- **Base SHA:** 934dffc (main).
- **Commit SHA(s):** d106c8c (guide in app), 3c9dcc8 (#580). The guide update and this handoff are in the last commit.
- **Rebased/updated before handoff:** yes.

## Ownership

- **Files owned:**
  - `server.ts`, `src/server/auth.ts`, `src/server/db.ts` (type only), `src/types.ts`.
  - `src/utils/pipelineMode.ts`, `src/components/RealtimeEngineCard.tsx`, `src/components/CameraStreamConfigPage.tsx`, `src/utils/gates.ts`.
  - `public/huong-dan/them-cong.html`, `.env.example`, tests.
- **Files forbidden/not touched:** face engine, door controller, persistence SQL.
- **`server.ts` touched:** yes. Hermes is the single writer.
- **Other hotspot touched:** `src/types.ts` gained optional fields. `src/server/db.ts` gained an optional field on the camera-config record type. No SQL changed.

## Changes

- **Behavior changed:**
  - `pipelineNotifyFor(gate)` uses the config's `pipelineNotify` boolean if one is set. Otherwise it uses `PIPELINE_NOTIFY_GATES`.
  - `pipelineNotifyActive` now goes through `pipelineNotifyFor`. That function is used for the door-scan claim, the pipeline message and the attendance row.
- **API/event contracts added or changed:**
  - New `POST /api/camera-streams/:gate/pipeline-notify` with body `{ enabled: true | false | null }`. Admin only.
    - Returns `{ success, gateId, gateLabel, pipelineNotify, pipelineNotifySource, pipelineRunning, watcher }`.
    - Returns 400 for a missing or non-boolean value, or for an unknown gate.
  - The watch runtime gains `pipelineNotify` and `pipelineNotifySource`.
  - The gate summary includes `pipelineNotify` when it is set.
- **Schema/migration changed:** none. The value lives in the camera-config JSON, where an unknown or non-boolean value is dropped.
- **Environment/configuration changed:** none. The `.env.example` comment now says the env value is the default.
- **Security/privacy impact:**
  - The new write route is admin only and is in the role matrix test.
  - It sends no unlock and sends no message itself.
  - The guide loads nothing external and contains no addresses or credentials.

## Verification

```text
command: docker build --target tester -t smartface-tests:notify-toggle . ; docker run --cpus 2.5 --network none ... npm test | npm run lint | npm run build
result:  unit 1613 tests, 1603 pass, 0 fail, 10 skipped; lint exit 0; build exit 0 (dist/huong-dan/them-cong.html present)

command: itest.sh (disposable gateway + throwaway PG, --internal --subnet 192.168.250.0/24, route to 192.168.60.1 checked) on pipelineNotifySwitch, pipelineMode, operatorRoleSeparation, nGates, pipelineNotify*
result:  34 tests, 34 pass

command: itest.sh tests/integration/*.test.ts
result:  457 tests, 449 pass, 3 fail, 5 skipped; the 3 fails are the known baseline (2 N-gates security subtests, strangerClusterEdit needs a PG gateway), same as e1a3a20
```

## Risks, migration, rollback, compatibility

- **Live on deploy:** no gate has `pipelineNotify`, so the exit gate keeps its env value. Nothing changes until an admin uses the switch.
- **Rollback:** retag the previous image and recreate the container, about 1 minute. An old build ignores a stored `pipelineNotify`, and the env value applies again.
- **Older server:** the card shows no switch when the watcher has no `pipelineNotify`.

## Unresolved questions and requested integration action

- **Before deploy:** a dev end-to-end run of the switch with a real pipeline. Steps: on, a message arrives; off, no message; a restart keeps the choice.
- Deploy only after hai.vo gives an explicit "deploy".

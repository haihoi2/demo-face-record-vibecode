# Agent handoff

## Task

Owner choice "A" (27 Nov 2026, Taiga #523): a passage that only the exit gate's real-time pipeline saw is also
recorded in the access history, so the weekly report and attendance count it.

Acceptance:

- On a gate in `PIPELINE_NOTIFY_GATES`, when the pipeline itself sent the chat message (`notify: "sent"`) and no
  GRANTED row of that employee exists at that gate for the passage, the pipeline writes one access-log row:
  `status GRANTED`, `source "pipeline"`, `lockAction "Không mở cửa (chỉ ghi nhận lượt đi qua)"`, no image, the
  track id and capture time, the door scan's confidence scale.
- The row is written one pairing window (`SHADOW_MATCH_WINDOW_MS`, 15 s) after the decision, after the shadow
  pairing, so a door-scan grant of the same passage that lands late still wins.
- Never an unlock, never an image, never a change to the door's grant cooldowns; the door-scan row stays the
  security fact of a passage it recorded.
- Door-scan rows and every older row: unchanged, `source` NULL.

## Source control

- Branch `feat/pipeline-access-log` (worktree `.claude/worktrees/pipeline-notify`), base `1bd39b8` (main).
- Commits: see `git log 1bd39b8..` on the branch (feature + this handoff).

## Ownership

- `server.ts touched: yes` (Hermes, single writer). Also `src/server/db.ts`, `src/types.ts` (hotspots, Hermes),
  `src/server/pipelineNotify.ts`, `src/components/AccessLogs.tsx` (one line), tests, `.env.example`.

## Changes

- `src/server/db.ts`: new nullable column `access_logs.source` (PG `VARCHAR(16)`, SQLite `TEXT`), added by
  `ADD COLUMN IF NOT EXISTS` / the SQLite ALTER list; written by every insert path (live insert, PG seed, SQLite
  mirror); read by every list path. `storableAccessLogSource()` stores only `"pipeline"`, anything else NULL.
- `src/server/pipelineNotify.ts`: pure `recentGrantRowId()` (same person, same gate, passage time inside the
  window; compares `capturedAt` so one row per message) and `pipelineConfidencePct()`.
- `server.ts`:
  - `reportPipelineResult` chains `recordPipelinePassage()` after `persistShadowResult()` only when `notify === "sent"`.
  - `recordPipelinePassage()` skips when the paired door-scan event is a grant of the same employee or
    `recentGrantRowId()` finds a grant row, else writes the row, `broadcastSSE("access_granted")` (the UI only
    prepends it to the list), logs `Ghi lượt ...`.
  - `nearestLegacyEvent()` ignores `source: "pipeline"` rows (they are not door-engine events).
  - `sanitizePublicJson()` (the response filter every JSON body passes): keeps `source` and an already computed
    `hasImage`. **Bug fixed on the way:** it used to compute `hasImage` from the image URL, so every history row
    said `hasImage: true`.
- `src/components/AccessLogs.tsx`: no thumbnail request for a row with `hasImage === false`.
- `src/types.ts`: `AccessLog.source?: 'pipeline'`.
- API: history rows may carry `source: "pipeline"`; `hasImage` is now correct. No new route, no new env.

## Verification

All in Docker, `--cpus 2.5`, isolated networks with a pinned subnet (see Risks).

- `docker build --target tester -t smartface-tests:pipeline-access-log .`: exit 0.
- Unit (`docker run --rm --network none <image>`): 1597 tests, 1587 pass, 0 fail, 10 skipped.
- `npm run lint`: exit 0. `npm run build`: exit 0.
- Integration, full suite, gateway on JSON store + throwaway PostgreSQL 18 for the persistence tests
  (`PERSISTENCE_PG_URL`), final revision: 450 tests, 442 pass, 3 fail, 5 skipped. Gateway on that PostgreSQL for
  `strangerClusterEdit`, `accessLogSourcePersistence`, `accessLogTracePersistence`: 13/13 pass. Fails: the 2 known `N gates: security` subtests
  (pre-existing on main) and `strangerClusterEdit` (needs the gateway itself on that PostgreSQL; passes 7/7 when it
  is, together with the new source test).
- New `tests/integration/accessLogSourcePersistence.test.ts`: previous-release PG schema gains the column without
  default or backfill, round trip through query/page/hydration, unknown values stored NULL, old INSERT still works,
  `DROP COLUMN` rollback keeps the events and a restart re-adds it; SQLite round trip across a restart.
- Dev end-to-end (isolated network, NVR clip looped through mediamtx, sink for the chat webhook, dev-only lowered
  thresholds):
  - door scan off: 3 messages, 3 rows `source pipeline`, `hasImage false`, each 15 s after its message.
  - door scan on: the door scan granted first (row with image, unlock, message); the pipeline's later decision
    was `notify: duplicate`, no row; later pipeline-only passages: 2 messages, 2 rows.
  - The first run exposed the message/row mismatch for a repeat passage 60-75 s later (row skipped because the
    previous row was WRITTEN inside the window); fixed by comparing `capturedAt` (unit test added).

## Data and deployment

- Migration: additive nullable column, catalog-only, no backfill (history immutable). Runs at startup.
- Rollback: redeploy the previous image (`smartface-app:pre-pipeline-attendance`), the column is ignored by older
  code; optionally `ALTER TABLE access_logs DROP COLUMN "source"` (loses only the marker). Rows already written
  stay as GRANTED attendance rows with lockAction "Không mở cửa"; delete them only with the owner's yes.
- Live config unchanged: `PIPELINE_NOTIFY_GATES=exit` is already set.

## Risks and follow-up

- A pipeline-first passage whose door-scan grant lands more than 15 s later gets two rows (pipeline + door scan).
  Rare (the door scan takes 2-4 s); attendance uses first-in/last-out.
- Pipeline rows count in the weekly report and "GRANTED" totals; they are marked by `source` and lockAction.
- `sanitizePublicJson` still drops `capturedAt`, `trackId`, `recordingChannel` and `mergedInto` from history rows
  (pre-existing; not changed here).
- Incident during this work (27/11 03:55:40-03:57:50Z): the first integration network was created without
  `--subnet`, Docker picked 192.168.48.0/20, which routed the live exit camera and the NVR into the bridge. The
  live exit camera was down 2 min 10 s; NVR playback shows 2 employees passing unrecorded. Runners now pin
  `--internal --subnet 192.168.250.0/24` and check `ip route get 192.168.60.1` before running.

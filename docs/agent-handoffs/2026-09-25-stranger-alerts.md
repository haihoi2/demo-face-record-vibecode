# Handoff: per-person stranger alerts, flood cap, CSV export name

- Branch: `feat/stranger-alerts` (worktree `build-release-ci`), base `20341a9`
- Commits: `e00e9b6` (behaviour), `b568a7b` (integration-test helper)
- `server.ts touched: yes` (sendStrangerWebhook, its caller, CSV export route)

## Task and acceptance

1. A second, different stranger within the alert cooldown is alerted; the same
   person lingering is alerted once (window extends while they stay).
2. At most `STRANGER_ALERT_MAX_PER_MINUTE` (default 6) alerts per rolling
   minute; suppressed alerts are reported as "+N" in the next alert.
3. CSV export filename dates are in `SITE_TIMEZONE`; `to` names the last day included.

## Contracts / env

- New env: `STRANGER_ALERT_MAX_PER_MINUTE` (integer 1-600, blank = default 6).
- `strangerCooldownSeconds` keeps its name and storage; its meaning changes
  from global to per person. The UI label/help text says so.
- No API or schema change. The test-send route still bypasses cooldown and cap.

## Verification

- Typecheck clean; unit 256 tests, 252 pass, 0 fail (4 skipped); `npm run build` clean.
- Integration on SQLite: 162 pass, 0 fail.
- Integration on throwaway postgres:18-alpine: before the helper fix, 3/3 runs
  failed on a different stranger subtest each time; after it, 12 of 13 runs
  passed. The one failure (merge subtest) was not captured and did not recur in
  10 further runs.

## Risks / rollback

- Alert state is in memory; a restart forgets who was alerted (at most one
  repeat alert per person after a restart).
- A person held back by the flood cap counts as alerted (reported in "+N") and
  is not re-alerted within the cooldown.
- Rollback: redeploy the previous image; no data migration.

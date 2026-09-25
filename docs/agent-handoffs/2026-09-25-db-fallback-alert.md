# Handoff: alert loudly when writes are not reaching PostgreSQL

- Branch: `feat/db-fallback-alert`, base `46e4e78`
- `server.ts touched: yes` (/api/health body, new GET /api/storage-status); `src/server/db.ts` touched
- Owner's decision (2026-09-25): keep the SQLite fallback so the gates stay up, but alert loudly.

## Behaviour

- Startup fallback (DATABASE_URL set, PostgreSQL unreachable after the 6 retries):
  `/api/health` answers `{"status":"degraded"}` (HTTP 200, so the healthcheck does not
  restart the gates), a loud `console.error`, and a red banner for every signed-in role.
- Mid-run outage: PostgreSQL connection errors on pool queries/connect mark storage
  degraded until the next successful query. SQL errors (constraint, type) do not count.
- New pool "error" listener: previously an idle connection dropped by a PostgreSQL
  restart emitted an unhandled "error" (process crash risk).
- `GET /api/storage-status` (viewer+): expected/active store, degraded, since, reason.
  The reason never contains hosts or credentials. `/api/health` stays public and says
  only ok/degraded.
- Not changed: fallback still requires a gateway restart to return to PostgreSQL after a
  startup failure, and rows written during a fallback still need copying back by hand.

## Verification

- Typecheck clean; unit 264 tests, 260 pass, 0 fail (4 skipped); build clean.
- Integration: SQLite 162/0, throwaway postgres:18-alpine 162/0 twice.
- Manual: unreachable PG at startup -> degraded after ~45 s, 401 for anonymous
  storage-status; PG stopped mid-run -> degraded at once, gateway stays up, back to ok
  within 2 s of PG returning.

## Data action taken on live (owner-approved)

Copied the 4 access logs that existed only in the SQLite fallback (startup race,
2026-09-25 03:24-03:34Z) into PostgreSQL, insert-only. Ids and rollback statement:
`demo-face-record-vibecode-backups/20260925T213635Z-backfill/backfilled-ids.txt`.
Not copied: 3 demo seed rows and 26 simulated grants from 2026-09-12/13.

## Rollback

Redeploy the previous image; no schema change.

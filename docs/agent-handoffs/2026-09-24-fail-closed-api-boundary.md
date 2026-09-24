# Agent handoff

## Task

- **Title:** Land the fail-closed API authorization boundary and complete its frontend callers
- **Owner/agent:** Claude (taking over the in-flight work left uncommitted on this branch)
- **Acceptance criteria:** typecheck clean; unit suite 0 failures; integration suite 0 failures; production build clean; CI workflow able to run the suite it now needs.
- **Scope explicitly excluded:** deployment, secret generation, `.env` changes on this host, key rotation, the `agent/build/ci-baseline` worktree, threshold recalibration, liveness modelling.

## Source control

- **Branch/worktree:** `agent/backend/stranger-ci-baseline` @ `/opt/etonlab/dev/demo-face-record-vibecode`
- **Base SHA:** `c7bd678` ("Harden stranger recognition and add CI baseline")
- **Commit SHA(s):** `f95caf2` (security boundary), `b22a8d5` (frontend callers)
- **Rebased/updated before handoff:** no — base is unchanged since `c7bd678`; `main` is at `14f58b3`, an ancestor.

## Ownership

- **Files owned (this session's own edits, in `b22a8d5`):** `tests/frontendFailClosed.test.ts`, `src/components/CameraStreamConfigPage.tsx`, `src/components/DoorConfigPage.tsx`, `src/components/EmployeeRegistration.tsx`, `src/components/WebhookIntegration.tsx`, `.github/workflows/ci.yml`
- **Files forbidden/not touched:** everything in `../demo-face-record-vibecode-wt/build-release-ci`
- **`server.ts` touched:** no — `f95caf2` carries another session's `server.ts` work verbatim; this session added nothing to it
- **Other hotspot touched:** `src/server/db.ts`, `src/types.ts` likewise carried verbatim in `f95caf2`, not edited here

> `f95caf2` is the wave written by the other session between 2026-09-22 and 2026-09-24 00:41. It sat uncommitted for two days. This session verified it and committed it unchanged rather than leaving it at risk in the working tree.

## Changes

- **Files changed:** 34 (28 modified, 6 added). Added: `src/components/ProtectedImage.tsx`, `tests/integration/securityMatrix.test.ts`, `tests/offlineStorage.test.ts`, `tests/protectedImage.test.ts`, `tests/frontendFailClosed.test.ts`, this handoff.
- **Behavior changed:** the API is authenticated by default. `/api/*` and the legacy aliases (`/events`, `/lock`, `/employees`, `/logs`, `/notifications`, `/webhook`) require an operator session — viewer role for GET/HEAD, operator role plus session CSRF for mutations. Exempt: `/api/health`, `/api/operator/session`, `/api/system/db-info` (`INTERNAL_API_TOKEN` bearer), recognition ingest (`DEVICE_INGEST_TOKEN` bearer, rejected if an `Origin` header is present).
- **API/event contracts added or changed:** `GET /api/logs` now returns a bounded `{ logs, ... }` page instead of a bare array — **breaking**. New: `POST/GET/DELETE /api/operator/session`, `GET /api/strangers/lookup`, `GET /api/strangers/clusters/:clusterId`, `GET /api/strangers/resolutions/:clusterId`. SSE events no longer carry biometric bytes or embeddings.
- **Schema/migration changed:** new table `stranger_resolution_events` plus index `idx_stranger_resolution_events_cluster` in `init-db.sql`. Additive; created with `IF NOT EXISTS`.
- **Environment/configuration changed:** new required-in-production vars `OPERATOR_ID`, `OPERATOR_TOKEN`, `OPERATOR_SESSION_SECRET`, `DEVICE_INGEST_TOKEN`, `INTERNAL_API_TOKEN`; optional `VIEWER_ID`, `VIEWER_TOKEN`, `OPERATOR_COOKIE_CROSS_SITE`, `ENABLE_DEMO_DATA`, `VITE_ENABLE_DEMO_OFFLINE_PERSISTENCE`. Documented in `.env.example`, wired in `docker-compose.yml`, supplied in CI.
- **Security/privacy impact:** closes unauthenticated access to `/api/lock/unlock`, the employee roster, access logs and biometric images. Adjudication history is append-only. JSON responses are redacted of RTSP credentials, token/key query parameters and webhook path secrets. Eleven legacy `localStorage` keys holding face snapshots, door-controller config and webhook config are purged in the browser.

## Verification

```text
command: docker compose --profile test build tests
result:  exit 0

command: docker compose --profile test run --rm --entrypoint npm tests run typecheck
result:  exit 0, no diagnostics

command: docker compose --profile test run --rm tests
result:  exit 0 — tests 149, pass 145, fail 0, skipped 4 (model-gated)

command: docker compose --profile test run --rm -d --name smartface-verify-itest \
           -e NODE_ENV=production -e DATABASE_URL= -e DATA_DIR=/tmp/smartface-verify-data \
           -e ALLOW_SIMULATED_RECOGNITION=false -e ENABLE_DEMO_STRANGER_SEEDS=false -e ENABLE_DEMO_DATA=false \
           -e OPERATOR_ID=itest-operator -e OPERATOR_TOKEN=... -e VIEWER_ID=itest-viewer -e VIEWER_TOKEN=... \
           -e OPERATOR_SESSION_SECRET=... -e DEVICE_INGEST_TOKEN=... -e INTERNAL_API_TOKEN=... \
           -e CORS_ALLOWED_ORIGINS=http://allowed.test -p 3101:3000 \
           --entrypoint sh tests -c 'npx tsx server.ts'
         docker compose --profile test run --rm -e APP_URL=http://smartface-verify-itest:3000 ... \
           --entrypoint sh tests -c 'npm run test:integration'
result:  exit 0 — tests 133, pass 128, fail 0, skipped 5 (model-gated)

command: docker compose --profile test run --rm --entrypoint npm tests run build
result:  exit 0 — dist/server.cjs 381.2kb, dist/faceWorker.cjs 7.8kb
```

- **Not run and why:** no run against live PostgreSQL or the live gateway — the integration suite mutates, and the task was not a deployment. The isolated gateway ran with `DATABASE_URL` empty and `DATA_DIR` under `/tmp`, and was removed afterwards.
- **Manual verification:** confirmed the seven `securityMatrix` tests and the `operator authorization` block execute rather than silently skip; confirmed CI previously lacked `OPERATOR_SESSION_SECRET`, `DEVICE_INGEST_TOKEN` and `INTERNAL_API_TOKEN` and would have failed as committed.

## Data and deployment

- **Forward migration:** `init-db.sql` creates `stranger_resolution_events` on startup. No backfill: absent history means no prior adjudication events, which is accurate.
- **Rollback or compensation:** revert `b22a8d5` then `f95caf2`. The new table can be left in place; nothing else reads it. No destructive data change to undo.
- **Backward compatibility:** **not compatible with the running image.** Any client reading `GET /api/logs` as a bare array breaks. Any client without an operator session gets 401, or 503 while the operator vars are unset.
- **Data retention/deletion impact:** adjudication events accumulate per cluster resolution with no retention policy yet. Browser-side biometric caches are deleted on next load.
- **Deployment/restart required:** yes, and **not without first setting the five environment variables** — otherwise the whole API fails closed with 503, not just the stranger panel.

## Risks and follow-up

- **Known risks:**
  1. Operator login is a `window.prompt()` that fires per 401. Adequate for a test harness, wrong for a wall-mounted operator screen.
  2. `tests/frontendFailClosed.test.ts` asserts against component source text with regexes. It catches real regressions today but will produce false failures on innocuous refactors. Worth converting to behavioural assertions.
  3. Threshold calibration is still based on one subject and one impostor; unchanged by this work.
  4. Stranger-capture quality floor still absent — 57% of stored captures are below usable quality.
- **Unresolved questions:** who holds the operator token in day-to-day use, and whether the viewer principal is wanted at all on this site.
- **Dependencies on other agents/commits:** `agent/build/ci-baseline` still holds `package-lock.json`, the unconditional `npm ci`, `--test-concurrency=1`, and the removal of hardcoded camera credentials from `src/server/db.ts` defaults. That branch overlaps `src/server/db.ts` and `docker-compose.yml` with `f95caf2` and will need a rebase.
- **Requested integration action/order:** integrate this branch first, then rebase `agent/build/ci-baseline` on top and re-run the gates from the merged branch before any deploy.

## Environment note

A stale container `smartface-cluster-red` (127.0.0.1:3112) from the earlier session is still running. It has `OPERATOR_TOKEN` but no `OPERATOR_ID`, so `authConfigured()` is false and every protected route on it answers 503; it also predates the final code. It was left untouched — results read off it are meaningless.

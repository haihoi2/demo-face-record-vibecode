# Agent handoff

## Task

- **Title:** Presence alerts P3a - live mode messages the security group (after hours, no face), grouped per 5 minutes, offline notice
- **Owner/agent:** Hermes (integration owner)
- **Acceptance criteria:** see plan decision 8 (docs/plans/2026-10-02-person-presence-alerts.md). `PRESENCE_MODE_<GATE>=live` sends; `shadow` records only. Text + login link only, no image. alertSentAt recorded and kept. One "offline"/"online" notice per transition.
- **Scope explicitly excluded:** P3b - declarable channels, per-gate settings screen, per-event deep link, anti-false-alarm rule (bench bag), the 19:00-07:00 window revisit after labels.

## Source control

- **Branch/worktree:** `feat/presence-p3a` / `.claude/worktrees/presence-p3a`
- **Base SHA:** d9078c7
- **Commit SHA(s):** see `git log d9078c7..feat/presence-p3a`
- **Rebased/updated before handoff:** yes

## Ownership

- **Files owned:** `server.ts`, `src/server/presence/alerts.ts` (new), `src/server/presence/contracts.ts` (doc), `src/utils/presence.ts` (label), `docker-compose.yml`, `.env.example`, `tests/presenceAlerts.test.ts` (new), plan doc, this handoff
- **Files forbidden/not touched:** `src/server/db.ts`, `src/types.ts`
- **`server.ts` touched:** yes
- **Other hotspot touched:** no

## Changes

- **Behavior changed:** live gates offer every saved presence event to `PresenceAlertBatcher`; a 1 s ticker sends due batches through `sendPresenceWebhook` (shared Eton webhook, destination guard, no redirects, webhook log); sent events get alertSentAt (kept through later upserts via `presenceAlertedAt`). A 10 s ticker sends offline/online notices for live gates after the startup grace.
- **API/event contracts:** `/api/presence/status` gains `alerts: { windowSeconds, health }` for live gates; mode may be `live` (UI label "Đang báo").
- **Schema/migration changed:** no
- **Environment/configuration changed:** `PRESENCE_MODE_<GATE>=live` (new value), `PRESENCE_ALERT_WINDOW_SECONDS` (300), `PRESENCE_ALERT_HOLD_MS` (3000), `PRESENCE_OFFLINE_AFTER_SECONDS` (120); compose passes them.
- **Security/privacy impact:** messages leave the system (owner-approved): gate, local time, duration, person count, event id, link; no image, no crop URL.

## Verification

```text
command: npm run lint / npm test / npm run build (smartface-tests:p3a, --cpus 2.5)
result: lint clean; unit 1218 tests, 1209 pass, 0 fail, 9 skipped; build ok
command: integration suite, fresh gateway on SQLite / on postgres:18-alpine (tmpfs)
result: SQLite 381 tests, 345 pass, 0 fail, 36 skipped; PostgreSQL 381 tests, 376 pass, 0 fail, 5 skipped
command: dev test (scratchpad p3a-dev.sh): throwaway gateway, PRESENCE_MODE_ENTRY=live, no camera, PRESENCE_OFFLINE_AFTER_SECONDS=30, webhook -> local mock (WEBHOOK_ALLOWED_HOSTS + WEBHOOK_ALLOW_HTTP on the test gateway only)
result: webhook off -> "Webhook đang tắt", nothing sent; webhook on -> exactly one "NGỪNG hoạt động" message received by the mock (local time correct, no image), logged "thành công (200)"
```

- **Not run and why:** event alerts end to end with real footage (needs a replayed clip; the batcher, rule and message are unit-tested and the send path is the one the dev test exercised).

## Data and deployment

- **Forward migration:** none
- **Rollback or compensation:** previous image, or set `PRESENCE_MODE_ENTRY=shadow` and recreate the container.
- **Backward compatibility:** shadow/off unchanged.
- **Data retention/deletion impact:** none
- **Deployment/restart required:** yes. Messages start only after `PRESENCE_MODE_ENTRY=live` is set in `.env` (owner approval).

## Risks and follow-up

- **Known risks:** early arrivals before 07:00 still alert (grouped); the 1 s after-hours rule can fire on a static object (bench bag, 1 event in 19 min of replay).
- **Unresolved questions:** window end 07:00 vs 06:00 after labels.
- **Requested integration action/order:** merge, deploy on "deploy p3a", then switch the entry gate to live on owner approval.

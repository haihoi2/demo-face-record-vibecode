# Agent handoff

## Task

- **Title:** P3b integrated - notification channels, alert routing, per-gate presence settings (+ P3a tuning fix)
- **Owner/agent:** Hermes (integration owner); storage by data-migrations (feat/p3b-db, handoff 2026-10-07-p3b-db.md), screens by frontend (feat/p3b-ui, handoff 2026-10-07-p3b-ui.md)
- **Acceptance criteria:** contract docs/plans/2026-10-07-p3b-contract.md sections 1-3.
- **Scope explicitly excluded:** removing the hard-coded Eton webhook URL from WebhookIntegration.tsx / README.md and rotating that token (separate task, owner decision); per-gate period labels in src/utils/presence.ts still say 07:00-19:00.

## Source control

- **Branch/worktree:** `feat/p3b-server` / `.claude/worktrees/p3b-server`
- **Base SHA:** b22adf6 (fix/presence-p3a-tuning, itself on main 51e2b19)
- **Commit SHA(s):** a963a2c (server), merges of feat/p3b-ui (f217ed9, 4fb4b7e) and feat/p3b-db (b4479da), then the integration commit
- **Rebased/updated before handoff:** yes

## Ownership

- **`server.ts` touched:** yes (Hermes). **db.ts:** data-migrations (single writer). **types.ts:** no.

## Changes

- Settings writes use `db.updateAppSetting` (read-modify-write in the store's write queue); a route's refusal (404 / 409 CHANNEL_IN_USE / 400 CHANNEL_LIMIT / SETTINGS_TOO_LARGE) is thrown inside the update so nothing is written.
- Stranger alerts, presence alerts and detector-health notices go to their routed channel through `postToChannel` (guard, no redirects, 7 s timeout, webhook log; declared channels logged masked).
- Saved presence settings take effect at startup through the existing `db.onSync -> syncGateWatchers -> syncPipelines` path (presence on/off is part of the stream key).

## Verification

```text
command: lint / npm test / build (smartface-tests:p3b, --cpus 2.5); integration on SQLite and fresh postgres:18-alpine;
         dev test p3b-dev.sh (throwaway gateway, mock receiver, built-in webhook + declared channel, presenceHealth routed)
result:  lint clean; unit 1289 tests, 1280 pass, 0 fail, 9 skipped; build ok
         integration SQLite 396 tests, 352 pass, 0 fail, 44 skipped; PostgreSQL 396 tests, 391 pass, 0 fail, 5 skipped
         (includes app_settings persistence and notificationChannels suites)
         dev test: channel created (URL masked, never in the list), test send 200, mode live saved,
         offline notice delivered to the declared channel only (built-in webhook received nothing)
```

## Data and deployment

- **Forward migration:** `app_settings` table created at startup (PostgreSQL/SQLite), additive.
- **Rollback:** previous image (pre-p3b); `app_settings` is ignored by older code (drop optional). Live `.env` PRESENCE_MODE_ENTRY=live keeps working either way.
- **Deployment/restart required:** yes (owner approval).

## Risks and follow-up

- Channel URLs (webhook tokens) are stored in plaintext like webhook_config.
- A saved `mode` overrides `.env`; "Đặt lại theo .env" clears it.

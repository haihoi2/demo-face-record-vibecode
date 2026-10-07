# P3b contract - notification channels, alert routing, per-gate presence settings

Owner request 2026-10-07 "go P3b" (plan docs/plans/2026-10-02-person-presence-alerts.md, sections 5-6,
decision 1: declarable channels, all alerts on the shared Eton channel for now).
Integration owner: Hermes. Base branch: `fix/presence-p3a-tuning` (b22adf6).

## 1. Storage (data-migrations agent, `src/server/db.ts`)

One generic key/value table for small admin settings documents, in all three stores:

```
app_settings (
  key        VARCHAR(64) PRIMARY KEY,   -- e.g. "notification_channels"
  value      JSONB NOT NULL,            -- SQLite: TEXT (JSON); JSON fallback: object
  "updatedAt" VARCHAR(64) NOT NULL,     -- ISO
  "updatedBy" VARCHAR(255) NOT NULL     -- actor
)
```

db API (exact names):

```ts
export interface AppSettingRecord<T = unknown> { key: string; value: T; updatedAt: string; updatedBy: string }
db.getAppSetting<T = unknown>(key: string): AppSettingRecord<T> | undefined   // SYNC, from an in-memory cache
db.saveAppSetting<T>(key: string, value: T, actor: string): Promise<boolean>  // durable write, then cache; false on failure
```

- Keys: `^[a-z][a-z0-9_]{1,63}$` (others: getAppSetting -> undefined, saveAppSetting -> false). Value: JSON-serialisable, <= 64 KB serialised (else false).
- PostgreSQL: CREATE TABLE IF NOT EXISTS in the normal migration; the cache is hydrated when PostgreSQL becomes active (same moment the other configs load), so `getAppSetting` is correct right after `db.onSync`.
- SQLite / JSON fallback: same semantics. Values returned are deep copies.
- Rollback: `DROP TABLE app_settings` (nothing else references it).
- Tests: unit (SQLite + JSON), PostgreSQL persistence (PERSISTENCE_PG_URL, throwaway only), restart/read-back.

Keys used by P3b (values are owned by the server, the db does not validate them):
- `notification_channels`: `{ channels: NotificationChannel[] }`
- `notification_routes`: `{ stranger: string; presence: string; presenceHealth: string }` (channel ids)
- `presence_gate_settings`: `{ gates: Record<gateId, PresenceGateSettingsOverride> }`

## 2. HTTP API (Hermes, `server.ts`)

All writes: CSRF. Roles as listed. Errors: `{ success: false, error, code?, field? }`.

### Channels (admin)

```
GET    /api/notification-channels
  -> { success, channels: ChannelView[], routes: { stranger, presence, presenceHealth } }
POST   /api/notification-channels            { name, url, enabled? }        -> { success, channel: ChannelView }
PATCH  /api/notification-channels/:id        { name?, url?, enabled? }      -> { success, channel: ChannelView }
DELETE /api/notification-channels/:id                                        -> { success }
POST   /api/notification-channels/:id/test                                   -> { success, statusCode?, error? }
PUT    /api/notification-routes              { stranger?, presence?, presenceHealth? } -> { success, routes }

ChannelView = {
  id: string;                 // "eton-default" for the built-in one, else "CH-<uuid>"
  name: string;               // 1-60 chars
  type: "eton-webhook";
  builtIn: boolean;           // true only for "eton-default" = the existing webhook settings
  enabled: boolean;
  urlMasked: string;          // e.g. "https://chat.example.vn/…/x7Qa" - the URL is NEVER returned
  usedFor: Array<"stranger" | "presence" | "presenceHealth">;
  updatedAt?: string; updatedBy?: string;
}
```

- The built-in channel "Eton (chung)" (`eton-default`) is the existing webhook config (URL and on/off edited in
  the Webhook settings as today). PATCH/DELETE on it -> 400 `CHANNEL_BUILT_IN`.
- URL: destination guard of the webhook policy (`DEST_*` codes, `field: "url"`), https unless WEBHOOK_ALLOW_HTTP.
- Max 20 channels. DELETE of a routed channel -> 409 `CHANNEL_IN_USE`. Unknown id -> 404.
- Routes default to `eton-default` for all three. PUT with an unknown channel -> 400 `CHANNEL_UNKNOWN`.
- Test sends one plain text message ("Tin thử từ SmartFace Gate Watch ...") and records a webhook log entry.

### Per-gate presence settings

```
GET /api/presence/settings          (operator)  -> { success, gates: PresenceGateSettingsView[] }
PUT /api/presence/settings/:gateId  (admin)     { mode?, workingHours?, minSecondsWorking?, minSecondsAfterHours?,
                                                  alertWindowSeconds?, alertHoldSeconds? }
                                                -> { success, gate: PresenceGateSettingsView }

PresenceGateSettingsView = {
  gateId: string; label: string;
  mode: "off" | "shadow" | "live";          // effective now
  workingHours: string;                     // "HH:MM-HH:MM" local (Asia/Ho_Chi_Minh)
  minSecondsWorking: number;                // 0.5-60
  minSecondsAfterHours: number;             // 0.5-60
  alertWindowSeconds: number;               // 30-3600
  alertHoldSeconds: number;                 // 0-30
  source: { [field: string]: "saved" | "env" };   // where each value comes from
  updatedAt?: string; updatedBy?: string;
  needsStream?: boolean;                    // true when mode != off but the gate has no pipeline stream
}
```

- Saved values override `.env`; `.env` stays the default. Sending `null` for a field clears the override.
- shadow <-> live and the alert fields apply at once; hours / minimum seconds restart the gate's presence detector;
  off <-> on restarts the gate's stream (a few seconds).

## 3. UI (frontend agent)

- **Webhook tab (`WebhookIntegration.tsx`), new section "Kênh thông báo" (admin only; hidden for others):**
  list channels (name, masked URL, on/off, "Dùng cho" chips, "Gửi thử", edit, delete), "Thêm kênh" form (name, URL,
  on/off), and a routing block "Gửi cảnh báo tới" with three selects (Người lạ / Có người ngoài giờ / Phát hiện người
  ngừng hoạt động). The built-in channel shows "Eton (chung) - sửa URL ở phần Webhook phía trên" and has no edit/delete.
  Server errors are shown as-is (DEST_* messages are Vietnamese already). Never display or log a full URL.
- **Presence tab (`PresencePanel.tsx`), new "Cài đặt cổng" block:** per gate: mode (Tắt / Chạy thử / Đang báo) with a
  confirmation when switching to "Đang báo" ("Tin nhắn sẽ được gửi tới nhóm bảo vệ ngoài giờ làm"), working hours,
  minimum seconds (giờ làm / ngoài giờ), "Gộp tin mỗi" (minutes), "Chờ nhận diện" (seconds); an "Đặt lại theo .env"
  per field when `source[field] === "saved"`. Editable for admin, read-only for operator; hidden for viewer.
- Pure helpers (request building, validation, labels) in `src/utils/notificationChannels.ts` and
  `src/utils/presenceSettings.ts` with unit tests; no backend behaviour in the UI.

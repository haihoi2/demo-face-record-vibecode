# Outbound-connection (egress) audit - 2026-11-03

Read-only audit of what the gateway process dials out to. Evidence comes from a
**throwaway** gateway (image `smartface-tests:sec` built from `main` 3929fff,
SQLite mode, integration tokens, models mounted read-only, Docker network
`smartface-network`), never from the live service or its database. The live
container was not inspected.

## Method

1. `/proc/net/tcp` and `/proc/net/tcp6` read inside the throwaway container
   (a) every second for the first 12 s after start, (b) every 0.5 s during one
   `POST /api/camera-streams/scan-rtsp` against an unreachable camera URL,
   (c) every 0.5 s for 12 s with presence `mode=shadow` on a gate whose only
   stream points at that unreachable host, (d) during one
   `GET /api/network/ip-info` as a viewer. Listening sockets (state `0A`) were
   dropped; remaining peers decoded from the hex table.
2. `grep` of the production bundle `dist/server.cjs` and of
   `node_modules/onnxruntime-node` (1.30.0, `linux/x64`) for URLs, telemetry
   strings, CA-bundle paths and `ORT_*` environment switches.
3. Review of every outbound call site in `server.ts` / `src/server/**`
   (`fetch(`, `https.get(`, `net.Socket`, `spawn("ffmpeg"`, `dns.promises.lookup`,
   `pg.Pool`, `GoogleGenAI`).

## Destinations by purpose

| Purpose | Code path | Destination | Guarded by | Observed in the throwaway |
| --- | --- | --- | --- | --- |
| Camera / NVR frame grab | `grabRtspFrame` -> `spawn("ffmpeg")` (server.ts ~4838), gate watchers, presence pipeline | configured `rtspUrl` hosts (RTSP 554 or as configured) | `checkDestination(NET_POLICY.camera)` before every dial; `CAMERA_ALLOWED_HOSTS` | `172.17.0.4:1 SYN_SENT` during the scan and during the presence tick - the fixture camera only |
| Camera TCP probe | `POST /api/camera-streams/test-stream` -> `net.Socket.connect` (server.ts ~4960) | user-supplied host:port | `NET_POLICY.probe`; connects to the checked address | not exercised in the capture (covered by `netGuard.test.ts`) |
| NVR playback | `GET /api/logs/:id/recording` -> `spawn("ffmpeg")` (server.ts ~9196) | `RECORDING_NVR_URL` host | env-owned URL; `redactRtsp` on stderr | none (no NVR configured) |
| Webhook (built-in Eton channel) | `fetch(webhookConfig.url)` (server.ts ~2889), stranger alert (~3165), test-stranger (~3461) | `ETON_WEBHOOK_URL` host (`chat-room.eton.vn` in prod) | `destinationRefusal(NET_POLICY.webhook)` at save and at send; `redirect: "manual"` | none (built-in channel unset) |
| Webhook (P3b channels) | `postToChannel` -> `fetch(target.url)` (server.ts ~9947) | admin-declared HTTPS hosts | same webhook policy at save (`destinationSaveCheck`) and at send (`destinationRefusal`); 7 s timeout; no redirects | none dialled: `.invalid` host refused at send with `DEST_UNRESOLVED` |
| Door controller | `sendDoorCommand` -> `fetch` | `DOOR_CONTROLLER_URL` host | door policy at save and at send; token never logged (N1) | none (no controller configured) |
| Database | `src/server/db.ts` `new Pool(...)` | `DATABASE_URL` host | env-owned | none (SQLite mode) |
| DNS | `checkDestination` -> `dns.promises.lookup` for every guarded destination; `ip-info` route | Docker embedded resolver `127.0.0.11` -> host `127.0.0.53` | - | resolver only |
| Gemini (optional) | `GoogleGenAI` client (server.ts ~1204) | `generativelanguage.googleapis.com` | only when `GEMINI_API_KEY` is set and provider is `google` | none (no key) |
| **Public-IP lookup (unexpected)** | `GET /api/network/ip-info` and `/api/system/ip-info` (server.ts ~3853) -> `https.get("https://api.ipify.org")`, `https.get("https://ifconfig.me/ip")`, `dns.lookup` of a hard-coded Cloud Run host and of `chat-room.eton.vn` | `api.ipify.org`, `ifconfig.me` | **none** (no destination guard; not configurable) | `172.67.74.152:443` and `34.160.111.145:443 ESTABLISHED` during one viewer call |
| **ONNX Runtime telemetry (unexpected)** | `onnxruntime-node` 1.30.0 native library, `core/platform/posix/telemetry.cc` (1DS / OneCollector client with embedded libcurl) | `mobile.events.data.microsoft.com/OneCollector/1.0/` | `ORT_DISABLE_TELEMETRY` env only; needs a readable CA bundle | not dialled in the throwaway: the tester image has no CA bundle (`No readable CA bundle was found; telemetry HTTPS uploads will be unavailable`) |

Startup: no outbound connection at all (only the `:3000` listener and Docker's
DNS stub on `127.0.0.11`). Presence tick: the only peer is the gate's own camera
stream (the pipeline's FFmpeg reader); no other destination.

## Unexpected items

### E1 - `GET /api/network/ip-info` is viewer-reachable and dials two third parties

- `server.ts` ~3853 registers `["/api/network/ip-info", "/api/system/ip-info"]`.
  `src/server/auth.ts` makes `/api/system/` admin-only, but `/api/network/` matches
  no rule and falls to the **viewer** default for reads.
- Each call opens HTTPS connections to `api.ipify.org` and `ifconfig.me`
  (observed), does two DNS lookups, and returns the gateway's **public egress
  IPv4** plus hard-coded infrastructure notes (a Cloud Run host name, GCP
  ranges) to any signed-in viewer. The route has no destination guard and is
  not needed by the on-premise deployment (the notes describe a retired cloud
  deployment).
- Impact: information disclosure to the lowest role; an uncontrolled egress
  path that an edge firewall allowlist would have to carry; a tiny amplifier
  (one request = two outbound HTTPS requests).
- Proposal (owner of `server.ts` / `src/server/auth.ts`): add
  `{ methods: READ, pattern: /^\/api\/network\/ip-info$/, role: "admin" }` to
  `RULES` (or drop the `/api/network/` alias), and either remove the two public
  lookups or put them behind an explicit `EGRESS_IP_LOOKUP_ENABLED` flag.
  Regression test proposed and committed as a `todo` case in
  `tests/integration/operatorRoleSeparation.test.ts` (flip to a normal `it` once fixed).

### E2 - ONNX Runtime 1.30.0 ships a telemetry uploader on Linux

- The `linux/x64/libonnxruntime.so.1` binary contains a POSIX telemetry
  system (1DS/OneCollector, libcurl built in): collector URL
  `https://mobile.events.data.microsoft.com/OneCollector/1.0/`, fields
  `DeviceInfo.Id`, `Session.ImpressionId`, `AppInfo.*`, reads `/etc/os-release`,
  persists a device id, and looks for a CA bundle at
  `/etc/ssl/certs/ca-certificates.crt` and the usual alternatives. The only
  switch found is the environment variable `ORT_DISABLE_TELEMETRY`; the Node
  binding exposes no `DisableTelemetryEvents`.
- In the tester image it fails closed (`No readable CA bundle was found;
  telemetry HTTPS uploads will be unavailable`, seen in the throwaway's log).
  The production `runner` stage installs `ca-certificates` (needed for
  webhooks), so the same library in production has what it needs to upload.
  The repository sets `ORT_DISABLE_TELEMETRY` nowhere (Dockerfile,
  docker-compose.yml, .env.example checked).
- Impact: an undeclared destination from an on-premise security appliance;
  device/OS metadata leaves the site. Nothing biometric is in the payload as
  far as the strings show, but the principle (explicit allowlist for every
  outbound destination) is broken.
- Not verified on the live container (production reads are out of scope for
  this task). Owner-run read-only check: `docker exec smartface-local-gateway
  cat /proc/net/tcp | awk '$4!="0A"{print $3}'` and compare against
  `getent ahosts mobile.events.data.microsoft.com`.
- Proposal (compose/Dockerfile owner): `ORT_DISABLE_TELEMETRY=1` in the
  `smartface-app` environment and in the Dockerfile `ENV`; add an edge egress
  rule that denies `*.events.data.microsoft.com` from this host; add a
  startup log line stating the switch is set. A unit check can assert the
  variable is present in `docker-compose.yml`.

### E3 - request logger writes raw query strings (credentials in logs)

- `server.ts` ~1166 logs `[HTTP ${method}] ${req.url}` for every request. A
  client that sends a camera URL in a query string - e.g. the legacy
  `GET /api/camera-streams/snapshot?url=rtsp://user:pass@host/...` (the route
  itself refuses `?url=` with 400) - gets the RTSP login written to the
  gateway log verbatim. Observed in the throwaway's log with a fixture
  password after one such request.
- Impact: camera credentials in `docker logs` and any log shipping; low
  exploit value (self-inflicted by the caller) but a redaction gap given the
  open credential-rotation item.
- Proposal: log `req.path` plus a redacted query (`redactedUrl`-style: strip
  userinfo, mask `url|rtspUrl|token|key|secret|password` parameters) and
  never the raw `req.url`. Unit test: a request with
  `?url=rtsp://u:p@h/x` yields a log line without `u:p@`.

## Expected and acceptable

- `https://chat-room.eton.vn/hooks/...` in the bundle is the
  `YOUR_WEBHOOK_TOKEN` placeholder (guarded by `tests/noWebhookTokenInSource.test.ts`).
- `http://192.168.60.2/stream` / `/substream` are the default sample camera
  config, not dialled unless configured.
- `https://images.unsplash.com/...` are demo avatar URLs in demo data paths
  (`ENABLE_DEMO_DATA=false` in production; not dialled by the server).
- URLs inside `onnxruntime-node` dist JS / `libonnxruntime.so.1` other than
  the collector are documentation links (arxiv, numpy, gpuweb, crbug).

## Reproduction (throwaway only)

```sh
docker build -q --target tester -t smartface-tests:sec .
# start as in tests/integration/README.md (SQLite, integration tokens), then:
docker exec <container> sh -c 'cat /proc/net/tcp /proc/net/tcp6' | awk 'NR>1 && $4!="0A"{print $3,$4}'
docker run --rm --entrypoint sh smartface-tests:sec -c \
  'grep -aoE "https?://[A-Za-z0-9./_-]{4,}" node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1 | grep -i events.data; \
   grep -aoE "ORT_[A-Z_]{3,40}" node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1 | sort -u | grep TELEM'
```

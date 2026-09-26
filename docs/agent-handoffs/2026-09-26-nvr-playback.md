# Handoff: NVR playback of access events

- Branch: `feat/nvr-playback`, base `24d1238`
- `server.ts touched: yes` (two routes); `db.ts` / `types.ts` untouched; no schema change.
- New env: `RECORDING_NVR_URL` (rtsp://login@host:port, server-only), `RECORDING_ENTRY_CHANNEL`,
  `RECORDING_EXIT_CHANNEL`, `RECORDING_MAX_CONCURRENT` (default 2). Unset = feature hidden.
- New routes: `GET /api/recordings/config` (viewer+; booleans only),
  `GET /api/logs/:id/recording` (viewer+; video/mp4 stream).

## Verification

Typecheck clean; unit 273/0; build clean; integration 166/0 on SQLite and throwaway
postgres:18-alpine. Live against the NVR (isolated gateway): both gates 200 video/mp4,
first byte ~5.7 s, 15 s H.264 720p clips, on-screen clock matches the event time; concurrency
cap 429; anonymous 401; player close kills FFmpeg in 0.4 s; NVR password absent from logs.

## Known limits / follow-ups

- Window is anchored on the access log's write time (1-2 s after capture); the tracker work
  should store the exact frame capture time.
- Views are audited in the server log only; a DB audit table (db.ts owner) is proposed.
- Playback is real time: ~6 s before video starts, ~16 s to complete. No seeking until loaded.
- NVR keeps ~8 days; older events answer 404 RECORDING_NOT_FOUND.
- Stranger panel has no recording button yet.

## Deploy notes

Add to the host `.env`: RECORDING_NVR_URL (from the NVR view account), RECORDING_ENTRY_CHANNEL=2201,
RECORDING_EXIT_CHANNEL=501. Rollback: remove the lines (button disappears) or redeploy previous image.

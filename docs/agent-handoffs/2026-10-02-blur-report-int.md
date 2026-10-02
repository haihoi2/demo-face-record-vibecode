# Handoff: blur reports (INT)

- **Task:** owner 2026-10-02 "add feature report blur to validate and optimize rather than delete"; "stored or tagged for you to review and enhance the accuracy".
- **Branch:** `feat/blur-report` (worktree `demo-face-record-vibecode-wt/blur-report`), base `main` @ `d485568`. Commits `120dfe7` contract, `6b2aa78` backend, `b6e62d4`/`582de62` UI (frontend agent, merged `276bc04`), `48c9880` test casts.
- **server.ts touched:** yes (INT). **db.ts:** `stranger_faces."featureNorm"` (additive, nullable, no backfill) and new table `stranger_face_reports` (append-only). **types.ts:** `StrangerPhoto.blurReported?`.

## Behaviour
Operators/admins toggle "Báo ảnh mờ" / "Bỏ báo mờ" on per-face stranger photos; a badge "Đã báo mờ" shows while reported. Nothing is deleted or hidden. Each toggle appends a row (blur / blur-withdrawn) with actor, time and the face's stored scores (featureNorm for faces stored from this release, edgeEnergy, quality, detectorScore, sizePx, gateId). `GET /api/strangers/blur-reports` (admin, read logged) is the review feed INT uses to re-tune FACE_STRANGER_MIN_FEATURE_NORM / EDGE_ENERGY.

## Verification
- `smartface-tests:blur`: tsc 0, lint 0, unit 1060/0, build 0; integration SQLite 369/334/0/35 skipped, PostgreSQL 18 369/364/0/5.
- Dev E2E (scratchpad/blur-e2e.sh, SQLite and throwaway PostgreSQL; storage floors relaxed on that gateway only so the fixture photo is stored): report -> cluster flag true -> withdraw -> flag cleared; list keeps both rows with featureNorm 22.8, edgeEnergy 0.0908, quality 0.434, detector 0.759, 62 px, gate entry, note.
- Not done: browser click-through (no browser in this environment).

## Rollback
Previous image. Schema is additive: `ALTER TABLE stranger_faces DROP COLUMN "featureNorm"; DROP TABLE stranger_face_reports;` only if needed (old code ignores both).

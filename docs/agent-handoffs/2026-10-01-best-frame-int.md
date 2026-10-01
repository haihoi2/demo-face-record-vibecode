# Handoff: sharpest of several pictures (best-frame) - INT

- **Task:** owner 2026-10-01 "yes" to "sharpest of several frames": fewer motion-blurred stranger/access photos, without delaying an employee's door.
- **Branch:** `feat/best-frame` (worktree `demo-face-record-vibecode-wt/best-frame`), base `main` @ `5b82301`, commit `68f74bc`.
- **server.ts touched:** yes (INT). New `src/server/bestFrame.ts` + `tests/bestFrame.test.ts`.

## Behaviour

- Only for shared-stream door scans (wave D) on the ONNX engine. When the scan's newest picture contains a clear face and that picture recognises nobody, `DOOR_SCAN_BEST_OF_EXTRA_FRAMES` (2) older pictures from memory, `DOOR_SCAN_BEST_OF_SPACING_MS` (250) apart, are looked at too.
- Door rule unchanged: a grant must be backed by the scan's own picture(s) or by one extra picture on its own. Pooled multi-agree over extra pictures is turned into `rejected-weak` (consecutive pictures are not independent evidence).
- Stored picture: the strongest recogniser response (ArcFace feature norm, r50 only; else quality), also among equally confident views of a recognised person.
- Empty doorway and immediately-recognised employee: same work as before.
- Response: `storedFrame {streamId, frameIndex, framesLooked, featureNorm}` (numbers only).

## Verification

- `smartface-tests:best`: tsc 0, lint 0, unit 992/0, build 0; integration SQLite 360/325/0/35 skipped, PostgreSQL 18 throwaway 360/355/0/5.
- Dev (mediamtx, fixture photo alternating sharp 0.25 s / 6 px horizontal smear 0.5 s - the smear calibrated to the site's motion blur: still detected and clear, strength 21.8 vs 23.1; 30 manual scans each):
  - Stranger: sharp picture stored 12/28 (1 picture) -> 22-23/28 (3 pictures); scan ~1.2 s -> ~3.5 s (no door involved).
  - Enrolled: recognised 12/28 (1 picture) -> 23-24/28 (3 pictures), all `single-strong`, no `multi-agree`; first-picture grants still ~1.14 s, grants needing an extra picture ~3.4 s (before: next scan, ~5 s later). Access photo sharp in 24/24 grants after the tie-break.
  - A stronger smear (28 px) makes the detector find no face at all: those pictures never become stranger photos and trigger no extra look.
- Test clips deleted after use.

## Risks / rollback

- Scans that see an unrecognised face take ~2.3 s longer (4K entrance more); the watcher gap starts after the scan, so the scan rate drops slightly while strangers are present.
- Three chances per scan for a single-picture grant: same per-picture rule, more pictures per minute (like a faster scan rate).
- Rollback: `DOOR_SCAN_BEST_OF_EXTRA_FRAMES=0` + restart, or the previous image. No schema change.

# Handoff: smaller stored access-log photos

- Branch: `feat/snapshot-size`, base `48d390b`, commit `1f94ff4`
- `server.ts touched: yes` (annotateSnapshotWithBoxes only)
- New env: `SNAPSHOT_JPEG_QSCALE` (FFmpeg -q:v, 2-31, blank = 8). No API or schema change.

## Why

access_logs held 3.7 GB of photos (2,322 rows, median 1.8 MB, mostly 3840x2160) and grew
~0.9 GB/day; disk at 80-84%. Frames were stored at -q:v 2, or as received when no box was drawn.

## Measurement (50 real captures with a face, 2026-09-26)

| variant | median KB | faces lost | cosine p10 | enrolment grade lost |
|---|---|---|---|---|
| native q8 (chosen) | 820 | 0 | 0.920 | 0/50 |
| native q10 | 696 | 0 | 0.856 | 0/50 |
| 2560 px q4 | 621 | 0 | 0.876 | 10/50 |
| 1280 px q3 | 239 | 0 | 0.642 | 33/50 |
| crop around faces q6 | 291 | 1 | 0.740 | 1/50 |

Downscaling loses face detail in overview shots, and quick-register/merge enrol from the
stored photo. Cropping is ~5x smaller but removes the wide scene operators see; left for the
owner to decide.

## Verification

Typecheck clean; unit 260 pass / 0 fail; build clean; integration 162/0 on SQLite and on a
throwaway postgres:18-alpine. Three real 4K captures posted through /api/recognize-face on
the isolated gateway: 1.95 MB in -> 0.87 MB stored. Exported captures deleted afterwards.

## Not done

Existing rows are not re-encoded (live data rewrite; would need approval, and the photo is
evidence). Retention policy for biometric photos is still undefined. Growth after deploy is
~0.4 GB/day instead of ~0.9 GB/day.

## Rollback

Set `SNAPSHOT_JPEG_QSCALE=2` (old quality) or redeploy the previous image.

# Handoff: minimum face size

- Branch: `feat/min-face-size`, base `24bbda5`, commit `96384fa`
- `server.ts touched: yes` (stranger floor, enrolment mapping, gate counter); `src/types.ts` not touched
- New env: `FACE_MIN_SIZE_PX` (default 40), `FACE_STRANGER_MIN_SIZE_PX` (default 60). No API/schema change.
- Owner's request: "only capture face big enough".

## Behaviour

- Face < 40 px (shorter side, source frame): "small" in the clear-face gate -> not recognised,
  tracked, stored or enrolled. Counted in `/api/face-engine/status` clearFace.byReason.small.
- Stranger face < 60 px: not stored/grouped; counted as suppressed "stranger-small".
  Employees between 40 and 60 px are still recognised.
- Enrolment where every face is too small: `low-quality` (UI text already says "too small or blurry").

## Measurement (206 recognised, 150 denied real captures)

| face px | recognised n | own-template cosine (median) | >= 0.45 | denied faces |
|---|---|---|---|---|
| < 40 | 1 | 0.352 | 0% | 10 |
| 40-60 | 39 | 0.501 | 85% | 70 |
| 60-80 | 24 | 0.494 | 96% | 28 |
| >= 170 | 88 | 0.607 | 88% | 9 |

Impact with the new floors: 1 of 176 usable recognitions lost; 63 of 150 denied captures no
longer stored as strangers. Exported captures deleted afterwards.

## Verification

Typecheck clean; unit 264 pass / 0 fail; build clean; integration 162/0 on SQLite and on a
throwaway postgres:18-alpine.

## Rollback

`FACE_MIN_SIZE_PX=0` and `FACE_STRANGER_MIN_SIZE_PX=0` restore the old behaviour; or redeploy
the previous image.

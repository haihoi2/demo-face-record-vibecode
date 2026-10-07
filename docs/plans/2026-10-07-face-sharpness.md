# Face sharpness: keep blurred faces out of stranger groups

Status: PLAN (owner "YES" 2026-10-07). Nothing built yet. Decisions needed are in section 7.

## 1. Why

Operators flag blurred stranger faces ("Báo ảnh mờ"). On 2026-10-07 there were 35 reports (one operator). Compared
with the other 485 stored stranger faces, none of today's numbers separates them:

| Cut-off | Reported faces removed | Other faces also removed |
|---|---|---|
| featureNorm < 23 | 54% | 49% |
| edge energy < 0.25 | 34% | 23% |
| face size < 80 px | 46% | 37% |
| quality < 0.80 | 49% | 39% |

Raising any of these loses good captures almost as often as blurred ones.

## 2. Likely cause

Every measure is taken on the **112x112 aligned face**, after the face has been resized:

- a small face (60-90 px) is enlarged to 112 px, so it looks equally soft whether the camera caught it sharp or
  blurred; a large face is shrunk, which hides blur;
- the Laplacian variance and edge energy also fall with **darkness and low contrast**, so a dim but sharp face scores
  like a blurred one;
- featureNorm (ArcFace feature strength) mixes blur with pose, occlusion and lighting.

## 3. Candidate measures (all cheap, CPU, on the face as captured)

Measured on the face box in the **original frame, before resizing**, with a fixed margin:

1. **Contrast-normalised sharpness**: Laplacian variance divided by intensity variance (so darkness does not count as blur).
2. **Re-blur ratio** (Crété-Roffet 2007): how much the face changes when blurred again; a blurred face barely changes.
   Independent of size and brightness, no model.
3. **Motion-blur direction**: ratio of horizontal to vertical gradient energy; walking-past blur is directional.
4. **Eye-region sharpness**: the same measure on the eye band only (from the 5 landmarks); the eyes are where blur
   hurts recognition most.
5. **Optional, learned face-quality model** (FIQA, ONNX, CPU): only with a free licence (decision 6 of the presence
   plan applies). Evaluated only if 1-4 are not good enough.

## 4. Labels

Today there are only "blurred" reports; an unreported face is not "sharp". The evaluation needs both:

- **Labelling round (owner/operators, ~20 min):** a small admin page shows ~300 random stored stranger faces, one key
  per face: "Rõ" / "Mờ" / "Không phải mặt". Two people label the same set where possible (agreement tells us how
  subjective "blurred" is).
- Existing "Báo ảnh mờ" reports count as "Mờ".
- Labels are stored like blur reports (append-only, actor, time) and deleted with the faces by retention.

## 5. Phases

| Phase | What | Output | Effort |
|---|---|---|---|
| S0 | Labelling page + round (section 4) | >= 300 labelled faces | 0.5 day + labelling |
| S1 | Offline evaluation of measures 1-4 on the stored crops (in a capped container, scratch deleted after) | ROC per measure: % blurred removed vs % sharp lost; recommended measure + threshold | 1 day |
| S2 | Shadow: compute the chosen measure for every new stranger face, store it, show it in the blur-report list; no filtering | live numbers for a few days | 0.5 day |
| S3 | Enforce: blurred faces are not grouped (kept for the access history, hidden from the panel like a dismiss, restorable); best-frame and enrolment prefer the sharpest face | fewer blurred photos in groups | 0.5 day |

Success target for S3 (proposal): remove >= 70% of blurred faces while losing <= 10% of sharp ones. If no measure
reaches it, S3 does not ship and we report why.

## 6. Safety and data

- Door decisions are untouched: this only changes which stranger photos are grouped and shown.
- Stranger crops are biometric: S1 reads them in a capped container, keeps only numbers, deletes any scratch copies.
- New columns are additive (stranger_faces: one REAL column per kept measure); rollback = ignore/drop.

## 7. Owner decisions

1. **Labelling round:** who labels, and is ~300 faces acceptable?
2. **What happens to a blurred face in S3:** hidden from the groups but kept (restorable) - proposed - or not stored at all?
3. **Success target:** >= 70% blurred removed, <= 10% sharp lost - acceptable?
4. **FIQA model:** only if 1-4 fail, free licence only - agreed?

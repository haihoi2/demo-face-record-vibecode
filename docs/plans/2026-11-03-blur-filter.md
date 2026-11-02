# Blur filter S1: what the stored numbers can and cannot tell about blur

Status: S1 DONE (evaluation + pure module, not wired). Taiga #511. Parent plan: `docs/plans/2026-10-07-face-sharpness.md`.
Owner decisions needed are in section 8.

## 1. Question

Operators have tagged 230 stranger faces "Báo ảnh mờ" (plus 7 `rated-blurry`, 5 `rated-sharp` from the S0 page).
Before computing any new measure on the crops (S1 of the parent plan, measures 1-4), check whether the metrics we
already store with every face — `edgeEnergy`, `featureNorm`, `quality`, `detectorScore`, `sizePx` — separate those
blurred faces from faces we know were usable. Numbers only: no image was read or exported.

Tool: `scripts/perf/blur-label-eval.ts` (one read-only SELECT, aggregates out; see its header for the exact classes).

## 2. Data (live PostgreSQL, 2026-11-02, read-only)

Faces with a `gateId` and a `featureNorm`, all `arcface_w600k_r50`: 11 931.

| gate | blurry (labels) | sharp, rated | sharp, proxy (recognised, cosine >= 0.65) | recognised, cosine < 0.65 | stranger, unlabelled |
|---|---|---|---|---|---|
| entry | 138 | 3 | 1668 | 3964 | 1572 |
| exit | 94 | 2 | 1045 | 2088 | 1357 |
| pooled | 232 | 5 | 2713 | 6052 | 2929 |

- blurry = newest of `blur`/`blur-withdrawn` is `blur` (227 faces, two actors, 2026-10-07..10-23) or `rated-blurry`.
- sharp = `rated-sharp` or recognised with `matchCosine >= 0.65` (the recogniser matched it with margin, so the capture
  was usable). This is a PROXY: it is not an operator saying "sharp".
- The 2 `blur` reports later withdrawn are not blurry. No `rated-not-face` rows exist.

Class distributions (p10 / p50 / p90):

| metric | blurry | sharp proxy | stranger unlabelled | recognised, cosine < 0.65 |
|---|---|---|---|---|
| edgeEnergy | 0.193 / 0.304 / 0.634 | 0.206 / 0.349 / 0.639 | 0.197 / 0.329 / 0.644 | 0.18 / 0.334 / 0.626 |
| featureNorm | 21.02 / 23.02 / 24.78 | 22.35 / 24.96 / 27.63 | 20.95 / 23.04 / 25.22 | 21.37 / 23.68 / 25.93 |
| quality | 0.589 / 0.848 / 1 | 0.634 / 0.905 / 1 | 0.501 / 0.813 / 1 | 0.562 / 0.849 / 1 |
| sizePx | 66 / 90 / 177 | 66 / 99 / 236 | 63 / 88 / 180 | 64 / 91 / 200 |
| detectorScore | 0.813 / 0.846 / 0.882 | 0.784 / 0.854 / 0.892 | 0.811 / 0.847 / 0.885 | 0.761 / 0.84 / 0.884 |

Read the `featureNorm` row twice: the blurry faces (23.02) and the UNLABELLED strangers (23.04) have the same median.
Whatever `featureNorm` separates, it separates "stranger capture" from "recognised employee" at least as much as
"blurred" from "sharp" (section 5).

## 3. Results (sharpness scores: higher = sharper; "blurry" = score < threshold)

Pooled, 2718 sharp vs 232 blurry. "t @95 %" is the threshold that catches 95 % of the blurry labels and the share of
sharp faces it would also remove; "t @<=10 %" is the threshold that removes at most 10 % of sharp faces (the parent
plan's budget) and the share of blurry it catches there.

| score | AUC | t @95 % caught | sharp lost | t @70 % caught | sharp lost | t @<=10 % sharp lost | blurry caught | t @<=5 % sharp lost | blurry caught |
|---|---|---|---|---|---|---|---|---|---|
| edgeEnergy | 0.554 | 0.793 | 95.9 % | 0.441 | 69.1 % | 0.206 | 14.2 % | 0.169 | 3.4 % |
| featureNorm | 0.781 | 25.54 | 60.8 % | 23.84 | 29.0 % | 22.35 | 34.5 % | 21.52 | 16.8 % |
| quality | 0.537 | 1 | 100 % | 1 | 100 % | 0.633 | 12.5 % | 0.526 | 6.5 % |
| detectorScore | 0.532 | 0.888 | 86.9 % | 0.863 | 60.2 % | 0.784 | 0.0 % | 0.759 | 0.0 % |
| sizePx | 0.542 | 195 | 86.6 % | 122 | 69.3 % | 66 | 9.1 % | 63 | 3.9 % |
| edgeEnergy * (112/size)^0.5 | 0.523 | 0.814 | 97.6 % | 0.471 | 73.5 % | 0.200 | 11.2 % | 0.156 | 2.2 % |
| edgeEnergy * (112/size) | 0.492 | 0.935 | 98.1 % | 0.503 | 71.4 % | 0.163 | 6.9 % | 0.122 | 2.2 % |
| edgeEnergy * (size/112)^0.5 | 0.558 | 0.881 | 92.6 % | 0.412 | 64.9 % | 0.178 | 12.5 % | 0.151 | 6.0 % |
| featureNorm * (112/size)^0.5 | 0.571 | 31.3 | 76.6 % | 27.9 | 58.3 % | 16.2 | 3.9 % | 13.9 | 1.3 % |
| featureNorm * (size/112)^0.5 | 0.669 | 30.5 | 84.8 % | 23.5 | 50.4 % | 19.7 | 35.3 % | 19.0 | 27.2 % |
| edgeEnergy * featureNorm | 0.603 | 18.5 | 94.6 % | 9.81 | 59.6 % | 4.99 | 18.5 % | 4.02 | 4.3 % |
| edgeEnergy/0.1 + featureNorm/4 | 0.636 | 13.96 | 95.7 % | 10.02 | 53.6 % | 8.07 | 25.0 % | 7.59 | 10.3 % |
| logit(featureNorm) | 0.781 | 3.205 | 60.8 % | 2.387 | 29.0 % | 1.670 | 34.5 % | 1.271 | 16.8 % |
| **logit(featureNorm, ln size)** | **0.806** | 3.357 | 59.5 % | 2.301 | 24.1 % | **1.677** | **44.8 %** | 1.212 | 27.6 % |
| logit(edge, featureNorm) | 0.782 | 3.167 | 59.2 % | 2.389 | 28.7 % | 1.680 | 36.6 % | 1.269 | 16.8 % |
| logit(edge, featureNorm, ln size) | 0.805 | 3.476 | 63.4 % | 2.331 | 25.1 % | 1.676 | 45.3 % | 1.211 | 28.4 % |
| logit(edge, featureNorm, quality) | 0.796 | 3.339 | 62.1 % | 2.362 | 26.6 % | 1.645 | 40.1 % | 1.291 | 28.4 % |

Logistic fits (raw units, P(blurry) = sigmoid(intercept + sum coef * x); 5-fold cross-validation, fold = row index mod 5):

| model | intercept | edgeEnergy | featureNorm | ln(sizePx) | quality | CV AUC |
|---|---|---|---|---|---|---|
| logit(featureNorm) | 9.0824 | | -0.4811 | | | 0.779 |
| logit(featureNorm, ln size) | 17.4616 | | -0.5703 | -1.3364 | | 0.803 |
| logit(edge, featureNorm) | 9.1687 | -0.3805 | -0.4785 | | | 0.779 |
| logit(edge, featureNorm, ln size) | 17.9752 | +0.7232 | -0.5822 | -1.4457 | | 0.801 |
| logit(edge, featureNorm, quality) | 13.2785 | +0.5366 | -0.5554 | | -3.1018 | 0.792 |

Per gate (same columns, the two useful scores only):

| gate | score | n sharp/blurry | AUC | t @95 % | sharp lost | t @70 % | sharp lost | t @<=10 % | blurry caught |
|---|---|---|---|---|---|---|---|---|---|
| entry | featureNorm | 1671/138 | 0.777 | 25.38 | 60.3 % | 23.77 | 29.4 % | 22.21 | 30.4 % |
| entry | logit(featureNorm, ln size) | 1671/138 | 0.798 | 3.45 | 58.4 % | 2.49 | 25.6 % | 1.81 | 44.2 % |
| exit | featureNorm | 1047/94 | 0.789 | 25.73 | 60.0 % | 24.09 | 30.1 % | 22.59 | 43.6 % |
| exit | logit(featureNorm, ln size) | 1047/94 | 0.824 | 3.28 | 64.3 % | 2.15 | 25.1 % | 1.51 | 52.1 % |

Size-stratified AUC (sharp/blurry counts in brackets):

| score | 60-79 px | 80-109 px | >= 110 px |
|---|---|---|---|
| edgeEnergy | 0.525 (755/74) | 0.553 (867/74) | 0.569 (1096/84) |
| featureNorm | 0.903 (755/74) | 0.763 (867/74) | 0.722 (1096/84) |
| quality | 0.471 (755/74) | 0.581 (867/74) | 0.493 (1096/84) |
| sizePx | 0.473 (755/74) | 0.603 (867/74) | 0.547 (1096/84) |
| logit(featureNorm, ln size) | 0.904 (755/74) | 0.773 (867/74) | 0.751 (1096/84) |

Current stranger floors (`FACE_STRANGER_MIN_EDGE_ENERGY` 0.16 or `FACE_STRANGER_MIN_FEATURE_NORM` 20): blurry caught
**0.0 %**, sharp lost 4.8 % (entry 0 % / 2.9 %, exit 0 % / 7.8 %). Every stored face already passed them at
capture time; the floors remove nothing the operators complained about, and the "sharp lost" there are recognised
faces stored before the floors were raised.

## 4. Reading

1. `edgeEnergy`, `quality` (Laplacian x size) and `detectorScore` carry **no information** about these labels
   (AUC 0.53-0.56; within any size band 0.47-0.58). Section 2 of the parent plan predicted this: both are measured
   on the 112 px aligned crop after resizing. Size-normalising them does not help (AUC 0.49-0.57). Raising the
   edgeEnergy floor from 0.16 to 0.21 would remove 14 % of blurry and 10 % of sharp faces: a coin toss.
2. `featureNorm` is the only stored number with signal (AUC 0.78), strongest on small faces (0.90 at 60-79 px) and
   weak on large ones (0.72). A small face needs a higher featureNorm to count as sharp, so the size term is kept
   (AUC 0.81, CV 0.80). Adding edgeEnergy or quality on top changes nothing (and the edgeEnergy coefficient flips
   sign, i.e. it is fitting noise), so they are left out of the rule.
3. **The parent plan's targets are not reachable with stored numbers.** Catching 95 % of blurry faces costs ~60 %
   of the sharp ones at every score; the S3 target (>= 70 % removed, <= 10 % sharp lost) is missed by a wide margin:
   at <= 10 % sharp lost the best rule catches 44.8 % (entry 44 %, exit 52 %).

## 5. The confound, stated plainly

Every blurry label is a stranger capture; every sharp proxy is a recognised employee. `featureNorm` is also the
recogniser's own confidence in its input, so "low featureNorm" and "the recogniser did not match it" are the same
fact seen twice. The decisive check is the unlabelled strangers: at the chosen threshold the rule flags **44.8 % of
the blurry labels and 44.8 % of the unlabelled strangers** (entry 37 % / 36 %, exit 56 % / 55 %). Either roughly
half of all stranger captures are as blurred as the reported ones (plausible: operators reported 230 of 3161 and
did not go through them all), or the rule measures "stranger-ness" rather than blur. The 5 `rated-sharp` labels
cannot tell the two apart (1 of 5 is flagged). Only sharp labels on STRANGER faces can; see section 8.

## 6. Shipped: `src/server/blurFilter.ts` (pure, not wired)

```text
sharpness = -(17.4616 - 0.5703 * featureNorm - 1.3364 * ln(sizePx))
blurry    = sharpness < 1.68          (DEFAULT_BLUR_POLICY.threshold)
```

Equivalent featureNorm cut-offs: 23.7 at 66 px, 22.8 at 100 px, 21.8 at 150 px, 21.0 at 220 px.

- `blurSharpness(metrics, policy)` -> number | null; `blurProbability()` for shadow logging; `isBlurry()`;
  `proposedFloors()` returns `hideFromClusters` and `refuseAsTemplate` (the same rule, named for the two call sites);
  `blurPolicyFromEnv()` reads `FACE_BLUR_THRESHOLD`.
- Fail-safe: a missing, non-finite, non-positive or wrong-typed `featureNorm`/`sizePx` gives `null`, and `isBlurry`
  is `false` for `null`. **Unknown is never hidden.**
- Model tag: `featureNorm` is only meaningful for `arcface_w600k_r50`; a different `modelTag` gives `null`. A policy
  with weight 0 on a metric does not require that metric (the default ignores `edgeEnergy`).
- Not a door decision and not liveness: it ranks capture detail, nothing about presentation attacks.
- Tests: `tests/blurFilter.test.ts` (14): monotonicity, the fitted cut-offs, determinism, null/missing/NaN/
  wrong-type/negative inputs, model mismatch, size-less and edge-less policies, env override, `proposedFloors`.

Threshold choice: the parent plan's budget (<= 10 % of sharp lost), pooled. Per-gate thresholds would be 1.81
(entry) and 1.51 (exit); the pooled 1.68 lands at 8.0 % / 13.3 % sharp lost. Not shipped per gate: 94 blurry labels
at exit are too few to pin a threshold to two decimals, and the integrator can set `FACE_BLUR_THRESHOLD` per
deployment anyway.

## 7. What changes when wired (measured on the same 11 931 faces)

| gate | stranger captures hidden from the cluster panel | blurry labels hidden | sharp proxy refused as template | recognised, cosine < 0.65, refused |
|---|---|---|---|---|
| entry | 617 / 1710 = **36.1 %** | 51 / 138 = 37.0 % | 134 / 1668 = 8.0 % | 993 / 3964 = 25.1 % |
| exit | 800 / 1451 = **55.1 %** | 53 / 94 = 56.4 % | 139 / 1045 = 13.3 % | 735 / 2088 = 35.2 % |
| pooled | 1417 / 3161 = 44.8 % | 104 / 232 = 44.8 % | 273 / 2713 = 10.1 % | 1728 / 6052 = 28.6 % |

- (a) Cluster panel: roughly a third of entry and half of exit stranger captures would disappear from grouping.
  The access history keeps them (hide, never delete), like a dismiss.
- (b) Templates: enrolment/merge from a stranger tile and camera adaptation would refuse ~10 % of the faces that
  recognised fine and ~29 % of the weaker recognised faces. Adaptation already requires cosine >= its own floor, so
  the practical effect is on the weaker 29 %, which is the intended direction (they are the templates that drift).
- Door decisions: none. `strangerFaceFloor()` (storage) and the access policy are not touched.

## 8. Rollout (behind an env flag) and owner decisions

`FACE_BLUR_FILTER = off | shadow | hide | enforce` (default `off`), `FACE_BLUR_THRESHOLD` (default 1.68).

1. **shadow** (ship first, 1-2 weeks): compute `blurProbability()` for every stored face, return it on the
   blur-report list and cluster photos as `blurScore`, count flagged per gate per day in the health summary.
   Nothing hidden. This answers section 5 cheaply: operators keep reporting; if new "Báo ảnh mờ" reports fall
   mostly in the flagged half, the rule is about blur; if they fall evenly, it is not.
2. **hide**: (a) only. Reversible per face (restore like a dismissed group), reversible globally by flipping the flag.
3. **enforce**: (a) + (b).

Decisions:

1. Accept that no stored metric meets the S3 target (>= 70 % removed at <= 10 % lost) and either (i) ship `shadow`
   now and decide on `hide` with the shadow numbers, or (ii) go straight to S1 measures 1-4 of the parent plan
   (contrast-normalised Laplacian / re-blur ratio on the ORIGINAL frame crop), which needs the labelling round.
2. The missing labels are **sharp strangers**: ~150 `rated-sharp` on stranger faces (S0 page, ~15 min) would turn
   section 5 from a guess into a measurement. Who, and when?
3. Is hiding 36 % (entry) / 55 % (exit) of stranger captures acceptable if it also hides half the sharp strangers?
   Today's numbers cannot rule that out.

## 9. Integration proposal (server.ts owner; this task did not touch `server.ts`)

No schema change. One import: `import { DEFAULT_BLUR_POLICY, blurPolicyFromEnv, blurProbability, isBlurry, proposedFloors } from "./src/server/blurFilter";`
and `const BLUR_POLICY = blurPolicyFromEnv(process.env)`, `const BLUR_MODE = envEnum("FACE_BLUR_FILTER", "off", [...])`.

Metrics come from `StrangerFaceRecord` / `FaceObservation` fields that already exist: `featureNorm`, `sizePx`
(or `min(box w, h)`), `modelTag`.

| where (function name) | mode | change |
|---|---|---|
| `strangerWindow()` -> `observationsFromFaces(faces, retired)` | hide/enforce | drop faces with `isBlurry({ featureNorm, sizePx, modelTag }, BLUR_POLICY)` before clustering, as retired observations are dropped today; keep them in `faces` so the access history and the blur-report routes still see them |
| `GET /api/strangers/clusters` (photo decoration, next to `blurReported`) | shadow+ | add `blurScore: blurProbability(...)` per photo; in hide mode also `blurHidden: true` on the per-log fallback photos |
| `GET /api/strangers/blur-reports` | shadow+ | add `blurScore` per report row so the labelling page shows the rule next to the operator's label |
| `enrolFromStrangerSource()` (before `prepareTemplateFromImage`) | enforce | `if (proposedFloors(BLUR_POLICY).refuseAsTemplate(face)) return { rejected: "blurry" }` (new `EnrollOutcome` reason; `src/types.ts` owner if the union lives there) |
| `runCameraAdaptation()` candidates filter | enforce | add `!refuseAsTemplate(o)` to the `.filter(...)`; log the count skipped |
| `strangerFaceFloor()` | none | NOT changed: the storage floors stay; the filter hides, it does not refuse storage (owner decision 2 of the parent plan, "hidden but kept") |
| health/summary (`/api/health` or the accuracy summary) | shadow+ | per-gate count of flagged faces in the last 24 h, so the shadow period produces numbers without a DB query |

Fail-closed notes for the integrator: `isBlurry` returns false on unknown, so a face without `featureNorm`
(pre-2026-10-02 rows, or another recogniser) is never hidden; nothing here feeds the access-policy decision or the
door controller.

## 10. Verification

Gates (worktree, image `smartface-tests:blur`, through the shared `gate-lock.sh` wrapper at 1.0 CPU):
`npm run lint`, `npm test`, `npm run build` — results in the handoff. The evaluation ran inside the tester image on a
tab-separated dump of the SELECT (no ids, no images), deleted afterwards.

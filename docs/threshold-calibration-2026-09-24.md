# Recognition threshold calibration — 2026-09-24

Measured against live `access_logs` on the staging gateway. Read-only; no live
data or configuration was changed by this analysis.

## Thresholds actually in force

`currentFusionThresholds()` takes `acceptSingle` from the stored AI config and
everything else from `DEFAULT_FUSION_THRESHOLDS`; no `FACE_*` overrides are set
on the running container.

| Threshold | Value | Source |
| :--- | :--- | :--- |
| `acceptSingle` | 0.45 | `ai_recognition_config.localModel.similarityThreshold` |
| `acceptFused` | 0.45 | default |
| `minEvidence` | 0.35 | default |
| `minMargin` | 0.08 | default |
| `minAgreeing` | 2 | default |

## Reading the two score columns

They are not the same scale, which matters for any comparison:

- **DENIED** rows record the raw best cosine as a percentage (`confidence`), and
  the same number appears in the reason text.
- **GRANTED** rows record the *fused decision confidence* as a percentage, which
  is `(fused − minEvidence) / (1 − minEvidence)` plus a small multi-stream bonus.
- `livenessScore` is capture quality ×100. It is **not** an anti-spoofing score.

## Is anyone being rejected just under the line?

This was the open question. 98 denials scored in the 0.35–0.45 band, the highest
at 0.447 — three thousandths under the threshold — which looks like a false-reject
population until it is tested.

Test: denials in the 30 s immediately before a successful grant at the same gate
are overwhelmingly the same person walking up. If the threshold were cutting off
enrolled people, those denials would skew high.

| Population | n | mean cosine | max | ≥0.35 |
| :--- | ---: | ---: | ---: | ---: |
| Denials 30 s before a grant | 11 | 0.196 | 0.401 | 1 (9%) |
| All denials | 1,252 | 0.213 | 0.447 | 98 (7.8%) |

They are indistinguishable. A wider ±120 s adjacency test also found no
enrichment in the near-miss bands over the ~7% ambient baseline.

**Conclusion: do not lower the threshold.** There is no population of enrolled
people sitting just below 0.45. Pre-grant denials are low-scoring — the same
person at an angle or distance where the embedding is simply poor, not a
marginal match. Lowering into the 0.35–0.45 band would convert almost none of
them into grants, while admitting strangers: cross-camera impostor scores on
this site were previously measured at 0.139–0.304, which overlaps that band.

## What does limit recognition

| Capture quality | scans | grants | grant rate |
| :--- | ---: | ---: | ---: |
| <0.15 | 54 | 0 | 0.0% |
| 0.15–0.25 | 100 | 0 | 0.0% |
| 0.25–0.40 | 200 | 6 | 3.0% |
| ≥0.40 | 960 | 56 | 5.8% |

No capture below 0.273 has ever produced a grant. But 73% of scans are already
≥0.40, so capture quality is no longer the dominant limit either — it has
improved substantially since the earlier measurement.

The remaining limit is **enrolment coverage**: 4 of 10 employees have templates
(14 templates total). A doorway camera scanning every 3 seconds sees mostly
people who are not enrolled, so a 5.8% grant rate among good captures is
expected rather than a defect.

## Actions

1. **Threshold: leave at 0.45.** Revisit only if a specific person reports being
   refused while enrolled, and check that person's scores rather than the aggregate.
2. **Quality floor: implemented.** `FACE_STRANGER_MIN_QUALITY` (default 0.25)
   stops storing the 154 scans that can never identify anyone. Storage only —
   recognition and the unlock path are untouched.
3. **Enrol the remaining six employees** the way the working four were enrolled
   (per camera, good lighting). This is the highest-value remaining action and
   needs no code.

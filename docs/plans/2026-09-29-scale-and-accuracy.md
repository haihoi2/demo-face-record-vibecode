# Plan: throughput, accuracy, N gates, shared faces

Status: APPROVED 2026-09-29. Owner decisions: 1 yes, 2 yes, 3 automatic with audit + operator delete, 4 yes (each future gate has its own physical door), 5 NO manual enrolment - employees unrecognised on a camera appear there as stranger groups and the operator merges each group into the right person (per-camera templates come from those merges, from the face's own crop), 6 yes. Owner request: "continue the plan: optimize system and increase the accuracy engine and model, extend to many gates (not fixed to 2), every gate can share person faces for check". Needs the decisions in section 8 before code is written. Sources: live counters on staging (both gates shadow, 18 vCPU, 10:08–11:45Z), the calibration handoffs (2026-09-27-rt-calib, rt-entry), and a read-only inventory of the code.

## 1. What the live system says today

| Fact | Entry | Exit |
|---|---|---|
| Camera frames offered to the new engine | 8 fps | 8 fps |
| Frames actually processed (one recognition thread per gate, loop ~370 ms) | 27,657 | 17,079 |
| Frames dropped because the worker was still busy | 63,044 (70%) | 41,994 (71%) |
| Shadow decisions in 1.5 h | 756 | 44 |
| ...of which the person never yielded a usable face | 742 | 43 |
| ...employees recognised | 11 | 1 |
| Old engine grants in the same window | 13 | 3 |

- 775 of 800 shadow decisions had `framesUsed = 0`: the tracker saw a person for 2–10 frames but no frame reached embedding. With 70% of frames dropped, a tentative track (needs 2 hits within 500 ms) rarely confirms. **This is a throughput problem, not a model problem.**
- Face templates: 89 in total, **1** captured from a live camera. By where the merged captures came from: 18 employees have entry-side faces only, 9 both sides, 2 exit only. Calibration measured cross-camera matching at 11.6% and exit-to-exit at 23%, so most employees are effectively un-enrolled at the exit.
- Matching is already global: the gallery ignores which camera a template came from, and every gate matches against all templates. "Sharing faces across gates" is therefore in place; what is missing is templates from each camera.
- The shadow engine's results are not stored and carry no cosine/margin, so its accuracy cannot be compared with the old engine after the fact.
- The calibrated per-model thresholds and the gallery-derivation planner exist in code but are not connected to the pipeline (`pipelineContext` uses the legacy tag, gallery and thresholds).

## 2. Part A: let the new engine see the frames (configuration, this week)

**Measured 2026-09-29 (dev replay of the NVR sequences, ground truth in clips.json, host load 12–15):**

| Setting | Entry dropped-busy | Entry tracks with no usable face | Entry passages with a usable decision | Exit passages |
|---|---|---|---|---|
| 1 thread, `auto` (today) | 70% | 93% | 4 / 35 | 0 / 45 |
| 4 threads, `auto` | 49% | 96% | 4 / 35 | 2 / 45 |
| 4 threads, `auto:960` | 74% | 97% | 2 / 35 | 0 / 45 |

Threads cut the drops but not the misses. The run-3 log showed 351 detections for 8 embeddings at the entrance, and the per-frame diagnostic (`usable.ts`) on the entry strip found: 174 faces under 60 px, 47 failing the pose gate (aspect 29, roll 9, yaw 9), 14 usable; only 3 of 18 passages with people ever had two usable frames. **The entrance limiter is face size in the wide 4K overview (the 60 px floor) plus downward pose, not throughput.** Consequence: A.1 (threads) still helps and stays; A.2 (`auto:960`) does not help at the entrance; a new A.4 is added below.

**Offline diagnostic per gate (usable.ts, 2 fps inside the labelled passage windows, detector `det_10g_int8_dyn`):**

| Gate, detector input | Passages with people | ...with any face detected | ...with ≥ 2 usable frames | Faces: usable / < 60 px / pose-unclear |
|---|---|---|---|---|
| Entry `auto` (1696×224, scale 0.49) | 18 | 12 | 3 | 14 / 174 / 47 |
| Entry `auto:960` (2592×352, scale 0.76) | 18 | 14 | 7 | 28 / 223 / 45 |
| Exit `auto` (832×480) | 23 | 3 | 3 | 20 / 13 / 0 |
| Exit `auto:960` (1280×704) | 23 | 4 | 3 | 19 / 15 / 0 |
| Exit `auto:1280` (1696×960) | 23 | 3 | 3 | 19 / 14 / 0 |

- **Entrance:** the larger detector input doubles usable frames; most detected faces are still under 60 px. So `auto:960` **does** help at the entrance when the worker has CPU (run 3 was CPU-starved at host load 15), and a lower pipeline-only floor helps on top.
- **Exit:** in 840 sampled frames with people present no face is detectable at any input size; the few passages with a visible face are usable. The exit camera (NVR channel, steep angle) mostly sees people from behind or the side. **This is camera placement, not software.** The door engine's 11 expected grants out of 59 people at the exit match this picture.

4. **A.4 Pipeline-only face-size floor** `PIPELINE_MIN_FACE_PX` (worker only; the door engine keeps 60 px): test 40 px on the replay, then in shadow on staging. Recognition accuracy at 40–60 px was measured earlier at about 23% of grants on the entry camera being 40–60 px faces that matched correctly, so this is an owner decision (section 8, decision 7). If 40 px is still short, the entrance needs a closer camera (hardware).

1. `PIPELINE_ORT_THREADS` 1 → **4** per gate (2 gates × 4 = 8 of 18 vCPU). Expected loop ~120–150 ms → 7–8 fps processed. Success: dropped-busy < 20%, `framesUsed = 0` share < 40%, decisions per person ≥ 90% on the NVR replay clips.
2. If entry recall is still short: `PIPELINE_DETECT_INPUT=auto:960` on the entry gate (calibration: 100% recall vs 95%, 2.4× detector cost, affordable at 4 threads).
3. Fallback only if 1–2 are not enough: tracker `tentativeMaxMissMs` 500 → 1000 and `confirmHits` at low fps (code change, small).
4. Method: dev harness replay of the 46 NVR clips at each setting → staging on owner approval → 24 h shadow → compare with Part B numbers.

## 3. Part B: make accuracy measurable (small schema, one wave)

- Persist every shadow outcome in `pipeline_shadow_results` (additive): gate, trackId, outcome, employeeId, fused cosine, margin, runner-up, basis, framesSeen/Used, firstSeen/decided, plus the nearest old-engine event on the same gate within ±5 s (its id and status).
- Engine card shows per gate over 24 h: agreement rate, shadow-only finds, legacy-only finds, and **disagreements on identity** (the false-accept candidates an operator must look at).
- Retention: 30 days (decision 2). No images; embeddings never stored here.
- Wire `pipelineFusionThresholds()` into `pipelineContext()` so the pipeline uses its calibrated per-model thresholds (today it silently uses the legacy ones).

## 4. Part C: templates per camera (largest accuracy gain)

Calibration: recognition by templates per person 1 → 70.9%, 5 → 86.4%, 10 → 91.3%; a gallery built from stored face crops scores 85.6% vs 76.8% from full frames.

- **C1 (operator, no code; owner decision 5):** no manual capture session. An employee the exit camera does not recognise is captured there as a stranger; the operator merges that group into the employee, which enrols a template from that camera's crop. C2 must make this visible: the group card shows the best-matching employee as a suggestion, and the employee list shows which cameras still lack templates.
- **C2 (code):** template cap per camera instead of the global 12 (5 per camera + photo templates), eviction per camera, and a coverage indicator per employee per camera with a "missing on camera X" filter.
- **C3 (code, decision 3): camera adaptation.** A guarded derivation job (the existing `planGalleryDerivation`) turns confident old-engine grants into per-camera templates from the stored face crop: fused cosine ≥ acceptSingle + 0.10, margin ≥ 0.15, quality ≥ 0.35, at most 5 per camera per employee, never from stranger merges, each template attributed to the job and deletable by an operator. Audit line per template.
  - **Correction after measurement (acc-eng, 2026-09-29):** adaptation GROWS a camera's templates (1 → 5 within a few grants once that camera has one), it cannot SEED a camera: on this site no cross-camera pair reaches the 0.65 floor (max 0.60) and fewer than 5% are granted at all cross-camera. The seed for a new camera is the operator's first merge of the person's stranger group on that camera (decision 5); after that, adaptation fills the remaining slots automatically. Also: one template per access event per camera (`onePerEvent`), so the five slots span days rather than one passage.

## 5. Part D: engine and model

- **D1** Keep the FP32 r50 recogniser now that CPU is available (INT8 loses 1.4 points; MobileFaceNet 8). The INT8 path stays as an option for a GPU-less expansion.
- **D2** Evaluate horizontal-flip test-time augmentation with `calib-eval` (cheap, typically 0–2 points).
- **D3** `FACE_DETECT_UPSCALE`: keep `none` (measured best: 93% re-find vs 86/84%). Close review item 7 with this decision (decision 6).
- **D4** Labels for free: per-face records plus operator adjudications (merge / quick-register / dismiss) give labelled pairs continuously. Grow the calibration set from 141 labelled crops to thousands and re-run `calib-eval` monthly. Only then evaluate a stronger recogniser (r100-class or AdaFace, about 2.5× r50 cost, still CPU-feasible at 4 threads).
- **D5** Exit camera quality: exit-to-exit at 23% points at the picture (1080p NVR channel, faces 60–80 px, steep angle). Do C1 first; if exit stays below ~70%, it is a camera placement question (hardware decision), not a model one.

## 6. Part E: N gates (one wave after A–C)

Inventory: the two-gate assumption lives in `CameraStreamsConfig {entryGate, exitGate}`, the `ScanType/Gate` unions, per-gate `Record<"entry"|"exit">` state (watchers, pipelines, stats), route validation `(entry|exit)`, auth rules, one door controller and one lock state, per-gate env (`PIPELINE_MODE_ENTRY/EXIT`, `RECORDING_*_CHANNEL`, `CAMERA_*_RTSP_URL`), and two-tab UIs (camera config, dashboard, engine card, scanner, logs filter). Already generic: `streams[]` per gate, the cooldown maps, the global gallery, templated URLs, free-form DB columns.

Design:
- `gates: GateConfig[]` with `id` (slug), `label`, `direction: IN | OUT`, `doorId`, `streams[]`, `watch`, `pipelineMode`, `recordingChannel`, `enabled`. `entryGate/exitGate` remain as a compatibility view; migration maps them to gates `entry` (IN) and `exit` (OUT).
- Access events keep `type` (direction, for reports and the existing filters) and gain `gateId` (backfilled from `type` for old rows). Stranger faces likewise.
- **Doors become per gate**: door controller config `doors[]` (id, URL, token server-side), each gate bound to one door; `unlockDoor(gateId)`. Today every gate opens the same door.
- Routes `/api/camera-streams/:gateId/...` validate against the configured gates (400 for unknown; today an unknown gate silently becomes "entry"). Auth rules generalised to a slug; pipeline-mode stays admin.
- Per-gate state becomes `Map<gateId, ...>`; pipeline `Gate` becomes the gate id.
- UI: gate list instead of two tabs; engine card rows from config; scanner and logs select a gate; enrolment already lists cameras.
- Webhooks: title per gate.
- Tests: about 40 files touch the two-gate assumption; add an N = 3 integration test (entry, exit, side).
- Capacity: ~2–3 vCPU per gate in shadow/live (decode + 4 threads). 18 vCPU carries about 5 gates; beyond that, a GPU or a second node.

## 7. Order and effort

| Wave | Content | Effort | Owner action |
|---|---|---|---|
| A | ORT threads, detect input, replay measurement, staging soak | 1–2 days | approve staging change |
| B | shadow results table + card numbers + threshold wiring | 2 days | none |
| C1 | enrol all employees on both cameras | operator, ~1 h | schedule it |
| C2–C3 | per-camera cap, coverage, camera adaptation job | 3 days | decision 3 |
| D2–D4 | TTA eval, label pipeline, monthly calib | 2 days + recurring | none |
| E | N gates | 5–7 days | decision 4 |

## 8. Owner decisions

1. **Part A on staging** after the dev replay: threads 4 per gate, then `auto:960` on entry if needed. Recommended: yes.
2. **Shadow results retention**: 30 days, no images. Recommended: yes.
3. **Camera adaptation (C3)**: automatic with audit and operator delete (recommended), or operator-approved per template.
4. **N-gate model**: direction + door per gate as in section 6. Confirm that each future gate has its own physical door/controller.
5. **C1 now**: have an operator enrol all 31 employees on both cameras this week.
6. **`FACE_DETECT_UPSCALE` stays `none`** (closes review item 7). Recommended: yes.
7. **Pipeline-only face floor** `PIPELINE_MIN_FACE_PX=40` on staging in shadow mode (door engine unchanged at 60 px), after the dev replay shows it lifts usable decisions. Recommended: yes, shadow only.
8. **Flip TTA measurement** needs a read-only re-export of stored face crops from the live database (about 20 minutes of compute, biometric data kept under /data/test-clips, deleted after). Recommended: yes, once, by INT.

## 9. Contract (accuracy wave, base `release/accuracy`)

- `src/server/shadowResults.ts`: `ShadowResultRecord`, `ShadowResultStore`, `classifyShadowAgreement`, `SHADOW_RESULT_RETENTION_DAYS` (30).
- `src/server/galleryAdaptation.ts`: `planAdaptation` policy (pure), `templateCoverage`, `DEFAULT_ADAPTATION_POLICY`.
- `src/server/strangerFaces.ts`: recognised-face observations (`employeeId`, `matchCosine`, `matchMargin`) and `getRecognisedFaceObservations`.
- `src/types.ts`: `StrangerCluster.suggestion` (`StrangerClusterSuggestion`), `ShadowAccuracySummaryView`.
- API (INT): `GET /api/pipeline/shadow-summary?hours=24` → `{ success, since, gates: ShadowAccuracySummaryView[] }` (viewer); `GET /api/pipeline/shadow-results?gate=&agreement=&cursor=&limit=` (viewer); `GET /api/employees/:id/templates` gains `coverage: [{streamId, gate, count, adaptation}]`; `DELETE` of an adaptation template uses the existing template route; stranger cluster payloads gain `suggestion`.
- db (data-migrations): `pipeline_shadow_results` table implementing `ShadowResultStore`; `stranger_faces` gains `employeeId`, `matchCosine`, `matchMargin` (nullable) and the candidate/grouping queries exclude rows with `employeeId`; `face_templates.source` accepts `"adaptation"`; a per-(employee, streamId) template count query.
- Hotspot writers: db.ts data-migrations; server.ts, strangers.ts, types.ts, contracts INT; StrangerClusterModal.tsx, EmployeeRegistration.tsx, RealtimeEngineCard.tsx frontend.

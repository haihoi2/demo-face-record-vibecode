# Engine comparison harness: a model switch is a measured decision

Status: TOOLING + MEASURED (Taiga #513; detector input size feeds #523). 2026-11-03. Nothing in production
changes. `server.ts touched: no`. Sections 1-8 describe the harness (validated first on a synthetic crop set);
section 9 holds the 2026-11-02 run on real site data under the owner's approval (OpenCV Zoo SFace/YuNet fetched
and hashed for it; data deleted afterwards).

## 1. Why

The gate runs InsightFace `buffalo_l` (SCRFD `det_10g` + ArcFace `w600k_r50`) with thresholds calibrated on this
site's captures (`docs/agent-handoffs/2026-09-27-rt-calib.md`). Any proposal to change the recogniser (faster,
free-licensed, "more accurate") or the detector input size must be answered with numbers from THIS site's faces
and this CPU, not a benchmark table from a paper. `scripts/perf/engine-compare.ts` is the offline tool for that.

## 2. Data: reuse the calib pipeline, create nothing new

The harness consumes the crop set of `scripts/perf/calib-crops.ts` (112x112x3 uint8 RGB ArcFace-aligned crops,
`index.json` with weak labels, `calib/` = INT8 calibration subset that is excluded from scoring). Producing it is
the documented, already-reviewed flow of 2026-09-27 and needs the owner's approval each time because it exports
biometric data:

```bash
# 1. read-only export of access_logs snapshots into a 0700 scratch dir (DBA step, owner approval; see the
#    2026-09-27 handoff "Calibration data": GRANTED rows with a snapshot + recent DENIED rows -> <export>/index.json + JPEGs)
# 2. aligned crops, exactly what the pipeline embeds (FP32 SCRFD at 640, alignFace, clearFaceIssue, FACE_MIN_SIZE_PX)
docker run --rm --network none --cpus 2 \
  -v /data/models:/models:ro -v <export>:/export:ro -v <scratch>/crops:/crops \
  -e FACE_MODEL_DIR=/models -e FACE_ORT_THREADS=2 \
  --entrypoint npx smartface-tests:encmp tsx scripts/perf/calib-crops.ts /crops --logs /export [--clips /clips]
# 3. the comparison (section 3)
# 4. delete: rm -rf <scratch>/crops <export>   (crops and any embeddings are biometric derivatives)
```

The crop set, the export and the report JSON live under the session scratchpad or a 0700 dir on `/data`, never
in the repo, and are deleted after the run. The harness keeps embeddings in memory only (no `emb_*.f32` cache;
`calib-eval.ts` has one, this tool deliberately does not) and refuses to write a report containing any vector
(`assertNoVectors`).

Labels are WEAK: an employee label comes from the current engine's own GRANTED decision, so the pair set cannot
show the baseline's own false accepts and favours `w600k_r50`. A candidate that looks equal here may still be
better; one that looks worse is worse.

## 3. Running the harness

```bash
docker build -q --target tester -t smartface-tests:encmp .
docker run --rm --network none --cpus 2.5 \
  -v /data/models:/models:ro -v /path/to/candidates:/cand:ro \
  -v <scratch>/crops:/crops -v <scratch>/out:/out \
  --entrypoint npx smartface-tests:encmp tsx scripts/perf/engine-compare.ts /crops \
    --model r50=/models/w600k_r50.onnx \
    --model r50_int8=/models/candidates/w600k_r50_int8.onnx --parent r50_int8=r50 \
    --model cand=/cand/x.onnx,input=112,mean=127.5,std=127.5,layout=NCHW,rgb \
    --license r50="MIT (code); weights: InsightFace non-commercial research only; WebFace600K" \
    --license cand="..." \
    --ref r50 --threads 2 --bench-threads 1,2,4 --bench-iters 40 \
    --out /out/engine-compare.json --md /out/engine-compare.md \
    [--frames /frames --detect-size 640,960,1280 --detect-ref 1280 --detector-dir /models]
```

`--model name=path.onnx[,input=112,mean=127.5,std=127.5,layout=NCHW|NHWC,rgb|bgr]`: the defaults are exactly
the contract `faceEmbedding.ts` implements for `w600k_r50`; per-channel mean/std use `/`
(`mean=123.7/116.3/103.5`). A model with a different contract is evaluated correctly but is flagged
`loadableByCurrentEngine: false`: the engine today accepts only 512-D, 112 NCHW RGB `(x-127.5)/127.5`, and a
switch would need engine work plus a new template tag (section 6).

Threads: `--threads` (default `FACE_ORT_THREADS` or 2) for the embedding pass; the latency bench runs the model at
each `--bench-threads` count. Keep the container at `--cpus 2.5` on this host (live streams share the CPU).

### What is reported per recogniser

| column | meaning |
|---|---|
| genuine / impostor strict / probable p5/p50/p95 | cosine of L2-normalised embeddings per pair kind (same rules as `calib-eval.ts`: genuine = same employee, different capture; strict impostor = two different employees; probable = employee vs unlabelled DENIED/stranger) |
| TAR@FAR=0 | genuine pairs accepted at the smallest threshold with zero strict false accepts (threshold shown) |
| TAR@site strict | the site's rule: zero strict false accepts AND threshold >= impostor p95 + `minMargin` (0.08), rounded up to 0.01; margin shown |
| TAR/FA @legacy 0.55 | today's `acceptSingle` applied to this model's cosines (only meaningful in the baseline's space) |
| acceptSingle / acceptFused reproducing ref | thresholds in the candidate's own cosine space that give the reference's TAR and FAR at `DEFAULT_FUSION_THRESHOLDS` (0.55 / 0.45 for `arcface_w600k_r50`); the stricter of same-TAR and same-FAR, rounded up to 0.01, with its TAR, strict false accepts and margin |
| drift p50/p95 | `1 - cos` vs `--parent` on the same crops (quantised child vs FP32 parent; equal dims only) |
| ms/face 1t/2t/4t | median ONNX Runtime CPU latency per 112 crop at 1/2/4 intra-op threads on this CPU (JSON also has p95, min, load ms, speed-up vs ref) |
| good enough | `calib-eval` rule: TAR@FAR=0 within 2 points of the reference AND margin >= 0.08 at the reproduced threshold AND zero strict false accepts there |

Also in the JSON: `dPrime`, TAR/FAR at FAR = 1e-3 (needs >= 1000 strict impostor pairs to mean anything), FRR
(= 1 - TAR) per operating point, file size, embedding dim, `modelTagIfLoaded` (`faceModelTagFor(file)`) and
`tagCollidesWith` (two different files that would share a tag would mix embeddings in a gallery; the harness warns).

### Detector input size (#523)

With `--frames <dir>` of full frames (JPEG/PNG; the gate's own stored frames or an NVR export, biometric data,
same handling as the crops) the SCRFD detector in `--detector-dir` runs at each `--detect-size` square letterbox
(`detectFaces(img, {inputShape})`, `FACE_DETECT_UPSCALE=none`) and reports, against `--detect-ref` (default the
largest size): faces found (all / >= `FACE_MIN_SIZE_PX`), recall, extra detections, box IoU, landmark error as a
percentage of the face size, the sizes of missed faces, and ms per frame. For gate-area strips with the
aspect-preserving `auto` plan, `scripts/perf/detect-input-eval.ts` remains the tool; this one answers the simpler
door-scan question "640 vs 960 vs 1280 on the full frame".

`--tiles 2 --tile-size 640 --tile-overlap 0.1` adds a pass that splits each frame into two horizontal windows
sharing 10 % of the width, letterboxes each to 640 on its own, and merges the detections with NMS (IoU 0.4, the
higher score wins; `tilePlan` / `cropRgb` / `mergeTileDetections` in the lib). The row is scored against the same
`--detect-ref` as the plain sizes; its ms/frame includes the two detector runs and the crops.

### The near-threshold DENIED group

Unlabelled `DENIED` crops in the set (the live engine's rejections with best cosine 0.50-0.55) are never genuine or
impostor pairs. They are reported on their own: per model, each denied crop's best cosine against every
employee-labelled crop (1-NN; a proxy for "best template"), and how many crops reach the model's reproduced
`acceptSingle` / `acceptFused`, its site-strict and FAR = 0 thresholds, and today's 0.55. A model that accepts
many of them at its equivalent threshold is more permissive on exactly the cases the gate is unsure about today;
whether those people are employees or strangers is unknown (that is the point of the group).

The report also carries a label-defect radar: the employee-id pairs with the most strict-impostor cosines at or
above `acceptSingle` under the reference model (counts and max only). Two ids this close are one person under two
records or a repeated false accept; the 2026-09-27 run found EMP-0465 / EMP-7602 this way.

## 4. Decision rule for a recogniser switch

A candidate may replace `w600k_r50` for the door only if, on the site's crop set (>= the 2026-09-27 size: 11
employees, ~600 crops, strict impostor pairs in the thousands):

1. good-enough verdict `yes` with the reference = current `w600k_r50`;
2. TAR at the site-strict threshold not below the baseline's by more than 2 points, with 0 strict false accepts;
3. probable-impostor p95 at the reproduced `acceptSingle` not above the baseline's;
4. latency at the production thread count fits the door-scan budget (today ~1 s per 4K frame end to end at 4
   threads; the recogniser is a minority of that);
5. the licence row says "ok for production" or legal sign-off is on file (section 5);
6. the engine change is implemented fail-closed (section 6) and the gallery is re-enrolled per camera under the
   new tag (cross-camera cosine overlaps the impostor range on this site; never convert embeddings).

A detector size change for the door scan needs: recall vs 1280 on faces >= 60 px not below 98 % on the gate's
frames, no landmark error p95 above ~3 % of the face size (alignment drift moves embeddings), and the ms/frame
within the scan gap.

## 5. Candidate licences (fill from the official LICENSE / README; "cần kiểm tra" = not verified offline)

The harness prints whatever `--license` says; this table is the reference the operator copies from. Code licence
and weight terms differ: an MIT repository does not make its pretrained weights free, and almost every public
face-recognition weight set was trained on a dataset whose terms are research-only (MS-Celeb-1M / MS1MV2/3 -
withdrawn by Microsoft; WebFace260M / WebFace600K / Glint360K / WebFace4M-12M - research licence on application;
VGGFace2 - non-commercial; CASIA-WebFace - research). Whether that caveat binds a deployment of the WEIGHTS is a
legal question, not an engineering one.

| candidate | code licence | pretrained weights: licence / terms | training data caveat | verdict |
|---|---|---|---|---|
| InsightFace buffalo_l: det_10g + w600k_r50 (CURRENT) | MIT (insightface repo / python package) | InsightFace model zoo: "available for non-commercial research purposes only" (model-zoo README; applies to auto-download packs incl. buffalo_l) | w600k_r50: WebFace600K (subset of WebFace260M, research licence); det_10g: WIDER FACE (research) | ok to evaluate; production use NEEDS LEGAL SIGN-OFF (already deployed - raise with the owner) |
| InsightFace antelopev2: scrfd_10g_bnkps + glintr100 | MIT | same InsightFace non-commercial-research terms | glintr100: Glint360K (research) | ok to evaluate; needs legal sign-off for production |
| InsightFace buffalo_s/sc: w600k_mbf (already in /data/models/candidates) | MIT | same terms | WebFace600K | ok to evaluate; needs legal sign-off; measured 2026-09-27: 7-8 TAR points below r50 here |
| AdaFace (mk-minchul/AdaFace) | MIT | weights distributed from the repo README (Google Drive); no separate weights licence stated - cần kiểm tra | MS1MV2 / MS1MV3 (withdrawn MS-Celeb-1M derivatives), WebFace4M / WebFace12M (research licence) | ok to evaluate; needs legal sign-off; export to ONNX required (PyTorch checkpoints; 112x112, BGR, (x-127.5)/127.5 in the reference code - cần kiểm tra before trusting the spec) |
| MagFace (IrvingMeng/MagFace) | Apache-2.0 - cần kiểm tra | repo-hosted checkpoints, no separate terms stated - cần kiểm tra | MS1MV2 (withdrawn MS-Celeb-1M derivative) | ok to evaluate; needs legal sign-off; export to ONNX required; output is 512-D with magnitude = quality (L2-normalise for cosine, keep the norm as a quality signal) |
| OpenCV Zoo YuNet (detector) + SFace (recogniser) | opencv_zoo: Apache-2.0 | ONNX files in opencv_zoo listed as Apache-2.0 - cần kiểm tra the per-model LICENSE in the zoo folders (`models/face_recognition_sface/LICENSE`, `models/face_detection_yunet/LICENSE`; text not fetched in this task) | YuNet: WIDER FACE; SFace: training set not stated in the zoo README - cần kiểm tra (paper uses MS1M-style data) | EVALUATED 2026-11-02 (section 9). Files fetched by the owner's approval from the official `opencv/opencv_zoo` at commit `48b10fa505aeb51fbd127fc60a5c660040e823b7`, stored in `/data/models/candidates/opencv_zoo/`, sha256 in `SOURCES.sha256` (the zoo keeps `.onnx` in Git LFS: `raw.githubusercontent.com` returns a pointer whose `oid` equals the sha256 of the object fetched from `media.githubusercontent.com`; both verified). SFace: 112x112, 128-D, BGR; OpenCV's `FaceRecognizerSF` feeds `blobFromImage` defaults = raw 0-255, no mean/std (confirmed empirically: section 9 compares raw vs (x-127.5)/127.5). YuNet is not SCRFD (different anchors/outputs): the detector part of the harness does NOT cover it; a YuNet adapter is a follow-up (section 9) |
| dlib ResNet (dlib_face_recognition_resnet_model_v1) | Boost Software License 1.0 | model file: public domain / CC0 per the author (dlib-models README) - cần kiểm tra wording | ~3M faces: FaceScrub + VGG-Face + author-scraped images (terms of the sources mixed) | ok to evaluate once converted to ONNX (dlib .dat is not ONNX; 150x150 input, 128-D; accuracy on 2017 LFW 99.38 %, expected well below ArcFace on this site) |
| facenet-pytorch (timesler) InceptionResnetV1 | MIT | weights ported from davidsandberg/facenet (MIT) - cần kiểm tra whether the port keeps a separate notice | VGGFace2 (non-commercial) or CASIA-WebFace (research) | ok to evaluate; needs legal sign-off; 160x160 input, 512-D, (x-127.5)/128 ("fixed_image_standardization"), RGB; export to ONNX required |
| GhostFaceNets (HamadYA/GhostFaceNets) | MIT | weights in the repo releases, no separate terms stated - cần kiểm tra | MS1MV2 / MS1MV3 (withdrawn) | ok to evaluate; needs legal sign-off; Keras/TF models -> ONNX export (likely NHWC input; (x-127.5)/128 per keras_insightface - cần kiểm tra), 112x112, 512-D |
| EdgeFace (otroshi/edgeface, Idiap) | cần kiểm tra (repo LICENSE; Idiap releases often carry a non-commercial clause) | weights on GitHub/HF - terms cần kiểm tra | WebFace260M subsets (research licence) | ok to evaluate; needs legal sign-off; 112x112, 512-D, torchvision Normalize(0.5, 0.5) = (x-127.5)/127.5, RGB; export to ONNX required |

None of the candidates is approved for production by this document. "ok to evaluate" means: an offline run on
the crop set inside a `--network none` container, weights fetched by the owner (not by an agent in this task),
with the sha256 recorded next to the file as `/data/models/candidates/SOURCES.sha256` does today.

## 6. What a switch would touch (not done here; proposal for the integration owner)

- `faceEmbedding.ts`: the recogniser contract is fixed (112 NCHW RGB `(x-127.5)/127.5`, 512-D). A candidate
  with another input size, layout, channel order or dim needs a per-model `RecognizerContract` resolved from the
  file name, and the template tag must encode the model family, not `arcface_<file>` (today `faceModelTagFor`
  would tag an SFace file `arcface_sface` and mix nothing only because dims differ). Fail closed: refuse to load a
  file whose declared contract does not match the session's input/output metadata.
- `faceFusion.ts`: a `PIPELINE_FUSION_THRESHOLDS_BY_TAG` entry from the harness's reproduced thresholds; a tag
  without an entry falls back to legacy defaults today, which is wrong for a different cosine space - propose
  failing closed instead for non-ArcFace tags.
- Gallery: re-enrol per camera under the new tag (`planGalleryDerivation`), never convert embeddings.
- Door policy: unchanged; identity matching stays separate from authorisation.

## 7. Validation done for this task (no biometric data on the host)

No crop set exists in the scratchpad and creating one needs an owner-approved export, so the end-to-end run used
`scripts/perf/engine-compare-fixture.ts`: deterministic procedural textures posing as identities (6 x 4 captures
+ 4 unlabelled), marked `synthetic: true` in `index.json`; the harness prints a warning and the table title says
so. It proves the mechanics only: a model compared with itself is identical (drift 0, same thresholds), the
INT8 r50 from `/data/models/candidates` (read-only) is evaluated as a child of r50, the report has the documented
shape and contains no vectors. The accuracy numbers from that run are meaningless and were not kept.

## 8. Open questions

1. Owner: is the InsightFace "non-commercial research only" weight term acceptable for the deployed `buffalo_l`,
   or does the licence row above make a free-licensed candidate (OpenCV Zoo SFace/YuNet, verified) a requirement
   rather than an option?
2. DBA/owner: approval for a fresh read-only export of access_logs snapshots (same procedure as 2026-09-27) so the
   harness can run on real site data; the 2026-09-27 set was deleted as agreed.
3. Which candidate weights may be fetched (by the owner, sha256 recorded) for the first real comparison? Suggested
   order: w600k_mbf and r50_int8 (already present), then OpenCV SFace (licence), then AdaFace/EdgeFace (accuracy).
4. #523: the frames for the detector-size comparison - stored door-scan frames (which gate, how many, what hours)
   so the 640/960/1280 numbers reflect the actual face sizes at that door.
5. Integration owner: onnxruntime-node 1.30 printed `[W:onnxruntime ... telemetry.cc] No readable CA bundle was
   found; telemetry HTTPS uploads will be unavailable` when a session was created inside the `--network none`
   container. Check whether the production image's ORT attempts any telemetry upload and, if so, disable it
   explicitly (on-premise system; nothing may leave the host).

Status of 1-4 after the 2026-11-02 run (section 9): 2 and 4 were answered by the owner's approval of 03/11 (read-only
export, deleted after the run; ENTRY frames from the weekday peak windows); 3 was answered for `w600k_mbf`,
`r50_int8` and OpenCV SFace (fetched under that approval, hashes recorded); 1 remains with the owner and the
numbers below say what the permissive candidate costs.

## 9. Results on real site data (2026-11-02, owner-approved export, data deleted)

### 9.1 Data

Read-only export from the live PostgreSQL (`SELECT` only, container env, no credentials printed), decoded on the
host into a 0700 scratch directory, cropped by the 2026-09-27 procedure (`calib-crops.ts`: FP32 SCRFD at the 640
letterbox, `alignFace`, `clearFaceIssue`, `FACE_MIN_SIZE_PX = 60`), and deleted afterwards (JPEG exports as soon
as each batch was cropped, crops and frames after the run; only `engine-compare.json` / `.md` aggregates remain).

| source | rows exported | crops kept | notes |
|---|---|---|---|
| GRANTED, 2026-10-01 .. 2026-11-02, `gateId` entry/exit, <= 30 per employee x gate spread over time (employees with even id hash) | 1,118 | 1,007 | label = `employeeId` (weak: the live r50 decision), gate kept per crop |
| GRANTED, same window, <= 15 per employee x gate (odd id hash) | 684 | 588 | the per-employee cap was lowered to stay inside the 30 min CPU budget (0.9 s per 4K picture at 1.5 CPUs) |
| DENIED since 2026-10-29 with "cosine tốt nhất 0.500-0.550" in the reason (the near-threshold group) | 115 | 114 | unlabelled, reported separately (section 9.4) |
| **crop set** | 1,917 pictures | **1,709 crops: 1,595 employee-labelled (833 ENTRY / 762 EXIT), 54 identities (53 employees), 114 DENIED** | skipped: 172 pictures with several clear faces, 28 without a face >= 60 px, 14 not clear |
| face box size p5 / p50 / p95 | | 63 / 90 / 257 px | pictures 3840x2160 (ENTRY, 898 crops) and 1920x1080 (EXIT, 811) |
| capture quality p5 / p50 / p95 | | 0.53 / 0.84 / 1.00 | |
| pairs | | genuine 14,210 (same gate) + 14,491 cross-gate; strict impostor 1,242,514; probable 181,830 | FAR = 1e-3 is meaningful at this size (>= 1,000 strict pairs) |
| #523 frames: ENTRY gate, weekdays 2026-10-29 .. 2026-11-02, 07:30-08:30 and 12:30-13:30 Asia/Ho_Chi_Minh | 229 | 229 frames of 3840x2160 | all 45 DENIED rows in those windows + all 184 GRANTED rows (the windows hold only 45 DENIED, so half/half was not available) |

Compared with 2026-09-27 (11 employees, 141 labelled crops, 3 employees carrying 94 % of them) this set has 53
employees with 1-56 crops each (median 27), so the FAR = 0 and site-strict statistics are no longer set by one
person. The labels are still weak and still favour `w600k_r50` (section 2).

Runs: `smartface-tests:encmp2` built from this branch, `docker run --network none --cpus 1.5` (the integrator's
shared-host budget during the run; the brief said 2.5), ORT 2 intra-op threads for the embedding pass, bench at
1 / 2 / 4 threads, host load average 12-16 on 18 cores throughout - latencies are upper bounds and the 4-thread
column is capped by the 1.5 CPUs.

### 9.2 Recognisers (crop-vs-crop cosine, L2-normalised; reference r50 = today's engine)

| model | licence (weights) | MB | dim | input | genuine p5 / p50 / p95 | strict impostor p5 / p50 / p95 (max) | d' | TAR @ FAR = 0 (thr) | TAR @ FAR = 1e-3 (thr) | TAR @ FAR = 1e-4 (thr) | TAR / strict FA @ today's 0.55 | acceptSingle reproducing r50 @ 0.55 (TAR, FA, margin) | acceptFused reproducing 0.45 | drift vs r50 p50 / p95 | ms/face 1t / 2t | good enough (calib rule) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r50 (current) | InsightFace non-commercial research | 174.4 | 512 | engine | 0.260 / 0.468 / 0.628 | -0.065 / 0.050 / 0.200 (0.690) | 4.11 | 1.1 % (0.690) | **84.2 %** (0.355) | **50.3 %** (0.467) | 20.6 % / 49 (FAR 3.9e-5) | - | - | - | 707 / 506 | (ref) |
| r50_int8 | same | 82.5 | 512 | engine | 0.259 / 0.462 / 0.621 | -0.064 / 0.051 / 0.199 (0.681) | 4.10 | 1.1 % (0.681) | 84.0 % (0.352) | 50.9 % (0.460) | 18.5 % / 42 | 0.55 (18.5 %, 42, 0.351) | 0.45 | 0.010 / 0.022 | 161 / 128 | no (42 FA > 0; see note) |
| w600k_mbf | same | 13.6 | 512 | engine | 0.217 / 0.402 / 0.574 | -0.063 / 0.067 / 0.222 (0.702) | 3.31 | 0.2 % (0.702) | 60.1 % (0.376) | 31.4 % (0.454) | 8.0 % / 13 | 0.50 (17.7 %, 45, 0.278) | 0.45 | - | 47 / 46 | no |
| SFace, raw 0-255 BGR | Apache-2.0 (opencv_zoo; per-model LICENSE cần kiểm tra) | 38.7 | 128 | 112 BGR, no mean/std | 0.211 / 0.443 / 0.624 | -0.070 / 0.106 / 0.293 (0.711) | 2.74 | 0.6 % (0.711) | 46.6 % (0.453) | 24.4 % (0.523) | 17.3 % / 48 | 0.55 (17.3 %, 48, 0.257) | 0.52 | - | 74 / 69 | no |
| SFace, (x-127.5)/127.5 BGR (wrong preprocessing, run 1 only) | same file | 38.7 | 128 | | 0.796 / 0.949 / 0.985 | 0.759 / 0.938 / 0.979 (0.998) | 0.20 | 0 % | 1.0 % | - | 99.8 % / 1,235,641 | 1.00 | 1.00 | - | 69 / 65 | no |

"TAR @ today's 0.55" is the share of same-employee crop pairs with cosine >= 0.55; the "acceptSingle reproducing
r50" column is the threshold in the candidate's own space that gives the same TAR or the same strict FAR as r50 at
0.55, whichever is stricter, rounded up to 0.01 (run 2; run 1 had a rounding defect in this column, fixed in the
lib with a unit test: a FAR of 4e-5 on 1.24 M pairs was rounded to 0 and turned "same FAR" into "FAR = 0").

How to read the absolute numbers: this is crop vs crop, single capture against single capture across up to five
weeks, both gates, 63-257 px faces, no template selection and no fusion - a much harder task than the door's
"best observation vs enrolled templates", which is why only 20.6 % of r50's same-employee pairs reach 0.55 here
while the gate granted every one of these captures at >= 0.55. The columns to compare models on are d' and
TAR at FAR = 1e-3 / 1e-4 (1,242 and 124 false accepts allowed out of 1.24 M strict pairs): at equal false-accept
rate, how many genuine pairs each model keeps.

Findings:

1. **SFace is clearly worse than r50 on this site**: d' 2.74 vs 4.11; at FAR = 1e-3 it keeps 46.6 % of the genuine
   pairs where r50 keeps 84.2 %; at FAR = 1e-4, 24.4 % vs 50.3 %. At the threshold that reproduces r50's operating
   point (0.55 in its own space too, coincidentally: 48 strict false accepts vs r50's 49) it keeps 17.3 % of the
   genuine pairs vs r50's 20.6 %, and the margin to the impostor p95 is 0.257 vs 0.350 - worse at every point of
   the curve, not only at the extremes. It is 7x faster than FP32 r50 (69 vs 506 ms at 2 threads) and 1.9x slower than r50_int8. Its input
   contract (128-D, BGR, raw) is not loadable by the engine today; `faceModelTagFor` would tag it
   `arcface_face_recognition_sface_2021dec`, which is wrong (not ArcFace) - section 6 applies in full.
2. **SFace preprocessing**: raw 0-255 BGR is the right input (OpenCV's `FaceRecognizerSF` uses `blobFromImage`
   defaults). The (x-127.5)/127.5 variant collapses: every pair scores 0.94-0.99 (d' 0.2). Assumption confirmed by
   measurement, not just recalled.
3. **r50_int8 is the same model**: drift p50 0.010 / p95 0.022 vs FP32, d' 4.10 vs 4.11, TAR within 0.2-0.6 points
   at every FAR, 4x faster at 1-2 threads. Its reproduced thresholds are today's 0.55 / 0.45 unchanged (the
   2026-09-27 `PIPELINE_FUSION_THRESHOLDS_BY_TAG` entry can stay). It is the only candidate that passes the
   section 4 accuracy criteria; licence is the same InsightFace term as the current model.
4. **w600k_mbf** keeps 60 % at FAR = 1e-3 (24 points below r50; 2026-09-27 saw 7-8 points on 141 crops), reproduced
   acceptSingle 0.50. Fast (46 ms) but the accuracy cost is now measured on 53 people.
5. **"good enough" is `no` for every candidate** because the calib rule demands zero strict false accepts at the
   reproduced threshold and r50 itself has 49 at 0.55 on this set (the rule was written when the baseline had 0).
   The 49 come from four identity pairs (next paragraph); the verdict column should be read together with the
   FAR columns, and the rule should become "no more strict false accepts than the reference" in a follow-up.

**Label-defect radar (r50, strict-impostor pairs >= 0.55; counts only, no image viewed).** Four employee-id pairs
produce all 49 strict false accepts: `EMP-27b9ce46…` vs `EMP-e8d23291…` 29 pairs (max 0.69 - this one pair sets
every model's FAR = 0 threshold), `EMP-80f30b1c…` vs `EMP-b1f56976…` 10 (max 0.663), `EMP-09808ba4…` vs
`EMP-838a4839…` 9 (max 0.615), `EMP-224dedb8…` vs `EMP-286daf24…` 1 (0.563). Cosines of 0.6-0.69 between two
different people are far outside this model's impostor distribution (p95 0.20); each pair is most likely one person
with two employee records, or a person repeatedly granted under someone else's id. **Owner action (security
finding, independent of the model question):** check these four pairs of records and their GRANTED events since
2026-10-01. Re-running the harness with `--exclude` of the duplicate ids would lift TAR @ FAR = 0 for every model
and is the first thing to do once the records are understood.

### 9.3 The near-threshold DENIED group (114 crops, live engine's best cosine 0.50-0.55 against the templates)

Per model: the share of the 114 crops whose best cosine against any of the 1,595 employee crops (1-NN, a laxer
proxy than the enrolled templates) reaches each threshold. Reported, not scored - who these people are is unknown.

| model | best cosine p50 / p95 / max | cross @ reproduced acceptSingle | @ reproduced acceptFused | @ own site-strict | @ own FAR = 0 | @ 0.55 in own space |
|---|---|---|---|---|---|---|
| r50 | 0.551 / 0.648 / 0.677 | 58 (0.55) | 111 (0.45) | 0 (0.69) | 0 (0.69) | 58 |
| r50_int8 | 0.547 / 0.641 / 0.669 | 52 (0.55) | 109 (0.45) | 0 (0.69) | 0 (0.681) | 52 |
| w600k_mbf | 0.495 / 0.614 / 0.714 | 54 (0.50) | 89 (0.45) | 1 (0.71) | 1 (0.702) | 27 |
| SFace raw | 0.556 / 0.677 / 0.762 | 60 (0.55) | 75 (0.52) | 3 (0.72) | 3 (0.711) | 60 |

Against single crops, half of the group (58/114) crosses 0.55 for r50 - these are rejections the engine made against
templates, so by construction they sit just under 0.55 there; the 1-NN over 1,595 crops of the same people is more
permissive, as expected. The candidates behave the same way at their equivalent thresholds (52-60 of 114); SFace
puts the most of them (60) over its line and has the longest tail (max 0.762 vs 0.677), consistent with its wider
impostor distribution. Nothing here says the group is employees or strangers; it says no candidate would make the
door more decisive about them.

### 9.4 Latency (ms per 112 crop, median of 40 runs, 16 real crops, `--cpus 1.5`, host load 10-16)

| model | MB | 1 thread | 2 threads | 4 threads (capped by 1.5 CPUs) | embedding pass, 1,709 crops at 2t |
|---|---|---|---|---|---|
| r50 (FP32, current) | 174.4 | 707 (p95 805) | 506 (552) | 677 (714) | 524 ms/face |
| r50_int8 | 82.5 | 161 (188) | 128 (163) | 203 (282) | 135 ms/face |
| w600k_mbf | 13.6 | 47 (55) | 46 (69) | 88 (99) | 43 ms/face |
| SFace (raw BGR) | 38.7 | 74 (86) | 69 (92) | 103 (174) | 70 ms/face |

Relative order is the result (r50_int8 ~4x, SFace ~8x, mbf ~12x faster than FP32 r50 at 1-2 threads); the absolute
numbers are 2-3x worse than an idle host would give (the 2026-09-27 run measured r50 at ~250 ms/1t with less
contention) and the 4-thread column only shows that 4 threads on 1.5 CPUs thrash.

### 9.5 Detector input size on the ENTRY door (#523): 229 frames of 3840x2160, det_10g FP32, 2 threads, ref 1280

| detect size | faces found (all / >= 60 px) | recall vs 1280 (>= 60 px) | extra | box IoU p50 / min | landmark error % of face p50 / p95 | sizes of missed faces (px) | ms/frame p50 / p95 |
|---|---|---|---|---|---|---|---|
| 640 (today's door scan) | 414 / 379 | 370/385 (96.1 %) | 10 | 0.917 / 0.525 | 3.3 / 10.5 | 62,62,64,64,69,69,69,71,85,89,99,106,106,118,497 | 740 / 908 |
| 960 | 488 / 388 | 381/385 (99.0 %) | 9 | 0.941 / 0.602 | 2.1 / 7.4 | 62,69,69,207 | 1603 / 1790 |
| 1280 (ref) | 507 / 385 | - | - | - | - | - | 2739 / 2946 |
| 2 x 640 tiles, 10 % overlap, NMS 0.4 | 506 / 386 | 381/385 (99.0 %) | 7 | 0.951 / 0.667 | 1.7 / 6.8 | 62,69,85,118 | 1612 / 1774 |

Reading, against the decision rule of section 4 (recall >= 98 % on faces >= 60 px, landmark p95 <= ~3 %):

- 640 on the full 4K frame misses 4 % of the faces >= 60 px that 1280 finds - 15 faces, 11 of them 62-99 px, i.e.
  exactly the far-away faces the door scan is for - and its landmarks sit 3.3 % (p95 10.5 %) off the 1280
  landmarks, which is alignment drift that moves embeddings. It fails both criteria.
- 960 and the two 640 tiles both reach 99 % recall (4 misses each, 62-207 px) with fewer extras than 640.
  The tiles have the better landmarks (p50 1.7 %, p95 6.8 %, IoU min 0.67) because each tile is detected at
  ~2112x2160 -> 640, so a face is seen at roughly 1.9x the pixels of the 640 full-frame pass and ~1.3x that of
  960. Neither meets the 3 % landmark p95 criterion; only 1280 does by definition. The landmark error is measured
  against 1280, so part of it is 1280's own jitter.
- Cost: 960 and the tile pass take the same time (1.6 s per frame at 2 threads under load, ~2.2x the 640 pass);
  1280 takes 3.7x. On the live host at 4 threads these scale down proportionally (the 2026-09-27 numbers put
  1280 at ~1 s end to end).
- Recommendation for #523: run the ENTRY door scan at 960 or as 2 x 640 tiles (the tile pass is a drop-in: same
  640 graph the detector is baked for, no new model metadata, merge = the engine's own NMS rule). Prefer the tiles
  when landmark quality matters (it feeds alignment, hence recognition) and the gap between scans allows ~1.6 s;
  960 when the detector graph must stay a single call. 640 on the full frame should stop being the default for the
  4K ENTRY camera. No 60-px face is ever found by 640 and missed by the tiles.

### 9.6 YuNet: not evaluated, adapter is a follow-up

`face_detection_yunet_2023mar.onnx` is on the host (section 5) but the harness's detector pass goes through the
engine's `detectFaces()` (SCRFD anchors, strides 8/16/32, 5 landmarks in InsightFace order). YuNet has its own
head layout (`cls_8/16/32`, `obj_8/16/32`, `bbox_8/16/32`, `kps_8/16/32`, anchor-free priors per stride, score =
sqrt(cls x obj), landmarks in the order right eye, left eye, nose, right mouth, left mouth) and its own input
contract (raw BGR 0-255, dynamic size). Writing that decoder is roughly half a day plus the time to agree on a
reference other than SCRFD@1280 (its own misses would be scored as YuNet "extras"); it was not worth doing in a
run whose CPU budget was already spent on the frames above. Follow-up, if the owner wants the fully permissive
pair: `scripts/perf/yunetAdapter.ts` (pure decode + NMS, unit-tested on a synthetic output tensor) and a
`--detector yunet=/cand/opencv_zoo/face_detection_yunet_2023mar.onnx` option that feeds the same `detectorAgreement`.

### 9.7 Recommendation

1. Do not switch the recogniser to SFace for accuracy reasons: on this site it keeps about half of r50's genuine
   pairs at equal false-accept rate (46.6 % vs 84.2 % at FAR = 1e-3). If the InsightFace weight term (section 5,
   question 1) is ruled unacceptable, SFace is the permissive fallback and the price is this table; AdaFace /
   EdgeFace would need the same run before being preferred, and their terms are not better than InsightFace's.
2. `r50_int8` is the only candidate that passes the accuracy rule (drift 0.01, d' equal, thresholds unchanged) and
   is 4x faster; it needs its own tag and templates, as already planned (2026-09-27), not a threshold change.
3. #523: move the 4K ENTRY door scan off the 640 full-frame letterbox - 96 % recall and 3.3 % landmark error against
   1280 - to 960 or to 2 x 640 tiles (99 % recall, best landmarks, 1.6 s per frame at 2 threads under load).
4. Owner: review the four employee-id pairs of the label-defect radar (section 9.2); they are either duplicate
   records or repeated false accepts, and they set the FAR = 0 numbers for every model.
5. Follow-ups for the harness: "good enough" rule relative to the reference's false accepts; a YuNet adapter if the
   permissive pair stays on the table; re-run with `--exclude` once the duplicates are resolved.

### 9.8 Data handling (what was created and deleted)

Created, all under the session scratchpad with mode 0700 / files 0600: JPEG exports (1,118 + 684 GRANTED, 115
DENIED, 229 frames), 1,709 aligned 112x112 crops, the two reports. Deleted at the end of the run: every JPEG
export (each batch right after cropping), the crop directory, the frame directory. Kept: `engine-compare.json`
and `engine-compare.md` (aggregates only, `assertNoVectors` enforced), the harness log without pixel data, this
section. Nothing was written to the database or the repository besides this document and the harness code. The
OpenCV Zoo files stay in `/data/models/candidates/opencv_zoo/` (model weights, not biometric data).

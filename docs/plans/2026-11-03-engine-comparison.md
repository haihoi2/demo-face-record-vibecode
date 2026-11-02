# Engine comparison harness: a model switch is a measured decision

Status: TOOLING (Taiga #513; detector input size feeds #523). 2026-11-03. Nothing in production changes.
`server.ts touched: no`. No new weights were downloaded for this task; the harness was validated with the two
models on the host and a synthetic (non-biometric) crop set.

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
| OpenCV Zoo YuNet (detector) + SFace (recogniser) | opencv_zoo: Apache-2.0 | ONNX files in opencv_zoo listed as Apache-2.0 - cần kiểm tra the per-model LICENSE in the zoo folders | YuNet: WIDER FACE; SFace: training set not stated in the zoo README - cần kiểm tra (paper uses MS1M-style data) | ok to evaluate; the only candidate pair whose weights are stated under a permissive licence - verify before relying on it. SFace: 112x112, 128-D, BGR, OpenCV feeds uint8 without mean/std (mean=0,std=1) - cần kiểm tra; YuNet is not SCRFD (different anchors/outputs) so the detector part of the harness does NOT cover it without engine work |
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

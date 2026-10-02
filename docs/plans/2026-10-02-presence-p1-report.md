# P1 report: person detector for presence alerts (offline evaluation)

Date: 2026-10-02. Author: face-engine agent. Branch `eval/presence-p1`. Plan: `docs/plans/2026-10-02-person-presence-alerts.md` (phase P1).

Status:
- **ENTRY:** done, on limited footage.
- **Night (lights off):** false alarms done (15 min of stills per gate); recall not done.
- **EXIT:** not done.

Nothing in the running system was changed.

## 1. Answer first

**Recommended detector: RTMDet-tiny (OpenMMLab), whole picture scaled to 960 px wide (960x544 input), person score threshold 0.30, 2 frames/s, one inference thread.**

**Condition:** RTMDet's weight licence must be confirmed in writing first. The code is Apache-2.0, but the weight file on OpenMMLab's download server carries no licence statement of its own. Under the owner's free-licence rule it is "licence unconfirmed" until then.

On the real entry footage (21 clips, 8.2 min, 23 Sep - 2 Oct, day and evening, lights on) RTMDet-tiny at 960 / 0.30:
- saw **10 of 10 people who walked through** the picture for at least 3 s;
- saw **25 of 48 people (52 %)** in view for at least 3 s when counting everyone. Most misses are workers standing half hidden behind the cage bars far away.
- raised **no false alarm** of 3 s or more:
  - in the 8.2 min of footage (a weak bound: one episode here = 7.3/h);
  - on 15 min of lights-off IR stills at either gate.
- kept the same threshold when two new clips were added. Its scores on clutter stay below its scores on people.

**Cost:** 620 ms per frame on one thread, p95 696 (onnxruntime-node 1.30, this host). That is about **1.2 cores per gate at 2 frames/s**; it cannot sustain 4 frames/s on one or two threads. The model file is 22 MB.

**Licence-clean, low-CPU alternative (use until the RTMDet licence is confirmed, or if 1.2 cores per gate cannot be spared):** **YOLOX-Nano (Megvii, Apache-2.0 code and weights), 960x544, threshold 0.55**:
- 8/10 walkers and 13/48 people, no false alarms, 152 ms per frame on one thread (0.3 core per gate at 2 frames/s, 3.7 MB);
- its threshold is fragile: it scores clutter in the same range as half-hidden people. On the first 19 clips 0.20 was false-alarm-free (17/40 people, 8/8 walkers); two more clips with a bag and a bottle on the cabinet pushed it to 0.55;
- with per-gate exclusion masks on known clutter spots it could run near 0.30 (17/48, 8/10).

**Not recommended:**
- RT-DETR-R18: 1.8 s per frame, and a persistent false person on a backpack.
- RF-DETR-Nano: 1.0 s per frame, and weaker here.
- YOLOX-Tiny: costs as much as RTMDet-tiny at the same size (581 ms at 960) but finds fewer people.
- EfficientDet-Lite2: weakest on far people, 328 ms, weight licence unconfirmed.
- EfficientDet-Lite0: its ONNX conversion does not load in onnxruntime-node 1.30.

**P2 should build the presence worker against the common ONNX contract used here** (one image in, `[1,N,5]` person boxes out, NMS in Node.js). Then YOLOX-Nano can ship first in shadow and RTMDet-tiny can be swapped in by changing the model file and the threshold.

Three things matter more than the model choice. Section 6 explains each:
1. **Input size beats model family.** At the usual 640 px every model misses most people at the entry: they are about 25 px tall at that scale and behind bars.
2. **CPU is the hard limit on this host.** P1 jobs using 4-6 cores starved the live camera streams on 2026-10-02.
3. **Whole picture plus 3 s plus all hours (decided) will alert on the workers** who stand in view behind the cages during working hours. The 3 s rule does not filter them. This is for the shadow phase to quantify (section 6).

## 2. What was measured

**Footage (biometric; stayed on this host under `/data/test-clips`, mode 0700; frames, crops and contact sheets deleted after the run):**
- **ENTRY, real (primary).** 21 clips, 8.2 min, 9 day and 12 evening with the lights on:
  - the 19 NVR entry clips of `/data/test-clips/candidates.json` (23-26 Sep, 15-20 s each);
  - two 70 s evening clips INT exported on 2 Oct (12:46:50Z and 13:11:40Z).
- **ENTRY and EXIT, night, lights off (false alarms only).** INT's 105 IR stills per gate, one every 9 s, 2 Oct 14:55-15:10Z. Person-free (checked by eye).
- **ENTRY, scripted (sanity only).** `entry-sequence.mp4` (1000 s) and `entry-empty.mp4` (100 s).
  - These are **synthetic**: head-and-shoulder face tiles pasted on a flat colour gradient, on screen about 4 s per passage.
  - They are useful for the face engine but say little about a body detector, and the "empty" clips are a plain gradient.
- **EXIT with people:** not evaluated (section 8).

**Sampling.** 4 frames/s, as planned for the presence thread. NVR frames were kept 1920 px wide (the entry camera is 4K; FFmpeg scaled it down). FFmpeg then scaled them to each model's input, as the production stream would.

**Ground truth (person boxes per frame).** Grounding DINO alone was too slow on this CPU (20-37 s per frame), so the labels were pooled:
1. **Grounding DINO base (Apache-2.0), offline only:** the independent reference. Labelled at 1 frame/s (9 clips), 0.5 frame/s (10 clips) and 0.25 frame/s (the 2 new clips).
2. **Pooling:** every candidate's whole-picture detections at score ≥ 0.3 (all inputs), plus the Grounding DINO boxes, linked into tracks (325 tracks).
3. **Review by eye:**
   - every track of 1 s or more, and every short track proposed as a person, was checked on contact sheets (169 tracks);
   - 21 proposals were corrected: 9 objects proposed as people and 12 real people that had been proposed as "no";
   - the objects were a backpack (4 clips), an office chair, a pallet jack, a patterned bag, and 2 Grounding DINO-only shapes;
   - the 6 clips with no person track were checked by eye: 011, 016, 021 and 022 on 0.5 frame/s contact sheets (016 and 021 also with full-resolution crops of the far area); 012 and 017 at Grounding DINO's boxes only.
4. **Result:** 111 person tracks; 48 people in view ≥ 3 s, 81 ≥ 1 s, 10 of whom walk through the picture (box centre moves ≥ 5 % of the width).
   - People far away, seen from the back, or half hidden behind cage bars **count as present**.
   - Gaps inside a person track (every source missed) are filled, because the person was still there.
5. **Bias.** The pool comes from the candidates themselves, so a person missed by every candidate and by Grounding DINO is missing from the truth too.

**Weak labels are not ground truth.**
- In 6 of the 19 original entry clips the access log counted 2-7 people, but **nobody is visible**: the camera does not cover where they were, or the log time does not match the video.
- The clip the log calls "empty" (051) shows a security guard and three other people.
- **INT's 12:46:50Z clip:** the face shadow engine logged 3 person tracks at 12:47:06-24Z, but **I found nobody in view**:
  - checked by eye (the whole window at 1 frame/s, and full-resolution crops of the far left, the conveyor and the cages);
  - no candidate at 0.3, and Grounding DINO found nobody either.
  - It counts as person-free here. **INT should check those 3 tracks:** they may be false face tracks. One candidate source is the bag with printed cartoon faces on the bench.

**Metrics** (definitions in `tools/presence-eval/score.py`):
- **Person recall ≥ 3 s (primary):** share of ground-truth people in view ≥ 3 s whom the model itself detects for ≥ 3 s (IoU ≥ 0.3, gaps ≤ 0.5 s bridged). One detected person does not cover for another.
- **Walking-through recall:** the same, for people walking through.
- **Passage recall ≥ 3 s / ≥ 1 s (as asked):** a clip counts if the model sees any person for ≥ 3 s / 1 s inside it. A worker standing in the background makes this easy, which is why person recall is primary.
- **False alarms/h:** episodes ≥ 3 s made only of detections that match no person, per hour of footage.
- **ms/frame:** `session.run` only, in onnxruntime-node 1.30 inside the repo's tester image. 200 frames after 10 warm-up frames, intra-op threads 1 and 2, `--cpus 2.5`, nice 19. The host was busy (live gateway plus another project, load 8-20), so expect 10-30 % jitter.
- **Overlay mask:** detections lying mostly on the camera's on-screen clock and logo are dropped. That is a fixed mask, trivial in production. Unmasked numbers are in the appendix.

**Operating threshold** per model: the lowest score threshold that gives the best person recall ≥ 3 s among the thresholds with no false-alarm episode on this footage. The full sweep is in section 4.

## 3. Candidates: source, version, licence

| Model | Source used (exact) | Version / commit | Licence: code | Licence: weights |
|---|---|---|---|---|
| YOLOX-Nano | weights `github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.pth` (sha256 `cd28f55f…feff7b`) | code `Megvii-BaseDetection/YOLOX@6ddff48` | Apache-2.0 (repo LICENSE) | Apache-2.0: release asset of the same repository |
| YOLOX-Tiny | `…/0.1.1rc0/yolox_tiny.pth` (sha256 `9de513de…aee8f0`) | same | Apache-2.0 | Apache-2.0: release asset of the same repository |
| RTMDet-tiny | `download.openmmlab.com/mmdetection/v3.0/rtmdet/rtmdet_tiny_8xb32-300e_coco/rtmdet_tiny_8xb32-300e_coco_20220902_112414-78e30dcc.pth` (sha256 `78e30dcc…54a7fb`) | mmdetection 3.3.0, mmcv 2.1.0, mmengine 0.10.4 (PyPI) | Apache-2.0 | **licence unconfirmed**: hosted on OpenMMLab's server and linked from the Apache-2.0 model zoo, but no licence statement for the weight files |
| EfficientDet-Lite0 / Lite2 (MediaPipe) | `storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite{0,2}/float32/1/…tflite` (sha256 `40338edf…` / `ad2abbf2…`) | MediaPipe model version 1; tf2onnx 1.16.1, TF 2.15.1; anchors from the model's `DETECTOR_METADATA` (mediapipe 0.10.14) | Apache-2.0 (MediaPipe) | **licence unconfirmed**: no licence in the model metadata or the storage bucket. The MediaPipe page states CC-BY-4.0 for page content and Apache-2.0 for code samples only |
| RT-DETR-R18 (Baidu, official) | `github.com/lyuwenyu/storage/releases/download/v0.1/rtdetr_r18vd_dec3_6x_coco_from_paddle.pth` (sha256 `3ba8b5c9…66f0`), linked from the official repo's README | code `lyuwenyu/RT-DETR@29320b6` (its `rtdetrv2_pytorch` tree, v1 R18 config). **Not** the AGPL Ultralytics packaging | Apache-2.0 | **licence unconfirmed**: separate storage repository without a LICENSE file (converted from PaddleDetection weights, which are Apache-2.0) |
| RF-DETR-Nano | `storage.googleapis.com/rfdetr/nano_coco/checkpoint_best_regular.pth` (md5 `fb6504cc…` pinned by the package; sha256 `d8d6b9ee…`) | `rfdetr==1.11.1` (repo `roboflow/rf-detr@8913f7b`) | Apache-2.0 | Apache-2.0: the README licence table lists RF-DETR-N as Apache 2.0 (only XL/2XL are PML 1.0; not used) |
| Grounding DINO base (labels only, never deployed) | HF `IDEA-Research/grounding-dino-base@12bdfa3` | transformers 5.18.0 | Apache-2.0 | Apache-2.0 (model card) |

All detectors are COCO-trained (images under Flickr terms). That is common to every candidate and not a differentiator.

**Conversions.** Every ONNX file follows one contract: one image in, `[1,N,5]` person boxes out (x1, y1, x2, y2 in input pixels, person score), NMS done by the caller. Each was checked against its reference implementation:
- YOLOX: PyTorch, ≤ 0.0013 px at 4 input shapes.
- RTMDet: mmdet's own inference, same box within 0.1 px and same score.
- EfficientDet: MediaPipe's own ObjectDetector, within 1.3 px and same score.
- RT-DETR: PyTorch, 0.06 px.
- RF-DETR: the package's own export plus our tail, exact.

EfficientDet-Lite0 runs in onnxruntime 1.19 (Python), but **onnxruntime-node 1.30 refuses to load it**: shape inference fails on an FPN `Add` node. Dropping the stale shape annotations did not help, and it was not forced further. Lite2, same family and larger, is measured.

## 4. Results: ENTRY, real footage, whole picture (primary)

Overlays masked. 8.2 min of real entry video; one false-alarm episode equals 7.3/h.

Without the mask, the operating points on this footage are identical (raw table in the appendix): the 2 Oct clutter, not the OSD digits, sets YOLOX's thresholds. On the first 19 clips alone, the OSD digits had pushed YOLOX-Nano 960 from 0.20 to 0.25.

| Model | Input | Licence code / weights | Thr | Person recall >=3 s | Walking-through recall >=3 s | Person recall >=1 s | Passage recall >=3 s | Passage recall >=1 s | False alarms/h (episodes) | Box recall | ms/frame 1 thr mean / p95 | ms/frame 2 thr mean / p95 | Size MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| efficientdet-lite2 | 448x448 | Apache-2.0 / unconfirmed | 0.25 | 13/48 (27%) | 8/10 (80%) | 29/81 (36%) | 9/14 (64%) | 11/14 (79%) | 0.0 (0) | 35% | 328 / 414 | 206 / 295 | 22.9 |
| rfdetr-nano | 384x384 | Apache-2.0 / Apache-2.0 | 0.3 | 14/48 (29%) | 8/10 (80%) | 34/81 (42%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 39% | 1025 / 1134 | 677 / 935 | 107.8 |
| rtdetr-r18 | 640x640 | Apache-2.0 / unconfirmed | 0.45 | 16/48 (33%) | 9/10 (90%) | 32/81 (40%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 39% | 1772 / 1912 | 1061 / 1277 | 80.4 |
| rtmdet-tiny | 1280x736 | Apache-2.0 / unconfirmed | 0.35 | 23/48 (48%) | 10/10 (100%) | 49/81 (60%) | 12/14 (86%) | 13/14 (93%) | 0.0 (0) | 57% | 1157 / 1345 | 718 / 1093 | 22.3 |
| rtmdet-tiny | 416x256 | Apache-2.0 / unconfirmed | 0.4 | 10/48 (21%) | 8/10 (80%) | 18/81 (22%) | 6/14 (43%) | 7/14 (50%) | 0.0 (0) | 26% | 128 / 152 | 77 / 104 | 22.3 |
| rtmdet-tiny | 640x384 | Apache-2.0 / unconfirmed | 0.35 | 16/48 (33%) | 9/10 (90%) | 31/81 (38%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 41% | 290 / 324 | 167 / 216 | 22.3 |
| rtmdet-tiny | 960x544 | Apache-2.0 / unconfirmed | 0.3 | 25/48 (52%) | 10/10 (100%) | 52/81 (64%) | 11/14 (79%) | 12/14 (86%) | 0.0 (0) | 61% | 620 / 696 | 366 / 497 | 22.3 |
| yolox-nano | 1280x736 | Apache-2.0 / Apache-2.0 | 0.6 | 15/48 (31%) | 9/10 (90%) | 26/81 (32%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 34% | 283 / 320 | 175 / 222 | 3.7 |
| yolox-nano | 640x384 | Apache-2.0 / Apache-2.0 | 0.4 | 10/48 (21%) | 8/10 (80%) | 24/81 (30%) | 8/14 (57%) | 11/14 (79%) | 0.0 (0) | 29% | 70 / 86 | 51 / 77 | 3.7 |
| yolox-nano | 960x544 | Apache-2.0 / Apache-2.0 | 0.55 | 13/48 (27%) | 8/10 (80%) | 27/81 (33%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 33% | 152 / 177 | 100 / 129 | 3.7 |
| yolox-nano | 416x256 | Apache-2.0 / Apache-2.0 | 0.65 | 7/48 (15%) | 7/10 (70%) | 9/81 (11%) | 6/14 (43%) | 6/14 (43%) | 0.0 (0) | 17% | 31 / 40 | 28 / 52 | 3.7 |
| yolox-tiny | 1280x736 | Apache-2.0 / Apache-2.0 | 0.4 | 18/48 (38%) | 10/10 (100%) | 41/81 (51%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 47% | 1055 / 1139 | 606 / 692 | 20.3 |
| yolox-tiny | 640x384 | Apache-2.0 / Apache-2.0 | 0.6 | 10/48 (21%) | 8/10 (80%) | 21/81 (26%) | 8/14 (57%) | 11/14 (79%) | 0.0 (0) | 28% | 273 / 305 | 161 / 225 | 20.3 |
| yolox-tiny | 960x544 | Apache-2.0 / Apache-2.0 | 0.5 | 17/48 (35%) | 10/10 (100%) | 33/81 (41%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 41% | 581 / 640 | 334 / 383 | 20.3 |
| yolox-tiny | 416x256 | Apache-2.0 / Apache-2.0 | 0.6 | 9/48 (19%) | 8/10 (80%) | 12/81 (15%) | 6/14 (43%) | 7/14 (50%) | 0.0 (0) | 21% | 117 / 137 | 77 / 107 | 20.3 |

**Sweep** (person recall ≥ 3 s / walking-through recall ≥ 3 s / false alarms per hour). It shows the trade-off below each operating point: lower thresholds find more half-hidden people and start alerting on static clutter. False alarms per hour can rise with the threshold (YOLOX-Nano 960: 29/h at 0.35, 88/h at 0.40) when one long false episode breaks into several shorter ones.

| Model | Input | t=0.15 person R3 / walking R3 / FA/h | t=0.2 person R3 / walking R3 / FA/h | t=0.25 person R3 / walking R3 / FA/h | t=0.3 person R3 / walking R3 / FA/h | t=0.35 person R3 / walking R3 / FA/h | t=0.4 person R3 / walking R3 / FA/h | t=0.5 person R3 / walking R3 / FA/h | t=0.6 person R3 / walking R3 / FA/h |
|---|---|---|---|---|---|---|---|---|---|
| efficientdet-lite2 | 448x448 | 22/48 / 9/10 / 59 | 17/48 / 9/10 / 29 | 13/48 / 8/10 / 0 | 12/48 / 8/10 / 0 | 10/48 / 8/10 / 0 | 10/48 / 8/10 / 0 | 9/48 / 8/10 / 0 | 8/48 / 8/10 / 0 |
| rfdetr-nano | 384x384 | 24/48 / 10/10 / 103 | 21/48 / 9/10 / 37 | 17/48 / 9/10 / 22 | 14/48 / 8/10 / 0 | 14/48 / 8/10 / 0 | 13/48 / 8/10 / 0 | 10/48 / 8/10 / 0 | 9/48 / 8/10 / 0 |
| rtdetr-r18 | 640x640 | 28/48 / 10/10 / 125 | 25/48 / 10/10 / 103 | 23/48 / 10/10 / 66 | 20/48 / 10/10 / 59 | 18/48 / 9/10 / 59 | 16/48 / 9/10 / 15 | 13/48 / 9/10 / 0 | 9/48 / 8/10 / 0 |
| rtmdet-tiny | 1280x736 | 45/48 / 10/10 / 198 | 40/48 / 10/10 / 191 | 33/48 / 10/10 / 103 | 29/48 / 10/10 / 7 | 23/48 / 10/10 / 0 | 19/48 / 10/10 / 0 | 14/48 / 9/10 / 0 | 11/48 / 8/10 / 0 |
| rtmdet-tiny | 416x256 | 25/48 / 9/10 / 184 | 20/48 / 8/10 / 73 | 16/48 / 8/10 / 59 | 12/48 / 8/10 / 37 | 11/48 / 8/10 / 51 | 10/48 / 8/10 / 0 | 9/48 / 8/10 / 0 | 6/48 / 6/10 / 0 |
| rtmdet-tiny | 640x384 | 31/48 / 10/10 / 169 | 29/48 / 10/10 / 110 | 23/48 / 10/10 / 51 | 19/48 / 9/10 / 22 | 16/48 / 9/10 / 0 | 11/48 / 8/10 / 0 | 9/48 / 8/10 / 0 | 9/48 / 8/10 / 0 |
| rtmdet-tiny | 960x544 | 37/48 / 10/10 / 191 | 33/48 / 10/10 / 96 | 29/48 / 10/10 / 51 | 25/48 / 10/10 / 0 | 20/48 / 10/10 / 0 | 19/48 / 10/10 / 0 | 12/48 / 8/10 / 0 | 9/48 / 8/10 / 0 |
| yolox-nano | 1280x736 | 22/48 / 10/10 / 66 | 21/48 / 10/10 / 51 | 20/48 / 10/10 / 51 | 19/48 / 10/10 / 44 | 19/48 / 10/10 / 59 | 18/48 / 10/10 / 51 | 17/48 / 10/10 / 7 | 15/48 / 9/10 / 0 |
| yolox-nano | 640x384 | 20/48 / 9/10 / 22 | 16/48 / 9/10 / 15 | 14/48 / 8/10 / 7 | 14/48 / 8/10 / 7 | 13/48 / 8/10 / 7 | 10/48 / 8/10 / 0 | 9/48 / 8/10 / 0 | 9/48 / 8/10 / 0 |
| yolox-nano | 960x544 | 21/48 / 10/10 / 22 | 20/48 / 10/10 / 15 | 18/48 / 9/10 / 15 | 17/48 / 8/10 / 22 | 17/48 / 8/10 / 29 | 16/48 / 8/10 / 88 | 13/48 / 8/10 / 7 | 13/48 / 8/10 / 0 |
| yolox-nano | 416x256 | 12/48 / 8/10 / 44 | 12/48 / 8/10 / 37 | 10/48 / 8/10 / 44 | 9/48 / 8/10 / 44 | 8/48 / 8/10 / 29 | 8/48 / 8/10 / 22 | 8/48 / 8/10 / 7 | 8/48 / 8/10 / 51 |
| yolox-tiny | 1280x736 | 25/48 / 10/10 / 81 | 24/48 / 10/10 / 59 | 21/48 / 10/10 / 51 | 20/48 / 10/10 / 37 | 19/48 / 10/10 / 7 | 18/48 / 10/10 / 0 | 18/48 / 10/10 / 0 | 17/48 / 10/10 / 0 |
| yolox-tiny | 640x384 | 21/48 / 9/10 / 81 | 19/48 / 9/10 / 59 | 19/48 / 9/10 / 29 | 17/48 / 9/10 / 29 | 17/48 / 9/10 / 44 | 16/48 / 9/10 / 44 | 15/48 / 9/10 / 29 | 10/48 / 8/10 / 0 |
| yolox-tiny | 960x544 | 23/48 / 10/10 / 37 | 21/48 / 10/10 / 51 | 20/48 / 10/10 / 37 | 19/48 / 10/10 / 15 | 18/48 / 10/10 / 7 | 17/48 / 10/10 / 7 | 17/48 / 10/10 / 0 | 17/48 / 10/10 / 0 |
| yolox-tiny | 416x256 | 14/48 / 8/10 / 66 | 13/48 / 8/10 / 51 | 13/48 / 8/10 / 44 | 12/48 / 8/10 / 44 | 10/48 / 8/10 / 44 | 10/48 / 8/10 / 44 | 9/48 / 8/10 / 22 | 9/48 / 8/10 / 0 |

**Night, lights off (false alarms only).** 105 IR stills per gate, one every 9 s, 2 Oct 14:55-15:10Z (21:55-22:10 local), person-free.
- **No model produced a single false still at its operating threshold, at either gate.**
- Detections just below the thresholds were all objects:
  - RTMDet-tiny 960/1280 at 0.20: a dark round object on the cabinet next to the IR lamp glare, on 90-97 of the 105 entry stills;
  - YOLOX-Nano 1280 at 0.30: a water bottle on the bench;
  - RT-DETR-R18 at 0.15-0.17: the edge of a shelf.
- **Caveat:** these are stills, not a stream. Read as a stream at one frame per 9 s, every false still would have been a ≥ 3 s alert, and a detection that flickers between stills is invisible.
- **Not measured:** night recall. No lights-off footage with people exists yet.

| Model | Input | Entry op thr | ENTRY FP stills / runs @op | EXIT FP stills / runs @op | ENTRY / EXIT FP stills @0.2 | ENTRY / EXIT FP stills @0.3 | ENTRY / EXIT FP stills @0.4 |
|---|---|---|---|---|---|---|---|
| efficientdet-lite2 | 448x448 | 0.25 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| rfdetr-nano | 384x384 | 0.3 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| rtdetr-r18 | 640x640 | 0.45 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| rtmdet-tiny | 1280x736 | 0.35 | 0/105 / 0 | 0/105 / 0 | 90 / 0 | 0 / 0 | 0 / 0 |
| rtmdet-tiny | 416x256 | 0.4 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| rtmdet-tiny | 640x384 | 0.35 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| rtmdet-tiny | 960x544 | 0.3 | 0/105 / 0 | 0/105 / 0 | 97 / 0 | 0 / 0 | 0 / 0 |
| yolox-nano | 1280x736 | 0.6 | 0/105 / 0 | 0/105 / 0 | 1 / 0 | 1 / 0 | 0 / 0 |
| yolox-nano | 640x384 | 0.4 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-nano | 960x544 | 0.55 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-nano | 416x256 | 0.65 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-tiny | 1280x736 | 0.4 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-tiny | 640x384 | 0.6 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-tiny | 960x544 | 0.5 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| yolox-tiny | 416x256 | 0.6 | 0/105 / 0 | 0/105 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

**Gate area (secondary).** Two ways were tested:
- crop the live entry gate area (x 363, y 792, w 3408, h 456 of 3840x2160) and detect;
- detect on the whole picture and keep boxes inside the area.

Results, for people inside the gate area (40 people ≥ 3 s, 21 clips):
- **Best:** whole picture at 960 px, keeping boxes in the area (RTMDet-tiny 21/40). The owner's whole-picture decision loses nothing.
- **At equal CPU,** a gate-area crop scaled to 1280 px wide is as good as or better than the whole picture at 640 px restricted to the area:
  - RTMDet-tiny 17 vs 14;
  - YOLOX-Tiny 14 vs 8;
  - YOLOX-Nano 16 vs 16.
- **Cheapest useful setting** if the owner later chooses a zone instead of the whole picture: a YOLOX-Nano gate crop at 1280x192, 16/40 for 70 ms per frame on one thread.

| Model | Input | How | Thr | Person recall >=3 s | Passage recall >=3 s | Passage recall >=1 s | False alarms/h (episodes) | ms/frame 1 / 2 thr (mean) |
|---|---|---|---|---|---|---|---|---|
| efficientdet-lite2 | 448x448 | detect full, keep boxes in area | 0.25 | 11/40 (28%) | 9/14 (64%) | 11/14 (79%) | 0.0 (0) | 328 / 206 |
| rfdetr-nano | 384x384 | detect full, keep boxes in area | 0.3 | 12/40 (30%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 1025 / 677 |
| rtdetr-r18 | 640x640 | detect full, keep boxes in area | 0.4 | 15/40 (38%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 1772 / 1061 |
| rtmdet-tiny | 1280x736 | detect full, keep boxes in area | 0.35 | 20/40 (50%) | 12/14 (86%) | 13/14 (93%) | 0.0 (0) | 1157 / 718 |
| rtmdet-tiny | 1280x192 | crop then detect | 0.4 | 17/40 (42%) | 12/14 (86%) | 12/14 (86%) | 0.0 (0) | 309 / 224 |
| rtmdet-tiny | 416x256 | detect full, keep boxes in area | 0.25 | 10/40 (25%) | 8/14 (57%) | 9/14 (64%) | 0.0 (0) | 128 / 77 |
| rtmdet-tiny | 416x64 | crop then detect | 0.35 | 10/40 (25%) | 9/14 (64%) | 11/14 (79%) | 0.0 (0) | - / - |
| rtmdet-tiny | 640x384 | detect full, keep boxes in area | 0.35 | 14/40 (35%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 290 / 167 |
| rtmdet-tiny | 640x96 | crop then detect | 0.4 | 12/40 (30%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | - / - |
| rtmdet-tiny | 960x544 | detect full, keep boxes in area | 0.3 | 21/40 (52%) | 11/14 (79%) | 12/14 (86%) | 0.0 (0) | 620 / 366 |
| rtmdet-tiny | 960x160 | crop then detect | 0.4 | 13/40 (32%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | - / - |
| yolox-nano | 1280x736 | detect full, keep boxes in area | 0.6 | 12/40 (30%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 283 / 175 |
| yolox-nano | 1280x192 | crop then detect | 0.45 | 16/40 (40%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 70 / 47 |
| yolox-nano | 640x384 | detect full, keep boxes in area | 0.15 | 16/40 (40%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 70 / 51 |
| yolox-nano | 640x96 | crop then detect | 0.4 | 11/40 (28%) | 9/14 (64%) | 10/14 (71%) | 0.0 (0) | - / - |
| yolox-nano | 960x544 | detect full, keep boxes in area | 0.5 | 11/40 (28%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 152 / 100 |
| yolox-nano | 960x160 | crop then detect | 0.35 | 14/40 (35%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | - / - |
| yolox-nano | 416x256 | detect full, keep boxes in area | 0.25 | 7/40 (18%) | 6/14 (43%) | 8/14 (57%) | 0.0 (0) | 31 / 28 |
| yolox-nano | 416x64 | crop then detect | 0.25 | 6/40 (15%) | 7/14 (50%) | 9/14 (64%) | 0.0 (0) | - / - |
| yolox-tiny | 1280x736 | detect full, keep boxes in area | 0.4 | 16/40 (40%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 1055 / 606 |
| yolox-tiny | 1280x192 | crop then detect | 0.6 | 14/40 (35%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 267 / 158 |
| yolox-tiny | 640x384 | detect full, keep boxes in area | 0.6 | 8/40 (20%) | 8/14 (57%) | 11/14 (79%) | 0.0 (0) | 273 / 161 |
| yolox-tiny | 640x96 | crop then detect | 0.65 | 10/40 (25%) | 10/14 (71%) | 10/14 (71%) | 0.0 (0) | - / - |
| yolox-tiny | 960x544 | detect full, keep boxes in area | 0.2 | 17/40 (42%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 581 / 334 |
| yolox-tiny | 960x160 | crop then detect | 0.45 | 14/40 (35%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | - / - |
| yolox-tiny | 416x256 | detect full, keep boxes in area | 0.35 | 8/40 (20%) | 7/14 (50%) | 10/14 (71%) | 0.0 (0) | 117 / 77 |
| yolox-tiny | 416x64 | crop then detect | 0.35 | 8/40 (20%) | 7/14 (50%) | 9/14 (64%) | 0.0 (0) | - / - |

**Scripted synthetic set (sanity only; RT-DETR and RF-DETR not run on it, to save CPU).** At threshold 0.3 no model raised a false alarm on the flat gradient. Recall ≥ 3 s on the 4 s face tiles ranged from 0/24 (YOLOX-Nano 416) to 20/24 (RTMDet-tiny 640, EfficientDet-Lite2). These numbers mostly reflect how well a model fires on a pasted head-and-shoulders tile; they do not reflect real people.

## 5. Failure cases (descriptions, no images)

**Misses: standing people behind the cage bars.**
- At the entry, workers stand at a bench far back, behind two rows of steel cages. They are about 70-90 px tall in a 1920 px frame, cut into strips by the bars, and often bent over.
- At 640 px input they are about 25 px tall, and every model misses most of them.
- These are most of the misses for every model.
- INT's hard case is in the 13:11:40Z clip: a person behind the cages at the conveyor around 13:12:18Z.
  - RTMDet-tiny sees them in 15 of 37 frames at 1280 and 8 of 37 at 960 (threshold 0.3);
  - YOLOX-Nano 960 sees them in 2 of 37 frames, even at 0.2.

**Misses: people walking through.** Fine for RTMDet-tiny and YOLOX-Tiny at 960 px and above (10/10). At their zero-false-alarm thresholds, YOLOX-Nano 960, RF-DETR-Nano and EfficientDet-Lite2 lose 2 of 10 and RT-DETR-R18 loses 1. Examples of the walkers missed:
- a woman in a light top and jeans crossing the open floor at the back (evening);
- a man in a cap working his way along the box stacks, mostly hidden by them (evening).

**False people: static clutter.** Each would raise a long or repeated alert:
- A black backpack hanging on the orange bench, bottom-left, in the evening clips:
  - RT-DETR-R18 scores it up to 0.54 (above 0.3 in 80 % of those frames);
  - YOLOX-Nano and YOLOX-Tiny at 416 px take it for a person (0.52-0.54);
  - at 640 px and above YOLOX stays below 0.15, and RTMDet-tiny stays at or below 0.21 at every size.
- A red basket with a bottle and a black bag on top of the grey cabinet (2 Oct clips). YOLOX-Nano 960 scores it 0.38-0.48 in every frame, which is what pushed its threshold to 0.55.
- A cartoon-patterned bag with bottles on the bench (2 Oct).
- An empty black office chair.
- A red pallet truck with boxes (4 models, whole clip).
- Steel cages full of boxes.
- A blue bin.
- The OSD date digits at the bottom-left (YOLOX at 960 px); fixed by the overlay mask.

**Light.**
- Evening clips with the lights on are not harder than day clips: RTMDet-tiny 960 passage recall day 3/5, evening 8/9; the day misses are standing workers.
- One morning clip (012) is in grey IR mode. Nobody is in it, and no model raised a false alarm on it at its operating threshold.
- Lights-off night: no false alarms at the operating thresholds (section 4). Recall with lights off is untested.

**Weak labels.** 6 of 19 "people" clips show nobody at all (section 2). Without image-checked ground truth these would have counted as misses for every model.

## 6. Recommendation and trade-offs

1. **Detector: RTMDet-tiny, 960x544 whole picture, threshold 0.30, 2 frames/s, 1 intra-op thread, overlay mask.** Condition: written confirmation of the weight licence.
   - Best person recall at zero false alarms in every set (25/48, 10/10 walking through).
   - Its zero-false-alarm threshold held at 0.30 when the 2 Oct clips were added. YOLOX-Nano 960's moved from 0.20 to 0.55. RT-DETR, RF-DETR and Lite2 also held, but they find far fewer people.
   - At 1280 it gains little (23/48 at its threshold 0.35) for nearly twice the CPU.
2. **Until then, or if CPU is short: YOLOX-Nano, 960x544, threshold 0.55.**
   - Apache-2.0 code and weights, 152 ms/frame on 1 thread, 3.7 MB.
   - Finds fewer hidden people (13/48) and 8/10 walkers.
   - With operator-drawn exclusion masks on clutter spots (bench, cabinet top) it can run lower: about 0.30 gave 17/48 and 8/10, with only the clutter as false alarms.
3. **Why not lower thresholds.** Below about 0.25-0.30 every model starts to call static clutter a person for whole clips: RTMDet-tiny 1280 at 0.20 finds 40/48 people, but has 26 false episodes in 8.2 min.
   - A per-gate mask of known false spots (from the operator label "báo nhầm") would allow lower thresholds.
   - A rule that ignores never-moving tracks would not help: it would also hide a person standing still, which is exactly the hard case here.
4. **CPU.** The presence thread must stay small:
   - The live gateway already uses 6-7.6 cores, and the host had no headroom.
   - P1 jobs of 4-6 cores dropped both live streams from 8 to about 1.5 frames/s with 17 reconnects, even at reduced CPU shares. INT then capped P1 at 2.5 CPUs and nice 19.
   - RTMDet-tiny 960 at 2 frames/s is about 1.2 cores per gate; that is about the whole P1 budget for the entry alone.
   - P2 should run the detector at 1 intra-op thread and nice 19, at 2 frames/s (the 3 s rule still has 6 frames). It could also skip frames when the existing gate motion check sees nothing.
   - Measure the live streams' fps in shadow before switching alerts on.
   - YOLOX-Nano 960 at 2 frames/s is about 0.3 core per gate.
5. **3 s rule, whole picture, all hours (owner decisions 3 and 4).** The plan expects the 3 s rule to filter passers-by. At the entry, though, workers stand in view behind the cages for whole clips during working hours: 11 of the 14 clips with people had someone in view in at least 70 % of the frames. The rule as decided will therefore alert again and again while work is going on.
   - This does not change the model choice. It is a P2/P4 point: watch it in the shadow phase.
   - Options that keep the whole picture:
     - one alert per person track plus the cooldown (plan section 5);
     - a "known staff area" exclusion mask on the bench, if the owner accepts one;
     - or revisit the hours rule after the shadow week.
6. **False-alarm numbers are weak.**
   - 8.2 min of footage around access events cannot estimate false alarms per hour: "0 episodes" here means fewer than about 7/h.
   - The night set is 15 min of stills per gate.
   - Clutter changes daily: the 2 Oct clips brought new false spots.
   - The long continuous footage requested in section 8 is needed before P4.

## 7. CPU timing on this host

onnxruntime-node 1.30, tester image, `graphOptimizationLevel: all`, intra-op threads as listed, 200 NVR frames after 10 warm-up frames, `--cpus 2.5`, nice 19, busy host. `session.run` only; FFmpeg scaling and tensor fill come on top (5-60 ms in this harness, depending on size). "Cores per gate" = 1-thread time × frames per second.

| Model | Input | View | 1 thread mean / p95 ms | 2 threads mean / p95 ms | Cores per gate at 4 fps / 2 fps (1 thread) | Keeps up with 4 fps on 1 thread? | Size MB |
|---|---|---|---|---|---|---|---|
| yolox-nano | 416x256 | whole picture | 31 / 40 | 28 / 52 | 0.1 / 0.1 | yes | 3.7 |
| yolox-nano | 640x384 | whole picture | 70 / 86 | 51 / 77 | 0.3 / 0.1 | yes | 3.7 |
| yolox-nano | 960x544 | whole picture | 152 / 177 | 100 / 129 | 0.6 / 0.3 | yes | 3.7 |
| yolox-nano | 1280x736 | whole picture | 283 / 320 | 175 / 222 | 1.1 / 0.6 | no | 3.7 |
| yolox-nano | 1280x192 | gate-area crop | 70 / 83 | 47 / 69 | 0.3 / 0.1 | yes | 3.7 |
| yolox-tiny | 416x256 | whole picture | 117 / 137 | 77 / 107 | 0.5 / 0.2 | yes | 20.3 |
| yolox-tiny | 640x384 | whole picture | 273 / 305 | 161 / 225 | 1.1 / 0.5 | no | 20.3 |
| yolox-tiny | 960x544 | whole picture | 581 / 640 | 334 / 383 | 2.3 / 1.2 | no | 20.3 |
| yolox-tiny | 1280x736 | whole picture | 1055 / 1139 | 606 / 692 | 4.2 / 2.1 | no | 20.3 |
| yolox-tiny | 1280x192 | gate-area crop | 267 / 297 | 158 / 205 | 1.1 / 0.5 | no | 20.3 |
| rtmdet-tiny | 416x256 | whole picture | 128 / 152 | 77 / 104 | 0.5 / 0.3 | yes | 22.3 |
| rtmdet-tiny | 640x384 | whole picture | 290 / 324 | 167 / 216 | 1.2 / 0.6 | no | 22.3 |
| rtmdet-tiny | 960x544 | whole picture | 620 / 696 | 366 / 497 | 2.5 / 1.2 | no | 22.3 |
| rtmdet-tiny | 1280x736 | whole picture | 1157 / 1345 | 718 / 1093 | 4.6 / 2.3 | no | 22.3 |
| rtmdet-tiny | 1280x192 | gate-area crop | 309 / 404 | 224 / 433 | 1.2 / 0.6 | no | 22.3 |
| efficientdet-lite2 | 448x448 | whole picture | 328 / 414 | 206 / 295 | 1.3 / 0.7 | no | 22.9 |
| rtdetr-r18 | 640x640 | whole picture | 1772 / 1912 | 1061 / 1277 | 7.1 / 3.5 | no | 80.4 |
| rfdetr-nano | 384x384 | whole picture | 1025 / 1134 | 677 / 935 | 4.1 / 2.1 | no | 107.8 |

## 8. Not done, and footage INT should export

- **EXIT gate:** not evaluated (INT priority: entry first; CPU budget). Night false alarms at the exit were measured (zero at every operating threshold). The harness runs unchanged with `--plan accuracy-exit`; the ground-truth review must be repeated for the exit picture.
- **Night (lights off):** false alarms measured on 15 min of stills per gate. Recall is not measured: no lights-off footage with people exists yet. INT is looking for early arrivals before the lights come on.
- **False alarms per hour:** needs long continuous footage, not 15-70 s clips around events.
- **EfficientDet-Lite0:** the conversion does not load in onnxruntime-node 1.30 (section 3).
- **RT-DETR-R18 and RF-DETR-Nano** at other input sizes: not tried. Both are already 2-3x slower than RTMDet-tiny 960 and weaker.

Footage request for INT. NVR times are UTC (local = UTC+7); the NVR keeps about 8 days:

| Gate (channel) | Window (UTC) | Local time | Why |
|---|---|---|---|
| ENTRY (2201) | 2026-10-01 03:00-04:00 | 01 Oct 10:00-11:00 | working hours, continuous: false alarms/h, the standing-worker issue |
| ENTRY (2201) | 2026-10-01 11:30-12:30 | 01 Oct 18:30-19:30 | end of shift, evening light |
| ENTRY (2201) | 2026-10-01 15:00-16:00 and 2026-10-01 20:00-21:00 | 01 Oct 22:00-23:00 and 02 Oct 03:00-04:00 | lights off, as video (not stills): night false alarms at 4 frames/s |
| ENTRY (2201) | the first person(s) in the morning before the lights come on, and any guard round at night (2 min around each) | night | night recall |
| EXIT (501) | the same windows | | exit evaluation |

INT knows when the lights are actually off. Please shift the night windows to match.

## 9. Reproduce

`tools/presence-eval/README.md` lists every step. The model files are in `/data/models/candidates/presence/` (not in git). The labels are in `/data/test-clips/presence-p1/labels/` (`gt.json`, `decisions-entry.json`, Grounding DINO keyframes); the metrics are `metrics.json` (raw) and `metrics-masked.json`. The labels hold no pictures, but they are footage-derived: keep them on this host and delete them with the clips (`deleteAfter` 2026-10-27).

## Appendix: raw table (no overlay mask)

| Model | Input | Licence code / weights | Thr | Person recall >=3 s | Walking-through recall >=3 s | Person recall >=1 s | Passage recall >=3 s | Passage recall >=1 s | False alarms/h (episodes) | Box recall | ms/frame 1 thr mean / p95 | ms/frame 2 thr mean / p95 | Size MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| efficientdet-lite2 | 448x448 | Apache-2.0 / unconfirmed | 0.25 | 13/48 (27%) | 8/10 (80%) | 29/81 (36%) | 9/14 (64%) | 11/14 (79%) | 0.0 (0) | 35% | 328 / 414 | 206 / 295 | 22.9 |
| rfdetr-nano | 384x384 | Apache-2.0 / Apache-2.0 | 0.3 | 14/48 (29%) | 8/10 (80%) | 34/81 (42%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 39% | 1025 / 1134 | 677 / 935 | 107.8 |
| rtdetr-r18 | 640x640 | Apache-2.0 / unconfirmed | 0.45 | 16/48 (33%) | 9/10 (90%) | 32/81 (40%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 39% | 1772 / 1912 | 1061 / 1277 | 80.4 |
| rtmdet-tiny | 1280x736 | Apache-2.0 / unconfirmed | 0.35 | 23/48 (48%) | 10/10 (100%) | 49/81 (60%) | 12/14 (86%) | 13/14 (93%) | 0.0 (0) | 57% | 1157 / 1345 | 718 / 1093 | 22.3 |
| rtmdet-tiny | 416x256 | Apache-2.0 / unconfirmed | 0.4 | 10/48 (21%) | 8/10 (80%) | 18/81 (22%) | 6/14 (43%) | 7/14 (50%) | 0.0 (0) | 26% | 128 / 152 | 77 / 104 | 22.3 |
| rtmdet-tiny | 640x384 | Apache-2.0 / unconfirmed | 0.35 | 16/48 (33%) | 9/10 (90%) | 31/81 (38%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 41% | 290 / 324 | 167 / 216 | 22.3 |
| rtmdet-tiny | 960x544 | Apache-2.0 / unconfirmed | 0.3 | 25/48 (52%) | 10/10 (100%) | 52/81 (64%) | 11/14 (79%) | 12/14 (86%) | 0.0 (0) | 61% | 620 / 696 | 366 / 497 | 22.3 |
| yolox-nano | 1280x736 | Apache-2.0 / Apache-2.0 | 0.6 | 15/48 (31%) | 9/10 (90%) | 26/81 (32%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 34% | 283 / 320 | 175 / 222 | 3.7 |
| yolox-nano | 640x384 | Apache-2.0 / Apache-2.0 | 0.4 | 10/48 (21%) | 8/10 (80%) | 24/81 (30%) | 8/14 (57%) | 11/14 (79%) | 0.0 (0) | 29% | 70 / 86 | 51 / 77 | 3.7 |
| yolox-nano | 960x544 | Apache-2.0 / Apache-2.0 | 0.55 | 13/48 (27%) | 8/10 (80%) | 27/81 (33%) | 10/14 (71%) | 11/14 (79%) | 0.0 (0) | 33% | 152 / 177 | 100 / 129 | 3.7 |
| yolox-nano | 416x256 | Apache-2.0 / Apache-2.0 | 0.65 | 7/48 (15%) | 7/10 (70%) | 9/81 (11%) | 6/14 (43%) | 6/14 (43%) | 0.0 (0) | 17% | 31 / 40 | 28 / 52 | 3.7 |
| yolox-tiny | 1280x736 | Apache-2.0 / Apache-2.0 | 0.4 | 18/48 (38%) | 10/10 (100%) | 41/81 (51%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 47% | 1055 / 1139 | 606 / 692 | 20.3 |
| yolox-tiny | 640x384 | Apache-2.0 / Apache-2.0 | 0.6 | 10/48 (21%) | 8/10 (80%) | 21/81 (26%) | 8/14 (57%) | 11/14 (79%) | 0.0 (0) | 28% | 273 / 305 | 161 / 225 | 20.3 |
| yolox-tiny | 960x544 | Apache-2.0 / Apache-2.0 | 0.5 | 17/48 (35%) | 10/10 (100%) | 33/81 (41%) | 11/14 (79%) | 11/14 (79%) | 0.0 (0) | 41% | 581 / 640 | 334 / 383 | 20.3 |
| yolox-tiny | 416x256 | Apache-2.0 / Apache-2.0 | 0.6 | 9/48 (19%) | 8/10 (80%) | 12/81 (15%) | 6/14 (43%) | 7/14 (50%) | 0.0 (0) | 21% | 117 / 137 | 77 / 107 | 20.3 |

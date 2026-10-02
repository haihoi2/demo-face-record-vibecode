# Presence-detector evaluation (P1, offline only)

Re-runnable harness behind `docs/plans/2026-10-02-presence-p1-report.md`. Nothing here is used by
the gateway; it never touches the live containers or database.

Footage and everything derived from it (frames, crops, contact sheets, labels) is biometric data:
keep it under `/data/test-clips` (mode 0700), never commit or upload it, and delete frames, crops
and sheets when done (keep only `labels/*.json` and `metrics*.json`).

## Pipeline

All paths below assume `W=/data/test-clips/presence-p1` (create with `mkdir -m 0700`), `M=/data/models/candidates/presence`
and `T=$PWD/tools/presence-eval`.

**CPU budget (shared host with the LIVE gateway):** at most 2.5 CPUs across all P1 containers together
(`--cpus` on every `docker run`), processes at `nice -n 19`, one heavy job at a time. On 2026-10-02 a
Grounding DINO job (~4 cores) plus a 2-core inference job starved the live camera streams (8 -> 1.5 fps,
17 reconnects) even with `--cpu-shares 512`; `run_matrix.py` now refuses `--cpus` above 2.5.

1. Frames + manifest (host Python 3, ffmpeg): 4 frames/s, NVR clips stored 1920 px wide, scripted 1280 px.
   `python3 $T/extract_frames.py --work $W`
2. Tool images (offline only):
   - `docker build -f $T/docker/torch.Dockerfile -t presence-p1-torch $T/docker` (YOLOX, RT-DETR, RF-DETR export; Grounding DINO)
   - `docker build -f $T/docker/mm.Dockerfile -t presence-p1-mm $T/docker` (RTMDet export)
   - `docker build -f $T/docker/tf.Dockerfile -t presence-p1-tf $T/docker` (EfficientDet-Lite conversion)
   - `docker build --target tester -t presence-p1-tester .` (the repo's own tester image: onnxruntime-node 1.30)
3. Models -> `$M/*.onnx` (sources, versions and licences: see the report). Every exported file has the
   same contract: one image input, output `[1,N,5]` = x1,y1,x2,y2 (input pixels), person score.
   Each script checks its ONNX against the reference implementation (PyTorch, MediaPipe, mmdet).
   - `export_yolox.py --name yolox-nano|yolox-tiny` (presence-p1-torch, `PYTHONPATH=/src/YOLOX`)
   - `export_rtdetr.py` (presence-p1-torch, `-w /src/RT-DETR/rtdetrv2_pytorch`)
   - `export_rfdetr.py` (presence-p1-torch)
   - `export_rtmdet.py` (presence-p1-mm)
   - `convert_effdet.py --tflite efficientdet_lite0|2.tflite` (presence-p1-tf)
4. Grounding DINO pre-labels (independent reference, 1 frame/s; ~25 s/frame with 3-5 cores, ~75 s/frame at 1.5):
   `docker run --cpus 2.5 ... presence-p1-torch nice -n 19 python /tools/prelabel_gdino.py --work /work --every 4 --gates ENTRY --out labels/gdino-base-1fps.jsonl`
5. Candidate runs (onnxruntime-node in the tester image, one job at a time):
   `python3 $T/run_matrix.py --plan accuracy-entry [--cpus 2 --threads 2]` and `--plan timing`
   (`run-models.ts` writes `runs/<model>__<view>__<input>__t<threads>__<tag>/{dets.jsonl,summary.json}`).
6. Ground truth: `pool_labels.py --gate ENTRY` (presence-p1-torch) pools all candidate detections and
   Grounding DINO into tracks and draws `review/<gate>/sheet-NN.jpg`; look at every sheet, write
   overrides to `labels/decisions-<gate>.json`, then rerun with `--decisions ... --write-gt` to write `labels/gt.json`.
7. Scores: `python3 $T/score.py --work $W [--mask-overlays --out metrics-masked.json]` -> `metrics.json`;
   `python3 $T/report_tables.py --work $W [--metrics metrics-masked.json]` prints the report tables (person,
   walking-through and passage recall at 3 s and 1 s, false alarms per hour, ms/frame, size).
8. New footage later:
   - extra NVR exports in `$W/night/clips/<gate>-<channel>-<startUtc>.mp4`: `extract_frames.py --sets nvr,scripted,night,extra`,
     then `run_matrix.py --plan accuracy-entry --tag entry-add --clips <ids>` and `merge_runs.py --src entry-add --dst entry`,
     Grounding DINO with `--clips <ids>`, and steps 6-7 again;
   - night stills (`$W/night/<gate>/<UTC>.jpg`, person-free): `extract_frames.py --sets ...,night`,
     `run_matrix.py --plan night`, then `night_fa.py --work $W --metrics metrics-masked.json`.

Definitions of every metric are in the `score.py` docstring.

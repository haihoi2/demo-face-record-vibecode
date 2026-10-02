#!/usr/bin/env python3
"""Grounding DINO pre-labels ("a person.") for the P1 ground truth. OFFLINE ONLY.

Runs in the presence-p1-torch image (tools/presence-eval/docker/torch.Dockerfile):

  docker run --rm --cpus 2.5 -u $(id -u):$(id -g) -v /data/test-clips/presence-p1:/work \
    -v /data/models/candidates/hf:/cache/hf -e HF_HUB_OFFLINE=1 presence-p1-torch \
    nice -n 19 python /tools/prelabel_gdino.py --work /work --model IDEA-Research/grounding-dino-base \
    --threads 2 --every 4 --gates ENTRY
  (shared host: at most 2.5 CPUs for all P1 containers together, one heavy job at a time)

Writes /work/labels/gdino.jsonl: {"c":clipId,"i":frame,"d":[[x1,y1,x2,y2,score],...]} with boxes
normalised to the stored frame, every box with score >= --keep. Resumable: clips already present
in the output are skipped. --every 4 labels one frame per second. Pre-labels are NOT ground truth until reviewed (review.py).
"""
import argparse
import json
import os
import time

import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/work")
    ap.add_argument("--model", default="IDEA-Research/grounding-dino-base")
    ap.add_argument("--sets", default="nvr")
    ap.add_argument("--clips", default="")
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--keep", type=float, default=0.15)
    ap.add_argument("--short-edge", type=int, default=800)
    ap.add_argument("--out", default="labels/gdino.jsonl")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--every", type=int, default=1, help="label every Nth frame (4 = 1 fps)")
    ap.add_argument("--gates", default="ENTRY,EXIT")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    man = json.load(open(os.path.join(a.work, "manifest.json")))
    clips = [c for c in man["clips"] if c["set"] in a.sets.split(",")]
    clips = [c for c in clips if c["gate"] in a.gates.split(",")]
    if a.clips:
        clips = [c for c in clips if c["id"] in a.clips.split(",")]
    out_path = os.path.join(a.work, a.out)
    os.makedirs(os.path.dirname(out_path), mode=0o700, exist_ok=True)
    done = set()
    if os.path.exists(out_path):
        for line in open(out_path):
            done.add(json.loads(line)["c"])
    proc = AutoProcessor.from_pretrained(a.model)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(a.model).eval()
    text = "a person."
    n = 0
    t_all = time.time()
    with open(out_path, "a") as out:
        for c in clips:
            if c["id"] in done:
                continue
            rows = []
            for i in range(0, c["frames"], a.every):
                img = Image.open(os.path.join(a.work, "frames", c["id"], f"{i:05d}.jpg")).convert("RGB")
                w, h = img.size
                inputs = proc(images=img, text=text, return_tensors="pt",
                              size={"shortest_edge": a.short_edge, "longest_edge": 1333})
                with torch.inference_mode():
                    o = model(**inputs)
                try:
                    r = proc.post_process_grounded_object_detection(
                        o, inputs.input_ids, threshold=a.keep, text_threshold=a.keep, target_sizes=[(h, w)])[0]
                except TypeError:
                    r = proc.post_process_grounded_object_detection(
                        o, inputs.input_ids, box_threshold=a.keep, text_threshold=a.keep, target_sizes=[(h, w)])[0]
                d = []
                for b, s in zip(r["boxes"].tolist(), r["scores"].tolist()):
                    d.append([round(b[0] / w, 4), round(b[1] / h, 4), round(b[2] / w, 4), round(b[3] / h, 4), round(s, 3)])
                rows.append({"c": c["id"], "i": i, "d": d})
                n += 1
                if a.limit and n >= a.limit:
                    break
            for r_ in rows:
                out.write(json.dumps(r_) + "\n")
            out.flush()
            print(f"{c['id']}: {len(rows)} frames, {(time.time() - t_all) / max(1, n):.2f} s/frame avg", flush=True)
            if a.limit and n >= a.limit:
                break


if __name__ == "__main__":
    main()

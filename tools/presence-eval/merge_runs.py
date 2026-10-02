#!/usr/bin/env python3
"""Fold the detections of runs made on newly added clips into the main runs. Stdlib only.

    python3 tools/presence-eval/merge_runs.py --work /data/test-clips/presence-p1 --src entry-add --dst entry

For every runs/<model>__<view>__<input>__t<n>__<src> with a matching ...__<dst>, the destination's
dets.jsonl loses any lines for the clips in the source and gains the source's lines. The source
summary.json is kept next to the destination as summary-<src>.json (timings are not merged).
"""
import argparse
import glob
import json
import os
import shutil


def main():
    os.nice(19)
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    a = ap.parse_args()
    for sd in sorted(glob.glob(os.path.join(a.work, "runs", f"*__{a.src}"))):
        dd = sd[: -len(a.src)] + a.dst
        if not (os.path.exists(os.path.join(sd, "summary.json")) and os.path.exists(os.path.join(dd, "dets.jsonl"))):
            print(f"skip {os.path.basename(sd)}")
            continue
        new = [json.loads(x) for x in open(os.path.join(sd, "dets.jsonl"))]
        clips = {r["c"] for r in new}
        old = [x for x in open(os.path.join(dd, "dets.jsonl")) if json.loads(x)["c"] not in clips]
        with open(os.path.join(dd, "dets.jsonl"), "w") as f:
            f.writelines(old)
            f.writelines(json.dumps(r) + "\n" for r in new)
        shutil.copy(os.path.join(sd, "summary.json"), os.path.join(dd, f"summary-{a.src}.json"))
        print(f"merged {len(new)} frames of {sorted(clips)} into {os.path.basename(dd)}")


if __name__ == "__main__":
    main()

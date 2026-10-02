#!/usr/bin/env python3
"""Night false alarms on INT's lights-off IR stills (person-free, checked by eye). Stdlib only.

    python3 tools/presence-eval/night_fa.py --work /data/test-clips/presence-p1 [--metrics metrics-masked.json]

For every night run (runs/*__night) and each model's ENTRY operating threshold (taken from the
metrics file, same rule as report_tables.py) plus fixed thresholds, prints per gate:
  FP frames      stills with any detection >= threshold (after the overlay mask)
  runs           maximal runs of consecutive FP stills; treating the stills as a stream at their
                 capture interval (~5-9 s), every run lasts >= one interval, i.e. >= 3 s, so each run
                 is a would-be 3 s alert. Caveat: the real stream is 4 fps; a detection that flickers
                 between stills is invisible here, and one lucky still is counted as a full interval.
"""
import argparse
import glob
import json
import os

from report_tables import op_threshold
from score import drop_overlays, load_jsonl

FIXED = ["0.2", "0.3", "0.4"]


def main():
    os.nice(19)
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--metrics", default="metrics-masked.json")
    ap.add_argument("--no-mask", action="store_true")
    a = ap.parse_args()
    man = {c["id"]: c for c in json.load(open(os.path.join(a.work, "manifest.json")))["clips"] if c["set"] == "night"}
    met = json.load(open(os.path.join(a.work, a.metrics)))
    ops = {(r["model"], r["input"]): op_threshold(r["byThreshold"]) for r in met["results"]
           if r["set"] == "nvr" and r["view"] == "full"}
    print("| Model | Input | Entry op thr | " + " | ".join(
        f"{g} FP stills / runs @op" for g in ("ENTRY", "EXIT")) + " | " + " | ".join(
        f"ENTRY / EXIT FP stills @{t}" for t in FIXED) + " |")
    print("|---|---|---|---|---|" + "---|" * len(FIXED))
    for rd in sorted(glob.glob(os.path.join(a.work, "runs", "*__night"))):
        if not os.path.exists(os.path.join(rd, "summary.json")):
            continue
        meta = json.load(open(os.path.join(rd, "summary.json")))
        dets = load_jsonl(os.path.join(rd, "dets.jsonl"))
        op = ops.get((meta["model"], meta["input"]))

        def count(cid, thr):
            c = man[cid]
            flags = []
            for i in range(c["frames"]):
                d = [x for x in dets.get((cid, i), []) if x[4] >= thr]
                if not a.no_mask:
                    d = drop_overlays(d, c["gate"])
                flags.append(bool(d))
            runs = sum(1 for i, f in enumerate(flags) if f and (i == 0 or not flags[i - 1]))
            return sum(flags), runs, c["frames"]

        cells = []
        for cid in ("night-entry", "night-exit"):
            if cid in man and op:
                fp, runs, n = count(cid, float(op))
                cells.append(f"{fp}/{n} / {runs}")
            else:
                cells.append("-")
        fixed = []
        for t in FIXED:
            parts = [f"{count(cid, float(t))[0]}" if cid in man else "-" for cid in ("night-entry", "night-exit")]
            fixed.append(" / ".join(parts))
        print(f"| {meta['model']} | {meta['shapes'].split(' ')[0]} | {op or '-'} | " + " | ".join(cells) + " | "
              + " | ".join(fixed) + " |")
    for cid, c in man.items():
        print(f"\n{cid}: {c['frames']} stills, one every {c['stillStepS']:.1f} s, {c['times'][0]}..{c['times'][-1]} UTC")


if __name__ == "__main__":
    main()

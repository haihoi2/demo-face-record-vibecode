#!/usr/bin/env python3
"""Print the P1 report tables (markdown) from metrics.json and the timing runs. Stdlib only.

    python3 tools/presence-eval/report_tables.py --work /data/test-clips/presence-p1 [--gate ENTRY]

Operating threshold per model/input = the lowest threshold with no false-alarm episode on this
footage that gives the best person recall at 3 s (then passage recall). The footage is short (one
episode = ~10/h), so "no false alarm here" is a weak bound; the sweep table shows the trade-off.
"""
import argparse
import glob
import json
import os

LICENCE = {
    "yolox-nano": "Apache-2.0 / Apache-2.0",
    "yolox-tiny": "Apache-2.0 / Apache-2.0",
    "rtmdet-tiny": "Apache-2.0 / unconfirmed",
    "efficientdet-lite0": "Apache-2.0 / unconfirmed",
    "efficientdet-lite2": "Apache-2.0 / unconfirmed",
    "rtdetr-r18": "Apache-2.0 / unconfirmed",
    "rfdetr-nano": "Apache-2.0 / Apache-2.0",
}


def pct(h, n):
    return f"{h}/{n} ({100 * h / n:.0f}%)" if n else "-"


def timing(work):
    t = {}
    for p in glob.glob(os.path.join(work, "runs", "*__timing", "summary.json")):
        s = json.load(open(p))
        t[(s["model"], s["input"], s["threads"], s["view"])] = s
    return t


def op_threshold(byt):
    """Lowest threshold with zero false-alarm episodes on this footage that reaches the best person
    recall at 3 s (then passage recall) among the zero-false-alarm thresholds. If no threshold is
    free of false alarms, the one with the fewest false alarms."""
    fa_min = min(v["fa"] for v in byt.values())
    cand = {t: v for t, v in byt.items() if v["fa"] == fa_min}
    best = max((v.get("thit3", 0), v["hit3"]) for v in cand.values())
    ok = [float(t) for t, v in cand.items() if (v.get("thit3", 0), v["hit3"]) == best]
    return str(min(ok))


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--metrics", default="metrics.json")
    ap.add_argument("--gate", default="ENTRY")
    ap.add_argument("--fixed", default="0.3", help="also report every model at this common threshold")
    a = ap.parse_args()
    m = json.load(open(os.path.join(a.work, a.metrics)))
    tim = timing(a.work)
    tag = a.gate.lower()
    res = [r for r in m["results"] if r["run"].endswith("__" + tag)]

    def row(r, t):
        v = r["byThreshold"][t]
        hours = v["sec"] / 3600
        fa = f"{v['fa'] / hours:.1f} ({v['fa']})" if hours else "-"
        br = f"{100 * v['gt_hit'] / v['gt_boxes']:.0f}%" if v["gt_boxes"] else "-"
        return v, fa, br

    print(f"\n### {a.gate}: real footage, full picture (primary)\n")
    print("| Model | Input | Licence code / weights | Thr | Person recall >=3 s | Walking-through recall >=3 s | Person recall >=1 s | Passage recall >=3 s | Passage recall >=1 s | False alarms/h (episodes) | Box recall | ms/frame 1 thr mean / p95 | ms/frame 2 thr mean / p95 | Size MB |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    full = sorted([r for r in res if r["set"] == "nvr" and r["view"] == "full"], key=lambda r: (r["model"], r["input"]))
    for r in full:
        t = op_threshold(r["byThreshold"])
        v, fa, br = row(r, t)
        t1 = tim.get((r["model"], r["input"], 1, "full"))
        t2 = tim.get((r["model"], r["input"], 2, "full"))
        f1 = f"{t1['runMs']['mean']:.0f} / {t1['runMs']['p95']:.0f}" if t1 else "-"
        f2 = f"{t2['runMs']['mean']:.0f} / {t2['runMs']['p95']:.0f}" if t2 else "-"
        size = (t1 or t2 or {}).get("fileBytes")
        sz = f"{size / 1e6:.1f}" if size else "-"
        print(f"| {r['model']} | {r['shapes'].split(' ')[0]} | {LICENCE.get(r['model'], '?')} | {t} | "
              f"{pct(v.get('thit3', 0), v.get('tpos3', 0))} | {pct(v.get('mhit3', 0), v.get('mpos3', 0))} | "
              f"{pct(v.get('thit1', 0), v.get('tpos1', 0))} | "
              f"{pct(v['hit3'], v['pos3'])} | {pct(v['hit1'], v['pos1'])} | {fa} | {br} | {f1} | {f2} | {sz} |")
    hours = full[0]["byThreshold"]["0.3"]["sec"] / 3600 if full else 0
    print(f"\nFootage: {hours * 60:.1f} min real {a.gate} video.")

    print(f"\n### {a.gate}: every model at threshold {a.fixed}\n")
    print("| Model | Input | Person recall >=3 s | Person recall >=1 s | Passage recall >=3 s | False alarms/h (episodes) | Box recall |")
    print("|---|---|---|---|---|---|---|")
    for r in full:
        v, fa, br = row(r, a.fixed)
        print(f"| {r['model']} | {r['shapes'].split(' ')[0]} | {pct(v.get('thit3', 0), v.get('tpos3', 0))} | "
              f"{pct(v.get('thit1', 0), v.get('tpos1', 0))} | {pct(v['hit3'], v['pos3'])} | {fa} | {br} |")

    print(f"\n### {a.gate}: threshold sweep (real footage, full picture)\n")
    ths = ["0.15", "0.2", "0.25", "0.3", "0.35", "0.4", "0.5", "0.6"]
    print("| Model | Input | " + " | ".join(f"t={t} person R3 / walking R3 / FA/h" for t in ths) + " |")
    print("|---|---|" + "---|" * len(ths))
    for r in full:
        cells = []
        for t in ths:
            v = r["byThreshold"][t]
            h = v["sec"] / 3600
            cells.append(f"{v.get('thit3', 0)}/{v.get('tpos3', 0)} / {v.get('mhit3', 0)}/{v.get('mpos3', 0)} / {v['fa'] / h:.0f}" if h else "-")
        print(f"| {r['model']} | {r['shapes'].split(' ')[0]} | " + " | ".join(cells) + " |")

    zone = sorted([r for r in res if r["set"] == "nvr" and r["view"] in ("gate", "full+zone")],
                  key=lambda r: (r["model"], r["input"], r["view"]))
    if zone:
        print(f"\n### {a.gate}: gate area (secondary)\n")
        print("| Model | Input | How | Thr | Person recall >=3 s | Passage recall >=3 s | Passage recall >=1 s | False alarms/h (episodes) | ms/frame 1 / 2 thr (mean) |")
        print("|---|---|---|---|---|---|---|---|---|")
        for r in zone:
            t = op_threshold(r["byThreshold"])
            v, fa, br = row(r, t)
            how = "crop then detect" if r["view"] == "gate" else "detect full, keep boxes in area"
            vw = "gate" if r["view"] == "gate" else "full"
            ms = [tim.get((r["model"], r["input"], k, vw)) for k in (1, 2)]
            ms_s = " / ".join(f"{x['runMs']['mean']:.0f}" if x else "-" for x in ms)
            print(f"| {r['model']} | {r['shapes'].split(' ')[0]} | {how} | {t} | {pct(v.get('thit3', 0), v.get('tpos3', 0))} | "
                  f"{pct(v['hit3'], v['pos3'])} | {pct(v['hit1'], v['pos1'])} | {fa} | {ms_s} |")

    scr = sorted([r for r in res if r["set"] == "scripted"], key=lambda r: (r["model"], r["input"]))
    if scr:
        print(f"\n### {a.gate}: scripted synthetic set (sanity check only)\n")
        print("| Model | Input | t=0.3 recall >=3 s | t=0.3 recall >=1 s | t=0.3 FA episodes in empty passages/clip |")
        print("|---|---|---|---|---|")
        for r in scr:
            v = r["byThreshold"]["0.3"]
            print(f"| {r['model']} | {r['shapes'].split(' ')[0]} | {pct(v['hit3'], v['pos3'])} | {pct(v['hit1'], v['pos1'])} | {v['fa']} |")

    print("\n### Misses and false alarms at the operating threshold\n")
    for r in full:
        t = op_threshold(r["byThreshold"])
        v = r["byThreshold"][t]
        print(f"- {r['model']} {r['input']} t={t}: persons missed {v.get('tmissed') or 'none'}; "
              f"passages missed {v['missed'] or 'none'}; FA {v['fa_where'] or 'none'}")


if __name__ == "__main__":
    main()

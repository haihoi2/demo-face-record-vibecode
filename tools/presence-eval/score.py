#!/usr/bin/env python3
"""Score P1 person-detector runs against the reviewed ground truth. Stdlib only. OFFLINE ONLY.

    python3 tools/presence-eval/score.py --work /data/test-clips/presence-p1 [--runs 'glob'] \
        [--gt labels/gt.json] [--out metrics.json] [--gap 2] [--iou 0.3]

Definitions (4 frames/s; a frame flag is "seen" if any detection >= threshold satisfies the rule):
  TP frame        a detection matches a ground-truth person box (IoU >= --iou)
  FP frame        a detection matches no ground-truth person box
  episode         a run of flagged frames; gaps of <= --gap frames (0.5 s at gap 2) are bridged;
                  duration = (last - first + 1) / fps
  passage recall  share of positive passages (ground truth shows a person for >= D s inside the
                  passage window) where the model has a TP episode >= D s inside the window, for
                  D = 3 s (the alert rule) and D = 1 s. Scripted passages have no boxes: any
                  detection inside a people passage counts (synthetic set, see report).
  false alarms/h  FP episodes >= 3 s per hour of footage (all frames; an FP is a detection on no
                  person - in an empty stretch or next to real people). Scripted: any detection in
                  an empty passage / empty clip.
  person recall   per ground-truth person track (NVR): share of tracks in view >= D s that the model
                  itself matched for >= D s (gap-bridged); stricter than passage recall, where one
                  detected person (e.g. a worker in the background) covers the whole clip
  moving recall   person recall restricted to tracks whose box centre moves >= 5% of the frame
                  width (people walking through rather than standing at a bench)
  box recall      share of ground-truth person boxes matched by a detection
Zone ("gate") scoring: ground-truth boxes and detections are clipped to the gate area and kept if at
least 20% of the box lies inside it. Runs with view=gate are cropped inputs; runs with view=full are
also scored as "full+zone" (full-picture detection, then the zone rule) for ENTRY clips.
"""
import argparse
import glob
import json
import os

THRESHOLDS = [round(0.10 + 0.05 * k, 2) for k in range(15)]  # 0.10 .. 0.80
ZONE_MIN_FRAC = 0.2
MOVING_FRAC = 0.05


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inter(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def iou(a, b):
    i = inter(a, b)
    u = area(a) + area(b) - i
    return i / u if u > 0 else 0.0


def clip_to_zone(boxes, z):
    """z = [x, y, w, h] fractions; keep boxes with >= ZONE_MIN_FRAC of their area inside, clipped."""
    zx1, zy1, zx2, zy2 = z[0], z[1], z[0] + z[2], z[1] + z[3]
    out = []
    for b in boxes:
        a = area(b)
        c = [max(b[0], zx1), max(b[1], zy1), min(b[2], zx2), min(b[3], zy2)] + list(b[4:])
        if a > 0 and area(c) >= ZONE_MIN_FRAC * a:
            out.append(c)
    return out


def match(dets, gts, thr_iou):
    """Greedy one-to-one matching by IoU. Returns (matched gt indices, n_unmatched_det)."""
    used = set()
    unmatched = 0
    for d in sorted(dets, key=lambda d: -d[4]):
        best, bj = thr_iou, -1
        for j, g in enumerate(gts):
            if j in used:
                continue
            v = iou(d, g)
            if v >= best:
                best, bj = v, j
        if bj >= 0:
            used.add(bj)
        else:
            unmatched += 1
    return used, unmatched


def episodes(flags, gap):
    """Runs of True with gaps <= gap bridged -> list of (first, last) frame indices."""
    out = []
    start = last = None
    for i, f in enumerate(flags):
        if not f:
            continue
        if start is None:
            start = last = i
        elif i - last - 1 <= gap:
            last = i
        else:
            out.append((start, last))
            start = last = i
    if start is not None:
        out.append((start, last))
    return out


def longest_in(eps, lo, hi):
    best = 0
    for a, b in eps:
        a2, b2 = max(a, lo), min(b, hi)
        if b2 >= a2:
            best = max(best, b2 - a2 + 1)
    return best


def load_jsonl(p):
    rows = {}
    for line in open(p):
        r = json.loads(line)
        rows[(r["c"], r["i"])] = r["d"]
    return rows


def score_run(run_dir, man, gt, gap, thr_iou, zone_mode):
    """zone_mode: None (full picture) or 'zone' (clip GT + dets to the gate area)."""
    meta = json.load(open(os.path.join(run_dir, "summary.json")))
    dets = load_jsonl(os.path.join(run_dir, "dets.jsonl"))
    fps = man["fps"]
    clips = [c for c in man["clips"] if (c["id"], 0) in dets]
    if zone_mode:
        clips = [c for c in clips if c["gate"] == "ENTRY"]
    res = {}
    for t in THRESHOLDS:
        acc = {"pos3": 0, "hit3": 0, "pos1": 0, "hit1": 0, "fa": 0, "fa_empty": 0, "sec": 0.0, "sec_empty": 0.0,
               "gt_boxes": 0, "gt_hit": 0, "missed": [], "fa_where": [], "by": {},
               "tpos3": 0, "thit3": 0, "tpos1": 0, "thit1": 0, "tmissed": [],
               "mpos3": 0, "mhit3": 0, "mmissed": []}
        for c in clips:
            n = c["frames"]
            g_clip = gt["clips"].get(c["id"]) if c["set"] == "nvr" else None
            if c["set"] == "nvr" and g_clip is None:
                continue
            tp, fp, gt_present, empty = [], [], [], []
            trk_seen, trk_hit = {}, {}  # track id -> per-frame flags (present / matched)
            trk_ctr = {}  # track id -> box centres (to tell people walking through from people standing)
            for i in range(n):
                d = [x for x in dets.get((c["id"], i), []) if x[4] >= t]
                if c["set"] == "nvr":
                    g = g_clip["frames"][i] if i < len(g_clip["frames"]) else []
                    if zone_mode:
                        g = clip_to_zone(g, c["gateArea"])
                        d = clip_to_zone(d, c["gateArea"])
                    used, um = match(d, g, thr_iou)
                    m = len(used)
                    acc["gt_boxes"] += len(g)
                    acc["gt_hit"] += m
                    for j, b in enumerate(g):
                        if len(b) > 4:
                            tid = b[4]
                            trk_seen.setdefault(tid, [False] * n)[i] = True
                            trk_hit.setdefault(tid, [False] * n)[i] = j in used
                            trk_ctr.setdefault(tid, []).append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2))
                    tp.append(m > 0)
                    fp.append(um > 0)
                    gt_present.append(len(g) > 0)
                    empty.append(len(g) == 0)
                else:
                    in_people = any(p["startS"] <= i / fps < p["endS"] and p["weakPeople"] > 0 for p in c["passages"])
                    tp.append(in_people and len(d) > 0)
                    fp.append((not in_people) and len(d) > 0)
                    gt_present.append(in_people)
                    empty.append(not in_people)
            tp_eps, fp_eps, gt_eps = episodes(tp, gap), episodes(fp, gap), episodes(gt_present, gap)
            light = c.get("light") or "?"
            key = f"{c['set']}/{c['gate']}/{light}"
            by = acc["by"].setdefault(key, {"pos3": 0, "hit3": 0, "pos1": 0, "hit1": 0, "fa": 0, "sec": 0.0})
            for p in c["passages"]:
                lo, hi = int(round(p["startS"] * fps)), min(n, int(round(p["endS"] * fps))) - 1
                gl = longest_in(gt_eps, lo, hi)
                ml = longest_in(tp_eps, lo, hi)
                for dur, kp, kh in ((3.0, "pos3", "hit3"), (1.0, "pos1", "hit1")):
                    need = int(round(dur * fps))
                    if gl >= need:
                        acc[kp] += 1
                        by[kp] += 1
                        if ml >= need:
                            acc[kh] += 1
                            by[kh] += 1
                        elif dur == 3.0:
                            acc["missed"].append(f"{p['id']} (gt {gl / fps:.2f}s, model {ml / fps:.2f}s)")
            # Per-person recall: every ground-truth person track in view >= D s must itself be
            # matched for >= D s (gap-bridged) - one detected person cannot cover for another.
            for tid, seen in trk_seen.items():
                gl = max((b - a + 1 for a, b in episodes(seen, gap)), default=0)
                ml = max((b - a + 1 for a, b in episodes(trk_hit.get(tid, [False] * n), gap)), default=0)
                for dur, kp, kh in ((3.0, "tpos3", "thit3"), (1.0, "tpos1", "thit1")):
                    need = int(round(dur * fps))
                    if gl >= need:
                        acc[kp] += 1
                        if ml >= need:
                            acc[kh] += 1
                        elif dur == 3.0:
                            acc["tmissed"].append(f"{c['id']}#{tid} (in view {gl / fps:.2f}s, seen {ml / fps:.2f}s)")
                # "moving" = the box centre travels >= MOVING_FRAC of the frame width from where it
                # appeared: someone walking through, not a worker standing at a bench.
                ctr = trk_ctr.get(tid, [])
                moving = bool(ctr) and max(abs(x - ctr[0][0]) for x, _ in ctr) >= MOVING_FRAC
                if moving and gl >= int(round(3 * fps)):
                    acc["mpos3"] += 1
                    if ml >= int(round(3 * fps)):
                        acc["mhit3"] += 1
                    else:
                        acc["mmissed"].append(f"{c['id']}#{tid} (in view {gl / fps:.2f}s, seen {ml / fps:.2f}s)")
            for a, b in fp_eps:
                if (b - a + 1) >= int(round(3 * fps)):
                    acc["fa"] += 1
                    by["fa"] += 1
                    all_empty = all(empty[a:b + 1])
                    if all_empty:
                        acc["fa_empty"] += 1
                    acc["fa_where"].append(f"{c['id']}@{a / fps:.1f}-{(b + 1) / fps:.1f}s{' (empty)' if all_empty else ''}")
            acc["sec"] += n / fps
            by["sec"] += n / fps
            acc["sec_empty"] += sum(empty) / fps
        res[str(t)] = acc
    return meta, res


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--runs", default="runs/*")
    ap.add_argument("--gt", default="labels/gt.json")
    ap.add_argument("--out", default="metrics.json")
    ap.add_argument("--gap", type=int, default=2)
    ap.add_argument("--iou", type=float, default=0.3)
    a = ap.parse_args()
    man = json.load(open(os.path.join(a.work, "manifest.json")))
    gt = json.load(open(os.path.join(a.work, a.gt)))
    out = []
    for rd in sorted(glob.glob(os.path.join(a.work, a.runs))):
        if not os.path.exists(os.path.join(rd, "summary.json")):  # missing or still running
            continue
        meta = json.load(open(os.path.join(rd, "summary.json")))
        modes = [None]
        if meta["view"] == "gate":
            modes = ["zone"]
        elif meta["view"] == "full":
            modes = [None, "zone"]
        for zm in modes:
            for subset in ("nvr", "scripted"):
                if zm and subset == "scripted":  # zones are only meaningful on the real footage
                    continue
                man_s = dict(man, clips=[c for c in man["clips"] if c["set"] == subset])
                meta, res = score_run(rd, man_s, gt, a.gap, a.iou, zm)
                if not any(v["sec"] for v in res.values()):
                    continue
                view = meta["view"] if zm is None or meta["view"] == "gate" else "full+zone"
                out.append({"run": os.path.basename(rd), "model": meta["model"], "view": view, "input": meta["input"],
                            "shapes": meta["shapes"], "set": subset, "byThreshold": res})
                print(f"scored {os.path.basename(rd)} {view} {subset}", flush=True)
    p = os.path.join(a.work, a.out)
    json.dump({"gapFrames": a.gap, "iou": a.iou, "thresholds": THRESHOLDS, "results": out}, open(p, "w"), indent=1)
    os.chmod(p, 0o600)
    print(f"wrote {p}")


if __name__ == "__main__":
    main()

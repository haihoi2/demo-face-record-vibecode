#!/usr/bin/env python3
"""P1b: combine YOLOX-Nano and RTMDet-tiny without new inference. Stdlib only. OFFLINE ONLY.

    python3 tools/presence-eval/combine.py --work /data/test-clips/presence-p1 [--fps 2] [--out combine.json]

Re-scores the saved 4 fps detections (runs/<A>/dets.jsonl, runs/<B>/dets.jsonl) against labels/gt.json,
simulating a presence thread that processes --fps frames per second (frame i of the 4 fps grid is
processed when i % (4 / fps) == 0). OSD overlays are masked (score.drop_overlays).

Strategies (A = YOLOX-Nano 960, B = RTMDet-tiny 960; thresholds on the command line):
  A            A alone at ta.
  B            B alone at tb.
  UNION        A at ta and B at tb on every processed frame; boxes merged by NMS (IoU 0.5).
  CASCADE-A r  A on every processed frame. When A sees nobody on a frame of B's own r fps grid, B runs on
               that frame. CPU = A always + B only on those frames.
  LOWRATE r    A on every processed frame, B on every frame of its r fps grid regardless of A, union.
  For CASCADE-A and LOWRATE the tracker is assumed to coast over one B period: detections up to one B
  period apart are linked into one episode (the end is not extended), instead of the usual 0.5 s.
  CASCADE-B    A at a lower threshold ta_low on every processed frame; when A has a candidate, B runs on
               that frame and only A boxes overlapping a B box >= tb_confirm (IoU >= 0.3) are kept.

Metrics as in score.py, evaluated on the processed frames only (gap of <= 0.5 s bridged):
person recall >= 3 s / 1 s, walking-through recall >= 3 s, passage recall >= 3 s, false-alarm
episodes >= 3 s, and CPU = sum of 1-thread session.run means of the inferences actually made, in cores per
gate (ms per second / 1000). Set split: day+evening clips vs night (lights off) clips.
"""
import argparse
import json
import os

from score import area, drop_overlays, episodes, inter, iou, load_jsonl, match

MOVING_FRAC = 0.05


def nms(boxes, thr=0.5):
    keep = []
    for b in sorted(boxes, key=lambda b: -b[4]):
        if all(iou(b, k) <= thr for k in keep):
            keep.append(b)
    return keep


def frame_eval(dets, gts):
    """-> (matched person track ids, false-positive flag). An unmatched detection that lies mostly on a
    ground-truth person (>= 50 % of its area inside a person box, or IoU >= 0.1) is a duplicate box on a
    present person, not a false alarm; score.py counts those as false positives (stricter)."""
    used, unmatched = match(dets, gts, 0.3)
    fp = False
    if unmatched:
        for d in dets:
            if any(iou(d, g) >= 0.3 for g in gts):
                continue
            a = area(d)
            if not any(iou(d, g) >= 0.1 or (a > 0 and inter(d, g) >= 0.5 * a) for g in gts):
                fp = True
                break
    return {gts[j][4] for j in used}, fp


class Sim:
    """Per-clip simulation of one strategy -> list of (matched_tids, fp) per processed frame + cost."""

    def __init__(self, a, b, ta, tb, cost_a, cost_b):
        self.a, self.b, self.ta, self.tb, self.ca, self.cb = a, b, ta, tb, cost_a, cost_b

    def dets(self, rows, cid, i, thr):
        return drop_overlays([d for d in rows.get((cid, i), []) if d[4] >= thr], "ENTRY")

    def run(self, kind, cid, frames, gt, step, param):
        out, ms = [], 0.0
        b_period = int(round(4 / param)) if kind in ("CASCADE-A", "LOWRATE") else 0
        for i in frames:
            g = gt[i]
            if kind == "A":
                d = self.dets(self.a, cid, i, self.ta); ms += self.ca
            elif kind == "B":
                d = self.dets(self.b, cid, i, self.tb); ms += self.cb
            elif kind == "UNION":
                d = nms(self.dets(self.a, cid, i, self.ta) + self.dets(self.b, cid, i, self.tb)); ms += self.ca + self.cb
            elif kind == "CASCADE-A":
                d = self.dets(self.a, cid, i, self.ta); ms += self.ca
                if not d and i % b_period == 0:
                    d = self.dets(self.b, cid, i, self.tb); ms += self.cb
            elif kind == "LOWRATE":
                d = self.dets(self.a, cid, i, self.ta); ms += self.ca
                if i % b_period == 0:
                    d = nms(d + self.dets(self.b, cid, i, self.tb)); ms += self.cb
            elif kind == "CASCADE-B":
                ta_low, tb_conf = param
                cand = self.dets(self.a, cid, i, ta_low); ms += self.ca
                d = []
                if cand:
                    conf = self.dets(self.b, cid, i, tb_conf); ms += self.cb
                    d = [c for c in cand if any(iou(c, x) >= 0.3 for x in conf)]
            out.append(frame_eval(d, g))
        return out, ms


def score_clip(res, gt, frames, fps, acc, gap_s=0.5):
    n = len(frames)
    gap = max(1, int(round(gap_s * fps)))
    need = {3: int(round(3 * fps)), 1: int(round(1 * fps))}
    tids = {b[4] for i in frames for b in gt[i]}
    longest = lambda flags: max((b - a + 1 for a, b in episodes(flags, gap)), default=0)  # noqa: E731
    for t in tids:
        seen = [any(b[4] == t for b in gt[i]) for i in frames]
        hit = [t in res[k][0] for k in range(n)]
        gl, ml = longest(seen), longest(hit)
        if gl >= need[3] and ml >= need[3]:
            # time to alert: from the person's first frame in view to the end of the frame on which the
            # model's (gap-bridged) episode for that person first reaches 3 s
            first = seen.index(True)
            a0 = next(a for a, b in episodes(hit, gap) if b - a + 1 >= need[3])
            acc["lat"].append((a0 + need[3] - first) / fps)
        ctr = [((b[0] + b[2]) / 2) for i in frames for b in gt[i] if b[4] == t]
        moving = bool(ctr) and max(abs(x - ctr[0]) for x in ctr) >= MOVING_FRAC
        for s in (3, 1):
            if gl >= need[s]:
                acc[f"p{s}"] += 1
                acc[f"h{s}"] += ml >= need[s]
        if moving and gl >= need[3]:
            acc["mp"] += 1
            acc["mh"] += ml >= need[3]
    present = [bool(gt[i]) for i in frames]
    tp = [bool(res[k][0]) for k in range(n)]
    if longest(present) >= need[3]:
        acc["pp"] += 1
        acc["ph"] += longest(tp) >= need[3]
    fp = [res[k][1] for k in range(n)]
    acc["fa"] += sum(1 for a, b in episodes(fp, gap) if b - a + 1 >= need[3])
    acc["sec"] += n / fps


def main():
    os.nice(19)
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--a", default="yolox-nano__full__960__t2__entry")
    ap.add_argument("--b", default="rtmdet-tiny__full__960__t2__entry")
    ap.add_argument("--ta", type=float, default=0.55)
    ap.add_argument("--tb", type=float, default=0.30)
    ap.add_argument("--cost-a", type=float, default=152.0, help="ms per A inference (1 thread, this host)")
    ap.add_argument("--cost-b", type=float, default=620.0, help="ms per B inference (1 thread, this host)")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--out", default="combine.json")
    a = ap.parse_args()
    man = {c["id"]: c for c in json.load(open(os.path.join(a.work, "manifest.json")))["clips"]}
    gt = json.load(open(os.path.join(a.work, "labels", "gt.json")))["clips"]
    A = load_jsonl(os.path.join(a.work, "runs", a.a, "dets.jsonl"))
    B = load_jsonl(os.path.join(a.work, "runs", a.b, "dets.jsonl"))
    sim = Sim(A, B, a.ta, a.tb, a.cost_a, a.cost_b)
    step = int(round(4 / a.fps))
    sets = {"day+evening": [], "night": []}
    for cid, g in gt.items():
        c = man.get(cid)
        if not c or c["gate"] != "ENTRY" or (cid, 0) not in A or (cid, 0) not in B:
            continue
        sets["night" if c.get("light") == "night" else "day+evening"].append(cid)
    plans = [("A", None, f"YOLOX-Nano 960 @{a.ta}"), ("B", None, f"RTMDet-tiny 960 @{a.tb}"),
             ("UNION", None, f"UNION: A@{a.ta} or B@{a.tb}, both every frame")]
    plans += [("LOWRATE", r, f"UNION-LOWRATE: A@{a.ta} every frame, B@{a.tb} at {r} fps") for r in (0.5, 1.0)]
    plans += [("CASCADE-A", r, f"CASCADE-A: A@{a.ta} every frame, B@{a.tb} at {r} fps when A empty") for r in (0.5, 1.0, 2.0)]
    plans += [("CASCADE-B", (tl, tc), f"CASCADE-B: A@{tl} candidates confirmed by B@{tc}")
              for tl in (0.30, 0.20) for tc in (0.15, 0.20, 0.30)]
    out = []
    for kind, param, label in plans:
        row = {"strategy": label, "kind": kind, "param": param, "fps": a.fps}
        for sname, cids in sets.items():
            acc = dict(p3=0, h3=0, p1=0, h1=0, mp=0, mh=0, pp=0, ph=0, fa=0, sec=0.0, ms=0.0, lat=[])
            for cid in sorted(cids):
                frames = list(range(0, man[cid]["frames"], step))
                res, ms = sim.run(kind, cid, frames, gt[cid]["frames"], step, param)
                gap_s = (1 / param - 1 / a.fps) if kind in ("CASCADE-A", "LOWRATE") else 0.5
                score_clip(res, gt[cid]["frames"], frames, a.fps, acc, max(0.5, gap_s))
                acc["ms"] += ms
            acc["cores"] = round(acc["ms"] / acc["sec"] / 1000, 2) if acc["sec"] else None
            lat = sorted(acc["lat"])
            acc["lat_median"] = lat[len(lat) // 2] if lat else None
            acc["lat_max"] = lat[-1] if lat else None
            acc["clips"] = len(cids)
            row[sname] = acc
        out.append(row)
    p = os.path.join(a.work, a.out)
    json.dump(out, open(p, "w"), indent=1)
    os.chmod(p, 0o600)
    f = lambda h, n: f"{h}/{n}" if n else "-"  # noqa: E731
    print(f"processing rate {a.fps} fps; CPU from 1-thread means A {a.cost_a} ms, B {a.cost_b} ms per inference\n")
    for sname in sets:
        print(f"#### {sname} ({out[0][sname]['clips']} clips, {out[0][sname]['sec'] / 60:.1f} min)\n")
        print("| Strategy | Person recall >=3 s | Walking-through >=3 s | Person recall >=1 s | Passage recall >=3 s | False-alarm episodes (per h) | Time to alert median / max (s) | CPU cores per gate |")
        print("|---|---|---|---|---|---|---|---|")
        for r in out:
            x = r[sname]
            fah = f"{x['fa']} ({x['fa'] / x['sec'] * 3600:.0f}/h)" if x["sec"] else "-"
            lt = f"{x['lat_median']:.1f} / {x['lat_max']:.1f}" if x["lat_median"] is not None else "-"
            print(f"| {r['strategy']} | {f(x['h3'], x['p3'])} | {f(x['mh'], x['mp'])} | {f(x['h1'], x['p1'])} | "
                  f"{f(x['ph'], x['pp'])} | {fah} | {lt} | {x['cores']} |")
        print()


if __name__ == "__main__":
    main()

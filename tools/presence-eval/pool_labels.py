#!/usr/bin/env python3
"""Pooled ground truth for P1: pool every candidate's full-picture detections and the Grounding
DINO pre-labels, link them into tracks, propose a label per track, render contact sheets for a
human check, and (with --decisions) write labels/gt.json. OFFLINE ONLY.

Runs in presence-p1-torch (needs Pillow):
  # 1) pool + sheets (review/<gate>/sheet-NN.jpg: one tile per track, default label printed)
  python pool_labels.py --work /work --gate ENTRY
  # 2) after looking at the sheets, write overrides {"<clip>#<track>": "person"|"no"} to
  #    labels/decisions-<gate>.json and build the ground truth
  python pool_labels.py --work /work --gate ENTRY --decisions labels/decisions-entry.json --write-gt

Default label: person if Grounding DINO scored the track >= --gdino-person at any 1 fps keyframe,
or >= 3 different models detected it on >= 25% of its frames; otherwise "no". Every track of
>= 4 frames (1 s) is shown on a sheet so the default can be overridden by eye. Ground-truth boxes
per frame are the pooled boxes of person tracks; gaps inside a person track (all sources missed)
are filled by linear interpolation, because the person was still there.
Sheets are crops of people (biometric): keep them under the 0700 work dir and delete them after review.
"""
import argparse
import glob
import json
import os
from collections import defaultdict

from PIL import Image, ImageDraw


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0.0


def load(path):
    out = {}
    for line in open(path):
        r = json.loads(line)
        out[(r["c"], r["i"])] = r["d"]
    return out


def pool_clip(clip, sources, gd, cand_thr, gd_thr):
    """Return tracks: list of dicts {frames: {i: box}, src: {name: nframes}, gd: max score}."""
    n = clip["frames"]
    tracks = []
    active = []
    for i in range(n):
        boxes = []
        for name, rows in sources.items():
            for d in rows.get((clip["id"], i), []):
                if d[4] >= cand_thr:
                    boxes.append((d, name))
        for d in gd.get((clip["id"], i), []):
            if d[4] >= gd_thr:
                boxes.append((d, "gdino"))
        boxes.sort(key=lambda t: -t[0][4])
        clusters = []
        for d, name in boxes:
            for c in clusters:
                if iou(c["ref"], d) >= 0.45:
                    c["m"].append((d, name))
                    break
            else:
                clusters.append({"ref": d, "m": [(d, name)]})
        for c in clusters:
            ws = [m[0][4] for m in c["m"]]
            box = [sum(m[0][k] * w for m, w in zip(c["m"], ws)) / sum(ws) for k in range(4)]
            c["box"] = box
            c["srcs"] = {m[1] for m in c["m"]}
            c["gd"] = max([m[0][4] for m in c["m"] if m[1] == "gdino"], default=0.0)
        # associate with active tracks
        used = set()
        pairs = sorted(((iou(t["last"], c["box"]), ti, ci) for ti, t in enumerate(active)
                        for ci, c in enumerate(clusters)), reverse=True)
        assigned_t = set()
        for v, ti, ci in pairs:
            if v < 0.3 or ti in assigned_t or ci in used:
                continue
            assigned_t.add(ti)
            used.add(ci)
            t = active[ti]
            c = clusters[ci]
            t["frames"][i] = c["box"]
            t["last"] = c["box"]
            t["lastI"] = i
            for s in c["srcs"]:
                t["src"][s] += 1
            t["gd"] = max(t["gd"], c["gd"])
        for ci, c in enumerate(clusters):
            if ci in used:
                continue
            t = {"frames": {i: c["box"]}, "last": c["box"], "lastI": i, "src": defaultdict(int), "gd": c["gd"]}
            for s in c["srcs"]:
                t["src"][s] += 1
            active.append(t)
            tracks.append(t)
        active = [t for t in active if i - t["lastI"] <= 4]
    for k, t in enumerate(tracks):
        t["id"] = k
        t["n"] = len(t["frames"])
        t["first"], t["lastF"] = min(t["frames"]), max(t["frames"])
    return tracks


def default_label(t, gd_person):
    if t["gd"] >= gd_person:
        return "person"
    models = {s.split("__")[0] for s, k in t["src"].items() if s != "gdino" and k >= 0.25 * t["n"]}
    return "person" if len(models) >= 3 else "no"


def sheets(work, gate, clips, all_tracks, labels, out_dir, per_sheet=40, cols=8, tile=200):
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "*.jpg")):
        os.remove(f)
    items = [(c, t) for c in clips for t in all_tracks[c["id"]] if t["n"] >= 4]
    index = []
    for s in range(0, len(items), per_sheet):
        chunk = items[s:s + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tile, rows * (tile + 28)), (30, 30, 30))
        dr = ImageDraw.Draw(sheet)
        for k, (c, t) in enumerate(chunk):
            fi = sorted(t["frames"])[len(t["frames"]) // 2]
            b = t["frames"][fi]
            im = Image.open(os.path.join(work, "frames", c["id"], f"{fi:05d}.jpg"))
            W, H = im.size
            bw, bh = (b[2] - b[0]) * W, (b[3] - b[1]) * H
            cx, cy = (b[0] + b[2]) / 2 * W, (b[1] + b[3]) / 2 * H
            side = max(bw, bh) * 1.3 + 16
            crop = im.crop((int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2)))
            crop = crop.resize((tile, tile))
            d2 = ImageDraw.Draw(crop)
            sx = tile / side
            d2.rectangle([(b[0] * W - (cx - side / 2)) * sx, (b[1] * H - (cy - side / 2)) * sx,
                          (b[2] * W - (cx - side / 2)) * sx, (b[3] * H - (cy - side / 2)) * sx],
                         outline=(255, 255, 0), width=1)
            x0, y0 = (k % cols) * tile, (k // cols) * (tile + 28)
            sheet.paste(crop, (x0, y0))
            key = f"{c['id']}#{t['id']}"
            lab = labels[key]
            col = (60, 220, 60) if lab == "person" else (240, 70, 70)
            nm = len({s.split('__')[0] for s in t['src'] if s != 'gdino'})
            dr.text((x0 + 3, y0 + tile + 1), f"{s // per_sheet:02d}-{k:02d} {c['id'][:3]}#{t['id']} {lab}", fill=col)
            dr.text((x0 + 3, y0 + tile + 14), f"n{t['n']} g{t['gd']:.2f} m{nm} {int(bw)}x{int(bh)}px", fill=(200, 200, 200))
            index.append({"tile": f"{s // per_sheet:02d}-{k:02d}", "key": key, "default": lab, "n": t["n"],
                          "gd": round(t["gd"], 3), "models": nm, "frame": fi,
                          "box": [round(v, 4) for v in b]})
        p = os.path.join(out_dir, f"sheet-{s // per_sheet:02d}.jpg")
        sheet.save(p, quality=88)
        os.chmod(p, 0o600)
    json.dump(index, open(os.path.join(out_dir, "index.json"), "w"), indent=0)
    return index


def interp_frames(t, n):
    fr = dict(t["frames"])
    ks = sorted(fr)
    for a, b in zip(ks, ks[1:]):
        if b - a > 1 and b - a <= 9:
            for i in range(a + 1, b):
                w = (i - a) / (b - a)
                fr[i] = [fr[a][k] * (1 - w) + fr[b][k] * w for k in range(4)]
    return fr


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/work")
    ap.add_argument("--gate", default="ENTRY")
    ap.add_argument("--runs", default="runs/*__full__*")
    ap.add_argument("--gdino", default="labels/gdino-base-1fps.jsonl")
    ap.add_argument("--cand-thr", type=float, default=0.3)
    ap.add_argument("--gdino-thr", type=float, default=0.25)
    ap.add_argument("--gdino-person", type=float, default=0.35)
    ap.add_argument("--decisions", default="")
    ap.add_argument("--write-gt", action="store_true")
    a = ap.parse_args()
    man = json.load(open(os.path.join(a.work, "manifest.json")))
    clips = [c for c in man["clips"] if c["set"] == "nvr" and c["gate"] == a.gate]
    sources = {}
    for rd in sorted(glob.glob(os.path.join(a.work, a.runs))):
        name = os.path.basename(rd)
        if name.endswith("timing") or "sanity" in name or not os.path.exists(os.path.join(rd, "dets.jsonl")):
            continue
        rows = load(os.path.join(rd, "dets.jsonl"))
        if any(k[0] == clips[0]["id"] for k in rows):
            sources[name] = rows
    gd = load(os.path.join(a.work, a.gdino))
    print(f"sources: {sorted(sources)} + gdino ({len(gd)} keyframes)")
    all_tracks = {c["id"]: pool_clip(c, sources, gd, a.cand_thr, a.gdino_thr) for c in clips}
    labels = {f"{cid}#{t['id']}": default_label(t, a.gdino_person) for cid, ts in all_tracks.items() for t in ts}
    over = json.load(open(os.path.join(a.work, a.decisions))) if a.decisions else {}
    labels.update(over)
    out_dir = os.path.join(a.work, "review", a.gate.lower())
    idx = sheets(a.work, a.gate, clips, all_tracks, labels, out_dir)
    n_person = sum(1 for k, v in labels.items() if v == "person")
    print(f"{sum(len(v) for v in all_tracks.values())} tracks, {len(idx)} on sheets, {n_person} person; overrides {len(over)}")
    if not a.write_gt:
        return
    gt_path = os.path.join(a.work, "labels", "gt.json")
    gt = json.load(open(gt_path)) if os.path.exists(gt_path) else {"schemaVersion": 1, "clips": {}}
    for c in clips:
        frames = [[] for _ in range(c["frames"])]
        for t in all_tracks[c["id"]]:
            if labels[f"{c['id']}#{t['id']}"] != "person":
                continue
            for i, b in interp_frames(t, c["frames"]).items():
                frames[i].append([round(v, 4) for v in b])
        gt["clips"][c["id"]] = {
            "gate": c["gate"], "light": c.get("light"),
            "source": "pooled candidates + Grounding DINO base 1 fps, tracks checked by eye",
            "personTracks": sum(1 for t in all_tracks[c["id"]] if labels[f"{c['id']}#{t['id']}"] == "person"),
            "frames": frames,
        }
    gt["overrides"] = {**gt.get("overrides", {}), **over}
    json.dump(gt, open(gt_path, "w"))
    os.chmod(gt_path, 0o600)
    print(f"wrote {gt_path}")


if __name__ == "__main__":
    main()

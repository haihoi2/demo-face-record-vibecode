#!/usr/bin/env python3
"""Build the P1 presence-evaluation manifest and extract 4 fps frames.

    python3 tools/presence-eval/extract_frames.py --work /data/test-clips/presence-p1 [--sets nvr,scripted] [--fps 4]

Inputs (biometric footage, read-only, never copied off this host):
  /data/test-clips/nvr/NNN-<gate>-<channel>-<startUtc>.mp4 + /data/test-clips/candidates.json (weak labels)
  /data/test-clips/scripted/{entry,exit}-{sequence,empty}.mp4 + scripted/clips.json (exact passage labels)

Outputs under --work (create it 0700; frames are biometric derivatives - delete them when done):
  manifest.json                     clips, sampled frame times, passages, gate areas
  frames/<clipId>/NNNNN.jpg         frame i is the picture at t = i / fps seconds

NVR frames are stored 1920 px wide (entry 4K is downscaled; exit is native 1920x1080). Scripted
frames are stored 1280 px wide (synthetic tiles on a flat background, see the report).
"""
import argparse
import glob
import json
import os
import subprocess
import sys

CLIPS = "/data/test-clips"
# Live gate areas (INT, 2026-10-02, from the running gateway's log), in source pixels.
GATE_AREAS = {
    "ENTRY": {"src": [3840, 2160], "x": 363, "y": 792, "w": 3408, "h": 456},
    "EXIT": {"src": [1920, 1080], "x": 0, "y": 0, "w": 1920, "h": 1080},
}


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "format=duration:stream=width,height", "-of", "json", path],
        check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    return float(j["format"]["duration"]), int(s["width"]), int(s["height"])


def gate_area_frac(gate):
    g = GATE_AREAS[gate]
    sw, sh = g["src"]
    return [g["x"] / sw, g["y"] / sh, g["w"] / sw, g["h"] / sh]


def nvr_clips():
    cands = json.load(open(os.path.join(CLIPS, "candidates.json")))["candidates"]
    by_key = {f"{c['gate'].lower()}-{c['nvrChannel']}-{c['startUtc']}": c for c in cands}
    out = []
    for f in sorted(glob.glob(os.path.join(CLIPS, "nvr", "[0-9][0-9][0-9]-*.mp4"))):
        base = os.path.basename(f)[:-4]
        key = base[4:]
        c = by_key.get(key)
        if c is None:
            print(f"skip {base}: no candidates.json entry", file=sys.stderr)
            continue
        dur, w, h = probe(f)
        people = int(c.get("peopleWeak") or 0)
        out.append({
            "id": base, "set": "nvr", "file": f, "gate": c["gate"], "light": c.get("light"),
            "outcome": c.get("outcome"), "durationS": dur, "width": w, "height": h,
            "storeWidth": 1920,
            # The whole clip is one passage window; weak label = people the access log saw.
            "passages": [{"id": base, "startS": 0.0, "endS": dur, "weakPeople": people,
                          "labelQuality": "weak"}],
        })
    return out


def scripted_clips():
    meta = json.load(open(os.path.join(CLIPS, "scripted", "clips.json")))
    out = []
    for c in meta["clips"]:
        f = os.path.join(CLIPS, "scripted", c["file"])
        dur, w, h = probe(f)
        out.append({
            "id": c["id"], "set": "scripted", "file": f, "gate": c["gate"], "light": "synthetic",
            "durationS": dur, "width": w, "height": h, "storeWidth": 1280,
            "passages": [{"id": p["id"], "startS": p["startS"], "endS": p["endS"],
                          "weakPeople": len(p["people"]), "labelQuality": "exact-passage",
                          "tags": p.get("tags", [])} for p in c["passages"]],
        })
    for gate in ("entry", "exit"):
        f = os.path.join(CLIPS, "scripted", f"{gate}-empty.mp4")
        dur, w, h = probe(f)
        out.append({
            "id": f"scripted-{gate}-empty", "set": "scripted", "file": f, "gate": gate.upper(),
            "light": "synthetic", "durationS": dur, "width": w, "height": h, "storeWidth": 1280,
            "passages": [{"id": f"scripted-{gate}-empty", "startS": 0.0, "endS": dur,
                          "weakPeople": 0, "labelQuality": "exact-passage", "tags": ["empty"]}],
        })
    return out


def extract(clip, work, fps):
    d = os.path.join(work, "frames", clip["id"])
    os.makedirs(d, mode=0o700, exist_ok=True)
    n_expected = int(clip["durationS"] * fps)
    have = len(glob.glob(os.path.join(d, "*.jpg")))
    if have >= n_expected:
        return sorted(glob.glob(os.path.join(d, "*.jpg")))
    cmd = ["nice", "-n", "19", "ffmpeg", "-v", "error", "-threads", "4", "-i", clip["file"],
           "-vf", f"fps={fps},scale={clip['storeWidth']}:-2:flags=area", "-q:v", "2",
           "-start_number", "0", "-y", os.path.join(d, "%05d.jpg")]
    subprocess.run(cmd, check=True)
    return sorted(glob.glob(os.path.join(d, "*.jpg")))


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.path.join(CLIPS, "presence-p1"))
    ap.add_argument("--sets", default="nvr,scripted")
    ap.add_argument("--fps", type=float, default=4.0)
    a = ap.parse_args()
    os.makedirs(a.work, mode=0o700, exist_ok=True)
    clips = []
    sets = a.sets.split(",")
    if "nvr" in sets:
        clips += nvr_clips()
    if "scripted" in sets:
        clips += scripted_clips()
    for c in clips:
        frames = extract(c, a.work, a.fps)
        c["fps"] = a.fps
        c["frames"] = len(frames)
        c["storeHeight"] = round(c["height"] * c["storeWidth"] / c["width"] / 2) * 2
        c["gateArea"] = gate_area_frac(c["gate"])
        print(f"{c['id']}: {len(frames)} frames", flush=True)
    man = {"schemaVersion": 1, "fps": a.fps, "gateAreas": GATE_AREAS, "clips": clips}
    p = os.path.join(a.work, "manifest.json")
    with open(p, "w") as f:
        json.dump(man, f, indent=1)
    os.chmod(p, 0o600)
    print(f"wrote {p}: {len(clips)} clips, {sum(c['frames'] for c in clips)} frames")


if __name__ == "__main__":
    main()

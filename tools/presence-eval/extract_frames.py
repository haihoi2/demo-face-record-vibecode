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
import datetime
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


def extra_clips(work):
    """Extra NVR exports from INT: <work>/night/clips/<gate>-<channel>-<startUtc>.mp4. Scored with the
    real NVR set (set "nvr"); ground truth comes from the same pooled review."""
    out = []
    for f in sorted(glob.glob(os.path.join(work, "night", "clips", "*.mp4"))):
        base = os.path.basename(f)[:-4]
        gate = base.split("-")[0].upper()
        dur, w, h = probe(f)
        hour = int(base.split("T")[1][:2])
        out.append({
            "id": "x-" + base, "set": "nvr", "file": f, "gate": gate,
            "light": "evening" if 10 <= hour < 15 else "day" if hour < 10 else "night",
            "outcome": "int-export", "durationS": dur, "width": w, "height": h, "storeWidth": 1920,
            "passages": [{"id": "x-" + base, "startS": 0.0, "endS": dur, "weakPeople": 0, "labelQuality": "image-checked"}],
        })
    return out


def night_clips(work):
    """INT's night stills: <work>/night/<gate>/<UTC stamp>.jpg, one frame every few seconds, lights off
    (IR). Treated as person-free clips (checked by eye) for the night false-alarm count."""
    out = []
    for gate in ("entry", "exit"):
        files = sorted(glob.glob(os.path.join(work, "night", gate, "*.jpg")))
        if not files:
            continue
        stamps = [datetime.datetime.strptime(os.path.basename(f)[:16], "%Y%m%dT%H%M%SZ") for f in files]
        gaps = sorted((b - a).total_seconds() for a, b in zip(stamps, stamps[1:])) or [5.0]
        step = gaps[len(gaps) // 2]
        _, w, h = probe(files[0])
        cid = f"night-{gate}"
        out.append({
            "id": cid, "set": "night", "file": os.path.join(work, "night", gate), "gate": gate.upper(),
            "light": "night-ir", "durationS": step * len(files), "width": w, "height": h, "storeWidth": 1920,
            "stillStepS": step, "times": [os.path.basename(f)[:16] for f in files],
            "passages": [{"id": cid, "startS": 0.0, "endS": step * len(files), "weakPeople": 0,
                          "labelQuality": "assumed-empty, checked by eye"}],
        })
    return out


def extract_stills(clip, work):
    d = os.path.join(work, "frames", clip["id"])
    os.makedirs(d, mode=0o700, exist_ok=True)
    for f in glob.glob(os.path.join(d, "*.jpg")):
        os.remove(f)
    cmd = ["nice", "-n", "19", "ffmpeg", "-v", "error", "-threads", "2", "-pattern_type", "glob",
           "-i", os.path.join(clip["file"], "*.jpg"), "-vf", f"scale={clip['storeWidth']}:-2:flags=area",
           "-q:v", "2", "-start_number", "0", "-y", os.path.join(d, "%05d.jpg")]
    subprocess.run(cmd, check=True)
    return sorted(glob.glob(os.path.join(d, "*.jpg")))


def extract(clip, work, fps):
    d = os.path.join(work, "frames", clip["id"])
    os.makedirs(d, mode=0o700, exist_ok=True)
    n_expected = int(clip["durationS"] * fps)
    have = len(glob.glob(os.path.join(d, "*.jpg")))
    if have >= n_expected:
        return sorted(glob.glob(os.path.join(d, "*.jpg")))
    cmd = ["nice", "-n", "19", "ffmpeg", "-v", "error", "-threads", "2", "-i", clip["file"],
           "-vf", f"fps={fps},scale={clip['storeWidth']}:-2:flags=area", "-q:v", "2",
           "-start_number", "0", "-y", os.path.join(d, "%05d.jpg")]
    subprocess.run(cmd, check=True)
    return sorted(glob.glob(os.path.join(d, "*.jpg")))


def main():
    os.nice(19)  # shared host with the live gateway: lowest CPU priority
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.path.join(CLIPS, "presence-p1"))
    ap.add_argument("--sets", default="nvr,scripted", help="nvr, scripted, night (INT's IR stills), extra (INT's extra NVR exports)")
    ap.add_argument("--fps", type=float, default=4.0)
    ap.add_argument("--add", action="store_true",
                    help="merge into the existing manifest: extract only clips not in it yet (frames of the old "
                         "clips may already be deleted)")
    a = ap.parse_args()
    os.makedirs(a.work, mode=0o700, exist_ok=True)
    clips = []
    sets = a.sets.split(",")
    if "nvr" in sets:
        clips += nvr_clips()
    if "scripted" in sets:
        clips += scripted_clips()
    if "night" in sets:
        clips += night_clips(a.work)
    if "extra" in sets:
        clips += extra_clips(a.work)
    old = {}
    mp = os.path.join(a.work, "manifest.json")
    if a.add and os.path.exists(mp):
        old = {c["id"]: c for c in json.load(open(mp))["clips"]}
        clips = [c for c in clips if c["id"] not in old]
    for c in clips:
        frames = extract_stills(c, a.work) if c["set"] == "night" else extract(c, a.work, a.fps)
        c["fps"] = 1 / c["stillStepS"] if c["set"] == "night" else a.fps
        c["frames"] = len(frames)
        c["storeHeight"] = round(c["height"] * c["storeWidth"] / c["width"] / 2) * 2
        c["gateArea"] = gate_area_frac(c["gate"])
        print(f"{c['id']}: {len(frames)} frames", flush=True)
    if a.add:
        clips = list(old.values()) + clips
    man = {"schemaVersion": 1, "fps": a.fps, "gateAreas": GATE_AREAS, "clips": clips}
    p = os.path.join(a.work, "manifest.json")
    with open(p, "w") as f:
        json.dump(man, f, indent=1)
    os.chmod(p, 0o600)
    print(f"wrote {p}: {len(clips)} clips, {sum(c['frames'] for c in clips)} frames")


if __name__ == "__main__":
    main()

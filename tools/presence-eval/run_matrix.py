#!/usr/bin/env python3
"""Run the P1 model matrix one job at a time in the repo's tester image (onnxruntime-node 1.30).

    python3 tools/presence-eval/run_matrix.py --plan accuracy-entry [--cpus 4] [--dry-run]
    python3 tools/presence-eval/run_matrix.py --plan timing

Plans:
  accuracy-<gate>  every model x input on the full picture (and the gate area for ENTRY, dynamic-
                   shape models only), --threads intra-op threads (default 2), all frames of that gate -> runs/<model>__<view>__<input>__t4__<gate>
  timing           every model x input, intra-op threads 1 and 2, first 200 frames of the NVR clips
                   (after 10 warm-up frames), no detections written -> runs/...__timing
Prerequisites: docker images presence-p1-tester (docker build --target tester -t presence-p1-tester .),
frames + manifest (extract_frames.py), ONNX files in --models (export_*.py, convert_effdet.py).
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)


def jobs(plan, models, threads=2):
    out = []
    if plan.startswith("accuracy-"):
        gate = plan.split("-", 1)[1].upper()
        for m in models:
            for inp in m["inputs"]:
                # Gate-area crops only for dynamic-shape models: a static square input would just
                # letterbox the thin strip. Full-picture runs are also scored as "full+zone".
                views = ["full", "gate"] if gate == "ENTRY" and "width" in inp else ["full"]
                for v in views:
                    # The scripted set is synthetic (face tiles on a flat background): full picture only.
                    out.append(dict(model=m["id"], input=inp["key"], view=v, threads=threads, gates=gate,
                                    tag=gate.lower(), extra=["--sets", "nvr"] if v == "gate" else []))
    elif plan == "timing":
        for m in models:
            for inp in m["inputs"]:
                for t in (1, 2):
                    out.append(dict(model=m["id"], input=inp["key"], view="full", threads=t, gates="ENTRY,EXIT",
                                    tag="timing", extra=["--sets", "nvr", "--limit", "200", "--warmup", "10",
                                                         "--no-dets"]))
    else:
        raise SystemExit(f"unknown plan {plan}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--work", default="/data/test-clips/presence-p1")
    ap.add_argument("--models", default="/data/models/candidates/presence")
    ap.add_argument("--image", default="presence-p1-tester")
    # Shared host with the LIVE gateway: INT caps all P1 containers together at 2.5 CPUs, nice 19,
    # one heavy job at a time (2026-10-02, after P1 jobs starved the live camera streams).
    ap.add_argument("--cpus", default="2.5")
    ap.add_argument("--nvr-only", default="", help="models run on the real footage only (skip the synthetic set)")
    ap.add_argument("--threads", type=int, default=2, help="intra-op threads for accuracy plans")
    ap.add_argument("--only", default="", help="comma list of model ids")
    ap.add_argument("--skip-done", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if float(a.cpus) > 2.5:
        raise SystemExit("--cpus above 2.5 is not allowed on the shared host")
    models = json.load(open(os.path.join(HERE, "models.json")))["models"]
    if a.only:
        models = [m for m in models if m["id"] in a.only.split(",")]
    uid = f"{os.getuid()}:{os.getgid()}"
    for j in jobs(a.plan, models, a.threads):
        name = "__".join([j["model"], j["view"], j["input"], f"t{j['threads']}", j["tag"]])
        if a.skip_done and os.path.exists(os.path.join(a.work, "runs", name, "summary.json")):
            print(f"skip {name}", flush=True)
            continue
        if not os.path.exists(os.path.join(a.models, next(i["file"] for m in models if m["id"] == j["model"]
                                                            for i in m["inputs"] if i["key"] == j["input"]))):
            print(f"missing model file for {name}; skipped", flush=True)
            continue
        if j["model"] in a.nvr_only.split(",") and "--sets" not in j["extra"]:
            j["extra"] = j["extra"] + ["--sets", "nvr"]
        cmd = ["docker", "run", "--rm", "--cpus", a.cpus, "--cpu-shares", "128", "-u", uid, "-e", "HOME=/tmp",
               "-v", f"{a.work}:/work", "-v", f"{a.models}:/models:ro", "-v", f"{TOOLS}:/app/tools:ro", a.image,
               "nice", "-n", "19", "node", "--import", "tsx", "tools/presence-eval/run-models.ts", "--work", "/work", "--models", "/models",
               "--model", j["model"], "--input", j["input"], "--view", j["view"], "--threads", str(j["threads"]),
               "--gates", j["gates"], "--tag", j["tag"], *j["extra"]]
        print("+", name, flush=True)
        if a.dry_run:
            continue
        r = subprocess.run(cmd, capture_output=True, text=True)
        last = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
        print(last[-1][:300] if last else r.stderr[-800:], flush=True)
        if r.returncode != 0:
            print(f"FAILED {name} rc={r.returncode}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()

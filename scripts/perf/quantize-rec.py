#!/usr/bin/env python3
"""Static INT8 (QDQ, U8S8, per-channel) of ANY ArcFace-style recogniser, with the
knobs PERF's first pass did not try (real-time pipeline, CALIB).

Throwaway container only (never the app image):

  docker run --rm --cpus 2 -v /data/models:/models -v <crops>/calib:/calib:ro -v <pylib>:/pylib \
    -v <repo>/scripts/perf:/scripts:ro -e PYTHONPATH=/pylib python:3.12-slim \
    python /scripts/quantize-rec.py --model /models/w600k_r50.onnx --out /models/candidates/w600k_r50_q.onnx \
      --method percentile --percentile 99.99 --limit 400 --keep-heads-fp32 --exclude-first

Calibration inputs: /calib/rec_*.u8 (112x112x3 uint8 RGB from scripts/perf/calib-crops.ts).
Normalisation matches faceEmbedding.ts embedFace(): (px - 127.5) / 127.5, NCHW.

Options beyond quantize.py: any --model/--out, --exclude-first (keep the stem
conv FP32), --exclude <node,...>, --limit up to the whole calibration set,
--op-types (default Conv,MatMul,Gemm), --reduce-range. Imports fix_batch /
output_heads / U8Reader / sha256 / input_name from quantize.py (same dir).
"""

import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import onnx  # noqa: E402
from onnxruntime.quantization import CalibrationMethod, QuantFormat, QuantType, quantize_static  # noqa: E402
from onnxruntime.quantization.shape_inference import quant_pre_process  # noqa: E402

from quantize import METHODS, U8Reader, fix_batch, input_name, output_heads, sha256  # noqa: E402


def first_weighted_nodes(path, count=1):
    """The first `count` weighted nodes in topological order (the stem conv)."""
    m = onnx.load(path, load_external_data=False)
    out = []
    for n in m.graph.node:
        if n.op_type in ("Conv", "Gemm", "MatMul", "ConvTranspose"):
            out.append(n.name)
            if len(out) >= count:
                break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--calib", default="/calib")
    ap.add_argument("--method", default="minmax", choices=sorted(METHODS))
    ap.add_argument("--percentile", type=float, default=99.999)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--keep-heads-fp32", action="store_true")
    ap.add_argument("--exclude-first", type=int, default=0, help="keep the first N weighted nodes FP32")
    ap.add_argument("--exclude", default="", help="extra node names to keep FP32, comma separated")
    ap.add_argument("--op-types", default="Conv,MatMul,Gemm")
    ap.add_argument("--act", choices=["u8", "s8"], default="u8")
    ap.add_argument("--reduce-range", action="store_true")
    ap.add_argument("--no-moving-average", action="store_true")
    args = ap.parse_args()

    base = os.path.basename(args.model)[: -len(".onnx")]
    fixed = f"/tmp/{base}_b1.onnx"
    pre = f"/tmp/{base}_pre.onnx"
    fix_batch(args.model, fixed, 112)
    quant_pre_process(fixed, pre, skip_symbolic_shape=True)

    files = sorted(glob.glob(os.path.join(args.calib, "rec_*.u8")))
    if not files:
        print("no calibration crops", file=sys.stderr)
        sys.exit(2)
    reader = U8Reader(files, input_name(pre), 112, 127.5, 127.5, args.limit)

    exclude = set()
    if args.keep_heads_fp32:
        exclude.update(output_heads(pre))
    if args.exclude_first:
        exclude.update(first_weighted_nodes(pre, args.exclude_first))
    if args.exclude:
        exclude.update(x for x in args.exclude.split(",") if x)

    extra = {"CalibMovingAverage": args.method == "minmax" and not args.no_moving_average}
    if args.method == "percentile":
        extra["CalibPercentile"] = args.percentile
    if args.act == "s8":
        extra["ActivationSymmetric"] = True

    quantize_static(
        pre,
        args.out,
        reader,
        quant_format=QuantFormat.QDQ,
        op_types_to_quantize=[t for t in args.op_types.split(",") if t],
        per_channel=True,
        reduce_range=args.reduce_range,
        activation_type=QuantType.QInt8 if args.act == "s8" else QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=METHODS[args.method],
        nodes_to_exclude=sorted(exclude),
        extra_options=extra,
    )
    digest = sha256(args.out)
    with open(args.out + ".sha256", "w") as f:
        f.write(f"{digest}  {os.path.basename(args.out)}\n")
    print(
        f"{os.path.basename(args.out)}: {args.method}"
        f"{' p' + str(args.percentile) if args.method == 'percentile' else ''}, calibrated on {min(args.limit, len(files))}/{len(files)} crops,"
        f" {len(exclude)} nodes FP32, {os.path.getsize(args.out) / 1e6:.1f} MB, sha256={digest[:16]}"
    )


if __name__ == "__main__":
    main()

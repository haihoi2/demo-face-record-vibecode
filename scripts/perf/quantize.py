#!/usr/bin/env python3
"""INT8 variants of the SCRFD detector and ArcFace recogniser (real-time pipeline step 4).

Runs in a THROWAWAY container, never in the app image:

  docker run --rm --cpus 2 -v <models>:/models -v <calib>:/calib:ro -v <pylib>:/pylib \
    -e PYTHONPATH=/pylib python:3.12-slim python /scripts/quantize.py --mode static

  pip deps (install once into <pylib>): onnxruntime==1.23.* onnx numpy

Inputs : /models/det_10g.onnx, /models/w600k_r50.onnx (FP32 InsightFace buffalo_l)
         /calib/det_*.u8 (640x640x3 uint8), /calib/rec_*.u8 (112x112x3 uint8)
         produced by scripts/perf/dump-calib.ts from real gate captures.
Outputs: /models/det_10g_int8.onnx, /models/w600k_r50_int8.onnx (+ .sha256 next to each)

Static quantization: QDQ format, per-channel symmetric INT8 weights, UINT8
activations (U8S8, the VNNI fast path), calibration on the real crops with the
chosen method. `--mode dynamic` is the fallback (weights only, no calibration).
Normalisation matches src/server/faceEmbedding.ts exactly:
  detector   (px - 127.5) / 128.0, NCHW RGB
  recogniser (px - 127.5) / 127.5, NCHW RGB
"""

import argparse
import glob
import hashlib
import os
import re
import sys

import numpy as np
import onnx
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_dynamic,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process


SHAPE_RE = re.compile(r"_(\d+)x(\d+)\.u8$")


class U8Reader(CalibrationDataReader):
    """Calibration tensors: `<name>.u8` is size x size x 3; `<name>_<W>x<H>.u8` carries its
    own shape (scripts/perf/detect-input-eval.ts --dump-calib), for a dynamic-H/W export."""

    def __init__(self, files, input_name, size, mean, std, limit):
        self.files = sorted(files)[:limit]
        self.input_name = input_name
        self.size = size
        self.mean = mean
        self.std = std
        self.i = 0

    def get_next(self):
        if self.i >= len(self.files):
            return None
        f = self.files[self.i]
        raw = np.fromfile(f, dtype=np.uint8)
        self.i += 1
        m = SHAPE_RE.search(os.path.basename(f))
        w, h = (int(m.group(1)), int(m.group(2))) if m else (self.size, self.size)
        img = raw.reshape(h, w, 3).astype(np.float32)
        x = ((img - self.mean) / self.std).transpose(2, 0, 1)[None, ...]
        return {self.input_name: np.ascontiguousarray(x, dtype=np.float32)}

    def rewind(self):
        self.i = 0


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def input_name(path):
    m = onnx.load(path, load_external_data=False)
    inits = {i.name for i in m.graph.initializer}
    return [i.name for i in m.graph.input if i.name not in inits][0]


MIN_OPSET = 13  # per-channel QDQ (DequantizeLinear `axis`) needs opset >= 13


def fix_batch(src, dst, size, dynamic_hw=False):
    """Pin the symbolic batch dim to 1 (shape inference) and lift the opset to >= 13.

    buffalo_l's det_10g/w600k_r50 are older opsets; a per-channel QDQ model on
    those loads with "Unrecognized attribute: axis for operator DequantizeLinear".
    With dynamic_hw the spatial dims stay symbolic ("h", "w"): the export then
    takes any multiple of 32 per axis, like the FP32 det_10g (the real-time
    pipeline's aspect-preserving input for wide gate areas needs this).
    """
    m = onnx.load(src)
    opset = next((o.version for o in m.opset_import if o.domain in ("", "ai.onnx")), 0)
    if opset < MIN_OPSET:
        from onnx import version_converter

        m = version_converter.convert_version(m, MIN_OPSET)
        print(f"{os.path.basename(src)}: opset {opset} -> {MIN_OPSET}")
    inits = {i.name for i in m.graph.initializer}
    for inp in m.graph.input:
        if inp.name in inits:
            continue
        dims = inp.type.tensor_type.shape.dim
        dims[0].ClearField("dim_param")
        dims[0].dim_value = 1
        if size and len(dims) == 4:
            for d, v in zip(dims[1:], (3, size, size)):
                d.ClearField("dim_param")
                d.dim_value = v
            if dynamic_hw:
                for d, name in zip(dims[2:], ("h", "w")):
                    d.ClearField("dim_value")
                    d.dim_param = name
    onnx.save(m, dst)


METHODS = {
    "minmax": CalibrationMethod.MinMax,
    "percentile": CalibrationMethod.Percentile,
    "entropy": CalibrationMethod.Entropy,
}

WEIGHTED = {"Conv", "Gemm", "MatMul", "ConvTranspose"}


def output_heads(path):
    """Nodes between each graph output and the nearest weighted op (inclusive).

    SCRFD: the 9 score/bbox/landmark head convs (+ their reshapes/sigmoids) -
    landmark precision drives ArcFace alignment. ArcFace: the final
    BN -> Flatten -> Gemm -> BN embedding head. Keeping these in FP32 is the
    usual remedy when full INT8 drifts too far.
    """
    m = onnx.load(path, load_external_data=False)
    producer = {o: n for n in m.graph.node for o in n.output}
    inits = {i.name for i in m.graph.initializer}
    keep = set()
    stack = [o.name for o in m.graph.output]
    seen = set()
    while stack:
        t = stack.pop()
        if t in seen or t in inits:
            continue
        seen.add(t)
        n = producer.get(t)
        if n is None:
            continue
        keep.add(n.name)
        if n.op_type in WEIGHTED:
            continue
        stack.extend(n.input)
    return sorted(keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["static", "dynamic"], default="static")
    ap.add_argument("--models", default="/models")
    ap.add_argument("--calib", default="/calib")
    ap.add_argument("--which", default="det,rec")
    ap.add_argument("--method", default="minmax", choices=sorted(METHODS))
    ap.add_argument("--det-limit", type=int, default=64)
    ap.add_argument("--rec-limit", type=int, default=300)
    ap.add_argument("--suffix", default="_int8")
    ap.add_argument("--keep-heads-fp32", action="store_true", help="exclude the output heads from quantization")
    ap.add_argument("--percentile", type=float, default=99.999)
    ap.add_argument("--act", choices=["u8", "s8"], default="u8", help="activation type: u8 (U8S8) or s8 (S8S8, symmetric)")
    ap.add_argument("--dynamic-hw", action="store_true", help="keep the detector's H/W symbolic (calibration files may carry _WxH in their names)")
    args = ap.parse_args()

    jobs = {
        "det": ("det_10g.onnx", 640, 128.0, "det_*.u8", args.det_limit),
        "rec": ("w600k_r50.onnx", 112, 127.5, "rec_*.u8", args.rec_limit),
    }
    for key in args.which.split(","):
        name, size, std, pattern, limit = jobs[key]
        src = os.path.join(args.models, name)
        base = name[: -len(".onnx")]
        dst = os.path.join(args.models, f"{base}{args.suffix}.onnx")
        fixed = os.path.join("/tmp", f"{base}_b1.onnx")
        pre = os.path.join("/tmp", f"{base}_pre.onnx")
        fix_batch(src, fixed, size, dynamic_hw=args.dynamic_hw and key == "det")
        quant_pre_process(fixed, pre, skip_symbolic_shape=True)
        if args.mode == "dynamic":
            quantize_dynamic(pre, dst, weight_type=QuantType.QInt8, per_channel=True)
        else:
            files = glob.glob(os.path.join(args.calib, pattern))
            if not files:
                print(f"no calibration files for {key}", file=sys.stderr)
                sys.exit(2)
            reader = U8Reader(files, input_name(pre), size, 127.5, std, limit)
            exclude = output_heads(pre) if args.keep_heads_fp32 else []
            extra = {"CalibMovingAverage": args.method == "minmax"}
            if args.method == "percentile":
                extra["CalibPercentile"] = args.percentile
            if args.act == "s8":
                extra["ActivationSymmetric"] = True
            quantize_static(
                pre,
                dst,
                reader,
                quant_format=QuantFormat.QDQ,
                per_channel=True,
                activation_type=QuantType.QInt8 if args.act == "s8" else QuantType.QUInt8,
                weight_type=QuantType.QInt8,
                calibrate_method=METHODS[args.method],
                nodes_to_exclude=exclude,
                extra_options=extra,
            )
            print(
                f"{key}: calibrated on {min(limit, len(files))} of {len(files)} inputs ({args.method}),"
                f" {len(exclude)} head nodes kept FP32"
            )
        digest = sha256(dst)
        with open(dst + ".sha256", "w") as f:
            f.write(f"{digest}  {os.path.basename(dst)}\n")
        print(f"{key}: {dst} {os.path.getsize(dst) / 1e6:.1f} MB sha256={digest[:16]}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Export YOLOX-Nano / YOLOX-Tiny (Megvii, Apache-2.0) to a person-only ONNX. OFFLINE ONLY.

Weights: official .pth files from https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0
Code:    Megvii-BaseDetection/YOLOX @ the commit pinned in docker/torch.Dockerfile.

Output contract (shared by every P1 candidate, see run-models.ts):
  input  "images" float32 [1,3,H,W], BGR, 0..255, no normalisation (YOLOX legacy=False), pad 114
  output "dets"   float32 [1,N,5]   x1,y1,x2,y2 in input pixels, person score = obj * cls[person]
H and W are dynamic (multiples of 32); NMS is done by the caller.

  python export_yolox.py --name yolox-nano --ckpt /models/src/yolox_nano.pth --out /models/yolox_nano_person.onnx
"""
import argparse

import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from yolox.exp import get_exp


class PersonHead(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)  # [1,N,85]: cx,cy,w,h (pixels), obj, 80 class probs (sigmoid applied)
        cx, cy, w, h = o[..., 0], o[..., 1], o[..., 2], o[..., 3]
        s = o[..., 4] * o[..., 5]
        return torch.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, s], dim=-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    exp = get_exp(None, a.name)
    model = exp.get_model()
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    model.load_state_dict(ck["model"])
    model.eval()
    model.head.decode_in_inference = True
    w = PersonHead(model).eval()
    x = torch.rand(1, 3, 384, 640) * 255
    torch.onnx.export(w, x, a.out, input_names=["images"], output_names=["dets"], opset_version=17,
                      dynamic_axes={"images": {2: "h", 3: "w"}, "dets": {1: "n"}}, dynamo=False)
    # Verify the dynamic graph at shapes other than the trace shape.
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    for hh, ww in [(384, 640), (256, 416), (96, 640), (640, 640)]:
        t = torch.rand(1, 3, hh, ww) * 255
        with torch.no_grad():
            ref = w(t).numpy()
        got = sess.run(None, {"images": t.numpy()})[0]
        print(f"{a.name} {ww}x{hh}: N={got.shape[1]} max|diff|={np.abs(ref - got).max():.4g}")
        assert got.shape == ref.shape and np.abs(ref - got).max() < 1e-2


if __name__ == "__main__":
    main()

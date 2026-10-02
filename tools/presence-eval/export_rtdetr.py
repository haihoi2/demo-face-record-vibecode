#!/usr/bin/env python3
"""Export RT-DETR-R18 (official implementation, github.com/lyuwenyu/RT-DETR, Apache-2.0) to a
person-only ONNX. OFFLINE ONLY. Do NOT substitute the Ultralytics packaging (AGPL-3.0).

Weights: rtdetr_r18vd_dec3_6x_coco_from_paddle.pth from the repo's README (lyuwenyu/storage v0.1).
Output contract (see run-models.ts): input "images" float32 [1,3,640,640] RGB 0..1 (the harness
divides by 255); output "dets" [1,300,5] = x1,y1,x2,y2 (input pixels), sigmoid(person logit).
NMS-free (one-to-one DETR queries).

  python export_rtdetr.py --ckpt /models/src/rtdetr_r18vd_dec3_6x_coco_from_paddle.pth --out /models/rtdetr_r18_person.onnx
"""
import argparse
import sys

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

# The repo's rtdetrv2_pytorch tree runs on current torchvision and ships the v1 RT-DETR configs;
# rtdetr_pytorch (v1 tree) needs torchvision 0.15. Same R18 model and weights either way.
sys.path.insert(0, "/src/RT-DETR/rtdetrv2_pytorch")
from src.core import YAMLConfig  # noqa: E402

CONFIG = "/src/RT-DETR/rtdetrv2_pytorch/configs/rtdetr/rtdetr_r18vd_6x_coco.yml"
PERSON = 0  # remap_mscoco_category: label 0 = COCO category 1 "person"


class PersonDets(nn.Module):
    def __init__(self, m, size):
        super().__init__()
        self.m = m
        self.size = size

    def forward(self, x):
        o = self.m(x)
        b = o["pred_boxes"]  # [1,Q,4] cx,cy,w,h normalised
        s = torch.sigmoid(o["pred_logits"][..., PERSON])
        cx, cy, w, h = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
        W = H = float(self.size)
        return torch.stack([(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H, s], dim=-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=CONFIG)
    a = ap.parse_args()
    cfg = YAMLConfig(a.config)
    cfg.yaml_cfg["PResNet"]["pretrained"] = False  # do not download ImageNet backbone weights
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    state = ck["ema"]["module"] if "ema" in ck else ck["model"]
    cfg.model.load_state_dict(state)
    m = cfg.model.deploy().eval()
    w = PersonDets(m, 640).eval()
    x = torch.rand(1, 3, 640, 640)
    torch.onnx.export(w, x, a.out, input_names=["images"], output_names=["dets"], opset_version=17, dynamo=False)
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    with torch.no_grad():
        ref = w(x).numpy()
    got = sess.run(None, {"images": x.numpy()})[0]
    db = np.abs(ref[..., :4] - got[..., :4]).max()
    ds = np.abs(ref[..., 4] - got[..., 4]).max()
    print(f"rtdetr-r18: {got.shape} max|box diff|={db:.4g} px max|score diff|={ds:.4g}")
    assert got.shape == ref.shape and db < 0.5 and ds < 1e-3


if __name__ == "__main__":
    main()

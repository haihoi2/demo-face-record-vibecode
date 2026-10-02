#!/usr/bin/env python3
"""Export RTMDet-tiny (OpenMMLab mmdetection 3.3.0, Apache-2.0) to a person-only ONNX without
mmdeploy. OFFLINE ONLY. Runs in presence-p1-mm (docker/mm.Dockerfile).

Weights: https://download.openmmlab.com/mmdetection/v3.0/rtmdet/rtmdet_tiny_8xb32-300e_coco/
         rtmdet_tiny_8xb32-300e_coco_20220902_112414-78e30dcc.pth
Graph: backbone + neck + RTMDet head, then in-graph decode (point priors at stride multiples,
distances already scaled by stride) for the person class (label 0).
Output contract: input "images" float32 [1,3,H,W] BGR normalised with the config's mean/std
(the harness does it); output "dets" [1,N,5] = x1,y1,x2,y2 (input pixels), sigmoid(person).
H, W dynamic (multiples of 32). NMS by the caller. Checked against mmdet's own inference.

  python export_rtmdet.py --ckpt /models/src/rtmdet_tiny_...pth --out /models/rtmdet_tiny_person.onnx --check-image img.jpg
"""
import argparse
import os

import mmdet
import numpy as np
import onnxruntime as ort
import torch
from mmdet.apis import inference_detector, init_detector
from PIL import Image
from torch import nn

CFG = os.path.join(os.path.dirname(mmdet.__file__), ".mim", "configs", "rtmdet", "rtmdet_tiny_8xb32-300e_coco.py")
MEAN = [103.53, 116.28, 123.675]
STD = [57.375, 57.12, 58.395]


class PersonDets(nn.Module):
    def __init__(self, det):
        super().__init__()
        self.det = det
        self.strides = [s[0] if isinstance(s, (tuple, list)) else s for s in det.bbox_head.prior_generator.strides]

    def forward(self, x):
        feats = self.det.extract_feat(x)
        cls_scores, bbox_preds = self.det.bbox_head(feats)
        outs = []
        for cs, bp, s in zip(cls_scores, bbox_preds, self.strides):
            h, w = cs.shape[-2], cs.shape[-1]
            ys = torch.arange(h, dtype=torch.float32) * s
            xs = torch.arange(w, dtype=torch.float32) * s
            py = ys[:, None].expand(h, w).reshape(-1)
            px = xs[None, :].expand(h, w).reshape(-1)
            d = bp[0].reshape(4, -1)  # l,t,r,b in pixels
            score = torch.sigmoid(cs[0, 0].reshape(-1))
            outs.append(torch.stack([px - d[0], py - d[1], px + d[2], py + d[3], score], dim=-1))
        return torch.cat(outs, 0)[None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--check-image", required=True)
    a = ap.parse_args()
    det = init_detector(CFG, a.ckpt, device="cpu").eval()
    w = PersonDets(det).eval()
    x = torch.randn(1, 3, 384, 640)
    torch.onnx.export(w, x, a.out, input_names=["images"], output_names=["dets"], opset_version=17,
                      dynamic_axes={"images": {2: "h", 3: "w"}, "dets": {1: "n"}})
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    for hh, ww in [(384, 640), (256, 416), (96, 640), (640, 640)]:
        t = torch.randn(1, 3, hh, ww)
        with torch.no_grad():
            ref = w(t).numpy()
        got = sess.run(None, {"images": t.numpy()})[0]
        print(f"{ww}x{hh}: N={got.shape[1]} max|box diff|={np.abs(ref[..., :4] - got[..., :4]).max():.4g}px "
              f"max|score diff|={np.abs(ref[..., 4] - got[..., 4]).max():.3g}")
        assert got.shape == ref.shape and np.abs(ref[..., :4] - got[..., :4]).max() < 0.5

    # Semantic check vs mmdet's own pipeline on a real frame scaled to 640 wide (no further resize).
    im = Image.open(a.check_image).convert("RGB")
    s = 640 / im.width
    im = im.resize((640, round(im.height * s)), Image.BILINEAR)
    bgr = np.asarray(im)[:, :, ::-1].copy()
    pad = np.full((640, 640, 3), 114, np.uint8)  # mmdet pads its test input to 640x640; use the same pixels
    pad[: bgr.shape[0]] = bgr
    r = inference_detector(det, pad).pred_instances
    keep = (r.labels == 0) & (r.scores > 0.3)
    ref_b = r.bboxes[keep].numpy()
    ref_s = r.scores[keep].numpy()
    t = (pad.astype(np.float32) - np.array(MEAN, np.float32)) / np.array(STD, np.float32)
    got = sess.run(None, {"images": t.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
    j = int(np.argmax(got[:, 4]))
    print(f"onnx top person {got[j].round(2)}; mmdet persons {np.c_[ref_b, ref_s].round(2).tolist()[:3]}")
    assert len(ref_b) and np.abs(got[j, :4] - ref_b[0]).max() < 2.0 and abs(got[j, 4] - ref_s[0]) < 0.01
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()

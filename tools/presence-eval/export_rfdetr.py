#!/usr/bin/env python3
"""Export RF-DETR-Nano (Roboflow rfdetr 1.11.1, Apache-2.0 for code and the Nano COCO weights) to a
person-only ONNX. OFFLINE ONLY.

Weights: https://storage.googleapis.com/rfdetr/nano_coco/checkpoint_best_regular.pth
         (md5 fb6504cce7fbdc783f7a46991f07639f, pinned by rfdetr/assets/model_weights.py)
Steps: rfdetr's own ONNX export (input "input" [1,3,H,W] ImageNet-normalised RGB; outputs
boxes [1,Q,4] cx,cy,w,h normalised and logits [1,Q,C]), then an appended tail producing the shared
contract "person_dets" [1,Q,5] = x1,y1,x2,y2 (input pixels), sigmoid(logit[person]). NMS-free.

  python export_rfdetr.py --ckpt /models/src/rf-detr-nano.pth --out /models/rfdetr_nano_person.onnx [--shape 384x384]
"""
import argparse
import glob
import os
import shutil
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper


def append_person_tail(src, dst, width, height, person_idx):
    m = onnx.load(src)
    g = m.graph
    outs = [o.name for o in g.output]
    shapes = {o.name: [d.dim_value for d in o.type.tensor_type.shape.dim] for o in g.output}
    box_name = next(n for n in outs if shapes[n][-1] == 4)
    logit_name = next(n for n in outs if n != box_name and shapes[n][-1] > 4)
    c = lambda name, vals, dt=TensorProto.FLOAT: helper.make_tensor(name, dt, [len(vals)], vals)  # noqa: E731
    g.initializer.extend([
        c("t_idx", [person_idx], TensorProto.INT64),
        c("t_scale", [width, height, width, height]),
        c("t_half", [0.5, 0.5]),
        c("t_split", [2, 2], TensorProto.INT64),
    ])
    nodes = [
        helper.make_node("Gather", [logit_name, "t_idx"], ["t_plogit"], axis=2),  # [1,Q,1]
        helper.make_node("Sigmoid", ["t_plogit"], ["t_score"]),
        helper.make_node("Split", [box_name, "t_split"], ["t_cxcy", "t_wh"], axis=2),
        helper.make_node("Mul", ["t_wh", "t_half"], ["t_hwh"]),
        helper.make_node("Sub", ["t_cxcy", "t_hwh"], ["t_xy1"]),
        helper.make_node("Add", ["t_cxcy", "t_hwh"], ["t_xy2"]),
        helper.make_node("Concat", ["t_xy1", "t_xy2"], ["t_xyxy_n"], axis=2),
        helper.make_node("Mul", ["t_xyxy_n", "t_scale"], ["t_xyxy"]),
        helper.make_node("Concat", ["t_xyxy", "t_score"], ["person_dets"], axis=2),
    ]
    g.node.extend(nodes)
    while len(g.output):
        g.output.pop()
    g.output.append(helper.make_tensor_value_info("person_dets", TensorProto.FLOAT, [1, shapes[box_name][1], 5]))
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    return box_name, logit_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--shape", default="384x384", help="WxH, multiples of 32")
    ap.add_argument("--person-idx", type=int, default=1, help="logit column of COCO 'person' (category id 1)")
    a = ap.parse_args()
    from rfdetr import RFDETRNano

    W, H = (int(v) for v in a.shape.split("x"))
    model = RFDETRNano(pretrain_weights=a.ckpt)
    tmp = tempfile.mkdtemp()
    model.export(output_dir=tmp, shape=(H, W), opset_version=17, verbose=False)
    src = sorted(glob.glob(os.path.join(tmp, "**", "*.onnx"), recursive=True))[0]
    bn, ln = append_person_tail(src, a.out, W, H, a.person_idx)
    raw = ort.InferenceSession(src, providers=["CPUExecutionProvider"])
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    x = np.random.rand(1, 3, H, W).astype(np.float32)
    feeds = {raw.get_inputs()[0].name: x}
    rb, rl = (dict(zip([o.name for o in raw.get_outputs()], raw.run(None, feeds)))[k] for k in (bn, ln))
    got = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    exp_s = 1 / (1 + np.exp(-rl[..., a.person_idx]))
    assert np.abs(got[..., 4] - exp_s).max() < 1e-5
    assert np.abs(got[..., 0] - (rb[..., 0] - rb[..., 2] / 2) * W).max() < 1e-3
    print(f"rfdetr-nano {W}x{H}: outputs {bn},{ln} -> dets {got.shape}; input {sess.get_inputs()[0].name}")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()

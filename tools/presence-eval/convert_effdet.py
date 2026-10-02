#!/usr/bin/env python3
"""Convert MediaPipe EfficientDet-Lite0/Lite2 (float32 TFLite, Apache-2.0) to a person-only ONNX.
OFFLINE ONLY. Runs in presence-p1-tf (docker/tf.Dockerfile).

Source: https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite{0,2}/float32/1/
These MediaPipe builds contain no TFLite_Detection_PostProcess op: the graph ends with raw box
encodings [1,N,4] and sigmoid class scores [1,N,90]; MediaPipe decodes them with fixed anchors and
scales stored in the model's DETECTOR_METADATA, then runs NMS. We read those anchors, append the
same decode for the person class (label 0 in the embedded labels.txt) to the tf2onnx graph, and
leave NMS to the caller (run-models.ts). The decode is checked against MediaPipe's own
ObjectDetector on a real frame.

Output contract: input [1,H,W,3] float32 RGB (x-127.5)/127.5; output "person_dets" [1,N,5] =
x1,y1,x2,y2 (input pixels), person score.

  python convert_effdet.py --tflite /models/src/efficientdet_lite0.tflite --out /models/efficientdet_lite0_person.onnx \
      --check-image /work/frames/<clip>/00000.jpg
"""
import argparse
import os
import subprocess
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import tensorflow as tf
from onnx import TensorProto, helper, numpy_helper
from PIL import Image


def detector_metadata(path):
    from mediapipe.tasks.metadata import metadata_schema_py_generated as ms
    from mediapipe.tasks.metadata import object_detector_metadata_schema_py_generated as od
    from mediapipe.tasks.python.metadata import metadata as mdlib

    buf = mdlib.MetadataDisplayer.with_model_file(path).get_metadata_buffer() if hasattr(
        mdlib.MetadataDisplayer, "get_metadata_buffer") else None
    if buf is None:
        buf = mdlib.get_metadata_buffer(open(path, "rb").read())
    meta = ms.ModelMetadata.GetRootAsModelMetadata(buf, 0)
    sg = meta.SubgraphMetadata(0)
    for i in range(sg.CustomMetadataLength()):
        cm = sg.CustomMetadata(i)
        if cm.Name().decode() == "DETECTOR_METADATA":
            data = bytes(cm.DataAsNumpy())
            o = od.ObjectDetectorOptions.GetRootAsObjectDetectorOptions(data, 0)
            fa = o.SsdAnchorsOptions().FixedAnchorsSchema()
            anchors = np.array([[fa.Anchors(j).XCenter(), fa.Anchors(j).YCenter(), fa.Anchors(j).Width(),
                                 fa.Anchors(j).Height()] for j in range(fa.AnchorsLength())], np.float32)
            t = o.TensorsDecodingOptions()
            dec = dict(num_classes=t.NumClasses(), num_boxes=t.NumBoxes(), num_coords=t.NumCoords(),
                       x_scale=t.XScale(), y_scale=t.YScale(), w_scale=t.WScale(), h_scale=t.HScale(),
                       apply_exp=t.ApplyExponentialOnBoxSize(), sigmoid=t.SigmoidScore())
            return anchors, dec
    raise SystemExit("DETECTOR_METADATA not found")


def letterbox(img_path, W, H):
    im = Image.open(img_path).convert("RGB")
    s = min(W / im.width, H / im.height)
    cw, ch = round(im.width * s), round(im.height * s)
    canvas = np.zeros((H, W, 3), np.uint8)
    canvas[:ch, :cw] = np.asarray(im.resize((cw, ch), Image.BILINEAR))
    return canvas


def decode(raw, anchors, d, order):
    """MediaPipe TensorsToDetections decode; order 'yxhw' or 'xywh' = layout of raw[...,0:4]."""
    if order == "yxhw":
        ty, tx, th, tw = raw[:, 0], raw[:, 1], raw[:, 2], raw[:, 3]
    else:
        tx, ty, tw, th = raw[:, 0], raw[:, 1], raw[:, 2], raw[:, 3]
    xc = tx / d["x_scale"] * anchors[:, 2] + anchors[:, 0]
    yc = ty / d["y_scale"] * anchors[:, 3] + anchors[:, 1]
    if d["apply_exp"]:
        w = np.exp(tw / d["w_scale"]) * anchors[:, 2]
        h = np.exp(th / d["h_scale"]) * anchors[:, 3]
    else:
        w = tw / d["w_scale"] * anchors[:, 2]
        h = th / d["h_scale"] * anchors[:, 3]
    return np.stack([xc - w / 2, yc - h / 2, xc + w / 2, yc + h / 2], 1)  # normalised xyxy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tflite", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--check-image", required=True)
    ap.add_argument("--person-class", type=int, default=0)
    a = ap.parse_args()

    anchors, d = detector_metadata(a.tflite)
    print(f"anchors {anchors.shape}, decode {d}")
    it = tf.lite.Interpreter(model_path=a.tflite)
    it.allocate_tensors()
    inp = it.get_input_details()[0]
    _, H, W, _ = inp["shape"]
    outs = it.get_output_details()
    box_o = next(o for o in outs if o["shape"][-1] == d["num_coords"])
    cls_o = next(o for o in outs if o["shape"][-1] == d["num_classes"])

    img = letterbox(a.check_image, W, H)
    x = ((img.astype(np.float32) - 127.5) / 127.5)[None]
    it.set_tensor(inp["index"], x)
    it.invoke()
    raw_box = it.get_tensor(box_o["index"])[0]
    raw_cls = it.get_tensor(cls_o["index"])[0]
    pscore = raw_cls[:, a.person_class] if not d["sigmoid"] else 1 / (1 + np.exp(-raw_cls[:, a.person_class]))

    # Reference: MediaPipe's own detector on the same (already model-sized) picture.
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions
    det = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=BaseOptions(model_asset_path=a.tflite), score_threshold=0.3, max_results=10))
    res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=img))
    people = [r for r in res.detections if r.categories[0].category_name == "person"]
    assert people, "MediaPipe found no person on the check image; pick another frame"
    ref = max(people, key=lambda r: r.categories[0].score)
    bb = ref.bounding_box
    ref_xyxy = np.array([bb.origin_x, bb.origin_y, bb.origin_x + bb.width, bb.origin_y + bb.height], np.float32)
    ref_s = ref.categories[0].score
    k = int(np.argmax(pscore))
    best = None
    for order in ("yxhw", "xywh"):
        b = decode(raw_box, anchors, d, order)[k] * np.array([W, H, W, H])
        err = np.abs(b - ref_xyxy).max()
        print(f"order {order}: top box {b.round(1)} vs mediapipe {ref_xyxy} (score {pscore[k]:.3f} vs {ref_s:.3f}) err {err:.2f}px")
        if best is None or err < best[1]:
            best = (order, err)
    order, err = best
    assert err < 3.0 and abs(pscore[k] - ref_s) < 0.02, "decode does not reproduce MediaPipe"

    tmp = tempfile.mkdtemp()
    full = os.path.join(tmp, "full.onnx")
    subprocess.run(["python", "-m", "tf2onnx.convert", "--tflite", a.tflite, "--output", full, "--opset", "17"],
                   check=True, capture_output=True)
    m = onnx.load(full)
    g = m.graph
    onames = [o.name for o in g.output]
    oshape = {o.name: [dd.dim_value for dd in o.type.tensor_type.shape.dim] for o in g.output}
    box_name = next(n for n in onames if oshape[n][-1] == d["num_coords"])
    cls_name = next(n for n in onames if oshape[n][-1] == d["num_classes"])
    # raw -> (tx,ty,tw,th) order as [1,N,4]
    perm = [1, 0, 3, 2] if order == "yxhw" else [0, 1, 2, 3]
    g.initializer.extend([
        numpy_helper.from_array(np.array(perm, np.int64), "e_perm"),
        numpy_helper.from_array(anchors[None, :, 0:2], "e_anc_c"),        # x_center,y_center
        numpy_helper.from_array(anchors[None, :, 2:4], "e_anc_s"),        # width,height
        numpy_helper.from_array(np.array([1 / d["x_scale"], 1 / d["y_scale"]], np.float32), "e_sc_c"),
        numpy_helper.from_array(np.array([1 / d["w_scale"], 1 / d["h_scale"]], np.float32), "e_sc_s"),
        numpy_helper.from_array(np.array([0.5, 0.5], np.float32), "e_half"),
        numpy_helper.from_array(np.array([2, 2], np.int64), "e_split"),
        numpy_helper.from_array(np.array([a.person_class], np.int64), "e_idx"),
        numpy_helper.from_array(np.array([W, H, W, H], np.float32), "e_px"),
    ])
    nodes = [
        helper.make_node("Gather", [box_name, "e_perm"], ["e_raw"], axis=2),
        helper.make_node("Split", ["e_raw", "e_split"], ["e_dc", "e_ds"], axis=2),
        helper.make_node("Mul", ["e_dc", "e_sc_c"], ["e_dc2"]),
        helper.make_node("Mul", ["e_dc2", "e_anc_s"], ["e_dc3"]),
        helper.make_node("Add", ["e_dc3", "e_anc_c"], ["e_ctr"]),
        helper.make_node("Mul", ["e_ds", "e_sc_s"], ["e_ds2"]),
    ]
    if d["apply_exp"]:
        nodes.append(helper.make_node("Exp", ["e_ds2"], ["e_ds3"]))
    else:
        nodes.append(helper.make_node("Identity", ["e_ds2"], ["e_ds3"]))
    nodes += [
        helper.make_node("Mul", ["e_ds3", "e_anc_s"], ["e_size"]),
        helper.make_node("Mul", ["e_size", "e_half"], ["e_hs"]),
        helper.make_node("Sub", ["e_ctr", "e_hs"], ["e_min"]),
        helper.make_node("Add", ["e_ctr", "e_hs"], ["e_max"]),
        helper.make_node("Concat", ["e_min", "e_max"], ["e_xyxy_n"], axis=2),
        helper.make_node("Mul", ["e_xyxy_n", "e_px"], ["e_xyxy"]),
        helper.make_node("Gather", [cls_name, "e_idx"], ["e_p"], axis=2),
    ]
    score = "e_p"
    if d["sigmoid"]:
        nodes.append(helper.make_node("Sigmoid", ["e_p"], ["e_ps"]))
        score = "e_ps"
    nodes.append(helper.make_node("Concat", ["e_xyxy", score], ["person_dets"], axis=2))
    g.node.extend(nodes)
    while len(g.output):
        g.output.pop()
    g.output.append(helper.make_tensor_value_info("person_dets", TensorProto.FLOAT, [1, anchors.shape[0], 5]))
    # tf2onnx leaves intermediate shape annotations that onnxruntime-node 1.30 rejects for Lite0
    # ("[ShapeInferenceError] Incompatible dimensions" on an FPN Add); ORT re-infers them anyway.
    del g.value_info[:]
    onnx.checker.check_model(m)
    onnx.save(m, a.out)

    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    got = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    j = int(np.argmax(got[:, 4]))
    print(f"onnx top person {got[j].round(2)} vs mediapipe {ref_xyxy} {ref_s:.3f}")
    assert np.abs(got[j, :4] - ref_xyxy).max() < 3.0 and abs(got[j, 4] - ref_s) < 0.02
    print(f"wrote {a.out}: input {sess.get_inputs()[0].name} {sess.get_inputs()[0].shape}, order {order}")


if __name__ == "__main__":
    main()

# Offline-only tooling image for the P1 presence-detector evaluation:
#   - Grounding DINO pre-labels (transformers, IDEA-Research/grounding-dino-*; Apache-2.0)
#   - ONNX export of YOLOX-Nano/Tiny (Megvii, Apache-2.0), RT-DETR-R18 (lyuwenyu/RT-DETR, the
#     official Baidu implementation, Apache-2.0 - NOT the AGPL Ultralytics packaging), and
#     RF-DETR-Nano (roboflow rfdetr, Apache-2.0 for N/S/M/L).
# Never part of the gateway image. Build:
#   docker build -f tools/presence-eval/docker/torch.Dockerfile -t presence-p1-torch tools/presence-eval/docker
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir "rfdetr[onnx]==1.11.1" onnx onnxruntime pillow pyyaml scipy loguru tabulate pycocotools

# Pinned source checkouts (commits recorded in the P1 report).
ARG YOLOX_SHA=6ddff4824372906469a7fae2dc3206c7aa4bbaee
ARG RTDETR_SHA=29320b6fd828f8e0987a71426cf2d961b09dfed7
RUN git clone --filter=blob:none https://github.com/Megvii-BaseDetection/YOLOX.git /src/YOLOX \
    && git -C /src/YOLOX checkout "$YOLOX_SHA" \
    && git clone --filter=blob:none https://github.com/lyuwenyu/RT-DETR.git /src/RT-DETR \
    && git -C /src/RT-DETR checkout "$RTDETR_SHA"
# YOLOX's package __init__ imports cv2/thop/psutil/tensorboard; RT-DETR's src.data imports faster-coco-eval.
RUN pip install --no-cache-dir opencv-python-headless thop psutil tensorboard faster-coco-eval

ENV PYTHONPATH=/src/YOLOX \
    HF_HOME=/cache/hf \
    TORCH_HOME=/cache/torch \
    PYTHONUNBUFFERED=1
WORKDIR /work

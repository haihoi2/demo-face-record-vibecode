# Offline-only tooling image: export RTMDet-tiny (OpenMMLab mmdetection, Apache-2.0) to ONNX
# without mmdeploy (export_rtmdet.py traces backbone+neck+head and decodes in-graph).
#   docker build -f tools/presence-eval/docker/mm.Dockerfile -t presence-p1-mm tools/presence-eval/docker
FROM python:3.10-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple
RUN pip install --no-cache-dir "numpy<2" mmengine==0.10.4 \
    && pip install --no-cache-dir mmcv==2.1.0 -f https://download.openmmlab.com/mmcv/dist/cpu/torch2.1/index.html \
    && pip install --no-cache-dir mmdet==3.3.0 onnx==1.16.2 onnxruntime==1.19.2
ENV PYTHONUNBUFFERED=1
WORKDIR /work

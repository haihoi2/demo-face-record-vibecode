# Offline-only tooling image: convert MediaPipe EfficientDet-Lite0/Lite2 (Apache-2.0) TFLite
# models to ONNX with tf2onnx, cutting the graph before TFLite_Detection_PostProcess.
#   docker build -f tools/presence-eval/docker/tf.Dockerfile -t presence-p1-tf tools/presence-eval/docker
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir tensorflow-cpu==2.15.1 tf2onnx==1.16.1 onnx==1.16.2 onnxruntime==1.19.2 "numpy<2" pillow
# mediapipe (Apache-2.0): reads the DETECTOR_METADATA anchors and gives the reference decode.
RUN pip install --no-cache-dir mediapipe==0.10.14 "numpy<2"
ENV PYTHONUNBUFFERED=1
WORKDIR /work

/**
 * Worker-thread entry of one gate's real-time pipeline (F11: inference must
 * not run on the main thread). Protocol: pipelineProtocol.ts; logic:
 * pipelineCore.ts; engine: onnxEngine.ts.
 *
 * Loaded in two shapes, like faceWorker.ts:
 *   - dev  : this .ts file, through the tsx loader inherited via process.execArgv;
 *   - prod : bundled by esbuild into dist/pipelineWorker.cjs (npm run build:pipeline-worker).
 * gatePipeline.ts#resolvePipelineWorkerEntry() picks which one.
 *
 * The engine is loaded here, once per worker, and retried every
 * ENGINE_RETRY_MS while it fails (a model volume can appear late). Until it is
 * ready every frame is answered `processed: false` (fail closed).
 */
import { parentPort } from "node:worker_threads";

import { PipelineCore } from "./pipelineCore";
import { cropFaceFromRgb } from "./faceCrop";
import { loadOnnxPipelineEngine, onnxPipelineEngine } from "./onnxEngine";
import type { HostToWorker } from "./pipelineProtocol";

const ENGINE_RETRY_MS = 30_000;

if (parentPort) {
  const port = parentPort;
  const core = new PipelineCore({
    engine: onnxPipelineEngine,
    post: (msg, transfer) => port.postMessage(msg, transfer as any),
    cropper: async (frame, box) => {
      const jpeg = await cropFaceFromRgb(frame, box);
      return jpeg ? new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength) : null;
    },
  });
  port.on("message", (msg: HostToWorker) => core.handle(msg));

  let retry: ReturnType<typeof setTimeout> | null = null;
  const load = async () => {
    retry = null;
    const ok = await loadOnnxPipelineEngine();
    core.engineChanged();
    if (!ok) {
      retry = setTimeout(load, ENGINE_RETRY_MS);
      retry.unref?.();
    }
  };
  void load();
  port.on("close", () => {
    if (retry) clearTimeout(retry);
  });
}

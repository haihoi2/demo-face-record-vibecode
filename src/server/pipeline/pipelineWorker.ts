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
 *
 * Priority: before anything else this thread lowers its own scheduling
 * priority (PIPELINE_WORKER_NICE, default 10; 0 = unchanged). Threads the
 * engine creates here (ONNX Runtime's intra-op pool) inherit it. Under a CPU
 * limit the FFmpeg decoders, HTTP and the legacy watcher (which still opens the
 * door) then always win, and the pipeline gets the CPU that is left; measured
 * in the F11 retest, without it two gate workers starved the stream decoders.
 */
import fs from "node:fs";
import os from "node:os";
import { parentPort } from "node:worker_threads";

import { PipelineCore } from "./pipelineCore";
import { cropFaceFromRgb } from "./faceCrop";
import { loadOnnxPipelineEngine, onnxPipelineEngine } from "./onnxEngine";
import type { HostToWorker } from "./pipelineProtocol";

const ENGINE_RETRY_MS = 30_000;
const DEFAULT_NICE = 10;

/** Lowers THIS thread's priority (Linux: setpriority on the thread id). Returns an error text or null. */
export function lowerThreadPriority(raw: string | undefined): string | null {
  const text = String(raw ?? "").trim();
  const nice = text === "" ? DEFAULT_NICE : Number(text);
  if (!Number.isInteger(nice) || nice < 0 || nice > 19) return `PIPELINE_WORKER_NICE must be 0-19, got ${text.slice(0, 16)}`;
  if (nice === 0) return null;
  try {
    const tid = Number(fs.readlinkSync("/proc/thread-self").split("/").pop());
    if (!Number.isInteger(tid) || tid <= 0) return "no thread id";
    os.setPriority(tid, nice);
    return null;
  } catch (e) {
    return String((e as any)?.message || e).slice(0, 200);
  }
}

if (parentPort) {
  const port = parentPort;
  const niceError = lowerThreadPriority(process.env.PIPELINE_WORKER_NICE);
  const core = new PipelineCore({
    engine: onnxPipelineEngine,
    post: (msg, transfer) => port.postMessage(msg, transfer as any),
    cropper: async (frame, box) => {
      const jpeg = await cropFaceFromRgb(frame, box);
      return jpeg ? new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength) : null;
    },
  });
  port.on("message", (msg: HostToWorker) => core.handle(msg));
  if (niceError) port.postMessage({ type: "error", message: `pipeline worker priority unchanged: ${niceError}` });

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

/**
 * Test-only pipeline worker: the real PipelineCore with a fake engine whose
 * detect() BLOCKS its thread synchronously for BLOCK_MS, like onnxruntime-node
 * does (~0.4-0.6 s per SCRFD/ArcFace call). Used by pipelineWorker.test.ts to
 * show the main thread stays responsive while the worker is busy (F11).
 */
import { parentPort, workerData } from "node:worker_threads";

import { PipelineCore, type PipelineEngine } from "../../src/server/pipeline/pipelineCore";

const BLOCK_MS = Number(workerData?.blockMs) || 300;
const TAG = "arcface_test";

const engine: PipelineEngine = {
  ready: () => true,
  modelTag: () => TAG,
  async detect() {
    const end = Date.now() + BLOCK_MS;
    while (Date.now() < end) {
      // busy: the event loop of THIS thread is blocked, like ORT's run()
    }
    return [];
  },
  align: () => null,
  embed: async () => null,
  quality: () => 0,
  clearIssue: () => null,
};

if (parentPort) {
  const port = parentPort;
  const core = new PipelineCore({ engine, post: (msg, transfer) => port.postMessage(msg, transfer as any) });
  port.on("message", (msg) => core.handle(msg));
}

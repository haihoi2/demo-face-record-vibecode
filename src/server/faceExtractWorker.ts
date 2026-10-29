/**
 * Worker thread body for off-thread door-scan face extraction (Taiga #507).
 *
 * Runs exactly what observeFrame() runs on the main thread -
 * `loadImage(image)` then `extractFaces(rgb)` from faceEmbedding.ts - in its
 * own ONNX engine, so SCRFD/ArcFace and the JS image work (4K area resize,
 * letterbox, alignment, quality maths) no longer block the HTTP/SSE event loop.
 *
 * Loaded as src/server/faceExtractWorker.ts through the tsx loader inherited
 * via process.execArgv (dev, tests), or as dist/faceExtractWorker.cjs (esbuild
 * bundle) in the image; faceExtractPool.ts#resolveFaceExtractWorkerEntry picks.
 *
 * Lifecycle: load the engine once at start (+ one warm-up run), then post
 * `ready` with the configuration fingerprint, or `fatal` and exit when the
 * models cannot be loaded. One task at a time (the host never sends a second
 * before the first answered).
 *
 * Fail closed: extractFaces() swallows engine errors into [] (or drops a face).
 * Here any "[faceEmbedding] ..." console.error line during a task turns the
 * whole result into engine_error, and an undecodable frame is decode_failed,
 * so the host never mistakes a failure for "no face".
 *
 * Privacy: never logs or echoes image bytes or embeddings. Embedding buffers
 * are transferred to the host, the frame buffer is dropped after the task.
 */

import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

import {
  embedFace,
  extractFaces,
  getFaceEngine,
  getFaceEngineInfo,
  loadImage,
  toImageBuffer,
  EMBEDDING_DIM,
} from "./faceEmbedding";
import {
  extractFingerprint,
  isEngineErrorLine,
  type ExtractFailed,
  type ExtractOk,
  type HostToWorker,
  type WorkerToHost,
} from "./faceExtractProtocol";

const port = parentPort;
if (!port) throw new Error("faceExtractWorker must run inside a worker thread");

// Engine error capture (see header). Lines are still printed as before.
let capturing = false;
let engineErrors: string[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (capturing && isEngineErrorLine(args[0])) engineErrors.push(String(args[0]).slice(0, 200));
  originalConsoleError(...args);
};

function send(msg: WorkerToHost, transfer?: ArrayBuffer[]): void {
  port!.postMessage(msg, transfer ?? []);
}

function fail(id: number, code: ExtractFailed["code"], error: string, t0: number): void {
  send({ type: "result", id, ok: false, code, error, ms: Math.round(performance.now() - t0) });
}

async function handleExtract(id: number, image: ArrayBuffer | string): Promise<void> {
  const t0 = performance.now();
  const input = typeof image === "string" ? image : image instanceof ArrayBuffer ? Buffer.from(image) : null;
  const buf = input === null ? null : toImageBuffer(input);
  if (!buf) return fail(id, "invalid_input", "empty or unparseable image", t0);
  const engine = await getFaceEngine();
  if (!engine) return fail(id, "not_ready", "engine unavailable in worker", t0);

  capturing = true;
  engineErrors = [];
  try {
    const rgb = await loadImage(buf);
    if (!rgb) return fail(id, "decode_failed", "image could not be decoded (JPEG/PNG expected)", t0);
    const faces = await extractFaces(rgb);
    if (engineErrors.length > 0) return fail(id, "engine_error", engineErrors[0], t0);
    const transfer: ArrayBuffer[] = [];
    for (const f of faces) {
      let e = f.embedding;
      // Transfer each embedding's own buffer; copy one that shares a larger buffer.
      if (e.byteOffset !== 0 || e.buffer.byteLength !== EMBEDDING_DIM * 4 || !(e.buffer instanceof ArrayBuffer)) {
        e = new Float32Array(e);
        f.embedding = e;
      }
      transfer.push(e.buffer as ArrayBuffer);
    }
    const msg: ExtractOk = {
      type: "result",
      id,
      ok: true,
      width: rgb.width,
      height: rgb.height,
      modelTag: getFaceEngineInfo().modelTag,
      faces,
      ms: Math.round(performance.now() - t0),
    };
    send(msg, transfer);
  } catch (err) {
    fail(id, "engine_error", err instanceof Error ? err.message.slice(0, 200) : "extraction failed", t0);
  } finally {
    capturing = false;
    engineErrors = [];
  }
}

port.on("message", (msg: HostToWorker) => {
  if (!msg || typeof msg !== "object" || msg.type !== "extract" || !Number.isInteger(msg.id)) return;
  handleExtract(msg.id, msg.image).catch((err) => {
    // handleExtract already reports; this only guards a throw inside fail()/send().
    originalConsoleError("[faceExtractWorker] task failed:", err instanceof Error ? err.message : String(err));
  });
});

async function boot(): Promise<void> {
  const engine = await getFaceEngine();
  if (!engine) {
    send({ type: "fatal", error: getFaceEngineInfo().lastError || "face engine failed to load" });
    // Let the message flush, then exit; the host replaces the worker with back-off.
    setTimeout(() => process.exit(1), 50);
    return;
  }
  // Warm-up: the first ORT run allocates arenas; do it before taking real frames.
  try {
    await extractFaces({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 3) });
    await embedFace({ width: 112, height: 112, data: new Uint8Array(112 * 112 * 3) });
  } catch {
    /* warm-up only; a real failure shows up on the first task */
  }
  const info = getFaceEngineInfo();
  send({
    type: "ready",
    fingerprint: extractFingerprint(),
    modelTag: info.modelTag,
    detectorModel: info.detectorModel,
    recognizerModel: info.recognizerModel,
    ortThreads: Number(process.env.FACE_ORT_THREADS) || 0,
    loadTimeMs: info.loadTimeMs,
  });
}

boot().catch((err) => {
  send({ type: "fatal", error: err instanceof Error ? err.message : String(err) });
  setTimeout(() => process.exit(1), 50);
});

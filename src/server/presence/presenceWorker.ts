/**
 * Worker-thread entry of ONE presence detector (YOLOX-Nano or RTMDet-tiny, chosen
 * by the host's `init`). Protocol: presenceProtocol.ts; logic:
 * presenceDetectorCore.ts; model wrapper: detectors.ts (sha256-checked ONNX).
 *
 * Loaded like pipelineWorker.ts:
 *   - dev  : this .ts file, through the tsx loader inherited via process.execArgv;
 *   - prod : bundled by esbuild into dist/presenceWorker.cjs
 *            (needs a build:presence-worker script, see the P2 handoff).
 * presenceHost.ts#resolvePresenceWorkerEntry() picks which one.
 *
 * On `init` the thread lowers its own scheduling priority (PRESENCE_WORKER_NICE,
 * default 19) before the ONNX session (and its threads) exists, so the live
 * camera decoders and the door path always win the CPU.
 */
import { parentPort } from "node:worker_threads";

import { OnnxPersonDetector } from "./detectors";
import { PresenceDetectorCore } from "./presenceDetectorCore";
import type { HostToDetector } from "./presenceProtocol";

if (parentPort) {
  const port = parentPort;
  const core = new PresenceDetectorCore({
    createEngine: (init) => new OnnxPersonDetector({ model: init.model, modelDir: init.modelDir, mask: init.mask, ortThreads: init.ortThreads }),
    post: (msg) => port.postMessage(msg),
  });
  port.on("message", (msg: HostToDetector) => core.handle(msg));
}

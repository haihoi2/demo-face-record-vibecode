/**
 * Presence host (P2) lifecycle with fake engines (in-process detector workers)
 * and one real worker-thread check:
 *  - YOLOX on every frame, RTMDet on every 4th, drafts (qualified + final) with crops;
 *  - newest frame only, never queued;
 *  - fail closed: a model that does not load (sha256 mismatch) -> no processing, no drafts, visible error;
 *  - worker crash -> restart with back-off; hung worker -> restarted by the watchdog;
 *  - stop() delivers final drafts; malformed/stale frames rejected;
 *  - the real worker entry resolves and, without model files, fails closed and stops cleanly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { Box, PersonDetection, PresenceEventDraft, PresenceModelId } from "../src/server/presence/contracts";
import type { PersonDetectorEngine, PresenceFrame } from "../src/server/presence/detectors";
import { PresenceHost, createInProcessDetectorWorker, resolvePresenceWorkerEntry, type PresenceWorkerLike } from "../src/server/presence/presenceHost";
import { presenceSettingsFromEnv } from "../src/server/presence/presenceConfig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
/** 22:00 local (after hours: 1 s qualifies). */
const T0 = Date.UTC(2026, 9, 3, 15, 0, 0);

interface FakeOpts {
  loadOk?: boolean;
  loadError?: string;
  delayMs?: number;
  hangFirst?: boolean;
  script?: (t: number, model: PresenceModelId) => PersonDetection[];
}

function fakeEngine(model: PresenceModelId, o: FakeOpts, calls: Record<PresenceModelId, number[]>): PersonDetectorEngine {
  let ready = false;
  let hung = false;
  return {
    async load() {
      ready = o.loadOk !== false;
      return ready;
    },
    ready: () => ready,
    error: () => (ready ? null : o.loadError || "not loaded"),
    tag: () => `${model}@fake`,
    async detect(frame: PresenceFrame) {
      calls[model].push(frame.capturedAtMs);
      if (o.hangFirst && !hung) {
        hung = true;
        return new Promise<PersonDetection[]>(() => undefined);
      }
      if (o.delayMs) await sleep(o.delayMs);
      return (o.script?.(frame.capturedAtMs, model) ?? []).map((d) => ({ ...d, model }));
    },
  };
}

const person = (x: number, score = 0.8): PersonDetection => ({ box: [x, 400, x + 80, 600] as Box, score, model: "yolox-nano" });

function makeHost(per: Partial<Record<PresenceModelId, FakeOpts>>, extra: Partial<ConstructorParameters<typeof PresenceHost>[0]> = {}) {
  const clock = { t: T0 };
  const calls: Record<PresenceModelId, number[]> = { "yolox-nano": [], "rtmdet-tiny": [] };
  const drafts: Array<{ d: PresenceEventDraft; crop: Buffer | null }> = [];
  const crops: Array<{ w: number; box: Box }> = [];
  const errors: string[] = [];
  const host = new PresenceHost({
    gateId: "entry",
    settings: presenceSettingsFromEnv({}).settings,
    onDraft: (d, crop) => drafts.push({ d, crop }),
    onError: (m) => errors.push(m),
    cropper: async (frame, box) => {
      crops.push({ w: frame.width, box });
      return Buffer.from("jpeg");
    },
    createWorker: (model) => createInProcessDetectorWorker(() => fakeEngine(model, per[model] ?? {}, calls)),
    now: () => clock.t,
    tickMs: 10,
    statsMs: 10,
    restartBackoffInitialMs: 20,
    restartBackoffMaxMs: 50,
    ...extra,
  });
  const frame = (t: number): PresenceFrame => ({ width: 960, height: 540, rgb: new Uint8Array(960 * 540 * 3), capturedAtMs: t, sourceWidth: 3840, sourceHeight: 2160 });
  return { host, clock, calls, drafts, crops, errors, frame };
}

describe("presence host: frames -> drafts (fake engines)", () => {
  it("YOLOX every frame, RTMDet every 4th; a qualified draft then a final draft, each with a crop", async () => {
    const h = makeHost({ "yolox-nano": { script: (t) => (t - T0 <= 2500 ? [person(400)] : []) } });
    h.host.start();
    await until(() => h.host.stats().engineReady, 2000, "engine ready");
    for (let i = 0; i < 8; i++) {
      h.clock.t = T0 + i * 500;
      h.host.offer(h.frame(h.clock.t));
      await until(() => h.host.stats().framesProcessed === i + 1, 2000, `frame ${i}`);
    }
    await until(() => h.calls["rtmdet-tiny"].length === 2, 2000, "rtmdet runs");
    assert.deepEqual(h.calls["rtmdet-tiny"], [T0, T0 + 2000]);
    assert.equal(h.calls["yolox-nano"].length, 8);
    await until(() => h.drafts.length >= 1, 2000, "qualified draft");
    const q = h.drafts[0];
    assert.equal(q.d.final, false);
    assert.equal(q.d.period, "after-hours");
    assert.equal(q.d.inViewMs, 1000);
    assert.equal(q.d.gateId, "entry");
    assert.deepEqual(q.d.bestBox, [400, 400, 480, 600]); // source pixels
    assert.ok(q.crop && q.crop.length > 0);
    assert.deepEqual(h.crops[0], { w: 960, box: [100, 100, 120, 150] }); // crop box in frame pixels (/4)
    h.clock.t = T0 + 2500 + 2100; // > 2 s after the last box
    await until(() => h.drafts.length === 2, 2000, "final draft");
    assert.equal(h.drafts[1].d.final, true);
    assert.equal(h.drafts[1].d.trackId, q.d.trackId);
    assert.equal(h.drafts[1].d.framesSeen, 6);
    const st = h.host.stats();
    assert.equal(st.qualified, 1);
    assert.equal(st.finals, 1);
    assert.equal(st.rtmdetRuns, 2);
    assert.equal(st.detections["yolox-nano"], 6);
    assert.equal(st.worker.state, "running");
    assert.deepEqual(st.worker.models, ["yolox-nano@d37c96c31da5", "rtmdet-tiny@31aa4d63d4fb"]);
    assert.equal(typeof st.lastEventAt, "string");
    await h.host.stop();
    assert.equal(h.host.stats().running, false);
  });

  it("newest frame only: a frame arriving while YOLOX is busy replaces the waiting one", async () => {
    const h = makeHost({ "yolox-nano": { delayMs: 150 } });
    h.host.start();
    await until(() => h.host.stats().engineReady, 2000, "engine ready");
    for (let i = 0; i < 3; i++) {
      h.clock.t = T0 + i * 10;
      h.host.offer(h.frame(h.clock.t));
    }
    await until(() => h.host.stats().framesProcessed === 2, 3000, "two frames");
    await sleep(200);
    const st = h.host.stats();
    assert.equal(st.framesReceived, 3);
    assert.equal(st.framesDroppedBusy, 1);
    assert.equal(st.framesProcessed, 2);
    assert.deepEqual(h.calls["yolox-nano"], [T0, T0 + 20]);
    await h.host.stop();
  });

  it("rejects malformed, stale and out-of-order frames", async () => {
    const h = makeHost({});
    h.host.start();
    await until(() => h.host.stats().engineReady, 2000, "engine ready");
    assert.equal(h.host.stats().lastEventAt, null);
    h.host.offer({ width: 10, height: 10, rgb: new Uint8Array(5), capturedAtMs: T0 });
    h.host.offer(h.frame(T0 - 6000)); // older than maxFrameAgeMs
    h.host.offer(h.frame(T0));
    h.host.offer(h.frame(T0)); // the same frame again (polling): ignored, not counted
    h.host.offer(h.frame(T0 - 100)); // older than the last accepted one
    assert.equal(h.host.stats().framesRejected, 3);
    assert.equal(h.host.stats().framesReceived, 1);
    await h.host.stop();
  });

  it("stop() ends open tracks and still delivers their final drafts", async () => {
    const h = makeHost({ "yolox-nano": { script: () => [person(400)] } });
    h.host.start();
    await until(() => h.host.stats().engineReady, 2000, "engine ready");
    for (let i = 0; i < 3; i++) {
      h.clock.t = T0 + i * 500;
      h.host.offer(h.frame(h.clock.t));
      await until(() => h.host.stats().framesProcessed === i + 1, 2000, `frame ${i}`);
    }
    await h.host.stop();
    assert.deepEqual(h.drafts.map((x) => x.d.final), [false, true]);
  });

  it("constructor validates the gate id and the callback", () => {
    assert.throws(() => new PresenceHost({ gateId: "../x", onDraft: () => undefined, settings: presenceSettingsFromEnv({}).settings }), /invalid gate id/);
    assert.throws(() => new PresenceHost({ gateId: "entry" } as any), /onDraft/);
  });
});

describe("presence host: fail closed and recovery", () => {
  it("a model that does not load (sha256 mismatch): nothing processed, no drafts, visible error", async () => {
    const h = makeHost({
      "yolox-nano": { script: () => [person(400)] },
      "rtmdet-tiny": { loadOk: false, loadError: "model sha256 mismatch for rtmdet-tiny: /m/rtmdet_tiny_person.onnx is 000000000000..." },
    });
    h.host.start();
    await until(() => Boolean(h.host.stats().workers["rtmdet-tiny"].loadError), 2000, "load error in stats");
    for (let i = 0; i < 4; i++) {
      h.clock.t = T0 + i * 500;
      h.host.offer(h.frame(h.clock.t));
    }
    await sleep(50);
    const st = h.host.stats();
    assert.equal(st.engineReady, false);
    assert.equal(st.framesProcessed, 0);
    assert.equal(st.framesSkippedNotReady, 4);
    assert.equal(h.calls["yolox-nano"].length, 0);
    assert.equal(h.drafts.length, 0);
    assert.match(String(st.lastError), /sha256 mismatch/);
    assert.match(String(st.workers["rtmdet-tiny"].loadError), /sha256 mismatch/);
    assert.equal(st.workers["yolox-nano"].ready, true);
    await h.host.stop();
  });

  it("a crashed worker is restarted with back-off and processing resumes", async () => {
    let spawned = 0;
    const calls: Record<PresenceModelId, number[]> = { "yolox-nano": [], "rtmdet-tiny": [] };
    const crashing = (): PresenceWorkerLike => {
      const ee = new EventEmitter() as any;
      ee.postMessage = () => undefined;
      ee.terminate = () => Promise.resolve(0);
      setTimeout(() => ee.emit("exit", 1), 5);
      return ee;
    };
    const h = makeHost({}, {
      createWorker: (model) => {
        if (model === "yolox-nano" && spawned++ === 0) return crashing();
        return createInProcessDetectorWorker(() => fakeEngine(model, {}, calls));
      },
    });
    h.host.start();
    await until(() => h.host.stats().engineReady, 3000, "engine ready after restart");
    const st = h.host.stats();
    assert.equal(st.workers["yolox-nano"].restarts, 1);
    assert.equal(st.worker.restarts, 1);
    assert.match(String(st.lastError), /exited \(code 1\); restart 1/);
    h.host.offer(h.frame(h.clock.t));
    await until(() => h.host.stats().framesProcessed === 1, 2000, "frame after restart");
    await h.host.stop();
  });

  it("a hung worker (no answer within frameTimeoutMs) is restarted", async () => {
    const h = makeHost({ "yolox-nano": { hangFirst: true } }, { frameTimeoutMs: 80 });
    h.host.start();
    await until(() => h.host.stats().engineReady, 2000, "engine ready");
    h.host.offer(h.frame(h.clock.t));
    h.clock.t += 200; // the injected clock decides "hung"
    await until(() => h.host.stats().workers["yolox-nano"].restarts === 1, 3000, "watchdog restart");
    assert.match(String(h.host.stats().lastError), /did not answer a frame/);
    await h.host.stop();
  });
});

describe("presence host: real worker threads", () => {
  it("the worker entry resolves under tsx", () => {
    assert.match(resolvePresenceWorkerEntry(), /src[\\/]server[\\/]presence[\\/]presenceWorker\.ts$/);
  });

  it("without model files both workers fail closed, nothing is processed, and stop() is clean", async () => {
    const { settings } = presenceSettingsFromEnv({ PRESENCE_MODEL_DIR: "/nonexistent-presence-models", PRESENCE_WORKER_NICE: "0" });
    const drafts: PresenceEventDraft[] = [];
    const host = new PresenceHost({ gateId: "entry", settings, onDraft: (d) => drafts.push(d), statsMs: 50, cropper: null });
    host.start();
    try {
      await until(() => Object.values(host.stats().workers).every((w) => Boolean(w.loadError)), 20_000, "worker load errors");
      const st = host.stats();
      assert.equal(st.engineReady, false);
      for (const w of Object.values(st.workers)) assert.match(String(w.loadError), /model file missing: \/nonexistent-presence-models\//);
      host.offer({ width: 960, height: 540, rgb: new Uint8Array(960 * 540 * 3), capturedAtMs: Date.now() });
      assert.equal(host.stats().framesSkippedNotReady, 1);
      assert.equal(host.stats().framesProcessed, 0);
    } finally {
      await host.stop();
    }
    assert.equal(host.stats().worker.state, "stopped");
    assert.equal(drafts.length, 0);
  });
});

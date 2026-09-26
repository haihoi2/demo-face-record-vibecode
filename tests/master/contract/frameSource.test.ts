/**
 * pipeline-contract: FrameSource behaviour (contracts.ts) on live RTSP served by
 * the MT harness. The test publishes its own synthetic stream into MediaMTX
 * (FFmpeg testsrc, no biometric data) so it can drop, restart and burst it.
 *
 *   MT_MTX_RTSP=rtsp://mediamtx-rt-mt:8554 node --import tsx --test tests/master/contract/frameSource.test.ts
 *
 * Skips cleanly while src/server/pipeline/streamReader.ts does not exist (W1)
 * or exposes no factory the adapter below recognises. Writes the measured
 * recovery time to $MT_RESULTS_DIR/recovery.json for the acceptance suite.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Frame, FrameSource, SourceState } from "../../../src/server/pipeline/contracts.ts";

const MTX = (process.env.MT_MTX_RTSP || "").replace(/\/+$/, "");
const MODULE = new URL("../../../src/server/pipeline/streamReader.ts", import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const CANARY = `mtcanary${Date.now().toString(36)}`;

type Factory = (opts: Record<string, unknown>) => FrameSource;

/**
 * Binds whatever STR exports to a FrameSource factory. Recognised shapes:
 * createFrameSource(opts) | createStreamReader(opts) | new StreamReader(opts) | default.
 * MT_FRAMESOURCE_EXPORT names the export when it is something else.
 */
async function loadFactory(): Promise<{ factory: Factory | null; why?: string }> {
  if (!existsSync(MODULE)) return { factory: null, why: "streamReader.ts not in this build (STR, W1)" };
  const spec: string = MODULE.href;
  const mod: any = await import(spec);
  const named = process.env.MT_FRAMESOURCE_EXPORT;
  const pick = (name: string) => mod[name];
  const cand = (named && pick(named)) || pick("createFrameSource") || pick("createStreamReader") || pick("StreamReader") || mod.default;
  if (typeof cand !== "function") return { factory: null, why: `no recognised factory export (found: ${Object.keys(mod).join(", ")})` };
  const isClass = /^class\s/.test(Function.prototype.toString.call(cand));
  return { factory: (opts) => (isClass ? new cand(opts) : cand(opts)) };
}

function sourceOptions(url: string, gate: "ENTRY" | "EXIT" = "EXIT") {
  // Superset of plausible option names; an implementation ignores what it does not use.
  return { gate, streamId: `mt-contract-${gate.toLowerCase()}`, url, rtspUrl: url, fps: 8, targetFps: 8, transport: "tcp", staleMs: 1000 };
}

function publish(path: string, opts: { realtime?: boolean; seconds?: number } = {}): ChildProcess {
  const args = [
    "-hide_banner", "-loglevel", "error",
    ...(opts.realtime === false ? [] : ["-re"]),
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25${opts.seconds ? `:duration=${opts.seconds}` : ""}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "50", "-pix_fmt", "yuv420p",
    "-f", "rtsp", "-rtsp_transport", "tcp", `${MTX}/${path}`,
  ];
  const p = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "ignore"] });
  return p;
}

function kill(p: ChildProcess | null) {
  if (p && p.exitCode === null) p.kill("SIGKILL");
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("pipeline-contract: FrameSource over the replay harness", () => {
  let factory: Factory | null = null;
  let why = "";
  let publisher: ChildProcess | null = null;
  const path = `mt-contract-${process.pid}`;
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;

  before(async () => {
    const r = await loadFactory();
    factory = r.factory;
    why = r.why || "";
    if (!MTX) why = why || "set MT_MTX_RTSP (harness up)";
    for (const [k, orig] of [["log", origLog], ["warn", origWarn], ["error", origErr]] as const) {
      (console as any)[k] = (...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
        orig(...a);
      };
    }
  });
  after(() => {
    kill(publisher);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  });

  it("streams frames of the declared geometry at ~8 fps with monotonic seq and time", async (t) => {
    if (!factory || !MTX) return t.skip(why);
    publisher = publish(path);
    await new Promise((r) => setTimeout(r, 1500));
    const src = factory(sourceOptions(`${MTX}/${path}`));
    const frames: Frame[] = [];
    const states: SourceState[] = [];
    src.on("frame", (f) => frames.push(f));
    src.on("state", (s) => states.push(s));
    src.start();
    try {
      assert.ok(await until(() => frames.length > 0, 10_000), "no frame within 10 s");
      const t0 = Date.now();
      const n0 = frames.length;
      await new Promise((r) => setTimeout(r, 4000));
      const fps = ((frames.length - n0) * 1000) / (Date.now() - t0);
      assert.ok(fps >= 5 && fps <= 11, `handed-out fps ${fps.toFixed(1)} not ~8`);
      for (const f of frames.slice(-10)) {
        assert.equal(f.rgb.length, f.width * f.height * 3, "rgb must be packed RGB24 of width x height");
        assert.equal(f.roi.length, 4);
        assert.ok(f.width <= f.sourceWidth && f.height <= f.sourceHeight);
        assert.doesNotMatch(f.streamId, /rtsp:|@/, "streamId must not be a URL");
      }
      for (let i = 1; i < frames.length; i++) {
        assert.ok(frames[i].seq > frames[i - 1].seq, "seq must increase");
        assert.ok(frames[i].capturedAtMs >= frames[i - 1].capturedAtMs, "capturedAtMs must not go back");
      }
      const latest = src.latest();
      assert.ok(latest && latest.seq === frames[frames.length - 1].seq, "latest() must be the newest frame");
      assert.ok(states.some((s) => s.status === "streaming"), "state must reach streaming");
    } finally {
      src.stop();
      kill(publisher);
      publisher = null;
    }
  });

  it("goes stale within ~1 s of a drop, reconnects within 10 s, and reports it", async (t) => {
    if (!factory || !MTX) return t.skip(why);
    publisher = publish(path);
    await new Promise((r) => setTimeout(r, 1500));
    const src = factory(sourceOptions(`${MTX}/${path}`));
    const states: SourceState[] = [];
    let frames = 0;
    src.on("frame", () => frames++);
    src.on("state", (s) => states.push(s));
    src.start();
    try {
      assert.ok(await until(() => frames > 5, 10_000), "never streamed");
      kill(publisher);
      const dropAt = Date.now();
      assert.ok(await until(() => states.some((s) => s.status === "stale" || s.status === "reconnecting"), 3000), "no stale/reconnecting state within 3 s of the drop");
      const staleMs = Date.now() - dropAt;
      assert.equal(src.latest(), null, "latest() must be null while stale");
      await new Promise((r) => setTimeout(r, 1000));
      publisher = publish(path);
      const backAt = Date.now();
      const before = frames;
      assert.ok(await until(() => frames > before + 3, 15_000), "no frames within 15 s of the stream returning");
      const recoveryMs = Date.now() - backAt;
      const last = states[states.length - 1];
      assert.ok(last.reconnects >= 1, "reconnects must count the drop");
      assert.ok(recoveryMs <= 10_000, `recovery took ${recoveryMs} ms (target <= 10 s)`);
      if (process.env.MT_RESULTS_DIR) {
        mkdirSync(process.env.MT_RESULTS_DIR, { recursive: true });
        writeFileSync(join(process.env.MT_RESULTS_DIR, "recovery.json"), JSON.stringify({ staleMs, recoveryMs, at: new Date().toISOString() }));
      }
    } finally {
      src.stop();
      kill(publisher);
      publisher = null;
    }
  });

  it("hands out the newest frame only: a burst does not build a backlog", async (t) => {
    if (!factory || !MTX) return t.skip(why);
    // Not paced: FFmpeg pushes 10 s of video as fast as it can encode.
    publisher = publish(path, { realtime: false, seconds: 10 });
    const src = factory(sourceOptions(`${MTX}/${path}`));
    const arrivals: number[] = [];
    src.on("frame", () => arrivals.push(Date.now()));
    src.start();
    try {
      await until(() => publisher!.exitCode !== null, 20_000);
      const endedAt = Date.now();
      await new Promise((r) => setTimeout(r, 2500));
      const late = arrivals.filter((a) => a > endedAt + 1500).length;
      assert.ok(late <= 2, `${late} frame(s) handed out > 1.5 s after the burst ended: a queue is being drained`);
      const perSecond = new Map<number, number>();
      for (const a of arrivals) perSecond.set(Math.floor(a / 1000), (perSecond.get(Math.floor(a / 1000)) || 0) + 1);
      const peak = Math.max(0, ...perSecond.values());
      assert.ok(peak <= 15, `peak ${peak} frames/s handed out during a burst (cap ~8)`);
    } finally {
      src.stop();
      kill(publisher);
      publisher = null;
    }
  });

  it("never exposes stream credentials in states, errors, frames or logs", async (t) => {
    if (!factory || !MTX) return t.skip(why);
    const host = MTX.replace(/^rtsp:\/\//, "");
    const url = `rtsp://mt:${CANARY}@${host}/${path}-nonexistent`;
    const src = factory(sourceOptions(url, "ENTRY"));
    const seen: string[] = [];
    src.on("state", (s) => seen.push(JSON.stringify(s)));
    src.on("frame", (f) => seen.push(f.streamId));
    src.start();
    await new Promise((r) => setTimeout(r, 4000));
    src.stop();
    const all = seen.join("\n") + "\n" + logs.join("\n");
    assert.ok(!all.includes(CANARY), "the stream password leaked into states/frames/logs");
    assert.ok(seen.length > 0, "a failing source must still report state");
  });

  it("stop() ends frames and reports stopped", async (t) => {
    if (!factory || !MTX) return t.skip(why);
    publisher = publish(path);
    await new Promise((r) => setTimeout(r, 1500));
    const src = factory(sourceOptions(`${MTX}/${path}`));
    let frames = 0;
    const states: SourceState[] = [];
    src.on("frame", () => frames++);
    src.on("state", (s) => states.push(s));
    src.start();
    try {
      assert.ok(await until(() => frames > 3, 10_000));
      src.stop();
      const at = frames;
      await new Promise((r) => setTimeout(r, 2000));
      assert.ok(frames - at <= 1, "frames kept arriving after stop()");
      assert.ok(await until(() => states.some((s) => s.status === "stopped"), 2000), "no stopped state");
    } finally {
      kill(publisher);
      publisher = null;
    }
  });
});

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { Frame, SourceState } from "../src/server/pipeline/contracts";
import {
  buildStreamReaderArgs,
  createStreamReader,
  normalizeRoi,
  parseStreamSize,
  probeStreamSize,
  redactCredentials,
  type SpawnLike,
  type StreamReaderOptions,
} from "../src/server/pipeline/streamReader";

const SECRET_URL = "rtsp://admin:S3cr3tPass@192.0.2.10:554/Streaming/Channels/501";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: Array<NodeJS.Signals | number | undefined> = [];
  exited = false;
  constructor(readonly pid: number, readonly args: string[]) {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (!this.exited) {
      this.exited = true;
      this.emit("exit", null, signal); // synchronous on purpose: the reader must cope
    }
    return true;
  }
  write(bytes: Uint8Array | number[]): void {
    this.stdout.emit("data", Buffer.from(bytes as Uint8Array));
  }
}

function fakeSpawner() {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn: SpawnLike = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new FakeChild(1000 + children.length, args);
    children.push(child);
    return child;
  };
  return { spawn, children, calls, last: () => children[children.length - 1] };
}

/** 4 x 2 RGB frame = 24 bytes whose every byte is `value`. */
const W = 4;
const H = 2;
const FRAME = W * H * 3;
function frameBytes(value: number): number[] {
  return new Array(FRAME).fill(value);
}

function reader(extra: Partial<StreamReaderOptions> = {}) {
  const fake = fakeSpawner();
  const states: SourceState[] = [];
  const frames: Frame[] = [];
  const source = createStreamReader({
    gate: "EXIT",
    streamId: "exit-main",
    url: SECRET_URL,
    sourceWidth: W,
    sourceHeight: H,
    spawn: fake.spawn,
    motion: false,
    ...extra,
  });
  source.on("state", (s) => states.push(s));
  source.on("frame", (f) => frames.push(f));
  // Status transitions (heartbeat states repeat the current status; collapse them).
  const statuses = () => states.map((s) => s.status).filter((st, i, all) => i === 0 || st !== all[i - 1]);
  return { source, fake, states, frames, statuses };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
});

afterEach(() => {
  mock.timers.reset();
});

describe("buildStreamReaderArgs", () => {
  it("opens one low-latency TCP session and emits cropped RGB24 at the pipeline rate", () => {
    const args = buildStreamReaderArgs(SECRET_URL, {
      roi: [100, 200, 640, 480], fps: 8, skipFrame: null, threads: null, lowDelay: true, socketTimeoutMs: 5000,
    });
    const i = args.indexOf("-i");
    assert.equal(args[i + 1], SECRET_URL);
    const before = args.slice(0, i).join(" ");
    assert.match(before, /-rtsp_transport tcp/);
    assert.match(before, /-fflags nobuffer/);
    assert.match(before, /-flags low_delay/);
    assert.match(before, /-timeout 5000000/);
    const after = args.slice(i + 2).join(" ");
    assert.match(after, /-map 0:v:0 -an/);
    assert.match(after, /-vf crop=640:480:100:200,fps=8 -fps_mode passthrough/);
    assert.match(after, /-pix_fmt rgb24 -f rawvideo pipe:1$/);
    assert.ok(!args.includes("-skip_frame") && !args.includes("-threads"));
  });

  it("puts decoder options before the input", () => {
    const args = buildStreamReaderArgs("rtsp://cam/x", {
      roi: [0, 0, 1920, 1080], fps: 5, skipFrame: "noref", threads: 2, lowDelay: false, socketTimeoutMs: 3000,
    });
    const i = args.indexOf("-i");
    assert.ok(args.indexOf("-skip_frame") < i && args[args.indexOf("-skip_frame") + 1] === "noref");
    assert.ok(args.indexOf("-threads") < i && args[args.indexOf("-threads") + 1] === "2");
    assert.ok(!args.includes("low_delay"));
    assert.ok(args.includes("crop=1920:1080:0:0,fps=5"));
  });
});

describe("normalizeRoi", () => {
  it("defaults to the full frame and clamps/rounds to even pixels", () => {
    assert.deepEqual(normalizeRoi(undefined, 3840, 2160), [0, 0, 3840, 2160]);
    assert.deepEqual(normalizeRoi([101, 51, 641, 481], 3840, 2160), [100, 50, 640, 480]);
    assert.deepEqual(normalizeRoi([3000, 2000, 2000, 2000], 3840, 2160), [3000, 2000, 840, 160]);
    assert.deepEqual(normalizeRoi([-5, -5, 99999, 99999], 1920, 1080), [0, 0, 1920, 1080]);
    assert.deepEqual(normalizeRoi([Number.NaN, 0, 10, 10] as any, 1920, 1080), [0, 0, 1920, 1080]);
  });
});

describe("StreamReader frame slicing", () => {
  it("rebuilds exact frames across arbitrary chunk boundaries", () => {
    const { source, fake, frames } = reader();
    source.start();
    const child = fake.last();
    const stream = [...frameBytes(1), ...frameBytes(2), ...frameBytes(3)];
    // Chunks that never line up with frame edges, delivered one frame at a time at most.
    for (const [a, b] of [[0, 5], [5, 24], [24, 25], [25, 47], [47, 48], [48, 60], [60, 72]]) {
      child.write(stream.slice(a, b));
    }
    assert.equal(frames.length, 3);
    frames.forEach((f, i) => {
      assert.equal(f.rgb.length, FRAME);
      assert.ok(f.rgb.every((v) => v === i + 1), `frame ${i} content`);
      assert.equal(f.seq, i);
      assert.equal(f.width, W);
      assert.equal(f.height, H);
      assert.deepEqual(f.roi, [0, 0, W, H]);
      assert.equal(f.gate, "EXIT");
      assert.equal(f.streamId, "exit-main");
      assert.equal(f.capturedAtMs, Date.now());
    });
    source.stop();
  });

  it("hands out only the newest frame when several arrive at once", () => {
    const { source, fake, frames } = reader();
    source.start();
    const child = fake.last();
    child.write(frameBytes(9).slice(0, 10)); // partial frame
    child.write([...frameBytes(9).slice(10), ...frameBytes(8), ...frameBytes(7), ...frameBytes(6).slice(0, 4)]);
    assert.equal(frames.length, 1, "superseded frames are neither copied nor emitted");
    assert.ok(frames[0].rgb.every((v) => v === 7));
    assert.equal(frames[0].seq, 2, "seq still counts the skipped frames");
    assert.equal(source.latest(), frames[0]);
    child.write(frameBytes(6).slice(4));
    assert.equal(frames.length, 2);
    assert.ok(frames[1].rgb.every((v) => v === 6), "partial tail completes into the next frame");
    assert.equal(source.latest(), frames[1]);
    source.stop();
  });

  it("gives each frame its own buffer (a kept frame is never overwritten)", () => {
    const { source, fake, frames } = reader();
    source.start();
    fake.last().write(frameBytes(1));
    fake.last().write(frameBytes(2));
    assert.ok(frames[0].rgb.every((v) => v === 1));
    assert.ok(frames[1].rgb.every((v) => v === 2));
    source.stop();
  });

  it("latest() is null before the first frame and once the newest frame is older than staleMs", () => {
    const { source, fake } = reader({ staleMs: 1000 });
    assert.equal(source.latest(), null);
    source.start();
    assert.equal(source.latest(), null);
    fake.last().write(frameBytes(5));
    assert.ok(source.latest());
    mock.timers.tick(900);
    assert.ok(source.latest(), "still fresh");
    mock.timers.tick(200);
    assert.equal(source.latest(), null, "stale frames are never handed out");
    source.stop();
  });

  it("reports streaming state with fps and newest-frame age", () => {
    const { source, fake, statuses } = reader();
    source.start();
    assert.deepEqual(statuses(), ["starting"]);
    for (let i = 0; i < 8; i += 1) {
      fake.last().write(frameBytes(i));
      mock.timers.tick(125);
    }
    assert.equal(statuses()[1], "streaming");
    const s = (source as any).getState() as SourceState;
    assert.equal(s.status, "streaming");
    assert.equal(s.gate, "EXIT");
    assert.ok(s.fps >= 7 && s.fps <= 9, `fps ${s.fps}`);
    assert.equal(s.newestFrameAgeMs, 125);
    assert.equal(s.reconnects, 0);
    source.stop();
  });

  it("survives a listener that throws", () => {
    const { source, fake, frames } = reader();
    source.on("frame", () => {
      throw new Error("consumer bug");
    });
    source.start();
    assert.doesNotThrow(() => fake.last().write(frameBytes(1)));
    assert.doesNotThrow(() => fake.last().write(frameBytes(2)));
    assert.equal(frames.length, 2);
    source.stop();
  });
});

describe("StreamReader reconnects", () => {
  it("kills a stale stream and reconnects with doubling back-off capped at 30 s", () => {
    const { source, fake, statuses, states } = reader({ staleMs: 1000, firstFrameTimeoutMs: 5000 });
    source.start();
    fake.last().write(frameBytes(1));
    mock.timers.tick(1250); // > staleMs without a frame
    assert.deepEqual(fake.children[0].signals, ["SIGKILL"]);
    assert.deepEqual(statuses().slice(0, 4), ["starting", "streaming", "stale", "reconnecting"]);
    assert.match(states.find((st) => st.status === "stale")?.lastError || "", /no frame for/);
    assert.equal(source.latest(), null);

    // Reconnect #1 after 1 s.
    mock.timers.tick(999);
    assert.equal(fake.children.length, 1);
    mock.timers.tick(1);
    assert.equal(fake.children.length, 2);
    // The camera stays dead: no first frame -> kill after firstFrameTimeoutMs, then 2 s, 4 s, ...
    const expected = [2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of expected) {
      const before = fake.children.length;
      mock.timers.tick(5250); // first-frame timeout on the current child
      assert.deepEqual(fake.last().signals, ["SIGKILL"]);
      mock.timers.tick(delay - 1);
      assert.equal(fake.children.length, before, `no reconnect before ${delay} ms`);
      mock.timers.tick(1);
      assert.equal(fake.children.length, before + 1, `reconnect after ${delay} ms`);
    }
    const s = (source as any).getState() as SourceState;
    assert.equal(s.reconnects, 1 + expected.length);
    assert.equal(s.status, "starting");
    source.stop();
  });

  it("reconnects after FFmpeg exits or fails to spawn, without throwing", () => {
    const fake = fakeSpawner();
    let n = 0;
    const spawn: SpawnLike = (cmd, args, o) => {
      n += 1;
      if (n === 2) throw new Error("spawn ffmpeg ENOENT");
      return fake.spawn(cmd, args, o);
    };
    const source = createStreamReader({ gate: "ENTRY", streamId: "entry", url: SECRET_URL, sourceWidth: W, sourceHeight: H, spawn });
    assert.doesNotThrow(() => source.start());
    fake.last().stderr.emit("data", Buffer.from(`[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized for ${SECRET_URL}\n`));
    fake.last().emit("exit", 1, null);
    assert.equal((source as any).getState().status, "reconnecting");
    assert.doesNotThrow(() => mock.timers.tick(1000)); // spawn throws -> reconnecting again
    assert.equal((source as any).getState().status, "reconnecting");
    assert.match((source as any).getState().lastError, /could not start/);
    mock.timers.tick(2000);
    assert.equal(fake.children.length, 2);
    fake.last().emit("error", new Error("boom"));
    fake.last().emit("exit", 1, null); // the second event of the same process is ignored
    mock.timers.tick(4000);
    assert.equal(fake.children.length, 3);
    source.stop();
  });

  it("resets the back-off after healthy streaming", () => {
    const { source, fake } = reader({ staleMs: 1000, backoffResetMs: 10_000 });
    source.start();
    // Two quick failures -> next delay would be 4 s.
    fake.last().emit("exit", 1, null);
    mock.timers.tick(1000);
    fake.last().emit("exit", 1, null);
    mock.timers.tick(2000);
    assert.equal(fake.children.length, 3);
    for (let t = 0; t < 12_000; t += 250) {
      fake.last().write(frameBytes(1));
      mock.timers.tick(250);
    }
    fake.last().emit("exit", 1, null);
    mock.timers.tick(1000);
    assert.equal(fake.children.length, 4, "back to the 1 s first delay");
    source.stop();
  });

  it("restarts seq at 0 and clears old frames on reconnect", () => {
    const { source, fake, frames } = reader();
    source.start();
    fake.last().write([...frameBytes(1), ...frameBytes(2)]);
    fake.last().emit("exit", 0, null);
    assert.equal(source.latest(), null);
    mock.timers.tick(1000);
    fake.last().write(frameBytes(3));
    assert.equal(frames[frames.length - 1].seq, 0);
    source.stop();
  });

  it("ignores output of a process it already replaced", () => {
    const { source, fake, frames } = reader();
    source.start();
    const old = fake.last();
    old.emit("exit", 1, null);
    mock.timers.tick(1000);
    old.write(frameBytes(7));
    old.emit("exit", 1, null);
    assert.equal(frames.length, 0);
    assert.equal(fake.children.length, 2);
    assert.equal((source as any).getState().status, "starting");
    source.stop();
  });
});

describe("StreamReader stop()", () => {
  it("hard-kills FFmpeg and never reconnects", () => {
    const { source, fake, statuses } = reader();
    source.start();
    fake.last().write(frameBytes(1));
    source.stop();
    assert.deepEqual(fake.children[0].signals, ["SIGKILL"]);
    assert.equal(statuses()[statuses().length - 1], "stopped");
    assert.equal(source.latest(), null);
    mock.timers.tick(120_000);
    assert.equal(fake.children.length, 1);
    fake.children[0].write(frameBytes(2)); // late output
    assert.equal(source.latest(), null);
  });

  it("stops a pending reconnect", () => {
    const { source, fake } = reader();
    source.start();
    fake.last().emit("exit", 1, null);
    source.stop();
    mock.timers.tick(60_000);
    assert.equal(fake.children.length, 1);
  });

  it("can be started again after stop()", () => {
    const { source, fake, frames } = reader();
    source.start();
    source.stop();
    source.start();
    assert.equal(fake.children.length, 2);
    fake.last().write(frameBytes(4));
    assert.equal(frames.length, 1);
    source.stop();
  });
});

describe("StreamReader configuration and secrets", () => {
  it("never puts credentials in state or errors", () => {
    const { source, fake, states } = reader();
    source.start();
    fake.last().stderr.emit("data", Buffer.from(`[rtsp @ 0x55] Could not open ${SECRET_URL}: 401 Unauthorized\n`));
    fake.last().emit("exit", 1, null);
    mock.timers.tick(1000);
    fake.last().emit("error", new Error(`connect ECONNREFUSED ${SECRET_URL}`));
    const everything = JSON.stringify(states) + JSON.stringify((source as any).getState());
    assert.ok(!everything.includes("S3cr3tPass"), "password leaked");
    assert.ok(!everything.includes("admin:"), "login leaked");
    assert.match(everything, /rtsp:\/\/<login>@192\.0\.2\.10/);
    assert.ok(states.some((s) => /401 Unauthorized/.test(s.lastError || "")), "the useful part of the error survives");
    source.stop();
  });

  it("redacts any scheme's credentials", () => {
    assert.equal(redactCredentials("x rtsp://a:b@h/y https://u:p@h2 z"), "x rtsp://<login>@h/y https://<login>@h2 z");
    assert.equal(redactCredentials(undefined), "");
  });

  it("refuses to run on an invalid configuration without throwing or spawning", () => {
    const fake = fakeSpawner();
    const states: SourceState[] = [];
    const source = createStreamReader({ gate: "ENTRY", streamId: "e", url: SECRET_URL, sourceWidth: 0, sourceHeight: 1080, spawn: fake.spawn });
    source.on("state", (s) => states.push(s));
    assert.doesNotThrow(() => source.start());
    assert.equal(fake.children.length, 0);
    assert.equal(states[0].status, "stopped");
    assert.match(states[0].lastError || "", /invalid source size/);
    const noUrl = createStreamReader({ gate: "ENTRY", streamId: "e", url: "", sourceWidth: 4, sourceHeight: 2, spawn: fake.spawn });
    noUrl.start();
    assert.equal(fake.children.length, 0);
  });

  it("uses the normalized ROI for frame size and metadata", () => {
    const { source, fake, frames } = reader({ sourceWidth: 1920, sourceHeight: 1080, roi: [11, 21, 5, 3] });
    source.start();
    assert.ok(fake.last().args.includes("crop=4:2:10:20,fps=8"));
    fake.last().write(frameBytes(3));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].roi, [10, 20, 4, 2]);
    assert.equal(frames[0].sourceWidth, 1920);
    assert.equal(frames[0].sourceHeight, 1080);
    source.stop();
  });
});

describe("StreamReader motion", () => {
  it("reports motion only when the gate area changes (after the hold)", () => {
    const { source, fake, frames } = reader({ motion: { holdMs: 0, thumbWidth: 4, samplesPerAxis: 1 } });
    source.start();
    fake.last().write(frameBytes(50));
    mock.timers.tick(125);
    fake.last().write(frameBytes(50));
    mock.timers.tick(125);
    fake.last().write(frameBytes(200));
    assert.equal(source.motion!(frames[0]), true, "first frame: no reference, fail open");
    assert.equal(source.motion!(frames[1]), false, "still scene");
    assert.equal(source.motion!(frames[2]), true, "changed scene");
    source.stop();
  });

  it("always says true when motion is disabled or the frame is unknown", () => {
    const off = reader({ motion: false });
    off.source.start();
    off.fake.last().write(frameBytes(1));
    off.fake.last().write(frameBytes(1));
    assert.equal(off.source.motion!(off.frames[1]), true);
    off.source.stop();
    const on = reader({ motion: { holdMs: 0 } });
    assert.equal(on.source.motion!({ ...off.frames[1] }), true);
  });
});

describe("probeStreamSize", () => {
  const dump = [
    "Input #0, rtsp, from 'rtsp://<login>@192.0.2.10:554/Streaming/Channels/501':",
    "  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160, 15 fps, 15 tbr, 90k tbn",
    "  Stream #0:1: Audio: pcm_mulaw, 8000 Hz, mono, s16, 64 kb/s",
  ].join("\n");

  it("parses the first video stream's size, not a size cut off mid-chunk", () => {
    assert.deepEqual(parseStreamSize(dump), { width: 3840, height: 2160 });
    assert.equal(parseStreamSize("  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x21"), null);
    assert.equal(parseStreamSize("Stream #0:0: Audio: pcm_mulaw"), null);
    assert.deepEqual(
      parseStreamSize("Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuvj420p(pc), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps"),
      { width: 1920, height: 1080 },
    );
  });

  it("resolves the size and kills the probe as soon as it is known", async () => {
    mock.timers.reset();
    const fake = fakeSpawner();
    const pending = probeStreamSize(SECRET_URL, { spawn: fake.spawn, timeoutMs: 5000 });
    const child = fake.last();
    assert.ok(!child.args.includes("-f"), "no output is written");
    child.stderr.emit("data", Buffer.from(dump.slice(0, 120)));
    child.stderr.emit("data", Buffer.from(dump.slice(120)));
    assert.deepEqual(await pending, { width: 3840, height: 2160 });
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });

  it("resolves null on failure or timeout, never rejects", async () => {
    mock.timers.reset();
    const failing: SpawnLike = () => {
      throw new Error("ENOENT");
    };
    assert.equal(await probeStreamSize(SECRET_URL, { spawn: failing }), null);
    const fake = fakeSpawner();
    const hung = probeStreamSize(SECRET_URL, { spawn: fake.spawn, timeoutMs: 100 });
    assert.equal(await hung, null);
    assert.deepEqual(fake.last().signals, ["SIGKILL"]);
  });
});

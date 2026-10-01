/**
 * Manual measurement of the StreamReader on a real camera/NVR stream (STR, step 1).
 * Read-only: opens ONE RTSP session for at most --seconds (capped at 90 s), saves
 * no pictures, prints a JSON line without the URL.
 *
 * The URL (may carry credentials) is read from a file or the environment, never
 * from the command line:
 *   MEASURE_URL_FILE=/path/0600-file   (preferred)   or   MEASURE_URL=rtsp://...
 *
 *   npx tsx scripts/pipeline/measure-stream.ts --gate entry --source 3840x2160 \
 *     [--seconds 30] [--fps 8] [--roi x,y,w,h] [--skip-frame noref] [--threads 2] \
 *     [--no-low-delay] [--latency] [--label name]
 *
 * Reports: time to first frame, delivered fps, newest-frame age as a consumer
 * sampling latest() sees it, FFmpeg CPU (from /proc/<pid>/stat) and the reader's
 * own Node CPU. With --latency the decoder is also asked to stamp each packet
 * with its arrival wall-clock (-use_wallclock_as_timestamps) and log it after
 * decode+crop (showinfo); arrival->decoded delay is reported per frame.
 * Camera-side delay (sensor -> encoder -> network) is not measurable this way.
 */
import { readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

import type { Frame, SourceState } from "../../src/server/pipeline/contracts";
import { isGateId } from "../../src/server/gates";
import { createStreamReader, probeStreamSize, redactCredentials, type SpawnLike } from "../../src/server/pipeline/streamReader";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const round = (n: number | null, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function cpuTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]); // utime + stime (fields 14, 15)
  } catch {
    return null;
  }
}

function lumaStats(frame: Frame): { mean: number; std: number } {
  let sum = 0;
  let sq = 0;
  let n = 0;
  const step = Math.max(3, Math.floor(frame.rgb.length / 3 / 20000) * 3);
  for (let i = 0; i + 2 < frame.rgb.length; i += step) {
    const y = (frame.rgb[i] * 77 + frame.rgb[i + 1] * 150 + frame.rgb[i + 2] * 29) >> 8;
    sum += y;
    sq += y * y;
    n += 1;
  }
  const mean = sum / n;
  return { mean: round(mean) as number, std: round(Math.sqrt(Math.max(0, sq / n - mean * mean))) as number };
}

async function main() {
  const url = (process.env.MEASURE_URL_FILE ? readFileSync(process.env.MEASURE_URL_FILE, "utf8") : process.env.MEASURE_URL || "").trim();
  if (!url) {
    console.error("Set MEASURE_URL_FILE (or MEASURE_URL).");
    process.exit(2);
  }
  // A configured gate id ("entry", "exit", "side-door"); the pipeline refuses directions.
  const gate = String(arg("gate") || "entry").toLowerCase();
  if (!isGateId(gate)) {
    console.error("--gate must be a gate id (e.g. entry, exit, side-door).");
    process.exit(2);
  }
  const seconds = Math.min(90, Math.max(5, Number(arg("seconds") || 30)));
  const fps = Number(arg("fps") || 8);
  const label = arg("label") || "default";
  const latencyProbe = flag("latency");
  let sourceWidth = 0;
  let sourceHeight = 0;
  const source = arg("source");
  if (source && /^\d+x\d+$/.test(source)) {
    [sourceWidth, sourceHeight] = source.split("x").map(Number);
  } else {
    const probed = await probeStreamSize(url);
    if (!probed) {
      console.error("Could not read the stream size; pass --source WxH.");
      process.exit(3);
    }
    ({ width: sourceWidth, height: sourceHeight } = probed);
  }
  const roiArg = arg("roi");
  const roi = roiArg ? (roiArg.split(",").map(Number) as [number, number, number, number]) : undefined;
  const threadsArg = arg("threads");

  let pid: number | undefined;
  const decodedDelays: number[] = [];
  let stderrLines = 0;
  const spawn: SpawnLike = (cmd, args, options) => {
    let a = args;
    if (latencyProbe) {
      a = [...args];
      // Wall-clock packet stamps, kept absolute (-copyts) through decode and crop.
      a.splice(a.indexOf("-i"), 0, "-use_wallclock_as_timestamps", "1", "-copyts");
      const vf = a.indexOf("-vf") + 1;
      a[vf] = a[vf].replace(",fps=", ",showinfo=checksum=0,fps=");
      a[a.indexOf("-loglevel") + 1] = "info";
    }
    const child = nodeSpawn(cmd, a, options);
    pid = child.pid;
    if (latencyProbe) {
      let buf = "";
      let tbMs = 0; // showinfo's time base in ms per tick
      child.stderr?.on("data", (chunk: Buffer) => {
        const now = Date.now();
        buf += String(chunk);
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          stderrLines += 1;
          const tb = /Parsed_showinfo.*config in time_base: (\d+)\/(\d+)/.exec(line);
          if (tb) tbMs = (Number(tb[1]) / Number(tb[2])) * 1000;
          const m = /Parsed_showinfo.*\bpts:\s*(\d+)/.exec(line);
          if (m && tbMs) decodedDelays.push(now - Number(m[1]) * tbMs);
        }
      });
    }
    return child;
  };

  const reader = createStreamReader({
    gate,
    streamId: `${gate.toLowerCase()}-measure`,
    url,
    sourceWidth,
    sourceHeight,
    roi,
    fps,
    decoder: {
      skipFrame: (arg("skip-frame") as "noref" | "bidir" | "nointra" | "nokey" | undefined) || null,
      threads: threadsArg != null ? Number(threadsArg) : null,
      lowDelay: !flag("no-low-delay"),
    },
    spawn,
  });

  const t0 = Date.now();
  let firstFrameAt: number | null = null;
  let firstFrame: { mean: number; std: number } | null = null;
  let lastFrame: Frame | null = null;
  let frames = 0;
  let skipped = 0;
  let lastSeq = -1;
  let motionFrames = 0;
  let framesInCpuWindow = 0;
  let framesFirstSecond = 0;
  const states: Array<SourceState & { atS: number }> = [];
  reader.on("frame", (f) => {
    frames += 1;
    if (cpuStart) framesInCpuWindow += 1;
    if (firstFrameAt != null && Date.now() - (firstFrameAt as number) < 1000) framesFirstSecond += 1;
    if (firstFrameAt == null) {
      firstFrameAt = Date.now();
      firstFrame = lumaStats(f);
    }
    if (lastSeq >= 0 && f.seq > lastSeq + 1) skipped += f.seq - lastSeq - 1;
    lastSeq = f.seq;
    if (reader.motion?.(f)) motionFrames += 1;
    lastFrame = f;
  });
  reader.on("state", (s) => {
    if (!states.length || states[states.length - 1].status !== s.status) states.push({ ...s, atS: round((Date.now() - t0) / 1000) as number });
  });

  const ages: number[] = [];
  let nulls = 0;
  let cpuStart: { ticks: number; at: number; node: NodeJS.CpuUsage } | null = null;
  const sampler = setInterval(() => {
    const f = reader.latest();
    if (f) ages.push(Date.now() - f.capturedAtMs);
    else if (firstFrameAt != null) nulls += 1;
    // CPU window starts 2 s after the first frame (skip connect/probe burst).
    if (!cpuStart && firstFrameAt != null && Date.now() - firstFrameAt >= 2000 && pid) {
      const ticks = cpuTicks(pid);
      if (ticks != null) cpuStart = { ticks, at: Date.now(), node: process.cpuUsage() };
    }
  }, 37); // not a divisor of the frame interval: samples land at random phases

  reader.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(sampler);
  const end = Date.now();
  const ticksEnd = pid ? cpuTicks(pid) : null;
  const nodeCpu = cpuStart ? process.cpuUsage(cpuStart.node) : null;
  const finalState = reader.getState();
  reader.stop();

  const clkTck = 100;
  const windowS = cpuStart ? (end - cpuStart.at) / 1000 : 0;
  const result = {
    label,
    gate,
    source: `${sourceWidth}x${sourceHeight}`,
    roi: lastFrame ? (lastFrame as Frame).roi : roi || null,
    fps,
    seconds,
    decoder: { skipFrame: arg("skip-frame") || null, threads: threadsArg ?? null, lowDelay: !flag("no-low-delay") },
    timeToFirstFrameMs: firstFrameAt != null ? firstFrameAt - t0 : null,
    framesDelivered: frames,
    framesSkippedNewestWins: skipped,
    deliveredFps: firstFrameAt != null ? round(frames / ((end - (firstFrameAt as number)) / 1000), 2) : 0,
    steadyFps: windowS > 0 ? round(framesInCpuWindow / windowS, 2) : null,
    framesInFirstSecond: framesFirstSecond + (firstFrameAt != null ? 1 : 0),
    motionFrames,
    newestFrameAgeMs: { p50: percentile(ages, 50), p95: percentile(ages, 95), max: percentile(ages, 100), samples: ages.length, nullAfterFirst: nulls },
    decodeDelayMs: latencyProbe
      ? { p50: round(percentile(decodedDelays, 50)), p95: round(percentile(decodedDelays, 95)), max: round(percentile(decodedDelays, 100)), samples: decodedDelays.length, stderrLines }
      : undefined,
    ffmpegCpuCores: cpuStart && ticksEnd != null && windowS > 0 ? round((ticksEnd - cpuStart.ticks) / clkTck / windowS, 2) : null,
    nodeReaderCpuCores: nodeCpu && windowS > 0 ? round((nodeCpu.user + nodeCpu.system) / 1e6 / windowS, 3) : null,
    firstFrameLuma: firstFrame,
    lastFrameLuma: lastFrame ? lumaStats(lastFrame) : null,
    reconnects: finalState.reconnects,
    statuses: states.map((s) => `${s.atS}s ${s.status}`),
    lastError: finalState.lastError ? redactCredentials(finalState.lastError) : undefined,
  };
  console.log(JSON.stringify(result));
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error(redactCredentials(err?.stack || err));
  process.exit(1);
});

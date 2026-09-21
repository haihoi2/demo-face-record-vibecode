/**
 * Backend gate watchers (server-side auto-scan).
 *
 * The browser `setInterval` that used to drive auto-scan is now a backend job:
 * a per-gate, self-rescheduling `setTimeout` chain that runs the very same
 * gate-wide scan POST /api/camera-streams/scan-rtsp runs.
 *
 * Covered here: the persisted `watch` block and its defaults/clamping, the two
 * endpoints (`GET /api/camera-streams/watch`, `POST /api/camera-streams/:gate/watch`),
 * the config round-trip, and - the point of the whole exercise - that scans
 * NEVER overlap and that a dead camera is backed off instead of hammered.
 *
 * The suite snapshots the camera config (streams + watch of both gates) in
 * `before` and restores it in `after`; the only stream it ever points at is
 * `rtsp://127.0.0.1:1/...` (connection refused instantly), so nothing here
 * depends on a reachable camera and no scan ever waits on a socket timeout.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { api, postJson } from "./helpers";

interface WatchConfig {
  enabled: boolean;
  intervalSeconds: number;
  frames: number;
}

interface WatchRuntime {
  gate: "ENTRY" | "EXIT";
  enabled: boolean;
  intervalSeconds: number;
  frames: number;
  running: boolean;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastBasis?: string;
  lastRecognized?: boolean;
  lastEmployeeName?: string;
  lastError?: string;
  consecutiveErrors: number;
  totalRuns: number;
  nextRunAt?: string;
}

interface GateConfig {
  gateType: "ENTRY" | "EXIT";
  watch?: WatchConfig;
  streams: Array<Record<string, unknown> & { id: string; enabled: boolean }>;
  [key: string]: unknown;
}

interface CameraConfig {
  entryGate: GateConfig;
  exitGate: GateConfig;
  [key: string]: unknown;
}

const UNREACHABLE_STREAM = {
  id: "exit-watch-itest",
  label: "gateWatch integration probe",
  sourceType: "RTSP",
  // Port 1 on loopback: ECONNREFUSED in milliseconds, so a "failing scan" is
  // fast and the whole suite stays well inside its time budget.
  rtspUrl: "rtsp://127.0.0.1:1/watch-itest",
  rtspTransport: "TCP",
  enabled: true,
  priority: 1,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Both gates' stream lists - the shared state `streams.test.ts` also rewrites. */
function streamFingerprint(config: CameraConfig): string {
  return JSON.stringify([config.entryGate.streams, config.exitGate.streams]);
}

/**
 * The scheduling test below needs the exit gate to itself for ~8 s, and
 * `streams.test.ts` runs in parallel against the same two gates. Wait until
 * BOTH gates' stream lists are back at the pristine snapshot and have stayed
 * there for `stableMs` - that suite rewrites one gate or the other almost
 * continuously and puts everything back in its own `after`, so a quiet
 * pristine config means it is done. Gives up after `deadlineMs` and runs
 * anyway rather than turning a race into a hang.
 */
async function waitForQuietCameraConfig(original: CameraConfig, stableMs = 1_500, deadlineMs = 25_000) {
  const pristine = streamFingerprint(original);
  const until = Date.now() + deadlineMs;
  let quietSince = 0;
  while (Date.now() < until) {
    if (streamFingerprint(await getConfig()) === pristine) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= stableMs) return true;
    } else {
      quietSince = 0;
    }
    await sleep(250);
  }
  return false;
}

async function getConfig(): Promise<CameraConfig> {
  const res = await api("/api/camera-streams/config");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body?.success, true);
  return res.body.config;
}

async function getWatchers(): Promise<WatchRuntime[]> {
  const res = await api("/api/camera-streams/watch");
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body?.success, true);
  assert.ok(Array.isArray(res.body.watchers), "watchers must be an array");
  return res.body.watchers;
}

async function getWatcher(gate: "ENTRY" | "EXIT"): Promise<WatchRuntime> {
  const found = (await getWatchers()).find((w) => w.gate === gate);
  assert.ok(found, `GET /api/camera-streams/watch must report the ${gate} gate`);
  return found!;
}

function postWatch(gate: string, payload: unknown) {
  return postJson(`/api/camera-streams/${gate}/watch`, payload);
}

/** Puts a gate's watch block back exactly as it was found. */
async function restoreWatch(gate: "entry" | "exit", watch: WatchConfig | undefined) {
  if (!watch) return;
  const res = await postWatch(gate, watch);
  assert.equal(res.status, 200, `restoring ${gate} watch failed: ${res.text.slice(0, 200)}`);
}

describe("Backend gate watch (server-side auto-scan)", () => {
  let original: CameraConfig;

  before(async () => {
    original = await getConfig();
  });

  after(async () => {
    // Stop anything this suite started before writing the streams back, so no
    // scan of ours can still be in flight against a restored config.
    await postWatch("entry", { enabled: false });
    await postWatch("exit", { enabled: false });
    const res = await postJson("/api/camera-streams/config", {
      entryGate: { streams: original.entryGate.streams, watch: original.entryGate.watch },
      exitGate: { streams: original.exitGate.streams, watch: original.exitGate.watch },
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    await restoreWatch("entry", original.entryGate.watch);
    await restoreWatch("exit", original.exitGate.watch);

    const restored = await getConfig();
    assert.deepEqual(
      restored.exitGate.streams.map((s) => s.id),
      original.exitGate.streams.map((s) => s.id),
      "exit gate streams must be restored"
    );
    assert.deepEqual(restored.entryGate.watch, original.entryGate.watch, "entry watch must be restored");
    assert.deepEqual(restored.exitGate.watch, original.exitGate.watch, "exit watch must be restored");
  });

  describe("config contract", () => {
    it("both gates carry a normalised watch block, disabled by default", () => {
      for (const gate of ["entryGate", "exitGate"] as const) {
        const watch = original[gate].watch;
        assert.ok(watch, `${gate}.watch must be present in GET /api/camera-streams/config`);
        assert.equal(typeof watch!.enabled, "boolean", `${gate}.watch.enabled must be a boolean`);
        // A backend job that can drive an unlock decision unattended must be
        // switched on deliberately - deploying must never start it.
        assert.equal(watch!.enabled, false, `${gate}.watch must default to disabled`);
        assert.equal(watch!.intervalSeconds, 3, `${gate}.watch.intervalSeconds default`);
        assert.equal(watch!.frames, 1, `${gate}.watch.frames default`);
      }
    });

    it("GET /api/camera-streams/watch reports a runtime for both gates", async () => {
      const watchers = await getWatchers();
      assert.deepEqual(watchers.map((w) => w.gate).sort(), ["ENTRY", "EXIT"]);
      for (const w of watchers) {
        assert.equal(typeof w.running, "boolean");
        assert.equal(typeof w.consecutiveErrors, "number");
        assert.equal(typeof w.totalRuns, "number");
        assert.ok(w.intervalSeconds >= 1 && w.intervalSeconds <= 300);
        assert.ok(w.frames >= 1 && w.frames <= 5);
      }
    });

    it("clamps out-of-range values written through the config endpoint", async () => {
      const high = await postJson("/api/camera-streams/config", {
        exitGate: { watch: { enabled: false, intervalSeconds: 9999, frames: 99 } },
      });
      assert.equal(high.status, 200, high.text.slice(0, 200));
      assert.deepEqual(high.body.config.exitGate.watch, { enabled: false, intervalSeconds: 300, frames: 5 });

      const low = await postJson("/api/camera-streams/config", {
        exitGate: { watch: { enabled: false, intervalSeconds: 0, frames: -4 } },
      });
      assert.equal(low.status, 200, low.text.slice(0, 200));
      assert.deepEqual(low.body.config.exitGate.watch, { enabled: false, intervalSeconds: 1, frames: 1 });

      await restoreWatch("exit", original.exitGate.watch);
    });

    it("a partial watch patch keeps the gate's other watch values", async () => {
      const seeded = await postWatch("exit", { enabled: false, intervalSeconds: 11, frames: 3 });
      assert.equal(seeded.status, 200, seeded.text.slice(0, 200));
      const patched = await postJson("/api/camera-streams/config", { exitGate: { watch: { frames: 2 } } });
      assert.equal(patched.status, 200, patched.text.slice(0, 200));
      assert.deepEqual(patched.body.config.exitGate.watch, { enabled: false, intervalSeconds: 11, frames: 2 });

      await restoreWatch("exit", original.exitGate.watch);
    });

    it("round-trips through GET /api/camera-streams/config and GET .../watch", async () => {
      const res = await postWatch("entry", { enabled: false, intervalSeconds: 7, frames: 2 });
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.deepEqual(res.body.watch, { enabled: false, intervalSeconds: 7, frames: 2 });

      const cfg = await getConfig();
      assert.deepEqual(cfg.entryGate.watch, { enabled: false, intervalSeconds: 7, frames: 2 });
      assert.deepEqual(cfg.exitGate.watch, original.exitGate.watch, "the other gate is untouched");

      const runtime = await getWatcher("ENTRY");
      assert.equal(runtime.enabled, false);
      assert.equal(runtime.intervalSeconds, 7);
      assert.equal(runtime.frames, 2);

      await restoreWatch("entry", original.entryGate.watch);
    });
  });

  describe("input validation", () => {
    it("400 on an unknown gate", async () => {
      const res = await postWatch("lobby", { enabled: true });
      assert.equal(res.status, 400, res.text.slice(0, 200));
      assert.equal(res.body?.success, false);
    });

    it("400 on out-of-range intervalSeconds / frames, leaving the config untouched", async () => {
      const cases: Array<Record<string, unknown>> = [
        { intervalSeconds: 0 },
        { intervalSeconds: 301 },
        { intervalSeconds: "soon" },
        { frames: 0 },
        { frames: 6 },
        { enabled: "yes" },
      ];
      for (const payload of cases) {
        const res = await postWatch("entry", payload);
        assert.equal(res.status, 400, `${JSON.stringify(payload)} must be rejected: ${res.text.slice(0, 200)}`);
        assert.equal(res.body?.success, false);
      }
      const cfg = await getConfig();
      assert.deepEqual(cfg.entryGate.watch, original.entryGate.watch, "a rejected write must not change the config");
      const runtime = await getWatcher("ENTRY");
      assert.equal(runtime.enabled, false, "a rejected write must not start a watcher");
    });
  });

  describe("scheduling: never overlapping, backing off on failure", () => {
    it("runs one scan at a time and backs off while the camera is dead", async () => {
      const intervalSeconds = 1;
      await waitForQuietCameraConfig(original);
      const startedAt = Date.now();
      const samples: WatchRuntime[] = [];
      try {
        // Own the exit gate's stream list for the length of this test: a single
        // stream that refuses connections, so every scan fails fast and the
        // backoff is deterministic on any machine (with or without the NVR).
        const swapped = await postJson("/api/camera-streams/config", {
          exitGate: { streams: [UNREACHABLE_STREAM] },
        });
        assert.equal(swapped.status, 200, swapped.text.slice(0, 200));

        const enabled = await postWatch("exit", { enabled: true, intervalSeconds, frames: 1 });
        assert.equal(enabled.status, 200, enabled.text.slice(0, 200));
        const started: WatchRuntime = enabled.body.watcher;
        assert.equal(started.enabled, true, "enabling must report enabled:true");
        assert.equal(started.intervalSeconds, intervalSeconds);
        assert.ok(started.nextRunAt, "enabling must report when the first scan is due");
        assert.ok(
          Date.parse(started.nextRunAt!) >= startedAt,
          `nextRunAt must be in the future, got ${started.nextRunAt}`
        );

        // ~8 s of observation. With a 1 s gap and the 2^errors backoff the
        // expected run times are ~0.5 s, ~2.5 s and ~6.5 s: three runs.
        while (Date.now() - startedAt < 8_000) {
          samples.push(await getWatcher("EXIT"));
          await sleep(250);
        }
        assert.ok(
          JSON.stringify((await getConfig()).exitGate.streams.map((s) => s.id)) ===
            JSON.stringify([UNREACHABLE_STREAM.id]),
          "another suite changed the exit gate mid-test; re-run the integration suite"
        );
      } finally {
        await postWatch("exit", { enabled: false });
        const restored = await postJson("/api/camera-streams/config", {
          exitGate: { streams: original.exitGate.streams },
        });
        assert.equal(restored.status, 200, restored.text.slice(0, 200));
      }

      const runCounts = samples.map((s) => s.totalRuns);
      const last = samples[samples.length - 1];
      assert.ok(samples.length >= 10, `expected a decent number of polls, got ${samples.length}`);

      // 1. totalRuns only ever moves forward, and never by more than one scan
      //    between two polls: the setTimeout chain cannot start a second scan
      //    while one is in flight, and it never fires a burst of catch-up ticks.
      for (let i = 1; i < runCounts.length; i++) {
        const delta = runCounts[i] - runCounts[i - 1];
        assert.ok(delta === 0 || delta === 1, `totalRuns jumped by ${delta} between two polls: ${runCounts.join(",")}`);
      }

      // 2. The scans that DID happen are at least `intervalSeconds` apart -
      //    the interval is an honest gap between scans, not a period.
      const runTimes = [...new Set(samples.map((s) => s.lastRunAt).filter(Boolean) as string[])].map((t) =>
        Date.parse(t)
      );
      for (let i = 1; i < runTimes.length; i++) {
        assert.ok(
          runTimes[i] - runTimes[i - 1] >= intervalSeconds * 1000 - 100,
          `two scans started ${runTimes[i] - runTimes[i - 1]} ms apart, closer than the ${intervalSeconds}s gap`
        );
      }

      // 3. Run count tracks elapsed / (gap + scan duration), not elapsed / 0.
      //    The hard ceiling is one run per interval; the backoff makes the real
      //    number much smaller (3 runs in 8 s rather than 8).
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      assert.ok(last.totalRuns >= 2, `expected the watcher to have run at least twice, got ${last.totalRuns}`);
      assert.ok(
        last.totalRuns <= Math.floor(elapsedSeconds / intervalSeconds) + 1,
        `totalRuns ${last.totalRuns} exceeds one run per ${intervalSeconds}s over ${elapsedSeconds}s`
      );
      assert.ok(last.totalRuns <= 5, `backoff should have kept the run count low, got ${last.totalRuns}`);

      // 4. Every scan of a refused port fails, so the error count rises with it
      //    and the next run is pushed out by intervalSeconds * 2^errors.
      assert.equal(last.consecutiveErrors, last.totalRuns, "every scan of a dead camera must count as an error");
      assert.ok(last.consecutiveErrors >= 2, `expected consecutive errors to accumulate, got ${last.consecutiveErrors}`);
      assert.ok(last.lastError, "the watcher must report why the scan failed");
      assert.equal(last.lastRecognized, false, "a failed scan must never report a recognition");

      const backedOff = samples.filter((s) => s.lastRunAt && s.nextRunAt);
      const widest = backedOff.reduce(
        (max, s) => Math.max(max, Date.parse(s.nextRunAt!) - Date.parse(s.lastRunAt!)),
        0
      );
      assert.ok(
        widest > intervalSeconds * 1000 * 1.5,
        `the gap should have backed off past ${intervalSeconds}s, widest seen was ${widest} ms`
      );
      assert.ok(widest <= 60_000, `backoff must stay capped at 60 s, saw ${widest} ms`);
    });

    it("disabling stops the watcher: no further runs, no next run scheduled", async () => {
      const before = await getWatcher("EXIT");
      assert.equal(before.enabled, false, "the previous test left the watcher stopped");
      assert.equal(before.nextRunAt, undefined, "a stopped watcher has no scheduled run");

      // Nothing may run after the stop, even though a scan was in flight
      // moments ago: the stopped watcher's generation no longer matches.
      await sleep(2_500);
      const after = await getWatcher("EXIT");
      assert.equal(after.totalRuns, before.totalRuns, "a stopped watcher must not run again");
      assert.equal(after.running, false);
      assert.equal(after.nextRunAt, undefined);
    });
  });
});

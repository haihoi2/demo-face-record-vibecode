#!/usr/bin/env -S npx tsx
/**
 * SYNTHETIC crop set in the scripts/perf/calib-crops.ts layout, for validating
 * scripts/perf/engine-compare.ts end to end on a machine WITHOUT biometric data
 * (Taiga #513). Nothing here is a face: every "identity" is a deterministic
 * procedural texture and every "capture" a noisy, shifted, re-lit copy of it, so
 * the accuracy numbers a run produces are meaningless; only the harness
 * mechanics (preprocessing, pairing, metrics, report shape, identical-model
 * sanity) are exercised. index.json carries `synthetic: true` and the harness
 * prints a warning when it sees it.
 *
 *   npx tsx scripts/perf/engine-compare-fixture.ts <out-dir> [--identities 6] [--per 4] [--denied 4] [--seed 1]
 */
import fs from "node:fs";
import path from "node:path";
import { resizeBilinearU8, type RgbU8 } from "./engineCompareLib";

const SIZE = 112;

/** mulberry32: small, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth low-frequency texture (sum of a few sinusoids + blobs) at 128x128. */
export function identityPattern(r: () => number): RgbU8 {
  const N = 128;
  const waves = Array.from({ length: 4 }, () => ({ fx: (r() - 0.5) * 0.25, fy: (r() - 0.5) * 0.25, ph: r() * 6.283, amp: 20 + r() * 30, c: [r(), r(), r()] }));
  const blobs = Array.from({ length: 3 }, () => ({ x: 20 + r() * 88, y: 20 + r() * 88, s: 8 + r() * 14, amp: (r() - 0.5) * 120, c: [r(), r(), r()] }));
  const data = new Uint8Array(N * N * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (let c = 0; c < 3; c++) {
        let v = 120;
        for (const w of waves) v += w.amp * (0.5 + w.c[c]) * Math.sin(w.fx * x + w.fy * y + w.ph);
        for (const b of blobs) v += b.amp * (0.5 + b.c[c]) * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s));
        data[(y * N + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { width: N, height: N, data };
}

/** One "capture": shifted window, brightness/contrast change, gaussian-ish noise. */
export function capture(base: RgbU8, r: () => number): RgbU8 {
  const dx = Math.floor(r() * 16);
  const dy = Math.floor(r() * 16);
  const gain = 0.8 + r() * 0.4;
  const bias = (r() - 0.5) * 40;
  const noise = 4 + r() * 10;
  const data = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      for (let c = 0; c < 3; c++) {
        const src = base.data[((y + dy) * base.width + (x + dx)) * 3 + c];
        const n = (r() + r() + r() - 1.5) * noise;
        data[(y * SIZE + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(src * gain + bias + n)));
      }
    }
  }
  return { width: SIZE, height: SIZE, data };
}

function main() {
  const args = process.argv.slice(2);
  const outDir = args[0];
  const opt = (name: string, d: number) => {
    const i = args.indexOf(name);
    return i > 0 ? Number(args[i + 1]) : d;
  };
  if (!outDir) {
    console.error("usage: engine-compare-fixture.ts <out-dir> [--identities 6] [--per 4] [--denied 4] [--seed 1]");
    process.exit(2);
  }
  const IDENTITIES = opt("--identities", 6);
  const PER = opt("--per", 4);
  const DENIED = opt("--denied", 4);
  const SEED = opt("--seed", 1);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(outDir, "calib"), { recursive: true, mode: 0o700 });
  const r = rng(SEED);
  const entries: any[] = [];
  let n = 0;
  const write = (img: RgbU8, identity: string | null, status: "GRANTED" | "DENIED", gate: string) => {
    fs.writeFileSync(path.join(outDir, `rec_${n}.u8`), img.data, { mode: 0o600 });
    entries.push({ n, source: "log", groupId: `syn-${n}`, identity, labelQuality: identity ? "weak" : "none", status, gate, ts: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}Z`, boxSize: 80 + Math.round(r() * 60), score: 0.9, quality: Math.round((0.6 + r() * 0.4) * 1000) / 1000, sharpness: 100, picture: { width: 1920, height: 1080 }, facesInPicture: 1 });
    // Odd DENIED crops double as the "INT8 calibration set" so the exclusion path is exercised.
    if (status === "DENIED" && n % 2 === 1) fs.copyFileSync(path.join(outDir, `rec_${n}.u8`), path.join(outDir, "calib", `rec_${n}.u8`));
    n++;
  };
  for (let i = 0; i < IDENTITIES; i++) {
    const base = identityPattern(r);
    for (let k = 0; k < PER; k++) write(capture(base, r), `EMP-${String(i + 1).padStart(4, "0")}`, "GRANTED", k % 2 ? "EXIT" : "ENTRY");
  }
  for (let i = 0; i < DENIED; i++) write(capture(resizeBilinearU8(identityPattern(r), 128, 128), r), null, "DENIED", "ENTRY");
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ createdAt: new Date().toISOString(), synthetic: true, seed: SEED, minFacePx: 60, detectSize: 640, skipped: {}, entries }, null, 1), { mode: 0o600 });
  console.log(`synthetic crop set: ${entries.length} crops (${IDENTITIES} identities x ${PER} + ${DENIED} unlabelled) -> ${outDir}`);
}

if (process.argv[1] && /engine-compare-fixture\.ts$/.test(process.argv[1])) main();

/**
 * Camera routes must only ever dial the CONFIGURED stream, and must never
 * return FFmpeg output unredacted (it echoes rtsp://user:password@...).
 * Black-box versions live in the master test suite; this guards the source.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

function routeBody(path: string): string {
  const start = source.indexOf(`app.get("${path}"`);
  assert.ok(start >= 0, `${path} not found`);
  const next = source.indexOf("\napp.", start + 10);
  return source.slice(start, next > 0 ? next : undefined);
}

describe("camera route hardening", () => {
  for (const path of ["/api/camera-streams/snapshot", "/api/camera-streams/mjpeg"]) {
    it(`${path} refuses a caller-supplied ?url= and never dials it`, () => {
      const body = routeBody(path);
      assert.match(body, /if \(req\.query\.url !== undefined\)[\s\S]{0,80}status\(400\)/);
      assert.doesNotMatch(body.replace(/if \(req\.query\.url !== undefined\)/, ""), /req\.query\.url/);
    });
  }

  it("never returns an FFmpeg error log without redaction", () => {
    const leaks = [...source.matchAll(/\b(details?|detail)\s*:\s*([^,\n]*errorLog[^,\n]*)/g)]
      .map((m) => m[2])
      .filter((expr) => !/redactRtsp\(/.test(expr));
    assert.deepEqual(leaks, []);
  });
});

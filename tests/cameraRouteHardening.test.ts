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
  // The route ends at its own closing "});" at column 0 - NOT at the next
  // "app." line, which can be a thousand lines further down.
  const end = source.indexOf("\n});\n", start);
  assert.ok(end > start, `${path} has no closing brace`);
  return source.slice(start, end + 4);
}

describe("camera route hardening", () => {
  it("the MJPEG proxy is removed: it answers 410 and dials nothing", () => {
    const body = routeBody("/api/camera-streams/mjpeg");
    assert.match(body, /status\(410\)/);
    assert.doesNotMatch(body, /spawn|grabRtspFrame|rtspUrl/);
  });

  for (const path of ["/api/camera-streams/snapshot"]) {
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

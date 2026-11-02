/**
 * GET /api/logs/:id/image and GET /api/logs/:id/recording - the two routes
 * that turn an access event into pixels. Viewer role, cross-site refusal,
 * path-traversal ids, unknown ids, and error bodies that never carry an
 * NVR/RTSP address or login.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { apiAs, authenticateAs, noFaceJpegDataUrl, rawApi, recognize } from "./helpers";
import { rawRequest } from "./rawHttp";

/** Literal dot-segment paths, sent byte-for-byte. */
const DOT_PATHS = (suffix: string) => [`/api/logs/../${suffix}`, `/api/logs/%2e%2e/${suffix}`, `/api/logs/..%2f..%2f${suffix}`, `/api/logs/LOG-1/../LOG-2/${suffix}`];

const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "integration-viewer-token";
const LEAK = /rtsp:\/\/|rtsps:\/\/|https?:\/\/[^\s"]*@|Streaming\/tracks|ISAPI|RECORDING_NVR_URL=|admin:/i;
// Dot segments ("..", "%2e%2e") go through rawRequest below: fetch resolves
// them client-side and the gateway would never see a traversal.
const TRAVERSAL_IDS = ["..%2F..%2Fetc%2Fpasswd", "%2e%2e%2f", "%00", "LOG-1%2F..%2Fx", "LOG-1%00.jpg", "-dash-first", "LOG-" + "x".repeat(130), "LOG%20with%20space"];

let viewer = "";
let logId = "";

before(async () => {
  viewer = await authenticateAs(VIEWER_TOKEN);
  const made = await recognize({ imageBase64: noFaceJpegDataUrl(64, 99001), scanType: "EXIT" });
  assert.equal(made.status, 200, made.text.slice(0, 200));
  logId = (made.body as any).log.id;
  assert.ok(logId);
});

describe("GET /api/logs/:id/image", () => {
  it("anonymous 401; a viewer gets the picture with no-store, nosniff, a sandboxing CSP and a same-site CORP", async () => {
    assert.equal((await rawApi(`/api/logs/${logId}/image`)).status, 401);
    const res = await fetch(`${process.env.APP_URL || "http://127.0.0.1:3100"}/api/logs/${logId}/image`, { headers: { Cookie: viewer } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^image\/(jpeg|png|webp)$/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
    assert.match(res.headers.get("content-security-policy") || "", /sandbox/);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-site");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 0);
    assert.equal(bytes[0], 0xff, "JPEG SOI");
  });

  it("refuses cross-site embedding and foreign origins (403) before touching the image", async () => {
    const crossSite = await apiAs<any>(viewer, `/api/logs/${logId}/image`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.code, "IMAGE_CROSS_SITE_FORBIDDEN");
    const foreign = await apiAs<any>(viewer, `/api/logs/${logId}/image`, { headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const referer = await apiAs<any>(viewer, `/api/logs/${logId}/image`, { headers: { Referer: "https://evil.example/page" } });
    assert.equal(referer.status, 403);
  });

  it("path-traversal and malformed ids are 400, unknown ids 404, with no address in any body", async () => {
    for (const id of TRAVERSAL_IDS) {
      const res = await apiAs<any>(viewer, `/api/logs/${id}/image`);
      assert.equal(res.status, 400, `${id}: ${res.status} ${res.text.slice(0, 100)}`);
      assert.doesNotMatch(res.text, LEAK);
    }
    for (const path of DOT_PATHS("image")) {
      const res = await rawRequest("GET", path, { Cookie: viewer });
      assert.ok(res.status === 400 || res.status === 404, `${path}: ${res.status} ${res.text.slice(0, 100)}`);
      assert.doesNotMatch(res.text, LEAK);
      assert.doesNotMatch(res.headers["content-type"] || "", /^image\//, `${path} served an image`);
    }
    const unknown = await apiAs<any>(viewer, "/api/logs/LOG-never-existed-itest/image");
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(unknown.text, LEAK);
  });
});

describe("GET /api/logs/:id/recording", () => {
  it("anonymous 401; cross-site 403; traversal 400; unknown 404; a real event 503/409/5xx-free without an NVR - and never an address", async () => {
    assert.equal((await rawApi(`/api/logs/${logId}/recording`)).status, 401);
    const crossSite = await apiAs<any>(viewer, `/api/logs/${logId}/recording`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.code, "RECORDING_CROSS_SITE_FORBIDDEN");
    for (const id of TRAVERSAL_IDS) {
      const res = await apiAs<any>(viewer, `/api/logs/${id}/recording`);
      assert.equal(res.status, 400, `${id}: ${res.status}`);
      assert.doesNotMatch(res.text, LEAK);
    }
    for (const path of DOT_PATHS("recording")) {
      const res = await rawRequest("GET", path, { Cookie: viewer });
      assert.ok(res.status === 400 || res.status === 404, `${path}: ${res.status} ${res.text.slice(0, 100)}`);
      assert.doesNotMatch(res.text, LEAK);
      assert.notEqual(res.headers["content-type"], "video/mp4", `${path} streamed video`);
    }
    const unknown = await apiAs<any>(viewer, "/api/logs/LOG-never-existed-itest/recording");
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(unknown.text, LEAK);

    const real = await apiAs<any>(viewer, `/api/logs/${logId}/recording`);
    assert.ok([200, 404, 409, 422, 429, 502, 503, 504].includes(real.status), `unexpected ${real.status}: ${real.text.slice(0, 200)}`);
    if (real.status !== 200) {
      assert.doesNotMatch(real.text, LEAK, "the error body names no NVR address or login");
      assert.match(String(real.body?.code || ""), /^RECORDING_[A-Z_]+$/);
    }
    assert.equal(real.headers.get("cache-control"), "private, no-store");
    const cfg = await apiAs<any>(viewer, "/api/recordings/config");
    assert.equal(cfg.status, 200);
    assert.doesNotMatch(cfg.text, LEAK);
  });
});

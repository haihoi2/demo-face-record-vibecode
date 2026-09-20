/**
 * CORS allowlist behaviour.
 *
 * The gateway under test must be started with CORS_ALLOWED_ORIGINS set; this
 * suite needs to know one origin from that list, taken from
 * CORS_TEST_ALLOWED_ORIGIN (default http://allowed.test, which matches the
 * smoke-server command in README.md). The disallowed origin below is never
 * expected to be in anyone's allowlist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, BASE_URL } from "./helpers";

const ALLOWED_ORIGIN = (process.env.CORS_TEST_ALLOWED_ORIGIN || "http://allowed.test").replace(/\/+$/, "");
const DISALLOWED_ORIGIN = "http://definitely-not-allowed.invalid";

function preflight(origin: string, path = "/api/recognize-face") {
  return api(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

describe(`CORS preflight against ${BASE_URL}`, () => {
  it("a disallowed Origin gets 403 and no Access-Control-Allow-Origin header", async () => {
    const res = await preflight(DISALLOWED_ORIGIN);
    assert.equal(res.status, 403, `expected 403, got ${res.status} - is CORS_ALLOWED_ORIGINS set on the server?`);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  it("an allowed Origin gets 204 with the origin echoed back", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    assert.equal(res.status, 204, `expected 204 for ${ALLOWED_ORIGIN}, got ${res.status}`);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.match(res.headers.get("access-control-allow-methods") || "", /POST/);
    assert.equal(res.headers.get("access-control-allow-headers"), "content-type", "requested headers should be echoed");
    assert.equal(res.headers.get("vary"), "Origin");
  });

  it("the allowlist match is case-insensitive and ignores a trailing slash", async () => {
    const res = await preflight(ALLOWED_ORIGIN.toUpperCase() + "/");
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN.toUpperCase() + "/");
  });

  it("the wildcard origin is never emitted while an allowlist is configured", async () => {
    for (const origin of [ALLOWED_ORIGIN, DISALLOWED_ORIGIN]) {
      const res = await preflight(origin, "/api/health");
      assert.notEqual(res.headers.get("access-control-allow-origin"), "*", `wildcard leaked for ${origin}`);
    }
  });
});

describe("CORS on actual requests", () => {
  it("a same-origin/non-browser request (no Origin) still succeeds and gets no CORS header", async () => {
    const res = await api("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("a GET from a disallowed Origin is answered but without Access-Control-Allow-Origin", async () => {
    const res = await api("/api/health", { headers: { Origin: DISALLOWED_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("a GET from an allowed Origin carries the echoed Access-Control-Allow-Origin", async () => {
    const res = await api("/api/health", { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });

  it("a POST to /api/recognize-face from a disallowed Origin is still refused on its merits (400, no unlock)", async () => {
    const res = await api("/api/recognize-face", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DISALLOWED_ORIGIN },
      body: JSON.stringify({ employeeCode: "NV-5588" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

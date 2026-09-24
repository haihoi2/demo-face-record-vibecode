/**
 * Unit tests for the frontend API URL helpers (src/utils/api.ts).
 *
 * These run outside a browser, so `window` is undefined and no
 * VITE_API_BASE_URL is set - i.e. the same-origin path that local
 * development and the single-container deployment both rely on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeApiUrl,
  buildEventSourceUrl,
  getApiBaseUrl,
  getCustomBackendUrl,
  STORAGE_KEY_CUSTOM_BACKEND,
  clearSessionCsrfToken,
  operatorJsonFetch,
} from "../src/utils/api";

describe("getCustomBackendUrl", () => {
  it("returns an empty string when there is no browser storage", () => {
    assert.equal(getCustomBackendUrl(), "");
  });

  it("exposes a stable localStorage key", () => {
    assert.equal(STORAGE_KEY_CUSTOM_BACKEND, "smartlock_custom_backend_url");
  });
});

describe("getApiBaseUrl", () => {
  it("falls back to same-origin (empty base) with no custom URL and no env override", () => {
    assert.equal(getApiBaseUrl(), "");
  });
});

describe("normalizeApiUrl", () => {
  it("defaults to the health endpoint for an empty input", () => {
    assert.equal(normalizeApiUrl(""), "/api/health");
  });

  it("passes absolute http(s) URLs through untouched", () => {
    assert.equal(normalizeApiUrl("http://gate-watch.vota.local:3000/api/health"), "http://gate-watch.vota.local:3000/api/health");
    assert.equal(normalizeApiUrl("https://example.test/api/employees"), "https://example.test/api/employees");
  });

  it("adds the leading slash to a bare api/ path", () => {
    assert.equal(normalizeApiUrl("api/employees"), "/api/employees");
  });

  it("adds the leading slash to any other relative path", () => {
    assert.equal(normalizeApiUrl("employees"), "/employees");
  });

  it("leaves an already-rooted path unchanged", () => {
    assert.equal(normalizeApiUrl("/api/lock/status"), "/api/lock/status");
  });

  it("trims surrounding whitespace before normalizing", () => {
    assert.equal(normalizeApiUrl("  api/notifications  "), "/api/notifications");
  });

  it("is idempotent", () => {
    const once = normalizeApiUrl("api/events");
    assert.equal(normalizeApiUrl(once), once);
  });
});

describe("buildEventSourceUrl", () => {
  it("normalizes the SSE endpoint the same way as a regular API call", () => {
    assert.equal(buildEventSourceUrl("api/events"), "/api/events");
    assert.equal(buildEventSourceUrl("/api/events"), normalizeApiUrl("/api/events"));
  });
});

describe("operatorJsonFetch CSRF recovery", () => {
  it("refreshes the authenticated session and retries a CSRF-specific 403 exactly once", async () => {
    clearSessionCsrfToken();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; csrf: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const csrf = new Headers(init?.headers).get("x-csrf-token");
      calls.push({ url, csrf });
      if (url === "/api/operator/session") {
        return new Response(JSON.stringify({ success: true, csrfToken: "fresh-csrf" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (calls.filter((call) => call.url === "/api/lock/lock").length === 1) {
        return new Response(JSON.stringify({ success: false, code: "CSRF_REQUIRED" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await operatorJsonFetch("/api/lock/lock", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(result.status, 200);
      assert.deepEqual(calls.map((call) => call.url), [
        "/api/lock/lock", "/api/operator/session", "/api/lock/lock",
      ]);
      assert.equal(calls[2].csrf, "fresh-csrf");
    } finally {
      globalThis.fetch = originalFetch;
      clearSessionCsrfToken();
    }
  });

  it("does not retry an arbitrary 403", async () => {
    clearSessionCsrfToken();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ success: false, code: "ROLE_REQUIRED" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await operatorJsonFetch("/api/lock/lock", { method: "POST" });
      assert.equal(result.status, 403);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

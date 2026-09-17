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

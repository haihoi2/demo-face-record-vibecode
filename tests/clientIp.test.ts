/**
 * Client address resolution behind the edge proxies (src/server/clientIp.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clientIpOf, normalizeIp, parseTrustedProxies } from "../src/server/clientIp";

const TRUSTED = parseTrustedProxies("192.168.6.19, 10.0.19.37, not-an-ip");

describe("clientIpOf", () => {
  it("believes X-Real-IP only from a trusted proxy", () => {
    assert.equal(clientIpOf("::ffff:192.168.6.19", { "x-real-ip": "203.0.113.7" }, TRUSTED), "203.0.113.7");
    assert.equal(clientIpOf("10.0.19.37", { "x-real-ip": "2001:db8::1" }, TRUSTED), "2001:db8::1");
    assert.equal(clientIpOf("::ffff:192.168.6.77", { "x-real-ip": "203.0.113.7" }, TRUSTED), "192.168.6.77", "a LAN host cannot forge it");
  });

  it("never reads CF-Connecting-IP and ignores junk or missing headers", () => {
    assert.equal(clientIpOf("192.168.6.19", { "cf-connecting-ip": "198.51.100.1" }, TRUSTED), "192.168.6.19");
    assert.equal(clientIpOf("192.168.6.19", { "x-real-ip": "evil, 1.2.3.4" }, TRUSTED), "192.168.6.19");
    assert.equal(clientIpOf("192.168.6.19", { "x-real-ip": ["198.51.100.9", "1.1.1.1"] }, TRUSTED), "198.51.100.9");
    assert.equal(clientIpOf(undefined, {}, TRUSTED), "unknown");
  });

  it("parses the trusted list and normalises mapped IPv4", () => {
    assert.deepEqual([...TRUSTED], ["192.168.6.19", "10.0.19.37"]);
    assert.equal(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
    assert.equal(normalizeIp("::1"), "::1");
  });
});

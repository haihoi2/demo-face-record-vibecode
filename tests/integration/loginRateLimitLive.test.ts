/**
 * The sign-in rate limit on the live HTTP route (the unit test covers the
 * limiter class only). Needs a gateway started with a SMALL limit, e.g.
 *
 *   LOGIN_RATE_LIMIT_PER_MINUTE=3 LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE=8
 *
 * and the same numbers in ITEST_LOGIN_RATE_LIMIT_PER_MINUTE /
 * ITEST_LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE for the runner; without them this
 * file skips (the regular integration gateway runs with the limit at 100000
 * so the rest of the suite can sign in freely).
 *
 * Checks: the Nth+1 attempt from one address is 429 with Retry-After and a
 * RATE_LIMITED code; a correct token is refused too while limited (fail
 * closed); forged X-Real-IP / X-Forwarded-For / CF-Connecting-IP headers from
 * an untrusted peer do not open a fresh bucket.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rawApi } from "./helpers";

const PER_IP = Number(process.env.ITEST_LOGIN_RATE_LIMIT_PER_MINUTE || 0);
const skip = PER_IP > 0 && PER_IP <= 20 ? false : "ITEST_LOGIN_RATE_LIMIT_PER_MINUTE not set to a small value (dedicated rate-limit gateway only)";

const attempt = (body: unknown, headers: Record<string, string> = {}) =>
  rawApi<any>("/api/operator/session", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("sign-in rate limit on the live route", { skip }, () => {
  it("refuses the attempt after the per-address limit with 429, Retry-After and RATE_LIMITED; a correct token is refused too", async () => {
    for (let i = 0; i < PER_IP; i++) {
      const res = await attempt({ token: `wrong-${i}` });
      assert.equal(res.status, 401, `attempt ${i + 1}: ${res.status} ${res.text.slice(0, 100)}`);
    }
    const limited = await attempt({ token: "wrong-again" });
    assert.equal(limited.status, 429, limited.text.slice(0, 200));
    assert.equal(limited.body.code, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1, "Retry-After is set");
    assert.ok(limited.body.retryAfterSeconds >= 1);
    assert.doesNotMatch(limited.text, /wrong-again/, "the attempted secret is not echoed");

    const good = await attempt({ token: process.env.OPERATOR_TOKEN || "integration-operator-token" });
    assert.equal(good.status, 429, "fail closed: the right token does not bypass the limit");
    assert.equal(good.headers.get("set-cookie"), null, "no session is issued while limited");

    const account = await attempt({ username: "nobody", password: "x".repeat(12) });
    assert.equal(account.status, 429, "account sign-in shares the same bucket");
  });

  it("forged client-address headers from an untrusted peer do not reset the bucket", async () => {
    for (const headers of [
      { "X-Real-IP": "203.0.113.9" },
      { "X-Forwarded-For": "203.0.113.10, 198.51.100.1" },
      { "CF-Connecting-IP": "203.0.113.11" },
      { "X-Real-IP": "203.0.113.12", "X-Forwarded-For": "203.0.113.13", "True-Client-IP": "203.0.113.14", Forwarded: "for=203.0.113.15" },
    ]) {
      const res = await attempt({ token: "wrong-spoof" }, headers);
      assert.equal(res.status, 429, `${JSON.stringify(headers)}: ${res.status}`);
    }
  });
});

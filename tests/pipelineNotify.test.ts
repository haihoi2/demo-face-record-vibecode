/**
 * Chat messages from the real-time pipeline (#523 step 3): gate list, dedupe window,
 * and the server wiring that keeps it a message only.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_NOTIFY_DEDUPE_SECONDS, GateNoticeDedupe, notifyDedupeSeconds, parseNotifyGates } from "../src/server/pipelineNotify";

describe("parseNotifyGates", () => {
  it("blank or missing means no gate", () => {
    for (const raw of [undefined, null, "", "  ", ","]) {
      const r = parseNotifyGates(raw);
      assert.equal(r.gates.size, 0);
      assert.deepEqual(r.ignored, []);
    }
  });

  it("reads comma or space separated gate ids, lower-cased, without duplicates", () => {
    assert.deepEqual([...parseNotifyGates("exit").gates], ["exit"]);
    assert.deepEqual([...parseNotifyGates(" EXIT , entry exit ").gates].sort(), ["entry", "exit"]);
    assert.deepEqual([...parseNotifyGates("side-door").gates], ["side-door"]);
  });

  it("ignores and reports values that are not gate ids", () => {
    const r = parseNotifyGates("exit, ../etc, a;b, *");
    assert.deepEqual([...r.gates], ["exit"]);
    assert.deepEqual(r.ignored, ["../etc", "a;b", "*"]);
  });
});

describe("notifyDedupeSeconds", () => {
  it("defaults to 60 and accepts whole seconds 1..3600 only", () => {
    assert.equal(DEFAULT_NOTIFY_DEDUPE_SECONDS, 60);
    assert.equal(notifyDedupeSeconds(undefined), 60);
    assert.equal(notifyDedupeSeconds(""), 60);
    assert.equal(notifyDedupeSeconds("30"), 30);
    assert.equal(notifyDedupeSeconds("3600"), 3600);
    for (const bad of ["0", "-5", "3601", "1.5", "abc", "1e3"]) assert.equal(notifyDedupeSeconds(bad), 60, bad);
  });
});

describe("GateNoticeDedupe", () => {
  it("one message per gate and employee inside the window, whichever path claims first", () => {
    const d = new GateNoticeDedupe(60_000);
    assert.deepEqual(d.claim("exit", "E1", "pipeline", 1_000), { send: true });
    // The door scan sees the same passage 5 s later: skipped, and says who sent.
    assert.deepEqual(d.claim("exit", "E1", "door-scan", 6_000), { send: false, duplicateOf: { source: "pipeline", agoMs: 5_000 } });
    // A second pipeline decision for the same passage is skipped too.
    assert.equal(d.claim("exit", "E1", "pipeline", 9_000).send, false);
    // Door scan first, pipeline later: same rule.
    assert.equal(d.claim("exit", "E2", "door-scan", 10_000).send, true);
    assert.deepEqual(d.claim("exit", "E2", "pipeline", 12_000), { send: false, duplicateOf: { source: "door-scan", agoMs: 2_000 } });
  });

  it("skipped claims do not extend the window; a new passage after it sends again", () => {
    const d = new GateNoticeDedupe(60_000);
    assert.equal(d.claim("exit", "E1", "pipeline", 0).send, true);
    assert.equal(d.claim("exit", "E1", "pipeline", 59_999).send, false);
    assert.equal(d.claim("exit", "E1", "pipeline", 60_000).send, true);
  });

  it("other employees and other gates are independent", () => {
    const d = new GateNoticeDedupe(60_000);
    assert.equal(d.claim("exit", "E1", "pipeline", 0).send, true);
    assert.equal(d.claim("exit", "E2", "pipeline", 1).send, true);
    assert.equal(d.claim("entry", "E1", "door-scan", 2).send, true);
  });

  it("a clock that goes backwards never suppresses", () => {
    const d = new GateNoticeDedupe(60_000);
    assert.equal(d.claim("exit", "E1", "pipeline", 100_000).send, true);
    assert.equal(d.claim("exit", "E1", "pipeline", 50_000).send, true);
  });

  it("memory stays bounded: old entries are pruned", () => {
    const d = new GateNoticeDedupe(1_000);
    for (let i = 0; i < 2500; i++) d.claim("exit", `E${i}`, "pipeline", i * 10);
    assert.ok(d.size <= 2001, `size ${d.size}`);
  });
});

describe("server wiring", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const fnBody = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const next = src.indexOf("\nfunction ", start + 10);
    const nextAsync = src.indexOf("\nasync function ", start + 10);
    const end = Math.min(...[next, nextAsync].filter((i) => i > 0));
    return src.slice(start, end);
  };

  it("the pipeline message is a chat message only: no unlock, no access log, no stored image", () => {
    const body = fnBody("notifyFromPipeline");
    assert.match(body, /gateNotices\.claim\(gate, emp\.id, "pipeline", Date\.now\(\)\)/);
    assert.match(body, /sendEtonWebhook\(/);
    for (const forbidden of [/unlockDoor/, /saveAccessLog/, /accessLogs\.unshift/, /photoSnapshot/, /broadcastSSE\("access_granted"/, /saveStrangerFace/]) {
      assert.doesNotMatch(body, forbidden);
    }
  });

  it("only employee outcomes on a gate in PIPELINE_NOTIFY_GATES whose pipeline runs send", () => {
    assert.match(src, /const PIPELINE_NOTIFY = parseNotifyGates\(process\.env\.PIPELINE_NOTIFY_GATES\);/);
    assert.match(fnBody("pipelineNotifyActive"), /PIPELINE_NOTIFY\.gates\.has\(gate\) && Boolean\(gatePipelines\.get\(gate\)\?\.pipeline\)/);
    assert.match(fnBody("reportPipelineResult"), /r\.outcome\.kind === "employee" && pipelineNotifyActive\(gate\)\s*\?\s*notifyFromPipeline\(gate, r\.outcome\.employeeId\)/);
  });

  it("the door scan claims the same slot on a notify gate and sends unchanged elsewhere", () => {
    assert.match(
      src,
      /const notice = pipelineNotifyActive\(gateKey\) \? gateNotices\.claim\(gateKey, emp\.id, "door-scan", Date\.now\(\)\) : \{ send: true \};\s*if \(notice\.send\) \{\s*sendEtonWebhook\(\{/
    );
    // The access-log row, the SSE event and the unlock are written before and regardless of the claim.
    const grant = src.slice(src.indexOf("// 2. One GRANTED row per employee"), src.indexOf("const notice = pipelineNotifyActive(gateKey)"));
    assert.match(grant, /accessLogs\.unshift\(accessLog\);/);
    assert.match(grant, /broadcastSSE\("access_granted"/);
  });

  // docker-compose.yml is not in the image build context (.dockerignore): checked on a host checkout only.
  const composeUrl = new URL("../docker-compose.yml", import.meta.url);
  it("compose passes both settings through", { skip: !existsSync(composeUrl) && "docker-compose.yml not in the build context" }, () => {
    const compose = readFileSync(composeUrl, "utf8");
    assert.match(compose, /- PIPELINE_NOTIFY_GATES=\$\{PIPELINE_NOTIFY_GATES:-\}/);
    assert.match(compose, /- PIPELINE_NOTIFY_DEDUPE_SECONDS=\$\{PIPELINE_NOTIFY_DEDUPE_SECONDS:-\}/);
  });

  it(".env.example documents both settings, off by default", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    assert.match(example, /^PIPELINE_NOTIFY_GATES=""$/m);
    assert.match(example, /^PIPELINE_NOTIFY_DEDUPE_SECONDS=""$/m);
  });
});

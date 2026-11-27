/**
 * Chat messages from the real-time pipeline (#523 step 3): gate list, dedupe window,
 * and the server wiring that keeps it a message only.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_NOTIFY_DEDUPE_SECONDS,
  GateNoticeDedupe,
  notifyDedupeSeconds,
  parseNotifyGates,
  pipelineConfidencePct,
  recentGrantRowId,
} from "../src/server/pipelineNotify";
import { storableAccessLogSource } from "../src/server/db";

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

describe("recentGrantRowId", () => {
  const T0 = Date.parse("2026-11-27T03:00:00.000Z");
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  type L = { id: string; timestamp: string; status: string; employeeId?: string; gateId?: string; type?: string };
  const gateOf = (l: L) => l.gateId || (l.type === "EXIT" ? "exit" : "entry");
  // Newest first, like the server's in-memory log.
  const logs: L[] = [
    { id: "L5", timestamp: at(50), status: "DENIED", gateId: "exit" },
    { id: "L4", timestamp: at(40), status: "GRANTED", employeeId: "E2", gateId: "exit" },
    { id: "L3", timestamp: at(30), status: "GRANTED", employeeId: "E1", gateId: "entry" },
    { id: "L2", timestamp: at(20), status: "GRANTED", employeeId: "E1", type: "EXIT" },
    { id: "L1", timestamp: at(-100), status: "GRANTED", employeeId: "E3", gateId: "exit" },
  ];

  it("finds a grant of the same person at the same gate in the window, legacy rows included", () => {
    assert.equal(recentGrantRowId(logs, "exit", "E1", T0, gateOf), "L2");
    assert.equal(recentGrantRowId(logs, "entry", "E1", T0, gateOf), "L3");
  });
  it("ignores other people, other gates, denials and rows before the window", () => {
    assert.equal(recentGrantRowId(logs, "exit", "E1", T0 + 25_000, gateOf), null);
    assert.equal(recentGrantRowId(logs, "exit", "E9", T0, gateOf), null);
    assert.equal(recentGrantRowId(logs, "exit", "E3", T0, gateOf), null, "older than the window");
    assert.equal(recentGrantRowId(logs, "exit", "E3", T0 - 200_000, gateOf), "L1");
  });
  it("compares passage times: a pipeline row written after the window opened but seen before it does not count", () => {
    // Previous passage seen at -5 s, its row written at +10 s; the new decision's window starts at 0.
    const rows = [{ id: "P1", timestamp: at(10), capturedAt: at(-5), status: "GRANTED", employeeId: "E1", gateId: "exit" }];
    assert.equal(recentGrantRowId(rows, "exit", "E1", T0, gateOf), null);
    assert.equal(recentGrantRowId(rows, "exit", "E1", T0 - 10_000, gateOf), "P1");
  });
  it("stops after the scan limit", () => {
    assert.equal(recentGrantRowId(logs, "exit", "E1", T0, gateOf, 3), null);
  });
});

describe("pipelineConfidencePct", () => {
  it("uses the door scan's scale and clamps", () => {
    assert.equal(pipelineConfidencePct(0.35), 0);
    assert.equal(pipelineConfidencePct(0.6), 38);
    assert.equal(pipelineConfidencePct(1), 100);
    assert.equal(pipelineConfidencePct(0.1), 0);
    assert.equal(pipelineConfidencePct(2), 100);
    for (const bad of [undefined, null, "x", NaN]) assert.equal(pipelineConfidencePct(bad), 0);
  });
});

describe("storableAccessLogSource", () => {
  it("stores only the one known value; anything else is a door-scan row (NULL)", () => {
    assert.equal(storableAccessLogSource("pipeline"), "pipeline");
    for (const v of [undefined, null, "", "Pipeline", "browser", "door-scan", 1, {}]) assert.equal(storableAccessLogSource(v), null);
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
    assert.match(fnBody("pipelineNotifyActive"), /pipelineNotifyFor\(gate\)\.on && Boolean\(gatePipelines\.get\(gate\)\?\.pipeline\)/);
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

  it("an attendance row is written only after the pipeline itself sent the message", () => {
    assert.match(
      fnBody("reportPipelineResult"),
      /persistShadowResult\(gate, r\)\s*\.then\(\(legacy\) => \(notify === "sent" \? recordPipelinePassage\(gate, r, legacy\) : undefined\)\)/
    );
  });

  it("the attendance row: employee only, skipped when a grant row exists, never an unlock or an image", () => {
    const body = fnBody("recordPipelinePassage");
    assert.match(body, /if \(r\.outcome\.kind !== "employee"\) return;/);
    assert.match(body, /legacy\.status === "GRANTED" && legacy\.employeeId === employeeId/);
    assert.match(body, /recentGrantRowId\(accessLogs, gate, employeeId, sh\.decidedAtMs - PIPELINE_NOTIFY_DEDUPE_MS, gateIdForLegacyRow\)/);
    assert.ok(body.indexOf("if (existing)") < body.indexOf("db.saveAccessLog(log)"), "the duplicate check comes before the write");
    assert.match(body, /source: "pipeline",/);
    assert.match(body, /photoSnapshot: "",/);
    assert.match(body, /status: "GRANTED",/);
    for (const forbidden of [/unlockDoor/, /lastGrantAtByGateEmployee/, /sendEtonWebhook/, /saveStrangerFace/, /frameImage/, /annotateSnapshot/]) {
      assert.doesNotMatch(body, forbidden);
    }
  });

  it("the JSON response filter keeps the source and the real hasImage of a history row", () => {
    const body = fnBody("sanitizePublicJson");
    assert.match(body, /hasImage: typeof value\.hasImage === "boolean" \? value\.hasImage : Boolean\(value\.photoSnapshot\)/);
    assert.match(body, /\.\.\.\(value\.source === "pipeline" \? \{ source: "pipeline" \} : \{\}\)/);
  });

  it("the shadow pairing never mistakes the pipeline's own row for a door-scan event", () => {
    assert.match(fnBody("nearestLegacyEvent"), /if \(log\.source === "pipeline"\) continue;/);
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

/** Dashboard "Thống Kê Kiểm Soát Hôm Nay", direction badge, quick blur, and the recording clip centre (2026-10-11). */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isEntryEvent, logBlurReportRequest, readTodayStats, todayStartIso, todayStatsUrls } from "../src/utils/dashboardStats";

describe("today's stats", () => {
  it("today starts at 00:00 site time (UTC+07:00)", () => {
    assert.equal(todayStartIso(new Date("2026-10-11T02:37:16Z")), "2026-10-10T17:00:00.000Z");
    assert.equal(todayStartIso(new Date("2026-10-10T17:30:00Z")), "2026-10-10T17:00:00.000Z", "00:30 local is still the 11th");
    assert.equal(todayStartIso(new Date("2026-10-10T16:59:00Z")), "2026-10-09T17:00:00.000Z", "23:59 local is the 10th");
  });
  it("asks the server, granted and denied separately", () => {
    const u = todayStatsUrls(new Date("2026-10-11T02:00:00Z"));
    assert.match(u.granted, /^\/api\/logs\/stats\?from=2026-10-10T17%3A00%3A00\.000Z&status=GRANTED$/);
    assert.match(u.denied, /status=DENIED$/);
    assert.deepEqual(readTodayStats({ entries: 12, exits: 9, total: 21 }, { total: 31 }), { entries: 12, exits: 9, denied: 31 });
    assert.equal(readTodayStats({ entries: 1 }, { total: 2 }), null);
  });
  it("direction comes from `type`", () => {
    assert.equal(isEntryEvent({ type: "ENTRY" }), true);
    assert.equal(isEntryEvent({ type: "EXIT" }), false);
  });
  it("quick blur report request", () => {
    assert.deepEqual(logBlurReportRequest("LOG-1", true).init.method, "POST");
    assert.deepEqual(logBlurReportRequest("LOG-1", false).init.method, "DELETE");
    assert.equal(logBlurReportRequest("LOG 1", true).url, "/api/logs/LOG%201/blur-report");
  });
});

describe("wiring", () => {
  const ui = readFileSync(new URL("../src/components/CameraDashboard.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  it("the card no longer counts scanType or the loaded events", () => {
    assert.doesNotMatch(ui, /l\.scanType === "ENTRY"|log\.scanType === "ENTRY"/);
    assert.match(ui, /\{todayStats \? todayStats\.entries : "–"\}/);
  });
  it("the app reloads its data after a sign-in", () => {
    assert.match(app, /if \(signedInActor\) void fetchData\(\);/);
  });
  it("the event keeps the picture's capture time and the clip is centred on it", () => {
    assert.match(src, /capturedAt: new Date\(snapshotCapturedAtMs\)\.toISOString\(\)/);
    assert.match(src, /recordingWindow\(capturedMs, Date\.now\(\)\)/);
    assert.match(src, /beforeMs: 15_000/);
  });
  it("quick blur routes are operator-only and CSRF-protected", () => {
    assert.match(src, /app\.post\("\/api\/logs\/:id\/blur-report", requireOperatorRole\("operator"\), requireCsrf,/);
    assert.match(src, /app\.delete\("\/api\/logs\/:id\/blur-report", requireOperatorRole\("operator"\), requireCsrf,/);
  });
});

/**
 * "Nhật ký vào ra" over the whole history: keyset paging, server-side filters,
 * totals and the hourly chart computed for the same filters, and CSV export.
 * Every entry here is created after `since`, so the assertions are exact even
 * on a gateway that already holds other tests' history.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, authenticateAs, noFaceJpegDataUrl, rawApi, recognize } from "./helpers";

let since = "";
const created: Array<{ id: string; type: "ENTRY" | "EXIT" }> = [];

async function deniedLog(seed: number, scanType: "ENTRY" | "EXIT") {
  const res = await recognize({ imageBase64: noFaceJpegDataUrl(64, seed), scanType });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const log = (res.body as any).log;
  assert.ok(log?.id);
  created.push({ id: log.id, type: scanType });
}

const q = (params: Record<string, string>) => new URLSearchParams({ from: since, ...params }).toString();

describe("access history", () => {
  before(async () => {
    since = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 5; i++) await deniedLog(72000 + i, "ENTRY");
    for (let i = 0; i < 3; i++) await deniedLog(72100 + i, "EXIT");
  });

  it("walks every matching entry exactly once with a cursor, newest first", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let total = -1;
    for (let guard = 0; guard < 10; guard++) {
      const res = await api<any>(`/api/logs?${q({ paging: "cursor", limit: "3", ...(cursor ? { cursor } : {}) })}`);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.equal(res.body.version, 2);
      total = res.body.total;
      seen.push(...res.body.logs.map((l: any) => l.id));
      assert.ok(res.body.logs.length <= 3);
      const times = res.body.logs.map((l: any) => l.timestamp);
      assert.deepEqual(times, [...times].sort().reverse(), "each page is newest first");
      if (!res.body.hasMore) break;
      cursor = res.body.nextCursor;
    }
    assert.equal(total, created.length);
    assert.equal(new Set(seen).size, seen.length, "no entry repeats across pages");
    assert.deepEqual([...seen].sort(), created.map((c) => c.id).sort());
  });

  it("filters by direction and status on the server", async () => {
    const exits = await api<any>(`/api/logs?${q({ type: "EXIT", limit: "50" })}`);
    assert.equal(exits.body.total, 3);
    assert.ok(exits.body.logs.every((l: any) => l.type === "EXIT"));
    const granted = await api<any>(`/api/logs?${q({ status: "GRANTED" })}`);
    assert.equal(granted.body.total, 0);
    const none = await api<any>(`/api/logs?${q({ q: "zz-no-such-person-zz" })}`);
    assert.equal(none.body.total, 0);
  });

  it("never returns image bytes or face data in a page", async () => {
    const res = await api<any>(`/api/logs?${q({ limit: "50" })}`);
    assert.doesNotMatch(res.text, /data:image\/|faceEmbedding/);
    assert.ok(res.body.logs.every((l: any) => /^\/api\/logs\/.+\/image$/.test(l.photoSnapshot)));
  });

  it("computes totals and hour-of-day buckets for the same filters", async () => {
    const res = await api<any>(`/api/logs/stats?${q({})}`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.body.total, 8);
    assert.equal(res.body.denied, 8);
    assert.equal(res.body.entries, 5);
    assert.equal(res.body.exits, 3);
    assert.equal(res.body.byHour.length, 24);
    assert.equal(res.body.byHour.reduce((n: number, b: any) => n + b.totalScans, 0), 8);
    const siteHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: res.body.timeZone }).format(new Date()));
    const bucket = res.body.byHour[siteHour];
    assert.ok(bucket.totalScans >= 1, `this run's entries land in the site-time hour ${siteHour}`);
    const exitsOnly = await api<any>(`/api/logs/stats?${q({ type: "EXIT" })}`);
    assert.equal(exitsOnly.body.total, 3);
  });

  it("exports every matching entry as a spreadsheet-safe CSV", async () => {
    const res = await api(`/api/logs/export.csv?${q({})}`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.match(res.headers.get("content-type") || "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") || "", /attachment; filename="nhat_ky_vao_ra_tu_\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.replace(/^﻿/, "").trim().split("\n");
    assert.equal(lines.length, 1 + created.length, "header plus one line per entry");
    assert.match(lines[0], /^"ID","Thời gian"/);
    for (const c of created) assert.ok(lines.some((l) => l.startsWith(`"${c.id}"`)), c.id);
    assert.doesNotMatch(res.text, /data:image\/|faceEmbedding/);
  });

  it("rejects malformed filters and cursors", async () => {
    for (const bad of ["status=MAYBE", "type=SIDEWAYS", "from=not-a-date", `from=${encodeURIComponent(since)}&to=${encodeURIComponent(since)}`, "cursor=%%%"]) {
      const res = await api(`/api/logs?${bad}`);
      assert.equal(res.status, 400, bad);
    }
    assert.equal((await api("/api/logs/stats?status=MAYBE")).status, 400);
    assert.equal((await api("/api/logs/export.csv?type=SIDEWAYS")).status, 400);
  });

  it("is readable by a viewer and closed to anyone signed out", async () => {
    const viewer = await authenticateAs(process.env.VIEWER_TOKEN || "integration-viewer-token");
    for (const path of ["/api/logs?paging=cursor", "/api/logs/stats", "/api/logs/export.csv"]) {
      assert.equal((await rawApi(path, { headers: { Cookie: viewer } })).status, 200, path);
      assert.equal((await rawApi(path)).status, 401, path);
    }
  });

  it("keeps the page-number mode for callers that only want the newest rows", async () => {
    const res = await api<any>("/api/logs?limit=5");
    assert.equal(res.body.version, 1);
    assert.ok(res.body.logs.length <= 5);
  });
});

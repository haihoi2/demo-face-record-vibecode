/**
 * Blur reports in the stranger panel (owner 2026-10-02): a LABEL on a per-face
 * photo for re-tuning the blur filter. Never deletes or hides the photo; the
 * badge follows the server, changing only after a 2xx.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { StrangerCluster, StrangerPhoto } from "../src/types";
import {
  BLUR_NOTE_MAX,
  BLUR_REPORT_HINT,
  applyBlurState,
  blurReportPath,
  blurReportRequest,
  blurReportSuccessText,
  canBlurReport,
  isBlurReported,
  normalizeBlurNote,
  readBlurReportResult,
} from "../src/utils/blurReports";

const photo = (extra: Partial<StrangerPhoto> & { logId: string } & { blurReported?: unknown }): StrangerPhoto =>
  ({
    photoSnapshot: `/api/logs/${extra.logId}/image`,
    timestamp: "2026-10-02T01:00:00.000Z",
    doorName: "Cổng vào - Camera 1",
    confidence: 0,
    ...extra,
  }) as StrangerPhoto;

const faceA = photo({ logId: "LOG-1", faceId: "SF-a", observationId: "face:SF-a" });
const faceB = photo({ logId: "LOG-1", faceId: "SF-b", observationId: "face:SF-b", blurReported: true });
const legacy = photo({ logId: "LOG-0", blurReported: true });

const cluster = (id: string, photos: StrangerPhoto[]): StrangerCluster => ({
  clusterId: id,
  label: id,
  photos,
  firstSeen: "2026-10-02T01:00:00.000Z",
  lastSeen: "2026-10-02T01:00:00.000Z",
  totalSightings: photos.length,
  primaryPhoto: photos[0]?.photoSnapshot || "",
  similarityScore: null,
});

describe("blur report eligibility and badge state", () => {
  it("only per-face photos can be reported", () => {
    assert.equal(canBlurReport(faceA), true);
    assert.equal(canBlurReport(legacy), false);
    assert.equal(canBlurReport(photo({ logId: "LOG-2", faceId: "" })), false);
    assert.equal(canBlurReport(undefined), false);
    assert.equal(canBlurReport(null), false);
  });

  it("the badge shows only for a literal blurReported: true on a per-face photo", () => {
    assert.equal(isBlurReported(faceB), true);
    assert.equal(isBlurReported(faceA), false);
    assert.equal(isBlurReported(photo({ logId: "L", faceId: "SF-c", blurReported: "true" as unknown as boolean })), false);
    assert.equal(isBlurReported(photo({ logId: "L", faceId: "SF-c", blurReported: 1 as unknown as boolean })), false);
    // A whole-frame photo never shows the badge, whatever the payload says.
    assert.equal(isBlurReported(legacy), false);
    assert.equal(isBlurReported(undefined), false);
  });
});

describe("blur report request builder", () => {
  it("encodes the face id in the path", () => {
    assert.equal(blurReportPath("SF-a"), "/api/strangers/faces/SF-a/blur-report");
    assert.equal(blurReportPath("a/../b?x"), "/api/strangers/faces/a%2F..%2Fb%3Fx/blur-report");
  });

  it("reports with POST and an empty JSON body", () => {
    const { url, init } = blurReportRequest("SF-a", true);
    assert.equal(url, "/api/strangers/faces/SF-a/blur-report");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), {});
    assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
  });

  it("includes a trimmed note of at most 200 characters", () => {
    const { init } = blurReportRequest("SF-a", true, "  nhòe do chuyển động  ");
    assert.deepEqual(JSON.parse(String(init.body)), { note: "nhòe do chuyển động" });
    const long = blurReportRequest("SF-a", true, "x".repeat(500));
    assert.equal(JSON.parse(String(long.init.body)).note.length, BLUR_NOTE_MAX);
    assert.deepEqual(JSON.parse(String(blurReportRequest("SF-a", true, "   ").init.body)), {});
  });

  it("withdraws with DELETE and no note", () => {
    const { url, init } = blurReportRequest("SF-a", false, "ignored");
    assert.equal(url, "/api/strangers/faces/SF-a/blur-report");
    assert.equal(init.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init.body)), {});
  });

  it("normalizes notes", () => {
    assert.equal(normalizeBlurNote(undefined), undefined);
    assert.equal(normalizeBlurNote(null), undefined);
    assert.equal(normalizeBlurNote(""), undefined);
    assert.equal(normalizeBlurNote(" a "), "a");
  });
});

describe("blur report response handling", () => {
  it("accepts a 2xx with success and a boolean blurReported", () => {
    assert.deepEqual(
      readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: true, faceId: "SF-a", blurReported: true, report: {} } }),
      { ok: true, faceId: "SF-a", blurReported: true },
    );
    assert.deepEqual(
      readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: true, faceId: "SF-a", blurReported: false } }),
      { ok: true, faceId: "SF-a", blurReported: false },
    );
  });

  it("shows the server's error text as-is for 404, 400 and 403", () => {
    for (const [status, error] of [
      [404, "Không tìm thấy khuôn mặt SF-x"],
      [400, "faceId không hợp lệ"],
      [403, "Cần quyền vận hành"],
    ] as const) {
      const out = readBlurReportResult("SF-x", { ok: false, status, data: { success: false, error } });
      assert.deepEqual(out, { ok: false, status, error });
    }
  });

  it("never turns a refusal or transport failure into success", () => {
    const transport = readBlurReportResult("SF-a", { ok: false, status: 0, data: undefined, error: "Failed to fetch" });
    assert.deepEqual(transport, { ok: false, status: 0, error: "Failed to fetch" });
    const noText = readBlurReportResult("SF-a", { ok: false, status: 500, data: undefined });
    assert.deepEqual(noText, { ok: false, status: 500, error: "HTTP 500" });
    // A 2xx without success / without a boolean state is not a confirmation.
    assert.equal(readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: false } }).ok, false);
    assert.equal(readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: true } }).ok, false);
    assert.equal(readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: true, blurReported: "true" } }).ok, false);
    assert.equal(readBlurReportResult("SF-a", { ok: true, status: 200, data: "<html>" }).ok, false);
    // A reply about another face is not a confirmation for this one.
    assert.equal(
      readBlurReportResult("SF-a", { ok: true, status: 200, data: { success: true, faceId: "SF-b", blurReported: true } }).ok,
      false,
    );
  });
});

describe("applyBlurState (after a confirmed 2xx only)", () => {
  const clusters = [cluster("C1", [faceA, legacy]), cluster("C2", [faceB])];

  it("sets the flag on the matching face and leaves everything else untouched", () => {
    const next = applyBlurState(clusters, "SF-a", true);
    assert.notEqual(next, clusters);
    assert.equal(isBlurReported(next[0].photos[0]), true);
    assert.equal(next[0].photos[1], legacy);
    assert.equal(next[1], clusters[1]);
    // The original state is not mutated (a failed request has nothing to revert).
    assert.equal(isBlurReported(clusters[0].photos[0]), false);
  });

  it("withdraws, keeping the photo in the cluster", () => {
    const next = applyBlurState(clusters, "SF-b", false);
    assert.equal(next[1].photos.length, 1);
    assert.equal(next[1].photos[0].faceId, "SF-b");
    assert.equal(isBlurReported(next[1].photos[0]), false);
  });

  it("returns the same array when nothing changes", () => {
    assert.equal(applyBlurState(clusters, "SF-a", false), clusters);
    assert.equal(applyBlurState(clusters, "SF-b", true), clusters);
    assert.equal(applyBlurState(clusters, "SF-unknown", true), clusters);
  });

  it("success copy says the photo is kept", () => {
    assert.match(blurReportSuccessText(true), /vẫn được giữ/);
    assert.match(blurReportSuccessText(false), /vẫn được giữ/);
    assert.match(BLUR_REPORT_HINT, /không bị xóa/);
  });
});

describe("StrangerClusterModal blur report wiring", () => {
  const src = readFileSync(new URL("../src/components/StrangerClusterModal.tsx", import.meta.url), "utf8");

  it("shows the toggle to operator/admin only, as a pressed-state button", () => {
    assert.match(src, /hasRole\(useOperatorSession\(\), "operator"\)/);
    assert.match(src, /showBlurToggle = canReportBlur && canBlurReport\(photo\)/);
    assert.match(src, /aria-pressed=\{blurReported\}/);
    assert.match(src, /aria-pressed=\{isBlurReported\(activePhoto\)\}/);
    assert.match(src, /"Bỏ báo mờ"/);
    assert.match(src, /"Báo ảnh mờ"/);
    assert.match(src, /Đã báo mờ/);
  });

  it("updates state only from a confirmed server reply", () => {
    assert.match(src, /operatorJsonFetch\(url, init\)/);
    const handler = src.slice(src.indexOf("const handleToggleBlurReport"), src.indexOf("const handleSubmitQuickRegister"));
    assert.ok(handler.length > 0);
    // applyBlurState runs only after readBlurReportResult and the failure early return.
    const readAt = handler.indexOf("readBlurReportResult");
    const failAt = handler.indexOf('if ("error" in outcome)');
    const applyAt = handler.indexOf("applyBlurState");
    assert.ok(readAt > 0 && failAt > readAt && applyAt > failAt);
    // Never removes the photo or the cluster.
    assert.doesNotMatch(handler, /filter\(/);
  });
});

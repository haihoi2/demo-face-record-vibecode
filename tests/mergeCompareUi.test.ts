/**
 * Merge comparison (owner request 2026-10-04): every merge of a stranger group
 * into an existing employee first opens a photo comparison; the merge request is
 * sent only from its "Xác nhận gộp". Pure helpers, a static render of the dialog
 * markup, and the panel wiring.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Employee, StrangerCluster } from "../src/types";
import {
  EMPTY_FACE_SAMPLES,
  MERGE_COMPARE_CAUTION,
  MERGE_COMPARE_MAX_SAMPLES,
  MERGE_COMPARE_MAX_TEMPLATE_FRAMES,
  MERGE_COMPARE_NO_SAMPLES,
  compareSuggestion,
  employeeHeading,
  faceSamplesLoadError,
  faceSamplesUrl,
  formatCompareTime,
  matchScoreLabel,
  noSamplesNotice,
  readFaceSamples,
  registrationPhotoState,
  registrationPhotoText,
  sampleCaptionParts,
  strangerPhotoCaptionParts,
  suggestionStrengthLabel,
  templateFrameCaptionParts,
  templateSourceLabel,
} from "../src/utils/mergeCompare";
import { MergeCompareView, type MergeCompareViewProps } from "../src/components/MergeCompareDialog";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Whether the button carrying `data-testid` has the disabled attribute (not a `disabled:` class). */
const isDisabled = (html: string, testId: string): boolean => {
  const tag = html.match(new RegExp(`<button\\b[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  assert.ok(tag, `button ${testId} rendered`);
  return /\sdisabled=""/.test(tag);
};

describe("readFaceSamples", () => {
  const body = {
    success: true,
    employee: { id: "EMP-1", name: "TIÊN OB", employeeCode: "NV-4386", department: "OutBound", hasPhoto: true },
    samples: [
      { faceId: "SF-old", capturedAt: "2026-10-01T01:00:00.000Z", gateId: "entry", matchCosine: 0.612 },
      { faceId: "SF-new", capturedAt: "2026-10-03T01:00:00.000Z" },
      { faceId: "../etc/passwd", capturedAt: "2026-10-03T02:00:00.000Z" },
      { faceId: "SF-new", capturedAt: "2026-10-03T01:00:00.000Z" },
      { faceId: 42 },
      null,
    ],
    templateFrames: [
      { logId: "LOG-1", capturedAt: "2026-09-20T01:00:00.000Z", source: "merge", streamId: "cam-1" },
      { logId: "LOG-1", capturedAt: "2026-09-20T01:00:00.000Z", source: "merge" },
      { logId: "LOG-2", capturedAt: "2026-09-25T01:00:00.000Z", source: "enrollment" },
      { logId: "a/b", capturedAt: "2026-09-25T01:00:00.000Z", source: "enrollment" },
    ],
  };

  it("maps ids to the protected image routes, newest first, dropping unsafe and duplicate ids", () => {
    const view = readFaceSamples(body);
    assert.deepEqual(view.employee, {
      id: "EMP-1",
      name: "TIÊN OB",
      employeeCode: "NV-4386",
      department: "OutBound",
      hasPhoto: true,
    });
    assert.deepEqual(
      view.samples.map((s) => [s.faceId, s.imageUrl]),
      [
        ["SF-new", "/api/strangers/faces/SF-new/image"],
        ["SF-old", "/api/strangers/faces/SF-old/image"],
      ]
    );
    assert.equal(view.samples[1].gateId, "entry");
    assert.equal(view.samples[1].matchCosine, 0.612);
    assert.equal("gateId" in view.samples[0], false);
    assert.equal("matchCosine" in view.samples[0], false);
    assert.deepEqual(
      view.templateFrames.map((f) => [f.logId, f.imageUrl, f.source]),
      [
        ["LOG-2", "/api/logs/LOG-2/image", "enrollment"],
        ["LOG-1", "/api/logs/LOG-1/image", "merge"],
      ]
    );
    assert.equal(view.templateFrames[1].streamId, "cam-1");
  });

  it("caps the lists at the contract's sizes", () => {
    const many = {
      success: true,
      employee: { id: "E" },
      samples: Array.from({ length: 12 }, (_, i) => ({ faceId: `SF-${i}`, capturedAt: `2026-10-0${(i % 9) + 1}T00:00:00Z` })),
      templateFrames: Array.from({ length: 7 }, (_, i) => ({ logId: `LOG-${i}`, capturedAt: "2026-10-01T00:00:00Z", source: "auto" })),
    };
    const view = readFaceSamples(many);
    assert.equal(view.samples.length, MERGE_COMPARE_MAX_SAMPLES);
    assert.equal(view.templateFrames.length, MERGE_COMPARE_MAX_TEMPLATE_FRAMES);
    assert.equal(MERGE_COMPARE_MAX_SAMPLES, 8);
    assert.equal(MERGE_COMPARE_MAX_TEMPLATE_FRAMES, 4);
  });

  it("yields the empty view for a refusal or a malformed body", () => {
    assert.deepEqual(readFaceSamples(null), EMPTY_FACE_SAMPLES);
    assert.deepEqual(readFaceSamples({ success: false, error: "x" }), EMPTY_FACE_SAMPLES);
    assert.deepEqual(readFaceSamples({ success: true }), EMPTY_FACE_SAMPLES);
    assert.deepEqual(readFaceSamples("<html>"), EMPTY_FACE_SAMPLES);
  });

  it("encodes the employee id into the JSON route", () => {
    assert.equal(faceSamplesUrl("EMP-1"), "/api/employees/EMP-1/face-samples");
    assert.equal(faceSamplesUrl("a/b c"), "/api/employees/a%2Fb%20c/face-samples");
  });
});

describe("faceSamplesLoadError", () => {
  it("shows an HTTP refusal's server text as-is", () => {
    assert.equal(
      faceSamplesLoadError({ ok: false, status: 404, data: { success: false, error: "Không tìm thấy nhân viên EMP-9" } }),
      "Không tìm thấy nhân viên EMP-9"
    );
    assert.equal(faceSamplesLoadError({ ok: false, status: 403, data: undefined, error: "Lỗi yêu cầu (HTTP 403)" }), "Lỗi yêu cầu (HTTP 403)");
    assert.equal(faceSamplesLoadError({ ok: false, status: 500, data: undefined }), "HTTP 500");
  });

  it("names a transport failure as such, never as an empty success", () => {
    const text = faceSamplesLoadError({ ok: false, status: 0, data: undefined, error: "Failed to fetch" });
    assert.match(String(text), /Không kết nối được máy chủ/);
    assert.match(String(text), /Failed to fetch/);
  });

  it("treats a 2xx without success as an error and a success as none", () => {
    assert.equal(faceSamplesLoadError({ ok: true, status: 200, data: { success: false, error: "tắt" } }), "tắt");
    assert.match(String(faceSamplesLoadError({ ok: true, status: 200, data: {} })), /không trả về/);
    assert.equal(faceSamplesLoadError({ ok: true, status: 200, data: { success: true, samples: [] } }), null);
  });
});

describe("labels", () => {
  it("formats times with a fallback for missing or invalid values", () => {
    assert.equal(formatCompareTime(""), "—");
    assert.equal(formatCompareTime(null), "—");
    assert.equal(formatCompareTime("not a date"), "—");
    assert.notEqual(formatCompareTime("2026-10-03T01:02:03.000Z"), "—");
  });

  it("captions a face crop with time, gate label and score only when present", () => {
    const labels = { "gate-b": "Cổng kho B" };
    const full = sampleCaptionParts({ capturedAt: "2026-10-03T01:02:03Z", gateId: "gate-b", matchCosine: 0.612 }, labels);
    assert.equal(full.length, 3);
    assert.equal(full[1], "Cổng kho B");
    assert.equal(full[2], "Độ giống 61%");
    assert.deepEqual(sampleCaptionParts({ capturedAt: "x" }), ["—"]);
    assert.equal(sampleCaptionParts({ capturedAt: "x", gateId: "entry" })[1], "Cổng vào");
    assert.equal(sampleCaptionParts({ capturedAt: "x", gateId: "dock" })[1], "Cổng dock");
    assert.equal(matchScoreLabel(undefined), "");
    assert.equal(matchScoreLabel(Number.NaN), "");
  });

  it("names template sources and keeps an unknown one as-is", () => {
    assert.equal(templateSourceLabel("enrollment"), "Ảnh đăng ký");
    assert.equal(templateSourceLabel("merge"), "Gộp từ người lạ");
    assert.equal(templateSourceLabel("adaptation"), "Tự bổ sung khi nhận diện");
    assert.equal(templateSourceLabel("future-kind"), "future-kind");
    assert.equal(templateSourceLabel(""), "Không rõ nguồn");
    assert.deepEqual(templateFrameCaptionParts({ capturedAt: "x", source: "manual", streamId: "cam-2" }), ["—", "Thêm thủ công", "luồng cam-2"]);
  });

  it("words the suggestion's score with its strength on the panel's weak line", () => {
    assert.equal(suggestionStrengthLabel(0.55 - 0.004), "Độ giống 55% - yếu");
    assert.equal(suggestionStrengthLabel(0.62), "Độ giống 62% - gần giống");
    assert.equal(suggestionStrengthLabel(Number.NaN), "Độ giống — - yếu");
    assert.match(MERGE_COMPARE_CAUTION, /Chỉ là gợi ý/);
    assert.match(MERGE_COMPARE_CAUTION, /so ảnh/);
  });

  it("headings, stranger captions, registration photo states", () => {
    assert.equal(employeeHeading("TIÊN OB", "NV-4386"), "TIÊN OB (NV-4386)");
    assert.equal(employeeHeading("TIÊN OB", ""), "TIÊN OB");
    assert.deepEqual(strangerPhotoCaptionParts({ timestamp: "bad", doorName: "Cổng vào - Camera 1" }), ["—", "Cổng vào - Camera 1"]);
    assert.equal(registrationPhotoState("/api/employees/E/photo", false), "photo");
    assert.equal(registrationPhotoState("", true), "pending");
    assert.equal(registrationPhotoState("", false), "none");
    assert.equal(registrationPhotoState("", null), "unknown");
    for (const s of ["pending", "none", "unknown"] as const) assert.ok(registrationPhotoText(s).length > 0);
  });

  it("says plainly when there are no gate pictures", () => {
    assert.equal(noSamplesNotice({ samples: [], templateFrames: [] }), MERGE_COMPARE_NO_SAMPLES);
    assert.equal(MERGE_COMPARE_NO_SAMPLES, "Chưa có ảnh nhận diện tại cổng của nhân viên này - chỉ có ảnh đăng ký");
    assert.equal(noSamplesNotice({ samples: [{ faceId: "a", capturedAt: "", imageUrl: "" }], templateFrames: [] }), null);
  });

  it("passes the suggestion only when the target is the suggested employee", () => {
    const cluster = { suggestion: { employeeId: "EMP-1", name: "TIÊN OB", employeeCode: "NV-4386", cosine: 0.55, missingCameras: [] } };
    assert.equal(compareSuggestion(cluster, { id: "EMP-1" })?.cosine, 0.55);
    assert.equal(compareSuggestion(cluster, { id: "EMP-2" }), null);
    assert.equal(compareSuggestion({}, { id: "EMP-1" }), null);
    assert.equal(compareSuggestion(cluster, null), null);
  });
});

describe("MergeCompareView markup", () => {
  const cluster: StrangerCluster = {
    clusterId: "C1",
    label: "Người lạ #1",
    photos: [
      {
        logId: "LOG-a",
        observationId: "face:SF-a",
        faceId: "SF-a",
        photoSnapshot: "/api/strangers/faces/SF-a/image",
        timestamp: "2026-10-04T01:00:00.000Z",
        confidence: 0,
        doorName: "Cổng vào - Camera 1",
      },
      {
        logId: "LOG-b",
        observationId: "face:SF-b",
        faceId: "SF-b",
        photoSnapshot: "/api/strangers/faces/SF-b/image",
        timestamp: "2026-10-04T01:05:00.000Z",
        confidence: 0,
        doorName: "Cổng ra - Camera 2",
      },
    ],
    firstSeen: "2026-10-04T01:00:00.000Z",
    lastSeen: "2026-10-04T01:05:00.000Z",
    totalSightings: 2,
    primaryPhoto: "/api/strangers/faces/SF-a/image",
    similarityScore: null,
  } as StrangerCluster;
  const employee: Employee = {
    id: "EMP-1",
    name: "TIÊN OB",
    employeeCode: "NV-4386",
    department: "OutBound",
    position: "",
    photoUrl: "/api/employees/EMP-1/photo",
    registeredAt: "",
    accessLevel: "ALL_ACCESS",
  };
  const noop = () => {};
  const render = (extra: Partial<MergeCompareViewProps> = {}) =>
    renderToStaticMarkup(
      React.createElement(MergeCompareView, {
        cluster,
        activeObservationId: "face:SF-a",
        viewObservationId: "face:SF-a",
        employee,
        suggestion: null,
        adoptPhoto: false,
        submitting: false,
        samples: EMPTY_FACE_SAMPLES,
        loading: false,
        loadError: null,
        gateLabels: {},
        onViewPhoto: noop,
        onZoom: noop,
        onConfirm: noop,
        onCancel: noop,
        onRetry: noop,
        ...extra,
      })
    );

  it("is a labelled modal with the two columns and the two buttons", () => {
    const html = render();
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="merge-compare-title"/);
    assert.match(html, /Người lạ/);
    assert.match(html, /TIÊN OB \(NV-4386\)/);
    assert.match(html, />Xác nhận gộp</);
    assert.match(html, />Hủy</);
    assert.match(html, /Ảnh đăng ký/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /Ảnh chính/);
  });

  it("shows the suggestion's strength and caution only for a suggestion", () => {
    assert.doesNotMatch(render(), /merge-compare-suggestion/);
    const html = render({
      suggestion: { employeeId: "EMP-1", name: "TIÊN OB", employeeCode: "NV-4386", cosine: 0.5499, missingCameras: [] },
    });
    assert.match(html, /Độ giống 55% - yếu/);
    assert.match(html, /Chỉ là gợi ý từ độ giống với mẫu đã có/);
  });

  it("says plainly that only the registration photo exists, and still offers confirming", () => {
    const html = render();
    assert.match(html, /Chưa có ảnh nhận diện tại cổng của nhân viên này - chỉ có ảnh đăng ký/);
    assert.equal(isDisabled(html, "merge-compare-confirm"), false);
  });

  it("shows a load error with a retry and keeps confirming possible", () => {
    const html = render({ loadError: "Không tìm thấy nhân viên EMP-1" });
    assert.match(html, /role="alert"/);
    assert.match(html, /Không tìm thấy nhân viên EMP-1/);
    assert.match(html, /Thử lại/);
    assert.doesNotMatch(html, /merge-compare-empty/);
    assert.equal(isDisabled(html, "merge-compare-confirm"), false);
  });

  it("shows loading without the empty notice", () => {
    const html = render({ loading: true });
    assert.match(html, /Đang tải ảnh/);
    assert.doesNotMatch(html, /merge-compare-empty/);
  });

  it("lists recognised crops with gate and score, then template frames under their heading", () => {
    const samples = readFaceSamples({
      success: true,
      employee: { id: "EMP-1", name: "TIÊN OB", employeeCode: "NV-4386", hasPhoto: true },
      samples: [{ faceId: "SF-x", capturedAt: "2026-10-03T01:00:00Z", gateId: "gate-b", matchCosine: 0.7 }],
      templateFrames: [{ logId: "LOG-9", capturedAt: "2026-09-20T01:00:00Z", source: "merge" }],
    });
    const html = render({ samples, gateLabels: { "gate-b": "Cổng kho B" } });
    assert.match(html, /Ảnh nhận diện tại cổng \(1\)/);
    assert.match(html, /Cổng kho B/);
    assert.match(html, /Độ giống 70%/);
    assert.match(html, /Khung hình đã tạo mẫu/);
    assert.match(html, /Gộp từ người lạ/);
    assert.ok(html.indexOf("Ảnh nhận diện tại cổng") < html.indexOf("Khung hình đã tạo mẫu"));
    assert.doesNotMatch(html, /merge-compare-empty/);
    // Images go through the protected component, never a bare <img> with the API path.
    assert.doesNotMatch(html, /<img[^>]*\/api\//);
  });

  it("disables both buttons while the merge is being sent", () => {
    const html = render({ submitting: true });
    assert.match(html, /Đang gộp cụm ảnh/);
    assert.equal(isDisabled(html, "merge-compare-cancel"), true);
    assert.equal(isDisabled(html, "merge-compare-confirm"), true);
  });
});

describe("panel wiring", () => {
  const panel = read("src/components/StrangerClusterModal.tsx");
  const dialog = read("src/components/MergeCompareDialog.tsx");

  it("sends the merge only from the comparison's confirm", () => {
    // The form submit opens the comparison and sends nothing.
    const submit = panel.slice(panel.indexOf("const handleSubmitMerge"), panel.indexOf("const sendMerge"));
    assert.ok(submit.length > 0);
    assert.match(submit, /setCompareOpen\(true\)/);
    assert.doesNotMatch(submit, /operatorJsonFetch|\/api\/strangers\/merge/);
    // The one merge request lives in sendMerge, called only by the dialog.
    assert.equal((panel.match(/"\/api\/strangers\/merge"/g) || []).length, 1);
    assert.ok(panel.indexOf('"/api/strangers/merge"') > panel.indexOf("const sendMerge"));
    assert.equal((panel.match(/sendMerge\(\)/g) || []).length, 1);
    assert.match(panel, /onConfirm=\{\(\) => void sendMerge\(\)\}/);
    assert.match(panel, /onCancel=\{\(\) => setCompareOpen\(false\)\}/);
  });

  it("opens the comparison from every suggestion merge button", () => {
    const open = panel.slice(panel.indexOf("const handleOpenMergeSuggestion"), panel.indexOf("// Search the authoritative server roster"));
    assert.match(open, /setCompareOpen\(true\)/);
    assert.match(panel, /setEmployeeQuery\(suggestion\.employeeCode \|\| suggestion\.name\);\s*setCompareOpen\(true\);\s*\}\}/);
  });

  it("keeps the merge payload unchanged", () => {
    const send = panel.slice(panel.indexOf("const sendMerge"), panel.indexOf("const [dismissingId"));
    for (const field of ["employeeId: mergeTarget.id", "employeeCode: mergeTarget.employeeCode", "clusterId: selectedCluster.clusterId", "clusterVersion: selectedCluster.clusterVersion", "adoptPhoto,", "...resolvePayloadIds(selectedCluster.photos, activePhoto)"]) {
      assert.ok(send.includes(field), field);
    }
  });

  it("the dialog itself sends no mutation and loads pictures with the operator session", () => {
    assert.doesNotMatch(dialog, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
    assert.match(dialog, /operatorJsonFetch<unknown>\(faceSamplesUrl\(employee\.id\)\)/);
    assert.doesNotMatch(dialog, /<img\b/);
    assert.doesNotMatch(dialog, /localStorage|sessionStorage/);
    // Escape and the backdrop cancel unless the merge is being sent; Tab is trapped.
    assert.match(dialog, /e\.key === "Escape"/);
    assert.match(dialog, /e\.key !== "Tab"/);
    assert.match(dialog, /e\.target === e\.currentTarget && !submitting/);
  });
});

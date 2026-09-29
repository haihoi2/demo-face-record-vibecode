/**
 * Accuracy wave UI (plan docs/plans/2026-09-29-scale-and-accuracy.md, Parts B/C,
 * section 9): the engine card's 24 h shadow summary, the per-camera coverage
 * indicator and filter in the employee list, and the merge suggestion on a
 * stranger group. Pure helpers plus source inspection of the three components.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ShadowAccuracySummaryView, StrangerClusterSuggestion } from "../src/types";
import {
  IDENTITY_MISMATCH_REVIEW_LABEL,
  NO_USABLE_FACE_WARN_SHARE,
  agreementRows,
  cameraShortLabel,
  coverageIndicatorText,
  deriveCoverage,
  formatCosinePercent,
  formatShare,
  isAdaptationTemplate,
  isEmptyShadowWindow,
  missingCameras,
  noUsableFaceShare,
  noUsableFaceTone,
  passesCoverageFilter,
  readShadowSummary,
  readSuggestion,
  shadowSummaryForGate,
  suggestionAsEmployee,
  suggestionMergeLabel,
  suggestionText,
  type CoverageStream,
} from "../src/utils/accuracyUi";

const gateView = (extra: Partial<ShadowAccuracySummaryView> & { gate: string }): ShadowAccuracySummaryView => ({
  since: "2026-09-29T10:08:00.000Z",
  decisions: 0,
  employees: 0,
  strangers: 0,
  insufficient: 0,
  framesUsedZero: 0,
  agree: 0,
  shadowOnly: 0,
  legacyOnly: 0,
  identityMismatch: 0,
  none: 0,
  decisionLatencyP50Ms: null,
  ...extra,
});

// The live numbers from plan section 1 (entry gate, 1.5 h): 756 decisions, 742 with no usable face.
const entry = gateView({
  gate: "ENTRY",
  decisions: 756,
  employees: 11,
  strangers: 3,
  insufficient: 742,
  framesUsedZero: 742,
  agree: 9,
  shadowOnly: 2,
  legacyOnly: 4,
  identityMismatch: 1,
  none: 740,
  decisionLatencyP50Ms: 380,
});

describe("shadow summary body", () => {
  it("reads the contract shape and defaults missing counters to 0", () => {
    const summary = readShadowSummary({
      success: true,
      since: "2026-09-28T10:00:00.000Z",
      gates: [entry, { gate: "exit", decisions: 44 }, { nope: true }, null],
    });
    assert.ok(summary);
    assert.equal(summary.since, "2026-09-28T10:00:00.000Z");
    assert.equal(summary.gates.length, 2);
    assert.equal(summary.gates[1].gate, "exit");
    assert.equal(summary.gates[1].decisions, 44);
    assert.equal(summary.gates[1].identityMismatch, 0);
    assert.equal(summary.gates[1].decisionLatencyP50Ms, null);
    assert.equal(shadowSummaryForGate(summary, "entry"), summary.gates[0]);
    assert.equal(shadowSummaryForGate(summary, "exit"), summary.gates[1]);
  });

  it("rejects bodies that are not the summary (refusal JSON, HTML, missing gates)", () => {
    assert.equal(readShadowSummary({ success: false, error: "Forbidden" }), null);
    assert.equal(readShadowSummary("<!doctype html>"), null);
    assert.equal(readShadowSummary({ success: true }), null);
    assert.equal(readShadowSummary(null), null);
    assert.equal(shadowSummaryForGate(null, "entry"), null);
    assert.equal(shadowSummaryForGate({ since: null, gates: [entry] }, "exit"), null);
  });

  it("treats a window with no decision as empty", () => {
    assert.equal(isEmptyShadowWindow(gateView({ gate: "EXIT" })), true);
    assert.equal(isEmptyShadowWindow(null), true);
    assert.equal(isEmptyShadowWindow(entry), false);
    assert.equal(noUsableFaceShare(gateView({ gate: "EXIT" })), null);
    assert.equal(noUsableFaceTone(gateView({ gate: "EXIT" })), undefined);
  });
});

describe("shadow summary formatting", () => {
  it("formats shares as whole percentages and an em dash for an empty whole", () => {
    assert.equal(formatShare(742, 756), "98%");
    assert.equal(formatShare(1, 3), "33%");
    assert.equal(formatShare(0, 756), "0%");
    assert.equal(formatShare(5, 0), "—");
    assert.equal(formatShare(10, 5), "100%");
    assert.equal(formatShare(Number.NaN, 5), "—");
  });

  it("flags the no-usable-face share as a throughput problem above the plan's line", () => {
    assert.ok(Math.abs((noUsableFaceShare(entry) ?? 0) - 742 / 756) < 1e-9);
    assert.equal(noUsableFaceTone(entry), "amber");
    const healthy = gateView({ gate: "ENTRY", decisions: 100, framesUsedZero: 20 });
    assert.equal(noUsableFaceTone(healthy), undefined);
    const border = gateView({ gate: "ENTRY", decisions: 100, framesUsedZero: Math.round(NO_USABLE_FACE_WARN_SHARE * 100) });
    assert.equal(noUsableFaceTone(border), "amber");
    assert.equal(noUsableFaceShare(gateView({ gate: "ENTRY", decisions: 10, framesUsedZero: 40 })), 1);
  });

  it("lists the agreement breakdown in order and marks identity mismatch for review", () => {
    const rows = agreementRows(entry);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["agree", "shadowOnly", "legacyOnly", "identityMismatch", "none"]
    );
    assert.deepEqual(
      rows.map((r) => r.count),
      [9, 2, 4, 1, 740]
    );
    const mismatch = rows.find((r) => r.key === "identityMismatch")!;
    assert.equal(mismatch.needsReview, true);
    assert.equal(mismatch.tone, "rose");
    assert.equal(mismatch.share, "0%");
    assert.equal(rows[0].tone, "emerald");
    assert.equal(rows[4].tone, "slate");
    assert.equal(IDENTITY_MISMATCH_REVIEW_LABEL, "cần kiểm tra");

    const clean = agreementRows(gateView({ gate: "EXIT", decisions: 10, agree: 10 }));
    assert.equal(clean.find((r) => r.key === "identityMismatch")!.needsReview, false);
    assert.equal(clean.find((r) => r.key === "identityMismatch")!.tone, "slate");
  });
});

const cameras: CoverageStream[] = [
  { id: "entry-2201", label: "Camera vào", gateKey: "entry", gateName: "Cổng vào", enabled: true },
  { id: "exit-501", label: "NVR 501", gateKey: "exit", gateName: "Cổng ra", enabled: true },
  { id: "exit-2401", label: "Cũ", gateKey: "exit", gateName: "Cổng ra", enabled: false },
];

describe("per-camera coverage", () => {
  it("prefers the server's coverage array", () => {
    const cov = deriveCoverage({
      coverage: [
        { streamId: "entry-2201", gate: "ENTRY", count: 5, adaptation: 2 },
        { streamId: "exit-501", gate: "EXIT", count: 0, adaptation: 0 },
        { streamId: "", count: 9 },
      ],
      byStream: { "entry-2201": 99 },
      templates: [{ id: "t1", streamId: "exit-501" }],
    });
    assert.deepEqual(cov, [
      { streamId: "entry-2201", gate: "ENTRY", count: 5, adaptation: 2 },
      { streamId: "exit-501", gate: "EXIT", count: 0, adaptation: 0 },
    ]);
  });

  it("falls back to the template list, counting adaptation templates, on an older server", () => {
    const cov = deriveCoverage({
      byStream: { "entry-2201": 3, unknown: 1 },
      templates: [
        { id: "a", streamId: "entry-2201", source: "enrollment" },
        { id: "b", streamId: "entry-2201", source: "adaptation" },
        { id: "c", streamId: "entry-2201", source: "Adaptation " },
        { id: "d", source: "manual" },
      ],
    });
    assert.deepEqual(cov, [
      { streamId: "entry-2201", gate: "", count: 3, adaptation: 2 },
      { streamId: "unknown", gate: "", count: 1, adaptation: 0 },
    ]);
  });

  it("falls back to byStream when there is no template list, and to nothing at all", () => {
    assert.deepEqual(deriveCoverage({ byStream: { "exit-501": 2, "entry-2201": 0 } }), [
      { streamId: "exit-501", gate: "", count: 2, adaptation: 0 },
      { streamId: "entry-2201", gate: "", count: 0, adaptation: 0 },
    ]);
    assert.deepEqual(deriveCoverage({}), []);
    assert.deepEqual(deriveCoverage(null), []);
    assert.equal(isAdaptationTemplate({ source: "merge" }), false);
    assert.equal(isAdaptationTemplate({}), false);
  });

  it("names the missing cameras the way the employee list reads them", () => {
    const entryOnly = deriveCoverage({ coverage: [{ streamId: "entry-2201", gate: "ENTRY", count: 4, adaptation: 0 }] });
    assert.deepEqual(missingCameras(entryOnly, cameras).map((c) => c.id), ["exit-501"]);
    assert.equal(coverageIndicatorText(entryOnly, cameras), "thiếu mẫu ở Cổng ra");
    assert.equal(coverageIndicatorText([], cameras), "chưa có mẫu ở camera nào");
    const both = deriveCoverage({
      coverage: [
        { streamId: "entry-2201", gate: "ENTRY", count: 4, adaptation: 0 },
        { streamId: "exit-501", gate: "EXIT", count: 1, adaptation: 1 },
      ],
    });
    assert.equal(coverageIndicatorText(both, cameras), "đủ mẫu trên 2 camera");
    assert.equal(coverageIndicatorText(both, []), null);
    // A gate with two enabled cameras names the stream too.
    const twoExit: CoverageStream[] = [cameras[1], { ...cameras[2], enabled: true }];
    assert.equal(cameraShortLabel(cameras[1], twoExit), "Cổng ra / NVR 501");
    assert.equal(cameraShortLabel(cameras[1], cameras), "Cổng ra");
    assert.equal(coverageIndicatorText([], twoExit), "chưa có mẫu ở camera nào");
    assert.equal(
      coverageIndicatorText(deriveCoverage({ coverage: [{ streamId: "exit-501", count: 1 }] }), twoExit),
      "thiếu mẫu ở Cổng ra / Cũ"
    );
  });

  it("filters only on coverage it has actually read", () => {
    const entryOnly = deriveCoverage({ coverage: [{ streamId: "entry-2201", gate: "ENTRY", count: 4, adaptation: 0 }] });
    assert.equal(passesCoverageFilter("", undefined, cameras), true);
    assert.equal(passesCoverageFilter("__any__", undefined, cameras), false);
    assert.equal(passesCoverageFilter("__any__", null, cameras), false);
    assert.equal(passesCoverageFilter("__any__", entryOnly, cameras), true);
    assert.equal(passesCoverageFilter("exit-501", entryOnly, cameras), true);
    assert.equal(passesCoverageFilter("entry-2201", entryOnly, cameras), false);
    assert.equal(passesCoverageFilter("no-such-camera", entryOnly, cameras), false);
  });
});

const suggestion: StrangerClusterSuggestion = {
  employeeId: "EMP-1",
  name: "Nguyễn Văn A",
  employeeCode: "NV-001",
  cosine: 0.6234,
  missingCameras: ["Cổng ra"],
};

describe("stranger group suggestion", () => {
  it("is worded as a possibility with the cosine as a percentage and the missing cameras", () => {
    assert.equal(suggestionText(suggestion), "Có thể là Nguyễn Văn A (NV-001) – 62% – chưa có mẫu ở Cổng ra");
    assert.equal(
      suggestionText({ ...suggestion, missingCameras: ["Cổng vào", " Cổng ra "] }),
      "Có thể là Nguyễn Văn A (NV-001) – 62% – chưa có mẫu ở Cổng vào, Cổng ra"
    );
    assert.equal(suggestionText({ ...suggestion, missingCameras: [] }), "Có thể là Nguyễn Văn A (NV-001) – 62%");
    assert.equal(suggestionMergeLabel(suggestion), "Gộp vào Nguyễn Văn A");
    assert.doesNotMatch(suggestionText(suggestion), /đã nhận diện|là nhân viên|xác nhận/);
  });

  it("clamps the cosine percentage", () => {
    assert.equal(formatCosinePercent(0.5), "50%");
    assert.equal(formatCosinePercent(1.4), "100%");
    assert.equal(formatCosinePercent(-0.2), "0%");
    assert.equal(formatCosinePercent(Number.NaN), "—");
  });

  it("pre-fills the merge flow with only the id and code that the request uses", () => {
    const emp = suggestionAsEmployee(suggestion);
    assert.equal(emp.id, "EMP-1");
    assert.equal(emp.employeeCode, "NV-001");
    assert.equal(emp.name, "Nguyễn Văn A");
    assert.equal(emp.photoUrl, "");
  });

  it("ignores a suggestion that names no employee", () => {
    assert.deepEqual(readSuggestion(suggestion), suggestion);
    assert.equal(readSuggestion(undefined), null);
    assert.equal(readSuggestion({ name: "x" }), null);
    assert.equal(readSuggestion({ employeeId: "E", name: "" }), null);
    const loose = readSuggestion({ employeeId: "E", name: "N", cosine: "0.9", missingCameras: ["a", 1, null] });
    assert.deepEqual(loose, { employeeId: "E", name: "N", employeeCode: "", cosine: 0, missingCameras: ["a"] });
  });
});

describe("component sources", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("engine card reads the 24 h summary on the card's cadence and hides it on 404", () => {
    const src = read("src/components/RealtimeEngineCard.tsx");
    assert.match(src, /\/api\/pipeline\/shadow-summary\?hours=\$\{SHADOW_SUMMARY_HOURS\}/);
    assert.match(src, /const SHADOW_SUMMARY_HOURS = 24;/);
    assert.match(src, /Promise\.all\(\[safeJsonFetch<unknown>\("\/api\/camera-streams\/watch"\), fetchShadowSummary\(\)\]\)/);
    assert.match(src, /if \(res\.status === 404 \|\| res\.status === 501\) \{\s*setShadowSupported\(false\)/);
    assert.match(src, /if \(shadowSupported !== true\) return null;/);
    assert.match(src, /Độ chính xác \(\{SHADOW_SUMMARY_HOURS\} giờ\)/);
    assert.match(src, /IDENTITY_MISMATCH_REVIEW_LABEL/);
    // A refusal keeps the last numbers and says so; it is never rendered as data.
    assert.match(src, /Đang hiển thị số liệu độ chính xác của lần đọc trước/);
    assert.doesNotMatch(src, /chu kỳ|tần suất|quét mỗi/);
  });

  it("employee list derives coverage from the templates body and filters on it", () => {
    const src = read("src/components/EmployeeRegistration.tsx");
    assert.match(src, /deriveCoverage\(res\.data\)/);
    assert.match(src, /passesCoverageFilter\(coverageFilter, coverageByEmployee\[emp\.id\], activeStreams\)/);
    assert.match(src, /Thiếu mẫu trên camera…/);
    assert.match(src, /isAdaptationTemplate\(tpl\) && \(/);
    assert.match(src, /\{ADAPTATION_TAG\}/);
    // The adaptation tag sits inside the existing template row, which keeps its delete button.
    assert.match(src, /onClick=\{\(\) => handleDeleteTemplate\(tpl\.id\)\}/);
    assert.doesNotMatch(src, /chu kỳ|tần suất|quét mỗi/);
  });

  it("stranger panel shows the suggestion as a hint and pre-selects the merge target only", () => {
    const src = read("src/components/StrangerClusterModal.tsx");
    assert.match(src, /const suggestion = readSuggestion\(cluster\.suggestion\);/);
    assert.match(src, /handleOpenMergeSuggestion = \(cluster: StrangerCluster, suggestion: StrangerClusterSuggestion\)/);
    assert.match(src, /setFormMode\("MERGE"\);\s*setMergeTarget\(suggestionAsEmployee\(suggestion\)\);/);
    // The merge still goes through the existing form and its submit; no auto-submit.
    assert.doesNotMatch(src, /handleOpenMergeSuggestion[\s\S]{0,400}handleSubmitMerge/);
    assert.equal((src.match(/<SuggestionBox\b/g) || []).length, 3);
    assert.match(src, /Chỉ là gợi ý từ độ giống với mẫu đã có, không phải kết luận/);
  });
});

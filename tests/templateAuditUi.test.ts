/**
 * Template audit UI (owner request 2026-11-03, Taiga #508): "So lại mẫu với nhân
 * viên đã biết" lists templates the server found closer to another employee than
 * to their owner. Pure helpers, a static render of the panel, and the wiring.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  REASON_LABEL,
  TEMPLATE_AUDIT_BUTTON,
  TEMPLATE_AUDIT_EMPTY,
  TEMPLATE_AUDIT_EXPLANATION,
  TEMPLATE_AUDIT_FORBIDDEN,
  TEMPLATE_AUDIT_RUNNING,
  TEMPLATE_AUDIT_URL,
  auditErrorText,
  auditSummaryText,
  employeeLabel,
  formatCosine,
  groupSuspectsByEmployee,
  ownCosineText,
  readTemplateAudit,
  reasonLabel,
  sortSuspects,
  suspectImageUrl,
  templateCellParts,
  templateDeleteUrl,
  withoutSuspect,
  type TemplateSuspect,
} from "../src/utils/templateAudit";
import { TemplateAuditPanelView, type TemplateAuditViewProps } from "../src/components/TemplateAuditPanel";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const suspect = (over: Partial<TemplateSuspect>): TemplateSuspect => ({
  templateId: "FT-1",
  employeeId: "EMP-1",
  employeeCode: "NV-4386",
  employeeName: "Tiên OB",
  source: "merge",
  streamId: "entry-101",
  capturedAt: "2026-11-01T01:00:00.000Z",
  quality: 0.93,
  sourceLogId: "LOG-1",
  ownCosine: 0.27,
  otherEmployeeId: "EMP-2",
  otherEmployeeCode: "NV-4658",
  otherEmployeeName: "Hùng IB",
  otherCosine: 0.66,
  otherCentroidCosine: 0.61,
  reason: "closer-to-other",
  ...over,
});

const body = {
  success: true,
  generatedAt: "2026-11-03T02:00:00.000Z",
  modelTag: "arcface_w600k_r50",
  thresholds: { acceptSingle: 0.55 },
  templates: 879,
  employees: 53,
  suspects: [
    { templateId: "FT-a", employeeId: "EMP-1", employeeCode: "NV-4386", employeeName: "Tiên OB", source: "merge", streamId: "entry-101", capturedAt: "2026-11-01T01:00:00.000Z", quality: 0.93, sourceLogId: "LOG-1", ownCosine: 0.27, otherEmployeeId: "EMP-2", otherEmployeeCode: "NV-4658", otherEmployeeName: "Hùng IB", otherCosine: 0.46, otherCentroidCosine: 0.41, reason: "closer-to-other" },
    { templateId: "FT-b", employeeId: "EMP-3", employeeCode: "NV-1", employeeName: "A", source: "enrollment", streamId: "exit-501", capturedAt: "2026-10-01T01:00:00.000Z", quality: 0.5, sourceLogId: null, ownCosine: null, otherEmployeeId: "EMP-2", otherEmployeeCode: "NV-4658", otherEmployeeName: "Hùng IB", otherCosine: 0.66, otherCentroidCosine: 0.61, reason: "matches-other" },
    { templateId: "FT-c", employeeId: "EMP-1", employeeCode: "NV-4386", employeeName: "Tiên OB", source: "adaptation", streamId: "entry-101", capturedAt: "2026-11-02T01:00:00.000Z", quality: 0.8, sourceLogId: "../etc/passwd", ownCosine: 0.31, otherEmployeeId: "EMP-2", otherEmployeeCode: "NV-4658", otherEmployeeName: "Hùng IB", otherCosine: 0.58, otherCentroidCosine: 0.5, reason: "matches-other" },
    { templateId: "FT-a", employeeId: "EMP-1", otherEmployeeId: "EMP-2", otherCosine: 0.9, reason: "matches-other" }, // duplicate id
    { templateId: "FT-x", employeeId: "EMP-1", otherEmployeeId: "EMP-2", otherCosine: 0.9, reason: "something-else" }, // unknown reason
    { templateId: "FT-y", employeeId: "EMP-1", otherEmployeeId: "EMP-2", reason: "matches-other" }, // no cosine
    null,
  ],
};

describe("readTemplateAudit", () => {
  const view = readTemplateAudit(body)!;
  it("keeps the counts, model and threshold", () => {
    assert.equal(view.templates, 879);
    assert.equal(view.employees, 53);
    assert.equal(view.modelTag, "arcface_w600k_r50");
    assert.equal(view.acceptSingle, 0.55);
    assert.equal(view.generatedAt, "2026-11-03T02:00:00.000Z");
  });
  it("drops malformed rows and duplicates, sorts by severity", () => {
    assert.deepEqual(view.suspects.map((s) => s.templateId), ["FT-b", "FT-c", "FT-a"]);
  });
  it("never turns an unsafe sourceLogId into a URL", () => {
    const c = view.suspects.find((s) => s.templateId === "FT-c")!;
    assert.equal(c.sourceLogId, null);
    assert.equal(suspectImageUrl(c), null);
    assert.equal(suspectImageUrl(view.suspects.find((s) => s.templateId === "FT-a")!), "/api/logs/LOG-1/image");
  });
  it("a single-template owner has ownCosine null", () => {
    assert.equal(view.suspects.find((s) => s.templateId === "FT-b")!.ownCosine, null);
  });
  it("refuses success:false, missing suspects, non-objects", () => {
    assert.equal(readTemplateAudit({ success: false, suspects: [] }), null);
    assert.equal(readTemplateAudit({ success: true }), null);
    assert.equal(readTemplateAudit(null), null);
    assert.equal(readTemplateAudit("x"), null);
  });
  it("carries no embedding-like field even when the server sends one", () => {
    const v = readTemplateAudit({ ...body, suspects: [{ ...body.suspects[0], embedding: [0.1, 0.2] }] })!;
    assert.equal("embedding" in (v.suspects[0] as object), false);
  });
});

describe("sortSuspects", () => {
  it("matches-other first, then larger otherCosine, then smaller ownCosine (null last), then id", () => {
    const rows = [
      suspect({ templateId: "c1", reason: "closer-to-other", otherCosine: 0.5 }),
      suspect({ templateId: "m-low", reason: "matches-other", otherCosine: 0.56 }),
      suspect({ templateId: "m-high", reason: "matches-other", otherCosine: 0.7 }),
      suspect({ templateId: "c2-null", reason: "closer-to-other", otherCosine: 0.5, ownCosine: null }),
      suspect({ templateId: "c0", reason: "closer-to-other", otherCosine: 0.5, ownCosine: 0.1 }),
      suspect({ templateId: "c1-dup", reason: "closer-to-other", otherCosine: 0.5 }),
    ];
    assert.deepEqual(sortSuspects(rows).map((s) => s.templateId), ["m-high", "m-low", "c0", "c1", "c1-dup", "c2-null"]);
  });
  it("does not mutate its input", () => {
    const rows = [suspect({ templateId: "b" }), suspect({ templateId: "a" })];
    sortSuspects(rows);
    assert.deepEqual(rows.map((s) => s.templateId), ["b", "a"]);
  });
});

describe("groupSuspectsByEmployee", () => {
  it("groups by employeeId in first-appearance order, rows keep their order", () => {
    const rows = [
      suspect({ templateId: "1", employeeId: "E2", employeeCode: "NV-2" }),
      suspect({ templateId: "2", employeeId: "E1" }),
      suspect({ templateId: "3", employeeId: "E2", employeeCode: "NV-2" }),
    ];
    const groups = groupSuspectsByEmployee(rows);
    assert.deepEqual(groups.map((g) => g.employeeId), ["E2", "E1"]);
    assert.deepEqual(groups[0].suspects.map((s) => s.templateId), ["1", "3"]);
    assert.equal(groups[0].employeeCode, "NV-2");
  });
  it("empty in, empty out", () => assert.deepEqual(groupSuspectsByEmployee([]), []));
});

describe("labels and formatting", () => {
  it("cosine uses two decimals and a Vietnamese comma", () => {
    assert.equal(formatCosine(0.66), "0,66");
    assert.equal(formatCosine(0.275), "0,28");
    assert.equal(formatCosine(1), "1,00");
    assert.equal(formatCosine(null), "—");
    assert.equal(formatCosine(NaN), "—");
  });
  it("own cosine cell says 'chỉ có 1 mẫu' when there is nothing to compare with", () => {
    assert.equal(ownCosineText({ ownCosine: null }), "chỉ có 1 mẫu");
    assert.equal(ownCosineText({ ownCosine: 0.27 }), "0,27");
  });
  it("reason badges", () => {
    assert.equal(reasonLabel("closer-to-other"), "Giống người khác hơn");
    assert.equal(reasonLabel("matches-other"), "Khớp người khác ≥ 0,55");
    assert.deepEqual(Object.keys(REASON_LABEL).sort(), ["closer-to-other", "matches-other"]);
  });
  it("employee label joins code and name, falls back to the id", () => {
    assert.equal(employeeLabel("NV-4658", "Hùng IB"), "NV-4658 · Hùng IB");
    assert.equal(employeeLabel("", "Hùng IB"), "Hùng IB");
    assert.equal(employeeLabel("", "", "EMP-9"), "EMP-9");
    assert.equal(employeeLabel("", ""), "—");
  });
  it("template cell: source label, camera, date (missing parts omitted)", () => {
    const parts = templateCellParts({ source: "merge", streamId: "entry-101", capturedAt: "2026-11-01T01:00:00.000Z" });
    assert.equal(parts[0], "Gộp từ người lạ");
    assert.equal(parts[1], "entry-101");
    assert.match(parts[2], /2026/);
    assert.deepEqual(templateCellParts({ source: "", streamId: "", capturedAt: "" }), []);
  });
  it("summary line", () => {
    assert.equal(
      auditSummaryText({ templates: 879, employees: 53, suspects: [suspect({}), suspect({ templateId: "FT-2" }), suspect({ templateId: "FT-3" })] }),
      "Đã so 879 mẫu của 53 nhân viên – 3 mẫu nghi ngờ"
    );
  });
});

describe("auditErrorText", () => {
  it("401/403 -> admin required; other statuses show the body error; never an empty success", () => {
    assert.equal(auditErrorText({ ok: false, status: 401 }), TEMPLATE_AUDIT_FORBIDDEN);
    assert.equal(auditErrorText({ ok: false, status: 403, data: { error: "x" } }), "Cần quyền admin");
    assert.equal(auditErrorText({ ok: false, status: 503, data: { error: "Engine chưa sẵn sàng" } }), "Engine chưa sẵn sàng");
    assert.equal(auditErrorText({ ok: false, status: 404 }), "Máy chủ chưa hỗ trợ so lại mẫu (HTTP 404).");
    assert.equal(auditErrorText({ ok: false, status: 0, error: "Không thể kết nối đến máy chủ" }), "Không thể kết nối đến máy chủ");
    assert.equal(auditErrorText({ ok: false, status: 500 }), "Không so được mẫu (HTTP 500).");
  });
});

describe("delete bookkeeping", () => {
  it("uses the existing per-employee template route with encoded ids", () => {
    assert.equal(templateDeleteUrl("EMP 1", "FT/2"), "/api/employees/EMP%201/templates/FT%2F2");
  });
  it("withoutSuspect removes exactly that row; the summary follows", () => {
    const view = readTemplateAudit(body)!;
    const after = withoutSuspect(view, "FT-b");
    assert.deepEqual(after.suspects.map((s) => s.templateId), ["FT-c", "FT-a"]);
    assert.match(auditSummaryText(after), /– 2 mẫu nghi ngờ$/);
    assert.equal(view.suspects.length, 3, "input untouched");
  });
});

describe("TemplateAuditPanelView markup", () => {
  const noop = () => {};
  const base: TemplateAuditViewProps = {
    view: null,
    running: false,
    error: null,
    confirmId: null,
    deletingId: null,
    deleteErrors: {},
    onRun: noop,
    onAskDelete: noop,
    onCancelDelete: noop,
    onConfirmDelete: noop,
  };
  const render = (over: Partial<TemplateAuditViewProps>) =>
    renderToStaticMarkup(React.createElement(TemplateAuditPanelView, { ...base, ...over }));
  const runButton = (html: string) => html.match(/<button\b[^>]*data-testid="template-audit-run"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";

  it("idle: the button carries the owner's wording and the explanation is shown", () => {
    const html = render({});
    assert.match(runButton(html), new RegExp(TEMPLATE_AUDIT_BUTTON));
    assert.doesNotMatch(runButton(html), /\sdisabled=""/);
    assert.match(html, /Mẫu nghi ngờ là mẫu giống các mẫu của một nhân viên khác/);
    assert.match(html, /Xóa là vĩnh viễn/);
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /template-audit-table/);
  });
  it("running: disabled + 'Đang so…'", () => {
    const html = render({ running: true });
    assert.match(runButton(html), /\sdisabled=""/);
    assert.match(runButton(html), new RegExp(TEMPLATE_AUDIT_RUNNING));
    assert.match(runButton(html), /aria-busy="true"/);
  });
  it("empty result: summary with zero suspects and the all-clear line", () => {
    const html = render({ view: readTemplateAudit({ ...body, suspects: [] }) });
    assert.match(html, /Đã so 879 mẫu của 53 nhân viên – 0 mẫu nghi ngờ/);
    assert.match(html, new RegExp(TEMPLATE_AUDIT_EMPTY));
    assert.doesNotMatch(html, /template-audit-table/);
  });
  it("error: role=alert with the message, no table or summary", () => {
    const html = render({ error: TEMPLATE_AUDIT_FORBIDDEN });
    assert.match(html, /role="alert"[^>]*data-testid="template-audit-error"/);
    assert.match(html, /Cần quyền admin/);
    assert.doesNotMatch(html, /template-audit-summary/);
  });
  it("suspects: grouped table, columns, badges, cosines, image link, delete action", () => {
    const view = readTemplateAudit(body)!;
    const html = render({ view });
    assert.match(html, /Đã so 879 mẫu của 53 nhân viên – 3 mẫu nghi ngờ/);
    for (const col of ["Nhân viên", "Mẫu", "Giống chính mình", "Giống người khác", "Lý do"]) {
      assert.match(html, new RegExp(`<th scope="col"[^>]*>${col}</th>`), col);
    }
    assert.equal((html.match(/data-testid="template-audit-group"/g) || []).length, 2, "two employees");
    assert.equal((html.match(/data-testid="template-audit-row"/g) || []).length, 3, "three rows");
    assert.match(html, /NV-4386 · Tiên OB/);
    assert.match(html, /NV-4658 · Hùng IB/);
    assert.match(html, /chỉ có 1 mẫu/);
    assert.match(html, /0,27/);
    assert.match(html, /0,66/);
    assert.match(html, /Khớp người khác ≥ 0,55/);
    assert.match(html, /Giống người khác hơn/);
    assert.match(html, /Gộp từ người lạ · entry-101/);
    // The frame goes through ProtectedImage (fetched with the session, no src in markup): one thumb for the row with a log, none for the dropped unsafe id.
    assert.match(html, /aria-label="Phóng to ảnh: Khung hình gốc của mẫu FT-a"/);
    assert.doesNotMatch(html, /Khung hình gốc của mẫu FT-c/);
    assert.doesNotMatch(html, /etc\/passwd/);
    assert.doesNotMatch(html, /data:image/);
    assert.match(html, /data-testid="template-audit-delete-FT-a"[^>]*>[\s\S]*?Xóa mẫu/);
    assert.doesNotMatch(html, /Xóa vĩnh viễn/);
  });
  it("confirm step replaces the row's action with confirm/cancel; delete error is inline", () => {
    const view = readTemplateAudit(body)!;
    const html = render({ view, confirmId: "FT-b", deleteErrors: { "FT-a": "Không xóa được mẫu này (HTTP 500)." } });
    assert.match(html, /data-testid="template-audit-confirm-FT-b"/);
    assert.match(html, /Xóa vĩnh viễn/);
    assert.match(html, /Hủy/);
    assert.doesNotMatch(html, /data-testid="template-audit-delete-FT-b"/);
    assert.match(html, /data-testid="template-audit-delete-error-FT-a"[^>]*>Không xóa được mẫu này \(HTTP 500\)\./);
  });
  it("while a delete is in flight the confirm button is disabled and says so", () => {
    const view = readTemplateAudit(body)!;
    const html = render({ view, confirmId: "FT-b", deletingId: "FT-b" });
    const btn = html.match(/<button\b[^>]*data-testid="template-audit-confirm-FT-b"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
    assert.match(btn, /\sdisabled=""/);
    assert.match(btn, /Đang xóa…/);
  });
});

describe("wiring", () => {
  const panel = read("src/components/TemplateAuditPanel.tsx");
  const reg = read("src/components/EmployeeRegistration.tsx");
  it("the panel reads the agreed audit route and deletes through the existing template route via safeJsonFetch", () => {
    assert.equal(TEMPLATE_AUDIT_URL, "/api/face-templates/audit");
    assert.match(panel, /safeJsonFetch<unknown>\(TEMPLATE_AUDIT_URL\)/);
    assert.match(panel, /templateDeleteUrl\(s\.employeeId, s\.templateId\)/);
    assert.match(panel, /method: "DELETE"/);
    assert.doesNotMatch(panel, /embedding/i, "no embedding ever reaches the panel");
  });
  it("a refused or malformed audit read is an error, never an empty all-clear", () => {
    assert.match(panel, /const parsed = res\.ok \? readTemplateAudit\(res\.data\) : null;/);
    assert.match(panel, /setError\(auditErrorText\(res\)\)/);
  });
  it("mounted for admins only in the registration screen, refreshing the owner's templates after a delete", () => {
    assert.match(reg, /\{isAdmin && \(\s*<TemplateAuditPanel/);
    assert.match(reg, /if \(employeeId === enrollEmployeeId\) void fetchTemplates\(employeeId\);/);
  });
  it("key copy is pinned", () => {
    assert.equal(TEMPLATE_AUDIT_BUTTON, "So lại mẫu với nhân viên đã biết");
    assert.equal(TEMPLATE_AUDIT_RUNNING, "Đang so…");
    assert.equal(TEMPLATE_AUDIT_EMPTY, "Không có mẫu nào giống người khác hơn chính chủ.");
    assert.match(TEMPLATE_AUDIT_EXPLANATION, /dữ liệu sinh trắc/);
  });
});

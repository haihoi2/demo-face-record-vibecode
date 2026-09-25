import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { accessLogExportName, csvCell } from "../src/server/csv";
import { EMPTY_LOG_FILTERS, logFilterParams } from "../src/utils/accessLogs";

describe("CSV export cells", () => {
  it("quotes every cell and doubles embedded quotes", () => {
    assert.equal(csvCell('Nguyễn "Huy"'), '"Nguyễn ""Huy"""');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(96.5), '"96.5"');
  });

  it("never lets a cell run as a spreadsheet formula", () => {
    for (const hostile of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      assert.match(csvCell(hostile), /^"'/, hostile);
    }
    assert.equal(csvCell("Phòng Kỹ Thuật AI"), '"Phòng Kỹ Thuật AI"');
  });
});

describe("history filter parameters", () => {
  it("sends only the filters that are set", () => {
    assert.equal(logFilterParams(EMPTY_LOG_FILTERS).toString(), "");
    const p = logFilterParams({ ...EMPTY_LOG_FILTERS, q: "  huy ", status: "DENIED", type: "EXIT" });
    assert.equal(p.get("q"), "huy");
    assert.equal(p.get("status"), "DENIED");
    assert.equal(p.get("type"), "EXIT");
  });

  it("turns local calendar days into an inclusive-from, exclusive-to instant range", () => {
    const p = logFilterParams({ ...EMPTY_LOG_FILTERS, fromDate: "2026-09-24", toDate: "2026-09-25" });
    assert.equal(p.get("from"), new Date("2026-09-24T00:00:00").toISOString());
    assert.equal(p.get("to"), new Date("2026-09-26T00:00:00").toISOString(), "the whole last day is included");
  });

  it("lets the chart's own range narrow the start, never widen it", () => {
    const f = { ...EMPTY_LOG_FILTERS, fromDate: "2026-09-20" };
    const later = new Date("2026-09-24T00:00:00").toISOString();
    const earlier = new Date("2026-09-01T00:00:00").toISOString();
    assert.equal(logFilterParams(f, later).get("from"), later);
    assert.equal(logFilterParams(f, earlier).get("from"), new Date("2026-09-20T00:00:00").toISOString());
  });
});

describe("CSV export file name", () => {
  const TZ = "Asia/Ho_Chi_Minh";

  it("names the days in the site's calendar, not UTC", () => {
    // "Today" 2026-09-25 in Vietnam = [2026-09-24T17:00Z, 2026-09-25T17:00Z).
    assert.equal(
      accessLogExportName("2026-09-24T17:00:00.000Z", "2026-09-25T17:00:00.000Z", TZ),
      "nhat_ky_vao_ra_tu_2026-09-25_den_2026-09-25.csv",
    );
  });

  it("uses the last day included for the exclusive upper bound", () => {
    assert.equal(
      accessLogExportName("2026-09-19T17:00:00.000Z", "2026-09-25T17:00:00.000Z", TZ),
      "nhat_ky_vao_ra_tu_2026-09-20_den_2026-09-25.csv",
    );
  });

  it("leaves out an open or unreadable bound", () => {
    assert.equal(accessLogExportName(undefined, undefined, TZ), "nhat_ky_vao_ra.csv");
    assert.equal(accessLogExportName("2026-09-24T17:00:00.000Z", undefined, TZ), "nhat_ky_vao_ra_tu_2026-09-25.csv");
    assert.equal(accessLogExportName("garbage", "", TZ), "nhat_ky_vao_ra.csv");
  });
});

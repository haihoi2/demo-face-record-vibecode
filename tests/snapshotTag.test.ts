/** Employee name tag on stored snapshots (2026-10-11). */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SNAPSHOT_TAG_FONT, snapshotNameTag, snapshotTagFilter } from "../src/server/snapshotTag";

describe("name tag", () => {
  it("only for a recognised employee; strangers keep the plain box", () => {
    assert.equal(snapshotNameTag({ recognized: true, employeeId: "EMP-1", employeeName: "Huê", employeeCode: "NV-4143" }), "Huê · NV-4143");
    assert.equal(snapshotNameTag({ recognized: true, employeeId: "EMP-1", employeeName: "Trần\nHoàng Ân" }), "Trần Hoàng Ân");
    assert.equal(snapshotNameTag({ recognized: false, employeeName: "x" }), null);
    assert.equal(snapshotNameTag({ recognized: true, employeeName: "x" }), null, "no employee id");
  });
  it("the text never enters the filter string", () => {
    const f = snapshotTagFilter(SNAPSHOT_TAG_FONT, "/tmp/t0.txt", { x: 0.5, y: 0.4, h: 0.2 });
    assert.match(f, /textfile=\/tmp\/t0\.txt/);
    assert.doesNotMatch(f, /text=[^f]/);
    assert.match(snapshotTagFilter(SNAPSHOT_TAG_FONT, "/t", { x: 0.1, y: 0.01, h: 0.2 }), /h\*0\.2100\+14/, "below a box at the top");
  });
  it("draws a Vietnamese name with the image's ffmpeg and font", { skip: !existsSync(SNAPSHOT_TAG_FONT) || spawnSync("ffmpeg", ["-version"]).status !== 0 ? "ffmpeg or font missing" : false }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tagtest-"));
    try {
      const txt = path.join(dir, "t.txt");
      writeFileSync(txt, "Đặng Thị Bảo Linh · NV-4043", "utf8");
      const out = path.join(dir, "o.jpg");
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=640x360",
        "-frames:v", "1", "-vf", snapshotTagFilter(SNAPSHOT_TAG_FONT, txt, { x: 0.3, y: 0.4, h: 0.3 }), "-y", out]);
      assert.equal(r.status, 0, String(r.stderr));
      assert.ok(readFileSync(out).length > 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

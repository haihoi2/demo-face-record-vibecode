/**
 * The admin guide for adding a gate (public/huong-dan/them-cong.html): it ships
 * with the build, works on a LAN-only site, carries no credentials, and the
 * camera config page links to it.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADD_GATE_GUIDE_PATH } from "../src/utils/gates";

const page = readFileSync(`public${ADD_GATE_GUIDE_PATH}`, "utf8");
const configPage = readFileSync("src/components/CameraStreamConfigPage.tsx", "utf8");

describe("admin guide page: adding a gate", () => {
  it("is a standalone HTML page served from public/", () => {
    assert.match(ADD_GATE_GUIDE_PATH, /^\/huong-dan\/[a-z-]+\.html$/);
    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /<html lang="vi">/);
    assert.match(page, /<title>[^<]+<\/title>/);
  });

  it("loads nothing from outside the gateway (LAN-only sites)", () => {
    assert.doesNotMatch(page, /https?:\/\//i);
    assert.doesNotMatch(page, /<script\b/i);
  });

  it("carries no camera URL, credential or token", () => {
    assert.doesNotMatch(page, /rtsps?:\/\//i);
    assert.doesNotMatch(page, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    assert.doesNotMatch(page, /(password|passwd|token)\s*[=:]/i);
  });

  it("names the real UI controls it tells the admin to press", () => {
    for (const label of ["Thêm cổng", "Thêm luồng", "Thêm Luồng", "Vùng cổng", "Lưu vùng cổng", "Watcher: BẬT", "Nghỉ sau mỗi lần quét", "Số khung"]) {
      assert.ok(page.includes(label), `guide mentions "${label}"`);
      assert.ok(configPage.includes(label) || readFileSync("src/components/CameraDashboard.tsx", "utf8").includes(label) || readFileSync("src/components/GateAreaEditor.tsx", "utf8").includes(label), `UI has "${label}"`);
    }
  });

  it("tells the admin the message switch is in the app, not a redeploy (#580)", () => {
    assert.ok(page.includes("Bật tin nhắn"));
    assert.ok(readFileSync("src/utils/pipelineMode.ts", "utf8").includes('confirmLabel: "Bật tin nhắn"'));
    assert.doesNotMatch(page, /triển khai lại/);
  });

  it("describes the scan wait as a rest, never a period", () => {
    assert.doesNotMatch(page, /chu kỳ|tần suất|quét mỗi \d/i);
  });

  it("is linked from the camera config page, next to Thêm cổng and in its dialog", () => {
    const links = configPage.match(/href=\{ADD_GATE_GUIDE_PATH\}/g) || [];
    assert.equal(links.length, 2);
    assert.match(configPage, /id="link-add-gate-guide"/);
  });
});

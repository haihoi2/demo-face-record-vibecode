/**
 * Owner decision 2026-09-26: the app shows captured FACE crops, never a camera
 * picture; the wider scene is reviewed through "Đoạn ghi" (NVR playback). These
 * source checks keep the camera-picture paths from creeping back and pin the
 * gate-area editor's contract and access rules.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("no camera picture on the monitoring dashboard", () => {
  const dashboard = read("src/components/CameraDashboard.tsx");

  it("requests no MJPEG stream, snapshot or synthetic test frame", () => {
    assert.doesNotMatch(dashboard, /camera-streams\/(?:mjpeg|snapshot|test-frame)/);
    assert.doesNotMatch(dashboard, /viewMode/);
  });

  it("shows the captured faces and points to the NVR recording for the scene", () => {
    assert.match(dashboard, /<FaceThumb/);
    assert.match(dashboard, /Đoạn ghi/);
  });

  it("reads the rollout mode and health from the server's watcher runtime", () => {
    assert.match(dashboard, /pipeline: readPipelineRuntime\(raw\)/);
    assert.match(dashboard, /renderPipelineBlock\(runtime\.pipeline/);
  });
});

describe("camera configuration page", () => {
  const page = read("src/components/CameraStreamConfigPage.tsx");

  it("keeps the connection test and shows stills only on an explicit click", () => {
    assert.match(page, /\/api\/camera-streams\/test-stream/);
    assert.doesNotMatch(page, /camera-streams\/mjpeg/);
    assert.doesNotMatch(page, /src=\{previewStream\.httpUrl\}/, "no direct camera-host MJPEG in the browser");
    // The only timer on the page polls worker telemetry (JSON), never a picture.
    const timers = page.match(/setInterval\([^,]+/g) || [];
    assert.deepEqual(timers, ["setInterval(fetchTelemetry"], "no still refreshes on a timer");
  });

  it("offers the gate-area editor to operators and above only", () => {
    assert.match(page, /const canEditGateArea = hasRole\(useOperatorSession\(\), "operator"\)/);
    assert.match(page, /\{canEditGateArea && s\.sourceType !== "CLIENT_UVC" && \(/);
    assert.match(page, /<GateAreaEditor/);
  });

  it("sends stream mutations through the CSRF-aware helper", () => {
    assert.doesNotMatch(page, /await fetch\(path/);
    assert.match(page, /await apiFetch\(path, \{/);
  });
});

describe("gate-area editor", () => {
  const editor = read("src/components/GateAreaEditor.tsx");

  it("saves roi through the existing per-stream endpoint with the session helper", () => {
    assert.match(editor, /apiFetch\(`\/api\/camera-streams\/\$\{gateKey\}\/streams\/\$\{encodeURIComponent\(stream\.id\)\}`/);
    assert.match(editor, /method: "PUT"/);
    assert.match(editor, /JSON\.stringify\(body\)/);
    assert.match(editor, /gateAreaRequestBody\(area\)/);
  });

  it("trusts the server's answer, not its own request", () => {
    assert.match(editor, /streamGateArea\(returned\)/);
    assert.match(editor, /CHƯA có hiệu lực/);
    assert.match(editor, /CHƯA được lưu/);
  });

  it("fetches one still on open, rejects the placeholder SVG and frees it on close", () => {
    assert.match(editor, /camera-streams\/snapshot\?gate=/);
    assert.match(editor, /image\\\/\(jpeg\|png\|webp\)/);
    assert.match(editor, /URL\.revokeObjectURL\(objectUrl\)/);
    assert.doesNotMatch(editor, /localStorage|sessionStorage|setInterval/);
  });

  it("is an accessible modal", () => {
    assert.match(editor, /role="dialog"/);
    assert.match(editor, /aria-modal="true"/);
    assert.match(editor, /e\.key === "Escape"/);
    assert.match(editor, /aria-live="polite"/);
    assert.match(editor, /ArrowLeft/);
  });
});

describe("enlarged image dialog", () => {
  const component = read("src/components/FaceImage.tsx");

  it("is a modal with focus handling and Escape", () => {
    assert.match(component, /role="dialog"/);
    assert.match(component, /aria-modal="true"/);
    assert.match(component, /e\.key === "Escape"/);
    assert.match(component, /previous\.focus\(\)/);
    assert.match(component, /createPortal/);
  });

  it("loads images only through the protected component", () => {
    assert.doesNotMatch(component, /<img\s/);
  });
});

import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const read = (path: string) => readFileSync(path, "utf8");

describe("protected biometric images", () => {
  it("loads protected log images through the authenticated blob component", () => {
    const component = read("src/components/ProtectedImage.tsx");
    assert.match(component, /apiFetch\(/);
    assert.match(component, /URL\.createObjectURL/);
    assert.match(component, /URL\.revokeObjectURL/);

    for (const path of ["src/components/AccessLogs.tsx", "src/components/StrangerClusterModal.tsx"]) {
      const source = read(path);
      assert.match(source, /<ProtectedImage/);
      assert.doesNotMatch(source, /<img[\s\S]{0,160}normalizeApiAssetUrl\(/);
    }
  });

  it("renders every server-served biometric image through the component, not a bare img", () => {
    // photoSnapshot is always an /api/logs/:id/image URL, and photoUrl becomes
    // one whenever an employee adopts a stranger sighting as their photo. A bare
    // <img> sends no credentials across origins, so both must go through the
    // component wherever they are rendered.
    const sources: Array<[string, RegExp]> = [
      ["src/components/CameraDashboard.tsx", /photoSnapshot|photoUrl/],
      ["src/components/EmployeeRegistration.tsx", /photoUrl/],
      ["src/components/FaceScanner.tsx", /photoUrl/],
      ["src/components/AccessLogs.tsx", /photoSnapshot/],
      ["src/components/StrangerClusterModal.tsx", /photoUrl|photoSnapshot/],
    ];
    for (const [path] of sources) {
      const source = read(path);
      const bare = source.match(/<img\b[\s\S]{0,200}?src=\{[^}]*photo(?:Url|Snapshot)[^}]*\}/g) || [];
      assert.deepEqual(bare, [], `${path} renders a protected image with a bare <img>`);
    }
  });

  it("keeps streaming and third-party image sources on a plain img", () => {
    // A multipart MJPEG response never completes, so it cannot be fetched into a
    // blob; a camera's own host must never receive the operator cookie. Everything
    // else under /api/camera-streams is a single JPEG and goes through the component.
    const source = read("src/components/CameraStreamConfigPage.tsx");
    const bareApi = source.match(/<img\b[\s\S]{0,240}?src=\{`\/api\/camera-streams\/(\w+)/g) || [];
    assert.deepEqual(
      bareApi.map((m) => (m.match(/camera-streams\/(\w+)/) || [])[1]),
      ["mjpeg"],
      "only the MJPEG stream may stay a bare <img>"
    );
    assert.match(source, /<ProtectedImage[\s\S]{0,240}?camera-streams\/snapshot/);
    assert.match(source, /fallbackSrc=/);
  });

  it("passes inline data/blob sources straight through instead of refetching them", () => {
    const component = read("src/components/ProtectedImage.tsx");
    assert.match(component, /\^\(\?:data\|blob\):/);
  });

  it("offers operator sign-in and sign-out instead of a browser prompt", () => {
    const bar = read("src/components/OperatorSessionBar.tsx");
    assert.match(bar, /openOperatorSession/);
    assert.match(bar, /closeOperatorSession/);
    assert.match(bar, /setOperatorTokenResolver/);
    assert.match(bar, /type="password"/);
    assert.doesNotMatch(bar, /localStorage|sessionStorage/);

    const api = read("src/utils/api.ts");
    assert.doesNotMatch(api, /window\.prompt/);

    assert.match(read("src/App.tsx"), /<OperatorSessionBar \/>/);
  });

  it("paginates stranger clusters and resolves deep links through authoritative lookup", () => {
    const source = read("src/components/StrangerClusterModal.tsx");
    assert.match(source, /nextCursor/);
    assert.match(source, /\/api\/strangers\/lookup\?logId=/);
    assert.match(source, /btn-next-stranger-page/);
    assert.match(source, /btn-prev-stranger-page/);
  });
});

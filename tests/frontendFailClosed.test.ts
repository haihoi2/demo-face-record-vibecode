import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("frontend production fail-closed boundaries", () => {
  it("employee registration cannot turn a server rejection into local biometric success", () => {
    const source = read("src/components/EmployeeRegistration.tsx");
    assert.doesNotMatch(source, /smartlock_offline_employees/);
    assert.doesNotMatch(source, /Even in catch block, never leave user stranded/);
    assert.match(source, /if \(!response\.ok \|\| !response\.data\?\.employee\)\s*\{\s*throw new Error/);
  });

  it("door configuration never persists credentials or directly dispatches after backend rejection", () => {
    const source = read("src/components/DoorConfigPage.tsx");
    assert.doesNotMatch(source, /dispatchDirectDoorControllerCommand/);
    assert.doesNotMatch(source, /saveStoredDoorConfig/);
    assert.doesNotMatch(source, /getStoredDoorConfig/);
    assert.match(source, /if \(!res\.ok/);
  });

  it("protected frontend mutations use credentialed CSRF-aware helpers rather than raw fetch", () => {
    for (const path of [
      "src/App.tsx",
      "src/components/SmartLockCard.tsx",
      "src/components/MobileCompanion.tsx",
      "src/components/CameraDashboard.tsx",
      "src/components/CameraStreamConfigPage.tsx",
    ]) {
      const source = read(path);
      assert.doesNotMatch(source, /fetch\(normalizeApiUrl\("\/api\/lock\/(?:un)?lock"\)/, path);
    }
    assert.doesNotMatch(read("src/components/CameraStreamConfigPage.tsx"), /fetch\("\/api\/camera-streams/);
  });

  it("split-origin SSE uses the configured API URL and credentials", () => {
    const source = read("src/components/WebhookIntegration.tsx");
    assert.match(source, /new EventSource\(buildEventSourceUrl\("\/api\/events"\), \{ withCredentials: true \}\)/);
  });
});

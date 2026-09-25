/**
 * What each role is shown in the UI. The server is the authority - these only
 * check that the screens line up with the permission table, so nobody lands on
 * a page where every button would be refused.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TAB_MIN_ROLE, canSeeTab } from "../src/components/Navbar";
import { hasRole } from "../src/utils/session";
import type { OperatorSessionInfo, OperatorRole } from "../src/utils/api";

const as = (role: OperatorRole): OperatorSessionInfo => ({
  actor: role, username: role, displayName: role, role, roleLabel: role, authMethod: "account", expiresAt: "",
});

describe("role checks in the browser", () => {
  it("nest like the server's: admin > operator > viewer, signed out has nothing", () => {
    assert.equal(hasRole(as("admin"), "operator"), true);
    assert.equal(hasRole(as("operator"), "operator"), true);
    assert.equal(hasRole(as("viewer"), "operator"), false);
    assert.equal(hasRole(null, "viewer"), false);
  });
});

describe("tabs by role", () => {
  const visible = (session: OperatorSessionInfo | null) =>
    (Object.keys(TAB_MIN_ROLE) as Array<keyof typeof TAB_MIN_ROLE>).filter((t) => canSeeTab(session, t)).sort();

  it("viewer sees the history and monitoring screens only", () => {
    assert.deepEqual(visible(as("viewer")), ["cameras", "logs", "mobile", "scanner"]);
  });

  it("operator adds registration and manual recognition", () => {
    assert.deepEqual(visible(as("operator")), ["cameras", "catalog", "logs", "manual", "mobile", "register", "scanner"]);
  });

  it("admin sees everything, including accounts and the door/webhook/AI settings", () => {
    assert.deepEqual(visible(as("admin")), Object.keys(TAB_MIN_ROLE).sort());
  });
});

describe("manual door controls", () => {
  it("are rendered only for admin, in every component that has one", () => {
    for (const path of [
      "src/components/SmartLockCard.tsx",
      "src/components/MobileCompanion.tsx",
      "src/components/CameraDashboard.tsx",
      "src/components/FaceScanner.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      assert.match(source, /const canOperateDoor = hasRole\(useOperatorSession\(\), "admin"\)/, path);
    }
  });

  it("a successful recognition in the browser never sends its own unlock", () => {
    // The server unlocks when it decides; the browser unlocking again doubled
    // every actuation and let client code open a physical door.
    const source = readFileSync("src/components/CameraDashboard.tsx", "utf8");
    const afterRecognition = source.slice(source.indexOf("if (finalResult.recognized) {"));
    const block = afterRecognition.slice(0, afterRecognition.indexOf("} else"));
    assert.doesNotMatch(block, /\/api\/lock\/unlock/);
  });
});

/**
 * Every API route must sit behind the fail-closed boundary, including the
 * legacy aliases registered without the /api prefix. /config/ai was one such
 * alias: missing from the boundary's list, it let anyone reach the handler that
 * rewrites the recognition thresholds - lower acceptSingle far enough and the
 * door opens for any face. This test enumerates the route paths declared in
 * server.ts so a new alias cannot slip past unnoticed.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

// Rebuild the boundary's own predicates from the source, so the test checks
// the code that actually runs rather than a copy of it.
const legacyMatch = source.match(/const legacySensitivePath = \(pathName: string\) =>\s*\/(.+)\/\.test\(pathName\);/);
assert.ok(legacyMatch, "legacySensitivePath not found in server.ts");
const legacySensitive = new RegExp(legacyMatch[1]);

const recognitionMatch = source.match(/const recognitionPath = \(pathName: string\) => \[([\s\S]*?)\]\.includes/);
assert.ok(recognitionMatch, "recognitionPath not found in server.ts");
const recognitionPaths = new Set(
  [...recognitionMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/\/+$/, "")),
);

/** Deliberately public, or not routes at all (literals used for other purposes). */
const NOT_PROTECTED = new Set([
  "/api/health",
  "/api/operator/session",
  "/hooks", "/hooks/",            // webhook URL validation literals
  "/node_modules", "/src/",       // request-logger skip list
]);

/** Every string literal in server.ts that is shaped like a route path. */
function declaredRoutePaths(): string[] {
  const paths = new Set<string>();
  for (const m of source.matchAll(/"(\/[a-z][A-Za-z0-9/_:.-]*)"/g)) paths.add(m[1]);
  return [...paths].sort();
}

const isCovered = (p: string) =>
  p.startsWith("/api/") || legacySensitive.test(p) || recognitionPaths.has(p.replace(/\/+$/, ""));

describe("fail-closed boundary coverage", () => {
  it("covers every declared route path, including legacy non-/api aliases", () => {
    const uncovered = declaredRoutePaths().filter((p) => !NOT_PROTECTED.has(p) && !isCovered(p));
    assert.deepEqual(uncovered, [], `route paths outside the auth boundary: ${uncovered.join(", ")}`);
  });

  it("covers the recognition-threshold aliases specifically", () => {
    for (const p of ["/config/ai", "/config/ai/", "/config/ai/benchmark"]) {
      assert.ok(isCovered(p), `${p} must be behind the boundary`);
    }
  });
});

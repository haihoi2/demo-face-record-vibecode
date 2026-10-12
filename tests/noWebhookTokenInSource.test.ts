/** A real Eton chat-room webhook token must never be committed again (2026-10-12; rotate the old one). */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git", "data", ".claude"]);
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|js|md|yml|yaml|json|sql|example)$/.test(name) || name === ".env.example") out.push(p);
  }
  return out;
}

describe("no webhook token in the source", () => {
  it("every chat-room.eton.vn/hooks/ address is a placeholder", () => {
    const offenders: string[] = [];
    for (const f of files(ROOT)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/chat-room\.eton\.vn\/hooks\/([A-Za-z0-9_\/]+)/g)) {
        if (!/^YOUR_/.test(m[1])) offenders.push(path.relative(ROOT, f));
      }
    }
    assert.deepEqual([...new Set(offenders)], [], "replace the token with YOUR_WEBHOOK_TOKEN");
  });
});

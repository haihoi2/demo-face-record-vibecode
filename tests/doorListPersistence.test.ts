/**
 * The door list (N-gate wave) survives a restart on the native SQLite store and
 * the JSON fallback: before this fix the SQLite door_controller_config row had
 * fixed columns and `doors` was dropped, so extra doors vanished on restart and
 * a gate bound to one stopped sending door commands (fail closed).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DB_MODULE = path.join(REPO_ROOT, "src/server/db.ts");
const scratch: string[] = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

function child(dir: string, body: string, nodeArgs: string[]) {
  const script = `const { db } = await import(${JSON.stringify(DB_MODULE)});\n${body}\nprocess.exit(0);`;
  const r = spawnSync(process.execPath, [...nodeArgs, "--import", "tsx", "--input-type=module", "-e", script], {
    cwd: REPO_ROOT, env: { ...process.env, DATA_DIR: dir, DATABASE_URL: "" }, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  return line ? JSON.parse(line.slice(7)) : null;
}

const DEFAULTS = {
  enabled: false, apiUrl: "", apiToken: "", authHeaderType: "BEARER", openMethod: "POST", closeMethod: "POST",
  pulseDurationSeconds: 5, triggerOnFaceRecognition: true, triggerOnManualUnlock: true,
};
const SAVE = `db.saveDoorControllerConfig({ ...${JSON.stringify(DEFAULTS)}, apiUrl: "http://door.example.test/main",
  doors: [{ id: "kho", label: "Cửa kho", ...${JSON.stringify(DEFAULTS)}, apiUrl: "http://door.example.test/kho", apiToken: "kho-token" }] });
process.stdout.write("RESULT " + JSON.stringify({ ok: true }) + "\\n");`;
const READ = `const c = db.getDoorControllerConfig(${JSON.stringify(DEFAULTS)});
process.stdout.write("RESULT " + JSON.stringify({ apiUrl: c.apiUrl, doors: (c.doors || []).map((d) => [d.id, d.label, d.apiUrl, Boolean(d.apiToken)]) }) + "\\n");`;

for (const [mode, args] of [["native SQLite", []], ["JSON fallback", ["--no-experimental-sqlite"]]] as const) {
  describe(`door list persistence (${mode})`, () => {
    it("a saved door list is read back by a new process", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-list-"));
      scratch.push(dir);
      child(dir, SAVE, [...args]);
      const out = child(dir, READ, [...args]);
      assert.equal(out.apiUrl, "http://door.example.test/main");
      assert.deepEqual(out.doors, [["kho", "Cửa kho", "http://door.example.test/kho", true]]);
    });
  });
}

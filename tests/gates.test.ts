/**
 * N-gate contract helpers (src/server/gates.ts): ids, legacy migration, env names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  doorIdOf,
  gateEnvSuffix,
  gateIdForLegacyRow,
  gatesFromStoredConfig,
  isGateId,
  legacyDirectionOf,
  legacyGateViews,
  MAX_GATES,
} from "../src/server/gates";

const norm = (g: Record<string, unknown>, id: string, direction: string) => ({ ...g, name: String(g.name ?? id), normalisedFor: `${id}/${direction}` });

describe("gate ids", () => {
  it("accept lowercase slugs only", () => {
    for (const ok of ["entry", "exit", "side-door", "kho2", "b2-ra"]) assert.ok(isGateId(ok), ok);
    for (const bad of ["", "e", "Entry", "2gate", "side_door", "a".repeat(33), "../x", "entry ", null, 7]) assert.ok(!isGateId(bad), String(bad));
  });

  it("env names: legacy gates keep theirs, new gates get an upper-cased suffix", () => {
    assert.equal(gateEnvSuffix("entry"), "ENTRY");
    assert.equal(gateEnvSuffix("exit"), "EXIT");
    assert.equal(gateEnvSuffix("side-door"), "SIDE_DOOR");
  });
});

describe("legacy migration", () => {
  it("entryGate/exitGate become gates entry (ENTRY) and exit (EXIT), normalised by the caller", () => {
    const { gates, dropped } = gatesFromStoredConfig({ entryGate: { name: "Cổng vào" }, exitGate: { name: "Cổng ra" } }, norm);
    assert.deepEqual(gates.map((g) => [g.id, g.direction, g.name, g.normalisedFor]), [
      ["entry", "ENTRY", "Cổng vào", "entry/ENTRY"],
      ["exit", "EXIT", "Cổng ra", "exit/EXIT"],
    ]);
    assert.deepEqual(dropped, []);
  });

  it("the new shape wins and keeps its order; bad entries are dropped and reported", () => {
    const { gates, dropped } = gatesFromStoredConfig({
      entryGate: { name: "ignored" },
      gates: [
        { id: "exit", direction: "EXIT", name: "Cổng ra" },
        { id: "side-door", gateType: "ENTRY", name: "Cửa hông" },
        { id: "Bad Id", direction: "ENTRY" },
        { id: "exit", direction: "EXIT" },
        { id: "noway", direction: "SIDEWAYS" },
        "junk",
      ],
    }, norm);
    assert.deepEqual(gates.map((g) => [g.id, g.direction]), [["exit", "EXIT"], ["side-door", "ENTRY"]]);
    assert.equal(dropped.length, 4);
  });

  it("caps the number of gates", () => {
    const many = Array.from({ length: MAX_GATES + 3 }, (_, i) => ({ id: `g${i + 10}`, direction: "ENTRY" }));
    const { gates, dropped } = gatesFromStoredConfig({ gates: many }, norm);
    assert.equal(gates.length, MAX_GATES);
    assert.equal(dropped.length, 3);
  });

  it("legacy views are the entry/exit gates when they exist", () => {
    const { gates } = gatesFromStoredConfig({ gates: [{ id: "exit", direction: "EXIT" }, { id: "kho", direction: "ENTRY" }] }, norm);
    const v = legacyGateViews(gates);
    assert.equal(v.entryGate, undefined);
    assert.equal(v.exitGate?.id, "exit");
  });

  it("old rows map to the two legacy gates by direction", () => {
    assert.equal(gateIdForLegacyRow({ type: "ENTRY" }), "entry");
    assert.equal(gateIdForLegacyRow({ type: "EXIT" }), "exit");
    assert.equal(gateIdForLegacyRow({ gate: "EXIT" }), "exit");
    assert.equal(gateIdForLegacyRow({ gateId: "side-door", type: "ENTRY" }), "side-door");
    assert.equal(gateIdForLegacyRow({ gateId: "BAD", type: "EXIT" }), "exit");
    assert.equal(legacyDirectionOf("exit"), "EXIT");
    assert.equal(legacyDirectionOf("side-door"), undefined);
  });

  it("a gate without a valid door opens the legacy single door", () => {
    assert.equal(doorIdOf({}), "main");
    assert.equal(doorIdOf({ doorId: "kho" }), "kho");
    assert.equal(doorIdOf({ doorId: "../x" }), "main");
  });
});

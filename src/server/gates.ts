/**
 * N gates (plan docs/plans/2026-09-29-scale-and-accuracy.md, Part E; owner
 * 2026-10-01: "go ahead for N gates"; decision 4: each gate has its own door).
 *
 * CONTRACT for the N-gate wave, plus the pure migration helpers every writer
 * shares. A gate is identified by a stable slug id; its DIRECTION (ENTRY/EXIT)
 * keeps today's reports, filters, CSV and webhook titles meaningful. The two
 * existing gates migrate to ids "entry" and "exit" and keep working unchanged.
 *
 * Nothing here decides access: matching stays global (every gate matches the
 * whole gallery; per-camera templates are what make a gate accurate), and a
 * gate only names which door its grants open.
 */

export type GateDirection = "ENTRY" | "EXIT";

/** Stable gate id: lowercase slug, 2-32 chars, starts with a letter. Never reused for another gate. */
export const GATE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Door ids follow the same rule. */
export const DOOR_ID_RE = GATE_ID_RE;
export const MAX_GATES = 16;
export const MAX_DOORS = 16;

/** The gates every existing installation has, in order. */
export const LEGACY_GATE_IDS = ["entry", "exit"] as const;
/** The single door of an existing installation. */
export const LEGACY_DOOR_ID = "main";

export const isGateId = (v: unknown): v is string => typeof v === "string" && GATE_ID_RE.test(v);
export const isDoorId = (v: unknown): v is string => typeof v === "string" && DOOR_ID_RE.test(v);
export const isGateDirection = (v: unknown): v is GateDirection => v === "ENTRY" || v === "EXIT";

/** Direction of a legacy gate id; undefined for any other id. */
export function legacyDirectionOf(gateId: string): GateDirection | undefined {
  return gateId === "entry" ? "ENTRY" : gateId === "exit" ? "EXIT" : undefined;
}

/**
 * Gate id of an access event / stranger face written before gate ids existed:
 * the old rows only carry the direction, and there were exactly two gates.
 */
export function gateIdForLegacyRow(row: { gateId?: string | null; type?: string | null; gate?: string | null }): string {
  if (isGateId(row.gateId)) return row.gateId;
  const dir = String(row.type ?? row.gate ?? "").toUpperCase();
  return dir === "EXIT" ? "exit" : "entry";
}

/**
 * Env names that used to be per direction become per gate id, upper-cased with
 * dashes as underscores: PIPELINE_MODE_ENTRY (gate "entry"), PIPELINE_MODE_SIDE_DOOR
 * (gate "side-door"). The two legacy gates therefore keep their existing names.
 */
export function gateEnvSuffix(gateId: string): string {
  return gateId.toUpperCase().replace(/-/g, "_");
}

/**
 * The configured gates of a stored camera config, in a stable order. Accepts
 * both the new shape ({ gates: [...] }) and the legacy one ({ entryGate,
 * exitGate }); `normalizeGate` is the caller's per-gate normaliser (streams,
 * watch, ROI) and receives the gate's id and direction. Invalid entries
 * (bad id, duplicate id, unknown direction) are dropped and reported.
 */
export function gatesFromStoredConfig<G extends Record<string, unknown>>(
  raw: unknown,
  normalizeGate: (gate: Record<string, unknown>, id: string, direction: GateDirection) => G,
): { gates: Array<G & { id: string; direction: GateDirection }>; dropped: string[] } {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const dropped: string[] = [];
  const out: Array<G & { id: string; direction: GateDirection }> = [];
  const seen = new Set<string>();
  const push = (g: Record<string, unknown>, id: string, direction: GateDirection) => {
    if (seen.has(id)) { dropped.push(`${id}: duplicate id`); return; }
    if (out.length >= MAX_GATES) { dropped.push(`${id}: more than ${MAX_GATES} gates`); return; }
    seen.add(id);
    out.push({ ...normalizeGate(g, id, direction), id, direction });
  };
  if (Array.isArray(cfg.gates)) {
    for (const item of cfg.gates as unknown[]) {
      const g = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      if (!g) { dropped.push("non-object gate"); continue; }
      const id = g.id;
      const direction = g.direction ?? g.gateType;
      if (!isGateId(id)) { dropped.push(`${String(id)}: invalid id`); continue; }
      if (!isGateDirection(direction)) { dropped.push(`${id}: invalid direction`); continue; }
      push(g, id, direction);
    }
  } else {
    if (cfg.entryGate && typeof cfg.entryGate === "object") push(cfg.entryGate as Record<string, unknown>, "entry", "ENTRY");
    if (cfg.exitGate && typeof cfg.exitGate === "object") push(cfg.exitGate as Record<string, unknown>, "exit", "EXIT");
  }
  return { gates: out, dropped };
}

/**
 * The legacy keys older clients read: entryGate/exitGate are views of gates
 * "entry" and "exit" when those exist. New clients use `gates`.
 */
export function legacyGateViews<G extends { id: string }>(gates: G[]): { entryGate?: G; exitGate?: G } {
  return { entryGate: gates.find((g) => g.id === "entry"), exitGate: gates.find((g) => g.id === "exit") };
}

/** A gate's door, falling back to the legacy single door. */
export function doorIdOf(gate: { doorId?: unknown }): string {
  return isDoorId(gate.doorId) ? gate.doorId : LEGACY_DOOR_ID;
}

/*
 * Also part of the contract (owners in plan section 11):
 *  - src/types.ts: GateConfig (GateStreamConfig + id, direction, label, doorId),
 *    CameraStreamsConfig.gates (entryGate/exitGate kept as legacy views),
 *    AccessLog.gateId, DoorConfig (DoorControllerConfig + id, label),
 *    DoorControllerConfig.doors, SmartLockState.doorId.
 *  - db (data-migrations): access_logs."gateId" VARCHAR(32) NULL (+ index with
 *    timestamp) - NO backfill writes: readers use gateIdForLegacyRow();
 *    AccessLogQuery.gateId filter (direction filter `type` unchanged);
 *    stranger_faces."gateId" VARCHAR(32) NULL; lock state per door
 *    (door_lock_states: doorId PK, state JSON) with the legacy smart_lock_state
 *    row read as door "main"; camera config and door config stay JSON blobs.
 *  - API (INT): GET/POST /api/camera-streams/config carry `gates` (and the
 *    legacy views); POST /api/gates, PUT/DELETE /api/gates/:gateId (admin);
 *    /api/camera-streams/:gateId/... for any configured gate (400 for unknown -
 *    never a silent fallback to "entry"); GET/POST /api/door-controller/config
 *    carry `doors`; GET /api/lock/state?doorId=, POST /api/lock/(un)lock {doorId}.
 *  - Pipeline: Gate = gate id string; direction travels separately.
 */

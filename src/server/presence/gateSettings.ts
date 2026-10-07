/**
 * Per-gate presence settings (P3b, contract docs/plans/2026-10-07-p3b-contract.md):
 * an admin's saved values override the .env defaults field by field; `null`
 * in a change clears that override.
 */
import { parseWorkingHours } from "./presenceConfig";

export type PresenceMode = "off" | "shadow" | "live";

export interface PresenceGateValues {
  mode: PresenceMode;
  workingHours: string;
  minSecondsWorking: number;
  minSecondsAfterHours: number;
  alertWindowSeconds: number;
  alertHoldSeconds: number;
}
export type PresenceGateField = keyof PresenceGateValues;
export const PRESENCE_GATE_FIELDS: readonly PresenceGateField[] = [
  "mode", "workingHours", "minSecondsWorking", "minSecondsAfterHours", "alertWindowSeconds", "alertHoldSeconds",
];
export type PresenceGateOverride = Partial<PresenceGateValues> & { updatedAt?: string; updatedBy?: string };

const RANGES: Record<"minSecondsWorking" | "minSecondsAfterHours" | "alertWindowSeconds" | "alertHoldSeconds", [number, number]> = {
  minSecondsWorking: [0.5, 60],
  minSecondsAfterHours: [0.5, 60],
  alertWindowSeconds: [30, 3600],
  alertHoldSeconds: [0, 30],
};

/** Saved values over .env defaults, with where each value came from. Invalid saved values are ignored. */
export function effectivePresenceGateSettings(
  defaults: PresenceGateValues,
  override: PresenceGateOverride | undefined,
): { values: PresenceGateValues; source: Record<PresenceGateField, "saved" | "env"> } {
  const values = { ...defaults };
  const source = Object.fromEntries(PRESENCE_GATE_FIELDS.map((f) => [f, "env"])) as Record<PresenceGateField, "saved" | "env">;
  for (const f of PRESENCE_GATE_FIELDS) {
    const v = override?.[f];
    if (v === undefined || v === null) continue;
    const checked = checkField(f, v);
    if ("error" in checked) continue;
    (values as any)[f] = checked.value;
    source[f] = "saved";
  }
  return { values, source };
}

function checkField(f: PresenceGateField, v: unknown): { value: unknown } | { error: string } {
  if (f === "mode") {
    return v === "off" || v === "shadow" || v === "live" ? { value: v } : { error: "Chế độ phải là off, shadow hoặc live" };
  }
  if (f === "workingHours") {
    const parsed = typeof v === "string" ? parseWorkingHours(v) : null;
    return parsed ? { value: `${parsed.start}-${parsed.end}` } : { error: "Giờ làm phải có dạng HH:MM-HH:MM (khác nhau)" };
  }
  const [min, max] = RANGES[f];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return { error: `${f} phải trong khoảng ${min}-${max}` };
  return { value: f === "alertWindowSeconds" ? Math.round(v) : Math.round(v * 10) / 10 };
}

/** Body of PUT /api/presence/settings/:gateId: any subset; null clears a saved value. */
export function parsePresenceGatePatch(body: unknown):
  | { ok: true; patch: Partial<Record<PresenceGateField, unknown>> }
  | { ok: false; error: string; field?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: Partial<Record<PresenceGateField, unknown>> = {};
  for (const key of Object.keys(b)) {
    if (!(PRESENCE_GATE_FIELDS as readonly string[]).includes(key)) return { ok: false, error: `Trường không hợp lệ: ${key.slice(0, 40)}`, field: key.slice(0, 40) };
    const f = key as PresenceGateField;
    if (b[f] === null) {
      patch[f] = null;
      continue;
    }
    const checked = checkField(f, b[f]);
    if ("error" in checked) return { ok: false, error: checked.error, field: f };
    patch[f] = checked.value;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Không có thay đổi nào" };
  return { ok: true, patch };
}

export function applyPresenceGatePatch(
  override: PresenceGateOverride | undefined,
  patch: Partial<Record<PresenceGateField, unknown>>,
  actor: string,
  at: string,
): PresenceGateOverride {
  const next: PresenceGateOverride = { ...(override || {}) };
  for (const [f, v] of Object.entries(patch)) {
    if (v === null) delete (next as any)[f];
    else (next as any)[f] = v;
  }
  next.updatedAt = at;
  next.updatedBy = actor;
  return next;
}

/** What a change needs: restart the stream (presence on/off), the detector (hours/minimums), or nothing. */
export function presenceSettingsImpact(before: PresenceGateValues, after: PresenceGateValues): { stream: boolean; detector: boolean } {
  const on = (m: PresenceMode) => m !== "off";
  return {
    stream: on(before.mode) !== on(after.mode),
    detector:
      before.workingHours !== after.workingHours ||
      before.minSecondsWorking !== after.minSecondsWorking ||
      before.minSecondsAfterHours !== after.minSecondsAfterHours,
  };
}

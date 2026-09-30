/**
 * Persisted shadow-engine results (plan docs/plans/2026-09-29-scale-and-accuracy.md, Part B).
 *
 * CONTRACT for the accuracy wave. The real-time pipeline in `shadow` mode
 * decides but never acts; until now its outcomes were only broadcast, so its
 * accuracy could not be compared with the door engine afterwards. Every
 * shadow outcome becomes one row here, together with the nearest door-engine
 * event on the same gate, so the engine card can show agreement, misses and
 * identity disagreements per gate.
 *
 * No images and no embeddings are stored here. Retention: owner decision
 * 2026-09-29, 30 days (SHADOW_RESULT_RETENTION_DAYS; 0 disables the purge).
 */
import { randomUUID } from "node:crypto";
import { envNumber } from "./env";

export type ShadowOutcomeKind = "employee" | "stranger" | "insufficient";

/**
 * How the shadow outcome relates to the door engine's event within
 * ±SHADOW_MATCH_WINDOW_MS on the same gate:
 *  - agree             both named the same employee, or both found nobody
 *  - shadow-only       shadow named an employee, the door engine granted nobody
 *  - legacy-only       the door engine granted, shadow found nobody usable
 *  - identity-mismatch both named an employee, a different one (look at these first)
 *  - none              no door-engine event in the window and shadow named nobody
 * A shadow employee with no door-engine event at all counts as shadow-only: the
 * door engine scans continuously and writes nothing when it recognises nobody,
 * so silence means it missed the person (a grant suppressed by its cooldown is
 * paired by the caller before this is called).
 */
export type ShadowAgreement = "agree" | "shadow-only" | "legacy-only" | "identity-mismatch" | "none";

export interface ShadowResultRecord {
  /** `SR-<uuid>` (<= 64 chars). */
  id: string;
  gate: string;
  trackId: string;
  outcome: ShadowOutcomeKind;
  employeeId?: string;
  /** Fused cosine and margin of the winning identity (employee outcomes; also the best candidate of a refused track when known). */
  fusedCosine?: number;
  margin?: number;
  runnerUpEmployeeId?: string;
  runnerUpCosine?: number;
  basis: string;
  fusionBasis?: string;
  meanCheckRefused?: boolean;
  framesSeen: number;
  framesUsed: number;
  firstSeenAt: string;
  firstUsableAt?: string;
  decidedAt: string;
  /** Nearest door-engine event on the same gate within the window, if any. */
  legacyLogId?: string;
  legacyStatus?: "GRANTED" | "DENIED";
  legacyEmployeeId?: string;
  agreement: ShadowAgreement;
  createdAt: string;
}

export interface ShadowAccuracySummary {
  gate: string;
  since: string;
  decisions: number;
  employees: number;
  strangers: number;
  insufficient: number;
  /** Tracks that never yielded a usable face (throughput / geometry problem, not a model one). */
  framesUsedZero: number;
  agree: number;
  shadowOnly: number;
  legacyOnly: number;
  identityMismatch: number;
  none: number;
  /** Median ms from first usable frame to decision (employee outcomes). */
  decisionLatencyP50Ms: number | null;
}

/** Implemented by SmartFaceDatabase for PostgreSQL, SQLite and the JSON fallback with the same semantics. */
export interface ShadowResultStore {
  /** Insert (ON CONFLICT DO NOTHING by id). True once the authoritative store has the row. */
  saveShadowResult(record: ShadowResultRecord): Promise<boolean>;
  /** Newest first by (decidedAt DESC, id DESC); cursor = last row returned; limit clamped to 1..100. */
  getShadowResultsPage(
    cursor: { decidedAt: string; id: string } | null,
    limit: number,
    filter?: { gate?: string; agreement?: ShadowAgreement; sinceIso?: string },
  ): Promise<{ results: ShadowResultRecord[]; hasMore: boolean }>;
  /** Per-gate counts since `sinceIso` (one row per gate that has results). */
  summarizeShadowResults(sinceIso: string): Promise<ShadowAccuracySummary[]>;
  /** Delete rows with decidedAt < cutoffIso. Returns rows deleted. */
  purgeShadowResults(cutoffIso: string): Promise<number>;
}

export const newShadowResultId = () => `SR-${randomUUID()}`;

/**
 * Door-engine events this close (either side) to the shadow decision count as
 * the same passage. 15 s: the door engine scans with a 3 s gap and a scan takes
 * 1.5-3 s, and live showed a genuine pair 12 s apart at 5 s (2026-09-30).
 */
export const SHADOW_MATCH_WINDOW_MS = 15000;

export function shadowResultRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber("SHADOW_RESULT_RETENTION_DAYS", 30, { min: 0, max: 3650, integer: true }, env);
}

/**
 * Classify a shadow outcome against the nearest door-engine event. Pure, so
 * the writer (server.ts) and the tests share one definition.
 */
export function classifyShadowAgreement(
  shadow: { outcome: ShadowOutcomeKind; employeeId?: string },
  legacy: { status: "GRANTED" | "DENIED"; employeeId?: string } | null,
): ShadowAgreement {
  if (!legacy) return shadow.outcome === "employee" && shadow.employeeId ? "shadow-only" : "none";
  const shadowEmp = shadow.outcome === "employee" ? shadow.employeeId : undefined;
  const legacyEmp = legacy.status === "GRANTED" ? legacy.employeeId : undefined;
  if (shadowEmp && legacyEmp) return shadowEmp === legacyEmp ? "agree" : "identity-mismatch";
  if (shadowEmp) return "shadow-only";
  if (legacyEmp) return "legacy-only";
  return "agree";
}

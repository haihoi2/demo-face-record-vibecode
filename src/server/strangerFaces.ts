/**
 * One stranger record per face (plan docs/plans/2026-09-29-per-face-stranger-observations.md).
 *
 * CONTRACT for the per-face wave. The access event stays one row per frame
 * (immutable history); every unrecognised face in that frame that passes the
 * stranger floors gets a StrangerFaceRecord with its own crop, box, scores and
 * embedding. Grouping, resolution and enrolment work on these records.
 *
 * Biometric data: `embedding` and `crop` never leave the server except the crop
 * through GET /api/strangers/faces/:id/image (viewer+). Retention: the crop and
 * the embedding are cleared after FACE_STRANGER_FACE_RETENTION_DAYS (owner:
 * 14 days) unless the face became part of an employee; the row stays as an
 * audit tombstone with `purgedAt`.
 */
import { randomUUID } from "node:crypto";
import { envNumber } from "./env";

export type StrangerFaceEngine = "legacy" | "pipeline";

export interface StrangerFaceRecord {
  /** `SF-<uuid>` (<= 64 chars). */
  id: string;
  /** The access event of the frame (DENIED, or GRANTED when an employee was in the frame). */
  logId: string;
  /** Order of the face within the frame (0-based). */
  faceIndex: number;
  /** Frame time, ISO UTC. */
  capturedAt: string;
  gate: "ENTRY" | "EXIT";
  /** Gate id (N gates); absent on faces from before gate ids: readers derive it from `gate`. */
  gateId?: string;
  streamId?: string;
  engine: StrangerFaceEngine;
  /** Pipeline track id, when the record comes from the real-time pipeline. */
  trackId?: string;
  /** Face box in source-frame pixels [x1, y1, x2, y2]. */
  box: [number, number, number, number];
  sourceWidth?: number;
  sourceHeight?: number;
  detectorScore: number;
  quality: number;
  edgeEnergy?: number;
  /** Recogniser feature strength (ArcFace norm before normalisation; blur measure). Stored since 2026-10-02. */
  featureNorm?: number;
  /** Shorter side of the box, px. */
  sizePx: number;
  /** L2-normalised embedding; absent once purged. */
  embedding?: number[];
  dims?: number;
  modelTag?: string;
  /** JPEG face crop (faceCrop.ts); only on writes and getStrangerFaceCrop, never in pages. */
  crop?: Buffer;
  createdAt: string;
  /** Set when retention cleared crop + embedding. */
  purgedAt?: string;
  /**
   * Recognised-face observation (plan 2026-09-29 Part C): set when the door
   * engine granted this face. Such rows are NOT strangers - grouping skips
   * them - but they feed camera adaptation (galleryAdaptation.ts). Same
   * retention as stranger faces.
   */
  employeeId?: string;
  matchCosine?: number;
  matchMargin?: number;
}

export interface StrangerFacePage {
  faces: StrangerFaceRecord[];
  hasMore: boolean;
}

/**
 * Persistence for stranger faces, implemented by SmartFaceDatabase (db.ts) for
 * PostgreSQL, SQLite and the JSON fallback with the same semantics.
 */
export interface StrangerFaceStore {
  /** Insert (ON CONFLICT DO NOTHING by id). Resolves true once the authoritative store has the rows. */
  saveStrangerFaces(faces: StrangerFaceRecord[]): Promise<boolean>;
  /**
   * Keyset page, newest first by (capturedAt DESC, id DESC); cursor = last row
   * returned. Excludes purged rows. Rows carry the embedding but NEVER the crop.
   * limit is clamped to 1..100.
   */
  getStrangerFacesPage(cursor: { capturedAt: string; id: string } | null, limit: number): Promise<StrangerFacePage>;
  /** Rows by id (any order, unknown ids skipped), embedding included, crop excluded; purged rows included. */
  getStrangerFacesByIds(ids: string[]): Promise<StrangerFaceRecord[]>;
  /** The JPEG crop, or undefined for an unknown or purged face. */
  getStrangerFaceCrop(id: string): Promise<Buffer | undefined>;
  /**
   * Clear crop + embedding (and set purgedAt) of every non-purged face with
   * capturedAt < cutoffIso whose id is not in keepIds. Returns rows purged.
   */
  purgeStrangerFaces(cutoffIso: string, keepIds: ReadonlySet<string>): Promise<number>;
  /**
   * Recognised-face observations (employeeId set, not purged) with capturedAt >= sinceIso,
   * newest first, embedding included, crop excluded; optional employee filter; limit clamped 1..2000.
   */
  getRecognisedFaceObservations(sinceIso: string, employeeId?: string, limit?: number): Promise<StrangerFaceRecord[]>;
}

/*
 * Also part of the contract, in db.ts (data-migrations):
 *  - StrangerResolutionRecord gains `faceIds?: string[]` (stored as a JSON array
 *    column "faceIds" DEFAULT '[]', sorted like logIds); commit/replay/restore
 *    compare faceIds as they compare logIds.
 *  - getRetiredStrangerObservationIds() returns `log:<id>` for logIds AND
 *    `face:<id>` for faceIds.
 *  - getStrangerCandidateLogsPage() excludes access logs that have at least one
 *    stranger_faces row (those are represented by their faces).
 */

export const LOG_OBSERVATION_PREFIX = "log:";
export const FACE_OBSERVATION_PREFIX = "face:";

export const faceObservationId = (faceId: string) => `${FACE_OBSERVATION_PREFIX}${faceId}`;
export const logObservationId = (logId: string) => `${LOG_OBSERVATION_PREFIX}${logId}`;

export const newStrangerFaceId = () => `SF-${randomUUID()}`;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Split `face:`/`log:` observation ids from a request. Unknown prefixes or
 * malformed ids make the whole list invalid (null): a resolution must name its
 * members exactly.
 */
export function parseObservationIds(raw: unknown): { logIds: string[]; faceIds: string[] } | null {
  if (!Array.isArray(raw)) return null;
  const logIds = new Set<string>();
  const faceIds = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    if (item.startsWith(FACE_OBSERVATION_PREFIX)) {
      const id = item.slice(FACE_OBSERVATION_PREFIX.length);
      if (!ID_RE.test(id)) return null;
      faceIds.add(id);
    } else if (item.startsWith(LOG_OBSERVATION_PREFIX)) {
      const id = item.slice(LOG_OBSERVATION_PREFIX.length);
      if (!ID_RE.test(id)) return null;
      logIds.add(id);
    } else {
      return null;
    }
  }
  return { logIds: [...logIds].sort(), faceIds: [...faceIds].sort() };
}

/** Owner decision 2026-09-29: unresolved stranger faces are kept 14 days. 0 disables the purge. */
export function strangerFaceRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber("FACE_STRANGER_FACE_RETENTION_DAYS", 14, { min: 0, max: 3650, integer: true }, env);
}

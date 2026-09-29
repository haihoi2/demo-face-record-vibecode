import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import {
  INITIAL_STORAGE_STATE,
  isConnectionError,
  recordConnectionError,
  recordQueryOk,
  StorageStatus,
  storageStatus,
  StorageTrackerState,
} from "./dbStatus";
import type { StrangerFacePage, StrangerFaceRecord, StrangerFaceStore } from "./strangerFaces";
import type { ShadowAccuracySummary, ShadowAgreement, ShadowResultRecord, ShadowResultStore } from "./shadowResults";
import type { FaceTemplate } from "../types";

// Safe dynamic loader for Node 22 native sqlite DatabaseSync
function getDatabaseSyncClass(): any {
  try {
    if (typeof require !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("node:sqlite").DatabaseSync;
    }
  } catch {}
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    return req("node:sqlite").DatabaseSync;
  } catch {}
  return null;
}

// Ensure data directory exists
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "smartface.db");

// Define interfaces matching server records
export interface EmployeeRecord {
  id: string;
  name: string;
  employeeCode: string;
  department: string;
  position: string;
  photoUrl: string;
  registeredAt: string;
  accessLevel: "ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED";
}

export interface AccessLogRecord {
  id: string;
  timestamp: string;
  type: "ENTRY" | "EXIT";
  status: "GRANTED" | "DENIED";
  employeeId?: string;
  employeeName?: string;
  employeeCode?: string;
  department?: string;
  photoSnapshot: string;
  confidence: number;
  livenessScore?: number;
  lockAction: string;
  doorName: string;
  reason?: string;
  /** L2-normalised stranger observation captured by the real ArcFace engine. */
  faceEmbedding?: number[];
  /** Persisted vector length; internal only and stripped from API responses. */
  faceEmbeddingDims?: number;
  /** Model identity for faceEmbedding. Embeddings with different tags are never compared. */
  faceEmbeddingModelTag?: string;
  /** Capture quality (0..1) of the persisted stranger observation. */
  faceEmbeddingQuality?: number;
  /**
   * Capture time of the frame the decision was made on (ISO-8601 UTC). Server-owned;
   * `timestamp` stays the time the event was written. Undefined on older rows.
   */
  capturedAt?: string;
  /** Tracker id of the passage (<= 64 chars). Undefined on older rows. */
  trackId?: string;
  /** NVR recording channel of the gate at event time (<= 16 chars). Undefined on older rows. */
  recordingChannel?: string;
}

/** Same limits as the PostgreSQL columns (VARCHAR 64 / 16), enforced here for SQLite and JSON too. */
const TRACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RECORDING_CHANNEL_RE = /^[A-Za-z0-9_-]{1,16}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
/** 2000-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z: toISOString() stays 24 characters. */
const CAPTURED_AT_MIN_MS = Date.UTC(2000, 0, 1);
const CAPTURED_AT_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** What getAccessLogMetaById returns: time, gate and trace of an event, never its image or face data. */
export type AccessLogMeta = Pick<AccessLogRecord, "id" | "timestamp" | "type" | "status" | "capturedAt" | "trackId" | "recordingChannel">;

export interface AccessLogTrace {
  capturedAt?: string;
  trackId?: string;
  recordingChannel?: string;
}

/**
 * Validates the optional trace fields of an access event before they are stored.
 *
 * The event itself is a security fact and must never be lost because a trace
 * value is malformed: an invalid value is dropped (stored as NULL) and named in
 * `rejected`. It is never truncated (a cut track id could name another passage)
 * and never allowed to fail the insert (a PostgreSQL VARCHAR overflow would).
 * `capturedAt` is normalised to `Date#toISOString()` (UTC, milliseconds).
 */
export function normalizeAccessLogTrace(input: {
  capturedAt?: unknown;
  trackId?: unknown;
  recordingChannel?: unknown;
}): AccessLogTrace & { rejected: Array<keyof AccessLogTrace> } {
  const out: AccessLogTrace & { rejected: Array<keyof AccessLogTrace> } = { rejected: [] };
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";

  if (present(input.capturedAt)) {
    const raw = typeof input.capturedAt === "string" ? input.capturedAt.trim() : "";
    const ms = ISO_INSTANT_RE.test(raw) ? Date.parse(raw) : NaN;
    if (Number.isFinite(ms) && ms >= CAPTURED_AT_MIN_MS && ms <= CAPTURED_AT_MAX_MS) {
      out.capturedAt = new Date(ms).toISOString();
    } else {
      out.rejected.push("capturedAt");
    }
  }
  if (present(input.trackId)) {
    if (typeof input.trackId === "string" && TRACK_ID_RE.test(input.trackId)) out.trackId = input.trackId;
    else out.rejected.push("trackId");
  }
  if (present(input.recordingChannel)) {
    const raw = typeof input.recordingChannel === "number" && Number.isSafeInteger(input.recordingChannel) && input.recordingChannel >= 0
      ? String(input.recordingChannel)
      : input.recordingChannel;
    if (typeof raw === "string" && RECORDING_CHANNEL_RE.test(raw)) out.recordingChannel = raw;
    else out.rejected.push("recordingChannel");
  }
  return out;
}

/** Longest an access-log read on PostgreSQL waits for this process's own in-flight inserts. */
const ACCESS_LOG_READ_YOUR_WRITES_MS = 2_000;

/** Row value (NULL/empty on old rows) -> optional field. */
const optionalText = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

/** capturedAt, trackId, recordingChannel as bind parameters (NULL when absent or invalid). */
function accessLogTraceParams(log: AccessLogTrace): [string | null, string | null, string | null] {
  const t = normalizeAccessLogTrace(log);
  return [t.capturedAt ?? null, t.trackId ?? null, t.recordingChannel ?? null];
}

export interface SmartLockStateRecord {
  lockId: string;
  doorName: string;
  state: "LOCKED" | "UNLOCKED" | "UNLOCKING" | "LOCKING";
  isLocked: boolean;
  batteryLevel: number;
  signalDbm: number;
  firmwareVersion: string;
  lastActionAt: string;
  lastActionBy: string;
  autoRelockSeconds: number;
  remainingRelockSeconds: number;
  status: "ONLINE" | "OFFLINE";
}

export interface WebhookConfigRecord {
  enabled: boolean;
  url: string;
  gateInTitle: string;
  gateOutTitle: string;
  includeEmployeeCode: boolean;

  // ---- Stranger ("người lạ") alert. All optional: configs persisted before
  // these existed must keep loading, falling back to DEFAULT_STRANGER_WEBHOOK_CONFIG.
  strangerAlertEnabled?: boolean;
  strangerTitle?: string;
  strangerLinkLabel?: string;
  /** Public base URL used to build the click-through deep link. No trailing slash. */
  appBaseUrl?: string;
  strangerCooldownSeconds?: number;
}

/** Defaults for the optional stranger-alert half of the webhook config. */
export const DEFAULT_STRANGER_WEBHOOK_CONFIG = {
  strangerAlertEnabled: true,
  strangerTitle: "[[CẢNH BÁO NGƯỜI LẠ]]",
  strangerLinkLabel: "Xem cụm ảnh người lạ",
  appBaseUrl: "",
  strangerCooldownSeconds: 60,
};

/** The stranger-alert keys, persisted together as one JSON blob column. */
const STRANGER_WEBHOOK_KEYS = [
  "strangerAlertEnabled",
  "strangerTitle",
  "strangerLinkLabel",
  "appBaseUrl",
  "strangerCooldownSeconds",
] as const;

/**
 * Fill in any missing stranger-alert field from the defaults, so an OLD
 * persisted config (written before these fields existed, or a row whose blob
 * column is still NULL) still loads with sane values. Never touches
 * url / titles / enabled - those keep whatever was persisted.
 */
export function withStrangerWebhookDefaults(
  config: WebhookConfigRecord,
  defaultConfig?: Partial<WebhookConfigRecord>
): WebhookConfigRecord {
  const d = { ...DEFAULT_STRANGER_WEBHOOK_CONFIG, ...(defaultConfig || {}) };
  const cooldown = config.strangerCooldownSeconds;
  const fallbackCooldown =
    typeof d.strangerCooldownSeconds === "number" && Number.isFinite(d.strangerCooldownSeconds)
      ? d.strangerCooldownSeconds
      : DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerCooldownSeconds;
  return {
    ...config,
    strangerAlertEnabled:
      typeof config.strangerAlertEnabled === "boolean"
        ? config.strangerAlertEnabled
        : typeof d.strangerAlertEnabled === "boolean"
          ? d.strangerAlertEnabled
          : DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerAlertEnabled,
    strangerTitle: config.strangerTitle || d.strangerTitle || DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerTitle,
    strangerLinkLabel:
      config.strangerLinkLabel || d.strangerLinkLabel || DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerLinkLabel,
    appBaseUrl: typeof config.appBaseUrl === "string" ? config.appBaseUrl : (d.appBaseUrl || ""),
    strangerCooldownSeconds:
      typeof cooldown === "number" && Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : fallbackCooldown,
  };
}

/** Serialise the stranger-alert fields for the `strangerConfig` blob column. */
function serializeStrangerWebhookConfig(config: WebhookConfigRecord): string {
  const blob: Record<string, unknown> = {};
  for (const key of STRANGER_WEBHOOK_KEYS) {
    if (config[key] !== undefined) blob[key] = config[key];
  }
  return JSON.stringify(blob);
}

/** Read the `strangerConfig` blob column back; tolerates NULL / corrupt JSON. */
function parseStrangerWebhookConfig(raw: unknown): Partial<WebhookConfigRecord> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Partial<WebhookConfigRecord>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Partial<WebhookConfigRecord>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface WebhookLogRecord {
  id: string;
  timestamp: string;
  url: string;
  method: string;
  payload: any;
  statusCode?: number;
  statusText?: string;
  responseBody?: string;
  success: boolean;
  error?: string;
  scanType: "ENTRY" | "EXIT";
  userName: string;
}

export interface MobileNotificationRecord {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  type: "SUCCESS" | "WARNING" | "INFO" | "ALERT";
  read: boolean;
  employeeId?: string;
  employeeName?: string;
}

export type DoorAuthHeaderType = "BEARER" | "API_KEY" | "CUSTOM_HEADER" | "QUERY_PARAM";

export interface DoorControllerConfigRecord {
  enabled: boolean;
  apiUrl: string;
  apiToken: string;
  authHeaderType: DoorAuthHeaderType;
  customHeaderName?: string;
  openMethod: "POST" | "GET" | "PUT";
  closeMethod: "POST" | "GET" | "PUT";
  openPayloadTemplate?: string;
  closePayloadTemplate?: string;
  pulseDurationSeconds: number;
  triggerOnFaceRecognition: boolean;
  triggerOnManualUnlock: boolean;
}

export interface DoorApiLogRecord {
  id: string;
  timestamp: string;
  action: "OPEN" | "CLOSE";
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  statusCode?: number;
  statusText?: string;
  responseBody?: string;
  success: boolean;
  error?: string;
  durationMs: number;
  triggeredBy: string;
}

// Off, with no URL, until an admin saves a real controller on the Door
// Controller page. The previous default was enabled and pointed at
// https://smartlock.eton.vn/api/door/control - a hostname that does not resolve -
// so every fresh instance (a new install, an isolated test gateway, a CI run)
// dispatched real OPEN/CLOSE commands for "CỔNG CHÍNH" to it, unauthenticated.
export const DEFAULT_DOOR_CONTROLLER_CONFIG: DoorControllerConfigRecord = {
  enabled: false,
  apiUrl: "",
  apiToken: "" /* set via the Door Controller page; never ship a real token in source */,
  authHeaderType: "BEARER",
  customHeaderName: "X-Door-Token",
  openMethod: "POST",
  closeMethod: "POST",
  openPayloadTemplate: JSON.stringify({ action: "OPEN", doorId: "CỔNG CHÍNH", pulseDuration: 6 }, null, 2),
  closePayloadTemplate: JSON.stringify({ action: "CLOSE", doorId: "CỔNG CHÍNH" }, null, 2),
  pulseDurationSeconds: 6,
  triggerOnFaceRecognition: true,
  triggerOnManualUnlock: true,
};

export type CameraSourceTypeRecord = "CLIENT_UVC" | "RTSP" | "HTTP_MJPEG" | "BACKEND_UVC";

/**
 * One video source attached to a gate (mirror of `GateStreamSource` in
 * src/types.ts). A gate may carry several; the enabled stream with the lowest
 * `priority` is the PRIMARY one and is mirrored onto the gate's legacy fields.
 */
export interface GateStreamSourceRecord {
  id: string;
  label: string;
  sourceType: CameraSourceTypeRecord;
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  httpUrl?: string;
  uvcDeviceId?: string;
  uvcDeviceLabel?: string;
  backendDevicePath?: string;
  resolution?: "1920x1080" | "1280x720" | "640x480" | "AUTO";
  fps?: number;
  enabled: boolean;
  priority: number;
  /** Gate area as picture fractions (pipeline ROI); null/absent = whole picture. */
  roi?: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Server-side auto-scan ("watch") for one gate (mirror of `GateWatchConfig` in
 * src/types.ts). Persisted inside the `cameraStreamsConfig` JSON blob, so no
 * schema change: blobs written before this field simply lack it and the server
 * normalisation fills in the default (disabled).
 */
export interface GateWatchConfigRecord {
  enabled: boolean;
  intervalSeconds: number;
  frames: number;
}

export interface GateStreamConfigRecord {
  gateType: "ENTRY" | "EXIT";
  name: string;
  enabled: boolean;
  /** Backend auto-scan for this gate. Absent in older blobs -> disabled. */
  watch?: GateWatchConfigRecord;
  /** Real-time pipeline mode set in the app (admin); absent = PIPELINE_MODE_<GATE> from the environment. */
  pipelineMode?: "legacy" | "shadow" | "live";
  /**
   * All video sources of the gate. Optional in persisted blobs written before
   * multi-stream support: the server derives one stream from the legacy fields
   * below and always keeps those fields mirrored from the primary stream.
   */
  streams?: GateStreamSourceRecord[];
  // ---- Legacy single-stream fields (mirror of the primary stream) ----
  sourceType: CameraSourceTypeRecord;
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  httpUrl?: string;
  uvcDeviceId?: string;
  uvcDeviceLabel?: string;
  resolution?: "1920x1080" | "1280x720" | "640x480" | "AUTO";
  fps?: number;
  backendDevicePath?: string;
  autoStart: boolean;
  reconnectIntervalSeconds: number;
}

/** One enrolled face embedding (Phase 1 real engine). Embedding is L2-normalised. */
export interface FaceTemplateRecord {
  id: string;
  employeeId: string;
  embedding: number[];
  dims: number;
  modelTag: string;
  /**
   * "adaptation" (accuracy wave): derived automatically from a confident
   * door-engine grant on one camera (galleryAdaptation.ts); listed and
   * deletable like any other template.
   */
  source: FaceTemplateSource;
  quality: number;
  capturedAt: string;
  sourceLogId?: string;
  streamId?: string;
}

/**
 * The source union is defined once, in src/types.ts (FaceTemplate.source), so
 * the gallery (`buildGallery(db.getFaceTemplates())` in server.ts) and the
 * store agree. Adding "adaptation" there widens this type too. Nothing in the
 * stores validates or constrains the value (VARCHAR(32) / TEXT, no CHECK), so
 * "adaptation" templates round-trip on every store already.
 */
export type FaceTemplateSource = FaceTemplate["source"];

/** Templates per employee per camera per source (coverage indicator, adaptation cap). */
export interface FaceTemplateCount {
  employeeId: string;
  /** null for templates without a camera (photo enrolment). */
  streamId: string | null;
  source: FaceTemplateSource;
  count: number;
}

/**
 * An operator account. `passwordHash` never leaves the server: every API
 * response goes through publicUser() in server.ts, which drops it.
 */
export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "operator" | "viewer";
  passwordHash: string;
  disabled: boolean;
  /** Bumped on password reset, role change or disable - invalidates issued sessions. */
  sessionVersion: number;
  failedLogins: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/** One managed value of the organisation catalog (a department or a position). */
export interface OrgEntryRecord {
  id: string;
  name: string;
  description: string;
  /** Inactive entries stay on existing employees but are not offered for new ones. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface OrgCatalogRecord {
  departments: OrgEntryRecord[];
  positions: OrgEntryRecord[];
}

/** Filters for the access history; every field optional, all combined with AND. */
export interface AccessLogQuery {
  /** Case-insensitive match on name, employee code, department or reason. */
  q?: string;
  status?: "GRANTED" | "DENIED";
  type?: "ENTRY" | "EXIT";
  /** ISO instant, inclusive. */
  from?: string;
  /** ISO instant, exclusive. */
  to?: string;
}

export interface AccessLogHourBucket {
  hour: number;
  grantedEntries: number;
  deniedEntries: number;
  totalEntries: number;
  exits: number;
  totalScans: number;
}

export interface AccessLogStats {
  total: number;
  granted: number;
  denied: number;
  entries: number;
  exits: number;
  /** 24 buckets, hour of day in the site's time zone. */
  byHour: AccessLogHourBucket[];
  grantedEntriesByDepartment: Array<{ name: string; count: number }>;
}

const emptyHours = (): AccessLogHourBucket[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, grantedEntries: 0, deniedEntries: 0, totalEntries: 0, exits: 0, totalScans: 0 }));

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Hour of day of an ISO instant in `timeZone`, or -1 when unparseable. */
function hourIn(iso: string, timeZone: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(t));
  return Number.isInteger(h) && h >= 0 && h < 24 ? h : -1;
}

function matchesAccessLogQuery(log: AccessLogRecord, f: AccessLogQuery): boolean {
  if (f.status && log.status !== f.status) return false;
  if (f.type && log.type !== f.type) return false;
  if (f.from && !(log.timestamp >= f.from)) return false;
  if (f.to && !(log.timestamp < f.to)) return false;
  if (f.q) {
    const term = f.q.toLocaleLowerCase("vi");
    const hay = [log.employeeName, log.employeeCode, log.department, log.reason].map((v) => String(v || "").toLocaleLowerCase("vi"));
    if (!hay.some((v) => v.includes(term))) return false;
  }
  return true;
}

function accumulateStats(rows: Array<Pick<AccessLogRecord, "timestamp" | "type" | "status" | "department">>, timeZone: string): AccessLogStats {
  const stats: AccessLogStats = { total: 0, granted: 0, denied: 0, entries: 0, exits: 0, byHour: emptyHours(), grantedEntriesByDepartment: [] };
  const departments = new Map<string, number>();
  for (const r of rows) {
    stats.total += 1;
    if (r.status === "GRANTED") stats.granted += 1; else if (r.status === "DENIED") stats.denied += 1;
    if (r.type === "ENTRY") stats.entries += 1; else if (r.type === "EXIT") stats.exits += 1;
    const h = hourIn(r.timestamp, timeZone);
    if (h >= 0) {
      const b = stats.byHour[h];
      b.totalScans += 1;
      if (r.type === "ENTRY") {
        b.totalEntries += 1;
        if (r.status === "GRANTED") b.grantedEntries += 1; else b.deniedEntries += 1;
      } else if (r.type === "EXIT") b.exits += 1;
    }
    if (r.type === "ENTRY" && r.status === "GRANTED") {
      const name = r.department || "Khác";
      departments.set(name, (departments.get(name) || 0) + 1);
    }
  }
  stats.grantedEntriesByDepartment = [...departments].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return stats;
}

export type StrangerResolutionAction = "QUICK_REGISTER" | "MERGE" | "DISMISS" | "RESTORE";

export interface StrangerResolutionRecord {
  id: string;
  clusterId: string;
  action: StrangerResolutionAction;
  employeeId?: string;
  actor: string;
  resolvedAt: string;
  logIds: string[];
  /**
   * stranger_faces ids this adjudication covers (per-face wave). Stored sorted
   * like logIds; rows written before the column existed read back as [].
   */
  faceIds?: string[];
  sourceLogId?: string;
  metadata?: Record<string, unknown>;
}

export interface StrangerResolutionCommit {
  resolution: StrangerResolutionRecord;
  employee?: EmployeeRecord;
  employeePhotoUpdate?: { employeeId: string; photoUrl: string };
  faceTemplate?: FaceTemplateRecord;
}

export type StrangerResolutionCommitResult =
  | { status: "created"; resolution: StrangerResolutionRecord }
  | { status: "replay"; resolution: StrangerResolutionRecord }
  | { status: "conflict"; resolution: StrangerResolutionRecord };

// float32 little-endian <-> number[] for BYTEA/BLOB storage of embeddings
function embeddingToBuffer(e: number[]): Buffer {
  return Buffer.from(new Float32Array(e).buffer);
}
function bufferToEmbedding(b: Buffer | Uint8Array | null | undefined, dims?: number): number[] {
  if (!b || b.length === 0) return [];
  const u8 = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const f = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
  const out = Array.from(f);
  return dims && out.length > dims ? out.slice(0, dims) : out;
}
function rowToFaceTemplate(r: any): FaceTemplateRecord {
  return {
    id: r.id,
    employeeId: r.employeeId,
    embedding: bufferToEmbedding(r.embedding, r.dims),
    dims: r.dims,
    modelTag: r.modelTag,
    source: r.source,
    quality: Number(r.quality) || 0,
    capturedAt: r.capturedAt,
    sourceLogId: r.sourceLogId || undefined,
    streamId: r.streamId || undefined,
  };
}

function rowToAccessLog(r: any): AccessLogRecord {
  return {
    ...r,
    confidence: Number(r.confidence) || 0,
    livenessScore: r.livenessScore == null ? undefined : Number(r.livenessScore),
    faceEmbedding: bufferToEmbedding(r.faceEmbedding, r.faceEmbeddingDims),
    faceEmbeddingModelTag: r.faceEmbeddingModelTag || undefined,
    faceEmbeddingQuality: r.faceEmbeddingQuality == null ? undefined : Number(r.faceEmbeddingQuality),
    capturedAt: optionalText(r.capturedAt),
    trackId: optionalText(r.trackId),
    recordingChannel: optionalText(r.recordingChannel),
  } as AccessLogRecord;
}

function rowToStrangerResolution(r: any): StrangerResolutionRecord {
  const parse = (value: unknown, fallback: unknown) => {
    if (value == null) return fallback;
    if (typeof value === "object") return value;
    try { return JSON.parse(String(value)); } catch { return fallback; }
  };
  return {
    id: String(r.id),
    clusterId: String(r.clusterId),
    action: r.action,
    employeeId: r.employeeId || undefined,
    actor: r.actor || "operator",
    resolvedAt: r.resolvedAt,
    logIds: parse(r.logIds, []) as string[],
    faceIds: resolutionFaceIds(parse(r.faceIds, [])),
    sourceLogId: r.sourceLogId || undefined,
    metadata: parse(r.metadata, {}) as Record<string, unknown>,
  };
}

/** faceIds of a resolution: sorted strings; absent (rows older than the column) or malformed -> []. */
function resolutionFaceIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").sort() : [];
}

/** A resolution as held in memory and returned to callers: own arrays, faceIds always present. */
function copyResolution(record: StrangerResolutionRecord): StrangerResolutionRecord {
  return {
    ...record,
    logIds: [...record.logIds],
    faceIds: resolutionFaceIds(record.faceIds),
    metadata: { ...(record.metadata || {}) },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sameSortedIds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  const left = [...(a || [])].sort();
  const right = [...(b || [])].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

/**
 * Same adjudication request? logIds and faceIds are compared as sets in sorted
 * order (a missing faceIds is []), so a replay naming other members - logs or
 * faces - is a conflict, never a replay.
 */
export function sameResolutionIntent(a: StrangerResolutionRecord, b: StrangerResolutionRecord): boolean {
  return a.clusterId === b.clusterId && a.action === b.action &&
    (a.employeeId || "") === (b.employeeId || "") &&
    (a.sourceLogId || "") === (b.sourceLogId || "") &&
    sameSortedIds(a.logIds, b.logIds) &&
    sameSortedIds(a.faceIds, b.faceIds) &&
    stableJson(a.metadata?.intent ?? null) === stableJson(b.metadata?.intent ?? null);
}

// ================= STRANGER FACES (per-face wave) =================
// One row per unrecognised face of an access event (src/server/strangerFaces.ts).
// Limits mirror the PostgreSQL columns so SQLite and JSON reject what
// PostgreSQL would, instead of storing a row PostgreSQL could never hold.

const STRANGER_FACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** access_logs.id is VARCHAR(64); printable ASCII, no spaces. */
const ACCESS_LOG_ID_RE = /^[\x21-\x7E]{1,64}$/;
const STREAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const STRANGER_FACE_MAX_DIMS = 4096;
/** A face crop is 20-40 KB (faceCrop.ts); anything near this is not a face crop. */
export const STRANGER_FACE_MAX_CROP_BYTES = 2 * 1024 * 1024;
const STRANGER_FACE_MAX_INDEX = 1000;
/** employees.id is VARCHAR(64); printable ASCII, no spaces (EMP-<uuid> today, imported ids tolerated). */
const EMPLOYEE_ID_RE = /^[\x21-\x7E]{1,64}$/;

/** A validated face as the stores hold it (crop as bytes, embedding as float32 LE bytes). */
interface StrangerFaceRow {
  id: string;
  logId: string;
  faceIndex: number;
  capturedAt: string;
  gate: "ENTRY" | "EXIT";
  streamId: string | null;
  engine: "legacy" | "pipeline";
  trackId: string | null;
  box: [number, number, number, number];
  sourceWidth: number | null;
  sourceHeight: number | null;
  detectorScore: number;
  quality: number;
  edgeEnergy: number | null;
  sizePx: number;
  embedding: Buffer | null;
  dims: number | null;
  modelTag: string | null;
  crop: Buffer | null;
  createdAt: string;
  /** Recognised-face observation (accuracy wave): the employee the door engine granted, with its match scores. */
  employeeId: string | null;
  matchCosine: number | null;
  matchMargin: number | null;
}

/** JSON-fallback shape: embedding as numbers, crop as base64 (a Buffer would serialise as a byte list). */
interface StrangerFaceJson extends Omit<StrangerFaceRecord, "crop"> {
  crop?: string;
}

const normIso = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return normalizeAccessLogTrace({ capturedAt: value }).capturedAt;
};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Within what a PostgreSQL REAL holds comfortably (scores are 0..1; this only stops overflow errors). */
const realValue = (v: unknown): v is number => finite(v) && Math.abs(v) <= 1e6;
const MAX_PIXELS = 100_000;
const optionalInt = (v: unknown, max: number): number | null =>
  finite(v) && v >= 0 && v <= max ? Math.round(v) : null;

/**
 * Validate one face for storage. Identity, time, gate, engine, box and scores
 * are required: without them the row cannot be paged, grouped or audited, so
 * the batch is refused. Descriptive fields (streamId, trackId, frame size,
 * edge energy) that are malformed are stored as NULL, never truncated.
 * `purgedAt` on input is ignored: a new face is never born purged.
 */
export function normalizeStrangerFace(face: StrangerFaceRecord): { row?: StrangerFaceRow; error?: string } {
  if (!face || typeof face !== "object") return { error: "not-an-object" };
  if (typeof face.id !== "string" || !STRANGER_FACE_ID_RE.test(face.id)) return { error: "id" };
  if (typeof face.logId !== "string" || !ACCESS_LOG_ID_RE.test(face.logId)) return { error: "logId" };
  if (!Number.isSafeInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex > STRANGER_FACE_MAX_INDEX) return { error: "faceIndex" };
  const capturedAt = normIso(face.capturedAt);
  if (!capturedAt) return { error: "capturedAt" };
  if (face.gate !== "ENTRY" && face.gate !== "EXIT") return { error: "gate" };
  if (face.engine !== "legacy" && face.engine !== "pipeline") return { error: "engine" };
  if (!Array.isArray(face.box) || face.box.length !== 4 || !face.box.every(finite)) return { error: "box" };
  if (!realValue(face.detectorScore) || !realValue(face.quality) || !finite(face.sizePx) || face.sizePx < 0 || face.sizePx > MAX_PIXELS) {
    return { error: "scores" };
  }
  let embedding: Buffer | null = null;
  let dims: number | null = null;
  if (face.embedding !== undefined && face.embedding !== null) {
    if (!Array.isArray(face.embedding) || face.embedding.length > STRANGER_FACE_MAX_DIMS || !face.embedding.every(realValue)) {
      return { error: "embedding" };
    }
    if (face.embedding.length) {
      embedding = embeddingToBuffer(face.embedding);
      dims = face.embedding.length;
    }
  }
  let modelTag: string | null = null;
  if (face.modelTag !== undefined && face.modelTag !== null && face.modelTag !== "") {
    if (typeof face.modelTag !== "string" || !MODEL_TAG_RE.test(face.modelTag)) return { error: "modelTag" };
    modelTag = face.modelTag;
  }
  let crop: Buffer | null = null;
  if (face.crop !== undefined && face.crop !== null) {
    if (!Buffer.isBuffer(face.crop) || face.crop.length > STRANGER_FACE_MAX_CROP_BYTES) return { error: "crop" };
    if (face.crop.length) crop = Buffer.from(face.crop);
  }
  // A recognised-face observation names the granted employee and carries the
  // scores camera adaptation filters on; without both scores it could never be
  // used, so it is refused rather than stored half-described. A stranger face
  // (no employeeId) stores no match scores.
  let employeeId: string | null = null;
  let matchCosine: number | null = null;
  let matchMargin: number | null = null;
  if (face.employeeId !== undefined && face.employeeId !== null && face.employeeId !== "") {
    if (typeof face.employeeId !== "string" || !EMPLOYEE_ID_RE.test(face.employeeId)) return { error: "employeeId" };
    if (!realValue(face.matchCosine) || !realValue(face.matchMargin)) return { error: "matchScores" };
    employeeId = face.employeeId;
    matchCosine = face.matchCosine;
    matchMargin = face.matchMargin;
  }
  return {
    row: {
      id: face.id,
      logId: face.logId,
      faceIndex: face.faceIndex,
      capturedAt,
      gate: face.gate,
      streamId: typeof face.streamId === "string" && STREAM_ID_RE.test(face.streamId) ? face.streamId : null,
      engine: face.engine,
      trackId: typeof face.trackId === "string" && TRACK_ID_RE.test(face.trackId) ? face.trackId : null,
      box: [face.box[0], face.box[1], face.box[2], face.box[3]],
      sourceWidth: optionalInt(face.sourceWidth, MAX_PIXELS),
      sourceHeight: optionalInt(face.sourceHeight, MAX_PIXELS),
      detectorScore: face.detectorScore,
      quality: face.quality,
      edgeEnergy: realValue(face.edgeEnergy) ? face.edgeEnergy : null,
      sizePx: Math.round(face.sizePx),
      embedding,
      dims,
      modelTag,
      crop,
      createdAt: normIso(face.createdAt) || new Date().toISOString(),
      employeeId,
      matchCosine,
      matchMargin,
    },
  };
}

const optionalNumber = (v: unknown): number | undefined => (v == null || v === "" ? undefined : Number(v));

function parseBox(value: unknown): [number, number, number, number] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return Array.isArray(raw) && raw.length === 4 ? (raw.map(Number) as [number, number, number, number]) : [0, 0, 0, 0];
}

/** A PostgreSQL/SQLite stranger_faces row -> record. Never carries the crop. */
function rowToStrangerFace(r: any): StrangerFaceRecord {
  const embedding = r.embedding ? bufferToEmbedding(r.embedding, r.dims == null ? undefined : Number(r.dims)) : [];
  const out: StrangerFaceRecord = {
    id: String(r.id),
    logId: String(r.logId),
    faceIndex: Number(r.faceIndex),
    capturedAt: String(r.capturedAt),
    gate: r.gate,
    streamId: optionalText(r.streamId),
    engine: r.engine,
    trackId: optionalText(r.trackId),
    box: parseBox(r.box),
    sourceWidth: optionalNumber(r.sourceWidth),
    sourceHeight: optionalNumber(r.sourceHeight),
    detectorScore: Number(r.detectorScore),
    quality: Number(r.quality),
    edgeEnergy: optionalNumber(r.edgeEnergy),
    sizePx: Number(r.sizePx),
    embedding: embedding.length ? embedding : undefined,
    dims: optionalNumber(r.dims),
    modelTag: optionalText(r.modelTag),
    createdAt: String(r.createdAt),
    purgedAt: optionalText(r.purgedAt),
    employeeId: optionalText(r.employeeId),
    matchCosine: optionalNumber(r.matchCosine),
    matchMargin: optionalNumber(r.matchMargin),
  };
  for (const key of Object.keys(out) as Array<keyof StrangerFaceRecord>) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function strangerFaceRowToJson(row: StrangerFaceRow): StrangerFaceJson {
  const out: StrangerFaceJson = {
    ...rowToStrangerFace({ ...row, box: row.box, purgedAt: null }),
    crop: row.crop ? row.crop.toString("base64") : undefined,
  };
  if (out.crop === undefined) delete out.crop;
  return out;
}

/** JSON-fallback face -> record, without the crop. */
function jsonToStrangerFace(face: StrangerFaceJson): StrangerFaceRecord {
  const { crop: _crop, embedding, ...rest } = face;
  const out: StrangerFaceRecord = { ...rest, box: [...face.box] as [number, number, number, number] };
  if (embedding?.length) out.embedding = [...embedding];
  return out;
}

const STRANGER_FACE_COLUMNS_PG = `id, "logId", "faceIndex", "capturedAt", gate, "streamId", engine, "trackId", box,
  "sourceWidth", "sourceHeight", "detectorScore", quality, "edgeEnergy", "sizePx", embedding, dims, "modelTag",
  "createdAt", "purgedAt", "employeeId", "matchCosine", "matchMargin"`;
const STRANGER_FACE_COLUMNS_SQLITE = `id, logId, faceIndex, capturedAt, gate, streamId, engine, trackId, box,
  sourceWidth, sourceHeight, detectorScore, quality, edgeEnergy, sizePx, embedding, dims, modelTag,
  createdAt, purgedAt, employeeId, matchCosine, matchMargin`;

/** Insert column lists (no purgedAt: a new face is never born purged). 23 parameters. */
const STRANGER_FACE_INSERT_COLUMNS_PG = `id, "logId", "faceIndex", "capturedAt", gate, "streamId", engine, "trackId", box,
  "sourceWidth", "sourceHeight", "detectorScore", quality, "edgeEnergy", "sizePx", embedding, dims, "modelTag",
  crop, "createdAt", "employeeId", "matchCosine", "matchMargin"`;
const STRANGER_FACE_INSERT_COLUMNS_SQLITE = `id, logId, faceIndex, capturedAt, gate, streamId, engine, trackId, box,
  sourceWidth, sourceHeight, detectorScore, quality, edgeEnergy, sizePx, embedding, dims, modelTag,
  crop, createdAt, employeeId, matchCosine, matchMargin`;
const STRANGER_FACE_INSERT_PARAM_COUNT = 23;

const strangerFaceInsertParams = (f: StrangerFaceRow, box: unknown): unknown[] => [
  f.id, f.logId, f.faceIndex, f.capturedAt, f.gate, f.streamId, f.engine, f.trackId, box,
  f.sourceWidth, f.sourceHeight, f.detectorScore, f.quality, f.edgeEnergy, f.sizePx,
  f.embedding, f.dims, f.modelTag, f.crop, f.createdAt, f.employeeId, f.matchCosine, f.matchMargin,
];

/**
 * stranger_faces on PostgreSQL. Additive: a new table, run as its own statement
 * after the main schema batch so a failure here can never roll back the
 * existing tables' migration. id and capturedAt sort bytewise (COLLATE "C") so
 * keyset paging orders exactly like SQLite and the JSON fallback; the paging
 * index is partial (unpurged rows), which is also what the purge scans. The unique
 * (logId, faceIndex) index is the (logId) lookup index and makes a writer's
 * retry of the same frame idempotent even with fresh ids. The foreign key keeps
 * every face tied to its immutable access event; clearing the access history
 * removes the faces with it (ON DELETE CASCADE).
 */
const PG_STRANGER_FACES_DDL = `
  CREATE TABLE IF NOT EXISTS stranger_faces (
    id VARCHAR(64) COLLATE "C" PRIMARY KEY,
    "logId" VARCHAR(64) NOT NULL REFERENCES access_logs (id) ON DELETE CASCADE,
    "faceIndex" INTEGER NOT NULL,
    "capturedAt" VARCHAR(64) COLLATE "C" NOT NULL,
    gate VARCHAR(16) NOT NULL,
    "streamId" VARCHAR(64),
    engine VARCHAR(16) NOT NULL,
    "trackId" VARCHAR(64),
    box JSONB NOT NULL,
    "sourceWidth" INTEGER,
    "sourceHeight" INTEGER,
    "detectorScore" REAL NOT NULL,
    quality REAL NOT NULL,
    "edgeEnergy" REAL,
    "sizePx" INTEGER NOT NULL,
    embedding BYTEA,
    dims INTEGER,
    "modelTag" VARCHAR(128),
    crop BYTEA,
    "createdAt" VARCHAR(64) NOT NULL,
    "purgedAt" VARCHAR(64),
    "employeeId" VARCHAR(64),
    "matchCosine" REAL,
    "matchMargin" REAL
  );
  CREATE INDEX IF NOT EXISTS idx_stranger_faces_captured ON stranger_faces ("capturedAt" DESC, id DESC)
    WHERE "purgedAt" IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_stranger_faces_log ON stranger_faces ("logId", "faceIndex");
  -- Recognised-face observations (accuracy wave, 2026-09-29): additive,
  -- nullable, no default (catalog-only ALTER). Old rows read NULL = a stranger
  -- face, exactly what they were. Rollback: DROP COLUMN x3 + DROP INDEX.
  ALTER TABLE stranger_faces ADD COLUMN IF NOT EXISTS "employeeId" VARCHAR(64);
  ALTER TABLE stranger_faces ADD COLUMN IF NOT EXISTS "matchCosine" REAL;
  ALTER TABLE stranger_faces ADD COLUMN IF NOT EXISTS "matchMargin" REAL;
  CREATE INDEX IF NOT EXISTS idx_stranger_faces_recognised ON stranger_faces ("employeeId", "capturedAt" DESC, id DESC)
    WHERE "employeeId" IS NOT NULL AND "purgedAt" IS NULL;
`;

/**
 * pipeline_shadow_results on PostgreSQL (src/server/shadowResults.ts). One row
 * per shadow-engine outcome; no images, no embeddings, so nothing biometric
 * lives here (retention is a plain DELETE by decidedAt). No foreign key to
 * access_logs: the door-engine event may not be durable yet when the shadow
 * decides, and an admin wipe of the history must not erase the comparison.
 * id and decidedAt sort bytewise (COLLATE "C") like stranger_faces so keyset
 * paging orders exactly as SQLite and JSON do.
 */
const PG_SHADOW_RESULTS_DDL = `
  CREATE TABLE IF NOT EXISTS pipeline_shadow_results (
    id VARCHAR(64) COLLATE "C" PRIMARY KEY,
    gate VARCHAR(64) NOT NULL,
    "trackId" VARCHAR(64) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    "employeeId" VARCHAR(64),
    "fusedCosine" REAL,
    margin REAL,
    "runnerUpEmployeeId" VARCHAR(64),
    "runnerUpCosine" REAL,
    basis VARCHAR(128) NOT NULL,
    "fusionBasis" VARCHAR(128),
    "meanCheckRefused" BOOLEAN,
    "framesSeen" INTEGER NOT NULL,
    "framesUsed" INTEGER NOT NULL,
    "firstSeenAt" VARCHAR(64) NOT NULL,
    "firstUsableAt" VARCHAR(64),
    "decidedAt" VARCHAR(64) COLLATE "C" NOT NULL,
    "legacyLogId" VARCHAR(64),
    "legacyStatus" VARCHAR(16),
    "legacyEmployeeId" VARCHAR(64),
    agreement VARCHAR(32) NOT NULL,
    "createdAt" VARCHAR(64) NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_results_decided ON pipeline_shadow_results ("decidedAt" DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_shadow_results_gate ON pipeline_shadow_results (gate, "decidedAt" DESC);
`;

const SQLITE_SHADOW_RESULTS_DDL = `
  CREATE TABLE IF NOT EXISTS pipeline_shadow_results (
    id TEXT PRIMARY KEY,
    gate TEXT NOT NULL,
    trackId TEXT NOT NULL,
    outcome TEXT NOT NULL,
    employeeId TEXT,
    fusedCosine REAL,
    margin REAL,
    runnerUpEmployeeId TEXT,
    runnerUpCosine REAL,
    basis TEXT NOT NULL,
    fusionBasis TEXT,
    meanCheckRefused INTEGER,
    framesSeen INTEGER NOT NULL,
    framesUsed INTEGER NOT NULL,
    firstSeenAt TEXT NOT NULL,
    firstUsableAt TEXT,
    decidedAt TEXT NOT NULL,
    legacyLogId TEXT,
    legacyStatus TEXT,
    legacyEmployeeId TEXT,
    agreement TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_results_decided ON pipeline_shadow_results (decidedAt DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_shadow_results_gate ON pipeline_shadow_results (gate, decidedAt DESC);
`;

// ================= SHADOW RESULTS (accuracy wave) =================
// Limits mirror the PostgreSQL columns so SQLite and JSON refuse what
// PostgreSQL would. Everything here is server-generated (server.ts writes it
// from the pipeline), so a malformed required field is a bug and the row is
// refused; malformed descriptive scores are stored as NULL.

const SHADOW_RESULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHADOW_GATE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** basis / fusionBasis: short machine strings ("fused-2", "rejected-ambiguous", ...). */
const SHADOW_BASIS_RE = /^[\x21-\x7E]{1,128}$/;
const SHADOW_OUTCOMES: ReadonlySet<string> = new Set(["employee", "stranger", "insufficient"]);
const SHADOW_AGREEMENTS: ReadonlySet<string> = new Set(["agree", "shadow-only", "legacy-only", "identity-mismatch", "none"]);
const SHADOW_MAX_FRAMES = 2_147_483_647;
const SHADOW_PAGE_MAX = 100;

/** A validated shadow result as the stores hold it (NULL for absent optionals). */
interface ShadowResultRow {
  id: string;
  gate: string;
  trackId: string;
  outcome: ShadowResultRecord["outcome"];
  employeeId: string | null;
  fusedCosine: number | null;
  margin: number | null;
  runnerUpEmployeeId: string | null;
  runnerUpCosine: number | null;
  basis: string;
  fusionBasis: string | null;
  meanCheckRefused: boolean | null;
  framesSeen: number;
  framesUsed: number;
  firstSeenAt: string;
  firstUsableAt: string | null;
  decidedAt: string;
  legacyLogId: string | null;
  legacyStatus: "GRANTED" | "DENIED" | null;
  legacyEmployeeId: string | null;
  agreement: ShadowAgreement;
  createdAt: string;
}

const frameCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= SHADOW_MAX_FRAMES;
const optionalId = (v: unknown, re: RegExp): { value: string | null; ok: boolean } => {
  if (v === undefined || v === null || v === "") return { value: null, ok: true };
  return typeof v === "string" && re.test(v) ? { value: v, ok: true } : { value: null, ok: false };
};

/**
 * Validate one shadow result for storage. id, gate, trackId, outcome, basis,
 * frame counts, firstSeenAt, decidedAt and agreement are required (the row
 * could not be paged, filtered or summarised without them); an employee
 * outcome needs its employeeId; ids that are present must fit their VARCHAR(64)
 * columns. Malformed scores and fusionBasis are stored as NULL; a malformed
 * firstUsableAt is dropped (the row then simply has no latency sample).
 */
export function normalizeShadowResult(record: ShadowResultRecord): { row?: ShadowResultRow; error?: string } {
  if (!record || typeof record !== "object") return { error: "not-an-object" };
  if (typeof record.id !== "string" || !SHADOW_RESULT_ID_RE.test(record.id)) return { error: "id" };
  if (typeof record.gate !== "string" || !SHADOW_GATE_RE.test(record.gate)) return { error: "gate" };
  if (typeof record.trackId !== "string" || !TRACK_ID_RE.test(record.trackId)) return { error: "trackId" };
  if (typeof record.outcome !== "string" || !SHADOW_OUTCOMES.has(record.outcome)) return { error: "outcome" };
  const employeeId = optionalId(record.employeeId, EMPLOYEE_ID_RE);
  if (!employeeId.ok || (record.outcome === "employee" && !employeeId.value)) return { error: "employeeId" };
  const runnerUp = optionalId(record.runnerUpEmployeeId, EMPLOYEE_ID_RE);
  if (!runnerUp.ok) return { error: "runnerUpEmployeeId" };
  if (typeof record.basis !== "string" || !SHADOW_BASIS_RE.test(record.basis)) return { error: "basis" };
  if (!frameCount(record.framesSeen) || !frameCount(record.framesUsed)) return { error: "frames" };
  const firstSeenAt = normIso(record.firstSeenAt);
  if (!firstSeenAt) return { error: "firstSeenAt" };
  const decidedAt = normIso(record.decidedAt);
  if (!decidedAt) return { error: "decidedAt" };
  const legacyLogId = optionalId(record.legacyLogId, ACCESS_LOG_ID_RE);
  if (!legacyLogId.ok) return { error: "legacyLogId" };
  if (record.legacyStatus !== undefined && record.legacyStatus !== null && record.legacyStatus !== "GRANTED" && record.legacyStatus !== "DENIED") {
    return { error: "legacyStatus" };
  }
  const legacyEmployeeId = optionalId(record.legacyEmployeeId, EMPLOYEE_ID_RE);
  if (!legacyEmployeeId.ok) return { error: "legacyEmployeeId" };
  if (typeof record.agreement !== "string" || !SHADOW_AGREEMENTS.has(record.agreement)) return { error: "agreement" };
  return {
    row: {
      id: record.id,
      gate: record.gate,
      trackId: record.trackId,
      outcome: record.outcome,
      employeeId: employeeId.value,
      fusedCosine: realValue(record.fusedCosine) ? record.fusedCosine : null,
      margin: realValue(record.margin) ? record.margin : null,
      runnerUpEmployeeId: runnerUp.value,
      runnerUpCosine: realValue(record.runnerUpCosine) ? record.runnerUpCosine : null,
      basis: record.basis,
      fusionBasis: typeof record.fusionBasis === "string" && SHADOW_BASIS_RE.test(record.fusionBasis) ? record.fusionBasis : null,
      meanCheckRefused: record.meanCheckRefused === true ? true : record.meanCheckRefused === false ? false : null,
      framesSeen: record.framesSeen,
      framesUsed: record.framesUsed,
      firstSeenAt,
      firstUsableAt: normIso(record.firstUsableAt) || null,
      decidedAt,
      legacyLogId: legacyLogId.value,
      legacyStatus: record.legacyStatus || null,
      legacyEmployeeId: legacyEmployeeId.value,
      agreement: record.agreement,
      createdAt: normIso(record.createdAt) || new Date().toISOString(),
    },
  };
}

/** A PostgreSQL/SQLite/JSON row -> record; absent optionals (NULL) are omitted. */
function rowToShadowResult(r: any): ShadowResultRecord {
  const out: ShadowResultRecord = {
    id: String(r.id),
    gate: String(r.gate),
    trackId: String(r.trackId),
    outcome: r.outcome,
    employeeId: optionalText(r.employeeId),
    fusedCosine: optionalNumber(r.fusedCosine),
    margin: optionalNumber(r.margin),
    runnerUpEmployeeId: optionalText(r.runnerUpEmployeeId),
    runnerUpCosine: optionalNumber(r.runnerUpCosine),
    basis: String(r.basis),
    fusionBasis: optionalText(r.fusionBasis),
    meanCheckRefused: r.meanCheckRefused == null ? undefined : r.meanCheckRefused === true || r.meanCheckRefused === 1,
    framesSeen: Number(r.framesSeen),
    framesUsed: Number(r.framesUsed),
    firstSeenAt: String(r.firstSeenAt),
    firstUsableAt: optionalText(r.firstUsableAt),
    decidedAt: String(r.decidedAt),
    legacyLogId: optionalText(r.legacyLogId),
    legacyStatus: r.legacyStatus === "GRANTED" || r.legacyStatus === "DENIED" ? r.legacyStatus : undefined,
    legacyEmployeeId: optionalText(r.legacyEmployeeId),
    agreement: r.agreement,
    createdAt: String(r.createdAt),
  };
  for (const key of Object.keys(out) as Array<keyof ShadowResultRecord>) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

const SHADOW_RESULT_COLUMNS_PG = `id, gate, "trackId", outcome, "employeeId", "fusedCosine", margin, "runnerUpEmployeeId", "runnerUpCosine",
  basis, "fusionBasis", "meanCheckRefused", "framesSeen", "framesUsed", "firstSeenAt", "firstUsableAt", "decidedAt",
  "legacyLogId", "legacyStatus", "legacyEmployeeId", agreement, "createdAt"`;
const SHADOW_RESULT_COLUMNS_SQLITE = `id, gate, trackId, outcome, employeeId, fusedCosine, margin, runnerUpEmployeeId, runnerUpCosine,
  basis, fusionBasis, meanCheckRefused, framesSeen, framesUsed, firstSeenAt, firstUsableAt, decidedAt,
  legacyLogId, legacyStatus, legacyEmployeeId, agreement, createdAt`;
const SHADOW_RESULT_PARAM_COUNT = 22;

const shadowResultInsertParams = (r: ShadowResultRow, meanCheckRefused: unknown): unknown[] => [
  r.id, r.gate, r.trackId, r.outcome, r.employeeId, r.fusedCosine, r.margin, r.runnerUpEmployeeId, r.runnerUpCosine,
  r.basis, r.fusionBasis, meanCheckRefused, r.framesSeen, r.framesUsed, r.firstSeenAt, r.firstUsableAt, r.decidedAt,
  r.legacyLogId, r.legacyStatus, r.legacyEmployeeId, r.agreement, r.createdAt,
];

/** Bytewise (decidedAt DESC, id DESC), the order every store pages in. */
const shadowNewestFirst = (a: { decidedAt: string; id: string }, b: { decidedAt: string; id: string }): number =>
  a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/** Median of a list of latencies in ms (mean of the two middle values for an even count), rounded; null for none. */
export function medianMs(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
}

/**
 * ShadowAccuracySummary rows from light rows (gate, outcome, framesUsed,
 * agreement, decidedAt, firstUsableAt). One definition for every store; the
 * SQL stores pre-aggregate the counts and only send employee latencies here.
 */
function emptyShadowSummary(gate: string, since: string): ShadowAccuracySummary {
  return {
    gate, since, decisions: 0, employees: 0, strangers: 0, insufficient: 0, framesUsedZero: 0,
    agree: 0, shadowOnly: 0, legacyOnly: 0, identityMismatch: 0, none: 0, decisionLatencyP50Ms: null,
  };
}

function countShadowRow(s: ShadowAccuracySummary, r: { outcome: string; framesUsed: number; agreement: string }): void {
  s.decisions += 1;
  if (r.outcome === "employee") s.employees += 1;
  else if (r.outcome === "stranger") s.strangers += 1;
  else if (r.outcome === "insufficient") s.insufficient += 1;
  if (Number(r.framesUsed) === 0) s.framesUsedZero += 1;
  if (r.agreement === "agree") s.agree += 1;
  else if (r.agreement === "shadow-only") s.shadowOnly += 1;
  else if (r.agreement === "legacy-only") s.legacyOnly += 1;
  else if (r.agreement === "identity-mismatch") s.identityMismatch += 1;
  else if (r.agreement === "none") s.none += 1;
}

/** The count columns of an aggregated SQL row, as integers (SQLite sums come back as numbers, PostgreSQL ::int too). */
function pickShadowCounts(r: any): Omit<ShadowAccuracySummary, "gate" | "since" | "decisionLatencyP50Ms"> {
  const n = (v: unknown) => Number(v) || 0;
  return {
    decisions: n(r.decisions), employees: n(r.employees), strangers: n(r.strangers), insufficient: n(r.insufficient),
    framesUsedZero: n(r.framesUsedZero), agree: n(r.agree), shadowOnly: n(r.shadowOnly), legacyOnly: n(r.legacyOnly),
    identityMismatch: n(r.identityMismatch), none: n(r.none),
  };
}

/** decidedAt - firstUsableAt in ms, for employee outcomes that have a usable-frame time. */
const shadowLatencyMs = (r: { outcome: string; decidedAt: string; firstUsableAt?: string | null }): number | null => {
  if (r.outcome !== "employee" || !r.firstUsableAt) return null;
  const ms = Date.parse(r.decidedAt) - Date.parse(String(r.firstUsableAt));
  return Number.isFinite(ms) ? ms : null;
};

const SQLITE_STRANGER_FACES_DDL = `
  CREATE TABLE IF NOT EXISTS stranger_faces (
    id TEXT PRIMARY KEY,
    logId TEXT NOT NULL,
    faceIndex INTEGER NOT NULL,
    capturedAt TEXT NOT NULL,
    gate TEXT NOT NULL,
    streamId TEXT,
    engine TEXT NOT NULL,
    trackId TEXT,
    box TEXT NOT NULL,
    sourceWidth INTEGER,
    sourceHeight INTEGER,
    detectorScore REAL NOT NULL,
    quality REAL NOT NULL,
    edgeEnergy REAL,
    sizePx INTEGER NOT NULL,
    embedding BLOB,
    dims INTEGER,
    modelTag TEXT,
    crop BLOB,
    createdAt TEXT NOT NULL,
    purgedAt TEXT,
    employeeId TEXT,
    matchCosine REAL,
    matchMargin REAL
  );
  CREATE INDEX IF NOT EXISTS idx_stranger_faces_captured ON stranger_faces (capturedAt DESC, id DESC)
    WHERE purgedAt IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_stranger_faces_log ON stranger_faces (logId, faceIndex);
`;
/** Databases from the per-face release: add the observation columns (duplicate-column error = already done). */
const SQLITE_STRANGER_FACES_MIGRATIONS = [
  "ALTER TABLE stranger_faces ADD COLUMN employeeId TEXT",
  "ALTER TABLE stranger_faces ADD COLUMN matchCosine REAL",
  "ALTER TABLE stranger_faces ADD COLUMN matchMargin REAL",
];
/** After the columns exist (fresh or migrated). */
const SQLITE_STRANGER_FACES_RECOGNISED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_stranger_faces_recognised ON stranger_faces (employeeId, capturedAt DESC, id DESC)
    WHERE employeeId IS NOT NULL AND purgedAt IS NULL;
`;

export interface CameraStreamsConfigRecord {
  entryGate: GateStreamConfigRecord;
  exitGate: GateStreamConfigRecord;
  workerThreadsCount: number;
  multiThreadEnabled: boolean;
  autoFailoverToClientUvc: boolean;
  maxFpsPerStream: number;
  backendCaptureFps: number;
}

const DEFAULT_ENTRY_RTSP_URL = process.env.CAMERA_ENTRY_RTSP_URL?.trim() || "";
const DEFAULT_EXIT_RTSP_URL = process.env.CAMERA_EXIT_RTSP_URL?.trim() || "";

export const DEFAULT_CAMERA_STREAMS_CONFIG: CameraStreamsConfigRecord = {
  entryGate: {
    gateType: "ENTRY",
    name: "Camera Cổng Vào (Main Entry Gate)",
    enabled: true,
    // Backend auto-scan is OFF by default: a job that can drive an unlock
    // decision unattended has to be switched on deliberately.
    watch: { enabled: false, intervalSeconds: 3, frames: 1 },
    streams: [
      {
        id: "entry-101",
        label: "Camera Cổng Vào (Main Entry Gate)",
        sourceType: "RTSP",
        rtspUrl: DEFAULT_ENTRY_RTSP_URL,
        rtspTransport: "TCP",
        httpUrl: "http://192.168.60.2/stream",
        uvcDeviceId: "default",
        uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
        backendDevicePath: "/dev/video0",
        resolution: "1920x1080",
        fps: 25,
        enabled: true,
        priority: 1,
      },
    ],
    sourceType: "RTSP",
    rtspUrl: DEFAULT_ENTRY_RTSP_URL,
    rtspTransport: "TCP",
    httpUrl: "http://192.168.60.2/stream",
    uvcDeviceId: "default",
    uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
    resolution: "1920x1080",
    fps: 25,
    backendDevicePath: "/dev/video0",
    autoStart: true,
    reconnectIntervalSeconds: 5,
  },
  exitGate: {
    gateType: "EXIT",
    name: "Camera Cổng Ra (Exit Gate B2)",
    enabled: true,
    watch: { enabled: false, intervalSeconds: 3, frames: 1 },
    streams: [
      {
        id: "exit-102",
        label: "Camera Cổng Ra (Exit Gate B2)",
        sourceType: "RTSP",
        rtspUrl: DEFAULT_EXIT_RTSP_URL,
        rtspTransport: "TCP",
        httpUrl: "http://192.168.60.2/substream",
        uvcDeviceId: "default",
        uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
        backendDevicePath: "/dev/video1",
        resolution: "1280x720",
        fps: 25,
        enabled: true,
        priority: 1,
      },
    ],
    sourceType: "RTSP",
    rtspUrl: DEFAULT_EXIT_RTSP_URL,
    rtspTransport: "TCP",
    httpUrl: "http://192.168.60.2/substream",
    uvcDeviceId: "default",
    uvcDeviceLabel: "Camera UVC Mặc Định Trình Duyệt",
    resolution: "1280x720",
    fps: 25,
    backendDevicePath: "/dev/video1",
    autoStart: true,
    reconnectIntervalSeconds: 5,
  },
  workerThreadsCount: 4,
  multiThreadEnabled: true,
  autoFailoverToClientUvc: true,
  maxFpsPerStream: 30,
  backendCaptureFps: 15,
};

// ================= AI RECOGNITION CONFIG =================
export type AiEngineMode = "GOOGLE_GEMINI" | "LOCAL_BIOMETRIC" | "HYBRID_AUTO";

export interface AiRecognitionConfigRecord {
  engineMode: AiEngineMode;
  googleAi: {
    model: string;
    temperature: number;
    minConfidence: number;
    useSystemFallback: boolean;
    customPrompt?: string;
  };
  localModel: {
    modelArchitecture: string;
    similarityThreshold: number;
    livenessSensitivity: "LOW" | "MEDIUM" | "HIGH";
    maxFaces: number;
    autoContrast: boolean;
    antiSpoofing: boolean;
  };
  hybridSettings: {
    localPreFilterThreshold: number;
    fallbackToCloudOnUnknown: boolean;
  };
}

export const AI_ENGINE_MODES: AiEngineMode[] = ["GOOGLE_GEMINI", "LOCAL_BIOMETRIC", "HYBRID_AUTO"];

/**
 * Lays a persisted (possibly partial / older) AI config over the defaults so
 * that fields introduced after the row was written still receive a default.
 * Sections are merged one level deep; an unknown engineMode falls back to the
 * default one instead of poisoning the runtime.
 */
export function mergeAiRecognitionConfig(
  defaults: AiRecognitionConfigRecord,
  persisted: Partial<AiRecognitionConfigRecord> | null | undefined
): AiRecognitionConfigRecord {
  const p: any = persisted && typeof persisted === "object" ? persisted : {};
  const engineMode = AI_ENGINE_MODES.includes(p.engineMode) ? (p.engineMode as AiEngineMode) : defaults.engineMode;
  return {
    engineMode,
    googleAi: { ...defaults.googleAi, ...(p.googleAi && typeof p.googleAi === "object" ? p.googleAi : {}) },
    localModel: { ...defaults.localModel, ...(p.localModel && typeof p.localModel === "object" ? p.localModel : {}) },
    hybridSettings: {
      ...defaults.hybridSettings,
      ...(p.hybridSettings && typeof p.hybridSettings === "object" ? p.hybridSettings : {}),
    },
  };
}

// Database wrapper supporting PostgreSQL (via DATABASE_URL), native Node 22 SQLite, and fallback JSON
class SQLiteStorage implements StrangerFaceStore, ShadowResultStore {
  private db: any = null;
  private isNativeSqlite = false;
  private pgPool: Pool | null = null;
  private isPostgres = false;
  private postgresConnected = false;
  private postgresHost = "";
  private postgresDatabase = "";
  private postgresCounts: Record<string, number> = {};
  private onSyncCallbacks: Array<() => void> = [];
  private storage: StorageTrackerState = { ...INITIAL_STORAGE_STATE };
  /**
   * PostgreSQL access-log inserts still in flight, by log id. saveAccessLog
   * callers that do not await the write answer the client before PostgreSQL
   * has the row, so an immediate follow-up read (open the stranger alert that
   * was just raised) could miss it. Access-log reads on PostgreSQL wait for
   * these first, bounded by ACCESS_LOG_READ_YOUR_WRITES_MS.
   */
  private pendingAccessLogWrites = new Map<string, Promise<boolean>>();
  /**
   * stranger_faces exists on PostgreSQL. Until then (startup, or a failed
   * migration, which is logged) face writes are refused and the stranger
   * candidate page does not reference the table, so the existing panel keeps
   * working exactly as before.
   */
  private pgStrangerFacesReady = false;
  /** pipeline_shadow_results exists on PostgreSQL (same pattern: refuse writes until then). */
  private pgShadowResultsReady = false;

  constructor() {
    this.init();
    this.initPostgres();
  }

  public onSync(cb: () => void) {
    this.onSyncCallbacks.push(cb);
  }

  private notifySync() {
    for (const cb of this.onSyncCallbacks) {
      try {
        cb();
      } catch (e: any) {
        console.error("[PostgreSQL Sync Callback Error]:", e?.message);
      }
    }
  }

  private async initPostgres() {
    const databaseUrl = process.env.DATABASE_URL;
    this.storage.sqliteActive = this.isNativeSqlite;
    if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
      return;
    }
    this.storage.postgresConfigured = true;
    this.storage.connecting = true;

    try {
      try {
        const parsed = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//, "http://"));
        this.postgresHost = parsed.hostname;
        this.postgresDatabase = parsed.pathname.replace(/^\//, "");
      } catch {}

      this.pgPool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 7000,
        idleTimeoutMillis: 30000,
        max: 10,
      });
      this.watchPostgresPool(this.pgPool);

      // Test connection. Retried with backoff: the first attempt races the
      // container's startup burst (ONNX session creation and worker spawn can
      // starve the event loop past the 7 s handshake timeout), and a single
      // failure used to drop the process onto SQLite/JSON for its whole life -
      // writes then silently diverged from PostgreSQL until the next restart.
      const maxAttempts = 6;
      let client: any;
      for (let attempt = 1; ; attempt++) {
        try {
          client = await this.pgPool.connect();
          break;
        } catch (connectErr: any) {
          if (attempt >= maxAttempts) throw connectErr;
          const delayMs = Math.min(2000 * 2 ** (attempt - 1), 15000);
          console.warn(
            `[PostgreSQL] Kết nối thất bại lần ${attempt}/${maxAttempts} (${connectErr?.message}); thử lại sau ${delayMs}ms.`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      try {
        await client.query("SELECT 1");
        this.postgresConnected = true;
        this.isPostgres = true;
        this.storage.postgresActive = true;
        this.storage.connecting = false;
        console.log(`[PostgreSQL] Đã kết nối cơ sở dữ liệu PostgreSQL thành công (${this.postgresHost}/${this.postgresDatabase})!`);
        await this.createPostgresTables();
        await this.syncWithPostgres();
      } finally {
        client.release();
      }
    } catch (err: any) {
      this.isPostgres = false;
      this.postgresConnected = false;
      this.storage.postgresActive = false;
      this.storage.connecting = false;
      this.storage.fellBackAt = Date.now();
      console.error(
        `[PostgreSQL] ⚠ KHÔNG kết nối được PostgreSQL (${err?.message}). Đang chạy trên ${
          this.isNativeSqlite ? "SQLite" : "JSON"
        } DỰ PHÒNG: dữ liệu mới chỉ nằm trên máy chủ cổng, cần chép lại vào PostgreSQL. ` +
          "Khởi động lại gateway khi PostgreSQL đã sẵn sàng."
      );
    }
  }

  /**
   * Track whether queries reach PostgreSQL. Writes are fire-and-forget, so a
   * connection loss mid-run would otherwise only show up as log lines. Also
   * the pool's "error" listener: without one, an idle connection dropped by a
   * PostgreSQL restart emits an unhandled "error" and kills the process.
   */
  private watchPostgresPool(pool: Pool) {
    const noteOk = () => {
      if (this.storage.outageStartedAt != null) console.log("[PostgreSQL] Kết nối PostgreSQL đã hồi phục.");
      this.storage = recordQueryOk(this.storage, Date.now());
    };
    const noteError = (err: unknown) => {
      if (!isConnectionError(err)) return;
      if (this.storage.outageStartedAt == null) {
        console.error(`[PostgreSQL] ⚠ Mất kết nối PostgreSQL (${(err as any)?.message}). Bản ghi mới có thể chưa được lưu.`);
      }
      this.storage = recordConnectionError(this.storage, Date.now());
    };
    pool.on("error", (err) => noteError(err));
    const rawQuery = pool.query.bind(pool) as (...args: any[]) => any;
    (pool as any).query = (...args: any[]) => {
      const result = rawQuery(...args);
      if (result && typeof result.then === "function") {
        return result.then(
          (value: unknown) => {
            noteOk();
            return value;
          },
          (err: unknown) => {
            noteError(err);
            throw err;
          },
        );
      }
      return result;
    };
    const rawConnect = pool.connect.bind(pool) as (...args: any[]) => any;
    (pool as any).connect = (...args: any[]) => {
      const result = rawConnect(...args);
      if (result && typeof result.then === "function") {
        // Startup retries report through fellBackAt, not as a runtime outage.
        return result.catch((err: unknown) => {
          if (!this.storage.connecting) noteError(err);
          throw err;
        });
      }
      return result;
    };
  }

  /** Where writes are going, and whether that is where the site expects them. */
  getStorageStatus(): StorageStatus {
    return storageStatus(this.storage);
  }

  private async syncWithPostgres() {
    if (!this.pgPool || !this.isPostgres) return;
    try {
      // 1. Employees sync
      const empCountRes = await this.pgPool.query('SELECT count(*) as count FROM employees');
      const empCount = parseInt(empCountRes.rows[0]?.count || "0", 10);
      if (empCount === 0) {
        const existingEmps = this.getEmployees([]);
        for (const emp of existingEmps) {
          await this.pgPool.query(`
            INSERT INTO employees (id, name, "employeeCode", department, position, "photoUrl", "registeredAt", "accessLevel")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              "employeeCode" = EXCLUDED."employeeCode",
              department = EXCLUDED.department,
              position = EXCLUDED.position,
              "photoUrl" = EXCLUDED."photoUrl",
              "accessLevel" = EXCLUDED."accessLevel"
          `, [emp.id, emp.name, emp.employeeCode, emp.department, emp.position, emp.photoUrl, emp.registeredAt, emp.accessLevel]);
        }
        console.log(`[PostgreSQL] Đã khởi tạo và đồng bộ ${existingEmps.length} nhân viên vào PostgreSQL!`);
      } else {
        const pgEmps = await this.pgPool.query(`
          SELECT id, name, "employeeCode", department, position, "photoUrl", "registeredAt", "accessLevel"
          FROM employees ORDER BY "registeredAt" DESC
        `);
        for (const row of pgEmps.rows) {
          if (this.isNativeSqlite && this.db) {
            try {
              const stmt = this.db.prepare(`
                INSERT INTO employees (id, name, employeeCode, department, position, photoUrl, registeredAt, accessLevel)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name,
                  employeeCode = excluded.employeeCode,
                  department = excluded.department,
                  position = excluded.position,
                  photoUrl = excluded.photoUrl,
                  accessLevel = excluded.accessLevel
              `);
              stmt.run(row.id, row.name, row.employeeCode, row.department, row.position, row.photoUrl, row.registeredAt, row.accessLevel);
            } catch {}
          }
        }
        console.log(`[PostgreSQL] Đã tải ${pgEmps.rows.length} nhân viên từ PostgreSQL vào cache hệ thống!`);
      }

      // 2. Access logs sync
      const logCountRes = await this.pgPool.query('SELECT count(*) as count FROM access_logs');
      const logCount = parseInt(logCountRes.rows[0]?.count || "0", 10);
      if (logCount === 0) {
        const existingLogs = this.getAccessLogs([]);
        for (const log of existingLogs) {
          await this.pgPool.query(`
            INSERT INTO access_logs (
              id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
              department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
              "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality",
              "capturedAt", "trackId", "recordingChannel"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
            ON CONFLICT (id) DO NOTHING
          `, [
            log.id, log.timestamp, log.type, log.status,
            log.employeeId || null, log.employeeName || null, log.employeeCode || null,
            log.department || null, log.photoSnapshot, log.confidence,
            log.livenessScore ?? null, log.lockAction, log.doorName, log.reason || null,
            log.faceEmbedding?.length ? embeddingToBuffer(log.faceEmbedding) : null,
            log.faceEmbedding?.length || null, log.faceEmbeddingModelTag || null, log.faceEmbeddingQuality ?? null,
            ...accessLogTraceParams(log),
          ]);
        }
        console.log(`[PostgreSQL] Đã khởi tạo và đồng bộ ${existingLogs.length} bản ghi truy cập vào PostgreSQL!`);
      } else {
        const pgLogs = await this.pgPool.query(`
          SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
                 department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
                 "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality",
                 "capturedAt", "trackId", "recordingChannel"
          FROM access_logs ORDER BY timestamp DESC LIMIT 100
        `);
        for (const r of pgLogs.rows) {
          if (this.isNativeSqlite && this.db) {
            try {
              const stmt = this.db.prepare(`
                INSERT INTO access_logs (
                  id, timestamp, type, status, employeeId, employeeName, employeeCode,
                  department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason,
                  faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality,
                  capturedAt, trackId, recordingChannel
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
              `);
              stmt.run(
                r.id, r.timestamp, r.type, r.status,
                r.employeeId || null, r.employeeName || null, r.employeeCode || null,
                r.department || null, r.photoSnapshot, r.confidence,
                r.livenessScore ?? null, r.lockAction, r.doorName, r.reason || null,
                r.faceEmbedding || null, r.faceEmbeddingDims || null,
                r.faceEmbeddingModelTag || null, r.faceEmbeddingQuality ?? null,
                r.capturedAt ?? null, r.trackId ?? null, r.recordingChannel ?? null
              );
            } catch {}
          }
        }
      }

      // 3. Smart lock state sync
      const lockCountRes = await this.pgPool.query('SELECT count(*) as count FROM smart_lock_state');
      const lockCount = parseInt(lockCountRes.rows[0]?.count || "0", 10);
      if (lockCount === 0) {
        const currentLock = this.getSmartLockState({
          lockId: "SL-HQ-01",
          doorName: "Cửa Chính Trụ Sở - Cổng A",
          state: "LOCKED",
          isLocked: true,
          batteryLevel: 96,
          signalDbm: -54,
          firmwareVersion: "v2.5.8-Zigbee/IP",
          lastActionAt: new Date().toISOString(),
          lastActionBy: "Hệ thống bảo mật tự động",
          autoRelockSeconds: 6,
          remainingRelockSeconds: 0,
          status: "ONLINE",
        });
        await this.pgPool.query(`
          INSERT INTO smart_lock_state (
            "lockId", "doorName", state, "isLocked", "batteryLevel", "signalDbm",
            "firmwareVersion", "lastActionAt", "lastActionBy", "autoRelockSeconds", status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT ("lockId") DO NOTHING
        `, [
          currentLock.lockId, currentLock.doorName, currentLock.state, currentLock.isLocked,
          currentLock.batteryLevel, currentLock.signalDbm, currentLock.firmwareVersion,
          currentLock.lastActionAt, currentLock.lastActionBy, currentLock.autoRelockSeconds, currentLock.status
        ]);
      } else {
        const pgLock = await this.pgPool.query('SELECT * FROM smart_lock_state LIMIT 1');
        if (pgLock.rows[0] && this.isNativeSqlite && this.db) {
          const row = pgLock.rows[0];
          try {
            const stmt = this.db.prepare(`
              INSERT INTO smart_lock_state (
                lockId, doorName, state, isLocked, batteryLevel, signalDbm,
                firmwareVersion, lastActionAt, lastActionBy, autoRelockSeconds, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(lockId) DO UPDATE SET
                doorName = excluded.doorName,
                state = excluded.state,
                isLocked = excluded.isLocked,
                batteryLevel = excluded.batteryLevel,
                signalDbm = excluded.signalDbm,
                lastActionAt = excluded.lastActionAt,
                lastActionBy = excluded.lastActionBy,
                status = excluded.status
            `);
            stmt.run(
              row.lockId, row.doorName, row.state, row.isLocked ? 1 : 0,
              row.batteryLevel, row.signalDbm, row.firmwareVersion,
              row.lastActionAt, row.lastActionBy, row.autoRelockSeconds, row.status
            );
          } catch {}
        }
      }

      // 4. Webhook config sync
      const hookCountRes = await this.pgPool.query('SELECT count(*) as count FROM webhook_config');
      const hookCount = parseInt(hookCountRes.rows[0]?.count || "0", 10);
      if (hookCount === 0) {
        const currentHook = this.getWebhookConfig({
          enabled: false,
          url: "https://chat-room.eton.vn/hooks/YOUR_WEBHOOK_TOKEN",
          gateInTitle: "[[CỔNG VÀO]]",
          gateOutTitle: "[[CỔNG RA]]",
          includeEmployeeCode: true,
          ...DEFAULT_STRANGER_WEBHOOK_CONFIG,
        });
        await this.pgPool.query(`
          INSERT INTO webhook_config (id, enabled, url, "gateInTitle", "gateOutTitle", "includeEmployeeCode", "strangerConfig")
          VALUES ('default', $1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [currentHook.enabled, currentHook.url, currentHook.gateInTitle, currentHook.gateOutTitle, currentHook.includeEmployeeCode, serializeStrangerWebhookConfig(currentHook)]);
      } else {
        const pgHook = await this.pgPool.query('SELECT * FROM webhook_config WHERE id = $1', ['default']);
        if (pgHook.rows[0] && this.isNativeSqlite && this.db) {
          const row = pgHook.rows[0];
          try {
            const stmt = this.db.prepare(`
              INSERT INTO webhook_config (id, enabled, url, gateInTitle, gateOutTitle, includeEmployeeCode, strangerConfig)
              VALUES ('default', ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                url = excluded.url,
                gateInTitle = excluded.gateInTitle,
                gateOutTitle = excluded.gateOutTitle,
                includeEmployeeCode = excluded.includeEmployeeCode,
                strangerConfig = excluded.strangerConfig
            `);
            stmt.run(
              row.enabled ? 1 : 0,
              row.url,
              row.gateInTitle,
              row.gateOutTitle,
              row.includeEmployeeCode ? 1 : 0,
              typeof row.strangerConfig === "string" ? row.strangerConfig : JSON.stringify(parseStrangerWebhookConfig(row.strangerConfig))
            );
          } catch {}
        }
      }

      // 5. Mobile notifications sync
      const notifCountRes = await this.pgPool.query('SELECT count(*) as count FROM mobile_notifications');
      const notifCount = parseInt(notifCountRes.rows[0]?.count || "0", 10);
      if (notifCount === 0) {
        const currentNotifs = this.getNotifications([]);
        for (const notif of currentNotifs) {
          await this.pgPool.query(`
            INSERT INTO mobile_notifications (id, title, body, timestamp, type, read, "employeeId", "employeeName")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
          `, [
            notif.id, notif.title, notif.body, notif.timestamp, notif.type,
            notif.read, notif.employeeId || null, notif.employeeName || null
          ]);
        }
      }

      // Update count statistics
      await this.refreshPostgresCounts();
      this.notifySync();
    } catch (err: any) {
      console.error("[PostgreSQL] Lỗi đồng bộ dữ liệu ban đầu:", err?.message);
    }
  }

  public async refreshPostgresCounts() {
    if (!this.pgPool || !this.isPostgres) return;
    try {
      const [emp, log, notif, hook, lock] = await Promise.all([
        this.pgPool.query('SELECT count(*) as c FROM employees'),
        this.pgPool.query('SELECT count(*) as c FROM access_logs'),
        this.pgPool.query('SELECT count(*) as c FROM mobile_notifications'),
        this.pgPool.query('SELECT count(*) as c FROM webhook_logs'),
        this.pgPool.query('SELECT count(*) as c FROM smart_lock_state'),
      ]);
      this.postgresCounts = {
        employees: parseInt(emp.rows[0]?.c || "0", 10),
        accessLogs: parseInt(log.rows[0]?.c || "0", 10),
        notifications: parseInt(notif.rows[0]?.c || "0", 10),
        webhookLogs: parseInt(hook.rows[0]?.c || "0", 10),
        smartLockState: parseInt(lock.rows[0]?.c || "0", 10),
      };
    } catch {}
  }

  private async createPostgresTables() {
    if (!this.pgPool) return;
    try {
      await this.pgPool.query(`
        CREATE TABLE IF NOT EXISTS employees (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          "employeeCode" VARCHAR(64) UNIQUE NOT NULL,
          department VARCHAR(255),
          position VARCHAR(255),
          "photoUrl" TEXT,
          "registeredAt" VARCHAR(64),
          "accessLevel" VARCHAR(32) DEFAULT 'ALL_ACCESS'
        );

        CREATE TABLE IF NOT EXISTS access_logs (
          id VARCHAR(64) PRIMARY KEY,
          timestamp VARCHAR(64) NOT NULL,
          type VARCHAR(16) NOT NULL,
          status VARCHAR(16) NOT NULL,
          "employeeId" VARCHAR(64),
          "employeeName" VARCHAR(255),
          "employeeCode" VARCHAR(64),
          department VARCHAR(255),
          "photoSnapshot" TEXT,
          confidence NUMERIC(5, 2),
          "livenessScore" NUMERIC(5, 2),
          "lockAction" TEXT,
          "doorName" VARCHAR(255),
          reason TEXT,
          "faceEmbedding" BYTEA,
          "faceEmbeddingDims" INTEGER,
          "faceEmbeddingModelTag" VARCHAR(128),
          "faceEmbeddingQuality" REAL,
          "capturedAt" VARCHAR(64),
          "trackId" VARCHAR(64),
          "recordingChannel" VARCHAR(16)
        );

        CREATE TABLE IF NOT EXISTS smart_lock_state (
          "lockId" VARCHAR(64) PRIMARY KEY,
          "doorName" VARCHAR(255),
          state VARCHAR(32),
          "isLocked" BOOLEAN,
          "batteryLevel" INTEGER,
          "signalDbm" INTEGER,
          "firmwareVersion" VARCHAR(64),
          "lastActionAt" VARCHAR(64),
          "lastActionBy" VARCHAR(255),
          "autoRelockSeconds" INTEGER,
          status VARCHAR(32)
        );

        CREATE TABLE IF NOT EXISTS webhook_config (
          id VARCHAR(64) PRIMARY KEY,
          enabled BOOLEAN,
          url TEXT,
          "gateInTitle" VARCHAR(255),
          "gateOutTitle" VARCHAR(255),
          "includeEmployeeCode" BOOLEAN,
          "strangerConfig" TEXT
        );

        CREATE TABLE IF NOT EXISTS webhook_logs (
          id VARCHAR(64) PRIMARY KEY,
          timestamp VARCHAR(64) NOT NULL,
          url TEXT,
          method VARCHAR(16),
          payload TEXT,
          "statusCode" INTEGER,
          "statusText" VARCHAR(128),
          "responseBody" TEXT,
          success BOOLEAN,
          error TEXT,
          "scanType" VARCHAR(16),
          "userName" VARCHAR(255)
        );

        CREATE TABLE IF NOT EXISTS mobile_notifications (
          id VARCHAR(64) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          body TEXT NOT NULL,
          timestamp VARCHAR(64) NOT NULL,
          type VARCHAR(32),
          read BOOLEAN DEFAULT FALSE,
          "employeeId" VARCHAR(64),
          "employeeName" VARCHAR(255)
        );

        CREATE TABLE IF NOT EXISTS resolved_stranger_clusters (
          "clusterId" VARCHAR(128) PRIMARY KEY,
          "resolvedAt" VARCHAR(64),
          "resolvedBy" VARCHAR(255)
        );

        CREATE TABLE IF NOT EXISTS stranger_resolutions (
          id VARCHAR(128) PRIMARY KEY,
          "clusterId" VARCHAR(128) UNIQUE NOT NULL,
          action VARCHAR(32) NOT NULL,
          "employeeId" VARCHAR(64),
          actor VARCHAR(255) NOT NULL,
          "resolvedAt" VARCHAR(64) NOT NULL,
          "logIds" JSONB NOT NULL,
          "sourceLogId" VARCHAR(64),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb
        );

        CREATE TABLE IF NOT EXISTS stranger_resolution_events (
          id VARCHAR(128) PRIMARY KEY,
          "clusterId" VARCHAR(128) NOT NULL,
          action VARCHAR(32) NOT NULL,
          "employeeId" VARCHAR(64),
          actor VARCHAR(255) NOT NULL,
          "resolvedAt" VARCHAR(64) NOT NULL,
          "logIds" JSONB NOT NULL,
          "sourceLogId" VARCHAR(64),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb
        );
        CREATE INDEX IF NOT EXISTS idx_stranger_resolution_events_cluster
          ON stranger_resolution_events ("clusterId", "resolvedAt");

        CREATE TABLE IF NOT EXISTS face_templates (
          id VARCHAR(64) PRIMARY KEY,
          "employeeId" VARCHAR(64) NOT NULL,
          embedding BYTEA NOT NULL,
          dims INTEGER NOT NULL,
          "modelTag" VARCHAR(64) NOT NULL,
          source VARCHAR(32) NOT NULL,
          quality REAL,
          "capturedAt" VARCHAR(64),
          "sourceLogId" VARCHAR(64),
          "streamId" VARCHAR(64)
        );
        CREATE INDEX IF NOT EXISTS idx_face_templates_emp ON face_templates ("employeeId");

        CREATE TABLE IF NOT EXISTS ai_recognition_config (
          id VARCHAR(64) PRIMARY KEY,
          config_json JSONB NOT NULL,
          "updatedAt" VARCHAR(64)
        );

        -- Also in init-db.sql, which only runs when a database is first made:
        -- without these here, a database created any other way had no table
        -- for camera or door settings and silently kept them in SQLite only.
        CREATE TABLE IF NOT EXISTS camera_streams_config (
          id VARCHAR(64) PRIMARY KEY,
          data JSONB NOT NULL,
          "updatedAt" VARCHAR(64)
        );
        CREATE TABLE IF NOT EXISTS door_controller_config (
          id VARCHAR(64) PRIMARY KEY,
          data JSONB NOT NULL,
          "updatedAt" VARCHAR(64)
        );

        CREATE TABLE IF NOT EXISTS app_users (
          id VARCHAR(64) PRIMARY KEY,
          username VARCHAR(64) NOT NULL UNIQUE,
          data JSONB NOT NULL,
          "updatedAt" VARCHAR(64)
        );

        CREATE TABLE IF NOT EXISTS org_catalog (
          id VARCHAR(64) PRIMARY KEY,
          data JSONB NOT NULL,
          "updatedAt" VARCHAR(64)
        );

        -- Migration: stranger-alert settings for databases created before they existed
        ALTER TABLE webhook_config ADD COLUMN IF NOT EXISTS "strangerConfig" TEXT;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbedding" BYTEA;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingDims" INTEGER;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingModelTag" VARCHAR(128);
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingQuality" REAL;
        -- Real-time pipeline trace (2026-09-26): additive, nullable, no default, so
        -- the ALTER is a catalog-only change (no table rewrite) and code that
        -- predates it keeps working. Rollback: DROP COLUMN (see handoff notes).
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "capturedAt" VARCHAR(64);
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "trackId" VARCHAR(64);
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "recordingChannel" VARCHAR(16);
        -- Matches the history ordering (newest first, id as tie-break) so a page
        -- is an index range scan instead of a sort of the whole table.
        CREATE INDEX IF NOT EXISTS idx_access_logs_ts_id ON access_logs ("timestamp" DESC, id DESC);
        -- Per-face stranger records (2026-09-29): the faces an adjudication
        -- covers. A constant default makes the NOT NULL column catalog-only
        -- (no rewrite); old rows read '[]' and old code never names it.
        ALTER TABLE stranger_resolutions ADD COLUMN IF NOT EXISTS "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE stranger_resolution_events ADD COLUMN IF NOT EXISTS "faceIds" JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      try {
        await this.pgPool.query(PG_STRANGER_FACES_DDL);
        this.pgStrangerFacesReady = true;
      } catch (err) {
        console.error("[PostgreSQL] Lỗi khởi tạo bảng stranger_faces:", err);
      }
      try {
        await this.pgPool.query(PG_SHADOW_RESULTS_DDL);
        this.pgShadowResultsReady = true;
      } catch (err) {
        console.error("[PostgreSQL] Lỗi khởi tạo bảng pipeline_shadow_results:", err);
      }
      this.warnStrandedLocalStrangerFaces();
      await this.loadResolvedStrangerClusters();
      await this.loadStrangerResolutions();
      await this.loadStrangerResolutionEvents();
      await this.loadAiRecognitionConfig();
      await this.loadCameraStreamsConfig();
      await this.loadFaceTemplates();
      await this.loadUsers();
      await this.loadOrgCatalog();
      console.log("[PostgreSQL] Các bảng dữ liệu đã sẵn sàng trên PostgreSQL!");
    } catch (err) {
      console.error("[PostgreSQL] Lỗi khởi tạo bảng:", err);
    }
  }

  private init() {
    try {
      // Use Node.js 22 built-in native SQLite engine (DatabaseSync)
      const DatabaseSync = getDatabaseSyncClass();
      if (!DatabaseSync) {
        throw new Error("node:sqlite DatabaseSync is not available in current runtime");
      }
      this.db = new DatabaseSync(DB_PATH);
      this.isNativeSqlite = true;
      this.createTables();
      console.log(`[SQLite] Đã kết nối cơ sở dữ liệu SQLite thành công tại: ${DB_PATH}`);
    } catch (err: any) {
      console.warn(`[SQLite] Native SQLite không khả dụng (${err?.message}). Sử dụng bộ lưu trữ tệp dự phòng.`);
      this.initFallbackStorage();
    }
  }

  private createTables() {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        employeeCode TEXT UNIQUE NOT NULL,
        department TEXT,
        position TEXT,
        photoUrl TEXT,
        registeredAt TEXT,
        accessLevel TEXT DEFAULT 'ALL_ACCESS'
      );

      CREATE TABLE IF NOT EXISTS access_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        employeeId TEXT,
        employeeName TEXT,
        employeeCode TEXT,
        department TEXT,
        photoSnapshot TEXT,
        confidence REAL,
        livenessScore REAL,
        lockAction TEXT,
        doorName TEXT,
        reason TEXT,
        faceEmbedding BLOB,
        faceEmbeddingDims INTEGER,
        faceEmbeddingModelTag TEXT,
        faceEmbeddingQuality REAL,
        capturedAt TEXT,
        trackId TEXT,
        recordingChannel TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_access_logs_ts_id ON access_logs (timestamp DESC, id DESC);

      CREATE TABLE IF NOT EXISTS smart_lock_state (
        lockId TEXT PRIMARY KEY,
        doorName TEXT,
        state TEXT,
        isLocked INTEGER,
        batteryLevel INTEGER,
        signalDbm INTEGER,
        firmwareVersion TEXT,
        lastActionAt TEXT,
        lastActionBy TEXT,
        autoRelockSeconds INTEGER,
        status TEXT
      );

      CREATE TABLE IF NOT EXISTS webhook_config (
        id TEXT PRIMARY KEY,
        enabled INTEGER,
        url TEXT,
        gateInTitle TEXT,
        gateOutTitle TEXT,
        includeEmployeeCode INTEGER,
        strangerConfig TEXT
      );

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        url TEXT,
        method TEXT,
        payload TEXT,
        statusCode INTEGER,
        statusText TEXT,
        responseBody TEXT,
        success INTEGER,
        error TEXT,
        scanType TEXT,
        userName TEXT
      );

      CREATE TABLE IF NOT EXISTS mobile_notifications (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT,
        read INTEGER DEFAULT 0,
        employeeId TEXT,
        employeeName TEXT
      );

      CREATE TABLE IF NOT EXISTS door_controller_config (
        id TEXT PRIMARY KEY,
        enabled INTEGER,
        apiUrl TEXT,
        apiToken TEXT,
        authHeaderType TEXT,
        customHeaderName TEXT,
        openMethod TEXT,
        closeMethod TEXT,
        openPayloadTemplate TEXT,
        closePayloadTemplate TEXT,
        pulseDurationSeconds INTEGER,
        triggerOnFaceRecognition INTEGER,
        triggerOnManualUnlock INTEGER
      );

      CREATE TABLE IF NOT EXISTS door_api_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        requestHeaders TEXT,
        requestBody TEXT,
        statusCode INTEGER,
        statusText TEXT,
        responseBody TEXT,
        success INTEGER,
        error TEXT,
        durationMs INTEGER,
        triggeredBy TEXT
      );

      CREATE TABLE IF NOT EXISTS camera_streams_config (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_recognition_config (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updatedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS resolved_stranger_clusters (
        clusterId TEXT PRIMARY KEY,
        resolvedAt TEXT,
        resolvedBy TEXT
      );

      CREATE TABLE IF NOT EXISTS stranger_resolutions (
        id TEXT PRIMARY KEY,
        clusterId TEXT UNIQUE NOT NULL,
        action TEXT NOT NULL,
        employeeId TEXT,
        actor TEXT NOT NULL,
        resolvedAt TEXT NOT NULL,
        logIds TEXT NOT NULL,
        sourceLogId TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        faceIds TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS stranger_resolution_events (
        id TEXT PRIMARY KEY,
        clusterId TEXT NOT NULL,
        action TEXT NOT NULL,
        employeeId TEXT,
        actor TEXT NOT NULL,
        resolvedAt TEXT NOT NULL,
        logIds TEXT NOT NULL,
        sourceLogId TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        faceIds TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_stranger_resolution_events_cluster
        ON stranger_resolution_events (clusterId, resolvedAt);
    `);

    // Migration: databases created before the stranger alert existed have no
    // `strangerConfig` column. SQLite has no ADD COLUMN IF NOT EXISTS, so the
    // "duplicate column name" error simply means the migration already ran.
    try {
      this.db.exec(`ALTER TABLE webhook_config ADD COLUMN strangerConfig TEXT`);
    } catch {
      // column already present
    }
    for (const migration of [
      "ALTER TABLE access_logs ADD COLUMN faceEmbedding BLOB",
      "ALTER TABLE access_logs ADD COLUMN faceEmbeddingDims INTEGER",
      "ALTER TABLE access_logs ADD COLUMN faceEmbeddingModelTag TEXT",
      "ALTER TABLE access_logs ADD COLUMN faceEmbeddingQuality REAL",
      "ALTER TABLE access_logs ADD COLUMN capturedAt TEXT",
      "ALTER TABLE access_logs ADD COLUMN trackId TEXT",
      "ALTER TABLE access_logs ADD COLUMN recordingChannel TEXT",
      "ALTER TABLE stranger_resolutions ADD COLUMN faceIds TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE stranger_resolution_events ADD COLUMN faceIds TEXT NOT NULL DEFAULT '[]'",
    ]) {
      try { this.db.exec(migration); } catch { /* column already present */ }
    }
    try {
      this.db.exec(SQLITE_STRANGER_FACES_DDL);
      for (const migration of SQLITE_STRANGER_FACES_MIGRATIONS) {
        try { this.db.exec(migration); } catch { /* column already present */ }
      }
      this.db.exec(SQLITE_STRANGER_FACES_RECOGNISED_INDEX);
    } catch (err) {
      console.error("[SQLite] Lỗi khởi tạo bảng stranger_faces:", err);
    }
    try {
      this.db.exec(SQLITE_SHADOW_RESULTS_DDL);
    } catch (err) {
      console.error("[SQLite] Lỗi khởi tạo bảng pipeline_shadow_results:", err);
    }
  }

  // --- Fallback JSON storage in case node:sqlite is not present ---
  private fallbackData: {
    employees: EmployeeRecord[];
    access_logs: AccessLogRecord[];
    smart_lock_state?: SmartLockStateRecord;
    webhook_config?: WebhookConfigRecord;
    webhook_logs: WebhookLogRecord[];
    mobile_notifications: MobileNotificationRecord[];
    door_controller_config?: DoorControllerConfigRecord;
    door_api_logs: DoorApiLogRecord[];
    camera_streams_config?: CameraStreamsConfigRecord;
    resolved_stranger_clusters?: string[];
    stranger_resolutions?: StrangerResolutionRecord[];
    stranger_resolution_events?: StrangerResolutionRecord[];
    face_templates?: FaceTemplateRecord[];
    ai_recognition_config?: AiRecognitionConfigRecord;
    app_users?: UserRecord[];
    org_catalog?: OrgCatalogRecord;
    stranger_faces?: StrangerFaceJson[];
    pipeline_shadow_results?: ShadowResultRecord[];
  } = {
    employees: [],
    access_logs: [],
    webhook_logs: [],
    mobile_notifications: [],
    door_api_logs: [],
    resolved_stranger_clusters: [],
    stranger_resolutions: [],
  };

  private fallbackFile = path.join(DATA_DIR, "smartface_data.json");
  private fallbackStrangerHead: { log: AccessLogRecord; next: any } | null = null;
  private fallbackStrangerNodes = new Map<string, { log: AccessLogRecord; next: any }>();

  private isFallbackStrangerCandidate(log: AccessLogRecord): boolean {
    return Boolean(log.photoSnapshot) && (log.status === "DENIED" || !log.employeeId || log.employeeName === "Không xác định");
  }

  private prependFallbackStrangerCandidate(log: AccessLogRecord): void {
    if (!this.isFallbackStrangerCandidate(log) || this.fallbackStrangerNodes.has(log.id)) return;
    const node = { log, next: this.fallbackStrangerHead };
    this.fallbackStrangerHead = node;
    this.fallbackStrangerNodes.set(log.id, node);
  }

  /** JSON fallback: access logs that have stranger_faces rows (represented by their faces, not as a log). */
  private fallbackFaceLogIds = new Set<string>();

  private rebuildFallbackStrangerIndex(): void {
    this.fallbackStrangerHead = null;
    this.fallbackStrangerNodes.clear();
    for (let index = this.fallbackData.access_logs.length - 1; index >= 0; index -= 1) {
      this.prependFallbackStrangerCandidate(this.fallbackData.access_logs[index]);
    }
    this.fallbackFaceLogIds = new Set((this.fallbackData.stranger_faces || []).map((face) => face.logId));
  }

  private initFallbackStorage() {
    if (fs.existsSync(this.fallbackFile)) {
      try {
        const raw = fs.readFileSync(this.fallbackFile, "utf-8");
        this.fallbackData = JSON.parse(raw);
      } catch {}
    }
    this.rebuildFallbackStrangerIndex();
  }

  private writeFallback(data = this.fallbackData) {
    const tempFile = `${this.fallbackFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempFile, this.fallbackFile);
  }

  private saveFallback() {
    try {
      this.writeFallback();
    } catch {}
  }

  // ================= EMPLOYEES =================
  getEmployees(defaults: EmployeeRecord[]): EmployeeRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM employees ORDER BY registeredAt DESC").all();
        if (rows && rows.length > 0) {
          return rows as EmployeeRecord[];
        }
        // Seed initial employees
        for (const emp of defaults) {
          this.saveEmployee(emp);
        }
        return defaults;
      } catch (err) {
        console.error("[SQLite] Lỗi getEmployees:", err);
      }
    }
    if (this.fallbackData.employees.length === 0) {
      this.fallbackData.employees = [...defaults];
      this.saveFallback();
    }
    return this.fallbackData.employees;
  }

  async getEmployeeById(id: string): Promise<EmployeeRecord | undefined> {
    if (this.pgPool && this.isPostgres) {
      const result = await this.pgPool.query('SELECT id,name,"employeeCode",department,position,"photoUrl","registeredAt","accessLevel" FROM employees WHERE id=$1', [id]);
      return result.rows[0] as EmployeeRecord | undefined;
    }
    if (this.isNativeSqlite && this.db) {
      return this.db.prepare("SELECT * FROM employees WHERE id=?").get(id) as EmployeeRecord | undefined;
    }
    return this.fallbackData.employees.find((employee) => employee.id === id);
  }

  saveEmployee(emp: EmployeeRecord) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO employees (id, name, "employeeCode", department, position, "photoUrl", "registeredAt", "accessLevel")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          "employeeCode" = EXCLUDED."employeeCode",
          department = EXCLUDED.department,
          position = EXCLUDED.position,
          "photoUrl" = EXCLUDED."photoUrl",
          "accessLevel" = EXCLUDED."accessLevel"
      `, [emp.id, emp.name, emp.employeeCode, emp.department, emp.position, emp.photoUrl, emp.registeredAt, emp.accessLevel])
      .catch((e) => console.error("[PostgreSQL] Lỗi saveEmployee:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO employees (id, name, employeeCode, department, position, photoUrl, registeredAt, accessLevel)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            employeeCode = excluded.employeeCode,
            department = excluded.department,
            position = excluded.position,
            photoUrl = excluded.photoUrl,
            accessLevel = excluded.accessLevel
        `);
        stmt.run(
          emp.id,
          emp.name,
          emp.employeeCode,
          emp.department,
          emp.position,
          emp.photoUrl,
          emp.registeredAt,
          emp.accessLevel
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveEmployee:", err);
      }
    }
    const idx = this.fallbackData.employees.findIndex((e) => e.id === emp.id);
    if (idx >= 0) {
      this.fallbackData.employees[idx] = emp;
    } else {
      this.fallbackData.employees.unshift(emp);
    }
    this.saveFallback();
  }

  deleteEmployee(id: string) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM employees WHERE id = $1", [id])
        .catch((e) => console.error("[PostgreSQL] Lỗi deleteEmployee:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare("DELETE FROM employees WHERE id = ?");
        stmt.run(id);
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi deleteEmployee:", err);
      }
    }
    this.fallbackData.employees = this.fallbackData.employees.filter((e) => e.id !== id);
    this.saveFallback();
  }

  /**
   * Point every access log and notification that references `sourceId` at
   * `target`. Runs against the stores directly so rows outside the in-memory
   * window are covered too; the caller updates the cached arrays itself.
   */
  reassignEmployeeReferences(
    sourceId: string,
    target: { id: string; name: string; employeeCode: string; department: string }
  ) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query(
          `UPDATE access_logs SET "employeeId"=$1, "employeeName"=$2, "employeeCode"=$3, department=$4 WHERE "employeeId"=$5`,
          [target.id, target.name, target.employeeCode, target.department, sourceId]
        )
        .catch((e) => console.error("[PostgreSQL] Lỗi reassign access_logs:", e.message));
      this.pgPool
        .query(`UPDATE mobile_notifications SET "employeeId"=$1, "employeeName"=$2 WHERE "employeeId"=$3`, [
          target.id, target.name, sourceId,
        ])
        .catch((e) => console.error("[PostgreSQL] Lỗi reassign mobile_notifications:", e.message));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.db
          .prepare("UPDATE access_logs SET employeeId=?, employeeName=?, employeeCode=?, department=? WHERE employeeId=?")
          .run(target.id, target.name, target.employeeCode, target.department, sourceId);
        this.db
          .prepare("UPDATE mobile_notifications SET employeeId=?, employeeName=? WHERE employeeId=?")
          .run(target.id, target.name, sourceId);
      } catch (err) {
        console.error("[SQLite] Lỗi reassignEmployeeReferences:", err);
      }
    }
    for (const l of this.fallbackData.access_logs) {
      if (l.employeeId === sourceId) {
        l.employeeId = target.id; l.employeeName = target.name; l.employeeCode = target.employeeCode; l.department = target.department;
      }
    }
    for (const n of this.fallbackData.mobile_notifications) {
      if (n.employeeId === sourceId) { n.employeeId = target.id; n.employeeName = target.name; }
    }
    this.saveFallback();
  }

  // ================= ACCESS LOGS =================
  /** Waits (bounded) for in-flight PostgreSQL access-log inserts: one id, or all of them. */
  private async settleAccessLogWrites(id?: string): Promise<void> {
    const pending = id === undefined
      ? [...this.pendingAccessLogWrites.values()]
      : [this.pendingAccessLogWrites.get(id)].filter((p): p is Promise<boolean> => Boolean(p));
    if (!pending.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ACCESS_LOG_READ_YOUR_WRITES_MS); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  getAccessLogs(defaults: AccessLogRecord[]): AccessLogRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT 100").all();
        if (rows && rows.length > 0) {
          return rows.map(rowToAccessLog);
        }
        for (const log of defaults) {
          this.saveAccessLog(log);
        }
        return defaults;
      } catch (err) {
        console.error("[SQLite] Lỗi getAccessLogs:", err);
      }
    }
    if (this.fallbackData.access_logs.length === 0) {
      this.fallbackData.access_logs = [...defaults];
      this.rebuildFallbackStrangerIndex();
      this.saveFallback();
    }
    return this.fallbackData.access_logs;
  }

  /** Authoritative metadata page; unlike startup hydration this is not capped at 100 rows. */
  async getAccessLogsPage(page: number, limit: number): Promise<{ logs: AccessLogRecord[]; total: number }> {
    const offset = Math.max(0, (page - 1) * limit);
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites();
      const [rows, count] = await Promise.all([
        this.pgPool.query(
          `SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode", department,
                  confidence, "livenessScore", "lockAction", "doorName", reason,
                  "capturedAt", "trackId", "recordingChannel",
                  CASE WHEN "photoSnapshot" IS NOT NULL AND "photoSnapshot" <> '' THEN 1 ELSE 0 END AS "hasImage"
             FROM access_logs ORDER BY timestamp DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        this.pgPool.query("SELECT count(*)::int AS total FROM access_logs"),
      ]);
      return { logs: rows.rows.map((row: any) => ({ ...rowToAccessLog(row), photoSnapshot: row.hasImage ? "stored" : "" })), total: Number(count.rows[0]?.total || 0) };
    }
    if (this.isNativeSqlite && this.db) {
      const rows = this.db.prepare(`SELECT id, timestamp, type, status, employeeId, employeeName, employeeCode,
        department, confidence, livenessScore, lockAction, doorName, reason,
        capturedAt, trackId, recordingChannel,
        CASE WHEN photoSnapshot IS NOT NULL AND photoSnapshot <> '' THEN 1 ELSE 0 END AS hasImage
        FROM access_logs ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset) as any[];
      const count = this.db.prepare("SELECT count(*) AS total FROM access_logs").get() as any;
      return { logs: rows.map((row) => ({ ...rowToAccessLog(row), photoSnapshot: row.hasImage ? "stored" : "" })), total: Number(count?.total || 0) };
    }
    const sorted = this.fallbackData.access_logs.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
    return { logs: sorted.slice(offset, offset + limit).map((log) => ({
      ...log, photoSnapshot: log.photoSnapshot ? "stored" : "", faceEmbedding: undefined,
      faceEmbeddingModelTag: undefined, faceEmbeddingQuality: undefined,
    })), total: sorted.length };
  }

  private pgAccessLogWhere(f: AccessLogQuery, params: unknown[]): string[] {
    const where: string[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    if (f.status) where.push(`status = ${add(f.status)}`);
    if (f.type) where.push(`type = ${add(f.type)}`);
    if (f.from) where.push(`timestamp >= ${add(f.from)}`);
    if (f.to) where.push(`timestamp < ${add(f.to)}`);
    if (f.q) {
      const p = add(`%${escapeLike(f.q)}%`);
      where.push(`("employeeName" ILIKE ${p} OR "employeeCode" ILIKE ${p} OR department ILIKE ${p} OR reason ILIKE ${p})`);
    }
    return where;
  }

  private sqliteAccessLogWhere(f: AccessLogQuery, params: unknown[]): string[] {
    const where: string[] = [];
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    if (f.type) { where.push("type = ?"); params.push(f.type); }
    if (f.from) { where.push("timestamp >= ?"); params.push(f.from); }
    if (f.to) { where.push("timestamp < ?"); params.push(f.to); }
    if (f.q) {
      // SQLite LIKE folds ASCII case only; accented Vietnamese matches exactly.
      const p = `%${escapeLike(f.q)}%`;
      where.push("(employeeName LIKE ? ESCAPE '\\' OR employeeCode LIKE ? ESCAPE '\\' OR department LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')");
      params.push(p, p, p, p);
    }
    return where;
  }

  /**
   * One page of history, newest first, continuing strictly after `cursor`
   * (keyset paging: page 500 costs the same as page 1). `total` counts every
   * row matching the filters. Image bytes and face data are never read.
   */
  async queryAccessLogs(
    f: AccessLogQuery,
    cursor: { timestamp: string; id: string } | null,
    limit: number,
  ): Promise<{ logs: AccessLogRecord[]; hasMore: boolean; total: number }> {
    const n = Math.min(200, Math.max(1, Math.trunc(limit)));
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites();
      const params: unknown[] = [];
      const where = this.pgAccessLogWhere(f, params);
      const countSql = `SELECT count(*)::int AS total FROM access_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
      const countParams = [...params];
      if (cursor) {
        params.push(cursor.timestamp, cursor.id);
        where.push(`(timestamp, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(n + 1);
      const [rows, count] = await Promise.all([
        this.pgPool.query(
          `SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode", department,
                  confidence, "livenessScore", "lockAction", "doorName", reason,
                  "capturedAt", "trackId", "recordingChannel",
                  CASE WHEN "photoSnapshot" IS NOT NULL AND "photoSnapshot" <> '' THEN 1 ELSE 0 END AS "hasImage"
             FROM access_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY timestamp DESC, id DESC LIMIT $${params.length}`,
          params,
        ),
        this.pgPool.query(countSql, countParams),
      ]);
      const logs = rows.rows.map((row: any) => ({ ...rowToAccessLog(row), photoSnapshot: row.hasImage ? "stored" : "" }));
      return { logs: logs.slice(0, n), hasMore: logs.length > n, total: Number(count.rows[0]?.total || 0) };
    }
    if (this.isNativeSqlite && this.db) {
      const params: unknown[] = [];
      const where = this.sqliteAccessLogWhere(f, params);
      const count = this.db.prepare(`SELECT count(*) AS total FROM access_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...(params as any[])) as any;
      if (cursor) {
        where.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
        params.push(cursor.timestamp, cursor.timestamp, cursor.id);
      }
      const rows = this.db.prepare(`SELECT id, timestamp, type, status, employeeId, employeeName, employeeCode,
        department, confidence, livenessScore, lockAction, doorName, reason,
        capturedAt, trackId, recordingChannel,
        CASE WHEN photoSnapshot IS NOT NULL AND photoSnapshot <> '' THEN 1 ELSE 0 END AS hasImage
        FROM access_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...(params as any[]), n + 1) as any[];
      const logs = rows.map((row) => ({ ...rowToAccessLog(row), photoSnapshot: row.hasImage ? "stored" : "" }));
      return { logs: logs.slice(0, n), hasMore: logs.length > n, total: Number(count?.total || 0) };
    }
    const matching = this.fallbackData.access_logs
      .filter((log) => matchesAccessLogQuery(log, f))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
    const after = cursor
      ? matching.filter((l) => l.timestamp < cursor.timestamp || (l.timestamp === cursor.timestamp && l.id < cursor.id))
      : matching;
    const logs = after.slice(0, n).map((log) => ({
      ...log, photoSnapshot: log.photoSnapshot ? "stored" : "", faceEmbedding: undefined,
      faceEmbeddingModelTag: undefined, faceEmbeddingQuality: undefined,
    }));
    return { logs, hasMore: after.length > n, total: matching.length };
  }

  /** Totals, hour-of-day buckets (in `timeZone`) and granted entries per department for the filters. */
  async accessLogStats(f: AccessLogQuery, timeZone: string): Promise<AccessLogStats> {
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites();
      const params: unknown[] = [];
      const where = this.pgAccessLogWhere(f, params);
      // Only well-formed ISO instants can be bucketed; anything else is skipped, not fatal.
      where.push(`timestamp ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`);
      const clause = "WHERE " + where.join(" AND ");
      // Postgres refuses a parameter it cannot type, so the time zone is added
      // only to the query that uses it, and cast explicitly.
      const deptParams = [...params];
      params.push(timeZone);
      const tz = `$${params.length}::text`;
      const [hours, depts] = await Promise.all([
        this.pgPool.query(
          `SELECT extract(hour FROM (timestamp::timestamptz AT TIME ZONE ${tz}))::int AS h,
                  count(*)::int AS scans,
                  count(*) FILTER (WHERE status = 'GRANTED')::int AS granted,
                  count(*) FILTER (WHERE status = 'DENIED')::int AS denied,
                  count(*) FILTER (WHERE type = 'ENTRY')::int AS entries,
                  count(*) FILTER (WHERE type = 'ENTRY' AND status = 'GRANTED')::int AS granted_entries,
                  count(*) FILTER (WHERE type = 'EXIT')::int AS exits
             FROM access_logs ${clause} GROUP BY 1`,
          params,
        ),
        this.pgPool.query(
          `SELECT coalesce(nullif(department, ''), 'Khác') AS name, count(*)::int AS count
             FROM access_logs ${clause} AND type = 'ENTRY' AND status = 'GRANTED'
            GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
          deptParams,
        ),
      ]);
      const stats: AccessLogStats = { total: 0, granted: 0, denied: 0, entries: 0, exits: 0, byHour: emptyHours(), grantedEntriesByDepartment: [] };
      for (const r of hours.rows) {
        stats.total += r.scans; stats.granted += r.granted; stats.denied += r.denied; stats.entries += r.entries; stats.exits += r.exits;
        const b = stats.byHour[r.h];
        if (b) Object.assign(b, { totalScans: r.scans, totalEntries: r.entries, grantedEntries: r.granted_entries, deniedEntries: r.entries - r.granted_entries, exits: r.exits });
      }
      stats.grantedEntriesByDepartment = depts.rows.map((r: any) => ({ name: r.name, count: r.count }));
      return stats;
    }
    if (this.isNativeSqlite && this.db) {
      const params: unknown[] = [];
      const where = this.sqliteAccessLogWhere(f, params);
      const rows = this.db.prepare(`SELECT timestamp, type, status, department FROM access_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}`).all(...(params as any[])) as any[];
      return accumulateStats(rows, timeZone);
    }
    return accumulateStats(this.fallbackData.access_logs.filter((log) => matchesAccessLogQuery(log, f)), timeZone);
  }

  /**
   * When and at which gate an event happened, without its image or face data.
   * getAccessLogById below is NOT a general lookup on PostgreSQL: it loads only
   * id + photoSnapshot for the image route, so its timestamp/type are undefined.
   */
  async getAccessLogMetaById(id: string): Promise<AccessLogMeta | undefined> {
    const meta = (r: any): AccessLogMeta => ({
      id: r.id,
      timestamp: r.timestamp,
      type: r.type,
      status: r.status,
      capturedAt: optionalText(r.capturedAt),
      trackId: optionalText(r.trackId),
      recordingChannel: optionalText(r.recordingChannel),
    });
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites(id);
      const result = await this.pgPool.query(
        `SELECT id, timestamp, type, status, "capturedAt", "trackId", "recordingChannel"
           FROM access_logs WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? meta(result.rows[0]) : undefined;
    }
    if (this.isNativeSqlite && this.db) {
      const row = this.db.prepare(
        "SELECT id, timestamp, type, status, capturedAt, trackId, recordingChannel FROM access_logs WHERE id = ?",
      ).get(id) as any;
      return row ? meta(row) : undefined;
    }
    const row = this.fallbackData.access_logs.find((log) => log.id === id);
    return row ? meta(row) : undefined;
  }

  async getAccessLogById(id: string): Promise<AccessLogRecord | undefined> {
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites(id);
      const result = await this.pgPool.query(
        `SELECT id, "photoSnapshot" FROM access_logs WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? rowToAccessLog(result.rows[0]) : undefined;
    }
    if (this.isNativeSqlite && this.db) {
      const row = this.db.prepare("SELECT * FROM access_logs WHERE id = ?").get(id) as any;
      return row ? rowToAccessLog(row) : undefined;
    }
    const row = this.fallbackData.access_logs.find((log) => log.id === id);
    return row ? { ...row, faceEmbedding: row.faceEmbedding ? [...row.faceEmbedding] : undefined } : undefined;
  }

  /**
   * Bounded keyset page of authoritative stranger candidates. The cursor is the
   * last `(timestamp,id)` pair returned by the previous page; no request loads
   * or reclusters the complete access-log history. Access logs that have at
   * least one stranger_faces row (purged or not) are excluded: they are
   * represented by their faces (`face:<id>`), never as a whole-frame `log:<id>`.
   */
  async getStrangerCandidateLogsPage(
    cursor: { timestamp: string; id: string } | null,
    limit: number,
  ): Promise<{ logs: AccessLogRecord[]; hasMore: boolean }> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const fetchLimit = boundedLimit + 1;
    if (this.pgPool && this.isPostgres) {
      await this.settleAccessLogWrites();
      const params: unknown[] = [];
      const cursorWhere = cursor
        ? ` AND (timestamp, id) < ($1, $2)`
        : "";
      if (cursor) params.push(cursor.timestamp, cursor.id);
      params.push(fetchLimit);
      const limitParam = `$${params.length}`;
      const result = await this.pgPool.query(
          `SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode", department,
                  CASE WHEN "photoSnapshot" IS NOT NULL AND "photoSnapshot" <> '' THEN 'stored' ELSE '' END AS "photoSnapshot",
                  confidence, "livenessScore", "lockAction", "doorName", reason,
                  "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality",
                  "capturedAt", "trackId", "recordingChannel"
             FROM access_logs
            WHERE "photoSnapshot" IS NOT NULL AND "photoSnapshot" <> ''
              AND (status = 'DENIED' OR "employeeId" IS NULL OR "employeeName" = 'Không xác định')${cursorWhere}
              ${this.pgStrangerFacesReady ? `AND NOT EXISTS (SELECT 1 FROM stranger_faces sf WHERE sf."logId" = access_logs.id)` : ""}
            ORDER BY timestamp DESC, id DESC LIMIT ${limitParam}`,
          params,
        );
      const rows = result.rows.map(rowToAccessLog);
      return { logs: rows.slice(0, boundedLimit), hasMore: rows.length > boundedLimit };
    }
    if (this.isNativeSqlite && this.db) {
      const cursorWhere = cursor ? " AND (timestamp < ? OR (timestamp = ? AND id < ?))" : "";
      const params = cursor ? [cursor.timestamp, cursor.timestamp, cursor.id, fetchLimit] : [fetchLimit];
      const rows = this.db.prepare(
        `SELECT id, timestamp, type, status, employeeId, employeeName, employeeCode, department,
                CASE WHEN photoSnapshot IS NOT NULL AND photoSnapshot <> '' THEN 'stored' ELSE '' END AS photoSnapshot,
                confidence, livenessScore, lockAction, doorName, reason,
                faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality,
                capturedAt, trackId, recordingChannel FROM access_logs
          WHERE photoSnapshot IS NOT NULL AND photoSnapshot <> ''
            AND (status = 'DENIED' OR employeeId IS NULL OR employeeName = 'Không xác định')${cursorWhere}
            AND NOT EXISTS (SELECT 1 FROM stranger_faces sf WHERE sf.logId = access_logs.id)
          ORDER BY timestamp DESC, id DESC LIMIT ?`,
      ).all(...params) as any[];
      return { logs: rows.slice(0, boundedLimit).map(rowToAccessLog), hasMore: rows.length > boundedLimit };
    }
    let node = cursor ? this.fallbackStrangerNodes.get(cursor.id)?.next || null : this.fallbackStrangerHead;
    const rows: AccessLogRecord[] = [];
    while (node && rows.length < fetchLimit) {
      if (!this.fallbackFaceLogIds.has(node.log.id)) rows.push(node.log);
      node = node.next;
    }
    return {
      logs: rows.slice(0, boundedLimit).map((log) => ({ ...log, photoSnapshot: "stored", faceEmbedding: log.faceEmbedding ? [...log.faceEmbedding] : undefined })),
      hasMore: rows.length > boundedLimit,
    };
  }

  async getStrangerCandidateLogById(id: string): Promise<AccessLogRecord | undefined> {
    if (!this.pgPool && !this.isNativeSqlite) {
      const log = this.fallbackStrangerNodes.get(id)?.log;
      return log ? { ...log, photoSnapshot: "stored", faceEmbedding: log.faceEmbedding ? [...log.faceEmbedding] : undefined } : undefined;
    }
    const log = await this.getAccessLogById(id);
    if (!log?.photoSnapshot || !(log.status === "DENIED" || !log.employeeId || log.employeeName === "Không xác định")) return undefined;
    return { ...log, photoSnapshot: "stored", faceEmbedding: log.faceEmbedding ? [...log.faceEmbedding] : undefined };
  }

  /** Observation ids covered by a current adjudication: `log:<id>` per logId, `face:<id>` per faceId. */
  getRetiredStrangerObservationIds(): string[] {
    return this.getStrangerResolutions().flatMap((resolution) => [
      ...resolution.logIds.map((id) => `log:${id}`),
      ...(resolution.faceIds || []).map((id) => `face:${id}`),
    ]);
  }

  // ================= STRANGER FACES =================
  // Exactly one store holds stranger faces at a time: PostgreSQL when it is
  // the active authority, else native SQLite, else the JSON file. Unlike access
  // logs there is no local mirror while PostgreSQL is active - these are
  // biometric crops and embeddings, and a second copy would escape retention.
  // While PostgreSQL is configured but still connecting (or its stranger_faces
  // migration failed) writes are refused (false) and reads are empty, rather
  // than landing in a local store the gateway stops reading once connected.

  /**
   * Faces written to the local store during an earlier fallback period are not
   * read once PostgreSQL is active. Say so at startup instead of hiding them;
   * the retention purge still clears their crops and embeddings.
   */
  private warnStrandedLocalStrangerFaces(): void {
    let count = 0;
    try {
      if (this.isNativeSqlite && this.db) {
        count = Number((this.db.prepare("SELECT count(*) AS n FROM stranger_faces WHERE purgedAt IS NULL").get() as any)?.n || 0);
      } else {
        count = (this.fallbackData.stranger_faces || []).filter((face) => !face.purgedAt).length;
      }
    } catch {}
    if (count) {
      console.warn(`[StrangerFaces] ${count} khuôn mặt người lạ chỉ nằm trong kho cục bộ (ghi khi PostgreSQL không khả dụng); bảng người lạ không hiển thị chúng.`);
    }
  }

  /**
   * The one store a single-authority table lives in: PostgreSQL when it is the
   * active authority and the table's migration ran (`pgReady`), null while
   * PostgreSQL is configured but not usable yet, else native SQLite, else JSON.
   */
  private singleStoreMode(pgReady: boolean): "postgresql" | "sqlite" | "json" | null {
    if (this.pgPool && this.isPostgres) return pgReady ? "postgresql" : null;
    if (this.storage.connecting) return null;
    if (this.isNativeSqlite && this.db) return "sqlite";
    return "json";
  }

  private strangerFaceMode(): "postgresql" | "sqlite" | "json" | null {
    return this.singleStoreMode(this.pgStrangerFacesReady);
  }

  /**
   * Insert faces of access events (StrangerFaceStore.saveStrangerFaces).
   *
   * All-or-nothing per call: a malformed face, or a face whose access event is
   * not stored, refuses the whole batch (false, nothing written). Replays are
   * no-ops by id, and by (logId, faceIndex) so a writer retrying a frame with
   * fresh ids does not duplicate its faces: the first row for a slot wins.
   * Resolves true once the authoritative store has a row for every face slot.
   * Never rejects.
   */
  async saveStrangerFaces(faces: StrangerFaceRecord[]): Promise<boolean> {
    if (!Array.isArray(faces)) return false;
    const rows: StrangerFaceRow[] = [];
    const ids = new Set<string>();
    const slots = new Set<string>();
    for (const face of faces) {
      const { row, error } = normalizeStrangerFace(face);
      if (!row) {
        console.warn(`[StrangerFaces] Từ chối lưu ${faces.length} khuôn mặt: trường không hợp lệ (${error}).`);
        return false;
      }
      const slot = `${row.logId}\u0000${row.faceIndex}`;
      if (ids.has(row.id) || slots.has(slot)) continue;
      ids.add(row.id);
      slots.add(slot);
      rows.push(row);
    }
    if (!rows.length) return true;
    const logIds = [...new Set(rows.map((row) => row.logId))];
    const mode = this.strangerFaceMode();
    if (!mode) {
      console.warn(`[StrangerFaces] PostgreSQL chưa sẵn sàng; chưa lưu ${rows.length} khuôn mặt.`);
      return false;
    }

    if (mode === "postgresql") {
      // The access event may still be in flight (saveAccessLog is often not
      // awaited); the foreign key needs it first.
      await Promise.all(logIds.map((id) => this.settleAccessLogWrites(id)));
      const params: unknown[] = [];
      const values = rows.map((row) => {
        const start = params.length;
        params.push(...strangerFaceInsertParams(row, JSON.stringify(row.box)));
        // $9 is the box (jsonb); the rest bind as their column types.
        const placeholders = Array.from({ length: STRANGER_FACE_INSERT_PARAM_COUNT }, (_, i) => `$${start + i + 1}${i === 8 ? "::jsonb" : ""}`);
        return `(${placeholders.join(",")})`;
      });
      try {
        await this.pgPool!.query(
          `INSERT INTO stranger_faces (${STRANGER_FACE_INSERT_COLUMNS_PG})
           VALUES ${values.join(",")}
           ON CONFLICT DO NOTHING`,
          params,
        );
        return true;
      } catch (err: any) {
        console.error(`[PostgreSQL] Lỗi saveStrangerFaces (${err?.code || "?"}): ${err?.message}`);
        return false;
      }
    }

    if (mode === "sqlite") {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (err: any) {
        console.error("[SQLite] Lỗi saveStrangerFaces:", err?.message);
        return false;
      }
      try {
        const exists = this.db.prepare("SELECT 1 AS ok FROM access_logs WHERE id = ?");
        const missing = logIds.find((id) => !exists.get(id));
        if (missing) {
          this.db.exec("ROLLBACK");
          console.warn("[StrangerFaces] Từ chối lưu khuôn mặt: sự kiện truy cập chưa tồn tại.");
          return false;
        }
        const insert = this.db.prepare(
          `INSERT INTO stranger_faces (${STRANGER_FACE_INSERT_COLUMNS_SQLITE})
           VALUES (${Array(STRANGER_FACE_INSERT_PARAM_COUNT).fill("?").join(",")})
           ON CONFLICT DO NOTHING`,
        );
        for (const row of rows) insert.run(...strangerFaceInsertParams(row, JSON.stringify(row.box)));
        this.db.exec("COMMIT");
        return true;
      } catch (err: any) {
        try { this.db.exec("ROLLBACK"); } catch {}
        console.error("[SQLite] Lỗi saveStrangerFaces:", err?.message);
        return false;
      }
    }

    const known = new Set(this.fallbackData.access_logs.map((log) => log.id));
    if (logIds.some((id) => !known.has(id))) {
      console.warn("[StrangerFaces] Từ chối lưu khuôn mặt: sự kiện truy cập chưa tồn tại.");
      return false;
    }
    const existing = this.fallbackData.stranger_faces || [];
    const storedIds = new Set(existing.map((face) => face.id));
    const storedSlots = new Set(existing.map((face) => `${face.logId}\u0000${face.faceIndex}`));
    const fresh = rows
      .filter((row) => !storedIds.has(row.id) && !storedSlots.has(`${row.logId}\u0000${row.faceIndex}`))
      .map(strangerFaceRowToJson);
    if (!fresh.length) return true;
    const staged = [...fresh, ...existing];
    try {
      this.writeFallback({ ...this.fallbackData, stranger_faces: staged });
    } catch (err: any) {
      console.error("[JSON] Lỗi saveStrangerFaces:", err?.message);
      return false;
    }
    this.fallbackData.stranger_faces = staged;
    for (const face of fresh) this.fallbackFaceLogIds.add(face.logId);
    return true;
  }

  /**
   * StrangerFaceStore.getStrangerFacesPage: newest first, purged rows excluded,
   * never the crop. Recognised-face observations (employeeId set) are not
   * strangers and are excluded too: they never reach stranger grouping.
   */
  async getStrangerFacesPage(cursor: { capturedAt: string; id: string } | null, limit: number): Promise<StrangerFacePage> {
    const n = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const after = cursor ? { capturedAt: String(cursor.capturedAt), id: String(cursor.id) } : null;
    const mode = this.strangerFaceMode();
    let rows: StrangerFaceRecord[] = [];
    if (mode === "postgresql") {
      const params: unknown[] = [];
      let where = `"purgedAt" IS NULL AND "employeeId" IS NULL`;
      if (after) {
        params.push(after.capturedAt, after.id);
        where += ` AND ("capturedAt", id) < ($1, $2)`;
      }
      params.push(n + 1);
      const result = await this.pgPool!.query(
        `SELECT ${STRANGER_FACE_COLUMNS_PG} FROM stranger_faces WHERE ${where}
          ORDER BY "capturedAt" DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      rows = result.rows.map(rowToStrangerFace);
    } else if (mode === "sqlite") {
      const params: unknown[] = [];
      let where = "purgedAt IS NULL AND employeeId IS NULL";
      if (after) {
        where += " AND (capturedAt < ? OR (capturedAt = ? AND id < ?))";
        params.push(after.capturedAt, after.capturedAt, after.id);
      }
      rows = (this.db.prepare(
        `SELECT ${STRANGER_FACE_COLUMNS_SQLITE} FROM stranger_faces WHERE ${where}
          ORDER BY capturedAt DESC, id DESC LIMIT ?`,
      ).all(...params, n + 1) as any[]).map(rowToStrangerFace);
    } else if (mode === "json") {
      rows = (this.fallbackData.stranger_faces || [])
        .filter((face) => !face.purgedAt && !face.employeeId)
        .filter((face) => !after || face.capturedAt < after.capturedAt || (face.capturedAt === after.capturedAt && face.id < after.id))
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, n + 1)
        .map(jsonToStrangerFace);
    }
    return { faces: rows.slice(0, n), hasMore: rows.length > n };
  }

  /** StrangerFaceStore.getStrangerFacesByIds: purged rows included, never the crop. */
  async getStrangerFacesByIds(ids: string[]): Promise<StrangerFaceRecord[]> {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && id.length <= 64))];
    if (!wanted.length) return [];
    const mode = this.strangerFaceMode();
    if (mode === "postgresql") {
      const result = await this.pgPool!.query(
        `SELECT ${STRANGER_FACE_COLUMNS_PG} FROM stranger_faces WHERE id = ANY($1::varchar[])`,
        [wanted],
      );
      return result.rows.map(rowToStrangerFace);
    }
    if (mode === "sqlite") {
      return (this.db.prepare(
        `SELECT ${STRANGER_FACE_COLUMNS_SQLITE} FROM stranger_faces WHERE id IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(wanted)) as any[]).map(rowToStrangerFace);
    }
    if (mode === "json") {
      const set = new Set(wanted);
      return (this.fallbackData.stranger_faces || []).filter((face) => set.has(face.id)).map(jsonToStrangerFace);
    }
    return [];
  }

  /**
   * Faces of the given access events, ordered by logId then faceIndex; purged
   * rows included, never the crop. Not part of StrangerFaceStore: serves the
   * `#strangers/<logId>` lookup and lets a writer re-read the ids a retried
   * frame actually kept.
   */
  async getStrangerFacesByLogIds(logIds: string[]): Promise<StrangerFaceRecord[]> {
    const wanted = [...new Set((Array.isArray(logIds) ? logIds : []).filter((id): id is string => typeof id === "string" && id.length <= 64))];
    if (!wanted.length) return [];
    const mode = this.strangerFaceMode();
    if (mode === "postgresql") {
      const result = await this.pgPool!.query(
        `SELECT ${STRANGER_FACE_COLUMNS_PG} FROM stranger_faces WHERE "logId" = ANY($1::varchar[]) ORDER BY "logId", "faceIndex"`,
        [wanted],
      );
      return result.rows.map(rowToStrangerFace);
    }
    if (mode === "sqlite") {
      return (this.db.prepare(
        `SELECT ${STRANGER_FACE_COLUMNS_SQLITE} FROM stranger_faces WHERE logId IN (SELECT value FROM json_each(?)) ORDER BY logId, faceIndex`,
      ).all(JSON.stringify(wanted)) as any[]).map(rowToStrangerFace);
    }
    if (mode === "json") {
      const set = new Set(wanted);
      return (this.fallbackData.stranger_faces || [])
        .filter((face) => set.has(face.logId))
        .sort((a, b) => (a.logId < b.logId ? -1 : a.logId > b.logId ? 1 : a.faceIndex - b.faceIndex))
        .map(jsonToStrangerFace);
    }
    return [];
  }

  /**
   * StrangerFaceStore.getRecognisedFaceObservations: faces the door engine
   * granted (employeeId set), not purged, captured at or after `sinceIso`,
   * newest first by (capturedAt DESC, id DESC); embedding included, never the
   * crop; optional employee filter; limit clamped 1..2000 (default: the cap).
   * An unparseable `sinceIso` throws RangeError; an employeeId that could not
   * be stored matches nothing.
   */
  async getRecognisedFaceObservations(sinceIso: string, employeeId?: string, limit?: number): Promise<StrangerFaceRecord[]> {
    const since = normIso(sinceIso);
    if (!since) throw new RangeError("getRecognisedFaceObservations: invalid since");
    const n = Math.min(2000, Math.max(1, Number.isFinite(limit as number) ? Math.trunc(limit as number) : 2000));
    let who: string | null = null;
    if (employeeId !== undefined && employeeId !== null && employeeId !== "") {
      if (typeof employeeId !== "string" || !EMPLOYEE_ID_RE.test(employeeId)) return [];
      who = employeeId;
    }
    const mode = this.strangerFaceMode();
    if (mode === "postgresql") {
      const params: unknown[] = [since];
      let where = `"employeeId" IS NOT NULL AND "purgedAt" IS NULL AND "capturedAt" >= $1`;
      if (who) {
        params.push(who);
        where += ` AND "employeeId" = $${params.length}`;
      }
      params.push(n);
      const result = await this.pgPool!.query(
        `SELECT ${STRANGER_FACE_COLUMNS_PG} FROM stranger_faces WHERE ${where}
          ORDER BY "capturedAt" DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(rowToStrangerFace);
    }
    if (mode === "sqlite") {
      const params: unknown[] = [since];
      let where = "employeeId IS NOT NULL AND purgedAt IS NULL AND capturedAt >= ?";
      if (who) {
        where += " AND employeeId = ?";
        params.push(who);
      }
      return (this.db.prepare(
        `SELECT ${STRANGER_FACE_COLUMNS_SQLITE} FROM stranger_faces WHERE ${where}
          ORDER BY capturedAt DESC, id DESC LIMIT ?`,
      ).all(...params, n) as any[]).map(rowToStrangerFace);
    }
    if (mode === "json") {
      return (this.fallbackData.stranger_faces || [])
        .filter((face) => face.employeeId && !face.purgedAt && face.capturedAt >= since && (!who || face.employeeId === who))
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, n)
        .map(jsonToStrangerFace);
    }
    return [];
  }

  /** StrangerFaceStore.getStrangerFaceCrop: the JPEG bytes, or undefined (unknown, purged, or stored without a crop). */
  async getStrangerFaceCrop(id: string): Promise<Buffer | undefined> {
    if (typeof id !== "string" || !id || id.length > 64) return undefined;
    const mode = this.strangerFaceMode();
    let crop: unknown = null;
    if (mode === "postgresql") {
      const result = await this.pgPool!.query(`SELECT crop FROM stranger_faces WHERE id = $1 AND "purgedAt" IS NULL`, [id]);
      crop = result.rows[0]?.crop;
    } else if (mode === "sqlite") {
      crop = (this.db.prepare("SELECT crop FROM stranger_faces WHERE id = ? AND purgedAt IS NULL").get(id) as any)?.crop;
    } else if (mode === "json") {
      const face = (this.fallbackData.stranger_faces || []).find((item) => item.id === id);
      crop = face && !face.purgedAt && face.crop ? Buffer.from(face.crop, "base64") : null;
    }
    if (!crop || !(crop instanceof Uint8Array) || crop.length === 0) return undefined;
    return Buffer.isBuffer(crop) ? crop : Buffer.from(crop);
  }

  /**
   * StrangerFaceStore.purgeStrangerFaces: clear crop + embedding and set
   * purgedAt on every non-purged face captured before `cutoffIso` that is not
   * in keepIds. The row (box, scores, dims, modelTag, logId) stays as an audit
   * tombstone and keeps its access event out of the log-level candidates.
   * Returns the rows purged in the authoritative store. An unparseable cutoff
   * throws (a retention job must not silently purge nothing).
   *
   * With PostgreSQL active, faces left in the local SQLite/JSON store by an
   * earlier fallback period are purged on the same clock (logged, not counted).
   */
  async purgeStrangerFaces(cutoffIso: string, keepIds: ReadonlySet<string>): Promise<number> {
    const cutoff = normIso(cutoffIso);
    if (!cutoff) throw new RangeError("purgeStrangerFaces: invalid cutoff");
    const keep = [...(keepIds || new Set<string>())].filter((id) => typeof id === "string");
    const now = new Date().toISOString();
    const mode = this.strangerFaceMode();
    if (mode === "postgresql") {
      const result = await this.pgPool!.query(
        `UPDATE stranger_faces SET crop = NULL, embedding = NULL, "purgedAt" = $1
          WHERE "purgedAt" IS NULL AND "capturedAt" < $2 AND NOT (id = ANY($3::varchar[]))`,
        [now, cutoff, keep],
      );
      let stranded = 0;
      try {
        stranded = this.purgeLocalStrangerFaces(cutoff, keep, now);
      } catch (err: any) {
        console.error("[StrangerFaces] Lỗi xoá khuôn mặt trong kho cục bộ:", err?.message);
      }
      if (stranded) console.warn(`[StrangerFaces] Đã xoá ảnh/embedding của ${stranded} khuôn mặt chỉ còn trong kho cục bộ.`);
      return result.rowCount || 0;
    }
    if (mode === "sqlite" || mode === "json") return this.purgeLocalStrangerFaces(cutoff, keep, now);
    return 0;
  }

  private purgeLocalStrangerFaces(cutoff: string, keep: string[], now: string): number {
    if (this.isNativeSqlite && this.db) {
      const result = this.db.prepare(
        `UPDATE stranger_faces SET crop = NULL, embedding = NULL, purgedAt = ?
          WHERE purgedAt IS NULL AND capturedAt < ? AND id NOT IN (SELECT value FROM json_each(?))`,
      ).run(now, cutoff, JSON.stringify(keep));
      return Number(result?.changes || 0);
    }
    const current = this.fallbackData.stranger_faces || [];
    const keepSet = new Set(keep);
    let purged = 0;
    const staged = current.map((face) => {
      if (face.purgedAt || !(face.capturedAt < cutoff) || keepSet.has(face.id)) return face;
      purged += 1;
      const { crop: _crop, embedding: _embedding, ...rest } = face;
      return { ...rest, purgedAt: now };
    });
    if (!purged) return 0;
    this.writeFallback({ ...this.fallbackData, stranger_faces: staged });
    this.fallbackData.stranger_faces = staged;
    return purged;
  }

  // ================= SHADOW RESULTS (accuracy wave) =================
  // Same single-authority rule as stranger faces: PostgreSQL when active (once
  // its table exists), else SQLite, else JSON; refused (false / empty) while
  // PostgreSQL is configured but not usable, so rows never land in a store the
  // gateway stops reading once connected. Nothing biometric is stored here.

  private shadowResultMode(): "postgresql" | "sqlite" | "json" | null {
    return this.singleStoreMode(this.pgShadowResultsReady);
  }

  /**
   * ShadowResultStore.saveShadowResult: insert, replay by id is a no-op. True
   * once the authoritative store has the row (awaited); false for a malformed
   * record, a store error, or PostgreSQL not ready. Never rejects.
   */
  async saveShadowResult(record: ShadowResultRecord): Promise<boolean> {
    const { row, error } = normalizeShadowResult(record);
    if (!row) {
      console.warn(`[ShadowResults] Từ chối lưu kết quả shadow: trường không hợp lệ (${error}).`);
      return false;
    }
    const mode = this.shadowResultMode();
    if (!mode) {
      console.warn("[ShadowResults] PostgreSQL chưa sẵn sàng; chưa lưu kết quả shadow.");
      return false;
    }
    if (mode === "postgresql") {
      try {
        await this.pgPool!.query(
          `INSERT INTO pipeline_shadow_results (${SHADOW_RESULT_COLUMNS_PG})
           VALUES (${Array.from({ length: SHADOW_RESULT_PARAM_COUNT }, (_, i) => `$${i + 1}`).join(",")})
           ON CONFLICT (id) DO NOTHING`,
          shadowResultInsertParams(row, row.meanCheckRefused),
        );
        return true;
      } catch (err: any) {
        console.error(`[PostgreSQL] Lỗi saveShadowResult (${err?.code || "?"}): ${err?.message}`);
        return false;
      }
    }
    if (mode === "sqlite") {
      try {
        this.db.prepare(
          `INSERT INTO pipeline_shadow_results (${SHADOW_RESULT_COLUMNS_SQLITE})
           VALUES (${Array(SHADOW_RESULT_PARAM_COUNT).fill("?").join(",")})
           ON CONFLICT (id) DO NOTHING`,
        ).run(...shadowResultInsertParams(row, row.meanCheckRefused === null ? null : row.meanCheckRefused ? 1 : 0));
        return true;
      } catch (err: any) {
        console.error("[SQLite] Lỗi saveShadowResult:", err?.message);
        return false;
      }
    }
    const existing = this.fallbackData.pipeline_shadow_results || [];
    if (existing.some((item) => item.id === row.id)) return true;
    const staged = [rowToShadowResult(row), ...existing];
    try {
      this.writeFallback({ ...this.fallbackData, pipeline_shadow_results: staged });
    } catch (err: any) {
      console.error("[JSON] Lỗi saveShadowResult:", err?.message);
      return false;
    }
    this.fallbackData.pipeline_shadow_results = staged;
    return true;
  }

  /**
   * ShadowResultStore.getShadowResultsPage: newest first by (decidedAt DESC,
   * id DESC), strict keyset cursor, limit clamped 1..100. Filters: exact gate,
   * exact agreement (an unknown value matches nothing), decidedAt >= sinceIso
   * (unparseable -> RangeError).
   */
  async getShadowResultsPage(
    cursor: { decidedAt: string; id: string } | null,
    limit: number,
    filter?: { gate?: string; agreement?: ShadowAgreement; sinceIso?: string },
  ): Promise<{ results: ShadowResultRecord[]; hasMore: boolean }> {
    const n = Math.min(SHADOW_PAGE_MAX, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const after = cursor ? { decidedAt: String(cursor.decidedAt), id: String(cursor.id) } : null;
    const gate = typeof filter?.gate === "string" && filter.gate !== "" ? filter.gate : null;
    const rawAgreement: unknown = filter?.agreement;
    const agreement = typeof rawAgreement === "string" && rawAgreement.length ? rawAgreement : null;
    if (agreement && !SHADOW_AGREEMENTS.has(agreement)) return { results: [], hasMore: false };
    let since: string | null = null;
    if (filter?.sinceIso !== undefined && filter.sinceIso !== null && filter.sinceIso !== "") {
      since = normIso(filter.sinceIso) || null;
      if (!since) throw new RangeError("getShadowResultsPage: invalid sinceIso");
    }
    const mode = this.shadowResultMode();
    let rows: ShadowResultRecord[] = [];
    if (mode === "postgresql") {
      const params: unknown[] = [];
      const where: string[] = [];
      if (gate) { params.push(gate); where.push(`gate = $${params.length}`); }
      if (agreement) { params.push(agreement); where.push(`agreement = $${params.length}`); }
      if (since) { params.push(since); where.push(`"decidedAt" >= $${params.length}`); }
      if (after) { params.push(after.decidedAt, after.id); where.push(`("decidedAt", id) < ($${params.length - 1}, $${params.length})`); }
      params.push(n + 1);
      const result = await this.pgPool!.query(
        `SELECT ${SHADOW_RESULT_COLUMNS_PG} FROM pipeline_shadow_results ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY "decidedAt" DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      rows = result.rows.map(rowToShadowResult);
    } else if (mode === "sqlite") {
      const params: unknown[] = [];
      const where: string[] = [];
      if (gate) { params.push(gate); where.push("gate = ?"); }
      if (agreement) { params.push(agreement); where.push("agreement = ?"); }
      if (since) { params.push(since); where.push("decidedAt >= ?"); }
      if (after) { params.push(after.decidedAt, after.decidedAt, after.id); where.push("(decidedAt < ? OR (decidedAt = ? AND id < ?))"); }
      rows = (this.db.prepare(
        `SELECT ${SHADOW_RESULT_COLUMNS_SQLITE} FROM pipeline_shadow_results ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY decidedAt DESC, id DESC LIMIT ?`,
      ).all(...params, n + 1) as any[]).map(rowToShadowResult);
    } else if (mode === "json") {
      rows = (this.fallbackData.pipeline_shadow_results || [])
        .filter((r) => (!gate || r.gate === gate) && (!agreement || r.agreement === agreement) && (!since || r.decidedAt >= since))
        .filter((r) => !after || r.decidedAt < after.decidedAt || (r.decidedAt === after.decidedAt && r.id < after.id))
        .sort(shadowNewestFirst)
        .slice(0, n + 1)
        .map((r) => rowToShadowResult(r));
    }
    return { results: rows.slice(0, n), hasMore: rows.length > n };
  }

  /**
   * ShadowResultStore.summarizeShadowResults: per-gate counts of results with
   * decidedAt >= sinceIso (one row per gate that has any, gates in bytewise
   * order) and the median decision latency (decidedAt - firstUsableAt) over
   * employee outcomes that have a firstUsableAt. Counts are aggregated in SQL;
   * the median is computed here from the employee rows' two timestamps, the
   * same way for every store. Unparseable sinceIso -> RangeError.
   */
  async summarizeShadowResults(sinceIso: string): Promise<ShadowAccuracySummary[]> {
    const since = normIso(sinceIso);
    if (!since) throw new RangeError("summarizeShadowResults: invalid sinceIso");
    const mode = this.shadowResultMode();
    const byGate = new Map<string, ShadowAccuracySummary>();
    const latencies = new Map<string, number[]>();
    const addLatency = (gate: string, r: { outcome: string; decidedAt: string; firstUsableAt?: string | null }) => {
      const ms = shadowLatencyMs(r);
      if (ms === null) return;
      (latencies.get(gate) || latencies.set(gate, []).get(gate)!).push(ms);
    };
    if (mode === "postgresql") {
      const counts = await this.pgPool!.query(
        `SELECT gate, count(*)::int AS decisions,
           count(*) FILTER (WHERE outcome = 'employee')::int AS employees,
           count(*) FILTER (WHERE outcome = 'stranger')::int AS strangers,
           count(*) FILTER (WHERE outcome = 'insufficient')::int AS insufficient,
           count(*) FILTER (WHERE "framesUsed" = 0)::int AS "framesUsedZero",
           count(*) FILTER (WHERE agreement = 'agree')::int AS agree,
           count(*) FILTER (WHERE agreement = 'shadow-only')::int AS "shadowOnly",
           count(*) FILTER (WHERE agreement = 'legacy-only')::int AS "legacyOnly",
           count(*) FILTER (WHERE agreement = 'identity-mismatch')::int AS "identityMismatch",
           count(*) FILTER (WHERE agreement = 'none')::int AS none
         FROM pipeline_shadow_results WHERE "decidedAt" >= $1 GROUP BY gate`,
        [since],
      );
      for (const r of counts.rows) byGate.set(String(r.gate), { ...emptyShadowSummary(String(r.gate), since), ...pickShadowCounts(r) });
      const emp = await this.pgPool!.query(
        `SELECT gate, "decidedAt", "firstUsableAt" FROM pipeline_shadow_results
          WHERE "decidedAt" >= $1 AND outcome = 'employee' AND "firstUsableAt" IS NOT NULL`,
        [since],
      );
      for (const r of emp.rows) addLatency(String(r.gate), { outcome: "employee", decidedAt: String(r.decidedAt), firstUsableAt: r.firstUsableAt });
    } else if (mode === "sqlite") {
      const counts = this.db.prepare(
        `SELECT gate, count(*) AS decisions,
           sum(outcome = 'employee') AS employees,
           sum(outcome = 'stranger') AS strangers,
           sum(outcome = 'insufficient') AS insufficient,
           sum(framesUsed = 0) AS framesUsedZero,
           sum(agreement = 'agree') AS agree,
           sum(agreement = 'shadow-only') AS shadowOnly,
           sum(agreement = 'legacy-only') AS legacyOnly,
           sum(agreement = 'identity-mismatch') AS identityMismatch,
           sum(agreement = 'none') AS none
         FROM pipeline_shadow_results WHERE decidedAt >= ? GROUP BY gate`,
      ).all(since) as any[];
      for (const r of counts) byGate.set(String(r.gate), { ...emptyShadowSummary(String(r.gate), since), ...pickShadowCounts(r) });
      const emp = this.db.prepare(
        `SELECT gate, decidedAt, firstUsableAt FROM pipeline_shadow_results
          WHERE decidedAt >= ? AND outcome = 'employee' AND firstUsableAt IS NOT NULL`,
      ).all(since) as any[];
      for (const r of emp) addLatency(String(r.gate), { outcome: "employee", decidedAt: String(r.decidedAt), firstUsableAt: r.firstUsableAt });
    } else if (mode === "json") {
      for (const r of this.fallbackData.pipeline_shadow_results || []) {
        if (!(r.decidedAt >= since)) continue;
        const s = byGate.get(r.gate) || byGate.set(r.gate, emptyShadowSummary(r.gate, since)).get(r.gate)!;
        countShadowRow(s, r);
        addLatency(r.gate, r);
      }
    }
    for (const [gate, s] of byGate) s.decisionLatencyP50Ms = medianMs(latencies.get(gate) || []);
    return [...byGate.values()].sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
  }

  /**
   * ShadowResultStore.purgeShadowResults: delete rows with decidedAt < cutoffIso
   * (plain DELETE: no biometric data, nothing to tombstone). Returns rows
   * deleted in the authoritative store. Unparseable cutoff -> RangeError.
   */
  async purgeShadowResults(cutoffIso: string): Promise<number> {
    const cutoff = normIso(cutoffIso);
    if (!cutoff) throw new RangeError("purgeShadowResults: invalid cutoff");
    const mode = this.shadowResultMode();
    if (mode === "postgresql") {
      const result = await this.pgPool!.query(`DELETE FROM pipeline_shadow_results WHERE "decidedAt" < $1`, [cutoff]);
      return result.rowCount || 0;
    }
    if (mode === "sqlite") {
      const result = this.db.prepare("DELETE FROM pipeline_shadow_results WHERE decidedAt < ?").run(cutoff);
      return Number(result?.changes || 0);
    }
    if (mode === "json") {
      const current = this.fallbackData.pipeline_shadow_results || [];
      const staged = current.filter((r) => !(r.decidedAt < cutoff));
      const removed = current.length - staged.length;
      if (!removed) return 0;
      this.writeFallback({ ...this.fallbackData, pipeline_shadow_results: staged });
      this.fallbackData.pipeline_shadow_results = staged;
      return removed;
    }
    return 0;
  }

  /**
   * Insert an immutable physical access event. Replays with the same id are
   * no-ops (the first write, including its trace fields, wins).
   *
   * Resolves once the authoritative store has the row: `true` when PostgreSQL
   * (when it is the active authority) or else the local store accepted it or
   * already had it, `false` when that write failed. Never rejects, so the
   * existing fire-and-forget callers are unaffected; new callers can await it.
   * Invalid trace values (capturedAt/trackId/recordingChannel) are stored as
   * NULL and logged by field name, never failing the event itself.
   */
  saveAccessLog(log: AccessLogRecord): Promise<boolean> {
    const embedding = log.faceEmbedding?.length ? embeddingToBuffer(log.faceEmbedding) : null;
    const embeddingDims = log.faceEmbedding?.length || null;
    const trace = normalizeAccessLogTrace(log);
    if (trace.rejected.length) {
      console.warn(`[AccessLog] ${String(log.id).slice(0, 64)}: bỏ giá trị không hợp lệ (${trace.rejected.join(", ")}), bản ghi vẫn được lưu.`);
    }
    const traceParams = [trace.capturedAt ?? null, trace.trackId ?? null, trace.recordingChannel ?? null];
    let authoritative: Promise<boolean> | null = null;
    if (this.pgPool && this.isPostgres) {
      authoritative = this.pgPool.query(`
        INSERT INTO access_logs (
          id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
          department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
          "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality",
          "capturedAt", "trackId", "recordingChannel"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        ON CONFLICT (id) DO NOTHING
      `, [
        log.id, log.timestamp, log.type, log.status,
        log.employeeId || null, log.employeeName || null, log.employeeCode || null,
        log.department || null, log.photoSnapshot, log.confidence,
        log.livenessScore ?? null, log.lockAction, log.doorName, log.reason || null,
        embedding, embeddingDims, log.faceEmbeddingModelTag || null, log.faceEmbeddingQuality ?? null,
        ...traceParams,
      ]).then(
        () => true,
        (e) => {
          console.error("[PostgreSQL] Lỗi saveAccessLog:", e.message);
          return false;
        },
      );
      const write = authoritative;
      this.pendingAccessLogWrites.set(log.id, write);
      void write.then(() => {
        if (this.pendingAccessLogWrites.get(log.id) === write) this.pendingAccessLogWrites.delete(log.id);
      });
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO access_logs (
            id, timestamp, type, status, employeeId, employeeName, employeeCode,
            department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason,
            faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality,
            capturedAt, trackId, recordingChannel
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          log.id,
          log.timestamp,
          log.type,
          log.status,
          log.employeeId || null,
          log.employeeName || null,
          log.employeeCode || null,
          log.department || null,
          log.photoSnapshot,
          log.confidence,
          log.livenessScore ?? null,
          log.lockAction,
          log.doorName,
          log.reason || null,
          embedding,
          embeddingDims,
          log.faceEmbeddingModelTag || null,
          log.faceEmbeddingQuality ?? null,
          ...traceParams,
        );
        return authoritative ?? Promise.resolve(true);
      } catch (err) {
        console.error("[SQLite] Lỗi saveAccessLog:", err);
      }
    }
    let localOk = true;
    if (!this.fallbackData.access_logs.some((existing) => existing.id === log.id)) {
      const stored: AccessLogRecord = {
        ...log,
        capturedAt: trace.capturedAt,
        trackId: trace.trackId,
        recordingChannel: trace.recordingChannel,
      };
      this.fallbackData.access_logs.unshift(stored);
      this.prependFallbackStrangerCandidate(stored);
      try {
        this.writeFallback();
      } catch (err: any) {
        console.error("[JSON] Lỗi saveAccessLog:", err?.message);
        localOk = false;
      }
    }
    return authoritative ?? Promise.resolve(localOk);
  }

  /**
   * Admin wipe of the access history. The stranger faces of those events go
   * with them (ON DELETE CASCADE on PostgreSQL, explicitly here for SQLite and
   * JSON): a face without its access event is biometric data with no purpose.
   */
  clearAccessLogs() {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM access_logs")
        .catch((e) => console.error("[PostgreSQL] Lỗi clearAccessLogs:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec("DELETE FROM stranger_faces; DELETE FROM access_logs;");
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi clearAccessLogs:", err);
      }
    }
    this.fallbackData.access_logs = [];
    this.fallbackData.stranger_faces = [];
    this.rebuildFallbackStrangerIndex();
    this.saveFallback();
  }

  // ================= SMART LOCK STATE =================
  getSmartLockState(defaultState: SmartLockStateRecord): SmartLockStateRecord {
    if (this.isNativeSqlite && this.db) {
      try {
        const row = this.db.prepare("SELECT * FROM smart_lock_state WHERE lockId = ?").get(defaultState.lockId);
        if (row) {
          return {
            ...defaultState,
            ...row,
            isLocked: Boolean(row.isLocked),
          };
        }
        this.saveSmartLockState(defaultState);
        return defaultState;
      } catch (err) {
        console.error("[SQLite] Lỗi getSmartLockState:", err);
      }
    }
    return this.fallbackData.smart_lock_state || defaultState;
  }

  saveSmartLockState(state: SmartLockStateRecord) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO smart_lock_state (
          "lockId", "doorName", state, "isLocked", "batteryLevel", "signalDbm",
          "firmwareVersion", "lastActionAt", "lastActionBy", "autoRelockSeconds", status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT ("lockId") DO UPDATE SET
          "doorName" = EXCLUDED."doorName",
          state = EXCLUDED.state,
          "isLocked" = EXCLUDED."isLocked",
          "batteryLevel" = EXCLUDED."batteryLevel",
          "signalDbm" = EXCLUDED."signalDbm",
          "lastActionAt" = EXCLUDED."lastActionAt",
          "lastActionBy" = EXCLUDED."lastActionBy",
          status = EXCLUDED.status
      `, [
        state.lockId, state.doorName, state.state, state.isLocked,
        state.batteryLevel, state.signalDbm, state.firmwareVersion,
        state.lastActionAt, state.lastActionBy, state.autoRelockSeconds, state.status
      ]).catch((e) => console.error("[PostgreSQL] Lỗi saveSmartLockState:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO smart_lock_state (
            lockId, doorName, state, isLocked, batteryLevel, signalDbm, firmwareVersion,
            lastActionAt, lastActionBy, autoRelockSeconds, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(lockId) DO UPDATE SET
            doorName = excluded.doorName,
            state = excluded.state,
            isLocked = excluded.isLocked,
            batteryLevel = excluded.batteryLevel,
            signalDbm = excluded.signalDbm,
            lastActionAt = excluded.lastActionAt,
            lastActionBy = excluded.lastActionBy,
            status = excluded.status
        `);
        stmt.run(
          state.lockId,
          state.doorName,
          state.state,
          state.isLocked ? 1 : 0,
          state.batteryLevel,
          state.signalDbm,
          state.firmwareVersion,
          state.lastActionAt,
          state.lastActionBy,
          state.autoRelockSeconds,
          state.status
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveSmartLockState:", err);
      }
    }
    this.fallbackData.smart_lock_state = state;
    this.saveFallback();
  }

  // ================= WEBHOOK CONFIG =================
  getWebhookConfig(defaultConfig: WebhookConfigRecord): WebhookConfigRecord {
    if (this.isNativeSqlite && this.db) {
      try {
        const row = this.db.prepare("SELECT * FROM webhook_config WHERE id = 'default'").get();
        if (row) {
          let url = row.url;
          // Optional stranger-alert fields live in one JSON blob column; a row
          // written before they existed has NULL there and falls back to defaults.
          const stranger = parseStrangerWebhookConfig(row.strangerConfig);
          const merged = withStrangerWebhookDefaults(
            {
              enabled: Boolean(row.enabled),
              url: url,
              gateInTitle: row.gateInTitle || defaultConfig.gateInTitle,
              gateOutTitle: row.gateOutTitle || defaultConfig.gateOutTitle,
              includeEmployeeCode: Boolean(row.includeEmployeeCode),
              ...stranger,
            },
            defaultConfig
          );
          // Auto-heal truncated URL with ellipsis or incomplete hook path
          if (!url || typeof url !== "string" || url.includes("...") || url.endsWith("/hooks/") || url.endsWith("/hooks")) {
            url = defaultConfig.url;
            merged.url = defaultConfig.url;
            this.saveWebhookConfig(merged);
          }
          return merged;
        }
        this.saveWebhookConfig(withStrangerWebhookDefaults(defaultConfig, defaultConfig));
        return withStrangerWebhookDefaults(defaultConfig, defaultConfig);
      } catch (err) {
        console.error("[SQLite] Lỗi getWebhookConfig:", err);
      }
    }
    const stored = this.fallbackData.webhook_config;
    const current = withStrangerWebhookDefaults(stored || defaultConfig, defaultConfig);
    if (!current.url || current.url.includes("...") || current.url.endsWith("/hooks/") || current.url.endsWith("/hooks")) {
      current.url = defaultConfig.url;
    }
    if (!stored || JSON.stringify(stored) !== JSON.stringify(current)) {
      this.fallbackData.webhook_config = current;
      this.saveFallback();
    }
    return current;
  }

  saveWebhookConfig(config: WebhookConfigRecord) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO webhook_config (id, enabled, url, "gateInTitle", "gateOutTitle", "includeEmployeeCode", "strangerConfig")
        VALUES ('default', $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          url = EXCLUDED.url,
          "gateInTitle" = EXCLUDED."gateInTitle",
          "gateOutTitle" = EXCLUDED."gateOutTitle",
          "includeEmployeeCode" = EXCLUDED."includeEmployeeCode",
          "strangerConfig" = EXCLUDED."strangerConfig"
      `, [config.enabled, config.url, config.gateInTitle, config.gateOutTitle, config.includeEmployeeCode, serializeStrangerWebhookConfig(config)])
      .catch((e) => console.error("[PostgreSQL] Lỗi saveWebhookConfig:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO webhook_config (id, enabled, url, gateInTitle, gateOutTitle, includeEmployeeCode, strangerConfig)
          VALUES ('default', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            url = excluded.url,
            gateInTitle = excluded.gateInTitle,
            gateOutTitle = excluded.gateOutTitle,
            includeEmployeeCode = excluded.includeEmployeeCode,
            strangerConfig = excluded.strangerConfig
        `);
        stmt.run(
          config.enabled ? 1 : 0,
          config.url,
          config.gateInTitle,
          config.gateOutTitle,
          config.includeEmployeeCode ? 1 : 0,
          serializeStrangerWebhookConfig(config)
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveWebhookConfig:", err);
      }
    }
    this.fallbackData.webhook_config = config;
    this.saveFallback();
  }

  // ================= WEBHOOK LOGS =================
  getWebhookLogs(): WebhookLogRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM webhook_logs ORDER BY timestamp DESC LIMIT 60").all();
        if (rows) {
          return rows.map((r: any) => ({
            ...r,
            payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
            success: Boolean(r.success),
          }));
        }
      } catch (err) {
        console.error("[SQLite] Lỗi getWebhookLogs:", err);
      }
    }
    return this.fallbackData.webhook_logs;
  }

  saveWebhookLog(log: WebhookLogRecord) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO webhook_logs (
          id, timestamp, url, method, payload, "statusCode", "statusText", "responseBody", success, error, "scanType", "userName"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING
      `, [
        log.id, log.timestamp, log.url, log.method,
        typeof log.payload === "string" ? log.payload : JSON.stringify(log.payload),
        log.statusCode || null, log.statusText || null, log.responseBody || null,
        log.success, log.error || null, log.scanType, log.userName
      ]).catch((e) => console.error("[PostgreSQL] Lỗi saveWebhookLog:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO webhook_logs (
            id, timestamp, url, method, payload, statusCode, statusText, responseBody, success, error, scanType, userName
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        stmt.run(
          log.id,
          log.timestamp,
          log.url,
          log.method,
          JSON.stringify(log.payload),
          log.statusCode || null,
          log.statusText || null,
          log.responseBody || null,
          log.success ? 1 : 0,
          log.error || null,
          log.scanType,
          log.userName
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveWebhookLog:", err);
      }
    }
    this.fallbackData.webhook_logs.unshift(log);
    if (this.fallbackData.webhook_logs.length > 60) {
      this.fallbackData.webhook_logs = this.fallbackData.webhook_logs.slice(0, 60);
    }
    this.saveFallback();
  }

  clearWebhookLogs(): void {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM webhook_logs").catch((e) => console.error("[PostgreSQL] Lỗi clearWebhookLogs:", e.message));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.db.prepare("DELETE FROM webhook_logs").run();
      } catch (err) {
        console.error("[SQLite] Lỗi clearWebhookLogs:", err);
      }
    }
    this.fallbackData.webhook_logs = [];
    this.saveFallback();
  }

  // ================= MOBILE NOTIFICATIONS =================
  getNotifications(defaults: MobileNotificationRecord[]): MobileNotificationRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM mobile_notifications ORDER BY timestamp DESC LIMIT 80").all();
        if (rows && rows.length > 0) {
          return rows.map((r: any) => ({
            ...r,
            read: Boolean(r.read),
          }));
        }
        for (const notif of defaults) {
          this.saveNotification(notif);
        }
        return defaults;
      } catch (err) {
        console.error("[SQLite] Lỗi getNotifications:", err);
      }
    }
    if (this.fallbackData.mobile_notifications.length === 0) {
      this.fallbackData.mobile_notifications = [...defaults];
      this.saveFallback();
    }
    return this.fallbackData.mobile_notifications;
  }

  saveNotification(notif: MobileNotificationRecord) {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO mobile_notifications (id, title, body, timestamp, type, read, "employeeId", "employeeName")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          read = EXCLUDED.read
      `, [
        notif.id, notif.title, notif.body, notif.timestamp, notif.type,
        notif.read, notif.employeeId || null, notif.employeeName || null
      ]).catch((e) => console.error("[PostgreSQL] Lỗi saveNotification:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO mobile_notifications (id, title, body, timestamp, type, read, employeeId, employeeName)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            read = excluded.read
        `);
        stmt.run(
          notif.id,
          notif.title,
          notif.body,
          notif.timestamp,
          notif.type,
          notif.read ? 1 : 0,
          notif.employeeId || null,
          notif.employeeName || null
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveNotification:", err);
      }
    }
    const idx = this.fallbackData.mobile_notifications.findIndex((n) => n.id === notif.id);
    if (idx >= 0) {
      this.fallbackData.mobile_notifications[idx] = notif;
    } else {
      this.fallbackData.mobile_notifications.unshift(notif);
    }
    this.saveFallback();
  }

  clearNotifications() {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM mobile_notifications")
        .catch((e) => console.error("[PostgreSQL] Lỗi clearNotifications:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec("DELETE FROM mobile_notifications");
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi clearNotifications:", err);
      }
    }
    this.fallbackData.mobile_notifications = [];
    this.saveFallback();
  }

  markNotificationsRead() {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("UPDATE mobile_notifications SET read = true")
        .catch((e) => console.error("[PostgreSQL] Lỗi markNotificationsRead:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec("UPDATE mobile_notifications SET read = 1");
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi markNotificationsRead:", err);
      }
    }
    this.fallbackData.mobile_notifications.forEach((n) => (n.read = true));
    this.saveFallback();
  }

  // ================= DOOR CONTROLLER API CONFIG =================
  getDoorControllerConfig(defaults: DoorControllerConfigRecord): DoorControllerConfigRecord {
    if (this.isNativeSqlite && this.db) {
      try {
        const row: any = this.db.prepare("SELECT * FROM door_controller_config WHERE id = 'default'").get();
        if (row) {
          return {
            enabled: Boolean(row.enabled),
            apiUrl: row.apiUrl || defaults.apiUrl,
            apiToken: row.apiToken !== undefined ? row.apiToken : defaults.apiToken,
            authHeaderType: (row.authHeaderType as DoorAuthHeaderType) || defaults.authHeaderType,
            customHeaderName: row.customHeaderName || defaults.customHeaderName,
            openMethod: row.openMethod || defaults.openMethod,
            closeMethod: row.closeMethod || defaults.closeMethod,
            openPayloadTemplate: row.openPayloadTemplate || defaults.openPayloadTemplate,
            closePayloadTemplate: row.closePayloadTemplate || defaults.closePayloadTemplate,
            pulseDurationSeconds: Number(row.pulseDurationSeconds) || defaults.pulseDurationSeconds,
            triggerOnFaceRecognition: row.triggerOnFaceRecognition !== undefined ? Boolean(row.triggerOnFaceRecognition) : defaults.triggerOnFaceRecognition,
            triggerOnManualUnlock: row.triggerOnManualUnlock !== undefined ? Boolean(row.triggerOnManualUnlock) : defaults.triggerOnManualUnlock,
          };
        }
        this.saveDoorControllerConfig(defaults);
        return defaults;
      } catch (err) {
        console.error("[SQLite] Lỗi getDoorControllerConfig:", err);
      }
    }
    if (!this.fallbackData.door_controller_config) {
      this.fallbackData.door_controller_config = defaults;
      this.saveFallback();
    }
    return this.fallbackData.door_controller_config;
  }

  saveDoorControllerConfig(config: DoorControllerConfigRecord) {
    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO door_controller_config (
            id, enabled, apiUrl, apiToken, authHeaderType, customHeaderName,
            openMethod, closeMethod, openPayloadTemplate, closePayloadTemplate,
            pulseDurationSeconds, triggerOnFaceRecognition, triggerOnManualUnlock
          ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            apiUrl = excluded.apiUrl,
            apiToken = excluded.apiToken,
            authHeaderType = excluded.authHeaderType,
            customHeaderName = excluded.customHeaderName,
            openMethod = excluded.openMethod,
            closeMethod = excluded.closeMethod,
            openPayloadTemplate = excluded.openPayloadTemplate,
            closePayloadTemplate = excluded.closePayloadTemplate,
            pulseDurationSeconds = excluded.pulseDurationSeconds,
            triggerOnFaceRecognition = excluded.triggerOnFaceRecognition,
            triggerOnManualUnlock = excluded.triggerOnManualUnlock
        `);
        stmt.run(
          config.enabled ? 1 : 0,
          config.apiUrl,
          config.apiToken,
          config.authHeaderType,
          config.customHeaderName || "",
          config.openMethod,
          config.closeMethod,
          config.openPayloadTemplate || "",
          config.closePayloadTemplate || "",
          config.pulseDurationSeconds,
          config.triggerOnFaceRecognition ? 1 : 0,
          config.triggerOnManualUnlock ? 1 : 0
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveDoorControllerConfig:", err);
      }
    }
    this.fallbackData.door_controller_config = config;
    this.saveFallback();
  }

  // ================= DOOR API LOGS =================
  getDoorApiLogs(): DoorApiLogRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM door_api_logs ORDER BY timestamp DESC LIMIT 60").all();
        if (rows) {
          return rows.map((r: any) => ({
            ...r,
            requestHeaders: r.requestHeaders ? JSON.parse(r.requestHeaders) : undefined,
            success: Boolean(r.success),
          }));
        }
      } catch (err) {
        console.error("[SQLite] Lỗi getDoorApiLogs:", err);
      }
    }
    return this.fallbackData.door_api_logs || [];
  }

  saveDoorApiLog(log: DoorApiLogRecord) {
    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO door_api_logs (
            id, timestamp, action, url, method, requestHeaders, requestBody,
            statusCode, statusText, responseBody, success, error, durationMs, triggeredBy
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        stmt.run(
          log.id,
          log.timestamp,
          log.action,
          log.url,
          log.method,
          log.requestHeaders ? JSON.stringify(log.requestHeaders) : null,
          log.requestBody || null,
          log.statusCode || null,
          log.statusText || null,
          log.responseBody || null,
          log.success ? 1 : 0,
          log.error || null,
          log.durationMs || 0,
          log.triggeredBy || "System"
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveDoorApiLog:", err);
      }
    }
    if (!this.fallbackData.door_api_logs) this.fallbackData.door_api_logs = [];
    this.fallbackData.door_api_logs.unshift(log);
    if (this.fallbackData.door_api_logs.length > 60) {
      this.fallbackData.door_api_logs = this.fallbackData.door_api_logs.slice(0, 60);
    }
    this.saveFallback();
  }

  clearDoorApiLogs(): void {
    if (this.isNativeSqlite && this.db) {
      try {
        this.db.prepare("DELETE FROM door_api_logs").run();
      } catch (err) {
        console.error("[SQLite] Lỗi clearDoorApiLogs:", err);
      }
    }
    this.fallbackData.door_api_logs = [];
    this.saveFallback();
  }

  // ================= CAMERA STREAMS CONFIG =================
  // Gate URLs, stream lists and watcher settings. The read path is synchronous
  // (every request resolves the gate config), so the PostgreSQL row is hydrated
  // into memory at startup exactly like the AI config, and every save writes
  // through to each active store. Before this, the config lived only in SQLite
  // and the JSON fallback: on a host where ./data is not persisted the whole
  // camera configuration silently reverted to the compiled defaults.
  private cameraConfigCache: CameraStreamsConfigRecord | null = null;
  private cameraConfigLoadedCallbacks: Array<(config: CameraStreamsConfigRecord) => void> = [];

  /** Fires once the PostgreSQL row has been hydrated (only when PostgreSQL is active). */
  public onCameraStreamsConfigLoaded(cb: (config: CameraStreamsConfigRecord) => void) {
    this.cameraConfigLoadedCallbacks.push(cb);
  }

  /** Config as persisted by the local stores, ignoring the PostgreSQL cache. */
  private localCameraStreamsConfig(): CameraStreamsConfigRecord | null {
    if (this.isNativeSqlite && this.db) {
      try {
        const row: any = this.db
          .prepare("SELECT config_json FROM camera_streams_config WHERE id = 'default'")
          .get();
        if (row?.config_json) return JSON.parse(row.config_json);
      } catch (err) {
        console.error("[SQLite] Lỗi getCameraStreamsConfig:", err);
      }
    }
    return this.fallbackData.camera_streams_config || null;
  }

  private async loadCameraStreamsConfig() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query(
        "SELECT data FROM camera_streams_config WHERE id = 'default'"
      );
      const raw = res.rows[0]?.data;
      const parsed = raw
        ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as CameraStreamsConfigRecord)
        : null;
      if (parsed) {
        this.cameraConfigCache = parsed;
        console.log("[PostgreSQL] Đã nạp cấu hình luồng camera.");
      } else {
        // First run against PostgreSQL: adopt whatever the local stores hold so
        // an existing deployment keeps its gates instead of reverting to defaults.
        const local = this.localCameraStreamsConfig();
        if (local) {
          this.cameraConfigCache = local;
          this.saveCameraStreamsConfig(local);
          console.log("[PostgreSQL] Đã di chuyển cấu hình luồng camera từ bộ lưu cục bộ.");
        }
      }
      for (const cb of this.cameraConfigLoadedCallbacks) {
        try {
          if (this.cameraConfigCache) cb(this.cameraConfigCache);
        } catch (e: any) {
          console.error("[PostgreSQL] Lỗi callback cấu hình luồng camera:", e?.message);
        }
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp cấu hình luồng camera:", err);
    }
  }

  /** Precedence: PostgreSQL (hydrated cache) > native SQLite row > JSON fallback > defaults. */
  getCameraStreamsConfig(defaultConfig: CameraStreamsConfigRecord): CameraStreamsConfigRecord {
    if (this.cameraConfigCache) return this.cameraConfigCache;
    return this.localCameraStreamsConfig() || defaultConfig;
  }

  saveCameraStreamsConfig(config: CameraStreamsConfigRecord): void {
    const snapshot: CameraStreamsConfigRecord = JSON.parse(JSON.stringify(config));
    const json = JSON.stringify(snapshot);

    if (this.pgPool && this.isPostgres) {
      // Cache first so the next synchronous read reflects the change even
      // before the row lands.
      this.cameraConfigCache = snapshot;
      this.pgPool
        .query(
          `INSERT INTO camera_streams_config (id, data, "updatedAt")
           VALUES ('default', $1::jsonb, $2)
           ON CONFLICT (id) DO UPDATE SET
             data = EXCLUDED.data,
             "updatedAt" = EXCLUDED."updatedAt"`,
          [json, new Date().toISOString()]
        )
        .catch((err: any) =>
          console.error("[PostgreSQL] Lỗi lưu cấu hình luồng camera:", err?.message)
        );
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db
          .prepare(`
            INSERT INTO camera_streams_config (id, config_json)
            VALUES ('default', ?)
            ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json
          `)
          .run(json);
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveCameraStreamsConfig:", err);
      }
    }
    this.fallbackData.camera_streams_config = snapshot;
    this.saveFallback();
  }

  // ================= AI RECOGNITION CONFIG =================
  // Engine mode / Gemini model / thresholds edited from the AI settings page.
  // The read path is synchronous (the config is consulted on every
  // recognition), so the PostgreSQL row is hydrated into memory at startup
  // and every save goes to each active store best-effort. On hosts where
  // ./data is bind-mounted read-only for the container, SQLite and the JSON
  // fallback cannot be written - PostgreSQL is the store that survives.
  private aiConfigCache: AiRecognitionConfigRecord | null = null;
  private aiConfigLoadedCallbacks: Array<(config: AiRecognitionConfigRecord) => void> = [];

  /** Fires once the PostgreSQL row has been hydrated (only when PostgreSQL is active and holds a row). */
  public onAiRecognitionConfigLoaded(cb: (config: AiRecognitionConfigRecord) => void) {
    this.aiConfigLoadedCallbacks.push(cb);
  }

  private parseAiConfigRow(value: unknown): AiRecognitionConfigRecord | null {
    if (!value) return null;
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return parsed && typeof parsed === "object" ? (parsed as AiRecognitionConfigRecord) : null;
    } catch {
      return null;
    }
  }

  private async loadAiRecognitionConfig() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query(
        "SELECT config_json FROM ai_recognition_config WHERE id = 'default'"
      );
      const parsed = this.parseAiConfigRow(res.rows[0]?.config_json);
      if (parsed) {
        this.aiConfigCache = parsed;
        console.log(
          `[PostgreSQL] Đã nạp cấu hình AI nhận diện (engine: ${parsed.engineMode}, model: ${parsed.googleAi?.model}).`
        );
        for (const cb of this.aiConfigLoadedCallbacks) {
          try {
            cb(parsed);
          } catch (e: any) {
            console.error("[PostgreSQL] Lỗi callback cấu hình AI:", e?.message);
          }
        }
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp cấu hình AI nhận diện:", err);
    }
  }

  /**
   * Returns the persisted AI config merged over `defaults`.
   * Precedence: PostgreSQL (hydrated cache) > native SQLite row > JSON fallback > defaults.
   */
  getAiRecognitionConfig(defaults: AiRecognitionConfigRecord): AiRecognitionConfigRecord {
    if (this.aiConfigCache) {
      return mergeAiRecognitionConfig(defaults, this.aiConfigCache);
    }
    if (this.isNativeSqlite && this.db) {
      try {
        const row: any = this.db
          .prepare("SELECT config_json FROM ai_recognition_config WHERE id = 'default'")
          .get();
        const parsed = this.parseAiConfigRow(row?.config_json);
        if (parsed) return mergeAiRecognitionConfig(defaults, parsed);
      } catch (err) {
        console.error("[SQLite] Lỗi getAiRecognitionConfig:", err);
      }
    }
    return mergeAiRecognitionConfig(defaults, this.fallbackData.ai_recognition_config);
  }

  saveAiRecognitionConfig(config: AiRecognitionConfigRecord): void {
    const snapshot: AiRecognitionConfigRecord = JSON.parse(JSON.stringify(config));
    const updatedAt = new Date().toISOString();
    const json = JSON.stringify(snapshot);

    if (this.pgPool && this.isPostgres) {
      // Cache first so the next read reflects the change even before the row lands.
      this.aiConfigCache = snapshot;
      this.pgPool
        .query(
          `INSERT INTO ai_recognition_config (id, config_json, "updatedAt")
           VALUES ('default', $1::jsonb, $2)
           ON CONFLICT (id) DO UPDATE SET
             config_json = EXCLUDED.config_json,
             "updatedAt" = EXCLUDED."updatedAt"`,
          [json, updatedAt]
        )
        .catch((err: any) =>
          console.error("[PostgreSQL] Lỗi lưu cấu hình AI nhận diện:", err?.message)
        );
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ai_recognition_config (
            id TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            updatedAt TEXT
          )
        `);
        this.db
          .prepare(
            `INSERT INTO ai_recognition_config (id, config_json, updatedAt)
             VALUES ('default', ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               config_json = excluded.config_json,
               updatedAt = excluded.updatedAt`
          )
          .run(json, updatedAt);
      } catch (err) {
        console.error("[SQLite] Lỗi saveAiRecognitionConfig:", err);
      }
    }

    this.fallbackData.ai_recognition_config = snapshot;
    this.saveFallback();
  }

  // ================= RESOLVED STRANGER CLUSTERS =================
  // Seeded demo clusters carry synthetic log ids that never exist in
  // access_logs, so acting on one cannot remove it the way a real cluster is
  // removed (its logs flipping to GRANTED). Remember the resolved ids instead.
  //
  // Read path is synchronous (the clusters endpoint is sync), so the ids are
  // held in memory and hydrated from PostgreSQL at startup. Writes go to every
  // store that is active: PostgreSQL, native SQLite, and the JSON fallback.
  // The JSON fallback alone is not sufficient - when ./data is bind-mounted
  // from a host user, the container cannot write it and saveFallback() fails
  // silently in its catch.
  private resolvedClustersCache: string[] = [];

  private async loadResolvedStrangerClusters() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query('SELECT "clusterId" FROM resolved_stranger_clusters');
      this.resolvedClustersCache = res.rows.map((r: any) => r.clusterId);
      if (this.resolvedClustersCache.length > 0) {
        console.log(
          `[PostgreSQL] Đã nạp ${this.resolvedClustersCache.length} cụm người lạ đã xử lý.`
        );
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp danh sách cụm người lạ đã xử lý:", err);
    }
  }

  getResolvedStrangerClusters(): string[] {
    if (this.resolvedClustersCache.length > 0) return this.resolvedClustersCache;
    // SQLite / JSON-only deployments never hydrate the cache from PostgreSQL.
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db
          .prepare("SELECT clusterId FROM resolved_stranger_clusters")
          .all() as any[];
        if (rows?.length) {
          this.resolvedClustersCache = rows.map((r) => r.clusterId);
          return this.resolvedClustersCache;
        }
      } catch {}
    }
    return this.fallbackData.resolved_stranger_clusters || [];
  }

  markStrangerClusterResolved(clusterId: string, resolvedBy = "operator"): void {
    if (!clusterId) return;
    if (this.resolvedClustersCache.includes(clusterId)) return;
    this.resolvedClustersCache = [...this.resolvedClustersCache, clusterId];

    const resolvedAt = new Date().toISOString();

    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query(
          `INSERT INTO resolved_stranger_clusters ("clusterId", "resolvedAt", "resolvedBy")
           VALUES ($1, $2, $3)
           ON CONFLICT ("clusterId") DO NOTHING`,
          [clusterId, resolvedAt, resolvedBy]
        )
        .catch((err: any) =>
          console.error("[PostgreSQL] Lỗi lưu cụm người lạ đã xử lý:", err?.message)
        );
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS resolved_stranger_clusters (
            clusterId TEXT PRIMARY KEY,
            resolvedAt TEXT,
            resolvedBy TEXT
          )
        `);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO resolved_stranger_clusters (clusterId, resolvedAt, resolvedBy) VALUES (?, ?, ?)"
          )
          .run(clusterId, resolvedAt, resolvedBy);
      } catch (err) {
        console.error("[SQLite] Lỗi lưu cụm người lạ đã xử lý:", err);
      }
    }

    const current = this.fallbackData.resolved_stranger_clusters || [];
    if (!current.includes(clusterId)) {
      this.fallbackData.resolved_stranger_clusters = [...current, clusterId];
      this.saveFallback();
    }
  }

  private strangerResolutionsCache: StrangerResolutionRecord[] = [];
  private strangerResolutionsHydrated = false;
  private strangerResolutionEventsCache: StrangerResolutionRecord[] = [];
  private strangerResolutionEventsHydrated = false;

  private async loadStrangerResolutionEvents(): Promise<void> {
    if (!this.pgPool) return;
    try {
      const result = await this.pgPool.query(
        'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "faceIds", "sourceLogId", metadata FROM stranger_resolution_events ORDER BY "resolvedAt", id'
      );
      this.strangerResolutionEventsCache = result.rows.map(rowToStrangerResolution);
      this.strangerResolutionEventsHydrated = true;
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp lịch sử adjudication người lạ:", err);
    }
  }

  getStrangerResolutionEvents(clusterId?: string): StrangerResolutionRecord[] {
    if (!this.strangerResolutionEventsHydrated) {
      if (this.isNativeSqlite && this.db) {
        try {
          const rows = this.db.prepare("SELECT * FROM stranger_resolution_events ORDER BY resolvedAt, id").all() as any[];
          this.strangerResolutionEventsCache = rows.map(rowToStrangerResolution);
        } catch {
          this.strangerResolutionEventsCache = [];
        }
      } else {
        this.strangerResolutionEventsCache = (this.fallbackData.stranger_resolution_events || []).map(copyResolution);
      }
      this.strangerResolutionEventsHydrated = true;
    }
    return this.strangerResolutionEventsCache
      .filter((record) => !clusterId || record.clusterId === clusterId)
      .map(copyResolution);
  }

  private async loadStrangerResolutions(): Promise<void> {
    if (!this.pgPool) return;
    try {
      const result = await this.pgPool.query(
        'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "faceIds", "sourceLogId", metadata FROM stranger_resolutions'
      );
      this.strangerResolutionsCache = result.rows.map(rowToStrangerResolution);
      this.strangerResolutionsHydrated = true;
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp adjudication người lạ:", err);
    }
  }

  getStrangerResolutions(): StrangerResolutionRecord[] {
    if (this.strangerResolutionsHydrated || this.strangerResolutionsCache.length > 0) {
      return this.strangerResolutionsCache.map(copyResolution);
    }
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM stranger_resolutions").all() as any[];
        this.strangerResolutionsCache = rows.map(rowToStrangerResolution);
        this.strangerResolutionsHydrated = true;
        return this.getStrangerResolutions();
      } catch {}
    }
    this.strangerResolutionsCache = (this.fallbackData.stranger_resolutions || []).map(copyResolution);
    this.strangerResolutionsHydrated = true;
    return this.getStrangerResolutions();
  }

  getStrangerResolution(clusterId: string): StrangerResolutionRecord | undefined {
    return this.getStrangerResolutions().find((record) => record.clusterId === clusterId);
  }

  async commitStrangerResolution(input: StrangerResolutionCommit): Promise<StrangerResolutionCommitResult> {
    const resolution: StrangerResolutionRecord = {
      ...input.resolution,
      logIds: [...input.resolution.logIds].sort(),
      faceIds: [...(input.resolution.faceIds || [])].sort(),
      metadata: { ...(input.resolution.metadata || {}) },
    };
    const classify = (existing: StrangerResolutionRecord): StrangerResolutionCommitResult => ({
      status: sameResolutionIntent(existing, resolution) ? "replay" : "conflict",
      resolution: existing,
    });

    if (this.pgPool && this.isPostgres) {
      const client = await this.pgPool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "faceIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1 FOR UPDATE',
          [resolution.clusterId],
        );
        if (found.rows[0]) {
          await client.query("ROLLBACK");
          return classify(rowToStrangerResolution(found.rows[0]));
        }
        if (input.employee) {
          const e = input.employee;
          await client.query(
            'INSERT INTO employees (id,name,"employeeCode",department,position,"photoUrl","registeredAt","accessLevel") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [e.id, e.name, e.employeeCode, e.department, e.position, e.photoUrl, e.registeredAt, e.accessLevel],
          );
        }
        if (input.employeePhotoUpdate) {
          await client.query('UPDATE employees SET "photoUrl"=$1 WHERE id=$2', [input.employeePhotoUpdate.photoUrl, input.employeePhotoUpdate.employeeId]);
        }
        if (input.faceTemplate) {
          const t = input.faceTemplate;
          await client.query(
            'INSERT INTO face_templates (id,"employeeId",embedding,dims,"modelTag",source,quality,"capturedAt","sourceLogId","streamId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [t.id, t.employeeId, embeddingToBuffer(t.embedding), t.dims, t.modelTag, t.source, t.quality, t.capturedAt, t.sourceLogId || null, t.streamId || null],
          );
        }
        await client.query(
          'INSERT INTO stranger_resolutions (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata,"faceIds") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb)',
          [resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}),
            JSON.stringify(resolution.faceIds)],
        );
        await client.query(
          'INSERT INTO stranger_resolution_events (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata,"faceIds") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb)',
          [resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}),
            JSON.stringify(resolution.faceIds)],
        );
        await client.query(
          'INSERT INTO resolved_stranger_clusters ("clusterId","resolvedAt","resolvedBy") VALUES ($1,$2,$3)',
          [resolution.clusterId, resolution.resolvedAt, resolution.actor],
        );
        await client.query("COMMIT");
      } catch (error: any) {
        await client.query("ROLLBACK");
        if (error?.code === "23505") {
          const found = await this.pgPool.query(
            'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "faceIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1',
            [resolution.clusterId],
          );
          if (found.rows[0]) return classify(rowToStrangerResolution(found.rows[0]));
        }
        throw error;
      } finally {
        client.release();
      }
    } else if (this.isNativeSqlite && this.db) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const found = this.db.prepare("SELECT * FROM stranger_resolutions WHERE clusterId=?").get(resolution.clusterId) as any;
        if (found) {
          this.db.exec("ROLLBACK");
          return classify(rowToStrangerResolution(found));
        }
        if (input.employee) {
          const e = input.employee;
          this.db.prepare("INSERT INTO employees (id,name,employeeCode,department,position,photoUrl,registeredAt,accessLevel) VALUES (?,?,?,?,?,?,?,?)")
            .run(e.id, e.name, e.employeeCode, e.department, e.position, e.photoUrl, e.registeredAt, e.accessLevel);
        }
        if (input.employeePhotoUpdate) {
          this.db.prepare("UPDATE employees SET photoUrl=? WHERE id=?").run(input.employeePhotoUpdate.photoUrl, input.employeePhotoUpdate.employeeId);
        }
        if (input.faceTemplate) {
          const t = input.faceTemplate;
          this.ensureSqliteFaceTemplates();
          this.db.prepare("INSERT INTO face_templates (id,employeeId,embedding,dims,modelTag,source,quality,capturedAt,sourceLogId,streamId) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(t.id, t.employeeId, embeddingToBuffer(t.embedding), t.dims, t.modelTag, t.source, t.quality, t.capturedAt, t.sourceLogId || null, t.streamId || null);
        }
        this.db.prepare("INSERT INTO stranger_resolutions (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata,faceIds) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}),
            JSON.stringify(resolution.faceIds));
        this.db.prepare("INSERT INTO stranger_resolution_events (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata,faceIds) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}),
            JSON.stringify(resolution.faceIds));
        this.db.prepare("INSERT INTO resolved_stranger_clusters (clusterId,resolvedAt,resolvedBy) VALUES (?,?,?)")
          .run(resolution.clusterId, resolution.resolvedAt, resolution.actor);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        const found = this.db.prepare("SELECT * FROM stranger_resolutions WHERE clusterId=?").get(resolution.clusterId) as any;
        if (found) return classify(rowToStrangerResolution(found));
        throw error;
      }
    } else {
      const found = (this.fallbackData.stranger_resolutions || []).find((item) => item.clusterId === resolution.clusterId);
      if (found) return classify(copyResolution(found));
      const staged = JSON.parse(JSON.stringify(this.fallbackData)) as typeof this.fallbackData;
      if (input.employee) {
        if (staged.employees.some((item) => item.id === input.employee!.id || item.employeeCode.toUpperCase() === input.employee!.employeeCode.toUpperCase())) {
          throw new Error("employee-conflict");
        }
        staged.employees.unshift(input.employee);
      }
      if (input.employeePhotoUpdate) {
        const employee = staged.employees.find((item) => item.id === input.employeePhotoUpdate!.employeeId);
        if (!employee) throw new Error("employee-not-found");
        employee.photoUrl = input.employeePhotoUpdate.photoUrl;
      }
      if (input.faceTemplate) (staged.face_templates ||= []).push(input.faceTemplate);
      (staged.stranger_resolutions ||= []).push(resolution);
      (staged.stranger_resolution_events ||= []).push(resolution);
      (staged.resolved_stranger_clusters ||= []).push(resolution.clusterId);
      this.writeFallback(staged);
      this.fallbackData = staged;
    }

    this.strangerResolutionsCache.push(resolution);
    this.strangerResolutionsHydrated = true;
    this.getStrangerResolutionEvents();
    if (!this.strangerResolutionEventsCache.some((item) => item.id === resolution.id)) {
      this.strangerResolutionEventsCache.push(resolution);
    }
    if (!this.resolvedClustersCache.includes(resolution.clusterId)) this.resolvedClustersCache.push(resolution.clusterId);
    if (input.faceTemplate) {
      this.getFaceTemplates();
      this.faceTemplatesCache.push(input.faceTemplate);
    }
    return { status: "created", resolution };
  }

  /** Append one idempotent adjudication without mutating the physical access event. */
  async saveStrangerResolution(record: StrangerResolutionRecord): Promise<StrangerResolutionRecord> {
    const existing = this.getStrangerResolution(record.clusterId);
    if (existing) return existing;
    const snapshot: StrangerResolutionRecord = {
      ...record,
      logIds: [...record.logIds].sort(),
      faceIds: [...(record.faceIds || [])].sort(),
      metadata: { ...(record.metadata || {}) },
    };
    if (this.pgPool && this.isPostgres) {
      await this.pgPool.query(
        `INSERT INTO stranger_resolutions
          (id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata, "faceIds")
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb)
         ON CONFLICT ("clusterId") DO NOTHING`,
        [snapshot.id, snapshot.clusterId, snapshot.action, snapshot.employeeId || null, snapshot.actor,
          snapshot.resolvedAt, JSON.stringify(snapshot.logIds), snapshot.sourceLogId || null,
          JSON.stringify(snapshot.metadata || {}), JSON.stringify(snapshot.faceIds)]
      );
    }
    if (this.isNativeSqlite && this.db) {
      this.db.prepare(
        `INSERT OR IGNORE INTO stranger_resolutions
          (id, clusterId, action, employeeId, actor, resolvedAt, logIds, sourceLogId, metadata, faceIds)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(snapshot.id, snapshot.clusterId, snapshot.action, snapshot.employeeId || null, snapshot.actor,
        snapshot.resolvedAt, JSON.stringify(snapshot.logIds), snapshot.sourceLogId || null,
        JSON.stringify(snapshot.metadata || {}), JSON.stringify(snapshot.faceIds));
    }
    this.strangerResolutionsCache.push(snapshot);
    const fallback = this.fallbackData.stranger_resolutions || [];
    if (!fallback.some((item) => item.clusterId === snapshot.clusterId)) fallback.push(snapshot);
    this.fallbackData.stranger_resolutions = fallback;
    this.saveFallback();
    this.markStrangerClusterResolved(snapshot.clusterId, snapshot.actor);
    return snapshot;
  }

  async restoreStrangerResolution(record: StrangerResolutionRecord): Promise<StrangerResolutionRecord> {
    const restore: StrangerResolutionRecord = {
      ...record,
      action: "RESTORE",
      logIds: [...record.logIds].sort(),
      faceIds: [...(record.faceIds || [])].sort(),
      metadata: { ...(record.metadata || {}) },
    };
    const existing = this.getStrangerResolution(restore.clusterId);
    if (!existing || existing.action !== "DISMISS" || !sameResolutionIntent(
      existing,
      { ...existing, logIds: restore.logIds, faceIds: restore.faceIds },
    )) throw new Error("restore-conflict");

    if (this.pgPool && this.isPostgres) {
      const client = await this.pgPool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "faceIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1 FOR UPDATE',
          [restore.clusterId],
        );
        const current = found.rows[0] ? rowToStrangerResolution(found.rows[0]) : undefined;
        if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds, faceIds: restore.faceIds })) {
          await client.query("ROLLBACK");
          throw new Error("restore-conflict");
        }
        await client.query(
          'INSERT INTO stranger_resolution_events (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata,"faceIds") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb)',
          [restore.id, restore.clusterId, restore.action, null, restore.actor, restore.resolvedAt,
            JSON.stringify(restore.logIds), restore.sourceLogId || null, JSON.stringify(restore.metadata || {}),
            JSON.stringify(restore.faceIds)],
        );
        await client.query('DELETE FROM stranger_resolutions WHERE "clusterId"=$1', [restore.clusterId]);
        await client.query('DELETE FROM resolved_stranger_clusters WHERE "clusterId"=$1', [restore.clusterId]);
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally {
        client.release();
      }
    } else if (this.isNativeSqlite && this.db) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const found = this.db.prepare("SELECT * FROM stranger_resolutions WHERE clusterId=?").get(restore.clusterId) as any;
        const current = found ? rowToStrangerResolution(found) : undefined;
        if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds, faceIds: restore.faceIds })) {
          throw new Error("restore-conflict");
        }
        this.db.prepare("INSERT INTO stranger_resolution_events (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata,faceIds) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(restore.id, restore.clusterId, restore.action, null, restore.actor, restore.resolvedAt,
            JSON.stringify(restore.logIds), restore.sourceLogId || null, JSON.stringify(restore.metadata || {}),
            JSON.stringify(restore.faceIds));
        this.db.prepare("DELETE FROM stranger_resolutions WHERE clusterId=?").run(restore.clusterId);
        this.db.prepare("DELETE FROM resolved_stranger_clusters WHERE clusterId=?").run(restore.clusterId);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    } else {
      const staged = JSON.parse(JSON.stringify(this.fallbackData)) as typeof this.fallbackData;
      const current = (staged.stranger_resolutions || []).find((item) => item.clusterId === restore.clusterId);
      if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds, faceIds: restore.faceIds })) {
        throw new Error("restore-conflict");
      }
      (staged.stranger_resolution_events ||= []).push(restore);
      staged.stranger_resolutions = (staged.stranger_resolutions || []).filter((item) => item.clusterId !== restore.clusterId);
      staged.resolved_stranger_clusters = (staged.resolved_stranger_clusters || []).filter((id) => id !== restore.clusterId);
      this.writeFallback(staged);
      this.fallbackData = staged;
    }

    this.strangerResolutionsCache = this.strangerResolutionsCache.filter((item) => item.clusterId !== restore.clusterId);
    this.getStrangerResolutionEvents();
    if (!this.strangerResolutionEventsCache.some((item) => item.id === restore.id)) {
      this.strangerResolutionEventsCache.push(restore);
    }
    this.resolvedClustersCache = this.resolvedClustersCache.filter((id) => id !== restore.clusterId);
    return restore;
  }

  // ================= ORGANISATION CATALOG (departments, positions) =================
  // One small document, read synchronously when an employee is created, so it
  // is hydrated into memory at startup and every save writes through - the same
  // arrangement as the camera configuration.
  private orgCatalogCache: OrgCatalogRecord | null = null;

  private localOrgCatalog(): OrgCatalogRecord | null {
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteOrgCatalog();
        const row: any = this.db.prepare("SELECT config_json FROM org_catalog WHERE id = 'default'").get();
        if (row?.config_json) return JSON.parse(row.config_json);
      } catch (err) {
        console.error("[SQLite] Lỗi đọc org_catalog:", err);
      }
    }
    return this.fallbackData.org_catalog || null;
  }

  private ensureSqliteOrgCatalog() {
    if (!(this.isNativeSqlite && this.db)) return;
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS org_catalog (id TEXT PRIMARY KEY, config_json TEXT NOT NULL)");
    } catch {}
  }

  private async loadOrgCatalog() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query("SELECT data FROM org_catalog WHERE id = 'default'");
      const raw = res.rows[0]?.data;
      const remote = raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as OrgCatalogRecord) : null;
      if (remote) {
        this.orgCatalogCache = remote;
      } else {
        // First run against PostgreSQL: keep whatever the local stores hold.
        const local = this.localOrgCatalog();
        if (local) this.saveOrgCatalog(local);
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp org_catalog:", err);
    }
  }

  /** The catalog, or null when it has never been created (the caller seeds it). */
  getOrgCatalog(): OrgCatalogRecord | null {
    return this.orgCatalogCache || this.localOrgCatalog();
  }

  saveOrgCatalog(catalog: OrgCatalogRecord): OrgCatalogRecord {
    const snapshot: OrgCatalogRecord = JSON.parse(JSON.stringify(catalog));
    const json = JSON.stringify(snapshot);
    this.orgCatalogCache = snapshot;
    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query(
          `INSERT INTO org_catalog (id, data, "updatedAt") VALUES ('default', $1::jsonb, $2)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = EXCLUDED."updatedAt"`,
          [json, new Date().toISOString()]
        )
        .catch((e: any) => console.error("[PostgreSQL] Lỗi lưu org_catalog:", e?.message));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteOrgCatalog();
        this.db
          .prepare(`INSERT INTO org_catalog (id, config_json) VALUES ('default', ?)
                    ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`)
          .run(json);
      } catch (err) {
        console.error("[SQLite] Lỗi lưu org_catalog:", err);
      }
    }
    this.fallbackData.org_catalog = snapshot;
    this.saveFallback();
    return snapshot;
  }

  // ================= OPERATOR ACCOUNTS =================
  // Every request re-checks the account behind its session (disabled? demoted?
  // password reset?), so reads must be synchronous: accounts live in memory,
  // hydrated from PostgreSQL at startup, and every write goes to all active
  // stores - the same arrangement as the face-template gallery.
  private usersCache: UserRecord[] = [];
  private usersHydrated = false;

  private parseUserRow(raw: unknown): UserRecord | null {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" && (parsed as any).id && (parsed as any).username
        ? (parsed as UserRecord)
        : null;
    } catch {
      return null;
    }
  }

  private localUsers(): UserRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteUsers();
        const rows = this.db.prepare("SELECT data FROM app_users").all() as any[];
        return rows.map((r) => this.parseUserRow(r.data)).filter(Boolean) as UserRecord[];
      } catch (err) {
        console.error("[SQLite] Lỗi đọc app_users:", err);
      }
    }
    return this.fallbackData.app_users || [];
  }

  private async loadUsers() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query("SELECT data FROM app_users");
      const remote = res.rows.map((r: any) => this.parseUserRow(r.data)).filter(Boolean) as UserRecord[];
      // Accounts created or changed while the process ran on the local stores
      // (PostgreSQL unreachable at the time) are merged in, newest write wins,
      // and pushed back so PostgreSQL ends up complete.
      const merged = new Map<string, UserRecord>(remote.map((u) => [u.id, u]));
      const toPush: UserRecord[] = [];
      for (const local of this.localUsers()) {
        const current = merged.get(local.id);
        if (!current || Date.parse(local.updatedAt) > Date.parse(current.updatedAt)) {
          merged.set(local.id, local);
          toPush.push(local);
        }
      }
      this.usersCache = [...merged.values()];
      this.usersHydrated = true;
      for (const u of toPush) this.saveUser(u);
      if (this.usersCache.length > 0) {
        console.log(`[PostgreSQL] Đã nạp ${this.usersCache.length} tài khoản vận hành.`);
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp app_users:", err);
    }
  }

  private ensureSqliteUsers() {
    if (!(this.isNativeSqlite && this.db)) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL,
          updatedAt TEXT
        );
      `);
    } catch {}
  }

  getUsers(): UserRecord[] {
    if (!this.usersHydrated && this.usersCache.length === 0) this.usersCache = this.localUsers();
    return this.usersCache;
  }

  getUserById(id: string): UserRecord | undefined {
    return this.getUsers().find((u) => u.id === id);
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const wanted = String(username || "").toLowerCase();
    return this.getUsers().find((u) => u.username === wanted);
  }

  /** Insert or replace by id. Writes through to every active store. */
  saveUser(user: UserRecord): UserRecord {
    const rec: UserRecord = JSON.parse(JSON.stringify(user));
    this.getUsers();
    const idx = this.usersCache.findIndex((u) => u.id === rec.id);
    if (idx >= 0) this.usersCache[idx] = rec; else this.usersCache.push(rec);
    const json = JSON.stringify(rec);

    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query(
          `INSERT INTO app_users (id, username, data, "updatedAt") VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, data = EXCLUDED.data, "updatedAt" = EXCLUDED."updatedAt"`,
          [rec.id, rec.username, json, rec.updatedAt]
        )
        .catch((e: any) => console.error("[PostgreSQL] Lỗi lưu tài khoản:", e?.message));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteUsers();
        this.db
          .prepare("INSERT OR REPLACE INTO app_users (id, username, data, updatedAt) VALUES (?, ?, ?, ?)")
          .run(rec.id, rec.username, json, rec.updatedAt);
      } catch (err) {
        console.error("[SQLite] Lỗi lưu tài khoản:", err);
      }
    }
    const fb = this.fallbackData.app_users || [];
    const fi = fb.findIndex((u) => u.id === rec.id);
    if (fi >= 0) fb[fi] = rec; else fb.push(rec);
    this.fallbackData.app_users = fb;
    this.saveFallback();
    return rec;
  }

  deleteUser(id: string): boolean {
    this.getUsers();
    const before = this.usersCache.length;
    this.usersCache = this.usersCache.filter((u) => u.id !== id);
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM app_users WHERE id = $1", [id]).catch((e: any) =>
        console.error("[PostgreSQL] Lỗi xóa tài khoản:", e?.message)
      );
    }
    if (this.isNativeSqlite && this.db) {
      try { this.ensureSqliteUsers(); this.db.prepare("DELETE FROM app_users WHERE id = ?").run(id); } catch {}
    }
    this.fallbackData.app_users = (this.fallbackData.app_users || []).filter((u) => u.id !== id);
    this.saveFallback();
    return this.usersCache.length < before;
  }

  // ================= FACE TEMPLATES (real engine gallery) =================
  // Matching runs synchronously inside request handling, so the gallery lives
  // in memory, hydrated from PostgreSQL at startup; every write goes to all
  // active stores. Embeddings are stored as float32 bytes (BYTEA / BLOB).
  private faceTemplatesCache: FaceTemplateRecord[] = [];
  private faceTemplatesHydrated = false;
  /**
   * PostgreSQL face_templates writes, in issue order. saveFaceTemplate and
   * deleteFaceTemplate are synchronous for their callers (the gallery is the
   * in-memory cache), so their PostgreSQL statements used to run unordered on
   * the pool: a delete could overtake the insert of the same id and the
   * template came back at the next restart. One chain keeps the order; jobs
   * that need durability await settleFaceTemplateWrites().
   */
  private faceTemplateWrites: Promise<void> = Promise.resolve();

  private queueFaceTemplateWrite(label: string, run: () => Promise<unknown>): void {
    this.faceTemplateWrites = this.faceTemplateWrites
      .then(run)
      .then(() => undefined, (e: any) => { console.error(`[PostgreSQL] Lỗi ${label}:`, e?.message); });
  }

  /** Resolves once every PostgreSQL template write issued so far has finished (succeeded or been logged). */
  settleFaceTemplateWrites(): Promise<void> {
    return this.faceTemplateWrites;
  }

  private async loadFaceTemplates() {
    if (!this.pgPool) return;
    try {
      const res = await this.pgPool.query(
        'SELECT id, "employeeId", embedding, dims, "modelTag", source, quality, "capturedAt", "sourceLogId", "streamId" FROM face_templates'
      );
      this.faceTemplatesCache = res.rows.map(rowToFaceTemplate);
      this.faceTemplatesHydrated = true;
      if (this.faceTemplatesCache.length > 0) {
        console.log(`[PostgreSQL] Đã nạp ${this.faceTemplatesCache.length} mẫu khuôn mặt (face templates).`);
      }
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp face_templates:", err);
    }
  }

  private ensureSqliteFaceTemplates() {
    if (!(this.isNativeSqlite && this.db)) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS face_templates (
          id TEXT PRIMARY KEY,
          employeeId TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dims INTEGER NOT NULL,
          modelTag TEXT NOT NULL,
          source TEXT NOT NULL,
          quality REAL,
          capturedAt TEXT,
          sourceLogId TEXT,
          streamId TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_face_templates_emp ON face_templates (employeeId);
      `);
    } catch {}
  }

  /** All templates (in-memory gallery). Hydrated from PostgreSQL; falls back to SQLite / JSON. */
  getFaceTemplates(): FaceTemplateRecord[] {
    if (this.faceTemplatesHydrated || this.faceTemplatesCache.length > 0) return this.faceTemplatesCache;
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteFaceTemplates();
        const rows = this.db.prepare("SELECT * FROM face_templates").all() as any[];
        this.faceTemplatesCache = rows.map(rowToFaceTemplate);
        return this.faceTemplatesCache;
      } catch {}
    }
    this.faceTemplatesCache = this.fallbackData.face_templates || [];
    return this.faceTemplatesCache;
  }

  getFaceTemplatesForEmployee(employeeId: string): FaceTemplateRecord[] {
    return this.getFaceTemplates().filter((t) => t.employeeId === employeeId);
  }

  /**
   * Templates per (employee, camera, source) - the coverage indicator and the
   * per-camera adaptation cap. Counted over the in-memory gallery, i.e. exactly
   * the templates matching uses (every write updates it synchronously), sorted
   * by employeeId, streamId (null first), source. Templates without a camera
   * (photo enrolment) count under streamId null.
   */
  async countFaceTemplatesByEmployeeAndStream(): Promise<FaceTemplateCount[]> {
    const counts = new Map<string, FaceTemplateCount>();
    for (const t of this.getFaceTemplates()) {
      const streamId = typeof t.streamId === "string" && t.streamId !== "" ? t.streamId : null;
      const key = `${t.employeeId}\u0000${streamId ?? ""}\u0000${t.source}`;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { employeeId: t.employeeId, streamId, source: t.source, count: 1 });
    }
    const text = (v: string | null) => (v === null ? "" : `\u0001${v}`);
    return [...counts.values()].sort((a, b) =>
      a.employeeId.localeCompare(b.employeeId) || text(a.streamId).localeCompare(text(b.streamId)) || a.source.localeCompare(b.source));
  }

  /** Insert or replace by id. Writes through to every active store. */
  saveFaceTemplate(t: FaceTemplateRecord): FaceTemplateRecord {
    const rec: FaceTemplateRecord = { ...t, dims: t.dims || t.embedding.length };
    this.getFaceTemplates();
    const idx = this.faceTemplatesCache.findIndex((x) => x.id === rec.id);
    if (idx >= 0) this.faceTemplatesCache[idx] = rec; else this.faceTemplatesCache.push(rec);

    const buf = embeddingToBuffer(rec.embedding);
    if (this.pgPool && this.isPostgres) {
      this.queueFaceTemplateWrite("saveFaceTemplate", () => this.pgPool!.query(
        `INSERT INTO face_templates (id, "employeeId", embedding, dims, "modelTag", source, quality, "capturedAt", "sourceLogId", "streamId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET "employeeId" = EXCLUDED."employeeId", embedding = EXCLUDED.embedding, dims = EXCLUDED.dims,
           "modelTag" = EXCLUDED."modelTag", source = EXCLUDED.source, quality = EXCLUDED.quality,
           "capturedAt" = EXCLUDED."capturedAt", "sourceLogId" = EXCLUDED."sourceLogId", "streamId" = EXCLUDED."streamId"`,
        [rec.id, rec.employeeId, buf, rec.dims, rec.modelTag, rec.source, rec.quality, rec.capturedAt, rec.sourceLogId || null, rec.streamId || null],
      ));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.ensureSqliteFaceTemplates();
        this.db
          .prepare(
            `INSERT OR REPLACE INTO face_templates (id, employeeId, embedding, dims, modelTag, source, quality, capturedAt, sourceLogId, streamId)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(rec.id, rec.employeeId, buf, rec.dims, rec.modelTag, rec.source, rec.quality, rec.capturedAt, rec.sourceLogId || null, rec.streamId || null);
      } catch (err) {
        console.error("[SQLite] Lỗi saveFaceTemplate:", err);
      }
    }
    const fb = this.fallbackData.face_templates || [];
    const fi = fb.findIndex((x) => x.id === rec.id);
    if (fi >= 0) fb[fi] = rec; else fb.push(rec);
    this.fallbackData.face_templates = fb;
    this.saveFallback();
    return rec;
  }

  deleteFaceTemplate(id: string): boolean {
    this.getFaceTemplates();
    const before = this.faceTemplatesCache.length;
    this.faceTemplatesCache = this.faceTemplatesCache.filter((t) => t.id !== id);
    if (this.pgPool && this.isPostgres) {
      this.queueFaceTemplateWrite("deleteFaceTemplate", () => this.pgPool!.query("DELETE FROM face_templates WHERE id = $1", [id]));
    }
    if (this.isNativeSqlite && this.db) {
      try { this.ensureSqliteFaceTemplates(); this.db.prepare("DELETE FROM face_templates WHERE id = ?").run(id); } catch {}
    }
    this.fallbackData.face_templates = (this.fallbackData.face_templates || []).filter((t) => t.id !== id);
    this.saveFallback();
    return this.faceTemplatesCache.length < before;
  }

  /** Remove every template of an employee (used when an employee is deleted). */
  deleteFaceTemplatesForEmployee(employeeId: string): number {
    const ids = this.getFaceTemplates().filter((t) => t.employeeId === employeeId).map((t) => t.id);
    for (const id of ids) this.deleteFaceTemplate(id);
    return ids.length;
  }

  /** Move an employee's templates to another (used by employee merge). */
  reassignFaceTemplates(fromEmployeeId: string, toEmployeeId: string): number {
    const moved = this.getFaceTemplates().filter((t) => t.employeeId === fromEmployeeId);
    for (const t of moved) this.saveFaceTemplate({ ...t, employeeId: toEmployeeId });
    return moved.length;
  }

  unmarkStrangerClusterResolved(clusterId: string): void {
    this.resolvedClustersCache = this.resolvedClustersCache.filter((id) => id !== clusterId);

    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query('DELETE FROM resolved_stranger_clusters WHERE "clusterId" = $1', [clusterId])
        .catch(() => {});
    }
    if (this.isNativeSqlite && this.db) {
      try {
        this.db.prepare("DELETE FROM resolved_stranger_clusters WHERE clusterId = ?").run(clusterId);
      } catch {}
    }

    const current = this.fallbackData.resolved_stranger_clusters || [];
    if (current.includes(clusterId)) {
      this.fallbackData.resolved_stranger_clusters = current.filter((id) => id !== clusterId);
      this.saveFallback();
    }
  }

  // Get info & statistics
  getStorageInfo() {
    let sizeBytes = 0;
    try {
      if (fs.existsSync(DB_PATH)) {
        sizeBytes = fs.statSync(DB_PATH).size;
      }
    } catch {}

    const engineNames = [];
    if (this.postgresConnected) {
      engineNames.push("PostgreSQL (Docker/External)");
    }
    if (this.isNativeSqlite) {
      engineNames.push("SQLite 3 (Node.js native DatabaseSync)");
    }
    if (engineNames.length === 0) {
      engineNames.push("JSON File Persistence Fallback");
    }

    return {
      engine: engineNames.join(" + "),
      postgresConnected: this.postgresConnected,
      postgresHost: this.postgresHost,
      postgresDatabase: this.postgresDatabase,
      postgresCounts: this.postgresCounts,
      sqlitePath: DB_PATH,
      sizeBytes,
      sizeFormatted: (sizeBytes / 1024).toFixed(2) + " KB",
    };
  }
}

export const db = new SQLiteStorage();

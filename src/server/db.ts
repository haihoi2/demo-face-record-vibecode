import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { Pool } from "pg";

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

export const DEFAULT_DOOR_CONTROLLER_CONFIG: DoorControllerConfigRecord = {
  enabled: true,
  apiUrl: "https://smartlock.eton.vn/api/door/control",
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
  source: "enrollment" | "merge" | "manual" | "auto";
  quality: number;
  capturedAt: string;
  sourceLogId?: string;
  streamId?: string;
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
    sourceLogId: r.sourceLogId || undefined,
    metadata: parse(r.metadata, {}) as Record<string, unknown>,
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

export function sameResolutionIntent(a: StrangerResolutionRecord, b: StrangerResolutionRecord): boolean {
  const aIds = [...a.logIds].sort();
  const bIds = [...b.logIds].sort();
  return a.clusterId === b.clusterId && a.action === b.action &&
    (a.employeeId || "") === (b.employeeId || "") &&
    (a.sourceLogId || "") === (b.sourceLogId || "") &&
    aIds.length === bIds.length && aIds.every((id, index) => id === bIds[index]) &&
    stableJson(a.metadata?.intent ?? null) === stableJson(b.metadata?.intent ?? null);
}

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
class SQLiteStorage {
  private db: any = null;
  private isNativeSqlite = false;
  private pgPool: Pool | null = null;
  private isPostgres = false;
  private postgresConnected = false;
  private postgresHost = "";
  private postgresDatabase = "";
  private postgresCounts: Record<string, number> = {};
  private onSyncCallbacks: Array<() => void> = [];

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
    if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
      return;
    }

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

      // Test connection
      const client = await this.pgPool.connect();
      try {
        await client.query("SELECT 1");
        this.postgresConnected = true;
        this.isPostgres = true;
        console.log(`[PostgreSQL] Đã kết nối cơ sở dữ liệu PostgreSQL thành công (${this.postgresHost}/${this.postgresDatabase})!`);
        await this.createPostgresTables();
        await this.syncWithPostgres();
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn(`[PostgreSQL] Không thể kết nối PostgreSQL (${err?.message}). Tiếp tục với SQLite/JSON.`);
      this.isPostgres = false;
      this.postgresConnected = false;
    }
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
              "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            ON CONFLICT (id) DO NOTHING
          `, [
            log.id, log.timestamp, log.type, log.status,
            log.employeeId || null, log.employeeName || null, log.employeeCode || null,
            log.department || null, log.photoSnapshot, log.confidence,
            log.livenessScore ?? null, log.lockAction, log.doorName, log.reason || null,
            log.faceEmbedding?.length ? embeddingToBuffer(log.faceEmbedding) : null,
            log.faceEmbedding?.length || null, log.faceEmbeddingModelTag || null, log.faceEmbeddingQuality ?? null
          ]);
        }
        console.log(`[PostgreSQL] Đã khởi tạo và đồng bộ ${existingLogs.length} bản ghi truy cập vào PostgreSQL!`);
      } else {
        const pgLogs = await this.pgPool.query(`
          SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
                 department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
                 "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality"
          FROM access_logs ORDER BY timestamp DESC LIMIT 100
        `);
        for (const r of pgLogs.rows) {
          if (this.isNativeSqlite && this.db) {
            try {
              const stmt = this.db.prepare(`
                INSERT INTO access_logs (
                  id, timestamp, type, status, employeeId, employeeName, employeeCode,
                  department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason,
                  faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
              `);
              stmt.run(
                r.id, r.timestamp, r.type, r.status,
                r.employeeId || null, r.employeeName || null, r.employeeCode || null,
                r.department || null, r.photoSnapshot, r.confidence,
                r.livenessScore ?? null, r.lockAction, r.doorName, r.reason || null,
                r.faceEmbedding || null, r.faceEmbeddingDims || null,
                r.faceEmbeddingModelTag || null, r.faceEmbeddingQuality ?? null
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
          "faceEmbeddingQuality" REAL
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
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
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
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
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

        -- Migration: stranger-alert settings for databases created before they existed
        ALTER TABLE webhook_config ADD COLUMN IF NOT EXISTS "strangerConfig" TEXT;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbedding" BYTEA;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingDims" INTEGER;
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingModelTag" VARCHAR(128);
        ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS "faceEmbeddingQuality" REAL;
      `);
      await this.loadResolvedStrangerClusters();
      await this.loadStrangerResolutions();
      await this.loadStrangerResolutionEvents();
      await this.loadAiRecognitionConfig();
      await this.loadCameraStreamsConfig();
      await this.loadFaceTemplates();
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
        faceEmbeddingQuality REAL
      );

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
        metadata TEXT NOT NULL DEFAULT '{}'
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
        metadata TEXT NOT NULL DEFAULT '{}'
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
    ]) {
      try { this.db.exec(migration); } catch { /* column already present */ }
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

  private rebuildFallbackStrangerIndex(): void {
    this.fallbackStrangerHead = null;
    this.fallbackStrangerNodes.clear();
    for (let index = this.fallbackData.access_logs.length - 1; index >= 0; index -= 1) {
      this.prependFallbackStrangerCandidate(this.fallbackData.access_logs[index]);
    }
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
      const [rows, count] = await Promise.all([
        this.pgPool.query(
          `SELECT id, timestamp, type, status, "employeeId", "employeeName", "employeeCode", department,
                  confidence, "livenessScore", "lockAction", "doorName", reason,
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

  async getAccessLogById(id: string): Promise<AccessLogRecord | undefined> {
    if (this.pgPool && this.isPostgres) {
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
   * or reclusters the complete access-log history.
   */
  async getStrangerCandidateLogsPage(
    cursor: { timestamp: string; id: string } | null,
    limit: number,
  ): Promise<{ logs: AccessLogRecord[]; hasMore: boolean }> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const fetchLimit = boundedLimit + 1;
    if (this.pgPool && this.isPostgres) {
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
                  "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality"
             FROM access_logs
            WHERE "photoSnapshot" IS NOT NULL AND "photoSnapshot" <> ''
              AND (status = 'DENIED' OR "employeeId" IS NULL OR "employeeName" = 'Không xác định')${cursorWhere}
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
                faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality FROM access_logs
          WHERE photoSnapshot IS NOT NULL AND photoSnapshot <> ''
            AND (status = 'DENIED' OR employeeId IS NULL OR employeeName = 'Không xác định')${cursorWhere}
          ORDER BY timestamp DESC, id DESC LIMIT ?`,
      ).all(...params) as any[];
      return { logs: rows.slice(0, boundedLimit).map(rowToAccessLog), hasMore: rows.length > boundedLimit };
    }
    let node = cursor ? this.fallbackStrangerNodes.get(cursor.id)?.next || null : this.fallbackStrangerHead;
    const rows: AccessLogRecord[] = [];
    while (node && rows.length < fetchLimit) {
      rows.push(node.log);
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

  getRetiredStrangerObservationIds(): string[] {
    return this.getStrangerResolutions().flatMap((resolution) => resolution.logIds.map((id) => `log:${id}`));
  }

  /** Insert an immutable physical access event. Replays with the same id are no-ops. */
  saveAccessLog(log: AccessLogRecord) {
    const embedding = log.faceEmbedding?.length ? embeddingToBuffer(log.faceEmbedding) : null;
    const embeddingDims = log.faceEmbedding?.length || null;
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query(`
        INSERT INTO access_logs (
          id, timestamp, type, status, "employeeId", "employeeName", "employeeCode",
          department, "photoSnapshot", confidence, "livenessScore", "lockAction", "doorName", reason,
          "faceEmbedding", "faceEmbeddingDims", "faceEmbeddingModelTag", "faceEmbeddingQuality"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO NOTHING
      `, [
        log.id, log.timestamp, log.type, log.status,
        log.employeeId || null, log.employeeName || null, log.employeeCode || null,
        log.department || null, log.photoSnapshot, log.confidence,
        log.livenessScore ?? null, log.lockAction, log.doorName, log.reason || null,
        embedding, embeddingDims, log.faceEmbeddingModelTag || null, log.faceEmbeddingQuality ?? null,
      ]).catch((e) => console.error("[PostgreSQL] Lỗi saveAccessLog:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO access_logs (
            id, timestamp, type, status, employeeId, employeeName, employeeCode,
            department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason,
            faceEmbedding, faceEmbeddingDims, faceEmbeddingModelTag, faceEmbeddingQuality
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveAccessLog:", err);
      }
    }
    if (!this.fallbackData.access_logs.some((existing) => existing.id === log.id)) {
      const stored = { ...log };
      this.fallbackData.access_logs.unshift(stored);
      this.prependFallbackStrangerCandidate(stored);
      this.saveFallback();
    }
  }

  clearAccessLogs() {
    if (this.pgPool && this.isPostgres) {
      this.pgPool.query("DELETE FROM access_logs")
        .catch((e) => console.error("[PostgreSQL] Lỗi clearAccessLogs:", e.message));
    }

    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec("DELETE FROM access_logs");
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi clearAccessLogs:", err);
      }
    }
    this.fallbackData.access_logs = [];
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
        'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolution_events ORDER BY "resolvedAt", id'
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
        this.strangerResolutionEventsCache = [...(this.fallbackData.stranger_resolution_events || [])];
      }
      this.strangerResolutionEventsHydrated = true;
    }
    return this.strangerResolutionEventsCache
      .filter((record) => !clusterId || record.clusterId === clusterId)
      .map((record) => ({ ...record, logIds: [...record.logIds], metadata: { ...(record.metadata || {}) } }));
  }

  private async loadStrangerResolutions(): Promise<void> {
    if (!this.pgPool) return;
    try {
      const result = await this.pgPool.query(
        'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolutions'
      );
      this.strangerResolutionsCache = result.rows.map(rowToStrangerResolution);
      this.strangerResolutionsHydrated = true;
    } catch (err) {
      console.error("[PostgreSQL] Lỗi nạp adjudication người lạ:", err);
    }
  }

  getStrangerResolutions(): StrangerResolutionRecord[] {
    if (this.strangerResolutionsHydrated || this.strangerResolutionsCache.length > 0) {
      return this.strangerResolutionsCache.map((record) => ({ ...record, logIds: [...record.logIds] }));
    }
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM stranger_resolutions").all() as any[];
        this.strangerResolutionsCache = rows.map(rowToStrangerResolution);
        this.strangerResolutionsHydrated = true;
        return this.getStrangerResolutions();
      } catch {}
    }
    this.strangerResolutionsCache = [...(this.fallbackData.stranger_resolutions || [])];
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
          'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1 FOR UPDATE',
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
          'INSERT INTO stranger_resolutions (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)',
          [resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {})],
        );
        await client.query(
          'INSERT INTO stranger_resolution_events (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)',
          [resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {})],
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
            'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1',
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
        this.db.prepare("INSERT INTO stranger_resolutions (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}));
        this.db.prepare("INSERT INTO stranger_resolution_events (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(resolution.id, resolution.clusterId, resolution.action, resolution.employeeId || null, resolution.actor,
            resolution.resolvedAt, JSON.stringify(resolution.logIds), resolution.sourceLogId || null, JSON.stringify(resolution.metadata || {}));
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
      if (found) return classify(found);
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
      metadata: { ...(record.metadata || {}) },
    };
    if (this.pgPool && this.isPostgres) {
      await this.pgPool.query(
        `INSERT INTO stranger_resolutions
          (id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
         ON CONFLICT ("clusterId") DO NOTHING`,
        [snapshot.id, snapshot.clusterId, snapshot.action, snapshot.employeeId || null, snapshot.actor,
          snapshot.resolvedAt, JSON.stringify(snapshot.logIds), snapshot.sourceLogId || null,
          JSON.stringify(snapshot.metadata || {})]
      );
    }
    if (this.isNativeSqlite && this.db) {
      this.db.prepare(
        `INSERT OR IGNORE INTO stranger_resolutions
          (id, clusterId, action, employeeId, actor, resolvedAt, logIds, sourceLogId, metadata)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(snapshot.id, snapshot.clusterId, snapshot.action, snapshot.employeeId || null, snapshot.actor,
        snapshot.resolvedAt, JSON.stringify(snapshot.logIds), snapshot.sourceLogId || null,
        JSON.stringify(snapshot.metadata || {}));
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
      metadata: { ...(record.metadata || {}) },
    };
    const existing = this.getStrangerResolution(restore.clusterId);
    if (!existing || existing.action !== "DISMISS" || !sameResolutionIntent(
      existing,
      { ...existing, logIds: restore.logIds },
    )) throw new Error("restore-conflict");

    if (this.pgPool && this.isPostgres) {
      const client = await this.pgPool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          'SELECT id, "clusterId", action, "employeeId", actor, "resolvedAt", "logIds", "sourceLogId", metadata FROM stranger_resolutions WHERE "clusterId"=$1 FOR UPDATE',
          [restore.clusterId],
        );
        const current = found.rows[0] ? rowToStrangerResolution(found.rows[0]) : undefined;
        if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds })) {
          await client.query("ROLLBACK");
          throw new Error("restore-conflict");
        }
        await client.query(
          'INSERT INTO stranger_resolution_events (id,"clusterId",action,"employeeId",actor,"resolvedAt","logIds","sourceLogId",metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)',
          [restore.id, restore.clusterId, restore.action, null, restore.actor, restore.resolvedAt,
            JSON.stringify(restore.logIds), restore.sourceLogId || null, JSON.stringify(restore.metadata || {})],
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
        if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds })) {
          throw new Error("restore-conflict");
        }
        this.db.prepare("INSERT INTO stranger_resolution_events (id,clusterId,action,employeeId,actor,resolvedAt,logIds,sourceLogId,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(restore.id, restore.clusterId, restore.action, null, restore.actor, restore.resolvedAt,
            JSON.stringify(restore.logIds), restore.sourceLogId || null, JSON.stringify(restore.metadata || {}));
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
      if (!current || current.action !== "DISMISS" || !sameResolutionIntent(current, { ...current, logIds: restore.logIds })) {
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

  // ================= FACE TEMPLATES (real engine gallery) =================
  // Matching runs synchronously inside request handling, so the gallery lives
  // in memory, hydrated from PostgreSQL at startup; every write goes to all
  // active stores. Embeddings are stored as float32 bytes (BYTEA / BLOB).
  private faceTemplatesCache: FaceTemplateRecord[] = [];
  private faceTemplatesHydrated = false;

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

  /** Insert or replace by id. Writes through to every active store. */
  saveFaceTemplate(t: FaceTemplateRecord): FaceTemplateRecord {
    const rec: FaceTemplateRecord = { ...t, dims: t.dims || t.embedding.length };
    this.getFaceTemplates();
    const idx = this.faceTemplatesCache.findIndex((x) => x.id === rec.id);
    if (idx >= 0) this.faceTemplatesCache[idx] = rec; else this.faceTemplatesCache.push(rec);

    const buf = embeddingToBuffer(rec.embedding);
    if (this.pgPool && this.isPostgres) {
      this.pgPool
        .query(
          `INSERT INTO face_templates (id, "employeeId", embedding, dims, "modelTag", source, quality, "capturedAt", "sourceLogId", "streamId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET "employeeId" = EXCLUDED."employeeId", embedding = EXCLUDED.embedding, dims = EXCLUDED.dims,
             "modelTag" = EXCLUDED."modelTag", source = EXCLUDED.source, quality = EXCLUDED.quality,
             "capturedAt" = EXCLUDED."capturedAt", "sourceLogId" = EXCLUDED."sourceLogId", "streamId" = EXCLUDED."streamId"`,
          [rec.id, rec.employeeId, buf, rec.dims, rec.modelTag, rec.source, rec.quality, rec.capturedAt, rec.sourceLogId || null, rec.streamId || null]
        )
        .catch((e: any) => console.error("[PostgreSQL] Lỗi saveFaceTemplate:", e?.message));
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
      this.pgPool.query("DELETE FROM face_templates WHERE id = $1", [id]).catch(() => {});
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

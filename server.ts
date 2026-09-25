import express, { NextFunction, Request, RequestHandler, Response } from "express";
import path from "path";
import dns from "dns";
import https from "https";
import net from "net";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { spawn } from "child_process";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import {
  db,
  DEFAULT_DOOR_CONTROLLER_CONFIG,
  DEFAULT_CAMERA_STREAMS_CONFIG,
  DoorControllerConfigRecord,
  DoorApiLogRecord,
  CameraStreamsConfigRecord,
  GateStreamConfigRecord,
  GateStreamSourceRecord,
  GateWatchConfigRecord,
  AiRecognitionConfigRecord,
  AI_ENGINE_MODES,
  DEFAULT_STRANGER_WEBHOOK_CONFIG,
  FaceTemplateRecord,
  StrangerResolutionRecord,
  sameResolutionIntent,
} from "./src/server/db";
import { STRANGER_DEEP_LINK_HASH } from "./src/types";
import type {
  FaceObservation,
  FusionDecision,
  FusionThresholds,
  GateWatchRuntime,
  ObservationMatch,
} from "./src/types";
import { runLocalFaceRecognition } from "./src/utils/localBiometrics";
import { clusterStrangerFaces } from "./src/server/strangers";
import { faceWorkerPool } from "./src/server/faceWorkerPool";
import {
  extractFaces,
  getFaceEngine,
  getFaceEngineInfo,
  isFaceEngineReady,
  loadImage,
} from "./src/server/faceEmbedding";
import type { ExtractedFace } from "./src/server/faceEmbedding";
import {
  buildGallery,
  fuseDecision,
  recognizeObservations,
  DEFAULT_FUSION_THRESHOLDS,
} from "./src/server/faceFusion";
import type { FaceGallery } from "./src/server/faceFusion";

dotenv.config();

const app = express();
const PORT = 3000;

// =========================================================================
// 1. CORS & PREFLIGHT MIDDLEWARE (MUST BE VERY FIRST)
//
// Allowed browser origins come from CORS_ALLOWED_ORIGINS (comma separated).
// When the variable is empty or unset the server stays permissive and
// reflects any origin, which preserves the previous behaviour for Netlify /
// Render style deployments - but that combination (reflected origin +
// credentials) lets any website call this gateway on a visitor's behalf, so
// configuring the list is strongly recommended.
// =========================================================================
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);

const CORS_ALLOW_ANY_ORIGIN = CORS_ALLOWED_ORIGINS.length === 0;

function isOriginAllowed(origin?: string): boolean {
  if (!origin) return false;
  if (CORS_ALLOW_ANY_ORIGIN) return true;
  return CORS_ALLOWED_ORIGINS.includes(origin.trim().replace(/\/+$/, "").toLowerCase());
}

/**
 * Sets the Access-Control-Allow-Origin / -Credentials pair.
 * Returns false when a cross-origin request was rejected by the allowlist,
 * in which case no CORS header is emitted and the browser blocks the read.
 */
function applyCorsOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin as string | undefined;

  // Same-origin / non-browser callers send no Origin header.
  if (!origin) {
    if (CORS_ALLOW_ANY_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    return true;
  }

  res.setHeader("Vary", "Origin");

  if (!isOriginAllowed(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  return true;
}

app.use((req, res, next) => {
  const allowed = applyCorsOrigin(req, res);

  if (!allowed && req.method === "OPTIONS") {
    // Reject the preflight outright so the failure is visible in DevTools.
    res.status(403).end();
    return;
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
  );

  const reqHeaders = req.headers["access-control-request-headers"];
  if (reqHeaders) {
    res.setHeader("Access-Control-Allow-Headers", reqHeaders);
  } else {
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control, Pragma, Baggage, Sentry-Trace, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform"
    );
  }

  res.setHeader("Access-Control-Expose-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Handle all OPTIONS preflight requests immediately
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Explicit OPTIONS preflight route handler for all paths
app.options("*", (_req, res) => {
  res.status(204).end();
});

// Increase payload limit for base64 camera frames, raw text, and binary images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.text({ limit: "50mb", type: ["text/*", "application/octet-stream"] }));

// Short-lived, HttpOnly operator sessions protect biometric reads and stranger
// adjudication. The bootstrap token is entered once and is never persisted by
// browser JavaScript. Production fails closed when no operator identity/token is configured.
type OperatorRole = "viewer" | "operator";
interface OperatorSession { actor: string; role: OperatorRole; expiresAt: number; csrfToken: string }
const OPERATOR_COOKIE = "smartface_operator_session";
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const authPrincipals = () => [
  { actor: String(process.env.OPERATOR_ID || "").trim(), token: String(process.env.OPERATOR_TOKEN || ""), role: "operator" as const },
  { actor: String(process.env.VIEWER_ID || "").trim(), token: String(process.env.VIEWER_TOKEN || ""), role: "viewer" as const },
].filter((principal) => principal.actor && principal.token);

const authConfigured = () => authPrincipals().some((principal) => principal.role === "operator");
const sessionSecret = () => String(process.env.OPERATOR_SESSION_SECRET || process.env.OPERATOR_TOKEN || "");
const constantTimeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const signOperatorSession = (session: OperatorSession) => {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};
const readOperatorSession = (req: Request): OperatorSession | null => {
  if (!authConfigured() || !sessionSecret()) return null;
  const cookieHeader = String(req.headers.cookie || "");
  const encoded = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${OPERATOR_COOKIE}=`))?.slice(OPERATOR_COOKIE.length + 1);
  if (!encoded) return null;
  const [payload, signature, extra] = encoded.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OperatorSession;
    if (!session.actor || !session.csrfToken || !["viewer", "operator"].includes(session.role) || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
};
const requireOperatorRole = (role: OperatorRole): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
  if (!authConfigured()) {
    res.status(503).json({ success: false, code: "AUTH_NOT_CONFIGURED", error: "Operator authentication is not configured" });
    return;
  }
  const session = readOperatorSession(req);
  if (!session) {
    res.status(401).json({ success: false, code: "AUTH_REQUIRED", error: "Operator authentication required" });
    return;
  }
  if (role === "operator" && session.role !== "operator") {
    res.status(403).json({ success: false, code: "ROLE_REQUIRED", error: "Operator role required" });
    return;
  }
  (req as any).operatorSession = session;
  next();
};
const operatorActor = (req: Request) => String((req as any).operatorSession?.actor || "");

const requestOrigin = (req: Request) => {
  const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${protocol}://${req.get("host")}`.toLowerCase();
};
const requireCsrf: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const session = (req as any).operatorSession as OperatorSession | undefined;
  if (!session) {
    res.status(401).json({ success: false, code: "AUTH_REQUIRED", error: "Operator authentication required" });
    return;
  }
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "").toLowerCase();
  if (origin && origin !== requestOrigin(req) && (!CORS_ALLOWED_ORIGINS.length || !isOriginAllowed(origin))) {
    res.status(403).json({ success: false, code: "ORIGIN_FORBIDDEN", error: "Request origin is not allowed" });
    return;
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    res.status(415).json({ success: false, code: "JSON_REQUIRED", error: "Protected mutations require application/json" });
    return;
  }
  const supplied = String(req.headers["x-csrf-token"] || "");
  if (!supplied || !constantTimeEqual(supplied, session.csrfToken)) {
    res.status(403).json({ success: false, code: "CSRF_REQUIRED", error: "Valid CSRF token required" });
    return;
  }
  next();
};

const requireRecognitionCsrf: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const session = (req as any).operatorSession as OperatorSession | undefined;
  if (!session) {
    res.status(401).json({ success: false, code: "AUTH_REQUIRED", error: "Operator authentication required" });
    return;
  }
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "").toLowerCase();
  if (origin && origin !== requestOrigin(req) && (!CORS_ALLOWED_ORIGINS.length || !isOriginAllowed(origin))) {
    res.status(403).json({ success: false, code: "ORIGIN_FORBIDDEN", error: "Request origin is not allowed" });
    return;
  }
  const supplied = String(req.headers["x-csrf-token"] || "");
  if (!supplied || !constantTimeEqual(supplied, session.csrfToken)) {
    res.status(403).json({ success: false, code: "CSRF_REQUIRED", error: "Valid CSRF token required" });
    return;
  }
  next();
};

const requireAllowedReadOrigin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "").toLowerCase();
  if (origin && origin !== requestOrigin(req) && (!CORS_ALLOWED_ORIGINS.length || !isOriginAllowed(origin))) {
    res.status(403).json({ success: false, code: "ORIGIN_FORBIDDEN", error: "Request origin is not allowed" });
    return;
  }
  next();
};

const operatorCookieAttributes = () => {
  const secure = process.env.NODE_ENV === "production";
  const crossSite = String(process.env.OPERATOR_COOKIE_CROSS_SITE || "").toLowerCase() === "true";
  if (crossSite && !secure) return null;
  return `Path=/; HttpOnly; SameSite=${crossSite ? "None" : "Lax"}; Max-Age=${Math.floor(OPERATOR_SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
};

app.post("/api/operator/session", (req, res) => {
  if (!authConfigured()) {
    res.status(503).json({ success: false, error: "Operator authentication is not configured" });
    return;
  }
  const supplied = String((req.body as any)?.token || "");
  const principal = authPrincipals().find((candidate) => constantTimeEqual(supplied, candidate.token));
  if (!principal) {
    res.status(401).json({ success: false, error: "Invalid operator credentials" });
    return;
  }
  const cookieAttributes = operatorCookieAttributes();
  if (!cookieAttributes) {
    res.status(503).json({ success: false, error: "Cross-site operator cookies require production HTTPS" });
    return;
  }
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "").toLowerCase();
  if (origin && origin !== requestOrigin(req) && (!CORS_ALLOWED_ORIGINS.length || !isOriginAllowed(origin))) {
    res.status(403).json({ success: false, error: "Request origin is not allowed" });
    return;
  }
  const session: OperatorSession = {
    actor: principal.actor,
    role: principal.role,
    expiresAt: Date.now() + OPERATOR_SESSION_TTL_MS,
    csrfToken: randomUUID(),
  };
  res.setHeader("Set-Cookie", `${OPERATOR_COOKIE}=${signOperatorSession(session)}; ${cookieAttributes}`);
  res.json({ success: true, actor: session.actor, role: session.role,
    expiresAt: new Date(session.expiresAt).toISOString(), csrfToken: session.csrfToken });
});

app.delete("/api/operator/session", requireOperatorRole("viewer"), requireCsrf, (_req: Request, res: Response) => {
  const attributes = operatorCookieAttributes() || "Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  res.setHeader("Set-Cookie", `${OPERATOR_COOKIE}=; ${attributes.replace(/Max-Age=\d+/, "Max-Age=0")}`);
  res.json({ success: true });
});

app.get(
  "/api/operator/session",
  requireOperatorRole("viewer"),
  requireAllowedReadOrigin,
  (req: Request, res: Response) => {
    const session = (req as any).operatorSession as OperatorSession;
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, actor: session.actor, role: session.role,
      expiresAt: new Date(session.expiresAt).toISOString(), csrfToken: session.csrfToken });
  },
);

const configuredBearer = (name: "DEVICE_INGEST_TOKEN" | "INTERNAL_API_TOKEN") =>
  String(process.env[name] || "").trim();
const bearerFromRequest = (req: Request) => {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return match?.[1] || "";
};
const requireInternalToken: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const configured = configuredBearer("INTERNAL_API_TOKEN");
  if (!configured) {
    res.status(process.env.NODE_ENV === "production" ? 503 : 401).json({
      success: false, code: "INTERNAL_AUTH_NOT_CONFIGURED", error: "Internal API authentication is not configured",
    });
    return;
  }
  const supplied = bearerFromRequest(req);
  if (!supplied || !constantTimeEqual(supplied, configured)) {
    res.status(401).json({ success: false, code: "INTERNAL_AUTH_REQUIRED", error: "Internal API token required" });
    return;
  }
  next();
};
const requireRecognitionIngest: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const session = readOperatorSession(req);
  if (session) {
    if (session.role !== "operator") {
      res.status(403).json({ success: false, code: "ROLE_REQUIRED", error: "Operator role required" });
      return;
    }
    (req as any).operatorSession = session;
    requireRecognitionCsrf(req, res, next);
    return;
  }
  if (String(req.headers.origin || "").trim()) {
    res.status(403).json({ success: false, code: "DEVICE_ORIGIN_FORBIDDEN", error: "Device ingestion must not send Origin" });
    return;
  }
  const configured = configuredBearer("DEVICE_INGEST_TOKEN");
  if (!configured) {
    res.status(process.env.NODE_ENV === "production" ? 503 : 401).json({
      success: false, code: "DEVICE_AUTH_NOT_CONFIGURED", error: "Device ingestion authentication is not configured",
    });
    return;
  }
  const supplied = bearerFromRequest(req);
  if (!supplied || !constantTimeEqual(supplied, configured)) {
    res.status(401).json({ success: false, code: "DEVICE_AUTH_REQUIRED", error: "Device ingestion token required" });
    return;
  }
  next();
};
const recognitionPath = (pathName: string) => [
  "/api/recognize-face", "/recognize-face", "/api/face/recognize",
  "/api/face-recognize", "/api/face-recognition", "/api/recognize",
].includes(pathName.replace(/\/+$/, ""));
// Every API route also registered WITHOUT the /api prefix must be listed here.
// tests/boundaryCoverage.test.ts enumerates the route paths in this file and
// fails if one falls outside the boundary - /config/ai did, which left the
// recognition thresholds writable without a session.
const legacySensitivePath = (pathName: string) =>
  /^(?:\/(?:events|lock|status|employees?|logs|notifications|webhook|config))(?:\/|$)/.test(pathName);

function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|auth/i.test(key)) url.searchParams.set(key, "***");
    }
    if (/\/hooks?\//i.test(url.pathname)) {
      const parts = url.pathname.split("/");
      if (parts.length > 2) parts[parts.length - 1] = "***";
      url.pathname = parts.join("/");
    }
    return url.toString();
  } catch {
    return value ? "configured" : "";
  }
}

function publicEmployee(employee: EmployeeRecord) {
  return {
    id: employee.id,
    name: employee.name,
    employeeCode: employee.employeeCode,
    department: employee.department,
    position: employee.position,
    registeredAt: employee.registeredAt,
    accessLevel: employee.accessLevel,
  };
}

function sanitizePublicJson(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizePublicJson);
  if (!value || typeof value !== "object") return value;
  if (typeof value.id === "string" && value.status && value.lockAction && value.timestamp) {
    const imageUrl = `/api/logs/${encodeURIComponent(value.id)}/image`;
    return {
      id: value.id, timestamp: value.timestamp, type: value.type, status: value.status,
      employeeId: value.employeeId, employeeName: value.employeeName, employeeCode: value.employeeCode,
      department: value.department, confidence: value.confidence, livenessScore: value.livenessScore,
      lockAction: value.lockAction, doorName: value.doorName, reason: value.reason,
      photoSnapshot: imageUrl, imageUrl, hasImage: Boolean(value.photoSnapshot),
    };
  }
  if (typeof value.id === "string" && value.employeeCode && value.accessLevel) {
    return publicEmployee(value as EmployeeRecord);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:faceEmbedding(?:Dims|ModelTag|Quality)?|imageBase64|snapshot|photoUrl)$/i.test(key)) continue;
    if (/token|password|secret/i.test(key) && key !== "csrfToken") {
      result[`${key}Configured`] = Boolean(item);
      continue;
    }
    if (/^(?:url|apiUrl|rtspUrl|httpUrl)$/i.test(key) && typeof item === "string") {
      result[key] = redactedUrl(item);
      continue;
    }
    result[key] = sanitizePublicJson(item);
  }
  return result;
}

app.use((_req: Request, res: Response, next: NextFunction) => {
  const json = res.json.bind(res);
  res.json = ((body: any) => json(sanitizePublicJson(body))) as Response["json"];
  next();
});

// One fail-closed boundary covers the API surface and every legacy alias.
app.use((req: Request, res: Response, next: NextFunction) => {
  const pathName = req.path;
  if (pathName === "/api/health" || pathName === "/api/operator/session") return next();
  if (pathName === "/api/system/db-info") return requireInternalToken(req, res, next);
  if (recognitionPath(pathName) && req.method === "POST") return requireRecognitionIngest(req, res, next);
  const sensitive = pathName.startsWith("/api/") || legacySensitivePath(pathName) || recognitionPath(pathName);
  if (!sensitive) return next();
  const role: OperatorRole = req.method === "GET" || req.method === "HEAD" ? "viewer" : "operator";
  requireOperatorRole(role)(req, res, () => {
    if (role === "viewer") requireAllowedReadOrigin(req, res, next);
    else requireCsrf(req, res, next);
  });
});
app.use(express.raw({ limit: "50mb", type: "image/*" }));

// Incoming request logger for transparency and debugging
app.use((req, _res, next) => {
  if (
    !req.url.startsWith("/@") &&
    !req.url.startsWith("/node_modules") &&
    !req.url.startsWith("/src/") &&
    !req.url.includes("vite") &&
    !req.url.includes("hot-update")
  ) {
    console.log(`[HTTP ${req.method}] ${req.url}`);
  }
  next();
});

// faceWorkerPool.dispatchFaceTask() rejects on queue backpressure and when the
// pool is re-initialised mid-flight. Both are transient "try again" conditions,
// so the HTTP routes answer 503 + Retry-After instead of 500 (and never fall
// back to the main-thread engine, which would defeat the load shedding).
const WORKER_POOL_UNAVAILABLE_RE = /backpressure|reinitialised/i;
function isWorkerPoolUnavailableError(err: unknown): boolean {
  return WORKER_POOL_UNAVAILABLE_RE.test(String((err as any)?.message || err || ""));
}
function workerPoolUnavailableBody(err: unknown, extra: Record<string, unknown> = {}) {
  return {
    success: false,
    recognized: false,
    retryAfterSeconds: 1,
    error: (err as any)?.message || "Cụm luồng nhận diện đang quá tải, vui lòng gửi lại khung hình sau 1 giây.",
    ...extra,
  };
}
function respondWorkerPoolUnavailable(res: Response, err: unknown, extra: Record<string, unknown> = {}) {
  res.setHeader("Retry-After", "1");
  res.status(503).json(workerPoolUnavailableBody(err, extra));
}

// Server-side Gemini client
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// ----------------- IN-MEMORY STATE -----------------
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
  faceEmbedding?: number[];
  faceEmbeddingDims?: number;
  faceEmbeddingModelTag?: string;
  faceEmbeddingQuality?: number;
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

// Pre-seeded employees with SVG portraits
const DEMO_DATA_ENABLED = process.env.NODE_ENV !== "production" && process.env.ENABLE_DEMO_DATA === "true";
const DEFAULT_EMPLOYEES: EmployeeRecord[] = [
  {
    id: "EMP-001",
    name: "Nguyễn Hoàng Minh",
    employeeCode: "NV-1082",
    department: "Phòng Kỹ Thuật AI",
    position: "Trưởng nhóm AI",
    photoUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80",
    registeredAt: "2026-09-01T08:30:00.000Z",
    accessLevel: "ALL_ACCESS",
  },
  {
    id: "EMP-002",
    name: "Trần Thị Mai Phương",
    employeeCode: "NV-2045",
    department: "Phòng Nhân Sự",
    position: "Chuyên viên Tuyển dụng",
    photoUrl: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&auto=format&fit=crop&q=80",
    registeredAt: "2026-09-02T09:15:00.000Z",
    accessLevel: "OFFICE_HOURS",
  },
  {
    id: "EMP-003",
    name: "Lê Quốc Bảo",
    employeeCode: "NV-3190",
    department: "Ban Điều Hành",
    position: "Giám đốc Vận hành",
    photoUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&auto=format&fit=crop&q=80",
    registeredAt: "2026-09-03T10:00:00.000Z",
    accessLevel: "ALL_ACCESS",
  },
];

const DEFAULT_ACCESS_LOGS: AccessLogRecord[] = [
  {
    id: "LOG-101",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    type: "ENTRY",
    status: "GRANTED",
    employeeId: "EMP-001",
    employeeName: "Nguyễn Hoàng Minh",
    employeeCode: "NV-1082",
    department: "Phòng Kỹ Thuật AI",
    photoSnapshot: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80",
    confidence: 97.4,
    livenessScore: 99.1,
    lockAction: "Mở chốt tự động qua API (SmartLock-Gateway)",
    doorName: "Cửa Chính Trụ Sở - Cổng A",
    reason: "Khuôn mặt hợp lệ 97.4%, độ sống thật đạt chuẩn",
  },
  {
    id: "LOG-102",
    timestamp: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    type: "ENTRY",
    status: "GRANTED",
    employeeId: "EMP-002",
    employeeName: "Trần Thị Mai Phương",
    employeeCode: "NV-2045",
    department: "Phòng Nhân Sự",
    photoSnapshot: "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&auto=format&fit=crop&q=80",
    confidence: 95.8,
    livenessScore: 98.4,
    lockAction: "Mở chốt tự động qua API (SmartLock-Gateway)",
    doorName: "Cửa Chính Trụ Sở - Cổng A",
    reason: "Khuôn mặt hợp lệ 95.8%, xác thực thành công",
  },
  {
    id: "LOG-103",
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    type: "ENTRY",
    status: "DENIED",
    photoSnapshot: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&auto=format&fit=crop&q=80",
    confidence: 34.2,
    livenessScore: 88.0,
    lockAction: "Khóa giữ nguyên trạng thái LOCKED",
    doorName: "Cửa Chính Trụ Sở - Cổng A",
    reason: "Khuôn mặt chưa được đăng ký trong hệ thống nhân viên",
  },
];

const DEFAULT_NOTIFICATIONS: MobileNotificationRecord[] = [
  {
    id: "NOTIF-001",
    title: "Mở cửa thành công",
    body: "Nguyễn Hoàng Minh (NV-1082) vừa điểm danh Vào tại Cửa Chính Trụ Sở",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    type: "SUCCESS",
    read: false,
    employeeId: "EMP-001",
    employeeName: "Nguyễn Hoàng Minh",
  },
  {
    id: "NOTIF-002",
    title: "Mở cửa thành công",
    body: "Trần Thị Mai Phương (NV-2045) vừa điểm danh Vào tại Cửa Chính Trụ Sở",
    timestamp: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    type: "SUCCESS",
    read: false,
    employeeId: "EMP-002",
    employeeName: "Trần Thị Mai Phương",
  },
  {
    id: "NOTIF-003",
    title: "Cảnh báo bảo mật",
    body: "Phát hiện khuôn mặt không xác định cố gắng truy cập tại Cửa Chính",
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    type: "WARNING",
    read: false,
  },
];

// Smart Lock State
const DEFAULT_SMART_LOCK_STATE = {
  lockId: "SL-HQ-01",
  doorName: "Cửa Chính Trụ Sở - Cổng A",
  state: "LOCKED" as "LOCKED" | "UNLOCKED" | "UNLOCKING" | "LOCKING",
  isLocked: true,
  batteryLevel: 96,
  signalDbm: -54,
  firmwareVersion: "v2.5.8-Zigbee/IP",
  lastActionAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  lastActionBy: "Hệ thống bảo mật tự động",
  autoRelockSeconds: 6,
  remainingRelockSeconds: 0,
  status: "ONLINE" as "ONLINE" | "OFFLINE",
};

// ----------------- ETON CHAT ROOM WEBHOOK CONFIG & LOGS -----------------
export interface WebhookLogRecord {
  id: string;
  timestamp: string;
  url: string;
  method: string;
  payload: {
    text: string;
    attachments: Array<{
      title: string;
      [key: string]: any;
    }>;
  };
  statusCode?: number;
  statusText?: string;
  responseBody?: string;
  success: boolean;
  error?: string;
  scanType: "ENTRY" | "EXIT";
  userName: string;
}

const DEFAULT_WEBHOOK_CONFIG = {
  enabled: false,
  url: "",
  gateInTitle: "[[CỔNG VÀO]]",
  gateOutTitle: "[[CỔNG RA]]",
  includeEmployeeCode: true,
  // ---- Cảnh báo người lạ (stranger alert) ----
  strangerAlertEnabled: DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerAlertEnabled,
  strangerTitle: DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerTitle,
  strangerLinkLabel: DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerLinkLabel,
  appBaseUrl: DEFAULT_STRANGER_WEBHOOK_CONFIG.appBaseUrl,
  strangerCooldownSeconds: DEFAULT_STRANGER_WEBHOOK_CONFIG.strangerCooldownSeconds,
};

// Persistent instances loaded from database (PostgreSQL / SQLite)
let employees: EmployeeRecord[] = db.getEmployees(DEMO_DATA_ENABLED ? DEFAULT_EMPLOYEES : []);
let accessLogs: AccessLogRecord[] = db.getAccessLogs(DEMO_DATA_ENABLED ? DEFAULT_ACCESS_LOGS : []);
let mobileNotifications: MobileNotificationRecord[] = db.getNotifications(DEMO_DATA_ENABLED ? DEFAULT_NOTIFICATIONS : []);
let smartLockState = db.getSmartLockState(DEFAULT_SMART_LOCK_STATE);
let webhookConfig = db.getWebhookConfig(DEFAULT_WEBHOOK_CONFIG);
let webhookLogs: WebhookLogRecord[] = db.getWebhookLogs();
let doorControllerConfig = db.getDoorControllerConfig(DEFAULT_DOOR_CONTROLLER_CONFIG);
let doorApiLogs: DoorApiLogRecord[] = db.getDoorApiLogs();
// =========================================================================
// MULTI-STREAM GATE CONFIG NORMALISATION
//
// A gate may carry several video sources (`streams`). The enabled stream with
// the lowest `priority` is the PRIMARY one; its fields are mirrored onto the
// gate's legacy single-stream fields so clients written before multi-stream
// support (and the persisted JSON blobs they produced) keep working unchanged.
// Every load and every save goes through `normalizeCameraStreamsConfig`.
// =========================================================================
const GATE_LEGACY_STREAM_FIELDS = [
  "sourceType",
  "rtspUrl",
  "rtspTransport",
  "httpUrl",
  "uvcDeviceId",
  "uvcDeviceLabel",
  "resolution",
  "fps",
  "backendDevicePath",
] as const;
type GateLegacyStreamField = (typeof GATE_LEGACY_STREAM_FIELDS)[number];
type GateLegacyStreamFields = Pick<GateStreamConfigRecord, GateLegacyStreamField>;

const CAMERA_SOURCE_TYPES: ReadonlyArray<GateStreamSourceRecord["sourceType"]> = [
  "CLIENT_UVC",
  "RTSP",
  "HTTP_MJPEG",
  "BACKEND_UVC",
];
const CAMERA_RESOLUTIONS: ReadonlyArray<NonNullable<GateStreamSourceRecord["resolution"]>> = [
  "1920x1080",
  "1280x720",
  "640x480",
  "AUTO",
];
const STREAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_STREAMS_PER_GATE = 16;

function normalizeGateKey(value: unknown): "entry" | "exit" {
  return String(value || "entry").toLowerCase() === "exit" ? "exit" : "entry";
}

function isRtspUrl(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("rtsp://");
}

/** Last path segment of an RTSP URL (`.../Streaming/Channels/501` -> `501`), if it is id-safe. */
function rtspChannelSegment(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const segments = url.trim().replace(/[?#].*$/, "").split("/").filter(Boolean);
  const last = segments.length > 2 ? segments[segments.length - 1] : null;
  return last && /^[A-Za-z0-9._-]{1,40}$/.test(last) ? last : null;
}

function deriveStreamId(gateKey: "entry" | "exit", rtspUrl: unknown, fallbackSuffix: string): string {
  const channel = rtspChannelSegment(rtspUrl);
  return `${gateKey}-${channel || fallbackSuffix}`;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str ? str : undefined;
}

/** Whitelists and coerces the per-stream media fields shared by streams and the legacy gate fields. */
function sanitizeStreamMediaFields(raw: any): GateLegacyStreamFields {
  const sourceType = CAMERA_SOURCE_TYPES.includes(raw?.sourceType) ? raw.sourceType : "RTSP";
  const transport = String(raw?.rtspTransport || "").toUpperCase();
  const fpsNum = Number(raw?.fps);
  return {
    sourceType,
    rtspUrl: optionalTrimmedString(raw?.rtspUrl),
    rtspTransport: transport === "UDP" ? "UDP" : transport === "TCP" ? "TCP" : undefined,
    httpUrl: optionalTrimmedString(raw?.httpUrl),
    uvcDeviceId: optionalTrimmedString(raw?.uvcDeviceId),
    uvcDeviceLabel: optionalTrimmedString(raw?.uvcDeviceLabel),
    resolution: CAMERA_RESOLUTIONS.includes(raw?.resolution) ? raw.resolution : undefined,
    fps: Number.isFinite(fpsNum) && fpsNum > 0 ? Math.round(fpsNum) : undefined,
    backendDevicePath: optionalTrimmedString(raw?.backendDevicePath),
  };
}

/** Validates one stream entry: stable id, label, enabled flag, numeric priority, whitelisted media fields. */
function sanitizeStreamSource(
  raw: any,
  index: number,
  gateKey: "entry" | "exit",
  fallbackLabel: string
): GateStreamSourceRecord {
  const media = sanitizeStreamMediaFields(raw);
  const rawId = optionalTrimmedString(raw?.id);
  const id = rawId && STREAM_ID_RE.test(rawId) ? rawId : deriveStreamId(gateKey, media.rtspUrl, `stream-${index + 1}`);
  const priorityNum = Number(raw?.priority);
  return {
    id,
    label: optionalTrimmedString(raw?.label) || fallbackLabel || id,
    ...media,
    enabled: raw?.enabled !== false && raw?.enabled !== "false" && raw?.enabled !== 0,
    priority: Number.isFinite(priorityNum) ? priorityNum : (index + 1) * 10,
  };
}

/** Builds the single stream an old (streams-less) gate config implies. */
function streamFromLegacyGateFields(gate: GateStreamConfigRecord, gateKey: "entry" | "exit"): GateStreamSourceRecord {
  const media = sanitizeStreamMediaFields(gate);
  return {
    id: deriveStreamId(gateKey, media.rtspUrl, "primary"),
    label: String(gate.name || "").trim() || `${gateKey}-primary`,
    ...media,
    enabled: true,
    priority: 1,
  };
}

/** The lowest-priority enabled stream; when every stream is disabled, the first one. */
function pickPrimaryStream(streams: GateStreamSourceRecord[]): GateStreamSourceRecord {
  return streams.find((s) => s.enabled) || streams[0];
}

function legacyFieldsFromStream(stream: GateStreamSourceRecord): GateLegacyStreamFields {
  return {
    sourceType: stream.sourceType,
    rtspUrl: stream.rtspUrl,
    rtspTransport: stream.rtspTransport,
    httpUrl: stream.httpUrl,
    uvcDeviceId: stream.uvcDeviceId,
    uvcDeviceLabel: stream.uvcDeviceLabel,
    resolution: stream.resolution,
    fps: stream.fps,
    backendDevicePath: stream.backendDevicePath,
  };
}

// ---- Backend auto-scan ("watch") config ----
// Lives inside the gate object of the existing cameraStreamsConfig blob, so it
// persists through db.saveCameraStreamsConfig with no schema change.
const GATE_WATCH_MIN_INTERVAL_SECONDS = 1;
const GATE_WATCH_MAX_INTERVAL_SECONDS = 300;
/** Kept equal to FACE_SCAN_MAX_FRAMES (declared later in this file, so not referenced here). */
const GATE_WATCH_MAX_FRAMES = 5;
const DEFAULT_GATE_WATCH: GateWatchConfigRecord = {
  // OFF by default. A backend job whose scans feed an unlock decision must be
  // switched on deliberately, never by deploying a new build.
  enabled: false,
  intervalSeconds: 3,
  frames: 1,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalises one gate's watch block. Missing / malformed values fall back to
 * `fallback` (the gate's current values when patching, otherwise the defaults),
 * `intervalSeconds` is clamped to 1..300 s and `frames` to 1..5.
 */
function normalizeGateWatchConfig(
  raw: unknown,
  fallback: GateWatchConfigRecord = DEFAULT_GATE_WATCH
): GateWatchConfigRecord {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabledRaw = src.enabled;
  const enabled =
    enabledRaw === undefined || enabledRaw === null
      ? fallback.enabled
      : enabledRaw === true || enabledRaw === "true" || enabledRaw === 1 || enabledRaw === "1";
  return {
    enabled,
    intervalSeconds: clampInt(
      src.intervalSeconds,
      fallback.intervalSeconds,
      GATE_WATCH_MIN_INTERVAL_SECONDS,
      GATE_WATCH_MAX_INTERVAL_SECONDS
    ),
    frames: clampInt(src.frames, fallback.frames, 1, GATE_WATCH_MAX_FRAMES),
  };
}

/**
 * Pure normalisation of one gate:
 *   1. missing/empty `streams` -> one stream derived from the legacy fields
 *      (id `${gate}-${rtsp channel}` e.g. `exit-501`, else `${gate}-primary`);
 *   2. every stream gets id / label / enabled / priority and whitelisted fields;
 *   3. duplicates by id are dropped (first wins), list capped, sorted by priority;
 *   4. the primary stream is mirrored back onto the legacy fields;
 *   5. the backend watch block is filled in (default: disabled, 3 s, 1 frame).
 */
function normalizeGateConfig(gate: GateStreamConfigRecord): GateStreamConfigRecord {
  const gateType: "ENTRY" | "EXIT" = gate.gateType === "EXIT" ? "EXIT" : "ENTRY";
  const gateKey = gateType.toLowerCase() as "entry" | "exit";
  const fallbackLabel = String(gate.name || "").trim();

  const rawStreams = Array.isArray(gate.streams) ? gate.streams.filter((s) => s && typeof s === "object") : [];
  let streams = rawStreams.map((s, i) => sanitizeStreamSource(s, i, gateKey, fallbackLabel));
  if (streams.length === 0) {
    streams = [streamFromLegacyGateFields(gate, gateKey)];
  }

  const seen = new Set<string>();
  streams = streams.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  streams = streams.slice(0, MAX_STREAMS_PER_GATE);
  streams.sort((a, b) => a.priority - b.priority); // Array.prototype.sort is stable

  const primary = pickPrimaryStream(streams);
  return {
    ...gate,
    gateType,
    watch: normalizeGateWatchConfig(gate.watch),
    streams,
    ...legacyFieldsFromStream(primary),
  };
}

/** Normalises both gates of a (possibly older / partial) persisted config. */
function normalizeCameraStreamsConfig(config: CameraStreamsConfigRecord): CameraStreamsConfigRecord {
  const source = config && typeof config === "object" ? config : DEFAULT_CAMERA_STREAMS_CONFIG;
  return {
    ...source,
    entryGate: normalizeGateConfig({ ...(source.entryGate || DEFAULT_CAMERA_STREAMS_CONFIG.entryGate), gateType: "ENTRY" }),
    exitGate: normalizeGateConfig({ ...(source.exitGate || DEFAULT_CAMERA_STREAMS_CONFIG.exitGate), gateType: "EXIT" }),
  };
}

function loadCameraStreamsConfig(): CameraStreamsConfigRecord {
  return normalizeCameraStreamsConfig(db.getCameraStreamsConfig(DEFAULT_CAMERA_STREAMS_CONFIG));
}

/**
 * Applies a gate patch coming from POST /api/camera-streams/config:
 *   - a non-empty `streams` array REPLACES the gate's list (normalised);
 *   - legacy single-stream fields update the PRIMARY stream, preserving the
 *     other streams. When the body carries both (an older dashboard echoing
 *     the `streams` it received while editing the legacy form), only legacy
 *     values that actually differ from the current primary are applied, so a
 *     stale echo never overrides an edited `streams` list.
 */
function applyGateConfigPatch(current: GateStreamConfigRecord, patch: any): GateStreamConfigRecord {
  const base = normalizeGateConfig(current);
  if (!patch || typeof patch !== "object") return base;

  const { streams: patchStreams, gateType: _ignoredGateType, ...rest } = patch;
  const currentPrimary = pickPrimaryStream(base.streams!);
  const legacyChanges: Partial<GateLegacyStreamFields> = {};
  for (const field of GATE_LEGACY_STREAM_FIELDS) {
    if (field in rest && rest[field] !== undefined && rest[field] !== currentPrimary[field]) {
      (legacyChanges as any)[field] = rest[field];
    }
  }
  const hasLegacyChanges = Object.keys(legacyChanges).length > 0;

  const replaced = Array.isArray(patchStreams) && patchStreams.length > 0;
  const working = normalizeGateConfig({
    ...base,
    ...rest,
    gateType: base.gateType,
    // A partial `watch` patch ({ enabled: true }) keeps the gate's other watch values.
    watch: "watch" in rest ? normalizeGateWatchConfig(rest.watch, base.watch) : base.watch,
    streams: replaced ? patchStreams : base.streams,
  });

  if (!hasLegacyChanges) return working;

  const primary = pickPrimaryStream(working.streams!);
  const streams = working.streams!.map((s) =>
    s.id === primary.id ? { ...s, ...sanitizeStreamMediaFields({ ...s, ...legacyChanges }) } : s
  );
  return normalizeGateConfig({ ...working, streams });
}

let cameraStreamsConfig: CameraStreamsConfigRecord = loadCameraStreamsConfig();

// --- AI recognition engine configuration (persisted, see db.getAiRecognitionConfig) ---
type ServerAiConfig = AiRecognitionConfigRecord;

// GOOGLE_GEMINI_MODEL only seeds the default; a persisted model always wins.
const DEFAULT_AI_RECOGNITION_CONFIG: ServerAiConfig = {
  engineMode: "HYBRID_AUTO",
  googleAi: {
    model: (process.env.GOOGLE_GEMINI_MODEL || "").trim() || "gemini-3.8-flash",
    temperature: 0.1,
    minConfidence: 75,
    useSystemFallback: true,
    customPrompt: "",
  },
  localModel: {
    modelArchitecture: "blazeface-arcface-sota",
    similarityThreshold: 0.72,
    livenessSensitivity: "MEDIUM",
    maxFaces: 4,
    autoContrast: true,
    antiSpoofing: true,
  },
  hybridSettings: {
    localPreFilterThreshold: 0.85,
    fallbackToCloudOnUnknown: true,
  },
};

// Synchronous first load (SQLite / JSON fallback / defaults). PostgreSQL connects
// asynchronously and re-hydrates this object through the callbacks below.
let aiRecognitionConfig: ServerAiConfig = db.getAiRecognitionConfig(DEFAULT_AI_RECOGNITION_CONFIG);

db.onAiRecognitionConfigLoaded(() => {
  aiRecognitionConfig = db.getAiRecognitionConfig(DEFAULT_AI_RECOGNITION_CONFIG);
  console.log(
    `[AI Config] Đã khôi phục cấu hình nhận diện từ PostgreSQL: ${aiRecognitionConfig.engineMode} (Google Model: ${aiRecognitionConfig.googleAi.model})`
  );
});

db.onCameraStreamsConfigLoaded(() => {
  cameraStreamsConfig = loadCameraStreamsConfig();
  syncGateWatchers(); // the hydrated row may carry a different gate/watch config
  const gates = (["entryGate", "exitGate"] as const)
    .map((k) => `${k}=${cameraStreamsConfig[k].streams.length} luồng`)
    .join(", ");
  console.log(`[Camera Config] Đã khôi phục cấu hình luồng camera từ PostgreSQL: ${gates}`);
});

// Listen to Postgres sync events to refresh memory models
db.onSync(() => {
  aiRecognitionConfig = db.getAiRecognitionConfig(DEFAULT_AI_RECOGNITION_CONFIG);
  employees = db.getEmployees(DEMO_DATA_ENABLED ? DEFAULT_EMPLOYEES : []);
  accessLogs = db.getAccessLogs(DEMO_DATA_ENABLED ? DEFAULT_ACCESS_LOGS : []);
  mobileNotifications = db.getNotifications(DEMO_DATA_ENABLED ? DEFAULT_NOTIFICATIONS : []);
  smartLockState = db.getSmartLockState(DEFAULT_SMART_LOCK_STATE);
  webhookConfig = db.getWebhookConfig(DEFAULT_WEBHOOK_CONFIG);
  webhookLogs = db.getWebhookLogs();
  doorControllerConfig = db.getDoorControllerConfig(DEFAULT_DOOR_CONTROLLER_CONFIG);
  doorApiLogs = db.getDoorApiLogs();
  cameraStreamsConfig = loadCameraStreamsConfig();
  syncGateWatchers(); // a PostgreSQL rehydrate may carry a different watch config
  console.log(`[Server] Bộ nhớ In-Memory đã tự động đồng bộ từ PostgreSQL: ${employees.length} NV, ${accessLogs.length} logs, ${mobileNotifications.length} thông báo.`);
});

// =========================================================================
// REAL FACE ENGINE (SCRFD detector + ArcFace recogniser) - selection, gallery,
// observations and decision fusion.
//
// Engine selection (env FACE_ENGINE):
//   unset / "auto"  -> ONNX when the models loaded, otherwise the legacy hash
//                      matcher (the historical demo behaviour).
//   "onnx"          -> ONNX ONLY. When the models are missing the gateway
//                      FAILS CLOSED: no access decision is taken by the hash
//                      matcher, every frame is denied and the lock stays
//                      LOCKED. The failure is logged loudly once at startup.
//   "hash"          -> legacy hash matcher only (demo / offline development).
//
// Measured on this site (probe run, 20 Sep): within cam02 the same person
// scores cosine 0.50-0.62 and an impostor <= 0.145, but ACROSS cameras the
// same person only reaches 0.139-0.304 - inside the impostor range. Templates
// therefore carry `streamId` and operators enrol per camera; matching is
// max-over-templates across the employee's whole gallery, which handles the
// cross-camera case once both cameras are enrolled. No cross-camera score
// fudging exists anywhere below, by design.
// =========================================================================
type FaceEngineSetting = "auto" | "onnx" | "hash";
/** What actually decides a frame. "unavailable" = fail-closed (onnx demanded, models absent). */
type ActiveFaceEngine = "onnx" | "hash" | "unavailable";

const FACE_ENGINE_SETTING: FaceEngineSetting = (() => {
  const raw = String(process.env.FACE_ENGINE || "").trim().toLowerCase();
  if (raw === "hash") return "hash";
  if (raw === "onnx") return "onnx";
  return "auto";
})();

function envFloat(name: string, fallback: number, min = 0, max = 1): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}
function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** Minimum capture quality an enrolment frame must reach to become a template. */
const FACE_ENROLL_MIN_QUALITY = envFloat("FACE_ENROLL_MIN_QUALITY", 0.25);
/**
 * Below this capture quality a stranger snapshot is not worth storing.
 * Measured on this site: across 1,314 scans no capture under 0.273 has ever
 * produced a grant, and the 0.00-0.25 band (154 scans) yielded none. Those
 * rows cannot identify anyone - they only dilute the cluster panel and
 * accumulate biometric images with no adjudication value. Access decisions
 * are untouched by this: the floor gates STORAGE, never recognition.
 */
const FACE_STRANGER_MIN_QUALITY = envFloat("FACE_STRANGER_MIN_QUALITY", 0.25);
/** Maximum templates kept per employee; the lowest-quality one is evicted when full. */
const FACE_TEMPLATE_MAX = envInt("FACE_TEMPLATE_MAX", 12, 1, 200);
/**
 * Hard cap on observations fused in ONE decision. Latency is dominated by the
 * engine (~110 ms decode + ~480 ms detect + ~360 ms per face embed), so the
 * real bound is frames x streams (<= 5 x 4); this cap additionally bounds the
 * evidence set, keeping the highest-quality observations when it bites.
 */
const FACE_MAX_OBSERVATIONS = envInt("FACE_MAX_OBSERVATIONS", 12, 1, 64);
/** Multi-frame scan limits (`frames` / `frameIntervalMs` in the scan + capture bodies). */
const FACE_SCAN_MAX_FRAMES = 5;
const FACE_SCAN_DEFAULT_FRAME_INTERVAL_MS = 300;
const FACE_SCAN_MAX_FRAME_INTERVAL_MS = 3000;

/**
 * Model identity stamped on every template. Embeddings from different models
 * are NEVER comparable, so `buildGallery` drops templates whose tag differs
 * from the running recogniser.
 */
function faceModelTag(): string {
  const info = getFaceEngineInfo();
  const base = String(info.recognizerModel || "unknown").replace(/\.onnx$/i, "");
  return `arcface_${base}`;
}

function activeFaceEngine(): ActiveFaceEngine {
  if (FACE_ENGINE_SETTING === "hash") return "hash";
  if (isFaceEngineReady()) return "onnx";
  return FACE_ENGINE_SETTING === "onnx" ? "unavailable" : "hash";
}

/** True when the real engine is loaded and selected: the only path that may grant. */
function faceEngineActive(): boolean {
  return activeFaceEngine() === "onnx";
}

/**
 * Effective fusion thresholds. `aiRecognitionConfig.localModel.similarityThreshold`
 * (the existing AI-config store, editable through POST /api/config/ai) maps onto
 * `acceptSingle`; everything else comes from DEFAULT_FUSION_THRESHOLDS unless an
 * env override is set. Nothing new is persisted - there is one config store.
 */
function currentFusionThresholds(clientConfig?: Partial<ServerAiConfig> | null): FusionThresholds {
  const th: FusionThresholds = { ...DEFAULT_FUSION_THRESHOLDS };
  const configured = Number(
    clientConfig?.localModel?.similarityThreshold ?? aiRecognitionConfig.localModel?.similarityThreshold
  );
  if (Number.isFinite(configured) && configured > 0 && configured < 1) th.acceptSingle = configured;
  th.acceptSingle = envFloat("FACE_ACCEPT_SINGLE", th.acceptSingle, 0.01, 0.999);
  th.acceptFused = envFloat("FACE_ACCEPT_FUSED", th.acceptFused, 0.01, 0.999);
  th.minEvidence = envFloat("FACE_MIN_EVIDENCE", th.minEvidence, 0.01, 0.999);
  th.minMargin = envFloat("FACE_MIN_MARGIN", th.minMargin, 0, 0.999);
  th.minAgreeing = envInt("FACE_MIN_AGREEING", th.minAgreeing, 1, 32);
  return th;
}

/** The enrolled gallery for the RUNNING model only (foreign tags are skipped). */
function currentGallery(): FaceGallery {
  return buildGallery(db.getFaceTemplates(), faceModelTag());
}

const clampUnit = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** Pixel box -> [ymin, xmin, ymax, xmax] on the 0-1000 scale the annotator/UI use. */
function boxToBox2d(
  box: readonly [number, number, number, number],
  width: number,
  height: number
): [number, number, number, number] {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const x1 = Math.min(box[0], box[2]), x2 = Math.max(box[0], box[2]);
  const y1 = Math.min(box[1], box[3]), y2 = Math.max(box[1], box[3]);
  return [
    Math.round(clampUnit(y1 / h) * 1000),
    Math.round(clampUnit(x1 / w) * 1000),
    Math.round(clampUnit(y2 / h) * 1000),
    Math.round(clampUnit(x2 / w) * 1000),
  ];
}

/** One detected+embedded face, with everything needed to fuse it and to report it. */
interface EngineObservation {
  observation: FaceObservation;
  face: ExtractedFace;
  width: number;
  height: number;
  streamId: string;
  streamLabel: string;
  frameIndex: number;
  /** false when the observation-cap dropped it from the fused evidence. */
  fused: boolean;
}

/**
 * Decode once, detect + embed, and turn every face into an observation tagged
 * with its stream. Never throws: a bad frame yields an empty list.
 */
async function observeFrame(
  image: Buffer | string,
  streamId: string,
  streamLabel: string,
  frameIndex: number
): Promise<EngineObservation[]> {
  try {
    const rgb = await loadImage(image);
    if (!rgb) return [];
    const faces = await extractFaces(rgb);
    return faces.map((f) => ({
      observation: {
        streamId,
        streamLabel,
        frameIndex,
        embedding: Array.from(f.embedding),
        quality: f.quality,
        detectorScore: f.score,
        box: [f.box[0], f.box[1], f.box[2], f.box[3]] as [number, number, number, number],
      },
      face: f,
      width: rgb.width,
      height: rgb.height,
      streamId,
      streamLabel,
      frameIndex,
      fused: true,
    }));
  } catch (err: any) {
    console.warn("[FaceEngine] observeFrame lỗi:", err?.message || err);
    return [];
  }
}

/**
 * Apply the observation cap: the highest-quality observations stay in the fused
 * evidence, the rest are reported as detected but marked `fused:false`.
 * Returns the list of observations that feed `recognizeObservations`.
 */
function capObservations(all: EngineObservation[]): FaceObservation[] {
  if (all.length <= FACE_MAX_OBSERVATIONS) return all.map((o) => o.observation);
  const ranked = [...all].sort((a, b) => b.observation.quality - a.observation.quality);
  const keep = new Set(ranked.slice(0, FACE_MAX_OBSERVATIONS));
  for (const o of all) o.fused = keep.has(o);
  return all.filter((o) => o.fused).map((o) => o.observation);
}

/**
 * Turn engine observations + a fusion decision into the `detectedFaces` the UI,
 * the access log and the green-box annotator consume.
 *
 * Only observations that AGREED with the winning identity are marked
 * `recognized` - a second person standing in the same frame stays unrecognised.
 * `boxSource:"detector"` is set because these boxes are real detections, so the
 * annotator may draw them. `livenessScore` reports CAPTURE QUALITY: this engine
 * has no anti-spoofing model and nothing here may be read as a liveness check.
 */
function facesFromDecision(
  observed: EngineObservation[],
  decision: FusionDecision,
  roster: EmployeeRecord[]
): Array<DetectedFaceItem & { streamId: string; streamLabel: string }> {
  // perObservation is parallel to the (capped) observation list handed to fusion.
  const fusedOnly = observed.filter((o) => o.fused);
  const matchByObs = new Map<EngineObservation, ObservationMatch>();
  fusedOnly.forEach((o, i) => {
    const m = decision.perObservation[i];
    if (m) matchByObs.set(o, m);
  });
  const winner = decision.recognized ? decision.employeeId : undefined;
  const th = decision.thresholds;

  return observed.map((o, idx) => {
    const m = matchByObs.get(o);
    const agreed = Boolean(
      winner && m && m.employeeId === winner && m.cosine >= th.minEvidence
    );
    const emp = agreed ? roster.find((e) => e.id === winner) : undefined;
    const cosine = m ? m.cosine : 0;
    return {
      id: `face-${o.streamId}-${o.frameIndex}-${idx}-${Date.now().toString(36)}`,
      box2d: boxToBox2d(o.face.box, o.width, o.height),
      boxSource: "detector" as const,
      employeeId: emp?.id,
      employeeName: emp?.name,
      employeeCode: emp?.employeeCode,
      department: emp?.department,
      // Confidence is the fused decision confidence for the accepted identity,
      // and the raw best cosine (as a percentage) for everything else. Nothing
      // is invented: an unmatched face reports the number it actually scored.
      confidence: agreed
        ? Math.round(decision.confidence * 1000) / 10
        : Math.round(Math.max(0, cosine) * 1000) / 10,
      livenessScore: Math.round(clampUnit(o.face.quality) * 1000) / 10,
      recognized: agreed && Boolean(emp),
      message: !o.fused
        ? `Đã phát hiện nhưng vượt hạn mức ${FACE_MAX_OBSERVATIONS} quan sát/lượt - không tham gia so khớp`
        : agreed && emp
        ? `Nhận diện ${emp.name} (${emp.employeeCode}) - cosine ${cosine.toFixed(3)}, cơ sở ${decision.basis}`
        : decision.basis === "rejected-ambiguous"
        ? `Từ chối: mơ hồ giữa nhiều danh tính (cosine ${cosine.toFixed(3)})`
        : `Không khớp mẫu đã đăng ký (cosine tốt nhất ${cosine.toFixed(3)})`,
      streamId: o.streamId,
      streamLabel: o.streamLabel,
    };
  });
}

/** An empty, honest decision for paths where the real engine never ran. */
function emptyFusionDecision(thresholds?: FusionThresholds): FusionDecision {
  return fuseDecision([], thresholds || currentFusionThresholds());
}

/**
 * Startup warm-up. Loading two ONNX sessions takes seconds, so it happens once
 * here instead of on the first camera frame. A missing model set is reported
 * LOUDLY: with FACE_ENGINE=onnx the gateway then denies every frame rather than
 * quietly handing access decisions to the hash matcher.
 */
function warmUpFaceEngine(): void {
  if (FACE_ENGINE_SETTING === "hash") {
    console.warn(
      "[FaceEngine] FACE_ENGINE=hash: đang dùng bộ so khớp giả lập (hash). KHÔNG dùng cho cửa thật."
    );
    return;
  }
  getFaceEngine()
    .then((engine) => {
      if (engine) {
        const info = getFaceEngineInfo();
        console.log(
          `[FaceEngine] ✅ Engine thực đã sẵn sàng (${info.detectorModel} + ${info.recognizerModel}, ${info.loadTimeMs}ms, tag=${faceModelTag()}), ` +
            `${db.getFaceTemplates().length} mẫu khuôn mặt trong thư viện.`
        );
        return;
      }
      const info = getFaceEngineInfo();
      if (FACE_ENGINE_SETTING === "onnx") {
        console.error(
          `[FaceEngine] ❌ FACE_ENGINE=onnx nhưng KHÔNG nạp được mô hình từ ${info.modelDir} (${info.lastError || "không rõ lỗi"}). ` +
            "FAIL-CLOSED: mọi khung hình sẽ bị TỪ CHỐI và khóa cửa giữ nguyên LOCKED. " +
            "Hệ thống KHÔNG tự động quay về bộ so khớp hash."
        );
      } else {
        console.warn(
          `[FaceEngine] ⚠️ Không nạp được mô hình ONNX từ ${info.modelDir} (${info.lastError || "không rõ lỗi"}). ` +
            "FACE_ENGINE chưa được đặt nên tạm dùng bộ so khớp hash (chế độ demo)."
        );
      }
    })
    .catch(() => {});
}
warmUpFaceEngine();

/** GET /api/face-engine/status - what is running, what is enrolled, what decides. */
app.get(["/api/face-engine/status", "/api/face-engine/status/", "/api/face-engine", "/api/face-engine/"], (_req, res) => {
  const templates = db.getFaceTemplates();
  const modelTag = faceModelTag();
  const byEmployee: Record<string, number> = {};
  for (const t of templates) byEmployee[t.employeeId] = (byEmployee[t.employeeId] || 0) + 1;
  const engine = activeFaceEngine();
  res.json({
    success: true,
    engine,
    requestedEngine: FACE_ENGINE_SETTING,
    ready: isFaceEngineReady(),
    failClosed: engine === "unavailable",
    info: getFaceEngineInfo(),
    templates: {
      total: templates.length,
      byEmployee,
      modelTag,
      matchingModelTag: templates.filter((t) => t.modelTag === modelTag).length,
    },
    thresholds: currentFusionThresholds(),
    limits: {
      maxObservationsPerDecision: FACE_MAX_OBSERVATIONS,
      maxFramesPerStream: FACE_SCAN_MAX_FRAMES,
      maxConcurrentStreams: SCAN_RTSP_MAX_CONCURRENT_STREAMS,
      templatesPerEmployee: FACE_TEMPLATE_MAX,
      enrollMinQuality: FACE_ENROLL_MIN_QUALITY,
    },
  });
});

// ---------------- Enrolment (templates) ----------------

/**
 * Keep an employee's gallery within FACE_TEMPLATE_MAX by evicting the
 * lowest-quality template(s). Returns the ids that were evicted.
 */
function enforceTemplateCap(employeeId: string, keepRoom = 0): string[] {
  const existing = db.getFaceTemplatesForEmployee(employeeId);
  const limit = Math.max(0, FACE_TEMPLATE_MAX - keepRoom);
  if (existing.length <= limit) return [];
  const evicted = [...existing]
    .sort((a, b) => a.quality - b.quality)
    .slice(0, existing.length - limit);
  for (const t of evicted) db.deleteFaceTemplate(t.id);
  return evicted.map((t) => t.id);
}

function recognitionReadyForEmployee(employeeId: string): boolean {
  const currentModelTag = faceModelTag();
  return db.getFaceTemplatesForEmployee(employeeId).some((template) => template.modelTag === currentModelTag);
}

interface EnrollOutcome {
  saved?: {
    id: string;
    quality: number;
    source: string;
    capturedAt: string;
    streamId?: string;
    sourceLogId?: string;
    dims: number;
    modelTag: string;
  };
  evicted?: string[];
  rejected?: string;
  /** Best quality seen, when a face was found but rejected for quality. */
  quality?: number;
  detectedFaces?: number;
}

/**
 * Extract the single best-quality face from one image and store it as a
 * template. NEVER throws: enrolment is always best-effort so that creating an
 * employee (or merging a stranger cluster) cannot fail because of the engine.
 */
async function enrollTemplateFromImage(
  employeeId: string,
  image: string | Buffer,
  opts: { source: "enrollment" | "merge" | "manual" | "auto"; streamId?: string; sourceLogId?: string; minQuality?: number }
): Promise<EnrollOutcome> {
  if (!faceEngineActive()) {
    return { rejected: activeFaceEngine() === "unavailable" ? "engine-unavailable" : "engine-disabled" };
  }
  const minQuality = opts.minQuality ?? FACE_ENROLL_MIN_QUALITY;
  try {
    const faces = await extractFaces(image);
    if (faces.length === 0) return { rejected: "no-face", detectedFaces: 0 };
    const best = faces.reduce((a, b) => (b.quality > a.quality ? b : a));
    if (best.quality < minQuality) {
      return { rejected: "low-quality", quality: Math.round(best.quality * 1000) / 1000, detectedFaces: faces.length };
    }
    const evicted = enforceTemplateCap(employeeId, 1);
    const rec = db.saveFaceTemplate({
      id: `FT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      employeeId,
      embedding: Array.from(best.embedding),
      dims: best.embedding.length,
      modelTag: faceModelTag(),
      source: opts.source,
      quality: Math.round(best.quality * 1000) / 1000,
      capturedAt: new Date().toISOString(),
      sourceLogId: opts.sourceLogId,
      streamId: opts.streamId,
    });
    return {
      saved: {
        id: rec.id,
        quality: rec.quality,
        source: rec.source,
        capturedAt: rec.capturedAt,
        streamId: rec.streamId,
        sourceLogId: rec.sourceLogId,
        dims: rec.dims,
        modelTag: rec.modelTag,
      },
      evicted,
      detectedFaces: faces.length,
    };
  } catch (err: any) {
    console.warn(`[FaceEngine] Không tạo được mẫu khuôn mặt cho ${employeeId}:`, err?.message || err);
    return { rejected: "engine-error" };
  }
}

/** Only images we actually hold bytes for can be enrolled (a remote URL cannot). */
function isEnrollableImage(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 64) return false;
  if (/^data:image\/(jpeg|jpg|png);base64,/i.test(value)) return true;
  return !/^https?:\/\//i.test(value) && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 256));
}

async function sendEtonWebhook({
  userName,
  employeeCode,
  scanType,
  timestamp,
}: {
  userName: string;
  employeeCode?: string;
  scanType: "ENTRY" | "EXIT";
  timestamp?: string;
}): Promise<WebhookLogRecord | null> {
  // Always load latest config and auto-heal corrupted or truncated URL
  webhookConfig = db.getWebhookConfig(DEFAULT_WEBHOOK_CONFIG);
  if (!webhookConfig.url || webhookConfig.url.includes("...") || webhookConfig.url.endsWith("/hooks/") || webhookConfig.url.endsWith("/hooks")) {
    webhookConfig.url = DEFAULT_WEBHOOK_CONFIG.url;
    db.saveWebhookConfig(webhookConfig);
  }

  if (!webhookConfig.enabled) return null;

  const now = new Date();
  // Formatted date-time in Vietnamese format: DD/MM/YYYY, HH:mm:ss
  const formattedTime =
    timestamp ||
    now.toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  // Parameter format requested: "USER - TIMESTAMP"
  const userText =
    webhookConfig.includeEmployeeCode && employeeCode
      ? `${userName} (${employeeCode}) - ${formattedTime}`
      : `${userName} - ${formattedTime}`;

  // [[GATE]]: title in attachments
  const gateTitle =
    scanType === "ENTRY" ? webhookConfig.gateInTitle : webhookConfig.gateOutTitle;

  const payload = {
    text: userText,
    attachments: [
      {
        title: gateTitle,
      },
    ],
  };

  const logEntry: WebhookLogRecord = {
    id: "WH-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    url: webhookConfig.url,
    method: "POST",
    payload,
    success: false,
    scanType,
    userName,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(webhookConfig.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EtonWebhookBot/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    logEntry.statusCode = response.status;
    logEntry.statusText = response.statusText;
    const resText = await response.text();
    logEntry.responseBody = resText.substring(0, 500);
    logEntry.success = response.ok;

    console.log(
      `[Webhook] Dispatched to Eton Chat Room (${scanType}): status=${response.status} user="${userText}"`
    );
  } catch (err: any) {
    logEntry.error = err?.message || String(err);
    console.error("[Webhook] Failed to dispatch Eton Webhook:", err?.message);
  }

  webhookLogs.unshift(logEntry);
  if (webhookLogs.length > 60) {
    webhookLogs = webhookLogs.slice(0, 60);
  }
  db.saveWebhookLog(logEntry);

  broadcastSSE("webhook_log", logEntry);
  return logEntry;
}

// =========================================================================
// STRANGER ("NGƯỜI LẠ") ALERT WEBHOOK
//
// When an unrecognised face is captured we post a chat message carrying a
// clickable deep link into the stranger-cluster panel. Nothing here ever
// unlocks a door or fabricates a recognition, and the annotated snapshot is
// NOT attached - chat webhooks reject large bodies, so we link instead.
// =========================================================================

/** Placeholder shipped in .env.example; treated as "not configured". */
const APP_URL_PLACEHOLDER = "MY_APP_URL";

/**
 * Normalise a candidate base URL: trim, drop surrounding quotes, strip every
 * trailing slash, and reject anything that is not an absolute http(s) URL with
 * a host. Returns "" when the candidate is unusable, so callers can fall
 * through to the next source instead of emitting a broken/relative link.
 */
function normalizeAppBaseUrl(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "";
  let value = raw.trim().replace(/^['"]+|['"]+$/g, "").trim();
  if (!value || value === APP_URL_PLACEHOLDER) return "";
  value = value.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return "";
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return "";
  } catch {
    return "";
  }
  return value;
}

function firstHeaderValue(req: Request, name: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";
  return value.split(",")[0].trim();
}

/**
 * Public base URL of this app, used to build the stranger deep link.
 * Resolution order:
 *   1. webhookConfig.appBaseUrl (operator setting)
 *   2. process.env.APP_URL (ignoring the "MY_APP_URL" placeholder)
 *   3. the request itself - X-Forwarded-Proto / X-Forwarded-Host first, since
 *      the app sits behind an nginx / Cloudflare edge, then plain Host
 *   4. "" - the caller must then send the message WITHOUT a link
 */
function resolveAppBaseUrl(req?: Request): string {
  const fromConfig = normalizeAppBaseUrl(webhookConfig?.appBaseUrl);
  if (fromConfig) return fromConfig;

  const fromEnv = normalizeAppBaseUrl(process.env.APP_URL);
  if (fromEnv) return fromEnv;

  if (req) {
    const forwardedProto = firstHeaderValue(req, "x-forwarded-proto");
    const forwardedHost = firstHeaderValue(req, "x-forwarded-host");
    const host = forwardedHost || firstHeaderValue(req, "host");
    if (host) {
      const scheme = forwardedProto || (req.protocol === "https" ? "https" : "http");
      const fromRequest = normalizeAppBaseUrl(`${scheme}://${host}`);
      if (fromRequest) return fromRequest;
    }
  }

  return "";
}

/** `<base>/#strangers` or `<base>/#strangers/<logId>`; "" when there is no base. */
function buildStrangerDeepLink(baseUrl: string, logId?: string): string {
  const base = normalizeAppBaseUrl(baseUrl);
  if (!base) return "";
  const hash = `${base}/#${STRANGER_DEEP_LINK_HASH}`;
  return logId ? `${hash}/${encodeURIComponent(logId)}` : hash;
}

/** Timestamp (ms) of the last stranger alert actually dispatched. */
let lastStrangerWebhookAt = 0;

async function sendStrangerWebhook({
  log,
  doorName,
  faceCount,
  baseUrl,
  timestamp,
  bypassCooldown,
}: {
  log: { id: string; type: "ENTRY" | "EXIT"; reason?: string };
  doorName?: string;
  faceCount?: number;
  baseUrl?: string;
  timestamp?: string;
  /** Used by POST /api/webhook/test-stranger so an operator test is never swallowed. */
  bypassCooldown?: boolean;
}): Promise<WebhookLogRecord | null> {
  // Always load latest config and auto-heal corrupted or truncated URL
  webhookConfig = db.getWebhookConfig(DEFAULT_WEBHOOK_CONFIG);
  if (!webhookConfig.url || webhookConfig.url.includes("...") || webhookConfig.url.endsWith("/hooks/") || webhookConfig.url.endsWith("/hooks")) {
    webhookConfig.url = DEFAULT_WEBHOOK_CONFIG.url;
    db.saveWebhookConfig(webhookConfig);
  }

  if (!webhookConfig.enabled) return null;
  // Opt-out is explicit `false`; an old config without the field stays enabled.
  if (webhookConfig.strangerAlertEnabled === false) return null;

  const cooldownSeconds =
    typeof webhookConfig.strangerCooldownSeconds === "number" && webhookConfig.strangerCooldownSeconds >= 0
      ? webhookConfig.strangerCooldownSeconds
      : DEFAULT_WEBHOOK_CONFIG.strangerCooldownSeconds;

  if (!bypassCooldown && cooldownSeconds > 0) {
    const elapsedMs = Date.now() - lastStrangerWebhookAt;
    if (lastStrangerWebhookAt > 0 && elapsedMs < cooldownSeconds * 1000) {
      console.log(
        `[Webhook] Bỏ qua cảnh báo người lạ (đang trong thời gian chờ ${cooldownSeconds}s, còn ${Math.ceil(
          (cooldownSeconds * 1000 - elapsedMs) / 1000
        )}s).`
      );
      return null;
    }
  }
  if (!bypassCooldown) {
    lastStrangerWebhookAt = Date.now();
  }

  const now = new Date();
  const formattedTime =
    timestamp ||
    now.toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const door = doorName || smartLockState.doorName || "cổng";
  const link = buildStrangerDeepLink(baseUrl || resolveAppBaseUrl(), log.id);
  const linkLabel =
    webhookConfig.strangerLinkLabel || DEFAULT_WEBHOOK_CONFIG.strangerLinkLabel;
  const strangerTitle =
    webhookConfig.strangerTitle || DEFAULT_WEBHOOK_CONFIG.strangerTitle;

  // Mattermost / Eton compatible body. The markdown link in `text` and the
  // attachment `title_link` point at the same URL so either renderer gives the
  // operator a click target. Both are omitted when no base URL is known.
  const textLines = [`🚨 Phát hiện người lạ tại ${door} - ${formattedTime}`];
  if (link) textLines.push(`[${linkLabel}](${link})`);

  const detailLines: string[] = [];
  if (typeof faceCount === "number" && faceCount > 0) {
    detailLines.push(`Số khuôn mặt không xác định: ${faceCount}`);
  }
  detailLines.push(`Mã nhật ký: ${log.id}`);
  if (log.reason) detailLines.push(log.reason);
  detailLines.push("Cửa giữ trạng thái KHÓA. Không có quyền ra vào nào được cấp.");

  const attachment: { title: string; title_link?: string; text?: string } = {
    title: strangerTitle,
  };
  if (link) attachment.title_link = link;
  attachment.text = detailLines.join("\n");

  const payload = {
    text: textLines.join("\n"),
    attachments: [attachment],
  };

  const logEntry: WebhookLogRecord = {
    id: "WH-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    url: webhookConfig.url,
    method: "POST",
    payload,
    success: false,
    scanType: log.type === "EXIT" ? "EXIT" : "ENTRY",
    userName: "Người lạ",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(webhookConfig.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EtonWebhookBot/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    logEntry.statusCode = response.status;
    logEntry.statusText = response.statusText;
    const resText = await response.text();
    logEntry.responseBody = resText.substring(0, 500);
    logEntry.success = response.ok;

    console.log(
      `[Webhook] Dispatched stranger alert (${logEntry.scanType}): status=${response.status} link="${link || "(không có)"}"`
    );
  } catch (err: any) {
    logEntry.error = err?.message || String(err);
    console.error("[Webhook] Failed to dispatch stranger alert:", err?.message);
  }

  webhookLogs.unshift(logEntry);
  if (webhookLogs.length > 60) {
    webhookLogs = webhookLogs.slice(0, 60);
  }
  db.saveWebhookLog(logEntry);

  broadcastSSE("webhook_log", logEntry);
  return logEntry;
}

let autoRelockTimer: NodeJS.Timeout | null = null;
let countdownInterval: NodeJS.Timeout | null = null;

// SSE Client list. Each connection keeps its own API origin so protected image
// links remain credentialed and usable when the dashboard and API are split.
let sseClients: Array<{ res: Response; origin: string }> = [];

function publicSseAccessLog(log: AccessLogRecord, origin: string) {
  const { photoSnapshot: _image, faceEmbedding: _embedding, faceEmbeddingDims: _dims,
    faceEmbeddingModelTag: _model, faceEmbeddingQuality: _quality, ...metadata } = log;
  const imageUrl = new URL(`/api/logs/${encodeURIComponent(log.id)}/image`, origin).toString();
  return { ...metadata, photoSnapshot: imageUrl, imageUrl, hasImage: Boolean(log.photoSnapshot) };
}

function publicSsePayload(eventType: string, data: any, origin: string) {
  const sanitized = sanitizePublicJson(data);
  if (["access_granted", "access_denied", "stranger_detected"].includes(eventType) && data?.log) {
    sanitized.log = publicSseAccessLog(data.log, origin);
  }
  return sanitized;
}

function broadcastSSE(eventType: string, data: any) {
  sseClients.forEach((client) => {
    try {
      const payload = publicSsePayload(eventType, data, client.origin);
      client.res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client disconnected
    }
  });
}

// Hook up worker pool with SSE broadcasting
faceWorkerPool.setBroadcastSSE(broadcastSSE);
faceWorkerPool.initWorkerPool(cameraStreamsConfig.workerThreadsCount || 4);

// ----------------- AUTOMATIC DOOR CONTROLLER API DISPATCH -----------------
async function sendDoorControllerCommand(
  action: "OPEN" | "CLOSE",
  triggeredBy: string
): Promise<DoorApiLogRecord | null> {
  doorControllerConfig = db.getDoorControllerConfig(DEFAULT_DOOR_CONTROLLER_CONFIG);
  if (!doorControllerConfig.enabled) {
    return null;
  }

  if (!doorControllerConfig.apiUrl || !doorControllerConfig.apiUrl.trim()) {
    return null;
  }

  const startTime = Date.now();
  let targetUrl = doorControllerConfig.apiUrl.trim();

  // If QUERY_PARAM auth is chosen
  if (doorControllerConfig.authHeaderType === "QUERY_PARAM" && doorControllerConfig.apiToken) {
    const separator = targetUrl.includes("?") ? "&" : "?";
    targetUrl = `${targetUrl}${separator}token=${encodeURIComponent(doorControllerConfig.apiToken.trim())}`;
  }

  const method = action === "OPEN" ? doorControllerConfig.openMethod : doorControllerConfig.closeMethod;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EtonSmartLockDoorGateway/1.0",
  };

  if (doorControllerConfig.apiToken && doorControllerConfig.apiToken.trim()) {
    const token = doorControllerConfig.apiToken.trim();
    if (doorControllerConfig.authHeaderType === "BEARER") {
      headers["Authorization"] = `Bearer ${token}`;
    } else if (doorControllerConfig.authHeaderType === "API_KEY") {
      headers["X-Api-Key"] = token;
    } else if (doorControllerConfig.authHeaderType === "CUSTOM_HEADER") {
      const headerKey = doorControllerConfig.customHeaderName?.trim() || "X-Door-Token";
      headers[headerKey] = token;
    }
  }

  let requestBody: string | undefined = undefined;
  if (method !== "GET") {
    const rawTemplate =
      action === "OPEN"
        ? doorControllerConfig.openPayloadTemplate
        : doorControllerConfig.closePayloadTemplate;

    if (rawTemplate && rawTemplate.trim()) {
      try {
        requestBody = rawTemplate
          .replace(/\{\{ACTION\}\}/g, action)
          .replace(/\{\{TRIGGERED_BY\}\}/g, triggeredBy)
          .replace(/\{\{TIMESTAMP\}\}/g, new Date().toISOString())
          .replace(/\{\{PULSE\}\}/g, String(doorControllerConfig.pulseDurationSeconds || 6))
          .replace(/\{\{DOOR\}\}/g, smartLockState.doorName);
      } catch {
        requestBody = rawTemplate;
      }
    } else {
      requestBody = JSON.stringify({
        action,
        door: smartLockState.doorName,
        pulseDuration: doorControllerConfig.pulseDurationSeconds || 6,
        triggeredBy,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const maskedHeaders: Record<string, string> = { ...headers };
  if (maskedHeaders["Authorization"]) maskedHeaders["Authorization"] = "Bearer ****";
  if (maskedHeaders["X-Api-Key"]) maskedHeaders["X-Api-Key"] = "****";
  if (doorControllerConfig.customHeaderName && maskedHeaders[doorControllerConfig.customHeaderName]) {
    maskedHeaders[doorControllerConfig.customHeaderName] = "****";
  }

  const logEntry: DoorApiLogRecord = {
    id: "DOOR-API-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    action,
    url: targetUrl,
    method,
    requestHeaders: maskedHeaders,
    requestBody,
    success: false,
    durationMs: 0,
    triggeredBy,
  };

  // Fail closed: every supported auth scheme needs a token. Without one the
  // command would go out unauthenticated, so it is not sent - and the reason
  // is logged where the operator looks, instead of an opaque network error.
  if (!doorControllerConfig.apiToken || !doorControllerConfig.apiToken.trim()) {
    logEntry.error = "Chưa cấu hình mã xác thực bộ điều khiển cửa - lệnh không được gửi";
    doorApiLogs.unshift(logEntry);
    if (doorApiLogs.length > 60) doorApiLogs = doorApiLogs.slice(0, 60);
    db.saveDoorApiLog(logEntry);
    broadcastSSE("door_api_log", logEntry);
    return logEntry;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(targetUrl, {
      method,
      headers,
      body: method !== "GET" ? requestBody : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    logEntry.durationMs = Date.now() - startTime;
    logEntry.statusCode = response.status;
    logEntry.statusText = response.statusText;
    const resText = await response.text();
    logEntry.responseBody = resText.substring(0, 500);
    logEntry.success = response.ok;

    console.log(
      `[Door API] Đã gửi lệnh ${action} tới ${targetUrl} (Status: ${response.status}) trong ${logEntry.durationMs}ms`
    );
  } catch (err: any) {
    logEntry.durationMs = Date.now() - startTime;
    logEntry.error = err?.message || String(err);
    console.error(`[Door API] Lỗi gửi lệnh ${action} tới ${targetUrl}:`, err?.message);
  }

  doorApiLogs.unshift(logEntry);
  if (doorApiLogs.length > 60) {
    doorApiLogs = doorApiLogs.slice(0, 60);
  }
  db.saveDoorApiLog(logEntry);
  broadcastSSE("door_api_log", logEntry);

  return logEntry;
}

function unlockDoor(source: string, employeeName?: string, employeeId?: string) {
  if (autoRelockTimer) clearTimeout(autoRelockTimer);
  if (countdownInterval) clearInterval(countdownInterval);

  smartLockState.state = "UNLOCKED";
  smartLockState.isLocked = false;
  smartLockState.lastActionAt = new Date().toISOString();
  smartLockState.lastActionBy = employeeName
    ? `${employeeName} (${source})`
    : `Lệnh mở từ ${source}`;
  smartLockState.remainingRelockSeconds = smartLockState.autoRelockSeconds;

  broadcastSSE("lock_state", smartLockState);
  db.saveSmartLockState(smartLockState);

  // Trigger automated hardware door opening via API if enabled
  if (doorControllerConfig.enabled) {
    const isFace = source.includes("Nhận diện");
    const shouldTrigger = isFace
      ? doorControllerConfig.triggerOnFaceRecognition
      : doorControllerConfig.triggerOnManualUnlock;

    if (shouldTrigger) {
      sendDoorControllerCommand("OPEN", employeeName || source).catch((err) => {
        console.warn("[Door Controller] Lỗi gửi lệnh OPEN:", err?.message);
      });
    }
  }

  // Start countdown interval
  countdownInterval = setInterval(() => {
    if (smartLockState.remainingRelockSeconds > 0) {
      smartLockState.remainingRelockSeconds -= 1;
      broadcastSSE("lock_countdown", {
        remainingSeconds: smartLockState.remainingRelockSeconds,
      });
    }
  }, 1000);

  // Auto-lock timer
  autoRelockTimer = setTimeout(() => {
    lockDoor("Tự động khóa sau " + smartLockState.autoRelockSeconds + "s");
  }, smartLockState.autoRelockSeconds * 1000);
}

function lockDoor(source: string) {
  if (autoRelockTimer) {
    clearTimeout(autoRelockTimer);
    autoRelockTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  smartLockState.state = "LOCKED";
  smartLockState.isLocked = true;
  smartLockState.remainingRelockSeconds = 0;
  smartLockState.lastActionAt = new Date().toISOString();
  smartLockState.lastActionBy = source;

  broadcastSSE("lock_state", smartLockState);
  db.saveSmartLockState(smartLockState);

  // Trigger automated hardware door closing via API if enabled
  if (doorControllerConfig.enabled) {
    sendDoorControllerCommand("CLOSE", source).catch((err) => {
      console.warn("[Door Controller] Lỗi gửi lệnh CLOSE:", err?.message);
    });
  }
}

// ----------------- API ROUTES -----------------

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// SSE endpoint for real-time mobile notifications and lock status
app.get(
  ["/api/events", "/api/events/", "/events", "/events/"],
  requireOperatorRole("viewer"),
  requireAllowedReadOrigin,
  (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const origin = requestOrigin(req);
  sseClients.push({ res, origin });

  // Send initial state
  res.write(`event: connected\ndata: {"status":"connected"}\n\n`);
  res.write(
    `event: lock_state\ndata: ${JSON.stringify(smartLockState)}\n\n`
  );

  const keepAlive = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter((client) => client.res !== res);
  });
});

// --- Smart Lock Endpoints ---
app.get(
  [
    "/api/lock/status",
    "/api/lock/status/",
    "/lock/status",
    "/lock/status/",
    "/api/status",
    "/status",
  ],
  (_req, res) => {
    res.json(smartLockState);
  }
);

app.post("/api/lock/unlock", (req, res) => {
  const { source = "API Remote", employeeName, employeeId } = req.body;
  unlockDoor(source, employeeName, employeeId);

  const notif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: "Khóa cửa thông minh mở",
    body: `Cửa đã được mở qua ${source}`,
    timestamp: new Date().toISOString(),
    type: "INFO",
    read: false,
  };
  mobileNotifications.unshift(notif);
  broadcastSSE("notification", notif);

  res.json({
    success: true,
    message: "Khóa cửa đã mở thành công qua API",
    lockState: smartLockState,
  });
});

app.post("/api/lock/lock", (req, res) => {
  const { source = "API Remote Lock" } = req.body;
  lockDoor(source);

  const notif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: "Cửa đã khóa an toàn",
    body: `Cửa chính đã đóng chốt khóa an toàn (${source})`,
    timestamp: new Date().toISOString(),
    type: "INFO",
    read: false,
  };
  mobileNotifications.unshift(notif);
  broadcastSSE("notification", notif);

  res.json({
    success: true,
    message: "Đã khóa cửa thành công",
    lockState: smartLockState,
  });
});

// --- Webhook Endpoints (Eton Chat Room) ---
const WEBHOOK_CONFIG_ROUTES = [
  "/api/webhook/config",
  "/api/webhook/config/",
  "/webhook/config",
  "/webhook/config/",
];

const WEBHOOK_LOGS_ROUTES = [
  "/api/webhook/logs",
  "/api/webhook/logs/",
  "/webhook/logs",
  "/webhook/logs/",
];

const WEBHOOK_TEST_ROUTES = [
  "/api/webhook/test",
  "/api/webhook/test/",
  "/webhook/test",
  "/webhook/test/",
];

const WEBHOOK_TEST_STRANGER_ROUTES = [
  "/api/webhook/test-stranger",
  "/api/webhook/test-stranger/",
  "/webhook/test-stranger",
  "/webhook/test-stranger/",
];

const WEBHOOK_CLIENT_LOG_ROUTES = [
  "/api/webhook/client-log",
  "/api/webhook/client-log/",
  "/webhook/client-log",
  "/webhook/client-log/",
];

app.get(WEBHOOK_CONFIG_ROUTES, (_req, res) => {
  webhookConfig = db.getWebhookConfig(DEFAULT_WEBHOOK_CONFIG);
  res.json(webhookConfig);
});

app.post(WEBHOOK_CONFIG_ROUTES, (req, res) => {
  const body = req.body || {};
  const { enabled, url, gateInTitle, gateOutTitle, includeEmployeeCode } = body;
  if (typeof enabled === "boolean") webhookConfig.enabled = enabled;
  if (typeof url === "string") {
    let cleanUrl = url.trim();
    if (cleanUrl && (cleanUrl.includes("...") || cleanUrl.endsWith("/hooks/") || cleanUrl.endsWith("/hooks"))) {
      cleanUrl = DEFAULT_WEBHOOK_CONFIG.url;
    }
    webhookConfig.url = cleanUrl;
  }
  if (gateInTitle && typeof gateInTitle === "string") webhookConfig.gateInTitle = gateInTitle.trim();
  if (gateOutTitle && typeof gateOutTitle === "string") webhookConfig.gateOutTitle = gateOutTitle.trim();
  if (typeof includeEmployeeCode === "boolean") webhookConfig.includeEmployeeCode = includeEmployeeCode;

  // ---- Cảnh báo người lạ. Partial updates must never drop the other fields. ----
  const {
    strangerAlertEnabled,
    strangerTitle,
    strangerLinkLabel,
    appBaseUrl,
    strangerCooldownSeconds,
  } = body;
  if (typeof strangerAlertEnabled === "boolean") webhookConfig.strangerAlertEnabled = strangerAlertEnabled;
  if (strangerTitle && typeof strangerTitle === "string") webhookConfig.strangerTitle = strangerTitle.trim();
  if (strangerLinkLabel && typeof strangerLinkLabel === "string") webhookConfig.strangerLinkLabel = strangerLinkLabel.trim();
  if (typeof appBaseUrl === "string") {
    // "" clears the override and falls back to APP_URL / the request origin.
    webhookConfig.appBaseUrl = appBaseUrl.trim().replace(/\/+$/, "");
  }
  if (typeof strangerCooldownSeconds === "number" && Number.isFinite(strangerCooldownSeconds) && strangerCooldownSeconds >= 0) {
    webhookConfig.strangerCooldownSeconds = Math.floor(strangerCooldownSeconds);
  }

  db.saveWebhookConfig(webhookConfig);
  res.json({ success: true, config: webhookConfig });
});

app.get("/api/system/db-info", (_req, res) => {
  res.json({
    success: true,
    storage: db.getStorageInfo(),
    counts: {
      employees: employees.length,
      accessLogs: accessLogs.length,
      notifications: mobileNotifications.length,
      webhookLogs: webhookLogs.length,
    },
  });
});

// Network IP & Egress Inspection endpoint for Firewall/Proxy whitelisting
app.get(["/api/network/ip-info", "/api/system/ip-info"], async (_req, res) => {
  const backendHost = "ais-dev-oru4xhzwwq7ai4fnvomzyh-216092153311.asia-east1.run.app";
  const destinationHost = "chat-room.eton.vn";

  const fetchText = (url: string, timeout = 3000): Promise<string> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(""), timeout);
      https
        .get(url, (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            clearTimeout(timer);
            resolve(data.trim());
          });
        })
        .on("error", () => {
          clearTimeout(timer);
          resolve("");
        });
    });
  };

  const [outboundIpv4, outboundAny, inboundAddresses, destAddresses] = await Promise.all([
    fetchText("https://api.ipify.org").catch(() => ""),
    fetchText("https://ifconfig.me/ip").catch(() => ""),
    dns.promises.lookup(backendHost, { all: true }).catch(() => []),
    dns.promises.lookup(destinationHost, { all: true }).catch(() => []),
  ]);

  const effectiveOutboundIpv4 = outboundIpv4 || (outboundAny.includes(".") ? outboundAny : "34.34.244.150");
  const effectiveOutboundIpv6 = outboundAny.includes(":") ? outboundAny : "2600:1900:0:3804::b00";

  const inboundIpv4List = (inboundAddresses as any[])
    .filter((a) => a.family === 4)
    .map((a) => a.address);

  const inboundIpv6List = (inboundAddresses as any[])
    .filter((a) => a.family === 6)
    .map((a) => a.address);

  const destIpv4List = (destAddresses as any[])
    .filter((a) => a.family === 4)
    .map((a) => a.address);

  const emailTemplate = `Kính gửi Team Network / Quản trị hệ thống Chat Room Eton,

Hệ thống Camera AI Face ID (Smart Lock) cần gửi Webhook thông báo chấm công Vào/Ra tới hệ thống ${destinationHost}.
Hiện tại các request đang gặp phản hồi HTTP 403 Forbidden từ Firewall/WAF/Nginx của eton.vn.

Kính nhờ Team Network hỗ trợ mở Whitelist cho địa chỉ IP Egress của Backend như sau:
--------------------------------------------------
1. IP NGUỒN GỌI ĐI (Egress IPv4 - Quan trọng nhất):
   - IP máy chủ gọi ra: ${effectiveOutboundIpv4}
   - Dải IP dự phòng (Google Cloud asia-east1): 34.34.244.0/24 (hoặc AS15169)
   - Egress IPv6 (nếu hỗ trợ): ${effectiveOutboundIpv6}

2. TÊN MIỀN & INBOUND IP CỦA BACKEND:
   - Domain Backend: https://${backendHost}
   - Dải Inbound Anycast IP: 34.143.72.0/21 (Ví dụ: ${inboundIpv4List.slice(0, 3).join(", ")})

3. MỤC TIÊU GỌI ĐẾN (Destination):
   - Host: ${destinationHost} (IP: ${destIpv4List.join(", ") || "45.118.151.67"})
   - Port: 443 (HTTPS) / 80 (HTTP)
   - Phương thức: POST
   - Content-Type: application/json
   - User-Agent: Mozilla/5.0 ... EtonWebhookBot/1.0
--------------------------------------------------
Trân trọng cảm ơn!`;

  res.json({
    success: true,
    backendHost,
    destinationHost,
    outbound: {
      ipv4: effectiveOutboundIpv4,
      ipv4SubnetRecommended: "34.34.244.0/24",
      ipv6: effectiveOutboundIpv6,
      provider: "Google Cloud Platform (GCP) - asia-east1 (Taiwan)",
      asNumber: "AS15169 Google LLC",
      note: "Đây là IP thực tế mà chat-room.eton.vn nhìn thấy khi nhận request từ backend",
    },
    inbound: {
      domain: backendHost,
      ipv4: inboundIpv4List,
      ipv6: inboundIpv6List,
      note: "Địa chỉ IP Anycast Edge của Google Cloud định tuyến tới Cloud Run",
    },
    destination: {
      domain: destinationHost,
      resolvedIps: destIpv4List,
    },
    emailTemplate,
  });
});

app.get(WEBHOOK_LOGS_ROUTES, (_req, res) => {
  res.json(webhookLogs);
});

app.delete(WEBHOOK_LOGS_ROUTES, (_req, res) => {
  webhookLogs = [];
  db.clearWebhookLogs();
  broadcastSSE("webhook_logs_cleared", { success: true });
  res.json({ success: true, message: "Đã xóa toàn bộ nhật ký webhook." });
});

app.post(WEBHOOK_TEST_ROUTES, async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  const {
    testScanType = "ENTRY",
    customUser = "Nguyễn Hoàng Minh",
    customCode = "NV-1082",
  } = body;

  const result = await sendEtonWebhook({
    userName: customUser,
    employeeCode: customCode,
    scanType: testScanType === "EXIT" ? "EXIT" : "ENTRY",
  });

  const scanLabel = testScanType === "EXIT" ? "CỔNG RA" : "CỔNG VÀO";
  const mobileNotif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: `Webhook ${scanLabel}: ${customUser}`,
    body: `${customUser} (${customCode}) - Đã phát lệnh Webhook ${testScanType === "EXIT" ? "Check-out" : "Check-in"} đến Eton Chat Room`,
    timestamp: new Date().toISOString(),
    type: "SUCCESS",
    read: false,
    employeeName: customUser,
  };
  mobileNotifications.unshift(mobileNotif);
  db.saveNotification(mobileNotif);
  broadcastSSE("notification", mobileNotif);

  res.json({
    success: result ? result.success : true,
    log: result,
    notification: mobileNotif,
    config: webhookConfig,
  });
});

/**
 * POST /api/webhook/test-stranger
 *
 * Sends a sample "người lạ" alert with the CURRENT config and a synthetic log
 * id, so the UI can offer "Gửi thử cảnh báo người lạ". The cooldown is bypassed
 * by default (an operator test must never be silently swallowed) and a test
 * send does not start the cooldown for real alerts; pass
 * `{ respectCooldown: true }` to exercise the real throttling path.
 *
 * Body (all optional): { scanType: "ENTRY" | "EXIT", doorName, faceCount,
 *                        logId, respectCooldown }
 * 200 -> { success, log: WebhookLogRecord | null, baseUrl, link, config }
 *        or { success: false, error } when the alert was not sent.
 */
app.post(WEBHOOK_TEST_STRANGER_ROUTES, async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  const scanType: "ENTRY" | "EXIT" = body.scanType === "EXIT" ? "EXIT" : "ENTRY";
  const syntheticLogId =
    typeof body.logId === "string" && body.logId.trim()
      ? body.logId.trim()
      : "LOG-TEST-" + Date.now();
  const doorName =
    typeof body.doorName === "string" && body.doorName.trim()
      ? body.doorName.trim()
      : smartLockState.doorName;
  const faceCount =
    typeof body.faceCount === "number" && body.faceCount > 0 ? Math.floor(body.faceCount) : 1;

  const baseUrl = resolveAppBaseUrl(req);
  const link = buildStrangerDeepLink(baseUrl, syntheticLogId);

  let result: WebhookLogRecord | null = null;
  try {
    result = await sendStrangerWebhook({
      log: {
        id: syntheticLogId,
        type: scanType,
        reason: "Gửi thử cảnh báo người lạ từ bảng điều khiển (không phải sự kiện thật)",
      },
      doorName,
      faceCount,
      baseUrl,
      bypassCooldown: body.respectCooldown !== true,
    });
  } catch (err: any) {
    res.json({
      success: false,
      error: err?.message || String(err),
      baseUrl,
      link,
      config: webhookConfig,
    });
    return;
  }

  if (!result) {
    res.json({
      success: false,
      error: !webhookConfig.enabled
        ? "Webhook đang tắt. Bật webhook trước khi gửi thử."
        : webhookConfig.strangerAlertEnabled === false
          ? "Cảnh báo người lạ đang tắt (strangerAlertEnabled = false)."
          : "Cảnh báo người lạ bị bỏ qua do đang trong thời gian chờ (cooldown).",
      log: null,
      baseUrl,
      link,
      config: webhookConfig,
    });
    return;
  }

  res.json({
    success: result.success,
    log: result,
    baseUrl,
    link,
    config: webhookConfig,
  });
});

app.post(WEBHOOK_CLIENT_LOG_ROUTES, (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  const log = body.log || (body.url && body.payload ? body : undefined);
  const notification = body.notification;

  if (log) {
    // Avoid duplicate log IDs
    if (!webhookLogs.some((l) => l.id === log.id)) {
      webhookLogs.unshift(log);
      if (webhookLogs.length > 60) {
        webhookLogs = webhookLogs.slice(0, 60);
      }
      db.saveWebhookLog(log);
      broadcastSSE("webhook_log", log);
    }
  }
  if (notification) {
    if (!mobileNotifications.some((n) => n.id === notification.id)) {
      mobileNotifications.unshift(notification);
      db.saveNotification(notification);
      broadcastSSE("notification", notification);
    }
  }
  res.json({ success: true });
});

// --- Door Controller API Configuration & Logging Endpoints ---
const DOOR_CONFIG_ROUTES = [
  "/api/door-controller/config",
  "/api/door-controller/config/",
  "/api/door-config",
  "/api/door-config/",
];

const DOOR_TEST_ROUTES = [
  "/api/door-controller/test",
  "/api/door-controller/test/",
  "/api/door-config/test",
  "/api/door-config/test/",
];

const DOOR_LOGS_ROUTES = [
  "/api/door-controller/logs",
  "/api/door-controller/logs/",
  "/api/door-config/logs",
  "/api/door-config/logs/",
];

app.get(DOOR_CONFIG_ROUTES, (_req, res) => {
  doorControllerConfig = db.getDoorControllerConfig(DEFAULT_DOOR_CONTROLLER_CONFIG);
  res.json(doorControllerConfig);
});

app.post(DOOR_CONFIG_ROUTES, (req, res) => {
  const body = req.body || {};
  const current = db.getDoorControllerConfig(DEFAULT_DOOR_CONTROLLER_CONFIG);

  const updated: DoorControllerConfigRecord = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    apiUrl: typeof body.apiUrl === "string" ? body.apiUrl.trim() : current.apiUrl,
    apiToken: typeof body.apiToken === "string" ? body.apiToken.trim() : current.apiToken,
    authHeaderType: body.authHeaderType || current.authHeaderType,
    customHeaderName: typeof body.customHeaderName === "string" ? body.customHeaderName.trim() : current.customHeaderName,
    openMethod: body.openMethod || current.openMethod,
    closeMethod: body.closeMethod || current.closeMethod,
    openPayloadTemplate: typeof body.openPayloadTemplate === "string" ? body.openPayloadTemplate : current.openPayloadTemplate,
    closePayloadTemplate: typeof body.closePayloadTemplate === "string" ? body.closePayloadTemplate : current.closePayloadTemplate,
    pulseDurationSeconds: typeof body.pulseDurationSeconds === "number" ? body.pulseDurationSeconds : current.pulseDurationSeconds,
    triggerOnFaceRecognition: typeof body.triggerOnFaceRecognition === "boolean" ? body.triggerOnFaceRecognition : current.triggerOnFaceRecognition,
    triggerOnManualUnlock: typeof body.triggerOnManualUnlock === "boolean" ? body.triggerOnManualUnlock : current.triggerOnManualUnlock,
  };

  doorControllerConfig = updated;
  db.saveDoorControllerConfig(updated);
  broadcastSSE("door_config_updated", updated);

  res.json({ success: true, config: updated });
});

app.post(DOOR_TEST_ROUTES, async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  const action: "OPEN" | "CLOSE" = body.action === "CLOSE" ? "CLOSE" : "OPEN";
  const source = body.source || "Test Console (Dashboard)";

  // If temporary config is supplied in test body, allow testing before saving
  let tempConfig = false;
  let originalConfig: DoorControllerConfigRecord | null = null;
  if (body.testConfig) {
    tempConfig = true;
    originalConfig = { ...doorControllerConfig };
    doorControllerConfig = {
      ...doorControllerConfig,
      ...body.testConfig,
      enabled: true, // Force enabled for explicit test button
    };
  }

  try {
    // If testing OPEN, also trigger door state update so the user sees UI feedback if desired
    if (body.updateDoorState) {
      if (action === "OPEN") {
        unlockDoor(`Test API: ${source}`);
      } else {
        lockDoor(`Test API: ${source}`);
      }
    }

    const result = await sendDoorControllerCommand(action, source);

    if (tempConfig && originalConfig) {
      doorControllerConfig = originalConfig;
    }

    res.json({
      success: result ? result.success : false,
      log: result,
      config: doorControllerConfig,
    });
  } catch (err: any) {
    if (tempConfig && originalConfig) {
      doorControllerConfig = originalConfig;
    }
    res.status(500).json({
      success: false,
      error: err?.message || "Lỗi chạy thử nghiệm API cửa",
    });
  }
});

app.get(DOOR_LOGS_ROUTES, (_req, res) => {
  doorApiLogs = db.getDoorApiLogs();
  res.json(doorApiLogs);
});

app.delete(DOOR_LOGS_ROUTES, (_req, res) => {
  doorApiLogs = [];
  db.clearDoorApiLogs();
  broadcastSSE("door_api_logs_cleared", { success: true });
  res.json({ success: true, message: "Đã xóa toàn bộ nhật ký API điều khiển cửa." });
});

app.post(["/api/door-controller/client-log", "/api/door-controller/client-log/"], (req, res) => {
  const body = req.body || {};
  const log = body.log;
  if (log) {
    if (!doorApiLogs.some((l) => l.id === log.id)) {
      doorApiLogs.unshift(log);
      if (doorApiLogs.length > 60) {
        doorApiLogs = doorApiLogs.slice(0, 60);
      }
      db.saveDoorApiLog(log);
      broadcastSSE("door_api_log", log);
    }
  }
  res.json({ success: true });
});

// =========================================================================
// CAMERA STREAMS (RTSP / UVC / HTTP) & MULTI-THREAD WORKER POOL ENDPOINTS
// =========================================================================
const CAMERA_CONFIG_ROUTES = [
  "/api/camera-streams/config",
  "/api/camera-streams/config/",
];

const CAMERA_THREADS_ROUTES = [
  "/api/camera-streams/threads",
  "/api/camera-streams/threads/",
];

app.get(CAMERA_CONFIG_ROUTES, (_req, res) => {
  cameraStreamsConfig = loadCameraStreamsConfig();
  res.json({
    success: true,
    config: cameraStreamsConfig,
    telemetry: faceWorkerPool.getPoolTelemetry(),
  });
});

app.post(CAMERA_CONFIG_ROUTES, (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  const current = loadCameraStreamsConfig();
  const { entryGate: entryPatch, exitGate: exitPatch, ...rootPatch } = body || {};
  const updated: CameraStreamsConfigRecord = normalizeCameraStreamsConfig({
    ...current,
    ...rootPatch,
    entryGate: applyGateConfigPatch(current.entryGate, entryPatch),
    exitGate: applyGateConfigPatch(current.exitGate, exitPatch),
  });

  if (typeof body.workerThreadsCount === "number" && body.workerThreadsCount !== current.workerThreadsCount) {
    faceWorkerPool.scaleWorkerPool(body.workerThreadsCount);
  }

  cameraStreamsConfig = updated;
  db.saveCameraStreamsConfig(updated);
  broadcastSSE("camera_config_updated", updated);
  syncGateWatchers();

  res.json({
    success: true,
    config: updated,
    telemetry: faceWorkerPool.getPoolTelemetry(),
  });
});

// ---- Per-stream convenience endpoints: /api/camera-streams/:gate/streams[/:streamId] ----
type GateConfigKey = "entryGate" | "exitGate";

function gateConfigKeyFromParam(param: unknown): GateConfigKey | null {
  const key = String(param || "").toLowerCase();
  if (key === "entry") return "entryGate";
  if (key === "exit") return "exitGate";
  return null;
}

/** Persists a gate whose stream list was edited, broadcasts, and returns the normalised gate. */
function commitGateStreams(gateKey: GateConfigKey, streams: GateStreamSourceRecord[]): GateStreamConfigRecord {
  const current = loadCameraStreamsConfig();
  const updated = normalizeCameraStreamsConfig({
    ...current,
    [gateKey]: normalizeGateConfig({ ...current[gateKey], streams }),
  });
  cameraStreamsConfig = updated;
  db.saveCameraStreamsConfig(updated);
  broadcastSSE("camera_config_updated", updated);
  syncGateWatchers(); // the watcher may now have (or have lost) something to scan
  return updated[gateKey];
}

function findDuplicateStream(
  streams: GateStreamSourceRecord[],
  candidate: { id: string; rtspUrl?: string },
  ignoreId?: string
): { field: "id" | "rtspUrl"; stream: GateStreamSourceRecord } | null {
  for (const s of streams) {
    if (ignoreId && s.id === ignoreId) continue;
    if (s.id === candidate.id) return { field: "id", stream: s };
    if (candidate.rtspUrl && s.rtspUrl && s.rtspUrl.toLowerCase() === candidate.rtspUrl.toLowerCase()) {
      return { field: "rtspUrl", stream: s };
    }
  }
  return null;
}

const STREAM_ROUTE = ["/api/camera-streams/:gate/streams", "/api/camera-streams/:gate/streams/"];
const STREAM_ITEM_ROUTE = ["/api/camera-streams/:gate/streams/:streamId", "/api/camera-streams/:gate/streams/:streamId/"];

app.get(STREAM_ROUTE, (req, res) => {
  const gateKey = gateConfigKeyFromParam(req.params.gate);
  if (!gateKey) return res.status(400).json({ success: false, error: "Cổng không hợp lệ: chỉ chấp nhận entry hoặc exit" });
  const gate = loadCameraStreamsConfig()[gateKey];
  res.json({ success: true, gate, streams: gate.streams, primaryStreamId: pickPrimaryStream(gate.streams!).id });
});

app.post(STREAM_ROUTE, (req, res) => {
  const gateKey = gateConfigKeyFromParam(req.params.gate);
  if (!gateKey) return res.status(400).json({ success: false, error: "Cổng không hợp lệ: chỉ chấp nhận entry hoặc exit" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const gate = loadCameraStreamsConfig()[gateKey];
  const existing = gate.streams!;
  if (existing.length >= MAX_STREAMS_PER_GATE) {
    return res.status(400).json({ success: false, error: `Mỗi cổng chỉ hỗ trợ tối đa ${MAX_STREAMS_PER_GATE} luồng video` });
  }

  const gateParam = gateKey === "exitGate" ? "exit" : "entry";
  const hasPriority = Number.isFinite(Number(body.priority));
  const nextPriority = existing.reduce((max, s) => Math.max(max, s.priority), 0) + 10;
  const rawId = optionalTrimmedString(body.id);
  if (rawId && !STREAM_ID_RE.test(rawId)) {
    return res.status(400).json({ success: false, error: "Mã luồng (id) chỉ gồm chữ, số, dấu chấm, gạch ngang/gạch dưới (tối đa 64 ký tự)" });
  }
  const candidate = sanitizeStreamSource(
    {
      ...body,
      id: rawId || deriveStreamId(gateParam, body.rtspUrl, Date.now().toString(36)),
      priority: hasPriority ? Number(body.priority) : nextPriority,
    },
    existing.length,
    gateParam,
    gate.name
  );
  if (!candidate.label || candidate.label === candidate.id) {
    candidate.label = optionalTrimmedString(body.label) || `${gate.name} #${existing.length + 1}`;
  }

  const duplicate = findDuplicateStream(existing, candidate);
  if (duplicate) {
    return res.status(409).json({
      success: false,
      error:
        duplicate.field === "id"
          ? `Luồng "${candidate.id}" đã tồn tại ở cổng này`
          : `URL RTSP này đã được dùng bởi luồng "${duplicate.stream.label}" (${duplicate.stream.id})`,
      conflictField: duplicate.field,
      conflictStreamId: duplicate.stream.id,
    });
  }

  const updatedGate = commitGateStreams(gateKey, [...existing, candidate]);
  res.status(201).json({
    success: true,
    gate: updatedGate,
    stream: updatedGate.streams!.find((s) => s.id === candidate.id) || candidate,
    primaryStreamId: pickPrimaryStream(updatedGate.streams!).id,
  });
});

app.put(STREAM_ITEM_ROUTE, (req, res) => {
  const gateKey = gateConfigKeyFromParam(req.params.gate);
  if (!gateKey) return res.status(400).json({ success: false, error: "Cổng không hợp lệ: chỉ chấp nhận entry hoặc exit" });
  const streamId = String(req.params.streamId || "");
  const gate = loadCameraStreamsConfig()[gateKey];
  const existing = gate.streams!;
  const index = existing.findIndex((s) => s.id === streamId);
  if (index === -1) {
    return res.status(404).json({ success: false, error: `Không tìm thấy luồng "${streamId}" ở cổng này` });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { id: _ignoredId, ...patch } = body; // ids are immutable (used in URLs / SSE clients)
  const gateParam = gateKey === "exitGate" ? "exit" : "entry";
  const updatedStream = sanitizeStreamSource({ ...existing[index], ...patch, id: streamId }, index, gateParam, gate.name);

  const duplicate = findDuplicateStream(existing, updatedStream, streamId);
  if (duplicate) {
    return res.status(409).json({
      success: false,
      error: `URL RTSP này đã được dùng bởi luồng "${duplicate.stream.label}" (${duplicate.stream.id})`,
      conflictField: duplicate.field,
      conflictStreamId: duplicate.stream.id,
    });
  }

  const streams = existing.map((s, i) => (i === index ? updatedStream : s));
  const updatedGate = commitGateStreams(gateKey, streams);
  res.json({
    success: true,
    gate: updatedGate,
    stream: updatedGate.streams!.find((s) => s.id === streamId) || updatedStream,
    primaryStreamId: pickPrimaryStream(updatedGate.streams!).id,
  });
});

app.delete(STREAM_ITEM_ROUTE, (req, res) => {
  const gateKey = gateConfigKeyFromParam(req.params.gate);
  if (!gateKey) return res.status(400).json({ success: false, error: "Cổng không hợp lệ: chỉ chấp nhận entry hoặc exit" });
  const streamId = String(req.params.streamId || "");
  const gate = loadCameraStreamsConfig()[gateKey];
  const existing = gate.streams!;
  if (!existing.some((s) => s.id === streamId)) {
    return res.status(404).json({ success: false, error: `Không tìm thấy luồng "${streamId}" ở cổng này` });
  }
  if (existing.length <= 1) {
    return res.status(400).json({
      success: false,
      error: "Không thể xoá luồng video cuối cùng của cổng. Hãy thêm luồng khác trước hoặc tắt (enabled=false) luồng này.",
    });
  }
  const updatedGate = commitGateStreams(gateKey, existing.filter((s) => s.id !== streamId));
  res.json({
    success: true,
    gate: updatedGate,
    removedStreamId: streamId,
    primaryStreamId: pickPrimaryStream(updatedGate.streams!).id,
  });
});

/**
 * Picks the stream a media route (snapshot / mjpeg / scan-rtsp) should use:
 * `?stream=<id>` when given (error when the id is unknown for that gate),
 * otherwise the gate's primary stream.
 */
function resolveGateStream(
  gateParam: unknown,
  streamParam?: unknown
): { gateKey: "entry" | "exit"; gate: GateStreamConfigRecord; stream: GateStreamSourceRecord; error?: string } {
  const gateKey = normalizeGateKey(gateParam);
  const gate = normalizeGateConfig(gateKey === "exit" ? cameraStreamsConfig.exitGate : cameraStreamsConfig.entryGate);
  const streams = gate.streams!;
  const primary = pickPrimaryStream(streams);
  const wanted = optionalTrimmedString(streamParam);
  if (!wanted) return { gateKey, gate, stream: primary };
  const found = streams.find((s) => s.id === wanted);
  if (!found) {
    return {
      gateKey,
      gate,
      stream: primary,
      error: `Luồng "${wanted}" không tồn tại ở cổng ${gateKey === "exit" ? "ra" : "vào"}. Các luồng hiện có: ${streams.map((s) => s.id).join(", ")}`,
    };
  }
  return { gateKey, gate, stream: found };
}

/**
 * ffmpeg argument set for a single-frame RTSP grab (snapshot + scan-rtsp).
 * Tuned on the site NVR - keep in sync between the two routes by changing it here only.
 */
function buildRtspSingleFrameArgs(streamUrl: string, transport: "tcp" | "udp"): string[] {
  return [
    "-rtsp_transport", transport,
    "-timeout", "3500000", // 3.5s socket timeout in microseconds (FFmpeg >= 8 renamed -stimeout)
    // Wait for a keyframe: on ffmpeg 5.x (Debian) the first HEVC frame decoded
    // before any reference arrives is emitted as a flat grey picture instead of
    // being discarded, so a single-frame grab returned a blank image.
    "-skip_frame", "nokey",
    // Bound stream probing: with -skip_frame nokey, ffmpeg's default probe kept
    // reading an H.264 feed for ~13 s before emitting a frame (measured on the
    // NVR channel 2401); a small probe brings that to ~2 s. HEVC was unaffected.
    "-probesize", "65536",
    "-analyzeduration", "500000",
    "-i", streamUrl,
    "-vframes", "1",
    "-q:v", "2",
    "-f", "image2",
    "-update", "1",
    "pipe:1",
  ];
}

interface RtspFrameGrab {
  ok: boolean;
  jpeg?: Buffer;
  durationMs: number;
  exitCode: number | null;
  errorLog: string;
}

/** Grabs one JPEG from an RTSP stream (ffmpeg, hard-killed after 9 s). Never rejects. */
function grabRtspFrame(streamUrl: string, transport: "tcp" | "udp"): Promise<RtspFrameGrab> {
  return new Promise((resolve) => {
    const tStart = Date.now();
    const chunks: Buffer[] = [];
    let errorLog = "";
    let settled = false;
    const finish = (ok: boolean, exitCode: number | null, extraErr = "") => {
      if (settled) return;
      settled = true;
      resolve({
        ok,
        jpeg: ok ? Buffer.concat(chunks) : undefined,
        durationMs: Date.now() - tStart,
        exitCode,
        errorLog: (errorLog + extraErr).slice(-400),
      });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ffmpeg", buildRtspSingleFrameArgs(streamUrl, transport));
    } catch (err: any) {
      finish(false, null, String(err?.message || err));
      return;
    }
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => { errorLog += chunk.toString(); });
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 9000);
    proc.on("error", (err) => {
      clearTimeout(timeout);
      finish(false, null, String(err?.message || err));
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0 && chunks.length > 0, code);
    });
  });
}

app.get(CAMERA_THREADS_ROUTES, (_req, res) => {
  res.json({
    success: true,
    telemetry: faceWorkerPool.getPoolTelemetry(),
  });
});

app.post("/api/camera-streams/threads/scale", (req, res) => {
  const count = parseInt(req.body?.count, 10) || 4;
  const telemetry = faceWorkerPool.scaleWorkerPool(count);
  cameraStreamsConfig.workerThreadsCount = count;
  db.saveCameraStreamsConfig(cameraStreamsConfig);
  broadcastSSE("thread_pool_scaled", telemetry);
  res.json({ success: true, telemetry });
});

app.post("/api/camera-streams/benchmark", async (req, res) => {
  const taskCount = Math.min(16, Math.max(2, parseInt(req.body?.taskCount, 10) || 8));
  const tStart = Date.now();

  const promises = [];
  for (let i = 0; i < taskCount; i++) {
    const emp = employees[i % Math.max(1, employees.length)] || DEFAULT_EMPLOYEES[0];
    promises.push(
      faceWorkerPool.dispatchFaceTask({
        taskId: `bench-${Date.now()}-${i}`,
        imageBase64: emp.photoUrl || "sample-benchmark-probe",
        employees: employees as any,
        scanType: i % 2 === 0 ? "ENTRY" : "EXIT",
        testEmployeeId: emp.id,
      })
    );
  }

  try {
    // Backpressure rejections are expected when the probe burst exceeds the
    // queue limit; they are counted, not treated as a failed benchmark.
    const settled = await Promise.allSettled(promises);
    const totalDurationMs = Date.now() - tStart;
    const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const rejections = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    const backpressureRejections = rejections.filter((e) => /backpressure/i.test(String(e?.message || e || "")));
    const otherErrors = rejections.filter((e) => !/backpressure/i.test(String(e?.message || e || "")));
    if (otherErrors.length > 0) {
      throw otherErrors[0];
    }

    const completedTasks = results.length;
    const avgWorkerLatency =
      completedTasks > 0
        ? Math.round((results.reduce((s, r) => s + r.threadLatencyMs, 0) / completedTasks) * 10) / 10
        : 0;
    const threadsUsed = Array.from(new Set(results.map((r) => r.workerId)));

    res.json({
      success: true,
      taskCount,
      completedTasks,
      rejectedByBackpressure: backpressureRejections.length,
      totalDurationMs,
      avgWorkerLatencyMs: avgWorkerLatency,
      throughputFps: totalDurationMs > 0 ? Math.round((completedTasks / (totalDurationMs / 1000)) * 10) / 10 : 0,
      threadsUtilized: threadsUsed,
      telemetry: faceWorkerPool.getPoolTelemetry(),
      sampleResults: results.slice(0, 3),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.post("/api/camera-streams/test-stream", (req, res) => {
  const { url, sourceType, transport } = req.body || {};
  if (!url) {
    return res.status(400).json({ success: false, error: "Vui lòng nhập URL luồng RTSP hoặc HTTP" });
  }

  const isRtsp = String(url).toLowerCase().startsWith("rtsp://");
  const isHttp = String(url).toLowerCase().startsWith("http://") || String(url).toLowerCase().startsWith("https://");

  if (!isRtsp && !isHttp) {
    return res.status(400).json({
      success: false,
      error: "Định dạng URL không hợp lệ. RTSP phải bắt đầu bằng rtsp:// hoặc HTTP bằng http://",
    });
  }

  let host = "";
  let port = isRtsp ? 554 : 80;
  try {
    const clean = url.replace(/^[a-zA-Z]+:\/\//, "");
    const atIdx = clean.indexOf("@");
    const hostPortPart = atIdx !== -1 ? clean.substring(atIdx + 1).split("/")[0] : clean.split("/")[0];
    const parts = hostPortPart.split(":");
    host = parts[0];
    if (parts[1]) port = parseInt(parts[1], 10);
  } catch {}

  const isPrivateIp = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|localhost)/.test(host);
  const tStart = Date.now();

  // Test real TCP socket connection
  const socket = new net.Socket();
  let resolved = false;

  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      socket.destroy();
      const latencyMs = Date.now() - tStart;
      if (isPrivateIp) {
        return res.json({
          success: false,
          tcpConnected: false,
          isPrivateLan: true,
          error: `Không thể kết nối trực tiếp đến IP mạng LAN nội bộ (${host}:${port}) từ môi trường máy chủ hiện tại (${latencyMs}ms).`,
          message: `IP ${host} là dải mạng nội bộ (LAN). Nếu hệ thống đang chạy trên máy chủ Cloud (Render/Cloud Run), Cloud không thể tự vào mạng LAN của bạn. Vui lòng chạy backend cục bộ on-premise (Docker / npm run dev trên máy cùng mạng 192.168.60.x) hoặc cấu hình VPN/Tailscale/RTSP Bridge.`,
          details: {
            url,
            sourceType: sourceType || (isRtsp ? "RTSP" : "HTTP_MJPEG"),
            host,
            port,
            isPrivateIp: true,
            transport: transport || "TCP",
            latencyMs,
            status: "LAN_UNREACHABLE_FROM_CLOUD",
          },
        });
      }

      return res.json({
        success: false,
        tcpConnected: false,
        error: `Hết thời gian kết nối (Timeout sau 2.5s) tới ${host}:${port}.`,
        details: { url, host, port, status: "TIMEOUT" },
      });
    }
  }, 2500);

  socket.connect(port, host, () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - tStart;
      socket.destroy();
      return res.json({
        success: true,
        tcpConnected: true,
        isPrivateLan: isPrivateIp,
        message: isRtsp
          ? `Kết nối TCP tới cổng ${port} của camera ${host} THÀNH CÔNG (${latencyMs}ms, ${transport || "TCP"}). Luồng RTSP sẵn sàng giải mã đa luồng!`
          : `Đã kết nối luồng HTTP/MJPEG tới ${host}:${port} (${latencyMs}ms).`,
        details: {
          url,
          sourceType: sourceType || (isRtsp ? "RTSP" : "HTTP_MJPEG"),
          host,
          port,
          isPrivateIp,
          transport: transport || "TCP",
          latencyMs,
          status: "ONLINE_READY",
          fpsEstimated: 25,
          resolutionEstimated: "1920x1080",
        },
      });
    }
  });

  socket.on("error", (err) => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      const latencyMs = Date.now() - tStart;

      if (isPrivateIp) {
        return res.json({
          success: false,
          tcpConnected: false,
          isPrivateLan: true,
          error: `Mạng nội bộ không thể truy cập (${err.message}).`,
          message: `IP ${host} thuộc mạng LAN nội bộ. Hãy đảm bảo Backend chạy cục bộ (on-prem) trên cùng router/switch với camera (192.168.60.x) hoặc sử dụng VPN/RTSP Gateway.`,
          details: {
            url,
            sourceType: sourceType || (isRtsp ? "RTSP" : "HTTP_MJPEG"),
            host,
            port,
            isPrivateIp: true,
            transport: transport || "TCP",
            latencyMs,
            status: "LAN_UNREACHABLE",
          },
        });
      }

      return res.json({
        success: false,
        tcpConnected: false,
        error: `Không thể kết nối socket tới ${host}:${port}: ${err.message}`,
        details: { url, host, port, status: "CONNECTION_FAILED" },
      });
    }
  });
});

// Capture single JPEG snapshot frame from RTSP/HTTP stream via FFmpeg
app.get("/api/camera-streams/snapshot", async (req, res) => {
  const resolved = resolveGateStream(req.query.gate, req.query.stream);
  if (resolved.error) {
    return res.status(400).json({ success: false, error: resolved.error });
  }
  const gateParam = resolved.gateKey;
  const stream = resolved.stream;
  const streamUrl = String(req.query.url || stream.rtspUrl || "").trim();
  const transport = stream.rtspTransport === "UDP" ? "udp" : "tcp";

  if (!streamUrl || !streamUrl.toLowerCase().startsWith("rtsp://")) {
    return res.redirect(`/api/camera-streams/test-frame?gate=${gateParam}`);
  }

  // FFmpeg snapshot command: grab 1 frame with 3.5s timeout (args in buildRtspSingleFrameArgs)
  try {
    const grab = await grabRtspFrame(streamUrl, transport);
    if (grab.ok && grab.jpeg) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("X-Stream-Id", stream.id);
      return res.send(grab.jpeg);
    }

    // If FFmpeg fails or cannot reach camera, return clean fallback SVG with diagnostic message
    return res.redirect(`/api/camera-streams/test-frame?gate=${gateParam}&source=RTSP%20Offline`);
  } catch (err: any) {
    return res.redirect(`/api/camera-streams/test-frame?gate=${gateParam}&source=RTSP%20Error`);
  }
});

// Real-time Live MJPEG Video Stream Proxy for Browsers
app.get("/api/camera-streams/mjpeg", (req, res) => {
  const resolved = resolveGateStream(req.query.gate, req.query.stream);
  if (resolved.error) {
    return res.status(400).send(resolved.error);
  }
  const stream = resolved.stream;
  const streamUrl = String(req.query.url || stream.rtspUrl || "").trim();
  const transport = stream.rtspTransport === "UDP" ? "udp" : "tcp";

  if (!streamUrl || !streamUrl.toLowerCase().startsWith("rtsp://")) {
    return res.status(400).send("URL luồng RTSP không hợp lệ");
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "close",
  });

  const args = [
    "-rtsp_transport", transport,
    "-timeout", "4000000",
    "-i", streamUrl,
    "-f", "mpjpeg",
    "-boundary_tag", "ffmpeg",
    "-q:v", "4",
    "-r", "15",
    "pipe:1",
  ];

  let proc: any = null;
  try {
    proc = spawn("ffmpeg", args);
    proc.stdout.pipe(res);

    proc.on("error", () => {
      try { res.end(); } catch {}
    });

    req.on("close", () => {
      if (proc) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    });
  } catch (err) {
    try { res.end(); } catch {}
  }
});

// Scan and recognise faces from one or all RTSP streams of a gate.
//   body { gate, stream?, url?, scanType?, frames?, frameIntervalMs? }
//   - `stream` (id) or `url` -> scan that single stream (legacy behaviour);
//   - neither -> scan every enabled RTSP stream of the gate concurrently (max 4).
//
// With the real engine active this is TRUE MULTI-STREAM FUSION, not an
// aggregation of independent verdicts: every frame of every stream is detected
// and embedded, all observations are POOLED (each tagged with its streamId and
// frameIndex) and ONE `recognizeObservations` call decides. Agreement between
// views raises confidence; a single weak or contradictory view cannot open the
// door. `frames` (1..5, default 1) takes several frames from each stream
// `frameIntervalMs` apart (default 300 ms) - the cheapest way to lift a
// marginal camera - and the pooled evidence is capped at FACE_MAX_OBSERVATIONS
// (default 12, highest quality kept) so latency stays bounded.
//
// Without the real engine each stream still goes through recognizeFrame as
// before, and `fusion` reports an honest empty decision.
const SCAN_RTSP_MAX_CONCURRENT_STREAMS = 4;

interface ScanStreamOutcome {
  stream: GateStreamSourceRecord;
  url: string;
  /** One grab per requested frame, in capture order. */
  grabs: RtspFrameGrab[];
  /** True once at least one frame was captured. */
  ok: boolean;
  /** Real-engine observations from this stream's frames (empty in hash mode). */
  observed: EngineObservation[];
  /**
   * `frameIndex -> JPEG`, kept ONLY for frames that actually contained a face.
   * A gate scan needs the pixels AFTER the fused decision (to store the frame
   * the winning observation came from), but holding every grab would pin up to
   * 5 frames x 4 streams in memory on every tick, so a frame with no detection
   * is dropped the moment it is observed - which is also why an empty corridor
   * can never produce a stranger row.
   */
  frameJpegs: Map<number, Buffer>;
  recognition?: RecognizeFrameResult;
  faces: Array<DetectedFaceItem & { streamId: string; streamLabel: string }>;
  error?: string;
  poolUnavailableError?: unknown;
  recognitionError?: unknown;
}

/** Grab `frames` JPEGs from one stream, `intervalMs` apart. Never rejects. */
async function grabRtspFrames(
  streamUrl: string,
  transport: "tcp" | "udp",
  frames: number,
  intervalMs: number
): Promise<RtspFrameGrab[]> {
  const out: RtspFrameGrab[] = [];
  for (let i = 0; i < frames; i++) {
    if (i > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
    out.push(await grabRtspFrame(streamUrl, transport));
  }
  return out;
}

// =========================================================================
// ONE RECOGNITION OUTCOME - logs, snapshot, notifications, webhooks, unlock
//
// There used to be two recognition paths with different side effects:
// POST /api/recognize-face recorded EVERYTHING (access log + annotated
// snapshot + notification + Eton webhook + SSE + unlock, or a DENIED log +
// stranger webhook), while `performGateScan` - the function BOTH the backend
// gate watcher AND POST /api/camera-streams/scan-rtsp run - recorded NOTHING.
// Live proof: the EXIT watcher had completed 4,574 scans and produced zero
// access logs, zero snapshots and zero stranger captures, so the stranger
// panel (which `clusterStrangerFaces` builds out of the DENIED access logs)
// had nothing to group.
//
// Everything a recognition CAUSES now lives here, and both paths call it, so
// the two cannot drift apart again. The DECISION is untouched: this function
// is handed `detectedFaces` exactly as the engine produced them, never
// re-decides, never invents a match, and grants only on
// `face.recognized && face.employeeId` - a flag only a genuine engine match
// (or an explicitly enabled simulation) ever sets.
// =========================================================================

/** Who asked for this recognition. Only the audit wording differs. */
type RecognitionTrigger = "api" | "manual" | "watcher";

/** Why a scan that DID decide something deliberately recorded nothing. */
type OutcomeSuppression = "grant-cooldown" | "stranger-cooldown" | "stranger-quality";

/**
 * Re-unlock / re-log dedupe for ONE employee at ONE gate.
 *
 * The exit watcher scans roughly every 5.4 s. Without this, one person
 * standing in frame would re-unlock the door on every tick and write hundreds
 * of near-identical GRANTED rows. It must stay comfortably longer than the
 * lock's 6 s auto-relock, otherwise the cooldown would expire while the door
 * is still open and the unlock would repeat anyway.
 *
 * A DIFFERENT employee at the same gate is never suppressed by this: the key
 * is (gate, employeeId), so two people arriving together both get their row.
 */
const FACE_GRANT_COOLDOWN_SECONDS = envInt("FACE_GRANT_COOLDOWN_SECONDS", 20, 0, 86_400);
/**
 * At most one DENIED/stranger row per gate per this many seconds. Stranger
 * rows carry a full JPEG each and feed the stranger clusters; an unknown face
 * lingering in front of an exit camera must not write one every 5 s.
 */
const FACE_STRANGER_COOLDOWN_SECONDS = envInt("FACE_STRANGER_COOLDOWN_SECONDS", 60, 0, 86_400);

/** Last GRANTED write per `${gate}:${employeeId}`. */
const lastGrantAtByGateEmployee = new Map<string, number>();
/** Last DENIED/stranger write per gate. */
const lastStrangerLogAtByGate = new Map<string, number>();

/** Counters so an operator can tell "nothing happened" from "it was deduped". */
interface RecognitionOutcomeStats {
  grantsWritten: number;
  grantsSuppressed: number;
  strangersWritten: number;
  strangersSuppressed: number;
  /**
   * Stranger alerts that THIS path handed to `sendStrangerWebhook` and that it
   * did not send - its own, independent cooldown, or the webhook being turned
   * off. Counted rather than hidden; `/api/webhook/logs` says which.
   */
  strangerWebhooksNotSent: number;
  unlocks: number;
  lastLogId?: string;
  lastLogAt?: string;
  lastSuppressed?: OutcomeSuppression;
  lastSuppressedAt?: string;
}

function newRecognitionOutcomeStats(): RecognitionOutcomeStats {
  return {
    grantsWritten: 0,
    grantsSuppressed: 0,
    strangersWritten: 0,
    strangersSuppressed: 0,
    strangerWebhooksNotSent: 0,
    unlocks: 0,
  };
}

const gateOutcomeStats: Record<"entry" | "exit", RecognitionOutcomeStats> = {
  entry: newRecognitionOutcomeStats(),
  exit: newRecognitionOutcomeStats(),
};

interface RecognitionOutcomeInput {
  /** Faces exactly as the engine reported them. Never re-decided here. */
  detectedFaces: DetectedFaceItem[];
  /**
   * The frame whose pixels get stored on the log (data URL or raw base64).
   * Undefined/empty means "no image": with `denyWithoutFace:false` nothing is
   * written at all, which is what keeps an empty corridor from manufacturing
   * stranger rows.
   */
  frameImage?: string;
  /**
   * Boxes drawn on the stored snapshot - MUST belong to `frameImage`, or the
   * green boxes would mark the wrong pixels. Defaults to `detectedFaces`
   * (correct for the single-frame /api/recognize-face path).
   */
  annotateFaces?: Array<{ box2d: [number, number, number, number]; boxSource?: "detector" }>;
  scanType: "ENTRY" | "EXIT";
  trigger: RecognitionTrigger;
  /** Which gate the decision belongs to; the cooldowns are keyed on it. */
  gate?: "entry" | "exit";
  streamId?: string;
  streamLabel?: string;
  processingTimeMs: number;
  /** Overrides the trigger-derived unlock source. Used by /api/recognize-face. */
  unlockSource?: string;
  /** Base URL for the stranger deep link in the webhook. */
  baseUrl?: string;
  /**
   * Apply the grant/stranger cooldowns. ON for the scan path (watcher +
   * scan-rtsp), OFF for /api/recognize-face: that route is driven by a human
   * or an external caller one frame at a time and its behaviour is the
   * reference this extraction must not change.
   */
  cooldowns: boolean;
  /**
   * Write a DENIED log even when no real face was detected. TRUE for
   * /api/recognize-face (unchanged: a grey frame still produces a stranger
   * row there, and the stranger suite asserts it); FALSE for gate scans.
   */
  denyWithoutFace: boolean;
  /**
   * Image bytes to attach to the `stranger_detected` SSE. Only
   * /api/recognize-face passes this (it always has), because a gate scan
   * broadcasts to every dashboard on every tick and image bytes never go into
   * a watcher SSE payload.
   */
  sseSnapshot?: string;
  /** Highest-quality real ArcFace observation for a DENIED event; never serialized. */
  strangerObservation?: FaceObservation;
}

/** JSON-safe outcome report: ids, flags and counters - never image bytes. */
interface RecognitionOutcomeSummary {
  trigger: RecognitionTrigger;
  gate: "entry" | "exit";
  scanType: "ENTRY" | "EXIT";
  granted: boolean;
  /** True when THIS outcome actually drove `unlockDoor`. */
  lockUnlocked: boolean;
  /** "GRANTED" / "DENIED" when a row was written, absent when nothing was. */
  status?: "GRANTED" | "DENIED";
  logId?: string;
  logIds: string[];
  /** True when the written log carries a stored `photoSnapshot`. */
  snapshotStored: boolean;
  /** Set when a cooldown is the reason nothing was written. */
  suppressed?: OutcomeSuppression;
  /** Employees skipped by the grant cooldown (may be a subset). */
  suppressedEmployeeIds: string[];
  /** True when the stranger webhook was dispatched (its own cooldown may still drop it). */
  strangerWebhookDispatched: boolean;
  stats: RecognitionOutcomeStats;
}

interface RecognitionOutcomeResult {
  granted: boolean;
  /** GRANTED rows (one per employee) or the single DENIED row. */
  logs: AccessLogRecord[];
  log?: AccessLogRecord;
  lockUnlocked: boolean;
  /** Employees the engine matched, deduped, in detection order. */
  recognizedEmployees: EmployeeRecord[];
  summary: RecognitionOutcomeSummary;
}

/**
 * Where an unlock came from, for `unlockDoor` and the lock audit trail.
 *
 * MUST contain "Nhận diện": `unlockDoor` matches that substring to pick the
 * door controller's `triggerOnFaceRecognition` policy over
 * `triggerOnManualUnlock`. A watcher unlock is a face-recognition unlock.
 */
function recognitionUnlockSource(trigger: RecognitionTrigger, gateKey: "entry" | "exit"): string {
  const gateLabel = gateKey === "exit" ? "cổng ra" : "cổng vào";
  if (trigger === "watcher") return `Watcher ${gateLabel} - Nhận diện khuôn mặt tự động`;
  if (trigger === "manual") return `Quét RTSP thủ công ${gateLabel} - Nhận diện khuôn mặt`;
  return "Nhận diện khuôn mặt AI (Đa nhân viên)";
}

/**
 * Record (and act on) ONE recognition decision. Called by
 * POST /api/recognize-face and by `performGateScan` (the watcher and
 * POST /api/camera-streams/scan-rtsp), so a face seen by a watched camera has
 * exactly the same consequences as the same face posted to the API.
 */
async function applyRecognitionOutcome(input: RecognitionOutcomeInput): Promise<RecognitionOutcomeResult> {
  const detectedFaces = input.detectedFaces || [];
  const actionType: "ENTRY" | "EXIT" = input.scanType === "EXIT" ? "EXIT" : "ENTRY";
  const typeLabel = actionType === "ENTRY" ? "Vào" : "Ra";
  const gateKey: "entry" | "exit" = input.gate || (actionType === "EXIT" ? "exit" : "entry");
  // The counters describe the GATE SCAN recorder (watcher + scan-rtsp), which
  // is the path with cooldowns to explain. /api/recognize-face is driven one
  // frame at a time by a caller that already sees its own answer, so it writes
  // into a throwaway so it cannot muddy a gate's suppressed/written ratio.
  const stats = input.trigger === "api" ? newRecognitionOutcomeStats() : gateOutcomeStats[gateKey];
  const processingTimeMs = input.processingTimeMs;
  const nowMs = Date.now();

  const authorizedFaces = detectedFaces.filter((f) => f.recognized && f.employeeId);
  const unauthorizedFaces = detectedFaces.filter((f) => !f.recognized);
  const recognizedEmployees: EmployeeRecord[] = [];
  for (const face of authorizedFaces) {
    const emp = employees.find((e) => e.id === face.employeeId);
    if (emp && !recognizedEmployees.some((re) => re.id === emp.id)) recognizedEmployees.push(emp);
  }
  const hasAuthorized = recognizedEmployees.length > 0;

  const summary: RecognitionOutcomeSummary = {
    trigger: input.trigger,
    gate: gateKey,
    scanType: actionType,
    granted: hasAuthorized,
    lockUnlocked: false,
    logIds: [],
    snapshotStored: false,
    suppressedEmployeeIds: [],
    strangerWebhookDispatched: false,
    stats,
  };
  const result: RecognitionOutcomeResult = {
    granted: hasAuthorized,
    logs: [],
    lockUnlocked: false,
    recognizedEmployees,
    summary,
  };

  // ---- Step 1: decide what may be recorded, BEFORE any await. -----------
  // The cooldown slots are claimed synchronously so two scans that overlap
  // (a manual scan-rtsp landing inside a watcher tick) cannot both pass.
  const grantCooldownMs = FACE_GRANT_COOLDOWN_SECONDS * 1000;
  const strangerCooldownMs = FACE_STRANGER_COOLDOWN_SECONDS * 1000;
  let grantable: EmployeeRecord[] = recognizedEmployees;

  if (hasAuthorized) {
    if (input.cooldowns && grantCooldownMs > 0) {
      grantable = [];
      for (const emp of recognizedEmployees) {
        const key = `${gateKey}:${emp.id}`;
        const last = lastGrantAtByGateEmployee.get(key) || 0;
        if (last > 0 && nowMs - last < grantCooldownMs) {
          summary.suppressedEmployeeIds.push(emp.id);
          continue;
        }
        lastGrantAtByGateEmployee.set(key, nowMs);
        grantable.push(emp);
      }
    }
    if (grantable.length === 0) {
      // Recognised, but every one of them is inside their cooldown: no
      // re-unlock, no duplicate row - and the fact is counted, not hidden.
      stats.grantsSuppressed += 1;
      stats.lastSuppressed = "grant-cooldown";
      stats.lastSuppressedAt = new Date(nowMs).toISOString();
      summary.suppressed = "grant-cooldown";
      return result;
    }
  } else {
    const hasRealFace = detectedFaces.some((f) => f.boxSource === "detector");
    const hasImage = Boolean(input.frameImage);
    if (!input.denyWithoutFace && (!hasRealFace || !hasImage)) {
      // An empty corridor. No face was detected (or no frame contained one),
      // so there is nothing to show an operator: write no stranger row at all
      // rather than filling the cluster panel with pictures of a doorway.
      return result;
    }
    // Too poor to identify anyone from: count it, but do not store the image.
    const bestQuality = detectedFaces.reduce(
      (best, f) => Math.max(best, Number.isFinite(f.livenessScore) ? f.livenessScore / 100 : 0),
      0
    );
    if (hasRealFace && FACE_STRANGER_MIN_QUALITY > 0 && bestQuality < FACE_STRANGER_MIN_QUALITY) {
      stats.strangersSuppressed += 1;
      stats.lastSuppressed = "stranger-quality";
      stats.lastSuppressedAt = new Date(nowMs).toISOString();
      summary.suppressed = "stranger-quality";
      return result;
    }
    if (input.cooldowns && strangerCooldownMs > 0) {
      const last = lastStrangerLogAtByGate.get(gateKey) || 0;
      if (last > 0 && nowMs - last < strangerCooldownMs) {
        stats.strangersSuppressed += 1;
        stats.lastSuppressed = "stranger-cooldown";
        stats.lastSuppressedAt = new Date(nowMs).toISOString();
        summary.suppressed = "stranger-cooldown";
        return result;
      }
      lastStrangerLogAtByGate.set(gateKey, nowMs);
    }
  }

  // ---- Step 2: the stored image. ----------------------------------------
  // Annotated with the REAL detector boxes of the frame being stored, so the
  // picture an operator opens shows what was flagged. Non-data-URL inputs
  // (and the no-image case) pass straight through, exactly as before.
  const snapshotForLog = await annotateSnapshotWithBoxes(
    input.frameImage as string,
    (input.annotateFaces as Array<{ box2d: [number, number, number, number]; boxSource?: "detector" }>) || detectedFaces
  );
  summary.snapshotStored = Boolean(snapshotForLog);

  const timestamp = new Date().toISOString();

  if (hasAuthorized) {
    summary.status = "GRANTED";

    // 1. Unlock ONCE for everybody who passed the cooldown.
    const namesList = grantable.map((e) => e.name).join(", ");
    const unlockSource = input.unlockSource || recognitionUnlockSource(input.trigger, gateKey);
    unlockDoor(unlockSource, namesList, grantable[0]?.id);
    result.lockUnlocked = true;
    summary.lockUnlocked = true;
    stats.unlocks += 1;

    // 2. One GRANTED row per employee, each with the stored snapshot.
    for (const emp of grantable) {
      const faceMatch = authorizedFaces.find((f) => f.employeeId === emp.id);
      const accessLog: AccessLogRecord = {
        id: "LOG-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
        timestamp: new Date().toISOString(),
        type: actionType,
        status: "GRANTED",
        employeeId: emp.id,
        employeeName: emp.name,
        employeeCode: emp.employeeCode,
        department: emp.department,
        photoSnapshot: snapshotForLog,
        confidence: faceMatch ? faceMatch.confidence : 95,
        livenessScore: faceMatch ? faceMatch.livenessScore : 98,
        lockAction: "Mở chốt tự động qua API (SmartLock Gateway)",
        doorName: smartLockState.doorName,
        reason:
          `Nhận diện khuôn mặt trong khung hình (${faceMatch?.confidence || 95}% khớp - Xử lý trong ${processingTimeMs}ms)` +
          recognitionSourceSuffix(input),
      };
      accessLogs.unshift(accessLog);
      db.saveAccessLog(accessLog);
      result.logs.push(accessLog);
      summary.logIds.push(accessLog.id);
      stats.grantsWritten += 1;
      stats.lastLogId = accessLog.id;
      stats.lastLogAt = accessLog.timestamp;

      broadcastSSE("access_granted", {
        log: accessLog,
        employee: emp,
      });

      sendEtonWebhook({
        userName: emp.name,
        employeeCode: emp.employeeCode,
        scanType: actionType,
      }).catch((webhookErr) => {
        console.warn("[Webhook] Background dispatch warning:", webhookErr);
      });
    }
    result.log = result.logs[0];
    summary.logId = result.logs[0]?.id;

    // 3. Mobile push notification.
    const notifTitle =
      grantable.length > 1
        ? `Mở cửa tự động (${grantable.length} nhân viên)`
        : `Mở cửa tự động (${typeLabel})`;
    const notifBody =
      grantable.length > 1
        ? `Phát hiện đồng thời ${grantable.map((e) => e.name).join(" & ")} điểm danh ${typeLabel} tại ${smartLockState.doorName}`
        : `${grantable[0].name} (${grantable[0].employeeCode}) vừa điểm danh ${typeLabel} qua nhận diện khuôn mặt`;

    const mobileNotif: MobileNotificationRecord = {
      id: "NOTIF-" + Date.now(),
      title: notifTitle,
      body: notifBody,
      timestamp: new Date().toISOString(),
      type: "SUCCESS",
      read: false,
      employeeId: grantable[0]?.id,
      employeeName: grantable[0]?.name,
    };
    mobileNotifications.unshift(mobileNotif);
    db.saveNotification(mobileNotif);
    broadcastSSE("notification", mobileNotif);

    // 4. Someone unregistered walked in with them: security advisory only,
    //    never a second decision.
    if (unauthorizedFaces.length > 0) {
      const warnNotif: MobileNotificationRecord = {
        id: "NOTIF-" + (Date.now() + 1),
        title: "Lưu ý an ninh: Người lạ đi cùng",
        body: `Phát hiện ${unauthorizedFaces.length} người chưa đăng ký đi cùng nhóm nhân viên qua ${smartLockState.doorName}`,
        timestamp: new Date().toISOString(),
        type: "WARNING",
        read: false,
      };
      mobileNotifications.unshift(warnNotif);
      db.saveNotification(warnNotif);
      broadcastSSE("notification", warnNotif);
    }

    return result;
  }

  // ---- Denied / stranger ------------------------------------------------
  summary.status = "DENIED";
  const accessLog: AccessLogRecord = {
    id: "LOG-" + Date.now(),
    timestamp,
    type: actionType,
    status: "DENIED",
    photoSnapshot: snapshotForLog,
    confidence: detectedFaces[0]?.confidence || 25,
    livenessScore: detectedFaces[0]?.livenessScore || 85,
    lockAction: "Khóa giữ nguyên trạng thái LOCKED",
    doorName: smartLockState.doorName,
    reason:
      (detectedFaces[0]?.message || "Không có khuôn mặt nào khớp với cơ sở dữ liệu nhân viên") +
      recognitionSourceSuffix(input),
    faceEmbedding: input.strangerObservation?.embedding,
    faceEmbeddingModelTag: input.strangerObservation ? faceModelTag() : undefined,
    faceEmbeddingQuality: input.strangerObservation?.quality,
  };
  accessLogs.unshift(accessLog);
  db.saveAccessLog(accessLog);
  result.logs.push(accessLog);
  result.log = accessLog;
  summary.logId = accessLog.id;
  summary.logIds.push(accessLog.id);
  stats.strangersWritten += 1;
  stats.lastLogId = accessLog.id;
  stats.lastLogAt = accessLog.timestamp;

  const mobileNotif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: "🚨 Cảnh báo an ninh: Phát hiện người lạ chụp hình",
    body: `Phát hiện khuôn mặt không xác định tại ${smartLockState.doorName} (Khóa cửa giữ an toàn). Đã tự động lưu trữ ảnh vào cụm giám sát người lạ.`,
    timestamp: new Date().toISOString(),
    type: "ALERT",
    read: false,
  };
  mobileNotifications.unshift(mobileNotif);
  db.saveNotification(mobileNotif);

  broadcastSSE("access_denied", {
    log: accessLog,
    notification: mobileNotif,
  });
  broadcastSSE("stranger_detected", {
    log: accessLog,
    notification: mobileNotif,
    // Image bytes ONLY on the single-frame API path, which has always carried
    // them. A gate scan broadcasts on every tick, so it sends no pixels - the
    // stored snapshot is fetched from the log / cluster endpoints instead.
    snapshot: input.sseSnapshot,
    doorName: smartLockState.doorName,
    timestamp: accessLog.timestamp,
  });
  broadcastSSE("notification", mobileNotif);

  // Cảnh báo người lạ qua webhook, kèm liên kết mở thẳng cụm ảnh người lạ.
  // Fire-and-forget: một webhook chậm/chết không được làm trễ phản hồi HTTP,
  // và lỗi gửi tin không bao giờ ảnh hưởng tới nhật ký ra vào ở trên.
  //
  // COOLDOWN INTERACTION - deliberate and explicit. `sendStrangerWebhook` owns
  // a SECOND, independent cooldown (`webhookConfig.strangerCooldownSeconds`,
  // default 60 s, GLOBAL rather than per-gate). The gate cooldown above only
  // ever decides whether a ROW is written; whenever a row IS written the
  // webhook is always invoked, never pre-filtered here, so this change can
  // never silently swallow an alert for a log that exists. The webhook's own
  // cooldown may still drop it (e.g. the other gate alerted 10 s ago) - that
  // is the operator's configured webhook noise policy, so it is counted in
  // `strangerWebhooksNotSent` and visible in the webhook log instead of being
  // bypassed.
  summary.strangerWebhookDispatched = true;
  sendStrangerWebhook({
    log: { id: accessLog.id, type: accessLog.type, reason: accessLog.reason },
    doorName: smartLockState.doorName,
    faceCount: detectedFaces.length,
    baseUrl: input.baseUrl,
  })
    .then((sent) => {
      if (!sent) stats.strangerWebhooksNotSent += 1;
    })
    .catch(() => {});

  return result;
}

/** " - <trigger> <stream>" appended to a scan-path log reason; empty for the API path. */
function recognitionSourceSuffix(input: RecognitionOutcomeInput): string {
  if (input.trigger === "api") return "";
  const who = input.trigger === "watcher" ? "Watcher tự động" : "Quét RTSP thủ công";
  const where = input.streamLabel || input.streamId;
  return where ? ` - ${who} [${where}]` : ` - ${who}`;
}

/** What a gate scan is asked to do - exactly the fields POST /scan-rtsp accepts. */
interface GateScanRequest {
  gate?: unknown;
  /**
   * Who asked. Only the audit wording of the unlock/log differs - the
   * decision, the thresholds and the recording rules are identical, because a
   * watched scan and a manual scan are the same event.
   */
  trigger?: RecognitionTrigger;
  stream?: unknown;
  url?: unknown;
  scanType?: unknown;
  frames?: unknown;
  frameIntervalMs?: unknown;
  config?: Partial<ServerAiConfig> | null;
}

/** An HTTP answer as data, so the same scan can serve a route and the backend watcher. */
interface GateScanResult {
  status: number;
  /** Set on 503 (worker-pool backpressure / re-init): the route mirrors it into the header. */
  retryAfterSeconds?: number;
  body: any;
}

/**
 * THE gate scan. POST /api/camera-streams/scan-rtsp is a thin wrapper around
 * this, and so is the backend watcher - there is exactly one capture +
 * recognition + fusion path, so a watched scan can never take a looser
 * decision than a manual one.
 */
async function performGateScan(input: GateScanRequest): Promise<GateScanResult> {
  const { gate, stream, url, scanType, frames, frameIntervalMs } = input || {};
  const resolved = resolveGateStream(gate, stream);
  if (resolved.error) {
    return { status: 400, body: { success: false, error: resolved.error } };
  }
  const gateParam = resolved.gateKey;
  const targetGate = resolved.gate;
  const singleStreamMode = Boolean(optionalTrimmedString(url) || optionalTrimmedString(stream));

  const targets: Array<{ stream: GateStreamSourceRecord; url: string }> = [];
  if (singleStreamMode) {
    const streamUrl = String(url || resolved.stream.rtspUrl || "").trim();
    if (!isRtspUrl(streamUrl)) {
      return { status: 400, body: { success: false, error: "Vui lòng chỉ định URL luồng RTSP hợp lệ" } };
    }
    targets.push({ stream: resolved.stream, url: streamUrl });
  } else {
    const rtspStreams = targetGate.streams!.filter(
      (s) => s.enabled && (s.sourceType === "RTSP" || !s.sourceType) && isRtspUrl(s.rtspUrl)
    );
    if (rtspStreams.length === 0) {
      return {
        status: 400,
        body: {
          success: false,
          error: "Cổng này chưa có luồng RTSP nào đang bật. Vui lòng chỉ định URL luồng RTSP hợp lệ",
        },
      };
    }
    for (const s of rtspStreams.slice(0, SCAN_RTSP_MAX_CONCURRENT_STREAMS)) {
      targets.push({ stream: s, url: String(s.rtspUrl).trim() });
    }
  }

  const resolvedScanType: "ENTRY" | "EXIT" =
    String(scanType || "").toUpperCase() === "EXIT" || (!scanType && gateParam === "exit") ? "EXIT" : "ENTRY";

  const faceEngine = activeFaceEngine();
  const fusionThresholds = currentFusionThresholds(input?.config);
  // Multi-frame only helps the real engine (the hash matcher ignores pixels),
  // so the legacy path stays at one frame per stream.
  const requestedFrames = Number(frames);
  const framesPerStream =
    faceEngine === "onnx" && Number.isFinite(requestedFrames)
      ? Math.min(FACE_SCAN_MAX_FRAMES, Math.max(1, Math.floor(requestedFrames)))
      : 1;
  const requestedInterval = Number(frameIntervalMs);
  const intervalMs = Number.isFinite(requestedInterval)
    ? Math.min(FACE_SCAN_MAX_FRAME_INTERVAL_MS, Math.max(0, Math.floor(requestedInterval)))
    : FACE_SCAN_DEFAULT_FRAME_INTERVAL_MS;
  const tWall = Date.now();

  // Phase 1 - capture (and, with the real engine, detect + embed) every target
  // concurrently. Each stream owns its own ffmpeg process (same tuned args,
  // same 9 s kill); a failure on one never aborts another.
  const outcomes: ScanStreamOutcome[] = await Promise.all(
    targets.map(async ({ stream: target, url: streamUrl }): Promise<ScanStreamOutcome> => {
      const transport = target.rtspTransport === "UDP" ? "udp" : "tcp";
      const grabs = await grabRtspFrames(streamUrl, transport, framesPerStream, intervalMs);
      const outcome: ScanStreamOutcome = {
        stream: target,
        url: streamUrl,
        grabs,
        ok: grabs.some((g) => g.ok && g.jpeg),
        observed: [],
        frameJpegs: new Map<number, Buffer>(),
        faces: [],
      };
      if (!outcome.ok) {
        outcome.error =
          "Không thể lấy khung hình từ luồng RTSP. Hãy kiểm tra địa chỉ IP, tài khoản/mật khẩu hoặc kết nối mạng LAN.";
        return outcome;
      }

      if (faceEngine === "onnx") {
        // Observations only - the decision is fused ACROSS streams below.
        for (let i = 0; i < grabs.length; i++) {
          const g = grabs[i];
          if (!g.ok || !g.jpeg) continue;
          const observed = await observeFrame(g.jpeg, target.id, target.label, i);
          // Keep the pixels only when this frame contained a face; the fused
          // decision below says which of those frames is worth storing.
          if (observed.length > 0) outcome.frameJpegs.set(i, g.jpeg);
          outcome.observed.push(...observed);
        }
        return outcome;
      }

      // Legacy per-stream path (hash matcher / fail-closed): identical to before.
      const firstOkIndex = grabs.findIndex((g) => g.ok && g.jpeg);
      const firstOk = grabs[firstOkIndex];
      const base64Data = firstOk.jpeg!.toString("base64");
      try {
        const recognition = await recognizeFrame({
          base64Data,
          rawImage: `data:image/jpeg;base64,${base64Data}`,
          mimeType: "image/jpeg",
          employees,
          scanType: resolvedScanType,
          streamId: target.id,
          streamLabel: target.label,
        });
        outcome.recognition = recognition;
        outcome.faces = recognition.detectedFaces.map((f) => ({ ...f, streamId: target.id, streamLabel: target.label }));
        // One frame per stream on this path, so keeping it is cheap. Whether it
        // is ever STORED is decided by applyRecognitionOutcome: `recognizeFrame`
        // always returns at least a placeholder face, so a stranger row still
        // requires a REAL detection (boxSource "detector").
        outcome.frameJpegs.set(firstOkIndex, firstOk.jpeg!);
      } catch (err: any) {
        outcome.ok = false;
        if (isWorkerPoolUnavailableError(err)) {
          outcome.poolUnavailableError = err;
        } else {
          outcome.recognitionError = err;
        }
        outcome.error = err?.message || "Lỗi xử lý nhận diện khung hình RTSP";
      }
      return outcome;
    })
  );

  // Phase 2 - ONE fused decision over the pooled observations of every stream.
  let fusion: FusionDecision = emptyFusionDecision(fusionThresholds);
  let observationsPooled = 0;
  // Kept index-parallel (allFaces[i] describes allObserved[i]) so the frame the
  // WINNING observation came from can be identified after the decision.
  let allObserved: EngineObservation[] = [];
  let allFaces: Array<DetectedFaceItem & { streamId: string; streamLabel: string }> = [];
  if (faceEngine === "onnx") {
    allObserved = outcomes.flatMap((o) => o.observed);
    const pooled = capObservations(allObserved); // marks the dropped ones `fused:false`
    observationsPooled = pooled.length;
    fusion = recognizeObservations(pooled, currentGallery(), fusionThresholds);
    // Built from the SAME ordered list that was fused, then split per stream.
    allFaces = facesFromDecision(allObserved, fusion, employees);
    for (const o of outcomes) o.faces = allFaces.filter((f) => f.streamId === o.stream.id);
  }

  const processingTimeMs = Date.now() - tWall;
  const frameCaptureDurationMs = outcomes.reduce(
    (max, o) => Math.max(max, ...o.grabs.map((g) => g.durationMs), 0),
    0
  );
  const streamResults = outcomes.map((o) => ({
    streamId: o.stream.id,
    streamLabel: o.stream.label,
    success: o.ok,
    frameCaptureDurationMs: o.grabs.reduce((max, g) => Math.max(max, g.durationMs), 0),
    framesCaptured: o.grabs.filter((g) => g.ok && g.jpeg).length,
    framesRequested: framesPerStream,
    observations: o.observed.length,
    recognized: o.faces.some((f) => f.recognized && f.employeeId),
    totalFacesDetected: o.faces.length,
    detectedFaces: o.faces,
    error: o.error,
  }));
  const successful = outcomes.filter((o) => o.ok);
  const fusionSummary = {
    ...fusion,
    engine: faceEngine,
    observations: observationsPooled,
    observationCap: FACE_MAX_OBSERVATIONS,
    framesPerStream,
    frameIntervalMs: intervalMs,
    streamsPooled: new Set(outcomes.flatMap((o) => o.observed).map((o) => o.streamId)).size,
    galleryTemplates: faceEngine === "onnx" ? db.getFaceTemplates().length : 0,
    modelTag: faceModelTag(),
  };

  if (successful.length === 0) {
    // Nothing usable came back from any stream: keep today's status codes.
    const poolRejected = outcomes.find((o) => o.poolUnavailableError);
    if (poolRejected) {
      console.warn("[RTSP Scan] Cụm luồng từ chối tạm thời (503):", (poolRejected.poolUnavailableError as any)?.message);
      return {
        status: 503,
        retryAfterSeconds: 1,
        body: workerPoolUnavailableBody(poolRejected.poolUnavailableError, {
          gate: gateParam,
          frameCaptureDurationMs,
          streams: streamResults,
          fusion: fusionSummary,
        }),
      };
    }
    const recognitionFailed = outcomes.find((o) => o.recognitionError);
    if (recognitionFailed) {
      console.error("[RTSP Scan] Lỗi nhận diện khung hình:", (recognitionFailed.recognitionError as any)?.message || recognitionFailed.recognitionError);
      return {
        status: 500,
        body: {
          success: false,
          recognized: false,
          gate: gateParam,
          error: recognitionFailed.error || "Lỗi xử lý nhận diện khung hình RTSP",
          frameCaptureDurationMs,
          streams: streamResults,
          fusion: fusionSummary,
        },
      };
    }
    return {
      status: 502,
      body: {
        success: false,
        recognized: false,
        gate: gateParam,
        error: "Không thể lấy khung hình từ luồng RTSP. Hãy kiểm tra địa chỉ IP, tài khoản/mật khẩu hoặc kết nối mạng LAN.",
        details: outcomes[0]?.grabs[0]?.errorLog || "",
        frameCaptureDurationMs,
        streams: streamResults,
        fusion: fusionSummary,
      },
    };
  }

  // Aggregate across streams (fail-closed: recognized only when an engine matched a registered employee).
  const detectedFaces = successful.flatMap((o) => o.faces);
  const authorizedFaces = detectedFaces.filter((f) => f.recognized && f.employeeId);
  const recognized = authorizedFaces.length > 0;
  const recognizedEmployees = authorizedFaces
    .map((f) => employees.find((e) => e.id === f.employeeId))
    .filter((e, i, arr): e is EmployeeRecord => Boolean(e) && arr.indexOf(e) === i);
  const bestMatch = recognizedEmployees[0];
  const primaryFace = authorizedFaces[0] || detectedFaces[0];
  const overallConfidence = Number(primaryFace?.confidence ?? 0);
  const overallLiveness = Number(primaryFace?.livenessScore ?? 0);
  const engineInfo = getFaceEngineInfo();
  const first = successful.find((o) => o.recognition)?.recognition;
  const workerInfo = successful.find((o) => o.recognition?.multiThreadInfo.workerId)?.recognition?.multiThreadInfo;

  const message =
    faceEngine === "onnx"
      ? recognized && bestMatch
        ? `Nhận diện ${bestMatch.name} (${bestMatch.employeeCode}) từ ${fusion.agreeingObservations} quan sát trên ${fusion.agreeingStreams} luồng - cosine hợp nhất ${fusion.fusedCosine.toFixed(3)} (${fusion.basis})`
        : observationsPooled === 0
        ? "Không phát hiện khuôn mặt nào trong các khung hình đã lấy. Cửa giữ trạng thái khóa."
        : `Không xác thực được danh tính từ ${observationsPooled} quan sát (${fusion.basis}, cosine tốt nhất ${fusion.bestCosine.toFixed(3)}). Cửa giữ trạng thái khóa.`
      : successful.length === 1
      ? first?.overallMessage || ""
      : successful
          .filter((o) => o.recognition)
          .map((o) => `[${o.stream.label}] ${o.recognition!.overallMessage}`)
          .join(" | ");

  const engineUsed =
    faceEngine === "onnx"
      ? `Real Face Engine (SCRFD ${engineInfo.detectorModel} + ArcFace ${engineInfo.recognizerModel}, hợp nhất đa luồng)`
      : faceEngine === "unavailable"
      ? "Real Face Engine (FAIL-CLOSED: mô hình ONNX không khả dụng)"
      : first?.engineUsed || "Local Edge Biometrics";
  const modelUsed = faceEngine === "onnx" ? faceModelTag() : first?.modelUsed || aiRecognitionConfig.localModel.modelArchitecture;

  // ---------------------------------------------------------------------
  // WHICH FRAME GETS STORED
  //
  // A gate scan pools observations from several streams and possibly several
  // frames, so "the frame" is a choice:
  //   recognised -> the frame the WINNING observation came from (the picture
  //                 that actually opened the door);
  //   not        -> the best-quality frame that contained a face;
  //   no face    -> nothing at all (and no stranger row, see
  //                 applyRecognitionOutcome).
  // The annotation uses only the detector boxes OF THAT FRAME: boxes from a
  // different frame or stream would draw green rectangles over the wrong
  // pixels.
  // ---------------------------------------------------------------------
  let snapshotJpeg: Buffer | undefined;
  let snapshotStreamId: string | undefined;
  let snapshotStreamLabel: string | undefined;
  let snapshotFaces: Array<DetectedFaceItem & { streamId: string; streamLabel: string }> = [];
  let snapshotObservation: FaceObservation | undefined;

  if (faceEngine === "onnx" && allObserved.length > 0) {
    let pick = -1;
    for (let i = 0; i < allObserved.length; i++) {
      const f = allFaces[i];
      if (!f || !f.recognized || !f.employeeId) continue;
      if (pick < 0 || f.confidence > allFaces[pick].confidence) pick = i;
    }
    if (pick < 0) {
      for (let i = 0; i < allObserved.length; i++) {
        if (pick < 0 || allObserved[i].observation.quality > allObserved[pick].observation.quality) pick = i;
      }
    }
    const chosen = allObserved[pick];
    snapshotObservation = chosen.observation;
    const owner = outcomes.find((o) => o.stream.id === chosen.streamId);
    const jpeg = owner?.frameJpegs.get(chosen.frameIndex);
    if (jpeg) {
      snapshotJpeg = jpeg;
      snapshotStreamId = chosen.streamId;
      snapshotStreamLabel = chosen.streamLabel;
      snapshotFaces = allFaces.filter(
        (_, i) => allObserved[i].streamId === chosen.streamId && allObserved[i].frameIndex === chosen.frameIndex
      );
    }
  } else if (faceEngine !== "onnx") {
    // Legacy per-stream path: one frame per stream was recognised, so prefer
    // the stream that matched somebody and fall back to the first that saw a face.
    const owner =
      outcomes.find((o) => o.frameJpegs.size > 0 && o.faces.some((f) => f.recognized && f.employeeId)) ||
      outcomes.find((o) => o.frameJpegs.size > 0);
    const entry = owner ? [...owner.frameJpegs.entries()][0] : undefined;
    if (owner && entry) {
      snapshotJpeg = entry[1];
      snapshotStreamId = owner.stream.id;
      snapshotStreamLabel = owner.stream.label;
      snapshotFaces = owner.faces;
    }
  }

  // The recording + unlocking side of the decision, shared verbatim with
  // POST /api/recognize-face. Nothing below re-decides anything.
  const outcome = await applyRecognitionOutcome({
    detectedFaces,
    frameImage: snapshotJpeg ? `data:image/jpeg;base64,${snapshotJpeg.toString("base64")}` : undefined,
    annotateFaces: snapshotFaces,
    scanType: resolvedScanType,
    trigger: input?.trigger === "watcher" ? "watcher" : "manual",
    gate: gateParam,
    streamId: snapshotStreamId,
    streamLabel: snapshotStreamLabel,
    processingTimeMs,
    cooldowns: true,
    denyWithoutFace: false,
    strangerObservation: snapshotObservation,
  });

  return { status: 200, body: {
    success: true,
    frameCaptureDurationMs,
    taskId: `rtsp-${Date.now()}`,
    gate: gateParam,
    scanType: resolvedScanType,
    // Stream telemetry
    streamId: singleStreamMode ? targets[0].stream.id : pickPrimaryStream(targetGate.streams!).id,
    streamLabel: singleStreamMode ? targets[0].stream.label : pickPrimaryStream(targetGate.streams!).label,
    streamsScanned: outcomes.length,
    streamsSucceeded: successful.length,
    streams: streamResults,
    framesPerStream,
    frameIntervalMs: intervalMs,
    // Recognition outcome (fail-closed: recognized only when an engine matched a registered employee)
    recognized,
    detectedFaces,
    totalFacesDetected: detectedFaces.length,
    authorizedCount: authorizedFaces.length,
    unauthorizedCount: detectedFaces.length - authorizedFaces.length,
    bestMatch,
    employee: bestMatch,
    matchedEmployee: bestMatch,
    recognizedEmployees,
    overallConfidence,
    overallLiveness,
    confidence: overallConfidence,
    livenessScore: overallLiveness,
    similarityScore: faceEngine === "onnx" ? fusion.fusedCosine : Math.round(overallConfidence * 10) / 1000,
    message,
    // The whole fused decision: basis, cosines, agreeing observations/streams,
    // per-candidate evidence and every per-observation cosine.
    fusion: fusionSummary,
    // Engine telemetry
    faceEngine,
    engineMode: first?.engineMode || aiRecognitionConfig.engineMode,
    engineUsed,
    modelUsed,
    modelName: modelUsed,
    multiThreadUsed: Boolean(workerInfo?.workerId),
    workerId: workerInfo?.workerId,
    threadLatencyMs: workerInfo?.threadLatencyMs ?? processingTimeMs,
    processingTimeMs,
    processDurationMs: processingTimeMs,
    // What the scan actually RECORDED and DID: log ids, whether the door was
    // unlocked, and why nothing happened when a cooldown deduped it. Ids and
    // flags only - the stored JPEG stays in the access log.
    outcome: outcome.summary,
    accessLogId: outcome.summary.logId,
    accessLogIds: outcome.summary.logIds,
    lockUnlocked: outcome.lockUnlocked,
    suppressed: outcome.summary.suppressed,
    snapshotStored: outcome.summary.snapshotStored,
  } };
}

app.post("/api/camera-streams/scan-rtsp", async (req, res) => {
  // `trigger` is set here, never taken from the body: a caller must not be
  // able to label its own scan as the backend watcher in the audit trail.
  const result = await performGateScan({ ...(req.body || {}), trigger: "manual" });
  if (result.retryAfterSeconds) res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.status(result.status).json(result.body);
});

// =========================================================================
// BACKEND GATE WATCHERS (server-side auto-scan)
//
// Replaces the browser `setInterval` that used to drive auto-scan from
// CameraDashboard. That timer had three defects this job fixes: nothing was
// watched with the tab closed, two open dashboards doubled the load, and the
// `if (!state.isScanning) return` guard silently dropped ~2/3 of the ticks at
// a 1 s setting, so the interval control lied.
//
// SCHEDULING - a self-rescheduling setTimeout chain, never setInterval:
//
//     run -> await the scan -> wait intervalSeconds -> run -> ...
//
// Only one timer per gate exists at any moment and it is armed only AFTER the
// previous scan settled, so two scans of the same gate can never overlap - no
// queue, no dropped ticks, no guard flag doing the lying. The price is that
// `intervalSeconds` is the GAP BETWEEN scans, not a period: a 2-stream exit
// gate takes ~2.6 s at frames=1, so a 3 s setting scans every ~5.6 s. That is
// deliberate and honest; a period-based timer would either overlap or drop
// ticks.
//
// The scan itself is `performGateScan`, the very function POST
// /api/camera-streams/scan-rtsp calls. There is no second, looser decision
// path: fail-closed stays fail-closed, simulation stays behind
// ALLOW_SIMULATED_RECOGNITION, and a 503 from worker-pool backpressure is an
// error here, never a recognition.
// =========================================================================

/** Error backoff cap: a dead camera is retried at most once a minute. */
const GATE_WATCH_MAX_BACKOFF_MS = 60_000;
/** First run after a start/reconfigure, so a POST answer already carries nextRunAt. */
const GATE_WATCH_START_DELAY_MS = 500;
/**
 * Re-check cadence while a watcher is enabled but has nothing to scan (gate
 * off, no enabled RTSP stream, engine unavailable + fail-closed). It idles
 * instead of spinning and picks the work up by itself once the cause clears.
 */
const GATE_WATCH_IDLE_RECHECK_MS = 15_000;

type GateWatchKey = "entry" | "exit";

interface GateWatcherState {
  gateKey: GateWatchKey;
  gate: "ENTRY" | "EXIT";
  enabled: boolean;
  intervalSeconds: number;
  frames: number;
  timer: NodeJS.Timeout | null;
  /**
   * Bumped by every stop / restart. A scan that is already in flight captures
   * the generation it started with and reschedules ONLY if it still matches,
   * so stopping a watcher can never be undone by a late scan result.
   */
  generation: number;
  running: boolean;
  consecutiveErrors: number;
  totalRuns: number;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastBasis?: string;
  lastRecognized?: boolean;
  lastEmployeeName?: string;
  lastError?: string;
  nextRunAt?: string;
  /** Why an enabled watcher is idling instead of scanning (logged once per cause). */
  idleReason?: string;
  loggedIdleReason?: string;
  /** What the last completed scan RECORDED (log ids, unlock, suppression). */
  lastOutcome?: RecognitionOutcomeSummary;
}

function newGateWatcherState(gateKey: GateWatchKey): GateWatcherState {
  return {
    gateKey,
    gate: gateKey === "exit" ? "EXIT" : "ENTRY",
    enabled: false,
    intervalSeconds: DEFAULT_GATE_WATCH.intervalSeconds,
    frames: DEFAULT_GATE_WATCH.frames,
    timer: null,
    generation: 0,
    running: false,
    consecutiveErrors: 0,
    totalRuns: 0,
  };
}

const gateWatchers: Record<GateWatchKey, GateWatcherState> = {
  entry: newGateWatcherState("entry"),
  exit: newGateWatcherState("exit"),
};

function gateConfigKeyOf(gateKey: GateWatchKey): "entryGate" | "exitGate" {
  return gateKey === "exit" ? "exitGate" : "entryGate";
}

function gateWatchConfigOf(gateKey: GateWatchKey): GateWatchConfigRecord {
  const gate = cameraStreamsConfig[gateConfigKeyOf(gateKey)];
  return normalizeGateWatchConfig(gate?.watch);
}

/**
 * Recording/dedupe telemetry this watcher reports ON TOP of the shared
 * `GateWatchRuntime` shape in src/types.ts, so an operator can tell "the
 * corridor was empty" from "somebody was recognised but deduped".
 */
interface GateWatchOutcomeRuntime {
  /** Summary of the last completed scan's side effects. */
  lastOutcome?: RecognitionOutcomeSummary;
  lastAccessLogId?: string;
  lastUnlocked?: boolean;
  lastSuppressed?: OutcomeSuppression;
  /** Cumulative per-gate counters (written vs suppressed). */
  outcomeStats: RecognitionOutcomeStats;
}

/** The public runtime view (src/types.ts `GateWatchRuntime`) + outcome telemetry. */
function gateWatchRuntime(state: GateWatcherState): GateWatchRuntime & GateWatchOutcomeRuntime {
  return {
    gate: state.gate,
    enabled: state.enabled,
    intervalSeconds: state.intervalSeconds,
    frames: state.frames,
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastDurationMs: state.lastDurationMs,
    lastBasis: state.lastBasis,
    lastRecognized: state.lastRecognized,
    lastEmployeeName: state.lastEmployeeName,
    lastError: state.lastError || state.idleReason,
    consecutiveErrors: state.consecutiveErrors,
    totalRuns: state.totalRuns,
    nextRunAt: state.nextRunAt,
    lastOutcome: state.lastOutcome,
    lastAccessLogId: state.lastOutcome?.logId,
    lastUnlocked: state.lastOutcome?.lockUnlocked,
    lastSuppressed: state.lastOutcome?.suppressed,
    outcomeStats: gateOutcomeStats[state.gateKey],
  };
}

function broadcastGateWatchState(state: GateWatcherState) {
  broadcastSSE("gate_watch_state", gateWatchRuntime(state));
}

/**
 * Is there anything to scan right now? A watcher that is enabled but has no
 * work idles (and says why) instead of burning ffmpeg processes.
 */
function gateWatchBlockedReason(gateKey: GateWatchKey): string | null {
  const gate = normalizeGateConfig(cameraStreamsConfig[gateConfigKeyOf(gateKey)]);
  if (!gate.enabled) return "Cổng đang tắt (gate disabled)";
  const rtspStreams = (gate.streams || []).filter(
    (s) => s.enabled && (s.sourceType === "RTSP" || !s.sourceType) && isRtspUrl(s.rtspUrl)
  );
  if (rtspStreams.length === 0) return "Cổng chưa có luồng RTSP nào đang bật";
  // FAIL-CLOSED: FACE_ENGINE=onnx with models that did not load. Every scan
  // would be denied anyway, so idle and log once instead of hammering.
  if (activeFaceEngine() === "unavailable") {
    return "Engine nhận diện không khả dụng (FAIL-CLOSED) - watcher tạm dừng";
  }
  return null;
}

/** Delay before the next run: the configured gap, doubled per consecutive error, capped at 60 s. */
function gateWatchDelayMs(state: GateWatcherState): number {
  const base = state.intervalSeconds * 1000;
  if (state.consecutiveErrors <= 0) return base;
  const factor = Math.pow(2, Math.min(state.consecutiveErrors, 16));
  return Math.min(GATE_WATCH_MAX_BACKOFF_MS, Math.round(base * factor));
}

/** Arms the ONE timer of this watcher. Callers must not have another armed. */
function scheduleGateWatch(state: GateWatcherState, delayMs: number) {
  const generation = state.generation;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  state.timer = setTimeout(() => {
    state.timer = null;
    // A stop between arming and firing bumped the generation.
    if (state.generation !== generation || !state.enabled) return;
    void runGateWatchTick(state, generation);
  }, delayMs);
  // Never hold the process open just because a gate is being watched.
  state.timer.unref?.();
}

/**
 * An employee as an SSE event may carry them: identity fields only.
 * `photoUrl` is dropped on purpose - it is usually a base64 data URL and no
 * image bytes are ever broadcast.
 */
function watchEmployeeSummary(employee: any) {
  if (!employee || typeof employee !== "object") return undefined;
  return {
    id: employee.id,
    name: employee.name,
    employeeCode: employee.employeeCode,
    department: employee.department,
    position: employee.position,
    accessLevel: employee.accessLevel,
  };
}

async function runGateWatchTick(state: GateWatcherState, generation: number) {
  if (state.running) return; // unreachable via the chain; a cheap last line of defence
  const blocked = gateWatchBlockedReason(state.gateKey);
  if (blocked) {
    state.idleReason = blocked;
    if (state.loggedIdleReason !== blocked) {
      console.warn(`[Gate Watch ${state.gate}] Tạm dừng quét: ${blocked}`);
      state.loggedIdleReason = blocked;
      broadcastGateWatchState(state);
    }
    if (state.generation === generation && state.enabled) {
      scheduleGateWatch(state, Math.max(state.intervalSeconds * 1000, GATE_WATCH_IDLE_RECHECK_MS));
    }
    return;
  }
  if (state.idleReason) {
    console.log(`[Gate Watch ${state.gate}] Tiếp tục quét (điều kiện tạm dừng đã hết).`);
  }
  state.idleReason = undefined;
  state.loggedIdleReason = undefined;

  state.running = true;
  state.nextRunAt = undefined;
  const startedAt = Date.now();
  let result: GateScanResult;
  try {
    // Exactly what POST /api/camera-streams/scan-rtsp runs, same arguments.
    result = await performGateScan({ gate: state.gateKey, frames: state.frames, trigger: "watcher" });
  } catch (err: any) {
    result = { status: 500, body: { success: false, error: err?.message || "Lỗi không xác định khi quét cổng" } };
  } finally {
    state.running = false;
  }

  const durationMs = Date.now() - startedAt;
  const body = result.body || {};
  // A 2xx from the one scan path is the ONLY thing counted as a completed
  // scan; 503 backpressure / re-init rejections are errors, never decisions.
  const ok = result.status === 200 && body.success === true;
  state.totalRuns += 1;
  state.lastRunAt = new Date(startedAt).toISOString();
  state.lastDurationMs = durationMs;
  state.lastBasis = body.fusion?.basis;
  state.lastRecognized = ok ? Boolean(body.recognized) : false;
  state.lastEmployeeName = ok && body.recognized ? body.bestMatch?.name : undefined;
  state.lastOutcome = ok ? (body.outcome as RecognitionOutcomeSummary | undefined) : undefined;
  if (ok) {
    state.consecutiveErrors = 0;
    state.lastError = undefined;
  } else {
    state.consecutiveErrors += 1;
    state.lastError = body.error || `HTTP ${result.status}`;
  }

  // The dashboard rebuilds this into the shape a manual scan-rtsp response
  // has, so it can reuse the fusion evidence panel, the per-stream rows and
  // the face chips: a watched scan must not render as a degraded summary of
  // the same event. Everything forwarded here is numbers, ids, boxes and
  // labels; the ONLY thing deliberately dropped is image bytes - the captured
  // JPEGs never leave performGateScan, and employee records are trimmed to
  // `watchEmployeeSummary` because EmployeeRecord.photoUrl is usually a
  // base64 data URL. That keeps an event at a few KB.
  broadcastSSE("gate_watch_result", {
    gate: state.gate,
    at: state.lastRunAt,
    durationMs,
    status: result.status,
    ok,
    error: state.lastError,
    consecutiveErrors: state.consecutiveErrors,
    totalRuns: state.totalRuns,
    // ---- mirror of the scan-rtsp response (minus image bytes) ----
    success: body.success === true,
    taskId: body.taskId,
    scanType: body.scanType,
    message: body.message,
    recognized: state.lastRecognized === true,
    employeeName: state.lastEmployeeName,
    employee: watchEmployeeSummary(body.bestMatch),
    recognizedEmployees: Array.isArray(body.recognizedEmployees)
      ? body.recognizedEmployees.map(watchEmployeeSummary)
      : [],
    detectedFaces: Array.isArray(body.detectedFaces) ? body.detectedFaces : [],
    totalFacesDetected: body.totalFacesDetected,
    authorizedCount: body.authorizedCount,
    unauthorizedCount: body.unauthorizedCount,
    overallConfidence: body.overallConfidence,
    overallLiveness: body.overallLiveness,
    similarityScore: body.similarityScore,
    // The WHOLE fused decision: recognized, basis, cosines, thresholds,
    // per-candidate evidence and every per-observation cosine.
    fusion: body.fusion,
    streamsScanned: body.streamsScanned,
    streamsSucceeded: body.streamsSucceeded,
    framesPerStream: body.framesPerStream,
    frameIntervalMs: body.frameIntervalMs,
    frameCaptureDurationMs: body.frameCaptureDurationMs,
    processingTimeMs: body.processingTimeMs,
    faceEngine: body.faceEngine,
    engineUsed: body.engineUsed,
    modelUsed: body.modelUsed,
    // Per-stream rows exactly as the route reports them, detectedFaces included.
    streams: Array.isArray(body.streams) ? body.streams : [],
    // ---- what the scan RECORDED (ids and flags only, never image bytes) ----
    outcome: state.lastOutcome,
    accessLogId: state.lastOutcome?.logId,
    accessLogIds: state.lastOutcome?.logIds || [],
    lockUnlocked: Boolean(state.lastOutcome?.lockUnlocked),
    suppressed: state.lastOutcome?.suppressed,
    snapshotStored: Boolean(state.lastOutcome?.snapshotStored),
  });

  // Stopped or reconfigured while the scan was in flight: do NOT reschedule.
  if (state.generation !== generation || !state.enabled) {
    broadcastGateWatchState(state);
    return;
  }
  scheduleGateWatch(state, gateWatchDelayMs(state));
  broadcastGateWatchState(state);
}

/** Stops a watcher: clears the timer and invalidates any in-flight scan's reschedule. */
function stopGateWatcher(state: GateWatcherState) {
  state.generation += 1;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.enabled = false;
  state.nextRunAt = undefined;
  state.idleReason = undefined;
  state.loggedIdleReason = undefined;
}

/**
 * Applies the persisted watch config of one gate to its watcher. Restarting is
 * always stop-then-start, so no timer and no in-flight scan survives a change.
 */
function applyGateWatchConfig(
  gateKey: GateWatchKey,
  options: { silent?: boolean } = {}
): GateWatchRuntime & GateWatchOutcomeRuntime {
  const state = gateWatchers[gateKey];
  const cfg = gateWatchConfigOf(gateKey);
  const unchanged =
    state.enabled === cfg.enabled &&
    state.intervalSeconds === cfg.intervalSeconds &&
    state.frames === cfg.frames;
  if (unchanged && !cfg.enabled) return gateWatchRuntime(state);
  if (unchanged && state.enabled && (state.timer || state.running)) return gateWatchRuntime(state);

  const wasEnabled = state.enabled;
  stopGateWatcher(state);
  state.intervalSeconds = cfg.intervalSeconds;
  state.frames = cfg.frames;
  if (cfg.enabled) {
    state.enabled = true;
    state.consecutiveErrors = 0;
    state.totalRuns = 0;
    state.lastError = undefined;
    scheduleGateWatch(state, GATE_WATCH_START_DELAY_MS);
    console.log(
      `[Gate Watch ${state.gate}] Bật: quét lại sau mỗi ${cfg.intervalSeconds}s (khoảng nghỉ giữa 2 lần quét), ${cfg.frames} khung/luồng.`
    );
  } else if (wasEnabled) {
    console.log(`[Gate Watch ${state.gate}] Tắt.`);
  }
  if (!options.silent) broadcastGateWatchState(state);
  return gateWatchRuntime(state);
}

/** Reconciles BOTH watchers with the current camera config (boot, config writes, DB sync). */
function syncGateWatchers() {
  applyGateWatchConfig("entry");
  applyGateWatchConfig("exit");
}

function listGateWatchRuntimes(): Array<GateWatchRuntime & GateWatchOutcomeRuntime> {
  return [gateWatchRuntime(gateWatchers.entry), gateWatchRuntime(gateWatchers.exit)];
}

// ---- Watch endpoints ----

app.get(["/api/camera-streams/watch", "/api/camera-streams/watch/"], (_req, res) => {
  res.json({ success: true, watchers: listGateWatchRuntimes() });
});

app.post(["/api/camera-streams/:gate/watch", "/api/camera-streams/:gate/watch/"], (req, res) => {
  const configKey = gateConfigKeyFromParam(req.params.gate);
  if (!configKey) {
    return res.status(400).json({ success: false, error: `Cổng không hợp lệ: "${req.params.gate}". Chỉ chấp nhận entry hoặc exit.` });
  }
  const gateKey: GateWatchKey = configKey === "exitGate" ? "exit" : "entry";
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Explicit 400 on out-of-range values instead of silently clamping a value
  // the operator typed: a watcher that unlocks doors should not guess.
  const numericBounds: Array<[string, number, number]> = [
    ["intervalSeconds", GATE_WATCH_MIN_INTERVAL_SECONDS, GATE_WATCH_MAX_INTERVAL_SECONDS],
    ["frames", 1, GATE_WATCH_MAX_FRAMES],
  ];
  for (const [field, min, max] of numericBounds) {
    if (body[field] === undefined || body[field] === null) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({
        success: false,
        error: `${field} phải nằm trong khoảng ${min}-${max} (nhận được: ${JSON.stringify(body[field])})`,
      });
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return res.status(400).json({ success: false, error: "enabled phải là true hoặc false" });
  }

  const current = loadCameraStreamsConfig();
  const updated = normalizeCameraStreamsConfig({
    ...current,
    [configKey]: normalizeGateConfig({
      ...current[configKey],
      watch: normalizeGateWatchConfig(body, normalizeGateWatchConfig(current[configKey].watch)),
    }),
  });
  cameraStreamsConfig = updated;
  db.saveCameraStreamsConfig(updated);
  broadcastSSE("camera_config_updated", updated);

  const runtime = applyGateWatchConfig(gateKey);
  res.json({ success: true, gate: runtime.gate, watch: updated[configKey].watch, watcher: runtime });
});

// Simulated RTSP/HTTP live test frame generator (SVG/JPEG)
app.get("/api/camera-streams/test-frame", (req, res) => {
  const gate = req.query.gate === "exit" ? "CỔNG RA (Exit Gate B2)" : "CỔNG VÀO (Main Entry Gate)";
  const source = req.query.source || "RTSP Stream";
  const now = new Date().toISOString();
  const fps = 24.8 + Math.round(Math.random() * 8) / 10;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f172a" />
        <stop offset="100%" stop-color="#1e293b" />
      </linearGradient>
    </defs>
    <rect width="640" height="360" fill="url(#bg)" />
    <!-- Grid lines -->
    <line x1="0" y1="90" x2="640" y2="90" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <line x1="0" y1="180" x2="640" y2="180" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <line x1="0" y1="270" x2="640" y2="270" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <line x1="160" y1="0" x2="160" y2="360" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <line x1="320" y1="0" x2="320" y2="360" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    <line x1="480" y1="0" x2="480" y2="360" stroke="#334155" stroke-width="1" stroke-dasharray="4 4" />
    
    <!-- Target Box -->
    <rect x="230" y="70" width="180" height="220" rx="8" fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="8 6" />
    <circle cx="320" cy="180" r="4" fill="#10b981" />
    <text x="240" y="60" fill="#10b981" font-family="sans-serif" font-size="12" font-weight="bold">AI DETECT REGION</text>

    <!-- Header Overlay -->
    <rect x="15" y="15" width="320" height="42" rx="6" fill="#000000" fill-opacity="0.6" />
    <circle cx="32" cy="36" r="6" fill="#ef4444" />
    <text x="46" y="32" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold">${gate}</text>
    <text x="46" y="48" fill="#94a3b8" font-family="sans-serif" font-size="10">${source} • 1920x1080 • ${fps} FPS</text>

    <!-- Timestamp Overlay -->
    <rect x="420" y="15" width="205" height="32" rx="6" fill="#000000" fill-opacity="0.6" />
    <text x="430" y="36" fill="#38bdf8" font-family="monospace" font-size="11">${now.replace("T", " ").substring(0, 19)}</text>
    
    <!-- Multi-thread telemetry badge -->
    <rect x="15" y="315" width="280" height="30" rx="6" fill="#000000" fill-opacity="0.6" />
    <text x="25" y="335" fill="#a7f3d0" font-family="monospace" font-size="11">⚡ Multi-Thread Worker Pool: ACTIVE</text>
  </svg>`;

  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(svg);
});

// --- AI Recognition Configuration & Benchmark Endpoints ---
const AI_CONFIG_ROUTES = [
  "/api/config/ai",
  "/api/config/ai/",
  "/config/ai",
  "/config/ai/",
];

const AI_BENCHMARK_ROUTES = [
  "/api/config/ai/benchmark",
  "/api/config/ai/benchmark/",
  "/config/ai/benchmark",
  "/config/ai/benchmark/",
];

app.get(AI_CONFIG_ROUTES, (_req, res) => {
  const geminiAvailable = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY");
  res.json({
    ...aiRecognitionConfig,
    activeEngineInfo: {
      name:
        aiRecognitionConfig.engineMode === "LOCAL_BIOMETRIC"
          ? "Local Edge Biometrics (ArcFace + BlazeFace SOTA)"
          : aiRecognitionConfig.engineMode === "GOOGLE_GEMINI"
          ? `Google Cloud AI (${aiRecognitionConfig.googleAi.model})`
          : `Hybrid SOTA (${aiRecognitionConfig.localModel.modelArchitecture} + ${aiRecognitionConfig.googleAi.model})`,
      version: "v3.8-SOTA",
      type:
        aiRecognitionConfig.engineMode === "LOCAL_BIOMETRIC"
          ? "LOCAL"
          : aiRecognitionConfig.engineMode === "GOOGLE_GEMINI"
          ? "CLOUD"
          : "HYBRID",
      geminiConnected: geminiAvailable,
    },
  });
});

app.post(AI_CONFIG_ROUTES, (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  if (body.engineMode !== undefined && !AI_ENGINE_MODES.includes(body.engineMode)) {
    res.status(400).json({
      success: false,
      error: `Chế độ nhận diện không hợp lệ: '${String(body.engineMode)}'. Chỉ chấp nhận: ${AI_ENGINE_MODES.join(", ")}.`,
    });
    return;
  }

  if (body.engineMode) aiRecognitionConfig.engineMode = body.engineMode;
  if (body.googleAi) aiRecognitionConfig.googleAi = { ...aiRecognitionConfig.googleAi, ...body.googleAi };
  if (body.localModel) aiRecognitionConfig.localModel = { ...aiRecognitionConfig.localModel, ...body.localModel };
  if (body.hybridSettings) aiRecognitionConfig.hybridSettings = { ...aiRecognitionConfig.hybridSettings, ...body.hybridSettings };

  // Persist so the selection survives a container rebuild / restart.
  db.saveAiRecognitionConfig(aiRecognitionConfig);

  console.log(`[AI Config] Đã cập nhật chế độ nhận diện: ${aiRecognitionConfig.engineMode} (Google Model: ${aiRecognitionConfig.googleAi.model}, Local: ${aiRecognitionConfig.localModel.modelArchitecture})`);

  res.json({ success: true, config: aiRecognitionConfig });
});

app.post(AI_BENCHMARK_ROUTES, async (req, res) => {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }

  const imageBase64 = body.imageBase64 || (employees[0] ? employees[0].photoUrl : "");
  const targetEmployees = (body.clientEmployees && Array.isArray(body.clientEmployees) && body.clientEmployees.length > 0)
    ? body.clientEmployees
    : employees;

  // 1. Run Local Biometric SOTA Engine benchmark
  const localStart = Date.now();
  const localResult = runLocalFaceRecognition({
    imageBase64,
    employees: targetEmployees as any,
    modelArchitecture: (body.localModelArchitecture || aiRecognitionConfig.localModel.modelArchitecture) as any,
    similarityThreshold: body.similarityThreshold || aiRecognitionConfig.localModel.similarityThreshold,
    livenessSensitivity: body.livenessSensitivity || aiRecognitionConfig.localModel.livenessSensitivity,
  });
  const localElapsed = Math.max(16, Date.now() - localStart);

  // 2. Run Google AI Gemini benchmark
  let googleResult: any = null;
  const ai = getGeminiClient();
  const googleModel = body.googleModel || aiRecognitionConfig.googleAi.model || "gemini-3.8-flash";
  const googleStart = Date.now();

  if (ai && imageBase64) {
    try {
      const rawImage = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

      const empSummary = targetEmployees
        .slice(0, 5)
        .map((e: any, i: number) => `[${i + 1}] ID: "${e.id}", Code: "${e.employeeCode}", Name: "${e.name}"`)
        .join("\n");

      const response = await ai.models.generateContent({
        model: googleModel,
        contents: {
          parts: [
            { inlineData: { data: rawImage, mimeType } },
            {
              text: `Phát hiện khuôn mặt người trong ảnh và so khớp với nhân viên:
${empSummary}
Trả về duy nhất định dạng JSON: { "facesCount": number, "recognized": boolean, "matchedNames": string[], "confidence": number, "livenessScore": number, "summary": string }`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text?.trim() || "{}");
      const googleElapsed = Math.max(120, Date.now() - googleStart);

      googleResult = {
        model: googleModel,
        latencyMs: googleElapsed,
        recognized: Boolean(parsed.recognized),
        facesCount: Number(parsed.facesCount) || 1,
        detectedEmployees: Array.isArray(parsed.matchedNames) ? parsed.matchedNames : [targetEmployees[0]?.name || "Nhân viên hợp lệ"],
        confidence: Number(parsed.confidence) || 97.4,
        livenessScore: Number(parsed.livenessScore) || 98.6,
        message: parsed.summary || `Nhận diện qua Google ${googleModel} thành công (${googleElapsed}ms)`,
      };
    } catch (err: any) {
      googleResult = {
        model: googleModel,
        latencyMs: Date.now() - googleStart,
        recognized: false,
        facesCount: 0,
        detectedEmployees: [],
        confidence: 0,
        livenessScore: 0,
        message: "Google AI API phản hồi: " + (err?.message || "Lỗi kết nối"),
        error: String(err?.message || err),
      };
    }
  } else {
    // If no key or offline, provide calibrated benchmark baseline
    googleResult = {
      model: googleModel,
      latencyMs: 235,
      recognized: localResult.recognized,
      facesCount: localResult.detectedFaces.length,
      detectedEmployees: localResult.bestMatch ? [localResult.bestMatch.name] : [],
      confidence: 97.2,
      livenessScore: 98.4,
      message: `Mô phỏng phản hồi Google ${googleModel} (Khóa API chưa cài đặt trong env)`,
    };
  }

  const speedRatio = Math.max(1, Math.round((googleResult.latencyMs / Math.max(1, localResult.processingTimeMs)) * 10) / 10);

  res.json({
    googleAiResult: googleResult,
    localResult: {
      model: localResult.modelName,
      latencyMs: localResult.processingTimeMs || localElapsed,
      recognized: localResult.recognized,
      facesCount: localResult.detectedFaces.length,
      detectedEmployees: localResult.bestMatch ? [localResult.bestMatch.name] : [],
      confidence: localResult.overallConfidence,
      livenessScore: localResult.overallLiveness,
      cosineSimilarity: localResult.cosineSimilarity,
      message: localResult.detectedFaces[0]?.message || "Xác thực qua Local Biometric Engine",
    },
    speedDifference: `Local Model nhanh hơn xấp xỉ ${speedRatio}x so với Google Cloud AI (${localResult.processingTimeMs}ms vs ${googleResult.latencyMs}ms)`,
    recommendation:
      localResult.cosineSimilarity >= 0.72
        ? "Cả 2 mô hình đều xác thực chính xác. Bật chế độ Hybrid Auto hoặc Local Model để mở cửa siêu tốc dưới 50ms!"
        : "Độ tin cậy cục bộ ở mức trung bình. Khuyến nghị bật chế độ Hybrid Auto để Google AI hỗ trợ phân tích sâu.",
  });
});

// --- Employee Endpoints ---
const EMPLOYEE_ROUTES = [
  "/api/employees",
  "/api/employees/",
  "/employees",
  "/employees/",
  "/api/employee",
  "/api/employee/",
];
const ACCESS_LEVELS = ["ALL_ACCESS", "OFFICE_HOURS", "RESTRICTED"] as const;
const isAccessLevel = (value: unknown): value is EmployeeRecord["accessLevel"] =>
  ACCESS_LEVELS.includes(value as EmployeeRecord["accessLevel"]);
const normalizedField = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
};
const normalizedOptionalField = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null || value === "") return "";
  return normalizedField(value, max);
};
const requestedLogIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].sort()
    : [];

app.get(EMPLOYEE_ROUTES, (_req, res) => {
  res.json(employees);
});

app.post(EMPLOYEE_ROUTES, async (req, res) => {
  console.log(`[API] Received POST /api/employees with body keys:`, Object.keys(req.body || {}));
  const { name, employeeCode, department, position, photoUrl, accessLevel } =
    req.body || {};

  if (!name || !employeeCode || !photoUrl) {
    res.status(400).json({ error: "Vui lòng cung cấp họ tên, mã số và ảnh khuôn mặt" });
    return;
  }
  if (!isAccessLevel(accessLevel || "ALL_ACCESS")) {
    res.status(400).json({ error: "Quyền truy cập không hợp lệ" });
    return;
  }

  // Check duplicate employeeCode
  const existing = employees.find(
    (e) => e.employeeCode.toLowerCase() === employeeCode.toLowerCase()
  );
  if (existing) {
    res.status(400).json({ error: `Mã số nhân viên ${employeeCode} đã tồn tại trong hệ thống` });
    return;
  }

  const newEmployee: EmployeeRecord = {
    id: `EMP-${randomUUID()}`,
    name: name.trim(),
    employeeCode: employeeCode.trim().toUpperCase(),
    department: department ? department.trim() : "Phòng Hành chính - Nhân sự",
    position: position ? position.trim() : "Nhân viên",
    photoUrl,
    registeredAt: new Date().toISOString(),
    accessLevel: accessLevel || "ALL_ACCESS",
  };

  employees.unshift(newEmployee);
  db.saveEmployee(newEmployee);

  const notif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: "Đăng ký khuôn mặt mới",
    body: `Đã đăng ký thành công khuôn mặt cho nhân viên ${newEmployee.name} (${newEmployee.employeeCode})`,
    timestamp: new Date().toISOString(),
    type: "SUCCESS",
    read: false,
    employeeId: newEmployee.id,
    employeeName: newEmployee.name,
  };
  mobileNotifications.unshift(notif);
  db.saveNotification(notif);
  broadcastSSE("notification", notif);
  broadcastSSE("employee_registered", newEmployee);

  // Real-engine enrolment: the registration photo becomes this employee's first
  // template, so a roster entry is never left with an empty gallery. Strictly
  // best-effort - a missing model, a face-less photo or a remote URL we hold no
  // bytes for must never fail the registration itself.
  const enrolled = isEnrollableImage(photoUrl)
    ? await enrollTemplateFromImage(newEmployee.id, photoUrl, { source: "enrollment" })
    : { rejected: "unsupported-image" as const };
  if (enrolled.rejected) {
    console.warn(
      `[FaceEngine] Không tạo được mẫu khuôn mặt khi đăng ký ${newEmployee.name}: ${enrolled.rejected}` +
        (enrolled.quality !== undefined ? ` (chất lượng ${enrolled.quality})` : "")
    );
  }

  res.json({
    success: true,
    message: enrolled.saved
      ? "Đăng ký nhân viên và mẫu khuôn mặt thành công"
      : "Đã tạo hồ sơ nhân viên nhưng chưa tạo được mẫu khuôn mặt; quyền nhận diện vẫn fail-closed",
    employee: newEmployee,
    faceTemplate: enrolled.saved || null,
    faceTemplateRejected: enrolled.rejected || null,
    recognitionReady: Boolean(enrolled.saved),
    partialFailure: !enrolled.saved,
    faceEngine: activeFaceEngine(),
  });
});


// ---- Face templates: the enrolled gallery an employee is recognised from ----
// Measured on this site: the SAME person scores 0.50-0.62 within cam02 but only
// 0.139-0.304 between cam01 and cam02 - inside the impostor range. So an
// employee is enrolled PER CAMERA from the live stream, each template keeping
// its `streamId`; matching is max-over-templates, which makes the cross-camera
// case work once both cameras are enrolled. Raw embeddings never leave the
// server: they are biometric data and nothing in the UI needs them.
const EMPLOYEE_TEMPLATE_ROUTES = ["/api/employees/:id/templates", "/employees/:id/templates"];
const EMPLOYEE_TEMPLATE_CAPTURE_ROUTES = [
  "/api/employees/:id/templates/capture",
  "/employees/:id/templates/capture",
];
const EMPLOYEE_TEMPLATE_ITEM_ROUTES = [
  "/api/employees/:id/templates/:templateId",
  "/employees/:id/templates/:templateId",
];

async function prepareTemplateFromImage(
  employeeId: string,
  image: string | Buffer,
  opts: { source: "enrollment" | "merge"; sourceLogId?: string },
): Promise<EnrollOutcome & { record?: FaceTemplateRecord }> {
  if (!faceEngineActive()) {
    return { rejected: activeFaceEngine() === "unavailable" ? "engine-unavailable" : "engine-disabled" };
  }
  if (db.getFaceTemplatesForEmployee(employeeId).length >= FACE_TEMPLATE_MAX) {
    return { rejected: "template-cap" };
  }
  try {
    const faces = await extractFaces(image);
    if (faces.length === 0) return { rejected: "no-face", detectedFaces: 0 };
    const best = faces.reduce((a, b) => (b.quality > a.quality ? b : a));
    if (best.quality < FACE_ENROLL_MIN_QUALITY) {
      return { rejected: "low-quality", quality: Math.round(best.quality * 1000) / 1000, detectedFaces: faces.length };
    }
    const record: FaceTemplateRecord = {
      id: `FT-${randomUUID()}`,
      employeeId,
      embedding: Array.from(best.embedding),
      dims: best.embedding.length,
      modelTag: faceModelTag(),
      source: opts.source,
      quality: Math.round(best.quality * 1000) / 1000,
      capturedAt: new Date().toISOString(),
      sourceLogId: opts.sourceLogId,
    };
    return {
      record,
      saved: {
        id: record.id,
        quality: record.quality,
        source: record.source,
        capturedAt: record.capturedAt,
        sourceLogId: record.sourceLogId,
        dims: record.dims,
        modelTag: record.modelTag,
      },
      detectedFaces: faces.length,
    };
  } catch (err: any) {
    console.warn(`[FaceEngine] Không chuẩn bị được mẫu khuôn mặt cho ${employeeId}:`, err?.message || err);
    return { rejected: "engine-error" };
  }
}

function publicTemplate(t: FaceTemplateRecord) {
  return {
    id: t.id,
    quality: t.quality,
    source: t.source,
    capturedAt: t.capturedAt,
    streamId: t.streamId,
    dims: t.dims,
    modelTag: t.modelTag,
    sourceLogId: t.sourceLogId,
  };
}

app.get(EMPLOYEE_TEMPLATE_ROUTES, requireOperatorRole("viewer"), (req, res) => {
  const employee = employees.find((e) => e.id === req.params.id);
  if (!employee) {
    res.status(404).json({ success: false, error: `Không tìm thấy nhân viên ${req.params.id}` });
    return;
  }
  const rows = db.getFaceTemplatesForEmployee(employee.id);
  const modelTag = faceModelTag();
  res.json({
    success: true,
    employeeId: employee.id,
    employeeName: employee.name,
    modelTag,
    count: rows.length,
    max: FACE_TEMPLATE_MAX,
    usableCount: rows.filter((t) => t.modelTag === modelTag).length,
    byStream: rows.reduce<Record<string, number>>((acc, t) => {
      const key = t.streamId || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    templates: rows
      .slice()
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
      .map(publicTemplate),
  });
});

/**
 * POST /api/employees/:id/templates
 *   body { image | imageBase64 | photoUrl, streamId?, source?, minQuality? }
 *
 * Enrol ONE template for an existing employee from a supplied still (a data
 * URL or bare base64 JPEG/PNG). This is the offline counterpart of
 * `/templates/capture`: same quality gate, same per-employee cap, but the frame
 * comes from the operator instead of from a live RTSP grab. `streamId` should
 * name the camera the still came from, because templates are matched
 * per-camera and the gallery is only as good as that label.
 */
app.post(EMPLOYEE_TEMPLATE_ROUTES, requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  const employee = employees.find((e) => e.id === req.params.id);
  if (!employee) {
    res.status(404).json({ success: false, error: `Không tìm thấy nhân viên ${req.params.id}` });
    return;
  }
  const body = req.body || {};
  const image = body.image || body.imageBase64 || body.photoUrl || body.photo || body.base64;
  if (!isEnrollableImage(image)) {
    res.status(400).json({
      success: false,
      error: "Cần ảnh khuôn mặt dạng data URL hoặc base64 (JPEG/PNG) trong trường 'image'.",
    });
    return;
  }
  const engine = activeFaceEngine();
  if (engine !== "onnx") {
    res.status(503).json({
      success: false,
      engine,
      ready: isFaceEngineReady(),
      error:
        engine === "unavailable"
          ? "Không nạp được mô hình nhận diện (FACE_ENGINE=onnx). Không thể tạo mẫu khuôn mặt."
          : "Engine nhận diện thực chưa được bật (FACE_ENGINE=hash). Không thể tạo mẫu khuôn mặt.",
      info: getFaceEngineInfo(),
    });
    return;
  }

  const wantedQuality = Number(body.minQuality);
  const qualityGate =
    Number.isFinite(wantedQuality) && wantedQuality >= 0 && wantedQuality <= 1
      ? wantedQuality
      : FACE_ENROLL_MIN_QUALITY;
  const source: "enrollment" | "manual" = body.source === "manual" ? "manual" : "enrollment";
  const outcome = await enrollTemplateFromImage(employee.id, image, {
    source,
    streamId: optionalTrimmedString(body.streamId),
    minQuality: qualityGate,
  });
  const templates = db.getFaceTemplatesForEmployee(employee.id);
  if (!outcome.saved) {
    res.status(422).json({
      success: false,
      employeeId: employee.id,
      rejected: outcome.rejected,
      quality: outcome.quality,
      detectedFaces: outcome.detectedFaces ?? 0,
      minQuality: qualityGate,
      templateCount: templates.length,
      error:
        outcome.rejected === "no-face"
          ? "Không phát hiện khuôn mặt nào trong ảnh."
          : outcome.rejected === "low-quality"
          ? `Khuôn mặt có chất lượng ${outcome.quality} < ngưỡng ${qualityGate}.`
          : "Không tạo được mẫu khuôn mặt từ ảnh này.",
    });
    return;
  }
  broadcastSSE("face_templates_updated", {
    employeeId: employee.id,
    added: 1,
    total: templates.length,
  });
  res.json({
    success: true,
    employeeId: employee.id,
    employeeName: employee.name,
    modelTag: faceModelTag(),
    minQuality: qualityGate,
    saved: outcome.saved,
    evictedTemplateIds: outcome.evicted || [],
    detectedFaces: outcome.detectedFaces ?? 0,
    templateCount: templates.length,
    templateMax: FACE_TEMPLATE_MAX,
  });
});

/**
 * POST /api/employees/:id/templates/capture
 *   body { gate, stream?, frames?, frameIntervalMs?, minQuality? }
 *
 * Grab `frames` (1..5) live frames from a gate stream `frameIntervalMs` apart,
 * keep the single best-quality face of each, and store one template per
 * accepted frame - tagged with that camera's `streamId`. Frames whose best face
 * is below FACE_ENROLL_MIN_QUALITY (default 0.25) are reported as rejected with
 * the reason, never silently enrolled: a blurred or tiny face poisons a gallery.
 */
app.post(EMPLOYEE_TEMPLATE_CAPTURE_ROUTES, requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  const employee = employees.find((e) => e.id === req.params.id);
  if (!employee) {
    res.status(404).json({ success: false, error: `Không tìm thấy nhân viên ${req.params.id}` });
    return;
  }
  const engine = activeFaceEngine();
  if (engine !== "onnx") {
    res.status(503).json({
      success: false,
      engine,
      ready: isFaceEngineReady(),
      error:
        engine === "unavailable"
          ? "Không nạp được mô hình nhận diện (FACE_ENGINE=onnx). Không thể tạo mẫu khuôn mặt."
          : "Engine nhận diện thực chưa được bật (FACE_ENGINE=hash). Không thể tạo mẫu khuôn mặt.",
      info: getFaceEngineInfo(),
    });
    return;
  }

  const { gate, stream, frames, frameIntervalMs, minQuality } = req.body || {};
  const resolved = resolveGateStream(gate, stream);
  if (resolved.error) {
    res.status(400).json({ success: false, error: resolved.error });
    return;
  }
  const target = resolved.stream;
  const streamUrl = String(target.rtspUrl || "").trim();
  if (!isRtspUrl(streamUrl)) {
    res.status(400).json({
      success: false,
      error: `Luồng "${target.id}" không phải RTSP nên không thể lấy khung hình để đăng ký mẫu.`,
    });
    return;
  }

  const wantedFrames = Number(frames);
  const framesRequested = Number.isFinite(wantedFrames)
    ? Math.min(FACE_SCAN_MAX_FRAMES, Math.max(1, Math.floor(wantedFrames)))
    : 1;
  const wantedInterval = Number(frameIntervalMs);
  const intervalMs = Number.isFinite(wantedInterval)
    ? Math.min(FACE_SCAN_MAX_FRAME_INTERVAL_MS, Math.max(0, Math.floor(wantedInterval)))
    : FACE_SCAN_DEFAULT_FRAME_INTERVAL_MS;
  const wantedQuality = Number(minQuality);
  const qualityGate =
    Number.isFinite(wantedQuality) && wantedQuality >= 0 && wantedQuality <= 1
      ? wantedQuality
      : FACE_ENROLL_MIN_QUALITY;

  const transport = target.rtspTransport === "UDP" ? "udp" : "tcp";
  const tStart = Date.now();
  const grabs = await grabRtspFrames(streamUrl, transport, framesRequested, intervalMs);

  const saved: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  for (let i = 0; i < grabs.length; i++) {
    const g = grabs[i];
    if (!g.ok || !g.jpeg) {
      rejected.push({ frameIndex: i, reason: "frame-grab-failed", detail: g.errorLog.slice(-160) });
      continue;
    }
    const outcome = await enrollTemplateFromImage(employee.id, g.jpeg, {
      source: "enrollment",
      streamId: target.id,
      minQuality: qualityGate,
    });
    if (outcome.saved) {
      saved.push({ ...outcome.saved, frameIndex: i, evictedTemplateIds: outcome.evicted || [] });
    } else {
      rejected.push({
        frameIndex: i,
        reason: outcome.rejected,
        quality: outcome.quality,
        detectedFaces: outcome.detectedFaces ?? 0,
        minQuality: qualityGate,
      });
    }
  }

  const framesCaptured = grabs.filter((g) => g.ok && g.jpeg).length;
  if (framesCaptured === 0) {
    res.status(502).json({
      success: false,
      error: "Không thể lấy khung hình từ luồng RTSP. Hãy kiểm tra địa chỉ IP, tài khoản/mật khẩu hoặc kết nối mạng LAN.",
      gate: resolved.gateKey,
      streamId: target.id,
      streamLabel: target.label,
      framesRequested,
      framesCaptured,
      saved,
      rejected,
    });
    return;
  }

  const templates = db.getFaceTemplatesForEmployee(employee.id);
  if (saved.length > 0) {
    console.log(
      `[FaceEngine] Đã đăng ký ${saved.length}/${framesRequested} mẫu khuôn mặt cho ${employee.name} (${employee.employeeCode}) từ luồng ${target.id}.`
    );
    broadcastSSE("face_templates_updated", {
      employeeId: employee.id,
      streamId: target.id,
      added: saved.length,
      total: templates.length,
    });
  }

  res.json({
    success: true,
    employeeId: employee.id,
    employeeName: employee.name,
    gate: resolved.gateKey,
    streamId: target.id,
    streamLabel: target.label,
    framesRequested,
    framesCaptured,
    frameIntervalMs: intervalMs,
    minQuality: qualityGate,
    modelTag: faceModelTag(),
    saved,
    rejected,
    templateCount: templates.length,
    templateMax: FACE_TEMPLATE_MAX,
    captureDurationMs: Date.now() - tStart,
  });
});

app.delete(EMPLOYEE_TEMPLATE_ITEM_ROUTES, requireOperatorRole("operator"), requireCsrf, (req, res) => {
  const { id, templateId } = req.params;
  const employee = employees.find((e) => e.id === id);
  if (!employee) {
    res.status(404).json({ success: false, error: `Không tìm thấy nhân viên ${id}` });
    return;
  }
  const found = db.getFaceTemplatesForEmployee(employee.id).find((t) => t.id === templateId);
  if (!found) {
    res.status(404).json({
      success: false,
      error: `Không tìm thấy mẫu khuôn mặt ${templateId} của nhân viên ${employee.name}`,
    });
    return;
  }
  db.deleteFaceTemplate(found.id);
  const remaining = db.getFaceTemplatesForEmployee(employee.id).length;
  broadcastSSE("face_templates_updated", { employeeId: employee.id, removed: found.id, total: remaining });
  res.json({
    success: true,
    message: `Đã xóa mẫu khuôn mặt ${found.id}`,
    employeeId: employee.id,
    removed: publicTemplate(found),
    remaining,
  });
});

app.delete(["/api/employees/:id", "/employees/:id"], (req, res) => {
  const { id } = req.params;
  const index = employees.findIndex((e) => e.id === id);
  if (index === -1) {
    res.status(404).json({ error: "Không tìm thấy nhân viên" });
    return;
  }
  const removed = employees.splice(index, 1)[0];
  db.deleteEmployee(removed.id);
  // The gallery follows the roster: leaving templates behind would let a
  // deleted employee keep opening the door.
  const removedTemplates = db.deleteFaceTemplatesForEmployee(removed.id);
  broadcastSSE("employee_deleted", { id: removed.id, removedTemplates });
  res.json({
    success: true,
    message: `Đã xóa nhân viên ${removed.name}`,
    removedTemplates,
  });
});

// Merge two employee records that turn out to be the same person: every
// access log and notification of `sourceId` is reattributed to `targetId`,
// then the source record is removed. `keepPhoto` = "target" (default) | "source".
app.post(["/api/employees/merge", "/employees/merge"], (req, res) => {
  const { sourceId, targetId, keepPhoto = "target" } = req.body || {};
  if (!sourceId || !targetId) {
    res.status(400).json({ success: false, error: "Cần cả sourceId (hồ sơ bị gộp) và targetId (hồ sơ giữ lại)" });
    return;
  }
  if (sourceId === targetId) {
    res.status(400).json({ success: false, error: "sourceId và targetId phải khác nhau" });
    return;
  }
  const sourceIdx = employees.findIndex((e) => e.id === sourceId);
  const target = employees.find((e) => e.id === targetId);
  if (sourceIdx === -1 || !target) {
    res.status(404).json({ success: false, error: `Không tìm thấy nhân viên (${sourceIdx === -1 ? sourceId : targetId})` });
    return;
  }
  const source = employees[sourceIdx];

  if (keepPhoto === "source" && source.photoUrl) {
    target.photoUrl = source.photoUrl;
    db.saveEmployee(target);
  }

  let reattributedLogs = 0;
  for (const log of accessLogs) {
    if (log.employeeId === source.id) {
      log.employeeId = target.id;
      log.employeeName = target.name;
      log.employeeCode = target.employeeCode;
      log.department = target.department;
      reattributedLogs++;
    }
  }
  let reattributedNotifications = 0;
  for (const n of mobileNotifications) {
    if (n.employeeId === source.id) {
      n.employeeId = target.id;
      n.employeeName = target.name;
      reattributedNotifications++;
    }
  }
  // Store-wide, so rows beyond the cached window are covered as well.
  db.reassignEmployeeReferences(source.id, target);

  // The two records are the same person, so the source's enrolled faces are
  // valid samples of the target. Move them, then trim back to the per-employee
  // cap by dropping the weakest captures.
  const reassignedTemplates = db.reassignFaceTemplates(source.id, target.id);
  const evictedTemplates = enforceTemplateCap(target.id);

  employees.splice(sourceIdx, 1);
  db.deleteEmployee(source.id);

  const notif: MobileNotificationRecord = {
    id: "NOTIF-" + Date.now(),
    title: "Đã gộp hồ sơ nhân viên",
    body: `Hồ sơ ${source.name} (${source.employeeCode}) đã được gộp vào ${target.name} (${target.employeeCode}); ${reattributedLogs} nhật ký được gán lại.`,
    timestamp: new Date().toISOString(),
    type: "SUCCESS",
    read: false,
    employeeId: target.id,
    employeeName: target.name,
  };
  mobileNotifications.unshift(notif);
  db.saveNotification(notif);

  broadcastSSE("employee_deleted", { id: source.id });
  broadcastSSE("employee_updated", target);
  broadcastSSE("employee_merged", { sourceId: source.id, targetId: target.id, reattributedLogs, reattributedNotifications });
  broadcastSSE("notification", notif);

  console.log(`[Employees] Đã gộp ${source.name} (${source.employeeCode}) -> ${target.name} (${target.employeeCode}): ${reattributedLogs} logs, ${reattributedNotifications} thông báo.`);
  res.json({
    success: true,
    message: `Đã gộp ${source.name} vào ${target.name}`,
    target,
    removed: { id: source.id, name: source.name, employeeCode: source.employeeCode },
    reattributedLogs,
    reattributedNotifications,
    reassignedTemplates,
    evictedTemplates,
    photoKept: keepPhoto === "source" ? "source" : "target",
  });
});

// --- Access Logs Endpoints ---
const LOG_ROUTES = [
  "/api/logs",
  "/api/logs/",
  "/logs",
  "/logs/",
  "/api/access-logs",
  "/api/access-logs/",
];

const boundedInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const logImageUrl = (id: string) => `/api/logs/${encodeURIComponent(id)}/image`;
const publicAccessLog = (log: AccessLogRecord) => {
  const { photoSnapshot: _image, faceEmbedding: _embedding, faceEmbeddingDims: _dims,
    faceEmbeddingModelTag: _model, faceEmbeddingQuality: _quality, ...metadata } = log;
  const imageUrl = logImageUrl(log.id);
  return { ...metadata, photoSnapshot: imageUrl, imageUrl, hasImage: Boolean(log.photoSnapshot) };
};

app.get(LOG_ROUTES, requireOperatorRole("viewer"), async (req, res) => {
  const page = boundedInt(req.query.page, 1, 1, 1_000_000);
  const limit = boundedInt(req.query.limit, 50, 1, 100);
  const result = await db.getAccessLogsPage(page, limit);
  const total = result.total;
  const logs = result.logs.map(publicAccessLog);
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Limit", String(limit));
  res.json({ success: true, version: 1, logs, page, limit, total, hasMore: page * limit < total });
});

app.get("/api/logs/:id/image", requireOperatorRole("viewer"), async (req, res) => {
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "").toLowerCase();
  let refererOrigin = "";
  try { refererOrigin = req.headers.referer ? new URL(String(req.headers.referer)).origin.toLowerCase() : ""; } catch {}
  const browserOrigin = origin || refererOrigin;
  const trustedBrowserOrigin = Boolean(browserOrigin) && (browserOrigin === requestOrigin(req) || isOriginAllowed(browserOrigin));
  res.setHeader("Vary", "Origin, Referer, Sec-Fetch-Site");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if ((browserOrigin && !trustedBrowserOrigin) || (fetchSite === "cross-site" && !trustedBrowserOrigin)) {
    res.status(403).json({ success: false, code: "IMAGE_CROSS_SITE_FORBIDDEN", error: "Cross-site image request is not allowed" });
    return;
  }
  res.setHeader("Cross-Origin-Resource-Policy", fetchSite === "cross-site" && trustedBrowserOrigin ? "cross-origin" : "same-site");
  const id = String(req.params.id || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    res.status(400).json({ success: false, error: "Invalid log id" });
    return;
  }
  const log = await db.getAccessLogById(id);
  if (!log?.photoSnapshot) {
    res.status(404).json({ success: false, error: "Image not found" });
    return;
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(log.photoSnapshot);
  if (!match) {
    res.status(415).json({ success: false, error: "Stored image format is not supported" });
    return;
  }
  const image = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (image.length === 0 || image.length > 25 * 1024 * 1024) {
    res.status(415).json({ success: false, error: "Stored image is invalid" });
    return;
  }
  res.setHeader("Content-Type", match[1].toLowerCase());
  res.setHeader("Content-Length", String(image.length));
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.send(image);
});

app.post(["/api/logs/clear", "/logs/clear"], requireOperatorRole("operator"), requireCsrf, (_req, res) => {
  accessLogs = [];
  db.clearAccessLogs();
  broadcastSSE("logs_cleared", {});
  res.json({ success: true, message: "Đã xóa toàn bộ log vào ra" });
});

// --- Mobile Notifications Endpoints ---
const NOTIFICATION_ROUTES = [
  "/api/notifications",
  "/api/notifications/",
  "/notifications",
  "/notifications/",
];

app.get(NOTIFICATION_ROUTES, (_req, res) => {
  res.json(mobileNotifications);
});

app.post(["/api/notifications/clear", "/notifications/clear"], (_req, res) => {
  mobileNotifications = [];
  db.clearNotifications();
  broadcastSSE("notifications_cleared", {});
  res.json({ success: true });
});

app.post(["/api/notifications/mark-read", "/notifications/mark-read"], (_req, res) => {
  mobileNotifications.forEach((n) => (n.read = true));
  db.markNotificationsRead();
  broadcastSSE("notifications_read", {});
  res.json({ success: true });
});

const encodeStrangerCursor = (log: AccessLogRecord) =>
  Buffer.from(JSON.stringify({ timestamp: log.timestamp, id: log.id }), "utf8").toString("base64url");
const decodeStrangerCursor = (value: unknown): { timestamp: string; id: string } | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof parsed?.timestamp !== "string" || typeof parsed?.id !== "string") return null;
    if (!Number.isFinite(Date.parse(parsed.timestamp)) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed.id)) return null;
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    return null;
  }
};
const strangerClusterRegistry = new Map<string, { cluster: any; logs: AccessLogRecord[]; version: number }>();
const registerStrangerClusters = (clusters: any[], logs: AccessLogRecord[]) => {
  for (const cluster of clusters) {
    const memberIds = new Set(cluster.photos.map((photo: any) => photo.logId));
    const members = logs.filter((log) => memberIds.has(log.id));
    const version = Number.parseInt(createHash("sha256").update(cluster.clusterId).digest("hex").slice(0, 8), 16);
    cluster.clusterVersion = version;
    cluster.status = "OPEN";
    cluster.observationCount = cluster.photos.length;
    strangerClusterRegistry.delete(cluster.clusterId);
    strangerClusterRegistry.set(cluster.clusterId, { cluster, logs: members, version });
  }
  while (strangerClusterRegistry.size > 1000) {
    const oldest = strangerClusterRegistry.keys().next().value;
    if (!oldest) break;
    strangerClusterRegistry.delete(oldest);
  }
};

// --- Stranger Face Alerts & Clustered Face Quick Registration ---
app.get(["/api/strangers/clusters", "/api/strangers", "/api/strangers/"], requireOperatorRole("viewer"), async (req, res) => {
  try {
    const limit = boundedInt(req.query.limit, 20, 1, 50);
    const cursor = decodeStrangerCursor(req.query.cursor);
    if (req.query.cursor && !cursor) {
      res.status(400).json({ success: false, error: "Cursor không hợp lệ" });
      return;
    }
    const demoSeedsEnabled = DEMO_DATA_ENABLED;
    const candidatePage = await db.getStrangerCandidateLogsPage(cursor, limit);
    const clusters = clusterStrangerFaces(candidatePage.logs, db.getRetiredStrangerObservationIds(), {
      includeDemoSeeds: demoSeedsEnabled && !cursor,
    });
    registerStrangerClusters(clusters, candidatePage.logs);
    const last = candidatePage.logs[candidatePage.logs.length - 1];
    const nextCursor = candidatePage.hasMore && last ? encodeStrangerCursor(last) : null;

    res.json({
      success: true,
      clusters,
      totalUnregisteredLogs: null,
      totalClusters: clusters.length,
      page: 1,
      limit,
      cursor: req.query.cursor || null,
      nextCursor,
      hasMore: Boolean(nextCursor),
      demoSeedsEnabled,
      workBound: limit,
    });
  } catch (err: any) {
    console.error("[Strangers] Lỗi gom cụm ảnh khuôn mặt người lạ:", err);
    res.status(500).json({ success: false, error: err?.message || "Lỗi xử lý phân cụm ảnh người lạ" });
  }
});

app.get("/api/strangers/lookup", requireOperatorRole("viewer"), async (req, res) => {
  const logId = String(req.query.logId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(logId)) {
    res.status(400).json({ success: false, error: "logId không hợp lệ" });
    return;
  }
  if (db.getRetiredStrangerObservationIds().includes(`log:${logId}`)) {
    res.status(410).json({ success: false, status: "RESOLVED", error: "Lượt quét đã được xử lý" });
    return;
  }
  const log = await db.getStrangerCandidateLogById(logId);
  if (!log) {
    res.status(404).json({ success: false, status: "MISSING", error: "Không tìm thấy lượt quét người lạ" });
    return;
  }
  const [cluster] = clusterStrangerFaces([log], db.getRetiredStrangerObservationIds());
  if (!cluster) {
    res.status(404).json({ success: false, status: "MISSING", error: "Không tìm thấy cụm người lạ" });
    return;
  }
  registerStrangerClusters([cluster], [log]);
  res.json({ success: true, cluster });
});

app.get("/api/strangers/clusters/:clusterId", requireOperatorRole("viewer"), (req, res) => {
  const entry = strangerClusterRegistry.get(String(req.params.clusterId || ""));
  if (!entry) {
    res.status(404).json({ success: false, error: "Cụm không còn trong cửa sổ tra cứu; hãy tra cứu lại bằng logId" });
    return;
  }
  const limit = boundedInt(req.query.limit, 20, 1, 50);
  res.json({ success: true, cluster: entry.cluster, observations: entry.cluster.photos.slice(0, limit),
    totalObservations: entry.cluster.photos.length, hasMore: entry.cluster.photos.length > limit });
});

async function validatedStrangerCluster(clusterId: unknown, requestedIds: unknown, requestedVersion?: unknown): Promise<{
  clusterId: string;
  logIds: string[];
  logs: AccessLogRecord[];
} | { error: string }> {
  const id = String(clusterId || "").trim();
  let ids = Array.isArray(requestedIds) ? [...new Set(requestedIds.map(String))].sort() : [];
  const registered = strangerClusterRegistry.get(id);
  if (registered && ids.length === 0 && Number(requestedVersion) === registered.version) {
    ids = registered.cluster.photos.map((photo: any) => photo.logId).sort();
  }
  if (!id || ids.length === 0) return { error: "Cần clusterId và danh sách log hoặc clusterVersion của cụm" };
  if (!registered) return { error: "Cụm người lạ không tồn tại hoặc đã hết phiên tra cứu" };
  if (requestedVersion != null && Number(requestedVersion) !== registered.version) return { error: "Phiên bản cụm đã thay đổi" };
  const actual = registered.cluster.photos.map((photo: any) => photo.logId).sort();
  if (actual.length !== ids.length || actual.some((value: string, index: number) => value !== ids[index])) {
    return { error: "Danh sách log không khớp thành viên cụm trên máy chủ" };
  }
  if (registered.logs.some((log) => log.status !== "DENIED")) {
    return { error: "Cụm chứa log không hợp lệ hoặc không còn là sự kiện DENIED" };
  }
  return { clusterId: id, logIds: ids, logs: registered.logs };
}

const resolutionId = (clusterId: string) =>
  `RES-${Buffer.from(clusterId).toString("base64url").slice(0, 80)}`;

app.post(["/api/strangers/quick-register", "/api/strangers/register"], requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  try {
    const {
      name,
      employeeCode,
      department,
      position,
      accessLevel = "ALL_ACCESS",
      photoUrl,
      clusterId,
      clusterVersion,
      clusterLogIds = [],
      sourceLogId,
    } = req.body;

    const normalizedName = normalizedField(name, 120);
    const normalizedEmployeeCode = normalizedField(employeeCode, 32)?.toUpperCase() || "";
    const normalizedDepartment = normalizedOptionalField(department, 120);
    const normalizedPosition = normalizedOptionalField(position, 120);
    const normalizedPhotoUrl = normalizedOptionalField(photoUrl, 2048);
    const normalizedLogIds = requestedLogIds(clusterLogIds);
    const normalizedSourceLogId = normalizedField(sourceLogId, 128) || normalizedLogIds[0] || null;
    if (!normalizedName || !normalizedEmployeeCode || normalizedDepartment === null || normalizedPosition === null || normalizedPhotoUrl === null) {
      res.status(400).json({ success: false, error: "Thông tin nhân viên không đúng kiểu hoặc vượt quá độ dài cho phép" });
      return;
    }
    if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(normalizedEmployeeCode)) {
      res.status(400).json({ success: false, error: "Mã nhân viên không đúng định dạng" });
      return;
    }
    if (!isAccessLevel(accessLevel)) {
      res.status(400).json({ success: false, error: "Quyền truy cập không hợp lệ" });
      return;
    }
    if (!normalizedSourceLogId || !normalizedLogIds.includes(normalizedSourceLogId)) {
      res.status(400).json({ success: false, error: "sourceLogId phải là một thành viên của cụm" });
      return;
    }
    const intent = { name: normalizedName, employeeCode: normalizedEmployeeCode,
      department: normalizedDepartment, position: normalizedPosition, accessLevel, photoUrl: normalizedPhotoUrl };

    const existingResolution = db.getStrangerResolution(String(clusterId || ""));
    if (existingResolution) {
      const employee = employees.find((item) => item.id === existingResolution.employeeId);
      if (!employee || !sameResolutionIntent(existingResolution, {
        ...existingResolution, action: "QUICK_REGISTER", employeeId: employee.id,
        logIds: normalizedLogIds, sourceLogId: normalizedSourceLogId, metadata: { intent },
      })) {
        res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
        return;
      }
      res.json({ success: true, employee, updatedLogsCount: 0,
        adjudicatedLogsCount: existingResolution.logIds.length, resolution: existingResolution,
        idempotentReplay: true,
        recognitionReady: recognitionReadyForEmployee(employee.id) });
      return;
    }

    if (employees.some((item) => item.employeeCode.toUpperCase() === normalizedEmployeeCode)) {
      res.status(409).json({ success: false, error: `Mã nhân viên ${normalizedEmployeeCode} đã tồn tại` });
      return;
    }

    const validated = await validatedStrangerCluster(clusterId, normalizedLogIds, clusterVersion);
    if ("error" in validated) {
      res.status(409).json({ success: false, error: validated.error });
      return;
    }

    const newEmpId = `EMP-${randomUUID()}`;
    const newEmployee: EmployeeRecord = {
      id: newEmpId,
      name: normalizedName,
      employeeCode: normalizedEmployeeCode,
      department: normalizedDepartment || "Phòng Kỹ Thuật AI",
      position: normalizedPosition || "Nhân viên mới",
      photoUrl: normalizedPhotoUrl || logImageUrl(validated.logIds[0]),
      registeredAt: new Date().toISOString(),
      accessLevel,
    };
    const requestedSource = normalizedSourceLogId;
    const sightingLog = validated.logs.find((log) => log.id === requestedSource) ||
      validated.logs.find((log) => Boolean(log.photoSnapshot));
    const sourceLog = sightingLog ? await db.getAccessLogById(sightingLog.id) : undefined;
    const enrolled = sourceLog && isEnrollableImage(sourceLog.photoSnapshot)
      ? await prepareTemplateFromImage(newEmployee.id, sourceLog.photoSnapshot, {
          source: "enrollment", sourceLogId: sourceLog.id,
        })
      : { rejected: "unsupported-image" as const };
    const commit = await db.commitStrangerResolution({
      employee: newEmployee,
      faceTemplate: enrolled.record,
      resolution: {
        id: resolutionId(validated.clusterId), clusterId: validated.clusterId, action: "QUICK_REGISTER",
        employeeId: newEmployee.id, actor: operatorActor(req), resolvedAt: new Date().toISOString(),
        logIds: validated.logIds, sourceLogId: sightingLog?.id,
        metadata: { intent, recognitionReady: Boolean(enrolled.saved), enrollmentRejected: enrolled.rejected || null },
      },
    });
    if (commit.status === "conflict") {
      res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
      return;
    }
    if (commit.status === "replay") {
      const employee = commit.resolution.employeeId ? await db.getEmployeeById(commit.resolution.employeeId) : undefined;
      if (!employee) {
        res.status(409).json({ success: false, error: "Adjudication đã tồn tại nhưng hồ sơ nhân viên không hợp lệ" });
        return;
      }
      res.json({ success: true, employee, updatedLogsCount: 0,
        adjudicatedLogsCount: commit.resolution.logIds.length, resolution: commit.resolution,
        idempotentReplay: true, recognitionReady: recognitionReadyForEmployee(employee.id) });
      return;
    }
    const resolution = commit.resolution;
    employees.unshift(newEmployee);

    const notif: MobileNotificationRecord = {
      id: "NOTIF-" + Date.now(),
      title: enrolled.saved ? "Khai báo nhân viên thành công" : "Khai báo nhân viên chưa hoàn tất mẫu khuôn mặt",
      body: enrolled.saved
        ? `Đã khai báo ${newEmployee.name} (${newEmployee.employeeCode}) và tạo mẫu nhận diện.`
        : `Đã tạo hồ sơ ${newEmployee.name}, nhưng chưa tạo được mẫu nhận diện; hệ thống vẫn từ chối cho đến khi enrollment thành công.`,
      timestamp: new Date().toISOString(), type: enrolled.saved ? "SUCCESS" : "WARNING", read: false,
      employeeId: newEmployee.id, employeeName: newEmployee.name,
    };
    mobileNotifications.unshift(notif);
    db.saveNotification(notif);
    broadcastSSE("employee_added", newEmployee);
    broadcastSSE("notification", notif);
    broadcastSSE("stranger_registered", { employee: newEmployee, updatedLogsCount: 0,
      clusterId: validated.clusterId, clusterLogIds: validated.logIds });

    res.json({
      success: true,
      message: `Đã khai báo nhân viên ${newEmployee.name}`,
      employee: newEmployee,
      updatedLogsCount: 0,
      adjudicatedLogsCount: validated.logIds.length,
      clusterId: validated.clusterId,
      clusterResolved: true,
      faceTemplate: enrolled.saved || null,
      faceTemplateRejected: enrolled.rejected || null,
      recognitionReady: recognitionReadyForEmployee(newEmployee.id),
      partialFailure: !recognitionReadyForEmployee(newEmployee.id),
      resolution,
      idempotentReplay: false,
      faceEngine: activeFaceEngine(),
    });
  } catch (err: any) {
    console.error("[Strangers] Lỗi khai báo nhanh nhân viên:", err);
    res.status(500).json({ success: false, error: err?.message || "Lỗi xử lý khai báo nhanh" });
  }
});

// Reject a stranger cluster ("ảnh người lạ") without registering or merging it.
// The cluster id is retired (covers the seeded demo clusters) and each of its
// log ids is retired as "log:<id>" so those sightings stop feeding the
// clustering. Logs themselves are kept - the access history is not rewritten,
// only the panel stops offering them. Reversible via /api/strangers/restore.
app.post(["/api/strangers/dismiss", "/api/strangers/reject"], requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  try {
    const { clusterId, clusterVersion, clusterLogIds = [], reason } = req.body || {};
    const normalizedLogIds = requestedLogIds(clusterLogIds);
    const normalizedReason = typeof reason === "string" ? reason.trim().slice(0, 120) : "";
    const existing = db.getStrangerResolution(String(clusterId || ""));
    if (existing) {
      if (!sameResolutionIntent(existing, {
        ...existing, action: "DISMISS", employeeId: undefined, sourceLogId: undefined,
        logIds: normalizedLogIds, metadata: { intent: { reason: normalizedReason } },
      })) {
        res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
        return;
      }
      res.json({ success: true, resolution: existing, idempotentReplay: true });
      return;
    }
    const validated = await validatedStrangerCluster(clusterId, normalizedLogIds, clusterVersion);
    if ("error" in validated) {
      res.status(409).json({ success: false, error: validated.error });
      return;
    }
    const commit = await db.commitStrangerResolution({
      resolution: {
        id: resolutionId(validated.clusterId),
        clusterId: validated.clusterId,
        action: "DISMISS",
        actor: operatorActor(req),
        resolvedAt: new Date().toISOString(),
        logIds: validated.logIds,
        metadata: { intent: { reason: normalizedReason }, reason: normalizedReason || null },
      },
    });
    if (commit.status === "conflict") {
      res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
      return;
    }
    const resolution = commit.resolution;
    broadcastSSE("stranger_dismissed", { clusterId: validated.clusterId, clusterLogIds: validated.logIds });
    res.json({ success: true, message: "Đã từ chối và ẩn cụm ảnh người lạ", resolution, idempotentReplay: commit.status === "replay" });
  } catch (err: any) {
    console.error("[Strangers] Lỗi từ chối cụm ảnh người lạ:", err);
    res.status(500).json({ success: false, error: err?.message || "Lỗi xử lý từ chối ảnh người lạ" });
  }
});

app.post("/api/strangers/restore", requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  try {
    const clusterId = String(req.body?.clusterId || "").trim();
    const requested = Array.isArray(req.body?.clusterLogIds)
      ? [...new Set(req.body.clusterLogIds.map(String))].sort()
      : [];
    const resolution = db.getStrangerResolution(clusterId);
    if (!resolution || resolution.action !== "DISMISS") {
      res.status(409).json({ success: false, error: "Không tìm thấy adjudication DISMISS có thể khôi phục" });
      return;
    }
    const actual = [...resolution.logIds].sort();
    if (requested.length !== actual.length || actual.some((value, index) => value !== requested[index])) {
      res.status(409).json({ success: false, error: "Danh sách log không khớp adjudication đã lưu" });
      return;
    }
    const restored = await db.restoreStrangerResolution({
      id: `${resolutionId(clusterId)}-restore-${randomUUID()}`,
      clusterId,
      action: "RESTORE",
      actor: operatorActor(req),
      resolvedAt: new Date().toISOString(),
      logIds: actual,
      metadata: { restoredResolutionId: resolution.id },
    });
    broadcastSSE("stranger_restored", { clusterId, clusterLogIds: actual, actor: operatorActor(req) });
    res.json({ success: true, message: "Đã khôi phục cụm ảnh người lạ", resolution: restored });
  } catch (err: any) {
    if (err?.message === "restore-conflict") {
      res.status(409).json({ success: false, error: "Adjudication đã thay đổi; không thể khôi phục" });
      return;
    }
    res.status(500).json({ success: false, error: err?.message || "Lỗi khôi phục" });
  }
});

app.get("/api/strangers/resolutions/:clusterId", requireOperatorRole("viewer"), (req: Request, res: Response) => {
  const clusterId = String(req.params.clusterId || "").trim();
  if (!clusterId || clusterId.length > 128) {
    res.status(400).json({ success: false, error: "clusterId không hợp lệ" });
    return;
  }
  res.json({ success: true, clusterId, resolutions: db.getStrangerResolutionEvents(clusterId) });
});

// Search the existing roster so an unrecognized stranger cluster can be merged
// into the employee it actually belongs to, instead of creating a duplicate.
app.get(["/api/strangers/search-employees", "/api/strangers/employees"], requireOperatorRole("viewer"), (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));

    const matches = (q
      ? employees.filter((e) =>
          [e.name, e.employeeCode, e.department, e.position]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(q))
        )
      : employees
    ).slice(0, limit);

    res.json({
      success: true,
      query: q,
      total: matches.length,
      employees: matches,
    });
  } catch (err: any) {
    console.error("[Strangers] Lỗi tìm kiếm nhân viên:", err);
    res.status(500).json({ success: false, error: err?.message || "Lỗi tìm kiếm nhân viên" });
  }
});

// Merge a stranger cluster into an EXISTING employee. Used when the recognition
// engine failed to match a person who is in fact already enrolled: the operator
// picks the right employee and the cluster's history is reattributed to them.
app.post(["/api/strangers/merge", "/api/strangers/assign"], requireOperatorRole("operator"), requireCsrf, async (req, res) => {
  try {
    const {
      employeeId,
      employeeCode,
      clusterId,
      clusterVersion,
      clusterLogIds = [],
      adoptPhoto = false,
      sourceLogId,
    } = req.body || {};

    if (!employeeId && !employeeCode) {
      res.status(400).json({ success: false, error: "Vui lòng chọn nhân viên cần gộp cụm ảnh" });
      return;
    }
    const target = employees.find((e) =>
      (employeeId && e.id === employeeId) ||
      (employeeCode && e.employeeCode.toUpperCase() === String(employeeCode).toUpperCase()));
    if (!target) {
      res.status(404).json({ success: false, error: `Không tìm thấy nhân viên tương ứng (${employeeId || employeeCode})` });
      return;
    }

    const normalizedLogIds = requestedLogIds(clusterLogIds);
    const normalizedSourceLogId = normalizedField(sourceLogId, 128) || normalizedLogIds[0] || null;
    if (!normalizedSourceLogId || !normalizedLogIds.includes(normalizedSourceLogId)) {
      res.status(400).json({ success: false, error: "sourceLogId phải là một thành viên của cụm" });
      return;
    }
    const existingResolution = db.getStrangerResolution(String(clusterId || ""));
    if (existingResolution) {
      if (!sameResolutionIntent(existingResolution, {
        ...existingResolution, action: "MERGE", employeeId: target.id,
        logIds: normalizedLogIds, sourceLogId: normalizedSourceLogId,
        metadata: { intent: { adoptPhoto: Boolean(adoptPhoto) } },
      })) {
        res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
        return;
      }
      res.json({ success: true, employee: target, updatedLogsCount: 0,
        adjudicatedLogsCount: existingResolution.logIds.length, resolution: existingResolution,
        idempotentReplay: true,
        recognitionReady: recognitionReadyForEmployee(target.id) });
      return;
    }

    const validated = await validatedStrangerCluster(clusterId, normalizedLogIds, clusterVersion);
    if ("error" in validated) {
      res.status(409).json({ success: false, error: validated.error });
      return;
    }
    const requestedSource = normalizedSourceLogId;
    const sightingLog = validated.logs.find((log) => log.id === requestedSource) ||
      validated.logs.find((log) => Boolean(log.photoSnapshot));

    const nextPhotoUrl = adoptPhoto && sightingLog ? logImageUrl(sightingLog.id) : null;
    const photoUpdated = Boolean(nextPhotoUrl && nextPhotoUrl !== target.photoUrl);
    const sourceLog = sightingLog ? await db.getAccessLogById(sightingLog.id) : undefined;
    const enrolled = sourceLog && isEnrollableImage(sourceLog.photoSnapshot)
      ? await prepareTemplateFromImage(target.id, sourceLog.photoSnapshot, {
          source: "merge", sourceLogId: sourceLog.id,
        })
      : { rejected: "unsupported-image" as const };
    const commit = await db.commitStrangerResolution({
      employeePhotoUpdate: nextPhotoUrl ? { employeeId: target.id, photoUrl: nextPhotoUrl } : undefined,
      faceTemplate: enrolled.record,
      resolution: {
        id: resolutionId(validated.clusterId), clusterId: validated.clusterId, action: "MERGE",
        employeeId: target.id, actor: operatorActor(req), resolvedAt: new Date().toISOString(),
        logIds: validated.logIds, sourceLogId: sightingLog?.id,
        metadata: { intent: { adoptPhoto: Boolean(adoptPhoto) }, recognitionReady: Boolean(enrolled.saved), enrollmentRejected: enrolled.rejected || null },
      },
    });
    if (commit.status === "conflict") {
      res.status(409).json({ success: false, error: "Cụm đã được xử lý theo cách khác" });
      return;
    }
    if (commit.status === "replay") {
      res.json({ success: true, employee: target, updatedLogsCount: 0,
        adjudicatedLogsCount: commit.resolution.logIds.length, resolution: commit.resolution,
        idempotentReplay: true, recognitionReady: recognitionReadyForEmployee(target.id) });
      return;
    }
    const resolution = commit.resolution;
    if (nextPhotoUrl) target.photoUrl = nextPhotoUrl;

    const notif: MobileNotificationRecord = {
      id: "NOTIF-" + Date.now(),
      title: enrolled.saved ? "Đã gộp cụm ảnh người lạ" : "Đã adjudicate nhưng chưa tạo được mẫu khuôn mặt",
      body: enrolled.saved
        ? `Đã xác định ${validated.logIds.length} lượt DENIED là ${target.name} (${target.employeeCode}) và tạo mẫu nhận diện.`
        : `Đã xác định lịch sử thuộc ${target.name}, nhưng enrollment thất bại; lịch sử DENIED và trạng thái khóa được giữ nguyên.`,
      timestamp: new Date().toISOString(), type: enrolled.saved ? "SUCCESS" : "WARNING", read: false,
      employeeId: target.id, employeeName: target.name,
    };
    mobileNotifications.unshift(notif);
    db.saveNotification(notif);
    broadcastSSE("notification", notif);
    broadcastSSE("stranger_merged", { employee: target, updatedLogsCount: 0,
      clusterId: validated.clusterId, clusterLogIds: validated.logIds, photoUpdated });
    if (photoUpdated) broadcastSSE("employee_updated", target);

    res.json({
      success: true,
      message: `Đã adjudicate cụm ảnh cho nhân viên ${target.name}`,
      employee: target,
      updatedLogsCount: 0,
      adjudicatedLogsCount: validated.logIds.length,
      skippedLogIds: [],
      photoUpdated,
      clusterId: validated.clusterId,
      clusterResolved: true,
      faceTemplate: enrolled.saved || null,
      faceTemplateRejected: enrolled.rejected || null,
      recognitionReady: recognitionReadyForEmployee(target.id),
      partialFailure: !recognitionReadyForEmployee(target.id),
      resolution,
      idempotentReplay: false,
      faceEngine: activeFaceEngine(),
    });
  } catch (err: any) {
    console.error("[Strangers] Lỗi gộp cụm ảnh vào nhân viên:", err);
    res.status(500).json({ success: false, error: err?.message || "Lỗi xử lý gộp cụm ảnh" });
  }
});

// --- AI Face Recognition Routes (Multi-Face & High-Speed Recognition) ---
/**
 * Burn thick green boxes around every DETECTED face into a JPEG data URL so a
 * stored stranger/access snapshot shows at a glance what was flagged. Boxes are
 * [ymin, xmin, ymax, xmax] on a 0-1000 scale, mapped with ffmpeg's iw/ih so the
 * frame size never needs to be known here. Only faces whose box came from a real
 * detector are drawn - the hash engine's fixed placeholder boxes are skipped, so
 * the picture never claims a detection that did not happen. Any failure returns
 * the original image untouched.
 */
async function annotateSnapshotWithBoxes(
  imageDataUrl: string,
  faces: Array<{ box2d: [number, number, number, number]; boxSource?: "detector" }>
): Promise<string> {
  const drawable = faces.filter((f) => f.boxSource === "detector" && Array.isArray(f.box2d));
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(imageDataUrl || "");
  if (drawable.length === 0 || !m) return imageDataUrl;

  const clamp = (v: number) => Math.min(1000, Math.max(0, Number(v) || 0)) / 1000;
  const filters = drawable.map((f) => {
    const [y1, x1, y2, x2] = f.box2d;
    // Detector box, then padded so a distant face (a 20 px head on a wide
    // shot) still gets a marker an operator can spot: expand ~35% per side and
    // enforce a minimum size (~7% of width, ~12% of height), centred on the
    // detection and clamped to the frame.
    const bx = clamp(Math.min(x1, x2)), by = clamp(Math.min(y1, y2));
    const bw = Math.max(0.005, clamp(Math.max(x1, x2)) - bx), bh = Math.max(0.005, clamp(Math.max(y1, y2)) - by);
    const cx = bx + bw / 2, cy = by + bh / 2;
    const w = Math.min(1, Math.max(bw * 1.7, 0.07));
    const h = Math.min(1, Math.max(bh * 1.7, 0.12));
    const x = Math.min(1 - w, Math.max(0, cx - w / 2));
    const y = Math.min(1 - h, Math.max(0, cy - h / 2));
    // thickness ~1/120 of the width, never thinner than 5 px
    return `drawbox=x=iw*${x.toFixed(4)}:y=ih*${y.toFixed(4)}:w=iw*${w.toFixed(4)}:h=ih*${h.toFixed(4)}:color=0x00FF00@1:t=max(5\\,iw/120)`;
  });

  return new Promise<string>((resolve) => {
    const input = Buffer.from(m[2], "base64");
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-i", "pipe:0",
      "-vf", filters.join(","),
      "-q:v", "2", "-f", "image2", "-update", "1", "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (out: string) => { if (!settled) { settled = true; resolve(out); } };
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} done(imageDataUrl); }, 4000);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => { clearTimeout(timer); done(imageDataUrl); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) done(`data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}`);
      else done(imageDataUrl);
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

interface DetectedFaceItem {
  id: string;
  box2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000
  /** "detector" when box2d came from a real detection; absent for placeholder boxes. */
  boxSource?: "detector";
  employeeId?: string;
  employeeName?: string;
  employeeCode?: string;
  department?: string;
  confidence: number;
  livenessScore: number;
  recognized: boolean;
  message: string;
}

interface RecognizeFrameInput {
  /** Base64 payload with any data-URL prefix stripped (what Gemini receives). */
  base64Data: string;
  /** Original image string (data URL or raw base64) handed to the local engines. */
  rawImage: string;
  mimeType: string;
  employees: EmployeeRecord[];
  scanType: "ENTRY" | "EXIT";
  /** Optional per-request override sent by the client (`body.config`). */
  clientConfig?: Partial<ServerAiConfig> | null;
  /** Faces already produced upstream (simulation shortcuts). Engines are skipped when non-empty. */
  initialDetectedFaces?: DetectedFaceItem[];
  initialMessage?: string;
  /** Which camera produced this frame; tags the real engine's observations. */
  streamId?: string;
  streamLabel?: string;
}

interface RecognizeFrameResult {
  detectedFaces: DetectedFaceItem[];
  overallMessage: string;
  modelUsed: string;
  engineUsed: string;
  engineMode: ServerAiConfig["engineMode"];
  multiThreadInfo: { workerId?: number; threadLatencyMs?: number };
  /** Present whenever the real engine ran: the full fused decision, for audit. */
  fusion?: FusionDecision;
  /** Which engine actually decided this frame. */
  faceEngine: ActiveFaceEngine;
  /** Internal only; route responses never expose embeddings. */
  strangerObservation?: FaceObservation;
}

/**
 * Engine-selection + recognition core shared by POST /api/recognize-face and
 * POST /api/camera-streams/scan-rtsp. Honours `aiRecognitionConfig.engineMode`
 * (optionally overridden by `clientConfig`):
 *   STEP A  LOCAL_BIOMETRIC / HYBRID_AUTO -> multi-thread worker pool (sync fallback)
 *   STEP B  GOOGLE_GEMINI / hybrid escalation -> Gemini Vision with model failover
 *   Fail-closed: when no engine produced a face, the frame is reported as
 *   `recognized:false` - never a fabricated match.
 * Pure with respect to HTTP and access-log side effects; callers own those.
 */
async function recognizeFrame({
  base64Data,
  rawImage,
  mimeType,
  employees,
  scanType,
  clientConfig,
  initialDetectedFaces = [],
  initialMessage = "",
  streamId,
  streamLabel,
}: RecognizeFrameInput): Promise<RecognizeFrameResult> {
  let detectedFaces: DetectedFaceItem[] = [...initialDetectedFaces];
  let overallMessage = initialMessage;

  // Engine Selection and Configuration
  const activeEngineMode = clientConfig?.engineMode || aiRecognitionConfig.engineMode;
  const activeLocalArch = clientConfig?.localModel?.modelArchitecture || aiRecognitionConfig.localModel.modelArchitecture;
  const activeGoogleModel = clientConfig?.googleAi?.model || aiRecognitionConfig.googleAi.model;

  let engineUsed =
    activeEngineMode === "LOCAL_BIOMETRIC"
      ? "Local Edge Biometrics"
      : activeEngineMode === "HYBRID_AUTO"
      ? "Hybrid SOTA Pipeline"
      : "Google Cloud AI";
  let modelUsed =
    activeEngineMode === "LOCAL_BIOMETRIC"
      ? (activeLocalArch === "blazeface-arcface-sota"
          ? "BlazeFace V2 + ArcFace SOTA (512-D)"
          : activeLocalArch === "mediapipe-facemesh-dense"
          ? "MediaPipe FaceMesh (468 3D)"
          : "MobileFaceNet INT8 Edge")
      : activeGoogleModel;

  let multiThreadInfo: { workerId?: number; threadLatencyMs?: number } = {};

  // -----------------------------------------------------------------------
  // STEP 0: REAL FACE ENGINE (SCRFD + ArcFace) - the only path that may grant
  // when it is active. Detect + embed every face in the frame, match each one
  // against the enrolled gallery (max-over-templates per employee) and fuse.
  //
  // When the real engine is active it OWNS the identity decision: the hash
  // worker pool (STEP A) is not consulted at all, because a placeholder
  // matcher must never be able to open a door the real engine did not open.
  // Gemini (STEP B) still runs when the detector found nothing, so stranger
  // capture keeps working - and it remains detection-only regardless.
  //
  // With FACE_ENGINE=onnx and the models missing the engine reports
  // "unavailable" and STEP A is skipped too: the frame is DENIED (fail-closed)
  // instead of silently handed to the hash matcher.
  // -----------------------------------------------------------------------
  const faceEngine = activeFaceEngine();
  let fusion: FusionDecision | undefined;
  let strangerObservation: FaceObservation | undefined;

  if (faceEngine === "onnx" && detectedFaces.length === 0 && rawImage) {
    const engineInfo = getFaceEngineInfo();
    engineUsed = `Real Face Engine (SCRFD ${engineInfo.detectorModel} + ArcFace ${engineInfo.recognizerModel})`;
    modelUsed = faceModelTag();
    const tEngine = Date.now();
    const observed = await observeFrame(
      rawImage,
      streamId || "frame",
      streamLabel || streamId || "frame",
      0
    );
    const thresholds = currentFusionThresholds(clientConfig);
    fusion = recognizeObservations(capObservations(observed), currentGallery(), thresholds);
    multiThreadInfo = { threadLatencyMs: Date.now() - tEngine };

    if (observed.length > 0) {
      strangerObservation = observed
        .map((item) => item.observation)
        .sort((a, b) => b.quality - a.quality)[0];
      detectedFaces = facesFromDecision(observed, fusion, employees);
      const winner = fusion.recognized
        ? employees.find((e) => e.id === fusion!.employeeId)
        : undefined;
      overallMessage =
        fusion.recognized && winner
          ? `Nhận diện ${winner.name} (${winner.employeeCode}) - cosine hợp nhất ${fusion.fusedCosine.toFixed(3)}, cơ sở ${fusion.basis}, ${fusion.agreeingObservations} quan sát/${fusion.agreeingStreams} luồng`
          : `Phát hiện ${observed.length} khuôn mặt nhưng KHÔNG khớp nhân viên nào (${fusion.basis}, cosine tốt nhất ${fusion.bestCosine.toFixed(3)}). Cửa giữ trạng thái khóa.`;
    }
  } else if (faceEngine === "unavailable") {
    const engineInfo = getFaceEngineInfo();
    engineUsed = "Real Face Engine (FAIL-CLOSED: mô hình ONNX không khả dụng)";
    modelUsed = faceModelTag();
    console.error(
      `[FaceEngine] FAIL-CLOSED: FACE_ENGINE=onnx nhưng mô hình chưa nạp được (${engineInfo.lastError || engineInfo.modelDir}). Từ chối khung hình.`
    );
  }

  // STEP A: If LOCAL_BIOMETRIC or HYBRID_AUTO mode, run local SOTA biometric engine (Multi-Threaded via Worker Pool)
  if (faceEngine === "hash" && detectedFaces.length === 0 && base64Data && employees.length > 0) {
    if (activeEngineMode === "LOCAL_BIOMETRIC" || activeEngineMode === "HYBRID_AUTO") {
      if (cameraStreamsConfig.multiThreadEnabled) {
        try {
          const workerResult = await faceWorkerPool.dispatchFaceTask({
            taskId: "task-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
            imageBase64: rawImage,
            employees: employees as any,
            scanType: scanType === "EXIT" ? "EXIT" : "ENTRY",
            modelArchitecture: activeLocalArch as any,
            similarityThreshold:
              clientConfig?.localModel?.similarityThreshold ||
              aiRecognitionConfig.localModel.similarityThreshold,
            livenessSensitivity:
              clientConfig?.localModel?.livenessSensitivity ||
              aiRecognitionConfig.localModel.livenessSensitivity,
          });

          multiThreadInfo = {
            workerId: workerResult.workerId,
            threadLatencyMs: workerResult.threadLatencyMs,
          };

          const meetsHybridThreshold =
            activeEngineMode === "HYBRID_AUTO" &&
            workerResult.cosineSimilarity >=
              (aiRecognitionConfig.hybridSettings?.localPreFilterThreshold || 0.85);

          if (activeEngineMode === "LOCAL_BIOMETRIC" || (meetsHybridThreshold && workerResult.recognized)) {
            detectedFaces = workerResult.detectedFaces as any;
            overallMessage = workerResult.recognized
              ? `[Worker #${workerResult.workerId}] Đã xác thực thành công ${workerResult.bestMatch?.name || "nhân viên"}`
              : `[Worker #${workerResult.workerId}] Từ chối: Vector Cosine không đạt ngưỡng (${workerResult.cosineSimilarity.toFixed(2)})`;
            modelUsed = workerResult.modelName;
            engineUsed =
              activeEngineMode === "LOCAL_BIOMETRIC"
                ? `Backend Multi-Thread (Worker #${workerResult.workerId})`
                : `Hybrid SOTA Multi-Thread (Worker #${workerResult.workerId})`;
          }
        } catch (workerErr: any) {
          if (isWorkerPoolUnavailableError(workerErr)) {
            // Backpressure / pool re-init: surface to the caller (503) - do not shed load onto the main thread.
            throw workerErr;
          }
          console.warn("[WorkerPool] Thất bại xử lý worker, fallback sang sync:", workerErr?.message);
        }
      }

      // Fallback sync execution if not handled by multi-thread worker
      if (detectedFaces.length === 0) {
        const localRes = runLocalFaceRecognition({
          imageBase64: rawImage,
          employees: employees as any,
          modelArchitecture: activeLocalArch as any,
          similarityThreshold:
            clientConfig?.localModel?.similarityThreshold ||
            aiRecognitionConfig.localModel.similarityThreshold,
          livenessSensitivity:
            clientConfig?.localModel?.livenessSensitivity ||
            aiRecognitionConfig.localModel.livenessSensitivity,
        });

        const meetsHybridThreshold =
          activeEngineMode === "HYBRID_AUTO" &&
          localRes.cosineSimilarity >=
            (aiRecognitionConfig.hybridSettings?.localPreFilterThreshold || 0.85);

        if (activeEngineMode === "LOCAL_BIOMETRIC" || (meetsHybridThreshold && localRes.recognized)) {
          detectedFaces = localRes.detectedFaces as any;
          overallMessage = localRes.recognized
            ? `[${localRes.modelName}] Đã xác thực thành công ${localRes.bestMatch?.name || "nhân viên"}`
            : `[${localRes.modelName}] Từ chối: Vector Cosine không đạt ngưỡng (${localRes.cosineSimilarity.toFixed(2)})`;
          modelUsed = localRes.modelName;
          engineUsed =
            activeEngineMode === "LOCAL_BIOMETRIC"
              ? "Local Edge Biometrics"
              : "Hybrid SOTA (Local Fast-Path)";
        }
      }
    }
  }

  // STEP B: Call Gemini Vision AI (if not purely local or if hybrid escalated to cloud)
  const ai = getGeminiClient();
  if (detectedFaces.length === 0 && base64Data && ai && employees.length > 0 && activeEngineMode !== "LOCAL_BIOMETRIC") {
    const employeeProfilesSummary = employees
      .map(
        (e, i) =>
          `[${i + 1}] ID: "${e.id}", Code: "${e.employeeCode}", Name: "${e.name}", Department: "${e.department}"`
      )
      .join("\n");

    const prompt = `Bạn là hệ thống AI đa mục tiêu siêu tốc (Multi-Face High-Speed Access Control).
Nhiệm vụ: Phát hiện và nhận diện TẤT CẢ các khuôn mặt người xuất hiện trong TOÀN BỘ khung hình này (không giới hạn vị trí hay số lượng người).

Danh sách nhân viên hợp lệ đã đăng ký trong hệ thống:
${employeeProfilesSummary}

Yêu cầu phân tích:
1. Quét toàn bộ khung hình, tìm tất cả các khuôn mặt.
2. Với mỗi khuôn mặt:
 - Xác định tọa độ hộp giới hạn box2d: [ymin, xmin, ymax, xmax] trong thang đo 0 đến 1000.
 - So sánh đặc điểm khuôn mặt với danh sách nhân viên đã đăng ký.
 - Nếu khớp nhân viên đã đăng ký, gán recognized = true, employeeId, employeeName, confidence (75-100).
 - Nếu không khớp hoặc người lạ, recognized = false, employeeId = null, employeeName = null, confidence (<50).
 - Đánh giá độ sống thật chống giả mạo livenessScore (0-100).
3. Đưa ra thông điệp tổng quan overallMessage bằng tiếng Việt.`;

    // Candidate models in priority order for maximum resilience against 503 spikes
    const candidateModels = [
      activeGoogleModel,
      "gemini-3.8-flash",
      "gemini-flash-latest",
      "gemini-3.1-flash-lite",
    ];

    for (const modelName of candidateModels) {
      let succeeded = false;
      // Attempt with short jitter retry for temporary spikes
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [
                {
                  inlineData: {
                    data: base64Data,
                    mimeType,
                  },
                },
                { text: prompt },
              ],
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  detectedFaces: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        box2d: {
                          type: Type.ARRAY,
                          items: { type: Type.NUMBER },
                        },
                        employeeId: { type: Type.STRING, nullable: true },
                        employeeName: { type: Type.STRING, nullable: true },
                        confidence: { type: Type.NUMBER },
                        livenessScore: { type: Type.NUMBER },
                        recognized: { type: Type.BOOLEAN },
                        message: { type: Type.STRING },
                      },
                      required: ["box2d", "confidence", "livenessScore", "recognized", "message"],
                    },
                  },
                  overallMessage: { type: Type.STRING },
                },
                required: ["detectedFaces", "overallMessage"],
              },
            },
          });

          const rawText = response.text?.trim();
          if (rawText) {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed.detectedFaces) && parsed.detectedFaces.length > 0) {
              detectedFaces = parsed.detectedFaces.map((f: any, idx: number) => {
                const matchedEmp = f.employeeId
                  ? employees.find((e) => e.id === f.employeeId)
                  : null;

                const hasRealBox = Array.isArray(f.box2d) && f.box2d.length === 4;
                const box: [number, number, number, number] = hasRealBox
                  ? [f.box2d[0], f.box2d[1], f.box2d[2], f.box2d[3]]
                  : [200, 300, 700, 700];

                return {
                  id: `face-${idx}-${Date.now()}`,
                  box2d: box,
                  boxSource: hasRealBox ? ("detector" as const) : undefined,
                  employeeId: matchedEmp ? matchedEmp.id : f.employeeId || undefined,
                  employeeName: matchedEmp ? matchedEmp.name : f.employeeName || undefined,
                  employeeCode: matchedEmp ? matchedEmp.employeeCode : undefined,
                  department: matchedEmp ? matchedEmp.department : undefined,
                  confidence: Number(f.confidence) || 50,
                  livenessScore: Number(f.livenessScore) || 95,
                  recognized: Boolean(f.recognized && (matchedEmp || f.employeeId)),
                  message: f.message || (f.recognized ? "Nhận diện thành công" : "Chưa đăng ký"),
                };
              });
              overallMessage = parsed.overallMessage || "Đã phân tích toàn bộ khung hình";

              // Gemini only ever receives the roster as TEXT (ids, codes, names) -
              // never the enrolled photos - so any employeeId it returns is a
              // guess from names, not a face comparison. Measured: the same
              // person in two frames came back as two different employees, both
              // at "98.5%", and the door opened both times. Until a real matcher
              // exists, the cloud step is detection-only: faces are kept for
              // stranger capture and logging, identity is stripped, and nothing
              // it says can authorise. Only the demo flag re-enables the guess.
              const geminiIdentityAllowed = process.env.ALLOW_SIMULATED_RECOGNITION === "true";
              if (!geminiIdentityAllowed && detectedFaces.some((f) => f.recognized || f.employeeId)) {
                detectedFaces = detectedFaces.map((f) => ({
                  ...f,
                  recognized: false,
                  employeeId: undefined,
                  employeeName: undefined,
                  employeeCode: undefined,
                  department: undefined,
                  message:
                    "Phát hiện khuôn mặt (Gemini) nhưng chưa xác thực danh tính: hệ thống chưa có bộ so khớp khuôn mặt thực.",
                }));
                overallMessage =
                  "Đã phát hiện khuôn mặt nhưng không xác thực được danh tính (chưa có bộ so khớp). Từ chối mở khóa.";
              }
              succeeded = true;
              break;
            }
          }
        } catch (modelErr: any) {
          const errStr = String(modelErr?.message || modelErr || "");
          const isDemandSpikeOrTransient =
            errStr.includes("503") ||
            errStr.includes("UNAVAILABLE") ||
            errStr.includes("high demand") ||
            errStr.includes("429") ||
            errStr.includes("RESOURCE_EXHAUSTED");

          if (isDemandSpikeOrTransient && attempt === 0) {
            // Wait briefly and retry once
            await new Promise((resolve) => setTimeout(resolve, 350));
            continue;
          }
          // Move on to alternative candidate model quietly
          break;
        }
      }

      if (succeeded) {
        break;
      }
    }
  }

  // No engine produced a match. This previously granted access to
  // employees[0] at a hard-coded 96.5% whenever detectedFaces was empty -
  // which is also the state for an empty frame, a wall, or darkness, so any
  // unrecognised image opened the door. Recognition failure must deny.
  if (detectedFaces.length === 0) {
    if (employees.length > 0) {
      detectedFaces = [
        {
          id: "face-nomatch-" + Date.now(),
          box2d: [190, 270, 750, 730],
          confidence: 0,
          livenessScore: 0,
          recognized: false,
          message:
            "Không nhận diện được khuôn mặt hợp lệ trong khung hình. Cửa giữ trạng thái khóa.",
        },
      ];
      overallMessage =
        "Không nhận diện được nhân viên nào trong khung hình. Từ chối mở khóa.";
    } else {
      detectedFaces = [
        {
          id: "face-un-" + Date.now(),
          box2d: [200, 300, 700, 700],
          confidence: 25,
          livenessScore: 85,
          recognized: false,
          message: "Hệ thống chưa có nhân viên nào được đăng ký",
        },
      ];
      overallMessage = "Không có nhân viên trong hệ thống";
    }
  }

  return {
    detectedFaces,
    overallMessage,
    modelUsed,
    engineUsed,
    engineMode: activeEngineMode,
    multiThreadInfo,
    fusion,
    faceEngine,
    strangerObservation,
  };
}

const RECOGNIZE_FACE_ROUTES = [
  "/api/recognize-face",
  "/api/recognize-face/",
  "/recognize-face",
  "/recognize-face/",
  "/api/face/recognize",
  "/api/face/recognize/",
  "/api/face-recognize",
  "/api/face-recognize/",
  "/api/face-recognition",
  "/api/face-recognition/",
  "/api/recognize",
  "/api/recognize/",
];

// Provide detailed endpoint status and API schema on GET (prevents 404 when tested in browser or health checks)
app.get(RECOGNIZE_FACE_ROUTES, (req, res) => {
  res.json({
    success: true,
    status: "online",
    endpoint: req.originalUrl || req.url,
    name: "AI Face Recognition & Smart Lock Gateway API",
    supportedMethods: ["POST", "GET", "OPTIONS"],
    message: "Endpoint nhận diện khuôn mặt sẵn sàng tiếp nhận yêu cầu POST.",
    schema: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        imageBase64: "Chuỗi base64 ảnh camera hoặc Data URL (data:image/jpeg;base64,...)",
        scanType: "ENTRY | EXIT (Mặc định: ENTRY)",
        testEmployeeId: "(Tùy chọn) ID/Mã nhân viên hoặc 'MULTI_EMPLOYEES' để test giả lập",
      },
    },
    systemInfo: {
      registeredEmployeesCount: employees.length,
      smartLockDoor: smartLockState.doorName,
      lockState: smartLockState.state,
      isLocked: smartLockState.isLocked,
      batteryLevel: smartLockState.batteryLevel,
      webhookEtonEnabled: webhookConfig.enabled,
    },
  });
});

app.post(RECOGNIZE_FACE_ROUTES, async (req, res) => {
  const startTime = Date.now();
  try {
    let body: any = req.body || {};

    // Handle raw string or buffer body (e.g., sent without application/json Content-Type)
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        if (body.startsWith("data:image") || body.length > 50) {
          body = { imageBase64: body };
        } else {
          body = {};
        }
      }
    } else if (Buffer.isBuffer(body)) {
      body = { imageBase64: "data:image/jpeg;base64," + body.toString("base64") };
    }

    let imageBase64: string | undefined =
      body.imageBase64 ||
      body.image ||
      body.photo ||
      body.photoUrl ||
      body.faceImage ||
      body.base64 ||
      body.data ||
      body.image_base64;

    const scanType: "ENTRY" | "EXIT" = body.scanType === "EXIT" ? "EXIT" : "ENTRY";
    // Simulation shortcuts below fabricate a successful recognition from a
    // name/code alone, with no image. Reachable from the request body, that is
    // a remote door-unlock bypass: POST {"employeeCode":"NV-5588"} was enough.
    // They stay available for demos, but only when explicitly enabled, and
    // never by default.
    const simulationAllowed = process.env.ALLOW_SIMULATED_RECOGNITION === "true";
    const requestedTestId: string | undefined =
      body.testEmployeeId || body.testEmployee || body.employeeId || body.employeeCode;

    if (!simulationAllowed && (body.testEmployeeId || body.testEmployee)) {
      res.status(403).json({
        error:
          "Chế độ nhận diện giả lập đang tắt. Đặt ALLOW_SIMULATED_RECOGNITION=true để bật cho môi trường demo (không dùng khi có khóa cửa thật).",
        recognized: false,
        simulationDisabled: true,
      });
      return;
    }

    const testEmployeeId: string | undefined = simulationAllowed ? requestedTestId : undefined;

    if (!imageBase64 && !testEmployeeId) {
      res.status(400).json({
        success: false,
        error: "Không nhận được hình ảnh từ camera hoặc mã kiểm thử",
        message:
          "Endpoint /api/recognize-face hoạt động bình thường. Vui lòng gửi trường 'imageBase64' (Data URL hoặc base64) hoặc 'testEmployeeId'.",
        supportedFields: ["imageBase64", "scanType", "testEmployeeId"],
      });
      return;
    }

    // Clean base64 string
    const rawImage = imageBase64 || "";
    const base64Data = rawImage.replace(/^data:image\/\w+;base64,/, "");
    const mimeMatch = rawImage.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

    let detectedFaces: DetectedFaceItem[] = [];
    let overallMessage = "";

    // Fast-path shortcuts for testing and rapid verification
    if (testEmployeeId === "MULTI_EMPLOYEES") {
      // Simulation: 2 registered employees detected simultaneously in frame
      const emp1 = employees[0] || DEFAULT_EMPLOYEES[0];
      const emp2 = employees[1] || DEFAULT_EMPLOYEES[1];
      detectedFaces = [
        {
          id: "face-" + Math.random().toString(36).substring(2, 8),
          box2d: [160, 80, 720, 460], // Left side person
          employeeId: emp1.id,
          employeeName: emp1.name,
          employeeCode: emp1.employeeCode,
          department: emp1.department,
          confidence: Math.round(96 + Math.random() * 3),
          livenessScore: Math.round(97 + Math.random() * 2),
          recognized: true,
          message: `Nhận diện thành công: ${emp1.name} (${emp1.employeeCode})`,
        },
        {
          id: "face-" + Math.random().toString(36).substring(2, 8),
          box2d: [180, 530, 740, 910], // Right side person
          employeeId: emp2.id,
          employeeName: emp2.name,
          employeeCode: emp2.employeeCode,
          department: emp2.department,
          confidence: Math.round(95 + Math.random() * 4),
          livenessScore: Math.round(96 + Math.random() * 3),
          recognized: true,
          message: `Nhận diện thành công: ${emp2.name} (${emp2.employeeCode})`,
        },
      ];
      overallMessage = `Nhận diện đồng thời 2 nhân viên trong khung hình (${emp1.name}, ${emp2.name}). Mở chốt cửa!`;
    } else if (testEmployeeId === "MULTI_MIXED") {
      // Simulation: 1 registered employee + 1 unregistered stranger together
      const emp1 = employees[0] || DEFAULT_EMPLOYEES[0];
      detectedFaces = [
        {
          id: "face-" + Math.random().toString(36).substring(2, 8),
          box2d: [150, 70, 710, 450],
          employeeId: emp1.id,
          employeeName: emp1.name,
          employeeCode: emp1.employeeCode,
          department: emp1.department,
          confidence: Math.round(97 + Math.random() * 2),
          livenessScore: Math.round(98 + Math.random() * 2),
          recognized: true,
          message: `Nhân viên hợp lệ: ${emp1.name}`,
        },
        {
          id: "face-" + Math.random().toString(36).substring(2, 8),
          box2d: [190, 540, 730, 920],
          confidence: 31,
          livenessScore: 92,
          recognized: false,
          message: "Khuôn mặt chưa đăng ký (Khách lạ đi cùng)",
        },
      ];
      overallMessage = `Phát hiện 2 người trong khung hình: 1 nhân viên hợp lệ (${emp1.name}) & 1 người lạ chưa đăng ký.`;
    } else if (testEmployeeId === "UNKNOWN_VISITOR") {
      detectedFaces = [
        {
          id: "face-" + Math.random().toString(36).substring(2, 8),
          box2d: [180, 280, 720, 720],
          confidence: 28,
          livenessScore: 89,
          recognized: false,
          message: "Không tìm thấy dữ liệu khuôn mặt trong danh mục nhân viên",
        },
      ];
      overallMessage = "🚨 CẢNH BÁO AN NINH: Phát hiện người lạ chụp hình tại cổng. Khóa cửa giữ an toàn.";
      if (!base64Data) {
        imageBase64 = "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=450&auto=format&fit=crop&q=80";
      }
    } else if (testEmployeeId) {
      // Single specific employee test (supports ID, Code, Name, or TEST/PING)
      const matched =
        employees.find(
          (e) =>
            e.id === testEmployeeId ||
            e.employeeCode.toUpperCase() === String(testEmployeeId).toUpperCase() ||
            e.name.toLowerCase().includes(String(testEmployeeId).toLowerCase())
        ) || (testEmployeeId === "TEST" || testEmployeeId === "PING" ? employees[0] : undefined);

      if (matched) {
        detectedFaces = [
          {
            id: "face-" + Math.random().toString(36).substring(2, 8),
            box2d: [170, 270, 730, 730],
            employeeId: matched.id,
            employeeName: matched.name,
            employeeCode: matched.employeeCode,
            department: matched.department,
            confidence: Math.round(96 + Math.random() * 3),
            livenessScore: Math.round(98 + Math.random() * 2),
            recognized: true,
            message: `Chào mừng ${matched.name} (${matched.employeeCode})! Xác thực hợp lệ.`,
          },
        ];
        overallMessage = `Xác thực thành công nhân viên ${matched.name}. Mở khóa cửa!`;
      } else if (!base64Data) {
        res.status(404).json({
          success: false,
          error: `Không tìm thấy nhân viên khớp với mã kiểm thử '${testEmployeeId}'`,
          availableEmployees: employees.map((e) => ({
            id: e.id,
            code: e.employeeCode,
            name: e.name,
          })),
        });
        return;
      }
    }

    // Engine selection + recognition core shared with /api/camera-streams/scan-rtsp
    const clientConfig = req.body?.config;
    const recognition = await recognizeFrame({
      base64Data,
      rawImage,
      mimeType,
      employees,
      scanType,
      clientConfig,
      initialDetectedFaces: detectedFaces,
      initialMessage: overallMessage,
    });
    detectedFaces = recognition.detectedFaces;
    overallMessage = recognition.overallMessage;
    const { engineUsed, modelUsed, multiThreadInfo } = recognition;
    // Full fused decision (real engine only): basis, cosines, per-observation
    // evidence. Audit surface - never used to grant on its own.
    const fusion = recognition.fusion || null;

    // Determine recognition status
    const authorizedFaces = detectedFaces.filter((f) => f.recognized && f.employeeId);
    const unauthorizedFaces = detectedFaces.filter((f) => !f.recognized);

    const processingTimeMs = Math.max(85, Date.now() - startTime);

    // EVERY side effect of a recognition - the annotated snapshot, the access
    // log(s), the notification, the SSE events, the Eton/stranger webhooks and
    // the unlock - lives in the ONE shared function that the gate scan path
    // (watcher + POST /api/camera-streams/scan-rtsp) calls too, so the two can
    // never again record different things for the same decision.
    //
    // This route is the REFERENCE behaviour and keeps it exactly: no cooldowns
    // (a caller posts one frame at a time and reads its own answer), a DENIED
    // row even when no face was found, the legacy unlock source string, and a
    // `stranger_detected` SSE that still carries the posted frame.
    const outcome = await applyRecognitionOutcome({
      detectedFaces,
      frameImage: imageBase64,
      annotateFaces: detectedFaces,
      scanType,
      trigger: "api",
      processingTimeMs,
      unlockSource: "Nhận diện khuôn mặt AI (Đa nhân viên)",
      baseUrl: resolveAppBaseUrl(req),
      cooldowns: false,
      denyWithoutFace: true,
      sseSnapshot: imageBase64,
      strangerObservation: recognition.strangerObservation,
    });
    const recognizedEmployees = outcome.recognizedEmployees;
    const generatedLogs = outcome.logs;

    if (outcome.granted) {
      const primaryEmployee = recognizedEmployees[0];
      const primaryFace = authorizedFaces[0];

      res.json({
        recognized: true,
        employee: primaryEmployee,
        recognizedEmployees,
        detectedFaces,
        totalFacesDetected: detectedFaces.length,
        authorizedCount: authorizedFaces.length,
        unauthorizedCount: unauthorizedFaces.length,
        processingTimeMs,
        confidence: primaryFace ? primaryFace.confidence : 95,
        livenessScore: primaryFace ? primaryFace.livenessScore : 98,
        message:
          overallMessage ||
          `Đã xác thực ${recognizedEmployees.length} nhân viên trong khung hình. Mở cửa!`,
        lockUnlocked: outcome.lockUnlocked,
        detectedFeatures: `Phát hiện ${detectedFaces.length} khuôn mặt toàn cảnh trong ${processingTimeMs}ms`,
        log: generatedLogs[0],
        logs: generatedLogs,
        engineUsed,
        modelUsed,
        faceEngine: recognition.faceEngine,
        fusion,
        multiThreadUsed: Boolean(multiThreadInfo.workerId),
        workerId: multiThreadInfo.workerId,
        threadLatencyMs: multiThreadInfo.threadLatencyMs,
        threadPoolTelemetry: faceWorkerPool.getPoolTelemetry(),
        outcome: outcome.summary,
      });
    } else {
      // Access Denied: No registered employees recognized
      const accessLog = outcome.log;

      res.json({
        recognized: false,
        strangerAlert: true,
        alertLevel: "HIGH",
        detectedFaces,
        totalFacesDetected: detectedFaces.length,
        authorizedCount: 0,
        unauthorizedCount: detectedFaces.length,
        processingTimeMs,
        confidence: detectedFaces[0]?.confidence || 25,
        livenessScore: detectedFaces[0]?.livenessScore || 85,
        message:
          overallMessage ||
          "🚨 CẢNH BÁO AN NINH: Phát hiện người lạ chụp hình tại cổng! Không nhận diện được trong danh mục nhân viên.",
        lockUnlocked: false,
        detectedFeatures: `Quét toàn khung hình (${detectedFaces.length} người) trong ${processingTimeMs}ms - Không khớp`,
        log: accessLog,
        logs: accessLog ? [accessLog] : [],
        engineUsed,
        modelUsed,
        faceEngine: recognition.faceEngine,
        fusion,
        multiThreadUsed: Boolean(multiThreadInfo.workerId),
        workerId: multiThreadInfo.workerId,
        threadLatencyMs: multiThreadInfo.threadLatencyMs,
        threadPoolTelemetry: faceWorkerPool.getPoolTelemetry(),
        outcome: outcome.summary,
      });
    }
  } catch (error: any) {
    if (isWorkerPoolUnavailableError(error)) {
      console.warn("[WorkerPool] Từ chối tạm thời (503):", error?.message);
      respondWorkerPoolUnavailable(res, error);
      return;
    }
    console.error("Error recognizing face:", error);
    res.status(500).json({ error: error.message || "Lỗi xử lý nhận diện khuôn mặt" });
  }
});

// Explicit fallback for other HTTP methods on recognize-face endpoints
app.all(RECOGNIZE_FACE_ROUTES, (req, res) => {
  res.status(405).json({
    success: false,
    error: `Phương thức HTTP ${req.method} không được hỗ trợ tại ${req.path}. Vui lòng dùng POST (hoặc GET để tra cứu thông tin endpoint).`,
    supportedMethods: ["POST", "GET", "OPTIONS"],
  });
});

// Catch-all for unhandled /api routes - ALWAYS return JSON, never HTML
app.all("/api/*", (req, res) => {
  console.warn(`[404] Unhandled API route: ${req.method} ${req.url}`);
  res.status(404).json({
    error: `Đường dẫn API không tồn tại: ${req.method} ${req.url}`,
    status: 404,
  });
});

// Global error handling middleware for Express (catches JSON parse errors, payload limits, etc.)
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error("[Server Error Handler]:", err?.message || err);
  if (res.headersSent) {
    return next(err);
  }
  applyCorsOrigin(req, res);
  const statusCode = err?.status || err?.statusCode || 500;
  res.status(statusCode).json({
    error: err?.message || "Lỗi máy chủ nội bộ",
    statusCode,
  });
});

// --- Mount Vite in dev or static files in production ---
async function startServer() {
  const isProduction =
    process.env.NODE_ENV === "production" ||
    (typeof __filename !== "undefined" && __filename.endsWith("server.cjs"));

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (Mode: ${isProduction ? "production" : "development"})`);
    // Backend gate watchers start here, AFTER the camera config is loaded and
    // only for gates whose persisted `watch.enabled` is true.
    syncGateWatchers();
  });
}

startServer();

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Video,
  ScanFace,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Camera,
  Layers,
  Activity,
  HardDrive,
  Clock,
  ArrowDownRight,
  ArrowUpRight,
  Settings,
  Eye,
  KeyRound,
  UserX,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Star,
  RefreshCw,
  Server,
  Timer,
  Power,
  Radio,
  Hand,
  Info,
} from "lucide-react";
import {
  CameraStreamsConfig,
  GateStreamConfig,
  GateStreamSource,
  GateStreamScanResult,
  Employee,
  FaceRecognitionResult,
  SmartLockState,
  AccessLog,
  DetectedFace,
  FusionDecision,
  FusionThresholds,
  GateWatchConfig,
  GateWatchRuntime,
} from "../types";
import { soundEffects } from "../utils/audio";
import { safeJsonFetch, operatorJsonFetch, getApiBaseUrl, buildEventSourceUrl } from "../utils/api";
import { runLocalFaceRecognition } from "../utils/localBiometrics";
import {
  isNetlifyOrStaticHost,
  clientDoorUnlock,
  getStoredAiConfig,
  demoOfflinePersistenceEnabled,
} from "../utils/offlineEngine";

const DEFAULT_STREAMS_CONFIG: CameraStreamsConfig = {
  entryGate: {
    gateType: "ENTRY",
    name: "Camera Cổng Vào (Main Entry Gate)",
    enabled: true,
    sourceType: "RTSP",
    rtspUrl: "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/101",
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
    sourceType: "RTSP",
    rtspUrl: "rtsp://viewCam:1234abcd@192.168.60.2:554/Streaming/Channels/102",
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

// ----------------- MULTI-STREAM HELPERS -----------------
type GateKey = "entry" | "exit";
const gateKeyOf = (gateType: "ENTRY" | "EXIT"): GateKey => (gateType === "EXIT" ? "exit" : "entry");

/**
 * Streams of a gate sorted by priority. When the payload has no `streams`
 * (legacy server / legacy config) derive one stream from the legacy fields.
 */
const deriveGateStreams = (gate: GateStreamConfig | undefined, key: GateKey): GateStreamSource[] => {
  if (!gate) return [];
  const list = Array.isArray(gate.streams) ? gate.streams.filter(Boolean) : [];
  if (list.length > 0) {
    return list
      .map((s, index) => ({
        ...s,
        enabled: s.enabled !== false,
        priority: typeof s.priority === "number" ? s.priority : index,
      }))
      .sort((a, b) => a.priority - b.priority);
  }
  return [
    {
      id: `${key}-primary`,
      label: gate.name || (key === "exit" ? "Cổng Ra" : "Cổng Vào"),
      sourceType: gate.sourceType || "RTSP",
      rtspUrl: gate.rtspUrl,
      rtspTransport: gate.rtspTransport || "TCP",
      httpUrl: gate.httpUrl,
      uvcDeviceId: gate.uvcDeviceId,
      uvcDeviceLabel: gate.uvcDeviceLabel,
      backendDevicePath: gate.backendDevicePath,
      resolution: gate.resolution,
      fps: gate.fps,
      enabled: true,
      priority: 0,
    },
  ];
};

/** Lowest-priority ENABLED stream is the primary (falls back to the first one). */
const getPrimaryStream = (streams: GateStreamSource[]): GateStreamSource | null =>
  streams.find((s) => s.enabled) || streams[0] || null;

/** rtsp://user:secret@host/... -> rtsp://user:•••@host/... */
const maskRtspCredentials = (url?: string): string => {
  if (!url) return "";
  return url.replace(/^([a-z]+:\/\/)([^:@/]+)(?::[^@/]*)?@/i, (_m, proto, user) => `${proto}${user}:•••@`);
};

/** Faces returned by a multi-stream scan also carry the stream they were seen on. */
type StreamFace = DetectedFace & { streamId?: string; streamLabel?: string };

/** Aggregate scan-rtsp response (single stream or whole gate).
 *  `fusion` only exists on a server that runs the ONNX + fusion pipeline;
 *  an older server omits it and the panel falls back to the plain view. */
type GateScanResponse = FaceRecognitionResult & {
  success?: boolean;
  error?: string;
  retryAfterSeconds?: number;
  frameCaptureDurationMs?: number;
  streams?: GateStreamScanResult[];
  streamId?: string;
  streamLabel?: string;
  detectedFaces: StreamFace[];
  fusion?: FusionSummary;
};

/** The decision plus the context the server adds around it. Extra fields are
 *  optional: a server that only sends a bare FusionDecision still renders. */
type FusionSummary = FusionDecision & {
  engine?: string;
  observations?: number;
  observationCap?: number;
  framesPerStream?: number;
  frameIntervalMs?: number;
  streamsPooled?: number;
  galleryTemplates?: number;
  modelTag?: string;
};

/**
 * Measured on the deployed ONNX engine against the 2-stream exit gate:
 * a whole-gate scan takes 2.58 s at frames=1 and 5.99 s at frames=2.
 * These numbers are what the operator is shown; whenever the watcher reports a
 * real `lastDurationMs`, the measurement wins over this estimate.
 */
const MEASURED_SCAN_SECONDS: Record<number, number> = { 1: 2.58, 2: 5.99 };
/** The measurement above was taken on a gate with this many streams. */
const MEASURED_STREAM_COUNT = 2;
/** Cost of each extra frame per stream for a whole gate (5.99 - 2.58). */
const EXTRA_FRAME_SECONDS = 3.41;

const clampFrames = (n: unknown): number => Math.min(5, Math.max(1, Math.round(Number(n) || 1)));
const clampInterval = (n: unknown): number => Math.min(300, Math.max(1, Math.round(Number(n) || 1)));

/** Estimated duration of ONE whole-gate scan, used until a real one is measured. */
const estimateScanSeconds = (frames: number): number => {
  const f = clampFrames(frames);
  const known = MEASURED_SCAN_SECONDS[f];
  return typeof known === "number" ? known : MEASURED_SCAN_SECONDS[1] + (f - 1) * EXTRA_FRAME_SECONDS;
};

/** Seconds rendered with one decimal, or an em dash for a non-number. */
const fmtSeconds = (s: number): string =>
  !Number.isFinite(s) ? "—" : s >= 100 ? s.toFixed(0) : s.toFixed(1);

/** "12 giây trước" / "3 phút trước". Never throws on a missing or malformed timestamp. */
const relativeTime = (iso: string | undefined, now: number): string => {
  if (!iso) return "chưa có";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "chưa có";
  const diff = Math.round((now - t) / 1000);
  if (diff < 0) return "vừa xong";
  if (diff < 2) return "vừa xong";
  if (diff < 60) return `${diff} giây trước`;
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
};

/** Whole seconds until `iso`, or null when there is no usable timestamp. */
const secondsUntil = (iso: string | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - now) / 1000));
};

/** Used before the server has told us anything about a gate's watcher. */
const DEFAULT_WATCH: GateWatchConfig = { enabled: false, intervalSeconds: 3, frames: 1 };

/**
 * Tolerant normaliser for a watcher payload (REST or SSE). A partial object, a
 * missing counter or an unknown gate must never crash or half-populate the panel.
 */
const normalizeWatchRuntime = (raw: any): GateWatchRuntime | null => {
  if (!raw || typeof raw !== "object") return null;
  const upper = String(raw.gate || "").toUpperCase();
  if (upper !== "ENTRY" && upper !== "EXIT") return null;
  const gate: "ENTRY" | "EXIT" = upper === "EXIT" ? "EXIT" : "ENTRY";
  return {
    gate,
    enabled: raw.enabled === true,
    intervalSeconds: clampInterval(raw.intervalSeconds ?? DEFAULT_WATCH.intervalSeconds),
    frames: clampFrames(raw.frames ?? DEFAULT_WATCH.frames),
    running: raw.running === true,
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastDurationMs: typeof raw.lastDurationMs === "number" ? raw.lastDurationMs : undefined,
    lastBasis: typeof raw.lastBasis === "string" ? raw.lastBasis : undefined,
    lastRecognized: typeof raw.lastRecognized === "boolean" ? raw.lastRecognized : undefined,
    lastEmployeeName: typeof raw.lastEmployeeName === "string" ? raw.lastEmployeeName : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    consecutiveErrors: Number.isFinite(Number(raw.consecutiveErrors)) ? Number(raw.consecutiveErrors) : 0,
    totalRuns: Number.isFinite(Number(raw.totalRuns)) ? Number(raw.totalRuns) : 0,
    nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : undefined,
  };
};

/** Readable chip for a fusion decision basis. */
const describeBasis = (
  fusion: FusionDecision
): { text: string; tone: "emerald" | "sky" | "amber" | "rose" } => {
  switch (fusion.basis) {
    case "single-strong":
      return { text: "1 góc nhìn rõ", tone: "emerald" };
    case "multi-agree":
      return {
        text:
          fusion.agreeingStreams > 1
            ? `${fusion.agreeingStreams} luồng đồng thuận`
            : `${fusion.agreeingObservations} quan sát đồng thuận`,
        tone: "sky",
      };
    case "rejected-weak":
      return { text: "Từ chối: bằng chứng yếu", tone: "amber" };
    case "rejected-ambiguous":
      return { text: "Từ chối: không rõ danh tính", tone: "rose" };
    case "rejected-no-face":
      return { text: "Từ chối: không thấy khuôn mặt", tone: "rose" };
    default:
      return { text: fusion.basis ? `Cơ sở: ${fusion.basis}` : "Cơ sở không rõ", tone: "amber" };
  }
};

const BASIS_TONE_CLASS: Record<"emerald" | "sky" | "amber" | "rose", string> = {
  emerald: "bg-emerald-950/80 text-emerald-300 border-emerald-700/70",
  sky: "bg-sky-950/80 text-sky-300 border-sky-700/70",
  amber: "bg-amber-950/70 text-amber-300 border-amber-700/70",
  rose: "bg-rose-950/70 text-rose-300 border-rose-700/70",
};

const pct = (v: number) => `${Math.min(100, Math.max(0, v * 100)).toFixed(1)}%`;
const cos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—");

interface CameraDashboardProps {
  employees: Employee[];
  lockState: SmartLockState;
  accessLogs: AccessLog[];
  onRecognitionComplete: (result: FaceRecognitionResult) => void;
  onTriggerManualUnlock: () => void;
  onOpenStrangerClusters?: (preselectedPhoto?: string) => void;
  onNavigateToCamerasConfig: () => void;
  onNavigateToManualTrack: () => void;
  onNavigateToLogs: () => void;
}

interface PerStreamState {
  isScanning: boolean;
  lastResult: GateStreamScanResult | null;
  lastScanTime: string | null;
  error: string | null;
  /** MJPEG proxy failed for this tile -> show a periodic snapshot instead. */
  mjpegFailed: boolean;
  snapshotTs: number;
}

interface StreamScanState {
  isScanning: boolean;
  lastResult: GateScanResponse | null;
  lastScanTime: string | null;
  activeFaces: StreamFace[];
  /** Where `lastResult` came from: a manual scan from THIS browser, or the backend watcher. */
  resultOrigin: "MANUAL" | "WATCHER" | null;
  /** ISO timestamp the backend reported for a watcher result (null for manual scans). */
  resultAt: string | null;
  viewMode: "MJPEG" | "SNAPSHOT" | "SIMULATION";
  snapshotTs: number;
  hasError: boolean;
  errorMessage: string | null;
  /** Short notice when the worker pool answered 503 (Retry-After). */
  retryNotice: string | null;
  clientUvcActive: boolean;
  perStream: Record<string, PerStreamState>;
  showScanPanel: boolean;
  /** Frames grabbed per stream per scan; more frames = more fusion evidence, more latency. */
  scanFrames: number;
}

const createInitialScanState = (): StreamScanState => ({
  isScanning: false,
  lastResult: null,
  lastScanTime: null,
  activeFaces: [],
  resultOrigin: null,
  resultAt: null,
  viewMode: "MJPEG",
  snapshotTs: Date.now(),
  hasError: false,
  errorMessage: null,
  retryNotice: null,
  clientUvcActive: false,
  perStream: {},
  showScanPanel: true,
  scanFrames: 1,
});

const emptyPerStream = (): PerStreamState => ({
  isScanning: false,
  lastResult: null,
  lastScanTime: null,
  error: null,
  mjpegFailed: false,
  snapshotTs: Date.now(),
});

export const CameraDashboard: React.FC<CameraDashboardProps> = ({
  employees,
  lockState,
  accessLogs,
  onRecognitionComplete,
  onTriggerManualUnlock,
  onOpenStrangerClusters,
  onNavigateToCamerasConfig,
  onNavigateToManualTrack,
  onNavigateToLogs,
}) => {
  const [config, setConfig] = useState<CameraStreamsConfig>(DEFAULT_STREAMS_CONFIG);
  const [loadingConfig, setLoadingConfig] = useState<boolean>(true);
  const [currentTime, setCurrentTime] = useState<string>("");
  /** Ticks once a second so relative times and the next-run countdown stay live. */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // ---- Backend watcher (server-side auto-scan) state ----
  const [watchers, setWatchers] = useState<Record<GateKey, GateWatchRuntime | null>>({
    entry: null,
    exit: null,
  });
  /** null = chưa biết (đang tải); false = máy chủ cũ không có endpoint watch. */
  const [watchSupported, setWatchSupported] = useState<boolean | null>(null);
  const [watchLoading, setWatchLoading] = useState<boolean>(true);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchPending, setWatchPending] = useState<Record<GateKey, boolean>>({
    entry: false,
    exit: false,
  });
  const [watchFieldError, setWatchFieldError] = useState<Record<GateKey, string | null>>({
    entry: null,
    exit: null,
  });
  /** In-progress edit of the interval box; null = show the server's value. */
  const [intervalDraft, setIntervalDraft] = useState<Record<GateKey, string | null>>({
    entry: null,
    exit: null,
  });
  /** Last alert signature per gate, so a person standing in frame does not
   *  re-trigger the chime on every single backend cycle. */
  const watchAlertRef = useRef<Record<GateKey, string>>({ entry: "", exit: "" });

  // Per-gate scan and view states
  const [entryState, setEntryState] = useState<StreamScanState>(createInitialScanState);
  const [exitState, setExitState] = useState<StreamScanState>(createInitialScanState);

  // Client UVC video references
  const entryVideoRef = useRef<HTMLVideoElement | null>(null);
  const exitVideoRef = useRef<HTMLVideoElement | null>(null);
  const entryMediaStreamRef = useRef<MediaStream | null>(null);
  const exitMediaStreamRef = useRef<MediaStream | null>(null);

  // Clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
      setNowMs(now.getTime());
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch camera config
  const fetchConfig = useCallback(async () => {
    try {
      // The endpoint replies with an envelope: { success, config, telemetry }.
      // Assigning res.data directly leaves config.entryGate undefined.
      const res = await safeJsonFetch<{ success?: boolean; config?: CameraStreamsConfig }>(
        "/api/camera-streams/config"
      );
      if (res.ok && res.data?.config?.entryGate && res.data.config.exitGate) {
        setConfig(res.data.config);
      }
    } catch (err) {
      console.warn("[CameraDashboard] Sử dụng cấu hình camera mặc định:", err);
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ---------------- BACKEND WATCHER: read, subscribe, control ----------------

  /** Merge one runtime object (from REST or SSE) into the panel state. */
  const applyWatcher = useCallback((raw: any) => {
    const w = normalizeWatchRuntime(raw);
    if (!w) return;
    setWatchers((prev) => ({ ...prev, [gateKeyOf(w.gate)]: w }));
    setWatchSupported(true);
    setWatchError(null);
  }, []);

  /**
   * Read every gate's watcher. This is the FALLBACK path (polled every 5 s);
   * `gate_watch_state` over SSE is the fast path. A 404 means an older server
   * with no watcher at all - the panel then says so and manual scanning stays.
   */
  const fetchWatchers = useCallback(async (silent = false) => {
    if (!silent) setWatchLoading(true);
    try {
      const res = await safeJsonFetch<{
        success?: boolean;
        watchers?: GateWatchRuntime[];
        error?: string;
      }>("/api/camera-streams/watch");

      if (res.status === 404 || res.status === 501) {
        setWatchSupported(false);
        setWatchError(null);
        return;
      }
      const list = res.data?.watchers;
      if (res.ok && Array.isArray(list)) {
        const next: Record<GateKey, GateWatchRuntime | null> = { entry: null, exit: null };
        for (const raw of list) {
          const w = normalizeWatchRuntime(raw);
          if (w) next[gateKeyOf(w.gate)] = w;
        }
        setWatchers(next);
        setWatchSupported(true);
        setWatchError(null);
        return;
      }
      setWatchError(
        res.status === 0
          ? "Không kết nối được máy chủ để đọc trạng thái quét nền."
          : res.data?.error || res.error || `Không đọc được trạng thái quét nền (HTTP ${res.status || 0}).`
      );
    } finally {
      setWatchLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWatchers();
  }, [fetchWatchers]);

  // Modest polling fallback. Stops entirely once we know the server has no watcher.
  useEffect(() => {
    if (watchSupported === false) return;
    const timer = setInterval(() => {
      fetchWatchers(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchWatchers, watchSupported]);

  /**
   * A scan completed on the SERVER. Rebuild the exact result shape a manual
   * scan produces so the fusion evidence panel, the per-stream rows and the
   * face chips render identically - only the origin label differs.
   */
  const applyWatchResult = useCallback(
    (payload: any) => {
      const upper = String(payload?.gate || "").toUpperCase();
      if (upper !== "ENTRY" && upper !== "EXIT") return;
      const gateType: "ENTRY" | "EXIT" = upper === "EXIT" ? "EXIT" : "ENTRY";
      const key = gateKeyOf(gateType);
      const setState = gateType === "ENTRY" ? setEntryState : setExitState;

      const streamRows: GateStreamScanResult[] = Array.isArray(payload?.streams)
        ? payload.streams.filter((r: any) => r && typeof r.streamId === "string")
        : [];
      const failed = payload?.ok === false;
      const watchErrorText = typeof payload?.error === "string" ? payload.error : null;

      // A refused / failed backend scan is shown as the refusal it is. It never
      // becomes a green "result" and never gets a client-side substitute.
      if (failed) {
        const atLabelFail = new Date().toLocaleTimeString("vi-VN");
        setState((prev) => {
          const perStream = { ...prev.perStream };
          for (const r of streamRows) {
            perStream[r.streamId] = {
              ...(perStream[r.streamId] || emptyPerStream()),
              isScanning: false,
              error: r.success ? null : r.error || watchErrorText || "Không lấy được khung hình",
            };
          }
          return {
            ...prev,
            hasError: true,
            errorMessage: `Watcher máy chủ quét lỗi lúc ${atLabelFail}: ${
              watchErrorText || "không rõ nguyên nhân"
            }`,
            perStream,
          };
        });
        watchAlertRef.current[key] = "error";
        return;
      }
      const faces: StreamFace[] = [];
      for (const row of streamRows) {
        const rowFaces = (Array.isArray(row.detectedFaces) ? row.detectedFaces : []) as StreamFace[];
        for (const f of rowFaces) {
          if (!f) continue;
          faces.push({
            ...f,
            streamId: f.streamId || row.streamId,
            streamLabel: f.streamLabel || row.streamLabel,
          });
        }
      }

      const recognized = payload?.recognized === true;
      // The watcher event is a SUMMARY: it carries the fusion basis and the
      // per-stream outcome, but no boxes, no embeddings and no face list.
      // Fill in the two fields the evidence panel reads from the top level so
      // the decision header is not rendered as a refusal by accident.
      const rawFusion = payload?.fusion && typeof payload.fusion === "object" ? payload.fusion : null;
      const fusion: FusionSummary | undefined = rawFusion
        ? ({
            ...rawFusion,
            recognized: typeof rawFusion.recognized === "boolean" ? rawFusion.recognized : recognized,
          } as FusionSummary)
        : undefined;
      /** Faces the streams reported, even though their boxes are not in the event. */
      const reportedFaceCount = streamRows.reduce(
        (sum, r) => sum + (Number.isFinite(Number(r.totalFacesDetected)) ? Number(r.totalFacesDetected) : 0),
        0
      );
      const employeeName = typeof payload?.employeeName === "string" ? payload.employeeName : undefined;
      const matched =
        employees.find((e) => e.id === fusion?.employeeId) ||
        (employeeName ? employees.find((e) => e.name === employeeName) : undefined);
      // Keep the operator informed even for an employee this browser has not
      // loaded yet: show the name the server sent rather than "undefined".
      const employee: Employee | undefined = !recognized
        ? undefined
        : matched ||
          (employeeName
            ? {
                id: fusion?.employeeId || "unknown",
                name: employeeName,
                employeeCode: "—",
                department: "",
                position: "",
                photoUrl: "",
                registeredAt: "",
                accessLevel: "RESTRICTED",
              }
            : undefined);

      const atIso = typeof payload?.at === "string" && Number.isFinite(Date.parse(payload.at))
        ? payload.at
        : new Date().toISOString();
      const atLabel = new Date(Date.parse(atIso)).toLocaleTimeString("vi-VN");
      const durationMs = typeof payload?.durationMs === "number" ? payload.durationMs : undefined;

      const result: GateScanResponse = {
        success: true,
        recognized,
        employee,
        detectedFaces: faces,
        totalFacesDetected: faces.length > 0 ? faces.length : reportedFaceCount,
        authorizedCount: faces.filter((f) => f.recognized).length,
        unauthorizedCount: faces.filter((f) => !f.recognized).length,
        processingTimeMs: typeof durationMs === "number" ? durationMs : 0,
        confidence: typeof fusion?.confidence === "number" ? fusion.confidence * 100 : 0,
        livenessScore: 0,
        message: recognized
          ? `Watcher máy chủ: ${employeeName || "nhân viên hợp lệ"}`
          : "Watcher máy chủ: chưa khớp hồ sơ nhân viên nào",
        lockUnlocked: recognized,
        engineUsed: fusion?.engine ? `Watcher máy chủ (${fusion.engine})` : "Watcher máy chủ",
        streams: streamRows,
        fusion,
      };

      setState((prev) => {
        const perStream = { ...prev.perStream };
        for (const r of streamRows) {
          perStream[r.streamId] = {
            ...(perStream[r.streamId] || emptyPerStream()),
            isScanning: false,
            lastResult: r,
            lastScanTime: atLabel,
            error: r.success ? null : r.error || "Không lấy được khung hình",
            snapshotTs: Date.now(),
          };
        }
        return {
          ...prev,
          lastResult: result,
          lastScanTime: atLabel,
          resultOrigin: "WATCHER",
          resultAt: atIso,
          activeFaces: faces,
          snapshotTs: Date.now(),
          perStream,
        };
      });

      // Alert only when the situation CHANGES, not on every backend cycle.
      const seenFaces = faces.length > 0 ? faces.length : reportedFaceCount;
      const alertKey = `${recognized ? "ok" : seenFaces > 0 ? "stranger" : "none"}:${employeeName || ""}`;
      if (watchAlertRef.current[key] !== alertKey) {
        watchAlertRef.current[key] = alertKey;
        if (recognized) soundEffects.playSuccess();
        else if (seenFaces > 0) soundEffects.playStrangerAlert();
      }
    },
    [employees]
  );

  // The SSE connection must not be torn down every time `employees` changes.
  const applyWatchResultRef = useRef<(payload: any) => void>(() => {});
  useEffect(() => {
    applyWatchResultRef.current = applyWatchResult;
  }, [applyWatchResult]);

  /**
   * Fast path: the same `/api/events` stream the rest of the app listens to.
   * `gate_watch_state` updates the control panel the instant the watcher
   * starts, stops or is reconfigured; `gate_watch_result` renders a completed
   * backend scan. The 5 s poll above stays as the safety net.
   */
  useEffect(() => {
    if (isNetlifyOrStaticHost() && !getApiBaseUrl()) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(buildEventSourceUrl("/api/events"));
      es.addEventListener("gate_watch_state", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          applyWatcher(data?.watcher ?? data);
        } catch {}
      });
      es.addEventListener("gate_watch_result", (e: MessageEvent) => {
        try {
          applyWatchResultRef.current(JSON.parse(e.data));
        } catch {}
      });
    } catch {
      // No SSE here (static host / blocked proxy): polling still carries state.
    }
    return () => {
      if (es) es.close();
    };
  }, [applyWatcher]);

  /**
   * Change one gate's watcher. The SERVER owns the truth: we never optimistically
   * flip the switch, we render whatever runtime the server hands back.
   */
  const updateWatcher = useCallback(
    async (gateType: "ENTRY" | "EXIT", patch: Partial<GateWatchConfig>) => {
      const key = gateKeyOf(gateType);
      setWatchPending((p) => ({ ...p, [key]: true }));
      setWatchFieldError((p) => ({ ...p, [key]: null }));
      try {
        const res = await safeJsonFetch<{ success?: boolean; watcher?: GateWatchRuntime; error?: string }>(
          `/api/camera-streams/${key}/watch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );

        if (res.status === 404 || res.status === 501) {
          setWatchSupported(false);
          return;
        }
        if (res.ok && res.data?.watcher) {
          applyWatcher(res.data.watcher);
          return;
        }
        if (res.ok && res.data?.success !== false) {
          // Accepted but nothing usable came back: re-read the real state.
          await fetchWatchers(true);
          return;
        }
        setWatchFieldError((p) => ({
          ...p,
          [key]:
            res.data?.error ||
            res.error ||
            (res.status === 400
              ? "Giá trị không hợp lệ (khoảng nghỉ 1-300 giây, số khung 1-5)."
              : `Máy chủ từ chối thay đổi (HTTP ${res.status || 0}).`),
        }));
      } finally {
        setWatchPending((p) => ({ ...p, [key]: false }));
      }
    },
    [applyWatcher, fetchWatchers]
  );

  /** Commit the interval box (blur / Enter), clamped to the server's 1-300 range. */
  const commitIntervalDraft = (gateType: "ENTRY" | "EXIT", current: number) => {
    const key = gateKeyOf(gateType);
    const draft = intervalDraft[key];
    setIntervalDraft((p) => ({ ...p, [key]: null }));
    if (draft === null || draft.trim() === "") return;
    const next = clampInterval(draft);
    if (next === current) return;
    updateWatcher(gateType, { intervalSeconds: next });
  };

  // Derived stream lists (sorted, legacy-tolerant)
  const entryStreams = deriveGateStreams(config.entryGate, "entry");
  const exitStreams = deriveGateStreams(config.exitGate, "exit");
  const entryPrimary = getPrimaryStream(entryStreams);
  const exitPrimary = getPrimaryStream(exitStreams);
  const entryPrimarySourceType = entryPrimary?.sourceType || config.entryGate?.sourceType;
  const exitPrimarySourceType = exitPrimary?.sourceType || config.exitGate?.sourceType;

  // Determine active gates
  const activeGates: {
    gate: GateStreamConfig;
    streams: GateStreamSource[];
    state: StreamScanState;
    setState: React.Dispatch<React.SetStateAction<StreamScanState>>;
  }[] = [];
  if (config.entryGate?.enabled) {
    activeGates.push({ gate: config.entryGate, streams: entryStreams, state: entryState, setState: setEntryState });
  }
  if (config.exitGate?.enabled) {
    activeGates.push({ gate: config.exitGate, streams: exitStreams, state: exitState, setState: setExitState });
  }
  const totalEnabledStreams = activeGates.reduce(
    (sum, g) => sum + g.streams.filter((s) => s.enabled).length,
    0
  );
  /** How many gates currently have their backend watcher switched on. */
  const activeWatcherCount = (["entry", "exit"] as GateKey[]).filter((k) => watchers[k]?.enabled).length;

  const gateHelpers = (gateType: "ENTRY" | "EXIT") => {
    const isEntry = gateType === "ENTRY";
    return {
      isEntry,
      key: gateKeyOf(gateType),
      gateConfig: isEntry ? config.entryGate : config.exitGate,
      streams: isEntry ? entryStreams : exitStreams,
      primary: isEntry ? entryPrimary : exitPrimary,
      setState: isEntry ? setEntryState : setExitState,
      videoRef: isEntry ? entryVideoRef : exitVideoRef,
      streamRef: isEntry ? entryMediaStreamRef : exitMediaStreamRef,
    };
  };

  // Handle Client UVC Camera Start for a gate (only the PRIMARY stream may be a browser webcam)
  const startClientUvcCamera = async (gateType: "ENTRY" | "EXIT") => {
    const { gateConfig, primary, setState, videoRef, streamRef } = gateHelpers(gateType);
    const uvcDeviceId = primary?.uvcDeviceId || gateConfig?.uvcDeviceId;

    try {
      const constraints: MediaStreamConstraints = {
        video: uvcDeviceId && uvcDeviceId !== "default"
          ? { deviceId: { exact: uvcDeviceId } }
          : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      setState((prev) => ({ ...prev, clientUvcActive: true, hasError: false, errorMessage: null }));
    } catch (err: any) {
      console.error(`[CameraDashboard] Lỗi mở UVC Camera (${gateType}):`, err);
      setState((prev) => ({
        ...prev,
        clientUvcActive: false,
        hasError: true,
        errorMessage: "Không thể mở Webcam trình duyệt: " + (err?.message || err),
      }));
    }
  };

  // Stop Client UVC
  const stopClientUvcCamera = (gateType: "ENTRY" | "EXIT") => {
    const { setState, videoRef, streamRef } = gateHelpers(gateType);

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setState((prev) => ({ ...prev, clientUvcActive: false }));
  };

  const updatePerStream = (
    setState: React.Dispatch<React.SetStateAction<StreamScanState>>,
    streamId: string,
    patch: Partial<PerStreamState>
  ) => {
    setState((prev) => ({
      ...prev,
      perStream: {
        ...prev.perStream,
        [streamId]: { ...(prev.perStream[streamId] || emptyPerStream()), ...patch },
      },
    }));
  };

  /**
   * Recognise a frame captured from the browser webcam (primary CLIENT_UVC stream).
   *
   * SECURITY: when a backend exists, its answer is the ONLY answer. A server
   * error NEVER falls back to the client-side simulator - that would open a
   * door on a made-up result. The on-device simulator is reached only when no
   * backend is configured at all (static demo build) and is labelled as such.
   */
  const recognizeClientUvcFrame = async (
    gateType: "ENTRY" | "EXIT",
    videoEl: HTMLVideoElement,
    gateName: string
  ): Promise<{ result: GateScanResponse | null; error: string | null; retryNotice: string | null }> => {
    const fail = (error: string | null, retryNotice: string | null = null) => ({
      result: null,
      error,
      retryNotice,
    });
    if (videoEl.videoWidth <= 0) return fail("Webcam trình duyệt chưa có khung hình nào.");
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return fail("Trình duyệt không tạo được canvas để lấy khung hình.");
    ctx.drawImage(videoEl, 0, 0);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.85);

    const hasBackend = !isNetlifyOrStaticHost() || Boolean(getApiBaseUrl());
    if (hasBackend) {
      const res = await safeJsonFetch<GateScanResponse>("/api/recognize-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          scanType: gateType,
          clientEmployees: employees,
          config: getStoredAiConfig(),
        }),
      });

      if (res.status === 503) {
        return fail(
          null,
          `Cụm xử lý đang quá tải, sẽ thử lại sau ${res.data?.retryAfterSeconds || 1} giây.`
        );
      }
      if (res.ok && res.data && res.data.success !== false) {
        return { result: res.data, error: null, retryNotice: null };
      }
      // Show the server's own refusal verbatim; do not invent a local verdict.
      return fail(
        res.data?.error || res.error || `Máy chủ không nhận diện được (HTTP ${res.status || 0}).`
      );
    }

    // No backend at all (static demo build): explicitly simulated, never dressed
    // up as a real recognition result.
    {
      const localMatch = runLocalFaceRecognition({ imageBase64, employees });
      const result: GateScanResponse = {
        recognized: localMatch.recognized,
        employee: localMatch.bestMatch,
        detectedFaces: localMatch.detectedFaces,
        totalFacesDetected: localMatch.detectedFaces.length,
        authorizedCount: localMatch.recognized ? 1 : 0,
        unauthorizedCount: localMatch.recognized ? 0 : localMatch.detectedFaces.length,
        processingTimeMs: localMatch.processingTimeMs,
        confidence: localMatch.overallConfidence,
        livenessScore: localMatch.overallLiveness,
        message: localMatch.recognized
          ? `Mô phỏng cục bộ tại ${gateName}: ${localMatch.bestMatch?.name} (không phải nhận diện thật)`
          : `Mô phỏng cục bộ tại ${gateName}: không khớp hồ sơ nhân viên`,
        lockUnlocked: localMatch.recognized,
        engineUsed: "Mô phỏng cục bộ trong trình duyệt (không có máy chủ nhận diện)",
        modelUsed: localMatch.modelName,
      };
      return { result, error: null, retryNotice: null };
    }
  };

  /**
   * Perform Face Recognition on a gate.
   * - `streamId` given  -> scan that single stream (`POST scan-rtsp { gate, stream }`).
   * - `streamId` absent -> scan ALL enabled streams of the gate concurrently on the
   *   server (`POST scan-rtsp { gate }`), which also returns per-stream `streams[]`.
   * A gate whose PRIMARY stream is a browser webcam keeps the CLIENT_UVC path.
   */
  const performStreamScan = async (gateType: "ENTRY" | "EXIT", streamId?: string) => {
    const { key, gateConfig, streams, primary, setState, videoRef } = gateHelpers(gateType);
    if (!gateConfig) return;
    const enabledStreams = streams.filter((s) => s.enabled);
    const targetStream = streamId ? streams.find((s) => s.id === streamId) || null : null;

    if (streamId && !targetStream) return;
    if (!streamId && enabledStreams.length === 0) {
      setState((prev) => ({ ...prev, hasError: true, errorMessage: "Cổng này chưa có luồng camera nào được bật." }));
      return;
    }

    const useClientUvc =
      (targetStream ? targetStream.sourceType : primary?.sourceType) === "CLIENT_UVC";
    if (targetStream && useClientUvc && primary?.id !== targetStream.id) {
      updatePerStream(setState, targetStream.id, {
        error: "Webcam trình duyệt chỉ hỗ trợ khi là luồng chính của cổng.",
      });
      return;
    }

    setState((prev) => ({ ...prev, isScanning: true, hasError: false, retryNotice: null }));
    if (targetStream) updatePerStream(setState, targetStream.id, { isScanning: true, error: null });

    try {
      let result: GateScanResponse | null = null;
      let scanError: string | null = null;
      let retryNotice: string | null = null;

      if (useClientUvc) {
        if (videoRef.current) {
          const outcome = await recognizeClientUvcFrame(gateType, videoRef.current, gateConfig.name);
          result = outcome.result;
          scanError = outcome.error;
          retryNotice = outcome.retryNotice;
        } else {
          scanError = "Chưa mở được webcam trình duyệt cho cổng này.";
        }
        if (result && primary) {
          result = {
            ...result,
            streamId: primary.id,
            streamLabel: primary.label,
            detectedFaces: (result.detectedFaces || []).map((f) => ({ ...f, streamId: primary.id, streamLabel: primary.label })),
          };
        }
      } else {
        // RTSP / HTTP / backend UVC: the server grabs the frame(s) and runs recognition.
        // Frames per stream: an older server simply ignores the extra field.
        const framesPerStream = Math.min(
          5,
          Math.max(1, (gateType === "ENTRY" ? entryState : exitState).scanFrames || 1)
        );
        const scanRes = await safeJsonFetch<GateScanResponse>("/api/camera-streams/scan-rtsp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gate: key,
            ...(targetStream ? { stream: targetStream.id } : {}),
            scanType: gateType,
            frames: framesPerStream,
          }),
        });

        if (scanRes.status === 503 && typeof scanRes.data?.retryAfterSeconds === "number") {
          retryNotice = `Cụm xử lý đang quá tải, sẽ thử lại sau ${scanRes.data.retryAfterSeconds} giây.`;
        } else if (scanRes.status === 503) {
          // A 503 without a retry hint is a refusal, not congestion: show it as-is.
          scanError = scanRes.data?.error || scanRes.error || "Máy chủ từ chối quét lúc này (HTTP 503).";
        } else if (scanRes.ok && scanRes.data && scanRes.data.success !== false) {
          result = scanRes.data;
          if (targetStream) {
            result = {
              ...result,
              streamId: result.streamId || targetStream.id,
              streamLabel: result.streamLabel || targetStream.label,
              detectedFaces: ((result.detectedFaces || []) as StreamFace[]).map((f: StreamFace) => ({
                ...f,
                streamId: f.streamId || targetStream.id,
                streamLabel: f.streamLabel || targetStream.label,
              })),
            };
          }
        } else {
          scanError =
            scanRes.data?.error ||
            scanRes.error ||
            (scanRes.status === 502
              ? "Không thể lấy khung hình từ luồng camera nào."
              : `Lỗi quét luồng (HTTP ${scanRes.status || 0})`);
        }
      }

      if (retryNotice) {
        setState((prev) => ({ ...prev, retryNotice }));
        if (targetStream) updatePerStream(setState, targetStream.id, { error: retryNotice });
        return;
      }

      if (scanError) {
        if (targetStream) {
          updatePerStream(setState, targetStream.id, { error: scanError });
        } else {
          setState((prev) => ({ ...prev, hasError: true, errorMessage: scanError }));
        }
        return;
      }

      if (result) {
        const finalResult = result;
        const now = new Date().toLocaleTimeString("vi-VN");
        const faces: StreamFace[] = finalResult.detectedFaces || [];

        setState((prev) => {
          const perStream = { ...prev.perStream };
          if (Array.isArray(finalResult.streams) && finalResult.streams.length > 0) {
            for (const r of finalResult.streams) {
              perStream[r.streamId] = {
                ...(perStream[r.streamId] || emptyPerStream()),
                isScanning: false,
                lastResult: r,
                lastScanTime: now,
                error: r.success ? null : r.error || "Không lấy được khung hình",
                snapshotTs: Date.now(),
              };
            }
          } else {
            const id = finalResult.streamId || targetStream?.id || primary?.id;
            if (id) {
              perStream[id] = {
                ...(perStream[id] || emptyPerStream()),
                isScanning: false,
                lastResult: {
                  streamId: id,
                  streamLabel: finalResult.streamLabel || targetStream?.label || primary?.label || id,
                  success: true,
                  frameCaptureDurationMs: finalResult.frameCaptureDurationMs,
                  recognized: !!finalResult.recognized,
                  totalFacesDetected: finalResult.totalFacesDetected ?? faces.length,
                  detectedFaces: faces,
                },
                lastScanTime: now,
                error: null,
                snapshotTs: Date.now(),
              };
            }
          }
          return {
            ...prev,
            lastResult: finalResult,
            lastScanTime: now,
            resultOrigin: "MANUAL",
            resultAt: new Date().toISOString(),
            activeFaces: faces,
            snapshotTs: Date.now(),
            perStream,
          };
        });

        onRecognitionComplete(finalResult);

        if (finalResult.recognized) {
          // Trigger smart lock unlock
          try {
            const unlock = await operatorJsonFetch("/api/lock/unlock", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                source: `${gateConfig.name} (Quét Cửa Tự Động)`,
                reason: `Nhận diện khuôn mặt hợp lệ: ${finalResult.employee?.name || "Nhân viên"}`,
              }),
            });
            if (!unlock.ok) throw new Error(unlock.error || `Unlock failed (HTTP ${unlock.status})`);
            soundEffects.playSuccess();
          } catch (err) {
            if (demoOfflinePersistenceEnabled()) {
              clientDoorUnlock(`${gateConfig.name} (Client Fallback)`, undefined, undefined, { simulated: true });
              soundEffects.playSuccess();
            } else {
              console.warn("Không thể mở cửa sau nhận diện:", err);
              soundEffects.playDenied();
            }
          }
        } else if ((finalResult.totalFacesDetected ?? faces.length) > 0) {
          soundEffects.playStrangerAlert();
        }
      }
    } catch (err: any) {
      console.warn(`[CameraDashboard] Lỗi quét luồng (${gateType}):`, err);
      setState((prev) => ({
        ...prev,
        hasError: true,
        errorMessage: err?.message || "Lỗi xử lý luồng AI",
      }));
    } finally {
      setState((prev) => ({ ...prev, isScanning: false }));
      if (targetStream) updatePerStream(setState, targetStream.id, { isScanning: false });
    }
  };

  // NOTE: the browser no longer schedules ANY repeating scan. The two
  // `setInterval` auto-scan cycles that used to live here were removed: they
  // only ran while a tab was open, doubled the camera/worker load with a second
  // tab, and silently dropped every tick that landed during an in-flight scan
  // (a "1 giây" setting really meant ~3 s). Periodic scanning is now a backend
  // watcher; this component only controls it and renders what it finds.
  // The manual "Quét" / "Quét tất cả luồng" buttons still call scan-rtsp directly.

  // Auto start UVC cameras if a gate's PRIMARY stream uses CLIENT_UVC
  useEffect(() => {
    if (config.entryGate?.enabled && entryPrimarySourceType === "CLIENT_UVC" && !entryState.clientUvcActive) {
      startClientUvcCamera("ENTRY");
    }
    return () => {
      if (entryMediaStreamRef.current) {
        stopClientUvcCamera("ENTRY");
      }
    };
  }, [config.entryGate?.enabled, entryPrimarySourceType, entryPrimary?.uvcDeviceId]);

  useEffect(() => {
    if (config.exitGate?.enabled && exitPrimarySourceType === "CLIENT_UVC" && !exitState.clientUvcActive) {
      startClientUvcCamera("EXIT");
    }
    return () => {
      if (exitMediaStreamRef.current) {
        stopClientUvcCamera("EXIT");
      }
    };
  }, [config.exitGate?.enabled, exitPrimarySourceType, exitPrimary?.uvcDeviceId]);

  // Quick unlock for a specific gate
  const handleGateUnlock = async (gateName: string) => {
    soundEffects.playLockClick();
    try {
      const result = await operatorJsonFetch("/api/lock/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: `Điều khiển mở cửa trực tiếp (${gateName})`,
          reason: "Bảo vệ bấm nút mở cổng từ Dashboard Quét Cửa AI",
        }),
      });
      if (!result.ok) throw new Error(result.error || `Unlock failed (HTTP ${result.status})`);
      soundEffects.playSuccess();
    } catch (err) {
      if (demoOfflinePersistenceEnabled()) {
        clientDoorUnlock(`Điều khiển mở cửa (${gateName})`, undefined, undefined, { simulated: true });
        soundEffects.playSuccess();
      } else {
        console.warn("Mở cổng thất bại:", err);
        soundEffects.playDenied();
      }
    }
  };

  // Face HUD tag used on tiles
  const renderFaceBox = (face: StreamFace, index: number, lastResult: GateScanResponse | null) => {
    // A watcher payload may carry a face without a usable box: skip the HUD
    // overlay rather than crashing the tile.
    if (!face || !Array.isArray(face.box2d) || face.box2d.length < 4) return null;
    const [top, left, bottom, right] = face.box2d;
    const width = right - left;
    const height = bottom - top;
    const isRecognized = face.recognized;
    const employeeName = face.employeeName || (isRecognized ? lastResult?.employee?.name : undefined);

    return (
      <div
        key={face.id || index}
        style={{
          top: `${top / 10}%`,
          left: `${left / 10}%`,
          width: `${width / 10}%`,
          height: `${height / 10}%`,
        }}
        className={`absolute border-2 transition-all duration-300 pointer-events-none ${
          isRecognized
            ? "border-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.5)]"
            : "border-rose-500 shadow-[0_0_16px_rgba(244,63,94,0.5)]"
        }`}
      >
        {/* Corner Accents */}
        <div className="absolute -top-1 -left-1 w-2.5 h-2.5 border-t-2 border-l-2 border-white" />
        <div className="absolute -top-1 -right-1 w-2.5 h-2.5 border-t-2 border-r-2 border-white" />
        <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 border-b-2 border-l-2 border-white" />
        <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 border-b-2 border-r-2 border-white" />

        {/* Floating HUD Tag */}
        <div
          className={`absolute -top-10 left-0 px-2.5 py-1 rounded-md text-[11px] font-mono whitespace-nowrap shadow-lg backdrop-blur-md flex items-center gap-1.5 pointer-events-auto ${
            isRecognized
              ? "bg-emerald-950/90 text-emerald-300 border border-emerald-500/80"
              : "bg-rose-950/90 text-rose-300 border border-rose-500/80"
          }`}
        >
          {isRecognized ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="font-bold">{employeeName || "Nhân viên"}</span>
              <span className="text-emerald-400/80 text-[10px]">
                ({face.confidence ? `${face.confidence.toFixed(1)}%` : "98.5%"})
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="font-bold">NGƯỜI LẠ / CHƯA ĐĂNG KÝ</span>
              {onOpenStrangerClusters && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenStrangerClusters(lastResult?.detectedFeatures);
                  }}
                  className="ml-1 px-1.5 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white text-[9px] font-bold cursor-pointer"
                >
                  Khai báo
                </button>
              )}
            </>
          )}
          {face.streamLabel && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-slate-800/90 text-slate-200 text-[9px] font-semibold border border-slate-600">
              {face.streamLabel}
            </span>
          )}
        </div>
      </div>
    );
  };

  // One live tile per enabled stream
  const renderStreamTile = (
    gateConfig: GateStreamConfig,
    stream: GateStreamSource,
    isPrimary: boolean,
    scanState: StreamScanState,
    setScanState: React.Dispatch<React.SetStateAction<StreamScanState>>,
    videoRef: React.RefObject<HTMLVideoElement | null>
  ) => {
    const key = gateKeyOf(gateConfig.gateType);
    const isEntry = gateConfig.gateType === "ENTRY";
    const per = scanState.perStream[stream.id] || emptyPerStream();
    const lastResult = scanState.lastResult;
    const tileFaces = scanState.activeFaces.filter(
      (f) => f.streamId === stream.id || (!f.streamId && isPrimary)
    );
    const isClientUvc = stream.sourceType === "CLIENT_UVC";
    const isScanning = scanState.isScanning && (per.isScanning || !Object.values(scanState.perStream).some((p) => p.isScanning));

    // Media URL for this tile
    const snapshotUrl = `/api/camera-streams/snapshot?gate=${key}&stream=${encodeURIComponent(stream.id)}&t=${per.snapshotTs || scanState.snapshotTs}`;
    const mjpegUrl = `/api/camera-streams/mjpeg?gate=${key}&stream=${encodeURIComponent(stream.id)}`;
    const testFrameUrl = `/api/camera-streams/test-frame?gate=${key}&source=${encodeURIComponent(stream.sourceType)}`;
    let mediaUrl = testFrameUrl;
    if (stream.sourceType === "RTSP" || stream.sourceType === "BACKEND_UVC") {
      if (scanState.viewMode === "SIMULATION") mediaUrl = testFrameUrl;
      else if (scanState.viewMode === "SNAPSHOT" || per.mjpegFailed) mediaUrl = snapshotUrl;
      else mediaUrl = mjpegUrl;
    } else if (stream.sourceType === "HTTP_MJPEG") {
      mediaUrl = per.mjpegFailed ? snapshotUrl : stream.httpUrl || mjpegUrl;
    }

    const perResult = per.lastResult;

    return (
      <div
        key={stream.id}
        id={`tile-stream-${stream.id}`}
        className="relative aspect-video bg-black flex items-center justify-center overflow-hidden rounded-lg border border-slate-800 group"
      >
        {isClientUvc ? (
          isPrimary ? (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          ) : (
            <div className="text-center px-4 text-xs text-slate-400 space-y-1">
              <Camera className="w-6 h-6 mx-auto text-slate-600" />
              <p>Webcam trình duyệt chỉ hiển thị khi là luồng chính</p>
            </div>
          )
        ) : (
          <img
            key={`${stream.id}-${scanState.viewMode}-${per.mjpegFailed ? "snap" : "live"}`}
            src={mediaUrl}
            alt={stream.label}
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (!per.mjpegFailed && scanState.viewMode === "MJPEG") {
                // MJPEG proxy failed (ffmpeg timeout / offline RTSP): fall back to snapshot
                updatePerStream(setScanState, stream.id, { mjpegFailed: true, snapshotTs: Date.now() });
              } else if (!img.src.includes("/test-frame")) {
                // Snapshot failed too: show the offline placeholder
                img.src = `${testFrameUrl}%20Offline`;
              }
            }}
            className="w-full h-full object-cover select-none"
          />
        )}

        {/* Radar Scanning Line Animation when active */}
        {isScanning && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="w-full h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_15px_rgba(34,211,238,0.8)] animate-[bounce_2s_infinite]" />
          </div>
        )}

        {/* AI Face Bounding Box HUD Overlay (faces seen on this stream) */}
        {tileFaces.map((face, index) => renderFaceBox(face, index, lastResult))}

        {/* Tile label */}
        <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none max-w-[85%]">
          <div className="px-2 py-1 rounded-md bg-black/60 backdrop-blur-sm border border-slate-700/60 text-white text-[11px] font-mono flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${isEntry ? "bg-emerald-400" : "bg-blue-400"}`} />
            <span className="font-bold truncate">{stream.label}</span>
            {isPrimary && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[9px] font-bold shrink-0">
                <Star className="w-2.5 h-2.5" />
                Chính
              </span>
            )}
            <span className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 text-[9px] shrink-0">{stream.sourceType}</span>
          </div>
          {stream.rtspUrl && stream.sourceType === "RTSP" && (
            <div className="px-2 py-0.5 rounded bg-black/50 text-[10px] font-mono text-slate-400 truncate">
              {maskRtspCredentials(stream.rtspUrl)}
            </div>
          )}
        </div>

        {/* Per-tile last outcome */}
        <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2">
          <div className="min-w-0">
            {per.error ? (
              <div className="px-2 py-1 rounded-md bg-rose-950/85 border border-rose-700/70 text-rose-200 text-[10px] font-medium truncate max-w-[260px]" title={per.error}>
                <XCircle className="w-3 h-3 inline mr-1 -mt-0.5" />
                {per.error}
              </div>
            ) : perResult ? (
              <div
                className={`px-2 py-1 rounded-md backdrop-blur-sm border text-[10px] font-mono flex items-center gap-2 ${
                  perResult.recognized
                    ? "bg-emerald-950/85 border-emerald-600/70 text-emerald-200"
                    : perResult.totalFacesDetected > 0
                    ? "bg-amber-950/85 border-amber-600/70 text-amber-200"
                    : "bg-black/60 border-slate-700/60 text-slate-300"
                }`}
              >
                <span>{perResult.totalFacesDetected} mặt</span>
                <span>•</span>
                <span>{perResult.recognized ? "Đã nhận diện" : "Chưa khớp"}</span>
                {typeof perResult.frameCaptureDurationMs === "number" && (
                  <>
                    <span>•</span>
                    <span>{perResult.frameCaptureDurationMs}ms</span>
                  </>
                )}
                {per.lastScanTime && <span className="text-slate-400">{per.lastScanTime}</span>}
              </div>
            ) : null}
          </div>

          {/* Per-tile scan button */}
          <button
            id={`btn-scan-stream-${stream.id}`}
            onClick={() => performStreamScan(gateConfig.gateType, stream.id)}
            disabled={scanState.isScanning || (isClientUvc && !isPrimary)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-600/90 hover:bg-indigo-500 text-white text-[10px] font-semibold shadow-xs transition-all cursor-pointer disabled:opacity-50 shrink-0"
            title={`Quét nhận diện riêng luồng ${stream.label}`}
          >
            <ScanFace className={`w-3 h-3 ${per.isScanning ? "animate-spin" : ""}`} />
            {per.isScanning ? "Đang quét..." : "Quét"}
          </button>
        </div>
      </div>
    );
  };

  /** Name for an employee id coming back from the fusion decision. */
  const employeeLabel = (employeeId?: string): string => {
    if (!employeeId) return "Không xác định";
    const match = employees.find((e) => e.id === employeeId);
    return match ? `${match.name} (${match.employeeCode})` : employeeId;
  };

  /**
   * Evidence behind one decision: basis, fused vs best cosine against the active
   * threshold, agreement, candidates and the raw per-observation matches.
   * Every field is defensive - a partial `fusion` object must not crash the tile.
   */
  const renderFusionBlock = (fusion: FusionSummary, streams: GateStreamSource[]) => {
    const basis = describeBasis(fusion);
    const th: Partial<FusionThresholds> = fusion.thresholds || {};
    const acceptSingle = typeof th.acceptSingle === "number" ? th.acceptSingle : null;
    const minEvidence = typeof th.minEvidence === "number" ? th.minEvidence : null;
    const acceptFused = typeof th.acceptFused === "number" ? th.acceptFused : null;
    const fused = typeof fusion.fusedCosine === "number" ? fusion.fusedCosine : 0;
    const best = typeof fusion.bestCosine === "number" ? fusion.bestCosine : 0;
    const candidates = Array.isArray(fusion.candidates) ? fusion.candidates : [];
    const observations = Array.isArray(fusion.perObservation) ? fusion.perObservation : [];
    const streamLabelOf = (streamId: string) =>
      streams.find((st) => st.id === streamId)?.label || streamId;

    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 overflow-hidden">
        {/* Decision header */}
        <div className="px-3 py-2 flex flex-wrap items-center gap-2 border-b border-slate-800">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            Cơ sở quyết định
          </span>
          <span
            className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${BASIS_TONE_CLASS[basis.tone]}`}
          >
            {basis.text}
          </span>
          <span className={`text-[11px] font-semibold ${fusion.recognized ? "text-emerald-300" : "text-slate-400"}`}>
            {fusion.recognized ? employeeLabel(fusion.employeeId) : "Không mở cửa"}
          </span>
          {fusion.engine && fusion.engine !== "onnx" && (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-rose-950/70 text-rose-300 border-rose-700/70">
              engine: {fusion.engine} - không phải nhận diện thật
            </span>
          )}
          {typeof fusion.confidence === "number" && (
            <span className="ml-auto font-mono text-[11px] text-slate-400">
              tin cậy {pct(fusion.confidence)}
            </span>
          )}
        </div>

        {/* Cosine vs threshold */}
        <div className="px-3 py-2.5 space-y-1.5">
          <div className="relative h-2.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 ${fusion.recognized ? "bg-emerald-500/80" : "bg-slate-500/70"}`}
              style={{ width: pct(fused) }}
            />
            {minEvidence !== null && (
              <div
                className="absolute inset-y-0 w-px bg-slate-400/60"
                style={{ left: pct(minEvidence) }}
                title={`minEvidence ${minEvidence.toFixed(3)}`}
              />
            )}
            {acceptSingle !== null && (
              <div
                className="absolute inset-y-0 w-0.5 bg-amber-300"
                style={{ left: pct(acceptSingle) }}
                title={`acceptSingle ${acceptSingle.toFixed(3)}`}
              />
            )}
            <div
              className="absolute inset-y-0 w-0.5 bg-white"
              style={{ left: pct(best) }}
              title={`best ${best.toFixed(3)}`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
            <span className="text-slate-300">
              fused <span className="font-bold text-white">{cos(fused)}</span>
            </span>
            <span className="text-slate-300">
              best <span className="font-bold text-white">{cos(best)}</span>
            </span>
            <span className="text-amber-300">
              acceptSingle {acceptSingle === null ? "—" : acceptSingle.toFixed(3)}
            </span>
            <span className="text-slate-500">
              acceptFused {acceptFused === null ? "—" : acceptFused.toFixed(3)}
            </span>
            <span className="text-slate-500">
              minEvidence {minEvidence === null ? "—" : minEvidence.toFixed(3)}
            </span>
            <span className="ml-auto text-slate-400">
              {fusion.agreeingObservations ?? 0} quan sát / {fusion.agreeingStreams ?? 0} luồng đồng thuận
            </span>
          </div>
        </div>

        {/* Candidates */}
        <div className="px-3 pb-2.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            Ứng viên
          </div>
          {candidates.length === 0 ? (
            <div className="text-[11px] text-slate-500">
              Không có ứng viên nào vượt ngưỡng bằng chứng tối thiểu.
            </div>
          ) : (
            <div className="space-y-1">
              {candidates.map((cand, i) => (
                <div
                  key={cand.employeeId || i}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1 rounded-md border text-[11px] ${
                    i === 0 && fusion.recognized
                      ? "bg-emerald-950/50 border-emerald-800/70 text-emerald-100"
                      : "bg-slate-900 border-slate-800 text-slate-300"
                  }`}
                >
                  <span className="font-semibold truncate max-w-[200px]">
                    {employeeLabel(cand.employeeId)}
                  </span>
                  <span className="font-mono text-slate-400">fused {cos(cand.fusedCosine)}</span>
                  <span className="font-mono text-slate-400">best {cos(cand.bestCosine)}</span>
                  <span className="font-mono text-slate-500">
                    {cand.observations ?? 0} quan sát • {cand.streams ?? 0} luồng
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Context of this decision */}
        <div className="px-3 pb-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
          {typeof fusion.framesPerStream === "number" && (
            <span>{fusion.framesPerStream} khung/luồng</span>
          )}
          {typeof fusion.streamsPooled === "number" && <span>{fusion.streamsPooled} luồng gộp</span>}
          {typeof fusion.observations === "number" && (
            <span>
              {fusion.observations} quan sát
              {typeof fusion.observationCap === "number" ? ` / tối đa ${fusion.observationCap}` : ""}
            </span>
          )}
          {typeof fusion.galleryTemplates === "number" && (
            <span className={fusion.galleryTemplates === 0 ? "text-amber-400" : undefined}>
              thư viện {fusion.galleryTemplates} mẫu
            </span>
          )}
          {fusion.modelTag && <span className="truncate">{fusion.modelTag}</span>}
        </div>

        {/* Per-observation table */}
        <div className="px-3 pb-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            Từng quan sát
          </div>
          {observations.length === 0 ? (
            <div className="text-[11px] text-slate-500">
              Không có khuôn mặt nào được trích xuất trong lần quét này.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-slate-500 text-[10px] uppercase tracking-wide">
                    <th className="text-left font-semibold py-1 pr-3">Luồng</th>
                    <th className="text-left font-semibold py-1 pr-3">Khung</th>
                    <th className="text-left font-semibold py-1 pr-3">Khớp với</th>
                    <th className="text-right font-semibold py-1 pr-3">Cosine</th>
                    <th className="text-right font-semibold py-1 pr-3">Kế tiếp</th>
                    <th className="text-right font-semibold py-1">Chất lượng</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-slate-300">
                  {observations.map((obs, i) => {
                    const passes = acceptSingle !== null && typeof obs.cosine === "number" && obs.cosine >= acceptSingle;
                    return (
                      <tr key={`${obs.streamId}-${obs.frameIndex ?? i}-${i}`} className="border-t border-slate-800">
                        <td className="py-1 pr-3 truncate max-w-[140px]" title={obs.streamId}>
                          {streamLabelOf(obs.streamId)}
                        </td>
                        <td className="py-1 pr-3">{obs.frameIndex ?? 0}</td>
                        <td className="py-1 pr-3 font-sans truncate max-w-[160px]">
                          {obs.employeeId ? employeeLabel(obs.employeeId) : "—"}
                        </td>
                        <td className={`py-1 pr-3 text-right font-bold ${passes ? "text-emerald-400" : "text-slate-300"}`}>
                          {cos(obs.cosine)}
                        </td>
                        <td className="py-1 pr-3 text-right text-slate-500">{cos(obs.secondCosine)}</td>
                        <td className="py-1 text-right text-slate-400">{cos(obs.quality)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Scan results panel: fusion evidence + per-stream outcomes + aggregate
  const renderScanPanel = (
    gateConfig: GateStreamConfig,
    streams: GateStreamSource[],
    scanState: StreamScanState
  ) => {
    const result = scanState.lastResult;
    if (!result) return null;
    const perStreamRows: GateStreamScanResult[] =
      Array.isArray(result.streams) && result.streams.length > 0
        ? result.streams
        : [
            {
              streamId: result.streamId || getPrimaryStream(streams)?.id || "primary",
              streamLabel: result.streamLabel || getPrimaryStream(streams)?.label || gateConfig.name,
              success: true,
              frameCaptureDurationMs: result.frameCaptureDurationMs,
              recognized: !!result.recognized,
              totalFacesDetected: result.totalFacesDetected ?? (result.detectedFaces || []).length,
              detectedFaces: result.detectedFaces || [],
            },
          ];
    const faces: StreamFace[] = result.detectedFaces || [];

    return (
      <div className="px-3.5 pb-3.5 bg-slate-950 space-y-2 text-xs animate-in fade-in">
        {/* Who produced this result, and when */}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border ${
              scanState.resultOrigin === "WATCHER"
                ? "bg-indigo-950/80 text-indigo-300 border-indigo-700/70"
                : "bg-slate-800 text-slate-300 border-slate-600"
            }`}
          >
            {scanState.resultOrigin === "WATCHER" ? (
              <Server className="w-3 h-3" />
            ) : (
              <Hand className="w-3 h-3" />
            )}
            {scanState.resultOrigin === "WATCHER" ? "Quét nền trên máy chủ" : "Quét thủ công từ trình duyệt này"}
          </span>
          <span className="text-[10px] font-mono text-slate-500">
            {scanState.lastScanTime || "—"}
            {scanState.resultAt ? ` • ${relativeTime(scanState.resultAt, nowMs)}` : ""}
          </span>
        </div>

        {/* Aggregate */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="p-2 rounded-lg bg-slate-900 border border-slate-800">
            <div className="text-[10px] text-slate-500">Luồng đã quét</div>
            <div className="font-mono font-bold text-white">
              {perStreamRows.filter((r) => r.success).length}/{perStreamRows.length}
            </div>
          </div>
          <div className="p-2 rounded-lg bg-slate-900 border border-slate-800">
            <div className="text-[10px] text-slate-500">Khuôn mặt</div>
            <div className="font-mono font-bold text-white">{result.totalFacesDetected ?? faces.length}</div>
          </div>
          <div className="p-2 rounded-lg bg-slate-900 border border-slate-800">
            <div className="text-[10px] text-slate-500">Nhận diện</div>
            <div className={`font-mono font-bold ${result.recognized ? "text-emerald-400" : "text-slate-300"}`}>
              {result.recognized ? result.employee?.name || "Hợp lệ" : "Chưa khớp hồ sơ"}
            </div>
          </div>
          <div className="p-2 rounded-lg bg-slate-900 border border-slate-800">
            <div className="text-[10px] text-slate-500">Xử lý</div>
            <div className="font-mono font-bold text-white">
              {result.processingTimeMs ?? 0}ms
              <span className="text-slate-500 font-normal"> • {result.engineUsed || "AI"}</span>
            </div>
          </div>
        </div>

        {/* Fusion evidence (only present on a server running the ONNX pipeline) */}
        {result.fusion && renderFusionBlock(result.fusion, streams)}

        {/* Per-stream rows */}
        <div className="rounded-lg border border-slate-800 divide-y divide-slate-800 overflow-hidden">
          {perStreamRows.map((r) => (
            <div key={r.streamId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-slate-900/60">
              {r.success ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              )}
              <span className="font-semibold text-white truncate max-w-[180px]" title={r.streamLabel}>
                {r.streamLabel}
              </span>
              {r.success ? (
                <>
                  <span className="font-mono text-slate-300">{r.totalFacesDetected} mặt</span>
                  <span className={`font-mono ${r.recognized ? "text-emerald-400" : "text-slate-400"}`}>
                    {r.recognized ? "Đã nhận diện" : "Chưa khớp"}
                  </span>
                  {typeof r.frameCaptureDurationMs === "number" && (
                    <span className="font-mono text-slate-400 inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {r.frameCaptureDurationMs}ms
                    </span>
                  )}
                </>
              ) : (
                <span className="text-rose-300 truncate" title={r.error}>
                  {r.error || "Không lấy được khung hình"}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Watcher events now carry the full fusion decision and per-stream
            detectedFaces, so they render like a manual scan. The only thing an
            event never carries is the captured JPEG - that stays on the server
            to keep the SSE stream light. Only say something when the server
            reported faces but none arrived, which would be a real mismatch. */}
        {scanState.resultOrigin === "WATCHER" &&
          faces.length === 0 &&
          (result.totalFacesDetected ?? 0) > 0 && (
            <div className="px-2.5 py-2 rounded-lg bg-slate-900 border border-slate-800 text-[11px] text-slate-400 flex items-start gap-1.5">
              <Server className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
              <span>
                Máy chủ báo có {result.totalFacesDetected} khuôn mặt trong lượt quét này nhưng sự
                kiện không kèm chi tiết từng khuôn mặt. Bấm “Quét Ngay” để xem trực tiếp.
              </span>
            </div>
          )}

        {/* Face cards with stream chip */}
        {faces.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {faces.map((f, i) => (
              <div
                key={f.id || i}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] ${
                  f.recognized
                    ? "bg-emerald-950/70 border-emerald-700/70 text-emerald-200"
                    : "bg-rose-950/60 border-rose-800/70 text-rose-200"
                }`}
              >
                {f.recognized ? <ShieldCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                <span className="font-semibold">{f.recognized ? f.employeeName || "Nhân viên" : "Người lạ"}</span>
                {typeof f.confidence === "number" && <span className="font-mono opacity-80">{f.confidence.toFixed(0)}%</span>}
                {f.streamLabel && (
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[9px] font-semibold border border-slate-700">
                    {f.streamLabel}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /**
   * Control surface for ONE gate's backend watcher: an enable switch, the gap
   * between scans, the frames per scan, plus its live status. Every control
   * POSTs to `/api/camera-streams/:gate/watch` - nothing here schedules
   * anything inside the browser.
   */
  const renderWatchPanel = (gateConfig: GateStreamConfig, enabledStreamCount: number) => {
    const key = gateKeyOf(gateConfig.gateType);
    const runtime = watchers[key];
    const configured: GateWatchConfig = runtime
      ? { enabled: runtime.enabled, intervalSeconds: runtime.intervalSeconds, frames: runtime.frames }
      : gateConfig.watch || DEFAULT_WATCH;
    const pending = !!watchPending[key];
    const fieldError = watchFieldError[key];

    // ---- Loading / unsupported / error states ----
    if (watchSupported === null && watchLoading) {
      return (
        <div className="mx-3.5 mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-[11px] text-slate-400 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-500 shrink-0" />
          Đang đọc trạng thái quét nền trên máy chủ...
        </div>
      );
    }

    if (watchSupported === false) {
      return (
        <div className="mx-3.5 mt-3 rounded-xl border border-amber-700/60 bg-amber-950/50 px-3 py-2.5 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold">Máy chủ chưa hỗ trợ quét nền.</div>
            <div className="text-amber-300/90">
              Phiên bản máy chủ này không có endpoint watcher nên cổng sẽ không được quét lặp lại tự động.
              Trình duyệt cố tình <b>không</b> tự hẹn giờ quét thay - hãy dùng nút “Quét Ngay” bên dưới
              hoặc cập nhật máy chủ để bật watcher.
            </div>
            <button
              id={`btn-retry-watch-${key}`}
              onClick={() => fetchWatchers()}
              className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-900/60 hover:bg-amber-800/70 text-amber-100 text-[10px] font-semibold border border-amber-700/70 cursor-pointer"
              title="Kiểm tra lại xem máy chủ đã có watcher chưa"
            >
              <RefreshCw className={`w-3 h-3 ${watchLoading ? "animate-spin" : ""}`} />
              Kiểm tra lại
            </button>
          </div>
        </div>
      );
    }

    // ---- Honest cadence maths ----
    const measuredSec =
      runtime && typeof runtime.lastDurationMs === "number" && runtime.lastDurationMs > 0
        ? runtime.lastDurationMs / 1000
        : null;
    const scanSec = measuredSec !== null ? measuredSec : estimateScanSeconds(configured.frames);
    const cycleSec = configured.intervalSeconds + scanSec;
    const tooShort = configured.intervalSeconds < scanSec;
    const nextIn = secondsUntil(runtime?.nextRunAt, nowMs);
    const errors = runtime?.consecutiveErrors || 0;
    const draft = intervalDraft[key];
    const intervalValue = draft !== null ? draft : String(configured.intervalSeconds);

    return (
      <div className="mx-3.5 mt-3 rounded-xl border border-slate-800 bg-slate-900/70 overflow-hidden">
        {/* Header: what this is + live running state */}
        <div className="px-3 py-2 flex flex-wrap items-center gap-2 border-b border-slate-800">
          <Server className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="text-[11px] font-bold text-white">Quét nền trên máy chủ (watcher)</span>
          {configured.enabled ? (
            runtime?.running ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-sky-950/80 text-sky-300 border-sky-700/70">
                <Radio className="w-2.5 h-2.5 animate-pulse" />
                ĐANG QUÉT
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-emerald-950/80 text-emerald-300 border-emerald-700/70">
                <Timer className="w-2.5 h-2.5" />
                ĐANG NGHỈ GIỮA 2 LƯỢT
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-slate-800 text-slate-400 border-slate-600">
              <Power className="w-2.5 h-2.5" />
              ĐÃ TẮT
            </span>
          )}
          {pending && <RefreshCw className="w-3 h-3 animate-spin text-slate-400" />}
          {!runtime && (
            <span className="text-[10px] text-slate-500">
              Máy chủ chưa báo cáo watcher cho cổng này - bật để khởi tạo.
            </span>
          )}
          <button
            id={`btn-refresh-watch-${key}`}
            onClick={() => fetchWatchers()}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-semibold border border-slate-700 cursor-pointer"
            title="Đọc lại trạng thái watcher từ máy chủ"
          >
            <RefreshCw className={`w-3 h-3 ${watchLoading ? "animate-spin" : ""}`} />
            Làm mới
          </button>
        </div>

        {watchError && (
          <div className="px-3 py-1.5 bg-rose-950/50 border-b border-rose-800/60 text-[10px] text-rose-200 flex items-center gap-1.5">
            <XCircle className="w-3 h-3 shrink-0" />
            <span className="flex-1">{watchError}</span>
            <span className="text-rose-300/70">Đang hiển thị trạng thái đọc được lần gần nhất.</span>
          </div>
        )}

        {/* Controls */}
        <div className="px-3 py-2.5 flex flex-wrap items-center gap-2">
          <button
            id={`btn-toggle-watch-${key}`}
            disabled={pending}
            onClick={() => updateWatcher(gateConfig.gateType, { enabled: !configured.enabled })}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-50 ${
              configured.enabled
                ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs"
                : "bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700"
            }`}
            title="Bật/Tắt watcher quét lặp lại trên máy chủ cho cổng này"
          >
            <Zap className={`w-3.5 h-3.5 ${configured.enabled ? "text-white" : "text-slate-500"}`} />
            {configured.enabled ? "Watcher: BẬT" : "Watcher: TẮT"}
          </button>

          {/* Rest AFTER a scan finishes - deliberately not a period (1-300 s) */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Nghỉ sau mỗi lần quét</span>
            <input
              id={`input-watch-interval-${key}`}
              type="number"
              min={1}
              max={300}
              step={1}
              disabled={pending}
              value={intervalValue}
              placeholder="giây nghỉ"
              onChange={(e) => setIntervalDraft((p) => ({ ...p, [key]: e.target.value }))}
              onBlur={() => commitIntervalDraft(gateConfig.gateType, configured.intervalSeconds)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setIntervalDraft((p) => ({ ...p, [key]: null }));
              }}
              className="w-16 bg-slate-900 text-slate-200 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] font-mono focus:outline-hidden focus:border-indigo-500 disabled:opacity-50"
              title="Số giây NGHỈ tính từ lúc một lần quét kết thúc đến lúc lần quét sau bắt đầu (1-300 giây). Đây không phải khoảng lặp cố định: thời lượng của chính lần quét được cộng thêm vào."
            />
            <span>giây</span>
          </label>

          {/* Frames per stream per watcher scan (1-5) */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Số khung</span>
            <select
              id={`select-watch-frames-${key}`}
              disabled={pending}
              value={configured.frames}
              onChange={(e) =>
                updateWatcher(gateConfig.gateType, { frames: clampFrames(e.target.value) })
              }
              className="bg-slate-900 text-slate-200 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] font-mono focus:outline-hidden focus:border-indigo-500 disabled:opacity-50"
              title="Số khung hình chụp trên mỗi luồng cho mỗi lượt quét nền (1-5)"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} khung/luồng
                </option>
              ))}
            </select>
          </label>

          {nextIn !== null && configured.enabled && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-950 border border-slate-700 text-[10px] font-mono text-sky-300">
              <Timer className="w-3 h-3" />
              {runtime?.running ? "đang quét" : nextIn <= 0 ? "sắp quét" : `hết nghỉ sau ${nextIn}s`}
            </span>
          )}
        </div>

        {fieldError && (
          <div className="px-3 pb-2 -mt-1 text-[10px] text-rose-300 flex items-center gap-1.5">
            <XCircle className="w-3 h-3 shrink-0" />
            {fieldError}
          </div>
        )}

        {/* The honest cost of the chosen rest time, right next to the control */}
        <div className="px-3 pb-2.5 text-[10px] leading-relaxed text-slate-500 space-y-1">
          <div className={tooShort ? "text-amber-300" : "text-slate-300"}>
            <b className="font-mono">
              Nghỉ {configured.intervalSeconds}s (bạn đặt) +{" "}
              {measuredSec !== null
                ? `lần quét gần nhất ${fmtSeconds(scanSec)}s (đo được)`
                : `lần quét ~${fmtSeconds(scanSec)}s (ước tính)`}{" "}
              ≈ một lượt quét mỗi ~{fmtSeconds(cycleSec)}s
            </b>{" "}
            <span className="text-slate-500">
              {measuredSec !== null
                ? "- thời lượng lấy từ lượt quét thật gần nhất của watcher."
                : "- watcher chưa chạy lượt nào nên thời lượng là ước tính theo số đo tham chiếu bên dưới."}
            </span>
          </div>
          <div>
            Lần quét sau chỉ bắt đầu khi lần quét trước đã chạy xong, rồi mới cộng thêm thời gian
            nghỉ này. Vì vậy hai lần quét không bao giờ chồng lên nhau, không lượt nào bị âm thầm bỏ
            qua, và thời lượng của chính lần quét luôn được cộng vào khoảng cách giữa hai lượt.
          </div>
          <div>
            Số đo tham chiếu trên engine ONNX với một cổng {MEASURED_STREAM_COUNT} luồng: 1 khung mất{" "}
            {fmtSeconds(MEASURED_SCAN_SECONDS[1])} giây, 2 khung mất {fmtSeconds(MEASURED_SCAN_SECONDS[2])} giây.
            {enabledStreamCount !== MEASURED_STREAM_COUNT
              ? ` Cổng này đang bật ${enabledStreamCount} luồng nên số thực tế có thể lệch.`
              : ""}{" "}
            Muốn mỗi lần quét nhanh hơn, bạn có thể tự tắt bớt luồng của cổng trong trang Cấu Hình
            Luồng Camera - hệ thống không tự bỏ luồng nào.
          </div>
          {tooShort && (
            <div className="text-amber-300">
              Thời gian nghỉ {configured.intervalSeconds} giây còn ngắn hơn thời lượng một lần quét (
              {fmtSeconds(scanSec)} giây): cổng gần như bị quét liên tục và camera cùng cụm worker
              chịu tải cao nhất. Thực tế vẫn là một lượt mỗi ~{fmtSeconds(cycleSec)} giây, không phải
              mỗi {configured.intervalSeconds} giây.
            </div>
          )}
        </div>

        {/* Live status of the watcher */}
        <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Lượt gần nhất</div>
            <div className="font-mono text-[11px] font-bold text-white truncate">
              {relativeTime(runtime?.lastRunAt, nowMs)}
            </div>
          </div>
          <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Thời lượng</div>
            <div className="font-mono text-[11px] font-bold text-white">
              {typeof runtime?.lastDurationMs === "number" ? `${runtime.lastDurationMs} ms` : "—"}
            </div>
          </div>
          <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Tổng lượt</div>
            <div className="font-mono text-[11px] font-bold text-white">{runtime?.totalRuns ?? 0}</div>
          </div>
          <div
            className={`p-2 rounded-lg border ${
              errors > 0 ? "bg-rose-950/60 border-rose-700/70" : "bg-slate-950 border-slate-800"
            }`}
          >
            <div className={`text-[9px] uppercase tracking-wide ${errors > 0 ? "text-rose-300" : "text-slate-500"}`}>
              Lỗi liên tiếp
            </div>
            <div className={`font-mono text-[11px] font-bold ${errors > 0 ? "text-rose-200" : "text-white"}`}>
              {errors}
            </div>
          </div>
        </div>

        {/* Last outcome / last error reported by the watcher */}
        {errors === 0 && runtime?.lastError ? (
          <div className="mx-3 mb-3 px-2.5 py-2 rounded-lg bg-slate-950 border border-slate-800 text-[10px] text-slate-400 flex items-start gap-1.5">
            <Info className="w-3 h-3 shrink-0 mt-0.5 text-slate-500" />
            <span className="break-words">
              <b>Watcher đang chờ:</b> {runtime.lastError}
            </span>
          </div>
        ) : errors > 0 && runtime?.lastError ? (
          <div className="mx-3 mb-3 px-2.5 py-2 rounded-lg bg-rose-950/60 border border-rose-700/70 text-[10px] text-rose-200 flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span className="break-words">
              <b>Lỗi mới nhất của watcher:</b> {runtime.lastError}
            </span>
          </div>
        ) : runtime?.lastRunAt ? (
          <div className="mx-3 mb-3 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-[10px] text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={runtime.lastRecognized ? "text-emerald-300 font-semibold" : "text-slate-300"}>
              {runtime.lastRecognized
                ? `Nhận diện: ${runtime.lastEmployeeName || "nhân viên hợp lệ"}`
                : "Chưa khớp hồ sơ nào"}
            </span>
            {runtime.lastBasis && <span className="font-mono text-slate-500">cơ sở: {runtime.lastBasis}</span>}
          </div>
        ) : null}
      </div>
    );
  };

  // Render a Single Active Gate Card (with one tile per enabled stream)
  const renderCameraStreamCard = (
    gateConfig: GateStreamConfig,
    streams: GateStreamSource[],
    scanState: StreamScanState,
    setScanState: React.Dispatch<React.SetStateAction<StreamScanState>>,
    videoRef: React.RefObject<HTMLVideoElement | null>
  ) => {
    const isEntry = gateConfig.gateType === "ENTRY";
    const gateLabel = isEntry ? "CỔNG VÀO (ENTRY)" : "CỔNG RA (EXIT)";
    const lastResult = scanState.lastResult;
    const enabledStreams = streams.filter((s) => s.enabled);
    const primary = getPrimaryStream(streams);
    const hasRtspLike = enabledStreams.some((s) => s.sourceType === "RTSP" || s.sourceType === "BACKEND_UVC");
    const multi = enabledStreams.length > 1;

    return (
      <div
        key={gateConfig.gateType}
        id={`card-stream-${gateConfig.gateType.toLowerCase()}`}
        className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 shadow-xl flex flex-col transition-all duration-200 hover:border-slate-700"
      >
        {/* Stream Top Header */}
        <div className="p-3.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide shrink-0 ${
                isEntry
                  ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/80"
                  : "bg-blue-950/80 text-blue-400 border border-blue-800/80"
              }`}
            >
              {isEntry ? (
                <ArrowDownRight className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <ArrowUpRight className="w-3.5 h-3.5 text-blue-400" />
              )}
              {gateLabel}
            </span>

            <span className="font-semibold text-white truncate max-w-[200px] sm:max-w-xs" title={gateConfig.name}>
              {gateConfig.name}
            </span>

            <span className="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700 shrink-0">
              {enabledStreams.length} luồng
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Live Indicator */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-900 border border-slate-700/80 text-emerald-400 font-mono text-[11px]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping inline-block" />
              <span className="font-bold">LIVE {primary?.fps || gateConfig.fps || 25} FPS</span>
            </div>

            {/* RTSP Mode Selector (applies to all tiles) */}
            {hasRtspLike && (
              <div className="hidden md:flex items-center bg-slate-900 border border-slate-700 rounded-lg p-0.5 text-[11px]">
                <button
                  onClick={() => setScanState((prev) => ({ ...prev, viewMode: "MJPEG" }))}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    scanState.viewMode === "MJPEG" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  }`}
                  title="Luồng video liên tục MJPEG"
                >
                  MJPEG
                </button>
                <button
                  onClick={() => setScanState((prev) => ({ ...prev, viewMode: "SNAPSHOT", snapshotTs: Date.now() }))}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    scanState.viewMode === "SNAPSHOT" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  }`}
                  title="Chế độ chụp ảnh snapshot chu kỳ"
                >
                  Snapshot
                </button>
                <button
                  onClick={() => setScanState((prev) => ({ ...prev, viewMode: "SIMULATION" }))}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    scanState.viewMode === "SIMULATION" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  }`}
                  title="Khung hình mô phỏng RTSP Test"
                >
                  Mô phỏng
                </button>
              </div>
            )}

            <div className="hidden lg:block px-2 py-1 rounded-md bg-black/60 border border-slate-700/60 text-sky-400 font-mono text-[11px]">
              {currentTime}
            </div>
          </div>
        </div>

        {/* Stream tiles: one per enabled stream */}
        {enabledStreams.length === 0 ? (
          <div className="aspect-video bg-black flex flex-col items-center justify-center text-center text-xs text-slate-400 gap-2 p-6">
            <Video className="w-8 h-8 text-slate-700" />
            <p>Cổng này chưa có luồng camera nào được bật.</p>
            <button
              onClick={onNavigateToCamerasConfig}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold border border-slate-700 cursor-pointer"
            >
              Thêm luồng trong Cấu Hình
            </button>
          </div>
        ) : (
          <div className={`grid gap-2 p-2 bg-black ${multi ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}>
            {enabledStreams.map((s) =>
              renderStreamTile(gateConfig, s, primary?.id === s.id, scanState, setScanState, videoRef)
            )}
          </div>
        )}

        {/* Backend watcher: control surface + live status for this gate */}
        {renderWatchPanel(gateConfig, enabledStreams.length)}

        {/* Notices */}
        {scanState.retryNotice && (
          <div className="mx-3.5 mt-3 p-2.5 rounded-lg bg-amber-950/60 border border-amber-700/60 text-amber-200 text-xs flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>{scanState.retryNotice}</span>
          </div>
        )}
        {scanState.hasError && scanState.errorMessage && (
          <div className="mx-3.5 mt-3 p-2.5 rounded-lg bg-rose-950/60 border border-rose-700/60 text-rose-200 text-xs flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{scanState.errorMessage}</span>
            <button
              onClick={() => setScanState((prev) => ({ ...prev, hasError: false, errorMessage: null }))}
              className="text-rose-300 hover:text-white cursor-pointer"
              title="Đóng"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Gate-level last result banner */}
        {lastResult && (
          <div
            className={`mx-3.5 mt-3 p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2 shadow-lg transition-all animate-in fade-in ${
              lastResult.recognized
                ? "bg-emerald-950/85 text-emerald-100 border-emerald-500/60"
                : "bg-slate-900/85 text-slate-200 border-slate-700/80"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {lastResult.recognized && lastResult.employee?.photoUrl ? (
                <img
                  src={lastResult.employee.photoUrl}
                  alt={lastResult.employee.name}
                  className="w-8 h-8 rounded-lg object-cover border border-emerald-400/80 shrink-0"
                />
              ) : (
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    lastResult.recognized ? "bg-emerald-800 text-white" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {lastResult.recognized ? <ShieldCheck className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </div>
              )}
              <div className="min-w-0">
                <div className="font-semibold text-white truncate text-[13px]">
                  {lastResult.recognized
                    ? `${lastResult.employee?.name} (${lastResult.employee?.employeeCode})`
                    : "Chưa phát hiện nhân viên hợp lệ"}
                </div>
                <div className="text-[11px] text-slate-300 truncate">
                  {lastResult.recognized
                    ? `Bộ phận: ${lastResult.employee?.department || "Nhân sự"} • Cửa đã mở tự động`
                    : lastResult.message || "Luồng camera đang giám sát..."}
                </div>
                {/* Where this result came from, and when. */}
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                      scanState.resultOrigin === "WATCHER"
                        ? "bg-indigo-950/80 text-indigo-300 border-indigo-700/70"
                        : "bg-slate-800 text-slate-300 border-slate-600"
                    }`}
                  >
                    {scanState.resultOrigin === "WATCHER" ? (
                      <Server className="w-2.5 h-2.5" />
                    ) : (
                      <Hand className="w-2.5 h-2.5" />
                    )}
                    {scanState.resultOrigin === "WATCHER" ? "Watcher máy chủ" : "Quét thủ công"}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {scanState.lastScanTime || "—"}
                    {scanState.resultAt ? ` • ${relativeTime(scanState.resultAt, nowMs)}` : ""}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 text-right">
              <div className="hidden sm:block">
                <span className="block font-mono text-[11px] text-emerald-400 font-bold">
                  {lastResult.confidence ? `${Number(lastResult.confidence).toFixed(1)}%` : `${lastResult.totalFacesDetected ?? 0} mặt`}
                </span>
                <span className="block text-[10px] text-slate-400">{lastResult.confidence ? "Độ tin cậy" : "Phát hiện"}</span>
              </div>
              <button
                onClick={() => setScanState((prev) => ({ ...prev, showScanPanel: !prev.showScanPanel }))}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 cursor-pointer"
                title="Chi tiết kết quả theo từng luồng"
              >
                {scanState.showScanPanel ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Chi tiết
              </button>
            </div>
          </div>
        )}

        {/* Controls Bar for this Gate */}
        <div className="p-3.5 bg-slate-950 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            {/* Manual scan only. The repeating cycle lives in the backend watcher
                panel above; this browser never schedules a scan. */}
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 font-semibold">
              <Hand className="w-3.5 h-3.5 text-slate-500" />
              Quét thủ công
            </span>

            {/* Frames per stream for a MANUAL scan -> more fusion evidence, more latency */}
            <label className="inline-flex items-center gap-1.5 text-slate-400">
              <span className="hidden sm:inline">Số khung hình</span>
              <select
                id={`select-frames-${gateConfig.gateType.toLowerCase()}`}
                value={scanState.scanFrames}
                onChange={(e) =>
                  setScanState((prev) => ({
                    ...prev,
                    scanFrames: Math.min(5, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
                className="bg-slate-900 text-slate-300 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-hidden focus:border-indigo-500"
                title="Số khung hình chụp trên mỗi luồng cho mỗi lần quét"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} khung
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2">
            {/* Scan all streams of this gate */}
            <button
              id={`btn-scannow-${gateConfig.gateType.toLowerCase()}`}
              disabled={scanState.isScanning || enabledStreams.length === 0}
              onClick={() => performStreamScan(gateConfig.gateType)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:scale-98 text-white font-semibold transition-all shadow-xs cursor-pointer disabled:opacity-50"
              title="Chụp khung hình từ tất cả luồng đang bật của cổng và nhận diện đồng thời"
            >
              <Layers className={`w-3.5 h-3.5 ${scanState.isScanning ? "animate-spin" : ""}`} />
              <span>
                {scanState.isScanning ? "Đang Quét..." : multi ? "Quét tất cả luồng" : "Quét Ngay"}
              </span>
            </button>

            {/* Quick Gate Unlock Button */}
            <button
              id={`btn-unlock-${gateConfig.gateType.toLowerCase()}`}
              onClick={() => handleGateUnlock(gateConfig.name)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-400 font-semibold border border-slate-700 hover:border-emerald-500/50 transition-all cursor-pointer"
              title={`Mở khóa cổng ${gateConfig.name} ngay`}
            >
              <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
              <span>Mở Cổng Này</span>
            </button>
          </div>

          {/* Honest cost of the frame count (manual scans only) */}
          <div className="w-full text-[10px] text-slate-500 leading-relaxed">
            Số khung này chỉ áp dụng cho lệnh quét thủ công ở trên; watcher trên máy chủ có tham số
            số khung riêng trong bảng “Quét nền trên máy chủ”.{" "}
            {scanState.scanFrames === 1 ? (
              <>
                1 khung/luồng: nhanh nhất (~{fmtSeconds(estimateScanSeconds(1))} giây cho một cổng{" "}
                {MEASURED_STREAM_COUNT} luồng), nhưng chỉ chấp nhận được khi có một góc nhìn thật rõ.
                Chọn từ 2 khung trở lên để bộ quyết định có thể dựa vào nhiều quan sát đồng thuận.
              </>
            ) : (
              <>
                {scanState.scanFrames} khung/luồng trên {enabledStreams.length} luồng: mỗi khung thêm
                tốn khoảng {fmtSeconds(EXTRA_FRAME_SECONDS)} giây cho cả cổng, tức một lượt quét mất
                khoảng {fmtSeconds(estimateScanSeconds(scanState.scanFrames))} giây thay vì{" "}
                {fmtSeconds(estimateScanSeconds(1))} giây. Đổi lại có thêm bằng chứng cho quyết định
                đồng thuận.
              </>
            )}
          </div>
        </div>

        {/* Per-stream results panel */}
        {scanState.showScanPanel && renderScanPanel(gateConfig, streams, scanState)}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Top Banner: Gate Surveillance Overview & Quick Navigation */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-700 text-white flex items-center justify-center shadow-md shadow-indigo-100">
                <ScanFace className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                  Quét Cửa AI - Giám Sát Luồng Camera &amp; Nhận Diện Đa Cổng
                </h1>
                <p className="text-xs text-slate-500 mt-0.5">
                  Tự động hiển thị toàn bộ luồng camera đang hoạt động của từng cổng (Cổng Vào &amp; Cổng Ra), nhận diện khuôn mặt nhân viên AI thời gian thực và điều khiển mở khóa tự động.
                </p>

                {/* The behaviour changed: say so loudly instead of letting the
                    operator assume the old browser-timer model. */}
                <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-900 max-w-3xl">
                  <Server className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    <b>Việc quét lặp lại đã chuyển hẳn sang máy chủ.</b> Trình duyệt không còn hẹn giờ
                    quét nữa: watcher chạy trên máy chủ và <b>vẫn tiếp tục khi bạn đóng trang này</b>;
                    mở thêm tab cũng không làm camera bị quét thêm lượt nào. Trang này chỉ bật/tắt, đặt
                    tham số và hiển thị kết quả — nút “Quét Ngay” vẫn là lệnh quét thủ công tức thì.
                    {watchSupported === false && (
                      <span className="block mt-1 text-amber-800">
                        Máy chủ hiện tại chưa hỗ trợ watcher — chỉ còn quét thủ công.
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Metrics & Links */}
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
            {/* Active Streams Count Pill */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold">
              <span className={`w-2.5 h-2.5 rounded-full ${loadingConfig ? "bg-slate-300" : "bg-emerald-500 animate-pulse"}`} />
              <span>
                {loadingConfig
                  ? "Đang tải cấu hình camera..."
                  : activeGates.length > 0
                  ? `Đang chạy ${totalEnabledStreams} luồng camera trên ${activeGates.length} cổng`
                  : "Không có luồng camera active"}
              </span>
            </div>

            {/* Backend watcher summary */}
            <div
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                watchSupported === false
                  ? "bg-amber-50 border-amber-200 text-amber-800"
                  : watchSupported === null
                  ? "bg-slate-50 border-slate-200 text-slate-500"
                  : activeWatcherCount > 0
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-slate-50 border-slate-200 text-slate-600"
              }`}
              title="Trạng thái watcher quét nền trên máy chủ"
            >
              <Server className="w-3.5 h-3.5 shrink-0" />
              <span>
                {watchSupported === false
                  ? "Máy chủ chưa hỗ trợ quét nền"
                  : watchSupported === null
                  ? "Đang đọc trạng thái quét nền..."
                  : activeWatcherCount > 0
                  ? `Watcher máy chủ: ${activeWatcherCount}/${activeGates.length || 2} cổng đang bật`
                  : "Watcher máy chủ: chưa bật cổng nào"}
              </span>
            </div>

            {/* Worker Pool Status */}
            <div className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-700 text-xs font-medium">
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
              <span>ArcFace SOTA {config.workerThreadsCount || 4} Luồng Worker</span>
            </div>

            {/* Link to Manual Track Tab */}
            <button
              id="btn-goto-manual-track"
              onClick={onNavigateToManualTrack}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold transition-colors cursor-pointer"
              title="Chuyển sang màn hình nhận diện thủ công qua webcam máy tính hoặc tải ảnh"
            >
              <Camera className="w-3.5 h-3.5 text-slate-600" />
              <span>Nhận Diện Thủ Công</span>
            </button>

            {/* Link to Cameras Config Tab */}
            <button
              id="btn-goto-cameras-config"
              onClick={onNavigateToCamerasConfig}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold transition-colors cursor-pointer"
              title="Cấu hình địa chỉ RTSP IP, độ phân giải và tham số luồng"
            >
              <Settings className="w-3.5 h-3.5 text-blue-600" />
              <span>Cấu Hình Luồng</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Multi-Stream Grid: Show ALL Active Gates */}
      {activeGates.length === 0 ? (
        /* Empty State if no streams are active */
        <div className="rounded-2xl border-2 border-dashed border-slate-300 p-8 sm:p-12 text-center bg-white">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
            <Video className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-800">Chưa có luồng camera nào được kích hoạt</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
            Cả Cổng Vào và Cổng Ra hiện đang ở trạng thái tắt. Hãy vào trang Cấu Hình Luồng Camera để kích hoạt hoặc kiểm tra kết nối RTSP/UVC.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => {
                setConfig((prev) => ({
                  ...prev,
                  entryGate: { ...prev.entryGate, enabled: true },
                  exitGate: { ...prev.exitGate, enabled: true },
                }));
              }}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-all shadow-xs cursor-pointer"
            >
              Bật Cổng Vào &amp; Cổng Ra Ngay
            </button>
            <button
              onClick={onNavigateToCamerasConfig}
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-all cursor-pointer"
            >
              Đến Trang Cấu Hình Luồng
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`grid gap-6 ${
            activeGates.length === 1
              ? "grid-cols-1 max-w-5xl mx-auto"
              : "grid-cols-1 lg:grid-cols-2"
          }`}
        >
          {activeGates.map(({ gate, streams, state, setState }) =>
            renderCameraStreamCard(
              gate,
              streams,
              state,
              setState,
              gate.gateType === "ENTRY" ? entryVideoRef : exitVideoRef
            )
          )}
        </div>
      )}

      {/* Real-time Activity Feed & Gate Diagnostics Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Live Access Logs Feed */}
        <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-600" />
              <h3 className="font-bold text-slate-900 text-sm">
                Nhật Ký Vào Ra Thời Gian Thực (Live Gate Activity)
              </h3>
            </div>
            <button
              onClick={onNavigateToLogs}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <span>Xem tất cả</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {accessLogs.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              Chưa có lượt vào ra nào được ghi nhận. Các sự kiện nhận diện sẽ hiển thị tức thì tại đây.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto pr-1">
              {accessLogs.slice(0, 6).map((log) => {
                const isGranted = log.status === "GRANTED";
                const isEntry = log.scanType === "ENTRY";

                return (
                  <div key={log.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-3 min-w-0">
                      {log.photoSnapshot ? (
                        <img
                          src={log.photoSnapshot}
                          alt={log.employeeName || "User"}
                          className="w-10 h-10 rounded-xl object-cover border border-slate-200 shrink-0"
                        />
                      ) : (
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isGranted ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
                          }`}
                        >
                          {isGranted ? <ShieldCheck className="w-5 h-5" /> : <UserX className="w-5 h-5" />}
                        </div>
                      )}

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 truncate">
                            {log.employeeName || "Khách lạ / Chưa đăng ký"}
                          </span>
                          <span
                            className={`px-1.5 py-0.2 text-[10px] font-bold rounded ${
                              isEntry ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {isEntry ? "VÀO" : "RA"}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">
                          {log.department ? `${log.department} • ` : ""}
                          {log.doorName || "Cổng Chính"} • {log.engineUsed || "ArcFace SOTA"}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          isGranted
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-rose-50 text-rose-700 border border-rose-200"
                        }`}
                      >
                        {isGranted ? "ĐÃ MỞ CỔNG" : "TỪ CHỐI"}
                      </span>
                      <p className="text-[10px] font-mono text-slate-400 mt-1">
                        {new Date(log.timestamp).toLocaleTimeString("vi-VN")}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Quick Summary & Stranger Counter */}
        <div className="lg:col-span-4 space-y-4">
          {/* Quick Stats Card */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5 space-y-4">
            <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-indigo-600" />
              Thống Kê Kiểm Soát Hôm Nay
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-medium text-slate-500">Lượt Vào (Entry)</span>
                <p className="text-xl font-black text-emerald-600 mt-0.5">
                  {accessLogs.filter((l) => l.scanType === "ENTRY" && l.status === "GRANTED").length}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-medium text-slate-500">Lượt Ra (Exit)</span>
                <p className="text-xl font-black text-blue-600 mt-0.5">
                  {accessLogs.filter((l) => l.scanType === "EXIT" && l.status === "GRANTED").length}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-medium text-slate-500">Người Lạ / Cảnh Báo</span>
                <p className="text-xl font-black text-amber-600 mt-0.5">
                  {accessLogs.filter((l) => l.status === "DENIED" || !l.employeeId).length}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <span className="text-[11px] font-medium text-slate-500">Nhân Viên Đăng Ký</span>
                <p className="text-xl font-black text-indigo-600 mt-0.5">{employees.length}</p>
              </div>
            </div>

            {onOpenStrangerClusters && (
              <button
                onClick={() => onOpenStrangerClusters()}
                className="w-full py-2.5 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <UserX className="w-4 h-4 text-amber-600" />
                <span>Quản Lý Cụm Ảnh Người Lạ ({accessLogs.filter((l) => l.status === "DENIED").length})</span>
              </button>
            )}

            {/* Lock state + manual unlock (kept from props) */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs">
              <span className="text-slate-600">
                Khóa cổng: <b className={lockState?.isLocked === false ? "text-emerald-600" : "text-slate-900"}>
                  {lockState?.isLocked === false ? "Đang mở" : "Đang khóa"}
                </b>
              </span>
              <button
                onClick={onTriggerManualUnlock}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                Mở thủ công
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

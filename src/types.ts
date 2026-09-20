export type ScanType = 'ENTRY' | 'EXIT';

export interface Employee {
  id: string;
  name: string;
  employeeCode: string;
  department: string;
  position: string;
  photoUrl: string; // Base64 or URL
  registeredAt: string;
  accessLevel: 'ALL_ACCESS' | 'OFFICE_HOURS' | 'RESTRICTED';
}

export interface AccessLog {
  id: string;
  timestamp: string;
  type: ScanType;
  status: 'GRANTED' | 'DENIED';
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
}

export interface StrangerPhoto {
  logId: string;
  photoSnapshot: string;
  timestamp: string;
  confidence: number;
  doorName: string;
  reason?: string;
  faceEmbeddingHash?: string;
}

export interface StrangerCluster {
  clusterId: string;
  label: string;
  photos: StrangerPhoto[];
  firstSeen: string;
  lastSeen: string;
  totalSightings: number;
  primaryPhoto: string;
  estimatedGender?: string;
  similarityScore: number;
  suggestedName?: string;
  notes?: string;
}

export interface QuickRegisterStrangerPayload {
  name: string;
  employeeCode: string;
  department: string;
  position: string;
  accessLevel: 'ALL_ACCESS' | 'OFFICE_HOURS' | 'RESTRICTED';
  photoUrl: string;
  clusterLogIds: string[];
  retroUpdateLogs?: boolean;
}

export interface SmartLockState {
  lockId: string;
  doorName: string;
  state: 'LOCKED' | 'UNLOCKED' | 'UNLOCKING' | 'LOCKING';
  isLocked: boolean;
  batteryLevel: number;
  signalDbm: number;
  firmwareVersion: string;
  lastActionAt: string;
  lastActionBy: string;
  autoRelockSeconds: number;
  remainingRelockSeconds: number;
  status: 'ONLINE' | 'OFFLINE';
}

export interface MobileNotification {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  type: 'SUCCESS' | 'WARNING' | 'INFO' | 'ALERT';
  read: boolean;
  employeeId?: string;
  employeeName?: string;
}

export interface DetectedFace {
  id: string;
  box2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] in 0-1000 normalized coordinates
  employeeId?: string;
  employeeName?: string;
  employeeCode?: string;
  department?: string;
  confidence: number;
  livenessScore: number;
  recognized: boolean;
  message?: string;
}

export interface FaceRecognitionResult {
  recognized: boolean;
  employee?: Employee;
  recognizedEmployees?: Employee[];
  detectedFaces: DetectedFace[];
  totalFacesDetected: number;
  authorizedCount: number;
  unauthorizedCount: number;
  processingTimeMs: number;
  confidence: number;
  livenessScore: number;
  message: string;
  lockUnlocked: boolean;
  detectedFeatures?: string;
  log?: AccessLog;
  logs?: AccessLog[];
  engineUsed?: string;
  modelUsed?: string;
  multiThreadUsed?: boolean;
  workerId?: number;
  threadLatencyMs?: number;
}

export type RecognitionEngineMode = "GOOGLE_GEMINI" | "LOCAL_BIOMETRIC" | "HYBRID_AUTO";
export type GoogleAiModel =
  | "gemini-3.8-flash"
  | "gemini-flash-latest"
  | "gemini-3.1-flash-lite"
  | "gemini-3.1-pro-preview";
export type LocalBiometricModel =
  | "blazeface-arcface-sota"
  | "mediapipe-facemesh-dense"
  | "mobilefacenet-quantized";

export interface AiRecognitionConfig {
  engineMode: RecognitionEngineMode;
  googleAi: {
    model: GoogleAiModel;
    temperature: number;
    minConfidence: number; // 50 - 99
    useSystemFallback: boolean;
    customPrompt?: string;
  };
  localModel: {
    modelArchitecture: LocalBiometricModel;
    similarityThreshold: number; // 0.50 - 0.95
    livenessSensitivity: "LOW" | "MEDIUM" | "HIGH";
    maxFaces: number; // 1 - 8
    autoContrast: boolean;
    antiSpoofing: boolean;
  };
  hybridSettings: {
    localPreFilterThreshold: number; // e.g. 0.85
    fallbackToCloudOnUnknown: boolean;
  };
}

export interface BenchmarkResult {
  googleAiResult?: {
    model: string;
    latencyMs: number;
    recognized: boolean;
    facesCount: number;
    detectedEmployees: string[];
    confidence: number;
    livenessScore: number;
    message: string;
    error?: string;
  };
  localResult: {
    model: string;
    latencyMs: number;
    recognized: boolean;
    facesCount: number;
    detectedEmployees: string[];
    confidence: number;
    livenessScore: number;
    cosineSimilarity: number;
    message: string;
  };
  speedDifference: string;
  recommendation: string;
}

export interface WebhookLog {
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
  scanType: ScanType;
  userName: string;
}

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  gateInTitle: string;
  gateOutTitle: string;
  includeEmployeeCode: boolean;

  // ---- Stranger ("người lạ") alert ----
  /** Send a webhook when an unrecognised face is captured. Default true. */
  strangerAlertEnabled?: boolean;
  /** Attachment title for the alert, e.g. "[[CẢNH BÁO NGƯỜI LẠ]]". */
  strangerTitle?: string;
  /** Link text shown in the chat message, e.g. "Xem cụm ảnh người lạ". */
  strangerLinkLabel?: string;
  /**
   * Public base URL of this app, used to build the click-through link.
   * Falls back to the APP_URL env var, then to the request's own origin.
   * No trailing slash, e.g. "https://stg-gate-watch.vota.vn".
   */
  appBaseUrl?: string;
  /** Minimum seconds between two stranger alerts, to avoid flooding. Default 60. */
  strangerCooldownSeconds?: number;
}

/**
 * Deep link into the stranger-cluster panel.
 *   `<base>/#strangers`            → open the panel
 *   `<base>/#strangers/<logId>`    → open it with the cluster holding that sighting selected
 * Hash-based so no server route is needed and the SPA redirect rules still apply.
 */
export const STRANGER_DEEP_LINK_HASH = "strangers";

export type DoorAuthHeaderType = "BEARER" | "API_KEY" | "CUSTOM_HEADER" | "QUERY_PARAM";

export interface DoorControllerConfig {
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

export interface DoorApiLog {
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

// ----------------- CAMERA STREAM & GATE IN/OUT CONFIGURATION -----------------
export type CameraSourceType = "CLIENT_UVC" | "RTSP" | "HTTP_MJPEG" | "BACKEND_UVC";

/**
 * One video source attached to a gate. A gate may have several (e.g. the exit
 * gate watched by two NVR channels); `streams[0]` is the PRIMARY stream.
 */
export interface GateStreamSource {
  /** Stable id used in API calls (`?stream=<id>`), e.g. "exit-501". */
  id: string;
  /** Human label shown in the UI, e.g. "BVE-CUA-KHO". */
  label: string;
  sourceType: CameraSourceType;
  // RTSP settings
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  // HTTP / MJPEG settings
  httpUrl?: string;
  // Client UVC (Browser MediaDevices) settings
  uvcDeviceId?: string;
  uvcDeviceLabel?: string;
  // Backend UVC (Server /dev/videoX) settings
  backendDevicePath?: string;
  resolution?: "1920x1080" | "1280x720" | "640x480" | "AUTO";
  fps?: number;
  /** Disabled streams are kept in config but never captured or scanned. */
  enabled: boolean;
  /** Lower runs/shows first. The lowest-priority enabled stream is the primary. */
  priority: number;
}

export interface GateStreamConfig {
  gateType: "ENTRY" | "EXIT";
  name: string;
  enabled: boolean;
  /**
   * All video sources for this gate. Optional for backward compatibility:
   * when absent or empty, the server derives a single stream from the legacy
   * single-stream fields below. The server always keeps the legacy fields
   * mirrored from the primary stream so older clients keep working.
   */
  streams?: GateStreamSource[];
  // ---- Legacy single-stream fields (mirror of the primary stream) ----
  sourceType: CameraSourceType;
  // RTSP settings
  rtspUrl?: string;
  rtspTransport?: "TCP" | "UDP";
  // HTTP / MJPEG settings
  httpUrl?: string;
  // Client UVC (Browser MediaDevices) settings
  uvcDeviceId?: string;
  uvcDeviceLabel?: string;
  resolution?: "1920x1080" | "1280x720" | "640x480" | "AUTO";
  fps?: number;
  // Backend UVC (Server /dev/videoX) settings
  backendDevicePath?: string;
  autoStart: boolean;
  reconnectIntervalSeconds: number;
}

// ----------------- REAL FACE ENGINE (Phase 1): TEMPLATES & MULTI-STREAM FUSION -----------------

/** One enrolled face embedding for an employee. An employee may have many. */
export interface FaceTemplate {
  id: string;
  employeeId: string;
  /** L2-normalised embedding; length must match `dims`. */
  embedding: number[];
  dims: number;
  /** Which model produced it, e.g. "arcface_w600k_r50". Never compare across tags. */
  modelTag: string;
  source: "enrollment" | "merge" | "manual" | "auto";
  /** 0-1 capture quality (size × sharpness × detector score). */
  quality: number;
  capturedAt: string;
  sourceLogId?: string;
  /** Which camera stream captured it, when known. */
  streamId?: string;
}

/** One detected face from one frame of one stream, already embedded. */
export interface FaceObservation {
  streamId: string;
  streamLabel?: string;
  frameIndex?: number;
  embedding: number[];
  /** 0-1 capture quality; weights this observation in fusion. */
  quality: number;
  detectorScore: number;
  /** Face box in source-frame pixels [x1, y1, x2, y2]. */
  box?: [number, number, number, number];
}

/** Best gallery match for one observation. */
export interface ObservationMatch {
  streamId: string;
  frameIndex?: number;
  employeeId?: string;
  /** Best cosine against that employee's templates (max over templates). */
  cosine: number;
  /** Runner-up employee cosine, for margin/ambiguity checks. */
  secondCosine: number;
  secondEmployeeId?: string;
  quality: number;
}

export interface FusionThresholds {
  /** Single-observation accept threshold (one strong view is enough). */
  acceptSingle: number;
  /** Minimum per-observation cosine for an observation to count as agreeing evidence. */
  minEvidence: number;
  /** Quality-weighted mean cosine required when accepting on multi-view agreement. */
  acceptFused: number;
  /** Observations (frames × streams) that must agree for a fused accept. */
  minAgreeing: number;
  /** Minimum gap between best and runner-up identity to avoid ambiguous accepts. */
  minMargin: number;
}

export interface FusionDecision {
  recognized: boolean;
  employeeId?: string;
  /** 0-1 confidence derived from fused cosine, agreement and margin. */
  confidence: number;
  /** Quality-weighted mean cosine of the agreeing observations for the winner. */
  fusedCosine: number;
  /** Best single cosine for the winner. */
  bestCosine: number;
  /** How many observations agreed on the winner, and across how many distinct streams. */
  agreeingObservations: number;
  agreeingStreams: number;
  /** "single-strong" | "multi-agree" | "rejected-weak" | "rejected-ambiguous" | "rejected-no-face" */
  basis: string;
  /** Per-identity evidence, best first - for UI/audit. */
  candidates: Array<{ employeeId: string; fusedCosine: number; bestCosine: number; observations: number; streams: number }>;
  perObservation: ObservationMatch[];
  thresholds: FusionThresholds;
}

/** Per-stream outcome inside a multi-stream gate scan (`POST /api/camera-streams/scan-rtsp`). */
export interface GateStreamScanResult {
  streamId: string;
  streamLabel: string;
  success: boolean;
  frameCaptureDurationMs?: number;
  recognized: boolean;
  totalFacesDetected: number;
  detectedFaces: DetectedFace[];
  error?: string;
}

export interface CameraStreamsConfig {
  entryGate: GateStreamConfig;
  exitGate: GateStreamConfig;
  workerThreadsCount: number;
  multiThreadEnabled: boolean;
  autoFailoverToClientUvc: boolean;
  maxFpsPerStream: number;
  backendCaptureFps: number;
}

export interface WorkerThreadStatus {
  id: number;
  status: "IDLE" | "BUSY";
  tasksCompleted: number;
  lastLatencyMs: number;
  currentTaskId?: string | null;
  startedAt?: string;
}

export interface ThreadPoolTelemetry {
  enabled: boolean;
  workerThreadsCount: number;
  activeWorkers: number;
  queueDepth: number;
  totalProcessed: number;
  averageLatencyMs: number;
  workers: WorkerThreadStatus[];
}


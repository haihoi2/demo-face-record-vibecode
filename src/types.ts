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
}

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

export interface GateStreamConfig {
  gateType: "ENTRY" | "EXIT";
  name: string;
  enabled: boolean;
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


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

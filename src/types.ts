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

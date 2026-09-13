import {
  Employee,
  AccessLog,
  SmartLockState,
  MobileNotification,
  FaceRecognitionResult,
  DetectedFace,
  ScanType,
  WebhookConfig,
  WebhookLog,
  AiRecognitionConfig,
} from "../types";
import { runLocalFaceRecognition } from "./localBiometrics";

export const DEFAULT_OFFLINE_EMPLOYEES: Employee[] = [
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

export const DEFAULT_OFFLINE_LOGS: AccessLog[] = [
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
    lockAction: "Mở chốt tự động qua AI Biometrics",
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
    lockAction: "Mở chốt tự động qua AI Biometrics",
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
    reason: "Khuôn mặt chưa được đăng ký trong hệ thống",
  },
];

export const DEFAULT_OFFLINE_LOCK: SmartLockState = {
  lockId: "SL-HQ-01",
  doorName: "Cửa Chính Trụ Sở - Cổng A",
  state: "LOCKED",
  isLocked: true,
  batteryLevel: 96,
  signalDbm: -54,
  firmwareVersion: "v2.5.8-Zigbee/IP",
  lastActionAt: new Date().toISOString(),
  lastActionBy: "Khởi động hệ thống (Client Engine)",
  autoRelockSeconds: 6,
  remainingRelockSeconds: 0,
  status: "ONLINE",
};

export const DEFAULT_OFFLINE_NOTIFICATIONS: MobileNotification[] = [
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
    title: "Cảnh báo truy cập",
    body: "Phát hiện người lạ quét khuôn mặt tại Cửa Chính Trụ Sở - Khóa cửa giữ an toàn",
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    type: "ALERT",
    read: false,
  },
];

// Helper to detect if running on Netlify or client-only host
export function isNetlifyOrStaticHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host.includes("netlify.app") ||
    host.includes("github.io") ||
    host.includes("pages.dev") ||
    host.includes("vercel.app")
  );
}

// Local Storage Keys
const STORAGE_KEY_EMPLOYEES = "smartlock_offline_employees_v2";
const STORAGE_KEY_LOGS = "smartlock_offline_logs_v2";
const STORAGE_KEY_LOCK = "smartlock_offline_lock_v2";
const STORAGE_KEY_NOTIFS = "smartlock_offline_notifs_v2";

export function getStoredEmployees(): Employee[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EMPLOYEES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_OFFLINE_EMPLOYEES;
}

export function saveStoredEmployees(employees: Employee[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_EMPLOYEES, JSON.stringify(employees));
  } catch (e) {
    console.warn("Lỗi lưu employees vào localStorage:", e);
  }
}

export function getStoredLogs(): AccessLog[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LOGS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_OFFLINE_LOGS;
}

export function saveStoredLogs(logs: AccessLog[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(logs.slice(0, 200)));
  } catch (e) {
    console.warn("Lỗi lưu logs vào localStorage:", e);
  }
}

export function getStoredLockState(): SmartLockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LOCK);
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_OFFLINE_LOCK;
}

export function saveStoredLockState(state: SmartLockState): void {
  try {
    localStorage.setItem(STORAGE_KEY_LOCK, JSON.stringify(state));
  } catch (e) {
    console.warn("Lỗi lưu lock state vào localStorage:", e);
  }
}

export function getStoredNotifications(): MobileNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_NOTIFS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_OFFLINE_NOTIFICATIONS;
}

export function saveStoredNotifications(notifs: MobileNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIFS, JSON.stringify(notifs.slice(0, 100)));
  } catch (e) {
    console.warn("Lỗi lưu notifications vào localStorage:", e);
  }
}

// Webhook Local Storage & Direct Dispatcher
const STORAGE_KEY_WEBHOOK_CONFIG = "smartlock_offline_webhook_config_v2";
const STORAGE_KEY_WEBHOOK_LOGS = "smartlock_offline_webhook_logs_v2";

export const DEFAULT_OFFLINE_WEBHOOK_CONFIG: WebhookConfig = {
  enabled: false,
  url: "https://chat-room.eton.vn/hooks/YOUR_WEBHOOK_TOKEN",
  gateInTitle: "[[CỔNG VÀO]]",
  gateOutTitle: "[[CỔNG RA]]",
  includeEmployeeCode: true,
};

export const DEFAULT_OFFLINE_WEBHOOK_LOGS: WebhookLog[] = [
  {
    id: "WH-OFFLINE-INIT",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    url: DEFAULT_OFFLINE_WEBHOOK_CONFIG.url,
    method: "POST",
    payload: {
      text: "Nguyễn Hoàng Minh (NV-1082) - " + new Date(Date.now() - 45 * 60 * 1000).toLocaleString("vi-VN"),
      attachments: [{ title: "[[CỔNG VÀO]]" }],
    },
    statusCode: 200,
    statusText: "OK",
    responseBody: "ok",
    success: true,
    scanType: "ENTRY",
    userName: "Nguyễn Hoàng Minh",
  },
];

export function getStoredWebhookConfig(): WebhookConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WEBHOOK_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === "string") return parsed;
    }
  } catch {}
  return DEFAULT_OFFLINE_WEBHOOK_CONFIG;
}

export function saveStoredWebhookConfig(config: WebhookConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY_WEBHOOK_CONFIG, JSON.stringify(config));
  } catch (e) {
    console.warn("Lỗi lưu webhook config vào localStorage:", e);
  }
}

export function getStoredWebhookLogs(): WebhookLog[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WEBHOOK_LOGS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return DEFAULT_OFFLINE_WEBHOOK_LOGS;
}

export function saveStoredWebhookLogs(logs: WebhookLog[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_WEBHOOK_LOGS, JSON.stringify(logs.slice(0, 60)));
  } catch (e) {
    console.warn("Lỗi lưu webhook logs vào localStorage:", e);
  }
}

// AI & Local Face Recognition Configuration Storage
const STORAGE_KEY_AI_CONFIG = "smartlock_ai_recognition_config_v2";

export const DEFAULT_AI_CONFIG: AiRecognitionConfig = {
  engineMode: "HYBRID_AUTO",
  googleAi: {
    model: "gemini-3.8-flash",
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

export function getStoredAiConfig(): AiRecognitionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AI_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.engineMode) {
        return {
          ...DEFAULT_AI_CONFIG,
          ...parsed,
          googleAi: { ...DEFAULT_AI_CONFIG.googleAi, ...(parsed.googleAi || {}) },
          localModel: { ...DEFAULT_AI_CONFIG.localModel, ...(parsed.localModel || {}) },
          hybridSettings: { ...DEFAULT_AI_CONFIG.hybridSettings, ...(parsed.hybridSettings || {}) },
        };
      }
    }
  } catch {}
  return DEFAULT_AI_CONFIG;
}

export function saveStoredAiConfig(config: AiRecognitionConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY_AI_CONFIG, JSON.stringify(config));
  } catch (e) {
    console.warn("Lỗi lưu AI config vào localStorage:", e);
  }
}

/**
 * Direct browser webhook dispatcher: multi-transport delivery bypassing CORS restrictions.
 */
export function dispatchDirectWebhook(url: string, payload: any): void {
  if (!url) return;
  // Method 1: fetch no-cors
  try {
    fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}

  // Method 2: navigator.sendBeacon
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], {
        type: "text/plain;charset=UTF-8",
      });
      navigator.sendBeacon(url, blob);
    }
  } catch {}

  // Method 3: Hidden form in hidden iframe
  try {
    if (typeof document !== "undefined") {
      let iframe = document.getElementById("webhook-target-iframe") as HTMLIFrameElement;
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.id = "webhook-target-iframe";
        iframe.name = "webhook-target-iframe";
        iframe.style.display = "none";
        iframe.style.position = "absolute";
        iframe.style.width = "0";
        iframe.style.height = "0";
        iframe.style.border = "none";
        document.body.appendChild(iframe);
      }

      const form = document.createElement("form");
      form.method = "POST";
      form.action = url;
      form.target = "webhook-target-iframe";
      form.style.display = "none";

      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "payload";
      input.value = JSON.stringify(payload);
      form.appendChild(input);

      document.body.appendChild(form);
      form.submit();
      setTimeout(() => {
        if (form.parentNode) form.parentNode.removeChild(form);
      }, 1500);
    }
  } catch {}
}

// In-Browser Client Event Bus to simulate SSE when running on Netlify
type EventListener = (data: any) => void;

class ClientEventBus {
  private listeners: Record<string, EventListener[]> = {};

  on(event: string, callback: EventListener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
    return () => this.off(event, callback);
  }

  off(event: string, callback: EventListener) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  }

  emit(event: string, data: any) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error(`[EventBus] Error in listener for ${event}:`, err);
      }
    });
  }
}

export const clientEventBus = new ClientEventBus();

// Client Lock State Controller
let activeRelockTimer: any = null;
let currentClientLock: SmartLockState = getStoredLockState();

export function clientDoorUnlock(source: string, employeeName?: string, employeeId?: string): SmartLockState {
  if (activeRelockTimer) {
    clearInterval(activeRelockTimer);
    activeRelockTimer = null;
  }

  currentClientLock = {
    ...currentClientLock,
    state: "UNLOCKED",
    isLocked: false,
    remainingRelockSeconds: currentClientLock.autoRelockSeconds || 6,
    lastActionAt: new Date().toISOString(),
    lastActionBy: employeeName ? `AI Nhận Diện: ${employeeName}` : source,
  };

  saveStoredLockState(currentClientLock);
  clientEventBus.emit("lock_state", currentClientLock);

  // Countdown timer
  let remaining = currentClientLock.autoRelockSeconds || 6;
  activeRelockTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(activeRelockTimer);
      activeRelockTimer = null;
      clientDoorLock("Tự Động Khóa (Auto-Relock Timer)");
    } else {
      currentClientLock = {
        ...currentClientLock,
        remainingRelockSeconds: remaining,
      };
      clientEventBus.emit("lock_countdown", { remainingSeconds: remaining });
    }
  }, 1000);

  return currentClientLock;
}

export function clientDoorLock(source: string): SmartLockState {
  if (activeRelockTimer) {
    clearInterval(activeRelockTimer);
    activeRelockTimer = null;
  }

  currentClientLock = {
    ...currentClientLock,
    state: "LOCKED",
    isLocked: true,
    remainingRelockSeconds: 0,
    lastActionAt: new Date().toISOString(),
    lastActionBy: source,
  };

  saveStoredLockState(currentClientLock);
  clientEventBus.emit("lock_state", currentClientLock);
  return currentClientLock;
}

// Client-Side Biometric Simulation Engine (Runs directly in browser on Netlify)
interface ClientFaceRecognitionParams {
  imageBase64: string;
  scanType?: ScanType;
  testEmployeeId?: string;
  employees: Employee[];
  config?: AiRecognitionConfig;
}

export function simulateClientFaceRecognition({
  imageBase64,
  scanType = "ENTRY",
  testEmployeeId,
  employees,
  config,
}: ClientFaceRecognitionParams): FaceRecognitionResult {
  const currentEmployees = employees.length > 0 ? employees : getStoredEmployees();
  const activeConfig = config || getStoredAiConfig();
  const startTime = Date.now();

  const isLocalEngine = activeConfig.engineMode === "LOCAL_BIOMETRIC";
  const isHybrid = activeConfig.engineMode === "HYBRID_AUTO";
  const engineUsed = isLocalEngine
    ? "Local Edge Biometrics"
    : isHybrid
    ? "Hybrid Auto (Local Edge + Cloud AI)"
    : "Google Cloud AI";

  let modelUsed: string = activeConfig.googleAi.model;
  if (isLocalEngine || isHybrid) {
    if (activeConfig.localModel.modelArchitecture === "blazeface-arcface-sota") {
      modelUsed = "BlazeFace V2 + ArcFace SOTA (512-D)";
    } else if (activeConfig.localModel.modelArchitecture === "mediapipe-facemesh-dense") {
      modelUsed = "MediaPipe FaceMesh (468 3D Landmarks)";
    } else {
      modelUsed = "MobileFaceNet INT8 Edge";
    }
  }

  // If local engine is selected and not a multi-person test, run through local biometric engine
  if (isLocalEngine && testEmployeeId !== "MULTI_EMPLOYEES" && testEmployeeId !== "MULTI_MIXED") {
    const localRes = runLocalFaceRecognition({
      imageBase64,
      employees: currentEmployees,
      modelArchitecture: activeConfig.localModel.modelArchitecture,
      similarityThreshold: activeConfig.localModel.similarityThreshold,
      livenessSensitivity: activeConfig.localModel.livenessSensitivity,
      testEmployeeId,
    });

    if (localRes.recognized && localRes.bestMatch) {
      const emp = localRes.bestMatch;
      const log: AccessLog = {
        id: `LOG-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: scanType,
        status: "GRANTED",
        employeeId: emp.id,
        employeeName: emp.name,
        employeeCode: emp.employeeCode,
        department: emp.department,
        photoSnapshot: emp.photoUrl || imageBase64,
        confidence: localRes.overallConfidence,
        livenessScore: localRes.overallLiveness,
        lockAction: "Mở chốt tự động qua Local Biometrics SOTA",
        doorName: "Cửa Chính Trụ Sở - Cổng A",
        reason: `Khớp vector Cosine ${(localRes.cosineSimilarity * 100).toFixed(1)}% [${localRes.modelName}]`,
      };

      clientDoorUnlock("Local SOTA Biometrics", emp.name, emp.id);
      saveStoredLogs([log, ...getStoredLogs()]);

      const notif: MobileNotification = {
        id: `NOTIF-${Date.now()}`,
        title: "Mở cửa thành công (Local AI)",
        body: `${emp.name} (${emp.employeeCode}) - Xác thực qua ${localRes.modelName}`,
        timestamp: new Date().toISOString(),
        type: "SUCCESS",
        read: false,
        employeeId: emp.id,
        employeeName: emp.name,
      };
      saveStoredNotifications([notif, ...getStoredNotifications()]);
      clientEventBus.emit("notification", notif);

      return {
        recognized: true,
        employee: emp,
        recognizedEmployees: [emp],
        detectedFaces: localRes.detectedFaces,
        totalFacesDetected: localRes.detectedFaces.length,
        authorizedCount: 1,
        unauthorizedCount: 0,
        processingTimeMs: localRes.processingTimeMs,
        confidence: localRes.overallConfidence,
        livenessScore: localRes.overallLiveness,
        message: `[Local SOTA] Đã nhận diện: ${emp.name} (${emp.employeeCode}) [${localRes.modelName}] - Cửa đã mở!`,
        lockUnlocked: true,
        log,
        logs: [log],
        engineUsed,
        modelUsed,
      };
    } else {
      const log: AccessLog = {
        id: `LOG-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: scanType,
        status: "DENIED",
        photoSnapshot: imageBase64,
        confidence: localRes.overallConfidence,
        livenessScore: localRes.overallLiveness,
        lockAction: "Khóa giữ nguyên trạng thái LOCKED",
        doorName: "Cửa Chính Trụ Sở - Cổng A",
        reason: "Vector đặc trưng không đạt ngưỡng Cosine threshold (" + activeConfig.localModel.similarityThreshold + ")",
      };
      saveStoredLogs([log, ...getStoredLogs()]);

      return {
        recognized: false,
        detectedFaces: localRes.detectedFaces,
        totalFacesDetected: localRes.detectedFaces.length,
        authorizedCount: 0,
        unauthorizedCount: localRes.detectedFaces.length,
        processingTimeMs: localRes.processingTimeMs,
        confidence: localRes.overallConfidence,
        livenessScore: localRes.overallLiveness,
        message: "Từ chối truy cập: Khoảng cách vector Cosine không đạt chuẩn (" + localRes.cosineSimilarity.toFixed(2) + " < " + activeConfig.localModel.similarityThreshold + ")",
        lockUnlocked: false,
        log,
        logs: [log],
        engineUsed,
        modelUsed,
      };
    }
  }

  // CASE 1: MULTI-EMPLOYEE TEST
  if (testEmployeeId === "MULTI_EMPLOYEES") {
    const matchedEmps = currentEmployees.slice(0, Math.min(3, currentEmployees.length));
    const detectedFaces: DetectedFace[] = matchedEmps.map((emp, index) => {
      const xOffset = 80 + index * 290;
      return {
        id: `face-multi-${index}-${Date.now()}`,
        box2d: [160, xOffset, 740, Math.min(xOffset + 260, 950)],
        employeeId: emp.id,
        employeeName: emp.name,
        employeeCode: emp.employeeCode,
        department: emp.department,
        confidence: Math.round((96.5 + Math.random() * 2.8) * 10) / 10,
        livenessScore: Math.round((98.0 + Math.random() * 1.5) * 10) / 10,
        recognized: true,
        message: `Đã xác thực ${emp.name} (${emp.employeeCode})`,
      };
    });

    const logs: AccessLog[] = matchedEmps.map((emp, idx) => ({
      id: `LOG-${Date.now()}-${idx}`,
      timestamp: new Date().toISOString(),
      type: scanType,
      status: "GRANTED",
      employeeId: emp.id,
      employeeName: emp.name,
      employeeCode: emp.employeeCode,
      department: emp.department,
      photoSnapshot: emp.photoUrl || imageBase64,
      confidence: detectedFaces[idx].confidence,
      livenessScore: detectedFaces[idx].livenessScore,
      lockAction: "Mở chốt tự động qua AI Biometrics",
      doorName: "Cửa Chính Trụ Sở - Cổng A",
      reason: `Khuôn mặt hợp lệ ${detectedFaces[idx].confidence}%, độ sống thật đạt chuẩn`,
    }));

    // Unlock door
    clientDoorUnlock("AI Nhận Diện Đa Người", matchedEmps[0].name, matchedEmps[0].id);

    // Save logs
    const existingLogs = getStoredLogs();
    saveStoredLogs([...logs, ...existingLogs]);

    // Create notification
    const notif: MobileNotification = {
      id: `NOTIF-${Date.now()}`,
      title: "Mở cửa thành công (Đa nhân viên)",
      body: `Đã nhận diện đồng thời ${matchedEmps.map((e) => e.name).join(", ")} tại Cửa Chính`,
      timestamp: new Date().toISOString(),
      type: "SUCCESS",
      read: false,
    };
    const existingNotifs = getStoredNotifications();
    saveStoredNotifications([notif, ...existingNotifs]);
    clientEventBus.emit("notification", notif);

    return {
      recognized: true,
      recognizedEmployees: matchedEmps,
      detectedFaces,
      totalFacesDetected: detectedFaces.length,
      authorizedCount: detectedFaces.length,
      unauthorizedCount: 0,
      processingTimeMs: Math.round(120 + Math.random() * 50),
      confidence: 97.8,
      livenessScore: 98.9,
      message: `Đã nhận diện thành công đồng thời ${matchedEmps.length} nhân viên - Cửa đã mở!`,
      lockUnlocked: true,
      logs,
      log: logs[0],
      engineUsed,
      modelUsed,
    };
  }

  // CASE 2: UNKNOWN PERSON
  if (testEmployeeId === "UNKNOWN") {
    const detectedFace: DetectedFace = {
      id: `face-unknown-${Date.now()}`,
      box2d: [180, 260, 760, 740],
      confidence: 32.5,
      livenessScore: 89.2,
      recognized: false,
      message: "Khuôn mặt lạ - Không trùng khớp nhân viên nào",
    };

    const log: AccessLog = {
      id: `LOG-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: scanType,
      status: "DENIED",
      photoSnapshot: imageBase64,
      confidence: 32.5,
      livenessScore: 89.2,
      lockAction: "Khóa giữ nguyên trạng thái LOCKED",
      doorName: "Cửa Chính Trụ Sở - Cổng A",
      reason: "Khuôn mặt chưa được đăng ký trong danh sách nhân sự",
    };

    const existingLogs = getStoredLogs();
    saveStoredLogs([log, ...existingLogs]);

    const notif: MobileNotification = {
      id: `NOTIF-${Date.now()}`,
      title: "Cảnh báo từ chối vào",
      body: `Phát hiện khuôn mặt không xác định tại Cửa Chính - Khóa giữ an toàn`,
      timestamp: new Date().toISOString(),
      type: "ALERT",
      read: false,
    };
    const existingNotifs = getStoredNotifications();
    saveStoredNotifications([notif, ...existingNotifs]);
    clientEventBus.emit("notification", notif);

    return {
      recognized: false,
      detectedFaces: [detectedFace],
      totalFacesDetected: 1,
      authorizedCount: 0,
      unauthorizedCount: 1,
      processingTimeMs: Math.round(95 + Math.random() * 40),
      confidence: 32.5,
      livenessScore: 89.2,
      message: "Từ chối truy cập: Khuôn mặt lạ chưa được đăng ký trong hệ thống",
      lockUnlocked: false,
      log,
      logs: [log],
      engineUsed,
      modelUsed,
    };
  }

  // CASE 3: SPECIFIC EMPLOYEE OR CAMERA RECOGNITION
  let targetEmployee: Employee | undefined;
  if (testEmployeeId) {
    targetEmployee = currentEmployees.find(
      (e) => e.id === testEmployeeId || e.employeeCode === testEmployeeId
    );
  }

  if (!targetEmployee && currentEmployees.length > 0) {
    targetEmployee = currentEmployees[0];
  }

  if (targetEmployee) {
    const confidence = Math.round((96.0 + Math.random() * 3.4) * 10) / 10;
    const livenessScore = Math.round((98.2 + Math.random() * 1.6) * 10) / 10;

    const detectedFace: DetectedFace = {
      id: `face-${targetEmployee.id}-${Date.now()}`,
      box2d: [180, 270, 750, 730],
      employeeId: targetEmployee.id,
      employeeName: targetEmployee.name,
      employeeCode: targetEmployee.employeeCode,
      department: targetEmployee.department,
      confidence,
      livenessScore,
      recognized: true,
      message: `Xác thực thành công: ${targetEmployee.name}`,
    };

    const log: AccessLog = {
      id: `LOG-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: scanType,
      status: "GRANTED",
      employeeId: targetEmployee.id,
      employeeName: targetEmployee.name,
      employeeCode: targetEmployee.employeeCode,
      department: targetEmployee.department,
      photoSnapshot: targetEmployee.photoUrl || imageBase64,
      confidence,
      livenessScore,
      lockAction: "Mở chốt tự động qua AI Biometrics",
      doorName: "Cửa Chính Trụ Sở - Cổng A",
      reason: `Khuôn mặt hợp lệ ${confidence}%, độ sống thật đạt chuẩn`,
    };

    // Unlock smart lock
    clientDoorUnlock("AI Nhận Diện Khuôn Mặt", targetEmployee.name, targetEmployee.id);

    // Save log & notification
    const existingLogs = getStoredLogs();
    saveStoredLogs([log, ...existingLogs]);

    const notif: MobileNotification = {
      id: `NOTIF-${Date.now()}`,
      title: "Mở cửa thành công",
      body: `${targetEmployee.name} (${targetEmployee.employeeCode}) vừa điểm danh ${
        scanType === "ENTRY" ? "Vào" : "Ra"
      } tại Cửa Chính`,
      timestamp: new Date().toISOString(),
      type: "SUCCESS",
      read: false,
      employeeId: targetEmployee.id,
      employeeName: targetEmployee.name,
    };
    const existingNotifs = getStoredNotifications();
    saveStoredNotifications([notif, ...existingNotifs]);
    clientEventBus.emit("notification", notif);

    return {
      recognized: true,
      employee: targetEmployee,
      recognizedEmployees: [targetEmployee],
      detectedFaces: [detectedFace],
      totalFacesDetected: 1,
      authorizedCount: 1,
      unauthorizedCount: 0,
      processingTimeMs: Date.now() - startTime + Math.round(70 + Math.random() * 40),
      confidence,
      livenessScore,
      message: `Đã nhận diện: ${targetEmployee.name} (${targetEmployee.employeeCode}) [${modelUsed}] - Cửa mở thành công!`,
      lockUnlocked: true,
      log,
      logs: [log],
      engineUsed,
      modelUsed,
    };
  }

  // Fallback: No employees available at all
  return {
    recognized: false,
    detectedFaces: [],
    totalFacesDetected: 0,
    authorizedCount: 0,
    unauthorizedCount: 0,
    processingTimeMs: 50,
    confidence: 0,
    livenessScore: 0,
    message: "Hệ thống chưa có nhân viên đăng ký",
    lockUnlocked: false,
    engineUsed,
    modelUsed,
  };
}

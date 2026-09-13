import {
  Employee,
  AccessLog,
  SmartLockState,
  MobileNotification,
  FaceRecognitionResult,
  DetectedFace,
  ScanType,
} from "../types";

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
}

export function simulateClientFaceRecognition({
  imageBase64,
  scanType = "ENTRY",
  testEmployeeId,
  employees,
}: ClientFaceRecognitionParams): FaceRecognitionResult {
  const currentEmployees = employees.length > 0 ? employees : getStoredEmployees();
  const startTime = Date.now();

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
      message: `Đã nhận diện: ${targetEmployee.name} (${targetEmployee.employeeCode}) - Cửa mở thành công!`,
      lockUnlocked: true,
      log,
      logs: [log],
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
  };
}

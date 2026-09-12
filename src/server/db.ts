import fs from "fs";
import path from "path";
import { createRequire } from "module";

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
const DATA_DIR = path.join(process.cwd(), "data");
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

// Database wrapper supporting native Node 22 SQLite
class SQLiteStorage {
  private db: any = null;
  private isNativeSqlite = false;

  constructor() {
    this.init();
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
        reason TEXT
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
        includeEmployeeCode INTEGER
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
    `);
  }

  // --- Fallback JSON storage in case node:sqlite is not present ---
  private fallbackData: {
    employees: EmployeeRecord[];
    access_logs: AccessLogRecord[];
    smart_lock_state?: SmartLockStateRecord;
    webhook_config?: WebhookConfigRecord;
    webhook_logs: WebhookLogRecord[];
    mobile_notifications: MobileNotificationRecord[];
  } = {
    employees: [],
    access_logs: [],
    webhook_logs: [],
    mobile_notifications: [],
  };

  private fallbackFile = path.join(DATA_DIR, "smartface_data.json");

  private initFallbackStorage() {
    if (fs.existsSync(this.fallbackFile)) {
      try {
        const raw = fs.readFileSync(this.fallbackFile, "utf-8");
        this.fallbackData = JSON.parse(raw);
      } catch {}
    }
  }

  private saveFallback() {
    try {
      fs.writeFileSync(this.fallbackFile, JSON.stringify(this.fallbackData, null, 2), "utf-8");
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

  saveEmployee(emp: EmployeeRecord) {
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

  // ================= ACCESS LOGS =================
  getAccessLogs(defaults: AccessLogRecord[]): AccessLogRecord[] {
    if (this.isNativeSqlite && this.db) {
      try {
        const rows = this.db.prepare("SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT 100").all();
        if (rows && rows.length > 0) {
          return rows as AccessLogRecord[];
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
      this.saveFallback();
    }
    return this.fallbackData.access_logs;
  }

  saveAccessLog(log: AccessLogRecord) {
    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO access_logs (
            id, timestamp, type, status, employeeId, employeeName, employeeCode,
            department, photoSnapshot, confidence, livenessScore, lockAction, doorName, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            confidence = excluded.confidence
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
          log.livenessScore || null,
          log.lockAction,
          log.doorName,
          log.reason || null
        );
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi saveAccessLog:", err);
      }
    }
    this.fallbackData.access_logs.unshift(log);
    if (this.fallbackData.access_logs.length > 150) {
      this.fallbackData.access_logs = this.fallbackData.access_logs.slice(0, 150);
    }
    this.saveFallback();
  }

  clearAccessLogs() {
    if (this.isNativeSqlite && this.db) {
      try {
        this.db.exec("DELETE FROM access_logs");
        return;
      } catch (err) {
        console.error("[SQLite] Lỗi clearAccessLogs:", err);
      }
    }
    this.fallbackData.access_logs = [];
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
          return {
            enabled: Boolean(row.enabled),
            url: row.url,
            gateInTitle: row.gateInTitle,
            gateOutTitle: row.gateOutTitle,
            includeEmployeeCode: Boolean(row.includeEmployeeCode),
          };
        }
        this.saveWebhookConfig(defaultConfig);
        return defaultConfig;
      } catch (err) {
        console.error("[SQLite] Lỗi getWebhookConfig:", err);
      }
    }
    return this.fallbackData.webhook_config || defaultConfig;
  }

  saveWebhookConfig(config: WebhookConfigRecord) {
    if (this.isNativeSqlite && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO webhook_config (id, enabled, url, gateInTitle, gateOutTitle, includeEmployeeCode)
          VALUES ('default', ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            url = excluded.url,
            gateInTitle = excluded.gateInTitle,
            gateOutTitle = excluded.gateOutTitle,
            includeEmployeeCode = excluded.includeEmployeeCode
        `);
        stmt.run(
          config.enabled ? 1 : 0,
          config.url,
          config.gateInTitle,
          config.gateOutTitle,
          config.includeEmployeeCode ? 1 : 0
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

  // Get info & statistics
  getStorageInfo() {
    let sizeBytes = 0;
    try {
      if (fs.existsSync(DB_PATH)) {
        sizeBytes = fs.statSync(DB_PATH).size;
      }
    } catch {}

    return {
      engine: this.isNativeSqlite ? "SQLite 3 (Node.js native DatabaseSync)" : "JSON File Persistence Fallback",
      dbPath: DB_PATH,
      sizeBytes,
      sizeFormatted: (sizeBytes / 1024).toFixed(2) + " KB",
    };
  }
}

export const db = new SQLiteStorage();

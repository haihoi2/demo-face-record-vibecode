import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  UserPlus,
  Camera,
  Upload,
  CheckCircle2,
  Trash2,
  Scan,
  ShieldCheck,
  AlertCircle,
  Sparkles,
  Building,
  BadgeCheck,
  RefreshCw,
  UserX,
  Video,
  Layers,
  ScanFace,
  AlertTriangle,
  XCircle,
  Clock,
  Activity,
} from "lucide-react";
import {
  Employee,
  CameraStreamsConfig,
  GateStreamConfig,
  GateStreamSource,
} from "../types";
import { safeJsonFetch, compressImage } from "../utils/api";
import { ProtectedImage } from "./ProtectedImage";
import { orgChoice, orgOptions, useOrgCatalog } from "../utils/orgCatalog";

/** One enrolled template as returned by GET /api/employees/:id/templates.
 *  Raw embeddings are never sent to the browser, so every field is optional. */
interface TemplateSummary {
  id: string;
  quality?: number;
  source?: string;
  capturedAt?: string;
  streamId?: string;
  dims?: number;
  modelTag?: string;
}

/** POST /api/employees/:id/templates/capture */
interface CaptureResponse {
  success?: boolean;
  error?: string;
  retryAfterSeconds?: number;
  saved?: Array<TemplateSummary & { frameIndex?: number; evictedTemplateIds?: string[] }>;
  rejected?: Array<{
    reason?: string;
    quality?: number;
    streamId?: string;
    frameIndex?: number;
    minQuality?: number;
    detectedFaces?: number;
  }>;
}

/** GET /api/employees/:id/templates */
interface TemplatesResponse {
  success?: boolean;
  error?: string;
  templates?: TemplateSummary[];
  count?: number;
  max?: number;
  usableCount?: number;
  modelTag?: string;
}

/** A camera stream flattened with the gate it belongs to. */
interface FlatStream {
  gateKey: "entry" | "exit";
  gateName: string;
  id: string;
  label: string;
  enabled: boolean;
}

/** Interval between grabbed frames; slow enough that frames are not near-duplicates. */
const CAPTURE_FRAME_INTERVAL_MS = 400;

/** Server default for FACE_ENROLL_MIN_QUALITY, used only until the real value
 *  arrives from GET /api/face-engine/status. */
const DEFAULT_ENROLL_MIN_QUALITY = 0.25;

/** Quality observed on this site's best camera (exit-501: 0.34 - 0.43). An
 *  observation, NOT a policy - the only policy boundary is the server's
 *  enrollMinQuality below, which decides what is actually accepted. */
const OBSERVED_GOOD_QUALITY = 0.35;

/** Streams of one gate, tolerant of a legacy config that has no `streams[]`. */
const flattenGateStreams = (
  gate: GateStreamConfig | undefined,
  gateKey: "entry" | "exit"
): FlatStream[] => {
  if (!gate) return [];
  const gateName = gate.name || (gateKey === "exit" ? "Cổng Ra" : "Cổng Vào");
  const list: GateStreamSource[] = Array.isArray(gate.streams) ? gate.streams.filter(Boolean) : [];
  if (list.length > 0) {
    return list.map((st, index) => ({
      gateKey,
      gateName,
      id: st.id || `${gateKey}-${index}`,
      label: st.label || st.id || `Luồng ${index + 1}`,
      enabled: st.enabled !== false,
    }));
  }
  return [{ gateKey, gateName, id: `${gateKey}-primary`, label: gateName, enabled: gate.enabled !== false }];
};

/** Rejection reason codes returned by the enrolment endpoint. */
const REJECT_REASONS: Record<string, string> = {
  "no-face": "Không thấy khuôn mặt nào trong khung hình",
  "low-quality": "Khuôn mặt quá nhỏ hoặc quá mờ so với ngưỡng chất lượng",
  "duplicate": "Ảnh này đã được đăng ký làm mẫu cho nhân viên này",
  "not-frontal": "Khuôn mặt không nhìn thẳng vào camera (quay đi, cúi hoặc nghiêng) — hãy chụp lại khi nhìn thẳng",
  "frame-grab-failed": "Không lấy được khung hình từ camera",
  "engine-disabled": "Động cơ nhận diện thật chưa được bật trên máy chủ",
  "engine-unavailable": "Máy chủ không nạp được mô hình nhận diện",
  "engine-error": "Động cơ nhận diện báo lỗi khi xử lý khung hình",
};

const describeReject = (reason?: string): string =>
  (reason && REJECT_REASONS[reason]) || reason || "Không rõ lý do";

/** Red below the server's accept floor, amber up to the quality observed on the
 *  best camera here, green above it. */
const qualityTone = (q: number | undefined, minQuality: number) => {
  if (typeof q !== "number" || !Number.isFinite(q)) return { bar: "bg-slate-300", text: "text-slate-500" };
  if (q >= OBSERVED_GOOD_QUALITY) return { bar: "bg-emerald-500", text: "text-emerald-700" };
  if (q >= minQuality) return { bar: "bg-amber-500", text: "text-amber-700" };
  return { bar: "bg-rose-500", text: "text-rose-700" };
};

const formatCapturedAt = (iso?: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("vi-VN");
};

interface EmployeeRegistrationProps {
  employees: Employee[];
  onEmployeeAdded: (employee: Employee) => void;
  onEmployeeDeleted: (id: string) => void;
  onTestEmployee: (employee: Employee) => void;
  onOpenStrangerClusters?: () => void;
}

export const EmployeeRegistration: React.FC<EmployeeRegistrationProps> = ({
  employees,
  onEmployeeAdded,
  onEmployeeDeleted,
  onTestEmployee,
  onOpenStrangerClusters,
}) => {
  const [name, setName] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState<string>("");
  const [department, setDepartment] = useState<string>("Phòng Kỹ Thuật AI");
  const [position, setPosition] = useState<string>("Kỹ sư phần mềm");
  // Departments and positions come from the managed catalog; the server
  // refuses any value that is not an active entry there.
  const orgCatalog = useOrgCatalog();
  const departmentOptions = orgOptions(orgCatalog.departments);
  const positionOptions = orgOptions(orgCatalog.positions);
  useEffect(() => {
    setDepartment((current) => orgChoice(departmentOptions, current));
    setPosition((current) => orgChoice(positionOptions, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentOptions.join("\n"), positionOptions.join("\n")]);
  const [accessLevel, setAccessLevel] = useState<"ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED">("ALL_ACCESS");
  const [photoBase64, setPhotoBase64] = useState<string>("");

  const [isCapturingCamera, setIsCapturingCamera] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const regVideoRef = useRef<HTMLVideoElement | null>(null);

  // ---- Per-camera enrolment (gate camera -> face templates) -----------------
  const [enrollMinQuality, setEnrollMinQuality] = useState<number | null>(null);
  const [streamsConfig, setStreamsConfig] = useState<CameraStreamsConfig | null>(null);
  const [streamsLoading, setStreamsLoading] = useState<boolean>(true);
  const [streamsError, setStreamsError] = useState<string | null>(null);

  const [enrollEmployeeId, setEnrollEmployeeId] = useState<string>("");
  const [enrollGate, setEnrollGate] = useState<"entry" | "exit">("exit");
  const [enrollStreamId, setEnrollStreamId] = useState<string>("");
  const [enrollFrames, setEnrollFrames] = useState<number>(3);

  const [capturing, setCapturing] = useState<boolean>(false);
  const [captureResult, setCaptureResult] = useState<CaptureResponse | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);

  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templatesMeta, setTemplatesMeta] = useState<TemplatesResponse | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState<boolean>(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  const entryStreams = flattenGateStreams(streamsConfig?.entryGate, "entry");
  const exitStreams = flattenGateStreams(streamsConfig?.exitGate, "exit");
  const allStreams: FlatStream[] = [...entryStreams, ...exitStreams];
  const gateStreams = (enrollGate === "entry" ? entryStreams : exitStreams).filter((st) => st.enabled);
  const selectedEmployee = employees.find((emp) => emp.id === enrollEmployeeId) || null;
  /** The server's accept floor when it reports one; otherwise its documented default. */
  const qualityFloor = enrollMinQuality ?? DEFAULT_ENROLL_MIN_QUALITY;

  // The engine's own enrolment quality floor - never hardcode a policy number.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const res = await safeJsonFetch<{ limits?: { enrollMinQuality?: number } }>(
        "/api/face-engine/status"
      );
      if (!mounted) return;
      const value = res.ok ? res.data?.limits?.enrollMinQuality : undefined;
      setEnrollMinQuality(
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
      );
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Camera list for the enrolment picker
  useEffect(() => {
    let mounted = true;
    (async () => {
      const res = await safeJsonFetch<{ success?: boolean; config?: CameraStreamsConfig; error?: string }>(
        "/api/camera-streams/config"
      );
      if (!mounted) return;
      if (res.ok && res.data?.config) {
        setStreamsConfig(res.data.config);
        setStreamsError(null);
      } else {
        setStreamsConfig(null);
        setStreamsError(
          res.data?.error || res.error || `Không đọc được danh sách camera (HTTP ${res.status || 0}).`
        );
      }
      setStreamsLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Keep a valid employee selected
  useEffect(() => {
    if (employees.length === 0) {
      if (enrollEmployeeId) setEnrollEmployeeId("");
      return;
    }
    if (!employees.some((emp) => emp.id === enrollEmployeeId)) {
      setEnrollEmployeeId(employees[0].id);
    }
  }, [employees, enrollEmployeeId]);

  // Keep a valid stream selected for the chosen gate
  useEffect(() => {
    const ids = (enrollGate === "entry" ? entryStreams : exitStreams)
      .filter((st) => st.enabled)
      .map((st) => st.id);
    if (enrollStreamId && ids.includes(enrollStreamId)) return;
    setEnrollStreamId(ids[0] || "");
  }, [enrollGate, streamsConfig]);

  const fetchTemplates = useCallback(async (empId: string): Promise<void> => {
    if (!empId) {
      setTemplates(null);
      setTemplatesMeta(null);
      setTemplatesError(null);
      return;
    }
    setTemplatesLoading(true);
    const res = await safeJsonFetch<TemplatesResponse>(
      `/api/employees/${encodeURIComponent(empId)}/templates`
    );
    if (res.ok && Array.isArray(res.data?.templates)) {
      setTemplates(res.data.templates);
      setTemplatesMeta(res.data);
      setTemplatesError(null);
    } else {
      setTemplates(null);
      setTemplatesMeta(null);
      setTemplatesError(
        res.status === 404
          ? "Máy chủ chưa cung cấp danh sách mẫu khuôn mặt cho nhân viên này (HTTP 404)."
          : res.data?.error || res.error || `Không đọc được danh sách mẫu (HTTP ${res.status || 0}).`
      );
    }
    setTemplatesLoading(false);
  }, []);

  useEffect(() => {
    setCaptureResult(null);
    setCaptureError(null);
    setCaptureNotice(null);
    fetchTemplates(enrollEmployeeId);
  }, [enrollEmployeeId, fetchTemplates]);

  /** Grab `frames` live frames from the chosen gate camera and enrol them. */
  const handleCaptureFromGate = async () => {
    if (!enrollEmployeeId || capturing) return;
    setCapturing(true);
    setCaptureError(null);
    setCaptureNotice(null);
    setCaptureResult(null);

    const res = await safeJsonFetch<CaptureResponse>(
      `/api/employees/${encodeURIComponent(enrollEmployeeId)}/templates/capture`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gate: enrollGate,
          ...(enrollStreamId ? { stream: enrollStreamId } : {}),
          frames: enrollFrames,
          frameIntervalMs: CAPTURE_FRAME_INTERVAL_MS,
        }),
      }
    );

    if (res.status === 503 && typeof res.data?.retryAfterSeconds === "number") {
      setCaptureNotice(
        `Cụm xử lý đang quá tải, hãy thử lại sau ${res.data.retryAfterSeconds} giây. Chưa có mẫu nào được lưu.`
      );
    } else if (res.status === 503) {
      // 503 without a retry hint means a refusal (e.g. engine not enabled) - show it verbatim.
      setCaptureError(
        res.data?.error || "Máy chủ từ chối đăng ký mẫu lúc này (HTTP 503)."
      );
    } else if (res.ok && res.data && res.data.success !== false) {
      setCaptureResult(res.data);
      await fetchTemplates(enrollEmployeeId);
    } else {
      // Never invent a result client-side: show exactly what the server refused with.
      setCaptureError(
        res.data?.error ||
          res.error ||
          (res.status === 404
            ? "Máy chủ chưa hỗ trợ đăng ký khuôn mặt từ camera cổng (HTTP 404)."
            : `Không đăng ký được từ camera (HTTP ${res.status || 0}).`)
      );
    }
    setCapturing(false);
  };

  const handleDeleteTemplate = async (templateId: string) => {
    if (!enrollEmployeeId || !templateId) return;
    setDeletingTemplateId(templateId);
    const res = await safeJsonFetch<{ success?: boolean; error?: string }>(
      `/api/employees/${encodeURIComponent(enrollEmployeeId)}/templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" }
    );
    if (res.ok && res.data?.success !== false) {
      setTemplatesError(null);
      await fetchTemplates(enrollEmployeeId);
    } else {
      setTemplatesError(
        res.data?.error || res.error || `Không xóa được mẫu này (HTTP ${res.status || 0}).`
      );
    }
    setDeletingTemplateId(null);
  };

  // Start webcam for registration snapshot
  const startCamera = async () => {
    setErrorMsg(null);
    setIsCapturingCamera(true);
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 480, height: 480, facingMode: "user" },
        });
        if (regVideoRef.current) {
          regVideoRef.current.srcObject = stream;
          regVideoRef.current.play().catch(() => {});
        }
      }
    } catch {
      setErrorMsg("Không thể mở camera. Vui lòng tải ảnh từ máy tính.");
      setIsCapturingCamera(false);
    }
  };

  const capturePhoto = () => {
    if (!regVideoRef.current) return;
    const video = regVideoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, 400, 400);
    const base64 = canvas.toDataURL("image/jpeg", 0.9);
    setPhotoBase64(base64);

    // Stop video tracks
    if (video.srcObject) {
      const stream = video.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    setIsCapturingCamera(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Compress portrait image to ~640px, keeping size under 150KB
      const compressed = await compressImage(file, 640, 640, 0.82);
      setPhotoBase64(compressed);
      setErrorMsg(null);
    } catch (err: any) {
      console.error("Lỗi nén ảnh:", err);
      setErrorMsg("Không thể xử lý hình ảnh này. Vui lòng chọn ảnh khác.");
    }
  };

  // Sample portrait presets for quick registration testing
  const samplePresets = [
    {
      name: "Phạm Thúy Hằng",
      code: `NV-${Math.floor(1000 + Math.random() * 9000)}`,
      dept: "Phòng Tài Chính - Kế Toán",
      pos: "Chuyên viên Kế toán",
      photo: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&auto=format&fit=crop&q=80",
    },
    {
      name: "Đặng Quang Huy",
      code: `NV-${Math.floor(1000 + Math.random() * 9000)}`,
      dept: "Phòng Marketing & Truyền Thông",
      pos: "Trưởng phòng Marketing",
      photo: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80",
    },
    {
      name: "Hoàng Minh Tuấn",
      code: `NV-${Math.floor(1000 + Math.random() * 9000)}`,
      dept: "Phòng An Ninh & Bảo Vệ",
      pos: "Chỉ huy Trưởng Ca",
      photo: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&auto=format&fit=crop&q=80",
    },
  ];

  const applyPreset = (preset: typeof samplePresets[0]) => {
    setName(preset.name);
    setEmployeeCode(preset.code);
    // Sample presets only fill values the catalog actually offers.
    if (departmentOptions.includes(preset.dept)) setDepartment(preset.dept);
    if (positionOptions.includes(preset.pos)) setPosition(preset.pos);
    setPhotoBase64(preset.photo);
    setErrorMsg(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!name.trim()) {
      setErrorMsg("Vui lòng nhập Họ và tên nhân viên");
      return;
    }
    if (!employeeCode.trim()) {
      setErrorMsg("Vui lòng nhập Mã số nhân viên (ví dụ: NV-1002)");
      return;
    }
    if (!photoBase64) {
      setErrorMsg("Vui lòng chụp ảnh hoặc tải lên ảnh khuôn mặt để đăng ký AI");
      return;
    }

    const codeClean = employeeCode.trim().toUpperCase();
    const existing = employees.find(
      (emp) => emp.employeeCode.toUpperCase() === codeClean
    );
    if (existing) {
      setErrorMsg(`Mã số nhân viên ${codeClean} đã tồn tại trong hệ thống (của ${existing.name})`);
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. Send to server API
      const response = await safeJsonFetch<{
        success?: boolean;
        message?: string;
        employee?: Employee;
        error?: string;
      }>("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          employeeCode: codeClean,
          department: department?.trim() || "Phòng Hành chính - Nhân sự",
          position: position?.trim() || "Nhân viên",
          accessLevel,
          photoUrl: photoBase64,
        }),
      });

      // The server is the only source of an employee identity. A rejection stays a
      // rejection: fabricating a local record here would enrol a face the backend
      // never accepted, and the offline matcher would then treat it as enrolled.
      if (!response.ok || !response.data?.employee) {
        throw new Error(response.data?.error || response.error || `Đăng ký nhân viên thất bại (HTTP ${response.status})`);
      }
      const emp: Employee = response.data.employee;
      setSuccessMsg(
        `Đã tạo hồ sơ nhân viên: ${emp.name} (${emp.employeeCode}). Bước tiếp theo: đăng ký khuôn mặt từ camera cổng ở khung bên dưới.`
      );

      onEmployeeAdded(emp);
      // Send the operator straight on to per-camera enrolment for this person.
      setEnrollEmployeeId(emp.id);

      // Reset form
      setName("");
      setEmployeeCode("");
      setPhotoBase64("");
    } catch (err: any) {
      console.error("Registration error:", err);
      setErrorMsg(err?.message || "Không thể đăng ký nhân viên");
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Templates grouped by the camera that captured them, with the configured
   *  cameras always listed so a MISSING camera is as visible as a covered one. */
  const templateGroups = (() => {
    const list = templates || [];
    const byStream = new Map<string, TemplateSummary[]>();
    for (const tpl of list) {
      const key = tpl.streamId || "__unknown__";
      const bucket = byStream.get(key);
      if (bucket) bucket.push(tpl);
      else byStream.set(key, [tpl]);
    }
    const rows = allStreams.map((st) => ({
      id: st.id,
      label: st.label,
      gateKey: st.gateKey,
      gateName: st.gateName,
      known: true,
      enabled: st.enabled,
      items: byStream.get(st.id) || [],
    }));
    byStream.forEach((items, key) => {
      if (allStreams.some((st) => st.id === key)) return;
      rows.push({
        id: key,
        label: key === "__unknown__" ? "Không gắn với camera nào" : key,
        gateKey: "entry" as "entry" | "exit",
        gateName: "Ngoài cấu hình camera hiện tại",
        known: false,
        enabled: true,
        items,
      });
    });
    return rows;
  })();

  return (
    <div className="space-y-6">
      {/* Stranger Warning & Quick Registration Callout Banner */}
      {onOpenStrangerClusters && (
        <div className="bg-gradient-to-r from-amber-500/10 via-rose-500/10 to-indigo-500/10 border border-amber-300 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-600 text-white flex items-center justify-center shrink-0 shadow-xs">
              <UserX className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Phát hiện người lạ chụp hình tại cửa cần khai báo
              </h3>
              <p className="text-xs text-slate-600">
                Hệ thống tự động gom các ảnh chụp góc tương đồng của cùng một người lạ để bạn có thể thêm nhanh với 1 chạm.
              </p>
            </div>
          </div>

          <button
            type="button"
            id="btn-open-strangers-from-register"
            onClick={onOpenStrangerClusters}
            className="px-4 py-2 bg-gradient-to-r from-amber-600 to-rose-600 hover:opacity-95 text-white rounded-xl text-xs font-bold shadow-sm shadow-amber-200 flex items-center gap-1.5 shrink-0 transition cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Mở Cụm Ảnh &amp; Khai Báo Nhanh</span>
          </button>
        </div>
      )}

      {/* Registration Form & Biometric Acquisition Card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <UserPlus className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Đăng Ký Khuôn Mặt &amp; Thông Tin Nhân Viên Mới
              </h2>
              <p className="text-xs text-slate-500">
                Cập nhật cơ sở dữ liệu khuôn mặt vào mô hình nhận diện AI Smart Lock
              </p>
            </div>
          </div>

          {/* Preset Buttons for Convenience */}
          <div className="hidden sm:flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">Mẫu nhanh:</span>
            {samplePresets.map((p, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => applyPreset(p)}
                className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 rounded-lg text-slate-700 transition"
              >
                {p.name.split(" ").slice(-1)[0]}
              </button>
            ))}
          </div>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Photo Acquisition */}
          <div className="lg:col-span-5 flex flex-col items-center">
            <label className="text-xs font-bold text-slate-700 mb-2 self-start">
              Ảnh Khuôn Mặt Sinh Trắc Học (Bắt buộc)
            </label>

            {/* Photo Preview or Live Camera Capture */}
            <div className="relative w-full max-w-sm aspect-4/3 rounded-2xl bg-slate-100 border-2 border-dashed border-slate-300 overflow-hidden flex items-center justify-center group shadow-inner">
              {isCapturingCamera ? (
                <video
                  ref={regVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover transform -scale-x-100"
                />
              ) : photoBase64 ? (
                <img
                  src={photoBase64}
                  alt="Ảnh nhân viên"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center p-6 text-slate-400">
                  <Camera className="w-12 h-12 mx-auto mb-2 opacity-50 text-indigo-500" />
                  <p className="text-xs font-semibold text-slate-700">Chưa có ảnh khuôn mặt</p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Bật camera hoặc tải tệp ảnh từ máy tính
                  </p>
                </div>
              )}

              {/* Panoramic Face Frame Guide when in camera mode */}
              {isCapturingCamera && (
                <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between">
                  <div className="flex justify-between">
                    <div className="w-6 h-6 border-t-2 border-l-2 border-emerald-400" />
                    <div className="w-6 h-6 border-t-2 border-r-2 border-emerald-400" />
                  </div>
                  <div className="flex items-center justify-center">
                    <span className="text-[11px] font-mono text-emerald-300 bg-black/70 px-2.5 py-1 rounded-full border border-emerald-500/40">
                      👁️ AI Đang Quét Toàn Khung Hình • Sẵn Sàng Chụp
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <div className="w-6 h-6 border-b-2 border-l-2 border-emerald-400" />
                    <div className="w-6 h-6 border-b-2 border-r-2 border-emerald-400" />
                  </div>
                </div>
              )}
            </div>

            {/* Photo Capture Buttons */}
            <div className="mt-3 flex flex-wrap gap-2 justify-center w-full max-w-xs">
              {isCapturingCamera ? (
                <button
                  type="button"
                  id="btn-snap-photo"
                  onClick={capturePhoto}
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition"
                >
                  <Camera className="w-3.5 h-3.5" /> Chụp Ngay
                </button>
              ) : (
                <button
                  type="button"
                  id="btn-open-reg-camera"
                  onClick={startCamera}
                  className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <Camera className="w-3.5 h-3.5" /> Bật Camera
                </button>
              )}

              <label
                id="label-upload-face-file"
                className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer border border-slate-200 transition"
              >
                <Upload className="w-3.5 h-3.5 text-slate-500" /> Tải Tệp Lên
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>

            <p className="text-[11px] text-slate-700 mt-2 text-center max-w-xs">
              Mẹo: Ảnh rõ nét, hướng nhìn chính diện, ánh sáng đều giúp AI nhận diện chính xác nhất.
            </p>
          </div>

          {/* Right Column: Name & Metadata Form Fields */}
          <div className="lg:col-span-7 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Họ và Tên Nhân Viên <span className="text-rose-500">*</span>
                </label>
                <input
                  id="input-employee-name"
                  type="text"
                  required
                  placeholder="Ví dụ: Nguyễn Văn An"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                />
              </div>

              {/* Employee ID */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Mã Số Nhân Viên (Employee ID) <span className="text-rose-500">*</span>
                </label>
                <input
                  id="input-employee-code"
                  type="text"
                  required
                  placeholder="Ví dụ: NV-1099"
                  value={employeeCode}
                  onChange={(e) => setEmployeeCode(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition uppercase"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Department */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Phòng Ban / Đơn Vị
                </label>
                <select
                  id="select-department"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  disabled={departmentOptions.length === 0}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                >
                  {departmentOptions.length === 0 && <option value="">Đang tải danh mục...</option>}
                  {departmentOptions.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>

              {/* Position */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Chức Danh / Vị Trí
                </label>
                <select
                  id="input-position"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  disabled={positionOptions.length === 0}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                >
                  {positionOptions.length === 0 && <option value="">Đang tải danh mục...</option>}
                  {positionOptions.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Access Permission Level */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Phân Quyền Ra Vào Cửa Tự Động
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setAccessLevel("ALL_ACCESS")}
                  className={`py-2 px-3 rounded-xl text-xs font-medium border text-center transition ${
                    accessLevel === "ALL_ACCESS"
                      ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-bold"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Toàn Quyền 24/7
                </button>
                <button
                  type="button"
                  onClick={() => setAccessLevel("OFFICE_HOURS")}
                  className={`py-2 px-3 rounded-xl text-xs font-medium border text-center transition ${
                    accessLevel === "OFFICE_HOURS"
                      ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-bold"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Giờ Hành Chính
                </button>
                <button
                  type="button"
                  onClick={() => setAccessLevel("RESTRICTED")}
                  className={`py-2 px-3 rounded-xl text-xs font-medium border text-center transition ${
                    accessLevel === "RESTRICTED"
                      ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-bold"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Hạn Chế Cần Duyệt
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-3">
              <button
                type="submit"
                id="btn-submit-employee"
                disabled={isSubmitting}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2 transition cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Đang Lưu Dữ Liệu &amp; Huấn Luyện Khuôn Mặt AI...</span>
                  </>
                ) : (
                  <>
                    <BadgeCheck className="w-4 h-4" />
                    <span>Lưu &amp; Kích Hoạt Nhận Diện Cho Nhân Viên</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* ===================== PER-CAMERA FACE ENROLMENT ===================== */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
              <Video className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Đăng Ký Khuôn Mặt Từ Camera Cổng (Theo Từng Camera)
              </h2>
              <p className="text-xs text-slate-500">
                Máy chủ chụp trực tiếp vài khung hình từ camera bạn chọn và trích vector đặc trưng
                512 chiều - đây là dữ liệu thực sự được dùng để nhận diện tại cổng.
              </p>
            </div>
          </div>
          <button
            type="button"
            id="btn-refresh-templates"
            onClick={() => fetchTemplates(enrollEmployeeId)}
            disabled={!enrollEmployeeId || templatesLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition disabled:opacity-50 shrink-0"
            title="Đọc lại danh sách mẫu khuôn mặt"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${templatesLoading ? "animate-spin" : ""}`} />
            <span>Làm mới</span>
          </button>
        </div>

        {/* Why per camera */}
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-[11px] text-amber-900 leading-relaxed">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <span>
            <strong>Phải đăng ký riêng cho từng camera mà người này sẽ đi qua.</strong> Đo trên chính
            hệ thống này: cùng một người so trên cùng camera exit-501 đạt 0.50 - 0.62, nhưng so chéo
            giữa exit-2401 và exit-501 chỉ đạt 0.139 - 0.304. Dải chéo đó nằm{" "}
            <em>vắt ngang</em> mọi ngưỡng hợp lý - 4/6 cặp đo được rơi xuống dưới 0.28 - và đáy của nó{" "}
            <em>chạm vào</em> dải của hai người khác nhau (≤ 0.145), dù hai dải không trùng nhau. Kết
            quả là không thể chọn được ngưỡng nào vừa nhận đúng người qua camera khác vừa loại được
            người lạ, nên mẫu lấy từ camera này <em>không</em> dùng lại được cho camera kia.
          </span>
        </div>

        {employees.length === 0 ? (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl">
            <UserPlus className="w-7 h-7 text-slate-300 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-700">Chưa có nhân viên nào để đăng ký</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Hãy tạo hồ sơ nhân viên ở khung phía trên trước, rồi quay lại bước này.
            </p>
          </div>
        ) : (
          <>
            {/* Picker row */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Nhân viên</label>
                <select
                  id="select-enroll-employee"
                  value={enrollEmployeeId}
                  onChange={(e) => setEnrollEmployeeId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
                >
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.employeeCode})
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Cổng</label>
                <select
                  id="select-enroll-gate"
                  value={enrollGate}
                  onChange={(e) => setEnrollGate(e.target.value === "entry" ? "entry" : "exit")}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
                >
                  <option value="entry">Cổng Vào</option>
                  <option value="exit">Cổng Ra</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Camera</label>
                <select
                  id="select-enroll-stream"
                  value={enrollStreamId}
                  onChange={(e) => setEnrollStreamId(e.target.value)}
                  disabled={streamsLoading}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition disabled:opacity-60"
                >
                  {streamsLoading && <option value="">Đang tải danh sách camera...</option>}
                  {!streamsLoading && gateStreams.length === 0 && (
                    <option value="">Cổng này chưa có camera nào đang bật</option>
                  )}
                  {gateStreams.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label} ({st.id})
                    </option>
                  ))}
                  {!streamsLoading && gateStreams.length > 0 && (
                    <option value="">— Tất cả luồng đang bật của cổng —</option>
                  )}
                </select>
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Khung</label>
                <select
                  id="select-enroll-frames"
                  value={enrollFrames}
                  onChange={(e) => setEnrollFrames(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
                  title="Số khung hình chụp liên tiếp để lấy mẫu"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2 flex items-end">
                <button
                  type="button"
                  id="btn-capture-from-gate"
                  onClick={handleCaptureFromGate}
                  disabled={capturing || !enrollEmployeeId || (!streamsLoading && gateStreams.length === 0)}
                  className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  {capturing ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang chụp...</span>
                    </>
                  ) : (
                    <>
                      <ScanFace className="w-3.5 h-3.5" />
                      <span>Chụp &amp; Đăng Ký</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              Mỗi khung cách nhau {CAPTURE_FRAME_INTERVAL_MS} ms; chụp {enrollFrames} khung mất khoảng{" "}
              {((enrollFrames - 1) * CAPTURE_FRAME_INTERVAL_MS) / 1000 + 1} giây. Nhiều khung hơn giúp
              loại bỏ khung mờ, nhưng nhân viên phải đứng yên trước camera lâu hơn.
            </p>

            {streamsError && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                <span>
                  Không tải được danh sách camera: <span className="font-mono">{streamsError}</span>
                </span>
              </div>
            )}

            {captureNotice && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />
                <span>{captureNotice}</span>
              </div>
            )}

            {captureError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-900 flex items-start gap-2">
                <XCircle className="w-3.5 h-3.5 text-rose-600 mt-0.5 shrink-0" />
                <span className="break-words">{captureError}</span>
              </div>
            )}

            {/* Capture outcome */}
            {captureResult && (
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-800 flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-slate-500" />
                  Kết quả lần chụp vừa rồi
                </div>
                <div className="p-4 space-y-3">
                  {(captureResult.saved || []).length === 0 && (captureResult.rejected || []).length === 0 && (
                    <p className="text-[11px] text-slate-500">
                      Máy chủ không trả về mẫu nào được lưu hoặc bị loại. Hãy thử lại khi có người
                      đứng trước camera.
                    </p>
                  )}

                  {(captureResult.saved || []).length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-emerald-800 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        Đã lưu {(captureResult.saved || []).length} mẫu
                      </div>
                      {(captureResult.saved || []).some(
                        (tpl) => (tpl.evictedTemplateIds || []).length > 0
                      ) && (
                        <p className="text-[10px] text-amber-700">
                          Kho mẫu của nhân viên này đã đầy nên các mẫu chất lượng thấp nhất bị thay thế.
                        </p>
                      )}
                      {(captureResult.saved || []).map((tpl, idx) => {
                        const tone = qualityTone(tpl.quality, qualityFloor);
                        return (
                          <div
                            key={tpl.id || idx}
                            className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200"
                          >
                            <span className="font-mono text-[10px] text-slate-500 truncate max-w-[120px]">
                              {tpl.id || `#${idx + 1}`}
                            </span>
                            <span className="text-[10px] text-slate-600 font-mono truncate max-w-[110px]">
                              {tpl.streamId || "—"}
                            </span>
                            <div className="flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden min-w-[60px]">
                              <div
                                className={`h-full ${tone.bar}`}
                                style={{ width: `${Math.round(Math.min(1, Math.max(0, tpl.quality ?? 0)) * 100)}%` }}
                              />
                            </div>
                            <span className={`font-mono text-[10px] font-bold ${tone.text} shrink-0`}>
                              {typeof tpl.quality === "number" ? tpl.quality.toFixed(2) : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(captureResult.rejected || []).length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-rose-800 flex items-center gap-1.5">
                        <XCircle className="w-3.5 h-3.5 text-rose-600" />
                        Bị loại {(captureResult.rejected || []).length} khung
                      </div>
                      {(captureResult.rejected || []).map((rej, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-900"
                        >
                          <div className="min-w-0">
                            <div className="truncate">{describeReject(rej.reason)}</div>
                            {rej.reason && REJECT_REASONS[rej.reason] && (
                              <div className="font-mono text-[10px] text-rose-700/80 truncate">
                                {rej.reason}
                                {typeof rej.frameIndex === "number" ? ` • khung ${rej.frameIndex}` : ""}
                              </div>
                            )}
                          </div>
                          <span className="font-mono text-[10px] shrink-0">
                            chất lượng {typeof rej.quality === "number" ? rej.quality.toFixed(2) : "—"}
                            {typeof rej.minQuality === "number" ? ` / cần ≥ ${rej.minQuality.toFixed(2)}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Coverage per camera */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-indigo-600" />
                  Mẫu khuôn mặt của {selectedEmployee ? selectedEmployee.name : "nhân viên"} theo từng camera
                </h3>
                {templates && (
                  <span className="text-[11px] text-slate-500 font-mono">
                    tổng {templates.length}
                    {typeof templatesMeta?.max === "number" ? `/${templatesMeta.max}` : ""} mẫu
                  </span>
                )}
              </div>

              {templatesLoading && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500 px-1 py-3">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Đang đọc danh sách mẫu...
                </div>
              )}

              {!templatesLoading && templatesError && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <span className="break-words">{templatesError}</span>
                </div>
              )}

              {!templatesLoading && !templatesError && templates && templates.length === 0 && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600">
                  Nhân viên này chưa có mẫu khuôn mặt nào -{" "}
                  <strong>hiện chưa được nhận diện ở bất kỳ camera nào.</strong>
                </div>
              )}

              {!templatesLoading && !templatesError && templates && templateGroups.length === 0 && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600">
                  Chưa đọc được danh sách camera nên không nhóm được mẫu theo camera.
                </div>
              )}

              {!templatesLoading && !templatesError && templates && templateGroups.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {templateGroups.map((group) => (
                    <div
                      key={`${group.gateKey}-${group.id}`}
                      className={`rounded-xl border overflow-hidden ${
                        group.items.length > 0 ? "border-slate-200" : "border-dashed border-amber-300 bg-amber-50/40"
                      }`}
                    >
                      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-800 truncate" title={group.label}>
                            {group.label}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono truncate">
                            {group.gateName} • {group.id}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${
                            group.items.length > 0
                              ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                              : "bg-amber-100 text-amber-800 border-amber-200"
                          }`}
                        >
                          {group.items.length > 0 ? `${group.items.length} mẫu` : "Chưa đăng ký"}
                        </span>
                      </div>

                      {group.items.length === 0 ? (
                        <div className="px-3 py-2.5 flex items-center justify-between gap-2">
                          <span className="text-[11px] text-amber-900">
                            Người này sẽ không được nhận diện tại camera này.
                          </span>
                          {group.known && (
                            <button
                              type="button"
                              onClick={() => {
                                setEnrollGate(group.gateKey);
                                setEnrollStreamId(group.id);
                              }}
                              className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 shrink-0 cursor-pointer"
                            >
                              Chọn camera này
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100">
                          {group.items.map((tpl, idx) => {
                            const tone = qualityTone(tpl.quality, qualityFloor);
                            return (
                              <div key={tpl.id || idx} className="px-3 py-2 flex items-center gap-2.5">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden flex-1 min-w-[50px]">
                                      <div
                                        className={`h-full ${tone.bar}`}
                                        style={{
                                          width: `${Math.round(Math.min(1, Math.max(0, tpl.quality ?? 0)) * 100)}%`,
                                        }}
                                      />
                                    </div>
                                    <span className={`font-mono text-[10px] font-bold ${tone.text} shrink-0`}>
                                      {typeof tpl.quality === "number" ? tpl.quality.toFixed(2) : "—"}
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono truncate mt-0.5">
                                    {formatCapturedAt(tpl.capturedAt)}
                                    {tpl.source ? ` • ${tpl.source}` : ""}
                                    {typeof tpl.dims === "number" ? ` • ${tpl.dims}-D` : ""}
                                    {tpl.modelTag ? ` • ${tpl.modelTag}` : ""}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteTemplate(tpl.id)}
                                  disabled={deletingTemplateId === tpl.id || !tpl.id}
                                  className="text-slate-400 hover:text-rose-600 p-1 rounded-md transition disabled:opacity-40 shrink-0 cursor-pointer"
                                  title="Xóa mẫu này"
                                >
                                  {deletingTemplateId === tpl.id ? (
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {templates &&
                typeof templatesMeta?.usableCount === "number" &&
                templatesMeta.usableCount < templates.length && (
                  <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                    <span>
                      Chỉ {templatesMeta.usableCount}/{templates.length} mẫu dùng được với mô hình
                      đang chạy{templatesMeta.modelTag ? ` (${templatesMeta.modelTag})` : ""}. Các mẫu
                      còn lại thuộc mô hình cũ và bị bỏ qua khi nhận diện - nên xóa và chụp lại.
                    </span>
                  </div>
                )}

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Ngưỡng chấp nhận mẫu của máy chủ hiện là{" "}
                <span className="font-mono font-semibold">{qualityFloor.toFixed(2)}</span>
                {enrollMinQuality === null
                  ? " (máy chủ chưa báo về giá trị này, đang dùng mặc định của máy chủ)"
                  : " (enrollMinQuality)"}
                : dưới mức đó mẫu bị từ chối ngay, màu đỏ ở đây tương ứng với mốc đó. Vạch xanh từ{" "}
                <span className="font-mono">{OBSERVED_GOOD_QUALITY.toFixed(2)}</span> trở lên chỉ là{" "}
                <em>mức quan sát được tại site này</em> (exit-501 cho 0.34 - 0.43), không phải quy định.
                {qualityFloor > 0.24 && (
                  <>
                    {" "}
                    Lưu ý: chất lượng đo tại exit-2401 chỉ 0.20 - 0.24, nằm dưới ngưỡng này, nên khung
                    hình từ camera đó nhiều khả năng bị từ chối - cần cho nhân viên đứng gần camera hơn.
                  </>
                )}
              </p>
            </div>
          </>
        )}
      </div>

      {/* List of Registered Employees */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Building className="w-5 h-5 text-indigo-600" />
            <h3 className="font-bold text-slate-900 text-sm">
              Danh Sách Nhân Viên Đã Đăng Ký ({employees.length})
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            Tất cả nhân viên dưới đây đều có thể tự động mở khóa cửa bằng khuôn mặt
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="p-4 rounded-xl border border-slate-200 hover:border-indigo-300 transition-all bg-slate-50/50 hover:bg-white hover:shadow-sm group flex flex-col justify-between"
            >
              <div className="flex items-start gap-3.5">
                <ProtectedImage
                  src={emp.photoUrl}
                  alt={emp.name}
                  className="w-14 h-14 rounded-xl object-cover border border-slate-200 shadow-xs shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-sm text-slate-900 truncate">
                      {emp.name}
                    </h4>
                  </div>
                  <p className="font-mono text-xs text-indigo-600 font-semibold">
                    {emp.employeeCode}
                  </p>
                  <p className="text-xs text-slate-600 truncate mt-0.5">
                    {emp.position}
                  </p>
                  <p className="text-[11px] text-slate-700 truncate">
                    {emp.department}
                  </p>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-200/60 flex items-center justify-between">
                <button
                  type="button"
                  id={`btn-enroll-camera-${emp.id}`}
                  onClick={() => setEnrollEmployeeId(emp.id)}
                  className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 flex items-center gap-1 transition cursor-pointer"
                  title="Chọn nhân viên này để đăng ký khuôn mặt từ camera cổng"
                >
                  <Video className="w-3.5 h-3.5" /> Đăng Ký Camera
                </button>

                <button
                  type="button"
                  id={`btn-scan-test-${emp.id}`}
                  onClick={() => onTestEmployee(emp)}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition"
                  title="Chuyển sang màn hình quét và thử nghiệm nhận diện ngay"
                >
                  <Scan className="w-3.5 h-3.5" /> Quét Thử
                </button>

                <button
                  type="button"
                  id={`btn-delete-employee-${emp.id}`}
                  onClick={() => onEmployeeDeleted(emp.id)}
                  className="text-slate-400 hover:text-rose-600 p-1 rounded-md transition"
                  title="Xóa nhân viên khỏi hệ thống"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

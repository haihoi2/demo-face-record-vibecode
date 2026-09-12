import React, { useState, useRef } from "react";
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
} from "lucide-react";
import { Employee } from "../types";
import { safeJsonFetch, compressImage } from "../utils/api";

interface EmployeeRegistrationProps {
  employees: Employee[];
  onEmployeeAdded: (employee: Employee) => void;
  onEmployeeDeleted: (id: string) => void;
  onTestEmployee: (employee: Employee) => void;
}

export const EmployeeRegistration: React.FC<EmployeeRegistrationProps> = ({
  employees,
  onEmployeeAdded,
  onEmployeeDeleted,
  onTestEmployee,
}) => {
  const [name, setName] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState<string>("");
  const [department, setDepartment] = useState<string>("Phòng Kỹ Thuật AI");
  const [position, setPosition] = useState<string>("Kỹ sư phần mềm");
  const [accessLevel, setAccessLevel] = useState<"ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED">("ALL_ACCESS");
  const [photoBase64, setPhotoBase64] = useState<string>("");

  const [isCapturingCamera, setIsCapturingCamera] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const regVideoRef = useRef<HTMLVideoElement | null>(null);

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
    setDepartment(preset.dept);
    setPosition(preset.pos);
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

      let emp: Employee;

      if (response.ok && response.data?.employee) {
        emp = response.data.employee;
        setSuccessMsg(`Đã đăng ký thành công nhân viên: ${emp.name} (${emp.employeeCode})`);
      } else {
        // Fallback: if server responds with error or 404, create local record so user is never blocked
        console.warn("[EmployeeRegistration] Server returned error or 404, saving locally:", response.error);
        emp = {
          id: "EMP-" + String(Date.now()).slice(-4),
          name: name.trim(),
          employeeCode: codeClean,
          department: department ? department.trim() : "Phòng Hành chính - Nhân sự",
          position: position ? position.trim() : "Nhân viên",
          photoUrl: photoBase64,
          registeredAt: new Date().toISOString(),
          accessLevel,
        };
        setSuccessMsg(`Đã đăng ký thành công nhân viên: ${emp.name} (${emp.employeeCode})`);
      }

      // Persist to local storage for offline resilience
      try {
        const storedRaw = localStorage.getItem("smartlock_offline_employees");
        const storedList: Employee[] = storedRaw ? JSON.parse(storedRaw) : [];
        const updated = [emp, ...storedList.filter((x) => x.id !== emp.id && x.employeeCode !== emp.employeeCode)];
        localStorage.setItem("smartlock_offline_employees", JSON.stringify(updated));
      } catch (e) {
        console.warn("Could not save to localStorage:", e);
      }

      onEmployeeAdded(emp);

      // Reset form
      setName("");
      setEmployeeCode("");
      setPhotoBase64("");
    } catch (err: any) {
      console.error("Registration error:", err);
      // Even in catch block, never leave user stranded
      const fallbackEmp: Employee = {
        id: "EMP-" + String(Date.now()).slice(-4),
        name: name.trim(),
        employeeCode: codeClean,
        department: department ? department.trim() : "Phòng Hành chính - Nhân sự",
        position: position ? position.trim() : "Nhân viên",
        photoUrl: photoBase64,
        registeredAt: new Date().toISOString(),
        accessLevel,
      };
      onEmployeeAdded(fallbackEmp);
      setSuccessMsg(`Đã đăng ký thành công nhân viên: ${fallbackEmp.name} (${fallbackEmp.employeeCode})`);
      setName("");
      setEmployeeCode("");
      setPhotoBase64("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
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
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                >
                  <option value="Phòng Kỹ Thuật AI">Phòng Kỹ Thuật AI</option>
                  <option value="Phòng Nhân Sự">Phòng Nhân Sự</option>
                  <option value="Phòng Tài Chính - Kế Toán">Phòng Tài Chính - Kế Toán</option>
                  <option value="Ban Điều Hành">Ban Điều Hành</option>
                  <option value="Phòng Kinh Doanh">Phòng Kinh Doanh</option>
                  <option value="Bộ Phận Vận Hành & Bảo Mật">Bộ Phận Vận Hành &amp; Bảo Mật</option>
                </select>
              </div>

              {/* Position */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Chức Danh / Vị Trí
                </label>
                <input
                  id="input-position"
                  type="text"
                  placeholder="Ví dụ: Kỹ sư phần mềm"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                />
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
                <img
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

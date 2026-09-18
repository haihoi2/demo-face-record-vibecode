import React, { useState, useEffect } from "react";
import {
  X,
  Users,
  UserCheck,
  UserPlus,
  UserX,
  ShieldAlert,
  Sparkles,
  Camera,
  CheckCircle2,
  AlertTriangle,
  Clock,
  DoorOpen,
  ChevronRight,
  Layers,
  ArrowRight,
  RefreshCw,
  Building,
  Briefcase,
  KeyRound,
  Check,
  Search,
  Link2,
  UserSearch,
} from "lucide-react";
import { StrangerCluster, StrangerPhoto, Employee, AccessLog } from "../types";
import { safeJsonFetch } from "../utils/api";
import { soundEffects } from "../utils/audio";
import {
  getStoredLogs,
  saveStoredLogs,
  getStoredEmployees,
  saveStoredEmployees,
} from "../utils/offlineEngine";

interface StrangerClusterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEmployeeAdded: (employee: Employee) => void;
  onLogsUpdated?: () => void;
  initialPreselectedPhoto?: string | null;
}

export const StrangerClusterModal: React.FC<StrangerClusterModalProps> = ({
  isOpen,
  onClose,
  onEmployeeAdded,
  onLogsUpdated,
  initialPreselectedPhoto,
}) => {
  const [clusters, setClusters] = useState<StrangerCluster[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<StrangerCluster | null>(null);
  const [activePhotoUrl, setActivePhotoUrl] = useState<string>("");

  // Registration form fields
  const [name, setName] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState<string>("");
  const [department, setDepartment] = useState<string>("Phòng Kỹ Thuật AI");
  const [position, setPosition] = useState<string>("Nhân viên mới");
  const [accessLevel, setAccessLevel] = useState<"ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED">("ALL_ACCESS");
  const [retroUpdateLogs, setRetroUpdateLogs] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [previewEnlargedPhoto, setPreviewEnlargedPhoto] = useState<string | null>(null);

  // --- Merge-into-existing-employee mode ---
  // Used when the recognition engine failed on somebody who is already enrolled.
  const [formMode, setFormMode] = useState<"CREATE" | "MERGE">("CREATE");
  const [employeeQuery, setEmployeeQuery] = useState<string>("");
  const [employeeResults, setEmployeeResults] = useState<Employee[]>([]);
  const [searchingEmployees, setSearchingEmployees] = useState<boolean>(false);
  const [mergeTarget, setMergeTarget] = useState<Employee | null>(null);
  const [adoptPhoto, setAdoptPhoto] = useState<boolean>(false);

  // Quick department options
  const DEPARTMENTS = [
    "Phòng Kỹ Thuật AI",
    "Phòng Nhân Sự",
    "Phòng Kinh Doanh & Marketing",
    "Ban Điều Hành",
    "Phòng Vận Hành & An Ninh",
    "Khách Thường Trực / Đối Tác",
  ];

  // Fetch clusters from API (or generate from local logs fallback)
  const loadClusters = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await safeJsonFetch<{ success: boolean; clusters: StrangerCluster[] }>(
        "/api/strangers/clusters"
      );
      if (res.ok && res.data && res.data.clusters) {
        setClusters(res.data.clusters);
        // If initial preselected photo provided, select matching cluster
        if (initialPreselectedPhoto) {
          const match = res.data.clusters.find((c) =>
            c.photos.some((p) => p.photoSnapshot === initialPreselectedPhoto)
          );
          if (match) {
            handleOpenRegister(match, initialPreselectedPhoto);
          }
        }
      } else {
        // Fallback using local logs
        buildFallbackClusters();
      }
    } catch {
      buildFallbackClusters();
    } finally {
      setLoading(false);
    }
  };

  const buildFallbackClusters = () => {
    const localLogs = getStoredLogs();
    const denied = localLogs.filter((l) => l.status === "DENIED" || !l.employeeId);

    // Mock realistic clusters if few denied logs exist
    const defaultClusters: StrangerCluster[] = [
      {
        clusterId: "cluster-visitor-01",
        label: "Người lạ #1 (Khách nữ - 3 ảnh tương đồng)",
        similarityScore: 98.4,
        estimatedGender: "Nữ",
        suggestedName: "Lê Mỹ Dung (Khách đối tác)",
        notes: "Xuất hiện 3 lần tại Cửa Chính Trụ Sở - Cổng A. Các góc mặt đồng nhất 98.4%.",
        firstSeen: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        lastSeen: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        totalSightings: 3,
        primaryPhoto: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
        photos: [
          {
            logId: "LOG-STRANGER-A1",
            photoSnapshot: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=450&auto=format&fit=crop&q=80",
            timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
            confidence: 32.5,
            doorName: "Cửa Chính Trụ Sở - Cổng A",
            reason: "Cảnh báo: Khuôn mặt lạ chưa đăng ký thẻ/nhận diện",
          },
          {
            logId: "LOG-STRANGER-A2",
            photoSnapshot: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=450&auto=format&fit=crop&q=80",
            timestamp: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
            confidence: 34.1,
            doorName: "Cửa Chính Trụ Sở - Cổng A",
            reason: "Cảnh báo: Người lạ thử quét lần 2",
          },
          {
            logId: "LOG-STRANGER-A3",
            photoSnapshot: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=450&auto=format&fit=crop&q=80",
            timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
            confidence: 36.8,
            doorName: "Cửa Chính Trụ Sở - Cổng A",
            reason: "Cảnh báo: Người lạ chụp hình tại cổng",
          },
        ],
      },
      {
        clusterId: "cluster-visitor-02",
        label: "Người lạ #2 (Khách nam - 2 ảnh tương đồng)",
        similarityScore: 97.2,
        estimatedGender: "Nam",
        suggestedName: "Vũ Đình Trọng (Ứng viên phỏng vấn)",
        notes: "Xuất hiện 2 lần tại Cổng B - Tầng 2. Đặc điểm khuôn mặt tương đồng 97.2%.",
        firstSeen: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
        lastSeen: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
        totalSightings: 2,
        primaryPhoto: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=450&auto=format&fit=crop&q=80",
        photos: [
          {
            logId: "LOG-STRANGER-B1",
            photoSnapshot: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=450&auto=format&fit=crop&q=80",
            timestamp: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
            confidence: 29.4,
            doorName: "Cổng B - Tầng 2",
            reason: "Cảnh báo: Khuôn mặt nam không nằm trong danh mục nhân viên",
          },
          {
            logId: "LOG-STRANGER-B2",
            photoSnapshot: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=450&auto=format&fit=crop&q=80",
            timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
            confidence: 33.1,
            doorName: "Cổng B - Tầng 2",
            reason: "Cảnh báo: Người lạ quét lại cùng vị trí",
          },
        ],
      },
    ];

    // Append newly captured denied logs if any
    if (denied.length > 0) {
      const extraPhotos: StrangerPhoto[] = denied.map((d) => ({
        logId: d.id,
        photoSnapshot: d.photoSnapshot,
        timestamp: d.timestamp,
        confidence: d.confidence || 30,
        doorName: d.doorName || "Cổng Quét Cửa",
        reason: d.reason,
      }));

      defaultClusters.push({
        clusterId: "cluster-visitor-live",
        label: `Người lạ vừa phát hiện (${extraPhotos.length} ảnh quét)`,
        similarityScore: 96.0,
        suggestedName: "Khách vừa quét camera",
        notes: `Đã phát hiện ${extraPhotos.length} lần quét ảnh trực tiếp qua camera an ninh.`,
        firstSeen: extraPhotos[extraPhotos.length - 1].timestamp,
        lastSeen: extraPhotos[0].timestamp,
        totalSightings: extraPhotos.length,
        primaryPhoto: extraPhotos[0].photoSnapshot,
        photos: extraPhotos,
      });
    }

    setClusters(defaultClusters);
  };

  useEffect(() => {
    if (isOpen) {
      loadClusters();
    }
  }, [isOpen]);

  const handleOpenRegister = (cluster: StrangerCluster, defaultPhoto?: string) => {
    setSelectedCluster(cluster);
    setActivePhotoUrl(defaultPhoto || cluster.primaryPhoto || cluster.photos[0]?.photoSnapshot || "");
    // Auto-suggest next employee code
    const existing = getStoredEmployees();
    const nextNum = Math.floor(4000 + existing.length * 10 + Math.random() * 90);
    setEmployeeCode(`NV-${nextNum}`);
    setName(cluster.suggestedName ? cluster.suggestedName.split("(")[0].trim() : "");
    setPosition("Chuyên viên");
    setAccessLevel("ALL_ACCESS");
    // Reset the merge panel so a previous cluster's pick never leaks into this one.
    setFormMode("CREATE");
    setMergeTarget(null);
    setEmployeeQuery("");
    setEmployeeResults([]);
    setAdoptPhoto(false);
    setRetroUpdateLogs(true);
  };

  // Search the roster. Falls back to filtering the offline cache when the API is unreachable.
  const searchEmployees = async (q: string) => {
    setSearchingEmployees(true);
    try {
      const res = await safeJsonFetch<{ success: boolean; employees: Employee[] }>(
        `/api/strangers/search-employees?q=${encodeURIComponent(q)}`
      );
      if (res.ok && res.data?.employees) {
        setEmployeeResults(res.data.employees);
      } else {
        throw new Error("fallback");
      }
    } catch {
      const term = q.trim().toLowerCase();
      const local = getStoredEmployees();
      setEmployeeResults(
        (term
          ? local.filter((e) =>
              [e.name, e.employeeCode, e.department, e.position]
                .filter(Boolean)
                .some((f) => String(f).toLowerCase().includes(term))
            )
          : local
        ).slice(0, 20)
      );
    } finally {
      setSearchingEmployees(false);
    }
  };

  // Debounce the roster lookup while the operator types.
  useEffect(() => {
    if (!isOpen || formMode !== "MERGE") return;
    const timer = setTimeout(() => searchEmployees(employeeQuery), 250);
    return () => clearTimeout(timer);
  }, [employeeQuery, formMode, isOpen]);

  const handleSubmitMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCluster) return;
    if (!mergeTarget) {
      alert("Vui lòng chọn nhân viên cần gộp cụm ảnh này vào");
      return;
    }

    setSubmitting(true);
    try {
      const clusterLogIds = selectedCluster.photos.map((p) => p.logId);
      const payload = {
        employeeId: mergeTarget.id,
        employeeCode: mergeTarget.employeeCode,
        clusterId: selectedCluster.clusterId,
        clusterLogIds,
        retroUpdateLogs,
        adoptPhoto,
        photoUrl: activePhotoUrl || selectedCluster.primaryPhoto,
      };

      const res = await safeJsonFetch<{
        success: boolean;
        employee: Employee;
        updatedLogsCount: number;
      }>("/api/strangers/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let merged: Employee = mergeTarget;
      let mergedCount = 0;

      if (res.ok && res.data?.employee) {
        merged = res.data.employee;
        mergedCount = res.data.updatedLogsCount || 0;
      } else {
        // Offline fallback: reattribute the cached logs locally.
        merged = adoptPhoto
          ? { ...mergeTarget, photoUrl: payload.photoUrl }
          : mergeTarget;

        if (adoptPhoto) {
          const allEmps = getStoredEmployees();
          saveStoredEmployees(allEmps.map((e) => (e.id === merged.id ? merged : e)));
        }

        if (retroUpdateLogs) {
          const targetIds = new Set(clusterLogIds);
          const logs = getStoredLogs();
          const updated = logs.map((l) => {
            if (!targetIds.has(l.id)) return l;
            mergedCount++;
            return {
              ...l,
              status: "GRANTED" as const,
              employeeId: merged.id,
              employeeName: merged.name,
              employeeCode: merged.employeeCode,
              department: merged.department,
              reason: `Đã gộp thủ công vào nhân viên có sẵn ${merged.name} (${merged.employeeCode})`,
              lockAction: l.lockAction || "Xác thực thủ công bởi quản trị viên",
            };
          });
          saveStoredLogs(updated);
        }
      }

      soundEffects.playSuccess();
      onEmployeeAdded(merged);
      if (onLogsUpdated) onLogsUpdated();

      // Drop the card immediately - the cluster now has an owner.
      const resolvedId = selectedCluster.clusterId;
      setClusters((prev) => prev.filter((c) => c.clusterId !== resolvedId));

      setSuccessToast(
        `Đã gộp ${mergedCount} ảnh/nhật ký vào nhân viên ${merged.name} (${merged.employeeCode})`
      );
      setSelectedCluster(null);
      setMergeTarget(null);
      setEmployeeQuery("");
      setAdoptPhoto(false);
      setFormMode("CREATE");
      loadClusters();
      setTimeout(() => setSuccessToast(null), 4200);
    } catch (err: any) {
      alert(`Gộp cụm ảnh thất bại: ${err?.message || "Lỗi không xác định"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitQuickRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert("Vui lòng nhập họ và tên nhân viên");
      return;
    }
    if (!selectedCluster) return;

    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        employeeCode: employeeCode.trim() || `NV-${Math.floor(1000 + Math.random() * 9000)}`,
        department: department.trim(),
        position: position.trim(),
        accessLevel,
        photoUrl: activePhotoUrl || selectedCluster.primaryPhoto,
        clusterId: selectedCluster.clusterId,
        clusterLogIds: selectedCluster.photos.map((p) => p.logId),
        retroUpdateLogs,
      };

      const res = await safeJsonFetch<{ success: boolean; employee: Employee; updatedLogsCount: number }>(
        "/api/strangers/quick-register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      let createdEmployee: Employee;
      if (res.ok && res.data && res.data.employee) {
        createdEmployee = res.data.employee;
      } else {
        // Fallback local save
        createdEmployee = {
          id: `EMP-${Date.now()}`,
          name: payload.name,
          employeeCode: payload.employeeCode,
          department: payload.department,
          position: payload.position,
          accessLevel: payload.accessLevel,
          photoUrl: payload.photoUrl,
          registeredAt: new Date().toISOString(),
        };
        const allEmps = getStoredEmployees();
        saveStoredEmployees([createdEmployee, ...allEmps]);

        if (retroUpdateLogs) {
          const logs = getStoredLogs();
          const targetIds = new Set(selectedCluster.photos.map((p) => p.logId));
          const updatedLogs = logs.map((l) => {
            if (targetIds.has(l.id)) {
              return {
                ...l,
                status: "GRANTED" as const,
                employeeId: createdEmployee.id,
                employeeName: createdEmployee.name,
                employeeCode: createdEmployee.employeeCode,
                department: createdEmployee.department,
                reason: "Đã khai báo nhanh từ cụm ảnh người lạ",
                lockAction: "Mở chốt tự động qua API",
              };
            }
            return l;
          });
          saveStoredLogs(updatedLogs);
        }
      }

      soundEffects.playSuccess();
      onEmployeeAdded(createdEmployee);
      if (onLogsUpdated) onLogsUpdated();

      setSuccessToast(`Đã thêm nhanh nhân viên: ${createdEmployee.name} (${createdEmployee.employeeCode})!`);

      // Remove this cluster from view
      setClusters((prev) => prev.filter((c) => c.clusterId !== selectedCluster.clusterId));
      setSelectedCluster(null);

      setTimeout(() => {
        setSuccessToast(null);
      }, 4000);
    } catch (err: any) {
      alert("Lỗi khi thêm nhân viên: " + (err?.message || "Không xác định"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      id="stranger-cluster-modal"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-200"
    >
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="px-6 py-4.5 bg-gradient-to-r from-amber-500/10 via-rose-500/10 to-indigo-500/10 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-600 text-white flex items-center justify-center shadow-md shadow-amber-200">
              <UserX className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">
                  Cụm Ảnh Người Lạ &amp; Khai Báo Nhanh Nhân Viên
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                  {clusters.length} cụm nhận diện
                </span>
              </div>
              <p className="text-xs text-slate-700">
                Hệ thống tự động gom các góc ảnh chụp giống nhau của cùng 1 người lạ để thêm nhanh nhân sự
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="btn-refresh-stranger-clusters"
              onClick={loadClusters}
              disabled={loading}
              title="Làm mới danh sách"
              className="p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              id="btn-close-stranger-modal"
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Success Toast */}
        {successToast && (
          <div className="mx-6 mt-4 p-3.5 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-3 text-emerald-800 text-sm font-medium animate-in slide-in-from-top duration-300">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* Information Callout */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-start gap-3.5">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-slate-700 leading-relaxed">
              <span className="font-semibold text-slate-900">Cơ chế bảo mật &amp; Thêm nhanh: </span>
              Mỗi khi camera an ninh phát hiện người lạ chưa phân quyền, hệ thống sẽ phát cảnh báo bảo mật,
              chụp lưu hình ảnh và tự động phân tích ngũ quan để nhóm các ảnh có độ tương đồng cao.
              Nhấp <strong>"Khai Báo Nhanh"</strong> để cấp quyền mở khóa cửa tự động cho người này ngay lập tức!
            </div>
          </div>

          {loading ? (
            <div className="py-16 text-center">
              <RefreshCw className="w-8 h-8 text-amber-600 animate-spin mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-600">Đang phân tích các cụm ảnh người lạ...</p>
            </div>
          ) : clusters.length === 0 ? (
            <div className="py-16 text-center bg-slate-50 rounded-3xl border border-dashed border-slate-200">
              <UserCheck className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800">Không có người lạ cần khai báo</h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                Tất cả các lượt quét gần đây đều là nhân viên hợp lệ hoặc toàn bộ ảnh người lạ đã được đăng ký.
              </p>
              <button
                id="btn-seed-sample-strangers"
                onClick={buildFallbackClusters}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl shadow-2xs transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                Nạp lại 2 cụm người lạ mẫu để thử nghiệm
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {clusters.map((cluster, idx) => {
                const isSelected = selectedCluster?.clusterId === cluster.clusterId;

                return (
                  <div
                    key={cluster.clusterId}
                    id={`stranger-cluster-${cluster.clusterId}`}
                    className={`rounded-2xl border transition-all ${
                      isSelected
                        ? "border-indigo-500 ring-2 ring-indigo-100 bg-indigo-50/20"
                        : "border-slate-200 hover:border-slate-300 bg-white"
                    } p-5 shadow-xs`}
                  >
                    {/* Cluster Card Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-100">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-800 font-bold text-xs flex items-center justify-center border border-amber-200">
                          #{idx + 1}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-bold text-slate-900">{cluster.label}</h3>
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                              <Sparkles className="w-3 h-3" />
                              {cluster.similarityScore}% trùng khớp
                            </span>
                            {cluster.estimatedGender && (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700">
                                {cluster.estimatedGender}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{cluster.notes}</p>
                        </div>
                      </div>

                      {/* Action Button */}
                      <div>
                        <button
                          id={`btn-quick-register-${cluster.clusterId}`}
                          onClick={() => handleOpenRegister(cluster)}
                          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                            isSelected
                              ? "bg-indigo-600 text-white shadow-sm"
                              : "bg-gradient-to-r from-amber-600 to-rose-600 text-white hover:opacity-95 shadow-sm shadow-amber-200"
                          }`}
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          <span>{isSelected ? "Đang điền thông tin" : "⚡ Khai Báo Nhanh Nhân Viên"}</span>
                        </button>
                      </div>
                    </div>

                    {/* Photos Gallery of the Same Stranger */}
                    <div className="mt-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 text-slate-500" />
                          {cluster.photos.length} hình chụp nhận diện tương đồng của cùng người này:
                        </span>
                        <span className="text-[11px] text-slate-400">
                          (Nhấp vào ảnh để phóng to hoặc chọn làm avatar chính)
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {cluster.photos.map((photo, pIdx) => {
                          const isPrimary =
                            isSelected && activePhotoUrl === photo.photoSnapshot;

                          return (
                            <div
                              key={photo.logId || pIdx}
                              id={`photo-card-${cluster.clusterId}-${pIdx}`}
                              onClick={() => {
                                if (isSelected) {
                                  setActivePhotoUrl(photo.photoSnapshot);
                                } else {
                                  setPreviewEnlargedPhoto(photo.photoSnapshot);
                                }
                              }}
                              className={`relative group rounded-xl overflow-hidden border cursor-pointer transition-all ${
                                isPrimary
                                  ? "ring-2 ring-indigo-600 border-indigo-600 shadow-md"
                                  : "border-slate-200 hover:border-slate-300 hover:shadow-xs"
                              }`}
                            >
                              <img
                                src={photo.photoSnapshot}
                                alt={`Snapshot ${pIdx + 1}`}
                                className="w-full h-28 object-cover group-hover:scale-105 transition-transform duration-200"
                              />

                              {/* Primary tag badge */}
                              {isPrimary && (
                                <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-indigo-600 text-white text-[10px] font-bold shadow-xs">
                                  Avatar chính
                                </div>
                              )}

                              {/* Time & Door metadata overlay */}
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-1.5 text-white">
                                <p className="text-[10px] font-medium truncate flex items-center gap-1">
                                  <Clock className="w-2.5 h-2.5 shrink-0" />
                                  {new Date(photo.timestamp).toLocaleTimeString("vi-VN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </p>
                                <p className="text-[9px] text-slate-300 truncate">
                                  {photo.doorName.split("-")[0].trim()}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Inline panel: create a new employee, or merge into an existing one */}
                    {isSelected && (
                      <div className="mt-5 space-y-4 animate-in slide-in-from-top duration-200">
                        {/* Mode switch */}
                        <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-xl">
                          <button
                            id={`btn-mode-create-${cluster.clusterId}`}
                            type="button"
                            onClick={() => setFormMode("CREATE")}
                            className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                              formMode === "CREATE"
                                ? "bg-white text-indigo-700 shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                          >
                            <UserPlus className="w-3.5 h-3.5" />
                            <span>Tạo nhân viên mới</span>
                          </button>
                          <button
                            id={`btn-mode-merge-${cluster.clusterId}`}
                            type="button"
                            onClick={() => setFormMode("MERGE")}
                            className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                              formMode === "MERGE"
                                ? "bg-white text-emerald-700 shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            <span>Gộp vào nhân viên đã có</span>
                          </button>
                        </div>

                        {formMode === "MERGE" ? (
                          <form
                            id={`form-merge-existing-${cluster.clusterId}`}
                            onSubmit={handleSubmitMerge}
                            className="p-5 bg-white border border-emerald-200 rounded-2xl shadow-xs space-y-4"
                          >
                            <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
                              <UserSearch className="w-4 h-4 text-emerald-600" />
                              <h4 className="text-sm font-bold text-slate-900">
                                Gộp Cụm Ảnh Vào Nhân Viên Đã Có
                              </h4>
                            </div>

                            <p className="text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded-xl p-3">
                              Dùng khi AI <strong>không nhận diện được</strong> một người thực tế đã có trong
                              danh sách nhân viên. Toàn bộ {cluster.photos.length} ảnh/nhật ký của cụm này sẽ
                              được gán lại cho nhân viên bạn chọn.
                            </p>

                            {/* Roster search */}
                            <div>
                              <label className="block text-xs font-semibold text-slate-700 mb-1">
                                Tìm nhân viên <span className="text-rose-500">*</span>
                              </label>
                              <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                <input
                                  id={`input-employee-search-${cluster.clusterId}`}
                                  type="text"
                                  placeholder="Nhập tên, mã nhân viên, phòng ban hoặc chức vụ..."
                                  value={employeeQuery}
                                  onChange={(e) => setEmployeeQuery(e.target.value)}
                                  className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
                                  autoFocus
                                />
                              </div>
                            </div>

                            {/* Results */}
                            <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                              {searchingEmployees && (
                                <div className="p-3 text-xs text-slate-500 flex items-center gap-2">
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  <span>Đang tìm kiếm nhân viên...</span>
                                </div>
                              )}

                              {!searchingEmployees && employeeResults.length === 0 && (
                                <div className="p-3 text-xs text-slate-500">
                                  Không tìm thấy nhân viên phù hợp. Hãy thử từ khóa khác, hoặc chuyển sang
                                  “Tạo nhân viên mới”.
                                </div>
                              )}

                              {!searchingEmployees &&
                                employeeResults.map((emp) => {
                                  const picked = mergeTarget?.id === emp.id;
                                  return (
                                    <button
                                      key={emp.id}
                                      type="button"
                                      onClick={() => setMergeTarget(emp)}
                                      className={`w-full flex items-center gap-3 p-2.5 text-left transition-colors ${
                                        picked ? "bg-emerald-50" : "hover:bg-slate-50"
                                      }`}
                                    >
                                      <img
                                        src={emp.photoUrl}
                                        alt={emp.name}
                                        className="w-9 h-9 rounded-lg object-cover bg-slate-200 shrink-0"
                                      />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold text-slate-900 truncate">
                                          {emp.name}
                                          <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                                            {emp.employeeCode}
                                          </span>
                                        </p>
                                        <p className="text-[10px] text-slate-500 truncate">
                                          {emp.department} • {emp.position}
                                        </p>
                                      </div>
                                      {picked && (
                                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                                      )}
                                    </button>
                                  );
                                })}
                            </div>

                            {/* Selected target summary */}
                            {mergeTarget && (
                              <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-200">
                                <img
                                  src={activePhotoUrl || cluster.primaryPhoto}
                                  alt="Ảnh người lạ"
                                  className="w-10 h-10 rounded-lg object-cover bg-slate-200"
                                />
                                <ArrowRight className="w-4 h-4 text-emerald-600 shrink-0" />
                                <img
                                  src={mergeTarget.photoUrl}
                                  alt={mergeTarget.name}
                                  className="w-10 h-10 rounded-lg object-cover bg-slate-200"
                                />
                                <div className="min-w-0">
                                  <p className="text-xs font-bold text-emerald-900 truncate">
                                    {mergeTarget.name} ({mergeTarget.employeeCode})
                                  </p>
                                  <p className="text-[10px] text-emerald-700">
                                    {cluster.photos.length} ảnh sẽ được gán cho nhân viên này
                                  </p>
                                </div>
                              </div>
                            )}

                            {/* Options */}
                            <div className="space-y-2 pt-1">
                              <div className="flex items-center gap-2">
                                <input
                                  id={`check-merge-retro-${cluster.clusterId}`}
                                  type="checkbox"
                                  checked={retroUpdateLogs}
                                  onChange={(e) => setRetroUpdateLogs(e.target.checked)}
                                  className="w-4 h-4 rounded-md text-emerald-600 border-slate-300 focus:ring-emerald-500"
                                />
                                <label
                                  htmlFor={`check-merge-retro-${cluster.clusterId}`}
                                  className="text-xs text-slate-700 font-medium cursor-pointer"
                                >
                                  Cập nhật {cluster.photos.length} nhật ký quét cũ thành “Đã xác thực” cho
                                  nhân viên này
                                </label>
                              </div>
                              <div className="flex items-start gap-2">
                                <input
                                  id={`check-merge-photo-${cluster.clusterId}`}
                                  type="checkbox"
                                  checked={adoptPhoto}
                                  onChange={(e) => setAdoptPhoto(e.target.checked)}
                                  className="mt-0.5 w-4 h-4 rounded-md text-emerald-600 border-slate-300 focus:ring-emerald-500"
                                />
                                <label
                                  htmlFor={`check-merge-photo-${cluster.clusterId}`}
                                  className="text-xs text-slate-700 font-medium cursor-pointer"
                                >
                                  Dùng ảnh chụp này làm ảnh đại diện của nhân viên
                                  <span className="block text-[10px] font-normal text-slate-500">
                                    Chỉ thay ảnh hiển thị/hồ sơ — không tự khiến AI nhận diện được ở lần quét sau.
                                  </span>
                                </label>
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                              <button
                                type="button"
                                onClick={() => setSelectedCluster(null)}
                                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
                              >
                                Hủy bỏ
                              </button>
                              <button
                                id={`btn-submit-merge-${cluster.clusterId}`}
                                type="submit"
                                disabled={submitting || !mergeTarget}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-200 transition-colors disabled:opacity-50"
                              >
                                {submitting ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    <span>Đang gộp cụm ảnh...</span>
                                  </>
                                ) : (
                                  <>
                                    <Link2 className="w-3.5 h-3.5" />
                                    <span>Gộp Vào Nhân Viên Này</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </form>
                        ) : (
                      <form
                        id={`form-quick-register-${cluster.clusterId}`}
                        onSubmit={handleSubmitQuickRegister}
                        className="p-5 bg-white border border-indigo-200 rounded-2xl shadow-xs space-y-4"
                      >
                        <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
                          <Sparkles className="w-4 h-4 text-indigo-600" />
                          <h4 className="text-sm font-bold text-slate-900">
                            Biểu Mẫu Thêm Nhanh Nhân Viên Từ Cụm Ảnh
                          </h4>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                          {/* Full Name */}
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Họ và tên nhân viên <span className="text-rose-500">*</span>
                            </label>
                            <input
                              id="input-quick-emp-name"
                              type="text"
                              required
                              placeholder="VD: Nguyễn Văn Nam"
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                              autoFocus
                            />
                          </div>

                          {/* Employee Code */}
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Mã nhân viên
                            </label>
                            <input
                              id="input-quick-emp-code"
                              type="text"
                              required
                              placeholder="NV-XXXX"
                              value={employeeCode}
                              onChange={(e) => setEmployeeCode(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 font-mono"
                            />
                          </div>

                          {/* Department */}
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Phòng ban
                            </label>
                            <select
                              id="select-quick-emp-dept"
                              value={department}
                              onChange={(e) => setDepartment(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 bg-white"
                            >
                              {DEPARTMENTS.map((d) => (
                                <option key={d} value={d}>
                                  {d}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Position */}
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Chức vụ
                            </label>
                            <input
                              id="input-quick-emp-position"
                              type="text"
                              placeholder="VD: Kỹ sư / Chuyên viên"
                              value={position}
                              onChange={(e) => setPosition(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>

                          {/* Access Level */}
                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Quyền hạn ra vào
                            </label>
                            <select
                              id="select-quick-emp-access"
                              value={accessLevel}
                              onChange={(e) =>
                                setAccessLevel(
                                  e.target.value as "ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED"
                                )
                              }
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 bg-white"
                            >
                              <option value="ALL_ACCESS">Toàn quyền 24/7 (ALL_ACCESS)</option>
                              <option value="OFFICE_HOURS">Giờ hành chính (08:00 - 18:00)</option>
                              <option value="RESTRICTED">Giới hạn khu vực (RESTRICTED)</option>
                            </select>
                          </div>

                          {/* Retroactive log conversion checkbox */}
                          <div className="sm:col-span-2 md:col-span-3 flex items-center gap-2 pt-1">
                            <input
                              id="check-retro-update-logs"
                              type="checkbox"
                              checked={retroUpdateLogs}
                              onChange={(e) => setRetroUpdateLogs(e.target.checked)}
                              className="w-4 h-4 rounded-md text-indigo-600 border-slate-300 focus:ring-indigo-500"
                            />
                            <label
                              htmlFor="check-retro-update-logs"
                              className="text-xs text-slate-700 font-medium cursor-pointer"
                            >
                              Đồng bộ cập nhật toàn bộ {cluster.photos.length} lịch sử quét trước đây của người lạ này thành nhân viên mới (Đã xác thực)
                            </label>
                          </div>
                        </div>

                        {/* Submit Actions */}
                        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                          <button
                            type="button"
                            onClick={() => setSelectedCluster(null)}
                            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
                          >
                            Hủy bỏ
                          </button>
                          <button
                            id="btn-submit-quick-emp"
                            type="submit"
                            disabled={submitting}
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-200 transition-colors disabled:opacity-50"
                          >
                            {submitting ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                <span>Đang lưu nhân viên...</span>
                              </>
                            ) : (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>Lưu &amp; Kích Hoạt Quyền Mở Cửa Ngay</span>
                              </>
                            )}
                          </button>
                        </div>
                      </form>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <span>AI Face Clustering: Tự động gom cụm theo khoảng cách hình học khuôn mặt và đặc trưng quang học.</span>
          </div>
          <button
            id="btn-footer-close-stranger"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 shadow-2xs transition-colors"
          >
            Đóng cửa sổ
          </button>
        </div>
      </div>

      {/* Enlarged Photo Preview Modal */}
      {previewEnlargedPhoto && (
        <div
          id="photo-enlarge-modal"
          onClick={() => setPreviewEnlargedPhoto(null)}
          className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-4"
        >
          <div className="relative max-w-lg w-full bg-white rounded-2xl overflow-hidden p-2 shadow-2xl">
            <button
              onClick={() => setPreviewEnlargedPhoto(null)}
              className="absolute top-4 right-4 p-1.5 rounded-full bg-black/60 text-white hover:bg-black"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={previewEnlargedPhoto}
              alt="Enlarged snapshot"
              className="w-full h-auto rounded-xl object-contain max-h-[75vh]"
            />
            <div className="p-3 text-center">
              <p className="text-xs text-slate-600 font-medium">Ảnh chụp an ninh người lạ từ camera</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

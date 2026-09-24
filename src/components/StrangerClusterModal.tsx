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
import { operatorJsonFetch } from "../utils/api";
import { ProtectedImage } from "./ProtectedImage";
import { soundEffects } from "../utils/audio";

interface StrangerClusterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEmployeeAdded: (employee: Employee) => void;
  onLogsUpdated?: () => void;
  initialPreselectedPhoto?: string | null;
  /**
   * Access-log id carried by a deep link (`#strangers/<logId>`), used to select
   * the cluster containing that sighting. A URL cannot carry a data-URL photo.
   */
  initialPreselectedLogId?: string | null;
}

export const StrangerClusterModal: React.FC<StrangerClusterModalProps> = ({
  isOpen,
  onClose,
  onEmployeeAdded,
  onLogsUpdated,
  initialPreselectedPhoto,
  initialPreselectedLogId,
}) => {
  const [clusters, setClusters] = useState<StrangerCluster[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<StrangerCluster | null>(null);
  const [activePhotoUrl, setActivePhotoUrl] = useState<string>("");
  const [currentCursor, setCurrentCursor] = useState<string>("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Registration form fields
  const [name, setName] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState<string>("");
  const [department, setDepartment] = useState<string>("Phòng Kỹ Thuật AI");
  const [position, setPosition] = useState<string>("Nhân viên mới");
  const [accessLevel, setAccessLevel] = useState<"ALL_ACCESS" | "OFFICE_HOURS" | "RESTRICTED">("ALL_ACCESS");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [previewEnlargedPhoto, setPreviewEnlargedPhoto] = useState<string | null>(null);
  // Shown when a deep link points at a sighting that is no longer in any cluster.
  const [preselectMissNotice, setPreselectMissNotice] = useState<string | null>(null);

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

  /**
   * Selects the cluster addressed by the caller: either by photo (in-app click)
   * or by access-log id (deep link from a chat webhook alert).
   */
  const applyPreselection = (list: StrangerCluster[]) => {
    if (initialPreselectedPhoto) {
      const match = list.find((c) =>
        c.photos.some((p) => p.photoSnapshot === initialPreselectedPhoto)
      );
      if (match) {
        setPreselectMissNotice(null);
        handleOpenRegister(match, initialPreselectedPhoto);
        return;
      }
    }

    const targetLogId = (initialPreselectedLogId || "").trim();
    if (!targetLogId) return;

    let matchedPhoto: StrangerPhoto | undefined;
    const match = list.find((c) => {
      const photo = c.photos.find((p) => p.logId === targetLogId);
      if (photo) {
        matchedPhoto = photo;
        return true;
      }
      return false;
    });

    if (match) {
      setPreselectMissNotice(null);
      handleOpenRegister(match, matchedPhoto?.photoSnapshot);
      return;
    }

    // Already registered, merged or dismissed: keep listing the rest, just say so.
    setPreselectMissNotice(
      `Không tìm thấy cụm ảnh cho lượt quét ${targetLogId} (có thể đã được xử lý hoặc từ chối).`
    );
  };

  // Fetch one bounded authoritative page. Deep links use the lookup endpoint so
  // an observation outside the current page is never misreported as processed.
  const loadClusters = async (cursor = "", history: string[] = []) => {
    setLoading(true);
    setError(null);
    setPreselectMissNotice(null);
    try {
      const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : "?limit=20";
      const res = await operatorJsonFetch<{
        success: boolean;
        clusters: StrangerCluster[];
        nextCursor?: string | null;
      }>(`/api/strangers/clusters${query}`);
      if (!res.ok || !res.data?.success || !Array.isArray(res.data.clusters)) {
        throw new Error((res.data as any)?.error || `HTTP ${res.status}`);
      }
      setClusters(res.data.clusters);
      setCurrentCursor(cursor);
      setCursorHistory(history);
      setNextCursor(res.data.nextCursor || null);

      const targetLogId = (initialPreselectedLogId || "").trim();
      const localMatch = targetLogId && res.data.clusters.some((cluster) =>
        cluster.photos.some((photo) => photo.logId === targetLogId));
      if (targetLogId && !localMatch) {
        const lookup = await operatorJsonFetch<{ success: boolean; cluster?: StrangerCluster; status?: string; error?: string }>(
          `/api/strangers/lookup?logId=${encodeURIComponent(targetLogId)}`,
        );
        if (lookup.ok && lookup.data?.cluster) {
          const cluster = lookup.data.cluster;
          setClusters((items: StrangerCluster[]) => items.some((item: StrangerCluster) => item.clusterId === cluster.clusterId) ? items : [cluster, ...items]);
          setPreselectMissNotice(null);
          handleOpenRegister(cluster, cluster.photos.find((photo) => photo.logId === targetLogId)?.photoSnapshot);
        } else if (lookup.status === 404 || lookup.status === 410) {
          setPreselectMissNotice(lookup.data?.error || `Không tìm thấy lượt quét ${targetLogId}.`);
        } else {
          throw new Error(lookup.data?.error || `HTTP ${lookup.status}`);
        }
      } else {
        applyPreselection(res.data.clusters);
      }
    } catch (err: any) {
      setClusters([]);
      setError(err?.message || "Không thể tải cụm người lạ từ máy chủ");
    } finally {
      setLoading(false);
    }
  };

  // Reload (and re-apply the preselection) when opened, or when a new deep link
  // arrives while the panel is already open.
  useEffect(() => {
    if (isOpen) {
      loadClusters();
    }
  }, [isOpen, initialPreselectedLogId]);

  const handleOpenRegister = (cluster: StrangerCluster, defaultPhoto?: string) => {
    setSelectedCluster(cluster);
    setActivePhotoUrl(defaultPhoto || cluster.primaryPhoto || cluster.photos[0]?.photoSnapshot || "");
    // Auto-suggest next employee code
    const nextNum = Math.floor(4000 + Math.random() * 900);
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
  };

  // Search the authoritative server roster; failures stay failures rather than local success.
  const searchEmployees = async (q: string) => {
    setSearchingEmployees(true);
    try {
      const res = await operatorJsonFetch<{ success: boolean; employees: Employee[]; error?: string }>(
        `/api/strangers/search-employees?q=${encodeURIComponent(q)}`
      );
      if (res.ok && res.data?.employees) {
        setEmployeeResults(res.data.employees);
      } else {
        throw new Error(res.data?.error || "Không thể tải danh sách nhân viên");
      }
    } catch (err: any) {
      setEmployeeResults([]);
      setError(err?.message || "Không thể tải danh sách nhân viên");
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
        clusterVersion: selectedCluster.clusterVersion,
        clusterLogIds,
        adoptPhoto,
        photoUrl: activePhotoUrl || selectedCluster.primaryPhoto,
        sourceLogId: selectedCluster.photos.find((photo: StrangerPhoto) => photo.photoSnapshot === activePhotoUrl)?.logId,
      };

      const res = await operatorJsonFetch<{
        success: boolean;
        employee: Employee;
        updatedLogsCount: number;
        adjudicatedLogsCount: number;
        recognitionReady: boolean;
        partialFailure: boolean;
        faceTemplateRejected?: string | null;
      }>("/api/strangers/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.data?.success || !res.data.employee) {
        throw new Error((res.data as any)?.error || `HTTP ${res.status}`);
      }
      const merged: Employee = res.data.employee;
      const adjudicatedCount = res.data.adjudicatedLogsCount ?? 0;

      if (res.data.recognitionReady) soundEffects.playSuccess();
      onEmployeeAdded(merged);
      if (onLogsUpdated) onLogsUpdated();

      // Drop the card immediately - the cluster now has an owner.
      const resolvedId = selectedCluster.clusterId;
      setClusters((prev) => prev.filter((c) => c.clusterId !== resolvedId));

      setSuccessToast(
        res.data.recognitionReady
          ? `Đã adjudicate ${adjudicatedCount} lượt quét cho ${merged.name} và tạo mẫu nhận diện.`
          : `Đã adjudicate ${adjudicatedCount} lượt quét cho ${merged.name}; chưa tạo được mẫu nhận diện nên quyền mở cửa chưa được kích hoạt.`
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

  const [dismissingId, setDismissingId] = useState<string | null>(null);

  // Reject a cluster: it disappears from the panel without becoming an employee.
  // Logs are kept; the server retires the cluster and its sightings. Falls back to
  // hiding it locally for this session when the API is unreachable.
  const handleDismissCluster = async (cluster: StrangerCluster) => {
    const ok = window.confirm(
      `Từ chối ${cluster.photos.length} ảnh của "${cluster.label}"?\nCụm ảnh sẽ bị ẩn khỏi danh sách (không tạo nhân viên, nhật ký vẫn được giữ).`
    );
    if (!ok) return;
    setDismissingId(cluster.clusterId);
    try {
      const res = await operatorJsonFetch<{ success: boolean; error?: string }>("/api/strangers/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clusterId: cluster.clusterId,
          clusterVersion: cluster.clusterVersion,
          clusterLogIds: cluster.photos.map((p) => p.logId),
          reason: "Từ chối thủ công từ bảng người lạ",
        }),
      });
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      setClusters((prev) => prev.filter((c) => c.clusterId !== cluster.clusterId));
      if (selectedCluster?.clusterId === cluster.clusterId) setSelectedCluster(null);
      setDismissingId(null);
      setSuccessToast(`Đã từ chối và ẩn cụm ảnh "${cluster.label}"`);
      setTimeout(() => setSuccessToast(null), 3500);
    } catch (err: any) {
      alert(`Từ chối cụm ảnh thất bại: ${err?.message || "Lỗi máy chủ"}`);
    } finally {
      setDismissingId(null);
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
        clusterVersion: selectedCluster.clusterVersion,
        clusterLogIds: selectedCluster.photos.map((p) => p.logId),
        sourceLogId: selectedCluster.photos.find((photo: StrangerPhoto) => photo.photoSnapshot === activePhotoUrl)?.logId,
      };

      const res = await operatorJsonFetch<{
        success: boolean;
        employee: Employee;
        updatedLogsCount: number;
        adjudicatedLogsCount: number;
        recognitionReady: boolean;
        partialFailure: boolean;
        faceTemplateRejected?: string | null;
      }>(
        "/api/strangers/quick-register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok || !res.data?.success || !res.data.employee) {
        throw new Error((res.data as any)?.error || `HTTP ${res.status}`);
      }
      const createdEmployee: Employee = res.data.employee;

      if (res.data.recognitionReady) soundEffects.playSuccess();
      onEmployeeAdded(createdEmployee);
      if (onLogsUpdated) onLogsUpdated();

      setSuccessToast(
        res.data.recognitionReady
          ? `Đã tạo ${createdEmployee.name} (${createdEmployee.employeeCode}) và mẫu nhận diện đã sẵn sàng.`
          : `Đã tạo hồ sơ ${createdEmployee.name} (${createdEmployee.employeeCode}), nhưng chưa có mẫu nhận diện; quyền mở cửa chưa được kích hoạt.`
      );

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
              onClick={() => loadClusters("", [])}
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

        {/* Deep-link miss notice (log id no longer belongs to any cluster) */}
        {preselectMissNotice && (
          <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-2.5 text-amber-900 text-xs animate-in slide-in-from-top duration-300">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span className="flex-1 leading-relaxed">{preselectMissNotice}</span>
            <button
              id="btn-dismiss-preselect-notice"
              type="button"
              onClick={() => setPreselectMissNotice(null)}
              title="Đóng thông báo"
              className="p-1 rounded-lg text-amber-600 hover:text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
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
              Nhấp <strong>"Khai Báo Nhanh"</strong> để tạo hồ sơ và thử enrollment. Quyền nhận diện chỉ sẵn sàng khi máy chủ xác nhận đã tạo mẫu khuôn mặt.
            </div>
          </div>

          {error ? (
            <div className="py-12 text-center bg-rose-50 rounded-3xl border border-rose-200">
              <AlertTriangle className="w-8 h-8 text-rose-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-rose-900">Không tải được dữ liệu người lạ</p>
              <p className="text-xs text-rose-700 mt-1">{error}</p>
              <button type="button" onClick={() => loadClusters(currentCursor, cursorHistory)}
                className="mt-4 px-4 py-2 rounded-xl bg-white border border-rose-200 text-xs font-semibold text-rose-700">
                Thử lại
              </button>
            </div>
          ) : loading ? (
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
                            {cluster.similarityScore !== null && (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                                <Sparkles className="w-3 h-3" />
                                {cluster.similarityScore}% trùng khớp
                              </span>
                            )}
                            {cluster.estimatedGender && (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700">
                                {cluster.estimatedGender}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{cluster.notes}</p>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-2">
                        <button
                          id={`btn-dismiss-cluster-${cluster.clusterId}`}
                          type="button"
                          onClick={() => handleDismissCluster(cluster)}
                          disabled={dismissingId === cluster.clusterId}
                          title="Từ chối ảnh người lạ - ẩn khỏi danh sách, không tạo nhân viên"
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 transition-colors disabled:opacity-50"
                        >
                          <UserX className="w-3.5 h-3.5" />
                          <span>{dismissingId === cluster.clusterId ? "Đang ẩn..." : "Từ chối ảnh"}</span>
                        </button>
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
                              <ProtectedImage
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
                                      <ProtectedImage
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
                                <ProtectedImage
                                  src={activePhotoUrl || cluster.primaryPhoto}
                                  alt="Ảnh người lạ"
                                  className="w-10 h-10 rounded-lg object-cover bg-slate-200"
                                />
                                <ArrowRight className="w-4 h-4 text-emerald-600 shrink-0" />
                                <ProtectedImage
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
                              <p className="text-xs text-slate-600">
                                Adjudication luôn giữ nguyên sự kiện DENIED và trạng thái khóa vật lý.
                              </p>
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

                          <div className="sm:col-span-2 md:col-span-3 text-xs text-slate-600">
                            Adjudication luôn giữ nguyên lịch sử DENIED và trạng thái khóa vật lý.
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
                                <span>Lưu hồ sơ &amp; Thử tạo mẫu nhận diện</span>
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
              <div className="flex items-center justify-between pt-2">
                <button
                  id="btn-prev-stranger-page"
                  type="button"
                  disabled={loading || cursorHistory.length === 0}
                  onClick={() => {
                    const history = cursorHistory.slice(0, -1);
                    loadClusters(cursorHistory[cursorHistory.length - 1] || "", history);
                  }}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold disabled:opacity-40"
                >
                  Trang trước
                </button>
                <button
                  id="btn-next-stranger-page"
                  type="button"
                  disabled={loading || !nextCursor}
                  onClick={() => nextCursor && loadClusters(nextCursor, [...cursorHistory, currentCursor])}
                  className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold disabled:opacity-40"
                >
                  Trang sau
                </button>
              </div>
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
            <ProtectedImage
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

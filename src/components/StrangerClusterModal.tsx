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
  ZoomIn,
  ExternalLink,
  Lightbulb,
  Focus,
  Scissors,
  EyeOff,
  RotateCcw,
} from "lucide-react";
import { StrangerCluster, StrangerClusterSuggestion, StrangerPhoto, Employee, AccessLog } from "../types";
import { readSuggestion, suggestionAsEmployee, suggestionMergeLabel, suggestionText } from "../utils/accuracyUi";
import { normalizeApiAssetUrl, operatorJsonFetch } from "../utils/api";
import { ProtectedImage } from "./ProtectedImage";
import { FaceImage, FaceThumb, ImageZoomDialog } from "./FaceImage";
import { MergeCompareDialog } from "./MergeCompareDialog";
import { compareSuggestion } from "../utils/mergeCompare";
import { orgChoice, orgOptions, orgPlaceholder, useOrgCatalog } from "../utils/orgCatalog";
import { soundEffects } from "../utils/audio";
import { templateRejectReason } from "../utils/templateReject";
import { employeeAvatarSrc, employeeInitials } from "../utils/employeeAvatar";
import { SharpnessLabeler } from "./SharpnessLabeler";
import {
  ClusterEditAction,
  ClusterEditUndo,
  clusterEditRequest,
  clusterEditSuccessText,
  splitUndoRequest,
  toggleObservation,
} from "../utils/clusterEdit";
import {
  defaultActiveObservationId,
  findPhotoByObservationId,
  frameLinkPath,
  observationIdOf,
  photoForSnapshot,
  photoMatchesTarget,
  preselectTarget,
  resolvePayloadIds,
} from "../utils/strangerPhotos";
import {
  BLUR_EXPLAINER,
  BLUR_REPORT_HINT,
  BLUR_WITHDRAW_HINT,
  applyBlurState,
  blurReportRequest,
  blurReportSuccessText,
  canBlurReport,
  isBlurReported,
  readBlurReportResult,
} from "../utils/blurReports";
import { hasRole, useOperatorSession } from "../utils/session";

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
  /**
   * Optional per-face deep link (`#strangers/face/<faceId>`, plan section 4).
   * Takes precedence over `initialPreselectedLogId`; resolved through
   * `/api/strangers/lookup?faceId=` when the face is not on the loaded page.
   * App does not pass it yet.
   */
  initialPreselectedFaceId?: string | null;
}

/** Why no template was made from the chosen photo (leading space, or empty). */
export function templateRejectHint(reason?: string | null): string {
  const text = templateRejectReason(reason);
  return text ? ` ${text}` : "";
}

/**
 * The best-matching employee for a group (plan 2026-09-29 C1/C2). A hint for the
 * operator's merge, worded as a possibility and never as a result: the operator
 * still picks "Gộp vào ..." and confirms in the merge form. Nothing here decides
 * anything.
 */
const SuggestionBox: React.FC<{
  clusterId: string;
  suggestion: StrangerClusterSuggestion;
  onMerge: () => void;
  /** Already pre-selected in the merge form: show the hint without the button. */
  selected?: boolean;
  compact?: boolean;
}> = ({ clusterId, suggestion, onMerge, selected = false, compact = false }) => (
  <div
    className={`flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/70 ${compact ? "p-2.5" : "p-3"}`}
    data-testid={`stranger-suggestion-${clusterId}`}
  >
    <Lightbulb className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="text-xs text-sky-900">
        <span className="font-semibold">Gợi ý:</span> {suggestionText(suggestion)}
      </p>
      <p className="text-[10px] text-sky-800/80">
        Chỉ là gợi ý từ độ giống với mẫu đã có, không phải kết luận - bạn xem ảnh và xác nhận trước khi gộp.
      </p>
    </div>
    {selected ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5" /> đã chọn trong biểu mẫu gộp
      </span>
    ) : (
      <button
        type="button"
        id={`btn-merge-suggestion-${clusterId}`}
        onClick={onMerge}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 transition-colors shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-500"
        title="Mở so sánh ảnh với nhân viên này; chỉ gộp khi bạn bấm Xác nhận gộp."
      >
        <Link2 className="w-3.5 h-3.5" />
        <span>{suggestionMergeLabel(suggestion)}</span>
      </button>
    )}
  </div>
);

export const StrangerClusterModal: React.FC<StrangerClusterModalProps> = ({
  isOpen,
  onClose,
  onEmployeeAdded,
  onLogsUpdated,
  initialPreselectedPhoto,
  initialPreselectedLogId,
  initialPreselectedFaceId,
}) => {
  const [clusters, setClusters] = useState<StrangerCluster[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<StrangerCluster | null>(null);
  // The chosen tile, by observation id: two face tiles of one frame share a logId
  // and must stay distinguishable.
  const [activeObservationId, setActiveObservationId] = useState<string>("");
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
  // Owner 2026-10-04: every merge first opens the photo comparison; the merge
  // request is sent only from its "Xác nhận gộp".
  const [compareOpen, setCompareOpen] = useState<boolean>(false);

  // --- Blur reports (a label for tuning the blur filter; the photo is never deleted or hidden) ---
  // The toggle is a courtesy for operator/admin; the server checks the role on every request.
  const canReportBlur = hasRole(useOperatorSession(), "operator");
  // Group editing (split / take photos out): operator and admin, same as the blur toggle.
  const canEditClusters = canReportBlur;
  const [showSharpnessLabeler, setShowSharpnessLabeler] = useState(false);
  const [editingClusterId, setEditingClusterId] = useState<string | null>(null);
  const [editSelection, setEditSelection] = useState<string[]>([]);
  const [editPending, setEditPending] = useState(false);
  const [editNotice, setEditNotice] = useState<{ kind: "success" | "error"; text: string; undo?: ClusterEditUndo } | null>(null);
  const [blurPending, setBlurPending] = useState<Record<string, boolean>>({});
  const [blurNotice, setBlurNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // Quick department options
  // Same managed catalog as the registration form; the server refuses anything else.
  const orgCatalog = useOrgCatalog();
  const departmentOptions = orgOptions(orgCatalog.departments);
  const positionOptions = orgOptions(orgCatalog.positions);
  useEffect(() => {
    setDepartment((current) => orgChoice(departmentOptions, current));
    setPosition((current) => orgChoice(positionOptions, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentOptions.join("\n"), positionOptions.join("\n")]);
  // The modal stays mounted while closed: fetch the catalog again on every open,
  // so a failed first load (signed out at page load) or a newly added entry
  // never leaves the lists stale.
  useEffect(() => {
    if (isOpen) void orgCatalog.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Deep-link target: a face id (per-face records) or an access-log id.
  const target = preselectTarget(initialPreselectedFaceId, initialPreselectedLogId);
  const targetLabel = (t: NonNullable<typeof target>) =>
    t.kind === "face" ? `khuôn mặt ${t.id}` : `lượt quét ${t.id}`;

  /**
   * Selects the cluster addressed by the caller: either by photo (in-app click),
   * by face id, or by access-log id (deep link from a chat webhook alert).
   * A log can hold several face tiles; the first one found is selected.
   */
  const applyPreselection = (list: StrangerCluster[]) => {
    if (initialPreselectedPhoto) {
      for (const cluster of list) {
        const photo = photoForSnapshot(cluster.photos, initialPreselectedPhoto);
        if (photo) {
          setPreselectMissNotice(null);
          handleOpenRegister(cluster, observationIdOf(photo));
          return;
        }
      }
    }

    if (!target) return;

    for (const cluster of list) {
      const photo = cluster.photos.find((p) => photoMatchesTarget(p, target));
      if (photo) {
        setPreselectMissNotice(null);
        handleOpenRegister(cluster, observationIdOf(photo));
        return;
      }
    }

    // Already registered, merged or dismissed: keep listing the rest, just say so.
    setPreselectMissNotice(
      `Không tìm thấy cụm ảnh cho ${targetLabel(target)} (có thể đã được xử lý hoặc từ chối).`
    );
  };

  // Fetch one bounded authoritative page. Deep links use the lookup endpoint so
  // an observation outside the current page is never misreported as processed.
  const loadClusters = async (cursor = "", history: string[] = []) => {
    setLoading(true);
    setError(null);
    setPreselectMissNotice(null);
    setBlurNotice(null);
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

      const localMatch = target && res.data.clusters.some((cluster) =>
        cluster.photos.some((photo) => photoMatchesTarget(photo, target)));
      if (target && !localMatch) {
        const lookupUrl = target.kind === "face"
          ? `/api/strangers/lookup?faceId=${encodeURIComponent(target.id)}`
          : `/api/strangers/lookup?logId=${encodeURIComponent(target.id)}`;
        const lookup = await operatorJsonFetch<{ success: boolean; cluster?: StrangerCluster; status?: string; error?: string }>(lookupUrl);
        if (lookup.ok && lookup.data?.cluster) {
          const cluster = lookup.data.cluster;
          setClusters((items: StrangerCluster[]) => items.some((item: StrangerCluster) => item.clusterId === cluster.clusterId) ? items : [cluster, ...items]);
          setPreselectMissNotice(null);
          const photo = cluster.photos.find((p) => photoMatchesTarget(p, target));
          handleOpenRegister(cluster, photo ? observationIdOf(photo) : undefined);
        } else if (lookup.status === 404 || lookup.status === 410) {
          setPreselectMissNotice(lookup.data?.error || `Không tìm thấy ${targetLabel(target)}.`);
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
  }, [isOpen, initialPreselectedLogId, initialPreselectedFaceId]);

  const handleOpenRegister = (cluster: StrangerCluster, preferredObservationId?: string) => {
    setEditingClusterId(null);
    setEditSelection([]);
    setSelectedCluster(cluster);
    setActiveObservationId(defaultActiveObservationId(cluster, preferredObservationId));
    // Auto-suggest next employee code
    const nextNum = Math.floor(4000 + Math.random() * 900);
    setEmployeeCode(`NV-${nextNum}`);
    setName(cluster.suggestedName ? cluster.suggestedName.split("(")[0].trim() : "");
    setPosition((current) => orgChoice(positionOptions, positionOptions.includes("Chuyên viên") ? "Chuyên viên" : current));
    setAccessLevel("ALL_ACCESS");
    // Reset the merge panel so a previous cluster's pick never leaks into this one.
    setFormMode("CREATE");
    setMergeTarget(null);
    setEmployeeQuery("");
    setEmployeeResults([]);
    setAdoptPhoto(false);
    setCompareOpen(false);
  };

  /**
   * "Gộp vào <name>": open the resolve panel in merge mode with the suggested
   * employee pre-selected. The roster search runs on the code so the real record
   * (photo, department) replaces the placeholder; the operator still confirms.
   */
  const handleOpenMergeSuggestion = (cluster: StrangerCluster, suggestion: StrangerClusterSuggestion) => {
    handleOpenRegister(cluster);
    setFormMode("MERGE");
    setMergeTarget(suggestionAsEmployee(suggestion));
    setEmployeeQuery(suggestion.employeeCode || suggestion.name);
    // Straight to the photo comparison; nothing is sent until "Xác nhận gộp".
    setCompareOpen(true);
  };

  // Search the authoritative server roster; failures stay failures rather than local success.
  const searchEmployees = async (q: string) => {
    setSearchingEmployees(true);
    try {
      const res = await operatorJsonFetch<{ success: boolean; employees: Employee[]; error?: string }>(
        `/api/strangers/search-employees?q=${encodeURIComponent(q)}`
      );
      if (res.ok && res.data?.employees) {
        const found = res.data.employees;
        setEmployeeResults(found);
        // A suggestion pre-selects a placeholder; swap in the roster's record when it turns up.
        setMergeTarget((current) => (current ? found.find((emp) => emp.id === current.id) ?? current : current));
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

  // The merge form's submit only opens the comparison; sendMerge runs from its "Xác nhận gộp".
  const handleSubmitMerge = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCluster) return;
    if (!mergeTarget) {
      alert("Vui lòng chọn nhân viên cần gộp cụm ảnh này vào");
      return;
    }
    setCompareOpen(true);
  };

  // The existing merge request, unchanged; on failure the comparison stays open.
  const sendMerge = async () => {
    if (!selectedCluster || !mergeTarget || submitting) return;

    setSubmitting(true);
    try {
      const activePhoto = findPhotoByObservationId(selectedCluster.photos, activeObservationId);
      const payload = {
        employeeId: mergeTarget.id,
        employeeCode: mergeTarget.employeeCode,
        clusterId: selectedCluster.clusterId,
        clusterVersion: selectedCluster.clusterVersion,
        adoptPhoto,
        photoUrl: activePhoto?.photoSnapshot || selectedCluster.primaryPhoto,
        // clusterLogIds + clusterObservationIds, sourceLogId + sourceObservationId
        ...resolvePayloadIds(selectedCluster.photos, activePhoto),
      };

      const res = await operatorJsonFetch<{
        success: boolean;
        employee: Employee;
        updatedLogsCount: number;
        adjudicatedLogsCount: number;
        recognitionReady: boolean;
        partialFailure: boolean;
        /** The template made from the chosen photo; null when none was added. */
        faceTemplate?: { id: string } | null;
        faceTemplateRejected?: string | null;
        /** A repeated request: the cluster was already merged, nothing new was made. */
        idempotentReplay?: boolean;
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
        res.data.faceTemplate
          ? `Đã adjudicate ${adjudicatedCount} lượt quét cho ${merged.name} và tạo mẫu nhận diện.`
          : res.data.idempotentReplay && res.data.recognitionReady
            ? `Cụm này đã được gộp cho ${merged.name} trước đó.`
          : res.data.recognitionReady
            ? `Đã adjudicate ${adjudicatedCount} lượt quét cho ${merged.name}; không thêm mẫu từ ảnh này.${templateRejectHint(res.data.faceTemplateRejected)} ${merged.name} vẫn được nhận diện bằng các mẫu hiện có.`
            : `Đã adjudicate ${adjudicatedCount} lượt quét cho ${merged.name}; chưa tạo được mẫu nhận diện nên quyền mở cửa chưa được kích hoạt.${templateRejectHint(res.data.faceTemplateRejected)}`
      );
      setCompareOpen(false);
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
          ...resolvePayloadIds(cluster.photos),
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

  const startClusterEdit = (cluster: StrangerCluster) => {
    if (selectedCluster?.clusterId === cluster.clusterId) setSelectedCluster(null);
    setEditingClusterId(cluster.clusterId);
    setEditSelection([]);
    setEditNotice(null);
  };
  const stopClusterEdit = () => {
    setEditingClusterId(null);
    setEditSelection([]);
  };

  /**
   * Split the picked photos into their own group, or take them out of the
   * group. The server records it (append-only) and returns what undoes it; the
   * list reloads because the groups change.
   */
  const handleClusterEdit = async (action: ClusterEditAction, cluster: StrangerCluster) => {
    const count = editSelection.length;
    if (!count || editPending) return;
    if (action === "split" && count >= cluster.photos.length) return;
    if (action === "remove" && !window.confirm(
      `Bỏ ${count} ảnh khỏi "${cluster.label}"?\nẢnh sẽ được ẩn khỏi danh sách người lạ (không bị xóa, nhật ký vẫn giữ nguyên) và có thể hoàn tác.`
    )) return;
    setEditPending(true);
    setEditNotice(null);
    try {
      const { url, init } = clusterEditRequest(action, cluster, editSelection);
      const res = await operatorJsonFetch<{ success: boolean; error?: string; undo?: ClusterEditUndo }>(url, init);
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      setEditNotice({ kind: "success", text: clusterEditSuccessText(action, count), undo: res.data.undo });
      stopClusterEdit();
      loadClusters(currentCursor, cursorHistory);
    } catch (err: any) {
      setEditNotice({ kind: "error", text: `${action === "split" ? "Tách cụm" : "Bỏ ảnh khỏi cụm"} thất bại: ${err?.message || "Lỗi máy chủ"}` });
    } finally {
      setEditPending(false);
    }
  };

  /** Undo the last edit, or re-join a split group ("Gộp lại"). */
  const handleUndoClusterEdit = async (undo: ClusterEditUndo, doneText: string) => {
    if (editPending) return;
    setEditPending(true);
    try {
      const { url, init } = splitUndoRequest(undo);
      const res = await operatorJsonFetch<{ success: boolean; error?: string }>(url, init);
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      setEditNotice({ kind: "success", text: doneText });
      loadClusters(currentCursor, cursorHistory);
    } catch (err: any) {
      setEditNotice({ kind: "error", text: `Hoàn tác thất bại: ${err?.message || "Lỗi máy chủ"}` });
    } finally {
      setEditPending(false);
    }
  };

  /**
   * "Báo ảnh mờ" / "Bỏ báo mờ" on one per-face photo. The badge changes only
   * after the server confirms (2xx); a refusal or transport failure leaves it as
   * it was and shows the server's error text as-is. Nothing is deleted or hidden.
   */
  const handleToggleBlurReport = async (photo: StrangerPhoto) => {
    if (!canBlurReport(photo) || blurPending[photo.faceId]) return;
    const faceId = photo.faceId;
    const report = !isBlurReported(photo);
    setBlurPending((prev) => ({ ...prev, [faceId]: true }));
    setBlurNotice(null);
    try {
      const { url, init } = blurReportRequest(faceId, report);
      const res = await operatorJsonFetch(url, init);
      const outcome = readBlurReportResult(faceId, res);
      // A refusal or transport failure: the badge stays as it was.
      if ("error" in outcome) {
        setBlurNotice({ kind: "error", text: outcome.error });
        return;
      }
      setClusters((prev) => applyBlurState(prev, faceId, outcome.blurReported));
      setSelectedCluster((prev) => (prev ? applyBlurState([prev], faceId, outcome.blurReported)[0] : prev));
      setBlurNotice({ kind: "success", text: blurReportSuccessText(outcome.blurReported) });
    } catch (err: any) {
      setBlurNotice({ kind: "error", text: err?.message || "Lỗi không xác định" });
    } finally {
      setBlurPending((prev) => {
        const next = { ...prev };
        delete next[faceId];
        return next;
      });
    }
  };

  // A confirmation fades after a few seconds; an error stays until dismissed.
  useEffect(() => {
    if (blurNotice?.kind !== "success") return;
    const timer = setTimeout(() => setBlurNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [blurNotice]);

  const handleSubmitQuickRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert("Vui lòng nhập họ và tên nhân viên");
      return;
    }
    if (!selectedCluster) return;

    setSubmitting(true);
    try {
      const activePhoto = findPhotoByObservationId(selectedCluster.photos, activeObservationId);
      const payload = {
        name: name.trim(),
        employeeCode: employeeCode.trim() || `NV-${Math.floor(1000 + Math.random() * 9000)}`,
        department: department.trim(),
        position: position.trim(),
        accessLevel,
        photoUrl: activePhoto?.photoSnapshot || selectedCluster.primaryPhoto,
        clusterId: selectedCluster.clusterId,
        clusterVersion: selectedCluster.clusterVersion,
        // clusterLogIds + clusterObservationIds, sourceLogId + sourceObservationId
        ...resolvePayloadIds(selectedCluster.photos, activePhoto),
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
          : `Đã tạo hồ sơ ${createdEmployee.name} (${createdEmployee.employeeCode}), nhưng chưa có mẫu nhận diện; quyền mở cửa chưa được kích hoạt.${templateRejectHint(res.data.faceTemplateRejected)}`
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
            {canReportBlur && (
              <button
                id="btn-open-sharpness-labeler"
                type="button"
                onClick={() => setShowSharpnessLabeler(true)}
                title="Gán nhãn Rõ / Mờ cho ảnh người lạ để tinh chỉnh bộ lọc ảnh mờ"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Focus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Gán nhãn độ nét</span>
              </button>
            )}
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

        {/* Blur report result: always mounted so screen readers hear the change */}
        <div
          id="blur-report-notice"
          aria-live={blurNotice?.kind === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {blurNotice && (
            <div
              className={`mx-6 mt-4 p-3 rounded-2xl border flex items-start gap-2.5 text-xs animate-in slide-in-from-top duration-300 ${
                blurNotice.kind === "error"
                  ? "bg-rose-50 border-rose-200 text-rose-900"
                  : "bg-emerald-50 border-emerald-200 text-emerald-900"
              }`}
            >
              {blurNotice.kind === "error" ? (
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              )}
              <span className="flex-1 leading-relaxed">
                {blurNotice.kind === "error" && <span className="font-semibold">Không lưu được báo ảnh mờ: </span>}
                {blurNotice.text}
              </span>
              <button
                id="btn-dismiss-blur-notice"
                type="button"
                onClick={() => setBlurNotice(null)}
                aria-label="Đóng thông báo"
                title="Đóng thông báo"
                className="p-1 rounded-lg opacity-70 hover:opacity-100 hover:bg-white/60 transition-colors shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Group edit result (split / take out / undo), with an undo button */}
        <div id="cluster-edit-notice" aria-live={editNotice?.kind === "error" ? "assertive" : "polite"} aria-atomic="true">
          {editNotice && (
            <div
              className={`mx-6 mt-4 p-3 rounded-2xl border flex items-center gap-2.5 text-xs animate-in slide-in-from-top duration-300 ${
                editNotice.kind === "error" ? "bg-rose-50 border-rose-200 text-rose-900" : "bg-emerald-50 border-emerald-200 text-emerald-900"
              }`}
            >
              {editNotice.kind === "error" ? (
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
              )}
              <span className="flex-1 leading-relaxed">{editNotice.text}</span>
              {editNotice.undo && (
                <button
                  id="btn-undo-cluster-edit"
                  type="button"
                  disabled={editPending}
                  onClick={() => handleUndoClusterEdit(editNotice.undo!, "Đã hoàn tác.")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-300 bg-white font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  Hoàn tác
                </button>
              )}
              <button
                id="btn-dismiss-cluster-edit-notice"
                type="button"
                onClick={() => setEditNotice(null)}
                aria-label="Đóng thông báo"
                title="Đóng thông báo"
                className="p-1 rounded-lg opacity-70 hover:opacity-100 hover:bg-white/60 transition-colors shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

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
                const activePhoto = isSelected
                  ? findPhotoByObservationId(cluster.photos, activeObservationId)
                  : undefined;
                const activeFramePath = activePhoto ? frameLinkPath(activePhoto) : null;
                const suggestion = readSuggestion(cluster.suggestion);
                const suggestionSelected = !!suggestion && isSelected && formMode === "MERGE" && mergeTarget?.id === suggestion.employeeId;
                const isEditing = editingClusterId === cluster.clusterId;
                const splitInfo = (cluster as StrangerCluster & { split?: ClusterEditUndo & { observationIds: string[] } }).split;

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
                            {splitInfo && (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-50 text-violet-700 border border-violet-200 flex items-center gap-1">
                                <Scissors className="w-3 h-3" aria-hidden="true" />
                                Đã tách thủ công
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
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {canEditClusters && splitInfo && !isEditing && (
                          <button
                            id={`btn-rejoin-split-${cluster.clusterId}`}
                            type="button"
                            disabled={editPending}
                            onClick={() => handleUndoClusterEdit(
                              { clusterId: splitInfo.clusterId, clusterObservationIds: splitInfo.observationIds },
                              "Đã gộp lại cụm đã tách.",
                            )}
                            title="Bỏ thao tác tách: các ảnh này được gom cụm tự động trở lại"
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold border border-violet-200 text-violet-700 bg-white hover:bg-violet-50 transition-colors disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Gộp lại</span>
                          </button>
                        )}
                        {canEditClusters && !isSelected && (
                          <button
                            id={`btn-edit-cluster-${cluster.clusterId}`}
                            type="button"
                            onClick={() => (isEditing ? stopClusterEdit() : startClusterEdit(cluster))}
                            aria-pressed={isEditing}
                            title="Chọn ảnh để tách thành cụm mới hoặc bỏ khỏi cụm"
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                              isEditing ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <Scissors className="w-3.5 h-3.5" />
                            <span>{isEditing ? "Xong" : "Sửa cụm"}</span>
                          </button>
                        )}
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

                    {/* Best-matching employee, if the server found one (a hint, not a decision) */}
                    {suggestion && (
                      <div className="mt-3">
                        <SuggestionBox
                          clusterId={cluster.clusterId}
                          suggestion={suggestion}
                          selected={suggestionSelected}
                          onMerge={() => handleOpenMergeSuggestion(cluster, suggestion)}
                        />
                      </div>
                    )}

                    {/* Photos Gallery of the Same Stranger */}
                    <div className="mt-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 text-slate-500" />
                          {cluster.photos.length} hình chụp nhận diện tương đồng của cùng người này:
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {isEditing ? "(Nhấp vào ảnh để chọn / bỏ chọn)" : "(Nhấp vào ảnh để phóng to hoặc chọn làm avatar chính)"}
                        </span>
                      </div>

                      {isEditing && (
                        <div
                          id={`cluster-edit-toolbar-${cluster.clusterId}`}
                          className="mb-3 p-2.5 rounded-xl border border-indigo-200 bg-indigo-50/60 flex flex-wrap items-center gap-2 text-xs"
                        >
                          <span className="font-semibold text-indigo-900 mr-auto" aria-live="polite">
                            Đã chọn {editSelection.length}/{cluster.photos.length} ảnh
                          </span>
                          <button
                            id={`btn-split-cluster-${cluster.clusterId}`}
                            type="button"
                            disabled={editPending || editSelection.length === 0 || editSelection.length >= cluster.photos.length}
                            onClick={() => handleClusterEdit("split", cluster)}
                            title={editSelection.length >= cluster.photos.length ? "Phải để lại ít nhất một ảnh trong cụm cũ" : "Các ảnh đã chọn là người khác: tách thành cụm riêng"}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
                          >
                            <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                            Tách thành cụm mới
                          </button>
                          <button
                            id={`btn-remove-photos-${cluster.clusterId}`}
                            type="button"
                            disabled={editPending || editSelection.length === 0}
                            onClick={() => handleClusterEdit("remove", cluster)}
                            title="Ẩn các ảnh đã chọn khỏi danh sách người lạ (không xóa, có thể hoàn tác)"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 disabled:opacity-40"
                          >
                            <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                            Bỏ khỏi cụm
                          </button>
                        </div>
                      )}

                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {cluster.photos.map((photo, pIdx) => {
                          // Several tiles can share one logId (two people in one frame):
                          // the observation id is the only per-tile identity.
                          const tileId = observationIdOf(photo);
                          const isPrimary = isSelected && activeObservationId === tileId;
                          const framePath = frameLinkPath(photo);
                          // Blur report: per-face photos only; the badge for everyone, the toggle for operator/admin.
                          const blurReported = isBlurReported(photo);
                          const showBlurToggle = canReportBlur && canBlurReport(photo);
                          const blurBusy = canBlurReport(photo) && !!blurPending[photo.faceId];
                          const isPicked = isEditing && editSelection.includes(tileId);

                          return (
                            <div
                              key={tileId}
                              id={`photo-card-${cluster.clusterId}-${pIdx}`}
                              data-observation-id={tileId}
                              className={`relative group aspect-square rounded-xl overflow-hidden border bg-slate-900 transition-all ${
                                isPicked
                                  ? "ring-2 ring-rose-500 border-rose-500 shadow-md"
                                  : isPrimary
                                  ? "ring-2 ring-indigo-600 border-indigo-600 shadow-md"
                                  : "border-slate-200 hover:border-slate-300 hover:shadow-xs"
                              }`}
                            >
                              <FaceImage
                                src={photo.photoSnapshot}
                                alt={`Ảnh khuôn mặt ${pIdx + 1}`}
                                className="w-full h-full group-hover:scale-105 transition-transform duration-200"
                              />

                              {/* Whole tile: selects the avatar while registering, otherwise enlarges */}
                              <button
                                type="button"
                                onClick={() => {
                                  if (isEditing) {
                                    setEditSelection((prev) => toggleObservation(prev, tileId));
                                  } else if (isSelected) {
                                    setActiveObservationId(tileId);
                                  } else {
                                    setPreviewEnlargedPhoto(photo.photoSnapshot);
                                  }
                                }}
                                aria-pressed={isEditing ? isPicked : isSelected ? isPrimary : undefined}
                                // Not registering or editing: the zoom button below is the keyboard path; skip this duplicate.
                                tabIndex={isSelected || isEditing ? 0 : -1}
                                aria-hidden={isSelected || isEditing ? undefined : true}
                                aria-label={
                                  isEditing
                                    ? `${isPicked ? "Bỏ chọn" : "Chọn"} ảnh khuôn mặt ${pIdx + 1}`
                                    : isSelected
                                    ? `Chọn ảnh khuôn mặt ${pIdx + 1} làm ảnh chính`
                                    : `Phóng to ảnh khuôn mặt ${pIdx + 1}`
                                }
                                className="absolute inset-0 w-full h-full cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                              />

                              {/* Keyboard-reachable zoom (the tile click selects the avatar while registering) */}
                              <button
                                type="button"
                                onClick={() => setPreviewEnlargedPhoto(photo.photoSnapshot)}
                                className="absolute top-1.5 left-1.5 z-10 p-1 rounded-md bg-black/55 text-white opacity-80 hover:opacity-100 focus:opacity-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
                                aria-label={`Phóng to ảnh khuôn mặt ${pIdx + 1}`}
                                title="Phóng to"
                              >
                                <ZoomIn className="w-3 h-3" />
                              </button>

                              {/* A face tile is only the crop: the whole frame opens in a new tab */}
                              {framePath && (
                                <a
                                  href={normalizeApiAssetUrl(framePath)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="absolute top-1.5 left-8 z-10 p-1 rounded-md bg-black/55 text-white opacity-80 hover:opacity-100 focus:opacity-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
                                  aria-label={`Xem khung hình của ảnh ${pIdx + 1} (mở tab mới)`}
                                  title="Xem khung hình"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}

                              {/* Blur report toggle: a label for tuning the blur filter, the photo stays */}
                              {showBlurToggle && (
                                <button
                                  id={`btn-blur-report-${cluster.clusterId}-${pIdx}`}
                                  type="button"
                                  onClick={() => handleToggleBlurReport(photo)}
                                  disabled={blurBusy}
                                  aria-pressed={blurReported}
                                  aria-busy={blurBusy || undefined}
                                  aria-label={`Báo ảnh mờ: ảnh khuôn mặt ${pIdx + 1}`}
                                  title={blurReported ? BLUR_WITHDRAW_HINT : BLUR_REPORT_HINT}
                                  className={`absolute top-1.5 right-1.5 z-10 p-1 rounded-md text-white opacity-80 hover:opacity-100 focus:opacity-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 disabled:cursor-wait ${
                                    blurReported ? "bg-amber-500" : "bg-black/55"
                                  }`}
                                >
                                  {blurBusy ? (
                                    <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                                  ) : (
                                    <Focus className="w-3 h-3" aria-hidden="true" />
                                  )}
                                </button>
                              )}

                              {isEditing && (
                                <div
                                  aria-hidden="true"
                                  className={`pointer-events-none absolute ${showBlurToggle ? "top-8" : "top-1.5"} right-1.5 w-5 h-5 rounded-md border-2 flex items-center justify-center ${
                                    isPicked ? "bg-rose-500 border-rose-500 text-white" : "bg-black/40 border-white/80"
                                  }`}
                                >
                                  {isPicked && <Check className="w-3.5 h-3.5" />}
                                </div>
                              )}

                              {/* Primary tag badge (below the blur toggle when there is one) */}
                              {isPrimary && (
                                <div className={`pointer-events-none absolute ${showBlurToggle ? "top-8" : "top-1.5"} right-1.5 px-1.5 py-0.5 rounded-md bg-indigo-600 text-white text-[10px] font-bold shadow-xs`}>
                                  Avatar chính
                                </div>
                              )}

                              {/* Time & Door metadata overlay */}
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-1.5 text-white">
                                {blurReported && (
                                  <p className="mb-0.5">
                                    <span
                                      data-testid={`blur-badge-${cluster.clusterId}-${pIdx}`}
                                      className="inline-flex items-center gap-0.5 px-1 py-px rounded bg-amber-400 text-amber-950 text-[9px] font-bold"
                                    >
                                      <Focus className="w-2.5 h-2.5" aria-hidden="true" />
                                      Đã báo mờ
                                    </span>
                                  </p>
                                )}
                                <p className="text-[10px] font-medium truncate flex items-center gap-1">
                                  <Clock className="w-2.5 h-2.5 shrink-0" />
                                  {/* Date and seconds too, so a photo can be checked against the NVR recording */}
                                  {new Date(photo.timestamp).toLocaleString("vi-VN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                    day: "2-digit",
                                    month: "2-digit",
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
                        {/* Chosen photo: the face crop at thumbnail size (never blown up), plus its frame */}
                        {activePhoto && (
                          <div
                            id={`active-photo-${cluster.clusterId}`}
                            className="flex items-center gap-3 p-3 rounded-2xl border border-indigo-100 bg-indigo-50/40"
                          >
                            <FaceThumb
                              src={activePhoto.photoSnapshot}
                              alt="Ảnh đã chọn làm ảnh chính"
                              className="w-24 h-24 max-w-[96px] rounded-xl"
                              caption={activePhoto.doorName}
                            />
                            <div className="min-w-0 space-y-1">
                              <p className="text-xs font-semibold text-slate-900" aria-live="polite">
                                Ảnh chính: ảnh {cluster.photos.indexOf(activePhoto) + 1}/{cluster.photos.length}
                              </p>
                              <p className="text-[11px] text-slate-600">
                                {new Date(activePhoto.timestamp).toLocaleString("vi-VN")} · {activePhoto.doorName}
                              </p>
                              <p className="text-[11px] text-slate-500">
                                {activePhoto.faceId
                                  ? "Ảnh cắt khuôn mặt của người này; khung hình đầy đủ có thể có người khác."
                                  : "Ảnh toàn khung hình (bản ghi cũ)."}
                              </p>
                              {/* Blur report on the chosen face: a label, the photo is kept */}
                              {canBlurReport(activePhoto) && (canReportBlur || isBlurReported(activePhoto)) && (
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    {isBlurReported(activePhoto) && (
                                      <span
                                        id={`blur-badge-active-${cluster.clusterId}`}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300"
                                      >
                                        <Focus className="w-3 h-3" aria-hidden="true" />
                                        Đã báo mờ
                                      </span>
                                    )}
                                    {canReportBlur && (
                                      <button
                                        id={`btn-blur-report-active-${cluster.clusterId}`}
                                        type="button"
                                        onClick={() => handleToggleBlurReport(activePhoto)}
                                        disabled={!!blurPending[activePhoto.faceId]}
                                        aria-pressed={isBlurReported(activePhoto)}
                                        aria-busy={!!blurPending[activePhoto.faceId] || undefined}
                                        title={isBlurReported(activePhoto) ? BLUR_WITHDRAW_HINT : BLUR_REPORT_HINT}
                                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 disabled:cursor-wait ${
                                          isBlurReported(activePhoto)
                                            ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                                            : "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
                                        }`}
                                      >
                                        {blurPending[activePhoto.faceId] ? (
                                          <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                                        ) : (
                                          <Focus className="w-3.5 h-3.5" aria-hidden="true" />
                                        )}
                                        <span>
                                          {blurPending[activePhoto.faceId]
                                            ? "Đang lưu..."
                                            : isBlurReported(activePhoto)
                                              ? "Bỏ báo mờ"
                                              : "Báo ảnh mờ"}
                                        </span>
                                      </button>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-slate-500">{BLUR_EXPLAINER}</p>
                                </div>
                              )}
                              {activeFramePath && (
                                <a
                                  id={`link-active-frame-${cluster.clusterId}`}
                                  href={normalizeApiAssetUrl(activeFramePath)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-700 hover:text-indigo-900 underline underline-offset-2 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  <span>Xem khung hình</span>
                                  <span className="sr-only">(mở tab mới)</span>
                                </a>
                              )}
                            </div>
                          </div>
                        )}

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

                            {suggestion && (
                              <SuggestionBox
                                clusterId={`${cluster.clusterId}-merge`}
                                suggestion={suggestion}
                                selected={suggestionSelected}
                                compact
                                onMerge={() => {
                                  setMergeTarget(suggestionAsEmployee(suggestion));
                                  setEmployeeQuery(suggestion.employeeCode || suggestion.name);
                                  setCompareOpen(true);
                                }}
                              />
                            )}

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
                                      {employeeAvatarSrc(emp as Employee & { hasPhoto?: boolean }) ? (
                                        <ProtectedImage
                                          src={employeeAvatarSrc(emp as Employee & { hasPhoto?: boolean })}
                                          alt={emp.name}
                                          loading="lazy"
                                          className="w-9 h-9 rounded-lg object-cover bg-slate-200 shrink-0"
                                        />
                                      ) : (
                                        <span
                                          aria-hidden="true"
                                          className="w-9 h-9 rounded-lg bg-slate-200 text-slate-600 text-[11px] font-bold flex items-center justify-center shrink-0"
                                        >
                                          {employeeInitials(emp.name)}
                                        </span>
                                      )}
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
                                <FaceThumb
                                  src={activePhoto?.photoSnapshot || cluster.primaryPhoto}
                                  alt="Ảnh người lạ"
                                  className="w-10 h-10 rounded-lg"
                                />
                                <ArrowRight className="w-4 h-4 text-emerald-600 shrink-0" />
                                <ProtectedImage
                                  src={employeeAvatarSrc(mergeTarget as Employee & { hasPhoto?: boolean })}
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
                                title="Mở so sánh ảnh; chỉ gộp khi bạn bấm Xác nhận gộp"
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

                        {/* Creating a new record for someone who may already exist would duplicate them */}
                        {suggestion && (
                          <SuggestionBox
                            clusterId={`${cluster.clusterId}-create`}
                            suggestion={suggestion}
                            compact
                            onMerge={() => handleOpenMergeSuggestion(cluster, suggestion)}
                          />
                        )}

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
                              {departmentOptions.length === 0 && (
                                <option value="" disabled>
                                  {orgPlaceholder(orgCatalog.loading, orgCatalog.error)}
                                </option>
                              )}
                              {departmentOptions.map((d) => (
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
                            <select
                              id="input-quick-emp-position"
                              value={position}
                              onChange={(e) => setPosition(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 bg-white"
                            >
                              {positionOptions.length === 0 && (
                                <option value="" disabled>
                                  {orgPlaceholder(orgCatalog.loading, orgCatalog.error)}
                                </option>
                              )}
                              {positionOptions.map((pos) => (
                                <option key={pos} value={pos}>
                                  {pos}
                                </option>
                              ))}
                            </select>
                          </div>

                          {orgCatalog.error && (
                            <p className="col-span-full text-xs text-rose-600">
                              {orgCatalog.error}{" "}
                              <button type="button" className="underline font-semibold" onClick={() => void orgCatalog.reload()}>
                                Thử lại
                              </button>
                            </p>
                          )}

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

      {/* Photo comparison before any merge into an existing employee (sends nothing itself) */}
      {compareOpen && selectedCluster && mergeTarget && formMode === "MERGE" && (
        <MergeCompareDialog
          cluster={selectedCluster}
          activeObservationId={activeObservationId}
          employee={mergeTarget}
          suggestion={compareSuggestion(selectedCluster, mergeTarget)}
          adoptPhoto={adoptPhoto}
          submitting={submitting}
          onConfirm={() => void sendMerge()}
          onCancel={() => setCompareOpen(false)}
        />
      )}

      {/* Enlarged photo: natural size, 2x/3x for small crops, Escape/backdrop closes */}
      {previewEnlargedPhoto && (
        <ImageZoomDialog
          src={previewEnlargedPhoto}
          alt="Ảnh người lạ đã chụp"
          onClose={() => setPreviewEnlargedPhoto(null)}
        />
      )}

      {/* Face sharpness S0: labelling round (operator/admin) */}
      {showSharpnessLabeler && <SharpnessLabeler onClose={() => setShowSharpnessLabeler(false)} />}
    </div>
  );
};

/**
 * "So ảnh trước khi gộp" (owner request 2026-10-04): every merge of a stranger
 * group into an existing employee opens this comparison first. Left: the
 * group's photos. Right: the employee's registration photo, recent recognised
 * face crops at the gates and the camera frames their templates came from.
 * Nothing is sent from here: "Xác nhận gộp" hands back to the panel, which runs
 * its existing merge request; "Hủy" (also Escape / click outside) sends nothing.
 *
 * Modal: focus moves in (to "Hủy"), Tab stays inside, focus returns to the
 * opener on close. A failed picture load is shown but never blocks confirming.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Camera, Check, Clock, Layers, Lightbulb, Link2, RefreshCw, UserX, X, ZoomIn } from "lucide-react";
import type { CameraStreamsConfig, Employee, StrangerCluster, StrangerClusterSuggestion } from "../types";
import { operatorJsonFetch, safeJsonFetch } from "../utils/api";
import { gateLabelMap, gatesOf } from "../utils/gates";
import { findPhotoByObservationId, observationIdOf } from "../utils/strangerPhotos";
import {
  EMPTY_FACE_SAMPLES,
  FaceSamplesView,
  MERGE_COMPARE_CAUTION,
  employeeHeading,
  faceSamplesLoadError,
  faceSamplesUrl,
  isWeakSuggestion,
  noSamplesNotice,
  readFaceSamples,
  registrationPhotoState,
  registrationPhotoText,
  sampleCaptionParts,
  strangerPhotoCaptionParts,
  suggestionStrengthLabel,
  templateFrameCaptionParts,
} from "../utils/mergeCompare";
import { FaceImage, ImageZoomDialog } from "./FaceImage";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ZoomTarget {
  src: string;
  alt: string;
  caption?: string;
}

export interface MergeCompareViewProps {
  cluster: StrangerCluster;
  /** The panel's chosen photo (the one the merge enrols from). */
  activeObservationId: string;
  /** The photo shown large on the left (the operator can browse the group). */
  viewObservationId: string;
  employee: Employee;
  /** Only when the target is the server's suggested employee. */
  suggestion?: StrangerClusterSuggestion | null;
  adoptPhoto: boolean;
  submitting: boolean;
  samples: FaceSamplesView;
  loading: boolean;
  loadError: string | null;
  gateLabels: Readonly<Record<string, string>>;
  onViewPhoto: (observationId: string) => void;
  onZoom: (target: ZoomTarget) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  dialogRef?: React.Ref<HTMLDivElement>;
  cancelRef?: React.Ref<HTMLButtonElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

const SectionTitle: React.FC<{ children: React.ReactNode; icon?: React.ReactNode }> = ({ children, icon }) => (
  <h4 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
    {icon}
    {children}
  </h4>
);

/** A picture that opens larger on click / Enter / Space. */
const ZoomableImage: React.FC<{
  src: string;
  alt: string;
  caption?: string;
  className: string;
  onZoom: (target: ZoomTarget) => void;
  testId?: string;
}> = ({ src, alt, caption, className, onZoom, testId }) => (
  <button
    type="button"
    onClick={() => onZoom({ src, alt, caption })}
    className={`group relative block overflow-hidden rounded-xl border border-slate-200 bg-slate-900 cursor-zoom-in focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${className}`}
    aria-label={`Phóng to: ${alt}`}
    title="Bấm để xem ảnh lớn"
    data-testid={testId}
  >
    <FaceImage src={src} alt={alt} className="w-full h-full" />
    <span className="pointer-events-none absolute top-1.5 left-1.5 p-1 rounded-md bg-black/55 text-white opacity-80 group-hover:opacity-100">
      <ZoomIn className="w-3 h-3" aria-hidden="true" />
    </span>
  </button>
);

/** The dialog's markup, all state passed in (rendered statically in tests). */
export const MergeCompareView: React.FC<MergeCompareViewProps> = ({
  cluster,
  activeObservationId,
  viewObservationId,
  employee,
  suggestion,
  adoptPhoto,
  submitting,
  samples,
  loading,
  loadError,
  gateLabels,
  onViewPhoto,
  onZoom,
  onConfirm,
  onCancel,
  onRetry,
  dialogRef,
  cancelRef,
  onKeyDown,
}) => {
  const heading = employeeHeading(employee.name, employee.employeeCode);
  const viewed =
    findPhotoByObservationId(cluster.photos, viewObservationId) ??
    findPhotoByObservationId(cluster.photos, activeObservationId) ??
    cluster.photos[0];
  const viewedId = viewed ? observationIdOf(viewed) : "";
  const viewedIndex = viewed ? cluster.photos.indexOf(viewed) : -1;
  const viewedCaption = viewed ? strangerPhotoCaptionParts(viewed).join(" · ") : "";
  // JSON never carries photoUrl (server privacy rule); a stored photo loads through the protected photo route.
  const regSrc = employee.photoUrl || (samples.employee?.hasPhoto ? `/api/employees/${encodeURIComponent(employee.id)}/photo` : "");
  const regState = regSrc ? "photo" : registrationPhotoState(employee.photoUrl, samples.employee ? samples.employee.hasPhoto : null);
  const emptyNotice = !loading && !loadError ? noSamplesNotice(samples) : null;
  const statusText = loading
    ? "Đang tải ảnh đối chiếu của nhân viên…"
    : loadError
      ? ""
      : `Đã tải ${samples.samples.length} ảnh nhận diện và ${samples.templateFrames.length} khung hình đã tạo mẫu.`;

  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
      data-testid="merge-compare-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-compare-title"
        aria-describedby="merge-compare-desc"
        aria-busy={submitting || undefined}
        onKeyDown={onKeyDown}
        className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-5xl overflow-hidden flex flex-col max-h-[92vh]"
        data-testid="merge-compare-dialog"
      >
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-amber-500/10 via-rose-500/10 to-emerald-500/10 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="merge-compare-title" className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
              <span className="truncate">So ảnh trước khi gộp vào {heading}</span>
            </h3>
            <p id="merge-compare-desc" className="text-xs text-slate-700 mt-0.5">
              {cluster.photos.length} ảnh của cụm “{cluster.label}” sẽ được gán cho {heading}. Sự kiện DENIED gốc và
              trạng thái khóa vật lý vẫn được giữ nguyên.
              {adoptPhoto ? " Ảnh chính của cụm sẽ được dùng làm ảnh đại diện." : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-40 shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Hủy và quay lại bảng người lạ"
            title="Hủy"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {/* The suggestion's score and the caution: a hint, not a decision */}
          {suggestion && (
            <div
              className={`flex items-start gap-2 rounded-xl border p-3 ${
                isWeakSuggestion(suggestion.cosine) ? "border-amber-300 bg-amber-50" : "border-sky-200 bg-sky-50/70"
              }`}
              data-testid="merge-compare-suggestion"
            >
              <Lightbulb className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs text-slate-900">
                  <span className="font-semibold">Gợi ý: </span>
                  {suggestionStrengthLabel(suggestion.cosine)}
                </p>
                <p className="text-[11px] text-slate-700">{MERGE_COMPARE_CAUTION}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Left: the stranger group */}
            <section aria-labelledby="merge-compare-stranger" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/30 p-4">
              <h4 id="merge-compare-stranger" className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <UserX className="w-4 h-4 text-amber-600" aria-hidden="true" />
                Người lạ
                <span className="text-[11px] font-medium text-slate-500">({cluster.photos.length} ảnh)</span>
              </h4>

              {viewed ? (
                <div className="space-y-1.5">
                  <ZoomableImage
                    src={viewed.photoSnapshot}
                    alt={`Ảnh người lạ ${viewedIndex + 1}`}
                    caption={viewedCaption}
                    className="w-full aspect-square max-h-80"
                    onZoom={onZoom}
                    testId="merge-compare-stranger-large"
                  />
                  <p className="text-[11px] text-slate-700 flex items-center gap-1 flex-wrap" aria-live="polite">
                    <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span>
                      Ảnh {viewedIndex + 1}/{cluster.photos.length} · {viewedCaption}
                    </span>
                    {viewedId === activeObservationId && (
                      <span className="px-1.5 py-0.5 rounded-md bg-indigo-600 text-white text-[10px] font-bold">Ảnh chính</span>
                    )}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Cụm này không có ảnh.</p>
              )}

              {cluster.photos.length > 1 && (
                <div>
                  <p className="text-[11px] text-slate-500 mb-1.5">Chọn ảnh để xem lớn:</p>
                  <div className="grid grid-cols-5 sm:grid-cols-6 gap-1.5 max-h-40 overflow-y-auto" role="group" aria-label="Các ảnh của người lạ">
                    {cluster.photos.map((photo, i) => {
                      const id = observationIdOf(photo);
                      const shown = id === viewedId;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => onViewPhoto(id)}
                          aria-pressed={shown}
                          aria-label={`Xem ảnh người lạ ${i + 1}: ${strangerPhotoCaptionParts(photo).join(", ")}`}
                          title={strangerPhotoCaptionParts(photo).join(" · ")}
                          className={`relative aspect-square rounded-lg overflow-hidden border bg-slate-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                            shown ? "ring-2 ring-indigo-600 border-indigo-600" : "border-slate-200 hover:border-slate-400"
                          }`}
                        >
                          <FaceImage src={photo.photoSnapshot} alt="" className="w-full h-full" />
                          {id === activeObservationId && (
                            <span className="pointer-events-none absolute bottom-0 inset-x-0 bg-indigo-600/90 text-white text-[8px] font-bold text-center">
                              chính
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* Right: the employee */}
            <section aria-labelledby="merge-compare-employee" className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50/30 p-4">
              <div>
                <h4 id="merge-compare-employee" className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                  {heading}
                </h4>
                {(employee.department || samples.employee?.department) && (
                  <p className="text-[11px] text-slate-500">{employee.department || samples.employee?.department}</p>
                )}
              </div>

              {/* Registration photo: the roster record's, else the protected /api/employees/:id/photo */}
              <div className="space-y-1.5">
                <SectionTitle>Ảnh đăng ký</SectionTitle>
                {regState === "photo" ? (
                  <ZoomableImage
                    src={regSrc}
                    alt={`Ảnh đăng ký của ${heading}`}
                    caption="Ảnh đăng ký"
                    className="w-40 h-40"
                    onZoom={onZoom}
                    testId="merge-compare-registration"
                  />
                ) : (
                  <p className="text-xs text-slate-500 rounded-xl border border-dashed border-slate-300 bg-white p-3">
                    {registrationPhotoText(regState)}
                  </p>
                )}
              </div>

              {/* Live status of the picture load */}
              <p className="sr-only" role="status" aria-live="polite">
                {statusText}
              </p>

              {loading && (
                <div className="flex items-center gap-2 text-xs text-slate-600" aria-hidden="true">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Đang tải ảnh nhận diện tại cổng…</span>
                </div>
              )}

              {loadError && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 space-y-1.5" data-testid="merge-compare-error">
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      <span className="font-semibold">Không tải được ảnh đối chiếu: </span>
                      {loadError}
                    </span>
                  </p>
                  <p className="text-[11px] text-rose-800">Bạn vẫn có thể so với ảnh đăng ký và xác nhận gộp.</p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="px-3 py-1 rounded-lg bg-white border border-rose-200 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-rose-500"
                  >
                    Thử lại
                  </button>
                </div>
              )}

              {emptyNotice && (
                <p className="text-xs text-slate-700 rounded-xl border border-slate-200 bg-white p-3" data-testid="merge-compare-empty">
                  {emptyNotice}
                </p>
              )}

              {!loading && samples.samples.length > 0 && (
                <div className="space-y-1.5">
                  <SectionTitle icon={<Camera className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />}>
                    Ảnh nhận diện tại cổng ({samples.samples.length})
                  </SectionTitle>
                  <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {samples.samples.map((sample, i) => {
                      const parts = sampleCaptionParts(sample, gateLabels);
                      return (
                        <li key={sample.faceId} className="space-y-0.5">
                          <ZoomableImage
                            src={sample.imageUrl}
                            alt={`Ảnh nhận diện ${i + 1} của ${heading}`}
                            caption={parts.join(" · ")}
                            className="w-full aspect-square"
                            onZoom={onZoom}
                          />
                          {parts.map((part, j) => (
                            <p key={j} className={`text-[10px] leading-tight truncate ${j === 0 ? "text-slate-700" : "text-slate-500"}`}>
                              {part}
                            </p>
                          ))}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {!loading && samples.templateFrames.length > 0 && (
                <div className="space-y-1.5">
                  <SectionTitle icon={<Layers className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />}>
                    Khung hình đã tạo mẫu
                  </SectionTitle>
                  <ul className="grid grid-cols-2 gap-2">
                    {samples.templateFrames.map((frame, i) => {
                      const parts = templateFrameCaptionParts(frame);
                      return (
                        <li key={frame.logId} className="space-y-0.5">
                          <ZoomableImage
                            src={frame.imageUrl}
                            alt={`Khung hình tạo mẫu ${i + 1} của ${heading}`}
                            caption={parts.join(" · ")}
                            className="w-full aspect-video"
                            onZoom={onZoom}
                          />
                          <p className="text-[10px] leading-tight text-slate-600 truncate">{parts.join(" · ")}</p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
            data-testid="merge-compare-cancel"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-200 transition-colors disabled:opacity-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            data-testid="merge-compare-confirm"
          >
            {submitting ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>Đang gộp cụm ảnh...</span>
              </>
            ) : (
              <>
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Xác nhận gộp</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export interface MergeCompareDialogProps {
  cluster: StrangerCluster;
  activeObservationId: string;
  employee: Employee;
  suggestion?: StrangerClusterSuggestion | null;
  adoptPhoto: boolean;
  submitting: boolean;
  /** Runs the panel's existing merge request; the dialog sends nothing itself. */
  onConfirm: () => void;
  onCancel: () => void;
}

/** Loads the employee's pictures, owns focus and the enlarged view, renders MergeCompareView. */
export const MergeCompareDialog: React.FC<MergeCompareDialogProps> = ({
  cluster,
  activeObservationId,
  employee,
  suggestion,
  adoptPhoto,
  submitting,
  onConfirm,
  onCancel,
}) => {
  const [samples, setSamples] = useState<FaceSamplesView>(EMPTY_FACE_SAMPLES);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [gateLabels, setGateLabels] = useState<Record<string, string>>({});
  const [viewObservationId, setViewObservationId] = useState<string>(activeObservationId);
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // The employee's pictures; a stale answer (target changed, dialog closed) is dropped.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setSamples(EMPTY_FACE_SAMPLES);
    (async () => {
      const res = await operatorJsonFetch<unknown>(faceSamplesUrl(employee.id));
      if (!active) return;
      const error = faceSamplesLoadError(res);
      if (error) {
        setLoadError(error);
      } else {
        setSamples(readFaceSamples(res.data));
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [employee.id, reloadKey]);

  // Gate names for the crops' captions; best effort (ids fall back to "Cổng <id>").
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await safeJsonFetch<{ config?: CameraStreamsConfig }>("/api/camera-streams/config");
      if (active && res.ok) setGateLabels(gateLabelMap(gatesOf(res.data?.config)));
    })();
    return () => {
      active = false;
    };
  }, []);

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === "function" && previous.isConnected) previous.focus();
    };
  }, []);

  const cancel = useCallback(() => {
    if (!submitting) onCancel();
  }, [submitting, onCancel]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The enlarged view handles its own keys (and stops Escape) while open.
    if (zoom) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)) as HTMLElement[];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !dialogRef.current.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !dialogRef.current.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  };

  const view = (
    <>
      <MergeCompareView
        cluster={cluster}
        activeObservationId={activeObservationId}
        viewObservationId={viewObservationId}
        employee={employee}
        suggestion={suggestion}
        adoptPhoto={adoptPhoto}
        submitting={submitting}
        samples={samples}
        loading={loading}
        loadError={loadError}
        gateLabels={gateLabels}
        onViewPhoto={setViewObservationId}
        onZoom={setZoom}
        onConfirm={() => {
          if (!submitting) onConfirm();
        }}
        onCancel={cancel}
        onRetry={() => setReloadKey((k) => k + 1)}
        dialogRef={dialogRef}
        cancelRef={cancelRef}
        onKeyDown={onKeyDown}
      />
      {zoom && <ImageZoomDialog src={zoom.src} alt={zoom.alt} caption={zoom.caption} onClose={() => setZoom(null)} />}
    </>
  );
  // A portal keeps the fixed overlay out of the panel's animated / scrolling ancestors.
  return typeof document === "undefined" ? view : createPortal(view, document.body);
};

export default MergeCompareDialog;

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Crop, Loader2, Maximize, RefreshCw, Save, X } from "lucide-react";
import { GateStreamSource } from "../types";
import { apiFetch } from "../utils/api";
import {
  FULL_GATE_AREA,
  GateArea,
  NormalizedPoint,
  formatGateArea,
  gateAreaFromPercentInputs,
  gateAreaFromPoints,
  gateAreaRequestBody,
  gateAreaStyle,
  gateAreasEqual,
  gateAreaToPercentInputs,
  gateAreaToPixels,
  isFullFrame,
  nudgeGateArea,
  pointerToNormalized,
  streamGateArea,
} from "../utils/gateArea";

interface GateAreaEditorProps {
  /** Gate id ("entry", "exit" or any configured gate). */
  gateKey: string;
  gateName: string;
  stream: GateStreamSource;
  /** Receives the gate's stream list exactly as the server returned it after a save. */
  onSaved: (streams: GateStreamSource[] | null) => void;
  onClose: () => void;
}

type StillState =
  | { kind: "loading" }
  | { kind: "ready"; url: string; width: number; height: number }
  | { kind: "unavailable"; reason: string };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; text: string }
  | { kind: "not-applied"; text: string }
  | { kind: "error"; text: string };

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const STEP = 0.01;

/** Streams list from a PUT /streams/:id response, whatever envelope the server used. */
function streamsFromResponse(data: any): GateStreamSource[] | null {
  const list = data?.gate?.streams ?? data?.streams;
  return Array.isArray(list) ? (list.filter(Boolean) as GateStreamSource[]) : null;
}

/**
 * Draws the gate area (ROI) of ONE stream on ONE still frame fetched when the
 * editor opens. The still lives only in memory (a blob URL revoked on close);
 * it is never stored and never refreshed on its own. When no still can be
 * fetched, the area is edited with the numeric inputs only.
 *
 * Saving sends `{ roi: {x,y,w,h} | null }` to the existing per-stream
 * endpoint; the editor then reads the stream back from the server's answer
 * and says plainly whether the server actually kept the area.
 */
export const GateAreaEditor: React.FC<GateAreaEditorProps> = ({ gateKey, gateName, stream, onSaved, onClose }) => {
  const saved = streamGateArea(stream);
  const [area, setArea] = useState<GateArea>(saved || FULL_GATE_AREA);
  const [inputs, setInputs] = useState(() => gateAreaToPercentInputs(saved || FULL_GATE_AREA));
  const [inputError, setInputError] = useState<string | null>(null);
  const [still, setStill] = useState<StillState>({ kind: "loading" });
  const [stillAttempt, setStillAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [drag, setDrag] = useState<NormalizedPoint | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const updateArea = useCallback((next: GateArea) => {
    setArea(next);
    setInputs(gateAreaToPercentInputs(next));
    setInputError(null);
    setSaveState((s) => (s.kind === "saving" ? s : { kind: "idle" }));
  }, []);

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  // ONE still per open (or per explicit "Chụp lại"), never on a timer.
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setStill({ kind: "loading" });
    const load = async () => {
      if (stream.sourceType !== "RTSP") {
        setStill({ kind: "unavailable", reason: "Chỉ lấy được khung hình tham chiếu từ luồng RTSP." });
        return;
      }
      try {
        const res = await apiFetch(
          `/api/camera-streams/snapshot?gate=${gateKey}&stream=${encodeURIComponent(stream.id)}&t=${Date.now()}`,
          { method: "GET" }
        );
        if (!active) return;
        if (!res.ok) {
          setStill({
            kind: "unavailable",
            reason:
              res.status === 401 || res.status === 403
                ? `Máy chủ từ chối lấy khung hình (HTTP ${res.status}).`
                : `Máy chủ không trả về khung hình (HTTP ${res.status}).`,
          });
          return;
        }
        const blob = await res.blob();
        // An unreachable camera is answered with a placeholder SVG: not a frame.
        if (!/^image\/(jpeg|png|webp)$/i.test(blob.type)) {
          setStill({ kind: "unavailable", reason: "Không lấy được khung hình từ camera (camera không phản hồi)." });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("decode"));
          img.src = objectUrl;
        });
        if (!active) return;
        setStill({ kind: "ready", url: objectUrl, ...size });
      } catch {
        if (active) setStill({ kind: "unavailable", reason: "Không kết nối được máy chủ để lấy khung hình." });
      }
    };
    void load();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [gateKey, stream.id, stream.sourceType, stillAttempt]);

  const saving = saveState.kind === "saving";

  const onKeyDownDialog = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!saving) onClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)) as HTMLElement[];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onKeyDownArea = (e: React.KeyboardEvent) => {
    const map: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const dir = map[e.key];
    if (!dir) return;
    e.preventDefault();
    updateArea(nudgeGateArea(area, dir, STEP, e.shiftKey));
  };

  // ---- Drawing with a pointer (mouse, pen, touch) ----
  const pointFromEvent = (e: React.PointerEvent) =>
    stageRef.current ? pointerToNormalized(e.clientX, e.clientY, stageRef.current.getBoundingClientRect()) : null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (still.kind !== "ready" || saving) return;
    const p = pointFromEvent(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(p);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointFromEvent(e);
    if (p) updateArea(gateAreaFromPoints(drag, p));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointFromEvent(e);
    if (p) updateArea(gateAreaFromPoints(drag, p));
    setDrag(null);
  };

  const applyInputs = () => {
    const next = gateAreaFromPercentInputs(inputs);
    if (!next) {
      setInputError("Nhập số phần trăm từ 0 đến 100; chiều rộng và chiều cao phải lớn hơn 0.");
      return;
    }
    updateArea(next);
  };

  const save = async () => {
    setSaveState({ kind: "saving" });
    const body = gateAreaRequestBody(area);
    let res: Response;
    try {
      res = await apiFetch(`/api/camera-streams/${gateKey}/streams/${encodeURIComponent(stream.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setSaveState({ kind: "error", text: "Không kết nối được máy chủ. Vùng cổng CHƯA được lưu." });
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const reason =
        data?.error ||
        (res.status === 401
          ? "Cần đăng nhập."
          : res.status === 403
          ? "Tài khoản không có quyền sửa luồng camera (cần quyền vận hành)."
          : res.status === 404
          ? "Máy chủ không tìm thấy luồng này hoặc chưa có API sửa từng luồng."
          : "Máy chủ từ chối yêu cầu.");
      setSaveState({ kind: "error", text: `${reason} (HTTP ${res.status}) Vùng cổng CHƯA được lưu.` });
      return;
    }
    // The server's answer is the truth: read the area back from it.
    const streams = streamsFromResponse(data);
    const returned = streams?.find((s) => s.id === stream.id) || (data?.stream as GateStreamSource | undefined) || null;
    const kept = returned ? streamGateArea(returned) : null;
    onSaved(streams);
    if (returned && gateAreasEqual(kept, body.roi)) {
      setSaveState({
        kind: "saved",
        text: body.roi ? `Đã lưu vùng cổng: ${formatGateArea(kept)}.` : "Đã bỏ vùng cổng: dùng toàn khung hình.",
      });
    } else {
      setSaveState({
        kind: "not-applied",
        text:
          "Máy chủ đã nhận yêu cầu nhưng không trả lại vùng cổng vừa gửi - phiên bản máy chủ này có thể chưa hỗ trợ vùng cổng. Vùng cổng CHƯA có hiệu lực.",
      });
    }
  };

  const dirty = !gateAreasEqual(area, saved);
  const pixels = still.kind === "ready" ? gateAreaToPixels(area, still.width, still.height) : null;
  const aspect = still.kind === "ready" ? `${still.width} / ${still.height}` : "16 / 9";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-area-title"
        onKeyDown={onKeyDownDialog}
        className="w-full max-w-4xl max-h-[95vh] overflow-y-auto rounded-2xl bg-white shadow-2xl"
        data-testid="gate-area-editor"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <div className="min-w-0">
            <h2 id="gate-area-title" className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Crop className="w-4 h-4 text-indigo-600" /> Vùng cổng - {stream.label}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {gateName} · Hệ thống chỉ tìm khuôn mặt trong vùng này. Để trống (toàn khung hình) nếu không cần giới hạn.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            aria-label="Đóng trình chỉnh vùng cổng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Still + rectangle */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
              <span>
                {still.kind === "ready"
                  ? `Khung hình tham chiếu ${still.width} × ${still.height} px - chụp 1 lần khi mở, không lưu lại. Kéo chuột để vẽ vùng.`
                  : still.kind === "loading"
                  ? "Đang lấy 1 khung hình tham chiếu..."
                  : "Không có khung hình tham chiếu - chỉnh vùng bằng các ô số bên dưới."}
              </span>
              <button
                type="button"
                onClick={() => setStillAttempt((n) => n + 1)}
                disabled={still.kind === "loading" || saving}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold disabled:opacity-40"
              >
                <RefreshCw className={`w-3 h-3 ${still.kind === "loading" ? "animate-spin" : ""}`} /> Chụp lại khung
              </button>
            </div>

            <div
              ref={stageRef}
              className={`relative w-full overflow-hidden rounded-xl border border-slate-300 bg-slate-800 select-none touch-none ${
                still.kind === "ready" ? "cursor-crosshair" : ""
              }`}
              style={{ aspectRatio: aspect }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              {still.kind === "ready" ? (
                <img src={still.url} alt={`Khung hình tham chiếu của ${stream.label}`} className="absolute inset-0 w-full h-full" draggable={false} />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-300 text-xs text-center px-6">
                  {still.kind === "loading" ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-amber-400" />
                      <span>{still.reason}</span>
                    </>
                  )}
                </div>
              )}
              {/* The area: everything outside it is dimmed */}
              <div
                tabIndex={0}
                role="group"
                aria-label={`Vùng cổng: ${formatGateArea(area)}. Phím mũi tên để di chuyển, Shift + mũi tên để đổi kích thước.`}
                onKeyDown={onKeyDownArea}
                className="absolute border-2 border-amber-400 shadow-[0_0_0_9999px_rgba(15,23,42,0.55)] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
                style={gateAreaStyle(area)}
                data-testid="gate-area-rect"
              >
                <span className="absolute -top-5 left-0 px-1.5 py-0.5 rounded bg-amber-400 text-[10px] font-bold text-slate-900 whitespace-nowrap">
                  Vùng cổng
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Bàn phím: chọn khung vàng rồi dùng phím mũi tên để di chuyển 1%, Shift + mũi tên để đổi kích thước 1%.
            </p>
          </div>

          {/* Numeric editor (always available) */}
          <fieldset className="grid grid-cols-2 sm:grid-cols-4 gap-3" disabled={saving}>
            <legend className="sr-only">Vùng cổng theo phần trăm khung hình</legend>
            {(
              [
                ["x", "Cách mép trái (%)"],
                ["y", "Cách mép trên (%)"],
                ["w", "Chiều rộng (%)"],
                ["h", "Chiều cao (%)"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="text-xs font-semibold text-slate-700 space-y-1">
                <span className="block">{label}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.1}
                  value={inputs[field]}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [field]: e.target.value }))}
                  onBlur={applyInputs}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyInputs();
                    }
                  }}
                  aria-invalid={inputError ? true : undefined}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 font-mono text-xs focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              </label>
            ))}
          </fieldset>
          {inputError && (
            <p role="alert" className="text-xs text-rose-700">
              {inputError}
            </p>
          )}

          <div className="text-[11px] text-slate-600">
            <b>Vùng đang chọn:</b> {formatGateArea(area)}
            {pixels && !isFullFrame(area) && (
              <span className="text-slate-500">
                {" "}
                (≈ {pixels.w} × {pixels.h} px trên khung hình tham chiếu)
              </span>
            )}
            {saved ? (
              <span className="block text-slate-500">Đang lưu trên máy chủ: {formatGateArea(saved)}</span>
            ) : (
              <span className="block text-slate-500">Máy chủ chưa có vùng cổng cho luồng này (dùng toàn khung hình).</span>
            )}
          </div>

          {/* Result of the last save, announced to screen readers */}
          <div aria-live="polite" role="status">
            {saveState.kind === "saved" && (
              <p className="flex items-start gap-1.5 p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" /> {saveState.text}
              </p>
            )}
            {(saveState.kind === "not-applied" || saveState.kind === "error") && (
              <p
                className={`flex items-start gap-1.5 p-2.5 rounded-lg border text-xs ${
                  saveState.kind === "error" ? "bg-rose-50 border-rose-200 text-rose-900" : "bg-amber-50 border-amber-200 text-amber-900"
                }`}
              >
                <AlertTriangle className="w-4 h-4 shrink-0" /> {saveState.text}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button
            type="button"
            onClick={() => updateArea(FULL_GATE_AREA)}
            disabled={saving || isFullFrame(area)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
          >
            <Maximize className="w-3.5 h-3.5" /> Dùng toàn khung hình
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || (!dirty && saveState.kind !== "not-applied")}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? "Đang lưu..." : "Lưu vùng cổng"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

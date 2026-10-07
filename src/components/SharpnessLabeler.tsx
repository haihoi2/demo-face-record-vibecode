import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, RefreshCw, ArrowLeft, SkipForward } from "lucide-react";
import { FaceImage } from "./FaceImage";
import { operatorJsonFetch } from "../utils/api";
import {
  RATING_LABELS,
  SharpnessRating,
  SharpnessSampleFace,
  ratingForKey,
  ratingRequest,
  readSample,
  sampleRequest,
} from "../utils/sharpnessLabels";

/**
 * Face sharpness S0: rate stored stranger faces "Rõ" / "Mờ" / "Không phải mặt"
 * (keys 1/2/3, S to skip, Backspace for the previous face). Ratings are labels
 * for tuning the blur filter; nothing is hidden or deleted.
 */
export const SharpnessLabeler: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [queue, setQueue] = useState<SharpnessSampleFace[]>([]);
  const [history, setHistory] = useState<SharpnessSampleFace[]>([]);
  const [rated, setRated] = useState(0);
  const [target, setTarget] = useState(300);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const skipped = useRef(new Set<string>());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await operatorJsonFetch<any>(sampleRequest(40));
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      const s = readSample(res.data);
      const fresh = s.faces.filter((f) => !skipped.current.has(f.faceId));
      setQueue(fresh);
      setRated(s.ratedByMe);
      setTarget(s.target);
      setDone(fresh.length === 0);
    } catch (err: any) {
      setError(err?.message || "Lỗi tải ảnh");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = queue[0];

  const advance = useCallback(() => {
    setQueue((q) => {
      const rest = q.slice(1);
      if (rest.length < 3) void load();
      return rest;
    });
  }, [load]);

  const rate = useCallback(async (rating: SharpnessRating) => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url, init } = ratingRequest(current.faceId, rating);
      const res = await operatorJsonFetch<any>(url, init);
      if (!res.ok || !res.data?.success) throw new Error(res.data?.error || `HTTP ${res.status}`);
      setHistory((h) => [current, ...h].slice(0, 20));
      setRated((n) => n + 1);
      advance();
    } catch (err: any) {
      setError(`Chưa lưu được nhãn: ${err?.message || "lỗi máy chủ"}`);
    } finally {
      setBusy(false);
    }
  }, [current, busy, advance]);

  const skip = useCallback(() => {
    if (!current) return;
    skipped.current.add(current.faceId);
    advance();
  }, [current, advance]);

  const back = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const [prev, ...rest] = h;
      setQueue((q) => [prev, ...q]);
      setRated((n) => Math.max(0, n - 1));
      return rest;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      const action = ratingForKey(e.key);
      if (!action) return;
      e.preventDefault();
      if (action === "skip") skip();
      else if (action === "back") back();
      else void rate(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rate, skip, back, onClose]);

  const pct = Math.min(100, Math.round((rated / Math.max(1, target)) * 100));

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6">
      <div role="dialog" aria-modal="true" aria-labelledby="sharpness-title" className="w-full max-w-lg bg-white rounded-3xl shadow-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="sharpness-title" className="text-base font-bold text-slate-900">Gán nhãn độ nét ảnh người lạ</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Nhãn dùng để tinh chỉnh bộ lọc ảnh mờ; không ẩn hay xóa ảnh nào. Phím 1 / 2 / 3 để gán, S bỏ qua, ← quay lại.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-slate-600 mb-1" aria-live="polite">
            <span>Đã gán {rated}/{target} ảnh</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="aspect-square w-full max-w-xs mx-auto rounded-2xl overflow-hidden bg-slate-900 flex items-center justify-center">
          {current ? (
            <FaceImage key={current.faceId} src={current.imageUrl} alt="Ảnh khuôn mặt cần gán nhãn" className="w-full h-full" />
          ) : loading ? (
            <RefreshCw className="w-6 h-6 text-white/70 animate-spin" aria-label="Đang tải" />
          ) : (
            <p className="text-xs text-white/80 px-6 text-center">{done ? "Đã gán hết ảnh hiện có. Cảm ơn!" : "Không có ảnh"}</p>
          )}
        </div>
        {current && (
          <p className="text-center text-[11px] text-slate-500">
            {new Date(current.capturedAt).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            {current.gateId ? ` · ${current.gateId === "exit" ? "Cổng ra" : current.gateId === "entry" ? "Cổng vào" : current.gateId}` : ""}
          </p>
        )}

        {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-2">{error}</p>}

        <div className="grid grid-cols-3 gap-2">
          {(["sharp", "blurry", "not-face"] as SharpnessRating[]).map((r, i) => (
            <button
              key={r}
              type="button"
              disabled={!current || busy}
              onClick={() => void rate(r)}
              className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-40 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                r === "sharp" ? "border-emerald-300 text-emerald-800 hover:bg-emerald-50" : r === "blurry" ? "border-amber-300 text-amber-800 hover:bg-amber-50" : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="font-mono text-[10px] opacity-60 mr-1">{i + 1}</span>
              {RATING_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="flex justify-between">
          <button type="button" onClick={back} disabled={!history.length || busy} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 disabled:opacity-40">
            <ArrowLeft className="w-3.5 h-3.5" /> Ảnh trước
          </button>
          <button type="button" onClick={skip} disabled={!current || busy} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 disabled:opacity-40">
            Bỏ qua <SkipForward className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default SharpnessLabeler;

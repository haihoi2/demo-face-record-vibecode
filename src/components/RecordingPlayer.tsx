import React, { useEffect, useState } from "react";
import { Film, Loader2, RotateCcw, X } from "lucide-react";
import { recordingUrl } from "../utils/recordings";

interface RecordingPlayerProps {
  logId: string;
  /** Shown in the header: when and where the event happened. */
  title: string;
  before: number;
  after: number;
  onClose: () => void;
}

/**
 * The NVR's recording around one access event, streamed by the backend as it
 * arrives from the recorder (about real time, so the clip fills in while it
 * plays). A <video> cannot read the server's error text, so failures show the
 * likely causes instead.
 */
export const RecordingPlayer: React.FC<RecordingPlayerProps> = ({ logId, title, before, after, onClose }) => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "playing" | "error">("loading");
  const src = recordingUrl(logId);
  const crossOrigin = /^https?:\/\//i.test(src) && !src.startsWith(window.location.origin) ? "use-credentials" : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Đoạn ghi từ đầu ghi"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Film className="w-4 h-4 text-indigo-600" /> Đoạn ghi từ đầu ghi
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {title} · {before} giây trước đến {after} giây sau lượt quét
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Đóng">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative bg-black aspect-video">
          {state !== "error" && (
            <video
              key={attempt}
              src={src}
              crossOrigin={crossOrigin}
              controls
              autoPlay
              muted
              playsInline
              className="w-full h-full"
              data-testid="recording-video"
              onPlaying={() => setState("playing")}
              onError={() => setState("error")}
            />
          )}
          {state === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-200 text-xs pointer-events-none">
              <Loader2 className="w-6 h-6 animate-spin" />
              Đang lấy đoạn ghi từ đầu ghi…
            </div>
          )}
          {state === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-slate-100 text-xs">
              <p className="font-bold text-sm">Không phát được đoạn ghi</p>
              <p className="text-slate-300 max-w-md">
                Đầu ghi chỉ lưu khoảng 8 ngày; lượt quét vừa xảy ra cần vài giây để đầu ghi ghi xong; hoặc đang có nhiều người
                xem cùng lúc.
              </p>
              <button
                type="button"
                onClick={() => {
                  setState("loading");
                  setAttempt((a) => a + 1);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-slate-900 font-bold"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Thử lại
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

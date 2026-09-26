import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn } from "lucide-react";
import { ProtectedImage } from "./ProtectedImage";
import {
  ImageShape,
  PixelSize,
  classifyImageShape,
  describeImageShape,
  formatPixelSize,
  thumbFitClass,
  usableZoomScales,
  zoomDisplaySize,
} from "../utils/faceImage";

/**
 * Measures a loaded <img> so the caller can fit a face crop and a legacy wide
 * frame differently. Until the image loads the shape is "unknown" (shown whole).
 */
export function useImageShape(): {
  shape: ImageShape;
  natural: PixelSize | null;
  onLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
} {
  const [natural, setNatural] = useState<PixelSize | null>(null);
  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNatural({ width: img.naturalWidth, height: img.naturalHeight });
  }, []);
  return { shape: natural ? classifyImageShape(natural.width, natural.height) : "unknown", natural, onLoad };
}

interface FaceImageProps {
  src?: string | null;
  alt: string;
  /** Classes of the <img> apart from the fit (size, rounding, hover effects). */
  className?: string;
}

/** A protected captured image whose fit follows its shape (crop fills, frame shows whole). */
export const FaceImage: React.FC<FaceImageProps> = ({ src, alt, className = "" }) => {
  const { shape, onLoad } = useImageShape();
  return <ProtectedImage src={src} alt={alt} onLoad={onLoad} className={`${className} ${thumbFitClass(shape)}`} />;
};

interface FaceThumbProps {
  src?: string | null;
  alt: string;
  /** Size/shape of the thumbnail box, e.g. "w-12 h-12 rounded-lg". */
  className?: string;
  /** Extra line under the enlarged image (time, gate...). */
  caption?: string;
  /** Rendered instead of the image when there is none. */
  placeholder?: React.ReactNode;
}

/**
 * Thumbnail of a captured face (or legacy frame) that opens the enlarged view
 * on click / Enter / Space. The box never distorts the image.
 */
export const FaceThumb: React.FC<FaceThumbProps> = ({ src, alt, className = "w-12 h-12 rounded-lg", caption, placeholder }) => {
  const [open, setOpen] = useState(false);
  const { shape, onLoad } = useImageShape();

  if (!src) {
    return <>{placeholder ?? <span aria-hidden="true" className={`inline-block bg-slate-100 border border-slate-200 ${className}`} />}</>;
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`group relative block shrink-0 overflow-hidden border border-slate-200 bg-slate-100 shadow-xs focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 cursor-zoom-in ${className}`}
        aria-label={`Phóng to ảnh: ${alt}`}
        title="Bấm để phóng to"
        data-image-shape={shape}
      >
        <ProtectedImage src={src} alt={alt} onLoad={onLoad} className={`w-full h-full ${thumbFitClass(shape)}`} />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/25 transition-colors">
          <ZoomIn className="w-3.5 h-3.5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </button>
      {open && <ImageZoomDialog src={src} alt={alt} caption={caption} onClose={() => setOpen(false)} />}
    </>
  );
};

interface ImageZoomDialogProps {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

const readViewport = (): PixelSize =>
  typeof window === "undefined" ? { width: 1024, height: 768 } : { width: window.innerWidth, height: window.innerHeight - 140 };

/**
 * Enlarged captured image at its natural size (a ~250 px face crop is shown at
 * 250 px, not blown up), with 2x/3x steps for small crops. Modal: focus moves
 * in, Tab stays inside, Escape or the backdrop closes, focus returns after.
 */
export const ImageZoomDialog: React.FC<ImageZoomDialogProps> = ({ src, alt, caption, onClose }) => {
  const { shape, natural, onLoad } = useImageShape();
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState<PixelSize>(readViewport);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onResize = () => setViewport(readViewport());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
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

  const scales = natural && shape === "crop" ? usableZoomScales(natural, viewport) : [1];
  const size = natural ? zoomDisplaySize(natural, viewport, scale) : null;
  const sizeLabel = formatPixelSize(natural);

  const overlay = (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Ảnh phóng to: ${alt}`}
        onKeyDown={onKeyDown}
        className="relative max-w-full rounded-2xl bg-white p-2 shadow-2xl"
        data-testid="image-zoom-dialog"
      >
        <div className="flex items-center justify-center rounded-xl bg-slate-900 overflow-hidden min-w-[160px] min-h-[160px]">
          <ProtectedImage
            src={src}
            alt={alt}
            onLoad={onLoad}
            style={size ? { width: size.width, height: size.height } : undefined}
            className="block max-w-[90vw] max-h-[calc(100vh-140px)] object-contain [image-rendering:auto]"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2 pb-1 text-xs text-slate-600">
          <div className="min-w-0">
            <p className="font-semibold text-slate-800">{describeImageShape(shape)}</p>
            <p className="text-[11px] text-slate-500">
              {[sizeLabel, scale > 1 ? `hiển thị ${scale}×` : sizeLabel ? "kích thước gốc" : "", size?.capped ? "thu nhỏ cho vừa màn hình" : "", caption]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {scales.length > 1 && (
              <div role="group" aria-label="Mức phóng to" className="flex items-center rounded-lg border border-slate-200 p-0.5">
                {scales.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={scale === s}
                    onClick={() => setScale(s)}
                    className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                      scale === s ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold"
            >
              <X className="w-3.5 h-3.5" /> Đóng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  // A portal keeps the overlay out of transformed / overflow-clipped ancestors
  // (table cells, animated panels, the stranger modal's scroll area).
  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
};

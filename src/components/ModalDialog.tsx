/**
 * Small accessible modal used by the gate and door forms: focus moves into the
 * dialog on open (the element marked `data-autofocus`, else the first control),
 * Tab cycles inside, Escape and the backdrop cancel unless busy, and focus
 * returns to the control that opened it.
 */
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalDialogProps {
  /** Unique prefix for the title/description ids. */
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  busy?: boolean;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** "alertdialog" for destructive confirmations. */
  role?: "dialog" | "alertdialog";
}

export const ModalDialog: React.FC<ModalDialogProps> = ({
  id,
  title,
  description,
  busy = false,
  onClose,
  children,
  footer,
  role = "dialog",
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialogRef.current;
    const target =
      (root?.querySelector("[data-autofocus]") as HTMLElement | null) ||
      (root?.querySelector(FOCUSABLE) as HTMLElement | null);
    target?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onClose();
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

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl max-h-[90vh] overflow-y-auto"
        data-testid={id}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-bold text-slate-900">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            aria-label="Đóng hộp thoại"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {description && (
          <p id={`${id}-desc`} className="px-5 pt-4 text-xs text-slate-700 leading-relaxed">
            {description}
          </p>
        )}
        {children && <div className="px-5 py-4 space-y-3">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">{footer}</div>}
      </div>
    </div>
  );
};

export default ModalDialog;

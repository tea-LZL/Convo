import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
}

const SIZES: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnEscape = true,
  closeOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeOnEscape, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => closeOnBackdrop && onClose()}
      />
      <div
        className={`relative w-full ${SIZES[size]} glass border border-border rounded-2xl shadow-modal animate-scale-in max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || description) && (
          <div className="px-5 pt-5 pb-3 flex items-start justify-between border-b border-border/40">
            <div>
              {title && <h2 className="text-base font-semibold text-text">{title}</h2>}
              {description && <p className="text-xs text-text-muted mt-0.5">{description}</p>}
            </div>
            <button
              onClick={onClose}
              className="text-text-subtle hover:text-text p-1 -mt-1 -mr-1 rounded-md hover:bg-surface-2"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-border/40 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

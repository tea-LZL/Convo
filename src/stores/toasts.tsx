/**
 * Toast notifications.
 */
import { create } from "zustand";
import { ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastVariant = "info" | "success" | "warn" | "error";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  durationMs: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = crypto.randomUUID();
    const toast: Toast = {
      id,
      variant: t.variant,
      title: t.title,
      message: t.message,
      durationMs: t.durationMs ?? 3500,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, toast.durationMs);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = {
  info: (message: string, title?: string, durationMs?: number) =>
    useToastStore.getState().push({ variant: "info", message, title, durationMs }),
  success: (message: string, title?: string, durationMs?: number) =>
    useToastStore.getState().push({ variant: "success", message, title, durationMs }),
  warn: (message: string, title?: string, durationMs?: number) =>
    useToastStore.getState().push({ variant: "warn", message, title, durationMs }),
  error: (message: string, title?: string, durationMs?: number) =>
    useToastStore.getState().push({ variant: "error", message, title, durationMs }),
};

const ICONS: Record<ToastVariant, ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warn: <AlertCircle size={16} />,
  error: <AlertCircle size={16} />,
};

const COLORS: Record<ToastVariant, string> = {
  info: "var(--color-accent)",
  success: "var(--color-success)",
  warn: "var(--color-warn)",
  error: "var(--color-error)",
};

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto bg-surface-1 border border-border rounded-lg shadow-modal min-w-[280px] max-w-[420px] px-3 py-2.5 flex items-start gap-2.5 animate-slide-up"
        >
          <div style={{ color: COLORS[t.variant] }} className="shrink-0 mt-0.5">
            {ICONS[t.variant]}
          </div>
          <div className="flex-1 min-w-0">
            {t.title && (
              <div className="text-sm font-medium text-text leading-tight">{t.title}</div>
            )}
            <div className="text-xs text-text-muted leading-snug mt-0.5 break-words">
              {t.message}
            </div>
          </div>
          <button
            onClick={() => dismiss(t.id)}
            className="text-text-subtle hover:text-text p-0.5 -mt-0.5 -mr-0.5"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

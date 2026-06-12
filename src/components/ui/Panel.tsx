import { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
  glass?: boolean;
  bordered?: boolean;
  padded?: boolean;
}

export function Panel({ children, className = "", glass = false, bordered = true, padded = false }: PanelProps) {
  return (
    <div
      className={`rounded-xl ${bordered ? "border border-border" : ""} ${glass ? "glass" : "bg-surface-1"} ${padded ? "p-4" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

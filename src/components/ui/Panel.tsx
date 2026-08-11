import { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
  bordered?: boolean;
  padded?: boolean;
}

export function Panel({ children, className = "", bordered = true, padded = false }: PanelProps) {
  return (
    <div
      className={`rounded-xl ${bordered ? "border border-border" : ""} bg-surface-1 ${padded ? "p-4" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

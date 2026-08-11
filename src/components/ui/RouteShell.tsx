import { ReactNode } from "react";

interface RouteShellProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function RouteShell({
  title,
  description,
  actions,
  children,
  className = "",
  contentClassName = "",
}: RouteShellProps) {
  return (
    <section className={`flex-1 min-h-0 flex flex-col ${className}`}>
      <header className="min-h-12 shrink-0 border-b border-border bg-surface-1 px-4 py-3 flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-text">{title}</h1>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{actions}</div>}
      </header>
      <div className={`flex-1 min-h-0 overflow-y-auto ${contentClassName}`}>{children}</div>
    </section>
  );
}

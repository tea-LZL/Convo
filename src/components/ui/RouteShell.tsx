import { ReactNode } from "react";

interface RouteShellProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * The page chrome every route inherits: a title, an optional
 * description, an optional right-aligned action cluster, and a scroll
 * region that is the only part of the page allowed to scroll.
 *
 * The reference design's "View:" pill is **not** here. It belongs to the
 * pages that have a real view toggle — Chat's model selector, Memory's
 * kind filter — and those pass it in through `actions`. A dropdown that
 * switches nothing is worse than none: it advertises a capability the app
 * does not have. So the shell ships the frame and the pages supply the
 * controls.
 */
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
      <header className="shrink-0 border-b border-border bg-surface-1 px-6 py-4 flex items-end gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* 28px / 700. The 26 theme keys carry no type scale, so this
              is the one place a size is spelled out, and it is spelled
              out in the class rather than left to whatever `text-sm`
              happened to be. */}
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-text">{title}</h1>
          {description && <p className="mt-1 text-xs text-text-muted">{description}</p>}
        </div>
        {actions && (
          <div
            data-actions=""
            className="flex items-center gap-2 shrink-0 flex-wrap justify-end"
          >
            {actions}
          </div>
        )}
      </header>
      <div className={`flex-1 min-h-0 overflow-y-auto ${contentClassName}`}>{children}</div>
    </section>
  );
}

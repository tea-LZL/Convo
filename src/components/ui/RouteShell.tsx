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
 *
 * The cluster is allowed to shrink, and it wraps. This is load-bearing
 * rather than incidental: a page's action cluster is the widest thing it
 * puts in its header — Memory's kind filter is four tabs — so a cluster
 * that cannot give is a header that pushes the content pane instead of
 * reflowing. `MemoryRoute` was the case that proved it, and
 * `RouteShell.test.tsx` pins the property from the shell's side.
 *
 * The `shrink-0` on the `<header>` below is a *different* thing and is
 * not in tension with this: that one stops the header collapsing as the
 * content region scrolls, so the title stays put.
 *
 * ── The page inset is 16px, and it is the same 16px here as below ───
 * The header was `px-6` (24px) while the content roots were 8, 12 or
 * 16px, so on Memory and Tasks a 28px bold title sat 12–16px further
 * right than the first row of content under it. Two pages sharing a top
 * edge and disagreeing about where it is.
 *
 * The value is 16px, and it is 16px rather than 24 because 16 is what
 * the content already used on the routes that are not compact — the
 * inset is page chrome, and chrome is the one thing on a page that is
 * the same everywhere. A route whose content is a *pane* flush to the
 * scroll region (Notes, Documents) carries no page inset at all and is
 * not this rule's subject; its panes own their internal padding, the
 * same way the sidebar's do.
 *
 * `RouteShell.test.tsx` measures the 16px out of a real Tailwind
 * compile, and `AboutRoute.test.tsx` measures that the title's left edge
 * and the content's left edge are the same line.
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
      <header className="shrink-0 border-b border-border bg-surface-1 px-4 py-4 flex items-end gap-4 flex-wrap">
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
            className="flex items-center gap-2 flex-wrap justify-end"
          >
            {actions}
          </div>
        )}
      </header>
      <div className={`flex-1 min-h-0 overflow-y-auto ${contentClassName}`}>{children}</div>
    </section>
  );
}

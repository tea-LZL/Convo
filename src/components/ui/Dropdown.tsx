import { ReactNode, useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
  /** When the trigger sits inside a stacking-context-creating parent
   * (e.g. backdrop-blur), an absolutely-positioned menu can't
   * paint over siblings outside its parent. Portal-mounting the
   * menu at document.body fixes that without requiring consumers
   * to know about CSS quirks. Default: true. */
  portal?: boolean;
}

/**
 * Compute the menu's position from the trigger element's bounding rect.
 * Runs once on each open (and on resize) so the menu tracks the
 * trigger when the window changes size. We do this with position:
 * fixed in the portal'd node so the menu is unaffected by transform /
 * filter / containment ancestors.
 */
function useMenuPosition(
  triggerRef: React.RefObject<HTMLElement>,
  open: boolean,
  align: "left" | "right"
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        top: r.bottom + 4 /* mt-1 = 4px */,
        // Mirror Tailwind's `right-0` / `left-0` on the absolute
        // menu: position the menu's right edge to the trigger's
        // right edge (when align=right), otherwise align the menu's
        // left edge to the trigger's left edge.
        left: align === "right" ? r.right : r.left,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align, triggerRef]);
  return pos;
}

export function Dropdown({
  trigger,
  children,
  align = "right",
  className = "",
  menuClassName = "",
  portal = true,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const pos = useMenuPosition(triggerRef, open, align);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      // Click outside either the trigger wrapper or the portaled menu.
      const target = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(target)) return;
      const menu = document.querySelector("[data-dropdown-portal]");
      if (menu && menu.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const menu = open ? (
    <div
      data-dropdown-portal
      className={`fixed z-[60] min-w-[180px] glass border border-border rounded-lg shadow-modal overflow-hidden animate-scale-in ${
        align === "right" ? "-translate-x-full" : ""
      } ${menuClassName}`}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
      }}
      // Disable until we have a real position so it doesn't flash
      // at (0,0).
      // eslint-disable-next-line react/forbid-dom-props
      data-positioned={pos !== null ? "1" : "0"}
      onClick={(e) => {
        // Clicks inside the menu shouldn't close it via the
        // document mousedown handler — the menu consumes them.
        e.stopPropagation();
        // Close on any actual item pick by default; consumers that
        // want to keep the menu open can call close() manually.
        if (!(e.target as HTMLElement).closest("[data-keep-open]")) {
          setOpen(false);
        }
      }}
    >
      {typeof children === "function" ? children(close) : children}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div ref={triggerRef} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </div>
      {portal && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : menu}
    </div>
  );
}

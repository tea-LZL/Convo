import {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  cloneElement,
  isValidElement,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
  /** When the trigger sits inside a stacking-context-creating parent
   * (e.g. translucent overlays), an absolutely-positioned menu can't
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
      const menu = document.querySelector<HTMLElement>("[data-dropdown-portal]");
      const menuWidth = menu?.offsetWidth ?? 180;
      const menuHeight = menu?.offsetHeight ?? 240;
      const gap = 4;
      const preferredLeft = align === "right" ? r.right - menuWidth : r.left;
      const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - menuWidth - 8));
      const below = r.bottom + gap;
      const top = below + menuHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, r.top - menuHeight - gap);
      setPos({ top, left });
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
  const menuRef = useRef<HTMLDivElement>(null);
  const pos = useMenuPosition(triggerRef, open, align);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      // Click outside either the trigger wrapper or the portaled menu.
      const target = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(target)) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.querySelector<HTMLElement>("button, [role='button']")?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [role='menuitem']") ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = current === -1
        ? (e.key === "ArrowDown" ? 0 : items.length - 1)
        : e.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    items.forEach((item) => item.setAttribute("role", "menuitem"));
    const frame = requestAnimationFrame(() => items[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      if (document.activeElement && menuRef.current?.contains(document.activeElement)) {
        triggerRef.current?.querySelector<HTMLElement>("button, [role='button']")?.focus();
      }
    };
  }, [open]);

  const close = () => setOpen(false);

  const enhanceTrigger = () => {
    if (!isValidElement(trigger)) return trigger;
    const element = trigger as ReactElement<{
      onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
      "aria-haspopup"?: "menu" | boolean;
      "aria-expanded"?: boolean;
    }>;
    return cloneElement(element, {
      "aria-haspopup": "menu",
      "aria-expanded": open,
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        element.props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
        }
      },
    });
  };

  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Menu"
      data-dropdown-portal
      className={`fixed z-[60] min-w-[180px] bg-surface-1 border border-border rounded-lg shadow-modal overflow-hidden animate-scale-in ${
        align === "right" ? "-translate-x-full" : ""
      } ${menuClassName}`}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
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
        {enhanceTrigger()}
      </div>
      {portal && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : menu}
    </div>
  );
}

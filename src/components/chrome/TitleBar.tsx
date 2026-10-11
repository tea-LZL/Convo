/**
 * The application's own title bar.
 *
 * The window is created with `decorations: false`, so the OS no longer draws
 * a title bar or its minimize / maximize / close controls. This replaces it
 * with one built from the active theme's tokens, so the chrome matches the
 * app instead of whatever the desktop environment is themed with.
 *
 * Dragging is the webview's: `data-tauri-drag-region` turns a press-and-move
 * on the bar into a window move (Tauri calls `startDragging`, which the
 * capability grants). The controls carry no such attribute, so a click on
 * close is never read as a drag. Double-clicking the bar toggles maximize —
 * that is the webview's own behaviour for a drag region, so it is not
 * re-implemented here (a second handler would toggle twice and cancel out).
 *
 * The bar is `bg-surface-1` with the same `border-b border-border` as the
 * sidebar header and every route's page header, so the chrome reads as one
 * frame rather than a separate widget bolted to the top.
 */
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

export function TitleBar() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const read = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch(() => {
          /* A window that cannot report its state still renders; the icon is cosmetic. */
        });
    };
    read();
    void appWindow
      .onResized(read)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* Without resize events the icon just does not update. */
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [appWindow]);

  const minimize = () => {
    void appWindow.minimize().catch(() => {});
  };
  const toggleMaximize = () => {
    void appWindow.toggleMaximize().catch(() => {});
  };
  const close = () => {
    void appWindow.close().catch(() => {});
  };

  return (
    <header
      data-tauri-drag-region
      className="shrink-0 h-9 flex items-stretch justify-between select-none border-b border-border bg-surface-1"
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-3 min-w-0"
      >
        <div
          data-tauri-drag-region
          className="w-4 h-4 rounded bg-accent flex items-center justify-center text-white font-bold text-[9px] shrink-0"
        >
          C
        </div>
        <span
          data-tauri-drag-region
          className="text-xs font-medium text-text-muted truncate"
        >
          Convo
        </span>
      </div>
      <div className="flex items-stretch">
        <WindowControl label="Minimize" onClick={minimize}>
          <Minus size={14} />
        </WindowControl>
        <WindowControl
          label={maximized ? "Restore" : "Maximize"}
          onClick={toggleMaximize}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </WindowControl>
        <WindowControl label="Close window" onClick={close} danger>
          <X size={14} />
        </WindowControl>
      </div>
    </header>
  );
}

/**
 * One window control. `danger` is the close button's red hover, which is the
 * one place a window control changes colour — spelling it as a flag keeps the
 * three buttons one definition rather than two and an exception.
 */
function WindowControl({
  label,
  onClick,
  children,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`w-11 inline-flex items-center justify-center text-text-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text ${
        danger
          ? "hover:bg-error hover:text-white"
          : "hover:bg-surface-2 hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

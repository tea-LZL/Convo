/**
 * Command palette UI.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { filterActions, getActions, usePaletteStore } from "../stores/palette";
import { useNavigate } from "react-router-dom";
import { comboDisplay } from "../stores/shortcuts";

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const query = usePaletteStore((s) => s.query);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const navigate = useNavigate();
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const actions = useMemo(() => (open ? filterActions(query) : []), [open, query]);

  useEffect(() => {
    if (selected >= actions.length) setSelected(Math.max(0, actions.length - 1));
  }, [actions.length, selected]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-action-index="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  if (!open) return null;

  const groups = actions.reduce<Record<string, Array<{ a: typeof actions[number]; i: number }>>>((acc, a, i) => {
    (acc[a.group] ??= []).push({ a, i });
    return acc;
  }, {});

  const runAction = (a: (typeof actions)[number]) => {
    setOpen(false);
    a.perform({ navigate });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[150] flex items-start justify-center pt-[12vh] px-4 animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 overlay-backdrop" />
      <div
        data-tour="palette"
        className="relative w-full max-w-xl bg-surface-1 border border-border rounded-2xl shadow-modal overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50">
          <Search size={16} className="text-text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(actions.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (actions[selected]) runAction(actions[selected]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <kbd className="text-[10px] text-text-subtle bg-surface-2 border border-border rounded px-1.5 py-0.5 font-mono">esc</kbd>
        </div>
        <div ref={listRef} role="listbox" aria-label="Commands" className="max-h-[60vh] overflow-y-auto py-1">
          {actions.length === 0 ? (
            <div className="px-4 py-6 text-center text-text-muted text-sm">
              {getActions().length === 0 ? "No actions registered yet" : "No matches"}
            </div>
          ) : (
            Object.entries(groups).map(([group, items]) => (
              <div key={group} className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
                  {group}
                </div>
                {items.map(({ a, i }) => (
                  <button
                    key={a.id}
                    role="option"
                    aria-selected={i === selected}
                    data-action-index={i}
                    onClick={() => runAction(a)}
                    onMouseEnter={() => setSelected(i)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                      i === selected ? "bg-surface-3 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
                    }`}
                  >
                    {a.icon && <span className="text-text-subtle shrink-0">{a.icon}</span>}
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{a.label}</div>
                      {a.description && (
                        <div className="text-xs text-text-subtle truncate">{a.description}</div>
                      )}
                    </div>
                    {a.shortcut && (
                      <kbd className="text-[10px] text-text-subtle bg-surface-2 border border-border rounded px-1.5 py-0.5 font-mono">
                        {comboDisplay(a.shortcut)}
                      </kbd>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 px-3 py-2 border-t border-border/50 text-[10px] text-text-subtle">
          <span><kbd className="bg-surface-2 border border-border rounded px-1 py-0.5">↑</kbd> <kbd className="bg-surface-2 border border-border rounded px-1 py-0.5">↓</kbd> navigate</span>
          <span><kbd className="bg-surface-2 border border-border rounded px-1 py-0.5">↵</kbd> select</span>
          <span><kbd className="bg-surface-2 border border-border rounded px-1 py-0.5">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

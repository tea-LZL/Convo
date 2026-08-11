/**
 * Sessions search overlay (Ctrl+Shift+F).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, MessageSquare } from "lucide-react";
import { api, SessionWithSnippet } from "../lib/api";

export function SessionSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<SessionWithSnippet>>([]);
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const onTrigger = () => setOpen((o) => !o);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("convo:search-sessions", onTrigger);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("convo:search-sessions", onTrigger);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => document.querySelector<HTMLInputElement>("[data-search-input]")?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api.searchSessions(query);
        setResults(r);
        setSelected(0);
      } catch (e) {
        console.error(e);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[140] flex items-start justify-center pt-[10vh] px-4 animate-fade-in"
      onClick={() => setOpen(false)}
    >
       <div className="absolute inset-0 overlay-backdrop" />
      <div
        className="relative w-full max-w-2xl bg-surface-1 border border-border rounded-2xl shadow-modal overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/50">
          <Search size={16} className="text-text-subtle" />
          <input
            data-search-input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter" && results[selected]) {
                e.preventDefault();
                navigate(`/chat/${results[selected].id}`);
                setOpen(false);
              }
            }}
            placeholder="Search session titles and message content…"
            className="flex-1 bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none"
          />
          <kbd className="text-[10px] text-text-subtle bg-surface-2 border border-border rounded px-1.5 py-0.5 font-mono">esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {query.trim() === "" ? (
            <div className="px-4 py-6 text-center text-text-muted text-sm">
              Type to search across all session titles and message content.
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-6 text-center text-text-muted text-sm">No matches.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                onClick={() => {
                  navigate(`/chat/${r.id}`);
                  setOpen(false);
                }}
                onMouseEnter={() => setSelected(i)}
                className={`w-full text-left px-4 py-2.5 transition-colors ${
                  i === selected ? "bg-surface-3" : "hover:bg-surface-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare size={12} className="text-text-subtle shrink-0" />
                  <span className="text-sm text-text font-medium truncate">{r.title}</span>
                </div>
                {r.snippet && (
                  <div className="text-xs text-text-subtle mt-0.5 line-clamp-2 pl-5">{r.snippet}</div>
                )}
                <div className="text-[10px] text-text-subtle mt-0.5 pl-5">
                  {new Date(r.updated_at).toLocaleString()}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

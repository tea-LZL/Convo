import { Brain, Edit3, Power, PowerOff, Search, Tag, Trash2, TriangleAlert } from "lucide-react";
import type { MemoryItem, MemorySearchHit } from "../../lib/api";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Spinner, Tabs } from "../ui/Form";
import { HighlightedSnippet } from "./HighlightedSnippet";

export type MemoryKind = "user_pref" | "project_fact" | "skill";
export type MemoryKindFilter = "all" | MemoryKind;

export const KIND_LABEL: Record<MemoryKindFilter, string> = {
  all: "All",
  user_pref: "Preferences",
  project_fact: "Project facts",
  skill: "Skills",
};

export const KIND_COLOR: Record<string, string> = {
  user_pref: "bg-accent/15 text-accent border-accent/30",
  project_fact: "bg-success/15 text-success border-success/30",
  skill: "bg-warn/15 text-warn border-warn/30",
};

export interface MemoryLibraryProps {
  items: MemoryItem[];
  visible: MemorySearchHit[];
  filter: MemoryKindFilter;
  query: string;
  loading: boolean;
  error: string | null;
  searchLoading: boolean;
  searchError: string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: MemoryKindFilter) => void;
  onRetry: () => void;
  onSearchRetry: () => void;
  onAdd: (kind: MemoryKind) => void;
  onToggle: (item: MemoryItem) => void;
  onEdit: (item: MemoryItem) => void;
  onDelete: (id: string) => void;
}

const FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "user_pref", label: "Preferences" },
  { id: "project_fact", label: "Project facts" },
  { id: "skill", label: "Skills" },
];

export function MemoryLibrary({
  items,
  visible,
  filter,
  query,
  loading,
  error,
  searchLoading,
  searchError,
  onQueryChange,
  onFilterChange,
  onRetry,
  onSearchRetry,
  onAdd,
  onToggle,
  onEdit,
  onDelete,
}: MemoryLibraryProps) {
  return (
    <>
      <div className="px-4 py-2 border-b border-border bg-surface-1/40 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search memory…"
            aria-label="Search memory"
            className="w-full bg-surface-2 border border-border rounded-md pl-8 pr-3 py-1.5 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent"
          />
        </div>
        <Tabs
          active={filter}
          onChange={(value) => onFilterChange(value as MemoryKindFilter)}
          tabs={FILTER_TABS}
        />
      </div>
      <div className="p-3 sm:p-4 max-w-2xl mx-auto w-full">
        {loading ? (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-text-muted" role="status" aria-live="polite">
            <Spinner size={16} />
            Loading memory items…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3" role="alert">
            <TriangleAlert size={16} className="text-error shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text">Could not load memory items.</p>
              <p className="text-xs text-text-muted mt-1">{error}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
                Retry
              </Button>
            </div>
          </div>
        ) : searchLoading ? (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-text-muted" role="status" aria-live="polite">
            <Spinner size={16} />
            Searching memory…
          </div>
        ) : searchError ? (
          <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3" role="alert">
            <TriangleAlert size={16} className="text-error shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text">Could not search memory.</p>
              <p className="text-xs text-text-muted mt-1">{searchError}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onSearchRetry}>
                Retry
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          query.trim() ? (
            <EmptyState
              icon={<Brain size={32} />}
              title="No matches"
              description="Try a different query or filter."
            />
          ) : (
            <div className="py-8">
              <div className="text-center mb-6">
                <Brain size={32} className="mx-auto text-text-subtle mb-3" />
                <h2 className="text-sm font-semibold text-text">No memories yet</h2>
                <p className="text-xs text-text-muted mt-1">
                  Add user preferences, project facts, and skills. They&apos;re included as context in every chat.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => onAdd("user_pref")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-1">Set a preference</div>
                  <div className="text-[10px] text-text-muted">&quot;I prefer concise replies&quot;</div>
                </button>
                <button
                  type="button"
                  onClick={() => onAdd("project_fact")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-1">Log a project fact</div>
                  <div className="text-[10px] text-text-muted">&quot;This repo uses Tauri v2&quot;</div>
                </button>
                <button
                  type="button"
                  onClick={() => onAdd("skill")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-colors"
                >
                  <div className="text-xs font-medium text-text mb-1">Create a skill</div>
                  <div className="text-[10px] text-text-muted">&quot;Run tests with `npm t` before push&quot;</div>
                </button>
              </div>
            </div>
          )
        ) : (
          <ul className="space-y-2" aria-label="Memory library">
            {visible.map((entry) => {
              const item = entry.item;
              const tags = (item.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
              return (
                <li
                  key={item.id}
                  className={`bg-surface-1 border border-border rounded-lg p-3 group ${!item.is_enabled ? "opacity-50" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`inline-flex items-center text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${KIND_COLOR[item.kind] || KIND_COLOR.skill}`}>
                      {KIND_LABEL[item.kind as MemoryKindFilter] || item.kind}
                    </span>
                    {item.title && <div className="text-sm font-medium text-text">{item.title}</div>}
                    <div className="flex-1" />
                    <button
                      type="button"
                      aria-label={item.is_enabled ? `Disable ${item.title || "memory item"}` : `Enable ${item.title || "memory item"}`}
                      onClick={() => onToggle(item)}
                      className="text-text-subtle hover:text-text p-1"
                      title={item.is_enabled ? "Disable" : "Enable"}
                    >
                      {item.is_enabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${item.title || "memory item"}`}
                      onClick={() => onEdit(item)}
                      className="text-text-subtle hover:text-text p-1"
                      title="Edit"
                    >
                      <Edit3 size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${item.title || "memory item"}`}
                      onClick={() => onDelete(item.id)}
                      className="text-text-subtle hover:text-error p-1"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {entry.snippet ? (
                    <div className="text-xs text-text-muted leading-relaxed mt-1.5">
                      <HighlightedSnippet snippet={entry.snippet} />
                    </div>
                  ) : (
                    <div className="text-xs text-text-muted leading-relaxed mt-1.5 whitespace-pre-wrap">{item.content}</div>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tags.map((tag, index) => (
                        <span key={`${item.id}-tag-${index}`} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-subtle">
                          <Tag size={8} aria-hidden="true" /> {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

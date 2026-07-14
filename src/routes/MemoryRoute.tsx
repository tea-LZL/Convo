import { useEffect, useState } from "react";
import { Plus, Trash2, Brain, Power, PowerOff, Search, Tag, X, Save, Sparkles, Filter, Edit3, Check, Bell } from "lucide-react";
import { api, ExtractedFact, MemoryItem, MemorySearchHit } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Tabs, TextArea, TextInput } from "../components/ui/Form";
import { Spinner } from "../components/ui/Form";
import { toast } from "../stores/toasts";
import { useMemoryStore } from "../stores/memory";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useNavigate } from "react-router-dom";

type KindFilter = "all" | "user_pref" | "project_fact" | "skill";

const KIND_LABEL: Record<KindFilter, string> = {
  all: "All",
  user_pref: "Preferences",
  project_fact: "Project facts",
  skill: "Skills",
};

const KIND_COLOR: Record<string, string> = {
  user_pref: "bg-accent/15 text-accent border-accent/30",
  project_fact: "bg-success/15 text-success border-success/30",
  skill: "bg-warn/15 text-warn border-warn/30",
};

export function MemoryRoute() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; tags: string; is_enabled: boolean }>({
    title: "",
    content: "",
    tags: "",
    is_enabled: true,
  });
  const [showExtract, setShowExtract] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractFacts, setExtractFacts] = useState<ExtractedFact[] | null>(null);
  const [selectedFacts, setSelectedFacts] = useState<Set<number>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [extractSessionId, setExtractSessionId] = useState<string | null>(null);
  const [extractSessions, setExtractSessions] = useState<Array<{ id: string; title: string; snippet: string }>>([]);
  const pendingExtracts = useMemoryStore((s) => s.pendingExtracts);
  const removePendingExtract = useMemoryStore((s) => s.removePendingExtract);
  const [reviewLocalId, setReviewLocalId] = useState<string | null>(null);
  const [reviewSelected, setReviewSelected] = useState<Set<number>>(new Set());
  const navigate = useNavigate();

  const refresh = async () => {
    const list = await api.listMemory(filter === "all" ? undefined : filter);
    setItems(list);
    setSearchHits(null);
  };

  useEffect(() => { refresh(); }, [filter]);

  useEffect(() => {
    if (!query.trim()) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api.searchMemory(query, filter === "all" ? undefined : filter);
        setSearchHits(r);
      } catch (e) { console.error(e); }
    }, 200);
    return () => clearTimeout(t);
  }, [query, filter]);

  const toggle = async (item: MemoryItem) => {
    await api.toggleMemory(item.id, !item.is_enabled);
    await refresh();
  };

  const remove = async (id: string) => {
    await api.deleteMemory(id);
    await refresh();
  };

  const startEdit = (item: MemoryItem) => {
    setEditing(item);
    setDraft({
      title: item.title ?? "",
      content: item.content,
      tags: item.tags ?? "",
      is_enabled: item.is_enabled,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!draft.content.trim()) {
      toast.error("Content cannot be empty");
      return;
    }
    await api.upsertMemory({
      id: editing.id,
      kind: editing.kind as "user_pref" | "project_fact" | "skill",
      title: draft.title || null,
      content: draft.content,
      tags: draft.tags || null,
      is_enabled: draft.is_enabled,
    });
    setEditing(null);
    await refresh();
    toast.success("Saved");
  };

  const add = async (kind: "user_pref" | "project_fact" | "skill") => {
    try {
      const id = await api.upsertMemory({
        kind,
        title: null,
        content: "",
        tags: null,
        is_enabled: true,
      });
      setShowAdd(false);
      await refresh();
      // Open the new item in the editor
      const created = (await api.listMemory(kind)).find((m) => m.id === id);
      if (created) startEdit(created);
    } catch (e) { toast.error(String(e)); }
  };

  const runExtract = async () => {
    // Step 1: show session picker. Show the most recently updated
    // 20 sessions, period. The earlier "filter out New Chat when
    // there are >5 sessions" heuristic dropped every placeholder
    // session and made the picker feel empty for users who never
    // renamed chats.
    setExtractBusy(true);
    try {
      const sessions = await api.listSessions();
      const candidates = sessions.slice(0, 20);
      if (candidates.length === 0) {
        toast.error("No chat sessions to extract from. Start a conversation first.");
        setExtractBusy(false);
        return;
      }
      setExtractSessions(
        candidates.map((s) => ({
          id: s.id,
          title: s.title || "Untitled",
          snippet: s.snippet || s.title || "(no preview)",
        }))
      );
      setExtractBusy(false);
      return;
    } catch (e) {
      toast.error(String(e));
    }
    setExtractBusy(false);
  };

  const runExtractOnSession = async (sessionId: string) => {
    setExtractSessionId(sessionId);
    setExtractBusy(true);
    try {
      const facts = await api.extractFactsFromSession(sessionId);
      setExtractFacts(facts);
      setSelectedFacts(new Set(facts.map((_, i) => i)));
    } catch (e) {
      toast.error(String(e));
    }
    setExtractBusy(false);
  };

  const saveSelectedFacts = async () => {
    if (!extractFacts) return;
    const chosen = extractFacts.filter((_, i) => selectedFacts.has(i));
    for (const f of chosen) {
      await api.upsertMemory({
        kind: f.kind as "user_pref" | "project_fact" | "skill",
        title: f.title,
        content: f.content,
        tags: f.tags,
        is_enabled: true,
      });
    }
    toast.success(`Saved ${chosen.length} memory item(s)`);
    setShowExtract(false);
    setExtractFacts(null);
    setSelectedFacts(new Set());
    await refresh();
  };

  const visible = searchHits ?? items.map((i) => ({ item: i, snippet: "" }));
  const reviewPending = reviewLocalId ? pendingExtracts.find((p) => p.localId === reviewLocalId) ?? null : null;
  const [deleteMemoryId, setDeleteMemoryId] = useState<string | null>(null);

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-surface-1/40 backdrop-blur px-4 py-3 flex items-center gap-2 flex-wrap">
        <Brain size={16} className="text-accent" />
        <h1 className="text-sm font-semibold text-text">Memory</h1>
        <span className="text-xs text-text-subtle">{items.length} item(s)</span>
        <div className="flex-1" />
        <Button size="xs" variant="secondary" icon={<Sparkles size={11} />} onClick={() => setShowExtract(true)}>
          Extract from chat
        </Button>
        <Button size="xs" variant="primary" icon={<Plus size={11} />} onClick={() => setShowAdd(true)}>
          Add
        </Button>
      </div>
      <div className="px-4 py-2 border-b border-border bg-surface-1/40 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory…"
            className="w-full bg-surface-2 border border-border rounded-md pl-8 pr-3 py-1.5 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent"
          />
        </div>
        <Tabs
          active={filter}
          onChange={(v) => setFilter(v as KindFilter)}
          tabs={[
            { id: "all", label: "All" },
            { id: "user_pref", label: "Preferences" },
            { id: "project_fact", label: "Project facts" },
            { id: "skill", label: "Skills" },
          ]}
        />
      </div>
      {pendingExtracts.length > 0 && (
        <div className="border-b border-border bg-accent/5 px-4 py-2 flex items-center gap-2 flex-wrap">
          <Bell size={12} className="text-accent shrink-0 animate-pulse-dot" />
          <span className="text-xs text-text">
            {pendingExtracts.length} pending memory review
            {pendingExtracts.length === 1 ? "" : "s"}
            {" · "}
            {pendingExtracts.reduce((n, p) => n + p.facts.length, 0)} suggested facts total
          </span>
          <div className="flex-1" />
          {pendingExtracts.map((p) => (
            <Button
              key={p.localId}
              size="xs"
              variant="secondary"
              icon={<Sparkles size={11} />}
              onClick={() => {
                setReviewLocalId(p.localId);
                setReviewSelected(new Set(p.facts.map((_, i) => i)));
              }}
              title={`From session ${p.sessionId.slice(0, 8)}…`}
            >
              Review ({p.facts.length})
            </Button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 max-w-2xl mx-auto w-full">
        {visible.length === 0 ? (
          query ? (
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
                <p className="text-xs text-text-muted mt-1">Add user preferences, project facts, and skills.
                They're included as context in every chat.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  onClick={() => add("user_pref")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-all hover:-translate-y-0.5"
                >
                  <div className="text-xs font-medium text-text mb-1">Set a preference</div>
                  <div className="text-[10px] text-text-muted">"I prefer concise replies"</div>
                </button>
                <button
                  onClick={() => add("project_fact")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-all hover:-translate-y-0.5"
                >
                  <div className="text-xs font-medium text-text mb-1">Log a project fact</div>
                  <div className="text-[10px] text-text-muted">"This repo uses Tauri v2"</div>
                </button>
                <button
                  onClick={() => add("skill")}
                  className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/30 rounded-lg p-3 text-left transition-all hover:-translate-y-0.5"
                >
                  <div className="text-xs font-medium text-text mb-1">Create a skill</div>
                  <div className="text-[10px] text-text-muted">"Run tests with `npm t` before push"</div>
                </button>
              </div>
            </div>
          )
        ) : (
          <ul className="space-y-2">
            {visible.map((entry, i) => {
              const item = entry.item;
              const tags = (item.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
              return (
                <li key={item.id} className={`bg-surface-1 border border-border rounded-lg p-3 group ${!item.is_enabled ? "opacity-50" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className={`inline-flex items-center text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${KIND_COLOR[item.kind] || KIND_COLOR.skill}`}>
                      {KIND_LABEL[item.kind as KindFilter] || item.kind}
                    </span>
                    {item.title && <div className="text-sm font-medium text-text">{item.title}</div>}
                    <div className="flex-1" />
                    <button
                      onClick={() => toggle(item)}
                      className="text-text-subtle hover:text-text p-1"
                      title={item.is_enabled ? "Disable" : "Enable"}
                    >
                      {item.is_enabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button
                      onClick={() => startEdit(item)}
                      className="text-text-subtle hover:text-text p-1"
                      title="Edit"
                    >
                      <Edit3 size={12} />
                    </button>
                    <button
                      onClick={() => setDeleteMemoryId(item.id)}
                      className="text-text-subtle hover:text-error p-1"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {entry.snippet ? (
                    <div
                      className="text-xs text-text-muted leading-relaxed mt-1.5"
                      dangerouslySetInnerHTML={{
                        __html: entry.snippet
                          .replace(/<mark>/g, '<mark class="bg-warn/30 text-text rounded px-0.5">')
                          .replace(/<\/mark>/g, '</mark>'),
                      }}
                    />
                  ) : (
                    <div className="text-xs text-text-muted leading-relaxed mt-1.5 whitespace-pre-wrap">{item.content}</div>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tags.map((t, j) => (
                        <span key={j} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-subtle">
                          <Tag size={8} /> {t}
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

      {/* Add modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add memory" size="sm">
        <div className="space-y-2">
          <p className="text-sm text-text-muted">What kind of memory?</p>
          <div className="grid grid-cols-1 gap-2">
            <Button variant="secondary" onClick={() => add("user_pref")}>User preference</Button>
            <Button variant="secondary" onClick={() => add("project_fact")}>Project fact</Button>
            <Button variant="secondary" onClick={() => add("skill")}>Skill</Button>
          </div>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit memory"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveEdit} icon={<Save size={12} />}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-2">
            <div className="text-xs text-text-muted">
              <span className={`inline-block px-1.5 py-0.5 rounded border ${KIND_COLOR[editing.kind]}`}>
                {KIND_LABEL[editing.kind as KindFilter] || editing.kind}
              </span>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Title (optional)</label>
              <TextInput value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Content</label>
              <TextArea
                value={draft.content}
                onChange={(v) => setDraft({ ...draft, content: v })}
                rows={5}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Tags (comma-separated)</label>
              <TextInput value={draft.tags} onChange={(v) => setDraft({ ...draft, tags: v })} placeholder="preference, code-style, project-x" />
            </div>
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={draft.is_enabled}
                onChange={(e) => setDraft({ ...draft, is_enabled: e.target.checked })}
                className="accent-[var(--color-accent)]"
              />
              Include in chat context
            </label>
          </div>
        )}
      </Modal>

      {/* Extract from session modal */}
      <Modal
        open={showExtract}
        onClose={() => {
          setShowExtract(false);
          setExtractFacts(null);
          setSelectedFacts(new Set());
          setExtractSessionId(null);
          setExtractSessions([]);
        }}
        title={extractSessionId ? "Extract facts from chat" : "Choose a session to extract from"}
        description={extractSessionId
          ? `Extracting facts from: ${extractSessions.find((s) => s.id === extractSessionId)?.title || extractSessionId}`
          : "Convo will ask the LLM to find durable facts in the selected session."}
        size="lg"
        footer={
          extractFacts !== null ? (
            <>
              <Button variant="ghost" onClick={() => {
                setShowExtract(false);
                setExtractFacts(null);
                setSelectedFacts(new Set());
                setExtractSessionId(null);
              }}>Cancel</Button>
              <Button variant="secondary" onClick={() => setSelectedFacts(new Set(extractFacts.map((_, i) => i)))}>Select all</Button>
              <Button variant="primary" onClick={saveSelectedFacts} disabled={selectedFacts.size === 0} icon={<Save size={12} />}>
                Save {selectedFacts.size}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => {
              setShowExtract(false);
              setExtractSessions([]);
            }}>Cancel</Button>
          )
        }
      >
        {extractFacts !== null ? (
          extractFacts.length === 0 ? (
            <div className="text-sm text-text-muted py-4 text-center">No durable facts found in this session.</div>
          ) : (
            <ul className="space-y-2">
              {extractFacts.map((f, i) => (
              <li key={i} className="bg-surface-1 border border-border rounded-md p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedFacts.has(i)}
                    onChange={(e) => {
                      const next = new Set(selectedFacts);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setSelectedFacts(next);
                    }}
                    className="accent-[var(--color-accent)] mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-block text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${KIND_COLOR[f.kind] || KIND_COLOR.skill}`}>
                        {KIND_LABEL[f.kind as KindFilter] || f.kind}
                      </span>
                      {f.title && <span className="text-xs font-medium text-text">{f.title}</span>}
                    </div>
                    <div className="text-xs text-text-muted leading-relaxed">{f.content}</div>
                    {f.tags && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {f.tags.split(",").map((t, j) => t.trim()).filter(Boolean).map((t, j) => (
                          <span key={j} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-subtle">
                            <Tag size={8} /> {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
          )
        ) : extractSessions.length > 0 ? (
          <div className="space-y-1 max-h-[50vh] overflow-y-auto">
            {extractBusy ? (
              <div className="flex items-center gap-2 py-4"><Spinner size={14} /> Loading sessions...</div>
            ) : (
              extractSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => runExtractOnSession(s.id)}
                  className="w-full text-left p-3 bg-surface-2 hover:bg-surface-3 border border-border rounded-md transition-colors"
                >
                  <div className="text-sm font-medium text-text truncate">{s.title}</div>
                  <div className="text-xs text-text-muted mt-0.5">{s.snippet}</div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="text-sm text-text-muted py-4 text-center">
            No sessions available. Start a chat first.
          </div>
        )}
      </Modal>

      {/* Pending review modal — surfaces auto-extracted facts from
          chat-done. User picks which to save as memory items. */}
      <Modal
        open={!!reviewLocalId}
        onClose={() => {
          setReviewLocalId(null);
          setReviewSelected(new Set());
        }}
        title="Review extracted facts"
        description={
          reviewPending
            ? `Auto-extracted from chat ${reviewPending.sessionId.slice(0, 8)} — pick the facts that should become memory.`
            : ""
        }
        size="lg"
        footer={
          reviewPending ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  removePendingExtract(reviewPending.localId);
                  setReviewLocalId(null);
                  setReviewSelected(new Set());
                }}
              >
                Discard all
              </Button>
              <Button
                variant="secondary"
                onClick={() => setReviewSelected(new Set(reviewPending.facts.map((_, i) => i)))}
              >
                Select all
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const chosen = reviewPending.facts.filter((_, i) => reviewSelected.has(i));
                  for (const f of chosen) {
                    await api.upsertMemory({
                      kind: f.kind as "user_pref" | "project_fact" | "skill",
                      title: f.title,
                      content: f.content,
                      tags: f.tags,
                      is_enabled: true,
                    });
                  }
                  toast.success(`Saved ${chosen.length} memory item${chosen.length === 1 ? "" : "s"}`);
                  removePendingExtract(reviewPending.localId);
                  setReviewLocalId(null);
                  setReviewSelected(new Set());
                  await refresh();
                }}
                disabled={reviewSelected.size === 0}
                icon={<Save size={12} />}
              >
                Save {reviewSelected.size}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const sid = reviewPending.sessionId;
                  setReviewLocalId(null);
                  setReviewSelected(new Set());
                  navigate(`/chat/${sid}`);
                }}
              >
                Open chat
              </Button>
            </>
          ) : null
        }
      >
        {reviewPending && (
          <ul className="space-y-2">
            {reviewPending.facts.map((f, i) => (
              <li key={i} className="bg-surface-1 border border-border rounded-md p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reviewSelected.has(i)}
                    onChange={(e) => {
                      const next = new Set(reviewSelected);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setReviewSelected(next);
                    }}
                    className="accent-[var(--color-accent)] mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`inline-block text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${
                          KIND_COLOR[f.kind] || KIND_COLOR.skill
                        }`}
                      >
                        {KIND_LABEL[f.kind as KindFilter] || f.kind}
                      </span>
                      {f.title && <span className="text-xs font-medium text-text">{f.title}</span>}
                    </div>
                    <div className="text-xs text-text-muted leading-relaxed">{f.content}</div>
                    {f.tags && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {f.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t, j) => (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-2 text-text-subtle"
                          >
                            <Tag size={8} /> {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <ConfirmDialog
        open={deleteMemoryId !== null}
        onClose={() => setDeleteMemoryId(null)}
        onConfirm={async () => {
          if (deleteMemoryId) await remove(deleteMemoryId);
          setDeleteMemoryId(null);
        }}
        title="Delete memory item"
        message="Delete this memory item? This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, Edit3, Save, Search, StickyNote, Tag, MessageSquare } from "lucide-react";
import { api, Note } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { TextArea, TextInput } from "../components/ui/Form";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { toast } from "../stores/toasts";

export function NotesRoute() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const refresh = async () => {
    const n = query.trim() ? await api.searchNotes(query) : await api.listNotes();
    setNotes(n);
    if (n.length > 0 && !activeId) {
      setActiveId(n[0].id);
      setTitle(n[0].title ?? "");
      setBody(n[0].body);
      setTags(n[0].tags ?? "");
    }
  };

  useEffect(() => { refresh(); }, [query]);

  const createNew = async () => {
    const id = await api.upsertNote({ body: "" });
    await refresh();
    setActiveId(id);
    setTitle("");
    setBody("");
    setTags("");
    setDirty(false);
  };

  const save = async () => {
    if (!activeId) return;
    await api.upsertNote({
      id: activeId,
      title: title || null,
      body,
      tags: tags || null,
    });
    setDirty(false);
    await refresh();
  };

  const remove = async (id: string) => {
    await api.deleteNote(id);
    if (activeId === id) {
      setActiveId(null);
      setTitle("");
      setBody("");
      setTags("");
    }
    await refresh();
  };

  const active = notes.find((n) => n.id === activeId);
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div className="flex-1 flex h-full min-h-0">
      <aside className="w-60 bg-surface-1 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Notes</h2>
          <Button size="xs" variant="primary" onClick={createNew} icon={<Plus size={12} />}>New</Button>
        </div>
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-surface-2 border border-border rounded-md pl-7 pr-2 py-1.5 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {notes.length === 0 ? (
            <div className="p-4 text-xs text-text-muted text-center">{query ? "No matches" : "No notes"}</div>
          ) : (
            notes.map((n) => {
              const nt = (n.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
              return (
                <button
                  key={n.id}
                  onClick={() => { if (dirty) save().catch(console.error); setActiveId(n.id); setTitle(n.title ?? ""); setBody(n.body); setTags(n.tags ?? ""); setDirty(false); }}
                  className={`w-full text-left px-3 py-2 text-xs flex flex-col gap-0.5 hover:bg-surface-2 ${n.id === activeId ? "bg-surface-2" : ""}`}
                >
                  <span className="text-text font-medium truncate">{n.title || "Untitled"}</span>
                  <span className="text-text-subtle text-[10px] truncate">{n.body.slice(0, 60) || "(empty)"}</span>
                  {(nt.length > 0 || n.source_session_id) && (
                    <span className="flex flex-wrap gap-1 mt-0.5">
                      {n.source_session_id && <MessageSquare size={9} className="text-text-subtle" />}
                      {nt.slice(0, 3).map((t, j) => (
                        <span key={j} className="text-[9px] px-1 py-0.5 rounded border border-border bg-surface-1 text-text-subtle">{t}</span>
                      ))}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        {activeId && active ? (
          <>
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border bg-surface-1/40 backdrop-blur">
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                placeholder="Title"
                className="bg-transparent text-sm font-medium text-text placeholder:text-text-subtle focus:outline-none flex-1 min-w-0"
              />
              {dirty && <span className="text-[10px] text-warn">●</span>}
              <Button size="sm" variant="ghost" onClick={() => setDeleteTargetId(activeId)} icon={<Trash2 size={12} />}>Delete</Button>
              <Button size="sm" variant="primary" onClick={save} disabled={!dirty} icon={<Save size={12} />}>Save</Button>
            </div>
            <div className="px-4 py-2 border-b border-border bg-surface-1/20 flex items-center gap-2">
              <Tag size={11} className="text-text-subtle shrink-0" />
              <input
                value={tags}
                onChange={(e) => { setTags(e.target.value); setDirty(true); }}
                placeholder="tags (comma-separated)"
                className="flex-1 bg-transparent text-xs text-text placeholder:text-text-subtle focus:outline-none"
              />
              {active.source_session_id && (
                <Link
                  to={`/chat/${active.source_session_id}`}
                  className="text-[10px] text-accent hover:underline flex items-center gap-1"
                  title="Open source chat"
                >
                  <MessageSquare size={10} /> from chat
                </Link>
              )}
            </div>
            <textarea
              value={body}
              onChange={(e) => { setBody(e.target.value); setDirty(true); }}
              placeholder="Write something…"
              className="flex-1 bg-bg text-sm text-text placeholder:text-text-subtle p-6 focus:outline-none resize-none"
            />
          </>
        ) : (
          <EmptyState
            icon={<StickyNote size={32} />}
            title="No note open"
            description="Create a new note to capture ideas. Use ⌘K → 'Search sessions' or 'Extract facts' to bring in content from your chats."
            action={<Button onClick={createNew} variant="primary" icon={<Plus size={14} />}>New note</Button>}
          />
        )}
      </div>
      <ConfirmDialog
        open={deleteTargetId !== null}
        onClose={() => setDeleteTargetId(null)}
        onConfirm={async () => {
          if (deleteTargetId) await remove(deleteTargetId);
          setDeleteTargetId(null);
        }}
        title="Delete note"
        message="Delete this note? This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Plus, Trash2, Edit3, Save, X, StickyNote } from "lucide-react";
import { api, Note } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { TextArea, TextInput } from "../components/ui/Form";
import { toast } from "../stores/toasts";

export function NotesRoute() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);

  const refresh = async () => {
    const n = await api.listNotes();
    setNotes(n);
    if (n.length > 0 && !activeId) {
      setActiveId(n[0].id);
      setTitle(n[0].title ?? "");
      setBody(n[0].body);
    }
  };

  useEffect(() => { refresh(); }, []);

  const createNew = async () => {
    const id = await api.upsertNote({ body: "" });
    await refresh();
    setActiveId(id);
    setTitle("");
    setBody("");
    setDirty(false);
  };

  const save = async () => {
    if (!activeId) return;
    await api.upsertNote({ id: activeId, title: title || null, body });
    setDirty(false);
    await refresh();
  };

  const remove = async (id: string) => {
    await api.deleteNote(id);
    if (activeId === id) {
      setActiveId(null);
      setTitle("");
      setBody("");
    }
    await refresh();
  };

  return (
    <div className="flex-1 flex h-full min-h-0">
      <aside className="w-60 bg-surface-1 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Notes</h2>
          <Button size="xs" variant="primary" onClick={createNew} icon={<Plus size={12} />}>New</Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {notes.length === 0 ? (
            <div className="p-4 text-xs text-text-muted text-center">No notes</div>
          ) : (
            notes.map((n) => (
              <button
                key={n.id}
                onClick={() => { if (dirty) save().catch(console.error); setActiveId(n.id); setTitle(n.title ?? ""); setBody(n.body); setDirty(false); }}
                className={`w-full text-left px-3 py-2 text-xs flex flex-col gap-0.5 hover:bg-surface-2 ${n.id === activeId ? "bg-surface-2" : ""}`}
              >
                <span className="text-text font-medium truncate">{n.title || "Untitled"}</span>
                <span className="text-text-subtle text-[10px] truncate">{n.body.slice(0, 60) || "(empty)"}</span>
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        {activeId ? (
          <>
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border bg-surface-1/40 backdrop-blur">
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                placeholder="Title"
                className="bg-transparent text-sm font-medium text-text placeholder:text-text-subtle focus:outline-none flex-1"
              />
              {dirty && <span className="text-[10px] text-warn">●</span>}
              <Button size="sm" variant="ghost" onClick={() => remove(activeId)} icon={<Trash2 size={12} />}>Delete</Button>
              <Button size="sm" variant="primary" onClick={save} disabled={!dirty} icon={<Save size={12} />}>Save</Button>
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
            description="Create a new note to capture ideas."
            action={<Button onClick={createNew} variant="primary" icon={<Plus size={14} />}>New note</Button>}
          />
        )}
      </div>
    </div>
  );
}

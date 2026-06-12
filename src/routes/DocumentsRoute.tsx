import { useEffect, useState } from "react";
import { FileText, Plus, Trash2, Edit3, Save, X, Download } from "lucide-react";
import { api, Document } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { toast } from "../stores/toasts";

export function DocumentsRoute() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);

  const refresh = async () => {
    const d = await api.listDocuments();
    setDocs(d);
    if (d.length > 0 && !activeId) {
      setActiveId(d[0].id);
      setTitle(d[0].title);
      setContent(d[0].content);
    }
  };

  useEffect(() => { refresh(); }, []);

  const active = docs.find((d) => d.id === activeId);

  const createNew = async () => {
    try {
      const id = await api.upsertDocument({ title: "Untitled", content: "", kind: "markdown" });
      await refresh();
      setActiveId(id);
      setTitle("Untitled");
      setContent("");
      setDirty(false);
    } catch (e) { toast.error(String(e)); }
  };

  const save = async () => {
    if (!activeId) return;
    try {
      await api.upsertDocument({ id: activeId, title: title || "Untitled", content, kind: "markdown" });
      setDirty(false);
      await refresh();
      toast.success("Saved");
    } catch (e) { toast.error(String(e)); }
  };

  const remove = async (id: string) => {
    await api.deleteDocument(id);
    if (activeId === id) {
      setActiveId(null);
      setContent("");
      setTitle("");
    }
    await refresh();
  };

  const exportDoc = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex h-full min-h-0">
      <aside className="w-60 bg-surface-1 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Documents</h2>
          <Button size="xs" variant="primary" onClick={createNew} icon={<Plus size={12} />}>New</Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {docs.length === 0 ? (
            <div className="p-4 text-xs text-text-muted text-center">No documents yet</div>
          ) : (
            docs.map((d) => (
              <button
                key={d.id}
                onClick={() => { if (dirty) save().catch(console.error); setActiveId(d.id); setTitle(d.title); setContent(d.content); setDirty(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-1.5 hover:bg-surface-2 ${d.id === activeId ? "bg-surface-2 text-text" : "text-text-muted"}`}
              >
                <FileText size={11} className="shrink-0" />
                <span className="truncate flex-1">{d.title}</span>
                <button onClick={(e) => { e.stopPropagation(); remove(d.id); }} className="text-text-subtle hover:text-error opacity-0 group-hover:opacity-100">
                  <Trash2 size={10} />
                </button>
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
                className="bg-transparent text-sm font-medium text-text focus:outline-none flex-1"
              />
              {dirty && <span className="text-[10px] text-warn">● unsaved</span>}
              <Button size="sm" variant="ghost" onClick={exportDoc} icon={<Download size={12} />}>Export</Button>
              <Button size="sm" variant="primary" onClick={save} disabled={!dirty} icon={<Save size={12} />}>Save</Button>
            </div>
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              placeholder="Start writing… (markdown supported)"
              className="flex-1 bg-bg text-sm text-text placeholder:text-text-subtle p-6 focus:outline-none resize-none font-mono"
            />
          </>
        ) : (
          <EmptyState
            icon={<FileText size={32} />}
            title="No document open"
            description="Create a new document or select one from the sidebar."
            action={<Button onClick={createNew} variant="primary" icon={<Plus size={14} />}>New document</Button>}
          />
        )}
      </div>
    </div>
  );
}

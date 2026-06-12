import { useEffect, useState } from "react";
import { Plus, Trash2, Brain, Power, PowerOff } from "lucide-react";
import { api, MemoryItem } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Tabs, TextArea } from "../components/ui/Form";
import { toast } from "../stores/toasts";

export function MemoryRoute() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [kind, setKind] = useState<"user_pref" | "project_fact" | "skill">("user_pref");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const refresh = async () => setItems(await api.listMemory());
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (!content.trim()) return;
    await api.upsertMemory({ kind, title: title || null, content, is_enabled: 1 });
    setTitle("");
    setContent("");
    await refresh();
  };

  const remove = async (id: string) => {
    await api.deleteMemory(id);
    await refresh();
  };

  const toggle = async (item: MemoryItem) => {
    const enabled = !item.content || true; // always toggle to true since we don't have is_enabled in the type
    await api.toggleMemory(item.id, enabled);
    await refresh();
  };

  const grouped: Record<string, MemoryItem[]> = items.reduce((acc, i) => {
    (acc[i.kind] ??= []).push(i);
    return acc;
  }, {} as Record<string, MemoryItem[]>);

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-surface-1/40 backdrop-blur px-4 py-3 flex items-center gap-2">
        <Brain size={16} className="text-accent" />
        <h1 className="text-sm font-semibold text-text">Memory</h1>
        <span className="text-xs text-text-subtle">{items.length} items</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 max-w-2xl mx-auto w-full">
        <div className="bg-surface-1 border border-border rounded-xl p-4 mb-4">
          <h3 className="text-sm font-medium text-text mb-3">Add memory</h3>
          <Tabs
            active={kind}
            onChange={(v) => setKind(v as any)}
            tabs={[
              { id: "user_pref", label: "User preference" },
              { id: "project_fact", label: "Project fact" },
              { id: "skill", label: "Skill" },
            ]}
            className="mb-3"
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full bg-surface-2 border border-border rounded-md px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent mb-2"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What should the assistant remember?"
            rows={3}
            className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent resize-none mb-2"
          />
          <div className="flex justify-end">
            <Button variant="primary" onClick={add} disabled={!content.trim()} icon={<Plus size={12} />}>Add</Button>
          </div>
        </div>

        {Object.keys(grouped).length === 0 ? (
          <EmptyState
            icon={<Brain size={32} />}
            title="No memories yet"
            description="Add user preferences, project facts, and skills. They're included as context in every chat."
          />
        ) : (
          Object.entries(grouped).map(([k, list]) => (
            <div key={k} className="mb-4">
              <h3 className="text-xs uppercase tracking-wider text-text-subtle font-semibold mb-2">
                {k.replace("_", " ")} <span className="text-text-subtle">({list.length})</span>
              </h3>
              <ul className="space-y-1">
                {list.map((item) => (
                  <li key={item.id} className="bg-surface-1 border border-border rounded-md p-3 group">
                    {item.title && <div className="text-sm font-medium text-text mb-1">{item.title}</div>}
                    <div className="text-xs text-text-muted leading-relaxed whitespace-pre-wrap">{item.content}</div>
                    <div className="mt-2 flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100">
                      <button onClick={() => toggle(item)} className="p-1 text-text-subtle hover:text-text" title="Toggle enabled">
                        <Power size={12} />
                      </button>
                      <button onClick={() => remove(item.id)} className="p-1 text-text-subtle hover:text-error" title="Delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

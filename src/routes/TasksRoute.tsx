import { useEffect, useState } from "react";
import { Check, Plus, Trash2, ListTodo, Calendar } from "lucide-react";
import { api, Task } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { TextInput } from "../components/ui/Form";
import { toast } from "../stores/toasts";

export function TasksRoute() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [showCompleted, setShowCompleted] = useState(true);

  const refresh = async () => {
    const t = await api.listTasks();
    setTasks(t);
  };

  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (!newTitle.trim()) return;
    await api.upsertTask({ title: newTitle.trim() });
    setNewTitle("");
    await refresh();
  };

  const toggle = async (t: Task) => {
    const completed = t.completed_at === null;
    await api.completeTask(t.id, completed);
    await refresh();
  };

  const remove = async (id: string) => {
    await api.deleteTask(id);
    await refresh();
  };

  const visible = tasks.filter((t) => showCompleted || t.completed_at === null);
  const open = tasks.filter((t) => t.completed_at === null);
  const done = tasks.filter((t) => t.completed_at !== null);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="border-b border-border bg-surface-1/40 backdrop-blur px-4 py-3 flex items-center gap-3">
        <ListTodo size={16} className="text-accent" />
        <h1 className="text-sm font-semibold text-text">Tasks</h1>
        <span className="text-xs text-text-subtle">{open.length} open · {done.length} done</span>
        <div className="flex-1" />
        <label className="text-xs text-text-muted flex items-center gap-1.5">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed
        </label>
      </div>
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 max-w-2xl mx-auto w-full">
        <div className="flex gap-2 mb-4">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="New task…"
            className="flex-1 bg-surface-2 border border-border rounded-md px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent"
          />
          <Button variant="primary" onClick={add} icon={<Plus size={14} />}>Add</Button>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            icon={<ListTodo size={32} />}
            title="No tasks"
            description="Add a task to keep yourself on track. Tasks can be created from chat with /task."
          />
        ) : (
          <ul className="space-y-1">
            {visible.map((t) => (
              <li key={t.id} className={`flex items-center gap-2 px-3 py-2 bg-surface-1 border border-border rounded-md group ${t.completed_at ? "opacity-60" : ""}`}>
                <button
                  onClick={() => toggle(t)}
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${t.completed_at ? "bg-accent border-accent" : "border-border-strong hover:border-accent"}`}
                >
                  {t.completed_at && <Check size={10} className="text-white" />}
                </button>
                <span className={`flex-1 text-sm ${t.completed_at ? "line-through text-text-muted" : "text-text"}`}>
                  {t.title}
                </span>
                {t.due_at && <span className="text-[10px] text-text-subtle flex items-center gap-1"><Calendar size={9} />{new Date(t.due_at).toLocaleDateString()}</span>}
                <button onClick={() => remove(t.id)} className="text-text-subtle hover:text-error opacity-0 group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

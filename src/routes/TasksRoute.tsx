import { useEffect, useState } from "react";
import { Calendar, Check, Edit3, ListTodo, Plus, Save, Trash2, X } from "lucide-react";
import { api, Task } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Select, TextArea, TextInput, Badge } from "../components/ui/Form";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { toast } from "../stores/toasts";

interface TaskDraft {
  title: string;
  body: string;
  dueAt: string;
  priority: string;
}

const EMPTY_DRAFT: TaskDraft = { title: "", body: "", dueAt: "", priority: "0" };
const PRIORITIES = [
  { value: "0", label: "Low" },
  { value: "1", label: "Normal" },
  { value: "2", label: "High" },
  { value: "3", label: "Urgent" },
];

function taskDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    body: task.body ?? "",
    dueAt: task.due_at ? task.due_at.slice(0, 10) : "",
    priority: String(task.priority),
  };
}

function isOverdue(task: Task): boolean {
  return task.completed_at === null && !!task.due_at && new Date(task.due_at).getTime() < Date.now();
}

export function TasksRoute() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [showCompleted, setShowCompleted] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await api.listTasks());
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Tasks could not be loaded");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const add = async () => {
    if (!draft.title.trim()) {
      setError("Task title cannot be empty");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await api.upsertTask({
        title: draft.title.trim(),
        body: draft.body || null,
        due_at: draft.dueAt || null,
        priority: Number(draft.priority),
      });
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Task could not be created");
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (task: Task) => {
    setSavingId(task.id);
    try {
      await api.completeTask(task.id, task.completed_at === null);
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Task status could not be changed");
    } finally {
      setSavingId(null);
    }
  };

  const saveEdit = async (task: Task) => {
    if (!editDraft.title.trim()) {
      setError("Task title cannot be empty");
      return;
    }
    setSavingId(task.id);
    try {
      await api.upsertTask({
        id: task.id,
        title: editDraft.title.trim(),
        body: editDraft.body || null,
        due_at: editDraft.dueAt || null,
        completed_at: task.completed_at,
        priority: Number(editDraft.priority),
        session_id: task.session_id,
      });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Task could not be saved");
    } finally {
      setSavingId(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSavingId(deleteTarget.id);
    try {
      await api.deleteTask(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Task could not be deleted");
    } finally {
      setSavingId(null);
    }
  };

  const open = tasks.filter((task) => task.completed_at === null);
  const done = tasks.filter((task) => task.completed_at !== null);
  const visible = tasks.filter((task) => {
    if (!showCompleted && task.completed_at !== null) return false;
    if (filter === "open" && task.completed_at !== null) return false;
    if (filter === "done" && task.completed_at === null) return false;
    if (overdueOnly && !isOverdue(task)) return false;
    return true;
  });

  return (
    <RouteShell
      title="Tasks"
      description={`${open.length} open · ${done.length} done`}
      actions={
        <>
        {(["all", "open", "done"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`px-2 py-1 rounded text-xs ${filter === value ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-2"}`}
          >
            {value === "all" ? "All" : value === "open" ? "Open" : "Completed"}
          </button>
        ))}
        <label className="text-xs text-text-muted flex items-center gap-1.5">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue
        </label>
        <label className="text-xs text-text-muted flex items-center gap-1.5">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed
        </label>
        </>
      }
    >
      <div className="p-3 sm:p-4 max-w-3xl mx-auto w-full">
        <div className="mb-4 rounded-lg border border-border bg-surface-1 p-3 space-y-2">
          <div className="flex gap-2">
            <TextInput
              aria-label="New task title"
              value={draft.title}
              onChange={(title) => setDraft((current) => ({ ...current, title }))}
              onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
              placeholder="New task…"
              autoFocus={false}
            />
            <Button variant="primary" onClick={() => void add()} loading={creating} icon={<Plus size={14} />}>Add</Button>
          </div>
          <TextArea aria-label="New task details" value={draft.body} onChange={(body) => setDraft((current) => ({ ...current, body }))} placeholder="Details (optional)" rows={2} />
          <div className="flex gap-2 flex-wrap">
            <input aria-label="New task due date" type="date" value={draft.dueAt} onChange={(e) => setDraft((current) => ({ ...current, dueAt: e.target.value }))} className="bg-surface-2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text" />
            <Select aria-label="New task priority" value={draft.priority} onChange={(priority) => setDraft((current) => ({ ...current, priority }))} options={PRIORITIES} />
          </div>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            <span>{error}</span>
            <button type="button" className="ml-2 underline" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {loading ? (
          <div className="p-6 text-center text-sm text-text-muted">Loading tasks…</div>
        ) : visible.length === 0 ? (
          <EmptyState icon={<ListTodo size={32} />} title="No tasks" description="Add a task to keep yourself on track. Tasks can be created from chat with /task." />
        ) : (
          <ul className="space-y-2">
            {visible.map((task) => (
              <li key={task.id} className={`px-3 py-2 bg-surface-1 border border-border rounded-md ${task.completed_at ? "opacity-60" : ""}`}>
                {editingId === task.id ? (
                  <div className="space-y-2">
                    <TextInput aria-label={`Title for ${task.title}`} value={editDraft.title} onChange={(title) => setEditDraft((current) => ({ ...current, title }))} autoFocus />
                    <TextArea aria-label={`Details for ${task.title}`} value={editDraft.body} onChange={(body) => setEditDraft((current) => ({ ...current, body }))} rows={2} />
                    <div className="flex gap-2 flex-wrap">
                      <input aria-label={`Due date for ${task.title}`} type="date" value={editDraft.dueAt} onChange={(e) => setEditDraft((current) => ({ ...current, dueAt: e.target.value }))} className="bg-surface-2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text" />
                      <Select aria-label={`Priority for ${task.title}`} value={editDraft.priority} onChange={(priority) => setEditDraft((current) => ({ ...current, priority }))} options={PRIORITIES} />
                      <div className="flex-1" />
                      <Button size="xs" variant="ghost" onClick={() => setEditingId(null)} icon={<X size={12} />}>Cancel</Button>
                      <Button size="xs" variant="primary" loading={savingId === task.id} onClick={() => void saveEdit(task)} icon={<Save size={12} />}>Save</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      aria-label={task.completed_at ? `Reopen ${task.title}` : `Complete ${task.title}`}
                      disabled={savingId === task.id}
                      onClick={() => void toggle(task)}
                      className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors ${task.completed_at ? "bg-accent border-accent" : "border-border-strong hover:border-accent"}`}
                    >
                      {task.completed_at && <Check size={10} className="text-white" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm ${task.completed_at ? "line-through text-text-muted" : "text-text"}`}>{task.title}</span>
                        {task.priority > 0 && <Badge variant={task.priority >= 3 ? "error" : task.priority >= 2 ? "warn" : "default"}>{PRIORITIES[task.priority]?.label ?? "Priority"}</Badge>}
                        {isOverdue(task) && <Badge variant="error">overdue</Badge>}
                      </div>
                      {task.body && <p className="mt-1 text-xs text-text-muted whitespace-pre-wrap">{task.body}</p>}
                      {task.due_at && <span className="mt-1 text-[10px] text-text-subtle flex items-center gap-1"><Calendar size={9} />{new Date(task.due_at).toLocaleDateString()}</span>}
                    </div>
                    <Button size="xs" variant="ghost" aria-label={`Edit ${task.title}`} onClick={() => { setEditingId(task.id); setEditDraft(taskDraft(task)); }} icon={<Edit3 size={12} />} />
                    <Button size="xs" variant="ghost" aria-label={`Delete ${task.title}`} onClick={() => setDeleteTarget(task)} icon={<Trash2 size={12} />} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title="Delete task"
        message={`Delete ${deleteTarget?.title ?? "this task"}? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </RouteShell>
  );
}

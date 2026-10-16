/**
 * Tasks — the second of the two compact-rhythm pages, with Documents.
 *
 * ── Why this page is dense ─────────────────────────────────────────────
 * A task list is the one place in the app where the number of rows is the
 * whole point: what is due today, what is late, what is left. Same tokens,
 * same 1px border, same theme radius, same colours as every other page —
 * 4px between rows and 8px inside one, where the standard rhythm gives 8
 * and 12. The split is deliberate, it is not a toggle, and it is
 * *measured* rather than declared: `TasksRoute.test.tsx` compiles this
 * file's classes through the project Tailwind and reads the resolved gap
 * and padding, and resolves the standard rhythm the same way so it can
 * show the measurement tells the two apart. A test that read `space-y-1`
 * off the DOM would break on a retune and pass on any page that merely
 * said it.
 *
 * Two lists take the compact rhythm, and the test measures both: the task
 * rows themselves, and the three field groups inside the composer. The
 * 16px `mb-3` between the composer and the list does *not* — a boundary
 * between two sections is not a row, and a section break that reads as a
 * row gap is how a dense page becomes an unreadable one.
 *
 * ── What is deliberately not here ───────────────────────────────────────
 * No shadow, and no transition inside the list. A task list is the subtree
 * that scales to hundreds of rows, which is the same reason the streaming
 * subtree is fenced and the same reason `MemoryRoute` drops its row
 * transitions. The only `box-shadow` in the app belongs to things that
 * genuinely float — the delete confirmation — and focus rings are the
 * exception to flatness, each behind a state, because Tailwind builds
 * `ring-*` out of `box-shadow` and an unscoped ring would paint a shadow on
 * every row at rest while the flatness check called the page clean.
 *
 * ── The two row controls ──────────────────────────────────────────────
 * `IconButton` would have been the obvious choice and it is not used: it
 * carries an unconditional `transition-colors`, and putting one on every
 * row of a list that scales to hundreds is the thing this page is deciding
 * not to do. They are `ROW_ACTION` from `components/ui/rowAction`, which
 * is where the reasoning for 24px, for `focus-visible:` and for the
 * absence of a transition lives — and which the other four pages import
 * rather than re-spell, so five pages of row controls cannot drift apart.
 */
import { useEffect, useState } from "react";
import { Calendar, Check, Edit3, ListTodo, Plus, Save, Trash2, X } from "lucide-react";
import { api, Task } from "../lib/api";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Select, TextArea, TextInput, Badge } from "../components/ui/Form";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { ROW_ACTION, ROW_ACTION_IDLE } from "../components/ui/rowAction";
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
        {/* Three sizes so this filter reads as the same control as the two
            `Button`s in the cluster's own header rather than as a second
            design system: 10px/2px of padding against the buttons' 12px and
            10px, and no focus ring at all. The test compares the two sets
            of *resolved* values rather than the two sets of class names, so
            a retune of the scale keeps the comparison honest. */}
        {(["all", "open", "done"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`px-2.5 py-1 text-xs rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              filter === value ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {value === "all" ? "All" : value === "open" ? "Open" : "Completed"}
          </button>
        ))}
        {/* `accent-[var(--color-accent)]` is how a native checkbox takes the
            theme's accent — a var, not a literal, and the same expression
            the Memory page's checkboxes use. */}
        <label className="text-xs text-text-muted flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="accent-[var(--color-accent)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          />
          Overdue
        </label>
        <label className="text-xs text-text-muted flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="accent-[var(--color-accent)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          />
          Show completed
        </label>
        </>
      }
    >
      {/* 48rem, the measure the Memory page's column uses and the reason it
          uses it: roughly 75 characters of the title and body a task row
          carries, and the only thing standing between a row and a 2000px
          line on a wide monitor. */}
      <div className="p-4 max-w-2xl mx-auto w-full">
        {/* The page's other compact list: three field groups, 4px between
            them and 8px inside the card. The `mb-3` to the task list below
            is a section boundary rather than a row gap, so it stays at 12px
            — a boundary that reads as a row is how a dense page becomes an
            unreadable one. */}
        <div className="mb-3 rounded-lg border border-border bg-surface-1 p-2 space-y-1">
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
            <input aria-label="New task due date" type="date" value={draft.dueAt} onChange={(e) => setDraft((current) => ({ ...current, dueAt: e.target.value }))} className="bg-surface-2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg" />
            <Select aria-label="New task priority" value={draft.priority} onChange={(priority) => setDraft((current) => ({ ...current, priority }))} options={PRIORITIES} />
          </div>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            <span>{error}</span>
            <button type="button" className="ml-2 underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {loading ? (
          <div className="p-6 text-center text-sm text-text-muted">Loading tasks…</div>
        ) : visible.length === 0 ? (
          // `RouteShell` owns this page's h1, so the title underneath it
          // is an h2 — an h3 here would be a skipped level.
          <EmptyState headingLevel={2} icon={<ListTodo size={28} />} title="No tasks" description="Add a task to keep yourself on track. Tasks can be created from chat with /task." />
        ) : (
          <ul className="space-y-1">
            {visible.map((task) => (
              <li key={task.id} className={`p-2 bg-surface-1 border border-border rounded-md ${task.completed_at ? "opacity-60" : ""}`}>
                {editingId === task.id ? (
                  <div className="space-y-2">
                    <TextInput aria-label={`Title for ${task.title}`} value={editDraft.title} onChange={(title) => setEditDraft((current) => ({ ...current, title }))} autoFocus />
                    <TextArea aria-label={`Details for ${task.title}`} value={editDraft.body} onChange={(body) => setEditDraft((current) => ({ ...current, body }))} rows={2} />
                    <div className="flex gap-2 flex-wrap">
                      <input aria-label={`Due date for ${task.title}`} type="date" value={editDraft.dueAt} onChange={(e) => setEditDraft((current) => ({ ...current, dueAt: e.target.value }))} className="bg-surface-2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg" />
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
                      // `aria-pressed` to match the label's polarity, and
                      // for the same reason as the session toggles in the
                      // sidebar: "Reopen" is only offered because the task
                      // *is* done, so the label already implies the state
                      // and the state has to be announced with it. Found by
                      // `stateAgreement.test.tsx`; pre-existing.
                      aria-pressed={!!task.completed_at}
                      aria-label={task.completed_at ? `Reopen ${task.title}` : `Complete ${task.title}`}
                      disabled={savingId === task.id}
                      onClick={() => void toggle(task)}
                      // 24px rather than 16px, for the target size — and
                      // `rounded-sm` rather than a bare `rounded`, so the box
                      // follows the theme's corner the way every other box
                      // on this page does. No `transition-colors`: this is a
                      // list row, and the list is the subtree that scales.
                      className={`mt-0.5 h-6 w-6 shrink-0 rounded-sm border flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${task.completed_at ? "bg-accent border-accent" : "border-border-strong hover:border-accent"}`}
                    >
                      {task.completed_at && <Check size={12} className="text-white" aria-hidden="true" />}
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
                    <button
                      type="button"
                      aria-label={`Edit ${task.title}`}
                      title="Edit"
                      onClick={() => { setEditingId(task.id); setEditDraft(taskDraft(task)); }}
                      className={`${ROW_ACTION} ${ROW_ACTION_IDLE}`}
                    >
                      <Edit3 size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${task.title}`}
                      title="Delete"
                      onClick={() => setDeleteTarget(task)}
                      className={`${ROW_ACTION} text-text-subtle hover:text-error`}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
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

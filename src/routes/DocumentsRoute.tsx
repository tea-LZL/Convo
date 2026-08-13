/**
 * Documents route — multi-tab editor with AI edit assist, Tauri file open/save,
 * Insert into chat.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { FileText, Plus, Trash2, Download, Upload, Sparkles, X, Check, Save, MoreHorizontal, Eye, Edit3, MessageSquarePlus } from "lucide-react";
import { api, Document } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { TextArea, TextInput } from "../components/ui/Form";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RouteShell } from "../components/ui/RouteShell";
import { diffLines, diffStats } from "../lib/diff";
import { escapeThinkTags } from "../components/chat/MessageRow";
import { toast } from "../stores/toasts";

interface Tab {
  id: string;
  title: string;
  content: string;
  dirty: boolean;
  /** If loaded from disk, remember the path for save-in-place. */
  diskPath: string | null;
  /** True when content matches the persisted DB copy. */
  savedToDb: boolean;
}

export function DocumentsRoute() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAiEdit, setShowAiEdit] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [pendingDiff, setPendingDiff] = useState<{ original: string; proposed: string; instruction: string } | null>(null);
  const [selection, setSelection] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Tab | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [externalChange, setExternalChange] = useState<{ id: string; content: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.listDocuments();
      setTabs((prevTabs) => {
        // Keep open tabs in sync with the DB without overwriting drafts.
        const known = new Map(d.map((x) => [x.id, x]));
        const next: Tab[] = [];
        for (const t of prevTabs) {
          if (!t.diskPath) {
            const fresh = known.get(t.id);
            if (fresh) {
              next.push(t.dirty ? t : { ...t, content: fresh.content, title: fresh.title, savedToDb: true });
              known.delete(t.id);
            } else if (t.dirty) {
              next.push(t);
            }
          } else {
            next.push(t);
          }
        }
        for (const [id, doc] of known) {
          next.push({ id, title: doc.title, content: doc.content, dirty: false, diskPath: null, savedToDb: true });
        }
        return next;
      });
      setActiveId((current) => current ?? d[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Documents could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = tabs.find((t) => t.id === activeId);

  const createNew = useCallback(async () => {
    try {
      const id = await api.upsertDocument({ title: "Untitled", content: "", kind: "markdown" });
      await refresh();
      setActiveId(id);
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "Document could not be created");
    }
  }, [refresh]);

  const updateActive = (patch: Partial<Tab>) => {
    if (!activeId) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== activeId) return t;
        const next = { ...t, ...patch };
        return { ...next, dirty: patch.dirty ?? (!patch.savedToDb ? true : t.dirty) };
      })
    );
  };

  const save = useCallback(async (id: string = activeId!) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    try {
      if (t.diskPath) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(t.diskPath, t.content);
        setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, dirty: false, savedToDb: true } : x)));
        toast.success("Saved to disk");
      } else {
        await api.upsertDocument({ id, title: t.title || "Untitled", content: t.content, kind: "markdown" });
        setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, dirty: false, savedToDb: true } : x)));
        toast.success("Saved");
      }
    } catch (e) {
      setError(String(e));
      toast.error(String(e));
    }
  }, [tabs, activeId]);

  const saveAll = useCallback(async () => {
    const dirty = tabs.filter((t) => t.dirty);
    const savedIds: string[] = [];
    const failures: string[] = [];
    setSavingAll(true);
    for (const t of dirty) {
      try {
        if (t.diskPath) {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          await writeTextFile(t.diskPath, t.content);
        } else {
          await api.upsertDocument({ id: t.id, title: t.title, content: t.content, kind: "markdown" });
        }
        savedIds.push(t.id);
      } catch (e) {
        failures.push(`${t.title || "Untitled"}: ${String(e)}`);
      }
    }
    setTabs((prev) => prev.map((t) => savedIds.includes(t.id) ? { ...t, dirty: false, savedToDb: true } : t));
    await refresh();
    setSavingAll(false);
    if (failures.length > 0) {
      setError(failures.join("\n"));
      toast.error(`${failures.length} document(s) could not be saved`);
    } else {
      toast.success(`Saved ${dirty.length} document(s)`);
    }
  }, [tabs, refresh]);

  const performDelete = async (t: Tab) => {
    if (!t.diskPath) {
      try {
        await api.deleteDocument(t.id);
      } catch (e) {
        setError(String(e));
        toast.error(String(e), "Document could not be deleted");
        return false;
      }
    }
    setTabs((prev) => prev.filter((x) => x.id !== t.id));
    if (activeId === t.id) setActiveId(null);
    await refresh();
    return true;
  };

  const remove = async (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (t.dirty) {
      setDeleteTarget(t);
      return;
    }
    await performDelete(t);
  };

  const openFromDisk = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Text", extensions: ["md", "txt", "markdown", "json", "yaml", "yml", "toml", "csv", "ts", "tsx", "js", "jsx", "py", "rs", "go", "sh", "html", "css"] },
        ],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      const content = await readTextFile(path);
      const fileName = path.split("/").pop() || "Untitled";
      // Open as unsaved tab pointing at the disk path
      const id = `disk:${path}`;
      setTabs((prev) => {
        if (prev.find((t) => t.id === id)) {
          setActiveId(id);
          return prev;
        }
        return [
          ...prev,
          { id, title: fileName, content, dirty: false, diskPath: path, savedToDb: true },
        ];
      });
      setActiveId(id);
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "File could not be opened");
    }
  };

  const saveToDisk = async () => {
    if (!active || !active.diskPath) return;
    try {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(active.diskPath, active.content);
      setTabs((prev) => prev.map((t) => (t.id === active.id ? { ...t, dirty: false, savedToDb: true } : t)));
      toast.success("Saved to disk");
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "File could not be saved");
    }
  };

  useEffect(() => {
    if (!active?.diskPath) return;
    let cancelled = false;
    const checkExternalChange = async () => {
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const content = await readTextFile(active.diskPath!);
        if (cancelled || content === active.content) return;
        if (active.dirty) {
          setExternalChange({ id: active.id, content });
        } else {
          setTabs((prev) => prev.map((tab) => tab.id === active.id ? { ...tab, content, savedToDb: true } : tab));
        }
      } catch {
        // File watching is best effort; explicit save reports write errors.
      }
    };
    const timer = setInterval(() => { void checkExternalChange(); }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active?.id, active?.diskPath, active?.content, active?.dirty]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tabs]);

  const exportDoc = async () => {
    if (!active) return;
    const blob = new Blob([active.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.title || "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runAiEdit = async () => {
    if (!active || !aiInstruction.trim()) return;
    setAiBusy(true);
    try {
      const proposed = await api.aiEditDocument({
        currentText: active.content,
        instruction: aiInstruction,
        selection: selection || null,
      });
      setPendingDiff({ original: active.content, proposed, instruction: aiInstruction });
      setShowAiEdit(false);
    } catch (e) {
      setError(String(e));
      toast.error(String(e), "AI edit failed");
    }
    setAiBusy(false);
  };

  const acceptDiff = () => {
    if (!pendingDiff || !activeId) return;
    updateActive({ content: pendingDiff.proposed });
    setPendingDiff(null);
    setAiInstruction("");
    setSelection("");
    toast.success("Edit applied");
  };

  const rejectDiff = () => {
    setPendingDiff(null);
    setAiInstruction("");
    setSelection("");
  };

  const insertIntoChat = () => {
    if (!active) return;
    const sel = selection || active.content;
    const event = new CustomEvent("convo:insert-into-chat", { detail: { text: sel, title: active.title } });
    window.dispatchEvent(event);
    toast.info("Inserted into chat composer");
  };

  // Track selection in the textarea
  const onSelect = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) {
      setSelection(ta.value.slice(start, end));
    } else {
      setSelection("");
    }
  };

  // Save shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeId) save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeId, save]);

  // Debounced autosave --- save to DB 2s after last edit
  useEffect(() => {
    if (!active || !active.dirty || active.diskPath) return;
    const timer = setTimeout(() => {
      save(active.id);
    }, 2000);
    return () => clearTimeout(timer);
  }, [active?.content, active?.dirty, active?.diskPath, active?.id, save]);

  if (loading && tabs.length === 0) {
    return (
      <RouteShell title="Documents" description="Edit Markdown documents locally and safely.">
        <div role="status" className="flex h-full items-center justify-center text-sm text-text-muted">Loading documents…</div>
      </RouteShell>
    );
  }

  if (tabs.length === 0) {
    return (
      <RouteShell
        title="Documents"
        description="Edit Markdown documents locally and safely."
        contentClassName="overflow-hidden"
        actions={
          <>
            <Button size="sm" variant="primary" onClick={() => void createNew()} icon={<Plus size={12} />}>New</Button>
            <Button size="sm" variant="secondary" onClick={() => void openFromDisk()} icon={<Upload size={12} />}>Open from disk</Button>
          </>
        }
      >
        <div className="h-full flex flex-col items-center justify-center p-4">
          {error && (
            <div role="alert" className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              {error}
              <button type="button" className="ml-2 underline" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          <EmptyState
            icon={<FileText size={32} />}
            title="No document open"
            description="Create a new document or open one from disk."
          />
        </div>
      </RouteShell>
    );
  }

  return (
    <RouteShell
      title="Documents"
      description="Edit Markdown documents locally and safely."
      contentClassName="overflow-hidden"
      actions={
        <>
          <Button size="sm" variant="primary" onClick={() => void createNew()} icon={<Plus size={12} />}>New</Button>
          <Button size="sm" variant="secondary" onClick={() => void openFromDisk()} icon={<Upload size={12} />}>Open from disk</Button>
          {tabs.some((t) => t.dirty) && (
            <Button size="sm" variant="ghost" onClick={() => void saveAll()} loading={savingAll} icon={<Save size={11} />}>
              Save all
            </Button>
          )}
        </>
      }
    >
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div role="tablist" aria-label="Open documents" className="flex items-center gap-1 px-2 h-10 border-b border-border bg-surface-1 overflow-x-auto">
        {tabs.map((t) => (
          <div key={t.id} className="flex items-center gap-1 rounded-t-md shrink-0">
            <button
              id={`document-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={t.id === activeId}
              aria-controls={`document-panel-${t.id}`}
              tabIndex={t.id === activeId ? 0 : -1}
              onClick={() => setActiveId(t.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveId(t.id);
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-b-2 transition-colors ${
                t.id === activeId
                  ? "bg-surface-2 text-text border-b-accent"
                  : "text-text-muted border-b-transparent hover:bg-surface-2 hover:text-text"
              }`}
            >
              <FileText size={11} className="text-text-subtle shrink-0" aria-hidden="true" />
              <span className="truncate max-w-[140px]">{t.title || "Untitled"}</span>
              {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-label="Unsaved changes" />}
            </button>
            <button
              type="button"
              onClick={() => void remove(t.id)}
              className="text-text-subtle hover:text-error px-0.5 rounded"
              aria-label={`Close ${t.title || "Untitled"}`}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex-1" />
      </div>
      {active && (
        <div id={`document-panel-${active.id}`} role="tabpanel" aria-labelledby={`document-tab-${active.id}`} className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-4 h-10 border-b border-border bg-surface-1">
            <input
              aria-label="Document title"
              value={active.title}
              onChange={(e) => updateActive({ title: e.target.value, savedToDb: false })}
              placeholder="Title"
              className="bg-transparent text-sm font-medium text-text placeholder:text-text-subtle focus:outline-none flex-1 min-w-0"
            />
            {active.diskPath && (
              <span className="text-[10px] text-text-subtle font-mono truncate max-w-[280px]">{active.diskPath}</span>
            )}
            <span className="text-[10px] text-text-subtle">{active.diskPath ? "Disk file" : "DB-backed"}</span>
            {active.dirty && <span className="text-[10px] text-warn">● unsaved</span>}
            <span className="text-[10px] text-text-subtle tabular-nums">
              {active.content.length} chars · {active.content.split(/\s+/).filter(Boolean).length} words
            </span>
            <span className="hidden sm:flex items-center gap-1.5 text-[10px] text-text-subtle">
              <kbd className="bg-surface-2 border border-border rounded px-1 py-0.5 text-[9px]">Ctrl+S</kbd> save
              <kbd className="bg-surface-2 border border-border rounded px-1 py-0.5 text-[9px] ml-1">Ctrl+P</kbd> preview
            </span>
            <Button
              size="xs"
              variant={showPreview ? "primary" : "ghost"}
              icon={showPreview ? <Edit3 size={11} /> : <Eye size={11} />}
              onClick={() => setShowPreview((p) => !p)}
            >
              {showPreview ? "Edit" : "Preview"}
            </Button>
            <Dropdown
              align="right"
              menuClassName="w-48"
              trigger={
                <button type="button" aria-label="More document actions" className="text-text-subtle hover:text-text p-1.5 rounded-md hover:bg-surface-2">
                  <MoreHorizontal size={14} />
                </button>
              }
            >
              {() => (
                <div className="py-1">
                  <button
                    type="button"
                    onClick={() => setShowAiEdit(true)}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5"
                  >
                    <Sparkles size={11} className="text-accent" /> Ask AI to edit
                  </button>
                  <button
                    type="button"
                    onClick={insertIntoChat}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5"
                    disabled={!active.content.trim()}
                  >
                    <MessageSquarePlus size={11} /> Insert into chat
                  </button>
                  {active.diskPath ? (
                    <button
                      type="button"
                      onClick={saveToDisk}
                      className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5"
                      disabled={!active.dirty}
                    >
                      <Save size={11} /> Save to disk
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => save()}
                      className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5"
                      disabled={!active.dirty}
                    >
                      <Save size={11} /> Save
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={exportDoc}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-1.5"
                  >
                    <Download size={11} /> Export as Markdown
                  </button>
                </div>
              )}
             </Dropdown>
           </div>
          {error && (
            <div role="alert" className="px-4 py-1.5 border-b border-error/30 bg-error/10 text-xs text-error flex items-center justify-between gap-2">
              <span className="whitespace-pre-wrap">{error}</span>
              <button type="button" className="underline shrink-0" onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {externalChange?.id === active.id && (
            <div role="alert" className="px-4 py-1.5 border-b border-warn/30 bg-warn/10 text-xs text-warn flex items-center justify-between gap-2">
              <span>The disk file changed while you had unsaved edits.</span>
              <span className="flex gap-2 shrink-0">
                <button type="button" className="underline" onClick={() => { updateActive({ content: externalChange.content, savedToDb: true, dirty: false }); setExternalChange(null); }}>Reload disk</button>
                <button type="button" className="underline" onClick={() => setExternalChange(null)}>Keep edits</button>
              </span>
            </div>
          )}
          {showPreview ? (
            <div className="flex-1 overflow-y-auto p-6 prose prose-invert prose-sm max-w-3xl mx-auto w-full">
              <MarkdownPreview content={active.content} />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={active.content}
              onChange={(e) => updateActive({ content: e.target.value, savedToDb: false })}
              onSelect={onSelect}
              onKeyUp={onSelect}
              onClick={onSelect}
              placeholder="Start writing… (markdown supported)"
              className="flex-1 bg-bg text-sm text-text placeholder:text-text-subtle p-6 focus:outline-none resize-none font-mono"
            />
          )}
          {selection && (
            <div className="px-4 py-1.5 bg-accent/10 border-t border-accent/30 text-[11px] text-accent flex items-center justify-between">
              <span>{selection.length} chars selected</span>
              <button type="button" onClick={() => { setSelection(""); window.getSelection()?.removeAllRanges(); }} className="hover:text-text">Clear</button>
            </div>
          )}
        </div>
      )}

      {/* AI Edit modal */}
      <Modal
        open={showAiEdit}
        onClose={() => setShowAiEdit(false)}
        title="Ask AI to edit"
        description={selection ? `Editing ${selection.length} chars of selection` : "Editing the whole document"}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAiEdit(false)}>Cancel</Button>
            <Button variant="primary" onClick={runAiEdit} disabled={!aiInstruction.trim() || aiBusy} loading={aiBusy} icon={<Sparkles size={12} />}>
              Generate edit
            </Button>
          </>
        }
      >
        <TextArea
          value={aiInstruction}
          onChange={setAiInstruction}
          placeholder="e.g. Make this more concise, fix grammar, convert to bullet points, add a TL;DR section…"
          rows={4}
          autoFocus
        />
      </Modal>

      {/* Diff preview */}
      <Modal
        open={!!pendingDiff}
        onClose={rejectDiff}
        title="AI edit preview"
        description={pendingDiff ? `"${pendingDiff.instruction}"` : ""}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={rejectDiff} icon={<X size={12} />}>Reject</Button>
            <Button variant="primary" onClick={acceptDiff} icon={<Check size={12} />}>Accept</Button>
          </>
        }
      >
        {pendingDiff && <DiffPreview original={pendingDiff.original} proposed={pendingDiff.proposed} />}
      </Modal>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await performDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        title="Discard unsaved changes"
        message={`Close "${deleteTarget?.title ?? ""}" without saving? Unsaved edits will be lost.`}
        confirmLabel="Discard"
        confirmVariant="danger"
      />
    </div>
    </RouteShell>
  );
}

export function DiffPreview({ original, proposed }: { original: string; proposed: string }) {
  const ops = diffLines(original, proposed);
  const stats = diffStats(ops);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs mb-2">
        <span className="text-success">+{stats.added} added</span>
        <span className="text-error">−{stats.removed} removed</span>
      </div>
      <div className="bg-surface-1 border border-border rounded-md overflow-hidden text-xs font-mono leading-relaxed max-h-[50vh] overflow-y-auto">
        {ops.length === 0 ? (
          <div className="p-3 text-text-muted">No changes</div>
        ) : (
          ops.map((op, i) => {
            const lines = op.value.split("\n");
            // Don't drop the LAST LINE of the WHOLE document if it's empty
            // and the op is "equal" — `split("\n")` emits a trailing ""
            // that visually renders as a blank-line marker between two
            // add/remove blocks. But for ops in the middle of the diff,
            // that trailing "" is genuinely a blank line and must stay.
            // ponytail: trailing-empty-line filter on equal ops only —
            // add/remove ops are kept verbatim so we never lose a
            // proposed line that happens to be blank.
            return (
              <div key={i}>
                {lines.map((line, j) => {
                  if (line === "" && j === lines.length - 1 && op.kind === "equal") return null;
                  const prefix = op.kind === "add" ? "+" : op.kind === "remove" ? "−" : " ";
                  const cls =
                    op.kind === "add"
                      ? "bg-success/10 text-success"
                      : op.kind === "remove"
                      ? "bg-error/10 text-error"
                      : "text-text-muted";
                  return (
                    <div key={j} className={`flex items-start gap-2 px-3 py-0.5 ${cls}`}>
                      <span className="w-3 text-text-subtle text-right select-none">{prefix}</span>
                      <span className="whitespace-pre-wrap break-words flex-1">{line || " "}</span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || "");
          const codeStr = String(children).replace(/\n$/, "");
          const inline = !match && !String(children).includes("\n");
          if (inline) {
            return <code className="bg-surface-2 rounded px-1 py-0.5 text-xs" {...props}>{children}</code>;
          }
          return (
            <div className="code-block-wrap my-2">
              <button
                type="button"
                aria-label="Copy code"
                className="code-copy"
                onClick={(e: any) => { navigator.clipboard.writeText(codeStr); e.preventDefault(); }}
              >Copy</button>
              <span className="code-lang">{match ? match[1] : "code"}</span>
              <SyntaxHighlighter
                style={oneDark}
                language={match ? match[1] : "text"}
                PreTag="div"
                customStyle={{ margin: 0, borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-1)" }}
              >
                {codeStr}
              </SyntaxHighlighter>
            </div>
          );
        },
      }}
    >
      {escapeThinkTags(content)}
    </Markdown>
  );
}

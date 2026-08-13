/**
 * The persistent left sidebar.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MessageSquare, FileText, StickyNote, ListTodo, Brain, Settings, ChevronLeft, Plus, Search, BookOpen, GitCompareArrows, Cpu, Activity, Pencil, Pin, Archive, ArchiveRestore, Trash2, Copy, Check, Archive as ArchiveIcon } from "lucide-react";
import { useSessionsStore, Session } from "../../stores/sessions";
import { IconButton } from "../ui/IconButton";
import { Tooltip } from "../ui/Form";
import { usePaletteStore } from "../../stores/palette";
import { comboDisplay, useShortcutsStore } from "../../stores/shortcuts";
import { toast } from "../../stores/toasts";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";
import { TextInput } from "../ui/Form";
import { Button } from "../ui/Button";
import { api } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
}

const NAV: NavItem[] = [
  { id: "chat", label: "Chat", icon: <MessageSquare size={16} />, path: "/chat" },
  { id: "compare", label: "Compare", icon: <GitCompareArrows size={16} />, path: "/compare" },
  { id: "documents", label: "Documents", icon: <FileText size={16} />, path: "/documents" },
  { id: "notes", label: "Notes", icon: <StickyNote size={16} />, path: "/notes" },
  { id: "tasks", label: "Tasks", icon: <ListTodo size={16} />, path: "/tasks" },
  { id: "memory", label: "Memory", icon: <Brain size={16} />, path: "/memory" },
];

interface SessionContextMenu {
  session: Session;
  x: number;
  y: number;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const isMac = useShortcutsStore((s) => s.isMac);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const setActive = useSessionsStore((s) => s.setActive);
  const create = useSessionsStore((s) => s.create);
  const refresh = useSessionsStore((s) => s.refresh);
  const removeSession = useSessionsStore((s) => s.remove);
  const pinSession = useSessionsStore((s) => s.pin);
  const archiveSession = useSessionsStore((s) => s.archive);

  const [ctxMenu, setCtxMenu] = useState<SessionContextMenu | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refresh();
    api.appInfo().then((info) => setAppVersion(info.version)).catch((error) => {
      recordLog({ operation: "app_info", status: "failed", route: "sidebar", errorClass: errorClass(error) });
    });
  }, [refresh]);

  // Close the right-click context menu on left-click outside, Esc, scroll.
  // Same pattern as the chat message menu (commits 3+4 of v0.6.1).
  useEffect(() => {
    if (!ctxMenu) return;
    const frame = requestAnimationFrame(() => ctxMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
    const onLeftClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener("mousedown", onLeftClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onLeftClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxMenu]);

  const handleNewChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const s = await create();
      setActive(s.id);
      navigate(`/chat/${s.id}`);
    } catch (error) {
      toast.error(String(error), "Chat could not be created");
    } finally {
      setCreating(false);
    }
  };

  const openContextMenu = (e: React.MouseEvent, s: Session) => {
    e.preventDefault();
    setCtxMenu({ session: s, x: e.clientX, y: e.clientY });
  };

  const handleRename = async (s: Session) => {
    setCtxMenu(null);
    setRenameTarget(s);
    setRenameValue(s.title);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    try {
      const { api } = await import("../../lib/api");
      await api.renameSession(renameTarget.id, trimmed);
      await refresh();
    } catch (e) {
      toast.error(String(e));
    }
    setRenameTarget(null);
  };

  const handlePin = async (s: Session) => {
    setCtxMenu(null);
    await pinSession(s.id, !s.is_pinned);
  };

  const handleArchive = async (s: Session) => {
    setCtxMenu(null);
    // No local visibility toggle needed: archive() in the store calls
    // refresh(), which now fetches both active and archived rows.
    // The sidebar's client-side filter re-derives the active/archived
    // lists from the in-memory store, so the row will appear in the
    // archived list and disappear from the active list on its own.
    await archiveSession(s.id, !s.is_archived);
  };

  const handleDelete = async (s: Session) => {
    setCtxMenu(null);
    setDeleteTarget(s);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await removeSession(deleteTarget.id);
    } catch (e) {
      toast.error(String(e));
    }
    setDeleteTarget(null);
  };

  const handleCopyId = async (s: Session) => {
    setCtxMenu(null);
    try {
      await navigator.clipboard.writeText(s.id);
      toast.success("Session ID copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  if (collapsed) {
    return (
      <aside className="w-12 h-full bg-surface-1 border-r border-border flex flex-col items-center py-2 gap-1 shrink-0">
        {NAV.map((n) => {
          const active = location.pathname.startsWith(n.path);
          return (
            <Tooltip key={n.id} content={n.label} side="right">
              <button
                type="button"
                aria-label={n.label}
                onClick={() => navigate(n.path)}
                className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                  active ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                {n.icon}
              </button>
            </Tooltip>
          );
        })}
        <div className="flex-1" />
        <Tooltip content="New chat" side="right">
          <button
            type="button"
            aria-label="New chat"
            disabled={creating}
          onClick={handleNewChat}
            className="w-8 h-8 rounded-md flex items-center justify-center bg-accent hover:bg-accent-hover text-white transition-colors"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
        <Tooltip content="Expand sidebar" side="right">
          <IconButton icon={<ChevronLeft size={14} className="rotate-180" />} label="Expand" onClick={onToggle} />
        </Tooltip>
        <Tooltip content="Settings" side="right">
          <IconButton icon={<Settings size={14} />} label="Settings" onClick={() => navigate("/settings")} />
        </Tooltip>
      </aside>
    );
  }

  const activeSessions = sessions.filter((s) => !s.is_archived);
  const archivedSessions = sessions.filter((s) => s.is_archived);
  const visibleSessions = (showArchived ? archivedSessions : activeSessions).slice(0, 30);

  return (
    <aside className="w-60 h-full bg-surface-1 border-r border-border flex flex-col shrink-0">
      <div className="p-3 flex items-center gap-2 border-b border-border">
        <div className="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-white font-semibold text-sm">
          C
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">Convo</div>
           <div className="text-[10px] text-text-subtle -mt-0.5">v{appVersion ?? "?"} · local-first</div>
        </div>
        <IconButton icon={<ChevronLeft size={14} />} label="Collapse" onClick={onToggle} size="sm" />
      </div>

      <div className="p-2">
        <button
          type="button"
          aria-label="Search and commands"
          onClick={() => setPaletteOpen(true)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-xs text-text-muted transition-colors"
        >
          <Search size={12} />
          <span className="flex-1 text-left">Search & commands</span>
          <kbd className="text-[9px] bg-surface-3 border border-border rounded px-1 py-0.5 font-mono">{comboDisplay("ctrl+k", isMac)}</kbd>
        </button>
      </div>

      <nav className="px-2 pb-2 flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = location.pathname.startsWith(n.path);
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => navigate(n.path)}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                active ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-surface-2"
              }`}
            >
              {n.icon}
              <span className="flex-1 text-left">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="px-2 py-2 mt-1">
        <button
          type="button"
          disabled={creating}
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-md text-sm font-medium transition-colors"
        >
          <Plus size={14} />
          New chat
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="flex-1 overflow-y-auto px-2 py-1 border-t border-border mt-1">
          <div className="flex items-center gap-1 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold flex-1">
              {showArchived ? "Archived" : "Recent"}
            </div>
            <button
              type="button"
              aria-label={showArchived ? "Show active chats" : "Show archived chats"}
              onClick={() => setShowArchived((v) => !v)}
              className="text-[10px] text-text-subtle hover:text-text flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface-2"
              title={showArchived ? "Show active chats" : `Show archived (${archivedSessions.length})`}
            >
              {showArchived ? <MessageSquare size={10} /> : <ArchiveIcon size={10} />}
              {showArchived ? "Active" : `Archived (${archivedSessions.length})`}
            </button>
          </div>
          {visibleSessions.length === 0 ? (
            <div className="text-text-subtle text-[10px] px-2 py-1.5 italic">
              {showArchived ? "No archived chats" : "No active chats yet"}
            </div>
          ) : (
            visibleSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                onLeftClick={() => {
                  setActive(s.id);
                  navigate("/chat");
                }}
                onContextMenu={(e) => openContextMenu(e, s)}
                onPin={() => pinSession(s.id, !s.is_pinned)}
                onArchive={() => archiveSession(s.id, !s.is_archived)}
              />
            ))
          )}
        </div>
      )}

      {!location.pathname.startsWith("/chat") && <div className="flex-1" />}

      <div className="border-t border-border/40 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold px-2 py-1">
          Tools
        </div>
        <button
          type="button"
          onClick={() => navigate("/hardware")}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
            location.pathname === "/hardware" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
        >
          <Cpu size={14} />
          Hardware scan
        </button>
        <button
          type="button"
          onClick={() => navigate("/diagnostics")}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
            location.pathname === "/diagnostics" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
        >
          <Activity size={14} />
          Diagnostics
        </button>
      </div>

      <div className="border-t border-border p-2 flex items-center gap-1">
        <IconButton
          icon={<BookOpen size={14} />}
          label="About"
          onClick={() => navigate("/about")}
        />
        <IconButton
          icon={<Settings size={14} />}
          label="Settings"
          onClick={() => navigate("/settings")}
        />
        <div className="flex-1" />
      </div>

      {ctxMenu && (
        <SessionContextMenuView
          ref={ctxMenuRef}
          session={ctxMenu.session}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onRename={() => handleRename(ctxMenu.session)}
          onPin={() => handlePin(ctxMenu.session)}
          onArchive={() => handleArchive(ctxMenu.session)}
          onDelete={() => handleDelete(ctxMenu.session)}
          onCopyId={() => handleCopyId(ctxMenu.session)}
        />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete session"
        message={`Delete session "${deleteTarget?.title ?? ""}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
      />
      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename session"
        size="sm"
      >
        <TextInput
          value={renameValue}
          onChange={setRenameValue}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitRename(); }
          }}
          placeholder="Session title"
        />
        <div className="flex items-center justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button variant="primary" onClick={submitRename}>Rename</Button>
        </div>
      </Modal>
    </aside>
  );
}

function SessionRow({
  session, active, onLeftClick, onContextMenu, onPin, onArchive,
}: {
  session: Session;
  active: boolean;
  onLeftClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPin: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      className={`group w-full rounded-md text-xs flex items-center gap-1 transition-colors animate-message-in ${
        active ? "bg-surface-3 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <button
        type="button"
        onClick={onLeftClick}
        onContextMenu={onContextMenu}
        className="flex-1 min-w-0 text-left px-2 py-1.5 flex items-center gap-1.5"
      >
        {session.is_pinned && <span className="text-accent shrink-0">★</span>}
        {session.is_archived && <span className="text-text-subtle shrink-0"><ArchiveIcon size={9} /></span>}
        <span className="truncate">{session.title}</span>
      </button>
      <div className="opacity-0 group-hover:opacity-100 flex items-center pr-1.5 gap-0.5 transition-opacity">
        <button
          type="button"
          aria-label={session.is_pinned ? "Unpin" : "Pin"}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          className="text-text-subtle hover:text-accent p-0.5"
          title={session.is_pinned ? "Unpin" : "Pin"}
        >
          <Pin size={10} className={session.is_pinned ? "text-accent" : ""} />
        </button>
        <button
          type="button"
          aria-label={session.is_archived ? "Unarchive" : "Archive"}
          onClick={(e) => { e.stopPropagation(); onArchive(); }}
          className="text-text-subtle hover:text-text p-0.5"
          title={session.is_archived ? "Unarchive" : "Archive"}
        >
          {session.is_archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
        </button>
      </div>
    </div>
  );
}

import { forwardRef } from "react";

const SessionContextMenuView = forwardRef<HTMLDivElement, {
  session: Session;
  x: number;
  y: number;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onCopyId: () => void;
}>(function SessionContextMenuView({ session, x, y, onRename, onPin, onArchive, onDelete, onCopyId }, ref) {
  // Clamp to viewport
  const menuW = 200;
  const menuH = 200;
  const cx = Math.min(x, window.innerWidth - menuW - 8);
  const cy = Math.min(y, window.innerHeight - menuH - 8);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${session.title}`}
      tabIndex={-1}
      className="fixed z-[100] min-w-[180px] bg-surface-1 border border-border rounded-lg shadow-modal py-1 animate-scale-in"
      style={{ left: cx, top: cy }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-2"
      >
        <Pencil size={12} /> Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onPin}
        className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-2"
      >
        <Pin size={12} className={session.is_pinned ? "text-accent" : ""} />
        {session.is_pinned ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onArchive}
        className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-2"
      >
        {session.is_archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
        {session.is_archived ? "Unarchive" : "Archive"}
      </button>
      <div className="my-1 border-t border-border/60" />
      <button
        type="button"
        role="menuitem"
        onClick={onCopyId}
        className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text flex items-center gap-2"
      >
        <Copy size={12} /> Copy ID
      </button>
      <div className="my-1 border-t border-border/60" />
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-surface-2 flex items-center gap-2"
      >
        <Trash2 size={12} /> Delete
      </button>
    </div>
  );
});

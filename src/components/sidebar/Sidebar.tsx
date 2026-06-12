/**
 * The persistent left sidebar.
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MessageSquare, FileText, StickyNote, ListTodo, Brain, Settings, ChevronLeft, Plus, Search, BookOpen, GitCompareArrows } from "lucide-react";
import { useSessionsStore } from "../../stores/sessions";
import { IconButton } from "../ui/IconButton";
import { Tooltip } from "../ui/Form";
import { usePaletteStore } from "../../stores/palette";

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

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const setActive = useSessionsStore((s) => s.setActive);
  const create = useSessionsStore((s) => s.create);
  const refresh = useSessionsStore((s) => s.refresh);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleNewChat = async () => {
    const s = await create();
    setActive(s.id);
    navigate("/chat");
  };

  if (collapsed) {
    return (
      <aside className="w-12 h-full bg-surface-1 border-r border-border flex flex-col items-center py-2 gap-1 shrink-0">
        {NAV.map((n) => {
          const active = location.pathname.startsWith(n.path);
          return (
            <Tooltip key={n.id} content={n.label} side="right">
              <button
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

  return (
    <aside className="w-60 h-full bg-surface-1 border-r border-border flex flex-col shrink-0">
      <div className="p-3 flex items-center gap-2 border-b border-border">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-accent-muted flex items-center justify-center text-white font-semibold text-sm">
          C
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">Convo</div>
          <div className="text-[10px] text-text-subtle -mt-0.5">v0.4 · local-first</div>
        </div>
        <IconButton icon={<ChevronLeft size={14} />} label="Collapse" onClick={onToggle} size="sm" />
      </div>

      <div className="p-2">
        <button
          onClick={() => setPaletteOpen(true)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-xs text-text-muted transition-colors"
        >
          <Search size={12} />
          <span className="flex-1 text-left">Search & commands</span>
          <kbd className="text-[9px] bg-surface-3 border border-border rounded px-1 py-0.5 font-mono">⌘K</kbd>
        </button>
      </div>

      <nav className="px-2 pb-2 flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = location.pathname.startsWith(n.path);
          return (
            <button
              key={n.id}
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
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-md text-sm font-medium transition-colors"
        >
          <Plus size={14} />
          New chat
        </button>
      </div>

      {location.pathname.startsWith("/chat") && sessions.length > 0 && (
        <div className="flex-1 overflow-y-auto px-2 py-1 border-t border-border mt-1">
          <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold px-2 py-1.5">
            Recent
          </div>
          {sessions.slice(0, 30).map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(s.id);
                navigate("/chat");
              }}
              className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-colors ${
                s.id === activeId ? "bg-surface-3 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              {s.is_pinned && <span className="text-accent">★</span>}
              <span className="truncate">{s.title}</span>
            </button>
          ))}
        </div>
      )}

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
    </aside>
  );
}

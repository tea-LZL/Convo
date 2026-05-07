import { useState, useRef, useEffect } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Conversation } from "../types";

function formatRelativeDate(iso: string): string {
  const now = new Date();
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[then.getMonth()]} ${then.getDate()}`;
}

interface ConversationItemProps {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

export default function ConversationItem({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: ConversationItemProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (ctxMenu) {
      const handleClick = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setCtxMenu(null);
        }
      };
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [ctxMenu]);

  const handleSave = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!editing) {
      e.stopPropagation();
      setEditing(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setTitle(conversation.title);
      setEditing(false);
    }
  };

  const handleCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleCtx}
      className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer transition-colors text-sm ${
        active
          ? "bg-accent/20 text-white border border-accent/30"
          : "text-gray-400 hover:bg-surface-300 hover:text-gray-200 border border-transparent"
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          className="flex-1 min-w-0 bg-surface-100 border border-accent rounded px-2 py-0.5 text-white text-sm outline-none"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex-1 min-w-0">
          <span className="block truncate">{conversation.title}</span>
          <span className="block text-[10px] text-gray-600 mt-0.5">
            {formatRelativeDate(conversation.updated_at)}
          </span>
        </div>
      )}

      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] w-40 bg-surface-200 border border-surface-400 rounded-xl shadow-2xl shadow-black/40 py-1 animate-fade-in"
          style={{
            left: ctxMenu.x + 160 > window.innerWidth ? ctxMenu.x - 160 : ctxMenu.x,
            top: ctxMenu.y + 80 > window.innerHeight ? ctxMenu.y - 80 : ctxMenu.y,
          }}
        >
          <button
            onClick={() => { setCtxMenu(null); setEditing(true); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-surface-300 transition-colors"
          >
            <Pencil size={14} className="text-gray-500" />
            Rename
          </button>
          <button
            onClick={() => { setCtxMenu(null); onDelete(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-surface-300 transition-colors"
          >
            <Trash2 size={14} className="text-red-400" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

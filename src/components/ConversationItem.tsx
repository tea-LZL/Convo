import { useState, useRef, useEffect } from "react";
import { Trash2 } from "lucide-react";
import type { Conversation } from "../types";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

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

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onDoubleClick={handleDoubleClick}
      className={`group flex items-center gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer transition-colors text-sm ${
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
        <>
          <span className="flex-1 truncate">{conversation.title}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all shrink-0"
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  );
}

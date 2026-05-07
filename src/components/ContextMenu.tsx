import { useState, useEffect, useRef, useCallback } from "react";
import { Copy, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";

interface ContextMenuProps {
  content: string;
  role: "user" | "assistant";
  x: number;
  y: number;
  onClose: () => void;
  onRegenerate?: () => void;
  hasThinking?: boolean;
  thinkingCollapsed?: boolean;
  onToggleThinking?: () => void;
}

export default function ContextMenu({
  content,
  role,
  x,
  y,
  onClose,
  onRegenerate,
  hasThinking,
  thinkingCollapsed,
  onToggleThinking,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      setPosition({
        x: x + rect.width > winW ? x - rect.width : x,
        y: y + rect.height > winH ? y - rect.height : y,
      });
    }
  }, [x, y]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    onClose();
  }, [content, onClose]);

  const handleToggleThinking = useCallback(() => {
    onToggleThinking?.();
    onClose();
  }, [onToggleThinking, onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] w-44 bg-surface-200 border border-surface-400 rounded-xl shadow-2xl shadow-black/40 py-1 animate-fade-in"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={handleCopy}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-surface-300 transition-colors"
      >
        <Copy size={14} className="text-gray-500" />
        Copy
      </button>
      {role === "assistant" && hasThinking && (
        <button
          onClick={handleToggleThinking}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-surface-300 transition-colors"
        >
          {thinkingCollapsed ? (
            <ChevronDown size={14} className="text-gray-500" />
          ) : (
            <ChevronUp size={14} className="text-gray-500" />
          )}
          {thinkingCollapsed ? "Expand" : "Collapse"} thinking
        </button>
      )}
      {role === "assistant" && onRegenerate && (
        <button
          onClick={() => { onRegenerate(); onClose(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-surface-300 transition-colors"
        >
          <RotateCcw size={14} className="text-gray-500" />
          Regenerate
        </button>
      )}
    </div>
  );
}

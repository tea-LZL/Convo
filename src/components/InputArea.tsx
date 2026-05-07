import { useState, useRef, useEffect } from "react";
import { Send, Square, ChevronUp } from "lucide-react";
import type { OllamaModel } from "../types";

interface InputAreaProps {
  onSend: (content: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  tokenCount: number;
  contextLength: number;
}

function formatModelLabel(name: string): string {
  const parts = name.split(":");
  return parts[0] + (parts[1] ? ":" + parts[1] : "");
}

export default function InputArea({
  onSend,
  onStop,
  streaming,
  disabled,
  models,
  selectedModel,
  onModelChange,
  tokenCount,
  contextLength,
}: InputAreaProps) {
  const [input, setInput] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!streaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [streaming]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    }
    if (modelOpen) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelOpen]);

  const handleSend = () => {
    if (!input.trim() || streaming || disabled) return;
    onSend(input);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSelect = (model: string) => {
    onModelChange(model);
    setModelOpen(false);
  };

  const percentUsed = Math.min(100, Math.round((tokenCount / contextLength) * 100));

  return (
    <div className="px-4 pb-4">
      <div className="max-w-[740px] mx-auto">
        <div className="rounded-[24px] border border-surface-400 bg-surface-200/95 backdrop-blur-xl shadow-lg shadow-black/20">
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
              rows={1}
              disabled={disabled}
              className="w-full resize-none bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none overflow-y-auto"
              style={{ maxHeight: "160px" }}
            />
          </div>

          <div className="flex items-center justify-between px-3 pb-3">
            <div className="flex items-center gap-1.5">
              <div ref={modelRef} className="relative">
                <button
                  onClick={() => setModelOpen(!modelOpen)}
                  className="flex items-center gap-1 bg-surface-300 hover:bg-surface-400 border border-surface-500 text-gray-300 text-xs rounded-full pl-3 pr-2 py-1.5 outline-none cursor-pointer transition-colors"
                >
                  <span className="truncate max-w-[120px]">
                    {formatModelLabel(selectedModel)}
                  </span>
                  <ChevronUp
                    size={12}
                    className={`text-gray-500 transition-transform ${
                      modelOpen ? "" : "rotate-180"
                    }`}
                  />
                </button>

                {modelOpen && (
                  <div className="absolute bottom-full left-0 mb-1 w-56 bg-surface-200 border border-surface-400 rounded-xl shadow-xl shadow-black/30 overflow-hidden animate-fade-in z-50">
                    <div className="max-h-48 overflow-y-auto py-1">
                      {models.map((m) => (
                        <button
                          key={m.name}
                          onClick={() => handleSelect(m.name)}
                          className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between ${
                            m.name === selectedModel
                              ? "bg-accent/20 text-white"
                              : "text-gray-300 hover:bg-surface-300"
                          }`}
                        >
                          <span className="truncate">{m.name}</span>
                          <span className="text-xs text-gray-500 ml-2 shrink-0">
                            {(m.size / 1e9).toFixed(1)}GB
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <div className="relative group">
                <span className="text-xs text-gray-500 tabular-nums cursor-default">
                  {tokenCount.toLocaleString()} tokens ({percentUsed}%)
                </span>
                <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-surface-300 border border-surface-500 rounded-lg shadow-xl shadow-black/30 text-xs text-gray-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Context</p>
                  <p>{tokenCount.toLocaleString()} tokens</p>
                  <p>{percentUsed}% used</p>
                </div>
              </div>
              {streaming ? (
                <button
                  onClick={onStop}
                  className="flex items-center gap-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  <Square size={12} fill="currentColor" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || disabled}
                  className="flex items-center justify-center w-8 h-8 bg-accent hover:bg-accent-hover text-white rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

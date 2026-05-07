import { useState, useEffect, useRef } from "react";
import type { ChatMessage, OllamaModel } from "../types";
import MessageBubble from "./MessageBubble";
import InputArea from "./InputArea";
import ContextMenu from "./ContextMenu";

function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatUserTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.getDate().toString().padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${day} ${month} ${year} ${hours}:${minutes} ${ampm}`;
}

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  totalTokens: number;
  contextLength: number;
  error: string | null;
  loadingMessages: boolean;
  models: OllamaModel[];
  selectedModel: string;
  onSend: (content: string) => void;
  onStop: () => void;
  onModelChange: (model: string) => void;
}

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  content: string;
  role: "user" | "assistant";
  msgIndex: number | null;
  isThinking: boolean;
}

export default function ChatView({
  messages,
  streaming,
  streamContent,
  streamThinking,
  totalTokens,
  contextLength,
  error,
  loadingMessages,
  models,
  selectedModel,
  onSend,
  onStop,
  onModelChange,
}: ChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isEmpty = messages.length === 0 && !streaming;
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<MenuState>({
    open: false,
    x: 0,
    y: 0,
    content: "",
    role: "user",
    msgIndex: null,
    isThinking: false,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamContent, streamThinking]);

  if (loadingMessages) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-gray-500 rounded-full animate-pulse-dot" style={{ animationDelay: "0s" }} />
          <span className="w-2 h-2 bg-gray-500 rounded-full animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
          <span className="w-2 h-2 bg-gray-500 rounded-full animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
        </div>
      </div>
    );
  }

  const handleCtx = (e: React.MouseEvent, msg: ChatMessage, isThinking = false) => {
    const idx = messages.indexOf(msg);
    setMenu({ open: true, x: e.clientX, y: e.clientY, content: msg.content, role: msg.role, msgIndex: idx, isThinking });
  };

  const handleToggleThinking = (idx: number) => {
    setCollapsedThinking((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full relative">
      <div className="flex-1 overflow-y-auto pb-36">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500 text-sm">Send a message to start the conversation.</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full">
            {messages.map((msg, i) => {
              const prevMsg = messages[i - 1];
              const duration = msg.role === "assistant" && prevMsg?.role === "user" && prevMsg.completedAt && msg.completedAt
                ? formatDuration(new Date(prevMsg.completedAt), new Date(msg.completedAt))
                : undefined;

              return (
                <div key={i}>
                  {msg.role === "user" && msg.completedAt && (
                    <div className="flex justify-end px-4 py-1">
                      <span className="text-[10px] text-gray-600 tabular-nums">
                        {formatUserTimestamp(msg.completedAt)}
                      </span>
                    </div>
                  )}
                  <MessageBubble
                    message={msg}
                    onContextMenu={handleCtx}
                    thinking={msg.thinking}
                    thinkingCollapsed={collapsedThinking.has(i)}
                    onToggleThinking={() => handleToggleThinking(i)}
                    responseDuration={duration}
                  />
                </div>
              );
            })}
            {streaming && (
              <MessageBubble
                message={{ role: "assistant", content: streamContent }}
                isStreaming={!streamContent}
                thinking={streamThinking}
                thinkingCollapsed={collapsedThinking.has(messages.length)}
                onToggleThinking={() => handleToggleThinking(messages.length)}
              />
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="absolute bottom-0 inset-x-0 pointer-events-none">
        {error && (
          <div className="px-4 py-2 mx-4 mb-2 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm max-w-[740px] mx-auto pointer-events-auto">
            {error}
          </div>
        )}
        <div
          className={`pointer-events-auto transition-transform duration-500 ease-in-out ${
            isEmpty ? "translate-y-[calc(-50vh+80px)]" : "translate-y-0"
          }`}
        >
          <InputArea
            onSend={onSend}
            onStop={onStop}
            streaming={streaming}
            disabled={loadingMessages}
            models={models}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            tokenCount={totalTokens}
            contextLength={contextLength}
          />
        </div>
      </div>

      {menu.open && (
        <ContextMenu
          content={menu.content}
          role={menu.role}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu((m) => ({ ...m, open: false }))}
          hasThinking={!!(menu.msgIndex !== null && (messages[menu.msgIndex]?.thinking || (menu.msgIndex === messages.length && streamThinking)))}
          thinkingCollapsed={menu.msgIndex !== null && collapsedThinking.has(menu.msgIndex)}
          onToggleThinking={menu.msgIndex !== null ? () => handleToggleThinking(menu.msgIndex!) : undefined}
        />
      )}
    </div>
  );
}

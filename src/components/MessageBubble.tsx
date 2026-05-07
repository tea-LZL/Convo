import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import type { ChatMessage } from "../types";

function formatTimestamp(iso?: string): string {
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

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onContextMenu?: (e: React.MouseEvent, msg: ChatMessage, isThinking?: boolean) => void;
  thinking?: string;
  thinkingCollapsed?: boolean;
  onToggleThinking?: () => void;
  responseDuration?: string;
}

export default function MessageBubble({
  message,
  isStreaming,
  onContextMenu,
  thinking,
  thinkingCollapsed = false,
  onToggleThinking,
  responseDuration,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const thinkingOpen = !thinkingCollapsed;

  const handleCtx = (e: React.MouseEvent, isThinking = false) => {
    if (isStreaming || !onContextMenu) return;
    e.preventDefault();
    onContextMenu(e, message, isThinking);
  };

  const handleThinkingCtx = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming || !onContextMenu) return;
    e.preventDefault();
    onContextMenu(e, message, true);
  };

  return (
    <div
      onContextMenu={(e) => handleCtx(e, false)}
      className={`flex px-4 py-2.5 animate-fade-in ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={
          isUser
            ? "max-w-[70%] rounded-2xl px-3.5 py-2 text-sm bg-white/[0.06] text-foreground"
            : "w-full max-w-3xl text-sm text-foreground"
        }
      >
        {!isUser && thinking && (
          <div
            onContextMenu={handleThinkingCtx}
            className="mb-3 bg-surface-300/40 border border-surface-400/40 rounded-xl overflow-hidden"
          >
            <button
              onClick={() => onToggleThinking?.()}
              className="w-full flex items-center gap-2 px-3 py-2 bg-surface-200/50 hover:bg-surface-300/70 text-gray-400 hover:text-gray-200 text-xs transition-all cursor-pointer group"
            >
              <Sparkles size={12} className="text-gray-500 group-hover:text-accent transition-colors" />
              <span className="flex-1 text-left font-medium">Thinking</span>
              <ChevronUp size={14} className={`transition-transform ${thinkingOpen ? "" : "rotate-180"}`} />
            </button>
            {thinkingOpen && (
              <div className="px-3 pb-2.5 text-xs text-gray-500/70 leading-relaxed whitespace-pre-wrap">
                {thinking}
              </div>
            )}
          </div>
        )}

        {message.content ? (
          <div className={isUser ? "" : "pl-4 border-l-2 border-accent/40"}>
            <div className="prose prose-invert prose-sm leading-relaxed break-words max-w-none">
              <Markdown
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const codeStr = String(children).replace(/\n$/, "");
                    const inline = !match && !String(children).includes("\n");

                    if (inline) {
                      return (
                        <code className="bg-white/[0.06] rounded px-1 py-0.5 text-xs" {...props}>
                          {children}
                        </code>
                      );
                    }

                    return (
                      <div className="relative group my-2">
                        <div className="absolute right-2 top-2 text-xs text-white/30 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                          {match ? match[1] : "code"}
                        </div>
                        <SyntaxHighlighter
                          style={oneDark}
                          language={match ? match[1] : "text"}
                          PreTag="div"
                          customStyle={{
                            margin: 0,
                            borderRadius: "10px",
                            border: "1px solid rgb(255 255 255 / 0.06)",
                            background: "rgb(0 0 0 / 0.3)",
                          }}
                        >
                          {codeStr}
                        </SyntaxHighlighter>
                      </div>
                    );
                  },
                }}
              >
                {message.content}
              </Markdown>
            </div>
          </div>
        ) : isStreaming ? (
          <span className="inline-flex gap-1 items-end h-5">
            <span className="w-1.5 h-1.5 bg-white/20 rounded-full animate-pulse-dot" style={{ animationDelay: "0s" }} />
            <span className="w-1.5 h-1.5 bg-white/20 rounded-full animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
            <span className="w-1.5 h-1.5 bg-white/20 rounded-full animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
          </span>
        ) : null}
        {!isUser && message.completedAt && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-gray-600 tabular-nums">
                {formatTimestamp(message.completedAt)}
              </span>
              {responseDuration && (
                <span className="text-[10px] text-gray-500 tabular-nums">
                  {responseDuration}
                </span>
              )}
            </div>
            <div className="mt-2 border-t border-surface-400/30" />
          </div>
        )}
      </div>
    </div>
  );
}

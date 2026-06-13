/**
 * New ChatView — uses the multi-provider chat system, new types, new design.
 * Phase 3: streaming segmenter, slash commands, attachments, per-session
 * model persistence, message editing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Square, ChevronUp, Plus, Paperclip, X, ChevronDown, Search, ArrowUp, Sparkles, RefreshCw, Edit2, Check, MoreHorizontal, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api, ChatMessage, Provider, Model } from "../../lib/api";
import { useChat } from "../../hooks/useChat";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Spinner, Tooltip, Tabs, Switch } from "../ui/Form";
import { IconButton } from "../ui/IconButton";
import { createStreamRenderer, StreamRenderer } from "../../lib/streamingRenderer";
import { useAttachments, PendingAttachment } from "../../hooks/useAttachments";
import { filterCommands, parseCommand, runCommand, SlashCommandContext } from "../../lib/slashCommands";
import { useNavigate } from "react-router-dom";
import { toast } from "../../stores/toasts";
import { useChatStreamStore } from "../../stores/chatStream";

function formatModelLabel(name: string): string {
  const parts = name.split(":");
  return parts[0] + (parts[1] ? ":" + parts[1] : "");
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.getDate().toString().padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function ChatViewNew({ sessionId }: { sessionId: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [contextLength, setContextLength] = useState(8192);
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set());
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; content: string; role: "user" | "assistant"; msgIndex: number | null; isThinking: boolean;
  } | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const navigate = useNavigate();
  const attachments = useAttachments(sessionId);

  const chat = useChat(sessionId, modelId);

  // Stream renderer is now owned by StreamingSection. The parent
  // only keeps the scroll container ref and the stick-to-bottom
  // sentinel (shared with StreamingSection so the renderer's
  // onAfterRender can decide whether to follow the tail).
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close the right-click context menu on left-click outside of it, on
  // Esc, and on scroll. We deliberately do NOT listen for contextmenu
  // here: a right-click that opens the menu fires its own onContextMenu
  // handler, and a document-level contextmenu listener would race with
  // it (the new menu's ref is unset when the listener first fires, so
  // the listener sees the click as "outside" and clears the menu before
  // the new one can render). Right-clicking on empty chat area leaves
  // the menu open until the user left-clicks, presses Esc, or scrolls.
  useEffect(() => {
    if (!contextMenu) return;
    const onLeftClick = (e: MouseEvent) => {
      if (e.button !== 0) return; // left-click only
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    const onScroll = () => setContextMenu(null);
    document.addEventListener("mousedown", onLeftClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onLeftClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [contextMenu]);

  // Load providers, models
  useEffect(() => {
    api.listProviders().then((ps) => {
      setProviders(ps);
      const def = ps.find((p) => p.is_default) || ps[0];
      if (def) setProviderId(def.id);
    }).catch(console.error);
  }, []);

  // Load session (model)
  useEffect(() => {
    if (sessionLoaded) return;
    api.listSessions().then((slist) => {
      const s = slist.find((x) => x.id === sessionId);
      if (s) {
        if (s.model_id) {
          // The model_id might be the database id (provider::name) — split it
          const sep = s.model_id.indexOf("::");
          if (sep >= 0) {
            setProviderId(s.model_id.slice(0, sep));
            setModelId(s.model_id.slice(sep + 2));
          } else {
            setModelId(s.model_id);
          }
        }
        if (s.provider_id) setProviderId(s.provider_id);
      }
      setSessionLoaded(true);
    }).catch(console.error);
  }, [sessionId, sessionLoaded]);

  // Refresh models when provider changes
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    (async () => {
      try {
        // Try the persisted table first
        let list = await api.listModelsForProvider(providerId).catch(() => []);
        // If empty, refresh
        if (!list || list.length === 0) {
          list = await api.refreshModels(providerId).catch(() => []);
        }
        if (cancelled) return;
        setModels(list);
        if (list.length > 0 && !list.find((m) => m.name === modelId)) {
          setModelId(list[0].name);
        }
      } catch (e) {
        console.error("models load failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [providerId]);

  // When modelId or providerId changes, persist to the DB. Gated on
  // sessionLoaded AND a real modelId to avoid an empty-string write
  // while the model is still loading.
  useEffect(() => {
    if (!sessionLoaded || !modelId) return;
    api.updateSessionModel(sessionId, modelId, providerId).catch(console.error);
  }, [modelId, providerId, sessionId, sessionLoaded]);

  // Resolve context length when model changes
  useEffect(() => {
    if (!modelId) return;
    api.getModelContextLength(modelId).then(setContextLength).catch(() => {
      const m = models.find((m) => m.name === modelId);
      if (m?.context_length !== null && m?.context_length !== undefined) setContextLength(m.context_length);
      else setContextLength(8192);
    });
  }, [modelId, models]);

  // The stream renderer setup and its cleanup now live inside
  // StreamingSection. See the per-slice sub-components below.

  // Auto-scroll the chat to the latest token while streaming, but
  // only if the user hasn't scrolled up to read history. We track
  // "stick to bottom" via a ref: set false when the user scrolls
  // away from the bottom, true again when they scroll back, and
  // forced to true when a new user message is sent.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distFromBottom < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // While streaming, the renderer scrolls inside its own rAF
  // (onAfterRender). This effect handles the case where the
  // message list changes without a stream being active — a
  // finished assistant message is appended, the user navigates
  // back to the chat, etc. One rAF is enough: nothing else is
  // The non-streaming scroll-to-bottom on messages.length change
  // is now handled inside MessageList, which subscribes to the
  // messages slice and calls onBumpScroll on length change.

  // Persist user message + attachments after send
  const onSend = async (text: string) => {
    // User just sent a message: re-arm the auto-scroll sentinel so
    // the upcoming stream follows the bottom.
    stickToBottom.current = true;
    // Persist the user message with attachments_json
    const readyIds = attachments.attachments.filter((a) => a.serverId).map((a) => a.serverId!);
    const attJson = attachments.serializeForMessage(readyIds);
    const newMessages: ChatMessage[] = [...chat.messages, {
      id: crypto.randomUUID(),
      session_id: sessionId,
      role: "user",
      content: text,
      thinking: null,
      attachments_json: attJson,
      prompt_tokens: null,
      output_tokens: null,
      created_at: new Date().toISOString(),
    }];
    // Save to disk so reload shows the attachments
    try {
      await api.saveMessages(sessionId, newMessages);
    } catch (e) {
      console.error("save user message", e);
    }
    // Then send to the model
    await chat.send(text);
    attachments.clear();
  };

  const handleSlashInput = (text: string): boolean => {
    if (!text.startsWith("/")) {
      setShowSlashMenu(false);
      return false;
    }
    // Only show when the slash is at the start with no other content
    if (text.includes(" ") || text.length > 24) {
      setShowSlashMenu(false);
      return false;
    }
    setSlashQuery(text);
    setShowSlashMenu(true);
    return true;
  };

  const isEmpty = chat.messages.length === 0 && !chat.streaming;

  // Stable scroll callback. Passed to MessageList (called on
  // messages.length change) and StreamingSection (called from
  // the renderer's onAfterRender). The function identity is
  // stable across renders, so the children don't re-render when
  // the parent re-renders on stream updates.
  const bumpScroll = useCallback(() => {
    if (!stickToBottom.current) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Stable "resend" callback. Used by MessageRow's "Save & resend"
  // button. Truncates the conversation to before this message,
  // saves, reloads, and sends the new content. Stable identity
  // so the message list's useMemo doesn't invalidate.
  const onResend = useCallback(async (msgIndex: number, content: string) => {
    const truncated = chat.messages.slice(0, msgIndex);
    try {
      await api.saveMessages(sessionId, truncated);
    } catch (e) { console.error(e); }
    setEditingMessageId(null);
    await chat.reload();
    await chat.send(content);
  }, [chat.messages, chat.reload, chat.send, sessionId]);

  const slashCtx: SlashCommandContext = {
    sessionId,
    setModelId: (id) => setModelId(id),
    setProviderId: (id) => setProviderId(id),
    currentModel: modelId,
    resendLast: async () => {
      const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
      if (lastUser) await chat.send(lastUser.content);
    },
    clearAll: async () => {
      await api.saveMessages(sessionId, []);
      window.location.reload();
    },
    newSession: async () => {
      navigate("/chat");
    },
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full relative">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-border bg-surface-1/40 backdrop-blur">
        <Dropdown
          align="left"
          menuClassName="min-w-[280px]"
          trigger={
            <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-sm transition-colors">
              <span className="text-text-muted text-xs">Model</span>
              <span className="text-text font-medium">{modelId ? formatModelLabel(modelId) : "Loading…"}</span>
              <ChevronDown size={12} className="text-text-subtle" />
            </button>
          }
        >
          {() => (
            <div className="py-1 max-h-80 overflow-y-auto">
              {providers.length > 1 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-subtle">Provider</div>
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setProviderId(p.id); setModelId(""); }}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${p.id === providerId ? "text-accent" : "text-text"}`}
                    >
                      <span>{p.name}</span>
                      <span className="text-text-subtle text-[10px]">{p.kind}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                </>
              )}
              {models.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-muted">No models — refresh in Settings</div>
              ) : (
                models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setModelId(m.name); if (m.context_length) setContextLength(m.context_length); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${m.name === modelId ? "bg-accent/10 text-accent" : "text-text"}`}
                  >
                    <span className="truncate">{formatModelLabel(m.name)}</span>
                    {m.size_bytes !== null && <span className="text-text-subtle text-[10px] ml-2">{(m.size_bytes / 1e9).toFixed(1)}GB</span>}
                  </button>
                ))
              )}
              <div className="my-1 border-t border-border" />
              <button
                onClick={async () => {
                  const list = await api.refreshModels(providerId);
                  setModels(list);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 flex items-center gap-1.5"
              >
                <RefreshCw size={11} /> Refresh models
              </button>
            </div>
          )}
        </Dropdown>

        <div className="flex-1" />

        <Dropdown
          align="right"
          menuClassName="w-48"
          trigger={
            <button className="text-text-subtle hover:text-text p-1.5 rounded-md hover:bg-surface-2">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {() => (
            <div className="py-1">
              <button
                onClick={async () => {
                  const md = await api.exportSessionMarkdown(sessionId);
                  const blob = new Blob([md], { type: "text/markdown" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `convo-${sessionId.slice(0, 8)}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast.success("Exported");
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                Export as Markdown
              </button>
              <button
                onClick={async () => {
                  if (!confirm("Clear all messages in this session?")) return;
                  await api.saveMessages(sessionId, []);
                  window.location.reload();
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-surface-2"
              >
                Clear session
              </button>
            </div>
          )}
        </Dropdown>

        <div className="text-xs text-text-muted tabular-nums">
          {chat.totalTokens.toLocaleString()} / {contextLength.toLocaleString()}
          <span className="text-text-subtle ml-1">({Math.min(100, Math.round((chat.totalTokens / contextLength) * 100))}%)</span>
        </div>
      </div>

      {/* Messages */}
      <div ref={chatScrollRef} className="flex-1 overflow-y-auto" onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest("[data-ctx]")) {
          setContextMenu(null);
        }
      }}>
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-subtle text-sm">
            Send a message to start the conversation.
          </div>
        ) : (
          <>
            <MessageList
              sessionId={sessionId}
              editingMessageId={editingMessageId}
              editingText={editingText}
              setEditingMessageId={setEditingMessageId}
              setEditingText={setEditingText}
              collapsedThinking={collapsedThinking}
              setCollapsedThinking={setCollapsedThinking}
              setContextMenu={setContextMenu}
              onBumpScroll={bumpScroll}
              onResend={onResend}
            />
            <StreamingSection
              sessionId={sessionId}
              stickToBottomRef={stickToBottom}
              onBumpScroll={bumpScroll}
            />
          </>
        )}
      </div>

      {/* Attachment strip */}
      {attachments.attachments.length > 0 && (
        <div className="px-4 pb-1.5">
          <div className="max-w-3xl mx-auto flex flex-wrap gap-1.5">
            {attachments.attachments.map((a) => (
              <AttachmentStripItem key={a.localId} a={a} onRemove={() => attachments.remove(a.localId)} />
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border bg-surface-1/40 backdrop-blur px-4 py-3 relative">
        {/* Slash menu */}
        {showSlashMenu && (
          <div className="absolute bottom-full left-4 right-4 mb-1 max-w-3xl mx-auto glass border border-border rounded-lg shadow-modal max-h-64 overflow-y-auto animate-scale-in">
            {filterCommands(slashQuery).map((c) => (
              <button
                key={c.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowSlashMenu(false);
                  // Insert the full command into the input
                  const inputEl = document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
                  if (inputEl) {
                    const full = `/${c.name} `;
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
                    setter.call(inputEl, full);
                    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
                    inputEl.focus();
                  }
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <span className="text-text font-mono">/{c.name}</span>
                {c.args && <span className="text-text-subtle font-mono ml-1">{c.args}</span>}
                <div className="text-text-subtle text-[10px]">{c.description}</div>
              </button>
            ))}
          </div>
        )}
        <div className="max-w-3xl mx-auto">
          {chat.error && (
            <div className="mb-2 px-3 py-2 bg-error/10 border border-error/30 rounded-lg text-error text-xs">
              {chat.error}
            </div>
          )}
          <ChatInput
            disabled={chat.streaming || !modelId}
            streaming={chat.streaming}
            attachments={attachments}
            onSend={onSend}
            onStop={() => chat.stop()}
            onInputChange={handleSlashInput}
            slashCtx={slashCtx}
          />
        </div>
      </div>

      {/* Drag overlay */}
      {attachments.isDragging && (
        <div className="absolute inset-0 z-50 bg-accent/10 border-2 border-dashed border-accent flex items-center justify-center pointer-events-none">
          <div className="bg-surface-1 border border-accent rounded-xl px-6 py-4 text-text shadow-modal">
            Drop files to attach
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] min-w-[180px] glass border border-border rounded-lg shadow-modal py-1 animate-scale-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <button
            onClick={() => { navigator.clipboard.writeText(contextMenu.content); setContextMenu(null); toast.success("Copied"); }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            Copy
          </button>
          <button
            onClick={() => {
              const blob = new Blob([contextMenu.content], { type: "text/markdown" });
              navigator.clipboard.write([new ClipboardItem({ "text/markdown": blob })]);
              setContextMenu(null);
              toast.success("Copied as Markdown");
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            Copy as Markdown
          </button>
          {contextMenu.role === "assistant" && (
            <>
              <button
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.msgIndex === null) return;
                  const i = contextMenu.msgIndex;
                  let userMsgIdx = i - 1;
                  while (userMsgIdx >= 0 && chat.messages[userMsgIdx].role !== "user") userMsgIdx--;
                  if (userMsgIdx < 0) return;
                  const userText = chat.messages[userMsgIdx].content;
                  const truncated = chat.messages.slice(0, userMsgIdx);
                  try {
                    await api.saveMessages(sessionId, truncated);
                    await chat.reload();
                    await chat.send(userText);
                  } catch (e) { console.error(e); }
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                Regenerate
              </button>
              <button
                onClick={async () => {
                  setContextMenu(null);
                  if (contextMenu.msgIndex === null) return;
                  // Toggle thinking
                  setCollapsedThinking((s) => { const n = new Set(s); n.has(contextMenu.msgIndex!) ? n.delete(contextMenu.msgIndex!) : n.add(contextMenu.msgIndex!); return n; });
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                Toggle thinking
              </button>
            </>
          )}
          {contextMenu.role === "user" && contextMenu.msgIndex !== null && (
            <button
              onClick={() => {
                setContextMenu(null);
                const m = chat.messages[contextMenu.msgIndex!];
                if (m) {
                  setEditingMessageId(m.id);
                  setEditingText(m.content);
                }
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
            >
              Edit & resend
            </button>
          )}
          <button
            onClick={async () => {
              if (contextMenu.msgIndex === null) return;
              setContextMenu(null);
              const idx = contextMenu.msgIndex;
              const truncated = chat.messages.slice(0, idx).concat(chat.messages.slice(idx + 1));
              try {
                await api.saveMessages(sessionId, truncated);
                await chat.reload();
              } catch (e) { console.error(e); }
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-surface-2"
          >
            Delete message
          </button>
          <div className="my-1 border-t border-border/60" />
          <button
            onClick={async () => {
              setContextMenu(null);
              if (contextMenu.msgIndex === null) return;
              const m = chat.messages[contextMenu.msgIndex];
              if (!m) return;
              const title = m.content.split("\n")[0].slice(0, 60);
              const body = `${m.content}\n\n---\n_Saved from chat on ${new Date().toLocaleString()}_`;
              try {
                await api.upsertNote({
                  title,
                  body,
                  source_session_id: sessionId,
                  source_message_id: m.id,
                });
                toast.success("Saved to note");
              } catch (e) { toast.error(String(e)); }
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            Save to note
          </button>
        </div>
      )}
    </div>
  );
}

// Module-level constants. Stable references so React.memo's shallow
// prop comparison sees only `content` change between renders. The
// `code` function takes all its data from props — no outer state
// captured — so it's safe to share across all MarkdownRenderer
// instances.
const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
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
          className="code-copy"
          onClick={(e) => { navigator.clipboard.writeText(codeStr); e.preventDefault(); }}
        >
          Copy
        </button>
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
};

/**
 * Wrapped in React.memo. With the module-level REMARK_PLUGINS and
 * MARKDOWN_COMPONENTS above, the only prop the parent ever changes
 * between renders is `content`. When the message row re-renders
 * with the same content (e.g. every chunk-bump on a static
 * completed message), the memo skips the re-render and
 * react-markdown + react-syntax-highlighter are not invoked.
 *
 * This is the load-bearing optimization for the stream-time lag:
 * v0.6.5's incremental DOM fix was correct but the parent
 * re-rendered 60Hz and re-parsed markdown on every static message
 * each time, saturating the main thread.
 */
const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {content}
    </Markdown>
  );
});

// ---------------------------------------------------------------------------
// Per-slice sub-components. v0.6.6: the previous design had one parent
// ChatViewNew that subscribed to the chatStream store via useChat and
// re-rendered 60 times per second during streaming. Every chunk-bump
// iterated the entire message list and re-parsed markdown for every
// completed message — saturating the main thread and making scroll
// and clicks feel laggy.
//
// The fix is structural: split the message list and the streaming tail
// into separate components with their own Zustand subscriptions. The
// parent no longer subscribes to streaming slices, so a chunk-bump
// only re-renders the streaming section, not the whole tree. The
// message list subscribes only to the messages array (stable across
// stream updates), and per-row React.memo skips the markdown re-parse
// for static messages.
// ---------------------------------------------------------------------------

const EMPTY_MESSAGES_LIST: ChatMessage[] = [];

interface MessageRowProps {
  msg: ChatMessage;
  i: number;
  sessionId: string;
  editingMessageId: string | null;
  editingText: string;
  setEditingMessageId: (id: string | null) => void;
  setEditingText: (text: string) => void;
  collapsedThinking: Set<number>;
  setCollapsedThinking: (updater: (s: Set<number>) => Set<number>) => void;
  setContextMenu: (m: { x: number; y: number; content: string; role: "user" | "assistant"; msgIndex: number | null; isThinking: boolean } | null) => void;
  onResend: (msgIndex: number, content: string) => Promise<void>;
}

/**
 * Custom comparator: only re-render when the message content itself
 * changes. Function props (setEditingMessageId, setContextMenu,
 * onResend, etc.) are ignored — they all close over `msg` and `i`
 * from the row's props, so a stale closure from the previous
 * render is still valid as long as `msg` and `i` are unchanged.
 */
function messageRowAreEqual(prev: MessageRowProps, next: MessageRowProps) {
  const pm = prev.msg;
  const nm = next.msg;
  return (
    prev.i === next.i &&
    pm.id === nm.id &&
    pm.content === nm.content &&
    pm.thinking === nm.thinking &&
    pm.role === nm.role &&
    pm.attachments_json === nm.attachments_json &&
    pm.created_at === nm.created_at &&
    prev.editingMessageId === next.editingMessageId &&
    prev.editingText === next.editingText &&
    prev.collapsedThinking === next.collapsedThinking &&
    prev.sessionId === next.sessionId
  );
}

const MessageRow = React.memo(function MessageRow({
  msg,
  i,
  sessionId,
  editingMessageId,
  editingText,
  setEditingMessageId,
  setEditingText,
  collapsedThinking,
  setCollapsedThinking,
  setContextMenu,
  onResend,
}: MessageRowProps) {
  const thinkingOpen = !collapsedThinking.has(i);
  const atts = parseAttachments(msg.attachments_json);
  return (
    <div
      key={msg.id}
      data-ctx
      className="px-4 py-2.5 group"
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          content: msg.content,
          role: msg.role as "user" | "assistant",
          msgIndex: i,
          isThinking: false,
        });
      }}
    >
      {atts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {atts.map((a) => <AttachmentChip key={a.id} att={a} />)}
        </div>
      )}
      {msg.role === "assistant" && msg.thinking && (
        <div className="mb-3 bg-surface-2/50 border border-border rounded-xl overflow-hidden">
          <button
            onClick={() => setCollapsedThinking((s) => {
              const n = new Set(s);
              n.has(i) ? n.delete(i) : n.add(i);
              return n;
            })}
            className="w-full flex items-center gap-2 px-3 py-2 bg-surface-2/40 hover:bg-surface-3/70 text-text-muted hover:text-text text-xs"
          >
            <span>✦</span>
            <span className="flex-1 text-left font-medium">Thinking</span>
            <ChevronDown size={12} className={`transition-transform ${thinkingOpen ? "" : "-rotate-90"}`} />
          </button>
          {thinkingOpen && (
            <div className="px-3 pb-2.5 pt-1 text-xs text-text-muted leading-relaxed whitespace-pre-wrap">
              {msg.thinking}
            </div>
          )}
        </div>
      )}
      {editingMessageId === msg.id ? (
        <div className="bg-surface-2 border border-border rounded-md p-2">
          <textarea
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            rows={Math.max(2, Math.min(10, editingText.split("\n").length + 1))}
            className="w-full bg-transparent text-sm text-text focus:outline-none resize-none"
            autoFocus
          />
          <div className="flex items-center gap-1 justify-end mt-1">
            <Button size="xs" variant="ghost" onClick={() => setEditingMessageId(null)}>Cancel</Button>
            <Button
              size="xs"
              variant="primary"
              onClick={async () => {
                const newContent = editingText.trim();
                if (!newContent) return;
                await onResend(i, newContent);
              }}
              icon={<Check size={12} />}
            >
              Save & resend
            </Button>
          </div>
        </div>
      ) : msg.role === "user" ? (
        <div className="bg-userbubble rounded-2xl px-3.5 py-2 text-sm text-text whitespace-pre-wrap break-words inline-block max-w-[85%]">
          {msg.content}
          <div className="mt-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
            <IconButton icon={<Edit2 size={11} />} label="Edit & resend" size="sm" onClick={() => { setEditingMessageId(msg.id); setEditingText(msg.content); }} />
          </div>
        </div>
      ) : (
        <div className="prose prose-invert prose-sm leading-relaxed max-w-none break-words">
          <MarkdownRenderer content={msg.content} />
        </div>
      )}
      {msg.role === "assistant" && msg.created_at && (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-text-subtle tabular-nums">
            {formatTimestamp(msg.created_at)}
          </span>
          <span className="text-[10px] text-text-subtle tabular-nums">
            {msg.prompt_tokens !== null && msg.output_tokens !== null
              ? `${msg.prompt_tokens + msg.output_tokens} tokens`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}, messageRowAreEqual);

interface MessageListProps {
  sessionId: string;
  editingMessageId: string | null;
  editingText: string;
  setEditingMessageId: (id: string | null) => void;
  setEditingText: (text: string) => void;
  collapsedThinking: Set<number>;
  setCollapsedThinking: (updater: (s: Set<number>) => Set<number>) => void;
  setContextMenu: (m: { x: number; y: number; content: string; role: "user" | "assistant"; msgIndex: number | null; isThinking: boolean } | null) => void;
  onBumpScroll: () => void;
  onResend: (msgIndex: number, content: string) => Promise<void>;
}

/**
 * Subscribes only to the messages slice. The array reference is
 * stable across stream updates (the bump shallow-copies the
 * SessionState but doesn't touch the messages array), so this
 * component re-renders only when a message is added/removed/edited.
 */
const MessageList = React.memo(function MessageList({
  sessionId,
  editingMessageId,
  editingText,
  setEditingMessageId,
  setEditingText,
  collapsedThinking,
  setCollapsedThinking,
  setContextMenu,
  onBumpScroll,
  onResend,
}: MessageListProps) {
  const messages = useChatStreamStore(
    (s) => s.sessions[sessionId]?.messages ?? EMPTY_MESSAGES_LIST
  );

  // Scroll to bottom when the message list grows. Bumps are
  // cheap; the per-row memo handles the actual re-render cost.
  const prevLenRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== prevLenRef.current) {
      prevLenRef.current = messages.length;
      onBumpScroll();
    }
  }, [messages.length, onBumpScroll]);

  // useMemo over the .map(): the children are JSX elements with
  // stable callback refs (from useCallback in the parent), so the
  // memoized array is reusable across renders as long as `messages`
  // and the editing state haven't changed. The per-row memo
  // comparator still runs on each render of the parent — but the
  // comparator is O(1) (a few string equality checks) and skips
  // the markdown re-parse on no-change.
  const renderedMessages = useMemo(
    () => messages.map((msg, i) => (
      <MessageRow
        key={msg.id}
        msg={msg}
        i={i}
        sessionId={sessionId}
        editingMessageId={editingMessageId}
        editingText={editingText}
        setEditingMessageId={setEditingMessageId}
        setEditingText={setEditingText}
        collapsedThinking={collapsedThinking}
        setCollapsedThinking={setCollapsedThinking}
        setContextMenu={setContextMenu}
        onResend={onResend}
      />
    )),
    [messages, sessionId, editingMessageId, editingText, collapsedThinking, setEditingMessageId, setEditingText, setCollapsedThinking, setContextMenu, onResend]
  );

  return <div className="max-w-3xl mx-auto w-full py-4">{renderedMessages}</div>;
});

interface StreamingSectionProps {
  sessionId: string;
  stickToBottomRef: React.MutableRefObject<boolean>;
  onBumpScroll: () => void;
}

/**
 * Subscribes only to the streaming slices. Re-renders on every
 * chunk-bump (necessary — the tail is the actual stream). The
 * renderer inside this component is the v0.6.5 incremental
 * DOM-direct renderer, with the per-pace-tick onAfterRender
 * calling onBumpScroll.
 *
 * Returns null when not streaming — unmounting destroys the
 * renderer (cleanup in the streaming useEffect).
 */
function StreamingSection({ sessionId, stickToBottomRef, onBumpScroll }: StreamingSectionProps) {
  const streaming = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streaming ?? false
  );
  const streamContent = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamContent ?? ""
  );
  const streamThinking = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamThinking ?? ""
  );

  const tailContainerRef = useRef<HTMLDivElement>(null);
  const tailRendererRef = useRef<StreamRenderer | null>(null);
  const lastStreamContent = useRef<string>("");
  const lastStreamThinking = useRef<string>("");

  useEffect(() => {
    if (!streaming) {
      tailRendererRef.current?.destroy();
      tailRendererRef.current = null;
      lastStreamContent.current = "";
      lastStreamThinking.current = "";
      return;
    }
    if (!tailContainerRef.current) return;
    if (!tailRendererRef.current) {
      const r = createStreamRenderer(tailContainerRef.current, {
        // Run the auto-scroll inside the renderer's rAF, after the
        // DOM has been updated. Single rAF for both the text write
        // and the scroll read.
        onAfterRender: () => {
          if (!stickToBottomRef.current) return;
          onBumpScroll();
        },
      });
      r.start();
      tailRendererRef.current = r;
    }
    const r = tailRendererRef.current;
    if (streamContent !== lastStreamContent.current) {
      const delta = streamContent.slice(lastStreamContent.current.length);
      lastStreamContent.current = streamContent;
      r.append(delta);
    }
    lastStreamThinking.current = streamThinking;
  }, [streaming, streamContent, streamThinking, stickToBottomRef, onBumpScroll]);

  // Cleanup on unmount (e.g. session change).
  useEffect(() => {
    return () => {
      tailRendererRef.current?.destroy();
      tailRendererRef.current = null;
    };
  }, []);

  if (!streaming) return null;

  return (
    <div className="px-4 py-2.5">
      {streamThinking && (
        <div className="mb-3 bg-surface-2/50 border border-border rounded-xl p-3 text-xs text-text-muted">
          <span className="text-text-muted font-medium block mb-1">✦ Thinking</span>
          <div className="whitespace-pre-wrap">{streamThinking}</div>
        </div>
      )}
      <div ref={tailContainerRef} className="prose prose-invert prose-sm leading-relaxed max-w-none break-words min-h-[1em]" />
      {!streamContent && !streamThinking && (
        <div className="inline-flex gap-1 items-end h-5">
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
        </div>
      )}
    </div>
  );
}

function parseAttachments(json: string | null | undefined): Array<{ id: string; name: string; mime: string; size: number; kind: string }> {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function AttachmentChip({ att }: { att: { id: string; name: string; mime: string; kind: string } }) {
  const isImage = att.kind === "image" || att.mime.startsWith("image/");
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-border rounded-md text-[10px] text-text-muted">
      <span className="text-text-subtle">{isImage ? "🖼" : att.mime === "application/pdf" ? "📕" : "📄"}</span>
      <span className="truncate max-w-[160px]">{att.name}</span>
    </div>
  );
}

function AttachmentStripItem({ a, onRemove }: { a: PendingAttachment; onRemove: () => void }) {
  return (
    <div className="relative group">
      {a.previewUrl ? (
        <div className="w-16 h-16 rounded-md border border-border overflow-hidden bg-surface-2">
          <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="px-2 py-1.5 bg-surface-2 border border-border rounded-md text-xs text-text-muted max-w-[180px] truncate">
          {a.name}
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-surface-3 border border-border rounded-full flex items-center justify-center text-text-muted hover:text-error"
        aria-label="Remove attachment"
      >
        <X size={9} />
      </button>
      {a.status === "uploading" && (
        <div className="absolute inset-0 bg-black/30 rounded-md flex items-center justify-center">
          <Spinner size={12} />
        </div>
      )}
    </div>
  );
}

function ChatInput({
  disabled,
  streaming,
  attachments,
  onSend,
  onStop,
  onInputChange,
  slashCtx,
}: {
  disabled: boolean;
  streaming: boolean;
  attachments: ReturnType<typeof useAttachments>;
  onSend: (text: string) => Promise<void> | void;
  onStop: () => void;
  onInputChange: (text: string) => void;
  slashCtx: SlashCommandContext;
}) {
  const [input, setInput] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  useEffect(() => {
    const onFocus = () => ref.current?.focus();
    window.addEventListener("convo:focus-input", onFocus);
    return () => window.removeEventListener("convo:focus-input", onFocus);
  }, []);

  // ArrowUp recall (last user message)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" && input === "" && ref.current && document.activeElement === ref.current) {
        // Use a custom event the chat route can listen to for last message
        e.preventDefault();
        const ev = new CustomEvent("convo:recall-last");
        window.dispatchEvent(ev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [input]);

  const openPicker = async () => {
    try {
      // Use the Tauri dialog plugin if available; fall back to <input type=file>
      const dialog = await import("@tauri-apps/plugin-dialog");
      const selected = await dialog.open({
        multiple: true,
        directory: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      // We can't directly read file bytes via dialog in Tauri v2 without fs.readFile; for now
      // use a hidden <input type=file> fallback.
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        if (input.files) attachments.addFiles(input.files);
      };
      input.click();
      void paths;
    } catch (e) {
      // Fallback
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        if (input.files) attachments.addFiles(input.files);
      };
      input.click();
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming || disabled) return;
    // Slash command?
    const parsed = parseCommand(text);
    if (parsed) {
      const result = await runCommand(parsed, slashCtx);
      if (result.sent && result.text) {
        // Replace input with transformed text and send
        setInput("");
        await onSend(result.text);
        return;
      }
      if (result.text !== undefined) {
        setInput(result.text);
        // Move focus to textarea for editing
        setTimeout(() => ref.current?.focus(), 0);
        return;
      }
      if (result.clear) {
        setInput("");
        return;
      }
    }
    setInput("");
    await onSend(text);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface-1/60 backdrop-blur shadow-modal">
      <textarea
        ref={ref}
        data-chat-input
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          onInputChange(e.target.value);
        }}
        onKeyDown={handleKey}
        placeholder="Type a message, or / for commands… (Enter to send, Shift+Enter for newline)"
        rows={1}
        disabled={disabled}
        className="w-full bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none px-4 pt-3 pb-1 resize-none overflow-y-auto"
        style={{ maxHeight: 200 }}
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <div className="flex items-center gap-1">
          <Tooltip content="Attach file (or drag & drop)">
            <IconButton icon={<Paperclip size={14} />} label="Attach" size="sm" onClick={openPicker} />
          </Tooltip>
        </div>
        <div className="flex items-center gap-1.5">
          {streaming ? (
            <Button size="sm" variant="danger" onClick={onStop} icon={<Square size={12} fill="currentColor" />}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              icon={<Send size={12} />}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * New ChatView — uses the multi-provider chat system, new types, new design.
 */
import { useEffect, useRef, useState } from "react";
import { Send, Square, ChevronUp, Plus, Paperclip, X, ChevronDown, Command } from "lucide-react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api, ChatMessage, Preset, Provider } from "../../lib/api";
import { useChat } from "../../hooks/useChat";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Spinner, Tooltip } from "../ui/Form";
import { IconButton } from "../ui/IconButton";

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
  const [presets, setPresets] = useState<Preset[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [modelName, setModelName] = useState<string>("");
  const [models, setModels] = useState<Array<{ name: string; size?: number; supports_thinking?: boolean; supports_vision?: boolean }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [contextLength, setContextLength] = useState(8192);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set());
  const [windowFocused, setWindowFocused] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; content: string; role: "user" | "assistant"; msgIndex: number | null; isThinking: boolean;
  } | null>(null);

  const currentPreset = presets.find((p) => p.id === presetId) || null;
  const chat = useChat(sessionId, currentPreset, modelName);

  // Load providers + presets
  useEffect(() => {
    api.listProviders().then((ps) => {
      setProviders(ps);
      const def = ps.find((p) => p.is_default) || ps[0];
      if (def) setProviderId(def.id);
    }).catch(console.error);
    api.listPresets().then(setPresets).catch(console.error);
  }, []);

  // Resolve session -> model, default model, etc.
  useEffect(() => {
    if (!providerId) return;
    setLoadingModels(true);
    // Try to discover models by probing the provider.
    if (providerId === "ollama-default" || providers.find((p) => p.id === providerId)?.kind === "ollama") {
      api.listModels()
        .then((m) => setModels(m.map((x) => ({ name: x.name, size: x.size }))))
        .catch(() => setModels([]))
        .finally(() => setLoadingModels(false));
    } else {
      // OpenAI-compat probe
      const p = providers.find((p) => p.id === providerId);
      if (p) {
        api.probeProvider(p.kind, p.base_url ?? "", p.api_key ?? undefined)
          .then((r) => {
            if (r.ok) setModels(r.models.map((m) => ({ name: m.name })));
            else setModels([]);
          })
          .catch(() => setModels([]))
          .finally(() => setLoadingModels(false));
      } else {
        setLoadingModels(false);
      }
    }
  }, [providerId, providers]);

  // Default model selection
  useEffect(() => {
    if (!modelName && models.length > 0) {
      setModelName(models[0].name);
      api.getModelContextLength(models[0].name).then(setContextLength).catch(() => {});
    }
  }, [models, modelName]);

  // Window focus tracking
  useEffect(() => {
    const onF = () => setWindowFocused(true);
    const onB = () => setWindowFocused(false);
    window.addEventListener("focus", onF);
    window.addEventListener("blur", onB);
    return () => {
      window.removeEventListener("focus", onF);
      window.removeEventListener("blur", onB);
    };
  }, []);

  const isEmpty = chat.messages.length === 0 && !chat.streaming;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full relative">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-border bg-surface-1/40 backdrop-blur">
        <Dropdown
          align="left"
          menuClassName="min-w-[260px]"
          trigger={
            <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-sm transition-colors">
              <span className="text-text-muted text-xs">Model</span>
              <span className="text-text font-medium">{modelName ? formatModelLabel(modelName) : "Loading…"}</span>
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
                      onClick={() => { setProviderId(p.id); setModelName(""); }}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${p.id === providerId ? "text-accent" : "text-text"}`}
                    >
                      <span>{p.name}</span>
                      <span className="text-text-subtle text-[10px]">{p.kind}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                </>
              )}
              {loadingModels ? (
                <div className="px-3 py-3 text-xs text-text-muted flex items-center gap-2"><Spinner size={12} /> Loading models…</div>
              ) : models.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-muted">No models — add one in Settings</div>
              ) : (
                models.map((m) => (
                  <button
                    key={m.name}
                    onClick={() => { setModelName(m.name); api.getModelContextLength(m.name).then(setContextLength).catch(() => {}); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-surface-2 ${m.name === modelName ? "bg-accent/10 text-accent" : "text-text"}`}
                  >
                    <span className="truncate">{formatModelLabel(m.name)}</span>
                    {m.size !== undefined && <span className="text-text-subtle text-[10px] ml-2">{(m.size / 1e9).toFixed(1)}GB</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </Dropdown>

        <Dropdown
          align="left"
          trigger={
            <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-sm transition-colors">
              <span className="text-text-muted text-xs">Preset</span>
              <span className="text-text">{currentPreset?.name ?? "None"}</span>
              <ChevronDown size={12} className="text-text-subtle" />
            </button>
          }
        >
          {() => (
            <div className="py-1 max-h-72 overflow-y-auto">
              <button
                onClick={() => setPresetId(null)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${!presetId ? "bg-accent/10 text-accent" : "text-text"}`}
              >
                None
              </button>
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPresetId(p.id)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${p.id === presetId ? "bg-accent/10 text-accent" : "text-text"}`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </Dropdown>

        <div className="flex-1" />

        <div className="text-xs text-text-muted">
          {chat.totalTokens.toLocaleString()} / {contextLength.toLocaleString()} tokens
          <span className="text-text-subtle ml-1">({Math.round((chat.totalTokens / contextLength) * 100)}%)</span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-subtle text-sm">
            Send a message to start the conversation.
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full py-4">
            {chat.messages.map((msg, i) => {
              const thinkingOpen = !collapsedThinking.has(i);
              return (
                <div key={msg.id} className="px-4 py-2.5" onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, content: msg.content, role: msg.role as "user" | "assistant", msgIndex: i, isThinking: false }); }}>
                  {msg.role === "assistant" && msg.thinking && (
                    <div className="mb-3 bg-surface-2/50 border border-border rounded-xl overflow-hidden">
                      <button
                        onClick={() => setCollapsedThinking((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}
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
                  <div className={`prose prose-invert prose-sm leading-relaxed max-w-none break-words ${msg.role === "user" ? "whitespace-pre-wrap" : ""}`}>
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code({ className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || "");
                          const codeStr = String(children).replace(/\n$/, "");
                          const inline = !match && !String(children).includes("\n");
                          if (inline) {
                            return <code className="bg-surface-2 rounded px-1 py-0.5 text-xs" {...props}>{children}</code>;
                          }
                          return (
                            <div className="code-block-wrap my-2">
                              <button className="code-copy" onClick={(e) => { navigator.clipboard.writeText(codeStr); e.preventDefault(); }}>Copy</button>
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
                      {msg.content}
                    </Markdown>
                  </div>
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
            })}
            {chat.streaming && (
              <div className="px-4 py-2.5">
                {chat.streamThinking && (
                  <div className="mb-3 bg-surface-2/50 border border-border rounded-xl p-3 text-xs text-text-muted whitespace-pre-wrap">
                    <span className="text-text-muted font-medium block mb-1">✦ Thinking</span>
                    {chat.streamThinking}
                  </div>
                )}
                {chat.streamContent ? (
                  <div className="prose prose-invert prose-sm leading-relaxed max-w-none break-words">
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {chat.streamContent}
                    </Markdown>
                  </div>
                ) : (
                  <div className="inline-flex gap-1 items-end h-5">
                    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" />
                    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
                    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border bg-surface-1/40 backdrop-blur px-4 py-3">
        <div className="max-w-3xl mx-auto">
          {chat.error && (
            <div className="mb-2 px-3 py-2 bg-error/10 border border-error/30 rounded-lg text-error text-xs">
              {chat.error}
            </div>
          )}
          <ChatInput
            disabled={chat.streaming || chat.loadingMessages || !modelName}
            streaming={chat.streaming}
            onSend={(text) => chat.send(text)}
            onStop={() => chat.stop()}
          />
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[100] min-w-[160px] glass border border-border rounded-lg shadow-modal py-1 animate-scale-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)}
        >
          <button
            onClick={() => { navigator.clipboard.writeText(contextMenu.content); setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            Copy
          </button>
          {contextMenu.role === "assistant" && (
            <button
              onClick={async () => {
                setContextMenu(null);
                if (!chat.messages[contextMenu.msgIndex!]) return;
                // Regenerate: resend the prior user message
                const i = contextMenu.msgIndex!;
                let userMsgIdx = i - 1;
                while (userMsgIdx >= 0 && chat.messages[userMsgIdx].role !== "user") userMsgIdx--;
                if (userMsgIdx < 0) return;
                const userText = chat.messages[userMsgIdx].content;
                // Truncate history to just before the assistant message and resend
                const truncated = chat.messages.slice(0, userMsgIdx);
                try {
                  await api.saveMessages(sessionId, truncated);
                  await chat.send(userText);
                } catch (e) { console.error(e); }
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
            >
              Regenerate
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChatInput({ disabled, streaming, onSend, onStop }: { disabled: boolean; streaming: boolean; onSend: (text: string) => void; onStop: () => void }) {
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

  const handleSend = () => {
    if (!input.trim() || streaming || disabled) return;
    onSend(input);
    setInput("");
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
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
        rows={1}
        disabled={disabled}
        className="w-full bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none px-4 pt-3 pb-1 resize-none overflow-y-auto"
        style={{ maxHeight: 200 }}
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <div className="flex items-center gap-1">
          <Tooltip content="Attach file (coming soon)">
            <IconButton icon={<Paperclip size={14} />} label="Attach" disabled size="sm" />
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

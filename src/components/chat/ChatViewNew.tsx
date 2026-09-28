/**
 * ChatViewNew — orchestrator for the multi-provider chat view.
 *
 * Phase 3 (v0.7): decomposed from 1219 lines into focused modules.
 * This file now only holds state, effects, callbacks, and JSX
 * composition of the extracted children:
 *   - ChatHeader, MessageList, StreamingTail, ChatInput,
 *     ChatContextMenu, AttachmentStripItem
 *
 * ── This page is not a `RouteShell` page, on purpose ──────────────────
 * Spec §4.2 gives every route a 28px title and a right-aligned action
 * cluster, and `RouteShell`'s own docblock says the "View:" pill belongs
 * to "Chat's model selector" — a sentence that reads as though Chat
 * passed its selector through `actions`. It does not, and cannot: a
 * conversation is a full-height scrolling column with a composer pinned
 * to the bottom, and a title bar above it would take 90px of the one
 * thing this surface is for. The model selector keeps the pill treatment
 * spec §4.2 describes, in the compact utility bar it has always lived
 * in, and the page below states the residual rather than hiding it.
 *
 * ── What re-renders at 60fps, and what does not ──────────────────────
 * Only `StreamingTail` is on the frame path, and it re-renders alone
 * because it subscribes to the streaming slices through a per-session
 * selector. This component subscribes through `useChat`, to five slices
 * that a chunk does not move, so the chrome below re-renders when a
 * message is added and when the stream starts and stops — not once per
 * frame. That is a property of the store's shape rather than of this
 * file, and it is the reason restyling the chrome is free: a
 * background, a radius or a border on a subtree that renders on message
 * boundaries costs nothing per frame, while the same change inside
 * `StreamingTail` would repaint it. `chatSurface.test.tsx` pins the
 * subscription list so a sixth slice added to `useChat` has to be
 * accounted for here.
 *
 * ── No shadow in the flow, and the three places there is one ─────────
 * The design is a surface plus a 1px border. The three `shadow-modal`
 * uses on this surface are overlays — the slash menu and the drag hint
 * below, and `ChatContextMenu` — and a shadow is what separates
 * something that floats from what it floats over. Nothing in the flow
 * carries one. The composer lost the last card shadow in the app and
 * took a surface step instead; see `ChatInput`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import { api, Model, Provider, Session } from "../../lib/api";
import { getLastUsedChatModel, getLastUsedModelForProvider, setLastUsedChatModel } from "../../lib/lastUsedChatModel";
import { useChat } from "../../hooks/useChat";
import { useAttachments } from "../../hooks/useAttachments";
import { filterCommands, SlashCommandContext } from "../../lib/slashCommands";
import { EmptyState } from "../ui/EmptyState";
import { ErrorBoundary } from "../ui/ErrorBoundary";

import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { StreamingTail } from "./StreamingTail";
import { ChatInput } from "./ChatInput";
import { ChatContextMenu } from "./ChatContextMenu";
import { AttachmentStripItem } from "./AttachmentChip";
import type { ChatContextMenuState } from "./types";

export function ChatViewNew({ sessionId, providers, session }: { sessionId: string; providers: Provider[]; session?: Session }) {
  const [models, setModels] = useState<Model[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [contextLength, setContextLength] = useState(8192);
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set());
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const navigate = useNavigate();
  const attachments = useAttachments(sessionId);

  const chat = useChat(sessionId, modelId, providerId);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const frame = requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [contextMenu]);

  // Close the right-click context menu on left-click outside of it, on
  // Esc, and on scroll.
  useEffect(() => {
    if (!contextMenu) return;
    const onLeftClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
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

  // Load the selected session's model from the already-refreshed session store.
  useEffect(() => {
    if (sessionLoaded) return;
    const defaultProvider = providers.find((p) => p.is_default) || providers[0];
    if (defaultProvider) setProviderId(defaultProvider.id);
    if (session) {
      if (session.model_id) {
        const sep = session.model_id.indexOf("::");
        if (sep >= 0) {
          setProviderId(session.model_id.slice(0, sep));
          setModelId(session.model_id.slice(sep + 2));
        } else {
          setModelId(session.model_id);
        }
      } else {
        const lastModel = getLastUsedChatModel();
        if (lastModel) {
          setProviderId(lastModel.providerId);
          setModelId(lastModel.modelId);
        }
      }
      if (session.provider_id) setProviderId(session.provider_id);
    }
    setSessionLoaded(true);
  }, [providers, session, sessionId, sessionLoaded]);

  // Refresh models when provider changes
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    (async () => {
      try {
        let list = await api.listModelsForProvider(providerId).catch(() => []);
        if (!list || list.length === 0) {
          list = await api.refreshModels(providerId).catch(() => []);
        }
        if (cancelled) return;
        setModels(list);
        if (list.length > 0 && !list.find((m) => m.name === modelId)) {
          const lastForProvider = getLastUsedModelForProvider(providerId);
          const preferred = lastForProvider && list.find((m) => m.name === lastForProvider)
            ? lastForProvider
            : list[0].name;
          setModelId(preferred);
        }
      } catch (e) {
        console.error("models load failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [providerId]);

  // Persist model selection to DB
  useEffect(() => {
    if (!sessionLoaded || !modelId || !providerId) return;
    setLastUsedChatModel(providerId, modelId);
    api.updateSessionModel(sessionId, `${providerId}::${modelId}`, providerId).catch(console.error);
  }, [modelId, providerId, sessionId, sessionLoaded]);

  // Resolve context length when model changes
  useEffect(() => {
    if (!modelId) return;
    const model = models.find((m) => m.name === modelId);
    if (model?.context_length !== null && model?.context_length !== undefined) {
      setContextLength(model.context_length);
      return;
    }
    const provider = providers.find((p) => p.id === providerId);
    if (provider?.kind !== "ollama") {
      setContextLength(8192);
      return;
    }
    api.getModelContextLength(modelId).then(setContextLength).catch(() => setContextLength(8192));
  }, [modelId, models, providerId, providers]);

  // Auto-scroll tracking
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

  // Send a message. sendMessage in the store is the single source
  // of truth for creating the user message — onSend no longer builds
  // a separate message with a different UUID (which caused
  // duplicates after chat.reload()).
  const onSend = async (text: string) => {
    stickToBottom.current = true;
    const readyIds = attachments.attachments.filter((a) => a.serverId).map((a) => a.serverId!);
    const attJson = attachments.serializeForMessage(readyIds);
    attachments.commit(readyIds);
    try {
      await chat.send(text, { attachmentsJson: attJson });
    } catch (error) {
      attachments.releaseCommitted(readyIds);
      throw error;
    }
  };

  const handleSlashInput = (text: string): boolean => {
    if (!text.startsWith("/")) {
      setShowSlashMenu(false);
      return false;
    }
    if (text.includes(" ") || text.length > 24) {
      setShowSlashMenu(false);
      return false;
    }
    setSlashQuery(text);
    setShowSlashMenu(true);
    return true;
  };

  const isEmpty = chat.messages.length === 0 && !chat.streaming;

  const bumpScroll = useCallback(() => {
    if (!stickToBottom.current) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onResend = useCallback(async (msgIndex: number, content: string) => {
    const message = chat.messages[msgIndex];
    if (!message) return;
    try {
      await api.truncateMessages(sessionId, message.id);
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
      await chat.clear();
    },
    newSession: async () => {
      navigate("/chat");
    },
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full relative">
      <ChatHeader
        providers={providers}
        models={models}
        providerId={providerId}
        modelId={modelId}
        setProviderId={setProviderId}
        setModelId={setModelId}
        setModels={setModels}
        setContextLength={setContextLength}
        sessionId={sessionId}
          contextLength={contextLength}
          totalTokens={chat.totalTokens}
          onClear={chat.clear}
      />

      {/* Messages */}
      <div ref={chatScrollRef} className="flex-1 overflow-y-auto" onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest("[data-ctx]")) {
          setContextMenu(null);
        }
      }}>
        {isEmpty ? (
          // The primitive rather than a bare centred sentence, so this
          // empty state is the same component as every other route's and
          // cannot drift from it.
          //
          // `headingLevel={2}` because this page owns no `h1` — it is not
          // a `RouteShell` page, for the reason in the header. An `h3`
          // here would be a heading whose whole outline starts three
          // levels down, which is worse than an `h2` that starts at two.
          // The page's missing `h1` is pre-existing and is Task 7's to
          // settle; this is the level that does not make it worse.
          <EmptyState
            className="h-full"
            headingLevel={2}
            icon={<MessageSquare size={28} />}
            title="No messages yet"
            description="Send a message to start the conversation."
          />
        ) : (
          <>
            <MessageList
              sessionId={sessionId}
              editingMessageId={editingMessageId}
              setEditingMessageId={setEditingMessageId}
              collapsedThinking={collapsedThinking}
              setCollapsedThinking={setCollapsedThinking}
              setContextMenu={setContextMenu}
              onBumpScroll={bumpScroll}
              onResend={onResend}
            />
            <ErrorBoundary label="Streaming">
              <StreamingTail
                sessionId={sessionId}
                stickToBottomRef={stickToBottom}
                onBumpScroll={bumpScroll}
              />
            </ErrorBoundary>
          </>
        )}
      </div>

      {/* Attachment strip */}
      {attachments.attachments.length > 0 && (
        <div className="px-3 sm:px-4 pb-1.5">
          <div className="max-w-3xl mx-auto flex flex-wrap gap-1.5">
            {attachments.attachments.map((a) => (
              <AttachmentStripItem
                key={a.localId}
                a={a}
                onRemove={() => attachments.remove(a.localId)}
                onRetry={() => attachments.retry(a.localId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border bg-surface-1 px-3 sm:px-4 py-3 relative">
        {/* Slash menu */}
        {showSlashMenu && (
          <div className="absolute bottom-full left-3 right-3 mb-1 max-w-3xl mx-auto bg-surface-1 border border-border rounded-lg shadow-modal max-h-64 overflow-y-auto animate-scale-in">
            {filterCommands(slashQuery).map((c) => (
              <button
                key={c.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowSlashMenu(false);
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
            <div role="alert" className="mb-2 px-3 py-2 bg-error/10 border border-error/30 rounded-lg text-error text-xs">
              <div className="flex items-center justify-between gap-2">
                <span>{chat.error}</span>
                <button
                  type="button"
                  onClick={() => chat.retryLast().catch(console.error)}
                  className="shrink-0 underline hover:text-text"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
          <ChatInput
            disabled={chat.streaming || !modelId}
            streaming={chat.streaming}
            status={chat.status}
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
        <ChatContextMenu
          contextMenu={contextMenu}
          contextMenuRef={contextMenuRef}
          setContextMenu={setContextMenu}
          chatMessages={chat.messages}
          sessionId={sessionId}
          collapsedThinking={collapsedThinking}
          setCollapsedThinking={setCollapsedThinking}
          setEditingMessageId={setEditingMessageId}
          chatReload={chat.reload}
          chatSend={chat.send}
        />
      )}
    </div>
  );
}

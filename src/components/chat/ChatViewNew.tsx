/**
 * ChatViewNew — orchestrator for the multi-provider chat view.
 *
 * Phase 3 (v0.7): decomposed from 1219 lines into focused modules.
 * This file now only holds state, effects, callbacks, and JSX
 * composition of the extracted children:
 *   - ChatHeader, MessageList, StreamingSection, ChatInput,
 *     ChatContextMenu, AttachmentStripItem
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ChatMessage, Provider, Model } from "../../lib/api";
import { getLastUsedChatModel, getLastUsedModelForProvider, setLastUsedChatModel } from "../../lib/lastUsedChatModel";
import { useChat } from "../../hooks/useChat";
import { useAttachments } from "../../hooks/useAttachments";
import { filterCommands, SlashCommandContext } from "../../lib/slashCommands";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { useChatStreamStore } from "../../stores/chatStream";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { StreamingSection } from "./StreamingSection";
import { ChatInput } from "./ChatInput";
import { ChatContextMenu } from "./ChatContextMenu";
import { AttachmentStripItem } from "./AttachmentChip";
import type { ChatContextMenuState } from "./types";

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
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const navigate = useNavigate();
  const attachments = useAttachments(sessionId);

  const chat = useChat(sessionId, modelId, providerId);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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

  // Load providers
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
          const sep = s.model_id.indexOf("::");
          if (sep >= 0) {
            setProviderId(s.model_id.slice(0, sep));
            setModelId(s.model_id.slice(sep + 2));
          } else {
            setModelId(s.model_id);
          }
        } else {
          const lastModel = getLastUsedChatModel();
          if (lastModel) {
            setProviderId(lastModel.providerId);
            setModelId(lastModel.modelId);
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
    await chat.send(text, { attachmentsJson: attJson });
    attachments.clear();
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
      await chat.reload();
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
      />

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
            <ErrorBoundary label="Streaming">
              <StreamingSection
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
              <AttachmentStripItem key={a.localId} a={a} onRemove={() => attachments.remove(a.localId)} />
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border bg-surface-1/40 backdrop-blur px-3 sm:px-4 py-3 relative">
        {/* Slash menu */}
        {showSlashMenu && (
          <div className="absolute bottom-full left-3 right-3 mb-1 max-w-3xl mx-auto glass border border-border rounded-lg shadow-modal max-h-64 overflow-y-auto animate-scale-in">
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
        <ChatContextMenu
          contextMenu={contextMenu}
          contextMenuRef={contextMenuRef}
          setContextMenu={setContextMenu}
          chatMessages={chat.messages}
          sessionId={sessionId}
          collapsedThinking={collapsedThinking}
          setCollapsedThinking={setCollapsedThinking}
          setEditingMessageId={setEditingMessageId}
          setEditingText={setEditingText}
          chatReload={chat.reload}
          chatSend={chat.send}
        />
      )}
    </div>
  );
}
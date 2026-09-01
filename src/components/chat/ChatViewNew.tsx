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
import { api, ChatMessage, Model, Provider, Session } from "../../lib/api";
import { getLastUsedChatModel, getLastUsedModelForProvider, setLastUsedChatModel } from "../../lib/lastUsedChatModel";
import { useChat } from "../../hooks/useChat";
import { useAttachments } from "../../hooks/useAttachments";
import { filterCommands, SlashCommandContext } from "../../lib/slashCommands";
import { toast } from "../../stores/toasts";
import { useSlashCommandsStore } from "../../stores/slashCommands";
import {
  acquireResendLock,
  isClearLocked,
  isResendLocked,
  releaseResendLock,
  type ResendLock,
} from "../../stores/chatStream";
import { ErrorBoundary } from "../ui/ErrorBoundary";

import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { StreamingSection } from "./StreamingSection";
import { ChatInput } from "./ChatInput";
import { ChatContextMenu } from "./ChatContextMenu";
import { AttachmentStripItem } from "./AttachmentChip";
import type { ChatContextMenuState } from "./types";

interface ResendRecoveryResult {
  saveError: unknown | null;
  reloadError: unknown | null;
}

async function restoreResendSnapshot(
  sessionId: string,
  messages: ChatMessage[],
  reload: () => Promise<void>,
): Promise<ResendRecoveryResult> {
  let saveError: unknown | null = null;
  let reloadError: unknown | null = null;
  try {
    await api.saveMessages(sessionId, messages);
  } catch (error) {
    saveError = error;
  }
  try {
    await reload();
  } catch (error) {
    reloadError = error;
  }
  return { saveError, reloadError };
}

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
  const customSlashCommands = useSlashCommandsStore((state) => state.commands);
  const refreshSlashCommands = useSlashCommandsStore((state) => state.refresh);

  const navigate = useNavigate();
  const attachments = useAttachments(sessionId);

  const chat = useChat(sessionId, modelId, providerId, contextLength);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const resendStateRef = useRef<{
    streaming: boolean;
    messages: ChatMessage[];
    reload: () => Promise<void>;
    send: (text: string, options?: {
      attachmentsJson?: string | null;
      resendSnapshot?: ChatMessage[];
      resendLock?: ResendLock;
    }) => Promise<boolean>;
  } | null>(null);
  resendStateRef.current = {
    streaming: chat.streaming,
    messages: chat.messages,
    reload: chat.reload,
    send: chat.send,
  };

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

  // Prompt commands are low-frequency state; load them once without coupling
  // this view to the high-frequency streaming slices.
  useEffect(() => {
    void Promise.resolve(refreshSlashCommands()).catch(() => undefined);
  }, [refreshSlashCommands]);

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
    let cancelled = false;
    api.getModelContextLength(modelId)
      .then((length) => {
        if (!cancelled) setContextLength(length);
      })
      .catch(() => {
        if (!cancelled) setContextLength(8192);
      });
    return () => { cancelled = true; };
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
  const onSend = async (text: string): Promise<boolean> => {
    if (isResendLocked(sessionId)) {
      toast.warn("Wait for resend recovery to finish before sending.");
      return false;
    }
    if (isClearLocked(sessionId)) {
      toast.warn("Wait for message clearing to finish before sending.");
      return false;
    }
    stickToBottom.current = true;
    const readyIds = attachments.attachments.filter((a) => a.serverId).map((a) => a.serverId!);
    const attJson = attachments.serializeForMessage(readyIds);
    const sent = await chat.send(text, { attachmentsJson: attJson });
    if (sent === false) return false;
    attachments.commit(readyIds);
    return true;
  };

  const handleSlashInput = (text: string): boolean => {
    if (!text.startsWith("/")) {
      setShowSlashMenu(false);
      return false;
    }
    if (text.includes(" ") || text.length > 33) {
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
    const current = resendStateRef.current;
    if (!current) return;
    if (current.streaming) {
      toast.warn("Stop the current response before editing or regenerating.");
      return;
    }
    const resendLock = acquireResendLock(sessionId);
    if (!resendLock) {
      toast.warn("Another resend or recovery is already in progress.");
      return;
    }
    try {
      const message = current.messages[msgIndex];
      if (!message) return;
      const snapshot = current.messages.slice();
      let truncated = false;
      let sendStarted = false;
      try {
        await api.truncateMessages(sessionId, message.id);
        truncated = true;
        await current.reload();
        sendStarted = true;
        await current.send(content, {
          attachmentsJson: message.attachments_json,
          resendSnapshot: snapshot,
          resendLock,
        });
        setEditingMessageId(null);
      } catch (e) {
        if (!truncated) {
          toast.error(`Unable to resend message. Your draft was kept. ${String(e)}`);
          return;
        }
        if (sendStarted) {
          // The store owns recovery once the replacement send has started.
          toast.error(`Unable to resend message. Your draft was kept. ${String(e)}`);
          return;
        }
        const recovery = await restoreResendSnapshot(sessionId, snapshot, current.reload);
        const recoveryMessage = recovery.saveError || recovery.reloadError
          ? ` The original history could not be fully restored. ${String(recovery.saveError ?? recovery.reloadError)}`
          : " The original history was restored.";
        toast.error(`Unable to resend message. Your draft was kept.${recoveryMessage} ${String(e)}`);
      }
    } finally {
      releaseResendLock(resendLock);
    }
  }, [sessionId]);

  const slashCtx: SlashCommandContext = {
    sessionId,
    setModelId: (id) => setModelId(id),
    setProviderId: (id) => setProviderId(id),
    currentModel: modelId,
    resendLast: async () => {
      await chat.retryLast();
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
          <div className="flex items-center justify-center h-full text-text-subtle text-sm">
            Send a message to start the conversation.
          </div>
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
            {filterCommands(slashQuery, customSlashCommands).map((c) => (
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
          canRegenerate={!chat.streaming}
        />
      )}
    </div>
  );
}

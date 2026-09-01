
import { api } from "../../lib/api";
import { ChatMessage } from "../../lib/api";
import { toast } from "../../stores/toasts";
import {
  acquireResendLock,
  releaseResendLock,
  type ResendLock,
} from "../../stores/chatStream";
import type { ChatContextMenuState } from "./types";

interface ChatContextMenuProps {
  contextMenu: ChatContextMenuState;
  contextMenuRef: React.RefObject<HTMLDivElement>;
  setContextMenu: (m: ChatContextMenuState | null) => void;
  chatMessages: ChatMessage[];
  sessionId: string;
  collapsedThinking: Set<number>;
  setCollapsedThinking: React.Dispatch<React.SetStateAction<Set<number>>>;
  setEditingMessageId: (id: string | null) => void;
  chatReload: () => Promise<void>;
  chatSend: (text: string, options?: {
    attachmentsJson?: string | null;
    resendSnapshot?: ChatMessage[];
    resendLock?: ResendLock;
  }) => Promise<boolean | void>;
  canRegenerate?: boolean;
}

async function restoreResendSnapshot(
  sessionId: string,
  messages: ChatMessage[],
  reload: () => Promise<void>,
): Promise<{ saveError: unknown | null; reloadError: unknown | null }> {
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

export function ChatContextMenu({
  contextMenu,
  contextMenuRef,
  setContextMenu,
  chatMessages,
  sessionId,
  setCollapsedThinking,
  setEditingMessageId,
  chatReload,
  chatSend,
  canRegenerate = true,
}: ChatContextMenuProps) {
  return (
    <div
      ref={contextMenuRef}
      role="menu"
      aria-label="Message actions"
      tabIndex={-1}
      className="fixed z-[100] min-w-[180px] bg-surface-1 border border-border rounded-lg shadow-modal py-1 animate-scale-in"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={() => setContextMenu(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setContextMenu(null);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = Array.from(contextMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      <button
        role="menuitem"
        type="button"
        onClick={() => { navigator.clipboard.writeText(contextMenu.content); setContextMenu(null); toast.success("Copied"); }}
        className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
      >
        Copy
      </button>
      <button
        role="menuitem"
        type="button"
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
            role="menuitem"
            type="button"
            disabled={!canRegenerate}
            title={!canRegenerate ? "Stop the current response before regenerating" : undefined}
            onClick={async () => {
              if (!canRegenerate) {
                toast.warn("Stop the current response before regenerating.");
                return;
              }
              setContextMenu(null);
              if (contextMenu.msgIndex === null) return;
              const i = contextMenu.msgIndex;
              let userMsgIdx = i - 1;
              while (userMsgIdx >= 0 && chatMessages[userMsgIdx].role !== "user") userMsgIdx--;
              if (userMsgIdx < 0) return;
              const userMessage = chatMessages[userMsgIdx];
              const userText = userMessage.content;
              const resendLock = acquireResendLock(sessionId);
              if (!resendLock) {
                toast.warn("Another resend or recovery is already in progress.");
                return;
              }
              const snapshot = chatMessages.slice();
              let truncated = false;
              let sendStarted = false;
              try {
                await api.truncateMessages(sessionId, userMessage.id);
                truncated = true;
                await chatReload();
                sendStarted = true;
                await chatSend(userText, {
                  attachmentsJson: userMessage.attachments_json,
                  resendSnapshot: snapshot,
                  resendLock,
                });
              } catch (e) {
                if (!truncated) {
                  toast.error(`Regenerate failed. ${String(e)}`);
                  return;
                }
                if (sendStarted) {
                  // The store owns recovery once the replacement send starts.
                  toast.error(`Regenerate failed. ${String(e)}`);
                  return;
                }
                const recovery = await restoreResendSnapshot(sessionId, snapshot, chatReload);
                const recoveryMessage = recovery.saveError || recovery.reloadError
                  ? ` The original history could not be fully restored. ${String(recovery.saveError ?? recovery.reloadError)}`
                  : " The original history was restored.";
                toast.error(`Regenerate failed.${recoveryMessage} ${String(e)}`);
              } finally {
                releaseResendLock(resendLock);
              }
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Regenerate
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={async () => {
              setContextMenu(null);
              if (contextMenu.msgIndex === null) return;
              const idx = contextMenu.msgIndex;
              setCollapsedThinking((s) => {
                const n = new Set(s);
                n.has(idx) ? n.delete(idx) : n.add(idx);
                return n;
              });
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            Toggle thinking
          </button>
        </>
      )}
      {contextMenu.role === "user" && contextMenu.msgIndex !== null && (
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            setContextMenu(null);
            const m = chatMessages[contextMenu.msgIndex!];
            if (m) {
              setEditingMessageId(m.id);
            }
          }}
          className="w-full text-left px-3 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Edit & resend
        </button>
      )}
      <button
        role="menuitem"
        type="button"
        onClick={async () => {
          if (contextMenu.msgIndex === null) return;
          setContextMenu(null);
          const idx = contextMenu.msgIndex;
           try {
             await api.deleteMessage(sessionId, chatMessages[idx].id);
             await chatReload();
          } catch (e) {
            toast.error(`Delete failed. ${String(e)}`);
          }
        }}
        className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-surface-2"
      >
        Delete message
      </button>
      <div className="my-1 border-t border-border/60" />
      <button
        role="menuitem"
        type="button"
        onClick={async () => {
          setContextMenu(null);
          if (contextMenu.msgIndex === null) return;
          const m = chatMessages[contextMenu.msgIndex];
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
  );
}

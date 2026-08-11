
import { api } from "../../lib/api";
import { ChatMessage } from "../../lib/api";
import { toast } from "../../stores/toasts";
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
  setEditingText: (text: string) => void;
  chatReload: () => Promise<void>;
  chatSend: (text: string) => Promise<void>;
}

export function ChatContextMenu({
  contextMenu,
  contextMenuRef,
  setContextMenu,
  chatMessages,
  sessionId,
  setCollapsedThinking,
  setEditingMessageId,
  setEditingText,
  chatReload,
  chatSend,
}: ChatContextMenuProps) {
  return (
    <div
      ref={contextMenuRef}
      className="fixed z-[100] min-w-[180px] bg-surface-1 border border-border rounded-lg shadow-modal py-1 animate-scale-in"
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
              while (userMsgIdx >= 0 && chatMessages[userMsgIdx].role !== "user") userMsgIdx--;
              if (userMsgIdx < 0) return;
              const userText = chatMessages[userMsgIdx].content;
              try {
                await api.truncateMessages(sessionId, chatMessages[userMsgIdx].id);
                await chatReload();
                await chatSend(userText);
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
          onClick={() => {
            setContextMenu(null);
            const m = chatMessages[contextMenu.msgIndex!];
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
           try {
             await api.deleteMessage(sessionId, chatMessages[idx].id);
             await chatReload();
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

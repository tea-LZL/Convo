import React, { useRef, useEffect, useMemo, useState } from "react";
import { ChevronDown, Check, Edit2 } from "lucide-react";
import { ChatMessage } from "../../lib/api";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { useChatStreamStore } from "../../stores/chatStream";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { AttachmentChip, parseAttachments } from "./AttachmentChip";
import { formatTimestamp } from "./format";
import type { MessageRowProps, MessageListProps } from "./types";

/**
 * Strip `<think>` / `</think>` tags from content so react-markdown
 * renders the inner text normally instead of treating the tags as
 * raw HTML (which gets stripped).  The streaming renderer
 * (renderMarkdown) handles this automatically via escapeHtml; this
 * is the matching corrector for the static MarkdownRenderer path.
 */
export function escapeThinkTags(text: string): string {
  return text.replace(/<\/?think>/gi, "");
}

const EMPTY_MESSAGES_LIST: ChatMessage[] = [];

export interface MemoryUsedRow {
  ownerType: string;
  ownerId: string;
  /** The kind heading — "Project facts", "Pinned note". A group, not a row. */
  label: string;
  /** The row's own name. Without it the list cannot say *which* fact. */
  title: string | null;
  /** `null` for a pinned row or a session note: it was not retrieved. */
  reason: string | null;
}

/**
 * Parse the snapshot Rust wrote onto a message.
 *
 * Tolerates anything: a row from a newer build, a hand-edited value, or
 * `null` on a message written before V013. A provenance chip that throws
 * would take the whole chat down, so every unknown shape is "no
 * provenance" rather than an error.
 */
export function parseMemoryUsed(raw: string | null): MemoryUsedRow[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { ownerType, ownerId, label, title, reason } = entry as Record<string, unknown>;
    if (typeof ownerType !== "string" || typeof ownerId !== "string" || typeof label !== "string") {
      return [];
    }
    return [
      {
        ownerType,
        ownerId,
        label,
        title: typeof title === "string" ? title : null,
        reason: typeof reason === "string" ? reason : null,
      },
    ];
  });
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
    pm.memory_used === nm.memory_used &&
    pm.created_at === nm.created_at &&
    prev.editingMessageId === next.editingMessageId &&
    prev.collapsedThinking === next.collapsedThinking &&
    prev.sessionId === next.sessionId
  );
}

export const MessageRow = React.memo(function MessageRow({
  msg,
  i,
  sessionId,
  editingMessageId,
  setEditingMessageId,
  collapsedThinking,
  setCollapsedThinking,
  setContextMenu,
  onResend,
}: MessageRowProps) {
  const thinkingOpen = !collapsedThinking.has(i);
  const [editText, setEditText] = useState(msg.content);
  const atts = parseAttachments(msg.attachments_json);
  const memoryUsed = parseMemoryUsed(msg.memory_used);

  useEffect(() => {
    if (editingMessageId === msg.id) setEditText(msg.content);
  }, [editingMessageId, msg.content, msg.id]);

  return (
    <div
      key={msg.id}
      data-ctx
      className="px-4 py-2.5 group animate-message-in"
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
        <div
          data-thinking-panel
          className="mb-3 bg-surface-2/50 border border-border rounded-xl overflow-hidden"
        >
          <button
            onClick={() => setCollapsedThinking((s) => {
              const n = new Set(s);
              n.has(i) ? n.delete(i) : n.add(i);
              return n;
            })}
            className="w-full flex items-center gap-2 px-3 py-2 bg-surface-2/40 hover:bg-surface-3/70 text-text-muted hover:text-text text-xs transition-colors"
            aria-expanded={thinkingOpen}
          >
            <span>✦</span>
            <span className="flex-1 text-left font-medium">Thinking</span>
            <ChevronDown size={12} className={`transition-transform ${thinkingOpen ? "" : "-rotate-90"}`} />
          </button>
          <div className={`transition-[max-height,opacity] duration-200 overflow-hidden ${thinkingOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}`}>
            <div className="px-3 pb-2.5 pt-1 text-xs text-text-muted leading-relaxed whitespace-pre-wrap">
              {msg.thinking}
            </div>
          </div>
        </div>
      )}
      {editingMessageId === msg.id ? (
        <div className="bg-surface-2 border border-border rounded-md p-2">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={Math.max(2, Math.min(10, editText.split("\n").length + 1))}
            className="w-full bg-transparent text-sm text-text focus:outline-none resize-none"
            autoFocus
          />
          <div className="flex items-center gap-1 justify-end mt-1">
            <Button size="xs" variant="ghost" onClick={() => setEditingMessageId(null)}>Cancel</Button>
            <Button
              size="xs"
              variant="primary"
              onClick={async () => {
                const newContent = editText.trim();
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
        // A surface, a 1px border and a token radius — the same
        // treatment every other filled token in the app wears, and the
        // reason the edge does not depend on `--color-user-bubble`
        // happening to contrast with the page in themes nobody has
        // measured.
        //
        // `--radius-lg` is the card radius and is 16px in the four
        // themes that keep the default scale, so this moved no pixel
        // from the 1rem default it replaced; on Mono and High Contrast,
        // which declare 6px, it goes 16px → 6px on purpose. The radius is
        // pinned to `ChatSkeleton`'s placeholder half, and the pin is
        // textual duplication — so `chatSurface.test.tsx` compares the two
        // *renderings* rather than two literals, and a commit that
        // converts one half and not the other fails there instead of
        // silently disagreeing.
        <div className="bg-userbubble border border-border rounded-lg px-3.5 py-2 text-sm text-text whitespace-pre-wrap break-words inline-block max-w-[85%]">
          {msg.content}
          <div className="mt-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton icon={<Edit2 size={11} />} label="Edit & resend" size="sm" onClick={() => setEditingMessageId(msg.id)} />
          </div>
        </div>
      ) : (
        <div className="prose prose-invert prose-sm leading-relaxed max-w-none break-words">
          <MarkdownRenderer content={escapeThinkTags(msg.content)} />
        </div>
      )}
      {msg.role === "assistant" && msg.created_at && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] text-text-subtle tabular-nums">
              {formatTimestamp(msg.created_at)}
            </span>
            {memoryUsed.length > 0 && (
              // A disclosure, not a badge: the count is the answer to "did it
              // remember anything", and the list is the answer to "what".
              // Reasons come from retrieval, so a pinned row says "pinned"
              // rather than inventing one.
              <details className="text-[10px] text-text-subtle">
                <summary className="cursor-pointer select-none hover:text-text-muted">
                  {memoryUsed.length} {memoryUsed.length === 1 ? "memory" : "memories"} used
                </summary>
                <ul className="mt-1 space-y-0.5 pl-2 text-text-muted">
                  {memoryUsed.map((row) => (
                    <li key={`${row.ownerType}:${row.ownerId}`}>
                      {/* The title names the row; the label only names its
                          kind. A memory deleted since the send keeps the
                          title here, which is what makes the list auditable
                          after the fact. */}
                      <span className="text-text">{row.title ?? row.label}</span>
                      {" — "}
                      {row.reason ?? "pinned"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
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

/**
 * Subscribes only to the messages slice. The array reference is
 * stable across stream updates (the bump shallow-copies the
 * SessionState but doesn't touch the messages array), so this
 * component re-renders only when a message is added/removed/edited.
 */
export const MessageList = React.memo(function MessageList({
  sessionId,
  editingMessageId,
  setEditingMessageId,
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

  // The edit draft belongs to the active MessageRow. Keeping it out of
  // this component means typing in one long-history row does not rebuild
  // the JSX array for every message on every keystroke.
  const renderedMessages = useMemo(
    () => messages.map((msg, i) => (
      <MessageRow
        key={msg.id}
        msg={msg}
        i={i}
        sessionId={sessionId}
        editingMessageId={editingMessageId}
        setEditingMessageId={setEditingMessageId}
        collapsedThinking={collapsedThinking}
        setCollapsedThinking={setCollapsedThinking}
        setContextMenu={setContextMenu}
        onResend={onResend}
      />
    )),
    [messages, sessionId, editingMessageId, collapsedThinking, setEditingMessageId, setCollapsedThinking, setContextMenu, onResend]
  );

  return <div className="max-w-3xl mx-auto w-full px-3 sm:px-4 py-4">{renderedMessages}</div>;
});

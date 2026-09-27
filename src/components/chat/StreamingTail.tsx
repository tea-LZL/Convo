import React, { useEffect, useMemo } from "react";
import { useChatStreamStore } from "../../stores/chatStream";
import { splitBlocks } from "../../lib/markdownBlocks";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { StreamingTailProps } from "./types";

/**
 * Streaming markdown, rendered with React.
 *
 * Replaces a DOM-direct renderer that wrote HTML strings into a
 * container element. That approach had two problems: it needed its own
 * HTML renderer separate from the one used for settled messages, so
 * every completed message restyled itself the instant its stream ended;
 * and it bypassed React entirely, which is why it needed its own
 * freeze bookkeeping to avoid re-rendering what could not change.
 *
 * Here React.memo *is* the freeze bookkeeping. `splitBlocks` divides
 * the source into blocks that can no longer change and one live tail.
 * Each block renders through the same `MarkdownRenderer` used by settled
 * messages, so there is one renderer and no restyle. Because a frozen
 * block's source string never changes, `MarkdownRenderer`'s existing
 * `React.memo` (which compares `content` alone) skips the re-parse, and
 * only the tail re-parses on each frame.
 */

/**
 * One block. Memoized on `content`, which is the whole point: a frozen
 * block's content never changes, so this never re-renders after its
 * first paint.
 */
const MarkdownBlock = React.memo(function MarkdownBlock({ content }: { content: string }) {
  return <MarkdownRenderer content={content} />;
});

/**
 * Render accumulated markdown as frozen blocks plus a live tail.
 *
 * Exported separately from `StreamingTail` because it is the piece worth
 * testing: it has no store dependency, no scrolling, and no thinking
 * panel, so parity and memoization can be asserted directly.
 */
export const MarkdownBlocks = React.memo(function MarkdownBlocks({ text }: { text: string }) {
  const split = useMemo(() => splitBlocks(text), [text]);

  return (
    <>
      {split.frozen.map((block, i) => (
        <MarkdownBlock key={i} content={block} />
      ))}
      {split.tail && <MarkdownBlock content={split.tail} />}
    </>
  );
});

/**
 * The live assistant response while a stream is in flight.
 *
 * Subscribes only to the streaming slices, via inline selectors — the
 * same ones the previous implementation used. A per-session slice
 * selector returns a stable value while other sessions update, which is
 * what keeps the rest of the message list from re-rendering 60 times a
 * second. Do not widen these to the whole session object.
 *
 * Returns null when not streaming: the stream's final content is
 * persisted and re-rendered from source as a normal message.
 */
export function StreamingTail({ sessionId, stickToBottomRef, onBumpScroll }: StreamingTailProps) {
  const streaming = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streaming ?? false
  );
  const streamContent = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamContent ?? ""
  );
  const streamThinking = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamThinking ?? ""
  );

  // Auto-scroll in the same frame as the render, so the tail is never
  // one frame behind the viewport.
  useEffect(() => {
    if (streaming && stickToBottomRef.current) onBumpScroll();
  }, [streaming, streamContent, stickToBottomRef, onBumpScroll]);

  if (!streaming) return null;

  return (
    <div className="max-w-3xl mx-auto w-full px-3 sm:px-4 py-2.5">
      {streamThinking && (
        <div className="mb-3 bg-surface-2/50 border border-border rounded-xl p-3 text-xs text-text-muted">
          <span className="text-text-muted font-medium block mb-1">✦ Thinking</span>
          <div className="whitespace-pre-wrap">{streamThinking}</div>
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        className="prose prose-invert prose-sm leading-relaxed max-w-none break-words min-h-[1em]"
      >
        <MarkdownBlocks text={streamContent} />
      </div>
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

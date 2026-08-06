import { useRef, useEffect } from "react";
import { createStreamRenderer, StreamRenderer } from "../../lib/streamingRenderer";
import { renderMarkdown } from "../../lib/markdown";
import { useChatStreamStore } from "../../stores/chatStream";
import type { StreamingSectionProps } from "./types";

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
export function StreamingSection({ sessionId, stickToBottomRef, onBumpScroll }: StreamingSectionProps) {
  const streaming = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streaming ?? false
  );
  const streamContent = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamContent ?? ""
  );
  const streamThinking = useChatStreamStore(
    (s) => s.sessions[sessionId]?.streamThinking ?? ""
  );

  // v0.6.7: odysseus-style stream renderer. The renderer is plain
  // DOM, owned by this component via a ref. We never touch its
  // children from React; we just call update(fullText) on each
  // streamContent change. The renderer handles its own frozen/tail
  // split and fence-mode append without per-token DOM animation.
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<StreamRenderer | null>(null);
  const lastContentRef = useRef<string>("");

  useEffect(() => {
    if (!streaming) {
      // Stream ended. Finalize the renderer so any uncommitted tail
      // is frozen canonically; the section will then unmount on the
      // next non-streaming render.
      if (rendererRef.current) {
        try { rendererRef.current.finalize(); } catch { /* degraded */ }
        rendererRef.current = null;
      }
      lastContentRef.current = "";
      return;
    }
    if (!contentRef.current) return;
    if (!rendererRef.current) {
      rendererRef.current = createStreamRenderer(contentRef.current, {
        render: renderMarkdown,
      });
    }
    if (streamContent !== lastContentRef.current) {
      lastContentRef.current = streamContent;
      rendererRef.current.update(streamContent);
      // Auto-scroll in the same animation frame as the DOM update.
      if (stickToBottomRef.current) onBumpScroll();
    }
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
        ref={contentRef}
        role="status"
        aria-live="polite"
        className="prose prose-invert prose-sm leading-relaxed max-w-none break-words min-h-[1em]"
      />
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

/**
 * Streaming markdown renderer.
 *
 * Renders a stream of incremental markdown tokens as DOM. Uses the segmenter
 * to identify "frozen" blocks (rendered once and never re-rendered) and a
 * "live tail" (re-rendered each token). The live tail is updated by
 * mutating a single `<div>`'s innerHTML, while frozen blocks live in
 * separate elements that are never touched again.
 *
 * Usage:
 *   const r = createStreamRenderer(targetEl);
 *   r.start();
 *   r.append("Hello");  // call many times
 *   r.append(" world");
 *   r.finalize();  // when done — last re-render of the tail
 *   r.destroy();
 */
import { segment } from "./streamingSegmenter";
import Markdown from "react-markdown";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";

export interface StreamRenderer {
  start(): void;
  append(delta: string): void;
  finalize(): void;
  destroy(): void;
  /** Current full source. */
  getSource(): string;
  /** Replace the source entirely (e.g. when restoring from cache). */
  setSource(s: string): void;
}

const ENABLED = true;

export function createStreamRenderer(target: HTMLElement): StreamRenderer {
  let source = "";
  let started = false;
  let tailEl: HTMLElement | null = null;
  let tailRoot: Root | null = null;
  let frozenEl: HTMLElement | null = null;
  let lastRenderedTail = "";
  let degraded = !ENABLED;
  let openCodeFence = false;

  function isOpenFence(s: string): boolean {
    const ticks = (s.match(/^```/gm) || []).length;
    return ticks % 2 === 1;
  }

  function render() {
    if (!target || !tailEl) return;
    if (degraded) {
      // Fallback: full re-render of source.
      if (frozenEl) {
        frozenEl.innerHTML = "";
        tailRoot?.render(
          createElement(
            Markdown as any,
            {},
            source || ""
          )
        );
      }
      return;
    }
    if (!source) {
      tailRoot?.render(null as any);
      return;
    }
    // Open-code-fence mode: if the source ends with an unmatched ```, the
    // segmenter would put everything into the tail anyway. To avoid a lot of
    // churn, we freeze everything before the last ``` and let the tail hold
    // the open fence + its accumulating content.
    const blocks = segment(source);
    // Move newly frozen blocks from the previous tail into the frozen column.
    const frozenCount = blocks.filter((b) => b.frozen).length;
    if (frozenEl) {
      const desired = blocks
        .slice(0, frozenCount)
        .map((b) => b.source)
        .join("\n\n");
      if (frozenEl.dataset.source !== desired) {
        frozenEl.dataset.source = desired;
        frozenEl.innerHTML = "";
        // Render the frozen portion
        tailRoot?.unmount();
        tailRoot = createRoot(frozenEl);
        tailRoot.render(
          createElement(Markdown as any, { children: desired || " " })
        );
      }
    }
    // Render the live tail
    const tailSource = blocks
      .slice(frozenCount)
      .map((b) => b.source)
      .join("\n\n");
    if (tailSource !== lastRenderedTail) {
      lastRenderedTail = tailSource;
      tailRoot?.unmount();
      tailRoot = createRoot(tailEl);
      tailRoot.render(createElement(Markdown as any, { children: tailSource || "" }));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      target.innerHTML = "";
      frozenEl = document.createElement("div");
      frozenEl.className = "stream-frozen";
      tailEl = document.createElement("div");
      tailEl.className = "stream-tail";
      target.appendChild(frozenEl);
      target.appendChild(tailEl);
    },
    append(delta: string) {
      try {
        source += delta;
        render();
      } catch (e) {
        console.error("stream render error; falling back to degraded", e);
        degraded = true;
        render();
      }
    },
    finalize() {
      try {
        // Force one more pass to make sure everything is rendered.
        render();
      } catch (e) {
        console.error("stream finalize error", e);
      }
    },
    destroy() {
      try {
        tailRoot?.unmount();
      } catch {}
      tailRoot = null;
      tailEl = null;
      frozenEl = null;
      target.innerHTML = "";
    },
    getSource() {
      return source;
    },
    setSource(s: string) {
      source = s;
      lastRenderedTail = "";
      if (frozenEl) frozenEl.dataset.source = "";
      if (frozenEl) frozenEl.innerHTML = "";
      render();
    },
  };
}

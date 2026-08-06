/**
 * Streaming markdown renderer.
 *
 * The DOM shell for incremental streaming markdown rendering. One
 * instance owns the DOM of one streaming assistant message and is
 * the only thing that writes to it while it streams.
 *
 * It keeps the message as two regions, separated by an invisible
 * comment marker so the rendered blocks are direct children of the
 * container (no wrapper elements to disturb CSS):
 *
 *     [ finalized block, frozen ][ finalized block, frozen ] <!--tail--> [ live tail ]
 *
 *   - Finalized blocks are rendered once and never touched again —
 *     so code-block hover buttons can't flicker and code is
 *     highlighted exactly once.
 *   - The live tail (the still-growing trailing block) is
 *     re-rendered each token, except an open code fence, which
 *     streams in append-mode (text appended to a stable <pre>,
 *     highlighted once when it closes).
 *
 * All the "is this safe to freeze?" logic lives in the pure
 * segmenter; this file is deliberately mechanical. If anything
 * throws, it latches into a full-re-render fallback so a bug can
 * never produce broken output — only today's behavior.
 *
 * The render function is provided by the caller (see
 * src/lib/markdown.ts). The renderer is renderer-agnostic: any
 * function `(text: string) => string` works. The renderer also
 * accepts an optional `hljs` (highlight.js) instance to highlight
 * code blocks once on freeze / fence close.
 *
 * Architecture (v0.6.7 — wholesale port of odysseus's
 * streamingRenderer.js, originally 206 lines, structure preserved
 * verbatim). The previous Convo renderer (v0.6.4-v0.6.6) had a
 * paced reveal, per-tick inline-emphasis re-parsing, and a
 * per-tick full tail rebuild — superseded by this design.
 */
import { splitFinalized, describeOpenFence } from "./streamingSegmenter";

export interface StreamRendererOpts {
  /**
   * Canonical markdown renderer. The same function is used in the
   * segmenter's self-verifying `cutIsRenderSafe` check, so it must
   * be deterministic. See src/lib/markdown.ts.
   */
  render: (src: string) => string;
  /**
   * Optional highlight.js instance. If provided, code blocks are
   * highlighted once on freeze (and once when a closing fence
   * lands in the live tail).
   */
  hljs?: { highlightElement: (el: Element) => void };
}

export interface StreamRenderer {
  /**
   * Render the latest full source text.
   *
   * PRECONDITION: callers must pass append-only text — each call's
   * `fullText` must extend the previous one with the already-seen
   * prefix UNCHANGED. Finalized blocks are frozen and never
   * re-rendered, so a feed that rewrites earlier text would leave
   * stale frozen blocks (corrected only by the next full
   * re-render).
   */
  update(fullText: string): void;
  /**
   * Stream finished: freeze whatever is left canonically and
   * flatten away the marker so the container holds exactly what a
   * single full render would produce. Self-heals from any state.
   */
  finalize(): void;
}

export function createStreamRenderer(
  contentEl: HTMLElement,
  opts: StreamRendererOpts,
): StreamRenderer {
  const { render, hljs } = opts;

  let started = false;
  let tailMarker: Comment | null = null; // finalized nodes precede it; live-tail nodes follow it
  let committedLen = 0; // chars of source already frozen
  let lastText = ""; // most recent full text (for finalize / degraded fallback)
  let tailShownLen = 0;
  let appendMode: { codeText: Text; appendedLen: number } | null = null; // open fence
  let degraded = false; // latched on first throw → fall back to full re-render

  function start() {
    contentEl.textContent = "";
    tailMarker = document.createComment("tail");
    contentEl.appendChild(tailMarker);
    started = true;
  }

  function highlight(root: Element) {
    if (hljs) root.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
  }

  function clearTail() {
    while (tailMarker && tailMarker.nextSibling) {
      (tailMarker.nextSibling as ChildNode).remove();
    }
  }

  // Render `src` and freeze the nodes before the tail marker.
  // Highlighting happens here, once, on the detached fragment
  // before the nodes are ever shown.
  function freeze(src: string) {
    if (!tailMarker) return;
    const holder = document.createElement("div");
    holder.innerHTML = render(src);
    highlight(holder);
    while (holder.firstChild) contentEl.insertBefore(holder.firstChild, tailMarker);
  }

  // Re-render the live tail. An open trailing fence streams in
  // append-mode.
  function renderTail(tailText: string) {
    const fence = tailText ? describeOpenFence(tailText) : null;
    if (fence) {
      appendOpenFence(tailText, fence);
      return;
    }
    appendMode = null;
    clearTail();
    if (!tailText) {
      tailShownLen = 0;
      return;
    }
    const holder = document.createElement("div");
    holder.innerHTML = render(tailText);
    tailShownLen = holder.textContent.length;
    while (holder.firstChild) contentEl.appendChild(holder.firstChild);
  }

  // Stream the body of an unterminated code fence by appending
  // only the new characters to a stable <pre><code> text node —
  // no re-parse, no re-highlight.
  function appendOpenFence(tailText: string, fence: { lang: string; contentStart: number }) {
    if (!appendMode) {
      clearTail();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence.lang) code.className = `language-${fence.lang}`;
      const textNode = document.createTextNode("");
      code.appendChild(textNode);
      pre.appendChild(code);
      contentEl.appendChild(pre);
      appendMode = { codeText: textNode, appendedLen: 0 };
       tailShownLen = 0;
    }
    const code = tailText.slice(fence.contentStart);
    if (code.length > appendMode.appendedLen) {
      appendMode.codeText.appendData(code.slice(appendMode.appendedLen));
      appendMode.appendedLen = code.length;
    }
  }

  function fullRender(fullText: string) {
    contentEl.innerHTML = render(fullText);
    highlight(contentEl);
  }

  function update(fullText: string) {
    lastText = fullText;
    if (degraded) {
      fullRender(fullText);
      return;
    }
    try {
      // Self-heal: if our DOM was replaced out from under us (the
      // chat view writes contentEl.innerHTML directly for
      // thinking indicators; finalize() removes the marker), our
      // tail marker is no longer a child of the container. Rebuild
      // from scratch so we never append onto foreign content or
      // touch a detached marker.
      if (started && (!tailMarker || tailMarker.parentNode !== contentEl)) {
        started = false;
        committedLen = 0;
        tailShownLen = 0;
        appendMode = null;
      }
      if (!started) start();
      const next = splitFinalized(fullText, render, committedLen);
      if (next > committedLen) {
        freeze(fullText.slice(committedLen, next));
        committedLen = next;
        appendMode = null; // whatever was streaming is now frozen
        tailShownLen = 0;
      }
      renderTail(fullText.slice(committedLen));
    } catch (err) {
      console.error("streamingRenderer: falling back to full render", err);
      degraded = true;
      fullRender(fullText);
    }
  }

  function finalize() {
    if (degraded) return;
    try {
      if (!started) start();
      clearTail();
      appendMode = null;
      const rest = lastText.slice(committedLen);
      if (rest.trim()) freeze(rest);
      if (tailMarker) {
        tailMarker.remove();
        tailMarker = null;
      }
      committedLen = lastText.length;
    } catch (err) {
      console.error("streamingRenderer: falling back to full render", err);
      degraded = true;
      fullRender(lastText);
    }
  }

  return { update, finalize };
}

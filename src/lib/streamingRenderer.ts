/**
 * Streaming markdown renderer.
 *
 * Renders a stream of incremental markdown source as DOM. The design:
 *
 * - The source is split by the segmenter into "frozen" blocks (rendered
 *   once and never touched) and a "live tail" (re-rendered each token).
 * - The frozen blocks are rendered to plain DOM nodes (a `<div>`
 *   containing the rendered HTML, with `code-block-wrap` wrappers
 *   preserved so styling matches the static message renderer) and
 *   appended to a single `frozenEl` container. Existing children are
 *   never re-rendered; we only ever append the next block.
 * - The live tail is a single `<div>` whose inner HTML is updated
 *   with the same inline-emphasis + backtick transforms that the
 *   frozen-block path uses. This makes the tail visually identical
 *   to the eventual frozen block at every frame, so the user never
 *   sees raw `*` and backtick characters in flight. Escape-first
 *   then transform — safe for innerHTML.
 * - When a code fence is open in the tail, the tail renders as a
 *   `<pre><code>` block (monospace, bordered). Fence-mode styles
 *   are written once on mode transitions, not on every frame.
 * - DOM updates are coalesced with `requestAnimationFrame` so a burst
 *   of chunks only triggers one paint.
 * - The optional `onAfterRender` callback fires synchronously at the
 *   end of the rAF, after the DOM has been updated, so the chat view
 *   can read the new scrollHeight and set scrollTop in the same
 *   frame. Eliminates the two-rAF race that caused scroll jitter.
 *
 * Usage:
 *   const r = createStreamRenderer(targetEl, { onAfterRender });
 *   r.start();
 *   r.append("Hello");  // call many times
 *   r.finalize();  // when done
 *   r.destroy();
 */
import { segment } from "./streamingSegmenter";

export interface StreamRenderer {
  start(): void;
  append(delta: string): void;
  finalize(): void;
  destroy(): void;
  getSource(): string;
  setSource(s: string): void;
}

export interface StreamRendererOpts {
  /**
   * Called synchronously at the end of each rAF, after the DOM has
   * been updated. Use this to read scrollHeight and adjust scrollTop
   * in the same frame as the text update — avoids the 1-frame scroll
   * lag that happens when the render and the scroll are in two
   * separate rAFs.
   */
  onAfterRender?: () => void;
}

const FENCE_RE = /^(```|~~~)/;

export function createStreamRenderer(
  target: HTMLElement,
  opts: StreamRendererOpts = {},
): StreamRenderer {
  let source = "";
  let started = false;
  let frozenEl: HTMLDivElement | null = null;
  let tailEl: HTMLDivElement | null = null;
  let lastRenderedTail = "";
  let lastFrozenCount = 0;
  let lastFenceMode: boolean | null = null;
  let rafPending = false;

  function isOpenFence(s: string): boolean {
    const ticks = (s.match(FENCE_RE) || []).length;
    return ticks % 2 === 1;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Escape first, then apply inline transforms: **x** -> <strong>,
   * *x* -> <em>, `x` -> <code>. Newlines become <br>. The
   * paragraph and list-item branches of blockToHtml() use the
   * exact same transforms — keep them in sync so the tail and
   * the frozen block render identically at every frame.
   */
  function inlineToHtml(s: string): string {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`\n]+)`/g, "<code style=\"background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;\">$1</code>")
      .replace(/\n/g, "<br>");
  }

  /**
   * Render a single frozen block to an HTML string. We keep the
   * `code-block-wrap` wrapper around fenced code so the existing
   * `.code-block-wrap` / `.code-lang` / `.code-copy` CSS in
   * globals.css keeps working. Other blocks get paragraph wrapping.
   */
  function blockToHtml(block: string): string {
    // Trim leading/trailing blank lines for cleaner HTML
    const trimmed = block.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return "";
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      // Fenced code block
      const lines = trimmed.split("\n");
      // First line is the opening fence (optionally with a language)
      const openLine = lines[0];
      const langMatch = openLine.match(/^[`~]{3,}(\w*)/);
      const lang = langMatch?.[1] || "";
      const body = lines.slice(1, -1).join("\n");
      const langLabel = lang || "code";
      return `<div class="code-block-wrap"><button class="code-copy">Copy</button><span class="code-lang">${escapeHtml(langLabel)}</span><pre style="margin:0;border-radius:10px;border:1px solid var(--color-border);background:var(--color-surface-1);padding:16px;overflow:auto;font-family:var(--font-mono);font-size:0.875em;line-height:1.5;color:#e6e8ee;"><code>${escapeHtml(body)}</code></pre></div>`;
    }
    if (trimmed.startsWith("#")) {
      // Heading
      const m = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const level = m[1].length;
        const text = escapeHtml(m[2]);
        return `<h${level} style="margin:0.5em 0 0.4em;font-weight:600;">${text}</h${level}>`;
      }
    }
    if (trimmed.startsWith(">")) {
      const body = trimmed.split("\n").map((l) => l.replace(/^>\s?/, "")).join("<br>");
      return `<blockquote style="margin:0.5em 0;padding:0.4em 0.8em;border-left:2px solid var(--color-border-strong);color:var(--color-text-muted);">${escapeHtml(body)}</blockquote>`;
    }
    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      const isOrdered = /^\d+\.\s/.test(trimmed);
      const tag = isOrdered ? "ol" : "ul";
      const items = trimmed.split("\n").map((l) => {
        const t = l.replace(/^(?:[-*+]|\d+\.)\s+/, "");
        return `<li>${escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`([^`]+)`/g, "<code style=\"background:var(--color-surface-2);padding:1px 4px;border-radius:3px;\">$1</code>")}</li>`;
      }).join("");
      return `<${tag} style="margin:0.4em 0;padding-left:1.4em;">${items}</${tag}>`;
    }
    if (/^---+$/.test(trimmed.trim()) || /^\*\*\*+$/.test(trimmed.trim()) || /^___+$/.test(trimmed.trim())) {
      return `<hr style="border:0;border-top:1px solid var(--color-border);margin:0.8em 0;" />`;
    }
    if (/^\|[^\n]*\|/.test(trimmed)) {
      // Simple table: render rows as a flex column with cells separated
      const rows = trimmed.split("\n").filter((l) => l.trim() && !/^\|[\s-:|]+\|$/.test(l.trim()));
      const html = rows
        .map((l) => {
          const cells = l.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
          return `<div style="display:flex;gap:1em;">${cells
            .map((c) => `<span style="flex:1;">${escapeHtml(c).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</span>`)
            .join("")}</div>`;
        })
        .join("");
      return `<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.5em 0.8em;margin:0.5em 0;">${html}</div>`;
    }
    // Default: paragraph. Inline emphasis + code backticks.
    const html = escapeHtml(trimmed)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`\n]+)`/g, "<code style=\"background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;\">$1</code>")
      .replace(/\n/g, "<br>");
    return `<p style="margin:0.4em 0;">${html}</p>`;
  }

  function doRender() {
    rafPending = false;
    if (!frozenEl || !tailEl) return;
    if (!source) {
      tailEl.innerHTML = "";
      tailEl.removeAttribute("data-fence");
      lastFenceMode = null;
      opts.onAfterRender?.();
      return;
    }
    const blocks = segment(source);
    const frozenBlocks = blocks.filter((b) => b.frozen);
    const tailBlocks = blocks.slice(frozenBlocks.length);

    // Append any new frozen blocks as raw HTML
    if (frozenBlocks.length > lastFrozenCount) {
      const frag = document.createDocumentFragment();
      for (let i = lastFrozenCount; i < frozenBlocks.length; i++) {
        const wrap = document.createElement("div");
        wrap.innerHTML = blockToHtml(frozenBlocks[i].source);
        // Pull the children out of the wrapper so the frozen container
        // holds the block elements directly (one per block).
        while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      }
      frozenEl.appendChild(frag);
      lastFrozenCount = frozenBlocks.length;
    }

    // Render the live tail with the same inline-emphasis + backtick
    // transforms that blockToHtml() uses on the paragraph branch.
    // Tail and frozen block now render identically at every frame,
    // so the user never sees raw `*` or backtick characters in
    // flight, and there's no "pop" when a block freezes.
    const tailSource = tailBlocks.map((b) => b.source).join("\n\n");
    if (tailSource !== lastRenderedTail) {
      lastRenderedTail = tailSource;
      const fence = isOpenFence(tailSource);
      if (fence) {
        if (lastFenceMode !== true) {
          tailEl.setAttribute("data-fence", "open");
          tailEl.style.whiteSpace = "pre-wrap";
          tailEl.style.fontFamily = "var(--font-mono)";
          tailEl.style.fontSize = "0.875em";
          tailEl.style.background = "var(--color-surface-1)";
          tailEl.style.border = "1px solid var(--color-border)";
          tailEl.style.borderRadius = "10px";
          tailEl.style.padding = "12px 16px";
          lastFenceMode = true;
        }
        // In fence mode, write raw text — no inline emphasis, no
        // <br>. The user is inside a code block; markdown does
        // not apply. Use textContent (safe — no HTML in code).
        tailEl.textContent = tailSource;
      } else {
        if (lastFenceMode !== false) {
          tailEl.removeAttribute("data-fence");
          tailEl.style.whiteSpace = "pre-wrap";
          tailEl.style.fontFamily = "";
          tailEl.style.fontSize = "";
          tailEl.style.background = "transparent";
          tailEl.style.border = "none";
          tailEl.style.borderRadius = "";
          tailEl.style.padding = "";
          lastFenceMode = false;
        }
        // Normal prose mode: write as innerHTML with escape +
        // inline emphasis + backticks. The exact same transform
        // the frozen-block path uses.
        tailEl.innerHTML = inlineToHtml(tailSource);
      }
    }

    // Notify the chat view that the DOM is up-to-date. The chat
    // view uses this to read scrollHeight and set scrollTop in
    // the same frame as the text update, eliminating the
    // two-rAF race that caused scroll jitter.
    opts.onAfterRender?.();
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(doRender);
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
      lastFrozenCount = 0;
      lastRenderedTail = "";
    },
    append(delta: string) {
      source += delta;
      scheduleRender();
    },
    finalize() {
      // One last pass at the next frame.
      scheduleRender();
    },
    destroy() {
      try {
        tailEl = null;
        frozenEl = null;
        target.innerHTML = "";
      } catch { /* ignore */ }
    },
    getSource() {
      return source;
    },
    setSource(s: string) {
      source = s;
      lastRenderedTail = "";
      lastFrozenCount = 0;
      if (frozenEl) {
        frozenEl.innerHTML = "";
      }
      scheduleRender();
    },
  };
}

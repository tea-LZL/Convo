/**
 * Streaming markdown renderer.
 *
 * Architecture (v0.6.4 — opencode ideology applied to a Tauri/React
 * stack):
 *
 * The source is split by the segmenter into "frozen" blocks (rendered
 * once and never touched) and a "live tail" (re-rendered each pace
 * tick). The key addition in this revision is **paced reveal**: the
 * store/stream holds the full text immediately, but the *visible*
 * text advances 2-24 characters at a time at word boundaries via a
 * 24ms setTimeout. This is opencode's createPacedValue pattern
 * (packages/ui/src/components/message-part.tsx:180-233) ported to
 * a plain-DOM renderer.
 *
 * Why it matters: the previous renderer re-parsed the inline-emphasis
 * pipeline on every chunk and re-wrote the tail's innerHTML on every
 * frame. When a new chunk crossed an emphasis-pair boundary
 * (`*hello*` -> `<em>hello</em>`), the entire tail element was
 * rebuilt. The user saw a brief blink at the asterisk.
 *
 * With paced reveal:
 *  - The visible text only advances 2-24 chars at word boundaries,
 *    so the *hello* pair is fully formed by the time the visible
 *    prefix includes it.
 *  - Inline emphasis is applied to the visible prefix only (not the
 *    full target), and only when a complete pair is in the visible
 *    range. A partial `*hello` is plain text. A complete `*hello*`
 *    becomes `<em>hello</em>`. The transition is atomic — no
 *    asterisk blink.
 *  - Auto-scroll fires from the pace tick, in the same rAF set as
 *    the visible text update, so the scroll read happens after the
 *    new height is in the DOM.
 *
 * Frozen blocks: rendered once via blockToHtml() and appended to a
 * single frozenEl container. Existing children are never re-rendered;
 * we only ever append the next block. Code-fence styles write once
 * per fence transition, not per frame.
 *
 * Usage:
 *   const r = createStreamRenderer(targetEl, { onAfterRender });
 *   r.start();
 *   r.append("Hello");  // call many times
 *   r.finalize();  // when done — fast-forwards visible text
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
   * Fires after the DOM is updated: either a new frozen block was
   * appended, or a pace tick advanced the visible text. Use this
   * to read scrollHeight and adjust scrollTop in the same frame as
   * the text update, eliminating the two-rAF scroll race.
   */
  onAfterRender?: () => void;
}

const FENCE_RE = /^(```|~~~)/;
const PACE_MS = 24;
const SNAP_RE = /[\s.,!?;:)\]]/;

/** Pacing step: how many characters to advance per tick. */
function paceStep(totalLen: number): number {
  if (totalLen <= 12) return 2;
  if (totalLen <= 48) return 4;
  if (totalLen <= 96) return 8;
  return Math.min(24, Math.ceil(totalLen / 8));
}

/**
 * Given the current visible prefix length and the target string,
 * return the next visible prefix length. Advances `paceStep` chars,
 * then snaps to the next word/punctuation boundary within
 * `paceStep*2` chars (if available), so a partial word isn't left
 * hanging at the edge.
 */
function nextPace(shown: number, target: string): number {
  if (shown >= target.length) return target.length;
  const step = paceStep(target.length);
  let end = Math.min(shown + step, target.length);
  if (end < target.length) {
    const windowEnd = Math.min(end + step, target.length);
    for (let i = end; i < windowEnd; i++) {
      if (SNAP_RE.test(target[i])) { end = i + 1; break; }
    }
  }
  return end;
}

export function createStreamRenderer(
  target: HTMLElement,
  opts: StreamRendererOpts = {},
): StreamRenderer {
  let source = "";
  let started = false;
  let frozenEl: HTMLDivElement | null = null;
  let tailEl: HTMLDivElement | null = null;
  let lastFrozenCount = 0;
  let lastFenceMode: boolean | null = null;
  let rafPending = false;

  // Pacing state.
  // - tailText: the post-frozen tail text that *should* be visible
  // - shown: the number of characters currently visible
  // The pace loop advances `shown` toward `tailText.length` at PACE_MS
  // intervals, snapping to word boundaries. finalize() fast-forwards.
  let tailText = "";
  let shown = 0;
  let paceTimer: number | null = null;
  let lastRenderedVisible = "";

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Same inline transforms as blockToHtml's paragraph branch.
   * Used for the frozen-block append path.
   */
  function inlineToHtml(s: string): string {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`\n]+)`/g, "<code style=\"background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;\">$1</code>")
      .replace(/\n/g, "<br>");
  }

  /**
   * Render a single frozen block to an HTML string. The existing
   * .code-block-wrap / .code-lang / .code-copy CSS in globals.css
   * keeps working.
   */
  function blockToHtml(block: string): string {
    const trimmed = block.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return "";
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const lines = trimmed.split("\n");
      const openLine = lines[0];
      const langMatch = openLine.match(/^[`~]{3,}(\w*)/);
      const lang = langMatch?.[1] || "";
      const body = lines.slice(1, -1).join("\n");
      const langLabel = lang || "code";
      return `<div class="code-block-wrap"><button class="code-copy">Copy</button><span class="code-lang">${escapeHtml(langLabel)}</span><pre style="margin:0;border-radius:10px;border:1px solid var(--color-border);background:var(--color-surface-1);padding:16px;overflow:auto;font-family:var(--font-mono);font-size:0.875em;line-height:1.5;color:#e6e8ee;"><code>${escapeHtml(body)}</code></pre></div>`;
    }
    if (trimmed.startsWith("#")) {
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
    const html = escapeHtml(trimmed)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`\n]+)`/g, "<code style=\"background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;\">$1</code>")
      .replace(/\n/g, "<br>");
    return `<p style="margin:0.4em 0;">${html}</p>`;
  }

  function isOpenFence(s: string): boolean {
    const ticks = (s.match(FENCE_RE) || []).length;
    return ticks % 2 === 1;
  }

  /**
   * Apply inline emphasis to a freshly-written plain-text tail.
   * After this, the tail contains a mix of text nodes and
   * <strong>/<em>/<code> elements. We only format *complete* pairs
   * in the visible prefix — a partial `*hello` is left as plain
   * text. When the next pace tick advances `shown` past the closing
   * `*`, the text-node range `*hello*` is replaced with `<em>hello</em>`
   * in one operation.
   */
  function applyInlineEmToTail(el: HTMLElement, visible: string) {
    if (!visible) {
      el.textContent = "";
      return;
    }
    el.textContent = visible;

    // Find all complete emphasis/code pairs. Order matters: try
    // ** first (longer), then *, then `.
    const matches: Array<{ start: number; end: number; tag: string; inner: string }> = [];
    const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(visible)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[1] !== undefined) {
        matches.push({ start, end, tag: "strong", inner: m[1] });
      } else if (m[2] !== undefined) {
        matches.push({ start, end, tag: "em", inner: m[2] });
      } else if (m[3] !== undefined) {
        matches.push({ start, end, tag: "code", inner: m[3] });
      }
    }
    if (matches.length === 0) return;

    // Walk the text node(s) of the element, splitting at match
    // boundaries and wrapping the matched ranges. We process
    // matches in reverse so earlier ranges keep their offsets.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);
    if (textNodes.length === 0) return;

    // Build an offset->node map by accumulating node lengths.
    // Single text node in practice (we just set textContent), but
    // be defensive.
    const ranges: Array<{ start: number; end: number; node: Text; nodeStart: number }> = [];
    let offset = 0;
    for (const node of textNodes) {
      const len = node.data.length;
      ranges.push({ start: offset, end: offset + len, node, nodeStart: offset });
      offset += len;
    }

    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      // Find the text node containing match.start and match.end
      const startRange = ranges.find((r) => match.start >= r.start && match.start < r.end);
      const endRange = ranges.find((r) => match.end > r.start && match.end <= r.end);
      if (!startRange || !endRange) continue;
      if (startRange.node !== endRange.node) continue; // don't cross text nodes
      const node = startRange.node;
      const localStart = match.start - startRange.nodeStart;
      const localEnd = match.end - startRange.nodeStart;

      const before = node.data.slice(0, localStart);
      const after = node.data.slice(localEnd);
      const parent = node.parentNode;
      if (!parent) continue;

      // Build the replacement: [before text] [formatted element] [after text]
      // If the match is at the very start or end, one of the
      // surrounding pieces may be empty.
      const inner = escapeHtml(match.inner);
      const style = match.tag === "code"
        ? "background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;"
        : "";
      const el2 = document.createElement(match.tag);
      if (style) el2.setAttribute("style", style);
      el2.innerHTML = inner;

      // Replace the node in-place.
      const beforeNode = before ? document.createTextNode(before) : null;
      const afterNode = after ? document.createTextNode(after) : null;
      const ref = node;
      if (beforeNode) parent.insertBefore(beforeNode, ref);
      parent.insertBefore(el2, ref);
      if (afterNode) parent.insertBefore(afterNode, ref);
      parent.removeChild(ref);
    }
  }

  function isLiveFence(): boolean {
    if (!tailEl) return false;
    if (lastFenceMode === true) return true;
    if (lastFenceMode === false) return false;
    return isOpenFence(tailText);
  }

  function setFenceMode(on: boolean) {
    if (!tailEl) return;
    if (on) {
      tailEl.setAttribute("data-fence", "open");
      tailEl.style.whiteSpace = "pre-wrap";
      tailEl.style.fontFamily = "var(--font-mono)";
      tailEl.style.fontSize = "0.875em";
      tailEl.style.background = "var(--color-surface-1)";
      tailEl.style.border = "1px solid var(--color-border)";
      tailEl.style.borderRadius = "10px";
      tailEl.style.padding = "12px 16px";
    } else {
      tailEl.removeAttribute("data-fence");
      tailEl.style.whiteSpace = "pre-wrap";
      tailEl.style.fontFamily = "";
      tailEl.style.fontSize = "";
      tailEl.style.background = "transparent";
      tailEl.style.border = "none";
      tailEl.style.borderRadius = "";
      tailEl.style.padding = "";
    }
    lastFenceMode = on;
  }

  /**
   * Render the currently-visible prefix of the tail. Called by
   * the pace tick (every 24ms when there's more to reveal), by
   * finalize() (to fast-forward), and by setSource() (to re-reveal
   * after navigation). Idempotent if the visible prefix hasn't
   * changed.
   */
  function renderVisible() {
    if (!tailEl) return;
    const visible = tailText.slice(0, shown);
    if (visible === lastRenderedVisible) return;
    lastRenderedVisible = visible;
    const fence = isOpenFence(tailText);
    if (fence !== lastFenceMode) setFenceMode(fence);
    if (fence) {
      // In fence mode, write raw text. No inline emphasis, no
      // <br>. Markdown doesn't apply inside a code block.
      tailEl.textContent = visible;
    } else {
      applyInlineEmToTail(tailEl, visible);
    }
    opts.onAfterRender?.();
  }

  function schedulePace() {
    if (paceTimer !== null) return;
    if (shown >= tailText.length) return;
    paceTimer = window.setTimeout(() => {
      paceTimer = null;
      if (!started) return;
      if (shown < tailText.length) {
        shown = nextPace(shown, tailText);
        renderVisible();
        if (shown < tailText.length) schedulePace();
      }
    }, PACE_MS);
  }

  function recomputeTarget() {
    if (!source) {
      tailText = "";
      return;
    }
    const blocks = segment(source);
    const tailBlocks = blocks.slice(blocks.filter((b) => b.frozen).length);
    tailText = tailBlocks.map((b) => b.source).join("\n\n");
  }

  function doRender() {
    rafPending = false;
    if (!frozenEl || !tailEl) return;
    if (!source) {
      tailText = "";
      shown = 0;
      lastRenderedVisible = "";
      tailEl.textContent = "";
      if (lastFenceMode !== null) setFenceMode(false);
      opts.onAfterRender?.();
      return;
    }
    const blocks = segment(source);
    const frozenBlocks = blocks.filter((b) => b.frozen);

    // Append any new frozen blocks as raw HTML
    if (frozenBlocks.length > lastFrozenCount) {
      const frag = document.createDocumentFragment();
      for (let i = lastFrozenCount; i < frozenBlocks.length; i++) {
        const wrap = document.createElement("div");
        wrap.innerHTML = blockToHtml(frozenBlocks[i].source);
        while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      }
      frozenEl.appendChild(frag);
      lastFrozenCount = frozenBlocks.length;
    }

    // Update tailText for the pace loop. If the tailText length
    // shrank (rare; would only happen on a setSource reset that
    // was already handled), reset shown.
    const prevLen = tailText.length;
    recomputeTarget();
    if (tailText.length < prevLen) {
      shown = 0;
      lastRenderedVisible = "";
    }

    // If a frozen block was just appended, the layout changed.
    // Fire onAfterRender so the scroll read happens in this
    // frame, not on the next pace tick.
    if (frozenBlocks.length > 0) {
      opts.onAfterRender?.();
    }

    schedulePace();
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
      lastRenderedVisible = "";
      lastFenceMode = null;
      tailText = "";
      shown = 0;
    },
    append(delta: string) {
      source += delta;
      scheduleRender();
    },
    finalize() {
      // Fast-forward: skip the pacing and show everything
      // immediately. Still runs in the next rAF to batch with
      // any pending append().
      scheduleRender();
      if (paceTimer !== null) {
        clearTimeout(paceTimer);
        paceTimer = null;
      }
      if (!source) return;
      const blocks = segment(source);
      const frozenBlocks = blocks.filter((b) => b.frozen);
      if (frozenBlocks.length > lastFrozenCount) {
        const frag = document.createDocumentFragment();
        for (let i = lastFrozenCount; i < frozenBlocks.length; i++) {
          const wrap = document.createElement("div");
          wrap.innerHTML = blockToHtml(frozenBlocks[i].source);
          while (wrap.firstChild) frag.appendChild(wrap.firstChild);
        }
        if (frozenEl) frozenEl.appendChild(frag);
        lastFrozenCount = frozenBlocks.length;
      }
      recomputeTarget();
      shown = tailText.length;
      renderVisible();
    },
    destroy() {
      if (paceTimer !== null) {
        clearTimeout(paceTimer);
        paceTimer = null;
      }
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
      lastFrozenCount = 0;
      lastRenderedVisible = "";
      if (frozenEl) frozenEl.innerHTML = "";
      recomputeTarget();
      shown = 0;
      if (lastFenceMode !== null) setFenceMode(isOpenFence(tailText));
      // Re-reveal from scratch via the pace loop.
      schedulePace();
    },
  };
}

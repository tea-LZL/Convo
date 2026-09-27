/**
 * A second markdown renderer, not on any render path.
 *
 * Streaming and settled messages both render through
 * `MarkdownRenderer` (react-markdown). This module is a hand-rolled
 * regex -> HTML string implementation that predates that, kept because
 * the block-splitter tests use it as a pure oracle: it is a total
 * function from source to HTML with no React, no DOM and no syntax
 * highlighter, which makes it a convenient thing to assert a split
 * against. It is deterministic for the same reason.
 *
 * Slated for removal once the splitter's contracts are covered by
 * React-level assertions alone.
 *
 * v0.6.7: extracted from the previous streamingRenderer.ts
 * (blockToHtml + inlineToHtml were private helpers there) and
 * unified into a single function. The streaming renderer no
 * longer needs to distinguish "frozen block" vs "live tail"
 * rendering — segment() decides what's a boundary, renderMarkdown
 * produces HTML for any prefix of the text, and the renderer
 * freezes the safe prefix and re-renders only the tail.
 *
 * This is plain string concatenation, no React, no
 * react-markdown AST parse, no react-syntax-highlighter. Highlight
 * runs once on the detached fragment in the streaming renderer
 * (via the optional `hljs` opt), and on the final render for
 * static messages (handled separately by the React MarkdownRenderer
 * in ChatViewNew).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a single block (paragraph, heading, list, code fence,
 * etc.) to an HTML string. Works for both complete and partial
 * blocks — partial blocks get the same treatment as complete
 * ones; the segmenter freezes on safe boundaries.
 */
function blockToHtml(block: string): string {
  const trimmed = block.replace(/^\n+|\n+$/g, "");
  if (!trimmed) return "";

  if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
    // Fenced code block. If unclosed, use the partial as the body.
    //
    // This renderer is no longer on any render path: StreamingTail and
    // settled messages both go through MarkdownRenderer. It is kept as
    // the pure oracle that markdownBlocks.test.ts and streaming's
    // block-split contracts are checked against.
    const lines = trimmed.split("\n");
    const openLine = lines[0];
    const langMatch = openLine.match(/^[`~]{3,}(\w*)/);
    const lang = langMatch?.[1] || "";
    // If the last line is a closing fence, exclude it from the body.
    // For an unclosed fence (live tail), include everything after the
    // opening fence to the end.
    const lastLine = lines[lines.length - 1];
    const hasClose = lastLine !== openLine && (/^```/.test(lastLine) || /^~~~/.test(lastLine));
    const body = hasClose ? lines.slice(1, -1).join("\n") : lines.slice(1).join("\n");
    const langLabel = lang || "code";
     return `<div class="code-block-wrap"><button class="code-copy">Copy</button><span class="code-lang">${escapeHtml(langLabel)}</span><pre style="margin:0;border-radius:10px;border:1px solid var(--color-border);background:var(--color-surface-1);padding:16px;overflow:auto;font-family:var(--font-mono);font-size:0.875em;line-height:1.5;color:var(--color-text);"><code>${escapeHtml(body)}</code></pre></div>`;
  }

  if (trimmed.startsWith("#")) {
    const m = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      const text = inlineToHtml(m[2]);
      return `<h${level} style="margin:0.5em 0 0.4em;font-weight:600;">${text}</h${level}>`;
    }
  }

  if (trimmed.startsWith(">")) {
    const body = trimmed
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .map((l) => inlineToHtml(l))
      .join("<br>");
    return `<blockquote style="margin:0.5em 0;padding:0.4em 0.8em;border-left:2px solid var(--color-border-strong);color:var(--color-text-muted);">${body}</blockquote>`;
  }

  if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
    const isOrdered = /^\d+\.\s/.test(trimmed);
    const tag = isOrdered ? "ol" : "ul";
    const items = trimmed
      .split("\n")
      .map((l) => `<li>${inlineToHtml(l.replace(/^(?:[-*+]|\d+\.)\s+/, ""))}</li>`)
      .join("");
    return `<${tag} style="margin:0.4em 0;padding-left:1.4em;">${items}</${tag}>`;
  }

  if (/^---+$/.test(trimmed.trim()) || /^\*\*\*+$/.test(trimmed.trim()) || /^___+$/.test(trimmed.trim())) {
    return `<hr style="border:0;border-top:1px solid var(--color-border);margin:0.8em 0;" />`;
  }

  if (/^\|[^\n]*\|/.test(trimmed)) {
    // Simple table: render rows as a flex column with cells separated.
    const rows = trimmed
      .split("\n")
      .filter((l) => l.trim() && !/^\|[\s-:|]+\|$/.test(l.trim()));
    const html = rows
      .map((l) => {
        const cells = l
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        return `<div style="display:flex;gap:1em;">${cells
          .map((c) => `<span style="flex:1;">${inlineToHtml(c)}</span>`)
          .join("")}</div>`;
      })
      .join("");
    return `<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.5em 0.8em;margin:0.5em 0;">${html}</div>`;
  }

  // Default: paragraph. Inline emphasis + code backticks + line breaks.
  return `<p style="margin:0.4em 0;">${inlineToHtml(trimmed).replace(/\n/g, "<br>")}</p>`;
}

/**
 * Inline emphasis: **x** → <strong>, *x* → <em>, `x` → <code>.
 */
function inlineToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, '<code style="background:var(--color-surface-2);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em;">$1</code>');
}

/**
 * Canonical renderer for this module: split the text into blocks,
 * render each block, join with an empty separator.
 *
 * Deterministic: no Date.now(), no Math.random(), no async — the output
 * is a pure function of the input. That is what makes it usable as a
 * test oracle.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  return renderBlocks(text);
}

/** Render by splitting on blank lines and code-fence boundaries. */
function renderBlocks(text: string): string {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: collect from ```/~~~ through matching close.
    if (/^```/.test(line) || /^~~~/.test(line)) {
      const marker = line.match(/^(`{3,}|~{3,})/)![1];
      const close = new RegExp("^" + marker[0] + "{" + marker.length + ",}\\s*$");
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      // Include the closing fence if found, else include to end.
      const end = j < lines.length ? j + 1 : lines.length;
      blocks.push(lines.slice(i, end).join("\n"));
      i = end;
      // Skip blank lines.
      while (i < lines.length && lines[i] === "") i++;
      continue;
    }

    // Blank line: paragraph break.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Collect a paragraph: consecutive non-blank lines.
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      !/^```/.test(lines[j]) &&
      !/^~~~/.test(lines[j])
    ) {
      j++;
    }
    blocks.push(lines.slice(i, j).join("\n"));
    i = j;
  }

  return blocks.map(blockToHtml).join("");
}

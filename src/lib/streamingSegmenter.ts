/**
 * Streaming markdown segmenter.
 *
 * Splits an accumulated source into a list of "frozen" blocks that are safe to
 * render exactly once, and a final "live" tail block that may still be
 * incomplete (open code fence, partial inline code, etc.) and needs
 * re-rendering as more tokens arrive.
 *
 * Rules:
 *   - A complete paragraph (separated by blank lines) is frozen.
 *   - A complete code fence (``` ... ```) is frozen.
 *   - An open code fence stays in the live tail; new tokens append to it.
 *   - Everything else is part of the live tail.
 *
 * The split is conservative: we'd rather over-freeze than under-freeze. An
 * under-frozen block would re-render and cause flicker; an over-frozen block
 * just means we re-render the live tail slightly more often.
 *
 * This is a TypeScript port of Odysseus's `streamingSegmenter.js`.
 */

export interface SegmenterBlock {
  /** Raw markdown source for this block. */
  source: string;
  /** Whether this block is safe to render once and freeze. */
  frozen: boolean;
}

export function segment(source: string): SegmenterBlock[] {
  if (!source) return [];
  const lines = source.split("\n");
  const out: SegmenterBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect start of fenced code block
    if (/^```/.test(line)) {
      // Find matching closing fence
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (/^```\s*$/.test(lines[j])) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        // Frozen: from ```open through ```close
        out.push({ source: lines.slice(i, j + 1).join("\n"), frozen: true });
        i = j + 1;
        // Consume trailing blank lines so next paragraph starts fresh
        while (i < lines.length && lines[i] === "") i++;
        continue;
      } else {
        // Open fence — emit everything from i to end as a live tail
        out.push({ source: lines.slice(i).join("\n"), frozen: false });
        return out;
      }
    }

    // Collect a paragraph (consecutive non-blank lines)
    if (line.trim() === "") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !/^```/.test(lines[j])) j++;
    const paragraphLines = lines.slice(i, j);

    // Check for other block constructs that we can freeze
    // - ATX heading (# Heading)
    // - Block quote (> ...)
    // - List items (- / * / 1. / - [ ])
    // - Horizontal rule (---, ***, ___)
    // - Table rows (| ... |)
    const isBlockConstruct = paragraphLines.every((l) =>
      /^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|---+|\*\*\*+|___+|\|[^\n]*\|)/.test(l)
    );
    if (isBlockConstruct) {
      out.push({ source: paragraphLines.join("\n"), frozen: true });
      i = j;
      // Consume trailing blank
      while (i < lines.length && lines[i] === "") i++;
      continue;
    }

    // Single line of normal prose that ended the source: not yet a full
    // paragraph (no blank line after it). Keep in live tail.
    if (j >= lines.length) {
      out.push({ source: paragraphLines.join("\n"), frozen: false });
      return out;
    }

    // Complete paragraph: frozen.
    out.push({ source: paragraphLines.join("\n"), frozen: true });
    i = j;
    while (i < lines.length && lines[i] === "") i++;
  }

  return out;
}

/**
 * Test helper: should this source be considered "stable" (i.e. can we stop
 * re-rendering the tail)? Currently always false while streaming.
 */
export function isStable(_source: string): boolean {
  return false;
}

/**
 * Streaming markdown block splitter.
 *
 * While an assistant message streams in, re-parsing the whole
 * accumulated markdown on every frame is O(N²) and recreates DOM, which
 * is what made code-block hover buttons flicker in earlier versions.
 * The fix is to divide the source into blocks that can no longer change
 * and one live tail, render each frozen block exactly once, and
 * re-render only the tail.
 *
 *     const { frozen, tail } = splitBlocks(text);
 *
 * `frozen` may be rendered immediately and never touched again. `tail`
 * is the still-growing trailing block and changes on nearly every frame.
 *
 * This replaces `streamingSegmenter.ts`. That module had to prove each
 * candidate cut was safe by rendering both sides and comparing to the
 * joined result (`cutIsRenderSafe`), because it froze *rendered output*.
 * This module freezes *source blocks* and lets React memoize each one, so
 * a mis-cut shows up as a wrong render rather than corrupted DOM, and
 * conservative structural rules are enough. That is the difference
 * between ~200 lines and ~90.
 *
 * Pure: no DOM, no React, no rendering, no global state. Single pass,
 * forward-only cursor, O(n) in the length of `text`.
 */

/**
 * A fenced-code delimiter line: up to 3 leading spaces, then >=3
 * backticks or tildes, then an optional info string.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A line that starts a list item — bullet, ordered, or a thematic break
 * (which shares the `-`/`*`/`_` characters and is conservatively treated
 * as a list too).
 */
const LIST_START_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * A line indented enough to be an indented code block. These continue
 * ACROSS blank lines — "    a\n\n    b" is one code block, not two — so
 * a blank line before one is not a boundary.
 */
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

/**
 * A line that opens a raw HTML block (CommonMark types 1-6). A block that
 * *starts* with one continues across blank lines, so a blank line before
 * one is not a boundary either. Deliberately narrow: a bare `<` in prose
 * ("a < b") is not an HTML block, and requiring a tag name keeps it out.
 */
const HTML_BLOCK_OPEN_RE = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|\/[A-Za-z][A-Za-z0-9-]*)/;

/** Blocks that can no longer change, plus the still-growing tail. */
export interface BlockSplit {
  /** Source of each finalized block, in order. Never changes once produced. */
  frozen: string[];
  /** The still-growing trailing block. Changes on nearly every frame. */
  tail: string;
}

/**
 * Split accumulated markdown source into finalized blocks and a live tail.
 *
 * Guarantees, in order of importance:
 *
 *  1. `[...frozen, tail].join("") === text`. Lossless.
 *  2. No frozen block is ever altered by later input. A block frozen at
 *     length `n` is still, in order, a prefix of the frozen blocks at any
 *     `n' > n`. This is what lets a caller render it once and forget it.
 *  3. No frozen block is empty or whitespace-only.
 *
 * A block is finalized at a top-level blank line only when it is not a
 * list, and immediately after a code fence closes. See the comment on
 * `isFreezable` for why lists are the exception.
 */
export function splitBlocks(text: string): BlockSplit {
  if (!text) return { frozen: [], tail: "" };

  const lines = text.split("\n");

  // Byte offset of each line's first character. Blocks are sliced out of
  // `text` by offset rather than rejoined from line arrays: a blank run
  // between two blocks is `["", ""]`, and `join("\n")` on that loses a
  // newline, which would make the split lossy.
  const starts: number[] = new Array(lines.length);
  starts[0] = 0;
  for (let i = 1, at = 0; i < lines.length; i++) {
    at += lines[i - 1].length + 1;
    starts[i] = at;
  }

  // Line indices at which a new block begins. Everything before the last
  // one is finalized.
  const cuts: number[] = [];
  // First line of the block currently being accumulated.
  let blockStart = 0;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);

    if (fence && (inFence || fence[1][0] !== "`" || !fence[2].includes("`"))) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
        fenceLen = fence[1].length;
      } else if (
        fence[1][0] === fenceChar &&
        fence[1].length >= fenceLen &&
        fence[2].trim() === "" // a closing fence carries no info string
      ) {
        // A completed code block is unconditionally safe: nothing can
        // ever merge into it. `fenceLen` is what keeps a 3-backtick line
        // from closing a 4-backtick fence.
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        // ...but only once the closing fence's own line is terminated.
        // A trailing "```" can still grow — one more character turns it
        // into "```x", which no longer closes. Cutting now would freeze
        // the block at the end of the fence, and the newline that
        // arrives next would grow an already-rendered block. Wait one
        // frame instead; the cost is re-rendering the final block once.
        if (i + 1 < lines.length) {
          cuts.push(i + 1);
          blockStart = i + 1;
        }
      }
      continue;
    }

    if (inFence) continue;

    if (line.trim() === "") {
      // Consume the entire blank run; the next non-blank line starts the
      // next block, so the finalized side owns the separator.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;

      // No following content means nothing can be separated yet.
      if (j < lines.length && isFreezable(lines, blockStart, j)) {
        cuts.push(j);
        blockStart = j;
      }
      i = j - 1;
    }
  }

  const frozen: string[] = [];
  let fromLine = 0;
  for (const cut of cuts) {
    frozen.push(text.slice(starts[fromLine], starts[cut]));
    fromLine = cut;
  }

  return { frozen, tail: text.slice(starts[fromLine]) };
}

/**
 * May the block spanning `lines[blockStart .. j)` be finalized, where
 * `j` is the index of the next non-blank line after a blank run?
 *
 * Mostly yes. A top-level blank line is a hard block boundary in
 * markdown — nothing before it can be reparsed by anything after it —
 * with exactly one exception worth guarding.
 *
 * The exception is lists. A blank line between two list items does not
 * end the list; it makes it *loose*, wrapping each item's content in a
 * paragraph. So "- a\\n\\n- b" renders as one list of two loose items,
 * while freezing after "- a" yields two adjacent tight lists. Cut inside
 * a list and the render visibly changes, so never do.
 *
 * Two more constructs continue across a blank line, and are handled by
 * looking at what *follows* the blank: an indented code line, and a raw
 * HTML block opener. Neither can interrupt a paragraph, so a paragraph
 * immediately before one is really the opening of that construct, and
 * cutting would split it.
 *
 * Setext headings need no special case: they require the underline to
 * follow the paragraph directly, so a blank line already prevents one.
 * Tables need none either: a blank line terminates a table.
 */
function isFreezable(lines: string[], blockStart: number, j: number): boolean {
  // Reject a block with no content of its own — otherwise a leading blank
  // run would emit a whitespace-only frozen block.
  let hasContent = false;
  for (let i = blockStart; i < j; i++) {
    if (lines[i].trim() !== "") {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return false;

  // A block that IS an indented code block or a raw HTML block runs
  // through its own internal blank lines, so it is never freezable.
  const first = lines[blockStart];
  if (INDENTED_CODE_RE.test(first) || HTML_BLOCK_OPEN_RE.test(first)) return false;

  // And a block followed by one of those is not finished either.
  const next = lines[j];
  if (INDENTED_CODE_RE.test(next) || HTML_BLOCK_OPEN_RE.test(next)) return false;

  return !LIST_START_RE.test(first);
}

/**
 * Markdown shape corpus for streaming tests.
 *
 * A single corpus shared by every test that needs to reason about
 * what a partially-arrived assistant message looks like. Each shape
 * is a complete message plus the prefix lengths at which a streaming
 * renderer would be fed a partial version of it.
 *
 * The cut points deliberately land *inside* constructs — mid-word,
 * mid-list, mid-fence, mid-table-row — not only at clean boundaries.
 * A streaming renderer that only ever sees whole blocks is never
 * tested.
 *
 * This file outlives the renderer it was written to characterize: it
 * is imported by the block-splitter tests, the streaming-tail parity
 * tests, and the performance tests.
 */

export interface StreamShape {
  /** Stable id used in test names. */
  name: string;
  /** The complete message text. */
  full: string;
  /**
   * Prefix lengths at which a renderer is fed `full.slice(0, n)`.
   * Always includes 0, the full length, and a spread of interior cuts.
   */
  cutPoints: number[];
}

/**
 * Build a spread of cut points for a string: the ends, plus interior
 * cuts at ~1/8 intervals offset to avoid landing only on even
 * boundaries. Sorted, deduplicated, clamped to [0, len], and capped.
 *
 * The cap matters. This corpus is swept by several parametrized test
 * files; without a ceiling, `veryLongSingleLine` alone would generate
 * thousands of cases and inflate the project's reported test count
 * into a number that no longer means anything.
 */
const MAX_CUT_POINTS = 12;

function spread(len: number, steps = 12): number[] {
  if (len === 0) return [0];
  const out = new Set<number>([0, len]);
  for (let i = 1; i < steps; i++) {
    const base = Math.floor((len * i) / steps);
    // Three nearby candidates so we sample odd offsets too.
    out.add(Math.min(len, base));
    out.add(Math.min(len, base + 1));
    out.add(Math.min(len, base + Math.floor(len / (steps * 2))));
  }
  const sorted = [...out].filter((n) => n >= 0 && n <= len).sort((a, b) => a - b);
  if (sorted.length <= MAX_CUT_POINTS) return sorted;
  // Keep both ends, subsample the interior evenly.
  const interior = sorted.slice(1, -1);
  const keep = MAX_CUT_POINTS - 2;
  const picked = Array.from(
    { length: keep },
    (_, i) => interior[Math.floor((i * interior.length) / keep)],
  );
  return [sorted[0], ...picked, sorted[sorted.length - 1]];
}

const RAW_SHAPES: Array<{ name: string; full: string }> = [
  {
    name: "paragraph",
    full: "A single paragraph of prose that is long enough to have a\nsoft wrap in the source but no blank line to separate it.",
  },
  {
    name: "twoParagraphs",
    full: "First paragraph here.\n\nSecond paragraph here, separated by one blank line.",
  },
  {
    name: "headingThenParagraph",
    full: "## A Heading\n\nBody text under the heading.",
  },
  {
    name: "setextHeading",
    full: "A Setext Heading\n=================\n\nBody after a setext heading.",
  },
  {
    name: "nestedList",
    full: [
      "1. top level",
      "   - nested one",
      "   - nested two",
      "2. second top level",
      "   - its nested child",
    ].join("\n"),
  },
  {
    name: "looseListWithBlankLines",
    full: [
      "1. first item",
      "",
      "2. second item",
      "",
      "3. third item",
    ].join("\n"),
  },
  {
    name: "taskList",
    full: ["- [ ] undone task", "- [x] done task", "- [ ] another undone"].join("\n"),
  },
  {
    name: "gfmTable",
    full: [
      "| col a | col b |",
      "| ----- | ----- |",
      "| one   | two   |",
      "| three | four  |",
    ].join("\n"),
  },
  {
    name: "blockquote",
    full: "> quoted line one\n> quoted line two",
  },
  {
    name: "blockquoteWithLazyContinuation",
    full: "> quoted line\nlazy continuation without a marker\n\nafter the quote",
  },
  {
    name: "closedCodeFence",
    full: "before\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nafter",
  },
  {
    name: "codeFenceWithLanguage",
    full: "```typescript\nexport function f(): void {}\n```",
  },
  {
    name: "tildeFence",
    full: "~~~python\nprint('hello')\n~~~",
  },
  {
    name: "unclosedCodeFence",
    full: "intro text\n\n```ts\nconst a = 1;\nconst b = 2;",
  },
  {
    name: "fourBacktickOpenerThreeBacktickClose",
    // A 4-backtick fence must NOT be closed by a 3-backtick line.
    // streamingSegmenter.ts documents this as a known mis-detection
    // (its afterClosedFence boundaries are trusted without the
    // equivalence check). The new splitter must get it right.
    full: "intro\n\n````\n```\nnested three-backtick content\n```\n````\n\nafter",
  },
  {
    name: "inlineEmphasisAcrossLines",
    full: "text with *emphasis that\ncontinues on the next line* done",
  },
  {
    name: "inlineCodeSpanningFenceText",
    full: "prose with `inline code` and then\n\n```\nfenced\n```\n\nmore prose",
  },
  {
    name: "htmlLikeAngleBrackets",
    full: "a < b && c > d, plus <div>markup</div> and 5 < 6",
  },
  {
    name: "linkWithParens",
    full: "see [the docs](https://example.com/a(b)c) for details",
  },
  {
    name: "strikethroughAndAutolink",
    full: "~~gone~~ and <https://example.com/auto>",
  },
  {
    name: "thinkBlock",
    full: "before <think>private reasoning here</think> after",
  },
  {
    name: "mixedEverything",
    full: [
      "## Heading",
      "",
      "Prose with **bold**, *italic*, and `code`.",
      "",
      "- list item",
      "- another",
      "",
      "> a quote",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```py",
      "x = 1",
      "```",
      "",
      "Final paragraph.",
    ].join("\n"),
  },
  {
    name: "trailingBlankLines",
    full: "content line\n\n\n\n",
  },
  {
    name: "whitespaceOnly",
    full: "   \n  \n\t\n",
  },
  {
    name: "singleNewline",
    full: "\n",
  },
  {
    name: "empty",
    full: "",
  },
  {
    name: "veryLongSingleLine",
    // Generated, not a literal. Review Focus case 3: a 20k-char line
    // with no blank lines must not make the splitter quadratic.
    full: `${"lorem ipsum dolor sit amet ".repeat(800)}end`,
  },
  {
    name: "multiByteAndRtl",
    // Review Focus case 2. A ZWJ family emoji, a combining sequence,
    // and an RTL run, so every cut point has a chance to land inside
    // a code point or a grapheme cluster.
    full: "emoji 👨‍👩‍👧‍👦 then combining éé then rtl אבגדה then ascii end",
  },
];

export const STREAM_SHAPES: StreamShape[] = RAW_SHAPES.map(({ name, full }) => ({
  name,
  full,
  cutPoints: spread(full.length),
}));

/** Look a shape up by name. Throws rather than returning undefined. */
export function shapeNamed(name: string): StreamShape {
  const found = STREAM_SHAPES.find((s) => s.name === name);
  if (!found) throw new Error(`no stream shape named "${name}"`);
  return found;
}

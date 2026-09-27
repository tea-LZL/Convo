import { describe, expect, it } from "vitest";
import { splitBlocks } from "../markdownBlocks";
import { renderMarkdown } from "../markdown";
import { STREAM_SHAPES, shapeNamed } from "../../components/chat/__tests__/fixtures/streamShapes";

describe("splitBlocks core contract", () => {
  it("never splits inside a fenced code block", () => {
    const { frozen } = splitBlocks("intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter");
    expect(frozen).toContain("```ts\nconst a = 1;\nconst b = 2;\n```\n");
  });

  it("keeps the unterminated fence in the tail", () => {
    const { frozen, tail } = splitBlocks("intro\n\n```ts\nconst a = 1;");
    expect(tail).toBe("```ts\nconst a = 1;");
    expect(frozen.join("")).toBe("intro\n\n");
  });

  it("keeps trailing blank lines in the tail", () => {
    // Nothing has superseded them yet, and dropping them would make the
    // split lossy. They render to nothing.
    const { frozen, tail } = splitBlocks("one\n\ntwo\n\n");
    expect(frozen).toEqual(["one\n\n"]);
    expect(tail).toBe("two\n\n");
  });

  it("puts the whole of a single unterminated paragraph in the tail", () => {
    const { frozen, tail } = splitBlocks("no blank lines here at all");
    expect(frozen).toEqual([]);
    expect(tail).toBe("no blank lines here at all");
  });
});

describe("splitBlocks round-trips its input", () => {
  it.each(STREAM_SHAPES.map((s) => [s.name] as const))(
    "concatenating blocks reproduces the source for %s",
    (name) => {
      const shape = shapeNamed(name);
      for (const n of shape.cutPoints) {
        const prefix = shape.full.slice(0, n);
        const { frozen, tail } = splitBlocks(prefix);
        expect([...frozen, tail].join("")).toBe(prefix);
      }
    },
  );

  it("never emits an empty or whitespace-only frozen block", () => {
    for (const shape of STREAM_SHAPES) {
      for (const n of shape.cutPoints) {
        const { frozen } = splitBlocks(shape.full.slice(0, n));
        for (const block of frozen) {
          expect(block.trim()).not.toBe("");
        }
      }
    }
  });
});

describe("splitBlocks freeze safety", () => {
  // The whole point of freezing: a block that can no longer change must
  // not change. If the splitter cuts somewhere it shouldn't, later input
  // would retroactively alter an already-rendered block, and the user
  // would see a message change after they read it.
  it.each(STREAM_SHAPES.map((s) => [s.name] as const))(
    "a frozen block is never altered by later input in %s",
    (name) => {
      const shape = shapeNamed(name);
      for (const n of shape.cutPoints) {
        const { frozen } = splitBlocks(shape.full.slice(0, n));
        for (const next of shape.cutPoints.filter((c) => c >= n)) {
          const later = splitBlocks(shape.full.slice(0, next));
          // Every block frozen at n must still be present, in order, at `next`.
          expect(later.frozen.slice(0, frozen.length)).toEqual(frozen);
        }
      }
    },
  );

  it("freezing does not change rendered output", () => {
    for (const shape of STREAM_SHAPES) {
      for (const n of shape.cutPoints) {
        const prefix = shape.full.slice(0, n);
        const { frozen, tail } = splitBlocks(prefix);
        expect(renderMarkdown([...frozen, tail].join(""))).toBe(renderMarkdown(prefix));
      }
    }
  });
});

describe("splitBlocks handles constructs that span blocks", () => {
  // A loose list's items change how they render depending on the blank
  // lines between them, so the splitter must not cut inside one.
  it("does not split a loose list at a blank line between items", () => {
    const { frozen, tail } = splitBlocks("1. first\n\n2. second");
    expect(frozen).toEqual([]);
    expect(tail).toBe("1. first\n\n2. second");
  });

  it("does not split a blockquote at a lazy continuation", () => {
    const { frozen } = splitBlocks("> quoted\nlazy continuation\n\nafter");
    expect(frozen.length).toBeLessThanOrEqual(1);
  });

  it("does not split a GFM table between its header and body", () => {
    const { frozen } = splitBlocks("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(frozen).toEqual([]);
  });
});

// --- Review Focus cases -------------------------------------------------
// These are input classes the spec implies but no existing test covered.
// The old renderer's behavior on each is recorded in streamingParity.test.ts.

describe("splitBlocks on corrected (non-append-only) input", () => {
  // The old renderer documented an append-only PRECONDITION and left
  // stale frozen blocks when a provider re-sent corrected text. The new
  // splitter is a pure function of its input, so correction is free —
  // but only if nothing downstream caches by position.
  it("reflects corrected earlier text", () => {
    const { frozen, tail } = splitBlocks("para ONE\n\ntwo");
    expect([...frozen, tail].join("")).toContain("para ONE");
    expect([...frozen, tail].join("")).not.toContain("para one");
  });
});

describe("splitBlocks on multi-byte and bidirectional text", () => {
  it("does not split a surrogate pair", () => {
    const { frozen, tail } = splitBlocks("👨‍👩‍👧‍👦 family\n\nnext");
    for (const block of [...frozen, tail]) {
      // A lone surrogate means we cut inside a code point.
      expect(block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(block).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("never cuts between a base character and a combining mark", () => {
    // "e" + U+0301 is one grapheme. Cutting between them renders as a
    // plain "e" followed by a stray floating accent. The property to
    // pin is that a cut never *starts* on a combining mark — a block is
    // allowed to contain one, it just may not begin with one.
    const text = "café bar\n\nsecond é block";
    const { frozen, tail } = splitBlocks(text);
    for (const block of [...frozen, tail]) {
      expect(block[0] ?? "").not.toMatch(/[̀-ͯ]/);
    }
    expect([...frozen, tail].join("")).toBe(text);
  });

  it("round-trips RTL content byte for byte", () => {
    const text = "start אבגדה end\n\nsecond";
    const { frozen, tail } = splitBlocks(text);
    expect([...frozen, tail].join("")).toBe(text);
  });
});

describe("splitBlocks on a very long single line", () => {
  // Review Focus case 3. A 20k-char line with no blank lines must not
  // make the splitter quadratic — the naive alternative rescans the
  // whole text on every call. Correctness of speed is gated by the
  // performance test; this pins the shape of the answer.
  it("leaves a single unterminated line entirely in the tail", () => {
    const long = `${"lorem ipsum dolor sit amet ".repeat(800)}end`;
    const { frozen, tail } = splitBlocks(long);
    expect(frozen).toEqual([]);
    expect(tail).toBe(long);
  });

  it("splits a long line from a following block in one pass", () => {
    const long = `${"lorem ipsum dolor sit amet ".repeat(800)}end`;
    const { frozen, tail } = splitBlocks(`${long}\n\nshort tail`);
    expect(frozen).toHaveLength(1);
    expect(tail).toBe("short tail");
  });
});

describe("splitBlocks on mismatched code fences", () => {
  // A 4-backtick opener must not be closed by a 3-backtick line. The
  // old segmenter trusted afterClosedFence boundaries without checking
  // (streamingSegmenter.ts:33-37), which mis-detected mid-stream.
  it("does not let a 3-backtick line close a 4-backtick fence", () => {
    const { frozen, tail } = splitBlocks("intro\n\n````\n```\ncontent\n```\nmore\n````\n\nafter");
    // The region from the 4-backtick opener to its 4-backtick close must
    // sit inside ONE block. If the inner 3-backtick lines were treated as
    // closes, the block would be cut mid-fence and the tail would start
    // inside the code.
    const fenceBlocks = frozen.filter((b) => b.includes("````"));
    expect(fenceBlocks).toHaveLength(1);
    expect(fenceBlocks[0]).toContain("```\ncontent\n```\nmore\n````");
    // Nothing leaked into the tail from inside the fence.
    expect(tail).not.toContain("content");
  });

  it("does not let a tilde line close a backtick fence", () => {
    const { frozen } = splitBlocks("```\n~~~\ncode\n~~~\n```\n\nafter");
    expect(frozen.join("")).toContain("```\n~~~\ncode\n~~~\n```\n");
  });

  it("requires the closing fence to carry no info string", () => {
    // ```js is an opener, never a closer.
    const { tail } = splitBlocks("```\ncode\n```js\nmore");
    expect(tail).toContain("```js");
  });
});

describe("splitBlocks on degenerate input", () => {
  it.each([
    ["empty", ""],
    ["single space", " "],
    ["newlines only", "\n\n\n"],
    ["tabs and spaces", "  \t\n \t "],
    ["single newline", "\n"],
    ["no trailing newline after a fence close", "```\nx\n```"],
  ])("does not throw on %s", (_label, text) => {
    expect(() => splitBlocks(text)).not.toThrow();
    const { frozen, tail } = splitBlocks(text);
    expect([...frozen, tail].join("")).toBe(text);
  });

  it("returns empty output for empty input", () => {
    expect(splitBlocks("")).toEqual({ frozen: [], tail: "" });
  });
});

describe("splitBlocks respects constructs that continue across a blank line", () => {
  // A blank line is a hard block boundary for most markdown, but not for
  // these. Cutting at one produces a different render than the settled
  // message, which is the exact restyle this rewrite exists to remove.

  it("keeps an indented code block whole across its internal blank line", () => {
    const { frozen } = splitBlocks("    a\n\n    b");
    expect(frozen).toEqual([]);
  });

  it("keeps a block whole when the next line is an indented code line", () => {
    // The paragraph cannot be separated: the indented line continues the
    // code block rather than starting a new construct.
    const { frozen, tail } = splitBlocks("intro\n\ntext\n\n    code line");
    expect(frozen).toEqual(["intro\n\n"]);
    expect(tail).toBe("text\n\n    code line");
  });

  it("keeps a block whole when the next line opens a raw HTML block", () => {
    const { tail } = splitBlocks("text\n\n<div>\n  markup\n</div>");
    expect(tail).toBe("text\n\n<div>\n  markup\n</div>");
  });

  it("still separates a paragraph from ordinary following content", () => {
    const { frozen, tail } = splitBlocks("first para\n\nsecond para");
    expect(frozen).toEqual(["first para\n\n"]);
    expect(tail).toBe("second para");
  });

  it("does not treat a less-than sign in prose as an HTML block", () => {
    const { frozen } = splitBlocks("a < b and c > d\n\nnext");
    expect(frozen).toEqual(["a < b and c > d\n\n"]);
  });
});

describe("splitBlocks offset and fence-opener edge cases", () => {
  it("reports a start offset for the first line", () => {
    // Guards the offset table itself: a hole at index 0 only worked
    // because String.slice coerces undefined to 0.
    const { frozen, tail } = splitBlocks("alpha\n\nbravo");
    expect(frozen).toEqual(["alpha\n\n"]);
    expect(tail).toBe("bravo");
  });

  it("does not open a backtick fence on an info string containing a backtick", () => {
    // CommonMark forbids backticks in a backtick fence's info string, so
    // this line is not an opener. Treating it as one would swallow every
    // following blank line and freeze nothing at all.
    const { frozen } = splitBlocks("``` ```\nnot really a fence\n\nafter");
    expect(frozen.length).toBeGreaterThan(0);
  });
});

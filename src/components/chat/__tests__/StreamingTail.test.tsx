/**
 * Tests for the React-native streaming tail.
 *
 * The tail replaces a DOM-direct renderer that wrote HTML straight into
 * a container element. These tests pin the two properties that made that
 * renderer worth keeping, and the one it could not provide.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { MarkdownBlocks, StreamingTail } from "../StreamingTail";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { useChatStreamStore } from "../../../stores/chatStream";
import type { SessionState } from "../../../stores/chatStream";
import { STREAM_SHAPES, shapeNamed } from "./fixtures/streamShapes";
import { canonicalElement } from "./fixtures/domCompare";

/** Carries both a GFM table and a task list — neither rendered by the old tail. */
const EMPTY_SESSION: SessionState = {
  messages: [],
  status: "idle",
  streaming: false,
  streamContent: "",
  streamThinking: "",
  error: null,
  loadingMessages: false,
};

const GFM_SHAPE = [
  "## Findings",
  "",
  "| col a | col b |",
  "| ----- | ----- |",
  "| one   | two   |",
  "",
  "- [x] done",
  "- [ ] pending",
  "",
  "Done.",
].join("\n");

/** Drives `StreamingTail` from a session seeded directly into the store. */
function StreamingTailHarness({ streaming, text }: { streaming: boolean; text: string }) {
  const stickToBottomRef = React.useRef(true);
  useChatStreamStore.setState({
    sessions: {
      "boundary-session": {
        ...EMPTY_SESSION,
        streaming,
        streamContent: text,
      },
    },
  });
  return (
    <StreamingTail
      sessionId="boundary-session"
      stickToBottomRef={stickToBottomRef}
      onBumpScroll={() => {}}
    />
  );
}

/** Counts how many times react-markdown is invoked, and with what source. */
const markdownRenders: string[] = [];

vi.mock("react-markdown", async () => {
  const Actual = await vi.importActual<typeof import("react-markdown")>("react-markdown");
  return {
    __esModule: true,
    default: (props: { children?: string }) => {
      markdownRenders.push(String(props.children ?? ""));
      return <Actual.default {...props} />;
    },
  };
});

beforeEach(() => {
  markdownRenders.length = 0;
});

describe("frozen blocks are not re-rendered", () => {
  it("re-parses only the tail as it grows", () => {
    const { rerender } = render(<MarkdownBlocks text={"alpha\n\nbravo"} />);
    // Two blocks: "alpha\n\n" frozen, "bravo" tail.
    expect(markdownRenders).toHaveLength(2);

    // A third block freezes; the first two must be skipped by memo.
    rerender(<MarkdownBlocks text={"alpha\n\nbravo\n\ncharlie"} />);
    // Only "charlie" is new. "bravo" was the tail and is now frozen, so
    // it renders once for the first time; "alpha" must not render again.
    expect(markdownRenders.filter((s) => s.trim() === "alpha")).toHaveLength(1);
  });

  it("keeps frozen block render counts flat while the tail grows", () => {
    const base = "alpha\n\nbravo\n\ncharlie\n\ndelta";
    const { rerender } = render(<MarkdownBlocks text={base} />);
    expect(markdownRenders.length).toBeGreaterThan(0);

    for (const tail of ["d", "de", "del", "delt", "delta"]) {
      rerender(<MarkdownBlocks text={`${base}\n\necho ${tail}`} />);
    }

    // The leading blocks must each have been parsed exactly once for the
    // whole run, no matter how many frames followed.
    const rendersOf = (block: string) =>
      markdownRenders.filter((s) => s.trim() === block).length;
    expect(rendersOf("alpha")).toBe(1);
    expect(rendersOf("bravo")).toBe(1);
    // The growing tail is the only thing re-parsed.
    expect(rendersOf("echo")).toBe(0);
    expect(markdownRenders.filter((s) => s.startsWith("echo")).length).toBe(5);
  });

  it("does not re-render frozen blocks when the text is unchanged", () => {
    const text = "alpha\n\nbravo\n\ncharlie";
    const { rerender } = render(<MarkdownBlocks text={text} />);
    const first = markdownRenders.length;
    rerender(<MarkdownBlocks text={text} />);
    rerender(<MarkdownBlocks text={text} />);
    expect(markdownRenders.length).toBe(first);
  });
});

/**
 * Shapes whose settled render includes a code block. These are exempt
 * from exact structural parity: the live tail deliberately renders code
 * without syntax highlighting, because Prism re-highlighting a growing
 * open fence measured at ~170ms per frame against ~6ms without it. Text
 * content and block structure still have to match — only colour and the
 * copy button arrive late.
 */
const CODE_FENCE_SHAPES = new Set([
  "closedCodeFence",
  "codeFenceWithLanguage",
  "tildeFence",
  "unclosedCodeFence",
  "fourBacktickOpenerThreeBacktickClose",
  "inlineCodeSpanningFenceText",
  "mixedEverything",
]);

describe("streaming and settled markdown agree", () => {
  // The defect this rewrite exists to fix. The old streaming path used
  // renderMarkdown (hand-rolled regex → HTML string, no GFM, no
  // highlighting); the settled path used react-markdown + remark-gfm +
  // Prism. So every completed message restyled itself the instant its
  // stream ended. One renderer removes the possibility.
  it.each(STREAM_SHAPES.filter((s) => !CODE_FENCE_SHAPES.has(s.name)).map((s) => [s.name] as const))(
    "block rendering of %s matches whole-message rendering exactly",
    (name) => {
      const shape = shapeNamed(name);
      const streamed = render(<MarkdownBlocks text={shape.full} />);
      const settled = render(<MarkdownRenderer content={shape.full} />);
      expect(canonicalElement(streamed.container)).toBe(
        canonicalElement(settled.container),
      );
    },
  );

  it("preserves the code text and the prose of a streamed block exactly", () => {
    for (const name of CODE_FENCE_SHAPES) {
      const shape = shapeNamed(name);
      const streamed = render(<MarkdownBlocks text={shape.full} />);
      const settled = render(<MarkdownRenderer content={shape.full} />);

      // The code itself, exactly, in the same order. react-markdown's
      // inter-block newline text nodes are invisible to a reader and are
      // absent when blocks render separately, so raw textContent is not
      // a usable oracle across a block boundary — hence checking the
      // code and the prose separately instead.
      const codeOf = (c: HTMLElement) =>
        [...c.querySelectorAll("pre code")].map((el) => el.textContent);
      expect(codeOf(streamed.container)).toEqual(codeOf(settled.container));

      // And the prose, with code and highlight chrome dropped from both.
      // Top-level blocks are joined with an explicit separator rather
      // than relying on textContent: react-markdown emits inter-block
      // newline text nodes only when it renders a whole message, so a
      // raw concatenation is separated on one side and not the other.
      const prose = (c: HTMLElement) => {
        const clone = c.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("pre, .code-copy, .code-lang").forEach((n) => n.remove());
        return [...clone.children]
          .map((child) => (child.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ");
      };
      expect(prose(streamed.container)).toBe(prose(settled.container));
    }
  });

  it("skips syntax highlighting only while streaming", () => {
    const shape = shapeNamed("codeFenceWithLanguage");
    const streamed = render(<MarkdownBlocks text={shape.full} />);
    const settled = render(<MarkdownRenderer content={shape.full} />);
    expect(streamed.container.querySelector(".code-copy")).toBeNull();
    expect(settled.container.querySelector(".code-copy")).not.toBeNull();
  });

  it("renders GFM identically while streaming and settled", () => {
    const table = shapeNamed("gfmTable").full;
    const streamed = render(<MarkdownBlocks text={table} />);
    const settled = render(<MarkdownRenderer content={table} />);
    expect(canonicalElement(streamed.container)).toBe(canonicalElement(settled.container));
    // Guard against a vacuous pass: a table really did render as a table.
    expect(streamed.container.querySelector("table")).not.toBeNull();
  });
});

describe("MarkdownBlocks on degenerate input", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   \n\t"],
    ["single newline", "\n"],
  ])("renders no block element for %s", (_label, text) => {
    const { container } = render(<MarkdownBlocks text={text} />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("keeps the content when the stream ends in blank lines", () => {
    const { container } = render(<MarkdownBlocks text={"content line\n\n\n\n"} />);
    expect(container.textContent).toBe("content line");
  });

  it("renders nothing at all for empty input", () => {
    const { container } = render(<MarkdownBlocks text="" />);
    expect(canonicalElement(container)).toBe("");
  });

  it("keeps the text a user sees when a block is frozen mid-stream", () => {
    // A paragraph arriving one character at a time must show every
    // character it was given — no drops, no duplication.
    const full = "the quick brown fox";
    for (let n = 1; n <= full.length; n++) {
      const { container } = render(<MarkdownBlocks text={full.slice(0, n)} />);
      // Trailing whitespace is not rendered; the visible characters must
      // all be there and in order.
      expect(container.textContent).toBe(full.slice(0, n).trimEnd());
    }
  });
});

describe("the streaming to settled boundary", () => {
  // The defect the rewrite exists to fix. The old path rendered the live
  // tail with a hand-rolled regex-to-HTML string and settled messages
  // with react-markdown + remark-gfm + Prism, so every completed message
  // restyled itself the instant its stream ended. `StreamingTail` must
  // hand off to `MarkdownRenderer` with no visual change.
  it("does not change the rendered message when a stream completes", () => {
    const { rerender, container } = render(
      <StreamingTailHarness streaming text={GFM_SHAPE} />,
    );
    // Compare the markdown subtree only — the tail wraps it in a
    // max-width container and an aria-live region that MarkdownRenderer
    // does not have.
    const tailMarkdown = container.querySelector('[role="status"]');
    expect(tailMarkdown).not.toBeNull();
    const whileStreaming = canonicalElement(tailMarkdown!);

    const settled = render(<MarkdownRenderer content={GFM_SHAPE} />);
    expect(whileStreaming).toBe(canonicalElement(settled.container));
  });

  it("carries no GFM gap between tail and settled output", () => {
    // Guards against a vacuous pass: the shape really does contain a
    // table and a task list, neither of which the old tail renderer
    // supported.
    const { container } = render(<StreamingTailHarness streaming text={GFM_SHAPE} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
  });
});

describe("corrected stream content", () => {
  // Review Focus case 1. streamingRenderer.ts documented an append-only
  // PRECONDITION and silently left stale frozen blocks when a provider
  // re-sent corrected text. MarkdownBlocks is a pure function of its
  // `text` prop, so correction is free — pinned here so no future cache
  // reintroduces the bug.
  it("reflects corrected earlier text", () => {
    const { rerender, container } = render(<MarkdownBlocks text={"para one\n\npara two"} />);
    expect(container.textContent).toContain("para one");

    rerender(<MarkdownBlocks text={"para ONE\n\npara two"} />);
    expect(container.textContent).toContain("para ONE");
    expect(container.textContent).not.toContain("para one");
  });
});

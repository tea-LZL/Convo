import { describe, expect, it, vi } from "vitest";
import { createStreamRenderer } from "../streamingRenderer";
import { renderMarkdown } from "../markdown";

describe("createStreamRenderer", () => {
  function makeRenderer(opts?: { hljs?: { highlightElement: (el: Element) => void } }) {
    const el = document.createElement("div");
    const renderer = createStreamRenderer(el, { render: renderMarkdown, ...opts });
    return { el, renderer };
  }

  it("renders an initial tail", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("hello");
    expect(el.textContent).toContain("hello");
  });

  it("freezes finalized blocks and keeps a live tail", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("block one\n\ntail");
    renderer.update("block one\n\nblock two\n\ntail");
    expect(el.textContent).toContain("block one");
    expect(el.textContent).toContain("block two");
    expect(el.textContent).toContain("tail");
  });

  it("finalizes to the same HTML as a full render", () => {
    const { el, renderer } = makeRenderer();
    const text = "# Title\n\nParagraph one.\n\nParagraph two.";
    renderer.update(text);
    renderer.finalize();
    const expected = renderMarkdown(text);
    expect(el.innerHTML).toBe(expected);
  });

  it("appends to an open code fence in append-mode", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("```js\nconst x = 1;");
    expect(el.querySelector("pre code")).not.toBeNull();
    renderer.update("```js\nconst x = 1;\nconst y = 2;");
    expect(el.querySelector("pre code")?.textContent).toContain("const y = 2");
  });

  it("highlights frozen code blocks when hljs is provided", () => {
    const highlightElement = vi.fn();
    const { el, renderer } = makeRenderer({ hljs: { highlightElement } });
    renderer.update("```js\nconst x = 1;\n```");
    renderer.finalize();
    expect(highlightElement).toHaveBeenCalled();
    expect(el.querySelector("pre code")).not.toBeNull();
  });

  it("falls back to full re-render after a DOM error", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("first");
    // Force the internal marker to detach, which triggers a self-heal on next update.
    el.innerHTML = "";
    renderer.update("second");
    expect(el.textContent).toContain("second");
  });

  it("finalizes degraded state without throwing", () => {
    const { el, renderer } = makeRenderer();
    renderer.update("text");
    el.innerHTML = "<span>external</span>";
    renderer.update("more");
    renderer.finalize();
    expect(el.innerHTML.length).toBeGreaterThan(0);
  });
});

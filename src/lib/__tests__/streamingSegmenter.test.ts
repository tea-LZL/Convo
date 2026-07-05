import { describe, expect, it, vi } from "vitest";
import { describeOpenFence, splitFinalized } from "../streamingSegmenter";
import { renderMarkdown } from "../markdown";

describe("splitFinalized", () => {
  it("returns 0 for empty text", () => {
    expect(splitFinalized("", renderMarkdown)).toBe(0);
  });

  it("does not finalize when text is a single growing paragraph", () => {
    const text = "hello world";
    expect(splitFinalized(text, renderMarkdown)).toBe(0);
  });

  it("finalizes after a blank line when the next block is complete", () => {
    const text = "first paragraph\n\nsecond paragraph";
    const cut = splitFinalized(text, renderMarkdown);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(text.length);
    expect(renderMarkdown(text.slice(0, cut)) + renderMarkdown(text.slice(cut))).toBe(
      renderMarkdown(text)
    );
  });

  it("finalizes through a closed code fence", () => {
    const text = "```js\nconst x = 1;\n```\n\nnext";
    const cut = splitFinalized(text, renderMarkdown);
    expect(cut).toBeGreaterThan(0);
    expect(text.slice(0, cut)).toContain("```");
  });

  it("does not finalize inside an open code fence", () => {
    const text = "```js\nconst x = 1;\nstill typing";
    expect(splitFinalized(text, renderMarkdown)).toBe(0);
  });

  it.each([
    "para one\n\npara two\n\npara three",
    "# Heading\n\nbody text",
    "- item 1\n- item 2\n\nnew paragraph",
  ])("satisfies render equivalence for %s", (text) => {
    const cut = splitFinalized(text, renderMarkdown);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThanOrEqual(text.length);
    expect(renderMarkdown(text.slice(0, cut)) + renderMarkdown(text.slice(cut))).toBe(
      renderMarkdown(text)
    );
  });

  it("advances committedLen when a new boundary appears", () => {
    const committedLen = splitFinalized("first\n\nsecond", renderMarkdown);
    const text = "first\n\nsecond\n\nthird";
    const next = splitFinalized(text, renderMarkdown, committedLen);
    expect(next).toBeGreaterThanOrEqual(committedLen);
  });
});

describe("describeOpenFence", () => {
  it("returns null when there is no fence", () => {
    expect(describeOpenFence("plain text")).toBeNull();
  });

  it("returns null when the fence is closed", () => {
    expect(describeOpenFence("```js\ncode\n```")).toBeNull();
  });

  it.each([
    { opener: "```js\n", expectedLang: "js" },
    { opener: "~~~python\n", expectedLang: "python" },
    { opener: "```\n", expectedLang: "" },
    { opener: "```  typescript info\n", expectedLang: "typescript" },
  ])("describes an open $opener fence", ({ opener, expectedLang }) => {
    const result = describeOpenFence(`${opener}const x = 1;`);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe(expectedLang);
    expect(result!.contentStart).toBe(opener.length);
  });

  it("ignores a mismatched closing fence", () => {
    const result = describeOpenFence("```js\ncode\n~~~");
    expect(result).not.toBeNull();
    expect(result!.lang).toBe("js");
  });
});

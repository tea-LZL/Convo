import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown", () => {
  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders a plain paragraph", () => {
    expect(renderMarkdown("hello world")).toContain("<p");
    expect(renderMarkdown("hello world")).toContain("hello world");
  });

  it.each([
    { md: "# Heading", tag: "h1", text: "Heading" },
    { md: "## Sub-heading", tag: "h2", text: "Sub-heading" },
    { md: "###### Tiny", tag: "h6", text: "Tiny" },
  ])("renders $tag headings", ({ md, tag, text }) => {
    const html = renderMarkdown(md);
    expect(html).toContain(`<${tag}`);
    expect(html).toContain(text);
  });

  it("renders unordered lists", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders ordered lists", () => {
    const html = renderMarkdown("1. first\n2. second");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>first</li>");
  });

  it("renders blockquotes", () => {
    const html = renderMarkdown("> a quote\n> continues");
    expect(html).toContain("<blockquote");
    expect(html).toContain("a quote<br>continues");
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toContain("<hr");
    expect(renderMarkdown("***")).toContain("<hr");
    expect(renderMarkdown("___")).toContain("<hr");
  });

  it("renders inline emphasis", () => {
    const html = renderMarkdown("**bold** and *italic* and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code");
    expect(html).toContain("code");
  });

  it("escapes HTML in code blocks", () => {
    const html = renderMarkdown("```html\n<p>hi</p>\n```");
    expect(html).toContain("&lt;p&gt;hi&lt;/p&gt;");
    expect(html).not.toContain("<p>hi</p>");
  });

  it("renders code blocks with language label", () => {
    const html = renderMarkdown("```typescript\nconst x = 1;\n```");
    expect(html).toContain("typescript");
    expect(html).toContain("const x = 1;");
  });

  it("renders simple tables", () => {
    const html = renderMarkdown("| a | b |\n| c | d |");
    expect(html).toContain("display:flex");
    expect(html).toContain("<span");
    expect(html).toContain("a");
  });

  it("preserves line breaks inside paragraphs", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toContain("line one<br>line two");
  });

  it("splits paragraphs on blank lines", () => {
    const html = renderMarkdown("p1\n\np2");
    expect(html.split("<p").length).toBe(3);
  });

  it("handles an unclosed code fence", () => {
    const html = renderMarkdown("```js\nconst x = 1;");
    expect(html).toContain("code-block-wrap");
    expect(html).toContain("const x = 1;");
  });

  it("escapes HTML entities in inline text", () => {
    const html = renderMarkdown("a < b & c > d");
    expect(html).toContain("a &lt; b &amp; c &gt; d");
  });

  it("escapes <think> tags as literal text", () => {
    const html = renderMarkdown("before <think>covert</think> after");
    expect(html).toContain("&lt;think&gt;covert&lt;/think&gt;");
    expect(html).not.toContain("<think>");
    expect(html).not.toContain("</think>");
  });
});

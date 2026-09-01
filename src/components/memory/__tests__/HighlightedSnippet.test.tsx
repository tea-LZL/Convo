import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedSnippet } from "../HighlightedSnippet";

describe("HighlightedSnippet", () => {
  it("renders FTS mark tokens while treating other HTML as literal text", () => {
    const snippet = 'hello <mark>tea</mark> <img src=x onerror="bad()">';
    const { container } = render(<HighlightedSnippet snippet={snippet} />);

    expect(screen.getByText("tea").tagName).toBe("MARK");
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.textContent).toContain('<img src=x onerror="bad()">');
  });

  it("keeps nested literal mark content highlighted through the outer closer", () => {
    render(
      <HighlightedSnippet snippet="before <mark>outer <mark>inner</mark>still-highlighted</mark> after" />,
    );

    expect(screen.getByText("still-highlighted", { selector: "mark" })).toBeInTheDocument();
  });

  it("renders an unmatched opening mark token as literal unhighlighted text", () => {
    const snippet = "before <mark>unmatched after";
    const { container } = render(<HighlightedSnippet snippet={snippet} />);

    expect(container.textContent).toBe(snippet);
    expect(container.querySelector("mark")).not.toBeInTheDocument();
  });

  it("keeps an unmatched outer opener literal around a later balanced mark", () => {
    const { container } = render(
      <HighlightedSnippet snippet="before <mark>outer <mark>tea</mark> after" />,
    );

    expect(container.textContent).toBe("before <mark>outer tea after");
    expect(screen.getByText("tea", { selector: "mark" })).toBeInTheDocument();
    expect(container.querySelectorAll("mark")).toHaveLength(1);
  });

  it("renders an unmatched closing mark token as literal unhighlighted text", () => {
    const snippet = "before </mark>unmatched after";
    const { container } = render(<HighlightedSnippet snippet={snippet} />);

    expect(container.textContent).toBe(snippet);
    expect(container.querySelector("mark")).not.toBeInTheDocument();
  });
});

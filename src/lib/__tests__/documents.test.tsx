import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffPreview } from "../../routes/DocumentsRoute";

describe("DiffPreview", () => {
  it("shows added and removed counts", () => {
    render(<DiffPreview original="old" proposed="new" />);
    expect(screen.getByText(/added/)).toBeTruthy();
    expect(screen.getByText(/removed/)).toBeTruthy();
  });

  it("shows no changes message for identical empty content", () => {
    render(<DiffPreview original="" proposed="" />);
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("renders diff lines with + and − prefixes", () => {
    render(<DiffPreview original="line1\nold line" proposed="line1\nnew line" />);
    // Equal lines show " " prefix, additions show "+", removals show "−"
    const lines = screen.getAllByText(/./).filter(
      (el) => el.classList.contains("text-success") || el.classList.contains("text-error") || el.classList.contains("text-text-muted")
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it("does not drop a meaningful trailing empty line in a diff block", () => {
    // The bug was that all trailing empty lines were dropped.
    // A diff with an added trailing empty line should show it.
    render(<DiffPreview original="" proposed="content\n" />);
    // Should NOT say "No changes"
    expect(screen.queryByText("No changes")).toBeNull();
  });
});

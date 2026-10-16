/**
 * The chat view owns an h1.
 *
 * `ChatViewNew` is not a `RouteShell` page — a conversation is a
 * full-height scrolling column with a pinned composer, and a title bar
 * above it would take 90px of the one thing this surface is for — so
 * nothing above it supplies an `h1`. But its empty state renders an
 * `EmptyState` with `headingLevel={2}`, which is a skipped level without
 * one: a screen-reader user moving by level jumps straight to 2.
 *
 * The fix is a visually hidden `h1`, so the visible design is untouched
 * and what this pins is the outline: exactly one `h1`, hiding rather
 * than laying out.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ChatViewNew } from "../ChatViewNew";

function renderChat() {
  return render(
    <MemoryRouter>
      <ChatViewNew sessionId="heading-guard" providers={[]} />
    </MemoryRouter>,
  );
}

describe("the chat view owns an h1", () => {
  it("exposes exactly one accessible h1 without changing the visible design", async () => {
    renderChat();
    const h1s = await screen.findAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Chat"]);
    // Visually hidden, so it adds no layout: `css: false` means jsdom
    // has no stylesheet to read hiding out of, so the class is the
    // honest instrument — and it is the stock Tailwind utility, not a
    // local rule that could restyle the surface around it.
    expect(h1s[0]).toHaveClass("sr-only");
    // …and the empty state's h2 is still the visible title, so the
    // outline reads 1 → 2 rather than starting at 2.
    expect(screen.getByRole("heading", { level: 2, name: "No messages yet" })).toBeInTheDocument();
  });
});

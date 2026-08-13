import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionSearch } from "../SessionSearch";
import { CommandPalette } from "../CommandPalette";
import { usePaletteStore } from "../../stores/palette";
import { registerActions, unregisterActions } from "../../stores/palette";

describe("overlay keyboard interactions", () => {
  it("keeps command-palette actions out of the tab order and restores focus", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open palette";
    document.body.appendChild(trigger);
    trigger.focus();
    registerActions([{ id: "test-action", label: "Test action", group: "Test", perform: () => {} }]);
    usePaletteStore.setState({ open: true, query: "" });
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    expect(screen.getByRole("option", { name: "Test action" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    unregisterActions(["test-action"]);
    trigger.remove();
  });

  it("opens session search from the shell event", async () => {
    render(
      <MemoryRouter>
        <SessionSearch />
      </MemoryRouter>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("convo:search-sessions"));
    });
    expect(await screen.findByRole("dialog", { name: "Search sessions" })).toBeInTheDocument();
  });

  it("traps session-search focus and restores the trigger focus on close", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open search";
    document.body.appendChild(trigger);
    trigger.focus();
    render(
      <MemoryRouter>
        <SessionSearch />
      </MemoryRouter>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("convo:search-sessions"));
    });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-search-input"));

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toHaveAttribute("data-search-input");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

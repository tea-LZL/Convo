import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { Modal } from "../Modal";
import { Dropdown } from "../Dropdown";

describe("shared accessibility behavior", () => {
  it("traps modal focus and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Confirm">
        <button>First</button>
        <button>Last</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("gives dropdown triggers and items keyboard menu semantics", async () => {
    render(
      <Dropdown trigger={<button>Open menu</button>}>
        <button>First item</button>
      </Dropdown>,
    );

    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "First item" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the modal shell free of axe violations", async () => {
    const { container } = render(
      <Modal open onClose={vi.fn()} title="Accessible modal">
        <p>Modal content</p>
      </Modal>,
    );

    expect((await axe(container)).violations).toHaveLength(0);
  });
});

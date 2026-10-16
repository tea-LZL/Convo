import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * One radius for every floating surface.
 *
 * Task 2 moved `Modal` off `rounded-2xl` and onto `rounded-xl`, and
 * left these two behind. The result was three radii for one object
 * class — a dialog, a command palette and a session search are all
 * "a thing that floats above the page", and they were rounding their
 * corners three different ways.
 *
 * The palette is the one that matters most here: it is what the
 * redesigned sidebar's search row opens, so the radius a user sees
 * first is the palette's, and the sidebar's own active row sits in a
 * `rounded-md` card above it. A `rounded-2xl` palette against a
 * `rounded-xl` modal is a difference nobody asked for and everybody
 * sees.
 *
 * `rounded-2xl` is also not a theme radius at all — it is 1rem
 * written into the class, which no theme can move. So the claim here is
 * not "they are the same class name": it is that all three resolve to
 * the same *declared* radius, read out of the project Tailwind, and
 * that the radius they resolve to is one a theme seeds. `primitives.
 * test.tsx` already makes the same argument for `Modal` itself; this is
 * the half that was left out.
 */
describe("floating surfaces share one radius", () => {
  /** The radius a class declares, resolved through the project Tailwind. */
  const radiusOf = async (el: Element): Promise<string> => {
    const postcss = (await import("postcss")).default;
    const tailwindcss = (await import("tailwindcss")).default;
    const config = (await import("../../../tailwind.config")).default;
    const cls = Array.from(el.classList).find((c) => c.startsWith("rounded-"));
    if (!cls) throw new Error(`<${el.tagName.toLowerCase()}> class="${el.className}" carries no radius`);
    const plugins = [
      tailwindcss({
        ...(config as object),
        content: [{ raw: `<i class="${cls}"></i>`, extension: "html" }],
        corePlugins: { preflight: false },
      }),
    ] as never;
    const css = (await postcss(plugins).process("@tailwind utilities;", { from: undefined })).css;
    const at = css.indexOf("@media");
    const body = at < 0 ? css : css.slice(0, at);
    const rule = body.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    if (!rule) throw new Error(`${cls} emits no rule at all; the class does not exist`);
    const decl = rule[1].split(";").find((d) => d.trim().startsWith("border-radius:"));
    if (!decl) throw new Error(`${cls} emits no border-radius`);
    return decl.split(":")[1].trim();
  };

  /** Every `shadow-modal` surface currently on the page. */
  const floating = (root: HTMLElement) => {
    const found = Array.from(root.querySelectorAll<HTMLElement>(".shadow-modal"));
    expect(found.length, "a floating surface must actually be on the page").toBeGreaterThan(0);
    return found;
  };

  it("rounds the command palette the way it rounds a modal", async () => {
    usePaletteStore.setState({ open: true, query: "" });
    const { container } = render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    const panel = floating(container)[0];
    expect(panel).toHaveAttribute("data-command-palette");

    // Compared against `Modal`'s own panel rather than against a literal,
    // so a retune of the theme's radius scale moves both sides and the
    // agreement survives it.
    const { Modal } = await import("../ui/Modal");
    const modal = render(<MemoryRouter><Modal open onClose={() => {}} title="Reference">x</Modal></MemoryRouter>);
    const reference = floating(modal.container)[0];
    expect(await radiusOf(panel)).toBe(await radiusOf(reference));
    // …and the negative, so "one radius" cannot be satisfied by a page
    // where everything became a bare `rounded` or nothing at all.
    expect(panel.className).not.toMatch(/rounded-2xl/);
    expect(await radiusOf(panel)).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
    usePaletteStore.setState({ open: false, query: "" });
  });

  it("rounds the session search the same way too", async () => {
    render(<MemoryRouter><SessionSearch /></MemoryRouter>);
    act(() => { window.dispatchEvent(new CustomEvent("convo:search-sessions")); });
    const dialog = await screen.findByRole("dialog", { name: "Search sessions" });
    const panel = floating(dialog as HTMLElement)[0];
    expect(panel).toHaveAttribute("data-session-search");

    const { Modal } = await import("../ui/Modal");
    const modal = render(<MemoryRouter><Modal open onClose={() => {}} title="Reference">x</Modal></MemoryRouter>);
    const reference = floating(modal.container)[0];
    expect(await radiusOf(panel)).toBe(await radiusOf(reference));
    expect(panel.className).not.toMatch(/rounded-2xl/);
    expect(await radiusOf(panel)).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
  });

  it("resolves a hardcoded radius to a literal, which is the thing being banned", async () => {
    // The control on the resolver. `rounded-2xl` emits `1rem` and
    // `rounded-xl` emits `var(--radius-xl)`; if the resolver could not
    // tell those apart, "they agree" would be satisfiable by anything.
    const probe = document.createElement("div");
    probe.className = "rounded-2xl";
    expect(await radiusOf(probe)).toBe("1rem");
    probe.className = "rounded-xl";
    expect(await radiusOf(probe)).toBe("var(--radius-xl)");
    // The same class through a second element, so "they agree" is shown
    // to be a fact about the class rather than about one cached compile.
    const other = document.createElement("div");
    other.className = "rounded-2xl";
    expect(await radiusOf(probe)).not.toBe(await radiusOf(other));
    // …and a box with no radius at all is a failure, not a shrug.
    await expect(radiusOf(document.createElement("div"))).rejects.toThrow();
  });

  it("leaves no rounded-2xl anywhere in the components that float", () => {
    // The source sweep, because the DOM walk above only sees the two
    // states it opened: a fourth floating surface added later, or one
    // that renders only behind a dialog, would not be covered.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    for (const rel of [
      "src/components/CommandPalette.tsx",
      "src/components/SessionSearch.tsx",
      "src/components/ui/Modal.tsx",
      "src/components/ui/ConfirmDialog.tsx",
      "src/components/ui/Dropdown.tsx",
      "src/components/ui/Form.tsx",
      "src/components/chat/ChatContextMenu.tsx",
    ]) {
      // Comments stripped: a docblock that *mentions* rounded-2xl as the
      // thing that was removed would otherwise fail its own guard.
      const src = readFileSync(resolve(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      expect(src, `${rel} must not round a floating surface at a hardcoded radius`)
        .not.toMatch(/rounded-2xl/);
    }
  });
});

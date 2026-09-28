/**
 * The restyled shared primitives, state by state.
 *
 * These are the components every page inherits the new look through, so
 * this file is deliberately opinionated about the *states* — default,
 * hover, disabled, focus-visible, and open — rather than about any single
 * screenshot. jsdom loads no stylesheet (`css: false`), so a class
 * assertion is the only handle on the visual vocabulary; what keeps that
 * honest is that each assertion here states a rule of the design system,
 * not a snapshot of today's class string:
 *
 *   - radii come from the four theme radius keys, so a theme that
 *     reshapes the UI actually reshapes the primitives;
 *   - a focus ring is 2px and derived from a token, never a literal;
 *   - a card is a surface plus a 1px border and carries no shadow, while
 *     a floating overlay (modal, menu, tooltip) keeps one;
 *   - a disabled control looks disabled;
 *   - no colour literal appears in any class or inline style, in any
 *     state.
 *
 * Non-interactive primitives (Panel, EmptyState, Skeleton) have no hover,
 * disabled or focus-visible state, and inventing one to assert would be a
 * test of nothing. They are covered for the states they do have.
 *
 * ── Scope of the contrast figures in this file ────────────────────────
 * Every ratio quoted below — the Switch thumb's, the EmptyState icon's —
 * was measured on **Default Dark and Default Light only**. Those are the
 * two themes this file can reason about without a render.
 *
 * **Solar, Forest, Mono and High Contrast are unverified.** Contrast is a
 * property of a *pairing*, not of a token: `--color-text` against
 * `--color-surface-3` can clear 3:1 on the two defaults and fail on Solar,
 * and no assertion here would notice. The Switch thumb is the sharpest
 * case — a 16px circle whose only job is to be found against a filled
 * track, on a theme whose surface and text values are not these.
 *
 * So treat every number in this file as scoped to two of six themes, and
 * do not cite one as a palette-wide result. Measuring the other four is a
 * separate piece of work and deliberately not attempted here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, render, screen } from "@testing-library/react";
import { ListTodo, Pencil } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../Button";
import { Dropdown } from "../Dropdown";
import { EmptyState } from "../EmptyState";
import { IconButton } from "../IconButton";
import { Badge, Select, Slider, Switch, Tabs, TextArea, TextInput, Tooltip } from "../Form";
import { Modal } from "../Modal";
import { Panel } from "../Panel";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
import { ChatSkeleton, Skeleton } from "../Skeleton";

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Every class in the subtree, plus every inline style value. */
function everyDeclaration(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    out.push(el.getAttribute("class") ?? "");
    const style = el.getAttribute("style");
    if (style) out.push(style);
  }
  return out;
}

/** The grep Task 7 runs over the diff, run here over every state instead. */
const LITERAL_COLOUR =
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(\s*in\s*(srgb|rgb)\b/i;

function expectNoColourLiteral(root: HTMLElement, where: string) {
  for (const declaration of everyDeclaration(root)) {
    expect(declaration, `${where} must not hardcode a colour`).not.toMatch(LITERAL_COLOUR);
  }
}

/**
 * A focus ring, 2px, derived from a token, and a gap between the ring and
 * the control so the ring is not the same colour as the thing it outlines.
 *
 * ── This pin was wrong, and said so, and the fix is in the same commit ─
 * It used to require `focus-visible:ring-accent/NN` and carry a comment
 * admitting the requirement was wrong on the two filled variants. It was
 * wrong considerably more widely than the comment claimed. The comment
 * measured the ring against the *button's own fill*; nobody had measured
 * it against the *page behind it*, and there `accent` at 40% alpha is
 * 1.68:1 in the default dark theme — 1.86 in the light one, 2.14 on Solar,
 * 2.16 on Forest, 2.92 on Mono. It cleared 3:1 only on High Contrast,
 * the one theme built so that everything clears 3:1. So the ring was not
 * a filled-button problem, it was an everywhere problem, and it was close
 * to invisible rather than subtly weak. A class-name pin cannot catch
 * that, because the class name is the same either way.
 *
 * So the ring is `text` with a `bg` offset — three theme tokens, no new
 * one — and this helper now requires both halves plus the offset, which
 * is strictly more than it required before. It still cannot see the
 * resulting *contrast*; that is `focusRing.test.ts`'s job, and it measures
 * all three legs against all six built-in themes. Between them the two
 * files fail if the ring stops being a token, stops being 2px, loses its
 * gap, or drops below 3:1 — which is the assertion the old pin could not
 * make and did not need to.
 */
function expectTokenFocusRing(el: HTMLElement, where: string) {
  const cls = el.getAttribute("class") ?? "";
  expect(cls, `${where} must carry a focus ring`).toMatch(/focus(-visible)?:ring-2\b/);
  expect(cls, `${where}'s ring must be token-derived`).toMatch(/focus(-visible)?:ring-[a-z-]+\b/);
  expect(cls, `${where}'s ring must not be a translucent accent`).not.toMatch(
    /focus(-visible)?:ring-accent\/\d+/,
  );
  expect(cls, `${where} must suppress the global outline when it rings`).toMatch(
    /focus(-visible)?:outline-none\b/,
  );
  // The gap. An inset ring cannot have one — there is nothing between the
  // indicator and the control's own fill to separate — and the three inset
  // sites are checked individually for that, so the exemption is stated
  // here rather than left to the reader to infer.
  if (!/focus(-visible)?:ring-inset\b/.test(cls)) {
    expect(cls, `${where}'s ring must be offset from the control's own edge`).toMatch(
      /focus(-visible)?:ring-offset-2\b/,
    );
    expect(cls, `${where}'s offset must be a token`).toMatch(
      /focus(-visible)?:ring-offset-[a-z-]+\b/,
    );
  }
}

/** Every primitive, in every state, in one tree — the literal sweep. */
function Kitchen() {
  return (
    <div>
      <Button>Default</Button>
      <Button variant="primary" icon={<Pencil size={12} />} rightIcon={<Pencil size={12} />}>
        Primary
      </Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="outline">Outline</Button>
      <Button loading>Loading</Button>
      <Button disabled>Disabled</Button>
      <IconButton icon={<Pencil />} label="Edit" />
      <IconButton icon={<Pencil />} label="Edit subtle" variant="subtle" />
      <IconButton icon={<Pencil />} label="Edit solid" variant="solid" />
      <IconButton icon={<Pencil />} label="Edit active" active />
      <IconButton icon={<Pencil />} label="Edit off" disabled />
      <TextInput value="" onChange={() => {}} />
      <TextInput value="" onChange={() => {}} disabled />
      <TextArea value="" onChange={() => {}} />
      <Select
        value="dark"
        onChange={() => {}}
        options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}
      />
      <Select
        value="dark"
        onChange={() => {}}
        disabled
        options={[{ value: "dark", label: "Dark" }]}
      />
      <Switch checked onChange={() => {}} label="Live" description="Semantic recall" />
      <Switch checked={false} onChange={() => {}} disabled />
      <Slider value={1} onChange={() => {}} min={0} max={2} />
      <Tabs
        tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}
        active="a"
        onChange={() => {}}
      />
      <Badge>Live</Badge>
      <Badge variant="accent">Accent</Badge>
      <Tooltip content="Soon">
        <span>hover me</span>
      </Tooltip>
      <Panel>
        <span>panel</span>
      </Panel>
      <Panel bordered={false} padded>
        <span>bare panel</span>
      </Panel>
      <EmptyState title="Nothing here" description="Add something." icon={<ListTodo />} />
      <Skeleton />
      <ChatSkeleton />
    </div>
  );
}

/* ── Button ──────────────────────────────────────────────────────────── */

describe("Button", () => {
  it("defaults to a surface plus a hairline, with no shadow", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveClass("bg-surface-2", "border-border");
    expect(button).not.toHaveClass("shadow-panel");
  });

  it.each([
    ["secondary", "bg-surface-2", "hover:bg-surface-3"],
    ["primary", "bg-accent", "hover:bg-accent-hover"],
    ["ghost", "bg-transparent", "hover:bg-surface-2"],
    ["outline", "bg-transparent", "hover:bg-surface-2"],
    ["danger", "bg-error/10", "hover:bg-error/20"],
  ] as const)("gives the %s variant a base and a hover", (variant, base, hover) => {
    render(<Button variant={variant}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveClass(base, hover);
  });

  it("looks disabled when it is disabled", () => {
    render(<Button disabled>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass("disabled:opacity-40", "disabled:cursor-not-allowed");
  });

  it("rings focus with a token-derived ring", () => {
    render(<Button>Save</Button>);
    expectTokenFocusRing(screen.getByRole("button", { name: "Save" }), "Button");
  });

  it("is inert while loading, and says so", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg")).not.toBeNull();
  });
});

/* ── IconButton ──────────────────────────────────────────────────────── */

describe("IconButton", () => {
  it("defaults to a ghost that hovers onto a surface", () => {
    render(<IconButton icon={<Pencil />} label="Edit" />);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveClass("text-text-muted", "hover:text-text", "hover:bg-surface-2");
  });

  it.each([
    ["subtle", "bg-surface-2", "hover:bg-surface-3"],
    ["solid", "bg-accent", "hover:bg-accent-hover"],
  ] as const)("gives the %s variant a base and a hover", (variant, base, hover) => {
    render(<IconButton icon={<Pencil />} label="Edit" variant={variant} />);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveClass(base, hover);
  });

  it("tints the active state with the accent, the way the accent badge does", () => {
    render(<IconButton icon={<Pencil />} label="Edit" active />);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveClass("bg-accent/15", "text-accent");
    // The two-step tint is the danger variant's pattern: a lighter active
    // state that still responds to the pointer.
    expect(button).toHaveClass("hover:bg-accent/20");
    expect(button).not.toHaveClass("bg-surface-3");
  });

  it("does not read as active when it is not", () => {
    render(<IconButton icon={<Pencil />} label="Edit" />);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).not.toHaveClass("bg-accent/15", "text-accent");
  });

  it("looks disabled when it is disabled", () => {
    render(<IconButton icon={<Pencil />} label="Edit" disabled />);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass("disabled:opacity-40", "disabled:cursor-not-allowed");
  });

  it("rings focus with a token-derived ring", () => {
    render(<IconButton icon={<Pencil />} label="Edit" />);
    expectTokenFocusRing(screen.getByRole("button", { name: "Edit" }), "IconButton");
  });
});

/* ── the Form family ─────────────────────────────────────────────────── */

describe("TextInput", () => {
  it("is a surface-2 field on a rounded-md, with no shadow", () => {
    const { container } = render(<TextInput value="" onChange={() => {}} />);
    const input = container.querySelector("input")!;
    expect(input).toHaveClass("bg-surface-2", "border-border", "rounded-md");
    expect(input).not.toHaveClass("shadow-panel");
  });

  it("rings focus with a token-derived ring", () => {
    const { container } = render(<TextInput value="" onChange={() => {}} />);
    expectTokenFocusRing(container.querySelector("input")!, "TextInput");
  });

  it("looks disabled when it is disabled", () => {
    const { container } = render(<TextInput value="" onChange={() => {}} disabled />);
    const input = container.querySelector("input")!;
    expect(input).toBeDisabled();
    expect(input).toHaveClass("disabled:opacity-50", "disabled:cursor-not-allowed");
  });
});

describe("TextArea", () => {
  it("matches the input field treatment", () => {
    const { container } = render(<TextArea value="" onChange={() => {}} />);
    const area = container.querySelector("textarea")!;
    expect(area).toHaveClass("bg-surface-2", "border-border", "rounded-md");
  });

  it("rings focus with a token-derived ring", () => {
    const { container } = render(<TextArea value="" onChange={() => {}} />);
    expectTokenFocusRing(container.querySelector("textarea")!, "TextArea");
  });

  it("looks disabled when it is disabled", () => {
    const { container } = render(<TextArea value="" onChange={() => {}} disabled />);
    const area = container.querySelector("textarea")!;
    expect(area).toBeDisabled();
    expect(area).toHaveClass("disabled:opacity-50", "disabled:cursor-not-allowed");
  });
});

describe("Select", () => {
  const options = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];

  it("is a surface-2 field on a rounded-md, like the other inputs", () => {
    render(<Select value="dark" onChange={() => {}} options={options} />);
    // Without this, nothing anywhere pinned the select's base surface: the
    // old assertion in Form.test.tsx was the only one, and it was
    // re-targeted at behaviour.
    expect(screen.getByRole("combobox")).toHaveClass("bg-surface-2", "border-border", "rounded-md");
  });

  it("suppresses the native arrow, and draws its own indicator instead", () => {
    const { container } = render(<Select value="dark" onChange={() => {}} options={options} />);
    const select = screen.getByRole("combobox");
    // All three halves of one invariant, asserted together because
    // dropping any one of them is a visible defect: without
    // `appearance-none` the control shows two arrows, without `pr-8` the
    // chevron sits on top of the text, and without the chevron there is
    // no indicator at all.
    expect(select).toHaveClass("appearance-none", "pr-8");
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("rings focus with a token-derived ring", () => {
    render(<Select value="dark" onChange={() => {}} options={options} />);
    expectTokenFocusRing(screen.getByRole("combobox"), "Select");
  });
});

describe("Switch", () => {
  it("fills with the accent when checked and a raised surface when not", () => {
    const { rerender } = render(<Switch checked onChange={() => {}} label="Live" />);
    const control = screen.getByRole("switch");
    expect(control).toHaveClass("bg-accent");
    expect(control.querySelector("span")).toHaveClass("translate-x-4");

    rerender(<Switch checked={false} onChange={() => {}} label="Live" />);
    expect(screen.getByRole("switch")).toHaveClass("bg-surface-3");
    expect(screen.getByRole("switch").querySelector("span")).toHaveClass("translate-x-0");
  });

  it("draws the thumb in a colour that clears 3:1 against whichever track it is on", () => {
    // The two tracks are opposite in lightness — accent when checked,
    // surface-3 when not — so no single token wins both, and the answer
    // has to be measured rather than reasoned about. Ratios against the
    // track the thumb actually sits on, from the two default themes
    // (see the file header for what these do and do not cover):
    //
    //   white on accent      3.96:1 dark,  6.18:1 light
    //   text  on surface-3  12.37:1 dark, 14.30:1 light
    //   text  on accent      3.23:1 dark,  2.76:1 light  <- light fails 1.4.11
    //   white on surface-3  15.15:1 dark,  1.19:1 light  <- light fails 1.4.11
    //
    // So the thumb takes the checked value when checked. Both branches
    // clear the 3:1 a UI component boundary needs, in both themes.
    const { rerender } = render(<Switch checked onChange={() => {}} label="Live" />);
    const thumb = () => screen.getByRole("switch").querySelector("span")!;

    expect(thumb()).toHaveClass("bg-white");
    expect(thumb()).not.toHaveClass("bg-text");

    rerender(<Switch checked={false} onChange={() => {}} label="Live" />);
    expect(thumb()).toHaveClass("bg-text");
    expect(thumb()).not.toHaveClass("bg-white");

    // The design is flat: a shadow on a 16px circle is the old language.
    expect(thumb().getAttribute("class")).not.toMatch(/(^|\s)shadow(\s|$)/);
  });

  it("rings focus with a token-derived ring", () => {
    render(<Switch checked onChange={() => {}} label="Live" />);
    expectTokenFocusRing(screen.getByRole("switch"), "Switch");
  });

  it("looks disabled and refuses to toggle", () => {
    const onChange = vi.fn();
    const { container } = render(<Switch checked onChange={onChange} label="Live" disabled />);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(container.firstElementChild).toHaveClass("opacity-50", "cursor-not-allowed");
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Slider", () => {
  it("tracks the accent token and rings focus from it", () => {
    const { container } = render(<Slider value={1} onChange={() => {}} min={0} max={2} />);
    const input = container.querySelector("input")!;
    expect(input.getAttribute("class")).toContain("var(--color-accent)");
    expectTokenFocusRing(input, "Slider");
  });
});

describe("Tabs", () => {
  it("marks the active tab with an accent underline, not a fill", () => {
    render(
      <Tabs
        tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}
        active="a"
        onChange={() => {}}
      />,
    );
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveClass("text-text");
    expect(first.querySelector("span.bg-accent")).not.toBeNull();
    expect(second).toHaveClass("text-text-muted", "hover:text-text");
    expect(second.querySelector("span.bg-accent")).toBeNull();
  });

  it("rings focus with a token-derived ring, inset so the indicator is not clipped", () => {
    render(<Tabs tabs={[{ id: "a", label: "A" }]} active="a" onChange={() => {}} />);
    const tab = screen.getByRole("tab");
    expectTokenFocusRing(tab, "Tabs");
    expect(tab.getAttribute("class")).toContain("focus-visible:ring-inset");
  });
});

describe("Badge", () => {
  it("uses a token radius", () => {
    render(<Badge>Live</Badge>);
    const badge = screen.getByText("Live");
    // `rounded` is a hardcoded 4px that no theme can move.
    expect(badge).toHaveClass("rounded-sm");
    expect(badge).not.toHaveClass("rounded");
  });

  it("tints the accent variant with the accent", () => {
    render(<Badge variant="accent">Accent</Badge>);
    expect(screen.getByText("Accent")).toHaveClass("bg-accent/15", "text-accent");
  });
});

describe("Tooltip", () => {
  it("floats above the content, so it keeps a shadow", () => {
    const { container } = render(
      <Tooltip content="Soon">
        <span>hover me</span>
      </Tooltip>,
    );
    expect(screen.queryByText("Soon")).toBeNull();
    fireEvent.mouseEnter(container.firstElementChild!);
    const tip = screen.getByText("Soon");
    expect(tip).toHaveClass("bg-surface-3", "border-border", "rounded-md", "shadow-modal");
  });
});

/* ── Modal ───────────────────────────────────────────────────────────── */

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("open, is a floating dialog: a surface, a hairline, and a shadow", () => {
    render(
      <Modal open onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // A modal floats above the page. Dropping its shadow would leave it
    // reading as a flat card sitting on the same plane as its content.
    const panel = dialog.querySelector<HTMLElement>(".shadow-modal")!;
    expect(panel, "the dialog surface must keep its shadow").not.toBeNull();
    expect(panel).toHaveClass("bg-surface-1", "border-border");
    expect(panel.getAttribute("class")).not.toContain("shadow-panel");
    expect(dialog.querySelector(".overlay-backdrop")).not.toBeNull();
  });

  it("open, takes its radius from the theme's radius tokens", () => {
    render(
      <Modal open onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const panel = screen.getByRole("dialog").querySelector<HTMLElement>(".shadow-modal")!;
    // rounded-2xl is 1rem hardcoded; a theme cannot move it.
    expect(panel).toHaveClass("rounded-xl");
    expect(panel).not.toHaveClass("rounded-2xl");
  });

  it("divides header and footer with the full-strength hairline", () => {
    render(
      <Modal open onClose={vi.fn()} title="Confirm" footer={<Button>Ok</Button>}>
        <p>Body</p>
      </Modal>,
    );
    const panel = screen.getByRole("dialog").querySelector<HTMLElement>(".shadow-modal")!;
    const rules = [panel.querySelector<HTMLElement>(".border-b"), panel.querySelector<HTMLElement>(".border-t")];
    for (const rule of rules) {
      expect(rule, "the dialog must have a hairline rule").not.toBeNull();
      expect(rule).toHaveClass("border-border");
      expect(rule!.getAttribute("class")).not.toMatch(/border-border\/\d+/);
    }
  });

  it("gives the close button a hover and a token focus ring", () => {
    render(
      <Modal open onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("hover:bg-surface-2", "hover:text-text");
    expectTokenFocusRing(close, "the modal close button");
  });
});

/* ── Dropdown ────────────────────────────────────────────────────────── */

describe("Dropdown", () => {
  it("closed, shows only the trigger", () => {
    render(
      <Dropdown trigger={<button>Open</button>}>
        <button>Item</button>
      </Dropdown>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-expanded", "false");
  });

  it("open, is a floating menu: a surface, a hairline, and a shadow", () => {
    render(
      <Dropdown trigger={<button>Open</button>}>
        <button>Item</button>
      </Dropdown>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const menu = screen.getByRole("menu");
    // Same reasoning as the modal: it overlaps the page, so it keeps its
    // shadow rather than reading as a card in the flow.
    expect(menu).toHaveClass("shadow-modal", "bg-surface-1", "border-border", "rounded-lg");
    expect(menu).not.toHaveClass("shadow-panel");
  });
});

/* ── Panel, EmptyState, Skeleton ─────────────────────────────────────── */

describe("Panel", () => {
  it("is a card: surface-1, a 1px border, a token radius, and no shadow", () => {
    const { container } = render(<Panel>Body</Panel>);
    const panel = container.firstElementChild!;
    expect(panel).toHaveClass("bg-surface-1", "border", "border-border");
    // The spec pins a card to --radius-lg.
    expect(panel).toHaveClass("rounded-lg");
    expect(panel).not.toHaveClass("rounded-xl");
    // Flat by design: a card is a surface plus a hairline.
    expect(panel.getAttribute("class")).not.toMatch(/(^|\s)shadow(-\w+)?(\s|$)/);
  });

  it("honours bordered and padded without inventing a prop for them", () => {
    const { container, rerender } = render(<Panel bordered={false} padded>Body</Panel>);
    const panel = container.firstElementChild!;
    expect(panel).not.toHaveClass("border");
    expect(panel).toHaveClass("p-4", "bg-surface-1");
    rerender(<Panel>Body</Panel>);
    expect(container.firstElementChild).toHaveClass("border");
  });
});

describe("EmptyState", () => {
  it("sets the icon on a flat surface chip, in a shade that stays legible", () => {
    const { container } = render(
      <EmptyState title="Nothing here" description="Add one." icon={<ListTodo />} action={<Button>Add</Button>} />,
    );
    expect(screen.getByRole("heading", { name: "Nothing here" })).toHaveClass("text-text");
    expect(screen.getByText("Add one.")).toHaveClass("text-text-muted");
    // The chip is the only element painted surface-2 in this tree, which
    // is what makes the locator unambiguous — the description is the
    // other muted element and carries no fill.
    const icon = container.querySelector<HTMLElement>(".bg-surface-2")!;
    expect(icon, "the icon must sit on a surface chip").not.toBeNull();
    expect(icon).toHaveClass("rounded-lg");
    // Measured on the two default themes, chip surface included:
    //   text-subtle  2.69:1 dark,  2.73:1 light   <- what the chip did
    //   text-muted    5.49:1 dark,  5.57:1 light   <- what it does now
    // The bare page background, before the chip existed, was 3.11 and
    // 2.90 — so the shade moved rather than the surface, and the icon
    // ends up above 3:1 in both themes where it previously was not.
    //
    // This is a fix for a restyle regression, not a rule about the
    // palette: `text-text-subtle` on a raised surface is common elsewhere
    // in the app, including this file's own input placeholders. Asserting
    // it away here would be a rule the codebase does not follow.
    expect(icon).toHaveClass("text-text-muted");
    expect(icon).not.toHaveClass("text-text-subtle");
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  /**
   * The title is a heading, and a heading's level is semantic rather than
   * visual. `RouteShell` gives every page an `h1`, so the `h3` this
   * component has always rendered is a skipped level underneath it, and
   * a screen-reader user moving by heading level cannot reach the title.
   *
   * So the level is a prop — and the treatment must be *identical*
   * whichever level is asked for, because that is the whole claim: the
   * primitive's job is the semantics, not a second visual.
   */
  describe("headingLevel", () => {
    it("renders an h3 by default, so no call site that ignores it changes", () => {
      render(<EmptyState title="Nothing here" />);
      expect(screen.getByRole("heading", { name: "Nothing here" }).tagName).toBe("H3");
    });

    it("renders an h2 when asked, and changes nothing else", () => {
      const props = { title: "Nothing here", description: "Add one.", icon: <ListTodo />, action: <Button>Add</Button> };
      const { container, rerender } = render(<EmptyState {...props} />);
      const three = screen.getByRole("heading", { name: "Nothing here" });
      const threeClasses = three.className;
      const threeWrapper = (container.firstElementChild as HTMLElement).className;

      rerender(<EmptyState {...props} headingLevel={2} />);
      const two = screen.getByRole("heading", { name: "Nothing here" });
      expect(two.tagName).toBe("H2");
      // Not merely "an h2 appeared": the treatment is byte-identical, and
      // the only difference between the two renders is the tag. A
      // component that restyled on the way to being accessible would
      // pass a tag-only assertion and change a page's appearance.
      expect(two.className).toBe(threeClasses);
      expect((container.firstElementChild as HTMLElement).className).toBe(threeWrapper);
      // The control on the comparison: the default really is the other
      // tag, so equality of the class lists is not trivially true.
      expect(three.tagName).toBe("H3");
    });

  });
});

/**
 * Every route that draws its own `h1` through `RouteShell` and an
 * `EmptyState` underneath it has to ask for level 2, or the skip comes
 * back. Tasks 5 and 6 restyle three of these five, and the failure mode
 * is silent: an `h3` where an `h2` was looks identical.
 *
 * **A limit, stated.** This is a source scan and its parse is
 * best-effort: it reads a `<EmptyState …>` element as the text up to the
 * closing `>`, so a call site with a `>` inside an attribute value would
 * be read short. That is a false *negative* — a missed call site, not a
 * false finding — and the failure mode of a guard that cries wolf is a
 * guard that gets deleted, so the bias is the right way round. First
 * thing to revisit if a call site ever grows a `>` in an attribute.
 */
describe("EmptyState callers ask for the level their page chrome implies", () => {
  const ROUTES = [
    "src/routes/CompareRoute.tsx",
    "src/routes/DocumentsRoute.tsx",
    "src/routes/MemoryRoute.tsx",
    "src/routes/NotesRoute.tsx",
    "src/routes/TasksRoute.tsx",
  ];

  it("gives every call site headingLevel={2}, and every one is under an h1", () => {
    let callSites = 0;
    for (const rel of ROUTES) {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      // Only a route that wraps in `RouteShell` owns an `h1`, and only
      // then does the level matter. Asserted rather than assumed, so a
      // route that swaps shells stops being counted as a caller.
      expect(src, `${rel} must draw its heading through RouteShell`).toMatch(/<RouteShell/);
      for (const m of src.matchAll(/<EmptyState\b([^>]*)>/g)) {
        callSites++;
        expect(
          m[1],
          `${rel}: an EmptyState under RouteShell's h1 must ask for headingLevel={2}`,
        ).toMatch(/headingLevel=\{2\}/);
      }
    }
    // The control on the scan itself. Five files and no call site between
    // them is a regex that has stopped matching, not a clean tree.
    expect(callSites, "every route's EmptyState must be found by the scan").toBeGreaterThanOrEqual(5);
  });

  it("finds a call site that forgot, so the scan is not vacuous", () => {
    const src = '<EmptyState icon={<X />} title="No tasks" description="Add one." />';
    expect(src.match(/<EmptyState\b([^>]*)>/)![1]).not.toMatch(/headingLevel=\{2\}/);
    expect('<EmptyState headingLevel={2} title="No tasks" />'.match(/<EmptyState\b([^>]*)>/)![1])
      .toMatch(/headingLevel=\{2\}/);
  });
});

describe("Skeleton", () => {
  it("defaults to a rounded-md block and takes its size from props", () => {
    const { container } = render(<Skeleton />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveClass("skeleton", "rounded-md");
    expect(block.style.width).toBe("100%");
    expect(block.style.height).toBe("1rem");
  });

  it("lets the caller choose the radius without a new prop", () => {
    const { container } = render(<Skeleton rounded="rounded-lg" width="40%" height="2rem" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveClass("skeleton", "rounded-lg");
    expect(block.style.width).toBe("40%");
  });

  it("composes a chat placeholder out of skeleton blocks", () => {
    const { container } = render(<ChatSkeleton />);
    const blocks = container.querySelectorAll(".skeleton");
    expect(blocks.length).toBeGreaterThan(1);
    // The bubble's radius is matched to MessageRow's, which Task 5 owns —
    // moving one half of a matched pair would make the loading state
    // disagree with the loaded one.
    //
    // The *pairing* is asserted by comparison, not by these two literals
    // agreeing: `chatSurface.test.tsx` renders both halves and compares
    // the two renderings, so a commit that converts one and not the other
    // fails there. What this file owns is the other half of the rule — the
    // placeholder declares a *theme* radius — and both directions are
    // pinned, because a check that only says "the expected class is
    // present" also passes a placeholder that has grown a second radius.
    expect(container.querySelector(".rounded-lg")).not.toBeNull();
    expect(container.querySelector(".rounded-2xl")).toBeNull();
    expect(container.querySelector(".rounded")).toBeNull();
  });
});

/* ── the mechanical sweep ────────────────────────────────────────────── */

describe("no colour literal reaches a primitive, in any state", () => {
  it("holds across every variant, state and open overlay", () => {
    render(<Kitchen />);
    // The state that only exists on interaction.
    fireEvent.mouseEnter(screen.getByText("hover me").parentElement!);
    expect(screen.getByText("Soon")).toBeInTheDocument();

    render(
      <Modal open onClose={vi.fn()} title="Confirm" description="Really?">
        <Button>Inside</Button>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    render(
      <Dropdown trigger={<button>Open</button>}>
        <button>Item</button>
      </Dropdown>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // The menu is portalled to document.body, so the sweep has to reach
    // past any one container to cover every overlay at once.
    expectNoColourLiteral(document.body, "the portalled overlays");
  });

  it("gives every interactive primitive a token focus ring", () => {
    const { container } = render(
      <>
        <Kitchen />
        <Modal open onClose={vi.fn()} title="Confirm">
          <Button>Inside</Button>
        </Modal>
      </>,
    );
    const controls = Array.from(
      container.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [role='switch'], [role='tab']",
      ),
    );
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      const where =
        control.tagName.toLowerCase() +
        (control.getAttribute("aria-label") ? `[${control.getAttribute("aria-label")}]` : "") +
        (control.textContent ? `[${control.textContent.trim().slice(0, 20)}]` : "");
      expectTokenFocusRing(control, `the primitive at ${where}`);
    }
  });
});

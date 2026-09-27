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
 */
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
 * A focus ring, 2px, derived from a token. Both halves matter: a ring with
 * no colour is invisible, and a colour that is not a token breaks the
 * moment a user switches theme.
 *
 * ── Tracked deferral: this pin is wrong for the two filled variants ────
 * `ring-accent/40` outside a `bg-accent` border box is accent on accent.
 * On `Button variant="primary"` and `IconButton variant="solid"` the ring
 * is a 40%-alpha accent band against a full-accent edge, and a keyboard
 * user tabbing to a filled Save or Send does not get a boundary that
 * clears WCAG 1.4.11's 3:1.
 *
 * It is deferred, not fixed, and the reason is a missing token rather than
 * missing effort: a ring colour that reads on both a filled accent
 * background and the four surfaces the primitives sit on does not exist in
 * the 26 theme keys, and this plan adds none. The available workarounds
 * were both rejected — `ring-offset-*` means guessing which of `bg` /
 * `surface-1` / `surface-2` / `surface-3` the control happens to be on,
 * and a second accent token is a new theme key.
 *
 * **So this helper pins the known-imperfect treatment on purpose. When the
 * fix lands, this pin has to be revisited in the same change** — otherwise
 * the test will fail on the fix, or worse, be quietly relaxed to match it.
 * Owner: Task 7's a11y pass.
 */
function expectTokenFocusRing(el: HTMLElement, where: string) {
  const cls = el.getAttribute("class") ?? "";
  expect(cls, `${where} must carry a focus ring`).toMatch(/focus(-visible)?:ring-2\b/);
  expect(cls, `${where}'s ring must be token-derived`).toMatch(/focus(-visible)?:ring-accent(\/\d+)?\b/);
  expect(cls, `${where} must suppress the global outline when it rings`).toMatch(
    /focus(-visible)?:outline-none\b/,
  );
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
    // track the thumb actually sits on, from the two default themes:
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
  it("sets the icon on a flat surface chip, and the copy on the text tokens", () => {
    const { container } = render(
      <EmptyState title="Nothing here" description="Add one." icon={<ListTodo />} action={<Button>Add</Button>} />,
    );
    expect(screen.getByRole("heading", { name: "Nothing here" })).toHaveClass("text-text");
    expect(screen.getByText("Add one.")).toHaveClass("text-text-muted");
    const iconWrap = container.querySelector<HTMLElement>(".text-text-subtle")!;
    expect(iconWrap).toHaveClass("bg-surface-2", "rounded-lg");
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
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
    expect(container.querySelector(".rounded-2xl")).not.toBeNull();
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

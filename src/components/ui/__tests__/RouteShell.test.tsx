import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it } from "vitest";
import { RouteShell } from "../RouteShell";

describe("RouteShell", () => {
  it("provides a consistent heading, description, actions, and scroll region", () => {
    render(
      <RouteShell title="Workspace" description="A focused route" actions={<button>Action</button>}>
        <p>Content</p>
      </RouteShell>,
    );
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByText("A focused route")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });
});

/**
 * The page chrome. Spec §4.2: a 28px/700 title and a right-aligned action
 * cluster, and the reference's "View:" pill *only* where a real view
 * toggle exists.
 *
 * That last clause is the one worth a guard. A decorative dropdown that
 * switches nothing is worse than no dropdown — it advertises a capability
 * the app does not have, and it is the kind of thing that survives
 * review precisely because it looks like a feature. `RouteShell` is the
 * one component every page inherits, so a "View:" pill added here would
 * appear on all ten routes at once. This asserts the prop that carries
 * per-page toggles exists and is rendered, and that the shell itself
 * invents none.
 */
describe("RouteShell page chrome", () => {
  it("gives the title the reference's weight and size, in tokens not literals", () => {
    render(<RouteShell title="Memory">x</RouteShell>);
    const heading = screen.getByRole("heading", { name: "Memory" });
    // 28px at weight 700. Spelled as a Tailwind arbitrary value because
    // the 26 theme keys carry no type scale, and a px literal in a class
    // is not a colour literal but it is equally a hardcoded design
    // decision — so it is asserted here rather than assumed.
    expect(heading.className).toContain("text-[28px]");
    expect(heading.className).toContain("font-bold");
    expect(heading.className).toMatch(/\btracking-[\w-]+/);
  });

  it("lays the title out against a right-aligned action cluster", () => {
    render(
      <RouteShell
        title="Memory"
        actions={
          <>
            <button>Add</button>
            <button>Extract</button>
          </>
        }
      >
        <p>Body</p>
      </RouteShell>,
    );
    const heading = screen.getByRole("heading", { name: "Memory" });
    const header = heading.closest("header")!;
    const cluster = header.querySelector("[data-actions]")!;
    expect(within(cluster as HTMLElement).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(cluster as HTMLElement).getByRole("button", { name: "Extract" })).toBeInTheDocument();
    // The cluster is a sibling of the title block, not nested inside it,
    // and it is the one that must not be squeezed by a long title.
    expect(cluster.className).toMatch(/justify-end/);
    // The cluster must be *allowed to give*, and it wraps. This assertion
    // replaces one that read `expect(cluster.className).toMatch(/shrink-0/)`
    // and it is not a deletion: it inverts the claim the design has moved
    // past. A page's action cluster is the widest thing in its header —
    // Memory's kind filter is four tabs — so a cluster that could not
    // shrink pushed the content pane instead of reflowing, and the only
    // way to put a filter in the header was to leave it in the body.
    // `MemoryRoute.test.tsx` asserts the same property from the page that
    // depends on it, so a re-added `shrink-0` is caught from both sides.
    expect(cluster.className).not.toMatch(/(?:^|\s)shrink-0(?:\s|$)/);
    expect(cluster.className).toMatch(/(?:^|\s)flex-wrap(?:\s|$)/);
    // The control on the negative: the header carries a `shrink-0` of its
    // own, which is a different thing — that one stops the header
    // collapsing as the content region scrolls. Without this the assertion
    // above would also pass against a page with no `shrink-0` anywhere.
    expect(header.className).toMatch(/(?:^|\s)shrink-0(?:\s|$)/);
    expect(heading.parentElement).not.toBe(cluster);
    expect(heading.parentElement!.contains(cluster)).toBe(false);
  });

  it("renders no action cluster at all when a page passes none", () => {
    render(<RouteShell title="About">Body</RouteShell>);
    const header = screen.getByRole("heading", { name: "About" }).closest("header")!;
    // No reserved-but-empty strip: the cluster is absent, not blank. A
    // page with no actions gets no action cluster, so a restyle cannot
    // leave a dead region where a toggle was once meant to go.
    expect(header.querySelector("[data-actions]")).toBeNull();
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
  });

  it("adds no view-switcher of its own", () => {
    render(<RouteShell title="About">x</RouteShell>);
    const shell = screen.getByRole("heading", { name: "About" }).closest("section")!;
    // No "View:" label anywhere, and no listbox/menu/select — the shell
    // ships the frame, and a page that has a real toggle passes it in
    // through `actions`.
    expect(shell.textContent).not.toMatch(/view/i);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the scroll region scrollable and the header out of it", () => {
    render(<RouteShell title="Memory"><p>Body</p></RouteShell>);
    const shell = screen.getByRole("heading", { name: "Memory" }).closest("section")!;
    const header = shell.querySelector("header")!;
    const content = header.nextElementSibling!;
    expect(content.contains(screen.getByText("Body"))).toBe(true);
    expect(content.className).toMatch(/overflow-y-auto/);
    expect(content.className).toMatch(/min-h-0/);
    // A header inside the scroller scrolls away, which is what the
    // `shrink-0` on a flex child is there to prevent.
    expect(header.className).toMatch(/shrink-0/);
    expect(shell.className).toMatch(/min-h-0/);
  });

  it("has no accessibility violations with an action cluster", async () => {
    render(
      <RouteShell title="Memory" description="Durable context." actions={<button>Add</button>}>
        <p>Content</p>
      </RouteShell>,
    );
    const shell = screen.getByRole("heading", { name: "Memory" }).closest("section")!;
    expect((await axe(shell)).violations).toHaveLength(0);
  });
});

/**
 * The page inset, measured rather than spelled.
 *
 * The header was `px-6` — 24px — while the content roots were 8, 12 or
 * 16px, so on the two compact pages a 28px bold title sat 12–16px
 * further right than the first row of content under it. The claim here
 * is narrower than "16px is right": it is that the number is *one
 * number*, and that a retune of the spacing scale moves the header and
 * the content together rather than leaving one of them behind.
 *
 * jsdom has no stylesheet here (`vitest.config.ts` sets `css: false`),
 * so `getComputedStyle` cannot answer it, and reading `px-4` off the
 * class string would be the wrong test twice over: it pins an
 * implementation detail, and it passes for any page that merely says
 * `px-4`. So the value comes from the project's own Tailwind compiling
 * the class the shell actually rendered, and the class it does *not*
 * render is compiled in the same pass as a control — if the resolver
 * could not tell a padding from a gap, the negative control says so.
 */
describe("RouteShell page inset", () => {
  /** The pixels a compiled utility declares for one property, or throw. */
  async function pxOf(className: string, prop: string): Promise<number> {
    const postcss = (await import("postcss")).default;
    const tailwindcss = (await import("tailwindcss")).default;
    const config = (await import("../../../../tailwind.config")).default;
    const plugins = [
      tailwindcss({
        ...(config as object),
        content: [{ raw: `<i class="${className}"></i>`, extension: "html" }],
        corePlugins: { preflight: false },
      }),
    ] as never;
    const css = (await postcss(plugins).process("@tailwind utilities;", { from: undefined })).css;
    // Tailwind emits the screen variants after the plain utilities, so
    // everything from the first `@media` on applies only at a
    // breakpoint and must not be read as the unconditional value.
    const at = css.indexOf("@media");
    const body = at < 0 ? css : css.slice(0, at);
    const rule = body.match(new RegExp(`\\.${className.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    if (!rule) throw new Error(`${className} emits no rule at all; the class does not exist`);
    const decl = rule[1].split(";").find((d) => d.trim().startsWith(`${prop}:`));
    if (!decl) throw new Error(`${className} emits no ${prop}`);
    const m = decl.split(":")[1].trim().match(/^(-?[\d.]+)(px|rem)$/);
    if (!m) throw new Error(`${className} { ${prop} } is not an absolute length: "${decl}"`);
    return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
  }

  it("indents the header by the page inset, and takes it from the spacing scale", async () => {
    render(<RouteShell title="Memory"><p>Body</p></RouteShell>);
    const header = screen.getByRole("heading", { name: "Memory" }).closest("header")!;
    const inline = classMatching(header, /^px-/);
    const block = classMatching(header, /^py-/);
    // 16px on both sides, resolved out of the build rather than read off
    // the class. Two declarations, because `px-4` writes the sides and
    // `py-4` the block: a header that indented only its left edge would
    // pass a one-sided assertion.
    expect(await pxOf(inline, "padding-left")).toBe(16);
    expect(await pxOf(inline, "padding-right")).toBe(16);
    expect(await pxOf(block, "padding-top")).toBe(16);
    // …and the control on the resolver: it is reading a padding and not
    // something else, it is not returning a constant, and it fails loudly
    // on a class that does not exist — so a header that lost its inset
    // cannot pass as "some px".
    expect(await pxOf("px-8", "padding-left")).toBe(32);
    expect(await pxOf("px-2", "padding-left")).toBe(8);
    await expect(pxOf(inline, "margin-top")).rejects.toThrow();
    await expect(pxOf("px-7x", "padding-left")).rejects.toThrow();
  });

  it("states one inset rather than two, so a wide window cannot re-open the step", () => {
    render(<RouteShell title="Memory"><p>Body</p></RouteShell>);
    const header = screen.getByRole("heading", { name: "Memory" }).closest("header")!;
    // A `sm:px-*` is a second inset. The title would sit on one line
    // above the content and on another from the breakpoint on, which is
    // the exact defect this number exists to end.
    expect(
      Array.from(header.classList).filter((c) => c.includes(":")),
      "the header must not change its inset at a breakpoint",
    ).toEqual([]);
  });

  it("reads the class it asserted, so a renamed utility fails rather than passes", () => {
    // The control on `classMatching`, which is what stops the assertion
    // above from silently measuring some other element's padding.
    const header = document.createElement("header");
    header.className = "shrink-0 border-b px-4 py-4";
    expect(classMatching(header, /^px-/)).toBe("px-4");
    expect(() => classMatching(header, /^max-w-/)).toThrow();
  });
});

/** The first class on `el` matching `re`, in the order it was written. */
function classMatching(el: Element, re: RegExp): string {
  for (const c of Array.from(el.classList)) if (re.test(c)) return c;
  throw new Error(`no class matching ${re} on <${el.tagName.toLowerCase()}> class="${el.className}"`);
}

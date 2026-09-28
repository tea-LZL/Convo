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

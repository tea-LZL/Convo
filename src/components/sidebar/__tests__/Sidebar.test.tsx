import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, KnowledgeIndexStatus, Session } from "../../../lib/api";
import { usePaletteStore } from "../../../stores/palette";
import { useSessionsStore } from "../../../stores/sessions";
import { useShortcutsStore, comboDisplay } from "../../../stores/shortcuts";
import { Sidebar } from "../Sidebar";

// Spec section 9. NAV is the only ordered list of sections in the app,
// so the rendered order of the nav is asserted as one sequence: five
// independent lookups would pass in any order and catch nothing.
const NAV_ORDER = ["Chat", "Notes", "Memory", "Compare", "Documents", "Tasks"];

const NAV_PATHS: Array<[string, string]> = [
  ["Chat", "/chat"],
  ["Notes", "/notes"],
  ["Memory", "/memory"],
  ["Compare", "/compare"],
  ["Documents", "/documents"],
  ["Tasks", "/tasks"],
];

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

const LIVE_STATUS: KnowledgeIndexStatus = {
  memoryCount: 30,
  noteCount: 12,
  embeddedCount: 42,
  needsEmbedding: 0,
  needsReindex: false,
  embeddingModel: "nomic-embed-text",
  semanticNote: null,
};

/** Degraded: a model is configured, but the index is stale. */
const STALE_STATUS: KnowledgeIndexStatus = {
  ...LIVE_STATUS,
  needsReindex: true,
  semanticNote:
    "The embedding model changed, so existing vectors are not comparable. They will be rebuilt on the next index pass.",
};

interface SidebarOptions {
  /** Report `prefers-reduced-motion: reduce` to the component. */
  reducedMotion?: boolean;
  /** What the memory-index status fetch returns. */
  status?: KnowledgeIndexStatus | "reject";
  isMac?: boolean;
  /** Sessions to show, so the conversations region exists to order. */
  sessions?: Session[];
}

const session = (id: string): Session => ({
  id,
  title: `Chat ${id}`,
  model_id: null,
  provider_id: null,
  group_id: null,
  is_pinned: false,
  is_archived: false,
  created_at: "now",
  updated_at: "now",
});

// The sidebar resolves appInfo on mount, so the first assertions have to
// wait for that state update rather than race it.
async function renderSidebar(collapsed = false, opts: SidebarOptions = {}) {
  vi.spyOn(api, "appInfo").mockResolvedValue({
    version: "0.7.0",
    data_dir: "/tmp",
    db_path: "/tmp/convo.db",
    os: "linux",
    arch: "x86_64",
  });
  vi.spyOn(api, "listSessions").mockResolvedValue(opts.sessions ?? []);
  // The status card is mounted by default. Pin it to a known state so a
  // card appearing or not is this suite's decision, not the Tauri
  // bridge's. A failure path is opt-in via `status: "reject"`.
  if (opts.status === "reject") {
    vi.spyOn(api, "knowledgeIndexStatus").mockRejectedValue(new Error("down"));
  } else {
    vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(opts.status ?? LIVE_STATUS);
  }
  useShortcutsStore.setState({ isMac: opts.isMac ?? false });
  usePaletteStore.setState({ open: false, query: "" });
  vi.mocked(window.matchMedia).mockImplementation((query) => ({
    matches: opts.reducedMotion === true && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  // Deliberately returns nothing: an existing assertion in this file pins
  // that, and rewriting a helper's signature to serve a new test is not
  // worth editing a passing assertion for. The sweep below reads
  // `document.body`, which is where `render` puts it anyway.
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Sidebar collapsed={collapsed} onToggle={() => {}} />
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {});
}

/** Every class token in the subtree, plus every inline style value. */
function everyDeclaration(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    out.push(el.getAttribute("class") ?? "");
    const style = el.getAttribute("style");
    if (style) out.push(style);
  }
  return out;
}

describe("Sidebar nav", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("renders the spec order in the expanded nav", async () => {
    await renderSidebar();
    const nav = within(screen.getByRole("navigation"));
    const names = nav
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");
    expect(names).toEqual(NAV_ORDER);
  });

  it("renders the same order when collapsed to icons", async () => {
    await renderSidebar(true);
    const names = screen
      .getAllByRole("button", { name: new RegExp(`^(${NAV_ORDER.join("|")})$`) })
      .map((el) => el.getAttribute("aria-label") ?? "");
    expect(names).toEqual(NAV_ORDER);
  });

  it("keeps every label bound to the path it had before the reorder", async () => {
    await renderSidebar();
    const nav = within(screen.getByRole("navigation"));
    for (const [label, path] of NAV_PATHS) {
      fireEvent.click(nav.getByRole("button", { name: label }));
      expect(screen.getByTestId("path")).toHaveTextContent(path);
    }
  });
});

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element) {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const aside = () => screen.getByRole("complementary") as HTMLElement;
const navRow = (name: string) =>
  within(screen.getByRole("navigation")).getByRole("button", { name }) as HTMLElement;
// The 64px rail has no <nav>: it is a bare <aside> of icon buttons, each
// wrapped in a tooltip. Reached by the accessible name, which is the only
// thing that identifies a row there, and reached *only* there, so a test
// cannot accidentally read the expanded nav's rows and call it a
// comparison between widths.
const railRow = (name: string) =>
  within(aside()).getByRole("button", { name }) as HTMLElement;

/**
 * The six classes that make a nav row look active or resting.
 *
 * Read as a set so a test can compare two rows without pinning a class
 * name per token — and so the comparison survives a retune of the
 * treatment itself, which is the point: the claim is "the two widths
 * agree", not "the rail is `bg-nav-active` this month". A test that
 * pinned both literals would have passed against a page where both were
 * wrong in the same way.
 */
const navTreatment = (el: Element) =>
  ["bg-nav-active", "text-text", "shadow-nav-glow", "text-text-muted", "hover:bg-surface-2"]
    .filter((c) => Array.from(el.classList).includes(c));
const statusCard = () => screen.queryByRole("region", { name: "Memory index" });

describe("Sidebar nav groups", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("splits the six rows into two groups with an OTHER header between them", async () => {
    await renderSidebar();
    const header = screen.getByText("OTHER");
    // Between, not merely present: three lookups and one "does it exist"
    // would pass with the header above Chat, which is not the grouping.
    expect(precedes(navRow("Memory"), header)).toBe(true);
    expect(precedes(header, navRow("Compare"))).toBe(true);
    // And the group split is the spec's: the first three are the primary
    // sections, the last three are the demoted ones.
    expect(screen.queryAllByText("PRIMARY")).toHaveLength(0);
  });

  it("labels the group header in the group-header token, not a raw colour", async () => {
    await renderSidebar();
    const header = screen.getByText("OTHER");
    expect(header).toHaveClass("text-group-header");
    // Small-caps by CSS, so the string stays a plain word and the
    // rendering is the theme's business.
    expect(header.textContent).toBe("OTHER");
  });
});

describe("Sidebar active row", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("paints the active row with the composited surface and the glow", async () => {
    await renderSidebar();
    const active = navRow("Chat");
    expect(active).toHaveClass("bg-nav-active", "shadow-nav-glow");
    // Inactive rows carry neither, so this cannot pass on a token that is
    // simply applied to the whole nav.
    expect(navRow("Notes")).not.toHaveClass("bg-nav-active");
    expect(navRow("Notes")).not.toHaveClass("shadow-nav-glow");
  });

  it("never animates the glow, whether or not motion is allowed", async () => {
    // The glow marks the active row, which changes on every navigation.
    // An animated bloom would sweep in from the left each time, so this
    // is checked with motion *allowed* — the global reduced-motion rule
    // cannot be leaned on to make it true.
    //
    // A colour transition is allowed and is what the row actually has:
    // `transition-colors` enumerates colour properties, and box-shadow
    // is not one of them, so it cannot move the glow. Anything broader
    // — `transition-all`, `transition-shadow`, an arbitrary value — can,
    // and any `animate-*` would.
    const animates = /(^|[\s:])animate-|(^|[\s:])transition-(all|shadow|transform|opacity|\[)/;
    await renderSidebar(false, { reducedMotion: false });
    const active = navRow("Chat");
    expect(active).toHaveClass("shadow-nav-glow");
    expect(active.className, "the glow must not animate").not.toMatch(animates);
  });

  it("puts the nav rows on the 40px rhythm", async () => {
    await renderSidebar();
    for (const label of NAV_ORDER) {
      expect(navRow(label), `${label} must be a 40px row`).toHaveClass("h-10");
    }
  });

  /**
   * Collapsing changes the width and nothing else.
   *
   * The rail's active row was `bg-accent/15 text-accent` — the old
   * treatment, on a 32px box with no glow — while the expanded row used
   * `bg-nav-active text-text shadow-nav-glow`. So the one control whose
   * entire purpose is comparing widths changed the current row's colour
   * when you used it, which is the opposite of what it is for.
   */
  it("paints the rail's active row the way the expanded nav does", async () => {
    // One render at a time, and the readings copied out before the next:
    // two sidebars in the document at once would make every lookup below
    // ambiguous, and the second render would find the first.
    await renderSidebar(false);
    const wide = { active: navTreatment(navRow("Chat")), resting: navTreatment(navRow("Notes")) };
    cleanup();

    await renderSidebar(true);
    const rail = { active: navTreatment(railRow("Chat")), resting: navTreatment(railRow("Notes")) };

    expect(rail.active, "the rail's active row must match the expanded one").toEqual(wide.active);
    expect(rail.resting, "and so must its resting row").toEqual(wide.resting);

    // …and the pairs are not the same pair, which is what makes the
    // comparison above a comparison. Without this, a nav where every row
    // carried the active treatment would satisfy it.
    expect(wide.resting).not.toEqual(wide.active);
    expect(rail.resting).not.toEqual(rail.active);
    expect(wide.active).toContain("bg-nav-active");
    expect(wide.active).toContain("shadow-nav-glow");
    // The old treatment is gone from both, named explicitly because it is
    // the exact thing that was wrong and it is a `bg-accent/15` away from
    // looking deliberate.
    expect(railRow("Chat").className).not.toMatch(/bg-accent\/15/);
    expect(railRow("Chat").className).not.toMatch(/\btext-accent\b/);
  });

  it("never animates the rail's glow either, because a 32px box moves less of it", async () => {
    // The same rule as the expanded nav, asserted on the rail rather than
    // assumed to follow: the glow marks the current row, which changes on
    // every navigation, so an animated bloom would sweep in on a control
    // with no label beside it to read as it moves.
    const animates = /(^|[\s:])animate-|(^|[\s:])transition-(all|shadow|transform|opacity|\[)/;
    await renderSidebar(true, { reducedMotion: false });
    const active = railRow("Chat");
    expect(active).toHaveClass("shadow-nav-glow");
    expect(active.className, "the rail's glow must not animate").not.toMatch(animates);
  });

  /**
   * The current page, announced at both widths.
   *
   * `aria-current` was on the expanded nav only. Collapsing the sidebar
   * therefore removed a piece of *state* rather than a piece of chrome: a
   * screen-reader user who collapsed it to make room lost the
   * "current page" announcement, and nothing about the control says that
   * is what collapsing does.
   */
  it("announces the current page on the rail as well as on the expanded nav", async () => {
    // Every row, not just the active one: a nav where all six claimed to
    // be the current page would satisfy a one-row assertion, and so would
    // one where the attribute had been dropped from the rail entirely and
    // the other five happened to be `undefined` too.
    const expected: Record<string, string | null> = Object.fromEntries(
      NAV_ORDER.map((label) => [label, label === "Chat" ? "page" : null]),
    );
    await renderSidebar(false);
    for (const label of NAV_ORDER) {
      expect(navRow(label).getAttribute("aria-current"), `${label} on the expanded nav`)
        .toBe(expected[label]);
    }
    // The state sits on the same control as the name, and both are
    // there: a row with `aria-current` and no accessible name announces
    // "current page" and nothing else.
    cleanup();

    await renderSidebar(true);
    for (const label of NAV_ORDER) {
      expect(railRow(label).getAttribute("aria-current"), `${label} on the rail`)
        .toBe(expected[label]);
    }
    const active = railRow("Chat");
    expect(active).toHaveAccessibleName("Chat");
    expect(active.tagName).toBe("BUTTON");
  });
});

describe("prefers-reduced-motion", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("puts no transition or animation class on any nav row", async () => {
    await renderSidebar(false, { reducedMotion: true });
    const rows = within(screen.getByRole("navigation")).getAllByRole("button");
    expect(rows).toHaveLength(NAV_ORDER.length);
    for (const row of rows) {
      expect(row.className, `${row.textContent} must not animate under reduced motion`)
        .not.toMatch(/(^|[\s:])((transition|animate|duration|ease)-[\w-]+)/);
    }
  });

  it("keeps the transitions when motion is allowed, so the flag is what changed", async () => {
    // Without this the test above would also pass on a nav that never
    // animated — which would prove nothing about the flag.
    await renderSidebar(false, { reducedMotion: false });
    const rows = within(screen.getByRole("navigation")).getAllByRole("button");
    expect(rows.some((r) => /transition-colors/.test(r.className))).toBe(true);
  });

  it("reaches the collapsed rail too, so the guarantee does not depend on the width", async () => {
    await renderSidebar(true, { reducedMotion: true });
    for (const label of NAV_ORDER) {
      const row = screen.getByRole("button", { name: label });
      expect(row.className, `rail row ${label} must not animate`).not.toMatch(
        /(^|[\s:])((transition|animate|duration|ease)-[\w-]+)/,
      );
    }
  });
});

/**
 * Every control in the sidebar, by its computed accessible name.
 *
 * The plan's a11y pass asks for a reachable name on every interactive
 * element, and the four surfaces it names — the nav rows, the search row,
 * the status card's chips, the per-session pin and archive — are all
 * here. A source scan cannot answer this question: a control's name comes
 * from its own text, from a `title`, from an `aria-label`, or from a
 * `<label>` wrapped around it, and only the DOM knows which. So this is a
 * rendered sweep over the real accessibility computation, which is also
 * why it is a *sweep* and not four lookups: four lookups each pass for
 * the control they name, and the finding this pass is guarding against is
 * a control nobody thought to look up.
 */
const INTERACTIVE = [
  "a[href]", "button", "input", "select", "textarea",
  "[role='switch']", "[role='tab']", "[role='menuitem']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * A control is named if any of `aria-label`, `aria-labelledby`, its own
 * text, or a `title` says something.
 *
 * The `title` is the weak one and it is deliberately **not** enough on its
 * own for a control with no text of its own. `title` is last in the
 * accessible-name computation, screen readers announce it inconsistently,
 * and it is not a name at all on a touch device — so accepting it would
 * let an icon button pass on the strength of the tooltip the same control
 * shows on hover. An icon-only control has to carry an `aria-label`.
 * That distinction is not theoretical: dropping the `aria-label` from the
 * Memory page's enable control left its `title` behind, and a sweep that
 * accepted `title` stayed green.
 *
 * `aria-labelledby` is not resolved: the id could point at anything, and a
 * name that exists but is spelled wrong is a different defect from a
 * missing one, which the per-surface tests cover by querying the name they
 * expect.
 */
function withoutNames(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE))) {
    // An `aria-hidden` subtree is not in the accessibility tree, so it is
    // not a control anyone reaches.
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby")) continue;
    if ((el.textContent ?? "").trim()) continue;
    if (!el.getAttribute("title")?.trim()) {
      out.push(`<${el.tagName.toLowerCase()}> class="${el.getAttribute("class") ?? ""}"`);
    } else {
      out.push(
        `<${el.tagName.toLowerCase()}> has only a title: class="${el.getAttribute("class") ?? ""}"`,
      );
    }
  }
  return out;
}

describe("Sidebar accessible names", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: [session("s1"), session("s2")],
      activeId: "s1",
      loading: false,
      error: null,
    });
  });

  it("names every control, with sessions present and the status card live", async () => {
    await renderSidebar(false, { sessions: [session("s1"), session("s2")] });
    const container = document.body;
    // Not a count the sweep is trusted to produce: a floor, so that a
    // harness that rendered an empty sidebar would not pass it.
    expect(container.querySelectorAll(INTERACTIVE).length).toBeGreaterThan(12);
    expect(withoutNames(container)).toEqual([]);
  });

  it("names every control on the collapsed rail, where the labels are gone", async () => {
    // The rail is the harder half: the visible text is replaced by an
    // icon, so a name that came from the text no longer exists and the
    // `aria-label` is the only thing left. If one of these is missing it
    // is six controls named "button".
    await renderSidebar(true, { sessions: [session("s1"), session("s2")] });
    const container = document.body;
    expect(container.querySelectorAll(INTERACTIVE).length).toBeGreaterThan(6);
    expect(withoutNames(container)).toEqual([]);
  });
});

describe("Sidebar search row", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("opens the existing command palette rather than a new search", async () => {
    await renderSidebar();
    const row = screen.getByRole("button", { name: /search/i });
    expect(usePaletteStore.getState().open).toBe(false);
    fireEvent.click(row);
    // The palette store, not a search input: this row is a shortcut to
    // something that already exists.
    expect(usePaletteStore.getState().open).toBe(true);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("derives the hint from comboDisplay, so Linux does not read Cmd K", async () => {
    await renderSidebar(false, { isMac: false });
    const hint = screen.getByRole("button", { name: /search/i }).querySelector("kbd")!;
    expect(hint.textContent).toBe(comboDisplay("ctrl+k", false));
    expect(hint.textContent).toBe("Ctrl+K");
    expect(hint.textContent).not.toContain("⌘");
  });

  it("reads the mac form on mac, from the same helper", async () => {
    await renderSidebar(false, { isMac: true });
    const hint = screen.getByRole("button", { name: /search/i }).querySelector("kbd")!;
    expect(hint.textContent).toBe(comboDisplay("ctrl+k", true));
    expect(hint.textContent).toBe("⌘K");
  });
});

describe("Sidebar regions", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("orders header, search, nav, conversations, status top to bottom", async () => {
    await renderSidebar(false, { sessions: [session("a")] });
    const wordmark = screen.getByText("Convo");
    const search = screen.getByRole("button", { name: /search/i });
    const nav = screen.getByRole("navigation");
    const scroll = aside().querySelector<HTMLElement>(".overflow-y-auto")!;
    const card = statusCard()!;

    expect(card, "the status card must render when the fetch succeeds").not.toBeNull();
    const order = [wordmark, search, nav, scroll, card];
    for (let i = 1; i < order.length; i += 1) {
      expect(precedes(order[i - 1], order[i]), `${order[i - 1].tagName} must precede ${order[i].tagName}`)
        .toBe(true);
    }
  });

  it("pins the status card below the scroll region so it cannot scroll away", async () => {
    await renderSidebar(false, { sessions: [session("a"), session("b")] });
    const card = statusCard();
    // Non-vacuous: without this the walk below would pass on `card` being
    // null, which is the state before StatusCard exists at all.
    expect(card, "the status card must render when the fetch succeeds").not.toBeNull();
    // The card is outside every scroll container in the sidebar. Inside
    // one, a long conversation list would push the index state out of
    // sight, which is the entire reason it is pinned.
    let node: HTMLElement | null = card;
    while (node && node !== document.body) {
      expect(node.className, "the status card must not live inside a scroll region")
        .not.toMatch(/overflow-y-auto/);
      node = node.parentElement;
    }
  });

  /**
   * The eight regions, walked by what each one *is*.
   *
   * The file header used to say "Five regions ... header, search, nav,
   * conversations, status" and then say "and the order is the point".
   * That combination is the failure: a comment written by someone who
   * counted is checked for its count rather than its code, and the count
   * was wrong — the new-chat button, the tools block and the footer are
   * three more, and status is sixth rather than fifth.
   *
   * So the count is asserted, and it is asserted *positionally*: each
   * region is found by its own content rather than by the tag it happens
   * to use, and the order of those finds is the order of the regions. A
   * tag-based walk would have passed the old five-region list, because
   * all five really were in order — it is the three that were missing
   * that a positional walk over all eight catches.
   */
  it("has the eight regions the file header names, in the order it names them", async () => {
    await renderSidebar(false, { sessions: [session("a")] });

    // Each entry names a region and how to recognise it, so a region
    // that moved cannot satisfy the walk by being present somewhere.
    const regions: [string, () => Element][] = [
      ["header", () => screen.getByText("Convo")],
      ["search", () => screen.getByRole("button", { name: /search/i })],
      ["nav", () => screen.getByRole("navigation")],
      ["new chat", () => screen.getByRole("button", { name: /^new chat$/i })],
      ["conversations", () => aside().querySelector<HTMLElement>(".overflow-y-auto")!],
      ["status", () => statusCard()!],
      ["tools", () => screen.getByText("Tools")],
      ["footer", () => screen.getByRole("button", { name: "About" })],
    ];
    // Eight, because that is what the header says. The count is the
    // claim; a test that walked "the regions" without a number would go
    // quietly stale the moment a ninth was added.
    expect(regions).toHaveLength(8);

    const found = regions.map(([, find]) => find());
    // Non-vacuity, before anything is compared: every region resolved to
    // a real element, so the order walk below is not comparing nulls.
    for (const [name, el] of regions.map(([n], i) => [n, found[i]] as const)) {
      expect(el, `the ${name} region must exist`).toBeTruthy();
    }
    // …and they are eight *different* elements. Two lookups that matched
    // the same node would satisfy an order walk for free, and "the new
    // chat button and the footer button are both buttons" is exactly the
    // kind of mistake a by-content lookup can make.
    expect(new Set(found).size, "the eight regions must be eight distinct elements").toBe(8);
    for (let i = 1; i < found.length; i++) {
      expect(
        precedes(found[i - 1], found[i]),
        `region ${i + 1} (${regions[i][0]}) must come after region ${i} (${regions[i - 1][0]})`,
      ).toBe(true);
    }
    // …and the status card is the *sixth*, not the fifth: the old list
    // stopped counting at five and was wrong about which one status was.
    expect(regions.findIndex(([name]) => name === "status")).toBe(5);
  });

  it("finds a region that moved, so the order walk is not vacuous", () => {
    // The control. An assertion that eight regions are in order is
    // equally consistent with a walk that compared nothing, so the same
    // `precedes` is run over a fixture with two of them swapped — and
    // the fixture is *attached*, because `compareDocumentPosition` on
    // two detached nodes reports DISCONNECTED and every comparison would
    // be false: a control that passes for the wrong reason is worse than
    // no control.
    const root = document.createElement("div");
    const a = document.createElement("div");
    a.textContent = "header";
    const b = document.createElement("div");
    b.textContent = "status";
    root.append(a, b);
    document.body.append(root);
    try {
      expect(precedes(a, b)).toBe(true);
      expect(precedes(b, a)).toBe(false);
      // …and moving the second one above the first flips both, which is
      // the whole content of the order claim.
      root.insertBefore(b, a);
      expect(precedes(b, a)).toBe(true);
      expect(precedes(a, b)).toBe(false);
    } finally {
      root.remove();
    }
  });

  it("keeps the sidebar at w-60 and the rail at 64px", async () => {
    await renderSidebar();
    expect(aside()).toHaveClass("w-60");
    // w-60 is 240px. Pinned because the whole truncation contract in
    // StatusCard.test.tsx is stated against that number, and because the
    // brief rules the width out of scope.
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    expect(Number.parseFloat(String(15 * rem))).toBeCloseTo(240, 0);
  });
});

describe("Sidebar survives a failed status fetch", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders the whole sidebar with no status card and does not throw", async () => {
    await expect(renderSidebar(false, { status: "reject" })).resolves.toBeUndefined();
    // Non-vacuous: the card is absent because the fetch was attempted
    // and rejected, not because no card was ever mounted.
    expect(api.knowledgeIndexStatus, "the status fetch must actually be attempted").toHaveBeenCalled();
    expect(statusCard(), "a failed fetch must leave no card").not.toBeInTheDocument();
    // The sidebar is still a sidebar: nav intact, wordmark intact, and
    // the nav still navigates. A status card must never be the reason a
    // sidebar fails.
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getAllByRole("button")).toHaveLength(NAV_ORDER.length);
    expect(screen.getByText("Convo")).toBeInTheDocument();
    fireEvent.click(nav.getByRole("button", { name: "Memory" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/memory");
  });
});

describe("Sidebar vocabulary", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
  });

  it("hardcodes no colour in any class or inline style", async () => {
    await renderSidebar(false, { sessions: [session("a")] });
    for (const declaration of everyDeclaration(aside())) {
      expect(declaration).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
    }
  });

  it("adds no view-switcher pill, because there is no view toggle here", async () => {
    await renderSidebar(false, { sessions: [session("a")] });
    // The reference design carries a "View:" pill. It appears only where
    // a real toggle switches something; the sidebar has none, so a
    // dropdown that switches nothing would be worse than nothing.
    expect(aside().textContent).not.toMatch(/view/i);
    // And no `listbox`, `menu` or extra combobox was introduced to carry it.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    await renderSidebar(false, { sessions: [session("a")] });
    expect((await axe(aside())).violations).toHaveLength(0);
  });
});

/**
 * The 64px rail's memory status, mounted in the rail rather than tested
 * in isolation.
 *
 * The reason this exists at all: collapsing the sidebar used to remove
 * the app's *only* signal that recall is degraded, and a user on a narrow
 * window is the user most likely to be looking at the rail. A 6px dot at
 * the bottom puts it back, and it takes the same token and the same words
 * the card would have — so the two surfaces cannot drift into disagreeing
 * about the same fetch.
 */
describe("the collapsed rail keeps a memory status", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const paint = () => screen.getByRole("img").querySelector("[aria-hidden]")!;
  const tokenOf = (el: Element) =>
    el.className.match(/(?:^|\s)(?:bg|text)-(success|warn|text-subtle)\b/)?.[1];

  it("dots the rail when the status is degraded, and names the state", async () => {
    await renderSidebar(true, { status: STALE_STATUS });
    const dot = screen.getByRole("img");
    expect(tokenOf(paint()), "a stale index must read as warn").toBe("warn");
    // The same words the card would have shown, so the state is available
    // to someone who cannot separate the colours.
    expect(dot).toHaveAccessibleName();
    expect(dot.getAttribute("aria-label")).toContain("needs reindex");
  });

  it("paints the same token the card would, from the same payload", async () => {
    // The dot and the card render from one derivation, so this is not a
    // coincidence worth asserting — it is the property that stops them
    // from drifting. Compared token-to-token rather than as class
    // strings: the chip is a tinted fill and the dot is the solid token.
    await renderSidebar(true, { status: STALE_STATUS });
    const dotToken = tokenOf(paint());
    cleanup();
    await renderSidebar(false, { status: STALE_STATUS });
    const cardEl = await screen.findByRole("region", { name: "Memory index" });
    const chipEl = within(cardEl).getByText("needs reindex");
    expect(tokenOf(chipEl), "chip and dot must resolve the same colour token").toBe(dotToken);
  });

  it("shows a live index as live, so the dot is not always an alarm", async () => {
    await renderSidebar(true, { status: LIVE_STATUS });
    expect(tokenOf(paint())).toBe("success");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("live");
  });

  it("sits at the bottom of the rail and widens nothing", async () => {
    await renderSidebar(true, { status: STALE_STATUS });
    // Still 64px, and the dot is its last child — below Settings, where a
    // status indicator belongs, not up among the section icons where it
    // would read as a seventh destination.
    expect(aside()).toHaveClass("w-12");
    const dot = screen.getByRole("img");
    expect(dot.parentElement!.parentElement!.parentElement).toBe(aside());
    // 6px of paint, and no width of its own to negotiate.
    expect(paint()).toHaveClass("w-1.5", "h-1.5");
  });

  it("leaves no dot behind when the fetch fails, and the rail still works", async () => {
    await renderSidebar(true, { status: "reject" });
    expect(api.knowledgeIndexStatus, "the status fetch must actually be attempted").toHaveBeenCalled();
    expect(screen.queryByRole("img"), "a failed fetch must leave no dot").not.toBeInTheDocument();
    // The rail is still a rail: six icons, a New chat, an expander, and
    // navigation that works.
    for (const label of NAV_ORDER) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/memory");
  });

  it("queries the index once per sidebar, whichever branch is mounted", async () => {
    // The card and the dot are in mutually exclusive branches, so this
    // must not become two round-trips to the backend. Both halves matter:
    // testing only the collapsed side would pass even if someone added a
    // `StatusDot` to the expanded tree, because the count would still be
    // 1 — from the card, with the dot's own query invisible.
    await renderSidebar(true, { status: STALE_STATUS });
    expect(screen.getByRole("img"), "the collapsed branch shows the dot").toBeInTheDocument();
    expect(api.knowledgeIndexStatus).toHaveBeenCalledTimes(1);
    cleanup();

    await renderSidebar(false, { status: STALE_STATUS });
    expect(statusCard(), "the expanded branch shows the card").not.toBeNull();
    expect(screen.queryByRole("img"), "and not the dot").not.toBeInTheDocument();
    expect(api.knowledgeIndexStatus, "one query in the expanded branch too").toHaveBeenCalledTimes(1);
  });
});

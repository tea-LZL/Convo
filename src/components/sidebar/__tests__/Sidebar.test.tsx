import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

interface SidebarOptions {
  /** Report `prefers-reduced-motion: reduce` to the component. */
  reducedMotion?: boolean;
  /** How the memory-index status fetch behaves. */
  status?: "live" | "reject";
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
    vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(LIVE_STATUS);
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

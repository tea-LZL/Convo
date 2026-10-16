import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRoute } from "../MemoryRoute";
import repoTailwind from "../../../tailwind.config";

/* ═══════════════════════════════════════════════════════════════════════
 * Measuring the page, not spelling it.
 *
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question this page's design
 * turns on: *how much air is between two rows?* The tempting substitute
 * is `expect(list.className).toContain("space-y-1")`, and it is the wrong
 * test twice over. It pins a class name, which is an implementation
 * detail — Task 5 and Task 6 will restyle the pages that share the
 * standard rhythm and this string will change for no reason. And it
 * passes for any page that merely *says* `space-y-1`, including one that
 * got denser using something else.
 *
 * So the numbers below come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that
 * comes out. A compact row is compact by four pixels whether it says
 * `space-y-1`, `space-y-0.5`, or something a later task invents; a class
 * that does not exist emits no rule at all, which is a loud failure here
 * rather than a silent zero.
 *
 * The limit, stated rather than hidden: this is the *stylesheet* the
 * build produces, not a browser's layout. It knows how wide a row is
 * declared to be; it does not know how tall a paragraph wrapped to three
 * lines. Every claim below is therefore about declared spacing, and the
 * one place a real measurement would be needed says so in place.
 * ═══════════════════════════════════════════════════════════════════════ */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** The declarations one utility class emits, keyed by CSS property. */
const cache = new Map<string, Map<string, string>>();

const unescapeSelector = (s: string) => s.replace(/\\(.)/g, "$1");

/**
 * The part of a compiled stylesheet that is unconditional.
 *
 * Tailwind emits screen variants after the plain utilities, so
 * everything from the first `@media` on only applies at or above a
 * breakpoint. Skipping that half is not a shortcut: a `sm:w-[900px]`
 * cannot squeeze a narrow window, and a `sm:` colour is not the one a row
 * is painted with on one. A variant-scoped declaration is genuinely not
 * a floor at the width this page is being asked about.
 */
const unconditional = (css: string) => {
  const at = css.indexOf("@media");
  return at < 0 ? css : css.slice(0, at);
};

/** Index a compiled stylesheet by the class each rule styles. */
function indexRules(css: string): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  for (const m of unconditional(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // `.space-y-1 > :not([hidden]) ~ :not([hidden])` styles `.space-y-1`.
    const head = unescapeSelector(m[1].trim().split(/\s+/)[0]);
    if (!head.startsWith(".")) continue;
    const name = head.slice(1);
    if (byClass.has(name)) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].split(";")) {
      const colon = d.indexOf(":");
      if (colon < 0) continue;
      const prop = d.slice(0, colon).trim();
      // Custom properties are machinery (`--tw-space-y-reverse: 0`), not
      // geometry, and reading one as a length would be nonsense.
      if (!prop || prop.startsWith("--")) continue;
      decls.set(prop, d.slice(colon + 1).trim());
    }
    byClass.set(name, decls);
  }
  return byClass;
}

/** Compile `classNames` through the project Tailwind, once. */
async function compileOnce(classNames: string[]): Promise<string> {
  // `tailwindcss` bundles its own copy of postcss, so its plugin type is
  // not nominally the `postcss` this repo depends on — two installs of
  // one library, and the compiler is only ever handed this array here.
  const plugins = [
    tailwindcss({
      ...(repoTailwind as object),
      content: [{ raw: classNames.map((c) => `<i class="${c}"></i>`).join("\n"), extension: "html" }],
      corePlugins: { preflight: false },
    }),
  ] as never;
  const result = await postcss(plugins).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

/** Compile `classNames` through the project Tailwind, once, and memoise. */
async function emitted(classNames: string[]): Promise<Map<string, Map<string, string>>> {
  const wanted = [...new Set(classNames)];
  const missing = wanted.filter((c) => !cache.has(c));
  if (missing.length) {
    const byClass = indexRules(await compileOnce(missing));
    for (const c of missing) cache.set(c, byClass.get(c) ?? new Map());
  }
  const out = new Map<string, Map<string, string>>();
  for (const c of wanted) out.set(c, cache.get(c)!);
  return out;
}

/**
 * The first absolute length in a declaration, in CSS pixels.
 *
 * A `var()` or a percentage has no absolute length, and returning a
 * number for one of those would be the exact lie this whole block
 * exists to avoid — so it throws, and the caller has to say what it is
 * actually measuring.
 */
function toPx(value: string | undefined, context: string): number {
  const m = String(value ?? "").match(/(-?[\d.]+)\s*(px|rem|em)\b/);
  if (!m) throw new Error(`${context} has no absolute length to measure: "${value}"`);
  const n = Number(m[1]);
  return m[2] === "px" ? n : n * 16;
}

/** The raw declaration text, for values that are a variable by design. */
function declValue(decls: Map<string, string>, prop: string, context: string): string {
  const v = decls.get(prop);
  if (v === undefined) throw new Error(`${context} emits no ${prop}; the class does not exist`);
  return v;
}

/** The first class on `el` matching `re`, in the order it was written. */
function classMatching(el: Element, re: RegExp): string {
  for (const c of el.classList) if (re.test(c)) return c;
  throw new Error(
    `no class matching ${re} on <${el.tagName.toLowerCase()}> class="${el.className}"`,
  );
}

/** The pixels `el`'s class matching `re` declares for one property. */
async function pxOn(el: Element, re: RegExp, prop: string): Promise<number> {
  const cls = classMatching(el, re);
  const decls = (await emitted([cls])).get(cls)!;
  return toPx(declValue(decls, prop, cls), `${cls} { ${prop} }`);
}

/** Everything `root`'s classes declare, class-first, for a full sweep. */
async function sweep(root: HTMLElement): Promise<Map<string, Map<string, string>>> {
  const classes: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const c of el.classList) classes.push(c);
  }
  return emitted(classes);
}

/** Where a class's rule sits in the stylesheet, for cascade-order claims. */
async function ruleOrder(classNames: string[]): Promise<Map<string, number>> {
  const css = await compileOnce([...new Set(classNames)]);
  const order = new Map<string, number>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = unescapeSelector(m[1].trim().split(/\s+/)[0]);
    if (!head.startsWith(".")) continue;
    const name = head.slice(1);
    if (!order.has(name)) order.set(name, m.index);
  }
  return order;
}

/**
 * A rule whose selector *contains* a class, rather than a rule a class
 * is the subject of.
 *
 * `indexRules` above is deliberately strict — it keys on the class being
 * the whole first token — because that is right for a plain utility. An
 * arbitrary variant emits `.cls > button` or `.cls [data-actions]`, and
 * those rules say something a strict index cannot reach: *what else* the
 * rule applies to, which is the load-bearing half of an override. Both
 * forms are returned, because the raw one is what specificity has to be
 * counted on (an escaped `\[` inside a class name is not an attribute
 * selector) and the readable one is what a failure message wants.
 */
const variantRules = new Map<string, { raw: string; selector: string; decls: Map<string, string> }>();

async function variantRule(cls: string) {
  const hit = variantRules.get(cls);
  if (hit) return hit;
  const css = await compileOnce([cls]);
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const raw = m[1].trim();
    if (!unescapeSelector(raw).includes(cls)) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].split(";")) {
      const colon = d.indexOf(":");
      if (colon < 0) continue;
      const prop = d.slice(0, colon).trim();
      if (!prop || prop.startsWith("--")) continue;
      decls.set(prop, d.slice(colon + 1).trim());
    }
    const found = { raw, selector: unescapeSelector(raw), decls };
    variantRules.set(cls, found);
    return found;
  }
  throw new Error(`no rule anywhere in the stylesheet matches ${cls}`);
}

/** The pixels the first class on `el` that declares `prop` resolves to. */
async function pxDeclaring(el: Element, prop: string): Promise<number> {
  for (const c of Array.from(el.classList)) {
    const decls = (await emitted([c])).get(c)!;
    const v = decls.get(prop);
    if (v !== undefined) return toPx(v, `${c} { ${prop} }`);
  }
  throw new Error(`no class on <${el.tagName.toLowerCase()}> declares ${prop}`);
}

/**
 * The widest absolute width anything inside `root` can force the pane to
 * be: the largest `width` or `min-width` it declares in px or rem.
 *
 * Percentages are skipped on purpose — `w-full` asks for the pane, which
 * is exactly the right answer and no floor at all. So is `max-width`,
 * which bounds a measure on a wide window and can never squeeze a narrow
 * one; that half of the story is asserted separately.
 */
async function intrinsicFloor(root: HTMLElement): Promise<number> {
  let widest = 0;
  for (const [cls, decls] of await sweep(root)) {
    for (const prop of ["min-width", "width"]) {
      const v = decls.get(prop);
      if (v && /^-?[\d.]+(px|rem|em)\b/.test(v)) {
        widest = Math.max(widest, toPx(v, `${cls} { ${prop} }`));
      }
    }
  }
  return widest;
}

/** Every class name and inline style under `root`, as one string each. */
function declarationsIn(root: HTMLElement): { classes: string[]; styles: string[] } {
  const classes: string[] = [];
  const styles: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    classes.push(...Array.from(el.classList));
    const inline = el.getAttribute("style");
    if (inline) styles.push(inline);
  }
  return { classes, styles };
}

/** A vertical rhythm, measured: the gap between rows and the padding in one. */
interface Rhythm { gap: number; pad: number }

/** The air one row costs beyond its own content: padding above and below, plus its gap. */
const airOf = (r: Rhythm) => r.pad * 2 + r.gap;

/** Rows of `content` px of text that fit in `height` px at a given rhythm. */
const rowsThatFit = (r: Rhythm, content: number, height: number) =>
  Math.floor((height + r.gap) / (content + airOf(r)));

const sessions = Array.from({ length: 25 }, (_, index) => ({
  id: `session-${index}`,
  title: index === 24 ? "New Chat" : `Session ${index}`,
  snippet: `Preview ${index}`,
  messageCount: index + 1,
}));

describe("MemoryRoute", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "list_extractable_sessions") return sessions;
      return null;
    });
  });

  it("loads every persisted session with messages when Extract from chat opens", async () => {
    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));

    expect(await screen.findByText("New Chat")).toBeInTheDocument();
    expect(screen.getByText("25 messages · Preview 24")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_extractable_sessions");
    expect(invoke).not.toHaveBeenCalledWith("list_sessions", expect.anything());
  });

  it("shows loading before an empty result", async () => {
    let resolveSessions!: (value: unknown[]) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([]);
      if (command === "list_note_titles") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "list_extractable_sessions") {
        return new Promise((resolve) => { resolveSessions = resolve; });
      }
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();

    await act(async () => resolveSessions([]));
    await waitFor(() => expect(screen.getByText(/No sessions available/)).toBeInTheDocument());
  });

  it("restores review states and retries failures", async () => {
    const reviews = [
      { id: "pending", sessionId: "session-1", facts: [{ kind: "user_pref", title: null, content: "Fact", tags: null }], status: "pending", error: null, createdAt: "now" },
      { id: "failed", sessionId: "session-2", facts: [], status: "failed", error: "offline", createdAt: "now" },
      { id: "extracting", sessionId: "session-3", facts: [], status: "extracting", error: null, createdAt: "now" },
      { id: "reviewed", sessionId: "session-4", facts: [], status: "reviewed", error: null, createdAt: "now" },
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return reviews;
      if (command === "retry_memory_review") return "session-2";
      if (command === "extract_facts_from_session") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Pending (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extracting · Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pending (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mark_memory_review_reviewed", { id: "pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed · Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("retry_memory_review", { id: "failed" }));
    expect(invoke).toHaveBeenCalledWith("finish_memory_review", { id: "failed", facts: [] });
  });
});

// The pin is the only way back to the always-on set: since context assembly
// moved into Rust, an unpinned memory reaches the model only when retrieval
// ranks it. Nothing calling set_memory_pinned is the same dead command as
// `fill_index` — the tier exists in the schema and is unreachable from the UI.
describe("MemoryRoute pinning", () => {
  const memory = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: "user_pref",
    title: `Pref ${id}`,
    content: "Concise replies",
    tags: null,
    is_enabled: true,
    created_at: "now",
    updated_at: "now",
    pinned: false,
    ...overrides,
  });

  /**
   * Every control on the page, by its computed accessible name.
   *
   * The same sweep as the sidebar's, and the same reason: the recall
   * panel's search field and the four row controls beside it are the ones
   * with no visible text of their own, so they are exactly the ones a
   * per-control assertion forgets. Rendered rather than scanned, because
   * only the DOM knows that a `<label>` wrapped round a checkbox is its
   * name.
   */
  it("names every control, so none of them is announced as 'button'", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [memory("m-1"), memory("m-2")];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );
    const recall = await screen.findByRole("textbox", { name: "Search memory" });
    expect(recall, "the recall panel's input must be reachable by name").toBeInTheDocument();

    const container = document.body;
    const INTERACTIVE = [
      "a[href]", "button", "input", "select", "textarea",
      "[role='switch']", "[role='tab']", "[role='menuitem']",
      "[tabindex]:not([tabindex='-1'])",
    ].join(", ");
    const controls = Array.from(container.querySelectorAll<HTMLElement>(INTERACTIVE))
      .filter((el) => !el.closest('[aria-hidden="true"]'));
    expect(controls.length, "the sweep must have controls to look at").toBeGreaterThan(8);

    // `aria-label`, `aria-labelledby` or the control's own text. A `title`
    // is not accepted on its own: it is last in the name computation, it
    // is announced inconsistently, and it is not a name on a touch device.
    // The sidebar's sweep has the same rule and the same reason.
    const unnamed = controls.filter(
      (el) =>
        !el.getAttribute("aria-label")?.trim() &&
        !el.getAttribute("aria-labelledby") &&
        !(el.textContent ?? "").trim(),
    );
    expect(
      unnamed.map((el) => `<${el.tagName.toLowerCase()}> ${el.getAttribute("class")?.slice(0, 50) ?? ""}`),
    ).toEqual([]);
  });

  it("pins through set_memory_pinned and says so, separately from enabling", async () => {
    let pinned = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_memory") return [memory("m-1", { pinned })];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "set_memory_pinned") pinned = (args as { pinned: boolean }).pinned;
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    // Two controls, and the labels must not read alike. "Enabled" is
    // eligibility for recall; "pinned" is injection regardless of recall.
    const pin = await screen.findByRole("button", { name: /Pin Pref m-1 — always include it in every chat/ });
    const disable = screen.getByRole("button", { name: /Disable Pref m-1 — stop it being eligible for recall/ });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("title", expect.stringContaining("only when recall ranks it"));
    expect(disable).toHaveAttribute(
      "title",
      expect.stringContaining("a disabled memory is not injected even when pinned"),
    );

    fireEvent.click(pin);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_memory_pinned", { id: "m-1", pinned: true }));

    // The row says it is pinned, without a hover.
    const unpin = await screen.findByRole("button", { name: /Unpin Pref m-1/ });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("pinned")).toHaveAttribute(
      "title",
      expect.stringContaining("always included in every chat"),
    );

    // Enabling is a separate command, and the enable control is untouched.
    expect(invoke).not.toHaveBeenCalledWith("toggle_memory", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /Disable Pref m-1/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("toggle_memory", { id: "m-1", enabled: false }));
  });

  // The agreement, rendered, for the control that had no state to agree
  // with. Every other aria assertion in this plan checked a value; this one
  // checks that four channels describe the same thing, and it is here
  // rather than in `stateAgreement.test.tsx` because a source scan cannot
  // see a rendering. Two of the four are the announcement a screen reader
  // gets — the name and `aria-pressed` — and two are not, which is what
  // makes it an agreement test: the `title` is prose written separately,
  // and the row's own `opacity-50` is the page's visual channel. If any
  // one of the four drifted, the assertion would fail on the drift rather
  // than on a hard-coded expectation.
  it("announces the enable state, and it agrees with the name, the title and the row", async () => {
    let enabled = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_memory") return [memory("m-1", { is_enabled: enabled })];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "toggle_memory") enabled = (args as { enabled: boolean }).enabled;
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const read = () => {
      const control = screen.getByRole("button", { name: /^Disable Pref m-1|^Enable Pref m-1/ });
      const row = control.closest("li")!;
      return {
        name: control.getAttribute("aria-label")!.split(" — ")[0],
        announced: control.getAttribute("aria-pressed"),
        // An independently written sentence about the same state. It does
        // not share an expression with the name, which is the point: two
        // channels that can only be wrong together if a person wrote them
        // wrong.
        title: control.getAttribute("title")!.split(":")[0],
        // The page's own visual channel for the same state.
        dimmed: row.className.includes("opacity-50"),
      };
    };

    // Enabled: the control offers "Disable" because it is enabled, says so,
    // writes "Enabled" in the tooltip, and the row is not dimmed.
    await waitFor(() => expect(read().name).toBe("Disable Pref m-1"));
    expect(read()).toEqual({
      name: "Disable Pref m-1",
      announced: "true",
      title: "Enabled",
      dimmed: false,
    });

    fireEvent.click(screen.getByRole("button", { name: /Disable Pref m-1/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("toggle_memory", { id: "m-1", enabled: false }));

    // Disabled: all four move together, and the label's polarity is the
    // one the pin above it uses — the name is the next action, so "Enable"
    // is offered precisely because the state is off.
    await waitFor(() => expect(read().name).toBe("Enable Pref m-1"));
    expect(read()).toEqual({
      name: "Enable Pref m-1",
      announced: "false",
      title: "Disabled",
      dimmed: true,
    });
  });

  // The provenance labels are worth one call per refresh, not one per row —
  // and that call must not be `list_notes`, which answers with every note
  // body in the library. The refresh runs after every pin click, so a pasted
  // document was crossing the IPC boundary on every click of a button that
  // has nothing to do with notes.
  //
  // The assertion is one call per *refresh*, not "exactly one call ever". A
  // count pinned to a single cycle fails the moment a legitimate second
  // refresh is added — a stale-comment fix, a manual reload button — which
  // is an unrelated reason to fail and trains the reader to re-pin the
  // number. Tying the two call counts together is the property that was
  // actually wanted: the note projection costs one query per refresh, and
  // neither count moves with the number of rendered rows.
  it("resolves every row's source note once per refresh, not once per row", async () => {
    const rows = [memory("m-1"), memory("m-2"), memory("m-3")];
    let pinned = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_memory") return rows.map((row) => ({ ...row, pinned: pinned && row.id === "m-1" }));
      if (command === "list_memory_reviews") return [];
      if (command === "set_memory_pinned") pinned = (args as { pinned: boolean }).pinned;
      // m-1 and m-3 came from the same note; m-2 came from nowhere. Keyed by
      // memory id, so two notes and three rows are still one query.
      if (command === "list_note_titles") return [
        { id: "n-1", title: "Release notes", memory_ids: ["m-1", "m-3"] },
        { id: "n-2", title: "Roadmap", memory_ids: [] },
      ];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const calls = (command: string) =>
      vi.mocked(invoke).mock.calls.filter(([c]) => c === command).length;

    await waitFor(() => expect(screen.getAllByText(/from note: Release notes/)).toHaveLength(2));
    // The row with no source note is not labelled, and all three rows are up.
    expect(screen.getAllByRole("button", { name: /^(Pin|Unpin) Pref m-2/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^(Pin|Unpin) Pref m-/ })).toHaveLength(3);
    // Three rows, one call: a per-row lookup would be three.
    expect(calls("list_note_titles")).toBe(calls("list_memory"));
    expect(calls("list_note_titles")).toBe(1);

    // A second refresh costs a second call — one per cycle — and the counts
    // stay locked together, so neither scales with the rows on screen.
    fireEvent.click(screen.getByRole("button", { name: /Pin Pref m-1/ }));
    await waitFor(() => expect(calls("list_memory")).toBe(2));
    expect(calls("list_note_titles")).toBe(calls("list_memory"));
    expect(calls("list_note_titles")).toBe(2);

    // The bodies stay in the database. A route that reached for
    // `list_notes` here would render identically and cost megabytes.
    expect(invoke).not.toHaveBeenCalledWith("list_notes", expect.anything());
  });

  it("still renders the list when the note projection fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [memory("m-1")];
      if (command === "list_memory_reviews") return [];
      if (command === "list_note_titles") throw new Error("notes offline");
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    // Provenance is decoration; a note library that will not load must not
    // cost the list it decorates.
    expect(await screen.findByRole("button", { name: /Pin Pref m-1/ })).toBeInTheDocument();
    expect(screen.queryByText(/from note:/)).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The compact rhythm.
 *
 * Memory is the first of three pages — with Documents and Tasks — where
 * row count is the point, and it says so in spacing and nowhere else.
 * Same tokens, same 1px border, same theme radius, same colours as the
 * standard rhythm every other page uses; less air. The pages that follow
 * copy the decision, and the decision is expressed in the pixels below
 * rather than in a class name, so copying it does not mean copying a
 * string.
 * ═══════════════════════════════════════════════════════════════════════ */

const listed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "user_pref",
  title: `Pref ${id}`,
  content: "Concise replies",
  tags: null,
  is_enabled: true,
  created_at: "now",
  updated_at: "now",
  pinned: false,
  ...over,
});

function serveMemories(items: unknown[]) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_memory") return items;
    if (command === "list_note_titles") return [];
    if (command === "list_memory_reviews") return [];
    // Answered rather than left to fall through to `null`, because a state
    // that opens the extract dialog reads `.length` on the result and a
    // `null` there throws *after* an assertion has already passed — which
    // is a flake waiting for the next assertion to move.
    if (command === "list_extractable_sessions") return [];
    if (command === "search_memory") return [];
    return null;
  });
}

/** The memory list, reached through a control on a row rather than by tag. */
async function memoryList(container: HTMLElement): Promise<HTMLUListElement> {
  const pins = await within(container).findAllByRole("button", { name: /^Pin / });
  const row = pins[0].closest("li");
  expect(row, "a memory row must be an <li>").toBeTruthy();
  const list = row!.parentElement;
  expect(list?.tagName, "memory rows must hang off one <ul>").toBe("UL");
  return list as HTMLUListElement;
}

/** One row of the rendered list, the same one every time. */
async function firstRow(container: HTMLElement): Promise<HTMLElement> {
  const list = await memoryList(container);
  return (await within(list).findAllByRole("button", { name: /^Pin / }))[0].closest("li")!;
}

const renderMemory = () =>
  render(
    <MemoryRouter>
      <MemoryRoute />
    </MemoryRouter>,
  );

/** The standard rhythm, named by the utilities the other pages use and
 *  measured through the same build, so a change to the scale moves both
 *  sides of the comparison and the difference survives it. */
async function standardRhythm(): Promise<Rhythm> {
  const decls = await emitted(["space-y-2", "p-3"]);
  return {
    gap: toPx(declValue(decls.get("space-y-2")!, "margin-top", "space-y-2"), "space-y-2 { margin-top }"),
    pad: toPx(declValue(decls.get("p-3")!, "padding", "p-3"), "p-3 { padding }"),
  };
}

/** The rhythm the rendered page actually ships. */
async function pageRhythm(container: HTMLElement): Promise<Rhythm> {
  const list = await memoryList(container);
  const row = (await within(list).findAllByRole("button", { name: /^Pin / }))[0].closest("li")!;
  return {
    gap: await pxOn(list, /^space-y-/, "margin-top"),
    pad: await pxOn(row, /^p-/, "padding"),
  };
}

describe("MemoryRoute density: the compact rhythm, measured", () => {
  beforeEach(() => serveMemories([listed("m-1"), listed("m-2"), listed("m-3")]));

  it("spaces rows tighter than the standard rhythm every other page uses", async () => {
    const { container } = renderMemory();
    const compact = await pageRhythm(container);
    const standard = await standardRhythm();

    // Read out of the stylesheet the build produces, from the classes the
    // page rendered. `space-y-1` is the current spelling; the assertion
    // is about four pixels, and any other spelling of four fewer pixels
    // would pass without an edit.
    expect(compact.gap).toBeLessThan(standard.gap);
    expect(compact.pad).toBeLessThan(standard.pad);
    // And it is a rhythm, not nothing: a list whose rows touch has
    // stopped being a list.
    expect(compact.gap).toBeGreaterThan(0);
  });

  it("spends less vertical air per row than the standard rhythm", async () => {
    const { container } = renderMemory();
    const compact = await pageRhythm(container);
    const standard = await standardRhythm();

    expect(airOf(compact)).toBeLessThan(airOf(standard));

    // The consequence, as a model and not a measurement: jsdom has no
    // layout, so a row's own height depends on how its text wrapped and
    // is unknowable here. What *is* knowable is the part the design
    // controls, and a smaller per-row cost can never fit fewer rows.
    const SCROLL = 600;
    for (const content of [24, 40, 72, 120, 200]) {
      expect(
        rowsThatFit(compact, content, SCROLL),
        `${content}px rows must not fit worse`,
      ).toBeGreaterThanOrEqual(rowsThatFit(standard, content, SCROLL));
    }
    // Strictly more at the short-row end — and the boundary is worth
    // stating rather than glossing, because the saving is 12px on a row,
    // about a ninth of a three-line one, and whether that crosses an
    // integer boundary in a given viewport depends on how tall the rows
    // actually are. In 600px of scroll it does for a row of 72px (5 rows
    // become 6) and it does not for a full chip-title-body-tag row of
    // about 84px, where both rhythms show five. The general claim above
    // is the one that always holds; this one says where the boundary is,
    // and a store of short one-line memories is exactly the case the
    // decision is for.
    expect(rowsThatFit(compact, 72, SCROLL)).toBeGreaterThan(rowsThatFit(standard, 72, SCROLL));
  });

  it("tells the two rhythms apart, because a measurement that cannot is not one", async () => {
    const standard = await standardRhythm();
    // The same code, run over a fixture built at the standard rhythm.
    const host = document.createElement("div");
    host.innerHTML = '<ul class="space-y-2"><li class="p-3"></li></ul>';
    const list = host.querySelector("ul")!;
    const row = host.querySelector("li")!;
    expect(await pxOn(list, /^space-y-/, "margin-top")).toBe(standard.gap);
    expect(await pxOn(row, /^p-/, "padding")).toBe(standard.pad);

    // A class the page does not use is a failure, not a zero. This is
    // what keeps the resolver honest: without it, a typo in a class name
    // would read as "no padding at all" and sail through as compact.
    const typo = document.createElement("ul");
    typo.className = "space-y-1x";
    await expect(pxOn(typo, /^space-y-/, "margin-top")).rejects.toThrow();
    // And a page with no rhythm at all is a failure too.
    const bare = document.createElement("ul");
    await expect(pxOn(bare, /^space-y-/, "margin-top")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Review Focus 5: a narrow window.
 *
 * `App.tsx` gives `<main>` a `min-w-0`, so the content pane can already
 * shrink; the question a route has to answer is what it asks of that pane
 * before the window gets there. A page that declares its own minimum
 * width puts a floor under the whole layout, and the floor — not the
 * pane — is what a user on a 900px screen ends up scrolling.
 *
 * The claim in both directions: the page asks for less than the sidebar
 * does, so the content is the thing that gives; and nothing in it can be
 * dragged wider by a long string, so what gives is air and not text.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("MemoryRoute on a narrow window", () => {
  beforeEach(() => serveMemories([listed("m-1"), listed("m-2"), listed("m-3")]));

  it("asks the pane for less than the sidebar asks of it, so the content absorbs a narrow window", async () => {
    const { container } = renderMemory();

    const floor = await intrinsicFloor(container);
    // The sidebar's own width, from the same Tailwind. `w-60` is Task 3's
    // and is not being changed; the point is only that it is the number a
    // page has to stay under.
    const sidebar = await emitted(["w-60"]);
    const sidebarPx = toPx(declValue(sidebar.get("w-60")!, "width", "w-60"), "w-60 { width }");

    // A usable floor rather than nothing: the search field still needs a
    // column to put a query in.
    expect(floor).toBeGreaterThan(0);
    // The load-bearing half. Above this the page, not the content pane,
    // would be what refuses to shrink.
    expect(floor).toBeLessThan(sidebarPx);
  });

  it("measures the floor it is asserting rather than assuming the walk found one", async () => {
    // The control, and the reason the assertion above means anything: the
    // same walk over a page that asks for 900px reports 900.
    const host = document.createElement("div");
    host.innerHTML = '<div class="w-[900px]"></div><div class="w-full"></div>';
    expect(await intrinsicFloor(host)).toBe(900);
    // …and `w-full` contributes nothing, because a percentage asks for
    // whatever the pane already is. Counting it would put a 16x-too-large
    // floor on every page that fills its column.
    const filling = document.createElement("div");
    filling.innerHTML = '<div class="w-full min-w-0"></div>';
    expect(await intrinsicFloor(filling)).toBe(0);
  });

  it("bounds the measure on a wide window too, so a long memory does not run the full width", async () => {
    const { container } = renderMemory();
    const column = (await memoryList(container)).parentElement!;
    // A `max-w-*` bounds a measure and can never squeeze a narrow window,
    // so it plays no part in the floor above — and on a 2560px monitor it
    // is the only thing standing between a row and a 2000px line of text.
    // 48rem is roughly 75 characters at this page's type size, the usual
    // upper bound for a single column.
    expect(await pxOn(column, /^max-w-/, "max-width")).toBeLessThanOrEqual(48 * 16);
  });

  it("truncates a 200-word title rather than widening the pane, and loses none of the text", async () => {
    const long = Array.from({ length: 220 }, (_, i) => `preference${i}`).join(" ");
    serveMemories([listed("m-1", { title: long })]);
    const { container } = renderMemory();
    const title = within(await memoryList(container)).getByText(long);

    // A long flex item needs two permissions to give way: `min-w-0` to
    // stop `min-width: auto` turning the text into a hard floor, and
    // `truncate` to actually do something with the space that frees.
    expect(title.className).toMatch(/\bmin-w-0\b/);
    const truncate = classMatching(title, /\btruncate\b/);
    const decls = (await emitted([truncate])).get(truncate)!;
    expect(declValue(decls, "overflow", truncate)).toBe("hidden");
    expect(declValue(decls, "text-overflow", truncate)).toBe("ellipsis");
    expect(declValue(decls, "white-space", truncate)).toBe("nowrap");

    // Truncation is presentation, not deletion: a screen reader and a
    // copy-paste still get all 220 words, which is the reason a title is
    // truncated at all rather than cut.
    expect(title.textContent).toBe(long);
    expect(long.split(" ")).toHaveLength(220);
  });

  it("wraps a long unbroken body string instead of pushing the row out", async () => {
    const blob = "x".repeat(400);
    serveMemories([listed("m-1", { title: null, content: blob })]);
    const { container } = renderMemory();
    const body = within(await memoryList(container)).getByText(blob);

    // `whitespace-pre-wrap` is not enough on its own: an unbroken run has
    // no break opportunity, and it is the base64 blob and the pasted URL
    // that break layouts, not the sentence.
    expect(body.className).toMatch(/\bwhitespace-pre-wrap\b/);
    const wrap = classMatching(body, /\bbreak-words\b/);
    const decls = (await emitted([wrap])).get(wrap)!;
    expect(declValue(decls, "overflow-wrap", wrap)).toBe("break-word");
  });

  it("lets the row's controls keep their size and shrinks the text beside them", async () => {
    const { container } = renderMemory();
    const row = await firstRow(container);
    const cluster = row.querySelector(".shrink-0");
    expect(cluster, "the row's control cluster must refuse to shrink").toBeTruthy();
    // Four controls at a fixed size, so the pane's width comes off the
    // title and the body rather than off the buttons a user has to hit.
    expect(cluster!.querySelectorAll("button")).toHaveLength(4);
    for (const b of cluster!.querySelectorAll("button")) {
      expect(await pxOn(b, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(b, /^h-/, "height")).toBeGreaterThanOrEqual(24);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, and no literal colour.
 *
 * The reference is flat: a card is a surface and a 1px border, and a
 * shadow on a list row is a regression against that, not a finishing
 * touch. The only `box-shadow` in this design belongs to things that
 * genuinely float — a modal, a dropdown, a tooltip — and none of those
 * are on the page.
 *
 * The transition half is scoped to the list, not the page, and the scope
 * is the argument: a memory list is the subtree that scales to hundreds
 * of rows, which is the same reason the streaming subtree is fenced. The
 * three starter buttons in the empty state and the rows inside a modal
 * are a fixed, transient handful, they already carry a shadow of their
 * own to justify floating, and they are not the thing that grows.
 * ═══════════════════════════════════════════════════════════════════════ */

const PAINT_UTILS: { label: string; re: RegExp }[] = [
  { label: "box-shadow", re: /^(shadow|drop-shadow)(-|$)/ },
  { label: "filter", re: /^(blur|brightness|contrast|grayscale|invert|saturate|sepia|hue-rotate|backdrop-)(-|$)/ },
  { label: "transition", re: /^transition(-|$)/ },
];

function paintForcing(root: Element, kinds: string[]): string[] {
  const found: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const cls of Array.from(el.classList)) {
      const bare = cls.replace(/^!/, "").split(":").pop() ?? cls;
      for (const { label, re } of PAINT_UTILS) {
        if (kinds.includes(label) && re.test(bare)) {
          found.push(`<${el.tagName.toLowerCase()} class="${cls}"> declares ${label}`);
        }
      }
    }
    const m = (el.getAttribute("style") ?? "").match(/(?:^|;)\s*(box-shadow|filter|transition(?:-property)?)\s*:/);
    if (m) {
      const label = m[1].startsWith("box-shadow") ? "box-shadow" : m[1].startsWith("transition") ? "transition" : "filter";
      if (kinds.includes(label)) found.push(`<${el.tagName.toLowerCase()}> declares inline ${m[1]}`);
    }
  }
  return found;
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(\s*in\s*(srgb|rgb)\b/i;

describe("MemoryRoute rows stay flat", () => {
  beforeEach(() => serveMemories([listed("m-1"), listed("m-2"), listed("m-3")]));

  it("puts no shadow and no filter anywhere on the page", async () => {
    const { container } = renderMemory();
    // Awaited, and this is not tidiness. `render()` returns before the
    // list resolves, so a walk taken immediately sees the *empty state* —
    // a page with no row on it at all — and reports a clean tree. The
    // first version of this test did exactly that and passed against a row
    // with `shadow-panel` on it. `memoryList` is the control: it will not
    // return until a row is really in the DOM.
    await memoryList(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("scopes every focus ring to a state, so no row paints a shadow at rest", async () => {
    const { container } = renderMemory();
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A
    // *bare* `ring-2` would put a shadow on every row at rest and the
    // shadow check would still call the page clean.
    //
    // `focus:` and `focus-visible:` both satisfy it. Which one a control
    // takes is a judgement, and the two are picked rather than defaulted:
    // the search field takes `focus:`, because a text field should show
    // where the caret is however it got there, and the row's buttons take
    // `focus-visible:`, because clicking one acts immediately and there
    // is nothing left to disambiguate.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    // The two choices above, asserted where they are made rather than
    // left to whatever the primitive happens to do.
    const search = screen.getByRole("textbox", { name: "Search memory" });
    expect(classMatching(search, /ring-/)).toMatch(/^focus:ring-/);
    const action = within(await firstRow(container)).getByRole("button", { name: /^Pin / });
    expect(classMatching(action, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("animates nothing inside the memory list", async () => {
    const { container } = renderMemory();
    expect(paintForcing(await memoryList(container), ["transition"])).toEqual([]);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // Negative control, so none of the three checks above can pass by
    // being blind.
    const host = document.createElement("div");
    host.innerHTML = [
      '<div class="shadow-panel"></div>',
      '<div class="hover:shadow-lg"></div>',
      '<div class="transition-colors"></div>',
      '<div class="blur-sm"></div>',
      '<div style="filter: blur(1px)"></div>',
      '<div style="transition: opacity 1s"></div>',
      '<div class="bg-surface-2 border border-border"></div>',
    ].join("");

    const all = paintForcing(host, ["box-shadow", "filter", "transition"]);
    expect(all.filter((f) => f.includes("shadow-panel"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("shadow-lg"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("transition-colors"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("blur-sm"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline filter"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline transition"))).toHaveLength(1);
    expect(all).toHaveLength(6);
    // And the scopes really do differ: a page-wide sweep would have
    // caught all six, a list-only sweep only the transition one.
    expect(paintForcing(host, ["transition"])).toHaveLength(2);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    serveMemories([listed("m-1", { tags: "a,b" })]);
    const { container } = renderMemory();
    // Same reason as the shadow walk above: the rows arrive a frame after
    // `render()`, and the row is where the colours are.
    await memoryList(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders on an empty store or
    // behind a modal is covered too.
    const src = source("src/routes/MemoryRoute.tsx");
    expect(src, "MemoryRoute.tsx must not hardcode a colour").not.toMatch(COLOUR_LITERAL);
  });

  it("finds a literal colour when one is planted", () => {
    // The control. `COLOR_LITERAL` is a regex on a class string, and a
    // regex that matches nothing is indistinguishable from a regex that
    // cannot match.
    expect('bg-[#ff0000]').toMatch(COLOUR_LITERAL);
    expect("shadow-[rgb(1,2,3)]").toMatch(COLOUR_LITERAL);
    expect("text-[hsl(210,50%,40%)]").toMatch(COLOUR_LITERAL);
    expect("border-[oklch(0.7_0.1_200)]").toMatch(COLOUR_LITERAL);
    // …and the tokens this page is supposed to be using are not literals.
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/15", "shadow-nav-glow"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The shared vocabulary, and the behaviour the restyle had to keep.
 *
 * The restyle is allowed to change what a row looks like. It is not
 * allowed to change what it does, so search, the kind filter, the empty
 * store's starter path and the disabled treatment are each asserted
 * here — a page that reads better and searches worse is not a restyle.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("MemoryRoute in the shared vocabulary", () => {
  beforeEach(() => serveMemories([listed("m-1"), listed("m-2"), listed("m-3")]));

  it("gives every card and every chip a theme radius, so a theme that reshapes the app reshapes the rows", async () => {
    // Tags and a source note, so the hand-composed chips are actually in
    // the tree. Without them this test sees the row and the `Badge` and
    // nothing else, and passes on a chip with a hardcoded radius on it.
    serveMemories([listed("m-1", { tags: "code-style, project-x" })]);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [listed("m-1", { tags: "code-style, project-x" })];
      if (command === "list_note_titles") {
        return [{ id: "n-1", title: "Release notes", memory_ids: ["m-1"] }];
      }
      if (command === "list_memory_reviews") return [];
      return null;
    });
    const { container } = renderMemory();
    await memoryList(container);
    const rows = Array.from((await memoryList(container)).children);
    // The chips this is about are really here.
    expect(within(rows[0] as HTMLElement).getAllByText(/code-style|project-x|from note/)).toHaveLength(3);

    // Not `0.5rem`, not `12px`: one of the four radius custom
    // properties, which is what makes the geometry theme-following. A
    // hardcoded radius here would be a card that ignores its own theme,
    // and the same failure V7 fixed in the primitives.
    //
    // Scoped by "draws a box", i.e. carries a border: the row card, the
    // kind chip, the pinned chip, the provenance chip and the tags. The
    // chips are hand-composed rather than `Badge` precisely because they
    // need a `title`, and hand-composed is exactly how four hardcoded
    // `rounded`s got here in the first place. Keying on the border rather
    // than on a radius class is what lets a chip that *lost* its radius
    // fail instead of quietly dropping out of the walk.
    const radii = new Set<string>();
    for (const row of rows) {
      for (const el of [row, ...Array.from(row.querySelectorAll("*"))]) {
        if (!Array.from(el.classList).some((c) => c === "border" || c.startsWith("border-"))) continue;
        const radius = classMatching(el, /^rounded-/);
        const decls = (await emitted([radius])).get(radius)!;
        expect(declValue(decls, "border-radius", radius), `${radius} on <${el.tagName.toLowerCase()}>`)
          .toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
        radii.add(radius);
      }
    }
    // A control against its own vacuity: the walk saw more than one kind
    // of box, and not merely the row it started from.
    expect(radii.size).toBeGreaterThan(1);
  });

  it("keeps the review banner a visible signal, and absent when there is nothing to review", async () => {
    // The one place this page tints itself with the accent to say "this
    // wants you". It is a strip, not a decoration: a restyle that dropped
    // the tint would leave a row of grey buttons with no reason for the
    // user to be there.
    serveMemories([listed("m-1")]);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [listed("m-1")];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") {
        return [{ id: "r-1", sessionId: "session-1", facts: [], status: "pending", error: null, createdAt: "now" }];
      }
      return null;
    });
    const { container } = renderMemory();

    const banner = (await screen.findByText("Memory extraction reviews")).closest("div")!;
    expect(banner.className).toMatch(/bg-accent\/\d+/);
    expect(await firstRow(container)).toBeTruthy();
    // …and it is a separate strip from the list, not a tint on the rows.
    expect(paintForcing(banner, ["box-shadow", "filter"])).toEqual([]);
  });

  it("paints the three kinds from three distinct tokens, and never from a fallback", async () => {
    serveMemories([
      listed("m-1", { kind: "user_pref" }),
      listed("m-2", { kind: "project_fact" }),
      listed("m-3", { kind: "skill" }),
    ]);
    const { container } = renderMemory();
    const rows = Array.from((await memoryList(container)).children);

    const toneOf = (row: Element) => {
      const chip = row.querySelector("span");
      const token = Array.from(chip!.classList).find((c) => /^bg-[a-z-]+\/\d+$/.test(c));
      return { label: chip!.textContent, token };
    };
    const tones = rows.map(toneOf);
    // Three kinds, three readable chips...
    expect(tones.map((t) => t.label)).toEqual(["Preferences", "Project facts", "Skills"]);
    // …and three different tokens behind them, so kind is legible without
    // reading the word. Shaped rather than spelled: the opacity and the
    // tint are retunable and the assertion survives them, but a chip that
    // fell through to a neutral surface — or to a literal — would not.
    expect(new Set(tones.map((t) => t.token)).size).toBe(3);
    for (const { token } of tones) {
      expect(token, "a kind chip must paint from a semantic token").toMatch(/^bg-(accent|success|warn)\/\d+$/);
    }
  });

  it("still gives a kind this build has never heard of a legible chip", async () => {
    // The `KIND_VARIANT` fallback is unreachable for the three kinds Rust
    // sends today, which makes it exactly the kind of line a test cannot
    // see. It is reachable in the one case that matters: a database
    // written by a build that knew a fourth kind. `MemoryItem.kind` is a
    // string at the IPC boundary, so the row arrives, and a chip that
    // rendered as a neutral surface would say nothing at all about it.
    serveMemories([listed("m-1", { kind: "habit" })]);
    const { container } = renderMemory();
    const row = (await firstRow(container));
    const chip = row.querySelector("span")!;
    // The label falls back to the raw kind, exactly as `KIND_LABEL` does.
    expect(chip.textContent).toBe("habit");
    expect(Array.from(chip.classList).find((c) => /^bg-[a-z-]+\/\d+$/.test(c)))
      .toMatch(/^bg-(accent|success|warn)\/\d+$/);
  });

  it("puts the kind filter in the action cluster, and the cluster can reflow rather than squeeze", async () => {
    const { container } = renderMemory();
    const cluster = container.querySelector("[data-actions]")!;
    const tablist = screen.getByRole("tablist");

    // The placement is the spec's. §4.2 gives a page with a real view
    // toggle a pill in the action cluster and names this page as the one
    // that has one; `RouteShell`'s own docstring says the same. A kind
    // filter sitting in a body toolbar is the app's old arrangement, and
    // this is the task that is supposed to replace it.
    expect(cluster.contains(tablist), "the kind filter belongs in the action cluster").toBe(true);
    expect(tablist.querySelectorAll("button")).toHaveLength(4);
    // …beside the two actions rather than instead of them, and to their
    // left, so the cluster still reads as "filter, then act".
    expect(cluster.querySelectorAll(":scope > button")).toHaveLength(2);
    expect(
      tablist.compareDocumentPosition(cluster.lastElementChild!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the filter must precede the actions",
    ).toBeTruthy();

    // The reflow half, and the reason the placement was hard. This cluster
    // is the widest thing in the header — four tabs plus two buttons — so
    // a cluster that could not shrink pushed the content pane instead of
    // reflowing, and the filter had nowhere to go but the body.
    //
    // Asserted here as well as in `RouteShell.test.tsx`, from the page
    // that depends on it, so a re-added `shrink-0` is caught from both
    // sides. And the application is asserted before the declaration,
    // which is the ordering this round's V44 is about: reading a class
    // out of the build says Tailwind could be asked for it, and says
    // nothing about whether this cluster is the thing that asks.
    const classes = Array.from(cluster.classList);
    expect(classes, "the cluster must not refuse to shrink").not.toContain("shrink-0");
    expect(classes, "a shrinkable cluster must wrap its control set").toContain("flex-wrap");
    // The control on the negative: the shell's *header* carries a
    // `shrink-0` of its own, which is a different thing and is why a
    // whole-page "no shrink-0 anywhere" rule would be a rule the design
    // does not follow.
    const header = cluster.closest("header")!;
    expect(Array.from(header.classList)).toContain("shrink-0");
    // The rest of the cluster's geometry, so the test is not satisfied by
    // a cluster that had everything stripped off it.
    for (const kept of ["flex", "items-center", "gap-2", "justify-end"]) {
      expect(classes, `the cluster must keep ${kept}`).toContain(kept);
    }
    const wrap = classMatching(cluster, /\bflex-wrap\b/);
    expect(declValue((await emitted([wrap])).get(wrap)!, "flex-wrap", wrap)).toBe("wrap");
  });

  it("sizes the filter's controls like the buttons beside them", async () => {
    renderMemory();
    const extract = screen.getByRole("button", { name: /extract from chat/i });
    const tablist = screen.getByRole("tablist");
    // Resolved, not spelled. `Tabs` is a 14px, 33px tab bar and the
    // header's buttons are 12px and 24px; side by side in one cluster
    // they read as two design systems, and the filter is the only control
    // in there that is not a button. The overrides resolve to exactly
    // `Button size="sm"`, so the claim is two numbers being equal.
    for (const [prop, variant] of [
      ["padding-left", "[&>button]:px-2.5"],
      ["padding-top", "[&>button]:py-1"],
      ["font-size", "[&>button]:text-xs"],
    ] as const) {
      // The page has to be *using* the override. A rule that resolves to
      // the right number proves Tailwind can be asked for it, which says
      // nothing about whether this page asked — and a comparison between
      // two declarations the page may have stopped using passes happily.
      expect(
        Array.from(tablist.classList),
        `${variant} must be on the tab strip`,
      ).toContain(variant);
      const rule = await variantRule(variant);
      // …and it has to reach the tab rather than merely the container it
      // is written on.
      expect(rule.selector, `${variant} must target the tab`).toMatch(/>\s*button$/);
      expect(
        toPx(declValue(rule.decls, prop, variant), `${variant} { ${prop} }`),
        `${prop}: the filter and the buttons beside it must match`,
      ).toBe(await pxDeclaring(extract, prop));
    }
    // The control on the comparison: the primitive's own values are
    // genuinely different, so equality above is not the default state.
    expect(await pxDeclaring(screen.getByRole("tab", { name: "Skills" }), "font-size")).toBe(14);
  });

  it("takes the tab strip's own rule off, and the class that takes it wins the cascade", async () => {
    renderMemory();
    const tablist = screen.getByRole("tablist");
    const zero = classMatching(tablist, /\bborder-b-0\b/);
    expect(declValue((await emitted([zero])).get(zero)!, "border-bottom-width", zero)).toBe("0px");

    // `Tabs` puts `border-b` on itself and the caller cannot remove it, so
    // the override has to come from a second utility. Both are one class
    // of equal specificity, which means the *order Tailwind emits them
    // in* is the entire mechanism — a property of the config's key order,
    // not of this page. If that order ever inverts, the override stops
    // working and a test that only read the class name would keep
    // passing. So the order is asserted, and this test is the reason
    // anyone would find out.
    const order = await ruleOrder([zero, "border-b"]);
    expect(order.get(zero)!).toBeGreaterThan(order.get("border-b")!);
  });

  it("still searches, and still shows what the search found", async () => {
    const hits = [{ item: listed("m-9", { title: "Concise replies" }), snippet: "<mark>Concise</mark> replies" }];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [listed("m-1")];
      if (command === "search_memory") return hits;
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      return null;
    });
    const { container } = renderMemory();

    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "concise" },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("search_memory", expect.objectContaining({ query: "concise" })),
    );
    // The hit renders as a row, and the match is marked up — a restyled
    // search field that no longer searches is not a restyle.
    await screen.findByText("Concise replies");
    const row = within(container).getByText("Concise replies").closest("li")!;
    const mark = row.querySelector("mark");
    expect(mark?.textContent).toBe("Concise");
    // The mark is the only thing telling a user *why* this row came back,
    // so it has to be visibly the match. Its tint is injected as a class
    // string through `dangerouslySetInnerHTML`, which a walk over the
    // route's own class lists would not see at all — so this is the one
    // place the match's own classes are read.
    const markClasses = Array.from(mark!.classList);
    const tint = markClasses.find((c) => /^bg-[a-z-]+\/\d+$/.test(c));
    expect(tint, `the match must be tinted, not just wrapped: "${mark!.className}"`).toBeTruthy();
    expect(tint).not.toMatch(/^bg-surface/);
  });

  it("still filters by kind", async () => {
    const { container } = renderMemory();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_memory", { kind: "skill" }));
    // …and the whole list is re-read rather than filtered on the client,
    // which is the behaviour that keeps Rust in charge of the list.
    expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
    expect(await memoryList(container)).toBeTruthy();
  });

  it("still offers a starter path when the store is empty", async () => {
    serveMemories([]);
    const { container } = renderMemory();
    const starters = screen.getByText("No memories yet");
    expect(starters).toBeInTheDocument();
    // The three kinds, each still wired to its own command. An empty
    // state that renders three decorative cards is the most likely thing
    // a restyle silently breaks.
    for (const [label, kind] of [
      ["Set a preference", "user_pref"],
      ["Log a project fact", "project_fact"],
      ["Create a skill", "skill"],
    ] as const) {
      fireEvent.click(screen.getByText(label));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "upsert_memory",
          expect.objectContaining({ item: expect.objectContaining({ kind }) }),
        ),
      );
    }
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("marks a disabled memory as disabled, and an enabled one not", async () => {
    serveMemories([listed("m-1", { is_enabled: false }), listed("m-2", { is_enabled: true })]);
    const { container } = renderMemory();
    const rows = Array.from((await memoryList(container)).children);
    const dimmed = rows.filter((r) => r.className.includes("opacity-50"));
    // Meaning, not decoration: a memory that is left out of every prompt
    // has to be visibly left out, and this is the treatment that says so.
    // It survives the restyle deliberately, and the pairing is what makes
    // the assertion above it about *which* row is disabled.
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0].textContent).toContain("Pref m-1");
    expect(rows[1].className).not.toMatch(/opacity-50/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position,
 * so `h1` followed by `h3` is a defect rather than a nit: the heading is
 * not reachable by a level-keyed jump, and every level-keyed list built
 * from the page inherits the gap. The empty state was doing exactly that
 * — `EmptyState`'s title is an `h3` by default, and `RouteShell` owns the
 * page's `h1` with no `h2` between them — so this page asks the
 * primitive for level 2 and the five-state walk below is what holds it
 * there.
 *
 * Every state the page can be in is checked, because the two empty states
 * and the five modals are separate subtrees and a fix applied to one of
 * them says nothing about the rest.
 * ═══════════════════════════════════════════════════════════════════════ */

const headingLevels = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
    level: Number(h.tagName.slice(1)),
    text: h.textContent ?? "",
  }));

function expectNoHeadingSkip(root: HTMLElement, where: string) {
  const headings = headingLevels(root);
  expect(headings.length, `${where} renders no heading at all`).toBeGreaterThan(0);
  expect(headings[0].level, `${where} must open with the page's own h1`).toBe(1);
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1];
    expect(
      headings[i].level,
      `${where}: h${prev.level} "${prev.text}" is followed by h${headings[i].level} "${headings[i].text}"`,
    ).toBeLessThanOrEqual(prev.level + 1);
  }
}

describe("MemoryRoute heading outline", () => {
  beforeEach(() => serveMemories([listed("m-1"), listed("m-2")]));

  it("skips no heading level in any state the page can be in", async () => {
    // 1 — the list, which is where a user spends their time and the only
    // state with no heading but the page's own.
    const list = renderMemory();
    await firstRow(list.container);
    expectNoHeadingSkip(list.container, "the memory list");

    // 2 — an empty store. The heading that used to skip.
    cleanup();
    serveMemories([]);
    const empty = renderMemory();
    await screen.findByText("No memories yet");
    expectNoHeadingSkip(empty.container, "the empty store");

    // 3 — a search that matched nothing. A different heading, and a
    // different branch, from the empty store's, and the only one of the
    // six that depends on a debounced query resolving.
    cleanup();
    serveMemories([listed("m-1")]);
    const search = renderMemory();
    await firstRow(search.container);
    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "nothing matches this" },
    });
    await screen.findByText("No matches");
    expectNoHeadingSkip(search.container, "a search with no matches");

    // 4 — the add modal. `Modal` renders its own `h2`, so a dialog title
    // lands at a level under the page's rather than beside it.
    cleanup();
    serveMemories([listed("m-1")]);
    const add = renderMemory();
    await firstRow(add.container);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(add.container, "the add modal");

    // 5 — the extract modal, the widest dialog on the page.
    cleanup();
    serveMemories([listed("m-1")]);
    const extract = renderMemory();
    await firstRow(extract.container);
    fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(extract.container, "the extract modal");

    // 6 — the delete confirmation, which is a `Modal` behind a
    // `ConfirmDialog` and the last heading-bearing subtree left.
    cleanup();
    serveMemories([listed("m-1")]);
    const confirm = renderMemory();
    await firstRow(confirm.container);
    fireEvent.click(screen.getByRole("button", { name: /^Delete Pref m-1/ }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(confirm.container, "the delete confirmation");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings, or one that
    // only ever saw the page's own h1.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Memory</h1><h3>No memories yet</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    // A clean outline passes, including a legal step down and a sibling
    // at the same level, so the assertion is not "only one heading".
    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Memory</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    // And a page that opens on something other than its own h1 fails,
    // which is the other half of "the outline starts at the top".
    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });

  it("gives the empty store a heading that is a heading, at the level it asked for", async () => {
    serveMemories([]);
    const { container } = renderMemory();
    // A `div` with a heading's typography is the failure mode this is
    // guarding, and it passes every visual check on the page. Asserting
    // the tag as well as the level is what distinguishes "a heading at
    // the right level" from "a paragraph that looks like one".
    const heading = await screen.findByRole("heading", { name: "No memories yet" });
    expect(heading.tagName).toBe("H2");
    // The empty store is the only state with a heading besides the page's
    // own, and it is the one the primitive got wrong by default.
    expect(headingLevels(container).map((h) => h.level)).toEqual([1, 2]);
    // …and it is the primitive's own heading, carrying the primitive's
    // treatment, rather than a second implementation drawn over the top
    // of it. The tag and its classes are `EmptyState`'s to this page.
    expect(heading.className).toBe("text-sm font-medium text-text");
  });
});

describe("MemoryRoute recall and index status", () => {
  it("mounts the index status banner and refreshes it after a pin or toggle", async () => {
    const note =
      "No embedding model configured. Recall is keyword-only, so it will miss memories that share no words with the question.";
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [listed("m-1")];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "knowledge_index_status") {
        return {
          memoryCount: 1,
          noteCount: 0,
          embeddedCount: 0,
          needsEmbedding: 0,
          needsReindex: false,
          embeddingModel: null,
          semanticNote: note,
        };
      }
      return null;
    });

    renderMemory();
    expect(await screen.findByText(note)).toBeInTheDocument();

    const statusCalls = () =>
      vi.mocked(invoke).mock.calls.filter(([c]) => c === "knowledge_index_status").length;
    const before = statusCalls();

    fireEvent.click(await screen.findByRole("button", { name: /^Pin Pref m-1/ }));
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
  });

  it("mounts the test-recall panel and renders Rust's reason verbatim", async () => {
    const reason = 'matched "concise" in content · recalled 3× · updated today';
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [listed("m-1")];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "memory_recall") {
        return [
          {
            ownerType: "memory",
            ownerId: "m-1",
            kind: "user_pref",
            title: "Pref m-1",
            content: "Concise replies",
            score: 0.032,
            reason,
          },
        ];
      }
      return null;
    });

    renderMemory();
    const input = await screen.findByRole("textbox", { name: "Test recall query" });
    fireEvent.change(input, { target: { value: "concise" } });
    fireEvent.click(screen.getByRole("button", { name: "Test recall" }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it("renders a superseded row struck through, names its replacement, and leaves a live row untouched", async () => {
    const oldRow = listed("old-1", {
      title: "Deploy window",
      content: "Ships land any time on Fridays.",
      superseded_by: "new-1",
    });
    const newRow = listed("new-1", {
      title: "Friday deploy window",
      content: "Ships land after 2pm on Fridays.",
      superseded_by: null,
    });
    serveMemories([oldRow, newRow]);

    const { container } = renderMemory();
    const list = await memoryList(container);

    const oldTitle = within(list).getByText("Deploy window");
    const newTitle = within(list).getByText("Friday deploy window");
    expect(oldTitle).toHaveClass("line-through");
    expect(within(list).getByText("Ships land any time on Fridays.")).toHaveClass("line-through");
    expect(newTitle).not.toHaveClass("line-through");
    expect(within(list).getByText("Ships land after 2pm on Fridays.")).not.toHaveClass("line-through");

    const reachReplacement = within(list).getByRole("button", {
      name: /replaced by Friday deploy window/i,
    });
    expect(reachReplacement).toBeInTheDocument();
    fireEvent.click(reachReplacement);
    expect(await screen.findByRole("dialog", { name: "Edit memory" })).toBeInTheDocument();
  });
});



import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { CompareRoute } from "../CompareRoute";
import repoTailwind from "../../../tailwind.config";

const callbacks: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};

/* ═══════════════════════════════════════════════════════════════════════
 * Measuring the page, not spelling it.
 *
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two rows?* The tempting substitute is
 * `expect(list.className).toContain("space-y-2")`, and it is the wrong
 * test twice over. It pins a class name, which is an implementation
 * detail that the next task will change for no reason, and it passes for
 * any page that merely *says* `space-y-2` — including one that got
 * denser using something else entirely.
 *
 * So the numbers below come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that comes
 * out. A card is 12px inside whether it says `p-3`, `px-3 py-3`, or
 * something a later task invents; a class that does not exist emits no
 * rule at all, which is a loud failure here rather than a silent zero.
 *
 * The resolver is duplicated from `MemoryRoute.test.tsx` and
 * `NotesRoute.test.tsx` on purpose. A shared test helper would be five
 * commits touching one file, and the whole point of the
 * one-commit-per-route rule is that a reviewer who dislikes one page's
 * treatment can reject that commit alone.
 *
 * The limit, stated rather than hidden: this is the *stylesheet* the build
 * produces, not a browser's layout. Every claim below is about declared
 * spacing.
 * ═══════════════════════════════════════════════════════════════════════ */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** The declarations one utility class emits, keyed by CSS property. */
const cache = new Map<string, Map<string, string>>();

const unescapeSelector = (s: string) => s.replace(/\\(.)/g, "$1");

/**
 * The part of a compiled stylesheet that is unconditional. Tailwind emits
 * screen variants after the plain utilities, so everything from the first
 * `@media` on only applies at or above a breakpoint.
 */
const unconditional = (css: string) => {
  const at = css.indexOf("@media");
  return at < 0 ? css : css.slice(0, at);
};

/** Index a compiled stylesheet by the class each rule styles. */
function indexRules(css: string): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  for (const m of unconditional(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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
  // not nominally the `postcss` this repo depends on — two installs of one
  // library, and the compiler is only ever handed this array here.
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
 * Every class on `root` and its descendants, resolved in **one** compile.
 *
 * Not an optimisation — a correctness fix for the timeout. `emitted` misses
 * the cache per class, and a walk that asks for one class at a time pays a
 * ~300ms Tailwind compile per class. `NotesRoute.test.tsx` learned this the
 * expensive way: seventeen compiles for one lookup pushed a test past
 * vitest's 5s default, where a passing test reads as a failing one.
 */
async function prewarm(root: HTMLElement): Promise<void> {
  const classes: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const c of el.classList) classes.push(c);
  }
  await emitted(classes);
}

/**
 * The first absolute length in a declaration, in CSS pixels. A `var()` or a
 * percentage has no absolute length, and returning a number for one of those
 * would be the exact lie this whole block exists to avoid — so it throws.
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
  throw new Error(`no class matching ${re} on <${el.tagName.toLowerCase()}> class="${el.className}"`);
}

/** The pixels `el`'s class matching `re` declares for one property. */
async function pxOn(el: Element, re: RegExp, prop: string): Promise<number> {
  const cls = classMatching(el, re);
  const decls = (await emitted([cls])).get(cls)!;
  return toPx(declValue(decls, prop, cls), `${cls} { ${prop} }`);
}

/**
 * The first class on `el` that declares `prop`, read out of the build.
 *
 * Needed wherever two classes of the same family sit on one element — a
 * `text-text` next to a `text-xs`, say — and the question is which of them
 * owns the property. `classMatching` answers "which class matches this
 * shape", and on a themed colour scale `text-*` is the *colour* family,
 * not the size one.
 */
async function classDeclaring(el: Element, prop: string): Promise<string> {
  // One `emitted` call for the element's whole class list, not one per
  // class — see `prewarm` for why that is not a style preference.
  const all = await emitted(Array.from(el.classList));
  for (const c of Array.from(el.classList)) {
    if (all.get(c)!.get(prop) !== undefined) return c;
  }
  throw new Error(`no class on <${el.tagName.toLowerCase()}> declares ${prop}`);
}

/** The type size `el` is actually set to, in CSS pixels. */
async function fontSizeOf(el: Element): Promise<number> {
  const cls = await classDeclaring(el, "font-size");
  const decls = (await emitted([cls])).get(cls)!;
  return toPx(declValue(decls, "font-size", cls), `${cls} { font-size }`);
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

/**
 * The first descendant of `card` that declares a `padding` — the content
 * region of a card that clips rather than insets itself.
 *
 * Throws when there is none, so "the card was never measured" is an error
 * rather than a skipped assertion.
 */
async function firstPaddedDescendant(card: Element): Promise<Element> {
  for (const el of Array.from(card.querySelectorAll("*"))) {
    const all = await emitted(Array.from(el.classList));
    for (const c of Array.from(el.classList)) {
      if (all.get(c)!.get("padding") !== undefined) return el;
    }
  }
  throw new Error("the column has no padded content region to measure");
}

/** A vertical rhythm, measured: the step between rows and the padding in one. */
interface Rhythm { gap: number; pad: number }

/**
 * The standard rhythm, named by the utilities every standard-rhythm page
 * uses and measured through the same build, so a change to the spacing
 * scale moves both sides of every comparison below and the difference
 * survives it.
 */
async function standardRhythm(): Promise<Rhythm> {
  const decls = await emitted(["space-y-2", "p-3"]);
  return {
    gap: toPx(declValue(decls.get("space-y-2")!, "margin-top", "space-y-2"), "space-y-2 { margin-top }"),
    pad: toPx(declValue(decls.get("p-3")!, "padding", "p-3"), "p-3 { padding }"),
  };
}

/** The compact rhythm, measured the same way, so the two are comparable. */
async function compactRhythm(): Promise<Rhythm> {
  const decls = await emitted(["space-y-1", "p-2"]);
  return {
    gap: toPx(declValue(decls.get("space-y-1")!, "margin-top", "space-y-1"), "space-y-1 { margin-top }"),
    pad: toPx(declValue(decls.get("p-2")!, "padding", "p-2"), "p-2 { padding }"),
  };
}

describe("CompareRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listProviders").mockResolvedValue([
      { id: "p1", name: "Local", kind: "ollama", base_url: "http://localhost", is_default: true, has_api_key: false, created_at: "now" },
    ]);
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([
      { id: "p1::model", name: "model", provider_id: "p1" },
    ] as never);
    vi.spyOn(api, "runCompare").mockResolvedValue("run-1");
    vi.spyOn(api, "cancelCompare").mockResolvedValue(undefined);
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
      return vi.fn();
    });
  });

  it("stops a running comparison locally and ignores stale run events", async () => {
    render(
      <MemoryRouter>
        <CompareRoute />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listModelsForProvider).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt to send to all models…"), { target: { value: "Compare this" } });
    fireEvent.click(screen.getByRole("button", { name: "Run compare" }));
    await waitFor(() => expect(api.runCompare).toHaveBeenCalled());

    callbacks["compare-chunk"]({ payload: { run_id: "stale-run", index: 0, content: "stale" } });
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(api.cancelCompare).toHaveBeenCalledWith("run-1"));
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  });

  it("batches compare chunks until the next animation frame", async () => {
    let flush!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    render(
      <MemoryRouter>
        <CompareRoute />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listModelsForProvider).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt to send to all models…"), { target: { value: "Compare this" } });
    fireEvent.click(screen.getByRole("button", { name: "Run compare" }));
    await waitFor(() => expect(api.runCompare).toHaveBeenCalled());

    callbacks["compare-chunk"]({ payload: { run_id: "run-1", index: 0, content: "first" } });
    callbacks["compare-chunk"]({ payload: { run_id: "run-1", index: 0, content: "second" } });
    expect(screen.queryByText("second")).not.toBeInTheDocument();
    act(() => flush(0));
    expect(await screen.findByText("firstsecond")).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The restyle's guards.
 *
 * Every one is written to fail if the thing it guards is removed, and
 * every walk either proves the subtree was there or throws. Four tasks in
 * this plan shipped a guard that passed against code it was not examining,
 * so the two habits that close that are load-bearing here: prove the
 * element is in the tree *before* walking it, and say what the walk is
 * looking at.
 * ═══════════════════════════════════════════════════════════════════════ */

const RUNS = [
  { id: "run-a", prompt: "Explain closures\nwith a note about scoping", created_at: "2026-09-01T10:00:00Z", winner_index: 0 },
  { id: "run-b", prompt: "Name a memory system", created_at: "2026-09-02T10:00:00Z", winner_index: null },
];

/**
 * One provider with one model, two of them selected, a prompt typed, and
 * the comparison running. That is the state with the most on it: two result
 * columns, a live column control, the winner control once both are done,
 * and the whole action cluster.
 */
async function renderRunning() {
  // `vitest.config.ts` does not set `unstubGlobals`, so the
  // `requestAnimationFrame` stub the second existing test installs with
  // `vi.stubGlobal` outlives it and every test after it. Left in place, the
  // compare chunk queue never flushes and no column ever reaches `done` —
  // which is why the winner control below could not be reached at all. This
  // is that stub, undone, and nothing else.
  vi.unstubAllGlobals();
  vi.spyOn(api, "listProviders").mockResolvedValue([
    { id: "p1", name: "Local", kind: "ollama", base_url: "http://localhost", is_default: true, has_api_key: false, created_at: "now" },
  ]);
  vi.spyOn(api, "listModelsForProvider").mockResolvedValue([
    { id: "p1::model", name: "model", provider_id: "p1" },
  ] as never);
  vi.spyOn(api, "runCompare").mockResolvedValue("run-1");
  vi.spyOn(api, "cancelCompare").mockResolvedValue(undefined);
  vi.spyOn(api, "cancelCompareColumn").mockResolvedValue(undefined);
  vi.spyOn(api, "saveCompareWinner").mockResolvedValue(undefined);
  vi.spyOn(api, "listCompareRuns").mockResolvedValue(RUNS as never);
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
    return vi.fn();
  });

  const rendered = render(
    <MemoryRouter>
      <CompareRoute />
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.listModelsForProvider).toHaveBeenCalledWith("p1"));
  fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
  fireEvent.change(screen.getByPlaceholderText("Prompt to send to all models…"), {
    target: { value: "Explain closures" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run compare" }));
  await waitFor(() => expect(api.runCompare).toHaveBeenCalled());
  await columns(rendered.container);
  return rendered;
}

/**
 * The two result columns, reached through a control *inside* them rather
 * than by class, so this cannot return a grid that is not on the page. It
 * is also the non-vacuity control for every walk below: `render()` returns
 * before the provider list lands, and a walk taken then sees a page with
 * no columns, no controls and nothing to fail.
 */
async function columns(container: HTMLElement): Promise<HTMLElement[]> {
  const stop = await within(container).findAllByRole("button", { name: /^Stop model / });
  expect(stop.length, "two columns must be on the page").toBe(2);
  const grid = stop[0].closest("div.grid");
  expect(grid, "the columns must be laid out by a grid").toBeTruthy();
  const cards = Array.from(grid!.children);
  expect(cards.length, "the grid must really have two children").toBe(2);
  return cards as HTMLElement[];
}

describe("CompareRoute density: the standard rhythm, measured", () => {
  it("spaces the history cards at the standard rhythm, and not the compact one", async () => {
    const { container } = await renderRunning();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const dialog = await screen.findByRole("dialog");
    // By `<li>`, not by button: the dialog carries its own Close button and
    // counting buttons would make this test depend on the primitive's
    // furniture rather than on the page's list.
    const list = await waitFor(() => {
      const found = dialog.querySelector("ul");
      expect(found, "the history list must be a <ul>").toBeTruthy();
      return found!;
    });
    expect(list.children.length, "the history list must really have two rows").toBe(2);
    const rows = Array.from(list.children).map((li) => li.firstElementChild!);
    expect(rows.every((r) => r.tagName === "BUTTON"), "a history row must be a button").toBe(true);

    const standard = await standardRhythm();
    const compact = await compactRhythm();
    // Read out of the stylesheet the build produces, from the classes the
    // page rendered. `space-y-2` and `p-3` are the current spellings; the
    // assertion is about eight and twelve pixels, and any other spelling of
    // those numbers would pass without an edit.
    expect(await pxOn(list as Element, /^space-y-/, "margin-top")).toBe(standard.gap);
    expect(await pxOn(rows[0], /^p-/, "padding")).toBe(standard.pad);
    // The load-bearing half, and the reason equality is not a free pass: a
    // page that quietly adopted the compact rhythm reads strictly less than
    // this on both axes, and must fail here.
    expect(await pxOn(list as Element, /^space-y-/, "margin-top")).toBeGreaterThan(compact.gap);
    expect(await pxOn(rows[0], /^p-/, "padding")).toBeGreaterThan(compact.pad);
  });

  it("insets each result column by the standard 12px, and gutters no tighter than the standard step", async () => {
    const { container } = await renderRunning();
    const [first] = await columns(container);
    const grid = first.parentElement!;
    const standard = await standardRhythm();
    const compact = await compactRhythm();

    // The column card is a *frame* — it clips its content and carries the
    // border, so the padding belongs to the content region inside it. Which
    // region that is, is discovered by asking which descendant declares a
    // padding at all, rather than by looking for a class name: a test that
    // looked for `p-3` would pass for a page that merely had one `p-3`
    // somewhere in the column, and fail for one that inset its content by
    // 12px a different way.
    const content = await firstPaddedDescendant(first);
    expect(await pxOn(content, /^p-/, "padding")).toBe(standard.pad);
    // 12px, not the standard 8px step, and deliberately: this gutter
    // separates two full-height columns of prose rather than two rows, and
    // a hairline gutter between two side-by-side answers reads as one
    // column. So the assertion is "at least the standard step", not "equal
    // to it" — and the floor is the standard step, not the compact one.
    const gutter = await pxOn(grid, /^gap-/, "gap");
    expect(gutter).toBeGreaterThanOrEqual(standard.gap);
    expect(gutter).toBeGreaterThan(compact.gap);
  });

  it("tells the two rhythms apart, because a measurement that cannot is not one", async () => {
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    // The two really are different, so the comparisons above are not
    // comparing a number with itself.
    expect(compact.gap).toBeLessThan(standard.gap);
    expect(compact.pad).toBeLessThan(standard.pad);

    // The same code, run over a fixture built at each rhythm.
    const read = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host;
    };
    const standardHost = read('<ul class="space-y-2"><li class="p-3"></li></ul>');
    expect(await pxOn(standardHost.querySelector("ul")!, /^space-y-/, "margin-top")).toBe(standard.gap);
    expect(await pxOn(standardHost.querySelector("li")!, /^p-/, "padding")).toBe(standard.pad);
    const compactHost = read('<ul class="space-y-1"><li class="p-2"></li></ul>');
    expect(await pxOn(compactHost.querySelector("ul")!, /^space-y-/, "margin-top")).toBe(compact.gap);
    expect(await pxOn(compactHost.querySelector("li")!, /^p-/, "padding")).toBe(compact.pad);

    // A class the page does not use is a failure, not a zero. This is what
    // keeps the resolver honest: without it, a typo in a class name would
    // read as "no padding at all" and sail through as the denser rhythm.
    const typo = document.createElement("ul");
    typo.className = "space-y-2x";
    await expect(pxOn(typo, /^space-y-/, "margin-top")).rejects.toThrow();
    // And a page with no rhythm at all is a failure too.
    const bare = document.createElement("ul");
    await expect(pxOn(bare, /^space-y-/, "margin-top")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, and no literal colour.
 *
 * The reference is flat: a card is a surface and a 1px border, and a
 * shadow on a result column is a regression against that rather than a
 * finishing touch. The only `box-shadow` in this design belongs to things
 * that genuinely float — a modal, a dropdown, a tooltip — and both of the
 * things on this page that float are asserted separately below.
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

describe("CompareRoute stays flat", () => {
  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = await renderRunning();
    // Awaited, and this is not tidiness. `render()` returns before the
    // provider list lands, so a walk taken immediately sees a page with no
    // columns and no controls on it and reports a clean tree.
    await columns(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("lets the dialogs float, and only the dialogs", async () => {
    const { container } = await renderRunning();
    await columns(container);
    expect(paintForcing(container, ["box-shadow"])).toEqual([]);

    // The history dialog overlaps the page — a shadow is the only thing
    // separating an overlay from a card in the flow. Asserted so a later
    // "flatten everything" commit argues with a test rather than with taste.
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("dialog");
    expect(paintForcing(container, ["box-shadow"]).length).toBeGreaterThan(0);
  });

  it("scopes every focus ring to a state, so no control paints a shadow at rest", async () => {
    const { container } = await renderRunning();
    await columns(container);
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A *bare*
    // `ring-2` would put a shadow on every control at rest and the shadow
    // check would still call the page clean.
    //
    // `focus:` and `focus-visible:` both satisfy it. Which one a control
    // takes is a judgement: the prompt field takes `focus:`, because a
    // field should show where the caret is however it got there, and every
    // button takes `focus-visible:`, because clicking one acts immediately
    // and there is nothing left to disambiguate.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    const prompt = screen.getByPlaceholderText("Prompt to send to all models…");
    expect(classMatching(prompt, /ring-/)).toMatch(/^focus:ring-/);
    const stop = within((await columns(container))[0]).getByRole("button", { name: /^Stop model 1/ });
    expect(classMatching(stop, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // The negative control, so none of the checks above can pass by being
    // blind.
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
    // And the scopes really do differ.
    expect(paintForcing(host, ["transition"])).toHaveLength(2);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    const { container } = await renderRunning();
    await columns(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders inside a dialog is
    // covered too.
    const src = source("src/routes/CompareRoute.tsx");
    expect(src, "CompareRoute.tsx must not hardcode a colour").not.toMatch(COLOUR_LITERAL);
  });

  it("finds a literal colour when one is planted", () => {
    // The control. `COLOUR_LITERAL` is a regex on a class string, and a
    // regex that matches nothing is indistinguishable from a regex that
    // cannot match. Every literal is *assembled*: `tailwind.config.ts` globs
    // this test tree, so a written-out one ships as a dead production rule
    // with a literal colour in the built stylesheet.
    const planted = (...parts: string[]) => parts.join("");
    expect(planted("bg-[", "#", "ff0000", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("shadow-[rgb", "(1,2,3)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("text-[hsl", "(210,50%,40%)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("border-[oklch", "(0.7_0.1_200)", "]")).toMatch(COLOUR_LITERAL);
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/10", "text-group-header"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The shared vocabulary, and the controls the restyle had to keep.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("CompareRoute in the shared vocabulary", () => {
  it("gives every box a theme radius, so a theme that reshapes the app reshapes the cards", async () => {
    const { container } = await renderRunning();
    await columns(container);
    await prewarm(container);
    // Scoped by "draws a box on every side" — a bare `border` class, not
    // any `border-*`. Keying on the border rather than on a radius class is
    // what lets a card that *lost* its radius fail instead of quietly
    // dropping out of the walk; keying on `border` rather than `border-b` is
    // what keeps the column's *rule*-carrying header, which has no radius
    // and is not a box, from being demanded one.
    const radii = new Set<string>();
    for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
      if (!el.classList.contains("border")) continue;
      const radius = classMatching(el, /^rounded-/);
      const decls = (await emitted([radius])).get(radius)!;
      expect(declValue(decls, "border-radius", radius), `${radius} on <${el.tagName.toLowerCase()}>`)
        .toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
      radii.add(radius);
    }
    // A control against its own vacuity: the walk saw more than one kind of
    // box, and not merely the card it started from.
    expect(radii.size).toBeGreaterThan(1);
  });

  it("keeps every column control at or above the minimum target size, and named", async () => {
    const { container } = await renderRunning();
    const cards = await columns(container);
    await prewarm(container);
    // The two controls that only exist while a column runs.
    for (const stop of within(container).getAllByRole("button", { name: /^Stop model / })) {
      expect(await pxOn(stop, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(stop, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      expect(stop).toHaveAttribute("type", "button");
    }
    // The two model-removal controls in the picker. They carried a text
    // glyph and nothing else; they are an icon now, and the glyph is gone
    // rather than left beside it.
    for (const remove of within(container).getAllByRole("button", { name: /^Remove model / })) {
      expect(await pxOn(remove, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(remove, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      expect(remove.textContent).toBe("");
    }

    // The winner control only appears once every column is done, which is a
    // separate subtree from the one above — a fix to one says nothing about
    // the rest, so it is reached by actually finishing the run.
    for (const index of [0, 1]) {
      await act(async () => {
        callbacks["compare-done"]({
          payload: { run_id: "run-1", index, done: true, prompt_tokens: 10, output_tokens: 20 },
        });
      });
    }
    // `act` flushes microtasks; the compare queue batches on a real
    // animation frame, which in jsdom is a ~16ms timer. So `waitFor` is what
    // waits for the frame, and it is also the assertion that the run really
    // reached "every column is done" — the state that puts a winner control
    // on each card.
    const picks = await within(container).findAllByRole("button", { name: /^Pick .* as winner$/ });
    expect(picks).toHaveLength(2);
    expect(within(container).getByRole("button", { name: "Pick A as winner" })).toBeInTheDocument();
    for (const pick of picks) {
      expect(await pxOn(pick, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(pick, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      expect(pick).toHaveAttribute("type", "button");
    }
    expect(cards).toHaveLength(2);
  });

  it("still switches blind mode on the control the cluster now owns", async () => {
    const { container } = await renderRunning();
    await columns(container);
    // In blind mode the column headers are A and B, not model names.
    expect(within(container).getByText("A")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Blind" });
    // The button's name is the mode it is currently in, and it is in "Blind",
    // so it is pressed. This asserted `"false"` for the whole of the first
    // round, which pinned the pre-existing inversion rather than the
    // behaviour: it was `aria-pressed={!blind}`, so the state announced was
    // the opposite of the state the control was in. Corrected in the route
    // and re-pinned here, so a re-inversion is red. The agreement itself is
    // the next test; this one is here because the control's metrics are.
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The primitive, not a hand-written control that happens to look like
    // one: it resolves to the same metrics as the button beside it.
    await prewarm(container);
    const history = screen.getByRole("button", { name: "History" });
    expect(await pxOn(toggle, /^px-/, "padding-left")).toBe(await pxOn(history, /^px-/, "padding-left"));
    expect(await pxOn(toggle, /^py-/, "padding-top")).toBe(await pxOn(history, /^py-/, "padding-top"));
    expect(await fontSizeOf(toggle)).toBe(await fontSizeOf(history));

    // The control on the comparison, and it has to be a control *on the
    // page*: the reveal cluster's `size="md"` button, which exists only once
    // the run is finished. Comparing against a class list read out of the
    // config would prove that Tailwind can be asked for 12px, which is not
    // the claim.
    for (const index of [0, 1]) {
      await act(async () => {
        callbacks["compare-done"]({
          payload: { run_id: "run-1", index, done: true, prompt_tokens: 10, output_tokens: 20 },
        });
      });
    }
    const reveal = await screen.findByRole("button", { name: /Reveal & pick winner/ });
    expect(await pxOn(reveal, /^px-/, "padding-left")).not.toBe(await pxOn(toggle, /^px-/, "padding-left"));
    expect(await fontSizeOf(reveal)).not.toBe(await fontSizeOf(toggle));

    // …and pressing it still flips both the name and the pinned state, so
    // the cluster control is not a decoration over dead state.
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: "Labeled" })).toHaveAttribute("aria-pressed", "false");
    // With the labels on, the headers carry the model name rather than A/B.
    expect(within(container).getAllByText("model").length).toBeGreaterThan(0);
  });

  it("announces blind mode's state, and it agrees with the mode the control is in", async () => {
    const { container } = await renderRunning();
    await columns(container);

    // The claim is not "the attribute has some value" — it is that the value
    // a screen reader is given is the state the page is actually in, and the
    // state is observable in the column headers: in blind mode they are `A`
    // and `B`, and with the labels on they are the model name. So all three
    // are read: the header, the name, and the pressed state.
    const pressOf = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");

    // Read the state off a *column header*, not off the page. The model
    // picker above already shows "model" twice, so a page-wide text query
    // for the same string matches the wrong thing — which is the V44 shape
    // one level up: a query that cannot tell which instance it is looking
    // at. Scoped to a card it is unambiguous.
    const [card] = await columns(container);
    const blind = pressOf("Blind");
    expect(within(card).getByText("A"), "blind mode labels the columns A and B").toBeInTheDocument();
    expect(within(card).queryByText("model"), "…and not by model name").not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Blind" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Labeled" })).toBeInTheDocument());
    const labelled = pressOf("Labeled");
    expect(within(card).getByText("model"), "revealing puts the model name back").toBeInTheDocument();
    expect(within(card).queryByText("A"), "…and takes the letter away").not.toBeInTheDocument();

    // Blind is the default and it is on, so the control named "Blind" is
    // pressed and the one named "Labeled" is not. It was the other way
    // round for the whole of the first round: `aria-pressed={!blind}`, so a
    // screen reader was told "Blind, not pressed" while blind mode was on —
    // and blind mode is what decides whether the model labels in this
    // comparison are visible at all.
    expect(blind).toBe("true");
    expect(labelled).toBe("false");
    // The control on the agreement. The two assertions above each pass for
    // *one* of two values, so an `aria-pressed` frozen at a constant would
    // satisfy one of them; asserting that the two differ is what makes
    // "tracks the state" true rather than plausible.
    expect(blind).not.toBe(labelled);
  });

  it("still stops one column without stopping the run", async () => {
    const { container } = await renderRunning();
    await columns(container);
    fireEvent.click(within(container).getByRole("button", { name: "Stop model 2" }));
    await waitFor(() => expect(api.cancelCompareColumn).toHaveBeenCalledWith("run-1", 1));
    expect(api.cancelCompare).not.toHaveBeenCalled();
    // The column says it stopped rather than going blank.
    expect(await within(container).findByText("Stopped")).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position, so
 * `h1` followed by `h3` is a defect rather than a nit. `RouteShell` owns
 * this page's `h1`, and the empty state and the two dialogs are separate
 * subtrees, so all three are walked.
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

describe("CompareRoute heading outline", () => {
  it("skips no heading level in any state the page can be in", async () => {
    // 1 — a run in progress, which is the only state with no heading but
    // the page's own.
    const running = await renderRunning();
    await columns(running.container);
    expectNoHeadingSkip(running.container, "a running comparison");

    // 2 — nothing run yet. The empty state's title is a heading, and it is
    // the one the primitive got wrong by default.
    cleanup();
    vi.spyOn(api, "listProviders").mockResolvedValue([]);
    vi.mocked(listen).mockResolvedValue(vi.fn());
    const empty = render(
      <MemoryRouter>
        <CompareRoute />
      </MemoryRouter>,
    );
    await screen.findByText("No comparison yet");
    expectNoHeadingSkip(empty.container, "no comparison yet");
    expect(await screen.findByRole("heading", { name: "No comparison yet" })).toHaveProperty("tagName", "H2");

    // 3 — the history dialog. A `Modal` renders its own `h2`, so a dialog
    // title lands at a level under the page's rather than beside it.
    cleanup();
    const withHistory = await renderRunning();
    await columns(withHistory.container);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(withHistory.container, "the history dialog");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Compare models</h1><h3>No comparison yet</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Compare models</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });
});

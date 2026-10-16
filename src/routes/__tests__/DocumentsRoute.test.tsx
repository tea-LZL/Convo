import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { DiffPreview, DocumentsRoute } from "../DocumentsRoute";
import repoTailwind from "../../../tailwind.config";

/* ═══════════════════════════════════════════════════════════════════════
 * Measuring the page, not spelling it.
 *
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two rows?* The tempting substitute is
 * `expect(strip.className).toContain("gap-1")`, and it is the wrong test
 * twice over. It pins a class name, which is an implementation detail that
 * the next task will change for no reason, and it passes for any page that
 * merely *says* `gap-1` — including one that got denser using something
 * else entirely.
 *
 * So the numbers below come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that comes
 * out. A tab is 8px inside whether it says `px-2`, `p-2`, or something a
 * later task invents; a class that does not exist emits no rule at all,
 * which is a loud failure here rather than a silent zero.
 *
 * The resolver is duplicated from `MemoryRoute.test.tsx`,
 * `NotesRoute.test.tsx` and `CompareRoute.test.tsx` on purpose. A shared
 * test helper would be five commits touching one file, and the whole point
 * of the one-commit-per-route rule is that a reviewer who dislikes one
 * page's treatment can reject that commit alone.
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
      // Custom properties are machinery, not geometry, and reading one as a
      // length would be nonsense.
      if (!prop || prop.startsWith("--")) continue;
      decls.set(prop, d.slice(colon + 1).trim());
    }
    byClass.set(name, decls);
  }
  return byClass;
}

/** Compile `classNames` through the project Tailwind, once. */
async function compileOnce(classNames: string[]): Promise<string> {
  // `tailwindcss` bundles its own copy of postcss, so its plugin type is not
  // nominally the `postcss` this repo depends on — two installs of one
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
 * Every radius declaration a class emits, read out of the build.
 *
 * Not just `border-radius`: a corner class like `rounded-t-lg` emits
 * `border-top-left-radius` and `border-top-right-radius` and nothing
 * else, so a check that read the shorthand would throw on it and the
 * element would quietly leave the walk.
 */
async function radiusValues(cls: string): Promise<string[]> {
  const decls = (await emitted([cls])).get(cls)!;
  const values = [...decls.entries()]
    .filter(([prop]) => prop.endsWith("-radius"))
    .map(([, value]) => value);
  if (values.length === 0) throw new Error(`${cls} emits no radius at all; the class does not exist`);
  return values;
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

const READ_ME = {
  id: "doc-1",
  title: "Readme",
  content: "Original content",
  kind: "markdown" as const,
  language: null,
  file_path: null,
  created_at: "now",
  updated_at: "now",
};

describe("DocumentsRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listDocuments").mockResolvedValue([READ_ME]);
    vi.spyOn(api, "upsertDocument").mockResolvedValue("doc-1");
    vi.spyOn(api, "deleteDocument").mockResolvedValue(undefined);
  });

  it("shows persistence type and saves DB-backed drafts without losing content", async () => {
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByText("DB-backed")).toBeInTheDocument();
    const editor = screen.getByDisplayValue("Original content");
    fireEvent.change(editor, { target: { value: "Draft content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(api.upsertDocument).toHaveBeenCalledWith(expect.objectContaining({
      id: "doc-1",
      content: "Draft content",
    })));
  });

  it("keeps document tabs keyboard-accessible without nesting the close action", async () => {
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("tab", { name: "Readme" })).toHaveAttribute("aria-controls", "document-panel-doc-1");
    expect(screen.getByRole("button", { name: "Close Readme" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Title")).toHaveAttribute("aria-label", "Document title");
    expect(screen.getByRole("button", { name: "More document actions" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Readme" }).querySelector("button")).toBeNull();
  });

  it("keeps a dirty draft when persistence fails", async () => {
    vi.mocked(api.upsertDocument).mockRejectedValue(new Error("read only"));
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue("Original content")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Original content"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(screen.getByDisplayValue("Keep this draft")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("read only");
  });

  it("shows a retryable empty-state load error", async () => {
    vi.mocked(api.listDocuments).mockRejectedValue(new Error("database offline"));
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("database offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The restyle's guards.
 *
 * Every one is written to fail if the thing it guards is removed, and every
 * walk either proves the subtree was there or throws.
 * ═══════════════════════════════════════════════════════════════════════ */

const SECOND = {
  id: "doc-2",
  title: "Changelog",
  content: "Second document",
  kind: "markdown" as const,
  language: null,
  file_path: null,
  created_at: "now",
  updated_at: "now",
};

function serveDocuments(docs: unknown[] = [READ_ME]) {
  vi.spyOn(api, "listDocuments").mockResolvedValue(docs as never);
  vi.spyOn(api, "upsertDocument").mockResolvedValue("doc-1");
  vi.spyOn(api, "deleteDocument").mockResolvedValue(undefined);
}

const renderDocuments = () =>
  render(
    <MemoryRouter>
      <DocumentsRoute />
    </MemoryRouter>,
  );

/**
 * The tab strip, reached through a control *inside* it rather than by class,
 * so this cannot return a strip that is not on the page. It is also the
 * non-vacuity control for every walk below: `render()` returns before the
 * document list lands, and a walk taken then sees a page with no tabs on it.
 */
async function tabStrip(container: HTMLElement): Promise<HTMLElement> {
  const tab = await within(container).findByRole("tab", { name: /Readme/ });
  const strip = tab.closest("[role='tablist']");
  expect(strip, "the tabs must hang off one tablist").toBeTruthy();
  expect(
    await within(strip as HTMLElement).findByRole("button", { name: "Close Changelog" }),
    "the strip must really have two tabs on it",
  ).toBeTruthy();
  return strip as HTMLElement;
}

describe("DocumentsRoute density: the compact rhythm, measured", () => {
  beforeEach(() => serveDocuments([READ_ME, SECOND]));

  it("spaces the tab strip tighter than the standard rhythm every other page uses", async () => {
    const { container } = renderDocuments();
    const strip = await tabStrip(container);
    const tab = within(strip).getByRole("tab", { name: /Readme/ });
    const compact = await compactRhythm();
    const standard = await standardRhythm();

    // Read out of the stylesheet the build produces, from the classes the
    // page rendered. `gap-1` and `px-2` are the current spellings; the
    // assertion is about four and eight pixels, and any other spelling of
    // those numbers would pass without an edit.
    const gutter = await pxOn(strip, /^gap-/, "gap");
    const inset = await pxOn(tab, /^px-/, "padding-left");
    expect(gutter).toBe(compact.gap);
    expect(inset).toBe(compact.pad);
    // The load-bearing half, and the reason the equalities above are not
    // free passes: the standard rhythm reads strictly higher on both axes,
    // and a page that drifted back to it must fail here.
    expect(gutter).toBeLessThan(standard.gap);
    expect(inset).toBeLessThan(standard.pad);
    // And it is a rhythm, not nothing: tabs whose edges touch read as one
    // control rather than as a list of documents.
    expect(gutter).toBeGreaterThan(0);
  });

  it("keeps the editor canvas at the standard padding, because prose is not a list row", async () => {
    const { container } = renderDocuments();
    const strip = await tabStrip(container);
    const tab = within(strip).getByRole("tab", { name: /Readme/ });
    const editor = tab.getAttribute("aria-controls")!;
    const canvas = container.querySelector(`#${editor}`)!.querySelector("textarea")!;
    // The compact rhythm is about how many *rows* fit. The canvas is a page
    // of prose and it is the one thing on this page a user reads at length,
    // so tightening it would be the density split misapplied rather than
    // applied. Asserted as a comparison, not as a number, so a retune moves
    // both sides.
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    const inset = await pxOn(canvas, /^p-/, "padding");
    expect(inset).toBeGreaterThan(standard.pad);
    expect(inset).toBeGreaterThan(compact.pad);
    // The control on the comparison: the tab the canvas sits beside really
    // is the compact 8px, so the canvas is not reading the same number by
    // accident.
    expect(await pxOn(tab, /^px-/, "padding-left")).toBeLessThan(inset);
  });

  it("tells the two rhythms apart, because a measurement that cannot is not one", async () => {
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    // The two really are different, so the comparisons above are not
    // comparing a number with itself.
    expect(compact.gap).toBeLessThan(standard.gap);
    expect(compact.pad).toBeLessThan(standard.pad);

    // The same code, run over a fixture built at each rhythm. The strip's
    // step is a `gap` and the tab's inset is a `padding-left`, because a
    // tab is a box in a row and the row's step is a gutter — the same two
    // properties the page's own strip and tab are read through.
    const read = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host;
    };
    const standardHost = read('<div class="gap-2"></div><div class="p-3"></div>');
    expect(await pxOn(standardHost.children[0], /^gap-/, "gap")).toBe(standard.gap);
    expect(await pxOn(standardHost.children[1], /^p-/, "padding")).toBe(standard.pad);
    const compactHost = read('<div class="gap-1"></div><div class="p-2"></div>');
    expect(await pxOn(compactHost.children[0], /^gap-/, "gap")).toBe(compact.gap);
    expect(await pxOn(compactHost.children[1], /^p-/, "padding")).toBe(compact.pad);

    // A class the page does not use is a failure, not a zero. This is what
    // keeps the resolver honest: without it, a typo in a class name would
    // read as "no padding at all" and sail through as compact.
    const typo = document.createElement("div");
    typo.className = "gap-1x";
    await expect(pxOn(typo, /^gap-/, "gap")).rejects.toThrow();
    // And a page with no rhythm at all is a failure too.
    const bare = document.createElement("div");
    await expect(pxOn(bare, /^gap-/, "gap")).rejects.toThrow();
    // A `var()` is not a number either: reading one as a length is the lie
    // this block exists to avoid, and it throws rather than guessing.
    await expect(pxOn(standardHost.children[1], /^rounded-/, "border-radius")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, and no literal colour or hardcoded radius.
 *
 * The reference is flat: a card is a surface and a 1px border, and a shadow
 * on a tab is a regression against that rather than a finishing touch. The
 * only `box-shadow` in this file belongs to things that genuinely float —
 * the two modals and the dropdown menu.
 * ═══════════════════════════════════════════════════════════════════════ */

const PAINT_UTILS: { label: string; re: RegExp }[] = [
  { label: "box-shadow", re: /^(shadow|drop-shadow)(-|$)/ },
  { label: "filter", re: /^(blur|brightness|contrast|grayscale|invert|saturate|sepia|hue-rotate|backdrop-)(-|$)/ },
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
    const m = (el.getAttribute("style") ?? "").match(/(?:^|;)\s*(box-shadow|filter)\s*:/);
    if (m) {
      const label = m[1].startsWith("box-shadow") ? "box-shadow" : "filter";
      if (kinds.includes(label)) found.push(`<${el.tagName.toLowerCase()}> declares inline ${m[1]}`);
    }
  }
  return found;
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(\s*in\s*(srgb|rgb)\b/i;

/**
 * A bare number, or a px string, as an inline radius.
 *
 * The class half of "every radius is a theme var" is a DOM walk. The inline
 * half cannot be one, because the only element here whose radius is set in
 * an inline style is a syntax-highlighted code block, and that exists only
 * once a document containing a fence is being previewed — one of three
 * states, which makes a DOM guard a guard that mostly does not run. So this
 * is a source sweep, and it is honest about being one.
 */
const HARDCODED_INLINE_RADIUS = /borderRadius:\s*["']?(?:\d|\d+(?:\.\d+)?px)/;

describe("DocumentsRoute stays flat", () => {
  beforeEach(() => serveDocuments([READ_ME, SECOND]));

  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = renderDocuments();
    // Awaited, and this is not tidiness. `render()` returns before the
    // document list lands, so a walk taken immediately sees a page with no
    // tabs and no controls on it and reports a clean tree.
    await tabStrip(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("lets the dialogs float, and only the dialogs", async () => {
    const { container } = renderDocuments();
    await tabStrip(container);
    expect(paintForcing(container, ["box-shadow"])).toEqual([]);

    // The AI-edit dialog overlaps the page — a shadow is the only thing
    // separating an overlay from a card in the flow. Asserted so a later
    // "flatten everything" commit argues with a test rather than with taste.
    fireEvent.click(within(container).getByRole("button", { name: "More document actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ask AI to edit/ }));
    await screen.findByRole("dialog");
    expect(paintForcing(container, ["box-shadow"]).length).toBeGreaterThan(0);
  });

  it("scopes every focus ring to a state, so no control paints a shadow at rest", async () => {
    const { container } = renderDocuments();
    const strip = await tabStrip(container);
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A *bare*
    // `ring-2` would put a shadow on every control at rest and the shadow
    // check would still call the page clean.
    //
    // `focus:` and `focus-visible:` both satisfy it. Which one a control
    // takes is a judgement: the title field takes `focus-visible:`, because
    // it is committed on blur rather than on Enter, and the tabs take it too
    // because clicking one switches immediately.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    const tab = within(strip).getByRole("tab", { name: /Readme/ });
    expect(classMatching(tab, /ring-/)).toMatch(/^focus-visible:ring-/);
    const close = within(strip).getByRole("button", { name: "Close Readme" });
    expect(classMatching(close, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("reports a shadow, a filter and an inline shadow when one is present", () => {
    // The negative control, so the checks above cannot pass by being blind.
    // The inline shadow is assembled rather than written out, for the same
    // reason the colour control assembles its literals: `tailwind.config.ts`
    // globs this test tree, so a written-out one ships as a dead production
    // rule.
    const planted = (...parts: string[]) => parts.join("");
    const host = document.createElement("div");
    host.innerHTML = [
      '<div class="shadow-panel"></div>',
      '<div class="hover:shadow-lg"></div>',
      '<div class="blur-sm"></div>',
      '<div style="filter: blur(1px)"></div>',
      `<div style="box-shadow: 0 1px 2px ${planted("rgb", "(0 0 0 / 0.2)")}"></div>`,
      '<div class="bg-surface-2 border border-border"></div>',
    ].join("");

    const all = paintForcing(host, ["box-shadow", "filter"]);
    expect(all.filter((f) => f.includes("shadow-panel"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("shadow-lg"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("blur-sm"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline filter"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline box-shadow"))).toHaveLength(1);
    expect(all).toHaveLength(5);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    const { container } = renderDocuments();
    await tabStrip(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders behind a dialog or inside
    // a code block is covered too.
    const src = source("src/routes/DocumentsRoute.tsx");
    expect(src, "DocumentsRoute.tsx must not hardcode a colour").not.toMatch(COLOUR_LITERAL);
  });

  it("hardcodes no radius in an inline style, so the code block follows its theme", () => {
    // The syntax highlighter takes its geometry as an inline style, and for
    // the whole of this plan that object carried `borderRadius: 10` — the
    // only card in the app whose radius no theme could reach. It is now a
    // `var(--radius-*)`, which is a variable rather than a smaller number.
    const src = source("src/routes/DocumentsRoute.tsx");
    expect(src, "DocumentsRoute.tsx must not hardcode an inline radius").not.toMatch(HARDCODED_INLINE_RADIUS);
    // …and the object really is there, so the sweep is not passing on a file
    // that had stopped rendering a code block.
    expect(src).toMatch(/customStyle=\{\{/);
    expect(src).toMatch(/borderRadius: "var\(--radius-/);
    // The control. A regex that matches nothing is indistinguishable from a
    // regex that cannot match.
    expect('customStyle={{ borderRadius: 10 }}').toMatch(HARDCODED_INLINE_RADIUS);
    expect('customStyle={{ borderRadius: "10px" }}').toMatch(HARDCODED_INLINE_RADIUS);
    expect('customStyle={{ borderRadius: "var(--radius-lg)" }}').not.toMatch(HARDCODED_INLINE_RADIUS);
  });

  it("finds a literal colour when one is planted", () => {
    // The control for `COLOUR_LITERAL`. Every literal is *assembled*:
    // `tailwind.config.ts` globs this test tree, so a written-out one ships
    // as a dead production rule with a literal colour in the stylesheet.
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
 * The shared vocabulary, and the behaviour the restyle had to keep.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("DocumentsRoute in the shared vocabulary", () => {
  beforeEach(() => serveDocuments([READ_ME, SECOND]));

  it("gives every box a theme radius, so a theme that reshapes the app reshapes the cards", async () => {
    const { container } = renderDocuments();
    await tabStrip(container);
    await prewarm(container);
    // Two walks, because one was not enough — and the second exists because
    // a mutation proved the first was blind.
    //
    // (a) *Every box draws a theme radius.* Scoped by "draws a box on every
    // side" — a bare `border` class, not any `border-*`. Keying on the
    // border rather than on a radius class is what lets a card that *lost*
    // its radius fail instead of quietly dropping out of the walk; keying on
    // `border` rather than `border-b` is what keeps the strip's
    // *rule*-carrying rows, which have no radius and are not boxes, from
    // being demanded one.
    //
    // (b) *Every radius on the page is a theme radius.* (a) cannot see the
    // tab strip's group wrapper, which carries `rounded-t-lg` and no border
    // — replacing it with `rounded-none` came back green. (b) covers every
    // element that has a radius at all, so a hardcoded one is caught whether
    // or not the element it is on is also a box.
    const radii = new Set<string>();
    for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
      const isBox = el.classList.contains("border");
      const hasRadius = Array.from(el.classList).some((c) => c.startsWith("rounded-"));
      if (!isBox && !hasRadius) continue;
      const radius = classMatching(el, /^rounded-/);
      for (const value of await radiusValues(radius)) {
        expect(value, `${radius} on <${el.tagName.toLowerCase()}>`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
      }
      if (isBox) radii.add(radius);
    }
    // A control against its own vacuity: walk (a) saw more than one kind of
    // box, and not merely the tab it started from. The two `kbd` chips are
    // here, and they are the two that were on a hardcoded `rounded`.
    expect(radii.size).toBeGreaterThan(1);
    expect(within(container).getByText("Ctrl+S").className).toMatch(/rounded-sm/);
    // …and walk (b) really reached the one element (a) cannot: the tab
    // strip's group wrapper, which is not a box.
    const wrapper = (await tabStrip(container)).querySelector("[role='tab']")!.parentElement!;
    expect(wrapper.className).toMatch(/rounded-t-/);
    expect(wrapper.className).not.toMatch(/rounded-none/);
  });

  it("gives the preview's inline-code chip a theme radius, and switches the preview on to see it", async () => {
    // The third state, and the one a radius guard that only looks at the
    // editor misses: in preview mode a Markdown inline code span is
    // re-composed as a chip by this route's own `code` renderer, and it was
    // on a bare `rounded` — 4px, no theme. Nothing above could see it, since
    // the chip exists only once a document with inline code is being
    // previewed, so it gets its own fixture and its own assertion.
    const withCode = { ...READ_ME, id: "doc-code", title: "Snippet", content: "Call `npm test` before pushing." };
    serveDocuments([READ_ME, SECOND, withCode]);
    const { container } = renderDocuments();
    await tabStrip(container);
    fireEvent.click(within(container).getByRole("tab", { name: /Snippet/ }));
    fireEvent.click(within(container).getByRole("button", { name: "Preview" }));

    const chip = await screen.findByText("npm test");
    expect(chip.tagName, "the preview composes inline code as a <code> chip").toBe("CODE");
    const radius = classMatching(chip, /^rounded-/);
    for (const value of await radiusValues(radius)) {
      expect(value, `${radius} on the inline-code chip`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
    }
  });

  it("gives the diff card a theme radius too, and reaches it where it renders", async () => {
    // The diff card only exists inside the AI-edit preview, which needs a
    // generated edit before it opens. A radius guard that only ran in one of
    // three states was blind: replacing this card's `rounded-lg` with a
    // hardcoded 7px came back green. `DiffPreview` is exported from the route
    // module precisely so it can be rendered on its own, and the radius is
    // the same card either way.
    const { container } = render(
      <MemoryRouter>
        <DiffPreview original="old" proposed="new" />
      </MemoryRouter>,
    );
    await prewarm(container);
    const card = container.firstElementChild!.firstElementChild!.nextElementSibling!;
    expect(card.tagName).toBe("DIV");
    const radius = classMatching(card, /^rounded-/);
    for (const value of await radiusValues(radius)) {
      expect(value, `${radius} on the diff card`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
    }
  });

  it("keeps the close control at or above the minimum target size", async () => {
    const { container } = renderDocuments();
    const strip = await tabStrip(container);
    await prewarm(container);
    // It was a `×` glyph with half a pixel of padding either side, which is
    // about 14px. Every tab carries one, so this is the control a user hits
    // most on this page.
    for (const name of ["Close Readme", "Close Changelog"]) {
      const close = within(strip).getByRole("button", { name });
      expect(await pxOn(close, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(close, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      expect(close).toHaveAttribute("type", "button");
      // An icon-only control needs a hover affordance as well as a name:
      // `aria-label` is what a screen reader reads and `title` is what a
      // sighted mouse user reads, and neither substitutes for the other.
      expect(close).toHaveAttribute("title", name);
      // The glyph is an icon now, and the old text glyph is gone rather
      // than left beside it.
      expect(close.textContent).toBe("");
    }
  });

  it("still keeps the close action out of the tab, and still says which file a tab is", async () => {
    const { container } = renderDocuments();
    const strip = await tabStrip(container);
    // A close button nested in a tab is a nested interactive control: a
    // screen reader reaches it twice, and Tab lands on it on the way to the
    // next tab. The existing test asserts it and it still holds.
    const tab = within(strip).getByRole("tab", { name: /Readme/ });
    expect(tab.querySelector("button")).toBeNull();
    // The strip is labelled, and each tab points at its own panel.
    expect(strip).toHaveAttribute("aria-label", "Open documents");
    expect(tab).toHaveAttribute("aria-controls", "document-panel-doc-1");
    expect(within(strip).getByRole("tab", { name: /Changelog/ })).toHaveAttribute("aria-selected", "false");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position, so
 * `h1` followed by `h3` is a defect rather than a nit. This page has three
 * distinct shells — loading, the empty workspace, and the editor — and the
 * empty one is the only one with a second heading, so all three are walked.
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

describe("DocumentsRoute heading outline", () => {
  it("skips no heading level in any state the page can be in", async () => {
    // 1 — the editor, which is where a user spends their time and the only
    // state with no heading but the page's own.
    serveDocuments([READ_ME, SECOND]);
    const editor = renderDocuments();
    await tabStrip(editor.container);
    expectNoHeadingSkip(editor.container, "the editor");

    // 2 — the empty workspace, a different shell entirely. Its title is the
    // one the primitive got wrong by default.
    cleanup();
    serveDocuments([]);
    const empty = renderDocuments();
    await screen.findByText("No document open");
    expectNoHeadingSkip(empty.container, "the empty workspace");
    expect(await screen.findByRole("heading", { name: "No document open" })).toHaveProperty("tagName", "H2");

    // 3 — the AI-edit dialog, the last heading-bearing subtree left. A
    // `Modal` renders its own `h2`, so a dialog title lands at a level under
    // the page's rather than beside it.
    cleanup();
    serveDocuments([READ_ME, SECOND]);
    const dialog = renderDocuments();
    await tabStrip(dialog.container);
    fireEvent.click(within(dialog.container).getByRole("button", { name: "More document actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ask AI to edit/ }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(dialog.container, "the AI edit dialog");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Documents</h1><h3>No document open</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Documents</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });
});

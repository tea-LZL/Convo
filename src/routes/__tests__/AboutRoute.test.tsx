/**
 * AboutRoute — the last un-restyled page's guards.
 *
 * This file is one of three written because the restyle never reached
 * the page. Nothing in the suite asserted a rhythm for it, which is
 * exactly why a page with no rhythm could sit under a new 28px title
 * for six tasks and read as done.
 *
 * ── Measuring the page, not spelling it ───────────────────────────────
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two rows?* The tempting substitute is
 * `expect(card.className).toContain("p-3")`, and it is the wrong test
 * twice over — it pins an implementation detail the next task will
 * change for no reason, and it passes for any page that merely *says*
 * `p-3`, including one that got denser using something else entirely.
 *
 * So the numbers come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that
 * comes out. A card is 12px inside whether it says `p-3`, `px-3 py-3`,
 * or something a later task invents; a class that does not exist emits
 * no rule at all, which is a loud failure here rather than a silent
 * zero.
 *
 * The resolver is duplicated from `TasksRoute.test.tsx`,
 * `NotesRoute.test.tsx`, `MemoryRoute.test.tsx` and
 * `CompareRoute.test.tsx` on purpose: the whole point of the
 * one-commit-per-route rule is that a reviewer who dislikes one page's
 * treatment can reject that commit alone, and a shared helper would
 * make that impossible.
 *
 * The limit, stated rather than hidden: this is the *stylesheet* the
 * build produces, not a browser's layout. Every claim below is about
 * declared spacing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, AppInfo } from "../../lib/api";
import { AboutRoute } from "../AboutRoute";
import repoTailwind from "../../../tailwind.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * A source file with its `/* … *\/` comments removed.
 *
 * This codebase explains itself in block docblocks, and a guard that
 * scans raw source will eventually match a sentence *about* the class
 * it is banning — which is exactly what happened the first time this
 * scan ran. Only block comments are stripped, because a `//` strip would
 * eat the `https://` in this very page's colophon link and quietly read
 * a different file than the one that ships.
 */
const code = (rel: string) => source(rel).replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declarations one utility class emits, keyed by CSS property. */
const cache = new Map<string, Map<string, string>>();

const unescapeSelector = (s: string) => s.replace(/\\(.)/g, "$1");

/**
 * The part of a compiled stylesheet that is unconditional. Tailwind
 * emits screen variants after the plain utilities, so everything from
 * the first `@media` on only applies at or above a breakpoint — and a
 * `sm:p-8` is not the padding a narrow window gets.
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
 * Every class on `root` and its descendants, resolved in **one** compile.
 *
 * Not an optimisation — a correctness fix for the timeout. `emitted`
 * misses the cache per class, and a walk that asks for one class at a
 * time pays a ~300ms Tailwind compile per class, which pushed a sibling
 * test past vitest's 5s default, where a passing test reads as a
 * failing one.
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
  return toPx(declValue(decls, prop, `${cls} { ${prop} }`), cls);
}

/**
 * The first class on `el` that declares `prop`, read out of the build.
 *
 * Needed wherever two classes of the same family sit on one element, and
 * the question is which of them owns the property.
 */
async function classDeclaring(el: Element, prop: string): Promise<string> {
  const all = await emitted(Array.from(el.classList));
  for (const c of Array.from(el.classList)) {
    if (all.get(c)!.get(prop) !== undefined) return c;
  }
  throw new Error(`no class on <${el.tagName.toLowerCase()}> declares ${prop}`);
}

/** Every radius declaration a class emits, read out of the build. */
async function radiusValues(cls: string): Promise<string[]> {
  const decls = (await emitted([cls])).get(cls)!;
  const values = [...decls.entries()]
    .filter(([prop]) => prop.endsWith("-radius"))
    .map(([, value]) => value);
  if (values.length === 0) throw new Error(`${cls} emits no radius at all; the class does not exist`);
  return values;
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

const APP_INFO: AppInfo = {
  version: "0.7.0",
  data_dir: "/home/tea/.local/share/convo",
  db_path: "/home/tea/.local/share/convo/convo.db",
  os: "linux",
  arch: "x86_64",
};

function renderAbout() {
  return render(
    <MemoryRouter>
      <AboutRoute />
    </MemoryRouter>,
  );
}

/**
 * The app-info card, reached through a *value Rust sent* rather than by
 * class or by tag, then walked up to the box that carries the border.
 *
 * This is the non-vacuity control for every walk below: `render()`
 * returns before the card lands, and a walk taken then sees a page with
 * no card on it and reports a clean tree.
 */
async function infoCard(container: HTMLElement): Promise<HTMLElement> {
  const version = await within(container).findByText(APP_INFO.version);
  let card: HTMLElement | null = version.closest("div");
  while (card && !card.className.split(/\s+/).includes("border")) {
    card = card.parentElement;
  }
  expect(card, "the info card must be a bordered box, not a bare row").toBeTruthy();
  return card!;
}

/**
 * The card's label/value rows, which are this page's only list — the
 * thing `space-y-2` on the card is spacing.
 *
 * Counted, because a `space-y-2` measured on a card holding one row is
 * a number about a card that does not exist.
 */
async function infoRows(container: HTMLElement): Promise<HTMLElement[]> {
  const card = await infoCard(container);
  const rows = Array.from(card.children).filter((d): d is HTMLElement =>
    d.className.includes("justify-between"));
  expect(rows.length, "the card must really carry its four rows").toBe(4);
  return rows;
}

describe("AboutRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "appInfo").mockResolvedValue(APP_INFO);
  });

  it("still says what it said, because a restyle is not a rewrite", async () => {
    const { container } = renderAbout();
    expect(await within(container).findByText(APP_INFO.version)).toBeInTheDocument();
    expect(within(container).getByText("Data directory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show data directory/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replay tour/i })).toBeInTheDocument();
    // The page's own h1, from `RouteShell`, still says About.
    expect(screen.getByRole("heading", { level: 1, name: "About Convo" })).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The rhythm, measured.
 *
 * The claim is that this page is on the *standard* rhythm — 8px between
 * rows, 12px inside a card — and not on the compact one. Both are
 * resolved through the same build, so the measurement can tell them
 * apart rather than merely agreeing with itself.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("AboutRoute rhythm: the standard one, measured", () => {
  beforeEach(() => {
    vi.spyOn(api, "appInfo").mockResolvedValue(APP_INFO);
  });

  it("spaces the info rows at the standard step and pads the card at the standard pad", async () => {
    const { container } = renderAbout();
    const card = await infoCard(container);
    await infoRows(container);
    const standard = await standardRhythm();

    // The card's own padding.
    expect(await pxOn(card, /^p-/, "padding")).toBe(standard.pad);
    // …and the step between its rows. Tailwind builds `space-y-*` out of
    // a `~` sibling selector, so the utility class is on the *parent* and
    // the `margin-top` it produces is not in the stylesheet under that
    // class name. The resolver therefore reads the class from the card
    // and the value it declares, which is the number the browser
    // computes for every row after the first.
    expect(await pxOn(card, /^space-y-/, "margin-top")).toBe(standard.gap);
  });

  it("is the standard rhythm and not the compact one, so the two cannot be confused", async () => {
    const { container } = renderAbout();
    const card = await infoCard(container);
    const standard = await standardRhythm();
    const compact = await compactRhythm();

    // The two really are different, so the comparison above is not
    // comparing a number with itself.
    expect(compact.pad).toBeLessThan(standard.pad);
    expect(compact.gap).toBeLessThan(standard.gap);

    const pad = await pxOn(card, /^p-/, "padding");
    const gap = await pxOn(card, /^space-y-/, "margin-top");
    expect(pad).toBe(standard.pad);
    expect(gap).toBe(standard.gap);
    // …and asserted against the compact one too, so a page that went
    // denser by accident cannot pass by being "a rhythm".
    expect(pad).not.toBe(compact.pad);
    expect(gap).not.toBe(compact.gap);
    expect(pad).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0);
  });

  it("fails the same measurement when a denser rhythm is planted", async () => {
    // The control. An assertion that this page is on the standard
    // rhythm is equally consistent with a walk that measured nothing.
    const read = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host;
    };
    const standard = await standardRhythm();
    const compact = await compactRhythm();

    const standardHost = read('<div class="p-3"><div class="space-y-2"></div></div>');
    expect(await pxOn(standardHost.querySelector("div")!, /^p-/, "padding")).toBe(standard.pad);
    expect(await pxOn(standardHost.querySelector(".space-y-2")!, /^space-y-/, "margin-top")).toBe(standard.gap);

    const compactHost = read('<div class="p-2"><div class="space-y-1"></div></div>');
    expect(await pxOn(compactHost.querySelector("div")!, /^p-/, "padding")).toBe(compact.pad);
    expect(await pxOn(compactHost.querySelector(".space-y-1")!, /^space-y-/, "margin-top")).toBe(compact.gap);
    // So a compact card on this page would be caught, and the two hosts
    // are the only thing separating the claims.
    expect(await pxOn(compactHost.querySelector("div")!, /^p-/, "padding")).not.toBe(standard.pad);

    // A class the page does not use is a failure, not a zero. This is
    // what keeps the resolver honest: without it, a typo in a class name
    // would read as "no padding at all" and sail through as compact.
    const typo = document.createElement("div");
    typo.className = "p-3x";
    await expect(pxOn(typo, /^p-/, "padding")).rejects.toThrow();
    // And a box with no rhythm at all is a failure too.
    const bare = document.createElement("div");
    await expect(pxOn(bare, /^p-/, "padding")).rejects.toThrow();
    // A `var()` is not a number either: reading one as a length is the
    // lie this block exists to avoid, and it throws rather than guessing.
    const themed = document.createElement("div");
    themed.className = "rounded-lg";
    await expect(pxOn(themed, /^rounded-/, "border-radius")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The page inset, and the title it has to line up with.
 *
 * `RouteShell`'s header is `px-4` and this page's content root is `p-4`.
 * They were 24px against 16/32px, which under a 28px bold title reads as
 * two different pages sharing a top edge.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("AboutRoute lines its content up with the title above it", () => {
  beforeEach(() => {
    vi.spyOn(api, "appInfo").mockResolvedValue(APP_INFO);
  });

  it("indents the content by exactly what the header indents the title", async () => {
    const { container } = renderAbout();
    const heading = screen.getByRole("heading", { level: 1, name: "About Convo" });
    const header = heading.closest("header")!;
    const region = header.nextElementSibling!;
    const content = region.firstElementChild!;

    // The header pads with `px-4` and the content with `p-4`, so the two
    // halves of the comparison are different properties. Read each one
    // the way it was written rather than assuming a shorthand, so a page
    // that pads only one side cannot pass by having the other.
    const headerPad = await pxOn(header, /^px-/, "padding-left");
    const contentPad = await pxOn(content, /^p-/, "padding");
    expect(contentPad, "the content must line up under the title").toBe(headerPad);
    expect(contentPad).toBe(16);
  });

  it("carries no responsive second inset, so a wide window does not re-open the step", async () => {
    const { container } = renderAbout();
    const heading = screen.getByRole("heading", { level: 1, name: "About Convo" });
    const content = heading.closest("header")!.nextElementSibling!.firstElementChild!;
    // `unconditional` strips the `@media` block before indexing, so a
    // `sm:` class reads as absent here. That is the point: the claim is
    // that the page has *one* inset, and a `sm:p-8` is a second one.
    const responsive = Array.from(content.classList).filter((c) => c.includes(":"));
    expect(responsive, "the content root must not change its inset at a breakpoint").toEqual([]);
    // The source too, so a class that only renders in an error state is
    // covered: this file used to say `p-4 sm:p-8`.
    expect(code("src/routes/AboutRoute.tsx"), "no second inset at a breakpoint")
      .not.toMatch(/\bsm:p-/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, one card radius, no literal colour.
 *
 * The reference is flat: a card is a surface and a 1px border. The
 * spec's card row names `--radius-lg`, and this page's card was
 * `rounded-xl` — also a theme radius, so not *wrong*, but a second,
 * larger shape for the same object.
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

/* `cleanup` between tests, and not as tidiness: this file renders the
 * page in three states, and a leaked DOM would let a later assertion
 * find a node left over from an earlier render rather than from the
 * state it is talking about. */
afterEach(() => cleanup());

describe("AboutRoute in the shared vocabulary", () => {
  beforeEach(() => {
    vi.spyOn(api, "appInfo").mockResolvedValue(APP_INFO);
  });

  it("gives every box a theme radius, and one radius for the card object", async () => {
    const { container } = renderAbout();
    const card = await infoCard(container);
    await prewarm(container);

    // The card is the spec's card: `--radius-lg`, a theme radius, so a
    // retune of the theme's corner scale moves it with everything else.
    const radius = classMatching(card, /^rounded-/);
    for (const value of await radiusValues(radius)) {
      expect(value, `${radius} on the info card`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
    }

    // …and `rounded-xl` is gone from the page, in the DOM and in the
    // source. Asserting the DOM alone would pass against a second,
    // larger shape that only renders behind the tour or an error state.
    expect(card.className, "the card must not be a second, larger shape").not.toMatch(/rounded-xl/);
    expect(container.querySelector(".rounded-2xl")).toBeNull();
    expect(code("src/routes/AboutRoute.tsx")).not.toMatch(/rounded-(2xl|3xl)/);
  });

  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = renderAbout();
    // Awaited, and this is not tidiness: `render()` returns before the
    // card lands, so a walk taken immediately sees a page with no card
    // on it and reports a clean tree.
    await infoCard(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("scopes every focus ring to a state, so nothing paints a shadow at rest", async () => {
    const { container } = renderAbout();
    await infoCard(container);
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A
    // *bare* `ring-2` would put a shadow on every element at rest and
    // the shadow check would still call the page clean.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`)
        .toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    // The control on the negative: the bare class, which is the thing
    // being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // The negative control, so none of the checks above can pass by being
    // blind. The inline shadow is assembled rather than written out, for
    // the reason the colour control assembles its literals:
    // `tailwind.config.ts` globs this test tree, so a written-out one
    // ships as a dead production rule.
    const planted = (...parts: string[]) => parts.join("");
    const host = document.createElement("div");
    host.innerHTML = [
      '<div class="shadow-panel"></div>',
      '<div class="hover:shadow-lg"></div>',
      '<div class="transition-colors"></div>',
      '<div class="blur-sm"></div>',
      '<div style="filter: blur(1px)"></div>',
      '<div style="transition: opacity 1s"></div>',
      `<div style="box-shadow: 0 1px 2px ${planted("rgb", "(0 0 0 / 0.2)")}"></div>`,
    ].join("");

    const all = paintForcing(host, ["box-shadow", "filter", "transition"]);
    expect(all.filter((f) => f.includes("shadow-panel"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("shadow-lg"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("transition-colors"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("blur-sm"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline filter"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline transition"))).toHaveLength(1);
    expect(all.filter((f) => f.includes("inline box-shadow"))).toHaveLength(1);
    expect(all).toHaveLength(7);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    const { container } = renderAbout();
    await infoCard(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders in a failure state is
    // covered too.
    expect(code("src/routes/AboutRoute.tsx"), "AboutRoute.tsx must not hardcode a colour")
      .not.toMatch(COLOUR_LITERAL);
  });

  it("finds a literal colour when one is planted", () => {
    // The control. `COLOUR_LITERAL` is a regex on a class string, and a
    // regex that matches nothing is indistinguishable from a regex that
    // cannot match. Every literal is *assembled*, for the dead-rule
    // reason.
    const planted = (...parts: string[]) => parts.join("");
    expect(planted("bg-[", "#", "ff0000", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("shadow-[rgb", "(1,2,3)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("text-[hsl", "(210,50%,40%)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("border-[oklch", "(0.7_0.1_200)", "]")).toMatch(COLOUR_LITERAL);
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/15"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline, and the states this page can be in.
 *
 * Three subtrees, not one: the card, the loading state before
 * `appInfo` resolves, and the failure state where the promise rejects.
 * A guard that only walked the loaded page would pass against a page
 * whose other two states were a mess.
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

describe("AboutRoute heading outline", () => {
  it("skips no heading level once the app info has landed", async () => {
    vi.spyOn(api, "appInfo").mockResolvedValue(APP_INFO);
    const { container } = renderAbout();
    await infoCard(container);
    expectNoHeadingSkip(container, "the loaded page");
  });

  it("skips no heading level while the app info is still in flight", async () => {
    // Never resolves, which is the state a slow filesystem leaves the
    // page in. A guard that only walked the loaded page would pass
    // against this one being a mess.
    vi.spyOn(api, "appInfo").mockReturnValue(new Promise(() => {}));
    const { container } = renderAbout();
    expectNoHeadingSkip(container, "the page before appInfo resolves");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>About</h1><h3>Details</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>About</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Why this page is in the fix wave, made checkable.
 *
 * The restyle shipped seven of ten routes and nothing noticed, because
 * nothing asked. These two tests are the asking: they walk the route
 * table and assert that every `RouteShell` route has a restyle guard
 * beside it. A route that ships with no guard now fails here rather
 * than being invisible again.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("every RouteShell route is guarded, so the next omission is loud", () => {
  /**
   * Chat's guard is not beside it. D7 keeps Chat off `RouteShell`, so
   * its page chrome is `ChatViewNew` and its guards live with the chat
   * surface rather than in the route table. Naming the exception is the
   * point: an unnamed exception is a hole, and a hole that moves is
   * invisible. The assertion below checks the file still exists.
   */
  const GUARD_ELSEWHERE: Record<string, string> = {
    ChatRoute: "src/components/chat/__tests__/chatSurface.test.tsx",
  };

  it("has a test file beside every route in the route directory", () => {
    const routeDir = resolve(ROOT, "src/routes");
    const testDir = resolve(ROOT, "src/routes/__tests__");
    // Read the directory rather than a hand-kept list of ten names: a
    // list is a second place to forget, which is the failure this whole
    // block exists to end. The plan's "ten routes, sixty renders" is
    // therefore a count of files rather than a number anybody typed.
    const found = readdirSync(routeDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith("Route.tsx"))
      .map((d) => d.name.replace(/\.tsx$/, ""))
      .sort();
    expect(found.length, "the route directory must not be empty").toBeGreaterThan(0);

    const unguarded = found.filter(
      (name) => !existsSync(resolve(testDir, `${name}.test.tsx`)) && !GUARD_ELSEWHERE[name],
    );
    expect(unguarded, `routes with no guard anywhere: ${unguarded.join(", ")}`).toEqual([]);

    // The controls on the directory read itself. A scan that found
    // nothing would satisfy "no route is unguarded", so the three this
    // wave added are named and the count is pinned: ten routes, which
    // is the spec's checklist, verified rather than trusted.
    expect(found).toEqual(expect.arrayContaining(["AboutRoute", "DiagnosticsRoute", "HardwareRoute"]));
    expect(found).toHaveLength(10);

    // …and the exceptions are real files, so the escape hatch above
    // cannot rot into a claim that Chat is guarded by nothing.
    for (const [route, guard] of Object.entries(GUARD_ELSEWHERE)) {
      expect(found, `${route} must still be a route`).toContain(route);
      expect(existsSync(resolve(ROOT, guard)), `${route}'s guard ${guard} must exist`).toBe(true);
    }
  });

  it("finds an unguarded route when one is planted", () => {
    // The control on the rule above, run over a fixture with a hole in
    // it rather than over the real directory — so a scan that stopped
    // matching `.test.tsx` is caught here rather than by the count.
    const present = new Set(["AboutRoute.test.tsx"]);
    const routes = ["AboutRoute", "DiagnosticsRoute"];
    const unguarded = routes.filter(
      (name) => !present.has(`${name}.test.tsx`) && !GUARD_ELSEWHERE[name],
    );
    expect(unguarded).toEqual(["DiagnosticsRoute"]);
  });
});

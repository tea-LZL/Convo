/**
 * DiagnosticsRoute — the restyle guard for a page the plan never reached.
 *
 * Three of the ten routes shipped without a restyle and without a
 * rhythm guard, which is why nothing noticed: a page with no rhythm
 * cannot fail a test that measures rhythm. This file is the asking.
 *
 * ── Measuring the page, not spelling it ───────────────────────────────
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two things?* The tempting substitute is
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
 * `AboutRoute.test.tsx` on purpose: the whole point of the
 * one-commit-per-route rule is that a reviewer who dislikes one page's
 * treatment can reject that commit alone, and a shared helper would
 * make that impossible.
 *
 * The limit, stated rather than hidden: this is the *stylesheet* the
 * build produces, not a browser's layout. Every claim below is about
 * declared spacing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { DiagnosticsRoute } from "../DiagnosticsRoute";
import repoTailwind from "../../../tailwind.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * A source file with its `/* … *\/` comments removed.
 *
 * This codebase explains itself in block docblocks, and a guard that
 * scans raw source will eventually match a sentence *about* the class
 * it is banning. Only block comments are stripped, because a `//` strip
 * would eat a URL in a string and quietly read a different file from
 * the one that ships.
 */
const code = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");

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
      // Custom properties are machinery, not geometry, and reading one as
      // a length would be nonsense.
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

/**
 * The standard rhythm, named by the utilities every standard-rhythm page
 * uses and measured through the same build, so a change to the spacing
 * scale moves both sides of every comparison below and the difference
 * survives it.
 */
async function standardRhythm(): Promise<{ gap: number; pad: number }> {
  const decls = await emitted(["space-y-2", "p-3"]);
  return {
    gap: toPx(declValue(decls.get("space-y-2")!, "margin-top", "space-y-2"), "space-y-2 { margin-top }"),
    pad: toPx(declValue(decls.get("p-3")!, "padding", "p-3"), "p-3 { padding }"),
  };
}

/** The compact rhythm, measured the same way, so the two are comparable. */
async function compactRhythm(): Promise<{ gap: number; pad: number }> {
  const decls = await emitted(["space-y-1", "p-2"]);
  return {
    gap: toPx(declValue(decls.get("space-y-1")!, "margin-top", "space-y-1"), "space-y-1 { margin-top }"),
    pad: toPx(declValue(decls.get("p-2")!, "padding", "p-2"), "p-2 { padding }"),
  };
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Provider ${id}`,
  kind: "ollama",
  is_default: false,
  has_api_key: true,
  model_count: 2,
  last_seen: null,
  reachable: true,
  reachable_msg: null,
  ...extra,
});

const base = {
  app: { version: "0.7.0", data_dir: "/tmp/convo", db_path: "/tmp/convo.db", os: "linux", arch: "x86_64", uptime_secs: 1 },
  db: {
    ok: true,
    size_bytes: 1,
    wal_size_bytes: 0,
    schema_version: 5,
    tables: [["memory_items", 3]] as [string, number][],
    page_count: 1,
    page_size: 4096,
  },
  providers: [] as unknown[],
  counts: {
    sessions: 0, messages: 0, notes: 0, tasks: 0, documents: 0,
    memory_items: 0, enabled_memory: 0, compare_runs: 0, attachments: 0,
  },
  storage: { blobs_bytes: 0, logs_bytes: 0, themes_bytes: 0 },
  recent_logs: [] as string[],
};

const report = (over: Record<string, unknown> = {}) => ({ ...base, ...over });

const renderDiagnostics = () =>
  render(
    <MemoryRouter>
      <DiagnosticsRoute />
    </MemoryRouter>,
  );

/**
 * The section cards, reached through a heading rather than by class.
 *
 * This is the non-vacuity control for every walk below: `render()`
 * returns before the report lands, and a walk taken then sees a page
 * with no cards on it and reports a clean tree.
 */
async function sections(container: HTMLElement): Promise<HTMLElement[]> {
  await within(container).findByText("Schema version");
  const cards = Array.from(container.querySelectorAll("div")).filter(
    (d) => d.classList.contains("border") && d.querySelector("h2") !== null,
  );
  // Five sections, and the count is checked rather than assumed: a walk
  // over three cards measures three cards.
  expect(cards.length, "the page must really carry its five section cards").toBe(5);
  return cards as HTMLElement[];
}

/* `cleanup` between tests, and not as tidiness: this file renders the
 * page in four states, and a leaked DOM would let a later assertion
 * find a node left over from an earlier render. */
afterEach(() => cleanup());

describe("DiagnosticsRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDiagnostics").mockResolvedValue(report() as never);
  });

  it("renders database health and recovery actions", async () => {
    renderDiagnostics();
    expect(await screen.findByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Schema version")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import backup" })).toBeInTheDocument();
    // The restyle is not a rewrite: all five sections still render.
    for (const title of ["Status", "Database", "Providers", "Storage", "Recent log"]) {
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("shows a retryable failure state", async () => {
    vi.spyOn(api, "getDiagnostics").mockRejectedValue(new Error("db unavailable"));
    renderDiagnostics();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("db unavailable"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The rhythm, measured.
 *
 * The claim is that this page is on the *standard* rhythm — 8px between
 * cards, 12px inside one — and not on the compact one. Both are
 * resolved through the same build, so the measurement can tell them
 * apart rather than merely agreeing with itself.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("DiagnosticsRoute rhythm: the standard one, measured", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDiagnostics").mockResolvedValue(report() as never);
  });

  it("spaces the section cards at the standard step and pads them at the standard pad", async () => {
    const { container } = renderDiagnostics();
    const cards = await sections(container);
    const standard = await standardRhythm();

    // Every card, not the one the walk happened to start from: a page
    // where four cards were right and the fifth was a second shape is
    // the defect, and a single-card assertion would sail past it.
    for (const card of cards) {
      expect(await pxOn(card, /^p-/, "padding"), card.className).toBe(standard.pad);
    }
    // The step *between* cards. Tailwind builds `space-y-*` out of a `~`
    // sibling selector, so the utility is on the parent and the
    // `margin-top` it produces is not in the stylesheet under that
    // class name — the resolver reads the class off the stack and the
    // value it declares, which is the number the browser computes for
    // every card after the first.
    const stack = cards[0].parentElement!;
    expect(await pxOn(stack, /^space-y-/, "margin-top")).toBe(standard.gap);
  });

  it("is the standard rhythm and not the compact one, so the two cannot be confused", async () => {
    const { container } = renderDiagnostics();
    const cards = await sections(container);
    const standard = await standardRhythm();
    const compact = await compactRhythm();

    // The two really are different, so the comparison above is not
    // comparing a number with itself.
    expect(compact.pad).toBeLessThan(standard.pad);
    expect(compact.gap).toBeLessThan(standard.gap);

    const pad = await pxOn(cards[0], /^p-/, "padding");
    const gap = await pxOn(cards[0].parentElement!, /^space-y-/, "margin-top");
    expect(pad).toBe(standard.pad);
    expect(gap).toBe(standard.gap);
    expect(pad).not.toBe(compact.pad);
    expect(gap).not.toBe(compact.gap);
    expect(pad).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0);
  });

  it("keeps the page inset on the number the title is indented by", async () => {
    const { container } = renderDiagnostics();
    await sections(container);
    const header = screen.getByRole("heading", { name: "Diagnostics" }).closest("header")!;
    const content = header.nextElementSibling!.firstElementChild!;
    // `px-4` on the header, `p-4` here: the same 16px, read each way it
    // was written so a page that pads only one side cannot pass.
    expect(await pxOn(content, /^p-/, "padding")).toBe(await pxOn(header, /^px-/, "padding-left"));
    // One inset, not two: a `sm:` inset would re-open the step this
    // page used to have (it was `p-4 sm:p-8`).
    expect(Array.from(content.classList).filter((c) => c.includes(":"))).toEqual([]);
  });

  it("fails the same measurement when a denser rhythm is planted", () => {
    // The control. An assertion that this page is on the standard
    // rhythm is equally consistent with a walk that measured nothing.
    // The shape the page actually has: a stack whose class carries the
    // spacing utility, holding a card. Both halves are measured, because
    // a control that only proved the resolver can read one of them is a
    // control for half the claim.
    const read = (pad: string, gap: string) => {
      const host = document.createElement("div");
      host.innerHTML = `<div class="${gap}"><div class="${pad}"></div></div>`;
      return host.firstElementChild!;
    };

    return (async () => {
      const std = await standardRhythm();
      const cmp = await compactRhythm();
      const standard = read("p-3", "space-y-2");
      const compact = read("p-2", "space-y-1");
      expect(await pxOn(standard.firstElementChild!, /^p-/, "padding")).toBe(std.pad);
      expect(await pxOn(standard, /^space-y-/, "margin-top")).toBe(std.gap);
      expect(await pxOn(compact.firstElementChild!, /^p-/, "padding")).toBe(cmp.pad);
      expect(await pxOn(compact, /^space-y-/, "margin-top")).toBe(cmp.gap);
      // So a compact card on this page would be caught, and the two
      // hosts are the only thing separating the claims.
      expect(await pxOn(compact.firstElementChild!, /^p-/, "padding")).not.toBe(std.pad);
      expect(await pxOn(compact, /^space-y-/, "margin-top")).not.toBe(std.gap);

      // A class the page does not use is a failure, not a zero. Without
      // this, a typo in a class name would read as "no padding at all"
      // and sail through as compact.
      const typo = document.createElement("div");
      typo.className = "p-3x";
      await expect(pxOn(typo, /^p-/, "padding")).rejects.toThrow();
      // And a box with no rhythm at all is a failure too.
      const bare = document.createElement("div");
      await expect(pxOn(bare, /^p-/, "padding")).rejects.toThrow();
      // A `var()` is not a number either: reading one as a length is the
      // lie this block exists to avoid, and it throws rather than
      // guessing.
      const themed = document.createElement("div");
      themed.className = "rounded-lg";
      await expect(pxOn(themed, /^rounded-/, "border-radius")).rejects.toThrow();
    })();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * One card radius, and no accent where nothing is selected.
 *
 * The reference is flat: a card is a surface and a 1px border. And an
 * accent-coloured icon on a section title says "this one is selected",
 * which is a claim no section on this page makes.
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

describe("DiagnosticsRoute in the shared vocabulary", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDiagnostics").mockResolvedValue(
      report({ providers: [provider("ollama", { is_default: true })] }) as never,
    );
  });

  it("gives every section card the spec's radius, and one radius for the object", async () => {
    const { container } = renderDiagnostics();
    const cards = await sections(container);
    await prewarm(container);

    const radii = new Set<string>();
    for (const card of cards) {
      const radius = classMatching(card, /^rounded-/);
      for (const value of await radiusValues(radius)) {
        // A theme radius, so a retune of the theme's corner scale moves
        // the card with everything else.
        expect(value, `${radius} on a section card`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
      }
      radii.add(radius);
    }
    // The control on its own vacuity: the walk saw more than one kind of
    // card and they all resolved to the same shape.
    expect(cards.length).toBe(5);
    expect(radii.size, "every section card draws the same radius").toBe(1);
    // …and `rounded-xl` is gone from the page, in the DOM and in the
    // source, because asserting the DOM alone would pass against a
    // second, larger shape that only renders in the failure state.
    expect(container.querySelector(".rounded-2xl")).toBeNull();
    expect(code("src/routes/DiagnosticsRoute.tsx")).not.toMatch(/rounded-(2xl|3xl)/);
  });

  it("paints a decorative section icon quietly, and a stateful one with its tone", async () => {
    const { container } = renderDiagnostics();
    await sections(container);
    // Reached through the heading, not by class: the icon is the icon
    // *beside this title*, which is the claim being made.
    // `className` on an `<svg>` is an `SVGAnimatedString`, so the
    // attribute is read directly — a `.className` here would stringify
    // to `[object SVGAnimatedString]` and match nothing.
    const classesOf = (el: Element) => el.getAttribute("class") ?? "";
    const decorative = ["Database", "Providers", "Storage", "Recent log"].map(
      (name) => screen.getByRole("heading", { name }).previousElementSibling!,
    );
    expect(decorative.length, "four decorative section icons and one stateful one").toBe(4);
    for (const icon of decorative) {
      expect(classesOf(icon), "a decorative section icon must not read as a link")
        .toMatch(/\btext-text-subtle\b/);
      expect(classesOf(icon), "and must not claim a selection").not.toMatch(/\btext-accent\b/);
    }
    // …and the counter-case, which is what makes the first one a rule
    // rather than a preference: `Status` is not decoration, its icon *is*
    // the health verdict, so it keeps a semantic tone and does not take
    // the quiet channel. Without this, "no accent icons" would be
    // satisfiable by deleting the distinction entirely.
    const status = classesOf(screen.getByRole("heading", { name: "Status" }).previousElementSibling!);
    expect(status).toMatch(/\btext-(success|warn)\b/);
    expect(status).not.toMatch(/\btext-text-subtle\b/);
  });

  it("uses the Badge primitive for the default-provider chip, not a hand-written span", async () => {
    const { container } = renderDiagnostics();
    await sections(container);
    const chip = screen.getByText("default");
    // The primitive spells its own geometry, tone and radius, and a
    // hand-written copy is how the two drift. The claim is not "it is
    // called Badge" — it is that the accent chip's exact class list is
    // the one the primitive produces, so a retune of `Badge` moves this
    // page too. Measured by resolving both through one build.
    const expected = (await emitted(["bg-accent/15", "text-accent", "border-accent/30"]))
      .get("bg-accent/15")!.get("background-color");
    const actual = (await emitted(Array.from(chip.classList))).get("bg-accent/15")!.get("background-color");
    expect(actual).toBe(expected);
    // …and the primitive's own geometry, so a chip that kept the hand
    // spelling and happened to match a colour would still be caught.
    expect(chip.className).toMatch(/\btext-\[10px\]/);
    expect(chip.className).toMatch(/\buppercase\b/);
    expect(chip.className).toMatch(/\brounded-sm\b/);
    // The control on the comparison: the two lookups are the same
    // expression, and a chip with no accent background at all fails
    // rather than passing as "some chip".
    expect(chip.className, "the chip must carry the accent tone").toMatch(/\bbg-accent\/15\b/);
  });

  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = renderDiagnostics();
    // Awaited, and this is not tidiness: `render()` returns before the
    // report lands, so a walk taken immediately sees a page with no
    // cards on it and reports a clean tree.
    await sections(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("scopes every focus ring to a state, so nothing paints a shadow at rest", async () => {
    const { container } = renderDiagnostics();
    await sections(container);
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
    const { container } = renderDiagnostics();
    await sections(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders in the failure state
    // is covered too.
    expect(code("src/routes/DiagnosticsRoute.tsx"), "DiagnosticsRoute.tsx must not hardcode a colour")
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
 * The heading outline, across the three states this page can be in.
 *
 * The loading branch and the failure branch are separate `RouteShell`
 * subtrees from the loaded one. A guard that only walked the loaded page
 * would pass against either of the other two being a mess.
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

describe("DiagnosticsRoute heading outline", () => {
  it("skips no heading level in the loaded state, where five sections are peers", async () => {
    vi.spyOn(api, "getDiagnostics").mockResolvedValue(report() as never);
    const { container } = renderDiagnostics();
    await sections(container);
    expectNoHeadingSkip(container, "the loaded report");
    // …and the sections really are `h2` under the shell's `h1`, which is
    // the shape the assertion above is about rather than a general claim
    // that some order of tags happens not to skip.
    expect(screen.getByRole("heading", { name: "Database" }).tagName).toBe("H2");
  });

  it("skips no heading level while the report is still in flight", async () => {
    // Never resolves, which is the state a slow disk leaves the page in.
    vi.spyOn(api, "getDiagnostics").mockReturnValue(new Promise(() => {}));
    const { container } = renderDiagnostics();
    expectNoHeadingSkip(container, "the loading state");
    expect(screen.getByRole("status")).toHaveTextContent("Loading diagnostics");
  });

  it("skips no heading level when the fetch fails", async () => {
    vi.spyOn(api, "getDiagnostics").mockRejectedValue(new Error("db unavailable"));
    const { container } = renderDiagnostics();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expectNoHeadingSkip(container, "the failure state");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Diagnostics</h1><h3>Database</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Diagnostics</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });
});

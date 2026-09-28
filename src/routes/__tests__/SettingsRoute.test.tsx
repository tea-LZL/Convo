import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { useShortcutsStore } from "../../stores/shortcuts";
import { useThemeStore } from "../../stores/theme";
import { SettingsRoute } from "../SettingsRoute";
import { KnowledgeSection } from "../settings/KnowledgeSection";
import repoTailwind from "../../../tailwind.config";

/* ═══════════════════════════════════════════════════════════════════════
 * Measuring the page, not spelling it.
 *
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two rows?* The tempting substitute is
 * `expect(row.className).toContain("py-3")`, and it is the wrong test
 * twice over. It pins a class name, which is an implementation detail that
 * the next task will change for no reason, and it passes for any page that
 * merely *says* `py-3` — including one that got denser using something
 * else entirely.
 *
 * So the numbers below come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that comes
 * out. A row is 12px inside whether it says `py-3`, `p-3` or something a
 * later task invents; a class that does not exist emits no rule at all,
 * which is a loud failure here rather than a silent zero.
 *
 * The resolver is duplicated from the four route tests that came before
 * this one. A shared test helper would be five commits touching one file,
 * and the whole point of the one-commit-per-route rule is that a reviewer
 * who dislikes one page's treatment can reject that commit alone.
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
 * `@media` on only applies at or above a breakpoint — and a `sm:p-3` is
 * not the padding a narrow window gets.
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
 * Every radius declaration a class emits, read out of the build.
 *
 * Not just `border-radius`: a corner class like `rounded-t-lg` emits
 * `border-top-left-radius` and `border-top-right-radius` and nothing else,
 * so a check that read the shorthand would throw on it and the element
 * would quietly leave the walk.
 */
async function radiusValues(cls: string): Promise<string[]> {
  const decls = (await emitted([cls])).get(cls)!;
  const values = [...decls.entries()]
    .filter(([prop]) => prop.endsWith("-radius"))
    .map(([, value]) => value);
  if (values.length === 0) throw new Error(`${cls} emits no radius at all; the class does not exist`);
  return values;
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
 * shape", and on a themed colour scale `text-*` is the *colour* family, not
 * the size one.
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
  return toPx(declValue((await emitted([cls])).get(cls)!, "font-size", cls), `${cls} { font-size }`);
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
interface Rhythm { gap: number; pad: number }

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

/* ═══════════════════════════════════════════════════════════════════════
 * The restyle's guards.
 * ═══════════════════════════════════════════════════════════════════════ */

const PROVIDERS = [
  { id: "p1", name: "Local", kind: "ollama", base_url: "http://localhost", is_default: true, has_api_key: false, created_at: "now" },
  { id: "p2", name: "OpenRouter", kind: "openai_compat", base_url: "https://openrouter.test", is_default: false, has_api_key: true, created_at: "now" },
];

const THEMES = [
  { id: "solar", name: "Solar", tokens_json: JSON.stringify({ "color-bg": "#12100c", "color-surface-2": "#1d1a14", "color-accent": "#c2703a", "color-text": "#f2ead9" }), is_builtin: true, is_active: true, created_at: "now" },
  // `color-text` is deliberately missing: a theme that does not define a
  // token must fall back to the page's own background for that swatch, and
  // a fixture where every token is present would never exercise the
  // fallback — which is the half of the exemption that has to be a var.
  { id: "mono", name: "Mono", tokens_json: JSON.stringify({ "color-bg": "#000000", "color-surface-2": "#1a1a1a", "color-accent": "#888888" }), is_builtin: true, is_active: false, created_at: "now" },
];

const BINDINGS = [
  { id: "new-chat", description: "New chat", combo: "ctrl+n", category: "chat" },
  { id: "toggle-sidebar", description: "Toggle sidebar", combo: "ctrl+b", category: "view" },
];

function serveSettings() {
  // The Theme section reads the theme list out of the *store*, and the store
  // fills itself from `invoke("list_themes")` on an `init()` that only
  // `App` calls. Mocking `api.listThemes` therefore does nothing at all —
  // which is why the first cut of this file rendered an empty theme section
  // and then failed to find anything to walk. Seeded directly, and reset
  // after each test so the two themes do not leak into the next one.
  useThemeStore.setState({ themes: THEMES as never, activeThemeId: "solar" });
  // Same story as the themes: the shortcut bindings are registered by
  // `App` on mount, so a bare route render has an *empty* card and there is
  // no row there to measure. Seeded, and reset after each test.
  useShortcutsStore.setState({ bindings: BINDINGS as never });
  vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS as never);
  vi.spyOn(api, "getSearchConfig").mockResolvedValue({ provider: "duckduckgo", base_url: null, api_key: null, max_results: 5 } as never);
  vi.spyOn(api, "getSetting").mockResolvedValue(null);
  vi.spyOn(api, "listThemes").mockResolvedValue(THEMES as never);
  vi.spyOn(api, "addProvider").mockResolvedValue({ id: "p-new" } as never);
  vi.spyOn(api, "deleteProvider").mockResolvedValue(undefined);
  vi.spyOn(api, "discoverLocalServers").mockResolvedValue([] as never);
}

// No `afterEach` reset for the two stores. `serveSettings` re-seeds both in
// every `beforeEach`, so a reset at the end only ever fired the stores'
// listeners while a component from the test that had just finished was
// still mounted — which is where React's "not wrapped in act(...)" warning
// came from. Vitest gives each file a fresh module registry, so nothing
// escapes into the next file either way.

const renderSettings = () =>
  render(
    <MemoryRouter>
      <SettingsRoute />
    </MemoryRouter>,
  );

/**
 * Every section the page can be in, reached by its nav link.
 *
 * Each returns after the section's own controls have landed, which is the
 * non-vacuity control for every walk below: a walk taken before that sees a
 * section with no rows on it and reports a clean tree, which is how four
 * guards in this plan came to pass against code they were not examining.
 */
const SECTIONS = {
  general: async () => {
    await screen.findByRole("heading", { level: 2, name: "General" });
    return screen.findByText("Sound effects");
  },
  providers: async () => {
    await screen.findByRole("heading", { level: 2, name: "Providers" });
    return screen.findByRole("button", { name: "Delete OpenRouter" });
  },
  models: async () => {
    await screen.findByRole("heading", { level: 2, name: "Models" });
    return screen.findByRole("combobox", { name: "Model provider" });
  },
  knowledge: async () => {
    await screen.findByRole("heading", { level: 2, name: "Knowledge" });
    return screen.findByLabelText("Recall items");
  },
  search: async () => {
    await screen.findByRole("heading", { level: 2, name: "Web search" });
    return screen.findByRole("button", { name: "Test" });
  },
  theme: async () => {
    await screen.findByRole("heading", { level: 2, name: "Theme" });
    return screen.findByText(THEMES[0].name);
  },
  shortcuts: async () => {
    await screen.findByRole("heading", { level: 2, name: "Shortcuts" });
    return screen.findByText("Toggle sidebar");
  },
} as const;

/**
 * A row really draws a rule, and the rule is visible.
 *
 * Both halves, because a width alone is not a rule: `border-t` with no
 * colour beside it is a 1px line in whatever the browser defaults to, which
 * on this page is the page background — an invisible separator. A mutation
 * that dropped the *colour* and left the width passed a width-only check,
 * which is the same shape as a guard that asserts something could be asked
 * rather than that this page asked it.
 */
async function expectVisibleRule(row: Element, edge: "top" | "bottom", where: string) {
  const width = await classDeclaring(row, `border-${edge}-width`);
  expect(
    toPx(declValue((await emitted([width])).get(width)!, `border-${edge}-width`, width), `${width} { border-${edge}-width }`),
    `${where}: the rule must be 1px`,
  ).toBe(1);
  // The colour may be declared per-edge or through the `border-color`
  // shorthand, and on this page it is the shorthand: `border-b` sets the
  // width and `border-border` sets the colour, and Tailwind's colour alias
  // emits `border-color`, not four per-edge properties. So both are tried,
  // and the one that exists is the one asserted.
  let colour: string;
  let colourProp: string;
  try {
    colourProp = `border-${edge}-color`;
    colour = await classDeclaring(row, colourProp);
  } catch {
    colourProp = "border-color";
    colour = await classDeclaring(row, colourProp);
  }
  expect(
    declValue((await emitted([colour])).get(colour)!, colourProp, `${colour} { ${colourProp} }`),
    `${where}: the rule must take the theme's border colour, not a default`,
  ).toBe("var(--color-border)");
}

/**
 * The row `label` belongs to: the nearest ancestor that draws a rule.
 *
 * Structural rather than a class query, and it throws rather than returning
 * something: a row on this page *is* the element carrying the 1px
 * separator, so that is what to walk up to. `closest("div.flex")` was the
 * first attempt and it reached the *inner* `flex items-center gap-2` that
 * holds a provider's name and badges — a real element, the wrong one, and
 * it would have measured a three-line box's padding rather than the row's.
 */
function rowOf(label: Element): HTMLElement {
  for (let el = label.parentElement; el; el = el.parentElement) {
    if (Array.from(el.classList).some((c) => /^border-[bt]/.test(c))) return el;
  }
  throw new Error("no row above this label — a row is the element carrying the rule");
}

type SectionName = keyof typeof SECTIONS;

async function openSection(container: HTMLElement, section: SectionName) {
  fireEvent.click(within(container).getByRole("link", { name: new RegExp(NAV_LABEL[section], "i") }));
  return SECTIONS[section]();
}

const NAV_LABEL: Record<SectionName, string> = {
  general: "General",
  providers: "Providers",
  models: "Models",
  knowledge: "Knowledge",
  search: "Web search",
  theme: "Theme",
  shortcuts: "Shortcuts",
};

describe("SettingsRoute density: the standard rhythm, measured", () => {
  beforeEach(() => {
    serveSettings();
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([] as never);
  });

  it("gives the page one row rhythm, and every row on it the same padding", async () => {
    // The claim worth making on this page is not "one row is 12px" — it is
    // that there is *one* row rhythm. The general rows, the provider rows,
    // the Knowledge section's rows and the shortcut rows were four separate
    // `py-3` / `py-2` literals, and the shortcut rows were the odd one out
    // at 8px. A page whose rows drift apart reads as four pages.
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    const { container } = renderSettings();

    const measure = [
      ["the general section's rows", "general", () => rowOf(screen.getByText("Desktop notifications"))],
      ["the providers section's rows", "providers", () => rowOf(screen.getByText("OpenRouter"))],
      ["the Knowledge section's rows", "knowledge", () => rowOf(screen.getByText("Context budget fraction"))],
      ["the shortcuts section's rows", "shortcuts", () => rowOf(screen.getByText("Toggle sidebar"))],
      // A fifth, in a *different file* from the fourth: the Knowledge
      // section's own switch row is its own `div` with its own `py-3`, and a
      // mutation taking that one to 8px came back green while the other four
      // went red. Every row this page draws is named, not every kind of row.
      ["the Knowledge section's switch row", "knowledge", () => rowOf(screen.getByText("Extract memories automatically"))],
    ] as const;

    const seen = new Set<number>();
    for (const [where, section, reach] of measure) {
      cleanup();
      const view = renderSettings();
      await openSection(view.container, section);
      const row = reach();
      expect(row, `${where} must be an element on the page`).toBeTruthy();
      // Deliberately *not* `prewarm`ed. This walk reads one class, and
      // prewarming compiles every class on the section — about 150 of them,
      // four times over — which took this test to 5.3s and had it failing on
      // the 5s default under the full suite's load while passing on its own.
      // The walks that really do sweep the page (the radius one) prewarm.
      const pad = await pxOn(row, /^py-/, "padding-top");
      expect(pad, `${where} must be at the standard 12px`).toBe(standard.pad);
      // …and strictly above the compact one, so the equality above is not a
      // free pass.
      expect(pad, `${where} must not be the compact 8px`).toBeGreaterThan(compact.pad);
      seen.add(pad);
    }
    // The control: the four really are four different elements that
    // resolved alike, rather than one element measured four times.
    expect(seen.size).toBe(1);
    expect(container).toBeTruthy();
  });

  it("separates its rows with a rule rather than with air, which is the same step a different way", async () => {
    const { container } = renderSettings();
    await openSection(container, "general");
    // The nav's own label. It was an `h2` repeating the page's `h1` word for
    // word, and an extra `h2` is *not* a skipped level — so the outline walk
    // above passed straight over it and only this catches it. The label is
    // for the reader, not for the outline.
    const nav = container.querySelector("aside")!;
    expect(
      within(nav).queryByRole("heading"),
      "the nav's label is a group header, not a heading",
    ).toBeNull();
    expect(within(nav).getByText("Sections")).toBeInTheDocument();

    const row = rowOf(screen.getByText("Desktop notifications"));
    // The step between rows is a 1px border, so the page has no `space-y-*`
    // at all. That is a deliberate choice for a dozen rows under a heading
    // and it is the reason the density test above measures padding rather
    // than a gap: asserting a gap here would be asserting an absence.
    expect(row.className).not.toMatch(/space-y-/);
    await expectVisibleRule(row, "bottom", "the general section's rows");

    // The Knowledge section is a separate file that draws its own rows, and
    // it is the one most likely to lose its rule: nothing on this page
    // shares that file's class strings. So its rows are checked for the rule
    // too, not just for the padding the test above measures.
    cleanup();
    const knowledge = renderSettings();
    await openSection(knowledge.container, "knowledge");
    const topK = screen.getByText("Recall items");
    const topKRow = rowOf(topK);
    await expectVisibleRule(topKRow, "top", "the Knowledge section's field rows");
    // …and its *switch* row, which is a third `div` in that file rather
    // than a second instance of the first. Reached from the switch itself
    // rather than through `rowOf`, because `rowOf` answers "the nearest
    // ancestor carrying a rule" and this assertion is about the element
    // that *has* the rule — with the rule taken away, `rowOf` would climb
    // past it and find something else, and the mutation came back green.
    const switchRow = screen.getByRole("switch").parentElement!.parentElement!;
    expect(switchRow.textContent, "the switch row is the one holding the switch").toContain("Extract memories automatically");
    await expectVisibleRule(switchRow, "top", "the Knowledge section's switch row");

    // …and the theme section's row, which is a real `SettingRow` — the six
    // general rows are `SwitchRow`s now, so a rule check that only walked
    // those never saw `SettingRow`'s own classes at all. A mutation taking
    // its border colour away came back green until this existed.
    cleanup();
    const theme = renderSettings();
    await openSection(theme.container, "theme");
    await expectVisibleRule(rowOf(screen.getByText("Mode")), "bottom", "the theme section's row");
  });

  it("tells the two rhythms apart, because a measurement that cannot is not one", async () => {
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    // The two really are different, so the comparisons above are not
    // comparing a number with itself.
    expect(compact.pad).toBeLessThan(standard.pad);

    // The same code, run over a fixture built at each rhythm.
    const read = (cls: string) => {
      const host = document.createElement("div");
      host.className = cls;
      return host;
    };
    expect(await pxOn(read("py-3"), /^py-/, "padding-top")).toBe(standard.pad);
    expect(await pxOn(read("p-3"), /^p-/, "padding")).toBe(standard.pad);
    expect(await pxOn(read("py-2"), /^py-/, "padding-top")).toBe(compact.pad);

    // A class the page does not use is a failure, not a zero. This is what
    // keeps the resolver honest: without it, a typo in a class name would
    // read as "no padding at all" and sail through as compact.
    const typo = document.createElement("div");
    typo.className = "py-3x";
    await expect(pxOn(typo, /^py-/, "padding-top")).rejects.toThrow();
    // And a page with no rhythm at all is a failure too.
    const bare = document.createElement("div");
    await expect(pxOn(bare, /^py-/, "padding-top")).rejects.toThrow();
    // A `var()` is not a number either: reading one as a length is the lie
    // this block exists to avoid, and it throws rather than guessing.
    await expect(pxOn(read("rounded-lg"), /^rounded-/, "border-radius")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, and no literal colour but the theme swatch.
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

describe("SettingsRoute stays flat", () => {
  beforeEach(() => {
    serveSettings();
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([] as never);
  });

  it("puts no shadow and no filter on any resting surface, in any section", async () => {
    for (const section of Object.keys(NAV_LABEL) as SectionName[]) {
      cleanup();
      const { container } = renderSettings();
      // Awaited per section, and this is not tidiness: a walk taken before
      // the section's own controls land sees a page with no rows on it and
      // reports a clean tree.
      await openSection(container, section);
      expect(paintForcing(container, ["box-shadow", "filter"]), `the ${section} section`).toEqual([]);
    }
  });

  it("lets the two dialogs float, and only the dialogs", async () => {
    const { container } = renderSettings();
    await openSection(container, "providers");
    expect(paintForcing(container, ["box-shadow"])).toEqual([]);

    // The add-provider dialog overlaps the page — a shadow is the only
    // thing separating an overlay from a card in the flow. Asserted so a
    // later "flatten everything" commit argues with a test rather than with
    // taste.
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await screen.findByRole("dialog");
    expect(paintForcing(container, ["box-shadow"]).length).toBeGreaterThan(0);
  });

  it("scopes every focus ring to a state, so no control paints a shadow at rest", async () => {
    const { container } = renderSettings();
    await openSection(container, "general");
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A *bare*
    // `ring-2` would put a shadow on every control at rest and the shadow
    // check would still call the page clean.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    // The nav link carries one of its own, and it is the control this page
    // hands-authored rather than reaching for a primitive.
    const link = within(container).getByRole("link", { name: /Providers/ });
    expect(classMatching(link, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("reports a shadow and a filter when one is present", () => {
    // The negative control, so the checks above cannot pass by being blind.
    // The inline shadow is assembled rather than written out, for the
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

  it("carries no literal colour anywhere but the theme swatches, and the swatch exemption is narrow", async () => {
    for (const section of Object.keys(NAV_LABEL) as SectionName[]) {
      cleanup();
      const { container } = renderSettings();
      await openSection(container, section);
      // Awaited per section: the rows arrive a frame after the nav click,
      // and the rows are where the colours are.
      await waitFor(() =>
        expect(container.querySelectorAll("[data-swatch]").length + container.querySelectorAll("h2").length)
          .toBeGreaterThan(0),
      );
      // The one exemption, and it is narrow: a theme swatch's job is to
      // *show* the theme's colours, so it paints them from `tokens_json`
      // and there is no var to read. Nothing else on the page may.
      for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
        if (el.hasAttribute("data-swatch")) continue;
        for (const c of Array.from(el.classList)) {
          expect(c, `class "${c}" on <${el.tagName.toLowerCase()}> hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
        }
        const inline = el.getAttribute("style");
        if (inline) expect(inline, `inline style on <${el.tagName.toLowerCase()}> hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
      }
    }
  });

  it("shows the theme's own colour in a swatch, so the exemption cannot carry a hardcoded one", async () => {
    const { container } = renderSettings();
    await openSection(container, "theme");
    // …and the other source: the page's own styling, where there is no
    // `tokens_json` to read and so no exemption is available at all.
    for (const file of ["src/routes/SettingsRoute.tsx", "src/routes/settings/KnowledgeSection.tsx", "src/routes/settings/ModelsSection.tsx"]) {
      expect(source(file), `${file} must not hardcode a colour`).not.toMatch(COLOUR_LITERAL);
    }

    const swatches = Array.from(container.querySelectorAll("[data-swatch]"));
    // Four tokens per theme, two themes. A swatch count that collapsed
    // would make the assertion below pass on nothing.
    expect(swatches.length).toBe(8);
    // The theme's own values, not a var and not a page colour: that is the
    // whole point of a swatch, and it is why this one element is exempt.
    //
    // Written as `rgb()` rather than as the fixture's hex because jsdom's
    // CSS parser normalises a hex background to `rgb()` on the way in, and
    // an assertion against the un-normalised string would be a test of the
    // parser rather than of the page. The numbers are Solar's, from the
    // fixture above.
    const painted = swatches.map((el) => (el as HTMLElement).style.background);
    expect(painted).toContain("rgb(18, 16, 12)");
    expect(painted).toContain("rgb(194, 112, 58)");
    // The fourth token of each theme is absent from the fixture, so that one
    // falls back to the page's own background — and *that* is a var, which
    // is the other half of the exemption: a missing token reads as the
    // page, not as a hardcoded colour.
    expect(painted).toContain("var(--color-bg)");
  });

  it("finds a literal colour when one is planted", () => {
    // The control. `COLOUR_LITERAL` is a regex on a class string, and a
    // regex that matches nothing is indistinguishable from a regex that
    // cannot match. Every literal is *assembled*, for the dead-rule reason.
    const planted = (...parts: string[]) => parts.join("");
    expect(planted("bg-[", "#", "ff0000", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("shadow-[rgb", "(1,2,3)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("text-[hsl", "(210,50%,40%)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("border-[oklch", "(0.7_0.1_200)", "]")).toMatch(COLOUR_LITERAL);
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/15", "text-group-header"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The shared vocabulary, and the behaviour the restyle had to keep.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("SettingsRoute in the shared vocabulary", () => {
  beforeEach(() => {
    serveSettings();
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([] as never);
  });

  it("gives every box a theme radius, and every radius on the page is a theme radius", async () => {
    let sawCircle = false;
    for (const section of ["general", "providers", "knowledge", "search", "theme"] as SectionName[]) {
      cleanup();
      const { container } = renderSettings();
      await openSection(container, section);
      await prewarm(container);
      // Two walks, because one was not enough — the second exists because a
      // mutation on the Documents page proved the first blind.
      //
      // (a) *Every box draws a theme radius*, scoped by a bare `border`
      // class rather than any `border-*`, so the `border-b`-carrying rules
      // between rows are not boxes and are not demanded one.
      //
      // (b) *Every radius on the page is a theme radius*, which is what
      // reaches a card that has a radius and no border of its own.
      const radii = new Set<string>();
      const circles: string[] = [];
      for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
        const isBox = el.classList.contains("border");
        const hasRadius = Array.from(el.classList).some((c) => c.startsWith("rounded-"));
        if (!isBox && !hasRadius) continue;
        const radius = classMatching(el, /^rounded-/);
        // `rounded-full` is the one exemption, and it is a real one: a
        // switch's track and its thumb are circles, and there is no theme
        // radius that means "circle" — a `--radius-lg` on a 20px track
        // would be a lozenge. So the exemption is for the *class*, and the
        // check below is that only a switch uses it.
        if (radius === "rounded-full") {
          circles.push(el.tagName.toLowerCase());
          expect(
            el.closest("[role='switch']") ?? (el.getAttribute("role") === "switch" ? el : null),
            `${section}: rounded-full on <${el.tagName.toLowerCase()}> that is not part of a switch`,
          ).toBeTruthy();
          continue;
        }
        for (const value of await radiusValues(radius)) {
          expect(value, `${radius} on <${el.tagName.toLowerCase()}> in ${section}`).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
        }
        if (isBox) radii.add(radius);
      }
      expect(radii.size, `the ${section} section has more than one kind of box`).toBeGreaterThan(0);
      if (section === "general") sawCircle = sawCircle || circles.length > 0;
    }
    // The control on the exemption: the walk really did meet a `rounded-full`
    // and really did exempt it, rather than the branch never being
    // exercised. Its *narrowness* is the per-element assertion above — a
    // `rounded-full` outside a switch fails there. The first cut of this
    // test also asserted that only the general section had a circle, and
    // was wrong: the Knowledge section has a switch too. A control that is
    // wrong about the code is worse than no control.
    expect(sawCircle, "a switch's circle track should have been exempted").toBe(true);
  });

  it("names every icon-only control, and puts a row's three actions at one size", async () => {
    const { container } = renderSettings();
    await openSection(container, "providers");
    // The provider delete button was a `Trash2` and nothing else: no name,
    // no `title`, and 18px. A screen reader announced "button" on the one
    // control that deletes a provider.
    const remove = screen.getByRole("button", { name: "Delete OpenRouter" });
    expect(remove).toHaveAttribute("title", "Delete OpenRouter");
    expect(remove).toHaveAttribute("type", "button");
    await prewarm(container);

    // The two controls beside it share the geometry, so a row of three
    // actions cannot read as three sizes. Compared as *resolved* metrics,
    // because the claim is one size rather than a spelling.
    //
    // Not a height claim, and the reason is worth stating: a `Button`'s box
    // is its padding plus its line box, and jsdom has no layout, so "24px"
    // is not a number this environment can read off a `Button`. What *is*
    // readable is that all three declare the same type size and the same
    // padding, which is what makes them one control. The three were 11px
    // before this task and are 12px now.
    // Scoped to OpenRouter's own row: with two providers on the page there
    // are two "Edit" buttons, and a page-wide query would be measuring
    // whichever came first rather than the row under test.
    const row = rowOf(screen.getByText("OpenRouter"));
    for (const [prop, re] of [["padding-left", /^px-/], ["padding-top", /^py-/]] as const) {
      for (const name of ["Edit", "Set default"]) {
        const button = within(row).getByRole("button", { name });
        expect(await pxOn(button, re, prop), `${name} { ${prop} }`).toBe(await pxOn(remove, re, prop));
      }
    }
    for (const name of ["Edit", "Set default"]) {
      const button = within(row).getByRole("button", { name });
      expect(await fontSizeOf(button), `${name}'s type size`).toBe(await fontSizeOf(remove));
    }
    // …and the row really did carry three actions, so the comparison above
    // is between three things and not between two.
    expect(within(row).getAllByRole("button")).toHaveLength(3);
  });

  /**
   * The six switches of the general section, by the name a screen reader is
   * given. Read out of the DOM as the six `label` props the route passes.
   */
  const SWITCH_LABELS = [
    "Sound effects",
    "Desktop notifications",
    "Enter to send",
    "Show token count",
    "Show thinking by default",
    "Auto-extract memory from chat",
  ] as const;

  it("gives every settings switch a non-empty, distinct accessible name", async () => {
    // The first round of this task added the six `label` props and asserted
    // nothing about them: the test reached the switches with
    // `getAllByRole("switch")` and no name filter, so a later edit that
    // dropped one label passed green and that switch went back to being
    // announced as "Toggle". This is the sixth guard of that shape in this
    // plan, and three of the first five were mine.
    const { container } = renderSettings();
    await openSection(container, "general");

    // Six switches, so a name query that matched nothing and one that
    // matched two are both distinguishable from the real thing.
    expect(screen.getAllByRole("switch"), "the general section has six switches").toHaveLength(SWITCH_LABELS.length);

    // Each label, by the accessible name — not by the visible text. A
    // `Switch` with no `label` prop falls back to `aria-label="Toggle"`, so
    // a dropped label fails here rather than producing a control nothing can
    // tell apart from its five neighbours.
    const found = SWITCH_LABELS.map((label) => screen.getByRole("switch", { name: label }));
    // Distinct. Two switches sharing a name is a finding rather than a
    // cosmetic one, and this is the assertion that says so: each label must
    // resolve to a *different* element, so a copy-pasted label is red even
    // though both queries succeed.
    expect(new Set(found).size, "each label must name a different switch").toBe(SWITCH_LABELS.length);
    // …and none of them is the primitive's fallback. Six identically-named
    // switches in one row is exactly the defect, so its absence is the claim.
    expect(
      screen.queryByRole("switch", { name: "Toggle" }),
      "no switch may fall back to the primitive's unnamed label",
    ).not.toBeInTheDocument();

    // The seventh switch on this page is the Knowledge section's, and it
    // already passed `label` before this task. Named here so "every switch"
    // means every switch rather than the six in one section.
    cleanup();
    const knowledge = renderSettings();
    await openSection(knowledge.container, "knowledge");
    expect(screen.getAllByRole("switch"), "the knowledge section has one switch").toHaveLength(1);
    expect(
      screen.getByRole("switch", { name: "Extract memories automatically" }),
    ).toBeInTheDocument();
  });

  it("still renders every section, and still says which one you are in", async () => {
    const { container } = renderSettings();
    await openSection(container, "general");
    for (const section of Object.keys(NAV_LABEL) as SectionName[]) {
      await openSection(container, section);
      const heading = await screen.findByRole("heading", { level: 2, name: NAV_LABEL[section] });
      expect(heading).toBeInTheDocument();
      // The nav marks the current section, and only that one.
      const current = within(container).getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
      expect(current, `exactly one nav item is current in ${section}`).toHaveLength(1);
      expect(current[0].textContent).toMatch(new RegExp(NAV_LABEL[section], "i"));
    }
  });

  it("still reads and writes the settings the sections own", async () => {
    const { container } = renderSettings();
    await openSection(container, "general");
    // The switches are `Switch`, and they still toggle. Reached by role
    // without a name filter: `Switch` wires its name through a `useId()`
    // `aria-labelledby`, and a name query against that is a test of React's
    // id plumbing rather than of the page. The wiring is then asserted
    // directly, which is the part actually worth knowing.
    const label = await screen.findByText("Sound effects");
    const [sound] = screen.getAllByRole("switch");
    expect(label).toHaveAttribute("id", sound.getAttribute("aria-labelledby"));
    expect(sound).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sound);
    await waitFor(() => expect(sound).toHaveAttribute("aria-checked", "false"));

    cleanup();
    const knowledge = renderSettings();
    await openSection(knowledge.container, "knowledge");
    // The Knowledge section's own reads still happen, one per key, and its
    // fields still render from what came back.
    const topK = await screen.findByLabelText("Recall items");
    expect(topK).toHaveValue(6);
    expect(screen.getByLabelText("Context budget fraction")).toHaveValue(0.15);
    expect(await screen.findByText("Model routing")).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position, so
 * two `h1`s on one page is a defect rather than a nit — and this page had
 * two, because the one section that did not use `SectionTitle` drew its
 * own. Every section is walked, plus both dialogs, because they are
 * separate subtrees and a fix to one says nothing about the rest.
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
  // Exactly one `h1`. The page announcing itself twice is the failure this
  // half is for, and it is not a *skip* — a second `h1` at the same level
  // sails through a skip-only assertion.
  expect(headings.filter((h) => h.level === 1), `${where} must have exactly one h1`).toHaveLength(1);
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1];
    expect(
      headings[i].level,
      `${where}: h${prev.level} "${prev.text}" is followed by h${headings[i].level} "${headings[i].text}"`,
    ).toBeLessThanOrEqual(prev.level + 1);
  }
}

describe("SettingsRoute heading outline", () => {
  beforeEach(() => {
    serveSettings();
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([] as never);
  });

  it("opens at one h1 and skips no level, in every section and both dialogs", async () => {
    for (const section of Object.keys(NAV_LABEL) as SectionName[]) {
      cleanup();
      const { container } = renderSettings();
      await openSection(container, section);
      expectNoHeadingSkip(container, `the ${section} section`);
      // And the shape is a tree rather than a flat list: a card label under
      // its section's heading is `h2 → h3`, and the two general sections
      // that have one are the only ones that should.
      const levels = headingLevels(container).map((h) => h.level);
      expect(Math.max(...levels), `${section} nests its card labels`).toBeLessThanOrEqual(3);
    }

    // The two card labels this page has, by name. A card label at the *same*
    // level as its section's heading is not a skipped level, so the outline
    // walk above passed straight over both of these — a mutation moving
    // either back to an `h2` came back green until this existed.
    cleanup();
    const search = renderSettings();
    await openSection(search.container, "search");
    const testCard = await screen.findByRole("heading", { name: "Test search" });
    expect(testCard.tagName, `"Test search" must be an h3 under the section's h2`).toBe("H3");
    expect(headingLevels(search.container).filter((h) => h.text === "Test search")).toHaveLength(1);

    // The add-provider dialog. A `Modal` renders its own `h2`, so a dialog
    // title lands at a level under the page's rather than beside it.
    cleanup();
    const { container } = renderSettings();
    await openSection(container, "providers");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(container, "the add-provider dialog");

    // …and the delete confirmation, the last heading-bearing subtree.
    cleanup();
    const confirm = renderSettings();
    await openSection(confirm.container, "providers");
    fireEvent.click(screen.getByRole("button", { name: "Delete OpenRouter" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(confirm.container, "the delete confirmation");
  });

  it("catches a skipped level and a second h1 when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings — and an
    // assertion that there is one `h1` is equally consistent with a walk
    // that found none.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Settings</h1><h2>General</h2><h4>Deep</h4>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h2 .* followed by h4/);
    expect(headingLevels(skip)).toHaveLength(3);

    // The second `h1`, which is the defect this page actually had and which
    // a skip-only assertion passes straight over.
    const twoH1 = document.createElement("div");
    twoH1.innerHTML = "<h1>Settings</h1><h2>Models</h2>";
    expect(() => expectNoHeadingSkip(twoH1, "planted two h1s")).not.toThrow();
    const twin = document.createElement("div");
    twin.innerHTML = "<h1>Settings</h1><h1>Models</h1>";
    expect(() => expectNoHeadingSkip(twin, "planted second h1")).toThrow(/exactly one h1/);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Settings</h1><h2>General</h2><h3>Recall</h3><h3>Routing</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });

  it("renders the Knowledge section's own cards at the level the page nests them", async () => {
    // The Knowledge section is a sibling file that draws its own headings,
    // so it is the one place a level can be lost. Asserted by name rather
    // than by count, because a section with no card labels would satisfy a
    // count of zero.
    render(
      <MemoryRouter>
        <KnowledgeSection />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Knowledge" });
    for (const name of ["Recall", "Model routing"]) {
      const label = await screen.findByRole("heading", { name });
      expect(label.tagName, `"${name}" must be an h3 under the section's h2`).toBe("H3");
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * One spelling of a group header, across every file that has one.
 *
 * `group-header` is literally `var(--color-text-subtle)`, so a site that
 * wrote `text-text-subtle` and one that wrote `text-group-header` look
 * identical today and diverge the moment anyone retunes either. That
 * makes this a naming inconsistency *now* and a colour bug on the first
 * retune — and there were three spellings, not two:
 *
 *   - this page's "Themes" heading was 12px `text-text-subtle`, while the
 *     "Sections" label forty lines above it was 10px `text-group-header`
 *   - Compare's two inline labels ("Provider", "Model") carried the
 *     colour and the size but neither the tracking nor the weight
 *
 * Asserted as a *set* of the four type tokens, over every site in the
 * app, so it does not matter in which order anybody writes them and a
 * site that gained a padding class is not a new spelling. The alias
 * itself is checked against `tailwind.config.ts` rather than trusted,
 * because the whole argument is that the two names resolve to the same
 * custom property *today*.
 * ═══════════════════════════════════════════════════════════════════════ */

const GROUP_HEADER_TOKENS = ["text-[10px]", "uppercase", "tracking-wider", "font-semibold", "text-group-header"];

/** Every element in `src` that carries the `text-group-header` alias. */
function groupHeaderSites(): { file: string; label: string; classes: string[] }[] {
  const SOURCES = [
    "src/components/sidebar/Sidebar.tsx",
    "src/routes/SettingsRoute.tsx",
    "src/routes/NotesRoute.tsx",
    "src/routes/CompareRoute.tsx",
  ];
  const sites: { file: string; label: string; classes: string[] }[] = [];
  for (const file of SOURCES) {
    const src = source(file);
    // Comments stripped first: the docblocks on two of these files
    // *quote* the treatment, and a guard that matched a sentence about
    // the class would be a guard that could never pass.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const m of code.matchAll(/className="([^"]*\btext-group-header\b[^"]*)"/g)) {
      sites.push({ file, label: m[1], classes: m[1].split(/\s+/) });
    }
  }
  return sites;
}

describe("one spelling of a group header", () => {
  it("carries the same five tokens at every site in the app", () => {
    const sites = groupHeaderSites();
    // The control on the scan, counted rather than assumed: three in the
    // sidebar, two on the settings page, two in Notes and two in Compare.
    // A scan that matched nothing would satisfy "they all agree"
    // trivially, and a scan that matched one would satisfy it just as
    // happily.
    expect(sites.length, "every group-header site must be found by the scan").toBe(9);
    expect(new Set(sites.map((s) => s.file)).size, "and across all four files").toBe(4);
    for (const { file, label } of sites) {
      for (const token of GROUP_HEADER_TOKENS) {
        expect(label, `${file}: "${label}" is missing ${token}`).toContain(token);
      }
    }
  });

  it("resolves the alias and the raw token to the same custom property", () => {
    // The premise of the whole rule, checked rather than assumed: if
    // `group-header` were not literally `--color-text-subtle`, then
    // writing one name instead of the other would already be a colour
    // change rather than a naming one, and the urgency would be higher
    // rather than lower.
    const config = repoTailwind as { theme: { extend: { colors: Record<string, string> } } };
    const alias = config.theme.extend.colors["group-header"];
    expect(alias, "group-header must be an alias, not a second colour").toBe("var(--color-text-subtle)");
    expect(config.theme.extend.colors.text.subtle, "and the token it replaces must still exist")
      .toBe("var(--color-text-subtle)");
  });

  it("finds a site that drifted, so the sweep is not vacuous", () => {
    // The control on the sweep above, over planted markup: one site
    // missing a token must be reported, and one that merely *mentions*
    // the alias inside a comment must not be counted as a site at all.
    const planted = (markup: string) =>
      [...markup.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/className="([^"]*\btext-group-header\b[^"]*)"/g)]
        .map((m) => m[1].split(/\s+/));
    expect(planted(`<div className="${GROUP_HEADER_TOKENS.join(" ")}">x</div>`)[0])
      .toEqual(expect.arrayContaining(GROUP_HEADER_TOKENS));
    const drifted = planted(`<h3 className="text-xs uppercase tracking-wider text-text-subtle font-semibold">x</h3>`);
    // The drifted site does not carry the alias, so the sweep reports it
    // as *absent* rather than as wrong — which is the other half of the
    // rule, checked here so a future reader knows the sweep is not
    // silently ignoring it.
    expect(drifted).toEqual([]);
    // A site that carries the alias but drops the tracking and the
    // weight — the exact shape Compare's two labels had — is caught, and
    // the two tokens it *does* carry are not mistaken for the failure.
    const halfSpelled = planted(`<span className="text-[10px] uppercase text-group-header">x</span>`)[0];
    expect(halfSpelled).toContain("text-[10px]");
    expect(halfSpelled).toContain("text-group-header");
    for (const token of ["tracking-wider", "font-semibold"]) {
      expect(halfSpelled, `a site that dropped ${token} must fail the sweep`).not.toContain(token);
    }
    // And the comment case: a docblock quoting the treatment is not a site.
    expect(planted(`/* className="text-[10px] uppercase tracking-wider text-group-header font-semibold" */`)).toEqual([]);
  });
});

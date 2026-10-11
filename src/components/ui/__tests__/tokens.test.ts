/**
 * The composited tokens, and the reason they are Tailwind aliases rather
 * than CSS custom properties.
 *
 * `src-tauri/src/themes.rs` seeds six built-in themes as `tokens_json`
 * rows, and `applyTheme` writes them onto `:root` as custom properties at
 * runtime. All six define the *same* 26 keys (18 colours, 4 radii, 2
 * shadows, 2 fonts) — verified mechanically below.
 *
 * So a new custom property would be undefined in all six built-in themes
 * and in every user-authored theme. A Solar user would get Solar's
 * palette everywhere plus default-coloured new chrome: a visibly broken
 * hybrid on four of six built-in themes. A Tailwind alias that composes
 * two *existing* vars is theme-following by construction and needs no
 * theme to define it. That is the whole point, and it is why the two
 * tests that follow check composition, not existence.
 *
 * ── A limit, stated rather than papered over ──────────────────────────
 * jsdom does not resolve `color-mix()`, and does not substitute `var()`
 * in `getComputedStyle` — it returns the declared value verbatim
 * (verified: `getComputedStyle(el).backgroundColor` for a
 * `color-mix(...var(--color-accent)...)` declaration comes back as the
 * literal `color-mix(...)` string, and a plain `var(--color-accent)`
 * comes back as `var(--color-accent)`). A channel-level runtime
 * assertion is therefore impossible here, and `vitest.config.ts` sets
 * `css: false`, so the generated stylesheet is not even present.
 *
 * Asserting that the class name appears in the DOM would be the
 * vacuous version of this test: it passes for a hardcoded `#7c6df0` too,
 * which is the exact bug this design avoids. So instead of pretending,
 * these tests read the real declaration out of `tailwind.config.ts`,
 * perform the `var()` substitution themselves against the values
 * `:root` actually holds, and assert the composited result is a
 * *function of the active theme*. Runtime resolution in a real browser
 * is unverifiable in jsdom; the declaration is.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const colors = tailwindConfig.theme.extend.colors as Record<string, unknown>;
const boxShadow = tailwindConfig.theme.extend.boxShadow as Record<string, unknown>;
const backgroundImage = tailwindConfig.theme.extend.backgroundImage as Record<string, unknown>;

/** The composited aliases, read from the declarations themselves. */
const NAV_ACTIVE = colors["nav-active"] as string;
const GROUP_HEADER = colors["group-header"] as string;
const NAV_GLOW = boxShadow["nav-glow"] as string;
const NAV_HIGHLIGHT = backgroundImage["nav-highlight"] as string;
const DECLARATIONS: Record<string, string> = { NAV_ACTIVE, GROUP_HEADER, NAV_GLOW, NAV_HIGHLIGHT };

/** A composited value must not reappear as a theme token or a custom property. */
const COMPOSITED_KEY = /(nav.?active|group.?header|nav.?glow)/i;

/* ── var() resolution, done by hand because jsdom will not ──────────── */

const VAR_REF = /var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/gi;

/** Every custom property a declaration depends on. */
function referencedVars(decl: string): string[] {
  return [...String(decl ?? "").matchAll(VAR_REF)].map((m) => m[1].toLowerCase());
}

/** The custom properties `:root` currently carries, in cascade order. */
function rootVars(): Map<string, string> {
  const vars = new Map<string, string>();
  // Layer 1: the default palette in globals.css.
  const rootBlock = read("src/styles/globals.css").match(/:root,\s*\[data-theme-mode="dark"\]\s*\{([\s\S]*?)\n\}/);
  expect(rootBlock, "globals.css :root block must be parseable").toBeTruthy();
  for (const m of rootBlock![1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1], m[2].trim());
  }
  // Layer 2: what the theme store wrote over the top, as applyTheme does.
  const inline = document.documentElement.style;
  for (let i = 0; i < inline.length; i++) {
    const name = inline.item(i);
    vars.set(name, inline.getPropertyValue(name).trim());
  }
  return vars;
}

/** Substitute each `var()` with what `:root` holds. Literal values pass through. */
function resolveAgainst(decl: string, vars: Map<string, string>): string {
  return String(decl ?? "").replace(VAR_REF, (_whole, name: string) => {
    const value = vars.get(name.toLowerCase());
    if (value === undefined) return `UNRESOLVED(${name})`;
    return value;
  });
}

const touched: string[] = [];
/** Sets a custom property the way `applyTheme` does, and undoes it after. */
function setThemeVar(name: string, value: string) {
  if (!touched.includes(name)) touched.push(name);
  document.documentElement.style.setProperty(name, value);
}
afterEach(() => {
  for (const name of touched.splice(0)) document.documentElement.style.removeProperty(name);
});

/* ── themes.rs — the six built-in themes, parsed, not assumed ───────── */

interface Theme { id: string; keys: Set<string> }
const BUILTIN_THEMES: Theme[] = [...read("src-tauri/src/themes.rs").matchAll(
  /id:\s*"([^"]+)",\s*\n\s*name:[^,]+,\s*\n\s*tokens_json:\s*([A-Z_]+),/g,
)].map((m) => {
  const json = read("src-tauri/src/themes.rs").match(
    new RegExp(`const ${m[2]}: &str = r##"([\\s\\S]*?)"##;`),
  );
  expect(json, `theme ${m[2]} must have a JSON body`).toBeTruthy();
  return { id: m[1], keys: new Set(Object.keys(JSON.parse(json![1]))) };
});

/* ── colour literals: the bug, in its other costume ─────────────────── */

const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(\s*in\s*(srgb|rgb)\b/i;
const NAMED_COLOUR = /^(white|black|red|blue|green|grey|gray|silver|gold|purple|orange|pink|brown|cyan|magenta|navy|teal|olive|maroon|lime|aqua|fuchsia)$/i;

describe("composited aliases exist as declarations", () => {
  it("declares nav-active and group-header as colours, and nav-glow as a boxShadow", () => {
    expect(typeof NAV_ACTIVE).toBe("string");
    expect(typeof GROUP_HEADER).toBe("string");
    // A colour alias cannot produce a `shadow-*` class on its own:
    // shadow-nav-glow has to come from boxShadow. If someone "fixes" a
    // missing shadow by moving this into colors, shadow-nav-glow stops
    // existing and this fails.
    expect(typeof NAV_GLOW).toBe("string");
    expect(colors["nav-glow"], "nav-glow must not be a colour alias").toBeUndefined();
  });

  it("composes nav-glow as a tight right-edge bloom", () => {
    // offset-x, offset-y (0 needs no unit), blur, spread. The spread is
    // negative on purpose: it pulls the shadow inside the row so a short
    // blur stays an accent instead of a haze around the 40px tab.
    const parts = NAV_GLOW.match(
      /^\s*(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+/,
    );
    expect(parts, "offset-x offset-y blur spread").not.toBeNull();
    expect(Number(parts![1]), "bloom sits on the right edge").toBeGreaterThan(0);
    expect(Number(parts![2])).toBe(0);
    expect(Number(parts![3]), "blur must stay tighter than the row").toBeLessThanOrEqual(10);
    expect(Number(parts![4]), "negative spread keeps the halo inside the row").toBeLessThan(0);
    expect(NAV_GLOW).toContain("var(--color-accent)");
  });

  it("fades the nav highlight into the active row's own colour", () => {
    // The band sits on the right and its far stop is `nav-active` itself,
    // so the fade ends at that colour and that opacity. A transparent
    // stop would fade into whatever sits behind the row instead.
    expect(NAV_HIGHLIGHT).toMatch(/^linear-gradient\(\s*to left,/);
    expect(NAV_HIGHLIGHT).toContain(NAV_ACTIVE);
    expect(NAV_HIGHLIGHT).not.toMatch(/\btransparent\b/);
    const ratios = [...NAV_HIGHLIGHT.matchAll(/var\(--color-accent\)\s+(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
    expect(Math.max(...ratios), "the right edge carries more accent than the row").toBeGreaterThan(14);
    expect(ratios).toContain(14);
  });
});

describe("nav-active follows the active theme, not the default palette", () => {
  it("mixes the accent `:root` is carrying into surface-2", () => {
    // The default palette's accent, for the contrast the assertions below make.
    const defaults = rootVars();
    expect(defaults.get("--color-accent")).toBe("#7c6df0");

    // Set a distinctly non-default accent on :root, as applyTheme does.
    setThemeVar("--color-accent", "rgb(1, 2, 3)");
    const resolved = resolveAgainst(NAV_ACTIVE, rootVars());

    // Reflects (1,2,3) — the accent the active theme is carrying.
    expect(resolved).toContain("1, 2, 3");
    // Not #7c6df0, and not its channels.
    expect(resolved).not.toContain("7c6df0");
    expect(resolved).not.toContain("124, 109, 240");
    // A composition, not a passthrough of one operand.
    expect(resolved).not.toBe("rgb(1, 2, 3)");
    expect(resolved).not.toBe(resolveAgainst("var(--color-surface-2)", rootVars()));
  });

  it("changes when the active theme's accent changes", () => {
    // A hardcoded default would produce the same string here. This is
    // the assertion that a class-name-only test cannot make.
    setThemeVar("--color-accent", "rgb(1, 2, 3)");
    const first = resolveAgainst(NAV_ACTIVE, rootVars());
    setThemeVar("--color-accent", "rgb(200, 30, 40)");
    const second = resolveAgainst(NAV_ACTIVE, rootVars());

    expect(second).toContain("200, 30, 40");
    expect(second).not.toBe(first);
  });

  it("mixes both operands, in oklab, at the specified ratio", () => {
    setThemeVar("--color-accent", "rgb(1, 2, 3)");
    setThemeVar("--color-surface-2", "rgb(28, 31, 38)");
    const resolved = resolveAgainst(NAV_ACTIVE, rootVars());

    expect(referencedVars(NAV_ACTIVE).sort()).toEqual(["--color-accent", "--color-surface-2"]);
    expect(NAV_ACTIVE).toMatch(/color-mix\(in oklab,/);
    expect(resolved).toContain("14%");
    expect(resolved).toContain("rgb(1, 2, 3)");
    expect(resolved).toContain("rgb(28, 31, 38)");
  });

  it("follows surface-2 too, not only the accent", () => {
    setThemeVar("--color-surface-2", "rgb(9, 8, 7)");
    expect(resolveAgainst(NAV_ACTIVE, rootVars())).toContain("9, 8, 7");
  });
});

describe("group-header follows text-subtle, and nav-glow follows the accent", () => {
  it("resolves group-header through --color-text-subtle", () => {
    setThemeVar("--color-text-subtle", "rgb(4, 5, 6)");
    const resolved = resolveAgainst(GROUP_HEADER, rootVars());
    expect(resolved).toBe("rgb(4, 5, 6)");
    // A direct alias, not a second copy of a colour.
    expect(GROUP_HEADER).toBe("var(--color-text-subtle)");
  });

  it("resolves nav-glow through --color-accent", () => {
    setThemeVar("--color-accent", "rgb(1, 2, 3)");
    const first = resolveAgainst(NAV_GLOW, rootVars());
    setThemeVar("--color-accent", "rgb(200, 30, 40)");
    const second = resolveAgainst(NAV_GLOW, rootVars());

    expect(first).toContain("1, 2, 3");
    expect(second).toContain("200, 30, 40");
    expect(second).not.toBe(first);
    expect(second).not.toContain("7c6df0");
  });
});

describe("no composited value is a colour literal", () => {
  it("composes every alias from vars, never from a hex, rgb() or hsl()", () => {
    for (const [name, decl] of Object.entries(DECLARATIONS)) {
      expect(decl, `${name} must be a string`).toBeTypeOf("string");
      // `transparent` is a keyword, not a theme colour, and the brief
      // specifies it for the glow. It is the one colour-ish token allowed.
      const withoutKeywords = decl.replace(/\btransparent\b/gi, " ");
      expect(withoutKeywords, `${name} must not hardcode a colour`).not.toMatch(LITERAL_COLOUR);
      for (const token of withoutKeywords.split(/[\s(),%]+/)) {
        expect(token, `${name} must not name a CSS colour keyword`).not.toMatch(NAMED_COLOUR);
      }
    }
  });

  it("gives every alias at least one var() to compose from", () => {
    for (const [name, decl] of Object.entries(DECLARATIONS)) {
      expect(referencedVars(decl).length, `${name} must compose from vars`).toBeGreaterThan(0);
      expect(resolveAgainst(decl, rootVars()), `${name} must resolve against :root`).not.toContain("UNRESOLVED(");
    }
  });
});

describe("the six built-in themes all define what the aliases need", () => {
  it("parses six built-in themes with an identical key set", () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual([
      "default-dark", "default-light", "solar", "forest", "mono", "high-contrast",
    ]);
    for (const theme of BUILTIN_THEMES) {
      // 26 design tokens — 18 colours, 4 radii, 2 shadows, 2 fonts — plus
      // `mode`, which applyTheme reads rather than writes as a colour.
      const design = [...theme.keys].filter((k) => k !== "mode");
      expect(design, `${theme.id} must define 26 design tokens`).toHaveLength(26);
      expect(theme.keys.has("mode"), `${theme.id} must declare its mode`).toBe(true);
    }
    const [first, ...rest] = BUILTIN_THEMES;
    for (const theme of rest) {
      expect([...theme.keys].sort(), `${theme.id} must match ${first.id}`).toEqual(
        [...first.keys].sort(),
      );
    }
  });

  it("defines every var the composited aliases reference, in every theme", () => {
    // This is the load-bearing check. A var that is not in all six
    // themes is the Solar-user bug: that theme's palette plus
    // default-coloured new chrome.
    const needed = new Set(
      Object.values(DECLARATIONS).flatMap((d) => referencedVars(d))
        // --color-surface-2 -> color.surface.2, --shadow-panel -> shadow.panel
        .map((v) => v.replace(/^--/, "").replace(/-/g, ".")),
    );
    expect([...needed].sort()).toEqual([
      "color.accent", "color.surface.2", "color.text.subtle",
    ]);

    for (const theme of BUILTIN_THEMES) {
      for (const key of needed) {
        expect(theme.keys.has(key), `${theme.id} must define ${key}`).toBe(true);
      }
    }
  });

  it("adds no theme key for a composited value", () => {
    // A new custom property would have to be added to every theme row.
    // Assert it was not: no theme carries a nav/group-header token.
    const composited = COMPOSITED_KEY;
    for (const theme of BUILTIN_THEMES) {
      for (const key of theme.keys) {
        expect(key, `${theme.id} must not define a composited key`).not.toMatch(composited);
      }
    }
  });

  it("adds no CSS custom property for a composited value in globals.css", () => {
    const css = read("src/styles/globals.css");
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      expect(m[1], "globals.css must not define a composited custom property")
        .not.toMatch(COMPOSITED_KEY);
    }
  });
});

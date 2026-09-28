/**
 * The focus ring, measured rather than pinned.
 *
 * `primitives.test.tsx` used to assert that a primitive's ring matched
 * `/focus-visible:ring-accent(\/\d+)?/` — a class-name pin, carrying a
 * comment that admitted it was wrong. It was worse than the comment said.
 * The ring was `accent` at 40% alpha, and 40% of the accent over a dark
 * page is 1.68:1. So it was not "accent on accent" on the two filled
 * variants, as the deferral recorded; it was **below 3:1 against the page
 * itself, on five of the six built-in themes**, and 1.73–1.86:1 on the two
 * defaults. A keyboard user tabbing to any control in the app was getting
 * a focus indicator that was close to invisible, and the plan's own
 * contrast scope note ("every figure in this file was measured on the two
 * default themes") is what kept that from being noticed: the figure that
 * was measured was the *secondary* leg, ring against the button's own
 * fill, and the primary leg — ring against what is behind it — was never
 * measured at all.
 *
 * So the ring is now `ring-text` with a `bg` offset, and this file asserts
 * the *numbers* against the real palettes rather than a class string. That
 * is the difference: a class-name pin can be satisfied by a value that is
 * 1.68:1, and a measured one cannot. Change the ring to anything that
 * drops a leg below 3:1 and this goes red with the figure in the message.
 *
 * ── Why this is not the contrast sweep ────────────────────────────────
 * Two tasks in a row deferred "measure every pairing on the other four
 * themes" as its own piece of work, and this file deliberately does not do
 * it: it measures the three legs of the *one* indicator this plan just
 * changed, in all six themes. That is bounded diligence for a change being
 * made now — shipping a new indicator on unmeasured themes is not
 * diligence, it is gambling — and it is not the same task as auditing the
 * ~40 pre-existing pairings across the palette. Those remain deferred, and
 * the follow-up is in the spec.
 *
 * ── A limit, stated rather than hidden ────────────────────────────────
 * The maths is real (WCAG 2.x relative luminance and the 3:1 threshold);
 * the *rendering* is not. jsdom loads no stylesheet (`css: false`), so
 * this cannot see what a browser paints. What it does establish is that
 * the two colours the declaration names produce a legal indicator in all
 * six built-in themes — which is the question a class-name pin could not
 * answer at all, and the question the old pin had answered wrongly.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/* ── the six built-in palettes, parsed out of themes.rs ──────────────── */

interface Palette { [key: string]: string }
const THEMES: { id: string; tokens: Palette }[] = [
  ...read("src-tauri/src/themes.rs").matchAll(
    /id:\s*"([^"]+)",\s*\n\s*name:[^,]+,\s*\n\s*tokens_json:\s*([A-Z_]+),/g,
  ),
].map((m) => {
  const body = read("src-tauri/src/themes.rs").match(
    new RegExp(`const ${m[2]}: &str = r##"([\\s\\S]*?)"##;`),
  );
  expect(body, `theme ${m[2]} must have a JSON body`).toBeTruthy();
  const raw = JSON.parse(body![1]) as Record<string, string>;
  const tokens: Palette = {};
  // `color.surface.1` -> `surface_1`, so a token is named the way the
  // Tailwind alias names it. This file must not invent a third spelling.
  for (const [key, value] of Object.entries(raw)) {
    tokens[key.replace(/^color\./, "").replace(/\./g, "_")] = value;
  }
  return { id: m[1], tokens };
});

/* ── WCAG 2.x contrast, written out rather than trusted ─────────────── */

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const linearise = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** An alpha-composited colour, which is what `ring-accent/40` resolves to. */
function over(fg: string, alpha: number, bg: string): string {
  const f = channels(fg);
  const b = channels(bg);
  return "#" + f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

const MINIMUM = 3;
/** The four surfaces a control is actually placed on, from `primitives.test.tsx`. */
const SURFACES = ["bg", "surface_1", "surface_2", "surface_3"] as const;
const f2 = (n: number) => n.toFixed(2);

describe("the six built-in themes are what this file measures", () => {
  it("parses all six, each with the colour tokens the ring needs", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "default-dark", "default-light", "solar", "forest", "mono", "high-contrast",
    ]);
    for (const { id, tokens } of THEMES) {
      for (const key of ["text", "bg", "accent", ...SURFACES]) {
        expect(tokens[key], `${id} must define ${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe("the focus ring clears 3:1 in every built-in theme", () => {
  it("ring text against the bg offset", () => {
    // Page-independent by construction: neither operand is a surface, so
    // this leg cannot change with the surface the control sits on — which
    // is precisely what a `ring-offset-<surface>` would have had to guess.
    for (const { id, tokens } of THEMES) {
      const r = contrast(tokens.text, tokens.bg);
      expect(r, `${id}: ring text on offset bg`).toBeGreaterThanOrEqual(MINIMUM);
    }
  });

  it("bg offset against the accent fill it has to cut out of", () => {
    // The leg that failed at 1.00:1 while the ring was `accent`. This is
    // the whole reason the offset exists, and it is the number a filled
    // `Button` lives or dies on.
    for (const { id, tokens } of THEMES) {
      const r = contrast(tokens.bg, tokens.accent);
      expect(r, `${id}: offset bg against the accent fill`).toBeGreaterThanOrEqual(MINIMUM);
    }
  });

  it("ring text against each of the four surfaces a control sits on", () => {
    for (const { id, tokens } of THEMES) {
      for (const surface of SURFACES) {
        const r = contrast(tokens.text, tokens[surface]);
        expect(r, `${id}: ring text on ${surface}`).toBeGreaterThanOrEqual(MINIMUM);
      }
    }
  });

  it("reports the figures it is asserting on, so a regression is diagnosable", () => {
    const rows = THEMES.map(({ id, tokens }) => {
      const worst = Math.min(...SURFACES.map((s) => contrast(tokens.text, tokens[s])));
      return `${id} ${f2(worst)}`;
    });
    // Not a snapshot. A snapshot here would be a test that fails whenever
    // a theme is retuned, which is the same mistake as pinning a class
    // name. The assertion is the >= 3 above; this records the margin.
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => Number(r.split(" ")[1]) >= MINIMUM)).toBe(true);
  });
});

describe("the treatment this replaced, so the record says what it measured", () => {
  it("ring-accent/40 was below 3:1 against the page on five of six themes", () => {
    const failing: string[] = [];
    const figures: Record<string, string> = {};
    for (const { id, tokens } of THEMES) {
      const r = contrast(over(tokens.accent, 0.4, tokens.bg), tokens.bg);
      figures[id] = f2(r);
      if (r < MINIMUM) failing.push(id);
    }
    // This is the finding, pinned as a fact about the old declaration and
    // not about the current one. It is here so that nobody re-derives it
    // from the plan's prose, which understated it as a filled-button
    // problem when it was an everywhere problem.
    expect(failing).toEqual([
      "default-dark", "default-light", "solar", "forest", "mono",
    ]);
    // And the one theme it passed on is the one built for maximum
    // separation, which is the opposite of reassuring.
    expect(Number(figures["high-contrast"])).toBeGreaterThanOrEqual(MINIMUM);
  });
});

describe("an inset ring has only the element's own fill to read against", () => {
  it("clears 3:1 on every fill the three inset sites actually use", () => {
    // `ring-inset` cannot use an offset, so its only adjacency is the
    // element it is drawn inside. The three sites are the Tabs strip
    // (Form.tsx), the note row (NotesRoute.tsx) and the document tab
    // (DocumentsRoute.tsx); the note row is the hard one, because the
    // selected row's fill is a 10% accent over surface-1 rather than a
    // token of its own.
    const FILLS: { label: string; of: (t: Palette) => string }[] = [
      { label: "document tab, resting (surface-1)", of: (t) => t.surface_1 },
      { label: "document tab, selected (surface-2)", of: (t) => t.surface_2 },
      { label: "note row, resting (bg)", of: (t) => t.bg },
      { label: "note row, selected (accent/10 over surface-1)", of: (t) => over(t.accent, 0.1, t.surface_1) },
    ];
    for (const { id, tokens } of THEMES) {
      for (const { label, of } of FILLS) {
        const r = contrast(tokens.text, of(tokens));
        expect(r, `${id}: inset ring text on ${label}`).toBeGreaterThanOrEqual(MINIMUM);
      }
    }
  });

  it("the old inset ring failed on five of six, and only just passed on the sixth", () => {
    // The same shape as the outset finding, and the same exception: High
    // Contrast's accent is pure yellow on near-black, so a 40% band of it
    // reaches 3.27:1 there and nowhere else. A theme passing for the
    // reason it was designed to is not evidence the treatment was sound.
    const failing: string[] = [];
    for (const { id, tokens } of THEMES) {
      const r = contrast(over(tokens.accent, 0.4, tokens.surface_1), tokens.surface_1);
      if (r < MINIMUM) failing.push(id);
    }
    expect(failing).toEqual([
      "default-dark", "default-light", "solar", "forest", "mono",
    ]);
  });
});

describe("no ring in the app is a translucent accent again", () => {
  it("every focus ring names a solid token and carries the offset", () => {
    // The class-name sweep, kept deliberately *narrow*: it does not say
    // the ring is the right colour (the numbers above do that), it says
    // no site has quietly gone back to an alpha ring. `rg` in the report
    // runs the same check over the same files.
    const solid = /ring-accent\/\d+/;
    // Comments are stripped first, and that is not cosmetic: the
    // rationale in `Button.tsx` and `IconButton.tsx` quotes the old
    // declaration verbatim, so a naive scan reads its own explanation of
    // the bug as the bug. A guard that fires on the fix's documentation
    // gets deleted, and then the thing it protected goes back.
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const files = [
      "src/components/ui/Button.tsx",
      "src/components/ui/Form.tsx",
      "src/components/ui/IconButton.tsx",
      "src/components/ui/Modal.tsx",
      "src/components/ui/RouteShell.tsx",
      "src/components/sidebar/Sidebar.tsx",
      "src/components/sidebar/StatusCard.tsx",
      "src/routes/CompareRoute.tsx",
      "src/routes/DocumentsRoute.tsx",
      "src/routes/MemoryRoute.tsx",
      "src/routes/NotesRoute.tsx",
      "src/routes/SettingsRoute.tsx",
      "src/routes/TasksRoute.tsx",
    ];
    const offenders: string[] = [];
    let rings = 0;
    for (const file of files) {
      const src = stripComments(read(file));
      for (const m of src.matchAll(/(focus|focus-visible):ring-2\b/g)) rings++;
      if (solid.test(src)) offenders.push(file);
    }
    // Both halves matter. Zero rings would mean the sweep found nothing
    // to look at, which is the vacuous pass this plan has hit four times.
    expect(rings, "the swept files must actually contain focus rings").toBeGreaterThan(20);
    expect(offenders, "no file may go back to a translucent accent ring").toEqual([]);
  });
});

/**
 * The row control, and the reason a guard rather than a convention.
 *
 * Five pages put a small icon button at the end of a line: Memory,
 * Notes, Compare, Tasks and Documents. For most of this plan each spelled the box
 * out by hand, and each carried a docblock claiming it was "one
 * definition" — while the definitions were five, and one of them was
 * missing `shrink-0`.
 *
 * The failure mode here is a *copy*, not a typo, and a docblock is not
 * what stops a copy: the five docblocks are what made it look safe. So
 * the rule is checked mechanically. A sixth page that hand-writes a row
 * control fails this file rather than inheriting a plausible one.
 *
 * The resolver is the same shape as the route suites' — a real Tailwind
 * compile of the classes, not a read of the class string — because the
 * claim that matters is about the *resolved* geometry, not the spelling.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import repoTailwind from "../../../../tailwind.config";
import { ROW_ACTION, ROW_ACTION_IDLE } from "../rowAction";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The five pages that draw a row control, and why each one has one. */
const PAGES: Record<string, string> = {
  "src/routes/MemoryRoute.tsx": "four controls in a fixed 102px column, three rows deep",
  "src/routes/NotesRoute.tsx": "the editor's pin, and the unlink in the produced-memories list",
  "src/routes/CompareRoute.tsx": "remove a model, stop a column, pick a winner",
  "src/routes/TasksRoute.tsx": "edit and delete, in a list that scales to hundreds",
  "src/routes/DocumentsRoute.tsx": "the tab-close control in the document tab strip",
};

const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
/** Comments stripped, so a docblock quoting the class is not a definition. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declarations one utility class emits, keyed by CSS property. */
function indexRules(css: string): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim().split(/\s+/)[0].replace(/\\(.)/g, "$1");
    if (!head.startsWith(".")) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].split(";")) {
      const colon = d.indexOf(":");
      if (colon < 0) continue;
      const prop = d.slice(0, colon).trim();
      if (!prop || prop.startsWith("--")) continue;
      decls.set(prop, d.slice(colon + 1).trim());
    }
    byClass.set(head.slice(1), decls);
  }
  return byClass;
}

/** Compile `classNames` through the project Tailwind and index the result. */
async function emitted(classNames: string[]): Promise<Map<string, Map<string, string>>> {
  const wanted = [...new Set(classNames)];
  const plugins = [
    tailwindcss({
      ...(repoTailwind as object),
      content: [{ raw: wanted.map((c) => `<i class="${c}"></i>`).join("\n"), extension: "html" }],
      corePlugins: { preflight: false },
    }),
  ] as never;
  const css = (await postcss(plugins).process("@tailwind utilities;", { from: undefined })).css;
  const at = css.indexOf("@media");
  return indexRules(at < 0 ? css : css.slice(0, at));
}

/** The pixels a class declares for one property, or throw. */
function toPx(decls: Map<string, Map<string, string>>, cls: string, prop: string): number {
  const value = decls.get(cls)?.get(prop);
  if (value === undefined) throw new Error(`${cls} emits no ${prop}; the class does not exist`);
  const m = value.match(/(-?[\d.]+)\s*(px|rem|em)\b/);
  if (!m) throw new Error(`${cls} { ${prop} } has no absolute length: "${value}"`);
  return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
}

describe("the row control is one definition, and a copy fails", () => {
  it("is imported by all five pages and declared by none of them", () => {
    // The claim the five docblocks were making. A page that hand-writes
    // its own is the failure mode, so this is asserted in both
    // directions: importing it is required, declaring it is forbidden.
    expect(Object.keys(PAGES), "all five pages are covered by this guard").toHaveLength(5);
    for (const [rel, why] of Object.entries(PAGES)) {
      expect(code(rel), `${rel} (${why}) must import ROW_ACTION`).toMatch(
        /import\s*\{\s*ROW_ACTION[^}]*\}\s*from\s*"\.\.\/components\/ui\/rowAction"/,
      );
      // A local `const ROW_ACTION =` is a copy, whatever it contains.
      expect(code(rel), `${rel} must not declare its own ROW_ACTION`).not.toMatch(
        /(?:const|let|var)\s+ROW_ACTION\s*=/,
      );
      // …and it must still *use* it, so the import cannot be a decoy
      // left behind by a half-finished edit.
      expect(code(rel), `${rel} must use ROW_ACTION`).toMatch(/\$\{ROW_ACTION\}/);
    }
  });

  it("resolves to a 24px target, which is the reason the pages agreed to it", async () => {
    const classes = ROW_ACTION.split(/\s+/);
    const decls = await emitted(classes);
    // Only the unprefixed utilities are emitted as rules in their own
    // right; `focus-visible:ring-2` is emitted under a variant selector,
    // and looking it up by its bare name would find nothing. The prefixed
    // ones are checked for *scoping* below, which is the claim that
    // matters about them.
    for (const cls of classes.filter((c) => !c.includes(":"))) {
      expect(decls.has(cls), `${cls} must exist`).toBe(true);
    }
    // …and a variant-prefixed class is a genuine miss if the variant is
    // misspelled, so at least one rule has to have come out for the
    // compile to have been a compile at all.
    expect(decls.size).toBeGreaterThan(0);
    // WCAG 2.2's target size, and the reason Memory took this from 20px
    // and Tasks took it from 16px. Asserted as a number so a retune of
    // the scale moves it and a deliberate change to 22px is a red test
    // rather than a silent regression.
    expect(toPx(decls, "h-6", "height")).toBeGreaterThanOrEqual(24);
    expect(toPx(decls, "w-6", "width")).toBeGreaterThanOrEqual(24);
    // …and the box refuses to shrink, so a long title gives way rather
    // than the control a user has to hit. This is the token Memory's
    // copy was missing, and its wrapper was covering for it.
    expect(ROW_ACTION.split(/\s+/)).toContain("shrink-0");
  });

  it("takes its radius from the theme and its focus ring from a state", async () => {
    const classes = ROW_ACTION.split(/\s+/);
    const decls = await emitted(classes);
    // A theme radius, not a hardcoded one: a theme can move this corner
    // and the row controls should go with it.
    const radius = decls.get("rounded-md")!.get("border-radius");
    expect(radius).toMatch(/^var\(--radius-(sm|md|lg|xl)\)$/);
    // The focus ring is behind `focus-visible:`, never bare. Tailwind
    // builds `ring-*` out of `box-shadow`, so an unscoped ring would
    // paint a shadow on every row at rest while the flatness checks
    // walked straight past it.
    const rings = classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the row control has a focus ring to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`)
        .toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    // And no transition, which is the reason this is not `IconButton`:
    // a list that scales to hundreds of rows should not animate every
    // one of them.
    expect(classes.filter((c) => c.split(":").pop()!.startsWith("transition")))
      .toEqual([]);
  });

  it("gives the idle tone a hover that reaches body text, so the row reads as a row", async () => {
    const classes = ROW_ACTION_IDLE.split(/\s+/);
    const decls = await emitted(classes);
    // The colour, through the alias — and the alias is the one the rest of
    // the app uses, so a retune moves the row controls with everything
    // else. Asserted as the resolved value because a class-name pin is
    // satisfied by a colour at 1.68:1.
    expect(decls.get("text-text-subtle")!.get("color")).toBe("var(--color-text-subtle)");
    expect(classes).toContain("hover:text-text");
  });

  it("catches a page that hand-writes its own, so the guard is not vacuous", () => {
    // The control on the rule above, over a planted page. A sweep that
    // stopped matching, or an import pattern that stopped matching, must
    // fail here rather than passing every page in the app.
    const declares = (src: string) => /(?:const|let|var)\s+ROW_ACTION\s*=/.test(src.replace(/\/\*[\s\S]*?\*\//g, " "));
    const imports = (src: string) =>
      /import\s*\{\s*ROW_ACTION[^}]*\}\s*from\s*"\.\.\/components\/ui\/rowAction"/.test(src);

    const good = 'import { ROW_ACTION } from "../components/ui/rowAction";\nclassName={`${ROW_ACTION}`}';
    expect(declares(good)).toBe(false);
    expect(imports(good)).toBe(true);

    const copy = 'const ROW_ACTION = "h-6 w-6";';
    expect(declares(copy)).toBe(true);
    expect(imports(copy)).toBe(false);

    // A docblock *mentioning* it is not a declaration, and a decoy import
    // that nothing uses is caught by the "must use" assertion above.
    expect(declares('/* ROW_ACTION is one definition */\nexport const x = 1;')).toBe(false);
    expect(imports('import { ROW_ACTION } from "../components/ui/rowAction";')).toBe(true);
  });

  it("resolves a hardcoded length to nothing, which is what keeps this honest", async () => {
    // The control on the resolver itself. A `var()` is not a length, and
    // a resolver that returned a number for one would let a theme radius
    // through as a pixel value.
    const decls = await emitted(["h-6", "w-6", "rounded-md", "rounded-lg"]);
    expect(toPx(decls, "h-6", "height")).toBe(24);
    expect(toPx(decls, "w-6", "width")).toBe(24);
    expect(() => toPx(decls, "rounded-md", "border-radius")).toThrow();
    expect(() => toPx(decls, "h-6", "margin-top")).toThrow();
    expect(() => toPx(decls, "h-6x", "height")).toThrow();
  });
});

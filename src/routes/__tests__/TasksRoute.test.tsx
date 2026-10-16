import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { TasksRoute } from "../TasksRoute";
import repoTailwind from "../../../tailwind.config";

/* ═══════════════════════════════════════════════════════════════════════
 * Measuring the page, not spelling it.
 *
 * `vitest.config.ts` sets `css: false`, so jsdom has no stylesheet and
 * `getComputedStyle` cannot answer the only question a rhythm turns on:
 * *how much air is between two rows?* The tempting substitute is
 * `expect(list.className).toContain("space-y-1")`, and it is the wrong test
 * twice over. It pins a class name, which is an implementation detail that
 * the next task will change for no reason, and it passes for any page that
 * merely *says* `space-y-1` — including one that got denser using
 * something else entirely.
 *
 * So the numbers below come from the project's own Tailwind compiling the
 * classes the page actually rendered, and from the declaration that comes
 * out. A row is 8px inside whether it says `p-2`, `px-2 py-2`, or something
 * a later task invents; a class that does not exist emits no rule at all,
 * which is a loud failure here rather than a silent zero.
 *
 * The resolver is duplicated from `MemoryRoute.test.tsx`,
 * `NotesRoute.test.tsx`, `CompareRoute.test.tsx` and
 * `DocumentsRoute.test.tsx` on purpose. A shared test helper would be five
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
 * Needed wherever two classes of the same family sit on one element, and
 * the question is which of them owns the property.
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

const tasks = [
  {
    id: "task-open",
    title: "Ship release",
    body: "Run the release gates",
    due_at: "2020-01-01",
    completed_at: null,
    priority: 3,
    session_id: null,
    created_at: "now",
  },
  {
    id: "task-done",
    title: "Write notes",
    body: null,
    due_at: null,
    completed_at: "2026-08-01T00:00:00Z",
    priority: 1,
    session_id: null,
    created_at: "now",
  },
];

describe("TasksRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listTasks").mockResolvedValue(tasks);
    vi.spyOn(api, "upsertTask").mockResolvedValue("task-new");
    vi.spyOn(api, "completeTask").mockResolvedValue(undefined);
    vi.spyOn(api, "deleteTask").mockResolvedValue(undefined);
  });

  it("renders task fields and filters completed and overdue work", async () => {
    render(
      <MemoryRouter>
        <TasksRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Run the release gates")).toBeInTheDocument();
    expect(screen.getByText("overdue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByText("Write notes")).toBeInTheDocument();
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();
  });

  it("creates and edits tasks with body, due date, and priority", async () => {
    render(
      <MemoryRouter>
        <TasksRoute />
      </MemoryRouter>,
    );
    await screen.findByText("Ship release");

    fireEvent.change(screen.getByPlaceholderText("New task…"), { target: { value: "New task" } });
    fireEvent.change(screen.getByPlaceholderText("Details (optional)"), { target: { value: "Body" } });
    fireEvent.change(screen.getByLabelText("New task due date"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.upsertTask).toHaveBeenCalledWith({
      title: "New task",
      body: "Body",
      due_at: "2026-09-01",
      priority: 0,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Edit Ship release" }));
    const editTitle = screen.getByDisplayValue("Ship release");
    fireEvent.change(editTitle, { target: { value: "Ship RC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      id: "task-open",
      title: "Ship RC",
    })));
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The restyle's guards.
 *
 * Every one is written to fail if the thing it guards is removed, and every
 * walk either proves the subtree was there or throws.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A third, un-completed, task so the list is never down to two rows. */
const THIRD = {
  id: "task-plain",
  title: "Read the spec",
  body: null,
  due_at: null,
  completed_at: null,
  priority: 0,
  session_id: null,
  created_at: "now",
};

function serveTasks(rows: unknown[] = [tasks[0], tasks[1], THIRD]) {
  vi.spyOn(api, "listTasks").mockResolvedValue(rows as never);
  vi.spyOn(api, "upsertTask").mockResolvedValue("task-new");
  vi.spyOn(api, "completeTask").mockResolvedValue(undefined);
  vi.spyOn(api, "deleteTask").mockResolvedValue(undefined);
}

const renderTasks = () =>
  render(
    <MemoryRouter>
      <TasksRoute />
    </MemoryRouter>,
  );

/**
 * The task list, reached through a control *inside* a row rather than by
 * tag, so this cannot return a list that is not on the page. It is also the
 * non-vacuity control for every walk below: `render()` returns before the
 * task list lands, and a walk taken then sees a page with no rows on it.
 */
async function taskList(container: HTMLElement): Promise<HTMLUListElement> {
  const complete = await within(container).findAllByRole("button", { name: /^(Complete|Reopen) / });
  const row = complete[0].closest("li");
  expect(row, "a task row must be an <li>").toBeTruthy();
  const list = row!.parentElement;
  expect(list?.tagName, "task rows must hang off one <ul>").toBe("UL");
  expect(complete.length, "the list must really have three rows on it").toBe(3);
  return list as HTMLUListElement;
}

/**
 * The composer's card, reached through its first field rather than by class.
 *
 * A task list is not the page's only list: the composer stacks three field
 * groups and takes the same compact rhythm, and a guard that only measured
 * the task rows would let the composer drift back to the standard one
 * unnoticed.
 */
async function composerCard(): Promise<HTMLElement> {
  const field = await screen.findByPlaceholderText("New task…");
  const firstGroup = field.closest("div");
  expect(firstGroup!.className, "the composer's first group is a flex row").toMatch(/flex/);
  const card = firstGroup!.parentElement!;
  expect(card.className, "and its parent is the card").toMatch(/border/);
  return card;
}

/** The rhythm the page actually ships, read out of its own classes. */
async function rhythmOf(list: Element, row: Element): Promise<Rhythm> {
  return {
    gap: await pxOn(list, /^space-y-/, "margin-top"),
    pad: await pxOn(row, /^p-/, "padding"),
  };
}

describe("TasksRoute density: the compact rhythm, measured", () => {
  beforeEach(() => serveTasks());

  it("spaces the task rows tighter than the standard rhythm every other page uses", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    const compact = await rhythmOf(list, list.firstElementChild!);
    const standard = await standardRhythm();

    // Read out of the stylesheet the build produces, from the classes the
    // page rendered. `space-y-1` and `p-2` are the current spellings; the
    // assertion is about four and eight pixels, and any other spelling of
    // those numbers would pass without an edit.
    expect(compact.gap).toBeLessThan(standard.gap);
    expect(compact.pad).toBeLessThan(standard.pad);
    // And the measurement is of the *compact* rhythm, not merely of
    // something smaller: asserted as a comparison, so a retune of the
    // spacing scale moves both sides.
    const known = await compactRhythm();
    expect(compact.gap).toBe(known.gap);
    expect(compact.pad).toBe(known.pad);
    // …and it is a rhythm, not nothing: rows whose edges touch are one box.
    expect(compact.gap).toBeGreaterThan(0);
  });

  it("gives the composer the same compact rhythm, because it is a list too", async () => {
    renderTasks();
    const card = await composerCard();
    const composer = await rhythmOf(card, card);
    const standard = await standardRhythm();
    const known = await compactRhythm();

    expect(composer.gap).toBe(known.gap);
    expect(composer.pad).toBe(known.pad);
    expect(composer.gap).toBeLessThan(standard.gap);
    expect(composer.pad).toBeLessThan(standard.pad);
  });

  it("keeps the composer-to-list boundary at the standard step, because a section is not a row", async () => {
    const { container } = renderTasks();
    await taskList(container);
    const card = await composerCard();
    const standard = await standardRhythm();
    // The 4px that would make it a row gap is exactly the mistake: a
    // boundary that reads as a row gap is how a dense page becomes an
    // unreadable one. So the space below the composer is asserted to be at
    // least the standard step, while the space *inside* it is half that.
    expect(await pxOn(card, /^mb-/, "margin-bottom")).toBeGreaterThanOrEqual(standard.gap);
  });

  it("bounds the measure on a wide window, so a long title does not run the full width", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    const column = list.parentElement!;
    // 48rem is the measure the Memory page's column uses and the reason it
    // uses it: roughly 75 characters of the title and body a task row
    // carries. A `max-w-*` bounds a measure and can never squeeze a narrow
    // window, so it plays no part in the density comparison above — and on a
    // 2560px monitor it is the only thing standing between a row and a
    // 2000px line of text.
    expect(await pxOn(column, /^max-w-/, "max-width")).toBeLessThanOrEqual(48 * 16);
    // The control: the column really does carry the bound, rather than the
    // assertion passing on an element that never had one.
    expect(column.className).toMatch(/max-w-/);
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
    expect(await rhythmOf(standardHost.querySelector("ul")!, standardHost.querySelector("li")!)).toEqual(standard);
    const compactHost = read('<ul class="space-y-1"><li class="p-2"></li></ul>');
    expect(await rhythmOf(compactHost.querySelector("ul")!, compactHost.querySelector("li")!)).toEqual(compact);

    // A class the page does not use is a failure, not a zero. This is what
    // keeps the resolver honest: without it, a typo in a class name would
    // read as "no padding at all" and sail through as compact.
    const typo = document.createElement("ul");
    typo.className = "space-y-1x";
    await expect(pxOn(typo, /^space-y-/, "margin-top")).rejects.toThrow();
    // And a page with no rhythm at all is a failure too.
    const bare = document.createElement("ul");
    await expect(pxOn(bare, /^space-y-/, "margin-top")).rejects.toThrow();
    // A `var()` is not a number either: reading one as a length is the lie
    // this block exists to avoid, and it throws rather than guessing.
    const themed = document.createElement("ul");
    themed.className = "rounded-lg";
    await expect(pxOn(themed, /^rounded-/, "border-radius")).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flat, and no literal colour.
 *
 * The reference is flat: a card is a surface and a 1px border, and a shadow
 * on a task row is a regression against that rather than a finishing touch.
 * The only `box-shadow` in the app belongs to things that genuinely float,
 * and the only one of those on this page is the delete confirmation.
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

describe("TasksRoute stays flat", () => {
  beforeEach(() => serveTasks());

  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = renderTasks();
    // Awaited, and this is not tidiness. `render()` returns before the task
    // list lands, so a walk taken immediately sees a page with no rows and
    // no controls on it and reports a clean tree.
    await taskList(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("lets the one floating surface on this page float, and no other", async () => {
    // The delete confirmation is a `Modal` behind a `ConfirmDialog`, and a
    // modal overlaps the page — a shadow is the only thing separating an
    // overlay from a card in the flow. Asserted so a later "flatten
    // everything" commit argues with a test rather than with taste.
    const { container } = renderTasks();
    const list = await taskList(container);
    expect(paintForcing(container, ["box-shadow"])).toEqual([]);

    cleanup();
    const open = renderTasks();
    await taskList(open.container);
    fireEvent.click(within(open.container).getByRole("button", { name: "Delete Ship release" }));
    await screen.findByRole("dialog");
    expect(paintForcing(open.container, ["box-shadow"]).length).toBeGreaterThan(0);
    expect(list.tagName).toBe("UL");
  });

  it("scopes every focus ring to a state, so no row paints a shadow at rest", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A *bare*
    // `ring-2` would put a shadow on every row at rest and the shadow check
    // would still call the page clean.
    //
    // `focus:` and `focus-visible:` both satisfy it. Which one a control
    // takes is a judgement: the two fields take `focus:`, because a field
    // should show where the caret is however it got there, and the two row
    // buttons take `focus-visible:`, because clicking one acts immediately.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    const date = screen.getByLabelText("New task due date");
    expect(classMatching(date, /ring-/)).toMatch(/^focus:ring-/);
    const complete = within(list).getByRole("button", { name: "Complete Ship release" });
    expect(classMatching(complete, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("animates nothing inside the task list", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    // Scoped to the list, and the scope is the argument: a task list is the
    // subtree that scales to hundreds of rows, which is the same reason the
    // streaming subtree is fenced and the same reason `MemoryRoute` drops
    // its row transitions. The handful of controls that are not the list
    // keep theirs — including the composer's, which is a fixed three groups.
    expect(paintForcing(list, ["transition"])).toEqual([]);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // The negative control, so none of the checks above can pass by being
    // blind. The inline shadow is assembled rather than written out, for
    // the reason the colour control assembles its literals:
    // `tailwind.config.ts` globs this test tree, so a written-out one ships
    // as a dead production rule.
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
      '<div class="bg-surface-2 border border-border"></div>',
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
    // And the scopes really do differ: a page-wide sweep would have caught
    // all seven, a list-only sweep only the two transitions.
    expect(paintForcing(host, ["transition"])).toHaveLength(2);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    const { container } = renderTasks();
    await taskList(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders behind a dialog or in the
    // edit form is covered too.
    const src = source("src/routes/TasksRoute.tsx");
    expect(src, "TasksRoute.tsx must not hardcode a colour").not.toMatch(COLOUR_LITERAL);
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
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/15", "accent-[var(--color-accent)]"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The shared vocabulary, and the behaviour the restyle had to keep.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("TasksRoute in the shared vocabulary", () => {
  beforeEach(() => serveTasks());

  it("gives every box a theme radius, and every radius on the page is a theme radius", async () => {
    const { container } = renderTasks();
    await taskList(container);
    await prewarm(container);
    // Two walks, because one was not enough — the second exists because a
    // mutation on the Documents page proved the first blind.
    //
    // (a) *Every box draws a theme radius*, scoped by "draws a box on every
    // side" — a bare `border` class, not any `border-*`, so the
    // `border-t`-carrying rules between cards are not boxes and are not
    // demanded one.
    //
    // (b) *Every radius on the page is a theme radius*, which is what
    // reaches the complete toggle: a *completed* row's box is
    // `border-accent` and a bare `border-border-strong`, so it carries no
    // bare `border` class and walk (a) cannot see it.
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
    // box, and not merely the row it started from.
    expect(radii.size).toBeGreaterThan(1);
  });

  it("keeps the complete toggle and the row controls at or above the minimum target size", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    await prewarm(container);
    // The complete toggle was a 16px box. It is the row's primary control
    // and a task list is the one place in the app where tapping the wrong
    // row has consequences, so WCAG 2.2's target size applies and the box
    // is 24px.
    const complete = within(list).getByRole("button", { name: "Complete Ship release" });
    expect(await pxOn(complete, /^w-/, "width")).toBeGreaterThanOrEqual(24);
    expect(await pxOn(complete, /^h-/, "height")).toBeGreaterThanOrEqual(24);
    // …and it still refuses to shrink, so a long title gives way rather than
    // the control a user has to hit.
    expect(complete.className).toMatch(/shrink-0/);

    for (const name of ["Edit Ship release", "Delete Ship release"]) {
      const control = within(list).getByRole("button", { name });
      expect(await pxOn(control, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(control, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      expect(control).toHaveAttribute("type", "button");
      // A hover affordance as well as a name: `aria-label` is what a screen
      // reader reads, `title` is what a sighted mouse user reads.
      expect(control).toHaveAttribute("title");
    }
  });

  it("sizes the three filter buttons alike and on the cluster's label, and keeps the native checkboxes on the theme accent", async () => {
    const { container } = renderTasks();
    await taskList(container);
    await prewarm(container);
    // Resolved, not spelled. The filter was 10px type in 8px of padding
    // with no focus ring, while the two checkboxes beside it in the same
    // cluster are 12px — a control set that reads as two things. This
    // page's cluster holds only the filter and the checkboxes, so unlike
    // the Memory page's there is no header `Button` to match against, and
    // the claim is the one that is true here: all three buttons agree with
    // each other and with the cluster's own label size.
    const buttons = ["All", "Open", "Completed"].map((name) => screen.getByRole("button", { name }));
    for (const button of buttons) {
      const clusterLabel = screen.getByText("Overdue");
      expect(await fontSizeOf(button)).toBe(await fontSizeOf(clusterLabel));
    }
    // The control on the comparison: the composer's `Add` is a
    // `size="md"` `Button` at 14px, so 12px above is not the default state.
    expect(await fontSizeOf(screen.getByRole("button", { name: "Add" }))).not.toBe(await fontSizeOf(buttons[0]));
    for (const [prop, re] of [["padding-left", /^px-/], ["padding-top", /^py-/]] as const) {
      for (const button of buttons) {
        expect(await pxOn(button, re, prop), `${button.textContent} { ${prop} }`).toBe(await pxOn(buttons[0], re, prop));
      }
    }
    // …and each carries a focus ring, which none of them did.
    for (const button of buttons) {
      expect(classMatching(button, /ring-/)).toMatch(/^focus-visible:ring-/);
    }

    // `accent-[var(--color-accent)]` is how a native checkbox takes the
    // theme's accent. Asserted as the resolved value, because a class name
    // here would be an implementation detail and the claim is that the
    // checkbox follows the theme.
    for (const name of ["Overdue", "Show completed"]) {
      const box = screen.getByRole("checkbox", { name });
      const cls = await classDeclaring(box, "accent-color");
      expect(
        declValue((await emitted([cls])).get(cls)!, "accent-color", cls),
        `${cls} on the ${name} checkbox`,
      ).toBe("var(--color-accent)");
    }
  });

  it("still filters, still marks what is done, and still edits", async () => {
    const { container } = renderTasks();
    const list = await taskList(container);
    // The filter is a filter: it changes which rows are on the page.
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(within(list).queryByText("Ship release")).not.toBeInTheDocument();
    expect(within(list).getByText("Write notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    // A completed task is visibly completed — the dimming is the claim, and
    // it is what says a row is done without reading a word of it.
    const rows = Array.from(list.children);
    const dimmed = rows.filter((r) => r.className.includes("opacity-60"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0].textContent).toContain("Write notes");
    expect(rows[0].className).not.toMatch(/opacity-60/);

    // The two controls still reach their own commands.
    fireEvent.click(within(list).getByRole("button", { name: "Complete Ship release" }));
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledWith("task-open", true));
    // Re-found from the document, not through the `<ul>` captured before the
    // refresh: completing a task re-reads the list, and a click aimed at a
    // detached button is a click that silently does nothing.
    fireEvent.click(await screen.findByRole("button", { name: "Edit Ship release" }));
    expect(await screen.findByDisplayValue("Ship release")).toBeInTheDocument();
    // …and the edit form is the row's own, not a dialog.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position, so
 * `h1` followed by `h3` is a defect rather than a nit. `RouteShell` owns
 * this page's `h1`, so the empty state's title has to be an `h2` — which is
 * what `EmptyState`'s `headingLevel` is for. The populated list and the
 * delete confirmation are separate subtrees and both are walked.
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

describe("TasksRoute heading outline", () => {
  beforeEach(() => serveTasks());

  it("skips no heading level in any state the page can be in", async () => {
    // 1 — the populated list, which is where a user spends their time and
    // the only state with no heading but the page's own.
    const list = renderTasks();
    await taskList(list.container);
    expectNoHeadingSkip(list.container, "the task list");

    // 2 — the edit form. A different subtree from the one above: the row's
    // two controls are replaced by three fields, so a fix to one says
    // nothing about the rest.
    cleanup();
    const editing = renderTasks();
    await taskList(editing.container);
    fireEvent.click(within(editing.container).getByRole("button", { name: "Edit Ship release" }));
    await screen.findByDisplayValue("Ship release");
    expectNoHeadingSkip(editing.container, "a task in edit");

    // 3 — the empty state, whose title is the one the primitive got wrong by
    // default.
    cleanup();
    serveTasks([]);
    const empty = renderTasks();
    await screen.findByText("No tasks");
    expectNoHeadingSkip(empty.container, "no tasks at all");
    expect(await screen.findByRole("heading", { name: "No tasks" })).toHaveProperty("tagName", "H2");

    // 4 — the delete confirmation, the last heading-bearing subtree left.
    cleanup();
    serveTasks();
    const confirm = renderTasks();
    await taskList(confirm.container);
    fireEvent.click(within(confirm.container).getByRole("button", { name: "Delete Ship release" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(confirm.container, "the delete confirmation");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Tasks</h1><h3>No tasks</h3>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h1 .* followed by h3/);
    expect(headingLevels(skip)).toHaveLength(2);

    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Tasks</h1><h2>One</h2><h2>Two</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });
});

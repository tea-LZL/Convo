import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, Note, NoteWithLinks } from "../../lib/api";
import { NotesRoute } from "../NotesRoute";
import repoTailwind from "../../../tailwind.config";

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
 * out. A row is 12px inside whether it says `p-3`, `px-3 py-3`, or
 * something a later task invents; a class that does not exist emits no
 * rule at all, which is a loud failure here rather than a silent zero.
 *
 * The resolver is duplicated from `MemoryRoute.test.tsx` on purpose. A
 * shared test helper would be five commits touching one file, and the
 * whole point of the one-commit-per-route rule is that a reviewer who
 * dislikes one page's treatment can reject that commit alone. Five copies
 * of a resolver is the price of that, and the copies are identical.
 *
 * The limit, stated rather than hidden: this is the *stylesheet* the
 * build produces, not a browser's layout. It knows how wide a row is
 * declared to be; it does not know how tall a paragraph wrapped to three
 * lines. Every claim below is therefore about declared spacing.
 * ═══════════════════════════════════════════════════════════════════════ */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** The declarations one utility class emits, keyed by CSS property. */
const cache = new Map<string, Map<string, string>>();

const unescapeSelector = (s: string) => s.replace(/\\(.)/g, "$1");

/**
 * The part of a compiled stylesheet that is unconditional.
 *
 * Tailwind emits screen variants after the plain utilities, so everything
 * from the first `@media` on only applies at or above a breakpoint.
 * Skipping that half is not a shortcut: a `sm:flex-row` cannot squeeze a
 * narrow window, and a `sm:` colour is not the one a row is painted with
 * on one.
 */
const unconditional = (css: string) => {
  const at = css.indexOf("@media");
  return at < 0 ? css : css.slice(0, at);
};

/** Index a compiled stylesheet by the class each rule styles. */
function indexRules(css: string): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  for (const m of unconditional(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // `.space-y-2 > :not([hidden]) ~ :not([hidden])` styles `.space-y-2`.
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
 * ~300ms Tailwind compile per class. The first version of
 * `classDeclaring` below did exactly that and compiled seventeen classes
 * before it found the one it wanted; two rows of it pushed a single test
 * past vitest's 5s default, and the resulting "Test timed out" would have
 * been indistinguishable from a real failure. One call, one compile.
 */
async function prewarm(root: HTMLElement): Promise<void> {
  const classes: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const c of el.classList) classes.push(c);
  }
  await emitted(classes);
}

/**
 * The first absolute length in a declaration, in CSS pixels.
 *
 * A `var()` or a percentage has no absolute length, and returning a
 * number for one of those would be the exact lie this whole block exists
 * to avoid — so it throws, and the caller has to say what it is actually
 * measuring.
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
 * `border-l-2` next to a `border-l-accent`, say — and the question is
 * which of them owns the property. `classMatching` answers "which class
 * matches this shape", which is the *width*; this answers "which class
 * says something about the colour", which is a different question.
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

/** Everything `root`'s classes declare, class-first, for a full sweep. */
async function sweep(root: HTMLElement): Promise<Map<string, Map<string, string>>> {
  const classes: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const c of el.classList) classes.push(c);
  }
  return emitted(classes);
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

const note: Note = {
  id: "note-1",
  title: "Release notes",
  body: "Provider setup",
  tags: "release",
  source_session_id: null,
  source_message_id: null,
  created_at: "now",
  updated_at: "now",
  pinned: false,
};

// list_notes answers with the note plus the memories it produced; the route
// unwraps the note out of that envelope.
const linked = (n: Note): NoteWithLinks => ({ note: n, linked_memories: [] });

describe("NotesRoute command contract", () => {
  beforeEach(() => {
    vi.spyOn(api, "listNotes").mockResolvedValue([]);
    vi.spyOn(api, "searchNotes").mockResolvedValue([note]);
  });

  it("uses the registered search_notes command for note search", async () => {
    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "release" } });
    await waitFor(() => expect(api.searchNotes).toHaveBeenCalledWith("release"));
  });

  it("preserves the draft when saving fails and supports tag filtering", async () => {
    vi.spyOn(api, "listNotes").mockResolvedValue([linked(note)]);
    vi.spyOn(api, "upsertNote").mockRejectedValue(new Error("disk full"));

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue("Provider setup")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Provider setup"), { target: { value: "Draft retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByDisplayValue("Draft retained")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter notes by tag" }), { target: { value: "missing" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows an explicit retryable load error", async () => {
    vi.spyOn(api, "listNotes").mockRejectedValue(new Error("notes offline"));
    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("notes offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("NotesRoute pinning and provenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "searchNotes").mockResolvedValue([]);
    vi.spyOn(api, "upsertNote").mockResolvedValue("note-1");
    vi.spyOn(api, "setNotePinned").mockResolvedValue(undefined);
    vi.spyOn(api, "unlinkMemoryFromNote").mockResolvedValue(undefined);
  });

  it("pins through set_note_pinned and shows the new state", async () => {
    let pinned = false;
    vi.spyOn(api, "listNotes").mockImplementation(async () => [
      { note: { ...note, pinned }, linked_memories: [] },
    ]);
    vi.spyOn(api, "setNotePinned").mockImplementation(async (_id, next) => { pinned = next; });

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    const pin = await screen.findByRole("button", { name: "Pin Release notes" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("title", expect.stringContaining("only when it is relevant"));

    fireEvent.click(pin);
    await waitFor(() => expect(api.setNotePinned).toHaveBeenCalledWith("note-1", true));
    // The row follows the result, not the click: state comes from the
    // re-read list, so a pin the backend refused cannot look set.
    expect(await screen.findByRole("button", { name: "Unpin Release notes" })).toHaveAttribute("aria-pressed", "true");

    // The editor's save must not carry the pin back; upsert_note ignores it
    // on update precisely so it cannot unpin what was set here. Asserted on
    // a save that happened — an assertion about a mock that was never
    // reached holds whether the save would have carried the pin or not.
    fireEvent.change(await screen.findByDisplayValue("Release notes"), {
      target: { value: "Release notes v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsertNote).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.upsertNote).mock.calls[0][0] as Record<string, unknown>;
    expect(saved).toMatchObject({ id: "note-1", title: "Release notes v2" });
    expect(saved).not.toHaveProperty("pinned");
  });

  it("lists the memories a note produced, marking the replaced one, and unlinks one", async () => {
    const links = [
      { id: "m-1", title: "Friday deploy window", content: "Ships land after 2pm on Fridays.", is_enabled: true, superseded_by: null },
      { id: "m-2", title: "Deploy window", content: "Ships land any time on Fridays.", is_enabled: true, superseded_by: "m-1" },
      { id: "m-3", title: "Release checklist", content: "Tag, changelog, announce.", is_enabled: false, superseded_by: null },
    ];
    vi.spyOn(api, "listNotes").mockResolvedValue([{ note, linked_memories: links }]);

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Produced 3 memories")).toBeInTheDocument();
    // Superseded rows are struck through and labelled, not hidden: the note
    // produced them and the correction history is the point.
    expect(screen.getByText("Deploy window")).toHaveClass("line-through");
    expect(screen.getByText("replaced")).toBeInTheDocument();
    expect(screen.getByText("Friday deploy window")).not.toHaveClass("line-through");
    expect(screen.getByText("disabled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unlink Release checklist from this note" }));
    await waitFor(() => expect(api.unlinkMemoryFromNote).toHaveBeenCalledWith("note-1", "m-3"));
  });

  it("claims nothing about provenance when the row came from search", async () => {
    vi.spyOn(api, "searchNotes").mockResolvedValue([note]);
    vi.spyOn(api, "listNotes").mockResolvedValue([]);

    render(
      <MemoryRouter>
        <NotesRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "release" } });
    expect(await screen.findByDisplayValue("Provider setup")).toBeInTheDocument();
    // search_notes returns plain notes, so links are unknown, not empty.
    expect(screen.queryByText(/^Produced/)).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The restyle's guards.
 *
 * Everything below is the *restyle* being held to the design's rules, and
 * every one of them is written to fail if the thing it guards is removed.
 * Four tasks in this plan shipped a guard that passed against code it was
 * not examining, so each suite here says what it walks, and each walk
 * either proves the subtree was there or throws.
 * ═══════════════════════════════════════════════════════════════════════ */

const memoryLink = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Memory ${id}`,
  content: "A durable fact this note produced.",
  is_enabled: true,
  superseded_by: null,
  ...over,
});

/**
 * Three notes, the first of which produced three memories — one plain, one
 * superseded, one disabled.
 *
 * All three states, deliberately. The first version of this fixture used
 * three plain memories, and the supersession chip it was supposed to be
 * exercising then *never rendered*: swapping the `Badge` back for a
 * hand-written `rounded-full` pill came back green, because the sweep below
 * was walking a list with no chip on it. A fixture that renders only the
 * happy path is how a guard ends up green against the thing it guards.
 */
const defaultLinks = [
  memoryLink("m-1"),
  memoryLink("m-2", { superseded_by: "m-1" }),
  memoryLink("m-3", { is_enabled: false }),
];

function serveLinked(notes: Note[], links = defaultLinks) {
  vi.spyOn(api, "listNotes").mockImplementation(async () =>
    notes.map((n) => ({ note: n, linked_memories: n.id === notes[0]?.id ? links : [] })),
  );
  vi.spyOn(api, "searchNotes").mockResolvedValue([]);
  vi.spyOn(api, "upsertNote").mockResolvedValue("note-1");
  vi.spyOn(api, "setNotePinned").mockResolvedValue(undefined);
  vi.spyOn(api, "unlinkMemoryFromNote").mockResolvedValue(undefined);
  vi.spyOn(api, "deleteNote").mockResolvedValue(undefined);
}

const secondNote: Note = { ...note, id: "note-2", title: "Roadmap", body: "What is next" };

const renderNotes = () =>
  render(
    <MemoryRouter>
      <NotesRoute />
    </MemoryRouter>,
  );

/**
 * The produced-memories list, reached through a control *inside* it rather
 * than by tag, so the helper cannot return a list that is not the one the
 * page renders. It is the page's only card list and the only list the
 * standard rhythm governs — see the file header in `NotesRoute.tsx`.
 */
async function cardList(container: HTMLElement): Promise<HTMLUListElement> {
  const unlink = await within(container).findAllByRole("button", { name: /^Unlink / });
  const item = unlink[0].closest("li");
  expect(item, "a produced-memory row must be an <li>").toBeTruthy();
  const list = item!.parentElement;
  expect(list?.tagName, "produced-memory rows must hang off one <ul>").toBe("UL");
  expect(unlink.length, "the list must really have three rows on it").toBe(3);
  return list as HTMLUListElement;
}

/**
 * A note's row in the navigation list, found by the row's own first line.
 *
 * Not by accessible name: the pin button in the editor's header is
 * *"Pin Release notes"*, so a name matcher for the row matches both and a
 * row is a `<button>` whose accessible name is its title, its body preview
 * and its tags run together. The title is the row's first child, so this is
 * a structural read, and a row that reorders puts its title second and
 * fails loudly rather than silently matching the wrong element.
 */
function noteRow(container: HTMLElement, title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const list = container.querySelector("aside ul");
    expect(list, "the note list must be a <ul>").toBeTruthy();
    const row = within(list as HTMLElement)
      .getAllByRole("button")
      .find((b) => b.textContent?.startsWith(title));
    expect(row, `a note row for "${title}"`).toBeTruthy();
    return row as HTMLElement;
  });
}

/** The rhythm the page actually ships, read out of its own classes. */
async function pageRhythm(container: HTMLElement): Promise<Rhythm> {
  const list = await cardList(container);
  const row = list.firstElementChild!;
  return {
    gap: await pxOn(list, /^space-y-/, "margin-top"),
    pad: await pxOn(row, /^p-/, "padding"),
  };
}

describe("NotesRoute density: the standard rhythm, measured", () => {
  beforeEach(() => serveLinked([note, secondNote]));

  it("spaces the produced-memory cards at the standard rhythm, and not the compact one", async () => {
    const { container } = renderNotes();
    const page = await pageRhythm(container);
    const standard = await standardRhythm();
    const compact = await compactRhythm();

    // Read out of the stylesheet the build produces, from the classes the
    // page rendered. `space-y-2` and `p-3` are the current spellings; the
    // assertion is about eight and twelve pixels, and any other spelling of
    // those numbers would pass without an edit.
    expect(page.gap).toBe(standard.gap);
    expect(page.pad).toBe(standard.pad);

    // The load-bearing half, and the reason equality is not a
    // free pass: a page that quietly adopted the compact rhythm reads
    // strictly less than this on both axes, and must fail here.
    expect(page.gap).toBeGreaterThan(compact.gap);
    expect(page.pad).toBeGreaterThan(compact.pad);
    // …and a standard rhythm is a rhythm, not nothing.
    expect(page.gap).toBeGreaterThan(0);
  });

  it("tells the two rhythms apart, because a measurement that cannot is not one", async () => {
    const standard = await standardRhythm();
    const compact = await compactRhythm();
    // The two really are different, so the comparison above is not
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
 * shadow on a list row is a regression against that, not a finishing
 * touch. The only `box-shadow` in this design belongs to things that
 * genuinely float — a modal, a dropdown, a tooltip — and the only one of
 * those that can be open on this page is the delete confirmation, which
 * is one of them.
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

describe("NotesRoute stays flat", () => {
  beforeEach(() => serveLinked([note, secondNote]));

  it("puts no shadow and no filter on any resting surface", async () => {
    const { container } = renderNotes();
    // Awaited, and this is not tidiness. `render()` returns before the
    // library resolves, so a walk taken immediately sees a pane with
    // "Loading notes…" on it — no cards, no fields, nothing. The first
    // version of Memory's equivalent test did exactly that and passed
    // against a row with `shadow-panel` on it. `cardList` is the control:
    // it will not return until a card is really in the DOM.
    await cardList(container);
    expect(paintForcing(container, ["box-shadow", "filter"])).toEqual([]);
  });

  it("lets the one floating surface on this page float, and no other", async () => {
    // The delete confirmation is a `Modal` behind a `ConfirmDialog`, and a
    // modal overlaps the page — a shadow is the only thing separating an
    // overlay from a card in the flow. Asserted so that a later
    // "flatten everything" commit argues with a test rather than with taste.
    serveLinked([note, secondNote]);
    const { container } = renderNotes();
    await cardList(container);
    expect(paintForcing(container, ["box-shadow"])).toEqual([]);

    cleanup();
    const open = renderNotes();
    await cardList(open.container);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    expect(paintForcing(open.container, ["box-shadow"]).length).toBeGreaterThan(0);
  });

  it("scopes every focus ring to a state, so no row paints a shadow at rest", async () => {
    const { container } = renderNotes();
    await cardList(container);
    // `ring-2` is a `box-shadow` under the hood, so the check above walks
    // straight past it — which is the only reason this one exists. A
    // *bare* `ring-2` would put a shadow on every row at rest and the
    // shadow check would still call the page clean.
    //
    // `focus:` and `focus-visible:` both satisfy it. Which one a control
    // takes is a judgement, and the two are picked rather than defaulted:
    // the two search fields and the three inline text fields take
    // `focus:`, because a field should show where the caret is however it
    // got there; the note rows and the row buttons take `focus-visible:`,
    // because clicking one acts immediately and there is nothing left to
    // disambiguate.
    const rings = declarationsIn(container).classes.filter((c) => c.split(":").pop()!.startsWith("ring-"));
    expect(rings.length, "the page has focus rings to scope").toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring, `a ring outside a state paints at rest: ${ring}`).toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
    }
    // The two choices above, asserted where they are made rather than left
    // to whatever the primitive happens to do.
    const search = screen.getByRole("textbox", { name: "Search notes" });
    expect(classMatching(search, /ring-/)).toMatch(/^focus:ring-/);
    const unlink = within(await cardList(container)).getAllByRole("button", { name: /^Unlink / })[0];
    expect(classMatching(unlink, /ring-/)).toMatch(/^focus-visible:ring-/);
    // The control: the bare class, which is the thing being banned.
    expect("ring-2").not.toMatch(/^(focus|focus-visible|active|hover|group-hover|peer-focus\S*):ring-/);
  });

  it("animates nothing inside either list", async () => {
    const { container } = renderNotes();
    const list = await cardList(container);
    // Scoped to the two lists rather than the page, and the scope is the
    // argument: every control on this page is a primitive that owns its own
    // `transition-colors`, and that is not this guard's business. What it
    // bans is a transition on a *row* — the subtree that scales with the
    // user's library, which is the same reason the streaming subtree is
    // fenced.
    expect(paintForcing(list, ["transition"])).toEqual([]);
    const noteList = (await noteRow(container, "Release notes")).closest("li")!.parentElement!;
    expect(noteList.tagName).toBe("UL");
    expect(noteList.children.length, "both rows must be on the list being walked").toBe(2);
    expect(paintForcing(noteList, ["transition"])).toEqual([]);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // The negative control, so none of the three checks above can pass by
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
    // And the scopes really do differ: a page-wide sweep would have caught
    // all six, a list-only sweep only the transition one.
    expect(paintForcing(host, ["transition"])).toHaveLength(2);
  });

  it("carries no literal colour in any class or inline style it renders", async () => {
    const { container } = renderNotes();
    // Same reason as the shadow walk above: the cards arrive a frame after
    // `render()`, and the card is where the colours are.
    await cardList(container);
    const { classes, styles } = declarationsIn(container);
    expect(classes.length, "the sweep saw a page with classes on it").toBeGreaterThan(0);
    for (const c of classes) expect(c, `class "${c}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);
    for (const s of styles) expect(s, `inline style "${s}" hardcodes a colour`).not.toMatch(COLOUR_LITERAL);

    // And the source, so a class that only renders behind a dialog or on an
    // empty library is covered too.
    const src = source("src/routes/NotesRoute.tsx");
    expect(src, "NotesRoute.tsx must not hardcode a colour").not.toMatch(COLOUR_LITERAL);
  });

  it("finds a literal colour when one is planted", () => {
    // The control. `COLOUR_LITERAL` is a regex on a class string, and a
    // regex that matches nothing is indistinguishable from a regex that
    // cannot match.
    //
    // Every literal below is *assembled*, never written out. `MemoryRoute`'s
    // equivalent control writes three of them inline, and `tailwind.config.ts`
    // globs this test tree — so each one shipped as a dead production rule
    // with a literal colour in the built stylesheet. Assembling them costs
    // three lines and emits nothing.
    const planted = (...parts: string[]) => parts.join("");
    expect(planted("bg-[", "#", "ff0000", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("shadow-[rgb", "(1,2,3)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("text-[hsl", "(210,50%,40%)", "]")).toMatch(COLOUR_LITERAL);
    expect(planted("border-[oklch", "(0.7_0.1_200)", "]")).toMatch(COLOUR_LITERAL);
    // …and the tokens this page is supposed to be using are not literals.
    for (const token of ["bg-surface-1", "text-text-muted", "border-border", "bg-accent/10", "text-group-header"]) {
      expect(token).not.toMatch(COLOUR_LITERAL);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The shared vocabulary, and the behaviour the restyle had to keep.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("NotesRoute in the shared vocabulary", () => {
  beforeEach(() => serveLinked([note, secondNote]));

  it("gives every box a theme radius, so a theme that reshapes the app reshapes the cards", async () => {
    const { container } = renderNotes();
    const list = await cardList(container);
    // The controls: the tag chip is in the *note* list, and the two status
    // chips are on the first two produced-memories rows. Asserted here
    // rather than assumed, because a sweep of a list whose chips did not
    // render is a sweep of nothing, and a hand-written `rounded-full` pill
    // in place of the `Badge` is exactly the regression this is for.
    const chip = within(await noteRow(container, "Release notes")).getByText("release");
    expect(chip.className).toMatch(/rounded-/);
    const list_ = within(list);
    expect(list_.getByText("replaced")).toBeInTheDocument();
    expect(list_.getByText("disabled")).toBeInTheDocument();
    expect(list_.getAllByText("replaced")).toHaveLength(1);
    expect(list_.getAllByText("disabled")).toHaveLength(1);

    // Not `4px`, not `12px`: one of the four radius custom properties,
    // which is what makes the geometry theme-following. A hardcoded radius
    // here would be a card that ignores its own theme, and the same
    // failure the primitives were corrected for.
    //
    // Scoped by "draws a box on every side" — a bare `border` class, not
    // any `border-*`. Keying on the border rather than on a radius class is
    // what lets a card that *lost* its radius fail instead of quietly
    // dropping out of the walk; keying on `border` rather than `border-b`
    // is what keeps the page's *rule*-carrying rows (which have no radius
    // and are not boxes) from being demanded one.
    await prewarm(container);
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

  it("marks the open note as the open one, by more than a grey", async () => {
    renderNotes();
    const open = await noteRow(document.body, "Release notes");
    const other = await noteRow(document.body, "Roadmap");
    await prewarm(document.body);

    // Both rows carry the same 2px left border, so opening a note does not
    // shift its text sideways; what differs is the colour. Resolved, not
    // spelled — a retune of the border width moves both and the equality
    // survives it, and the colour is read as the value the class resolves
    // to so "a different class" cannot stand in for "the accent".
    const openWidth = await pxOn(open, /^border-l-/, "border-left-width");
    const otherWidth = await pxOn(other, /^border-l-/, "border-left-width");
    expect(openWidth).toBe(otherWidth);
    expect(openWidth).toBeGreaterThan(0);
    const colourOf = async (el: Element) => {
      const cls = await classDeclaring(el, "border-left-color");
      return declValue((await emitted([cls])).get(cls)!, "border-left-color", cls);
    };
    expect(await colourOf(open)).toBe("var(--color-accent)");
    expect(await colourOf(other)).toBe("transparent");

    // …and the open one is tinted, so the selection is not a 2px line a
    // user has to be told to look for.
    expect(Array.from(open.classList)).toContain("bg-accent/10");
    expect(Array.from(other.classList)).not.toContain("bg-accent/10");
    // The selection is announced, not only drawn. A screen reader cannot
    // see a 2px accent rule, and this is the same one-of-a-many vocabulary
    // the Tasks filter uses for the same shape.
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(other).toHaveAttribute("aria-pressed", "false");

    // Switching notes moves the selection, and it is the *note* that
    // changes rather than a class left behind.
    fireEvent.click(other);
    await waitFor(async () => expect((await noteRow(document.body, "Roadmap")).getAttribute("aria-pressed")).toBe("true"));
    expect(await colourOf(await noteRow(document.body, "Release notes"))).toBe("transparent");
  });

  it("gives every control a reachable name that is not its placeholder", async () => {
    renderNotes();
    await cardList(document.body);
    // Three fields on this page carry a placeholder, and a placeholder is
    // not a name: it disappears the moment the field has a value, and a
    // screen reader announces nothing at all.
    expect(screen.getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter notes by tag" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note title" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note body" })).toBeInTheDocument();
    // And the pin is a labelled toggle, not an icon.
    const pin = screen.getByRole("button", { name: "Pin Release notes" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps every row control at or above the minimum target size", async () => {
    const { container } = renderNotes();
    const list = await cardList(container);
    await prewarm(container);
    const unlinks = within(list).getAllByRole("button", { name: /^Unlink / });
    for (const unlink of unlinks) {
      expect(await pxOn(unlink, /^w-/, "width")).toBeGreaterThanOrEqual(24);
      expect(await pxOn(unlink, /^h-/, "height")).toBeGreaterThanOrEqual(24);
      // The control refuses to shrink, so a long memory title gives way
      // rather than the button a user has to hit.
      expect(unlink.className, "the row control must not give up its box").toMatch(/shrink-0/);
    }
    const pin = screen.getByRole("button", { name: "Pin Release notes" });
    expect(await pxOn(pin, /^w-/, "width")).toBeGreaterThanOrEqual(24);
    expect(await pxOn(pin, /^h-/, "height")).toBeGreaterThanOrEqual(24);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The heading outline.
 *
 * A screen-reader user moves between headings by level, not by position, so
 * `h1` followed by `h3` is a defect rather than a nit. `RouteShell` owns
 * this page's `h1` and the list's own heading is an `h2` beside it, so the
 * empty state's title has to be an `h2` too — which is what
 * `EmptyState`'s `headingLevel` is for.
 *
 * Every state the page can be in is checked, because the note list and the
 * empty state and the delete dialog are separate subtrees and a fix applied
 * to one of them says nothing about the rest.
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

describe("NotesRoute heading outline", () => {
  beforeEach(() => serveLinked([note, secondNote]));

  it("skips no heading level in any state the page can be in", async () => {
    // 1 — a note open, with the card list under it. Where a user spends
    // their time, and the only state with more than the page's own
    // headings.
    const editor = renderNotes();
    await cardList(editor.container);
    expectNoHeadingSkip(editor.container, "the open note");

    // 2 — the empty state, which is the heading the primitive got wrong by
    // default. A different subtree from the one above.
    cleanup();
    serveLinked([]);
    const empty = renderNotes();
    await screen.findByText("No note open");
    expectNoHeadingSkip(empty.container, "an empty library with no note open");

    // 3 — the delete confirmation, the last heading-bearing subtree left.
    cleanup();
    serveLinked([note, secondNote]);
    const confirm = renderNotes();
    await cardList(confirm.container);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    expectNoHeadingSkip(confirm.container, "the delete confirmation");
  });

  it("catches a skipped level when one is planted", () => {
    // The control. An assertion that no state ever skipped a level is
    // equally consistent with a walk that found no headings, or one that
    // only ever saw the page's own h1.
    const skip = document.createElement("div");
    skip.innerHTML = "<h1>Notes</h1><h2>No note open</h2><h4>Nested</h4>";
    expect(() => expectNoHeadingSkip(skip, "planted skip")).toThrow(/h2 .* followed by h4/);
    expect(headingLevels(skip)).toHaveLength(3);

    // A clean outline passes, including a legal step down and a sibling at
    // the same level, so the assertion is not "only one heading".
    const clean = document.createElement("div");
    clean.innerHTML = "<h1>Notes</h1><h2>No note open</h2><h2>Produced 2 memories</h2><h3>Nested</h3>";
    expect(() => expectNoHeadingSkip(clean, "planted clean outline")).not.toThrow();
    expect(headingLevels(clean)).toHaveLength(4);

    // And a page that opens on something other than its own h1 fails,
    // which is the other half of "the outline starts at the top".
    const noTitle = document.createElement("div");
    noTitle.innerHTML = "<h2>Orphan</h2>";
    expect(() => expectNoHeadingSkip(noTitle, "planted orphan")).toThrow(/must open with the page's own h1/);
  });

  /**
   * The label that is not a heading.
   *
   * The aside's nav label read "Notes" — the page's own title, word for
   * word — as an `h2`. `SettingsRoute` had the identical defect in its
   * nav label and the identical treatment waiting for it, and the two
   * routes carried the *same* `text-group-header uppercase tracking-wider`
   * classes while only one of them had been converted. So the two
   * spellings are the evidence, and the rule is stated once here: a
   * label above a list is a group header, and a heading is for a
   * section of the page.
   *
   * The outline walk above cannot catch this on its own — `h1` followed
   * by `h2` skips nothing — which is exactly why the guard had to be
   * written rather than assumed. `expectNoHeadingSkip` is the wrong tool
   * for "a heading that should not be a heading", and using it as if it
   * were is the mistake this test exists to prevent.
   */
  it("keeps the aside label a group header rather than a second copy of the title", async () => {
    const { container } = renderNotes();
    await cardList(container);

    // The page's own title, and the thing no other heading may repeat.
    const h1 = screen.getByRole("heading", { level: 1, name: "Notes" });
    expect(h1).toBeInTheDocument();

    // The nav label exists and says what it always said — reached inside
    // the aside by its text, so this fails if the label is deleted rather
    // than silently passing on a page with no label at all. Scoped to the
    // aside because the page's own `h1` says "Notes" too, and matching
    // the first "Notes" on the page would find the title.
    const aside = within(container).getByRole("complementary");
    const label = within(aside).getByText("Notes");
    expect(label.tagName, "the nav label must not be a heading").toBe("DIV");
    // …and it is the group-header treatment, the same one the sidebar's
    // and the editor's own group headers take.
    expect(label.className).toMatch(/\btext-group-header\b/);
    expect(label.className).toMatch(/\buppercase\b/);
    expect(label.className).toMatch(/\btracking-wider\b/);
    expect(label.className).toMatch(/\btext-\[10px\]/);

    // The claim, stated over the whole page rather than over one node: no
    // heading below the `h1` repeats the page's own title.
    for (const heading of headingLevels(container).filter((h) => h.level > 1)) {
      expect(
        heading.text,
        `h${heading.level} "${heading.text}" repeats the page's own title word for word`,
      ).not.toBe(h1.textContent);
    }
    // …and the loop above is walking a list rather than a one-element
    // array that happens to pass. The editor's own group header is the
    // second heading-shaped thing on the page: it is spelled the same way,
    // it is correctly not a heading either, and it is found by its own
    // text rather than by a class — so this cannot pass on a page where
    // it was missing.
    // Matched on the element's *own* text nodes, not on its whole
    // `textContent` — otherwise every ancestor of the header matches too
    // and the lookup is ambiguous. The count is taken from the fixture's
    // own link list rather than typed, so a fixture that grew or lost a
    // link cannot silently turn this into a walk over nothing.
    const ownText = (d: Element) =>
      Array.from(d.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
    const expected = `Produced ${defaultLinks.length} memories`;
    const produced = Array.from(container.querySelectorAll("div")).filter((d) => ownText(d) === expected);
    expect(produced, `the page must really carry its second group header ("${expected}")`).toHaveLength(1);
    expect(produced[0].tagName, "and it must not be a heading either").toBe("DIV");
    expect(produced[0].className).toMatch(/\btext-group-header\b/);
    expect(screen.queryByRole("heading", { name: /produced/i })).not.toBeInTheDocument();
  });

  it("spells the group header the way SettingsRoute spells it, because the two were one rule", () => {
    // The evidence that this is one rule and not two: both routes carry
    // the same classes for their nav label, and only Settings had been
    // converted to the `div`. Read from the sources, because a guard that
    // compared the two *rendered* pages could not tell a shared constant
    // from two copies that happen to agree today.
    const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
    // The match stops at the label's own text rather than past it: a `/`
    // inside a regex literal closes the literal, and reading one source
    // and not the other would be a test that quietly compares nothing.
    const notesLabel = read("src/routes/NotesRoute.tsx")
      .match(/<div className="(text-\[10px\] uppercase tracking-wider text-group-header font-semibold)">Notes/);
    const sectionsLabel = read("src/routes/SettingsRoute.tsx")
      .match(/<div className="(text-\[10px\] uppercase tracking-wider text-group-header font-semibold px-2 py-2)">Sections/);
    expect(notesLabel, "NotesRoute must carry the group-header treatment").toBeTruthy();
    expect(sectionsLabel, "SettingsRoute must carry the group-header treatment").toBeTruthy();
    // One spelling: the Settings one adds only its own padding, which is
    // the label's box and not its type treatment.
    const type = "text-[10px] uppercase tracking-wider text-group-header font-semibold";
    expect(notesLabel![1]).toBe(type);
    expect(sectionsLabel![1]).toBe(`${type} px-2 py-2`);
  });

  it("gives the empty state a heading that is a heading, at the level it asked for", async () => {
    serveLinked([]);
    renderNotes();
    // A `div` with a heading's typography is the failure mode this guards,
    // and it passes every visual check on the page. Asserting the tag as
    // well as the level is what distinguishes "a heading at the right
    // level" from "a paragraph that looks like one".
    const heading = await screen.findByRole("heading", { name: "No note open" });
    expect(heading.tagName).toBe("H2");
    // Exactly the shell's h1 and this one. It used to read `[1, 2, 2]`,
    // because the aside's nav label was an `h2` repeating the page's own
    // title word for word — the same defect `SettingsRoute`'s "Sections"
    // label had already been fixed for. That label is a group header now,
    // so there is one h1 and one h2, and the empty state's title is a
    // *sibling* of nothing rather than a second level-two heading
    // masquerading as a peer of the nav.
    expect(headingLevels(document.body).map((h) => h.level)).toEqual([1, 2]);
    // …and it is the primitive's own heading, carrying the primitive's
    // treatment, rather than a second implementation drawn over the top of
    // it.
    expect(heading.className).toBe("text-sm font-medium text-text");
  });
});

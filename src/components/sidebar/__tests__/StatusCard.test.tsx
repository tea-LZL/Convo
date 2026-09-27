/**
 * The memory status card, and the four ways it can be wrong.
 *
 * A user with no embedding model gets keyword-only recall. Nothing else
 * in the app says so: the Memory page has plenty to show, the settings
 * page has a form, and the failure is silent. This card is the whole
 * reason Task 3's status region exists, so these tests are about the
 * card *reporting honestly* rather than about how it looks.
 *
 * Three states, pinned from the plan's Decisions table and from what
 * `knowledge_index_status` in `src-tauri/src/commands/knowledge.rs`
 * actually computes:
 *
 *   | condition                                    | chip             |
 *   |----------------------------------------------|------------------|
 *   | model set, no reindex needed, nothing to do  | success / `live` |
 *   | model set, reindex needed                    | warn / `needs reindex` |
 *   | no model                                     | subtle / `off`   |
 *
 * The order matters and is Rust's, not this component's. Rust sets
 * `needs_reindex` only when a model *is* configured, and `semantic_note`
 * is a three-way match in the same order: no model, then reindex, then
 * rows outstanding. So "no model" is tested first here for the same
 * reason — it is the state that overrides the others.
 *
 * ── Why `semanticNote` is asserted twice ─────────────────────────────
 * The round-trip assertion (the exact string comes back out) is
 * necessary but not sufficient. It proves the component passes a string
 * *through*; it does not stop someone adding a TypeScript fallback for
 * the case where Rust supplies nothing — which is precisely how two
 * wordings of the same warning end up in the tree, disagreeing, forever.
 * So the second assertion reads the real `semantic_note` literals out of
 * `knowledge.rs` and proves none of them appears in the TypeScript. The
 * Rust file is the single source; the card may quote it and may not
 * restate it.
 *
 * ── A limit, stated rather than papered over ─────────────────────────
 * jsdom loads no stylesheet (`css: false`) and does no layout, so
 * "truncates rather than overflows" is asserted as the Tailwind
 * truncation contract — `truncate` on the text node, `min-w-0` on the
 * flex ancestors between it and the card, `w-full` on the card — not as
 * a measured pixel width. A 240px column is asserted on the sidebar
 * itself, in `Sidebar.test.tsx`. Whether the result is one line or two
 * lines is a render question, and the class set is what makes it one.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, KnowledgeIndexStatus } from "../../../lib/api";
import {
  STATUS_TEXT,
  STATUS_TONES,
  StatusCard,
  StatusDot,
  type StatusText,
  type StatusTone,
} from "../StatusCard";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const CARD_NAME = "Memory index";

/** Rust's own numbers, so a fixture cannot quietly disagree with them. */
const live: KnowledgeIndexStatus = {
  memoryCount: 30,
  noteCount: 12,
  embeddedCount: 42,
  needsEmbedding: 0,
  needsReindex: false,
  embeddingModel: "nomic-embed-text",
  semanticNote: null,
};
const stale: KnowledgeIndexStatus = {
  ...live,
  needsReindex: true,
  semanticNote:
    "The embedding model changed, so existing vectors are not comparable. They will be rebuilt on the next index pass.",
};
const unconfigured: KnowledgeIndexStatus = {
  ...live,
  memoryCount: 30,
  noteCount: 12,
  embeddedCount: 0,
  needsEmbedding: 0,
  embeddingModel: null,
  semanticNote:
    "No embedding model configured. Recall is keyword-only, so it will miss memories that share no words with the question.",
};

async function renderCard(status: KnowledgeIndexStatus | Error) {
  if (status instanceof Error) {
    vi.spyOn(api, "knowledgeIndexStatus").mockRejectedValue(status);
  } else {
    vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(status);
  }
  render(<StatusCard />);
  // Flush the mount effect's state update inside act, so the assertions
  // below measure a settled tree rather than racing it.
  await act(async () => {});
  if (status instanceof Error) {
    // Confirm the failure actually landed, so "renders nothing" is
    // measured after the rejection and not before it.
    expect(api.knowledgeIndexStatus).toHaveBeenCalled();
  }
  return status;
}

const card = () => screen.queryByRole("region", { name: CARD_NAME });

/**
 * The colour token a rendered element is painted from, read off the class
 * list. `text-text-subtle` and `bg-text-subtle` are the same token, so a
 * chip and a dot that report the same token are the same state even though
 * they use different properties.
 */
const tokenOf = (el: Element) =>
  el.className.match(/(?:^|\s)(?:bg|text)-(success|warn|text-subtle)\b/)?.[1];

/**
 * The four payloads. Each row carries both vocabularies, because they are
 * different things and conflating them is how a check ends up comparing
 * `subtle` against `text-subtle` and failing for no reason:
 *
 *   - `tone`  is the tone *name* from `STATUS_TONES` — the vocabulary.
 *   - `token` is the theme colour it *renders* as — `subtle` paints
 *     `text-subtle`, and that indirection is the whole of Ruling 2.
 *
 * Asserted as one table rather than four separate lookups, because a
 * fourth payload silently inheriting a neighbour's expectation is exactly
 * what a per-state test cannot see.
 */
const MATRIX: {
  name: string;
  status: KnowledgeIndexStatus;
  tone: StatusTone;
  token: string;
  text: StatusText;
}[] = [
  { name: "live", status: live, tone: "success", token: "success", text: "live" },
  {
    name: "indexing",
    status: { ...live, embeddedCount: 12, needsEmbedding: 30, semanticNote: "30 row(s) are not embedded yet. Semantic recall will improve as they fill in." },
    tone: "subtle",
    token: "text-subtle",
    text: "indexing",
  },
  { name: "needs reindex", status: stale, tone: "warn", token: "warn", text: "reindex" },
  { name: "off", status: unconfigured, tone: "subtle", token: "text-subtle", text: "off" },
];

describe("StatusCard states", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(MATRIX)("reads `$name` on the $token token", async ({ status, token, text }) => {
    const label = STATUS_TEXT[text];
    await renderCard(status);
    await screen.findByRole("region", { name: CARD_NAME });
    const el = screen.getByText(label);
    // The label is looked up rather than typed, so a renamed key fails
    // here instead of silently comparing a key against rendered prose.
    expect(el.textContent).toBe(label);
    expect(tokenOf(el), `${label} must be painted from ${token}`).toBe(token);
  });

  it("never uses a fourth tone, because none is available", async () => {
    // Three tones, four labels. `off` and `indexing` are both "not
    // all-clear" and are therefore the same colour — which is only
    // honest because the label is the semantic channel. If a fourth tone
    // ever appears here it means a new token was added, and the whole
    // reason this file decouples tone from text goes with it.
    //
    // All three directions are checked, because a rendered-set comparison
    // alone only catches one of them: a fourth tone that is *used* shows
    // up in the rendered tokens; one that is added and left dangling
    // shows up as a member no payload can reach; and one that reaches a
    // render at all must be one of the three existing theme colours.
    const names = new Set(MATRIX.map((row) => row.tone));
    const tokens = new Set(MATRIX.map((row) => row.token));

    expect([...tokens].sort(), "no colour outside the three existing tokens").toEqual([
      "success", "text-subtle", "warn",
    ]);
    expect(names.size, "every tone must be reachable from a real payload").toBe(STATUS_TONES.length);
    for (const tone of STATUS_TONES) {
      expect(names, `${tone} must be reachable from some payload`).toContain(tone);
    }
    expect(MATRIX.length, "four payloads, four labels").toBe(4);
    expect(new Set(MATRIX.map((r) => r.text)).size, "every label is distinct").toBe(4);
  });

  it("separates `off` from `indexing` by text alone, since they share a tone", async () => {
    const off = MATRIX.find((r) => r.text === "off")!;
    const indexing = MATRIX.find((r) => r.text === "indexing")!;
    expect(off.tone, "both are 'not all-clear'").toBe(indexing.tone);
    expect(off.token, "and they render the same colour").toBe(indexing.token);
    expect(off.text).not.toBe(indexing.text);

    // And in a real render, not just in the table.
    await renderCard(off.status);
    expect(await screen.findByText("off")).toBeInTheDocument();
    expect(screen.queryByText("indexing")).not.toBeInTheDocument();
  });

  it("calls a half-filled index `indexing`, never `live` and never `off`", async () => {
    // `live` is a false all-clear — rows are still missing. `off` is a
    // misreport — semantic recall *is* working, just incompletely, and
    // calling it off would tell the user to go configure a model they
    // already have.
    await renderCard(MATRIX[1].status);
    expect(await screen.findByText("indexing")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("off")).not.toBeInTheDocument();
    // And the model is still named, because there is one.
    expect(screen.getByText("nomic-embed-text")).toBeInTheDocument();
  });

  it("prefers `off` over `needs reindex` when a payload claims both", async () => {
    // Rust cannot produce this: `needs_reindex` is computed inside the
    // `Some(route)` arm of the same match that yields the model, and the
    // `None` arm is `(0, false)`. So the two checks in `memoryStatus`
    // are observationally equivalent on every payload the backend can
    // send, and reordering them would not change a single real verdict —
    // which is exactly why the order needs asserting rather than trusting.
    //
    // The claim is the conservative one: with no model, semantic recall
    // is off, full stop, and a stale-index flag cannot make it anything
    // else.
    await renderCard({ ...live, embeddingModel: null, needsReindex: true, semanticNote: null });
    expect(await screen.findByText("off")).toBeInTheDocument();
    expect(screen.queryByText("needs reindex")).not.toBeInTheDocument();
  });

  it("does not claim `live` on a full store that still owes embeddings", async () => {
    // Retargeted by fix round 1's Ruling 2, and strengthened rather than
    // relaxed: the premise is unchanged — a half-filled store must not
    // read as an all-clear — and it now also pins the positive label, so
    // a regression to `off` (a misreport: the user's model is configured
    // and recall is working, just incompletely) is caught too.
    await renderCard({
      ...live,
      embeddedCount: 12,
      needsEmbedding: 30,
      semanticNote: "30 row(s) are not embedded yet. Semantic recall will improve as they fill in.",
    });
    await screen.findByRole("region", { name: CARD_NAME });
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("off")).not.toBeInTheDocument();
    expect(screen.getByText("indexing")).toBeInTheDocument();
  });

  it("reports two absolute numbers, and never a ratio", async () => {
    await renderCard({ ...live, embeddedCount: 18, needsEmbedding: 4 });
    await screen.findByRole("region", { name: CARD_NAME });
    expect(screen.getByText("18 embedded · 4 awaiting")).toBeInTheDocument();
  });

  it("does not divide one count by the other, because they are not two halves of a fraction", async () => {
    // The regression this pins: `embedded_count` is `COUNT(*)` over
    // `memory_embeddings`, `needs_embedding` counts only rows passing
    // `rows_needing_embedding`'s WHERE clause, and `memory_count +
    // note_count` is an unfiltered `COUNT(*)` over both tables. A ratio
    // over any two of those has a denominator holding rows that will
    // never be embedded, so a fully healthy store rendered `live` beside
    // a permanent `18 / 42 indexed`. Asserted as *absence* of any
    // fraction-shaped string, so it cannot come back as `18/42` either.
    await renderCard({ ...live, memoryCount: 30, noteCount: 12, embeddedCount: 18, needsEmbedding: 0 });
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    const text = cardEl.textContent ?? "";

    expect(text).toContain("18 embedded");
    expect(text).toContain("0 awaiting");
    // No `/`, no `%`, and neither total-count field is used at all.
    expect(text, "a card must not render a fraction").not.toMatch(/[/%]/);
    expect(text).not.toContain("42");
    expect(text).not.toContain("30");
    // And the raw counts are still available from the fetch — they are
    // just not what the card claims about the index.
    expect(live.memoryCount + live.noteCount).toBe(42);
  });
});

describe("semanticNote is Rust's wording, not a second one", () => {
  it("round-trips the exact string, so a reworded copy fails", async () => {
    // Deliberately awkward: an em dash, a colon, a parenthetical, a
    // trailing period. Normalising whitespace, collapsing a dash, or
    // "tidying" the capitalisation all break this.
    const note =
      "The embedding model changed — so existing vectors are not comparable (yet): they rebuild on the next index pass.";
    await renderCard({ ...stale, semanticNote: note });
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    expect(within(cardEl).getByText(note)).toBeInTheDocument();
    expect(cardEl.textContent).toContain(note);
  });

  it("carries the unconfigured-model warning verbatim too", async () => {
    await renderCard(unconfigured);
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    expect(cardEl.textContent).toContain(unconfigured.semanticNote!);
  });

  it("holds no second wording: no semantic_note literal appears in the TypeScript", () => {
    // Read the literals out of Rust rather than pasting them here, so
    // this cannot go stale.
    //
    // A `\` at end of line in Rust swallows the newline *and* the
    // following indentation, so `"…miss \` + newline + spaces +
    // `memories…"` is one string with a single space at the join. The
    // trailing whitespace before the backslash has to be consumed too,
    // or the join emits a second space, the extracted literal stops
    // matching anything, and this guard passes on a component that
    // contains the message verbatim — which is the exact blindness a
    // source-scanning guard cannot afford.
    const source = read("src-tauri/src/commands/knowledge.rs");
    const block = source
      .slice(
        source.indexOf("let semantic_note = match"),
        source.indexOf("Ok(KnowledgeIndexStatus {"),
      )
      .replace(/[ \t]*\\\s*\n\s*/g, " ");
    const literals = [...block.matchAll(/"([^"]*)"/g)]
      .map((m) => m[1].trim())
      .filter((s) => s.length > 24 && s.includes(" "));
    expect(literals.length, "knowledge.rs must still declare its own messages").toBeGreaterThanOrEqual(3);
    // The join has to be faithful or every assertion below is vacuous.
    for (const literal of literals) {
      expect(literal, "a Rust line continuation must join with one space").not.toMatch(/\s{2,}/);
      expect(literal, "a joined message must be a single line").not.toContain("\n");
    }

    const tsx = read("src/components/sidebar/StatusCard.tsx");
    for (const literal of literals) {
      expect(tsx, `StatusCard must not restate Rust's message: ${literal.slice(0, 40)}…`)
        .not.toContain(literal);
      // And not a distinctive clause of it either — a paraphrase is the
      // failure mode, not an exact copy. Five words is the floor: short
      // fragments like "not embedded yet" are shared vocabulary.
      const clause = literal.split(/[.,:—]/).map((s) => s.trim()).filter((s) => s.split(" ").length >= 5);
      expect(clause.length, "each message must have a clause long enough to be distinctive").toBeGreaterThan(0);
      for (const part of clause) {
        expect(tsx, `StatusCard must not paraphrase Rust's message: ${part}`)
          .not.toContain(part);
      }
    }
  });

  it("renders no note of its own when Rust supplies none", async () => {
    await renderCard(live);
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    // A `live` card with no note is a card with no paragraph. The
    // temptation is to add reassurance text here; that is a fourth
    // wording, invented in a language that is not the source of truth.
    expect(cardEl.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("a 240px column truncates rather than overflowing", () => {
  const longModel = "a-really-long-user-entered-embedding-model-name-that-keeps-going-and-going";

  it("clips the model name instead of pushing the content pane", async () => {
    await renderCard({ ...live, embeddingModel: longModel });
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    const model = within(cardEl).getByText(longModel);

    expect(model, "an untruncated model name widens the sidebar").toHaveClass("truncate");
    // `truncate` only clips inside a shrinkable flex/grid ancestor. Walk
    // up to the card and require `min-w-0` at every step that could
    // otherwise inherit `min-width: auto` and refuse to shrink.
    let node = model.parentElement;
    while (node && node !== cardEl) {
      expect(node.className, `every ancestor up to the card must allow shrinking: ${node.className}`)
        .toMatch(/min-w-0\b/);
      node = node.parentElement;
    }
    expect(node, "the model name must be inside the card").toBe(cardEl);
    // And the card itself is a block that takes the column, not adds to it.
    expect(cardEl.className).toMatch(/\bw-full\b/);
    expect(cardEl.className).not.toMatch(/(?<!-)\bw-(?!full\b)\d/);
  });

  it("clips the note too, since it is the longest string on the card", async () => {
    const longNote = `${longModel} ${longModel}`;
    await renderCard({ ...stale, semanticNote: longNote });
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    expect(within(cardEl).getByText(longNote)).toHaveClass("truncate");
  });
});

describe("a failed fetch renders nothing at all", () => {
  it("does not throw and does not leave a card behind", async () => {
    await expect(renderCard(new Error("knowledge_index_status failed"))).resolves.toBeTruthy();
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("off")).not.toBeInTheDocument();
  });

  it("shows no error, no spinner and no empty shell once it has failed", async () => {
    await renderCard(new Error("boom"));
    // The card is absent, so it cannot be showing anything. Asserted on
    // the body rather than the card, because the card does not exist.
    expect(document.body.textContent).not.toMatch(/live|reindex|index/i);
  });

  it("survives a backend that resolves with something other than a promise", async () => {
    // The Tauri boundary is untyped at runtime. A caller that gets
    // `undefined` back must not take the sidebar down with it.
    vi.spyOn(api, "knowledgeIndexStatus").mockReturnValue(undefined as never);
    render(<StatusCard />);
    await waitFor(() => expect(api.knowledgeIndexStatus).toHaveBeenCalled());
    expect(card()).not.toBeInTheDocument();
  });

  it("does not let a failure poison a later mount", async () => {
    // What this covers, precisely: a *new* mount after a failure fetches
    // again and reports. The `useRef` is per-instance, so a fresh card
    // starts with a fresh ref and cannot inherit the old request.
    //
    // What it does NOT cover, and no test here can: the same instance
    // re-running its effect after a failure. The effect has `[]` deps, so
    // that cannot happen today, and `pending.current = null` in the catch
    // is what would make it correct if the deps ever changed. That line is
    // therefore unverified — see the report. Asserted here because the
    // reachable half is worth pinning, and because a test titled after the
    // unreachable half would be a guard that cannot fail.
    vi.spyOn(api, "knowledgeIndexStatus").mockRejectedValueOnce(new Error("down"));
    const first = render(<StatusCard />);
    await act(async () => {});
    expect(card()).not.toBeInTheDocument();
    first.unmount();

    vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(live);
    render(<StatusCard />);
    await act(async () => {});
    expect(card(), "a later mount must fetch afresh and still report").toBeInTheDocument();
  });
});

/**
 * React 18 runs a mount effect twice, and `src/main.tsx:10` renders the
 * app inside `React.StrictMode` — so this is the shipping app's mount
 * sequence, not a test artefact. Without an in-flight guard it is two
 * `knowledge_index_status` round-trips per sidebar mount in production.
 *
 * Asserted here rather than at the sidebar because the guard belongs to
 * the hook: `Sidebar.test.tsx` renders without StrictMode and so cannot
 * see it at all.
 */
describe("StrictMode does not double the index query", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fetches once for the card, and once for the dot", async () => {
    for (const node of [<StatusCard key="card" />, <StatusDot key="dot" />]) {
      vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(live);
      const view = render(<StrictMode>{node}</StrictMode>);
      await act(async () => {});
      expect(api.knowledgeIndexStatus, "one query per mount, not two").toHaveBeenCalledTimes(1);
      // The negative control: the component rendered, so the count of 1
      // is a dedupe rather than a component that never fetched.
      expect(view.container).not.toBeEmptyDOMElement();
      view.unmount();
    }
  });

  it("does not double the failed-fetch log either", async () => {
    vi.spyOn(api, "knowledgeIndexStatus").mockRejectedValue(new Error("down"));
    render(<StrictMode><StatusCard /></StrictMode>);
    await act(async () => {});
    expect(api.knowledgeIndexStatus).toHaveBeenCalledTimes(1);
  });
});

describe("the card is readable", () => {
  it("has no accessibility violations", async () => {
    await renderCard(stale);
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    expect((await axe(cardEl)).violations).toHaveLength(0);
  });

  it("hardcodes no colour", async () => {
    await renderCard(stale);
    const cardEl = await screen.findByRole("region", { name: CARD_NAME });
    for (const el of [cardEl, ...Array.from(cardEl.querySelectorAll("*"))]) {
      expect(el.getAttribute("class") ?? "").not.toMatch(
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i,
      );
    }
  });
});

/**
 * The 64px rail's status dot.
 *
 * A 6px dot is the smallest thing that carries state in 64px, but a dot
 * on its own is colour-only — and a user who cannot separate the three
 * tones learns nothing from it. So the label is load-bearing, not
 * decoration, and these tests treat it that way: the dot must be
 * *findable by name*, and its name must carry the same words the card
 * would have shown.
 *
 * The dot and the card derive from one function, so the interesting
 * assertion is not "the dot is red when degraded" but "the dot and the
 * card cannot disagree" — which is checked by rendering both from the
 * same payload and comparing the token each resolved.
 */
describe("StatusDot, the rail's memory status", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function renderDot(status: KnowledgeIndexStatus) {
    vi.spyOn(api, "knowledgeIndexStatus").mockResolvedValue(status);
    render(<StatusDot />);
    await act(async () => {});
    return screen.getByRole("img");
  }

  it("is a 6px dot, so it needs no room the rail does not have", async () => {
    const dot = await renderDot(stale);
    const paint = dot.querySelector("[aria-hidden]")!;
    expect(paint).toHaveClass("w-1.5", "h-1.5", "rounded-full");
    // The rail's own width is asserted in Sidebar.test.tsx; what matters
    // here is that nothing about the dot asks for more than 6px.
    expect(paint.className).not.toMatch(/(?<![\w-])w-(?!1\.5\b)\d/);
  });

  it("paints from the same token the chip would, for every payload", async () => {
    for (const row of MATRIX) {
      const dot = await renderDot(row.status);
      const paint = dot.querySelector("[aria-hidden]")!;
      expect(tokenOf(paint), `dot tone for ${row.text}`).toBe(row.token);
      dot.remove();
    }
  });

  it("carries the card's own words in its accessible name", async () => {
    for (const row of MATRIX) {
      const dot = await renderDot(row.status);
      const name = dot.getAttribute("aria-label") ?? "";
      expect(name, `the name must carry "${STATUS_TEXT[row.text]}"`).toContain(STATUS_TEXT[row.text]);
      // "Memory index" is the subject; without it the name is a bare
      // state word with nothing attached.
      expect(name).toContain("Memory index");
      dot.remove();
    }
  });

  it("shows the same words on hover, through the rail's own Tooltip", async () => {
    const dot = await renderDot(stale);
    fireEvent.mouseEnter(dot.parentElement!);
    const tip = screen.getByText(`Memory index: ${STATUS_TEXT.reindex}`);
    expect(tip).toBeInTheDocument();
    // Tooltip content and the accessible name are the same string, by
    // construction — the label is computed once and used twice.
    expect(tip.textContent).toBe(dot.getAttribute("aria-label"));
  });

  it("reports no state at all when the fetch fails, and does not throw", async () => {
    vi.spyOn(api, "knowledgeIndexStatus").mockRejectedValue(new Error("down"));
    render(<StatusDot />);
    await act(async () => {});
    expect(api.knowledgeIndexStatus).toHaveBeenCalled();
    // No dot, no dot at the wrong colour, no empty rail — the same
    // degradation contract the card keeps.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("is a labelled indicator, not a control that does nothing", async () => {
    const dot = await renderDot(stale);
    // `role="img"` with a name, deliberately rather than a button: there
    // is nothing to activate. A button here would advertise an action
    // ("re-index now?") that does not exist, and would be the first thing
    // a later commit reaches for to make the dot "keyboard reachable" —
    // at which point it is a dead control, not an improvement.
    expect(dot.tagName).toBe("SPAN");
    expect(dot).toHaveAttribute("role", "img");
    expect(dot).not.toHaveAttribute("tabindex");
    // Nothing in the subtree is focusable, so the rail adds no tab stop.
    expect(dot.querySelector("[tabindex]")).toBeNull();
    expect(dot.querySelector("button")).toBeNull();
  });

  it("has no accessibility violations, and is not colour-only", async () => {
    const dot = await renderDot(stale);
    expect((await axe(dot)).violations).toHaveLength(0);
    // The negative control for the whole point of the label: a name
    // exists, so the state is available without perceiving colour.
    expect(dot).toHaveAccessibleName();
  });

  it("hardcodes no colour", async () => {
    const dot = await renderDot(stale);
    for (const el of [dot, ...Array.from(dot.querySelectorAll("*"))]) {
      expect(el.getAttribute("class") ?? "").not.toMatch(
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i,
      );
    }
  });
});

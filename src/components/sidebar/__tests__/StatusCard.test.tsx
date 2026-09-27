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
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, KnowledgeIndexStatus } from "../../../lib/api";
import { StatusCard } from "../StatusCard";

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

describe("StatusCard states", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reads `live` when a model is set, the index is current, and nothing is outstanding", async () => {
    await renderCard(live);
    expect((await screen.findByRole("region", { name: CARD_NAME }))).toBeInTheDocument();
    expect(await screen.findByText("live")).toHaveClass("text-success");
    expect(screen.getByText("nomic-embed-text")).toBeInTheDocument();
  });

  it("reads `needs reindex` when the model changed, ahead of anything outstanding", async () => {
    await renderCard(stale);
    expect(await screen.findByText("needs reindex")).toHaveClass("text-warn");
    // The reindex state wins even though nothing is outstanding — a
    // stale index with a full vector store is still stale.
    expect(stale.needsEmbedding).toBe(0);
  });

  it("reads `off` when no model is configured, and says why", async () => {
    await renderCard(unconfigured);
    expect(await screen.findByText("off")).toHaveClass("text-text-subtle");
  });

  it("prefers `off` over `needs reindex` when a payload claims both", async () => {
    // Rust cannot produce this: `needs_reindex` is computed inside the
    // `Some(route)` arm of the same match that yields the model, and the
    // `None` arm is `(0, false)`. So the two checks in `chipFor` are
    // observationally equivalent on every payload the backend can send,
    // and reordering them would not change a single real verdict — which
    // is exactly why the order needs asserting rather than trusting.
    //
    // The claim is the conservative one: with no model, semantic recall
    // is off, full stop, and a stale-index flag cannot make it anything
    // else.
    await renderCard({ ...live, embeddingModel: null, needsReindex: true, semanticNote: null });
    expect(await screen.findByText("off")).toBeInTheDocument();
    expect(screen.queryByText("needs reindex")).not.toBeInTheDocument();
  });

  it("does not claim `live` on a full store that still owes embeddings", async () => {
    // needsEmbedding > 0 with needsReindex false is neither of the two
    // named states, and `live` would be a false all-clear. Rust has a
    // third message for it; the card must not invent a fourth verdict.
    await renderCard({
      ...live,
      embeddedCount: 12,
      needsEmbedding: 30,
      semanticNote: "30 row(s) are not embedded yet. Semantic recall will improve as they fill in.",
    });
    await screen.findByRole("region", { name: CARD_NAME });
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  it("reports embedded rows against memory plus notes, from Rust's own fields", async () => {
    await renderCard({ ...live, memoryCount: 8, noteCount: 4, embeddedCount: 5 });
    await screen.findByRole("region", { name: CARD_NAME });
    expect(screen.getByText("5 / 12 indexed")).toBeInTheDocument();
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

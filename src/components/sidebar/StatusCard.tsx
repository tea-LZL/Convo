/**
 * The memory status: what the index is doing, and whether recall is
 * actually working.
 *
 * This exists because the failure it reports is silent. A user with no
 * embedding model gets keyword-only recall — it still returns results,
 * they are just the wrong ones, and nothing in the app says so. Rust
 * already knows (`knowledge_index_status` computes all of it); nothing
 * was showing it.
 *
 * ── Tone and text are two channels, on purpose ───────────────────────
 * Four payloads, three visual tones, four labels. The decoupling is not
 * tidiness — it is that the fourth payload has no colour of its own:
 *
 *   | payload                                    | tone     | text            |
 *   |--------------------------------------------|----------|-----------------|
 *   | model set, nothing outstanding             | success  | `live`          |
 *   | model set, rows still outstanding          | subtle   | `indexing`      |
 *   | model set, index stale                     | warn     | `needs reindex` |
 *   | no model                                   | subtle   | `off`           |
 *
 * `indexing` is live and still filling. Calling it `live` is a false
 * all-clear; calling it `off` is a misreport, because recall is working
 * — just not completely. A fourth *token* is not available either: the
 * three tones are the ones the plan named, and inventing a fourth colour
 * is a shared-vocabulary decision this task does not own. So the extra
 * state is carried by the label and the tone is reused, which is why the
 * text is the semantic channel: `off` and `indexing` look the same
 * because they are both "not all-clear", and only the words separate
 * them.
 *
 * ── `semanticNote` is quoted, never restated ──────────────────────────
 * Rust's `semantic_note` is the user-facing wording, and it is rendered
 * verbatim. This file deliberately contains no copy of it: a second
 * wording in TypeScript is how the two drift apart, and this project has
 * already shipped two messages that meant the same thing. If Rust has
 * nothing to say, this card says nothing either, rather than improvising
 * reassurance that Rust did not write.
 *
 * ── Degradation ──────────────────────────────────────────────────────
 * A failed fetch renders nothing. A status card must never be the reason
 * a sidebar fails to render, so there is no error state, no placeholder
 * and no retry affordance here — the Memory page owns that conversation.
 * `StatusDot` inherits that: no status, no dot.
 *
 * ── Two absolute numbers, and no ratio anywhere ───────────────────────
 * The line reads `N embedded · M awaiting`. It was briefly a coverage
 * ratio, and that was wrong in a way worth writing down, because the
 * numbers it used are not the two halves of one fraction:
 *
 *   - `embedded_count` is `COUNT(*)` over `memory_embeddings`.
 *   - `needs_embedding` comes from `rows_needing_embedding`, which counts
 *     only rows passing `is_enabled = 1 AND superseded_by IS NULL AND
 *     LENGTH(content) >= 32` — and for notes, `pinned = 1` (see
 *     `src-tauri/src/memory/embed.rs:124`).
 *   - `memory_count + note_count` is a raw `COUNT(*)` over both tables,
 *     with none of those filters.
 *
 * So a perfectly healthy store — every *embeddable* row vectorised — put
 * unpinned notes, one-line memories, disabled rows and superseded rows in
 * the denominator, none of which will ever be embedded. The card would
 * read `live` beside a permanent `18 / 42 indexed`, which is a card whose
 * stated job is honest reporting, disagreeing with itself in the two
 * halves of the same line.
 *
 * The reviewer's alternative denominator, `embedded_count +
 * needs_embedding`, is no cleaner: `rows_needing_embedding` also returns
 * rows whose embedding is under a *different* model or dimension, while
 * `embedded_count` counts embeddings in *any* model. The two populations
 * overlap, so their sum is not a denominator either.
 *
 * Two absolute numbers are unambiguous under every population definition,
 * which is the only property a status card actually needs. The chip tone
 * already carries the health; the numbers only have to be true.
 *
 * **Follow-up, not done here:** a real coverage ratio needs a denominator
 * Rust computes over the *embeddable* population — one field on
 * `KnowledgeIndexStatus`, counting the rows `rows_needing_embedding`'s
 * `WHERE` clause selects, ignoring the model/dim predicate. This plan
 * touches no Rust, so the ratio cannot be built correctly from what the
 * frontend is given, and a wrong one is worse than none.
 */
import { useEffect, useRef, useState } from "react";
import { api, KnowledgeIndexStatus } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";
import { Tooltip } from "../ui/Form";

/**
 * The three visual tones, named for the *colour role* rather than for
 * the state they usually mean — because one tone serves two states, and a
 * tone named `off` would then be a lie in the `indexing` case.
 *
 * A runtime array rather than a bare union, so the type and the
 * vocabulary cannot drift apart: a fourth tone added to the union but not
 * to this list is a type error, and a fourth entry added here is visible
 * to a test that walks it. Three is a ceiling the plan set, and a ceiling
 * that cannot be checked is not a ceiling.
 */
export const STATUS_TONES = ["success", "warn", "subtle"] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/**
 * The chip's three treatments.
 * `text-subtle` is not a Badge variant, and reaching for `Badge`'s
 * `default` and overriding its foreground through `className` would make
 * the result depend on which of two same-specificity colour rules
 * Tailwind happens to emit later. So the geometry is stated once and the
 * foreground is chosen per tone: a composition that cannot reorder.
 */
const CHIP_BASE =
  "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0";

const CHIP_TONE: Record<StatusTone, string> = {
  success: "bg-success/15 text-success border-success/30",
  warn: "bg-warn/15 text-warn border-warn/30",
  subtle: "bg-surface-3 text-text-subtle border-border",
};

/**
 * The rail dot's three treatments, keyed on the same three tones. A 6px
 * dot has no room for a border and a tint, so it takes the token solid
 * rather than the chip's translucent fill — the *token* is shared, which
 * is what "the same state token" has to mean for a shape this size.
 */
const DOT_TONE: Record<StatusTone, string> = {
  success: "bg-success",
  warn: "bg-warn",
  subtle: "bg-text-subtle",
};

/**
 * What the chip and the dot say, for each of the four payloads. The keys
 * are the semantic labels; the values are the only strings either surface
 * ever renders, so the two cannot drift.
 */
export const STATUS_TEXT = {
  live: "live",
  indexing: "indexing",
  reindex: "needs reindex",
  off: "off",
} as const;

export type StatusText = keyof typeof STATUS_TEXT;

interface MemoryStatus {
  status: KnowledgeIndexStatus;
  tone: StatusTone;
  text: StatusText;
}

/**
 * Rust's own decision procedure, in the same order
 * `knowledge_index_status` uses when it builds `semantic_note`: no model
 * first, then a stale index, then a live one. Matching the order here is
 * what keeps the chip and the note from disagreeing about the same fetch.
 */
function memoryStatus(status: KnowledgeIndexStatus): MemoryStatus {
  if (!status.embeddingModel) return { status, tone: "subtle", text: "off" };
  if (status.needsReindex) return { status, tone: "warn", text: "reindex" };
  if (status.needsEmbedding === 0) return { status, tone: "success", text: "live" };
  // Rows still outstanding with a current model. The tone reuses
  // `subtle` because a fourth colour is not this task's to add; the text
  // is what separates it from `off`.
  return { status, tone: "subtle", text: "indexing" };
}

/**
 * Fetch the index status once on mount. Shared by the card and the rail
 * dot — which are in mutually exclusive branches of the sidebar, so
 * exactly one of them is ever mounted and this is one query either way.
 * `null` until it answers, and `null` again if it fails.
 *
 * The in-flight guard is not belt-and-braces: the app renders inside
 * `React.StrictMode` (`src/main.tsx:10`), and React 18 runs a mount
 * effect twice. Without the guard that is two `knowledge_index_status`
 * round-trips on every sidebar mount, in the shipping app, not only in a
 * test. The second run re-uses the first run's promise.
 *
 * **What the guard must not do is skip the second run's state update.**
 * The first version returned early from the effect when a request was
 * already in flight, which deduplicated the *fetch* and with it the only
 * closure that would call `setStatus` — the first run's cleanup had
 * already marked itself dead. The card then rendered nothing, forever,
 * in the one environment it actually ships in. The guard is therefore on
 * the request, not on the effect body: every run attaches to the shared
 * promise and every run applies the result.
 *
 * What the guard does *not* cover is two *different* components of this
 * module mounted at once — a `useRef` is per-instance, so `StatusCard`
 * and `StatusDot` side by side would each fetch. That case does not exist
 * today because of the mutual exclusion above, and a test pins it; a
 * module-level flag would cover it and is worse, because shared mutable
 * state outlives an error and leaks between tests.
 */
function useMemoryIndexStatus(): KnowledgeIndexStatus | null {
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);
  const pending = useRef<Promise<KnowledgeIndexStatus | null> | null>(null);

  useEffect(() => {
    let live = true;
    if (!pending.current) {
      pending.current = (async () => {
        try {
          // `await` inside the try, not a `.then`: the Tauri boundary is
          // untyped at runtime, and a caller that resolves with something
          // that is not a promise must not take the sidebar down with it.
          return (await api.knowledgeIndexStatus()) ?? null;
        } catch (error) {
          recordLog({
            operation: "knowledge_index_status",
            status: "failed",
            route: "sidebar",
            errorClass: errorClass(error),
          });
          // A failure is deliberately not remembered by the ref. This is
          // unreachable today — the effect has `[]` deps, and a `useRef`
          // is per-instance, so no later mount can see this ref anyway —
          // and it is kept because it costs one line and makes the ref
          // correct rather than incidentally correct. No test pins it,
          // which is recorded in the report rather than glossed.
          pending.current = null;
          return null;
        }
      })();
    }
    // The stored promise never rejects, so this is always safe to chain.
    pending.current.then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return status;
}

/**
 * The card. `null` while the fetch is out and after it fails, which is
 * the whole degradation contract: no status, no card.
 */
export function StatusCard() {
  const status = useMemoryIndexStatus();
  if (!status) return null;

  const state = memoryStatus(status);
  const model = status.embeddingModel ?? "no model";
  const embedded = status.embeddedCount ?? 0;
  const awaiting = status.needsEmbedding ?? 0;
  const note = status.semanticNote;

  return (
    <section
      aria-label="Memory index"
      className="w-full min-w-0 shrink-0 border-t border-border bg-surface-1 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={`${CHIP_BASE} ${CHIP_TONE[state.tone]}`}>{STATUS_TEXT[state.text]}</span>
        {/* Two absolute numbers, never a ratio — see the file header. */}
        <span className="shrink-0 font-mono text-[10px] text-text-subtle tabular-nums">
          {`${embedded} embedded · ${awaiting} awaiting`}
        </span>
      </div>

      <div
        className="mt-1.5 min-w-0 truncate text-[11px] text-text-muted"
        title={model}
      >
        {model}
      </div>

      {/* Rust's sentence, unmodified. See the file header. */}
      {note && (
        <p className="mt-1 min-w-0 truncate text-[10px] leading-relaxed text-text-subtle" title={note}>
          {note}
        </p>
      )}
    </section>
  );
}

/**
 * The 64px rail's whole memory status: a 6px dot, the same state token
 * the chip uses, and the same words in a tooltip and in an accessible
 * name. A dot alone would be colour-only, which this project has already
 * committed not to ship, so the label is not optional decoration here —
 * it is the reason the dot is allowed to be a dot.
 *
 * `role="img"` with a name, rather than a button: it reports state, and
 * a control that does nothing is worse than a labelled indicator. The
 * tooltip is the app's own `Tooltip`, the same one every other rail row
 * uses, rather than a `title` — a native tooltip in a rail full of styled
 * ones is an inconsistency a user notices.
 */
export function StatusDot() {
  const status = useMemoryIndexStatus();
  if (!status) return null;

  const state = memoryStatus(status);
  const label = `Memory index: ${STATUS_TEXT[state.text]}`;

  return (
    <Tooltip content={label} side="right">
      <span role="img" aria-label={label} className="inline-flex">
        <span
          aria-hidden="true"
          className={`block w-1.5 h-1.5 rounded-full ${DOT_TONE[state.tone]}`}
        />
      </span>
    </Tooltip>
  );
}

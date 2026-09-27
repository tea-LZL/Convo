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
 */
import { useEffect, useState } from "react";
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

export interface MemoryStatus {
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
export function memoryStatus(status: KnowledgeIndexStatus): MemoryStatus {
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
 */
export function useMemoryIndexStatus(): KnowledgeIndexStatus | null {
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);

  useEffect(() => {
    let live = true;
    // `await` inside the try, not a `.then`: the Tauri boundary is
    // untyped at runtime, and a caller that resolves with something that
    // is not a promise must not take the sidebar down with it.
    (async () => {
      try {
        const next = await api.knowledgeIndexStatus();
        if (live) setStatus(next ?? null);
      } catch (error) {
        recordLog({
          operation: "knowledge_index_status",
          status: "failed",
          route: "sidebar",
          errorClass: errorClass(error),
        });
      }
    })();
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
  const total = (status.memoryCount ?? 0) + (status.noteCount ?? 0);
  const embedded = status.embeddedCount ?? 0;
  const note = status.semanticNote;

  return (
    <section
      aria-label="Memory index"
      className="w-full min-w-0 shrink-0 border-t border-border bg-surface-1 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={`${CHIP_BASE} ${CHIP_TONE[state.tone]}`}>{STATUS_TEXT[state.text]}</span>
        {/* The counts shrink before the model name does: they are the
            comparative read, the model name is the detail. */}
        <span className="shrink-0 font-mono text-[10px] text-text-subtle tabular-nums">
          {`${embedded} / ${total} indexed`}
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

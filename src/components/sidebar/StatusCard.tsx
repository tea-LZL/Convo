/**
 * The memory status card: what the index is doing, and whether recall is
 * actually working.
 *
 * This exists because the failure it reports is silent. A user with no
 * embedding model gets keyword-only recall — it still returns results,
 * they are just the wrong ones, and nothing in the app says so. Rust
 * already knows (`knowledge_index_status` computes all of it); nothing
 * was showing it.
 *
 * Three states, in Rust's order, because Rust's order is the order the
 * conditions actually take:
 *
 *   - no model configured  → `off`, and a chip in the subtle token
 *   - model changed        → `needs reindex`, in the warn token
 *   - otherwise            → `live` when nothing is outstanding
 *
 * `needs_embedding > 0` with a current model is deliberately *not* `live`:
 * a half-filled vector store is not an all-clear, and Rust has its own
 * message for it. The card does not invent a fourth verdict.
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
 */
import { useEffect, useState } from "react";
import { api, KnowledgeIndexStatus } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";

/**
 * The chip's three treatments, named for the plan's Decisions table.
 * `text-subtle` is not a Badge variant, and reaching for `Badge`'s
 * `default` and overriding its foreground through `className` would make
 * the result depend on which of two same-specificity colour rules
 * Tailwind happens to emit later. So the geometry is stated once and the
 * foreground is chosen per state: a composition that cannot reorder.
 */
const CHIP_BASE =
  "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0";

type ChipTone = "live" | "reindex" | "off";

const CHIP_TONE: Record<ChipTone, string> = {
  live: "bg-success/15 text-success border-success/30",
  reindex: "bg-warn/15 text-warn border-warn/30",
  off: "bg-surface-3 text-text-subtle border-border",
};

const CHIP_TEXT: Record<ChipTone, string> = {
  live: "live",
  reindex: "needs reindex",
  off: "off",
};

type Chip = { tone: ChipTone; label: string };

/**
 * Rust's own decision procedure, in the same order `knowledge_index_status`
 * uses when it builds `semantic_note`: no model first, then a stale
 * index, then a live one. Matching the order here is what keeps the chip
 * and the note from disagreeing about the same fetch.
 */
function chipFor(status: KnowledgeIndexStatus): Chip {
  if (!status.embeddingModel) return { tone: "off", label: CHIP_TEXT.off };
  if (status.needsReindex) return { tone: "reindex", label: CHIP_TEXT.reindex };
  if (status.needsEmbedding === 0) return { tone: "live", label: CHIP_TEXT.live };
  // Rows still outstanding with a current model: Rust explains it, the
  // chip does not claim a state Rust did not report.
  return { tone: "off", label: CHIP_TEXT.off };
}

export function StatusCard() {
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

  if (!status) return null;

  const chip = chipFor(status);
  const model = status.embeddingModel ?? "no model";
  const total = (status.memoryCount ?? 0) + (status.noteCount ?? 0);
  const embedded = status.embeddedCount ?? 0;

  return (
    <section
      aria-label="Memory index"
      className="w-full min-w-0 shrink-0 border-t border-border bg-surface-1 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={`${CHIP_BASE} ${CHIP_TONE[chip.tone]}`}>{chip.label}</span>
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
      {status.semanticNote && (
        <p className="mt-1 min-w-0 truncate text-[10px] leading-relaxed text-text-subtle" title={status.semanticNote}>
          {status.semanticNote}
        </p>
      )}
    </section>
  );
}

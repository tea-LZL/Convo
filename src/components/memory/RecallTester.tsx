import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Clipboard, Search, TriangleAlert } from "lucide-react";
import type { MemoryItem } from "../../lib/api";
import { diagnoseMemoryRecall } from "../../lib/memoryRecall";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { Spinner, TextInput } from "../ui/Form";

export interface RecallTesterProps {
  open: boolean;
  onClose: () => void;
  items: MemoryItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function RecallTester({
  open,
  onClose,
  items,
  loading = false,
  error = null,
  onRetry,
}: RecallTesterProps) {
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const diagnostics = useMemo(() => diagnoseMemoryRecall(query, items), [query, items]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCopyState("idle");
    }
  }, [open]);

  useEffect(() => {
    setCopyState("idle");
  }, [diagnostics.preview]);

  const copyPreview = async () => {
    if (!diagnostics.preview) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(diagnostics.preview);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Test recall"
      description="Run the local memory ranker without contacting a provider."
      size="lg"
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="recall-query" className="text-xs text-text-muted block mb-1">
            Recall query
          </label>
          <TextInput
            id="recall-query"
            value={query}
            onChange={setQuery}
            placeholder="For example: what is my name?"
            aria-describedby="recall-query-help"
          />
          <p id="recall-query-help" className="text-[11px] text-text-subtle mt-1">
            This shows the same enabled memories and ranking evidence that the chat recall path uses.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-text-muted" role="status" aria-live="polite">
            <Spinner size={16} />
            Loading memory items…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3" role="alert">
            <TriangleAlert size={16} className="text-error shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text">Could not load memory items.</p>
              <p className="text-xs text-text-muted mt-1">{error}</p>
              {onRetry && (
                <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
                  Retry
                </Button>
              )}
            </div>
          </div>
        ) : !query.trim() ? (
          <div role="status" aria-live="polite">
            <EmptyState
              icon={<Search size={28} />}
              title="Enter a query"
              description="Try a question such as “what is my name?” to see which memories would be recalled."
            />
          </div>
        ) : diagnostics.recalled.length === 0 ? (
          <div role="status" aria-live="polite">
            <EmptyState
              icon={<Brain size={28} />}
              title="No memories would be recalled"
              description={diagnostics.noMatchReason ?? "No enabled memories match this query."}
            />
          </div>
        ) : (
          <div className="space-y-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Would be recalled ({diagnostics.recalled.length})
              </h3>
              {diagnostics.usedFallback && (
                <span className="text-[10px] text-warn">Identity fallback</span>
              )}
            </div>
            <ul aria-label="Memories that would be recalled" className="space-y-2">
              {diagnostics.recalled.map((detail) => (
                <li
                  key={detail.item.id}
                  className="bg-surface-1 border border-border rounded-lg p-3"
                  data-testid={`recall-result-${detail.item.id}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-medium text-text">
                        {detail.item.title || "Untitled memory"}
                      </h4>
                      <p className="text-xs text-text-muted mt-1 whitespace-pre-wrap">
                        {detail.item.content}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border bg-success/15 text-success border-success/30">
                      <Check size={10} aria-hidden="true" />
                      Would be recalled
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-text-muted">
                    <span>Score: {detail.score}</span>
                    <span>Matched terms: {detail.matchedTerms.length > 0 ? detail.matchedTerms.join(", ") : "None"}</span>
                    <span>Matched fields: {detail.matchedFields.length > 0 ? detail.matchedFields.join(", ") : "None"}</span>
                    <span className="sm:col-span-2">Reason: {detail.reason}</span>
                  </div>
                </li>
              ))}
            </ul>

            <section aria-labelledby="recall-preview-title" className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div>
                  <h3 id="recall-preview-title" className="text-xs font-semibold text-text">
                    Short relevant-facts block
                  </h3>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    Exact provider-facing recall block; no provider call was made.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  icon={copyState === "copied" ? <Check size={11} /> : <Clipboard size={11} />}
                  onClick={() => void copyPreview()}
                  disabled={!diagnostics.preview}
                  aria-label="Copy recall block"
                >
                  {copyState === "copied" ? "Copied" : "Copy"}
                </Button>
              </div>
              <textarea
                aria-label="Recall block preview"
                readOnly
                value={diagnostics.preview}
                rows={Math.min(12, Math.max(5, diagnostics.preview.split("\n").length))}
                className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-[11px] leading-relaxed text-text font-mono resize-y focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
              />
              {copyState === "error" && (
                <p className="text-[11px] text-error mt-1" role="status">
                  Clipboard is unavailable. Select the preview text to copy it manually.
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
}

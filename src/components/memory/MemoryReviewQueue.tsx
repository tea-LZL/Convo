import { useState } from "react";
import { Bell, MessageSquare, Save } from "lucide-react";
import type { ExtractedFact, MemoryItem, MemoryReview } from "../../lib/api";
import { Badge, Spinner } from "../ui/Form";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { MemoryEditorFields, type MemoryEditorDraft } from "./MemoryEditor";
import { KIND_COLOR, KIND_LABEL, type MemoryKind } from "./MemoryLibrary";

const REVIEW_STATUS_ORDER: Record<MemoryReview["status"], number> = {
  pending: 0,
  failed: 1,
  extracting: 2,
  reviewed: 3,
};

export function normalizeMemoryContent(content: string) {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isExactMemoryDuplicate(
  fact: Pick<ExtractedFact, "kind" | "content">,
  persistedItems: MemoryItem[],
) {
  const normalizedContent = normalizeMemoryContent(fact.content);
  return persistedItems.some(
    (item) => item.kind === fact.kind && normalizeMemoryContent(item.content) === normalizedContent,
  );
}

function memoryCandidateKey(candidate: Pick<ExtractedFact, "kind" | "content">) {
  return `${candidate.kind}${String.fromCharCode(0)}${normalizeMemoryContent(candidate.content)}`;
}

export function duplicateCandidateIndexes(
  candidates: Array<Pick<ExtractedFact, "kind" | "content">>,
  persistedItems: MemoryItem[],
  persistedItemsReady: boolean,
) {
  const persistedKeys = persistedItemsReady
    ? new Set(persistedItems.map((item) => memoryCandidateKey(item)))
    : new Set<string>();
  const seenCandidateKeys = new Set<string>();
  const duplicateIndexes = new Set<number>();
  candidates.forEach((candidate, index) => {
    const key = memoryCandidateKey(candidate);
    if (persistedKeys.has(key) || seenCandidateKeys.has(key)) duplicateIndexes.add(index);
    seenCandidateKeys.add(key);
  });
  return duplicateIndexes;
}

export type MemoryReviewAction = "saving" | "discarding";

function isMemoryKind(kind: string): kind is MemoryKind {
  return kind === "user_pref" || kind === "project_fact" || kind === "skill";
}

function reviewLabel(review: MemoryReview) {
  if (review.status === "pending") return `Pending (${review.facts.length})`;
  if (review.status === "failed") return "Failed · Retry";
  if (review.status === "extracting") return "Extracting · Retry";
  return "Reviewed";
}

function reviewCandidates(review: MemoryReview, drafts: Record<string, ExtractedFact[]>) {
  return drafts[review.id] ?? review.facts;
}

export interface MemoryReviewQueueProps {
  reviews: MemoryReview[];
  persistedItems: MemoryItem[];
  persistedItemsReady: boolean;
  persistedItemsError: string | null;
  reviewAction: MemoryReviewAction | null;
  activeReviewId: string | null;
  selected: Set<number>;
  drafts: Record<string, ExtractedFact[]>;
  retryingReviewIds: Set<string>;
  onOpenReview: (review: MemoryReview, selectedIndexes: number[]) => void;
  onRetry: (id: string) => void;
  onToggleSelection: (index: number, selected: boolean) => void;
  onSelectAll: (indexes: number[]) => void;
  onCloseReview: () => void;
  onRetryPersistedItems: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onOpenSourceChat: () => void;
  onCandidateChange: (index: number, patch: Partial<ExtractedFact>) => void;
}

export function MemoryReviewQueue({
  reviews,
  persistedItems,
  persistedItemsReady,
  persistedItemsError,
  reviewAction,
  activeReviewId,
  selected,
  drafts,
  retryingReviewIds,
  onOpenReview,
  onRetry,
  onToggleSelection,
  onSelectAll,
  onCloseReview,
  onRetryPersistedItems,
  onDiscard,
  onSave,
  onOpenSourceChat,
  onCandidateChange,
}: MemoryReviewQueueProps) {
  const [showHistory, setShowHistory] = useState(false);
  const activeReview = activeReviewId
    ? reviews.find((review) => review.id === activeReviewId) ?? null
    : null;
  const candidates = activeReview ? reviewCandidates(activeReview, drafts) : [];
  const duplicateIndexes = duplicateCandidateIndexes(
    candidates,
    persistedItems,
    persistedItemsReady,
  );
  const orderedReviews = [...reviews].sort(
    (a, b) => REVIEW_STATUS_ORDER[a.status] - REVIEW_STATUS_ORDER[b.status],
  );
  const visibleReviews = showHistory
    ? orderedReviews
    : orderedReviews.filter((review) => review.status !== "reviewed");
  const reviewedCount = reviews.filter((review) => review.status === "reviewed").length;

  const selectedCount = Array.from(selected).filter((index) => !duplicateIndexes.has(index)).length;

  const selectAll = () => {
    onSelectAll(candidates
      .map((_, index) => index)
      .filter((index) => !duplicateIndexes.has(index)));
  };

  if (reviews.length === 0) return null;

  return (
    <section aria-label="Memory review queue" className="border-b border-border bg-accent/5 px-4 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Bell size={12} className="text-accent shrink-0" aria-hidden="true" />
        <h2 className="text-xs text-text">Memory extraction reviews</h2>
        <div className="flex-1" />
        {reviewedCount > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((current) => !current)}
          >
            {showHistory ? "Hide history" : "Show history"}
          </Button>
        )}
      </div>
      {visibleReviews.length > 0 && (
        <ul className="mt-2 flex items-center gap-2 flex-wrap" aria-label="Memory extraction review statuses">
          {visibleReviews.map((review) => {
            const canOpen = review.status === "pending";
            const candidatesForReview = reviewCandidates(review, drafts);
            const defaultDuplicateIndexes = duplicateCandidateIndexes(
              candidatesForReview,
              persistedItems,
              persistedItemsReady,
            );
            const defaultSelected = candidatesForReview
              .map((_, index) => index)
              .filter((index) => !defaultDuplicateIndexes.has(index));
            return (
              <li key={review.id} className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={review.status === "reviewed" || retryingReviewIds.has(review.id) || reviewAction !== null}
                  onClick={() => {
                    if (canOpen) {
                      onOpenReview(review, defaultSelected);
                    } else if (review.status === "failed" || review.status === "extracting") {
                      onRetry(review.id);
                    }
                  }}
                  title={`From session ${review.sessionId.slice(0, 8)}…`}
                >
                  {reviewLabel(review)}
                </Button>
                {review.status === "failed" && review.error && (
                  <span className="text-[10px] text-error max-w-40 truncate" title={review.error}>
                    {review.error}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {visibleReviews.length === 0 && showHistory && (
        <p className="mt-2 text-[11px] text-text-muted">No review history yet.</p>
      )}

      <Modal
        open={activeReview !== null}
        onClose={reviewAction ? () => undefined : onCloseReview}
        title="Review extracted facts"
        description={
          activeReview
            ? `Auto-extracted from chat ${activeReview.sessionId.slice(0, 8)} — edit and pick the facts that should become memory.`
            : ""
        }
        size="lg"
        footer={
          activeReview ? (
            <>
              <Button
                variant="ghost"
                onClick={onDiscard}
                loading={reviewAction === "discarding"}
                disabled={reviewAction !== null}
              >
                Discard all
              </Button>
              <Button variant="secondary" onClick={selectAll} disabled={!persistedItemsReady || reviewAction !== null}>
                Select all
              </Button>
              <Button
                variant="primary"
                onClick={onSave}
                loading={reviewAction === "saving"}
                disabled={selectedCount === 0 || !persistedItemsReady || reviewAction !== null}
                icon={<Save size={12} />}
              >
                Save {selectedCount}
              </Button>
              <Button
                variant="outline"
                onClick={onOpenSourceChat}
                disabled={reviewAction !== null}
                icon={<MessageSquare size={12} />}
              >
                Open source chat
              </Button>
            </>
          ) : null
        }
      >
        {activeReview && (
          <>
            {reviewAction && (
              <div className="mb-3 flex items-center gap-2 text-sm text-text-muted" role="status" aria-live="polite">
                <Spinner size={14} />
                {reviewAction === "saving" ? "Saving review…" : "Discarding review…"}
              </div>
            )}
            {!persistedItemsReady && (
              persistedItemsError ? (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3" role="alert">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text">Could not check saved memory for duplicates.</p>
                    <p className="text-xs text-text-muted mt-1">{persistedItemsError}</p>
                    <Button size="sm" variant="secondary" className="mt-3" onClick={onRetryPersistedItems}>
                      Retry
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mb-3 flex items-center gap-2 text-sm text-text-muted" role="status" aria-live="polite">
                  <Spinner size={14} />
                  Checking saved memory for duplicates…
                </div>
              )
            )}
            {candidates.length === 0 ? (
              <p className="text-sm text-text-muted py-4 text-center">No extracted facts were returned.</p>
            ) : (
              <ul className="space-y-2" aria-label="Extracted memory candidates">
                {candidates.map((candidate, index) => {
                  const isDuplicate = duplicateIndexes.has(index);
                  const isPersistedDuplicate = persistedItemsReady && isExactMemoryDuplicate(candidate, persistedItems);
                  const candidateKind = isMemoryKind(candidate.kind) ? candidate.kind : "project_fact";
                  const draft: MemoryEditorDraft = {
                    kind: candidateKind,
                    title: candidate.title ?? "",
                    content: candidate.content,
                    tags: candidate.tags ?? "",
                    is_enabled: true,
                  };
                  return (
                    <li
                      key={`${activeReview.id}-${index}`}
                      data-testid={`memory-review-candidate-${index}`}
                      className="bg-surface-1 border border-border rounded-md p-3"
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Select candidate ${index + 1}`}
                          checked={selected.has(index) && !isDuplicate}
                          disabled={!persistedItemsReady || isDuplicate || reviewAction !== null}
                          onChange={(event) => onToggleSelection(index, event.target.checked)}
                          className="accent-[var(--color-accent)] mt-1"
                        />
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`inline-block text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${KIND_COLOR[candidate.kind] || KIND_COLOR.skill}`}>
                              {KIND_LABEL[candidate.kind as keyof typeof KIND_LABEL] || candidate.kind}
                            </span>
                            {isDuplicate && (
                              <Badge variant="default">
                                {isPersistedDuplicate ? "Already saved" : "Duplicate candidate"}
                              </Badge>
                            )}
                          </div>
                          <MemoryEditorFields
                            draft={draft}
                            onChange={(patch) => onCandidateChange(index, {
                              ...(patch.kind === undefined ? {} : { kind: patch.kind }),
                              ...(patch.title === undefined ? {} : { title: patch.title }),
                              ...(patch.content === undefined ? {} : { content: patch.content }),
                              ...(patch.tags === undefined ? {} : { tags: patch.tags }),
                            })}
                            idPrefix={`memory-review-candidate-${index}`}
                            includeKind
                            labelPrefix={`candidate ${index + 1}`}
                            disabled={reviewAction !== null}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}

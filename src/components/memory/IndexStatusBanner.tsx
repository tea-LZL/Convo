import { useEffect, useState } from "react";
import { api, KnowledgeIndexStatus } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";

export function IndexStatusBanner({ refreshKey = 0 }: { refreshKey?: number }) {
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api.knowledgeIndexStatus();
        if (active && next) setStatus(next);
      } catch (error) {
        recordLog({
          operation: "knowledge_index_status",
          status: "failed",
          route: "/memory",
          errorClass: errorClass(error),
        });
        if (active) setStatus(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshKey]);

  if (!status) return null;

  const noModel = !status.embeddingModel;
  const needsReindex = Boolean(status.embeddingModel && status.needsReindex);
  const needsEmbedding = Boolean(
    status.embeddingModel && !status.needsReindex && status.needsEmbedding > 0,
  );
  const hasNote = Boolean(status.semanticNote);

  if (!noModel && !needsReindex && !needsEmbedding && !hasNote) {
    return null;
  }

  const stateLabel = noModel
    ? "Semantic recall off"
    : needsReindex
      ? "Needs reindex"
      : "Indexing";

  const toneClass =
    noModel || needsReindex
      ? "border-warn/30 bg-warn/10 text-warn"
      : "border-border bg-surface-2 text-text-subtle";

  return (
    <div
      role="status"
      aria-label="Semantic index status"
      className="mb-3 rounded-lg border border-border bg-surface-1 p-2.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${toneClass}`}
        >
          {stateLabel}
        </span>
        {status.embeddingModel && (
          <span className="font-mono text-[10px] text-text-subtle tabular-nums">
            {`${status.embeddedCount} embedded · ${status.needsEmbedding} awaiting`}
          </span>
        )}
      </div>
      {status.semanticNote && (
        <p className="mt-1.5 text-xs text-text-muted leading-relaxed break-words">
          {status.semanticNote}
        </p>
      )}
    </div>
  );
}

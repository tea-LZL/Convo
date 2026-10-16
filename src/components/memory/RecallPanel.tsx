import { useState } from "react";
import { api, RankedMemory } from "../../lib/api";
import { errorClass, recordLog } from "../../lib/logger";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Form";

type KindVariant = "accent" | "success" | "warn";
const KIND_VARIANT: Record<string, KindVariant> = {
  user_pref: "accent",
  project_fact: "success",
  skill: "warn",
};

const KIND_LABEL: Record<string, string> = {
  user_pref: "Preferences",
  project_fact: "Project facts",
  skill: "Skills",
};

export function RecallPanel() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RankedMemory[] | null>(null);
  const [busy, setBusy] = useState(false);

  const runRecall = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const results = await api.memoryRecall(trimmed);
      setHits(results ?? []);
    } catch (error) {
      recordLog({
        operation: "memory_recall",
        status: "failed",
        route: "/memory",
        errorClass: errorClass(error),
      });
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Test recall"
      className="mb-3 rounded-lg border border-border bg-surface-1 p-2.5"
    >
      <form onSubmit={(e) => void runRecall(e)} className="flex items-center gap-1.5 flex-wrap">
        <input
          aria-label="Test recall query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Test recall with a question…"
          className="flex-1 min-w-0 bg-surface-2 border border-border rounded-md px-2.5 py-1 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-text focus:ring-offset-2 focus:ring-offset-bg"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!query.trim() || busy}
        >
          Test recall
        </Button>
      </form>
      {hits !== null && (
        hits.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">Nothing matched that query.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {hits.map((hit) => (
              <div
                key={`${hit.ownerType}:${hit.ownerId}`}
                className="rounded-md border border-border bg-surface-2 p-2 text-xs"
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center rounded-sm border border-border bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-subtle">
                    {hit.ownerType}
                  </span>
                  <Badge variant={KIND_VARIANT[hit.kind] ?? "warn"}>
                    {KIND_LABEL[hit.kind] || hit.kind}
                  </Badge>
                  {hit.title && (
                    <span className="text-xs font-medium text-text min-w-0 truncate" title={hit.title}>
                      {hit.title}
                    </span>
                  )}
                  <div className="flex-1" />
                  <span className="font-mono text-[10px] text-text-subtle tabular-nums">
                    {hit.score.toFixed(3)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                  {hit.content}
                </div>
                <div className="mt-1 text-[11px] text-text-subtle break-words">
                  {hit.reason}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}

import { MemoryItem } from "../../lib/api";

interface SupersedeHistoryProps {
  items: MemoryItem[];
  item?: MemoryItem;
  onSelectReplacement?: (replacement: MemoryItem) => void;
}

const CHIP_BTN =
  "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm border border-border bg-surface-2 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

function reachTarget(
  replacement: MemoryItem | undefined,
  replacementId: string,
  onSelectReplacement?: (replacement: MemoryItem) => void,
) {
  if (replacement && onSelectReplacement) {
    onSelectReplacement(replacement);
    return;
  }
  const el = document.getElementById(`memory-${replacementId}`);
  el?.scrollIntoView?.({ block: "nearest" });
}

export function SupersedeHistory({
  items,
  item,
  onSelectReplacement,
}: SupersedeHistoryProps) {
  if (item) {
    if (!item.superseded_by) return null;
    const replacement = items.find((m) => m.id === item.superseded_by);
    const replacementLabel =
      replacement?.title || replacement?.content || item.superseded_by;
    return (
      <button
        type="button"
        onClick={() => reachTarget(replacement, item.superseded_by!, onSelectReplacement)}
        className={CHIP_BTN}
        title={`Replaced by ${replacementLabel}`}
      >
        {`Replaced by ${replacementLabel}`}
      </button>
    );
  }

  const superseded = items.filter((m) => Boolean(m.superseded_by));
  if (superseded.length === 0) return null;

  return (
    <section
      aria-label="Supersede history"
      className="rounded-lg border border-border bg-surface-1 p-2.5 space-y-1.5"
    >
      <div className="text-[10px] uppercase tracking-wider text-group-header font-semibold">
        Supersede history
      </div>
      <ul className="space-y-1">
        {superseded.map((oldItem) => {
          const replacement = items.find((m) => m.id === oldItem.superseded_by);
          const replacementLabel =
            replacement?.title || replacement?.content || oldItem.superseded_by!;
          return (
            <li
              key={oldItem.id}
              className="rounded-md border border-border bg-surface-2 p-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {oldItem.title && (
                  <span className="text-xs font-medium text-text-subtle line-through min-w-0 truncate">
                    {oldItem.title}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    reachTarget(replacement, oldItem.superseded_by!, onSelectReplacement)
                  }
                  className={CHIP_BTN}
                >
                  {`Replaced by ${replacementLabel}`}
                </button>
              </div>
              <div className="mt-1 text-xs text-text-muted line-through whitespace-pre-wrap break-words">
                {oldItem.content}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

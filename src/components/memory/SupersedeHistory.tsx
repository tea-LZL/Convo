import { MemoryItem } from "../../lib/api";

interface SupersedeHistoryProps {
  item: MemoryItem;
  items: MemoryItem[];
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
  item,
  items,
  onSelectReplacement,
}: SupersedeHistoryProps) {
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

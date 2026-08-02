import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { api, MemoryItem, Session } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Form";
import { toast } from "../../stores/toasts";
import { useMemoryStore } from "../../stores/memory";

interface SessionMemoryModalProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}

export function SessionMemoryModal({ open, onClose, sessionId }: SessionMemoryModalProps) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const setSessionOverrides = useMemoryStore((state) => state.setSessionOverrides);

  const toggleItem = async (id: string) => {
    const next = new Set(excludedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExcludedIds(next);
    // Persist: send the list of INCLUDED item IDs.  An empty list
    // clears all overrides (= all enabled items are included).
    const enabledIds = items
      .filter((i) => i.is_enabled)
      .map((i) => i.id);
    const included = enabledIds.filter((eid) => !next.has(eid));
    const payload = next.size > 0 ? included : [];
    try {
      await setSessionOverrides(sessionId, payload);
    } catch {
      // Rollback on failure
      setExcludedIds(excludedIds);
    }
  };

  const load = async () => {
    if (!open) return;
    setLoading(true);
    try {
      const [all, overrides] = await Promise.all([
        api.listMemory(),
        api.getSessionMemoryOverrides(sessionId),
      ]);
      setItems(all);
      // An item is "excluded" if it's enabled globally but NOT in the
      // session overrides list AND the overrides list is non-empty.
      // An empty overrides list means "all enabled items included."
      if (overrides.length > 0) {
        const overrideSet = new Set(overrides);
        const excluded = new Set(
          all
            .filter((i) => i.is_enabled && !overrideSet.has(i.id))
            .map((i) => i.id)
        );
        setExcludedIds(excluded);
      } else {
        setExcludedIds(new Set());
      }
    } catch (e) {
      console.error("SessionMemoryModal:", e);
      toast.error(String(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [open, sessionId]);

  const enabled = items.filter((i) => i.is_enabled);

  return (
    <Modal open={open} onClose={onClose} title="Memory for this session" size="md">
      <p className="text-xs text-text-muted mb-3">
        Checked items are included in the system prompt for this chat.
        Unchecked items are hidden from this session only.
      </p>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size={16} />
        </div>
      ) : enabled.length === 0 ? (
        <div className="text-sm text-text-muted text-center py-4">
          No memory items. Add some from the Memory page.
        </div>
      ) : (
        <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
          {enabled.map((item) => {
            const excluded = excludedIds.has(item.id);
            const kindLabels: Record<string, string> = {
              user_pref: "Pref",
              project_fact: "Fact",
              skill: "Skill",
            };
            const kindColors: Record<string, string> = {
              user_pref: "border-accent/30 text-accent bg-accent/10",
              project_fact: "border-success/30 text-success bg-success/10",
              skill: "border-warn/30 text-warn bg-warn/10",
            };
            return (
              <li key={item.id}>
                <label
                  className={`flex items-start gap-2 p-2 rounded-md cursor-pointer hover:bg-surface-2 ${
                    excluded ? "opacity-50" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!excluded}
                    onChange={() => toggleItem(item.id)}
                    className="accent-[var(--color-accent)] mt-1 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className={`inline-block text-[10px] uppercase tracking-wider font-medium px-1 py-0 rounded border ${
                          kindColors[item.kind] || kindColors.skill
                        }`}
                      >
                        {kindLabels[item.kind] || item.kind}
                      </span>
                      {item.title && (
                        <span className="text-xs font-medium text-text truncate">
                          {item.title}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                      {item.content}
                    </div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

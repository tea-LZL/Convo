import { useEffect, useState } from "react";
import { Brain, Pin } from "lucide-react";
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
    // Persist: the list of INCLUDED item ids, and whether the chat is
    // scoped at all.
    //
    // Two instructions, not one. At least one exclusion is a scope: the
    // chat is restricted to the checked items, which is the whole point of
    // this modal. NO exclusion is the one gesture that means "no
    // restriction", so it clears the scope rather than storing a list of
    // every id. And the case this rewrite exists for is in between: the
    // last box, unchecked, leaves an *empty* included list — and an empty
    // list sent as "unscoped" hands the user back the entire library, the
    // opposite of what they just asked for. So the empty list is sent as a
    // scope, and the database can tell the two apart.
    const enabledIds = items
      .filter((i) => i.is_enabled)
      .map((i) => i.id);
    const configured = next.size > 0;
    const included = configured ? enabledIds.filter((eid) => !next.has(eid)) : [];
    try {
      await setSessionOverrides(sessionId, included, configured);
    } catch {
      // Rollback on failure
      setExcludedIds(excludedIds);
    }
  };

  const load = async () => {
    if (!open) return;
    setLoading(true);
    try {
      const [all, scope] = await Promise.all([
        api.listMemory(),
        api.getSessionMemoryOverrides(sessionId),
      ]);
      setItems(all);
      // An item is "excluded" if it's enabled globally and not admitted by
      // this chat's scope. An unscoped chat admits every enabled item —
      // that is what an untouched chat means, and it is why the read
      // reports `configured` rather than leaving it to be inferred from an
      // empty list. A chat scoped to nothing has every enabled item
      // excluded, which is what the user asked for and what recall does.
      if (scope.configured) {
        const admitted = new Set(scope.itemIds);
        setExcludedIds(
          new Set(
            all
              .filter((i) => i.is_enabled && !admitted.has(i.id))
              .map((i) => i.id)
          ),
        );
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
  const nothingEligible = enabled.length > 0 && enabled.every((i) => excludedIds.has(i.id));

  return (
    <Modal open={open} onClose={onClose} title="Memory for this session" size="md">
      <p className="text-xs text-text-muted mb-3">
        Checked items are the ones recall may return for this chat; unchecking one only changes
        this chat. Recall sends the ones relevant to what you are asking, so checking is not the
        same as pinning. A pinned memory is sent in every chat whether it is checked here or not —
        pin one from the Memory page to always include it. Unchecking the last one means no memory
        is eligible here; checking them all again removes the restriction.
      </p>
      {/*
        The state a user must never have to infer: with every box unchecked,
        this chat has no eligible memory. It used to be the opposite —
        unchecking everything sent an empty list, which meant "no
        restriction", so the whole library came back with nothing to show for
        it.
      */}
      {nothingEligible && (
        <p className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-md px-2 py-1.5 mb-3">
          No memory is eligible for recall in this chat. Pinned memories are still sent.
        </p>
      )}
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
                      {/* The checkbox is not what puts a memory in the
                          prompt, so a pinned row says so where the user is
                          looking when they are about to trust the box. */}
                      {item.pinned && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded-full border border-accent/30 text-accent shrink-0"
                          title="Pinned — sent in every chat whether it is checked here or not. Unpin it on the Memory page."
                        >
                          <Pin size={8} /> pinned
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

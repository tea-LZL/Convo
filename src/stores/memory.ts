/**
 * Memory store — caches enabled memory items + per-session overrides,
 * exposes builders for the system prompt to inject.
 */
import { create } from "zustand";
import { api, ExtractedFact, MemoryItem } from "../lib/api";

export interface PendingExtract {
  /** Local-only ID so React can key the row. */
  localId: string;
  /** The session this came from, for "Open chat" links. */
  sessionId: string;
  /** Timestamp the extract ran (ms). */
  extractedAt: number;
  /** Fact candidates from the LLM. */
  facts: ExtractedFact[];
}

interface MemoryState {
  items: MemoryItem[];
  loaded: boolean;
  loading: boolean;
  /** Out-of-band queue of auto-extracted facts awaiting user review. */
  pendingExtracts: PendingExtract[];
  refresh: () => Promise<void>;
  /** Returns enabled memory items as a system prompt block.
   *  When sessionId is provided, filters to only items included
   *  in that session's overrides (if overrides exist). */
  buildContextBlock: (sessionId?: string) => Promise<string>;
  /** Pre-fetched per-session override lists (cached in memory). */
  _overrides: Record<string, string[] | null>;
  /** Add a pending extract (e.g. from auto-eval after chat-done). */
  pushPendingExtract: (extract: Omit<PendingExtract, "localId" | "extractedAt">) => void;
  /** Drop a pending extract (after user reviews / saves / discards). */
  removePendingExtract: (localId: string) => void;
  /** Drop every pending extract, optionally for one sessionId. */
  clearPendingExtracts: (sessionId?: string) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  _overrides: {},
  pendingExtracts: [],
  refresh: async () => {
    set({ loading: true });
    try {
      const items = await api.getEnabledMemory();
      set({ items, loaded: true, loading: false });
    } catch (e) {
      console.error("Failed to load memory:", e);
      set({ loading: false });
    }
  },
  pushPendingExtract: (extract) => {
    // Skip empty payloads — extract_facts_from_session returns [] when
    // it can't find anything durable, and that's not worth surfacing.
    if (!extract.facts || extract.facts.length === 0) return;
    set((s) => ({
      pendingExtracts: [
        ...s.pendingExtracts,
        {
          ...extract,
          localId: `pe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          extractedAt: Date.now(),
        },
      ],
    }));
  },
  removePendingExtract: (localId) =>
    set((s) => ({ pendingExtracts: s.pendingExtracts.filter((p) => p.localId !== localId) })),
  clearPendingExtracts: (sessionId) =>
    set((s) => ({
      pendingExtracts: sessionId
        ? s.pendingExtracts.filter((p) => p.sessionId !== sessionId)
        : [],
    })),
  buildContextBlock: async (sessionId) => {
    // Ensure items are loaded.  refresh() is called on mount but is
    // fire-and-forget — on the first send the promise may not have
    // resolved yet.  Guard with a one-shot load here.
    let items = get().items;
    if ((!items || items.length === 0) && !get().loaded && !get().loading) {
      await get().refresh();
      items = get().items;
    }
    if (!items || items.length === 0) return "";

    // Apply per-session overrides if sessionId is provided
    if (sessionId) {
      const overrides = get()._overrides;
      if (!(sessionId in overrides)) {
        // Fetch and cache
        try {
          const idList = await api.getSessionMemoryOverrides(sessionId);
          overrides[sessionId] = idList;
          set({ _overrides: { ...overrides } });
        } catch {
          overrides[sessionId] = null;
        }
      }
      const overrideList = get()._overrides[sessionId];
      // Empty list = no overrides (= all items included).
      // Non-empty list = only these items are included.
      if (overrideList !== null && overrideList !== undefined && overrideList.length > 0) {
        const overrideSet = new Set(overrideList);
        items = items.filter((i) => overrideSet.has(i.id));
      }
    }

    const grouped: Record<string, MemoryItem[]> = {
      user_pref: [],
      project_fact: [],
      skill: [],
    };
    for (const i of items) {
      (grouped[i.kind] ??= []).push(i);
    }
    const lines: string[] = [];
    const hasAny = grouped.user_pref.length || grouped.project_fact.length || grouped.skill.length;
    if (hasAny) {
      lines.push("USER CONTEXT (use these facts when relevant to the user's query):");
    }
    if (grouped.user_pref.length) {
      lines.push("## User preferences");
      for (const i of grouped.user_pref) {
        const t = i.title ? `**${i.title}** — ` : "";
        lines.push(`- ${t}${i.content}`);
      }
    }
    if (grouped.project_fact.length) {
      lines.push("\n## Project facts");
      for (const i of grouped.project_fact) {
        const t = i.title ? `**${i.title}** — ` : "";
        lines.push(`- ${t}${i.content}`);
      }
    }
    if (grouped.skill.length) {
      lines.push("\n## Active skills");
      for (const i of grouped.skill) {
        const t = i.title ? `**${i.title}** — ` : "";
        lines.push(`- ${t}${i.content}`);
      }
    }
    return lines.join("\n");
  },
}));

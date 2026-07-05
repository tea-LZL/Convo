/**
 * Memory store — caches enabled memory items + per-session overrides,
 * exposes builders for the system prompt to inject.
 */
import { create } from "zustand";
import { api, MemoryItem } from "../lib/api";

interface MemoryState {
  items: MemoryItem[];
  loaded: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Returns enabled memory items as a system prompt block.
   *  When sessionId is provided, filters to only items included
   *  in that session's overrides (if overrides exist). */
  buildContextBlock: (sessionId?: string) => Promise<string>;
  /** Pre-fetched per-session override lists (cached in memory). */
  _overrides: Record<string, string[] | null>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  _overrides: {},
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
  buildContextBlock: async (sessionId) => {
    let items = get().items;
    if (items.length === 0) return "";

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

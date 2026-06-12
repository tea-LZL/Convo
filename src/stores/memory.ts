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
  /** Returns enabled memory items as a system prompt block. */
  buildContextBlock: () => string;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
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
  buildContextBlock: () => {
    const items = get().items;
    if (items.length === 0) return "";
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

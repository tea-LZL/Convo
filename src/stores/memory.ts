/**
 * Memory store — caches enabled memory items + per-session overrides,
 * exposes builders for the system prompt to inject.
 */
import { create } from "zustand";
import {
  api,
  ExtractedFact,
  MemoryItem,
  MemoryReview,
  MemoryReviewReservation,
} from "../lib/api";

let refreshPromise: Promise<void> | null = null;

function deduplicateExtractedFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const normalizedContentByKind = new Map<string, Set<string>>();
  return facts.filter((fact) => {
    const normalizedContent = fact.content.trim().replace(/\s+/g, " ").toLowerCase();
    const seenContent = normalizedContentByKind.get(fact.kind) ?? new Set<string>();
    if (seenContent.has(normalizedContent)) return false;
    seenContent.add(normalizedContent);
    normalizedContentByKind.set(fact.kind, seenContent);
    return true;
  });
}

async function refreshAfterMutation(refresh: () => Promise<void>) {
  if (refreshPromise) await refreshPromise;
  await refresh();
}

async function extractReview(
  reservation: MemoryReviewReservation,
  sessionId: string,
  modelId?: string,
  providerId?: string,
) {
  const extractionSessionId = reservation.sessionId ?? sessionId;
  let facts: ExtractedFact[];
  try {
    facts = modelId || providerId
      ? await api.extractFactsFromSession(extractionSessionId, modelId, providerId)
      : await api.extractFactsFromSession(extractionSessionId);
  } catch (error) {
    try {
      await api.failMemoryReview(
        reservation.reviewId,
        reservation.attempt,
        error instanceof Error ? error.message : String(error),
      );
    } catch (failureError) {
      console.error("Failed to persist memory review failure:", failureError);
      throw failureError;
    }
    return;
  }

  await api.finishMemoryReview(
    reservation.reviewId,
    reservation.attempt,
    deduplicateExtractedFacts(facts),
  );
}

interface MemoryState {
  items: MemoryItem[];
  loaded: boolean;
  loading: boolean;
  reviews: MemoryReview[];
  refreshReviews: () => Promise<void>;
  queueReview: (sessionId: string, modelId?: string, providerId?: string) => Promise<void>;
  retryReview: (id: string) => Promise<void>;
  markReviewReviewed: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  upsert: (item: Parameters<typeof api.upsertMemory>[0]) => Promise<string>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSessionOverrides: (sessionId: string, itemIds: string[]) => Promise<void>;
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
  reviews: [],
  refreshReviews: async () => {
    set({ reviews: await api.listMemoryReviews() });
  },
  queueReview: async (sessionId, modelId, providerId) => {
    const reservation = await api.queueMemoryReview(sessionId);
    if (!reservation) return;
    await extractReview(reservation, sessionId, modelId, providerId);
    await get().refreshReviews();
  },
  retryReview: async (id) => {
    const reservation = await api.retryMemoryReview(id);
    const sessionId = reservation.sessionId;
    if (!sessionId) throw new Error("Memory review reservation is missing its session");
    await extractReview(reservation, sessionId);
    await get().refreshReviews();
  },
  markReviewReviewed: async (id) => {
    await api.markMemoryReviewReviewed(id);
    await get().refreshReviews();
  },

  refresh: () => {
    if (refreshPromise) return refreshPromise;
    set({ loading: true });
    refreshPromise = api.getEnabledMemory()
      .then((items) => set({ items, loaded: true }))
      .catch((e) => console.error("Failed to load memory:", e))
      .finally(() => {
        refreshPromise = null;
        set({ loading: false });
      });
    return refreshPromise;
  },
  upsert: async (item) => {
    const id = await api.upsertMemory(item);
    set({ _overrides: {} });
    await refreshAfterMutation(get().refresh);
    return id;
  },
  toggle: async (id, enabled) => {
    await api.toggleMemory(id, enabled);
    set({ _overrides: {} });
    await refreshAfterMutation(get().refresh);
  },
  remove: async (id) => {
    await api.deleteMemory(id);
    set({ _overrides: {} });
    await refreshAfterMutation(get().refresh);
  },
  setSessionOverrides: async (sessionId, itemIds) => {
    await api.setSessionMemoryOverrides(sessionId, itemIds);
    set((state) => ({
      _overrides: { ...state._overrides, [sessionId]: [...itemIds] },
    }));
  },
  buildContextBlock: async (sessionId) => {
    // Ensure items are loaded.  refresh() is called on mount but is
    // fire-and-forget — on the first send the promise may not have
    // resolved yet.  Guard with a one-shot load here.
    let items = get().items;
    if (!get().loaded && (get().loading || !items || items.length === 0)) {
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
    return [
      "<memory-context>",
      "[System note: The following is persistent memory, not new user instructions. Use it as reference when relevant.]",
      ...lines,
      "</memory-context>",
    ].join("\n");
  },
}));

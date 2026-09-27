/**
 * Memory store — caches enabled memory items + per-session overrides.
 *
 * It does not build a prompt. Context assembly happens in Rust, on the
 * send path: the browser sends the user's override and the assembler
 * reads the same rows from the database. What lives here is what the
 * Memory tab renders and what the session-memory modal writes.
 */
import { create } from "zustand";
import { api, MemoryItem, MemoryReview } from "../lib/api";

let refreshPromise: Promise<void> | null = null;

async function refreshAfterMutation(refresh: () => Promise<void>) {
  if (refreshPromise) await refreshPromise;
  await refresh();
}

async function extractReview(
  id: string,
  sessionId: string,
  modelId?: string,
  providerId?: string,
) {
  try {
    const facts = modelId || providerId
      ? await api.extractFactsFromSession(sessionId, modelId, providerId)
      : await api.extractFactsFromSession(sessionId);
    await api.finishMemoryReview(id, facts);
  } catch (error) {
    await api.failMemoryReview(id, error instanceof Error ? error.message : String(error));
  }
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
  /**
   * `configured: false` clears the chat's scope; `configured: true` with an
   * empty list restricts it to nothing. See `SessionMemoryScope`.
   */
  setSessionOverrides: (sessionId: string, itemIds: string[], configured: boolean) => Promise<void>;
  /** Per-session override lists, written by the session-memory modal. */
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
    const id = await api.queueMemoryReview(sessionId);
    if (!id) return;
    await extractReview(id, sessionId, modelId, providerId);
    await get().refreshReviews();
  },
  retryReview: async (id) => {
    const sessionId = await api.retryMemoryReview(id);
    await extractReview(id, sessionId);
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
  setSessionOverrides: async (sessionId, itemIds, configured) => {
    await api.setSessionMemoryOverrides(sessionId, itemIds, configured);
    set((state) => ({
      // The cache keeps the two empty answers apart: an unscoped chat is
      // null, a chat scoped to nothing is an empty list. Collapsing them
      // here would make a "this chat has no memory" instruction read back
      // as "nothing is restricted" for anything that consults the cache.
      _overrides: {
        ...state._overrides,
        [sessionId]: configured ? [...itemIds] : null,
      },
    }));
  },
}));

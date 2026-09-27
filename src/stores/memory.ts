/**
 * Memory store — caches enabled memory items + per-session overrides.
 *
 * It does not build a prompt. Context assembly happens in Rust, on the
 * send path: the browser sends the user's override and the assembler
 * reads the same rows from the database. What lives here is what the
 * Memory tab renders, what the session-memory modal writes, and the
 * automatic after-a-turn extraction the chat fires when the round is
 * worth running.
 */
import { create } from "zustand";
import { api, AppliedRevision, MemoryItem, MemoryReview } from "../lib/api";

let refreshPromise: Promise<void> | null = null;

async function refreshAfterMutation(refresh: () => Promise<void>) {
  if (refreshPromise) await refreshPromise;
  await refresh();
}

/**
 * Re-run the split path for a review row that is already persisted. Only
 * `retryReview` uses this, and it has no model to route with — it retries
 * the session the row names, on whatever the default provider is.
 */
async function extractReview(id: string, sessionId: string) {
  try {
    await api.finishMemoryReview(id, await api.extractFactsFromSession(sessionId));
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
  /**
   * The automatic after-a-turn path. Rust runs the extraction, applies the
   * revision table, writes the high-confidence rows and queues the
   * ambiguous ones in the inbox. The frontend no longer decides what is
   * kept — that is the whole point of the revision table — so this returns
   * what each candidate did and lets the caller say so out loud.
   */
  extractAndRevise: (
    sessionId: string,
    modelId?: string,
    providerId?: string,
  ) => Promise<AppliedRevision[]>;
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
  extractAndRevise: async (sessionId, modelId, providerId) => {
    const applied = modelId || providerId
      ? await api.memoryExtractAndRevise(sessionId, modelId, providerId)
      : await api.memoryExtractAndRevise(sessionId);
    // Both lists can be stale now, and for different reasons: the round may
    // have written memory rows and may have queued inbox rows. The list is
    // awaited so it is fresh by the time this resolves. The inbox refresh is
    // deliberately not awaited — a read that fails there would reject before
    // the caller can report what was written, which turns a correct write
    // into a silent one. The Memory tab re-reads the inbox on open and after
    // any review action, so a lost refresh heals itself.
    await get().refresh();
    void get().refreshReviews().catch(console.error);
    return applied;
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

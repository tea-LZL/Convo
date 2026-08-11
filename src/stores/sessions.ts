/**
 * Sessions (chat threads) store.
 */
import { create } from "zustand";
import { api } from "../lib/api";

export interface Session {
  id: string;
  title: string;
  model_id: string | null;
  provider_id: string | null;
  group_id: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

interface SessionsState {
  sessions: Session[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (opts?: { title?: string; providerId?: string; modelId?: string }) => Promise<Session>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  setActive: (id: string | null) => void;
  search: (q: string) => Promise<Array<Session & { snippet: string }>>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const sessions = await api.listSessions(null, true);
      set({ sessions, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  create: async (opts) => {
    const session = await api.createSession({
      title: opts?.title,
      modelId: opts?.modelId,
      providerId: opts?.providerId,
    });
    await get().refresh();
    return session;
  },

  rename: async (id, title) => {
    await api.renameSession(id, title);
    await get().refresh();
  },

  remove: async (id) => {
    await api.deleteSession(id);
    if (get().activeId === id) set({ activeId: null });
    await get().refresh();
  },

  pin: async (id, pinned) => {
    await api.setSessionPinned(id, pinned);
    await get().refresh();
  },

  archive: async (id, archived) => {
    await api.setSessionArchived(id, archived);
    if (get().activeId === id && archived) set({ activeId: null });
    await get().refresh();
  },

  setActive: (id) => set({ activeId: id }),

  search: async (q) => {
    if (!q.trim()) return [];
    return await api.searchSessions(q);
  },
}));

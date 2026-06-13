/**
 * Sessions (chat threads) store.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Session {
  id: string;
  title: string;
  model_id: string | null;
  provider_id: string | null;
  preset_id: string | null;
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
  refresh: () => Promise<void>;
  create: (opts?: { title?: string; providerId?: string; modelId?: string; presetId?: string }) => Promise<Session>;
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

  refresh: async () => {
    set({ loading: true });
    try {
      // Always fetch both active AND archived rows. The sidebar does
      // the active/archived split client-side (filter on
      // s.is_archived). Filtering at the DB layer broke the Archived
      // tab: the row was archived in the DB, but the in-memory list
      // never contained it, so the Archived tab was always empty and
      // archiving a session made it look like it disappeared.
      const sessions = await invoke<Session[]>("list_sessions", {
        groupId: null,
        includeArchived: true,
      });
      set({ sessions, loading: false });
    } catch (e) {
      console.error("Failed to load sessions:", e);
      set({ loading: false });
    }
  },

  create: async (opts) => {
    const session = await invoke<Session>("create_session", {
      title: opts?.title ?? "New Chat",
      modelId: opts?.modelId ?? null,
      providerId: opts?.providerId ?? null,
      presetId: opts?.presetId ?? null,
      groupId: null,
    });
    await get().refresh();
    return session;
  },

  rename: async (id, title) => {
    await invoke("rename_session", { id, title });
    await get().refresh();
  },

  remove: async (id) => {
    await invoke("delete_session", { id });
    if (get().activeId === id) set({ activeId: null });
    await get().refresh();
  },

  pin: async (id, pinned) => {
    await invoke("set_session_pinned", { id, pinned });
    await get().refresh();
  },

  archive: async (id, archived) => {
    await invoke("set_session_archived", { id, archived });
    if (get().activeId === id && archived) set({ activeId: null });
    await get().refresh();
  },

  setActive: (id) => set({ activeId: id }),

  search: async (q) => {
    if (!q.trim()) return [];
    return await invoke<Array<Session & { snippet: string }>>("search_sessions", { query: q });
  },
}));

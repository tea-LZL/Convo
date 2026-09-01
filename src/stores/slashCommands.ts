/**
 * Low-frequency cache for persisted prompt commands.
 *
 * Command loading is deliberately separate from the streaming stores. The
 * cache is refreshed on demand and after curator mutations, while command
 * lookup remains synchronous for the composer.
 */
import { create } from "zustand";
import { api, SlashCommand, SlashCommandInput } from "../lib/api";

let refreshPromise: Promise<void> | null = null;

async function refreshAfterMutation(refresh: (force?: boolean) => Promise<void>) {
  if (refreshPromise) await refreshPromise;
  await refresh(true);
}

export interface SlashCommandsState {
  commands: SlashCommand[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
  upsert: (command: SlashCommandInput) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

export const useSlashCommandsStore = create<SlashCommandsState>((set, get) => ({
  commands: [],
  loaded: false,
  loading: false,
  error: null,

  refresh: (force = false) => {
    if (!force && get().loaded) return Promise.resolve();
    if (refreshPromise) return refreshPromise;

    set({ loading: true });
    refreshPromise = api
      .listSlashCommands()
      .then((commands) => set({ commands, loaded: true, error: null }))
      .catch((error) => {
        console.error("Failed to load slash commands:", error);
        set({ error: String(error), loaded: false });
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
        set({ loading: false });
      });
    return refreshPromise;
  },

  upsert: async (command) => {
    const id = await api.upsertSlashCommand(command);
    await refreshAfterMutation(get().refresh);
    return id;
  },

  remove: async (id) => {
    await api.deleteSlashCommand(id);
    await refreshAfterMutation(get().refresh);
  },
}));

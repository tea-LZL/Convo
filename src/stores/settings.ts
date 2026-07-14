/**
 * Generic app settings — independent of theme.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AppSettings {
  muteSounds: boolean;
  muteNotifications: boolean;
  enterToSend: boolean;
  showTokenCount: boolean;
  showThinking: boolean;
  density: "compact" | "comfortable";
  /**
   * Automatically extract durable facts from a chat after it
   * completes (>= 2 exchanges) and queue them in the Memory page
   * for review. Default: true. Set false to require manual
   * "Extract from chat" via Memory route.
   */
  memoryAutoEvaluate: boolean;
}

interface SettingsState extends AppSettings {
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  updateMany: (patch: Partial<AppSettings>) => void;
}

const defaults: AppSettings = {
  muteSounds: false,
  muteNotifications: false,
  enterToSend: true,
  showTokenCount: true,
  showThinking: true,
  density: "comfortable",
  memoryAutoEvaluate: true,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      update: (key, value) => set((s) => ({ ...s, [key]: value })),
      updateMany: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: "convo-settings",
    }
  )
);

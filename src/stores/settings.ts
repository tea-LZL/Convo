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
  defaultPresetId: string | null;
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
  defaultPresetId: null,
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

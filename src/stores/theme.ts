/**
 * Theme loader — pulls themes from the Rust backend, applies the active one to
 * the document by setting CSS custom properties on `<html>`.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeId = string;

export interface ThemeSummary {
  id: string;
  name: string;
  is_builtin: boolean;
  tokens_json: string;
  created_at: string;
}

interface ThemeState {
  themes: ThemeSummary[];
  activeThemeId: ThemeId;
  mode: "dark" | "light" | "system";
  density: "compact" | "comfortable";
  loading: boolean;
  init: () => Promise<void>;
  setActive: (id: ThemeId) => Promise<void>;
  setMode: (mode: "dark" | "light" | "system") => void;
  setDensity: (d: "compact" | "comfortable") => void;
  applyTheme: (id: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themes: [],
      activeThemeId: "default-dark",
      mode: "dark",
      density: "comfortable",
      loading: false,

      init: async () => {
        set({ loading: true });
        try {
          const themes = await invoke<ThemeSummary[]>("list_themes");
          set({ themes, loading: false });
          await get().applyTheme(get().activeThemeId);
        } catch (e) {
          console.error("Failed to load themes:", e);
          set({ loading: false });
        }
      },

      setActive: async (id) => {
        set({ activeThemeId: id });
        await get().applyTheme(id);
      },

      setMode: (mode) => {
        set({ mode });
        const effective = resolveMode(mode);
        document.documentElement.setAttribute("data-theme-mode", effective);
      },

      setDensity: (d) => set({ density: d }),

      applyTheme: (id) => {
        const theme = get().themes.find((t) => t.id === id);
        if (!theme) return;
        try {
          const tokens = JSON.parse(theme.tokens_json);
          const root = document.documentElement;
          for (const [k, v] of Object.entries(tokens)) {
            const cssVar = k.startsWith("color.") || k.startsWith("radius.") || k.startsWith("shadow.") || k.startsWith("font.")
              ? `--${k.replace(/\./g, "-")}`
              : `--${k}`;
            root.style.setProperty(cssVar, String(v));
          }
          const effective = resolveMode(get().mode);
          root.setAttribute("data-theme-mode", effective);
          // If a mode is specified in the theme, use it.
          if (tokens.mode === "dark" || tokens.mode === "light") {
            root.setAttribute("data-theme-mode", tokens.mode);
          }
        } catch (e) {
          console.error("Failed to apply theme:", e, theme);
        }
      },
    }),
    {
      name: "convo-theme",
      partialize: (s) => ({
        activeThemeId: s.activeThemeId,
        mode: s.mode,
        density: s.density,
      }),
    }
  )
);

function resolveMode(mode: "dark" | "light" | "system"): "dark" | "light" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export async function saveCustomTheme(name: string, tokens: Record<string, string>) {
  const id = await invoke<string>("save_theme", {
    name,
    tokensJson: JSON.stringify(tokens),
  });
  return id;
}

export async function deleteCustomTheme(id: string) {
  await invoke("delete_theme", { id });
}

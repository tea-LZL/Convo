/**
 * Tour / onboarding state.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  target?: string; // CSS selector
  position?: "top" | "bottom" | "left" | "right";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Convo",
    body: "Convo is a self-hosted AI workspace. Click the sidebar to switch tools, or hit ⌘K for everything.",
  },
  {
    id: "providers",
    title: "Connect a provider",
    body: "By default, Convo looks for Ollama on localhost. Add OpenAI-compatible endpoints (OpenRouter, vLLM, llama.cpp) in Settings → Providers.",
  },
  {
    id: "palette",
    title: "Command palette",
    body: "⌘K (or Ctrl+K) opens the command palette. Type to search, ↑↓ to navigate, ↵ to run. It also indexes your sessions.",
    target: "[data-tour='palette']",
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    body: "Ctrl+N: new chat. Ctrl+B: toggle sidebar. Ctrl+Shift+F: search sessions. Ctrl+/: focus input. Re-bind them in Settings → Shortcuts.",
  },
  {
    id: "explore",
    title: "Explore",
    body: "The sidebar has Chat, Compare, Documents, Notes, Tasks, and Memory. Start a chat, then explore the rest.",
  },
];

interface TourState {
  active: boolean;
  step: number;
  dismissed: boolean;
  init: () => void;
  next: () => void;
  prev: () => void;
  skip: () => void;
  restart: () => void;
}

export const useTourStore = create<TourState>()(
  persist(
    (set) => ({
      active: false,
      step: 0,
      dismissed: false,
      init: () =>
        set((s) => {
          if (s.dismissed) return s;
          return { ...s, active: true, step: 0 };
        }),
      next: () =>
        set((s) => {
          if (s.step + 1 >= TOUR_STEPS.length) {
            return { active: false, step: 0, dismissed: true };
          }
          return { step: s.step + 1 };
        }),
      prev: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
      skip: () => set({ active: false, dismissed: true }),
      restart: () => set({ active: true, step: 0, dismissed: false }),
    }),
    {
      name: "convo-tour",
      partialize: (s) => ({ dismissed: s.dismissed }),
    }
  )
);

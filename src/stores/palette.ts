/**
 * Command palette state + action registry.
 */
import { create } from "zustand";
import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

export interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  group: string;
  keywords?: string[];
  shortcut?: string;
  perform: (helpers: { navigate: (path: string) => void }) => void | Promise<void>;
  icon?: ReactNode;
}

interface PaletteState {
  open: boolean;
  query: string;
  setOpen: (v: boolean) => void;
  setQuery: (q: string) => void;
  toggle: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  query: "",
  setOpen: (v) => set({ open: v, query: v ? "" : "" }),
  setQuery: (q) => set({ query: q }),
  toggle: () => set((s) => ({ open: !s.open, query: !s.open ? "" : "" })),
}));

let actionRegistry: PaletteAction[] = [];

export function registerActions(actions: PaletteAction[]) {
  for (const a of actions) {
    const existing = actionRegistry.findIndex((x) => x.id === a.id);
    if (existing >= 0) actionRegistry[existing] = a;
    else actionRegistry.push(a);
  }
}

export function unregisterActions(ids: string[]) {
  actionRegistry = actionRegistry.filter((a) => !ids.includes(a.id));
}

export function getActions(): PaletteAction[] {
  return actionRegistry;
}

export function filterActions(query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return actionRegistry;
  return actionRegistry.filter((a) => {
    if (a.label.toLowerCase().includes(q)) return true;
    if (a.description?.toLowerCase().includes(q)) return true;
    if (a.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });
}

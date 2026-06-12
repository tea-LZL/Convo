/**
 * Keyboard shortcut manager — central registry + parser.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ShortcutBinding {
  id: string;
  combo: string; // e.g. "ctrl+k", "ctrl+shift+f"
  action: () => void;
  description?: string;
}

interface ShortcutState {
  bindings: ShortcutBinding[];
  register: (b: ShortcutBinding) => void;
  registerMany: (bs: ShortcutBinding[]) => void;
  unregister: (id: string) => void;
  setCombo: (id: string, combo: string) => void;
  isMac: boolean;
}

const isMacFn = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export const useShortcutsStore = create<ShortcutState>((set) => ({
  bindings: [],
  isMac: isMacFn(),
  register: (b) =>
    set((s) => {
      const i = s.bindings.findIndex((x) => x.id === b.id);
      const next = s.bindings.slice();
      if (i >= 0) next[i] = b;
      else next.push(b);
      return { bindings: next };
    }),
  registerMany: (bs) =>
    set((s) => {
      const map = new Map(s.bindings.map((b) => [b.id, b]));
      for (const b of bs) map.set(b.id, b);
      return { bindings: Array.from(map.values()) };
    }),
  unregister: (id) => set((s) => ({ bindings: s.bindings.filter((b) => b.id !== id) })),
  setCombo: (id, combo) =>
    set((s) => ({ bindings: s.bindings.map((b) => (b.id === id ? { ...b, combo } : b)) })),
}));

export function parseEvent(e: KeyboardEvent, isMac = isMacFn()): string {
  const parts: string[] = [];
  const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
  if (ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  if (key === "escape") key = "escape";
  if (key.length === 1) key = key;
  if (parts.length === 0) return key;
  return `${parts.join("+")}+${key}`;
}

export function matchesCombo(eventCombo: string, target: string): boolean {
  if (!target) return false;
  return eventCombo === target.toLowerCase();
}

export function comboDisplay(combo: string, isMac = isMacFn()): string {
  if (!combo) return "";
  const parts = combo.split("+");
  return parts
    .map((p) => {
      if (p === "ctrl") return isMac ? "⌘" : "Ctrl";
      if (p === "alt") return isMac ? "⌥" : "Alt";
      if (p === "shift") return isMac ? "⇧" : "Shift";
      if (p === "space") return "Space";
      if (p === "escape") return "Esc";
      if (p === "enter") return "Enter";
      return p.toUpperCase();
    })
    .join(isMac ? "" : "+");
}

/**
 * Hook to install a global keydown listener that matches against the registered
 * shortcuts. Should be called once from the App shell.
 */
export function useGlobalShortcuts() {
  const bindings = useShortcutsStore((s) => s.bindings);
  const isMac = useShortcutsStore((s) => s.isMac);

  // Bind listener once; re-attaches when bindings change.
  if (typeof window !== "undefined") {
    (window as any).__shortcutsBindings = bindings;
    (window as any).__shortcutsIsMac = isMac;
  }
}

export function handleKeyDown(e: KeyboardEvent) {
  const w = window as any;
  const bindings: ShortcutBinding[] = w.__shortcutsBindings ?? [];
  const isMac: boolean = w.__shortcutsIsMac ?? false;
  const eventCombo = parseEvent(e, isMac);
  for (const b of bindings) {
    if (matchesCombo(eventCombo, b.combo)) {
      e.preventDefault();
      b.action();
      return;
    }
  }
}

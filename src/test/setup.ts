import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// ------------------------------------------------------------------
// localStorage polyfill — jsdom may not expose a functional
// localStorage depending on the vitest/jsdom version combination.
// We define it before any mocks so test isolation works reliably.
// ------------------------------------------------------------------
if (!globalThis.localStorage || typeof globalThis.localStorage.clear !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// ------------------------------------------------------------------
// Tauri runtime mocks
// ------------------------------------------------------------------
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
}));

// Sounds require Web Audio APIs that jsdom does not provide.
vi.mock("../utils/sounds", () => ({
  playDoneSound: vi.fn(),
  playSendSound: vi.fn(),
}));

// ------------------------------------------------------------------
// Browser APIs that jsdom does not implement
// ------------------------------------------------------------------
Object.defineProperty(globalThis, "matchMedia", {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperties(globalThis.URL, {
  createObjectURL: {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob://mock-object-url"),
  },
  revokeObjectURL: {
    configurable: true,
    writable: true,
    value: vi.fn(),
  },
});

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => null),
});

let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  writable: true,
  configurable: true,
  value: vi.fn(() => {
    uuidCounter += 1;
    return `test-uuid-${uuidCounter}`;
  }),
});

// ------------------------------------------------------------------
// Test isolation helpers
// ------------------------------------------------------------------
beforeEach(() => {
  uuidCounter = 0;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

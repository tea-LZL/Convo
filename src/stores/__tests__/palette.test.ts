import { describe, expect, it, vi } from "vitest";
import {
  filterActions,
  getActions,
  registerActions,
  unregisterActions,
  usePaletteStore,
} from "../palette";

const sampleActions = [
  {
    id: "a1",
    label: "New Chat",
    group: "General",
    keywords: ["session"],
    perform: vi.fn(),
  },
  {
    id: "a2",
    label: "Settings",
    group: "General",
    description: "Open settings",
    perform: vi.fn(),
  },
];

beforeEach(() => {
  unregisterActions(sampleActions.map((a) => a.id));
  usePaletteStore.setState({ open: false, query: "" });
});

describe("usePaletteStore", () => {
  it("starts closed with empty query", () => {
    expect(usePaletteStore.getState().open).toBe(false);
    expect(usePaletteStore.getState().query).toBe("");
  });

  it("opens and clears query", () => {
    usePaletteStore.getState().setOpen(true);
    expect(usePaletteStore.getState().open).toBe(true);
    expect(usePaletteStore.getState().query).toBe("");
  });

  it("closes and clears query", () => {
    usePaletteStore.setState({ open: true, query: "abc" });
    usePaletteStore.getState().setOpen(false);
    expect(usePaletteStore.getState().open).toBe(false);
    expect(usePaletteStore.getState().query).toBe("");
  });

  it("toggles open state", () => {
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().open).toBe(true);
    usePaletteStore.getState().toggle();
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it("sets query", () => {
    usePaletteStore.getState().setQuery("find");
    expect(usePaletteStore.getState().query).toBe("find");
  });
});

describe("action registry", () => {
  it("registers actions", () => {
    registerActions(sampleActions);
    expect(getActions()).toHaveLength(2);
  });

  it("replaces actions with the same id", () => {
    registerActions(sampleActions);
    registerActions([{ ...sampleActions[0], label: "New Session" }]);
    expect(getActions()).toHaveLength(2);
    expect(getActions()[0].label).toBe("New Session");
  });

  it("unregisters actions by id", () => {
    registerActions(sampleActions);
    unregisterActions(["a1"]);
    expect(getActions().map((a) => a.id)).toEqual(["a2"]);
  });

  it("filters actions by label", () => {
    registerActions(sampleActions);
    const results = filterActions("settings");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a2");
  });

  it("filters actions by keyword", () => {
    registerActions(sampleActions);
    const results = filterActions("session");
    expect(results.map((a) => a.id)).toContain("a1");
  });

  it("returns all actions when query is empty", () => {
    registerActions(sampleActions);
    expect(filterActions("")).toHaveLength(2);
  });

  it("is case-insensitive when filtering", () => {
    registerActions(sampleActions);
    expect(filterActions("SETTINGS")).toHaveLength(1);
  });
});

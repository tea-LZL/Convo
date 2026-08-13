import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, Session } from "../../lib/api";
import { handleKeyDown, isEditableTarget, parseEvent, useShortcutsStore } from "../../stores/shortcuts";
import { useSessionsStore } from "../../stores/sessions";
import { TOUR_STEPS, useTourStore } from "../../stores/tour";

const session = (id: string, archived = false): Session => ({
  id,
  title: "Chat",
  model_id: null,
  provider_id: null,
  group_id: null,
  is_pinned: false,
  is_archived: archived,
  created_at: "now",
  updated_at: "now",
});

describe("shell interactions", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
    useShortcutsStore.setState({ bindings: [] });
    useTourStore.setState({ active: false, step: 0, dismissed: true });
  });

  it("refreshes active and archived sessions through the API boundary", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([session("active"), session("archived", true)]);
    await useSessionsStore.getState().refresh();
    expect(api.listSessions).toHaveBeenCalledWith(null, true);
    expect(useSessionsStore.getState().sessions).toHaveLength(2);
  });

  it("rejects duplicate bindings, dispatches current store bindings, and normalizes arrows", () => {
    const action = vi.fn();
    useShortcutsStore.getState().register({ id: "one", combo: "ctrl+k", action });
    useShortcutsStore.getState().register({ id: "two", combo: "ctrl+p", action });
    expect(useShortcutsStore.getState().setCombo("two", "ctrl+k")).toBe(false);
    expect(useShortcutsStore.getState().bindings.find((binding) => binding.id === "two")?.combo).toBe("ctrl+p");
    (window as Window & { __shortcutsBindings?: unknown }).__shortcutsBindings = [];
    (window as Window & { __shortcutsIsMac?: boolean }).__shortcutsIsMac = false;
    handleKeyDown(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(parseEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }), false)).toBe("ctrl+k");
    expect(parseEvent(new KeyboardEvent("keydown", { key: "ArrowUp", ctrlKey: true }), false)).toBe("ctrl+up");
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isEditableTarget(input)).toBe(true);
    document.addEventListener("keydown", handleKeyDown);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    document.removeEventListener("keydown", handleKeyDown);
    expect(action).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("replays and completes the onboarding tour", () => {
    useTourStore.getState().restart();
    expect(useTourStore.getState().active).toBe(true);
    for (let i = 0; i < TOUR_STEPS.length; i += 1) useTourStore.getState().next();
    expect(useTourStore.getState().active).toBe(false);
    expect(useTourStore.getState().dismissed).toBe(true);
  });
});

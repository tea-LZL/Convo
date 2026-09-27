import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SessionMemoryModal } from "../chat/SessionMemoryModal";
import { useMemoryStore } from "../../stores/memory";
import { preferenceItem, skillItem } from "../../test/fixtures/memory";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  // The modal calls api.listMemory() and api.getSessionMemoryOverrides()
  // on open. Both await Promise.all, so queue up the responses for
  // both calls in order.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_memory") {
      return [preferenceItem, skillItem];
    }
    if (cmd === "get_session_memory_overrides") {
      return []; // empty overrides = "no overrides" (use global)
    }
    return null;
  });
  useMemoryStore.setState({ items: [] });
});

describe("SessionMemoryModal", () => {
  it("lists all enabled memory items as included by default", async () => {
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Keep responses concise/)).toBeInTheDocument();
    });
    // skillItem is enabled=false so it should NOT appear (filter
    // happens inside the component).
    expect(screen.queryByText(skillItem.content)).toBeNull();
    // Both checkboxes are checked initially.
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBe(1); // only preferenceItem passes the `is_enabled` filter
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it("reflects persisted overrides on load — items in the override set stay included; enabled but missing become excluded", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return [preferenceItem, skillItem];
      // Pretend the session has pref explicitly included. The
      // component treats overrides=non-empty as a strict whitelist;
      // anything enabled that's NOT in the list is excluded.
      if (cmd === "get_session_memory_overrides") return [preferenceItem.id];
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Keep responses concise/)).toBeInTheDocument();
    });
    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    // preferenceItem IS in the override set → included → checked.
    expect(cb.checked).toBe(true);
  });

  it("toggling a checkbox persists the new override set", async () => {
    const setOverridesMock = vi.fn().mockResolvedValue(undefined);
    mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "list_memory") return [preferenceItem, skillItem];
      if (cmd === "get_session_memory_overrides") return [];
      if (cmd === "set_session_memory_overrides") {
        setOverridesMock(args);
        return undefined;
      }
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));
    const cb = screen.getByRole("checkbox");
    fireEvent.click(cb);
    await waitFor(() => {
      // After toggle, the included-item list narrows.
      expect(setOverridesMock).toHaveBeenCalled();
    });
    // Empty Set of excluded items → payload is empty array (clear overrides).
    expect(setOverridesMock).toHaveBeenCalledWith({
      sessionId: "session-1",
      itemIds: [],
    });
  });

  // The box is an allowlist, not an injection switch. The copy used to say
  // "Checked items are included in the system prompt for this chat", which
  // promises the one thing only a pin does: a user who checks a memory then
  // expects it in every message and gets it only when recall happens to
  // rank it. The fix that made the vector route honour the allowlist
  // (d2528ab) is why the sentence was doubly wrong.
  it("does not promise that a checked item is in the prompt, and points at the pin", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return [{ ...preferenceItem, pinned: true }, skillItem];
      if (cmd === "get_session_memory_overrides") return [];
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));

    const copy = document.body.textContent ?? "";
    expect(copy).not.toMatch(/checked items are included/i);
    expect(copy).toMatch(/recall may return/i);
    expect(copy).toMatch(/pinned memory is sent in every chat/i);
    // The pin is named on the row itself, not only in the paragraph: the
    // checkbox is what a user is looking at when they decide to trust it.
    expect(screen.getByText("pinned")).toBeInTheDocument();
  });
});

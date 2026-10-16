import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SessionMemoryModal } from "../chat/SessionMemoryModal";
import { useMemoryStore } from "../../stores/memory";
import { preferenceItem, skillItem } from "../../test/fixtures/memory";

const mockedInvoke = vi.mocked(invoke);

/** An untouched chat: every enabled memory is eligible. */
const UNSCOPED = { itemIds: [], configured: false };

/** The write a toggle sends, out of the mocked invoke. */
const writes = () =>
  mockedInvoke.mock.calls.filter(([cmd]) => cmd === "set_session_memory_overrides");

/** The payload of the last write. */
const lastWrite = () => (writes().at(-1)?.[1] ?? {}) as { itemIds: string[]; configured: boolean };

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
      return UNSCOPED; // never configured = no restriction
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
      // The chat is scoped, and preference is the one admitted item. The
      // component treats the scope as a strict allowlist: anything enabled
      // that's NOT in it is excluded.
      if (cmd === "get_session_memory_overrides") {
        return { itemIds: [preferenceItem.id], configured: true };
      }
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Keep responses concise/)).toBeInTheDocument();
    });
    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    // preference IS in the scope → included → checked.
    expect(cb.checked).toBe(true);
  });

  it("toggling a checkbox narrows the chat's scope to the remaining items", async () => {
    const both = [
      { ...preferenceItem, id: "pref-1" },
      { ...skillItem, id: "skill-1", is_enabled: true },
    ];
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return both;
      if (cmd === "get_session_memory_overrides") {
        return { itemIds: ["pref-1", "skill-1"], configured: true };
      }
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
    // Both are admitted, so both start checked.
    const [first] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(first.checked).toBe(true);

    fireEvent.click(first);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(lastWrite()).toEqual({
      sessionId: "session-1",
      itemIds: ["skill-1"],
      configured: true,
    });
  });

  // The bug this rewrite exists to end: the last box, unchecked, sent
  // `itemIds: []`, and an empty list meant "no restriction" all the way down
  // to the SQL. So unchecking everything handed the user the entire library
  // back — the exact opposite of the instruction they had just given, with
  // no error anywhere. The empty list is now sent as a *scope*, which the
  // database can tell apart from a chat that was never scoped.
  it("unchecking the last item restricts the chat to nothing instead of to everything", async () => {
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(lastWrite()).toEqual({ sessionId: "session-1", itemIds: [], configured: true });
  });

  // And the state has to say so, rather than leaving the user to infer
  // "no memory here" from a list of empty boxes.
  it("says when nothing is eligible rather than leaving the boxes to speak for it", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return [preferenceItem, skillItem];
      if (cmd === "get_session_memory_overrides") return { itemIds: [], configured: true };
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));
    expect(screen.getByText(/no memory is eligible for recall in this chat/i)).toBeInTheDocument();
  });

  // Checking everything back is the one gesture that means "no restriction",
  // so it clears the scope rather than storing a list of every id. This is
  // the answer the empty list has always meant, and it must keep meaning
  // it: it is every chat that has never touched the feature.
  it("re-checking every item clears the scope instead of storing a list of all of them", async () => {
    const both = [
      { ...preferenceItem, id: "pref-1" },
      { ...skillItem, id: "skill-1", is_enabled: true },
    ];
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return both;
      if (cmd === "get_session_memory_overrides") return { itemIds: [], configured: true };
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));

    const [first, second] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(first);
    await waitFor(() => expect(lastWrite().itemIds).toEqual(["pref-1"]));
    fireEvent.click(second);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(lastWrite()).toEqual({
      sessionId: "session-1",
      itemIds: [],
      configured: false,
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
      if (cmd === "get_session_memory_overrides") return UNSCOPED;
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

  // The case that copy has to survive: a pinned memory is injected whether
  // or not it is checked, because pinning is read from `memory_items.pinned`
  // on the assembly path and never passes through the session allowlist. So
  // unchecking a pinned row does not stop it being sent, and a user who
  // reads the boxes as a switch would be wrong about exactly that row.
  it("tells the user that unchecking a pinned memory does not stop it being sent", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return [{ ...preferenceItem, pinned: true }];
      if (cmd === "get_session_memory_overrides") return UNSCOPED;
      return null;
    });
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // The row is excluded — the scope is honoured — and the copy still says
    // the pin wins, because it does.
    expect(lastWrite()).toEqual({ sessionId: "session-1", itemIds: [], configured: true });
    const copy = document.body.textContent ?? "";
    expect(copy).toMatch(/pinned memory is sent in every chat whether it is checked here or not/i);
    expect(screen.getByText("pinned")).toHaveAttribute(
      "title",
      expect.stringContaining("whether it is checked here or not"),
    );
  });

  it("warns that scoping a chat to memories removes that chat's notes from recall", async () => {
    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => screen.getByText(/Keep responses concise/));

    const copy = document.body.textContent ?? "";
    expect(copy).toMatch(/removes.*notes from.*recall|notes.*removed from.*recall/i);
    expect(copy).toMatch(/memory ids only/i);
  });

  it("excludes superseded memories from the session scoping list and allowlist", async () => {
    const superseded = {
      ...preferenceItem,
      id: "superseded-1",
      title: "Old tone",
      content: "Write formal essays.",
      is_enabled: true,
      superseded_by: "mem-pref-1",
    };
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory") return [superseded, preferenceItem];
      if (cmd === "get_session_memory_overrides") return UNSCOPED;
      return null;
    });

    render(<SessionMemoryModal open onClose={() => {}} sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText(/Keep responses concise/)).toBeInTheDocument());

    expect(screen.queryByText("Old tone")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});

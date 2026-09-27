import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRoute } from "../MemoryRoute";

const sessions = Array.from({ length: 25 }, (_, index) => ({
  id: `session-${index}`,
  title: index === 24 ? "New Chat" : `Session ${index}`,
  snippet: `Preview ${index}`,
  messageCount: index + 1,
}));

describe("MemoryRoute", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "list_extractable_sessions") return sessions;
      return null;
    });
  });

  it("loads every persisted session with messages when Extract from chat opens", async () => {
    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));

    expect(await screen.findByText("New Chat")).toBeInTheDocument();
    expect(screen.getByText("25 messages · Preview 24")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_extractable_sessions");
    expect(invoke).not.toHaveBeenCalledWith("list_sessions", expect.anything());
  });

  it("shows loading before an empty result", async () => {
    let resolveSessions!: (value: unknown[]) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([]);
      if (command === "list_note_titles") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "list_extractable_sessions") {
        return new Promise((resolve) => { resolveSessions = resolve; });
      }
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /extract from chat/i }));
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();

    await act(async () => resolveSessions([]));
    await waitFor(() => expect(screen.getByText(/No sessions available/)).toBeInTheDocument());
  });

  it("restores review states and retries failures", async () => {
    const reviews = [
      { id: "pending", sessionId: "session-1", facts: [{ kind: "user_pref", title: null, content: "Fact", tags: null }], status: "pending", error: null, createdAt: "now" },
      { id: "failed", sessionId: "session-2", facts: [], status: "failed", error: "offline", createdAt: "now" },
      { id: "extracting", sessionId: "session-3", facts: [], status: "extracting", error: null, createdAt: "now" },
      { id: "reviewed", sessionId: "session-4", facts: [], status: "reviewed", error: null, createdAt: "now" },
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return reviews;
      if (command === "retry_memory_review") return "session-2";
      if (command === "extract_facts_from_session") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Pending (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extracting · Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pending (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mark_memory_review_reviewed", { id: "pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed · Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("retry_memory_review", { id: "failed" }));
    expect(invoke).toHaveBeenCalledWith("finish_memory_review", { id: "failed", facts: [] });
  });
});

// The pin is the only way back to the always-on set: since context assembly
// moved into Rust, an unpinned memory reaches the model only when retrieval
// ranks it. Nothing calling set_memory_pinned is the same dead command as
// `fill_index` — the tier exists in the schema and is unreachable from the UI.
describe("MemoryRoute pinning", () => {
  const memory = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: "user_pref",
    title: `Pref ${id}`,
    content: "Concise replies",
    tags: null,
    is_enabled: true,
    created_at: "now",
    updated_at: "now",
    pinned: false,
    ...overrides,
  });

  it("pins through set_memory_pinned and says so, separately from enabling", async () => {
    let pinned = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_memory") return [memory("m-1", { pinned })];
      if (command === "list_note_titles") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "set_memory_pinned") pinned = (args as { pinned: boolean }).pinned;
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    // Two controls, and the labels must not read alike. "Enabled" is
    // eligibility for recall; "pinned" is injection regardless of recall.
    const pin = await screen.findByRole("button", { name: /Pin Pref m-1 — always include it in every chat/ });
    const disable = screen.getByRole("button", { name: /Disable Pref m-1 — stop it being eligible for recall/ });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("title", expect.stringContaining("only when recall ranks it"));
    expect(disable).toHaveAttribute(
      "title",
      expect.stringContaining("a disabled memory is not injected even when pinned"),
    );

    fireEvent.click(pin);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_memory_pinned", { id: "m-1", pinned: true }));

    // The row says it is pinned, without a hover.
    const unpin = await screen.findByRole("button", { name: /Unpin Pref m-1/ });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("pinned")).toHaveAttribute(
      "title",
      expect.stringContaining("always included in every chat"),
    );

    // Enabling is a separate command, and the enable control is untouched.
    expect(invoke).not.toHaveBeenCalledWith("toggle_memory", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /Disable Pref m-1/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("toggle_memory", { id: "m-1", enabled: false }));
  });

  // The provenance labels are worth one call per refresh, not one per row —
  // and that call must not be `list_notes`, which answers with every note
  // body in the library. The refresh runs after every pin click, so a pasted
  // document was crossing the IPC boundary on every click of a button that
  // has nothing to do with notes.
  //
  // The assertion is one call per *refresh*, not "exactly one call ever". A
  // count pinned to a single cycle fails the moment a legitimate second
  // refresh is added — a stale-comment fix, a manual reload button — which
  // is an unrelated reason to fail and trains the reader to re-pin the
  // number. Tying the two call counts together is the property that was
  // actually wanted: the note projection costs one query per refresh, and
  // neither count moves with the number of rendered rows.
  it("resolves every row's source note once per refresh, not once per row", async () => {
    const rows = [memory("m-1"), memory("m-2"), memory("m-3")];
    let pinned = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_memory") return rows.map((row) => ({ ...row, pinned: pinned && row.id === "m-1" }));
      if (command === "list_memory_reviews") return [];
      if (command === "set_memory_pinned") pinned = (args as { pinned: boolean }).pinned;
      // m-1 and m-3 came from the same note; m-2 came from nowhere. Keyed by
      // memory id, so two notes and three rows are still one query.
      if (command === "list_note_titles") return [
        { id: "n-1", title: "Release notes", memory_ids: ["m-1", "m-3"] },
        { id: "n-2", title: "Roadmap", memory_ids: [] },
      ];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const calls = (command: string) =>
      vi.mocked(invoke).mock.calls.filter(([c]) => c === command).length;

    await waitFor(() => expect(screen.getAllByText(/from note: Release notes/)).toHaveLength(2));
    // The row with no source note is not labelled, and all three rows are up.
    expect(screen.getAllByRole("button", { name: /^(Pin|Unpin) Pref m-2/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^(Pin|Unpin) Pref m-/ })).toHaveLength(3);
    // Three rows, one call: a per-row lookup would be three.
    expect(calls("list_note_titles")).toBe(calls("list_memory"));
    expect(calls("list_note_titles")).toBe(1);

    // A second refresh costs a second call — one per cycle — and the counts
    // stay locked together, so neither scales with the rows on screen.
    fireEvent.click(screen.getByRole("button", { name: /Pin Pref m-1/ }));
    await waitFor(() => expect(calls("list_memory")).toBe(2));
    expect(calls("list_note_titles")).toBe(calls("list_memory"));
    expect(calls("list_note_titles")).toBe(2);

    // The bodies stay in the database. A route that reached for
    // `list_notes` here would render identically and cost megabytes.
    expect(invoke).not.toHaveBeenCalledWith("list_notes", expect.anything());
  });

  it("still renders the list when the note projection fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [memory("m-1")];
      if (command === "list_memory_reviews") return [];
      if (command === "list_note_titles") throw new Error("notes offline");
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    // Provenance is decoration; a note library that will not load must not
    // cost the list it decorates.
    expect(await screen.findByRole("button", { name: /Pin Pref m-1/ })).toBeInTheDocument();
    expect(screen.queryByText(/from note:/)).not.toBeInTheDocument();
  });
});


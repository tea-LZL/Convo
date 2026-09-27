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
      if (command === "list_notes") return [];
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
      if (command === "list_notes") return Promise.resolve([]);
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
      if (command === "list_notes") return [];
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
      if (command === "list_notes") return [];
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

  it("resolves every row's source note in one call, not one per row", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [memory("m-1"), memory("m-2"), memory("m-3")];
      if (command === "list_memory_reviews") return [];
      // m-1 and m-3 came from the same note; m-2 came from nowhere. Keyed by
      // memory id, so two notes and three rows are still one query.
      if (command === "list_notes") return [{
        note: { id: "n-1", title: "Release notes", body: "", tags: null, source_session_id: null, source_message_id: null, created_at: "now", updated_at: "now", pinned: false },
        linked_memories: [
          { id: "m-1", title: "Pref m-1", content: "Concise replies", is_enabled: true, superseded_by: null },
          { id: "m-3", title: "Pref m-3", content: "Concise replies", is_enabled: true, superseded_by: null },
        ],
      }];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText(/from note: Release notes/)).toHaveLength(2));
    // The row with no source note is not labelled, and the query that
    // resolves the labels is not issued per row.
    expect(screen.getAllByRole("button", { name: /^(Pin|Unpin) Pref m-2/ })).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_notes")).toHaveLength(1);
  });
});


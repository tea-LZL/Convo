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

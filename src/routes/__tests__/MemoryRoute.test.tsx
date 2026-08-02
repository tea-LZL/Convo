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
});

/**
 * The welcome screen's New conversation creates a session and navigates to
 * it before the store marks it active. ChatRoute used to read that gap as
 * "this session is gone" and bounce straight back to /chat, so the button
 * looked like it did nothing. These tests pin both answers: switch to the
 * session that was just created, and return to the welcome screen only when
 * a session genuinely does not exist.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../lib/api";
import { useSessionsStore } from "../../stores/sessions";
import { ChatRoute } from "../ChatRoute";

vi.mock("../../components/chat/ChatViewNew", () => ({
  ChatViewNew: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-view">{sessionId}</div>
  ),
}));

const SESSION = {
  id: "s-1",
  title: "New chat",
  model_id: null,
  provider_id: null,
  group_id: null,
  is_pinned: false,
  is_archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const PROVIDER = {
  id: "p-1",
  name: "Ollama",
  kind: "ollama",
  base_url: "http://localhost:11434",
  is_default: true,
};

function renderApp(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<ChatRoute />} />
          <Route path="/chat/:sessionId" element={<ChatRoute />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("ChatRoute — the welcome screen's New conversation", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false, error: null });
    vi.spyOn(api, "listProviders").mockResolvedValue([PROVIDER] as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("switches to the newly created session instead of bouncing to the welcome screen", async () => {
    const sessions: Array<typeof SESSION> = [];
    // A real listSessions is a Tauri IPC round-trip, not a resolved promise.
    // The delay is the whole point of the test: the old code relied on the
    // route effect setting `activeId` after this resolved, and StrictMode
    // cancels that effect the moment the URL-sync bounce fires.
    vi.spyOn(api, "listSessions").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sessions as never;
    });
    vi.spyOn(api, "createSession").mockImplementation(async () => {
      sessions.push(SESSION);
      return SESSION as never;
    });

    renderApp("/chat");

    // The welcome screen is up and the create action is real.
    const button = await screen.findByRole("button", { name: /new conversation/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("chat-view")).toBeInTheDocument());
    expect(screen.getByTestId("chat-view")).toHaveTextContent("s-1");
    expect(screen.queryByRole("button", { name: /new conversation/i })).not.toBeInTheDocument();
  });

  it("returns to the welcome screen when the URL names a session that does not exist", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([] as never);

    renderApp("/chat/gone");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("chat-view")).not.toBeInTheDocument();
  });
});

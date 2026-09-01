import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRoute } from "../MemoryRoute";
import { factItem, preferenceItem } from "../../test/fixtures/memory";
import { useToastStore } from "../../stores/toasts";
import { useMemoryStore } from "../../stores/memory";

const mockedInvoke = vi.mocked(invoke);

const sessions = Array.from({ length: 25 }, (_, index) => ({
  id: `session-${index}`,
  title: index === 24 ? "New Chat" : `Session ${index}`,
  snippet: `Preview ${index}`,
  messageCount: index + 1,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("MemoryRoute", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useMemoryStore.setState({ reviews: [] });
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

  it("shows library loading before the empty state", async () => {
    const memoryResolvers: Array<(value: unknown[]) => void> = [];
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") {
        return new Promise<unknown[]>((resolve) => memoryResolvers.push(resolve));
      }
      if (command === "list_memory_reviews") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading memory items");
    expect(screen.queryByText("No memories yet")).not.toBeInTheDocument();

    await waitFor(() => expect(memoryResolvers).toHaveLength(2));
    await act(async () => {
      memoryResolvers.forEach((resolve) => resolve([]));
    });
  });

  it("shows a library failure with retry and recovers", async () => {
    let listMemoryCalls = 0;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") {
        listMemoryCalls += 1;
        if (listMemoryCalls === 1) throw new Error("memory store unavailable");
        if (listMemoryCalls === 2) return [];
        return [preferenceItem];
      }
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load memory items");
    expect(alert).toHaveTextContent("memory store unavailable");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText(preferenceItem.title ?? "")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("ignores an older memory search response after the query changes", async () => {
    const oldResult = { ...preferenceItem, id: "old-search", title: "Old result" };
    const newResult = { ...preferenceItem, id: "new-search", title: "New result" };
    const searchRequests: Deferred<unknown[]>[] = [];
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "search_memory") {
        const request = deferred<unknown[]>();
        searchRequests.push(request);
        return request.promise;
      }
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const input = screen.getByRole("textbox", { name: "Search memory" });
    fireEvent.change(input, { target: { value: "old query" } });
    await waitFor(() => expect(searchRequests).toHaveLength(1));

    fireEvent.change(input, { target: { value: "new query" } });
    await waitFor(() => expect(searchRequests).toHaveLength(2));

    await act(async () => {
      searchRequests[1].resolve([{ item: newResult, snippet: "new match" }]);
    });
    expect(await screen.findByText("New result")).toBeInTheDocument();

    await act(async () => {
      searchRequests[0].resolve([{ item: oldResult, snippet: "old match" }]);
    });
    await waitFor(() => {
      expect(screen.getByText("New result")).toBeInTheDocument();
      expect(screen.queryByText("Old result")).not.toBeInTheDocument();
    });
  });

  it("keeps an active search result when clicking the already-selected filter", async () => {
    const searchItem = { ...preferenceItem, id: "active-filter-search", title: "Active filter result" };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "search_memory") return [{ item: searchItem, snippet: "active match" }];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "active" },
    });
    expect(await screen.findByText("Active filter result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));

    expect(screen.getByText("Active filter result")).toBeInTheDocument();
    expect(screen.queryByText("Searching memory…")).not.toBeInTheDocument();
  });

  it("ignores an older memory search response after the filter changes", async () => {
    const oldResult = { ...preferenceItem, id: "old-filter-search", title: "Old filter result" };
    const newResult = { ...preferenceItem, id: "new-filter-search", title: "New filter result" };
    const searchRequests: Deferred<unknown[]>[] = [];
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "search_memory") {
        const request = deferred<unknown[]>();
        searchRequests.push(request);
        return request.promise;
      }
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "same query" },
    });
    await waitFor(() => expect(searchRequests).toHaveLength(1));

    fireEvent.click(screen.getByRole("tab", { name: "Preferences" }));
    await waitFor(() => expect(searchRequests).toHaveLength(2));
    await act(async () => {
      searchRequests[1].resolve([{ item: newResult, snippet: "new filter match" }]);
    });
    expect(await screen.findByText("New filter result")).toBeInTheDocument();

    await act(async () => {
      searchRequests[0].resolve([{ item: oldResult, snippet: "old filter match" }]);
    });
    await waitFor(() => {
      expect(screen.getByText("New filter result")).toBeInTheDocument();
      expect(screen.queryByText("Old filter result")).not.toBeInTheDocument();
    });
  });

  it("shows memory search failures with a retry action", async () => {
    let searchAttempts = 0;
    const result = { ...preferenceItem, id: "search-retry", title: "Recovered result" };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [];
      if (command === "search_memory") {
        searchAttempts += 1;
        if (searchAttempts === 1) throw new Error("search backend unavailable");
        return [{ item: result, snippet: "recovered match" }];
      }
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "recover" },
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not search memory");
    expect(alert).toHaveTextContent("search backend unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("Recovered result")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(searchAttempts).toBe(2);
    });
  });

  it("revalidates an active memory search after a mutation refresh", async () => {
    const searchItem = { ...preferenceItem, id: "search-item", title: "Search result" };
    const refreshedItem = { ...factItem, id: "refreshed-item", title: "Unmatched refresh item" };
    let listMemoryCalls = 0;
    let searchCalls = 0;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") {
        listMemoryCalls += 1;
        return listMemoryCalls <= 2 ? [searchItem] : [refreshedItem];
      }
      if (command === "list_memory_reviews") return [];
      if (command === "search_memory") {
        searchCalls += 1;
        return [{ item: searchItem, snippet: "active match" }];
      }
      if (command === "toggle_memory" || command === "get_enabled_memory") return null;
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "active" },
    });
    await waitFor(() => expect(searchCalls).toBe(1));
    expect(screen.getByText("Search result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disable Search result" }));
    await waitFor(() => expect(searchCalls).toBe(2));
    expect(screen.getByText("Search result")).toBeInTheDocument();
    expect(screen.queryByText("Unmatched refresh item")).not.toBeInTheDocument();
  });

  it("keeps overlapping unfiltered recall refreshes on the newest result and loading state", async () => {
    const olderItem = { ...preferenceItem, id: "older-recall", title: "Older recall", content: "Older recall result" };
    const latestItem = { ...preferenceItem, id: "latest-recall", title: "Latest recall", content: "Latest recall result" };
    const newestItem = { ...preferenceItem, id: "newest-recall", title: "Newest recall", content: "Newest recall result" };
    const recallRequests: Deferred<unknown[]>[] = [];
    let listMemoryCalls = 0;

    mockedInvoke.mockImplementation((command, args) => {
      if (command === "list_memory") {
        listMemoryCalls += 1;
        const kind = (args as { kind?: string | null } | undefined)?.kind;
        if (listMemoryCalls % 2 === 1) return Promise.resolve([]);
        expect(kind).toBeNull();
        const request = deferred<unknown[]>();
        recallRequests.push(request);
        return request.promise;
      }
      if (command === "list_memory_reviews") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Preferences" }));
    await waitFor(() => expect(recallRequests).toHaveLength(2));

    await act(async () => {
      recallRequests[1].resolve([latestItem]);
    });

    fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
    const dialog = await screen.findByRole("dialog", { name: /test recall/i });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
      target: { value: "recall" },
    });
    expect(await within(dialog).findByTestId("recall-result-latest-recall")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("recall-result-older-recall")).not.toBeInTheDocument();

    await act(async () => {
      recallRequests[0].resolve([olderItem]);
    });
    await waitFor(() => {
      expect(within(dialog).getByTestId("recall-result-latest-recall")).toBeInTheDocument();
      expect(within(dialog).queryByTestId("recall-result-older-recall")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => expect(recallRequests).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(recallRequests).toHaveLength(4));

    await act(async () => {
      recallRequests[2].resolve([{ ...preferenceItem, id: "stale-recall", title: "Stale recall", content: "Stale recall result" }]);
    });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading memory items");
    expect(within(dialog).queryByTestId("recall-result-stale-recall")).not.toBeInTheDocument();

    await act(async () => {
      recallRequests[3].resolve([newestItem]);
    });
    await waitFor(() => {
      expect(within(dialog).getByTestId("recall-result-newest-recall")).toBeInTheDocument();
      expect(within(dialog).queryByTestId("recall-result-stale-recall")).not.toBeInTheDocument();
      expect(within(dialog).queryByTestId("recall-result-older-recall")).not.toBeInTheDocument();
    });
  });

  it("refreshes a deferred mutation using the current kind after switching tabs", async () => {
    const toggleCompletion = deferred<null>();
    const libraryKinds: string[] = [];
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "list_memory") {
        const kind = (args as { kind?: string | null } | undefined)?.kind ?? null;
        if (kind) libraryKinds.push(kind);
        if (kind === "user_pref") return Promise.resolve([preferenceItem]);
        if (kind === "project_fact") return Promise.resolve([factItem]);
        return Promise.resolve([preferenceItem, factItem]);
      }
      if (command === "toggle_memory") return toggleCompletion.promise;
      if (command === "get_enabled_memory") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Preferences" }));
    expect(await screen.findByText("Tone")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disable Tone" }));
    fireEvent.click(screen.getByRole("tab", { name: "Project facts" }));
    await waitFor(() => {
      expect(screen.getByText("Stack")).toBeInTheDocument();
      expect(libraryKinds.at(-1)).toBe("project_fact");
    });

    await act(async () => {
      toggleCompletion.resolve(null);
    });

    await waitFor(() => {
      expect(screen.getByText("Stack")).toBeInTheDocument();
      expect(screen.queryByText("Tone")).not.toBeInTheDocument();
      expect(libraryKinds.at(-1)).toBe("project_fact");
    });
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
      if (command === "retry_memory_review") {
        return { reviewId: "failed", attempt: 2, sessionId: "session-2" };
      }
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
    fireEvent.click(screen.getByRole("button", { name: "Show history" }));
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pending (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mark_memory_review_reviewed", { id: "pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed · Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("retry_memory_review", { id: "failed" }));
    expect(invoke).toHaveBeenCalledWith("finish_memory_review", { id: "failed", attempt: 2, facts: [] });
  });

  it("shows retry failures through the toast path", async () => {
    const reviews = [
      { id: "failed", sessionId: "session-2", facts: [], status: "failed", error: "offline", createdAt: "now" },
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return reviews;
      if (command === "retry_memory_review") throw new Error("Review extraction is still in progress");
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Failed · Retry" }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variant: "error",
            message: expect.stringContaining("still in progress"),
          }),
        ]),
      );
    });
  });

  it("prevents duplicate retry clicks while a retry is in flight", async () => {
    const reviews = [
      { id: "failed", sessionId: "session-2", facts: [], status: "failed", error: "offline", createdAt: "now" },
    ];
    let resolveRetry!: (value: unknown) => void;
    const retryPromise = new Promise((resolve) => { resolveRetry = resolve; });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return reviews;
      if (command === "retry_memory_review") return retryPromise;
      if (command === "extract_facts_from_session") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const retryButton = await screen.findByRole("button", { name: "Failed · Retry" });
    fireEvent.click(retryButton);
    await waitFor(() => expect(retryButton).toBeDisabled());
    fireEvent.click(retryButton);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "retry_memory_review")).toHaveLength(1);

    await act(async () => {
      resolveRetry({ reviewId: "failed", attempt: 2, sessionId: "session-2" });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("finish_memory_review", { id: "failed", attempt: 2, facts: [] }));
  });

  it("handles empty and unmatched recall queries and returns focus on close", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [preferenceItem];
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: /test recall/i });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /test recall/i });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Enter a query");

    const input = within(dialog).getByRole("textbox", { name: /recall query/i });
    fireEvent.change(input, { target: { value: "unrelated vocabulary" } });
    expect(await within(dialog).findByText("No memories would be recalled")).toBeInTheDocument();
    expect(within(dialog).getByText("No enabled memories match this query.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "Recall block preview" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /test recall/i })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("tests identity recall without invoking a provider and hides disabled memories", async () => {
    const nickname = {
      ...preferenceItem,
      id: "nickname",
      title: "User nickname",
      content: "The user's nickname is Kevin.",
    };
    const disabled = {
      ...nickname,
      id: "disabled-name",
      title: "Disabled name",
      content: "The user's nickname is Hidden.",
      is_enabled: false,
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [nickname, disabled];
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
    const dialog = await screen.findByRole("dialog", { name: /test recall/i });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
      target: { value: "what is my name?" },
    });

    expect(await within(dialog).findByText("User nickname")).toBeInTheDocument();
    expect(within(dialog).getByText(/score:\s*4/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/reason:.*title match/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/matched terms:.*nickname/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Would be recalled")).toBeInTheDocument();
    expect(within(dialog).queryByText("Disabled name")).not.toBeInTheDocument();
    expect((within(dialog).getByRole("textbox", { name: "Recall block preview" }) as HTMLTextAreaElement).value)
      .toContain("The user's nickname is Kevin.");
    expect(within(dialog).getByRole("button", { name: "Copy recall block" })).toBeEnabled();
    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);
  });

  it("tests recall against all enabled kinds while the memory library is filtered", async () => {
    const projectFact = {
      ...preferenceItem,
      id: "project-stack",
      kind: "project_fact" as const,
      title: "Project stack",
      content: "This project uses React and Tauri.",
    };
    const disabled = {
      ...projectFact,
      id: "disabled-stack",
      title: "Hidden project stack",
      content: "This project uses a hidden stack.",
      is_enabled: false,
    };
    const allItems = [preferenceItem, projectFact, disabled];

    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "list_memory") {
        const kind = (args as { kind?: string | null } | undefined)?.kind;
        return kind === "user_pref" ? [preferenceItem] : allItems;
      }
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Preferences" }));
    await waitFor(() => expect(screen.queryByText("Project stack")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
    const dialog = await screen.findByRole("dialog", { name: /test recall/i });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
      target: { value: "what stack does this project use?" },
    });

    expect(await within(dialog).findByText("Project stack")).toBeInTheDocument();
    expect(within(dialog).queryByText("Hidden project stack")).not.toBeInTheDocument();
  });

  it("shows the identity fallback indicator for a self-identity query", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [preferenceItem];
      if (command === "list_memory_reviews") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
    const dialog = await screen.findByRole("dialog", { name: /test recall/i });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
      target: { value: "what is my name?" },
    });

    expect(await within(dialog).findByText("Identity fallback")).toBeInTheDocument();
    expect(within(dialog).getByText("Tone")).toBeInTheDocument();
  });

  it("copies the recall preview and reports success", async () => {
    const nickname = {
      ...preferenceItem,
      id: "nickname-copy",
      title: "User nickname",
      content: "The user's nickname is Kevin.",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [nickname];
      if (command === "list_memory_reviews") return [];
      return null;
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    try {
      render(
        <MemoryRouter>
          <MemoryRoute />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
      const dialog = await screen.findByRole("dialog", { name: /test recall/i });
      fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
        target: { value: "what is my name?" },
      });
      const copyButton = await within(dialog).findByRole("button", { name: "Copy recall block" });
      fireEvent.click(copyButton);

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(nickname.content)));
      expect(await within(dialog).findByText("Copied")).toBeInTheDocument();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("reports clipboard failures without hiding the recall preview", async () => {
    const nickname = {
      ...preferenceItem,
      id: "nickname-copy-error",
      title: "User nickname",
      content: "The user's nickname is Kevin.",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [nickname];
      if (command === "list_memory_reviews") return [];
      return null;
    });
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    try {
      render(
        <MemoryRouter>
          <MemoryRoute />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole("button", { name: /test recall/i }));
      const dialog = await screen.findByRole("dialog", { name: /test recall/i });
      fireEvent.change(within(dialog).getByRole("textbox", { name: /recall query/i }), {
        target: { value: "what is my name?" },
      });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Copy recall block" }));

      expect(await within(dialog).findByText("Clipboard is unavailable. Select the preview text to copy it manually.")).toBeInTheDocument();
      expect(within(dialog).getByRole("textbox", { name: "Recall block preview" })).toBeInTheDocument();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("prioritizes actionable review rows and hides reviewed history until requested", async () => {
    const reviews = [
      { id: "reviewed", sessionId: "session-reviewed", facts: [], status: "reviewed", error: null, createdAt: "now" },
      { id: "pending", sessionId: "session-pending", facts: [{ kind: "user_pref", title: "Pending fact", content: "Pending content", tags: null }], status: "pending", error: null, createdAt: "now" },
      { id: "failed", sessionId: "session-failed", facts: [], status: "failed", error: "offline", createdAt: "now" },
      { id: "extracting", sessionId: "session-extracting", facts: [], status: "extracting", error: null, createdAt: "now" },
    ];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return reviews;
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    const queue = await screen.findByRole("region", { name: "Memory review queue" });
    const pending = within(queue).getByRole("button", { name: "Pending (1)" });
    const failed = within(queue).getByRole("button", { name: "Failed · Retry" });
    const extracting = within(queue).getByRole("button", { name: "Extracting · Retry" });
    expect(within(queue).queryByRole("button", { name: "Reviewed" })).not.toBeInTheDocument();
    expect(within(queue).getByRole("button", { name: "Show history" })).toBeInTheDocument();

    fireEvent.click(within(queue).getByRole("button", { name: "Show history" }));
    const reviewed = within(queue).getByRole("button", { name: "Reviewed" });
    expect(pending.compareDocumentPosition(reviewed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(failed.compareDocumentPosition(reviewed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extracting.compareDocumentPosition(reviewed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lets reviewers edit candidate fields and leaves exact persisted duplicates unselected", async () => {
    const persisted = { ...preferenceItem, content: "Keep replies concise." };
    const review = {
      id: "review-edit",
      sessionId: "session-edit",
      facts: [
        { kind: "user_pref", title: "Duplicate candidate", content: " keep   replies concise. ", tags: "old" },
        { kind: "user_pref", title: "Near match", content: "Keep replies concise!", tags: "near" },
        { kind: "project_fact", title: "New fact", content: "This is new.", tags: null },
      ],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [persisted];
      if (command === "list_memory_reviews") return [review];
      if (command === "upsert_memory") return "saved-id";
      if (command === "get_enabled_memory") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (3)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    expect(within(dialog).getByText("Already saved")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 1" })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 2" })).toBeChecked();

    fireEvent.change(within(dialog).getByLabelText("Kind for candidate 2"), { target: { value: "skill" } });
    fireEvent.change(within(dialog).getByLabelText("Title for candidate 2"), { target: { value: "Edited skill" } });
    fireEvent.change(within(dialog).getByLabelText("Content for candidate 2"), { target: { value: "Edited instruction" } });
    fireEvent.change(within(dialog).getByLabelText("Tags for candidate 2"), { target: { value: "edited,review" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save 2" }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
      item: expect.objectContaining({
        kind: "skill",
        title: "Edited skill",
        content: "Edited instruction",
        tags: "edited,review",
      }),
    }));
    expect(mockedInvoke).not.toHaveBeenCalledWith("upsert_memory", expect.objectContaining({
      item: expect.objectContaining({ content: " keep   replies concise. " }),
    }));
  });

  it("labels duplicate candidates and keeps only the first equivalent candidate selectable", async () => {
    const review = {
      id: "review-candidate-duplicates",
      sessionId: "session-candidate-duplicates",
      facts: [
        { kind: "user_pref", title: "First copy", content: " Keep   replies concise. ", tags: null },
        { kind: "user_pref", title: "Second copy", content: "keep replies concise.", tags: null },
        { kind: "project_fact", title: "New fact", content: "The project uses Tauri.", tags: null },
      ],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      if (command === "upsert_memory") return "saved-id";
      if (command === "get_enabled_memory") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (3)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    expect(within(dialog).getByText("Duplicate candidate")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 1" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 2" })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 3" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Save 2" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save 2" }));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
        item: expect.objectContaining({ content: " Keep   replies concise. " }),
      });
      expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
        item: expect.objectContaining({ content: "The project uses Tauri." }),
      });
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("upsert_memory", {
      item: expect.objectContaining({ content: "keep replies concise." }),
    });
  });

  it("filters a candidate that becomes a duplicate after editing", async () => {
    const review = {
      id: "review-edited-duplicate",
      sessionId: "session-edited-duplicate",
      facts: [
        { kind: "user_pref", title: "First", content: "First preference.", tags: null },
        { kind: "user_pref", title: "Second", content: "Second preference.", tags: null },
      ],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      if (command === "upsert_memory") return "saved-id";
      if (command === "get_enabled_memory") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (2)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    fireEvent.change(within(dialog).getByLabelText("Content for candidate 2"), {
      target: { value: "First preference." },
    });
    expect(within(dialog).getByRole("button", { name: "Save 1" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review extracted facts" })).not.toBeInTheDocument());
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "upsert_memory")).toHaveLength(1);
    expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
      item: expect.objectContaining({ content: "First preference." }),
    });
  });

  it("waits for the full memory set before allowing review acceptance", async () => {
    const fullMemoryRequest = deferred<unknown[]>();
    const review = {
      id: "review-full-memory-loading",
      sessionId: "session-full-memory-loading",
      facts: [{ kind: "user_pref", title: "New candidate", content: "A new memory.", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    let listMemoryCalls = 0;
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") {
        listMemoryCalls += 1;
        return listMemoryCalls === 1 ? Promise.resolve([]) : fullMemoryRequest.promise;
      }
      if (command === "list_memory_reviews") return Promise.resolve([review]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Checking saved memory");
    expect(within(dialog).getByRole("button", { name: "Save 1" })).toBeDisabled();

    await act(async () => {
      fullMemoryRequest.resolve([]);
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save 1" })).toBeEnabled());
  });

  it("keeps review acceptance disabled and actionable when the full memory set fails", async () => {
    const fullMemoryRequest = deferred<unknown[]>();
    const review = {
      id: "review-full-memory-error",
      sessionId: "session-full-memory-error",
      facts: [{ kind: "user_pref", title: "New candidate", content: "A new memory.", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    let listMemoryCalls = 0;
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") {
        listMemoryCalls += 1;
        if (listMemoryCalls === 1) return Promise.resolve([]);
        if (listMemoryCalls === 2) return fullMemoryRequest.promise;
        return Promise.resolve([]);
      }
      if (command === "list_memory_reviews") return Promise.resolve([review]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    await act(async () => {
      fullMemoryRequest.reject(new Error("full memory unavailable"));
    });

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Could not check saved memory");
    expect(alert).toHaveTextContent("full memory unavailable");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Save 1" })).toBeDisabled();
  });

  it("prevents concurrent Save, duplicate Save, and Discard review actions", async () => {
    const upsertRequest = deferred<unknown>();
    const review = {
      id: "review-action-race",
      sessionId: "session-action-race",
      facts: [{ kind: "user_pref", title: "Action race", content: "A valid candidate.", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    let markCalls = 0;
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([]);
      if (command === "list_memory_reviews") return Promise.resolve([review]);
      if (command === "upsert_memory") return upsertRequest.promise;
      if (command === "get_enabled_memory") return Promise.resolve([]);
      if (command === "mark_memory_review_reviewed") {
        markCalls += 1;
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    const save = within(dialog).getByRole("button", { name: "Save 1" });
    const discard = within(dialog).getByRole("button", { name: "Discard all" });
    fireEvent.click(save);
    await waitFor(() => {
      expect(save).toBeDisabled();
      expect(discard).toBeDisabled();
    });
    fireEvent.click(save);
    fireEvent.click(discard);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "upsert_memory")).toHaveLength(1);
    expect(markCalls).toBe(0);

    await act(async () => {
      upsertRequest.resolve("saved-id");
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review extracted facts" })).not.toBeInTheDocument());
    expect(markCalls).toBe(1);
  });

  it("rejects whitespace-only review content and retains the selected draft", async () => {
    const review = {
      id: "review-whitespace-content",
      sessionId: "session-whitespace-content",
      facts: [{ kind: "user_pref", title: "Empty content", content: " \n\t ", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1" }));

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "warn", message: expect.stringContaining("empty content") }),
      ]),
    ));
    expect(mockedInvoke.mock.calls.some(([command]) => command === "upsert_memory")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Review extracted facts" })).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Select candidate 1" })).toBeChecked();
  });

  it("rejects unsupported review candidate kinds without sending them to persistence", async () => {
    const review = {
      id: "review-unsupported-kind",
      sessionId: "session-unsupported-kind",
      facts: [{ kind: "unsupported_kind", title: "Unsupported", content: "Valid content.", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1" }));

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "warn", message: expect.stringContaining("unsupported kind") }),
      ]),
    ));
    expect(mockedInvoke.mock.calls.some(([command]) => command === "upsert_memory")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Review extracted facts" })).toBeInTheDocument();
  });

  it("focuses the Skills view after accepting a skill candidate", async () => {
    const review = {
      id: "review-skill",
      sessionId: "session-skill",
      facts: [{ kind: "skill", title: "Review skill", content: "Use the project conventions.", tags: "workflow" }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      if (command === "upsert_memory") return "skill-id";
      if (command === "get_enabled_memory") return [];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true"));
  });

  it("keeps the source-chat action on the session route", async () => {
    const review = {
      id: "review-source",
      sessionId: "source-session",
      facts: [{ kind: "project_fact", title: "Source fact", content: "From the source chat.", tags: null }],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open source chat" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/chat/source-session");
  });

  it("retains the candidate draft and selection when saving a review fails", async () => {
    const review = {
      id: "review-save-error",
      sessionId: "session-save-error",
      facts: [
        { kind: "user_pref", title: "Keep me", content: "Original content", tags: "original" },
        { kind: "project_fact", title: "Do not save", content: "Second candidate", tags: null },
      ],
      status: "pending",
      error: null,
      createdAt: "now",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_memory") return [];
      if (command === "list_memory_reviews") return [review];
      if (command === "upsert_memory") throw new Error("review save failed");
      return null;
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pending (2)" }));
    const dialog = await screen.findByRole("dialog", { name: "Review extracted facts" });
    const firstSelection = within(dialog).getByRole("checkbox", { name: "Select candidate 1" });
    const secondSelection = within(dialog).getByRole("checkbox", { name: "Select candidate 2" });
    fireEvent.click(secondSelection);
    fireEvent.change(within(dialog).getByLabelText("Content for candidate 1"), { target: { value: "Draft retained" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1" }));

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "error", message: expect.stringContaining("review save failed") }),
      ]),
    ));
    expect(screen.getByRole("dialog", { name: "Review extracted facts" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Content for candidate 1")).toHaveValue("Draft retained");
    expect(firstSelection).toBeChecked();
    expect(secondSelection).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Save 1" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Discard all" })).toBeEnabled();
    expect(mockedInvoke).not.toHaveBeenCalledWith("mark_memory_review_reviewed", { id: "review-save-error" });
  });

  it("blocks memory editor fields and dismissal while saving", async () => {
    const saveRequest = deferred<unknown>();
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([preferenceItem]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "upsert_memory") return saveRequest.promise;
      if (command === "get_enabled_memory") return Promise.resolve([preferenceItem]);
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Tone" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit memory" });
    const title = within(dialog).getByLabelText("Title (optional)");
    const content = within(dialog).getByLabelText("Content");
    const tags = within(dialog).getByLabelText("Tags (comma-separated)");
    const enabled = within(dialog).getByRole("checkbox", { name: "Include in chat context" });

    fireEvent.change(content, { target: { value: "Draft while saving" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
        item: expect.objectContaining({ id: preferenceItem.id, content: "Draft while saving" }),
      });
      expect(title).toBeDisabled();
      expect(content).toBeDisabled();
      expect(tags).toBeDisabled();
      expect(enabled).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    });

    fireEvent.change(content, { target: { value: "Changed after save started" } });
    expect(content).toHaveValue("Draft while saving");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = document.querySelector(".overlay-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(screen.getByRole("dialog", { name: "Edit memory" })).toBeInTheDocument();

    await act(async () => {
      saveRequest.resolve("saved-id");
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit memory" })).not.toBeInTheDocument());
  });

  it("retains the memory editor draft when saving fails", async () => {
    const saveRequest = deferred<unknown>();
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_memory") return Promise.resolve([preferenceItem]);
      if (command === "list_memory_reviews") return Promise.resolve([]);
      if (command === "upsert_memory") return saveRequest.promise;
      return Promise.resolve(null);
    });

    render(
      <MemoryRouter>
        <MemoryRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Tone" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit memory" });
    const title = within(dialog).getByLabelText("Title (optional)");
    const content = within(dialog).getByLabelText("Content");
    fireEvent.change(title, { target: { value: "Draft title" } });
    fireEvent.change(content, { target: { value: "Draft retained after failure" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("upsert_memory", {
      item: expect.objectContaining({
        id: preferenceItem.id,
        title: "Draft title",
        content: "Draft retained after failure",
      }),
    }));
    await act(async () => {
      saveRequest.reject(new Error("memory save failed"));
    });

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "error", message: expect.stringContaining("memory save failed") }),
      ]),
    ));
    expect(screen.getByRole("dialog", { name: "Edit memory" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Title (optional)")).toHaveValue("Draft title");
    expect(within(dialog).getByLabelText("Content")).toHaveValue("Draft retained after failure");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

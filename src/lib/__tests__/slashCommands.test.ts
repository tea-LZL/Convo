import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expandCommandBody,
  filterCommands,
  findCommand,
  parseCommand,
  runCommand,
  SLASH_COMMANDS,
} from "../slashCommands";
import { api } from "../api";
import { toast } from "../../stores/toasts";
import { useSessionsStore } from "../../stores/sessions";
import { useSlashCommandsStore } from "../../stores/slashCommands";

vi.mock("../api", () => ({
  api: {
    getSearchConfig: vi.fn(),
    webSearch: vi.fn(),
    upsertNote: vi.fn(),
    upsertTask: vi.fn(),
    listSlashCommands: vi.fn(),
  },
}));

vi.mock("../../stores/toasts", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const mockedToast = vi.mocked(toast);

beforeEach(() => {
  useSlashCommandsStore.setState({
    commands: [],
    loaded: false,
    loading: false,
    error: null,
  });
});

describe("parseCommand", () => {
  it.each([
    { input: "/help", expected: { name: "help", args: "", raw: "/help" } },
    { input: "/search foo bar", expected: { name: "search", args: "foo bar", raw: "/search foo bar" } },
    { input: "  /model   gpt-4  ", expected: { name: "model", args: "  gpt-4", raw: "/model   gpt-4" } },
  ])("parses $input", ({ input, expected }) => {
    expect(parseCommand(input)).toEqual(expected);
  });

  it("returns null for input without a leading slash", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseCommand("")).toBeNull();
  });

  it("lowercases command names", () => {
    expect(parseCommand("/HELP")).toEqual({ name: "help", args: "", raw: "/HELP" });
  });
});

describe("findCommand", () => {
  it("finds an existing command", () => {
    expect(findCommand("help")?.name).toBe("help");
  });

  it("returns undefined for unknown commands", () => {
    expect(findCommand("nope")).toBeUndefined();
  });
});

describe("filterCommands", () => {
  it("returns all commands when query is empty", () => {
    expect(filterCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });

  it.each([
    { query: "/se", expected: ["new", "clear", "regenerate", "model", "search"] },
    { query: "note", expected: ["note"] },
    { query: "session", expected: ["new", "clear", "model"] },
  ])("filters by $query", ({ query, expected }) => {
    const names = filterCommands(query).map((c) => c.name);
    expect(names).toEqual(expected);
  });

  it("is case-insensitive", () => {
    const names = filterCommands("SEARCH").map((c) => c.name);
    expect(names).toContain("search");
  });

  it("includes loaded custom commands", () => {
    useSlashCommandsStore.setState({
      commands: [{
        id: "command-1",
        name: "summarize",
        description: "Summarize notes",
        body: "Summarize {{args}}",
        created_at: "2026-08-30T00:00:00Z",
      }],
      loaded: true,
    });

    expect(filterCommands("/sum").map((command) => command.name)).toEqual(["summarize"]);
  });

  it("lets built-ins win collisions while retaining the persisted row", () => {
    const collision = {
      id: "command-help",
      name: "HELP",
      description: "A custom help",
      body: "Custom help body",
      created_at: "2026-08-30T00:00:00Z",
    };
    useSlashCommandsStore.setState({ commands: [collision], loaded: true });

    expect(findCommand("help")?.description).toBe("Show available slash commands");
    expect(filterCommands("").map((command) => command.name).filter((name) => name === "help")).toEqual(["help"]);
    expect(useSlashCommandsStore.getState().commands).toEqual([collision]);
  });
});

describe("command expansion", () => {
  it("replaces every args placeholder", () => {
    expect(expandCommandBody("One {{args}}, two {{args}}.", "weekly notes")).toBe(
      "One weekly notes, two weekly notes.",
    );
  });

  it("appends non-empty args after a body without a placeholder", () => {
    expect(expandCommandBody("Summarize the notes.", "weekly notes")).toBe(
      "Summarize the notes.\n\nweekly notes",
    );
  });

  it("does not append whitespace-only args", () => {
    expect(expandCommandBody("Summarize the notes.", "  ")).toBe("Summarize the notes.");
  });

  it("preserves replacement syntax in user args", () => {
    expect(expandCommandBody("before {{args}} after", "$&-$`-$$")).toBe(
      "before $&-$`-$$ after",
    );
  });
});

describe("runCommand", () => {
  it("shows an error for unknown commands", async () => {
    await runCommand({ name: "unknown", args: "", raw: "/unknown" }, { sessionId: null });
    expect(mockedToast.error).toHaveBeenCalledWith("Unknown command: /unknown. Try /help.");
  });

  it("does not normalize a second leading slash into a built-in command", async () => {
    const clearAll = vi.fn().mockResolvedValue(undefined);
    useSlashCommandsStore.setState({ loaded: true });

    const result = await runCommand(
      { name: "/clear", args: "", raw: "//clear" },
      { sessionId: "session-1", clearAll },
    );

    expect(clearAll).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalledWith("Unknown command: //clear. Try /help.");
    expect(result.clear).toBe(true);
  });

  it("executes /help and clears input", async () => {
    const result = await runCommand({ name: "help", args: "", raw: "/help" }, { sessionId: null });
    expect(result.clear).toBe(true);
    expect(mockedToast.info).toHaveBeenCalled();
  });

  it("includes loaded custom commands in /help", async () => {
    useSlashCommandsStore.setState({
      commands: [{
        id: "command-1",
        name: "summarize",
        description: "Summarize notes",
        body: "Summarize {{args}}",
        created_at: "2026-08-30T00:00:00Z",
      }],
      loaded: true,
    });

    await runCommand({ name: "help", args: "", raw: "/help" }, { sessionId: null });

    expect(mockedToast.info).toHaveBeenCalledWith(
      expect.stringContaining("/summarize  —  Summarize notes"),
      "Help",
      8000,
    );
  });

  it("creates a new session via context callback", async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const result = await runCommand({ name: "new", args: "", raw: "/new" }, { sessionId: null, newSession });
    expect(newSession).toHaveBeenCalled();
    expect(result.clear).toBe(true);
  });

  it("catches a rejected fallback session create and clears the draft", async () => {
    const create = vi.spyOn(useSessionsStore.getState(), "create").mockRejectedValueOnce(new Error("creation failed"));

    try {
      const result = await runCommand({ name: "new", args: "", raw: "/new" }, { sessionId: null });

      expect(create).toHaveBeenCalled();
      expect(mockedToast.error).toHaveBeenCalledWith("Error: creation failed");
      expect(result).toEqual({ clear: true });
    } finally {
      create.mockRestore();
    }
  });

  it("catches rejected command callbacks and clears the draft", async () => {
    const newSession = vi.fn().mockRejectedValue(new Error("navigation failed"));

    const result = await runCommand(
      { name: "new", args: "", raw: "/new" },
      { sessionId: null, newSession },
    );

    expect(mockedToast.error).toHaveBeenCalledWith("Error: navigation failed");
    expect(result).toEqual({ clear: true });
  });

  it("switches model via context callback", async () => {
    const setModelId = vi.fn();
    const result = await runCommand({ name: "model", args: "llama3", raw: "/model llama3" }, { sessionId: null, setModelId });
    expect(setModelId).toHaveBeenCalledWith("llama3");
    expect(result.clear).toBe(true);
  });

  it("warns when /model is missing args", async () => {
    const result = await runCommand({ name: "model", args: "", raw: "/model" }, { sessionId: null });
    expect(mockedToast.error).toHaveBeenCalledWith("Usage: /model <name>");
    expect(result.clear).toBe(true);
  });

  it("runs /search and returns composed text", async () => {
    mockedApi.getSearchConfig.mockResolvedValueOnce({ provider: "tavily", base_url: null, api_key: "k", max_results: 3 });
    mockedApi.webSearch.mockResolvedValueOnce([
      { title: "Result A", url: "https://a.test", snippet: "About A" },
    ]);
    const result = await runCommand({ name: "search", args: "query", raw: "/search query" }, { sessionId: null });
    expect(result.text).toContain("Search results for \"query\"");
    expect(result.text).toContain("Result A");
  });

  it("errors when search provider is not configured", async () => {
    mockedApi.getSearchConfig.mockResolvedValueOnce(null);
    const result = await runCommand({ name: "search", args: "q", raw: "/search q" }, { sessionId: null });
    expect(result.clear).toBe(true);
    expect(mockedToast.error).toHaveBeenCalled();
  });

  it("creates a note via API", async () => {
    mockedApi.upsertNote.mockResolvedValueOnce("note-id");
    const result = await runCommand({ name: "note", args: "remember this", raw: "/note remember this" }, { sessionId: null });
    expect(mockedApi.upsertNote).toHaveBeenCalledWith({ body: "remember this" });
    expect(result.clear).toBe(true);
    expect(mockedToast.success).toHaveBeenCalled();
  });

  it("creates a task via API", async () => {
    mockedApi.upsertTask.mockResolvedValueOnce("task-id");
    const result = await runCommand({ name: "task", args: "do thing", raw: "/task do thing" }, { sessionId: null });
    expect(mockedApi.upsertTask).toHaveBeenCalledWith({ title: "do thing" });
    expect(result.clear).toBe(true);
  });

  it("catches synchronous errors and shows a toast", async () => {
    const result = await runCommand({ name: "search", args: "x", raw: "/search x" }, { sessionId: null });
    expect(result.clear).toBe(true);
  });

  it("expands a loaded custom command into composer text", async () => {
    useSlashCommandsStore.setState({
      commands: [{
        id: "command-1",
        name: "summarize",
        description: "Summarize notes",
        body: "Summarize {{args}} twice: {{args}}",
        created_at: "2026-08-30T00:00:00Z",
      }],
      loaded: true,
    });

    const result = await runCommand(
      { name: "summarize", args: "weekly notes", raw: "/summarize weekly notes" },
      { sessionId: null },
    );

    expect(result).toEqual({ text: "Summarize weekly notes twice: weekly notes" });
  });

  it("waits for an in-flight persisted command load before resolving a custom command", async () => {
    let resolve!: (commands: Array<{
      id: string;
      name: string;
      description: string;
      body: string;
      created_at: string;
    }>) => void;
    mockedApi.listSlashCommands.mockReturnValueOnce(new Promise((done) => {
      resolve = done;
    }));

    const refresh = useSlashCommandsStore.getState().refresh();
    const command = runCommand(
      { name: "summarize", args: "weekly notes", raw: "/summarize weekly notes" },
      { sessionId: null },
    );

    let settled = false;
    void command.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolve([{
      id: "command-1",
      name: "summarize",
      description: "Summarize notes",
      body: "Summarize {{args}}",
      created_at: "2026-08-30T00:00:00Z",
    }]);

    await refresh;
    await expect(command).resolves.toEqual({ text: "Summarize weekly notes" });
  });
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, SlashCommand } from "../../lib/api";
import { findCommand } from "../../lib/slashCommands";
import { useSlashCommandsStore } from "../slashCommands";

const command: SlashCommand = {
  id: "command-1",
  name: "summarize",
  description: "Summarize notes",
  body: "Summarize {{args}}",
  created_at: "2026-08-30T00:00:00Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
  useSlashCommandsStore.setState({
    commands: [],
    loaded: false,
    loading: false,
    error: null,
  });
});

describe("useSlashCommandsStore", () => {
  it("shares one in-flight load and does not reload a loaded list", async () => {
    let resolve!: (commands: SlashCommand[]) => void;
    const list = vi.spyOn(api, "listSlashCommands").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    const first = useSlashCommandsStore.getState().refresh();
    const second = useSlashCommandsStore.getState().refresh();

    expect(second).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);

    resolve([command]);
    await first;
    await useSlashCommandsStore.getState().refresh();

    expect(useSlashCommandsStore.getState().commands).toEqual([command]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refreshes after an upsert even when an older load is still in flight", async () => {
    let resolveOld!: (commands: SlashCommand[]) => void;
    const list = vi
      .spyOn(api, "listSlashCommands")
      .mockReturnValueOnce(new Promise((done) => { resolveOld = done; }))
      .mockResolvedValueOnce([command]);
    const upsert = vi.spyOn(api, "upsertSlashCommand").mockResolvedValue(command.id);

    const oldRefresh = useSlashCommandsStore.getState().refresh();
    const mutation = useSlashCommandsStore.getState().upsert({
      name: command.name,
      description: command.description,
      body: command.body,
    });
    resolveOld([]);

    await Promise.all([oldRefresh, mutation]);

    expect(upsert).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(2);
    expect(useSlashCommandsStore.getState().commands).toEqual([command]);
  });

  it("keeps built-ins available when persisted commands fail to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(api, "listSlashCommands").mockRejectedValue(new Error("offline"));

    await expect(useSlashCommandsStore.getState().refresh()).rejects.toThrow("offline");

    expect(findCommand("help")?.name).toBe("help");
    expect(useSlashCommandsStore.getState().commands).toEqual([]);
    expect(useSlashCommandsStore.getState().error).toContain("offline");
    expect(useSlashCommandsStore.getState().loading).toBe(false);
  });

  it("surfaces a forced refresh failure and remains retryable after mutation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSlashCommandsStore.setState({ commands: [command], loaded: true });
    const upsert = vi.spyOn(api, "upsertSlashCommand").mockResolvedValue(command.id);
    const list = vi
      .spyOn(api, "listSlashCommands")
      .mockRejectedValueOnce(new Error("refresh offline"))
      .mockResolvedValueOnce([command]);

    await expect(useSlashCommandsStore.getState().upsert({
      name: command.name,
      description: command.description,
      body: command.body,
    })).rejects.toThrow("refresh offline");

    expect(upsert).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(useSlashCommandsStore.getState().loaded).toBe(false);
    expect(useSlashCommandsStore.getState().error).toContain("refresh offline");

    await useSlashCommandsStore.getState().refresh();

    expect(list).toHaveBeenCalledTimes(2);
    expect(useSlashCommandsStore.getState().loaded).toBe(true);
    expect(useSlashCommandsStore.getState().commands).toEqual([command]);
  });
});

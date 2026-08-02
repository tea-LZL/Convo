import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sendMessage } from "../chatStream";
import { useMemoryStore } from "../memory";
import { preferenceItem } from "../../test/fixtures/memory";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  useMemoryStore.setState({ items: [], loaded: false, loading: false, _overrides: {} });
});

describe("sendMessage memory prompt", () => {
  it("sends the base prompt and enabled nickname memory to chat_stream_v2", async () => {
    const nickname = {
      ...preferenceItem,
      title: "User's nickname",
      content: "The user's nickname is Kevin.",
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "get_enabled_memory" || command === "list_memory") return [nickname] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });

    await sendMessage("prompt-test-session", "what is my nickname?", "model-1", {
      providerId: "provider-1",
    });

    const call = mockedInvoke.mock.calls.find(([command]) => command === "chat_stream_v2");
    expect(call).toBeDefined();
    const system = (call?.[1] as { args: { system: string } }).args.system;
    expect(system).toContain("You are a helpful, concise assistant.");
    expect(system).toContain("User's nickname");
    expect(system).toContain("Kevin");
  });
});

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionState, reloadSessionMessages, sendMessage } from "../chatStream";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "list_messages") return [] as never;
    if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
    if (command === "get_session_memory_overrides") return [] as never;
    return undefined as never;
  });
  vi.mocked(listen).mockResolvedValue(vi.fn());
});

describe("append-only chat persistence", () => {
  it("reloads history without issuing a destructive clear", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") {
        return [{
          id: "assistant-1",
          session_id: "reload-session",
          role: "assistant",
          content: "retained",
          thinking: null,
          attachments_json: null,
          prompt_tokens: null,
          output_tokens: null,
          created_at: "now",
        }] as never;
      }
      return [] as never;
    });

    await reloadSessionMessages("reload-session");

    expect(mockedInvoke).toHaveBeenCalledWith("list_messages", { sessionId: "reload-session" });
    expect(mockedInvoke).not.toHaveBeenCalledWith("clear_messages", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("save_messages", expect.objectContaining({ messages: [] }));
    expect(getSessionState("reload-session").messages[0]?.content).toBe("retained");
  });

  it("creates a stable assistant message id before starting a stream", async () => {
    await sendMessage("durable-session", "hello", "model-1", { providerId: "provider-1" });

    const streamCall = mockedInvoke.mock.calls.find(([command]) => command === "chat_stream_v2");
    const args = (streamCall?.[1] as { args: { assistantMessageId?: string; streamId?: string } }).args;
    expect(args.assistantMessageId).toBeTruthy();
    expect(args.streamId).toBeTruthy();
    expect(mockedInvoke.mock.calls.findIndex(([command]) => command === "upsert_message"))
      .toBeLessThan(mockedInvoke.mock.calls.findIndex(([command]) => command === "chat_stream_v2"));
  });
});

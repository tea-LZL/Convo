import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionState, sendMessage, stopStream } from "../chatStream";

const mockedInvoke = vi.mocked(invoke);
const callbacks: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};

async function startStream(sessionId: string) {
  await sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" });
  const state = getSessionState(sessionId);
  return {
    state,
    streamId: state._streamId!,
    assistantMessageId: state._assistantMessageId!,
  };
}

beforeEach(() => {
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "list_messages") return [] as never;
    if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
    if (command === "get_session_memory_overrides") return [] as never;
    return undefined as never;
  });
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
    return vi.fn();
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("stream delta transport", () => {
  it("keeps payload volume linear instead of resending prefixes", () => {
    const deltas = Array.from({ length: 1000 }, () => "x");
    const deltaBytes = deltas.reduce((total, delta) => total + delta.length, 0);
    const prefixBytes = deltas.reduce((total, _, index) => total + index + 1, 0);

    expect(deltaBytes).toBe(1000);
    expect(prefixBytes).toBeGreaterThan(deltaBytes * 500);
  });

  it("flushes a burst of deltas in one animation frame", async () => {
    let flush!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flush = callback;
      return 0;
    });
    const { streamId, assistantMessageId, state } = await startStream("burst-session");
    for (let index = 0; index < 1000; index += 1) {
      callbacks["chat-chunk"]({ payload: {
        conversation_id: "burst-session",
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        delta: "x",
      } });
    }
    expect(flush).toBeTypeOf("function");
    expect(state.streamContent).toBe("");
    flush(0);
    expect(state.streamContent).toHaveLength(1000);
  });

  it("batches content and thinking as deltas in the active stream", async () => {
    const { streamId, assistantMessageId, state } = await startStream("delta-session");

    callbacks["chat-chunk"]({ payload: {
      conversation_id: "delta-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      delta: "hel",
    } });
    callbacks["chat-thinking"]({ payload: {
      conversation_id: "delta-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      delta: "reason",
    } });

    expect(state.streamContent).toBe("hel");
    expect(state.streamThinking).toBe("reason");
    expect(state.status).toBe("streaming");
  });

  it("ignores stale and unscoped events from another stream", async () => {
    const { streamId, assistantMessageId, state } = await startStream("stale-session");
    state._streamId = "stream-b";
    state._assistantMessageId = "assistant-b";
    state.streamContent = "B";

    callbacks["chat-chunk"]({ payload: {
      conversation_id: "stale-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      delta: "stale",
    } });
    callbacks["chat-done"]({ payload: {
      conversation_id: "stale-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      prompt_tokens: null,
      output_tokens: null,
      completed_at: "now",
    } });
    callbacks["chat-chunk"]({ payload: {
      conversation_id: "stale-session",
      stream_id: "",
      assistant_message_id: "assistant-b",
      delta: "unscoped",
    } });

    expect(state.streamContent).toBe("B");
    expect(state.streaming).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it("creates one assistant message for duplicate terminal events", async () => {
    const { streamId, assistantMessageId, state } = await startStream("terminal-session");
    callbacks["chat-chunk"]({ payload: {
      conversation_id: "terminal-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      delta: "answer",
    } });
    const terminal = { payload: {
      conversation_id: "terminal-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      prompt_tokens: 1,
      output_tokens: 2,
      completed_at: "now",
    } };
    callbacks["chat-done"](terminal);
    callbacks["chat-done"](terminal);

    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(state.messages.find((message) => message.role === "assistant")?.id).toBe(assistantMessageId);
    expect(state.status).toBe("complete");
  });

  it("notifies when a response completes outside the open conversation", async () => {
    window.location.hash = "#/documents";
    const { streamId, assistantMessageId } = await startStream("background-session");

    callbacks["chat-done"]({ payload: {
      conversation_id: "background-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      prompt_tokens: null,
      output_tokens: null,
      completed_at: "now",
    } });

    expect(sendNotification).toHaveBeenCalledWith({
      title: "Convo",
      body: "Response complete",
    });
  });

  it("does not notify when the completed conversation is open", async () => {
    window.location.hash = "#/chat/open-session";
    const { streamId, assistantMessageId } = await startStream("open-session");

    callbacks["chat-done"]({ payload: {
      conversation_id: "open-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      prompt_tokens: null,
      output_tokens: null,
      completed_at: "now",
    } });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("cancels the exact active stream generation", async () => {
    const { streamId, assistantMessageId, state } = await startStream("cancel-session");
    await stopStream("cancel-session");

    expect(mockedInvoke).toHaveBeenCalledWith("cancel_chat_v2", {
      sessionId: "cancel-session",
      streamId,
    });
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: "cancel-session",
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      completed_at: "now",
    } });
    expect(state.status).toBe("stopped");
    expect(state.streaming).toBe(false);
  });
});

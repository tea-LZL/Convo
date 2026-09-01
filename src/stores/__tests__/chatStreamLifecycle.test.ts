import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ChatMessage } from "../../lib/api";
import { clearSessionMessages, getSessionState, isClearLocked, isResendLocked, loadSessionMessages, sendMessage, stopStream } from "../chatStream";
import { useMemoryStore } from "../memory";
import { useSettingsStore } from "../settings";
import { toast } from "../toasts";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useSettingsStore.setState({ memoryAutoEvaluate: true });
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
  it("shares listener registration and retries after a partial registration failure", async () => {
    const firstRegistration = deferred<() => void>();
    const firstUnlisten = vi.fn();
    let registrationCalls = 0;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      registrationCalls += 1;
      if (registrationCalls === 1) {
        callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
        return firstRegistration.promise;
      }
      if (registrationCalls === 2) {
        throw new Error("terminal listener registration failed");
      }
      callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
      return vi.fn();
    });

    const first = loadSessionMessages("listener-race-a");
    const second = loadSessionMessages("listener-race-b");
    expect(registrationCalls).toBe(1);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "list_messages")).toBe(false);

    firstRegistration.resolve(firstUnlisten);
    await expect(first).rejects.toThrow("terminal listener registration failed");
    await expect(second).rejects.toThrow("terminal listener registration failed");
    expect(firstUnlisten).toHaveBeenCalledOnce();

    await expect(loadSessionMessages("listener-retry")).resolves.toEqual([]);
    expect(registrationCalls).toBe(7);
  });

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

  it("does not clear an active stream or its stream IDs", async () => {
    const toastWarn = vi.spyOn(toast, "warn");
    const clearMessages = vi.spyOn(api, "clearMessages").mockResolvedValue(undefined);
    const { streamId, assistantMessageId, state } = await startStream("clear-active-stream-session");
    const messages = state.messages.slice();

    await clearSessionMessages("clear-active-stream-session");

    expect(state.messages).toEqual(messages);
    expect(state.streaming).toBe(true);
    expect(state._streamId).toBe(streamId);
    expect(state._assistantMessageId).toBe(assistantMessageId);
    expect(clearMessages).not.toHaveBeenCalled();
    expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("Stop"));
  });

  it("restores the exact session state when the clear API rejects", async () => {
    const sessionId = "clear-rollback-session";
    const messages: ChatMessage[] = [{
      id: "clear-rollback-user",
      session_id: sessionId,
      role: "user",
      content: "retained history",
      thinking: null,
      attachments_json: null,
      prompt_tokens: 3,
      output_tokens: 4,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    await loadSessionMessages(sessionId);
    const state = getSessionState(sessionId);
    Object.assign(state, {
      messages,
      status: "failed",
      streaming: false,
      streamContent: "retained stream content",
      streamThinking: "retained thinking",
      error: "previous error",
      loadingMessages: false,
      _streamGeneration: 4,
      _cancelRequestedGeneration: 3,
      _streamId: "retained-stream",
      _assistantMessageId: "retained-assistant",
      _lastModel: "model-1",
      _lastProviderId: "provider-1",
    });
    const clearError = new Error("database unavailable");
    const clearMessages = vi.spyOn(api, "clearMessages").mockRejectedValueOnce(clearError);
    const toastError = vi.spyOn(toast, "error");

    await expect(clearSessionMessages(sessionId)).resolves.toBe(false);

    expect(clearMessages).toHaveBeenCalledWith(sessionId);
    expect(state.messages).toEqual(messages);
    expect(state.status).toBe("failed");
    expect(state.streaming).toBe(false);
    expect(state.streamContent).toBe("retained stream content");
    expect(state.streamThinking).toBe("retained thinking");
    expect(state.error).toBe("previous error");
    expect(state._streamGeneration).toBe(4);
    expect(state._cancelRequestedGeneration).toBe(3);
    expect(state._streamId).toBe("retained-stream");
    expect(state._assistantMessageId).toBe("retained-assistant");
    expect(isClearLocked(sessionId)).toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("database unavailable"),
      "Clear failed",
    );
  });

  it("queues a first completed in-memory stream when automatic memory review is enabled", async () => {
    useSettingsStore.setState({ memoryAutoEvaluate: true });
    const queueReview = vi.spyOn(useMemoryStore.getState(), "queueReview").mockResolvedValue();

    try {
      const { streamId, assistantMessageId, state } = await startStream("first-review-session");
      expect(state._streamGeneration).toBe(1);
      callbacks["chat-chunk"]({ payload: {
        conversation_id: "first-review-session",
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        delta: "answer",
      } });
      callbacks["chat-done"]({ payload: {
        conversation_id: "first-review-session",
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        prompt_tokens: 1,
        output_tokens: 2,
        completed_at: "now",
      } });

      await vi.waitFor(() => {
        expect(queueReview).toHaveBeenCalledWith("first-review-session", "model-1", "provider-1");
      });
    } finally {
      queueReview.mockRestore();
    }
  });

  it("does not queue a completed stream when automatic memory review is disabled", async () => {
    useSettingsStore.setState({ memoryAutoEvaluate: false });
    const queueReview = vi.spyOn(useMemoryStore.getState(), "queueReview").mockResolvedValue();

    try {
      const { streamId, assistantMessageId } = await startStream("disabled-review-session");
      callbacks["chat-done"]({ payload: {
        conversation_id: "disabled-review-session",
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        prompt_tokens: null,
        output_tokens: null,
        completed_at: "now",
      } });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(queueReview).not.toHaveBeenCalled();
    } finally {
      queueReview.mockRestore();
    }
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

  it("recovers the exact snapshot after a matching terminal chat error", async () => {
    const sessionId = "resend-terminal-error-session";
    const snapshot: ChatMessage[] = [
      {
        id: "resend-user-1",
        session_id: sessionId,
        role: "user",
        content: "original question",
        thinking: null,
        attachments_json: JSON.stringify([{ sourceType: "file", id: "source-1" }]),
        prompt_tokens: null,
        output_tokens: null,
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "resend-assistant-1",
        session_id: sessionId,
        role: "assistant",
        content: "original answer",
        thinking: "original reasoning",
        attachments_json: null,
        prompt_tokens: 1,
        output_tokens: 2,
        created_at: "2026-09-01T00:00:01.000Z",
      },
    ];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const deleteMessage = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await vi.waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
    });
    const streamCall = mockedInvoke.mock.calls.find(([command]) => command === "chat_stream_v2");
    const streamArgs = (streamCall?.[1] as {
      args: { streamId: string; assistantMessageId: string };
    }).args;
    const replacementUserId = (mockedInvoke.mock.calls.find(([command]) => command === "upsert_message")?.[1] as {
      message: { id: string };
    }).message.id;

    callbacks["chat-chunk"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamArgs.streamId,
      assistant_message_id: streamArgs.assistantMessageId,
      delta: "partial replacement",
    } });
    callbacks["chat-error"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamArgs.streamId,
      assistant_message_id: streamArgs.assistantMessageId,
      error: "provider failed after starting",
      completed_at: "2026-09-01T00:00:02.000Z",
    } });

    await expect(resend).rejects.toThrow("provider failed after starting");

    expect(deleteMessage.mock.calls).toEqual([
      [sessionId, replacementUserId],
      [sessionId, streamArgs.assistantMessageId],
    ]);
    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "list_messages")).toHaveLength(2);
    expect(getSessionState(sessionId).messages).toEqual(snapshot);
    expect(getSessionState(sessionId).error).toContain("provider failed after starting");
  });

  it("does not clear an active resend while recovery is cleaning up", async () => {
    const sessionId = "clear-active-resend-session";
    const snapshot: ChatMessage[] = [{
      id: "clear-resend-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    const deleteFinished = deferred<void>();
    const deleteMessage = vi.spyOn(api, "deleteMessage")
      .mockImplementationOnce(() => deleteFinished.promise)
      .mockResolvedValue(undefined);
    const clearMessages = vi.spyOn(api, "clearMessages").mockResolvedValue(undefined);
    const toastWarn = vi.spyOn(toast, "warn");
    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await vi.waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
    });
    const state = getSessionState(sessionId);
    const streamId = state._streamId;
    const assistantMessageId = state._assistantMessageId;
    callbacks["chat-error"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId!,
      assistant_message_id: assistantMessageId!,
      error: "provider failed after starting",
      completed_at: "2026-09-01T00:00:02.000Z",
    } });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledTimes(1));

    await clearSessionMessages(sessionId);

    expect(state._streamId).toBe(streamId);
    expect(state._assistantMessageId).toBe(assistantMessageId);
    expect(clearMessages).not.toHaveBeenCalled();
    expect(toastWarn).toHaveBeenCalledWith(expect.stringContaining("resend"));

    deleteFinished.resolve(undefined);
    await expect(resend).rejects.toThrow("provider failed after starting");
  });

  it("keeps resend recovery exclusive until cleanup has finished", async () => {
    const sessionId = "resend-exclusive-recovery-session";
    const snapshot: ChatMessage[] = [{
      id: "exclusive-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    const deleteFinished = deferred<void>();
    const deleteMessage = vi.spyOn(api, "deleteMessage")
      .mockImplementationOnce(() => deleteFinished.promise)
      .mockResolvedValue(undefined);
    vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await vi.waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
    });
    const state = getSessionState(sessionId);
    const streamId = state._streamId!;
    const assistantMessageId = state._assistantMessageId!;
    callbacks["chat-error"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      error: "provider failed after starting",
      completed_at: "2026-09-01T00:00:02.000Z",
    } });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledTimes(1));

    await expect(sendMessage(sessionId, "concurrent message", "model-1")).resolves.toBe(false);
    expect(state._streamId).toBe(streamId);
    expect(state._assistantMessageId).toBe(assistantMessageId);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "chat_stream_v2")).toHaveLength(1);

    deleteFinished.resolve(undefined);
    await expect(resend).rejects.toThrow("provider failed after starting");
  });

  it("keeps a resend pending until the matching chat-done event", async () => {
    const sessionId = "resend-terminal-success-session";
    const snapshot: ChatMessage[] = [{
      id: "resend-success-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    let resolveStart!: () => void;
    const start = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      if (command === "chat_stream_v2") return start as never;
      return undefined as never;
    });

    let settled = false;
    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
    });
    resolveStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    const state = getSessionState(sessionId);
    callbacks["chat-done"]({ payload: {
      conversation_id: sessionId,
      stream_id: state._streamId!,
      assistant_message_id: state._assistantMessageId!,
      prompt_tokens: 1,
      output_tokens: 2,
      completed_at: "2026-09-01T00:00:01.000Z",
    } });
    await resend;
    expect(settled).toBe(true);
    expect(state.status).toBe("complete");
  });

  it("restores the exact snapshot when a resend's pre-attempt history load rejects", async () => {
    const sessionId = "resend-pre-attempt-load-error-session";
    const snapshot: ChatMessage[] = [{
      id: "pre-attempt-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: JSON.stringify([{ sourceType: "note", id: "note-1" }]),
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    const historyLoad = deferred<ChatMessage[]>();
    let listCalls = 0;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") {
        listCalls += 1;
        if (listCalls === 1) return snapshot as never;
        if (listCalls === 2) return historyLoad.promise as never;
        return snapshot as never;
      }
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    await loadSessionMessages(sessionId);
    const state = getSessionState(sessionId);
    state.messages = [];
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await vi.waitFor(() => expect(listCalls).toBe(2));
    expect(isResendLocked(sessionId)).toBe(true);
    historyLoad.reject(new Error("history load failed"));

    await expect(resend).rejects.toThrow("history load failed");

    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(listCalls).toBe(3);
    expect(state.messages).toEqual(snapshot);
    expect(state.streaming).toBe(false);
    expect(state.status).toBe("failed");
    expect(state.error).toContain("history load failed");
    expect(isResendLocked(sessionId)).toBe(false);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "upsert_message")).toBe(false);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);
  });

  it("recovers the exact snapshot when the provider rejects at stream start", async () => {
    const sessionId = "resend-provider-start-error-session";
    const snapshot: ChatMessage[] = [{
      id: "provider-start-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: JSON.stringify([{ sourceType: "note", id: "note-1" }]),
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      if (command === "chat_stream_v2") throw new Error("provider unavailable");
      return undefined as never;
    });
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const deleteMessage = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await expect(resend).rejects.toThrow("provider unavailable");

    const streamCall = mockedInvoke.mock.calls.find(([command]) => command === "chat_stream_v2");
    const streamArgs = (streamCall?.[1] as {
      args: { assistantMessageId: string };
    }).args;
    const replacementUserId = (mockedInvoke.mock.calls.find(([command]) => command === "upsert_message")?.[1] as {
      message: { id: string };
    }).message.id;
    expect(deleteMessage.mock.calls).toEqual([
      [sessionId, replacementUserId],
      [sessionId, streamArgs.assistantMessageId],
    ]);
    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "list_messages")).toHaveLength(2);
    expect(getSessionState(sessionId).messages).toEqual(snapshot);
  });

  it("settles an early resend failure and releases its completion lock", async () => {
    const sessionId = "resend-early-failure-session";
    const snapshot: ChatMessage[] = [{
      id: "early-failure-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "get_enabled_memory" || command === "list_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    vi.spyOn(api, "upsertMessage").mockRejectedValueOnce(new Error("upsert failed"));
    vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);
    vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await expect(resend).rejects.toThrow("upsert failed");
    const chatStream = await import("../chatStream");
    const isResendLocked = (chatStream as unknown as {
      isResendLocked?: (cid: string) => boolean;
    }).isResendLocked;
    expect(isResendLocked).toBeTypeOf("function");
    expect(isResendLocked?.(sessionId)).toBe(false);
  });

  it("treats an explicit resend cancellation as a failed replacement", async () => {
    const sessionId = "resend-cancelled-session";
    const snapshot: ChatMessage[] = [{
      id: "cancelled-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const deleteMessage = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);
    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await vi.waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
    });
    const streamCall = mockedInvoke.mock.calls.find(([command]) => command === "chat_stream_v2");
    const streamArgs = (streamCall?.[1] as {
      args: { streamId: string; assistantMessageId: string };
    }).args;
    const replacementUserId = (mockedInvoke.mock.calls.find(([command]) => command === "upsert_message")?.[1] as {
      message: { id: string };
    }).message.id;

    await stopStream(sessionId);
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamArgs.streamId,
      assistant_message_id: streamArgs.assistantMessageId,
      completed_at: "2026-09-01T00:00:02.000Z",
    } });

    await expect(resend).rejects.toThrow("Response cancelled");
    expect(deleteMessage.mock.calls).toEqual([
      [sessionId, replacementUserId],
      [sessionId, streamArgs.assistantMessageId],
    ]);
    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(getSessionState(sessionId).messages).toEqual(snapshot);
  });

  it("continues resend cleanup and reports recovery failures", async () => {
    const sessionId = "resend-recovery-error-session";
    const snapshot: ChatMessage[] = [{
      id: "recovery-error-user-1",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      if (command === "chat_stream_v2") throw new Error("provider unavailable");
      return undefined as never;
    });
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    const deleteMessage = vi.spyOn(api, "deleteMessage")
      .mockRejectedValueOnce(new Error("user cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const toastError = vi.spyOn(toast, "error");

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });

    await expect(resend).rejects.toThrow("provider unavailable");

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Resend recovery incomplete"),
      "Resend failed",
    );
  });

  it("recovers a resend snapshot when stop supersedes the send before provider start", async () => {
    const sessionId = "resend-stop-before-provider-session";
    const snapshot: ChatMessage[] = [{
      id: "resend-stop-original-user",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    const upsertFinished = deferred<void>();
    vi.spyOn(api, "upsertMessage").mockImplementationOnce(() => upsertFinished.promise);
    const deleteMessage = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);
    const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });
    await vi.waitFor(() => expect(api.upsertMessage).toHaveBeenCalledTimes(1));

    const state = getSessionState(sessionId);
    const streamId = state._streamId!;
    const assistantMessageId = state._assistantMessageId!;
    await stopStream(sessionId);
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      completed_at: "now",
    } });

    upsertFinished.resolve();
    await expect(resend).rejects.toThrow("Response cancelled");

    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);
    expect(deleteMessage).toHaveBeenCalledWith(sessionId, expect.any(String));
    expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    expect(state.messages).toEqual(snapshot);
    expect(state.streaming).toBe(false);
    expect(isResendLocked(sessionId)).toBe(false);
  });

  it("does not start the provider when stop supersedes a send during pre-provider persistence", async () => {
    const sessionId = "stop-before-provider-session";
    const upsertFinished = deferred<void>();
    vi.spyOn(api, "upsertMessage").mockImplementationOnce(() => upsertFinished.promise);

    const send = sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" });
    await vi.waitFor(() => expect(api.upsertMessage).toHaveBeenCalledTimes(1));

    const state = getSessionState(sessionId);
    const streamId = state._streamId!;
    const assistantMessageId = state._assistantMessageId!;
    await stopStream(sessionId);
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      completed_at: "now",
    } });

    upsertFinished.resolve();
    await expect(send).resolves.toBe(false);

    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);
    expect(state.streaming).toBe(false);
    expect(state.status).toBe("stopped");
  });

  it("refuses a send while a clear mutation is still in flight", async () => {
    const sessionId = "clear-send-race-session";
    const clearFinished = deferred<void>();
    const clearMessages = vi.spyOn(api, "clearMessages")
      .mockImplementationOnce(() => clearFinished.promise);

    const clear = clearSessionMessages(sessionId);
    await vi.waitFor(() => expect(clearMessages).toHaveBeenCalledWith(sessionId));

    await expect(sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" }))
      .resolves.toBe(false);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "upsert_message")).toBe(false);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);

    clearFinished.resolve();
    await expect(clear).resolves.toBe(true);
    await expect(sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" }))
      .resolves.toBe(true);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true);
  });

  it.each(["chat-done", "chat-error"] as const)(
    "treats a matching %s after stop as cancelled resend work",
    async (terminalEvent) => {
      const sessionId = `stop-before-${terminalEvent}-session`;
      const snapshot: ChatMessage[] = [{
        id: `stop-before-${terminalEvent}-user`,
        session_id: sessionId,
        role: "user",
        content: "original question",
        thinking: null,
        attachments_json: null,
        prompt_tokens: null,
        output_tokens: null,
        created_at: "2026-09-01T00:00:00.000Z",
      }];
      mockedInvoke.mockImplementation(async (command) => {
        if (command === "list_messages") return snapshot as never;
        if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
        if (command === "get_session_memory_overrides") return [] as never;
        return undefined as never;
      });
      const cancelFinished = deferred<void>();
      vi.spyOn(api, "cancelChat").mockImplementationOnce(() => cancelFinished.promise);
      const deleteMessage = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);
      const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
      const resend = sendMessage(sessionId, "replacement question", "model-1", {
        providerId: "provider-1",
        resendSnapshot: snapshot,
      });

      await vi.waitFor(() => expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true));
      const state = getSessionState(sessionId);
      const streamId = state._streamId!;
      const assistantMessageId = state._assistantMessageId!;
      const stop = stopStream(sessionId);
      await vi.waitFor(() => expect(api.cancelChat).toHaveBeenCalledWith(sessionId, streamId));

      callbacks[terminalEvent]({ payload: terminalEvent === "chat-done"
        ? {
            conversation_id: sessionId,
            stream_id: streamId,
            assistant_message_id: assistantMessageId,
            prompt_tokens: 1,
            output_tokens: 2,
            completed_at: "late",
          }
        : {
            conversation_id: sessionId,
            stream_id: streamId,
            assistant_message_id: assistantMessageId,
            error: "late provider error",
            completed_at: "late",
          } });

      cancelFinished.resolve();
      await stop;
      await expect(resend).rejects.toThrow("Response cancelled");
      expect(deleteMessage).toHaveBeenCalledWith(sessionId, expect.any(String));
      expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
      expect(state.messages).toEqual(snapshot);
      expect(state.streaming).toBe(false);
      expect(state.status).toBe("failed");
    },
  );

  it("runs stop timeout recovery while cancel is still hung and ignores its late failure", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "hung-cancel-timeout-session";
      const snapshot: ChatMessage[] = [{
        id: "hung-cancel-original-user",
        session_id: sessionId,
        role: "user",
        content: "original question",
        thinking: null,
        attachments_json: null,
        prompt_tokens: null,
        output_tokens: null,
        created_at: "2026-09-01T00:00:00.000Z",
      }];
      mockedInvoke.mockImplementation(async (command) => {
        if (command === "list_messages") return snapshot as never;
        if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
        if (command === "get_session_memory_overrides") return [] as never;
        return undefined as never;
      });
      const cancelFinished = deferred<void>();
      vi.spyOn(api, "cancelChat").mockImplementationOnce(() => cancelFinished.promise);
      const firstDelete = deferred<void>();
      const deleteMessage = vi.spyOn(api, "deleteMessage")
        .mockImplementationOnce(() => firstDelete.promise)
        .mockResolvedValue(undefined);
      const saveMessages = vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
      const resend = sendMessage(sessionId, "replacement question", "model-1", {
        providerId: "provider-1",
        resendSnapshot: snapshot,
      });

      await vi.waitFor(() => expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true));
      const state = getSessionState(sessionId);
      const streamId = state._streamId!;
      const stop = stopStream(sessionId);
      await vi.waitFor(() => expect(api.cancelChat).toHaveBeenCalledWith(sessionId, streamId));

      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledTimes(1));
      expect(state.status).toBe("stopped");
      expect(state.streaming).toBe(false);
      expect(state.error).toBe("Stop request timed out");

      cancelFinished.reject(new Error("late cancel failure"));
      await stop;
      expect(state.status).toBe("stopped");
      expect(state.error).toBe("Stop request timed out");

      firstDelete.resolve();
      await expect(resend).rejects.toThrow("Response stop timed out");
      expect(saveMessages).toHaveBeenCalledWith(sessionId, snapshot);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores late events after a stop timeout while resend recovery is pending", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "stop-timeout-late-event-session";
      const snapshot: ChatMessage[] = [{
        id: "timeout-original-user",
        session_id: sessionId,
        role: "user",
        content: "original question",
        thinking: null,
        attachments_json: null,
        prompt_tokens: null,
        output_tokens: null,
        created_at: "2026-09-01T00:00:00.000Z",
      }];
      mockedInvoke.mockImplementation(async (command) => {
        if (command === "list_messages") return snapshot as never;
        if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
        if (command === "get_session_memory_overrides") return [] as never;
        return undefined as never;
      });
      const firstDelete = deferred<void>();
      vi.spyOn(api, "deleteMessage")
        .mockImplementationOnce(() => firstDelete.promise)
        .mockResolvedValue(undefined);
      vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);

      const resend = sendMessage(sessionId, "replacement question", "model-1", {
        providerId: "provider-1",
        resendSnapshot: snapshot,
      });
      await vi.waitFor(() => expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true));

      const state = getSessionState(sessionId);
      const streamId = state._streamId!;
      const assistantMessageId = state._assistantMessageId!;
      await stopStream(sessionId);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(api.deleteMessage).toHaveBeenCalledTimes(1));

      callbacks["chat-chunk"]({ payload: {
        conversation_id: sessionId,
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        delta: "late content",
      } });
      callbacks["chat-done"]({ payload: {
        conversation_id: sessionId,
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        prompt_tokens: 1,
        output_tokens: 2,
        completed_at: "late",
      } });
      callbacks["chat-cancelled"]({ payload: {
        conversation_id: sessionId,
        stream_id: streamId,
        assistant_message_id: assistantMessageId,
        completed_at: "late",
      } });

      expect(state.status).toBe("stopped");
      expect(state.streaming).toBe(false);
      expect(state.streamContent).toBe("");
      expect(state.messages.some((message) => message.id === assistantMessageId)).toBe(false);

      firstDelete.resolve();
      await expect(resend).rejects.toThrow("Response stop timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores late events after cancel command failure while resend recovery is pending", async () => {
    const sessionId = "cancel-failure-late-event-session";
    const snapshot: ChatMessage[] = [{
      id: "cancel-failure-original-user",
      session_id: sessionId,
      role: "user",
      content: "original question",
      thinking: null,
      attachments_json: null,
      prompt_tokens: null,
      output_tokens: null,
      created_at: "2026-09-01T00:00:00.000Z",
    }];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return snapshot as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });
    const firstDelete = deferred<void>();
    vi.spyOn(api, "deleteMessage")
      .mockImplementationOnce(() => firstDelete.promise)
      .mockResolvedValue(undefined);
    vi.spyOn(api, "saveMessages").mockResolvedValue(undefined);
    vi.spyOn(api, "cancelChat").mockRejectedValueOnce(new Error("cancel command failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resend = sendMessage(sessionId, "replacement question", "model-1", {
      providerId: "provider-1",
      resendSnapshot: snapshot,
    });
    await vi.waitFor(() => expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true));

    const state = getSessionState(sessionId);
    const streamId = state._streamId!;
    const assistantMessageId = state._assistantMessageId!;
    await stopStream(sessionId);
    await vi.waitFor(() => expect(api.deleteMessage).toHaveBeenCalledTimes(1));

    callbacks["chat-chunk"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      delta: "late content",
    } });
    callbacks["chat-done"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      prompt_tokens: 1,
      output_tokens: 2,
      completed_at: "late",
    } });
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      completed_at: "late",
    } });

    expect(state.status).toBe("failed");
    expect(state.streaming).toBe(false);
    expect(state.streamContent).toBe("");
    expect(state.messages.some((message) => message.id === assistantMessageId)).toBe(false);

    firstDelete.resolve();
    await expect(resend).rejects.toThrow("cancel command failed");
  });

  it("preserves cancel failure state when a pre-provider phase rejects", async () => {
    const sessionId = "cancel-pre-provider-error-session";
    const promptFinished = deferred<string>();
    vi.spyOn(useMemoryStore.getState(), "buildContextBlock").mockReturnValue(promptFinished.promise);
    vi.spyOn(api, "cancelChat").mockRejectedValueOnce(new Error("cancel command failed"));
    const upsertMessage = vi.spyOn(api, "upsertMessage");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const send = sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" });
    await vi.waitFor(() => expect(upsertMessage).toHaveBeenCalledTimes(1));
    await stopStream(sessionId);
    promptFinished.reject(new Error("prompt construction failed"));

    await expect(send).resolves.toBe(false);
    const state = getSessionState(sessionId);
    expect(state.streaming).toBe(false);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("cancel command failed");
    expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(false);
  });

  it("returns failure when stop supersedes a provider-start call", async () => {
    const sessionId = "stop-provider-start-session";
    const providerStarted = deferred<void>();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return [] as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      if (command === "chat_stream_v2") return providerStarted.promise as never;
      return undefined as never;
    });

    const send = sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" });
    await vi.waitFor(() => expect(mockedInvoke.mock.calls.some(([command]) => command === "chat_stream_v2")).toBe(true));
    const state = getSessionState(sessionId);
    const streamId = state._streamId!;
    const assistantMessageId = state._assistantMessageId!;

    await stopStream(sessionId);
    callbacks["chat-cancelled"]({ payload: {
      conversation_id: sessionId,
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      completed_at: "now",
    } });
    providerStarted.resolve();

    await expect(send).resolves.toBe(false);
    expect(state.streaming).toBe(false);
    expect(state.status).toBe("stopped");
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

/**
 * Store subscription tests.
 *
 * These pin the reactivity contract the chat tree depends on: streaming
 * must re-render the tail and nothing else. If a session's published
 * object churns for reasons unrelated to what a component reads, every
 * subscriber re-renders 60 times a second and the v0.6.5 lag returns.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionState,
  sendMessage,
  useChatStreamStore,
  selectMessages,
  selectStreamSlice,
} from "../chatStream";
import type { StreamSlice } from "../chatStream";

const mockedInvoke = vi.mocked(invoke);
const callbacks: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};

/**
 * Session ids are unique per call. `stateBySession` is module scope and
 * survives `beforeEach`, and `sendMessage` early-returns on a session
 * that is still streaming — so reusing an id across tests silently
 * reuses the previous test's stream.
 */
let sessionCounter = 0;
const sid = () => `s${++sessionCounter}`;

beforeEach(() => {
  useChatStreamStore.setState({ sessions: {} });
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

async function startStream(sessionId: string) {
  await sendMessage(sessionId, "hello", "model-1", { providerId: "provider-1" });
  const state = getSessionState(sessionId);
  return { state, streamId: state._streamId!, assistantMessageId: state._assistantMessageId! };
}

/** Emit a chunk for a stream, with the ids the listener validates against. */
function emitChunk(
  handle: { streamId: string; assistantMessageId: string },
  sessionId: string,
  content: string,
) {
  emit("chat-chunk", {
    conversation_id: sessionId,
    stream_id: handle.streamId,
    assistant_message_id: handle.assistantMessageId,
    delta: content,
    content,
    thinking: "",
  });
}

function emit(event: string, payload: Record<string, unknown>) {
  callbacks[event]?.({ payload } as never);
}

describe("store shape", () => {
  it("exposes sessions as the only reactive state", () => {
    // A global version counter cannot drive per-session subscriptions:
    // any session's change would invalidate every subscriber's
    // comparison. The published session object identity is the signal.
    expect(Object.keys(useChatStreamStore.getState())).toEqual(["sessions"]);
  });

  it("publishes a session that was never read before", async () => {
    const id = sid();
    await startStream(id);
    expect(selectStreamSlice(id)(useChatStreamStore.getState())).toBeDefined();
  });
});

describe("selectStreamSlice", () => {
  it("returns undefined for a session the store has never seen", () => {
    // Components pair this with `?? false`. The selector does not invent
    // a default slice, because a session absent from the store and a
    // session that exists but is idle are genuinely different states.
    expect(selectStreamSlice("nope")(useChatStreamStore.getState())).toBeUndefined();
  });

  it("reflects streaming state once a stream starts", async () => {
    const id = sid();
    await startStream(id);
    const slice = selectStreamSlice(id)(useChatStreamStore.getState()) as StreamSlice;
    expect(slice.streaming).toBe(true);
    expect(slice.status).toBe("streaming");
  });

  it("accumulates streamed content into the slice", async () => {
    const id = sid();
    const handle = await startStream(id);
    emitChunk(handle, id, "hello ");
    emitChunk(handle, id, "world");
    const slice = selectStreamSlice(id)(useChatStreamStore.getState()) as StreamSlice;
    expect(slice.streamContent).toBe("hello world");
  });
});

describe("selectMessages", () => {
  it("keeps the array reference stable while a stream appends", async () => {
    const id = sid();
    const handle = await startStream(id);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const before = selectMessages(id)(useChatStreamStore.getState());
    expect(before).toBeDefined();

    for (let i = 0; i < 20; i++) emitChunk(handle, id, "x");

    const after = selectMessages(id)(useChatStreamStore.getState());
    // This identity is what keeps MessageList from re-rendering on every
    // frame. A new array here is the v0.6.5 stream-lag regression.
    expect(after).toBe(before);
  });

  it("is undefined for an unknown session", () => {
    expect(selectMessages("nope")(useChatStreamStore.getState())).toBeUndefined();
  });
});

describe("sessions are isolated from each other", () => {
  it("does not republish an untouched session when another streams", async () => {
    const a = sid();
    const b = sid();
    await startStream(a);
    await startStream(b);
    const aBefore = useChatStreamStore.getState().sessions[a];
    const bBefore = useChatStreamStore.getState().sessions[b];

    const handle = await startStream(a);
    for (let i = 0; i < 5; i++) emitChunk(handle, a, "x");

    // "a" churns — that is the point. "b" must not, or every subscriber
    // to session b re-renders on session a's every frame.
    expect(useChatStreamStore.getState().sessions[a]).not.toBe(aBefore);
    expect(useChatStreamStore.getState().sessions[b]).toBe(bBefore);
  });

  it("leaves another session's stream slice untouched", async () => {
    const a = sid();
    const b = sid();
    await startStream(a);
    await startStream(b);
    const bBefore = selectStreamSlice(b)(useChatStreamStore.getState());

    const handle = await startStream(a);
    emitChunk(handle, a, "x");

    expect(selectStreamSlice(b)(useChatStreamStore.getState())).toBe(bBefore);
  });
});

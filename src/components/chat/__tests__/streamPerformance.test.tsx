/**
 * Streaming performance gates — spec §8.2 invariants 1, 2 and 3.
 *
 * These assert *work done*, not wall-clock. A CI machine's speed is not
 * a property of this code, so a timing threshold would be a coin flip.
 * What is a property of this code is the shape of the work: each frozen
 * block is parsed once, a settled message list commits zero times while
 * a stream runs, and a cancelled stream accepts nothing more.
 *
 * React's Profiler counts real commits, because the failure these guard
 * against is a re-render, not a re-parse. A row that re-renders but hits
 * MarkdownRenderer's memo still costs React work and still shows as lag.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React, { Profiler } from "react";
import { MarkdownBlocks } from "../StreamingTail";
import { MessageList } from "../MessageRow";
import {
  getSessionState,
  sendMessage,
  stopStream,
  useChatStreamStore,
} from "../../../stores/chatStream";

/** Counts react-markdown invocations — i.e. markdown parses. */
let parses = 0;
vi.mock("react-markdown", async () => {
  const Actual = await vi.importActual<typeof import("react-markdown")>("react-markdown");
  return {
    __esModule: true,
    default: (props: { children?: string }) => {
      parses++;
      return <Actual.default {...props} />;
    },
  };
});

const mockedInvoke = vi.mocked(invoke);
const callbacks: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};

let sessionCounter = 0;
const sid = () => `perf${++sessionCounter}`;

function emitChunk(
  handle: { streamId: string; assistantMessageId: string },
  sessionId: string,
  content: string,
) {
  callbacks["chat-chunk"]?.({
    payload: {
      conversation_id: sessionId,
      stream_id: handle.streamId,
      assistant_message_id: handle.assistantMessageId,
      delta: content,
      content,
      thinking: "",
    },
  } as never);
}

let queuedFrames: FrameRequestCallback[] = [];

beforeEach(() => {
  parses = 0;
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
  // jsdom has no rAF loop. Queue the callbacks so a test decides when a
  // frame flushes, rather than depending on timers.
  queuedFrames = [];
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queuedFrames.push(cb);
    return ++handle;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function drainFrames() {
  while (queuedFrames.length) queuedFrames.shift()!(0);
}

describe("invariant 2: tail work is bounded by the block count, not the chunk count", () => {
  it("parses each block once across a long stream", () => {
    const CHUNKS = 200;
    const BLOCKS = 40;
    const body = Array.from(
      { length: BLOCKS },
      (_, i) => `Paragraph ${i} with enough words in it to make the block non-trivial.`,
    ).join("\n\n");
    expect(body.length).toBeGreaterThan(2000);

    const chunkSize = Math.ceil(body.length / CHUNKS);
    const { rerender } = render(<MarkdownBlocks text="" />);
    for (let i = 0; i < CHUNKS; i++) {
      rerender(<MarkdownBlocks text={body.slice(0, (i + 1) * chunkSize)} />);
    }

    // Each of the 40 blocks is parsed once, plus the growing tail is
    // re-parsed as it advances. A naive implementation that re-rendered
    // every block on every chunk would do BLOCKS x CHUNKS = 8000.
    expect(parses).toBeLessThan(BLOCKS + CHUNKS);
    expect(parses).toBeGreaterThan(BLOCKS);
  });

  it("does no work at all when the content does not change", () => {
    const body = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    const { rerender } = render(<MarkdownBlocks text={body} />);
    const afterFirst = parses;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) rerender(<MarkdownBlocks text={body} />);
    expect(parses).toBe(afterFirst);
  });
});

describe("invariant 1: settled message rows never commit while a stream runs", () => {
  it("keeps the message list's commit count flat for the whole stream", async () => {
    const id = sid();
    await sendMessage(id, "hello", "model-1", { providerId: "provider-1" });
    const s = getSessionState(id);
    const handle = { streamId: s._streamId!, assistantMessageId: s._assistantMessageId! };

    // The session is built only through the real flow. Seeding the store
    // directly does not seed `stateBySession`, so the first `publish`
    // would swap the seeded session for stateBySession's version and the
    // test would measure that swap rather than the invariant.
    //
    // Props are hoisted and referentially stable: handing MessageList
    // fresh callbacks or a fresh Set each render fails its memo on
    // identity alone and proves nothing about the store.
    const props = {
      sessionId: id,
      editingMessageId: null,
      setEditingMessageId: () => {},
      collapsedThinking: new Set<number>(),
      setCollapsedThinking: () => {},
      setContextMenu: () => {},
      onBumpScroll: () => {},
      onResend: async () => {},
    };

    let commits = 0;
    render(
      <Profiler id="list" onRender={() => { commits++; }}>
        <MessageList {...props} />
      </Profiler>,
    );
    const before = commits;
    expect(before).toBeGreaterThan(0);

    // Deliberately no rerender(): the store notification is the only
    // trigger, which is the situation this invariant is about.
    for (let i = 0; i < 100; i++) {
      emitChunk(handle, id, "chunk ");
      drainFrames();
    }

    // 100 chunks of streaming must not have re-committed the message
    // list. A regression here is the v0.6.5 stream-lag bug.
    expect(commits).toBe(before);
  });
});

describe("invariant 3: a closed stream accepts nothing further", () => {
  it("ignores chunks that arrive after the terminal event", async () => {
    const id = sid();
    await sendMessage(id, "hello", "model-1", { providerId: "provider-1" });
    const s = getSessionState(id);
    const handle = { streamId: s._streamId!, assistantMessageId: s._assistantMessageId! };

    emitChunk(handle, id, "partial answer");
    drainFrames();
    await stopStream(id);

    // Chunks between the cancel *request* and the terminal event are
    // kept on purpose: the partial answer is what gets saved, with
    // " [stopped]" appended. Dropping them would lose real output.
    emitChunk(handle, id, " more");
    drainFrames();
    expect(useChatStreamStore.getState().sessions[id]?.streamContent).toContain("more");

    callbacks["chat-cancelled"]?.({
      payload: {
        conversation_id: id,
        stream_id: handle.streamId,
        assistant_message_id: handle.assistantMessageId,
        completed_at: new Date().toISOString(),
      },
    } as never);

    const afterTerminal = useChatStreamStore.getState().sessions[id];
    expect(afterTerminal?.streaming).toBe(false);
    expect(afterTerminal?.status).toBe("stopped");
    expect(afterTerminal?.streamContent).toBe("");

    // The stream is closed now. Anything still in flight is an orphan
    // and must not touch the store.
    for (let i = 0; i < 50; i++) emitChunk(handle, id, "orphan");
    drainFrames();

    const after = useChatStreamStore.getState().sessions[id];
    expect(after?.streamContent).toBe("");
    expect(after?.status).toBe("stopped");
  });
});

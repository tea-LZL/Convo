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
 *
 * The last two describes are the *paint* half of the same argument.
 * jsdom cannot measure frame rate, so instead of a timing threshold they
 * assert the structural invariant that causes it: the subtree that
 * re-renders 60 times a second carries no box-shadow, filter or
 * transition, and MessageRow's hand-written comparator still accounts
 * for every prop it is given.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import React, { Profiler } from "react";
import { MarkdownBlocks, StreamingTail } from "../StreamingTail";
import { MessageList, MessageRow } from "../MessageRow";
import type { MessageRowProps } from "../types";
import {
  getSessionState,
  sendMessage,
  stopStream,
  useChatStreamStore,
} from "../../../stores/chatStream";
import type { ChatMessage } from "../../../lib/api";


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

  it("does not re-highlight a growing code fence on every frame", () => {
    // An open fence is the whole tail while it streams, so it re-renders
    // every frame. With Prism in that path, a growing 200-line block
    // measured at ~170ms per frame — 6fps, not 60fps. The streaming path
    // renders code without highlighting for exactly this reason; the
    // settled message gets it.
    const code = Array.from(
      { length: 200 },
      (_, i) => `const value${i} = compute(${i}, "some argument text to give the parser work");`,
    ).join("\n");
    const FRAMES = 20;
    const { rerender } = render(<MarkdownBlocks text={"```ts\n"} />);
    const started = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      rerender(<MarkdownBlocks text={`\`\`\`ts\n${code.slice(0, Math.floor((code.length * (i + 1)) / FRAMES))}`} />);
    }
    const perFrame = (performance.now() - started) / FRAMES;

    // A budget, not a wall-clock assertion on CI hardware: the old path
    // was ~170ms/frame. Anything in that neighbourhood is a regression.
    expect(perFrame).toBeLessThan(40);
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

/* ── the paint half ──────────────────────────────────────────────────────
 *
 * A streaming frame re-renders the tail ~60 times a second. A box-shadow,
 * filter or transition on that subtree is not a cosmetic detail: it
 * invalidates paint on every one of those frames, and a transition
 * guarantees a composited animation on each. Both were the difference
 * between 60fps and 6fps in v0.6.5.
 *
 * `vitest.config.ts` sets `css: false`, so there is no stylesheet here
 * and `getComputedStyle` cannot tell us anything. The check is therefore
 * structural: it reads the Tailwind utility class names off the rendered
 * tree (plus any inline style), which is where the property would be
 * declared. The negative control below proves the walk is not vacuous.
 */

/** Utility prefixes that put a paint-forcing property on an element. */
const PAINT_UTILS: { label: string; re: RegExp }[] = [
  // box-shadow. `drop-shadow` is a filter, hence also paint-forcing.
  { label: "box-shadow", re: /^(shadow|drop-shadow)(-|$)/ },
  { label: "filter", re: /^(blur|brightness|contrast|grayscale|invert|saturate|sepia|hue-rotate|backdrop-(blur|brightness|contrast|grayscale|invert|saturate|sepia|hue-rotate))(-|$)/ },
  { label: "transition", re: /^transition(-|$)/ },
];

/** Every paint-forcing declaration in the subtree rooted at `root`. */
function paintViolations(root: HTMLElement, allow: RegExp[] = []): string[] {
  const found: string[] = [];
  const tag = (el: Element) => el.tagName.toLowerCase();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const cls of el.classList) {
      // Drop variant prefixes (`hover:`, `dark:`, `md:`) and `!important`.
      const bare = cls.replace(/^!/, "").split(":").pop() ?? cls;
      if (allow.some((a) => a.test(bare))) continue;
      for (const { label, re } of PAINT_UTILS) {
        if (re.test(bare)) found.push(`<${tag(el)} class="${cls}"> declares ${label}`);
      }
    }
    const inline = el.getAttribute("style") ?? "";
    const m = inline.match(/(?:^|;)\s*(box-shadow|filter|transition(?:-property)?)\s*:/);
    if (m && !allow.some((a) => a.test(m[1]))) {
      found.push(`<${tag(el)}> declares inline ${m[1]}`);
    }
  }
  return found;
}

const STREAM_BODY = [
  "A paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com).",
  "",
  "- first list item",
  "- second list item",
  "",
  "## A heading",
  "",
  "```ts",
  'const value = compute(1, "some argument text");',
  "```",
  "",
  "> a blockquote",
].join("\n");

describe("paint guard: the streaming subtree stays cheap to repaint", () => {
  it("carries no box-shadow, filter or transition while it streams", async () => {
    const id = sid();
    await sendMessage(id, "hello", "model-1", { providerId: "provider-1" });
    const s = getSessionState(id);
    const handle = { streamId: s._streamId!, assistantMessageId: s._assistantMessageId! };

    const { container } = render(
      <StreamingTail
        sessionId={id}
        stickToBottomRef={{ current: true }}
        onBumpScroll={() => {}}
      />,
    );
    act(() => {
      emitChunk(handle, id, STREAM_BODY);
      drainFrames();
    });

    // A real subtree, not the empty placeholder: if the walk found
    // nothing to inspect it would pass for the wrong reason.
    expect(container.querySelector("h2")).toBeTruthy();
    expect(container.querySelector("li")).toBeTruthy();
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.querySelector("blockquote")).toBeTruthy();
    expect(container.textContent).toContain("compute(1");

    // `animate-pulse-dot` is allowed and is not in the list above: the
    // three dots are a transform animation on a 6px box, not a paint of
    // the text, and they only exist while there is no content at all.
    expect(paintViolations(container)).toEqual([]);
  });

  it("reports a shadow, a filter and a transition when one is present", () => {
    // Negative control, so the guard above cannot pass by being blind.
    const host = document.createElement("div");
    host.innerHTML = [
      '<div class="shadow-nav-glow"></div>',
      '<div class="hover:shadow-lg"></div>',
      '<div class="transition-opacity duration-200"></div>',
      '<div class="blur-sm"></div>',
      '<div style="filter: blur(1px)"></div>',
      '<div class="bg-surface-2"></div>',
    ].join("");

    const found = paintViolations(host);
    expect(found.filter((f) => f.includes("shadow-nav-glow"))).toHaveLength(1);
    expect(found.filter((f) => f.includes("shadow-lg"))).toHaveLength(1);
    expect(found.filter((f) => f.includes("transition-opacity"))).toHaveLength(1);
    expect(found.filter((f) => f.includes("blur-sm"))).toHaveLength(1);
    expect(found.filter((f) => f.includes("inline filter"))).toHaveLength(1);
    expect(found).toHaveLength(5);
  });

  it("keeps box-shadow and filter out of settled rows", async () => {
    // Transitions *are* allowed here: hover affordances and the
    // thinking panel's collapse are paid once, on mount. A shadow or a
    // filter is not, and `animate-message-in` on every row is a paint
    // storm on a long history.
    const messages: ChatMessage[] = [
      {
        id: "m-user", session_id: "s", role: "user", content: "hello there",
        thinking: null, attachments_json: JSON.stringify([
          { id: "a1", name: "notes.md", mime: "text/markdown", size: 12, kind: "file" },
        ]),
        prompt_tokens: null, output_tokens: null, created_at: new Date().toISOString(),
      },
      {
        id: "m-asst", session_id: "s", role: "assistant",
        content: "Here is **bold** text and `code`.\n\n```ts\nconst x = 1;\n```",
        thinking: "considering the options",
        attachments_json: null, prompt_tokens: 10, output_tokens: 20,
        created_at: new Date().toISOString(),
      },
    ];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_messages") return messages as never;
      if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
      if (command === "get_session_memory_overrides") return [] as never;
      return undefined as never;
    });

    const id = sid();
    await sendMessage(id, "hello there", "model-1", { providerId: "provider-1" });
    const { container } = render(
      <MessageList
        sessionId={id}
        editingMessageId={null}
        setEditingMessageId={() => {}}
        collapsedThinking={new Set<number>()}
        setCollapsedThinking={() => {}}
        setContextMenu={() => {}}
        onBumpScroll={() => {}}
        onResend={async () => {}}
      />,
    );

    expect(container.querySelectorAll("[data-ctx]").length).toBeGreaterThanOrEqual(2);
    // Shadow and filter only. `transition-*` and `animate-message-in`
    // are permitted and are covered by the prose above.
    expect(paintViolations(container, [/^transition(-|$)/])).toEqual([]);
  });
});

/* ── the comparator half ────────────────────────────────────────────────
 *
 * `MessageRow` is wrapped in `React.memo` with a hand-written
 * comparator. Every prop the comparator forgets is a prop that cannot
 * cause a re-render, and the v0.6.5 lag bugs were exactly that. The
 * prop list is only in the type, so this reads `types.ts` for it — and
 * then checks the comparator behaviourally, through the `compare`
 * function React attaches to the memoized component, so the assertion is
 * about what the comparator does and not about what its source says.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readRepoFile = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

interface PropDecl { name: string; optional: boolean; type: string }

/** `MessageRowProps` as declared, parsed out of the source. */
function declaredRowProps(): PropDecl[] {
  const src = readRepoFile("src/components/chat/types.ts");
  const body = src.match(/export interface MessageRowProps \{([\s\S]*?)\n\}/);
  expect(body, "MessageRowProps must be a plain interface").toBeTruthy();
  return [...body![1].matchAll(/^\s*([A-Za-z_$][\w$]*)(\?)?:\s*([\s\S]*?);\s*$/gm)].map((m) => ({
    name: m[1], optional: m[2] === "?", type: m[3].trim(),
  }));
}

/** A callback is the one prop class the comparator is documented to ignore. */
const isCallback = (p: PropDecl) => p.type.includes("=>") || p.type.startsWith("Function");

function changedValue(value: unknown): unknown {
  if (value === null || value === undefined) return "\u241Fmutated";
  if (typeof value === "string") return `${value}\u241F`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value instanceof Set) return new Set([...value, 999]);
  if (Array.isArray(value)) return [...value, "\u241F"];
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = changedValue(v);
    return out;
  }
  return value;
}

const BASE_ROW_PROPS: MessageRowProps = {
  msg: {
    id: "m1", session_id: "s1", role: "assistant", content: "an answer",
    thinking: null, attachments_json: null, prompt_tokens: 1, output_tokens: 2,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  i: 0,
  sessionId: "s1",
  editingMessageId: null,
  setEditingMessageId: () => {},
  collapsedThinking: new Set<number>(),
  setCollapsedThinking: () => {},
  setContextMenu: () => {},
  onResend: async () => {},
};

describe("comparator guard: messageRowAreEqual accounts for every prop", () => {
  it("compares every prop that is not a callback", () => {
    const props = declaredRowProps();
    // React hangs the comparator off the memoized component, so the
    // guard reads the function that actually runs rather than the source
    // that defines it. Cast as present; the assertion below is what
    // proves it is.
    const compare = (MessageRow as unknown as {
      compare: (a: MessageRowProps, b: MessageRowProps) => boolean;
    }).compare;
    expect(typeof compare, "MessageRow must be memoized with a comparator").toBe("function");

    // Self-check: the prop list came from a regex, and an empty list
    // would make every assertion below pass for the wrong reason.
    expect(props.length).toBeGreaterThan(0);
    expect(props.map((p) => p.name)).toContain("msg");
    expect(props.map((p) => p.name)).toContain("i");

    for (const p of props) {
      if (isCallback(p)) continue;
      const changed = {
        ...BASE_ROW_PROPS,
        [p.name]: changedValue((BASE_ROW_PROPS as unknown as Record<string, unknown>)[p.name]),
      } as MessageRowProps;
      expect(
        compare(BASE_ROW_PROPS, changed),
        `messageRowAreEqual must return false when ${p.name} changes — add it to the comparator`,
      ).toBe(false);
    }
  });

  it("names every data prop in the comparator source", () => {
    // The behavioural check above is the real guard. This one exists so
    // the failure message names the prop and points at the file.
    const src = readRepoFile("src/components/chat/MessageRow.tsx");
    const start = src.indexOf("function messageRowAreEqual");
    const end = src.indexOf("export const MessageRow");
    expect(start, "messageRowAreEqual must exist").toBeGreaterThan(-1);
    expect(end, "MessageRow must be exported after the comparator").toBeGreaterThan(start);
    // Comments must not be able to satisfy this.
    const body = src.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

    for (const p of declaredRowProps()) {
      if (isCallback(p)) continue;
      expect(body, `the comparator must read ${p.name}`).toMatch(
        new RegExp(`\\b(?:prev|next)\\.${p.name}\\b`),
      );
    }
  });

  it("destructures exactly the declared props", () => {
    // The interface and the component must not drift apart, and this is
    // what stops a broken regex from turning the checks above into a
    // silent pass.
    const src = readRepoFile("src/components/chat/MessageRow.tsx");
    const destructured = src.match(/function MessageRow\(\{([\s\S]*?)\}\s*:\s*MessageRowProps\s*\)/);
    expect(destructured, "MessageRow must destructure its props").toBeTruthy();
    const names = destructured![1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(names).toEqual(declaredRowProps().map((p) => p.name).sort());
  });

  it("ignores callback identity, as documented", () => {
    const compare = (MessageRow as unknown as {
      compare: (a: MessageRowProps, b: MessageRowProps) => boolean;
    }).compare;
    expect(typeof compare, "MessageRow must be memoized with a comparator").toBe("function");
    // Callbacks close over `msg` and `i`, which *are* compared, so a
    // fresh function identity is still a valid closure. Comparing
    // identity would put every row back on the 60fps path.
    expect(compare(BASE_ROW_PROPS, {
      ...BASE_ROW_PROPS,
      setEditingMessageId: () => {},
      setCollapsedThinking: () => {},
      setContextMenu: () => {},
      onResend: async () => {},
    })).toBe(true);
    // An unchanged row still compares equal.
    expect(compare(BASE_ROW_PROPS, { ...BASE_ROW_PROPS })).toBe(true);
  });
});

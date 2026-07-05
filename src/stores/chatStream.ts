/**
 * Chat stream store — long-lived listener wiring + per-session state.
 *
 * The previous design registered Tauri `chat-*` event listeners in a
 * useEffect scoped to the ChatViewNew component. That meant: if the user
 * switched sessions while an assistant response was still streaming, the
 * component unmounted, the listeners were torn down, and the
 * `chat-done` event fired into the void — the assistant message never
 * got saved to the DB. When the user came back, the chat history was
 * effectively gone (only the user message, saved pre-stream, survived).
 *
 * This module fixes that by:
 *   1. Registering the 5 listeners exactly once, on first use, for the
 *      lifetime of the app.
 *   2. Keeping a Map<sessionId, SessionState> in module scope, so
 *      switching sessions never loses the in-flight or completed state.
 *   3. Exposing a Zustand store that the React layer subscribes to
 *      for reactive updates.
 */
import { create } from "zustand";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api, ChatMessage } from "../lib/api";
import { useMemoryStore } from "./memory";
import { playDoneSound, playSendSound } from "../utils/sounds";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "./toasts";

/** Default system prompt used when no memory context or override is set. */
const DEFAULT_SYSTEM = "You are a helpful, concise assistant. Give direct, accurate answers. Avoid rambling, repetition, and filler. If you don't know something, say so honestly.";

export interface SessionState {
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  error: string | null;
  loadingMessages: boolean;
  /** Monotonic counter incremented on each send. Used to reject
   * stale chat-cancelled events from a previous stream. */
  _streamGeneration?: number;
  /** Generation for which the user explicitly pressed Stop. */
  _cancelRequestedGeneration?: number;
}

const EMPTY: SessionState = {
  messages: [],
  streaming: false,
  streamContent: "",
  streamThinking: "",
  error: null,
  loadingMessages: false,
};

const stateBySession = new Map<string, SessionState>();
const unlisteners: UnlistenFn[] = [];
let listenersReady = false;

/** Sessions we've already auto-titled (one-shot, never re-fire). */
const autoTitled = new Set<string>();
/** Titles that count as "default" — eligible for auto-rename. */
const DEFAULT_TITLES = new Set(["", "New Chat", "Untitled"]);

/**
 * Frame-batched stream updates.
 *
 * The Tauri `chat-chunk` listener receives one event per token chunk
 * the model emits. With LLM bursts of 4-8 chunks in a 16ms frame,
 * a naive "mutate state + bump" per event drives 4-8 React re-renders
 * per frame — the browser coalesces paints but the React tree still
 * re-runs.
 *
 * The pattern (borrowed from opencode's global-sdk.tsx frame flusher):
 * the chunk listener writes the latest server-provided full text into
 * a per-session pending map and schedules a single rAF drain. The
 * drain mutates `streamContent` and bumps once per frame, regardless
 * of how many chunks arrived. The terminal events (`chat-done`,
 * `chat-error`, `chat-cancelled`) drain the pending entry for the
 * affected session synchronously before reading `streamContent`, so
 * the final message saved to the DB is not stale by one frame.
 */
const pendingFullContent = new Map<string, string>();
let flushRafScheduled = false;

function scheduleFlush() {
  if (flushRafScheduled) return;
  flushRafScheduled = true;
  requestAnimationFrame(() => {
    flushRafScheduled = false;
    for (const [cid, text] of pendingFullContent) {
      pendingFullContent.delete(cid);
      const s = getOrCreate(cid);
      if (s.streamContent !== text) {
        s.streamContent = text;
        bump(cid);
      }
    }
  });
}

function drainPendingFor(cid: string) {
  const pending = pendingFullContent.get(cid);
  if (pending === undefined) return;
  pendingFullContent.delete(cid);
  const s = getOrCreate(cid);
  s.streamContent = pending;
  // No bump here — the caller is about to bump for its own state
  // change (s.messages append, s.streaming=false, s.error=...). The
  // pending flush is folded into that re-render.
}

async function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;

  // chat-thinking
  unlisteners.push(
    await listen<{ conversation_id: string; thinking: string }>(
      "chat-thinking",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        s.streamThinking = e.payload.thinking;
        if (!s.streaming) s.streaming = true;
        bump(cid);
      }
    )
  );

  // chat-chunk — frame-batched. The Rust side already sends
  // full_content on every chunk (it holds the in-memory text);
  // we just take the latest one per session per frame.
  unlisteners.push(
    await listen<{ conversation_id: string; content: string; full_content: string }>(
      "chat-chunk",
      (e) => {
        const cid = e.payload.conversation_id;
        if (!pendingFullContent.has(cid)) {
          // First chunk for this session: ensure streaming is on.
          const s = getOrCreate(cid);
          if (!s.streaming) s.streaming = true;
        }
        pendingFullContent.set(cid, e.payload.full_content);
        scheduleFlush();
      }
    )
  );

  // chat-done
  unlisteners.push(
    await listen<{
      conversation_id: string;
      prompt_tokens: number | null;
      output_tokens: number | null;
      completed_at: string;
    }>("chat-done", (e) => {
      const cid = e.payload.conversation_id;
      // Drain any pending chunk for this session. The terminal
      // event may arrive between two rAF drains; we need the
      // latest server text in the saved message.
      drainPendingFor(cid);
      const s = getOrCreate(cid);
      const thinking = (s.streamThinking || "").trim() || null;
      s.streaming = false;
      if (s.streamContent) {
        s.messages = [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            session_id: cid,
            role: "assistant",
            content: s.streamContent,
            thinking,
            attachments_json: null,
            prompt_tokens: e.payload.prompt_tokens ?? null,
            output_tokens: e.payload.output_tokens ?? null,
            created_at: e.payload.completed_at,
          },
        ];
      }
      s.streamContent = "";
      s.streamThinking = "";
      // Persist to DB unconditionally — the user may have navigated
      // away and we still need the final state on disk.
      api.saveMessages(cid, s.messages).catch((e) => {
        console.error("saveMessages (chat-done):", e);
      });

      // One-shot auto-title: if the user hasn't renamed the session and
      // we haven't already kicked off the LLM call for it, ask the LLM
      // for a short title derived from the first user message.
      maybeAutoTitle(cid, s.messages);

      playDoneSound(false);
      if (typeof document !== "undefined" && document.hidden) {
        try {
          sendNotification({ title: "Convo", body: "Response complete" });
        } catch { /* ignore */ }
      }
      bump(cid);
    })
  );

  // chat-error
  unlisteners.push(
    await listen<{ conversation_id: string; error: string }>(
      "chat-error",
      (e) => {
        const cid = e.payload.conversation_id;
        drainPendingFor(cid);
        const s = getOrCreate(cid);
        s.streaming = false;
        s.error = e.payload.error;
        // Persist whatever we have so the user message isn't lost
        api.saveMessages(cid, s.messages).catch((err) => {
          console.error("saveMessages (chat-error):", err);
        });
        toast.error(e.payload.error, "Chat error");
        bump(cid);
      }
    )
  );

  // chat-cancelled
  unlisteners.push(
    await listen<string>("chat-cancelled", (e) => {
      const cid = e.payload;
      drainPendingFor(cid);
      const s = getOrCreate(cid);
      const streamGeneration = s._streamGeneration ?? 0;
      const cancelRequestedGeneration = s._cancelRequestedGeneration ?? -1;
      // Ignore stale chat-cancelled events caused by an old Rust
      // cancel token being dropped/replaced. Real user cancellation
      // always goes through stopStream(), which marks the current
      // generation before invoking cancel_chat_v2.
      if (s.streaming && cancelRequestedGeneration !== streamGeneration) {
        return;
      }
      s.streaming = false;
      const thinking = (s.streamThinking || "").trim() || null;
      if (s.streamContent) {
        s.messages = [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            session_id: cid,
            role: "assistant",
            content: s.streamContent + " [stopped]",
            thinking,
            attachments_json: null,
            prompt_tokens: null,
            output_tokens: null,
            created_at: new Date().toISOString(),
          },
        ];
      }
      s.streamContent = "";
      s.streamThinking = "";
      api.saveMessages(cid, s.messages).catch((err) => {
        console.error("saveMessages (chat-cancelled):", err);
      });
      bump(cid);
    })
  );
}

function getOrCreate(id: string): SessionState {
  let s = stateBySession.get(id);
  if (!s) {
    s = { ...EMPTY, messages: [] };
    stateBySession.set(id, s);
  }
  return s;
}

function bump(cid: string) {
  // Bump a per-session version counter so subscribers re-render.
  useChatStreamStore.setState((prev) => ({
    version: prev.version + 1,
    sessions: { ...prev.sessions, [cid]: { ...getOrCreate(cid) } },
  }));
}

interface ChatStreamStore {
  /** Per-session state snapshots for components to subscribe to. */
  sessions: Record<string, SessionState>;
  /** Increments on any per-session change. Used to force re-renders. */
  version: number;
  /** Internal: tracks which sessions have been loaded from DB. */
  _loaded: Record<string, boolean>;
}

export const useChatStreamStore = create<ChatStreamStore>(() => ({
  sessions: {},
  version: 0,
  _loaded: {},
}));

export async function loadSessionMessages(cid: string): Promise<ChatMessage[]> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (s.messages.length > 0 || s.loadingMessages) {
    return s.messages;
  }
  s.loadingMessages = true;
  bump(cid);
  try {
    const msgs = await api.listMessages(cid);
    s.messages = msgs;
    return msgs;
  } finally {
    s.loadingMessages = false;
    bump(cid);
  }
}

export function getSessionState(cid: string): SessionState {
  return stateBySession.get(cid) ?? EMPTY;
}

export async function clearSessionMessages(cid: string) {
  await ensureListeners();
  const s = getOrCreate(cid);
  s.messages = [];
  s.streaming = false;
  s.streamContent = "";
  s.streamThinking = "";
  s.error = null;
  bump(cid);
  try {
    await api.saveMessages(cid, []);
  } catch (e) {
    console.error("clearSessionMessages:", e);
  }
}

export interface SendOpts {
  systemOverride?: string;
  attachmentsJson?: string | null;
  temperature?: number;
}

export async function sendMessage(
  cid: string,
  text: string,
  model: string,
  opts: SendOpts = {}
): Promise<void> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (s.streaming) return;
  s.error = null;
  // Single source of truth for the user message: create it here,
  // not in the calling component. This prevents the double-append
  // bug where onSend creates a message, saves to DB, then sendMessage
  // creates a second one with a different UUID.
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    session_id: cid,
    role: "user",
    content: text,
    thinking: null,
    attachments_json: opts.attachmentsJson ?? null,
    prompt_tokens: null,
    output_tokens: null,
    created_at: new Date().toISOString(),
  };
  s.messages = [...s.messages, userMsg];
  s.streaming = true;
  s.streamContent = "";
  s.streamThinking = "";
  // Increment generation counter so stale chat-cancelled events
  // from a previous stream are rejected in the handler.
  s._streamGeneration = (s._streamGeneration ?? 0) + 1;
  s._cancelRequestedGeneration = undefined;
  bump(cid);
  playSendSound(false);

  // Persist the user message to DB immediately so it survives even
  // if the stream connection fails before chat-done fires.
  api.saveMessages(cid, s.messages).catch(() => {});

  const memoryBlock = await useMemoryStore.getState().buildContextBlock(cid);
  const fullSystem = [opts.systemOverride, memoryBlock].filter(Boolean).join("\n\n") || undefined;
  // Truncate conversation history before sending to the LLM.
  // Keep the last 41 messages (~20 pairs + 1) to avoid context
  // overflow and model-repetition degredation on long conversations.
  const MAX_HISTORY = 41;
  const truncated = s.messages.length > MAX_HISTORY
    ? s.messages.slice(-MAX_HISTORY)
    : s.messages;
  const cleanMessages = truncated.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));

  try {
    await api.chatStream({
      sessionId: cid,
      model,
      messages: cleanMessages,
      system: fullSystem || DEFAULT_SYSTEM,
      temperature: opts.temperature ?? 0.7,
    });
  } catch (e) {
    s.streaming = false;
    s.error = String(e);
    toast.error(String(e), "Send failed");
    bump(cid);
  }
}

export async function stopStream(cid: string) {
  const s = getOrCreate(cid);
  s._cancelRequestedGeneration = s._streamGeneration ?? 0;
  try {
    await api.cancelChat(cid);
  } catch (e) {
    console.error("cancelChat:", e);
  }
}

async function maybeAutoTitle(cid: string, messages: ChatMessage[]) {
  if (autoTitled.has(cid)) return;
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser || !firstUser.content.trim()) return;
  // Mark up-front so concurrent chat-dones don't double-fire.
  autoTitled.add(cid);
  try {
    // Look up the current title; if user already renamed, skip.
    const sessions = await api.listSessions();
    const session = sessions.find((s) => s.id === cid);
    if (!session) return;
    if (!DEFAULT_TITLES.has(session.title.trim())) return;
    const title = await api.generateSessionTitle(firstUser.content);
    if (!title || !title.trim()) return;
    if (title.length > 80) return; // sanity cap
    await api.renameSession(cid, title);
    // Tell the sessions store to refresh so the sidebar updates.
    try {
      // Lazy import to avoid a hard dep cycle at module load
      const { useSessionsStore } = await import("./sessions");
      useSessionsStore.getState().refresh();
    } catch (e) {
      console.error("refresh sessions after rename:", e);
    }
  } catch (e) {
    // Don't keep the session in autoTitled if generation failed — let
    // the next chat-done try again.
    autoTitled.delete(cid);
    console.error("auto-title:", e);
  }
}

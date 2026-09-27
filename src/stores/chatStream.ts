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
import { api, AppliedRevision, ChatMessage } from "../lib/api";
import { useMemoryStore } from "./memory";
import { playDoneSound, playSendSound } from "../utils/sounds";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "./toasts";

function imageDataForMessage(message: ChatMessage): string[] {
  if (!message.attachments_json) return [];
  try {
    const attachments: unknown = JSON.parse(message.attachments_json);
    if (!Array.isArray(attachments)) return [];
    return attachments
      .filter((attachment): attachment is { kind?: string; mime?: string; dataBase64?: string } =>
        typeof attachment === "object" && attachment !== null
      )
      .filter((attachment) =>
        (attachment.kind === "image" || attachment.mime?.startsWith("image/"))
        && typeof attachment.dataBase64 === "string"
      )
      .map((attachment) => attachment.dataBase64!);
  } catch {
    return [];
  }
}

export interface SessionState {
  messages: ChatMessage[];
  status: ChatStatus;
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
  /** Model + provider used for the most recent send. Used by the
   * auto-eval hook so the same model that answered the chat is the
   * one that proposes memory facts. */
  _lastModel?: string;
  _lastProviderId?: string;
  _streamId?: string;
  _assistantMessageId?: string;
}

export type ChatStatus =
  | "idle"
  | "sending"
  | "streaming"
  | "stopping"
  | "failed"
  | "stopped"
  | "complete";

const EMPTY: SessionState = {
  messages: [],
  status: "idle",
  streaming: false,
  streamContent: "",
  streamThinking: "",
  error: null,
  loadingMessages: false,
};

const stateBySession = new Map<string, SessionState>();
const terminalStreams = new Set<string>();

function isConversationOpen(cid: string): boolean {
  if (typeof window === "undefined") return false;
  const route = window.location.hash.replace(/^#/, "").split(/[?#]/, 1)[0];
  const [, section, encodedConversationId] = route.split("/");
  if (section !== "chat" || !encodedConversationId) return false;
  try {
    return decodeURIComponent(encodedConversationId) === cid;
  } catch {
    return false;
  }
}

export function shouldNotifyForCompletedConversation(cid: string): boolean {
  return typeof document === "undefined" || document.hidden || !isConversationOpen(cid);
}

export function evictSessionState(cid: string): void {
  const state = stateBySession.get(cid);
  if (state?.streaming) return;
  stateBySession.delete(cid);
  pendingDeltas.forEach((pending, key) => {
    if (pending.cid === cid) pendingDeltas.delete(key);
  });
  sessionLoads.delete(cid);
  stopTimers.delete(cid);
  useChatStreamStore.setState((current) => {
    if (!(cid in current.sessions)) return current;
    const sessions = { ...current.sessions };
    delete sessions[cid];
    return { sessions };
  });
}

function eventStreamKey(cid: string, streamId: string): string {
  return `${cid}:${streamId}`;
}

function isCurrentStream(s: SessionState, streamId: string): boolean {
  return streamId.length > 0 && !!s._streamId && s._streamId === streamId;
}

export function acceptTerminalEvent(cid: string, streamId: string): boolean {
  const key = eventStreamKey(cid, streamId);
  if (terminalStreams.has(key)) return false;
  terminalStreams.add(key);
  if (terminalStreams.size > 256) {
    const oldest = terminalStreams.values().next().value;
    if (oldest) terminalStreams.delete(oldest);
  }
  return true;
}
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
 * the model emits. Those handlers deliberately mutate the working
 * session WITHOUT publishing, and this drain is the only thing that
 * publishes for them — that is what makes one render per frame instead
 * of one per chunk. With LLM bursts of 4-8 chunks in a 16ms frame,
 * a naive publish per event drives 4-8 React re-renders
 * per frame — the browser coalesces paints but the React tree still
 * re-runs.
 *
 * The listeners append content and thinking deltas into a stream-keyed
 * pending map and schedule a single rAF drain. Terminal events drain their
 * stream synchronously before reading `streamContent`, so the final message
 * is not stale by one frame.
 */
interface PendingDeltas {
  cid: string;
  streamId: string;
  content: string;
  thinking: string;
}

const pendingDeltas = new Map<string, PendingDeltas>();
let flushRafScheduled = false;

function scheduleFlush() {
  if (flushRafScheduled) return;
  flushRafScheduled = true;
  requestAnimationFrame(() => {
    flushRafScheduled = false;
    for (const [key, pending] of pendingDeltas) {
      pendingDeltas.delete(key);
      const s = getOrCreate(pending.cid);
      if (!isCurrentStream(s, pending.streamId)) continue;
      // Re-check at drain time: a terminal event may have closed the
      // stream between staging and this frame.
      if (!s.streaming) continue;
      s.streamContent += pending.content;
      s.streamThinking += pending.thinking;
      if (pending.content || pending.thinking) publish(pending.cid);
    }
  });
}

function drainPendingFor(cid: string, streamId: string) {
  const key = eventStreamKey(cid, streamId);
  const pending = pendingDeltas.get(key);
  if (!pending) return;
  pendingDeltas.delete(key);
  const s = getOrCreate(cid);
  if (!isCurrentStream(s, streamId)) return;
  s.streamContent += pending.content;
  s.streamThinking += pending.thinking;
}

interface StreamEventBase {
  conversation_id: string;
  stream_id: string;
  assistant_message_id: string;
}

function isCurrentEvent(s: SessionState, event: StreamEventBase): boolean {
  return isCurrentStream(s, event.stream_id)
    && !!s._assistantMessageId
    && s._assistantMessageId === event.assistant_message_id;
}

/**
 * Say what the revision table just did.
 *
 * The old path ended with candidates sitting in an inbox for a human to
 * sort out, so the user could always see what memory wanted. The revision
 * table writes the confident rows and leaves the ambiguous ones in the
 * inbox, which means a turn can now change memory without anything on
 * screen. That is correct and it is also invisible, so it gets one line —
 * and only when there is something to say: a round that found nothing
 * durable returns an empty list, and that is the common case, so staying
 * silent there is what keeps the signal worth reading.
 *
 * Three buckets because they are not the same claim. A new row and an
 * updated one are both "remembered" in the loose sense, but only the new
 * one is something the user will see appear in the Memory tab, and an
 * inbox row is not a write at all.
 */
export function reportRevisions(applied: AppliedRevision[]) {
  const count = (effects: AppliedRevision["effect"][]) =>
    applied.filter((entry) => effects.includes(entry.effect)).length;
  const parts: string[] = [];
  const added = count(["added", "superseded"]);
  const updated = count(["reinforced", "merged"]);
  const inbox = count(["sentToReview"]);
  if (added) parts.push(`${added} remembered`);
  if (updated) parts.push(`${updated} updated`);
  if (inbox) parts.push(`${inbox} need${inbox === 1 ? "s" : ""} review`);
  if (!parts.length) return;
  toast.info(parts.join(", "), "Memory");
}

function appendAssistantMessage(
  s: SessionState,
  cid: string,
  assistantMessageId: string,
  content: string,
  thinking: string | null,
  promptTokens: number | null,
  outputTokens: number | null,
  createdAt: string,
) {
  if (!content || s.messages.some((message) => message.id === assistantMessageId)) return;
  s.messages = [
    ...s.messages,
    {
      id: assistantMessageId,
      session_id: cid,
      role: "assistant",
      content,
      thinking,
      attachments_json: null,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      created_at: createdAt,
    },
  ];
}

async function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;

  // chat-thinking
  unlisteners.push(
    await listen<StreamEventBase & { delta: string }>(
      "chat-thinking",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        // A closed stream accepts nothing. Without this, a chunk that
        // arrives after `chat-done` / `chat-cancelled` — which clear
        // neither _streamId nor _assistantMessageId — passes validation,
        // sets streaming back to true, and resurrects a phantom tail on a
        // message that was already saved.
        if (!s.streaming) return;
        const key = eventStreamKey(cid, e.payload.stream_id);
        const pending = pendingDeltas.get(key) ?? {
          cid,
          streamId: e.payload.stream_id,
          content: "",
          thinking: "",
        };
        pending.thinking += e.payload.delta;
        pendingDeltas.set(key, pending);
        s.streaming = true;
        s.status = "streaming";
        scheduleFlush();
      }
    )
  );

  // chat-chunk — frame-batched deltas; avoid resending the accumulated prefix.
  unlisteners.push(
    await listen<StreamEventBase & { delta: string }>(
      "chat-chunk",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        if (!s.streaming) return;
        const key = eventStreamKey(cid, e.payload.stream_id);
        const pending = pendingDeltas.get(key) ?? {
          cid,
          streamId: e.payload.stream_id,
          content: "",
          thinking: "",
        };
        pending.content += e.payload.delta;
        pendingDeltas.set(key, pending);
        s.streaming = true;
        s.status = "streaming";
        scheduleFlush();
      }
    )
  );

  // chat-done
  unlisteners.push(
    await listen<StreamEventBase & {
      prompt_tokens: number | null;
      output_tokens: number | null;
      completed_at: string;
    }>("chat-done", (e) => {
      const cid = e.payload.conversation_id;
      const s = getOrCreate(cid);
      if (!isCurrentEvent(s, e.payload)) return;
      if (!acceptTerminalEvent(cid, e.payload.stream_id)) return;
      clearStopTimer(cid);
      drainPendingFor(cid, e.payload.stream_id);
      const thinking = (s.streamThinking || "").trim() || null;
      appendAssistantMessage(
        s,
        cid,
        e.payload.assistant_message_id,
        s.streamContent,
        thinking,
        e.payload.prompt_tokens,
        e.payload.output_tokens,
        e.payload.completed_at,
      );
      s.status = "complete";
      s.streaming = false;
      s.streamContent = "";
      s.streamThinking = "";

      // Rust owns durable assistant persistence. This event only updates
      // presentation state, so navigation cannot lose a completed turn.
      maybeAutoTitle(cid, s.messages);

      const gen = s._streamGeneration ?? 0;
      const lastModel = s._lastModel;
      const lastProvider = s._lastProviderId;
      if (gen >= 2) {
        import("../stores/settings").then(({ useSettingsStore }) => {
          if (!useSettingsStore.getState().memoryAutoEvaluate) return;
          void useMemoryStore.getState()
            .extractAndRevise(cid, lastModel, lastProvider)
            .then(reportRevisions)
            .catch(console.error);
        }).catch(console.error);
      }

      playDoneSound(false);
      if (shouldNotifyForCompletedConversation(cid)) {
        try {
          sendNotification({ title: "Convo", body: "Response complete" });
        } catch { /* ignore */ }
      }
      publish(cid);
    })
  );

  // chat-error
  unlisteners.push(
    await listen<StreamEventBase & { error: string; completed_at: string }>(
      "chat-error",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        if (!acceptTerminalEvent(cid, e.payload.stream_id)) return;
        clearStopTimer(cid);
        drainPendingFor(cid, e.payload.stream_id);
        const thinking = (s.streamThinking || "").trim() || null;
        appendAssistantMessage(
          s,
          cid,
          e.payload.assistant_message_id,
          s.streamContent,
          thinking,
          null,
          null,
          e.payload.completed_at,
        );
        s.streaming = false;
        s.status = "failed";
        s.error = e.payload.error;
        s.streamContent = "";
        s.streamThinking = "";
        toast.error(e.payload.error, "Chat error");
        publish(cid);
      }
    )
  );

  // chat-cancelled
  unlisteners.push(
    await listen<StreamEventBase & { completed_at: string }>("chat-cancelled", (e) => {
      const cid = e.payload.conversation_id;
      const s = getOrCreate(cid);
      if (!isCurrentEvent(s, e.payload)) return;
      const streamGeneration = s._streamGeneration ?? 0;
      const cancelRequestedGeneration = s._cancelRequestedGeneration ?? -1;
      // Ignore stale chat-cancelled events caused by an old Rust
      // cancel token being dropped/replaced. Real user cancellation
      // always goes through stopStream(), which marks the current
      // generation before invoking cancel_chat_v2.
      if (s.streaming && cancelRequestedGeneration !== streamGeneration) {
        return;
      }
      if (!acceptTerminalEvent(cid, e.payload.stream_id)) return;
      clearStopTimer(cid);
      drainPendingFor(cid, e.payload.stream_id);
      s.streaming = false;
      s.status = "stopped";
      const thinking = (s.streamThinking || "").trim() || null;
      appendAssistantMessage(
        s,
        cid,
        e.payload.assistant_message_id,
        s.streamContent ? `${s.streamContent} [stopped]` : "",
        thinking,
        null,
        null,
        e.payload.completed_at,
      );
      s.streamContent = "";
      s.streamThinking = "";
      publish(cid);
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

/**
 * Republish a session so subscribers see the mutations made to it.
 *
 * The session object itself is mutated in place, which is what keeps
 * `s.messages` reference-stable across a stream — the identity of the
 * *published* object is the change signal, not the inner one.
 *
 * Prefer `mutate`. This is separate only for the two cases that need to
 * publish without an accompanying mutation: staging a chunk for the
 * frame batch, and republishing after an async boundary.
 */
function publish(cid: string): void {
  useChatStreamStore.setState((prev) => ({
    sessions: { ...prev.sessions, [cid]: { ...getOrCreate(cid) } },
  }));
}

/**
 * Apply a mutation to a session and publish it, atomically.
 *
 * The point of fusing the two: this store used to mutate a session and
 * then call a separate `bump`, and forgetting the bump produced a
 * silently stale UI. There is no way to skip the publish here.
 *
 * Do NOT use this on the chunk hot path. `chat-chunk` arrives several
 * times per frame; publishing per chunk would defeat the frame batching
 * that keeps the tail at 60fps. Those handlers stage into `pendingDeltas`
 * and let the rAF drain publish once.
 */
function mutate(cid: string, fn: (s: SessionState) => void): void {
  const s = getOrCreate(cid);
  fn(s);
  publish(cid);
}

/** The reactive slice a streaming component needs from one session. */
export interface StreamSlice {
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  status: ChatStatus;
  error: string | null;
}

/**
 * Projections are cached against the published session object.
 *
 * A selector that builds a fresh object literal on every call defeats
 * zustand's `Object.is` comparison: every unrelated store notification
 * would look like a change to every subscriber, which is the 60fps
 * re-render storm this whole arrangement exists to avoid. `publish`
 * creates a new session object per mutation, so the cache misses once
 * per real change and hits forever after.
 */
const sliceCache = new WeakMap<SessionState, StreamSlice>();

/**
 * Select one session's stream slice in a single subscription.
 *
 * Prefer this over three separate `useChatStreamStore` calls when a
 * component needs more than one streaming field. Do NOT widen a
 * component's subscription to the whole session.
 */
export function selectStreamSlice(sessionId: string) {
  return (s: ChatStreamStore): StreamSlice | undefined => {
    const session = s.sessions[sessionId];
    if (!session) return undefined;
    let slice = sliceCache.get(session);
    if (!slice) {
      slice = {
        streaming: session.streaming,
        streamContent: session.streamContent,
        streamThinking: session.streamThinking,
        status: session.status,
        error: session.error,
      };
      sliceCache.set(session, slice);
    }
    return slice;
  };
}

/**
 * Select one session's message list.
 *
 * The array reference is stable across stream updates, so a subscriber
 * re-renders only when a message is added, removed, or edited. If this
 * ever starts returning a fresh array per chunk, MessageList re-renders
 * at 60fps and the v0.6.5 lag regression is back.
 */
export function selectMessages(sessionId: string) {
  return (s: ChatStreamStore): ChatMessage[] | undefined => s.sessions[sessionId]?.messages;
}

interface ChatStreamStore {
  /** Per-session state snapshots for components to subscribe to. */
  sessions: Record<string, SessionState>;
}

export const useChatStreamStore = create<ChatStreamStore>(() => ({
  sessions: {},
}));

const sessionLoads = new Map<string, Promise<ChatMessage[]>>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearStopTimer(cid: string) {
  const timer = stopTimers.get(cid);
  if (timer) clearTimeout(timer);
  stopTimers.delete(cid);
}

export async function loadSessionMessages(cid: string): Promise<ChatMessage[]> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (s.messages.length > 0 && !s.loadingMessages) {
    return s.messages;
  }
  const existing = sessionLoads.get(cid);
  if (existing) return existing;
  const load = (async () => {
    s.loadingMessages = true;
    publish(cid);
    try {
      const msgs = (await api.listMessages(cid)) ?? [];
      if (s.messages.length === 0 && !s.streaming) s.messages = msgs;
      return s.messages;
    } finally {
      s.loadingMessages = false;
      publish(cid);
      sessionLoads.delete(cid);
    }
  })();
  sessionLoads.set(cid, load);
  return load;
}

export async function reloadSessionMessages(cid: string): Promise<ChatMessage[]> {
  await ensureListeners();
  const s = getOrCreate(cid);
  s.loadingMessages = true;
  publish(cid);
  try {
    const msgs = (await api.listMessages(cid)) ?? [];
    s.messages = msgs;
    return msgs;
  } finally {
    s.loadingMessages = false;
    publish(cid);
  }
}

export function getSessionState(cid: string): SessionState {
  return stateBySession.get(cid) ?? EMPTY;
}

export async function clearSessionMessages(cid: string) {
  await ensureListeners();
  pendingDeltas.forEach((pending, key) => {
    if (pending.cid === cid) pendingDeltas.delete(key);
  });
  clearStopTimer(cid);
  mutate(cid, (s) => {
    s.messages = [];
    s.status = "idle";
    s.streaming = false;
    s.streamContent = "";
    s.streamThinking = "";
    s.error = null;
    s._streamId = undefined;
    s._assistantMessageId = undefined;
  });
  try {
    await api.clearMessages(cid);
  } catch (e) {
    console.error("clearSessionMessages:", e);
  }
}

export interface SendOpts {
  systemOverride?: string;
  attachmentsJson?: string | null;
  temperature?: number;
  /** Provider id backing `model`. Tracked on SessionState so the
   * auto-eval hook can request facts extraction using the same
   * model that just answered. */
  providerId?: string;
}

export async function sendMessage(
  cid: string,
  text: string,
  model: string,
  opts: SendOpts = {}
): Promise<void> {
  await ensureListeners();
  await loadSessionMessages(cid);
  const s = getOrCreate(cid);
  if (s.streaming) return;
  s.error = null;
  s.status = "sending";
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
  s._streamId = crypto.randomUUID();
  s._assistantMessageId = crypto.randomUUID();
  terminalStreams.delete(eventStreamKey(cid, s._streamId));
  s._lastModel = model;
  s._lastProviderId = opts.providerId;
  publish(cid);
  playSendSound(false);

  // Persist the user message to DB immediately so it survives even
  // if the stream connection fails before chat-done fires.
  try {
    await api.upsertMessage(userMsg);
  } catch (e) {
    s.messages = s.messages.filter((message) => message.id !== userMsg.id);
    s.streaming = false;
    s.status = "failed";
    publish(cid);
    throw e;
  }

  // Rust assembles the persona, the memory block, and the directive. The
  // frontend sends the user's override and nothing else.
  const fullSystem = opts.systemOverride;
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
    ...(() => {
      const images = imageDataForMessage(m);
      return images.length > 0 ? { images } : {};
    })(),
  }));

  try {
    s.status = "streaming";
    publish(cid);
    await api.chatStream({
      sessionId: cid,
      model,
      messages: cleanMessages,
      system: fullSystem,
      temperature: opts.temperature ?? 0.7,
      streamId: s._streamId,
      assistantMessageId: s._assistantMessageId,
    });
  } catch (e) {
    s.streaming = false;
    s.status = "failed";
    s.error = String(e);
    toast.error(String(e), "Send failed");
    publish(cid);
  }
}

export async function stopStream(cid: string) {
  const s = getOrCreate(cid);
  if (!s.streaming || !s._streamId) return;
  s._cancelRequestedGeneration = s._streamGeneration ?? 0;
  s.status = "stopping";
  publish(cid);
  try {
    await api.cancelChat(cid, s._streamId);
    clearStopTimer(cid);
    stopTimers.set(cid, setTimeout(() => {
      const current = getOrCreate(cid);
      if (current.status !== "stopping") return;
      const thinking = (current.streamThinking || "").trim() || null;
      appendAssistantMessage(
        current,
        cid,
        current._assistantMessageId ?? crypto.randomUUID(),
        current.streamContent ? `${current.streamContent} [stopped]` : "",
        thinking,
        null,
        null,
        new Date().toISOString(),
      );
      current.streaming = false;
      current.status = "stopped";
      current.error = "Stop request timed out";
      current.streamContent = "";
      current.streamThinking = "";
      publish(cid);
      stopTimers.delete(cid);
    }, 5000));
  } catch (e) {
    s.status = "failed";
    s.error = String(e);
    publish(cid);
    console.error("cancelChat:", e);
  }
}

export async function retryLastMessage(
  cid: string,
  model: string,
  opts: SendOpts = {},
): Promise<void> {
  const s = getOrCreate(cid);
  if (s.streaming) return;
  const lastUser = [...s.messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return;
  await api.truncateMessages(cid, lastUser.id);
  await reloadSessionMessages(cid);
  await sendMessage(cid, lastUser.content, model, {
    ...opts,
    attachmentsJson: opts.attachmentsJson ?? lastUser.attachments_json,
  });
}

async function maybeAutoTitle(cid: string, messages: ChatMessage[]) {
  if (autoTitled.has(cid)) return;
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser || !firstUser.content.trim()) return;
  // Mark up-front so concurrent chat-dones don't double-fire.
  autoTitled.add(cid);
  try {
    // Look up the current title; if user already renamed, skip.
    const sessions = (await api.listSessions()) ?? [];
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

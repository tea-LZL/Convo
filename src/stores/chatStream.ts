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
import { formatMemoryRecallBlock, rankMemoryRecall } from "../lib/memoryRecall";
import {
  formatMessageResources,
  parseMessageResources,
  sourceCharBudget,
  type MessageResource,
} from "../lib/messageResources";
import { useMemoryStore } from "./memory";
import { playDoneSound, playSendSound } from "../utils/sounds";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "./toasts";

/** Default system prompt used when no memory context or override is set. */
export const DEFAULT_SYSTEM = [
  "You are a helpful, concise assistant. Give direct, accurate answers.",
  "Avoid rambling, repetition, and filler.",
  "If you don't know something, say so honestly.",
  "IMPORTANT: If memory or user context is provided below, use it. " +
    "When the user asks who they are or about their name, preferences, " +
    "projects, or environment, answer from the provided context.",
].join(" ");

function imageDataForResources(resources: readonly MessageResource[]): string[] {
  return resources.flatMap((resource) => {
    if (
      resource.sourceType !== "file"
      || resource.kind !== "image"
      || typeof resource.dataBase64 !== "string"
      || resource.dataBase64.trim().length === 0
    ) {
      return [];
    }
    return [resource.dataBase64];
  });
}

function hasSourceText(resources: readonly MessageResource[]): boolean {
  return resources.some((resource) =>
    typeof resource.agentText === "string" && resource.agentText.length > 0
  );
}

export interface ProviderMessage {
  role: ChatMessage["role"];
  content: string;
  thinking?: string;
  images?: string[];
}

function buildProviderMessageFromResources(
  message: ChatMessage,
  resources: readonly MessageResource[],
  contextLength?: number | null,
  sourceTextBudget?: number,
): ProviderMessage {
  const sourceContext = message.role === "user" && resources.length > 0
    ? formatMessageResources(resources, contextLength, sourceTextBudget)
    : "";
  const images = imageDataForResources(resources);

  return {
    role: message.role,
    content: sourceContext ? `${message.content}\n\n${sourceContext}` : message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Assemble one persisted message for the provider boundary. Source snapshots
 * are reference data for user turns only; the persisted message stays raw.
 */
export function buildProviderMessage(
  message: ChatMessage,
  contextLength?: number | null,
): ProviderMessage {
  return buildProviderMessageFromResources(
    message,
    parseMessageResources(message.attachments_json),
    contextLength,
  );
}

export function buildProviderMessages(
  messages: readonly ChatMessage[],
  contextLength?: number | null,
): ProviderMessage[] {
  const resourcesByMessage = messages.map((message) =>
    parseMessageResources(message.attachments_json)
  );
  const sourceTextByMessage = messages.map((message, index) =>
    message.role === "user" && hasSourceText(resourcesByMessage[index])
  );
  const sourceBearingMessageCount = sourceTextByMessage.filter(Boolean).length;
  const perMessageSourceTextBudget = sourceBearingMessageCount > 0
    ? Math.floor(sourceCharBudget(contextLength) / sourceBearingMessageCount)
    : undefined;

  return messages.map((message, index) => buildProviderMessageFromResources(
    message,
    resourcesByMessage[index],
    contextLength,
    sourceTextByMessage[index] ? perMessageSourceTextBudget : undefined,
  ));
}

export function composeSystemPrompt(parts: {
  override?: string;
  alwaysOnMemory?: string;
  recalledMemory?: string;
}): string {
  return [DEFAULT_SYSTEM, parts.override, parts.alwaysOnMemory, parts.recalledMemory]
    .filter(Boolean)
    .join("\n\n");
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
const resendLocks = new Map<string, ResendLock>();
const clearLocks = new Set<string>();
let nextResendLockToken = 0;
const terminalStreams = new Set<string>();
const invalidatedStreams = new Set<string>();

export interface ResendLock {
  readonly cid: string;
  readonly token: number;
}

const RESEND_BUSY_MESSAGE = "A resend or recovery is already in progress.";

export function isResendLocked(cid: string): boolean {
  return resendLocks.has(cid);
}

export function acquireResendLock(cid: string): ResendLock | null {
  if (resendLocks.has(cid) || clearLocks.has(cid)) return null;
  if (getOrCreate(cid).streaming) return null;
  const lock: ResendLock = { cid, token: ++nextResendLockToken };
  resendLocks.set(cid, lock);
  return lock;
}

export function isClearLocked(cid: string): boolean {
  return clearLocks.has(cid);
}

export function releaseResendLock(lock: ResendLock): void {
  if (resendLocks.get(lock.cid)?.token === lock.token) {
    resendLocks.delete(lock.cid);
  }
}

function ownsResendLock(lock: ResendLock): boolean {
  return resendLocks.get(lock.cid)?.token === lock.token;
}

function resendBusyError(): Error {
  return new Error(RESEND_BUSY_MESSAGE);
}

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
  if (state?.streaming || resendLocks.has(cid) || clearLocks.has(cid)) return;
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
    const loaded = { ...current._loaded };
    delete loaded[cid];
    return { sessions, _loaded: loaded, version: current.version + 1 };
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
  if (terminalStreams.has(key) || invalidatedStreams.has(key)) return false;
  tombstoneStream(cid, streamId, false);
  return true;
}

function tombstoneStream(cid: string, streamId: string, discardPending = true): void {
  if (!streamId) return;
  const key = eventStreamKey(cid, streamId);
  terminalStreams.add(key);
  if (terminalStreams.size > 256) {
    const oldestTerminal = terminalStreams.values().next().value;
    if (oldestTerminal) terminalStreams.delete(oldestTerminal);
  }
  invalidatedStreams.add(key);
  if (discardPending) pendingDeltas.delete(key);
  if (invalidatedStreams.size > 512) {
    const oldest = invalidatedStreams.values().next().value;
    if (oldest) invalidatedStreams.delete(oldest);
  }
}
const unlisteners: UnlistenFn[] = [];
let listenersReady = false;
let listenersPromise: Promise<void> | null = null;

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
      s.streamContent += pending.content;
      s.streamThinking += pending.thinking;
      if (pending.content || pending.thinking) bump(pending.cid);
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
  const key = eventStreamKey(event.conversation_id, event.stream_id);
  return !terminalStreams.has(key)
    && !invalidatedStreams.has(key)
    && isCurrentStream(s, event.stream_id)
    && !!s._assistantMessageId
    && s._assistantMessageId === event.assistant_message_id;
}

function ignoreTerminalAfterStop(
  cid: string,
  s: SessionState,
  event: StreamEventBase,
): boolean {
  const generation = s._streamGeneration;
  if (generation === undefined || s._cancelRequestedGeneration !== generation) return false;
  const key = eventStreamKey(cid, event.stream_id);
  tombstoneStream(cid, event.stream_id);
  const resendAttempt = pendingResends.get(key);
  if (resendAttempt) rejectResendAttempt(resendAttempt, new Error("Response cancelled"));
  return true;
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

function ensureListeners(): Promise<void> {
  if (listenersReady) return Promise.resolve();
  if (listenersPromise) return listenersPromise;
  const promise = registerListeners();
  listenersPromise = promise;
  void promise.catch(() => {
    if (listenersPromise === promise) {
      listenersPromise = null;
      listenersReady = false;
    }
  });
  return promise;
}

async function registerListeners(): Promise<void> {
  const registered: UnlistenFn[] = [];
  try {

  registered.push(
    await listen<StreamEventBase & { delta: string }>(
      "chat-thinking",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        if (s.status === "stopping" && s._cancelRequestedGeneration === s._streamGeneration) return;
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
  registered.push(
    await listen<StreamEventBase & { delta: string }>(
      "chat-chunk",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        if (s.status === "stopping" && s._cancelRequestedGeneration === s._streamGeneration) return;
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
  registered.push(
    await listen<StreamEventBase & {
      prompt_tokens: number | null;
      output_tokens: number | null;
      completed_at: string;
    }>("chat-done", (e) => {
      const cid = e.payload.conversation_id;
      const s = getOrCreate(cid);
      if (!isCurrentEvent(s, e.payload)) return;
      if (ignoreTerminalAfterStop(cid, s, e.payload)) return;
      if (!acceptTerminalEvent(cid, e.payload.stream_id)) return;
      const resendAttempt = pendingResends.get(eventStreamKey(cid, e.payload.stream_id));
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

      const lastModel = s._lastModel;
      const lastProvider = s._lastProviderId;
      import("../stores/settings").then(({ useSettingsStore }) => {
        if (!useSettingsStore.getState().memoryAutoEvaluate) return;
        void useMemoryStore.getState().queueReview(cid, lastModel, lastProvider).catch(console.error);
      }).catch(console.error);

      playDoneSound(false);
      if (shouldNotifyForCompletedConversation(cid)) {
        try {
          sendNotification({ title: "Convo", body: "Response complete" });
        } catch { /* ignore */ }
      }
      bump(cid);
      if (resendAttempt) {
        resolveResendTerminal(resendAttempt);
      }
    })
  );

  // chat-error
  registered.push(
    await listen<StreamEventBase & { error: string; completed_at: string }>(
      "chat-error",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        if (!isCurrentEvent(s, e.payload)) return;
        if (ignoreTerminalAfterStop(cid, s, e.payload)) return;
        if (!acceptTerminalEvent(cid, e.payload.stream_id)) return;
        const resendAttempt = pendingResends.get(eventStreamKey(cid, e.payload.stream_id));
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
        bump(cid);
        if (resendAttempt) {
          rejectResendAttempt(resendAttempt, new Error(e.payload.error));
        }
      }
    )
  );

  // chat-cancelled
  registered.push(
    await listen<StreamEventBase & { completed_at: string }>("chat-cancelled", (e) => {
      const cid = e.payload.conversation_id;
      const s = getOrCreate(cid);
      if (!isCurrentEvent(s, e.payload)) return;
      const resendAttempt = pendingResends.get(eventStreamKey(cid, e.payload.stream_id));
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
      bump(cid);
      if (resendAttempt) {
        rejectResendAttempt(resendAttempt, new Error("Response cancelled"));
      }
    })
  );
  unlisteners.push(...registered);
  listenersReady = true;
} catch (error) {
  await Promise.allSettled(registered.map((unlisten) =>
    Promise.resolve().then(() => unlisten())
  ));
  throw error;
}
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

const sessionLoads = new Map<string, Promise<ChatMessage[]>>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearStopTimer(cid: string) {
  const timer = stopTimers.get(cid);
  if (timer !== undefined) clearTimeout(timer);
  stopTimers.delete(cid);
}

function scheduleStopTimer(cid: string, streamId: string, streamGeneration: number): void {
  clearStopTimer(cid);
  let timer: ReturnType<typeof setTimeout>;
  timer = setTimeout(() => {
    if (stopTimers.get(cid) !== timer) return;
    stopTimers.delete(cid);
    const current = getOrCreate(cid);
    if (
      current.status !== "stopping"
      || current._streamId !== streamId
      || current._streamGeneration !== streamGeneration
      || current._cancelRequestedGeneration !== streamGeneration
    ) return;
    const resendAttempt = pendingResends.get(eventStreamKey(cid, streamId));
    tombstoneStream(cid, streamId);
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
    bump(cid);
    if (resendAttempt) {
      rejectResendAttempt(resendAttempt, new Error("Response stop timed out"));
    }
  }, 5000);
  stopTimers.set(cid, timer);
}

export async function loadSessionMessages(cid: string): Promise<ChatMessage[]> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (isClearLocked(cid)) return s.messages;
  if (s.messages.length > 0 && !s.loadingMessages) {
    return s.messages;
  }
  const existing = sessionLoads.get(cid);
  if (existing) return existing;
  const load = (async () => {
    s.loadingMessages = true;
    bump(cid);
    try {
      const msgs = (await api.listMessages(cid)) ?? [];
      if (!isClearLocked(cid) && s.messages.length === 0 && !s.streaming) s.messages = msgs;
      return s.messages;
    } finally {
      s.loadingMessages = false;
      bump(cid);
      sessionLoads.delete(cid);
    }
  })();
  sessionLoads.set(cid, load);
  return load;
}

export async function reloadSessionMessages(
  cid: string,
  expectedResendLock?: ResendLock,
): Promise<ChatMessage[]> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (isClearLocked(cid)) return s.messages;
  if (expectedResendLock && !ownsResendLock(expectedResendLock)) return s.messages;
  s.loadingMessages = true;
  bump(cid);
  try {
    const msgs = (await api.listMessages(cid)) ?? [];
    if (expectedResendLock && !ownsResendLock(expectedResendLock)) {
      throw new Error("Resend recovery was superseded.");
    }
    if (isClearLocked(cid)) return s.messages;
    s.messages = msgs;
    return msgs;
  } finally {
    if (!expectedResendLock || ownsResendLock(expectedResendLock)) {
      s.loadingMessages = false;
      bump(cid);
    }
  }
}

export function getSessionState(cid: string): SessionState {
  return stateBySession.get(cid) ?? EMPTY;
}

export async function clearSessionMessages(cid: string): Promise<boolean> {
  if (clearLocks.has(cid)) {
    toast.warn("A message clear is already in progress.");
    return false;
  }
  const current = getOrCreate(cid);
  if (current.streaming || isResendLocked(cid)) {
    toast.warn("Stop the current response or wait for resend recovery before clearing messages.");
    return false;
  }
  clearLocks.add(cid);
  try {
    await ensureListeners();
    const s = getOrCreate(cid);
    if (s.streaming || isResendLocked(cid)) {
      toast.warn("Stop the current response or wait for resend recovery before clearing messages.");
      return false;
    }
    const beforeClear: SessionState = {
      ...s,
      messages: s.messages.slice(),
    };
    s.messages = [];
    s.status = "idle";
    s.streaming = false;
    s.streamContent = "";
    s.streamThinking = "";
    s.error = null;
    s._streamId = undefined;
    s._assistantMessageId = undefined;
    pendingDeltas.forEach((pending, key) => {
      if (pending.cid === cid) pendingDeltas.delete(key);
    });
    clearStopTimer(cid);
    bump(cid);
    try {
      await api.clearMessages(cid);
      return true;
    } catch (e) {
      Object.assign(s, beforeClear, { messages: beforeClear.messages.slice() });
      bump(cid);
      console.error("clearSessionMessages:", e);
      toast.error(`Unable to clear messages. ${describeError(e)}`, "Clear failed");
      return false;
    }
  } finally {
    clearLocks.delete(cid);
  }
}

export interface SendOpts {
  systemOverride?: string;
  attachmentsJson?: string | null;
  temperature?: number;
  contextLength?: number | null;
  /** Exact pre-truncate history to restore if this resend fails. */
  resendSnapshot?: ChatMessage[];
  /** Lock acquired before a UI resend truncates history. */
  resendLock?: ResendLock;
  /** Provider id backing `model`. Tracked on SessionState so the
   * auto-eval hook can request facts extraction using the same
   * model that just answered. */
  providerId?: string;
}

interface ResendRecoveryResult {
  errors: string[];
  superseded?: boolean;
}

interface ResendAttempt {
  cid: string;
  snapshot: ChatMessage[];
  replacementUserId: string;
  streamId: string;
  assistantMessageId: string;
  lock: ResendLock;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  rejectTerminal: (reason?: unknown) => void;
  recoveryPromise?: Promise<ResendRecoveryResult>;
  failureError?: unknown;
  terminalSettled?: boolean;
  failureFinalized?: boolean;
}

const pendingResends = new Map<string, ResendAttempt>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createResendAttempt(
  cid: string,
  snapshot: ChatMessage[],
  replacementUserId: string,
  streamId: string,
  assistantMessageId: string,
  lock: ResendLock,
): ResendAttempt {
  let resolveTerminal!: () => void;
  let rejectTerminal!: (reason?: unknown) => void;
  const terminalPromise = new Promise<void>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  // A terminal event can arrive before the provider-start promise returns;
  // keep an observer attached until sendMessage awaits this promise.
  void terminalPromise.catch(() => undefined);
  const attempt: ResendAttempt = {
    cid,
    snapshot: snapshot.slice(),
    replacementUserId,
    streamId,
    assistantMessageId,
    lock,
    terminalPromise,
    resolveTerminal,
    rejectTerminal,
  };
  pendingResends.set(eventStreamKey(cid, streamId), attempt);
  return attempt;
}

function isCurrentResendAttempt(attempt: ResendAttempt): boolean {
  const s = getOrCreate(attempt.cid);
  return ownsResendLock(attempt.lock)
    && s._streamId === attempt.streamId
    && s._assistantMessageId === attempt.assistantMessageId;
}

function resolveResendTerminal(attempt: ResendAttempt): void {
  if (attempt.terminalSettled) return;
  attempt.terminalSettled = true;
  if (pendingResends.get(eventStreamKey(attempt.cid, attempt.streamId)) === attempt) {
    pendingResends.delete(eventStreamKey(attempt.cid, attempt.streamId));
  }
  releaseResendLock(attempt.lock);
  attempt.resolveTerminal();
}

function rejectResendTerminal(attempt: ResendAttempt, error: unknown): void {
  if (attempt.terminalSettled) return;
  attempt.terminalSettled = true;
  if (pendingResends.get(eventStreamKey(attempt.cid, attempt.streamId)) === attempt) {
    pendingResends.delete(eventStreamKey(attempt.cid, attempt.streamId));
  }
  releaseResendLock(attempt.lock);
  attempt.rejectTerminal(error);
}

async function recoverResendAttempt(attempt: ResendAttempt): Promise<ResendRecoveryResult> {
  const errors: string[] = [];
  const replacementIds = [...new Set([
    attempt.replacementUserId,
    attempt.assistantMessageId,
  ].filter((id) => id.length > 0))];

  // The snapshot save command upserts non-empty rows, so remove both IDs
  // first. Continue through every cleanup step even when one fails.
  for (const messageId of replacementIds) {
    if (!ownsResendLock(attempt.lock)) {
      return { errors: ["resend recovery was superseded"], superseded: true };
    }
    try {
      await api.deleteMessage(attempt.cid, messageId);
    } catch (error) {
      errors.push(`delete ${messageId}: ${describeError(error)}`);
    }
  }
  if (!ownsResendLock(attempt.lock)) {
    return { errors: ["resend recovery was superseded"], superseded: true };
  }
  try {
    await api.saveMessages(attempt.cid, attempt.snapshot);
  } catch (error) {
    errors.push(`save snapshot: ${describeError(error)}`);
  }
  if (!ownsResendLock(attempt.lock)) {
    return { errors: ["resend recovery was superseded"], superseded: true };
  }
  try {
    await reloadSessionMessages(attempt.cid, attempt.lock);
  } catch (error) {
    errors.push(`reload history: ${describeError(error)}`);
  }

  if (!isCurrentResendAttempt(attempt)) {
    return { errors: ["resend recovery was superseded"], superseded: true };
  }
  const s = getOrCreate(attempt.cid);
  pendingDeltas.delete(eventStreamKey(attempt.cid, attempt.streamId));
  clearStopTimer(attempt.cid);
  // Keep the in-memory view exact even when the final reload failed. The
  // recovery error is reported separately so callers retain the original
  // provider error.
  s.messages = attempt.snapshot.slice();
  s.streaming = false;
  s.status = "failed";
  s.streamContent = "";
  s.streamThinking = "";
  s._streamId = undefined;
  s._assistantMessageId = undefined;
  s._cancelRequestedGeneration = undefined;
  bump(attempt.cid);
  return { errors };
}

function applyFallbackResendState(attempt: ResendAttempt): void {
  if (!isCurrentResendAttempt(attempt)) return;
  const s = getOrCreate(attempt.cid);
  pendingDeltas.delete(eventStreamKey(attempt.cid, attempt.streamId));
  clearStopTimer(attempt.cid);
  s.messages = attempt.snapshot.slice();
  s.streaming = false;
  s.status = "failed";
  s.streamContent = "";
  s.streamThinking = "";
  s._streamId = undefined;
  s._assistantMessageId = undefined;
  s._cancelRequestedGeneration = undefined;
  bump(attempt.cid);
}

function finalizeResendFailure(
  attempt: ResendAttempt,
  result: ResendRecoveryResult,
): void {
  if (attempt.failureFinalized) {
    rejectResendTerminal(attempt, attempt.failureError);
    return;
  }
  attempt.failureFinalized = true;
  try {
    if (!result.superseded && ownsResendLock(attempt.lock)) {
      const s = getOrCreate(attempt.cid);
      const originalError = describeError(attempt.failureError);
      s.error = result.errors.length > 0
        ? `${originalError} Resend recovery incomplete: ${result.errors.join("; ")}`
        : originalError;
      if (result.errors.length > 0) {
        toast.error(
          `Resend recovery incomplete: ${result.errors.join("; ")}`,
          "Resend failed"
        );
      }
      bump(attempt.cid);
    }
  } finally {
    rejectResendTerminal(attempt, attempt.failureError);
  }
}

function beginResendRecovery(
  attempt: ResendAttempt,
  error: unknown,
): Promise<ResendRecoveryResult> {
  if (attempt.recoveryPromise) return attempt.recoveryPromise;
  attempt.failureError = attempt.failureError ?? error;
  pendingResends.delete(eventStreamKey(attempt.cid, attempt.streamId));
  attempt.recoveryPromise = recoverResendAttempt(attempt)
    .catch((recoveryError) => {
      applyFallbackResendState(attempt);
      return {
        errors: [`recovery: ${describeError(recoveryError)}`],
      };
    })
    .then((result) => {
      finalizeResendFailure(attempt, result);
      return result;
    });
  return attempt.recoveryPromise;
}

function rejectResendAttempt(attempt: ResendAttempt, error: unknown): void {
  void beginResendRecovery(attempt, error).catch((finalizationError) => {
    attempt.failureError = attempt.failureError ?? finalizationError;
    applyFallbackResendState(attempt);
    finalizeResendFailure(attempt, {
      errors: [`recovery: ${describeError(finalizationError)}`],
    });
  });
}

function isSendCurrent(
  s: SessionState,
  generation: number,
  streamId: string,
  assistantMessageId: string,
  resendLock?: ResendLock,
): boolean {
  return s.streaming
    && s.status === "sending"
    && s._streamGeneration === generation
    && s._cancelRequestedGeneration !== generation
    && s._streamId === streamId
    && s._assistantMessageId === assistantMessageId
    && (!resendLock || ownsResendLock(resendLock));
}

function finishSupersededNormalSend(
  cid: string,
  s: SessionState,
  generation: number,
  streamId: string,
): void {
  if (s._streamGeneration !== generation || s._streamId !== streamId) return;
  tombstoneStream(cid, streamId);
  if (s._cancelRequestedGeneration === generation
    && s.status !== "failed"
    && s.status !== "stopped"
    && s.status !== "complete") {
    s.streaming = false;
    s.status = "stopped";
  } else if (s.status === "sending" || s.status === "stopping") {
    s.streaming = false;
    s.status = "failed";
    s.error = "Send was superseded before the response started.";
  } else {
    s.streaming = false;
  }
  s.streamContent = "";
  s.streamThinking = "";
  bump(cid);
}

function finishNormalSendFailure(
  cid: string,
  s: SessionState,
  generation: number,
  streamId: string,
  error: unknown,
  removeMessageId?: string,
): void {
  if (s._streamGeneration !== generation || s._streamId !== streamId) return;
  const cancellationRequested = s._cancelRequestedGeneration === generation
    || s.status === "stopping"
    || s.status === "stopped";
  tombstoneStream(cid, streamId);
  if (removeMessageId) {
    s.messages = s.messages.filter((message) => message.id !== removeMessageId);
  }
  s.streaming = false;
  if (!cancellationRequested) {
    s.status = "failed";
    s.error = describeError(error);
    toast.error(describeError(error), "Send failed");
  } else if (s.status === "sending" || s.status === "stopping" || s.status === "streaming") {
    s.status = "stopped";
  }
  s.streamContent = "";
  s.streamThinking = "";
  bump(cid);
}

function finishNormalSendPreflightFailure(cid: string, error: unknown): false {
  const s = getOrCreate(cid);
  const message = describeError(error);
  if (!s.streaming) {
    s.status = "failed";
    s.error = message;
    bump(cid);
  }
  toast.error(message, "Send failed");
  return false;
}

async function recoverPreAttemptResend(
  cid: string,
  snapshot: ChatMessage[],
  lock: ResendLock,
  originalError: unknown,
): Promise<void> {
  const errors: string[] = [];
  if (!ownsResendLock(lock)) return;

  try {
    await api.saveMessages(cid, snapshot);
  } catch (error) {
    errors.push(`save snapshot: ${describeError(error)}`);
  }
  if (ownsResendLock(lock)) {
    try {
      await reloadSessionMessages(cid, lock);
    } catch (error) {
      errors.push(`reload history: ${describeError(error)}`);
    }
  }
  if (!ownsResendLock(lock)) return;

  const s = getOrCreate(cid);
  pendingDeltas.forEach((pending, key) => {
    if (pending.cid === cid) pendingDeltas.delete(key);
  });
  clearStopTimer(cid);
  s.messages = snapshot.slice();
  s.streaming = false;
  s.status = "failed";
  s.loadingMessages = false;
  s.streamContent = "";
  s.streamThinking = "";
  s._streamId = undefined;
  s._assistantMessageId = undefined;
  s._cancelRequestedGeneration = undefined;
  s.error = errors.length > 0
    ? `${describeError(originalError)} Resend recovery incomplete: ${errors.join("; ")}`
    : describeError(originalError);
  bump(cid);
  if (errors.length > 0) {
    toast.error(`Resend recovery incomplete: ${errors.join("; ")}`, "Resend failed");
  }
}

export async function sendMessage(
  cid: string,
  text: string,
  model: string,
  opts: SendOpts = {}
): Promise<boolean> {
  const isResend = opts.resendSnapshot !== undefined;
  let resendLock = opts.resendLock;
  let resendAttempt: ResendAttempt | null = null;
  if (isClearLocked(cid)) {
    return isResend ? false : finishNormalSendPreflightFailure(
      cid,
      new Error("Message clearing is already in progress."),
    );
  }
  if (isResend) {
    if (resendLock) {
      if (!ownsResendLock(resendLock)) throw resendBusyError();
    } else {
      resendLock = acquireResendLock(cid) ?? undefined;
      if (!resendLock) throw resendBusyError();
    }
  } else if (isResendLocked(cid)) {
    return finishNormalSendPreflightFailure(cid, resendBusyError());
  }

  try {
    await ensureListeners();
    await loadSessionMessages(cid);
    if (isClearLocked(cid)) {
      if (isResend) return false;
      return finishNormalSendPreflightFailure(
        cid,
        new Error("Message clearing is already in progress."),
      );
    }
    const s = getOrCreate(cid);
    if (!isResend && isResendLocked(cid)) throw resendBusyError();
    if (s.streaming) throw new Error("A response is already in progress.");
    if (isResend && (!resendLock || !ownsResendLock(resendLock))) {
      throw resendBusyError();
    }
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
    const sendGeneration = s._streamGeneration;
    const streamId = s._streamId;
    const assistantMessageId = s._assistantMessageId;
    terminalStreams.delete(eventStreamKey(cid, streamId));
    invalidatedStreams.delete(eventStreamKey(cid, streamId));
    resendAttempt = isResend
      ? createResendAttempt(
        cid,
        opts.resendSnapshot!,
        userMsg.id,
        streamId,
        assistantMessageId,
        resendLock!,
      )
      : null;
    s._lastModel = model;
    s._lastProviderId = opts.providerId;
    bump(cid);
    playSendSound(false);

    const checkBeforeProvider = async (): Promise<boolean> => {
      if (isSendCurrent(s, sendGeneration, streamId, assistantMessageId, resendLock)) return true;
      const superseded = new Error("Send was superseded before the provider started.");
      if (resendAttempt) {
        await beginResendRecovery(resendAttempt, superseded);
        throw resendAttempt.failureError ?? superseded;
      }
      finishSupersededNormalSend(cid, s, sendGeneration, streamId);
      return false;
    };

    // Persist the user message to DB immediately so it survives even
    // if the stream connection fails before chat-done fires.
    try {
      await api.upsertMessage(userMsg);
    } catch (e) {
      if (resendAttempt) {
        await beginResendRecovery(resendAttempt, e);
        throw e;
      }
      finishNormalSendFailure(cid, s, sendGeneration, streamId, e, userMsg.id);
      return false;
    }
    if (!await checkBeforeProvider()) return false;

    let fullSystem: string;
    let cleanMessages: ProviderMessage[];
    try {
      const memoryBlock = await useMemoryStore.getState().buildContextBlock(cid);
      if (!await checkBeforeProvider()) return false;
      const recalledBlock = await recallMemories(text);
      if (!await checkBeforeProvider()) return false;

      fullSystem = composeSystemPrompt({
        override: opts.systemOverride,
        alwaysOnMemory: memoryBlock,
        recalledMemory: recalledBlock,
      });
      // Truncate conversation history before sending to the LLM.
      // Keep the last 41 messages (~20 pairs + 1) to avoid context
      // overflow and model-repetition degredation on long conversations.
      const MAX_HISTORY = 41;
      const truncated = s.messages.length > MAX_HISTORY
        ? s.messages.slice(-MAX_HISTORY)
        : s.messages;
      cleanMessages = buildProviderMessages(truncated, opts.contextLength);
      if (!await checkBeforeProvider()) return false;
    } catch (e) {
      if (resendAttempt) {
        await beginResendRecovery(resendAttempt, e);
        throw e;
      }
      finishNormalSendFailure(cid, s, sendGeneration, streamId, e);
      return false;
    }

    try {
      if (!isSendCurrent(s, sendGeneration, streamId, assistantMessageId, resendLock)) {
        const superseded = new Error("Send was superseded before the provider started.");
        if (resendAttempt) {
          await beginResendRecovery(resendAttempt, superseded);
          throw resendAttempt.failureError ?? superseded;
        }
        finishSupersededNormalSend(cid, s, sendGeneration, streamId);
        return false;
      }
      s.status = "streaming";
      bump(cid);
      await api.chatStream({
        sessionId: cid,
        model,
        messages: cleanMessages,
        system: fullSystem,
        temperature: opts.temperature ?? 0.7,
        streamId,
        assistantMessageId,
      });
      if (!resendAttempt && (
        s._streamGeneration !== sendGeneration
        || s._streamId !== streamId
        || s._assistantMessageId !== assistantMessageId
        || s._cancelRequestedGeneration === sendGeneration
        || (s.status as ChatStatus) === "stopping"
        || (s.status as ChatStatus) === "stopped"
        || (s.status as ChatStatus) === "failed"
      )) {
        return false;
      }
      if (resendAttempt) await resendAttempt.terminalPromise;
      return true;
    } catch (e) {
      if (resendAttempt) {
        await beginResendRecovery(resendAttempt, e);
        throw e;
      }
      finishNormalSendFailure(cid, s, sendGeneration, streamId, e);
      return false;
    }
  } catch (e) {
    if (isResend && resendAttempt === null && resendLock) {
      await recoverPreAttemptResend(cid, opts.resendSnapshot!, resendLock, e);
    }
    if (isResend) throw e;
    return finishNormalSendPreflightFailure(cid, e);
  } finally {
    if (resendLock) releaseResendLock(resendLock);
  }
}

export async function stopStream(cid: string) {
  const s = getOrCreate(cid);
  const streamId = s._streamId;
  const streamGeneration = s._streamGeneration ?? 0;
  if (!s.streaming || !streamId) return;
  if (s.status === "stopping" && s._cancelRequestedGeneration === streamGeneration) return;
  s._cancelRequestedGeneration = streamGeneration;
  s.status = "stopping";
  bump(cid);
  scheduleStopTimer(cid, streamId, streamGeneration);
  try {
    await api.cancelChat(cid, streamId);
    if (
      s._streamId !== streamId
      || s._streamGeneration !== streamGeneration
      || s.status !== "stopping"
      || invalidatedStreams.has(eventStreamKey(cid, streamId))
    ) return;
  } catch (e) {
    if (
      s._streamId !== streamId
      || s._streamGeneration !== streamGeneration
      || s.status !== "stopping"
      || s._cancelRequestedGeneration !== streamGeneration
      || invalidatedStreams.has(eventStreamKey(cid, streamId))
    ) return;
    const resendAttempt = pendingResends.get(eventStreamKey(cid, streamId));
    tombstoneStream(cid, streamId);
    clearStopTimer(cid);
    s.streaming = false;
    s.status = "failed";
    s.error = describeError(e);
    s.streamContent = "";
    s.streamThinking = "";
    bump(cid);
    console.error("cancelChat:", e);
    if (resendAttempt) {
      rejectResendAttempt(resendAttempt, e);
    }
  }
}

async function restoreRetrySnapshot(
  cid: string,
  messages: ChatMessage[],
  resendLock?: ResendLock,
): Promise<{ saveError: unknown | null; reloadError: unknown | null }> {
  let saveError: unknown | null = null;
  let reloadError: unknown | null = null;
  try {
    await api.saveMessages(cid, messages);
  } catch (error) {
    saveError = error;
  }
  try {
    await reloadSessionMessages(cid, resendLock);
  } catch (error) {
    reloadError = error;
  }
  return { saveError, reloadError };
}

export async function retryLastMessage(
  cid: string,
  model: string,
  opts: SendOpts = {},
): Promise<void> {
  const current = getOrCreate(cid);
  const resendLock = acquireResendLock(cid);
  if (!resendLock) {
    toast.warn(current.streaming
      ? "Stop the current response before retrying."
      : "Another resend or recovery is already in progress.");
    return;
  }
  try {
    const s = getOrCreate(cid);
    const lastUser = [...s.messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    const snapshot = s.messages.slice();
    let truncated = false;
    let sendStarted = false;
    try {
      await api.truncateMessages(cid, lastUser.id);
      truncated = true;
      await reloadSessionMessages(cid, resendLock);
      sendStarted = true;
      await sendMessage(cid, lastUser.content, model, {
        ...opts,
        attachmentsJson: opts.attachmentsJson ?? lastUser.attachments_json,
        resendSnapshot: snapshot,
        resendLock,
      });
    } catch (error) {
      if (!truncated) {
        toast.error(`Retry failed. Your original history was kept. ${String(error)}`);
        return;
      }
      if (sendStarted) {
        // sendMessage owns recovery once the replacement has been created.
        toast.error(`Retry failed. ${String(error)}`);
        return;
      }
      const recovery = await restoreRetrySnapshot(cid, snapshot, resendLock);
      const recoveryMessage = recovery.saveError || recovery.reloadError
        ? ` The original history could not be fully restored. ${String(recovery.saveError ?? recovery.reloadError)}`
        : " The original history was restored.";
      toast.error(`Retry failed.${recoveryMessage} ${String(error)}`);
    }
  } finally {
    releaseResendLock(resendLock);
  }
}

/**
 * Builds a short, prominent recall block for the current query. Ranking stays
 * pure in `memoryRecall`; this wrapper owns memory-store loading and prompt
 * formatting so recall remains best-effort and error-safe.
 */
export async function recallMemories(query: string): Promise<string> {
  try {
    const memoryState = useMemoryStore.getState();
    if (!memoryState.loaded) await memoryState.refresh();
    const recalled = rankMemoryRecall(query, useMemoryStore.getState().items);
    if (recalled.length === 0) return "";
    return formatMemoryRecallBlock(recalled);
  } catch {
    // Best-effort — silently skip on failure.
    return "";
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

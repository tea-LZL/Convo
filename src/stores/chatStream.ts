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
import { api, ChatMessage, Preset } from "../lib/api";
import { useMemoryStore } from "./memory";
import { playDoneSound, playSendSound } from "../utils/sounds";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "./toasts";

export interface SessionState {
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  error: string | null;
  loadingMessages: boolean;
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

  // chat-chunk
  unlisteners.push(
    await listen<{ conversation_id: string; content: string; full_content: string }>(
      "chat-chunk",
      (e) => {
        const cid = e.payload.conversation_id;
        const s = getOrCreate(cid);
        s.streamContent = e.payload.full_content;
        bump(cid);
      }
    )
  );

  // chat-done
  unlisteners.push(
    await listen<{
      conversation_id: string;
      prompt_tokens: number;
      output_tokens: number;
      completed_at: string;
    }>("chat-done", (e) => {
      const cid = e.payload.conversation_id;
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
      const s = getOrCreate(cid);
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
  presetOverride?: Preset | null;
}

export async function sendMessage(
  cid: string,
  text: string,
  model: string,
  preset: Preset | null,
  opts: SendOpts = {}
): Promise<void> {
  await ensureListeners();
  const s = getOrCreate(cid);
  if (s.streaming) return;
  s.error = null;
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    session_id: cid,
    role: "user",
    content: text,
    thinking: null,
    attachments_json: null,
    prompt_tokens: null,
    output_tokens: null,
    created_at: new Date().toISOString(),
  };
  s.messages = [...s.messages, userMsg];
  s.streaming = true;
  s.streamContent = "";
  s.streamThinking = "";
  bump(cid);
  playSendSound(false);

  const presetToUse = opts.presetOverride !== undefined ? opts.presetOverride : preset;
  const memoryBlock = useMemoryStore.getState().buildContextBlock();
  const presetSystem = opts.systemOverride ?? presetToUse?.system_prompt;
  const fullSystem = [presetSystem, memoryBlock].filter(Boolean).join("\n\n") || undefined;
  const cleanMessages = s.messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.thinking ? { thinking: m.thinking } : {}),
  }));

  try {
    await api.chatStream({
      sessionId: cid,
      model,
      messages: cleanMessages,
      system: fullSystem,
      temperature: presetToUse?.temperature ?? undefined,
      topP: presetToUse?.top_p ?? undefined,
      topK: presetToUse?.top_k ?? undefined,
      numCtx: presetToUse?.num_ctx ?? undefined,
      repeatPenalty: presetToUse?.repeat_penalty ?? undefined,
    });
  } catch (e) {
    s.streaming = false;
    s.error = String(e);
    toast.error(String(e), "Send failed");
    bump(cid);
  }
}

export async function stopStream(cid: string) {
  try {
    await api.cancelChat(cid);
  } catch (e) {
    console.error("cancelChat:", e);
  }
}

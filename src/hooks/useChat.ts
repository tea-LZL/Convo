/**
 * Chat hook — multi-session, multi-provider streaming.
 * Replaces the original useChat.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, ChatMessage, Preset } from "../lib/api";
import { useSessionsStore } from "../stores/sessions";
import { useSettingsStore } from "../stores/settings";
import { playDoneSound, playSendSound } from "../utils/sounds";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "../stores/toasts";

interface SessionState {
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  error: string | null;
  loadingMessages: boolean;
  evictTimer: ReturnType<typeof setTimeout> | null;
}

const EVICT_DELAY = 30_000;

function freshSession(): SessionState {
  return {
    messages: [],
    streaming: false,
    streamContent: "",
    streamThinking: "",
    error: null,
    loadingMessages: false,
    evictTimer: null,
  };
}

export interface UseChat {
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  totalTokens: number;
  error: string | null;
  loadingMessages: boolean;
  send: (content: string, options?: { systemOverride?: string; presetOverride?: Preset | null }) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useChat(activeId: string | null, currentPreset: Preset | null, modelName: string): UseChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const sessions = useRef<Map<string, SessionState>>(new Map());
  const messagesRef = useRef<ChatMessage[]>([]);
  const thinkingRef = useRef("");
  const activeIdRef = useRef(activeId);
  const presetRef = useRef<Preset | null>(currentPreset);
  const modelRef = useRef(modelName);

  const muteSounds = useSettingsStore((s) => s.muteSounds);
  const muteNotifications = useSettingsStore((s) => s.muteNotifications);
  const muteSoundsRef = useRef(muteSounds);
  const muteNotificationsRef = useRef(muteNotifications);

  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.prompt_tokens || 0) + (m.output_tokens || 0),
    0
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    thinkingRef.current = streamThinking;
  }, [streamThinking]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    presetRef.current = currentPreset;
  }, [currentPreset]);
  useEffect(() => {
    modelRef.current = modelName;
  }, [modelName]);
  useEffect(() => {
    muteSoundsRef.current = muteSounds;
  }, [muteSounds]);
  useEffect(() => {
    muteNotificationsRef.current = muteNotifications;
  }, [muteNotifications]);

  const ensure = (id: string): SessionState => {
    let s = sessions.current.get(id);
    if (!s) {
      s = freshSession();
      sessions.current.set(id, s);
    }
    return s;
  };
  const scheduleEvict = (id: string) => {
    const s = sessions.current.get(id);
    if (!s || s.streaming) return;
    if (s.evictTimer) clearTimeout(s.evictTimer);
    s.evictTimer = setTimeout(() => sessions.current.delete(id), EVICT_DELAY);
  };
  const cancelEvict = (id: string) => {
    const s = sessions.current.get(id);
    if (s?.evictTimer) {
      clearTimeout(s.evictTimer);
      s.evictTimer = null;
    }
  };

  useEffect(() => {
    return () => {
      sessions.current.forEach((s) => {
        if (s.evictTimer) clearTimeout(s.evictTimer);
      });
    };
  }, []);

  const prevIdRef = useRef<string | null>(activeId);

  useEffect(() => {
    const prevId = prevIdRef.current;
    if (prevId && prevId !== activeId) {
      const s = ensure(prevId);
      s.messages = messagesRef.current;
      s.streaming = streaming;
      s.streamContent = streamContent;
      s.streamThinking = streamThinking;
      s.error = error;
      s.loadingMessages = loadingMessages;
      scheduleEvict(prevId);
    }
    if (!activeId) {
      setMessages([]);
      setStreamContent("");
      setStreamThinking("");
      setStreaming(false);
      setError(null);
      setLoadingMessages(false);
      messagesRef.current = [];
    } else if (activeId !== prevId) {
      cancelEvict(activeId);
      const cached = sessions.current.get(activeId);
      if (!cached) {
        setMessages([]);
        setStreamContent("");
        setStreamThinking("");
        setStreaming(false);
        setError(null);
        setLoadingMessages(true);
        messagesRef.current = [];
        api
          .listMessages(activeId)
          .then((msgs) => {
            setMessages(msgs);
            messagesRef.current = msgs;
          })
          .catch((e) => {
            setError(String(e));
            ensure(activeId).error = String(e);
          })
          .finally(() => setLoadingMessages(false));
      } else {
        setMessages(cached.messages);
        setStreaming(cached.streaming);
        setStreamContent(cached.streamContent);
        setStreamThinking(cached.streamThinking);
        setError(cached.error);
        setLoadingMessages(cached.loadingMessages);
        messagesRef.current = cached.messages;
        if (cached.messages.length === 0 && !cached.loadingMessages && !cached.streaming) {
          setLoadingMessages(true);
          api
            .listMessages(activeId)
            .then((msgs) => {
              setMessages(msgs);
              messagesRef.current = msgs;
            })
            .catch((e) => setError(String(e)))
            .finally(() => setLoadingMessages(false));
        }
      }
    }
    prevIdRef.current = activeId;
  }, [activeId, streaming, streamContent, streamThinking, error, loadingMessages]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    const setup = async () => {
      const u0 = await listen<{ conversation_id: string; thinking: string }>("chat-thinking", (e) => {
        const cid = e.payload.conversation_id;
        const active = activeIdRef.current;
        const s = ensure(cid);
        s.streamThinking = e.payload.thinking;
        if (!s.streaming) s.streaming = true;
        cancelEvict(cid);
        if (cid === active) {
          setStreamThinking(e.payload.thinking);
          if (!streaming) setStreaming(true);
        }
      });
      const u1 = await listen<{ conversation_id: string; content: string; full_content: string }>("chat-chunk", (e) => {
        const cid = e.payload.conversation_id;
        const active = activeIdRef.current;
        const s = ensure(cid);
        s.streamContent = e.payload.full_content;
        cancelEvict(cid);
        if (cid === active) setStreamContent(e.payload.full_content);
      });
      const u2 = await listen<{ conversation_id: string; prompt_tokens: number; output_tokens: number; completed_at: string }>("chat-done", (e) => {
        const cid = e.payload.conversation_id;
        const active = activeIdRef.current;
        const s = ensure(cid);
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
        api.saveMessages(cid, s.messages).catch(console.error);
        scheduleEvict(cid);
        if (cid === active) {
          setStreaming(false);
          setStreamContent((prev) => {
            const doneThinking = thinkingRef.current.trim() || null;
            const msgs = messagesRef.current;
            if (prev) {
              const updated = [
                ...msgs,
                {
                  id: crypto.randomUUID(),
                  session_id: cid,
                  role: "assistant" as const,
                  content: prev,
                  thinking: doneThinking,
                  attachments_json: null,
                  prompt_tokens: e.payload.prompt_tokens ?? null,
                  output_tokens: e.payload.output_tokens ?? null,
                  created_at: e.payload.completed_at,
                },
              ];
              setMessages(updated);
              api.saveMessages(cid, updated).catch(console.error);
            } else {
              api.saveMessages(cid, msgs).catch(console.error);
            }
            return "";
          });
          setStreamThinking("");
          playDoneSound(muteSoundsRef.current);
          if (document.hidden && !muteNotificationsRef.current) {
            try {
              sendNotification({ title: "Convo", body: "Response complete" });
            } catch { /* ignore */ }
          }
          // Update session list order
          useSessionsStore.getState().refresh();
        }
      });
      const u3 = await listen<{ conversation_id: string; error: string }>("chat-error", (e) => {
        const cid = e.payload.conversation_id;
        const active = activeIdRef.current;
        const s = ensure(cid);
        s.streaming = false;
        s.error = e.payload.error;
        api.saveMessages(cid, s.messages).catch(console.error);
        scheduleEvict(cid);
        if (cid === active) {
          setStreaming(false);
          setError(e.payload.error);
          toast.error(e.payload.error, "Chat error");
        }
      });
      const u4 = await listen<string>("chat-cancelled", (e) => {
        const cid = e.payload;
        const active = activeIdRef.current;
        const s = ensure(cid);
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
        api.saveMessages(cid, s.messages).catch(console.error);
        scheduleEvict(cid);
        if (cid === active) {
          setStreaming(false);
          setStreamContent((prev) => {
            const doneThinking = thinkingRef.current.trim() || null;
            if (prev) {
              const msgs = messagesRef.current;
              const updated = [
                ...msgs,
                {
                  id: crypto.randomUUID(),
                  session_id: cid,
                  role: "assistant" as const,
                  content: prev + " [stopped]",
                  thinking: doneThinking,
                  attachments_json: null,
                  prompt_tokens: null,
                  output_tokens: null,
                  created_at: new Date().toISOString(),
                },
              ];
              setMessages(updated);
              api.saveMessages(cid, updated).catch(console.error);
            }
            return "";
          });
          setStreamThinking("");
        }
      });
      unlisteners.push(u0, u1, u2, u3, u4);
    };
    setup();
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [streaming]);

  const _unused = 0;

  const send = useCallback(
    async (content: string, options?: { systemOverride?: string; presetOverride?: Preset | null }) => {
      const cid = activeIdRef.current;
      if (!cid || !content.trim() || streaming) return;

      setError(null);
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        session_id: cid,
        role: "user",
        content: content.trim(),
        thinking: null,
        attachments_json: null,
        prompt_tokens: null,
        output_tokens: null,
        created_at: new Date().toISOString(),
      };
      const newMessages = [...messagesRef.current, userMsg];
      setMessages(newMessages);
      setStreaming(true);
      setStreamContent("");
      setStreamThinking("");
      playSendSound(muteSoundsRef.current);

      const preset = options?.presetOverride !== undefined ? options.presetOverride : presetRef.current;
      const cleanMessages = newMessages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.thinking ? { thinking: m.thinking } : {}),
      }));

      try {
        await api.chatStream({
          sessionId: cid,
          model: modelRef.current,
          messages: cleanMessages,
          system: options?.systemOverride ?? preset?.system_prompt ?? undefined,
          temperature: preset?.temperature ?? undefined,
          topP: preset?.top_p ?? undefined,
          topK: preset?.top_k ?? undefined,
          numCtx: preset?.num_ctx ?? undefined,
          repeatPenalty: preset?.repeat_penalty ?? undefined,
        });
      } catch (e) {
        if (activeIdRef.current === cid) {
          setStreaming(false);
          const msg = String(e);
          setError(msg);
          toast.error(msg, "Send failed");
        }
        const s = sessions.current.get(cid);
        if (s) {
          s.streaming = false;
          s.error = String(e);
        }
      }
    },
    [streaming]
  );

  const stop = useCallback(async () => {
    const cid = activeIdRef.current;
    if (cid) {
      try {
        await api.cancelChat(cid);
      } catch (e) {
        console.error("cancel chat:", e);
      }
    }
  }, []);

  const reload = useCallback(async () => {
    if (!activeId) return;
    setLoadingMessages(true);
    try {
      const msgs = await api.listMessages(activeId);
      setMessages(msgs);
      messagesRef.current = msgs;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMessages(false);
    }
  }, [activeId]);

  return {
    messages,
    streaming,
    streamContent,
    streamThinking,
    totalTokens,
    error,
    loadingMessages,
    send,
    stop,
    reload,
  };
}

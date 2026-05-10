import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { chatStream, cancelChat, getMessages, saveConversationMessages } from "../lib/commands";
import type { ChatMessage, ChatChunkPayload, ChatThinkingPayload, ChatDonePayload } from "../types";
import { playDoneSound, playSendSound } from "../utils/sounds";

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

export function useChat(conversationId: string | null, model: string, windowFocused: boolean, muteSounds: boolean, muteNotifications: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const sessions = useRef<Map<string, SessionState>>(new Map());
  const messagesRef = useRef<ChatMessage[]>([]);
  const thinkingRef = useRef("");
  const focusedRef = useRef(windowFocused);
  const muteSoundsRef = useRef(muteSounds);
  const muteNotificationsRef = useRef(muteNotifications);
  const conversationIdRef = useRef(conversationId);

  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.promptTokens || 0) + (m.outputTokens || 0),
    0
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    thinkingRef.current = streamThinking;
  }, [streamThinking]);

  useEffect(() => {
    focusedRef.current = windowFocused;
  }, [windowFocused]);

  useEffect(() => {
    muteSoundsRef.current = muteSounds;
  }, [muteSounds]);

  useEffect(() => {
    muteNotificationsRef.current = muteNotifications;
  }, [muteNotifications]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const ensureSession = (id: string): SessionState => {
    let s = sessions.current.get(id);
    if (!s) {
      s = freshSession();
      sessions.current.set(id, s);
    }
    return s;
  };

  const scheduleEviction = (id: string) => {
    const s = sessions.current.get(id);
    if (!s || s.streaming) return;
    if (s.evictTimer) clearTimeout(s.evictTimer);
    s.evictTimer = setTimeout(() => {
      sessions.current.delete(id);
    }, EVICT_DELAY);
  };

  const cancelEviction = (id: string) => {
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

  const prevIdRef = useRef<string | null>(conversationId);

  useEffect(() => {
    const prevId = prevIdRef.current;

    if (prevId && prevId !== conversationId) {
      const s = ensureSession(prevId);
      s.messages = messagesRef.current;
      s.streaming = streaming;
      s.streamContent = streamContent;
      s.streamThinking = streamThinking;
      s.error = error;
      s.loadingMessages = loadingMessages;
      scheduleEviction(prevId);
    }

    if (!conversationId) {
      setMessages([]);
      setStreamContent("");
      setStreamThinking("");
      setStreaming(false);
      setError(null);
      setLoadingMessages(false);
      messagesRef.current = [];
    } else if (conversationId !== prevId) {
      cancelEviction(conversationId);

      const cached = sessions.current.get(conversationId);

      if (!cached) {
        setMessages([]);
        setStreamContent("");
        setStreamThinking("");
        setStreaming(false);
        setError(null);
        setLoadingMessages(true);
        messagesRef.current = [];

        getMessages(conversationId)
          .then((msgs) => {
            setMessages(msgs);
            messagesRef.current = msgs;
          })
          .catch((e) => {
            const msg = String(e);
            setError(msg);
            ensureSession(conversationId).error = msg;
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
          getMessages(conversationId)
            .then((msgs) => {
              setMessages(msgs);
              messagesRef.current = msgs;
            })
            .catch((e) => {
              const msg = String(e);
              setError(msg);
              ensureSession(conversationId).error = msg;
            })
            .finally(() => setLoadingMessages(false));
        }
      }
    }

    prevIdRef.current = conversationId;
  }, [conversationId, streaming, streamContent, streamThinking, error, loadingMessages]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    const setup = async () => {
      const u0 = await listen<ChatThinkingPayload>("chat-thinking", (event) => {
        const cid = event.payload.conversation_id;
        const activeId = conversationIdRef.current;

        const s = ensureSession(cid);
        s.streamThinking = event.payload.thinking;
        if (!s.streaming) s.streaming = true;
        cancelEviction(cid);

        if (cid === activeId) {
          setStreamThinking(event.payload.thinking);
          if (!streaming) setStreaming(true);
        }
      });

      const u1 = await listen<ChatChunkPayload>("chat-chunk", (event) => {
        const cid = event.payload.conversation_id;
        const activeId = conversationIdRef.current;

        const s = ensureSession(cid);
        s.streamContent = event.payload.full_content;
        cancelEviction(cid);

        if (cid === activeId) {
          setStreamContent(event.payload.full_content);
        }
      });

      const u2 = await listen<ChatDonePayload>("chat-done", (event) => {
        const cid = event.payload.conversation_id;
        const activeId = conversationIdRef.current;
        const { prompt_tokens, output_tokens, completed_at } = event.payload;

        const s = ensureSession(cid);
        s.streaming = false;
        const thinking = (s.streamThinking || "").trim() || undefined;
        if (s.streamContent) {
          s.messages = [...s.messages, {
            role: "assistant" as const,
            content: s.streamContent,
            thinking,
            promptTokens: prompt_tokens,
            outputTokens: output_tokens,
            completedAt: completed_at,
          }];
        }
        s.streamContent = "";
        s.streamThinking = "";
        saveConversationMessages(cid, s.messages).catch(console.error);
        scheduleEviction(cid);

        if (cid === activeId) {
          setStreaming(false);
          setStreamContent((prev) => {
            const doneThinking = thinkingRef.current.trim() || undefined;
            const msgs = messagesRef.current;
            if (prev) {
              const updated = [...msgs, {
                role: "assistant" as const,
                content: prev,
                thinking: doneThinking,
                promptTokens: prompt_tokens,
                outputTokens: output_tokens,
                completedAt: completed_at,
              }];
              setMessages(updated);
              saveConversationMessages(cid, updated).catch(console.error);
            } else {
              saveConversationMessages(cid, msgs).catch(console.error);
            }
            return "";
          });
          setStreamThinking("");
          playDoneSound(muteSoundsRef.current);
          if (!focusedRef.current && !muteNotificationsRef.current) {
            setTimeout(() => {
              try {
                sendNotification({ title: "Convo", body: "Response complete" });
              } catch { /* ignore */ }
            }, 0);
          }
        }
      });

      const u3 = await listen<{ conversation_id: string; error: string }>(
        "chat-error",
        (event) => {
          const cid = event.payload.conversation_id;
          const activeId = conversationIdRef.current;

          const s = ensureSession(cid);
          s.streaming = false;
          s.error = event.payload.error;
          saveConversationMessages(cid, s.messages).catch(console.error);
          scheduleEviction(cid);

          if (cid === activeId) {
            setStreaming(false);
            setError(event.payload.error);
            saveConversationMessages(cid, messagesRef.current).catch(console.error);
          }
        }
      );

      const u4 = await listen<string>("chat-cancelled", (event) => {
        const cid = event.payload;
        const activeId = conversationIdRef.current;

        const s = ensureSession(cid);
        s.streaming = false;
        const thinking = (s.streamThinking || "").trim() || undefined;
        if (s.streamContent) {
          s.messages = [...s.messages, {
            role: "assistant" as const,
            content: s.streamContent + " [stopped]",
            thinking,
          }];
        }
        s.streamContent = "";
        s.streamThinking = "";
        saveConversationMessages(cid, s.messages).catch(console.error);
        scheduleEviction(cid);

        if (cid === activeId) {
          setStreaming(false);
          const doneThinking = thinkingRef.current.trim() || undefined;
          setStreamContent((prev) => {
            if (prev) {
              const msgs = messagesRef.current;
              const updated = [...msgs, {
                role: "assistant" as const,
                content: prev + " [stopped]",
                thinking: doneThinking,
              }];
              setMessages(updated);
              saveConversationMessages(cid, updated).catch(console.error);
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
  }, []);

  const send = useCallback(
    async (content: string) => {
      const cid = conversationIdRef.current;
      if (!cid || !content.trim() || streaming) return;

      setError(null);
      const userMsg: ChatMessage = { role: "user", content: content.trim(), completedAt: new Date().toISOString() };
      const newMessages = [...messagesRef.current, userMsg];
      setMessages(newMessages);
      setStreaming(true);
      setStreamContent("");
      setStreamThinking("");
      playSendSound(muteSoundsRef.current);

      try {
        const cleanMessages = newMessages.map(({ thinking: _, ...rest }) => rest);
        await chatStream(cid, model, cleanMessages);
      } catch (e) {
        if (conversationIdRef.current === cid) {
          setStreaming(false);
          setError(String(e));
        }
        const s = sessions.current.get(cid);
        if (s) {
          s.streaming = false;
          s.error = String(e);
        }
      }
    },
    [model, streaming]
  );

  const stopStreaming = useCallback(() => {
    if (conversationIdRef.current) {
      cancelChat(conversationIdRef.current).catch(console.error);
    }
  }, []);

  return {
    messages,
    streaming,
    streamContent,
    streamThinking,
    totalTokens,
    error,
    loadingMessages,
    send,
    stopStreaming,
  };
}

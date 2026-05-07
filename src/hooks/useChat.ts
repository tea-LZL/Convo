import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { chatStream, cancelChat, getMessages, saveConversationMessages } from "../lib/commands";
import type { ChatMessage, ChatChunkPayload, ChatThinkingPayload, ChatDonePayload } from "../types";
import { playDoneSound, playSendSound } from "../utils/sounds";

export function useChat(conversationId: string | null, model: string, windowFocused: boolean, muteSounds: boolean, muteNotifications: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [totalTokens, setTotalTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const thinkingRef = useRef("");
  const focusedRef = useRef(windowFocused);
  const muteSoundsRef = useRef(muteSounds);
  const muteNotificationsRef = useRef(muteNotifications);

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
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setStreamContent("");
      setStreaming(false);
      return;
    }

    setLoadingMessages(true);
    setError(null);
    getMessages(conversationId)
      .then((msgs) => {
        setMessages(msgs);
        messagesRef.current = msgs;
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingMessages(false));
  }, [conversationId]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    const setup = async () => {
      const u0 = await listen<ChatThinkingPayload>("chat-thinking", (event) => {
        if (event.payload.conversation_id === conversationId) {
          setStreamThinking(event.payload.thinking);
        }
      });

      const u1 = await listen<ChatChunkPayload>("chat-chunk", (event) => {
        if (event.payload.conversation_id === conversationId) {
          setStreamContent(event.payload.full_content);
        }
      });

      const u2 = await listen<ChatDonePayload>("chat-done", (event) => {
        if (event.payload.conversation_id === conversationId) {
          setStreaming(false);
          const { prompt_tokens, output_tokens } = event.payload;
          setStreamContent((prev) => {
            const thinking = thinkingRef.current.trim() || undefined;
            const msgs = messagesRef.current;
            if (prev) {
              const updated = [...msgs, { role: "assistant" as const, content: prev, thinking, promptTokens: prompt_tokens, outputTokens: output_tokens }];
              setMessages(updated);
              saveConversationMessages(conversationId!, updated).catch(console.error);
              const cumulative = msgs.reduce((sum, m) => sum + (m.promptTokens || 0) + (m.outputTokens || 0), 0) + prompt_tokens + output_tokens;
              setTotalTokens(cumulative);
            } else {
              saveConversationMessages(conversationId!, msgs).catch(console.error);
              const cumulative = msgs.reduce((sum, m) => sum + (m.promptTokens || 0) + (m.outputTokens || 0), 0);
              setTotalTokens(cumulative);
            }
            return "";
          });
          setStreamThinking("");
          playDoneSound(muteSoundsRef.current);
          if (!focusedRef.current && !muteNotificationsRef.current) {
            setTimeout(() => {
              try {
                sendNotification({ title: "Convo", body: "Response complete" });
              } catch {}
            }, 0);
          }
        }
      });

      const u3 = await listen<{ conversation_id: string; error: string }>(
        "chat-error",
        (event) => {
          if (event.payload.conversation_id === conversationId) {
            setStreaming(false);
            setError(event.payload.error);
            saveConversationMessages(conversationId!, messagesRef.current).catch(console.error);
          }
        }
      );

      const u4 = await listen<string>("chat-cancelled", (event) => {
        if (event.payload === conversationId) {
          setStreaming(false);
          const thinking = thinkingRef.current.trim() || undefined;
          setStreamContent((prev) => {
            if (prev) {
              const msgs = messagesRef.current;
              const updated = [...msgs, { role: "assistant" as const, content: prev + " [stopped]", thinking }];
              setMessages(updated);
              saveConversationMessages(conversationId!, updated).catch(console.error);
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
  }, [conversationId]);

  const send = useCallback(
    async (content: string) => {
      if (!conversationId || !content.trim() || streaming) return;

      setError(null);
      const userMsg: ChatMessage = { role: "user", content: content.trim() };
      const newMessages = [...messagesRef.current, userMsg];
      setMessages(newMessages);
      setStreaming(true);
      setStreamContent("");
      setStreamThinking("");
      playSendSound(muteSoundsRef.current);

      try {
        const cleanMessages = newMessages.map(({ thinking: _, ...rest }) => rest);
        await chatStream(conversationId, model, cleanMessages);
      } catch (e) {
        setStreaming(false);
        setError(String(e));
      }
    },
    [conversationId, model, streaming]
  );

  const stopStreaming = useCallback(() => {
    if (conversationId) {
      cancelChat(conversationId).catch(console.error);
    }
  }, [conversationId]);

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

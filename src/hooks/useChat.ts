/**
 * useChat — thin React wrapper around the long-lived chatStream store.
 *
 * The store is responsible for listener wiring and per-session state;
 * this hook just exposes per-slice selectors and the send/stop/reload
 * actions. Each slice is its own Zustand subscription, so a component
 * using this hook only re-renders when one of the slices it actually
 * reads changes. The previous version subscribed to a global version
 * counter, which caused 60Hz re-renders on every chunk arrival even
 * for components that didn't care about streaming state.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { loadSessionMessages, sendMessage, stopStream, clearSessionMessages, SessionState, useChatStreamStore } from "../stores/chatStream";

export interface UseChat {
  messages: SessionState["messages"];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  totalTokens: number;
  error: string | null;
  loadingMessages: boolean;
  send: (text: string, options?: { systemOverride?: string; attachmentsJson?: string | null }) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => Promise<void>;
}

const EMPTY_MESSAGES: SessionState["messages"] = [];

export function useChat(
  sessionId: string | null,
  modelName: string,
  providerId: string = ""
): UseChat {
  // Per-slice subscriptions. Each `useChatStreamStore` call is its
  // own subscription; Zustand compares the returned value with the
  // previous via Object.is, so a primitive slice re-renders only on
  // value change, and a stable array slice (e.g. messages) only
  // re-renders when the array reference changes.
  const streaming = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.streaming ?? false : false)
  );
  const streamContent = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.streamContent ?? "" : "")
  );
  const streamThinking = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.streamThinking ?? "" : "")
  );
  const messages = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES)
  );
  const error = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.error ?? null : null)
  );
  const loadingMessages = useChatStreamStore(
    (s) => (sessionId ? s.sessions[sessionId]?.loadingMessages ?? false : false)
  );

  // Fire loadSessionMessages exactly once per sessionId. The
  // previous version used a `version` counter in the deps so any
  // store update would re-check; that was the 60Hz amplifier. The
  // load is idempotent (the store guards against double-loads via
  // the `loadedFor` ref below) so we can drop the version dep.
  const loadedFor = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId) return;
    if (loadedFor.current.has(sessionId)) return;
    loadedFor.current.add(sessionId);
    loadSessionMessages(sessionId).catch((e) => {
      console.error("loadSessionMessages:", e);
      loadedFor.current.delete(sessionId);
    });
  }, [sessionId]);

  const totalTokens = useMemo(
    () => messages.reduce(
      (sum, m) => sum + (m.prompt_tokens || 0) + (m.output_tokens || 0),
      0
    ),
    [messages]
  );

  const send = useCallback(
    async (text: string, options?: { systemOverride?: string; attachmentsJson?: string | null }) => {
      if (!sessionId) return;
      await sendMessage(sessionId, text, modelName, {
        systemOverride: options?.systemOverride,
        attachmentsJson: options?.attachmentsJson,
        providerId: providerId || undefined,
      });
    },
    [sessionId, modelName, providerId]
  );

  const stop = useCallback(async () => {
    if (!sessionId) return;
    await stopStream(sessionId);
  }, [sessionId]);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    await clearSessionMessages(sessionId);
    await loadSessionMessages(sessionId);
  }, [sessionId]);

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

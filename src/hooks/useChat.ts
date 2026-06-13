/**
 * useChat — thin React wrapper around the long-lived chatStream store.
 *
 * The store is responsible for listener wiring and per-session state;
 * this hook just subscribes to a single session's state and exposes
 * send/stop/reload actions. Because the listeners live in the store, a
 * session that's actively streaming keeps updating its state in the
 * background even when the user navigates to another session — when
 * they come back, the latest state is already there.
 */
import { useEffect, useState, useRef } from "react";
import { getSessionState, loadSessionMessages, sendMessage, stopStream, clearSessionMessages, SessionState, useChatStreamStore } from "../stores/chatStream";
import { Preset } from "../lib/api";

export interface UseChat {
  messages: SessionState["messages"];
  streaming: boolean;
  streamContent: string;
  streamThinking: string;
  totalTokens: number;
  error: string | null;
  loadingMessages: boolean;
  send: (text: string, options?: { systemOverride?: string; presetOverride?: Preset | null }) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useChat(
  sessionId: string | null,
  currentPreset: Preset | null,
  modelName: string,
  presetId: string | null
): UseChat {
  // Subscribe to the store version so we re-render on any change.
  // We also reach into the per-session slot for the current snapshot.
  const version = useChatStreamStore((s) => s.version);

  // Track which sessions we've kicked off a load for; we want to fire
  // loadSessionMessages exactly once per sessionId (unless reload() is
  // called explicitly).
  const loadedFor = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId) return;
    if (loadedFor.current.has(sessionId)) return;
    loadedFor.current.add(sessionId);
    loadSessionMessages(sessionId).catch((e) => {
      console.error("loadSessionMessages:", e);
      loadedFor.current.delete(sessionId);
    });
  }, [sessionId, version]);

  const snap: SessionState = sessionId
    ? getSessionState(sessionId)
    : { messages: [], streaming: false, streamContent: "", streamThinking: "", error: null, loadingMessages: false };

  const totalTokens = snap.messages.reduce(
    (sum, m) => sum + (m.prompt_tokens || 0) + (m.output_tokens || 0),
    0
  );

  return {
    messages: snap.messages,
    streaming: snap.streaming,
    streamContent: snap.streamContent,
    streamThinking: snap.streamThinking,
    totalTokens,
    error: snap.error,
    loadingMessages: snap.loadingMessages,
    send: async (text, options) => {
      if (!sessionId) return;
      const preset = options?.presetOverride !== undefined ? options.presetOverride : currentPreset;
      await sendMessage(sessionId, text, modelName, preset, {
        systemOverride: options?.systemOverride,
        presetOverride: options?.presetOverride,
      });
    },
    stop: async () => {
      if (!sessionId) return;
      await stopStream(sessionId);
    },
    reload: async () => {
      if (!sessionId) return;
      await clearSessionMessages(sessionId);
      await loadSessionMessages(sessionId);
    },
  };
}

import { useState, useEffect, useCallback } from "react";
import {
  listConversations,
  createConversation,
  deleteConversation,
  renameConversation,
} from "../lib/commands";
import type { Conversation, OllamaModel } from "../types";

export function useConversations(model: string) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const convs = await listConversations();
      setConversations(convs);
    } catch (e) {
      console.error("Failed to load conversations:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (title?: string) => {
      const conv = await createConversation(title || "New Chat", model);
      await refresh();
      return conv;
    },
    [model, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      await refresh();
    },
    [refresh]
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await renameConversation(id, title);
      await refresh();
    },
    [refresh]
  );

  return { conversations, loading, refresh, create, remove, rename };
}

import { invoke } from "@tauri-apps/api/core";
import { type Conversation, type OllamaModel, type ChatMessage } from "../types";

export async function listModels(): Promise<OllamaModel[]> {
  return invoke("list_models");
}

export async function listConversations(): Promise<Conversation[]> {
  return invoke("list_conversations");
}

export async function createConversation(
  title: string,
  model: string
): Promise<Conversation> {
  return invoke("create_conversation", { title, model });
}

export async function renameConversation(
  id: string,
  title: string
): Promise<void> {
  return invoke("rename_conversation", { id, title });
}

export async function deleteConversation(id: string): Promise<void> {
  return invoke("delete_conversation", { id });
}

export async function getMessages(id: string): Promise<ChatMessage[]> {
  return invoke("get_messages", { id });
}

export async function chatStream(
  conversationId: string,
  model: string,
  messages: ChatMessage[]
): Promise<void> {
  return invoke("chat_stream", {
    conversationId,
    model,
    messages,
  });
}

export async function getConversation(id: string): Promise<Conversation> {
  return invoke("get_conversation", { id });
}

export async function saveConversationMessages(
  id: string,
  messages: ChatMessage[]
): Promise<void> {
  return invoke("save_conversation_messages", { id, messages });
}

export async function cancelChat(conversationId: string): Promise<void> {
  return invoke("cancel_chat", { conversationId });
}

export async function getModelContextLength(model: string): Promise<number> {
  return invoke("get_model_context_length", { model });
}

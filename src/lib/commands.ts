import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Conversation, type OllamaModel, type ChatMessage, type OllamaStatus, type LibraryModel, type PullProgress, type RunningModel } from "../types";

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

export async function checkOllamaStatus(): Promise<OllamaStatus> {
  return invoke("check_ollama_status");
}

export async function pullModel(name: string): Promise<void> {
  return invoke("pull_model", { name });
}

export async function deleteModel(name: string): Promise<void> {
  return invoke("delete_model", { name });
}

export async function getModelCatalog(): Promise<LibraryModel[]> {
  return invoke("get_model_catalog");
}

export async function getRunningModels(): Promise<RunningModel[]> {
  return invoke("get_running_models");
}

export async function createCustomModel(
  name: string,
  baseModel: string,
  numCtx: number
): Promise<void> {
  return invoke("create_custom_model", { name, baseModel, numCtx });
}

export function onPullProgress(
  handler: (progress: PullProgress) => void
): Promise<() => void> {
  return listen<PullProgress>("pull-progress", (event) => handler(event.payload));
}

export function onPullDone(handler: (name: string) => void): Promise<() => void> {
  return listen<string>("pull-done", (event) => handler(event.payload));
}

export function onPullError(handler: (error: string) => void): Promise<() => void> {
  return listen<string>("pull-error", (event) => handler(event.payload));
}

export function onCreateProgress(
  handler: (status: string) => void
): Promise<() => void> {
  return listen<string>("create-progress", (event) => handler(event.payload));
}

export function onCreateDone(handler: (name: string) => void): Promise<() => void> {
  return listen<string>("create-done", (event) => handler(event.payload));
}

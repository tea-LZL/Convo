import { ChatMessage } from "../../lib/api";

export const userMessage: ChatMessage = {
  id: "msg-user-1",
  session_id: "sess-1",
  role: "user",
  content: "Hello, assistant!",
  thinking: null,
  attachments_json: null,
  prompt_tokens: 12,
  output_tokens: null,
  created_at: "2024-01-01T12:00:00Z",
};

export const assistantMessage: ChatMessage = {
  id: "msg-assistant-1",
  session_id: "sess-1",
  role: "assistant",
  content: "Hello! How can I help you today?",
  thinking: "The user greeted me.",
  attachments_json: null,
  prompt_tokens: 12,
  output_tokens: 9,
  created_at: "2024-01-01T12:00:05Z",
};

export const systemMessage: ChatMessage = {
  id: "msg-system-1",
  session_id: "sess-1",
  role: "system",
  content: "You are a helpful assistant.",
  thinking: null,
  attachments_json: null,
  prompt_tokens: 6,
  output_tokens: null,
  created_at: "2024-01-01T11:59:00Z",
};

export const messageThread = [systemMessage, userMessage, assistantMessage];

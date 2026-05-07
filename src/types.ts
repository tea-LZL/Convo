export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  promptTokens?: number;
  outputTokens?: number;
  completedAt?: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

export interface ChatChunkPayload {
  conversation_id: string;
  content: string;
  full_content: string;
}

export interface ChatThinkingPayload {
  conversation_id: string;
  thinking: string;
}

export interface ChatDonePayload {
  conversation_id: string;
  prompt_tokens: number;
  output_tokens: number;
  completed_at: string;
}

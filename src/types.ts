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

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string;
}

export interface LibraryModel {
  name: string;
  description: string;
  size: string;
  macos_only: boolean;
  pull_count?: string;
  tags?: string[];
}

export interface PullProgress {
  status: string;
  digest: string;
  total: number;
  completed: number;
  percent: number;
}

export interface RunningModelDetails {
  parent_model: string;
  format: string;
  family: string;
  families: string[] | null;
  parameter_size: string;
  quantization_level: string;
}

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: RunningModelDetails;
  expires_at: string;
  size_vram: number;
  context_length: number;
}

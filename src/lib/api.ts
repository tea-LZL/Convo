/**
 * Thin Tauri command wrappers — the only file that should call `invoke()` for
 * Rust commands. Provides type safety + a single place to mock for tests.
 */
import { invoke } from "@tauri-apps/api/core";

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
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

export interface RunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
  expires_at: string;
  size_vram: number;
  context_length: number;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string;
}

// Session + Message types (mirrors Rust db::models)
export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  thinking: string | null;
  attachments_json: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface Preset {
  id: string;
  name: string;
  system_prompt: string | null;
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  num_ctx: number | null;
  repeat_penalty: number | null;
  stop: string | null;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Model {
  id: string;
  provider_id: string;
  name: string;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  context_length: number | null;
  size_bytes: number | null;
  supports_thinking: boolean;
  supports_vision: boolean;
  last_seen: string;
}

export interface Provider {
  id: string;
  kind: "ollama" | "openai_compat";
  name: string;
  base_url: string | null;
  has_api_key?: boolean;
  api_key?: string | null;
  is_default: boolean;
  created_at: string;
}

export interface Session {
  id: string;
  title: string;
  model_id: string | null;
  provider_id: string | null;
  preset_id: string | null;
  group_id: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  snippet?: string;
}

export type SessionWithSnippet = Session & { snippet: string };

export interface CompareConfig {
  prompt: string;
  models: Array<{ provider_id: string; model: string }>;
  system?: string;
  temperature?: number;
  top_p?: number;
}

export interface CompareRunResult {
  content: string;
  thinking: string;
  prompt_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  cancelled?: boolean;
  error?: string | null;
}

export interface CompareRunSummary {
  id: string;
  prompt: string;
  config_json: string;
  results_json: string | null;
  winner_index: number | null;
  created_at: string;
}

export interface DiscoveredServer {
  base_url: string;
  kind: string;
  models: Array<{ id: string; name: string; context_length: number | null }>;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  models: Array<{ id: string; name: string; context_length: number | null }>;
}

export interface Note {
  id: string;
  title: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  title: string;
  body: string | null;
  due_at: string | null;
  completed_at: string | null;
  priority: number;
  session_id: string | null;
  created_at: string;
}

export interface MemoryItem {
  id: string;
  kind: "user_pref" | "project_fact" | "skill";
  title: string | null;
  content: string;
  tags: string | null;
  is_enabled?: number;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  title: string;
  content: string;
  kind: "markdown" | "code" | "text" | "csv";
  language: string | null;
  file_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchConfig {
  provider: string;
  base_url: string | null;
  api_key: string | null;
  max_results: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface AppInfo {
  version: string;
  data_dir: string;
  db_path: string;
  os: string;
  arch: string;
}

export const api = {
  // Settings
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  getAllSettings: () => invoke<Array<[string, string]>>("get_all_settings"),
  appInfo: () => invoke<AppInfo>("app_info"),
  openDataDir: () => invoke<string>("open_data_dir"),

  // Sessions
  listSessions: (groupId?: string | null, includeArchived = false) =>
    invoke<Session[]>("list_sessions", { groupId: groupId ?? null, includeArchived }),
  createSession: (opts: {
    title?: string;
    modelId?: string | null;
    providerId?: string | null;
    presetId?: string | null;
    groupId?: string | null;
  }) =>
    invoke<Session>("create_session", {
      title: opts.title ?? "New Chat",
      modelId: opts.modelId ?? null,
      providerId: opts.providerId ?? null,
      presetId: opts.presetId ?? null,
      groupId: opts.groupId ?? null,
    }),
  renameSession: (id: string, title: string) => invoke<void>("rename_session", { id, title }),
  updateSessionModel: (id: string, modelId: string, providerId?: string | null, presetId?: string | null) =>
    invoke<void>("update_session_model", { id, modelId, providerId: providerId ?? null, presetId: presetId ?? null }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  setSessionPinned: (id: string, pinned: boolean) =>
    invoke<void>("set_session_pinned", { id, pinned }),
  setSessionArchived: (id: string, archived: boolean) =>
    invoke<void>("set_session_archived", { id, archived }),
  searchSessions: (query: string) => invoke<Array<SessionWithSnippet>>("search_sessions", { query }),
  exportSessionMarkdown: (id: string) => invoke<string>("export_session_markdown", { id }),
  listModelsForProvider: (providerId: string) => invoke<Model[]>("list_models_for_provider", { providerId }),
  listAllModels: () => invoke<Model[]>("list_all_models"),
  refreshModels: (providerId: string) => invoke<Model[]>("refresh_models", { providerId }),

  // Messages
  listMessages: (sessionId: string) => invoke<ChatMessage[]>("list_messages", { sessionId }),
  saveMessages: (sessionId: string, messages: ChatMessage[]) =>
    invoke<void>("save_messages", { sessionId, messages }),
  appendMessage: (sessionId: string, role: string, content: string, thinking?: string, attachmentsJson?: string) =>
    invoke<string>("append_message", { sessionId, role, content, thinking: thinking ?? null, attachmentsJson: attachmentsJson ?? null }),

  // Chat streaming (new)
  chatStream: (args: {
    sessionId: string;
    model: string;
    messages: Array<{ role: string; content: string; thinking?: string; images?: string[] }>;
    system?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    numCtx?: number;
    repeatPenalty?: number;
    stop?: string[];
  }) => invoke<void>("chat_stream_v2", { args }),
  cancelChat: (sessionId: string) => invoke<void>("cancel_chat_v2", { sessionId }),

  // Presets
  listPresets: () => invoke<Preset[]>("list_presets"),
  upsertPreset: (preset: Partial<Preset> & { name: string }) =>
    invoke<string>("upsert_preset", { preset }),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),

  // Providers
  listProviders: () => invoke<Provider[]>("list_providers"),
  addProvider: (kind: string, name: string, baseUrl: string | null, apiKey: string | null) =>
    invoke<Provider>("add_provider", { kind, name, baseUrl, apiKey }),
  updateProvider: (id: string, name: string | null, baseUrl: string | null, apiKey: string | null, isDefault: boolean | null) =>
    invoke<void>("update_provider", { id, name, baseUrl, apiKey, isDefault }),
  deleteProvider: (id: string) => invoke<void>("delete_provider", { id }),
  probeProvider: (kind: string, baseUrl: string, apiKey?: string) =>
    invoke<ProbeResult>("probe_provider", { kind, baseUrl, apiKey: apiKey ?? null }),
  discoverLocalServers: () => invoke<DiscoveredServer[]>("discover_local_servers"),

  // Themes
  listThemes: () => invoke<Array<{ id: string; name: string; is_builtin: boolean; tokens_json: string; created_at: string }>>("list_themes"),
  saveTheme: (name: string, tokensJson: string) => invoke<string>("save_theme", { name, tokensJson }),
  deleteTheme: (id: string) => invoke<void>("delete_theme", { id }),

  // Notes
  listNotes: () => invoke<Note[]>("list_notes"),
  upsertNote: (note: Partial<Note> & { body: string }) => invoke<string>("upsert_note", { note }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),

  // Tasks
  listTasks: () => invoke<Task[]>("list_tasks"),
  upsertTask: (task: Partial<Task> & { title: string }) => invoke<string>("upsert_task", { task }),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),
  completeTask: (id: string, completed: boolean) => invoke<void>("complete_task", { id, completed }),

  // Memory
  listMemory: () => invoke<MemoryItem[]>("list_memory"),
  upsertMemory: (item: Partial<MemoryItem> & { kind: string; content: string }) =>
    invoke<string>("upsert_memory", { item }),
  deleteMemory: (id: string) => invoke<void>("delete_memory", { id }),
  toggleMemory: (id: string, enabled: boolean) => invoke<void>("toggle_memory", { id, enabled }),

  // Documents
  listDocuments: () => invoke<Document[]>("list_documents"),
  upsertDocument: (doc: Partial<Document> & { title: string; content: string }) =>
    invoke<string>("upsert_document", { doc }),
  deleteDocument: (id: string) => invoke<void>("delete_document", { id }),
  aiEditDocument: (opts: { currentText: string; instruction: string; selection?: string | null; modelId?: string | null; providerId?: string | null }) =>
    invoke<string>("ai_edit_document", {
      currentText: opts.currentText,
      instruction: opts.instruction,
      selection: opts.selection ?? null,
      modelId: opts.modelId ?? null,
      providerId: opts.providerId ?? null,
    }),

  // Attachments
  addAttachment: (opts: { name: string; mime: string; dataBase64: string; sessionId: string | null; messageId: string | null }) =>
    invoke<{ id: string; name: string; mime: string; size: number; kind: string; blob_path: string | null; width: number | null; height: number | null; extracted_text: string | null; created_at: string }>(
      "add_attachment",
      opts
    ),
  getAttachmentData: (id: string) => invoke<string>("get_attachment_data", { id }),
  deleteAttachment: (id: string) => invoke<void>("delete_attachment", { id }),

  // Ollama (legacy)
  listModels: () => invoke<OllamaModel[]>("list_models"),
  getModelContextLength: (model: string) => invoke<number>("get_model_context_length", { model }),
  getRunningModels: () => invoke<RunningModel[]>("get_running_models"),
  checkOllamaStatus: () => invoke<OllamaStatus>("check_ollama_status"),
  getModelCatalog: () => invoke<LibraryModel[]>("get_model_catalog"),
  pullModel: (name: string) => invoke<void>("pull_model", { name }),
  deleteModel: (name: string) => invoke<void>("delete_model", { name }),
  createCustomModel: (name: string, baseModel: string, numCtx: number) =>
    invoke<void>("create_custom_model", { name, baseModel, numCtx }),

  // Search
  getSearchConfig: () => invoke<SearchConfig | null>("get_search_config"),
  setSearchConfig: (config: SearchConfig) => invoke<void>("set_search_config", { config }),
  webSearch: (query: string, config: SearchConfig | null) =>
    invoke<SearchResult[]>("web_search", { query, config }),

  // Compare
  runCompare: (config: CompareConfig) => invoke<string>("run_compare", { config }),
  cancelCompare: (runId: string) => invoke<void>("cancel_compare", { runId }),
  cancelCompareColumn: (runId: string, index: number) =>
    invoke<void>("cancel_compare_column", { runId, index }),
  saveCompareWinner: (runId: string, winnerIndex: number) =>
    invoke<void>("save_compare_winner", { runId, winnerIndex }),
  saveCompareAsSession: (runId: string, winnerIndex: number) =>
    invoke<string>("save_compare_as_session", { runId, winnerIndex }),
  listCompareRuns: (limit?: number) => invoke<CompareRunSummary[]>("list_compare_runs", { limit: limit ?? 50 }),
  getCompareRun: (id: string) => invoke<CompareRunSummary>("get_compare_run", { id }),

  // Slash commands
  listSlashCommands: () => invoke<Array<{ id: string; name: string; description: string | null; body: string; preset_id: string | null; created_at: string }>>("list_slash_commands"),
  upsertSlashCommand: (cmd: { id?: string; name: string; description?: string; body: string; preset_id?: string }) =>
    invoke<string>("upsert_slash_command", { cmd }),
  deleteSlashCommand: (id: string) => invoke<void>("delete_slash_command", { id }),
};

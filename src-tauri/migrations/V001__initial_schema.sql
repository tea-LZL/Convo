-- Convo initial schema (v1)

CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Providers (Ollama, OpenAI-compat, etc.)
CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                -- 'ollama' | 'openai_compat'
    name TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_providers_default ON providers(is_default);

-- Models (cached metadata, per provider)
CREATE TABLE models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    family TEXT,
    parameter_size TEXT,
    quantization TEXT,
    context_length INTEGER,
    size_bytes INTEGER,
    supports_thinking INTEGER NOT NULL DEFAULT 0,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(provider_id, name)
);
CREATE INDEX idx_models_provider ON models(provider_id);

-- Session groups
CREATE TABLE session_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sessions (chats)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
    group_id TEXT REFERENCES session_groups(id) ON DELETE SET NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_group ON sessions(group_id);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                -- 'user' | 'assistant' | 'system' | 'tool'
    content TEXT NOT NULL,
    thinking TEXT,
    attachments_json TEXT,             -- JSON array of attachment refs
    prompt_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);

-- Message branches (for edit-and-resend / regenerate alternatives)
CREATE TABLE message_branches (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thinking TEXT,
    prompt_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_branches_message ON message_branches(message_id);

-- Presets (system prompts, sampling)
CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT,
    temperature REAL,
    top_p REAL,
    top_k INTEGER,
    num_ctx INTEGER,
    repeat_penalty REAL,
    stop TEXT,                          -- JSON array
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Attachments
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- 'image' | 'document' | 'audio'
    blob_path TEXT,
    width INTEGER,
    height INTEGER,
    extracted_text TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_attachments_session ON attachments(session_id);

-- Documents
CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'markdown',
    language TEXT,
    file_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);

-- Notes
CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC);

-- Tasks
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    due_at TEXT,
    completed_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tasks_completed ON tasks(completed_at);
CREATE INDEX idx_tasks_due ON tasks(due_at);

-- Memory items (long-term project context)
CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                -- 'user_pref' | 'project_fact' | 'skill'
    title TEXT,
    content TEXT NOT NULL,
    tags TEXT,                          -- comma-separated
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Search provider config
CREATE TABLE search_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,             -- 'searxng' | 'duckduckgo' | 'brave'
    base_url TEXT,
    api_key TEXT,
    max_results INTEGER NOT NULL DEFAULT 5
);

-- Settings (key-value)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Themes (user-defined)
CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    tokens_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Compare runs (history)
CREATE TABLE compare_runs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    config_json TEXT NOT NULL,         -- model list, preset, etc.
    results_json TEXT,                  -- collected responses
    winner_index INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Custom slash commands
CREATE TABLE slash_commands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    body TEXT NOT NULL,
    preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

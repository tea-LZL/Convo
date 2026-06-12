-- Convo v2 schema: full-text search via FTS5, memory kinds, skill storage.

-- Memory items get a "tags" index for LIKE-search filtering
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_items(kind);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);

-- Notes get tags and source_session_id for cross-linking
ALTER TABLE notes ADD COLUMN tags TEXT;
ALTER TABLE notes ADD COLUMN source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(source_session_id);

-- Tasks get tags too
ALTER TABLE tasks ADD COLUMN tags TEXT;

-- FTS5 virtual tables for fast message and memory search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title,
    content,
    tags,
    content='memory_items',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync with messages
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Triggers to keep FTS in sync with memory_items
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts(rowid, title, content, tags) VALUES (new.rowid, COALESCE(new.title, ''), new.content, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, tags) VALUES('delete', old.rowid, COALESCE(old.title, ''), old.content, COALESCE(old.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, tags) VALUES('delete', old.rowid, COALESCE(old.title, ''), old.content, COALESCE(old.tags, ''));
    INSERT INTO memory_fts(rowid, title, content, tags) VALUES (new.rowid, COALESCE(new.title, ''), new.content, COALESCE(new.tags, ''));
END;

-- Per-session enabled skills/memory (composable)
CREATE TABLE IF NOT EXISTS session_overrides (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, item_id)
);

-- Repair databases whose user_version reached 9 without the V006 objects.
--
-- V006 was added after some installs had already recorded a later version.
-- rusqlite_migration never re-executes a recorded version, so amending
-- V006 cannot create these tables on those databases. Recall selects
-- memory_items.superseded_by and reads notes_fts; a missing column or
-- table errors, the error is discarded, and the prompt goes out with no
-- memory in it.
--
-- The column adds are not in this file. This SQLite rejects
-- `ADD COLUMN IF NOT EXISTS`, and `memory_items.pinned` is already present
-- on the database this repairs, so an unconditional ALTER fails. The Rust
-- hook added with this migration checks pragma_table_info and adds only
-- the missing columns, then creates the indexes that depend on them.
--
-- pending_memory_reviews is left as it is. Replaying V006's rebuild would
-- drop a table whose rows are not in V006's shape.
-- memory_fts is left as it is. Its triggers have already indexed the rows
-- recall needs, and a second insert changes their rank.

CREATE TABLE IF NOT EXISTS memory_embeddings (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('memory', 'note')),
    owner_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_emb_owner ON memory_embeddings(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_emb_model ON memory_embeddings(model, dim);

CREATE TABLE IF NOT EXISTS memory_events (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('memory', 'note')),
    owner_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('recall', 'extract', 'reinforce', 'supersede')),
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_owner ON memory_events(owner_type, owner_id, event);
CREATE INDEX IF NOT EXISTS idx_events_recent ON memory_events(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_watermark (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    tags,
    content='notes',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body, COALESCE(old.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body, COALESCE(old.tags, ''));
    INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body, COALESCE(new.tags, ''));
END;

-- A session that recorded V009 already has this table. One that did not
-- still needs it, or a scoped chat cannot tell "no restriction" from
-- "this chat admits nothing".
CREATE TABLE IF NOT EXISTS session_memory_scope (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

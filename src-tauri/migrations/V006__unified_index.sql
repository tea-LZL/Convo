-- Convo v3 schema: the unified knowledge index.
--
-- Memories and notes become one retrieval surface. Retrieval cannot tell
-- them apart; the UI filters by owner_type. Two FTS5 tables rather than
-- one, because an external-content FTS table binds to a single content
-- table — a shared one would need a hand-maintained denormalised shadow.
-- Same column shape and tokenizer on both, so their BM25 scores are
-- comparable and can be fused.
--
-- Everything here is additive. The one rebuild is pending_memory_reviews,
-- whose V004 UNIQUE(session_id) capped a session at one extraction
-- attempt for its whole life; a watermark column replaces that cap.

-- ---------------------------------------------------------------------------
-- Revision and provenance columns on memory_items
-- ---------------------------------------------------------------------------

-- How confident the extractor was. Auto-apply is gated on this.
ALTER TABLE memory_items ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;

-- Times this item was recalled, and when it was last seen. Both feed the
-- reinforcement boost and the recency decay in retrieval scoring.
ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN last_seen_at TEXT;

-- Set when a newer memory replaces this one. A superseded row is excluded
-- from recall but retained, so the history of a correction stays readable.
ALTER TABLE memory_items ADD COLUMN superseded_by TEXT;

-- Bidirectional provenance with notes: a note records the memories it
-- produced, a memory records the note it came from.
ALTER TABLE memory_items ADD COLUMN source_note_id TEXT;
ALTER TABLE memory_items ADD COLUMN source_session_id TEXT;

-- Cached token estimate, so context budgeting does not re-tokenize the
-- whole index on every send.
ALTER TABLE memory_items ADD COLUMN token_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_memory_superseded ON memory_items(superseded_by);
CREATE INDEX IF NOT EXISTS idx_memory_source_note ON memory_items(source_note_id);

-- ---------------------------------------------------------------------------
-- Notes join the index
-- ---------------------------------------------------------------------------

-- Pinned notes are always injected, budget permitting, regardless of what
-- retrieval ranks.
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN token_count INTEGER;
ALTER TABLE notes ADD COLUMN source_note_id TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned, updated_at DESC);

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

-- Backfill. Triggers only fire on write, so every row that existed before
-- this migration is invisible to FTS until it is next edited. Without
-- this, a user's entire existing note library is unsearchable.
--
-- 'rebuild' rather than INSERT ... SELECT: a raw re-insert would add a
-- second posting for every row the V002 triggers had already indexed,
-- doubling its term frequency and inflating its BM25 score. Measured:
-- one row's rank went from -1.73 to -2.46 across this migration, i.e.
-- every existing memory would have gained a spurious relevance boost.
-- 'rebuild' regenerates the index from the content table exactly once.
INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');

-- ---------------------------------------------------------------------------
-- Embeddings
-- ---------------------------------------------------------------------------
--
-- model and dim are recorded per row so switching embedding models is
-- detectable: vectors from a 768-dim model and a 1024-dim model are not
-- comparable, and mixing them in one cosine neighbourhood would produce
-- confident nonsense. Rows whose model or dim do not match the configured
-- one are treated as needing re-embedding, not as candidates for scoring.

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

-- The same repair for memory_fts, which has had this defect since V002:
-- its triggers were created after memory_items already had rows, so any
-- memory written before v0.2 has never been searchable. Fixed here
-- because V006 is the first migration where the index actually matters.
--
-- 'rebuild' because a raw re-insert would double the term frequency of
-- every row V002's triggers already indexed, and inflate its rank.
-- Measured: one row's BM25 went from -1.73 to -2.46 across this
-- migration, i.e. every existing memory would gain a relevance boost it
-- had not earned.
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');

-- ---------------------------------------------------------------------------
-- Access log
-- ---------------------------------------------------------------------------
--
-- Retrieval writes a row per recall; revision writes one per reinforce or
-- supersede. This is what makes reinforcement and decay computable rather
-- than guessed from updated_at alone.

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

-- ---------------------------------------------------------------------------
-- Rebuild pending_memory_reviews
-- ---------------------------------------------------------------------------
--
-- V004 declared session_id UNIQUE, so a session could only ever be queued
-- once. A watermark replaces that: the next round resumes after the last
-- extracted message instead of being forbidden. Rows are copied before the
-- old table is dropped, so in-flight reviews survive.

CREATE TABLE pending_memory_reviews_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    facts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('extracting', 'pending', 'failed', 'reviewed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    watermark_message_id TEXT
);

INSERT INTO pending_memory_reviews_new (id, session_id, facts_json, status, error, created_at)
SELECT id, session_id, facts_json, status, error, created_at FROM pending_memory_reviews;

DROP TABLE pending_memory_reviews;

ALTER TABLE pending_memory_reviews_new RENAME TO pending_memory_reviews;

-- Dropping the old table dropped its index with it.
CREATE INDEX IF NOT EXISTS idx_memory_reviews_status ON pending_memory_reviews(status, created_at DESC);

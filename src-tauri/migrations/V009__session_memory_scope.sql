-- Whether a session's memory list has been narrowed at all.
--
-- `session_overrides` alone cannot record "this chat admits nothing". Its
-- rows are the admitted ids, and no rows is also what every session that
-- has never touched the feature has — so the honest reading of an empty
-- list was "no restriction", and a user who unchecked every memory got
-- every memory back with no error anywhere. That is the same failure shape
-- as an unpopulated provenance column: a control that looks like it does
-- something and silently does the opposite.
--
-- This table is the bit that separates the two. A row here means the
-- session was scoped deliberately; its admitted set is exactly the
-- `session_overrides` rows for that session, empty list included. A session
-- with override rows and no row here is still scoped — that is what every
-- session written before this migration has, and reading it as unrestricted
-- would silently widen those sessions to the whole library.
--
-- A new migration rather than an amendment to V002: V002 shipped, and a
-- version a database has already recorded is never re-executed.

CREATE TABLE IF NOT EXISTS session_memory_scope (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

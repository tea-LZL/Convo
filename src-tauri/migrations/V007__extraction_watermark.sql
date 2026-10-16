-- Convo v3.1 schema: the extraction watermark.
--
-- How far extraction has got in each session. Without it, a second pass
-- over the same messages re-proposes every fact, the revision pass sees
-- them all as near-duplicates, and REINFORCE fires on all of them: the
-- user's memory fills with restatements of things they already had.
--
-- Its own table rather than a column on pending_memory_reviews, because a
-- session with no pending review still needs a watermark, and a review
-- row is transient while a watermark is not.
--
-- A new migration rather than an amendment to V006: V006 shipped, and a
-- version a database has already recorded is never re-executed, so an
-- amended V006 would leave this table missing on any machine that had
-- already run the app.

CREATE TABLE IF NOT EXISTS memory_watermark (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

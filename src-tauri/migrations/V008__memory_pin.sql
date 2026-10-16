-- A pinned memory is injected on every send, budget permitting,
-- regardless of what retrieval ranks.
--
-- It exists because deleting the always-on context block removed the
-- ability to say "always include this". Retrieval is topK=6 under a
-- token budget, so without a pin a memory the user considers essential
-- becomes conditional on whether the question happens to rank it.
--
-- A new migration rather than an amendment to V006: V006 shipped, and a
-- version a database has already recorded is never re-executed.
--
-- The companion column already exists for notes, added the same way in
-- V006. `sessions.is_pinned` is a different thing and is unrelated.

ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_items(pinned, updated_at DESC);

ALTER TABLE pending_memory_reviews
    ADD COLUMN evaluated_assistant_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pending_memory_reviews
    ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE pending_memory_reviews
SET updated_at = created_at
WHERE updated_at = '';

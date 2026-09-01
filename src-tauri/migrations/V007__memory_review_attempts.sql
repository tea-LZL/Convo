ALTER TABLE pending_memory_reviews
    ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

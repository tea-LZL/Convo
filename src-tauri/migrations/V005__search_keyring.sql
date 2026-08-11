-- Search credentials are migrated to the OS keyring by application code.
-- This marker makes the one-time transfer restart-safe without deleting a
-- legacy credential before the keyring write succeeds.
CREATE TABLE IF NOT EXISTS search_keyring_migration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    migrated_at TEXT NOT NULL
);

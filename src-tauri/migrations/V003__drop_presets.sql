-- Drop the presets feature from the schema. The preset feature
-- was removed from app code in the prior commit. This migration
-- drops the dead storage.
--
-- SQLite ≥ 3.35 (libsql_bundle in tauri 1.x ships 3.45+) supports
-- ALTER TABLE ... DROP COLUMN. The presets.id FK on sessions and
-- slash_commands was ON DELETE SET NULL, so the column drop is
-- safe; any pre-existing preset_id values become orphaned on
-- the way out, and the app no longer reads either column.

DROP TABLE IF EXISTS presets;
ALTER TABLE sessions DROP COLUMN preset_id;
ALTER TABLE slash_commands DROP COLUMN preset_id;

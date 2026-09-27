use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite_migration::{Migrations, M};
use std::path::PathBuf;
use std::sync::Arc;

pub mod legacy;
pub mod models;

pub type DbPool = Pool<SqliteConnectionManager>;

const MIGRATION_V001: &str = include_str!("../../migrations/V001__initial_schema.sql");
const MIGRATION_V002: &str = include_str!("../../migrations/V002__fts_and_skills.sql");
const MIGRATION_V003: &str = include_str!("../../migrations/V003__drop_presets.sql");
const MIGRATION_V004: &str = include_str!("../../migrations/V004__memory_reviews.sql");
const MIGRATION_V005: &str = include_str!("../../migrations/V005__search_keyring.sql");
const MIGRATION_V006: &str = include_str!("../../migrations/V006__unified_index.sql");
const MIGRATION_V007: &str = include_str!("../../migrations/V007__extraction_watermark.sql");
const MIGRATION_V008: &str = include_str!("../../migrations/V008__memory_pin.sql");

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(MIGRATION_V001),
        M::up(MIGRATION_V002),
        M::up(MIGRATION_V003),
        M::up(MIGRATION_V004),
        M::up(MIGRATION_V005),
        M::up(MIGRATION_V006),
        M::up(MIGRATION_V007),
        M::up(MIGRATION_V008),
    ])
}

pub fn data_dir() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("convo");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::create_dir_all(dir.join("blobs"));
    let _ = std::fs::create_dir_all(dir.join("logs"));
    let _ = std::fs::create_dir_all(dir.join("themes"));
    dir
}

pub fn db_path() -> PathBuf {
    data_dir().join("convo.db")
}

pub fn init_pool() -> Result<Arc<DbPool>, String> {
    let manager = SqliteConnectionManager::file(db_path()).with_init(|c| {
        c.execute_batch(
            "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA temp_store = MEMORY;",
        )
    });
    let pool = Pool::builder()
        .max_size(8)
        .build(manager)
        .map_err(|e| format!("Failed to build DB pool: {}", e))?;
    Ok(Arc::new(pool))
}

/// The real migration chain, for tests that need the actual schema rather
/// than a hand-rolled approximation. `#[cfg(test)]` so no command can reach
/// it.
#[cfg(test)]
pub(crate) fn migrations_for_tests() -> Migrations<'static> {
    migrations()
}

pub fn run_migrations(pool: &DbPool) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let m = migrations();
    m.to_latest(&mut conn)
        .map_err(|e| format!("Migration failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    #[test]
    fn migrates_existing_database_to_memory_reviews() {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrations::new(vec![
            M::up(MIGRATION_V001),
            M::up(MIGRATION_V002),
            M::up(MIGRATION_V003),
        ])
        .to_latest(&mut conn)
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES ('existing', 'Existing')",
            [],
        )
        .unwrap();

        migrations().to_latest(&mut conn).unwrap();

        let table: String = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_memory_reviews'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let session: String = conn
            .query_row(
                "SELECT title FROM sessions WHERE id = 'existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, "pending_memory_reviews");
        assert_eq!(session, "Existing");
    }

    /// A realistic v5 database: a session, a turn of messages, a durable
    /// memory, a note, and an in-flight review the user has not looked at.
    /// A migration that only passes against an empty database has not been
    /// tested at all.
    fn populated_v5() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrations::new(vec![
            M::up(MIGRATION_V001),
            M::up(MIGRATION_V002),
            M::up(MIGRATION_V003),
            M::up(MIGRATION_V004),
            M::up(MIGRATION_V005),
        ])
        .to_latest(&mut conn)
        .unwrap();

        conn.execute("INSERT INTO sessions (id, title) VALUES ('s1', 'Real')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content) VALUES ('m1','s1','user','hello')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content) VALUES ('mem1','project_fact','T','durable')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, body) VALUES ('n1','Note','body text')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES ('r1','s1','pending')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn migrates_a_populated_database_without_losing_data() {
        let mut conn = populated_v5();

        migrations().to_latest(&mut conn).unwrap();

        for (table, id) in [
            ("sessions", "s1"),
            ("messages", "m1"),
            ("memory_items", "mem1"),
            ("notes", "n1"),
            ("pending_memory_reviews", "r1"),
        ] {
            let n: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {} WHERE id = ?1", table),
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "row lost from {}", table);
        }
        let review: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(review, "pending", "in-flight review state must survive");
    }

    #[test]
    fn a_session_can_queue_more_than_one_memory_review_after_v006() {
        // V004 made session_id UNIQUE, which capped a session at one
        // extraction attempt for its whole life. The watermark column
        // replaces that cap.
        let mut conn = populated_v5();
        migrations().to_latest(&mut conn).unwrap();

        conn.execute(
            "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES ('r2','s1','pending')",
            [],
        )
        .unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_memory_reviews WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 2, "V004's UNIQUE session_id must not survive V006");
    }

    #[test]
    fn v6_defaults_are_backfilled_onto_existing_rows() {
        let mut conn = populated_v5();
        migrations().to_latest(&mut conn).unwrap();

        let (confidence, access_count, superseded): (f64, i64, Option<String>) = conn
            .query_row(
                "SELECT confidence, access_count, superseded_by FROM memory_items WHERE id = 'mem1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(confidence, 1.0);
        assert_eq!(access_count, 0);
        assert!(superseded.is_none());

        let pinned: i64 = conn
            .query_row("SELECT pinned FROM notes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pinned, 0);
    }

    #[test]
    fn v8_backfills_the_memory_pin_onto_existing_rows() {
        // A memory written before V008 must survive the ALTER and read as
        // unpinned, not as NULL — a nullable pin is one a reader can silently
        // treat as false, and one the `WHERE pinned = 1` tier scan would skip
        // for the wrong reason.
        let mut conn = populated_v5();
        migrations().to_latest(&mut conn).unwrap();

        let (pinned, content): (i64, String) = conn
            .query_row(
                "SELECT pinned, content FROM memory_items WHERE id = 'mem1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pinned, 0);
        assert_eq!(content, "durable");
    }

    #[test]
    fn v6_creates_the_embedding_and_event_tables_with_their_constraints() {
        let mut conn = populated_v5();
        migrations().to_latest(&mut conn).unwrap();

        // An event outside the allowed set must be refused by the database.
        conn.execute(
            "INSERT INTO memory_events (id, owner_type, owner_id, event) VALUES ('e1','memory','mem1','recall')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO memory_events (id, owner_type, owner_id, event) VALUES ('e2','memory','mem1','nonsense')",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO memory_embeddings (id, owner_type, owner_id, model, dim, vec) VALUES ('v1','nonsense','mem1','m',2,x'00000000')",
                [],
            )
            .is_err());

        // notes_fts must exist and be populated by the trigger.
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "notes_fts trigger did not index the existing note");

        // Rows written BEFORE the migration are indexed by the backfill,
        // not the trigger — triggers only fire on write. Without it, a
        // user's entire existing library is unsearchable.
        let mem_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH 'durable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mem_hits, 1, "memory_fts backfill missed a pre-existing row");
    }

    #[test]
    fn v6_keeps_the_note_index_in_sync_across_updates() {
        // The backfill covers history; the triggers cover everything after.
        let mut conn = populated_v5();
        migrations().to_latest(&mut conn).unwrap();

        conn.execute(
            "UPDATE notes SET body = 'rewritten content' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let stale: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'rewritten'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale, 1);

        conn.execute("DELETE FROM notes WHERE id = 'n1'", [])
            .unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'rewritten'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "delete trigger did not remove the row");
    }
    /// The assertion that actually pins the FTS backfill.
    ///
    /// A row written *after* V002 is already indexed by V002's trigger, so
    /// asserting it is findable after V006 passes whether or not the
    /// backfill runs at all — it proves nothing. This fixture writes the
    /// row *before* the index exists, so the only thing that can index it
    /// is the backfill.
    ///
    /// Applied as raw SQL rather than through the migration framework,
    /// because rusqlite_migration keys on position within a `Migrations`
    /// set: a second, partial set would renumber V002 from 1 and skip it.
    #[test]
    fn v6_backfills_rows_written_before_the_fts_triggers_existed() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V001).unwrap();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content)
             VALUES ('ancient','project_fact','T','a fact that predates the index')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, body) VALUES ('ancient-note','N','a note that predates the index')",
            [],
        )
        .unwrap();
        for sql in [
            MIGRATION_V002,
            MIGRATION_V003,
            MIGRATION_V004,
            MIGRATION_V005,
        ] {
            conn.execute_batch(sql).unwrap();
        }

        // The index now exists and neither row is in it. Creating an
        // external-content FTS table does not populate it; only the
        // triggers do, and these rows predate them.
        let mem_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH 'predates'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mem_before, 0, "fixture is not exercising the memory gap");

        conn.execute_batch(MIGRATION_V006).unwrap();

        let mem_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH 'predates'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let note_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'predates'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mem_after, 1, "V006 did not backfill a pre-V002 memory");
        assert_eq!(note_after, 1, "V006 did not backfill a pre-V002 note");
    }

    /// The backfill must not disturb rows that were already indexed.
    ///
    /// A raw `INSERT ... SELECT` over every row looks alarming: it
    /// re-inserts rows V002's triggers had already indexed. It is safe
    /// because FTS5 external-content insert is idempotent for an
    /// identical (rowid, terms) pair — verified directly, by deliberately
    /// re-inserting a row and observing that neither `fts5vocab`
    /// 'instance' nor 'row' mode gains a posting, and the term count is
    /// unchanged. This test pins the user-visible consequence.
    #[test]
    fn v6_backfill_does_not_change_the_ranking_of_already_indexed_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrations::new(vec![
            M::up(MIGRATION_V001),
            M::up(MIGRATION_V002),
            M::up(MIGRATION_V003),
            M::up(MIGRATION_V004),
            M::up(MIGRATION_V005),
        ])
        .to_latest(&mut conn)
        .unwrap();
        for i in 0..8 {
            conn.execute(
                "INSERT INTO memory_items (id, kind, title, content) VALUES (?1,'project_fact','T','filler unrelated text')",
                params![format!("f{}", i)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content) VALUES ('after','project_fact','T','durable searchable fact')",
            [],
        )
        .unwrap();

        let score = |conn: &Connection| -> f64 {
            conn.query_row(
                "SELECT bm25(memory_fts) FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
                 WHERE memory_fts MATCH 'durable'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        let before = score(&conn);
        migrations().to_latest(&mut conn).unwrap();
        let after = score(&conn);
        assert!(
            (before - after).abs() < 1e-9,
            "the backfill changed an already-indexed row's rank: {} -> {}",
            before,
            after
        );
    }
}

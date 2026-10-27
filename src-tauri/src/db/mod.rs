use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite_migration::{HookResult, Migrations, M};
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
const MIGRATION_V009: &str = include_str!("../../migrations/V009__session_memory_scope.sql");
const MIGRATION_V010: &str = include_str!("../../migrations/V010__repair_skipped_index.sql");
const MIGRATION_V011: &str = include_str!("../../migrations/V011__backfill_notes_index.sql");
const MIGRATION_V012: &str = include_str!("../../migrations/V012__repair_unified_index_final.sql");
const MIGRATION_V013: &str = include_str!("../../migrations/V013__message_memory_used.sql");

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
        M::up(MIGRATION_V009),
        M::up_with_hook(MIGRATION_V010, repair_skipped_index),
        M::up_with_hook(MIGRATION_V011, backfill_empty_notes_index),
        M::up_with_hook(MIGRATION_V012, repair_unified_index_final),
        M::up(MIGRATION_V013),
    ])
}

/// Rebuild `notes_fts` when V010 created it and recorded itself without
/// filling it. A later correction of V010 does not re-run on that database.
fn backfill_empty_notes_index(tx: &rusqlite::Transaction<'_>) -> HookResult {
    let present: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
        [],
        |row| row.get(0),
    )?;
    if present == 0 {
        return Ok(());
    }
    if row_count(tx, "notes")? > 0 && row_count(tx, "notes_fts_docsize")? == 0 {
        tx.execute("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')", [])?;
    }
    Ok(())
}

/// Columns from V006 and V008 that a database can lack after its
/// `user_version` has already moved past them.
///
/// The hook runs after the V010 statements, which create the tables that
/// do not depend on these columns. Indexes that name a new column are
/// created here, once the column exists. `pending_memory_reviews` is not
/// rebuilt, and `memory_fts` is not rewritten: one holds rows whose shape
/// is not V006's, and the other is already populated by the V002 triggers.
fn repair_skipped_index(tx: &rusqlite::Transaction<'_>) -> HookResult {
    for (column, decl) in [
        ("confidence", "REAL NOT NULL DEFAULT 1.0"),
        ("access_count", "INTEGER NOT NULL DEFAULT 0"),
        ("last_seen_at", "TEXT"),
        ("superseded_by", "TEXT"),
        ("source_note_id", "TEXT"),
        ("source_session_id", "TEXT"),
        ("token_count", "INTEGER"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        add_column_if_missing(tx, "memory_items", column, decl)?;
    }
    for (column, decl) in [
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("token_count", "INTEGER"),
        ("source_note_id", "TEXT"),
    ] {
        add_column_if_missing(tx, "notes", column, decl)?;
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memory_superseded ON memory_items(superseded_by);
         CREATE INDEX IF NOT EXISTS idx_memory_source_note ON memory_items(source_note_id);
         CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_items(pinned, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned, updated_at DESC);",
    )?;
    // An external-content FTS table reads its columns straight from `notes`,
    // so `COUNT(*)` is the note count even when the inverted index is
    // empty and MATCH finds nothing. `notes_fts_docsize` is the index.
    // It stays empty until a rebuild or a trigger write, which is how a
    // database that already ran V006 is told apart from one whose
    // notes_fts was created, empty, by the statements above.
    if row_count(tx, "notes")? > 0 && row_count(tx, "notes_fts_docsize")? == 0 {
        tx.execute("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')", [])?;
    }
    Ok(())
}

fn add_column_if_missing(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
    decl: &str,
) -> rusqlite::Result<()> {
    if !column_exists(tx, table, column)? {
        tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

/// The V012 repair: [`repair_skipped_index`], then the same "is the
/// inverted index empty" check for `memory_fts`.
///
/// V010 deliberately left `memory_fts` alone because the V002 triggers
/// populate it. That is true for a database whose V002 ran. It is not an
/// argument that the index is full, and a database repaired by the wrong
/// V010 check can carry an empty `memory_fts` with every memory row
/// still present. The `docsize` shadow table is the index itself, so it
/// tells the two apart the way it does for notes.
///
/// Safe to run on any database: every step is guarded by a column or
/// shadow-table check that no-ops when the work is already done.
fn repair_unified_index_final(tx: &rusqlite::Transaction<'_>) -> HookResult {
    repair_skipped_index(tx)?;
    if table_exists(tx, "memory_fts")?
        && row_count(tx, "memory_items")? > 0
        && row_count(tx, "memory_fts_docsize")? == 0
    {
        tx.execute("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')", [])?;
    }
    Ok(())
}

/// Whether a table exists. Used by the repair hooks before counting a
/// shadow table the table may not have.
fn table_exists(tx: &rusqlite::Transaction<'_>, table: &str) -> rusqlite::Result<bool> {
    safe_identifier(table)?;
    tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        rusqlite::params![table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// Refuse an identifier that is not a bare table or column name before it
/// reaches a `format!` interpolation.
///
/// Every caller passes a literal from the hook above, so this never fires
/// today. It exists so that a future caller cannot turn a table name that
/// carries a quote or a semicolon into SQL. A parameter cannot stand in for
/// an identifier in DDL, which is why the interpolation is there at all.
fn safe_identifier(name: &str) -> rusqlite::Result<()> {
    let ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidParameterName(name.to_string()))
    }
}

fn column_exists(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
) -> rusqlite::Result<bool> {
    safe_identifier(table)?;
    safe_identifier(column)?;
    let mut stmt = tx.prepare(&format!(
        "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
    ))?;
    stmt.exists(rusqlite::params![column])
}

fn row_count(tx: &rusqlite::Transaction<'_>, table: &str) -> rusqlite::Result<i64> {
    safe_identifier(table)?;
    tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
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

    /// The live failure: `user_version` is already 9, so V006 never runs,
    /// but `memory_items` has no `superseded_by`. Recall's SELECT errors,
    /// the error is discarded, and "what's my name" finds nothing even
    /// though the nickname row is indexed.
    fn database_that_skipped_v006() -> Connection {
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
        // V008 and V009 did apply on the affected database. V006 and V007
        // did not. Recording version 9 is what makes the runner skip them.
        conn.execute_batch(
            "ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
             CREATE TABLE session_memory_scope (
                 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );",
        )
        .unwrap();
        conn.execute("INSERT INTO sessions (id, title) VALUES ('s1', 'Real')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content, is_enabled, pinned)
             VALUES ('nick', 'user_pref', 'User''s nickname', 'Kevin', 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content)
             VALUES ('editor', 'user_pref', 'Editor', 'The user uses Neovim')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, body) VALUES ('n1', 'Note', 'body text')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES ('r1', 's1', 'pending')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 9).unwrap();
        conn
    }

    fn name_hits(conn: &Connection, query: &str) -> Vec<crate::memory::retrieve::RankedMemory> {
        crate::memory::retrieve::recall(
            conn,
            &crate::memory::retrieve::RecallOptions {
                query,
                session_id: None,
                embedding_model: None,
                embedding_dim: None,
                kinds: None,
                top_k: 6,
                lambda: crate::memory::retrieve::DEFAULT_LAMBDA,
            },
        )
    }

    fn nickname_rank(conn: &Connection) -> f64 {
        conn.query_row(
            "SELECT bm25(memory_fts) FROM memory_fts WHERE memory_fts MATCH 'nickname'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn v010_repairs_a_database_whose_version_skipped_the_index_columns() {
        let mut conn = database_that_skipped_v006();
        let rank_before = nickname_rank(&conn);
        assert!(
            conn.prepare(
                "SELECT id FROM memory_items WHERE superseded_by IS NULL AND is_enabled = 1"
            )
            .is_err(),
            "the fixture must be missing superseded_by, or it is not the live bug"
        );
        assert!(
            name_hits(&conn, "what's my name").is_empty(),
            "recall must fail closed before the repair, which is what the chat did"
        );

        migrations().to_latest(&mut conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 13);
        let rank_after = nickname_rank(&conn);
        assert!(
            (rank_before - rank_after).abs() < 1e-9,
            "the repair changed an already-indexed nickname's rank: {rank_before} -> {rank_after}"
        );

        let (content, confidence, access_count, pinned): (String, f64, i64, i64) = conn
            .query_row(
                "SELECT content, confidence, access_count, pinned
                 FROM memory_items WHERE id = 'nick' AND superseded_by IS NULL",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(content, "Kevin");
        assert_eq!(confidence, 1.0);
        assert_eq!(access_count, 0);
        assert_eq!(pinned, 0);

        for query in ["what's my name", "who am I"] {
            let hits = name_hits(&conn, query);
            assert_eq!(hits.len(), 1, "{query:?} returned {hits:?}");
            assert_eq!(hits[0].owner_id, "nick");
            assert_eq!(hits[0].content, "Kevin");
            assert_eq!(hits[0].title.as_deref(), Some("User's nickname"));
        }

        let note_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            note_hits, 1,
            "an existing note stayed invisible to notes_fts"
        );
        let note_pinned: i64 = conn
            .query_row("SELECT pinned FROM notes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(note_pinned, 0);

        let review: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(review, "pending");
        let rebuilt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pending_memory_reviews')
                 WHERE name = 'watermark_message_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rebuilt, 0, "V010 must not rebuild pending_memory_reviews");

        for table in ["memory_embeddings", "memory_events", "memory_watermark"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(n, 0, "{table} was not created");
        }

        // Applying it again must not try to add the columns a second time.
        migrations().to_latest(&mut conn).unwrap();
    }

    #[test]
    fn v010_leaves_a_database_that_already_ran_v006_unchanged() {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrations::new(vec![
            M::up(MIGRATION_V001),
            M::up(MIGRATION_V002),
            M::up(MIGRATION_V003),
            M::up(MIGRATION_V004),
            M::up(MIGRATION_V005),
            M::up(MIGRATION_V006),
            M::up(MIGRATION_V007),
            M::up(MIGRATION_V008),
            M::up(MIGRATION_V009),
        ])
        .to_latest(&mut conn)
        .unwrap();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content)
             VALUES ('nick', 'user_pref', 'User''s nickname', 'Kevin')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, body) VALUES ('n1', 'Note', 'body text')",
            [],
        )
        .unwrap();
        let rank_before = nickname_rank(&conn);
        let note_hits_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        migrations().to_latest(&mut conn).unwrap();

        let rank_after = nickname_rank(&conn);
        assert!(
            (rank_before - rank_after).abs() < 1e-9,
            "V010 changed an already-indexed row's rank: {rank_before} -> {rank_after}"
        );
        let note_hits_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(note_hits_before, 1);
        assert_eq!(note_hits_after, note_hits_before);
        let content: String = conn
            .query_row(
                "SELECT content FROM memory_items WHERE id = 'nick'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, "Kevin");
    }

    /// V010's first check treated `COUNT(*)` as the size of the index. On
    /// an external-content table that count is the note count, so the
    /// migration recorded itself and left the index empty. user_version 10
    /// is that database.
    #[test]
    fn v011_indexes_notes_an_empty_fts_table_still_counted() {
        let mut conn = database_that_skipped_v006();
        conn.execute_batch(MIGRATION_V010).unwrap();
        // `pinned` is already on this fixture, the way V008 left it.
        for (column, decl) in [
            ("confidence", "REAL NOT NULL DEFAULT 1.0"),
            ("access_count", "INTEGER NOT NULL DEFAULT 0"),
            ("last_seen_at", "TEXT"),
            ("superseded_by", "TEXT"),
            ("source_note_id", "TEXT"),
            ("source_session_id", "TEXT"),
            ("token_count", "INTEGER"),
        ] {
            conn.execute_batch(&format!(
                "ALTER TABLE memory_items ADD COLUMN {column} {decl}"
            ))
            .unwrap();
        }
        for (column, decl) in [
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("token_count", "INTEGER"),
            ("source_note_id", "TEXT"),
        ] {
            conn.execute_batch(&format!("ALTER TABLE notes ADD COLUMN {column} {decl}"))
                .unwrap();
        }
        conn.pragma_update(None, "user_version", 10).unwrap();
        let invisible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invisible, 0, "the fixture must be the unindexed notes_fts");
        let rank_before = nickname_rank(&conn);

        migrations().to_latest(&mut conn).unwrap();

        let visible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(visible, 1);
        let rank_after = nickname_rank(&conn);
        assert!(
            (rank_before - rank_after).abs() < 1e-9,
            "backfilling notes changed the nickname rank: {rank_before} -> {rank_after}"
        );
        let hits = name_hits(&conn, "what's my name");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "Kevin");
        migrations().to_latest(&mut conn).unwrap();
    }

    /// A database that reached version 11 with an empty index. The notes
    /// rebuild in V011 may have failed after the version was recorded, or the
    /// memory index was never checked by either V010 or V011. Neither runs
    /// again, so V012 is the only thing that can repair it.
    #[test]
    fn v012_repairs_a_database_that_recorded_an_empty_index() {
        let mut conn = database_that_skipped_v006();
        conn.execute_batch(MIGRATION_V010).unwrap();
        for (column, decl) in [
            ("confidence", "REAL NOT NULL DEFAULT 1.0"),
            ("access_count", "INTEGER NOT NULL DEFAULT 0"),
            ("last_seen_at", "TEXT"),
            ("superseded_by", "TEXT"),
            ("source_note_id", "TEXT"),
            ("source_session_id", "TEXT"),
            ("token_count", "INTEGER"),
        ] {
            conn.execute_batch(&format!(
                "ALTER TABLE memory_items ADD COLUMN {column} {decl}"
            ))
            .unwrap();
        }
        for (column, decl) in [
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("token_count", "INTEGER"),
            ("source_note_id", "TEXT"),
        ] {
            conn.execute_batch(&format!("ALTER TABLE notes ADD COLUMN {column} {decl}"))
                .unwrap();
        }
        // Empty both inverted indexes the way a wrong check can, leaving the
        // content tables they read from untouched.
        conn.execute(
            "INSERT INTO memory_fts(memory_fts) VALUES ('delete-all')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 11).unwrap();

        let inverted = |conn: &Connection, table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        };
        assert_eq!(inverted(&conn, "memory_fts_docsize"), 0);
        assert_eq!(inverted(&conn, "notes_fts_docsize"), 0);

        migrations().to_latest(&mut conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 13);
        assert_eq!(
            inverted(&conn, "memory_fts_docsize"),
            2,
            "V012 did not rebuild the memory index"
        );
        assert_eq!(
            inverted(&conn, "notes_fts_docsize"),
            1,
            "V012 did not rebuild the notes index"
        );
        let hits = name_hits(&conn, "what's my name");
        assert_eq!(hits.len(), 1, "recall still empty after V012: {hits:?}");
        assert_eq!(hits[0].content, "Kevin");

        // Idempotent: running the chain again changes nothing.
        migrations().to_latest(&mut conn).unwrap();
        assert_eq!(inverted(&conn, "memory_fts_docsize"), 2);
    }
}

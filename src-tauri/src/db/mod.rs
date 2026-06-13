use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite_migration::{Migrations, M};
use std::path::PathBuf;
use std::sync::Arc;

pub mod legacy;
pub mod models;

pub type DbPool = Pool<SqliteConnectionManager>;
pub type DbConn = r2d2::PooledConnection<SqliteConnectionManager>;

const MIGRATION_V001: &str = include_str!("../../migrations/V001__initial_schema.sql");
const MIGRATION_V002: &str = include_str!("../../migrations/V002__fts_and_skills.sql");
const MIGRATION_V003: &str = include_str!("../../migrations/V003__drop_presets.sql");

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(MIGRATION_V001),
        M::up(MIGRATION_V002),
        M::up(MIGRATION_V003),
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
    let manager = SqliteConnectionManager::file(db_path())
        .with_init(|c| {
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

pub fn run_migrations(pool: &DbPool) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let m = migrations();
    m.to_latest(&mut conn)
        .map_err(|e| format!("Migration failed: {}", e))?;
    Ok(())
}

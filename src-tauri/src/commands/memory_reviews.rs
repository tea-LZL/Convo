use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReview {
    pub id: String,
    pub session_id: String,
    pub facts: Vec<crate::commands::memory::ExtractedFact>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

fn list_reviews(conn: &Connection) -> Result<Vec<MemoryReview>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, facts_json, status, error, created_at FROM pending_memory_reviews ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, session_id, facts_json, status, error, created_at) =
            row.map_err(|e| e.to_string())?;
        let facts = serde_json::from_str(&facts_json).map_err(|e| e.to_string())?;
        Ok(MemoryReview {
            id,
            session_id,
            facts,
            status,
            error,
            created_at,
        })
    })
    .collect()
}

fn queue_review(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    let id = Uuid::new_v4().to_string();
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO pending_memory_reviews (id, session_id, status) VALUES (?1, ?2, 'extracting')",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?;
    Ok((inserted == 1).then_some(id))
}

fn finish_review(
    conn: &Connection,
    id: &str,
    facts: &[crate::commands::memory::ExtractedFact],
) -> Result<(), String> {
    let facts_json = serde_json::to_string(facts).map_err(|e| e.to_string())?;
    let status = if facts.is_empty() {
        "reviewed"
    } else {
        "pending"
    };
    conn.execute(
        "UPDATE pending_memory_reviews SET facts_json = ?1, status = ?2, error = NULL WHERE id = ?3",
        params![facts_json, status, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn fail_review(conn: &Connection, id: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE pending_memory_reviews SET status = 'failed', error = ?1 WHERE id = ?2",
        params![error, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn retry_review(conn: &Connection, id: &str) -> Result<String, String> {
    let changed = conn
        .execute(
            "UPDATE pending_memory_reviews SET status = 'extracting', error = NULL WHERE id = ?1 AND status IN ('failed', 'extracting')",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Review is not retryable".into());
    }
    conn.query_row(
        "SELECT session_id FROM pending_memory_reviews WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn mark_reviewed(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE pending_memory_reviews SET status = 'reviewed', error = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_memory_reviews(pool: State<'_, Arc<DbPool>>) -> Result<Vec<MemoryReview>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    list_reviews(&conn)
}

#[tauri::command]
pub fn queue_memory_review(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
) -> Result<Option<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    queue_review(&conn, &session_id)
}

#[tauri::command]
pub fn finish_memory_review(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    facts: Vec<crate::commands::memory::ExtractedFact>,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    finish_review(&conn, &id, &facts)
}

#[tauri::command]
pub fn fail_memory_review(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    error: String,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    fail_review(&conn, &id, &error)
}

#[tauri::command]
pub fn retry_memory_review(pool: State<'_, Arc<DbPool>>, id: String) -> Result<String, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    retry_review(&conn, &id)
}

#[tauri::command]
pub fn mark_memory_review_reviewed(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    mark_reviewed(&conn, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY);
             CREATE TABLE pending_memory_reviews (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
               facts_json TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL,
               error TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             INSERT INTO sessions (id) VALUES ('session-1');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn completed_extraction_is_pending_with_facts() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: Some("Nickname".into()),
            content: "Nickname is Kevin.".into(),
            tags: None,
        }];

        finish_review(&conn, &id, &facts).unwrap();

        let row: (String, String) = conn
            .query_row(
                "SELECT status, facts_json FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert!(row.1.contains("Kevin"));
    }

    #[test]
    fn empty_extraction_is_reviewed() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();

        finish_review(&conn, &id, &[]).unwrap();

        let status: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "reviewed");
    }

    #[test]
    fn failed_review_is_retryable() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();
        fail_review(&conn, &id, "provider unavailable").unwrap();

        assert_eq!(retry_review(&conn, &id).unwrap(), "session-1");
        let row: (String, Option<String>) = conn
            .query_row(
                "SELECT status, error FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("extracting".into(), None));
    }

    #[test]
    fn marks_reviewed() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();

        mark_reviewed(&conn, &id).unwrap();

        let status: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "reviewed");
    }

    #[test]
    fn interrupted_extraction_is_retryable() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();

        assert_eq!(retry_review(&conn, &id).unwrap(), "session-1");
    }

    #[test]
    fn lists_persisted_reviews() {
        let conn = db();
        let id = queue_review(&conn, "session-1").unwrap().unwrap();
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: None,
            content: "Prefers concise replies.".into(),
            tags: None,
        }];
        finish_review(&conn, &id, &facts).unwrap();

        let reviews = list_reviews(&conn).unwrap();

        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].session_id, "session-1");
        assert_eq!(reviews[0].status, "pending");
        assert_eq!(reviews[0].facts[0].content, "Prefers concise replies.");
    }

    #[test]
    fn queues_each_session_once() {
        let conn = db();
        assert!(queue_review(&conn, "session-1").unwrap().is_some());
        assert!(queue_review(&conn, "session-1").unwrap().is_none());
        let status: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "extracting");
    }
}

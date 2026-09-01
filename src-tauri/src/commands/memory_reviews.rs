use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

const STALE_ATTEMPT_ERROR: &str = "Memory review attempt is stale or no longer extracting";
const REVIEW_IN_PROGRESS_ERROR: &str = "Review extraction is still in progress";
const EXTRACTING_RETRY_AFTER_SECONDS: i64 = 5 * 60;

fn extracting_attempt_is_stale(updated_at: &str) -> bool {
    let Ok(updated_at) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        // A malformed or missing persisted timestamp cannot prove that an
        // attempt is still live, so make it recoverable after a restart.
        return true;
    };
    let age = chrono::Utc::now().signed_duration_since(updated_at.with_timezone(&chrono::Utc));
    age >= chrono::Duration::seconds(EXTRACTING_RETRY_AFTER_SECONDS)
}

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

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReviewReservation {
    pub review_id: String,
    pub attempt: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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

pub(crate) fn rebase_review_watermark(conn: &Connection, session_id: &str) -> Result<(), String> {
    let assistant_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND role = 'assistant'",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pending_memory_reviews
         SET evaluated_assistant_count = MIN(evaluated_assistant_count, ?1), updated_at = ?2
         WHERE session_id = ?3 AND status = 'reviewed'",
        params![assistant_count, chrono::Utc::now().to_rfc3339(), session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn queue_review(
    conn: &mut Connection,
    session_id: &str,
) -> Result<Option<MemoryReviewReservation>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let assistant_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND role = 'assistant'",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let existing_review: Option<(String, String, i64, i64)> = tx
        .query_row(
            "SELECT id, status, evaluated_assistant_count, attempt
             FROM pending_memory_reviews WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    let reservation = match existing_review {
        None if assistant_count >= 2 => {
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO pending_memory_reviews
                 (id, session_id, status, evaluated_assistant_count, updated_at, attempt)
                 VALUES (?1, ?2, 'extracting', ?3, ?4, 1)",
                params![id, session_id, assistant_count, now],
            )
            .map_err(|e| e.to_string())?;
            Some(MemoryReviewReservation {
                review_id: id,
                attempt: 1,
                session_id: None,
            })
        }
        Some((id, status, evaluated_assistant_count, attempt))
            if status == "reviewed" && assistant_count - evaluated_assistant_count >= 2 =>
        {
            let next_attempt = attempt + 1;
            let updated = tx
                .execute(
                    "UPDATE pending_memory_reviews
                     SET status = 'extracting', error = NULL, evaluated_assistant_count = ?1,
                         attempt = attempt + 1, updated_at = ?2
                     WHERE id = ?3 AND status = 'reviewed'",
                    params![assistant_count, now, id],
                )
                .map_err(|e| e.to_string())?;
            (updated == 1).then_some(MemoryReviewReservation {
                review_id: id,
                attempt: next_attempt,
                session_id: None,
            })
        }
        _ => None,
    };

    tx.commit().map_err(|e| e.to_string())?;
    Ok(reservation)
}

fn finish_review(
    conn: &Connection,
    id: &str,
    attempt: i64,
    facts: &[crate::commands::memory::ExtractedFact],
) -> Result<(), String> {
    let facts_json = serde_json::to_string(facts).map_err(|e| e.to_string())?;
    let status = if facts.is_empty() {
        "reviewed"
    } else {
        "pending"
    };
    let changed = conn
        .execute(
            "UPDATE pending_memory_reviews
             SET facts_json = ?1, status = ?2, error = NULL,
                 evaluated_assistant_count = CASE WHEN ?2 = 'reviewed' THEN
                     MIN(evaluated_assistant_count, (SELECT COUNT(*) FROM messages
                         WHERE messages.session_id = pending_memory_reviews.session_id
                           AND messages.role = 'assistant'))
                     ELSE evaluated_assistant_count END,
                 updated_at = ?5
             WHERE id = ?3 AND attempt = ?4 AND status = 'extracting'",
            params![
                facts_json,
                status,
                id,
                attempt,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err(STALE_ATTEMPT_ERROR.into());
    }
    Ok(())
}

fn fail_review(conn: &Connection, id: &str, attempt: i64, error: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE pending_memory_reviews
             SET status = 'failed', error = ?1, updated_at = ?4
             WHERE id = ?2 AND attempt = ?3 AND status = 'extracting'",
            params![error, id, attempt, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err(STALE_ATTEMPT_ERROR.into());
    }
    Ok(())
}

fn retry_review(conn: &mut Connection, id: &str) -> Result<MemoryReviewReservation, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let state: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT status, updated_at, attempt, session_id
             FROM pending_memory_reviews WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, updated_at, attempt, session_id)) = state else {
        return Err("Review is not retryable".into());
    };

    match status.as_str() {
        "failed" => {}
        "extracting" if !extracting_attempt_is_stale(&updated_at) => {
            return Err(REVIEW_IN_PROGRESS_ERROR.into());
        }
        "extracting" => {}
        _ => return Err("Review is not retryable".into()),
    }

    let updated = tx
        .execute(
            "UPDATE pending_memory_reviews
             SET status = 'extracting', error = NULL, attempt = attempt + 1,
                 updated_at = ?2
             WHERE id = ?1 AND status = ?3 AND attempt = ?4",
            params![id, chrono::Utc::now().to_rfc3339(), status, attempt],
        )
        .map_err(|e| e.to_string())?;
    if updated != 1 {
        return Err(STALE_ATTEMPT_ERROR.into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryReviewReservation {
        review_id: id.to_string(),
        attempt: attempt + 1,
        session_id: Some(session_id),
    })
}

fn mark_reviewed(conn: &mut Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let session_id: Option<String> = tx
        .query_row(
            "SELECT session_id FROM pending_memory_reviews
             WHERE id = ?1 AND status = 'pending'",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(session_id) = session_id else {
        return Err("Review is not pending".into());
    };
    let assistant_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM messages
             WHERE session_id = ?1 AND role = 'assistant'",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let updated = tx
        .execute(
            "UPDATE pending_memory_reviews
             SET status = 'reviewed', error = NULL,
                 evaluated_assistant_count = MIN(evaluated_assistant_count, ?2), updated_at = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![id, assistant_count, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    if updated != 1 {
        return Err("Review is not pending".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
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
) -> Result<Option<MemoryReviewReservation>, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    queue_review(&mut conn, &session_id)
}

#[tauri::command]
pub fn finish_memory_review(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    attempt: i64,
    facts: Vec<crate::commands::memory::ExtractedFact>,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    finish_review(&conn, &id, attempt, &facts)
}

#[tauri::command]
pub fn fail_memory_review(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    attempt: i64,
    error: String,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    fail_review(&conn, &id, attempt, &error)
}

#[tauri::command]
pub fn retry_memory_review(
    pool: State<'_, Arc<DbPool>>,
    id: String,
) -> Result<MemoryReviewReservation, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    retry_review(&mut conn, &id)
}

#[tauri::command]
pub fn mark_memory_review_reviewed(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    mark_reviewed(&mut conn, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY);
             CREATE TABLE messages (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE pending_memory_reviews (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
               facts_json TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL,
               error TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               evaluated_assistant_count INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL DEFAULT '',
               attempt INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO sessions (id) VALUES ('session-1');",
        )
        .unwrap();
        conn
    }

    fn add_assistant_messages(conn: &Connection, count: usize) {
        let existing_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        for offset in 0..count {
            let index = existing_count + offset as i64;
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, created_at)
                 VALUES (?1, 'session-1', 'assistant', ?2, ?3)",
                params![
                    format!("assistant-{index}"),
                    format!("Assistant response {index}"),
                    format!("2026-01-01T00:00:{index:02}Z"),
                ],
            )
            .unwrap();
        }
    }

    fn reserve_review(conn: &mut Connection) -> String {
        add_assistant_messages(conn, 2);
        queue_review(conn, "session-1").unwrap().unwrap().review_id
    }

    fn make_extracting_stale(conn: &Connection, id: &str) {
        conn.execute(
            "UPDATE pending_memory_reviews
             SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?1",
            params![id],
        )
        .unwrap();
    }

    #[test]
    fn completed_extraction_is_pending_with_facts() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: Some("Nickname".into()),
            content: "Nickname is Kevin.".into(),
            tags: None,
        }];

        finish_review(&conn, &id, 1, &facts).unwrap();

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
        let mut conn = db();
        let id = reserve_review(&mut conn);

        finish_review(&conn, &id, 1, &[]).unwrap();

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
        let mut conn = db();
        let id = reserve_review(&mut conn);
        fail_review(&conn, &id, 1, "provider unavailable").unwrap();

        let reservation = retry_review(&mut conn, &id).unwrap();
        assert_eq!(reservation.session_id.as_deref(), Some("session-1"));
        assert_eq!(reservation.attempt, 2);
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
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(
            &conn,
            &id,
            1,
            &[crate::commands::memory::ExtractedFact {
                kind: "user_pref".into(),
                title: None,
                content: "A fact to review.".into(),
                tags: None,
            }],
        )
        .unwrap();

        mark_reviewed(&mut conn, &id).unwrap();

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
        let mut conn = db();
        let id = reserve_review(&mut conn);
        make_extracting_stale(&conn, &id);

        let reservation = retry_review(&mut conn, &id).unwrap();
        assert_eq!(reservation.session_id.as_deref(), Some("session-1"));
        assert_eq!(reservation.attempt, 2);
    }

    #[test]
    fn lists_persisted_reviews() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: None,
            content: "Prefers concise replies.".into(),
            tags: None,
        }];
        finish_review(&conn, &id, 1, &facts).unwrap();

        let reviews = list_reviews(&conn).unwrap();

        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].session_id, "session-1");
        assert_eq!(reviews[0].status, "pending");
        assert_eq!(reviews[0].facts[0].content, "Prefers concise replies.");
    }

    #[test]
    fn does_not_reserve_an_active_session_twice() {
        let mut conn = db();
        assert!(!reserve_review(&mut conn).is_empty());
        assert!(queue_review(&mut conn, "session-1").unwrap().is_none());
        let status: String = conn
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "extracting");
    }

    #[test]
    fn fewer_than_two_assistant_messages_do_not_reserve_a_review() {
        let mut conn = db();
        add_assistant_messages(&conn, 1);

        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pending_memory_reviews", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn two_assistant_messages_reserve_an_extracting_review_with_watermark() {
        let mut conn = db();
        add_assistant_messages(&conn, 2);

        let id = queue_review(&mut conn, "session-1")
            .unwrap()
            .unwrap()
            .review_id;

        let row: (String, i64, String) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count, updated_at
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "extracting");
        assert_eq!(row.1, 2);
        assert!(!row.2.is_empty());
    }

    #[test]
    fn pending_review_is_not_replaced_when_new_assistant_messages_arrive() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: None,
            content: "Prefers concise replies.".into(),
            tags: None,
        }];
        finish_review(&conn, &id, 1, &facts).unwrap();
        add_assistant_messages(&conn, 2);

        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let row: (String, String, i64) = conn
            .query_row(
                "SELECT status, facts_json, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert!(row.1.contains("Prefers concise replies."));
        assert_eq!(row.2, 2);
    }

    #[test]
    fn extracting_review_is_not_replaced_when_new_assistant_messages_arrive() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        add_assistant_messages(&conn, 2);

        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let row: (String, i64) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("extracting".into(), 2));
    }

    #[test]
    fn failed_review_is_not_replaced_when_new_assistant_messages_arrive() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        fail_review(&conn, &id, 1, "provider unavailable").unwrap();
        add_assistant_messages(&conn, 2);

        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let row: (String, Option<String>, i64) = conn
            .query_row(
                "SELECT status, error, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            ("failed".into(), Some("provider unavailable".into()), 2)
        );
    }

    #[test]
    fn reviewed_review_with_fewer_than_two_new_assistant_messages_is_not_queued() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(&conn, &id, 1, &[]).unwrap();
        add_assistant_messages(&conn, 1);

        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let row: (String, i64) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("reviewed".into(), 2));
    }

    #[test]
    fn reviewed_review_with_two_new_assistant_messages_atomically_requeues_the_same_row() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(&conn, &id, 1, &[]).unwrap();
        add_assistant_messages(&conn, 2);

        assert_eq!(
            queue_review(&mut conn, "session-1")
                .unwrap()
                .map(|reservation| reservation.review_id),
            Some(id.clone())
        );
        assert_eq!(queue_review(&mut conn, "session-1").unwrap(), None);
        let row: (String, i64, i64) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count,
                        (SELECT COUNT(*) FROM pending_memory_reviews)
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("extracting".into(), 4, 1));
    }

    #[test]
    fn retry_increments_attempt_generation() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        make_extracting_stale(&conn, &id);
        let before: i64 = conn
            .query_row(
                "SELECT attempt FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();

        retry_review(&mut conn, &id).unwrap();

        let after: i64 = conn
            .query_row(
                "SELECT attempt FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, 1);
        assert_eq!(after, 2);
    }

    #[test]
    fn retry_reservation_returns_current_attempt_and_session() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        make_extracting_stale(&conn, &id);

        let reservation = retry_review(&mut conn, &id).unwrap();

        assert_eq!(reservation.review_id, id);
        assert_eq!(reservation.attempt, 2);
        assert_eq!(reservation.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn recurring_reservation_increments_attempt_generation() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(&conn, &id, 1, &[]).unwrap();
        add_assistant_messages(&conn, 2);

        let recurring_id = queue_review(&mut conn, "session-1")
            .unwrap()
            .unwrap()
            .review_id;

        let attempt: i64 = conn
            .query_row(
                "SELECT attempt FROM pending_memory_reviews WHERE id = ?1",
                params![recurring_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt, 2);
    }

    #[test]
    fn initial_reservation_returns_review_id_and_attempt_without_session_id() {
        let mut conn = db();
        add_assistant_messages(&conn, 2);

        let reservation = queue_review(&mut conn, "session-1").unwrap().unwrap();

        assert_eq!(reservation.attempt, 1);
        assert!(!reservation.review_id.is_empty());
        assert_eq!(reservation.session_id, None);
    }

    #[test]
    fn stale_finish_cannot_overwrite_a_newer_extraction_attempt() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let stale_attempt: i64 = conn
            .query_row(
                "SELECT attempt FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        make_extracting_stale(&conn, &id);
        let newer = retry_review(&mut conn, &id).unwrap();
        let stale_facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: None,
            content: "Stale extraction must not win.".into(),
            tags: None,
        }];

        let error = finish_review(&conn, &id, stale_attempt, &stale_facts).unwrap_err();

        assert!(error.contains("stale"));
        let row: (String, String, i64) = conn
            .query_row(
                "SELECT status, facts_json, attempt
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "extracting");
        assert_eq!(row.1, "[]");
        assert_eq!(row.2, newer.attempt);
    }

    #[test]
    fn stale_failure_cannot_overwrite_a_newer_extraction_attempt() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let stale_attempt: i64 = conn
            .query_row(
                "SELECT attempt FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        make_extracting_stale(&conn, &id);
        let newer = retry_review(&mut conn, &id).unwrap();

        let error = fail_review(&conn, &id, stale_attempt, "stale provider error").unwrap_err();

        assert!(error.contains("stale"));
        let row: (String, Option<String>, i64) = conn
            .query_row(
                "SELECT status, error, attempt
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "extracting");
        assert_eq!(row.1, None);
        assert_eq!(row.2, newer.attempt);
    }

    #[test]
    fn rebase_leaves_active_pending_and_failed_reviews_untouched() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO sessions (id) VALUES ('session-2'), ('session-3'), ('session-4');
             INSERT INTO pending_memory_reviews
               (id, session_id, status, error, evaluated_assistant_count, updated_at, attempt)
             VALUES
               ('active', 'session-2', 'extracting', NULL, 99, 'active-old', 4),
               ('pending', 'session-3', 'pending', 'pending-error', 98, 'pending-old', 5),
               ('failed', 'session-4', 'failed', 'failed-error', 97, 'failed-old', 6);",
        )
        .unwrap();

        rebase_review_watermark(&conn, "session-2").unwrap();
        rebase_review_watermark(&conn, "session-3").unwrap();
        rebase_review_watermark(&conn, "session-4").unwrap();

        let rows: Vec<(String, Option<String>, i64, String)> = ["active", "pending", "failed"]
            .into_iter()
            .map(|id| {
                conn.query_row(
                    "SELECT status, error, evaluated_assistant_count, updated_at
                     FROM pending_memory_reviews WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap()
            })
            .collect();

        assert_eq!(
            rows,
            vec![
                ("extracting".into(), None, 99, "active-old".into()),
                (
                    "pending".into(),
                    Some("pending-error".into()),
                    98,
                    "pending-old".into()
                ),
                (
                    "failed".into(),
                    Some("failed-error".into()),
                    97,
                    "failed-old".into()
                ),
            ]
        );
    }

    #[test]
    fn reservation_serializes_with_camel_case_and_optional_session_id() {
        let without_session = MemoryReviewReservation {
            review_id: "review-1".into(),
            attempt: 1,
            session_id: None,
        };
        let without_session_json = serde_json::to_value(without_session).unwrap();
        assert_eq!(without_session_json["reviewId"], "review-1");
        assert_eq!(without_session_json["attempt"], 1);
        assert!(without_session_json.get("sessionId").is_none());

        let with_session = MemoryReviewReservation {
            review_id: "review-1".into(),
            attempt: 2,
            session_id: Some("session-1".into()),
        };
        let with_session_json = serde_json::to_value(with_session).unwrap();
        assert_eq!(with_session_json["sessionId"], "session-1");
    }

    #[test]
    fn reviewed_high_watermark_is_rebased_after_clear_before_recurrence() {
        let mut conn = db();
        add_assistant_messages(&conn, 100);
        let id = queue_review(&mut conn, "session-1")
            .unwrap()
            .unwrap()
            .review_id;
        finish_review(&conn, &id, 1, &[]).unwrap();

        let watermark: i64 = conn
            .query_row(
                "SELECT evaluated_assistant_count FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark, 100);

        conn.execute("DELETE FROM messages WHERE session_id = 'session-1'", [])
            .unwrap();
        rebase_review_watermark(&conn, "session-1").unwrap();
        let rebased_watermark: i64 = conn
            .query_row(
                "SELECT evaluated_assistant_count FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rebased_watermark, 0);
        add_assistant_messages(&conn, 2);

        let reservation = queue_review(&mut conn, "session-1").unwrap().unwrap();
        assert_eq!(reservation.review_id, id);
        assert_eq!(reservation.attempt, 2);
    }

    #[test]
    fn empty_extraction_rebases_extracting_high_watermark_after_messages_are_cleared() {
        let mut conn = db();
        add_assistant_messages(&conn, 100);
        let id = queue_review(&mut conn, "session-1")
            .unwrap()
            .unwrap()
            .review_id;

        conn.execute("DELETE FROM messages WHERE session_id = 'session-1'", [])
            .unwrap();
        finish_review(&conn, &id, 1, &[]).unwrap();

        let row: (String, i64) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("reviewed".into(), 0));

        add_assistant_messages(&conn, 2);
        let reservation = queue_review(&mut conn, "session-1").unwrap().unwrap();
        assert_eq!(reservation.review_id, id);
        assert_eq!(reservation.attempt, 2);
    }

    #[test]
    fn fresh_extracting_review_rejects_duplicate_retry_without_changing_attempt() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        let before: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempt, error FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        let error = retry_review(&mut conn, &id).unwrap_err();

        assert_eq!(error, "Review extraction is still in progress");
        let after: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempt, error FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn stale_extracting_review_can_be_reclaimed_for_a_new_attempt() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        make_extracting_stale(&conn, &id);

        let reservation = retry_review(&mut conn, &id).unwrap();

        assert_eq!(reservation.review_id, id);
        assert_eq!(reservation.session_id.as_deref(), Some("session-1"));
        assert_eq!(reservation.attempt, 2);
        let row: (String, Option<String>, i64) = conn
            .query_row(
                "SELECT status, error, attempt FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("extracting".into(), None, 2));
    }

    #[test]
    fn marking_pending_review_rebases_watermark_after_messages_are_cleared() {
        let mut conn = db();
        add_assistant_messages(&conn, 100);
        let id = queue_review(&mut conn, "session-1")
            .unwrap()
            .unwrap()
            .review_id;
        let facts = vec![crate::commands::memory::ExtractedFact {
            kind: "user_pref".into(),
            title: None,
            content: "Keep this pending until the user reviews it.".into(),
            tags: None,
        }];
        finish_review(&conn, &id, 1, &facts).unwrap();
        conn.execute(
            "UPDATE pending_memory_reviews
             SET error = 'old error', updated_at = 'before-mark' WHERE id = ?1",
            params![id],
        )
        .unwrap();
        conn.execute("DELETE FROM messages WHERE session_id = 'session-1'", [])
            .unwrap();

        mark_reviewed(&mut conn, &id).unwrap();

        let row: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT status, error, evaluated_assistant_count, updated_at
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "reviewed");
        assert_eq!(row.1, None);
        assert_eq!(row.2, 0);
        assert_ne!(row.3, "before-mark");

        add_assistant_messages(&conn, 2);
        let reservation = queue_review(&mut conn, "session-1").unwrap().unwrap();
        assert_eq!(reservation.review_id, id);
        assert_eq!(reservation.attempt, 2);
    }

    #[test]
    fn rebase_does_not_advance_reviewed_watermark_for_new_assistant_messages() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(&conn, &id, 1, &[]).unwrap();
        add_assistant_messages(&conn, 2);

        rebase_review_watermark(&conn, "session-1").unwrap();

        let watermark: i64 = conn
            .query_row(
                "SELECT evaluated_assistant_count FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark, 2);
    }

    #[test]
    fn empty_finish_does_not_advance_watermark_past_reservation_snapshot() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        add_assistant_messages(&conn, 2);

        finish_review(&conn, &id, 1, &[]).unwrap();

        let row: (String, i64) = conn
            .query_row(
                "SELECT status, evaluated_assistant_count
                 FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("reviewed".into(), 2));
    }

    #[test]
    fn marking_reviewed_does_not_advance_watermark_for_new_assistant_messages() {
        let mut conn = db();
        let id = reserve_review(&mut conn);
        finish_review(
            &conn,
            &id,
            1,
            &[crate::commands::memory::ExtractedFact {
                kind: "user_pref".into(),
                title: None,
                content: "A fact to review.".into(),
                tags: None,
            }],
        )
        .unwrap();
        add_assistant_messages(&conn, 2);

        mark_reviewed(&mut conn, &id).unwrap();

        let watermark: i64 = conn
            .query_row(
                "SELECT evaluated_assistant_count FROM pending_memory_reviews WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark, 2);
    }

    #[test]
    fn marking_non_pending_reviews_is_rejected_without_mutating_them() {
        let mut conn = db();
        conn.execute_batch(
            "INSERT INTO sessions (id) VALUES ('session-2'), ('session-3');
             INSERT INTO pending_memory_reviews
               (id, session_id, status, error, updated_at, attempt)
             VALUES
               ('extracting-row', 'session-1', 'extracting', 'extracting-error', 'extracting-old', 3),
               ('failed-row', 'session-2', 'failed', 'failed-error', 'failed-old', 4),
               ('reviewed-row', 'session-3', 'reviewed', 'reviewed-error', 'reviewed-old', 5);",
        )
        .unwrap();

        for id in ["extracting-row", "failed-row", "reviewed-row"] {
            let before: (String, Option<String>, String, i64) = conn
                .query_row(
                    "SELECT status, error, updated_at, attempt
                     FROM pending_memory_reviews WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();

            let error = mark_reviewed(&mut conn, id).unwrap_err();

            assert_eq!(error, "Review is not pending");
            let after: (String, Option<String>, String, i64) = conn
                .query_row(
                    "SELECT status, error, updated_at, attempt
                     FROM pending_memory_reviews WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(after, before);
        }
    }
}

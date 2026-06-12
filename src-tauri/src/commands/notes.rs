use crate::db::models::Note;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_notes(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Note>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, title, body, tags, source_session_id, source_message_id, created_at, updated_at FROM notes ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                tags: row.get(3)?,
                source_session_id: row.get(4)?,
                source_message_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_note(pool: State<'_, Arc<DbPool>>, note: NoteInput) -> Result<String, String> {
    let is_update = note.id.is_some();
    let id = note.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE notes SET title = ?1, body = ?2, tags = ?3, source_session_id = ?4, source_message_id = ?5, updated_at = ?6 WHERE id = ?7",
            params![note.title, note.body, note.tags, note.source_session_id, note.source_message_id, now(), id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let ts = now();
        conn.execute(
            "INSERT INTO notes (id, title, body, tags, source_session_id, source_message_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, note.title, note.body, note.tags, note.source_session_id, note.source_message_id, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_note(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_notes(pool: State<'_, Arc<DbPool>>, query: String) -> Result<Vec<Note>, String> {
    if query.trim().is_empty() {
        return list_notes(pool);
    }
    let conn = pool.get().map_err(|e| e.to_string())?;
    let q = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, tags, source_session_id, source_message_id, created_at, updated_at
             FROM notes
             WHERE LOWER(IFNULL(title, '')) LIKE ?1
                OR LOWER(body) LIKE ?1
                OR LOWER(IFNULL(tags, '')) LIKE ?1
             ORDER BY updated_at DESC
             LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![q], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                tags: row.get(3)?,
                source_session_id: row.get(4)?,
                source_message_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub tags: Option<String>,
    pub source_session_id: Option<String>,
    pub source_message_id: Option<String>,
}

use crate::db::models::Session;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_sessions(
    pool: State<'_, Arc<DbPool>>,
    group_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<Session>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let q = if let Some(ref g) = group_id {
        format!(
            "SELECT id, title, model_id, provider_id, preset_id, group_id, is_pinned, is_archived, created_at, updated_at
             FROM sessions WHERE group_id = ?1 {} ORDER BY is_pinned DESC, updated_at DESC",
            if include_archived.unwrap_or(false) { "" } else { "AND is_archived = 0" }
        )
    } else {
        format!(
            "SELECT id, title, model_id, provider_id, preset_id, group_id, is_pinned, is_archived, created_at, updated_at
             FROM sessions WHERE 1=1 {} ORDER BY is_pinned DESC, updated_at DESC",
            if include_archived.unwrap_or(false) { "" } else { "AND is_archived = 0" }
        )
    };
    let mut stmt = conn.prepare(&q).map_err(|e| e.to_string())?;
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Session> {
        Ok(Session {
            id: row.get(0)?,
            title: row.get(1)?,
            model_id: row.get(2)?,
            provider_id: row.get(3)?,
            preset_id: row.get(4)?,
            group_id: row.get(5)?,
            is_pinned: row.get::<_, i64>(6)? != 0,
            is_archived: row.get::<_, i64>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    };
    let sessions: Vec<Session> = if let Some(g) = group_id {
        stmt.query_map(params![g], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(sessions)
}

#[tauri::command]
pub fn create_session(
    pool: State<'_, Arc<DbPool>>,
    title: Option<String>,
    model_id: Option<String>,
    provider_id: Option<String>,
    preset_id: Option<String>,
    group_id: Option<String>,
) -> Result<Session, String> {
    let id = Uuid::new_v4().to_string();
    let title = title.unwrap_or_else(|| "New Chat".to_string());
    let ts = now();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sessions (id, title, model_id, provider_id, preset_id, group_id, is_pinned, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?7)",
        params![id, title, model_id, provider_id, preset_id, group_id, ts],
    ).map_err(|e| e.to_string())?;
    Ok(Session {
        id,
        title,
        model_id,
        provider_id,
        preset_id,
        group_id,
        is_pinned: false,
        is_archived: false,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
pub fn rename_session(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    title: String,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_session(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_session_pinned(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET is_pinned = ?1, updated_at = ?2 WHERE id = ?3",
        params![pinned as i64, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_session_archived(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    archived: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET is_archived = ?1, updated_at = ?2 WHERE id = ?3",
        params![archived as i64, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_sessions(
    pool: State<'_, Arc<DbPool>>,
    query: String,
) -> Result<Vec<SessionSearchResult>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let q = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT s.id, s.title, s.updated_at,
                (SELECT content FROM messages m WHERE m.session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_content
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id
             WHERE LOWER(s.title) LIKE ?1 OR LOWER(m.content) LIKE ?1
             ORDER BY s.updated_at DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![q], |row| {
            Ok(SessionSearchResult {
                id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
                snippet: row
                    .get::<_, Option<String>>(3)?
                    .map(|s| s.chars().take(120).collect::<String>())
                    .unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SessionSearchResult {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub snippet: String,
}

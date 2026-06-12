use crate::db::models::MemoryItem;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_memory(pool: State<'_, Arc<DbPool>>) -> Result<Vec<MemoryItem>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, content, tags, created_at, updated_at, is_enabled
             FROM memory_items ORDER BY kind, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MemoryItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                tags: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_memory(pool: State<'_, Arc<DbPool>>, item: MemoryInput) -> Result<String, String> {
    let is_update = item.id.is_some();
    let id = item.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE memory_items SET kind = ?1, title = ?2, content = ?3, tags = ?4, is_enabled = ?5, updated_at = ?6 WHERE id = ?7",
            params![item.kind, item.title, item.content, item.tags, item.is_enabled, now(), id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let ts = now();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content, tags, is_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, item.kind, item.title, item.content, item.tags, item.is_enabled, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_memory(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM memory_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_memory(pool: State<'_, Arc<DbPool>>, id: String, enabled: bool) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memory_items SET is_enabled = ?1, updated_at = ?2 WHERE id = ?3",
        params![enabled as i64, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct MemoryInput {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub tags: Option<String>,
    pub is_enabled: i64,
}

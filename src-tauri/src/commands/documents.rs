use crate::db::models::Document;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_documents(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Document>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, title, content, kind, language, file_path, created_at, updated_at FROM documents ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                kind: row.get(3)?,
                language: row.get(4)?,
                file_path: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_document(pool: State<'_, Arc<DbPool>>, doc: DocumentInput) -> Result<String, String> {
    let is_update = doc.id.is_some();
    let id = doc.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE documents SET title = ?1, content = ?2, kind = ?3, language = ?4, file_path = ?5, updated_at = ?6 WHERE id = ?7",
            params![doc.title, doc.content, doc.kind, doc.language, doc.file_path, now(), id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let ts = now();
        conn.execute(
            "INSERT INTO documents (id, title, content, kind, language, file_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, doc.title, doc.content, doc.kind, doc.language, doc.file_path, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_document(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM documents WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct DocumentInput {
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub language: Option<String>,
    pub file_path: Option<String>,
}

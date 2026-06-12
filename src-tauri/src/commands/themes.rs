use crate::db::models::Theme;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_themes(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Theme>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, is_builtin, tokens_json, created_at FROM themes ORDER BY is_builtin DESC, name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Theme {
                id: row.get(0)?,
                name: row.get(1)?,
                is_builtin: row.get::<_, i64>(2)? != 0,
                tokens_json: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_theme(
    pool: State<'_, Arc<DbPool>>,
    name: String,
    tokens_json: String,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO themes (id, name, is_builtin, tokens_json, created_at)
         VALUES (?1, ?2, 0, ?3, ?4)",
        params![id, name, tokens_json, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_theme(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM themes WHERE id = ?1 AND is_builtin = 0", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

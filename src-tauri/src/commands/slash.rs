use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlashCommand {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[tauri::command]
pub fn list_slash_commands(pool: State<'_, Arc<DbPool>>) -> Result<Vec<SlashCommand>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, body, created_at FROM slash_commands ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SlashCommand {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_slash_command(
    pool: State<'_, Arc<DbPool>>,
    cmd: SlashCommandInput,
) -> Result<String, String> {
    let is_update = cmd.id.is_some();
    let id = cmd.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE slash_commands SET name = ?1, description = ?2, body = ?3 WHERE id = ?4",
            params![cmd.name, cmd.description, cmd.body, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO slash_commands (id, name, description, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, cmd.name, cmd.description, cmd.body, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_slash_command(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM slash_commands WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

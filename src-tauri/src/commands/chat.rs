use crate::db::models::{Message, Preset};
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_messages(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, thinking, attachments_json, prompt_tokens, output_tokens, created_at
             FROM messages WHERE session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                thinking: row.get(4)?,
                attachments_json: row.get(5)?,
                prompt_tokens: row.get(6)?,
                output_tokens: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_messages(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    messages: Vec<MessageInput>,
) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM messages WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    for m in messages {
        let id = if m.id.is_empty() { Uuid::new_v4().to_string() } else { m.id };
        let created = m.created_at.unwrap_or_else(now);
        tx.execute(
            "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, prompt_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                session_id,
                m.role,
                m.content,
                m.thinking,
                m.attachments_json,
                m.prompt_tokens,
                m.output_tokens,
                created,
            ],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        params![now(), session_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn append_message(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    role: String,
    content: String,
    thinking: Option<String>,
    attachments_json: Option<String>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, session_id, role, content, thinking, attachments_json, now()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        params![now(), session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_presets(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Preset>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, system_prompt, temperature, top_p, top_k, num_ctx, repeat_penalty, stop, is_builtin, created_at, updated_at
             FROM presets ORDER BY is_builtin DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Preset {
                id: row.get(0)?,
                name: row.get(1)?,
                system_prompt: row.get(2)?,
                temperature: row.get(3)?,
                top_p: row.get(4)?,
                top_k: row.get(5)?,
                num_ctx: row.get(6)?,
                repeat_penalty: row.get(7)?,
                stop: row.get(8)?,
                is_builtin: row.get::<_, i64>(9)? != 0,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_preset(pool: State<'_, Arc<DbPool>>, preset: PresetInput) -> Result<String, String> {
    let is_update = preset.id.is_some();
    let id = preset.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE presets SET name = ?1, system_prompt = ?2, temperature = ?3, top_p = ?4, top_k = ?5, num_ctx = ?6, repeat_penalty = ?7, stop = ?8, updated_at = ?9 WHERE id = ?10",
            params![
                preset.name,
                preset.system_prompt,
                preset.temperature,
                preset.top_p,
                preset.top_k,
                preset.num_ctx,
                preset.repeat_penalty,
                preset.stop,
                now(),
                id,
            ],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO presets (id, name, system_prompt, temperature, top_p, top_k, num_ctx, repeat_penalty, stop, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
            params![
                id,
                preset.name,
                preset.system_prompt,
                preset.temperature,
                preset.top_p,
                preset.top_k,
                preset.num_ctx,
                preset.repeat_penalty,
                preset.stop,
                now(),
            ],
        ).map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_preset(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM presets WHERE id = ?1 AND is_builtin = 0", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub attachments_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    pub id: Option<String>,
    pub name: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub num_ctx: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub stop: Option<String>,
}

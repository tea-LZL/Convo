use crate::db::models::{MemoryItem, MemorySearchHit};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: row.get(4)?,
        is_enabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
pub fn list_memory(
    pool: State<'_, Arc<DbPool>>,
    kind: Option<String>,
) -> Result<Vec<MemoryItem>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (sql, k): (&str, Option<String>) = match &kind {
        Some(_) => (
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at
             FROM memory_items WHERE kind = ?1 ORDER BY updated_at DESC",
            kind,
        ),
        None => (
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at
             FROM memory_items ORDER BY kind, updated_at DESC",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if let Some(k) = k {
        stmt.query_map(params![k], row_to_item)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], row_to_item)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
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
pub fn toggle_memory(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memory_items SET is_enabled = ?1, updated_at = ?2 WHERE id = ?3",
        params![enabled as i64, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_memory(
    pool: State<'_, Arc<DbPool>>,
    query: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemorySearchHit>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(30);
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    // Use FTS5 with a snippet function for excerpt highlighting. Escape the
    // user query for FTS5 by quoting each token.
    let fts_q: String = q
        .split_whitespace()
        .map(|tok| {
            let cleaned: String = tok.chars().filter(|c| !matches!(c, '"' | '\'' | '(' | ')' | '*')).collect();
            if cleaned.is_empty() { String::new() } else { format!("\"{}\"", cleaned) }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" AND ");
    if fts_q.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from(
        "SELECT m.id, m.kind, m.title, m.content, m.tags, m.is_enabled, m.created_at, m.updated_at,
                snippet(memory_fts, 2, '<mark>', '</mark>', '…', 16)
         FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ?1",
    );
    if kind.is_some() {
        sql.push_str(" AND m.kind = ?2");
    }
    sql.push_str(" ORDER BY rank LIMIT ?3");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| -> rusqlite::Result<MemorySearchHit> {
        Ok(MemorySearchHit {
            item: row_to_item(row)?,
            snippet: row.get::<_, String>(8)?,
        })
    };
    let hits: Vec<MemorySearchHit> = if let Some(k) = kind {
        stmt.query_map(params![fts_q, k, lim], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![fts_q, lim], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(hits)
}

#[tauri::command]
pub fn get_enabled_memory(pool: State<'_, Arc<DbPool>>) -> Result<Vec<MemoryItem>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at
             FROM memory_items WHERE is_enabled = 1 ORDER BY kind, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn get_session_memory_overrides(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT item_id FROM session_overrides WHERE session_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn set_session_memory_overrides(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    item_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_overrides WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    for id in item_ids {
        tx.execute(
            "INSERT OR IGNORE INTO session_overrides (session_id, item_id) VALUES (?1, ?2)",
            params![session_id, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractedFact {
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub tags: Option<String>,
}

/// Ask the LLM to extract facts (user prefs, project facts, skills) from a
/// session. Returns a list of candidate facts for the user to review and
/// save individually.
#[tauri::command]
pub async fn extract_facts_from_session(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<ExtractedFact>, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use crate::providers::{ollama::OllamaProvider, openai_compat::OpenAiCompatProvider, Provider};

    // Load messages (tight scope so stmt borrow ends before any await)
    let messages: Vec<(String, String)> = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT role, content FROM messages WHERE session_id = ?1 AND content != '' ORDER BY created_at ASC LIMIT 60",
            )
            .map_err(|e| e.to_string())?;
        let rows: Result<Vec<(String, String)>, rusqlite::Error> = stmt
            .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect();
        rows.map_err(|e| e.to_string())?
    };

    if messages.len() < 2 {
        return Err("Need at least 2 messages to extract facts".into());
    }

    // Build conversation text
    let convo = messages
        .iter()
        .map(|(role, content)| format!("{}: {}", if role == "user" { "Human" } else { "Assistant" }, content))
        .collect::<Vec<_>>()
        .join("\n\n");

    // Resolve provider/model (separate scope so DB connection is released
    // before the async LLM call).
    let (provider_id, model_id, kind, base_url, api_key) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let resolve: Result<(String, String, String, String, Option<String>), String> = (|| {
            let (p, m): (String, String) = match (provider_id.clone(), model_id.clone()) {
                (Some(p), Some(m)) => (p, m),
                _ => {
                    let p: Option<String> = conn
                        .query_row("SELECT id FROM providers WHERE is_default = 1 LIMIT 1", [], |r| r.get(0))
                        .ok();
                    let Some(p) = p else { return Err("No default provider configured".into()); };
                    let m: Option<String> = conn
                        .query_row(
                            "SELECT name FROM models WHERE provider_id = ?1 ORDER BY name LIMIT 1",
                            rusqlite::params![p],
                            |r| r.get(0),
                        )
                        .ok();
                    let Some(m) = m else { return Err("No models cached for default provider".into()); };
                    (p, m)
                }
            };
            let (k, bu): (String, String) = conn
                .query_row(
                    "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
                    rusqlite::params![p],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| format!("Provider: {}", e))?;
            let key = crate::services::get_api_key(&p);
            Ok((p, m, k, bu, key))
        })();
        resolve?
    };
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    let system = "You extract durable facts about the user and their work from a conversation. Output ONLY valid JSON. Return an array of objects, each with: kind (one of 'user_pref' for user preferences, 'project_fact' for project facts, 'skill' for reusable instructions), title (short, or null), content (the fact, written declaratively in present tense), tags (comma-separated, or null). Include only items likely to remain true across many future sessions — preferences, recurring projects, coding style rules, role descriptions, environment facts. Skip transient task details, debugging chatter, and one-off questions. Return at most 8 items. If nothing durable is found, return an empty array []. Output ONLY the JSON, no commentary.".to_string();

    let user = format!("Conversation:\n\n{}\n\nReturn the JSON array of extracted facts.", convo);
    let req = ChatRequest {
        model: model_id.clone(),
        messages: vec![MessageContent {
            role: "user".into(),
            content: user,
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(system),
        temperature: Some(0.1),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let response = provider.chat_stream(req).await?;
    use futures_util::StreamExt;
    let mut stream = response;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(msg) = chunk.message {
                    out.push_str(&msg.content);
                }
                if chunk.done { break; }
            }
            Err(e) => return Err(format!("LLM error: {}", e)),
        }
    }
    // Try to parse the JSON. The model might wrap in code fences.
    let trimmed = out.trim();
    let body = if let Some(stripped) = trimmed.strip_prefix("```") {
        // skip language tag line
        if let Some(idx) = stripped.find('\n') {
            let inner = &stripped[idx + 1..];
            inner.strip_suffix("```").unwrap_or(inner).trim()
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    let facts: Vec<ExtractedFact> = serde_json::from_str(body)
        .map_err(|e| format!("Could not parse extracted facts: {}\n\nResponse was:\n{}", e, out))?;
    Ok(facts)
}

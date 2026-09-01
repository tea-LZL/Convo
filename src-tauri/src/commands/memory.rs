use crate::db::models::{MemoryItem, MemorySearchHit};
use rusqlite::{params, OptionalExtension};
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

fn existing_memory_id(
    conn: &rusqlite::Connection,
    kind: &str,
    content: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM memory_items WHERE kind = ?1 AND content = ?2 LIMIT 1",
        params![kind, content],
        |row| row.get(0),
    )
    .optional()
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
        if let Some(existing_id) =
            existing_memory_id(&conn, &item.kind, &item.content).map_err(|e| e.to_string())?
        {
            return Ok(existing_id);
        }
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

fn search_memory_with_connection(
    conn: &rusqlite::Connection,
    query: &str,
    kind: Option<&str>,
    limit: Option<i64>,
) -> rusqlite::Result<Vec<MemorySearchHit>> {
    let lim = limit.unwrap_or(30).clamp(1, 100);
    let sanitized_query = query.replace('\0', " ");
    let q = sanitized_query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    // Use FTS5 with a snippet function for excerpt highlighting. Escape the
    // user query for FTS5 by quoting each token.
    let fts_q: String = q
        .split_whitespace()
        .map(|tok| {
            let cleaned: String = tok
                .chars()
                .filter(|c| !matches!(c, '"' | '\'' | '(' | ')' | '*'))
                .collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{}\"", cleaned)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" OR ");
    if fts_q.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from(
        "SELECT m.id, m.kind, m.title, m.content, m.tags, m.is_enabled, m.created_at, m.updated_at,
                snippet(memory_fts, 1, '<mark>', '</mark>', '…', 16)
         FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ?1",
    );
    if kind.is_some() {
        sql.push_str(" AND m.kind = ?2 ORDER BY rank LIMIT ?3");
    } else {
        sql.push_str(" ORDER BY rank LIMIT ?2");
    }
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |row: &rusqlite::Row<'_>| -> rusqlite::Result<MemorySearchHit> {
        Ok(MemorySearchHit {
            item: row_to_item(row)?,
            snippet: row.get::<_, String>(8)?,
        })
    };
    let hits: Vec<MemorySearchHit> = if let Some(k) = kind {
        stmt.query_map(params![fts_q, k, lim], mapper)?
            .collect::<Result<_, _>>()?
    } else {
        stmt.query_map(params![fts_q, lim], mapper)?
            .collect::<Result<_, _>>()?
    };
    Ok(hits)
}

#[tauri::command]
pub fn search_memory(
    pool: State<'_, Arc<DbPool>>,
    query: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemorySearchHit>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    search_memory_with_connection(&conn, &query, kind.as_deref(), limit).map_err(|e| e.to_string())
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
    tx.execute(
        "DELETE FROM session_overrides WHERE session_id = ?1",
        params![session_id],
    )
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
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Deserialize)]
struct ExtractedFactCandidate {
    kind: Option<String>,
    #[serde(rename = "type")]
    legacy_kind: Option<String>,
    category: Option<String>,
    #[serde(rename = "fact_type")]
    fact_type: Option<String>,
    title: Option<String>,
    fact: Option<String>,
    detail: Option<String>,
    content: Option<String>,
    value: Option<String>,
    details: Option<String>,
    context: Option<String>,
    notes: Option<String>,
    tags: Option<serde_json::Value>,
    labels: Option<serde_json::Value>,
}

fn normalize_fact_kind(value: &str) -> Option<&'static str> {
    // ponytail: keep compatibility explicit; unknown model schemas are ignored rather than guessed.
    match value.trim().to_ascii_lowercase().as_str() {
        "user_pref"
        | "personal_information"
        | "personal information"
        | "personal information / date"
        | "personal information/date"
        | "personal detail" => Some("user_pref"),
        "project_fact" | "project fact" => Some("project_fact"),
        "skill" | "instruction" | "reusable instruction" => Some("skill"),
        _ => None,
    }
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_tags(value: Option<serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(value)) => trimmed_optional(Some(value)),
        Some(serde_json::Value::Array(values)) => {
            let tags = values
                .into_iter()
                .filter_map(|value| value.as_str().map(|tag| tag.trim().to_string()))
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>();
            (!tags.is_empty()).then(|| tags.join(", "))
        }
        _ => None,
    }
}

fn inferred_personal_fact_kind(title: Option<&str>, content: Option<&str>) -> Option<&'static str> {
    let haystack = [title.unwrap_or(""), content.unwrap_or("")]
        .join(" ")
        .to_ascii_lowercase();
    let transient_markers = [
        "task",
        "goal",
        "draft",
        "email",
        "meeting",
        "communication",
        "request",
        "recent",
        "output",
        "event",
        "planning",
        "gathering",
        "invitation",
        "template",
        "setting up",
    ];
    if transient_markers
        .iter()
        .any(|marker| haystack.contains(marker))
    {
        return None;
    }

    let durable_markers = [
        "birthday",
        "birth date",
        "nickname",
        "user name",
        "username",
        "preferred",
        "preference",
        "prefers",
        "likes",
        "dislikes",
        "timezone",
        "time zone",
        "location",
        "city",
        "country",
        "occupation",
        "pronoun",
        "language",
    ];
    durable_markers
        .iter()
        .any(|marker| haystack.contains(marker))
        .then_some("user_pref")
}

fn parse_json_value(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }

    // Local reasoning models commonly add <think> blocks or prose around the
    // JSON. Try the two bounded JSON spans without accepting arbitrary text.
    for (open, close) in [('[', ']'), ('{', '}')] {
        if let (Some(start), Some(end)) = (trimmed.find(open), trimmed.rfind(close)) {
            if start < end {
                if let Ok(value) = serde_json::from_str(&trimmed[start..=end]) {
                    return Ok(value);
                }
            }
        }
    }

    Err("Invalid extraction JSON".into())
}

fn parse_extracted_facts(raw: &str) -> Result<Vec<ExtractedFact>, String> {
    let value = parse_json_value(raw)?;
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(object) => {
            ["extracted_facts", "facts", "memories", "items"]
                .into_iter()
                .find_map(|key| object.get(key).and_then(serde_json::Value::as_array))
                .map(|items| items.iter().collect())
                .or_else(|| {
                    // A single fact object is accepted only when it has an
                    // explicit fact-shaped field; arbitrary objects remain invalid.
                    object.contains_key("kind").then_some(vec![&value])
                })
                .ok_or_else(|| "Expected extracted facts to be a JSON array".to_string())?
        }
        _ => return Err("Expected extracted facts to be a JSON array".into()),
    };

    let mut facts = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        let candidate: ExtractedFactCandidate =
            serde_json::from_value(serde_json::Value::Object(object.clone()))
                .map_err(|e| format!("Invalid extracted fact object: {}", e))?;
        let explicit_kind = [
            candidate.kind.as_deref(),
            candidate.legacy_kind.as_deref(),
            candidate.category.as_deref(),
            candidate.fact_type.as_deref(),
        ]
        .into_iter()
        .flatten()
        .find_map(normalize_fact_kind);
        let title = trimmed_optional(
            candidate
                .title
                .or(candidate.fact)
                .or(candidate.detail)
                .or(candidate.fact_type),
        );
        let Some(content) = trimmed_optional(
            candidate
                .content
                .or(candidate.value)
                .or(candidate.details)
                .or(candidate.context)
                .or(candidate.notes),
        ) else {
            continue;
        };
        let kind =
            explicit_kind.or_else(|| inferred_personal_fact_kind(title.as_deref(), Some(&content)));
        let Some(kind) = kind else { continue };

        facts.push(ExtractedFact {
            kind: kind.into(),
            title,
            content,
            tags: normalize_tags(candidate.tags.or(candidate.labels)),
        });
    }
    Ok(facts)
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
        .map(|(role, content)| {
            format!(
                "{}: {}",
                if role == "user" { "Human" } else { "Assistant" },
                content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    // Resolve provider/model (separate scope so DB connection is released
    // before the async LLM call).
    let (_provider_id, model_id, kind, base_url, api_key) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let resolve: Result<(String, String, String, String, Option<String>), String> = (|| {
            let (p, m): (String, String) = match (provider_id.clone(), model_id.clone()) {
                (Some(p), Some(m)) => (p, m),
                _ => {
                    let p: Option<String> = conn
                        .query_row(
                            "SELECT id FROM providers WHERE is_default = 1 LIMIT 1",
                            [],
                            |r| r.get(0),
                        )
                        .ok();
                    let Some(p) = p else {
                        return Err("No default provider configured".into());
                    };
                    let m: Option<String> = conn
                        .query_row(
                            "SELECT name FROM models WHERE provider_id = ?1 ORDER BY name LIMIT 1",
                            rusqlite::params![p],
                            |r| r.get(0),
                        )
                        .ok();
                    let Some(m) = m else {
                        return Err("No models cached for default provider".into());
                    };
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
        })(
        );
        resolve?
    };
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    let system = "You extract durable facts about the user and their work from a conversation. Output ONLY valid JSON: a bare array of objects with exactly these keys: kind, title, content, tags. Do not wrap the array in an object such as extracted_facts. Allowed kind values are exactly 'user_pref' for user preferences, 'project_fact' for project facts, and 'skill' for reusable instructions. tags must be null or one comma-separated string, never an array. Example: [{\"kind\":\"user_pref\",\"title\":\"Birthday\",\"content\":\"The user's birthday is February 18th.\",\"tags\":null}]. Never use the keys type, fact, value, details, fact_type, detail, or context. Never return task/request or communication goal/task items or one-off task details. Include only items likely to remain true across many future sessions — preferences, recurring projects, coding style rules, role descriptions, environment facts. Skip transient task details, debugging chatter, and one-off questions. Return at most 8 items. If nothing durable is found, return an empty array []. Output ONLY the JSON, no commentary.".to_string();

    let user = format!(
        "Conversation:\n\n{}\n\nReturn the JSON array of extracted facts.",
        convo
    );
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
                if chunk.done {
                    break;
                }
            }
            Err(e) => return Err(format!("LLM error: {}", e)),
        }
    }
    let facts = parse_extracted_facts(&out)
        .map_err(|e| format!("Could not parse extracted facts: {}", e))?;
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_search_test_connection() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT,
                content TEXT NOT NULL,
                tags TEXT,
                is_enabled INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE memory_fts USING fts5(
                title,
                content,
                tags,
                content='memory_items',
                content_rowid='rowid',
                tokenize='porter unicode61'
            );
            CREATE TRIGGER memory_ai AFTER INSERT ON memory_items BEGIN
                INSERT INTO memory_fts(rowid, title, content, tags)
                VALUES (new.rowid, COALESCE(new.title, ''), new.content, COALESCE(new.tags, ''));
            END;",
        )
        .unwrap();
        conn
    }

    fn insert_test_memory(conn: &rusqlite::Connection, id: &str, kind: &str, content: &str) {
        insert_test_memory_with_tags(conn, id, kind, content, Some(content));
    }

    fn insert_test_memory_with_tags(
        conn: &rusqlite::Connection,
        id: &str,
        kind: &str,
        content: &str,
        tags: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO memory_items
                (id, kind, title, content, tags, is_enabled, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, kind, content, tags],
        )
        .unwrap();
    }

    #[test]
    fn memory_search_returns_content_snippet_when_tags_are_null() {
        let conn = memory_search_test_connection();
        insert_test_memory_with_tags(
            &conn,
            "memory-null-tags",
            "user_pref",
            "The user prefers loose-leaf green tea.",
            None,
        );

        let hits = search_memory_with_connection(&conn, "green", None, Some(10)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, "memory-null-tags");
        assert!(hits[0].snippet.contains("<mark>green</mark>"));
    }

    #[test]
    fn memory_search_safely_handles_nul_and_fts_metacharacters() {
        let conn = memory_search_test_connection();
        insert_test_memory(
            &conn,
            "memory-nul-query",
            "user_pref",
            "The user prefers loose-leaf green tea.",
        );

        let result = search_memory_with_connection(&conn, "green\0tea\"*", None, Some(10));

        assert!(
            result.is_ok(),
            "NUL-containing FTS input must not become malformed syntax: {result:?}"
        );
        let hits = result.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, "memory-nul-query");
    }

    #[test]
    fn unfiltered_memory_search_binds_clamped_limit_and_returns_a_hit() {
        let conn = memory_search_test_connection();
        insert_test_memory(
            &conn,
            "memory-1",
            "user_pref",
            "The user prefers concise replies.",
        );

        let hits = search_memory_with_connection(&conn, "concise", None, Some(0)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, "memory-1");
    }

    #[test]
    fn memory_search_kind_filter_returns_only_the_requested_type() {
        let conn = memory_search_test_connection();
        insert_test_memory(
            &conn,
            "skill-1",
            "skill",
            "Use small Rust functions for database queries.",
        );
        insert_test_memory(
            &conn,
            "project-1",
            "project_fact",
            "The project uses Rust for database queries.",
        );

        let hits = search_memory_with_connection(&conn, "Rust", Some("skill"), Some(10)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, "skill-1");
        assert_eq!(hits[0].item.kind, "skill");
    }

    #[test]
    fn memory_search_finds_partial_relevant_matches_for_natural_language_queries() {
        let conn = memory_search_test_connection();
        insert_test_memory(
            &conn,
            "memory-1",
            "user_pref",
            "The user prefers loose-leaf green tea.",
        );

        let hits = search_memory_with_connection(
            &conn,
            "can you recall green tea preferences",
            Some("user_pref"),
            Some(10),
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, "memory-1");
    }

    #[test]
    fn normalizes_observed_legacy_fact_shape_and_drops_task_requests() {
        let facts = parse_extracted_facts(
            r#"[
                {"type":"personal_information","fact":"User's Birthday Date","value":"February 18th"},
                {"type":"task/request","fact":"Email Draft Setup","details":"Drafting a birthday invitation email for friends."}
            ]"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("User's Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
        assert_eq!(facts[0].tags, None);
    }

    #[test]
    fn normalizes_gemma_fact_type_shape_and_drops_communication_tasks() {
        let facts = parse_extracted_facts(
            r#"```json
            [
              {"fact_type":"Personal Detail","detail":"Birthday Date","value":"February 18th"},
              {"fact_type":"Communication Goal/Task","detail":"Email drafting for friends","context":"Setup a birthday meeting email"}
            ]
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn normalizes_additional_gemma_personal_information_shapes() {
        for response in [
            r#"```json
            [
              {"fact":"Birthday Date","type":"Personal Information / Date","value":"February 18th","context":"The user asked the assistant to remember this date."},
              {"fact":"Desired Output","type":"Goal/Task","value":"Birthday meeting email for friends"}
            ]
            ```"#,
            r#"```json
            [
              {"category":"Personal Information","fact_type":"Birthday Date","value":"February 18th"},
              {"category":"Interaction Goal","fact_type":"Task Completion","value":"Drafting a birthday invitation email"}
            ]
            ```"#,
        ] {
            let facts = parse_extracted_facts(response).unwrap();

            assert_eq!(facts.len(), 1);
            assert_eq!(facts[0].kind, "user_pref");
            assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
            assert_eq!(facts[0].content, "February 18th");
        }
    }

    #[test]
    fn normalizes_gemma_extracted_facts_wrapper_and_infers_birthday() {
        let facts = parse_extracted_facts(
            r#"```json
            {
              "extracted_facts": [
                {
                  "fact": "Birthday Date",
                  "value": "February 18th",
                  "notes": "This date was used for the generated email templates."
                },
                {
                  "fact": "Recent Task Context",
                  "value": "Drafting a birthday invitation/meeting email.",
                  "details": "The user required three tone options."
                }
              ]
            }
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn drops_live_gemma_milestone_and_event_planning_artifacts() {
        let facts = parse_extracted_facts(
            r#"```json
            {
              "extracted_facts": [
                {"fact_type":"Personal Milestone","detail":"Birthday Date","value":"February 18th"},
                {"fact_type":"Goal/Task","detail":"Event Planning","value":"Setting up a birthday gathering/meeting."},
                {"fact_type":"Target Audience","detail":"Invitation Recipients","value":"Friends"},
                {"fact_type":"Output Generated","detail":"Email Templates","value":"Three birthday invitation versions."}
              ]
            }
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn accepts_array_tags_and_normalizes_them_for_the_existing_schema() {
        let facts = parse_extracted_facts(
            r#"[{"kind":"user_pref","title":"Style","content":"Prefers concise replies.","tags":["preference","communication"]}]"#,
        )
        .unwrap();

        assert_eq!(facts[0].tags.as_deref(), Some("preference, communication"));
    }

    #[test]
    fn preserves_canonical_fact_shape() {
        let facts = parse_extracted_facts(
            r#"[{"kind":"project_fact","title":"Stack","content":"Convo uses Tauri.","tags":"stack"}]"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "project_fact");
        assert_eq!(facts[0].title.as_deref(), Some("Stack"));
        assert_eq!(facts[0].content, "Convo uses Tauri.");
        assert_eq!(facts[0].tags.as_deref(), Some("stack"));
    }

    #[test]
    fn accepted_memory_write_deduplicates_exact_kind_and_content() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL);
             INSERT INTO memory_items (id, kind, content) VALUES ('memory-1', 'user_pref', 'The user prefers concise replies.');",
        )
        .unwrap();

        assert_eq!(
            existing_memory_id(&conn, "user_pref", "The user prefers concise replies.")
                .unwrap()
                .as_deref(),
            Some("memory-1")
        );
        assert_eq!(
            existing_memory_id(&conn, "project_fact", "The user prefers concise replies.").unwrap(),
            None
        );
    }

    #[test]
    fn rejects_invalid_json_and_non_array_responses() {
        let invalid_json = parse_extracted_facts("not json").unwrap_err();
        assert!(invalid_json.contains("JSON"));

        let non_array = parse_extracted_facts(r#"{"status":"ok"}"#).unwrap_err();
        assert!(non_array.contains("array"));
    }
}

use crate::db::models::Message;
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
    if messages.is_empty() {
        tx.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for mut m in messages {
        m.session_id = session_id.clone();
        upsert_message_conn(&tx, &m)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn upsert_message(pool: State<'_, Arc<DbPool>>, message: MessageInput) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    upsert_message_conn(&conn, &message)
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

fn upsert_message_conn(conn: &rusqlite::Connection, m: &MessageInput) -> Result<(), String> {
    let id = if m.id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        m.id.clone()
    };
    let created = m.created_at.clone().unwrap_or_else(now);
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, prompt_tokens, output_tokens, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET content=excluded.content, thinking=excluded.thinking,
           attachments_json=excluded.attachments_json, prompt_tokens=excluded.prompt_tokens,
           output_tokens=excluded.output_tokens",
        params![id, m.session_id, m.role, m.content, m.thinking, m.attachments_json,
            m.prompt_tokens, m.output_tokens, created],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        params![now(), m.session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub attachments_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub created_at: Option<String>,
}

/// Generate a short chat title (3-5 words) from the first user message.
/// Uses the same provider/model-resolution as the other AI commands:
/// explicit args win, otherwise default to the default provider's first
/// cached model. Strips quotes / punctuation from the response.
#[tauri::command]
pub async fn generate_session_title(
    pool: State<'_, Arc<crate::db::DbPool>>,
    first_message: String,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<String, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use crate::providers::{ollama::OllamaProvider, openai_compat::OpenAiCompatProvider, Provider};

    let trimmed = first_message.trim();
    if trimmed.is_empty() {
        return Err("Empty first message".into());
    }
    // Hard cap so we don't blow the context on huge pastes
    let excerpt: String = trimmed.chars().take(600).collect();

    let (pid, mid, kind, base_url, api_key) = {
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
    let _ = pid;
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    let system = "Suggest a 3-5 word title for a chat that starts with this user message. Output ONLY the title — no quotes, no leading numbers or bullets, no trailing period, no commentary, no markdown. Use Title Case.".to_string();
    let user = format!("User message:\n\"\"\"\n{}\n\"\"\"", excerpt);
    let req = ChatRequest {
        model: mid,
        messages: vec![MessageContent {
            role: "user".into(),
            content: user,
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(system),
        temperature: Some(0.4),
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
            Err(e) => return Err(format!("Title LLM error: {}", e)),
        }
    }
    Ok(clean_title(&out))
}

/// Strip quotes, code fences, leading numbers / dashes, trailing periods,
/// and collapse whitespace. Cap at 60 chars.
fn clean_title(s: &str) -> String {
    let s = s.trim();
    // Strip ``` fences
    let mut t = s.to_string();
    if t.starts_with("```") {
        if let Some(idx) = t.find('\n') {
            t = t[idx + 1..].to_string();
        }
        if t.ends_with("```") {
            t = t[..t.len() - 3].to_string();
        }
    }
    // Take first non-empty line
    let first_line = t
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    // Strip a leading list marker like "1." "- " "* " etc.
    let stripped = first_line.trim_start_matches(|c: char| {
        c.is_ascii_digit() || c == '.' || c == ')' || c == '-' || c == '*' || c == ' '
    });
    let stripped =
        stripped.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’'));
    // Cap at 60 chars on a word boundary
    let cap = 60;
    let out = if stripped.chars().count() <= cap {
        stripped.to_string()
    } else {
        let mut s = String::new();
        for c in stripped.chars() {
            if s.chars().count() + 1 > cap {
                break;
            }
            s.push(c);
        }
        s.push('…');
        s
    };
    // Drop trailing punctuation
    let out = out.trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '!' | '?'));
    out.to_string()
}

#[cfg(test)]
mod tests {
    use super::{clean_title, upsert_message_conn, MessageInput};
    use rusqlite::Connection;

    #[test]
    fn upsert_message_preserves_concurrent_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT, attachments_json TEXT, prompt_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL); INSERT INTO sessions VALUES ('s1', 'old');").unwrap();
        for (id, role, content, created_at) in [("user-1", "user", "hello", "2026-01-01T00:00:00Z"), ("assistant-1", "assistant", "hi", "2026-01-01T00:00:01Z")] {
            upsert_message_conn(&conn, &MessageInput { id: id.into(), session_id: "s1".into(), role: role.into(), content: content.into(), thinking: None, attachments_json: None, prompt_tokens: None, output_tokens: None, created_at: Some(created_at.into()) }).unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn strips_fences_and_quotes() {
        assert_eq!(clean_title("```\nMy Cool Title\n```"), "My Cool Title");
        assert_eq!(clean_title("\"My Cool Title\""), "My Cool Title");
        assert_eq!(clean_title("- My Cool Title"), "My Cool Title");
        assert_eq!(clean_title("1. My Cool Title."), "My Cool Title");
        assert_eq!(clean_title("My Cool Title."), "My Cool Title");
    }
    #[test]
    fn caps_long_titles() {
        let long = "a".repeat(80);
        let out = clean_title(&long);
        assert!(out.chars().count() <= 61);
        assert!(out.ends_with('…'));
    }
}

use super::DbPool;
use rusqlite::params;
use std::path::PathBuf;

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct LegacyMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(rename = "promptTokens", default)]
    pub prompt_tokens: Option<u64>,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: Option<u64>,
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct LegacyConversation {
    pub id: String,
    pub title: String,
    pub model: String,
    #[serde(rename = "created_at")]
    pub created_at: String,
    #[serde(rename = "updated_at")]
    pub updated_at: String,
    pub messages: Vec<LegacyMessage>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct LegacyStore {
    conversations: Vec<LegacyConversation>,
}

fn legacy_path() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("convo");
    dir.join("conversations.json")
}

pub fn legacy_exists() -> bool {
    legacy_path().exists()
}

pub fn read_legacy() -> Result<Vec<LegacyConversation>, String> {
    let data = std::fs::read_to_string(legacy_path()).map_err(|e| format!("Read legacy: {}", e))?;
    let store: LegacyStore =
        serde_json::from_str(&data).map_err(|e| format!("Parse legacy: {}", e))?;
    Ok(store.conversations)
}

pub fn rename_legacy_imported() -> Result<(), String> {
    let p = legacy_path();
    if p.exists() {
        let new_name = p.with_extension("json.imported");
        std::fs::rename(&p, new_name).map_err(|e| format!("Rename legacy: {}", e))?;
    }
    Ok(())
}

pub fn import_legacy_into(pool: &DbPool) -> Result<usize, String> {
    let convs = read_legacy()?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let count = convs.len();
    for c in convs {
        upsert_legacy_session(&tx, &c)?;
    }
    // Mark migration in a meta table or just rely on file absence.
    let _ = tx.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('legacy.imported_at', ?1)",
        params![serde_json::json!(now).to_string()],
    );
    tx.commit().map_err(|e| e.to_string())?;
    rename_legacy_imported()?;
    Ok(count)
}

fn upsert_legacy_session(
    conn: &rusqlite::Transaction<'_>,
    c: &LegacyConversation,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO sessions
            (id, title, model_id, provider_id, group_id, is_pinned, is_archived, created_at, updated_at)
         VALUES (?1, ?2, NULL, NULL, NULL, 0, 0, ?3, ?4)",
        params![c.id, c.title, c.created_at, c.updated_at],
    ).map_err(|e| e.to_string())?;

    for m in &c.messages {
        let mid = uuid::Uuid::new_v4().to_string();
        let created_at = m
            .completed_at
            .clone()
            .unwrap_or_else(|| c.updated_at.clone());
        let attachments_json = serde_json::to_string(&serde_json::json!([])).ok();
        conn.execute(
            "INSERT OR REPLACE INTO messages
                (id, session_id, role, content, thinking, attachments_json,
                 prompt_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                mid,
                c.id,
                m.role,
                m.content,
                m.thinking,
                attachments_json,
                m.prompt_tokens.map(|v| v as i64),
                m.output_tokens.map(|v| v as i64),
                created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

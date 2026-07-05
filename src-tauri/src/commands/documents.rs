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

#[tauri::command]
pub async fn ai_edit_document(
    pool: State<'_, Arc<DbPool>>,
    current_text: String,
    instruction: String,
    selection: Option<String>,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<String, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use crate::providers::{openai_compat::OpenAiCompatProvider, ollama::OllamaProvider, Provider};

    // Resolve provider/model
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (provider_id, model_id): (String, String) = match (provider_id, model_id) {
        (Some(p), Some(m)) => (p, m),
        _ => {
            // Fall back to the default provider
            let p: Option<String> = conn
                .query_row("SELECT id FROM providers WHERE is_default = 1 LIMIT 1", [], |r| r.get(0))
                .ok();
            let Some(p) = p else { return Err("No default provider configured".into()); };
            // Pick the first cached model
            let m: Option<String> = conn
                .query_row(
                    "SELECT name FROM models WHERE provider_id = ?1 ORDER BY name LIMIT 1",
                    rusqlite::params![p],
                    |r| r.get(0),
                )
                .ok();
            let Some(m) = m else { return Err("No models cached for default provider. Open a chat to discover models first.".into()); };
            (p, m)
        }
    };
    let (kind, base_url): (String, String) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("Provider: {}", e))?;
    drop(conn);
    let api_key = crate::services::get_api_key(&provider_id);

    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    // Build the system prompt and the request. We ask the model to return
    // the FULLY EDITED document (not a diff) so the frontend can show a
    // before/after diff. We instruct it to output only the new text, no
    // commentary, no markdown fences.
    let system = "You are a precise document editor. Apply the user's instruction to the document and output ONLY the resulting full document text. Do not include any commentary, explanations, or markdown formatting. Preserve the document's existing style and content unless the instruction explicitly says to change it. Do not add or remove blank lines unnecessarily. Output the full document every time.".to_string();
    let user_text = match selection.as_ref().filter(|s| !s.is_empty()) {
        Some(sel) => format!(
            "Document:\n```\n{}\n```\n\nSelection to edit:\n```\n{}\n```\n\nInstruction: {}\n\nReturn the FULL document with the selection replaced by your edit.",
            current_text, sel, instruction
        ),
        None => format!(
            "Document:\n```\n{}\n```\n\nInstruction: {}\n\nReturn the FULL document with the instruction applied.",
            current_text, instruction
        ),
    };

    let req = ChatRequest {
        model: model_id.clone(),
        messages: vec![MessageContent {
            role: "user".into(),
            content: user_text,
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(system),
        temperature: Some(0.2),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let response = provider.chat_stream(req).await?;
    // Collect the full response
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
            Err(e) => return Err(format!("AI edit error: {}", e)),
        }
    }
    // Strip any leading/trailing code fences the model may have added.
    // Models sometimes wrap their response in a fenced block even when
    // instructed not to.  Handle both ``` and ~~~ fences, with optional
    // language tags, and trailing whitespace.
    fn unwrap_fence(raw: &str) -> &str {
        let text = raw.trim();
        // Find the first newline: everything before it is the opening fence
        // line (may include a language tag).
        let Some(nl) = text.find('\n') else { return text; };
        let open_line = &text[..nl];
        if !(open_line.starts_with("```") || open_line.starts_with("~~~")) {
            return text;
        }
        // Strip the trailing fence.  Walk back from end to allow optional
        // trailing whitespace/newlines.
        let trimmed = text[nl + 1..].trim();
        let closing_fence = if open_line.starts_with("```") { "```" } else { "~~~" };
        let stripped = trimmed
            .strip_suffix(closing_fence)
            .or_else(|| trimmed.strip_suffix(&format!("{}\n", closing_fence)))
            .or_else(|| {
                // Model may have left trailing newline + fence
                if trimmed.ends_with(closing_fence) {
                    Some(&trimmed[..trimmed.len() - closing_fence.len()])
                } else {
                    None
                }
            });
        match stripped {
            Some(body) if !body.trim().is_empty() => body.trim(),
            _ => text, // fence wasn't cleanly stripped — return original (trimmed)
        }
    }
    Ok(unwrap_fence(&out).to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInput {
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub language: Option<String>,
    pub file_path: Option<String>,
}

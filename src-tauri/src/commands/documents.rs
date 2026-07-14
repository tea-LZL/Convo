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
    // instructed not to. Handle three fence styles:
    //   ```  (with or without info-string language tag)
    //   ~~~  (with or without info-string language tag)
    // …and strip *only the outermost* match so multi-block responses
    // (e.g. ```rs\nfn x() {}\n```\n\n```\nexplanation\n```) are returned with their inner blocks intact.
    fn unwrap_fence(raw: &str) -> &str {
        let text = raw.trim();
        // No newline at all: cannot be a fence block, return as-is.
        // ponytail: single-line outputs (e.g. language tag with no body)
        // fall through unchanged rather than risking wrong stripping.
        let Some(nl) = text.find('\n') else {
            return text;
        };
        let open_line = text[..nl].trim_end_matches('\r');
        let fence = if open_line.starts_with("```") {
            Some("```")
        } else if open_line.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        let Some(fence) = fence else {
            return text;
        };
        // Body is everything after the opening fence line, minus
        // the closing fence (if any). Strip trailing whitespace,
        // then look for the closing fence on its own line — at the
        // very end, or before trailing whitespace. Tolerant of
        // blank-line padding the model might add.
        let body_and_tail = text[nl + 1..].trim_end_matches('\r');
        let bytes = body_and_tail.as_bytes();
        // Search for the fence string preceded by start-of-line or
        // beginning-of-string. Walk back from each occurrence of the
        // fence to the start of that line.
        let mut cut = body_and_tail.len();
        let fence_bytes = fence.as_bytes();
        // Find every occurrence; we want the LAST one that's alone
        // on its line (only whitespace after the prior newline).
        let mut search_start = 0usize;
        while let Some(at) = body_and_tail[search_start..].find(fence) {
            let abs = search_start + at;
            // Check what's before: start of string or a newline.
            let line_start_ok = abs == 0
                || bytes[..abs].last().map(|b| *b == b'\n').unwrap_or(false);
            // Check what's after: end of string or only whitespace
            // until next newline / end.
            let after = abs + fence_bytes.len();
            let tail_ok = after == body_and_tail.len()
                || body_and_tail[after..]
                    .chars()
                    .take_while(|c| c.is_whitespace())
                    .any(|_| true)
                    && (after == body_and_tail.len()
                        || body_and_tail[after..]
                            .chars()
                            .take_while(|c| *c != '\n')
                            .all(|c| c.is_whitespace()));
            if line_start_ok && tail_ok {
                cut = abs;
                // Keep searching — there may be a later occurrence
                // (in case the model emitted nested fences).
                search_start = abs + fence_bytes.len();
            } else {
                search_start = abs + 1;
            }
        }
        // Walk `cut` back to before any trailing whitespace lines.
        let body = body_and_tail[..cut].trim_end();
        if body.is_empty() {
            // The body, post-strip, is empty. The model emitted just
            // a fence with nothing inside. Return the trimmed text
            // so the caller still gets something non-empty.
            return text;
        }
        body
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

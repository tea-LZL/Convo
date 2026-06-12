use crate::db::DbPool;
use crate::providers::types::{ChatRequest, MessageContent};
use crate::providers::{channelize, Provider};
use crate::streams::ActiveStreams;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatHistoryMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamArgs {
    pub session_id: String,
    pub model: String,
    pub messages: Vec<ChatHistoryMessage>,
    pub system: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub num_ctx: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub stop: Option<Vec<String>>,
}

#[tauri::command]
pub async fn chat_stream_v2(
    app: AppHandle,
    pool: State<'_, Arc<DbPool>>,
    streams: State<'_, ActiveStreams>,
    args: ChatStreamArgs,
) -> Result<(), String> {
    // Resolve provider from session -> model -> provider_id, fallback to default
    let conn = pool.get().map_err(|e| e.to_string())?;
    let provider_id: Option<String> = conn
        .query_row(
            "SELECT provider_id FROM sessions WHERE id = ?1",
            rusqlite::params![args.session_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let provider_id = provider_id.or_else(|| {
        conn.query_row(
            "SELECT id FROM providers WHERE is_default = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
    });
    let Some(provider_id) = provider_id else {
        return Err("No provider configured".into());
    };
    let (kind, base_url): (String, String) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("Provider lookup: {}", e))?;
    drop(conn);

    let api_key = crate::services::get_api_key(&provider_id);

    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(crate::providers::ollama::OllamaProvider::new(
            base_url,
            api_key,
        )),
        "openai_compat" => Box::new(
            crate::providers::openai_compat::OpenAiCompatProvider::new(base_url, api_key),
        ),
        other => return Err(format!("Unknown provider: {}", other)),
    };

    let messages: Vec<MessageContent> = args
        .messages
        .into_iter()
        .map(|m| MessageContent {
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            images: m.images,
        })
        .collect();

    let req = ChatRequest {
        model: args.model.clone(),
        messages,
        stream: true,
        system: args.system,
        temperature: args.temperature,
        top_p: args.top_p,
        top_k: args.top_k,
        num_ctx: args.num_ctx,
        repeat_penalty: args.repeat_penalty,
        stop: args.stop,
    };

    let stream = provider.chat_stream(req).await?;
    let (rx, _handle) = channelize(stream);

    let (tx, rx_cancel) = oneshot::channel::<()>();
    {
        let mut map = streams.0.lock().map_err(|e| e.to_string())?;
        map.insert(args.session_id.clone(), tx);
    }

    let app_clone = app.clone();
    let session_id = args.session_id.clone();
    tokio::spawn(async move {
        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut was_cancelled = false;
        let mut rx = rx;
        let mut rx_cancel = rx_cancel;
        loop {
            tokio::select! {
                _ = &mut rx_cancel => {
                    was_cancelled = true;
                    break;
                }
                item = rx.recv() => {
                    match item {
                        Some(Ok(chunk)) => {
                            if chunk.done {
                                let prompt_tokens = chunk.prompt_eval_count;
                                let output_tokens = chunk.eval_count;
                                let completed_at = chrono::Utc::now().to_rfc3339();
                                let _ = app_clone.emit(
                                    "chat-done",
                                    serde_json::json!({
                                        "conversation_id": &session_id,
                                        "prompt_tokens": prompt_tokens,
                                        "output_tokens": output_tokens,
                                        "completed_at": completed_at,
                                    }),
                                );
                                break;
                            }
                            if let Some(msg) = chunk.message {
                                if let Some(t) = msg.thinking {
                                    full_thinking.push_str(&t);
                                    let _ = app_clone.emit(
                                        "chat-thinking",
                                        serde_json::json!({
                                            "conversation_id": &session_id,
                                            "thinking": &full_thinking,
                                        }),
                                    );
                                }
                                if !msg.content.is_empty() {
                                    full_content.push_str(&msg.content);
                                    let _ = app_clone.emit(
                                        "chat-chunk",
                                        serde_json::json!({
                                            "conversation_id": &session_id,
                                            "content": &msg.content,
                                            "full_content": &full_content,
                                        }),
                                    );
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let _ = app_clone.emit(
                                "chat-error",
                                serde_json::json!({
                                    "conversation_id": &session_id,
                                    "error": e.to_string(),
                                }),
                            );
                            break;
                        }
                        None => break,
                    }
                }
            }
        }
        if was_cancelled {
            let _ = app_clone.emit("chat-cancelled", &session_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_chat_v2(streams: State<'_, ActiveStreams>, session_id: String) -> Result<(), String> {
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = map.remove(&session_id) {
        let _ = tx.send(());
    }
    Ok(())
}

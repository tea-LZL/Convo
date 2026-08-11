use crate::commands::chat::{upsert_message_conn, MessageInput};
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
    pub stream_id: String,
    pub assistant_message_id: String,
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

#[derive(Debug, Serialize, Clone)]
struct ChatThinkingEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatChunkEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatDoneEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    prompt_tokens: Option<u32>,
    output_tokens: Option<u32>,
    completed_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatErrorEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    error: String,
    completed_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatCancelledEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    completed_at: String,
}

fn persist_assistant(
    pool: &DbPool,
    session_id: &str,
    message_id: &str,
    content: &str,
    thinking: &str,
    usage: (Option<u32>, Option<u32>),
    created_at: &str,
) {
    if content.is_empty() && thinking.is_empty() {
        return;
    }
    let result = pool.get().map_err(|e| e.to_string()).and_then(|conn| {
        upsert_message_conn(
            &conn,
            &MessageInput {
                id: message_id.to_string(),
                session_id: session_id.to_string(),
                role: "assistant".to_string(),
                content: content.to_string(),
                thinking: (!thinking.is_empty()).then(|| thinking.to_string()),
                attachments_json: None,
                prompt_tokens: usage.0.map(|v| v as i64),
                output_tokens: usage.1.map(|v| v as i64),
                created_at: Some(created_at.to_string()),
            },
        )
    });
    if let Err(error) = result {
        tracing::error!(session_id, message_id, %error, "could not persist assistant message");
    }
}

#[tauri::command]
pub async fn chat_stream_v2(
    app: AppHandle,
    pool: State<'_, Arc<DbPool>>,
    streams: State<'_, ActiveStreams>,
    args: ChatStreamArgs,
) -> Result<(), String> {
    if args.stream_id.trim().is_empty() || args.assistant_message_id.trim().is_empty() {
        return Err("stream_id and assistant_message_id are required".into());
    }
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
            base_url, api_key,
        )),
        "openai_compat" => Box::new(crate::providers::openai_compat::OpenAiCompatProvider::new(
            base_url, api_key,
        )),
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
    let stream_id = args.stream_id.clone();
    let assistant_message_id = args.assistant_message_id.clone();
    let stream_key = format!("{}:{}", args.session_id, stream_id);

    let (tx, rx_cancel) = oneshot::channel::<()>();
    {
        let mut map = streams.0.lock().map_err(|e| e.to_string())?;
        let prefix = format!("{}:", args.session_id);
        for key in map
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>()
        {
            if let Some(previous) = map.remove(&key) {
                let _ = previous.send(());
            }
        }
        map.insert(stream_key.clone(), tx);
    }

    let app_clone = app.clone();
    let session_id = args.session_id.clone();
    let stream_id_for_events = stream_id.clone();
    let assistant_message_id_for_events = assistant_message_id.clone();
    let stream_key_for_cleanup = stream_key.clone();
    let streams_clone = ActiveStreams(streams.0.clone());
    let pool_clone = pool.inner().clone();
    tokio::spawn(async move {
        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut was_cancelled = false;
        let mut terminal_event_emitted = false;
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
                                persist_assistant(
                                    &pool_clone,
                                    &session_id,
                                    &assistant_message_id_for_events,
                                    &full_content,
                                    &full_thinking,
                                    (prompt_tokens, output_tokens),
                                    &completed_at,
                                );
                                let _ = app_clone.emit(
                                    "chat-done",
                                    ChatDoneEvent {
                                        conversation_id: session_id.clone(),
                                        stream_id: stream_id_for_events.clone(),
                                        assistant_message_id: assistant_message_id_for_events.clone(),
                                        prompt_tokens,
                                        output_tokens,
                                        completed_at,
                                    },
                                );
                                terminal_event_emitted = true;
                                break;
                            }
                            if let Some(msg) = chunk.message {
                                if let Some(t) = msg.thinking {
                                    full_thinking.push_str(&t);
                                    let _ = app_clone.emit(
                                        "chat-thinking",
                                        ChatThinkingEvent {
                                            conversation_id: session_id.clone(),
                                            stream_id: stream_id_for_events.clone(),
                                            assistant_message_id: assistant_message_id_for_events.clone(),
                                            delta: t,
                                        },
                                    );
                                }
                                if !msg.content.is_empty() {
                                    full_content.push_str(&msg.content);
                                    let _ = app_clone.emit(
                                        "chat-chunk",
                                        ChatChunkEvent {
                                            conversation_id: session_id.clone(),
                                            stream_id: stream_id_for_events.clone(),
                                            assistant_message_id: assistant_message_id_for_events.clone(),
                                            delta: msg.content,
                                        },
                                    );
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let completed_at = chrono::Utc::now().to_rfc3339();
                            persist_assistant(
                                &pool_clone,
                                &session_id,
                                &assistant_message_id_for_events,
                                    &full_content,
                                    &full_thinking,
                                    (None, None),
                                    &completed_at,
                            );
                            let _ = app_clone.emit(
                                "chat-error",
                                ChatErrorEvent {
                                    conversation_id: session_id.clone(),
                                    stream_id: stream_id_for_events.clone(),
                                    assistant_message_id: assistant_message_id_for_events.clone(),
                                    error: e.to_string(),
                                    completed_at,
                                },
                            );
                            terminal_event_emitted = true;
                            break;
                        }
                        None => break,
                    }
                }
            }
        }

        // Clean up the ActiveStreams entry so the cancel-token doesn't
        // get dropped by replacement on the next send (which would fire
        // a spurious chat-cancelled for this session).
        {
            if let Ok(mut map) = streams_clone.0.lock() {
                map.remove(&stream_key_for_cleanup);
            }
        }

        if was_cancelled {
            let completed_at = chrono::Utc::now().to_rfc3339();
            let content = if full_content.is_empty() {
                String::new()
            } else {
                format!("{} [stopped]", full_content)
            };
            persist_assistant(
                &pool_clone,
                &session_id,
                &assistant_message_id_for_events,
                &content,
                &full_thinking,
                (None, None),
                &completed_at,
            );
            let _ = app_clone.emit(
                "chat-cancelled",
                ChatCancelledEvent {
                    conversation_id: session_id.clone(),
                    stream_id: stream_id_for_events.clone(),
                    assistant_message_id: assistant_message_id_for_events.clone(),
                    completed_at,
                },
            );
        } else if !terminal_event_emitted {
            // The stream ended without a done chunk (provider closed
            // the connection or dropped the final done event). Emit a
            // synthetic chat-done so the frontend can finalize — set
            // s.streaming = false and save the partial content.
            let completed_at = chrono::Utc::now().to_rfc3339();
            persist_assistant(
                &pool_clone,
                &session_id,
                &assistant_message_id_for_events,
                &full_content,
                &full_thinking,
                (None, None),
                &completed_at,
            );
            let _ = app_clone.emit(
                "chat-done",
                ChatDoneEvent {
                    conversation_id: session_id,
                    stream_id: stream_id_for_events,
                    assistant_message_id: assistant_message_id_for_events,
                    prompt_tokens: None,
                    output_tokens: None,
                    completed_at,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_chat_v2(
    streams: State<'_, ActiveStreams>,
    session_id: String,
    stream_id: Option<String>,
) -> Result<(), String> {
    let Some(stream_id) = stream_id.filter(|id| !id.trim().is_empty()) else {
        return Err("stream_id is required".into());
    };
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    let key = format!("{}:{}", session_id, stream_id);
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ChatChunkEvent, ChatDoneEvent};

    #[test]
    fn stream_events_always_carry_generation_and_message_identity() {
        let chunk = serde_json::to_value(ChatChunkEvent {
            conversation_id: "session-1".into(),
            stream_id: "stream-1".into(),
            assistant_message_id: "assistant-1".into(),
            delta: "hello".into(),
        })
        .unwrap();
        assert_eq!(chunk["stream_id"], "stream-1");
        assert_eq!(chunk["assistant_message_id"], "assistant-1");

        let done = serde_json::to_value(ChatDoneEvent {
            conversation_id: "session-1".into(),
            stream_id: "stream-1".into(),
            assistant_message_id: "assistant-1".into(),
            prompt_tokens: None,
            output_tokens: None,
            completed_at: "now".into(),
        })
        .unwrap();
        assert_eq!(done["conversation_id"], "session-1");
        assert!(done.get("stream_id").is_some());
    }
}

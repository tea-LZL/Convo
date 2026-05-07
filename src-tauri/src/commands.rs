use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncBufReadExt;
use tokio::sync::oneshot;

use crate::conversation;
use crate::ollama::{self, ChatMessage, OllamaModel};
use crate::streams::ActiveStreams;

#[tauri::command]
pub async fn list_models() -> Result<Vec<OllamaModel>, String> {
    ollama::list_models().await
}

#[tauri::command]
pub async fn get_model_context_length(model: String) -> Result<u32, String> {
    ollama::get_model_context_length(model).await
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    streams: State<'_, ActiveStreams>,
    conversation_id: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let response = ollama::chat_stream(model, messages).await?;
    let byte_stream = response.bytes_stream();
    let reader = tokio_util::io::StreamReader::new(
        byte_stream.map(|r: Result<_, reqwest::Error>| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
    );
    let buf_reader = tokio::io::BufReader::new(reader);
    let mut lines = buf_reader.lines();

    let (tx, rx) = oneshot::channel::<()>();
    {
        let mut map = streams.0.lock().map_err(|e| e.to_string())?;
        map.insert(conversation_id.clone(), tx);
    }

    let app_clone = app.clone();
    let conv_id = conversation_id.clone();
    let streams_clone = streams.inner().clone();

    tokio::spawn(async move {
        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut was_cancelled = false;
        let mut rx = rx;

        loop {
            tokio::select! {
                _ = &mut rx => {
                    was_cancelled = true;
                    break;
                }
                result = lines.next_line() => {
                    match result {
                        Ok(Some(line)) => {
                            let line = line.trim().to_string();
                            if line.is_empty() {
                                continue;
                            }

                            match serde_json::from_str::<ollama::ChatResponseChunk>(&line) {
                                Ok(chunk) => {
                                    if chunk.done {
                                        let prompt_tokens = chunk.prompt_eval_count.unwrap_or(0);
                                        let output_tokens = chunk.eval_count.unwrap_or(0);
                                        let completed_at = chrono::Utc::now().to_rfc3339();
                                        let _ = app_clone.emit(
                                            "chat-done",
                                            serde_json::json!({
                                                "conversation_id": &conv_id,
                                                "prompt_tokens": prompt_tokens,
                                                "output_tokens": output_tokens,
                                                "completed_at": completed_at,
                                            }),
                                        );
                                        break;
                                    } else if let Some(msg) = chunk.message {
                                        if let Some(thinking) = &msg.thinking {
                                            full_thinking.push_str(thinking);
                                            let _ = app_clone.emit(
                                                "chat-thinking",
                                                serde_json::json!({
                                                    "conversation_id": &conv_id,
                                                    "thinking": &full_thinking,
                                                }),
                                            );
                                        }
                                        if !msg.content.is_empty() {
                                            full_content.push_str(&msg.content);
                                            let _ = app_clone.emit(
                                                "chat-chunk",
                                                serde_json::json!({
                                                    "conversation_id": &conv_id,
                                                    "content": &msg.content,
                                                    "full_content": &full_content,
                                                }),
                                            );
                                        }
                                    }
                                }
                                Err(e) => {
                                    let _ = app_clone.emit(
                                        "chat-error",
                                        serde_json::json!({
                                            "conversation_id": &conv_id,
                                            "error": format!("Parse error: {} (line: {})", e, &line[..line.len().min(200)]),
                                        }),
                                    );
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = app_clone.emit(
                                "chat-error",
                                serde_json::json!({
                                    "conversation_id": &conv_id,
                                    "error": format!("Stream error: {}", e),
                                }),
                            );
                            break;
                        }
                    }
                }
            }
        }

        {
            let mut map = streams_clone.0.lock().map_err(|e| e.to_string()).unwrap();
            map.remove(&conv_id);
        }

        if was_cancelled {
            let _ = app_clone.emit("chat-cancelled", &conv_id);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_chat(
    streams: State<'_, ActiveStreams>,
    conversation_id: String,
) -> Result<(), String> {
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = map.remove(&conversation_id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_conversation_messages(
    id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    conversation::save_messages(&id, &messages)
}

#[tauri::command]
pub fn list_conversations() -> Result<Vec<conversation::Conversation>, String> {
    conversation::list_conversations()
}

#[tauri::command]
pub fn create_conversation(title: String, model: String) -> Result<conversation::Conversation, String> {
    conversation::create_conversation(title, model)
}

#[tauri::command]
pub fn rename_conversation(id: String, title: String) -> Result<(), String> {
    conversation::rename_conversation(&id, &title)
}

#[tauri::command]
pub fn delete_conversation(id: String) -> Result<(), String> {
    conversation::delete_conversation(&id)
}

#[tauri::command]
pub fn get_messages(id: String) -> Result<Vec<ChatMessage>, String> {
    let conv = conversation::get_conversation(&id)?;
    Ok(conv.messages)
}

#[tauri::command]
pub fn get_conversation(id: String) -> Result<conversation::Conversation, String> {
    conversation::get_conversation(&id)
}

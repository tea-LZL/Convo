use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::db::DbPool;
use crate::providers::channelize;
use crate::providers::types::{ChatRequest, MessageContent};
use crate::streams::ActiveStreams;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompareConfig {
    pub prompt: String,
    pub models: Vec<CompareModelConfig>,
    pub system: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompareModelConfig {
    pub provider_id: String,
    pub model: String,
}

#[tauri::command]
pub async fn run_compare(
    app: AppHandle,
    pool: State<'_, Arc<DbPool>>,
    config: CompareConfig,
) -> Result<String, String> {
    let run_id = Uuid::new_v4().to_string();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let config_json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO compare_runs (id, prompt, config_json, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![run_id, config.prompt, config_json, now],
    )
    .map_err(|e| e.to_string())?;

    // Load providers and dispatch streams
    for (i, m) in config.models.iter().enumerate() {
        let (kind, base_url, api_key): (String, String, Option<String>) = conn
            .query_row(
                "SELECT kind, base_url, NULL FROM providers WHERE id = ?1",
                rusqlite::params![m.provider_id],
                |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get(2)?)),
            )
            .map_err(|e| format!("Provider {} not found: {}", m.provider_id, e))?;
        let key_from_keyring = crate::services::get_api_key(&m.provider_id);
        let api_key = api_key.or(key_from_keyring);

        let provider: Box<dyn crate::providers::Provider> = match kind.as_str() {
            "ollama" => Box::new(crate::providers::ollama::OllamaProvider::new(
                base_url,
                api_key,
            )),
            "openai_compat" => Box::new(crate::providers::openai_compat::OpenAiCompatProvider::new(
                base_url,
                api_key,
            )),
            other => return Err(format!("Unknown provider kind: {}", other)),
        };

        let req = ChatRequest {
            model: m.model.clone(),
            messages: vec![MessageContent {
                role: "user".into(),
                content: config.prompt.clone(),
                thinking: None,
                images: vec![],
            }],
            stream: true,
            system: config.system.clone(),
            temperature: config.temperature,
            top_p: config.top_p,
            top_k: None,
            num_ctx: None,
            repeat_penalty: None,
            stop: None,
        };

        let stream = provider.chat_stream(req).await?;
        let (rx, _handle) = channelize(stream);

        let app_clone = app.clone();
        let run_id_clone = run_id.clone();
        let (tx, mut rx_cancel) = oneshot::channel::<()>();
        let streams = app_clone.state::<ActiveStreams>();
        streams.0.lock().map_err(|e| e.to_string())?.insert(format!("{}:{}", run_id, i), tx);

        tokio::spawn(async move {
            let mut full_content = String::new();
            let mut full_thinking = String::new();
            let mut rx = rx;
            loop {
                tokio::select! {
                    _ = &mut rx_cancel => {
                        let _ = app_clone.emit(
                            "compare-cancelled",
                            serde_json::json!({ "run_id": &run_id_clone, "index": i }),
                        );
                        break;
                    }
                    item = rx.recv() => {
                        match item {
                            Some(Ok(chunk)) => {
                                if chunk.done {
                                    let prompt_tokens = chunk.prompt_eval_count;
                                    let output_tokens = chunk.eval_count;
                                    let _ = app_clone.emit(
                                        "compare-done",
                                        serde_json::json!({
                                            "run_id": &run_id_clone,
                                            "index": i,
                                            "prompt_tokens": prompt_tokens,
                                            "output_tokens": output_tokens,
                                        }),
                                    );
                                    break;
                                }
                                if let Some(msg) = chunk.message {
                                    if let Some(t) = msg.thinking {
                                        full_thinking.push_str(&t);
                                        let _ = app_clone.emit(
                                            "compare-thinking",
                                            serde_json::json!({
                                                "run_id": &run_id_clone,
                                                "index": i,
                                                "thinking": &full_thinking,
                                            }),
                                        );
                                    }
                                    if !msg.content.is_empty() {
                                        full_content.push_str(&msg.content);
                                        let _ = app_clone.emit(
                                            "compare-chunk",
                                            serde_json::json!({
                                                "run_id": &run_id_clone,
                                                "index": i,
                                                "content": &msg.content,
                                                "full_content": &full_content,
                                            }),
                                        );
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                let _ = app_clone.emit(
                                    "compare-error",
                                    serde_json::json!({ "run_id": &run_id_clone, "index": i, "error": e.to_string() }),
                                );
                                break;
                            }
                            None => break,
                        }
                    }
                }
            }
        });
    }

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_compare(streams: State<'_, ActiveStreams>, run_id: String) -> Result<(), String> {
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&format!("{}:", run_id))).cloned().collect();
    for k in keys {
        if let Some(tx) = map.remove(&k) {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn save_compare_winner(
    pool: State<'_, Arc<DbPool>>,
    run_id: String,
    winner_index: i64,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE compare_runs SET winner_index = ?1 WHERE id = ?2",
        rusqlite::params![winner_index, run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::db::DbPool;
use crate::providers::channelize;
use crate::providers::types::{ChatRequest, MessageContent};
use crate::streams::ActiveStreams;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareConfig {
    pub prompt: String,
    pub models: Vec<CompareModelConfig>,
    pub system: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
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
    // Pre-allocate results_json with empty slots so we can update it later
    let results_init = serde_json::to_string(
        &config.models.iter().map(|_| serde_json::json!({"content": "", "thinking": ""})).collect::<Vec<_>>()
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO compare_runs (id, prompt, config_json, results_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![run_id, config.prompt, config_json, results_init, now],
    )
    .map_err(|e| e.to_string())?;

    // Load providers and dispatch streams
    let results_collector: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(
        config.models.iter().map(|_| serde_json::json!({"content": "", "thinking": ""})).collect()
    ));
    let started_at = chrono::Utc::now();
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

        let collector = results_collector.clone();
        let run_id_for_persist = run_id.clone();
        let pool_for_persist = pool.inner().clone();
        tokio::spawn(async move {
            let mut full_content = String::new();
            let mut full_thinking = String::new();
            let mut prompt_tokens: Option<u32> = None;
            let mut output_tokens: Option<u32> = None;
            let column_started = chrono::Utc::now();
            let mut cancelled = false;
            let mut error_msg: Option<String> = None;
            let mut rx = rx;
            loop {
                tokio::select! {
                    _ = &mut rx_cancel => {
                        cancelled = true;
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
                                    prompt_tokens = chunk.prompt_eval_count;
                                    output_tokens = chunk.eval_count;
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
                                error_msg = Some(e.to_string());
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
            // Persist this column's result
            let duration_ms = (chrono::Utc::now() - column_started).num_milliseconds();
            {
                let mut guard = collector.lock().unwrap();
                if i < guard.len() {
                    guard[i] = serde_json::json!({
                        "content": &full_content,
                        "thinking": &full_thinking,
                        "prompt_tokens": prompt_tokens,
                        "output_tokens": output_tokens,
                        "duration_ms": duration_ms,
                        "cancelled": cancelled,
                        "error": error_msg,
                    });
                }
            }
            // Persist to DB (fire and forget, but try to update results_json)
            let snapshot = {
                let guard = collector.lock().unwrap();
                guard.clone()
            };
            if let Ok(json) = serde_json::to_string(&snapshot) {
                if let Ok(conn) = pool_for_persist.get() {
                    let _ = conn.execute(
                        "UPDATE compare_runs SET results_json = ?1 WHERE id = ?2",
                        rusqlite::params![json, run_id_for_persist],
                    );
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
pub fn cancel_compare_column(
    streams: State<'_, ActiveStreams>,
    run_id: String,
    index: usize,
) -> Result<(), String> {
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    let key = format!("{}:{}", run_id, index);
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(());
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompareRunSummary {
    pub id: String,
    pub prompt: String,
    pub config_json: String,
    pub results_json: Option<String>,
    pub winner_index: Option<i64>,
    pub created_at: String,
}

#[tauri::command]
pub fn list_compare_runs(
    pool: State<'_, Arc<DbPool>>,
    limit: Option<i64>,
) -> Result<Vec<CompareRunSummary>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, prompt, config_json, results_json, winner_index, created_at
             FROM compare_runs ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![lim], |row| {
            Ok(CompareRunSummary {
                id: row.get(0)?,
                prompt: row.get(1)?,
                config_json: row.get(2)?,
                results_json: row.get(3)?,
                winner_index: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_compare_run(
    pool: State<'_, Arc<DbPool>>,
    id: String,
) -> Result<CompareRunSummary, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, prompt, config_json, results_json, winner_index, created_at
         FROM compare_runs WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(CompareRunSummary {
                id: row.get(0)?,
                prompt: row.get(1)?,
                config_json: row.get(2)?,
                results_json: row.get(3)?,
                winner_index: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Persist the prompt + winner response as a new chat session so the user can
/// continue the conversation.
#[tauri::command]
pub fn save_compare_as_session(
    pool: State<'_, Arc<DbPool>>,
    run_id: String,
    winner_index: i64,
) -> Result<String, String> {
    use uuid::Uuid;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (prompt, config_json, results_json): (String, String, Option<String>) = conn
        .query_row(
            "SELECT prompt, config_json, results_json FROM compare_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let cfg: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("Parse config: {}", e))?;
    let results: serde_json::Value = results_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| format!("Parse results: {}", e))?
        .unwrap_or_else(|| serde_json::json!([]));
    let winner = results
        .as_array()
        .and_then(|arr| arr.get(winner_index as usize))
        .ok_or_else(|| "Winner not in results".to_string())?;
    let winner_content = winner
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let winner_model = cfg
        .get("models")
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.get(winner_index as usize))
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let winner_provider = cfg
        .get("models")
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.get(winner_index as usize))
        .and_then(|m| m.get("provider_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let now = chrono::Utc::now().to_rfc3339();
    let session_id = Uuid::new_v4().to_string();
    // Title from the first line of the prompt
    let title = prompt.lines().next().unwrap_or("Compare winner").chars().take(60).collect::<String>();
    // Build a model id of the form "provider::name" or just "name"
    let model_id = match &winner_provider {
        Some(p) => format!("{}::{}", p, winner_model),
        None => winner_model.clone(),
    };
    conn.execute(
        "INSERT INTO sessions (id, title, model_id, provider_id, preset_id, group_id, is_pinned, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, 0, 0, ?5, ?5)",
        rusqlite::params![session_id, title, model_id, winner_provider, now],
    ).map_err(|e| e.to_string())?;
    let user_msg_id = Uuid::new_v4().to_string();
    let asst_msg_id = Uuid::new_v4().to_string();
    let now2 = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, created_at)
         VALUES (?1, ?2, 'user', ?3, NULL, NULL, ?4)",
        rusqlite::params![user_msg_id, session_id, prompt, now],
    ).map_err(|e| e.to_string())?;
    let prompt_tokens = winner.get("prompt_tokens").and_then(|v| v.as_u64());
    let output_tokens = winner.get("output_tokens").and_then(|v| v.as_u64());
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, thinking, attachments_json, prompt_tokens, output_tokens, created_at)
         VALUES (?1, ?2, 'assistant', ?3, NULL, NULL, ?4, ?5, ?6)",
        rusqlite::params![
            asst_msg_id,
            session_id,
            winner_content,
            prompt_tokens.map(|v| v as i64),
            output_tokens.map(|v| v as i64),
            now2
        ],
    ).map_err(|e| e.to_string())?;
    Ok(session_id)
}

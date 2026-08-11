use crate::db::models::Model;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;

use crate::db::DbPool;
use crate::providers::discovery::scan_localhost;
use crate::providers::ollama::OllamaProvider;
use crate::providers::Provider;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static MODEL_PULLS: OnceLock<Mutex<HashMap<String, tokio::task::AbortHandle>>> = OnceLock::new();

fn model_pulls() -> &'static Mutex<HashMap<String, tokio::task::AbortHandle>> {
    MODEL_PULLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub async fn list_models_for_provider(
    pool: State<'_, Arc<DbPool>>,
    provider_id: String,
) -> Result<Vec<Model>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, provider_id, name, family, parameter_size, quantization,
                    context_length, size_bytes, supports_thinking, supports_vision, last_seen
             FROM models WHERE provider_id = ?1 ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![provider_id], |row| {
            Ok(Model {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                name: row.get(2)?,
                family: row.get(3)?,
                parameter_size: row.get(4)?,
                quantization: row.get(5)?,
                context_length: row.get(6)?,
                size_bytes: row.get(7)?,
                supports_thinking: row.get::<_, i64>(8)? != 0,
                supports_vision: row.get::<_, i64>(9)? != 0,
                last_seen: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_all_models(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Model>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, provider_id, name, family, parameter_size, quantization,
                    context_length, size_bytes, supports_thinking, supports_vision, last_seen
             FROM models ORDER BY provider_id, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Model {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                name: row.get(2)?,
                family: row.get(3)?,
                parameter_size: row.get(4)?,
                quantization: row.get(5)?,
                context_length: row.get(6)?,
                size_bytes: row.get(7)?,
                supports_thinking: row.get::<_, i64>(8)? != 0,
                supports_vision: row.get::<_, i64>(9)? != 0,
                last_seen: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_models(
    pool: State<'_, Arc<DbPool>>,
    provider_id: String,
) -> Result<Vec<Model>, String> {
    // Look up provider
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (kind, base_url, api_key): (String, String, Option<String>) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, ''), NULL FROM providers WHERE id = ?1",
            params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| format!("Provider lookup: {}", e))?;
    drop(conn);

    let keyring_key = crate::services::get_api_key(&provider_id);
    let api_key = api_key.or(keyring_key);

    let models: Vec<crate::providers::ModelInfo> = match kind.as_str() {
        "ollama" => {
            let p = OllamaProvider::new(base_url, api_key);
            p.list_models().await.map_err(|e| e.to_string())?
        }
        "openai_compat" => {
            let p = crate::providers::openai_compat::OpenAiCompatProvider::new(base_url, api_key);
            p.list_models().await.map_err(|e| e.to_string())?
        }
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    let conn = pool.get().map_err(|e| e.to_string())?;
    let now_str = now();
    for m in &models {
        let id = format!("{}::{}", provider_id, m.name);
        conn.execute(
            "INSERT INTO models (id, provider_id, name, family, parameter_size, quantization,
                                 context_length, size_bytes, supports_thinking, supports_vision, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(provider_id, name) DO UPDATE SET
                 family = excluded.family,
                 parameter_size = excluded.parameter_size,
                 quantization = excluded.quantization,
                 context_length = excluded.context_length,
                 size_bytes = excluded.size_bytes,
                 supports_thinking = excluded.supports_thinking,
                 supports_vision = excluded.supports_vision,
                 last_seen = excluded.last_seen",
            params![
                id,
                provider_id,
                m.name,
                m.family,
                m.parameter_size,
                m.quantization,
                m.context_length.map(|v| v as i64),
                m.size_bytes.map(|v| v as i64),
                m.supports_thinking as i64,
                m.supports_vision as i64,
                now_str,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    drop(conn);

    // Drop models that are no longer present (separate scope to release borrows before await)
    {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let names: Vec<String> = models.iter().map(|m| m.name.clone()).collect();
        if names.is_empty() {
            conn.execute(
                "DELETE FROM models WHERE provider_id = ?1",
                params![provider_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            let placeholders: Vec<String> =
                (0..names.len()).map(|i| format!("?{}", i + 2)).collect();
            let sql = format!(
                "DELETE FROM models WHERE provider_id = ?1 AND name NOT IN ({})",
                placeholders.join(",")
            );
            let mut owned: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(provider_id.clone())];
            for n in &names {
                owned.push(Box::new(n.clone()));
            }
            let refs: Vec<&dyn rusqlite::ToSql> = owned
                .iter()
                .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
                .collect();
            let _ = conn.execute(&sql, refs.as_slice());
        }
    }

    list_models_for_provider(pool, provider_id).await
}

fn ollama_provider(pool: &DbPool, provider_id: &str) -> Result<(String, Option<String>), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (kind, base_url): (String, String) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            params![provider_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Provider lookup: {}", e))?;
    if kind != "ollama" {
        return Err("Model mutations are supported only for Ollama providers".into());
    }
    let base_url = base_url.trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Ollama provider has no base URL".into());
    }
    Ok((base_url, crate::services::get_api_key(provider_id)))
}

#[derive(Debug, Serialize, Clone)]
struct ModelPullEvent {
    operation_id: String,
    provider_id: String,
    name: String,
    status: String,
    digest: String,
    total: u64,
    completed: u64,
    percent: f64,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaPullChunk {
    #[serde(default)]
    status: String,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

fn pull_event(
    operation_id: &str,
    provider_id: &str,
    name: &str,
    status: &str,
    digest: Option<String>,
    progress: (u64, u64),
    error: Option<String>,
) -> ModelPullEvent {
    let (total, completed) = progress;
    ModelPullEvent {
        operation_id: operation_id.to_string(),
        provider_id: provider_id.to_string(),
        name: name.to_string(),
        status: status.to_string(),
        digest: digest.unwrap_or_default(),
        total,
        completed,
        percent: if total > 0 {
            completed as f64 / total as f64 * 100.0
        } else {
            0.0
        },
        error,
    }
}

#[tauri::command]
pub async fn pull_model_for_provider(
    app: AppHandle,
    pool: tauri::State<'_, std::sync::Arc<DbPool>>,
    provider_id: String,
    name: String,
) -> Result<String, String> {
    let (base_url, api_key) = ollama_provider(pool.inner().as_ref(), &provider_id)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let operation_for_task = operation_id.clone();
    let provider_for_task = provider_id.clone();
    let name_for_task = name.clone();
    let app_for_task = app.clone();
    let client = reqwest::Client::new();
    let handle = tokio::spawn(async move {
        let result: Result<(), String> = async {
            let mut request = client
                .post(format!("{}/api/pull", base_url))
                .json(&serde_json::json!({ "name": name_for_task, "stream": true }));
            if let Some(key) = api_key {
                request = request.bearer_auth(key);
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(format!("Ollama error {}: {}", status, body));
            }
            let mut buffer = String::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                buffer.push_str(&String::from_utf8_lossy(
                    &chunk.map_err(|e| format!("Stream error: {}", e))?,
                ));
                while let Some(newline) = buffer.find('\n') {
                    let line = buffer[..newline].trim().to_string();
                    buffer.drain(..=newline);
                    if line.is_empty() {
                        continue;
                    }
                    let progress: OllamaPullChunk = serde_json::from_str(&line)
                        .map_err(|e| format!("Invalid pull response: {}", e))?;
                    let total = progress.total.unwrap_or(0);
                    let completed = progress.completed.unwrap_or(0);
                    if let Some(error) = progress.error {
                        return Err(error);
                    }
                    let status = progress.status.clone();
                    let _ = app_for_task.emit(
                        "model-pull-progress",
                        pull_event(
                            &operation_for_task,
                            &provider_for_task,
                            &name_for_task,
                            &status,
                            progress.digest,
                            (total, completed),
                            None,
                        ),
                    );
                    if status == "success" {
                        return Ok(());
                    }
                }
            }
            Ok(())
        }
        .await;

        let event = match result {
            Ok(()) => pull_event(
                &operation_for_task,
                &provider_for_task,
                &name_for_task,
                "success",
                None,
                (0, 0),
                None,
            ),
            Err(error) => pull_event(
                &operation_for_task,
                &provider_for_task,
                &name_for_task,
                "error",
                None,
                (0, 0),
                Some(error),
            ),
        };
        let event_name = if event.status == "success" {
            "model-pull-done"
        } else {
            "model-pull-error"
        };
        let _ = app_for_task.emit(event_name, event);
        if let Ok(mut pulls) = model_pulls().lock() {
            pulls.remove(&operation_for_task);
        }
    });
    if let Ok(mut pulls) = model_pulls().lock() {
        pulls.insert(operation_id.clone(), handle.abort_handle());
    }
    Ok(operation_id)
}

#[tauri::command]
pub fn cancel_model_pull(app: AppHandle, operation_id: String) -> Result<(), String> {
    let handle = model_pulls()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&operation_id);
    if let Some(handle) = handle {
        handle.abort();
        let _ = app.emit(
            "model-pull-cancelled",
            pull_event(&operation_id, "", "", "cancelled", None, (0, 0), None),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_model_for_provider(
    pool: tauri::State<'_, std::sync::Arc<DbPool>>,
    provider_id: String,
    name: String,
) -> Result<(), String> {
    let (base_url, api_key) = ollama_provider(pool.inner().as_ref(), &provider_id)?;
    let client = reqwest::Client::new();
    let mut request = client
        .delete(format!("{}/api/delete", base_url))
        .json(&serde_json::json!({ "name": name }));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, body));
    }
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM models WHERE provider_id = ?1 AND name = ?2",
        params![provider_id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_custom_model_for_provider(
    pool: tauri::State<'_, std::sync::Arc<DbPool>>,
    provider_id: String,
    name: String,
    base_model: String,
    num_ctx: u32,
) -> Result<(), String> {
    if name.trim().is_empty() || base_model.trim().is_empty() || num_ctx == 0 {
        return Err("Model name, base model, and context length are required".into());
    }
    let (base_url, api_key) = ollama_provider(pool.inner().as_ref(), &provider_id)?;
    let client = reqwest::Client::new();
    let mut request = client
        .post(format!("{}/api/create", base_url))
        .json(&serde_json::json!({
            "name": name,
            "modelfile": format!("FROM {}\nPARAMETER num_ctx {}\n", base_model, num_ctx),
            "stream": false,
        }));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, body));
    }
    let _ = response.bytes().await;
    Ok(())
}

#[tauri::command]
pub async fn list_local_servers() -> Result<Vec<crate::services::DiscoveredServer>, String> {
    Ok(scan_localhost().await)
}

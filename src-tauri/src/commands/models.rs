use crate::db::models::Model;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;

use crate::db::DbPool;
use crate::providers::discovery::scan_localhost;
use crate::providers::ollama::OllamaProvider;
use crate::providers::Provider;

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
            ).map_err(|e| e.to_string())?;
        } else {
            let placeholders: Vec<String> = (0..names.len()).map(|i| format!("?{}", i + 2)).collect();
            let sql = format!(
                "DELETE FROM models WHERE provider_id = ?1 AND name NOT IN ({})",
                placeholders.join(",")
            );
            let mut owned: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(provider_id.clone())];
            for n in &names {
                owned.push(Box::new(n.clone()));
            }
            let refs: Vec<&dyn rusqlite::ToSql> = owned.iter().map(|b| b.as_ref() as &dyn rusqlite::ToSql).collect();
            let _ = conn.execute(&sql, refs.as_slice());
        }
    }

    list_models_for_provider(pool, provider_id).await
}

#[tauri::command]
pub async fn list_local_servers() -> Result<Vec<crate::services::DiscoveredServer>, String> {
    Ok(scan_localhost().await)
}

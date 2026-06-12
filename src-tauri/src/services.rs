use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;

use crate::db::DbPool;

pub fn keyring_service() -> &'static str {
    "com.tea.convo"
}

pub fn keyring_account(provider_id: &str) -> String {
    format!("api-key:{}", provider_id)
}

pub fn store_api_key(provider_id: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(keyring_service(), &keyring_account(provider_id))
        .map_err(|e| format!("Keyring: {}", e))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Keyring set: {}", e))?;
    Ok(())
}

pub fn get_api_key(provider_id: &str) -> Option<String> {
    let entry = keyring::Entry::new(keyring_service(), &keyring_account(provider_id)).ok()?;
    entry.get_password().ok()
}

pub fn delete_api_key(provider_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(keyring_service(), &keyring_account(provider_id))
        .map_err(|e| format!("Keyring: {}", e))?;
    let _ = entry.delete_credential();
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Provider {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
    pub is_default: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredServer {
    pub base_url: String,
    pub kind: String,
    pub models: Vec<DiscoveredModel>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
    pub context_length: Option<u32>,
}

#[tauri::command]
pub async fn list_providers(pool: tauri::State<'_, Arc<DbPool>>) -> Result<Vec<Provider>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, kind, name, base_url, is_default, created_at FROM providers ORDER BY is_default DESC, name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Provider {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                base_url: row.get(3)?,
                has_api_key: None,
                is_default: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut providers: Vec<Provider> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    for p in providers.iter_mut() {
        p.has_api_key = Some(get_api_key(&p.id).is_some());
    }
    Ok(providers)
}

#[tauri::command]
pub async fn add_provider(
    pool: tauri::State<'_, Arc<DbPool>>,
    kind: String,
    name: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Provider, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO providers (id, kind, name, base_url, is_default) VALUES (?1, ?2, ?3, ?4, 0)",
        rusqlite::params![id, kind, name, base_url],
    )
    .map_err(|e| format!("Insert provider: {}", e))?;
    if let Some(ref key) = api_key {
        if !key.is_empty() {
            store_api_key(&id, key)?;
        }
    }
    Ok(Provider {
        id,
        kind,
        name,
        base_url,
        has_api_key: Some(api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false)),
        is_default: false,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn update_provider(
    pool: tauri::State<'_, Arc<DbPool>>,
    id: String,
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    is_default: Option<bool>,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    if let Some(n) = name {
        conn.execute("UPDATE providers SET name = ?1 WHERE id = ?2", rusqlite::params![n, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(b) = base_url {
        conn.execute("UPDATE providers SET base_url = ?1 WHERE id = ?2", rusqlite::params![b, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(k) = api_key {
        if k.is_empty() {
            delete_api_key(&id)?;
        } else {
            store_api_key(&id, &k)?;
        }
    }
    if let Some(d) = is_default {
        if d {
            conn.execute("UPDATE providers SET is_default = 0", [])
                .map_err(|e| e.to_string())?;
            conn.execute("UPDATE providers SET is_default = 1 WHERE id = ?1", rusqlite::params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_provider(
    pool: tauri::State<'_, Arc<DbPool>>,
    id: String,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM providers WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    let _ = delete_api_key(&id);
    Ok(())
}

#[tauri::command]
pub async fn probe_provider(
    kind: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<ProbeResult, String> {
    crate::providers::probe(&kind, &base_url, api_key.as_deref()).await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProbeResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<DiscoveredModel>,
}

#[tauri::command]
pub async fn discover_local_servers() -> Result<Vec<DiscoveredServer>, String> {
    Ok(crate::providers::discovery::scan_localhost().await)
}

pub fn init_logger(app: &AppHandle) {
    let log_dir = crate::db::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("convo.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .ok();
    if let Some(file) = file {
        let (file, _guard) = tracing_appender::non_blocking(file);
        let subscriber = tracing_subscriber::fmt()
            .with_writer(file)
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,convo_lib=debug")),
            )
            .with_target(false)
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
    }
    let _ = app;
}

pub fn ensure_default_ollama_provider(pool: &DbPool) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM providers", [], |r| r.get(0))
        .unwrap_or(0);
    if count == 0 {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO providers (id, kind, name, base_url, is_default) VALUES (?1, 'ollama', 'Ollama (local)', 'http://localhost:11434', 1)",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_builtin_presets(pool: &DbPool) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM presets WHERE is_builtin = 1", [], |r| r.get(0))
        .unwrap_or(0);
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let presets: Vec<(&str, Option<&str>, Option<f64>, Option<f64>, Option<i64>, Option<i64>, Option<f64>)> = vec![
        ("Default", None, Some(0.7), Some(0.9), None, None, None),
        ("Concise", Some("Be concise. Skip pleasantries and preamble. Answer directly. Prefer short sentences and bullet points. If a longer response is required, lead with the conclusion."), Some(0.5), Some(0.9), None, None, None),
        ("Code", Some("You are an expert programmer. Prefer minimal, correct, idiomatic solutions. Explain non-obvious decisions briefly. Show code in fenced code blocks with the right language tag."), Some(0.2), Some(0.95), Some(40), None, None),
        ("Socratic", Some("Never answer directly. Respond only with questions — sharp, layered, Socratic. Expose contradictions. Make the person argue with themselves until the truth falls out. Use irony like a scalpel. Be genuinely curious, never condescending."), Some(0.9), Some(0.95), None, None, None),
        ("Pirate", Some("You are a salty pirate captain. Speak in rough nautical vernacular. Arrr, matey. Keep it fun and useful at the same time."), Some(0.9), Some(0.9), None, None, None),
    ];
    for (name, prompt, temp, top_p, top_k, _num_ctx, _rp) in presets {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO presets (id, name, system_prompt, temperature, top_p, top_k, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
            rusqlite::params![id, name, prompt, temp, top_p, top_k, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_builtin_themes() -> Result<(), String> {
    use crate::themes::builtin_themes;
    use std::sync::Arc;
    let pool: Option<Arc<crate::db::DbPool>> = crate::state::get_pool_static();
    if let Some(pool) = pool {
        let conn: r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager> =
            pool.get().map_err(|e: r2d2::Error| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM themes WHERE is_builtin = 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339();
        for t in builtin_themes() {
            conn.execute(
                "INSERT INTO themes (id, name, is_builtin, tokens_json, created_at)
                 VALUES (?1, ?2, 1, ?3, ?4)",
                rusqlite::params![t.id, t.name, t.tokens_json, now],
            )
            .map_err(|e: rusqlite::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub db_path: String,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: crate::db::data_dir().to_string_lossy().to_string(),
        db_path: crate::db::db_path().to_string_lossy().to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn open_data_dir() -> Result<String, String> {
    Ok(crate::db::data_dir().to_string_lossy().to_string())
}

pub fn _unused_placeholder() -> HashMap<String, String> {
    HashMap::new()
}

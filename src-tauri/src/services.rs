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

pub fn migrate_search_api_key(pool: &DbPool) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let legacy: Option<String> = conn
        .query_row(
            "SELECT api_key FROM search_config WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(key) = legacy.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    store_api_key("search", &key)?;
    conn.execute("UPDATE search_config SET api_key = NULL WHERE id = 1", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO search_keyring_migration (id, migrated_at) VALUES (1, ?1)",
        rusqlite::params![chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
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
    if !matches!(kind.as_str(), "ollama" | "openai_compat") {
        return Err(format!("Unsupported provider kind: {}", kind));
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Provider name cannot be empty".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let conn = pool.get().map_err(|e| e.to_string())?;
    if provider_url_exists(&conn, &kind, base_url.as_deref(), None)? {
        return Err("A provider with this kind and URL already exists".into());
    }
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
    let existing_kind: String = conn
        .query_row(
            "SELECT kind FROM providers WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Provider lookup: {}", e))?;
    if let Some(ref b) = base_url {
        if provider_url_exists(&conn, &existing_kind, Some(b), Some(&id))? {
            return Err("A provider with this kind and URL already exists".into());
        }
    }
    if let Some(n) = name {
        conn.execute(
            "UPDATE providers SET name = ?1 WHERE id = ?2",
            rusqlite::params![n, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(b) = base_url {
        conn.execute(
            "UPDATE providers SET base_url = ?1 WHERE id = ?2",
            rusqlite::params![b, id],
        )
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
            conn.execute(
                "UPDATE providers SET is_default = 1 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn provider_url_exists(
    conn: &rusqlite::Connection,
    kind: &str,
    base_url: Option<&str>,
    except_id: Option<&str>,
) -> Result<bool, String> {
    let Some(base_url) = base_url.map(str::trim).filter(|url| !url.is_empty()) else {
        return Ok(false);
    };
    let count: i64 = if let Some(id) = except_id {
        conn.query_row(
            "SELECT COUNT(*) FROM providers WHERE kind = ?1 AND base_url = ?2 AND id <> ?3",
            rusqlite::params![kind, base_url, id],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM providers WHERE kind = ?1 AND base_url = ?2",
            rusqlite::params![kind, base_url],
            |row| row.get(0),
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(count > 0)
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

#[cfg(test)]
mod tests {
    use super::provider_url_exists;
    use rusqlite::Connection;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, base_url TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn duplicate_provider_urls_are_rejected_per_kind() {
        let conn = connection();
        conn.execute(
            "INSERT INTO providers VALUES ('p1', 'ollama', 'http://localhost:11434')",
            [],
        )
        .unwrap();
        assert!(
            provider_url_exists(&conn, "ollama", Some("http://localhost:11434"), None).unwrap()
        );
        assert!(
            !provider_url_exists(&conn, "openai_compat", Some("http://localhost:11434"), None)
                .unwrap()
        );
        assert!(
            !provider_url_exists(&conn, "ollama", Some("http://localhost:11434"), Some("p1"))
                .unwrap()
        );
    }
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

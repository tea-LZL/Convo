use crate::db::DbPool;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_setting(pool: State<'_, Arc<DbPool>>, key: String) -> Result<Option<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    Ok(v)
}

#[tauri::command]
pub fn set_setting(pool: State<'_, Arc<DbPool>>, key: String, value: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_all_settings(pool: State<'_, Arc<DbPool>>) -> Result<Vec<(String, String)>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DiagnosticLogEvent {
    pub operation: String,
    pub status: String,
    pub route: Option<String>,
    #[serde(rename = "providerKind")]
    pub provider_kind: Option<String>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<i64>,
    #[serde(rename = "errorClass")]
    pub error_class: Option<String>,
}

type ProviderRow = (String, String, String, bool, Option<String>);

fn sanitize_log_field(value: Option<String>, max_len: usize) -> Option<String> {
    let value = value?;
    let clean: String = value
        .chars()
        .filter(|c| !c.is_control())
        .take(max_len)
        .collect();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

#[tauri::command]
pub fn append_log_event(event: DiagnosticLogEvent) -> Result<(), String> {
    let status = match event.status.as_str() {
        "started" | "succeeded" | "failed" | "cancelled" => event.status,
        _ => return Err("invalid diagnostic log status".to_string()),
    };
    let operation = sanitize_log_field(Some(event.operation), 80)
        .ok_or_else(|| "diagnostic log operation cannot be empty".to_string())?;
    let safe = DiagnosticLogEvent {
        operation,
        status,
        route: sanitize_log_field(event.route, 120),
        provider_kind: sanitize_log_field(event.provider_kind, 40),
        duration_ms: event.duration_ms.map(|value| value.clamp(0, 86_400_000)),
        error_class: sanitize_log_field(event.error_class, 80),
    };
    let logs_dir = crate::db::data_dir().join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("convo.log"))
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&safe).map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagnosticsReport {
    pub app: AppInfo,
    pub db: DbStats,
    pub providers: Vec<ProviderStatus>,
    pub counts: Counts,
    pub storage: StorageStats,
    pub recent_logs: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub db_path: String,
    pub os: String,
    pub arch: String,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DbStats {
    pub ok: bool,
    pub size_bytes: u64,
    pub wal_size_bytes: u64,
    pub schema_version: i64,
    pub tables: Vec<(String, i64)>,
    pub page_count: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub is_default: bool,
    pub has_api_key: bool,
    pub model_count: i64,
    pub last_seen: Option<String>,
    pub reachable: Option<bool>,
    pub reachable_msg: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Counts {
    pub sessions: i64,
    pub messages: i64,
    pub notes: i64,
    pub tasks: i64,
    pub documents: i64,
    pub memory_items: i64,
    pub enabled_memory: i64,
    pub compare_runs: i64,
    pub attachments: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct StorageStats {
    pub blobs_bytes: u64,
    pub logs_bytes: u64,
    pub themes_bytes: u64,
}

#[tauri::command]
pub async fn get_diagnostics(pool: State<'_, Arc<DbPool>>) -> Result<DiagnosticsReport, String> {
    let app = AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: crate::db::data_dir().to_string_lossy().to_string(),
        db_path: crate::db::db_path().to_string_lossy().to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        uptime_secs: 0, // placeholder; could track process start
    };

    // DB stats
    let db = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let size = std::fs::metadata(crate::db::db_path())
            .map(|m| m.len())
            .unwrap_or(0);
        let wal_path = crate::db::db_path().with_extension("db-wal");
        let wal = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(0);
        let schema_version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap_or_else(|e| format!("error: {}", e));

        let table_names = vec![
            "providers",
            "models",
            "sessions",
            "session_groups",
            "messages",
            "message_branches",
            "attachments",
            "documents",
            "notes",
            "tasks",
            "memory_items",
            "search_config",
            "settings",
            "themes",
            "compare_runs",
            "slash_commands",
            "session_overrides",
        ];
        let mut tables: Vec<(String, i64)> = Vec::new();
        for t in table_names {
            let count: rusqlite::Result<i64> =
                conn.query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0));
            if let Ok(n) = count {
                tables.push((t.to_string(), n));
            }
        }
        DbStats {
            ok: integrity == "ok",
            size_bytes: size,
            wal_size_bytes: wal,
            schema_version,
            tables,
            page_count,
            page_size,
        }
    };

    // Counts
    let counts = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let count = |t: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0))
                .unwrap_or(0)
        };
        Counts {
            sessions: count("sessions"),
            messages: count("messages"),
            notes: count("notes"),
            tasks: count("tasks"),
            documents: count("documents"),
            memory_items: count("memory_items"),
            enabled_memory: conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_items WHERE is_enabled = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0),
            compare_runs: count("compare_runs"),
            attachments: count("attachments"),
        }
    };

    // Provider statuses — collect rows first (tight scope), then probe (async)
    let provider_rows: Vec<ProviderRow> = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, kind, is_default, base_url FROM providers")
            .map_err(|e| e.to_string())?;
        let rows: Result<Vec<ProviderRow>, rusqlite::Error> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get::<_, i64>(3)? != 0,
                    r.get(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect();
        rows.map_err(|e| e.to_string())?
    };

    // Per-provider model counts and last-seen (also tight scope)
    struct ProviderMeta {
        model_count: i64,
        last_seen: Option<String>,
    }
    let mut provider_metas: std::collections::HashMap<String, ProviderMeta> =
        std::collections::HashMap::new();
    {
        let conn = pool.get().map_err(|e| e.to_string())?;
        for (id, _, _, _, _) in &provider_rows {
            let model_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM models WHERE provider_id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let last_seen: Option<String> = conn
                .query_row(
                    "SELECT MAX(last_seen) FROM models WHERE provider_id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            provider_metas.insert(
                id.clone(),
                ProviderMeta {
                    model_count,
                    last_seen,
                },
            );
        }
    }

    // Now probe each provider (no DB connection held during awaits)
    let mut providers: Vec<ProviderStatus> = Vec::new();
    for (id, name, kind, is_default, base_url) in provider_rows {
        let meta = provider_metas.remove(&id).unwrap_or(ProviderMeta {
            model_count: 0,
            last_seen: None,
        });
        let has_api_key = crate::services::get_api_key(&id).is_some();
        let (reachable, reachable_msg) = if let Some(url) = base_url {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(800))
                .build()
                .ok();
            if let Some(client) = client {
                let probe_url = if kind == "ollama" {
                    format!("{}/api/tags", url.trim_end_matches('/'))
                } else {
                    format!("{}/v1/models", url.trim_end_matches('/'))
                };
                match client.get(&probe_url).send().await {
                    Ok(r) if r.status().is_success() => {
                        (Some(true), Some(format!("{} OK", r.status().as_u16())))
                    }
                    Ok(r) => (Some(false), Some(format!("HTTP {}", r.status().as_u16()))),
                    Err(e) => (Some(false), Some(e.to_string())),
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        providers.push(ProviderStatus {
            id,
            name,
            kind,
            is_default,
            has_api_key,
            model_count: meta.model_count,
            last_seen: meta.last_seen,
            reachable,
            reachable_msg,
        });
    }

    // Storage stats
    let blobs_dir = crate::db::data_dir().join("blobs");
    let logs_dir = crate::db::data_dir().join("logs");
    let themes_dir = crate::db::data_dir().join("themes");
    fn dir_size(path: &std::path::Path) -> u64 {
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(path) {
            for entry in rd.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        total += meta.len();
                    } else if meta.is_dir() {
                        total += dir_size(&entry.path());
                    }
                }
            }
        }
        total
    }
    let storage = StorageStats {
        blobs_bytes: dir_size(&blobs_dir),
        logs_bytes: dir_size(&logs_dir),
        themes_bytes: dir_size(&themes_dir),
    };

    // Recent log lines (last 200 from the tail of convo.log)
    let recent_logs: Vec<String> = {
        let log_path = logs_dir.join("convo.log");
        if let Ok(data) = std::fs::read_to_string(&log_path) {
            let lines: Vec<&str> = data.lines().rev().take(200).collect();
            lines.into_iter().rev().map(|s| s.to_string()).collect()
        } else {
            vec![]
        }
    };

    Ok(DiagnosticsReport {
        app,
        db,
        providers,
        counts,
        storage,
        recent_logs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_fields_strip_control_characters_and_bound_length() {
        let value = sanitize_log_field(Some("route\nwith\rnoise".to_string()), 20);
        assert_eq!(value.as_deref(), Some("routewithnoise"));

        let value = sanitize_log_field(Some("abcdef".to_string()), 3);
        assert_eq!(value.as_deref(), Some("abc"));
    }

    #[test]
    fn diagnostic_log_rejects_unknown_status_before_writing() {
        let result = append_log_event(DiagnosticLogEvent {
            operation: "test".to_string(),
            status: "unknown".to_string(),
            route: None,
            provider_kind: None,
            duration_ms: None,
            error_class: None,
        });
        assert_eq!(result, Err("invalid diagnostic log status".to_string()));
    }
}

use crate::db::DbPool;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn export_backup(pool: State<'_, Arc<DbPool>>, dest_path: String) -> Result<String, String> {
    use std::io::Write;
    use zip::write::FileOptions;
    let zip_path = std::path::PathBuf::from(&dest_path);
    let file =
        std::fs::File::create(&zip_path).map_err(|e| format!("Create {}: {}", dest_path, e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions<'_, ()> = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let data_dir = crate::db::data_dir();

    // 1) The DB file
    let db_path = crate::db::db_path();
    if db_path.exists() {
        zip.start_file("convo.db", opts)
            .map_err(|e| e.to_string())?;
        let mut f = std::fs::File::open(&db_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
    }

    // 2) Blobs (attachments)
    let blobs_dir = data_dir.join("blobs");
    if blobs_dir.exists() {
        for entry in std::fs::read_dir(&blobs_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let name = path
                    .strip_prefix(&blobs_dir)
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                zip.start_file(format!("blobs/{}", name), opts)
                    .map_err(|e| e.to_string())?;
                let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            } else if path.is_dir() {
                for sub in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                    let sub = sub.map_err(|e| e.to_string())?;
                    let sub_path = sub.path();
                    if sub_path.is_file() {
                        let rel = sub_path
                            .strip_prefix(&blobs_dir)
                            .unwrap()
                            .to_string_lossy()
                            .to_string();
                        zip.start_file(format!("blobs/{}", rel), opts)
                            .map_err(|e| e.to_string())?;
                        let mut f = std::fs::File::open(&sub_path).map_err(|e| e.to_string())?;
                        std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    // 3) Themes (custom)
    let themes_dir = data_dir.join("themes");
    if themes_dir.exists() {
        for entry in std::fs::read_dir(&themes_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                zip.start_file(format!("themes/{}", name), opts)
                    .map_err(|e| e.to_string())?;
                let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            }
        }
    }

    // 4) Manifest
    let manifest = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "kind": "convo-backup",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "os": std::env::consts::OS,
    });
    zip.start_file("manifest.json", opts)
        .map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    let _ = pool; // not used; included for symmetry / future use
    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_backup(_pool: State<'_, Arc<DbPool>>, src_path: String) -> Result<String, String> {
    let data_dir = crate::db::data_dir();
    let staging = data_dir.join(format!(".restore-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        validate_archive(&src_path)?;
        extract_archive(&src_path, &staging)?;
        let staged_db = staging.join("convo.db");
        if !staged_db.is_file() {
            return Err("Backup does not contain convo.db".into());
        }

        // Keep a rollback copy before replacing the live database. The app
        // restarts after import, so the open connection is never reused.
        let rollback = data_dir.join(format!("convo.db.pre-restore-{}", Uuid::new_v4()));
        let live_db = data_dir.join("convo.db");
        if live_db.is_file() {
            std::fs::copy(&live_db, &rollback)
                .map_err(|e| format!("Create rollback backup: {}", e))?;
            std::fs::rename(&live_db, live_db.with_extension("db.restore-old"))
                .map_err(|e| format!("Stage current database: {}", e))?;
        }
        if let Err(error) = std::fs::rename(&staged_db, &live_db) {
            let old = live_db.with_extension("db.restore-old");
            if old.is_file() {
                let _ = std::fs::rename(old, &live_db);
            }
            return Err(format!("Install restored database: {}", error));
        }
        copy_tree_if_present(&staging.join("blobs"), &data_dir.join("blobs"))?;
        copy_tree_if_present(&staging.join("themes"), &data_dir.join("themes"))?;
        let _ = std::fs::remove_file(live_db.with_extension("db.restore-old"));
        let _ = std::fs::remove_dir_all(&staging);
        Ok(format!(
            "Imported. Rollback copy: {}. Restart Convo for the changes to take effect.",
            rollback.display()
        ))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn safe_archive_path(name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if path.is_absolute() || name.is_empty() {
        return Err(format!("Unsafe backup path: {}", name));
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("Unsafe backup path: {}", name));
        }
    }
    Ok(path.to_path_buf())
}

fn validate_archive(src_path: &str) -> Result<(), String> {
    let file = std::fs::File::open(src_path).map_err(|e| format!("Open {}: {}", src_path, e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut manifest = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        safe_archive_path(entry.name())?;
        if entry.name() == "manifest.json" {
            let mut body = String::new();
            std::io::Read::read_to_string(&mut entry, &mut body).map_err(|e| e.to_string())?;
            manifest = Some(body);
        }
    }
    let manifest = manifest.ok_or_else(|| "Backup is missing manifest.json".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("Invalid manifest: {}", e))?;
    if value.get("kind").and_then(|v| v.as_str()) != Some("convo-backup") {
        return Err("Not a Convo backup".into());
    }
    Ok(())
}

fn extract_archive(src_path: &str, destination: &Path) -> Result<(), String> {
    let file = std::fs::File::open(src_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let relative = safe_archive_path(entry.name())?;
        if entry.name().ends_with('/') {
            continue;
        }
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_tree_if_present(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree_if_present(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_archive_path;

    #[test]
    fn rejects_archive_path_traversal() {
        assert!(safe_archive_path("blobs/session/file.bin").is_ok());
        assert!(safe_archive_path("../convo.db").is_err());
        assert!(safe_archive_path("/tmp/convo.db").is_err());
    }
}

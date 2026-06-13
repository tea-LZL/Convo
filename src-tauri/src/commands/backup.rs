use crate::db::DbPool;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn export_backup(pool: State<'_, Arc<DbPool>>, dest_path: String) -> Result<String, String> {
    use std::io::Write;
    use zip::write::FileOptions;
    let zip_path = std::path::PathBuf::from(&dest_path);
    let file = std::fs::File::create(&zip_path).map_err(|e| format!("Create {}: {}", dest_path, e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions<'_, ()> = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let data_dir = crate::db::data_dir();

    // 1) The DB file
    let db_path = crate::db::db_path();
    if db_path.exists() {
        zip.start_file("convo.db", opts).map_err(|e| e.to_string())?;
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
                let name = path.strip_prefix(&blobs_dir).unwrap().to_string_lossy().to_string();
                zip.start_file(format!("blobs/{}", name), opts).map_err(|e| e.to_string())?;
                let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            } else if path.is_dir() {
                for sub in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                    let sub = sub.map_err(|e| e.to_string())?;
                    let sub_path = sub.path();
                    if sub_path.is_file() {
                        let rel = sub_path.strip_prefix(&blobs_dir).unwrap().to_string_lossy().to_string();
                        zip.start_file(format!("blobs/{}", rel), opts).map_err(|e| e.to_string())?;
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
                zip.start_file(format!("themes/{}", name), opts).map_err(|e| e.to_string())?;
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
    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    let _ = pool; // not used; included for symmetry / future use
    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_backup(_pool: State<'_, Arc<DbPool>>, src_path: String) -> Result<String, String> {
    let f = std::fs::File::open(&src_path).map_err(|e| format!("Open {}: {}", src_path, e))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let data_dir = crate::db::data_dir();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.ends_with('/') { continue; }
        let target = data_dir.join(&name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok("Imported. Restart Convo for the changes to take effect.".to_string())
}

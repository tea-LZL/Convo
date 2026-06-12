use crate::db::models::Attachment;
use base64::Engine;
use rusqlite::params;
use sanitize_filename::sanitize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn kind_for(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("audio/") {
        "audio"
    } else {
        "document"
    }
}

#[tauri::command]
pub fn add_attachment(
    pool: State<'_, Arc<DbPool>>,
    name: String,
    mime: String,
    data_base64: String,
    session_id: Option<String>,
    message_id: Option<String>,
) -> Result<Attachment, String> {
    let id = Uuid::new_v4().to_string();
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Base64: {}", e))?;
    let size = data.len() as i64;
    let blob_dir = crate::db::data_dir().join("blobs");
    std::fs::create_dir_all(&blob_dir).map_err(|e| e.to_string())?;
    let safe_name = sanitize(&name);
    let blob_path = format!("{}/{}", id, safe_name);
    let full = blob_dir.join(&blob_path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, &data).map_err(|e| e.to_string())?;

    let (width, height) = if mime.starts_with("image/") {
        image_dimensions(&data).unwrap_or((None, None))
    } else {
        (None, None)
    };

    let extracted_text = if mime == "application/pdf" || mime.starts_with("text/") {
        if mime.starts_with("text/") {
            String::from_utf8(data.clone()).ok()
        } else {
            None // PDF text extraction can be added later via a crate
        }
    } else {
        None
    };

    let kind = kind_for(&mime);
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO attachments (id, session_id, message_id, name, mime, size, kind, blob_path, width, height, extracted_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![id, session_id, message_id, name, mime, size, kind, blob_path, width, height, extracted_text, now()],
    )
    .map_err(|e| e.to_string())?;

    Ok(Attachment {
        id,
        session_id,
        message_id,
        name,
        mime,
        size,
        kind: kind.to_string(),
        blob_path: Some(blob_path),
        width,
        height,
        extracted_text,
        created_at: now(),
    })
}

#[tauri::command]
pub fn get_attachment_data(
    pool: State<'_, Arc<DbPool>>,
    id: String,
) -> Result<String, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let blob_path: Option<String> = conn
        .query_row(
            "SELECT blob_path FROM attachments WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let Some(rel) = blob_path else {
        return Err("Attachment has no blob".into());
    };
    let full = crate::db::data_dir().join("blobs").join(&rel);
    let bytes = std::fs::read(&full).map_err(|e| format!("Read blob: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn delete_attachment(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let blob_path: Option<String> = conn
        .query_row("SELECT blob_path FROM attachments WHERE id = ?1", params![id], |r| r.get(0))
        .ok();
    conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(rel) = blob_path {
        let full = crate::db::data_dir().join("blobs").join(&rel);
        let _ = std::fs::remove_file(full);
    }
    Ok(())
}

fn image_dimensions(data: &[u8]) -> Option<(Option<i64>, Option<i64>)> {
    // Minimal PNG / JPEG / GIF header sniff
    if data.len() < 24 {
        return None;
    }
    if &data[..8] == b"\x89PNG\r\n\x1a\n" {
        let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]) as i64;
        let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]) as i64;
        return Some((Some(w), Some(h)));
    }
    if &data[..2] == b"\xff\xd8" {
        // walk JPEG markers
        let mut i = 2;
        while i < data.len() {
            if data[i] != 0xff {
                return None;
            }
            while i < data.len() && data[i] == 0xff {
                i += 1;
            }
            if i >= data.len() {
                return None;
            }
            let marker = data[i];
            i += 1;
            if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
                if i + 5 < data.len() {
                    let h = u16::from_be_bytes([data[i + 3], data[i + 4]]) as i64;
                    let w = u16::from_be_bytes([data[i + 5], data[i + 6]]) as i64;
                    return Some((Some(w), Some(h)));
                }
                return None;
            } else {
                if i + 1 >= data.len() {
                    return None;
                }
                let seg_len = u16::from_be_bytes([data[i], data[i + 1]]) as usize;
                i += seg_len;
            }
        }
    }
    if &data[..6] == b"GIF87a" || &data[..6] == b"GIF89a" {
        let w = u16::from_le_bytes([data[6], data[7]]) as i64;
        let h = u16::from_le_bytes([data[8], data[9]]) as i64;
        return Some((Some(w), Some(h)));
    }
    None
}

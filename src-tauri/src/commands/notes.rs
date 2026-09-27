use crate::db::models::{Note, NoteLink, NoteWithLinks};
use rusqlite::{params, Connection};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_notes(pool: State<'_, Arc<DbPool>>) -> Result<Vec<NoteWithLinks>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let notes = all_notes(&conn)?;
    let mut with_links = Vec::with_capacity(notes.len());
    for note in notes {
        let linked_memories = memories_for_note(&conn, &note.id)?;
        with_links.push(NoteWithLinks {
            note,
            linked_memories,
        });
    }
    Ok(with_links)
}

/// Every note, newest first, without provenance. The note rows are the same
/// for `list_notes` and `search_notes`; only the former attaches links.
fn all_notes(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title, body, tags, source_session_id, source_message_id, created_at, updated_at, pinned FROM notes ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                tags: row.get(3)?,
                source_session_id: row.get(4)?,
                source_message_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                pinned: row.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_note(pool: State<'_, Arc<DbPool>>, note: NoteInput) -> Result<String, String> {
    validate_note(&note)?;
    let is_update = note.id.is_some();
    let id = note
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        // `pinned` is deliberately absent from this UPDATE. The editor saves
        // the whole note, so writing the input's `pinned` back would silently
        // unpin a note the user pinned elsewhere. Pin and unpin are
        // `set_note_pinned`'s job, on purpose.
        conn.execute(
            "UPDATE notes SET title = ?1, body = ?2, tags = ?3, source_session_id = ?4, source_message_id = ?5, updated_at = ?6 WHERE id = ?7",
            params![note.title, note.body, note.tags, note.source_session_id, note.source_message_id, now(), id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let ts = now();
        conn.execute(
            "INSERT INTO notes (id, title, body, tags, source_session_id, source_message_id, created_at, updated_at, pinned) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![id, note.title, note.body, note.tags, note.source_session_id, note.source_message_id, ts, if note.pinned { 1 } else { 0 }],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

/// Set or clear a note's pin. A pinned note is injected on every send,
/// budget permitting, regardless of what retrieval ranks.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE notes
         SET pinned = ?2,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![id, if pinned { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The memories a note produced, newest first.
///
/// Derived from `memory_items.source_note_id` rather than a denormalised
/// list on the note, so deleting a memory cannot leave a dangling id on
/// the note that claims it. Superseded rows are included: the note
/// produced them and the correction history stays readable.
pub fn memories_for_note(conn: &Connection, note_id: &str) -> Result<Vec<NoteLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, is_enabled, superseded_by
             FROM memory_items
             WHERE source_note_id = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            Ok(NoteLink {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                is_enabled: row.get::<_, i64>(3)? != 0,
                superseded_by: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Clear a memory's source note. The note side needs no update because it
/// never stored a list. The memory survives: unlinking is a claim about
/// origin, not a delete.
pub fn unlink(conn: &Connection, memory_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE memory_items
         SET source_note_id = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![memory_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_note_pinned(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    set_pinned(&conn, &id, pinned)
}

#[tauri::command]
pub fn unlink_memory_from_note(
    pool: State<'_, Arc<DbPool>>,
    note_id: String,
    memory_id: String,
) -> Result<(), String> {
    // `note_id` is the note the caller believed the memory belonged to.
    // Provenance is a single column, so the memory is detached from it
    // whatever that belief was; nothing to clean up on the note side.
    let _ = note_id;
    let conn = pool.get().map_err(|e| e.to_string())?;
    unlink(&conn, &memory_id)
}

fn validate_note(note: &NoteInput) -> Result<(), String> {
    if note.body.len() > 2_000_000 {
        return Err("Note body is too large".into());
    }
    if note.title.as_deref().map(str::len).unwrap_or(0) > 500 {
        return Err("Note title is too long".into());
    }
    if note.tags.as_deref().map(str::len).unwrap_or(0) > 1_000 {
        return Err("Note tags are too long".into());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_note(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Search returns plain notes, not `NoteWithLinks`: a search result list is
/// for finding the note, and the links arrive with `list_notes` once one is
/// open. The empty query still means "everything", as it did before.
#[tauri::command]
pub fn search_notes(pool: State<'_, Arc<DbPool>>, query: String) -> Result<Vec<Note>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    if query.trim().is_empty() {
        return all_notes(&conn);
    }
    let q = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, tags, source_session_id, source_message_id, created_at, updated_at, pinned
             FROM notes
             WHERE LOWER(IFNULL(title, '')) LIKE ?1
                OR LOWER(body) LIKE ?1
                OR LOWER(IFNULL(tags, '')) LIKE ?1
             ORDER BY updated_at DESC
             LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![q], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                tags: row.get(3)?,
                source_session_id: row.get(4)?,
                source_message_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                pinned: row.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The note the editor sends. `pinned` is honoured on create and ignored on
/// update — see `upsert_note` — and defaults to false when a caller omits it,
/// which is also the column default.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub tags: Option<String>,
    pub source_session_id: Option<String>,
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[cfg(test)]
mod tests {
    use super::{validate_note, NoteInput};

    #[test]
    fn validates_note_sizes_without_rejecting_empty_drafts() {
        assert!(validate_note(&NoteInput {
            id: None,
            title: None,
            body: String::new(),
            tags: None,
            source_session_id: None,
            source_message_id: None,
            pinned: false,
        })
        .is_ok());
        assert!(validate_note(&NoteInput {
            id: None,
            title: Some("x".repeat(501)),
            body: String::new(),
            tags: None,
            source_session_id: None,
            source_message_id: None,
            pinned: false,
        })
        .is_err());
    }
}

use crate::db::models::{Note, NoteLink, NoteTitle, NoteWithLinks};
use rusqlite::{params, Connection};
use std::collections::HashMap;
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
///
/// `pub` so a test can pin the positional `row.get` chain: a column dropped
/// from the SELECT keeps indices 0-7 valid and a reordered one reads the
/// wrong field silently, so the read path needs coverage, not just the
/// writes.
pub fn all_notes(conn: &Connection) -> Result<Vec<Note>, String> {
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
pub fn list_note_titles(pool: State<'_, Arc<DbPool>>) -> Result<Vec<NoteTitle>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    all_note_titles(&conn)
}

/// Every note's id and title, and the memories each produced, newest first —
/// the same notes and the same order as `all_notes`, without their bodies.
///
/// The body is the expensive column and no caller of this one wants it: it is
/// a free-text textarea, so a single pasted document is megabytes, and the
/// Memory tab asks for this on every refresh including the one after every
/// pin click. The notes stay in the database.
///
/// The `LEFT JOIN` is why the row is a note with a list rather than a memory
/// with a title: the link lives on `memory_items.source_note_id`, and this is
/// the one query that can answer "which note did this memory come from"
/// without that column being read out of every memory. Rows are folded by
/// note id through a `HashMap` rather than by comparing neighbours, so a note
/// with no memories, or one whose memories interleave with another's in the
/// sort, is still one entry.
pub fn all_note_titles(conn: &Connection) -> Result<Vec<NoteTitle>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, m.id
             FROM notes n
             LEFT JOIN memory_items m ON m.source_note_id = n.id
             ORDER BY n.updated_at DESC, m.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut titles: Vec<NoteTitle> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let (id, title, memory_id) = row.map_err(|e| e.to_string())?;
        let slot = *at.entry(id.clone()).or_insert_with(|| {
            titles.push(NoteTitle {
                id: id.clone(),
                title,
                memory_ids: Vec::new(),
            });
            titles.len() - 1
        });
        if let Some(memory_id) = memory_id {
            titles[slot].memory_ids.push(memory_id);
        }
    }
    Ok(titles)
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
///
/// A pin on a note that is not there is an error, not a no-op: `UPDATE`
/// reports zero rows for an id that does not exist, and returning `Ok(())`
/// for that is how a pin looks set when it never was.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE notes
             SET pinned = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![id, if pinned { 1 } else { 0 }],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no note with id {id}"));
    }
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
///
/// Scoped to `note_id` as well as `memory_id`. Provenance is one column, so
/// an unscoped `UPDATE` would happily detach a memory that belongs to some
/// other note than the one the caller named — a silent edit to a claim the
/// caller never made. A mismatch, and a memory that does not exist, both
/// match zero rows and come back as an error.
pub fn unlink(conn: &Connection, note_id: &str, memory_id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE memory_items
             SET source_note_id = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND source_note_id = ?2",
            params![memory_id, note_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!(
            "memory {memory_id} is not linked to note {note_id}"
        ));
    }
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
    // The note id is verified, not merely accepted: `unlink` matches it, so
    // naming the wrong note fails instead of detaching provenance the
    // caller did not mean to touch.
    let conn = pool.get().map_err(|e| e.to_string())?;
    unlink(&conn, &note_id, &memory_id)
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
    search(&conn, &query)
}

/// The query behind `search_notes`, over `&Connection` so its positional
/// `row.get` chain is testable. The empty query means "everything", the same
/// short-circuit it has always had.
pub fn search(conn: &Connection, query: &str) -> Result<Vec<Note>, String> {
    if query.trim().is_empty() {
        return all_notes(conn);
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
    use super::{all_note_titles, validate_note, NoteInput};
    use rusqlite::params;

    /// Only the columns this projection reads, plus the `body` it must not
    /// read. A `body` in the schema and a `body` in the payload are the two
    /// halves of the same claim: the column exists, and nothing crosses the
    /// boundary carrying it.
    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY,
               title TEXT,
               body TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE memory_items (
               id TEXT PRIMARY KEY,
               source_note_id TEXT,
               updated_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn add_note(conn: &rusqlite::Connection, id: &str, title: Option<&str>, updated_at: &str) {
        conn.execute(
            "INSERT INTO notes (id, title, body, updated_at) VALUES (?1, ?2, '', ?3)",
            params![id, title, updated_at],
        )
        .unwrap();
    }

    fn link(conn: &rusqlite::Connection, memory_id: &str, note_id: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO memory_items (id, source_note_id, updated_at) VALUES (?1, ?2, ?3)",
            params![memory_id, note_id, updated_at],
        )
        .unwrap();
    }

    /// One entry per note, newest first, with the memories it produced and
    /// the memories of the other notes kept to their own note. A note with
    /// no memories is still listed: the caller draws the list, not the
    /// links.
    #[test]
    fn the_title_projection_is_every_note_newest_first_with_its_own_memories() {
        let conn = db();
        add_note(
            &conn,
            "old",
            Some("Old runbook"),
            "2026-01-01T00:00:00.000Z",
        );
        add_note(&conn, "new", None, "2026-01-03T00:00:00.000Z");
        add_note(
            &conn,
            "mid",
            Some("Deploy notes"),
            "2026-01-02T00:00:00.000Z",
        );
        link(&conn, "m-1", "old", "2026-01-01T00:00:01.000Z");
        link(&conn, "m-2", "mid", "2026-01-02T00:00:01.000Z");
        link(&conn, "m-3", "mid", "2026-01-02T00:00:02.000Z");

        let titles = all_note_titles(&conn).unwrap();

        let ids: Vec<&str> = titles.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["new", "mid", "old"], "same order as list_notes");
        assert_eq!(titles[0].title, None, "an untitled note is a real row");
        assert_eq!(titles[1].title.as_deref(), Some("Deploy notes"));
        assert_eq!(titles[1].memory_ids, ["m-3", "m-2"]);
        assert_eq!(titles[2].memory_ids, ["m-1"]);
        assert!(
            titles[0].memory_ids.is_empty(),
            "a note that produced nothing carries no memory ids"
        );
    }

    /// The reason this command exists. A body is free text, so one pasted
    /// document is megabytes, and the caller reads two short strings out of
    /// the row. The payload must not grow with the body.
    #[test]
    fn the_title_projection_leaves_note_bodies_in_the_database() {
        let conn = db();
        let marker = "BODY-MARKER".repeat(190_000);
        assert!(
            marker.len() > 2_000_000,
            "the fixture has to be a body size that is worth not sending"
        );
        conn.execute(
            "INSERT INTO notes (id, title, body, updated_at) VALUES ('n1','Runbook',?1,'2026-01-01T00:00:00.000Z')",
            params![&marker],
        )
        .unwrap();
        link(&conn, "m-1", "n1", "2026-01-01T00:00:01.000Z");

        let titles = all_note_titles(&conn).unwrap();
        assert_eq!(titles[0].title.as_deref(), Some("Runbook"));
        assert_eq!(titles[0].memory_ids, ["m-1"]);

        let payload = serde_json::to_string(&titles).unwrap();
        assert!(
            !payload.contains("BODY-MARKER"),
            "a 2MB body crossed the projection: {} bytes",
            payload.len()
        );
        assert!(
            !payload.contains("body"),
            "the projection grew a body field: {payload}"
        );
        // A generous bound on two ids, a title and one link: the point is
        // that it is orders of magnitude below the body, not the exact size.
        assert!(
            payload.len() < 512,
            "the projection is {} bytes for a 2MB body",
            payload.len()
        );
        // Nothing was moved or truncated: the body is still the note's, and
        // this read simply did not carry it.
        let stored: i64 = conn
            .query_row(
                "SELECT LENGTH(body) FROM notes WHERE id = 'n1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored as usize,
            marker.len(),
            "the body is still in the database; the projection only left it there"
        );
    }

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

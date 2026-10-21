use crate::db::models::{Note, NoteLink, NoteTitle, NoteWithLinks};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    // Millisecond precision and a trailing `Z`, the same shape as the
    // column defaults and the `strftime('%fZ')` writes in this file. The
    // list sorts `updated_at` as text, so two spellings of the same
    // instant can sort against each other incorrectly.
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
    let conn = pool.get().map_err(|e| e.to_string())?;
    upsert(&conn, note)
}

/// The write behind `upsert_note`, over `&Connection` so its two arms are
/// testable.
///
/// The UPDATE arm checks `rows_affected`. A note deleted in another window
/// (or by the agent) matches zero rows, and returning the id for that
/// reports a save that did not happen.
pub fn upsert(conn: &Connection, note: NoteInput) -> Result<String, String> {
    validate_note(&note)?;
    let is_update = note.id.is_some();
    let id = note
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if is_update {
        // `pinned` is deliberately absent from this UPDATE. The editor saves
        // the whole note, so writing the input's `pinned` back would silently
        // unpin a note the user pinned elsewhere. Pin and unpin are
        // `set_note_pinned`'s job, on purpose.
        let changed = conn
            .execute(
                "UPDATE notes SET title = ?1, body = ?2, tags = ?3, source_session_id = ?4, source_message_id = ?5, updated_at = ?6 WHERE id = ?7",
                params![note.title, note.body, note.tags, note.source_session_id, note.source_message_id, now(), id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("no note with id {id}"));
        }
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
/// `updated_at` is deliberately untouched: pinning changes where a note is
/// injected, not its text. The Notes list sorts by `updated_at`, and bumping
/// it would jump a note to the top of the list for a metadata-only click.
///
/// A pin on a note that is not there is an error, not a no-op: `UPDATE`
/// reports zero rows for an id that does not exist, and returning `Ok(())`
/// for that is how a pin looks set when it never was.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE notes SET pinned = ?2 WHERE id = ?1",
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
    delete(&conn, &id)
}

/// Delete a note and the two things that would otherwise outlive it.
///
/// `notes_fts` is maintained by the `notes_ad` trigger, but the vector index
/// and the memories' provenance are not: a deleted note's embedding would
/// stay in `memory_embeddings`, and `memory_items.source_note_id` has no
/// foreign key, so its children would point at an id that no longer exists.
/// One transaction, so a failure cannot leave half a deletion behind.
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no note with id {id}"));
    }
    // The memories survive: the note was their origin, not their owner.
    tx.execute(
        "UPDATE memory_items SET source_note_id = NULL WHERE source_note_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    crate::memory::embed::delete_embedding(&tx, "note", id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Search returns plain notes, not `NoteWithLinks`: a search result list is
/// for finding the note, and the links arrive with `list_notes` once one is
/// open. The empty query still means "everything", as it did before.
#[tauri::command]
pub fn search_notes(pool: State<'_, Arc<DbPool>>, query: String) -> Result<Vec<Note>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    search(&conn, &query)
}

/// The query behind `search_notes`, over `&Connection` so it is testable.
///
/// V006 built `notes_fts` and its triggers, and this query is what the index
/// is for: BM25-ranked, porter-stemmed, prefix-aware, and it no longer scans
/// every body with `LIKE '%…%'`. The `LIKE` path remains as a fallback for
/// two cases the token index cannot answer — a query with no token of two or
/// more characters, and a substring that is not a word prefix ("ider" inside
/// "provider"). Both paths are case-insensitive and both cap at 100 rows.
pub fn search(conn: &Connection, query: &str) -> Result<Vec<Note>, String> {
    let query = query.trim();
    if query.is_empty() {
        return all_notes(conn);
    }
    if let Some(expression) = fts_expression(query) {
        if let Ok(rows) = search_index(conn, &expression) {
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
    }
    search_contains(conn, query)
}

/// Quoted, prefix-matched FTS5 tokens joined with AND.
///
/// Tokens are split on anything that is not alphanumeric and quoted before
/// the `*`, so a query containing `"`, `*`, `:` or `OR` is text rather than
/// syntax. Tokens shorter than two characters are dropped: a one-letter
/// prefix matches nearly the whole library, and the caller falls back to
/// `LIKE` when nothing else survives.
fn fts_expression(query: &str) -> Option<String> {
    let mut tokens: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        let token = raw.to_lowercase();
        if token.chars().count() < 2 || tokens.contains(&token) {
            continue;
        }
        tokens.push(token);
    }
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("\"{}\"*", token.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

fn search_index(conn: &Connection, expression: &str) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.body, n.tags, n.source_session_id, n.source_message_id, n.created_at, n.updated_at, n.pinned
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
             WHERE notes_fts MATCH ?1
             ORDER BY bm25(notes_fts), n.updated_at DESC
             LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![expression], |row| {
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

/// Substring search with `%` and `_` treated as the characters the user
/// typed, not as wildcards. Without `ESCAPE`, a query of `%` matches every
/// note in the library and a search for `100%` matches things it should not.
fn search_contains(conn: &Connection, query: &str) -> Result<Vec<Note>, String> {
    let q = format!("%{}%", escape_like(&query.to_lowercase()));
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, tags, source_session_id, source_message_id, created_at, updated_at, pinned
             FROM notes
             WHERE LOWER(IFNULL(title, '')) LIKE ?1 ESCAPE '\\'
                OR LOWER(body) LIKE ?1 ESCAPE '\\'
                OR LOWER(IFNULL(tags, '')) LIKE ?1 ESCAPE '\\'
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

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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
    use super::{
        all_note_titles, delete, now, search, set_pinned, upsert, validate_note, NoteInput,
    };
    use rusqlite::{params, Connection};

    /// The columns the write path and the searches read. Rows inserted by
    /// the older projection tests fill the rest from defaults.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY,
               title TEXT,
               body TEXT NOT NULL,
               tags TEXT,
               source_session_id TEXT,
               source_message_id TEXT,
               created_at TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL,
               pinned INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE memory_items (
               id TEXT PRIMARY KEY,
               source_note_id TEXT,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE memory_embeddings (
               owner_type TEXT NOT NULL,
               owner_id TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    /// The real FTS5 table and triggers from V006, created after `notes` so
    /// the rows the tests insert are indexed the way production indexes
    /// them.
    fn with_fts(conn: &Connection) {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE notes_fts USING fts5(
               title, body, tags,
               content='notes', content_rowid='rowid',
               tokenize='porter unicode61'
             );
             CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
               INSERT INTO notes_fts(rowid, title, body, tags)
               VALUES (new.rowid, COALESCE(new.title, ''), new.body, COALESCE(new.tags, ''));
             END;
             CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
               INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
               VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body, COALESCE(old.tags, ''));
             END;
             CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
               INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
               VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body, COALESCE(old.tags, ''));
               INSERT INTO notes_fts(rowid, title, body, tags)
               VALUES (new.rowid, COALESCE(new.title, ''), new.body, COALESCE(new.tags, ''));
             END;",
        )
        .unwrap();
    }

    fn add_note(conn: &Connection, id: &str, title: Option<&str>, updated_at: &str) {
        conn.execute(
            "INSERT INTO notes (id, title, body, updated_at) VALUES (?1, ?2, '', ?3)",
            params![id, title, updated_at],
        )
        .unwrap();
    }

    fn add_full(
        conn: &Connection,
        id: &str,
        title: &str,
        body: &str,
        tags: Option<&str>,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO notes (id, title, body, tags, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, title, body, tags, updated_at],
        )
        .unwrap();
    }

    fn link(conn: &Connection, memory_id: &str, note_id: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO memory_items (id, source_note_id, updated_at) VALUES (?1, ?2, ?3)",
            params![memory_id, note_id, updated_at],
        )
        .unwrap();
    }

    fn note_input(id: Option<&str>, title: Option<&str>, body: &str) -> NoteInput {
        NoteInput {
            id: id.map(str::to_string),
            title: title.map(str::to_string),
            body: body.into(),
            tags: None,
            source_session_id: None,
            source_message_id: None,
            pinned: false,
        }
    }

    fn ids(conn: &Connection, query: &str) -> Vec<String> {
        search(conn, query)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect()
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

    /// A save to a note deleted elsewhere must not report success. The
    /// UPDATE matches zero rows and the caller used to receive the id back
    /// as if the text had landed.
    #[test]
    fn upsert_refuses_an_update_to_a_note_that_is_not_there() {
        let conn = db();
        let err = upsert(&conn, note_input(Some("ghost"), Some("Gone"), "body")).unwrap_err();
        assert!(
            err.contains("ghost"),
            "the error must name the id, got: {err}"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "the failed update must write nothing");
    }

    /// The editor sends the whole note, and its save must not move the pin
    /// or the provenance it does not own. `pinned` is ignored on update;
    /// the source ids are written because the editor now carries them.
    #[test]
    fn upsert_updates_the_text_and_leaves_the_pin_alone() {
        let conn = db();
        let id = upsert(
            &conn,
            NoteInput {
                id: None,
                title: Some("Draft".into()),
                body: "first".into(),
                tags: Some("ops".into()),
                source_session_id: Some("session-1".into()),
                source_message_id: Some("message-1".into()),
                pinned: true,
            },
        )
        .unwrap();

        upsert(
            &conn,
            NoteInput {
                id: Some(id.clone()),
                title: Some("Edited".into()),
                body: "second".into(),
                tags: Some("ops".into()),
                source_session_id: Some("session-1".into()),
                source_message_id: Some("message-1".into()),
                pinned: false,
            },
        )
        .unwrap();

        let (title, body, pinned, source_session, source_message): (
            Option<String>,
            String,
            i64,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT title, body, pinned, source_session_id, source_message_id FROM notes WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(title.as_deref(), Some("Edited"));
        assert_eq!(body, "second");
        assert_eq!(pinned, 1, "saving must not unpin a note pinned elsewhere");
        assert_eq!(
            (source_session.as_deref(), source_message.as_deref()),
            (Some("session-1"), Some("message-1")),
            "saving must not erase the chat the note came from"
        );
    }

    /// Deleting a note must take its vector with it and detach its
    /// memories. `memory_items.source_note_id` has no foreign key, and
    /// `delete_embedding` is the documented cleanup that was never called.
    #[test]
    fn delete_removes_the_note_its_vector_and_its_memories_provenance() {
        let conn = db();
        add_note(&conn, "n1", Some("Delete me"), "2026-01-01T00:00:00.000Z");
        add_note(&conn, "n2", Some("Keep me"), "2026-01-02T00:00:00.000Z");
        link(&conn, "m-1", "n1", "2026-01-01T00:00:01.000Z");
        link(&conn, "m-2", "n2", "2026-01-02T00:00:01.000Z");
        conn.execute_batch(
            "INSERT INTO memory_embeddings (owner_type, owner_id) VALUES
               ('note', 'n1'), ('note', 'n2'), ('memory', 'm-1');",
        )
        .unwrap();

        delete(&conn, "n1").unwrap();

        let notes: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(notes, 1, "only the named note is deleted");
        let m1: Option<String> = conn
            .query_row(
                "SELECT source_note_id FROM memory_items WHERE id = 'm-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(m1, None, "the memory survives, detached from the note");
        let m2: Option<String> = conn
            .query_row(
                "SELECT source_note_id FROM memory_items WHERE id = 'm-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            m2.as_deref(),
            Some("n2"),
            "another note's provenance is untouched"
        );

        let gone: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE owner_id = 'n1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "the deleted note must not keep a ranking vector");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, 2, "the other note's and the memory's vectors remain");

        // A second delete is a miss, not a quiet success.
        assert!(delete(&conn, "n1").is_err());
    }

    /// Pinning changes where a note is injected, not when it was written.
    /// The list is sorted by `updated_at`, so a bump would reorder the whole
    /// page for a metadata-only click.
    #[test]
    fn pinning_does_not_move_the_note_in_the_list() {
        let conn = db();
        add_note(&conn, "n1", Some("Runbook"), "2026-01-01T00:00:00.000Z");

        set_pinned(&conn, "n1", true).unwrap();

        let (pinned, updated_at): (i64, String) = conn
            .query_row(
                "SELECT pinned, updated_at FROM notes WHERE id = 'n1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pinned, 1);
        assert_eq!(updated_at, "2026-01-01T00:00:00.000Z");
    }

    /// One timestamp spelling on this table: the SQLite default and the
    /// pin/unlink writes are millisecond `…Z`, and the text sort depends on
    /// the write path agreeing with them.
    #[test]
    fn the_write_timestamp_is_millisecond_zulu() {
        let ts = now();
        assert!(ts.ends_with('Z'), "not a Zulu timestamp: {ts}");
        assert_eq!(ts.len(), 24, "not millisecond precision: {ts}");
        assert_eq!(ts.as_bytes()[19], b'.', "no fractional part: {ts}");
    }

    fn search_fixture() -> Connection {
        let conn = db();
        with_fts(&conn);
        add_full(
            &conn,
            "n1",
            "Deploying the provider",
            "We deployed the provider on Friday",
            Some("release, ops"),
            "2026-01-01T00:00:00.000Z",
        );
        add_full(
            &conn,
            "n2",
            "Groceries",
            "milk and eggs",
            Some("personal"),
            "2026-01-02T00:00:00.000Z",
        );
        add_full(
            &conn,
            "n3",
            "Local only",
            "100% local, and the user_name is a literal",
            Some("notes"),
            "2026-01-03T00:00:00.000Z",
        );
        conn
    }

    #[test]
    fn search_uses_stems_prefixes_tags_and_multiple_tokens() {
        let conn = search_fixture();

        let one = vec!["n1".to_string()];
        assert_eq!(ids(&conn, "deploy"), one, "porter must match 'deployed'");
        assert_eq!(ids(&conn, "provid"), one, "a prefix must match 'provider'");
        assert_eq!(ids(&conn, "ops"), one, "tags are indexed too");
        assert_eq!(ids(&conn, "deploy friday"), one, "tokens are ANDed");
        assert_eq!(ids(&conn, "MILK"), vec!["n2".to_string()], "case folds");
        assert!(ids(&conn, "nothing-matches-this").is_empty());
    }

    /// FTS syntax is text here. A query of `deploy:*` means the token
    /// `deploy`, not a bare column filter; whatever punctuation a user types
    /// must not turn into an error.
    #[test]
    fn search_treats_fts_operators_as_text() {
        let conn = search_fixture();
        assert_eq!(ids(&conn, "deploy:*"), vec!["n1".to_string()]);
        for query in ["\"*: OR (", "NEAR(", "title : deploy", "*"] {
            assert!(
                search(&conn, query).is_ok(),
                "query {query:?} produced an FTS error"
            );
        }
    }

    /// `%` and `_` are characters a user searched for, not wildcards. Before
    /// the escape, a `%` query returned the whole library.
    #[test]
    fn the_fallback_escape_keeps_wildcards_literal() {
        let conn = search_fixture();
        assert_eq!(ids(&conn, "%"), vec!["n3".to_string()]);
        assert_eq!(ids(&conn, "_"), vec!["n3".to_string()]);
    }

    /// An empty query still means "everything", newest first, and a database
    /// without `notes_fts` still answers through the substring fallback
    /// rather than failing the route.
    #[test]
    fn search_falls_back_to_contains_and_empty_means_everything() {
        let conn = search_fixture();
        assert_eq!(
            ids(&conn, "   "),
            vec!["n3".to_string(), "n2".to_string(), "n1".to_string()]
        );

        let legacy = db();
        add_full(
            &legacy,
            "n1",
            "Deploying",
            "We deployed it",
            None,
            "2026-01-01T00:00:00.000Z",
        );
        assert_eq!(
            ids(&legacy, "deploy"),
            vec!["n1".to_string()],
            "no index, the substring path still answers"
        );
    }
}

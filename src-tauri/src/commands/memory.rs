use crate::db::models::{MemoryItem, MemorySearchHit};
use rusqlite::{params, OptionalExtension};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

// The fact type and its parser live in the core module; the command re-exports
// them so `memory_reviews.rs` and the frontend contract are unchanged.
pub use crate::memory::extract::{parse_candidates, ExtractedFact};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Every memory reader maps its row through this, so the SELECT list and the
/// `get` indices are one contract: they must agree, in this order, in every
/// reader. The unit tests pin that, because a mismatch is not a compile
/// error — a reordered pair of string columns compiles, runs, and returns
/// one field's value in the other field's place.
fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: row.get(4)?,
        is_enabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        pinned: row.get::<_, i64>(8)? != 0,
        superseded_by: row.get(9)?,
    })
}

fn existing_memory_id(
    conn: &rusqlite::Connection,
    kind: &str,
    content: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM memory_items WHERE kind = ?1 AND content = ?2 LIMIT 1",
        params![kind, content],
        |row| row.get(0),
    )
    .optional()
}

#[tauri::command]
pub fn list_memory(
    pool: State<'_, Arc<DbPool>>,
    kind: Option<String>,
) -> Result<Vec<MemoryItem>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    list(&conn, kind.as_deref())
}

/// The query behind `list_memory`, over `&Connection` so its positional
/// `row.get` chain is testable. `None` lists every kind, which is what the
/// command passes when the frontend sends no filter.
pub fn list(conn: &rusqlite::Connection, kind: Option<&str>) -> Result<Vec<MemoryItem>, String> {
    let (sql, k): (&str, Option<&str>) = if kind.is_some() {
        (
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at, pinned, superseded_by
             FROM memory_items WHERE kind = ?1 ORDER BY updated_at DESC",
            kind,
        )
    } else {
        (
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at, pinned, superseded_by
             FROM memory_items ORDER BY kind, updated_at DESC",
            None,
        )
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if let Some(k) = k {
        stmt.query_map(params![k], row_to_item)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], row_to_item)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

#[tauri::command]
pub fn upsert_memory(pool: State<'_, Arc<DbPool>>, item: MemoryInput) -> Result<String, String> {
    let is_update = item.id.is_some();
    let id = item.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        // `pinned` is deliberately absent from this UPDATE, for the reason
        // `upsert_note` gives: the editor saves the whole item, so writing an
        // input's pin back would silently unpin a memory the user pinned
        // elsewhere. Pin and unpin are `set_pinned`'s job, on purpose.
        conn.execute(
            "UPDATE memory_items SET kind = ?1, title = ?2, content = ?3, tags = ?4, is_enabled = ?5, updated_at = ?6 WHERE id = ?7",
            params![item.kind, item.title, item.content, item.tags, item.is_enabled, now(), id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        if let Some(existing_id) =
            existing_memory_id(&conn, &item.kind, &item.content).map_err(|e| e.to_string())?
        {
            return Ok(existing_id);
        }
        let ts = now();
        conn.execute(
            "INSERT INTO memory_items (id, kind, title, content, tags, is_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, item.kind, item.title, item.content, item.tags, item.is_enabled, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_memory(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM memory_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_memory(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memory_items SET is_enabled = ?1, updated_at = ?2 WHERE id = ?3",
        params![enabled as i64, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_memory(
    pool: State<'_, Arc<DbPool>>,
    query: String,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemorySearchHit>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    search(&conn, &query, kind.as_deref(), limit.unwrap_or(30))
}

/// The query behind `search_memory`, over `&Connection` so it is callable
/// from a test. A command that can only be reached through a `State` is a
/// command nothing can test, which is how the two bugs below survived: a
/// kind-less search had never been run.
pub fn search(
    conn: &rusqlite::Connection,
    query: &str,
    kind: Option<&str>,
    lim: i64,
) -> Result<Vec<MemorySearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    // Use FTS5 with a snippet function for excerpt highlighting. Escape the
    // user query for FTS5 by quoting each token.
    let fts_q: String = q
        .split_whitespace()
        .map(|tok| {
            let cleaned: String = tok
                .chars()
                .filter(|c| !matches!(c, '"' | '\'' | '(' | ')' | '*'))
                .collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{}\"", cleaned)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" AND ");
    if fts_q.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from(
        // `snippet`'s column index is 0-based over
        // `memory_fts (title, content, tags)`, so 1 is content. It was 2,
        // which is tags: every excerpt came from the tag list, and a memory
        // with no tags is a NULL in that column, so the row could not be
        // read at all.
        "SELECT m.id, m.kind, m.title, m.content, m.tags, m.is_enabled, m.created_at, m.updated_at, m.pinned, m.superseded_by,
                snippet(memory_fts, 1, '<mark>', '</mark>', '…', 16)
         FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ?1",
    );
    if kind.is_some() {
        sql.push_str(" AND m.kind = ?2");
    }
    sql.push_str(" ORDER BY rank LIMIT ?3");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| -> rusqlite::Result<MemorySearchHit> {
        Ok(MemorySearchHit {
            item: row_to_item(row)?,
            snippet: row.get::<_, String>(10)?,
        })
    };
    // `?2` is bound even when its clause is absent. SQLite counts a
    // statement's parameters by its highest index, and `LIMIT ?3` is there
    // either way, so binding two is a "wrong number of parameters" error —
    // which is what every kind-less search returned, always.
    let hits: Vec<MemorySearchHit> = stmt
        .query_map(params![fts_q, kind, lim], mapper)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

#[tauri::command]
pub fn get_enabled_memory(pool: State<'_, Arc<DbPool>>) -> Result<Vec<MemoryItem>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    enabled(&conn)
}

/// The query behind `get_enabled_memory`, over `&Connection` so its positional
/// `row.get` chain is testable. Disabled rows are excluded, exactly as they
/// always were; a pin does not re-enable a memory the user turned off.
pub fn enabled(conn: &rusqlite::Connection) -> Result<Vec<MemoryItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, content, tags, is_enabled, created_at, updated_at, pinned, superseded_by
             FROM memory_items WHERE is_enabled = 1 ORDER BY kind, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Set or clear a memory's pin. A pinned memory is injected on every send,
/// budget permitting, regardless of what retrieval ranks.
///
/// A pin on a memory that is not there is an error, not a no-op: `UPDATE`
/// reports zero rows for an id that does not exist, and returning `Ok(())`
/// for that is how a pin looks set when it never was.
pub fn set_pinned(conn: &rusqlite::Connection, id: &str, pinned: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE memory_items
             SET pinned = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![id, if pinned { 1 } else { 0 }],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no memory with id {id}"));
    }
    Ok(())
}

#[tauri::command]
pub fn set_memory_pinned(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    set_pinned(&conn, &id, pinned)
}

/// Record that a note produced a memory. The write half of the link that
/// `memory_items.source_note_id` is, and the mirror of
/// [`crate::commands::notes::unlink`].
///
/// Both ids are checked, and both are checked for a reason. `source_note_id`
/// carries no foreign key — it was added by `ALTER TABLE` in V006, not
/// declared `REFERENCES notes(id)` — so an `UPDATE` naming a note that was
/// never written reports one changed row and leaves a dangling id that the
/// Notes tab can never resolve. A claim about origin is a claim about two
/// rows: if either is missing the link is not recorded.
///
/// Zero rows changed is an error, not a no-op, for the same reason
/// [`set_pinned`] gives: `UPDATE` reports zero rows for an id that is not
/// there, and returning `Ok(())` for that is how provenance looks recorded
/// when nothing was written.
///
/// Plain `&Connection` rather than a command: nothing in the UI sets this,
/// and a command with no caller is a surface nothing populates. Extraction
/// is the only writer, and it writes through this one.
pub fn set_source_note(
    conn: &rusqlite::Connection,
    note_id: &str,
    memory_id: &str,
) -> Result<(), String> {
    let note_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if note_exists == 0 {
        return Err(format!("no note with id {note_id}"));
    }
    let changed = conn
        .execute(
            "UPDATE memory_items
             SET source_note_id = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![memory_id, note_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("no memory with id {memory_id}"));
    }
    Ok(())
}

/// What one session's memory list is scoped to.
///
/// Three states, and the third is why this is not a `Vec<String>`.
/// `configured == false` is a session that has never touched the feature:
/// every enabled memory is eligible, which is what an empty override list
/// has always meant. `configured == true` with an empty `item_ids` is the
/// instruction "nothing is eligible in this chat" — a real answer the
/// override rows alone could not express, because they are also what an
/// untouched session looks like. The UI needs to tell the two apart to
/// render the boxes, and recall needs it to honour the instruction.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemoryScope {
    /// The memory ids eligible for recall in this session. Empty when
    /// `configured` is false, and possibly empty when it is true.
    pub item_ids: Vec<String>,
    /// Whether this session was scoped at all.
    pub configured: bool,
}

#[tauri::command]
pub fn get_session_memory_overrides(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
) -> Result<SessionMemoryScope, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    session_memory_scope(&conn, &session_id)
}

/// [`get_session_memory_overrides`] over `&Connection`, so the three states
/// are testable without a `State`.
///
/// Override rows on their own mean scoped, because that is what every
/// session written before `session_memory_scope` exists looks like, and
/// reading it as unrestricted would widen those sessions to the whole
/// library. The scope row is what says "deliberately, and to nothing".
pub fn session_memory_scope(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<SessionMemoryScope, String> {
    let mut stmt = conn
        .prepare("SELECT item_id FROM session_overrides WHERE session_id = ?1 ORDER BY item_id")
        .map_err(|e| e.to_string())?;
    let item_ids = stmt
        .query_map(params![session_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let deliberate: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_memory_scope WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(SessionMemoryScope {
        configured: deliberate > 0 || !item_ids.is_empty(),
        item_ids,
    })
}

#[tauri::command]
pub fn set_session_memory_overrides(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    item_ids: Vec<String>,
    configured: bool,
) -> Result<(), String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    write_session_memory_scope(&mut conn, &session_id, &item_ids, configured)
}

/// [`set_session_memory_overrides`] over `&Connection`, so the write is
/// testable.
///
/// `configured == false` clears the session entirely — rows and scope row —
/// and `item_ids` is ignored, because a session with no restriction is the
/// one state an empty list has always meant and the one every untouched
/// session is in. `configured == true` writes exactly `item_ids`, including
/// the empty list: a scope row with no override rows is how a user says
/// "this chat has no memory", and it is the only representation of that
/// answer that is not indistinguishable from never having asked.
///
/// One transaction, because the two tables are one fact. A scope row
/// written without its overrides is a session scoped to nothing that the
/// user meant to scope to something.
pub fn write_session_memory_scope(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    item_ids: &[String],
    configured: bool,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM session_overrides WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    if configured {
        for id in item_ids {
            tx.execute(
                "INSERT OR IGNORE INTO session_overrides (session_id, item_id) VALUES (?1, ?2)",
                params![session_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO session_memory_scope (session_id) VALUES (?1)",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "DELETE FROM session_memory_scope WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub tags: Option<String>,
    pub is_enabled: i64,
}

/// Ask the LLM to extract facts (user prefs, project facts, skills) from a
/// session. Returns a list of candidate facts for the user to review and
/// save individually.
#[tauri::command]
pub async fn extract_facts_from_session(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<ExtractedFact>, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use crate::providers::{ollama::OllamaProvider, openai_compat::OpenAiCompatProvider, Provider};

    // Load messages (tight scope so stmt borrow ends before any await)
    let messages: Vec<(String, String)> = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT role, content FROM messages WHERE session_id = ?1 AND content != '' ORDER BY created_at ASC LIMIT 60",
            )
            .map_err(|e| e.to_string())?;
        let rows: Result<Vec<(String, String)>, rusqlite::Error> = stmt
            .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect();
        rows.map_err(|e| e.to_string())?
    };

    if messages.len() < 2 {
        return Err("Need at least 2 messages to extract facts".into());
    }

    // Build conversation text
    let convo = messages
        .iter()
        .map(|(role, content)| {
            format!(
                "{}: {}",
                if role == "user" { "Human" } else { "Assistant" },
                content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    // Resolve provider/model (separate scope so DB connection is released
    // before the async LLM call).
    let (_provider_id, model_id, kind, base_url, api_key) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let resolve: Result<(String, String, String, String, Option<String>), String> = (|| {
            let (p, m): (String, String) = match (provider_id.clone(), model_id.clone()) {
                (Some(p), Some(m)) => (p, m),
                _ => {
                    let p: Option<String> = conn
                        .query_row(
                            "SELECT id FROM providers WHERE is_default = 1 LIMIT 1",
                            [],
                            |r| r.get(0),
                        )
                        .ok();
                    let Some(p) = p else {
                        return Err("No default provider configured".into());
                    };
                    let m: Option<String> = conn
                        .query_row(
                            "SELECT name FROM models WHERE provider_id = ?1 ORDER BY name LIMIT 1",
                            rusqlite::params![p],
                            |r| r.get(0),
                        )
                        .ok();
                    let Some(m) = m else {
                        return Err("No models cached for default provider".into());
                    };
                    (p, m)
                }
            };
            let (k, bu): (String, String) = conn
                .query_row(
                    "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
                    rusqlite::params![p],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| format!("Provider: {}", e))?;
            let key = crate::services::get_api_key(&p);
            Ok((p, m, k, bu, key))
        })(
        );
        resolve?
    };
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };

    let system = "You extract durable facts about the user and their work from a conversation. Output ONLY valid JSON: a bare array of objects with exactly these keys: kind, title, content, tags. Do not wrap the array in an object such as extracted_facts. Allowed kind values are exactly 'user_pref' for user preferences, 'project_fact' for project facts, and 'skill' for reusable instructions. tags must be null or one comma-separated string, never an array. Example: [{\"kind\":\"user_pref\",\"title\":\"Birthday\",\"content\":\"The user's birthday is February 18th.\",\"tags\":null}]. Never use the keys type, fact, value, details, fact_type, detail, or context. Never return task/request or communication goal/task items or one-off task details. Include only items likely to remain true across many future sessions — preferences, recurring projects, coding style rules, role descriptions, environment facts. Skip transient task details, debugging chatter, and one-off questions. Return at most 8 items. If nothing durable is found, return an empty array []. Output ONLY the JSON, no commentary.".to_string();

    let user = format!(
        "Conversation:\n\n{}\n\nReturn the JSON array of extracted facts.",
        convo
    );
    let req = ChatRequest {
        model: model_id.clone(),
        messages: vec![MessageContent {
            role: "user".into(),
            content: user,
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(system),
        temperature: Some(0.1),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let response = provider.chat_stream(req).await?;
    use futures_util::StreamExt;
    let mut stream = response;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(msg) = chunk.message {
                    out.push_str(&msg.content);
                }
                if chunk.done {
                    break;
                }
            }
            Err(e) => return Err(format!("LLM error: {}", e)),
        }
    }
    let facts =
        parse_candidates(&out).map_err(|e| format!("Could not parse extracted facts: {}", e))?;
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_observed_legacy_fact_shape_and_drops_task_requests() {
        let facts = parse_candidates(
            r#"[
                {"type":"personal_information","fact":"User's Birthday Date","value":"February 18th"},
                {"type":"task/request","fact":"Email Draft Setup","details":"Drafting a birthday invitation email for friends."}
            ]"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("User's Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
        assert_eq!(facts[0].tags, None);
    }

    #[test]
    fn normalizes_gemma_fact_type_shape_and_drops_communication_tasks() {
        let facts = parse_candidates(
            r#"```json
            [
              {"fact_type":"Personal Detail","detail":"Birthday Date","value":"February 18th"},
              {"fact_type":"Communication Goal/Task","detail":"Email drafting for friends","context":"Setup a birthday meeting email"}
            ]
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn normalizes_additional_gemma_personal_information_shapes() {
        for response in [
            r#"```json
            [
              {"fact":"Birthday Date","type":"Personal Information / Date","value":"February 18th","context":"The user asked the assistant to remember this date."},
              {"fact":"Desired Output","type":"Goal/Task","value":"Birthday meeting email for friends"}
            ]
            ```"#,
            r#"```json
            [
              {"category":"Personal Information","fact_type":"Birthday Date","value":"February 18th"},
              {"category":"Interaction Goal","fact_type":"Task Completion","value":"Drafting a birthday invitation email"}
            ]
            ```"#,
        ] {
            let facts = parse_candidates(response).unwrap();

            assert_eq!(facts.len(), 1);
            assert_eq!(facts[0].kind, "user_pref");
            assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
            assert_eq!(facts[0].content, "February 18th");
        }
    }

    #[test]
    fn normalizes_gemma_extracted_facts_wrapper_and_infers_birthday() {
        let facts = parse_candidates(
            r#"```json
            {
              "extracted_facts": [
                {
                  "fact": "Birthday Date",
                  "value": "February 18th",
                  "notes": "This date was used for the generated email templates."
                },
                {
                  "fact": "Recent Task Context",
                  "value": "Drafting a birthday invitation/meeting email.",
                  "details": "The user required three tone options."
                }
              ]
            }
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "user_pref");
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn drops_live_gemma_milestone_and_event_planning_artifacts() {
        let facts = parse_candidates(
            r#"```json
            {
              "extracted_facts": [
                {"fact_type":"Personal Milestone","detail":"Birthday Date","value":"February 18th"},
                {"fact_type":"Goal/Task","detail":"Event Planning","value":"Setting up a birthday gathering/meeting."},
                {"fact_type":"Target Audience","detail":"Invitation Recipients","value":"Friends"},
                {"fact_type":"Output Generated","detail":"Email Templates","value":"Three birthday invitation versions."}
              ]
            }
            ```"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].title.as_deref(), Some("Birthday Date"));
        assert_eq!(facts[0].content, "February 18th");
    }

    #[test]
    fn accepts_array_tags_and_normalizes_them_for_the_existing_schema() {
        let facts = parse_candidates(
            r#"[{"kind":"user_pref","title":"Style","content":"Prefers concise replies.","tags":["preference","communication"]}]"#,
        )
        .unwrap();

        assert_eq!(facts[0].tags.as_deref(), Some("preference, communication"));
    }

    #[test]
    fn preserves_canonical_fact_shape() {
        let facts = parse_candidates(
            r#"[{"kind":"project_fact","title":"Stack","content":"Convo uses Tauri.","tags":"stack"}]"#,
        )
        .unwrap();

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "project_fact");
        assert_eq!(facts[0].title.as_deref(), Some("Stack"));
        assert_eq!(facts[0].content, "Convo uses Tauri.");
        assert_eq!(facts[0].tags.as_deref(), Some("stack"));
    }

    #[test]
    fn accepted_memory_write_deduplicates_exact_kind_and_content() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL);
             INSERT INTO memory_items (id, kind, content) VALUES ('memory-1', 'user_pref', 'The user prefers concise replies.');",
        )
        .unwrap();

        assert_eq!(
            existing_memory_id(&conn, "user_pref", "The user prefers concise replies.")
                .unwrap()
                .as_deref(),
            Some("memory-1")
        );
        assert_eq!(
            existing_memory_id(&conn, "project_fact", "The user prefers concise replies.").unwrap(),
            None
        );
    }

    #[test]
    fn rejects_invalid_json_and_non_array_responses() {
        let invalid_json = parse_candidates("not json").unwrap_err();
        assert!(invalid_json.contains("JSON"));

        let non_array = parse_candidates(r#"{"status":"ok"}"#).unwrap_err();
        assert!(non_array.contains("array"));
    }
}

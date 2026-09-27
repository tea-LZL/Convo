//! Filling in the embedding index.
//!
//! Deliberately not on the send path. An embed call is a network round
//! trip — a second or more for a decent model — and a user should never
//! wait for one because they pressed send. A memory written by a
//! revision therefore has no vector until the next pass, and
//! `rows_needing_embedding` reports exactly that, so the Memory tab can
//! say "3 awaiting indexing" instead of pretending the vector is there.
//!
//! Cost if wrong: a freshly added memory is not semantically recallable
//! for one pass. Keyword recall finds it immediately, so nothing is
//! unreachable — just less well ranked.

use crate::memory::config;
use crate::memory::embed::{upsert_embedding, KnowledgeRow};
use crate::providers::Provider;
use rusqlite::params;

/// Embed and store every row that needs it. Safe to call repeatedly.
///
/// Returns how many rows were written. A provider that returns vectors
/// of the wrong dimension is an error naming both, not a silent
/// truncation: a short vector silently compared against a long one
/// produces a confident wrong score rather than a visible failure.
pub async fn fill_index(
    conn: &rusqlite::Connection,
    provider: &dyn Provider,
    model: &str,
    dim: usize,
    embed_all_notes: bool,
) -> Result<usize, String> {
    let rows = super::embed::rows_needing_embedding(conn, model, dim, embed_all_notes)
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut written = 0usize;
    for batch in rows.chunks(config::EMBED_BATCH) {
        let inputs: Vec<String> = batch.iter().map(embeddable_text).collect();
        let vectors = provider.embed(model, &inputs).await?;
        if vectors.len() != batch.len() {
            return Err(format!(
                "embed returned {} vectors for {} inputs",
                vectors.len(),
                batch.len()
            ));
        }
        for (row, vector) in batch.iter().zip(vectors.iter()) {
            if vector.len() != dim {
                return Err(format!(
                    "embed returned {}-dim vectors but the index is {}-dim; \
                     reindex rather than mixing them",
                    vector.len(),
                    dim
                ));
            }
            upsert_embedding(conn, &row.owner_type, &row.owner_id, model, vector)?;
            written += 1;
        }
    }
    Ok(written)
}

/// What to embed for a row: title and content together, so a memory titled
/// "Build command" is findable by its title.
fn embeddable_text(row: &KnowledgeRow) -> String {
    match row.title.as_deref() {
        Some(title) if !title.trim().is_empty() => format!("{}\\n\\n{}", title.trim(), row.content),
        _ => row.content.clone(),
    }
}

/// Delete a row's vector. Called when a memory or note is removed, so a
/// deleted item cannot keep influencing ranking through a stale vector.
pub fn forget(conn: &rusqlite::Connection, owner_type: &str, owner_id: &str) -> Result<(), String> {
    super::embed::delete_embedding(conn, owner_type, owner_id)
}

/// Record that a row was recalled, for the reinforcement boost. Called by
/// the context-assembly path, not here.
pub fn record_recall(
    conn: &rusqlite::Connection,
    owner_type: &str,
    owner_id: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    super::embed::log_event(conn, owner_type, owner_id, "recall", session_id)
}

/// Bump `access_count` alongside the access log, so reinforcement does
/// not need a `COUNT(*)` over the event log on every send.
pub fn bump_access_count(conn: &rusqlite::Connection, owner_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE memory_items
         SET access_count = access_count + 1,
             last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![owner_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

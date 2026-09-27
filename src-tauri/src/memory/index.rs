//! Filling in the embedding index.
//!
//! Deliberately not on the send path. An embed call is a network round
//! trip — a second or more for a decent model — and a user should never
//! wait for one because they pressed send. A memory written by a revision
//! is embedded by `revise::apply_candidate` right after it applies, still
//! off the send path; this module is the backstop for everything that path
//! does not cover: memories added by hand, notes, and rows written while
//! the embedding route was unconfigured or failing.
//!
//! Cost if wrong: a row is not semantically recallable until the next fill,
//! and `knowledge_index_status` reports exactly how many are waiting.
//! Keyword recall finds them immediately, so nothing is unreachable —
//! just less well ranked.
//!
//! No connection is held across an await anywhere in this file. The pool is
//! taken rather than a borrowed connection precisely so that the send
//! future stays `Send`; a `&Connection` spanning an embed call does not.

use crate::memory::config;
use crate::memory::embed::{upsert_embedding, KnowledgeRow};
use crate::providers::Provider;

/// Embed and store every row that needs it. Safe to call repeatedly.
///
/// Returns how many rows were written. A provider that returns the wrong
/// number of vectors, or vectors of the wrong dimension, is an error
/// naming both — a short vector silently compared against a long one
/// produces a confident wrong score rather than a visible failure, which
/// is the failure mode this module exists to prevent.
pub async fn fill_index(
    pool: &std::sync::Arc<crate::db::DbPool>,
    provider: &dyn Provider,
    model: &str,
    dim: usize,
    embed_all_notes: bool,
) -> Result<usize, String> {
    let rows = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        super::embed::rows_needing_embedding(&conn, model, dim, embed_all_notes)
            .map_err(|e| e.to_string())?
    };
    if rows.is_empty() {
        return Ok(0);
    }

    let mut written = 0usize;
    for batch in rows.chunks(config::EMBED_BATCH) {
        let inputs: Vec<String> = batch.iter().map(embeddable_text).collect();
        // Await with no connection in scope.
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
            // Re-acquired per row, so the borrow above cannot outlive the
            // await that follows it.
            let conn = pool.get().map_err(|e| e.to_string())?;
            upsert_embedding(&conn, &row.owner_type, &row.owner_id, model, vector)?;
            written += 1;
        }
    }
    Ok(written)
}

/// What to embed for a row: title and content together, so a memory titled
/// "Build command" is findable by its title.
fn embeddable_text(row: &KnowledgeRow) -> String {
    match row.title.as_deref() {
        Some(title) if !title.trim().is_empty() => format!("{}\n\n{}", title.trim(), row.content),
        _ => row.content.clone(),
    }
}

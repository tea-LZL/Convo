//! Vector persistence for the unified knowledge index.
//!
//! Memories and notes are selected through one query and stored through one
//! pair of functions, so retrieval cannot tell them apart. Nothing here
//! scores anything — that is Plan 3's `retrieve.rs`. This module's whole
//! job is to get vectors in and out of SQLite without ever handing back a
//! value that would produce a confident wrong answer.
//!
//! Three failure modes are refused rather than absorbed:
//!
//! - a BLOB whose length disagrees with its recorded dimension, which is a
//!   torn write and would otherwise decode to zeros and score as if real;
//! - a vector written by a different embedding model or a different
//!   dimension, which is not comparable and is treated as work to redo;
//! - a count mismatch between requested inputs and returned vectors, which
//!   the provider layer already refuses but which is re-checked here at the
//!   point where a rank would otherwise be assigned to the wrong document.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::config;

/// One row of the unified index, before scoring.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeRow {
    /// `"memory"` or `"note"`.
    pub owner_type: String,
    pub owner_id: String,
    /// Memory kind, or `"note"` for a note.
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub is_enabled: bool,
    pub superseded_by: Option<String>,
    pub access_count: i64,
    pub updated_at: String,
}

/// A stored vector, as read back out of the index.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingRow {
    pub owner_type: String,
    pub owner_id: String,
    pub model: String,
    pub dim: usize,
    pub vec: Vec<f32>,
}

/// Pack a vector as little-endian f32 bytes for the BLOB column.
pub fn encode(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for value in vec {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Unpack a BLOB written by [`encode`].
///
/// Returns `None` when the byte length is not exactly `dim * 4`. A torn or
/// truncated write is not recoverable and must not be papered over with
/// zeros: a zero vector would either be skipped as degenerate or, once
/// something upstream normalised it, compared as though it were real.
pub fn decode(bytes: &[u8], dim: usize) -> Option<Vec<f32>> {
    if bytes.len() != dim * 4 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Cosine similarity.
///
/// Returns `None` rather than a number whenever the result would be
/// undefined: mismatched lengths, an empty vector, or a zero-magnitude
/// side. A NaN here silently poisons every comparison it takes part in, so
/// the caller has to be able to see it and drop the pair.
pub fn cosine(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let mut dot = 0.0f64;
    let mut mag_a = 0.0f64;
    let mut mag_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let (x, y) = (*x as f64, *y as f64);
        dot += x * y;
        mag_a += x * x;
        mag_b += y * y;
    }
    if mag_a <= f64::EPSILON || mag_b <= f64::EPSILON {
        return None;
    }
    let score = dot / (mag_a.sqrt() * mag_b.sqrt());
    if score.is_finite() {
        Some(score)
    } else {
        None
    }
}

/// SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999. A corpus well past
/// that is the normal case, not the edge case, so ids are bound in chunks.
const ID_CHUNK: usize = 400;

/// Rows that need a vector: enabled, not superseded, long enough to be
/// worth embedding, and either unindexed or indexed under a different
/// model or dimension.
///
/// `embed_all_notes` gates the note arm. A long-form note library is
/// expensive to embed and mostly not what a chat query reaches for, so by
/// default only pinned notes are indexed.
pub fn rows_needing_embedding(
    conn: &Connection,
    model: &str,
    dim: usize,
    embed_all_notes: bool,
) -> rusqlite::Result<Vec<KnowledgeRow>> {
    let sql = "
        SELECT 'memory', m.id, m.kind, m.title, m.content, m.is_enabled,
               m.superseded_by, m.access_count, m.updated_at
        FROM memory_items m
        LEFT JOIN memory_embeddings e
               ON e.owner_type = 'memory' AND e.owner_id = m.id
        WHERE m.is_enabled = 1
          AND m.superseded_by IS NULL
          AND LENGTH(COALESCE(m.title, '') || ' ' || m.content) >= ?1
          AND (e.id IS NULL OR e.model <> ?2 OR e.dim <> ?3)
        UNION ALL
        SELECT 'note', n.id, 'note', n.title, n.body, 1, NULL, 0, n.updated_at
        FROM notes n
        LEFT JOIN memory_embeddings e
               ON e.owner_type = 'note' AND e.owner_id = n.id
        WHERE (n.pinned = 1 OR ?4 = 1)
          AND LENGTH(COALESCE(n.title, '') || ' ' || n.body) >= ?1
          AND (e.id IS NULL OR e.model <> ?2 OR e.dim <> ?3)
        ORDER BY 2
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        params![
            config::MIN_CONTENT_LENGTH as i64,
            model,
            dim as i64,
            if embed_all_notes { 1i64 } else { 0i64 },
        ],
        |row| {
            Ok(KnowledgeRow {
                owner_type: row.get(0)?,
                owner_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                content: row.get(4)?,
                is_enabled: row.get::<_, i64>(5)? != 0,
                superseded_by: row.get(6)?,
                access_count: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )?;
    rows.collect()
}

/// Replace the stored vector for one row.
pub fn upsert_embedding(
    conn: &Connection,
    owner_type: &str,
    owner_id: &str,
    model: &str,
    vec: &[f32],
) -> Result<(), String> {
    if vec.is_empty() {
        return Err("refusing to store a zero-length embedding".to_string());
    }
    if vec.iter().any(|v| !v.is_finite()) {
        return Err("refusing to store a non-finite embedding".to_string());
    }
    let dim = vec.len() as i64;
    let bytes = encode(vec);

    // Delete-then-insert in one transaction rather than
    // `ON CONFLICT(owner_type, owner_id) DO UPDATE`: that needs a UNIQUE
    // constraint the table does not have, and adding one would mean a
    // further migration for a table that has not shipped yet. The
    // transaction keeps the delete and the insert indivisible, so a crash
    // mid-write cannot leave a row with no vector.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE owner_type = ?1 AND owner_id = ?2",
        params![owner_type, owner_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO memory_embeddings (id, owner_type, owner_id, model, dim, vec)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            owner_type,
            owner_id,
            model,
            dim,
            bytes
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Stored vectors for the given rows, paired with the rows themselves.
///
/// Ids are bound in chunks to stay under SQLite's variable limit. Rows
/// without a vector under `model` are omitted rather than returned empty,
/// and a BLOB that fails to decode is omitted rather than zero-filled.
pub fn load_vectors(
    conn: &Connection,
    model: &str,
    rows: &[KnowledgeRow],
) -> rusqlite::Result<Vec<(KnowledgeRow, Vec<f32>)>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let mut found: Vec<(String, Vec<f32>)> = Vec::new();
    for chunk in rows.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT owner_id, dim, vec FROM memory_embeddings
             WHERE model = ?1 AND owner_id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(model.to_string())];
        for row in chunk {
            binds.push(Box::new(row.owner_id.clone()));
        }
        let mapped = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            let owner_id: String = row.get(0)?;
            let dim: usize = row.get(1)?;
            let bytes: Vec<u8> = row.get(2)?;
            Ok((owner_id, dim, bytes))
        })?;
        for entry in mapped {
            let (owner_id, dim, bytes) = entry?;
            if let Some(vector) = decode(&bytes, dim) {
                found.push((owner_id, vector));
            }
        }
    }
    // One lookup table rather than a linear scan per row. The scan was
    // quadratic in the candidate count: measured in release at 12ms for
    // 2,000 rows and 80ms for 5,000, against a <50ms p95 budget for the
    // whole of recall.
    let mut by_id: std::collections::HashMap<&str, &[f32]> =
        std::collections::HashMap::with_capacity(found.len());
    for (owner_id, vector) in &found {
        by_id.insert(owner_id.as_str(), vector.as_slice());
    }
    // Preserve the caller's ordering: rank is assigned by the caller, and
    // reordering here would silently re-pair a score with a document.
    Ok(rows
        .iter()
        .filter_map(|row| {
            by_id
                .get(row.owner_id.as_str())
                .map(|vector| (row.clone(), vector.to_vec()))
        })
        .collect())
}

/// True when any stored embedding was written by a different model or
/// dimension than the one now configured, so the index needs a rebuild.
pub fn needs_reindex(conn: &Connection, model: &str, dim: usize) -> rusqlite::Result<bool> {
    let stale: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_embeddings WHERE model <> ?1 OR dim <> ?2)",
        params![model, dim as i64],
        |row| row.get(0),
    )?;
    Ok(stale != 0)
}

/// Delete the vector for one row. Called when a memory or note is removed,
/// so a deleted item cannot keep influencing ranking through a stale vector.
pub fn delete_embedding(conn: &Connection, owner_type: &str, owner_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM memory_embeddings WHERE owner_type = ?1 AND owner_id = ?2",
        params![owner_type, owner_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Append to the access log.
///
/// The `event` CHECK constraint is the only enforcement point. Validating
/// the same set in Rust would be a second place to keep in sync, and the
/// two would drift.
pub fn log_event(
    conn: &Connection,
    owner_type: &str,
    owner_id: &str,
    event: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_events (id, owner_type, owner_id, event, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            owner_type,
            owner_id,
            event,
            session_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// How many times a row has been recalled, for the reinforcement boost.
pub fn recall_count(conn: &Connection, owner_type: &str, owner_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_events
         WHERE owner_type = ?1 AND owner_id = ?2 AND event = 'recall'",
        params![owner_type, owner_id],
        |row| row.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or(0))
}

/// Half-life decay for `updated_at`, in `(0.5, 1.0]`.
///
/// A multiplier rather than a filter: old-but-relevant still surfaces, it
/// just ranks below a fresh equivalent. A hard age cutoff would make
/// recall non-monotonic in time, which reads to a user as the app
/// forgetting things.
pub fn recency_weight(age_days: f64) -> f64 {
    if !age_days.is_finite() || age_days <= 0.0 {
        return 1.0;
    }
    let half_life = config::RECENCY_HALF_LIFE_DAYS;
    if half_life <= 0.0 {
        return 1.0;
    }
    let weight = 0.5f64.powf(age_days / half_life);
    weight.clamp(0.5, 1.0)
}

/// Whole days between an ISO-8601 timestamp and now.
///
/// Returns 0.0 for an unparseable timestamp rather than a large age, so a
/// malformed date cannot silently halve an item's rank forever.
pub fn age_days(updated_at: &str) -> f64 {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        return 0.0;
    };
    let age = chrono::Utc::now().signed_duration_since(parsed);
    age.num_seconds().max(0) as f64 / 86_400.0
}

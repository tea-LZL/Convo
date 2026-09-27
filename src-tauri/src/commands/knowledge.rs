//! Commands over the unified knowledge index.
//!
//! Split out of `commands/memory.rs`, which is 771 lines of extraction
//! logic that Plan 4 reworks. This file is the read side: recall and
//! index status.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::db::DbPool;
use crate::memory::config;
use crate::memory::retrieve::DEFAULT_LAMBDA;
use crate::memory::retrieve::{self, RankedMemory, RecallOptions};
use crate::providers::{ollama::OllamaProvider, openai_compat::OpenAiCompatProvider, Provider};

/// How much of the recall set the Memory tab gets. Wider than
/// `config::TOP_K_DEFAULT` on purpose: this is a UI list the user is
/// inspecting, not a context budget.
const UI_RESULT_LIMIT: usize = 50;

/// Ranked recall for one query.
///
/// Never returns an error for a missing index, a missing embedding model,
/// or an unreachable embed endpoint. Each of those degrades to a smaller
/// result, because recall runs inside a send and a failed send is worse
/// than a thin answer.
#[tauri::command]
pub async fn memory_recall(
    pool: State<'_, Arc<DbPool>>,
    query: String,
    session_id: Option<String>,
    top_k: Option<i64>,
    kinds: Option<Vec<String>>,
) -> Result<Vec<RankedMemory>, String> {
    let opts = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        // An explicit limit wins; otherwise the configured one. Capped so
        // a caller cannot ask for the whole index.
        let limit = top_k
            .filter(|n| *n > 0)
            .unwrap_or_else(|| config::top_k(&conn))
            .clamp(1, UI_RESULT_LIMIT as i64) as usize;
        RecallOptions {
            query: &query,
            session_id: session_id.as_deref(),
            embedding_model: None,
            embedding_dim: None,
            kinds,
            top_k: limit,
            lambda: DEFAULT_LAMBDA,
        }
    };

    // Embedding the query is optional. Every failure below drops to
    // keyword-only.
    let mut opts = opts;
    let mut query_vector: Vec<f32> = Vec::new();
    if let Some((provider_id, model)) = embedding_route(&pool) {
        if let Ok(vector) = embed_query(&pool, &provider_id, &model, &query).await {
            query_vector = vector;
            opts.embedding_model = Some(model);
            opts.embedding_dim = Some(query_vector.len());
        }
    }

    let conn = pool.get().map_err(|e| e.to_string())?;
    Ok(retrieve::recall_with_query_vector(
        &conn,
        &opts,
        &query_vector,
    ))
}

/// The configured embedding route, or `None`. Read inside its own scope so
/// the connection is released before any await.
fn embedding_route(pool: &State<'_, Arc<DbPool>>) -> Option<(String, String)> {
    let conn = pool.get().ok()?;
    config::load_routing(&conn)
        .embedding
        .map(|r| (r.provider_id, r.model))
}

/// Embed one string, or `None`. Never surfaces an error to the caller:
/// every failure is a reason to fall back to keyword recall.
async fn embed_query(
    pool: &State<'_, Arc<DbPool>>,
    provider_id: &str,
    model: &str,
    text: &str,
) -> Result<Vec<f32>, String> {
    let (kind, base_url, api_key) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let found: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT kind, COALESCE(base_url, ''), api_key FROM providers WHERE id = ?1",
                rusqlite::params![provider_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        match found {
            Some((kind, base_url, legacy_key)) => {
                // Provider keys live in the keyring; the column is legacy.
                let key = crate::services::get_api_key(provider_id).or(legacy_key);
                (kind, base_url, key)
            }
            None => return Err("embedding provider not found".into()),
        }
    };
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("unknown provider kind: {}", other)),
    };
    let inputs = vec![text.to_string()];
    let vectors = provider.embed(model, &inputs).await?;
    Ok(vectors.into_iter().next().unwrap_or_default())
}

/// Index status for the Memory tab.
///
/// Separates "nothing is embedded yet" from "the index is stale because
/// the embedding model changed", because those are different problems with
/// different fixes and a user staring at one number cannot tell them apart.
#[derive(Debug, Serialize, Clone)]
pub struct KnowledgeIndexStatus {
    pub memory_count: i64,
    pub note_count: i64,
    pub embedded_count: i64,
    pub needs_embedding: i64,
    pub needs_reindex: bool,
    pub embedding_model: Option<String>,
    /// Why semantic recall is unavailable, when it is. `None` means the
    /// vector route is configured; `Some` explains the fallback.
    pub semantic_note: Option<String>,
}

#[tauri::command]
pub fn knowledge_index_status(
    pool: State<'_, Arc<DbPool>>,
) -> Result<KnowledgeIndexStatus, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let memory_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
        .unwrap_or(0);
    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0);
    let embedded_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))
        .unwrap_or(0);

    let routing = config::load_routing(&conn);
    let (needs_embedding, needs_reindex) = match routing.embedding.as_ref() {
        Some(route) => {
            // The dimension is whatever the model actually produced, which
            // we only know by asking it. Until something is embedded, the
            // count is the eligible-row count against a nominal dim.
            let dim = conn
                .query_row(
                    "SELECT dim FROM memory_embeddings WHERE model = ?1 LIMIT 1",
                    rusqlite::params![route.model],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                .max(0) as usize;
            retrieve::knowledge_status(&conn, &route.model, dim)
        }
        None => (0, false),
    };

    let semantic_note = match routing.embedding.as_ref() {
        None => Some(
            "No embedding model configured. Recall is keyword-only, so it will miss \
             memories that share no words with the question."
                .to_string(),
        ),
        Some(_) if needs_reindex => Some(
            "The embedding model changed, so existing vectors are not comparable. \
             They will be rebuilt on the next index pass."
                .to_string(),
        ),
        Some(_) if needs_embedding > 0 => Some(format!(
            "{} row(s) are not embedded yet. Semantic recall will improve as they fill in.",
            needs_embedding
        )),
        Some(_) => None,
    };

    Ok(KnowledgeIndexStatus {
        memory_count,
        note_count,
        embedded_count,
        needs_embedding,
        needs_reindex,
        embedding_model: routing.embedding.map(|r| r.model),
        semantic_note,
    })
}

/// Extract from a session and apply the revision table, all in Rust.
///
/// This is the entry point that replaces the browser-side
/// extract-then-review dance: the frontend queued a review, the model
/// answered, and a human decided what to keep. Now the revision table
/// decides the high-confidence cases and the inbox only holds the rest.
#[tauri::command]
pub async fn memory_extract_and_revise(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<crate::memory::revise::Applied>, String> {
    let (window, every_n, auto_extract, extraction_route) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        if !config::auto_extract(&conn) {
            return Ok(Vec::new());
        }
        let window = crate::memory::extract::should_extract(&conn, &session_id, 2)
            .map_err(|e| e.to_string())?;
        let routing = config::load_routing(&conn);
        (
            window,
            2,
            true,
            match (routing.extraction, model_id.clone(), provider_id.clone()) {
                (Some(route), _, _) => Some((route.provider_id, route.model)),
                (None, Some(m), Some(p)) => Some((p, m)),
                (None, _, _) => None,
            },
        )
    };
    let Some(window) = window else {
        return Ok(Vec::new());
    };
    let _ = (every_n, auto_extract);

    let facts = match crate::memory::extract::run_extraction(&pool, &window, extraction_route).await
    {
        Ok(facts) => facts,
        Err(e) => {
            tracing::warn!("extraction failed for {}: {}", session_id, e);
            return Ok(Vec::new());
        }
    };

    let mut applied = Vec::new();
    for candidate in &facts {
        // Each candidate is independent: one failure must not abandon
        // the rest, so errors are logged and the loop continues.
        match crate::memory::revise::apply_candidate(&pool, &session_id, candidate).await {
            Ok(result) => applied.push(result),
            Err(e) => tracing::warn!("revision failed for a candidate: {}", e),
        }
    }

    let conn = pool.get().map_err(|e| e.to_string())?;
    crate::memory::extract::set_watermark(&conn, &session_id, &window.watermark_message_id)?;
    Ok(applied)
}

/// Fill in the vectors that are missing, and rebuild them if the
/// embedding model changed.
///
/// `knowledge_index_status` reports how many rows are unembedded, and this
/// is the only thing that reduces that number for rows extraction did not
/// create: memories added by hand, notes, and anything written while the
/// embedding route was unconfigured or failing.
///
/// The dimension comes from what is already stored, not from
/// configuration. A configured model and the vectors on disk are the only
/// two sources, and if they disagree the stored vectors are the truth about
/// what this index holds — mixing the two would produce confident wrong
/// scores rather than a visible error.
#[tauri::command]
pub async fn memory_index_fill(
    pool: State<'_, Arc<DbPool>>,
    embed_notes: bool,
) -> Result<usize, String> {
    let (route, dim) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let route = config::load_routing(&conn)
            .embedding
            .ok_or("no embedding model configured")?;
        let dim: i64 = conn
            .query_row(
                "SELECT dim FROM memory_embeddings WHERE model = ?1 LIMIT 1",
                rusqlite::params![route.model],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (route, dim.max(0) as usize)
    };
    if dim == 0 {
        return Err(format!(
            "nothing is embedded for {} yet, so its dimension is unknown; \
             add one memory with the model enabled first",
            route.model
        ));
    }

    let (provider_kind, base_url) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![route.provider_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|_| format!("embedding provider {} not found", route.provider_id))?
    };
    let api_key = crate::services::get_api_key(&route.provider_id);
    let provider: Box<dyn Provider> = match provider_kind.as_str() {
        "ollama" => Box::new(crate::providers::ollama::OllamaProvider::new(
            base_url, api_key,
        )),
        "openai_compat" => Box::new(crate::providers::openai_compat::OpenAiCompatProvider::new(
            base_url, api_key,
        )),
        other => return Err(format!("unknown provider kind: {}", other)),
    };

    crate::memory::index::fill_index(&pool, provider.as_ref(), &route.model, dim, embed_notes).await
}

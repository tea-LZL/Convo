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
///
/// `&Arc<DbPool>` rather than `&State<'_, Arc<DbPool>>` so a caller that is
/// not a Tauri command can reach it. `State` derefs to the `Arc`, so every
/// command-side call site is unaffected. `chat_stream.rs` embeds a query on
/// the send path and resolves its own route, because a route handed down by
/// a caller is a route a caller can get wrong — and the answer to "which
/// provider embeds" must have exactly one copy.
pub(crate) fn embedding_route(pool: &Arc<DbPool>) -> Option<(String, String)> {
    let conn = pool.get().ok()?;
    config::load_routing(&conn)
        .embedding
        .map(|r| (r.provider_id, r.model))
}

/// Embed one string, or `None`. Never surfaces an error to the caller:
/// every failure is a reason to fall back to keyword recall.
///
/// `&Arc<DbPool>` for the same reason as [`embedding_route`]. No connection
/// is held across the `embed` call, or the future would not be `Send` and
/// the command could not be spawned.
pub(crate) async fn embed_query(
    pool: &Arc<DbPool>,
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
#[serde(rename_all = "camelCase")]
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
    extract_and_revise(pool.inner(), &session_id, model_id, provider_id).await
}

/// The body behind `memory_extract_and_revise`, over a plain pool reference
/// so tests can call it without a Tauri state.
pub(crate) async fn extract_and_revise(
    pool: &Arc<DbPool>,
    session_id: &str,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<crate::memory::revise::Applied>, String> {
    let (window, extraction_route) = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        if !config::auto_extract(&conn) {
            return Ok(Vec::new());
        }
        // `every_n = 1` is "run on every completed exchange". The previous
        // fixed value of 2 meant a first exchange never qualified — a fresh
        // chat that says "remember my cat is named Mao Mao" and gets its
        // answer produced two messages, below the four-message threshold,
        // and nothing was extracted or even recorded. The `memory.auto_extract`
        // setting is the user's off switch; the window is the cost control.
        let window = crate::memory::extract::should_extract(&conn, session_id, 1)
            .map_err(|e| e.to_string())?;
        let routing = config::load_routing(&conn);
        (
            window,
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

    let facts = match crate::memory::extract::run_extraction(pool, &window, extraction_route).await
    {
        Ok(facts) => facts,
        Err(e) => {
            tracing::warn!("extraction failed for {}: {}", session_id, e);
            {
                let conn = pool.get().map_err(|e| e.to_string())?;
                crate::commands::memory_reviews::record_extraction_failure(&conn, session_id, &e)?;
            }
            return Ok(Vec::new());
        }
    };

    let applied = apply_round(pool, session_id, &facts).await;

    let conn = pool.get().map_err(|e| e.to_string())?;
    crate::memory::extract::set_watermark(&conn, session_id, &window.watermark_message_id)?;
    Ok(applied)
}

/// Apply one round of candidates, and record what produced what.
///
/// Note candidates are applied **first**, and that order is the whole point:
/// `memory_items.source_note_id` is a foreign claim, and a note's id only
/// exists once the note has been inserted. A candidate applied before the
/// note cannot be linked to a note that has not been written yet, so a round
/// that inserts a note and a fact together has to write the note first.
///
/// ## What "produced" means here, precisely
///
/// Same round, one note. A round of extraction reads one window of one
/// conversation and returns the items it found there; when one of those
/// items is a long-form note (`is_note`), the others came from the same
/// material in the same pass. The link is recorded only where the round
/// *created* the memory — `Added`, and the replacement a `Supersede` adds.
/// A `Reinforce` or a `Merged` writes into a memory that already existed,
/// and attributing a pre-existing memory to a note written seconds ago is a
/// false claim about origin, not provenance.
///
/// A round with no note links nothing. There is no other candidate parent
/// and inventing one is the bug this function exists to close.
///
/// A round with **several** notes links nothing, and says so in the log.
/// `source_note_id` holds one note, and nothing in the round's output says
/// which of the two documents a given fact belongs to — candidate order is
/// the order a model happened to emit, not a hierarchy. Picking the first
/// would put a claim on screen that the user cannot check and would have to
/// unlink by hand; a missing link is a gap they can see and fill, a wrong
/// one is a lie they have to disprove. The two notes are still there, and
/// the user can attach their own memories from the Notes tab.
///
/// Failures stay per-candidate: one candidate the revision pass cannot
/// apply must not abandon the rest of the round. The returned list is in
/// application order, so a note comes before the facts it came from.
pub(crate) async fn apply_round(
    pool: &Arc<DbPool>,
    session_id: &str,
    facts: &[crate::memory::extract::ExtractedFact],
) -> Vec<crate::memory::revise::Applied> {
    use crate::memory::revise::{apply_candidate, Applied};

    let mut applied: Vec<Applied> = Vec::with_capacity(facts.len());
    let (note_candidates, other_candidates): (Vec<_>, Vec<_>) =
        facts.iter().partition(|c| c.is_note);

    let mut note_ids: Vec<String> = Vec::new();
    for candidate in &note_candidates {
        match apply_candidate(pool, session_id, candidate).await {
            // Only an inserted note has an id to link to. Every other
            // outcome is an existing row the round did not create.
            Ok(Applied::Added { id }) => {
                note_ids.push(id.clone());
                applied.push(Applied::Added { id });
            }
            Ok(other) => applied.push(other),
            Err(e) => tracing::warn!("revision failed for a note candidate: {}", e),
        }
    }

    let origin: Option<&str> = match note_ids.as_slice() {
        [] => None,
        [only] => Some(only),
        ambiguous => {
            tracing::info!(
                notes = ambiguous.len(),
                session_id,
                "a round that produced several notes has no single origin for its \
                 memories, so they are left unlinked rather than attributed to one"
            );
            None
        }
    };

    let mut to_link: Vec<String> = Vec::new();
    for candidate in &other_candidates {
        match apply_candidate(pool, session_id, candidate).await {
            Ok(outcome) => {
                // `origin` is the same note for the whole round, so one read
                // of it is enough; only the memory id is per-candidate.
                if let (Some(_), Some(memory_id)) = (origin, created_memory_id(&outcome)) {
                    to_link.push(memory_id.to_string());
                }
                applied.push(outcome);
            }
            Err(e) => tracing::warn!("revision failed for a candidate: {}", e),
        }
    }

    if let Some(note_id) = origin {
        if let Ok(conn) = pool.get() {
            for memory_id in to_link {
                if let Err(e) = crate::commands::memory::set_source_note(&conn, note_id, &memory_id)
                {
                    tracing::warn!("could not record provenance: {}", e);
                }
            }
        } else {
            tracing::warn!("could not reach the database to record provenance");
        }
    }

    applied
}

/// The memory row this outcome created, if it created one.
///
/// `Supersede` inserts its replacement through the same `add` path and
/// reports it as `new_id`, so it counts; `Reinforce` and `Merge` write into
/// a row that was already there and do not.
fn created_memory_id(applied: &crate::memory::revise::Applied) -> Option<&str> {
    use crate::memory::revise::Applied;
    match applied {
        Applied::Added { id } => Some(id.as_str()),
        Applied::Superseded { new_id, .. } => Some(new_id.as_str()),
        _ => None,
    }
}

/// Fill in the vectors that are missing, and rebuild them if the
/// embedding model changed.
///
/// `knowledge_index_status` reports how many rows are unembedded, and this
/// is the only thing that reduces that number for rows extraction did not
/// create: memories added by hand, notes, and anything written while the
/// embedding route was unconfigured or failing.
///
/// The dimension comes from what is already stored when there is something
/// stored, and from the first vector the provider returns when there is
/// not. A configured model and the vectors on disk are the only two
/// sources, and if they disagree the stored vectors are the truth about
/// what this index holds — mixing the two would produce confident wrong
/// scores rather than a visible error. A zero dimension is the empty-index
/// bootstrap, not a failure: this command is the way the first vector gets
/// written, so it cannot require one to already exist.
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

#[cfg(test)]
mod tests {
    use super::{apply_round, extract_and_revise};
    use crate::memory::extract::ExtractedFact;

    /// A migrated in-memory pool, one connection, so `:memory:` is the same
    /// database on every `get()`.
    ///
    /// No embedding route is configured, which is the honest way to make
    /// `apply_candidate` deterministic: with no comparable vector every
    /// candidate looks brand new, so the decision table's only live branch
    /// is ADD, and the provenance under test is not a side effect of a
    /// network call that never happens in a test anyway.
    fn migrated_pool() -> std::sync::Arc<crate::db::DbPool> {
        use r2d2::Pool;
        use r2d2_sqlite::SqliteConnectionManager;
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .expect("pool");
        {
            let mut conn = pool.get().unwrap();
            crate::db::migrations_for_tests()
                .to_latest(&mut conn)
                .unwrap();
            conn.execute("INSERT INTO sessions (id, title) VALUES ('s1', 'S')", [])
                .unwrap();
        }
        std::sync::Arc::new(pool)
    }

    /// A fact at a confidence that auto-applies. Below
    /// `AUTO_ADD_CONFIDENCE` the candidate goes to the review inbox instead
    /// of the index, and this module is about the index.
    fn fact(content: &str) -> ExtractedFact {
        ExtractedFact {
            kind: "project_fact".into(),
            title: Some(content.into()),
            content: content.into(),
            tags: None,
            confidence: 0.9,
            is_note: false,
            note_body: None,
        }
    }

    fn note(title: &str) -> ExtractedFact {
        ExtractedFact {
            kind: "project_fact".into(),
            title: Some(title.into()),
            content: format!("{title}: the short form"),
            tags: None,
            confidence: 0.9,
            is_note: true,
            note_body: Some(format!("# {title}\n\nthe long form")),
        }
    }

    /// Every memory's `source_note_id`, by content, so the assertions read
    /// as the round rather than as uuids.
    fn links_by_content(pool: &std::sync::Arc<crate::db::DbPool>) -> Vec<(String, Option<String>)> {
        let conn = pool.get().unwrap();
        let mut stmt = conn
            .prepare("SELECT content, source_note_id FROM memory_items ORDER BY content")
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn note_ids(pool: &std::sync::Arc<crate::db::DbPool>) -> Vec<String> {
        let conn = pool.get().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM notes ORDER BY title").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    /// The bug this file was given: `source_note_id` was a `pub` surface that
    /// nothing in production ever wrote, so the Notes tab's linked-memories
    /// section and the Memory tab's "from note" chip rendered a correct
    /// empty state forever. A provenance feature that looks present and never
    /// shows anything is worse than no feature.
    ///
    /// The round is deliberately written note-last: a loop that applied
    /// candidates in arrival order could not link a fact that arrived before
    /// the note it came from, because the note's id does not exist until the
    /// note is inserted. That is the whole reason for the two passes.
    #[tokio::test]
    async fn a_round_that_produced_a_note_links_its_facts_to_it() {
        let pool = migrated_pool();
        let facts = vec![
            fact("Convo is a Tauri 2 chat client"),
            note("Release runbook"),
            fact("Releases are tagged, pushed, then left to CI"),
        ];

        let applied = apply_round(&pool, "s1", &facts).await;
        assert_eq!(applied.len(), 3, "every candidate applied: {applied:?}");

        let ids = note_ids(&pool);
        assert_eq!(ids.len(), 1, "the round wrote one note");
        let note_id = ids[0].as_str();
        let links = links_by_content(&pool);
        assert_eq!(links.len(), 2, "two memories from two facts: {links:?}");
        for (content, source) in &links {
            assert_eq!(
                source.as_deref(),
                Some(note_id),
                "{content} came out of the same round as the note, so it carries its id"
            );
        }

        // And the read the UI actually does. `list_note_titles` is the title
        // projection the Memory tab resolves every row's "from note" chip
        // with, and its `memory_ids` was always `[]` while nothing wrote the
        // column.
        let (titles, memory_ids) = {
            let conn = pool.get().unwrap();
            let titles = crate::commands::notes::all_note_titles(&conn).unwrap();
            let mut stmt = conn
                .prepare("SELECT id FROM memory_items ORDER BY content")
                .unwrap();
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect::<Vec<_>>();
            (titles, ids)
        };
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].title.as_deref(), Some("Release runbook"));
        let mut resolved = titles[0].memory_ids.clone();
        resolved.sort();
        let mut expected = memory_ids;
        expected.sort();
        assert_eq!(resolved, expected, "the projection resolves the links");
    }

    /// A round with no note has no candidate parent, and the honest answer
    /// is none. A link invented here would be a claim about origin that
    /// nothing in the data supports.
    #[tokio::test]
    async fn a_round_with_no_note_links_nothing() {
        let pool = migrated_pool();
        let facts = vec![
            fact("The user prefers concise replies"),
            fact("Convo uses SQLite"),
        ];

        apply_round(&pool, "s1", &facts).await;

        assert!(note_ids(&pool).is_empty(), "the round wrote no note");
        for (content, source) in links_by_content(&pool) {
            assert_eq!(
                source, None,
                "{content} was extracted with no note in the round, so it has no origin"
            );
        }
    }

    /// The ambiguous case, pinned because it is a decision and not an
    /// oversight. Two notes in one round and `source_note_id` holds one
    /// note: nothing in the round says which document a fact belongs to, and
    /// candidate order is the order a model emitted them in. Leaving the
    /// siblings unlinked is the answer that cannot be a false claim; taking
    /// the first note would put a link on screen that the user would have to
    /// disprove by hand.
    #[tokio::test]
    async fn a_round_with_several_notes_leaves_its_facts_unlinked() {
        let pool = migrated_pool();
        let facts = vec![
            note("Release runbook"),
            note("On-call notes"),
            fact("Releases are tagged, pushed, then left to CI"),
        ];

        apply_round(&pool, "s1", &facts).await;

        assert_eq!(note_ids(&pool).len(), 2, "both notes were written");
        for (content, source) in links_by_content(&pool) {
            assert_eq!(
                source, None,
                "{content} has two candidate parents and no evidence for either"
            );
        }
    }

    /// The note is written first whatever the round's order says, so a fact
    /// can be linked to a note the same round created.
    #[tokio::test]
    async fn a_note_is_applied_before_the_facts_it_came_from() {
        let pool = migrated_pool();
        let facts = vec![
            fact("Convo is a Tauri 2 chat client"),
            note("Release runbook"),
        ];

        let applied = apply_round(&pool, "s1", &facts).await;

        use crate::memory::revise::Applied;
        let first_is_a_note =
            matches!(&applied[0], Applied::Added { id } if note_ids(&pool).contains(id));
        assert!(
            first_is_a_note,
            "the note was applied second, so its id did not exist when the fact was written: {applied:?}"
        );
    }

    /// A failed extraction leaves a failed inbox row and does not advance the
    /// watermark. An empty result alone cannot tell "nothing durable" from
    /// "the model was unreachable"; the failed row is what makes the second
    /// case visible, and leaving the watermark alone keeps the unprocessed
    /// messages eligible for the next round.
    #[tokio::test]
    async fn a_failed_extraction_leaves_a_failed_inbox_row() {
        let pool = migrated_pool();
        {
            let conn = pool.get().unwrap();
            for (i, (role, content)) in [
                ("user", "The user's birthday is February 18th."),
                ("assistant", "Noted."),
                ("user", "Convo is a Tauri 2 chat client."),
                ("assistant", "Understood."),
            ]
            .iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?1, 's1', ?2, ?3, ?4)",
                    rusqlite::params![
                        format!("seed-{i}"),
                        role,
                        content,
                        format!("2026-01-01T00:00:0{i}Z"),
                    ],
                )
                .unwrap();
            }
        }

        // No extraction route is configured and no per-call model is passed,
        // so the model call fails before any network use.
        let applied = extract_and_revise(&pool, "s1", None, None).await.unwrap();
        assert!(
            applied.is_empty(),
            "a failed extraction applies nothing: {applied:?}"
        );

        let (status, error, facts_json): (String, String, String) = pool
            .get()
            .unwrap()
            .query_row(
                "SELECT status, error, facts_json FROM pending_memory_reviews WHERE session_id = 's1' ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert!(
            !error.is_empty(),
            "the inbox row must say why extraction failed"
        );
        assert_eq!(facts_json, "[]");

        let watermarks: i64 = pool
            .get()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM memory_watermark WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermarks, 0, "a failed round must not consume the window");
    }

    /// The after-a-turn trigger must reach the model on the first exchange,
    /// not skip it. A session with one exchange and no extraction route
    /// fails loudly — a failed inbox row — rather than returning an empty
    /// result that is indistinguishable from "nothing durable was said".
    /// This is the fix for the "remember X" in a fresh chat that silently
    /// did nothing: the threshold used to be two exchanges.
    #[tokio::test]
    async fn a_single_exchange_reaches_extraction_rather_than_being_skipped() {
        let pool = migrated_pool();
        {
            let conn = pool.get().unwrap();
            for (i, (role, content)) in [
                ("user", "remember that my cat is named Mao Mao"),
                (
                    "assistant",
                    "I will remember that your cat is named Mao Mao.",
                ),
            ]
            .iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?1, 's1', ?2, ?3, ?4)",
                    rusqlite::params![
                        format!("one-{i}"),
                        role,
                        content,
                        format!("2026-01-01T00:00:0{i}Z"),
                    ],
                )
                .unwrap();
            }
        }

        // No extraction route and no per-call model, so the model call fails
        // before any network use. The point is that it is attempted at all.
        let applied = extract_and_revise(&pool, "s1", None, None).await.unwrap();
        assert!(applied.is_empty(), "a failed round applies nothing");

        let status: String = pool
            .get()
            .unwrap()
            .query_row(
                "SELECT status FROM pending_memory_reviews WHERE session_id = 's1' ORDER BY created_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "failed",
            "the first exchange was skipped instead of attempted"
        );
    }
}

//! Retrieval: the fusion core.
//!
//! This file is deliberately split in two halves. The functions above the
//! `// --- SQL routes ---` marker are pure: plain values in, plain values
//! out, no database and no provider in scope. That is what makes the
//! scoring rules testable without a fixture, and what lets a change to the
//! fusion be evaluated apart from a change to the queries.
//!
//! The pipeline, in order:
//!
//! 1. BM25 over `memory_fts` and `notes_fts` — one ranked list each.
//! 2. Cosine over stored vectors — one ranked list.
//! 3. Reciprocal Rank Fusion over those three lists.
//! 4. Reinforcement and recency boosts.
//! 5. Maximal Marginal Relevance, so three restatements of one fact do
//!    not occupy the whole context budget.
//!
//! Every step degrades to an empty route rather than an error. A user with
//! no embedding model configured, an unreachable embed endpoint, or an
//! empty index still gets whatever the keyword route can find. That is the
//! contract in spec 6.4, and it is a deliberate choice: a degraded result
//! beats a failed send.

use super::config;
use super::embed::{cosine, KnowledgeRow};

/// One candidate, with its position in each retrieval route.
///
/// A route the candidate did not appear in is `None`, not zero. A rank of
/// zero would be a better-than-best score, which is how off-by-one bugs
/// become silent ranking bugs.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub row: KnowledgeRow,
    pub bm25_rank: Option<usize>,
    pub cosine_rank: Option<usize>,
    pub cosine: Option<f64>,
    /// Text the keyword route matched, for the reason string.
    pub matched_terms: Vec<String>,
}

/// A ranked result, ready to render in the Memory tab and to cross the
/// IPC boundary, so it is `Serialize` as well as comparable.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedMemory {
    pub owner_type: String,
    pub owner_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub score: f64,
    /// Why this was recalled. Always populated, never empty — a recall a
    /// user cannot audit is a recall they will not trust.
    pub reason: String,
}

/// Reciprocal Rank Fusion.
///
/// A candidate found by both routes beats one found by either, which is
/// the property that makes hybrid search worth more than either route
/// alone. `rank` is 1-based.
pub fn rrf_score(bm25_rank: Option<usize>, cosine_rank: Option<usize>, k: f64) -> f64 {
    let mut score = 0.0;
    if let Some(rank) = bm25_rank {
        score += 1.0 / (k + rank as f64);
    }
    if let Some(rank) = cosine_rank {
        score += 1.0 / (k + rank as f64);
    }
    score
}

/// The default lambda for [`diversify`]: how strongly score outweighs
/// redundancy. Above 0.5 keeps the best-scoring item first; below it
/// prefers breadth. The spec pins 0.7.
pub const DEFAULT_LAMBDA: f64 = 0.7;

/// The reinforcement cap from the spec. Without it an item recalled fifty
/// times would outrank everything regardless of how relevant it is.
pub const REINFORCEMENT_CAP: i64 = 10;
/// The reinforcement weight per recall, past the first.
pub const REINFORCEMENT_WEIGHT: f64 = 0.15;

/// Reinforcement and recency, applied to a fused score.
pub fn boost(rrf: f64, access_count: i64, age_days: f64) -> f64 {
    let _ = config::RRF_K;
    let reinforced = 1.0 + REINFORCEMENT_WEIGHT * access_count.clamp(0, REINFORCEMENT_CAP) as f64;
    rrf * reinforced * super::embed::recency_weight(age_days)
}

/// Maximal Marginal Relevance.
///
/// Greedy: repeatedly take whichever remaining candidate has the best
/// `lambda * score - (1 - lambda) * redundancy`, where redundancy is the
/// highest similarity to anything already chosen. That is what stops three
/// restatements of one fact from taking three of the top slots.
///
/// Where a candidate has no vector, or nothing comparable is already
/// chosen, it falls back to pure score order. A keyword-only recall has no
/// vectors at all, and returning nothing there would be worse than
/// returning the obvious list.
pub fn diversify(
    mut scored: Vec<(RankedMemory, Option<Vec<f32>>)>,
    lambda: f64,
    limit: usize,
) -> Vec<RankedMemory> {
    // Highest score first, so the greedy pick starts from the best.
    scored.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut chosen: Vec<(RankedMemory, Option<Vec<f32>>)> = Vec::new();
    while chosen.len() < limit && !scored.is_empty() {
        let mut best_index = 0usize;
        let mut best_value = f64::NEG_INFINITY;
        for (index, (item, vector)) in scored.iter().enumerate() {
            let redundancy = match vector {
                None => 0.0,
                Some(v) => chosen
                    .iter()
                    .filter_map(|(_, other)| other.as_ref())
                    .filter_map(|other| cosine(v, other))
                    .fold(0.0f64, f64::max),
            };
            let value = lambda * item.score - (1.0 - lambda) * redundancy;
            if value > best_value {
                best_value = value;
                best_index = index;
            }
        }
        chosen.push(scored.remove(best_index));
    }
    chosen.into_iter().map(|(item, _)| item).collect()
}

/// Build the reason string.
///
/// Names the routes that matched, the text the keyword route hit on, how
/// often the item has been recalled, and how old it is. That is enough for
/// a user to judge whether a recall was right, which is what the Memory tab
/// is for.
pub fn build_reason(
    bm25_rank: Option<usize>,
    cosine: Option<f64>,
    matched_terms: &[String],
    access_count: i64,
    age_days: f64,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    match (bm25_rank.is_some(), cosine.is_some()) {
        (true, true) => parts.push("keyword and semantic match".to_string()),
        (true, false) => parts.push("keyword match".to_string()),
        (false, true) => parts.push("semantic match".to_string()),
        (false, false) => parts.push("weak match".to_string()),
    }
    if !matched_terms.is_empty() {
        let shown: Vec<&str> = matched_terms.iter().take(3).map(|s| s.as_str()).collect();
        parts.push(format!("on {}", shown.join(", ")));
    }
    if access_count > 0 {
        parts.push(format!("recalled {}x", access_count));
    }
    if age_days >= 1.0 {
        let days = age_days.round() as i64;
        parts.push(format!(
            "updated {} day{} ago",
            days,
            if days == 1 { "" } else { "s" }
        ));
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_candidate_in_both_routes_beats_one_in_either() {
        let both = rrf_score(Some(1), Some(1), config::RRF_K);
        let keyword_only = rrf_score(Some(1), None, config::RRF_K);
        let semantic_only = rrf_score(None, Some(1), config::RRF_K);
        assert!(both > keyword_only, "{both} vs {keyword_only}");
        assert!(both > semantic_only, "{both} vs {semantic_only}");
        assert!(
            (keyword_only - semantic_only).abs() < 1e-12,
            "the two routes must be symmetric"
        );
    }

    #[test]
    fn a_candidate_in_no_route_scores_zero() {
        assert_eq!(rrf_score(None, None, config::RRF_K), 0.0);
    }

    #[test]
    fn rank_one_outranks_rank_two_within_a_route() {
        assert!(rrf_score(Some(1), None, 60.0) > rrf_score(Some(2), None, 60.0));
    }

    #[test]
    fn the_rrf_constant_actually_shapes_the_curve() {
        // A regression to k=1 would flatten the separation between top
        // ranks; k=1e9 would make every candidate score the same. Pin the
        // shape, not just the constant.
        let small = rrf_score(Some(1), Some(1), 1.0) - rrf_score(Some(10), Some(10), 1.0);
        let large = rrf_score(Some(1), Some(1), 60.0) - rrf_score(Some(10), Some(10), 60.0);
        assert!(small > large, "a smaller k must separate top ranks more");
    }

    #[test]
    fn reinforcement_lifts_a_repeatedly_recalled_item() {
        let fresh = boost(0.5, 0, 0.0);
        let reinforced = boost(0.5, 7, 0.0);
        assert!(reinforced > fresh, "{reinforced} vs {fresh}");
    }

    #[test]
    fn reinforcement_is_capped_so_one_item_cannot_dominate_forever() {
        assert_eq!(boost(0.5, 10, 0.0), boost(0.5, 500, 0.0));
        assert!(boost(0.5, 9, 0.0) < boost(0.5, 10, 0.0));
    }

    #[test]
    fn recency_lowers_but_never_zeroes_a_score() {
        let now = boost(0.5, 0, 0.0);
        let week = boost(0.5, 0, 7.0);
        let month = boost(0.5, 0, 30.0);
        assert!(week < now, "{week} vs {now}");
        assert!(month < week, "within the decay range, older scores lower");
        assert!(
            month > 0.0,
            "an old item must not be scored out of existence"
        );
    }

    #[test]
    fn recency_stops_at_its_floor_rather_than_decaying_forever() {
        // One half-life is where the floor is reached. Past it, age keeps
        // mattering not at all: a durable fact should not keep losing
        // relevance purely for being old, because that is the "the app
        // forgot" failure mode. Age breaks ties between comparably
        // relevant items; it does not expire them.
        let at_floor = boost(0.5, 0, config::RECENCY_HALF_LIFE_DAYS);
        let decade = boost(0.5, 0, 3650.0);
        let century = boost(0.5, 0, 365_000.0);
        assert_eq!(at_floor, decade, "past the floor, age stops mattering");
        assert_eq!(decade, century);
    }

    #[test]
    fn a_zero_rrf_stays_zero_through_boosting() {
        assert_eq!(boost(0.0, 100, 0.0), 0.0);
    }

    fn ranked(id: &str, score: f64) -> RankedMemory {
        RankedMemory {
            owner_type: "memory".into(),
            owner_id: id.into(),
            kind: "project_fact".into(),
            title: None,
            content: "c".into(),
            score,
            reason: "r".into(),
        }
    }

    #[test]
    fn diversify_demotes_a_near_duplicate_when_the_limit_forces_a_choice() {
        let v1 = vec![1.0f32, 0.0, 0.0];
        let v2 = vec![0.0f32, 1.0, 0.0];
        let near = vec![0.99f32, 0.01, 0.0];
        let build = || {
            vec![
                (ranked("a", 0.9), Some(v1.clone())),
                (ranked("a-dup", 0.89), Some(near.clone())),
                (ranked("b", 0.5), Some(v2.clone())),
            ]
        };

        // With room for everything, MMR reorders rather than drops: the
        // near-duplicate is pushed behind the distinct item even though it
        // scores higher on its own.
        let picked = diversify(build(), 0.7, 3);
        let all: Vec<&str> = picked.iter().map(|r| r.owner_id.as_str()).collect();
        assert_eq!(
            all,
            vec!["a", "b", "a-dup"],
            "MMR reorders, it does not drop"
        );
        assert!(
            all.iter().position(|id| *id == "b") < all.iter().position(|id| *id == "a-dup"),
            "the distinct item should outrank the restatement"
        );

        // Under a tighter limit the restatement loses its slot entirely.
        let picked = diversify(build(), 0.7, 2);
        let two: Vec<&str> = picked.iter().map(|r| r.owner_id.as_str()).collect();
        assert_eq!(two, vec!["a", "b"], "a near-duplicate took the slot");
    }

    #[test]
    fn diversify_keeps_distinct_items() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let scored = vec![(ranked("a", 0.9), Some(a)), (ranked("b", 0.89), Some(b))];
        assert_eq!(diversify(scored, 0.7, 5).len(), 2);
    }

    #[test]
    fn diversify_falls_back_to_score_order_when_vectors_are_absent() {
        // A keyword-only recall has no vectors. It must still return a
        // ranked list, not an error and not an empty one.
        let scored = vec![
            (ranked("a", 0.9), None),
            (ranked("b", 0.8), None),
            (ranked("c", 0.7), None),
        ];
        let out = diversify(scored, 0.7, 5);
        let ids: Vec<&str> = out.iter().map(|r| r.owner_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn diversify_ignores_a_zero_vector_rather_than_treating_it_as_similar_to_all() {
        let zero = vec![0.0f32, 0.0, 0.0];
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let scored = vec![
            (ranked("a", 0.9), Some(a)),
            (ranked("zero", 0.89), Some(zero)),
            (ranked("b", 0.5), Some(b)),
        ];
        assert_eq!(
            diversify(scored, 0.7, 5).len(),
            3,
            "cosine returns None for a zero vector, so nothing is similar to it"
        );
    }

    #[test]
    fn diversify_respects_the_limit() {
        let scored: Vec<_> = (0..20)
            .map(|i| (ranked(&format!("m{}", i), 1.0 - i as f64 * 0.01), None))
            .collect();
        assert_eq!(diversify(scored, 0.7, 6).len(), 6);
    }

    #[test]
    fn a_reason_is_always_populated() {
        // (bm25 rank, cosine, matched terms, recall count, age in days)
        let no_routes: (Option<usize>, Option<f64>, &[&str], i64, f64) = (None, None, &[], 0, 0.0);
        let both: (Option<usize>, Option<f64>, &[&str], i64, f64) =
            (Some(1), Some(0.9), &["postgres"], 0, 0.0);
        let keyword_only: (Option<usize>, Option<f64>, &[&str], i64, f64) =
            (Some(4), None, &[], 7, 4.0);
        for (rank, cos, terms, count, age) in [no_routes, both, keyword_only] {
            let owned: Vec<String> = terms.iter().map(|s| s.to_string()).collect();
            let reason = build_reason(rank, cos, &owned, count, age);
            assert!(!reason.trim().is_empty(), "empty reason for {rank:?}");
        }
    }

    #[test]
    fn the_reason_names_the_routes_that_matched() {
        let both = build_reason(Some(1), Some(0.87), &["migration".to_string()], 0, 0.0);
        assert!(both.contains("keyword"), "{both}");
        assert!(both.contains("semantic"), "{both}");
        assert!(both.contains("migration"), "{both}");

        let keyword = build_reason(Some(1), None, &["postgres".to_string()], 0, 0.0);
        assert!(keyword.contains("keyword"), "{keyword}");
        assert!(!keyword.contains("semantic"), "{keyword}");

        let semantic = build_reason(None, Some(0.9), &[], 0, 0.0);
        assert!(semantic.contains("semantic"), "{semantic}");
        assert!(!semantic.contains("keyword"), "{semantic}");
    }

    #[test]
    fn the_reason_reports_reinforcement_and_age_when_present() {
        let reason = build_reason(Some(1), None, &["x".to_string()], 7, 4.0);
        assert!(reason.contains('7'), "{reason}");
        assert!(reason.contains("day"), "{reason}");
    }
}

// --- SQL routes ------------------------------------------------------------
//
// Everything above this marker is pure. Everything below talks to SQLite.
// The split is deliberate: it is what let the scoring rules be tested
// without a fixture, and it keeps the query shapes reviewable in one
// place.

use rusqlite::params;

/// Words that carry no retrieval signal. Without this, a query like
/// "which database" needs "which" in the document, because the FTS
/// expression ANDs every token.
const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "this", "that", "what", "which", "how", "does", "can", "from",
    "into", "are", "was", "were", "have", "has", "had", "not", "but", "you", "your", "they",
    "them", "then", "than", "when", "where", "who", "why", "will", "would", "should", "could",
    "there", "their", "been", "being", "does", "doing", "just", "like", "some",
];

/// First-person tokens, kept *before* stop-word removal. "my" and "i" are
/// too short to survive into the FTS expression, and they are the only
/// signal that a question is about the user rather than about a name in
/// the project.
const SELF_PRONOUNS: &[&str] = &["i", "im", "me", "my", "mine", "myself"];

/// One identity concept. FTS tokenizes `name` and `nickname` as unrelated
/// words, so "what's my name?" misses a memory titled "User nickname".
/// This is that one group, not a synonym list: it is consulted only when
/// the question is about the user.
const IDENTITY_TERMS: &[&str] = &["name", "nickname", "username", "handle", "called"];

/// Everything the routes need. `embedding_model: None` disables the vector
/// route rather than failing: a user with no embedding model configured
/// still gets keyword recall, which is the most likely first-run state.
#[derive(Debug, Clone)]
pub struct RecallOptions<'a> {
    pub query: &'a str,
    pub session_id: Option<&'a str>,
    pub embedding_model: Option<String>,
    pub embedding_dim: Option<usize>,
    /// `None` means every kind. An empty `Some` would filter everything
    /// out, so the reader treats empty as unset.
    pub kinds: Option<Vec<String>>,
    pub top_k: usize,
    pub lambda: f64,
}

/// Every alphanumeric token, including the short ones and the stop words.
///
/// [`fts_expression`] drops those before building MATCH syntax. Identity
/// questions are decided here, while "my" and "who" are still visible.
fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let token = raw.to_lowercase();
        if token.is_empty() || tokens.contains(&token) {
            continue;
        }
        tokens.push(token);
    }
    tokens
}

/// Whether this question is asking who the user is.
///
/// Self-reference alone is not enough: "what editor do I use" is about
/// the user and must stay a normal keyword query. The question also has
/// to be an identity one — a name, a nickname, or "who am I".
fn identity_question(tokens: &[String]) -> bool {
    let about_self = tokens.iter().any(|t| SELF_PRONOUNS.contains(&t.as_str()));
    about_self
        && tokens
            .iter()
            .any(|t| t == "who" || IDENTITY_TERMS.contains(&t.as_str()))
}

/// `("name" OR "nickname" OR ...)`. One clause, so a question about a
/// name still matches a memory that only says nickname.
fn identity_clause() -> String {
    let parts = IDENTITY_TERMS
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("({parts})")
}

fn quote_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', ""))
}

/// Build an FTS5 MATCH expression from a free-text query.
///
/// Tokens shorter than three characters and stop words are dropped, and
/// the rest are quoted so a token containing FTS operators cannot become
/// syntax. Returns `None` when nothing survives, which the caller treats
/// as "no keyword route" rather than as an error.
///
/// An identity question is the exception. Its content word is expanded to
/// the identity group, and a question like "who am I" — which otherwise
/// survives as no tokens at all, because every word is a stop word or too
/// short — searches that group instead of searching for nothing.
fn fts_expression(query: &str, join: &str) -> Option<(String, Vec<String>)> {
    let raw = query_tokens(query);
    let identity = identity_question(&raw);
    let mut tokens: Vec<String> = Vec::new();
    for token in &raw {
        if token.len() < 3 || STOP_WORDS.contains(&token.as_str()) {
            continue;
        }
        if !tokens.contains(token) {
            tokens.push(token.clone());
        }
    }
    if tokens.is_empty() {
        if !identity {
            return None;
        }
        return Some((
            identity_clause(),
            IDENTITY_TERMS
                .iter()
                .map(|term| (*term).to_string())
                .collect(),
        ));
    }
    let expression = tokens
        .iter()
        .map(|token| {
            if identity && IDENTITY_TERMS.contains(&token.as_str()) {
                identity_clause()
            } else {
                quote_token(token)
            }
        })
        .collect::<Vec<_>>()
        .join(join);
    Some((expression, tokens))
}

/// One BM25 result, already filtered.
struct Bm25Hit {
    row: KnowledgeRow,
    /// 1-based position within its own FTS table's ranking. FTS5's `rank`
    /// is only comparable within one table, which is exactly why the
    /// memories and notes routes stay separate and are fused as two lists.
    rank: usize,
    terms: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
fn memory_bm25(
    conn: &rusqlite::Connection,
    expression: &str,
    terms: &[String],
    kinds_json: &str,
    allowlist: &Allowlist,
    limit: usize,
) -> rusqlite::Result<Vec<Bm25Hit>> {
    // The restriction is `?3` and the ids are `?4` rather than the other way
    // round: `json_array_length = 0` has to keep meaning "unrestricted" for
    // every session that has never been scoped, and a session scoped to
    // nothing has to be expressible at all. See `Allowlist`.
    let sql = "
        SELECT m.id, m.kind, m.title, m.content, m.is_enabled,
               m.superseded_by, m.access_count, m.updated_at
        FROM memory_fts
        JOIN memory_items m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?1
          AND m.is_enabled = 1
          AND m.superseded_by IS NULL
          AND m.kind IN (SELECT value FROM json_each(?2))
          AND (?3 = 0
               OR m.id IN (SELECT value FROM json_each(?4)))
        ORDER BY rank
        LIMIT ?5
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        params![
            expression,
            kinds_json,
            allowlist.restricted as i64,
            allowlist.json,
            limit as i64
        ],
        |row| {
            Ok(Bm25Hit {
                row: KnowledgeRow {
                    owner_type: "memory".into(),
                    owner_id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    is_enabled: row.get::<_, i64>(4)? != 0,
                    superseded_by: row.get(5)?,
                    access_count: row.get(6)?,
                    updated_at: row.get(7)?,
                },
                rank: 0,
                terms: Vec::new(),
            })
        },
    )?;
    let mut out: Vec<Bm25Hit> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for (index, hit) in out.iter_mut().enumerate() {
        hit.rank = index + 1;
        hit.terms = terms.to_vec();
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn note_bm25(
    conn: &rusqlite::Connection,
    expression: &str,
    terms: &[String],
    allowlist: &Allowlist,
    limit: usize,
) -> rusqlite::Result<Vec<Bm25Hit>> {
    // Notes carry no kind, so a kind filter cannot apply to them. When the
    // caller filtered to specific kinds, notes are excluded outright
    // rather than leaking past the filter.
    //
    // Notes answer to the same allowlist as memories, and have always done
    // so: `session_overrides` names memory ids only, so scoping a session
    // to any subset of memories also takes its notes out of keyword
    // recall. That is pre-existing, and consistent for the scoped-to-nothing
    // case as well.
    let sql = "
        SELECT n.id, n.title, n.body, n.updated_at
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?1
          AND (?2 = 0
               OR n.id IN (SELECT value FROM json_each(?3)))
        ORDER BY rank
        LIMIT ?4
    ";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        params![
            expression,
            allowlist.restricted as i64,
            allowlist.json,
            limit as i64
        ],
        |row| {
            Ok(Bm25Hit {
                row: KnowledgeRow {
                    owner_type: "note".into(),
                    owner_id: row.get(0)?,
                    kind: "note".into(),
                    title: row.get(1)?,
                    content: row.get(2)?,
                    is_enabled: true,
                    superseded_by: None,
                    access_count: 0,
                    updated_at: row.get(3)?,
                },
                rank: 0,
                terms: Vec::new(),
            })
        },
    )?;
    let mut out: Vec<Bm25Hit> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for (index, hit) in out.iter_mut().enumerate() {
        hit.rank = index + 1;
        hit.terms = terms.to_vec();
    }
    Ok(out)
}

/// The keyword route, over both FTS tables.
///
/// The strict expression ANDs every token, which is what you want when a
/// query is specific. When it finds nothing, a relaxed OR pass runs
/// instead: a three-word query where all three must appear is a high bar,
/// and returning nothing is worse than returning something weaker.
#[allow(clippy::too_many_arguments)]
fn bm25_route(
    conn: &rusqlite::Connection,
    query: &str,
    kinds_json: &str,
    allowlist: &Allowlist,
    include_notes: bool,
    limit: usize,
) -> Vec<Bm25Hit> {
    let Some((expression, terms)) = fts_expression(query, " AND ") else {
        return Vec::new();
    };
    let mut hits =
        memory_bm25(conn, &expression, &terms, kinds_json, allowlist, limit).unwrap_or_default();
    if hits.is_empty() {
        if let Some((relaxed, _)) = fts_expression(query, " OR ") {
            hits =
                memory_bm25(conn, &relaxed, &[], kinds_json, allowlist, limit).unwrap_or_default();
        }
    }
    if include_notes {
        let mut notes = note_bm25(conn, &expression, &terms, allowlist, limit).unwrap_or_default();
        if notes.is_empty() {
            if let Some((relaxed, _)) = fts_expression(query, " OR ") {
                notes = note_bm25(conn, &relaxed, &[], allowlist, limit).unwrap_or_default();
            }
        }
        hits.append(&mut notes);
    }
    hits
}

/// The vector route. Returns `(row, cosine, vector)` for everything whose
/// cosine against the query is defined.
fn cosine_route(
    conn: &rusqlite::Connection,
    query_vector: &[f32],
    model: &str,
) -> Vec<(KnowledgeRow, f64, Vec<f32>)> {
    let all = match all_indexed_rows(conn, model) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut scored: Vec<(KnowledgeRow, f64, Vec<f32>)> = Vec::new();
    for (row, vector) in all {
        if let Some(score) = cosine(query_vector, &vector) {
            if score >= config::REINFORCE_FLOOR {
                scored.push((row, score, vector));
            }
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

/// Every row that has a vector under `model`, filtered the same way the
/// keyword route filters.
///
/// One query per owner type, not one per row. The previous shape scanned
/// every embedding and then ran a `query_row` for each owner it found —
/// N+1 round trips against a <50ms p95 budget. The filters here are the
/// ones the keyword route's SQL applies, so a disabled or superseded
/// memory never reaches the vector route either; the session allowlist is
/// enforced once, after the merge, and is deliberately not repeated here.
fn all_indexed_rows(
    conn: &rusqlite::Connection,
    model: &str,
) -> rusqlite::Result<Vec<(KnowledgeRow, Vec<f32>)>> {
    let mut out: Vec<(KnowledgeRow, Vec<f32>)> = Vec::new();

    let memory_sql = "
        SELECT m.id, m.kind, m.title, m.content, m.access_count, m.updated_at,
               e.dim, e.vec
        FROM memory_embeddings e
        JOIN memory_items m ON m.id = e.owner_id
        WHERE e.model = ?1
          AND e.owner_type = 'memory'
          AND m.is_enabled = 1
          AND m.superseded_by IS NULL
        ORDER BY m.id
    ";
    let mut stmt = conn.prepare(memory_sql)?;
    let rows = stmt.query_map(params![model], |row| {
        let dim: usize = row.get(6)?;
        let bytes: Vec<u8> = row.get(7)?;
        Ok((
            KnowledgeRow {
                owner_type: "memory".into(),
                owner_id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                is_enabled: true,
                superseded_by: None,
                access_count: row.get(4)?,
                updated_at: row.get(5)?,
            },
            dim,
            bytes,
        ))
    })?;
    for row in rows {
        let (knowledge, dim, bytes) = row?;
        if let Some(vector) = super::embed::decode(&bytes, dim) {
            out.push((knowledge, vector));
        }
    }

    let note_sql = "
        SELECT n.id, n.title, n.body, n.updated_at, e.dim, e.vec
        FROM memory_embeddings e
        JOIN notes n ON n.id = e.owner_id
        WHERE e.model = ?1
          AND e.owner_type = 'note'
        ORDER BY n.id
    ";
    let mut stmt = conn.prepare(note_sql)?;
    let rows = stmt.query_map(params![model], |row| {
        let dim: usize = row.get(4)?;
        let bytes: Vec<u8> = row.get(5)?;
        Ok((
            KnowledgeRow {
                owner_type: "note".into(),
                owner_id: row.get(0)?,
                kind: "note".into(),
                title: row.get(1)?,
                content: row.get(2)?,
                is_enabled: true,
                superseded_by: None,
                access_count: 0,
                updated_at: row.get(3)?,
            },
            dim,
            bytes,
        ))
    })?;
    for row in rows {
        let (knowledge, dim, bytes) = row?;
        if let Some(vector) = super::embed::decode(&bytes, dim) {
            out.push((knowledge, vector));
        }
    }

    Ok(out)
}

/// A session's memory allowlist, resolved once per recall.
///
/// Two facts, and the second is the one the shape exists for. The SQL reads
/// `json_array_length(json) = 0` as "no restriction", which is right for a
/// session that has never touched the feature and catastrophic for one that
/// was told to admit nothing: the two are the same empty array. `restricted`
/// is the bit that tells them apart, and it is carried beside the ids
/// rather than encoded in them — a fake id inside the list would be a lie
/// the rest of the system has to know not to believe.
struct Allowlist {
    /// `["id", ...]` for the keyword route's `json_each`. Empty when nothing
    /// is admitted, which is only ever *restricted* when `restricted` is
    /// also true.
    json: String,
    /// Whether this list is a restriction at all. `false` means every memory
    /// is eligible; `true` with an empty `json` means none is.
    restricted: bool,
}

impl Allowlist {
    /// No restriction: every session with no scope row, and every recall
    /// that names no session at all.
    fn unrestricted() -> Self {
        Allowlist {
            json: "[]".to_string(),
            restricted: false,
        }
    }
}

/// Resolve a session's override list into the ids it admits and whether it
/// is a restriction.
///
/// Three answers, and the third is the reason this returns a struct:
/// no session and no rows means no restriction; rows mean the session is
/// scoped to exactly those rows; a `session_memory_scope` row with no
/// override rows means the session is scoped to nothing. An override row on
/// its own still counts as scoped, because that is what every session
/// written before the scope table existed has, and reading it as
/// unrestricted would silently widen those sessions to the whole library.
fn session_allowlist(conn: &rusqlite::Connection, session_id: Option<&str>) -> Allowlist {
    let Some(session_id) = session_id else {
        return Allowlist::unrestricted();
    };
    let mut stmt = match conn
        .prepare("SELECT item_id FROM session_overrides WHERE session_id = ?1 ORDER BY item_id")
    {
        Ok(stmt) => stmt,
        Err(e) => {
            // Degrading to no restriction is deliberate — a settings-shaped
            // row must never be the reason recall returns nothing — but
            // silence would make a corrupt overrides table look identical to
            // a healthy one. Name what failed.
            tracing::warn!("could not read session memory overrides: {}", e);
            return Allowlist::unrestricted();
        }
    };
    let rows = match stmt.query_map(rusqlite::params![session_id], |r| r.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(
                session_id,
                "could not read the session memory overrides: {}",
                e
            );
            return Allowlist::unrestricted();
        }
    };
    let mut ids: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let mut first_error: Option<rusqlite::Error> = None;
    for row in rows {
        match row {
            Ok(id) => ids.push(id),
            Err(e) => {
                skipped += 1;
                first_error.get_or_insert(e);
            }
        }
    }
    if skipped > 0 {
        // Skipping is the only direction available — an id that cannot be
        // read cannot be matched — so this WIDENS recall: a memory the user
        // excluded becomes eligible again. Better than a query error
        // emptying every session's memory, and only safe because it is
        // loud.
        tracing::warn!(
            session_id,
            skipped,
            error = ?first_error,
            "session memory overrides had unreadable rows; the memories they named are \
             eligible for recall again for this session"
        );
    }
    if !ids.is_empty() {
        return Allowlist {
            json: serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
            restricted: true,
        };
    }
    let scoped: Result<i64, rusqlite::Error> = conn.query_row(
        "SELECT COUNT(*) FROM session_memory_scope WHERE session_id = ?1",
        rusqlite::params![session_id],
        |r| r.get(0),
    );
    match scoped {
        // A scope row with no override rows: this session admits nothing,
        // and that is what the user asked for. See the migration.
        Ok(count) if count > 0 => Allowlist {
            json: "[]".to_string(),
            restricted: true,
        },
        Ok(_) => Allowlist::unrestricted(),
        Err(e) => {
            tracing::warn!(
                session_id,
                "could not read the session memory scope; treating it as unrestricted: {}",
                e
            );
            Allowlist::unrestricted()
        }
    }
}

/// The ids a session's overrides admit, or `None` when they admit all of
/// them.
///
/// `None` and an empty set are different answers and no longer overlap.
/// `None` is "no restriction" — a recall that names no session, or one
/// whose overrides could not be read, and the convention the SQL's
/// `json_array_length = 0` branch implements. `Some(empty)` is a session
/// scoped to nothing, which is the instruction "this chat has no memory".
///
/// A malformed array degrades to `None` for the same reason the read above
/// does: a bad settings-shaped row must never be the reason recall returns
/// nothing. Unlike a bad row, this one is logged — a table that is silently
/// ignored looks exactly like a healthy one, and the user cannot tell that
/// the restriction they set is not being applied.
fn admitted_ids(allowlist: &Allowlist) -> Option<std::collections::HashSet<String>> {
    if !allowlist.restricted {
        return None;
    }
    match serde_json::from_str::<Vec<String>>(&allowlist.json) {
        Ok(ids) => Some(ids.into_iter().collect()),
        Err(e) => {
            tracing::warn!(
                "could not parse the session memory allowlist, so it is not applied \
                 and every memory is eligible: {}",
                e
            );
            None
        }
    }
}

/// `None` and an empty list both mean "every kind", because a filter that
/// matches nothing is a filter that silently disables recall.
fn kinds_json(kinds: Option<&Vec<String>>) -> String {
    match kinds {
        Some(k) if !k.is_empty() => serde_json::to_string(k).unwrap_or_else(|_| "[]".to_string()),
        _ => serde_json::to_string(super::extract::KINDS).unwrap_or_else(|_| "[]".to_string()),
    }
}

/// Rank candidates, fuse, boost, and diversify.
///
/// `recall_with_query_vector` with no vector, so a keyword-only install
/// works.
pub fn recall(conn: &rusqlite::Connection, opts: &RecallOptions<'_>) -> Vec<RankedMemory> {
    recall_with_query_vector(conn, opts, &[])
}

/// [`recall`] with the query's vector supplied, so the fusion can be
/// exercised without a provider.
pub fn recall_with_query_vector(
    conn: &rusqlite::Connection,
    opts: &RecallOptions<'_>,
    query_vector: &[f32],
) -> Vec<RankedMemory> {
    let allowlist = session_allowlist(conn, opts.session_id);
    let kinds = kinds_json(opts.kinds.as_ref());
    let include_notes = opts.kinds.as_ref().is_none_or(|k| k.is_empty());
    let per_table = config::BM25_LIMIT;

    let keyword = bm25_route(
        conn,
        opts.query,
        &kinds,
        &allowlist,
        include_notes,
        per_table,
    );
    let semantic = match (opts.embedding_model.as_deref(), query_vector.is_empty()) {
        (Some(model), false) => cosine_route(conn, query_vector, model),
        _ => Vec::new(),
    };

    // Merge into candidates keyed by owner, so a row found by both routes
    // carries both ranks rather than appearing twice. A `HashSet` guards the
    // first-seen order: the old `Vec::contains` was a linear scan per
    // candidate, which is quadratic in the corpus size on a recall path with
    // a <50ms p95 budget.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut order_seen: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    let mut bm25_rank: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    let mut terms: std::collections::HashMap<(String, String), Vec<String>> =
        std::collections::HashMap::new();
    for hit in &keyword {
        let key = (hit.row.owner_type.clone(), hit.row.owner_id.clone());
        if order_seen.insert(key.clone()) {
            order.push(key.clone());
        }
        bm25_rank.insert(key.clone(), hit.rank);
        terms.insert(key, hit.terms.clone());
    }
    let mut cosine_rank: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    let mut cosine_score: std::collections::HashMap<(String, String), f64> =
        std::collections::HashMap::new();
    let mut vectors: std::collections::HashMap<(String, String), Vec<f32>> =
        std::collections::HashMap::new();
    let mut rows: std::collections::HashMap<(String, String), KnowledgeRow> =
        std::collections::HashMap::new();
    for (index, (row, score, vector)) in semantic.iter().enumerate() {
        let key = (row.owner_type.clone(), row.owner_id.clone());
        if order_seen.insert(key.clone()) {
            order.push(key.clone());
        }
        cosine_rank.insert(key.clone(), index + 1);
        cosine_score.insert(key.clone(), *score);
        vectors.insert(key.clone(), vector.clone());
        rows.insert(key, row.clone());
    }
    for hit in &keyword {
        let key = (hit.row.owner_type.clone(), hit.row.owner_id.clone());
        rows.entry(key).or_insert_with(|| hit.row.clone());
    }

    // The allowlist is a property of the *result*, not of one route, so it
    // is enforced here — once, after the merge, keyed on the same
    // `(owner_type, owner_id)` the merge used. Filtering per route is the
    // shape that produced this bug: `bm25_route` took the allowlist and
    // `cosine_route` did not, nothing checked the merged list, and the
    // vector route handed back whatever the keyword route had filtered out.
    // A third route would have inherited the same hole, and the next
    // reviewer would have to know which routes are allowlist-aware.
    //
    // The ids alone, with no owner type, because that is what the keyword
    // route's `id IN (SELECT value FROM json_each(...))` has always
    // matched on.
    //
    // The keyword route keeps its own SQL filter as well. It is a
    // narrowing optimisation and not redundant: the per-table `LIMIT` is
    // applied inside those queries, so dropping the filter there would let
    // an excluded row fill a top-N slot and push an *allowed* row past the
    // cut. Filtering after the merge is the guarantee; the SQL is what
    // keeps the guarantee from costing recall.
    if let Some(admitted) = admitted_ids(&allowlist) {
        order.retain(|(_, owner_id)| admitted.contains(owner_id));
    }

    let mut scored: Vec<(RankedMemory, Option<Vec<f32>>)> = Vec::new();
    for key in &order {
        let Some(row) = rows.get(key) else { continue };
        let bm = bm25_rank.get(key).copied();
        let co = cosine_rank.get(key).copied();
        let raw = rrf_score(bm, co, config::RRF_K);
        let age = super::embed::age_days(&row.updated_at);
        let final_score = boost(raw, row.access_count, age);
        let reason = build_reason(
            bm,
            cosine_score.get(key).copied(),
            terms.get(key).map(|t| t.as_slice()).unwrap_or(&[]),
            row.access_count,
            age,
        );
        scored.push((
            RankedMemory {
                owner_type: row.owner_type.clone(),
                owner_id: row.owner_id.clone(),
                kind: row.kind.clone(),
                title: row.title.clone(),
                content: row.content.clone(),
                score: final_score,
                reason,
            },
            vectors.get(key).cloned(),
        ));
    }
    diversify(scored, opts.lambda, opts.top_k)
}

/// `(needs_embedding, needs_reindex)` for the configured embedding model.
///
/// The Memory tab shows both, because "semantic recall is off" and "the
/// index is stale because you changed model" are different problems with
/// different fixes.
pub fn knowledge_status(conn: &rusqlite::Connection, model: &str, dim: usize) -> (i64, bool) {
    let needs = super::embed::rows_needing_embedding(conn, model, dim, false)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    let reindex = super::embed::needs_reindex(conn, model, dim).unwrap_or(false);
    (needs, reindex)
}

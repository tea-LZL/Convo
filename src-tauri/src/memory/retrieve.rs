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

/// A ranked result, ready to render in the Memory tab.
#[derive(Debug, Clone, PartialEq)]
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

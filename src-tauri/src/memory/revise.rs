//! Revision: what to do with a newly extracted fact.
//!
//! The question is not "is this fact true" — the extractor already
//! answered that, and `confidence` records its answer. The question is
//! what to do with it *given what is already known*, which is a much
//! narrower problem with a small decision table.
//!
//! An LLM judge is consulted for exactly one case: two memories close
//! enough that they might be the same thing. Below that floor the cosine
//! is decisive on its own and no call is made, so the common path costs
//! no latency and cannot be corrupted by a bad generation.

use crate::memory::config;
use crate::memory::embed::KnowledgeRow;
use crate::memory::extract::ExtractedFact;

/// What to do with a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionAction {
    /// New enough to add.
    Add,
    /// The same fact seen again. Bump the counters, union the tags.
    Reinforce,
    /// A newer statement replaces an older one. The old row is excluded
    /// from recall and retained, so the history of a correction stays
    /// readable.
    Supersede,
    /// Two near-duplicates that are not identical. Write the merged text.
    Merge,
    /// Anything ambiguous. Goes to the review inbox, never auto-written.
    Review,
}

/// The judge's answer about a near-duplicate pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Identical,
    Contradicts,
    Complements,
    /// The judge could not be read. Treated as `Review`, never as a
    /// write: a generator returning prose must not be able to rewrite a
    /// memory.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevisionDecision {
    pub action: RevisionAction,
    /// The existing memory this acts on, where one applies.
    pub target_id: Option<String>,
    /// For `Merge`, the text to store. `None` otherwise, and `None` for a
    /// merge that arrives without text — the decision never invents one.
    pub merged_content: Option<String>,
    pub reason: String,
}

/// Auto-write gates. Rewriting an existing memory takes a higher bar than
/// adding a new one, because it is the more destructive act: an add can be
/// deleted, a supersede silently changes what the model believes.
pub const AUTO_ADD_CONFIDENCE: f64 = 0.80;
pub const AUTO_REWRITE_CONFIDENCE: f64 = 0.85;

/// The nearest existing memory to a candidate, and how near.
#[derive(Debug, Clone, PartialEq)]
pub struct Nearest {
    pub row: KnowledgeRow,
    pub score: f64,
}

/// Read a judge response.
///
/// Deliberately narrow. A model that answers with a paragraph, a list, or
/// a hedged sentence has not answered, and the honest reading of that is
/// `Unreadable` — which routes to review. Accepting a verdict by substring
/// search would mean a response of "they do not CONTRADICT, they COMPLEMENT"
/// silently becomes whichever word appeared first.
pub fn parse_verdict(raw: &str) -> Verdict {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let text = value
            .get("verdict")
            .or_else(|| value.get("result"))
            .or_else(|| value.get("answer"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return match text.trim().to_ascii_uppercase().as_str() {
            "IDENTICAL" => Verdict::Identical,
            "CONTRADICTS" | "CONTRADICTION" => Verdict::Contradicts,
            "COMPLEMENTS" | "COMPLEMENTARY" => Verdict::Complements,
            _ => Verdict::Unreadable,
        };
    }
    // A bare token, and only a bare token. Anything with extra words is a
    // sentence the model is thinking out loud, not an answer.
    match trimmed.to_ascii_uppercase().as_str() {
        "IDENTICAL" => Verdict::Identical,
        "CONTRADICTS" | "CONTRADICTION" => Verdict::Contradicts,
        "COMPLEMENTS" | "COMPLEMENTARY" => Verdict::Complements,
        _ => Verdict::Unreadable,
    }
}

/// The decision table from spec 7.4, with the confidence gates applied
/// after it.
///
/// Gating after the table matters: an auto-write is never something the
/// table decided on its own, so a bug in the thresholds degrades to review
/// rather than to a silent rewrite.
pub fn decide(
    candidate: &ExtractedFact,
    cosine: Option<f64>,
    verdict: Option<Verdict>,
) -> RevisionDecision {
    let confidence = candidate.confidence;
    let action = match cosine {
        None => RevisionAction::Add,
        Some(score) if score < config::REINFORCE_FLOOR => RevisionAction::Add,
        Some(score) if score < config::DUP_FLOOR => RevisionAction::Reinforce,
        // At or above the duplicate floor, only a readable verdict may
        // change the index. Everything else is a review.
        Some(_) => match verdict {
            Some(Verdict::Identical) => RevisionAction::Reinforce,
            Some(Verdict::Contradicts) => RevisionAction::Supersede,
            Some(Verdict::Complements) => RevisionAction::Merge,
            _ => RevisionAction::Review,
        },
    };
    let action = match action {
        RevisionAction::Add if confidence < AUTO_ADD_CONFIDENCE => RevisionAction::Review,
        RevisionAction::Supersede | RevisionAction::Merge
            if confidence < AUTO_REWRITE_CONFIDENCE =>
        {
            RevisionAction::Review
        }
        other => other,
    };
    RevisionDecision {
        action,
        target_id: None,
        merged_content: None,
        reason: describe(cosine, verdict, confidence, action),
    }
}

fn describe(
    cosine: Option<f64>,
    verdict: Option<Verdict>,
    confidence: f64,
    action: RevisionAction,
) -> String {
    let similarity = match cosine {
        Some(score) => format!("similarity {:.2}", score),
        None => "no existing match".to_string(),
    };
    let judged = match verdict {
        Some(v) => format!("judge said {:?}", v),
        None => "judge not consulted".to_string(),
    };
    format!(
        "{:?} at confidence {:.2} ({}; {})",
        action, confidence, similarity, judged
    )
}

/// The nearest existing memory above the reinforce floor, or `None`.
///
/// Below the floor the answer is "nothing similar enough to act on", and
/// the caller skips the judge call entirely — the floor is what keeps the
/// common path free of an LLM round trip.
pub fn find_nearest(
    conn: &rusqlite::Connection,
    candidate_vector: &[f32],
) -> rusqlite::Result<Option<Nearest>> {
    use crate::memory::embed::cosine;
    let mut stmt = conn.prepare(
        "SELECT e.owner_id, e.dim, e.vec FROM memory_embeddings e
         JOIN memory_items m ON m.id = e.owner_id AND e.owner_type = 'memory'
         WHERE e.model = (
                 SELECT model FROM memory_embeddings LIMIT 1
             ) AND m.is_enabled = 1 AND m.superseded_by IS NULL",
    )?;
    let entries = stmt.query_map([], |row| {
        let owner_id: String = row.get(0)?;
        let dim: usize = row.get(1)?;
        let bytes: Vec<u8> = row.get(2)?;
        Ok((owner_id, dim, bytes))
    })?;
    let mut best: Option<Nearest> = None;
    for entry in entries {
        let (owner_id, dim, bytes) = entry?;
        let Some(vector) = crate::memory::embed::decode(&bytes, dim) else {
            continue;
        };
        let Some(score) = cosine(candidate_vector, &vector) else {
            continue;
        };
        if score < config::REINFORCE_FLOOR {
            continue;
        }
        let row = conn.query_row(
            "SELECT kind, title, content, is_enabled, superseded_by, access_count, updated_at
             FROM memory_items WHERE id = ?1",
            rusqlite::params![owner_id],
            |r| {
                Ok(KnowledgeRow {
                    owner_type: "memory".into(),
                    owner_id: owner_id.clone(),
                    kind: r.get(0)?,
                    title: r.get(1)?,
                    content: r.get(2)?,
                    is_enabled: r.get::<_, i64>(3)? != 0,
                    superseded_by: r.get(4)?,
                    access_count: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            },
        );
        if let Ok(row) = row {
            let better = best.as_ref().is_none_or(|b| score > b.score);
            if better {
                best = Some(Nearest { row, score });
            }
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::config::{DUP_FLOOR, REINFORCE_FLOOR};
    use crate::memory::extract::ExtractedFact;

    fn candidate(confidence: f64) -> ExtractedFact {
        ExtractedFact {
            kind: "user_pref".into(),
            title: Some("T".into()),
            content: "c".into(),
            tags: None,
            confidence,
            is_note: false,
            note_body: None,
        }
    }

    #[test]
    fn well_below_the_reinforce_floor_is_an_add() {
        assert_eq!(
            decide(&candidate(0.95), Some(0.1), None).action,
            RevisionAction::Add
        );
    }

    #[test]
    fn no_match_at_all_is_an_add() {
        assert_eq!(
            decide(&candidate(0.95), None, None).action,
            RevisionAction::Add
        );
    }

    #[test]
    fn between_the_floors_is_a_reinforce() {
        let mid = (REINFORCE_FLOOR + DUP_FLOOR) / 2.0;
        assert_eq!(
            decide(&candidate(0.95), Some(mid), None).action,
            RevisionAction::Reinforce
        );
    }

    #[test]
    fn at_the_reinforce_floor_is_a_reinforce_not_an_add() {
        assert_eq!(
            decide(&candidate(0.95), Some(REINFORCE_FLOOR), None).action,
            RevisionAction::Reinforce,
            "the floor is inclusive"
        );
    }

    #[test]
    fn above_the_duplicate_floor_an_identical_verdict_is_a_reinforce() {
        assert_eq!(
            decide(&candidate(0.95), Some(0.98), Some(Verdict::Identical)).action,
            RevisionAction::Reinforce
        );
    }

    #[test]
    fn above_the_duplicate_floor_a_contradiction_supersedes() {
        assert_eq!(
            decide(&candidate(0.95), Some(0.98), Some(Verdict::Contradicts)).action,
            RevisionAction::Supersede
        );
    }

    #[test]
    fn above_the_duplicate_floor_a_complement_merges() {
        assert_eq!(
            decide(&candidate(0.95), Some(0.98), Some(Verdict::Complements)).action,
            RevisionAction::Merge
        );
    }

    #[test]
    fn an_unreadable_verdict_goes_to_review_never_to_a_write() {
        // Review Focus 5. A judge that returned prose, an empty string, or
        // the wrong JSON shape must not be able to auto-write.
        for raw in [
            "",
            "   ",
            "they are the same",
            "[]",
            "{}",
            r#"{"v":"maybe"}"#,
            "null",
            "CONTRADICTS BUT ALSO MAYBE",
        ] {
            assert_eq!(parse_verdict(raw), Verdict::Unreadable, "input {:?}", raw);
            assert_eq!(
                decide(&candidate(0.99), Some(0.99), Some(Verdict::Unreadable)).action,
                RevisionAction::Review,
                "input {:?} wrote something",
                raw
            );
        }
    }

    #[test]
    fn a_readable_verdict_parses() {
        assert_eq!(parse_verdict("IDENTICAL"), Verdict::Identical);
        assert_eq!(parse_verdict("contradicts"), Verdict::Contradicts);
        assert_eq!(
            parse_verdict(r#"{"verdict":"COMPLEMENTS"}"#),
            Verdict::Complements
        );
        assert_eq!(parse_verdict("  Complements  \n"), Verdict::Complements);
    }

    #[test]
    fn a_low_confidence_add_goes_to_review() {
        assert_eq!(
            decide(&candidate(0.5), Some(0.1), None).action,
            RevisionAction::Review,
            "below the 0.80 auto-add gate"
        );
    }

    #[test]
    fn a_low_confidence_supersede_goes_to_review() {
        // Rewriting an existing memory is more destructive than adding one,
        // so it takes a higher bar.
        assert_eq!(
            decide(&candidate(0.82), Some(0.98), Some(Verdict::Contradicts)).action,
            RevisionAction::Review,
            "below the 0.85 auto-rewrite gate"
        );
    }

    #[test]
    fn a_high_confidence_supersede_is_applied() {
        assert_eq!(
            decide(&candidate(0.90), Some(0.98), Some(Verdict::Contradicts)).action,
            RevisionAction::Supersede
        );
    }

    #[test]
    fn every_decision_carries_a_reason() {
        for c in [0.1, 0.8, 0.99] {
            for v in [
                None,
                Some(Verdict::Identical),
                Some(Verdict::Contradicts),
                Some(Verdict::Complements),
                Some(Verdict::Unreadable),
            ] {
                let d = decide(&candidate(c), Some(0.5), v);
                assert!(!d.reason.trim().is_empty(), "no reason for {:?} {:?}", c, v);
            }
        }
    }

    #[test]
    fn only_merge_may_carry_merged_content_and_needs_supplied_text() {
        // The decision must not invent merged text. `apply` refuses to
        // write a merge that arrives without it.
        for v in [
            None,
            Some(Verdict::Identical),
            Some(Verdict::Contradicts),
            Some(Verdict::Complements),
            Some(Verdict::Unreadable),
        ] {
            let d = decide(&candidate(0.95), Some(0.98), v);
            assert!(d.merged_content.is_none(), "{:?} invented merged text", v);
        }
    }

    #[test]
    fn the_decision_names_the_action_it_took() {
        let cases = [
            (None, RevisionAction::Add),
            (Some(0.1), RevisionAction::Add),
            (Some(0.8), RevisionAction::Reinforce),
        ];
        for (score, want) in cases {
            let d = decide(&candidate(0.95), score, None);
            assert_eq!(d.action, want);
            assert!(
                d.reason
                    .to_lowercase()
                    .contains(&format!("{:?}", want).to_lowercase())
                    || d.reason.contains("confidence"),
                "reason should be legible for {:?}: {}",
                want,
                d.reason
            );
        }
    }
}

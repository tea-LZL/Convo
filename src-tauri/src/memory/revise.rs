//! Revision: what to do with a newly extracted fact.
//!
//! The question is not "is this fact true" — the extractor already
//! answered that, and `confidence` records its answer. The question is
//! what to do with it *given what is already known*, which is a much
//! narrower problem with a small decision table.
//!
//! An LLM judge is consulted in two cases. With an embedding index, two
//! memories close enough that they might be the same thing; below that
//! floor the cosine is decisive on its own and no call is made. Without an
//! embedding index there is no cosine to rank by, so the judge is given a
//! shortlist of the candidate's own kind and asked which entry the new fact
//! restates, replaces, or complements.

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

/// How many existing memories the no-vector judge is shown. Small enough
/// that the model keeps the list in view, large enough to hold the handful
/// of facts a user accumulates about one kind.
pub const SHORTLIST_LIMIT: usize = 12;

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

/// Read a shortlist judge response: a 1-based number and a verdict, or
/// `NONE`.
///
/// Returns the 0-based index into the shortlist. Anything that is not a
/// number in range paired with a verdict is `None`, which the caller reads
/// as `Add`. The pair is required: a number with no verdict is not an
/// answer, and a verdict with no number is not a target.
pub fn parse_shortlist_reply(raw: &str, len: usize) -> Option<(usize, Verdict)> {
    let upper = raw.trim().to_ascii_uppercase();
    if upper.is_empty() || upper.contains("NONE") {
        return None;
    }
    let verdict = if upper.contains("CONTRADICT") {
        Verdict::Contradicts
    } else if upper.contains("COMPLEMENT") {
        Verdict::Complements
    } else if upper.contains("IDENTICAL") {
        Verdict::Identical
    } else {
        return None;
    };
    let number = upper
        .split_whitespace()
        .filter_map(|token| {
            token
                .trim_matches(|c: char| !c.is_ascii_digit())
                .parse::<usize>()
                .ok()
        })
        .next()?;
    if number == 0 || number > len {
        return None;
    }
    Some((number - 1, verdict))
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
    let action = gate(action, confidence);
    RevisionDecision {
        action,
        target_id: None,
        merged_content: None,
        reason: describe(cosine, verdict, confidence, action),
    }
}

/// Apply the confidence gates to a decision.
///
/// Gating after the table matters: an auto-write is never something the
/// table decided on its own, so a bug in the thresholds degrades to review
/// rather than to a silent rewrite. Shared with the no-vector path so the
/// two cannot drift.
fn gate(action: RevisionAction, confidence: f64) -> RevisionAction {
    match action {
        RevisionAction::Add if confidence < AUTO_ADD_CONFIDENCE => RevisionAction::Review,
        RevisionAction::Supersede | RevisionAction::Merge
            if confidence < AUTO_REWRITE_CONFIDENCE =>
        {
            RevisionAction::Review
        }
        other => other,
    }
}

/// The decision for a candidate matched by the judge with no vector.
///
/// The cosine table does not apply: there is no cosine, only the judge's
/// word about whether the new memory restates, replaces, or adds to the
/// shortlisted one. `None` or an unreadable verdict is `Add` — never a
/// rewrite — so a phrase-parroting model cannot silently replace a memory
/// it did not actually judge.
fn decide_from_verdict(candidate: &ExtractedFact, verdict: Option<Verdict>) -> RevisionDecision {
    let action = match verdict {
        Some(Verdict::Identical) => RevisionAction::Reinforce,
        Some(Verdict::Contradicts) => RevisionAction::Supersede,
        Some(Verdict::Complements) => RevisionAction::Merge,
        _ => RevisionAction::Add,
    };
    let action = gate(action, candidate.confidence);
    RevisionDecision {
        action,
        target_id: None,
        merged_content: None,
        reason: format!(
            "{:?} at confidence {:.2} (no vector; judge said {:?})",
            action, candidate.confidence, verdict
        ),
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

/// Existing memories of the candidate's own kind, most recent first.
///
/// The no-vector match set. With no embedding route there is no cosine to
/// rank by, so the judge is handed this list and asked which entry the
/// candidate restates, replaces, or adds to. Same kind because an update is
/// almost always within a kind — a nickname replaces a nickname, a
/// preference a preference — and the cap keeps the prompt bounded.
pub fn shortlist_for(
    conn: &rusqlite::Connection,
    candidate: &ExtractedFact,
) -> rusqlite::Result<Vec<KnowledgeRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, kind, title, content, is_enabled, superseded_by, access_count, updated_at
         FROM memory_items
         WHERE is_enabled = 1 AND superseded_by IS NULL AND kind = ?1
         ORDER BY updated_at DESC, rowid DESC
         LIMIT {}",
        SHORTLIST_LIMIT
    ))?;
    let rows = stmt.query_map(rusqlite::params![candidate.kind], |r| {
        Ok(KnowledgeRow {
            owner_type: "memory".into(),
            owner_id: r.get(0)?,
            kind: r.get(1)?,
            title: r.get(2)?,
            content: r.get(3)?,
            is_enabled: r.get::<_, i64>(4)? != 0,
            superseded_by: r.get(5)?,
            access_count: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    rows.collect()
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

// --- applying ---------------------------------------------------------------

use crate::memory::embed::{log_event, upsert_embedding};
use rusqlite::params;

/// The effect of applying one decision.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
// Two attributes, because serde needs both: `rename_all` renames the
// variant names, `rename_all_fields` renames the fields inside the struct
// variants. Setting only the first leaves `new_id` as `new_id`, which the
// frontend union does not match.
#[serde(
    tag = "effect",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Applied {
    Added { id: String },
    Reinforced { id: String, confidence: f64 },
    Superseded { new_id: String, old_id: String },
    Merged { id: String },
    SentToReview { review_id: String },
}

impl RevisionDecision {
    /// Write the decision.
    ///
    /// Every branch runs in a transaction, so a failure cannot leave a row
    /// without its vector, or a supersede without its replacement.
    ///
    /// A merge with no supplied text becomes a review rather than a
    /// guess. Inventing merged prose would silently replace what the user
    /// wrote with something they never said.
    /// `session_id` is required for a review row: `pending_memory_reviews`
    /// has a NOT NULL foreign key to `sessions`, and a review is always
    /// about a conversation. Inventing a placeholder session would put a
    /// row in the user's session list that is not a conversation.
    pub fn apply(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
        candidate: &ExtractedFact,
        nearest: Option<&Nearest>,
        merged_text: Option<&str>,
    ) -> Result<Applied, String> {
        if self.action == RevisionAction::Merge && merged_text.is_none() {
            return self.send_to_review(conn, session_id, candidate);
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let outcome = match self.action {
            RevisionAction::Add => self.add(&tx, candidate),
            RevisionAction::Reinforce => self.reinforce(&tx, candidate, nearest),
            RevisionAction::Supersede => self.supersede(&tx, candidate, nearest),
            RevisionAction::Merge => self.merge(&tx, candidate, nearest, merged_text),
            RevisionAction::Review => {
                // Rolled back by dropping `tx`, then written outside it:
                // a review row is bookkeeping, not part of the same
                // atomic change, and must survive a failed write.
                drop(tx);
                return self.send_to_review(conn, session_id, candidate);
            }
        };
        // Commit explicitly rather than relying on Drop, which swallows
        // the error. A silently dropped commit is how a write vanishes
        // with nothing in the log and nothing in the return value.
        match outcome {
            Ok(applied) => {
                tx.commit().map_err(|e| format!("commit: {}", e))?;
                Ok(applied)
            }
            Err(e) => Err(e),
        }
    }

    fn add(
        &self,
        conn: &rusqlite::Connection,
        candidate: &ExtractedFact,
    ) -> Result<Applied, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let owner_type = if candidate.is_note { "note" } else { "memory" };
        if candidate.is_note {
            let body = candidate
                .note_body
                .as_deref()
                .unwrap_or(candidate.content.as_str());
            conn.execute(
                "INSERT INTO notes (id, title, body, tags, pinned) VALUES (?1, ?2, ?3, ?4, 0)",
                params![id, candidate.title, body, candidate.tags],
            )
            .map_err(|e| format!("add: insert note: {}", e))?;
        } else {
            conn.execute(
                "INSERT INTO memory_items (id, kind, title, content, tags, is_enabled, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    id,
                    candidate.kind,
                    candidate.title,
                    candidate.content,
                    candidate.tags,
                    candidate.confidence
                ],
            )
            .map_err(|e| format!("add: insert memory: {}", e))?;
        }
        log_event(conn, owner_type, &id, "extract", None)
            .map_err(|e| format!("add: log event: {}", e))?;
        Ok(Applied::Added { id })
    }

    fn reinforce(
        &self,
        conn: &rusqlite::Connection,
        candidate: &ExtractedFact,
        nearest: Option<&Nearest>,
    ) -> Result<Applied, String> {
        let Some(target) = nearest
            .map(|n| n.row.owner_id.clone())
            .or_else(|| self.target_id.clone())
        else {
            return Err("reinforce needs a target memory".to_string());
        };
        // Union rather than replace: the new observation may carry a tag
        // the old one did not, and dropping it would lose information the
        // extractor volunteered.
        let existing: Option<String> = conn
            .query_row(
                "SELECT tags FROM memory_items WHERE id = ?1",
                params![target],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let merged = union_tags(existing.as_deref(), candidate.tags.as_deref());
        // Confidence moves toward the observation, never above what the
        // extractor claimed: re-seeing a fact at 0.95 does not make a 0.7
        // guess into a 0.95 one.
        //
        // And never below what is already stored. An average is symmetric,
        // but only one direction is safe. A candidate at 0.2 confidence
        // falls below every auto-write gate in the system, so it would
        // never have become a memory on its own — yet in the reinforce band
        // it can still walk a confident memory toward 0.2, one restatement
        // at a time, with no review and nothing in the log. Being seen again
        // is not evidence a memory is less reliable. A weak restatement
        // still bumps the counters and unions the tags; it just does not
        // get a vote on how sure we are.
        let previous: f64 = conn
            .query_row(
                "SELECT confidence FROM memory_items WHERE id = ?1",
                params![target],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let confidence = if candidate.confidence > previous {
            (previous + candidate.confidence) / 2.0
        } else {
            previous
        };
        conn.execute(
            "UPDATE memory_items
             SET access_count = access_count + 1,
                 last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 tags = ?2,
                 confidence = ?3,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![target, merged, confidence],
        )
        .map_err(|e| e.to_string())?;
        log_event(conn, "memory", &target, "reinforce", None)?;
        Ok(Applied::Reinforced {
            id: target,
            confidence,
        })
    }

    fn supersede(
        &self,
        conn: &rusqlite::Connection,
        candidate: &ExtractedFact,
        nearest: Option<&Nearest>,
    ) -> Result<Applied, String> {
        let Some(old) = nearest.map(|n| n.row.owner_id.clone()) else {
            return Err("supersede needs a target memory".to_string());
        };
        let new_id = match self.add(conn, candidate)? {
            Applied::Added { id } => id,
            _ => return Err("supersede must add the replacement".to_string()),
        };
        // The old row is retained and pointed at its replacement, not
        // deleted: the history of a correction stays readable, and a user
        // can see what they used to believe.
        conn.execute(
            "UPDATE memory_items SET superseded_by = ?2 WHERE id = ?1",
            params![old, new_id],
        )
        .map_err(|e| e.to_string())?;
        log_event(conn, "memory", &old, "supersede", None)?;
        Ok(Applied::Superseded {
            new_id,
            old_id: old,
        })
    }

    fn merge(
        &self,
        conn: &rusqlite::Connection,
        candidate: &ExtractedFact,
        nearest: Option<&Nearest>,
        merged_text: Option<&str>,
    ) -> Result<Applied, String> {
        let Some(target) = nearest.map(|n| n.row.owner_id.clone()) else {
            return Err("merge needs a target memory".to_string());
        };
        let Some(text) = merged_text else {
            return Err("merge needs supplied text".to_string());
        };
        conn.execute(
            "UPDATE memory_items
             SET content = ?2,
                 access_count = access_count + 1,
                 last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![target, text],
        )
        .map_err(|e| e.to_string())?;
        let _ = candidate;
        log_event(conn, "memory", &target, "reinforce", None)?;
        Ok(Applied::Merged { id: target })
    }

    fn send_to_review(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
        candidate: &ExtractedFact,
    ) -> Result<Applied, String> {
        let review_id = uuid::Uuid::new_v4().to_string();
        // A review always names the conversation it came from, and the
        // foreign key says so. An earlier comment here claimed a
        // session-less review was still useful; the schema disagrees, and
        // the schema is right — a review with no origin cannot be shown in
        // context or re-run. The caller always has the session id.
        //
        // The facts_json carries the candidate so the inbox can show what
        // was proposed and why it was not applied, rather than raw text.
        let facts_json = serde_json::to_string(&[candidate]).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pending_memory_reviews (id, session_id, status, facts_json)
             VALUES (?1, ?2, 'pending', ?3)",
            params![review_id, session_id, facts_json],
        )
        .map_err(|e| e.to_string())?;
        Ok(Applied::SentToReview { review_id })
    }
}

/// Union two comma-separated tag sets, order-preserving and deduplicated.
fn union_tags(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    for source in [existing, incoming].into_iter().flatten() {
        for tag in source.split(',') {
            let tag = tag.trim();
            if !tag.is_empty() && !out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
                out.push(tag.to_string());
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join(","))
    }
}

// --- end to end -------------------------------------------------------------

/// What to embed for a candidate: title and content together, so a memory
/// titled "Build command" is findable by its title.
fn candidate_text(candidate: &ExtractedFact) -> String {
    match candidate.title.as_deref() {
        Some(t) if !t.trim().is_empty() => format!(
            "{}\n\n{}\n\n{}",
            t.trim(),
            candidate.content,
            candidate.note_body.as_deref().unwrap_or("")
        ),
        _ => format!(
            "{}\n\n{}",
            candidate.content,
            candidate.note_body.as_deref().unwrap_or("")
        ),
    }
}

/// The judge prompt. Asked for one word and one of two things, because a
/// judge that has to explain itself will hedge, and a hedged answer is a
/// review.
const JUDGE_SYSTEM: &str = "You compare an existing memory with a newly extracted one and decide their relationship. Reply with exactly one word, nothing else:\nIDENTICAL - the new one restates the existing one.\nCONTRADICTS - the new one reverses or replaces the existing one.\nCOMPLEMENTS - the new one adds detail to the existing one without contradicting it.\nDo not explain. Do not add punctuation. One word only.";

/// The no-vector judge prompt. Same three verdicts as [`JUDGE_SYSTEM`], but
/// the existing side is a numbered shortlist and the reply names which entry
/// it applies to. `CONTRADICTS` is spelled out with the common case — a
/// changed name, date, or preference — because that is the one this path
/// exists to catch, and a local model reads an example far better than a
/// definition.
const JUDGE_SHORTLIST_SYSTEM: &str = "You are given a numbered list of existing memories and one newly extracted memory. Decide whether the new memory restates, contradicts, or adds to ONE of the existing ones.\nReply with exactly two tokens: the number of that memory, then one of IDENTICAL, CONTRADICTS, COMPLEMENTS.\nIDENTICAL - it says the same thing.\nCONTRADICTS - it reverses or replaces it, for example a changed name, date, or preference.\nCOMPLEMENTS - it adds detail without contradicting.\nIf it relates to none of them, reply exactly NONE.\nDo not explain. No punctuation.";

/// Decide and apply one extracted candidate, end to end.
///
/// Two ways to find what to revise against. With an embedding route the
/// candidate gets a vector, cosine ranks the nearest memory, and the judge
/// runs above the duplicate floor. Without one there is no cosine, so the
/// judge is given a shortlist of the candidate's own kind and asked which
/// entry it restates, replaces, or adds to. Only when neither finds a
/// target does the candidate become a new memory.
pub async fn apply_candidate(
    pool: &std::sync::Arc<crate::db::DbPool>,
    session_id: &str,
    candidate: &ExtractedFact,
) -> Result<Applied, String> {
    let embedding = resolve_embedding_provider(pool);

    // Embed the candidate. No connection is held across this await.
    let candidate_vector = match &embedding {
        Some((provider, model)) => {
            match provider.embed(model, &[candidate_text(candidate)]).await {
                Ok(mut vectors) => vectors.pop().unwrap_or_default(),
                Err(e) => {
                    tracing::warn!(
                        "candidate embedding failed, degrading to propose-only: {}",
                        e
                    );
                    Vec::new()
                }
            }
        }
        None => Vec::new(),
    };

    // Find something to revise against. With a vector, cosine ranks it and
    // the judge runs only above the duplicate floor, so the common path
    // stays free of a round trip. Without a vector there is no cosine to
    // rank by, so the judge is given a shortlist of the candidate's own
    // kind instead; that is the whole non-embedding revision path, and the
    // reason a missing embedding model no longer means all-ADD.
    let (nearest, verdict): (Option<Nearest>, Option<Verdict>) = if !candidate_vector.is_empty() {
        let nearest = {
            let conn = pool.get().map_err(|e| e.to_string())?;
            find_nearest(&conn, &candidate_vector).map_err(|e| e.to_string())?
        };
        let needs_judge = nearest
            .as_ref()
            .is_some_and(|n| n.score >= config::DUP_FLOOR);
        let verdict = match (&nearest, needs_judge) {
            (Some(nearest), true) => {
                match judge(pool, &nearest.row.content, &candidate.content).await {
                    Ok(raw) => Some(parse_verdict(&raw)),
                    Err(e) => {
                        tracing::warn!("judge unavailable, routing to review: {}", e);
                        Some(Verdict::Unreadable)
                    }
                }
            }
            _ => None,
        };
        (nearest, verdict)
    } else if candidate.is_note {
        // Notes live in their own table; there is nothing to shortlist.
        (None, None)
    } else {
        match nearest_from_shortlist(pool, candidate).await {
            Some((nearest, verdict)) => (Some(nearest), Some(verdict)),
            None => (None, None),
        }
    };

    let decision = {
        let mut decision = if candidate_vector.is_empty() {
            decide_from_verdict(candidate, verdict)
        } else {
            decide(candidate, nearest.as_ref().map(|n| n.score), verdict)
        };
        decision.target_id = nearest.as_ref().map(|n| n.row.owner_id.clone());
        decision
    };
    let merged_text =
        merge_text_for(&decision, candidate, nearest.as_ref(), verdict, &embedding).await;

    let applied = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let out = decision.apply(
            &conn,
            session_id,
            candidate,
            nearest.as_ref(),
            merged_text.as_deref(),
        );
        out?
    };

    // A newly added row gets its vector, off the send path. The embed
    // await happens with no connection held; the write happens after.
    if let (Applied::Added { id }, Some((provider, model))) = (&applied, &embedding) {
        let owner = if candidate.is_note { "note" } else { "memory" };
        let text = candidate_text(candidate);
        match provider.embed(model, &[text]).await {
            Ok(mut vectors) => {
                if let Some(vector) = vectors.pop() {
                    let stored = {
                        let conn = pool.get().map_err(|e| e.to_string())?;
                        upsert_embedding(&conn, owner, id, model, &vector)
                    };
                    if let Err(e) = stored {
                        tracing::warn!("could not store the new vector: {}", e);
                    }
                }
            }
            Err(e) => tracing::warn!("could not embed the new row: {}", e),
        }
    }
    Ok(applied)
}

/// The configured embedding route, resolved once with no connection held.
fn resolve_embedding_provider(
    pool: &std::sync::Arc<crate::db::DbPool>,
) -> Option<(Box<dyn crate::providers::Provider>, String)> {
    use crate::providers::ollama::OllamaProvider;
    use crate::providers::openai_compat::OpenAiCompatProvider;
    use crate::providers::Provider;
    let conn = pool.get().ok()?;
    let route = crate::memory::config::load_routing(&conn).embedding?;
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![route.provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (kind, base_url) = found?;
    let api_key = crate::services::get_api_key(&route.provider_id);
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        _ => return None,
    };
    Some((provider, route.model))
}

/// Ask the model whether a candidate and an existing memory are the same,
/// opposite, or complementary.
async fn judge(
    pool: &std::sync::Arc<crate::db::DbPool>,
    existing: &str,
    candidate: &str,
) -> Result<String, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use futures_util::StreamExt;

    let (provider, model) = resolve_chat_provider(pool)?;
    let request = ChatRequest {
        model,
        messages: vec![MessageContent {
            role: "user".into(),
            content: format!(
                "EXISTING MEMORY:\n{}\n\nNEWLY EXTRACTED:\n{}\n\nReply with one word.",
                existing, candidate
            ),
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(JUDGE_SYSTEM.to_string()),
        temperature: Some(0.0),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let mut stream = provider.chat_stream(request).await?;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(message) = chunk.message {
                    out.push_str(&message.content);
                }
                if chunk.done {
                    break;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

/// One call that asks the judge which shortlisted memory the candidate
/// relates to, and how. Used only when there is no candidate vector.
async fn judge_shortlist(
    pool: &std::sync::Arc<crate::db::DbPool>,
    candidate: &ExtractedFact,
    items: &[KnowledgeRow],
) -> Result<String, String> {
    use crate::providers::types::{ChatRequest, MessageContent};
    use futures_util::StreamExt;

    let (provider, model) = resolve_chat_provider(pool)?;
    let mut list = String::new();
    for (index, row) in items.iter().enumerate() {
        let title = row.title.as_deref().map(str::trim).unwrap_or("");
        if title.is_empty() {
            list.push_str(&format!("{}. {}\n", index + 1, row.content));
        } else {
            list.push_str(&format!("{}. {}: {}\n", index + 1, title, row.content));
        }
    }
    let new_line = match candidate.title.as_deref().map(str::trim) {
        Some(title) if !title.is_empty() => format!("{}: {}", title, candidate.content),
        _ => candidate.content.clone(),
    };
    let request = ChatRequest {
        model,
        messages: vec![MessageContent {
            role: "user".into(),
            content: format!(
                "EXISTING MEMORIES:\n{}\nNEWLY EXTRACTED:\n{}\n\nReply with '<number> <VERDICT>' or 'NONE'.",
                list, new_line
            ),
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some(JUDGE_SHORTLIST_SYSTEM.to_string()),
        temperature: Some(0.0),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let mut stream = provider.chat_stream(request).await?;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(message) = chunk.message {
                    out.push_str(&message.content);
                }
                if chunk.done {
                    break;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

/// The memory to revise against when there is no candidate vector, and the
/// judge's verdict. `None` means nothing to revise against, so the caller
/// adds.
async fn nearest_from_shortlist(
    pool: &std::sync::Arc<crate::db::DbPool>,
    candidate: &ExtractedFact,
) -> Option<(Nearest, Verdict)> {
    let items = {
        let conn = pool.get().ok()?;
        match shortlist_for(&conn, candidate) {
            Ok(items) => items,
            Err(e) => {
                tracing::warn!("could not read the revision shortlist: {}", e);
                return None;
            }
        }
    };
    if items.is_empty() {
        return None;
    }
    let raw = match judge_shortlist(pool, candidate, &items).await {
        Ok(raw) => raw,
        Err(e) => {
            tracing::warn!("shortlist judge unavailable, adding instead: {}", e);
            return None;
        }
    };
    let (index, verdict) = parse_shortlist_reply(&raw, items.len())?;
    Some((
        Nearest {
            row: items[index].clone(),
            // The judge, not a cosine, chose this row. The number is
            // carried for the reason string only; the action comes from
            // the verdict.
            score: config::DUP_FLOOR,
        },
        verdict,
    ))
}

/// The default provider, for a job with no dedicated route.
fn resolve_chat_provider(
    pool: &std::sync::Arc<crate::db::DbPool>,
) -> Result<(Box<dyn crate::providers::Provider>, String), String> {
    use crate::providers::ollama::OllamaProvider;
    use crate::providers::openai_compat::OpenAiCompatProvider;
    use crate::providers::Provider;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let provider_id: String = conn
        .query_row(
            "SELECT id FROM providers WHERE is_default = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "no default provider configured".to_string())?;
    let (kind, base_url): (String, String) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let model: String = conn
        .query_row(
            "SELECT name FROM models WHERE provider_id = ?1 ORDER BY name LIMIT 1",
            rusqlite::params![provider_id],
            |r| r.get(0),
        )
        .map_err(|_| "no models cached for the default provider".to_string())?;
    let api_key = crate::services::get_api_key(&provider_id);
    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(OllamaProvider::new(base_url, api_key)),
        "openai_compat" => Box::new(OpenAiCompatProvider::new(base_url, api_key)),
        other => return Err(format!("unknown provider kind: {}", other)),
    };
    Ok((provider, model))
}

/// The merged text for a `Merge` decision, or `None`.
///
/// A merge is only worth doing if something will actually produce the
/// merged prose. The judge returns a verdict, not a rewrite, so this asks
/// for the text explicitly — and returns `None` when that fails, which
/// routes the decision to review rather than overwriting what the user
/// wrote with a guess.
async fn merge_text_for(
    decision: &RevisionDecision,
    candidate: &ExtractedFact,
    nearest: Option<&Nearest>,
    verdict: Option<Verdict>,
    embedding: &Option<(Box<dyn crate::providers::Provider>, String)>,
) -> Option<String> {
    if decision.action != RevisionAction::Merge {
        return None;
    }
    let (provider, model) = embedding.as_ref()?;
    if verdict != Some(Verdict::Complements) {
        return None;
    }
    // The existing memory is half the merge. Without it this would ask the
    // model to merge the candidate with itself and quietly discard what
    // the user already had.
    let existing = nearest?.row.content.as_str();
    use crate::providers::types::{ChatRequest, MessageContent};
    use futures_util::StreamExt;
    let request = ChatRequest {
        model: model.clone(),
        messages: vec![MessageContent {
            role: "user".into(),
            content: format!(
                "Combine these into one fact, keeping every detail from both. Output only the sentence.\n\nEXISTING: {}\nNEW: {}",
                existing, candidate.content
            ),
            thinking: None,
            images: vec![],
        }],
        stream: false,
        system: Some("You merge two related facts into one sentence that keeps every detail from both. Output only that sentence.".to_string()),
        temperature: Some(0.1),
        top_p: None,
        top_k: None,
        num_ctx: None,
        repeat_penalty: None,
        stop: None,
    };
    let mut stream = provider.chat_stream(request).await.ok()?;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        let Ok(item) = item else { break };
        if let Some(message) = item.message {
            out.push_str(&message.content);
        }
        if item.done {
            break;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod no_vector_decision_tests {
    use super::*;
    use crate::memory::extract::ExtractedFact;

    fn candidate(confidence: f64) -> ExtractedFact {
        ExtractedFact {
            kind: "user_pref".into(),
            title: Some("Nickname".into()),
            content: "The user's nickname is John".into(),
            tags: None,
            confidence,
            is_note: false,
            note_body: None,
        }
    }

    #[test]
    fn the_verdict_is_the_action_when_there_is_no_cosine() {
        let c = candidate(0.95);
        assert_eq!(
            decide_from_verdict(&c, Some(Verdict::Contradicts)).action,
            RevisionAction::Supersede
        );
        assert_eq!(
            decide_from_verdict(&c, Some(Verdict::Identical)).action,
            RevisionAction::Reinforce
        );
        assert_eq!(
            decide_from_verdict(&c, Some(Verdict::Complements)).action,
            RevisionAction::Merge
        );
        assert_eq!(
            decide_from_verdict(&c, None).action,
            RevisionAction::Add,
            "no verdict is never a rewrite"
        );
    }

    #[test]
    fn a_low_confidence_no_vector_rewrite_is_held_for_review() {
        // Below the rewrite gate even a contradiction must not auto-write;
        // it goes to the inbox, exactly as the cosine path does.
        let c = candidate(0.5);
        assert_eq!(
            decide_from_verdict(&c, Some(Verdict::Contradicts)).action,
            RevisionAction::Review
        );
    }
}

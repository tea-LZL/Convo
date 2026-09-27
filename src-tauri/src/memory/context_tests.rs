use super::context::*;

fn row(owner_type: &str, owner_id: &str, label: &str, text: &str) -> ContextRow {
    ContextRow {
        owner_type: owner_type.into(),
        owner_id: owner_id.into(),
        label: label.into(),
        text: text.into(),
    }
}

/// The empty case emits no block at all — not an empty block, not a
/// header with nothing under it. A `<memory-context>` element with no
/// facts invites the model to volunteer that the user has no stored
/// context, which is a statement about the user that no one verified.
#[test]
fn no_rows_means_no_memory_block_at_all() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![],
        budget_tokens: 1000,
    });
    assert!(out.memory_block.is_none());
    assert_eq!(out.system_prompt, PERSONA);
    assert_eq!(out.used_tokens, 0);
}

/// The override is prepended to the persona, and the memory block comes
/// last so it is the most recent thing in the prompt. Small models attend
/// to the end far more than the middle.
#[test]
fn the_override_precedes_the_persona_and_memory_comes_last() {
    let out = assemble(ContextInput {
        override_prompt: Some("Always answer in French.".into()),
        rows: vec![row("memory", "m1", "User preferences", "uses Neovim")],
        budget_tokens: 1000,
    });
    let s = out.system_prompt;
    assert!(s.find("Always answer in French.").unwrap() < s.find(PERSONA).unwrap());
    assert!(s.find(PERSONA).unwrap() < s.find("<memory-context>").unwrap());
    assert!(out.memory_block.is_some());
}

/// A pinned memory and a retrieved copy of the same fact produce one
/// entry. Two copies of one fact reads to the model as two opinions, and
/// the whole point of a single block is that it cannot contradict itself.
#[test]
fn a_fact_that_is_both_pinned_and_retrieved_appears_once() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row(
                "memory",
                "m1",
                "User preferences",
                "uses Neovim as the primary editor",
            ),
            row(
                "memory",
                "m1",
                "User preferences",
                "uses Neovim as the primary editor",
            ),
        ],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    assert_eq!(block.matches("uses Neovim").count(), 1);
}

/// The first occurrence wins, so a pinned row is never displaced by the
/// retrieved copy of itself arriving later in precedence order.
#[test]
fn the_first_occurrence_of_a_duplicated_fact_wins() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("memory", "m1", "Pinned", "the canonical wording"),
            row("memory", "m1", "Retrieved", "a looser restatement"),
        ],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    assert!(block.contains("the canonical wording"));
    assert!(!block.contains("a looser restatement"));
}

/// A row too large for the remaining budget is dropped and recorded, and
/// the rows after it are still considered. Truncation order is precedence
/// order, so an oversized pinned note costs the tail of the retrieval
/// rather than the head of the precedence.
#[test]
fn an_oversized_row_is_dropped_and_the_rest_still_fit() {
    let huge = "x".repeat(4000);
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("note", "n1", "Notes", &huge),
            row("memory", "m1", "User preferences", "uses Neovim"),
        ],
        budget_tokens: 100,
    });
    let block = out.memory_block.unwrap();
    assert!(!block.contains(&huge));
    assert!(block.contains("uses Neovim"));
    assert_eq!(out.dropped, vec!["n1".to_string()]);
}

/// Everything is dropped and the block is omitted rather than emitted
/// empty. A block that survived with no facts is the failure this guards.
#[test]
fn a_budget_too_small_for_any_row_omits_the_block() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![row("memory", "m1", "User preferences", "uses Neovim")],
        budget_tokens: 0,
    });
    assert!(out.memory_block.is_none());
    assert_eq!(out.dropped, vec!["m1".to_string()]);
    assert_eq!(out.system_prompt, PERSONA);
}

/// The block closes with one directive. Small models skip soft
/// instructions, and a second directive competing with the first is how
/// the block ends up ignored.
#[test]
fn the_block_carries_exactly_one_directive() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![row("memory", "m1", "User preferences", "uses Neovim")],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    assert!(block.starts_with("<memory-context>"));
    assert!(block.trim_end().ends_with("</memory-context>"));
    assert_eq!(block.matches("You MUST").count(), 1);
    assert_eq!(block.matches("<memory-context>").count(), 1);
}

/// Rows are grouped under their label, in first-seen order, so the
/// rendered block is stable across sends.
#[test]
fn rows_are_grouped_by_label_in_first_seen_order() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("memory", "m1", "User preferences", "a"),
            row("memory", "m2", "Project facts", "b"),
            row("memory", "m3", "User preferences", "c"),
        ],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    let prefs = block.find("User preferences").unwrap();
    let project = block.find("Project facts").unwrap();
    assert!(prefs < project);
    assert_eq!(block.matches("## User preferences").count(), 1);
}

/// A row the budget cut is absent from `injected`, not merely absent from
/// the rendered text. Task 4 writes reinforcement from `injected`, so a
/// dropped row leaking in there would record a memory the model never saw —
/// a silent wrong signal into the next turn's boost, which is the exact
/// failure `record_injection` exists to make visible.
#[test]
fn a_dropped_row_is_not_reported_as_injected() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("note", "n1", "Notes", &"x".repeat(4000)),
            row("memory", "m1", "User preferences", "uses Neovim"),
        ],
        budget_tokens: 100,
    });
    let injected: Vec<&str> = out.injected.iter().map(|r| r.owner_id.as_str()).collect();
    assert_eq!(injected, vec!["m1"]);
    assert_eq!(out.dropped, vec!["n1".to_string()]);
    // The two lists partition the input: nothing is in both, nothing is in
    // neither.
    assert!(!out.injected.iter().any(|r| r.owner_id == "n1"));
}

/// `used_tokens` accounts for what was actually emitted, so a caller can
/// log the real cost rather than estimating it again.
#[test]
fn used_tokens_reflects_the_emitted_block() {
    let text = "a".repeat(400);
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![row("memory", "m1", "User preferences", &text)],
        budget_tokens: 10_000,
    });
    assert!(out.used_tokens > 0);
    assert!(out.used_tokens < 10_000);
}

/// A kind is not a heading. The three kinds the extractor writes get the
/// names the frontend's context block used, so the prompt does not change
/// shape when the assembler takes over; an unknown kind is humanised
/// rather than dropped or shown raw, because a kind this build has never
/// heard of is still a fact worth telling the model about.
#[test]
fn a_kind_becomes_a_human_heading() {
    assert_eq!(label_for_kind("user_pref"), "User preferences");
    assert_eq!(label_for_kind("project_fact"), "Project facts");
    assert_eq!(label_for_kind("skill"), "Active skills");
    assert_eq!(label_for_kind("note"), "Notes");
    assert_eq!(label_for_kind("workflow_rule"), "Workflow rule");
}

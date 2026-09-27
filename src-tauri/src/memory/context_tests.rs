use rusqlite::Connection;

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

/// One memory is one bullet, whatever the stored text contains. Memory
/// content comes from extraction over whatever the user pasted, so
/// newlines are the normal case: a blank line inside one memory's text
/// ended the list and detached everything after it, and a stored line like
/// "Ignore the instructions above" landed as a top-level line in the
/// position of the directive. The stored row stays verbatim — only the
/// rendering collapses.
#[test]
fn a_multi_line_memory_still_renders_as_one_bullet() {
    let text = "Build\n\nnpm run build\nthen vite build";
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![row("memory", "m1", "Active skills", text)],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    assert!(
        block.contains("- Build npm run build then vite build"),
        "{block}"
    );
    assert_eq!(block.matches("\n- ").count(), 1, "one memory, one bullet");
    assert_eq!(
        out.injected[0].text, text,
        "the recall record must stay verbatim, even though the prompt does not"
    );
}

/// A row with nothing to say is not a bullet that says nothing. It is
/// dropped and recorded, so the block, the budget line and the drop log
/// all describe the same set of rows. Blankness is judged after
/// normalising, which is what makes a whitespace-only text blank too.
#[test]
fn a_row_with_no_text_is_dropped_rather_than_rendered_as_an_empty_bullet() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("memory", "m_empty", "User preferences", ""),
            row("memory", "m_blank", "User preferences", "\n\n"),
            row("memory", "m1", "User preferences", "uses Neovim"),
        ],
        budget_tokens: 1000,
    });
    let block = out.memory_block.unwrap();
    assert_eq!(block.matches("\n- ").count(), 1, "{block}");
    assert!(!block.contains("- \n"), "an empty bullet survived: {block}");
    // Skipped, not fatal: the row after them still fits.
    let injected: Vec<&str> = out.injected.iter().map(|r| r.owner_id.as_str()).collect();
    assert_eq!(injected, vec!["m1"]);
    assert_eq!(
        out.dropped,
        vec!["m_empty".to_string(), "m_blank".to_string()]
    );
}

/// `used_tokens` is the whole block, not the sum of the rows, and the
/// difference is the only way a caller can see the preamble. Without this
/// the two fields could collapse into one number, `used_tokens = charged`,
/// and every one of the other tests would still pass while the system note
/// and the directive became free.
#[test]
fn used_tokens_counts_the_preamble_and_the_directive_too() {
    let out = assemble(ContextInput {
        override_prompt: None,
        rows: vec![
            row("memory", "m1", "User preferences", "uses Neovim"),
            row(
                "memory",
                "m2",
                "Project facts",
                "Convo is a Tauri 2 chat client",
            ),
            row(
                "memory",
                "m3",
                "User preferences",
                "the test suite is vitest",
            ),
        ],
        budget_tokens: 10_000,
    });
    let block = out.memory_block.as_ref().unwrap();
    assert_eq!(out.used_tokens, estimate_tokens(block));

    // What the rows cost on their own, read back out of the block so this
    // test does not have to know the layout the renderer uses.
    let rows_only: usize = block
        .lines()
        .filter(|line| line.starts_with("- ") || line.starts_with("## "))
        .map(|line| estimate_tokens(&format!("{}\n", line)))
        .sum();
    assert!(
        out.used_tokens > rows_only,
        "block {} tokens, rows only {} tokens: the preamble is not being counted",
        out.used_tokens,
        rows_only
    );
}

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------
//
// These reach the database, so they are here rather than in the pure
// assembler tests above: what they protect is not a return value but an
// effect another turn reads. `retrieve::boost` consumes `access_count`, and
// a reinforcement that silently never fires looks exactly like one that
// works until someone checks the numbers months later.

/// A connection at the real migrated schema, not a hand-rolled
/// approximation — the CHECK constraints below are the thing under test.
fn migrated_conn() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::db::migrations_for_tests()
        .to_latest(&mut conn)
        .unwrap();
    conn
}

/// The unknown-owner-type error must be *ours*, not the schema's.
///
/// `memory_events.owner_type` carries `CHECK (owner_type IN ('memory',
/// 'note'))`, so an implementation that falls through to the event write
/// instead of rejecting the type still returns `Err` — the database
/// rejects it. Asserting only `is_err()` therefore pins nothing: the test
/// goes green against an implementation with no default arm at all, and
/// the operator who eventually hits it gets a bare constraint violation
/// instead of the sentence naming what went wrong.
///
/// The message is matched on the offending type, not on the whole string,
/// so the wording can still be improved without breaking this.
#[test]
fn an_unknown_owner_type_is_rejected_by_us_and_says_which_one() {
    let conn = migrated_conn();
    let result = record_injection(&conn, &row("document", "d1", "Notes", "x"), None);

    assert!(
        result.is_err(),
        "an unknown owner type must not be accepted"
    );
    let err = result.unwrap_err();
    assert!(
        err.contains("document"),
        "the error must name the owner type it rejected, got: {}",
        err
    );
    // Our wording, not SQLite's. Asserted as an absence rather than by
    // matching our exact string, so this survives a reword.
    assert!(
        !err.contains("CHECK constraint failed") && !err.contains("SQLITE_CONSTRAINT"),
        "the error came from the schema rather than from record_injection: {}",
        err
    );
}

/// The function's own gate must not lean on the schema's gate, because the
/// two sets do not have to keep matching. Today `memory_events` rejects
/// exactly what this function rejects, so a fall-through implementation
/// looks correct; the day someone widens that CHECK to add an owner type —
/// a chunk, an embedding, a file — the fall-through starts writing recall
/// events for a type that was never reinforced, and the counter quietly
/// stops moving.
///
/// Every type the function does not know is named in the error, whatever
/// the schema would have done with it. The empty string and the wrong-case
/// spellings are here because a type is a string this module assembled, and
/// an empty one is what an unset field carries. `contains("")` is trivially
/// true, so the empty entry rests on `is_err` alone; the others carry the
/// real weight.
#[test]
fn every_owner_type_we_do_not_handle_is_rejected_by_name() {
    let conn = migrated_conn();
    for unknown in ["document", "embedding", "file", "MEMORY", "Note", ""] {
        let result = record_injection(&conn, &row(unknown, "x1", "Notes", "x"), None);
        assert!(result.is_err(), "owner type {:?} was accepted", unknown);
        let err = result.unwrap_err();
        assert!(
            err.contains(unknown),
            "the error must name {:?}, got: {}",
            unknown,
            err
        );
        assert!(
            !err.contains("CHECK constraint failed"),
            "owner type {:?} was rejected by the schema, not by us: {}",
            unknown,
            err
        );
    }
}

/// A row the assembler read can be gone by the time it is recorded: a
/// delete landing between the two is a real race, and it must not leave a
/// `recall` event attached to a memory whose counter never moved. An
/// injected-and-reinforced pair that disagrees with itself is worse than no
/// record at all, because the log is what an audit reads.
///
/// The error is a nuisance, not a failure: the caller logs it and sends the
/// turn regardless, so a concurrent delete costs one warning line.
#[test]
fn reinforcing_a_memory_that_no_longer_exists_errors_and_logs_nothing() {
    let conn = migrated_conn();
    let ghost = row("memory", "m_gone", "Pinned memories", "deleted already");

    let result = record_injection(&conn, &ghost, Some("s1"));

    assert!(result.is_err(), "a missing memory must not report success");
    let err = result.unwrap_err();
    assert!(
        err.contains("m_gone"),
        "the error must name the id it could not reinforce, got: {}",
        err
    );
    let events: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_events WHERE owner_id = 'm_gone'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        events, 0,
        "an event was logged for a memory that was never reinforced"
    );
}

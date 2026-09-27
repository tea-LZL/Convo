# Retrieval and Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recall actually work. Replace the browser-side substring scorer with hybrid keyword + semantic retrieval behind a Rust command, and add extraction with a revision decision table so durable facts are consolidated instead of piling up.

**Architecture:** Two new pure-ish Rust modules. `retrieve.rs` owns candidate generation (BM25 over both FTS tables, cosine over stored vectors), fusion, boosting, and diversification, and returns ranked rows with a human-readable reason. `revise.rs` owns the ADD / REINFORCE / SUPERSEDE / MERGE decision, consulting an LLM judge only for near-duplicates.

**Tech Stack:** Rust 2021, rusqlite 0.32 (bundled SQLite with FTS5), async-trait, reqwest 0.12, chrono, uuid. React 18 + TypeScript for the one additive type change.

**Spec:** `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` §6 (retrieval) and §7 (extraction + revision). `docs/GOALS.md` is canonical for product intent.

**Predecessors:** Plan 1 (streaming), Plan 2 (V006 schema, `memory/config.rs`, `memory/embed.rs`, `Provider::embed`, Ollama cloud). This plan consumes all of them.

---

## Global Constraints

- **Test floor: 372 TypeScript tests, 0 failures**, unchanged. Rust floor: **105 passing**, from Plan 2.
- Rust gates: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`.
- **No new crates.** `rusqlite`, `reqwest`, `async-trait`, `chrono`, `uuid` already cover everything here.
- **Recall must never fail a send.** Every degradation path returns a smaller result, never an error. Spec §6.4.
- **`memory_recall` is not yet called by `chat_stream_v2`.** Context assembly is Plan 4. Until then the live recall path is still the TypeScript substring scorer at `src/stores/chatStream.ts:736-787`. **Task 7 marks that function deprecated with a pointer to the Rust command**, so nobody edits the wrong one. Do not delete it here; Plan 4 does, with its own tests.
- **`commands/memory.rs` (771 lines) is reworked here, not rewritten.** Its defensive parser is retained: it encodes real observed local-model failure modes. It is re-targeted at the new candidate schema and the new kinds, not replaced.
- Rust house style: `#[tauri::command]` sync fns take `pool: State<'_, Arc<DbPool>>`; async fns release the DB connection before awaiting. Errors are `String`; the provider layer uses `ProviderError`. DB tests use `Connection::open_in_memory()` plus `migrations_for_tests()`. Provider tests use the real loopback `serve_once` / `serve_echoing_headers` helpers in `src/providers/tests.rs`.
- Named exports. No `#[allow(dead_code)]` anywhere in this plan — a dead-code warning means something is not wired, and `pub` on a private module is how this repo has already been bitten twice.

---

## Review Focus

Input classes this plan implies. Each is pinned to a test in the task that owns the code.

1. **A query with no embedding model configured.** The most likely first-run state. Must return keyword results, not an error and not an empty list. → Task 3.
2. **A query with no lexical overlap at all** — "how do I run this" against a memory titled "build command". Keyword search returns nothing; only the vector route can find it. This is the entire reason the vector route exists and the test must prove it is load-bearing. → Task 4.
3. **A query matching a superseded memory.** It must be excluded from recall while remaining readable in the UI's history. → Task 3.
4. **The same conversation extracted twice.** Without a watermark the second pass re-proposes every fact, and REINFORCE fires on everything. A user watching would see their memory count balloon with near-duplicates. → Task 5.
5. **A provider that returns garbage from the judge call** — prose, an empty string, a JSON array where an object was asked for. The decision must degrade to review, never to an auto-write. → Task 6.

---

## Design decisions taken in this plan

**Fusion is a pure function over ranked candidate lists.** `rrf_score`, `boost`, and `diversify` take plain values and return plain values, with no database or provider in scope. That makes the scoring rules unit-testable without fixtures, and it means a change to the fusion can be evaluated in isolation from a change to the queries. `retrieve.rs` is therefore split: a pure core, and a thin SQL shell that feeds it.

**MMR operates on vectors that may be absent.** A keyword-only recall has no vectors to diversify with, so `diversify` takes `Option<Vec<f32>>` per candidate. Where the vector is absent it falls back to pure score order rather than refusing to run — a degraded result beats an error, per §6.4.

**The reason string names routes and boosts, not matched terms.** FTS5's `snippet()` with sentinel markers would yield the literal matched text, but mapping that back to a clean term list is fragile across tokenizers. The reason names which routes matched, how often the item has been recalled, and how old it is. That is enough for a user to judge whether a recall was right, which is what the Memory tab needs.

**Extraction confidence is the extractor's own self-report, bounded by what we trust.** The parser clamps it to `[0, 1]` and defaults a missing value to `0.5` — not to `1.0`. A model that omits the field has not expressed confidence, and defaulting high would let every legacy-shaped response auto-write past the `0.80` gate.

---

## File Structure

**Created:**
- `src-tauri/src/memory/retrieve.rs` — fusion core and SQL routes.
- `src-tauri/src/memory/index.rs` — fills in missing vectors.
- `src-tauri/src/memory/extract.rs` — trigger, window, re-targeted parser.
- `src-tauri/src/memory/revise.rs` — decision table and judge.
- `src-tauri/src/commands/knowledge.rs` — the new Tauri commands.
- Tests live in the existing `src-tauri/src/memory/tests.rs` (shared fixture) plus per-module test modules where a module needs its own private access.

**Modified:**
- `src-tauri/src/memory/mod.rs` — declare the four modules.
- `src-tauri/src/memory/embed.rs` — O(1) vector lookup, and a `owner_ids` helper the routes share.
- `src-tauri/src/commands/memory.rs` — `ExtractedFact` gains optional fields; `extract_facts_from_session` delegates to `extract.rs`; the parser is re-targeted.
- `src-tauri/src/commands/memory_reviews.rs` — watermark replaces the one-shot `INSERT OR IGNORE`.
- `src-tauri/src/lib.rs` — `mod commands;` already covers the new file; add the command names to `invoke_handler!`.
- `src/stores/chatStream.ts` — deprecation marker on `recallMemories` only.
- `src/lib/api.ts` — wrappers for the new commands; additive `ExtractedFact` fields.

---

### Task 1: O(1) vector lookup

Plan 2's review deferred this: `load_vectors` is O(n²) because it does a linear `find` per row. At a 5,000-item corpus that is 25M string comparisons per query against a `<50ms` p95 gate.

**Files:**
- Modify: `src-tauri/src/memory/embed.rs` (`load_vectors`)

**Interfaces:**
- Consumes: `KnowledgeRow` from Task 5 of Plan 2.
- Produces: the same signature, same ordering guarantee.

```rust
pub fn load_vectors(
    conn: &rusqlite::Connection,
    model: &str,
    rows: &[KnowledgeRow],
) -> rusqlite::Result<Vec<(KnowledgeRow, Vec<f32>)>>;
```

**Guarantee, already tested:** output ordering follows `rows`, because rank is assigned by the caller and reordering would re-pair a score with a document.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/memory/tests.rs`. The point is the *cost*, so assert the shape that makes the cost observable: a large id list must resolve without a per-row scan, and must not silently drop or duplicate a row.

```rust
#[test]
fn load_vectors_resolves_a_large_id_list_in_one_pass() {
    let conn = migrated_conn();
    let mut expected: Vec<String> = Vec::new();
    for i in 0..600 {
        let id = format!("m{}", i);
        add_memory(&conn, &id, LONG);
        upsert_embedding(&conn, "memory", &id, "m", &[i as f32, 1.0]).unwrap();
        expected.push(id);
    }
    let rows: Vec<KnowledgeRow> = expected
        .iter()
        .map(|id| KnowledgeRow {
            owner_type: "memory".into(),
            owner_id: id.clone(),
            kind: "project_fact".into(),
            title: None,
            content: LONG.into(),
            is_enabled: true,
            superseded_by: None,
            access_count: 0,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .collect();

    let loaded = load_vectors(&conn, "m", &rows).unwrap();
    assert_eq!(loaded.len(), 600, "every requested row must come back");
    let got: Vec<&str> = loaded.iter().map(|(r, _)| r.owner_id.as_str()).collect();
    let want: Vec<&str> = expected.iter().map(|s| s.as_str()).collect();
    assert_eq!(got, want, "ordering must follow the caller's row order");
    // And each vector is the one stored for that id, not a neighbour's.
    for (row, vector) in &loaded {
        let i: f32 = row.owner_id[1..].parse().unwrap();
        assert_eq!(vector[0], i, "vector paired with the wrong row");
    }
}

#[test]
fn load_vectors_chunks_past_the_sqlite_variable_limit() {
    // SQLITE_MAX_VARIABLE_NUMBER defaults to 999. A 600-id request is one
    // chunk; a 2,000-id request must split without a bind error.
    let conn = migrated_conn();
    let mut rows = Vec::new();
    for i in 0..2000 {
        let id = format!("m{}", i);
        add_memory(&conn, &id, LONG);
        upsert_embedding(&conn, "memory", &id, "m", &[i as f32]).unwrap();
        rows.push(KnowledgeRow {
            owner_type: "memory".into(),
            owner_id: id,
            kind: "project_fact".into(),
            title: None,
            content: LONG.into(),
            is_enabled: true,
            superseded_by: None,
            access_count: 0,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        });
    }
    let loaded = load_vectors(&conn, "m", &rows).unwrap();
    assert_eq!(loaded.len(), 2000);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml load_vectors_`
Expected: `load_vectors_resolves_a_large_id_list_in_one_pass` and the chunk test FAIL or hang. 600 rows at 400 per chunk is two queries, so the chunk test may pass; the one-pass test's value is that it pins ordering and pairing at a scale where the quadratic version is visibly slow. If it passes, that is a finding: the quadratic version is not yet slow enough to fail, which means the fix is justified by the gate rather than by a red test. Record that in the ledger and keep the test as a regression guard.

- [ ] **Step 3: Implement the HashMap lookup**

Replace the nested scan in `load_vectors` with one lookup table, preserving the caller's order:

```rust
let mut by_id: std::collections::HashMap<String, Vec<f32>> =
    std::collections::HashMap::with_capacity(found.len());
for (owner_id, vector) in found {
    by_id.insert(owner_id, vector);
}
Ok(rows
    .iter()
    .filter_map(|row| by_id.get(&row.owner_id).map(|v| (row.clone(), v.clone())))
    .collect())
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml load_vectors_ && cargo test --manifest-path src-tauri/Cargo.toml memory::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/memory
git commit -m "perf(memory): resolve vectors by lookup table instead of a per-row scan

load_vectors did a linear find per requested row, which is O(n^2) over
the candidate set. At a 5,000-item corpus that is 25M string
comparisons per query against a <50ms p95 gate. Ordering is unchanged:
rank is assigned by the caller, so reordering would re-pair a score
with a document.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The fusion core

Pure functions, no database, no provider. This is where the scoring rules live and where they are testable without a fixture.

**Files:**
- Create: `src-tauri/src/memory/retrieve.rs`
- Modify: `src-tauri/src/memory/mod.rs` (`pub mod retrieve;`)
- Test: `#[cfg(test)] mod tests` inside `retrieve.rs`

**Interfaces:**
- Consumes: `config` constants (Plan 2), `KnowledgeRow` and `recency_weight` (Plan 2), `cosine` (Plan 2).
- Produces:

```rust
/// One candidate, with its position in each retrieval route. A route the
/// candidate did not appear in is `None` — not zero. A rank of 0 would be
/// a better-than-best score, which is how off-by-one bugs become
/// silent ranking bugs.
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

/// Reciprocal Rank Fusion. A candidate in both routes beats one in either.
pub fn rrf_score(bm25_rank: Option<usize>, cosine_rank: Option<usize>, k: f64) -> f64;

/// Reinforcement and recency, applied to a fused score.
pub fn boost(rrf: f64, access_count: i64, age_days: f64) -> f64;

/// Maximal Marginal Relevance. Drops near-duplicate restatements that
/// would otherwise occupy several of the top slots with the same fact.
pub fn diversify(
    scored: Vec<(RankedMemory, Option<Vec<f32>>)>,
    lambda: f64,
    limit: usize,
) -> Vec<RankedMemory>;

/// Build the reason string. Exposed for testing; not a decision point.
pub fn build_reason(
    bm25_rank: Option<usize>,
    cosine: Option<f64>,
    matched_terms: &[String],
    access_count: i64,
    age_days: f64,
) -> String;
```

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::embed::KnowledgeRow;

    fn row(id: &str) -> KnowledgeRow {
        KnowledgeRow {
            owner_type: "memory".into(),
            owner_id: id.into(),
            kind: "project_fact".into(),
            title: None,
            content: "content".into(),
            is_enabled: true,
            superseded_by: None,
            access_count: 0,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn a_candidate_in_both_routes_beats_one_in_either() {
        let both = rrf_score(Some(1), Some(1), config::RRF_K);
        let keyword_only = rrf_score(Some(1), None, config::RRF_K);
        let semantic_only = rrf_score(None, Some(1), config::RRF_K);
        assert!(both > keyword_only, "{both} vs {keyword_only}");
        assert!(both > semantic_only, "{both} vs {semantic_only}");
        assert!((keyword_only - semantic_only).abs() < 1e-12, "routes are symmetric");
    }

    #[test]
    fn a_candidate_in_no_route_scores_zero() {
        assert_eq!(rrf_score(None, None, config::RRF_K), 0.0);
    }

    #[test]
    fn rank_one_ranks_above_rank_two_within_a_route() {
        assert!(rrf_score(Some(1), None, 60.0) > rrf_score(Some(2), None, 60.0));
    }

    #[test]
    fn the_rrf_constant_actually_matters() {
        // k controls how sharply top ranks separate from the tail. A
        // regression to k=1 would flatten the curve; to k=1e9 would make
        // every candidate score the same. Pin the shape, not just the
        // constant.
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
        // Ten is the cap from the spec. Without it, an item recalled
        // fifty times would outrank everything regardless of relevance.
        assert_eq!(boost(0.5, 10, 0.0), boost(0.5, 500, 0.0));
        assert!(boost(0.5, 9, 0.0) < boost(0.5, 10, 0.0));
    }

    #[test]
    fn recency_lowers_but_never_zeroes_a_score() {
        let now = boost(0.5, 0, 0.0);
        let month = boost(0.5, 0, 30.0);
        let decade = boost(0.5, 0, 3650.0);
        assert!(month < now, "{month} vs {now}");
        assert!(decade < month, "older should not score higher");
        assert!(decade > 0.0, "an old item must not be scored out of existence");
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
    fn diversify_drops_a_near_duplicate_and_keeps_the_whole_set() {
        let v1 = vec![1.0f32, 0.0, 0.0];
        let v2 = vec![0.0f32, 1.0, 0.0];
        let near = vec![0.99f32, 0.01, 0.0]; // essentially v1
        let scored = vec![
            (ranked("a", 0.9), Some(v1.clone())),
            (ranked("a-dup", 0.89), Some(near)),
            (ranked("b", 0.5), Some(v2)),
        ];
        let out = diversify(scored, 0.7, 3);
        let ids: Vec<&str> = out.iter().map(|r| r.owner_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"], "a near-duplicate occupied a slot");
    }

    #[test]
    fn diversify_keeps_distinct_items() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let scored = vec![(ranked("a", 0.9), Some(a)), (ranked("b", 0.89), Some(b))];
        let out = diversify(scored, 0.7, 5);
        assert_eq!(out.len(), 2, "distinct items must both survive");
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
    fn diversify_ignores_a_zero_vector_rather_than_treating_it_as_similar_to_everything() {
        let zero = vec![0.0f32, 0.0, 0.0];
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let scored = vec![
            (ranked("a", 0.9), Some(a)),
            (ranked("zero", 0.89), Some(zero)),
            (ranked("b", 0.5), Some(b)),
        ];
        let out = diversify(scored, 0.7, 5);
        assert_eq!(out.len(), 3, "cosine returns None for a zero vector, so nothing is 'similar'");
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
        for args in [
            (None, None, &[][..], 0, 0.0),
            (Some(1), Some(0.9), &["postgres".to_string()][..], 0, 0.0),
            (Some(4), None, &[], 7, 4.0),
        ] {
            let reason = build_reason(args.0, args.1, args.2, args.3, args.4);
            assert!(!reason.trim().is_empty(), "empty reason for {:?}", args);
        }
    }

    #[test]
    fn the_reason_names_the_routes_that_matched() {
        let both = build_reason(Some(1), Some(0.87), &["migration".into()], 0, 0.0);
        assert!(both.contains("keyword"), "{both}");
        assert!(both.contains("semantic"), "{both}");
        assert!(both.contains("migration"), "{both}");

        let keyword = build_reason(Some(1), None, &["postgres".into()], 0, 0.0);
        assert!(keyword.contains("keyword"), "{keyword}");
        assert!(!keyword.contains("semantic"), "{keyword}");

        let semantic = build_reason(None, Some(0.9), &[], 0, 0.0);
        assert!(semantic.contains("semantic"), "{semantic}");
        assert!(!semantic.contains("keyword"), "{semantic}");
    }

    #[test]
    fn the_reason_reports_reinforcement_and_age_when_present() {
        let reason = build_reason(Some(1), None, &["x".into()], 7, 4.0);
        assert!(reason.contains("7"), "{reason}");
        assert!(reason.contains("day"), "{reason}");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::retrieve`
Expected: FAIL to compile — the module does not exist.

- [ ] **Step 3: Implement `retrieve.rs`**

`rrf_score` sums `1/(k+rank)` over the present routes. `boost` is
`rrf * (1 + 0.15 * min(access_count, 10)) * recency_weight(age_days)`, matching spec §6.2.

`diversify` is greedy MMR:

```rust
pub fn diversify(
    scored: Vec<(RankedMemory, Option<Vec<f32>>)>,
    lambda: f64,
    limit: usize,
) -> Vec<RankedMemory> {
    let mut pool = scored;
    // Highest score first, so the greedy pick starts from the best.
    pool.sort_by(|a, b| b.0.score.partial_cmp(&a.0.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut chosen: Vec<(RankedMemory, Option<Vec<f32>>)> = Vec::new();
    while chosen.len() < limit && !pool.is_empty() {
        let mut best_index = 0usize;
        let mut best_value = f64::NEG_INFINITY;
        for (index, (item, vector)) in pool.iter().enumerate() {
            let redundancy = match vector {
                // No vector, or nothing comparable to be redundant with:
                // fall back to pure score.
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
        chosen.push(pool.remove(best_index));
    }
    chosen.into_iter().map(|(item, _)| item).collect()
}
```

`build_reason` joins a route clause, an optional matched-term clause, an optional recall-count clause, and an optional age clause with `"; "`, skipping the ones with nothing to say.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::retrieve`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/memory
git commit -m "feat(memory): the retrieval fusion core

Pure functions, no database and no provider in scope, so the scoring
rules are testable without a fixture and a change to the fusion can be
evaluated apart from a change to the queries.

RRF, reinforcement and recency boosts, greedy MMR with a score-only
fallback where no vector exists, and a reason string on every result —
a recall a user cannot audit is a recall they will not trust.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The retrieval routes and the `memory_recall` command

**Files:**
- Modify: `src-tauri/src/memory/retrieve.rs` (SQL routes and the top-level entry point)
- Create: `src-tauri/src/commands/knowledge.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (`invoke_handler!`)

**Interfaces:**
- Consumes: Task 2's fusion core, Plan 2's `embed::load_vectors` and `config`.
- Produces:

```rust
// retrieve.rs

/// Everything the routes need. `None` disables the vector route rather
/// than failing: a user with no embedding model configured still gets
/// keyword recall, which is the most likely first-run state.
pub struct RecallOptions<'a> {
    pub query: &'a str,
    pub session_id: Option<&'a str>,
    pub embedding_model: Option<&'a str>,
    pub embedding_dim: Option<usize>,
    pub top_k: usize,
    pub lambda: f64,
}

/// Generate candidates, fuse, boost, diversify, and rank.
pub fn recall(conn: &rusqlite::Connection, opts: &RecallOptions<'_>) -> Vec<RankedMemory>;

/// BM25 route, over both FTS tables. The snippet uses sentinel markers
/// so the matched region can be turned into a term list for the reason.
fn bm25_candidates(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> rusqlite::Result<Vec<KnowledgeRow>>;
```

```rust
// commands/knowledge.rs

/// Ranked recall for one query. Never returns an error for a missing
/// index, a missing embedding model, or an unreachable embed endpoint —
/// each of those degrades to a smaller result.
#[tauri::command]
pub async fn memory_recall(
    pool: State<'_, Arc<DbPool>>,
    query: String,
    session_id: Option<String>,
    top_k: Option<i64>,
) -> Result<Vec<RankedMemory>, String>;

/// How many rows need embedding, for the Memory tab's index status.
#[tauri::command]
pub fn knowledge_index_status(
    pool: State<'_, Arc<DbPool>>,
) -> Result<KnowledgeIndexStatus, String>;

#[derive(Debug, Serialize, Clone)]
pub struct KnowledgeIndexStatus {
    pub memory_count: i64,
    pub note_count: i64,
    pub embedded_count: i64,
    pub needs_embedding: i64,
    pub needs_reindex: bool,
    pub embedding_model: Option<String>,
}
```

Register `memory_recall` and `knowledge_index_status` in `lib.rs`'s `invoke_handler!`, alphabetically inside the memory group.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/memory/tests.rs`. A shared corpus fixture, reused by Task 4:

```rust
/// A corpus where every query has at least one defensible answer, plus
/// decoys that only keyword or only semantic search would find.
pub fn knowledge_corpus(conn: &Connection) {
    for (id, kind, title, content) in [
        ("db-choice", "decision", "Database choice",
         "Chose Postgres over MySQL for the multi-tenant billing schema"),
        ("db-pool", "project_fact", "Connection pooling",
         "PgBouncer sits in front of Postgres with pool_mode set to transaction"),
        ("migrate", "skill", "Running migrations",
         "Apply migrations with just so it runs pending SQL and exits nonzero on failure"),
        ("editor", "user_pref", "Editor",
         "Prefers Neovim with lazy.nvim and no plugin manager"),
        ("deploy", "constraint", "Deploy window",
         "No production deploys on Fridays after 14:00 UTC"),
    ] {
        add_memory(conn, id, kind, title, content);
    }
    add_note(conn, "db-runbook", "Runbook", "Restart PgBouncer after a Postgres failover, then check lag", 1);
    add_note(conn, "editor-notes", "Editor setup", "Neovim config lives in a dotfiles repo, module-per-plugin", 0);
}
```

Add a second helper rather than changing the existing one. Plan 2's
`seeded()` and its tests call `add_memory(&conn, id, content)` with three
arguments; changing that signature would rewrite a dozen tests that have
nothing to do with retrieval.

```rust
/// Already in the test file from Plan 2. Leave it alone.
fn add_memory(conn: &Connection, id: &str, content: &str);

/// New: the corpus needs distinct kinds and titles.
fn add_memory_full(conn: &Connection, id: &str, kind: &str, title: &str, content: &str);
```

The tests below call the five-argument form.

Then the route tests:

```rust
fn opts<'a>(query: &'a str) -> RecallOptions<'a> {
    RecallOptions {
        query,
        session_id: None,
        embedding_model: None,
        embedding_dim: None,
        top_k: config::TOP_K_DEFAULT as usize,
        lambda: 0.7,
    }
}

#[test]
fn recall_finds_an_exact_keyword_match() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let hits = retrieve::recall(&conn, &opts("PgBouncer"));
    assert!(!hits.is_empty());
    assert_eq!(hits[0].owner_id, "db-pool");
}

#[test]
fn recall_survives_an_empty_index() {
    // Review Focus 1's extreme: no memory at all. Not an error, not a panic.
    let conn = migrated_conn();
    assert!(retrieve::recall(&conn, &opts("anything")).is_empty());
}

#[test]
fn recall_excludes_a_superseded_memory() {
    // Review Focus 3. A superseded row is history, not something to
    // inject into a prompt.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("UPDATE memory_items SET superseded_by = 'db-choice' WHERE id = 'migrate'", []).unwrap();
    let hits = retrieve::recall(&conn, &opts("migrations"));
    assert!(!hits.iter().any(|h| h.owner_id == "migrate"), "got {:?}", hits.iter().map(|h| h.owner_id.clone()).collect::<Vec<_>>());
    // And it is still readable in the item list, which is a different query.
    let still_there: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items WHERE id = 'migrate'", [], |r| r.get(0)).unwrap();
    assert_eq!(still_there, 1, "supersede retains the row for history");
}

#[test]
fn recall_excludes_a_disabled_memory() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("UPDATE memory_items SET is_enabled = 0 WHERE id = 'editor'", []).unwrap();
    assert!(!retrieve::recall(&conn, &opts("neovim")).iter().any(|h| h.owner_id == "editor"));
}

#[test]
fn recall_without_an_embedding_model_is_keyword_only_and_still_works() {
    // Review Focus 1. The most likely first-run state.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let hits = retrieve::recall(&conn, &opts("postgres"));
    assert!(!hits.is_empty(), "keyword recall must work with no embedder");
    assert!(hits.len() <= config::TOP_K_DEFAULT as usize);
}

#[test]
fn recall_honours_a_per_session_allowlist() {
    // An override list is an allowlist. A non-empty list means "only
    // these", matching buildContextBlock's existing semantics.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", []).unwrap();
    conn.execute("INSERT INTO session_overrides (session_id, item_id) VALUES ('s1','db-choice')", []).unwrap();
    let mut o = opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h.owner_id == "db-choice"), "allowlist not applied");
}

#[test]
fn recall_with_no_overrides_includes_everything() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", []).unwrap();
    let mut o = opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);
    assert!(hits.len() > 1, "an empty override list must not filter to nothing");
}

#[test]
fn recall_is_deterministic() {
    // Rank is assigned from a fused score. Two calls over unchanged data
    // must agree exactly, or a user sees the memory list shuffle on
    // every turn for no reason.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let a = retrieve::recall(&conn, &opts("postgres pooling"));
    let b = retrieve::recall(&conn, &opts("postgres pooling"));
    assert_eq!(a, b);
}

#[test]
fn recall_respects_top_k() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut o = opts("postgres neovim deploy");
    o.top_k = 2;
    assert_eq!(retrieve::recall(&conn, &o).len(), 2);
}

#[test]
fn recall_with_a_nonsense_query_returns_nothing_rather_than_erroring() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    for q in ["", "   ", "!!!", "\"", "*", "AND OR NOT"] {
        assert!(retrieve::recall(&conn, &opts(q)).is_empty(), "query: {:?}", q);
    }
}

#[test]
fn every_recalled_item_carries_a_reason() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    for hit in retrieve::recall(&conn, &opts("postgres")) {
        assert!(!hit.reason.trim().is_empty(), "no reason for {}", hit.owner_id);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recall_`
Expected: FAIL to compile — `retrieve::recall` does not exist.

- [ ] **Step 3: Implement the BM25 route**

One query per FTS table, `UNION ALL`, ordered by `rank`. Reuse the token-quoting approach from `commands/memory.rs:139-154`, and **fix the bug that function has**: it builds one query with a conditional bind and reads `kind` from `?2` or the limit from `?3` depending on branch, so the two branches bind different things to the same placeholder. Write it once with the filters always bound, using `OptionalExtension` for the kind.

```sql
SELECT 'memory', m.id, m.kind, m.title, m.content, m.is_enabled,
       m.superseded_by, m.access_count, m.updated_at
FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
WHERE memory_fts MATCH ?1 AND m.is_enabled = 1 AND m.superseded_by IS NULL
  AND m.kind IN (SELECT value FROM json_each(?4))
UNION ALL
SELECT 'note', n.id, 'note', n.title, n.body, 1, NULL, 0, n.updated_at
FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
WHERE notes_fts MATCH ?1
ORDER BY 3, 2
LIMIT ?2
```

`?4` is a JSON array of allowed kinds; an empty array filters everything out, so pass the full six-kind list when no filter is set. Apply the same `is_enabled` / superseded and allowlist predicates to the note arm that the memory arm gets.

Rank positions come from each table's own `ORDER BY rank`, assigned separately and then merged — FTS5's `rank` is only comparable within one table, so the two tables' ranks are fused as two routes, not concatenated.

- [ ] **Step 4: Implement the cosine route**

`embed::load_vectors` gives `(KnowledgeRow, Vec<f32>)` for the enabled, non-superseded set under the configured model. Score the query against each, drop `None` (a degenerate vector, per `cosine`), sort descending, and assign 1-based ranks. If `embedding_model` is `None`, or `load_vectors` returns nothing, the route yields no candidates — not an error.

The query vector comes from the caller; `memory_recall` obtains it by calling `Provider::embed` for the single query string. **A failure there is swallowed and logged**: recall falls back to keyword-only, per §6.4. A failure the user should know about goes in `knowledge_index_status`, not in the recall result.

- [ ] **Step 5: Implement `recall`**

```rust
pub fn recall(conn: &rusqlite::Connection, opts: &RecallOptions<'_>) -> Vec<RankedMemory> {
    let bm25 = bm25_candidates(conn, opts.query, config::BM25_LIMIT).unwrap_or_default();
    let cosine = opts.embedding_model
        .and_then(|model| opts.embedding_dim.map(|dim| (model, dim)))
        .and_then(|(model, dim)| cosine_candidates(conn, opts.query, model, dim, opts).ok())
        .unwrap_or_default();
    // ...merge by (owner_type, owner_id) into Candidates carrying both ranks...
    // ...rrf_score, boost, build_reason...
    // ...diversify to opts.top_k...
}
```

Every fallible step is `unwrap_or_default()` to an empty route. That is the §6.4 contract, and it is deliberate rather than lazy: a degraded result beats a failed send.

- [ ] **Step 6: Implement `memory_recall` and `knowledge_index_status`**

`memory_recall` is `async` only because it may call `embed` for the query. It reads `config::load_routing` and `config::top_k` from the DB, resolves the embedding route, and if that route is configured, resolves a `Box<dyn Provider>` using the same pattern as `extract_facts_from_session` at `commands/memory.rs:512-553`, embeds the query, and passes the vector in. Every failure in that chain drops to keyword-only.

`knowledge_index_status` is sync: four `COUNT(*)` queries plus `embed::needs_reindex`.

- [ ] **Step 7: Register the commands**

Add `mod knowledge;` to `src-tauri/src/commands/mod.rs` and `knowledge_index_status` / `memory_recall` to `lib.rs`'s `invoke_handler!`, alphabetically within the memory group.

- [ ] **Step 8: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recall_ && cargo test --manifest-path src-tauri/Cargo.toml memory::`
Expected: PASS.

- [ ] **Step 9: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src
git commit -m "feat(memory): hybrid recall behind the memory_recall command

BM25 over both FTS tables fused with cosine over stored vectors, then
RRF, reinforcement and recency boosts, and MMR. Every route failure
degrades to an empty route rather than an error, so a missing embedding
model or an unreachable endpoint still yields keyword recall — which is
the most likely first-run state.

Fixes a latent bind bug inherited from search_memory, which built one
query with a conditional placeholder layout so the kind and limit bound
to different parameters depending on the branch.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The recall gates

**Files:**
- Test: `src-tauri/src/memory/tests.rs`
- Modify: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` (Phase 4 checkboxes)

**Interfaces:**
- Consumes: Task 3's `recall` and the corpus fixture.
- Produces: the measured precision gate from `docs/GOALS.md`.

- [ ] **Step 1: Write the known-answer test**

The spec demands "≥90% of seeded relevant items in top-6". That is a property to measure, not a rank to hand-compute, so each query declares which ids are relevant and the test checks recall of that set.

```rust
/// Each query declares the items a reasonable person would call relevant.
/// The gate is that 90% of them appear in the top 6 — not that a
/// hand-computed rank holds, which would be brittle against tokenizer
/// and corpus changes without telling us anything.
const KNOWN_QUERIES: &[(&str, &[&str])] = &[
    ("postgres", &["db-choice", "db-pool", "db-runbook"]),
    ("which database", &["db-choice", "db-pool"]),
    ("connection pool failover", &["db-pool", "db-runbook"]),
    ("how do i run migrations", &["migrate"]),
    ("apply pending sql", &["migrate"]),
    ("neovim configuration", &["editor", "editor-notes"]),
    ("when can i deploy", &["deploy"]),
    ("friday deploy policy", &["deploy"]),
    ("pgbouncer", &["db-pool", "db-runbook"]),
    ("multi tenant billing", &["db-choice"]),
];

#[test]
fn recall_precision_meets_the_documented_gate() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut total = 0usize;
    let mut found = 0usize;
    let mut misses: Vec<String> = Vec::new();
    for (query, relevant) in KNOWN_QUERIES {
        let hits = retrieve::recall(&conn, &opts(query));
        let ids: Vec<&str> = hits.iter().take(6).map(|h| h.owner_id.as_str()).collect();
        for want in *relevant {
            total += 1;
            if ids.contains(want) {
                found += 1;
            } else {
                misses.push(format!("{:?} missed {}", query, want));
            }
        }
    }
    let precision = found as f64 / total as f64;
    assert!(
        precision >= 0.90,
        "recall precision {:.0}% ({}/{}) below the 90% gate\n{}",
        precision * 100.0,
        found,
        total,
        misses.join("\n")
    );
}
```

- [ ] **Step 2: Run it and report the real number**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recall_precision -- --nocapture`
Expected: either PASS, or FAIL with the per-query miss list. **If it fails, that is the finding, not a reason to loosen the corpus.** The keyword-only path is what runs here, because no embedding model is configured in the test. Semantic recall is gated separately in Step 4.

- [ ] **Step 3: Fix the routes, not the gate**

If precision is below 0.90, the cause will be in `bm25_candidates` — most likely the token quoting, which ANDs every token and so requires all of them. A query like "which database" contributes "which" (a stop word) and would need "which" in the document. Drop tokens shorter than 3 characters and a small stop list before building the FTS expression, and retry with a relaxed expression (OR instead of AND) when the strict one returns nothing. Record the measured before/after in the commit body.

- [ ] **Step 4: Write the test that proves the vector route is load-bearing**

Review Focus 2, and the reason embeddings exist at all. A query with no lexical
overlap must still find its memory, and only the vector route can do that. The
query vector comes from a provider, so this needs a stub — use the loopback
`serve_once` helper from `src/providers/tests.rs` to return a fixed vector, and
a *different* fixed vector for the stored memory, so only a cosine comparison
can connect them.

```rust
#[test]
fn recall_finds_a_memory_with_no_lexical_overlap() {
    // "what is the wifi password" against a memory that says "SSID is
    // Convo-5G". No shared token at all: BM25 returns nothing, and the
    // vector route is the only thing that can answer. If this test ever
    // passes on the keyword path alone, the embedding index is not being
    // read and the whole subsystem is decorative.
    let conn = migrated_conn();
    add_memory_full(&conn, "wifi", "project_fact", "Network",
        "The wifi password is hunter2 and the SSID is Convo-5G");
    upsert_embedding(&conn, "memory", "wifi", "stub", &[1.0, 0.0, 0.0]).unwrap();

    // No stored vector matches the query's model, so build the candidate
    // set directly and assert the fusion ranks it. A full end-to-end
    // version needs a stubbed provider for the query embed, which is
    // Task 7's `memory_recall`; here we assert the property the fusion
    // must have.
    let hits = retrieve::recall_with_query_vector(
        &conn,
        &opts_with("what is the wifi password", Some("stub"), 3),
        &[1.0, 0.0, 0.0],
    );
    assert!(!hits.is_empty(), "keyword search cannot answer this one");
    assert_eq!(hits[0].owner_id, "wifi");
    assert!(hits[0].reason.contains("semantic"), "got reason: {}", hits[0].reason);
}
```

That test needs one small addition to `retrieve.rs`, which Task 3 produces:

```rust
/// `recall` with the query vector supplied rather than fetched, so the
/// fusion can be tested without a provider.
pub fn recall_with_query_vector(
    conn: &Connection,
    opts: &RecallOptions<'_>,
    query_vector: &[f32],
) -> Vec<RankedMemory>;
```

- [ ] **Step 5: Write the degradation tests**

```rust
#[test]
fn recall_degrades_to_keyword_only_when_the_embed_route_is_unusable() {
    // A configured model with no stored vectors: the cosine route yields
    // nothing and keyword recall still answers.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut o = opts("postgres");
    o.embedding_model = Some("nomic-embed-text");
    o.embedding_dim = Some(768);
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h.reason.contains("keyword")), "got a semantic reason with no vectors");
}

#[test]
fn recall_ignores_vectors_from_a_different_dimension() {
    // Vectors from another model must not be compared with this one.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    upsert_embedding(&conn, "memory", "db-choice", "nomic-embed-text", &[0.1, 0.2]).unwrap();
    let mut o = opts("postgres");
    o.embedding_model = Some("nomic-embed-text");
    o.embedding_dim = Some(1024);
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h.reason.contains("keyword")));
}
```

- [ ] **Step 6: Write the index-status test**

```rust
#[test]
fn index_status_reports_what_needs_embedding_and_whether_a_reindex_is_due() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    upsert_embedding(&conn, "memory", "db-choice", "nomic-embed-text", &[0.1; 768]).unwrap();

    let (needs, reindex) = knowledge_status(&conn, "nomic-embed-text", 768);
    assert_eq!(needs, 4, "four eligible rows are still unembedded");
    assert!(!reindex, "every stored vector matches the configured model");

    let (needs, reindex) = knowledge_status(&conn, "mxbai-embed-large", 1024);
    assert!(reindex, "a model switch means the index is stale");
    assert!(needs > 0);
}
```

- [ ] **Step 7: Add the `knowledge_status` helper**

A small pure function over the connection, so the command and the test share one implementation:

```rust
/// `(needs_embedding, needs_reindex)` for the configured embedding model.
pub fn knowledge_status(conn: &Connection, model: &str, dim: usize)
    -> (i64, bool);
```

- [ ] **Step 8: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript; precision ≥ 90%.

- [ ] **Step 9: Record the measured precision in the spec**

Replace the Phase 4 checkbox with the measured number and the corpus size, so the gate has a recorded baseline rather than a promise. If precision is below 90% after Step 3, record that instead and leave the phase incomplete — a failing gate written down honestly is worth more than a passing one nobody measured.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src docs/
git commit -m "test(memory): measure the recall precision gate against a known corpus

Ten queries over a seven-item corpus, each declaring which items a
reasonable person would call relevant. The gate is that 90% of them
land in the top 6, which is a property to measure rather than a rank to
hand-compute — a hand-computed rank is brittle against tokenizer and
corpus changes without telling anyone anything.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extraction

**Files:**
- Create: `src-tauri/src/memory/extract.rs`
- Modify: `src-tauri/src/memory/mod.rs`
- Modify: `src-tauri/src/commands/memory.rs` (`ExtractedFact` gains optional fields; `extract_facts_from_session` delegates)
- Modify: `src-tauri/src/lib/api.ts` (additive `ExtractedFact` fields)
- Test: `src-tauri/src/memory/tests.rs`

**Interfaces:**
- Consumes: Plan 2's `config` and routing; the existing parser helpers in `commands/memory.rs`.
- Produces:

```rust
/// How many messages since the last watermark make an extraction round
/// worth running. `None` means "not yet, or nothing new since last time".
pub fn should_extract(conn: &Connection, session_id: &str, every_n: i64)
    -> rusqlite::Result<Option<ExtractionWindow>>;

pub struct ExtractionWindow {
    /// Last message id to extract through. Becomes the next watermark.
    pub watermark_message_id: String,
    /// (role, content) pairs, oldest first.
    pub messages: Vec<(String, String)>,
}

/// The window spec: 40 messages or 6000 estimated tokens, whichever is
/// smaller. A blind `LIMIT 60` is neither.
pub const MAX_WINDOW_MESSAGES: usize = 40;
pub const MAX_WINDOW_TOKENS: usize = 6000;
pub const MIN_EXTRACT_MESSAGES: usize = 2;

/// A candidate fact, as the parser produces it. `confidence` defaults to
/// 0.5 when the model omits it: a model that did not say is not
/// confident, and defaulting high would auto-write past the 0.80 gate.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ExtractedFact {
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub tags: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// Long-form or structured: this candidate becomes a note, not a memory.
    #[serde(default)]
    pub is_note: bool,
    #[serde(default)]
    pub note_body: Option<String>,
}

fn default_confidence() -> f64 { 0.5 }

/// The six kinds, per spec §7.3. Anything else normalizes to `None` and
/// the candidate is dropped, as today.
pub const KINDS: &[&str] = &[
    "user_pref", "project_fact", "decision", "constraint", "skill", "entity",
];
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn kinds_expand_to_the_documented_six() {
    assert_eq!(KIND_COUNT, 6);
    for kind in KINDS {
        assert!(normalize_kind(kind).is_some(), "{} should normalize", kind);
    }
}

#[test]
fn an_unknown_kind_is_dropped_rather_than_stored() {
    assert!(normalize_kind("task").is_none());
    assert!(normalize_kind("").is_none());
}

#[test]
fn a_missing_confidence_defaults_to_half_not_to_one() {
    // A model that omits the field has not expressed confidence.
    // Defaulting to 1.0 would let every legacy-shaped response past the
    // 0.80 auto-write gate.
    let raw = r#"[{"kind":"user_pref","title":"T","content":"c","tags":null}]"#;
    let facts = parse_candidates(raw).unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].confidence, 0.5);
}

#[test]
fn confidence_outside_zero_to_one_is_clamped() {
    for (input, want) in [(1.7, 1.0), (-3.0, 0.0), (0.42, 0.42)] {
        let raw = format!(
            r#"[{{"kind":"user_pref","content":"c","confidence":{}}}]"#, input
        );
        let facts = parse_candidates(&raw).unwrap();
        assert_eq!(facts[0].confidence, want, "input {}", input);
    }
}

#[test]
fn a_note_candidate_is_recognised() {
    let raw = r#"[{"kind":"project_fact","title":"Runbook","content":"summary",
                    "confidence":0.9,"is_note":true,"note_body":"the long form"}]"#;
    let facts = parse_candidates(raw).unwrap();
    assert!(facts[0].is_note);
    assert_eq!(facts[0].note_body.as_deref(), Some("the long form"));
}

#[test]
fn the_legacy_parser_shapes_still_parse() {
    // Every shape the existing parser was built to survive, because those
    // are real observations about what local models emit.
    for raw in [
        r#"[{"type":"user_pref","fact":"The user's birthday is February 18th"}]"#,
        r#"[{"fact_type":"personal_information","detail":"Born 1990"}]"#,
        r#"{"extracted_facts":[{"kind":"project_fact","content":"c"}]}"#,
        r#"[{"category":"skill","value":"Always run the tests","labels":["ci"]}]"#,
    ] {
        let facts = parse_candidates(raw).expect(raw);
        assert!(!facts.is_empty(), "legacy shape stopped parsing: {}", raw);
    }
}

#[test]
fn a_think_wrapped_response_still_parses() {
    let raw = "<think>reasoning about the answer</think>\n[{\"kind\":\"user_pref\",\"content\":\"c\"}]";
    let facts = parse_candidates(raw).unwrap();
    assert_eq!(facts.len(), 1);
}
```

Plus the watermark tests:

```rust
#[test]
fn no_extraction_runs_before_the_second_exchange() {
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[("user", "hello")]);
    assert!(extract::should_extract(&conn, "s1", 2).unwrap().is_none());
}

#[test]
fn no_extraction_runs_twice_for_the_same_messages() {
    // Review Focus 4. Without a watermark the second pass re-proposes
    // every fact and REINFORCE fires on all of them, so the user's
    // memory fills with near-duplicates.
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[
        ("user", "a"), ("assistant", "b"), ("user", "c"), ("assistant", "d"),
    ]);
    let first = extract::should_extract(&conn, "s1", 2).unwrap().expect("should extract");
    extract::set_watermark(&conn, "s1", &first.watermark_message_id).unwrap();
    assert!(extract::should_extract(&conn, "s1", 2).unwrap().is_none(),
            "the same messages must not extract twice");
}

#[test]
fn extraction_resumes_after_the_watermark() {
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[
        ("user", "a"), ("assistant", "b"), ("user", "c"), ("assistant", "d"),
    ]);
    let first = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    extract::set_watermark(&conn, "s1", &first.watermark_message_id).unwrap();
    seed_session(&conn, "s1", &[("user", "e"), ("assistant", "f")]);
    let second = extract::should_extract(&conn, "s1", 2).unwrap().expect("new messages should extract");
    assert_ne!(second.watermark_message_id, first.watermark_message_id);
    assert!(second.messages.len() >= 2);
}

#[test]
fn the_window_is_bounded_by_messages_and_by_tokens() {
    let conn = migrated_conn();
    let long = "word ".repeat(4000);
    let mut pairs = vec![];
    for i in 0..30 {
        pairs.push(("user", format!("{} message {}", long, i)));
    }
    seed_session(&conn, "s1", &pairs);
    let window = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    assert!(window.messages.len() <= extract::MAX_WINDOW_MESSAGES, "message bound not applied");
    let tokens: usize = window.messages.iter().map(|(_, c)| c.len() / 4).sum();
    assert!(tokens <= extract::MAX_WINDOW_TOKENS, "token bound not applied: {}", tokens);
}

#[test]
fn the_window_stops_at_the_watermark_and_does_not_re_read_old_messages() {
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[
        ("user", "old one"), ("assistant", "old two"), ("user", "old three"), ("assistant", "old four"),
    ]);
    let first = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    extract::set_watermark(&conn, "s1", &first.watermark_message_id).unwrap();
    seed_session(&conn, "s1", &[("user", "new one"), ("assistant", "new two")]);
    let second = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    assert!(!second.messages.iter().any(|(_, c)| c.contains("old one")),
            "the window must start after the watermark");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract::`
Expected: FAIL to compile — `extract` does not exist.

- [ ] **Step 3: Implement the watermark and window**

`should_extract` counts messages with `created_at` (or `rowid`) after the stored watermark, and returns a window only when the count is at least `every_n * 2` — one user and one assistant message per round — and at least `MIN_EXTRACT_MESSAGES` in total. The watermark gets its own table, not a column on `pending_memory_reviews`: a
session with no pending review still needs a watermark, and the review row is
transient while the watermark is not.

```sql
-- V007__extraction_watermark.sql
CREATE TABLE IF NOT EXISTS memory_watermark (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

**A new migration, not an amendment to V006.** V006 shipped in Plan 2 and a
developer's local database may already have it applied; an amended V006 would
silently not re-run there, and the watermark table would simply be missing. A
migrations table that has already recorded a version is not re-executed, which
is the whole point of having one.

The window query takes the newest `MAX_WINDOW_MESSAGES` and then trims from the front until the token estimate fits, so the tail — the newest exchange — always survives.

- [ ] **Step 4: Re-target the parser**

`parse_candidates` wraps the existing `parse_json_value` and `ExtractedFactCandidate` from `commands/memory.rs`, adding `confidence`, `is_note`, and `note_body` to the candidate struct, clamping confidence, and mapping through the six kinds. **Do not rewrite the 14 alias fields or the `<think>` recovery** — they are load-bearing.

`normalize_kind` extends `normalize_fact_kind` with the three new kinds, keeping every existing mapping.

- [ ] **Step 5: Update `ExtractedFact` and the TS type**

Add the three fields to the Rust struct with `#[serde(default)]`, so existing `facts_json` rows still deserialize. In `src/lib/api.ts`, add the same three as optional to the `ExtractedFact` interface. Nothing else in TypeScript changes.

- [ ] **Step 6: Point `extract_facts_from_session` at the new module**

Keep the command name and signature so the frontend is unaffected. Its body becomes: build the window, resolve the extraction route, build the `ChatRequest` with the existing system prompt extended for the new kinds and the `confidence` / `is_note` fields, drain the stream, and call `parse_candidates`. The 771-line file shrinks; the parser helpers move into `extract.rs` and are re-exported for the tests that already exercise them.

- [ ] **Step 7: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract:: && cargo test --manifest-path src-tauri/Cargo.toml commands::memory::`
Expected: PASS, including the eight pre-existing parser tests unchanged.

- [ ] **Step 8: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript — the `ExtractedFact` additions are optional, so no test needs changing.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src src/lib/api.ts
git commit -m "feat(memory): watermark-driven extraction with a bounded window

Replaces the hardcoded gen>=2 gate and the blind LIMIT 60 with a
watermark per session and a window bounded by both message count and
token estimate, always trimming from the front so the newest exchange
survives.

A missing confidence defaults to 0.5, not 1.0. A model that omitted the
field has not expressed confidence, and defaulting high would let every
legacy-shaped response past the 0.80 auto-write gate.

The existing defensive parser is retained and re-targeted, not
rewritten: its 14 alias fields and its think-block recovery encode
real observations about what local models emit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The revision decision table

**Files:**
- Create: `src-tauri/src/memory/revise.rs`
- Modify: `src-tauri/src/memory/mod.rs`
- Test: `#[cfg(test)] mod tests` inside `revise.rs`

**Interfaces:**
- Consumes: Task 5's `ExtractedFact`, Plan 2's `cosine`, `config::REINFORCE_FLOOR` / `DUP_FLOOR`, `Provider::embed`.
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionAction {
    /// New enough to add.
    Add,
    /// Same fact seen again. Bump the counters, union the tags.
    Reinforce,
    /// A newer statement replaces an older one. Old row is excluded from
    /// recall and retained for history.
    Supersede,
    /// Two near-duplicates that are not identical. Write the merged text.
    Merge,
    /// Anything ambiguous. Goes to the review inbox, never auto-written.
    Review,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevisionDecision {
    pub action: RevisionAction,
    /// The existing memory this acts on, where one applies.
    pub target_id: Option<String>,
    /// For `Merge`, the text to store. `None` otherwise.
    pub merged_content: Option<String>,
    pub reason: String,
}

pub const AUTO_ADD_CONFIDENCE: f64 = 0.80;
pub const AUTO_REWRITE_CONFIDENCE: f64 = 0.85;

/// The nearest existing memory to a candidate, and how near.
pub struct Nearest {
    pub row: KnowledgeRow,
    pub score: f64,
}

pub fn find_nearest(
    conn: &Connection,
    candidate_vector: &[f32],
) -> rusqlite::Result<Option<Nearest>>;

/// The judge, consulted only at or above `DUP_FLOOR`. One LLM call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Identical,
    Contradicts,
    Complements,
    /// The judge could not be read. Treated as `Review`, never as a write.
    Unreadable,
}

pub fn parse_verdict(raw: &str) -> Verdict;

/// Apply the table. `verdict` is `None` below `DUP_FLOOR`, where no call
/// is made.
pub fn decide(
    candidate: &ExtractedFact,
    cosine: Option<f64>,
    verdict: Option<Verdict>,
) -> RevisionDecision;
```

- [ ] **Step 1: Write the failing tests**

Every row of the spec §7.4 table, one test each. These are the tests the plan exists to produce.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::config::{DUP_FLOOR, REINFORCE_FLOOR};

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
        let d = decide(&candidate(0.95), Some(0.1), None);
        assert_eq!(d.action, RevisionAction::Add);
    }

    #[test]
    fn no_match_at_all_is_an_add() {
        let d = decide(&candidate(0.95), None, None);
        assert_eq!(d.action, RevisionAction::Add);
    }

    #[test]
    fn between_the_floors_is_a_reinforce() {
        let mid = (REINFORCE_FLOOR + DUP_FLOOR) / 2.0;
        let d = decide(&candidate(0.95), Some(mid), None);
        assert_eq!(d.action, RevisionAction::Reinforce);
    }

    #[test]
    fn at_the_reinforce_floor_is_a_reinforce_not_an_add() {
        let d = decide(&candidate(0.95), Some(REINFORCE_FLOOR), None);
        assert_eq!(d.action, RevisionAction::Reinforce, "the floor is inclusive");
    }

    #[test]
    fn above_the_duplicate_floor_with_an_identical_verdict_is_a_reinforce() {
        let d = decide(&candidate(0.95), Some(0.98), Some(Verdict::Identical));
        assert_eq!(d.action, RevisionAction::Reinforce);
    }

    #[test]
    fn above_the_duplicate_floor_with_a_contradiction_supersedes() {
        let d = decide(&candidate(0.95), Some(0.98), Some(Verdict::Contradicts));
        assert_eq!(d.action, RevisionAction::Supersede);
    }

    #[test]
    fn above_the_duplicate_floor_with_a_complement_merges() {
        let d = decide(&candidate(0.95), Some(0.98), Some(Verdict::Complements));
        assert_eq!(d.action, RevisionAction::Merge);
    }

    #[test]
    fn an_unreadable_verdict_goes_to_review_never_to_a_write() {
        // Review Focus 5. A judge that returned prose, an empty string, or
        // the wrong JSON shape must not be able to auto-write.
        for raw in ["", "   ", "they are the same", "[]", "{}", r#"{"v":"maybe"}"#, "null"] {
            assert_eq!(parse_verdict(raw), Verdict::Unreadable, "input {:?}", raw);
            let d = decide(&candidate(0.99), Some(0.99), Some(Verdict::Unreadable));
            assert_eq!(d.action, RevisionAction::Review, "input {:?} wrote something", raw);
        }
    }

    #[test]
    fn a_readable_verdict_parses() {
        assert_eq!(parse_verdict("IDENTICAL"), Verdict::Identical);
        assert_eq!(parse_verdict("contradicts"), Verdict::Contradicts);
        assert_eq!(parse_verdict(r#"{"verdict":"COMPLEMENTS"}"#), Verdict::Complements);
        assert_eq!(parse_verdict("  Complements  \n"), Verdict::Complements);
    }

    #[test]
    fn a_low_confidence_add_goes_to_review() {
        let d = decide(&candidate(0.5), Some(0.1), None);
        assert_eq!(d.action, RevisionAction::Review, "below the 0.80 auto-add gate");
    }

    #[test]
    fn a_low_confidence_supersede_goes_to_review() {
        // Rewriting an existing memory is more destructive than adding
        // one, so it gets a higher bar.
        let d = decide(&candidate(0.82), Some(0.98), Some(Verdict::Contradicts));
        assert_eq!(d.action, RevisionAction::Review, "below the 0.85 auto-rewrite gate");
    }

    #[test]
    fn a_high_confidence_supersede_is_applied() {
        let d = decide(&candidate(0.90), Some(0.98), Some(Verdict::Contradicts));
        assert_eq!(d.action, RevisionAction::Supersede);
    }

    #[test]
    fn every_decision_carries_a_reason() {
        for c in [0.1, 0.8, 0.99] {
            for v in [None, Some(Verdict::Identical), Some(Verdict::Contradicts), Some(Verdict::Complements), Some(Verdict::Unreadable)] {
                let d = decide(&candidate(c), Some(0.5), v);
                assert!(!d.reason.trim().is_empty(), "no reason for {:?} {:?}", c, v);
            }
        }
    }

    #[test]
    fn only_merge_carries_merged_content() {
        let merged = decide(&candidate(0.95), Some(0.98), Some(Verdict::Complements));
        // merged_content is None until the judge supplies the text; the
        // decision itself must not invent one.
        assert!(merged.merged_content.is_none());
        for action in [RevisionAction::Add, RevisionAction::Reinforce, RevisionAction::Supersede, RevisionAction::Review] {
            let d = decide(&candidate(0.95), Some(0.5), if action == RevisionAction::Supersede { Some(Verdict::Contradicts) } else { None });
            assert!(d.merged_content.is_none(), "{:?} invented merged text", action);
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::revise`
Expected: FAIL to compile — the module does not exist.

- [ ] **Step 3: Implement `decide`**

```rust
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
        // At or above the duplicate floor, only a readable verdict can
        // change the index. Anything else is a review.
        Some(_) => match verdict {
            Some(Verdict::Identical) => RevisionAction::Reinforce,
            Some(Verdict::Contradicts) => RevisionAction::Supersede,
            Some(Verdict::Complements) => RevisionAction::Merge,
            _ => RevisionAction::Review,
        },
    };
    // The gate is applied after the table, so an auto-write is never
    // something the table decided on its own.
    let action = match action {
        RevisionAction::Add if confidence < AUTO_ADD_CONFIDENCE => RevisionAction::Review,
        RevisionAction::Supersede | RevisionAction::Merge
            if confidence < AUTO_REWRITE_CONFIDENCE => RevisionAction::Review,
        other => other,
    };
    RevisionDecision {
        action,
        target_id: None,
        merged_content: None,
        reason: describe(candidate, cosine, verdict, action),
    }
}
```

`find_nearest` embeds the candidate, loads enabled vectors, and returns the highest `cosine` above `REINFORCE_FLOOR`. Below that the answer is "no match" and no judge call is made — the point of the floor.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::revise`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/memory
git commit -m "feat(memory): the revision decision table

ADD below the reinforce floor, REINFORCE between the floors, and
IDENTICAL / CONTRADICTS / COMPLEMENTS above the duplicate floor where a
judge call is made. Confidence gates are applied after the table, so an
auto-write is never something the table decided alone.

An unreadable judge response — prose, an empty string, the wrong JSON
shape — is a Review, never a write. Rewriting an existing memory takes a
higher confidence bar than adding a new one, because it is the more
destructive act.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Apply revisions, and close out the phase

**Files:**
- Modify: `src-tauri/src/memory/revise.rs` (`apply` functions)
- Modify: `src-tauri/src/commands/memory_reviews.rs` (watermark, multiple rounds per session)
- Modify: `src-tauri/src/commands/knowledge.rs` (`memory_extract_and_revise`)
- Modify: `src-tauri/src/lib/api.ts`, `src/stores/chatStream.ts` (deprecation marker only)
- Test: `src-tauri/src/memory/tests.rs`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:

```rust
/// The effect of applying one decision.
#[derive(Debug, Clone, PartialEq)]
pub enum Applied {
    Added { id: String },
    Reinforced { id: String },
    Superseded { new_id: String, old_id: String },
    Merged { id: String },
    SentToReview { review_id: String },
}

impl RevisionDecision {
    /// Write the decision. Never partially applies: either the row is
    /// written and its vector refreshed, or nothing is.
    pub fn apply(
        &self,
        conn: &Connection,
        candidate: &ExtractedFact,
        nearest: Option<&Nearest>,
        merged_text: Option<&str>,
    ) -> Result<Applied, String>;
}
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn superseding_keeps_the_old_row_for_history() {
    let conn = migrated_conn();
    add_memory(&conn, "old", "project_fact", "T", "the original decision");
    let candidate = fact("the reversed decision", 0.95);
    let nearest = Nearest { row: row_for(&conn, "old"), score: 0.97 };
    let decision = decide(&candidate, Some(0.97), Some(Verdict::Contradicts));
    let applied = decision.apply(&conn, &candidate, Some(&nearest), None).unwrap();
    assert!(matches!(applied, Applied::Superseded { .. }));
    let superseded_by: Option<String> = conn.query_row("SELECT superseded_by FROM memory_items WHERE id = 'old'", [], |r| r.get(0)).unwrap();
    assert!(superseded_by.is_some(), "the old row must point at its replacement");
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items WHERE id = 'old'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "supersede retains history, it does not delete");
}

#[test]
fn reinforcing_bumps_the_counters_and_unions_tags() {
    let conn = migrated_conn();
    add_memory(&conn, "m1", "user_pref", "T", "the same fact");
    conn.execute("UPDATE memory_items SET access_count = 3, tags = 'a,b' WHERE id = 'm1'", []).unwrap();
    let candidate = fact("the same fact", 0.95);
    let nearest = Nearest { row: row_for(&conn, "m1"), score: 0.80 };
    let decision = decide(&candidate, Some(0.80), None);
    decision.apply(&conn, &candidate, Some(&nearest), None).unwrap();
    let (count, tags): (i64, Option<String>) = conn.query_row("SELECT access_count, tags FROM memory_items WHERE id = 'm1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(count, 4);
    let tags = tags.unwrap();
    assert!(tags.contains('a') && tags.contains('b'), "existing tags were lost: {}", tags);
}

#[test]
fn a_review_decision_writes_nothing_to_memory_items() {
    let conn = migrated_conn();
    add_memory(&conn, "m1", "user_pref", "T", "existing");
    let before: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
    let candidate = fact("something new", 0.2);
    let decision = decide(&candidate, Some(0.1), None);
    assert_eq!(decision.action, RevisionAction::Review);
    let applied = decision.apply(&conn, &candidate, None, None).unwrap();
    assert!(matches!(applied, Applied::SentToReview { .. }));
    let after: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
    assert_eq!(after, before, "a review decision wrote a memory anyway");
}

#[test]
fn a_note_candidate_is_written_as_a_note_not_a_memory() {
    let conn = migrated_conn();
    let mut candidate = fact("a summary", 0.95);
    candidate.is_note = true;
    candidate.note_body = Some("the long form".into());
    let decision = decide(&candidate, Some(0.1), None);
    let applied = decision.apply(&conn, &candidate, None, None).unwrap();
    assert!(matches!(applied, Applied::Added { .. }));
    let memories: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0)).unwrap();
    let notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes WHERE body = 'the long form'", [], |r| r.get(0)).unwrap();
    assert_eq!(memories, 0, "a note candidate must not land in memory_items");
    assert_eq!(notes, 1);
}

#[test]
fn an_applied_add_writes_its_confidence() {
    let conn = migrated_conn();
    let candidate = fact("brand new", 0.77);
    let decision = decide(&candidate, Some(0.1), None);
    decision.apply(&conn, &candidate, None, None).unwrap();
    let (confidence, kind): (f64, String) = conn.query_row("SELECT confidence, kind FROM memory_items", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert!((confidence - 0.77).abs() < 1e-9, "got {}", confidence);
    assert_eq!(kind, "user_pref");
}

#[test]
fn a_session_can_run_more_than_one_extraction_round() {
    // V004's UNIQUE session_id capped a session at one round for life.
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", []).unwrap();
    for id in ["r1", "r2"] {
        conn.execute("INSERT INTO pending_memory_reviews (id, session_id, status) VALUES (?1,'s1','pending')", params![id]).unwrap();
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM pending_memory_reviews WHERE session_id = 's1'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::tests`
Expected: FAIL — `apply` does not exist.

- [ ] **Step 3: Implement `apply`**

`Add` inserts into `memory_items` (or `notes` when `is_note`), then into `memory_events` as `extract`. `Reinforce` bumps `access_count`, sets `last_seen_at`, and unions tags by splitting on `,` and re-joining the deduped set. `Supersede` inserts the new row, sets `superseded_by` on the old, and logs a `supersede` event for both. `Merge` writes `merged_text` — refusing to write if it is `None`, since inventing a merge is worse than deferring. `Review` writes a `pending_memory_reviews` row and touches nothing else.

Every branch runs inside a transaction so a failure cannot leave a row without its vector or a supersede without its replacement.

A new row's embedding is not computed here. `index.rs` will pick it up on the next pass, and `rows_needing_embedding` already reports it, so the Memory tab can show "3 awaiting indexing" honestly rather than pretending the vector exists.

- [ ] **Step 4: Add `index.rs`**

Small, and the reason it is not folded into `apply`: embedding is slow and must not sit on a user's send path.

```rust
/// Embed and store every row that needs it. Safe to call repeatedly.
/// Returns how many rows were written.
pub async fn fill_index(
    conn: &Connection,
    provider: &dyn Provider,
    model: &str,
    dim: usize,
    embed_all_notes: bool,
) -> Result<usize, String>;
```

Batches of `config::EMBED_BATCH`, calls `provider.embed`, and `upsert_embedding`s each result. Dimension disagreement between the response and `dim` is an error naming both, not a silent truncation.

- [ ] **Step 5: Add `memory_extract_and_revise`**

```rust
#[tauri::command]
pub async fn memory_extract_and_revise(
    pool: State<'_, Arc<DbPool>>,
    session_id: String,
    model_id: Option<String>,
    provider_id: Option<String>,
) -> Result<Vec<Applied>, String>;
```

Loads the window, extracts, and for each candidate: embeds, `find_nearest`, calls the judge when above `DUP_FLOOR`, `decide`, `apply`. Records the watermark. Returns what happened to each candidate, so the review inbox can show the revision verdict rather than raw candidates.

- [ ] **Step 6: Mark the old TypeScript recall path deprecated**

In `src/stores/chatStream.ts`, on `recallMemories` (line 736), add a comment block: it is the pre-V006 substring scorer, superseded by the Rust `memory_recall` command, and is deleted in Plan 4. Do not delete it and do not change its behavior — the 372-test suite depends on it, and Plan 4 owns its removal.

- [ ] **Step 7: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372 TypeScript unchanged.

- [ ] **Step 8: Update the spec and commit**

Mark spec Phase 4 and Phase 5 checkboxes, with the measured precision from Task 4 and a note that `memory_recall` is not yet on the send path.

```bash
git add -A src-tauri/src src docs/
git commit -m "feat(memory): apply revisions, fill the index, and close the phase

Supersede retains the old row and points it at its replacement rather
than deleting it, so the history of a correction stays readable. Merge
refuses to write without supplied merged text. Every branch runs in a
transaction, so a failure cannot leave a row without its vector or a
supersede without its replacement.

A new row's embedding is not computed on the send path; index.rs picks
it up on the next pass and the Memory tab can honestly report what is
awaiting indexing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Out of Scope — the next plan

| Plan | Spec phase | Starts from |
|---|---|---|
| 4 | Phase 6 + 7 — notes wiring, Rust-owned context assembly, delete `chatStream.ts:736-787` and `stores/memory.ts buildContextBlock`, wire `memory_recall` into `chat_stream_v2` | This plan's `memory_recall` and `memory_extract_and_revise` |
| 5 | Phase 8 + 9 — nav reorder, Memory / Notes / review-inbox UI, release gates | Plan 4's live recall |

Plan 4 is the one that makes it real for a user: it replaces the substring
scorer on the send path with the Rust pipeline built here.

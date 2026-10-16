# Unified Index and Provider Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the schema the memory-first design needs (embeddings, access events, note indexing, revision columns) and make the provider layer able to reach Ollama cloud and produce embeddings.

**Architecture:** One additive SQL migration. A new `src-tauri/src/memory/` Rust module owning retrieval configuration and vector persistence. The `Provider` trait gains an `embed` method, implemented for both existing backends, and `OllamaProvider` learns to send an `Authorization` header so the same adapter serves local and cloud.

**Tech Stack:** Rust 2021, rusqlite 0.32 (bundled SQLite with FTS5), r2d2, reqwest 0.12 (rustls), async-trait, tokio, keyring 3, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` §5 (unified index) and §10 (provider layer). `docs/GOALS.md` is canonical for product intent.

---

## Global Constraints

- **This plan changes no frontend code.** The TypeScript API wrappers are untouched; new Rust commands are added in Plan 3 when something calls them. `src/` must show zero diff at the end of this plan.
- **`src-tauri/src/commands/memory.rs` is NOT modified in this plan.** It is 771 lines of extraction logic that Plan 3 re-targets. Touching it here would create two large diffs for one concern.
- **Test floor: 372 TypeScript tests, 0 failures**, unchanged. `npm run typecheck` and `npm run test:run` must both be clean at every task boundary.
- Rust gates: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `cargo test --manifest-path src-tauri/Cargo.toml` all clean.
- **No new crates.** Everything needed is already in `Cargo.toml`. `rusqlite`'s `bundled` feature means no system SQLite. Adding a vector-search or HTTP dependency is out of scope.
- Rust house style, from the existing code: `#[tauri::command]` sync fns take `pool: State<'_, Arc<DbPool>>`; async fns that await after touching the DB wrap DB reads in a scope block so the connection is released before the await. Errors are `String`. `ProviderError` via `thiserror` in the provider layer, `format!` in commands.
- Rust test style: `#[cfg(test)] mod tests` with `rusqlite::Connection::open_in_memory()` for DB tests, and real loopback `TcpListener` HTTP fixtures for provider tests (see `src/providers/tests.rs:69-86`, the `serve_once` helper). **No mocking crate.**
- Migrations are `M::up(include_str!(...))` appended to the `Migrations::new` vec in `src-tauri/src/db/mod.rs`. There are no `M::down` migrations in this project and none will be added.

---

## Review Focus

Input classes this plan implies. Each is pinned to a test in the task that owns the code.

1. **A populated v1–v5 database upgrading to v6.** Not an empty one. Real users have memory items, notes, sessions, and *in-flight* `pending_memory_reviews` rows. A migration that only passes on an empty DB has destroyed someone's data. → Task 1.
2. **Switching embedding models.** Vectors from `nomic-embed-text` (768-dim) and `mxbai-embed-large` (1024-dim) are not comparable. A model switch must not silently mix them in one cosine neighbourhood. → Task 5.
3. **A provider configured with a cloud base_url but no API key.** `OllamaProvider::new` currently discards its `api_key` argument entirely, so a cloud endpoint gets unauthenticated requests that fail with an opaque 401. → Task 3.
4. **An `openai_compat` provider pointed at a server with no `/v1/embeddings`.** The `embed` method must return a typed error the caller can degrade on, not panic or hang. → Task 4.
5. **A dimension mismatch inside a single stored vector set** — a row whose `dim` disagrees with its blob length. Possible if a write is interrupted. Cosine over garbage is worse than an error. → Task 5.

---

## Design decision: one FTS table per content table, not one shared table

The spec says "one index, two views". That means one *retrieval path* and one *scoring*, not one physical FTS table. SQLite FTS5 external-content tables bind to exactly one content table via `content=`, and the existing sync triggers are per-table. A single table spanning `memory_items` and `notes` would mean denormalising both into a shadow table and keeping it in sync by hand.

Instead: `memory_fts` and a new `notes_fts`, each external-content over its own table, each with the same column shape (`title`, body, `tags`) and the same tokenizer. Retrieval issues one BM25 query per table and fuses the two ranked lists with RRF, which is what RRF is for — it takes any number of ranked lists. "Unified" is enforced at the retrieval layer, where it belongs, and by the shared column shape and tokenizer that make the two comparable.

**Cost if wrong:** a third content type later (documents) adds a third FTS table and a third RRF route. That is additive, not a rework.

---

## File Structure

**Created:**
- `src-tauri/migrations/V006__unified_index.sql` — the whole schema change.
- `src-tauri/src/memory/mod.rs` — module root, re-exports.
- `src-tauri/src/memory/config.rs` — retrieval constants, settings-backed overrides, model routing.
- `src-tauri/src/memory/embed.rs` — vector codec, persistence, reindex detection, cosine.
- `src-tauri/src/memory/tests.rs` — `#[cfg(test)] mod tests;` for the module.

**Modified:**
- `src-tauri/src/db/mod.rs` — register V006; extend the migration test to cover a populated DB.
- `src-tauri/src/db/models.rs` — **not modified in this plan.** `Note` and `MemoryItem` gain columns in V006, but a SQL migration cannot add a field to a Rust struct; nothing reads the new columns until Plan 3, which is where the structs change. Touching them now would mean either dead fields or a cast that Plan 3 rewrites.
- `src-tauri/src/providers/mod.rs` — add `embed` to the trait; pass `api_key` to `OllamaProvider` in `probe`.
- `src-tauri/src/providers/ollama.rs` — auth header; `embed` via `POST /api/embed`.
- `src-tauri/src/providers/openai_compat.rs` — `embed` via `POST /v1/embeddings`.
- `src-tauri/src/providers/tests.rs` — loopback tests for both `embed` implementations and the auth header.
- `src-tauri/src/lib.rs` — `mod memory;`.
- `src-tauri/src/services.rs` — add `ensure_ollama_cloud_provider`, alongside the existing `ensure_default_ollama_provider` at `:293`.

**Not modified:** `src/**` (TypeScript), `src-tauri/src/commands/**` (including `memory.rs`), `src-tauri/migrations/V00[1-5]*`.

---

### Task 1: The V006 migration

**Files:**
- Create: `src-tauri/migrations/V006__unified_index.sql`
- Modify: `src-tauri/src/db/mod.rs:12-26` (add the const and the `M::up` entry), `src-tauri/src/db/mod.rs` test module

**Interfaces:**
- Consumes: nothing.
- Produces: the schema every later task reads. Concretely —
  - `memory_items` gains: `confidence REAL NOT NULL DEFAULT 1.0`, `access_count INTEGER NOT NULL DEFAULT 0`, `last_seen_at TEXT`, `superseded_by TEXT`, `source_note_id TEXT`, `source_session_id TEXT`, `token_count INTEGER`.
  - `notes` gains: `pinned INTEGER NOT NULL DEFAULT 0`, `token_count INTEGER`, `source_note_id TEXT`.
  - New table `memory_embeddings(id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, created_at TEXT NOT NULL)`.
  - New table `memory_events(id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL)`.
  - New FTS table `notes_fts` external-content over `notes`, columns `title, body, tags`, `tokenize='porter unicode61'`, plus `notes_ai` / `notes_ad` / `notes_au` triggers.
  - `pending_memory_reviews` rebuilt without `session_id UNIQUE`, and gains `watermark_message_id TEXT`.
  - Indexes: `idx_emb_owner`, `idx_emb_model`, `idx_events_owner`, `idx_memory_superseded`, `idx_memory_source_note`, `idx_notes_pinned`.

- [ ] **Step 1: Write the failing migration test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/db/mod.rs`. Follow the existing test at `:69-107` for style — in-memory `Connection`, partial `Migrations::new`, then `migrations().to_latest(&mut conn)`.

```rust
#[test]
fn migrates_a_populated_database_without_losing_data() {
    let mut conn = Connection::open_in_memory().unwrap();
    Migrations::new(vec![
        M::up(MIGRATION_V001),
        M::up(MIGRATION_V002),
        M::up(MIGRATION_V003),
        M::up(MIGRATION_V004),
        M::up(MIGRATION_V005),
    ])
    .to_latest(&mut conn)
    .unwrap();

    // A realistic v5 database: a session, a turn of messages, memory,
    // a note, and an in-flight review the user has not looked at yet.
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1', 'Real')", []).unwrap();
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1','s1','user','hello')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content) VALUES ('mem1','project_fact','T','durable')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Note','body text')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES ('r1','s1','pending')",
        [],
    ).unwrap();

    migrations().to_latest(&mut conn).unwrap();

    // Nothing was lost.
    for (table, id) in [("sessions", "s1"), ("messages", "m1"), ("memory_items", "mem1"), ("notes", "n1")] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {} WHERE id = ?1", table), params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "row lost from {}", table);
    }
    let review: String = conn
        .query_row("SELECT status FROM pending_memory_reviews WHERE id = 'r1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(review, "pending");
}
```

Add two more tests alongside it:

```rust
#[test]
fn a_session_can_queue_more_than_one_memory_review_after_v006() {
    // setup as above, then to_latest
    conn.execute(
        "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES ('r2','s1','pending')",
        [],
    ).unwrap();
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pending_memory_reviews WHERE session_id = 's1'", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(n, 2, "V004's UNIQUE session_id must not survive V006");
}
```

```rust
#[test]
fn v6_defaults_are_backfilled_onto_existing_rows() {
    // setup with one memory_items row and one notes row, then to_latest
    let (confidence, access_count, superseded): (f64, i64, Option<String>) = conn
        .query_row("SELECT confidence, access_count, superseded_by FROM memory_items WHERE id='mem1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(confidence, 1.0);
    assert_eq!(access_count, 0);
    assert!(superseded.is_none());
    let pinned: i64 = conn.query_row("SELECT pinned FROM notes WHERE id='n1'", [], |r| r.get(0)).unwrap();
    assert_eq!(pinned, 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migrates_a_populated`
Expected: FAIL — the v6 columns and `notes_fts` do not exist; the second test fails on the `UNIQUE` constraint, the third on "no such column: confidence".

- [ ] **Step 3: Write `V006__unified_index.sql`**

Follow the house conventions: a leading comment explaining the intent, `IF NOT EXISTS` on every index and virtual table, `strftime('%Y-%m-%dT%H:%M:%fZ','now')` for every timestamp default, and the same trigger naming (`notes_ai` / `notes_ad` / `notes_au`) and shape as the existing `memory_ai`/`ad`/`au` triggers in `V002__fts_and_skills.sql`.

The `pending_memory_reviews` rebuild must be the standard SQLite dance: create `pending_memory_reviews_new` without the `UNIQUE`, `INSERT INTO ... SELECT` the rows, `DROP TABLE` the old, `ALTER TABLE ... RENAME`. Recreate `idx_memory_reviews_status` afterwards, because dropping the table drops its index.

`memory_events.event` needs a `CHECK` constraint, matching how `V004` constrains `status`:

```sql
event TEXT NOT NULL CHECK (event IN ('recall', 'extract', 'reinforce', 'supersede'))
```

`memory_embeddings.owner_type` likewise: `CHECK (owner_type IN ('memory', 'note'))`.

- [ ] **Step 4: Register the migration in `src-tauri/src/db/mod.rs`**

Add `const MIGRATION_V006: &str = include_str!("../../migrations/V006__unified_index.sql");` after V005, and `M::up(MIGRATION_V006),` as the last entry in the `Migrations::new` vec. Do not reorder the existing entries — `rusqlite_migration` keys on the order they are declared.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::`
Expected: PASS, all four tests in `db::tests` (the pre-existing one plus the three new).

- [ ] **Step 6: Verify migration is idempotent across the whole chain**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests pass, including the pre-existing `migrates_existing_database_to_memory_reviews`.

- [ ] **Step 7: Confirm the frontend is untouched**

Run: `git status --short src/`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/migrations/V006__unified_index.sql src-tauri/src/db/mod.rs
git commit -m "feat(db): add V006 unified index schema

Embedding storage, access events, note FTS, and the revision columns
memory consolidation needs. Rebuilds pending_memory_reviews without
V004's UNIQUE session_id so a session can accumulate multiple extraction
rounds, and adds a watermark column to replace the hardcoded gen>=2 gate.

The migration is tested against a populated v5 database, not an empty
one, including an in-flight review row.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Retrieval configuration and model routing

**Files:**
- Create: `src-tauri/src/memory/mod.rs`, `src-tauri/src/memory/config.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod memory;`)
- Test: `src-tauri/src/memory/tests.rs`

**Interfaces:**
- Consumes: `settings(key, value)` read via the `settings` table, per `src/commands/settings.rs:9-32`.
- Produces:

```rust
// src-tauri/src/memory/config.rs

/// Every retrieval constant the spec §6.2 pins, in one place.
/// Overridable per install; these are the defaults.
pub const RRF_K: f64 = 60.0;
pub const BM25_LIMIT: usize = 30;
pub const COSINE_LIMIT: usize = 30;
pub const TOP_K_DEFAULT: i64 = 6;
pub const REINFORCE_FLOOR: f64 = 0.72;
pub const DUP_FLOOR: f64 = 0.92;
pub const RECENCY_HALF_LIFE_DAYS: f64 = 30.0;
pub const CONTEXT_BUDGET_FRACTION: f64 = 0.15;
pub const MIN_CONTENT_LENGTH: usize = 32;
pub const EMBED_BATCH: usize = 32;

/// A provider + model pair for one capability.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelRoute {
    pub provider_id: String,
    pub model: String,
}

/// Which model serves which job. `None` means "use the session's own
/// model", which is the correct default for chat and extraction.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelRouting {
    pub chat: Option<ModelRoute>,
    pub extraction: Option<ModelRoute>,
    pub embedding: Option<ModelRoute>,
}

/// Reads the `memory.routing` settings row. Returns all-`None` when
/// absent or malformed — routing is an optimisation, never a hard
/// dependency, so a bad value must not break recall.
pub fn load_routing(conn: &rusqlite::Connection) -> ModelRouting;

/// Effective `top_k`: the `memory.top_k` setting, or `TOP_K_DEFAULT`.
pub fn top_k(conn: &rusqlite::Connection) -> i64;

/// Effective context budget fraction, clamped to `(0.0, 1.0]`.
pub fn context_budget_fraction(conn: &rusqlite::Connection) -> f64;

/// Whether automatic extraction after a turn is enabled. Default true.
pub fn auto_extract(conn: &rusqlite::Connection) -> bool;
```

`load_routing` reads one settings row, `memory.routing`, whose value is JSON:

```json
{"chat":{"provider_id":"p1","model":"llama3"},
 "extraction":{"provider_id":"p1","model":"qwen2.5:3b"},
 "embedding":{"provider_id":"p1","model":"nomic-embed-text"}}
```

Absent keys mean "not configured". A malformed row logs and yields `ModelRouting::default()`.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/memory/tests.rs`, a shared in-memory fixture matching the `db/mod.rs` style:

```rust
fn conn_with_settings(pairs: &[(&str, &str)]) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    for (k, v) in pairs {
        conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", params![k, v]).unwrap();
    }
    conn
}
```

Tests:

```rust
#[test]
fn routing_defaults_to_unset_when_no_row_exists() {
    let conn = conn_with_settings(&[]);
    assert_eq!(config::load_routing(&conn), ModelRouting::default());
}

#[test]
fn routing_reads_each_capability_independently() {
    let conn = conn_with_settings(&[(
        "memory.routing",
        r#"{"extraction":{"provider_id":"p1","model":"qwen2.5:3b"}}"#,
    )]);
    let r = config::load_routing(&conn);
    assert_eq!(r.extraction, Some(ModelRoute { provider_id: "p1".into(), model: "qwen2.5:3b".into() }));
    assert_eq!(r.chat, None);
    assert_eq!(r.embedding, None);
}

#[test]
fn malformed_routing_json_degrades_to_defaults_instead_of_erroring() {
    // A bad settings row must never break recall.
    for bad in ["not json", "[]", r#"{"chat":"p1"}"#, r#"{"chat":{"provider_id":1}}"#] {
        let conn = conn_with_settings(&[("memory.routing", bad)]);
        assert_eq!(config::load_routing(&conn), ModelRouting::default(), "input: {}", bad);
    }
}

#[test]
fn top_k_defaults_and_overrides() {
    assert_eq!(config::top_k(&conn_with_settings(&[])), config::TOP_K_DEFAULT);
    let conn = conn_with_settings(&[("memory.top_k", "12")]);
    assert_eq!(config::top_k(&conn), 12);
}

#[test]
fn top_k_ignores_a_nonsense_value() {
    for bad in ["abc", "-1", "0", ""] {
        let conn = conn_with_settings(&[("memory.top_k", bad)]);
        assert_eq!(config::top_k(&conn), config::TOP_K_DEFAULT, "input: {}", bad);
    }
}

#[test]
fn context_budget_fraction_is_clamped_to_a_sane_range() {
    assert_eq!(config::context_budget_fraction(&conn_with_settings(&[])), 0.15);
    for (input, want) in [("0.5", 0.5), ("0", 0.15), ("1", 1.0), ("2.0", 1.0), ("-1", 0.15), ("nan", 0.15)] {
        let conn = conn_with_settings(&[("memory.context_budget_fraction", input)]);
        assert_eq!(config::context_budget_fraction(&conn), want, "input: {}", input);
    }
}

#[test]
fn auto_extract_defaults_on_and_can_be_turned_off() {
    assert!(config::auto_extract(&conn_with_settings(&[])));
    assert!(!config::auto_extract(&conn_with_settings(&[("memory.auto_extract", "false")])));
    assert!(config::auto_extract(&conn_with_settings(&[("memory.auto_extract", "true")])));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::`
Expected: FAIL — `crate::memory` does not exist.

- [ ] **Step 3: Write `src-tauri/src/memory/config.rs`**

`src-tauri/src/memory/mod.rs`:

```rust
pub mod config;
pub mod embed;            // added in Task 5
#[cfg(test)] mod tests;
```

Declare only `config` in this task; add `embed` in Task 5 to keep the module compiling between tasks. Add `mod memory;` to `src-tauri/src/lib.rs` next to the other `mod` declarations.

In `config.rs`, implement the four readers against the `settings` table using the same `query_row(..., |r| r.get(0)).optional()` shape as `src/commands/settings.rs:9-20`. Every parse failure returns the default — routing and tuning are never a reason to fail a send.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: clean, and `npm run typecheck && npm run test:run` still 372/372.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/memory src-tauri/src/lib.rs
git commit -m "feat(memory): retrieval config and per-capability model routing

Every constant the spec pins in one place, each overridable from the
settings table, plus chat/extraction/embedding model routing read from
a single memory.routing JSON row.

Every reader degrades to its default on a malformed value. Routing is an
optimisation; a bad settings row must never be the reason recall fails.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Ollama cloud authentication

**Files:**
- Modify: `src-tauri/src/providers/ollama.rs:13-28` (struct, `new`, `url`, add `auth`), `src-tauri/src/providers/mod.rs:64-89` (`probe` passes the key)
- Test: `src-tauri/src/providers/tests.rs`

**Interfaces:**
- Consumes: `services::store_api_key` / `get_api_key`, which already handle the keyring. **No new keyring code** — `add_provider` (`services.rs:113`) already stores the key against the provider id.
- Produces:

```rust
impl OllamaProvider {
    /// `api_key` is now honoured. It was previously discarded, which
    /// made every cloud endpoint fail with an opaque 401.
    pub fn new(base_url: String, api_key: Option<String>) -> Self;

    /// Adds `Authorization: Bearer <key>` when a key is configured.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/providers/tests.rs`, reusing the existing `serve_once(status, body, content_type) -> String` helper at `:69-86`. That helper is fire-and-forget on one request, which is all a header assertion needs.

```rust
#[tokio::test]
async fn ollama_sends_an_authorization_header_when_a_key_is_configured() {
    // Needs a server that reports the request headers back, so use the
    // raw TcpListener pattern from `openai_adapter_handles_sse...` at :112
    // rather than serve_once: assert on the echoed Authorization value.
}

#[tokio::test]
async fn ollama_sends_no_authorization_header_without_a_key() {
    // Same shape; assert the echoed headers contain no "authorization".
}
```

For each, bind `127.0.0.1:0`, read the request head, echo it back as the body, and assert on the echo. Add a small `serve_echoing_headers() -> String` helper next to `serve_once` returning `http://{addr}` and the received head via a `Arc<Mutex<Option<String>>>`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ollama_sends`
Expected: FAIL — no `Authorization` header is sent, because `new` discards the key.

- [ ] **Step 3: Implement `auth` and use it on every request in `ollama.rs`**

```rust
pub struct OllamaProvider {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder().build().expect("reqwest client");
        Self { base_url, api_key, http }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), path)
    }

    /// Local Ollama ignores this; ollama.com requires it. Applying it
    /// unconditionally is simpler than branching on host, and a local
    /// server ignores an unexpected Authorization header.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}
```

Wrap the existing `.get(self.url("api/tags"))`, `.get(self.url("api/ps"))`, `.post(self.url("api/chat"))`, and `.post(self.url("api/show"))` builders in `self.auth(...)`.

- [ ] **Step 4: Seed the Ollama cloud provider**

The spec §10 names an `ollama-cloud` preset so the user never types a URL. Add to `src-tauri/src/services.rs`, modelled on `ensure_default_ollama_provider` at `:293`:

```rust
/// One-time seed of the Ollama cloud endpoint, so a user with a key but
/// no local server is not asked to type a base URL. Idempotent: the
/// `provider_url_exists` check is what makes re-running it a no-op.
pub fn ensure_ollama_cloud_provider(pool: &DbPool) -> Result<(), String>
```

It inserts `kind = 'ollama'`, `name = 'Ollama Cloud'`, `base_url = 'https://ollama.com/api'`, `is_default = 0`, and returns early if `provider_url_exists(&conn, "ollama", Some("https://ollama.com/api"), None)` is true. It must NOT be marked default — the local provider stays the default so an existing install changes no behaviour.

Call it once from `setup` in `src/lib.rs`, next to wherever `ensure_default_ollama_provider` is already called. Do not add a Tauri command; nothing in the UI needs to invoke it.

Cover with a test in `services.rs`'s test module if one exists, otherwise assert via the `db::` migration fixture. The assertion that matters: calling `ensure_ollama_cloud_provider` twice leaves exactly one row.

- [ ] **Step 5: Pass the key through in `providers/mod.rs::probe`**

`probe` at `mod.rs:64-89` currently calls `OllamaProvider::new(base_url.to_string(), None)`. Change `None` to `api_key.map(|s| s.to_string())`.

- [ ] **Step 6: Verify a missing cloud key produces a legible failure**

Review Focus 3. With no key configured, `auth` adds no header and the cloud endpoint answers 401. That must surface as a typed error the UI can explain, not a generic transport failure:

```rust
#[tokio::test]
async fn ollama_cloud_without_a_key_reports_401_as_a_typed_api_error() {
    let url = serve_once(401, r#"{"error":"unauthorized"}"#, "application/json");
    let p = OllamaProvider::new(url, None);
    match p.embed("gpt-oss:120b", &["hi".to_string()]).await {
        Err(ProviderError::Api { status: 401, .. }) => {}
        other => panic!("expected a typed 401 so the UI can say 'check your Ollama cloud key', got {:?}", other),
    }
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ollama_ && cargo test --manifest-path src-tauri/Cargo.toml providers::`
Expected: PASS, including the pre-existing `adapters_preserve_http_status_errors` and both adapter stream tests, which must be unaffected.

- [ ] **Step 8: Run the full gates**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372/372 TypeScript.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/providers src-tauri/src/services.rs src-tauri/src/lib.rs
git commit -m "feat(providers): authenticate Ollama requests so cloud works

OllamaProvider::new took an api_key argument and discarded it, so every
ollama.com endpoint failed with an opaque 401. Stores the key, sends
Authorization: Bearer when present, and applies it to all four request
sites. probe() now forwards the key it already had.

Local Ollama ignores the header, so no branching on host is needed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Embeddings on the Provider trait

**Files:**
- Modify: `src-tauri/src/providers/mod.rs:45-50` (trait), `src-tauri/src/providers/ollama.rs`, `src-tauri/src/providers/openai_compat.rs`
- Test: `src-tauri/src/providers/tests.rs`

**Interfaces:**
- Consumes: the `Provider` trait, `ProviderFuture`, `ProviderError`.
- Produces:

```rust
// src-tauri/src/providers/mod.rs
#[async_trait]
pub trait Provider: Send + Sync {
    // ... existing list_models / probe / chat_stream ...

    /// Embed one or more inputs. Returns one vector per input, in order.
    ///
    /// A provider with no embedding endpoint returns
    /// `ProviderError::NotConfigured`, which callers degrade on by
    /// falling back to keyword-only retrieval. It must never panic.
    fn embed<'a>(&'a self, model: &'a str, inputs: &'a [String])
        -> ProviderFuture<'a, Vec<Vec<f32>>>;
}
```

- [ ] **Step 1: Write the failing tests**

In `providers/tests.rs`, using the existing `serve_once` helper with fixed JSON bodies:

```rust
#[tokio::test]
async fn ollama_embed_parses_the_embeddings_array() {
    // POST /api/embed returns {"embeddings": [[1.0, 2.0], [3.0, 4.0]]}
    let url = serve_once(200, r#"{"embeddings":[[1.0,2.0],[3.0,4.0]]}"#, "application/json");
    let p = OllamaProvider::new(url, None);
    let out = p.embed("nomic-embed-text", &["a".to_string(), "b".to_string()]).await.unwrap();
    assert_eq!(out, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
}

#[tokio::test]
async fn openai_compat_embed_parses_the_data_array() {
    // POST /v1/embeddings returns {"data":[{"embedding":[1.0,2.0]}]}
    let url = serve_once(200, r#"{"data":[{"embedding":[1.0,2.0]}]}"#, "application/json");
    let p = OpenAiCompatProvider::new(url, None);
    let out = p.embed("m", &["a".to_string()]).await.unwrap();
    assert_eq!(out, vec![vec![1.0, 2.0]]);
}

#[tokio::test]
async fn embed_reports_a_missing_endpoint_rather_than_failing_opaquely() {
    let url = serve_once(404, r#"{"error":"not found"}"#, "application/json");
    let p = OllamaProvider::new(url, None);
    match p.embed("m", &["a".to_string()]).await {
        Err(ProviderError::Api { status: 404, .. }) => {}
        other => panic!("expected a typed Api error, got {:?}", other),
    }
}

#[tokio::test]
async fn embed_rejects_a_response_whose_vector_count_does_not_match_its_inputs() {
    // One vector for two inputs is worse than an error: RRF would fuse
    // the wrong pairings.
    let url = serve_once(200, r#"{"embeddings":[[1.0,2.0]]}"#, "application/json");
    let p = OllamaProvider::new(url, None);
    assert!(matches!(
        p.embed("m", &["a".to_string(), "b".to_string()]).await,
        Err(ProviderError::Parse(_))
    ));
}
```

Add a matching `openai_compat` count-mismatch test. `ProviderError` needs `Debug` for the `panic!` — it already derives it.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml embed_`
Expected: FAIL to compile — `embed` is not a member of `Provider`.

- [ ] **Step 3: Add `embed` to the trait and implement it in `ollama.rs`**

Trait method, matching the existing `async_trait` + `ProviderFuture` style used by `list_models`:

```rust
fn embed<'a>(&'a self, model: &'a str, inputs: &'a [String]) -> ProviderFuture<'a, Vec<Vec<f32>>>;
```

`ollama.rs` — `POST {base}/api/embed` with `{"model": model, "input": inputs}`, wrapped in `self.auth(...)`, following the `fetch_context_length` non-streaming shape at `ollama.rs:189-203` for error mapping. Response type:

```rust
#[derive(serde::Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}
```

Map a non-success status to `ProviderError::Api { status, body }`, a transport failure to `ProviderError::Http`, a deserialisation failure to `ProviderError::Parse`, and a length mismatch to `ProviderError::Parse`.

- [ ] **Step 4: Implement `embed` in `openai_compat.rs`**

`POST {base}/v1/embeddings` with `{"model": model, "input": inputs}`, through the existing `auth` helper at `openai_compat.rs:34-40`. Response type:

```rust
#[derive(serde::Deserialize)]
struct OpenAiEmbedResponse {
    data: Vec<OpenAiEmbedDatum>,
}
#[derive(serde::Deserialize)]
struct OpenAiEmbedDatum {
    embedding: Vec<f32>,
    index: usize,
}
```

Sort `data` by `index` before returning. Ollama's OpenAI-compatible endpoint does not guarantee response order, and RRF fuses by rank, so an out-of-order response would silently mis-pair a query with a document.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml embed_ && cargo test --manifest-path src-tauri/Cargo.toml providers::`
Expected: PASS, 5 new plus the 7 pre-existing provider tests.

- [ ] **Step 6: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372/372 TypeScript.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/providers
git commit -m "feat(providers): add embed to the Provider trait

POST /api/embed for Ollama, POST /v1/embeddings for OpenAI-compatible.
A length mismatch between requested inputs and returned vectors is a
parse error, not a short result: RRF fuses by rank, so a mis-paired
vector silently corrupts retrieval.

The OpenAI-compatible path sorts by the response index field, which
Ollama's cloud endpoint does not guarantee to be in request order.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Vector persistence

**Files:**
- Create: `src-tauri/src/memory/embed.rs`
- Modify: `src-tauri/src/memory/mod.rs` (declare `pub mod embed;`)
- Modify: `src-tauri/src/db/models.rs` (add `EmbeddingRow`, `KnowledgeRow`, `ModelRoute` consumers)
- Test: `src-tauri/src/memory/tests.rs`

**Interfaces:**
- Consumes: `Provider::embed` (Task 4), the `memory_embeddings` / `memory_events` tables (Task 1).
- Produces:

```rust
// src-tauri/src/memory/embed.rs

/// One row of the unified index, before scoring. `owner_type` is
/// `"memory"` or `"note"`; retrieval must not be able to tell them apart.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeRow {
    pub owner_type: String,
    pub owner_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub is_enabled: bool,
    pub superseded_by: Option<String>,
    pub access_count: i64,
    pub updated_at: String,
}

pub struct EmbeddingRow {
    pub owner_type: String,
    pub owner_id: String,
    pub model: String,
    pub dim: usize,
    pub vec: Vec<f32>,
}

/// Pack a vector as little-endian f32 bytes for the BLOB column.
pub fn encode(vec: &[f32]) -> Vec<u8>;

/// Unpack a BLOB. Returns `None` when `bytes.len() != dim * 4`, which
/// is a torn or truncated write — treating it as zeros would produce
/// confident nonsense from a cosine score.
pub fn decode(bytes: &[u8], dim: usize) -> Option<Vec<f32>>;

/// Cosine similarity. Returns `None` for a zero-magnitude vector rather
/// than dividing by zero.
pub fn cosine(a: &[f32], b: &[f32]) -> Option<f64>;

/// Rows eligible for embedding: enabled, not superseded, long enough,
/// and either unembedded or embedded under a different model/dim.
pub fn rows_needing_embedding(
    conn: &rusqlite::Connection,
    model: &str,
    dim: usize,
) -> rusqlite::Result<Vec<KnowledgeRow>>;

/// Replace the stored vector for one row.
pub fn upsert_embedding(
    conn: &rusqlite::Connection,
    owner_type: &str,
    owner_id: &str,
    model: &str,
    vec: &[f32],
) -> Result<(), String>;

/// Stored vectors for `ids`, with their `KnowledgeRow`s. Used by
/// retrieval: filter in SQL first, then load only surviving vectors.
pub fn load_vectors(
    conn: &rusqlite::Connection,
    model: &str,
    rows: &[KnowledgeRow],
) -> rusqlite::Result<Vec<(KnowledgeRow, Vec<f32>)>>;

/// True when any stored embedding was written by a different model or
/// dimension than the one now configured, so the index needs a rebuild.
pub fn needs_reindex(
    conn: &rusqlite::Connection,
    model: &str,
    dim: usize,
) -> rusqlite::Result<bool>;

/// Append to the access log. `event` is one of recall | extract |
/// reinforce | supersede; the CHECK constraint enforces it.
pub fn log_event(
    conn: &rusqlite::Connection,
    owner_type: &str,
    owner_id: &str,
    event: &str,
    session_id: Option<&str>,
) -> Result<(), String>;
```

- [ ] **Step 1: Write the failing tests**

In `memory/tests.rs`. A shared fixture that runs the real migration chain, so the tests exercise the real schema rather than a hand-rolled approximation:

```rust
fn migrated_conn() -> rusqlite::Connection {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrations_for_tests().to_latest(&mut conn).unwrap();
    conn
}
```

Add `pub(crate) fn migrations_for_tests() -> Migrations<'static>` to `src-tauri/src/db/mod.rs`, returning the same `migrations()` value. It is `pub(crate)` and `#[cfg(test)]`-gated so it cannot be reached from a command.

Tests:

The trivial codec and arithmetic cases need only their names. The five with a
reason to be written down:

```rust
// Review Focus 5: a torn write must not become a confident wrong score.
#[test]
fn decode_rejects_a_blob_whose_length_disagrees_with_its_dimension() {
    // 3 floats written, dim recorded as 2.
    let bytes = encode(&[1.0, 2.0, 3.0]);
    assert!(decode(&bytes, 2).is_none());
    assert_eq!(decode(&bytes, 3).unwrap(), vec![1.0, 2.0, 3.0]);
}

// Cosine is only defined for non-degenerate inputs. Each of these would
// otherwise be a NaN that poisons every downstream comparison.
#[test]
fn cosine_returns_none_for_degenerate_inputs() {
    assert!(cosine(&[0.0, 0.0], &[1.0, 1.0]).is_none(), "zero magnitude");
    assert!(cosine(&[1.0, 2.0], &[1.0]).is_none(), "length mismatch");
    assert!(cosine(&[], &[]).is_none(), "empty");
    assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]).unwrap() - 1.0).abs() < 1e-6);
    assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).unwrap().abs() < 1e-6);
}

// A disabled or superseded row must never come back as work to do.
#[test]
fn rows_needing_embedding_skips_disabled_and_superseded_rows() {
    let conn = seeded();   // fixture: one enabled, one is_enabled=0, one superseded_by set
    let rows = rows_needing_embedding(&conn, "nomic-embed-text", 768, false).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].owner_id, "enabled-one");
}

// Junk and pinned-notes-only, per the note-arm predicate in Step 3.
#[test]
fn rows_needing_embedding_honours_the_minimum_length_and_the_pinned_flag() {
    let conn = seeded();   // adds a 1-char memory, an unpinned note, a pinned note
    assert!(!rows_needing_embedding(&conn, "m", 768, false).unwrap()
        .iter().any(|r| r.content == "x"));
    let notes: Vec<_> = rows_needing_embedding(&conn, "m", 768, false).unwrap()
        .into_iter().filter(|r| r.owner_type == "note").collect();
    assert!(notes.iter().all(|r| r.owner_id == "pinned-note"));
    // Flipping the setting admits every note.
    assert!(rows_needing_embedding(&conn, "m", 768, true).unwrap()
        .iter().any(|r| r.owner_id == "unpinned-note"));
}

// Review Focus 2: vectors from two models are not comparable.
#[test]
fn needs_reindex_is_true_after_switching_the_embedding_model() {
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "nomic-embed-text", &[0.1, 0.2]).unwrap();
    assert!(!needs_reindex(&conn, "nomic-embed-text", 2).unwrap(), "same model and dim");
    assert!(needs_reindex(&conn, "mxbai-embed-large", 2).unwrap(), "model switched");
    assert!(needs_reindex(&conn, "nomic-embed-text", 1024).unwrap(), "dim switched");
    // And the same switch must make the row eligible for re-embedding.
    assert!(rows_needing_embedding(&conn, "mxbai-embed-large", 1024, false).unwrap()
        .iter().any(|r| r.owner_id == "enabled-one"));
}

// The CHECK constraint is the only enforcement point; a bad event must
// be refused by the database, not by Rust.
#[test]
fn log_event_rejects_an_event_outside_the_check_constraint() {
    let conn = migrated_conn();
    assert!(log_event(&conn, "memory", "m1", "recall", None).is_ok());
    assert!(log_event(&conn, "memory", "m1", "nonsense", None).is_err());
    assert!(log_event(&conn, "nonsense", "m1", "recall", None).is_err());
}
```

Named-only, with the assertion each must make:

| Test | Assertion |
|---|---|
| `encode_decode_round_trips_a_vector` | `decode(&encode(v), v.len()) == v` for a non-empty `v` with negative and fractional values |
| `rows_needing_embedding_returns_nothing_for_an_empty_index` | empty fixture yields `Ok(vec![])` |
| `upsert_then_load_returns_the_same_vector` | `load_vectors` returns the vector passed to `upsert_embedding` |
| `upsert_replaces_rather_than_duplicating` | two upserts for one `owner_id` leave `COUNT(*) == 1` |
| `load_vectors_skips_rows_whose_embedding_is_missing` | a row present in the id list but absent from `memory_embeddings` is omitted, not returned with a zero vector |
| `needs_reindex_is_false_on_an_empty_index` | empty fixture yields `false` |
| `log_event_accepts_every_permitted_event` | `recall`, `extract`, `reinforce`, `supersede` all insert, and `COUNT(*) == 4` |

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::tests`
Expected: FAIL to compile — `crate::memory::embed` does not exist.

- [ ] **Step 3: Implement `embed.rs`**

`encode`/`decode`:

```rust
pub fn encode(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn decode(bytes: &[u8], dim: usize) -> Option<Vec<f32>> {
    if bytes.len() != dim * 4 {
        return None;
    }
    Some(
        bytes.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}
```

`cosine`: return `None` when either slice is empty, when lengths differ, or when either magnitude is zero. Otherwise return the dot product over the product of magnitudes.

`rows_needing_embedding` is a single query that `LEFT JOIN`s `memory_embeddings` and selects where the join missed, the model differs, or the dim differs:

```sql
SELECT 'memory', m.id, m.kind, m.title, m.content, m.is_enabled, m.superseded_by,
       m.access_count, m.updated_at
FROM memory_items m
LEFT JOIN memory_embeddings e
       ON e.owner_type = 'memory' AND e.owner_id = m.id
WHERE m.is_enabled = 1
  AND m.superseded_by IS NULL
  AND LENGTH(m.content) >= ?1
  AND (e.id IS NULL OR e.model <> ?2 OR e.dim <> ?3)
UNION ALL
SELECT 'note', n.id, 'note', n.title, n.body, 1, NULL, 0, n.updated_at
FROM notes n
LEFT JOIN memory_embeddings e
       ON e.owner_type = 'note' AND e.owner_id = n.id
WHERE n.pinned = 1 OR ?4 = 1
  AND LENGTH(n.body) >= ?1
  AND (e.id IS NULL OR e.model <> ?2 OR e.dim <> ?3)
```

The note arm takes a `notes_must_be_pinned: bool` argument, wired to a `memory.embed_all_notes` setting defaulting to false. A corpus of long-form notes is expensive to embed and mostly not worth retrieving; the owner's call, one setting.

**Do not use `UNION ALL` with the `?4 = 1` term as written above.** `AND` binds tighter than `OR`, so that predicate is wrong. The note arm's own condition must be parenthesised:

```sql
WHERE (n.pinned = 1 OR ?4 = 1)
  AND LENGTH(n.body) >= ?1
  AND (e.id IS NULL OR e.model <> ?2 OR e.dim <> ?3)
```

`load_vectors` takes a second query joining `memory_embeddings` against the caller's filtered id list. Bind ids in chunks of 500 to stay under SQLite's variable limit, which is 999 by default and a real hazard at a 5,000-item corpus.

`needs_reindex` is `SELECT EXISTS(SELECT 1 FROM memory_embeddings WHERE model <> ?1 OR dim <> ?2)`.

`log_event` generates a UUID and inserts, letting the CHECK constraint reject a bad event rather than validating in Rust — one enforcement point instead of two.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml memory::tests`
Expected: PASS, 17 tests.

- [ ] **Step 5: Run the full gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run`
Expected: clean; 372/372 TypeScript.

- [ ] **Step 6: Confirm the frontend is still untouched**

Run: `git diff main --stat -- src/ | tail -3`
Expected: only the files Plan 1 changed. This plan adds nothing under `src/`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/memory src-tauri/src/db
git commit -m "feat(memory): vector persistence with model-aware reindex detection

Little-endian f32 BLOB codec, cosine with explicit None for degenerate
inputs, and a rows-needing-embedding query that treats a model or
dimension change as work to redo rather than a vector to compare.

A blob whose length disagrees with its recorded dimension decodes to
None, not zeros: a cosine over zeros produces a confident wrong score.

Memory and notes are selected through one query, so retrieval cannot
tell them apart.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Close out the phase

**Files:**
- Modify: `src-tauri/src/lib.rs` if any `mod` declaration is still missing
- Modify: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md` (Phase 2/3 checkboxes)
- Modify: `docs/GOALS.md` if a gate needs restating

**Interfaces:**
- Consumes: everything above.
- Produces: a green phase with its gates recorded.

- [ ] **Step 1: Verify no TypeScript changed**

Run: `git diff main --stat -- src/ | tail -5 && git diff main --name-only -- src/ | wc -l`
Expected: the only `src/` files listed are the ones Plan 1 touched. If this plan leaked into the frontend, revert it — the constraint at the top of this plan is absolute.

- [ ] **Step 2: Run the full Rust and TypeScript gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test:run && npm run build`
Expected: all clean. Record the Rust test count — the AGENTS.md floor will need updating.

- [ ] **Step 3: Verify the migration is safe to ship on a real database**

Run: `sqlite3` is not a dependency, so use the test: `cargo test --manifest-path src-tauri/Cargo.toml db:: -- --nocapture`
Expected: `migrates_a_populated_database_without_losing_data` passes. Then confirm by inspection that `V006__unified_index.sql` contains no `DROP TABLE` other than the `pending_memory_reviews` rebuild, and no `DELETE`.

- [ ] **Step 4: Update the spec checkboxes**

Mark spec §5 and §10's Phase 2 and Phase 3 items complete. Note in the spec that the unified index is one *retrieval path* over two FTS tables, with the reasoning already recorded in this plan's Design decision section.

- [ ] **Step 5: Update `AGENTS.md` and `GOALS.md` counts**

The verification trio comment in `AGENTS.md` carries the TypeScript floor. If the Rust test count is quoted anywhere (`docs/RELEASE_CHECKLIST.md` says 35), update it to the number this phase produced. Do not guess it — read it off the `cargo test` output from Step 2.

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri docs AGENTS.md
git commit -m "docs: close out the unified index and provider phase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Out of Scope — the next plan

This plan covers spec Phase 2 and Phase 3 only. Remaining:

| Plan | Spec phase | Starts from |
|---|---|---|
| 3 | Phase 4 + 5 — hybrid retrieval (BM25 ⊕ cosine ⊕ RRF ⊕ boost ⊕ MMR), extraction re-target, the revision decision table | This plan's schema, `embed`, and config |
| 4 | Phase 6 + 7 — notes wiring, Rust-owned context assembly, delete `chatStream.ts:736-787` and `stores/memory.ts buildContextBlock` | Plan 3's retrieval |
| 5 | Phase 8 + 9 — nav reorder, Memory/Notes/review UI, release gates | Plan 4's context assembly |

Plan 3 is the one that makes recall actually work. It is also where `commands/memory.rs` gets reworked, which is why this plan left that file alone.

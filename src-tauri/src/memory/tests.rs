use rusqlite::{params, Connection};

use crate::commands::memory;
use crate::commands::notes;
use crate::db::models::MemoryItem;

/// An in-memory `settings` table, matching the real one from V001:
/// `settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
fn conn_with_settings(pairs: &[(&str, &str)]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    for (key, value) in pairs {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .unwrap();
    }
    conn
}

use super::config::{self, ModelRoute, ModelRouting};
use super::context;
use super::index;
use super::retrieve;

#[test]
fn routing_defaults_to_unset_when_no_row_exists() {
    let conn = conn_with_settings(&[]);
    assert_eq!(config::load_routing(&conn), ModelRouting::default());
}

#[test]
fn routing_reads_each_capability_independently() {
    // Configuring extraction must not implicitly configure chat or
    // embedding: an unset capability falls back to the session's own
    // model, which is the right default and must stay explicit.
    let conn = conn_with_settings(&[(
        "memory.routing",
        r#"{"extraction":{"provider_id":"p1","model":"qwen2.5:3b"}}"#,
    )]);
    let routing = config::load_routing(&conn);
    assert_eq!(
        routing.extraction,
        Some(ModelRoute {
            provider_id: "p1".into(),
            model: "qwen2.5:3b".into(),
        })
    );
    assert_eq!(routing.chat, None);
    assert_eq!(routing.embedding, None);
}

#[test]
fn routing_reads_all_three_capabilities_at_once() {
    let conn = conn_with_settings(&[(
        "memory.routing",
        r#"{"chat":{"provider_id":"p1","model":"llama3"},
            "extraction":{"provider_id":"p1","model":"qwen2.5:3b"},
            "embedding":{"provider_id":"p2","model":"nomic-embed-text"}}"#,
    )]);
    let routing = config::load_routing(&conn);
    assert_eq!(routing.chat.unwrap().model, "llama3");
    assert_eq!(routing.extraction.unwrap().model, "qwen2.5:3b");
    assert_eq!(routing.embedding.unwrap().provider_id, "p2");
}

#[test]
fn malformed_routing_json_degrades_to_defaults_instead_of_erroring() {
    // A bad settings row must never be the reason recall fails. These
    // are the shapes a hand-edited row or a bad migration produces.
    for bad in [
        "not json",
        "[]",
        "{}",
        r#"{"chat":"p1"}"#,
        r#"{"chat":{"provider_id":1}}"#,
        r#"{"chat":{"provider_id":"p1"}}"#,
        r#"{"chat":{"model":"llama3"}}"#,
        r#"{"chat":{"provider_id":"","model":"llama3"}}"#,
        r#"{"unknown_capability":{"provider_id":"p1","model":"m"}}"#,
    ] {
        let conn = conn_with_settings(&[("memory.routing", bad)]);
        assert_eq!(
            config::load_routing(&conn),
            ModelRouting::default(),
            "input should have degraded to defaults: {}",
            bad
        );
    }
}

#[test]
fn one_bad_capability_does_not_discard_the_good_ones() {
    // Partial validity is still useful. A user who mistyped the embedding
    // model should keep their chat routing.
    let conn = conn_with_settings(&[(
        "memory.routing",
        r#"{"chat":{"provider_id":"p1","model":"llama3"},"embedding":{"provider_id":1}}"#,
    )]);
    let routing = config::load_routing(&conn);
    assert_eq!(routing.chat.unwrap().model, "llama3");
    assert_eq!(routing.embedding, None);
}

#[test]
fn top_k_defaults_and_overrides() {
    assert_eq!(
        config::top_k(&conn_with_settings(&[])),
        config::TOP_K_DEFAULT
    );
    let conn = conn_with_settings(&[("memory.top_k", "12")]);
    assert_eq!(config::top_k(&conn), 12);
}

#[test]
fn top_k_ignores_a_nonsense_value() {
    // Zero would silently disable recall, which is never what a bad
    // settings row should do.
    for bad in ["abc", "-1", "0", "", "3.5", "9999999999999999999"] {
        let conn = conn_with_settings(&[("memory.top_k", bad)]);
        assert_eq!(
            config::top_k(&conn),
            config::TOP_K_DEFAULT,
            "input: {}",
            bad
        );
    }
}

#[test]
fn context_budget_fraction_accepts_a_real_fraction_and_rejects_the_rest() {
    assert_eq!(
        config::context_budget_fraction(&conn_with_settings(&[])),
        0.15
    );
    // Out of range falls back to the default rather than clamping. A user
    // who typed 2.0 most likely dropped a decimal point and meant 0.2;
    // honouring the literal value would let memory take the whole context
    // window and break the conversation.
    for (input, want) in [
        ("0.5", 0.5),
        ("0", 0.15),
        ("1", 1.0),
        ("2.0", 0.15),
        ("-1", 0.15),
        ("nan", 0.15),
        ("inf", 0.15),
        ("nonsense", 0.15),
    ] {
        let conn = conn_with_settings(&[("memory.context_budget_fraction", input)]);
        assert_eq!(
            config::context_budget_fraction(&conn),
            want,
            "input: {}",
            input
        );
    }
}

#[test]
fn auto_extract_defaults_on_and_can_be_turned_off() {
    assert!(config::auto_extract(&conn_with_settings(&[])));
    assert!(!config::auto_extract(&conn_with_settings(&[(
        "memory.auto_extract",
        "false"
    )])));
    assert!(config::auto_extract(&conn_with_settings(&[(
        "memory.auto_extract",
        "true"
    )])));
    // Anything not explicitly false leaves the default alone.
    for v in ["1", "yes", "", "nonsense"] {
        assert!(
            config::auto_extract(&conn_with_settings(&[("memory.auto_extract", v)])),
            "input: {}",
            v
        );
    }
}

#[test]
fn the_spec_constants_have_the_values_the_spec_pins() {
    // These are contract with the design doc, not implementation detail.
    // Changing one changes retrieval behaviour for every existing user.
    assert_eq!(config::RRF_K, 60.0);
    assert_eq!(config::BM25_LIMIT, 30);
    assert_eq!(config::COSINE_LIMIT, 30);
    assert_eq!(config::TOP_K_DEFAULT, 6);
    assert_eq!(config::REINFORCE_FLOOR, 0.72);
    assert_eq!(config::DUP_FLOOR, 0.92);
    assert_eq!(config::RECENCY_HALF_LIFE_DAYS, 30.0);
    assert_eq!(config::EXTRACT_EVERY_N_EXCHANGES, 1);
    assert_eq!(config::CONTEXT_BUDGET_FRACTION, 0.15);
    assert_eq!(config::MIN_CONTENT_LENGTH, 8);
    assert_eq!(config::EMBED_BATCH, 32);
}

#[test]
fn the_recency_half_life_setting_is_read_and_degenerate_values_fall_back() {
    // 30 days is the default; a stored value wins; anything that would make
    // `0.5^(age / half_life)` meaningless falls back to the default rather
    // than silently turning recency off or producing NaN.
    assert_eq!(config::recency_half_life_days(&migrated_conn()), 30.0);

    let seven = conn_with_settings(&[("memory.recency_half_life_days", "7")]);
    assert_eq!(config::recency_half_life_days(&seven), 7.0);

    for degenerate in ["0", "-1", "nan", "inf", "thirty", ""] {
        let conn = conn_with_settings(&[("memory.recency_half_life_days", degenerate)]);
        assert_eq!(
            config::recency_half_life_days(&conn),
            30.0,
            "{degenerate:?} was honoured as a half-life"
        );
    }
}

#[test]
fn the_extraction_interval_setting_is_read_and_zero_falls_back() {
    // `0` would mean "never extract", which the user has an explicit switch
    // for; silently honouring it would look like extraction was broken.
    assert_eq!(config::extract_every_n_exchanges(&migrated_conn()), 1);

    let three = conn_with_settings(&[("memory.extract_every_n_exchanges", "3")]);
    assert_eq!(config::extract_every_n_exchanges(&three), 3);

    for degenerate in ["0", "-2", "often", ""] {
        let conn = conn_with_settings(&[("memory.extract_every_n_exchanges", degenerate)]);
        assert_eq!(
            config::extract_every_n_exchanges(&conn),
            1,
            "{degenerate:?} was honoured as an interval"
        );
    }
}

// ---------------------------------------------------------------------------
// Vector persistence
// ---------------------------------------------------------------------------

use super::embed::{
    age_days, cosine, decode, delete_embedding, encode, load_vectors, log_event, needs_reindex,
    recall_count, recency_weight, rows_needing_embedding, upsert_embedding, KnowledgeRow,
};

/// A connection at the real V006 schema, not a hand-rolled approximation.
fn migrated_conn() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::db::migrations_for_tests()
        .to_latest(&mut conn)
        .unwrap();
    conn
}

/// A migrated in-memory pool. `max_size(1)` keeps it to a single
/// connection so the `:memory:` database is the same one on every `get()` —
/// the same trick `services.rs` uses.
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
    }
    std::sync::Arc::new(pool)
}

fn add_memory(conn: &Connection, id: &str, content: &str) {
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content) VALUES (?1,'project_fact','T',?2)",
        params![id, content],
    )
    .unwrap();
}

fn add_note(conn: &Connection, id: &str, body: &str, pinned: i64) {
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned) VALUES (?1,'N',?2,?3)",
        params![id, body, pinned],
    )
    .unwrap();
}

/// The same, with a real title, for the retrieval corpus.
fn add_note_titled(conn: &Connection, id: &str, title: &str, body: &str, pinned: i64) {
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned) VALUES (?1,?2,?3,?4)",
        params![id, title, body, pinned],
    )
    .unwrap();
}

/// A fixture covering every branch of the eligibility query at once.
fn seeded() -> Connection {
    let conn = migrated_conn();
    add_memory(&conn, "enabled-one", "a durable fact long enough to embed");
    add_memory(&conn, "disabled", "a durable fact long enough to embed");
    conn.execute(
        "UPDATE memory_items SET is_enabled = 0 WHERE id = 'disabled'",
        [],
    )
    .unwrap();
    add_memory(&conn, "superseded", "a durable fact long enough to embed");
    conn.execute(
        "UPDATE memory_items SET superseded_by = 'enabled-one' WHERE id = 'superseded'",
        [],
    )
    .unwrap();
    add_memory(&conn, "tiny", "x");
    // Comfortably past MIN_CONTENT_LENGTH, so these fixtures test the pinned
    // gate rather than the length gate.
    add_note(
        &conn,
        "pinned-note",
        "a long note body that is definitely worth indexing",
        1,
    );
    add_note(
        &conn,
        "unpinned-note",
        "another long note body that is also worth indexing",
        0,
    );
    conn
}

const LONG: &str = "a durable fact long enough to embed";

#[test]
fn encode_decode_round_trips_a_vector() {
    // Negative and fractional values, so a sign or precision error in the
    // little-endian packing would show up.
    let v = vec![0.0f32, -1.5, 3.25, -0.125, f32::MAX, f32::MIN_POSITIVE];
    assert_eq!(decode(&encode(&v), v.len()).unwrap(), v);
}

#[test]
fn decode_rejects_a_blob_whose_length_disagrees_with_its_dimension() {
    // A torn or truncated write. Decoding this as zeros would produce a
    // confident cosine score from a vector that does not exist.
    let bytes = encode(&[1.0, 2.0, 3.0]);
    assert!(decode(&bytes, 2).is_none(), "dim too small");
    assert!(decode(&bytes, 4).is_none(), "dim too large");
    assert_eq!(decode(&bytes, 3).unwrap(), vec![1.0, 2.0, 3.0]);
}

#[test]
fn decode_rejects_a_truncated_blob() {
    let mut bytes = encode(&[1.0, 2.0, 3.0]);
    bytes.truncate(10); // 2.5 floats
    assert!(decode(&bytes, 3).is_none());
}

#[test]
fn cosine_of_identical_vectors_is_one() {
    let v = vec![1.0f32, 2.0, 3.0];
    let got = cosine(&v, &v).unwrap();
    assert!((got - 1.0).abs() < 1e-6, "got {}", got);
}

#[test]
fn cosine_of_orthogonal_vectors_is_zero() {
    let got = cosine(&[1.0, 0.0], &[0.0, 1.0]).unwrap();
    assert!(got.abs() < 1e-6, "got {}", got);
}

#[test]
fn cosine_of_opposite_vectors_is_minus_one() {
    let got = cosine(&[1.0, 0.0], &[-1.0, 0.0]).unwrap();
    assert!((got + 1.0).abs() < 1e-6, "got {}", got);
}

#[test]
fn cosine_returns_none_for_degenerate_inputs() {
    // Each of these would otherwise be a NaN or an infinity that poisons
    // every downstream comparison in the ranking.
    assert!(cosine(&[0.0, 0.0], &[1.0, 1.0]).is_none(), "zero magnitude");
    assert!(cosine(&[1.0, 1.0], &[0.0, 0.0]).is_none(), "zero magnitude");
    assert!(cosine(&[1.0, 2.0], &[1.0]).is_none(), "length mismatch");
    assert!(cosine(&[], &[]).is_none(), "empty");
    assert!(cosine(&[1.0], &[]).is_none(), "one side empty");
}

#[test]
fn rows_needing_embedding_skips_disabled_and_superseded_rows() {
    let rows = rows_needing_embedding(&seeded(), "nomic-embed-text", 768, false).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.owner_id.as_str()).collect();
    assert!(ids.contains(&"enabled-one"), "got {:?}", ids);
    assert!(
        !ids.contains(&"disabled"),
        "a disabled row is not work to do"
    );
    assert!(!ids.contains(&"superseded"), "a superseded row is history");
}

#[test]
fn rows_needing_embedding_honours_the_minimum_length() {
    let rows = rows_needing_embedding(&seeded(), "m", 768, false).unwrap();
    assert!(
        !rows.iter().any(|r| r.owner_id == "tiny"),
        "one-character content is noise in a cosine neighbourhood"
    );
    // And the boundary itself is inclusive of the configured minimum.
    let conn = migrated_conn();
    let exact = "x".repeat(super::config::MIN_CONTENT_LENGTH);
    add_memory(&conn, "exact", &exact);
    let rows = rows_needing_embedding(&conn, "m", 768, false).unwrap();
    assert!(rows.iter().any(|r| r.owner_id == "exact"));
}

/// The live failure this floor was rewritten for: `User's nickname` /
/// `Kevin` is five characters of content. The old content-only
/// thirty-two-character gate dropped it, so the one memory a user is most
/// likely to ask for never got a vector. The floor now measures title plus
/// content, so a short fact with a naming title is embeddable.
#[test]
fn rows_needing_embedding_reads_the_title_as_part_of_the_text() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content)
         VALUES ('nick', 'user_pref', 'User''s nickname', 'Kevin')",
        [],
    )
    .unwrap();
    let rows = rows_needing_embedding(&conn, "m", 768, false).unwrap();
    assert!(
        rows.iter().any(|r| r.owner_id == "nick"),
        "a titled short fact must be embeddable: {rows:?}"
    );

    // A genuinely tiny row is still dropped: no title, a two-character body.
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content)
         VALUES ('frag', 'user_pref', '', 'hi')",
        [],
    )
    .unwrap();
    let rows = rows_needing_embedding(&conn, "m", 768, false).unwrap();
    assert!(
        !rows.iter().any(|r| r.owner_id == "frag"),
        "a two-character fragment is still noise"
    );
}

#[test]
fn rows_needing_embedding_gates_notes_on_the_pinned_flag() {
    // A long-form note library is expensive to embed and mostly not what a
    // chat query is reaching for, so only pinned notes go in by default.
    let rows = rows_needing_embedding(&seeded(), "m", 768, false).unwrap();
    let notes: Vec<&str> = rows
        .iter()
        .filter(|r| r.owner_type == "note")
        .map(|r| r.owner_id.as_str())
        .collect();
    assert_eq!(notes, vec!["pinned-note"]);

    // Flipping the setting admits every note.
    let rows = rows_needing_embedding(&seeded(), "m", 768, true).unwrap();
    assert!(rows.iter().any(|r| r.owner_id == "unpinned-note"));
}

#[test]
fn rows_needing_embedding_returns_nothing_for_an_empty_index() {
    let rows = rows_needing_embedding(&migrated_conn(), "m", 768, false).unwrap();
    assert!(rows.is_empty());
}

#[test]
fn rows_needing_embedding_skips_rows_already_indexed_by_the_same_model() {
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "m", &[0.1, 0.2]).unwrap();
    let rows = rows_needing_embedding(&conn, "m", 2, false).unwrap();
    assert!(
        !rows.iter().any(|r| r.owner_id == "enabled-one"),
        "already indexed under this model and dim"
    );
}

#[test]
fn rows_needing_embedding_includes_rows_indexed_by_a_different_model() {
    // Vectors from two embedding models are not comparable. The row must
    // come back as work to redo, not as a candidate for scoring.
    let conn = seeded();
    upsert_embedding(
        &conn,
        "memory",
        "enabled-one",
        "nomic-embed-text",
        &[0.1, 0.2],
    )
    .unwrap();

    let rows = rows_needing_embedding(&conn, "mxbai-embed-large", 2, false).unwrap();
    assert!(
        rows.iter().any(|r| r.owner_id == "enabled-one"),
        "model switched"
    );

    let rows = rows_needing_embedding(&conn, "nomic-embed-text", 1024, false).unwrap();
    assert!(
        rows.iter().any(|r| r.owner_id == "enabled-one"),
        "dim switched"
    );
}

#[test]
fn upsert_then_load_returns_the_same_vector() {
    let conn = seeded();
    let vector = vec![0.5f32, -0.25, 1.0];
    upsert_embedding(&conn, "memory", "enabled-one", "m", &vector).unwrap();

    let rows = vec![KnowledgeRow {
        owner_type: "memory".into(),
        owner_id: "enabled-one".into(),
        kind: "project_fact".into(),
        title: Some("T".into()),
        content: LONG.into(),
        is_enabled: true,
        superseded_by: None,
        access_count: 0,
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }];
    let loaded = load_vectors(&conn, "m", &rows).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].1, vector);
    assert_eq!(loaded[0].0.owner_id, "enabled-one");
}

#[test]
fn upsert_replaces_rather_than_duplicating() {
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "m", &[0.1, 0.2]).unwrap();
    upsert_embedding(&conn, "memory", "enabled-one", "m", &[0.3, 0.4]).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_embeddings WHERE owner_id = 'enabled-one'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn load_vectors_skips_rows_whose_embedding_is_missing() {
    // Not returned with a zero vector: a zero vector would either be
    // skipped as degenerate or, worse, compared as if it were real.
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "m", &[0.1, 0.2]).unwrap();
    let row = |id: &str| KnowledgeRow {
        owner_type: "memory".into(),
        owner_id: id.into(),
        kind: "project_fact".into(),
        title: None,
        content: LONG.into(),
        is_enabled: true,
        superseded_by: None,
        access_count: 0,
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    };
    let loaded = load_vectors(&conn, "m", &[row("enabled-one"), row("nope")]).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].0.owner_id, "enabled-one");
}

#[test]
fn load_vectors_skips_a_row_indexed_by_another_model() {
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "other", &[0.1, 0.2]).unwrap();
    let rows = vec![KnowledgeRow {
        owner_type: "memory".into(),
        owner_id: "enabled-one".into(),
        kind: "project_fact".into(),
        title: None,
        content: LONG.into(),
        is_enabled: true,
        superseded_by: None,
        access_count: 0,
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }];
    assert!(load_vectors(&conn, "m", &rows).unwrap().is_empty());
}

#[test]
fn load_vectors_of_an_empty_request_needs_no_query() {
    assert!(load_vectors(&migrated_conn(), "m", &[]).unwrap().is_empty());
}

#[test]
fn needs_reindex_is_false_on_an_empty_index() {
    assert!(!needs_reindex(&migrated_conn(), "m", 768).unwrap());
}

#[test]
fn needs_reindex_is_true_after_switching_the_embedding_model() {
    let conn = seeded();
    upsert_embedding(
        &conn,
        "memory",
        "enabled-one",
        "nomic-embed-text",
        &[0.1, 0.2],
    )
    .unwrap();
    assert!(
        !needs_reindex(&conn, "nomic-embed-text", 2).unwrap(),
        "same model and dim"
    );
    assert!(
        needs_reindex(&conn, "mxbai-embed-large", 2).unwrap(),
        "model switched"
    );
    assert!(
        needs_reindex(&conn, "nomic-embed-text", 1024).unwrap(),
        "dim switched"
    );
}

#[test]
fn log_event_accepts_every_permitted_event() {
    let conn = migrated_conn();
    for event in ["recall", "extract", "reinforce", "supersede"] {
        log_event(&conn, "memory", "mem1", event, Some("s1")).unwrap();
    }
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 4);
}

#[test]
fn log_event_rejects_an_event_outside_the_check_constraint() {
    // The database is the only enforcement point. Validating in Rust too
    // would be a second place to keep in sync.
    let conn = migrated_conn();
    assert!(log_event(&conn, "memory", "mem1", "recall", None).is_ok());
    assert!(log_event(&conn, "memory", "mem1", "nonsense", None).is_err());
    assert!(log_event(&conn, "nonsense", "mem1", "recall", None).is_err());
    // And nothing was written by the rejected calls.
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn log_event_tolerates_a_null_session() {
    let conn = migrated_conn();
    assert!(log_event(&conn, "note", "n1", "recall", None).is_ok());
}

#[test]
fn upsert_refuses_a_zero_length_or_non_finite_vector() {
    // Storing either produces a row that fails to decode or scores as
    // garbage. Refusing at the write is cheaper to diagnose than a
    // mysterious empty recall later.
    let conn = migrated_conn();
    assert!(upsert_embedding(&conn, "memory", "m1", "m", &[]).is_err());
    assert!(upsert_embedding(&conn, "memory", "m1", "m", &[f32::NAN]).is_err());
    assert!(upsert_embedding(&conn, "memory", "m1", "m", &[f32::INFINITY]).is_err());
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "a rejected vector must leave no row behind");
}

#[test]
fn delete_embedding_removes_only_the_named_row() {
    let conn = seeded();
    upsert_embedding(&conn, "memory", "enabled-one", "m", &[0.1, 0.2]).unwrap();
    upsert_embedding(&conn, "note", "pinned-note", "m", &[0.3, 0.4]).unwrap();

    delete_embedding(&conn, "memory", "enabled-one").unwrap();

    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 1, "only the named row should go");
}

#[test]
fn a_memory_and_a_note_can_hold_vectors_under_the_same_owner_id() {
    // The owner pair is the key, not the bare id. A note and a memory
    // generated from a shared uuid must not collide.
    let conn = seeded();
    upsert_embedding(&conn, "memory", "shared", "m", &[0.1, 0.2]).unwrap();
    upsert_embedding(&conn, "note", "shared", "m", &[0.3, 0.4]).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(n, 2);
}

#[test]
fn recency_weight_halves_at_the_half_life_and_is_clamped() {
    let half_life = super::config::RECENCY_HALF_LIFE_DAYS;
    assert!((recency_weight(0.0, half_life) - 1.0).abs() < 1e-9);
    assert!(
        (recency_weight(half_life, half_life) - 0.5).abs() < 1e-9,
        "one half-life is 0.5"
    );
    // The floor is 0.5 and is reached at one half-life, not approached
    // asymptotically. A durable fact should not keep losing relevance
    // purely for being old — that is the "the app forgot" failure mode.
    // Age breaks ties between comparably-relevant items; it does not
    // expire them.
    assert_eq!(recency_weight(half_life * 2.0, half_life), 0.5);
    assert_eq!(recency_weight(10_000.0, half_life), 0.5);
    // Monotonic non-increasing across the decay range.
    let mut previous = 1.0;
    for step in 0..=60 {
        let weight = recency_weight(step as f64, half_life);
        assert!(
            weight <= previous + f64::EPSILON,
            "not monotonic at {}",
            step
        );
        previous = weight;
    }
    // Degenerate input is treated as fresh, not as ancient.
    assert_eq!(recency_weight(-5.0, half_life), 1.0);
    assert_eq!(recency_weight(f64::NAN, half_life), 1.0);
}

#[test]
fn age_days_is_zero_for_an_unparseable_timestamp() {
    // A malformed date must not halve an item's rank forever.
    assert_eq!(age_days("not a timestamp"), 0.0);
    assert_eq!(age_days(""), 0.0);
    assert!(
        age_days("2020-01-01T00:00:00.000Z") > 1000.0,
        "a 2020 date is old"
    );
    let now = chrono::Utc::now().to_rfc3339();
    assert!(age_days(&now) < 1.0, "a date from now is not old");
}

#[test]
fn recall_count_counts_only_recall_events() {
    let conn = migrated_conn();
    log_event(&conn, "memory", "m1", "recall", None).unwrap();
    log_event(&conn, "memory", "m1", "recall", Some("s1")).unwrap();
    log_event(&conn, "memory", "m1", "reinforce", None).unwrap();
    let count = recall_count(&conn, "memory", "m1").unwrap();
    assert_eq!(count, 2, "reinforce is not a recall");
    assert_eq!(recall_count(&conn, "memory", "nope").unwrap(), 0);
}

// ---------------------------------------------------------------------------
// Vector lookup at corpus scale
// ---------------------------------------------------------------------------

fn knowledge_row(id: &str) -> KnowledgeRow {
    KnowledgeRow {
        owner_type: "memory".into(),
        owner_id: id.into(),
        kind: "project_fact".into(),
        title: None,
        content: LONG.into(),
        is_enabled: true,
        superseded_by: None,
        access_count: 0,
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

#[test]
fn load_vectors_resolves_a_large_id_list_in_one_pass() {
    // Ordering and pairing are what a per-row linear scan could get wrong
    // at scale: rank is assigned by the caller, so a vector paired with
    // the wrong row silently corrupts ranking rather than erroring.
    let conn = migrated_conn();
    let mut expected: Vec<String> = Vec::new();
    for i in 0..600 {
        let id = format!("m{}", i);
        add_memory(&conn, &id, LONG);
        upsert_embedding(&conn, "memory", &id, "m", &[i as f32, 1.0]).unwrap();
        expected.push(id);
    }
    let rows: Vec<KnowledgeRow> = expected.iter().map(|id| knowledge_row(id)).collect();

    let loaded = load_vectors(&conn, "m", &rows).unwrap();
    assert_eq!(loaded.len(), 600, "every requested row must come back");
    let got: Vec<&str> = loaded.iter().map(|(r, _)| r.owner_id.as_str()).collect();
    let want: Vec<&str> = expected.iter().map(|s| s.as_str()).collect();
    assert_eq!(got, want, "ordering must follow the caller's row order");
    for (row, vector) in &loaded {
        let i: f32 = row.owner_id[1..].parse().unwrap();
        assert_eq!(vector[0], i, "vector paired with the wrong row");
    }
}

#[test]
fn load_vectors_chunks_past_the_sqlite_variable_limit() {
    // SQLITE_MAX_VARIABLE_NUMBER defaults to 999. A 2,000-id request must
    // split without a bind error.
    let conn = migrated_conn();
    let mut rows = Vec::new();
    for i in 0..2000 {
        let id = format!("m{}", i);
        add_memory(&conn, &id, LONG);
        upsert_embedding(&conn, "memory", &id, "m", &[i as f32]).unwrap();
        rows.push(knowledge_row(&id));
    }
    let loaded = load_vectors(&conn, "m", &rows).unwrap();
    assert_eq!(loaded.len(), 2000);
}

// ---------------------------------------------------------------------------
// Retrieval routes
// ---------------------------------------------------------------------------

/// A memory with an explicit kind and title. Plan 2's three-argument
/// `add_memory` stays as it is, because a dozen of its tests use it.
fn add_memory_full(conn: &Connection, id: &str, kind: &str, title: &str, content: &str) {
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content) VALUES (?1, ?2, ?3, ?4)",
        params![id, kind, title, content],
    )
    .unwrap();
}

/// A corpus where every query has at least one defensible answer, plus
/// decoys that only a keyword route or only a semantic route would find.
fn knowledge_corpus(conn: &Connection) {
    for (id, kind, title, content) in [
        (
            "db-choice",
            "decision",
            "Database choice",
            "Chose Postgres over MySQL for the multi-tenant billing schema",
        ),
        (
            "db-pool",
            "project_fact",
            "Connection pooling",
            "PgBouncer sits in front of Postgres with pool_mode set to transaction",
        ),
        (
            "migrate",
            "skill",
            "Running migrations",
            "Apply migrations with just so it runs pending SQL and exits nonzero on failure",
        ),
        (
            "editor",
            "user_pref",
            "Editor",
            "Prefers Neovim with lazy.nvim and no plugin manager",
        ),
        (
            "deploy",
            "constraint",
            "Deploy window",
            "No production deploys on Fridays after 14:00 UTC",
        ),
    ] {
        add_memory_full(conn, id, kind, title, content);
    }
    add_note_titled(
        conn,
        "db-runbook",
        "Runbook",
        "Restart PgBouncer after a Postgres failover, then check replication lag",
        1,
    );
    add_note_titled(
        conn,
        "editor-notes",
        "Editor setup",
        "Neovim config lives in a dotfiles repo, module-per-plugin",
        0,
    );
}

fn recall_opts<'a>(query: &'a str) -> retrieve::RecallOptions<'a> {
    retrieve::RecallOptions {
        query,
        session_id: None,
        embedding_model: None,
        embedding_dim: None,
        kinds: None,
        top_k: config::TOP_K_DEFAULT as usize,
        lambda: retrieve::DEFAULT_LAMBDA,
    }
}

#[test]
fn recall_finds_an_exact_keyword_match() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let hits = retrieve::recall(&conn, &recall_opts("PgBouncer"));
    assert!(!hits.is_empty());
    assert_eq!(hits[0].owner_id, "db-pool", "got {:?}", ids(&hits));
}

/// "what's my name?" does not contain the token `nickname`, and "who am I?"
/// contains no keyword token at all. A saved nickname is the memory the
/// user expects either question to return.
#[test]
fn asking_for_a_name_recalls_a_saved_nickname() {
    let conn = migrated_conn();
    add_memory_full(
        &conn,
        "nick",
        "user_pref",
        "User nickname",
        "The user's nickname is Kevin.",
    );
    add_memory_full(
        &conn,
        "editor",
        "user_pref",
        "Editor",
        "The user uses Neovim",
    );

    for query in [
        "what's my name",
        "what is my name?",
        "who am I",
        "what is my nickname",
    ] {
        let hits = retrieve::recall(&conn, &recall_opts(query));
        assert!(
            ids(&hits).contains(&"nick"),
            "{query:?} missed the nickname, got {:?}",
            ids(&hits)
        );
        assert!(
            !ids(&hits).contains(&"editor"),
            "{query:?} recalled an unrelated preference: {:?}",
            ids(&hits)
        );
    }

    // "called" is in the identity group, but only a question about the
    // user expands it. An ordinary question must not surface the nickname.
    let unrelated = retrieve::recall(&conn, &recall_opts("what is this called"));
    assert!(
        !ids(&unrelated).contains(&"nick"),
        "an unrelated question recalled the nickname: {:?}",
        ids(&unrelated)
    );

    let disabled = migrated_conn();
    add_memory_full(
        &disabled,
        "nick",
        "user_pref",
        "User nickname",
        "The user's nickname is Kevin.",
    );
    disabled
        .execute(
            "UPDATE memory_items SET is_enabled = 0 WHERE id = 'nick'",
            [],
        )
        .unwrap();
    assert!(
        retrieve::recall(&disabled, &recall_opts("what's my name")).is_empty(),
        "a disabled nickname is not a name the model should be told"
    );
}

fn ids(hits: &[retrieve::RankedMemory]) -> Vec<&str> {
    hits.iter().map(|h| h.owner_id.as_str()).collect()
}

#[test]
fn recall_survives_an_empty_index() {
    let conn = migrated_conn();
    assert!(retrieve::recall(&conn, &recall_opts("anything")).is_empty());
}

#[test]
fn recall_excludes_a_superseded_memory() {
    // Review Focus 3. A superseded row is history, not something to
    // inject into a prompt — but it stays readable in the item list.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute(
        "UPDATE memory_items SET superseded_by = 'db-choice' WHERE id = 'migrate'",
        [],
    )
    .unwrap();
    let hits = retrieve::recall(&conn, &recall_opts("migrations"));
    assert!(!ids(&hits).contains(&"migrate"), "got {:?}", ids(&hits));
    let still_there: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_items WHERE id = 'migrate'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(still_there, 1, "supersede retains the row for history");
}

#[test]
fn recall_excludes_a_disabled_memory() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute(
        "UPDATE memory_items SET is_enabled = 0 WHERE id = 'editor'",
        [],
    )
    .unwrap();
    assert!(!ids(&retrieve::recall(&conn, &recall_opts("neovim"))).contains(&"editor"));
}

#[test]
fn recall_without_an_embedding_model_is_keyword_only_and_still_works() {
    // Review Focus 1. The most likely first-run state.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let hits = retrieve::recall(&conn, &recall_opts("postgres"));
    assert!(
        !hits.is_empty(),
        "keyword recall must work with no embedder"
    );
    assert!(hits.len() <= config::TOP_K_DEFAULT as usize);
    assert!(
        hits.iter().all(|h| h.reason.contains("keyword")),
        "no vector route was configured, so nothing may claim a semantic match"
    );
}

#[test]
fn recall_honours_a_per_session_allowlist() {
    // A non-empty override list is an allowlist, matching the semantics
    // buildContextBlock already has.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO session_overrides (session_id, item_id) VALUES ('s1','db-choice')",
        [],
    )
    .unwrap();
    let mut o = recall_opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(
        hits.iter().all(|h| h.owner_id == "db-choice"),
        "allowlist not applied: {:?}",
        ids(&hits)
    );
}

#[test]
fn recall_with_no_overrides_includes_everything() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    let mut o = recall_opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);
    assert!(
        hits.len() > 1,
        "an empty override list must not filter to nothing"
    );
}

// ---------------------------------------------------------------------------
// The allowlist is a property of the result
// ---------------------------------------------------------------------------
//
// `session_overrides` is a per-session allowlist: one row and every other
// memory in the library is off for that conversation. It used to be
// enforced inside the keyword route's SQL, which left the vector route free
// to bring back anything the keyword route had filtered out — so with
// embeddings configured, whether a user's exclusion was honoured depended on
// which route happened to find the memory. These pin it on the merged
// result, for both arms and for the two shapes that mean "no restriction".

/// The model the fixture vectors are stored under, which is the only thing
/// `cosine_route` matches on.
const STUB_MODEL: &str = "stub";

/// A question the keyword route cannot answer. The memory below shares no
/// token with it, so a hit can only have come from the vector route.
const SEMANTIC_QUERY: &str = "what is the wifi password";

/// What `SEMANTIC_QUERY` embeds to, and what the fixture memory is stored
/// under: an exact match, so cosine is 1.0 and well over `REINFORCE_FLOOR`.
const STUB_VECTOR: &[f32] = &[1.0, 0.0, 0.0];

/// A memory only the vector route can reach. It avoids "wifi" and
/// "password" on purpose: an earlier fixture in this family said "The wifi
/// password is hunter2", which the keyword route found, so the test would
/// have proved nothing.
fn add_semantic_only_memory(conn: &Connection, id: &str) {
    add_memory_full(
        conn,
        id,
        "project_fact",
        "Network",
        "The SSID is Convo-5G and the passphrase is hunter2",
    );
    upsert_embedding(conn, "memory", id, STUB_MODEL, STUB_VECTOR).unwrap();
}

/// `SEMANTIC_QUERY` with the vector route live and the keyword route
/// powerless against it.
fn semantic_opts<'a>(session_id: Option<&'a str>) -> retrieve::RecallOptions<'a> {
    retrieve::RecallOptions {
        query: SEMANTIC_QUERY,
        session_id,
        embedding_model: Some(STUB_MODEL.to_string()),
        embedding_dim: Some(3),
        kinds: None,
        top_k: config::TOP_K_DEFAULT as usize,
        lambda: retrieve::DEFAULT_LAMBDA,
    }
}

/// Scope a session to `ids`. An empty `ids` is a session that has never
/// used the feature, which `session_allowlist` reports as unrestricted.
fn scope_session_to(conn: &Connection, session_id: &str, ids: &[&str]) {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1,'S')",
        params![session_id],
    )
    .unwrap();
    for id in ids {
        conn.execute(
            "INSERT INTO session_overrides (session_id, item_id) VALUES (?1,?2)",
            params![session_id, id],
        )
        .unwrap();
    }
}

/// Scope a session to nothing, which the override rows alone cannot say.
/// Goes through the real write path rather than inserting a row, so this
/// fixture cannot drift from what the modal sends.
fn deny_all_for_session(conn: &Connection, session_id: &str) {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1,'S')",
        params![session_id],
    )
    .unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO session_memory_scope (session_id) VALUES (?1)",
        params![session_id],
    )
    .unwrap();
}

/// The arm that already worked, pinned anyway: an exclusion the keyword
/// route enforces has to keep being enforced once the filter that enforces
/// it lives somewhere else.
///
/// Two memories answer this question, so the session is scoped to one of
/// them and the assertion is both halves — the excluded one is gone and the
/// allowed one arrived. A filter that dropped everything would pass a
/// test that only checked the first.
#[test]
fn a_memory_the_session_excluded_stays_out_of_the_keyword_result() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    scope_session_to(&conn, "s1", &["db-choice"]);

    let mut o = recall_opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);

    assert!(
        ids(&hits).contains(&"db-choice"),
        "the memory the session allowed should have been recalled: {:?}",
        ids(&hits)
    );
    assert!(
        !ids(&hits).contains(&"db-pool"),
        "a memory the session excluded was recalled anyway: {:?}",
        ids(&hits)
    );
}

/// A session scoped to a memory the vector route found. The filter has to
/// drop the excluded rows without eating the allowed ones — a filter that
/// removed everything satisfies test 1 as happily as this one.
#[test]
fn a_memory_the_session_allowed_survives_the_vector_route() {
    let conn = migrated_conn();
    add_semantic_only_memory(&conn, "wifi");
    scope_session_to(&conn, "s1", &["wifi"]);

    let hits = retrieve::recall_with_query_vector(&conn, &semantic_opts(Some("s1")), STUB_VECTOR);

    assert_eq!(
        ids(&hits),
        vec!["wifi"],
        "an allowlisted memory found by the vector route must survive"
    );
    assert!(
        hits[0].reason.contains("semantic"),
        "and it must still be reported as the vector route's find: {}",
        hits[0].reason
    );
}

/// A recall over a large index still returns the right row. This is the
/// correctness guard for the vector route's query rewrite: the old shape
/// scanned every embedding and re-queried the owner table once per hit, and
/// a rewrite that dropped or re-paired a row would still pass the small
/// fixtures above. It is deliberately not a wall-clock assertion — the p95
/// budget is measured in release, and a timing bound in CI would be flaky.
#[test]
fn recall_stays_correct_across_a_large_index() {
    let conn = migrated_conn();
    for i in 0..2_000 {
        let id = format!("filler-{i}");
        add_memory_full(
            &conn,
            &id,
            "project_fact",
            "Filler",
            "an unrelated durable fact about tooling and process",
        );
        upsert_embedding(&conn, "memory", &id, STUB_MODEL, &[0.0, 1.0, 0.0]).unwrap();
    }
    add_semantic_only_memory(&conn, "needle");

    let hits = retrieve::recall_with_query_vector(&conn, &semantic_opts(None), STUB_VECTOR);
    assert_eq!(
        ids(&hits).first().copied(),
        Some("needle"),
        "the vector route lost or reordered the one matching row: {:?}",
        ids(&hits)
    );
}

/// The Phase 9 latency gate, measured instead of asserted by inspection.
///
/// Ignored because the number only means something in a release build: an
/// unoptimised debug run is several times slower, so a wall-clock bound there
/// would be either vacuous or flaky. Run it with
///
/// ```text
/// cargo test --release --manifest-path src-tauri/Cargo.toml -- \
///     --ignored recall_latency --nocapture
/// ```
///
/// The corpus is 5,000 memories with 5,000 stored vectors — the shape that
/// costs the most, because the vector route reads and scores every embedded
/// row, so it is the route that grows with the corpus. The keyword-only arm
/// runs too, because a keyword-only install is the degradation path and must
/// stay under the same gate.
#[test]
#[ignore = "release-mode latency gate; debug timings are not meaningful"]
fn recall_latency_p95_over_five_thousand_items() {
    use std::time::{Duration, Instant};

    const CORPUS: usize = 5_000;
    const SAMPLES: usize = 200;
    const BUDGET: Duration = Duration::from_millis(50);
    const KEYWORD_QUERY: &str = "an unrelated durable fact about tooling and process";

    let conn = migrated_conn();
    for i in 0..CORPUS {
        let id = format!("perf-{i}");
        add_memory_full(
            &conn,
            &id,
            "project_fact",
            "Filler",
            &format!("an unrelated durable fact about tooling and process, entry number {i}"),
        );
        // Distinct directions, so no comparison short-circuits: every stored
        // vector clears the reinforce floor and has to be sorted.
        let vector = [1.0f32, (i as f32) * 0.0001, 0.5];
        upsert_embedding(&conn, "memory", &id, STUB_MODEL, &vector).unwrap();
    }
    // The one row only the vector route can find, and the row the vector-only
    // arm asserts on: a timing that stays green because recall returned
    // nothing would prove nothing about recall.
    add_semantic_only_memory(&conn, "needle");

    let opts = |query: &'static str, embedding_model: Option<&str>| retrieve::RecallOptions {
        query,
        session_id: None,
        embedding_model: embedding_model.map(str::to_string),
        embedding_dim: embedding_model.map(|_| 3),
        kinds: None,
        top_k: config::TOP_K_DEFAULT as usize,
        lambda: retrieve::DEFAULT_LAMBDA,
    };
    let keyword_opts = opts(KEYWORD_QUERY, None);
    let fused_opts = opts(KEYWORD_QUERY, Some(STUB_MODEL));
    let vector_opts = opts(SEMANTIC_QUERY, Some(STUB_MODEL));

    let mut keyword: Vec<Duration> = Vec::with_capacity(SAMPLES);
    let mut fused: Vec<Duration> = Vec::with_capacity(SAMPLES);
    let mut vector: Vec<Duration> = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        let hits = retrieve::recall(&conn, &keyword_opts);
        keyword.push(start.elapsed());
        assert_eq!(
            hits.len(),
            config::TOP_K_DEFAULT as usize,
            "keyword recall stopped filling its page at {CORPUS} items"
        );

        let start = Instant::now();
        let hits = retrieve::recall_with_query_vector(&conn, &fused_opts, STUB_VECTOR);
        fused.push(start.elapsed());
        assert_eq!(
            hits.len(),
            config::TOP_K_DEFAULT as usize,
            "fused recall stopped filling its page at {CORPUS} items"
        );

        let start = Instant::now();
        let hits = retrieve::recall_with_query_vector(&conn, &vector_opts, STUB_VECTOR);
        vector.push(start.elapsed());
        assert_eq!(
            ids(&hits).first().copied(),
            Some("needle"),
            "the vector route lost the matching row at {CORPUS} items"
        );
    }

    fn p95(mut samples: Vec<Duration>) -> Duration {
        samples.sort();
        let rank = ((samples.len() as f64) * 0.95).ceil() as usize;
        samples[rank.saturating_sub(1)]
    }

    let keyword_p95 = p95(keyword);
    let fused_p95 = p95(fused);
    let vector_p95 = p95(vector);
    println!(
        "recall p95 over {CORPUS} items: keyword-only {keyword_p95:?}, both routes {fused_p95:?}, vector-only {vector_p95:?}"
    );
    for (arm, measured) in [
        ("keyword-only", keyword_p95),
        ("both routes", fused_p95),
        ("vector-only", vector_p95),
    ] {
        assert!(
            measured < BUDGET,
            "{arm} recall p95 {measured:?} exceeds the {BUDGET:?} budget"
        );
    }
}

/// No session means no overrides were ever read, so no restriction. A
/// filter that read "no allowlist" as "nothing admitted" would return an
/// empty result here rather than failing, which is the worst way for it to
/// be wrong: the Memory tab would go blank and every send would lose its
/// memory, with nothing in the logs.
#[test]
fn no_session_leaves_a_recall_unrestricted() {
    let conn = migrated_conn();
    add_semantic_only_memory(&conn, "wifi");
    // Another session's overrides must not narrow an unscoped recall.
    // `session_overrides.item_id` is a foreign key, so the row it names has
    // to exist for the override to be storable at all.
    add_memory_full(
        &conn,
        "db-choice",
        "project_fact",
        "Database choice",
        "Chose Postgres over MySQL for the multi-tenant billing schema",
    );
    scope_session_to(&conn, "s1", &["db-choice"]);

    let hits = retrieve::recall_with_query_vector(&conn, &semantic_opts(None), STUB_VECTOR);

    assert!(
        ids(&hits).contains(&"wifi"),
        "a recall with no session was filtered by an allowlist: {:?}",
        ids(&hits)
    );
}

/// An untouched session means "no restriction", and that convention is
/// load-bearing rather than incidental. `session_allowlist` answers
/// unrestricted for every session with no scope row and no override rows —
/// which is every session a user did not go looking for it in — so reading
/// the empty list as "nothing is allowed" would not fail loudly. It would
/// silently empty the memory of every session in the library, on every send,
/// and look like a retrieval bug nobody could reproduce.
#[test]
fn an_empty_override_list_leaves_a_recall_unrestricted() {
    let conn = migrated_conn();
    add_semantic_only_memory(&conn, "wifi");
    scope_session_to(&conn, "s1", &[]);

    let hits = retrieve::recall_with_query_vector(&conn, &semantic_opts(Some("s1")), STUB_VECTOR);

    assert!(
        ids(&hits).contains(&"wifi"),
        "a session with no overrides was filtered to nothing: {:?}",
        ids(&hits)
    );
}

/// A session the user scoped to nothing recalls nothing, and that is the
/// answer they asked for.
///
/// The bug this pins: unchecking every memory in the session modal sent an
/// empty list, which was the same thing as "never configured" — so a user
/// who said "this chat has no memory" got the whole library back, silently,
/// with no error anywhere. A deny-all the data layer cannot hold is a
/// control that lies about what it does.
///
/// Both routes are live here, because an exclusion that only the keyword
/// route honours is the bug d2528ab was about: the vector route has to lose
/// the same rows, and the merge-time filter has to be the thing that does it.
#[test]
fn a_session_scoped_to_nothing_recalls_nothing() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    add_semantic_only_memory(&conn, "wifi");
    deny_all_for_session(&conn, "s1");

    let keyword = retrieve::recall(&conn, &{
        let mut o = recall_opts("postgres pooling");
        o.session_id = Some("s1");
        o
    });
    assert!(
        keyword.is_empty(),
        "the keyword route answered a session that admits nothing: {:?}",
        ids(&keyword)
    );

    let semantic =
        retrieve::recall_with_query_vector(&conn, &semantic_opts(Some("s1")), STUB_VECTOR);
    assert!(
        semantic.is_empty(),
        "the vector route answered a session that admits nothing: {:?}",
        ids(&semantic)
    );
}

/// The same instruction, seen through the read the UI uses to draw the
/// boxes: a scoped-to-nothing session has to come back as *configured* with
/// an empty list, not as an untouched session. Returning the untouched
/// answer would leave the modal drawing every box checked while recall
/// returns nothing — the same lie, one layer up.
#[test]
fn a_session_scoped_to_nothing_reads_back_as_configured_and_empty() {
    let conn = migrated_conn();
    add_memory(&conn, "db-choice", "Chose Postgres over MySQL");
    deny_all_for_session(&conn, "s1");

    let scope = memory::session_memory_scope(&conn, "s1").unwrap();
    assert_eq!(
        scope,
        memory::SessionMemoryScope {
            item_ids: Vec::new(),
            configured: true,
        },
        "deny-all must not be readable as never-configured"
    );
}

/// And the three states are three states, not two. The third is the one
/// this change added; the first two are the convention that had to survive
/// it.
#[test]
fn the_scope_reads_back_untouched_scoped_and_cleared() {
    let mut conn = migrated_conn();
    add_memory(&conn, "db-choice", "Chose Postgres over MySQL");
    add_memory(&conn, "db-pool", "The pool is r2d2");
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES ('s1','S')",
        [],
    )
    .unwrap();

    let untouched = memory::SessionMemoryScope {
        item_ids: Vec::new(),
        configured: false,
    };
    assert_eq!(
        memory::session_memory_scope(&conn, "s1").unwrap(),
        untouched
    );

    memory::write_session_memory_scope(&mut conn, "s1", &["db-choice".to_string()], true).unwrap();
    assert_eq!(
        memory::session_memory_scope(&conn, "s1").unwrap(),
        memory::SessionMemoryScope {
            item_ids: vec!["db-choice".to_string()],
            configured: true,
        }
    );

    // Checking every box again is the one gesture that means "no
    // restriction", and it has to clear the scope rather than store a list
    // of every id.
    memory::write_session_memory_scope(&mut conn, "s1", &[], false).unwrap();
    assert_eq!(
        memory::session_memory_scope(&conn, "s1").unwrap(),
        untouched
    );
    let leftover: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_overrides WHERE session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftover, 0, "clearing leaves no override rows behind");
}

/// A session scoped before the scope table existed still reads as scoped.
/// This is every session a user had already configured when the app
/// updated, and the migration adds no rows for them, so this is the
/// compatibility the whole shape rests on: reading them as unrestricted
/// would silently widen each one to the entire library on the next send.
#[test]
fn override_rows_without_a_scope_row_still_read_as_configured() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    scope_session_to(&conn, "s1", &["db-choice"]);

    let scope = memory::session_memory_scope(&conn, "s1").unwrap();
    assert!(scope.configured, "a pre-migration session stays scoped");
    assert_eq!(scope.item_ids, ["db-choice"]);

    let mut o = recall_opts("postgres");
    o.session_id = Some("s1");
    let hits = retrieve::recall(&conn, &o);
    assert_eq!(
        ids(&hits),
        vec!["db-choice"],
        "and keeps exactly the memories it had"
    );
}

#[test]
fn recall_is_deterministic() {
    // Rank comes from a fused score. Two calls over unchanged data must
    // agree exactly, or the Memory tab shuffles on every turn for no
    // reason and the user stops trusting it.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    assert_eq!(
        retrieve::recall(&conn, &recall_opts("postgres pooling")),
        retrieve::recall(&conn, &recall_opts("postgres pooling"))
    );
}

#[test]
fn recall_respects_top_k() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut o = recall_opts("postgres neovim deploy");
    o.top_k = 2;
    assert_eq!(retrieve::recall(&conn, &o).len(), 2);
}

#[test]
fn recall_with_a_nonsense_query_returns_nothing_rather_than_erroring() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    for q in ["", "   ", "!!!", "\"", "*", "AND OR NOT", "a to"] {
        assert!(
            retrieve::recall(&conn, &recall_opts(q)).is_empty(),
            "query {:?} returned {:?}",
            q,
            ids(&retrieve::recall(&conn, &recall_opts(q)))
        );
    }
}

#[test]
fn every_recalled_item_carries_a_reason() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    for hit in retrieve::recall(&conn, &recall_opts("postgres")) {
        assert!(
            !hit.reason.trim().is_empty(),
            "no reason for {}",
            hit.owner_id
        );
    }
}

#[test]
fn recall_can_find_a_pinned_note() {
    // Notes are in the same index. A pinned one is the kind a query is
    // most likely to want.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let hits = retrieve::recall(&conn, &recall_opts("pgbouncer failover"));
    assert!(ids(&hits).contains(&"db-runbook"), "got {:?}", ids(&hits));
}

#[test]
fn recall_respects_a_kind_filter() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut o = recall_opts("postgres neovim");
    o.kinds = Some(vec!["decision".to_string()]);
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(
        hits.iter().all(|h| h.kind == "decision"),
        "got {:?}",
        ids(&hits)
    );
}

// ---------------------------------------------------------------------------
// Recall gates
// ---------------------------------------------------------------------------

/// Proves the vector route is load-bearing.
///
/// "what is the wifi password" against a memory worded "the SSID is
/// Convo-5G and the passphrase is hunter2". After stop words and
/// sub-three-character tokens are dropped, the question and the memory
/// share nothing at all, so the keyword route cannot answer it. If this
/// ever passes on the keyword path alone, the embedding index is not
/// being read and the whole subsystem is decorative.
#[test]
fn recall_finds_a_memory_with_no_lexical_overlap() {
    let conn = migrated_conn();
    // Deliberately avoids "wifi" and "password". An earlier version said
    // "The wifi password is hunter2", which of course the keyword route
    // found — the test then proved nothing.
    add_memory_full(
        &conn,
        "wifi",
        "project_fact",
        "Network",
        "The SSID is Convo-5G and the passphrase is hunter2",
    );
    upsert_embedding(&conn, "memory", "wifi", "stub", &[1.0, 0.0, 0.0]).unwrap();

    let mut o = recall_opts("what is the wifi password");
    o.embedding_model = Some("stub".to_string());
    let hits = retrieve::recall_with_query_vector(&conn, &o, &[1.0, 0.0, 0.0]);

    assert!(!hits.is_empty(), "keyword search cannot answer this one");
    assert_eq!(hits[0].owner_id, "wifi");
    assert!(
        hits[0].reason.contains("semantic"),
        "got reason: {}",
        hits[0].reason
    );
    // And the keyword route genuinely found nothing, so the win is real.
    let keyword_only = retrieve::recall(&conn, &recall_opts("what is the wifi password"));
    assert!(
        keyword_only.is_empty(),
        "the fixture does not actually need vectors"
    );
}

/// The recall-precision gate from the spec: at least 90% of the items a
/// reasonable person would call relevant land in the top 6.
///
/// Measured keyword-only, because the test has no embedder. That is the
/// degraded mode, and the number it produces is the floor the hybrid route
/// has to beat, not the target.
const KNOWN_QUERIES: &[(&str, &[&str])] = &[
    ("postgres", &["db-choice", "db-pool", "db-runbook"]),
    ("which database", &["db-choice"]),
    ("connection pool failover", &["db-pool", "db-runbook"]),
    ("how do i run migrations", &["migrate"]),
    ("apply pending sql", &["migrate"]),
    ("neovim configuration", &["editor", "editor-notes"]),
    ("when can i deploy", &["deploy"]),
    ("friday deploy policy", &["deploy"]),
    ("pgbouncer", &["db-pool", "db-runbook"]),
    ("multi tenant billing", &["db-choice"]),
    // Paraphrases. A keyword index cannot answer these; they are here to
    // measure how much the vector route is worth, not to be passed.
    ("how do I connect to the database", &["db-choice"]),
    ("what text editor do I use", &["editor"]),
    ("when am I allowed to ship", &["deploy"]),
];

#[test]
fn recall_precision_over_keyword_queries_meets_the_gate() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut total = 0usize;
    let mut found = 0usize;
    let mut misses: Vec<String> = Vec::new();
    for (query, relevant) in KNOWN_QUERIES {
        let hits = retrieve::recall(&conn, &recall_opts(query));
        let top: Vec<&str> = hits.iter().take(6).map(|h| h.owner_id.as_str()).collect();
        for want in *relevant {
            total += 1;
            if top.contains(want) {
                found += 1;
            } else {
                misses.push(format!("{:?} missed {} (got {:?})", query, want, top));
            }
        }
    }
    let precision = found as f64 / total as f64;
    println!(
        "MEASURED keyword-only recall precision: {:.0}% ({}/{})",
        precision * 100.0,
        found,
        total
    );
    assert!(
        precision >= 0.90,
        "keyword-only recall precision {:.0}% ({}/{}) below the 90% gate\n{}",
        precision * 100.0,
        found,
        total,
        misses.join("\n")
    );
}

#[test]
fn recall_degrades_to_keyword_only_when_the_embed_route_is_unusable() {
    // A configured model with no stored vectors: the cosine route yields
    // nothing and keyword recall still answers.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    let mut o = recall_opts("postgres");
    o.embedding_model = Some("nomic-embed-text".to_string());
    o.embedding_dim = Some(768);
    let hits = retrieve::recall(&conn, &o);
    assert!(!hits.is_empty());
    assert!(
        hits.iter().all(|h| h.reason.contains("keyword")),
        "claimed a semantic reason with no vectors"
    );
}

#[test]
fn recall_ignores_vectors_from_a_different_dimension() {
    // Vectors from another model are not comparable with this one.
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    upsert_embedding(
        &conn,
        "memory",
        "db-choice",
        "nomic-embed-text",
        &[0.1, 0.2],
    )
    .unwrap();
    let mut o = recall_opts("postgres");
    o.embedding_model = Some("nomic-embed-text".to_string());
    let hits = retrieve::recall_with_query_vector(&conn, &o, &[0.0; 1024]);
    assert!(!hits.is_empty(), "keyword recall must still answer");
    assert!(
        hits.iter().all(|h| h.reason.contains("keyword")),
        "a 2-dim vector was compared against a 1024-dim query"
    );
}

#[test]
fn index_status_reports_what_needs_embedding_and_whether_a_reindex_is_due() {
    let conn = migrated_conn();
    knowledge_corpus(&conn);
    upsert_embedding(
        &conn,
        "memory",
        "db-choice",
        "nomic-embed-text",
        &[0.1; 768],
    )
    .unwrap();

    let (needs, reindex) = retrieve::knowledge_status(&conn, "nomic-embed-text", 768);
    assert!(!reindex, "every stored vector matches the configured model");
    // Four memories (all but db-choice, now embedded) plus the one pinned
    // note. Unpinned notes are excluded by default.
    assert_eq!(needs, 5, "unembedded memories plus the pinned note");

    let (_, reindex) = retrieve::knowledge_status(&conn, "mxbai-embed-large", 1024);
    assert!(reindex, "a model switch means the index is stale");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

use super::extract;

/// Approximate token count. Cheap, and only ever used as a window bound, so
/// a real tokenizer would cost more than it buys.
fn rough_tokens(text: &str) -> usize {
    text.len() / 4
}

/// Message ids must be unique across a whole test, not just within one
/// `seed_session` call, or a second call for the same session collides on
/// the primary key.
static MESSAGE_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn seed_session(conn: &Connection, session_id: &str, pairs: &[(&str, &str)]) {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, 'S')",
        params![session_id],
    )
    .unwrap();
    for (i, (role, content)) in pairs.iter().enumerate() {
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![
                format!(
                    "{}-{}-{}",
                    session_id,
                    MESSAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    i
                ),
                session_id,
                role,
                content
            ],
        )
        .unwrap();
    }
}

fn set_watermark(conn: &Connection, session_id: &str, message_id: &str) {
    conn.execute(
        "INSERT INTO memory_watermark (session_id, message_id) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET message_id = excluded.message_id",
        params![session_id, message_id],
    )
    .unwrap();
}

#[test]
fn kinds_expand_to_the_documented_six() {
    assert_eq!(extract::KINDS.len(), 6);
    for kind in extract::KINDS {
        assert!(
            extract::normalize_kind(kind).is_some(),
            "{} should normalize",
            kind
        );
    }
}

#[test]
fn an_unknown_kind_is_dropped_rather_than_stored() {
    for kind in ["task", "", "chore", "todo"] {
        assert!(
            extract::normalize_kind(kind).is_none(),
            "{:?} should not normalize",
            kind
        );
    }
}

#[test]
fn a_missing_confidence_defaults_to_half_not_to_one() {
    // A model that omitted the field has not expressed confidence.
    // Defaulting to 1.0 would let every legacy-shaped response past the
    // 0.80 auto-write gate.
    let raw = r#"[{"kind":"user_pref","title":"T","content":"c","tags":null}]"#;
    let facts = extract::parse_candidates(raw).unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].confidence, 0.5);
}

#[test]
fn confidence_outside_zero_to_one_is_clamped() {
    for (input, want) in [(1.7, 1.0), (-3.0, 0.0), (0.42, 0.42)] {
        let raw = format!(
            r#"[{{"kind":"user_pref","content":"c","confidence":{}}}]"#,
            input
        );
        let facts = extract::parse_candidates(&raw).unwrap();
        assert_eq!(facts[0].confidence, want, "input {}", input);
    }
}

#[test]
fn a_note_candidate_is_recognised() {
    let raw = r#"[{"kind":"project_fact","title":"Runbook","content":"summary",
                    "confidence":0.9,"is_note":true,"note_body":"the long form"}]"#;
    let facts = extract::parse_candidates(raw).unwrap();
    assert!(facts[0].is_note);
    assert_eq!(facts[0].note_body.as_deref(), Some("the long form"));
}

#[test]
fn a_note_candidate_without_a_body_is_still_a_note() {
    let raw = r#"[{"kind":"project_fact","content":"s","is_note":true}]"#;
    let facts = extract::parse_candidates(raw).unwrap();
    assert!(facts[0].is_note);
    assert!(facts[0].note_body.is_none());
}

#[test]
fn the_legacy_parser_shapes_still_parse() {
    // Every shape the existing parser was built to survive, because those
    // are real observations about what local models emit.
    // `fact` is the title and `value` the content in this shape; a fact
    // with no content is dropped on purpose, because a title is not a
    // durable fact. The eight existing tests in `commands/memory.rs`
    // remain the authority on these observed shapes; this adds the three
    // kinds the taxonomy gained.
    for raw in [
        r#"[{"type":"personal_information","fact":"Birthday","value":"February 18th"}]"#,
        r#"[{"fact_type":"personal_information","detail":"Born","value":"1990"}]"#,
        r#"{"extracted_facts":[{"kind":"project_fact","content":"c"}]}"#,
        r#"[{"category":"skill","value":"Always run the tests","labels":["ci"]}]"#,
        r#"[{"kind":"decision","content":"Use Rust for the CLI"}]"#,
        r#"[{"kind":"constraint","content":"Never deploy on a Friday"}]"#,
        r#"[{"kind":"entity","content":"The billing service is owned by Priya"}]"#,
    ] {
        let facts = extract::parse_candidates(raw).expect(raw);
        assert!(!facts.is_empty(), "legacy shape stopped parsing: {}", raw);
    }
}

#[test]
fn a_title_with_no_content_is_dropped_rather_than_stored_empty() {
    // A heading is not a durable fact. Storing it would fill memory with
    // titles that answer nothing.
    let facts = extract::parse_candidates(r#"[{"kind":"user_pref","title":"T"}]"#).unwrap();
    assert!(facts.is_empty());
}

#[test]
fn a_think_wrapped_response_still_parses() {
    let raw =
        "<think>reasoning about the answer</think>\n[{\"kind\":\"user_pref\",\"content\":\"c\"}]";
    let facts = extract::parse_candidates(raw).unwrap();
    assert_eq!(facts.len(), 1);
}

#[test]
fn a_response_that_is_not_a_fact_list_is_rejected() {
    // An empty array is NOT an error: it is the correct answer for
    // "nothing durable in this conversation", and the review flow treats
    // it as an automatic pass.
    assert!(extract::parse_candidates("[]").unwrap().is_empty());
    for raw in ["not json at all", "{}", r#"{"other":1}"#, "42"] {
        assert!(
            extract::parse_candidates(raw).is_err(),
            "should have been rejected: {:?}",
            raw
        );
    }
}

#[test]
fn no_extraction_runs_before_the_second_exchange() {
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[("user", "hello")]);
    assert!(extract::should_extract(&conn, "s1", 2).unwrap().is_none());
}

#[test]
fn a_single_exchange_extracts_at_the_every_exchange_threshold() {
    // The after-a-turn path calls `should_extract(.., 1)`. One exchange is
    // two messages and must qualify: a fresh chat that says "remember my cat
    // is named Mao Mao" and gets its answer otherwise never extracts, which
    // is the exact case this threshold was changed for.
    let conn = migrated_conn();
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "remember my cat is named Mao Mao"),
            (
                "assistant",
                "I will remember that your cat is named Mao Mao.",
            ),
        ],
    );
    let window = extract::should_extract(&conn, "s1", 1)
        .unwrap()
        .expect("a completed first exchange must extract");
    assert_eq!(window.messages.len(), 2);
}

#[test]
fn no_extraction_runs_twice_for_the_same_messages() {
    // Review Focus 4. Without a watermark the second pass re-proposes
    // every fact and REINFORCE fires on all of them, so the user's memory
    // fills with near-duplicates they never asked for.
    let conn = migrated_conn();
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "a"),
            ("assistant", "b"),
            ("user", "c"),
            ("assistant", "d"),
        ],
    );
    let first = extract::should_extract(&conn, "s1", 2)
        .unwrap()
        .expect("should extract");
    set_watermark(&conn, "s1", &first.watermark_message_id);
    assert!(
        extract::should_extract(&conn, "s1", 2).unwrap().is_none(),
        "the same messages must not extract twice"
    );
}

#[test]
fn extraction_resumes_after_the_watermark() {
    let conn = migrated_conn();
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "a"),
            ("assistant", "b"),
            ("user", "c"),
            ("assistant", "d"),
        ],
    );
    let first = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    set_watermark(&conn, "s1", &first.watermark_message_id);
    // `every_n` counts exchanges, and an exchange is a user turn plus an
    // answer, so two exchanges is four messages.
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "e"),
            ("assistant", "f"),
            ("user", "g"),
            ("assistant", "h"),
        ],
    );
    let second = extract::should_extract(&conn, "s1", 2)
        .unwrap()
        .expect("new messages should extract");
    assert_ne!(second.watermark_message_id, first.watermark_message_id);
}

#[test]
fn the_window_is_bounded_by_message_count() {
    let conn = migrated_conn();
    let pairs: Vec<(String, String)> = (0..80)
        .map(|i| ("user".to_string(), format!("short message {}", i)))
        .collect();
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    seed_session(&conn, "s1", &borrowed);
    let window = extract::should_extract(&conn, "s1", 2)
        .unwrap()
        .expect("should extract");
    assert!(
        window.messages.len() <= extract::MAX_WINDOW_MESSAGES,
        "message bound not applied: {}",
        window.messages.len()
    );
}

#[test]
fn the_window_is_bounded_by_tokens() {
    // Each message is ~1,000 tokens, so 30 of them are well over the
    // 6,000 budget while each one individually fits. Trimming from the
    // front has to land inside the budget.
    let conn = migrated_conn();
    let chunky = "word ".repeat(1000);
    let pairs: Vec<(String, String)> = (0..30)
        .map(|i| ("user".to_string(), format!("{} message {}", chunky, i)))
        .collect();
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    seed_session(&conn, "s1", &borrowed);
    let window = extract::should_extract(&conn, "s1", 2)
        .unwrap()
        .expect("should extract");
    let tokens: usize = window.messages.iter().map(|(_, c)| rough_tokens(c)).sum();
    assert!(
        tokens <= extract::MAX_WINDOW_TOKENS,
        "token bound not applied: {}",
        tokens
    );
    assert!(window.messages.len() >= 2, "the window must stay usable");
}

#[test]
fn a_message_too_large_for_the_budget_still_yields_a_window() {
    // One message can exceed the whole budget on its own. The bound is a
    // target, not a reason to refuse to extract — dropping below two
    // messages would be worse than overshooting.
    let conn = migrated_conn();
    let huge = "word ".repeat(20_000);
    let borrowed: Vec<(&str, &str)> = vec![
        ("user", huge.as_str()),
        ("assistant", "ok"),
        ("user", "and again"),
        ("assistant", "understood"),
    ];
    seed_session(&conn, "s1", &borrowed);
    let window = extract::should_extract(&conn, "s1", 2)
        .unwrap()
        .expect("should extract");
    // Trimming stops at the minimum rather than continuing, so the
    // window stays usable even though it overshoots the budget.
    assert!(
        window.messages.len() >= extract::MIN_EXTRACT_MESSAGES,
        "must not go below a usable window, got {}",
        window.messages.len()
    );
    assert!(
        window.messages.len() < 4,
        "should still have trimmed, kept {}",
        window.messages.len()
    );
}

#[test]
fn the_window_keeps_the_newest_messages() {
    // Trimming happens from the front, so the most recent exchange — the
    // one that produced the facts — must always survive.
    let conn = migrated_conn();
    let long = "word ".repeat(3000);
    let mut pairs: Vec<(String, String)> = (0..20)
        .map(|i| ("user".to_string(), format!("{} filler {}", long, i)))
        .collect();
    pairs.push(("user".to_string(), "MARKER_NEWEST".to_string()));
    pairs.push(("assistant".to_string(), "MARKER_NEWEST_REPLY".to_string()));
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    seed_session(&conn, "s1", &borrowed);
    let window = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    let all: String = window
        .messages
        .iter()
        .map(|(_, c)| c.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        all.contains("MARKER_NEWEST"),
        "the newest turn was trimmed away"
    );
}

#[test]
fn the_window_starts_after_the_watermark() {
    let conn = migrated_conn();
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "OLD_ONE"),
            ("assistant", "OLD_TWO"),
            ("user", "OLD_THREE"),
            ("assistant", "OLD_FOUR"),
        ],
    );
    let first = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    set_watermark(&conn, "s1", &first.watermark_message_id);
    seed_session(
        &conn,
        "s1",
        &[
            ("user", "NEW_ONE"),
            ("assistant", "NEW_TWO"),
            ("user", "NEW_THREE"),
            ("assistant", "NEW_FOUR"),
        ],
    );
    let second = extract::should_extract(&conn, "s1", 2).unwrap().unwrap();
    let all: String = second
        .messages
        .iter()
        .map(|(_, c)| c.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(all.contains("NEW_ONE"));
    assert!(
        !all.contains("OLD_ONE"),
        "the window must start after the watermark"
    );
}

#[test]
fn an_extraction_every_n_of_zero_or_one_never_blocks_extraction() {
    let conn = migrated_conn();
    seed_session(&conn, "s1", &[("user", "a"), ("assistant", "b")]);
    for every_n in [0, 1] {
        assert!(
            extract::should_extract(&conn, "s1", every_n)
                .unwrap()
                .is_some(),
            "every_n={} should not stall extraction",
            every_n
        );
    }
}

// ---------------------------------------------------------------------------
// Applying a revision
// ---------------------------------------------------------------------------

use super::revise;
use super::revise::{Applied, Nearest, RevisionAction};

fn fact(content: &str, confidence: f64) -> extract::ExtractedFact {
    extract::ExtractedFact {
        kind: "user_pref".into(),
        title: Some("T".into()),
        content: content.into(),
        tags: None,
        confidence,
        is_note: false,
        note_body: None,
    }
}

fn row_named(conn: &Connection, id: &str) -> super::embed::KnowledgeRow {
    conn.query_row(
        "SELECT kind, title, content, is_enabled, superseded_by, access_count, updated_at
         FROM memory_items WHERE id = ?1",
        params![id],
        |r| {
            Ok(super::embed::KnowledgeRow {
                owner_type: "memory".into(),
                owner_id: id.into(),
                kind: r.get(0)?,
                title: r.get(1)?,
                content: r.get(2)?,
                is_enabled: r.get::<_, i64>(3)? != 0,
                superseded_by: r.get(4)?,
                access_count: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )
    .unwrap()
}

fn count_rows(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn an_applied_add_writes_its_kind_and_confidence() {
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    // Above the 0.80 auto-add gate. At 0.77 this is a Review, not an
    // Add — which is the gate doing its job, and cost this test a
    // confusing FOREIGN KEY error before it was spotted.
    let candidate = fact("brand new fact", 0.95);
    let decision = revise::decide(&candidate, Some(0.1), None);
    assert_eq!(decision.action, RevisionAction::Add);
    let applied = decision.apply(&conn, "s1", &candidate, None, None).unwrap();
    assert!(matches!(applied, Applied::Added { .. }));
    let (confidence, kind): (f64, String) = conn
        .query_row("SELECT confidence, kind FROM memory_items", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert!((confidence - 0.95).abs() < 1e-9, "got {}", confidence);
    assert_eq!(kind, "user_pref");
}

#[test]
fn a_review_decision_writes_nothing_to_memory_items() {
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    add_memory_full(&conn, "m1", "user_pref", "T", "existing durable content");
    let before = count_rows(&conn, "memory_items");
    // Below the auto-add gate, so this is a review, not a write.
    let candidate = fact("something new", 0.2);
    let decision = revise::decide(&candidate, Some(0.1), None);
    assert_eq!(decision.action, RevisionAction::Review);
    let applied = decision.apply(&conn, "s1", &candidate, None, None).unwrap();
    assert!(matches!(applied, Applied::SentToReview { .. }));
    assert_eq!(
        count_rows(&conn, "memory_items"),
        before,
        "a review decision wrote a memory anyway"
    );
}

#[test]
fn reinforcing_bumps_the_counters_and_unions_tags() {
    let conn = migrated_conn();
    add_memory_full(&conn, "m1", "user_pref", "T", "the same durable fact");
    conn.execute(
        "UPDATE memory_items SET access_count = 3, tags = 'a,b' WHERE id = 'm1'",
        [],
    )
    .unwrap();
    let candidate = fact("the same fact", 0.95);
    let nearest = Nearest {
        row: row_named(&conn, "m1"),
        score: 0.80,
    };
    let decision = revise::decide(&candidate, Some(0.80), None);
    let applied = decision
        .apply(&conn, "s1", &candidate, Some(&nearest), None)
        .unwrap();
    assert!(matches!(applied, Applied::Reinforced { .. }));
    let (count, tags): (i64, Option<String>) = conn
        .query_row(
            "SELECT access_count, tags FROM memory_items WHERE id = 'm1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 4);
    let tags = tags.unwrap();
    assert!(
        tags.contains('a') && tags.contains('b'),
        "existing tags lost: {}",
        tags
    );
}

#[test]
fn superseding_keeps_the_old_row_for_history() {
    let conn = migrated_conn();
    add_memory_full(&conn, "old", "decision", "T", "the original decision");
    let candidate = fact("the reversed decision", 0.95);
    let nearest = Nearest {
        row: row_named(&conn, "old"),
        score: 0.97,
    };
    let decision = revise::decide(&candidate, Some(0.97), Some(revise::Verdict::Contradicts));
    assert_eq!(decision.action, RevisionAction::Supersede);
    let applied = decision
        .apply(&conn, "s1", &candidate, Some(&nearest), None)
        .unwrap();
    assert!(matches!(applied, Applied::Superseded { .. }));
    let superseded_by: Option<String> = conn
        .query_row(
            "SELECT superseded_by FROM memory_items WHERE id = 'old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        superseded_by.is_some(),
        "the old row must point at its replacement"
    );
    assert_eq!(
        count_rows(&conn, "memory_items"),
        2,
        "supersede retains history"
    );
    // And the superseded row is excluded from recall.
    assert!(
        !ids(&retrieve::recall(&conn, &recall_opts("decision"))).contains(&"old"),
        "a superseded memory is still being recalled"
    );
}

#[test]
fn a_merge_without_supplied_text_goes_to_review_rather_than_inventing_one() {
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    add_memory_full(&conn, "m1", "user_pref", "T", "prefers dark mode");
    let candidate = fact("prefers dark mode and a light terminal", 0.95);
    let nearest = Nearest {
        row: row_named(&conn, "m1"),
        score: 0.97,
    };
    let decision = revise::decide(&candidate, Some(0.97), Some(revise::Verdict::Complements));
    assert_eq!(decision.action, RevisionAction::Merge);
    let before = conn
        .query_row(
            "SELECT content FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    // No merged text supplied: refuse rather than overwrite with a guess.
    let applied = decision
        .apply(&conn, "s1", &candidate, Some(&nearest), None)
        .unwrap();
    assert!(matches!(applied, Applied::SentToReview { .. }));
    let after = conn
        .query_row(
            "SELECT content FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(before, after, "a merge wrote without supplied text");
}

#[test]
fn a_merge_with_supplied_text_writes_it() {
    let conn = migrated_conn();
    add_memory_full(&conn, "m1", "user_pref", "T", "prefers dark mode");
    let candidate = fact("prefers dark mode and a light terminal", 0.95);
    let nearest = Nearest {
        row: row_named(&conn, "m1"),
        score: 0.97,
    };
    let decision = revise::decide(&candidate, Some(0.97), Some(revise::Verdict::Complements));
    let applied = decision
        .apply(
            &conn,
            "s1",
            &candidate,
            Some(&nearest),
            Some("prefers dark mode, with a light terminal"),
        )
        .unwrap();
    assert!(matches!(applied, Applied::Merged { .. }));
    let content: String = conn
        .query_row(
            "SELECT content FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "prefers dark mode, with a light terminal");
}

#[test]
fn a_note_candidate_is_written_as_a_note_not_a_memory() {
    let conn = migrated_conn();
    let mut candidate = fact("a summary", 0.95);
    candidate.is_note = true;
    candidate.note_body = Some("the long form".into());
    let decision = revise::decide(&candidate, Some(0.1), None);
    let applied = decision.apply(&conn, "s1", &candidate, None, None).unwrap();
    assert!(matches!(applied, Applied::Added { .. }));
    assert_eq!(
        count_rows(&conn, "memory_items"),
        0,
        "a note landed in memory_items"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE body = 'the long form'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn applying_a_decision_logs_an_event() {
    // The access log is what makes reinforcement and decay computable
    // rather than guessed from updated_at alone.
    let conn = migrated_conn();
    let candidate = fact("a brand new fact for the log", 0.95);
    let decision = revise::decide(&candidate, Some(0.1), None);
    decision.apply(&conn, "s1", &candidate, None, None).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_events WHERE event = 'extract'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "an applied add must leave an extract event");
}

#[test]
fn a_session_can_run_more_than_one_extraction_round() {
    // V004's UNIQUE session_id capped a session at one round for life.
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    for id in ["r1", "r2", "r3"] {
        conn.execute(
            "INSERT INTO pending_memory_reviews (id, session_id, status) VALUES (?1,'s1','pending')",
            params![id],
        )
        .unwrap();
    }
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM pending_memory_reviews WHERE session_id = 's1'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
}

#[test]
fn a_watermark_survives_for_every_session() {
    let conn = migrated_conn();
    for id in ["s1", "s2"] {
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1,'S')",
            params![id],
        )
        .unwrap();
        set_watermark(&conn, id, "m-last");
    }
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_watermark", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    set_watermark(&conn, "s1", "m-newer");
    let latest: String = conn
        .query_row(
            "SELECT message_id FROM memory_watermark WHERE session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        latest, "m-newer",
        "a second write must replace, not duplicate"
    );
}

/// Reinforcement averages confidence rather than taking the max. A
/// repeated 0.7 guess should converge to 0.7, not climb to 0.95 because
/// it was seen twice; otherwise confidence would reward repetition over
/// evidence, and every loopback would ratchet its own guesses upward.
#[test]
fn reinforcement_averages_confidence_and_does_not_climb_past_the_observation() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, confidence, access_count)
         VALUES ('m1','user_pref','Build','prefers dark mode',1,0.5,0)",
        [],
    )
    .unwrap();

    let candidate = fact("prefers dark mode", 0.9);
    let decision = revise::decide(&candidate, Some(0.99), Some(revise::Verdict::Identical));
    let applied = decision
        .apply(
            &conn,
            "",
            &candidate,
            Some(&Nearest {
                row: row_named(&conn, "m1"),
                score: 0.99,
            }),
            None,
        )
        .unwrap();
    match applied {
        revise::Applied::Reinforced { confidence, .. } => {
            assert!((confidence - 0.7).abs() < 1e-9, "got {}", confidence);
        }
        other => panic!("expected Reinforced, got {:?}", other),
    }

    // A second identical observation lands on the same 0.9 it started at,
    // not above it.
    let applied = revise::decide(&candidate, Some(0.99), Some(revise::Verdict::Identical))
        .apply(
            &conn,
            "",
            &candidate,
            Some(&Nearest {
                row: row_named(&conn, "m1"),
                score: 0.99,
            }),
            None,
        )
        .unwrap();
    match applied {
        revise::Applied::Reinforced { confidence, .. } => {
            assert!((confidence - 0.8).abs() < 1e-9, "got {}", confidence);
            assert!(confidence < candidate.confidence);
        }
        other => panic!("expected Reinforced, got {:?}", other),
    }
}

/// A note candidate becomes a note row, not a memory row. One index, two
/// owner types: a memory recalled as a fact and a note recalled as a
/// document must not be confusable.
#[test]
fn an_added_note_candidate_writes_a_note_not_a_memory() {
    let conn = migrated_conn();
    let mut candidate = fact("Runbook", 0.95);
    candidate.is_note = true;
    candidate.note_body = Some("# Runbook\n\nstep one".to_string());

    let decision = revise::decide(&candidate, Some(0.1), None);
    let applied = decision.apply(&conn, "", &candidate, None, None).unwrap();
    assert!(matches!(applied, revise::Applied::Added { .. }));

    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    let memories: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(notes, 1);
    assert_eq!(memories, 0, "a note must not also land in memory_items");
}

/// The whole pipeline in one pass: a model's JSON reply goes through the
/// parser, each candidate through the decision table, and the result
/// through `apply` into the database.
///
/// The gap this closes: every other test starts from an `ExtractedFact`
/// it built by hand, so a change to the parser and a change to the table
/// could each pass alone while the seam between them — the field names the
/// model actually emits versus the ones the table reads — was never
/// exercised. Feeding raw model output is the only way to see that seam.
#[test]
fn a_model_reply_flows_through_parse_decide_and_apply() {
    let conn = migrated_conn();
    // What a small local model actually returns, flaws and all: a missing
    // confidence, a note flagged inline, a hedge that is not a verdict.
    let reply = r##"[
        {"kind":"user_pref","title":"Editor","content":"Uses Neovim as the primary editor.","tags":"editor,config","confidence":0.9,"is_note":false,"note_body":null},
        {"kind":"project_fact","title":"Convo","content":"Convo is a Tauri 2 chat client.","tags":null,"is_note":false,"note_body":null},
        {"kind":"skill","title":"Release runbook","content":"Tag, push, then wait for CI.","tags":"release","confidence":0.85,"is_note":true,"note_body":"# Release runbook\n\n1. Tag\n2. Push\n3. Wait for CI"},
        {"kind":"decision","title":"","content":"chose a rewrite over a refactor","tags":null,"confidence":0.6,"is_note":false,"note_body":null}
    ]"##;

    let candidates = extract::parse_candidates(reply).unwrap();
    assert_eq!(candidates.len(), 4, "every item in the reply must parse");

    // No confidence field: defaults to 0.5, which is below the add gate, so
    // a model that omits it proposes rather than writes.
    assert!(
        (candidates[1].confidence - 0.5).abs() < 1e-9,
        "a missing confidence must not read as full confidence, got {}",
        candidates[1].confidence
    );
    // Tags arrive as one string, not an array.
    assert_eq!(candidates[0].tags.as_deref(), Some("editor,config"));
    // A note candidate carries its long form.
    assert!(candidates[2].is_note);
    assert!(candidates[2]
        .note_body
        .as_deref()
        .unwrap()
        .contains("Release runbook"));

    // A review always names its session, so the connection needs one.
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();

    let mut effects = Vec::new();
    for candidate in &candidates {
        // Nothing exists yet, so every candidate is judged against no
        // neighbour: the branch under test is the add path and the gate.
        let decision = revise::decide(candidate, Some(0.05), None);
        // Propagated, not defaulted. An earlier version mapped the error
        // to a fake review, which turned a real foreign key failure into
        // an effect vector that still read "review" over zero rows.
        let applied = decision.apply(&conn, "s1", candidate, None, None).unwrap();
        effects.push(match applied {
            revise::Applied::Added { .. } => "added",
            revise::Applied::SentToReview { .. } => "review",
            other => panic!("unexpected effect {:?}", other),
        });
    }
    assert_eq!(
        effects,
        vec!["added", "review", "added", "review"],
        "0.9 and 0.85 clear the gate; a defaulted 0.5 and an explicit 0.6 do not"
    );

    // One memory from the first candidate, one note from the third: the
    // note is not also a memory row. The two sub-gate candidates are
    // review rows, not writes, and each applied row logged an event.
    assert_eq!(count_rows(&conn, "memory_items"), 1);
    assert_eq!(count_rows(&conn, "notes"), 1);
    assert_eq!(count_rows(&conn, "pending_memory_reviews"), 2);
    assert_eq!(count_rows(&conn, "memory_events"), 2);
}

/// A review without a session is refused rather than half-written. The
/// foreign key is doing the work here: the row is the inbox entry, and an
/// inbox entry that cannot name its conversation cannot be re-run or shown
/// in context. A silent skip would leave the user with no memory and no
/// queue item and nothing in the log.
#[test]
fn a_review_without_a_session_is_refused_rather_than_written() {
    let conn = migrated_conn();
    let candidate = fact("a modest claim", 0.6); // below the add gate
    let decision = revise::decide(&candidate, Some(0.05), None);
    assert_eq!(decision.action, RevisionAction::Review);

    let result = decision.apply(&conn, "", &candidate, None, None);
    assert!(
        result.is_err(),
        "expected the session foreign key to refuse this, got {:?}",
        result.map(|a| format!("{:?}", a))
    );
    assert_eq!(count_rows(&conn, "pending_memory_reviews"), 0);
    assert_eq!(count_rows(&conn, "memory_items"), 0);
}

/// A provider that returns fixed vectors, so the fill path can be tested
/// without a network or a model. `dim` is what it claims to return, which
/// is how the mismatch test provokes the dimension guard.
struct StubEmbedder {
    dim: usize,
    /// Vectors per input, or `None` to return the wrong count.
    per_input: Option<usize>,
}

#[async_trait::async_trait]
impl crate::providers::Provider for StubEmbedder {
    fn list_models<'a>(
        &'a self,
    ) -> crate::providers::ProviderFuture<'a, Vec<crate::providers::ModelInfo>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn probe<'a>(&'a self) -> crate::providers::ProbeFuture<'a> {
        Box::pin(async { crate::providers::ProbeOutcome::Err("stub".into()) })
    }
    fn chat_stream<'a>(
        &'a self,
        _request: crate::providers::types::ChatRequest,
    ) -> crate::providers::ProviderFuture<'a, crate::providers::ProviderStream> {
        Box::pin(async {
            Err(crate::providers::ProviderError::NotConfigured(
                "stub".into(),
            ))
        })
    }
    fn embed<'a>(
        &'a self,
        _model: &'a str,
        inputs: &'a [String],
    ) -> crate::providers::ProviderFuture<'a, Vec<Vec<f32>>> {
        let n = self.per_input.unwrap_or(inputs.len());
        Box::pin(async move { Ok(vec![vec![0.5; self.dim]; n]) })
    }
}

/// `fill_index` stores a vector for every row that needs one, and reports
/// how many it wrote.
#[tokio::test]
async fn fill_index_stores_a_vector_for_every_eligible_row() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "m1",
            "user_pref",
            "Build",
            "builds with npm run build and then vite build",
        );
        add_memory_full(
            &conn,
            "m2",
            "user_pref",
            "Test",
            "tests run with npm run test and vitest run",
        );
    }
    let written = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap();

    assert_eq!(written, 2);
    let conn = pool.get().unwrap();
    let stored: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, 2);
}

/// The bootstrap case: an index with no vectors has no dimension, and the
/// fill must learn it from the provider rather than refuse to run. Before
/// this, a user whose only memories were hand-written could never build the
/// first vector, so semantic recall was permanently off.
#[tokio::test]
async fn fill_index_bootstraps_from_an_empty_index_and_learns_the_dimension() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(&conn, "m1", "user_pref", "Name", "Kevin");
    }
    let written = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 8,
            per_input: None,
        },
        "e",
        0,
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        written, 1,
        "the first vector must be written when no dimension is stored"
    );
    let conn = pool.get().unwrap();
    let dim: i64 = conn
        .query_row(
            "SELECT dim FROM memory_embeddings WHERE owner_id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        dim, 8,
        "the dimension learned from the provider must be stored"
    );
}

/// A disabled or superseded row is not embedded. Re-embedding a superseded
/// memory would put a vector back into the index for something recall is
/// supposed to exclude.
#[tokio::test]
async fn fill_index_skips_disabled_and_superseded_rows() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "m1",
            "user_pref",
            "Live",
            "a preference that is still true today",
        );
        add_memory_full(
            &conn,
            "m2",
            "user_pref",
            "Off",
            "a preference the user turned off here",
        );
        add_memory_full(
            &conn,
            "m3",
            "user_pref",
            "Old",
            "a fact that a later memory replaced",
        );
        conn.execute("UPDATE memory_items SET is_enabled = 0 WHERE id = 'm2'", [])
            .unwrap();
        conn.execute(
            "UPDATE memory_items SET superseded_by = 'm1' WHERE id = 'm3'",
            [],
        )
        .unwrap();
    }
    let written = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap();
    assert_eq!(written, 1);

    let conn = pool.get().unwrap();
    let ids: Vec<String> = conn
        .prepare("SELECT owner_id FROM memory_embeddings")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(ids, vec!["m1".to_string()]);
}

/// A dimension mismatch is an error naming both numbers, not a truncated
/// vector written anyway. A short vector compared against a long one gives a
/// confident wrong score, which is worse than no semantic recall at all.
#[tokio::test]
async fn fill_index_refuses_vectors_of_the_wrong_dimension() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "m1",
            "user_pref",
            "Build",
            "builds with npm run build and then vite build",
        );
    }
    let err = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 5,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap_err();

    assert!(
        err.contains('5'),
        "error should name the returned dim: {}",
        err
    );
    assert!(
        err.contains('3'),
        "error should name the index dim: {}",
        err
    );
    let conn = pool.get().unwrap();
    let stored: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, 0, "a bad vector must not be written");
}

/// A provider that returns the wrong number of vectors is refused. Pairing
/// vectors with the wrong rows would corrupt the index in a way nothing
/// downstream can detect.
#[tokio::test]
async fn fill_index_refuses_a_mismatched_vector_count() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "m1",
            "user_pref",
            "Build",
            "builds with npm run build and then vite build",
        );
        add_memory_full(
            &conn,
            "m2",
            "user_pref",
            "Test",
            "tests run with npm run test and vitest run",
        );
    }
    let err = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: Some(1),
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap_err();

    assert!(
        err.contains('1'),
        "error should name what came back: {}",
        err
    );
    assert!(
        err.contains('2'),
        "error should name what was asked: {}",
        err
    );
}

/// Running twice writes nothing the second time. The fill must be
/// idempotent, or a scheduled pass would re-embed the whole index on every
/// tick and spend a model's time to reproduce rows it already has.
#[tokio::test]
async fn fill_index_is_idempotent() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "m1",
            "user_pref",
            "Build",
            "builds with npm run build and then vite build",
        );
    }
    let first = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap();
    let second = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap();

    assert_eq!(first, 1);
    assert_eq!(second, 0, "a second fill re-embedded a row it already had");
}

/// Content whose embeddable text is shorter than `MIN_CONTENT_LENGTH` is not
/// embedded. A one-token fragment is cheaper to match lexically than to
/// embed, and every vector it adds is a vector a real memory has to compete
/// with. The floor measures title plus content, so the `short` row below is
/// excluded only because it is tiny in both.
#[tokio::test]
async fn fill_index_skips_content_too_short_to_be_worth_embedding() {
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(&conn, "short", "user_pref", "", "hi");
        add_memory_full(
            &conn,
            "long",
            "user_pref",
            "Build",
            "builds with npm run build and then vite build",
        );
    }
    let written = index::fill_index(
        &pool,
        &StubEmbedder {
            dim: 3,
            per_input: None,
        },
        "e",
        3,
        false,
    )
    .await
    .unwrap();
    assert_eq!(written, 1, "only the long row is worth a vector");

    let conn = pool.get().unwrap();
    let ids: Vec<String> = conn
        .prepare("SELECT owner_id FROM memory_embeddings")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(ids, vec!["long".to_string()]);
}

/// Reinforcement must never lower a memory's confidence.
///
/// The averaging rule exists so a repeated guess cannot ratchet itself
/// upward: 0.5 + 0.9 lands on 0.7, not 0.9. But the average is symmetric,
/// and the downward direction is the harmful one. A candidate at 0.2
/// confidence is one the system would never auto-*write* anywhere — it
/// falls below every gate — yet in the reinforce band it can drag a
/// confident memory toward 0.2, one restatement at a time, with no review
/// and nothing in the log.
///
/// Being seen again is not evidence that a memory is less reliable. The
/// fix is to move toward the observation only when the observation is
/// stronger than what is stored, and to leave the stored value alone
/// otherwise. That keeps the anti-ratchet property (an average never
/// exceeds its larger input) and drops the degradation.
#[test]
fn reinforcement_does_not_lower_confidence() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, confidence, access_count)
         VALUES ('m1','user_pref','Build','prefers dark mode',1,0.9,0)",
        [],
    )
    .unwrap();

    // A weak restatement of the same fact, in the reinforce band.
    let weak = fact("prefers dark mode", 0.2);
    let decision = revise::decide(&weak, Some(0.80), None);
    assert_eq!(decision.action, RevisionAction::Reinforce);

    let applied = decision
        .apply(
            &conn,
            "",
            &weak,
            Some(&Nearest {
                row: row_named(&conn, "m1"),
                score: 0.80,
            }),
            None,
        )
        .unwrap();
    assert!(matches!(applied, revise::Applied::Reinforced { .. }));

    let stored: f64 = conn
        .query_row(
            "SELECT confidence FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        (stored - 0.9).abs() < 1e-9,
        "a 0.2 restatement dragged a 0.9 memory down to {}",
        stored
    );
}

/// The exact JSON each `Applied` variant serializes to.
///
/// `Applied` crosses the IPC boundary and `api.ts` narrows it in a
/// discriminated union on `effect`, so a rename on either side silently
/// breaks the type check on the frontend: the call still succeeds, it just
/// stops matching any branch. The TypeScript compiler cannot catch it,
/// because both sides are independently well-typed. Only this test can.
///
/// The value here is that the expected strings are written out in full
/// rather than derived from the enum, so a serde attribute change shows up
/// as a diff instead of being silently absorbed.
#[test]
fn applied_serializes_to_the_shape_the_frontend_narrows_on() {
    let cases: Vec<(revise::Applied, &str)> = vec![
        (
            revise::Applied::Added { id: "m1".into() },
            r#"{"effect":"added","id":"m1"}"#,
        ),
        (
            revise::Applied::Reinforced {
                id: "m1".into(),
                confidence: 0.75,
            },
            r#"{"effect":"reinforced","id":"m1","confidence":0.75}"#,
        ),
        (
            revise::Applied::Superseded {
                new_id: "m2".into(),
                old_id: "m1".into(),
            },
            r#"{"effect":"superseded","newId":"m2","oldId":"m1"}"#,
        ),
        (
            revise::Applied::Merged { id: "m1".into() },
            r#"{"effect":"merged","id":"m1"}"#,
        ),
        (
            revise::Applied::SentToReview {
                review_id: "r1".into(),
            },
            r#"{"effect":"sentToReview","reviewId":"r1"}"#,
        ),
    ];
    for (value, expected) in cases {
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, expected, "frontend union no longer matches");
    }
}

#[test]
fn pinning_a_note_is_visible_to_the_reader() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    notes::set_pinned(&conn, "n1", true).unwrap();
    let pinned: i64 = conn
        .query_row("SELECT pinned FROM notes WHERE id = 'n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pinned, 1);
    // Unpinning is the same path, not a separate command.
    notes::set_pinned(&conn, "n1", false).unwrap();
    let pinned: i64 = conn
        .query_row("SELECT pinned FROM notes WHERE id = 'n1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pinned, 0);
}

/// Reverse provenance is derived from `memory_items.source_note_id`, so it
/// cannot drift from the memory rows. A superseded memory is still listed
/// — the note produced it and the history stays readable.
#[test]
fn a_note_lists_the_memories_it_produced_including_superseded_ones() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, source_note_id)
         VALUES ('m1','skill','Build','npm run build',1,'n1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, source_note_id, superseded_by)
         VALUES ('m2','skill','Old','npm run build:dev',0,'n1','m1')",
        [],
    )
    .unwrap();

    let links = notes::memories_for_note(&conn, "n1").unwrap();
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(|l| l.id == "m1" && l.is_enabled));
    let m2 = links.iter().find(|l| l.id == "m2").unwrap();
    assert_eq!(m2.superseded_by.as_deref(), Some("m1"));
}

/// Unlinking clears the memory's `source_note_id` and touches nothing on
/// the note. With provenance derived rather than stored, there is no second
/// copy to keep in sync, which is the whole reason for the query in the
/// previous test.
#[test]
fn unlinking_a_memory_removes_it_from_its_notes_list() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, source_note_id)
         VALUES ('m1','skill','Build','npm run build',1,'n1')",
        [],
    )
    .unwrap();
    assert_eq!(notes::memories_for_note(&conn, "n1").unwrap().len(), 1);

    notes::unlink(&conn, "n1", "m1").unwrap();
    assert!(notes::memories_for_note(&conn, "n1").unwrap().is_empty());

    // The memory itself survives: unlinking is a claim about origin, not a
    // delete, and the row is still reachable and still recallable.
    let content: String = conn
        .query_row(
            "SELECT content FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "npm run build");
}

/// A note with no memories lists an empty vec, not an error. Every note
/// starts life with none.
#[test]
fn a_note_with_no_memories_lists_no_links() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Empty','x')",
        [],
    )
    .unwrap();
    assert!(notes::memories_for_note(&conn, "n1").unwrap().is_empty());
}

/// The write half of the link, and the reason a round of extraction can
/// populate provenance at all. `notes::memories_for_note` is the read the
/// Notes tab draws its "linked memories" section from, so linking through
/// the column and reading back through the query is the only version of
/// this test that proves the UI works.
#[test]
fn linking_a_memory_to_a_note_shows_it_in_the_notes_linked_memories() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled)
         VALUES ('m1','skill','Build','npm run build',1)",
        [],
    )
    .unwrap();

    memory::set_source_note(&conn, "n1", "m1").unwrap();

    let links = notes::memories_for_note(&conn, "n1").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].id, "m1");
    let source: Option<String> = conn
        .query_row(
            "SELECT source_note_id FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source.as_deref(), Some("n1"));
    // And the title projection the Memory tab resolves its "from note" chip
    // with, which was fetching nothing while nothing wrote the column.
    let titles = notes::all_note_titles(&conn).unwrap();
    assert_eq!(titles[0].memory_ids, ["m1"]);
}

/// `source_note_id` was added by `ALTER TABLE`, so it carries no foreign key
/// to `notes`. An `UPDATE` naming a note that was never written would report
/// one changed row and leave a dangling id the Notes tab can never resolve —
/// a claim about origin that resolves to nothing. It is an error instead.
#[test]
fn linking_a_memory_to_a_note_that_does_not_exist_is_an_error() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled)
         VALUES ('m1','skill','Build','npm run build',1)",
        [],
    )
    .unwrap();

    let err = memory::set_source_note(&conn, "nope", "m1").unwrap_err();
    assert!(err.contains("nope"), "the error names the note: {err}");
    let source: Option<String> = conn
        .query_row(
            "SELECT source_note_id FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, None, "the failed link wrote nothing");
}

/// The other half: a memory that is not there is equally a failed claim, and
/// `UPDATE` reporting zero rows is how a link looks recorded when it was
/// not.
#[test]
fn linking_a_memory_that_does_not_exist_is_an_error() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();

    let err = memory::set_source_note(&conn, "n1", "nope").unwrap_err();
    assert!(err.contains("nope"), "the error names the memory: {err}");
}

/// Unlinking has to keep working once linking is possible, and it has to
/// clear the column rather than leave a second copy of the claim behind.
/// Before extraction wrote `source_note_id`, this path was unreachable in
/// practice — there was nothing to unlink.
#[test]
fn a_link_can_be_undone_by_unlinking_it() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled)
         VALUES ('m1','skill','Build','npm run build',1)",
        [],
    )
    .unwrap();
    memory::set_source_note(&conn, "n1", "m1").unwrap();
    assert_eq!(notes::memories_for_note(&conn, "n1").unwrap().len(), 1);

    notes::unlink(&conn, "n1", "m1").unwrap();

    assert!(notes::memories_for_note(&conn, "n1").unwrap().is_empty());
    let source: Option<String> = conn
        .query_row(
            "SELECT source_note_id FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, None, "the memory's source note is NULL again");
    // The memory itself is untouched: unlinking is a claim about origin, not
    // a delete.
    let content: String = conn
        .query_row(
            "SELECT content FROM memory_items WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "npm run build");
}

/// Both note readers read `pinned` positionally, so a column dropped or
/// reordered in either SELECT would leave the pin unreadable — or, worse,
/// readable from the wrong column. Pin it through the write path and read it
/// back through both.
#[test]
fn a_pinned_note_reads_back_pinned_from_both_readers() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    notes::set_pinned(&conn, "n1", true).unwrap();

    let listed = notes::all_note_summaries(&conn).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].pinned);

    let found = notes::search(&conn, "runbook").unwrap();
    assert_eq!(found.len(), 1);
    assert!(found[0].pinned);
}

/// A note with no title is the case that catches a shift between the
/// nullable `title` and the `NOT NULL` `body`: swapped, `title` would hold
/// the body text and `body` would fail to read at all.
#[test]
fn a_note_without_a_title_still_reads_its_body() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1', NULL, 'untitled body')",
        [],
    )
    .unwrap();

    let listed = notes::all_note_summaries(&conn).unwrap();
    assert_eq!(listed[0].title, None);
    assert_eq!(listed[0].preview, "untitled body");
    assert_eq!(
        notes::note_by_id(&conn, "n1").unwrap().body,
        "untitled body"
    );

    let found = notes::search(&conn, "untitled").unwrap();
    assert_eq!(found[0].title, None);
    assert_eq!(found[0].preview, "untitled body");
}

/// `created_at` and `updated_at` are adjacent in the SELECT and both are
/// strings, so nothing but a distinct pair catches them trading places. An
/// edit moves `updated_at` forward and leaves `created_at` alone.
#[test]
fn an_edited_note_reads_two_distinct_timestamps_in_order() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body, created_at, updated_at)
         VALUES ('n1','Runbook','first draft','2024-01-01T00:00:00.000Z','2024-01-02T00:00:00.000Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE notes SET body = 'second draft', updated_at = '2024-06-01T00:00:00.000Z' WHERE id = 'n1'",
        [],
    )
    .unwrap();

    for read in [
        notes::all_note_summaries(&conn).unwrap(),
        notes::search(&conn, "draft").unwrap(),
    ] {
        assert_eq!(read[0].created_at, "2024-01-01T00:00:00.000Z");
        assert_eq!(read[0].updated_at, "2024-06-01T00:00:00.000Z");
        assert!(read[0].created_at < read[0].updated_at);
        assert_eq!(read[0].preview, "second draft");
    }
    assert_eq!(
        notes::note_by_id(&conn, "n1").unwrap().body,
        "second draft",
        "the full body still comes from the one reader that carries it"
    );
}

/// `UPDATE` reports zero rows for an id that is not there. Reporting that as
/// success is how a pin looks set when it never was.
#[test]
fn pinning_a_note_that_does_not_exist_is_an_error() {
    let conn = migrated_conn();
    let err = notes::set_pinned(&conn, "nope", true).unwrap_err();
    assert!(err.contains("nope"), "error must name the id: {err}");
}

/// Same for unlinking: a memory id that matches nothing is a caller bug, and
/// `Ok(())` would read as "detached" when nothing was.
#[test]
fn unlinking_a_memory_that_does_not_exist_is_an_error() {
    let conn = migrated_conn();
    let err = notes::unlink(&conn, "n1", "nope").unwrap_err();
    assert!(err.contains("nope"), "error must name the id: {err}");
}

/// The note id is verified, not accepted. Unlinking through the wrong note
/// touches nothing: the memory stays linked to the note that really produced
/// it.
#[test]
fn unlinking_a_memory_through_the_wrong_note_changes_nothing() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step one')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n2','Other','x')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, source_note_id)
         VALUES ('m1','skill','Build','npm run build',1,'n1')",
        [],
    )
    .unwrap();

    notes::unlink(&conn, "n2", "m1").unwrap_err();
    let rows = notes::all_notes_with_links(&conn).unwrap();
    assert_eq!(
        rows.iter()
            .find(|row| row.note.id == "n1")
            .unwrap()
            .linked_memories
            .len(),
        1
    );
    assert!(rows
        .iter()
        .find(|row| row.note.id == "n2")
        .unwrap()
        .linked_memories
        .is_empty());
}

/// A memory search with no kind filter is the shape the Memory tab uses, and
/// it was an error every time: the query names three parameters and the
/// kind-less branch bound two, which SQLite rejects outright.
#[test]
fn a_memory_search_without_a_kind_filter_returns_its_hits() {
    let conn = migrated_conn();
    add_memory_full(
        &conn,
        "m1",
        "user_pref",
        "Build",
        "npm run build and then vite build",
    );

    let hits = memory::search(&conn, "vite", None, 30).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].item.id, "m1");

    // The filter still applies when it is given.
    assert!(memory::search(&conn, "vite", Some("skill"), 30)
        .unwrap()
        .is_empty());
    assert_eq!(
        memory::search(&conn, "vite", Some("user_pref"), 30)
            .unwrap()
            .len(),
        1
    );
}

/// The excerpt is built from the content, not from the tag list. `snippet`'s
/// column index is 0-based over `memory_fts (title, content, tags)`, so 2 was
/// the tags: a memory with tags got a tag list as its excerpt, and a memory
/// without them got a NULL, which failed to read as a String and took the
/// whole search result down with it.
#[test]
fn a_memory_search_excerpts_the_content_and_survives_a_memory_without_tags() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, tags)
         VALUES ('m1','user_pref','Build','npm run build and then vite build', NULL)",
        [],
    )
    .unwrap();

    let hits = memory::search(&conn, "vite", None, 30).unwrap();
    assert_eq!(hits.len(), 1, "a tagless memory could not be read back");
    assert_eq!(hits[0].item.content, "npm run build and then vite build");
    assert!(
        hits[0].snippet.contains("<mark>"),
        "excerpt: {}",
        hits[0].snippet
    );
    assert!(
        hits[0].snippet.contains("vite") && !hits[0].snippet.contains("Build"),
        "the excerpt is not the matched content: {}",
        hits[0].snippet
    );
}

/// A pinned memory is distinguishable from an unpinned one through the
/// read path, and pinning an unknown id is an error rather than a
/// silent no-op. The read path is what `pinned_rows` will scan, so a
/// query that dropped the column would leave the whole precedence tier
/// permanently empty.
#[test]
fn a_pinned_memory_reads_back_pinned_and_an_unknown_id_errors() {
    let conn = migrated_conn();
    add_memory_full(
        &conn,
        "m1",
        "user_pref",
        "Build",
        "npm run build and then vite build",
    );
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();

    // Default is unpinned.
    let pinned: i64 = conn
        .query_row("SELECT pinned FROM memory_items WHERE id = 'm1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(pinned, 0);

    memory::set_pinned(&conn, "m1", true).unwrap();
    let after: i64 = conn
        .query_row("SELECT pinned FROM memory_items WHERE id = 'm1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_ne!(after, 0, "pin did not take");

    // Unpinning is the same path, not a separate command.
    memory::set_pinned(&conn, "m1", false).unwrap();
    let after: i64 = conn
        .query_row("SELECT pinned FROM memory_items WHERE id = 'm1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(after, 0, "unpin did not take");

    // A pin on a memory that does not exist is an error, not a no-op that
    // leaves the UI showing a pin that was never set.
    let err = memory::set_pinned(&conn, "nope", true).unwrap_err();
    assert!(err.contains("nope"), "error should name the id: {}", err);
}

/// Every memory reader maps its row positionally, so a column dropped or
/// reordered in any one of the three SELECTs is either a runtime error or,
/// worse, a row read out of the wrong column. `search` is the sharpest case:
/// it appends the FTS snippet after the item columns, so the pin and the
/// snippet index have to move together. The search below also runs after a
/// pin, and every write re-fires the FTS trigger, so it proves a pin does
/// not knock the memory out of the index.
#[test]
fn a_pinned_memory_reads_back_pinned_through_every_reader() {
    let conn = migrated_conn();
    add_memory_full(
        &conn,
        "m1",
        "user_pref",
        "Build",
        "npm run build and then vite build",
    );
    memory::set_pinned(&conn, "m1", true).unwrap();

    let mut readers: Vec<Vec<MemoryItem>> = vec![
        memory::list(&conn, None).unwrap(),
        memory::enabled(&conn).unwrap(),
    ];
    let hits = memory::search(&conn, "vite", None, 30).unwrap();
    assert_eq!(hits.len(), 1, "the FTS trigger did not index the memory");
    // The snippet lives one column past the item, so a `<mark>` in it is the
    // direct proof that the pin did not shift it.
    assert!(
        hits[0].snippet.contains("<mark>"),
        "snippet column shifted: {}",
        hits[0].snippet
    );
    readers.push(hits.into_iter().map(|hit| hit.item).collect());

    for read in readers {
        assert_eq!(read.len(), 1);
        let item = &read[0];
        assert_eq!(item.id, "m1");
        assert_eq!(item.kind, "user_pref");
        assert_eq!(item.title.as_deref(), Some("Build"));
        assert_eq!(item.content, "npm run build and then vite build");
        assert_eq!(item.tags, None);
        assert!(
            item.is_enabled,
            "a row that is still enabled read as disabled"
        );
        assert!(item.pinned, "the pin did not reach the reader");
    }

    // The kind filter still filters, on both readers that take one.
    assert!(memory::list(&conn, Some("skill")).unwrap().is_empty());
    assert!(memory::search(&conn, "vite", Some("skill"), 30)
        .unwrap()
        .is_empty());
}

/// The nullable `title` sits next to the `NOT NULL` `content`, so nothing but
/// a title-less row catches the two trading places: swapped, `title` would
/// hold the content and `content` would fail to read at all.
#[test]
fn a_memory_without_a_title_still_reads_its_content() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content)
         VALUES ('m1','skill',NULL,'run the linter before every commit')",
        [],
    )
    .unwrap();
    memory::set_pinned(&conn, "m1", true).unwrap();

    let hits = memory::search(&conn, "linter", None, 30).unwrap();
    assert_eq!(hits.len(), 1);
    let readers = vec![
        memory::list(&conn, None).unwrap(),
        memory::enabled(&conn).unwrap(),
        hits.into_iter().map(|hit| hit.item).collect::<Vec<_>>(),
    ];

    for read in &readers {
        assert_eq!(read[0].title, None);
        assert_eq!(read[0].content, "run the linter before every commit");
        assert!(read[0].pinned);
    }
}

/// `created_at` and `updated_at` are adjacent in the SELECT and both are
/// strings, so nothing but a distinct pair catches them trading places. The
/// pin is the edit that separates them: it moves `updated_at` forward and
/// leaves `created_at` alone.
#[test]
fn a_pinned_memory_reads_two_distinct_timestamps_in_order() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, created_at, updated_at)
         VALUES ('m1','skill','Lint','run the linter before every commit',
                 '2024-01-01T00:00:00.000Z','2024-01-02T00:00:00.000Z')",
        [],
    )
    .unwrap();
    memory::set_pinned(&conn, "m1", true).unwrap();

    let listed = memory::list(&conn, None).unwrap();
    let enabled = memory::enabled(&conn).unwrap();
    let hits = memory::search(&conn, "linter", None, 30).unwrap();
    assert_eq!(hits.len(), 1);
    let searched = vec![hits.into_iter().next().unwrap().item];

    for read in [&listed, &enabled, &searched] {
        assert_eq!(read[0].created_at, "2024-01-01T00:00:00.000Z");
        assert_ne!(
            read[0].updated_at, "2024-01-02T00:00:00.000Z",
            "the pin should have moved updated_at forward"
        );
        assert!(read[0].updated_at > read[0].created_at);
    }
}

/// Precedence is the SQL's order, not a sort applied afterwards:
/// pinned notes, then pinned memories, then this session's notes. A
/// pinned note outranks a pinned memory because a pin is a deliberate
/// act and a memory is only a candidate.
#[test]
fn pinned_rows_come_back_in_precedence_order() {
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned, source_session_id)
         VALUES ('n_pin','Pinned','pinned note body',1,'s1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned, source_session_id)
         VALUES ('n_ses','Session','session note body',0,'s1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled)
         VALUES ('m_pin','skill','Build','npm run build',1)",
        [],
    )
    .unwrap();
    // Through the write path rather than the column, so this proves the pin
    // the app actually sets is the pin the query reads.
    memory::set_pinned(&conn, "m_pin", true).unwrap();

    let rows = context::pinned_rows(&conn, Some("s1")).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.owner_id.as_str()).collect();
    assert_eq!(ids, vec!["n_pin", "m_pin", "n_ses"]);
}

/// Each group is labelled by where it came from, not by kind: the rendered
/// heading comes from this string, and a snapshot downstream pins it. The
/// text carries the title as well as the body, in the same shape the index
/// embeds, so a row whose vector included the title does not reach the
/// model without it.
#[test]
fn pinned_rows_are_labelled_by_the_group_they_come_from() {
    let conn = migrated_conn();
    conn.execute("INSERT INTO sessions (id, title) VALUES ('s1','S')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned, source_session_id)
         VALUES ('n_pin','Pinned','pinned note body',1,'s1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes (id, title, body, pinned, source_session_id)
         VALUES ('n_ses',NULL,'session note body',0,'s1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled)
         VALUES ('m_pin','skill','Build','npm run build',1)",
        [],
    )
    .unwrap();
    memory::set_pinned(&conn, "m_pin", true).unwrap();

    let rows = context::pinned_rows(&conn, Some("s1")).unwrap();
    let by_id: std::collections::HashMap<&str, &context::ContextRow> =
        rows.iter().map(|r| (r.owner_id.as_str(), r)).collect();

    assert_eq!(by_id["n_pin"].label, "Notes");
    assert_eq!(by_id["n_pin"].text, "Pinned\n\npinned note body");
    assert_eq!(by_id["n_pin"].owner_type, "note");

    assert_eq!(by_id["m_pin"].label, "Pinned memories");
    assert_eq!(by_id["m_pin"].text, "Build\n\nnpm run build");
    assert_eq!(by_id["m_pin"].owner_type, "memory");

    assert_eq!(by_id["n_ses"].label, "Notes from this session");
    // An untitled note contributes only its body: an empty heading would be
    // a title the user never wrote.
    assert_eq!(by_id["n_ses"].text, "session note body");
}

/// A pin the user has since switched off, and a fact a newer memory has
/// replaced, must not reach the prompt through a query that never asks
/// whether the row is still true. The session filter is the other half:
/// one session's notes are not another's context, and a call with no
/// session has no session's notes to read.
#[test]
fn a_pinned_memory_that_is_off_or_replaced_is_not_injected() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO sessions (id, title) VALUES ('s1','One'),('s2','Two')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_items (id, kind, content, is_enabled, pinned)
         VALUES ('m_on','skill','still true',1,1),
                ('m_off','skill','switched off',0,1),
                ('m_gone','skill','replaced',1,1),
                ('m_plain','skill','never pinned',1,0)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE memory_items SET superseded_by = 'm_on' WHERE id = 'm_gone'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes (id, body, pinned, source_session_id)
         VALUES ('n_pin','pinned',1,NULL),
                ('n_s1','mine',0,'s1'),
                ('n_s2','someone else''s',0,'s2')",
        [],
    )
    .unwrap();

    let mine: Vec<String> = context::pinned_rows(&conn, Some("s1"))
        .unwrap()
        .into_iter()
        .map(|r| r.owner_id)
        .collect();
    assert_eq!(
        mine,
        vec!["n_pin".to_string(), "m_on".to_string(), "n_s1".to_string()],
        "the off, replaced and unpinned memories, and the other session's note, are all absent"
    );

    let background: Vec<String> = context::pinned_rows(&conn, None)
        .unwrap()
        .into_iter()
        .map(|r| r.owner_id)
        .collect();
    assert_eq!(background, vec!["n_pin".to_string(), "m_on".to_string()]);
}

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------
//
// These reach the database, so they live here rather than in
// `context_tests.rs`. What they protect is not a return value but an effect
// that another turn reads: the boost in `retrieve::boost` consumes
// `access_count`, and a reinforcement that silently never fires looks
// exactly like one that works until someone checks the numbers.

/// A recall that was actually injected bumps the counter the next turn's
/// boost reads. If this never fires, the boost is fed only by seeded
/// data and the feedback loop is open in one direction.
#[test]
fn injecting_a_memory_bumps_its_access_count() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO memory_items (id, kind, title, content, is_enabled, access_count)
         VALUES ('m1','user_pref','Build','npm run build',1,0)",
        [],
    )
    .unwrap();
    let row = context::ContextRow {
        owner_type: "memory".into(),
        owner_id: "m1".into(),
        label: "User preferences".into(),
        text: "npm run build".into(),
        reason: None,
    };
    context::record_injection(&conn, &row, Some("s1")).unwrap();
    context::record_injection(&conn, &row, Some("s1")).unwrap();
    let (count, events): (i64, i64) = conn
        .query_row(
            "SELECT (SELECT access_count FROM memory_items WHERE id = 'm1'),
                    (SELECT COUNT(*) FROM memory_events WHERE owner_id = 'm1' AND event = 'recall')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(events, 2);
}

/// A note has no `access_count` column, so the event log is the only
/// record. It must not error trying to update a column that is not there.
#[test]
fn injecting_a_note_logs_the_recall_without_touching_a_counter() {
    let conn = migrated_conn();
    conn.execute(
        "INSERT INTO notes (id, title, body) VALUES ('n1','Runbook','step')",
        [],
    )
    .unwrap();
    let row = context::ContextRow {
        owner_type: "note".into(),
        owner_id: "n1".into(),
        label: "Notes".into(),
        text: "step".into(),
        reason: None,
    };
    context::record_injection(&conn, &row, Some("s1")).unwrap();
    let events: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_events WHERE owner_id = 'n1' AND event = 'recall'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(events, 1);
}

// ---------------------------------------------------------------------------
// Revision without an embedding index
// ---------------------------------------------------------------------------

/// The shortlist judge reply must be a number in range and a verdict. A
/// verdict with no number is not an answer; a number out of range names no
/// memory; either way the caller adds rather than rewriting.
#[test]
fn the_shortlist_reply_needs_a_number_and_a_verdict() {
    use revise::{parse_shortlist_reply, Verdict};
    assert_eq!(
        parse_shortlist_reply("1 CONTRADICTS", 3),
        Some((0, Verdict::Contradicts))
    );
    assert_eq!(
        parse_shortlist_reply("2 complements.", 3),
        Some((1, Verdict::Complements))
    );
    assert_eq!(
        parse_shortlist_reply("3 identical", 3),
        Some((2, Verdict::Identical))
    );
    assert_eq!(parse_shortlist_reply("NONE", 3), None);
    assert_eq!(parse_shortlist_reply("", 3), None);
    assert_eq!(
        parse_shortlist_reply("CONTRADICTS", 3),
        None,
        "a verdict with no number is not an answer"
    );
    assert_eq!(
        parse_shortlist_reply("9 CONTRADICTS", 3),
        None,
        "a number past the list names nothing"
    );
    assert_eq!(parse_shortlist_reply("maybe", 3), None);
}

#[test]
fn the_shortlist_is_same_kind_enabled_and_live() {
    let conn = migrated_conn();
    add_memory_full(&conn, "live", "user_pref", "A", "the live one");
    add_memory_full(&conn, "other-kind", "project_fact", "B", "a different kind");
    add_memory_full(&conn, "disabled", "user_pref", "C", "switched off");
    conn.execute(
        "UPDATE memory_items SET is_enabled = 0 WHERE id = 'disabled'",
        [],
    )
    .unwrap();
    add_memory_full(&conn, "superseded", "user_pref", "D", "replaced already");
    conn.execute(
        "UPDATE memory_items SET superseded_by = 'live' WHERE id = 'superseded'",
        [],
    )
    .unwrap();

    let items = revise::shortlist_for(&conn, &fact("anything", 0.9)).unwrap();
    let ids: Vec<&str> = items.iter().map(|row| row.owner_id.as_str()).collect();
    assert!(ids.contains(&"live"), "the live same-kind row is missing");
    assert!(!ids.contains(&"other-kind"), "a different kind leaked in");
    assert!(!ids.contains(&"disabled"), "a disabled row leaked in");
    assert!(!ids.contains(&"superseded"), "a superseded row leaked in");
}

/// The reported failure, end to end: no embedding model, the user updates
/// their nickname, and the old memory is superseded rather than left beside
/// a new one. The judge is a real HTTP round trip — `serve_once` is a real
/// loopback server, because stubbing it at the provider seam would test a
/// second implementation of the thing under test.
#[tokio::test]
async fn a_nickname_change_supersedes_the_old_nickname_without_an_embedding_model() {
    let url = crate::providers::tests::serve_once(
        "200 OK",
        "{\"message\":{\"role\":\"assistant\",\"content\":\"1 CONTRADICTS\"},\"done\":true}\n",
        "application/x-ndjson",
    )
    .await;
    let pool = migrated_pool();
    {
        let conn = pool.get().unwrap();
        add_memory_full(
            &conn,
            "old-nick",
            "user_pref",
            "User's nickname",
            "Kevin Dude Menata",
        );
        // The judge runs on the default chat provider, so one must exist and
        // point at the server that answers the verdict.
        conn.execute(
            "INSERT INTO providers (id, kind, name, base_url, is_default)
             VALUES ('p1', 'ollama', 'Local', ?1, 1)",
            params![url],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO models (id, provider_id, name) VALUES ('m1', 'p1', 'llama3')",
            [],
        )
        .unwrap();
    }

    let candidate = extract::ExtractedFact {
        kind: "user_pref".into(),
        title: Some("Preferred Name".into()),
        content: "The user prefers to be called John.".into(),
        tags: None,
        confidence: 0.95,
        is_note: false,
        note_body: None,
    };

    let applied = revise::apply_candidate(&pool, "s1", &candidate)
        .await
        .unwrap();
    let new_id = match applied {
        Applied::Superseded { new_id, old_id } => {
            assert_eq!(old_id, "old-nick", "the wrong memory was replaced");
            new_id
        }
        other => panic!("expected a supersede, got {other:?}"),
    };

    let conn = pool.get().unwrap();
    let superseded: Option<String> = conn
        .query_row(
            "SELECT superseded_by FROM memory_items WHERE id = 'old-nick'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(superseded.as_deref(), Some(new_id.as_str()));
    let live: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_items
             WHERE superseded_by IS NULL AND content LIKE '%John%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(live, 1, "the replacement must be the only live nickname");
}

// ---------------------------------------------------------------------------
// The extractor stops making entities out of the user's own attributes
// ---------------------------------------------------------------------------

#[test]
fn an_entity_for_the_users_own_name_is_dropped() {
    for raw in [
        r#"[{"kind":"entity","title":"Alias","content":"john","confidence":0.9}]"#,
        r#"[{"kind":"entity","title":"Name","content":"Kevin Dude Menata","confidence":0.9}]"#,
        r#"[{"kind":"entity","title":"Nickname","content":"Kevin","confidence":0.9}]"#,
    ] {
        assert!(
            extract::parse_candidates(raw).unwrap().is_empty(),
            "a self-attribute entity survived: {raw}"
        );
    }
}

#[test]
fn a_real_entity_is_kept() {
    let raw =
        r#"[{"kind":"entity","title":"Sarah","content":"owns the auth service","confidence":0.9}]"#;
    let facts = extract::parse_candidates(raw).unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, "entity");
    assert_eq!(facts[0].content, "owns the auth service");
}

#[test]
fn a_superseded_memory_reads_back_with_its_replacement_through_every_reader() {
    let conn = migrated_conn();
    add_memory_full(
        &conn,
        "old-m",
        "project_fact",
        "Deploy window",
        "Ships land any time on Fridays.",
    );
    add_memory_full(
        &conn,
        "new-m",
        "project_fact",
        "Friday deploy window",
        "Ships land after 2pm on Fridays.",
    );
    conn.execute(
        "UPDATE memory_items SET superseded_by = 'new-m' WHERE id = 'old-m'",
        [],
    )
    .unwrap();

    for items in [
        memory::list(&conn, None).unwrap(),
        memory::list(&conn, Some("project_fact")).unwrap(),
        memory::enabled(&conn).unwrap(),
        memory::search(&conn, "Fridays", None, 30)
            .unwrap()
            .into_iter()
            .map(|hit| hit.item)
            .collect(),
    ] {
        let old = items.iter().find(|m| m.id == "old-m").expect("old row");
        let new = items.iter().find(|m| m.id == "new-m").expect("new row");
        assert_eq!(old.superseded_by.as_deref(), Some("new-m"));
        assert_eq!(new.superseded_by, None);
    }
}

use rusqlite::{params, Connection};

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
    assert_eq!(config::CONTEXT_BUDGET_FRACTION, 0.15);
    assert_eq!(config::MIN_CONTENT_LENGTH, 32);
    assert_eq!(config::EMBED_BATCH, 32);
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
    assert!((recency_weight(0.0) - 1.0).abs() < 1e-9);
    assert!(
        (recency_weight(half_life) - 0.5).abs() < 1e-9,
        "one half-life is 0.5"
    );
    // The floor is 0.5 and is reached at one half-life, not approached
    // asymptotically. A durable fact should not keep losing relevance
    // purely for being old — that is the "the app forgot" failure mode.
    // Age breaks ties between comparably-relevant items; it does not
    // expire them.
    assert_eq!(recency_weight(half_life * 2.0), 0.5);
    assert_eq!(recency_weight(10_000.0), 0.5);
    // Monotonic non-increasing across the decay range.
    let mut previous = 1.0;
    for step in 0..=60 {
        let weight = recency_weight(step as f64);
        assert!(
            weight <= previous + f64::EPSILON,
            "not monotonic at {}",
            step
        );
        previous = weight;
    }
    // Degenerate input is treated as fresh, not as ancient.
    assert_eq!(recency_weight(-5.0), 1.0);
    assert_eq!(recency_weight(f64::NAN), 1.0);
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

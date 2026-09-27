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

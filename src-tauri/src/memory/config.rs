//! Retrieval configuration.
//!
//! Every constant the design doc pins lives here, and every one of them is
//! overridable from the `settings` table. They are contract, not
//! implementation detail: changing `RRF_K` or `DUP_FLOOR` changes what
//! every existing user gets back from recall.
//!
//! Every reader degrades to its default on a missing or malformed value.
//! Tuning is an optimisation. A hand-edited settings row must never be the
//! reason recall fails or a send errors.

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;

/// Reciprocal Rank Fusion constant. 60 is the value Cormack et al. use and
/// the one the design doc pins.
pub const RRF_K: f64 = 60.0;

/// Candidates pulled from each retrieval route before fusion. Two routes
/// (BM25, cosine) at 30 each gives RRF enough depth to fuse without
/// letting a single route dominate.
pub const BM25_LIMIT: usize = 30;
pub const COSINE_LIMIT: usize = 30;

/// How many items reach the prompt by default. Was hardcoded to 3 in the
/// browser-side substring scorer this replaces.
pub const TOP_K_DEFAULT: i64 = 6;

/// Cosine below which an extracted fact is new enough to ADD rather than
/// reinforce what already exists.
pub const REINFORCE_FLOOR: f64 = 0.72;

/// Cosine above which two memories are close enough that the revision
/// judge is consulted (IDENTICAL / CONTRADICTS / COMPLEMENTS).
pub const DUP_FLOOR: f64 = 0.92;

/// Days for `updated_at`'s contribution to halve. A multiplier in
/// [0.5, 1.0], not a filter: old-but-relevant still surfaces.
pub const RECENCY_HALF_LIFE_DAYS: f64 = 30.0;

/// Completed exchanges between automatic extraction runs.
///
/// One, not two: a first exchange never qualified under the old fixed value
/// of two — a fresh chat that says "remember my cat is named Mao Mao" and
/// gets its answer produces two messages, below the four-message threshold,
/// and nothing was extracted or even recorded. The window is the cost
/// control; `memory.auto_extract` is the off switch.
pub const EXTRACT_EVERY_N_EXCHANGES: i64 = 1;

/// Share of the model's context window the memory block may occupy.
pub const CONTEXT_BUDGET_FRACTION: f64 = 0.15;

/// The context window assumed for a model whose real one is not known.
///
/// A constant and not a setting, because there is nothing to configure: the
/// value is a judgement about what to assume when the truth is unavailable,
/// and a user has no better answer than the smallest case. 4096 is the
/// smallest window a local model is likely to have, which makes it the
/// assumption that *breaks first* rather than the one that breaks loudest.
/// An unlimited budget here is how memory eats a whole context window and
/// takes the conversation with it.
///
/// Lives beside [`CONTEXT_BUDGET_FRACTION`] because it is only ever used
/// with it: the fallback row budget is this times that fraction, so the two
/// numbers are a single decision split across two constants.
pub const FALLBACK_CONTEXT_LENGTH: u32 = 4096;

/// Shorter content is not worth a vector: it is noise in a cosine
/// neighbourhood and a waste of an embedding call.
///
/// The floor is measured against the *embeddable text* (title plus content,
/// see `index::embeddable_text`), not the content alone. A memory whose
/// content is a single word but whose title names it — `User's nickname` /
/// `Kevin`, `Birthday` / `February 18th` — is worth a vector and was
/// excluded by the old content-only, 32-character gate. Eight is short
/// enough to admit those and long enough to drop a one-token fragment.
pub const MIN_CONTENT_LENGTH: usize = 8;

/// How many texts to send in one embed request.
pub const EMBED_BATCH: usize = 32;

/// A provider and model pair serving one capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRoute {
    pub provider_id: String,
    pub model: String,
}

/// Which model serves which job. `None` means "use the session's own
/// model", which is the correct default for chat and extraction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelRouting {
    pub chat: Option<ModelRoute>,
    pub extraction: Option<ModelRoute>,
    pub embedding: Option<ModelRoute>,
}

/// The raw shape of a `memory.routing` row, kept as untyped values.
///
/// Deliberately not a typed struct. A typed `RoutingRow` fails as a unit,
/// so one mistyped field — `{"chat":{...},"embedding":{"provider_id":1}}` —
/// would discard the two capabilities the user did configure. Parsing each
/// capability independently means a bad field costs only its own
/// capability.
type RoutingRow = serde_json::Map<String, serde_json::Value>;

/// Read one capability out of a routing row, treating a malformed or
/// half-typed entry as "not configured".
fn route_from(row: &RoutingRow, capability: &str) -> Option<ModelRoute> {
    let value = row.get(capability)?;
    let parsed: RouteRow = serde_json::from_value(value.clone()).ok()?;
    parsed.into_route()
}

#[derive(Deserialize)]
struct RouteRow {
    provider_id: String,
    model: String,
}

impl RouteRow {
    /// A route with a blank provider or model is not configured. Silently
    /// completing a half-typed row would send a request to a model that
    /// does not exist.
    fn into_route(self) -> Option<ModelRoute> {
        let provider_id = self.provider_id.trim().to_string();
        let model = self.model.trim().to_string();
        if provider_id.is_empty() || model.is_empty() {
            return None;
        }
        Some(ModelRoute { provider_id, model })
    }
}

/// Read one settings row. Absent or non-string values read as absent.
fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

/// Parse a settings row as f64, treating a parse failure as absent.
fn setting_f64(conn: &Connection, key: &str) -> Option<f64> {
    setting(conn, key).and_then(|v| v.trim().parse::<f64>().ok())
}

/// Which model serves which job, read from the single `memory.routing`
/// row: `{"chat":{"provider_id":..,"model":..}, ...}`.
///
/// A malformed row, or a malformed single capability inside a valid row,
/// yields `None` for that capability only. The whole row is never
/// discarded, because one mistyped field should not cost a user the two
/// capabilities they did configure.
pub fn load_routing(conn: &Connection) -> ModelRouting {
    let raw = match setting(conn, "memory.routing") {
        Some(raw) => raw,
        None => return ModelRouting::default(),
    };
    let row: RoutingRow = match serde_json::from_str(&raw) {
        Ok(row) => row,
        Err(err) => {
            tracing::warn!("memory.routing is not valid JSON, ignoring: {}", err);
            return ModelRouting::default();
        }
    };
    ModelRouting {
        chat: route_from(&row, "chat"),
        extraction: route_from(&row, "extraction"),
        embedding: route_from(&row, "embedding"),
    }
}

/// Effective `top_k`. Rejects anything below 1, because `top_k = 0` would
/// silently disable recall and look like the feature was broken.
pub fn top_k(conn: &Connection) -> i64 {
    match setting(conn, "memory.top_k").and_then(|v| v.trim().parse::<i64>().ok()) {
        Some(n) if n >= 1 => n,
        _ => TOP_K_DEFAULT,
    }
}

/// Effective context budget fraction. A value of 0 would inject no memory
/// at all, so out-of-range values fall back to the default rather than
/// clamping: a user who typed `2.0` most likely dropped a decimal point
/// and meant `0.2`, and honouring the literal value would let memory
/// consume the entire context window and break the conversation.
pub fn context_budget_fraction(conn: &Connection) -> f64 {
    match setting_f64(conn, "memory.context_budget_fraction") {
        Some(f) if f.is_finite() && f > 0.0 && f <= 1.0 => f,
        _ => CONTEXT_BUDGET_FRACTION,
    }
}

/// Whether automatic extraction after a turn is enabled. Default on.
/// Only an explicit "false" turns it off, so an unrecognised value does
/// not quietly stop the user accumulating memory.
pub fn auto_extract(conn: &Connection) -> bool {
    match setting(conn, "memory.auto_extract") {
        Some(v) => !v.trim().eq_ignore_ascii_case("false"),
        None => true,
    }
}

/// Whether every note should be embedded, or only pinned ones. Default
/// off: a large long-form note library is expensive to embed and mostly
/// not what a chat query is reaching for.
pub fn embed_all_notes(conn: &Connection) -> bool {
    match setting(conn, "memory.embed_all_notes") {
        Some(v) => v.trim().eq_ignore_ascii_case("true"),
        None => false,
    }
}

/// Effective recency half-life, in days.
///
/// A zero or negative value would make `0.5^(age / 0)` meaningless, so
/// those fall back to the default. A very large value is honoured rather
/// than capped: it means "stop discounting old items", which is a
/// preference, not a typo — the multiplier is clamped to [0.5, 1.0]
/// downstream either way.
pub fn recency_half_life_days(conn: &Connection) -> f64 {
    match setting_f64(conn, "memory.recency_half_life_days") {
        Some(days) if days.is_finite() && days > 0.0 => days,
        _ => RECENCY_HALF_LIFE_DAYS,
    }
}

/// Effective extraction interval, in completed exchanges.
///
/// Rejects anything below 1: `0` would mean "never extract", which the user
/// has an explicit switch for (`memory.auto_extract`), and a silent no-op
/// interval would look like extraction was broken.
pub fn extract_every_n_exchanges(conn: &Connection) -> i64 {
    match setting(conn, "memory.extract_every_n_exchanges")
        .and_then(|v| v.trim().parse::<i64>().ok())
    {
        Some(n) if n >= 1 => n,
        _ => EXTRACT_EVERY_N_EXCHANGES,
    }
}

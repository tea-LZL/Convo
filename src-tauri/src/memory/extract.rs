//! Extraction: what to send the model, and when to send it.
//!
//! The parser that lives here was moved out of `commands/memory.rs`
//! unchanged in substance. Its fourteen alias fields and its think-block
//! recovery are not over-engineering: they encode observed failures of
//! real local models, and every one of them is a test in
//! `commands/memory.rs`. What changed here is the target shape — the six
//! kinds, an explicit `confidence`, and the `is_note` flag that lets the
//! agent write a note instead of a one-line memory.

use serde::{Deserialize, Serialize};

/// A candidate fact, as the parser produces it.
///
/// `confidence` defaults to 0.5 when the model omits it. A model that did
/// not say is not confident, and defaulting high would let every
/// legacy-shaped response past the 0.80 auto-write gate.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ExtractedFact {
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    pub tags: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// Long-form or structured: this candidate becomes a note, not a
    /// memory. That is how the agent writes notes during a session.
    #[serde(default)]
    pub is_note: bool,
    #[serde(default)]
    pub note_body: Option<String>,
}

fn default_confidence() -> f64 {
    0.5
}

#[derive(Debug, Deserialize)]
struct ExtractedFactCandidate {
    kind: Option<String>,
    #[serde(rename = "type")]
    legacy_kind: Option<String>,
    category: Option<String>,
    #[serde(rename = "fact_type")]
    fact_type: Option<String>,
    title: Option<String>,
    fact: Option<String>,
    detail: Option<String>,
    content: Option<String>,
    value: Option<String>,
    details: Option<String>,
    context: Option<String>,
    notes: Option<String>,
    tags: Option<serde_json::Value>,
    labels: Option<serde_json::Value>,
    /// `null`, a number, or a string. Anything unparseable becomes the
    /// default rather than a hard failure, because a model that garbles
    /// one field has still told us the fact.
    confidence: Option<serde_json::Value>,
    #[serde(alias = "isNote")]
    is_note: Option<bool>,
    note_body: Option<String>,
}

fn normalize_fact_kind(value: &str) -> Option<&'static str> {
    // ponytail: keep compatibility explicit; unknown model schemas are ignored rather than guessed.
    match value.trim().to_ascii_lowercase().as_str() {
        "user_pref"
        | "personal_information"
        | "personal information"
        | "personal information / date"
        | "personal information/date"
        | "personal detail" => Some("user_pref"),
        "project_fact" | "project fact" => Some("project_fact"),
        "skill" | "instruction" | "reusable instruction" => Some("skill"),
        "decision" | "decisions" | "choice" => Some("decision"),
        "constraint" | "constraints" | "rule" | "policy" => Some("constraint"),
        "entity" | "entities" | "person" | "service" | "repo" => Some("entity"),
        _ => None,
    }
}

/// The six kinds. Anything outside this set is dropped rather than
/// stored, as it always was.
pub const KINDS: &[&str] = &[
    "user_pref",
    "project_fact",
    "decision",
    "constraint",
    "skill",
    "entity",
];

/// Normalize a model-supplied kind to one of [`KINDS`], or `None` to drop.
pub fn normalize_kind(value: &str) -> Option<&'static str> {
    normalize_fact_kind(value)
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_tags(value: Option<serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(value)) => trimmed_optional(Some(value)),
        Some(serde_json::Value::Array(values)) => {
            let tags = values
                .into_iter()
                .filter_map(|value| value.as_str().map(|tag| tag.trim().to_string()))
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>();
            (!tags.is_empty()).then(|| tags.join(", "))
        }
        _ => None,
    }
}

fn inferred_personal_fact_kind(title: Option<&str>, content: Option<&str>) -> Option<&'static str> {
    let haystack = [title.unwrap_or(""), content.unwrap_or("")]
        .join(" ")
        .to_ascii_lowercase();
    let transient_markers = [
        "task",
        "goal",
        "draft",
        "email",
        "meeting",
        "communication",
        "request",
        "recent",
        "output",
        "event",
        "planning",
        "gathering",
        "invitation",
        "template",
        "setting up",
    ];
    if transient_markers
        .iter()
        .any(|marker| haystack.contains(marker))
    {
        return None;
    }

    let durable_markers = [
        "birthday",
        "birth date",
        "nickname",
        "user name",
        "username",
        "preferred",
        "preference",
        "prefers",
        "likes",
        "dislikes",
        "timezone",
        "time zone",
        "location",
        "city",
        "country",
        "occupation",
        "pronoun",
        "language",
    ];
    durable_markers
        .iter()
        .any(|marker| haystack.contains(marker))
        .then_some("user_pref")
}

fn parse_json_value(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }

    // Local reasoning models commonly add <think> blocks or prose around the
    // JSON. Try the two bounded JSON spans without accepting arbitrary text.
    for (open, close) in [('[', ']'), ('{', '}')] {
        if let (Some(start), Some(end)) = (trimmed.find(open), trimmed.rfind(close)) {
            if start < end {
                if let Ok(value) = serde_json::from_str(&trimmed[start..=end]) {
                    return Ok(value);
                }
            }
        }
    }

    Err("Invalid extraction JSON".into())
}

pub fn parse_candidates(raw: &str) -> Result<Vec<ExtractedFact>, String> {
    let value = parse_json_value(raw)?;
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(object) => {
            ["extracted_facts", "facts", "memories", "items"]
                .into_iter()
                .find_map(|key| object.get(key).and_then(serde_json::Value::as_array))
                .map(|items| items.iter().collect())
                .or_else(|| {
                    // A single fact object is accepted only when it has an
                    // explicit fact-shaped field; arbitrary objects remain invalid.
                    object.contains_key("kind").then_some(vec![&value])
                })
                .ok_or_else(|| "Expected extracted facts to be a JSON array".to_string())?
        }
        _ => return Err("Expected extracted facts to be a JSON array".into()),
    };

    let mut facts = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        let candidate: ExtractedFactCandidate =
            serde_json::from_value(serde_json::Value::Object(object.clone()))
                .map_err(|e| format!("Invalid extracted fact object: {}", e))?;
        let explicit_kind = [
            candidate.kind.as_deref(),
            candidate.legacy_kind.as_deref(),
            candidate.category.as_deref(),
            candidate.fact_type.as_deref(),
        ]
        .into_iter()
        .flatten()
        .find_map(normalize_fact_kind);
        let title = trimmed_optional(
            candidate
                .title
                .or(candidate.fact)
                .or(candidate.detail)
                .or(candidate.fact_type),
        );
        let Some(content) = trimmed_optional(
            candidate
                .content
                .or(candidate.value)
                .or(candidate.details)
                .or(candidate.context)
                .or(candidate.notes),
        ) else {
            continue;
        };
        let kind =
            explicit_kind.or_else(|| inferred_personal_fact_kind(title.as_deref(), Some(&content)));
        let Some(kind) = kind else { continue };

        facts.push(ExtractedFact {
            kind: kind.into(),
            title,
            content,
            tags: normalize_tags(candidate.tags.or(candidate.labels)),
            confidence: parse_confidence(candidate.confidence),
            is_note: candidate.is_note.unwrap_or(false),
            note_body: trimmed_optional(candidate.note_body),
        });
    }
    Ok(facts)
}

/// Read a confidence value of any shape a model might emit, clamped to
/// `[0, 1]`. Absent, null, or unparseable means `0.5`.
fn parse_confidence(raw: Option<serde_json::Value>) -> f64 {
    let value = match raw {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
        // Some models emit "0.9" as a percent-suffixed string, or a
        // confidence band. Treat anything unrecognised as unconfident
        // rather than guessing upward.
        _ => None,
    };
    match value {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => default_confidence(),
    }
}

// --- window and watermark ---------------------------------------------------

use rusqlite::{params, Connection};

/// The window spec from the spec: 40 messages or 6000 estimated tokens,
/// whichever is smaller. A blind `LIMIT 60` is neither.
pub const MAX_WINDOW_MESSAGES: usize = 40;
pub const MAX_WINDOW_TOKENS: usize = 6000;
/// Fewer than a full exchange is not a conversation to learn from.
pub const MIN_EXTRACT_MESSAGES: usize = 2;

/// A slice of a session worth extracting from.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractionWindow {
    /// Last message id in the window. Becomes the next watermark.
    pub watermark_message_id: String,
    /// `(role, content)` pairs, oldest first.
    pub messages: Vec<(String, String)>,
}

/// Cheap token estimate. Only ever used as a window bound, so a real
/// tokenizer would cost more than it buys.
fn rough_tokens(text: &str) -> usize {
    text.len() / 4
}

/// The last message this session has already extracted through.
fn watermark(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT message_id FROM memory_watermark WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .ok()
}

/// Record how far extraction has got.
pub fn set_watermark(conn: &Connection, session_id: &str, message_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_watermark (session_id, message_id) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET message_id = excluded.message_id,
                                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![session_id, message_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Messages after the watermark, newest `MAX_WINDOW_MESSAGES` of them.
fn messages_after(
    conn: &Connection,
    session_id: &str,
    since: Option<&str>,
    limit: usize,
) -> rusqlite::Result<Vec<(String, String, String)>> {
    // Ordered newest-first so `LIMIT` keeps the most recent, then
    // reversed so the window reads oldest-first for the prompt.
    let sql = match since {
        Some(_) => {
            "
            SELECT id, role, content, seq FROM (
                SELECT id, role, content, created_at, rowid AS seq FROM messages
                WHERE session_id = ?1 AND content != ''
                  AND rowid > (SELECT rowid FROM messages WHERE id = ?2)
                ORDER BY created_at DESC, rowid DESC LIMIT ?3
            ) ORDER BY seq ASC"
        }
        None => {
            "
            SELECT id, role, content, seq FROM (
                SELECT id, role, content, created_at, rowid AS seq FROM messages
                WHERE session_id = ?1 AND content != ''
                ORDER BY created_at DESC, rowid DESC LIMIT ?2
            ) ORDER BY seq ASC"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = match since {
        Some(since) => stmt.query_map(params![session_id, since, limit as i64], row_map)?,
        None => stmt.query_map(params![session_id, limit as i64], row_map)?,
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

fn row_map(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
}

/// Whether an extraction round is worth running, and over what.
///
/// Returns `None` when there are too few new messages, or none at all
/// since the last round. `every_n` is exchanges, so the threshold is
/// `every_n * 2` messages — one user turn and one answer each.
pub fn should_extract(
    conn: &Connection,
    session_id: &str,
    every_n: i64,
) -> rusqlite::Result<Option<ExtractionWindow>> {
    let since = watermark(conn, session_id);
    let available = messages_after(conn, session_id, since.as_deref(), MAX_WINDOW_MESSAGES)?;
    if available.len() < MIN_EXTRACT_MESSAGES {
        return Ok(None);
    }
    // `every_n` of 0 or 1 means "every time there is anything new".
    let needed = if every_n <= 1 {
        MIN_EXTRACT_MESSAGES
    } else {
        (every_n as usize) * 2
    };
    if available.len() < needed {
        return Ok(None);
    }

    // Trim from the front until the token estimate fits, so the newest
    // exchange — the one that produced the facts — always survives.
    let mut messages: Vec<(String, String)> = available
        .iter()
        .map(|(_, role, content)| (role.clone(), content.clone()))
        .collect();
    loop {
        let tokens: usize = messages.iter().map(|(_, c)| rough_tokens(c)).sum();
        if tokens <= MAX_WINDOW_TOKENS || messages.len() <= MIN_EXTRACT_MESSAGES {
            break;
        }
        messages.remove(0);
    }

    // The watermark is the newest message overall, not the oldest in the
    // window: marking only what was read would re-read the trimmed part
    // on the next round. `available` is non-empty here — the minimum
    // message guard already returned.
    let watermark_message_id = available
        .last()
        .map(|(id, _, _)| id.clone())
        .unwrap_or_default();

    Ok(Some(ExtractionWindow {
        watermark_message_id,
        messages,
    }))
}

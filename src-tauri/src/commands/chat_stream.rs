use crate::commands::chat::{upsert_message_conn, MessageInput};
use crate::db::DbPool;
use crate::memory::{config, context, retrieve};
use crate::providers::types::{ChatRequest, MessageContent};
use crate::providers::{channelize, Provider};
use crate::streams::ActiveStreams;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatHistoryMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamArgs {
    pub stream_id: String,
    pub assistant_message_id: String,
    pub session_id: String,
    pub model: String,
    pub messages: Vec<ChatHistoryMessage>,
    pub system: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub num_ctx: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub stop: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Clone)]
struct ChatThinkingEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatChunkEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatDoneEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    prompt_tokens: Option<u32>,
    output_tokens: Option<u32>,
    completed_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatErrorEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    error: String,
    completed_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatCancelledEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    completed_at: String,
}

/// One assistant write, as a terminal event knows it.
///
/// A struct rather than six more positional arguments: the fields travel
/// together, and two adjacent `&str`s of the same shape — content and
/// thinking, or the snapshot and the timestamp — are exactly the pair a
/// positional call gets wrong without the compiler noticing.
struct AssistantTurn<'a> {
    message_id: &'a str,
    content: &'a str,
    thinking: &'a str,
    usage: (Option<u32>, Option<u32>),
    /// The `UsedRow` snapshot, already serialised for the message row.
    memory_used: &'a str,
    created_at: &'a str,
}

fn persist_assistant(pool: &DbPool, session_id: &str, turn: AssistantTurn<'_>) {
    if turn.content.is_empty() && turn.thinking.is_empty() {
        return;
    }
    let result = pool.get().map_err(|e| e.to_string()).and_then(|conn| {
        upsert_message_conn(
            &conn,
            &MessageInput {
                id: turn.message_id.to_string(),
                session_id: session_id.to_string(),
                role: "assistant".to_string(),
                content: turn.content.to_string(),
                thinking: (!turn.thinking.is_empty()).then(|| turn.thinking.to_string()),
                attachments_json: None,
                prompt_tokens: turn.usage.0.map(|v| v as i64),
                output_tokens: turn.usage.1.map(|v| v as i64),
                memory_used: Some(turn.memory_used.to_string()),
                created_at: Some(turn.created_at.to_string()),
            },
        )
    });
    if let Err(error) = result {
        tracing::error!(
            session_id,
            message_id = turn.message_id,
            %error,
            "could not persist assistant message"
        );
    }
}

// --- Context planning --------------------------------------------------------
//
// The system prompt for a send is assembled here, in Rust, from the same
// rows every other reader of memory sees. It used to arrive pre-assembled
// from the browser, which meant the prompt that reached the model was the
// frontend's opinion of what was worth saying rather than a function of
// what was stored.
//
// Everything below degrades. Nothing in this section returns an error, and
// nothing in it can prevent a send.

/// One row that reached the model, as a send records it.
///
/// Provenance only: the body is not copied. It stays in `memory_items` /
/// `notes` where the user can edit or delete it, and a copy on every
/// assistant message would multiply what a backup carries and let a stale
/// copy disagree with the Memory tab.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsedRow {
    pub owner_type: String,
    pub owner_id: String,
    /// The heading the prompt grouped the row under — the kind, not the row.
    pub label: String,
    /// The row's own name. Without it the list says "Project facts" and
    /// cannot say which fact, and a memory deleted since the send would be
    /// unlabelable.
    pub title: Option<String>,
    /// `None` for a pinned row or a session note: it is in the block because
    /// of what it is, not because it ranked.
    pub reason: Option<String>,
}

/// What one send will use, and how much of it was memory.
///
/// `used` is the rows the model was actually shown, not the rows retrieval
/// returned: a row the budget cut was never injected, and counting it would
/// make the reinforcement signal drift toward whatever retrieval happened
/// to produce.
#[derive(Debug, Clone)]
pub struct SendPlan {
    pub system: String,
    pub used: Vec<UsedRow>,
}

/// Emitted once per send, before the first token, so the answer can carry
/// its own provenance while it streams.
#[derive(Debug, Serialize, Clone)]
struct ChatRecallEvent {
    conversation_id: String,
    stream_id: String,
    assistant_message_id: String,
    rows: Vec<UsedRow>,
}

/// The budget for a model whose context window is not known, in tokens.
///
/// The fallback window and the fraction that trims it both come from
/// `memory::config`, so every number that shapes a prompt lives in one place
/// rather than split between a command file and a config module.
pub(crate) fn default_budget() -> usize {
    (config::FALLBACK_CONTEXT_LENGTH as f64 * config::CONTEXT_BUDGET_FRACTION) as usize
}

/// The model's context window, from the cached model metadata.
///
/// `models` is keyed per provider, so two providers can both list a model
/// under one name with different windows. `MIN` rather than `MAX`, and
/// because `chat_stream_v2` hands over a model *name*: over-budgeting costs
/// some memory in the prompt, while under-budgeting is the direction that
/// cannot take the conversation down. A null or non-positive row is not a
/// window, so it is excluded rather than treated as zero.
///
/// The two ways of answering "no" are kept apart. `Ok(None)` is a model
/// that is simply not in the cache, which is the ordinary state for any
/// model whose metadata has never been refreshed, and the caller falling
/// back to a small window is correct rather than a fault. `Err` is the
/// query itself failing, and `.ok()` would have swallowed that into the
/// same `None` — leaving a message that names the model when the truth is
/// that the database could not be read, and making a degradation that costs
/// every subsequent turn its memory impossible to spot.
fn context_length_for(conn: &rusqlite::Connection, model: &str) -> Option<i64> {
    match conn.query_row(
        "SELECT MIN(context_length) FROM models WHERE name = ?1 AND context_length > 0",
        rusqlite::params![model],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        Ok(length) => length,
        Err(e) => {
            tracing::warn!("could not read the context length for {:?}: {}", model, e);
            None
        }
    }
}

/// The row budget for one model: its context window times the configured
/// fraction of it.
///
/// Only the *rows* are charged against this. The block's own preamble and
/// directive are on top, so the emitted prompt can exceed it by a fixed
/// cost — `context::assemble` reports the real number for callers that need
/// a hard ceiling.
fn budget_for(pool: &Arc<DbPool>, model: &str) -> Result<usize, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let fraction = config::context_budget_fraction(&conn);
    let length = context_length_for(&conn, model)
        .ok_or_else(|| format!("no known context length for model {:?}", model))?;
    Ok((length as f64 * fraction) as usize)
}

/// Retrieve and map to context rows.
///
/// `Err` only for a reason the caller should log; every *degradation* is
/// already a smaller result, not a failure.
async fn recall_rows(
    pool: &Arc<DbPool>,
    session_id: &str,
    query: &str,
) -> Result<Vec<context::ContextRow>, String> {
    // The connection is scoped to the reads it serves and released before
    // the embed call, because `rusqlite::Connection` is `!Send` and a
    // Tauri command's future has to be.
    let mut opts = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        retrieve::RecallOptions {
            query,
            session_id: Some(session_id),
            embedding_model: None,
            embedding_dim: None,
            // The user's recall scope. `None` — every kind — for an absent,
            // empty, or unreadable row; see `config::recall_kinds`.
            kinds: config::recall_kinds(&conn),
            // No floor of our own: `config::top_k` rejects anything below 1
            // already, and a second copy of that rule in a command file is
            // the same number in two places — one of which nobody will
            // update when the other changes.
            top_k: config::top_k(&conn) as usize,
            lambda: retrieve::DEFAULT_LAMBDA,
        }
    };

    // Same shape as `memory_recall`: the query vector is optional, and
    // every failure to get one leaves keyword recall standing alone. A
    // configured-but-broken route is not a reason to skip the search.
    let mut query_vector: Vec<f32> = Vec::new();
    if let Some((provider_id, embed_model)) = crate::commands::knowledge::embedding_route(pool) {
        match crate::commands::knowledge::embed_query(pool, &provider_id, &embed_model, query).await
        {
            Ok(vector) if !vector.is_empty() => {
                opts.embedding_model = Some(embed_model);
                opts.embedding_dim = Some(vector.len());
                query_vector = vector;
            }
            Ok(_) => tracing::warn!("the embed route returned no vector; recalling by keyword"),
            Err(e) => tracing::warn!("could not embed the query, recalling by keyword: {}", e),
        }
    }

    let conn = pool.get().map_err(|e| e.to_string())?;
    let hits = retrieve::recall_with_query_vector(&conn, &opts, &query_vector);
    Ok(hits
        .into_iter()
        // `recall` includes notes when `kinds` is unset, which is right for
        // the Memory tab and wrong here: injecting every unpinned note would
        // crowd out the memories the budget is really for. Pinned notes
        // arrive separately, from `pinned_rows`.
        .filter(|h| h.owner_type != "note")
        .map(|h| context::ContextRow {
            owner_type: h.owner_type,
            owner_id: h.owner_id,
            // The heading the prompt shows, not the stored kind. `## user_pref`
            // is not a heading, and a label this build has never seen is
            // still a fact worth telling the model about.
            label: context::label_for_kind(&h.kind),
            title: h.title.clone(),
            // Title and content together, the same shape
            // `index::embeddable_text` embeds. A row whose embedded form
            // carried the title should not reach the model without it.
            text: match h.title {
                Some(title) if !title.trim().is_empty() => {
                    format!("{}\n\n{}", title.trim(), h.content)
                }
                _ => h.content,
            },
            reason: Some(h.reason),
        })
        .collect())
}

/// Work out the system prompt for one send.
///
/// Never returns `Err`. Spec §6.4: recall must never fail a send, and
/// BM25-only is a degraded success. Every failure below degrades to a
/// smaller plan and is logged; a send that does not happen is the worst
/// outcome in this file.
///
/// Takes no embedding route: it resolves its own, exactly as
/// `memory_recall` does, because a route passed in by a caller is a route a
/// caller can get wrong.
pub async fn plan_send(
    pool: &Arc<DbPool>,
    session_id: &str,
    query: &str,
    model: &str,
    override_prompt: Option<String>,
) -> SendPlan {
    let budget = match budget_for(pool, model) {
        Ok(budget) => budget,
        Err(e) => {
            tracing::warn!("context budget unavailable, using the default: {}", e);
            default_budget()
        }
    };

    let mut recalled_rows = match recall_rows(pool, session_id, query).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("recall failed, sending without retrieved memory: {}", e);
            Vec::new()
        }
    };

    // Pinned rows are prepended, not appended: precedence is the assembler's
    // contract and the tests pin that order.
    let pinned = match pool.get() {
        Ok(conn) => match context::pinned_rows(&conn, Some(session_id)) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("pinned rows unavailable: {}", e);
                Vec::new()
            }
        },
        Err(e) => {
            tracing::warn!("pinned rows unavailable, no connection: {}", e);
            Vec::new()
        }
    };
    let mut rows = pinned;
    rows.append(&mut recalled_rows);

    let out = context::assemble(context::ContextInput {
        override_prompt,
        rows,
        budget_tokens: budget,
    });

    // Reinforcement records what was emitted, not what was retrieved: a row
    // that ranked eleventh and was cut by the budget was never shown to the
    // model and must not count as having been recalled. One pooled
    // connection for the whole loop — `record_injection` opens a
    // transaction per row and commits it, so it needs a connection with no
    // transaction already open on it, which is what this is.
    //
    // Every failure here is log-only. A reinforcement that cannot be
    // recorded costs a boost that stays flat, which the next turn can see;
    // a send that does not happen costs the user their turn.
    match pool.get() {
        Ok(conn) => {
            for row in &out.injected {
                if let Err(e) = context::record_injection(&conn, row, Some(session_id)) {
                    tracing::warn!("could not record a recall of {}: {}", row.owner_id, e);
                }
            }
        }
        Err(e) => tracing::warn!("could not record any recall, no connection: {}", e),
    }

    // `dropped` is not a budget count: it also holds rows with no text to
    // state, and an id can appear here *and* in `injected` when two
    // sources carried one fact. So the line says "left out", not
    // "over budget", and the two lists are not presented as disjoint.
    if !out.dropped.is_empty() {
        tracing::info!(
            "context assembly left out {} row(s): {}",
            out.dropped.len(),
            out.dropped.join(", ")
        );
    }
    // The true size of the emitted block, which is not bounded by
    // `budget_tokens` — the preamble and directive are on top of the rows,
    // so the two numbers are reported side by side rather than reconciled
    // into one. Clamping them here would report a number that was never
    // computed.
    tracing::debug!(
        "context: {} row(s) injected, {} left out; block is {} token(s) against a \
         {} token(s) row budget",
        out.injected.len(),
        out.dropped.len(),
        out.used_tokens,
        budget,
    );

    SendPlan {
        system: out.system_prompt,
        used: out
            .injected
            .iter()
            .map(|row| UsedRow {
                owner_type: row.owner_type.clone(),
                owner_id: row.owner_id.clone(),
                label: row.label.clone(),
                title: row.title.clone(),
                reason: row.reason.clone(),
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn chat_stream_v2(
    app: AppHandle,
    pool: State<'_, Arc<DbPool>>,
    streams: State<'_, ActiveStreams>,
    args: ChatStreamArgs,
) -> Result<(), String> {
    if args.stream_id.trim().is_empty() || args.assistant_message_id.trim().is_empty() {
        return Err("stream_id and assistant_message_id are required".into());
    }
    // Resolve provider from session -> model -> provider_id, fallback to default
    let conn = pool.get().map_err(|e| e.to_string())?;
    let provider_id: Option<String> = conn
        .query_row(
            "SELECT provider_id FROM sessions WHERE id = ?1",
            rusqlite::params![args.session_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let provider_id = provider_id.or_else(|| {
        conn.query_row(
            "SELECT id FROM providers WHERE is_default = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
    });
    let Some(provider_id) = provider_id else {
        return Err("No provider configured".into());
    };
    let (kind, base_url): (String, String) = conn
        .query_row(
            "SELECT kind, COALESCE(base_url, '') FROM providers WHERE id = ?1",
            rusqlite::params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("Provider lookup: {}", e))?;
    drop(conn);

    let api_key = crate::services::get_api_key(&provider_id);

    let provider: Box<dyn Provider> = match kind.as_str() {
        "ollama" => Box::new(crate::providers::ollama::OllamaProvider::new(
            base_url, api_key,
        )),
        "openai_compat" => Box::new(crate::providers::openai_compat::OpenAiCompatProvider::new(
            base_url, api_key,
        )),
        other => return Err(format!("Unknown provider: {}", other)),
    };

    let messages: Vec<MessageContent> = args
        .messages
        .into_iter()
        .map(|m| MessageContent {
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            images: m.images,
        })
        .collect();

    // The recall query is the last user message of this very conversation,
    // read off the messages being sent — not a separate argument. A second
    // source of truth could disagree with the message the model is about to
    // answer, and the disagreement would be invisible.
    let recall_query = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    // Assembled here rather than in the browser: the prompt is now a
    // function of what is stored, and every failure below degrades to a
    // smaller plan rather than to no send.
    let plan = plan_send(
        &pool,
        &args.session_id,
        &recall_query,
        &args.model,
        args.system,
    )
    .await;
    tracing::info!(
        session_id = %args.session_id,
        model = %args.model,
        recalled = plan.used.len(),
        "planned send"
    );

    // What this send put in front of the model, serialised once: the event
    // and the stored message must say the same thing, and a second
    // serialisation is a second chance to disagree. Emitted before the
    // first token so the answer can carry its provenance while it streams.
    let memory_used_json = serde_json::to_string(&plan.used).unwrap_or_else(|e| {
        tracing::warn!("could not serialise the recall snapshot: {}", e);
        "[]".to_string()
    });
    if !plan.used.is_empty() {
        let _ = app.emit(
            "chat-recall",
            ChatRecallEvent {
                conversation_id: args.session_id.clone(),
                stream_id: args.stream_id.clone(),
                assistant_message_id: args.assistant_message_id.clone(),
                rows: plan.used.clone(),
            },
        );
    }

    let req = ChatRequest {
        model: args.model.clone(),
        messages,
        stream: true,
        system: Some(plan.system),
        temperature: args.temperature,
        top_p: args.top_p,
        top_k: args.top_k,
        num_ctx: args.num_ctx,
        repeat_penalty: args.repeat_penalty,
        stop: args.stop,
    };

    let stream = provider.chat_stream(req).await?;
    let (rx, _handle) = channelize(stream);
    let stream_id = args.stream_id.clone();
    let assistant_message_id = args.assistant_message_id.clone();
    let stream_key = format!("{}:{}", args.session_id, stream_id);

    let (tx, rx_cancel) = oneshot::channel::<()>();
    {
        let mut map = streams.0.lock().map_err(|e| e.to_string())?;
        let prefix = format!("{}:", args.session_id);
        for key in map
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>()
        {
            if let Some(previous) = map.remove(&key) {
                let _ = previous.send(());
            }
        }
        map.insert(stream_key.clone(), tx);
    }

    let app_clone = app.clone();
    let session_id = args.session_id.clone();
    let stream_id_for_events = stream_id.clone();
    let assistant_message_id_for_events = assistant_message_id.clone();
    let stream_key_for_cleanup = stream_key.clone();
    let streams_clone = ActiveStreams(streams.0.clone());
    let pool_clone = pool.inner().clone();
    tokio::spawn(async move {
        let mut full_content = String::new();
        let mut full_thinking = String::new();
        let mut was_cancelled = false;
        let mut terminal_event_emitted = false;
        let mut rx = rx;
        let mut rx_cancel = rx_cancel;
        loop {
            tokio::select! {
                _ = &mut rx_cancel => {
                    was_cancelled = true;
                    break;
                }
                item = rx.recv() => {
                    match item {
                        Some(Ok(chunk)) => {
                            if chunk.done {
                                let prompt_tokens = chunk.prompt_eval_count;
                                let output_tokens = chunk.eval_count;
                                let completed_at = chrono::Utc::now().to_rfc3339();
                                persist_assistant(
                                    &pool_clone,
                                    &session_id,
                                    AssistantTurn {
                                        message_id: &assistant_message_id_for_events,
                                        content: &full_content,
                                        thinking: &full_thinking,
                                        usage: (prompt_tokens, output_tokens),
                                        memory_used: &memory_used_json,
                                        created_at: &completed_at,
                                    },
                                );
                                let _ = app_clone.emit(
                                    "chat-done",
                                    ChatDoneEvent {
                                        conversation_id: session_id.clone(),
                                        stream_id: stream_id_for_events.clone(),
                                        assistant_message_id: assistant_message_id_for_events.clone(),
                                        prompt_tokens,
                                        output_tokens,
                                        completed_at,
                                    },
                                );
                                terminal_event_emitted = true;
                                break;
                            }
                            if let Some(msg) = chunk.message {
                                if let Some(t) = msg.thinking {
                                    full_thinking.push_str(&t);
                                    let _ = app_clone.emit(
                                        "chat-thinking",
                                        ChatThinkingEvent {
                                            conversation_id: session_id.clone(),
                                            stream_id: stream_id_for_events.clone(),
                                            assistant_message_id: assistant_message_id_for_events.clone(),
                                            delta: t,
                                        },
                                    );
                                }
                                if !msg.content.is_empty() {
                                    full_content.push_str(&msg.content);
                                    let _ = app_clone.emit(
                                        "chat-chunk",
                                        ChatChunkEvent {
                                            conversation_id: session_id.clone(),
                                            stream_id: stream_id_for_events.clone(),
                                            assistant_message_id: assistant_message_id_for_events.clone(),
                                            delta: msg.content,
                                        },
                                    );
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let completed_at = chrono::Utc::now().to_rfc3339();
                            persist_assistant(
                                &pool_clone,
                                &session_id,
                                AssistantTurn {
                                    message_id: &assistant_message_id_for_events,
                                    content: &full_content,
                                    thinking: &full_thinking,
                                    usage: (None, None),
                                    memory_used: &memory_used_json,
                                    created_at: &completed_at,
                                },
                            );
                            let _ = app_clone.emit(
                                "chat-error",
                                ChatErrorEvent {
                                    conversation_id: session_id.clone(),
                                    stream_id: stream_id_for_events.clone(),
                                    assistant_message_id: assistant_message_id_for_events.clone(),
                                    error: e.to_string(),
                                    completed_at,
                                },
                            );
                            terminal_event_emitted = true;
                            break;
                        }
                        None => break,
                    }
                }
            }
        }

        // Clean up the ActiveStreams entry so the cancel-token doesn't
        // get dropped by replacement on the next send (which would fire
        // a spurious chat-cancelled for this session).
        {
            if let Ok(mut map) = streams_clone.0.lock() {
                map.remove(&stream_key_for_cleanup);
            }
        }

        if was_cancelled {
            let completed_at = chrono::Utc::now().to_rfc3339();
            let content = if full_content.is_empty() {
                String::new()
            } else {
                format!("{} [stopped]", full_content)
            };
            persist_assistant(
                &pool_clone,
                &session_id,
                AssistantTurn {
                    message_id: &assistant_message_id_for_events,
                    content: &content,
                    thinking: &full_thinking,
                    usage: (None, None),
                    memory_used: &memory_used_json,
                    created_at: &completed_at,
                },
            );
            let _ = app_clone.emit(
                "chat-cancelled",
                ChatCancelledEvent {
                    conversation_id: session_id.clone(),
                    stream_id: stream_id_for_events.clone(),
                    assistant_message_id: assistant_message_id_for_events.clone(),
                    completed_at,
                },
            );
        } else if !terminal_event_emitted {
            // The stream ended without a done chunk (provider closed
            // the connection or dropped the final done event). Emit a
            // synthetic chat-done so the frontend can finalize — set
            // s.streaming = false and save the partial content.
            let completed_at = chrono::Utc::now().to_rfc3339();
            persist_assistant(
                &pool_clone,
                &session_id,
                AssistantTurn {
                    message_id: &assistant_message_id_for_events,
                    content: &full_content,
                    thinking: &full_thinking,
                    usage: (None, None),
                    memory_used: &memory_used_json,
                    created_at: &completed_at,
                },
            );
            let _ = app_clone.emit(
                "chat-done",
                ChatDoneEvent {
                    conversation_id: session_id,
                    stream_id: stream_id_for_events,
                    assistant_message_id: assistant_message_id_for_events,
                    prompt_tokens: None,
                    output_tokens: None,
                    completed_at,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_chat_v2(
    streams: State<'_, ActiveStreams>,
    session_id: String,
    stream_id: Option<String>,
) -> Result<(), String> {
    let Some(stream_id) = stream_id.filter(|id| !id.trim().is_empty()) else {
        return Err("stream_id is required".into());
    };
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    let key = format!("{}:{}", session_id, stream_id);
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ChatChunkEvent, ChatDoneEvent, UsedRow};

    #[test]
    fn stream_events_always_carry_generation_and_message_identity() {
        let chunk = serde_json::to_value(ChatChunkEvent {
            conversation_id: "session-1".into(),
            stream_id: "stream-1".into(),
            assistant_message_id: "assistant-1".into(),
            delta: "hello".into(),
        })
        .unwrap();
        assert_eq!(chunk["stream_id"], "stream-1");
        assert_eq!(chunk["assistant_message_id"], "assistant-1");

        let done = serde_json::to_value(ChatDoneEvent {
            conversation_id: "session-1".into(),
            stream_id: "stream-1".into(),
            assistant_message_id: "assistant-1".into(),
            prompt_tokens: None,
            output_tokens: None,
            completed_at: "now".into(),
        })
        .unwrap();
        assert_eq!(done["conversation_id"], "session-1");
        assert!(done.get("stream_id").is_some());
    }

    /// The provenance row is a cross-boundary contract: Rust writes it into
    /// the event and the message, and the frontend reads camelCase keys. A
    /// rename here does not fail anything — `parseMemoryUsed` drops what it
    /// cannot read and the feature simply disappears, with green suites.
    #[test]
    fn the_recall_snapshot_serialises_to_the_keys_the_frontend_reads() {
        let value = serde_json::to_value(UsedRow {
            owner_type: "memory".into(),
            owner_id: "m1".into(),
            label: "Project facts".into(),
            title: Some("Database".into()),
            reason: Some("keyword match on postgres".into()),
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "ownerType": "memory",
                "ownerId": "m1",
                "label": "Project facts",
                "title": "Database",
                "reason": "keyword match on postgres",
            })
        );
    }

    /// The event name is a string in two languages with no compiler between
    /// them. The frontend half is pinned behaviourally (its listener test
    /// emits `chat-recall`); this pins the Rust half against that same
    /// literal, because a rename would otherwise be silent in both suites.
    #[test]
    fn the_recall_event_name_matches_the_frontend_listener() {
        let frontend = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/stores/chatStream.ts"
        ))
        .expect("the store that listens for chat-recall");

        assert!(
            frontend.contains(r#""chat-recall""#),
            "the frontend no longer listens for chat-recall"
        );
        assert!(
            frontend.contains("rows: unknown"),
            "the frontend's chat-recall payload no longer carries rows"
        );
        assert!(
            std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/commands/chat_stream.rs"
            ))
            .unwrap()
            .contains(r#""chat-recall""#),
            "Rust no longer emits chat-recall"
        );
    }
}

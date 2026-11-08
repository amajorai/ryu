//! Built-in conversation-history search (`search_conversations.search`).
//!
//! An agent-callable tool that searches across the user's stored chat messages
//! two ways: by exact words through the full-text index (identifiers, error
//! strings, file names) and by meaning through the same embedder the rest of
//! Core uses (local hashing by default, or a remote `/v1/embeddings` endpoint
//! via `RYU_EMBED_BASE_URL` — nothing hardcoded). `mode: "all"` (the default)
//! fuses both ranked lists with weighted reciprocal rank fusion keyed by
//! message id, so a literal match is never lost behind weak hashing vectors.
//!
//! Registered as a reserved registry server (`search_conversations`) like
//! spider/exa/notify, so the `<server>.<tool>` id scheme, per-agent allowlist,
//! catalog search (`GET /api/tools/search`), and the single `call_tool` entry all
//! work for free — and it is allowlist-gated + audited on BOTH planes (ACP +
//! openai-compat) through the shared dispatch path. No bespoke dispatch.
//!
//! The actual indexes + searches live on [`crate::server::conversations::ConversationStore`]
//! (it owns the cipher needed to decrypt snippets and the message append site).
//! The store is threaded into the registry via `McpRegistry::with_conversations`;
//! when it is not wired (CLI / tests / headless) the tool reports unavailable
//! rather than panicking.

use std::collections::HashSet;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};
use crate::server::conversations::{ConversationStore, MessageSearchHit};

/// Reserved registry server name for the built-in conversation-search provider.
pub const SERVER_NAME: &str = "search_conversations";

/// Maximum length of a returned snippet (characters) — keeps tool output compact
/// so a long message doesn't blow the model's context.
const SNIPPET_MAX_CHARS: usize = 400;

/// Fusion weights for `mode: "all"`. Equal weights let a message found by both
/// searches outrank one found by either alone; ties break toward the exact list
/// because it is passed first.
const EXACT_WEIGHT: f32 = 1.0;
const SEMANTIC_WEIGHT: f32 = 1.0;

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to look for in past conversations: a natural-language \
                                question ('what did we decide about the database schema') or \
                                exact words such as an identifier, error string, or file name."
            },
            "mode": {
                "type": "string",
                "enum": ["all", "exact", "semantic"],
                "description": "'exact' matches the query's words literally, 'semantic' \
                                matches by meaning, 'all' (default) runs both and merges them."
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of matching message snippets to return (default 5).",
                "minimum": 1,
                "maximum": 20
            },
            "conversation_ids": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional list of conversation ids to restrict the search to. \
                                Omit to search across all conversations you can read."
            },
            "since": {
                "type": ["string", "integer"],
                "description": "Only messages sent at or after this time: an RFC 3339 \
                                timestamp, a YYYY-MM-DD date (UTC), or unix seconds."
            },
            "until": {
                "type": ["string", "integer"],
                "description": "Only messages sent at or before this time: an RFC 3339 \
                                timestamp, a YYYY-MM-DD date (UTC, start of day), or unix seconds."
            }
        },
        "required": ["query"]
    })
}

/// The search tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}.search"),
        server: SERVER_NAME.to_owned(),
        name: "search".to_owned(),
        description: Some(
            "Search the user's past chats by meaning or by exact words (identifiers, error \
             strings, file names). Returns matching message snippets with conversation id and \
             title, message id, role, timestamp, which search matched, and a relevance score. \
             Use to recall earlier discussions, decisions, or facts from prior chats; narrow \
             with since/until for a time range."
                .to_owned(),
        ),
        input_schema: Some(search_schema()),
        ..Default::default()
    }]
}

/// Which index(es) a search consults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchMode {
    Exact,
    Semantic,
    All,
}

impl SearchMode {
    fn parse(arguments: &Value) -> Result<Self> {
        match arguments.get("mode") {
            None | Some(Value::Null) => Ok(Self::All),
            Some(Value::String(mode)) => match mode.trim().to_ascii_lowercase().as_str() {
                "" | "all" => Ok(Self::All),
                "exact" => Ok(Self::Exact),
                "semantic" => Ok(Self::Semantic),
                other => Err(anyhow!(
                    "invalid 'mode' '{other}': expected exact, semantic, or all"
                )),
            },
            Some(_) => Err(anyhow!("'mode' must be a string: exact, semantic, or all")),
        }
    }

    fn exact(self) -> bool {
        self != Self::Semantic
    }

    fn semantic(self) -> bool {
        self != Self::Exact
    }
}

/// Inclusive `[since, until]` bounds on a message's `created_at` (unix millis).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TimeWindow {
    pub since: Option<i64>,
    pub until: Option<i64>,
}

impl TimeWindow {
    fn parse(arguments: &Value) -> Result<Self> {
        Ok(Self {
            since: parse_time_bound(arguments, "since")?,
            until: parse_time_bound(arguments, "until")?,
        })
    }

    fn is_bounded(self) -> bool {
        self.since.is_some() || self.until.is_some()
    }

    pub(crate) fn contains(self, created_at_ms: i64) -> bool {
        self.since.is_none_or(|since| created_at_ms >= since)
            && self.until.is_none_or(|until| created_at_ms <= until)
    }
}

/// Parse a time bound into unix milliseconds. Accepts an RFC 3339 timestamp, a
/// `YYYY-MM-DD` date (midnight UTC), or unix seconds (a number, or a string of
/// digits). Values too large to be seconds (13+ digits) are taken as millis.
pub(crate) fn parse_time_bound(arguments: &Value, field: &str) -> Result<Option<i64>> {
    let invalid = || {
        anyhow!(
            "invalid '{field}': expected an RFC 3339 timestamp, a YYYY-MM-DD date, or unix seconds"
        )
    };
    let unix = |n: i64| {
        if n.abs() >= 100_000_000_000 {
            n
        } else {
            n.saturating_mul(1000)
        }
    };
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(unix).map(Some).ok_or_else(invalid),
        Some(Value::String(raw)) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return Ok(None);
            }
            if let Ok(n) = raw.parse::<i64>() {
                return Ok(Some(unix(n)));
            }
            if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(raw) {
                return Ok(Some(ts.timestamp_millis()));
            }
            chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|dt| Some(dt.and_utc().timestamp_millis()))
                .ok_or_else(invalid)
        }
        Some(_) => Err(invalid()),
    }
}

/// One fused result, before snippet truncation and title lookup.
#[derive(Debug, Clone)]
pub(crate) struct FusedHit {
    pub hit: MessageSearchHit,
    pub score: f32,
    pub matched_by: &'static str,
}

/// Merge exact and semantic hit lists into one ranked list of at most `limit`.
///
/// Every hit is first post-filtered against `allowed` (when the search was
/// scoped) and `window`, so a stale index row can never leak a snippet and the
/// time range is honored. With both lists present the results are fused with
/// [`ryu_rag::hybrid::weighted_rrf`] keyed by message id and carry the fused
/// score; a single list keeps its own order and relevance score.
pub(crate) fn merge_hits(
    exact: Option<Vec<MessageSearchHit>>,
    semantic: Option<Vec<MessageSearchHit>>,
    allowed: Option<&[String]>,
    window: TimeWindow,
    limit: usize,
) -> Vec<FusedHit> {
    let allowed: Option<HashSet<&str>> =
        allowed.map(|ids| ids.iter().map(String::as_str).collect());
    let keep = |hits: Option<Vec<MessageSearchHit>>| -> Option<Vec<MessageSearchHit>> {
        hits.map(|hits| {
            hits.into_iter()
                .filter(|hit| {
                    allowed
                        .as_ref()
                        .is_none_or(|ids| ids.contains(hit.conversation_id.as_str()))
                        && window.contains(hit.created_at)
                })
                .collect()
        })
    };
    let single = |hits: Vec<MessageSearchHit>, matched_by: &'static str| -> Vec<FusedHit> {
        let mut seen = HashSet::new();
        hits.into_iter()
            .filter(|hit| seen.insert(hit.message_id.clone()))
            .take(limit)
            .map(|hit| FusedHit {
                score: hit.score,
                hit,
                matched_by,
            })
            .collect()
    };
    match (keep(exact), keep(semantic)) {
        (Some(exact), None) => single(exact, "exact"),
        (None, Some(semantic)) => single(semantic, "semantic"),
        (None, None) => Vec::new(),
        (Some(exact), Some(semantic)) => {
            let exact_ids: HashSet<String> = exact.iter().map(|h| h.message_id.clone()).collect();
            let semantic_ids: HashSet<String> =
                semantic.iter().map(|h| h.message_id.clone()).collect();
            ryu_rag::hybrid::weighted_rrf(
                vec![(EXACT_WEIGHT, exact), (SEMANTIC_WEIGHT, semantic)],
                |hit: &MessageSearchHit| hit.message_id.clone(),
                limit,
            )
            .into_iter()
            .map(|(hit, score)| {
                let matched_by = match (
                    exact_ids.contains(&hit.message_id),
                    semantic_ids.contains(&hit.message_id),
                ) {
                    (true, true) => "both",
                    (true, false) => "exact",
                    _ => "semantic",
                };
                FusedHit {
                    hit,
                    score,
                    matched_by,
                }
            })
            .collect()
        }
    }
}

/// Resolve the conversation ids a search may touch.
///
/// **Tenancy.** This was the single worst leak in Core: `search_messages` took a
/// CALLER-SUPPLIED `conversation_ids` list and applied no tenancy filter at all, so
/// on an org-bound node "search my past conversations for the Q3 numbers" ran
/// semantic search across EVERY user's messages and printed the snippets into the
/// asking user's thread. Its REST twin (`search_conversations_handler`) already
/// filtered via `visible_conversation_ids`; that asymmetry WAS the bug.
///
/// The caller-supplied `conversation_ids` is an **INTERSECTION** with
/// `principal`'s visible set (and the server-owned scope), never a widening.
/// Omitting the argument searches the visible set; naming someone else's
/// conversation searches nothing. `Unrestricted` (unbound personal node) keeps
/// the caller's list exactly as supplied. Both exact and semantic searches use
/// the id set this returns.
async fn resolve_conversation_ids(
    arguments: &Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    conversation_scope: Option<&[String]>,
) -> Result<Option<Vec<String>>> {
    let requested_ids: Option<Vec<String>> = arguments
        .get("conversation_ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        });
    let in_scope = |id: &String| conversation_scope.is_none_or(|scope| scope.contains(id));

    if matches!(principal, ToolPrincipal::Unrestricted) {
        return Ok(match (requested_ids, conversation_scope) {
            (Some(requested), Some(_)) => Some(requested.into_iter().filter(in_scope).collect()),
            (None, Some(scope)) => Some(scope.to_vec()),
            (requested, None) => requested,
        });
    }
    // THE GATE — the same `TENANCY_VISIBLE_PREDICATE` the REST search uses.
    let (uid, org, bound) = principal.filter_args();
    let visible = store.visible_conversation_ids(uid, org, bound).await?;
    Ok(Some(
        requested_ids
            .unwrap_or_else(|| visible.clone())
            .into_iter()
            .filter(|id| visible.contains(id) && in_scope(id))
            .collect(),
    ))
}

fn unavailable(error: &str) -> Value {
    json!({ "ok": false, "available": false, "error": error, "results": [], "count": 0 })
}

/// Dispatch a `search_conversations` tool call. `store` is the wired conversation
/// store (the searches + lazy backfill live there). `Err` only for a malformed
/// call; an unavailable index returns an `ok:false` envelope, not an error, so the
/// agent can degrade gracefully. See [`resolve_conversation_ids`] for tenancy.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    dispatch_scoped(tool, arguments, store, principal, None).await
}

/// Dispatch with an optional server-owned conversation scope. The profile
/// bootstrap uses this to make its imported conversation selection a hard
/// ceiling rather than a prompt-only suggestion.
pub async fn dispatch_scoped(
    tool: &str,
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    conversation_scope: Option<&[String]>,
) -> Result<Value> {
    if tool != "search" {
        return Err(anyhow!("unknown search_conversations tool '{tool}'"));
    }
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("missing required string argument 'query'"))?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 20) as usize)
        .unwrap_or(5);
    let mode = SearchMode::parse(&arguments)?;
    let window = TimeWindow::parse(&arguments)?;

    // Conversation indexes are a Memory app contribution surface, so agent
    // access follows the same explicit opt-in as the REST/UI search. Keep the
    // envelope successful at the transport level so agents can continue without
    // treating an optional capability as a tool failure.
    if !store.chat_memory_enabled() {
        return Ok(unavailable(
            "conversation memory search is disabled; enable Remember chats first",
        ));
    }

    let conversation_ids =
        resolve_conversation_ids(&arguments, store, principal, conversation_scope).await?;
    // An empty visible set must return NOTHING, not everything: `None` means
    // "unfiltered" to both searches, so never collapse `Some(vec![])`.
    if conversation_ids.as_ref().is_some_and(Vec::is_empty) {
        return Ok(json!({ "ok": true, "available": true, "results": [], "count": 0 }));
    }
    let ids = conversation_ids.as_deref();

    // Time bounds are post-filters, so widen the candidate pool when set. Fusion
    // also benefits from a deeper list than the final `limit`.
    let candidates = if window.is_bounded() {
        (limit * 5).min(100)
    } else {
        (limit * 2).min(40)
    };
    let exact = if mode.exact() {
        store.fts_search_messages(query, candidates, ids).await?
    } else {
        None
    };
    let semantic = if mode.semantic() {
        store.search_messages(query, candidates, ids).await?
    } else {
        None
    };
    let sources = json!({ "exact": exact.is_some(), "semantic": semantic.is_some() });
    if exact.is_none() && semantic.is_none() {
        return Ok(unavailable(
            "conversation search index is not available on this node",
        ));
    }

    let fused = merge_hits(exact, semantic, ids, window, limit);
    let mut title_ids: Vec<String> = Vec::new();
    for fused_hit in &fused {
        if !title_ids.contains(&fused_hit.hit.conversation_id) {
            title_ids.push(fused_hit.hit.conversation_id.clone());
        }
    }
    let titles = store.conversation_titles(&title_ids).await?;
    let results: Vec<Value> = fused
        .into_iter()
        .map(
            |FusedHit {
                 hit,
                 score,
                 matched_by,
             }| {
                json!({
                    "conversation_id": hit.conversation_id,
                    "conversation_title": titles.get(&hit.conversation_id),
                    "message_id": hit.message_id,
                    "role": hit.role,
                    "snippet": truncate(&hit.content),
                    "created_at": hit.created_at,
                    "matched_by": matched_by,
                    "score": score,
                })
            },
        )
        .collect();
    let count = results.len();
    Ok(json!({
        "ok": true,
        "available": true,
        "sources": sources,
        "results": results,
        "count": count
    }))
}

/// Truncate a snippet to [`SNIPPET_MAX_CHARS`] on a char boundary, appending an
/// ellipsis when cut.
fn truncate(text: &str) -> String {
    if text.chars().count() <= SNIPPET_MAX_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(SNIPPET_MAX_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
#[path = "search_conversations_tests.rs"]
mod tests;

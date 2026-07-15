//! Built-in semantic conversation-history search (`search_conversations__search`).
//!
//! An agent-callable tool that searches across the user's stored chat messages
//! using the same embedder the rest of Core uses (local hashing by default, or a
//! remote `/v1/embeddings` endpoint via `RYU_EMBED_BASE_URL` — nothing hardcoded).
//!
//! Registered as a reserved registry server (`search_conversations`) like
//! spider/exa/notify, so the `<server>__<tool>` id scheme, per-agent allowlist,
//! catalog search (`GET /api/tools/search`), and the single `call_tool` entry all
//! work for free — and it is allowlist-gated + audited on BOTH planes (ACP +
//! openai-compat) through the shared dispatch path. No bespoke dispatch.
//!
//! The actual index + search live on [`crate::server::conversations::ConversationStore`]
//! (it owns the cipher needed to decrypt snippets and the message append site).
//! The store is threaded into the registry via `McpRegistry::with_conversations`;
//! when it is not wired (CLI / tests / headless) the tool reports unavailable
//! rather than panicking.

use anyhow::Result;
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};
use crate::server::conversations::ConversationStore;

/// Reserved registry server name for the built-in conversation-search provider.
pub const SERVER_NAME: &str = "search_conversations";

/// Maximum length of a returned snippet (characters) — keeps tool output compact
/// so a long message doesn't blow the model's context.
const SNIPPET_MAX_CHARS: usize = 400;

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural-language query to search your past conversations \
                                (e.g. 'what did we decide about the database schema')."
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
                                Omit to search across all conversations."
            }
        },
        "required": ["query"]
    })
}

/// The search tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__search"),
        server: SERVER_NAME.to_owned(),
        name: "search".to_owned(),
        description: Some(
            "Semantically search the user's past conversation messages and return matching \
             snippets with conversation id, role, timestamp, and a relevance score. Use to \
             recall earlier discussions, decisions, or facts from prior chats."
                .to_owned(),
        ),
        input_schema: Some(search_schema()),
        ..Default::default()
    }]
}

/// Dispatch a `search_conversations` tool call. `store` is the wired conversation
/// store (the search + lazy backfill live there). `Err` only for a malformed call;
/// an unavailable index returns an `ok:false` envelope, not an error, so the agent
/// can degrade gracefully.
///
/// **Tenancy.** This was the single worst leak in Core: `search_messages` took a
/// CALLER-SUPPLIED `conversation_ids` list and applied no tenancy filter at all, so
/// on an org-bound node "search my past conversations for the Q3 numbers" ran
/// semantic search across EVERY user's messages and printed the snippets into the
/// asking user's thread. Its REST twin (`search_conversations_handler`) already
/// filtered via `visible_conversation_ids`; that asymmetry WAS the bug.
///
/// The fix is one line of intent: the caller-supplied `conversation_ids` becomes an
/// **INTERSECTION** with `principal`'s visible set, never a widening. Omitting the
/// argument searches the visible set; naming someone else's conversation searches
/// nothing.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    match tool {
        "search" => {
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'query'"))?;
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 20) as usize)
                .unwrap_or(5);
            let requested_ids: Option<Vec<String>> = arguments
                .get("conversation_ids")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                });

            // THE GATE — the same `TENANCY_VISIBLE_PREDICATE` the REST search uses.
            // `Unrestricted` (unbound personal node) keeps the caller's list exactly
            // as supplied, so behaviour there is byte-identical to before.
            let conversation_ids: Option<Vec<String>> =
                if matches!(principal, ToolPrincipal::Unrestricted) {
                    requested_ids
                } else {
                    let (uid, org, bound) = principal.filter_args();
                    let visible = store.visible_conversation_ids(uid, org, bound).await?;
                    Some(match requested_ids {
                        // INTERSECTION: a caller-supplied id that is not visible to
                        // this principal is dropped, never honoured.
                        Some(requested) => requested
                            .into_iter()
                            .filter(|id| visible.contains(id))
                            .collect(),
                        None => visible,
                    })
                };

            // An empty visible set must return NOTHING, not everything: `None` means
            // "unfiltered" to `search_messages`, so never collapse `Some(vec![])`.
            if conversation_ids.as_ref().is_some_and(Vec::is_empty) {
                return Ok(json!({ "ok": true, "available": true, "results": [], "count": 0 }));
            }

            let hits = store
                .search_messages(query, limit, conversation_ids.as_deref())
                .await?;
            let Some(hits) = hits else {
                return Ok(json!({
                    "ok": false,
                    "available": false,
                    "error": "conversation search index is not available on this node",
                    "results": [],
                    "count": 0
                }));
            };

            let results: Vec<Value> = hits
                .into_iter()
                .map(|h| {
                    json!({
                        "conversation_id": h.conversation_id,
                        "message_id": h.message_id,
                        "role": h.role,
                        "snippet": truncate(&h.content),
                        "created_at": h.created_at,
                        "score": h.score,
                    })
                })
                .collect();
            let count = results.len();
            Ok(json!({ "ok": true, "available": true, "results": results, "count": count }))
        }
        other => Err(anyhow::anyhow!(
            "unknown search_conversations tool '{other}'"
        )),
    }
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
mod tests {
    use super::*;
    use crate::server::conversations::Tenancy;

    #[test]
    fn lists_search_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "search_conversations__search");
        assert_eq!(tools[0].server, SERVER_NAME);
    }

    #[tokio::test]
    async fn missing_query_is_an_error() {
        let store = ConversationStore::open_in_memory().expect("store");
        assert!(dispatch("search", json!({}), &store, &ToolPrincipal::Unrestricted).await.is_err());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let store = ConversationStore::open_in_memory().expect("store");
        assert!(dispatch("nope", json!({ "query": "x" }), &store, &ToolPrincipal::Unrestricted)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn unavailable_index_returns_graceful_envelope() {
        // open_in_memory wires no message index, so search reports unavailable.
        let store = ConversationStore::open_in_memory().expect("store");
        let out = dispatch("search", json!({ "query": "hello" }), &store, &ToolPrincipal::Unrestricted)
            .await
            .expect("dispatch ok");
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["available"], json!(false));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // THE SEMANTIC-SEARCH LEAK (task item 2). `search_messages` took a
    // CALLER-SUPPLIED `conversation_ids` and applied NO tenancy filter, while its REST
    // twin (`search_conversations_handler`) filtered via `visible_conversation_ids`.
    // That asymmetry WAS the bug: "search my past conversations for the Q3 numbers"
    // ran across every user's messages.
    // ══════════════════════════════════════════════════════════════════════════

    const ORG: &str = "org1";

    #[tokio::test]
    async fn a_caller_supplied_conversation_id_is_intersected_never_widened() {
        let store = ConversationStore::open_in_memory().expect("store");
        store
            .ensure_conversation(
                "alice-thread",
                None,
                None,
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();
        store
            .ensure_conversation(
                "bob-thread",
                None,
                None,
                Tenancy::Owned {
                    user_id: "bob".to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();

        let bob = ToolPrincipal::Owned {
            user_id: "bob".to_owned(),
            org_id: Some(ORG.to_owned()),
        };

        // Bob's agent explicitly NAMES Alice's conversation. The intersection empties
        // the id set, so the search short-circuits to zero results — it must never
        // fall through to an UNFILTERED (`None`) search, which is what "empty means
        // unrestricted" would silently do.
        let out = dispatch(
            "search",
            json!({ "query": "q3 revenue", "conversation_ids": ["alice-thread"] }),
            &store,
            &bob,
        )
        .await
        .expect("dispatch");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["count"], json!(0));
        assert_eq!(out["results"], json!([]));
    }

    /// FAIL CLOSED on a bound node with no resolvable principal.
    #[tokio::test]
    async fn an_unresolved_principal_searches_nothing() {
        let store = ConversationStore::open_in_memory().expect("store");
        let out = dispatch(
            "search",
            json!({ "query": "anything" }),
            &store,
            &ToolPrincipal::Unresolved,
        )
        .await
        .expect("dispatch");
        assert_eq!(out["count"], json!(0));
    }
}

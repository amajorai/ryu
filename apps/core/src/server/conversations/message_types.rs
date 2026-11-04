//! Message records returned by the store: stored messages, provenance,
//! learning projections, search hits and title history.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// A persisted chat message belonging to a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    /// The agent that produced this message (None for user messages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// The verified human author of this message (None for agent messages or
    /// when no verified identity was present). Distinct from `agent_id`, which
    /// names the AI agent. Populated by the JWT identity layer in a later stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_user_id: Option<String>,
    /// Display name of the (possibly unverified) sender for group/channel chats,
    /// e.g. a Telegram first name or Discord username. Distinct from
    /// `author_user_id` (a *verified* Ryu identity): this is connector-supplied
    /// and is NOT trusted for auth — it exists so a multi-participant group thread
    /// can show and reason about who said what. None for 1:1 / anonymous turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    /// Server-verified source for a non-human turn, when one exists (for
    /// example, `widget`). This is never accepted from the chat wire body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Server-verified widget instance that authored this user turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget_instance_id: Option<String>,
    /// Server-resolved MCP server that owns the widget instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_server: Option<String>,
    /// Structured render parts (AI SDK reduced UIMessage `parts` array: text /
    /// tool / file), captured server-side as the turn streams. This is what lets a
    /// reloaded conversation re-render its tool-call rows and the cowork context
    /// (Progress / Sources / Subagents) instead of collapsing to flat `content`
    /// text. User turns preserve their submitted text/file parts as well. `None` for
    /// legacy rows, which fall back to a text part built from `content`. Sealed at rest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<serde_json::Value>,
    /// Client render metadata, sealed at rest. Never an authorization source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// The message this one was produced in reply to (its position in the
    /// version tree). `None` for root turns and for every message in a
    /// conversation that has never been edited/regenerated (flat history). Set
    /// lazily the first time a conversation is branched (see `linearize`), then
    /// maintained by `append_message` once `active_leaf` is engaged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    /// This assistant turn was cut off mid-stream and never finalized — the node
    /// died (crash, force-quit, OOM, power loss) while it was still being written,
    /// so `content`/`parts` hold only what had been flushed by then.
    ///
    /// Nothing stamps this during a normal turn: both terminal exits of the
    /// streaming loop write the finished row. It is set at boot by
    /// [`ConversationStore::reconcile_interrupted_runs`], which is the only place
    /// that can tell the difference — a process that dies never gets to say so.
    /// The client renders it as an explicit "this reply was cut off" marker
    /// instead of passing a truncated answer off as a complete one.
    #[serde(default)]
    pub interrupted: bool,
    /// 0-based index of this message among its siblings (messages sharing the
    /// same `parent_message_id`), ordered by `created_at`. `0` for messages with
    /// no siblings. Computed at read time by `get_active_messages`, not stored.
    #[serde(default)]
    pub sibling_index: usize,
    /// Total number of sibling versions at this point in the tree (including
    /// this one). `1` when the message was never branched. Computed at read
    /// time; drives the `< n / m >` version pager in the client.
    #[serde(default = "default_sibling_count")]
    pub sibling_count: usize,
    /// The ids of every version at this branch point, in pager order (v1..vN),
    /// so the client can map a pager step to the target id for `select_version`.
    /// Empty when the message was never branched (`sibling_count == 1`), keeping
    /// flat-history payloads unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sibling_ids: Vec<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// Server-owned attribution written alongside a persisted message.
///
/// This is intentionally not part of [`ChatStreamRequest`]'s deserializable
/// shape. Callers must obtain it from a Core verification boundary first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageProvenance {
    pub source: String,
    pub widget_instance_id: String,
    pub origin_server: String,
}

/// The deliberately narrow message projection used by continual learning.
/// It excludes structured parts and identity-bearing author fields, which are
/// not learning input even though the general conversation read exposes them.
#[derive(Debug, Clone)]
pub struct LearningMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub agent_id: Option<String>,
}

/// One message carried by the explicit "save this temporary chat" boundary.
/// Message ids are intentionally generated by Core when the snapshot is saved;
/// the client-owned ids only exist for the temporary in-tab transcript.
#[derive(Debug, Clone)]
pub(crate) struct TemporaryConversationMessage {
    pub role: String,
    pub content: String,
    pub agent_id: Option<String>,
    pub author_user_id: Option<String>,
    pub parts: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
}

pub(super) fn default_sibling_count() -> usize {
    1
}

/// A semantic-search hit over past conversation messages. The snippet is
/// re-decrypted from `conversations.db` at search time (the index never stores
/// message text).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSearchHit {
    pub conversation_id: String,
    pub message_id: String,
    pub role: String,
    /// Decrypted message text (may be truncated by the caller).
    pub content: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Relevance score in `[0, 1]` (higher is more relevant), derived from the
    /// squared-L2 KNN distance.
    pub score: f32,
}

/// One past title for a conversation (auto-rename / manual rename history).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitleHistoryEntry {
    pub id: String,
    pub title: String,
    /// `"auto"` | `"user"` | `"derived"`.
    pub source: String,
    /// Unix milliseconds.
    pub created_at: i64,
}

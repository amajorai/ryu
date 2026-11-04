//! Conversation summaries and details, side-chat entries, reactions, read
//! receipts and the legacy session record.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

/// Lightweight conversation summary used by the list endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
    pub message_count: i64,
    /// Active working folder for the run (M1 git-native parity).
    pub folder_path: Option<String>,
    /// Git branch active at run start.
    pub branch: Option<String>,
    /// Per-run worktree path (populated when a dedicated worktree was created).
    pub worktree_path: Option<String>,
    /// Run lifecycle status: "running" | "completed" | "failed" | "interrupted" |
    /// null. "interrupted" is written only by
    /// [`ConversationStore::reconcile_interrupted_runs`] at boot or a live Kill
    /// Switch pause, for a turn Core could not finish — it is a TERMINAL state,
    /// so anything counting live runs must keep testing for "running" specifically.
    pub run_status: Option<String>,
    /// All agent ids participating in this conversation (multi-agent, #414).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<String>,
    /// Pinned by a coordinator thread to keep it surfaced. Defaults false.
    #[serde(default)]
    pub pinned: bool,
    /// Archived by a coordinator thread to hide a finished worker. Defaults false.
    #[serde(default)]
    pub archived: bool,
    /// GitHub pull request URLs explicitly linked to this chat, in link order.
    /// The branch-derived pull request is not stored here; clients add it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked_pull_requests: Vec<String>,
    /// Optional Notion-style glyph (`GlyphValue` JSON from `@ryu/ui`). Null =
    /// title-only row (no leading custom icon).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<serde_json::Value>,
    /// `private` keeps the conversation owner-only; `org`/`team` share it with
    /// the corresponding organization scope.
    #[serde(default = "default_private_visibility")]
    pub visibility: String,
    /// First line of the newest message, capped at [`PREVIEW_MAX_CHARS`]. Only
    /// populated when the caller asked for previews (`?preview=1`) — the
    /// messaging-style sidebar rows need it, every other lister does not, and
    /// filling it costs a correlated subquery plus one decrypt per row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    /// Role of the message [`Self::last_message`] came from (`"user"` /
    /// `"assistant"` / a tool role). Lets the row prefix a "You: " marker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_role: Option<String>,
    /// Unix milliseconds of that message. Distinct from `updated_at`, which also
    /// moves on renames, pins and run-status writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    /// Where the thread sits in the Projects › Bots/Groups › Sessions hierarchy.
    #[serde(flatten, default)]
    pub hierarchy: ThreadHierarchy,
    /// RNP handoff marker (`{ nodeLabel, bundleId?, workspaceId?, at }`) set on
    /// the source after the thread continued on another node. Null otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_on: Option<serde_json::Value>,
}

pub(super) fn default_private_visibility() -> String {
    "private".to_owned()
}

/// Detail view of a conversation, including messages and participants.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationDetail {
    pub id: String,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<StoredMessage>,
    /// All agent ids participating in this conversation.
    #[serde(default)]
    pub participants: Vec<String>,
    /// Whether another page exists before the returned message slice. Only set
    /// by the paged conversation read; full reads keep the legacy shape.
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_older_messages: bool,
    /// Stable message id to pass as `before` for the next older page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older_messages_cursor: Option<String>,
}

pub(super) fn is_false(value: &bool) -> bool {
    !*value
}

/// A persisted `/btw` side question + its answer, keyed to the conversation it
/// was asked about. These are lightweight asides (single Q&A, no tools) that the
/// "Side chats" surfaces list under their parent conversation. `question` and
/// `answer` are sealed at rest like message content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtwEntry {
    pub id: String,
    pub conversation_id: String,
    /// `btw` for side questions; `subagent` for delegated child runs.
    #[serde(default = "default_child_entry_kind")]
    pub kind: String,
    pub question: String,
    pub answer: String,
    /// The model that produced the answer (None if unknown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Registered agent id used by a subagent child, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Permission preset attached to a subagent child, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Full clean-context conversation id used by an ACP/registered child agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_conversation_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// One `(message_id, emoji)` bucket of a conversation's reactions, aggregated
/// across users. `reacted_by_me` is resolved for the viewer passed to
/// [`ConversationStore::list_reactions`] — the caller's own identity comes from
/// the verified JWT at the route, never from a request body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageReaction {
    pub message_id: String,
    pub emoji: String,
    pub count: i64,
    pub reacted_by_me: bool,
}

/// One human's durable read marker for one message. The database keeps the
/// timestamp as epoch milliseconds alongside the rest of the conversation
/// metadata; the public projection uses RFC 3339 so clients do not have to
/// guess the unit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageReadReceipt {
    pub message_id: String,
    pub user_id: String,
    pub read_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
}

/// Display metadata for a human who has a durable read marker in the same
/// conversation. The identity is still the stable `id`; name and avatar are
/// refreshed from the scoped organization roster when available.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageReadReceiptUser {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

pub(super) fn default_child_entry_kind() -> String {
    "btw".to_owned()
}

/// The run status of a [`Session`]. Tracks the lifecycle of a single agent/workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The session has been created but no run has started yet.
    #[default]
    Idle,
    /// A run is actively in progress.
    Running,
    /// The most recent run completed successfully.
    Completed,
    /// The most recent run ended with an error.
    Failed,
}

impl SessionStatus {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Running => "running",
            SessionStatus::Completed => "completed",
            SessionStatus::Failed => "failed",
        }
    }

    pub(super) fn from_str(s: &str) -> Self {
        match s {
            "running" => SessionStatus::Running,
            "completed" => SessionStatus::Completed,
            "failed" => SessionStatus::Failed,
            _ => SessionStatus::Idle,
        }
    }
}

/// A Session wraps an existing conversation and adds run-ownership.
///
/// Extends the conversation store from spec unit #15: reuses the same
/// [`ConversationStore`] (same SQLite file, same connection) and adds a
/// runnable binding (which agent/workflow/tool/skill is being run) plus a
/// lifecycle status. Message CRUD is unchanged — use [`ConversationStore`]
/// methods on the `conversation_id` directly.
///
/// Per the Core-vs-Gateway rule: session state is *what runs* (orchestration),
/// not *what is allowed/measured/paid*, so it lives in Core.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    /// The conversation this session owns. Reuses the existing conversation row.
    pub conversation_id: String,
    /// The id of the Runnable being run (agent id, workflow id, etc.).
    pub runnable_id: String,
    /// The kind of Runnable (agent, workflow, tool, skill).
    pub runnable_kind: RunnableKind,
    /// Current lifecycle status of the run.
    pub status: SessionStatus,
    /// Portable execution profile requested for this session. The profile is
    /// provenance/configuration; Gateway and the runner still enforce the
    /// effective sandbox, network, and approval policy.
    #[serde(default)]
    pub execution_profile: ExecutionProfile,
    /// Optional parent session for a delegated child run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Native runtime session id (for example an ACP/Codex session), when the
    /// selected adapter exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// Canonical spelling of a workspace folder path, for the `folder_path` /
/// `worktree_path` columns clients group conversations by.
///
/// Collapses runs of either separator to one and drops trailing separators,
/// without ever emptying a root. Deliberately conservative: it does NOT change
/// case (both macOS and Windows are case-insensitive but case-PRESERVING, and
/// the sidebar draws the leaf as the project's name), does not resolve symlinks
/// or `..` (that needs the path to exist, and this runs on rows for machines
/// that may not be this one), and does not rewrite `\` to `/` (a Windows path
/// must survive this round trip intact).
pub(super) fn normalize_folder_path(path: &str) -> String {
    let trimmed = path.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut last_was_sep = false;
    for ch in trimmed.chars() {
        let is_sep = ch == '/' || ch == '\\';
        if is_sep && last_was_sep {
            continue;
        }
        last_was_sep = is_sep;
        out.push(ch);
    }
    // A single trailing separator is the common accident; strip it, but never
    // turn "/" or "C:\" into something that no longer names a directory.
    while out.len() > 1 && (out.ends_with('/') || out.ends_with('\\')) {
        let is_root = out.len() == 3 && out.as_bytes()[1] == b':';
        if is_root {
            break;
        }
        out.pop();
    }
    out
}

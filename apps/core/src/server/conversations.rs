//! Server-side conversation/session store (spec unit U10).
//!
//! Persists chat history in a local SQLite database (`~/.ryu/conversations.db`)
//! keyed by `conversation_id`. This replaces the per-client localStorage/in-memory
//! history that previously lived in each frontend (desktop, web, CLI, extension).
//!
//! The [`Session`] type (spec unit U004/#118) extends this store: it wraps an
//! existing conversation (reusing [`ConversationStore`] from spec unit #15) and
//! adds run-ownership — a binding to a [`crate::runnable::RunnableKind`] + id and
//! a status/state field. Sessions and conversations share the same SQLite file and
//! the same `Arc<Mutex<Connection>>`, so there is exactly one store and no data
//! duplication across message CRUD.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): conversation/session
//! state is part of *what runs* (orchestration), not *what is allowed/measured/paid*,
//! so it belongs in Core.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{named_params, params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::runnable::RunnableKind;
use ryu_agent_contracts::{
    validate_start_request, ExecutionProfile, HarnessRun, HarnessSession, MultitaskStrategy,
    RunEvent, RunEventEnvelope, RunStatus as HarnessRunStatus, StartRunRequest, PROTOCOL_VERSION,
};
use ryu_kernel_contracts::ResourceKey;

#[path = "conversations_hierarchy.rs"]
mod hierarchy;
pub use hierarchy::*;
#[path = "conversations_scope_guidance.rs"]
mod scope_guidance;
pub use scope_guidance::*;

const MESSAGE_SEARCH_BATCH_SQL: &str =
    "SELECT p.revision, m.id, m.conversation_id, m.role, m.content, m.created_at, p.dirty
     FROM message_search_pending p JOIN messages m ON m.id = p.message_id
     WHERE p.kind = ?1 AND p.revision > ?2 AND p.revision <= ?3
     ORDER BY p.revision LIMIT 128";

/// The SQL twin of `resource_access` (`server/mod.rs`) — the ONE place a tenancy
/// read-filter is expressed for list/search queries, so the row gate and the list
/// gate can never drift apart.
///
///   - `:bound = 0` (node UNBOUND, anonymous caller on a trusted local peer, or an
///     in-process caller): no restriction. This is the node's single local
///     principal, identical to the pre-ACL behaviour.
///   - `:bound = 2` (node UNBOUND, verified caller or anonymous remote request):
///     untenanted legacy rows plus the rows the by-id gate grants this caller. An
///     anonymous remote request therefore sees legacy rows only, matching the
///     realtime gateway's credential-downgrade rule.
///   - A collaborator grant on a row with no org applies on both node kinds,
///     matching `can_access`.
///   - node ORG-BOUND: a row is visible iff the caller OWNS it, or it is explicitly
///     shared with the caller's org/team membership. An untenanted (NULL-owner) row
///     is therefore INVISIBLE on a bound node — matching the ACL's fail-closed
///     reading of an unattributable legacy row.
///   - node ORG-BOUND + anonymous caller (`:uid IS NULL`): nothing matches → empty.
const TENANCY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR (:bound = 2 AND c.owner_user_id IS NULL AND c.org_id IS NULL)
        OR (:uid IS NOT NULL AND c.owner_user_id = :uid)
        OR (:uid IS NOT NULL
            AND ((:org IS NOT NULL AND c.org_id = :org)
                 OR (c.org_id IS NULL AND c.owner_user_id IS NOT NULL))
            AND EXISTS (
                SELECT 1 FROM conversation_collaborators collaborator
                WHERE collaborator.conversation_id = c.id
                  AND collaborator.user_id = :uid
            ))
        OR (:uid IS NOT NULL AND :org IS NOT NULL AND c.org_id = :org
            AND (
                c.visibility = 'org'
                OR (c.visibility = 'team' AND c.team_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM json_each(COALESCE(:teams, '[]')) AS caller_team
                        WHERE caller_team.value = c.team_id
                    ))
            ))
     )";

/// The caller context a tenancy-filtered query is evaluated against.
#[derive(Clone, Copy)]
struct TenancyFilter<'a> {
    /// Whether THIS node is bound to an org (a shared "company brain"). Unbound →
    /// no filtering at all.
    node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    owner_user_id: Option<&'a str>,
    /// The caller's org (already narrowed to this node's org by `identity_verify`).
    org_id: Option<&'a str>,
    /// JSON array of verified team ids, narrowed to the caller's node org. Kept
    /// as JSON so SQLite can evaluate membership inside the same SQL predicate.
    team_ids_json: Option<&'a str>,
    /// On an UNBOUND node, whether this caller is narrower than the node's single
    /// local principal: a verified user (who sees legacy rows plus their own and
    /// shared ones) or an anonymous REMOTE request (legacy rows only). Ignored on
    /// a bound node.
    restricted_when_unbound: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationCollaborator {
    pub user_id: String,
    pub role: String,
}

impl<'a> TenancyFilter<'a> {
    /// The in-process, full-trust filter: every row on the node.
    fn unrestricted() -> Self {
        Self {
            node_bound: false,
            owner_user_id: None,
            org_id: None,
            team_ids_json: None,
            restricted_when_unbound: false,
        }
    }

    /// The filter for an HTTP caller. Mirrors `resource_access`: an anonymous
    /// request keeps the unbound node's full view only from a trusted local peer.
    fn for_http_caller(
        node_bound: bool,
        owner_user_id: Option<&'a str>,
        org_id: Option<&'a str>,
        team_ids_json: Option<&'a str>,
    ) -> Self {
        Self {
            node_bound,
            owner_user_id,
            org_id,
            team_ids_json,
            restricted_when_unbound: owner_user_id.is_some()
                || !crate::server::anonymous_request_is_local(),
        }
    }

    /// `:bound` for [`TENANCY_VISIBLE_PREDICATE`]: `1` bound, `0` unbound full
    /// view, `2` unbound restricted view.
    fn bound_flag(&self) -> i64 {
        if self.node_bound {
            1
        } else if self.restricted_when_unbound {
            2
        } else {
            0
        }
    }
}

/// The tenancy a conversation row is CREATED with — the explicit, mandatory
/// principal every row-creating store call must supply.
///
/// Deliberately **not** an `Option<&str>` pair: an optional argument reads as "may
/// be omitted", and omitting it is precisely the bug this type exists to make
/// uncompilable. Stamping tenancy at a handful of handlers is what let rows born
/// on other paths (the MCP `create_thread`/`fork_thread` tools, sync replay, the
/// healing simulator) stay NULL-tenanted — and on an org-bound node a NULL-tenanted
/// row is DENIED to everyone, locking an owner out of their own chat. With this
/// type a future creation path must make a DELIBERATE choice; "silently forgot" no
/// longer compiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tenancy {
    /// Attribute the new row to this principal: an org-bound node with a verified
    /// caller, or an in-process agent tool call whose HOST conversation resolved an
    /// owner (see `sidecar::mcp::ToolPrincipal`).
    Owned {
        user_id: String,
        org_id: Option<String>,
    },
    /// Attribute a machine-created conversation to the node's organization
    /// without inventing a human owner. Channel ingress uses this for a shared
    /// bot session so every member of the org can continue the same transcript
    /// from the desktop while the bot remains the write authority.
    SharedOrg { org_id: String },
    /// No principal. This is what an UNBOUND personal node passes: there is exactly
    /// one principal and `RYU_TOKEN` is the boundary, so rows stay NULL-tenanted
    /// exactly as they did before the ACL existed (no offline lockout). It is also
    /// what a path writing into an ALREADY-EXISTING row passes — the choke point's
    /// COALESCE preserves whatever owner is already stamped.
    Unattributed,
}

impl Tenancy {
    /// The `(owner_user_id, org_id)` column pair this tenancy writes. `pub(crate)`
    /// so the Spaces / documents choke points (`spaces::upsert_document_row` /
    /// `upsert_space_row`) can reuse this ONE tenancy type rather than defining a
    /// parallel enum that could drift from the conversation plane's semantics.
    pub(crate) fn parts(&self) -> (Option<&str>, Option<&str>) {
        match self {
            Self::Owned { user_id, org_id } => (Some(user_id.as_str()), org_id.as_deref()),
            Self::SharedOrg { org_id } => (None, Some(org_id.as_str())),
            Self::Unattributed => (None, None),
        }
    }

    /// Attribute to `user_id` unless it is absent, in which case the row is
    /// unattributed. The one place `Option<VerifiedCaller>` is lowered to a
    /// `Tenancy`.
    pub fn owned_by(user_id: Option<&str>, org_id: Option<&str>) -> Self {
        match user_id {
            Some(uid) => Self::Owned {
                user_id: uid.to_owned(),
                org_id: org_id.map(str::to_owned),
            },
            None => Self::Unattributed,
        }
    }

    /// Attribute a machine-created row to an organization without a human owner.
    pub fn shared_with_org(org_id: &str) -> Self {
        Self::SharedOrg {
            org_id: org_id.to_owned(),
        }
    }

    /// Derive a `Tenancy` from the shared [`ResourceKey`] composition layer. The
    /// key's compound `node`/`project`/`session` fields are carried at the layer
    /// above and never affect this collapse: a `Tenancy` is exactly the key's
    /// `(owner_user_id, org_id)` pair, so this is byte-identical to
    /// [`Self::owned_by`] fed the same pair. This is the "constructors accept-or-
    /// derive a ResourceKey internally" seam — the choke point still calls
    /// [`Self::parts`], unchanged.
    ///
    /// Reserved adoption seam: exercised by the behavior-preserving regression test
    /// and available to the choke-point adoption wave. No production path is rewired
    /// this wave (that would churn call sites for zero behavior change), so it is
    /// `allow(dead_code)` until then.
    #[allow(dead_code)]
    pub fn from_resource_key(key: &ResourceKey) -> Self {
        let (user_id, org_id) = key.to_tenancy_parts();
        Self::owned_by(user_id, org_id)
    }

    /// Lift this `Tenancy` into the shared [`ResourceKey`] so a caller can compose
    /// the fuller address (session/project/node) on top before lowering it back.
    /// Round-trips through [`Self::parts`], so it never invents attribution.
    /// Reserved adoption seam (see [`Self::from_resource_key`]); `allow(dead_code)`
    /// until a production path adopts it.
    #[allow(dead_code)]
    pub fn to_resource_key(&self) -> ResourceKey {
        let (user_id, org_id) = self.parts();
        ResourceKey::from_tenancy_parts(user_id, org_id)
    }
}

/// How [`upsert_conversation_row`] treats `updated_at` when the row already exists.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Touch {
    /// Leave `updated_at` alone (`ensure_conversation`, `add_participant`,
    /// `create_session`, `claim_tenancy` — none of them is a new turn).
    Keep,
    /// Bump to the supplied timestamp (`append_message` — a real new turn).
    Set,
    /// `max(stored, incoming)` — the sync replay's last-writer-wins clock.
    Max,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConversationConflict {
    Merge,
    Ignore,
}

/// The non-tenancy columns a creation path may seed. Every field is EXISTING-WINS
/// on conflict (except `agent_id`, which is NEW-wins, matching the pre-choke-point
/// upserts), so a caller that leaves one `None` can never clobber a value another
/// path already wrote.
#[derive(Default)]
struct ConvRow<'a> {
    /// Already SEALED by the caller (`seal_opt`) — the choke point does no crypto.
    title: Option<&'a str>,
    agent_id: Option<&'a str>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    folder_path: Option<&'a str>,
    branch: Option<&'a str>,
    worktree_path: Option<&'a str>,
    participants: Option<&'a str>,
    /// Stable control-plane channel config id for a channel-backed session.
    channel_id: Option<&'a str>,
    /// Visibility is seeded as `org` for org-shared channel sessions and remains
    /// existing-wins on later message writes.
    visibility: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProactiveOpeningStatus {
    pub conversation_id: String,
    pub status: String,
}

/// The replayable result of one channel-session turn. The channel adapter uses
/// this when a provider send timed out after Core had already persisted the
/// assistant reply: the retry can deliver the same reply without running the
/// model again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelTurnReplay {
    pub reply: String,
    pub assistant_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub agent_id: Option<String>,
    pub fallback_warning: Option<String>,
    pub interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
}

/// Result of claiming a channel-session idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelTurnClaim {
    /// The caller owns the key and may run the turn.
    Claimed,
    /// Another request is currently running the same key.
    InFlight,
    /// Core already completed the key; return this exact result to the caller.
    Completed(ChannelTurnReplay),
}

/// A conversation row's source version: 12 hex characters of
/// `SHA-256(id NUL created_at NUL owner NUL org)`. None of those change for the
/// life of a row (owner and org are first-writer-wins, see
/// [`upsert_conversation_row`]), while deleting a conversation and creating
/// another under the same id yields a different version, because the new row is
/// owned by its creator and stamped with its own creation time.
pub(crate) fn conversation_source_version(
    id: &str,
    created_at: i64,
    owner_user_id: Option<&str>,
    org_id: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update([0]);
    hasher.update(created_at.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(owner_user_id.unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(org_id.unwrap_or("").as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..6])
}

/// **THE CHOKE POINT** — the one and only `INSERT INTO conversations` in Core.
///
/// Every path that can bring a conversation row into existence
/// ([`ConversationStore::ensure_conversation`], [`ConversationStore::append_message_as`],
/// [`ConversationStore::append_message_with_id`], [`ConversationStore::fork_conversation`],
/// [`ConversationStore::add_participant`], [`ConversationStore::create_session`],
/// [`ConversationStore::claim_tenancy`]) funnels through here, and this statement
/// ALWAYS emits the tenancy clause. So "a new creation path forgot to stamp its
/// owner" is not a mistake that can be made: `tenancy` is a mandatory argument with
/// no default.
///
/// Three load-bearing properties, all in the `ON CONFLICT` clause:
///   - **Stamp on create.** A brand-new row is born with its owner.
///   - **Preserve, never clobber.** `owner_user_id`/`org_id` are
///     `COALESCE(existing, excluded)`, so a later `append_message` (which passes
///     `Unattributed`, the row already existing) can never wipe a claimed owner.
///   - **First-writer-wins.** The same COALESCE means a row can never be
///     RE-tenanted: a racing or deliberate second claimer cannot steal it.
fn upsert_conversation_row(
    conn: &Connection,
    conversation_id: &str,
    now: i64,
    tenancy: &Tenancy,
    row: &ConvRow<'_>,
    touch: Touch,
) -> Result<()> {
    insert_conversation_row(
        conn,
        conversation_id,
        now,
        tenancy,
        row,
        touch,
        ConversationConflict::Merge,
    )
}

fn insert_conversation_row(
    conn: &Connection,
    conversation_id: &str,
    now: i64,
    tenancy: &Tenancy,
    row: &ConvRow<'_>,
    touch: Touch,
    conflict: ConversationConflict,
) -> Result<()> {
    let (owner_user_id, org_id) = tenancy.parts();
    let touch_flag: i64 = match touch {
        Touch::Keep => 0,
        Touch::Set => 1,
        Touch::Max => 2,
    };
    let conflict_clause = match conflict {
        ConversationConflict::Merge => {
            "ON CONFLICT(id) DO UPDATE SET
             title         = COALESCE(conversations.title, excluded.title),
             agent_id      = COALESCE(excluded.agent_id, conversations.agent_id),
             updated_at    = CASE :touch
                                 WHEN 1 THEN excluded.updated_at
                                 WHEN 2 THEN max(conversations.updated_at, excluded.updated_at)
                                 ELSE conversations.updated_at
                             END,
             folder_path   = COALESCE(conversations.folder_path, excluded.folder_path),
             branch        = COALESCE(conversations.branch, excluded.branch),
             worktree_path = COALESCE(conversations.worktree_path, excluded.worktree_path),
             participants  = COALESCE(conversations.participants, excluded.participants),
             channel_id    = COALESCE(conversations.channel_id, excluded.channel_id),
             visibility    = COALESCE(conversations.visibility, excluded.visibility),
             owner_user_id = COALESCE(conversations.owner_user_id, excluded.owner_user_id),
             org_id        = COALESCE(conversations.org_id, excluded.org_id)"
        }
        ConversationConflict::Ignore => "ON CONFLICT(id) DO NOTHING",
    };
    let statement = format!(
        "INSERT INTO conversations
            (id, title, agent_id, created_at, updated_at,
             folder_path, branch, worktree_path, participants,
             channel_id, visibility, owner_user_id, org_id)
         VALUES (:id, :title, :agent_id,
                 COALESCE(:created_at, :now + (:touch * 0)),
                 COALESCE(:updated_at, :now + (:touch * 0)),
                 :folder_path, :branch, :worktree_path,
                 -- `participants` is NOT NULL DEFAULT '[]'; the choke point names it
                 -- explicitly (so `fork` can carry the source's list), which bypasses
                 -- the column default — restore it here for the callers that pass none.
                 COALESCE(:participants, '[]'),
                 :channel_id, COALESCE(:visibility, 'private'), :owner, :org)
         {conflict_clause}"
    );
    conn.execute(
        &statement,
        named_params! {
            ":id": conversation_id,
            ":title": row.title,
            ":agent_id": row.agent_id,
            ":created_at": row.created_at,
            ":updated_at": row.updated_at,
            ":now": now,
            ":folder_path": row.folder_path,
            ":branch": row.branch,
            ":worktree_path": row.worktree_path,
            ":participants": row.participants,
            ":channel_id": row.channel_id,
            ":visibility": row.visibility,
            ":owner": owner_user_id,
            ":org": org_id,
            ":touch": touch_flag,
        },
    )
    .context("inserting conversation row (choke point)")?;
    Ok(())
}

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

fn default_sibling_count() -> usize {
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

/// A durable provider/model selection change made in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConversationModelChangeKind {
    Initial,
    Change,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelChange {
    /// Database ordering key. Monotonic within one conversation.
    pub sequence: i64,
    pub id: String,
    pub kind: ConversationModelChangeKind,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    /// Derived from Core's verified caller identity, never the request body.
    pub changed_by: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// Validated input to the append-only provider/model selection history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationModelSelectionInput {
    pub id: String,
    pub kind: ConversationModelChangeKind,
    pub provider_id: Option<String>,
    pub provider_label: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub changed_by: Option<String>,
}

impl ConversationModelChangeKind {
    fn as_db_value(&self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Change => "change",
        }
    }
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelSelectionState {
    pub current: Option<ConversationModelChange>,
    pub changes: Vec<ConversationModelChange>,
    /// Context handoffs that carried a summary across a model change. Rendered
    /// as markers in the transcript beside the model-change notices.
    pub handoffs: Vec<ConversationContextHandoff>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationModelSelectionWriteResult {
    pub change: ConversationModelChange,
    pub changed: bool,
}

fn read_conversation_model_change(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ConversationModelChange> {
    let raw_kind = row.get::<_, String>(2)?;
    let kind = match raw_kind.as_str() {
        "initial" => ConversationModelChangeKind::Initial,
        "change" => ConversationModelChangeKind::Change,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unknown conversation model-selection kind",
                )),
            ));
        }
    };
    Ok(ConversationModelChange {
        sequence: row.get(0)?,
        id: row.get(1)?,
        kind,
        provider_id: row.get(3)?,
        provider_label: row.get(4)?,
        model_id: row.get(5)?,
        model_label: row.get(6)?,
        changed_by: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// Whether a model-change handoff carried a summary or was evaluated and found
/// unnecessary (the earlier history already fits the new model).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ContextHandoffOutcome {
    Applied,
    NotNeeded,
}

impl ContextHandoffOutcome {
    fn as_db_value(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::NotNeeded => "not_needed",
        }
    }
}

/// The durable marker left in a conversation when switching models handed the
/// earlier history off as a summary. One row per model change and branch of the
/// history before it, so the summary is produced once per branch and replayed
/// byte-identically on every later turn on that branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextHandoff {
    pub id: String,
    /// The `conversation_model_changes.id` this handoff belongs to.
    pub model_change_id: String,
    /// Id of the last message the summary covers on its branch; empty when no
    /// history preceded the change. Editing or branching from a message before
    /// the switch gives the active thread a different head, so it gets its own
    /// handoff instead of a summary of a thread the user left.
    pub covered_head_id: String,
    pub outcome: ContextHandoffOutcome,
    /// Which policy rule fired: `smaller-context`, `different-provider`, `always`.
    pub reason: String,
    pub from_model: Option<String>,
    pub to_model: Option<String>,
    /// Context windows (tokens) of the previous and new model, when known.
    pub from_context: Option<i64>,
    pub to_context: Option<i64>,
    /// How many earlier messages the summary replaces.
    pub summarized_count: i64,
    /// Unix milliseconds: messages created before this are the summarized ones.
    pub boundary_at: i64,
    /// The carried summary. `None` when the outcome is `notNeeded`.
    pub summary: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

const CONTEXT_HANDOFF_COLUMNS: &str = "id, model_change_id, outcome, reason, from_model, to_model,
     from_context, to_context, summarized_count, boundary_at, summary, created_at, covered_head_id";

/// Per-conversation tables whose `ON DELETE CASCADE` is inert (FK enforcement
/// is off; deletes are manual), so every conversation delete path clears them.
const CONVERSATION_SCOPED_HISTORY_TABLES: [&str; 5] = [
    "conversation_context_handoffs",
    "conversation_model_changes",
    "conversation_title_history",
    "agent_controls",
    "run_auto_resume",
];

/// Read one handoff row. `summary` is still sealed here; the store opens it.
fn read_context_handoff_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ConversationContextHandoff> {
    let raw_outcome = row.get::<_, String>(2)?;
    let outcome = match raw_outcome.as_str() {
        "applied" => ContextHandoffOutcome::Applied,
        "not_needed" => ContextHandoffOutcome::NotNeeded,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unknown context handoff outcome",
                )),
            ));
        }
    };
    Ok(ConversationContextHandoff {
        id: row.get(0)?,
        model_change_id: row.get(1)?,
        outcome,
        reason: row.get(3)?,
        from_model: row.get(4)?,
        to_model: row.get(5)?,
        from_context: row.get(6)?,
        to_context: row.get(7)?,
        summarized_count: row.get(8)?,
        boundary_at: row.get(9)?,
        summary: row.get(10)?,
        created_at: row.get(11)?,
        covered_head_id: row.get(12)?,
    })
}

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

fn default_private_visibility() -> String {
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

fn is_false(value: &bool) -> bool {
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

fn default_child_entry_kind() -> String {
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
    fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Running => "running",
            SessionStatus::Completed => "completed",
            SessionStatus::Failed => "failed",
        }
    }

    fn from_str(s: &str) -> Self {
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
fn normalize_folder_path(path: &str) -> String {
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

/// SQLite-backed conversation store. Cheap to clone (wraps an `Arc<Mutex<Connection>>`).
///
/// Message bodies are encrypted at rest via [`ryu_crypto::FieldCipher`]: the
/// `content` column holds the `enc:v1:` envelope, written on append and decrypted
/// transparently on read. Rows written before encryption was introduced have no
/// envelope and are passed through unchanged (lazy migration). Metadata (ids,
/// roles, timestamps) stays plaintext so listing/ordering/sync still work.
#[derive(Clone)]
pub struct ConversationStore {
    conn: Arc<Mutex<Connection>>,
    cipher: ryu_crypto::FieldCipher,
    /// Whether chat messages are opted into the Memory app's source index.
    /// The preference is process-local here so the search UI and background
    /// Dream routes share one gate without reopening the preferences database.
    chat_memory_enabled: Arc<AtomicBool>,
    /// Optional semantic index over message bodies, backing the
    /// `search_conversations` builtin tool. `None` in contexts that don't wire it
    /// (tests, CLI, headless). Indexing on append and lazy backfill on search are
    /// both best-effort: a failure here never affects message CRUD.
    message_index: Option<ryu_search::MessageIndex>,
    /// Optional full-text (FTS5) index over message bodies — the lexical/keyword
    /// complement to `message_index` (semantic KNN), backing the FTS session-search
    /// recall layer. `None` in contexts that don't wire it (tests, CLI, headless).
    /// Unlike the semantic index it needs NO embedder, so its lazy backfill on
    /// search is network-free. Population is DEFAULT-OFF: it only ever runs when the
    /// FTS recall pref is enabled (search is the sole writer, via lazy backfill), so
    /// the on-disk term index materializes only for users who opt in.
    message_fts: Option<ryu_search::MessageFtsIndex>,
    semantic_backfill: Arc<Mutex<bool>>,
    fts_backfill: Arc<Mutex<bool>>,
    /// Source messages the search-index backfill skipped because their sealed
    /// body did not open (never indexed as placeholder text).
    index_unreadable: Arc<AtomicU64>,
    /// Harness-run rows a list skipped because a sealed field did not open.
    harness_unreadable: Arc<AtomicU64>,
    #[cfg(test)]
    content_reads: Arc<std::sync::atomic::AtomicUsize>,
    /// Optional room-keyed realtime registry (Phase 1 of the multi-user epic).
    /// When wired, [`append_message`] publishes an `Events` frame keyed by the
    /// conversation id so other live viewers see new turns immediately. `None` in
    /// contexts without realtime fan-out (tests, CLI). Cloned from the same
    /// instance held by `ServerState` so publishes reach the WS handler's
    /// subscribers (see `main.rs` wiring). Best-effort: publishing to a room with
    /// no members is a harmless no-op.
    realtime: Option<ryu_realtime::RoomRegistry>,
    /// Conversations that were still `running` when this store was opened, i.e.
    /// turns the previous process died in the middle of. Captured once at boot,
    /// before reconciliation flips them to `interrupted`, and drained by the
    /// boot auto-resume task. A live Kill Switch pause never adds to it.
    boot_interrupted: Arc<std::sync::Mutex<Vec<String>>>,
}

/// Outcome of [`ConversationStore::claim_interrupted_run_for_auto_resume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoResumeClaim {
    /// The run moved from `interrupted` to `running` at `claimed_at` (the
    /// conversation's new `updated_at`); this is `attempt` n for the turn.
    Claimed { attempt: u32, claimed_at: i64 },
    /// Something else already moved the run off `interrupted` (a desktop
    /// retry, a new user turn, a deletion).
    NotInterrupted,
    /// This user turn already used its automatic-resume budget.
    Exhausted,
    /// The conversation belongs to a person (`owner_user_id` or `org_id` is
    /// set). A detached resume has no verified caller, JWT, or author to run
    /// it as, so it would run with node authority instead of the author's;
    /// the run stays `interrupted` for the author to retry.
    Attributed,
}

/// A run's lifecycle status changed. Carries the FULL run summary (not just id +
/// status) so a snapshot-first `/api/runs/stream` subscriber can render completion
/// notifications (title/folder/branch) with no follow-up fetch, and so runs that
/// start *after* a client connects still arrive with complete metadata.
#[derive(Clone, Debug, Serialize)]
pub struct RunStatusEvent {
    pub run: ConversationSummary,
}

/// Process-global run-status broadcast. Self-initialises on first use (nothing to
/// wire at startup), mirroring [`crate::events`]. [`ConversationStore::set_run_status`]
/// publishes here; the `/api/runs/stream` SSE endpoint subscribes.
fn run_events_sender() -> &'static tokio::sync::broadcast::Sender<RunStatusEvent> {
    static RUN_EVENTS: OnceLock<tokio::sync::broadcast::Sender<RunStatusEvent>> = OnceLock::new();
    RUN_EVENTS.get_or_init(|| tokio::sync::broadcast::channel(128).0)
}

/// Subscribe to run lifecycle status changes (used by the `/api/runs/stream` SSE
/// endpoint). A missed delta self-heals from the stream's opening snapshot.
pub fn subscribe_run_events() -> tokio::sync::broadcast::Receiver<RunStatusEvent> {
    run_events_sender().subscribe()
}

/// A replay notification for the versioned harness event journal. The SQLite
/// row is the source of truth; this process-local bus only wakes live SSE
/// subscribers so they can fetch the next durable cursor without polling.
fn harness_events_sender() -> &'static tokio::sync::broadcast::Sender<RunEventEnvelope> {
    static HARNESS_EVENTS: OnceLock<tokio::sync::broadcast::Sender<RunEventEnvelope>> =
        OnceLock::new();
    HARNESS_EVENTS.get_or_init(|| tokio::sync::broadcast::channel(256).0)
}

/// Subscribe to durable harness event notifications.
pub fn subscribe_harness_events() -> tokio::sync::broadcast::Receiver<RunEventEnvelope> {
    harness_events_sender().subscribe()
}

/// Where a replayed message sits in its source's version tree, as the source
/// described it. Read by [`ConversationStore::link_synced_messages`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncParent {
    /// The source sent no tree position: an older peer, or a never-branched
    /// source whose rows are flat. The row continues the receiver's thread.
    Unknown,
    /// The source's row is a genuine root of its version tree (a first turn, or
    /// an edited first turn).
    Root,
    /// The source's row was produced in reply to this message.
    Message(String),
}

/// One replayed message and its source tree position, in payload order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncLink {
    pub id: String,
    pub parent: SyncParent,
}

/// Union-find over the version tree while [`ConversationStore::link_synced_messages`]
/// links one replay, so a relayed payload cannot store a parent loop. Each
/// visited row's parent is read once and path-compressed, which keeps repeated
/// walks over a long thread near-linear.
#[derive(Default)]
struct VersionAncestry {
    up: std::collections::HashMap<String, Option<String>>,
}

impl VersionAncestry {
    /// The root of `id`'s tree, or `None` when its ancestor chain loops.
    fn root(
        &mut self,
        parent_of: &mut rusqlite::CachedStatement<'_>,
        conversation_id: &str,
        id: &str,
    ) -> Result<Option<String>> {
        let mut path = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut current = id.to_owned();
        loop {
            if !seen.insert(current.clone()) {
                return Ok(None);
            }
            let next = if let Some(next) = self.up.get(&current) {
                next.clone()
            } else {
                let next = parent_of
                    .query_row(params![current, conversation_id], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .optional()
                    .context("walking synced ancestry")?
                    .flatten();
                self.up.insert(current.clone(), next.clone());
                next
            };
            let Some(next) = next else {
                break;
            };
            path.push(std::mem::replace(&mut current, next));
        }
        for node in path {
            self.up.insert(node, Some(current.clone()));
        }
        Ok(Some(current))
    }

    /// Whether parenting `child` (a root of its own tree) on `parent` keeps the
    /// tree acyclic: `parent` must not descend from `child`.
    fn extends_tree(
        &mut self,
        parent_of: &mut rusqlite::CachedStatement<'_>,
        conversation_id: &str,
        parent: &str,
        child: &str,
    ) -> Result<bool> {
        let parent_root = self.root(parent_of, conversation_id, parent)?;
        let child_root = self.root(parent_of, conversation_id, child)?;
        Ok(parent_root.is_some() && parent_root != child_root)
    }

    /// Record a link the caller just wrote.
    fn link(&mut self, child: &str, parent: &str) {
        self.up.insert(child.to_owned(), Some(parent.to_owned()));
    }
}

/// The result of [`ConversationStore::rewind_to_message`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewoundTurn {
    /// The new active leaf; `None` when the first turn was rewound.
    pub active_leaf_message_id: Option<String>,
    /// The rewound user message's text, for the composer.
    pub text: String,
}

/// Which moment a chat checkpoint captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatCheckpointKind {
    /// Taken before the agent ran a user turn.
    Turn,
    /// Taken immediately before a rewind restored files, so it can be undone.
    PreRestore,
}

impl ChatCheckpointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::PreRestore => "pre_restore",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "pre_restore" {
            Self::PreRestore
        } else {
            Self::Turn
        }
    }
}

/// One `chat_checkpoints` row.
#[derive(Debug, Clone)]
pub struct ChatCheckpointRecord {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub kind: ChatCheckpointKind,
    pub workspace: Option<String>,
    pub commit_id: Option<String>,
    pub skip_reason: Option<String>,
    pub created_at: i64,
}

/// The public projection of a chat checkpoint.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatCheckpoint {
    pub id: String,
    /// User message the checkpoint was taken before (`turn` checkpoints).
    pub message_id: Option<String>,
    pub kind: ChatCheckpointKind,
    /// Folder the snapshot covers; absent when the chat has no folder.
    pub workspace: Option<String>,
    /// Whether file contents were captured and can be restored.
    pub has_files: bool,
    /// Why files were not captured, when they were not.
    pub skip_reason: Option<String>,
    /// First characters of the user message.
    pub preview: Option<String>,
    /// RFC 3339 UTC.
    pub created_at: String,
}

impl ChatCheckpoint {
    pub fn from_record(record: ChatCheckpointRecord, preview: Option<String>) -> Self {
        Self {
            id: record.id,
            message_id: record.message_id,
            kind: record.kind,
            workspace: record.workspace,
            has_files: record.commit_id.is_some(),
            skip_reason: record.skip_reason,
            preview,
            created_at: chrono::DateTime::from_timestamp_millis(record.created_at)
                .unwrap_or_default()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

fn chat_checkpoint_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatCheckpointRecord> {
    Ok(ChatCheckpointRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        message_id: row.get(2)?,
        kind: ChatCheckpointKind::parse(&row.get::<_, String>(3)?),
        workspace: row.get(4)?,
        commit_id: row.get(5)?,
        skip_reason: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// What a bulk chat clear removed: the conversation count, and per removed
/// conversation the residue it leaves outside the store, so the caller can
/// release it as a single delete does.
#[derive(Debug, Default)]
pub struct ClearedConversations {
    pub removed: u64,
    pub residue: Vec<ClearedConversationResidue>,
}

/// One cleared conversation's id (its agent transcripts are kept under it) and
/// the folders whose checkpoint stores pin snapshots for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearedConversationResidue {
    pub conversation_id: String,
    pub checkpoint_workspaces: Vec<PathBuf>,
}

/// The residue a bulk clear is about to remove: every conversation (`owner` is
/// `None`) or only the ones `owner` owns (strict owner match), plus any
/// checkpoint rows those clears delete. Callers hold the connection lock across
/// this read and the deletes.
fn cleared_conversation_residue(
    conn: &Connection,
    owner: Option<&str>,
) -> Result<Vec<ClearedConversationResidue>> {
    const OWNED: &str = "SELECT id FROM conversations WHERE owner_user_id = ?1";
    let mut by_id: std::collections::BTreeMap<String, Vec<PathBuf>> =
        std::collections::BTreeMap::new();
    let (ids_sql, folders_sql) = match owner {
        None => (
            "SELECT id FROM conversations".to_owned(),
            "SELECT DISTINCT conversation_id, workspace FROM chat_checkpoints
             WHERE commit_id IS NOT NULL AND workspace IS NOT NULL
             ORDER BY conversation_id, workspace"
                .to_owned(),
        ),
        Some(_) => (
            OWNED.to_owned(),
            format!(
                "SELECT DISTINCT conversation_id, workspace FROM chat_checkpoints
                 WHERE commit_id IS NOT NULL AND workspace IS NOT NULL
                   AND conversation_id IN ({OWNED})
                 ORDER BY conversation_id, workspace"
            ),
        ),
    };
    let params: Vec<&dyn rusqlite::ToSql> = match &owner {
        None => Vec::new(),
        Some(owner) => vec![owner],
    };
    {
        let mut stmt = conn.prepare(&ids_sql)?;
        let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, String>(0))?;
        for id in rows {
            by_id.entry(id?).or_default();
        }
    }
    {
        let mut stmt = conn.prepare(&folders_sql)?;
        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, workspace) = row?;
            by_id.entry(id).or_default().push(PathBuf::from(workspace));
        }
    }
    Ok(by_id
        .into_iter()
        .map(
            |(conversation_id, checkpoint_workspaces)| ClearedConversationResidue {
                conversation_id,
                checkpoint_workspaces,
            },
        )
        .collect())
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// One saved generative-UI widget state (see
/// [`ConversationStore::set_agent_ui_state`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentUiState {
    pub tool_call_id: String,
    /// The desktop renderer's saved record; opaque to Core.
    pub state: serde_json::Value,
    /// Unix milliseconds of the last save.
    pub updated_at: i64,
}

/// Upper bound on saved generative-UI widget states per conversation, so the
/// state endpoint can't be used as an unbounded per-conversation write sink.
pub const MAX_AGENT_UI_STATES: i64 = 500;

/// Whether `message_id` names a persisted message *of this conversation*. The
/// existence gate every `message_reactions` write runs first: FK enforcement is
/// off on this database (deletes are manual), so without it any string would
/// insert an orphan reaction row, and a cross-conversation id would react into a
/// thread the caller was never authorized against.
fn message_in_conversation(
    conn: &Connection,
    conversation_id: &str,
    message_id: &str,
) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("checking message membership")?;
    Ok(found.is_some())
}

/// The `ryu_content_seal` store name under which `conversations.db` records the
/// scrub owed for run text older builds kept in plaintext.
const RUN_TEXT_STORE: &str = "conversations.db";

/// Default on-disk location for the conversation database (`~/.ryu/conversations.db`).
fn default_db_path() -> PathBuf {
    crate::paths::db_path("conversations.db")
}

impl ConversationStore {
    /// Isolated file-backed test storage using the same fixed test cipher as
    /// `open_in_memory`, without touching the global host/keychain.
    #[cfg(test)]
    pub(crate) fn open_hook_test_file(path: PathBuf) -> Result<Self> {
        let mut store = Self::open_in_memory()?;
        let conn = Connection::open(path)?;
        Self::init_schema(&conn)?;
        store.conn = Arc::new(Mutex::new(conn));
        Ok(store)
    }

    /// Open (or create) the conversation store at the default path and run migrations.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the conversation store at a specific path.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening conversation db {}", path.display()))?;
        // Deleted and rewritten cells (sealed or legacy plaintext) are zeroed
        // from now on. What older builds freed without it is scrubbed below.
        conn.pragma_update(None, "secure_delete", "ON")
            .context("enabling secure_delete on the conversation db")?;
        Self::init_schema(&conn)?;
        let cipher = ryu_crypto::global_cipher()?;
        // One-shot tenancy backfill for rows that pre-date the per-resource ACL.
        // Deliberately NOT in `init_schema` (which the in-memory test store also
        // runs — it must never read the real account vault) and best-effort: a
        // failure here must never stop the node from opening its chat db.
        if let Err(e) = Self::backfill_tenancy(&conn) {
            tracing::warn!("conversation tenancy backfill skipped: {e:#}");
        }
        // Nothing else can close the books on a turn the node died in the middle
        // of: `set_run_status` only ever runs from the turn lifecycle, so a killed
        // process leaves the conversation at `running` and its half-written
        // assistant row looking finished. Same placement + best-effort rule as the
        // backfill above (out of `init_schema`, warn on failure, never blocks the
        // node opening its chat db), but deliberately NOT marker-gated: every crash
        // produces new stuck rows, so this has to run on every boot.
        //
        // Remember which conversations those were first, so the boot auto-resume
        // task can pick their turns back up once the runtime is ready.
        let boot_interrupted = Self::list_running_conversations(&conn).unwrap_or_else(|e| {
            tracing::warn!("could not list interrupted runs for auto-resume: {e:#}");
            Vec::new()
        });
        if let Err(e) = Self::reconcile_interrupted_runs(&mut conn, &cipher) {
            tracing::warn!("interrupted-run reconciliation skipped: {e:#}");
        }
        // Run errors and fallback warnings written before they were sealed,
        // then the scrub of the plaintext they and older deletes left behind.
        // Best-effort: reads accept both forms, and an unfinished scrub stays
        // recorded, so a failure only defers the work to the next start.
        if let Err(e) = Self::seal_and_scrub_legacy_run_text(&conn, &path, &cipher) {
            tracing::warn!("sealing legacy run errors deferred: {e:#}");
        }
        let compaction_owed =
            ryu_crypto::content_sqlite::compaction_owed(&conn, RUN_TEXT_STORE).unwrap_or(false);
        let conn = Arc::new(Mutex::new(conn));
        if compaction_owed {
            Self::defer_compaction(&conn, path);
        }
        Ok(Self {
            conn,
            cipher,
            chat_memory_enabled: Arc::new(AtomicBool::new(false)),
            message_index: None,
            message_fts: None,
            semantic_backfill: Arc::new(Mutex::new(false)),
            fts_backfill: Arc::new(Mutex::new(false)),
            index_unreadable: Arc::new(AtomicU64::new(0)),
            harness_unreadable: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            content_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            realtime: None,
            boot_interrupted: Arc::new(std::sync::Mutex::new(boot_interrupted)),
        })
    }

    /// Decide, once, what a pre-existing NULL-tenancy conversation row MEANS.
    ///
    /// Before the per-resource ACL was populated, every conversation row was
    /// created with `owner_user_id` and `org_id` NULL. `resource_access`
    /// (`server/mod.rs`) reads an untenanted row as "the local single-user row":
    /// full access on an UNBOUND node, DENIED on an ORG-BOUND (shared) one. So:
    ///
    ///   - **Node UNBOUND** (no `registered_org()`): return immediately, stamping
    ///     nothing. There is exactly one principal on a personal node and the node
    ///     token is the boundary (the same rule `enforce_permission` already
    ///     applies), so scoping rows there would buy no security and would lock the
    ///     owner out of their own chats whenever the control plane is unreachable
    ///     and their JWT cannot be minted. The marker is NOT written, so this reruns
    ///     (and does the real work) if the node later joins an org.
    ///   - **Node ORG-BOUND**: attribute every untenanted row to the LOCAL OWNER —
    ///     the signed-in account in the vault — because those chats were had by
    ///     whoever was sitting at this node before it was shared. Idempotent via the
    ///     `conv_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: there is nobody to attribute
    ///     them to. Leave them NULL and warn. Combined with the ACL's
    ///     untenanted-row-on-a-bound-node DENY they become unreachable (data intact
    ///     on disk, recoverable by an explicit admin action) rather than readable by
    ///     every member of the org. Fail closed.
    fn backfill_tenancy(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conv_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating conv_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM conv_meta WHERE key = 'tenancy_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }

        // Unbound (personal) node: rows stay untenanted, by design. Not marked done.
        let Some(org) = crate::sidecar::control_plane::registered_org() else {
            return Ok(());
        };

        let Some(owner) = crate::auth::load_accounts()
            .active()
            .map(|a| a.user_id.clone())
        else {
            let orphans: i64 = conn.query_row(
                "SELECT COUNT(*) FROM conversations
                 WHERE owner_user_id IS NULL AND org_id IS NULL",
                [],
                |r| r.get(0),
            )?;
            if orphans > 0 {
                tracing::warn!(
                    "tenancy backfill: {orphans} pre-ACL conversation(s) on an org-bound node with \
                     no signed-in local account to attribute them to — leaving them untenanted, \
                     which the per-resource ACL denies (fail closed). Sign in and restart to claim them."
                );
            }
            return Ok(());
        };

        let claimed = conn
            .execute(
                "UPDATE conversations SET owner_user_id = ?1, org_id = ?2
                 WHERE owner_user_id IS NULL AND org_id IS NULL",
                params![owner, org.id],
            )
            .context("backfilling conversation tenancy")?;
        conn.execute(
            "INSERT OR REPLACE INTO conv_meta (key, value) VALUES ('tenancy_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!(
            "tenancy backfill: attributed {claimed} pre-ACL conversation(s) to the local owner"
        );
        Ok(())
    }

    /// Close the books, at boot, on turns this node died in the middle of.
    ///
    /// A turn's status is written by the streaming loop at exactly two terminal
    /// points (`completed` / `failed`), so a process that is killed mid-stream —
    /// crash, force-quit, OOM, power loss — leaves the conversation parked at
    /// `running` forever and its assistant row holding only what had been flushed.
    /// Nothing downstream can tell that row apart from a finished answer that just
    /// happens to stop mid-sentence. At startup a `running` row means its producer
    /// died with the process. During a live Kill Switch action, Core first signals
    /// every producer, then marks the still-running rows interrupted.
    ///
    /// Three statements, in this order:
    ///   1. flag the trailing assistant message of every `running` conversation
    ///      (it is the row that was being written when the node went down), and
    ///   2. move the conversation itself off `running`.
    ///   3. close any durable harness run that was still live and append its
    ///      terminal `run_interrupted` event in the same transaction.
    /// The message pass keys off `run_status = 'running'`, so flipping the status
    /// first would flag nothing.
    ///
    /// Raw SQL rather than a `set_run_status` loop on purpose. The caller handling
    /// a live pause publishes summaries after this batch write; boot reconciliation
    /// has no subscribers yet and should not pay for those summary loads.
    ///
    /// Returns `(runs_reconciled, messages_flagged)` for the log line.
    fn reconcile_interrupted_runs(
        conn: &mut Connection,
        cipher: &ryu_crypto::FieldCipher,
    ) -> Result<(usize, usize)> {
        let flagged = conn
            .execute(
                "UPDATE messages SET interrupted = 1
                 WHERE id IN (
                     SELECT m.id FROM messages m
                     JOIN conversations c ON c.id = m.conversation_id
                     WHERE c.run_status = 'running'
                       AND m.role = 'assistant'
                       AND m.id = (
                           SELECT m2.id FROM messages m2
                           WHERE m2.conversation_id = c.id
                           ORDER BY m2.created_at DESC, m2.rowid DESC
                           LIMIT 1
                       )
                 )",
                [],
            )
            .context("flagging interrupted assistant messages")?;
        let runs = conn
            .execute(
                "UPDATE conversations SET run_status = 'interrupted' WHERE run_status = 'running'",
                [],
            )
            .context("reconciling interrupted run statuses")?;

        // A harness run has a separate lifecycle from the legacy conversation
        // row. Reconcile both together so a restarted node cannot leave the
        // cursorable event stream parked forever without a terminal event.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting harness interruption transaction")?;
        let stuck: Vec<(String, String, i64)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, session_id, event_seq FROM harness_runs
                     WHERE status IN ('running', 'awaiting_approval')",
                )
                .context("listing interrupted harness runs")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let harness_runs = stuck.len();
        let now = now_millis();
        for (run_id, session_id, current_seq) in stuck {
            let next_seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
            let event = build_harness_event(
                &run_id,
                &session_id,
                next_seq,
                now,
                RunEvent::RunInterrupted,
            );
            insert_harness_event(&tx, cipher, &event)
                .with_context(|| format!("appending interruption for harness run {run_id}"))?;
            tx.execute(
                "UPDATE harness_runs
                 SET status = 'interrupted', event_seq = ?1, finished_at = ?2
                 WHERE id = ?3 AND status IN ('running', 'awaiting_approval')",
                params![i64::try_from(next_seq).unwrap_or(i64::MAX), now, run_id,],
            )?;
            tx.execute(
                "UPDATE sessions SET status = 'failed', updated_at = ?1
                 WHERE id = ?2 AND status = 'running'",
                params![now, session_id],
            )?;
        }
        tx.commit()
            .context("committing harness interruption transaction")?;
        if runs > 0 || harness_runs > 0 {
            tracing::info!(
                "run reconciliation: {runs} conversation(s) and {harness_runs} harness run(s) \
                 were still live at boot ({flagged} truncated assistant message(s) marked interrupted)"
            );
        }
        Ok((runs + harness_runs, flagged))
    }

    /// Ids of conversations parked at `running`, oldest turn first. Only
    /// meaningful at boot, where `running` means the producer died with the
    /// previous process.
    fn list_running_conversations(conn: &Connection) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM conversations WHERE run_status = 'running'
                 ORDER BY updated_at ASC, rowid ASC",
            )
            .context("listing running conversations")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading running conversations")
    }

    /// Take the conversations whose turns the previous process died in the
    /// middle of. Returns them once; later calls get an empty list.
    pub fn take_boot_interrupted_runs(&self) -> Vec<String> {
        self.boot_interrupted
            .lock()
            .map(|mut ids| std::mem::take(&mut *ids))
            .unwrap_or_default()
    }

    /// Atomically move an `interrupted` run back to `running` for one automatic
    /// resume of the user turn `user_message_id`.
    ///
    /// The attempt is recorded in the same transaction as the status flip, so
    /// it is durable before any model work starts: if the resumed turn takes
    /// the node down again, the next boot sees the spent attempt. A different
    /// `user_message_id` than the recorded one starts a fresh budget.
    ///
    /// The conditional status update is the duplicate-work guard against a
    /// desktop reconnect retry racing this claim, the same way
    /// [`Self::claim_terminal_run_for_retry`] guards two desktop windows.
    ///
    /// Only node-owned (untenanted) conversations are claimed: a conversation
    /// with an owner or org returns [`AutoResumeClaim::Attributed`] untouched.
    pub async fn claim_interrupted_run_for_auto_resume(
        &self,
        conversation_id: &str,
        user_message_id: &str,
        max_attempts: u32,
    ) -> Result<AutoResumeClaim> {
        let now = now_millis();
        let claim = {
            let mut conn = self.conn.lock().await;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .context("starting auto-resume claim")?;
            let previous: Option<(String, i64)> = tx
                .query_row(
                    "SELECT user_message_id, attempts FROM run_auto_resume
                     WHERE conversation_id = ?1",
                    params![conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .context("reading auto-resume attempts")?;
            let spent = previous
                .filter(|(message_id, _)| message_id == user_message_id)
                .map_or(0, |(_, attempts)| {
                    u32::try_from(attempts.max(0)).unwrap_or(u32::MAX)
                });
            let attributed: bool = tx
                .query_row(
                    "SELECT owner_user_id IS NOT NULL OR org_id IS NOT NULL
                     FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading conversation tenancy")?
                .unwrap_or(false);
            let claim = if attributed {
                AutoResumeClaim::Attributed
            } else if spent >= max_attempts {
                AutoResumeClaim::Exhausted
            } else {
                let moved = tx
                    .execute(
                        "UPDATE conversations
                         SET run_status = 'running', updated_at = ?1
                         WHERE id = ?2 AND run_status = 'interrupted'
                           AND owner_user_id IS NULL AND org_id IS NULL",
                        params![now, conversation_id],
                    )
                    .context("claiming interrupted run")?;
                if moved == 1 {
                    let attempt = spent + 1;
                    tx.execute(
                        "INSERT INTO run_auto_resume
                             (conversation_id, user_message_id, attempts, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(conversation_id) DO UPDATE SET
                             user_message_id = excluded.user_message_id,
                             attempts = excluded.attempts,
                             updated_at = excluded.updated_at",
                        params![conversation_id, user_message_id, i64::from(attempt), now],
                    )
                    .context("recording auto-resume attempt")?;
                    AutoResumeClaim::Claimed {
                        attempt,
                        claimed_at: now,
                    }
                } else {
                    AutoResumeClaim::NotInterrupted
                }
            };
            tx.commit().context("committing auto-resume claim")?;
            claim
        };
        if matches!(claim, AutoResumeClaim::Claimed { .. }) {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(claim)
    }

    /// Close an auto-resumed run whose turn ended before it ever started.
    ///
    /// A turn that gets going writes `running` again (bumping `updated_at`)
    /// and later its own terminal status. One rejected up front (an agent that
    /// no longer exists, a Kill Switch pause) writes nothing, which would leave
    /// the claim's `running` in place with no producer behind it. Matching on
    /// the claim's own `updated_at` makes this a no-op for every turn that
    /// started, and for any newer turn in the same conversation.
    pub async fn fail_unstarted_auto_resume(
        &self,
        conversation_id: &str,
        claimed_at: i64,
    ) -> Result<bool> {
        let failed = {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations
                 SET run_status = 'failed', updated_at = ?1
                 WHERE id = ?2 AND run_status = 'running' AND updated_at = ?3",
                params![now_millis(), conversation_id, claimed_at],
            )
            .context("failing unstarted auto-resume")?
                == 1
        };
        if failed {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(failed)
    }

    /// Preference key shared by Core's preference route and the Memory app.
    pub const CHAT_MEMORY_ENABLED_PREF_KEY: &'static str = "chat-memory-enabled";

    /// Parse the persisted Memory source-index flag defensively. Only explicit
    /// truthy values enable it; unset or malformed values stay opt-in-off.
    pub fn parse_chat_memory_enabled(raw: Option<&str>) -> bool {
        matches!(
            raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
            Some("true") | Some("1") | Some("on") | Some("yes")
        )
    }

    /// Whether chat messages are currently opted into Memory search/Dream.
    pub fn chat_memory_enabled(&self) -> bool {
        self.chat_memory_enabled.load(Ordering::Acquire)
    }

    /// Update the process-local Memory source-index gate after a preference
    /// write. The preference store remains the durable source of truth.
    pub async fn set_chat_memory_enabled(&self, enabled: bool) -> Result<()> {
        self.chat_memory_enabled.store(enabled, Ordering::Release);
        Ok(())
    }

    /// Clear the derived semantic message index while retaining the encrypted
    /// conversation transcript. Re-enabling chat memory can backfill it again.
    pub async fn clear_message_embeddings(&self) -> anyhow::Result<()> {
        {
            let mut initialized = self.semantic_backfill.lock().await;
            if let Some(index) = self.message_index.clone() {
                index.clear().await?;
            }
            *initialized = false;
        }
        // The keyword index is derived from the same messages: turning chat
        // memory off empties it too (its blind tokens still reveal which
        // messages share words).
        let mut initialized = self.fts_backfill.lock().await;
        if let Some(index) = self.message_fts.clone() {
            index.clear().await?;
        }
        *initialized = false;
        Ok(())
    }

    /// Recall diagnostics for the conversation indexes: how much of the
    /// semantic index is searchable from memory (`vector_coverage`), and how many
    /// rows were skipped because a sealed value did not open.
    pub fn search_index_diagnostics(&self) -> serde_json::Value {
        let coverage = self
            .message_index
            .as_ref()
            .map(ryu_search::MessageIndex::vector_coverage);
        serde_json::json!({
            "vector_coverage": coverage,
            "unreadable": {
                "message_embeddings": self
                    .message_index
                    .as_ref()
                    .map_or(0, ryu_search::MessageIndex::unreadable_rows),
                "source_messages": self.index_unreadable.load(Ordering::Relaxed),
                "harness_runs": self.harness_unreadable.load(Ordering::Relaxed),
            },
        })
    }

    /// Seal legacy run text ([`Self::seal_legacy_run_text`]), then scrub the
    /// plaintext it leaves on disk. Older builds wrote run errors and fallback
    /// warnings in plaintext without `secure_delete`, so rows they deleted (and
    /// the old cells this reseal rewrites) can remain in free pages, inside
    /// partly used pages and in stale WAL frames. The debt is recorded in
    /// `ryu_content_seal` (store [`RUN_TEXT_STORE`], no key check value) before
    /// anything is rewritten: on the first open by a sealing build, and with
    /// every reseal. While it is recorded, `content_sqlite` truncates the WAL,
    /// zeroes the freelist and vacuums the file when it fits the size and
    /// free-space gates; a gated vacuum stays `vacuum_pending` and is retried at
    /// a later start. Call only while `conn` is the store's one open connection.
    fn seal_and_scrub_legacy_run_text(
        conn: &Connection,
        path: &std::path::Path,
        cipher: &ryu_crypto::FieldCipher,
    ) -> Result<()> {
        use ryu_crypto::content_sqlite;
        let first_open = content_sqlite::read_store_record(conn, RUN_TEXT_STORE)?.is_none();
        if first_open {
            Self::mark_run_text_scrub_owed(conn)?;
        }
        let sealed = Self::seal_legacy_run_text(conn, cipher)?;
        if first_open || sealed > 0 {
            content_sqlite::finish_store(conn, path, RUN_TEXT_STORE)?;
        } else {
            content_sqlite::run_pending_vacuum_gated(conn, path, RUN_TEXT_STORE)?;
        }
        Ok(())
    }

    /// Hand a compaction too large for the boot path to the background
    /// compaction worker: it runs later under this store's connection lock, so
    /// requests wait for it instead of the boot.
    fn defer_compaction(conn: &Arc<Mutex<Connection>>, path: PathBuf) {
        let weak = Arc::downgrade(conn);
        ryu_crypto::content_sqlite::defer_compaction(
            RUN_TEXT_STORE,
            Box::new(move || {
                let conn = weak.upgrade()?;
                let conn = conn.blocking_lock();
                Some(ryu_crypto::content_sqlite::compact_deferred(
                    &conn,
                    &path,
                    RUN_TEXT_STORE,
                ))
            }),
        );
    }

    /// Record that `conversations.db` owes the run-text scrub (keeps an existing
    /// `vacuum_pending` row and its retry time as they are).
    fn mark_run_text_scrub_owed(conn: &Connection) -> Result<()> {
        use ryu_crypto::content_sqlite::{ensure_state_table, states, STATE_TABLE, STORE_ITEM};
        ensure_state_table(conn)?;
        conn.execute(
            &format!(
                "INSERT INTO {STATE_TABLE} (store, item, state, cursor, updated_at)
                 VALUES (?1, ?2, ?3, NULL, strftime('%s', 'now'))
                 ON CONFLICT(store, item) DO UPDATE SET state = excluded.state,
                    cursor = NULL, updated_at = excluded.updated_at
                 WHERE {STATE_TABLE}.state != excluded.state"
            ),
            params![RUN_TEXT_STORE, STORE_ITEM, states::VACUUM_PENDING],
        )
        .context("recording the run-text scrub")?;
        Ok(())
    }

    /// Seal `harness_runs.error`, `channel_turn_idempotency.fallback_warning` and
    /// `scope_guidance.goal` / `.instructions` values written before they were
    /// sealed (compare-and-swap per row).
    /// Returns how many values were sealed; each reseal records the scrub debt
    /// in the same transaction.
    fn seal_legacy_run_text(conn: &Connection, cipher: &ryu_crypto::FieldCipher) -> Result<u64> {
        let mut sealed = 0u64;
        for (table, key, column) in [
            ("harness_runs", "id", "error"),
            (
                "channel_turn_idempotency",
                "idempotency_key",
                "fallback_warning",
            ),
            // Project and bot goals and project instructions are prompt text.
            ("scope_guidance", "scope", "goal"),
            ("scope_guidance", "scope", "instructions"),
        ] {
            let pending: Vec<(String, String)> = {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {key}, {column} FROM {table}
                     WHERE {column} IS NOT NULL AND {column} != '' AND {column} NOT LIKE 'enc:%'"
                ))?;
                let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            if pending.is_empty() {
                continue;
            }
            let tx = conn.unchecked_transaction()?;
            Self::mark_run_text_scrub_owed(&tx)?;
            for (id, plain) in &pending {
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ?1 WHERE {key} = ?2 AND {column} = ?3"),
                    params![cipher.seal(plain)?, id, plain],
                )?;
            }
            tx.commit()?;
            sealed += pending.len() as u64;
            tracing::info!(table, sealed = pending.len(), "sealed legacy run text");
        }
        Ok(sealed)
    }

    /// Open a sealed message body for a derived index. `None` when it does not
    /// open: the caller skips the row (never indexes placeholder text) and the
    /// skip is counted.
    fn open_content_for_index(&self, stored: String) -> Option<String> {
        #[cfg(test)]
        self.content_reads.fetch_add(1, Ordering::Relaxed);
        match self.cipher.open(&stored) {
            Ok(content) => Some(content),
            Err(error) => {
                let total = self.index_unreadable.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    unreadable = total,
                    "search index: skipped a message whose sealed body did not open: {error}"
                );
                None
            }
        }
    }

    /// Wire the semantic message index (backing the `search_conversations` builtin
    /// tool) into the store. Cheap to clone (`Arc` inside). Must be called after
    /// construction to enable indexing-on-append + searchable history.
    pub fn with_message_index(mut self, index: ryu_search::MessageIndex) -> Self {
        self.message_index = Some(index);
        self.semantic_backfill = Arc::new(Mutex::new(false));
        self
    }

    /// Swap the semantic message provider before a coordinated re-embed pass.
    /// Message vectors contain metadata only; the encrypted message body remains
    /// in this store and is decrypted only for the embedding request.
    pub async fn set_message_embedder(
        &self,
        embedder: std::sync::Arc<dyn ryu_search::SearchEmbedder>,
    ) -> anyhow::Result<()> {
        let mut initialized = self.semantic_backfill.lock().await;
        if let Some(index) = self.message_index.clone() {
            index.set_embedder(embedder).await?;
        }
        // A dimension change clears the vector table, requiring a new backfill.
        // Same-width stale vectors are handled by the coordinated re-embed pass.
        *initialized = false;
        Ok(())
    }

    /// Re-embed stale message vectors using the current semantic provider.
    /// The conversation DB mutex is released before each provider call, and
    /// indexing remains best-effort per message so one malformed/deleted row
    /// cannot strand the rest of the pass.
    pub async fn reindex_message_embeddings(&self) -> anyhow::Result<usize> {
        let _backfill = self.semantic_backfill.lock().await;
        if !self.chat_memory_enabled() {
            return Ok(0);
        }
        let Some(index) = self.message_index.clone() else {
            return Ok(0);
        };
        let embedder = index.embedder();
        let stale = index
            .stale_ids(embedder.model_id(), embedder.dims())
            .await?;
        let indexed = index.indexed_ids().await?;
        if stale.is_empty() && indexed.len() == 0 {
            return Ok(0);
        }
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare("SELECT id, conversation_id, role, content, created_at FROM messages")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            let mut pending = Vec::new();
            for row in rows {
                let (id, conversation_id, role, sealed, created_at) = row?;
                if stale.contains(&id) || !indexed.contains(&id) {
                    let Some(content) = self.open_content_for_index(sealed) else {
                        continue;
                    };
                    if !content.trim().is_empty() {
                        pending.push((id, conversation_id, role, content, created_at));
                    }
                }
            }
            pending
        };
        let model = embedder.model_id().to_owned();
        let mut updated = 0;
        for (id, conversation_id, role, content, created_at) in rows {
            let vector = embedder.embed(&content).await?;
            index
                .index_message(&id, &conversation_id, &role, &vector, &model, created_at)
                .await?;
            updated += 1;
        }
        Ok(updated)
    }

    /// Wire the full-text (FTS5) message index (backing the FTS session-search
    /// recall layer) into the store. Cheap to clone (`Arc` inside). Mirrors
    /// [`with_message_index`]. Population is lazy-on-search and default-OFF, so
    /// wiring the index alone materializes nothing until a search runs under the
    /// enabled FTS recall pref.
    pub fn with_message_fts_index(mut self, index: ryu_search::MessageFtsIndex) -> Self {
        self.message_fts = Some(index);
        self.fts_backfill = Arc::new(Mutex::new(false));
        self
    }

    /// Wire the room-keyed realtime registry so [`append_message`] publishes a
    /// live `Events` frame (keyed by conversation id) for every persisted turn.
    /// Pass a clone of the same [`ryu_realtime::RoomRegistry`] held by
    /// `ServerState` so the frames reach the WS handler's subscribers. Must be
    /// called after construction.
    pub fn with_realtime(mut self, realtime: ryu_realtime::RoomRegistry) -> Self {
        self.realtime = Some(realtime);
        self
    }

    /// Open an in-memory store (used by tests). Uses an ephemeral key so tests
    /// never touch the real keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::FieldCipher::new(&[0x11; 32]),
            chat_memory_enabled: Arc::new(AtomicBool::new(false)),
            message_index: None,
            message_fts: None,
            semantic_backfill: Arc::new(Mutex::new(false)),
            fts_backfill: Arc::new(Mutex::new(false)),
            index_unreadable: Arc::new(AtomicU64::new(0)),
            harness_unreadable: Arc::new(AtomicU64::new(0)),
            content_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            realtime: None,
            boot_interrupted: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        // Pre-release handoff rows were keyed by model change alone. They only
        // cache summaries Core can regenerate, so drop that shape and let the
        // batch below recreate the table keyed by change and branch.
        let handoff_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversation_context_handoffs)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|row| row.ok()).collect()
        };
        if !handoff_columns.is_empty() && !handoff_columns.contains("covered_head_id") {
            conn.execute_batch("DROP TABLE conversation_context_handoffs")
                .context("dropping pre-release context handoff table")?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS conversations (
                 id          TEXT PRIMARY KEY,
                 title       TEXT,
                 agent_id    TEXT,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS conversation_collaborators (
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 user_id         TEXT NOT NULL,
                 role            TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL,
                 PRIMARY KEY (conversation_id, user_id)
             );
             CREATE INDEX IF NOT EXISTS idx_conversation_collaborators_user
                 ON conversation_collaborators(user_id, conversation_id);
             CREATE TABLE IF NOT EXISTS agent_controls (
                 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                 requested_by    TEXT NOT NULL,
                 agent_id        TEXT,
                 model           TEXT,
                 effort          TEXT,
                 requested_at    INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_conversation
                 ON messages(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS proactive_openings (
                 idempotency_key TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 status          TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 completed_at    INTEGER
             );
             CREATE TABLE IF NOT EXISTS channel_turn_idempotency (
                 idempotency_key      TEXT PRIMARY KEY,
                 conversation_id      TEXT NOT NULL,
                 request_hash         TEXT NOT NULL,
                 status               TEXT NOT NULL,
                 reply                TEXT,
                 assistant_message_id TEXT,
                 assistant_message_ids TEXT NOT NULL DEFAULT '[]',
                 agent_id             TEXT,
                 fallback_warning     TEXT,
                 interactive_markup   TEXT,
                 created_at           INTEGER NOT NULL,
                 updated_at           INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_channel_turn_idempotency_updated
                 ON channel_turn_idempotency(updated_at);
             CREATE TABLE IF NOT EXISTS sessions (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 runnable_id     TEXT NOT NULL,
                 runnable_kind   TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'idle',
                 execution_profile TEXT NOT NULL DEFAULT '{}',
                 parent_session_id TEXT,
                 native_session_id TEXT,
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_conversation
                 ON sessions(conversation_id);
             CREATE TABLE IF NOT EXISTS harness_runs (
                 id                TEXT PRIMARY KEY,
                 session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                 parent_run_id     TEXT,
                 status            TEXT NOT NULL DEFAULT 'pending',
                 attempt           INTEGER NOT NULL DEFAULT 1,
                 idempotency_key   TEXT,
                 execution_profile TEXT NOT NULL DEFAULT '{}',
                 input_json        TEXT NOT NULL,
                 output_json       TEXT,
                 error             TEXT,
                 event_seq         INTEGER NOT NULL DEFAULT 0,
                 created_at        INTEGER NOT NULL,
                 started_at        INTEGER,
                 finished_at       INTEGER,
                 UNIQUE(session_id, idempotency_key)
             );
             CREATE INDEX IF NOT EXISTS idx_harness_runs_session
                 ON harness_runs(session_id, created_at DESC);
             -- Boot auto-resume ledger: how many times Core has re-run one user
             -- turn after a crash. Keyed by the turn so a new message starts a
             -- fresh budget, and written before the re-run starts so a turn that
             -- crashes Core again cannot loop forever.
             CREATE TABLE IF NOT EXISTS run_auto_resume (
                 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                 user_message_id TEXT NOT NULL,
                 attempts        INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS harness_run_events (
                 id         TEXT PRIMARY KEY,
                 run_id     TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
                 seq        INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 event_json TEXT NOT NULL,
                 UNIQUE(run_id, seq)
             );
             CREATE INDEX IF NOT EXISTS idx_harness_run_events_run
                 ON harness_run_events(run_id, seq);
             CREATE TABLE IF NOT EXISTS btw_entries (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 kind            TEXT NOT NULL DEFAULT 'btw',
                 question        TEXT NOT NULL,
                 answer          TEXT NOT NULL,
                 model           TEXT,
                 agent_id        TEXT,
                 preset          TEXT,
                 child_conversation_id TEXT,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_btw_conversation
                 ON btw_entries(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS conversation_title_history (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 title           TEXT NOT NULL,
                 source          TEXT NOT NULL,
                 created_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_title_history_conversation
                 ON conversation_title_history(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS message_reactions (
                 message_id      TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 user_id         TEXT NOT NULL,
                 emoji           TEXT NOT NULL,
                 created_at      INTEGER NOT NULL,
                 PRIMARY KEY (message_id, user_id, emoji)
             );
             CREATE INDEX IF NOT EXISTS idx_reactions_conversation
                 ON message_reactions(conversation_id);
             CREATE TABLE IF NOT EXISTS agent_ui_state (
                 conversation_id TEXT NOT NULL,
                 tool_call_id    TEXT NOT NULL,
                 state           TEXT NOT NULL,
                 updated_at      INTEGER NOT NULL,
                 PRIMARY KEY (conversation_id, tool_call_id)
             );
             CREATE TABLE IF NOT EXISTS message_read_receipts (
                 message_id      TEXT NOT NULL,
                 conversation_id TEXT NOT NULL,
                 user_id         TEXT NOT NULL,
                 read_at         INTEGER NOT NULL,
                 PRIMARY KEY (message_id, user_id)
             );
             CREATE INDEX IF NOT EXISTS idx_read_receipts_conversation
                 ON message_read_receipts(conversation_id, message_id);
             CREATE TABLE IF NOT EXISTS conversation_model_changes (
                 sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
                 id             TEXT NOT NULL UNIQUE,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 selection_kind TEXT NOT NULL CHECK (selection_kind IN ('initial', 'change')),
                 provider_id    TEXT,
                 provider_label TEXT,
                 model_id       TEXT,
                 model_label    TEXT,
                 changed_by     TEXT,
                 created_at     INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_model_changes_conversation
                 ON conversation_model_changes(conversation_id, sequence);
             CREATE TABLE IF NOT EXISTS conversation_context_handoffs (
                 id               TEXT PRIMARY KEY,
                 conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 model_change_id  TEXT NOT NULL,
                 covered_head_id  TEXT NOT NULL DEFAULT '',
                 outcome          TEXT NOT NULL CHECK (outcome IN ('applied', 'not_needed')),
                 reason           TEXT NOT NULL,
                 from_model       TEXT,
                 to_model         TEXT,
                 from_context     INTEGER,
                 to_context       INTEGER,
                 summarized_count INTEGER NOT NULL,
                 boundary_at      INTEGER NOT NULL,
                 summary          TEXT,
                 created_at       INTEGER NOT NULL,
                 UNIQUE (model_change_id, covered_head_id)
             );
             CREATE INDEX IF NOT EXISTS idx_context_handoffs_conversation
                 ON conversation_context_handoffs(conversation_id, created_at);
             CREATE TABLE IF NOT EXISTS chat_checkpoints (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 message_id      TEXT,
                 kind            TEXT NOT NULL CHECK (kind IN ('turn', 'pre_restore')),
                 workspace       TEXT,
                 commit_id       TEXT,
                 skip_reason     TEXT,
                 created_at      INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_checkpoints_turn
                 ON chat_checkpoints(conversation_id, message_id) WHERE kind = 'turn';
             CREATE INDEX IF NOT EXISTS idx_chat_checkpoints_conversation
                 ON chat_checkpoints(conversation_id, created_at);",
        )
        .context("initializing conversation schema")?;
        super::conversation_lifecycle::initialize(conn)
            .context("initializing conversation lifecycle identities")?;

        let existing_channel_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(channel_turn_idempotency)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|row| row.ok()).collect()
        };
        if !existing_channel_columns.contains("interactive_markup") {
            conn.execute_batch(
                "ALTER TABLE channel_turn_idempotency ADD COLUMN interactive_markup TEXT",
            )
            .context("adding channel-turn interactive markup column")?;
        }

        // Additive migration: add run-metadata columns to `conversations` that
        // may not exist on databases created before this unit (U013). Each ALTER
        // is guarded by a PRAGMA table_info check so the call is a no-op when
        // the column already exists — safe to run on every startup.
        let existing_conv_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(conversations)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "folder_path",
                "ALTER TABLE conversations ADD COLUMN folder_path   TEXT",
            ),
            (
                "branch",
                "ALTER TABLE conversations ADD COLUMN branch        TEXT",
            ),
            (
                "worktree_path",
                "ALTER TABLE conversations ADD COLUMN worktree_path TEXT",
            ),
            (
                "run_status",
                "ALTER TABLE conversations ADD COLUMN run_status    TEXT",
            ),
            // Multi-agent participants (#414): JSON array of agent_ids.
            // Existing single-agent conversations are back-filled by a trigger in
            // add_participant; new conversations start empty and the primary agent
            // is added on first message.
            (
                "participants",
                "ALTER TABLE conversations ADD COLUMN participants  TEXT NOT NULL DEFAULT '[]'",
            ),
            // Coordinator threads (Codex-style cross-thread orchestration): a
            // coordinator agent can pin a thread to keep it surfaced and archive
            // a finished one to hide it. Both default off so existing
            // conversations are neither pinned nor archived.
            (
                "pinned",
                "ALTER TABLE conversations ADD COLUMN pinned        INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "archived",
                "ALTER TABLE conversations ADD COLUMN archived      INTEGER NOT NULL DEFAULT 0",
            ),
            // Pull requests linked to a chat beyond the one its branch owns: a
            // JSON array of GitHub pull request URLs, written by
            // `set_pull_request_linked`.
            (
                "linked_pull_requests",
                "ALTER TABLE conversations ADD COLUMN linked_pull_requests TEXT NOT NULL DEFAULT '[]'",
            ),
            // Auto-rename (ChatGPT/Claude-style): a conversation's title is first
            // derived from the first user message, then a background task asks the
            // default local model for a concise title and overwrites it. A manual
            // rename (REST/coordinator) sets `title_custom = 1` so the auto-namer
            // never clobbers a user-chosen title. Defaults off → existing
            // conversations are eligible for a one-time auto-name on their next
            // first-user-message (none, since they already have messages).
            (
                "title_custom",
                "ALTER TABLE conversations ADD COLUMN title_custom  INTEGER NOT NULL DEFAULT 0",
            ),
            // Multi-user tenancy (collaboration epic, Phase 0): the verified
            // human owner of the conversation, the org it belongs to, its
            // sharing visibility, and an optional owning team. All nullable
            // except `visibility`, which defaults to 'private' so existing
            // single-tenant conversations stay private. ACL enforcement is wired
            // in a later stage; these are schema-only for now.
            (
                "owner_user_id",
                "ALTER TABLE conversations ADD COLUMN owner_user_id TEXT",
            ),
            (
                "org_id",
                "ALTER TABLE conversations ADD COLUMN org_id        TEXT",
            ),
            (
                "visibility",
                "ALTER TABLE conversations ADD COLUMN visibility    TEXT NOT NULL DEFAULT 'private'",
            ),
            (
                "team_id",
                "ALTER TABLE conversations ADD COLUMN team_id       TEXT",
            ),
            // Channel-backed sessions carry the control-plane config id so Core
            // can distinguish an org-shared bot room from a human conversation
            // when the machine ingress gate runs.
            (
                "channel_id",
                "ALTER TABLE conversations ADD COLUMN channel_id    TEXT",
            ),
            // Imported threads (agent-native history import, Zed/VS Code parity):
            // `origin` marks where a conversation came from (e.g. `import:claude`)
            // and `native_session_id` records the agent's own session/thread id so
            // a future ACP `session/load` can warm-resume the agent's context.
            // Both nullable → existing conversations are native Ryu threads.
            (
                "origin",
                "ALTER TABLE conversations ADD COLUMN origin        TEXT",
            ),
            (
                "native_session_id",
                "ALTER TABLE conversations ADD COLUMN native_session_id TEXT",
            ),
            ("icon", "ALTER TABLE conversations ADD COLUMN icon TEXT"),
            (
                "continued_on",
                "ALTER TABLE conversations ADD COLUMN continued_on TEXT",
            ),
        ] {
            if !existing_conv_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col}"))?;
            }
        }
        hierarchy::migrate(conn, &existing_conv_columns)?;
        scope_guidance::migrate(conn)?;

        // Denormalized message count. Every summary read used a correlated
        // `COUNT(*)` over `messages` per conversation, which walks every index
        // entry of every chat while the store lock is held. Triggers keep the
        // column exact for all writers (appends, imports, sync replay, deletes),
        // and the conversation-insert trigger recounts so messages written before
        // their conversation row still count. The column, backfill and triggers
        // land in one transaction so no database ends up with one but not the
        // others.
        if !existing_conv_columns.contains("message_count") {
            let tx = conn
                .unchecked_transaction()
                .context("starting message_count migration")?;
            tx.execute_batch(
                "ALTER TABLE conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
                 UPDATE conversations SET message_count =
                     (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id);
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_insert
                 AFTER INSERT ON messages BEGIN
                     UPDATE conversations SET message_count = message_count + 1
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_delete
                 AFTER DELETE ON messages BEGIN
                     UPDATE conversations SET message_count = message_count - 1
                      WHERE id = OLD.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_count_after_move
                 AFTER UPDATE OF conversation_id ON messages
                 WHEN OLD.conversation_id IS NOT NEW.conversation_id BEGIN
                     UPDATE conversations SET message_count = message_count - 1
                      WHERE id = OLD.conversation_id;
                     UPDATE conversations SET message_count = message_count + 1
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS conversations_count_after_insert
                 AFTER INSERT ON conversations BEGIN
                     UPDATE conversations SET message_count =
                         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = NEW.id)
                      WHERE id = NEW.id;
                 END;",
            )
            .context("adding message_count column and triggers")?;
            tx.commit().context("committing message_count migration")?;
        }

        // Sync revision: changes whenever anything the cloud sync payload carries
        // changes, so the sync loop can skip conversations it already pushed.
        // `updated_at` alone is not enough: streamed replies are rewritten in
        // place by `update_message_content` without touching it. Values come from
        // one global sequence rather than a per-row counter, so a conversation
        // deleted and recreated under the same id never repeats a revision the
        // loop has already recorded.
        if !existing_conv_columns.contains("sync_rev") {
            let tx = conn
                .unchecked_transaction()
                .context("starting sync_rev migration")?;
            tx.execute_batch(
                "ALTER TABLE conversations ADD COLUMN sync_rev INTEGER NOT NULL DEFAULT 0;
                 CREATE TABLE IF NOT EXISTS sync_rev_seq (
                     id INTEGER PRIMARY KEY CHECK (id = 1),
                     value INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO sync_rev_seq (id, value) VALUES (1, 0);
                 CREATE TRIGGER IF NOT EXISTS conversations_sync_rev_after_insert
                 AFTER INSERT ON conversations BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS conversations_sync_rev_after_update
                 AFTER UPDATE OF title, agent_id, folder_path, branch, worktree_path,
                                 run_status, owner_user_id, created_at, updated_at
                 ON conversations BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_insert
                 AFTER INSERT ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = NEW.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_delete
                 AFTER DELETE ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id = OLD.conversation_id;
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_sync_rev_after_update
                 AFTER UPDATE OF content, role, created_at, conversation_id ON messages BEGIN
                     UPDATE sync_rev_seq SET value = value + 1 WHERE id = 1;
                     UPDATE conversations SET sync_rev = (SELECT value FROM sync_rev_seq)
                      WHERE id IN (OLD.conversation_id, NEW.conversation_id);
                 END;",
            )
            .context("adding sync_rev column and triggers")?;
            tx.commit().context("committing sync_rev migration")?;
        }

        // Additive migration for the versioned harness session projection. The
        // legacy `/api/sessions` shape remains compatible, while new harness
        // callers gain a durable execution profile and parent/native bindings.
        let existing_session_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "execution_profile",
                "ALTER TABLE sessions ADD COLUMN execution_profile TEXT NOT NULL DEFAULT '{}'",
            ),
            (
                "parent_session_id",
                "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT",
            ),
            (
                "native_session_id",
                "ALTER TABLE sessions ADD COLUMN native_session_id TEXT",
            ),
        ] {
            if !existing_session_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding session column {col}"))?;
            }
        }

        // Additive migration: harness double-texting. A run submitted behind an
        // active run is persisted as `pending` with its strategy; the queue is
        // ordered by priority (interrupt/rollback first) and then arrival, and
        // a rollback remembers which run's turns it removes when it starts.
        let existing_harness_run_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(harness_runs)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "multitask_strategy",
                "ALTER TABLE harness_runs ADD COLUMN multitask_strategy TEXT",
            ),
            (
                "queue_priority",
                "ALTER TABLE harness_runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "rollback_run_id",
                "ALTER TABLE harness_runs ADD COLUMN rollback_run_id TEXT",
            ),
        ] {
            if !existing_harness_run_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding harness run column {col}"))?;
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_harness_runs_queue
                 ON harness_runs(session_id, status, queue_priority DESC, created_at)",
        )
        .context("creating harness run queue index")?;

        // Additive migration: add agent_id column to messages (#414).
        let existing_msg_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        if !existing_msg_columns.contains("agent_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN agent_id TEXT")
                .context("adding agent_id column to messages")?;
        }

        // Additive migration: generalize side-chat rows so `/btw` asides and
        // subagent child runs share the same parent-conversation list.
        let existing_btw_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(btw_entries)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(|r| r.ok()).collect()
        };
        for (col, ddl) in [
            (
                "kind",
                "ALTER TABLE btw_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'btw'",
            ),
            (
                "agent_id",
                "ALTER TABLE btw_entries ADD COLUMN agent_id TEXT",
            ),
            ("preset", "ALTER TABLE btw_entries ADD COLUMN preset TEXT"),
            (
                "child_conversation_id",
                "ALTER TABLE btw_entries ADD COLUMN child_conversation_id TEXT",
            ),
        ] {
            if !existing_btw_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding btw_entries column {col}"))?;
            }
        }

        // Additive migration: the verified human author of a message (multi-user
        // collaboration epic, Phase 0). Distinct from `agent_id` (the AI agent).
        // Nullable — existing rows and agent messages carry NULL.
        if !existing_msg_columns.contains("author_user_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_user_id TEXT")
                .context("adding author_user_id column to messages")?;
        }

        // Additive migration: connector-supplied display name of the sender for
        // group/channel chats (Telegram first name, Discord username, etc.).
        // Nullable; unverified (NOT for auth) — distinct from author_user_id.
        if !existing_msg_columns.contains("author_name") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN author_name TEXT")
                .context("adding author_name column to messages")?;
        }

        // Additive migration: server-verified widget attribution. Nullable so
        // ordinary and legacy messages remain unchanged; the conversation_id
        // column is the binding that keeps this metadata scoped to its thread.
        for (col, ddl) in [
            ("source", "ALTER TABLE messages ADD COLUMN source TEXT"),
            (
                "widget_instance_id",
                "ALTER TABLE messages ADD COLUMN widget_instance_id TEXT",
            ),
            (
                "origin_server",
                "ALTER TABLE messages ADD COLUMN origin_server TEXT",
            ),
        ] {
            if !existing_msg_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col} to messages"))?;
            }
        }

        // Additive migration: structured render parts (AI SDK reduced UIMessage
        // `parts` array) captured server-side as an assistant turn streams, so a
        // reloaded conversation re-renders its tool rows + cowork context instead
        // of flattening to text-only. Nullable, sealed at rest like `content`;
        // existing rows carry NULL and fall back to a text part on the client.
        if !existing_msg_columns.contains("parts") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN parts TEXT")
                .context("adding parts column to messages")?;
        }

        if !existing_msg_columns.contains("metadata") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN metadata TEXT")
                .context("adding metadata column to messages")?;
        }

        // Additive migration: per-message thumbs feedback ('up' | 'down' | NULL).
        // A deliberate 👍/👎 on an assistant reply. Durable so the button stays lit
        // across reloads; it also seeds the continual-learning reward and the RAG
        // memory sinks (see `crate::learning::apply_message_feedback`). Nullable —
        // existing rows and un-rated messages carry NULL. Not encrypted (a coarse
        // ordinal, no message text).
        if !existing_msg_columns.contains("feedback") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN feedback TEXT")
                .context("adding feedback column to messages")?;
        }

        // Additive migration: message version tree (ChatGPT/Claude-style edit +
        // regenerate branching). `parent_message_id` links a message to the turn
        // it replied to; siblings sharing a parent are alternate versions. NULL
        // for every message in a conversation that has never been branched (flat
        // history stays byte-identical). Populated lazily on first edit/regenerate
        // by `linearize`, then maintained by `append_message`.
        if !existing_msg_columns.contains("parent_message_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN parent_message_id TEXT")
                .context("adding parent_message_id column to messages")?;
        }

        // Additive migration: "this turn was cut off mid-stream". A killed node
        // (crash / force-quit / OOM) leaves the assistant row holding whatever the
        // streaming loop had flushed and no terminal write ever lands, so the row
        // is indistinguishable from a finished answer that simply stops mid
        // sentence. Stamped at boot by `reconcile_interrupted_runs` for the rows
        // whose conversation is still parked at `run_status = 'running'`. 0 for
        // every existing row and every normally-completed turn.
        if !existing_msg_columns.contains("interrupted") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0",
            )
            .context("adding interrupted column to messages")?;
        }

        // Additive migration: the conversation's currently-selected leaf in the
        // version tree. NULL means the conversation is flat (never branched) and
        // reads fall back to chronological order. Once set, the active thread is
        // the parent chain walked up from this leaf, and new turns attach beneath
        // it.
        if !existing_conv_columns.contains("active_leaf_message_id") {
            conn.execute_batch("ALTER TABLE conversations ADD COLUMN active_leaf_message_id TEXT")
                .context("adding active_leaf_message_id column to conversations")?;
        }

        // Track IDs, never plaintext. Triggers cover imports, forks, and sync as
        // well as ordinary appends; revisions prevent acknowledging a newer edit
        // while an older revision is being embedded outside the database lock.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_parent
                 ON messages(conversation_id, parent_message_id, created_at);
             CREATE TABLE IF NOT EXISTS message_search_pending (
                 revision INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind INTEGER NOT NULL,
                 message_id TEXT NOT NULL,
                 dirty INTEGER NOT NULL DEFAULT 1,
                 UNIQUE(kind, message_id)
             );
             CREATE INDEX IF NOT EXISTS idx_message_search_pending_kind
                 ON message_search_pending(kind, revision);
             CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id) VALUES (0, NEW.id);
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id) VALUES (1, NEW.id);
             END;
             CREATE TRIGGER IF NOT EXISTS message_search_update
             AFTER UPDATE OF content, role, conversation_id, created_at ON messages BEGIN
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty) VALUES (0, NEW.id, 2);
                 INSERT OR REPLACE INTO message_search_pending(kind, message_id, dirty) VALUES (1, NEW.id, 2);
             END;
             CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
                 DELETE FROM message_search_pending WHERE kind = 0 AND message_id = OLD.id;
                 DELETE FROM message_search_pending WHERE kind = 1 AND message_id = OLD.id;
             END;",
        )?;

        Ok(())
    }

    /// Ensure a conversation row exists, creating it on first use. Optionally
    /// records the agent and a title (only set when not already present).
    ///
    /// `tenancy` stamps the row's owner **on creation** (see [`Tenancy`] and the
    /// [`upsert_conversation_row`] choke point). Pass [`Tenancy::Unattributed`] on
    /// an unbound personal node or when the row is already known to exist — the
    /// choke point preserves any owner already stamped.
    pub async fn ensure_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<()> {
        self.ensure_conversation_with_generation(conversation_id, agent_id, title, tenancy)
            .await
            .map(|_| ())
    }

    pub async fn ensure_conversation_with_generation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        let now = now_millis();
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                ..ConvRow::default()
            },
            Touch::Keep,
        )?;
        super::conversation_lifecycle::generation(&conn, conversation_id)?
            .context("conversation generation missing")
    }

    /// Insert a conversation received through a continuity/sync boundary without
    /// mutating an existing row. Metadata convergence is handled separately by
    /// `update_metadata_if_newer`; keeping conflict handling insert-only prevents
    /// a stale payload from replacing the active agent before its timestamp is
    /// considered.
    pub async fn ensure_sync_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        created_at: i64,
        updated_at: i64,
        tenancy: Tenancy,
    ) -> Result<()> {
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        insert_conversation_row(
            &conn,
            conversation_id,
            updated_at,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                created_at: Some(created_at),
                updated_at: Some(updated_at),
                ..ConvRow::default()
            },
            Touch::Keep,
            ConversationConflict::Ignore,
        )
    }

    /// Ensure a channel-originated conversation exists with stable source
    /// metadata. On an org-bound node the row is shared with the organization
    /// without assigning it to a human owner; on an unbound node it preserves
    /// the local single-user behavior.
    pub async fn ensure_channel_conversation(
        &self,
        conversation_id: &str,
        channel_id: &str,
        agent_id: Option<&str>,
        org_id: Option<&str>,
    ) -> Result<()> {
        let tenancy = org_id
            .map(Tenancy::shared_with_org)
            .unwrap_or(Tenancy::Unattributed);
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now_millis(),
            &tenancy,
            &ConvRow {
                agent_id,
                channel_id: Some(channel_id),
                visibility: org_id.map(|_| "org"),
                ..ConvRow::default()
            },
            Touch::Keep,
        )
    }

    /// Persist the active agent for a conversation after an agent-level handoff.
    /// Participants remain recorded separately so the previous agent is still a
    /// valid caller for conversation-scoped tools during the same thread.
    pub async fn set_active_agent(&self, conversation_id: &str, agent_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET agent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, agent_id, now_millis()],
        )
        .context("setting active conversation agent")?;
        Ok(())
    }

    /// Record run metadata (folder_path, branch, worktree_path) on the
    /// conversation row at run start. Call after `ensure_conversation` so the
    /// row is guaranteed to exist.
    pub async fn set_run_metadata(
        &self,
        conversation_id: &str,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<()> {
        // Normalised here because this is the ONE write path for `folder_path`,
        // and its callers are three different producers of the same string: a
        // native run (the desktop's picked folder), a thread import (Claude
        // Code's / Codex's recorded `cwd`), and the threads MCP. Clients group
        // conversations into project folders by this value, so a lone trailing
        // separator from any one of them showed up as a second project folder
        // with the same name.
        let folder_path = folder_path.map(normalize_folder_path);
        let worktree_path = worktree_path.map(normalize_folder_path);
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET folder_path  = COALESCE(?2, folder_path),
                 branch       = COALESCE(?3, branch),
                 worktree_path = COALESCE(?4, worktree_path)
             WHERE id = ?1",
            params![
                conversation_id,
                folder_path.as_deref(),
                branch,
                worktree_path.as_deref()
            ],
        )
        .context("setting run metadata")?;
        Ok(())
    }

    /// Whether an agent is already participating in a conversation. Agent-plane
    /// tools use this as their conversation boundary: the caller identity comes
    /// from Core's ACP/MCP bridge, never from tool arguments.
    pub async fn is_conversation_agent(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT agent_id, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("checking conversation agent membership")?;
        let Some((primary_agent_id, participants_json)) = row else {
            return Ok(false);
        };
        if primary_agent_id.as_deref() == Some(agent_id) {
            return Ok(true);
        }
        Ok(parse_participants_json(participants_json.as_deref())
            .iter()
            .any(|participant| participant == agent_id))
    }

    /// Store or merge a next-turn agent control. A second partial request in the
    /// same turn fills another field rather than discarding the first request.
    pub async fn set_pending_agent_control(
        &self,
        conversation_id: &str,
        control: &crate::agent_control::PendingAgentControl,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO agent_controls
                 (conversation_id, requested_by, agent_id, model, effort, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 requested_by = excluded.requested_by,
                 agent_id = COALESCE(excluded.agent_id, agent_controls.agent_id),
                 model = COALESCE(excluded.model, agent_controls.model),
                 effort = COALESCE(excluded.effort, agent_controls.effort),
                 requested_at = excluded.requested_at",
            params![
                conversation_id,
                control.requested_by,
                control
                    .patch
                    .clear_agent_id
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.agent_id.as_deref()),
                control
                    .patch
                    .clear_model
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.model.as_deref()),
                control
                    .patch
                    .clear_effort
                    .then_some(crate::agent_control::CLEAR_SENTINEL)
                    .or(control.patch.effort.as_deref()),
                control.requested_at,
            ],
        )
        .context("setting pending agent control")?;
        Ok(())
    }

    /// Atomically consume the pending control for the next user turn.
    pub async fn take_pending_agent_control(
        &self,
        conversation_id: &str,
    ) -> Result<Option<crate::agent_control::PendingAgentControl>> {
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction()
            .context("starting agent control transaction")?;
        let row: Option<(String, Option<String>, Option<String>, Option<String>, i64)> = tx
            .query_row(
                "SELECT requested_by, agent_id, model, effort, requested_at
                 FROM agent_controls WHERE conversation_id = ?1",
                params![conversation_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .context("reading pending agent control")?;
        let Some((requested_by, agent_id, model, effort, requested_at)) = row else {
            tx.commit()
                .context("committing empty agent control transaction")?;
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM agent_controls WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .context("consuming pending agent control")?;
        tx.commit().context("committing consumed agent control")?;
        let decode = |value: Option<String>| {
            if value.as_deref() == Some(crate::agent_control::CLEAR_SENTINEL) {
                (None, true)
            } else {
                (value, false)
            }
        };
        let (agent_id, clear_agent_id) = decode(agent_id);
        let (model, clear_model) = decode(model);
        let (effort, clear_effort) = decode(effort);
        Ok(Some(crate::agent_control::PendingAgentControl {
            patch: crate::agent_control::AgentControlPatch {
                agent_id,
                clear_agent_id,
                model,
                clear_model,
                effort,
                clear_effort,
            },
            requested_by,
            requested_at,
        }))
    }

    /// Record that a conversation was imported from an agent's native history
    /// store: `origin` (e.g. `import:claude`) and the agent-native `session_id`.
    /// Call after the conversation row exists. Callers dedup on
    /// [`find_imported_conversation`] before creating, so a re-import returns the
    /// existing conversation rather than writing a duplicate.
    pub async fn set_import_source(
        &self,
        conversation_id: &str,
        origin: &str,
        native_session_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET origin = ?2, native_session_id = ?3
             WHERE id = ?1",
            params![conversation_id, origin, native_session_id],
        )
        .context("setting import source")?;
        Ok(())
    }

    /// Find an already-imported conversation by its import origin + agent-native
    /// session id, so a repeat import focuses the existing thread instead of
    /// creating a duplicate. Returns `None` when nothing matches (or the source
    /// thread carried no native session id to key on). Candidate rows are limited
    /// to the same owner and organization pair as the requested tenancy, so a
    /// human or sync service cannot reuse another scope.
    pub async fn find_imported_conversation(
        &self,
        origin: &str,
        native_session_id: &str,
        tenancy: &Tenancy,
    ) -> Result<Option<String>> {
        Ok(self
            .find_imported_conversation_with_generation(origin, native_session_id, tenancy)
            .await?
            .map(|(id, _)| id))
    }

    pub async fn find_imported_conversation_with_generation(
        &self,
        origin: &str,
        native_session_id: &str,
        tenancy: &Tenancy,
    ) -> Result<Option<(String, String)>> {
        let (owner_user_id, org_id) = tenancy.parts();
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT c.id, g.generation FROM conversations c JOIN conversation_generations g ON g.conversation_id = c.id
                 WHERE origin = ?1 AND native_session_id = ?2
                   AND owner_user_id IS ?3 AND org_id IS ?4
                 ORDER BY updated_at DESC LIMIT 1",
                params![origin, native_session_id, owner_user_id, org_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .context("looking up imported conversation")?;
        Ok(id)
    }

    /// Update the run_status column of a conversation.
    pub async fn set_run_status(&self, conversation_id: &str, status: &str) -> Result<()> {
        let now = now_millis();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations SET run_status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now, conversation_id],
            )
            .context("setting run status")?;
        }
        // Fan out the lifecycle change to live `/api/runs/stream` subscribers so
        // the desktop can replace its 3s poll. A publish with no listeners is a
        // harmless no-op, and a summary-load failure must never fail the caller —
        // the status write already succeeded.
        if let Ok(Some(run)) = self.run_summary(conversation_id).await {
            let _ = run_events_sender().send(RunStatusEvent { run });
        }
        Ok(())
    }

    /// Whether a turn is running in this conversation, whatever its provider:
    /// the conversation's own `run_status` is `running`, or one of its
    /// sessions is. Same rule as [`Self::get_run_status_visible`], without the
    /// tenancy filter, for callers that already passed an access check.
    pub async fn is_run_running(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT EXISTS (
                 SELECT 1 FROM conversations c
                 WHERE c.id = ?1 AND c.run_status = 'running'
             ) OR EXISTS (
                 SELECT 1 FROM sessions s
                 WHERE s.conversation_id = ?1 AND s.status = 'running'
             )",
            params![conversation_id],
            |row| row.get::<_, bool>(0),
        )
        .context("reading conversation run status")
    }

    /// Return a visible conversation's run status without loading its transcript.
    /// `None` means the conversation is missing or not visible; `Some(None)` means
    /// it exists and is visible, but no run status is recorded.
    pub async fn get_run_status_visible(
        &self,
        conversation_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<Option<String>>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let sql = format!(
            "SELECT CASE
                 WHEN EXISTS (
                     SELECT 1 FROM sessions s
                     WHERE s.conversation_id = c.id AND s.status = 'running'
                 ) THEN 'running'
                 ELSE c.run_status
             END
             FROM conversations c
             WHERE c.id = :id AND {TENANCY_VISIBLE_PREDICATE}"
        );
        let conn = self.conn.lock().await;
        conn.query_row(
            &sql,
            named_params! {
                ":id": conversation_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .context("reading visible conversation run status")
    }

    /// Return a session's status only when its conversation is visible to the
    /// caller. The access predicate and status read share one SQL statement.
    pub async fn get_session_status_visible(
        &self,
        session_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<String>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let sql = format!(
            "SELECT s.status FROM sessions s
             JOIN conversations c ON c.id = s.conversation_id
             WHERE s.id = :id AND {TENANCY_VISIBLE_PREDICATE}"
        );
        let conn = self.conn.lock().await;
        conn.query_row(
            &sql,
            named_params! {
                ":id": session_id,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("reading visible session status")
    }

    /// Interrupt active chat records at the same time Core cancels their agents.
    /// Keep the message flags, run state and durable harness events on the same
    /// SQLite transaction path as boot recovery, then publish each live summary.
    pub async fn interrupt_running_conversations(&self) -> Result<usize> {
        let mut conn = self.conn.lock().await;
        let conversation_ids = {
            let mut statement =
                conn.prepare("SELECT id FROM conversations WHERE run_status = 'running'")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let (interrupted, _) = Self::reconcile_interrupted_runs(&mut conn, &self.cipher)?;
        drop(conn);

        for conversation_id in &conversation_ids {
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(interrupted)
    }

    /// Load one run summary for a caller that has already passed the conversation
    /// ACL. This keeps retry and other lifecycle endpoints from having to scan the
    /// entire run list just to inspect one conversation.
    pub async fn get_run_summary(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationSummary>> {
        self.run_summary(conversation_id).await
    }

    /// Atomically claim a terminal run for one bounded reconnect retry.
    ///
    /// The caller must perform the conversation ACL before invoking this method.
    /// The conditional update is the duplicate-work guard: two desktop windows
    /// reconnecting at the same time can race, but only the first one changes the
    /// terminal status to `running` and receives `true`.
    pub async fn claim_terminal_run_for_retry(&self, conversation_id: &str) -> Result<bool> {
        let now = now_millis();
        let claimed = {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE conversations
                 SET run_status = 'running', updated_at = ?1
                 WHERE id = ?2 AND run_status IN ('failed', 'interrupted')",
                params![now, conversation_id],
            )? == 1
        };
        if claimed {
            // A publish with no listeners is harmless; the status write remains the
            // source of truth if a client subscribes after this point.
            if let Ok(Some(run)) = self.run_summary(conversation_id).await {
                let _ = run_events_sender().send(RunStatusEvent { run });
            }
        }
        Ok(claimed)
    }

    /// Load a single conversation's run summary by id. Used to publish a complete
    /// [`RunStatusEvent`] on every status change. Returns `None` if the row is gone.
    async fn run_summary(&self, conversation_id: &str) -> Result<Option<ConversationSummary>> {
        let summary = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                        c.message_count,
                        c.folder_path, c.branch, c.worktree_path, c.run_status,
                        c.participants, c.pinned, c.archived, c.icon, c.visibility,
                        c.project_id, c.thread_role, c.owner_kind, c.owner_id,
                        c.coordination, c.spawned_by_conversation_id, c.spawned_by_message_id,
                        c.linked_pull_requests
                 FROM conversations c
                 WHERE c.id = ?1",
            )?;
            stmt.query_row(params![conversation_id], |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
                let icon_raw: Option<String> = row.get(13)?;
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    message_count: row.get(5)?,
                    folder_path: row.get(6)?,
                    branch: row.get(7)?,
                    worktree_path: row.get(8)?,
                    run_status: row.get(9)?,
                    participants,
                    pinned: row.get::<_, i64>(11)? != 0,
                    archived: row.get::<_, i64>(12)? != 0,
                    linked_pull_requests: parse_participants_json(
                        row.get::<_, Option<String>>(15 + HIERARCHY_COLUMN_COUNT)?
                            .as_deref(),
                    ),
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    visibility: row.get(14)?,
                    last_message: None,
                    last_message_role: None,
                    last_message_at: None,
                    hierarchy: hierarchy_from_row(row, 15)?,
                    continued_on: None,
                })
            })
            .optional()?
        };
        // Decrypt the title after the connection lock is released (uses the cipher,
        // not the db), matching the pattern in `list_runs`.
        Ok(summary.map(|mut s| {
            s.title = self.open_opt(s.title);
            s
        }))
    }

    /// Set (or replace) the title of a conversation. The title is sealed at rest
    /// like every other title write. Used by the coordinator `set_thread_title`
    /// tool so an orchestrator can label its worker threads, and by the desktop
    /// manual-rename endpoint.
    ///
    /// This is an explicit, human-driven rename, so it marks the title
    /// `title_custom = 1` — the background auto-namer ([`auto_set_title`]) checks
    /// that flag and never overwrites a title a user (or coordinator) chose.
    pub async fn set_title(&self, conversation_id: &str, title: &str) -> Result<()> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        transaction.execute(
            "UPDATE conversations SET title = ?1, title_custom = 1, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        )
        .context("setting conversation title")?;
        Self::push_title_history_locked(
            &transaction,
            &self.cipher,
            conversation_id,
            title,
            "user",
            now,
        )?;
        transaction
            .commit()
            .context("committing conversation title and history")?;
        Ok(())
    }

    /// Apply an auto-generated title (from the chat-title plugin / background
    /// auto-namer) to a conversation, but **only** when the user hasn't chosen
    /// one themselves (`title_custom = 0`). The guard makes the write a no-op if
    /// a manual rename raced ahead, so an LLM title can never clobber a deliberate
    /// one.
    ///
    /// Unlike [`set_title`] this does NOT set `title_custom` — an auto title stays
    /// replaceable, and a later manual rename still locks it. Returns whether a
    /// row was actually updated.
    pub async fn auto_set_title(&self, conversation_id: &str, title: &str) -> Result<bool> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let changed = transaction
            .execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2
                 WHERE id = ?3 AND title_custom = 0",
                params![sealed, now, conversation_id],
            )
            .context("auto-setting conversation title")?;
        if changed > 0 {
            Self::push_title_history_locked(
                &transaction,
                &self.cipher,
                conversation_id,
                title,
                "auto",
                now,
            )?;
        }
        transaction
            .commit()
            .context("committing automatic title and history")?;
        Ok(changed > 0)
    }

    /// Explicitly requested machine rename: unlock the title and record history atomically.
    pub async fn force_set_title(&self, conversation_id: &str, title: &str) -> Result<()> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let changed = transaction.execute(
            "UPDATE conversations SET title = ?1, title_custom = 0, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        ).context("force-setting conversation title")?;
        anyhow::ensure!(changed > 0, "conversation not found");
        Self::push_title_history_locked(
            &transaction,
            &self.cipher,
            conversation_id,
            title,
            "auto",
            now,
        )?;
        transaction
            .commit()
            .context("committing requested automatic title and history")?;
        Ok(())
    }

    /// Append one title-history row. Titles are sealed at rest like conversation
    /// titles. `source` is a short tag (`"auto"` | `"user"` | `"derived"`).
    fn push_title_history_locked(
        conn: &Connection,
        cipher: &ryu_crypto::FieldCipher,
        conversation_id: &str,
        title: &str,
        source: &str,
        created_at: i64,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let sealed = cipher.seal(title)?;
        conn.execute(
            "INSERT INTO conversation_title_history
                (id, conversation_id, title, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, conversation_id, sealed, source, created_at],
        )
        .context("inserting title history")?;
        Ok(())
    }

    /// Title history for a conversation, oldest → newest (decrypted).
    pub async fn list_title_history(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<TitleHistoryEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, source, created_at
                 FROM conversation_title_history
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )
            .context("preparing title history query")?;
        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .context("querying title history")?;
        let mut out = Vec::new();
        for row in rows {
            let (id, sealed, source, created_at) = row.context("reading title history row")?;
            let title = self
                .cipher
                .open(&sealed)
                .unwrap_or_else(|_| "[unable to decrypt]".to_owned());
            out.push(TitleHistoryEntry {
                id,
                title,
                source,
                created_at,
            });
        }
        Ok(out)
    }

    /// Provider/model changes are append-only conversation events. The newest
    /// event is also the conversation's current selection, so collaborators
    /// share one durable value without relying on their per-user preferences.
    pub async fn list_model_changes(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationModelChange>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes
                 WHERE conversation_id = ?1
                 ORDER BY sequence ASC",
            )
            .context("preparing conversation model history query")?;
        let rows = stmt
            .query_map(params![conversation_id], read_conversation_model_change)
            .context("querying conversation model history")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading conversation model history")
    }

    /// Store a model/provider selection atomically and fan it out to active
    /// conversation collaborators. Replaying the same `id` is idempotent.
    pub async fn record_model_selection(
        &self,
        conversation_id: &str,
        input: ConversationModelSelectionInput,
    ) -> Result<(ConversationModelChange, bool)> {
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting conversation model-selection transaction")?;

        let existing = tx
            .query_row(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes WHERE id = ?1",
                params![input.id],
                read_conversation_model_change,
            )
            .optional()
            .context("checking idempotent model-selection write")?;
        if let Some(existing) = existing {
            anyhow::ensure!(
                existing.kind == input.kind
                    && existing.provider_id == input.provider_id
                    && existing.provider_label == input.provider_label
                    && existing.model_id == input.model_id
                    && existing.model_label == input.model_label
                    && existing.changed_by == input.changed_by,
                "conversation model-selection id was reused with different data"
            );
            tx.commit()
                .context("committing idempotent model-selection write")?;
            return Ok((existing, false));
        }

        let current = tx
            .query_row(
                "SELECT sequence, id, selection_kind, provider_id, provider_label, model_id,
                        model_label, changed_by, created_at
                 FROM conversation_model_changes
                 WHERE conversation_id = ?1
                 ORDER BY sequence DESC LIMIT 1",
                params![conversation_id],
                read_conversation_model_change,
            )
            .optional()
            .context("reading current conversation model selection")?;
        if let Some(current) = current {
            if current.provider_id == input.provider_id && current.model_id == input.model_id {
                tx.commit()
                    .context("committing unchanged model-selection write")?;
                return Ok((current, false));
            }
        }

        let created_at = now_millis();
        tx.execute(
            "INSERT INTO conversation_model_changes
                (id, conversation_id, selection_kind, provider_id, provider_label, model_id,
                 model_label, changed_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.id,
                conversation_id,
                input.kind.as_db_value(),
                input.provider_id,
                input.provider_label,
                input.model_id,
                input.model_label,
                input.changed_by,
                created_at,
            ],
        )
        .context("recording conversation model selection")?;
        let change = ConversationModelChange {
            sequence: tx.last_insert_rowid(),
            id: input.id,
            kind: input.kind,
            provider_id: input.provider_id,
            provider_label: input.provider_label,
            model_id: input.model_id,
            model_label: input.model_label,
            changed_by: input.changed_by,
            created_at,
        };
        tx.commit()
            .context("committing conversation model selection")?;
        drop(conn);

        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.model-selection",
                serde_json::json!({
                    "type": "modelSelection",
                    "conversationId": conversation_id,
                    "change": change,
                }),
            );
        }
        Ok((change, true))
    }

    /// Every context handoff recorded for a conversation, oldest first.
    pub async fn list_context_handoffs(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationContextHandoff>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CONTEXT_HANDOFF_COLUMNS} FROM conversation_context_handoffs
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC"
            ))
            .context("preparing context handoff query")?;
        let rows = stmt
            .query_map(params![conversation_id], read_context_handoff_row)
            .context("querying context handoffs")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading context handoffs")?;
        drop(stmt);
        drop(conn);
        Ok(rows
            .into_iter()
            .map(|row| self.open_context_handoff(row))
            .collect())
    }

    /// The handoff recorded for one model change on the branch whose history
    /// before it ends at `covered_head_id`, if it was evaluated already.
    pub async fn get_context_handoff(
        &self,
        model_change_id: &str,
        covered_head_id: &str,
    ) -> Result<Option<ConversationContextHandoff>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                &format!(
                    "SELECT {CONTEXT_HANDOFF_COLUMNS} FROM conversation_context_handoffs
                     WHERE model_change_id = ?1 AND covered_head_id = ?2"
                ),
                params![model_change_id, covered_head_id],
                read_context_handoff_row,
            )
            .optional()
            .context("reading context handoff")?;
        drop(conn);
        Ok(row.map(|row| self.open_context_handoff(row)))
    }

    /// Record the handoff for a model change on one branch. The summary is sealed
    /// at rest like message content. A second write for the same change and
    /// branch keeps the first (two racing turns must replay one summary) and
    /// returns it.
    pub async fn record_context_handoff(
        &self,
        conversation_id: &str,
        handoff: ConversationContextHandoff,
    ) -> Result<ConversationContextHandoff> {
        let sealed_summary = self.seal_opt(handoff.summary.as_deref())?;
        let conn = self.conn.lock().await;
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO conversation_context_handoffs
                    (id, conversation_id, model_change_id, outcome, reason, from_model,
                     to_model, from_context, to_context, summarized_count, boundary_at,
                     summary, created_at, covered_head_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    handoff.id,
                    conversation_id,
                    handoff.model_change_id,
                    handoff.outcome.as_db_value(),
                    handoff.reason,
                    handoff.from_model,
                    handoff.to_model,
                    handoff.from_context,
                    handoff.to_context,
                    handoff.summarized_count,
                    handoff.boundary_at,
                    sealed_summary,
                    handoff.created_at,
                    handoff.covered_head_id,
                ],
            )
            .context("recording context handoff")?;
        drop(conn);
        if inserted == 0 {
            return self
                .get_context_handoff(&handoff.model_change_id, &handoff.covered_head_id)
                .await?
                .context("context handoff vanished after a conflicting insert");
        }
        if handoff.outcome == ContextHandoffOutcome::Applied {
            if let Some(realtime) = &self.realtime {
                realtime.broadcast_event(
                    conversation_id,
                    "conversation.context-handoff",
                    serde_json::json!({
                        "type": "contextHandoff",
                        "conversationId": conversation_id,
                        "handoff": handoff,
                    }),
                );
            }
        }
        Ok(handoff)
    }

    fn open_context_handoff(
        &self,
        mut row: ConversationContextHandoff,
    ) -> ConversationContextHandoff {
        row.summary = self.open_opt(row.summary);
        row
    }

    /// Whether a conversation's title is user-chosen (locked against auto-rename).
    /// Used by the auto-namer to skip conversations the user already renamed.
    pub async fn title_is_custom(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let custom: Option<i64> = conn
            .query_row(
                "SELECT title_custom FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading title_custom")?;
        Ok(custom.unwrap_or(0) != 0)
    }

    /// Pin or unpin a conversation (coordinator `set_thread_pinned`).
    pub async fn set_pinned(&self, conversation_id: &str, pinned: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(pinned), now, conversation_id],
        )
        .context("setting pinned flag")?;
        Ok(())
    }

    /// Archive or unarchive a conversation (coordinator `set_thread_archived`).
    pub async fn set_archived(&self, conversation_id: &str, archived: bool) -> Result<()> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(archived), now, conversation_id],
        )
        .context("setting archived flag")?;
        Ok(())
    }

    /// Link (or unlink) a GitHub pull request URL to a conversation. Linking is
    /// idempotent and keeps link order; at most [`MAX_LINKED_PULL_REQUESTS`]
    /// stay linked. Returns the resulting list, or `None` when the row is gone.
    pub async fn set_pull_request_linked(
        &self,
        conversation_id: &str,
        url: &str,
        linked: bool,
    ) -> Result<Option<Vec<String>>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let current: Option<String> = conn
            .query_row(
                "SELECT linked_pull_requests FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading linked pull requests")?;
        let Some(current) = current else {
            return Ok(None);
        };
        let mut urls = parse_participants_json(Some(&current));
        urls.retain(|existing| existing != url);
        if linked {
            if urls.len() >= MAX_LINKED_PULL_REQUESTS {
                anyhow::bail!("a chat can link at most {MAX_LINKED_PULL_REQUESTS} pull requests");
            }
            urls.push(url.to_owned());
        }
        conn.execute(
            "UPDATE conversations SET linked_pull_requests = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&urls)?, now, conversation_id],
        )
        .context("setting linked pull requests")?;
        Ok(Some(urls))
    }

    /// Set or clear the workspace folder used to group a conversation.
    ///
    /// Clearing the value detaches the chat from its project without deleting
    /// either the conversation or the folder on disk.
    pub async fn set_folder_path(
        &self,
        conversation_id: &str,
        folder_path: Option<&str>,
    ) -> Result<bool> {
        let now = now_millis();
        let normalized = folder_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(normalize_folder_path);
        let conn = self.conn.lock().await;
        let updated = conn
            .execute(
                "UPDATE conversations SET folder_path = ?1, updated_at = ?2 WHERE id = ?3",
                params![normalized, now, conversation_id],
            )
            .context("setting conversation folder")?;
        Ok(updated > 0)
    }

    /// Set or clear a conversation's Notion-style glyph. `None` clears it.
    pub async fn set_icon(
        &self,
        conversation_id: &str,
        icon: Option<&serde_json::Value>,
    ) -> Result<bool> {
        let now = now_millis();
        let icon_str = match icon {
            Some(v) => Some(serde_json::to_string(v).context("serializing conversation icon")?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE conversations SET icon = ?1, updated_at = ?2 WHERE id = ?3",
                params![icon_str, now, conversation_id],
            )
            .context("setting conversation icon")?;
        Ok(n > 0)
    }

    /// Set a conversation's sharing visibility. The HTTP layer owns the resource
    /// write gate; this store method keeps the column update atomic and explicit.
    pub async fn set_visibility(
        &self,
        conversation_id: &str,
        visibility: &str,
        team_id: Option<&str>,
        admin_authorized: bool,
    ) -> Result<bool> {
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
            );
        }
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires team_id");
        }
        let now = now_millis();
        let conn = self.conn.lock().await;
        if visibility == "private" {
            let current: Option<String> = conn
                .query_row(
                    "SELECT visibility FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading current conversation visibility")?;
            if matches!(current.as_deref(), Some("org" | "team")) && !admin_authorized {
                anyhow::bail!("only organization admins can make shared conversations private");
            }
        }
        let updated = conn
            .execute(
                "UPDATE conversations SET visibility = ?1, team_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![visibility, team_id, now, conversation_id],
            )
            .context("setting conversation visibility")?;
        Ok(updated > 0)
    }

    /// Replace a conversation's direct grants and general visibility atomically.
    pub async fn set_access(
        &self,
        conversation_id: &str,
        visibility: &str,
        team_id: Option<&str>,
        collaborators: &[ConversationCollaborator],
        manager_authorized: bool,
    ) -> Result<bool> {
        if !matches!(visibility, "private" | "org" | "team") {
            anyhow::bail!(
                "unknown visibility {visibility:?}: expected \"private\", \"org\", or \"team\""
            );
        }
        if visibility == "team" && team_id.is_none() {
            anyhow::bail!("team visibility requires team_id");
        }
        if collaborators.len() > 100 {
            anyhow::bail!("a conversation can have at most 100 collaborators");
        }
        let mut user_ids = std::collections::HashSet::new();
        for collaborator in collaborators {
            if collaborator.user_id.is_empty()
                || collaborator.user_id.len() > 256
                || collaborator.user_id.chars().any(char::is_control)
            {
                anyhow::bail!("collaborator user_id must be 1-256 printable characters");
            }
            if !matches!(collaborator.role.as_str(), "viewer" | "participant") {
                anyhow::bail!("collaborator role must be \"viewer\" or \"participant\"");
            }
            if !user_ids.insert(collaborator.user_id.as_str()) {
                anyhow::bail!("duplicate collaborator user_id");
            }
        }

        let now = now_millis();
        let mut conn = self.conn.lock().await;
        let transaction = conn
            .transaction()
            .context("starting conversation access update")?;
        if visibility == "private" {
            let current: Option<String> = transaction
                .query_row(
                    "SELECT visibility FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .context("reading current conversation visibility")?;
            if matches!(current.as_deref(), Some("org" | "team")) && !manager_authorized {
                anyhow::bail!(
                    "only owners and organization admins can make shared conversations private"
                );
            }
        }
        let updated = transaction
            .execute(
                "UPDATE conversations SET visibility = ?1, team_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![visibility, team_id, now, conversation_id],
            )
            .context("setting conversation access")?;
        if updated == 0 {
            return Ok(false);
        }
        transaction
            .execute(
                "DELETE FROM conversation_collaborators WHERE conversation_id = ?1",
                params![conversation_id],
            )
            .context("replacing conversation collaborators")?;
        for collaborator in collaborators {
            transaction
                .execute(
                    "INSERT INTO conversation_collaborators
                        (conversation_id, user_id, role, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![
                        conversation_id,
                        collaborator.user_id,
                        collaborator.role,
                        now
                    ],
                )
                .context("adding conversation collaborator")?;
        }
        transaction
            .commit()
            .context("committing conversation access update")?;
        Ok(true)
    }

    pub async fn list_collaborators(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationCollaborator>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT user_id, role FROM conversation_collaborators
             WHERE conversation_id = ?1 ORDER BY user_id",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            Ok(ConversationCollaborator {
                user_id: row.get(0)?,
                role: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing conversation collaborators")
    }

    /// Append a message and bump the conversation's `updated_at`. Returns the new
    /// message id. **Creates the conversation if it does not exist yet** — which is
    /// why it takes a [`Tenancy`]: an append that mints a row on an org-bound node
    /// must stamp its owner or the row is born invisible to everybody.
    ///
    /// Callers writing into a row that already exists pass [`Tenancy::Unattributed`];
    /// the choke point's COALESCE preserves the owner already stamped (this is the
    /// property `append_does_not_wipe_a_claimed_owner` asserts).
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        self.append_message_as_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
        )
        .await
    }

    /// Append a message with provenance resolved by a server-side verification
    /// boundary. The provenance is written together with the ordinary message
    /// row so the existing conversation reload endpoint can render it.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_provenance(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            None,
            None,
            None,
            None,
        )
        .await
    }

    /// Append a message and correlate its live event with the concrete client
    /// that submitted the HTTP mutation. The id is event metadata only and is not
    /// persisted or used for authorization.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_realtime_origin(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            client_id,
            None,
            None,
            None,
        )
        .await
    }

    /// Persist a submitted UI message and its display data atomically. Metadata is
    /// client supplied; verified identity/provenance remain separate columns.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_as_with_render_data(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
        parts: Option<&serde_json::Value>,
        metadata: Option<&serde_json::Value>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            None,
            provenance,
            client_id,
            parts,
            metadata,
            None,
        )
        .await
    }

    /// Persist a complete temporary-chat snapshot in one transaction.
    ///
    /// Temporary turns intentionally never create rows while they are running,
    /// so the desktop needs one explicit promotion boundary when the user picks
    /// "Save chat". The transaction keeps a failed promotion from leaving a
    /// half-transcript behind. Core generates message ids, seals both text and
    /// structured parts, and then performs the same best-effort search indexing
    /// and realtime fan-out as a normal append.
    pub async fn save_temporary_conversation(
        &self,
        conversation_id: &str,
        agent_id: Option<&str>,
        folder_path: Option<&str>,
        messages: &[TemporaryConversationMessage],
        tenancy: Tenancy,
    ) -> Result<ConversationSummary> {
        if messages.is_empty() {
            anyhow::bail!("a temporary chat must contain at least one message");
        }
        if messages
            .iter()
            .any(|message| !matches!(message.role.as_str(), "user" | "assistant"))
        {
            anyhow::bail!("temporary chat messages must be user or assistant turns");
        }

        let now = now_millis();
        let created_at = messages
            .iter()
            .map(|message| message.created_at)
            .min()
            .unwrap_or(now);
        let updated_at = messages
            .iter()
            .map(|message| message.created_at)
            .max()
            .unwrap_or(now)
            .max(now);
        let normalized_folder = folder_path.map(normalize_folder_path);
        let title = messages
            .iter()
            .find(|message| message.role == "user")
            .and_then(|message| derive_title(&message.content));
        let sealed_title = self.seal_opt(title.as_deref())?;
        let index = self.message_index.clone();
        let index_enabled = self.chat_memory_enabled();
        let realtime = self.realtime.clone();
        let mut persisted = Vec::with_capacity(messages.len());

        {
            let mut conn = self.conn.lock().await;
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists: Option<String> = transaction
                .query_row(
                    "SELECT id FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                anyhow::bail!("conversation already exists");
            }
            insert_conversation_row(
                &transaction,
                conversation_id,
                now,
                &tenancy,
                &ConvRow {
                    title: sealed_title.as_deref(),
                    agent_id,
                    created_at: Some(created_at),
                    updated_at: Some(updated_at),
                    folder_path: normalized_folder.as_deref(),
                    ..ConvRow::default()
                },
                Touch::Keep,
                ConversationConflict::Ignore,
            )?;
            if let Some(derived_title) = title.as_deref() {
                Self::push_title_history_locked(
                    &transaction,
                    &self.cipher,
                    conversation_id,
                    derived_title,
                    "derived",
                    created_at,
                )?;
            }

            for message in messages {
                let message_id = uuid::Uuid::new_v4().to_string();
                let sealed_content = self.cipher.seal(&message.content)?;
                let sealed_parts = message
                    .parts
                    .as_ref()
                    .filter(|parts| !parts.is_null())
                    .map(|parts| {
                        serde_json::to_string(parts)
                            .context("serializing temporary chat message parts")
                            .and_then(|json| self.cipher.seal(&json))
                    })
                    .transpose()?;
                let sealed_metadata = message
                    .metadata
                    .as_ref()
                    .filter(|value| value.is_object())
                    .map(|value| self.cipher.seal(&value.to_string()))
                    .transpose()?;
                transaction
                    .execute(
                        "INSERT INTO messages
                            (id, conversation_id, role, content, agent_id, author_user_id,
                             parts, created_at, metadata)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            message_id,
                            conversation_id,
                            message.role,
                            sealed_content,
                            message.agent_id,
                            message.author_user_id,
                            sealed_parts,
                            message.created_at,
                            sealed_metadata,
                        ],
                    )
                    .context("inserting temporary chat message")?;
                persisted.push((
                    message_id,
                    message.role.clone(),
                    message.content.clone(),
                    message.agent_id.clone(),
                    message.author_user_id.clone(),
                    message.created_at,
                ));
            }
            transaction.commit()?;
        }

        if index_enabled {
            if let Some(index) = index {
                for (message_id, role, content, _, _, created_at) in persisted.clone() {
                    if content.trim().is_empty() {
                        continue;
                    }
                    let index = index.clone();
                    let message_id = message_id.clone();
                    let conversation_id = conversation_id.to_owned();
                    let role = role.clone();
                    let content = content.clone();
                    tokio::spawn(async move {
                        let embedder = index.embedder();
                        match embedder.embed(&content).await {
                            Ok(vector) => {
                                if let Err(error) = index
                                    .index_message(
                                        &message_id,
                                        &conversation_id,
                                        &role,
                                        &vector,
                                        embedder.model_id(),
                                        created_at,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        "message-index write failed for {message_id}: {error:#}"
                                    );
                                }
                            }
                            Err(error) => tracing::warn!(
                                "message-index embed failed for {message_id} (sidecar down?): {error:#}"
                            ),
                        }
                    });
                }
            }
        }

        if let Some(realtime) = realtime {
            for (message_id, role, content, message_agent_id, author_user_id, created_at) in
                persisted
            {
                realtime.broadcast_event(
                    conversation_id,
                    "conversation.message",
                    serde_json::json!({
                        "type": "message",
                        "conversation_id": conversation_id,
                        "message": {
                            "id": message_id,
                            "role": role,
                            "content": content,
                            "author_user_id": author_user_id,
                            "created_at": created_at,
                            "agent_id": message_agent_id,
                        }
                    }),
                );
            }
        }

        self.run_summary(conversation_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("saved temporary conversation disappeared"))
    }

    /// [`Self::append_message_as`], but with an explicit `created_at` (epoch
    /// millis) instead of "now".
    ///
    /// Exists for IMPORT, which is a restore rather than a new exchange: the
    /// agent's own transcript records when each turn happened, and stamping the
    /// import time instead made a three-week-old thread land as if it had just
    /// occurred — wrong in the row, wrong in the chat's date separators, and wrong
    /// for anything that orders on it. `None` means "now", which is what every
    /// live-chat caller wants and why that stays the default.
    #[allow(clippy::too_many_arguments)]
    pub async fn append_message_at(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            tenancy,
            created_at,
            None,
            None,
            None,
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn append_imported_message_at(
        &self,
        conversation_id: &str,
        generation: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
    ) -> Result<String> {
        self.append_message_at_with_provenance(
            conversation_id,
            role,
            content,
            agent_id,
            None,
            None,
            tenancy,
            created_at,
            None,
            None,
            None,
            None,
            Some(generation),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn append_message_at_with_provenance(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
        tenancy: Tenancy,
        created_at: Option<i64>,
        provenance: Option<&MessageProvenance>,
        client_id: Option<&str>,
        parts: Option<&serde_json::Value>,
        metadata: Option<&serde_json::Value>,
        expected_generation: Option<&str>,
    ) -> Result<String> {
        let sealed_parts = parts
            .filter(|value| value.is_array())
            .map(|value| self.cipher.seal(&value.to_string()))
            .transpose()?;
        let sealed_metadata = metadata
            .filter(|value| value.is_object())
            .map(|value| self.cipher.seal(&value.to_string()))
            .transpose()?;
        let now = created_at.unwrap_or_else(now_millis);
        let message_id = uuid::Uuid::new_v4().to_string();

        let guard = self.conn.lock().await;
        // One transaction for the whole append: the row upsert, title history,
        // message insert and leaf advance commit together with a single WAL sync
        // instead of one per statement, and a failure leaves no partial append.
        let conn = guard
            .unchecked_transaction()
            .context("starting message append")?;
        if let Some(expected) = expected_generation {
            anyhow::ensure!(
                super::conversation_lifecycle::generation(&conn, conversation_id)?.as_deref()
                    == Some(expected),
                "conversation changed during import"
            );
        }
        // Index the message body for semantic search — best-effort, fail-open.
        // We spawn BEFORE taking the DB lock and embed the *plaintext* (pre-seal)
        // in the spawned task, so the network embed never holds the conversation
        // mutex and a down embed sidecar can never block or slow the chat write.
        if self.chat_memory_enabled() {
            if let Some(index) = self.message_index.clone() {
                if !content.trim().is_empty() {
                    let index_msg_id = message_id.clone();
                    let index_conv_id = conversation_id.to_owned();
                    let index_role = role.to_owned();
                    let index_content = content.to_owned();
                    tokio::spawn(async move {
                        let embedder = index.embedder();
                        match embedder.embed(&index_content).await {
                            Ok(vec) => {
                                if let Err(e) = index
                                    .index_message(
                                        &index_msg_id,
                                        &index_conv_id,
                                        &index_role,
                                        &vec,
                                        embedder.model_id(),
                                        now,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        "message-index write failed for {index_msg_id}: {e:#}"
                                    );
                                }
                            }
                            Err(e) => tracing::warn!(
                                "message-index embed failed for {index_msg_id} (sidecar down?): {e:#}"
                            ),
                        }
                    });
                }
            }
        }

        // Derive a first-pass title from the first user message (sealed at rest).
        // Only applied when the conversation has no title yet (COALESCE in upsert).
        let derived = if role == "user" {
            derive_title(content)
        } else {
            None
        };
        let title = derived
            .as_deref()
            .map(|t| self.seal_opt(Some(t)))
            .transpose()?
            .flatten();
        // Was this conversation untitled before this append? Used to record the
        // derived title in history exactly once.
        let had_title: bool = conn
            .query_row(
                "SELECT title IS NOT NULL FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false);
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                title: title.as_deref(),
                agent_id,
                ..ConvRow::default()
            },
            Touch::Set,
        )?;
        if let (Some(derived_title), false) = (derived.as_deref(), had_title) {
            if role == "user" {
                let _ = Self::push_title_history_locked(
                    &conn,
                    &self.cipher,
                    conversation_id,
                    derived_title,
                    "derived",
                    now,
                );
            }
        }
        // Version-tree linkage: if this conversation has been branched (its
        // `active_leaf_message_id` is set), attach the new turn beneath the
        // current leaf and advance the leaf to this message. Conversations that
        // have never been edited/regenerated carry a NULL leaf, so `parent` stays
        // NULL and the append is byte-identical to the pre-tree behavior. This is
        // what makes flat chat (including council/team/group multi-reply) untouched
        // until the user actually edits.
        let parent_message_id: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf on append")?
            .flatten();
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, author_user_id, author_name, source, widget_instance_id, origin_server, parent_message_id, created_at, parts, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                message_id,
                conversation_id,
                role,
                sealed,
                agent_id,
                author_user_id,
                author_name,
                provenance.map(|p| p.source.as_str()),
                provenance.map(|p| p.widget_instance_id.as_str()),
                provenance.map(|p| p.origin_server.as_str()),
                parent_message_id,
                now,
                sealed_parts,
                sealed_metadata
            ],
        )
        .context("inserting message")?;
        // Advance the leaf so the next turn chains beneath this one. Only matters
        // once branching is engaged (NULL leaf stays NULL: the UPDATE below sets it
        // to this id only when it was already non-NULL).
        if parent_message_id.is_some() {
            conn.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![message_id, conversation_id],
            )
            .context("advancing active leaf on append")?;
        }

        // Release the conversation DB lock before fanning out — the publish is a
        // non-blocking broadcast send on a different mutex, but there is no reason
        // to hold the conn lock across it.
        conn.commit().context("committing message append")?;
        drop(guard);

        // NOTE: the title written above is only the placeholder cut from the raw
        // message. The LLM rename is NOT fired from here any more — it belongs to
        // the `@ryu/chat-title` turn-hook plugin (`post_assistant_turn`), which
        // owns the cadence (first reply + every N turns), the enable toggle, and
        // the model choice. Core used to ALSO enqueue a background titler on the
        // first user turn; that path resolved its model as "the `auto-title-model`
        // pref, else an active *local* engine", so on a cloud-only node it silently
        // did nothing while the plugin (which falls back through the node default)
        // worked — the "chats stay called New Chat until the 5th turn" report. One
        // titler now, and it is the configurable one.

        // Room-keyed realtime fan-out (Phase 1): make this turn appear live for
        // every other viewer of the conversation. We publish the *plaintext*
        // `content` (the same value `GET /api/conversations/:id` returns after
        // decrypting the sealed column) — never the sealed blob — and reuse `now`
        // (the exact `created_at` written to the row) so the live frame matches the
        // persisted/GET shape.
        //
        // This is the first adopter of the typed named-event contract
        // (`broadcast_event`, the Rivet-style `broadcast(event, payload)`): the turn
        // rides the Events channel as a `conversation.message` envelope. It stays
        // wire-compatible — the WS gateway's `frame_to_message` unwraps the envelope
        // back to `{"channel":"events","data":<this INNER value>}`, byte-for-byte
        // what raw `publish_event` produced — so `data` still carries the
        // self-describing `"type":"message"` shape existing clients key off; do not
        // pre-wrap with "channel". No-op when realtime is unwired (tests/CLI) or the
        // room has no members.
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.message",
                serde_json::json!({
                    "type": "message",
                    "conversation_id": conversation_id,
                    "message": {
                        "id": message_id,
                        "role": role,
                        "content": content,
                        "parts": parts,
                        "metadata": metadata,
                        "author_user_id": author_user_id,
                        "client_id": client_id,
                        "author_name": author_name,
                        "source": provenance.map(|p| p.source.as_str()),
                        "widget_instance_id": provenance.map(|p| p.widget_instance_id.as_str()),
                        "origin_server": provenance.map(|p| p.origin_server.as_str()),
                        "created_at": now,
                        "agent_id": agent_id,
                    }
                }),
            );
        }
        Ok(message_id)
    }

    /// Update the content of an existing message (by id) in place, re-sealing
    /// the new content at rest.  Used for incremental persistence of ACP
    /// streaming replies: the assistant message row is created early (possibly
    /// with partial text) and updated as more text arrives, so the content
    /// survives a client disconnect.
    pub async fn update_message_content(&self, message_id: &str, content: &str) -> Result<()> {
        let sealed = self.cipher.seal(content)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            params![sealed, message_id],
        )
        .context("updating message content")?;
        Ok(())
    }

    /// Store the structured render `parts` (a serialized AI SDK UIMessage `parts`
    /// array) for an existing message, sealed at rest like `content`. Written once
    /// at turn end (after the close-out frames, so terminal tool states are
    /// captured) by the streaming loop so a reloaded conversation re-renders its
    /// tool rows + cowork context. Best-effort: a failure here never fails the turn
    /// (the flat `content` text is still persisted independently).
    pub async fn update_message_parts(&self, message_id: &str, parts_json: &str) -> Result<()> {
        let sealed = self.cipher.seal(parts_json)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE messages SET parts = ?1 WHERE id = ?2",
            params![sealed, message_id],
        )
        .context("updating message parts")?;
        Ok(())
    }

    /// List conversations, most-recently-updated first. **Unfiltered** — every row
    /// on the node. Kept for the in-process callers that legitimately need the full
    /// set (sync replay, the learning pass, the MCP `threads` tool). Any HTTP
    /// handler serving a remote caller must use [`Self::list_conversations_visible`].
    pub async fn list_conversations(&self) -> Result<Vec<ConversationSummary>> {
        self.list_summaries("", TenancyFilter::unrestricted()).await
    }

    /// List conversations this caller may READ, filtered in SQL.
    ///
    /// Replaces the handler-side N+1 (`get_access_meta` per row, each taking the
    /// store mutex) with one query whose `WHERE` mirrors `resource_access`
    /// (`server/mod.rs`) exactly. On an org-bound node an anonymous caller gets an
    /// empty list rather than every user's chat titles.
    pub async fn list_conversations_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_conversations_visible_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant used by authenticated HTTP callers. `team_ids_json`
    /// must contain only signature-verified team ids narrowed to the node org.
    pub async fn list_conversations_visible_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
        )
        .await
    }

    /// [`Self::list_conversations_visible`] with the newest message of each row
    /// attached (`last_message` / `last_message_role` / `last_message_at`). Serves
    /// `GET /api/conversations?preview=1`, which the desktop calls only while the
    /// messaging-style sidebar is switched on.
    pub async fn list_conversations_visible_with_preview(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_conversations_visible_with_preview_for_teams(
            owner_user_id,
            org_id,
            node_bound,
            None,
        )
        .await
    }

    /// Preview variant with the same verified team-membership boundary as the
    /// summary list. The SQL gate runs before any newest-message content is opened.
    pub async fn list_conversations_visible_with_preview_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries_inner(
            "",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
            true,
            None,
        )
        .await
    }

    /// List conversations that have an active or recently-finished run (i.e.
    /// run_status is not NULL), ordered most-recently-updated first.  Used by
    /// the background-runs view (issue #128) and the sidebar runs section.
    /// **Unfiltered** — see [`Self::list_runs_visible`] for the caller-scoped form.
    pub async fn list_runs(&self) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "AND c.run_status IS NOT NULL",
            TenancyFilter::unrestricted(),
        )
        .await
    }

    /// The tenancy-filtered twin of [`Self::list_runs`] — used by `GET /api/runs`
    /// and the `/api/runs/stream` opening snapshot, which otherwise fan out every
    /// run on the node to every holder of the node token.
    pub async fn list_runs_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_runs_visible_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant of [`Self::list_runs_visible`].
    pub async fn list_runs_visible_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries(
            "AND c.run_status IS NOT NULL",
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json),
        )
        .await
    }

    /// The ids of every conversation this caller may READ. Feeds the
    /// `conversation_ids` filter that [`Self::search_messages`] /
    /// [`Self::fts_search_messages`] already accept, so semantic search can never
    /// return a snippet from someone else's chat.
    pub async fn visible_conversation_ids(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Vec<String>> {
        self.visible_conversation_ids_for_teams(owner_user_id, org_id, node_bound, None)
            .await
    }

    /// Team-aware variant used before semantic search builds its conversation id
    /// intersection. Without this boundary, search could expose a team preview
    /// even when the sidebar list was correctly filtered.
    pub async fn visible_conversation_ids_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<String>> {
        let filter =
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json);
        // Newest first, so a caller that must bound the set (the ext-proxy's
        // caller resource scope) keeps the most recently active conversations.
        let sql = format!(
            "SELECT c.id FROM conversations c WHERE {TENANCY_VISIBLE_PREDICATE}
             ORDER BY c.updated_at DESC, c.id ASC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| row.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The conversations this caller may READ, each paired with its source
    /// version: a short digest of the row's immutable identity (id, creation
    /// time, owner, org). Feeds the ext-proxy's `caller_resource_scope`, so a
    /// derived index can tell a conversation from a later one RE-CREATED under
    /// the same id (after the original was deleted) and never serve the old
    /// conversation's derived data to the new one's readers. Newest first, like
    /// [`Self::visible_conversation_ids_for_teams`].
    pub async fn visible_conversation_versions_for_teams(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        team_ids_json: Option<&str>,
    ) -> Result<Vec<(String, String)>> {
        let filter =
            TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, team_ids_json);
        let sql = format!(
            "SELECT c.id, c.created_at, c.owner_user_id, c.org_id
             FROM conversations c WHERE {TENANCY_VISIBLE_PREDICATE}
             ORDER BY c.updated_at DESC, c.id ASC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
            },
            |row| {
                let id: String = row.get(0)?;
                let created_at: i64 = row.get(1)?;
                let owner: Option<String> = row.get(2)?;
                let org: Option<String> = row.get(3)?;
                let version =
                    conversation_source_version(&id, created_at, owner.as_deref(), org.as_deref());
                Ok((id, version))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Shared body of the conversation-summary listings. `extra` is an additional
    /// `AND …` clause appended to the tenancy predicate.
    async fn list_summaries(
        &self,
        extra: &str,
        filter: TenancyFilter<'_>,
    ) -> Result<Vec<ConversationSummary>> {
        self.list_summaries_inner(extra, filter, false, None).await
    }

    /// One visible conversation's summary, read with the same query and access
    /// predicate as [`Self::list_conversations_visible`] but for a single id, so
    /// a caller that needs one row does not list (and decrypt) every chat.
    pub async fn get_summary_visible(
        &self,
        conversation_id: &str,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
    ) -> Result<Option<ConversationSummary>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        Ok(self
            .list_summaries_inner("", filter, false, Some(conversation_id))
            .await?
            .into_iter()
            .next())
    }

    /// Every conversation's sync revision (see the `sync_rev` migration). A
    /// revision changes whenever anything a cloud sync payload carries changes,
    /// and never repeats for an id, so equal values mean nothing to push.
    pub async fn sync_revisions(&self) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id, sync_rev FROM conversations")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (id, rev) = row?;
            out.insert(id, rev);
        }
        Ok(out)
    }

    /// One conversation's summary, **unfiltered** like [`Self::list_conversations`].
    /// For in-process callers that already checked access and need a single row,
    /// so they do not list (and decrypt) every chat on the node to find it.
    pub async fn get_summary(&self, conversation_id: &str) -> Result<Option<ConversationSummary>> {
        Ok(self
            .list_summaries_inner(
                "",
                TenancyFilter::unrestricted(),
                false,
                Some(conversation_id),
            )
            .await?
            .into_iter()
            .next())
    }

    /// [`Self::list_summaries`] plus the newest message of each row. Separate
    /// entry point rather than a default argument because the preview costs two
    /// correlated subqueries and one decrypt per row, and only the messaging-style
    /// sidebar wants it — `list_runs`, sync replay and the learning pass must not
    /// start paying for it.
    async fn list_summaries_inner(
        &self,
        extra: &str,
        filter: TenancyFilter<'_>,
        with_preview: bool,
        // Restrict to one conversation; bound as a parameter, never spliced.
        only_id: Option<&str>,
    ) -> Result<Vec<ConversationSummary>> {
        // Both subqueries ride `idx_messages_conversation (conversation_id,
        // created_at)`, so each is an index seek to the tail of one conversation.
        // Only conversational turns preview. In-process writes are user/assistant
        // only, but sync replay and thread import copy a peer's `role` verbatim, and
        // a tool/system row surfacing as an agent's "last message" reads as a bug.
        let preview_cols = if with_preview {
            ",
                    (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
                    (SELECT m.role FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
                    (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant')
                      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)"
        } else {
            ""
        };
        let sql = format!(
            "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    c.message_count,
                    c.folder_path, c.branch, c.worktree_path, c.run_status,
                    c.participants, c.pinned, c.archived, c.icon, c.visibility,
                    {HIERARCHY_SELECT}, c.linked_pull_requests{preview_cols},
                    c.continued_on
             FROM conversations c
             WHERE {TENANCY_VISIBLE_PREDICATE} AND (:only_id IS NULL OR c.id = :only_id) {extra}
             ORDER BY c.updated_at DESC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
                ":only_id": only_id,
            },
            |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
                let icon_raw: Option<String> = row.get(13)?;
                // Still sealed here — decrypted below, once the db lock is out of
                // the way, exactly like `title`.
                let linked_at = 15 + HIERARCHY_COLUMN_COUNT;
                let linked_pull_requests =
                    parse_participants_json(row.get::<_, Option<String>>(linked_at)?.as_deref());
                let preview_at = linked_at + 1;
                let (last_message, last_message_role, last_message_at) = if with_preview {
                    (
                        row.get(preview_at)?,
                        row.get(preview_at + 1)?,
                        row.get(preview_at + 2)?,
                    )
                } else {
                    (None, None, None)
                };
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    agent_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    message_count: row.get(5)?,
                    folder_path: row.get(6)?,
                    branch: row.get(7)?,
                    worktree_path: row.get(8)?,
                    run_status: row.get(9)?,
                    participants,
                    pinned: row.get::<_, i64>(11)? != 0,
                    archived: row.get::<_, i64>(12)? != 0,
                    linked_pull_requests,
                    icon: icon_raw.and_then(|s| serde_json::from_str(&s).ok()),
                    visibility: row.get(14)?,
                    last_message,
                    last_message_role,
                    last_message_at,
                    hierarchy: hierarchy_from_row(row, 15)?,
                    continued_on: row
                        .get::<_, Option<String>>(preview_at + if with_preview { 3 } else { 0 })?
                        .and_then(|raw| serde_json::from_str(&raw).ok()),
                })
            },
        )?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        for summary in &mut out {
            summary.title = self.open_opt(summary.title.take());
            summary.last_message = summary
                .last_message
                .take()
                .map(|sealed| preview_line(&self.open_content(sealed)));
        }
        Ok(out)
    }

    /// Decrypt a stored `content` value, degrading gracefully: a row that fails
    /// to decrypt (corrupt/wrong-key) is replaced with a marker rather than
    /// failing the whole conversation load. Legacy plaintext passes through.
    fn open_content(&self, stored: String) -> String {
        #[cfg(test)]
        self.content_reads.fetch_add(1, Ordering::Relaxed);
        self.cipher.open(&stored).unwrap_or_else(|e| {
            tracing::warn!("could not decrypt message content: {e}");
            "[unable to decrypt message]".to_owned()
        })
    }

    /// Seal an optional field (e.g. a conversation title) for storage. `None`
    /// stays `None` so SQL `COALESCE`/null semantics are preserved.
    fn seal_opt(&self, value: Option<&str>) -> Result<Option<String>> {
        value.map(|v| self.cipher.seal(v)).transpose()
    }

    /// Decrypt an optional stored field, with the same graceful degradation as
    /// [`Self::open_content`]. Legacy plaintext passes through.
    fn open_opt(&self, stored: Option<String>) -> Option<String> {
        stored.map(|s| {
            self.cipher.open(&s).unwrap_or_else(|e| {
                tracing::warn!("could not decrypt conversation title: {e}");
                "[unable to decrypt]".to_owned()
            })
        })
    }

    /// Decrypt + parse an optional stored `parts` column into a JSON value (the AI
    /// SDK `parts` array). A row that fails to decrypt or parse (corrupt / wrong
    /// key / legacy garbage) degrades to `None` so the client falls back to a text
    /// part from `content` — never failing the whole conversation load.
    fn open_parts(&self, stored: Option<String>) -> Option<serde_json::Value> {
        let sealed = stored?;
        let plaintext = self.cipher.open(&sealed).ok()?;
        serde_json::from_str(&plaintext).ok()
    }

    /// Page assistant usage parts without selecting or decrypting message content.
    /// Return only explicitly allowlisted usage metadata; text/tool parts never leave this method.
    pub(crate) async fn usage_metadata_page(
        &self,
        after_rowid: i64,
        limit: usize,
    ) -> Result<
        Vec<(
            i64,
            String,
            String,
            Option<String>,
            i64,
            Vec<serde_json::Value>,
        )>,
    > {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT rowid,id,conversation_id,agent_id,created_at,
                    CASE WHEN length(parts)<=8388608 THEN parts ELSE NULL END
             FROM messages WHERE rowid>?1 AND role='assistant' AND parts IS NOT NULL AND interrupted=0
             ORDER BY rowid LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![after_rowid.max(0), limit.clamp(1, 10001) as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )?;
        let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(conn);
        Ok(raw
            .into_iter()
            .map(|(rowid, id, conversation, agent, created, parts)| {
                let metadata = self
                    .open_parts(parts)
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|part| {
                        if !matches!(
                            part.get("type").and_then(serde_json::Value::as_str),
                            Some(
                                "data-acp-usage"
                                    | "data-ryu-usage"
                                    | "data-ryu-usage-stats"
                                    | "data-ryu-stats"
                            )
                        ) {
                            return None;
                        }
                        let data = part.get("data")?.as_object()?;
                        let mut safe = serde_json::Map::new();
                        if let Some(kind) = part.get("type") {
                            safe.insert("usagePartType".to_owned(), kind.clone());
                        }
                        for key in [
                            "done",
                            "promptTokens",
                            "completionTokens",
                            "cachedReadTokens",
                            "cachedWriteTokens",
                            "cacheReadTokens",
                            "cacheWriteTokens",
                            "cachedOutputTokens",
                            "thoughtTokens",
                            "reasoningTokens",
                            "totalTokens",
                            "observedAt",
                            "historyEventId",
                            "historySourceId",
                            "historySessionId",
                            "historyAccountId",
                            "historyProviderId",
                            "historyModelId",
                            "providerId",
                            "modelId",
                            "provider",
                            "model",
                        ] {
                            if let Some(value) = data
                                .get(key)
                                .filter(|v| v.is_number() || v.is_boolean() || v.is_string())
                            {
                                safe.insert(key.to_owned(), value.clone());
                            }
                        }
                        Some(serde_json::Value::Object(safe))
                    })
                    .collect();
                (rowid, id, conversation, agent, created, metadata)
            })
            .collect())
    }

    /// Fetch all messages of a conversation in chronological order.
    pub async fn get_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        // The raw sealed `parts` blob is carried on `StoredMessage.parts` as a
        // JSON string temporarily, then decrypted + parsed below (outside the DB
        // lock, like `content`/`title`).
        let rows = stmt.query_map([conversation_id], |row| {
            let sealed_parts: Option<String> = row.get(10)?;
            let sealed_metadata: Option<String> = row.get(13)?;
            Ok((
                StoredMessage {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    agent_id: row.get(3)?,
                    author_user_id: row.get(5)?,
                    author_name: row.get(6)?,
                    source: row.get(7)?,
                    widget_instance_id: row.get(8)?,
                    origin_server: row.get(9)?,
                    parts: None,
                    metadata: None,
                    parent_message_id: row.get(11)?,
                    interrupted: row.get::<_, i64>(12)? != 0,
                    sibling_index: 0,
                    sibling_count: 1,
                    sibling_ids: Vec::new(),
                    created_at: row.get(4)?,
                },
                sealed_parts,
                sealed_metadata,
            ))
        })?;
        let raw = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        // Release the store mutex before decrypting: a long conversation's
        // content + parts can be megabytes, and every other chat's reads and
        // streaming checkpoints queue on this lock.
        drop(stmt);
        drop(conn);
        let out = raw
            .into_iter()
            .map(|(mut msg, sealed_parts, sealed_metadata)| {
                msg.content = self.open_content(std::mem::take(&mut msg.content));
                msg.parts = self.open_parts(sealed_parts);
                msg.metadata = self.open_parts(sealed_metadata);
                msg
            })
            .collect();
        Ok(out)
    }

    /// Atomically claim a proactive opening. A completed key is permanent so a
    /// retry after a lost response cannot send a second greeting. A stale running
    /// claim is reclaimed after fifteen minutes, which lets a process killed
    /// during model startup recover without requiring a manual database repair.
    pub async fn claim_proactive_opening(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let stale_before = now_millis() - 15 * 60 * 1000;
        conn.execute(
            "DELETE FROM proactive_openings
             WHERE idempotency_key = ?1 AND status = 'running' AND created_at < ?2",
            params![idempotency_key, stale_before],
        )?;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO proactive_openings
             (idempotency_key, conversation_id, status, created_at)
             VALUES (?1, ?2, 'running', ?3)",
            params![idempotency_key, conversation_id, now_millis()],
        )?;
        Ok(inserted == 1)
    }

    /// Durable state and conversation binding of a proactive opening claim.
    pub async fn proactive_opening_status(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ProactiveOpeningStatus>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT conversation_id, status
             FROM proactive_openings
             WHERE idempotency_key = ?1",
            params![idempotency_key],
            |row| {
                Ok(ProactiveOpeningStatus {
                    conversation_id: row.get(0)?,
                    status: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Mark a proactive opening complete only after its assistant message is
    /// durable. The update is deliberately idempotent.
    pub async fn complete_proactive_opening(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE proactive_openings
             SET status = 'completed', completed_at = ?2
             WHERE idempotency_key = ?1",
            params![idempotency_key, now_millis()],
        )?;
        Ok(())
    }

    /// Release a failed opening so a readiness retry can try again.
    pub async fn release_proactive_opening(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM proactive_openings WHERE idempotency_key = ?1 AND status = 'running'",
            params![idempotency_key],
        )?;
        Ok(())
    }

    /// Atomically claim one channel-session turn. Completed results are retained
    /// for thirty days so a provider redelivery after a Gateway restart replays
    /// the exact Core reply rather than appending another user/assistant pair.
    /// A live processing claim returns `InFlight`; a stale one is reclaimed so a
    /// Core process that died mid-turn does not wedge that provider message.
    pub async fn claim_channel_turn(
        &self,
        idempotency_key: &str,
        conversation_id: &str,
        request_hash: &str,
    ) -> Result<ChannelTurnClaim> {
        let key = idempotency_key.trim();
        if key.is_empty() || key.len() > 500 {
            anyhow::bail!("channel turn idempotency key must be 1..=500 bytes");
        }
        let now = now_millis();
        let stale_before = now - 15 * 60 * 1000;
        let retention_before = now - 30 * 24 * 60 * 60 * 1000;
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM channel_turn_idempotency
             WHERE status = 'completed' AND updated_at < ?1",
            params![retention_before],
        )?;

        let existing: Option<(
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        )> = conn
            .query_row(
                "SELECT conversation_id, request_hash, reply, assistant_message_id,
                        assistant_message_ids, agent_id, fallback_warning,
                        interactive_markup, updated_at
                 FROM channel_turn_idempotency
                 WHERE idempotency_key = ?1",
                params![key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .optional()?;

        if let Some((
            existing_conversation_id,
            existing_hash,
            sealed_reply,
            assistant_message_id,
            assistant_message_ids,
            agent_id,
            fallback_warning,
            sealed_interactive_markup,
            updated_at,
        )) = existing
        {
            if existing_conversation_id != conversation_id || existing_hash != request_hash {
                anyhow::bail!("channel turn idempotency key was reused for a different request");
            }
            if sealed_reply.is_some() {
                let reply = sealed_reply
                    .map(|sealed| self.cipher.open(&sealed))
                    .transpose()?
                    .unwrap_or_default();
                let assistant_message_ids =
                    serde_json::from_str(&assistant_message_ids).unwrap_or_default();
                let interactive_markup = sealed_interactive_markup
                    .map(|sealed| self.cipher.open(&sealed))
                    .transpose()?
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?;
                return Ok(ChannelTurnClaim::Completed(ChannelTurnReplay {
                    reply,
                    assistant_message_id,
                    assistant_message_ids,
                    agent_id,
                    fallback_warning: fallback_warning
                        .map(|sealed| self.cipher.open(&sealed))
                        .transpose()?,
                    interactive_markup,
                }));
            }
            if updated_at >= stale_before {
                return Ok(ChannelTurnClaim::InFlight);
            }
            conn.execute(
                "UPDATE channel_turn_idempotency
                 SET status = 'processing', updated_at = ?2
                 WHERE idempotency_key = ?1",
                params![key, now],
            )?;
            return Ok(ChannelTurnClaim::Claimed);
        }

        conn.execute(
            "INSERT INTO channel_turn_idempotency
             (idempotency_key, conversation_id, request_hash, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'processing', ?4, ?4)",
            params![key, conversation_id, request_hash, now],
        )?;
        Ok(ChannelTurnClaim::Claimed)
    }

    /// Persist the complete channel-session result after the conversation rows
    /// are durable. The update is idempotent and refuses to overwrite a result
    /// that a concurrent retry already completed.
    pub async fn complete_channel_turn(
        &self,
        idempotency_key: &str,
        result: &ChannelTurnReplay,
    ) -> Result<()> {
        let sealed_reply = self.cipher.seal(&result.reply)?;
        let sealed_fallback_warning = result
            .fallback_warning
            .as_deref()
            .map(|warning| self.cipher.seal(warning))
            .transpose()?;
        let assistant_message_ids = serde_json::to_string(&result.assistant_message_ids)?;
        let sealed_interactive_markup = result
            .interactive_markup
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .map(|json| self.cipher.seal(&json))
            .transpose()?;
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE channel_turn_idempotency
             SET status = 'completed', reply = ?2, assistant_message_id = ?3,
                 assistant_message_ids = ?4, agent_id = ?5, fallback_warning = ?6,
                 interactive_markup = ?7, updated_at = ?8
             WHERE idempotency_key = ?1 AND status = 'processing'",
            params![
                idempotency_key.trim(),
                sealed_reply,
                result.assistant_message_id,
                assistant_message_ids,
                result.agent_id,
                sealed_fallback_warning,
                sealed_interactive_markup,
                now_millis(),
            ],
        )?;
        if updated == 0 {
            let status: Option<String> = conn
                .query_row(
                    "SELECT status FROM channel_turn_idempotency WHERE idempotency_key = ?1",
                    params![idempotency_key.trim()],
                    |row| row.get(0),
                )
                .optional()?;
            if status.as_deref() != Some("completed") {
                anyhow::bail!("channel turn idempotency claim disappeared before completion");
            }
        }
        Ok(())
    }

    /// Release a channel-session claim when validation or the model path fails
    /// before a replayable result exists. A later provider retry can then make a
    /// fresh claim instead of receiving a permanent in-flight response.
    pub async fn release_channel_turn(&self, idempotency_key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM channel_turn_idempotency
             WHERE idempotency_key = ?1 AND status = 'processing'",
            params![idempotency_key.trim()],
        )?;
        Ok(())
    }

    /// Read only the plaintext user/assistant projection allowed into learning.
    /// This query deliberately does not select or decrypt `parts`,
    /// `author_user_id`, or `author_name`, and has no read path to the identity
    /// vault or other encrypted-field stores.
    pub async fn get_learning_messages(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<LearningMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(LearningMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut message = row?;
            message.content = self.open_content(message.content);
            out.push(message);
        }
        Ok(out)
    }

    /// Set (or clear) the thumbs feedback on a message. `rating` is `"up"` /
    /// `"down"` to set, or `None` to clear. Scoped by `conversation_id` so a stray
    /// id can't rate another conversation's message. Returns `true` when a row was
    /// updated (i.e. the message exists in this conversation).
    pub async fn set_message_feedback(
        &self,
        conversation_id: &str,
        message_id: &str,
        rating: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE messages SET feedback = ?3
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id, rating],
            )
            .context("setting message feedback")?;
        Ok(n > 0)
    }

    /// The rated messages of a conversation as `(message_id, rating)` pairs
    /// (`rating` is `"up"` / `"down"`). Un-rated messages are omitted, so the map
    /// is small even for long threads. Drives the persisted thumbs state on reload.
    pub async fn list_feedback(&self, conversation_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, feedback FROM messages
             WHERE conversation_id = ?1 AND feedback IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ── Message reactions ─────────────────────────────────────────────────────
    //
    // Same shape as `feedback` above and for the same reason: a per-message datum
    // deliberately kept OUT of the `get_messages` SELECT (which has many non-UI
    // callers) and served instead by one bulk per-conversation read fetched
    // alongside the transcript. Unlike feedback, a reaction is per-*person*, so it
    // needs its own table rather than a column.
    //
    // Two deliberate policies, both visible in the code below:
    //   * **Reactions are per message VERSION.** `edit_user_message` mints a fresh
    //     uuid rather than mutating the row, so an edited message is a new row and
    //     starts with no reactions. That is honest — people reacted to different
    //     text — and needs no migration. `sibling_ids` is the only link if
    //     carry-forward is ever wanted.
    //   * **A message must be persisted before it can be reacted to.** Every write
    //     first proves the id exists *in this conversation* (`WHERE EXISTS` on
    //     `messages`). FK enforcement is off, so without that check any string
    //     would insert an orphan row. This is also why there is no
    //     `allow_latest_fallback` twin of the feedback retarget hack: a streaming
    //     reply still carrying its client-generated id simply 404s until it lands.

    /// Add `emoji` from `user_id` to a message. Scoped by `conversation_id` so a
    /// stray id can't react into another conversation, and gated on the message
    /// actually existing (see the module note above). Idempotent: reacting twice
    /// with the same emoji keeps one row. Returns `false` when the message is not
    /// in this conversation (→ 404 at the route) and `true` otherwise; a repeat of
    /// an existing reaction returns `true` but does not fan out.
    pub async fn add_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
    ) -> Result<bool> {
        let now = now_millis();
        let inserted = {
            let conn = self.conn.lock().await;
            if !message_in_conversation(&conn, conversation_id, message_id)? {
                return Ok(false);
            }
            conn.execute(
                "INSERT OR IGNORE INTO message_reactions
                     (message_id, conversation_id, user_id, emoji, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![message_id, conversation_id, user_id, emoji, now],
            )
            .context("adding message reaction")?
        };
        if inserted > 0 {
            self.broadcast_reaction(conversation_id, message_id, user_id, emoji, "add");
        }
        Ok(true)
    }

    /// Remove `emoji` by `user_id` from a message. Same scoping and the same
    /// message-exists gate as [`ConversationStore::add_reaction`]. Returns `false`
    /// when the message is not in this conversation; removing a reaction that was
    /// never placed is a success (`true`) but does not fan out.
    pub async fn remove_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
    ) -> Result<bool> {
        let removed = {
            let conn = self.conn.lock().await;
            if !message_in_conversation(&conn, conversation_id, message_id)? {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM message_reactions
                 WHERE message_id = ?1 AND conversation_id = ?2
                   AND user_id = ?3 AND emoji = ?4",
                params![message_id, conversation_id, user_id, emoji],
            )
            .context("removing message reaction")?
        };
        if removed > 0 {
            self.broadcast_reaction(conversation_id, message_id, user_id, emoji, "remove");
        }
        Ok(true)
    }

    /// Every reaction bucket of a conversation, aggregated. `viewer_user_id` is the
    /// caller whose own reactions light up (`reacted_by_me`) — it is resolved in the
    /// same GROUP BY, never a second query. Ordered by first-placed so the chip row
    /// does not reshuffle between reloads.
    pub async fn list_reactions(
        &self,
        conversation_id: &str,
        viewer_user_id: &str,
    ) -> Result<Vec<MessageReaction>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT r.message_id,
                    r.emoji,
                    COUNT(*)                                            AS count,
                    MAX(CASE WHEN r.user_id = ?2 THEN 1 ELSE 0 END)     AS mine,
                    MIN(r.created_at)                                   AS first_at
             FROM message_reactions r
             JOIN messages m
               ON m.id = r.message_id
              AND m.conversation_id = r.conversation_id
             WHERE r.conversation_id = ?1
             GROUP BY r.message_id, r.emoji
             ORDER BY first_at ASC, emoji ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, viewer_user_id], |row| {
            Ok(MessageReaction {
                message_id: row.get(0)?,
                emoji: row.get(1)?,
                count: row.get(2)?,
                reacted_by_me: row.get::<_, i64>(3)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The id of the most recently persisted user message in a conversation.
    ///
    /// An agent's turn always starts after its triggering user message has been
    /// appended, so this is the message an agent means when it reacts "to what
    /// the user just said" without naming an id it was never shown.
    pub async fn latest_user_message_id(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id FROM messages
             WHERE conversation_id = ?1 AND role = 'user'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("reading latest user message id")
    }

    /// Agent-authored emojis on the conversation's latest user message, oldest
    /// first. A channel turn mirrors these onto the provider message that
    /// started it, so the bot's reaction shows on Telegram/Slack/Discord the same
    /// way it shows in the desktop transcript.
    pub async fn agent_reactions_on_latest_user_message(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<String>> {
        let Some(message_id) = self.latest_user_message_id(conversation_id).await? else {
            return Ok(Vec::new());
        };
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT emoji FROM message_reactions
             WHERE conversation_id = ?1 AND message_id = ?2 AND user_id LIKE 'agent:%'
             ORDER BY created_at ASC, emoji ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, message_id], |row| row.get(0))?;
        let mut out: Vec<String> = Vec::new();
        for row in rows {
            let emoji: String = row?;
            if !out.contains(&emoji) {
                out.push(emoji);
            }
        }
        Ok(out)
    }

    /// Save the interactive state of one generative-UI widget (`ui.render`) so a
    /// checklist, form or calculator reopens the way the user left it.
    ///
    /// Keyed by the tool call id rather than the message id: the tool call id is
    /// stable from the first streamed frame, while a still-streaming reply's
    /// message id is client-generated until the turn lands. The value is opaque
    /// JSON owned by the desktop renderer and sealed like message bodies, since it
    /// holds whatever the user typed. Returns `false` (→ 409 at the route) when
    /// the conversation already holds [`MAX_AGENT_UI_STATES`] widgets and this
    /// call would add a new one; updating an existing widget always succeeds.
    pub async fn set_agent_ui_state(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        state_json: &str,
    ) -> Result<bool> {
        let sealed = self.cipher.seal(state_json)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM agent_ui_state WHERE conversation_id = ?1 AND tool_call_id = ?2",
                params![conversation_id, tool_call_id],
                |_| Ok(()),
            )
            .optional()
            .context("reading agent ui state")?
            .is_some();
        if !exists {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_ui_state WHERE conversation_id = ?1",
                    params![conversation_id],
                    |row| row.get(0),
                )
                .context("counting agent ui state")?;
            if count >= MAX_AGENT_UI_STATES {
                return Ok(false);
            }
        }
        conn.execute(
            "INSERT INTO agent_ui_state (conversation_id, tool_call_id, state, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation_id, tool_call_id)
             DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
            params![conversation_id, tool_call_id, sealed, now],
        )
        .context("saving agent ui state")?;
        Ok(true)
    }

    /// Every saved generative-UI widget state in a conversation, oldest update
    /// first. A row that no longer decrypts or parses is skipped (the widget falls
    /// back to its spec's initial state) rather than failing the whole read.
    pub async fn list_agent_ui_states(&self, conversation_id: &str) -> Result<Vec<AgentUiState>> {
        let rows: Vec<(String, String, i64)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT tool_call_id, state, updated_at FROM agent_ui_state
                 WHERE conversation_id = ?1 ORDER BY updated_at ASC",
            )?;
            let mapped = stmt.query_map(params![conversation_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            mapped.collect::<std::result::Result<_, _>>()?
        };
        Ok(rows
            .into_iter()
            .filter_map(|(tool_call_id, sealed, updated_at)| {
                let plaintext = self.cipher.open(&sealed).ok()?;
                let state = serde_json::from_str(&plaintext).ok()?;
                Some(AgentUiState {
                    tool_call_id,
                    state,
                    updated_at,
                })
            })
            .collect())
    }

    /// Room-keyed realtime fan-out for a reaction, mirroring the
    /// `conversation.message` publish in `append_message`: a self-describing
    /// `"type": "reaction"` payload on the typed named-event contract. The DB lock
    /// is already released by every caller. Do NOT pre-wrap with `"channel"` —
    /// `frame_to_message` in the WS gateway does that. No-op when realtime is
    /// unwired (tests/CLI) or the room has no members.
    fn broadcast_reaction(
        &self,
        conversation_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
        op: &str,
    ) {
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.reaction",
                serde_json::json!({
                    "type": "reaction",
                    "conversation_id": conversation_id,
                    "message_id": message_id,
                    "emoji": emoji,
                    "user_id": user_id,
                    "op": op,
                }),
            );
        }
    }

    /// Return the durable per-person read markers for a conversation. The join
    /// back to `messages` is intentional: older databases did not enable foreign
    /// keys, so an orphaned marker must never surface as a receipt for a message
    /// that no longer exists.
    pub async fn list_read_receipts(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<MessageReadReceipt>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT receipt.message_id, receipt.user_id, receipt.read_at
             FROM message_read_receipts AS receipt
             INNER JOIN messages AS message
               ON message.id = receipt.message_id
              AND message.conversation_id = receipt.conversation_id
             WHERE receipt.conversation_id = ?1
             ORDER BY receipt.read_at ASC, receipt.rowid ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            let read_at: i64 = row.get(2)?;
            Ok(MessageReadReceipt {
                message_id: row.get(0)?,
                user_id: row.get(1)?,
                read_at: millis_to_rfc3339(read_at),
                user_name: None,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Mark a bounded set of messages read for one verified human. The composite
    /// key makes the operation idempotent across tabs, retries, and reconnects;
    /// only the first insert fans a receipt event out to the room.
    pub async fn mark_messages_read(
        &self,
        conversation_id: &str,
        message_ids: &[String],
        user_id: &str,
        user_name: Option<&str>,
    ) -> Result<Vec<MessageReadReceipt>> {
        let read_at_ms = now_millis();
        let read_at = millis_to_rfc3339(read_at_ms);
        let inserted_ids = {
            let conn = self.conn.lock().await;
            let mut inserted = Vec::new();
            for message_id in message_ids {
                if !message_in_conversation(&conn, conversation_id, message_id)? {
                    continue;
                }
                let count = conn
                    .execute(
                        "INSERT OR IGNORE INTO message_read_receipts
                             (message_id, conversation_id, user_id, read_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![message_id, conversation_id, user_id, read_at_ms],
                    )
                    .context("marking message read")?;
                if count > 0 {
                    inserted.push(message_id.clone());
                }
            }
            inserted
        };

        let receipts = inserted_ids
            .into_iter()
            .map(|message_id| MessageReadReceipt {
                message_id,
                user_id: user_id.to_owned(),
                read_at: read_at.clone(),
                user_name: user_name.map(str::to_owned),
            })
            .collect::<Vec<_>>();
        for receipt in &receipts {
            self.broadcast_read_receipt(conversation_id, receipt);
        }
        Ok(receipts)
    }

    /// Broadcast one newly-created receipt without holding the conversation DB
    /// lock. `readAt` and the optional display name are presentation metadata;
    /// the durable source of truth remains the table above.
    fn broadcast_read_receipt(&self, conversation_id: &str, receipt: &MessageReadReceipt) {
        if let Some(realtime) = &self.realtime {
            realtime.broadcast_event(
                conversation_id,
                "conversation.readReceipt",
                serde_json::json!({
                    "type": "readReceipt",
                    "conversationId": conversation_id,
                    "messageId": receipt.message_id,
                    "userId": receipt.user_id,
                    "readAt": receipt.read_at,
                    "userName": receipt.user_name,
                }),
            );
        }
    }

    /// The decrypted `(user_prompt, assistant_reply, agent_id)` for the turn that
    /// the given assistant message closes: the assistant text plus the *nearest
    /// preceding user message* in chronological order. `None` when the id is not an
    /// assistant message or has no user message before it. Used to seed the
    /// learning reward + RAG memory sinks from a thumbs vote.
    ///
    /// Note the pairing walks back to the nearest user message regardless of any
    /// intervening assistant rows, so it resolves correctly for a regenerated /
    /// edited sibling (`[user, asstV1, asstV2]` — voting `asstV2` still maps to
    /// `user`) and for council/team turns with several consecutive assistant
    /// replies (each maps to the same preceding user turn).
    pub async fn get_turn_for_assistant_message(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<(String, String, Option<String>)>> {
        let messages = self.get_messages(conversation_id).await?;
        let Some(idx) = messages
            .iter()
            .position(|m| m.id == message_id && m.role == "assistant")
        else {
            return Ok(None);
        };
        // Nearest preceding user message (skip intervening assistant siblings).
        for user in messages[..idx].iter().rev() {
            if user.role == "user" {
                let asst = &messages[idx];
                return Ok(Some((
                    user.content.clone(),
                    asst.content.clone(),
                    asst.agent_id.clone(),
                )));
            }
        }
        Ok(None)
    }

    /// The id of a conversation's most recent assistant message, if any. A
    /// freshly-streamed reply is rendered under a client-generated id that never
    /// reached the DB (Core assigns its own uuid at persist time), so a thumbs vote
    /// on the just-produced reply can't match by id until the thread is reloaded.
    /// The feedback handler falls back to this newest assistant row when the client
    /// flags the vote as the latest turn — resolving that common live case.
    pub async fn latest_assistant_message_id(
        &self,
        conversation_id: &str,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM messages
                 WHERE conversation_id = ?1 AND role = 'assistant'
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading latest assistant message")?;
        Ok(id)
    }

    /// The decrypted text of a conversation's earliest user message, if any.
    /// Used by the auto-namer to seed a concise title from what the user first
    /// asked. Returns `None` for conversations with no user turn yet.
    pub async fn get_first_user_message(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let sealed: Option<String> = conn
            .query_row(
                "SELECT content FROM messages
                 WHERE conversation_id = ?1 AND role = 'user'
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading first user message")?;
        Ok(sealed.map(|s| self.open_content(s)))
    }

    /// Remove index rows whose source message no longer exists (conversations
    /// deleted before deletes reached the indexes, or by an older build).
    /// Best-effort: a failure leaves the orphans for the next pass; search
    /// already drops hits that no longer resolve.
    async fn sweep_index_orphans(
        &self,
        lexical: bool,
        indexed: &std::collections::HashSet<String>,
    ) {
        if indexed.is_empty() {
            return;
        }
        let existing: std::collections::HashSet<String> = {
            let conn = self.conn.lock().await;
            let ids = conn
                .prepare("SELECT id FROM messages")
                .and_then(|mut stmt| {
                    stmt.query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<_>>()
                });
            match ids {
                Ok(ids) => ids,
                Err(error) => {
                    tracing::warn!("search index orphan sweep skipped: {error:#}");
                    return;
                }
            }
        };
        let orphans: Vec<String> = indexed
            .iter()
            .filter(|id| !existing.contains(*id))
            .cloned()
            .collect();
        if orphans.is_empty() {
            return;
        }
        let result = if lexical {
            match self.message_fts.as_ref() {
                Some(index) => index.delete_messages(&orphans).await,
                None => Ok(0),
            }
        } else {
            match self.message_index.as_ref() {
                Some(index) => index.delete_messages(&orphans).await,
                None => Ok(0),
            }
        };
        match result {
            Ok(removed) => tracing::info!(lexical, removed, "search index: removed orphaned rows"),
            Err(error) => tracing::warn!("search index orphan sweep failed: {error:#}"),
        }
    }

    /// Reconcile once against index metadata, then consume only queued revisions.
    /// The caller holds that index's backfill mutex across awaits. Failed rows
    /// remain queued, but are attempted only once per pass; newer writes receive
    /// a new revision and cannot be acknowledged by an older in-flight request.
    async fn reconcile_search_index(&self, lexical: bool, initialized: &mut bool) -> Result<()> {
        if !self.chat_memory_enabled() {
            return Ok(());
        }
        let kind = i64::from(lexical);
        if !*initialized {
            {
                let conn = self.conn.lock().await;
                conn.execute(
                    "INSERT OR IGNORE INTO message_search_pending(kind, message_id, dirty)
                     SELECT ?1, id, 0 FROM messages",
                    [kind],
                )?;
            }
            let indexed = if lexical {
                self.message_fts
                    .as_ref()
                    .expect("FTS wired")
                    .indexed_ids()
                    .await?
            } else {
                self.message_index
                    .as_ref()
                    .expect("semantic wired")
                    .indexed_ids()
                    .await?
            };
            self.sweep_index_orphans(lexical, &indexed).await;
            let conn = self.conn.lock().await;
            let transaction = conn.unchecked_transaction()?;
            {
                let mut delete = transaction.prepare_cached(
                    "DELETE FROM message_search_pending WHERE kind = ?1 AND message_id = ?2 AND dirty = 0",
                )?;
                for id in indexed {
                    delete.execute(params![kind, id])?;
                }
            }
            transaction.commit()?;
            *initialized = true;
        }
        let end: i64 = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM message_search_pending WHERE kind = ?1",
                [kind],
                |row| row.get(0),
            )?
        };
        let mut after = 0;
        let mut failures = 0;
        while after < end && self.chat_memory_enabled() {
            let pending = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare_cached(MESSAGE_SEARCH_BATCH_SQL)?;
                let rows = stmt.query_map(params![kind, after, end], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if pending.is_empty() {
                break;
            }
            for (revision, id, conversation, role, sealed, created, dirty) in pending {
                if !self.chat_memory_enabled() {
                    return Ok(());
                }
                after = revision;
                // Append's best-effort worker may already have written this new
                // message. Check one indexed key, never reload all indexed IDs.
                // Updates (dirty = 2) must still replace any older embedding.
                if !lexical
                    && dirty == 1
                    && self
                        .message_index
                        .as_ref()
                        .expect("semantic wired")
                        .contains_message(&id)
                        .await?
                {
                    let conn = self.conn.lock().await;
                    conn.execute(
                        "DELETE FROM message_search_pending WHERE revision = ?1",
                        [revision],
                    )?;
                    continue;
                }
                let Some(content) = self.open_content_for_index(sealed) else {
                    // Never index placeholder text for a body that did not open.
                    let conn = self.conn.lock().await;
                    conn.execute(
                        "DELETE FROM message_search_pending WHERE revision = ?1",
                        [revision],
                    )?;
                    continue;
                };
                let result = if content.trim().is_empty() {
                    if lexical && dirty == 2 {
                        // Edited to empty: the old tokens must not stay searchable.
                        self.message_fts
                            .as_ref()
                            .expect("FTS wired")
                            .delete_messages(std::slice::from_ref(&id))
                            .await
                            .map(|_| ())
                    } else {
                        Ok(())
                    }
                } else if lexical {
                    self.message_fts
                        .as_ref()
                        .expect("FTS wired")
                        .index_message(&id, &conversation, &role, &content, created)
                        .await
                } else {
                    let index = self.message_index.as_ref().expect("semantic wired");
                    let embedder = index.embedder();
                    match embedder.embed(&content).await {
                        Ok(vector) if self.chat_memory_enabled() => {
                            index
                                .index_message(
                                    &id,
                                    &conversation,
                                    &role,
                                    &vector,
                                    embedder.model_id(),
                                    created,
                                )
                                .await
                        }
                        Ok(_) => return Ok(()),
                        Err(error) => Err(error),
                    }
                };
                match result {
                    Ok(()) => {
                        failures = 0;
                        let conn = self.conn.lock().await;
                        conn.execute(
                            "DELETE FROM message_search_pending WHERE revision = ?1",
                            [revision],
                        )?;
                    }
                    Err(error) => {
                        failures += 1;
                        tracing::warn!("message search backfill failed for {id}: {error:#}");
                        if !lexical && failures >= 3 {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Semantic search over past conversation messages (the `search_conversations`
    /// builtin tool). Returns `None` when no message index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the index
    /// is decrypted and embedded so the feature returns hits for chats already on
    /// disk, not just future ones. A failed embed during backfill is non-fatal —
    /// that message is skipped this round (the next search retries it). Then runs a
    /// KNN over the index and re-reads + decrypts each hit's snippet from this db
    /// (the index stores only vectors + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its
    /// vector) are dropped.
    pub async fn search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        // Chat-message search is an explicit Memory opt-in. Guard the semantic
        // backfill as well as KNN so callers cannot materialize an index by
        // invoking the store directly instead of going through the HTTP/MCP
        // gates.
        if !self.chat_memory_enabled() {
            return Ok(None);
        }
        let Some(index) = self.message_index.clone() else {
            return Ok(None);
        };

        if index.embedder().is_local() {
            let mut initialized = self.semantic_backfill.lock().await;
            self.reconcile_search_index(false, &mut initialized).await?;
        } else if let Ok(mut initialized) = self.semantic_backfill.clone().try_lock_owned() {
            // One remote backfill owns the queue. Its bounded reads and network
            // calls run off the request path, including the first reconciliation.
            let store = self.clone();
            tokio::spawn(async move {
                if let Err(error) = store.reconcile_search_index(false, &mut initialized).await {
                    tracing::warn!("semantic backfill failed: {error:#}");
                }
            });
        }

        // ── KNN + snippet re-read ────────────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<String> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            };
            // Drop orphaned vectors (message deleted out from under the index).
            let Some(sealed) = sealed else { continue };
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.open_content(sealed),
                created_at: hit.created_at,
                // vec0's default metric is L2 (Euclidean) distance. The embedder
                // L2-normalizes its vectors, so distance lies in [0, 2] (0 =
                // identical, 2 = opposite). Map it to a monotonic [0, 1] relevance
                // hint — this preserves ranking and gives a bounded score; it is a
                // relevance indicator, not an exact cosine value.
                score: (1.0 - hit.distance / 2.0).clamp(0.0, 1.0),
            });
        }
        Ok(Some(out))
    }

    /// Full-text (FTS5) search over past conversation messages — the lexical/keyword
    /// complement to [`search_messages`] (semantic KNN). Returns `None` when no FTS
    /// index is wired.
    ///
    /// Performs a **lazy backfill** first: any stored message not yet in the FTS
    /// index is decrypted and indexed so the feature returns hits for chats already
    /// on disk, not just future ones. Unlike the semantic backfill this is
    /// network-free (no embedder), so it runs INLINE (awaited) rather than spawned —
    /// a down embed sidecar can never affect it. Then runs the FTS MATCH and
    /// re-reads + decrypts each hit's snippet from this db (the FTS index stores only
    /// the tokenized inverted index + metadata, never message text). Hits whose
    /// message id no longer resolves (e.g. a deleted conversation orphaned its FTS
    /// row) are dropped.
    pub async fn fts_search_messages(
        &self,
        query: &str,
        limit: usize,
        conversation_ids: Option<&[String]>,
    ) -> Result<Option<Vec<MessageSearchHit>>> {
        // Chat-message search is an explicit Memory opt-in. Guard the FTS
        // backfill as well as MATCH so a disabled feature never materializes a
        // lexical index merely because a caller asks for an exact search.
        if !self.chat_memory_enabled() {
            return Ok(None);
        }
        let Some(index) = self.message_fts.clone() else {
            return Ok(None);
        };

        {
            let mut initialized = self.fts_backfill.lock().await;
            self.reconcile_search_index(true, &mut initialized).await?;
        }

        // ── FTS MATCH + snippet re-read ──────────────────────────────────────
        let hits = index.search(query, limit, conversation_ids).await?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            let sealed: Option<String> = {
                let conn = self.conn.lock().await;
                conn.query_row(
                    "SELECT content FROM messages WHERE id = ?1",
                    [&hit.message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            };
            // Drop orphaned rows (message deleted out from under the index).
            let Some(sealed) = sealed else { continue };
            out.push(MessageSearchHit {
                conversation_id: hit.conversation_id,
                message_id: hit.message_id,
                role: hit.role,
                content: self.open_content(sealed),
                created_at: hit.created_at,
                score: hit.score,
            });
        }
        Ok(Some(out))
    }

    /// Fetch the most recent `limit` messages of a conversation, returned in
    /// chronological order (oldest first). Used by short-term memory (spec unit
    /// U11) to assemble recent session context for each request without
    /// replaying the entire history.
    ///
    /// Once a conversation has a version tree (non-NULL leaf), this follows the
    /// active thread like [`Self::get_active_messages`]: rewound, edited-away and
    /// regenerated-over rows stay in the table as alternate versions and must
    /// not be replayed to the model as if they were still the conversation.
    pub async fn get_recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredMessage>> {
        // Short-term-memory context assembly feeds the model plain text, so the
        // structured parts, metadata and the render-side interruption marker are
        // intentionally not read here — only the reload paths decode them.
        fn recent_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMessage> {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
                parts: None,
                metadata: None,
                parent_message_id: None,
                interrupted: false,
                sibling_index: 0,
                sibling_count: 1,
                sibling_ids: Vec::new(),
                created_at: row.get(4)?,
                author_user_id: row.get(5)?,
                author_name: row.get(6)?,
                source: row.get(7)?,
                widget_instance_id: row.get(8)?,
                origin_server: row.get(9)?,
            })
        }
        const RECENT_COLUMNS: &str = "id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server";

        let conn = self.conn.lock().await;
        // Newest first in both branches; reversed to chronological order below.
        let mut out = match Self::active_leaf_locked(&conn, conversation_id)? {
            Some(leaf) => {
                let ids = Self::active_ancestor_ids_locked(&conn, conversation_id, &leaf, limit)?;
                let mut stmt = conn.prepare_cached(&format!(
                    "SELECT {RECENT_COLUMNS} FROM messages WHERE id = ?1 AND conversation_id = ?2"
                ))?;
                let mut out = Vec::with_capacity(ids.len());
                for id in &ids {
                    out.push(
                        stmt.query_row(params![id, conversation_id], recent_message_from_row)?,
                    );
                }
                out
            }
            None => {
                // Never branched: the newest `limit` rows are the thread.
                let mut stmt = conn.prepare(&format!(
                    "SELECT {RECENT_COLUMNS}
                     FROM messages
                     WHERE conversation_id = ?1
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?2"
                ))?;
                let rows = stmt.query_map(
                    params![conversation_id, limit as i64],
                    recent_message_from_row,
                )?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        // Runs on every chat turn: decrypt after releasing the store mutex.
        drop(conn);
        for msg in &mut out {
            msg.content = self.open_content(std::mem::take(&mut msg.content));
        }
        out.reverse();
        Ok(out)
    }

    /// Update conversation metadata only when `incoming_updated_at` is strictly
    /// newer than the stored `updated_at` value (last-writer-wins).
    /// Used by the cross-device sync client (`server/sync.rs`).
    pub async fn update_metadata_if_newer(
        &self,
        conversation_id: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
        folder_path: Option<&str>,
        branch: Option<&str>,
        worktree_path: Option<&str>,
        run_status: Option<&str>,
        incoming_updated_at: i64,
    ) -> Result<()> {
        let title = self.seal_opt(title)?;
        let conn = self.conn.lock().await;
        // Only overwrite when the incoming timestamp is >= the stored one (LWW).
        conn.execute(
            "UPDATE conversations
             SET title         = COALESCE(?2, title),
                 agent_id      = COALESCE(?3, agent_id),
                 folder_path   = COALESCE(?4, folder_path),
                 branch        = COALESCE(?5, branch),
                 worktree_path = COALESCE(?6, worktree_path),
                 run_status    = COALESCE(?7, run_status),
                 updated_at    = ?8
             WHERE id = ?1 AND updated_at <= ?8",
            params![
                conversation_id,
                title,
                agent_id,
                folder_path,
                branch,
                worktree_path,
                run_status,
                incoming_updated_at,
            ],
        )
        .context("update_metadata_if_newer")?;
        Ok(())
    }

    /// Append a message with an explicit stable id (used by the sync client to
    /// replay messages from a remote payload without generating new ids).
    /// Skips the insert silently when a message with the given id already
    /// exists (idempotent — union-merge semantics for cross-device sync).
    pub async fn append_message_with_id(
        &self,
        conversation_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        created_at_ms: i64,
        tenancy: Tenancy,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        // Upsert the conversation row so the message FK is satisfied — through the
        // choke point, so a replayed conversation is born owned rather than
        // NULL-tenanted (and therefore invisible) on an org-bound node.
        upsert_conversation_row(
            &conn,
            conversation_id,
            created_at_ms,
            &tenancy,
            &ConvRow {
                agent_id,
                ..ConvRow::default()
            },
            Touch::Max,
        )?;

        // INSERT OR IGNORE: skip when the message id already exists (idempotent).
        let sealed = self.cipher.seal(content)?;
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![message_id, conversation_id, role, sealed, agent_id, created_at_ms],
        )
        .context("inserting message with explicit id")?;
        Ok(())
    }

    /// Insert one replayed message after `ensure_sync_conversation` established
    /// the row and tenancy. Unlike `append_message_with_id`, this does not touch
    /// conversation metadata, so replay order cannot replace a newer active agent
    /// or timestamp before LWW metadata resolution runs.
    pub async fn append_sync_message_with_id(
        &self,
        conversation_id: &str,
        message_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        created_at_ms: i64,
    ) -> Result<bool> {
        let sealed = self.cipher.seal(content)?;
        let conn = self.conn.lock().await;
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO messages
                    (id, conversation_id, role, content, agent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message_id,
                    conversation_id,
                    role,
                    sealed,
                    agent_id,
                    created_at_ms
                ],
            )
            .context("inserting sync message with explicit id")?;
        Ok(inserted == 1)
    }

    /// Chain the rows an RNP resume just imported into the version tree.
    ///
    /// Sync inserts carry no parent, so once a conversation has a tree (non-NULL
    /// leaf) they are unreachable from the active thread that the chat view and
    /// the next turn's context read. `transcript_ids` is the resumed bundle's
    /// transcript in thread order (one linear active-thread export),
    /// `context_ids` its imported context items, and `inserted` the subset of both
    /// that this resume added. Each inserted row is parented on its predecessor.
    ///
    /// The leaf moves only when the import continues the active thread: the
    /// inserted transcript rows are the bundle's tail and either follow the leaf
    /// itself or share no row with the target (a `Recent` export past the
    /// target's history), in which case they start beneath the leaf. When the
    /// target has its own turns after the shared row, the imported transcript
    /// stays an alternate branch beneath that row (reachable through the version
    /// pager) and its context items follow it, so the target's newer local turns
    /// remain selected. Context items imported without new transcript rows join
    /// the active thread beneath the leaf. A never-branched conversation is left
    /// flat, where reads already follow creation order.
    pub async fn link_resumed_messages(
        &self,
        conversation_id: &str,
        transcript_ids: &[String],
        context_ids: &[String],
        inserted: &std::collections::HashSet<String>,
    ) -> Result<()> {
        if !transcript_ids
            .iter()
            .chain(context_ids)
            .any(|id| inserted.contains(id))
        {
            return Ok(());
        }
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting resume link transaction")?;
        let Some(leaf) = Self::active_leaf_locked(&tx, conversation_id)? else {
            return Ok(());
        };
        let link = |parent: Option<&str>, id: &str| -> Result<()> {
            tx.execute(
                "UPDATE messages SET parent_message_id = ?1
                 WHERE id = ?2 AND conversation_id = ?3",
                params![parent, id, conversation_id],
            )
            .context("linking resumed message")?;
            Ok(())
        };
        // Where the active thread ends, and whether the context items follow it.
        let mut active_tail = leaf.clone();
        let mut previous: Option<String> = Some(leaf.clone());
        let mut context_on_active_thread = true;
        if let Some(first_new) = transcript_ids.iter().position(|id| inserted.contains(id)) {
            let anchor = first_new
                .checked_sub(1)
                .map(|index| transcript_ids[index].clone());
            let new_tail = transcript_ids[first_new..]
                .iter()
                .all(|id| inserted.contains(id));
            let appends = new_tail && anchor.as_deref().is_none_or(|anchor| anchor == leaf);
            let mut transcript_previous = if appends { Some(leaf.clone()) } else { anchor };
            for id in &transcript_ids[first_new..] {
                if inserted.contains(id) {
                    link(transcript_previous.as_deref(), id.as_str())?;
                }
                transcript_previous = Some(id.clone());
            }
            if appends {
                active_tail = transcript_previous.clone().unwrap_or_else(|| leaf.clone());
                previous = transcript_previous;
            } else if new_tail {
                // An alternate branch: keep its context items with it.
                context_on_active_thread = false;
                previous = transcript_previous;
            }
        }
        for id in context_ids {
            if inserted.contains(id) {
                link(previous.as_deref(), id.as_str())?;
                if context_on_active_thread {
                    active_tail = id.clone();
                }
                previous = Some(id.clone());
            }
        }
        if active_tail != leaf {
            tx.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![active_tail, conversation_id],
            )
            .context("advancing leaf to resumed thread")?;
        }
        tx.commit().context("committing resume link")?;
        Ok(())
    }

    /// Place the rows a cloud-sync pull or git-checkpoint import just inserted
    /// into the receiver's version tree.
    ///
    /// Replayed rows are inserted with a NULL parent, so in a branched receiver
    /// (non-NULL leaf) they would be unreachable from the active thread that the
    /// chat view and the next turn's context read. `rows` is the replayed batch
    /// in payload order with each row's source tree position; `inserted` is the
    /// subset this replay added. Rows that already existed are never re-parented.
    ///
    /// In a branched receiver, each inserted row keeps its source parent when the
    /// receiver holds that parent and linking it keeps the tree acyclic. A
    /// [`SyncParent::Root`] row stays a root. A row with no parent, a parent the
    /// receiver does not hold, or a parent that would close a loop (a payload
    /// naming rows as each other's parents) continues the thread: it is parented
    /// on the current tail, and later such rows chain beneath it. The leaf moves
    /// only down onto inserted rows that descend from it, so it never leaves newer
    /// local turns: a row whose parent is an earlier message becomes an alternate
    /// version reachable through the pager. A never-branched receiver is left
    /// untouched: its leaf stays NULL, its reads stay flat, and its rows keep NULL
    /// parents (branching later rebuilds every parent chronologically).
    pub async fn link_synced_messages(
        &self,
        conversation_id: &str,
        rows: &[SyncLink],
        inserted: &std::collections::HashSet<String>,
    ) -> Result<()> {
        if inserted.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting sync link transaction")?;
        let Some(leaf) = Self::active_leaf_locked(&tx, conversation_id)? else {
            // Flat receiver: the pre-tree behaviour, no writes.
            return Ok(());
        };
        // The end of the thread this replay continues, and (once it is an
        // inserted row) its parent, so a later sibling version replaces it.
        let mut tail = leaf.clone();
        let mut tail_parent: Option<String> = None;
        // Inserted children of each parent, in payload order.
        let mut children: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        {
            let mut exists =
                tx.prepare_cached("SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2")?;
            let mut parent_of = tx.prepare_cached(
                "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
            )?;
            let mut link = tx.prepare_cached(
                "UPDATE messages SET parent_message_id = ?1
                 WHERE id = ?2 AND conversation_id = ?3",
            )?;
            let mut ancestry = VersionAncestry::default();
            let mut placed = std::collections::HashSet::new();
            for row in rows.iter().filter(|row| inserted.contains(&row.id)) {
                // A payload may repeat an id; place each row once.
                if !placed.insert(row.id.as_str()) {
                    continue;
                }
                let mut parent = None;
                if let SyncParent::Message(source) = &row.parent {
                    let held = exists
                        .query_row(params![source, conversation_id], |_| Ok(()))
                        .optional()
                        .context("checking synced parent")?
                        .is_some();
                    if held
                        && ancestry.extends_tree(
                            &mut parent_of,
                            conversation_id,
                            source,
                            &row.id,
                        )?
                    {
                        parent = Some(source.clone());
                    }
                }
                if parent.is_none()
                    && row.parent != SyncParent::Root
                    && ancestry.extends_tree(&mut parent_of, conversation_id, &tail, &row.id)?
                {
                    // No usable source position: continue the receiver's thread.
                    parent = Some(tail.clone());
                }
                let Some(parent) = parent else {
                    continue;
                };
                link.execute(params![parent, row.id, conversation_id])
                    .context("linking synced message")?;
                ancestry.link(&row.id, &parent);
                if tail == parent || tail_parent.as_deref() == Some(parent.as_str()) {
                    tail_parent = Some(parent.clone());
                    tail = row.id.clone();
                }
                children.entry(parent).or_default().push(row.id.clone());
            }
        }
        // Follow inserted descendants of the tail, whatever order they arrived
        // in; the newest version wins where the source branched below it.
        let mut visited = std::collections::HashSet::from([tail.clone()]);
        while let Some(next) = children
            .get(&tail)
            .and_then(|ids| ids.last())
            .filter(|id| visited.insert((*id).clone()))
        {
            tail = next.clone();
        }
        if tail != leaf {
            tx.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
                params![tail, conversation_id],
            )
            .context("advancing leaf to synced thread")?;
        }
        tx.commit().context("committing sync link")?;
        Ok(())
    }

    /// The conversation's selected leaf, or `None` while it has never been
    /// branched (its rows are flat and carry no meaningful parents).
    pub async fn active_leaf(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        Self::active_leaf_locked(&conn, conversation_id)
    }

    /// Fetch full conversation detail including messages and participants.
    pub async fn get_conversation_detail(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationDetail>> {
        // Serve the *active* thread (the currently-selected branch) so a reloaded
        // conversation renders the version the user last chose, with sibling
        // counts for the pager. Flat (never-branched) conversations fall back to
        // full chronological order inside `get_active_messages`.
        let messages = self.get_active_messages(conversation_id).await?;
        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, agent_id, created_at, updated_at, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((title, agent_id, created_at, updated_at, participants_json)) => {
                let participants = parse_participants_json(participants_json.as_deref());
                Ok(Some(ConversationDetail {
                    id: conversation_id.to_owned(),
                    title: self.open_opt(title),
                    agent_id,
                    created_at,
                    updated_at,
                    messages,
                    participants,
                    has_older_messages: false,
                    older_messages_cursor: None,
                }))
            }
        }
    }

    /// Fetch one chronological page from a never-branched conversation without
    /// loading or decrypting the rest of the transcript. The extra row is the
    /// existence check for the next older page.
    async fn get_flat_message_page(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<StoredMessage>, bool)> {
        let page_limit = limit.max(1);
        let cursor_position = if let Some(cursor) = before {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT created_at, rowid FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![cursor, conversation_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        } else {
            None
        };
        let fetch_limit = page_limit.saturating_add(1) as i64;
        let conn = self.conn.lock().await;
        let mut raw = Vec::new();
        if let Some((cursor_created_at, cursor_rowid)) = cursor_position {
            let mut stmt = conn.prepare(
                "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
                 FROM messages
                 WHERE conversation_id = ?1
                   AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![
                    conversation_id,
                    cursor_created_at,
                    cursor_rowid,
                    fetch_limit
                ],
                |row| {
                    let sealed_parts: Option<String> = row.get(10)?;
                    let sealed_metadata: Option<String> = row.get(13)?;
                    Ok((
                        StoredMessage {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            content: row.get(2)?,
                            agent_id: row.get(3)?,
                            author_user_id: row.get(5)?,
                            author_name: row.get(6)?,
                            source: row.get(7)?,
                            widget_instance_id: row.get(8)?,
                            origin_server: row.get(9)?,
                            parts: None,
                            metadata: None,
                            parent_message_id: row.get(11)?,
                            interrupted: row.get::<_, i64>(12)? != 0,
                            sibling_index: 0,
                            sibling_count: 1,
                            sibling_ids: Vec::new(),
                            created_at: row.get(4)?,
                        },
                        sealed_parts,
                        sealed_metadata,
                    ))
                },
            )?;
            for row in rows {
                raw.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
                 FROM messages
                 WHERE conversation_id = ?1
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![conversation_id, fetch_limit], |row| {
                let sealed_parts: Option<String> = row.get(10)?;
                let sealed_metadata: Option<String> = row.get(13)?;
                Ok((
                    StoredMessage {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                        agent_id: row.get(3)?,
                        author_user_id: row.get(5)?,
                        author_name: row.get(6)?,
                        source: row.get(7)?,
                        widget_instance_id: row.get(8)?,
                        origin_server: row.get(9)?,
                        parts: None,
                        metadata: None,
                        parent_message_id: row.get(11)?,
                        interrupted: row.get::<_, i64>(12)? != 0,
                        sibling_index: 0,
                        sibling_count: 1,
                        sibling_ids: Vec::new(),
                        created_at: row.get(4)?,
                    },
                    sealed_parts,
                    sealed_metadata,
                ))
            })?;
            for row in rows {
                raw.push(row?);
            }
        }
        // Decrypt after releasing the store mutex so a page load never holds
        // up other chats' reads and streaming checkpoints.
        drop(conn);
        let mut out: Vec<StoredMessage> = raw
            .into_iter()
            .map(|(mut message, sealed_parts, sealed_metadata)| {
                message.content = self.open_content(std::mem::take(&mut message.content));
                message.parts = self.open_parts(sealed_parts);
                message.metadata = self.open_parts(sealed_metadata);
                message
            })
            .collect();
        let has_older = out.len() > page_limit;
        out.truncate(page_limit);
        out.reverse();
        Ok((out, has_older))
    }

    /// Fetch the newest message page, or the page immediately before a stable
    /// message cursor. The desktop uses this for reverse scrolling so opening a
    /// long chat only decrypts/renders the latest slice at first.
    pub async fn get_conversation_message_page(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Option<ConversationDetail>> {
        let active_leaf = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        };
        let (messages, has_older_messages, older_messages_cursor) = if active_leaf.is_none() {
            let (messages, has_older_messages) = self
                .get_flat_message_page(conversation_id, before, limit)
                .await?;
            let older_messages_cursor = if has_older_messages {
                messages.first().map(|message| message.id.clone())
            } else {
                None
            };
            (messages, has_older_messages, older_messages_cursor)
        } else {
            let conn = self.conn.lock().await;
            let (messages, has_older_messages) = self.active_message_page_locked(
                &conn,
                conversation_id,
                active_leaf.as_deref().expect("branched"),
                before,
                limit.max(1),
            )?;
            let older_messages_cursor = if has_older_messages {
                messages.first().map(|message| message.id.clone())
            } else {
                None
            };
            (messages, has_older_messages, older_messages_cursor)
        };

        let conn = self.conn.lock().await;
        let row: Option<(Option<String>, Option<String>, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, agent_id, created_at, updated_at, participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((title, agent_id, created_at, updated_at, participants_json)) => {
                let participants = parse_participants_json(participants_json.as_deref());
                Ok(Some(ConversationDetail {
                    id: conversation_id.to_owned(),
                    title: self.open_opt(title),
                    agent_id,
                    created_at,
                    updated_at,
                    older_messages_cursor,
                    has_older_messages,
                    messages,
                    participants,
                }))
            }
        }
    }

    /// Fork (branch) a conversation into a brand-new conversation, copying the
    /// thread up to and including `up_to_message_id` (ChatGPT-style "Branch in
    /// new chat"). When `up_to_message_id` is `None` the whole active thread is
    /// copied. Once the source has a version tree, the copy is the cut point's
    /// ancestry only; alternate versions (edits, regenerations, rewound turns)
    /// are never interleaved into the branch.
    ///
    /// The new conversation is fully independent: it gets a fresh id and fresh
    /// per-message ids, so continuing the branch never touches the source. Run
    /// metadata (folder/branch/worktree) and participants are carried over, but
    /// `run_status` and any goal are intentionally left unset on the copy. Saved
    /// generative-UI widget state is carried over only when the fork copies the
    /// whole active thread.
    ///
    /// Returns the new conversation's summary, or `None` when the source does not
    /// exist or `up_to_message_id` is not a message of that conversation.
    ///
    /// Tenancy: the FORKER owns the copy (`owner_user_id` / `org_id` come from the
    /// caller, NOT from the source row). Forking an org-visible chat therefore
    /// produces a private branch owned by whoever forked it, and never silently
    /// hands a copy of someone else's private chat to a new owner — the READ gate on
    /// the source is what decides whether the fork may happen at all. Pass
    /// [`Tenancy::Unattributed`] for the unbound/personal case (rows stay untenanted,
    /// byte-identical to the pre-ACL behaviour).
    pub async fn fork_conversation(
        &self,
        source_id: &str,
        up_to_message_id: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<Option<ConversationSummary>> {
        // Read the source history (chronological) before taking the write lock so
        // the cut-point lookup stays simple. The leaf is read first so it always
        // names a row the history read below includes.
        let leaf = {
            let conn = self.conn.lock().await;
            Self::active_leaf_locked(&conn, source_id)?
        };
        let messages = self.get_messages(source_id).await?;
        // `copies_active_thread`: the slice is the whole active thread, so the
        // latest widget snapshots belong to it (see the widget-state copy below).
        let (slice, copies_active_thread): (Vec<&StoredMessage>, bool) = match leaf.as_deref() {
            // Never branched: the flat chronological history is the thread.
            None => {
                let slice: Vec<&StoredMessage> = match up_to_message_id {
                    Some(mid) => {
                        let Some(idx) = messages.iter().position(|m| m.id == mid) else {
                            return Ok(None);
                        };
                        messages[..=idx].iter().collect()
                    }
                    None => messages.iter().collect(),
                };
                let whole = slice.len() == messages.len();
                (slice, whole)
            }
            // A version tree: copy only the cut point's own ancestry, never the
            // alternate versions (edits, regenerations, rewound turns) beside it.
            Some(leaf) => {
                let by_id: std::collections::HashMap<&str, &StoredMessage> =
                    messages.iter().map(|m| (m.id.as_str(), m)).collect();
                let tip = up_to_message_id.unwrap_or(leaf);
                if up_to_message_id.is_some() && !by_id.contains_key(tip) {
                    return Ok(None);
                }
                let mut slice = Vec::new();
                let mut visited = std::collections::HashSet::new();
                let mut cursor = Some(tip);
                while let Some(id) = cursor {
                    if !visited.insert(id) {
                        break;
                    }
                    let Some(message) = by_id.get(id) else {
                        break;
                    };
                    slice.push(*message);
                    cursor = message.parent_message_id.as_deref();
                }
                slice.reverse();
                (slice, tip == leaf)
            }
        };

        let now = now_millis();
        let new_id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().await;

        // Carry over the source's metadata; bail if the row is missing.
        type SourceRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let source: Option<SourceRow> = conn
            .query_row(
                "SELECT title, agent_id, folder_path, branch, worktree_path, participants
                 FROM conversations WHERE id = ?1",
                params![source_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((title, agent_id, folder_path, branch, worktree_path, participants_json)) = source
        else {
            return Ok(None);
        };
        // The stored title is sealed; decrypt before deriving the branch title,
        // then re-seal for the new row (and return the plaintext in the summary).
        let forked_title = self
            .open_opt(title)
            .map(|t| format!("{t} (branch)"))
            .or_else(|| Some("Branch".to_owned()));
        let forked_title_sealed = self.seal_opt(forked_title.as_deref())?;
        let participants_json = participants_json.unwrap_or_else(|| "[]".to_owned());

        upsert_conversation_row(
            &conn,
            &new_id,
            now,
            &tenancy,
            &ConvRow {
                title: forked_title_sealed.as_deref(),
                agent_id: agent_id.as_deref(),
                folder_path: folder_path.as_deref(),
                branch: branch.as_deref(),
                worktree_path: worktree_path.as_deref(),
                participants: Some(participants_json.as_str()),
                channel_id: None,
                visibility: None,
                ..ConvRow::default()
            },
            Touch::Keep,
        )
        .context("inserting forked conversation")?;
        // A fork stays in its source's project as an ordinary session; it never
        // inherits a main-thread role (that would collide with the scope's one
        // main thread).
        let project_id_of_source: Option<String> = conn
            .query_row(
                "SELECT project_id FROM conversations WHERE id = ?1",
                params![source_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if project_id_of_source.is_some() {
            conn.execute(
                "UPDATE conversations SET project_id = ?1 WHERE id = ?2",
                params![project_id_of_source, new_id],
            )
            .context("carrying the project onto the fork")?;
        }

        // Copy each message with a fresh id, preserving role/content/agent/ordering.
        // `m.content` is already decrypted (get_messages opened it), so re-seal it
        // for the new row.
        //
        // Deliberately NOT copied: `feedback`, `interrupted` — and, for the
        // same reason, `message_reactions`. A fork is a new thread whose messages
        // have new ids; per-person reactions belong to the rows people actually
        // reacted to, so the branch starts with none.
        for m in &slice {
            let copy_id = uuid::Uuid::new_v4().to_string();
            let sealed = self.cipher.seal(&m.content)?;
            let sealed_parts = m
                .parts
                .as_ref()
                .map(|value| self.cipher.seal(&value.to_string()))
                .transpose()?;
            let sealed_metadata = m
                .metadata
                .as_ref()
                .map(|value| self.cipher.seal(&value.to_string()))
                .transpose()?;
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, agent_id, created_at, parts, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![copy_id, new_id, m.role, sealed, m.agent_id, m.created_at, sealed_parts, sealed_metadata],
            )
            .context("copying message into fork")?;
        }

        // Saved generative-UI widget and artifact-page state is keyed by the tool
        // call ids the copied parts keep verbatim, so a fork of the whole history
        // carries it over: ticks stay ticked and a submitted form stays submitted.
        // Each row is one latest snapshot, not a history, so a fork cut before the
        // last message starts its widgets from their specs rather than importing
        // edits (or a submission) made after the cut point. Values are sealed
        // without per-conversation binding and the source is already capped at
        // `MAX_AGENT_UI_STATES`, so the rows copy as they are.
        if copies_active_thread {
            conn.execute(
                "INSERT OR IGNORE INTO agent_ui_state (conversation_id, tool_call_id, state, updated_at)
                 SELECT ?1, tool_call_id, state, updated_at FROM agent_ui_state
                 WHERE conversation_id = ?2
                 ORDER BY updated_at DESC
                 LIMIT ?3",
                params![new_id, source_id, MAX_AGENT_UI_STATES],
            )
            .context("copying widget state into fork")?;
        }

        Ok(Some(ConversationSummary {
            id: new_id,
            title: forked_title,
            agent_id,
            created_at: now,
            updated_at: now,
            message_count: slice.len() as i64,
            folder_path,
            branch,
            worktree_path,
            run_status: None,
            participants: parse_participants_json(Some(&participants_json)),
            pinned: false,
            archived: false,
            linked_pull_requests: Vec::new(),
            icon: None,
            visibility: "private".to_owned(),
            last_message: None,
            last_message_role: None,
            last_message_at: None,
            hierarchy: ThreadHierarchy {
                project_id: project_id_of_source,
                ..ThreadHierarchy::default()
            },
            continued_on: None,
        }))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Message version tree (ChatGPT/Claude-style edit + regenerate branching)
    //
    // A conversation starts flat: every message has a NULL `parent_message_id`
    // and the conversation's `active_leaf_message_id` is NULL, so reads return
    // chronological order and appends do not link parents. The first edit or
    // regenerate calls `linearize`, which converts that flat history into a spine
    // (each message's parent = its predecessor) and sets the leaf to the last
    // message. From then on the *active thread* is the parent chain walked up
    // from the leaf, alternate versions are siblings (messages sharing a parent),
    // and `append_message` chains new turns beneath the leaf.
    // ─────────────────────────────────────────────────────────────────────────

    /// Convert a never-branched conversation's flat history into a linked spine
    /// so it can host version branches. Idempotent: a no-op once the leaf is set
    /// (i.e. the conversation already has a tree). Returns the id of the message
    /// the caller named, resolved within the now-linearized history, or `None`
    /// if that message does not belong to the conversation.
    ///
    /// Must be called while holding no other reference to the connection.
    fn linearize_locked(conn: &Connection, conversation_id: &str) -> Result<()> {
        let already: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("checking leaf for linearize")?
            .flatten();
        if already.is_some() {
            return Ok(());
        }
        // Chronological ids (the flat order the UI has always shown).
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM messages WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        if ids.is_empty() {
            return Ok(());
        }
        // Link each message to its predecessor; the first becomes a root (NULL
        // parent). Clearing it matters: a flat row may still carry a parent (a
        // relayed or legacy value), and keeping one that names a later row would
        // turn the rebuilt chain into a ring.
        conn.execute(
            "UPDATE messages SET parent_message_id = NULL WHERE id = ?1",
            params![ids[0]],
        )
        .context("clearing first message parent on linearize")?;
        for pair in ids.windows(2) {
            conn.execute(
                "UPDATE messages SET parent_message_id = ?1 WHERE id = ?2",
                params![pair[0], pair[1]],
            )
            .context("linearizing message parent")?;
        }
        let leaf = ids.last().expect("non-empty");
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
            params![leaf, conversation_id],
        )
        .context("setting leaf on linearize")?;
        Ok(())
    }

    /// The conversation's active leaf, or `None` for a never-branched (flat)
    /// conversation or a missing row.
    fn active_leaf_locked(conn: &Connection, conversation_id: &str) -> Result<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf")?
            .flatten())
    }

    /// Up to `limit` message ids on the parent chain walked up from `leaf`,
    /// newest (the leaf) first. Reads ids only — no payloads, no decryption.
    fn active_ancestor_ids_locked(
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        let mut parent_query = conn.prepare_cached(
            "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        let mut ids = Vec::new();
        let mut cursor = Some(leaf.to_owned());
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if ids.len() == limit || !visited.insert(id.clone()) {
                break;
            }
            let parent: Option<Option<String>> = parent_query
                .query_row(params![id, conversation_id], |row| row.get(0))
                .optional()?;
            let Some(parent) = parent else {
                break;
            };
            ids.push(id);
            cursor = parent;
        }
        Ok(ids)
    }

    /// Read only the selected ancestry and returned page's payloads. Sibling
    /// decoration uses the parent index and never reads alternate message bodies.
    fn active_message_page_locked(
        &self,
        conn: &Connection,
        conversation_id: &str,
        leaf: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<StoredMessage>, bool)> {
        let mut parent_query = conn.prepare_cached(
            "SELECT parent_message_id FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        // Invalid/off-branch cursors retain the old behavior: return the latest
        // page. Verify ancestry using IDs only before fetching any payload.
        let mut start = Some(leaf.to_owned());
        if let Some(before) = before {
            let mut cursor = start.clone();
            let mut visited = std::collections::HashSet::new();
            while let Some(id) = cursor {
                if !visited.insert(id.clone()) {
                    break;
                }
                let parent: Option<Option<String>> = parent_query
                    .query_row(params![id, conversation_id], |row| row.get(0))
                    .optional()?;
                let Some(parent) = parent else {
                    break;
                };
                if id == before {
                    start = parent;
                    break;
                }
                cursor = parent;
            }
        }
        let mut selected = Vec::new();
        let mut cursor = start;
        let mut visited = std::collections::HashSet::new();
        let mut has_older = false;
        while let Some(id) = cursor {
            if !visited.insert(id.clone()) {
                break;
            }
            let parent: Option<Option<String>> = parent_query
                .query_row(params![id, conversation_id], |row| row.get(0))
                .optional()?;
            let Some(parent) = parent else {
                break;
            };
            if selected.len() == limit {
                has_older = true;
                break;
            }
            selected.push(id);
            cursor = parent;
        }
        selected.reverse();
        let mut message_query = conn.prepare_cached(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name,
                    source, widget_instance_id, origin_server, parts, parent_message_id, interrupted, metadata
             FROM messages WHERE id = ?1 AND conversation_id = ?2",
        )?;
        let mut sibling_query = conn.prepare_cached(
            "SELECT id FROM messages WHERE conversation_id = ?1 AND parent_message_id IS ?2
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let mut messages = Vec::with_capacity(selected.len());
        for id in selected {
            let (mut message, parts, metadata) =
                message_query.query_row(params![id, conversation_id], |row| {
                    Ok((
                        StoredMessage {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            content: row.get(2)?,
                            agent_id: row.get(3)?,
                            created_at: row.get(4)?,
                            author_user_id: row.get(5)?,
                            author_name: row.get(6)?,
                            source: row.get(7)?,
                            widget_instance_id: row.get(8)?,
                            origin_server: row.get(9)?,
                            parts: None,
                            metadata: None,
                            parent_message_id: row.get(11)?,
                            interrupted: row.get::<_, i64>(12)? != 0,
                            sibling_index: 0,
                            sibling_count: 1,
                            sibling_ids: Vec::new(),
                        },
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                })?;
            message.content = self.open_content(std::mem::take(&mut message.content));
            message.parts = self.open_parts(parts);
            message.metadata = self.open_parts(metadata);
            let siblings = sibling_query
                .query_map(params![conversation_id, message.parent_message_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            message.sibling_count = siblings.len();
            message.sibling_index = siblings
                .iter()
                .position(|id| *id == message.id)
                .unwrap_or(0);
            if siblings.len() > 1 {
                message.sibling_ids = siblings;
            }
            messages.push(message);
        }
        Ok((messages, has_older))
    }

    /// The active thread of a conversation: the parent chain walked up from the
    /// selected leaf, in chronological (root-first) order, each message annotated
    /// with its `sibling_index`/`sibling_count` for the version pager. Falls back
    /// to flat chronological order for conversations that have never been branched
    /// (NULL leaf) — byte-identical to `get_messages` there.
    pub async fn get_active_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let leaf: Option<String> = conn
            .query_row(
                "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .context("reading active leaf")?
            .flatten();
        drop(conn);
        let Some(leaf) = leaf else {
            // Never branched: flat history.
            return self.get_messages(conversation_id).await;
        };

        let conn = self.conn.lock().await;
        Ok(self
            .active_message_page_locked(&conn, conversation_id, &leaf, None, usize::MAX)?
            .0)
    }

    /// How many versions share `parent` in `conversation_id` — the fan-out at a
    /// branch point, read for the `session_tree` hook payload.
    ///
    /// `IS` rather than `=`: the branch point of the very first user turn is the
    /// root bucket, where `parent_message_id` is NULL, and SQL `=` never matches
    /// NULL — a naive `=` would report a first-turn edit as having no siblings at
    /// all, which is exactly the case a version pager cares about.
    ///
    /// Fails open to `1` (a lone version): this count only decorates an
    /// observation hook, so a read error here must never turn an edit into a 500.
    fn sibling_count_locked(conn: &Connection, conversation_id: &str, parent: Option<&str>) -> i64 {
        match conn.query_row(
            "SELECT COUNT(*) FROM messages
             WHERE conversation_id = ?1 AND parent_message_id IS ?2",
            params![conversation_id, parent],
            |r| r.get::<_, i64>(0),
        ) {
            Ok(count) => count,
            Err(e) => {
                tracing::warn!(
                    "session_tree: sibling count failed for '{conversation_id}': {e}; reporting 1"
                );
                1
            }
        }
    }

    /// Fire `session_tree` plugin hooks DETACHED after the message tree branched.
    ///
    /// Observation-only, in both directions: no directive can move a leaf, so the
    /// branch is already committed before the sandbox is even spawned, and every
    /// returned directive is dropped. Detached rather than awaited because an
    /// edit/regenerate is a user-facing click on the UI's critical path — waiting
    /// on a sandbox run there would cost latency for a signal nobody can act on in
    /// time. The global dispatcher's own DB-free `any_manifest_declares` gate makes
    /// the no-plugin case free, so a node without a `session_tree` plugin pays only
    /// this spawn.
    ///
    /// Takes owned scalars — never `&self` and never the connection — because the
    /// caller MUST have dropped the store mutex first. A hook is free to reach back
    /// into Core over HTTP; if the spawn happened under the lock, that call would
    /// block on a mutex the still-running caller holds.
    fn fire_session_tree_hooks(
        conversation_id: String,
        source_message_id: String,
        parent_message_id: Option<String>,
        new_message_id: Option<String>,
        active_leaf_message_id: String,
        sibling_count: i64,
        reason: &'static str,
    ) {
        tokio::spawn(async move {
            let ctx = crate::plugin_host::HookContext {
                conversation_id: Some(conversation_id.clone()),
                event: Some(serde_json::json!({
                    "conversation_id": conversation_id,
                    "source_message_id": source_message_id,
                    "parent_message_id": parent_message_id,
                    "new_message_id": new_message_id,
                    "active_leaf_message_id": active_leaf_message_id,
                    "sibling_count": sibling_count,
                    "reason": reason,
                })),
                ..Default::default()
            };
            let _ =
                crate::plugin_host::dispatch_global(crate::plugin_host::ON_SESSION_TREE, ctx).await;
        });
    }

    /// Edit a user message: create a new sibling version carrying `new_content`
    /// (same parent as the edited message) and point the active leaf at it, so a
    /// subsequent generation turn attaches its reply beneath the edit. Returns the
    /// new sibling's id, or `None` if the message is absent / not a user turn.
    ///
    /// Fires `session_tree` hooks (detached) once the branch is committed — this is
    /// the primary site where the tree actually gains a fork.
    pub async fn edit_user_message(
        &self,
        conversation_id: &str,
        message_id: &str,
        new_content: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let new_id = uuid::Uuid::new_v4().to_string();
        let sealed = self.cipher.seal(new_content)?;
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        // Resolve the edited message's role, parent, and agent.
        let row: Option<(String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT role, parent_message_id, agent_id FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .context("loading message to edit")?;
        let Some((role, parent, agent_id)) = row else {
            return Ok(None);
        };
        if role != "user" {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, parent_message_id, created_at)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6)",
            params![new_id, conversation_id, sealed, agent_id, parent, now],
        )
        .context("inserting edited user sibling")?;
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_id, now, conversation_id],
        )
        .context("pointing leaf at edit")?;
        // Read the fan-out under the SAME lock that just inserted the sibling
        // (cheap, indexed, no decryption), so the hook payload can never disagree
        // with the branch it is reporting. Then release the lock BEFORE spawning.
        let sibling_count = Self::sibling_count_locked(&conn, conversation_id, parent.as_deref());
        drop(conn);
        Self::fire_session_tree_hooks(
            conversation_id.to_owned(),
            message_id.to_owned(),
            parent,
            Some(new_id.clone()),
            new_id.clone(),
            sibling_count,
            "edit",
        );
        Ok(Some(new_id))
    }

    /// Prepare to regenerate an assistant message: point the active leaf at the
    /// user turn *above* it (its parent) so the next generation appends a fresh
    /// assistant sibling. Returns the parent id, or `None` if the message is
    /// absent or has no parent (a regenerate needs a preceding user turn).
    ///
    /// Fires `session_tree` hooks (detached) alongside `edit_user_message`: the
    /// phase means "the tree changed", not "the edit button was pressed", and a
    /// regenerate moves the active leaf to a fork point just as an edit does.
    pub async fn prepare_regenerate(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let parent: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_message_id FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .context("loading message to regenerate")?;
        let Some(Some(parent_id)) = parent else {
            return Ok(None);
        };
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![parent_id, now, conversation_id],
        )
        .context("pointing leaf at regenerate parent")?;
        let sibling_count = Self::sibling_count_locked(&conn, conversation_id, Some(&parent_id));
        drop(conn);
        // `new_message_id` is null on purpose. A regenerate only repoints the leaf;
        // the fresh assistant sibling is born later, when the streamed turn reaches
        // `append_message` and chains beneath this parent. Reporting an id here
        // would mean inventing one. For the same reason `sibling_count` is the
        // count BEFORE the regeneration lands, i.e. how many versions the user is
        // branching away from.
        Self::fire_session_tree_hooks(
            conversation_id.to_owned(),
            message_id.to_owned(),
            Some(parent_id.clone()),
            None,
            parent_id.clone(),
            sibling_count,
            "regenerate",
        );
        Ok(Some(parent_id))
    }

    /// Switch the active version at a branch point: make `version_id` the chosen
    /// sibling, then descend to a leaf (following the newest child at each step)
    /// and set that as the conversation's active leaf. Returns the resolved leaf
    /// id, or `None` if `version_id` is absent. The client then re-reads the
    /// active path to re-render the thread along the newly-selected branch.
    ///
    /// Deliberately does NOT fire `session_tree`, unlike `edit_user_message` and
    /// `prepare_regenerate`: paging between versions inserts no message and rewires
    /// no parent edge, it only moves the cursor over a tree that already exists.
    /// Firing here would turn a branch signal into a navigation feed, so a plugin
    /// counting forks would over-count every time the user clicked "<".
    pub async fn select_version(
        &self,
        conversation_id: &str,
        version_id: &str,
    ) -> Result<Option<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![version_id, conversation_id],
                |_| Ok(()),
            )
            .optional()
            .context("checking version exists")?
            .is_some();
        if !exists {
            return Ok(None);
        }
        // Descend from the chosen version to a leaf, always following the
        // most-recently-created child (the latest continuation of that branch).
        let mut leaf = version_id.to_owned();
        // A stored parent loop (relayed or legacy data) must not spin forever
        // while the store lock is held: stop at the first revisited row.
        let mut visited = std::collections::HashSet::from([leaf.clone()]);
        loop {
            let child: Option<String> = conn
                .query_row(
                    "SELECT id FROM messages
                     WHERE conversation_id = ?1 AND parent_message_id = ?2
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![conversation_id, leaf],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .context("descending to leaf")?;
            match child {
                Some(c) if visited.insert(c.clone()) => leaf = c,
                _ => break,
            }
        }
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![leaf, now, conversation_id],
        )
        .context("setting selected leaf")?;
        Ok(Some(leaf))
    }

    /// Record one chat checkpoint row. A `turn` checkpoint is keyed by its user
    /// message: the first capture wins, so a regenerate of the same turn keeps the
    /// state from before the turn first ran. Returns whether a row was written.
    pub async fn record_chat_checkpoint(&self, checkpoint: &ChatCheckpointRecord) -> Result<bool> {
        let conn = self.conn.lock().await;
        let written = conn
            .execute(
                "INSERT OR IGNORE INTO chat_checkpoints
                     (id, conversation_id, message_id, kind, workspace, commit_id, skip_reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    checkpoint.id,
                    checkpoint.conversation_id,
                    checkpoint.message_id,
                    checkpoint.kind.as_str(),
                    checkpoint.workspace,
                    checkpoint.commit_id,
                    checkpoint.skip_reason,
                    checkpoint.created_at,
                ],
            )
            .context("recording chat checkpoint")?;
        Ok(written == 1)
    }

    /// Folders of every conversation with a turn running right now
    /// (`run_status = 'running'`; boot reconciliation clears crashed runs).
    /// A rewind refuses to restore a folder another live turn is editing.
    pub async fn running_run_folders(&self) -> Result<Vec<(String, Vec<String>)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, folder_path, worktree_path FROM conversations
             WHERE run_status = 'running'",
        )?;
        let rows = stmt.query_map([], |row| {
            let folders = [row.get::<_, Option<String>>(1)?, row.get(2)?]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            Ok((row.get::<_, String>(0)?, folders))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing running run folders")
    }

    /// Whether a `turn` checkpoint already exists for this user message.
    pub async fn has_turn_checkpoint(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found = conn
            .query_row(
                "SELECT 1 FROM chat_checkpoints
                 WHERE conversation_id = ?1 AND message_id = ?2 AND kind = 'turn'",
                params![conversation_id, message_id],
                |_| Ok(()),
            )
            .optional()
            .context("checking turn checkpoint")?;
        Ok(found.is_some())
    }

    /// Checkpoints of one conversation, newest first, each with a short preview
    /// of the user message it was taken before.
    pub async fn list_chat_checkpoints(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatCheckpoint>> {
        let rows: Vec<(ChatCheckpointRecord, Option<String>)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT c.id, c.conversation_id, c.message_id, c.kind, c.workspace,
                        c.commit_id, c.skip_reason, c.created_at, m.content
                 FROM chat_checkpoints c
                 LEFT JOIN messages m ON m.id = c.message_id AND m.conversation_id = c.conversation_id
                 WHERE c.conversation_id = ?1
                 ORDER BY c.created_at DESC, c.rowid DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(
                params![conversation_id, i64::try_from(limit).unwrap_or(i64::MAX)],
                |row| {
                    Ok((
                        chat_checkpoint_from_row(row)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("listing chat checkpoints")?
        };
        Ok(rows
            .into_iter()
            .map(|(record, content)| {
                let preview = content.map(|stored| {
                    let text = self.open_content(stored);
                    let trimmed = text.trim();
                    let mut preview: String = trimmed.chars().take(160).collect();
                    if preview.len() < trimmed.len() {
                        preview.push('…');
                    }
                    preview
                });
                ChatCheckpoint::from_record(record, preview)
            })
            .collect())
    }

    /// One checkpoint of a conversation.
    pub async fn get_chat_checkpoint(
        &self,
        conversation_id: &str,
        checkpoint_id: &str,
    ) -> Result<Option<ChatCheckpointRecord>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, conversation_id, message_id, kind, workspace, commit_id, skip_reason, created_at
             FROM chat_checkpoints WHERE conversation_id = ?1 AND id = ?2",
            params![conversation_id, checkpoint_id],
            chat_checkpoint_from_row,
        )
        .optional()
        .context("reading chat checkpoint")
    }

    /// The active leaf when it is a user message. A version-tree edit or
    /// regenerate re-runs that turn without appending a new user row, so this is
    /// the turn a checkpoint belongs to.
    pub async fn active_leaf_user_message(&self, conversation_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT m.id FROM conversations c
             JOIN messages m ON m.id = c.active_leaf_message_id AND m.conversation_id = c.id
             WHERE c.id = ?1 AND m.role = 'user'",
            params![conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("reading active user leaf")
    }

    /// Rewind the active thread to just before a user message: the active leaf
    /// moves to that message's parent, so the message and everything after it
    /// leave the active thread without being deleted (they stay reachable as a
    /// version). Returns `None` when the message is absent or not a user turn,
    /// otherwise the rewound message's text and the new leaf. The leaf is `None`
    /// for the first user turn: a version tree cannot point at an empty thread,
    /// so the caller resends that turn as an edit, which creates its root-level
    /// sibling.
    pub async fn rewind_to_message(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> Result<Option<RewoundTurn>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        Self::linearize_locked(&conn, conversation_id)?;
        let row: Option<(String, Option<String>, String)> = conn
            .query_row(
                "SELECT role, parent_message_id, content FROM messages
                 WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .context("loading message to rewind")?;
        let Some((role, parent, content)) = row else {
            return Ok(None);
        };
        if role != "user" {
            return Ok(None);
        }
        if let Some(parent_id) = parent.as_deref() {
            conn.execute(
                "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![parent_id, now, conversation_id],
            )
            .context("pointing leaf at rewind parent")?;
        }
        drop(conn);
        Ok(Some(RewoundTurn {
            active_leaf_message_id: parent,
            text: self.open_content(content),
        }))
    }

    /// Add an agent as a participant in a conversation. Idempotent — adding an
    /// agent that is already in the list is a no-op. Creates the conversation row
    /// if it does not yet exist.
    pub async fn add_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
        tenancy: Tenancy,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        // Ensure the conversation row exists — through the choke point, so a council
        // chat created by adding its first participant is born owned.
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow {
                participants: Some("[]"),
                ..ConvRow::default()
            },
            Touch::Keep,
        )
        .context("ensuring conversation for add_participant")?;
        // Load current participants.
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        if !participants.iter().any(|p| p == agent_id) {
            participants.push(agent_id.to_owned());
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in add_participant")?;
        }
        Ok(participants)
    }

    /// Remove an agent from a conversation's participant list. Idempotent — if
    /// the agent is not present the list is returned unchanged.
    pub async fn remove_participant(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> Result<Vec<String>> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut participants = parse_participants_json(participants_json.as_deref());
        let before_len = participants.len();
        participants.retain(|p| p != agent_id);
        if participants.len() != before_len {
            let new_json = serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_owned());
            conn.execute(
                "UPDATE conversations SET participants = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, new_json, now],
            )
            .context("updating participants in remove_participant")?;
        }
        Ok(participants)
    }

    /// Return the current participant list for a conversation.
    pub async fn get_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let participants_json: Option<String> = conn
            .query_row(
                "SELECT participants FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(parse_participants_json(participants_json.as_deref()))
    }

    /// Stamp the verified human owner (and the node's org) onto a conversation,
    /// creating the row if this is a brand-new chat. **This is the write that makes
    /// the per-resource ACL non-vacuous** — before it existed every row was created
    /// with NULL tenancy, which `resource_access` reads as "the untenanted local
    /// row" and grants to everyone.
    ///
    /// **First-writer-wins**: `COALESCE(existing, new)` means a row that already has
    /// an owner is NEVER re-tenanted, so a second caller racing on the same id (or a
    /// deliberate re-POST with someone else's conversation id) can never STEAL a
    /// conversation. The loser is simply denied by the ACL on their next request.
    ///
    /// Safe to front-run the lazy upserts in [`Self::ensure_conversation`] /
    /// [`Self::append_message`]: their `ON CONFLICT` clauses touch only
    /// `agent_id` / `title` / `updated_at`, never the tenancy columns, so the owner
    /// stamped here survives the first message landing.
    pub async fn claim_tenancy(
        &self,
        conversation_id: &str,
        owner_user_id: &str,
        org_id: Option<&str>,
    ) -> Result<()> {
        let now = now_millis();
        let tenancy = Tenancy::Owned {
            user_id: owner_user_id.to_owned(),
            org_id: org_id.map(str::to_owned),
        };
        let conn = self.conn.lock().await;
        upsert_conversation_row(
            &conn,
            conversation_id,
            now,
            &tenancy,
            &ConvRow::default(),
            Touch::Keep,
        )
        .context("claiming conversation tenancy")
    }

    /// The conversation a session hangs off, so a session-keyed route can be gated
    /// on its PARENT conversation's tenancy (sessions carry no tenancy of their own).
    /// `Ok(None)` when the session id is unknown.
    pub async fn conversation_id_for_session(&self, session_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT conversation_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("resolving session's conversation")?;
        Ok(id)
    }

    /// The conversation a `/btw` side entry (or subagent child run) hangs off — the
    /// session-lookup's twin, for gating the btw routes on the parent's tenancy.
    pub async fn conversation_id_for_btw(&self, btw_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT conversation_id FROM btw_entries WHERE id = ?1",
                params![btw_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("resolving btw entry's conversation")?;
        Ok(id)
    }

    /// Load the tenancy quartet (owner / org / visibility / team) for a
    /// conversation, for the realtime WS gateway's access decision. Returns
    /// `Ok(None)` when the conversation row does not exist (an as-yet-uncreated
    /// chat — conversations are upserted lazily on the first message). These
    /// columns are plaintext (only `title` and message `content` are sealed at
    /// rest), so a raw `SELECT` compares correctly against a verified caller's id.
    pub async fn get_access_meta(
        &self,
        conversation_id: &str,
    ) -> Result<Option<crate::identity_verify::ResourceTenancy>> {
        Ok(self
            .get_access_meta_with_generation(conversation_id)
            .await?
            .map(|(meta, _)| meta))
    }

    pub async fn get_access_meta_with_generation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<(crate::identity_verify::ResourceTenancy, String)>> {
        let connection = self.conn.lock().await;
        let conn = connection
            .unchecked_transaction()
            .context("reading conversation identity snapshot")?;
        let meta = conn
            .query_row(
                "SELECT owner_user_id, org_id, visibility, team_id
                 FROM conversations WHERE id = ?1",
                params![conversation_id],
                |row| {
                    Ok(crate::identity_verify::ResourceTenancy {
                        owner_user_id: row.get(0)?,
                        org_id: row.get(1)?,
                        // NOT NULL DEFAULT 'private' in the schema, so always present.
                        visibility: row.get(2)?,
                        team_id: row.get(3)?,
                        collaborators: Vec::new(),
                    })
                },
            )
            .optional()
            .context("reading conversation access metadata")?;
        let Some(mut meta) = meta else {
            return Ok(None);
        };
        let mut statement = conn.prepare(
            "SELECT user_id, role FROM conversation_collaborators
             WHERE conversation_id = ?1 ORDER BY user_id",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            let role: String = row.get(1)?;
            let access = if role == "participant" {
                crate::identity_verify::Access::Write
            } else {
                crate::identity_verify::Access::Read
            };
            Ok(crate::identity_verify::ResourceCollaborator {
                user_id: row.get(0)?,
                access,
            })
        })?;
        meta.collaborators = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("reading conversation collaborators")?;
        let generation = super::conversation_lifecycle::generation(&conn, conversation_id)?
            .context("conversation generation missing")?;
        Ok(Some((meta, generation)))
    }

    /// Whether a conversation was created by a registered channel bot. This is
    /// intentionally separate from the public tenancy quartet: the machine
    /// ingress gate uses it to allow the node-token channel writer to continue
    /// its own org-shared room, while human reads still go through the normal
    /// organization visibility ACL.
    pub async fn is_channel_conversation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM conversations
                 WHERE id = ?1 AND channel_id IS NOT NULL",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("checking channel conversation metadata")?;
        Ok(found.is_some())
    }

    /// Delete a conversation and its messages. Returns true if a row was removed.
    pub async fn delete_conversation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // FK enforcement is off (deletes are manual), so drop side chats here too.
        conn.execute(
            "DELETE FROM btw_entries WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM chat_checkpoints WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Same reason: `message_reactions` has no FK either, so its rows would
        // outlive both the messages and the conversation forever.
        conn.execute(
            "DELETE FROM message_reactions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Generative-UI widget state is keyed by tool call, not message, and has
        // no FK either.
        conn.execute(
            "DELETE FROM agent_ui_state WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM message_read_receipts WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Proactive openings deliberately have no FK (their key survives a
        // failed message write), so delete the idempotency tombstone with the
        // conversation. Otherwise deleting and recreating the same conversation
        // id can suppress its first greeting forever.
        conn.execute(
            "DELETE FROM proactive_openings WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM channel_turn_idempotency WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Legacy databases do not rely on SQLite foreign-key enforcement for
        // manual deletes, so clear the durable harness children explicitly.
        conn.execute(
            "DELETE FROM harness_run_events WHERE run_id IN (
                 SELECT id FROM harness_runs WHERE session_id IN (
                     SELECT id FROM sessions WHERE conversation_id = ?1
                 )
             )",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM harness_runs WHERE session_id IN (
                 SELECT id FROM sessions WHERE conversation_id = ?1
             )",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM conversation_collaborators WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        // Their `ON DELETE CASCADE` never fires with FK enforcement off. Left
        // behind, the sealed LLM handoff summaries and every past title outlive
        // the chat, and a recreated id would inherit them (and the auto-resume
        // attempt ledger and pending agent control).
        for table in CONVERSATION_SCOPED_HISTORY_TABLES {
            conn.execute(
                &format!("DELETE FROM {table} WHERE conversation_id = ?1"),
                params![conversation_id],
            )?;
        }
        let removed = conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        drop(conn);
        self.remove_conversation_from_indexes(conversation_id).await;
        Ok(removed > 0)
    }

    /// The derived search indexes hold a conversation's vectors and blind terms:
    /// remove them with it. Best-effort (the source rows are already gone,
    /// search drops hits that no longer resolve, and the backfill's orphan sweep
    /// retries).
    async fn remove_conversation_from_indexes(&self, conversation_id: &str) {
        if let Some(index) = self.message_fts.as_ref() {
            if let Err(error) = index.delete_conversation(conversation_id).await {
                tracing::warn!(
                    "keyword index cleanup for a deleted conversation failed: {error:#}"
                );
            }
        }
        if let Some(index) = self.message_index.as_ref() {
            if let Err(error) = index.delete_conversation(conversation_id).await {
                tracing::warn!(
                    "semantic index cleanup for a deleted conversation failed: {error:#}"
                );
            }
        }
    }

    // ── Side questions (`/btw`) ───────────────────────────────────────────────

    /// Persist a `/btw` side question + answer against its parent conversation.
    /// `question`/`answer` are sealed at rest. Returns the stored entry (with the
    /// plaintext fields, for an immediate echo back to the client).
    pub async fn append_btw(
        &self,
        conversation_id: &str,
        question: &str,
        answer: &str,
        model: Option<&str>,
    ) -> Result<BtwEntry> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let sealed_q = self.cipher.seal(question)?;
        let sealed_a = self.cipher.seal(answer)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO btw_entries (id, conversation_id, kind, question, answer, model, created_at)
             VALUES (?1, ?2, 'btw', ?3, ?4, ?5, ?6)",
            params![id, conversation_id, sealed_q, sealed_a, model, now],
        )
        .context("persisting btw entry")?;
        Ok(BtwEntry {
            id,
            conversation_id: conversation_id.to_owned(),
            kind: "btw".to_owned(),
            question: question.to_owned(),
            answer: answer.to_owned(),
            model: model.map(str::to_owned),
            agent_id: None,
            preset: None,
            child_conversation_id: None,
            created_at: now,
        })
    }

    /// Persist a delegated subagent child under its parent conversation. The row
    /// is intentionally summary-shaped: `question` is the task, `answer` is the
    /// final output or error text, and `child_conversation_id` points at the full
    /// clean-context ACP transcript when a registered agent produced one.
    pub async fn append_subagent_child(
        &self,
        conversation_id: &str,
        task: &str,
        answer: &str,
        agent_id: Option<&str>,
        preset: Option<&str>,
        child_conversation_id: Option<&str>,
    ) -> Result<BtwEntry> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let sealed_task = self.cipher.seal(task)?;
        let sealed_answer = self.cipher.seal(answer)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO btw_entries (
                 id, conversation_id, kind, question, answer, model,
                 agent_id, preset, child_conversation_id, created_at
             )
             VALUES (?1, ?2, 'subagent', ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                id,
                conversation_id,
                sealed_task,
                sealed_answer,
                agent_id,
                preset,
                child_conversation_id,
                now
            ],
        )
        .context("persisting subagent child entry")?;
        Ok(BtwEntry {
            id,
            conversation_id: conversation_id.to_owned(),
            kind: "subagent".to_owned(),
            question: task.to_owned(),
            answer: answer.to_owned(),
            model: None,
            agent_id: agent_id.map(str::to_owned),
            preset: preset.map(str::to_owned),
            child_conversation_id: child_conversation_id.map(str::to_owned),
            created_at: now,
        })
    }

    /// All child entries for a conversation, newest first.
    pub async fn list_btw(&self, conversation_id: &str) -> Result<Vec<BtwEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, kind, question, answer, model,
                    agent_id, preset, child_conversation_id, created_at
             FROM btw_entries
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(BtwEntry {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                kind: row.get(2)?,
                question: row.get(3)?,
                answer: row.get(4)?,
                model: row.get(5)?,
                agent_id: row.get(6)?,
                preset: row.get(7)?,
                child_conversation_id: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut entry = row?;
            entry.question = self.open_content(std::mem::take(&mut entry.question));
            entry.answer = self.open_content(std::mem::take(&mut entry.answer));
            out.push(entry);
        }
        Ok(out)
    }

    /// Delete a single side question by id. Returns true when a row was removed.
    pub async fn delete_btw(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM btw_entries WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Total number of conversations (for the danger-zone "Delete all 42 chats?"
    /// preview). Cheap `COUNT(*)`, no row materialization.
    pub async fn count_conversations(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// `(sealed, total)` chat-content rows, for the encryption-status surface.
    ///
    /// Measured, not assumed: sealed rows carry the `enc:v1:` envelope prefix, so
    /// a row written before encryption landed counts toward `total` but not
    /// `sealed`. Reporting a flat "encrypted ✓" would hide exactly that legacy
    /// plaintext.
    ///
    /// Counts ROWS, not fields, keyed on the field that every row has: a message is
    /// sealed when its `content` envelope is present, a conversation when its
    /// `title` is. `parts` needs no term of its own — it is sealed through the same
    /// [`FieldCipher`] in [`Self::update_message_parts`], and it only ever exists on
    /// a row already counted here, so adding it would double-count the same message.
    /// If a future field is sealed on a path of its own, it needs a term on BOTH
    /// sides — one added to `total` alone would peg every node at partial coverage.
    pub async fn count_sealed_content(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock().await;
        let (sealed, total): (i64, i64) = conn.query_row(
            "SELECT
                 (SELECT COUNT(*) FROM messages WHERE content LIKE 'enc:v1:%')
                 + (SELECT COUNT(*) FROM conversations WHERE title LIKE 'enc:v1:%'),
                 (SELECT COUNT(*) FROM messages)
                 + (SELECT COUNT(*) FROM conversations WHERE title IS NOT NULL AND title <> '')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok((sealed.max(0) as u64, total.max(0) as u64))
    }

    /// Delete **every** conversation and all chat-scoped state: messages and
    /// sessions (both keyed by `conversation_id`) plus the conversation rows
    /// themselves (which carry the goal columns). Returns the number of
    /// conversations removed. This goes further than [`Self::delete_conversation`],
    /// which leaves sessions orphaned — a full wipe should not.
    ///
    /// The returned [`ClearedConversations::residue`] is read under the same
    /// lock as the deletes, so it names exactly the conversations removed (one
    /// created concurrently either is cleared and listed, or survives).
    pub async fn clear_all_conversations(&self) -> Result<ClearedConversations> {
        // One transaction, so a failure part-way cannot leave reactions or other
        // side tables behind to resurface under a reused conversation id.
        let mut conn = self.conn.lock().await;
        let residue = cleared_conversation_residue(&conn, None)?;
        // Scoped so the transaction (which borrows the connection, so is not
        // `Send`) is gone before the awaits below.
        let removed = {
            let transaction = conn.transaction()?;
            transaction.execute("DELETE FROM messages", [])?;
            transaction.execute("DELETE FROM message_read_receipts", [])?;
            transaction.execute(
                "DELETE FROM harness_run_events WHERE run_id IN (SELECT id FROM harness_runs)",
                [],
            )?;
            transaction.execute("DELETE FROM harness_runs", [])?;
            transaction.execute("DELETE FROM sessions", [])?;
            transaction.execute("DELETE FROM btw_entries", [])?;
            // No FK on either table (see `delete_conversation`): without these the
            // reactions and the saved widget/page state (whatever the user typed into
            // a generative-UI widget) would outlive the wipe as unreachable orphans.
            transaction.execute("DELETE FROM message_reactions", [])?;
            transaction.execute("DELETE FROM agent_ui_state", [])?;
            transaction.execute("DELETE FROM chat_checkpoints", [])?;
            transaction.execute("DELETE FROM proactive_openings", [])?;
            transaction.execute("DELETE FROM channel_turn_idempotency", [])?;
            transaction.execute("DELETE FROM conversation_collaborators", [])?;
            for table in CONVERSATION_SCOPED_HISTORY_TABLES {
                transaction.execute(&format!("DELETE FROM {table}"), [])?;
            }
            let removed = transaction.execute("DELETE FROM conversations", [])?;
            transaction.commit()?;
            removed
        };
        drop(conn);
        // Every message is gone, so the derived indexes (blind terms, sealed
        // vectors, the in-memory partition) are emptied with them; the backfill
        // flags reset. Best-effort: the orphan sweep retries on a later search.
        if let Err(error) = self.clear_message_embeddings().await {
            tracing::warn!("search index cleanup after clearing all chats failed: {error:#}");
        }
        Ok(ClearedConversations {
            removed: removed as u64,
            residue,
        })
    }

    /// The tenancy-scoped twin of [`Self::clear_all_conversations`]: delete ONLY the
    /// conversations `owner_user_id` owns, plus their messages/sessions/side-chats.
    ///
    /// `POST /api/data/clear` used the unscoped truncate above with no ACL at all, so
    /// on an org-bound node any holder of the node token could destroy EVERY user's
    /// chats. On a bound node the danger-zone clear now routes here instead. Strict
    /// owner-match on purpose: an org-visible chat owned by a colleague is NOT the
    /// caller's to delete.
    ///
    /// Like [`Self::clear_all_conversations`], the residue is read under the
    /// same lock as the deletes.
    pub async fn clear_conversations_owned_by(
        &self,
        owner_user_id: &str,
    ) -> Result<ClearedConversations> {
        // One transaction, so a failure part-way cannot leave this owner's
        // reactions or other side tables behind for a reused conversation id.
        let mut conn = self.conn.lock().await;
        let residue = cleared_conversation_residue(&conn, Some(owner_user_id))?;
        let owned = "SELECT id FROM conversations WHERE owner_user_id = ?1";
        // Collected first: the derived search indexes are cleaned per
        // conversation after the wipe.
        let owned_ids: Vec<String> = {
            let mut stmt = conn.prepare(owned)?;
            let rows = stmt.query_map(params![owner_user_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        // Scoped so the transaction (which borrows the connection, so is not
        // `Send`) is gone before the awaits below.
        let removed = {
            let transaction = conn.transaction()?;
            transaction.execute(
                &format!("DELETE FROM messages WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM message_read_receipts WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            // Harness runs hang off sessions (`sess_…` ids), not conversation ids, so
            // resolve the owned conversations' sessions first.
            let owned_sessions =
                format!("SELECT id FROM sessions WHERE conversation_id IN ({owned})");
            transaction.execute(
                &format!(
                    "DELETE FROM harness_run_events WHERE run_id IN (
                     SELECT id FROM harness_runs WHERE session_id IN ({owned_sessions})
                 )"
                ),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM harness_runs WHERE session_id IN ({owned_sessions})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM sessions WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM btw_entries WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM message_reactions WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM agent_ui_state WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM chat_checkpoints WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM proactive_openings WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!("DELETE FROM channel_turn_idempotency WHERE conversation_id IN ({owned})"),
                params![owner_user_id],
            )?;
            transaction.execute(
                &format!(
                    "DELETE FROM conversation_collaborators WHERE conversation_id IN ({owned})"
                ),
                params![owner_user_id],
            )?;
            // Before the conversations themselves: `owned` reads their ids.
            for table in CONVERSATION_SCOPED_HISTORY_TABLES {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE conversation_id IN ({owned})"),
                    params![owner_user_id],
                )?;
            }
            let removed_rows = transaction.execute(
                "DELETE FROM conversations WHERE owner_user_id = ?1",
                params![owner_user_id],
            )?;
            transaction.commit()?;
            removed_rows
        };
        drop(conn);
        for conversation_id in &owned_ids {
            self.remove_conversation_from_indexes(conversation_id).await;
        }
        Ok(ClearedConversations {
            removed: removed as u64,
            residue,
        })
    }

    // ── Session methods ──────────────────────────────────────────────────────

    /// Create a new Session bound to a Runnable, reusing the existing
    /// conversation create path. The conversation is upserted via
    /// [`Self::ensure_conversation`] so no message data is duplicated.
    pub async fn create_session(
        &self,
        runnable_id: &str,
        runnable_kind: RunnableKind,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<Session> {
        let session_id = format!("sess_{}", uuid::Uuid::new_v4().simple());
        let conversation_id = format!("conv_{}", uuid::Uuid::new_v4().simple());
        let now = now_millis();

        // Reuse the existing conversation create path — no duplicate message store.
        let title = self.seal_opt(title)?;
        {
            let conn = self.conn.lock().await;
            upsert_conversation_row(
                &conn,
                &conversation_id,
                now,
                &tenancy,
                &ConvRow {
                    title: title.as_deref(),
                    agent_id,
                    ..ConvRow::default()
                },
                Touch::Keep,
            )
            .context("creating conversation for session")?;

            conn.execute(
                "INSERT INTO sessions (id, conversation_id, runnable_id, runnable_kind, status,
                 execution_profile, parent_session_id, native_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
                params![
                    session_id,
                    conversation_id,
                    runnable_id,
                    runnable_kind.as_str(),
                    SessionStatus::Idle.as_str(),
                    serde_json::to_string(&ExecutionProfile::default())?,
                    now,
                ],
            )
            .context("inserting session")?;
        }

        Ok(Session {
            id: session_id,
            conversation_id,
            runnable_id: runnable_id.to_string(),
            runnable_kind,
            status: SessionStatus::Idle,
            execution_profile: ExecutionProfile::default(),
            parent_session_id: None,
            native_session_id: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Load a session by id.
    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status,
                    execution_profile, parent_session_id, native_session_id,
                    created_at, updated_at
             FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        match rows.next() {
            None => Ok(None),
            Some(row) => {
                let (
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind_str,
                    status_str,
                    execution_profile_json,
                    parent_session_id,
                    native_session_id,
                    created_at,
                    updated_at,
                ) = row?;
                let runnable_kind = parse_runnable_kind(&runnable_kind_str);
                Ok(Some(Session {
                    id,
                    conversation_id,
                    runnable_id,
                    runnable_kind,
                    status: SessionStatus::from_str(&status_str),
                    execution_profile: parse_execution_profile(&execution_profile_json),
                    parent_session_id,
                    native_session_id,
                    created_at,
                    updated_at,
                }))
            }
        }
    }

    /// Update the status of a session.
    pub async fn update_session_status(
        &self,
        session_id: &str,
        status: SessionStatus,
    ) -> Result<bool> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status.as_str(), now, session_id],
        )?;
        Ok(updated > 0)
    }

    /// List sessions for a conversation, most-recently-updated first.
    pub async fn list_sessions_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status,
                    execution_profile, parent_session_id, native_session_id,
                    created_at, updated_at
             FROM sessions WHERE conversation_id = ?1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                conversation_id,
                runnable_id,
                runnable_kind_str,
                status_str,
                execution_profile_json,
                parent_session_id,
                native_session_id,
                created_at,
                updated_at,
            ) = row?;
            let runnable_kind = parse_runnable_kind(&runnable_kind_str);
            out.push(Session {
                id,
                conversation_id,
                runnable_id,
                runnable_kind,
                status: SessionStatus::from_str(&status_str),
                execution_profile: parse_execution_profile(&execution_profile_json),
                parent_session_id,
                native_session_id,
                created_at,
                updated_at,
            });
        }
        Ok(out)
    }

    /// List active Runnable sessions visible to this caller, newest activity
    /// first. The cap bounds the model-facing session roster.
    pub async fn list_running_sessions_visible(
        &self,
        owner_user_id: Option<&str>,
        org_id: Option<&str>,
        node_bound: bool,
        limit: usize,
    ) -> Result<Vec<Session>> {
        let filter = TenancyFilter::for_http_caller(node_bound, owner_user_id, org_id, None);
        let limit = limit.clamp(1, 100);
        let sql = format!(
            "SELECT s.id, s.conversation_id, s.runnable_id, s.runnable_kind, s.status,
                    s.execution_profile, s.parent_session_id, s.native_session_id,
                    s.created_at, s.updated_at
             FROM sessions s
             JOIN conversations c ON c.id = s.conversation_id
             WHERE s.status = 'running' AND {TENANCY_VISIBLE_PREDICATE}
             ORDER BY s.updated_at DESC
             LIMIT :limit"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json,
                ":limit": limit as i64,
            },
            |row| {
                let runnable_kind = parse_runnable_kind(&row.get::<_, String>(3)?);
                let status = SessionStatus::from_str(&row.get::<_, String>(4)?);
                let execution_profile = parse_execution_profile(&row.get::<_, String>(5)?);
                Ok(Session {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    runnable_id: row.get(2)?,
                    runnable_kind,
                    status,
                    execution_profile,
                    parent_session_id: row.get(6)?,
                    native_session_id: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("listing visible active sessions")
    }

    // ── Versioned agent harness ─────────────────────────────────────────────

    /// Store the portable execution profile attached to a session. The profile
    /// is intentionally separate from the node's secrets and from Gateway's
    /// effective policy; it records what the caller requested so every host can
    /// render the same run provenance.
    pub async fn set_session_execution_profile(
        &self,
        session_id: &str,
        profile: &ExecutionProfile,
        parent_session_id: Option<&str>,
    ) -> Result<bool> {
        let probe = StartRunRequest {
            input: serde_json::json!({}),
            idempotency_key: None,
            execution_profile: Some(profile.clone()),
            resume_run_id: None,
            multitask_strategy: None,
        };
        validate_start_request(&probe).map_err(anyhow::Error::msg)?;
        let profile_json = serde_json::to_string(profile)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions
             SET execution_profile = ?1, parent_session_id = ?2, updated_at = ?3
             WHERE id = ?4",
            params![profile_json, parent_session_id, now, session_id],
        )?;
        Ok(updated > 0)
    }

    /// Record the native session id supplied by an external runtime such as
    /// ACP/Codex. This is a projection binding only; the native runtime remains
    /// responsible for the native transcript and its own resume semantics.
    pub async fn set_session_native_id(
        &self,
        session_id: &str,
        native_session_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE sessions SET native_session_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![native_session_id, now_millis(), session_id],
        )?;
        Ok(updated > 0)
    }

    /// Convert the legacy session row into the versioned harness projection.
    /// The newest harness run supplies the richer lifecycle when one exists;
    /// otherwise the legacy idle/running/completed/failed state is preserved.
    pub async fn get_harness_session(&self, session_id: &str) -> Result<Option<HarnessSession>> {
        let Some(session) = self.get_session(session_id).await? else {
            return Ok(None);
        };
        // A queued run is newer than the run it waits behind, so the live run
        // (if any) describes the session; otherwise the newest run does.
        let runs = self.list_harness_runs(session_id).await?;
        let status = runs
            .iter()
            .find(|run| {
                matches!(
                    run.status,
                    HarnessRunStatus::Running | HarnessRunStatus::AwaitingApproval
                )
            })
            .or_else(|| runs.first())
            .map(|run| run.status)
            .unwrap_or_else(|| harness_status_from_legacy(&session.status));
        Ok(Some(HarnessSession {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            id: session.id,
            conversation_id: session.conversation_id,
            runnable_id: session.runnable_id,
            runnable_kind: session.runnable_kind.as_str().to_owned(),
            status,
            parent_session_id: session.parent_session_id,
            execution_profile: session.execution_profile,
            native_session_id: session.native_session_id,
            created_at: millis_to_rfc3339(session.created_at),
            updated_at: millis_to_rfc3339(session.updated_at),
        }))
    }

    /// List durable child sessions spawned from a parent session. Child rows
    /// stay independently addressable so they can be resumed or inspected
    /// without copying the parent's transcript.
    pub async fn list_child_harness_sessions(
        &self,
        parent_session_id: &str,
    ) -> Result<Vec<HarnessSession>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM sessions WHERE parent_session_id = ?1
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map(params![parent_session_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut children = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(session) = self.get_harness_session(&id).await? {
                children.push(session);
            }
        }
        Ok(children)
    }

    /// A newly-created idempotent harness run. `created = false` means the
    /// caller must attach to the existing run and must not dispatch a duplicate.
    ///
    /// The request's [`MultitaskStrategy`] decides what happens while the
    /// session already has an active (or queued) run:
    /// - `reject` fails with an "active run" / "queued run" conflict;
    /// - `enqueue` persists the run as `pending` at the back of the queue;
    /// - `interrupt` / `rollback` persist it as `pending` ahead of enqueued runs
    ///   and name the active run in [`HarnessRunStart::displaced_run_id`] so the
    ///   caller can stop it. A rollback also records which run's turns to remove
    ///   when it is promoted ([`Self::promote_next_harness_run`]).
    ///
    /// A `pending` run's first event is `run_queued`; `run_started` and
    /// `input_accepted` are appended when it is promoted.
    pub async fn start_harness_run(
        &self,
        session_id: &str,
        request: &StartRunRequest,
    ) -> Result<HarnessRunStart> {
        validate_start_request(request).map_err(anyhow::Error::msg)?;
        let Some(session) = self.get_session(session_id).await? else {
            anyhow::bail!("session '{session_id}' not found");
        };
        let profile = request
            .execution_profile
            .clone()
            .unwrap_or_else(|| session.execution_profile.clone());
        let input = serde_json::to_string(&request.input)?;
        let sealed_input = self.cipher.seal(&input)?;
        let idempotency_key = request
            .idempotency_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        let input_hash = ryu_tracing::hash_args(&request.input);
        let message_count = harness_message_count(&request.input);
        let strategy = request.multitask_strategy.unwrap_or_default();
        let stored_strategy = request
            .multitask_strategy
            .filter(|value| *value != MultitaskStrategy::Reject);
        let now = now_millis();
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let profile_json = serde_json::to_string(&profile)?;
        let parent_run_id = request.resume_run_id.clone();
        let created_at = millis_to_rfc3339(now);
        let (new_run, existing_id) = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let existing_id: Option<String> = if let Some(key) = idempotency_key.as_deref() {
                let existing: Option<(String, String, String, Option<String>)> = tx
                    .query_row(
                        "SELECT id, input_json, execution_profile, parent_run_id
                     FROM harness_runs
                     WHERE session_id = ?1 AND idempotency_key = ?2",
                        params![session_id, key],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                if let Some((existing_id, existing_input, existing_profile, existing_parent)) =
                    existing
                {
                    let existing_input = self.cipher.open(&existing_input)?;
                    if existing_input != input
                        || existing_profile != profile_json
                        || existing_parent != parent_run_id
                    {
                        anyhow::bail!(
                            "idempotency_key '{key}' was already used with a different request"
                        );
                    }
                    Some(existing_id)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(existing_id) = existing_id {
                drop(tx);
                drop(conn);
                (None, Some(existing_id))
            } else {
                let active: Option<(String, String)> = tx
                    .query_row(
                        "SELECT id, status FROM harness_runs
                         WHERE session_id = ?1
                           AND status IN ('running', 'awaiting_approval')
                         ORDER BY created_at DESC LIMIT 1",
                        params![session_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let queued: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM harness_runs
                     WHERE session_id = ?1 AND status = 'pending'",
                    params![session_id],
                    |row| row.get(0),
                )?;
                if strategy == MultitaskStrategy::Reject {
                    if let Some((active_id, active_status)) = active.as_ref() {
                        anyhow::bail!(
                            "session already has active run '{active_id}' ({active_status})"
                        );
                    }
                    if queued > 0 {
                        anyhow::bail!("session already has {queued} queued run(s)");
                    }
                }
                if let Some(parent_id) = parent_run_id.as_deref() {
                    let parent_session: Option<String> = tx
                        .query_row(
                            "SELECT session_id FROM harness_runs WHERE id = ?1",
                            params![parent_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    match parent_session {
                        Some(parent_session) if parent_session == session_id => {}
                        Some(_) => anyhow::bail!("resume_run_id belongs to another session"),
                        None => anyhow::bail!("resume_run_id '{parent_id}' not found"),
                    }
                }

                let attempt: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(attempt), 0) + 1 FROM harness_runs WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )?;
                let active_id = active.map(|(id, _)| id);
                let must_wait = active_id.is_some() || queued > 0;
                let (priority, displaced, rollback_of) = if strategy.preempts() {
                    (
                        1_i64,
                        active_id.clone(),
                        active_id
                            .clone()
                            .filter(|_| strategy == MultitaskStrategy::Rollback),
                    )
                } else {
                    (0, None, None)
                };
                if must_wait {
                    // Position among the runs that will start before this one:
                    // preempting runs only queue behind other preempting runs.
                    let ahead: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM harness_runs
                         WHERE session_id = ?1 AND status = 'pending' AND queue_priority >= ?2",
                        params![session_id, priority],
                        |row| row.get(0),
                    )?;
                    tx.execute(
                        "INSERT INTO harness_runs (
                             id, session_id, parent_run_id, status, attempt, idempotency_key,
                             execution_profile, input_json, event_seq, created_at,
                             multitask_strategy, queue_priority, rollback_run_id
                         ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11)",
                        params![
                            run_id,
                            session_id,
                            parent_run_id,
                            attempt,
                            idempotency_key,
                            profile_json,
                            sealed_input,
                            now,
                            stored_strategy.map(MultitaskStrategy::as_str),
                            priority,
                            rollback_of,
                        ],
                    )?;
                    let queued_event = build_harness_event(
                        &run_id,
                        session_id,
                        1,
                        now,
                        RunEvent::RunQueued {
                            position: u32::try_from(ahead.max(0) + 1).unwrap_or(u32::MAX),
                            strategy,
                            active_run_id: active_id.clone(),
                        },
                    );
                    insert_harness_event(&tx, &self.cipher, &queued_event)?;
                    tx.commit()?;
                    (
                        Some((
                            vec![queued_event],
                            attempt,
                            HarnessRunStatus::Pending,
                            displaced,
                        )),
                        None,
                    )
                } else {
                    tx.execute(
                        "INSERT INTO harness_runs (
                             id, session_id, parent_run_id, status, attempt, idempotency_key,
                             execution_profile, input_json, event_seq, created_at, started_at,
                             multitask_strategy
                         ) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, 0, ?8, ?8, ?9)",
                        params![
                            run_id,
                            session_id,
                            parent_run_id,
                            attempt,
                            idempotency_key,
                            profile_json,
                            sealed_input,
                            now,
                            stored_strategy.map(MultitaskStrategy::as_str),
                        ],
                    )?;
                    tx.execute(
                        "UPDATE sessions SET status = 'running', updated_at = ?1 WHERE id = ?2",
                        params![now, session_id],
                    )?;
                    let events = append_run_start_events(
                        &tx,
                        &self.cipher,
                        &run_id,
                        session_id,
                        0,
                        now,
                        profile.clone(),
                        input_hash,
                        message_count,
                    )?;
                    tx.commit()?;
                    (
                        Some((events, attempt, HarnessRunStatus::Running, None)),
                        None,
                    )
                }
            }
        };
        if let Some(existing_id) = existing_id {
            let run = self
                .get_harness_run(&existing_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("idempotent harness run disappeared"))?;
            return Ok(HarnessRunStart {
                run,
                created: false,
                displaced_run_id: None,
            });
        }
        let Some((events, attempt, status, displaced_run_id)) = new_run else {
            anyhow::bail!("harness run creation produced no run");
        };
        let event_cursor = events.last().map_or(0, |event| event.seq);
        for event in events {
            let _ = harness_events_sender().send(event);
        }
        let running = status == HarnessRunStatus::Running;
        Ok(HarnessRunStart {
            run: HarnessRun {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                id: run_id,
                session_id: session_id.to_owned(),
                status,
                attempt: u32::try_from(attempt.max(0)).unwrap_or(u32::MAX),
                idempotency_key,
                parent_run_id,
                execution_profile: profile,
                event_cursor,
                created_at: created_at.clone(),
                started_at: running.then_some(created_at),
                finished_at: None,
                error: None,
                output: None,
                multitask_strategy: stored_strategy,
            },
            created: true,
            displaced_run_id,
        })
    }

    /// Start the next queued run of a session when nothing is active. Returns
    /// `None` when a run is still `running`/`awaiting_approval` or the queue is
    /// empty, so concurrent callers can race safely: exactly one of them
    /// promotes a given run. A rollback run removes the transcript turns of the
    /// run it displaced in the same transaction, before it is dispatched.
    pub async fn promote_next_harness_run(
        &self,
        session_id: &str,
    ) -> Result<Option<PromotedHarnessRun>> {
        let promoted = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let active: Option<String> = tx
                .query_row(
                    "SELECT id FROM harness_runs
                     WHERE session_id = ?1 AND status IN ('running', 'awaiting_approval')
                     LIMIT 1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Ok(None);
            }
            let next: Option<(String, String, String, i64, Option<String>)> = tx
                .query_row(
                    "SELECT id, input_json, execution_profile, event_seq, rollback_run_id
                     FROM harness_runs
                     WHERE session_id = ?1 AND status = 'pending'
                     ORDER BY queue_priority DESC, created_at ASC, rowid ASC
                     LIMIT 1",
                    params![session_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((run_id, sealed_input, profile_json, current_seq, rollback_run_id)) = next
            else {
                return Ok(None);
            };
            let conversation_id: String = tx.query_row(
                "SELECT conversation_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            let input_json = self.cipher.open(&sealed_input)?;
            let input: serde_json::Value = serde_json::from_str(&input_json)?;
            let mut removed_message_ids = Vec::new();
            if let Some(rolled_back) = rollback_run_id.as_deref() {
                removed_message_ids =
                    rollback_harness_run_turns_locked(&tx, &conversation_id, rolled_back)?;
            }
            let now = now_millis();
            tx.execute(
                "UPDATE harness_runs SET status = 'running', started_at = ?1 WHERE id = ?2",
                params![now, run_id],
            )?;
            tx.execute(
                "UPDATE sessions SET status = 'running', updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            let events = append_run_start_events(
                &tx,
                &self.cipher,
                &run_id,
                session_id,
                u64::try_from(current_seq.max(0)).unwrap_or(0),
                now,
                parse_execution_profile(&profile_json),
                ryu_tracing::hash_args(&input),
                harness_message_count(&input),
            )?;
            tx.commit()?;
            (run_id, input, conversation_id, removed_message_ids, events)
        };
        let (run_id, input, conversation_id, removed_message_ids, events) = promoted;
        for event in events {
            let _ = harness_events_sender().send(event);
        }
        // The search indexes skip message ids that no longer resolve, so the
        // removed turns stop appearing in recall without an index write here.
        let run = self
            .get_harness_run(&run_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("promoted harness run disappeared"))?;
        Ok(Some(PromotedHarnessRun {
            run,
            input,
            conversation_id,
            removed_messages: removed_message_ids.len(),
        }))
    }

    /// Sessions that still hold queued (`pending`) harness runs, with whether
    /// their conversation is attributed to a person or org. Used at boot to
    /// drain queues that a restart left behind.
    pub async fn list_sessions_with_queued_harness_runs(
        &self,
    ) -> Result<Vec<QueuedHarnessSession>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT r.session_id,
                    (c.owner_user_id IS NOT NULL OR c.org_id IS NOT NULL)
             FROM harness_runs r
             JOIN sessions s ON s.id = r.session_id
             LEFT JOIN conversations c ON c.id = s.conversation_id
             WHERE r.status = 'pending'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(QueuedHarnessSession {
                session_id: row.get(0)?,
                attributed: row.get::<_, Option<bool>>(1)?.unwrap_or(false),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Fetch one durable harness run by id.
    pub async fn get_harness_run(&self, run_id: &str) -> Result<Option<HarnessRun>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, session_id, parent_run_id, status, attempt, idempotency_key,
                        execution_profile, input_json, output_json, error, event_seq,
                        created_at, started_at, finished_at, multitask_strategy
                 FROM harness_runs WHERE id = ?1",
                params![run_id],
                read_harness_run_row,
            )
            .optional()?
        };
        raw.map(|row| decode_harness_run(&self.cipher, row))
            .transpose()
    }

    /// List a session's runs newest-first.
    pub async fn list_harness_runs(&self, session_id: &str) -> Result<Vec<HarnessRun>> {
        let raw = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, session_id, parent_run_id, status, attempt, idempotency_key,
                        execution_profile, input_json, output_json, error, event_seq,
                        created_at, started_at, finished_at, multitask_strategy
                 FROM harness_runs WHERE session_id = ?1
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            let rows = stmt.query_map(params![session_id], read_harness_run_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // A row whose sealed fields do not open is skipped and counted, never
        // allowed to fail the whole list (get-by-id still errors).
        let mut runs = Vec::with_capacity(raw.len());
        let mut skipped = 0u64;
        for row in raw {
            match decode_harness_run(&self.cipher, row) {
                Ok(run) => runs.push(run),
                Err(error) => {
                    skipped += 1;
                    tracing::debug!("harness run skipped: {error:#}");
                }
            }
        }
        if skipped > 0 {
            let total = self
                .harness_unreadable
                .fetch_add(skipped, Ordering::Relaxed)
                + skipped;
            tracing::warn!(
                skipped,
                total,
                "harness runs: skipped rows whose sealed fields did not open \
                 (conversations.db.unreadable_rows)"
            );
        }
        Ok(runs)
    }

    /// Append one ordered event to the durable run journal and wake live
    /// subscribers. Event payloads are bounded and already redacted by the
    /// caller; raw model/tool arguments are never required by this contract.
    pub async fn append_harness_event(
        &self,
        run_id: &str,
        event: RunEvent,
    ) -> Result<RunEventEnvelope> {
        let (envelope, _) = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (session_id, current_seq): (String, i64) = tx
                .query_row(
                    "SELECT session_id, event_seq FROM harness_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .context("loading harness run for event")?;
            let seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
            let now = now_millis();
            let envelope = build_harness_event(run_id, &session_id, seq, now, event);
            insert_harness_event(&tx, &self.cipher, &envelope)?;
            tx.execute(
                "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
                params![i64::try_from(seq).unwrap_or(i64::MAX), run_id],
            )?;
            tx.commit()?;
            (envelope, seq)
        };
        let _ = harness_events_sender().send(envelope.clone());
        Ok(envelope)
    }

    /// Read a bounded event page after an exclusive sequence cursor.
    pub async fn list_harness_events(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<RunEventEnvelope>> {
        let after = i64::try_from(after_seq).unwrap_or(i64::MAX);
        let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT event_json FROM harness_run_events
             WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![run_id, after, limit], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let sealed = row?;
            let json = self.cipher.open(&sealed).context("opening harness event")?;
            serde_json::from_str(&json).context("decoding harness event")
        })
        .collect()
    }

    /// Move a non-terminal run between `running` and `awaiting_approval`
    /// without creating an extra synthetic event. The approval event itself is
    /// the durable explanation for the transition; this method only updates the
    /// indexed state used by `GET /api/harness/runs/:id`.
    pub async fn set_harness_run_status(
        &self,
        run_id: &str,
        status: HarnessRunStatus,
    ) -> Result<bool> {
        if status.is_terminal() {
            anyhow::bail!("set_harness_run_status accepts non-terminal states only");
        }
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE harness_runs SET status = ?1 WHERE id = ?2
             AND status NOT IN ('completed', 'failed', 'canceled', 'interrupted')",
            params![status.as_str(), run_id],
        )?;
        Ok(updated > 0)
    }

    /// Complete, fail, cancel, or interrupt a run. Terminal calls are
    /// idempotent: a late duplicate completion cannot append a second terminal
    /// event or move a run back out of its terminal state.
    pub async fn finish_harness_run(
        &self,
        run_id: &str,
        status: HarnessRunStatus,
        error: Option<&str>,
        output: Option<&serde_json::Value>,
    ) -> Result<Option<HarnessRun>> {
        if !status.is_terminal() {
            anyhow::bail!("harness finish status must be terminal");
        }
        let mut published = None;
        let mut already_terminal = false;
        {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let row: Option<(String, i64, String)> = tx
                .query_row(
                    "SELECT session_id, event_seq, status FROM harness_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((session_id, current_seq, current_status)) = row else {
                drop(tx);
                drop(conn);
                // Keep the decision outside this transaction scope so a caller
                // that is already in a Tokio task never holds a rusqlite
                // transaction across the async reload below.
                return Ok(None);
            };
            if HarnessRunStatus::from_str(&current_status).is_terminal() {
                already_terminal = true;
                drop(tx);
                drop(conn);
            } else {
                let now = now_millis();
                let output_json = output
                    .map(serde_json::to_string)
                    .transpose()?
                    .map(|value| self.cipher.seal(&value))
                    .transpose()?;
                // The error text can echo provider responses (prompt fragments):
                // sealed like the output.
                let sealed_error = error.map(|value| self.cipher.seal(value)).transpose()?;
                tx.execute(
                    "UPDATE harness_runs
                     SET status = ?1, error = ?2, output_json = ?3, finished_at = ?4
                     WHERE id = ?5",
                    params![status.as_str(), sealed_error, output_json, now, run_id],
                )?;
                let session_status = match status {
                    HarnessRunStatus::Completed => "completed",
                    HarnessRunStatus::Canceled
                    | HarnessRunStatus::Failed
                    | HarnessRunStatus::Interrupted => "failed",
                    HarnessRunStatus::Pending
                    | HarnessRunStatus::Running
                    | HarnessRunStatus::AwaitingApproval => "running",
                };
                // Finishing a queued run must not overwrite the status of
                // the run that is still live in the same session.
                tx.execute(
                    "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3
                     AND NOT EXISTS (
                         SELECT 1 FROM harness_runs
                         WHERE session_id = ?3 AND id != ?4
                           AND status IN ('running', 'awaiting_approval')
                     )",
                    params![session_status, now, session_id, run_id],
                )?;
                let next_seq = u64::try_from(current_seq.max(0) + 1).unwrap_or(u64::MAX);
                let terminal_event = match status {
                    HarnessRunStatus::Completed => RunEvent::RunCompleted {
                        output: output.cloned(),
                    },
                    HarnessRunStatus::Canceled => RunEvent::RunCanceled,
                    HarnessRunStatus::Interrupted => RunEvent::RunInterrupted,
                    HarnessRunStatus::Failed => RunEvent::RunFailed {
                        code: "run_failed".to_owned(),
                        message: error.unwrap_or("run failed").to_owned(),
                    },
                    HarnessRunStatus::Pending
                    | HarnessRunStatus::Running
                    | HarnessRunStatus::AwaitingApproval => unreachable!(),
                };
                let envelope =
                    build_harness_event(run_id, &session_id, next_seq, now, terminal_event);
                insert_harness_event(&tx, &self.cipher, &envelope)?;
                tx.execute(
                    "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
                    params![i64::try_from(next_seq).unwrap_or(i64::MAX), run_id],
                )?;
                tx.commit()?;
                published = Some(envelope);
            }
        }
        if already_terminal {
            return self.get_harness_run(run_id).await;
        }
        if let Some(envelope) = published {
            let _ = harness_events_sender().send(envelope);
        }
        self.get_harness_run(run_id).await
    }
}

/// The result of starting a run, including whether dispatch is new or an
/// idempotent replay.
#[derive(Debug, Clone)]
pub struct HarnessRunStart {
    pub run: HarnessRun,
    pub created: bool,
    /// The active run an `interrupt`/`rollback` request displaces. The caller
    /// stops it; the new run is promoted once it has ended.
    pub displaced_run_id: Option<String>,
}

/// A queued run that was just moved to `running` and must be dispatched.
#[derive(Debug, Clone)]
pub struct PromotedHarnessRun {
    pub run: HarnessRun,
    /// The run's decrypted input, as accepted when it was queued.
    pub input: serde_json::Value,
    pub conversation_id: String,
    /// Messages a rollback removed from the transcript before the run started.
    pub removed_messages: usize,
}

/// A session whose queue a restart left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedHarnessSession {
    pub session_id: String,
    /// The conversation belongs to a person or org, so a queued run cannot be
    /// dispatched without its author's verified credentials.
    pub attributed: bool,
}

/// Append `run_started` + `input_accepted` after `current_seq` and advance the
/// run's cursor. Shared by immediate starts and queue promotion so both emit
/// the same start boundary.
#[allow(clippy::too_many_arguments)]
fn append_run_start_events(
    tx: &rusqlite::Transaction<'_>,
    cipher: &ryu_crypto::FieldCipher,
    run_id: &str,
    session_id: &str,
    current_seq: u64,
    now: i64,
    execution_profile: ExecutionProfile,
    input_hash: String,
    message_count: u32,
) -> Result<Vec<RunEventEnvelope>> {
    let started = build_harness_event(
        run_id,
        session_id,
        current_seq + 1,
        now,
        RunEvent::RunStarted { execution_profile },
    );
    let accepted = build_harness_event(
        run_id,
        session_id,
        current_seq + 2,
        now,
        RunEvent::InputAccepted {
            input_hash,
            message_count,
        },
    );
    insert_harness_event(tx, cipher, &started)?;
    insert_harness_event(tx, cipher, &accepted)?;
    tx.execute(
        "UPDATE harness_runs SET event_seq = ?1 WHERE id = ?2",
        params![i64::try_from(current_seq + 2).unwrap_or(i64::MAX), run_id],
    )?;
    Ok(vec![started, accepted])
}

/// Remove the transcript turns a displaced run wrote: every message of the
/// session's conversation created at or after the run started and before the
/// next run of the session started. Harness runs of one session are serialized,
/// so that window belongs to the displaced run; turns of a run that ran in
/// between (a queued interrupt that completed before this rollback was
/// promoted) are outside it and stay.
/// When the conversation is branched and its active leaf was removed, the leaf
/// moves to the parent of the earliest removed message. Returns removed ids.
fn rollback_harness_run_turns_locked(
    tx: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    rolled_back_run_id: &str,
) -> Result<Vec<String>> {
    let started_at: Option<Option<i64>> = tx
        .query_row(
            "SELECT started_at FROM harness_runs WHERE id = ?1",
            params![rolled_back_run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(Some(started_at)) = started_at else {
        return Ok(Vec::new());
    };
    // The window closes when the next run of the same session started (the
    // run being promoted has no `started_at` yet, so it never closes it).
    let window_end: i64 = tx.query_row(
        "SELECT COALESCE(MIN(next.started_at), ?3) FROM harness_runs AS next
         WHERE next.session_id = (SELECT session_id FROM harness_runs WHERE id = ?1)
           AND next.id != ?1 AND next.started_at IS NOT NULL AND next.started_at > ?2",
        params![rolled_back_run_id, started_at, i64::MAX],
        |row| row.get(0),
    )?;
    let removed: Vec<(String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT id, parent_message_id FROM messages
             WHERE conversation_id = ?1 AND created_at >= ?2 AND created_at < ?3
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, started_at, window_end], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if removed.is_empty() {
        return Ok(Vec::new());
    }
    let active_leaf: Option<String> = tx
        .query_row(
            "SELECT active_leaf_message_id FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let ids: Vec<String> = removed.iter().map(|(id, _)| id.clone()).collect();
    if active_leaf
        .as_deref()
        .is_some_and(|leaf| ids.iter().any(|id| id == leaf))
    {
        let new_leaf = removed.first().and_then(|(_, parent)| parent.clone());
        tx.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1 WHERE id = ?2",
            params![new_leaf, conversation_id],
        )?;
    }
    for id in &ids {
        tx.execute(
            "DELETE FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
        tx.execute(
            "DELETE FROM message_reactions WHERE message_id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
        tx.execute(
            "DELETE FROM message_read_receipts WHERE message_id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )?;
    }
    Ok(ids)
}

#[derive(Debug)]
struct HarnessRunDbRow {
    id: String,
    session_id: String,
    parent_run_id: Option<String>,
    status: String,
    attempt: i64,
    idempotency_key: Option<String>,
    execution_profile: String,
    #[allow(dead_code)]
    input_json: String,
    output_json: Option<String>,
    error: Option<String>,
    event_seq: i64,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    multitask_strategy: Option<String>,
}

fn read_harness_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HarnessRunDbRow> {
    Ok(HarnessRunDbRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        parent_run_id: row.get(2)?,
        status: row.get(3)?,
        attempt: row.get(4)?,
        idempotency_key: row.get(5)?,
        execution_profile: row.get(6)?,
        input_json: row.get(7)?,
        output_json: row.get(8)?,
        error: row.get(9)?,
        event_seq: row.get(10)?,
        created_at: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        multitask_strategy: row.get(14)?,
    })
}

fn decode_harness_run(
    cipher: &ryu_crypto::FieldCipher,
    row: HarnessRunDbRow,
) -> Result<HarnessRun> {
    let output = row
        .output_json
        .map(|value| cipher.open(&value))
        .transpose()?
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(HarnessRun {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        id: row.id,
        session_id: row.session_id,
        status: HarnessRunStatus::from_str(&row.status),
        attempt: u32::try_from(row.attempt.max(0)).unwrap_or(u32::MAX),
        idempotency_key: row.idempotency_key,
        parent_run_id: row.parent_run_id,
        execution_profile: parse_execution_profile(&row.execution_profile),
        event_cursor: u64::try_from(row.event_seq.max(0)).unwrap_or(u64::MAX),
        created_at: millis_to_rfc3339(row.created_at),
        started_at: row.started_at.map(millis_to_rfc3339),
        finished_at: row.finished_at.map(millis_to_rfc3339),
        // Sealed since phase 2; legacy plaintext passes through.
        error: row.error.map(|value| cipher.open(&value)).transpose()?,
        output,
        multitask_strategy: row
            .multitask_strategy
            .as_deref()
            .map(MultitaskStrategy::from_str),
    })
}

fn insert_harness_event(
    tx: &rusqlite::Transaction<'_>,
    cipher: &ryu_crypto::FieldCipher,
    envelope: &RunEventEnvelope,
) -> Result<()> {
    tx.execute(
        "INSERT INTO harness_run_events (id, run_id, seq, created_at, event_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            envelope.id,
            envelope.run_id,
            i64::try_from(envelope.seq).unwrap_or(i64::MAX),
            rfc3339_to_millis(&envelope.created_at),
            cipher.seal(&serde_json::to_string(envelope)?)?,
        ],
    )?;
    Ok(())
}

fn build_harness_event(
    run_id: &str,
    session_id: &str,
    seq: u64,
    now: i64,
    event: RunEvent,
) -> RunEventEnvelope {
    RunEventEnvelope {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        id: format!("evt_{}", uuid::Uuid::new_v4().simple()),
        run_id: run_id.to_owned(),
        session_id: session_id.to_owned(),
        seq,
        created_at: millis_to_rfc3339(now),
        event,
    }
}

fn harness_message_count(input: &serde_json::Value) -> u32 {
    let count = if let Some(messages) = input.get("messages").and_then(serde_json::Value::as_array)
    {
        messages.len()
    } else if let Some(messages) = input.as_array() {
        messages.len()
    } else if input.get("prompt").is_some() {
        1
    } else {
        0
    };
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn parse_execution_profile(raw: &str) -> ExecutionProfile {
    serde_json::from_str(raw).unwrap_or_else(|error| {
        tracing::warn!(error = %error, "invalid stored harness execution profile; using safe defaults");
        ExecutionProfile::default()
    })
}

fn harness_status_from_legacy(status: &SessionStatus) -> HarnessRunStatus {
    match status {
        SessionStatus::Idle => HarnessRunStatus::Pending,
        SessionStatus::Running => HarnessRunStatus::Running,
        SessionStatus::Completed => HarnessRunStatus::Completed,
        SessionStatus::Failed => HarnessRunStatus::Failed,
    }
}

fn millis_to_rfc3339(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn rfc3339_to_millis(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .unwrap_or_else(|_| now_millis())
}

/// Parse a stored `runnable_kind` string back to a [`RunnableKind`].
/// Unknown strings default to `Agent` (the most common kind in practice).
fn parse_runnable_kind(s: &str) -> RunnableKind {
    match s {
        "workflow" => RunnableKind::Workflow,
        "tool" => RunnableKind::Tool,
        "skill" => RunnableKind::Skill,
        _ => RunnableKind::Agent,
    }
}

/// Upper bound on pull requests explicitly linked to one conversation.
pub const MAX_LINKED_PULL_REQUESTS: usize = 20;

/// Normalize a GitHub pull request URL to `https://github.com/<owner>/<repo>/pull/<n>`.
/// Returns `None` for anything that is not a GitHub pull request link.
pub fn normalize_pull_request_url(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("https://github.com/")?;
    let mut segments = rest.split(['/', '?', '#']);
    let owner = segments.next().filter(|s| is_github_name(s))?;
    let repo = segments.next().filter(|s| is_github_name(s))?;
    if !matches!(segments.next(), Some("pull" | "pulls")) {
        return None;
    }
    let number = segments
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)?;
    Some(format!("https://github.com/{owner}/{repo}/pull/{number}"))
}

fn is_github_name(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 100
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Parse a JSON array of strings (agent ids in `participants`, pull request
/// URLs in `linked_pull_requests`). Returns an empty vec on null/empty/malformed
/// input.
fn parse_participants_json(json: Option<&str>) -> Vec<String> {
    json.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Build a short conversation title from the first user message: its first line,
/// capped at 60 chars. This is the DEFAULT title every chat gets the moment it is
/// persisted — no plugin involved — so a thread reads as what the user actually
/// asked instead of a placeholder while the LLM rename is still pending.
///
/// `None` for a turn with no text (an image- or file-only opener). Returning a
/// literal placeholder here would be worse than nothing: the upsert COALESCEs
/// (`COALESCE(conversations.title, excluded.title)`), so a placeholder written
/// once wins over every later derivation and only an LLM rename could displace
/// it. A NULL title lets the next user turn title the thread.
///
/// The client mirrors this rule (`deriveDraftTitle` in the desktop's chat history
/// context) so the sidebar can show the same string immediately on send, without
/// waiting for the round trip. Change one, change the other.
fn derive_title(content: &str) -> Option<String> {
    const MAX: usize = 60;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.is_empty() {
        return None;
    }
    if first_line.chars().count() <= MAX {
        return Some(first_line.to_owned());
    }
    let truncated: String = first_line.chars().take(MAX).collect();
    Some(format!("{truncated}…"))
}

/// Longest message preview served on a conversation summary, in characters.
const PREVIEW_MAX_CHARS: usize = 140;

/// Flatten a message body into the single line a messaging-style row shows.
/// Newlines collapse to spaces (a two-line row must not grow), runs of
/// whitespace collapse with them, and the result is capped at
/// [`PREVIEW_MAX_CHARS`] so a 40 KB tool dump does not travel to the sidebar.
///
/// Unlike [`derive_title`] this keeps the *whole* message flattened rather than
/// only its first line: an assistant reply whose first line is a bare "```rust"
/// would otherwise preview as nothing readable.
fn preview_line(content: &str) -> String {
    let flattened = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= PREVIEW_MAX_CHARS {
        return flattened;
    }
    let truncated: String = flattened.chars().take(PREVIEW_MAX_CHARS).collect();
    format!("{truncated}…")
}

/// Test-only conveniences.
///
/// `append_message` has ~55 call sites, nearly all of them tests that model an
/// unbound personal node. Rather than churn them, the pre-tenancy signature lives
/// on **only** in `cfg(test)`, hard-wired to [`Tenancy::Unattributed`]. Production
/// code therefore has exactly one entry point — [`ConversationStore::append_message_as`],
/// which cannot be called without choosing a `Tenancy`. A production caller that
/// forgets fails `cargo check` (not `cargo test`), which is the whole point.
#[cfg(test)]
impl ConversationStore {
    pub(crate) async fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        agent_id: Option<&str>,
        author_user_id: Option<&str>,
        author_name: Option<&str>,
    ) -> Result<String> {
        self.append_message_as(
            conversation_id,
            role,
            content,
            agent_id,
            author_user_id,
            author_name,
            Tenancy::Unattributed,
        )
        .await
    }
}

#[cfg(test)]
#[path = "conversations/render_history_tests.rs"]
mod render_history_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_request_urls_normalize_to_canonical_github_links() {
        assert_eq!(
            normalize_pull_request_url(" https://github.com/acme/app/pull/42/files?x=1 "),
            Some("https://github.com/acme/app/pull/42".to_owned())
        );
        assert_eq!(
            normalize_pull_request_url("https://github.com/acme/app/pulls/7"),
            Some("https://github.com/acme/app/pull/7".to_owned())
        );
        // Shared with the desktop's `parsePullRequestUrl` parity test
        // (apps/desktop/src/lib/api/pull-request-feedback.test.ts).
        assert_eq!(
            normalize_pull_request_url("https://github.com/acme/app/pull/42#discussion"),
            Some("https://github.com/acme/app/pull/42".to_owned())
        );
        assert_eq!(
            normalize_pull_request_url("https://github.com/acme/app/pull/007"),
            Some("https://github.com/acme/app/pull/7".to_owned())
        );
        for rejected in [
            "http://github.com/acme/app/pull/1",
            "https://github.com/acme/app/issues/1",
            "https://github.com/acme/app/pull/0",
            "https://github.com/acme/../pull/1",
            "https://evil.example/acme/app/pull/1",
            "https://github.com/acme/./pull/1",
            "https://github.com//app/pull/1",
            "https://github.com/acme/app/pull/",
            "https://github.com/acme/app/pull/42abc",
            "https://github.com/acme/app/pull/-1",
            "https://github.com.evil.example/acme/app/pull/1",
        ] {
            assert_eq!(normalize_pull_request_url(rejected), None, "{rejected}");
        }
    }

    #[tokio::test]
    async fn linked_pull_requests_round_trip_through_listing() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("chat", Some("claude"), None, Tenancy::Unattributed)
            .await
            .unwrap();
        let first = "https://github.com/acme/app/pull/1";
        let second = "https://github.com/acme/api/pull/2";
        store
            .set_pull_request_linked("chat", first, true)
            .await
            .unwrap();
        store
            .set_pull_request_linked("chat", second, true)
            .await
            .unwrap();
        // Re-linking is idempotent and moves nothing but order.
        let linked = store
            .set_pull_request_linked("chat", first, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(linked, vec![second.to_owned(), first.to_owned()]);
        let listed = store.list_conversations().await.unwrap();
        assert_eq!(listed[0].linked_pull_requests, linked);
        let unlinked = store
            .set_pull_request_linked("chat", second, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unlinked, vec![first.to_owned()]);
        assert!(store
            .set_pull_request_linked("missing", first, true)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn linked_pull_requests_are_capped_per_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("chat", Some("claude"), None, Tenancy::Unattributed)
            .await
            .unwrap();
        for number in 1..=MAX_LINKED_PULL_REQUESTS {
            store
                .set_pull_request_linked(
                    "chat",
                    &format!("https://github.com/acme/app/pull/{number}"),
                    true,
                )
                .await
                .unwrap();
        }
        let over = format!(
            "https://github.com/acme/app/pull/{}",
            MAX_LINKED_PULL_REQUESTS + 1
        );
        assert!(store
            .set_pull_request_linked("chat", &over, true)
            .await
            .is_err());
        // Re-linking an existing URL at the cap only reorders it.
        let relinked = store
            .set_pull_request_linked("chat", "https://github.com/acme/app/pull/1", true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(relinked.len(), MAX_LINKED_PULL_REQUESTS);
        assert_eq!(
            relinked.last().map(String::as_str),
            Some("https://github.com/acme/app/pull/1")
        );
    }

    #[tokio::test]
    async fn imported_messages_cannot_cross_a_recreated_conversation_generation() {
        let store = ConversationStore::open_in_memory().unwrap();
        let old = store
            .ensure_conversation_with_generation(
                "chat",
                Some("claude"),
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        store
            .set_import_source("chat", "import:claude", Some("native-old"))
            .await
            .unwrap();
        let identity = store
            .find_imported_conversation_with_generation(
                "import:claude",
                "native-old",
                &Tenancy::Unattributed,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(identity, ("chat".to_owned(), old.clone()));
        store
            .append_imported_message_at(
                "chat",
                &old,
                "user",
                "legitimate import",
                Some("claude"),
                Tenancy::Unattributed,
                Some(1),
            )
            .await
            .unwrap();
        store
            .conn
            .lock()
            .await
            .execute("DELETE FROM conversations WHERE id = 'chat'", [])
            .unwrap();
        let new = store
            .ensure_conversation_with_generation(
                "chat",
                Some("claude"),
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        assert_ne!(old, new);
        let before = store.get_messages("chat").await.unwrap().len();
        assert!(store
            .append_imported_message_at(
                "chat",
                &old,
                "user",
                "prior native transcript",
                Some("claude"),
                Tenancy::Unattributed,
                Some(1)
            )
            .await
            .is_err());
        assert_eq!(store.get_messages("chat").await.unwrap().len(), before);
        store
            .append_imported_message_at(
                "chat",
                &new,
                "user",
                "current import",
                Some("claude"),
                Tenancy::Unattributed,
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(store.get_messages("chat").await.unwrap().len(), before + 1);
    }

    #[tokio::test]
    async fn channel_sessions_are_org_shared_and_machine_marked() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_channel_conversation(
                "channel:bot-1:chat-1",
                "bot-1",
                Some("agent-1"),
                Some("org-1"),
            )
            .await
            .unwrap();

        assert!(store
            .is_channel_conversation("channel:bot-1:chat-1")
            .await
            .unwrap());
        let meta = store
            .get_access_meta("channel:bot-1:chat-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(meta.owner_user_id, None);
        assert_eq!(meta.org_id.as_deref(), Some("org-1"));
        assert_eq!(meta.visibility, "org");
    }

    #[tokio::test]
    async fn imported_conversation_dedup_is_scoped_to_creation_tenancy() {
        let store = ConversationStore::open_in_memory().unwrap();
        let origin = "import:claude";
        let native_id = "native-session-1";

        store
            .ensure_conversation(
                "alice-import",
                Some("agent-claude"),
                Some("Alice"),
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org1".to_owned()),
                },
            )
            .await
            .unwrap();
        store
            .set_import_source("alice-import", origin, Some(native_id))
            .await
            .unwrap();

        store
            .ensure_conversation(
                "shared-import",
                Some("agent-claude"),
                Some("Shared"),
                Tenancy::SharedOrg {
                    org_id: "org1".to_owned(),
                },
            )
            .await
            .unwrap();
        store
            .set_import_source("shared-import", origin, Some(native_id))
            .await
            .unwrap();

        let alice = Tenancy::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let bob = Tenancy::Owned {
            user_id: "bob".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let shared = Tenancy::SharedOrg {
            org_id: "org1".to_owned(),
        };

        assert_eq!(
            store
                .find_imported_conversation(origin, native_id, &alice)
                .await
                .unwrap(),
            Some("alice-import".to_owned())
        );
        assert_eq!(
            store
                .find_imported_conversation(origin, native_id, &bob)
                .await
                .unwrap(),
            None,
            "Bob must never deduplicate into Alice's private import"
        );
        assert_eq!(
            store
                .find_imported_conversation(origin, native_id, &shared)
                .await
                .unwrap(),
            Some("shared-import".to_owned())
        );
        assert_eq!(
            store
                .find_imported_conversation(origin, native_id, &Tenancy::Unattributed)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn private_import_access_is_checked_before_reuse() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation(
                "alice-private-import",
                Some("agent-claude"),
                Some("Alice"),
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org1".to_owned()),
                },
            )
            .await
            .unwrap();
        store
            .set_import_source(
                "alice-private-import",
                "import:claude",
                Some("native-session-2"),
            )
            .await
            .unwrap();

        let bob = crate::identity_verify::VerifiedCaller {
            user_id: "bob".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        };
        let bob_tenancy = Tenancy::Owned {
            user_id: bob.user_id.clone(),
            org_id: bob.org_id.clone(),
        };

        assert_eq!(
            store
                .find_imported_conversation("import:claude", "native-session-2", &bob_tenancy)
                .await
                .unwrap(),
            None,
            "a different caller cannot reuse the private import key"
        );
        assert!(
            crate::server::require_resource_write(
                store.get_access_meta("alice-private-import").await,
                Some(&bob),
                "conversation not found",
            )
            .is_err(),
            "the canonical conversation gate must deny Bob before message access"
        );
    }

    #[tokio::test]
    async fn agent_control_is_conversation_scoped_and_consumed_once() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation(
                "control-conversation",
                Some("caller-agent"),
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();

        let pending = crate::agent_control::PendingAgentControl {
            patch: crate::agent_control::AgentControlPatch {
                agent_id: Some("better-agent".to_owned()),
                clear_agent_id: false,
                model: Some("strong-model".to_owned()),
                clear_model: false,
                effort: Some("high".to_owned()),
                clear_effort: false,
            },
            requested_by: "caller-agent".to_owned(),
            requested_at: 123,
        };
        store
            .set_pending_agent_control("control-conversation", &pending)
            .await
            .unwrap();

        assert!(store
            .is_conversation_agent("control-conversation", "caller-agent")
            .await
            .unwrap());
        assert!(!store
            .is_conversation_agent("control-conversation", "other-agent")
            .await
            .unwrap());
        assert_eq!(
            store
                .take_pending_agent_control("control-conversation")
                .await
                .unwrap(),
            Some(pending)
        );
        assert!(store
            .take_pending_agent_control("control-conversation")
            .await
            .unwrap()
            .is_none());

        let clear_pending = crate::agent_control::PendingAgentControl {
            patch: crate::agent_control::AgentControlPatch {
                agent_id: None,
                clear_agent_id: false,
                model: None,
                clear_model: true,
                effort: None,
                clear_effort: true,
            },
            requested_by: "caller-agent".to_owned(),
            requested_at: 456,
        };
        store
            .set_pending_agent_control("control-conversation", &clear_pending)
            .await
            .unwrap();
        assert_eq!(
            store
                .take_pending_agent_control("control-conversation")
                .await
                .unwrap(),
            Some(clear_pending)
        );
    }

    #[tokio::test]
    async fn verified_widget_provenance_survives_message_reload() {
        let store = ConversationStore::open_in_memory().unwrap();
        let provenance = MessageProvenance {
            source: "widget".to_owned(),
            widget_instance_id: "wgt_server_minted".to_owned(),
            origin_server: "com.example.weather".to_owned(),
        };

        store
            .append_message_as_with_provenance(
                "widget-conversation",
                "user",
                "What is the weather?",
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(&provenance),
            )
            .await
            .unwrap();

        // The normal conversation read is the reload/render path. The
        // attribution must come from the persisted server columns, remain bound
        // to this conversation row, and never appear in another thread.
        let reloaded = store
            .get_conversation_detail("widget-conversation")
            .await
            .unwrap()
            .unwrap();
        let message = &reloaded.messages[0];
        assert_eq!(reloaded.id, "widget-conversation");
        assert_eq!(message.source.as_deref(), Some("widget"));
        assert_eq!(
            message.widget_instance_id.as_deref(),
            Some("wgt_server_minted")
        );
        assert_eq!(
            message.origin_server.as_deref(),
            Some("com.example.weather")
        );
        assert!(store
            .get_messages("different-conversation")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn conversation_visibility_controls_visible_summaries_and_previews() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("alice-chat", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message(
                "alice-chat",
                "user",
                "shared roadmap",
                None,
                Some("alice"),
                None,
            )
            .await
            .unwrap();

        let bob_private = store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        assert!(bob_private.is_empty());

        assert!(store
            .set_visibility("alice-chat", "org", None, true)
            .await
            .unwrap());
        let bob_shared = store
            .list_conversations_visible_with_preview(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        assert_eq!(bob_shared.len(), 1);
        assert_eq!(bob_shared[0].visibility, "org");
        assert_eq!(
            bob_shared[0].last_message.as_deref(),
            Some("shared roadmap")
        );

        let meta = store
            .get_access_meta("alice-chat")
            .await
            .unwrap()
            .expect("conversation ACL metadata");
        assert_eq!(meta.visibility, "org");

        assert!(store
            .set_visibility("alice-chat", "private", None, false)
            .await
            .is_err());
        assert!(store
            .set_visibility("alice-chat", "private", None, true)
            .await
            .unwrap());
        assert!(store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .set_visibility("alice-chat", "team", None, true)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn direct_conversation_grants_are_atomic_and_org_scoped() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("direct-chat", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message(
                "direct-chat",
                "user",
                "private roadmap",
                None,
                Some("alice"),
                None,
            )
            .await
            .unwrap();
        let collaborators = vec![
            ConversationCollaborator {
                user_id: "bob".to_owned(),
                role: "viewer".to_owned(),
            },
            ConversationCollaborator {
                user_id: "carol".to_owned(),
                role: "participant".to_owned(),
            },
        ];
        assert!(store
            .set_access("direct-chat", "private", None, &collaborators, true)
            .await
            .unwrap());

        let bob_visible = store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        assert_eq!(bob_visible.len(), 1);
        assert!(store
            .list_conversations_visible(Some("bob"), Some("org2"), true)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store.list_collaborators("direct-chat").await.unwrap(),
            collaborators
        );
        let meta = store.get_access_meta("direct-chat").await.unwrap().unwrap();
        assert_eq!(meta.collaborators.len(), 2);
        assert_eq!(
            meta.collaborators[0].access,
            crate::identity_verify::Access::Read
        );
        assert_eq!(
            meta.collaborators[1].access,
            crate::identity_verify::Access::Write
        );

        let duplicates = vec![collaborators[0].clone(), collaborators[0].clone()];
        assert!(store
            .set_access("direct-chat", "org", None, &duplicates, true)
            .await
            .is_err());
        assert_eq!(
            store.list_collaborators("direct-chat").await.unwrap(),
            collaborators
        );
        assert_eq!(
            store
                .get_access_meta("direct-chat")
                .await
                .unwrap()
                .unwrap()
                .visibility,
            "private"
        );
    }

    #[tokio::test]
    async fn team_visibility_requires_verified_team_membership_for_list_preview_and_search() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("team-chat", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message(
                "team-chat",
                "user",
                "team-only roadmap",
                None,
                Some("alice"),
                None,
            )
            .await
            .unwrap();
        store
            .set_visibility("team-chat", "team", Some("team-alpha"), true)
            .await
            .unwrap();

        // Same-org membership alone is not enough for a team-scoped row. The
        // compatibility wrapper intentionally passes no team ids, matching an
        // authenticated caller whose JWT predates team claims.
        assert!(store
            .list_conversations_visible_with_preview(Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .visible_conversation_ids(Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .is_empty());

        let team_ids = Some(r#"["team-alpha"]"#);
        let visible = store
            .list_conversations_visible_with_preview_for_teams(
                Some("bob"),
                Some("org1"),
                true,
                team_ids,
            )
            .await
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(
            visible[0].last_message.as_deref(),
            Some("team-only roadmap")
        );
        assert_eq!(
            store
                .visible_conversation_ids_for_teams(Some("bob"), Some("org1"), true, team_ids)
                .await
                .unwrap(),
            vec!["team-chat".to_owned()]
        );
    }

    /// **The choke-point acceptance test** (task item 1).
    ///
    /// Reads this very source file and asserts there is exactly ONE
    /// `INSERT INTO conversations` outside the test module — [`upsert_conversation_row`],
    /// which always emits the tenancy clause. A future creation path that hand-rolls
    /// its own INSERT (and therefore could forget to stamp an owner, locking that
    /// owner out of their own chat on an org-bound node) fails HERE, in CI, rather
    /// than silently in production.
    #[test]
    fn exactly_one_insert_into_conversations_in_the_whole_store() {
        // Normalize CRLF first: on a Windows checkout `include_str!` sees `\r\n`,
        // and an un-normalized marker miss would silently scan the test module too.
        let src = include_str!("conversations.rs").replace("\r\n", "\n");
        let test_mod = src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("test-module marker must exist in this very file");
        let production = &src[..test_mod];
        // Matches every row-creating form, not just the one that exists today, so a
        // future `INSERT OR IGNORE` / `INSERT OR REPLACE` / `REPLACE INTO` cannot slip
        // a second, un-stamping creation path past this guard.
        let hits: Vec<&str> = production
            .lines()
            .map(str::trim)
            .filter(|l| {
                let l = l.trim_start_matches('"');
                (l.starts_with("INSERT") || l.starts_with("REPLACE"))
                    && l.contains("INTO conversations")
            })
            .collect();
        assert_eq!(
            hits.len(),
            1,
            "every conversation row must be created by the ONE choke point \
             (upsert_conversation_row), which always stamps tenancy; found {} raw INSERTs: {hits:?}",
            hits.len()
        );
    }

    /// The choke point's tenancy clause must be preserve-not-clobber AND
    /// first-writer-wins. Asserted on the SQL text so a future edit that flips a
    /// COALESCE direction (which would either wipe a claimed owner — re-opening the
    /// leak — or let a row be re-tenanted — enabling theft) fails loudly.
    #[test]
    fn the_choke_point_always_coalesces_tenancy() {
        let src = include_str!("conversations.rs");
        assert!(src.contains(
            "owner_user_id = COALESCE(conversations.owner_user_id, excluded.owner_user_id)"
        ));
        assert!(src.contains("org_id        = COALESCE(conversations.org_id, excluded.org_id)"));
    }

    /// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
    ///
    /// The `ResourceKey` composition layer must lower to a `Tenancy` whose `parts()`
    /// are byte-identical to the pre-ResourceKey construction, for every case the
    /// choke point can see — including the load-bearing collapse (an unattributed
    /// key yields `(None, None)`, the row an UNBOUND node writes, so no offline
    /// lockout regresses). The compound `node`/`project`/`session` address composes
    /// but never alters the emitted pair.
    #[test]
    fn resource_key_lowers_to_identical_tenancy_parts() {
        // Every (user, org) shape a caller can hand in — the derived Tenancy's
        // parts must equal the direct `owned_by` construction exactly.
        for (user, org) in [
            (Some("u1"), Some("acme")),
            (Some("u1"), None),
            (None, None),
            // org-only in ⇒ collapses to fully unattributed (the pair the SQL has
            // never seen is never produced).
            (None, Some("acme")),
        ] {
            let via_key = Tenancy::from_resource_key(&ResourceKey::owned(user, org));
            let direct = Tenancy::owned_by(user, org);
            assert_eq!(
                via_key.parts(),
                direct.parts(),
                "ResourceKey lowering must match owned_by for ({user:?}, {org:?})"
            );
        }

        // The UNBOUND-node row: an unattributed key is byte-identical to
        // `Tenancy::Unattributed` and writes `(None, None)` — the invariant that
        // keeps an offline/personal node from ever locking its owner out.
        let unbound = Tenancy::from_resource_key(&ResourceKey::unattributed());
        assert_eq!(unbound, Tenancy::Unattributed);
        assert_eq!(unbound.parts(), (None, None));

        // Compound address composes above the collapse but never changes the pair
        // the choke point stamps.
        let compound = ResourceKey::owned(Some("u1"), Some("acme"))
            .with_session(Some("conv-9"))
            .with_project(Some("/proj"));
        assert_eq!(
            Tenancy::from_resource_key(&compound).parts(),
            Tenancy::owned_by(Some("u1"), Some("acme")).parts()
        );

        // Round-trip: Tenancy → ResourceKey → Tenancy is stable.
        let t = Tenancy::Owned {
            user_id: "u1".into(),
            org_id: Some("acme".into()),
        };
        assert_eq!(Tenancy::from_resource_key(&t.to_resource_key()), t);
    }

    /// **Principal resolution with/without a host conversation id (task C2,
    /// deliverable #2).** Locks the headline behavior the gateway-exec threading
    /// rests on: an org-bound node resolves `Owned` from a tenanted host
    /// conversation (the id the Gateway now forwards), fails closed to `Unresolved`
    /// without one, and — the load-bearing no-lockout invariant — resolves
    /// `Unrestricted` on an UNBOUND node regardless. `resolve_at` was previously
    /// untested; this is the first assertion over it.
    #[tokio::test]
    async fn tool_principal_resolves_from_host_conversation() {
        use crate::sidecar::mcp::ToolPrincipal;
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation(
                "c1",
                None,
                None,
                Tenancy::Owned {
                    user_id: "u1".into(),
                    org_id: Some("acme".into()),
                },
            )
            .await
            .unwrap();

        // BOUND node + host conversation with an owner ⇒ Owned: the forwarded id
        // resolves the principal (the gateway-exec headline).
        assert!(matches!(
            ToolPrincipal::resolve_at(&store, Some("c1"), Some("acme")).await,
            ToolPrincipal::Owned { user_id, org_id }
                if user_id == "u1" && org_id.as_deref() == Some("acme")
        ));

        // BOUND node, NO host conversation ⇒ fail-closed Unresolved ("without id").
        assert_eq!(
            ToolPrincipal::resolve_at(&store, None, Some("acme")).await,
            ToolPrincipal::Unresolved
        );

        // BOUND node + host conversation that is itself untenanted ⇒ Unresolved
        // (no owner to attribute the tool call to; fail closed).
        store
            .ensure_conversation("c-null", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        assert_eq!(
            ToolPrincipal::resolve_at(&store, Some("c-null"), Some("acme")).await,
            ToolPrincipal::Unresolved
        );

        // UNBOUND node ⇒ Unrestricted regardless of the id — the invariant that
        // keeps a personal/offline node from ever locking its owner out.
        assert_eq!(
            ToolPrincipal::resolve_at(&store, Some("c1"), None).await,
            ToolPrincipal::Unrestricted
        );
        assert_eq!(
            ToolPrincipal::resolve_at(&store, None, None).await,
            ToolPrincipal::Unrestricted
        );
    }

    #[tokio::test]
    async fn append_message_publishes_live_event_to_room() {
        // The make-or-break wiring: a store sharing the SAME registry instance a
        // viewer subscribes against must deliver a `message` Events frame on every
        // persisted turn, shaped to match the GET read path (plaintext content,
        // role, ids, created_at). This is the only way to catch a "wrong registry
        // instance" regression without a live WS client.
        let registry = ryu_realtime::RoomRegistry::new();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_realtime(registry.clone());

        // A subscribed viewer makes the room live (publish is a no-op otherwise).
        let mut rx = registry.get_or_create("conv-live").subscribe();

        let id = store
            .append_message(
                "conv-live",
                "user",
                "hello live",
                None,
                Some("user-7"),
                None,
            )
            .await
            .unwrap();

        let frame = rx.recv().await.expect("frame delivered");
        // The message fan-out now rides the typed-event envelope
        // (`broadcast_event` → `Frame::Event({__ryu_event, data})`), so a raw
        // subscriber sees the payload nested under `data`. Decode it the way the
        // typed contract intends and assert against the payload.
        let event = ryu_realtime::Event::decode(&frame).expect("a typed Event frame");
        assert_eq!(event.name, "conversation.message");
        let value = &event.payload;
        assert_eq!(value["type"], "message");
        assert_eq!(value["conversation_id"], "conv-live");
        assert_eq!(value["message"]["id"], id);
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "hello live");
        assert_eq!(value["message"]["author_user_id"], "user-7");
        assert!(value["message"]["created_at"].is_i64());
    }

    #[tokio::test]
    async fn append_message_without_realtime_is_silent() {
        // Unwired store (tests/CLI) must persist exactly as before — no panic, no
        // dependency on a registry.
        let store = ConversationStore::open_in_memory().unwrap();
        let id = store
            .append_message("c-silent", "user", "hi", None, None, None)
            .await
            .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn search_messages_none_without_index() {
        // No index wired (open_in_memory) → search returns None, never errors.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "hello world", None, None, None)
            .await
            .unwrap();
        let res = store.search_messages("hello", 5, None).await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn usage_metadata_pages_never_decrypt_bodies_or_return_conversation_parts() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("usage-fixture", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        let id = store
            .append_message_as(
                "usage-fixture",
                "assistant",
                "private body",
                Some("acp:codex"),
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        store.update_message_parts(&id, &serde_json::json!([
            {"type":"text","text":"private text part"},
            {"type":"data-ryu-stats","data":{"done":true,"promptTokens":10,"completionTokens":3,"used":100,"sessionCostAmount":50,"credential":"private credential","historyEventId":"ryu-turn:fixture"}}
        ]).to_string()).await.unwrap();
        store.content_reads.store(0, Ordering::Relaxed);
        let page = store.usage_metadata_page(0, 1).await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].5.len(), 1);
        assert_eq!(page[0].5[0]["promptTokens"], 10);
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
        let encoded = serde_json::to_string(&page).unwrap();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("sessionCostAmount"));
        assert!(!encoded.contains("\"used\""));
        assert!(store
            .usage_metadata_page(page[0].0, 1)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn search_backfill_warm_reads_only_new_imports_and_retries_after_reset() {
        let semantic = crate::search_host::in_memory_message_index().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(semantic)
            .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap());
        store
            .ensure_conversation("search-perf", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        // Raw inserts exercise the same trigger used by import/sync/fork, with
        // equal historical timestamps rather than an append-time watermark.
        {
            let conn = store.conn.lock().await;
            for number in 0..300 {
                conn.execute(
                    "INSERT INTO messages(id, conversation_id, role, content, created_at)
                     VALUES (?1, 'search-perf', 'user', 'searchable history', 1)",
                    [format!("history-{number}")],
                )
                .unwrap();
            }
        }
        store.set_chat_memory_enabled(true).await.unwrap();
        for lexical in [false, true] {
            let lock = if lexical {
                &store.fts_backfill
            } else {
                &store.semantic_backfill
            };
            let mut initialized = lock.lock().await;
            store.content_reads.store(0, Ordering::Relaxed);
            store
                .reconcile_search_index(lexical, &mut initialized)
                .await
                .unwrap();
            assert_eq!(store.content_reads.load(Ordering::Relaxed), 300);
            store.content_reads.store(0, Ordering::Relaxed);
            store
                .reconcile_search_index(lexical, &mut initialized)
                .await
                .unwrap();
            assert_eq!(
                store.content_reads.load(Ordering::Relaxed),
                0,
                "warm search reads no bodies"
            );
            if !lexical {
                {
                    let conn = store.conn.lock().await;
                    conn.execute("INSERT INTO message_search_pending(kind, message_id) VALUES (0, 'history-0')", []).unwrap();
                }
                store
                    .reconcile_search_index(false, &mut initialized)
                    .await
                    .unwrap();
                assert_eq!(
                    store.content_reads.load(Ordering::Relaxed),
                    0,
                    "successful append indexing is not repeated"
                );
                {
                    let conn = store.conn.lock().await;
                    conn.execute(
                        "UPDATE messages SET content = 'updated history' WHERE id = 'history-0'",
                        [],
                    )
                    .unwrap();
                }
                store
                    .reconcile_search_index(false, &mut initialized)
                    .await
                    .unwrap();
                assert_eq!(
                    store.content_reads.load(Ordering::Relaxed),
                    1,
                    "an edit still refreshes an existing embedding"
                );
            }
        }
        store
            .set_message_embedder(store.message_index.as_ref().unwrap().embedder())
            .await
            .unwrap();
        assert!(
            !*store.semantic_backfill.lock().await,
            "provider swaps invalidate reconciliation"
        );
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO messages(id, conversation_id, role, content, created_at)
                 VALUES ('late-import', 'search-perf', 'user', 'imported history', 0)",
                [],
            )
            .unwrap();
        }
        store.content_reads.store(0, Ordering::Relaxed);
        let hits = store
            .fts_search_messages("imported", 5, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "late-import");
        assert_eq!(
            store.content_reads.load(Ordering::Relaxed),
            2,
            "one backfill and one hit snippet"
        );
        store.clear_message_embeddings().await.unwrap();
        store.content_reads.store(0, Ordering::Relaxed);
        let mut initialized = store.semantic_backfill.lock().await;
        store
            .reconcile_search_index(false, &mut initialized)
            .await
            .unwrap();
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 301);
    }

    #[tokio::test]
    async fn search_same_width_provider_change_reindexes_acknowledged_history() {
        let index = crate::search_host::in_memory_message_index().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(index.clone());
        let id = store
            .append_message(
                "provider-change",
                "user",
                "retained history",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .search_messages("retained history", 5, None)
            .await
            .unwrap();
        let embedder = index.embedder();
        let vector = embedder.embed("retained history").await.unwrap();
        // Keep the existing vector width while simulating metadata written by
        // the previous provider. The pending queue was already acknowledged.
        index
            .index_message(&id, "provider-change", "user", &vector, "previous-model", 1)
            .await
            .unwrap();
        assert!(index
            .search("retained history", 5, None)
            .await
            .unwrap()
            .is_empty());
        // Settings/startup use this setter followed by the coordinated reindex.
        store.set_message_embedder(embedder.clone()).await.unwrap();
        assert_eq!(store.reindex_message_embeddings().await.unwrap(), 1);
        assert!(index
            .stale_ids(embedder.model_id(), embedder.dims())
            .await
            .unwrap()
            .is_empty());
        let hits = store
            .search_messages("retained history", 5, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, id);
        store.content_reads.store(0, Ordering::Relaxed);
        let mut initialized = store.semantic_backfill.lock().await;
        store
            .reconcile_search_index(false, &mut initialized)
            .await
            .unwrap();
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn search_pending_revisions_survive_stale_ack_and_remove_deleted_messages() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("queue", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO messages(id, conversation_id, role, content, created_at)
            VALUES ('revision', 'queue', 'user', 'before', 1)",
            [],
        )
        .unwrap();
        let revision: i64 = conn.query_row(
            "SELECT revision FROM message_search_pending WHERE kind = 0 AND message_id = 'revision'",
            [], |row| row.get(0),
        ).unwrap();
        conn.execute(
            "UPDATE messages SET content = 'after' WHERE id = 'revision'",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM message_search_pending WHERE revision = ?1",
            [revision],
        )
        .unwrap();
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_search_pending", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 2, "each index retains its newer pending revision");
        conn.execute("DELETE FROM messages WHERE id = 'revision'", [])
            .unwrap();
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_search_pending", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 0);
    }

    #[tokio::test]
    async fn search_backfill_query_uses_indexed_pending_ids_not_a_message_scan() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conn = store.conn.lock().await;
        let mut statement = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {MESSAGE_SEARCH_BATCH_SQL}"))
            .unwrap();
        let plan = statement
            .query_map(params![0, 0, 1000], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|step| step.contains("SEARCH p USING INDEX idx_message_search_pending_kind")),
            "{plan:?}"
        );
        assert!(
            plan.iter()
                .any(|step| step.contains("SEARCH m USING INDEX sqlite_autoindex_messages")),
            "{plan:?}"
        );
        assert!(!plan.iter().any(|step| step.contains("SCAN")), "{plan:?}");
    }

    #[tokio::test]
    async fn search_backfill_failed_metadata_read_stays_retryable_and_clones_share_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fts.db");
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(ryu_search::MessageFtsIndex::open(path.clone()).unwrap());
        store
            .append_message("failure", "user", "retryable message", None, None, None)
            .await
            .unwrap();
        store.set_chat_memory_enabled(true).await.unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("DROP TABLE fts_messages")
            .unwrap();
        assert!(store.fts_search_messages("missing", 5, None).await.is_err());
        assert!(
            !*store.fts_backfill.lock().await,
            "failed metadata read must not complete reconciliation"
        );
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
        // Reopening recreates the missing metadata table. Existing store clones
        // still share their connection and backfill owner across both requests.
        drop(ryu_search::MessageFtsIndex::open(path).unwrap());
        let clone = store.clone();
        let (first, second) = tokio::join!(
            store.fts_search_messages("missing", 5, None),
            clone.fts_search_messages("missing", 5, None),
        );
        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn search_backfill_reopen_recovers_pending_and_reconciles_existing_ids_once() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("conversations.db");
        let index_path = temp.path().join("message-fts.db");
        {
            let mut store = ConversationStore::open_in_memory()
                .unwrap()
                .with_message_fts_index(
                    ryu_search::MessageFtsIndex::open(index_path.clone()).unwrap(),
                );
            let conn = Connection::open(&database).unwrap();
            ConversationStore::init_schema(&conn).unwrap();
            store.conn = Arc::new(Mutex::new(conn));
            store
                .append_message(
                    "restart",
                    "user",
                    "indexed before restart",
                    None,
                    None,
                    None,
                )
                .await
                .unwrap();
            store.set_chat_memory_enabled(true).await.unwrap();
            store.fts_search_messages("indexed", 5, None).await.unwrap();
            // Simulate shutdown after persist but before the next backfill.
            store
                .append_message("restart", "user", "pending at shutdown", None, None, None)
                .await
                .unwrap();
        }
        let mut reopened = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(ryu_search::MessageFtsIndex::open(index_path).unwrap());
        let conn = Connection::open(database).unwrap();
        ConversationStore::init_schema(&conn).unwrap();
        reopened.conn = Arc::new(Mutex::new(conn));
        reopened.set_chat_memory_enabled(true).await.unwrap();
        let mut initialized = reopened.fts_backfill.lock().await;
        reopened
            .reconcile_search_index(true, &mut initialized)
            .await
            .unwrap();
        assert_eq!(
            reopened.content_reads.load(Ordering::Relaxed),
            1,
            "only the unacknowledged message is opened after restart"
        );
        reopened.content_reads.store(0, Ordering::Relaxed);
        reopened
            .reconcile_search_index(true, &mut initialized)
            .await
            .unwrap();
        assert_eq!(reopened.content_reads.load(Ordering::Relaxed), 0);
        drop(initialized);
        assert_eq!(
            reopened
                .fts_search_messages("shutdown", 5, None)
                .await
                .unwrap()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn search_messages_backfills_and_finds_existing() {
        // Wire an in-memory index, append messages, then search. Even if the
        // append-time spawned indexing hasn't run, the lazy backfill on the
        // first search embeds the stored (decrypted) messages and finds them.
        // Uses the local (network-free) embedder, so no embed sidecar is needed.
        let index = crate::search_host::in_memory_message_index().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(index);
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .append_message(
                "c1",
                "user",
                "rust ownership and lifetimes are tricky",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "c1",
                "assistant",
                "favourite pizza toppings list",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let hits = store
            .search_messages("rust lifetimes", 5, None)
            .await
            .unwrap()
            .expect("index wired");
        assert!(!hits.is_empty(), "expected a hit after backfill");
        assert!(
            hits[0].content.contains("ownership"),
            "rust message should rank first, got: {}",
            hits[0].content
        );
        // The decrypted snippet is returned (proves snippet re-read + cipher.open).
        assert!(hits[0].content.contains("lifetimes"));
    }

    #[tokio::test]
    async fn search_messages_opt_out_skips_search_and_backfill() {
        let index = crate::search_host::in_memory_message_index().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(index.clone());
        store
            .append_message("c1", "user", "private semantic content", None, None, None)
            .await
            .unwrap();

        let hits = store.search_messages("private", 5, None).await.unwrap();
        assert!(
            hits.is_none(),
            "opted-out semantic search must be unavailable"
        );
        assert!(
            index.indexed_ids().await.unwrap().is_empty(),
            "opted-out semantic search must not backfill the vector index"
        );
    }

    #[tokio::test]
    async fn fts_search_none_without_index() {
        // No FTS index wired (open_in_memory) → search returns None, never errors.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "hello world", None, None, None)
            .await
            .unwrap();
        let res = store.fts_search_messages("hello", 5, None).await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn fts_search_backfills_existing_and_returns_decrypted_snippet() {
        // Append messages to an FTS-wired store, then search. The inline lazy
        // backfill on the first search indexes the stored (decrypted) messages and
        // finds them — and the returned snippet is the decrypted plaintext, not the
        // sealed blob. Network-free (no embedder).
        let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index);
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .append_message(
                "c1",
                "user",
                "rust ownership and lifetimes are tricky",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "c2",
                "assistant",
                "favourite pizza toppings pepperoni",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let hits = store
            .fts_search_messages("pizza", 5, None)
            .await
            .unwrap()
            .expect("fts index wired");
        assert!(!hits.is_empty(), "expected a hit after backfill");
        assert_eq!(hits[0].conversation_id, "c2");
        // Proves snippet re-read + cipher.open (decrypted, not the sealed blob).
        assert!(hits[0].content.contains("pepperoni"));
        assert!(!hits[0].content.starts_with("enc:v1:"));
    }

    #[tokio::test]
    async fn learning_projection_excludes_structured_and_identity_fields() {
        let store = ConversationStore::open_in_memory().unwrap();
        let user_id = store
            .append_message(
                "learning-safe",
                "user",
                "question",
                None,
                Some("verified-user"),
                None,
            )
            .await
            .unwrap();
        let assistant_id = store
            .append_message(
                "learning-safe",
                "assistant",
                "answer",
                Some("agent-1"),
                None,
                None,
            )
            .await
            .unwrap();
        store
            .update_message_parts(
                &assistant_id,
                r#"[{"type":"tool","secret":"do-not-learn"}]"#,
            )
            .await
            .unwrap();

        let messages = store.get_learning_messages("learning-safe").await.unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, user_id);
        assert_eq!(messages[0].content, "question");
        assert_eq!(messages[1].id, assistant_id);
        assert_eq!(messages[1].agent_id.as_deref(), Some("agent-1"));
        assert_eq!(messages[1].content, "answer");

        // The general read still has the identity/structured fields, proving the
        // learning projection—not the fixture—is what excludes them.
        let general = store.get_messages("learning-safe").await.unwrap();
        assert_eq!(general[0].author_user_id.as_deref(), Some("verified-user"));
        assert!(general[1].parts.is_some());
    }

    #[tokio::test]
    async fn fts_search_scopes_to_conversation_ids() {
        let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index);
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .append_message("c1", "user", "alpha beta gamma", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c2", "user", "alpha beta gamma", None, None, None)
            .await
            .unwrap();
        let hits = store
            .fts_search_messages("alpha beta", 5, Some(&["c2".to_owned()]))
            .await
            .unwrap()
            .expect("fts index wired");
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.conversation_id == "c2"));
    }

    #[tokio::test]
    async fn fts_search_opt_out_skips_search_and_backfill() {
        let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index.clone());
        store
            .append_message("c1", "user", "private lexical content", None, None, None)
            .await
            .unwrap();

        let hits = store.fts_search_messages("private", 5, None).await.unwrap();
        assert!(hits.is_none(), "opted-out FTS search must be unavailable");
        assert!(
            index.indexed_ids().await.unwrap().is_empty(),
            "opted-out exact search must not backfill the FTS index"
        );
    }

    #[tokio::test]
    async fn message_content_is_encrypted_on_disk() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "my secret diary entry", None, None, None)
            .await
            .unwrap();

        // The stored column must be a sealed envelope, never the plaintext.
        let raw: String = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT content FROM messages WHERE conversation_id = ?1",
                params!["c1"],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            raw.starts_with("enc:v1:"),
            "expected sealed content, got {raw}"
        );
        assert!(!raw.contains("secret diary"));

        // And it round-trips transparently on read.
        let msgs = store.get_messages("c1").await.unwrap();
        assert_eq!(msgs[0].content, "my secret diary entry");
    }

    #[tokio::test]
    async fn legacy_plaintext_messages_still_readable() {
        // A row written before encryption was introduced has no envelope prefix.
        let store = ConversationStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('m1', 'c1', 'user', 'old plaintext message', 0)",
                [],
            )
            .unwrap();
        }
        let msgs = store.get_messages("c1").await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "old plaintext message");
    }

    async fn stored_message_count(store: &ConversationStore, id: &str) -> i64 {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT message_count FROM conversations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn message_count_column_tracks_every_writer() {
        let store = ConversationStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute_batch(
                "INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 0, 0);
                 INSERT INTO conversations (id, created_at, updated_at) VALUES ('c2', 0, 0);
                 INSERT INTO messages (id, conversation_id, role, content, created_at)
                     VALUES ('early', 'c1', 'user', 'x', 0);",
            )
            .unwrap();
        }
        assert_eq!(stored_message_count(&store, "c1").await, 1);

        store
            .append_message("c1", "user", "hello", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c1", "assistant", "hi", None, None, None)
            .await
            .unwrap();
        assert_eq!(stored_message_count(&store, "c1").await, 3);

        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE messages SET conversation_id = 'c2' WHERE id = 'early'",
                [],
            )
            .unwrap();
            // An ignored duplicate insert must not count.
            conn.execute(
                "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('early', 'c2', 'user', 'x', 0)",
                [],
            )
            .unwrap();
        }
        assert_eq!(stored_message_count(&store, "c1").await, 2);
        assert_eq!(stored_message_count(&store, "c2").await, 1);

        {
            let conn = store.conn.lock().await;
            conn.execute("DELETE FROM messages WHERE conversation_id = 'c1'", [])
                .unwrap();
        }
        assert_eq!(stored_message_count(&store, "c1").await, 0);

        let summaries = store.list_conversations().await.unwrap();
        let c2 = summaries.iter().find(|s| s.id == "c2").unwrap();
        assert_eq!(c2.message_count, 1);
    }

    async fn sync_rev(store: &ConversationStore, id: &str) -> i64 {
        store.sync_revisions().await.unwrap()[id]
    }

    #[tokio::test]
    async fn sync_rev_changes_with_every_synced_field_and_never_repeats() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "hello", None, None, None)
            .await
            .unwrap();
        let after_append = sync_rev(&store, "c1").await;

        // A streamed reply rewritten in place does not touch `updated_at`, but it
        // is payload content, so the revision must move.
        let message_id: String = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT id FROM messages WHERE conversation_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        store
            .update_message_content(&message_id, "hello, edited")
            .await
            .unwrap();
        let after_edit = sync_rev(&store, "c1").await;
        assert!(after_edit > after_append);

        store.set_title("c1", "Renamed").await.unwrap();
        let after_title = sync_rev(&store, "c1").await;
        assert!(after_title > after_edit);

        // A column the payload does not carry leaves the revision alone.
        {
            let conn = store.conn.lock().await;
            conn.execute("UPDATE conversations SET pinned = 1 WHERE id = 'c1'", [])
                .unwrap();
        }
        assert_eq!(sync_rev(&store, "c1").await, after_title);

        // Delete and recreate under the same id: the global sequence means the
        // new row can never collide with a revision recorded for the old one.
        store.delete_conversation("c1").await.unwrap();
        store
            .append_message("c1", "user", "again", None, None, None)
            .await
            .unwrap();
        assert!(sync_rev(&store, "c1").await > after_title);
    }

    #[test]
    fn message_count_migration_backfills_existing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (
                 id TEXT PRIMARY KEY, title TEXT, agent_id TEXT,
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE messages (
                 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
                 content TEXT NOT NULL, created_at INTEGER NOT NULL
             );
             INSERT INTO conversations (id, created_at, updated_at) VALUES ('old', 0, 0);
             INSERT INTO messages VALUES ('m1', 'old', 'user', 'a', 0);
             INSERT INTO messages VALUES ('m2', 'old', 'assistant', 'b', 1);",
        )
        .unwrap();
        ConversationStore::init_schema(&conn).unwrap();
        // Running the schema again must not double count or fail.
        ConversationStore::init_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT message_count FROM conversations WHERE id = 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn conversation_title_is_encrypted_on_disk() {
        let store = ConversationStore::open_in_memory().unwrap();
        // The first user message derives the title from its content.
        store
            .append_message(
                "c1",
                "user",
                "Plan the secret acquisition",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let raw: Option<String> = {
            let conn = store.conn.lock().await;
            conn.query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                params!["c1"],
                |r| r.get(0),
            )
            .unwrap()
        };
        let raw = raw.expect("title should be set");
        assert!(
            raw.starts_with("enc:v1:"),
            "expected sealed title, got {raw}"
        );
        assert!(!raw.contains("secret acquisition"));

        // Both list and detail return the decrypted title.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(
            list[0].title.as_deref(),
            Some("Plan the secret acquisition")
        );
        let detail = store.get_conversation_detail("c1").await.unwrap().unwrap();
        assert_eq!(detail.title.as_deref(), Some("Plan the secret acquisition"));
    }

    #[tokio::test]
    async fn auto_set_title_overwrites_derived_but_not_custom() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "how do I center a div", None, None, None)
            .await
            .unwrap();
        // Provisional title is the derived first message; not yet user-locked.
        assert!(!store.title_is_custom("c1").await.unwrap());

        // The auto-namer may overwrite the derived title.
        assert!(store.auto_set_title("c1", "Centering a div").await.unwrap());
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("Centering a div"));

        // A manual rename locks the title.
        store.set_title("c1", "CSS layout help").await.unwrap();
        assert!(store.title_is_custom("c1").await.unwrap());

        // A later auto-name is a no-op once the user has chosen a title.
        assert!(!store.auto_set_title("c1", "Robot title").await.unwrap());
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("CSS layout help"));
    }

    #[tokio::test]
    async fn requested_auto_rename_unlocks_and_preserves_history() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "how do I center a div", None, None, None)
            .await
            .unwrap();
        store.set_title("c1", "My title").await.unwrap();
        assert!(!store
            .auto_set_title("c1", "Silent overwrite")
            .await
            .unwrap());
        store
            .force_set_title("c1", "Centering a div")
            .await
            .unwrap();
        assert!(!store.title_is_custom("c1").await.unwrap());
        assert_eq!(
            store
                .get_conversation_detail("c1")
                .await
                .unwrap()
                .unwrap()
                .title
                .as_deref(),
            Some("Centering a div")
        );
        let history = store.list_title_history("c1").await.unwrap();
        assert_eq!(history.last().unwrap().title, "Centering a div");
        assert_eq!(history.last().unwrap().source, "auto");
        assert!(store.force_set_title("missing", "Ghost").await.is_err());
        assert!(store
            .list_title_history("missing")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn context_handoff_is_recorded_once_per_model_change_and_branch() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("handoff", "user", "hello", None, None, None)
            .await
            .unwrap();
        let handoff = |id: &str, head: &str, summary: &str| ConversationContextHandoff {
            id: id.to_owned(),
            model_change_id: "change-2".to_owned(),
            covered_head_id: head.to_owned(),
            outcome: ContextHandoffOutcome::Applied,
            reason: "smaller-context".to_owned(),
            from_model: Some("Big".to_owned()),
            to_model: Some("Small".to_owned()),
            from_context: Some(1_000_000),
            to_context: Some(256_000),
            summarized_count: 4,
            boundary_at: 10,
            summary: Some(summary.to_owned()),
            created_at: 20,
        };

        let first = store
            .record_context_handoff("handoff", handoff("h1", "m4", "first briefing"))
            .await
            .unwrap();
        // A racing turn for the same change and branch replays the first summary.
        let second = store
            .record_context_handoff("handoff", handoff("h2", "m4", "second briefing"))
            .await
            .unwrap();
        assert_eq!(second, first);
        assert_eq!(
            store
                .get_context_handoff("change-2", "m4")
                .await
                .unwrap()
                .and_then(|row| row.summary)
                .as_deref(),
            Some("first briefing")
        );
        // An edit before the switch puts a different head on the active thread,
        // which gets its own summary rather than the old branch's.
        let edited = store
            .record_context_handoff("handoff", handoff("h3", "m2-edit", "edited briefing"))
            .await
            .unwrap();
        assert_eq!(edited.summary.as_deref(), Some("edited briefing"));
        assert_eq!(
            store.get_context_handoff("change-2", "m3").await.unwrap(),
            None
        );
        let listed = store.list_context_handoffs("handoff").await.unwrap();
        assert_eq!(listed, vec![first, edited]);
    }

    #[tokio::test]
    async fn model_selection_history_is_shared_ordered_and_idempotent() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("shared", "user", "hello", None, None, None)
            .await
            .unwrap();

        let (first, first_changed) = store
            .record_model_selection(
                "shared",
                ConversationModelSelectionInput {
                    id: "change-alice".to_owned(),
                    kind: ConversationModelChangeKind::Initial,
                    provider_id: Some("openai".to_owned()),
                    provider_label: Some("OpenAI".to_owned()),
                    model_id: Some("gpt-4.1".to_owned()),
                    model_label: Some("GPT-4.1".to_owned()),
                    changed_by: Some("alice".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(first_changed);
        assert_eq!(first.kind, ConversationModelChangeKind::Initial);

        let (second, second_changed) = store
            .record_model_selection(
                "shared",
                ConversationModelSelectionInput {
                    id: "change-bob".to_owned(),
                    kind: ConversationModelChangeKind::Change,
                    provider_id: Some("anthropic".to_owned()),
                    provider_label: Some("Anthropic".to_owned()),
                    model_id: Some("claude-sonnet-4".to_owned()),
                    model_label: Some("Claude Sonnet 4".to_owned()),
                    changed_by: Some("bob".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(second_changed);
        assert_eq!(second.kind, ConversationModelChangeKind::Change);
        assert!(second.sequence > first.sequence);

        let (replayed, replay_changed) = store
            .record_model_selection(
                "shared",
                ConversationModelSelectionInput {
                    id: "change-bob".to_owned(),
                    kind: ConversationModelChangeKind::Change,
                    provider_id: Some("anthropic".to_owned()),
                    provider_label: Some("Anthropic".to_owned()),
                    model_id: Some("claude-sonnet-4".to_owned()),
                    model_label: Some("Claude Sonnet 4".to_owned()),
                    changed_by: Some("bob".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(!replay_changed);
        assert_eq!(replayed, second);

        let (same_selection, same_changed) = store
            .record_model_selection(
                "shared",
                ConversationModelSelectionInput {
                    id: "duplicate-choice".to_owned(),
                    kind: ConversationModelChangeKind::Change,
                    provider_id: Some("anthropic".to_owned()),
                    provider_label: Some("Anthropic".to_owned()),
                    model_id: Some("claude-sonnet-4".to_owned()),
                    model_label: Some("Claude Sonnet 4".to_owned()),
                    changed_by: Some("carol".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(!same_changed);
        assert_eq!(same_selection, second);

        let changes = store.list_model_changes("shared").await.unwrap();
        assert_eq!(changes, vec![first, second]);
        assert_eq!(
            changes.last().map(|change| change.changed_by.as_deref()),
            Some(Some("bob"))
        );
    }

    /// The DEFAULT title (no plugin, no model): the first user message titles the
    /// conversation the moment it is persisted, and later turns leave it alone.
    #[tokio::test]
    async fn first_user_message_titles_the_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();

        store
            .append_message("c1", "user", "first question", None, None, None)
            .await
            .unwrap();
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("first question"));

        // Assistant reply + a second user turn must NOT re-derive over it.
        store
            .append_message("c1", "assistant", "an answer", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c1", "user", "follow-up", None, None, None)
            .await
            .unwrap();
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("first question"));
        // The derived title is not user-chosen, so the chat-title plugin may
        // still replace it.
        assert!(!store.title_is_custom("c1").await.unwrap());

        // `get_first_user_message` returns the earliest user turn.
        assert_eq!(
            store.get_first_user_message("c1").await.unwrap().as_deref(),
            Some("first question")
        );
    }

    /// A text-less opener (image/file only) must not pin a placeholder: the title
    /// stays NULL so the next real user turn can still name the thread.
    #[tokio::test]
    async fn empty_first_message_leaves_the_title_unset() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("c1", "user", "   ", None, None, None)
            .await
            .unwrap();
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title, None);

        store
            .append_message("c1", "user", "now with words", None, None, None)
            .await
            .unwrap();
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].title.as_deref(), Some("now with words"));
    }

    #[tokio::test]
    async fn append_and_fetch_round_trips() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-1", "user", "Hello there", Some("default"), None, None)
            .await
            .unwrap();
        store
            .append_message("conv-1", "assistant", "Hi!", Some("default"), None, None)
            .await
            .unwrap();

        let msgs = store.get_messages("conv-1").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "Hello there");
        assert_eq!(msgs[1].role, "assistant");
    }

    #[tokio::test]
    async fn message_feedback_set_list_and_turn_resolution() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-f",
                "user",
                "how do I reverse a string",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let asst = store
            .append_message("conv-f", "assistant", "use chars().rev()", None, None, None)
            .await
            .unwrap();

        // No feedback yet.
        assert!(store.list_feedback("conv-f").await.unwrap().is_empty());

        // Set a thumbs up.
        assert!(store
            .set_message_feedback("conv-f", &asst, Some("up"))
            .await
            .unwrap());
        let fb = store.list_feedback("conv-f").await.unwrap();
        assert_eq!(fb, vec![(asst.clone(), "up".to_string())]);

        // The turn resolves to (user prompt, assistant reply).
        let turn = store
            .get_turn_for_assistant_message("conv-f", &asst)
            .await
            .unwrap()
            .expect("turn resolves");
        assert_eq!(turn.0, "how do I reverse a string");
        assert_eq!(turn.1, "use chars().rev()");

        // Clearing removes it from the map.
        assert!(store
            .set_message_feedback("conv-f", &asst, None)
            .await
            .unwrap());
        assert!(store.list_feedback("conv-f").await.unwrap().is_empty());

        // A wrong-conversation scope is a no-op (row not found).
        assert!(!store
            .set_message_feedback("conv-other", &asst, Some("down"))
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn agent_ui_state_round_trips_updates_caps_and_deletes_with_the_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-ui", "user", "make me a checklist", None, None, None)
            .await
            .unwrap();
        assert!(store
            .list_agent_ui_states("conv-ui")
            .await
            .unwrap()
            .is_empty());

        let first = serde_json::json!({ "todo": [{ "label": "Pack", "done": true }] });
        assert!(store
            .set_agent_ui_state("conv-ui", "call-1", &first.to_string())
            .await
            .unwrap());
        // Updating the same widget replaces its state rather than adding a row.
        let second = serde_json::json!({ "todo": [{ "label": "Pack", "done": false }] });
        assert!(store
            .set_agent_ui_state("conv-ui", "call-1", &second.to_string())
            .await
            .unwrap());
        let saved = store.list_agent_ui_states("conv-ui").await.unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].tool_call_id, "call-1");
        assert_eq!(saved[0].state, second);
        // Other conversations never see it.
        assert!(store
            .list_agent_ui_states("conv-other")
            .await
            .unwrap()
            .is_empty());

        // The per-conversation cap refuses NEW widgets but still accepts updates.
        for index in 1..MAX_AGENT_UI_STATES {
            assert!(store
                .set_agent_ui_state("conv-ui", &format!("fill-{index}"), "{}")
                .await
                .unwrap());
        }
        assert!(!store
            .set_agent_ui_state("conv-ui", "one-too-many", "{}")
            .await
            .unwrap());
        assert!(store
            .set_agent_ui_state("conv-ui", "call-1", &first.to_string())
            .await
            .unwrap());

        assert!(store.delete_conversation("conv-ui").await.unwrap());
        assert!(store
            .list_agent_ui_states("conv-ui")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn message_reactions_aggregate_per_emoji_and_resolve_the_viewer() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-x", "user", "ship it?", None, None, None)
            .await
            .unwrap();
        let asst = store
            .append_message("conv-x", "assistant", "shipped", None, None, None)
            .await
            .unwrap();

        // Nothing yet.
        assert!(store
            .list_reactions("conv-x", "alice")
            .await
            .unwrap()
            .is_empty());

        assert!(store
            .add_reaction("conv-x", &asst, "alice", "🎉")
            .await
            .unwrap());
        let seen = store.list_reactions("conv-x", "alice").await.unwrap();
        assert_eq!(
            seen,
            vec![MessageReaction {
                message_id: asst.clone(),
                emoji: "🎉".to_owned(),
                count: 1,
                reacted_by_me: true,
            }]
        );
        // Bob sees the same bucket, but it is not his.
        assert!(!store.list_reactions("conv-x", "bob").await.unwrap()[0].reacted_by_me);

        // A second user on the same emoji aggregates into one bucket; both see
        // themselves in it.
        assert!(store
            .add_reaction("conv-x", &asst, "bob", "🎉")
            .await
            .unwrap());
        for viewer in ["alice", "bob"] {
            let seen = store.list_reactions("conv-x", viewer).await.unwrap();
            assert_eq!(seen.len(), 1, "one bucket for one emoji");
            assert_eq!(seen[0].count, 2);
            assert!(seen[0].reacted_by_me, "{viewer} reacted");
        }

        // Double-tapping is idempotent — no PK error, no double count.
        assert!(store
            .add_reaction("conv-x", &asst, "alice", "🎉")
            .await
            .unwrap());
        assert_eq!(
            store.list_reactions("conv-x", "alice").await.unwrap()[0].count,
            2
        );

        // A different emoji is a separate bucket.
        assert!(store
            .add_reaction("conv-x", &asst, "alice", "👀")
            .await
            .unwrap());
        assert_eq!(
            store.list_reactions("conv-x", "alice").await.unwrap().len(),
            2
        );

        // Removing drops only this user's row from the bucket.
        assert!(store
            .remove_reaction("conv-x", &asst, "alice", "🎉")
            .await
            .unwrap());
        let seen = store.list_reactions("conv-x", "alice").await.unwrap();
        let party = seen.iter().find(|r| r.emoji == "🎉").expect("bucket kept");
        assert_eq!(party.count, 1);
        assert!(!party.reacted_by_me);
        // Removing again is a harmless no-op, not an error.
        assert!(store
            .remove_reaction("conv-x", &asst, "alice", "🎉")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn message_reactions_allow_a_peer_agent_authored_message() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-agents-reactions",
                "user",
                "review this",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let alpha_message = store
            .append_message(
                "conv-agents-reactions",
                "assistant",
                "alpha's review",
                Some("agent-alpha"),
                None,
                None,
            )
            .await
            .unwrap();
        let beta_message = store
            .append_message(
                "conv-agents-reactions",
                "assistant",
                "beta's follow-up",
                Some("agent-beta"),
                None,
                None,
            )
            .await
            .unwrap();

        // The reaction writer is a different agent from both message authors.
        // The persisted-message gate checks conversation membership, not role or
        // agent ownership, so peer-agent replies remain reactable.
        assert!(store
            .add_reaction(
                "conv-agents-reactions",
                &alpha_message,
                "agent:agent-reviewer",
                "✅",
            )
            .await
            .unwrap());
        assert!(store
            .add_reaction(
                "conv-agents-reactions",
                &beta_message,
                "agent:agent-reviewer",
                "👀",
            )
            .await
            .unwrap());

        let reactions = store
            .list_reactions("conv-agents-reactions", "agent:agent-reviewer")
            .await
            .unwrap();
        assert_eq!(reactions.len(), 2);
        assert!(reactions.iter().any(|reaction| {
            reaction.message_id == alpha_message && reaction.emoji == "✅" && reaction.reacted_by_me
        }));
        assert!(reactions.iter().any(|reaction| {
            reaction.message_id == beta_message && reaction.emoji == "👀" && reaction.reacted_by_me
        }));
    }

    #[tokio::test]
    async fn agent_reactions_on_latest_user_message_ignore_people_and_older_turns() {
        let store = ConversationStore::open_in_memory().unwrap();
        assert_eq!(
            store.latest_user_message_id("conv-ack").await.unwrap(),
            None
        );
        assert!(store
            .agent_reactions_on_latest_user_message("conv-ack")
            .await
            .unwrap()
            .is_empty());
        let first = store
            .append_message("conv-ack", "user", "first", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-ack", "assistant", "ok", Some("agent-a"), None, None)
            .await
            .unwrap();
        let latest = store
            .append_message("conv-ack", "user", "yea find useful ones", None, None, None)
            .await
            .unwrap();
        store
            .append_message(
                "conv-ack",
                "assistant",
                "on it",
                Some("agent-a"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            store.latest_user_message_id("conv-ack").await.unwrap(),
            Some(latest.clone())
        );

        for (message, actor, emoji) in [
            (&first, "agent:agent-a", "🎉"),
            (&latest, "human-user", "❤️"),
            (&latest, "agent:agent-a", "👍"),
            (&latest, "agent:agent-b", "👍"),
            (&latest, "agent:agent-b", "🙏"),
        ] {
            assert!(store
                .add_reaction("conv-ack", message, actor, emoji)
                .await
                .unwrap());
        }
        assert_eq!(
            store
                .agent_reactions_on_latest_user_message("conv-ack")
                .await
                .unwrap(),
            vec!["👍".to_owned(), "🙏".to_owned()]
        );
    }

    #[tokio::test]
    async fn message_reactions_are_gated_on_a_persisted_message_of_this_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        let msg = store
            .append_message("conv-g", "assistant", "hi", None, None, None)
            .await
            .unwrap();

        // A client-generated id for a still-streaming reply has no row yet: false
        // (→ 404 at the route). This IS the persistence gate — there is no
        // `allow_latest_fallback` retarget for reactions.
        assert!(!store
            .add_reaction("conv-g", "client-generated-id", "alice", "🎉")
            .await
            .unwrap());
        // …and no orphan row was written.
        assert!(store
            .list_reactions("conv-g", "alice")
            .await
            .unwrap()
            .is_empty());

        // A real id under the WRONG conversation is equally refused.
        assert!(!store
            .add_reaction("conv-other", &msg, "alice", "🎉")
            .await
            .unwrap());
        assert!(!store
            .remove_reaction("conv-other", &msg, "alice", "🎉")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn read_receipts_are_per_user_idempotent_and_message_scoped() {
        let store = ConversationStore::open_in_memory().unwrap();
        let first = store
            .append_message("conv-read", "user", "first", None, Some("alice"), None)
            .await
            .unwrap();
        let second = store
            .append_message("conv-read", "user", "second", None, Some("alice"), None)
            .await
            .unwrap();

        let first_mark = store
            .mark_messages_read(
                "conv-read",
                &[first.clone(), second.clone(), "not-in-this-chat".to_owned()],
                "bob",
                Some("bob@example.test"),
            )
            .await
            .unwrap();
        assert_eq!(first_mark.len(), 2);
        assert!(first_mark.iter().all(|receipt| {
            receipt.user_id == "bob"
                && receipt.read_at.contains('T')
                && receipt.user_name.as_deref() == Some("bob@example.test")
        }));

        // Retrying the same batch produces no second event/row.
        assert!(store
            .mark_messages_read("conv-read", &[first.clone(), second.clone()], "bob", None,)
            .await
            .unwrap()
            .is_empty());

        // A second person gets an independent receipt, while a different
        // conversation cannot attach to these message ids.
        assert_eq!(
            store
                .mark_messages_read("conv-read", std::slice::from_ref(&first), "carol", None,)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .mark_messages_read("conv-other", std::slice::from_ref(&first), "dave", None,)
            .await
            .unwrap()
            .is_empty());

        let listed = store.list_read_receipts("conv-read").await.unwrap();
        assert_eq!(listed.len(), 3);
        assert!(listed
            .iter()
            .any(|receipt| { receipt.message_id == first && receipt.user_id == "carol" }));

        assert!(store.delete_conversation("conv-read").await.unwrap());
        assert!(store
            .list_read_receipts("conv-read")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn read_receipts_publish_a_named_live_event_once() {
        let registry = ryu_realtime::RoomRegistry::new();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_realtime(registry.clone());
        let message_id = store
            .append_message(
                "conv-realtime-read",
                "user",
                "live message",
                None,
                Some("alice"),
                None,
            )
            .await
            .unwrap();
        let mut receiver = registry.get_or_create("conv-realtime-read").subscribe();

        let receipts = store
            .mark_messages_read(
                "conv-realtime-read",
                std::slice::from_ref(&message_id),
                "bob",
                Some("bob@example.test"),
            )
            .await
            .unwrap();
        assert_eq!(receipts.len(), 1);
        let frame = receiver.recv().await.unwrap();
        let event = ryu_realtime::Event::decode(&frame).expect("named read event");
        assert_eq!(event.name, "conversation.readReceipt");
        assert_eq!(event.payload["type"], "readReceipt");
        assert_eq!(event.payload["conversationId"], "conv-realtime-read");
        assert_eq!(event.payload["messageId"], message_id);
        assert_eq!(event.payload["userId"], "bob");
        assert_eq!(event.payload["userName"], "bob@example.test");

        // Idempotent retries do not produce another room event.
        assert!(store
            .mark_messages_read(
                "conv-realtime-read",
                std::slice::from_ref(&message_id),
                "bob",
                None,
            )
            .await
            .unwrap()
            .is_empty());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn deleting_a_conversation_removes_its_reactions() {
        // FK enforcement is off, so this only holds because `delete_conversation`
        // drops the rows by hand.
        let store = ConversationStore::open_in_memory().unwrap();
        let msg = store
            .append_message("conv-d", "assistant", "bye", None, None, None)
            .await
            .unwrap();
        assert!(store
            .add_reaction("conv-d", &msg, "alice", "👋")
            .await
            .unwrap());

        assert!(store.delete_conversation("conv-d").await.unwrap());

        // Query the table directly: `list_reactions` would also pass on an empty
        // result, but this proves no row survived under the old conversation id.
        let conn = store.conn.lock().await;
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_reactions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0, "reactions must not outlive their conversation");
    }

    #[tokio::test]
    async fn bulk_clear_removes_reactions_and_legacy_orphans_stay_hidden() {
        let store = ConversationStore::open_in_memory().unwrap();
        let message_id = store
            .append_message("conv-clear", "assistant", "bye", None, None, None)
            .await
            .unwrap();
        store
            .add_reaction("conv-clear", &message_id, "alice", "👋")
            .await
            .unwrap();

        assert_eq!(store.clear_all_conversations().await.unwrap().removed, 1);
        let conn = store.conn.lock().await;
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_reactions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
        conn.execute(
            "INSERT INTO message_reactions
                (message_id, conversation_id, user_id, emoji, created_at)
             VALUES ('old-message', 'conv-clear', 'alice', '👋', 1)",
            [],
        )
        .unwrap();
        drop(conn);

        store
            .append_message("conv-clear", "assistant", "new", None, None, None)
            .await
            .unwrap();
        assert!(store
            .list_reactions("conv-clear", "alice")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn owner_scoped_clear_removes_only_that_owners_reactions() {
        let store = ConversationStore::open_in_memory().unwrap();
        let alice_message = store
            .append_message_as(
                "shared-id",
                "assistant",
                "alice old",
                None,
                Some("alice"),
                None,
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org-1".to_owned()),
                },
            )
            .await
            .unwrap();
        let bob_message = store
            .append_message_as(
                "bob-chat",
                "assistant",
                "bob",
                None,
                Some("bob"),
                None,
                Tenancy::Owned {
                    user_id: "bob".to_owned(),
                    org_id: Some("org-1".to_owned()),
                },
            )
            .await
            .unwrap();
        store
            .add_reaction("shared-id", &alice_message, "alice", "🔒")
            .await
            .unwrap();
        store
            .add_reaction("bob-chat", &bob_message, "bob", "✅")
            .await
            .unwrap();

        assert_eq!(
            store
                .clear_conversations_owned_by("alice")
                .await
                .unwrap()
                .removed,
            1
        );
        assert_eq!(
            store.list_reactions("bob-chat", "bob").await.unwrap().len(),
            1
        );

        store
            .append_message_as(
                "shared-id",
                "assistant",
                "bob new",
                None,
                Some("bob"),
                None,
                Tenancy::Owned {
                    user_id: "bob".to_owned(),
                    org_id: Some("org-1".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(store
            .list_reactions("shared-id", "bob")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn turn_resolution_pairs_second_assistant_reply_to_the_user() {
        // Regenerate / council case: a second consecutive assistant reply must
        // still pair to the preceding user turn (not return None).
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-r", "user", "what is 2+2", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-r", "assistant", "first attempt: 4", None, None, None)
            .await
            .unwrap();
        let second = store
            .append_message(
                "conv-r",
                "assistant",
                "regenerated: it is 4",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let turn = store
            .get_turn_for_assistant_message("conv-r", &second)
            .await
            .unwrap()
            .expect("second assistant reply resolves to the preceding user turn");
        assert_eq!(turn.0, "what is 2+2");
        assert_eq!(turn.1, "regenerated: it is 4");
    }

    #[tokio::test]
    async fn list_orders_by_recency_and_counts() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "first", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-b", "user", "second", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-a", "assistant", "reply", None, None, None)
            .await
            .unwrap();

        let list = store.list_conversations().await.unwrap();
        assert_eq!(list.len(), 2);
        // conv-a was updated last, so it sorts first.
        assert_eq!(list[0].id, "conv-a");
        assert_eq!(list[0].message_count, 2);
        assert_eq!(list[0].title.as_deref(), Some("first"));
        // The default listing stays preview-free — every other lister (runs, sync
        // replay, the learning pass) rides this path and must not pay for it.
        assert_eq!(list[0].last_message, None);
        assert_eq!(list[0].last_message_at, None);
    }

    #[tokio::test]
    async fn preview_listing_returns_the_newest_message_decrypted_and_flattened() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "first", None, None, None)
            .await
            .unwrap();
        store
            .append_message(
                "conv-a",
                "assistant",
                "line one\n\n   line two",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message("conv-b", "user", "only message", None, None, None)
            .await
            .unwrap();

        let list = store
            .list_conversations_visible_with_preview(None, None, false)
            .await
            .unwrap();
        let a = list
            .iter()
            .find(|c| c.id == "conv-a")
            .expect("conv-a listed");
        // Newest wins, it comes back decrypted, and the newlines are flattened so
        // the two-line sidebar row cannot grow a third line.
        assert_eq!(a.last_message.as_deref(), Some("line one line two"));
        assert_eq!(a.last_message_role.as_deref(), Some("assistant"));
        assert!(a.last_message_at.unwrap_or(0) > 0);

        let b = list
            .iter()
            .find(|c| c.id == "conv-b")
            .expect("conv-b listed");
        assert_eq!(b.last_message.as_deref(), Some("only message"));
        assert_eq!(b.last_message_role.as_deref(), Some("user"));
    }

    #[tokio::test]
    async fn preview_skips_non_conversational_roles() {
        // Sync replay and thread import copy a peer's role verbatim, so a `tool`
        // row can be the newest message. Previewing it would put a raw tool
        // payload where the sidebar promises the last thing that was said.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-t", "user", "run the build", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-t", "assistant", "building now", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-t", "tool", "{\"exit\":0}", None, None, None)
            .await
            .unwrap();

        let list = store
            .list_conversations_visible_with_preview(None, None, false)
            .await
            .unwrap();
        let conv = list.iter().find(|c| c.id == "conv-t").expect("listed");
        assert_eq!(conv.last_message.as_deref(), Some("building now"));
        assert_eq!(conv.last_message_role.as_deref(), Some("assistant"));
    }

    #[test]
    fn preview_line_caps_a_long_body() {
        let long = "x".repeat(PREVIEW_MAX_CHARS * 3);
        let preview = preview_line(&long);
        // Capped at the limit plus the ellipsis — a 40 KB tool dump never reaches
        // the sidebar.
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 1);
        assert!(preview.ends_with('…'));
    }

    #[tokio::test]
    async fn delete_removes_conversation_and_messages() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-x", "user", "to delete", None, None, None)
            .await
            .unwrap();
        assert!(store.delete_conversation("conv-x").await.unwrap());
        assert!(store.get_messages("conv-x").await.unwrap().is_empty());
        assert!(!store.delete_conversation("conv-x").await.unwrap());
    }

    #[tokio::test]
    async fn delete_removes_proactive_opening_tombstones() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-recreated", "user", "hello", None, None, None)
            .await
            .unwrap();
        assert!(store
            .claim_proactive_opening("opening-recreated", "conv-recreated")
            .await
            .unwrap());
        store
            .complete_proactive_opening("opening-recreated")
            .await
            .unwrap();

        assert!(store.delete_conversation("conv-recreated").await.unwrap());
        assert_eq!(
            store
                .proactive_opening_status("opening-recreated")
                .await
                .unwrap(),
            None
        );
        // Recreating the same conversation id starts with a fresh idempotency
        // lifecycle instead of inheriting the deleted row's completed tombstone.
        assert!(store
            .claim_proactive_opening("opening-recreated", "conv-recreated")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn sealed_content_count_separates_sealed_rows_from_legacy_plaintext() {
        // The Encryption settings tab reports this as MEASURED coverage, so a
        // legacy plaintext row must drag the count down, not be assumed sealed.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "sealed on write", None, None, None)
            .await
            .unwrap();
        let (sealed, total) = store.count_sealed_content().await.unwrap();
        assert!(total > 0, "the written row must be counted");
        assert_eq!(sealed, total, "everything written now is sealed");
        let before = total;

        // A row from before encryption landed: plaintext, no `enc:v1:` prefix.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('legacy', 'conv-a', 'user', 'written before encryption', 0)",
                [],
            )
            .unwrap();
        }
        let (sealed, total) = store.count_sealed_content().await.unwrap();
        assert_eq!(total, before + 1, "the legacy row is counted in the total");
        assert_eq!(sealed, before, "legacy plaintext must count as open");
    }

    #[tokio::test]
    async fn clear_all_removes_every_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-a", "user", "hi", None, None, None)
            .await
            .unwrap();
        store
            .append_message("conv-b", "user", "yo", None, None, None)
            .await
            .unwrap();
        assert_eq!(store.count_conversations().await.unwrap(), 2);
        // Saved widget state and reactions have no FK, so the wipe must remove
        // them explicitly rather than leave sealed orphans behind.
        store
            .set_agent_ui_state("conv-a", "call-1", r#"{"state":{"typed":"secret"}}"#)
            .await
            .unwrap();
        let message_id = store.get_messages("conv-b").await.unwrap()[0].id.clone();
        assert!(store
            .add_reaction("conv-b", &message_id, "me", "👍")
            .await
            .unwrap());

        let removed = store.clear_all_conversations().await.unwrap().removed;
        assert_eq!(removed, 2);
        assert_eq!(store.count_conversations().await.unwrap(), 0);
        assert!(store.list_conversations().await.unwrap().is_empty());
        let conn = store.conn.lock().await;
        let leftover: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM agent_ui_state)
                      + (SELECT COUNT(*) FROM message_reactions)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            leftover, 0,
            "clearing all chats left widget state or reactions"
        );
    }

    #[tokio::test]
    async fn clear_owned_removes_only_the_owners_widget_state_reactions_and_runs() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (conversation, owner) in [("alice-chat", "alice"), ("bob-chat", "bob")] {
            let message_id = store
                .append_message(conversation, "user", "hi", None, None, None)
                .await
                .unwrap();
            store
                .claim_tenancy(conversation, owner, Some("org1"))
                .await
                .unwrap();
            assert!(store
                .set_agent_ui_state(conversation, "call-1", r#"{"state":{"done":true}}"#)
                .await
                .unwrap());
            assert!(store
                .add_reaction(conversation, &message_id, owner, "👍")
                .await
                .unwrap());
        }
        let owned = |user: &str| Tenancy::Owned {
            user_id: user.to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let mut run_ids = Vec::new();
        for owner in ["alice", "bob"] {
            let session = store
                .create_session("agent-a", RunnableKind::Agent, None, None, owned(owner))
                .await
                .unwrap();
            let request = StartRunRequest {
                input: serde_json::json!({ "prompt": "inspect" }),
                idempotency_key: None,
                execution_profile: None,
                resume_run_id: None,
                multitask_strategy: None,
            };
            let started = store
                .start_harness_run(&session.id, &request)
                .await
                .unwrap();
            run_ids.push((owner, started.run.id));
        }

        let cleared = store.clear_conversations_owned_by("bob").await.unwrap();
        assert_eq!(
            cleared.removed, 2,
            "Bob's chat and his session's conversation"
        );
        // The residue names exactly the conversations removed, so their
        // transcripts and checkpoint pins are released and Alice's are not.
        assert_eq!(cleared.residue.len(), 2);
        assert!(cleared
            .residue
            .iter()
            .any(|residue| residue.conversation_id == "bob-chat"));
        assert!(cleared
            .residue
            .iter()
            .all(|residue| residue.conversation_id != "alice-chat"));

        assert!(store
            .list_agent_ui_states("bob-chat")
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .list_reactions("bob-chat", "bob")
            .await
            .unwrap()
            .is_empty());
        // Alice's rows are untouched.
        assert_eq!(
            store
                .list_agent_ui_states("alice-chat")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_reactions("alice-chat", "alice")
                .await
                .unwrap()
                .len(),
            1
        );
        for (owner, run_id) in run_ids {
            let kept = store.get_harness_run(&run_id).await.unwrap().is_some();
            assert_eq!(kept, owner == "alice", "harness run of {owner}");
        }
    }

    #[tokio::test]
    async fn full_fork_carries_widget_state_but_a_mid_history_fork_does_not() {
        let store = ConversationStore::open_in_memory().unwrap();
        let cut = store
            .append_message("src", "user", "make a checklist", None, None, None)
            .await
            .unwrap();
        store
            .append_message("src", "assistant", "here it is", None, None, None)
            .await
            .unwrap();
        let saved = serde_json::json!({ "state": { "done": [true] }, "submitted": true });
        assert!(store
            .set_agent_ui_state("src", "call-1", &saved.to_string())
            .await
            .unwrap());

        let full = store
            .fork_conversation("src", None, Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("full fork");
        let copied = store.list_agent_ui_states(&full.id).await.unwrap();
        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0].tool_call_id, "call-1");
        assert_eq!(copied[0].state, saved);

        // The fork owns its copy: editing it leaves the source alone.
        assert!(store
            .set_agent_ui_state(&full.id, "call-1", r#"{"state":{"done":[false]}}"#)
            .await
            .unwrap());
        assert_eq!(
            store.list_agent_ui_states("src").await.unwrap()[0].state,
            saved
        );

        // A cut before the last message would import a later snapshot, so the
        // branch starts its widgets from their specs instead.
        let partial = store
            .fork_conversation("src", Some(&cut), Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("partial fork");
        assert!(store
            .list_agent_ui_states(&partial.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn fork_copies_history_up_to_message_into_new_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("src", "user", "q1", None, None, None)
            .await
            .unwrap();
        let cut = store
            .append_message("src", "assistant", "a1", Some("default"), None, None)
            .await
            .unwrap();
        store
            .append_message("src", "user", "q2", None, None, None)
            .await
            .unwrap();

        let forked = store
            .fork_conversation("src", Some(&cut), Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("fork should succeed");
        assert_ne!(forked.id, "src");
        assert_eq!(forked.message_count, 2);
        assert_eq!(forked.title.as_deref(), Some("q1 (branch)"));

        // The fork has exactly the first two messages, with fresh ids.
        let copied = store.get_messages(&forked.id).await.unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(copied[0].content, "q1");
        assert_eq!(copied[1].content, "a1");
        assert_ne!(copied[1].id, cut, "copied messages get fresh ids");

        // The source is untouched; continuing the fork never touches it.
        assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
        store
            .append_message(&forked.id, "user", "branch-only", None, None, None)
            .await
            .unwrap();
        assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
        assert_eq!(store.get_messages(&forked.id).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn fork_missing_source_or_message_returns_none() {
        let store = ConversationStore::open_in_memory().unwrap();
        assert!(store
            .fork_conversation("nope", None, Tenancy::Unattributed)
            .await
            .unwrap()
            .is_none());
        store
            .append_message("src2", "user", "hi", None, None, None)
            .await
            .unwrap();
        assert!(store
            .fork_conversation("src2", Some("not-a-real-id"), Tenancy::Unattributed)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn get_recent_returns_tail_in_order() {
        let store = ConversationStore::open_in_memory().unwrap();
        for n in 0..5 {
            store
                .append_message("conv-r", "user", &format!("msg {n}"), None, None, None)
                .await
                .unwrap();
        }
        let recent = store.get_recent_messages("conv-r", 2).await.unwrap();
        assert_eq!(recent.len(), 2);
        // Newest two, in chronological order.
        assert_eq!(recent[0].content, "msg 3");
        assert_eq!(recent[1].content, "msg 4");
    }

    fn contents(messages: &[StoredMessage]) -> Vec<&str> {
        messages.iter().map(|m| m.content.as_str()).collect()
    }

    #[tokio::test]
    async fn get_recent_follows_the_active_thread_after_rewind_and_edit() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-branched";
        for (role, text) in [("user", "u1"), ("assistant", "a1")] {
            store
                .append_message(conv, role, text, None, None, None)
                .await
                .unwrap();
        }
        let u2 = store
            .append_message(conv, "user", "u2", None, None, None)
            .await
            .unwrap();
        store
            .append_message(conv, "assistant", "a2", None, None, None)
            .await
            .unwrap();

        // Rewinding to before u2 must keep the rewound pair out of the replay.
        store
            .rewind_to_message(conv, &u2)
            .await
            .unwrap()
            .expect("rewound");
        let u3 = store
            .append_message(conv, "user", "u3", None, None, None)
            .await
            .unwrap();
        let recent = store.get_recent_messages(conv, 10).await.unwrap();
        assert_eq!(contents(&recent), ["u1", "a1", "u3"]);
        let recent = store.get_recent_messages(conv, 2).await.unwrap();
        assert_eq!(contents(&recent), ["a1", "u3"], "limit keeps the newest");

        // Editing u3 drops the original question and its answer.
        store
            .append_message(conv, "assistant", "a3", None, None, None)
            .await
            .unwrap();
        store
            .edit_user_message(conv, &u3, "u3 edited")
            .await
            .unwrap()
            .expect("edited");
        store
            .append_message(conv, "assistant", "a3 edited", None, None, None)
            .await
            .unwrap();
        let recent = store.get_recent_messages(conv, 10).await.unwrap();
        assert_eq!(contents(&recent), ["u1", "a1", "u3 edited", "a3 edited"]);
    }

    #[tokio::test]
    async fn fork_of_a_branched_conversation_copies_only_the_cut_points_thread() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (role, text) in [("user", "u1"), ("assistant", "a1")] {
            store
                .append_message("src", role, text, None, None, None)
                .await
                .unwrap();
        }
        let u2 = store
            .append_message("src", "user", "u2", None, None, None)
            .await
            .unwrap();
        let a2 = store
            .append_message("src", "assistant", "a2", None, None, None)
            .await
            .unwrap();
        store
            .edit_user_message("src", &u2, "u2 edited")
            .await
            .unwrap()
            .expect("edited");
        let a2_edited = store
            .append_message("src", "assistant", "a2 edited", None, None, None)
            .await
            .unwrap();
        store
            .prepare_regenerate("src", &a2_edited)
            .await
            .unwrap()
            .expect("regenerate");
        let newest = store
            .append_message("src", "assistant", "a2 regenerated", None, None, None)
            .await
            .unwrap();
        assert!(store
            .set_agent_ui_state("src", "call-1", r#"{"state":{"done":true}}"#)
            .await
            .unwrap());

        let thread = ["u1", "a1", "u2 edited", "a2 regenerated"];
        for cut in [None, Some(newest.as_str())] {
            let forked = store
                .fork_conversation("src", cut, Tenancy::Unattributed)
                .await
                .unwrap()
                .expect("fork");
            assert_eq!(forked.message_count, 4);
            let copied = store.get_active_messages(&forked.id).await.unwrap();
            assert_eq!(contents(&copied), thread);
            assert_eq!(
                store.list_agent_ui_states(&forked.id).await.unwrap().len(),
                1,
                "a fork of the whole active thread keeps its widget state"
            );
        }

        // A cut on an inactive version copies that version's own ancestry.
        let forked = store
            .fork_conversation("src", Some(&a2), Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("fork of an inactive version");
        let copied = store.get_active_messages(&forked.id).await.unwrap();
        assert_eq!(contents(&copied), ["u1", "a1", "u2", "a2"]);
        assert!(store
            .list_agent_ui_states(&forked.id)
            .await
            .unwrap()
            .is_empty());
    }

    async fn seed_conversation_history_rows(store: &ConversationStore, conversation_id: &str) {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO conversation_title_history (id, conversation_id, title, source, created_at)
             VALUES (?1, ?2, 'old title', 'auto', 1)",
            params![format!("title-{conversation_id}"), conversation_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversation_model_changes (id, conversation_id, selection_kind, created_at)
             VALUES (?1, ?2, 'initial', 1)",
            params![format!("change-{conversation_id}"), conversation_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversation_context_handoffs
                (id, conversation_id, model_change_id, outcome, reason, summarized_count,
                 boundary_at, summary, created_at)
             VALUES (?1, ?2, ?3, 'applied', 'switch', 1, 1, 'digest of the chat', 1)",
            params![
                format!("handoff-{conversation_id}"),
                conversation_id,
                format!("change-{conversation_id}")
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_controls (conversation_id, requested_by, requested_at)
             VALUES (?1, 'someone', 1)",
            params![conversation_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO run_auto_resume (conversation_id, user_message_id, attempts, updated_at)
             VALUES (?1, 'turn', 1, 1)",
            params![conversation_id],
        )
        .unwrap();
    }

    async fn conversation_history_row_count(
        store: &ConversationStore,
        conversation_id: &str,
    ) -> i64 {
        let conn = store.conn.lock().await;
        CONVERSATION_SCOPED_HISTORY_TABLES
            .iter()
            .map(|table| {
                conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE conversation_id = ?1"),
                    params![conversation_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
            })
            .sum()
    }

    #[tokio::test]
    async fn every_delete_path_clears_title_model_and_handoff_history() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (conversation, owner) in [
            ("deleted", "alice"),
            ("alice-chat", "alice"),
            ("bob-chat", "bob"),
        ] {
            store
                .append_message(conversation, "user", "hi", None, None, None)
                .await
                .unwrap();
            store
                .claim_tenancy(conversation, owner, Some("org1"))
                .await
                .unwrap();
            seed_conversation_history_rows(&store, conversation).await;
            // Five seeded rows plus the title the first message derived.
            assert_eq!(
                conversation_history_row_count(&store, conversation).await,
                6
            );
        }

        assert!(store.delete_conversation("deleted").await.unwrap());
        assert_eq!(conversation_history_row_count(&store, "deleted").await, 0);
        // A recreated id starts without the deleted chat's history.
        store
            .append_message("deleted", "user", "new owner", None, None, None)
            .await
            .unwrap();
        assert!(store
            .list_context_handoffs("deleted")
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .list_model_changes("deleted")
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .list_title_history("deleted")
            .await
            .unwrap()
            .iter()
            .all(|entry| entry.title != "old title"));

        store.clear_conversations_owned_by("bob").await.unwrap();
        assert_eq!(conversation_history_row_count(&store, "bob-chat").await, 0);
        assert_eq!(
            conversation_history_row_count(&store, "alice-chat").await,
            6
        );

        store.clear_all_conversations().await.unwrap();
        assert_eq!(
            conversation_history_row_count(&store, "alice-chat").await,
            0
        );
    }

    #[tokio::test]
    async fn resumed_messages_join_the_active_thread_of_a_branched_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-resumed";
        let u1 = store
            .append_message(conv, "user", "u1", None, None, None)
            .await
            .unwrap();
        let a1 = store
            .append_message(conv, "assistant", "a1", None, None, None)
            .await
            .unwrap();
        // Engage the version tree (leaf = a1), as an edit or regenerate would.
        store
            .select_version(conv, &a1)
            .await
            .unwrap()
            .expect("leaf");

        let later = now_millis() + 1_000;
        for (offset, (id, role, text)) in [
            ("b-u2", "user", "u2 on the other node"),
            ("b-a2", "assistant", "a2 on the other node"),
            ("rnp-context-1", "user", "[Imported context: notes]"),
        ]
        .into_iter()
        .enumerate()
        {
            assert!(store
                .append_sync_message_with_id(conv, id, role, text, None, later + offset as i64)
                .await
                .unwrap());
        }
        let transcript = owned_ids(&[u1.as_str(), a1.as_str(), "b-u2", "b-a2"]);
        let context = owned_ids(&["rnp-context-1"]);
        let inserted = owned_id_set(&["b-u2", "b-a2", "rnp-context-1"]);
        store
            .link_resumed_messages(conv, &transcript, &context, &inserted)
            .await
            .unwrap();

        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&active),
            [
                "u1",
                "a1",
                "u2 on the other node",
                "a2 on the other node",
                "[Imported context: notes]"
            ]
        );
        // The next local turn continues beneath the resumed work.
        store
            .append_message(conv, "user", "u3", None, None, None)
            .await
            .unwrap();
        let recent = store.get_recent_messages(conv, 2).await.unwrap();
        assert_eq!(contents(&recent), ["[Imported context: notes]", "u3"]);
    }

    fn owned_ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn owned_id_set(ids: &[&str]) -> std::collections::HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    /// A branched conversation u1,a1,u2,a2 with leaf a2, plus its message ids.
    async fn branched_resume_target(store: &ConversationStore, conv: &str) -> Vec<String> {
        let mut ids = Vec::new();
        for (role, text) in [
            ("user", "u1"),
            ("assistant", "a1"),
            ("user", "u2"),
            ("assistant", "a2"),
        ] {
            ids.push(
                store
                    .append_message(conv, role, text, None, None, None)
                    .await
                    .unwrap(),
            );
        }
        store
            .select_version(conv, &ids[3])
            .await
            .unwrap()
            .expect("leaf");
        ids
    }

    async fn insert_synced(store: &ConversationStore, conv: &str, rows: &[(&str, &str, &str)]) {
        let later = now_millis() + 1_000;
        for (offset, (id, role, text)) in rows.iter().enumerate() {
            assert!(store
                .append_sync_message_with_id(conv, id, role, text, None, later + offset as i64)
                .await
                .unwrap());
        }
    }

    fn sync_link(id: &str, parent: SyncParent) -> SyncLink {
        SyncLink {
            id: id.to_owned(),
            parent,
        }
    }

    #[tokio::test]
    async fn checkpoint_import_chains_onto_the_branched_thread_it_continues() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-sync-link-checkpoint";
        let ids = branched_resume_target(&store, conv).await;
        insert_synced(
            &store,
            conv,
            &[("g-u3", "user", "u3"), ("g-a3", "assistant", "a3")],
        )
        .await;
        // A linear checkpoint: the first row's position is unknown, each later
        // row replies to its predecessor.
        let mut links = vec![sync_link(&ids[0], SyncParent::Unknown)];
        for pair in ids.windows(2) {
            links.push(sync_link(&pair[1], SyncParent::Message(pair[0].clone())));
        }
        links.push(sync_link("g-u3", SyncParent::Message(ids[3].clone())));
        links.push(sync_link("g-a3", SyncParent::Message("g-u3".to_owned())));
        store
            .link_synced_messages(conv, &links, &owned_id_set(&["g-u3", "g-a3"]))
            .await
            .unwrap();

        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(contents(&active), ["u1", "a1", "u2", "a2", "u3", "a3"]);
        // Rows that already existed are never re-parented.
        assert_eq!(active[0].parent_message_id, None);
    }

    /// Walk every stored row's parent chain; panics if one loops.
    async fn assert_acyclic(store: &ConversationStore, conv: &str) {
        let stored = store.get_messages(conv).await.unwrap();
        let parents: std::collections::HashMap<&str, Option<&str>> = stored
            .iter()
            .map(|m| (m.id.as_str(), m.parent_message_id.as_deref()))
            .collect();
        for start in parents.keys() {
            let mut current = Some(*start);
            let mut steps = 0;
            while let Some(id) = current {
                steps += 1;
                assert!(steps <= parents.len(), "parent loop through {start}");
                current = parents.get(id).copied().flatten();
            }
        }
    }

    #[tokio::test]
    async fn synced_parents_that_would_close_a_loop_continue_the_thread() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-sync-link-cycle";
        let ids = branched_resume_target(&store, conv).await;
        insert_synced(
            &store,
            conv,
            &[
                ("s-x", "user", "x"),
                ("s-y", "assistant", "y"),
                ("s-z", "user", "z"),
            ],
        )
        .await;
        // A relayed payload naming rows as each other's (and their own) parent.
        let links = [
            sync_link("s-x", SyncParent::Message("s-y".to_owned())),
            sync_link("s-y", SyncParent::Message("s-x".to_owned())),
            sync_link("s-z", SyncParent::Message("s-z".to_owned())),
        ];
        store
            .link_synced_messages(conv, &links, &owned_id_set(&["s-x", "s-y", "s-z"]))
            .await
            .unwrap();

        assert_acyclic(&store, conv).await;
        let stored = store.get_messages(conv).await.unwrap();
        let parent_of = |id: &str| {
            stored
                .iter()
                .find(|m| m.id == id)
                .and_then(|m| m.parent_message_id.clone())
        };
        assert_eq!(parent_of("s-x").as_deref(), Some("s-y"));
        assert_eq!(parent_of("s-y").as_deref(), Some(ids[3].as_str()));
        assert_eq!(parent_of("s-z").as_deref(), Some("s-y"));
        // Selecting any of them descends to a leaf instead of spinning.
        assert!(store.select_version(conv, "s-x").await.unwrap().is_some());
        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(contents(&active), ["u1", "a1", "u2", "a2", "y", "x"]);
    }

    #[tokio::test]
    async fn linearize_never_turns_a_stale_first_row_parent_into_a_ring() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-linearize-ring";
        let mut ids = Vec::new();
        for (role, text) in [("user", "u1"), ("assistant", "a1"), ("user", "u2")] {
            ids.push(
                store
                    .append_message(conv, role, text, None, None, None)
                    .await
                    .unwrap(),
            );
        }
        // A flat row may hold a parent naming a later row (relayed or legacy).
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE messages SET parent_message_id = ?1 WHERE id = ?2",
                params![ids[2], ids[0]],
            )
            .unwrap();

        let leaf = store.select_version(conv, &ids[0]).await.unwrap();
        assert_eq!(leaf.as_deref(), Some(ids[2].as_str()));
        assert_acyclic(&store, conv).await;
        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(contents(&active), ["u1", "a1", "u2"]);
    }

    #[tokio::test]
    async fn synced_rows_with_no_known_parent_continue_the_thread_in_any_order() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-sync-link-unknown";
        let ids = branched_resume_target(&store, conv).await;
        insert_synced(
            &store,
            conv,
            &[
                ("s-a3", "assistant", "a3"),
                ("s-u3", "user", "u3"),
                ("s-root", "user", "edited first turn"),
                ("s-orphan", "user", "orphan"),
            ],
        )
        .await;
        let links = [
            // A parent the receiver does not hold falls back to appending.
            sync_link("s-orphan", SyncParent::Message("missing".to_owned())),
            // A child listed before its parent still ends up selected.
            sync_link("s-a3", SyncParent::Message("s-u3".to_owned())),
            // Later rows with no position chain beneath the earlier ones.
            sync_link("s-u3", SyncParent::Unknown),
            // A genuine root stays an alternate first turn.
            sync_link("s-root", SyncParent::Root),
        ];
        store
            .link_synced_messages(
                conv,
                &links,
                &owned_id_set(&["s-a3", "s-u3", "s-root", "s-orphan"]),
            )
            .await
            .unwrap();

        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&active),
            ["u1", "a1", "u2", "a2", "orphan", "u3", "a3"]
        );
        assert_eq!(
            active[0].sibling_count, 2,
            "the root is a first-turn version"
        );
        let stored = store.get_messages(conv).await.unwrap();
        let parent_of = |id: &str| {
            stored
                .iter()
                .find(|m| m.id == id)
                .and_then(|m| m.parent_message_id.clone())
        };
        assert_eq!(parent_of("s-orphan").as_deref(), Some(ids[3].as_str()));
        assert_eq!(parent_of("s-u3").as_deref(), Some("s-orphan"));
        assert_eq!(parent_of("s-a3").as_deref(), Some("s-u3"));
        assert_eq!(parent_of("s-root"), None);
    }

    #[tokio::test]
    async fn resumed_context_keeps_the_targets_newer_local_turns_selected() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-resume-context-only";
        let ids = branched_resume_target(&store, conv).await;
        // The target kept chatting after the export's checkpoint (a2).
        store
            .append_message(conv, "user", "u3", None, None, None)
            .await
            .unwrap();
        store
            .append_message(conv, "assistant", "a3", None, None, None)
            .await
            .unwrap();
        insert_synced(
            &store,
            conv,
            &[("rnp-context-x", "user", "[Imported context: notes]")],
        )
        .await;
        let context = owned_ids(&["rnp-context-x"]);
        store
            .link_resumed_messages(conv, &ids, &context, &owned_id_set(&["rnp-context-x"]))
            .await
            .unwrap();

        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&active),
            [
                "u1",
                "a1",
                "u2",
                "a2",
                "u3",
                "a3",
                "[Imported context: notes]"
            ]
        );
    }

    #[tokio::test]
    async fn divergent_resumed_turns_become_a_branch_without_moving_the_leaf() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-resume-divergent";
        let ids = branched_resume_target(&store, conv).await;
        store
            .append_message(conv, "user", "local u3", None, None, None)
            .await
            .unwrap();
        store
            .append_message(conv, "assistant", "local a3", None, None, None)
            .await
            .unwrap();
        insert_synced(
            &store,
            conv,
            &[
                ("b-u3", "user", "remote u3"),
                ("b-a3", "assistant", "remote a3"),
                ("rnp-context-y", "user", "[Imported context: remote notes]"),
            ],
        )
        .await;
        let mut transcript = ids;
        transcript.extend(owned_ids(&["b-u3", "b-a3"]));
        let context = owned_ids(&["rnp-context-y"]);
        store
            .link_resumed_messages(
                conv,
                &transcript,
                &context,
                &owned_id_set(&["b-u3", "b-a3", "rnp-context-y"]),
            )
            .await
            .unwrap();

        // The target's own newer turns stay on the active thread.
        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&active),
            ["u1", "a1", "u2", "a2", "local u3", "local a3"]
        );
        // The remote turns are a sibling branch under the shared row, with their
        // context, and selecting it shows the resumed work.
        store
            .select_version(conv, "rnp-context-y")
            .await
            .unwrap()
            .expect("leaf");
        let branch = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&branch),
            [
                "u1",
                "a1",
                "u2",
                "a2",
                "remote u3",
                "remote a3",
                "[Imported context: remote notes]"
            ]
        );
    }

    #[tokio::test]
    async fn resumed_rows_sharing_nothing_with_the_target_append_beneath_the_leaf() {
        let store = ConversationStore::open_in_memory().unwrap();
        let conv = "conv-resume-disjoint";
        branched_resume_target(&store, conv).await;
        // A `Recent { max_messages }` export that starts past the target's history.
        insert_synced(
            &store,
            conv,
            &[
                ("b-u5", "user", "remote u5"),
                ("b-a5", "assistant", "remote a5"),
            ],
        )
        .await;
        let transcript = owned_ids(&["b-u5", "b-a5"]);
        store
            .link_resumed_messages(conv, &transcript, &[], &owned_id_set(&["b-u5", "b-a5"]))
            .await
            .unwrap();

        let active = store.get_active_messages(conv).await.unwrap();
        assert_eq!(
            contents(&active),
            ["u1", "a1", "u2", "a2", "remote u5", "remote a5"]
        );
    }

    #[test]
    fn title_truncates_long_first_line() {
        let long = "a".repeat(100);
        let title = derive_title(&long).expect("a non-empty message derives a title");
        assert!(title.chars().count() <= 61); // 60 chars + ellipsis
        assert!(title.ends_with('…'));
        // A text-less turn derives nothing rather than pinning a placeholder the
        // upsert's COALESCE would then keep forever.
        assert_eq!(derive_title("   \n  "), None);
        assert_eq!(derive_title(""), None);
    }

    #[tokio::test]
    async fn session_round_trip_with_existing_conversation_store() {
        let store = ConversationStore::open_in_memory().unwrap();

        // Create a session bound to an agent Runnable.
        let session = store
            .create_session(
                "agent-abc",
                RunnableKind::Agent,
                Some("agent-abc"),
                Some("Test session"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();

        assert_eq!(session.runnable_id, "agent-abc");
        assert_eq!(session.runnable_kind, RunnableKind::Agent);
        assert_eq!(session.status, SessionStatus::Idle);

        // Append a message via the existing ConversationStore path (no duplicate store).
        store
            .append_message(
                &session.conversation_id,
                "user",
                "Hello from session test",
                Some("agent-abc"),
                None,
                None,
            )
            .await
            .unwrap();

        // Reload session and verify state.
        let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(reloaded.id, session.id);
        assert_eq!(reloaded.runnable_kind, RunnableKind::Agent);
        assert_eq!(reloaded.status, SessionStatus::Idle);

        // Verify the message is accessible through the existing store.
        let msgs = store.get_messages(&session.conversation_id).await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "Hello from session test");

        // Update status and verify round-trip.
        let updated = store
            .update_session_status(&session.id, SessionStatus::Running)
            .await
            .unwrap();
        assert!(updated);

        let after_update = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(after_update.status, SessionStatus::Running);
    }

    #[tokio::test]
    async fn session_runnable_kind_round_trips_for_workflow() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = store
            .create_session(
                "wf-xyz",
                RunnableKind::Workflow,
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(reloaded.runnable_kind, RunnableKind::Workflow);
    }

    fn double_text_request(prompt: &str, strategy: Option<MultitaskStrategy>) -> StartRunRequest {
        StartRunRequest {
            input: serde_json::json!({ "prompt": prompt }),
            idempotency_key: None,
            execution_profile: None,
            resume_run_id: None,
            multitask_strategy: strategy,
        }
    }

    async fn double_text_session(store: &ConversationStore) -> Session {
        store
            .create_session(
                "agent-double-text",
                RunnableKind::Agent,
                Some("agent-double-text"),
                Some("Double text"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn harness_double_text_reject_is_default_and_enqueue_is_fifo() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = double_text_session(&store).await;
        let active = store
            .start_harness_run(&session.id, &double_text_request("first", None))
            .await
            .unwrap();
        assert_eq!(active.run.status, HarnessRunStatus::Running);
        assert!(active.displaced_run_id.is_none());

        let rejected = store
            .start_harness_run(&session.id, &double_text_request("again", None))
            .await
            .unwrap_err()
            .to_string();
        assert!(rejected.contains("active run"), "{rejected}");

        let second = store
            .start_harness_run(
                &session.id,
                &double_text_request("second", Some(MultitaskStrategy::Enqueue)),
            )
            .await
            .unwrap();
        let third = store
            .start_harness_run(
                &session.id,
                &double_text_request("third", Some(MultitaskStrategy::Enqueue)),
            )
            .await
            .unwrap();
        assert_eq!(second.run.status, HarnessRunStatus::Pending);
        assert_eq!(second.run.started_at, None);
        assert_eq!(second.run.event_cursor, 1);
        assert_eq!(
            second.run.multitask_strategy,
            Some(MultitaskStrategy::Enqueue)
        );
        let queued_events = store
            .list_harness_events(&third.run.id, 0, 10)
            .await
            .unwrap();
        assert_eq!(
            queued_events[0].event,
            RunEvent::RunQueued {
                position: 2,
                strategy: MultitaskStrategy::Enqueue,
                active_run_id: Some(active.run.id.clone()),
            }
        );

        // Reject also refuses to jump a non-empty queue.
        assert!(store
            .start_harness_run(&session.id, &double_text_request("x", None))
            .await
            .is_err());
        // The live run still describes the session while others wait.
        let projected = store
            .get_harness_session(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projected.status, HarnessRunStatus::Running);
        assert_eq!(
            store
                .list_sessions_with_queued_harness_runs()
                .await
                .unwrap(),
            vec![QueuedHarnessSession {
                session_id: session.id.clone(),
                attributed: false,
            }]
        );

        // Nothing is promoted while a run is active.
        assert!(store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .is_none());
        store
            .finish_harness_run(&active.run.id, HarnessRunStatus::Completed, None, None)
            .await
            .unwrap();
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .expect("second run is promoted");
        assert_eq!(promoted.run.id, second.run.id);
        assert_eq!(promoted.run.status, HarnessRunStatus::Running);
        assert!(promoted.run.started_at.is_some());
        assert_eq!(promoted.input, serde_json::json!({ "prompt": "second" }));
        assert_eq!(promoted.conversation_id, session.conversation_id);
        let events = store
            .list_harness_events(&second.run.id, 0, 10)
            .await
            .unwrap();
        let kinds: Vec<_> = events
            .iter()
            .map(|event| serde_json::to_value(&event.event).unwrap()["type"].clone())
            .collect();
        assert_eq!(kinds, ["run_queued", "run_started", "input_accepted"]);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2, 3]);
        // A second promotion cannot start the third run alongside the second.
        assert!(store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .is_none());

        // Canceling a queued run leaves the live run's session status alone.
        store
            .finish_harness_run(&third.run.id, HarnessRunStatus::Canceled, None, None)
            .await
            .unwrap();
        let projected = store
            .get_harness_session(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projected.status, HarnessRunStatus::Running);
        let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(reloaded.status, SessionStatus::Running);
    }

    #[tokio::test]
    async fn harness_preempting_runs_jump_the_queue_and_rollback_removes_turns() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = double_text_session(&store).await;
        let conversation = session.conversation_id.clone();
        store
            .append_message_at(
                &conversation,
                "user",
                "earlier turn",
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(1_000),
            )
            .await
            .unwrap();
        let active = store
            .start_harness_run(&session.id, &double_text_request("draft", None))
            .await
            .unwrap();
        let later = now_millis() + 60_000;
        for (role, text) in [("user", "draft"), ("assistant", "partial answ")] {
            store
                .append_message_at(
                    &conversation,
                    role,
                    text,
                    None,
                    None,
                    None,
                    Tenancy::Unattributed,
                    Some(later),
                )
                .await
                .unwrap();
        }
        let waiting = store
            .start_harness_run(
                &session.id,
                &double_text_request("queued", Some(MultitaskStrategy::Enqueue)),
            )
            .await
            .unwrap();
        assert!(waiting.displaced_run_id.is_none());
        let rollback = store
            .start_harness_run(
                &session.id,
                &double_text_request("replace", Some(MultitaskStrategy::Rollback)),
            )
            .await
            .unwrap();
        assert_eq!(rollback.run.status, HarnessRunStatus::Pending);
        assert_eq!(
            rollback.displaced_run_id.as_deref(),
            Some(active.run.id.as_str())
        );
        let queued = store
            .list_harness_events(&rollback.run.id, 0, 1)
            .await
            .unwrap();
        assert!(matches!(
            queued[0].event,
            RunEvent::RunQueued {
                position: 1,
                strategy: MultitaskStrategy::Rollback,
                ..
            }
        ));

        store
            .finish_harness_run(
                &active.run.id,
                HarnessRunStatus::Canceled,
                Some("rolled back"),
                None,
            )
            .await
            .unwrap();
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .expect("rollback run is promoted first");
        assert_eq!(promoted.run.id, rollback.run.id);
        assert_eq!(promoted.removed_messages, 2);
        let remaining: Vec<_> = store
            .get_messages(&conversation)
            .await
            .unwrap()
            .into_iter()
            .map(|message| message.content)
            .collect();
        assert_eq!(remaining, ["earlier turn"]);
        let canceled = store
            .get_harness_run(&active.run.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(canceled.status, HarnessRunStatus::Canceled);
        assert_eq!(canceled.error.as_deref(), Some("rolled back"));

        // The enqueued run waits for the rollback run, then starts.
        store
            .finish_harness_run(&rollback.run.id, HarnessRunStatus::Completed, None, None)
            .await
            .unwrap();
        let next = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .expect("enqueued run follows");
        assert_eq!(next.run.id, waiting.run.id);
        assert_eq!(next.removed_messages, 0);
    }

    #[tokio::test]
    async fn harness_rollback_keeps_turns_of_a_run_that_completed_in_between() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = double_text_session(&store).await;
        let conversation = session.conversation_id.clone();
        let active = store
            .start_harness_run(&session.id, &double_text_request("draft", None))
            .await
            .unwrap();
        let active_started = store
            .get_harness_run(&active.run.id)
            .await
            .unwrap()
            .unwrap()
            .started_at
            .map(|started_at| rfc3339_to_millis(&started_at))
            .expect("the first run starts immediately");
        store
            .append_message_at(
                &conversation,
                "user",
                "draft",
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(active_started),
            )
            .await
            .unwrap();
        // Double text: an interrupt and then a rollback both displace the run.
        let interrupt = store
            .start_harness_run(
                &session.id,
                &double_text_request("interrupt", Some(MultitaskStrategy::Interrupt)),
            )
            .await
            .unwrap();
        let rollback = store
            .start_harness_run(
                &session.id,
                &double_text_request("replace", Some(MultitaskStrategy::Rollback)),
            )
            .await
            .unwrap();
        assert_eq!(
            interrupt.displaced_run_id.as_deref(),
            Some(active.run.id.as_str())
        );
        assert_eq!(
            rollback.displaced_run_id.as_deref(),
            Some(active.run.id.as_str())
        );
        store
            .finish_harness_run(&active.run.id, HarnessRunStatus::Canceled, None, None)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .expect("the interrupt is promoted first");
        assert_eq!(promoted.run.id, interrupt.run.id);
        assert_eq!(promoted.removed_messages, 0);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        for (role, text) in [("user", "interrupt"), ("assistant", "interrupt answer")] {
            store
                .append_message_at(
                    &conversation,
                    role,
                    text,
                    None,
                    None,
                    None,
                    Tenancy::Unattributed,
                    Some(now_millis()),
                )
                .await
                .unwrap();
        }
        store
            .finish_harness_run(&interrupt.run.id, HarnessRunStatus::Completed, None, None)
            .await
            .unwrap();
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .expect("the rollback follows");
        assert_eq!(promoted.run.id, rollback.run.id);
        assert_eq!(promoted.removed_messages, 1);
        let remaining: Vec<_> = store
            .get_messages(&conversation)
            .await
            .unwrap()
            .into_iter()
            .map(|message| message.content)
            .collect();
        assert_eq!(remaining, ["interrupt", "interrupt answer"]);
    }

    #[tokio::test]
    async fn harness_interrupt_keeps_the_partial_transcript_and_preempt_without_active_starts() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = double_text_session(&store).await;
        let conversation = session.conversation_id.clone();
        // With nothing active, interrupt starts immediately and displaces nothing.
        let first = store
            .start_harness_run(
                &session.id,
                &double_text_request("first", Some(MultitaskStrategy::Interrupt)),
            )
            .await
            .unwrap();
        assert_eq!(first.run.status, HarnessRunStatus::Running);
        assert!(first.displaced_run_id.is_none());
        store
            .append_message_at(
                &conversation,
                "assistant",
                "partial",
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(now_millis() + 60_000),
            )
            .await
            .unwrap();
        let interrupt = store
            .start_harness_run(
                &session.id,
                &double_text_request("second", Some(MultitaskStrategy::Interrupt)),
            )
            .await
            .unwrap();
        assert_eq!(
            interrupt.displaced_run_id.as_deref(),
            Some(first.run.id.as_str())
        );
        store
            .finish_harness_run(&first.run.id, HarnessRunStatus::Canceled, None, None)
            .await
            .unwrap();
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(promoted.run.id, interrupt.run.id);
        assert_eq!(promoted.removed_messages, 0);
        assert_eq!(store.get_messages(&conversation).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn harness_queue_survives_boot_reconciliation() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = double_text_session(&store).await;
        let active = store
            .start_harness_run(&session.id, &double_text_request("active", None))
            .await
            .unwrap();
        let queued = store
            .start_harness_run(
                &session.id,
                &double_text_request("later", Some(MultitaskStrategy::Enqueue)),
            )
            .await
            .unwrap();
        // Boot reconciliation closes the live run; the queued run stays pending
        // and is promoted next.
        {
            let mut conn = store.conn.lock().await;
            ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap();
        }
        let interrupted = store
            .get_harness_run(&active.run.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interrupted.status, HarnessRunStatus::Interrupted);
        let still_queued = store
            .get_harness_run(&queued.run.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_queued.status, HarnessRunStatus::Pending);
        assert_eq!(
            store
                .list_sessions_with_queued_harness_runs()
                .await
                .unwrap()
                .len(),
            1
        );
        let promoted = store
            .promote_next_harness_run(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(promoted.run.id, queued.run.id);
        assert_eq!(promoted.input, serde_json::json!({ "prompt": "later" }));
        assert!(store
            .list_sessions_with_queued_harness_runs()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn harness_run_is_idempotent_replayable_and_terminal() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = store
            .create_session(
                "agent-harness",
                RunnableKind::Agent,
                Some("agent-harness"),
                Some("Harness test"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let profile = ExecutionProfile::worktree(
            Some("/tmp/ryu-harness-project".to_owned()),
            Some("harness-test".to_owned()),
        );
        assert!(store
            .set_session_execution_profile(&session.id, &profile, None)
            .await
            .unwrap());

        let request = StartRunRequest {
            input: serde_json::json!({ "prompt": "inspect" }),
            idempotency_key: Some("turn-1".to_owned()),
            execution_profile: None,
            resume_run_id: None,
            multitask_strategy: None,
        };
        let first = store
            .start_harness_run(&session.id, &request)
            .await
            .unwrap();
        assert!(first.created);
        assert_eq!(first.run.attempt, 1);
        assert_eq!(first.run.status, HarnessRunStatus::Running);
        assert_eq!(first.run.event_cursor, 2);
        assert_eq!(first.run.execution_profile, profile);

        let replay = store
            .start_harness_run(&session.id, &request)
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.run.id, first.run.id);
        assert_eq!(replay.run.event_cursor, 2);

        let different_request = StartRunRequest {
            input: serde_json::json!({ "prompt": "different" }),
            idempotency_key: Some("turn-1".to_owned()),
            execution_profile: None,
            resume_run_id: None,
            multitask_strategy: None,
        };
        assert!(store
            .start_harness_run(&session.id, &different_request)
            .await
            .is_err());

        let delta = store
            .append_harness_event(
                &first.run.id,
                RunEvent::TextDelta {
                    delta: "done".to_owned(),
                },
            )
            .await
            .unwrap();
        assert_eq!(delta.seq, 3);
        let events = store
            .list_harness_events(&first.run.id, 0, 20)
            .await
            .unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[2].event,
            RunEvent::TextDelta {
                delta: "done".into()
            }
        );

        let finished = store
            .finish_harness_run(
                &first.run.id,
                HarnessRunStatus::Completed,
                None,
                Some(&serde_json::json!({ "text": "done" })),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(finished.status, HarnessRunStatus::Completed);
        assert_eq!(finished.event_cursor, 4);
        assert_eq!(finished.output, Some(serde_json::json!({ "text": "done" })));

        // A late duplicate terminal callback is a no-op and cannot overwrite
        // the successful result.
        let duplicate = store
            .finish_harness_run(
                &first.run.id,
                HarnessRunStatus::Failed,
                Some("late failure"),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(duplicate.status, HarnessRunStatus::Completed);
        assert_eq!(
            duplicate.output,
            Some(serde_json::json!({ "text": "done" }))
        );
    }

    #[test]
    fn folder_paths_normalize_to_one_spelling() {
        // The reported bug: an imported thread's cwd and a native run's folder
        // differ only in punctuation and became two sidebar project folders.
        assert_eq!(
            normalize_folder_path("/Users/j/Code/ryu/"),
            normalize_folder_path("/Users/j/Code/ryu")
        );
        assert_eq!(
            normalize_folder_path("/Users/j//Code/ryu"),
            "/Users/j/Code/ryu"
        );
        assert_eq!(
            normalize_folder_path("  /Users/j/Code/ryu  "),
            "/Users/j/Code/ryu"
        );
        // Roots survive: stripping these would leave a string that names nothing.
        assert_eq!(normalize_folder_path("/"), "/");
        assert_eq!(normalize_folder_path("C:\\"), "C:\\");
        // Case is preserved — the leaf is the project's display name.
        assert_eq!(normalize_folder_path("/Users/J/Code"), "/Users/J/Code");
        // Windows separators survive as backslashes.
        assert_eq!(
            normalize_folder_path("C:\\Users\\j\\Code\\ryu\\"),
            "C:\\Users\\j\\Code\\ryu"
        );
    }

    #[tokio::test]
    async fn run_metadata_round_trips_and_migration_is_idempotent() {
        // Build a store via the normal path (exercises init_schema including the
        // ALTER TABLE migration).
        let store = ConversationStore::open_in_memory().unwrap();

        // Verify that calling init_schema a second time on the same connection
        // (the migration no-op path) does not error and leaves existing data intact.
        {
            let conn = store.conn.lock().await;
            ConversationStore::init_schema(&conn).expect("second init_schema must be a no-op");
        }

        // Create a conversation and set run metadata.
        store
            .append_message("conv-run", "user", "hello", Some("agent-1"), None, None)
            .await
            .unwrap();

        store
            .set_run_metadata("conv-run", Some("/home/user/project"), Some("main"), None)
            .await
            .unwrap();
        store.set_run_status("conv-run", "running").await.unwrap();

        // list_conversations must return the new fields.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list.len(), 1);
        let summary = &list[0];
        assert_eq!(summary.folder_path.as_deref(), Some("/home/user/project"));
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.worktree_path.is_none());
        assert_eq!(summary.run_status.as_deref(), Some("running"));

        // Update status to completed.
        store.set_run_status("conv-run", "completed").await.unwrap();
        let list2 = store.list_conversations().await.unwrap();
        assert_eq!(list2[0].run_status.as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn run_metadata_null_fields_preserved_when_unset() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-null", "user", "hi", None, None, None)
            .await
            .unwrap();

        // No metadata set — all new fields must be None.
        let list = store.list_conversations().await.unwrap();
        assert_eq!(list[0].folder_path, None);
        assert_eq!(list[0].branch, None);
        assert_eq!(list[0].worktree_path, None);
        assert_eq!(list[0].run_status, None);
    }

    #[tokio::test]
    async fn terminal_run_retry_claim_is_atomic_and_bounded() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-retry",
                "user",
                "continue this",
                Some("agent-1"),
                None,
                None,
            )
            .await
            .unwrap();
        store.set_run_status("conv-retry", "failed").await.unwrap();

        assert!(store
            .claim_terminal_run_for_retry("conv-retry")
            .await
            .unwrap());
        assert!(!store
            .claim_terminal_run_for_retry("conv-retry")
            .await
            .unwrap());
        assert_eq!(
            store
                .get_run_summary("conv-retry")
                .await
                .unwrap()
                .and_then(|summary| summary.run_status),
            Some("running".to_owned())
        );
    }

    // ── Multi-agent participants (#414) ───────────────────────────────────────

    #[tokio::test]
    async fn participants_add_remove_roundtrip() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-multi",
                "user",
                "hello",
                Some("agent-alpha"),
                None,
                None,
            )
            .await
            .unwrap();

        // Start with no participants.
        let initial = store.get_participants("conv-multi").await.unwrap();
        assert!(initial.is_empty(), "new conversation has no participants");

        // Add two agents.
        let after_add1 = store
            .add_participant("conv-multi", "agent-alpha", Tenancy::Unattributed)
            .await
            .unwrap();
        assert_eq!(after_add1, vec!["agent-alpha"]);

        let after_add2 = store
            .add_participant("conv-multi", "agent-beta", Tenancy::Unattributed)
            .await
            .unwrap();
        assert_eq!(after_add2, vec!["agent-alpha", "agent-beta"]);

        // Idempotent: adding agent-alpha again changes nothing.
        let after_dup = store
            .add_participant("conv-multi", "agent-alpha", Tenancy::Unattributed)
            .await
            .unwrap();
        assert_eq!(after_dup, vec!["agent-alpha", "agent-beta"]);

        // Remove one.
        let after_remove = store
            .remove_participant("conv-multi", "agent-alpha")
            .await
            .unwrap();
        assert_eq!(after_remove, vec!["agent-beta"]);

        // Verify via get_participants.
        let final_list = store.get_participants("conv-multi").await.unwrap();
        assert_eq!(final_list, vec!["agent-beta"]);
    }

    // ── Crash recovery: turns the node died in the middle of ──────────────────

    #[tokio::test]
    async fn reconcile_interrupted_runs_marks_the_truncated_trailing_turn() {
        let store = ConversationStore::open_in_memory().unwrap();

        // A conversation the node died mid-turn on: the assistant row holds only
        // what the incremental flush had written, and the run is still "running".
        store
            .append_message("conv-crash", "user", "write me an essay", None, None, None)
            .await
            .unwrap();
        let truncated = store
            .append_message(
                "conv-crash",
                "assistant",
                "Sure — here is the fi",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store.set_run_status("conv-crash", "running").await.unwrap();

        // A conversation that finished cleanly must be left alone.
        store
            .append_message("conv-ok", "user", "hi", None, None, None)
            .await
            .unwrap();
        let finished = store
            .append_message("conv-ok", "assistant", "hello!", None, None, None)
            .await
            .unwrap();
        store.set_run_status("conv-ok", "completed").await.unwrap();

        let (runs, flagged) = {
            let mut conn = store.conn.lock().await;
            ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
        };
        assert_eq!(runs, 1, "only the stuck run is reconciled");
        assert_eq!(flagged, 1, "only its trailing assistant row is flagged");

        let crashed = store.get_messages("conv-crash").await.unwrap();
        assert!(
            !crashed[0].interrupted,
            "the user turn is never marked interrupted"
        );
        assert!(
            crashed[1].interrupted && crashed[1].id == truncated,
            "the trailing assistant row carries the marker"
        );
        // The text that was never written is gone — the marker is what makes the
        // truncation visible, it does not restore it.
        assert_eq!(crashed[1].content, "Sure — here is the fi");

        let ok = store.get_messages("conv-ok").await.unwrap();
        assert!(
            !ok.iter().any(|m| m.interrupted),
            "a completed run's rows are untouched"
        );
        assert_eq!(ok[1].id, finished);

        let summaries = store.list_conversations().await.unwrap();
        let crashed_summary = summaries.iter().find(|c| c.id == "conv-crash").unwrap();
        assert_eq!(crashed_summary.run_status.as_deref(), Some("interrupted"));

        // Idempotent: a second boot flips nothing further (there is no `running`
        // row left) and does not re-flag anything.
        let (runs2, flagged2) = {
            let mut conn = store.conn.lock().await;
            ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
        };
        assert_eq!((runs2, flagged2), (0, 0));
    }

    #[tokio::test]
    async fn boot_capture_lists_only_runs_that_were_live() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (id, status) in [
            ("live-a", "running"),
            ("done", "completed"),
            ("old-crash", "interrupted"),
            ("live-b", "running"),
        ] {
            store
                .append_message(id, "user", "go", None, None, None)
                .await
                .unwrap();
            store.set_run_status(id, status).await.unwrap();
        }
        let captured = {
            let conn = store.conn.lock().await;
            ConversationStore::list_running_conversations(&conn).unwrap()
        };
        assert_eq!(captured, vec!["live-a".to_owned(), "live-b".to_owned()]);
        // The in-memory store never boots, so it has nothing to hand out.
        assert!(store.take_boot_interrupted_runs().is_empty());
    }

    #[tokio::test]
    async fn auto_resume_claim_is_bounded_per_user_turn() {
        let store = ConversationStore::open_in_memory().unwrap();
        let first_turn = store
            .append_message("conv", "user", "build it", None, None, None)
            .await
            .unwrap();
        store.set_run_status("conv", "interrupted").await.unwrap();

        let claim = store
            .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
            .await
            .unwrap();
        assert!(
            matches!(claim, AutoResumeClaim::Claimed { attempt: 1, .. }),
            "{claim:?}"
        );
        let status = store
            .get_run_summary("conv")
            .await
            .unwrap()
            .unwrap()
            .run_status;
        assert_eq!(status.as_deref(), Some("running"));
        // Already running: a racing claim (or a desktop retry) loses.
        assert_eq!(
            store
                .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
                .await
                .unwrap(),
            AutoResumeClaim::NotInterrupted
        );

        // The resumed turn took the node down again: the next boot gets one
        // more try, then the turn is left for the user.
        store.set_run_status("conv", "interrupted").await.unwrap();
        let claim = store
            .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
            .await
            .unwrap();
        assert!(
            matches!(claim, AutoResumeClaim::Claimed { attempt: 2, .. }),
            "{claim:?}"
        );
        store.set_run_status("conv", "interrupted").await.unwrap();
        assert_eq!(
            store
                .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
                .await
                .unwrap(),
            AutoResumeClaim::Exhausted
        );
        let status = store
            .get_run_summary("conv")
            .await
            .unwrap()
            .unwrap()
            .run_status;
        assert_eq!(
            status.as_deref(),
            Some("interrupted"),
            "exhausted runs stay put"
        );

        // A new user turn starts a fresh budget.
        let second_turn = store
            .append_message("conv", "user", "try again", None, None, None)
            .await
            .unwrap();
        let claim = store
            .claim_interrupted_run_for_auto_resume("conv", &second_turn, 2)
            .await
            .unwrap();
        assert!(
            matches!(claim, AutoResumeClaim::Claimed { attempt: 1, .. }),
            "{claim:?}"
        );
    }

    #[tokio::test]
    async fn auto_resume_never_claims_a_conversation_owned_by_a_person() {
        let store = ConversationStore::open_in_memory().unwrap();
        for (id, owner, org) in [
            ("alice-chat", Some("alice"), Some("org1")),
            ("org-chat", None, Some("org1")),
        ] {
            let turn = store
                .append_message(id, "user", "build it", None, None, None)
                .await
                .unwrap();
            store
                .conn
                .lock()
                .await
                .execute(
                    "UPDATE conversations SET owner_user_id = ?1, org_id = ?2 WHERE id = ?3",
                    params![owner, org, id],
                )
                .unwrap();
            store.set_run_status(id, "interrupted").await.unwrap();

            // A detached resume has no verified caller to run as, so it must
            // not pick up a person's turn with node authority.
            assert_eq!(
                store
                    .claim_interrupted_run_for_auto_resume(id, &turn, 2)
                    .await
                    .unwrap(),
                AutoResumeClaim::Attributed
            );
            let status = store.get_run_summary(id).await.unwrap().unwrap().run_status;
            assert_eq!(
                status.as_deref(),
                Some("interrupted"),
                "{id} is left for its author to retry"
            );
            let attempts: i64 = store
                .conn
                .lock()
                .await
                .query_row(
                    "SELECT COUNT(*) FROM run_auto_resume WHERE conversation_id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(attempts, 0, "{id} spends no resume budget");
        }
    }

    #[tokio::test]
    async fn unstarted_auto_resume_fails_only_when_no_turn_took_over() {
        let store = ConversationStore::open_in_memory().unwrap();
        let turn = store
            .append_message("conv", "user", "build it", None, None, None)
            .await
            .unwrap();
        store.set_run_status("conv", "interrupted").await.unwrap();
        let AutoResumeClaim::Claimed { claimed_at, .. } = store
            .claim_interrupted_run_for_auto_resume("conv", &turn, 2)
            .await
            .unwrap()
        else {
            panic!("claim should succeed");
        };

        // A turn that started rewrote `running` with a newer timestamp.
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE conversations SET updated_at = ?1 WHERE id = 'conv'",
                params![claimed_at + 1],
            )
            .unwrap();
        assert!(!store
            .fail_unstarted_auto_resume("conv", claimed_at)
            .await
            .unwrap());

        // Nothing touched the run since the claim: the turn never started.
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE conversations SET updated_at = ?1 WHERE id = 'conv'",
                params![claimed_at],
            )
            .unwrap();
        assert!(store
            .fail_unstarted_auto_resume("conv", claimed_at)
            .await
            .unwrap());
        let status = store
            .get_run_summary("conv")
            .await
            .unwrap()
            .unwrap()
            .run_status;
        assert_eq!(status.as_deref(), Some("failed"));
    }

    #[tokio::test]
    async fn reconcile_interrupted_harness_run_appends_terminal_event() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = store
            .create_session(
                "agent-1",
                RunnableKind::Agent,
                Some("agent-1"),
                Some("Harness crash"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let started = store
            .start_harness_run(
                &session.id,
                &StartRunRequest {
                    input: serde_json::json!({ "prompt": "continue" }),
                    idempotency_key: None,
                    execution_profile: None,
                    resume_run_id: None,
                    multitask_strategy: None,
                },
            )
            .await
            .unwrap();
        store
            .set_harness_run_status(&started.run.id, HarnessRunStatus::AwaitingApproval)
            .await
            .unwrap();

        let (runs, flagged) = {
            let mut conn = store.conn.lock().await;
            ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
        };
        assert_eq!((runs, flagged), (1, 0));

        let run = store
            .get_harness_run(&started.run.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.status, HarnessRunStatus::Interrupted);
        assert_eq!(run.event_cursor, 3);
        let events = store
            .list_harness_events(&started.run.id, 0, 10)
            .await
            .unwrap();
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events.get(1).map(|event| &event.event),
            Some(RunEvent::InputAccepted {
                message_count: 1,
                ..
            })
        ));
        assert!(matches!(
            events.last().map(|event| &event.event),
            Some(RunEvent::RunInterrupted)
        ));

        let session = store
            .get_harness_session(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.status, HarnessRunStatus::Interrupted);

        let (runs_again, flagged_again) = {
            let mut conn = store.conn.lock().await;
            ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
        };
        assert_eq!((runs_again, flagged_again), (0, 0));
        assert_eq!(
            store
                .list_harness_events(&started.run.id, 0, 10)
                .await
                .unwrap()
                .len(),
            3,
            "reconciliation must not append a second terminal event"
        );
    }

    #[tokio::test]
    async fn messages_carry_agent_id() {
        let store = ConversationStore::open_in_memory().unwrap();

        // Two agents in one conversation each produce a message.
        store
            .append_message("conv-agents", "user", "question", None, None, None)
            .await
            .unwrap();
        store
            .append_message(
                "conv-agents",
                "assistant",
                "reply from alpha",
                Some("agent-alpha"),
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "conv-agents",
                "assistant",
                "reply from beta",
                Some("agent-beta"),
                None,
                None,
            )
            .await
            .unwrap();

        let msgs = store.get_messages("conv-agents").await.unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].agent_id, None, "user message has no agent_id");
        assert_eq!(msgs[1].agent_id.as_deref(), Some("agent-alpha"));
        assert_eq!(msgs[2].agent_id.as_deref(), Some("agent-beta"));
    }

    #[tokio::test]
    async fn messages_carry_author_name() {
        // Group/channel support: a connector-supplied sender display name is
        // persisted on the user message and read back, while agent/1:1 messages
        // carry no author_name. (`author_user_id` stays None — author_name is the
        // unverified display label, distinct from a verified identity.)
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-grp",
                "user",
                "Alice: hi team",
                None,
                None,
                Some("Alice"),
            )
            .await
            .unwrap();
        store
            .append_message(
                "conv-grp",
                "assistant",
                "hello",
                Some("agent-x"),
                None,
                None,
            )
            .await
            .unwrap();

        let msgs = store.get_messages("conv-grp").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].author_name.as_deref(), Some("Alice"));
        assert_eq!(
            msgs[0].author_user_id, None,
            "display name is not a verified id"
        );
        assert_eq!(
            msgs[1].author_name, None,
            "agent message has no author_name"
        );
    }

    #[tokio::test]
    async fn get_conversation_detail_includes_participants() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message("conv-detail", "user", "hi", Some("agent-x"), None, None)
            .await
            .unwrap();
        store
            .add_participant("conv-detail", "agent-x", Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .add_participant("conv-detail", "agent-y", Tenancy::Unattributed)
            .await
            .unwrap();

        let detail = store
            .get_conversation_detail("conv-detail")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.id, "conv-detail");
        assert_eq!(detail.participants.len(), 2);
        assert!(detail.participants.contains(&"agent-x".to_owned()));
        assert!(detail.participants.contains(&"agent-y".to_owned()));
        assert_eq!(detail.messages.len(), 1);
    }

    #[tokio::test]
    async fn saving_a_temporary_snapshot_is_atomic_and_preserves_parts() {
        let store = ConversationStore::open_in_memory().unwrap();
        let messages = vec![
            TemporaryConversationMessage {
                metadata: None,
                role: "user".to_owned(),
                content: "Plan a private launch review".to_owned(),
                agent_id: None,
                author_user_id: None,
                parts: Some(
                    serde_json::json!([{ "type": "text", "text": "Plan a private launch review" }]),
                ),
                created_at: 10,
            },
            TemporaryConversationMessage {
                metadata: None,
                role: "assistant".to_owned(),
                content: "Here is a concise review plan.".to_owned(),
                agent_id: Some("agent-x".to_owned()),
                author_user_id: None,
                parts: Some(serde_json::json!([
                    { "type": "text", "text": "Here is a concise review plan." },
                    { "type": "data-note", "data": { "kind": "temporary" } }
                ])),
                created_at: 11,
            },
        ];

        let summary = store
            .save_temporary_conversation(
                "temporary-1",
                Some("agent-x"),
                Some("/tmp/project"),
                &messages,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        assert_eq!(summary.id, "temporary-1");
        assert_eq!(
            summary.title.as_deref(),
            Some("Plan a private launch review")
        );
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.folder_path.as_deref(), Some("/tmp/project"));

        let detail = store
            .get_conversation_detail("temporary-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].content, messages[0].content);
        assert_eq!(detail.messages[1].parts, messages[1].parts);
        assert!(store
            .save_temporary_conversation(
                "temporary-1",
                Some("agent-x"),
                None,
                &messages,
                Tenancy::Unattributed,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn conversation_message_pages_walk_backwards_from_latest() {
        let store = ConversationStore::open_in_memory().unwrap();
        for index in 0..5 {
            store
                .append_message(
                    "conv-page",
                    if index % 2 == 0 { "user" } else { "assistant" },
                    &format!("message-{index}"),
                    Some("agent-x"),
                    None,
                    None,
                )
                .await
                .unwrap();
        }

        let latest = store
            .get_conversation_message_page("conv-page", None, 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            latest
                .messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            ["message-3", "message-4"]
        );
        assert!(latest.has_older_messages);
        let cursor = latest.older_messages_cursor.clone().unwrap();

        let middle = store
            .get_conversation_message_page("conv-page", Some(&cursor), 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            middle
                .messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            ["message-1", "message-2"]
        );
        assert!(middle.has_older_messages);

        let oldest_cursor = middle.older_messages_cursor.clone().unwrap();
        let oldest = store
            .get_conversation_message_page("conv-page", Some(&oldest_cursor), 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(oldest.messages.len(), 1);
        assert_eq!(oldest.messages[0].content, "message-0");
        assert!(!oldest.has_older_messages);
        assert_eq!(oldest.older_messages_cursor, None);
    }

    // ── Version tree (edit + regenerate + select) ──────────────────────────

    /// Seed a 2-turn flat conversation: user "q1" → assistant "a1". Returns the
    /// two message ids.
    async fn seed_flat(store: &ConversationStore, conv: &str) -> (String, String) {
        let u = store
            .append_message(conv, "user", "q1", Some("agent-x"), None, None)
            .await
            .unwrap();
        let a = store
            .append_message(conv, "assistant", "a1", Some("agent-x"), None, None)
            .await
            .unwrap();
        (u, a)
    }

    #[tokio::test]
    async fn branched_pages_read_only_returned_payloads_and_preserve_cursor_order() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("branch-perf", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            for number in 0..1000 {
                let parent = (number > 0).then(|| format!("active-{}", number - 1));
                for prefix in ["active", "alternate"] {
                    conn.execute(
                        "INSERT INTO messages(id, conversation_id, role, content, created_at, parent_message_id)
                         VALUES (?1, 'branch-perf', 'user', 'history body', 1, ?2)",
                        params![format!("{prefix}-{number}"), parent],
                    ).unwrap();
                }
            }
            conn.execute(
                "UPDATE conversations SET active_leaf_message_id = 'active-999'
                WHERE id = 'branch-perf'",
                [],
            )
            .unwrap();
        }
        store.content_reads.store(0, Ordering::Relaxed);
        let page = store
            .get_conversation_message_page("branch-perf", None, 20)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 20);
        assert_eq!(page.messages.first().unwrap().id, "active-980");
        assert_eq!(page.messages.last().unwrap().id, "active-999");
        assert!(page.has_older_messages);
        assert!(page
            .messages
            .iter()
            .all(|message| message.sibling_count == 2 && message.sibling_index == 0));
        store.content_reads.store(0, Ordering::Relaxed);
        let older = store
            .get_conversation_message_page("branch-perf", page.older_messages_cursor.as_deref(), 20)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(older.messages.first().unwrap().id, "active-960");
        assert_eq!(older.messages.last().unwrap().id, "active-979");
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 20);
        let invalid = store
            .get_conversation_message_page("branch-perf", Some("alternate-500"), 20)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(invalid.messages.first().unwrap().id, "active-980");
        let oldest = store
            .get_conversation_message_page("branch-perf", Some("active-10"), 20)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(oldest.messages.len(), 10);
        assert!(!oldest.has_older_messages);
        assert_eq!(
            oldest.messages[0].sibling_ids,
            vec!["active-0", "alternate-0"]
        );
        store.content_reads.store(0, Ordering::Relaxed);
        assert_eq!(
            store
                .get_active_messages("branch-perf")
                .await
                .unwrap()
                .len(),
            1000
        );
        assert_eq!(
            store.content_reads.load(Ordering::Relaxed),
            1000,
            "inactive branches are never opened"
        );
    }

    #[tokio::test]
    async fn flat_conversation_stays_flat_until_edited() {
        let store = ConversationStore::open_in_memory().unwrap();
        seed_flat(&store, "conv-flat").await;
        // No branching yet: active messages == flat messages, no siblings, no
        // parent links (byte-identical to pre-tree behavior).
        let active = store.get_active_messages("conv-flat").await.unwrap();
        assert_eq!(active.len(), 2);
        assert!(active.iter().all(|m| m.parent_message_id.is_none()));
        assert!(active.iter().all(|m| m.sibling_count == 1));
    }

    #[tokio::test]
    async fn edit_user_message_creates_sibling_and_switches_active_path() {
        let store = ConversationStore::open_in_memory().unwrap();
        let (u, _a) = seed_flat(&store, "conv-edit").await;

        // Edit the user turn → new sibling, leaf now points at it. The old
        // assistant reply drops off the active path (its parent is the ORIGINAL
        // user turn, not the edit).
        let u2 = store
            .edit_user_message("conv-edit", &u, "q1-edited")
            .await
            .unwrap()
            .expect("edit returns new id");
        assert_ne!(u2, u);

        let active = store.get_active_messages("conv-edit").await.unwrap();
        assert_eq!(active.len(), 1, "only the edited user turn is active");
        assert_eq!(active[0].id, u2);
        assert_eq!(active[0].content, "q1-edited");
        // Two versions at this branch point: original + edit.
        assert_eq!(active[0].sibling_count, 2);
        assert_eq!(active[0].sibling_index, 1, "edit is the newer version");

        // A generated reply now attaches beneath the edit.
        store
            .append_message("conv-edit", "assistant", "a2", Some("agent-x"), None, None)
            .await
            .unwrap();
        let active = store.get_active_messages("conv-edit").await.unwrap();
        assert_eq!(active.len(), 2);
        assert_eq!(active[1].content, "a2");
        assert_eq!(active[1].parent_message_id.as_deref(), Some(u2.as_str()));
    }

    #[tokio::test]
    async fn select_version_restores_the_other_branch() {
        let store = ConversationStore::open_in_memory().unwrap();
        let (u, _a) = seed_flat(&store, "conv-sel").await;
        let u2 = store
            .edit_user_message("conv-sel", &u, "q1-edited")
            .await
            .unwrap()
            .unwrap();
        store
            .append_message("conv-sel", "assistant", "a2", Some("agent-x"), None, None)
            .await
            .unwrap();

        // Switch back to the ORIGINAL user version → its subtree (assistant "a1")
        // returns as the active path.
        let leaf = store
            .select_version("conv-sel", &u)
            .await
            .unwrap()
            .expect("select returns a leaf");
        let active = store.get_active_messages("conv-sel").await.unwrap();
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].id, u);
        assert_eq!(active[0].content, "q1");
        assert_eq!(active[1].content, "a1");
        assert_eq!(active[1].id, leaf);

        // Flip forward to the edit again.
        store.select_version("conv-sel", &u2).await.unwrap();
        let active = store.get_active_messages("conv-sel").await.unwrap();
        assert_eq!(active[0].content, "q1-edited");
        assert_eq!(active[1].content, "a2");
    }

    #[tokio::test]
    async fn regenerate_creates_assistant_sibling_under_same_user_turn() {
        let store = ConversationStore::open_in_memory().unwrap();
        let (u, a) = seed_flat(&store, "conv-regen").await;

        // Regenerate the assistant reply → leaf moves to the user turn above it.
        let parent = store
            .prepare_regenerate("conv-regen", &a)
            .await
            .unwrap()
            .expect("regenerate returns parent");
        assert_eq!(parent, u);

        // The fresh generation appends as a sibling of the old assistant reply.
        store
            .append_message(
                "conv-regen",
                "assistant",
                "a1-v2",
                Some("agent-x"),
                None,
                None,
            )
            .await
            .unwrap();
        let active = store.get_active_messages("conv-regen").await.unwrap();
        assert_eq!(active.len(), 2);
        assert_eq!(active[1].content, "a1-v2");
        assert_eq!(active[1].sibling_count, 2, "two assistant versions");
        assert_eq!(active[1].parent_message_id.as_deref(), Some(u.as_str()));
    }

    // ── Per-resource ACL: tenancy is actually POPULATED (the fix) ──────────────
    //
    // Before this, EVERY conversation row was created with `owner_user_id` and
    // `org_id` NULL, and `resource_access` (server/mod.rs) read NULL tenancy as
    // "the untenanted local row" and returned `Access::Write` unconditionally. The
    // gate existed, looked real, and enforced nothing. These tests pin the write
    // that makes it bite, and the SQL filter that mirrors it.

    #[tokio::test]
    async fn claim_tenancy_stamps_the_owner_on_a_brand_new_conversation() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("c1", "alice", Some("org1"))
            .await
            .unwrap();

        let meta = store.get_access_meta("c1").await.unwrap().expect("row");
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(meta.org_id.as_deref(), Some("org1"));
        assert_eq!(meta.visibility, "private");
    }

    #[tokio::test]
    async fn claim_tenancy_never_steals_an_already_owned_conversation() {
        // First-writer-wins. Two authenticated callers racing on the same id (or a
        // deliberate re-POST with someone else's conversation id) must not be able to
        // re-tenant a row — the loser is denied by the ACL on their next request.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("c1", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .claim_tenancy("c1", "mallory", Some("org1"))
            .await
            .unwrap();

        let meta = store.get_access_meta("c1").await.unwrap().expect("row");
        assert_eq!(
            meta.owner_user_id.as_deref(),
            Some("alice"),
            "an owned conversation must never be re-tenanted"
        );
    }

    #[tokio::test]
    async fn appending_a_message_does_not_wipe_the_claimed_owner() {
        // The silent-failure mode: `append_message` upserts the conversation row, so
        // if its ON CONFLICT clause rewrote the tenancy columns the claim would be
        // erased the moment the first message landed and the gate would go vacuous
        // again with every test still green.
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("c1", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("c1", "user", "hello", Some("ryu"), Some("alice"), None)
            .await
            .unwrap();

        let meta = store.get_access_meta("c1").await.unwrap().expect("row");
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(meta.org_id.as_deref(), Some("org1"));
    }

    #[tokio::test]
    async fn visible_lists_scope_to_the_caller_on_an_org_bound_node() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("alice-chat", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("alice-chat", "user", "secret", None, None, None)
            .await
            .unwrap();
        store
            .claim_tenancy("bob-chat", "bob", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("bob-chat", "user", "hi", None, None, None)
            .await
            .unwrap();
        // A pre-ACL row: no owner, no org. On a bound node it is unattributable.
        store
            .ensure_conversation("legacy", None, None, Tenancy::Unattributed)
            .await
            .unwrap();

        // Bob, on the org-bound node, sees only his own.
        let bob = store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        let ids: Vec<&str> = bob.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["bob-chat"], "bob must not see alice's chat");

        // Anonymous on a bound node: nothing.
        assert!(store
            .list_conversations_visible(None, None, true)
            .await
            .unwrap()
            .is_empty());

        // The same node UNBOUND (personal, local-first): everything, unchanged.
        assert_eq!(
            store
                .list_conversations_visible(None, None, false)
                .await
                .unwrap()
                .len(),
            3
        );

        // The search filter agrees with the list filter, so a semantic hit in
        // alice's chat can never surface for bob.
        let searchable = store
            .visible_conversation_ids(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        assert_eq!(searchable, vec!["bob-chat".to_owned()]);
        assert!(store
            .visible_conversation_ids(None, None, true)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn one_summary_lookup_matches_the_visible_list() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("alice-chat", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("alice-chat", "user", "secret", None, None, None)
            .await
            .unwrap();
        store
            .claim_tenancy("bob-chat", "bob", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("bob-chat", "user", "hi", None, None, None)
            .await
            .unwrap();

        let own = store
            .get_summary_visible("bob-chat", Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .expect("bob sees his chat");
        let listed = store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.id == "bob-chat")
            .unwrap();
        assert_eq!(own.id, listed.id);
        assert_eq!(own.title, listed.title);
        assert_eq!(own.message_count, listed.message_count);
        assert_eq!(own.run_status, listed.run_status);

        assert!(store
            .get_summary_visible("alice-chat", Some("bob"), Some("org1"), true)
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_summary_visible("missing", None, None, false)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn an_org_visible_conversation_is_listed_for_other_members() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("shared", "alice", Some("org1"))
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE conversations SET visibility = 'org' WHERE id = 'shared'",
                [],
            )
            .unwrap();
        }
        let bob = store
            .list_conversations_visible(Some("bob"), Some("org1"), true)
            .await
            .unwrap();
        assert_eq!(bob.len(), 1, "an org-visible chat is shared with the org");

        // …but not with a different org.
        let outsider = store
            .list_conversations_visible(Some("mallory"), Some("org2"), true)
            .await
            .unwrap();
        assert!(outsider.is_empty(), "cross-org must never see the row");
    }

    #[tokio::test]
    async fn a_fork_is_owned_by_the_forker_not_the_source_owner() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_tenancy("src", "alice", Some("org1"))
            .await
            .unwrap();
        store
            .append_message("src", "user", "shared thought", None, None, None)
            .await
            .unwrap();

        let forked = store
            .fork_conversation(
                "src",
                None,
                Tenancy::Owned {
                    user_id: "bob".to_owned(),
                    org_id: Some("org1".to_owned()),
                },
            )
            .await
            .unwrap()
            .expect("fork");
        let meta = store
            .get_access_meta(&forked.id)
            .await
            .unwrap()
            .expect("row");
        assert_eq!(meta.owner_user_id.as_deref(), Some("bob"));
        assert_eq!(meta.org_id.as_deref(), Some("org1"));
    }

    #[tokio::test]
    async fn conversation_folder_can_be_cleared_without_deleting_the_chat() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation(
                "project-chat",
                None,
                Some("Project chat"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        assert!(store
            .set_folder_path("project-chat", Some(r"C:\Code\ryu\"))
            .await
            .unwrap());
        let grouped = store
            .list_conversations()
            .await
            .unwrap()
            .into_iter()
            .find(|conversation| conversation.id == "project-chat")
            .expect("conversation summary");
        assert_eq!(grouped.folder_path.as_deref(), Some(r"C:\Code\ryu"));

        assert!(store.set_folder_path("project-chat", None).await.unwrap());
        let detached = store
            .list_conversations()
            .await
            .unwrap()
            .into_iter()
            .find(|conversation| conversation.id == "project-chat")
            .expect("conversation remains");
        assert_eq!(detached.folder_path, None);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // THE CHOKE POINT (task item 1): "no owner is ever locked out of their own
    // conversation, whichever path created it".
    //
    // These are the tests that catch a fix which trades a leak for an OUTAGE. The
    // regression they guard: tenancy used to be stamped at a handful of HANDLERS, so
    // every other creation path (MCP `create_thread`/`fork_thread`, sync replay, the
    // healing simulator, …) minted a NULL-tenanted row — and on an org-bound node
    // NULL means DENIED TO EVERYONE, including the row's rightful owner.
    // ══════════════════════════════════════════════════════════════════════════

    const ORG: &str = "org1";

    fn alice() -> Tenancy {
        Tenancy::Owned {
            user_id: "alice".to_owned(),
            org_id: Some(ORG.to_owned()),
        }
    }

    /// The owner can actually SEE the row on a bound node (the same SQL predicate the
    /// HTTP list/search and the MCP tools all filter with), and the row's stored
    /// tenancy names them.
    async fn assert_owner_can_reach(store: &ConversationStore, id: &str, path: &str) {
        let meta = store
            .get_access_meta(id)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("[{path}] no conversation row at all"));
        assert_eq!(
            meta.owner_user_id.as_deref(),
            Some("alice"),
            "[{path}] created an UNTENANTED row — on an org-bound node its own owner is locked out of it"
        );
        assert_eq!(
            meta.org_id.as_deref(),
            Some(ORG),
            "[{path}] org not stamped"
        );

        let visible = store
            .visible_conversation_ids(Some("alice"), Some(ORG), true)
            .await
            .unwrap();
        assert!(
            visible.iter().any(|v| v == id),
            "[{path}] the owner cannot see their own conversation on a bound node"
        );

        // …and a DIFFERENT user on the same org still cannot.
        let bobs = store
            .visible_conversation_ids(Some("bob"), Some(ORG), true)
            .await
            .unwrap();
        assert!(
            !bobs.iter().any(|v| v == id),
            "[{path}] a private conversation leaked into another member's visible set"
        );
    }

    /// EVERY creation path, table-driven. A future path added without a `Tenancy`
    /// cannot compile; a future path added WITH the wrong one fails here.
    #[tokio::test]
    async fn every_creation_path_leaves_the_row_reachable_by_its_own_owner() {
        // 1. ensure_conversation (MCP `create_thread`, sync replay, healing sim).
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("c-ensure", None, Some("t"), alice())
            .await
            .unwrap();
        assert_owner_can_reach(&store, "c-ensure", "ensure_conversation").await;

        // 2. append_message_as minting a fresh row (channel/bot ingress, import).
        store
            .append_message_as("c-append", "user", "hi", None, None, None, alice())
            .await
            .unwrap();
        assert_owner_can_reach(&store, "c-append", "append_message_as").await;

        // 3. append_message_with_id (the sync-replay insert).
        store
            .append_message_with_id("c-withid", "m1", "user", "hi", None, 1, alice())
            .await
            .unwrap();
        assert_owner_can_reach(&store, "c-withid", "append_message_with_id").await;

        // 4. add_participant (council chat's first agent).
        store
            .add_participant("c-part", "agent-a", alice())
            .await
            .unwrap();
        assert_owner_can_reach(&store, "c-part", "add_participant").await;

        // 5. create_session.
        let session = store
            .create_session("agent-a", RunnableKind::Agent, None, None, alice())
            .await
            .unwrap();
        assert_owner_can_reach(&store, &session.conversation_id, "create_session").await;

        // 6. fork_conversation (HTTP fork + the MCP `fork_thread` tool).
        let forked = store
            .fork_conversation("c-append", None, alice())
            .await
            .unwrap()
            .expect("fork");
        assert_owner_can_reach(&store, &forked.id, "fork_conversation").await;

        // 7. claim_tenancy (the repair/backfill entry, still first-writer-wins).
        store
            .claim_tenancy("c-claim", "alice", Some(ORG))
            .await
            .unwrap();
        assert_owner_can_reach(&store, "c-claim", "claim_tenancy").await;
    }

    /// The preserve-not-clobber half of the choke point, at every layer that upserts
    /// an EXISTING row: none of them may wipe the owner already stamped.
    #[tokio::test]
    async fn no_upsert_path_can_wipe_or_steal_a_claimed_owner() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("c1", None, None, alice())
            .await
            .unwrap();

        // Every path that upserts the same id with a DIFFERENT (or absent) tenancy.
        store
            .append_message_as("c1", "user", "hi", None, None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .ensure_conversation("c1", Some("a"), None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .append_message_with_id("c1", "m9", "user", "x", None, 2, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .add_participant("c1", "agent-z", Tenancy::Unattributed)
            .await
            .unwrap();
        // …and a deliberate STEAL attempt with a real, different principal.
        store
            .claim_tenancy("c1", "mallory", Some(ORG))
            .await
            .unwrap();
        store
            .append_message_as(
                "c1",
                "user",
                "mine now",
                None,
                None,
                None,
                Tenancy::Owned {
                    user_id: "mallory".to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();

        let meta = store.get_access_meta("c1").await.unwrap().unwrap();
        assert_eq!(
            meta.owner_user_id.as_deref(),
            Some("alice"),
            "first-writer-wins broken: the conversation was re-tenanted / stolen"
        );
    }

    /// UNBOUND PARITY: on a personal node nothing changes. Rows stay NULL-tenanted and
    /// every one of them stays visible — no offline lockout, byte-identical to the
    /// pre-ACL build.
    #[tokio::test]
    async fn an_unbound_personal_node_is_unchanged_on_every_creation_path() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("u1", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .append_message_as("u2", "user", "hi", None, None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .append_message_with_id("u3", "m1", "user", "hi", None, 1, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .add_participant("u4", "agent-a", Tenancy::Unattributed)
            .await
            .unwrap();
        let session = store
            .create_session(
                "agent-a",
                RunnableKind::Agent,
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let forked = store
            .fork_conversation("u2", None, Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("fork");

        for id in ["u1", "u2", "u3", "u4"] {
            let meta = store.get_access_meta(id).await.unwrap().unwrap();
            assert_eq!(
                meta.owner_user_id, None,
                "an unbound node must not stamp tenancy on {id}"
            );
            assert_eq!(meta.org_id, None);
        }

        // node_bound = false ⇒ NO filtering at all: every row is visible, exactly as
        // before the ACL existed.
        let visible = store
            .visible_conversation_ids(None, None, false)
            .await
            .unwrap();
        for id in ["u1", "u2", "u3", "u4", &session.conversation_id, &forked.id] {
            assert!(
                visible.iter().any(|v| v == id),
                "unbound node lost visibility of {id} — this is the offline-lockout regression"
            );
        }
        assert_eq!(store.list_conversations().await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn proactive_opening_claim_is_exactly_once_until_completed() {
        let store = ConversationStore::open_in_memory().unwrap();

        assert!(store
            .claim_proactive_opening("opening-1", "conversation-1")
            .await
            .unwrap());
        assert!(!store
            .claim_proactive_opening("opening-1", "conversation-1")
            .await
            .unwrap());
        assert_eq!(
            store.proactive_opening_status("opening-1").await.unwrap(),
            Some(ProactiveOpeningStatus {
                conversation_id: "conversation-1".to_string(),
                status: "running".to_string(),
            })
        );

        store.complete_proactive_opening("opening-1").await.unwrap();
        assert_eq!(
            store.proactive_opening_status("opening-1").await.unwrap(),
            Some(ProactiveOpeningStatus {
                conversation_id: "conversation-1".to_string(),
                status: "completed".to_string(),
            })
        );
        assert!(!store
            .claim_proactive_opening("opening-1", "conversation-1")
            .await
            .unwrap());
        assert!(!store
            .claim_proactive_opening("opening-1", "conversation-2")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn failed_proactive_opening_can_be_released_for_a_readiness_retry() {
        let store = ConversationStore::open_in_memory().unwrap();

        assert!(store
            .claim_proactive_opening("opening-2", "conversation-2")
            .await
            .unwrap());
        store.release_proactive_opening("opening-2").await.unwrap();
        assert_eq!(
            store.proactive_opening_status("opening-2").await.unwrap(),
            None
        );
        assert!(store
            .claim_proactive_opening("opening-2", "conversation-2")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn channel_turn_idempotency_replays_the_completed_result() {
        let store = ConversationStore::open_in_memory().unwrap();
        assert_eq!(
            store
                .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
                .await
                .unwrap(),
            ChannelTurnClaim::Claimed
        );
        assert_eq!(
            store
                .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
                .await
                .unwrap(),
            ChannelTurnClaim::InFlight
        );

        let result = ChannelTurnReplay {
            reply: "same reply".to_string(),
            assistant_message_id: Some("assistant-1".to_string()),
            assistant_message_ids: vec!["assistant-1".to_string(), "assistant-2".to_string()],
            agent_id: Some("agent-1".to_string()),
            fallback_warning: None,
            interactive_markup: Some(ryu_channel_contracts::InteractiveMarkup {
                layout: ryu_channel_contracts::InteractiveLayout::Inline,
                rows: vec![vec![ryu_channel_contracts::InteractiveButton {
                    label: "Approve".to_owned(),
                    action: ryu_channel_contracts::InteractiveAction::Callback {
                        action_id: "review.approve".to_owned(),
                        payload: serde_json::json!({ "requestId": "7" }),
                    },
                }]],
            }),
        };
        store
            .complete_channel_turn("telegram:bot-a:update-42", &result)
            .await
            .unwrap();

        assert_eq!(
            store
                .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
                .await
                .unwrap(),
            ChannelTurnClaim::Completed(result)
        );
    }

    #[tokio::test]
    async fn channel_turn_idempotency_rejects_key_reuse_for_different_input() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .claim_channel_turn("whatsapp:bot-a:wamid-1", "conversation-1", "hash-1")
            .await
            .unwrap();
        let error = store
            .claim_channel_turn("whatsapp:bot-a:wamid-1", "conversation-1", "hash-2")
            .await
            .expect_err("one provider id must not be reused for another payload");
        assert!(error
            .to_string()
            .contains("idempotency key was reused for a different request"));
    }
}

// RNP working-tree handoff: the source marks a thread it handed off so two
// nodes do not keep editing the same branch. Kept in its own `impl` block, and
// deliberately not touching `updated_at`, so marking never invalidates a
// reviewed export (`ifUpdatedAt`).
impl ConversationStore {
    /// Record where the thread continued (`{ nodeLabel, bundleId?, workspaceId?, at }`).
    /// Returns `false` when the conversation does not exist.
    pub async fn set_continued_on(&self, conversation_id: &str, record: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET continued_on = ?2 WHERE id = ?1",
                params![conversation_id, record],
            )
            .context("setting continued_on")?;
        Ok(changed == 1)
    }

    /// Take the thread back on this node. Returns `false` when it does not exist.
    pub async fn clear_continued_on(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET continued_on = NULL WHERE id = ?1",
                params![conversation_id],
            )
            .context("clearing continued_on")?;
        Ok(changed == 1)
    }
}

#[cfg(test)]
mod continued_on_tests {
    use super::*;

    #[tokio::test]
    async fn continued_on_is_set_cleared_and_listed_without_moving_updated_at() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_sync_conversation("c1", None, Some("Thread"), 10, 20, Tenancy::Unattributed)
            .await
            .unwrap();
        let before = store.get_summary("c1").await.unwrap().unwrap();
        assert!(before.continued_on.is_none());

        let record = r#"{"nodeLabel":"Mac","at":30}"#;
        assert!(store.set_continued_on("c1", record).await.unwrap());
        assert!(!store.set_continued_on("missing", record).await.unwrap());
        let marked = store.get_summary("c1").await.unwrap().unwrap();
        assert_eq!(
            marked.continued_on,
            Some(serde_json::json!({"nodeLabel":"Mac","at":30}))
        );
        assert_eq!(marked.updated_at, before.updated_at);
        let listed = store
            .list_summaries_inner("", TenancyFilter::unrestricted(), true, Some("c1"))
            .await
            .unwrap();
        assert_eq!(listed[0].continued_on, marked.continued_on);

        assert!(store.clear_continued_on("c1").await.unwrap());
        assert!(store
            .get_summary("c1")
            .await
            .unwrap()
            .unwrap()
            .continued_on
            .is_none());
    }
}

#[cfg(test)]
mod at_rest_recall_tests {
    use super::*;

    async fn raw_text(store: &ConversationStore, sql: &str, id: &str) -> Option<String> {
        let conn = store.conn.lock().await;
        conn.query_row(sql, [id], |row| row.get(0)).unwrap()
    }

    #[tokio::test]
    async fn harness_run_errors_are_sealed_legacy_rows_read_and_bad_rows_skipped() {
        let store = ConversationStore::open_in_memory().unwrap();
        let session = store
            .create_session(
                "agent-seal",
                RunnableKind::Agent,
                Some("agent-seal"),
                Some("Seal test"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let request = StartRunRequest {
            input: serde_json::json!({ "prompt": "inspect" }),
            idempotency_key: Some("seal-1".to_owned()),
            execution_profile: None,
            resume_run_id: None,
            multitask_strategy: None,
        };
        let run = store
            .start_harness_run(&session.id, &request)
            .await
            .unwrap()
            .run;
        store
            .finish_harness_run(
                &run.id,
                HarnessRunStatus::Failed,
                Some("upstream echoed: confidential prompt fragment"),
                None,
            )
            .await
            .unwrap();
        let stored = raw_text(
            &store,
            "SELECT error FROM harness_runs WHERE id = ?1",
            &run.id,
        )
        .await
        .unwrap();
        assert!(stored.starts_with("enc:v1:"));
        assert!(!stored.contains("confidential"));
        let read = store.get_harness_run(&run.id).await.unwrap().unwrap();
        assert_eq!(
            read.error.as_deref(),
            Some("upstream echoed: confidential prompt fragment")
        );

        // A legacy plaintext error still reads, and the open-time pass seals it
        // once (a second pass changes nothing).
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE harness_runs SET error = 'legacy plaintext error' WHERE id = ?1",
                [&run.id],
            )
            .unwrap();
        }
        assert_eq!(
            store
                .get_harness_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .error
                .as_deref(),
            Some("legacy plaintext error")
        );
        {
            let conn = store.conn.lock().await;
            ConversationStore::seal_legacy_run_text(&conn, &store.cipher).unwrap();
        }
        let first = raw_text(
            &store,
            "SELECT error FROM harness_runs WHERE id = ?1",
            &run.id,
        )
        .await
        .unwrap();
        assert!(first.starts_with("enc:v1:"));
        {
            let conn = store.conn.lock().await;
            ConversationStore::seal_legacy_run_text(&conn, &store.cipher).unwrap();
        }
        assert_eq!(
            raw_text(
                &store,
                "SELECT error FROM harness_runs WHERE id = ?1",
                &run.id
            )
            .await
            .unwrap(),
            first
        );

        // A sealed value that does not open: the list skips and counts the row,
        // get-by-id reports an error instead of an empty value.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE harness_runs SET error = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?1",
                [&run.id],
            )
            .unwrap();
        }
        assert!(store
            .list_harness_runs(&session.id)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(store.harness_unreadable.load(Ordering::Relaxed), 1);
        assert!(store.get_harness_run(&run.id).await.is_err());
    }

    /// Whether `marker` appears anywhere in the database file or its WAL.
    fn db_files_contain(path: &std::path::Path, marker: &str) -> bool {
        let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
        [path.to_path_buf(), wal].iter().any(|file| {
            std::fs::read(file).is_ok_and(|bytes| {
                bytes
                    .windows(marker.len())
                    .any(|window| window == marker.as_bytes())
            })
        })
    }

    /// Plaintext run errors an older build wrote, then deleted without
    /// `secure_delete`, must not survive the open-time reseal in free pages,
    /// partly used pages or WAL frames.
    #[tokio::test]
    async fn legacy_run_errors_are_scrubbed_from_db_and_wal_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("conversations.db");
        let deleted_marker = "DELETED-LEGACY-RUN-ERROR-7f3a";
        let live_marker = "LIVE-LEGACY-RUN-ERROR-9c1e";
        let cipher = {
            let store = ConversationStore::open_hook_test_file(path.clone()).unwrap();
            {
                let conn = store.conn.lock().await;
                conn.pragma_update(None, "secure_delete", "OFF").unwrap();
            }
            let session = store
                .create_session(
                    "agent-scrub",
                    RunnableKind::Agent,
                    Some("agent-scrub"),
                    Some("Scrub test"),
                    Tenancy::Unattributed,
                )
                .await
                .unwrap();
            let mut runs = Vec::new();
            for key in ["scrub-1", "scrub-2"] {
                let request = StartRunRequest {
                    input: serde_json::json!({ "prompt": "inspect" }),
                    idempotency_key: Some(key.to_owned()),
                    execution_profile: None,
                    resume_run_id: None,
                    multitask_strategy: None,
                };
                let run = store
                    .start_harness_run(&session.id, &request)
                    .await
                    .unwrap()
                    .run;
                store
                    .finish_harness_run(&run.id, HarnessRunStatus::Failed, Some("sealed"), None)
                    .await
                    .unwrap();
                runs.push(run);
            }
            {
                // What an older build left: plaintext errors, one of them on a
                // run it then deleted without secure_delete.
                let conn = store.conn.lock().await;
                conn.execute(
                    "UPDATE harness_runs SET error = ?1 WHERE id = ?2",
                    params![deleted_marker, runs[0].id],
                )
                .unwrap();
                conn.execute(
                    "UPDATE harness_runs SET error = ?1 WHERE id = ?2",
                    params![live_marker, runs[1].id],
                )
                .unwrap();
                conn.execute("DELETE FROM harness_runs WHERE id = ?1", [&runs[0].id])
                    .unwrap();
            }
            assert!(db_files_contain(&path, deleted_marker));
            store.cipher.clone()
        };

        // The open-time pass on the store's single connection.
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "secure_delete", "ON").unwrap();
            ConversationStore::init_schema(&conn).unwrap();
            ConversationStore::seal_and_scrub_legacy_run_text(&conn, &path, &cipher).unwrap();
            let record = ryu_crypto::content_sqlite::read_store_record(&conn, RUN_TEXT_STORE)
                .unwrap()
                .unwrap();
            assert_eq!(record.state, ryu_crypto::content_sqlite::states::OK);
            assert!(record.kcv.is_none(), "the scrub record names no key");
            let stored: String = conn
                .query_row("SELECT error FROM harness_runs", [], |row| row.get(0))
                .unwrap();
            assert!(stored.starts_with("enc:v1:"));
            assert_eq!(cipher.open(&stored).unwrap(), live_marker);
        }
        assert!(
            !db_files_contain(&path, deleted_marker),
            "a deleted legacy run error survived the scrub"
        );
        assert!(
            !db_files_contain(&path, live_marker),
            "the resealed legacy run error survived the scrub"
        );

        // Nothing left to seal and no debt: a later open does not rewrite.
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "secure_delete", "ON").unwrap();
        ConversationStore::seal_and_scrub_legacy_run_text(&conn, &path, &cipher).unwrap();
        assert_eq!(
            ryu_crypto::content_sqlite::read_store_record(&conn, RUN_TEXT_STORE)
                .unwrap()
                .unwrap()
                .state,
            ryu_crypto::content_sqlite::states::OK
        );
    }

    #[tokio::test]
    async fn channel_turn_fallback_warnings_are_sealed() {
        let store = ConversationStore::open_in_memory().unwrap();
        let key = "telegram:bot-a:update-sealed";
        store
            .claim_channel_turn(key, "conversation-1", "hash-1")
            .await
            .unwrap();
        let result = ChannelTurnReplay {
            reply: "reply".to_owned(),
            assistant_message_id: None,
            assistant_message_ids: Vec::new(),
            agent_id: None,
            fallback_warning: Some("primary model unavailable for this request".to_owned()),
            interactive_markup: None,
        };
        store.complete_channel_turn(key, &result).await.unwrap();
        let stored = raw_text(
            &store,
            "SELECT fallback_warning FROM channel_turn_idempotency WHERE idempotency_key = ?1",
            key,
        )
        .await
        .unwrap();
        assert!(stored.starts_with("enc:v1:"));
        assert_eq!(
            store
                .claim_channel_turn(key, "conversation-1", "hash-1")
                .await
                .unwrap(),
            ChannelTurnClaim::Completed(result)
        );
    }

    fn indexed_store() -> ConversationStore {
        ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(crate::search_host::in_memory_message_index().unwrap())
            .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap())
    }

    #[tokio::test]
    async fn deleting_a_conversation_removes_its_index_rows_and_memory_off_clears_both() {
        let store = indexed_store();
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .append_message(
                "conv-del",
                "user",
                "pineapple orchard harvest",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message(
                "conv-keep",
                "user",
                "pineapple smoothie recipe",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let hits = store
            .fts_search_messages("pineapple", 5, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hits.len(), 2);
        store
            .search_messages("pineapple", 5, None)
            .await
            .unwrap()
            .unwrap();
        let fts = store.message_fts.clone().unwrap();
        let semantic = store.message_index.clone().unwrap();
        // Wait for the append-time semantic workers to settle.
        for _ in 0..50 {
            if semantic.indexed_ids().await.unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(semantic.indexed_ids().await.unwrap().len(), 2);

        assert!(store.delete_conversation("conv-del").await.unwrap());
        assert_eq!(fts.indexed_ids().await.unwrap().len(), 1);
        assert_eq!(semantic.indexed_ids().await.unwrap().len(), 1);
        let diagnostics = store.search_index_diagnostics();
        assert!(diagnostics["vector_coverage"]["total"].is_number());

        store.clear_message_embeddings().await.unwrap();
        assert!(fts.indexed_ids().await.unwrap().is_empty());
        assert!(semantic.indexed_ids().await.unwrap().is_empty());
    }

    /// The danger-zone clears remove the wiped chats from both derived indexes
    /// (and the in-memory vector partition), not only from `conversations.db`.
    #[tokio::test]
    async fn clearing_chats_removes_their_index_rows() {
        let store = indexed_store();
        store.set_chat_memory_enabled(true).await.unwrap();
        for (conversation, owner) in [("conv-alice", "alice"), ("conv-bob", "bob")] {
            store
                .ensure_conversation(
                    conversation,
                    None,
                    None,
                    Tenancy::Owned {
                        user_id: owner.to_owned(),
                        org_id: Some("org1".to_owned()),
                    },
                )
                .await
                .unwrap();
            store
                .append_message(conversation, "user", "walnut grove notes", None, None, None)
                .await
                .unwrap();
        }
        store
            .fts_search_messages("walnut", 5, None)
            .await
            .unwrap()
            .unwrap();
        let fts = store.message_fts.clone().unwrap();
        let semantic = store.message_index.clone().unwrap();
        for _ in 0..50 {
            if semantic.indexed_ids().await.unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(fts.indexed_ids().await.unwrap().len(), 2);
        assert_eq!(semantic.indexed_ids().await.unwrap().len(), 2);

        assert_eq!(
            store
                .clear_conversations_owned_by("bob")
                .await
                .unwrap()
                .removed,
            1
        );
        assert_eq!(fts.indexed_ids().await.unwrap().len(), 1);
        assert_eq!(semantic.indexed_ids().await.unwrap().len(), 1);

        store.clear_all_conversations().await.unwrap();
        assert!(fts.indexed_ids().await.unwrap().is_empty());
        assert!(semantic.indexed_ids().await.unwrap().is_empty());
        assert_eq!(semantic.vector_coverage().total, 0);
    }

    #[tokio::test]
    async fn the_index_backfill_skips_bodies_that_do_not_open() {
        let store = indexed_store();
        store.set_chat_memory_enabled(true).await.unwrap();
        store
            .ensure_conversation("conv-bad", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO messages(id, conversation_id, role, content, created_at)
                 VALUES ('bad', 'conv-bad', 'user', 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1)",
                [],
            )
            .unwrap();
        }
        let hits = store
            .fts_search_messages("unable decrypt message", 5, None)
            .await
            .unwrap()
            .unwrap();
        assert!(hits.is_empty(), "placeholder text must never be indexed");
        assert!(store
            .message_fts
            .clone()
            .unwrap()
            .indexed_ids()
            .await
            .unwrap()
            .is_empty());
        assert_eq!(store.index_unreadable.load(Ordering::Relaxed), 1);
    }
}

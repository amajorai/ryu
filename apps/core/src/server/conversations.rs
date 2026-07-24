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
use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::runnable::RunnableKind;
use ryu_kernel_contracts::ResourceKey;

/// The SQL twin of `resource_access` (`server/mod.rs`) — the ONE place a tenancy
/// read-filter is expressed for list/search queries, so the row gate and the list
/// gate can never drift apart.
///
///   - `:bound = 0` (node UNBOUND / personal): no restriction. There is exactly one
///     principal and the node token is the boundary — identical to the pre-ACL
///     behaviour, and identical to `enforce_permission`'s unbound rule.
///   - node ORG-BOUND: a row is visible iff the caller OWNS it, or it is explicitly
///     shared (`visibility` in `org`/`team`) within the caller's org. An untenanted
///     (NULL-owner) row is therefore INVISIBLE on a bound node — matching the ACL's
///     fail-closed reading of an unattributable legacy row.
///   - node ORG-BOUND + anonymous caller (`:uid IS NULL`): nothing matches → empty.
const TENANCY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR (:uid IS NOT NULL AND c.owner_user_id = :uid)
        OR (:uid IS NOT NULL AND :org IS NOT NULL AND c.org_id = :org
            AND c.visibility IN ('org', 'team'))
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
}

impl TenancyFilter<'_> {
    /// The in-process, full-trust filter: every row on the node.
    fn unrestricted() -> Self {
        Self {
            node_bound: false,
            owner_user_id: None,
            org_id: None,
        }
    }

    fn bound_flag(&self) -> i64 {
        i64::from(self.node_bound)
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

/// The non-tenancy columns a creation path may seed. Every field is EXISTING-WINS
/// on conflict (except `agent_id`, which is NEW-wins, matching the pre-choke-point
/// upserts), so a caller that leaves one `None` can never clobber a value another
/// path already wrote.
#[derive(Default)]
struct ConvRow<'a> {
    /// Already SEALED by the caller (`seal_opt`) — the choke point does no crypto.
    title: Option<&'a str>,
    agent_id: Option<&'a str>,
    folder_path: Option<&'a str>,
    branch: Option<&'a str>,
    worktree_path: Option<&'a str>,
    participants: Option<&'a str>,
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
    let (owner_user_id, org_id) = tenancy.parts();
    let touch_flag: i64 = match touch {
        Touch::Keep => 0,
        Touch::Set => 1,
        Touch::Max => 2,
    };
    conn.execute(
        "INSERT INTO conversations
            (id, title, agent_id, created_at, updated_at,
             folder_path, branch, worktree_path, participants,
             owner_user_id, org_id)
         VALUES (:id, :title, :agent_id, :now, :now,
                 :folder_path, :branch, :worktree_path,
                 -- `participants` is NOT NULL DEFAULT '[]'; the choke point names it
                 -- explicitly (so `fork` can carry the source's list), which bypasses
                 -- the column default — restore it here for the callers that pass none.
                 COALESCE(:participants, '[]'),
                 :owner, :org)
         ON CONFLICT(id) DO UPDATE SET
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
             owner_user_id = COALESCE(conversations.owner_user_id, excluded.owner_user_id),
             org_id        = COALESCE(conversations.org_id, excluded.org_id)",
        named_params! {
            ":id": conversation_id,
            ":title": row.title,
            ":agent_id": row.agent_id,
            ":now": now,
            ":folder_path": row.folder_path,
            ":branch": row.branch,
            ":worktree_path": row.worktree_path,
            ":participants": row.participants,
            ":owner": owner_user_id,
            ":org": org_id,
            ":touch": touch_flag,
        },
    )
    .context("upserting conversation row (choke point)")?;
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
    /// Structured render parts (AI SDK reduced UIMessage `parts` array: text /
    /// tool / file), captured server-side as the turn streams. This is what lets a
    /// reloaded conversation re-render its tool-call rows and the cowork context
    /// (Progress / Sources / Subagents) instead of collapsing to flat `content`
    /// text. `None` for messages persisted before parts capture existed (they fall
    /// back to a single text part built from `content` on the client) and for user
    /// turns (which are plain text). Sealed at rest like `content`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<serde_json::Value>,
    /// The message this one was produced in reply to (its position in the
    /// version tree). `None` for root turns and for every message in a
    /// conversation that has never been edited/regenerated (flat history). Set
    /// lazily the first time a conversation is branched (see `linearize`), then
    /// maintained by `append_message` once `active_leaf` is engaged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
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
    /// Run lifecycle status: "running" | "completed" | "failed" | null.
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
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
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
    /// Optional sink for conversation ids that just received their *first* user
    /// message and so are candidates for a background auto-rename. `None` in
    /// contexts without a server loop to consume them (tests, CLI). The server
    /// wires a consumer that asks the default local model for a concise title and
    /// calls [`auto_set_title`]. Best-effort: a closed/absent channel just means
    /// the conversation keeps its first-message-derived title.
    auto_title_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    /// Optional room-keyed realtime registry (Phase 1 of the multi-user epic).
    /// When wired, [`append_message`] publishes an `Events` frame keyed by the
    /// conversation id so other live viewers see new turns immediately. `None` in
    /// contexts without realtime fan-out (tests, CLI). Cloned from the same
    /// instance held by `ServerState` so publishes reach the WS handler's
    /// subscribers (see `main.rs` wiring). Best-effort: publishing to a room with
    /// no members is a harmless no-op.
    realtime: Option<ryu_realtime::RoomRegistry>,
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

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Default on-disk location for the conversation database (`~/.ryu/conversations.db`).
fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("conversations.db")
}

impl ConversationStore {
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
        let conn = Connection::open(&path)
            .with_context(|| format!("opening conversation db {}", path.display()))?;
        Self::init_schema(&conn)?;
        // One-shot tenancy backfill for rows that pre-date the per-resource ACL.
        // Deliberately NOT in `init_schema` (which the in-memory test store also
        // runs — it must never read the real account vault) and best-effort: a
        // failure here must never stop the node from opening its chat db.
        if let Err(e) = Self::backfill_tenancy(&conn) {
            tracing::warn!("conversation tenancy backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::global_cipher()?,
            message_index: None,
            message_fts: None,
            auto_title_tx: None,
            realtime: None,
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

    /// Wire the semantic message index (backing the `search_conversations` builtin
    /// tool) into the store. Cheap to clone (`Arc` inside). Must be called after
    /// construction to enable indexing-on-append + searchable history.
    pub fn with_message_index(mut self, index: ryu_search::MessageIndex) -> Self {
        self.message_index = Some(index);
        self
    }

    /// Wire the full-text (FTS5) message index (backing the FTS session-search
    /// recall layer) into the store. Cheap to clone (`Arc` inside). Mirrors
    /// [`with_message_index`]. Population is lazy-on-search and default-OFF, so
    /// wiring the index alone materializes nothing until a search runs under the
    /// enabled FTS recall pref.
    pub fn with_message_fts_index(mut self, index: ryu_search::MessageFtsIndex) -> Self {
        self.message_fts = Some(index);
        self
    }

    /// Wire the auto-rename sink: each conversation that gets its first user
    /// message is sent on `tx` so a server-side consumer can generate a concise
    /// title with the default local model. Must be called after construction.
    pub fn with_auto_title(mut self, tx: tokio::sync::mpsc::UnboundedSender<String>) -> Self {
        self.auto_title_tx = Some(tx);
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
            message_index: None,
            message_fts: None,
            auto_title_tx: None,
            realtime: None,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS conversations (
                 id          TEXT PRIMARY KEY,
                 title       TEXT,
                 agent_id    TEXT,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
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
             CREATE TABLE IF NOT EXISTS sessions (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 runnable_id     TEXT NOT NULL,
                 runnable_kind   TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'idle',
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_conversation
                 ON sessions(conversation_id);
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
                 ON btw_entries(conversation_id, created_at);",
        )
        .context("initializing conversation schema")?;

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
        ] {
            if !existing_conv_columns.contains(col) {
                conn.execute_batch(ddl)
                    .with_context(|| format!("adding column {col}"))?;
            }
        }

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

        // Additive migration: structured render parts (AI SDK reduced UIMessage
        // `parts` array) captured server-side as an assistant turn streams, so a
        // reloaded conversation re-renders its tool rows + cowork context instead
        // of flattening to text-only. Nullable, sealed at rest like `content`;
        // existing rows carry NULL and fall back to a text part on the client.
        if !existing_msg_columns.contains("parts") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN parts TEXT")
                .context("adding parts column to messages")?;
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

        // Additive migration: the conversation's currently-selected leaf in the
        // version tree. NULL means the conversation is flat (never branched) and
        // reads fall back to chronological order. Once set, the active thread is
        // the parent chain walked up from this leaf, and new turns attach beneath
        // it.
        if !existing_conv_columns.contains("active_leaf_message_id") {
            conn.execute_batch("ALTER TABLE conversations ADD COLUMN active_leaf_message_id TEXT")
                .context("adding active_leaf_message_id column to conversations")?;
        }

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
        )
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
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations
             SET folder_path  = COALESCE(?2, folder_path),
                 branch       = COALESCE(?3, branch),
                 worktree_path = COALESCE(?4, worktree_path)
             WHERE id = ?1",
            params![conversation_id, folder_path, branch, worktree_path],
        )
        .context("setting run metadata")?;
        Ok(())
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
    /// thread carried no native session id to key on).
    pub async fn find_imported_conversation(
        &self,
        origin: &str,
        native_session_id: &str,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let id = conn
            .query_row(
                "SELECT id FROM conversations
                 WHERE origin = ?1 AND native_session_id = ?2
                 ORDER BY updated_at DESC LIMIT 1",
                params![origin, native_session_id],
                |row| row.get::<_, String>(0),
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

    /// Load a single conversation's run summary by id. Used to publish a complete
    /// [`RunStatusEvent`] on every status change. Returns `None` if the row is gone.
    async fn run_summary(&self, conversation_id: &str) -> Result<Option<ConversationSummary>> {
        let summary = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                        c.folder_path, c.branch, c.worktree_path, c.run_status,
                        c.participants, c.pinned, c.archived
                 FROM conversations c
                 WHERE c.id = ?1",
            )?;
            stmt.query_row(params![conversation_id], |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
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
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET title = ?1, title_custom = 1, updated_at = ?2 WHERE id = ?3",
            params![sealed, now, conversation_id],
        )
        .context("setting conversation title")?;
        Ok(())
    }

    /// Apply an auto-generated title (from the background auto-namer) to a
    /// conversation, but **only** when the user hasn't chosen one themselves
    /// (`title_custom = 0`). The guard makes the write a no-op if a manual rename
    /// raced ahead, so an LLM title can never clobber a deliberate one.
    ///
    /// Unlike [`set_title`] this does NOT set `title_custom` — an auto title stays
    /// replaceable, and a later manual rename still locks it. Returns whether a
    /// row was actually updated.
    pub async fn auto_set_title(&self, conversation_id: &str, title: &str) -> Result<bool> {
        let now = now_millis();
        let sealed = self.seal_opt(Some(title))?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2
                 WHERE id = ?3 AND title_custom = 0",
                params![sealed, now, conversation_id],
            )
            .context("auto-setting conversation title")?;
        Ok(changed > 0)
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

    /// Append a message and bump the conversation's `updated_at`. Returns the new
    /// message id. **Creates the conversation if it does not exist yet** — which is
    /// why it takes a [`Tenancy`]: an append that mints a row on an org-bound node
    /// must stamp its owner or the row is born invisible to everybody.
    ///
    /// Callers writing into a row that already exists pass [`Tenancy::Unattributed`];
    /// the choke point's COALESCE preserves the owner already stamped (this is the
    /// property `append_does_not_wipe_a_claimed_owner` asserts).
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
        let now = now_millis();
        let message_id = uuid::Uuid::new_v4().to_string();

        // Index the message body for semantic search — best-effort, fail-open.
        // We spawn BEFORE taking the DB lock and embed the *plaintext* (pre-seal)
        // in the spawned task, so the network embed never holds the conversation
        // mutex and a down embed sidecar can never block or slow the chat write.
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

        let conn = self.conn.lock().await;
        // Derive a first-pass title from the first user message (sealed at rest).
        let title = if role == "user" {
            self.seal_opt(Some(&derive_title(content)))?
        } else {
            None
        };
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
            "INSERT INTO messages (id, conversation_id, role, content, agent_id, author_user_id, author_name, parent_message_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![message_id, conversation_id, role, sealed, agent_id, author_user_id, author_name, parent_message_id, now],
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

        // Auto-rename trigger: when this is the conversation's *first* user
        // message and the title hasn't been user-locked, hand the id to the
        // server-side auto-namer (ChatGPT/Claude-style). We fire exactly once per
        // conversation (guarded on user-message count == 1) so the model is asked
        // for a title only at the start; the consumer re-checks `title_custom`
        // before writing, so a manual rename that races still wins.
        if role == "user" {
            if let Some(tx) = &self.auto_title_tx {
                let user_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM messages
                         WHERE conversation_id = ?1 AND role = 'user'",
                        params![conversation_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let already_custom: i64 = conn
                    .query_row(
                        "SELECT title_custom FROM conversations WHERE id = ?1",
                        params![conversation_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if user_count == 1 && already_custom == 0 {
                    // Best-effort: a full/closed channel just skips auto-naming.
                    let _ = tx.send(conversation_id.to_owned());
                }
            }
        }
        // Release the conversation DB lock before fanning out — the publish is a
        // non-blocking broadcast send on a different mutex, but there is no reason
        // to hold the conn lock across it.
        drop(conn);

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
                        "author_user_id": author_user_id,
                        "author_name": author_name,
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
        self.list_summaries(
            "",
            TenancyFilter {
                node_bound,
                owner_user_id,
                org_id,
            },
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
        self.list_summaries(
            "AND c.run_status IS NOT NULL",
            TenancyFilter {
                node_bound,
                owner_user_id,
                org_id,
            },
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
        let filter = TenancyFilter {
            node_bound,
            owner_user_id,
            org_id,
        };
        let sql = format!("SELECT c.id FROM conversations c WHERE {TENANCY_VISIBLE_PREDICATE}");
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
            },
            |row| row.get::<_, String>(0),
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
        let sql = format!(
            "SELECT c.id, c.title, c.agent_id, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                    c.folder_path, c.branch, c.worktree_path, c.run_status,
                    c.participants, c.pinned, c.archived
             FROM conversations c
             WHERE {TENANCY_VISIBLE_PREDICATE} {extra}
             ORDER BY c.updated_at DESC"
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            named_params! {
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
            },
            |row| {
                let participants_json: Option<String> = row.get(10)?;
                let participants = parse_participants_json(participants_json.as_deref());
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
                })
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            let mut summary = row?;
            summary.title = self.open_opt(summary.title);
            out.push(summary);
        }
        Ok(out)
    }

    /// Decrypt a stored `content` value, degrading gracefully: a row that fails
    /// to decrypt (corrupt/wrong-key) is replaced with a marker rather than
    /// failing the whole conversation load. Legacy plaintext passes through.
    fn open_content(&self, stored: String) -> String {
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

    /// Fetch all messages of a conversation in chronological order.
    pub async fn get_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name, parts, parent_message_id
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        // The raw sealed `parts` blob is carried on `StoredMessage.parts` as a
        // JSON string temporarily, then decrypted + parsed below (outside the DB
        // lock, like `content`/`title`).
        let rows = stmt.query_map([conversation_id], |row| {
            let sealed_parts: Option<String> = row.get(7)?;
            Ok((
                StoredMessage {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                    agent_id: row.get(3)?,
                    author_user_id: row.get(5)?,
                    author_name: row.get(6)?,
                    parts: None,
                    parent_message_id: row.get(8)?,
                    sibling_index: 0,
                    sibling_count: 1,
                    sibling_ids: Vec::new(),
                    created_at: row.get(4)?,
                },
                sealed_parts,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (mut msg, sealed_parts) = row?;
            msg.content = self.open_content(std::mem::take(&mut msg.content));
            msg.parts = self.open_parts(sealed_parts);
            out.push(msg);
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
        let Some(index) = self.message_index.clone() else {
            return Ok(None);
        };

        // ── Lazy backfill ───────────────────────────────────────────────────
        // Compute the set of not-yet-indexed messages, decrypt each, embed, and
        // index. Best-effort: a single embed failure skips that one message.
        let already = index.indexed_ids().await.unwrap_or_default();
        let unindexed = {
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
            let mut pending: Vec<(String, String, String, String, i64)> = Vec::new();
            for row in rows {
                let (id, conv, role, sealed, created) = row?;
                if already.contains(&id) {
                    continue;
                }
                let plaintext = self.open_content(sealed);
                if plaintext.trim().is_empty() {
                    continue;
                }
                pending.push((id, conv, role, plaintext, created));
            }
            pending
        };
        if !unindexed.is_empty() {
            let embedder = index.embedder();
            if embedder.is_local() {
                // The local hashing embedder is network-free, so run the backfill
                // INLINE (awaited) — like the FTS backfill below. This guarantees
                // the very first search sees the just-embedded messages (there is
                // no sidecar that could slow or hang it). Best-effort per message.
                let model = embedder.model_id().to_string();
                for (id, conv, role, content, created) in unindexed {
                    match embedder.embed(&content).await {
                        Ok(vec) => {
                            if let Err(e) = index
                                .index_message(&id, &conv, &role, &vec, &model, created)
                                .await
                            {
                                tracing::warn!("backfill index write failed for {id}: {e:#}");
                            }
                        }
                        Err(e) => {
                            tracing::warn!("backfill embed failed for {id}: {e:#}");
                        }
                    }
                }
            } else {
                // A remote embed sidecar could be slow or down, so spawn the
                // backfill off the request path — a search never blocks on it, and
                // the just-added messages surface on a subsequent search once the
                // background task has embedded them.
                let bg_index = index.clone();
                tokio::spawn(async move {
                    let embedder = bg_index.embedder();
                    let model = embedder.model_id().to_string();
                    let mut consecutive_failures: u32 = 0;
                    for (id, conv, role, content, created) in unindexed {
                        if consecutive_failures >= 3 {
                            tracing::warn!(
                                "backfill embed: aborting after {consecutive_failures} consecutive \
                                 failures — sidecar likely down, will retry on next search"
                            );
                            break;
                        }
                        match embedder.embed(&content).await {
                            Ok(vec) => {
                                consecutive_failures = 0;
                                if let Err(e) = bg_index
                                    .index_message(&id, &conv, &role, &vec, &model, created)
                                    .await
                                {
                                    tracing::warn!("backfill index write failed for {id}: {e:#}");
                                }
                            }
                            Err(e) => {
                                consecutive_failures += 1;
                                tracing::warn!(
                                    "backfill embed failed for {id} (sidecar down?): {e:#}"
                                );
                            }
                        }
                    }
                });
            }
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
        let Some(index) = self.message_fts.clone() else {
            return Ok(None);
        };

        // ── Lazy backfill (inline, network-free) ─────────────────────────────
        let already = index.indexed_ids().await.unwrap_or_default();
        let unindexed = {
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
            let mut pending: Vec<(String, String, String, String, i64)> = Vec::new();
            for row in rows {
                let (id, conv, role, sealed, created) = row?;
                if already.contains(&id) {
                    continue;
                }
                let plaintext = self.open_content(sealed);
                if plaintext.trim().is_empty() {
                    continue;
                }
                pending.push((id, conv, role, plaintext, created));
            }
            pending
        };
        for (id, conv, role, content, created) in unindexed {
            if let Err(e) = index
                .index_message(&id, &conv, &role, &content, created)
                .await
            {
                tracing::warn!("fts backfill index write failed for {id}: {e:#}");
            }
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
    pub async fn get_recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().await;
        // Select the newest `limit` rows, then reverse to chronological order.
        let mut stmt = conn.prepare(
            "SELECT id, role, content, agent_id, created_at, author_user_id, author_name
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![conversation_id, limit as i64], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                agent_id: row.get(3)?,
                // Short-term-memory context assembly (the sole caller) feeds the
                // model plain text, so the structured parts are intentionally not
                // read here — only `get_messages` (the reload path) decodes them.
                parts: None,
                parent_message_id: None,
                sibling_index: 0,
                sibling_count: 1,
                sibling_ids: Vec::new(),
                created_at: row.get(4)?,
                author_user_id: row.get(5)?,
                author_name: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut msg = row?;
            msg.content = self.open_content(std::mem::take(&mut msg.content));
            out.push(msg);
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
                }))
            }
        }
    }

    /// Fork (branch) a conversation into a brand-new conversation, copying every
    /// message up to and including `up_to_message_id` (ChatGPT-style "Branch in
    /// new chat"). When `up_to_message_id` is `None` the entire history is copied.
    ///
    /// The new conversation is fully independent: it gets a fresh id and fresh
    /// per-message ids, so continuing the branch never touches the source. Run
    /// metadata (folder/branch/worktree) and participants are carried over, but
    /// `run_status` and any goal are intentionally left unset on the copy.
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
        // the cut-point lookup stays simple.
        let messages = self.get_messages(source_id).await?;
        let slice: Vec<&StoredMessage> = match up_to_message_id {
            Some(mid) => {
                let Some(idx) = messages.iter().position(|m| m.id == mid) else {
                    return Ok(None);
                };
                messages[..=idx].iter().collect()
            }
            None => messages.iter().collect(),
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
            },
            Touch::Keep,
        )
        .context("inserting forked conversation")?;

        // Copy each message with a fresh id, preserving role/content/agent/ordering.
        // `m.content` is already decrypted (get_messages opened it), so re-seal it
        // for the new row.
        for m in &slice {
            let copy_id = uuid::Uuid::new_v4().to_string();
            let sealed = self.cipher.seal(&m.content)?;
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, agent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![copy_id, new_id, m.role, sealed, m.agent_id, m.created_at],
            )
            .context("copying message into fork")?;
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
        // Link each message to its predecessor; first stays a root (NULL parent).
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

        // Load the full row set once (sealed), then walk the parent chain in
        // memory so we never hold the DB lock across decryption.
        let all = self.get_messages(conversation_id).await?;
        let by_id: std::collections::HashMap<&str, &StoredMessage> =
            all.iter().map(|m| (m.id.as_str(), m)).collect();

        // Walk up from the leaf collecting the active path (leaf → root), then
        // reverse to chronological order.
        let mut path: Vec<StoredMessage> = Vec::new();
        let mut cursor = Some(leaf);
        while let Some(id) = cursor {
            let Some(msg) = by_id.get(id.as_str()) else {
                break;
            };
            path.push((*msg).clone());
            cursor = msg.parent_message_id.clone();
        }
        path.reverse();

        // Annotate each with its sibling index/count. Siblings share a
        // `parent_message_id` (treating None as a shared "root" bucket). `all` is
        // already in insertion order (`created_at ASC, rowid ASC` from
        // `get_messages`), so filtering preserves creation order — the pager shows
        // v1, v2, v3 as authored even when two versions land in the same
        // millisecond (rowid, not the random uuid, breaks the tie).
        for msg in &mut path {
            let siblings: Vec<&StoredMessage> = all
                .iter()
                .filter(|m| m.parent_message_id == msg.parent_message_id)
                .collect();
            msg.sibling_count = siblings.len();
            msg.sibling_index = siblings.iter().position(|m| m.id == msg.id).unwrap_or(0);
            // Only carry the id list when there is an actual choice to page
            // through — a single-version turn stays a lean payload.
            msg.sibling_ids = if siblings.len() > 1 {
                siblings.iter().map(|m| m.id.clone()).collect()
            } else {
                Vec::new()
            };
        }
        Ok(path)
    }

    /// Edit a user message: create a new sibling version carrying `new_content`
    /// (same parent as the edited message) and point the active leaf at it, so a
    /// subsequent generation turn attaches its reply beneath the edit. Returns the
    /// new sibling's id, or `None` if the message is absent / not a user turn.
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
        Ok(Some(new_id))
    }

    /// Prepare to regenerate an assistant message: point the active leaf at the
    /// user turn *above* it (its parent) so the next generation appends a fresh
    /// assistant sibling. Returns the parent id, or `None` if the message is
    /// absent or has no parent (a regenerate needs a preceding user turn).
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
        Ok(Some(parent_id))
    }

    /// Switch the active version at a branch point: make `version_id` the chosen
    /// sibling, then descend to a leaf (following the newest child at each step)
    /// and set that as the conversation's active leaf. Returns the resolved leaf
    /// id, or `None` if `version_id` is absent. The client then re-reads the
    /// active path to re-render the thread along the newly-selected branch.
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
                Some(c) => leaf = c,
                None => break,
            }
        }
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![leaf, now, conversation_id],
        )
        .context("setting selected leaf")?;
        Ok(Some(leaf))
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
        let conn = self.conn.lock().await;
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
                    })
                },
            )
            .optional()
            .context("reading conversation access metadata")?;
        Ok(meta)
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
        let removed = conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        Ok(removed > 0)
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

    /// Delete **every** conversation and all chat-scoped state: messages and
    /// sessions (both keyed by `conversation_id`) plus the conversation rows
    /// themselves (which carry the goal columns). Returns the number of
    /// conversations removed. This goes further than [`Self::delete_conversation`],
    /// which leaves sessions orphaned — a full wipe should not.
    pub async fn clear_all_conversations(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM sessions", [])?;
        conn.execute("DELETE FROM btw_entries", [])?;
        let removed = conn.execute("DELETE FROM conversations", [])?;
        Ok(removed as u64)
    }

    /// The tenancy-scoped twin of [`Self::clear_all_conversations`]: delete ONLY the
    /// conversations `owner_user_id` owns, plus their messages/sessions/side-chats.
    ///
    /// `POST /api/data/clear` used the unscoped truncate above with no ACL at all, so
    /// on an org-bound node any holder of the node token could destroy EVERY user's
    /// chats. On a bound node the danger-zone clear now routes here instead. Strict
    /// owner-match on purpose: an org-visible chat owned by a colleague is NOT the
    /// caller's to delete.
    pub async fn clear_conversations_owned_by(&self, owner_user_id: &str) -> Result<u64> {
        let conn = self.conn.lock().await;
        let owned = "SELECT id FROM conversations WHERE owner_user_id = ?1";
        conn.execute(
            &format!("DELETE FROM messages WHERE conversation_id IN ({owned})"),
            params![owner_user_id],
        )?;
        conn.execute(
            &format!("DELETE FROM sessions WHERE conversation_id IN ({owned})"),
            params![owner_user_id],
        )?;
        conn.execute(
            &format!("DELETE FROM btw_entries WHERE conversation_id IN ({owned})"),
            params![owner_user_id],
        )?;
        let removed = conn.execute(
            "DELETE FROM conversations WHERE owner_user_id = ?1",
            params![owner_user_id],
        )?;
        Ok(removed as u64)
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
                "INSERT INTO sessions (id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    session_id,
                    conversation_id,
                    runnable_id,
                    runnable_kind.as_str(),
                    SessionStatus::Idle.as_str(),
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
            created_at: now,
            updated_at: now,
        })
    }

    /// Load a session by id.
    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at
             FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
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
            "SELECT id, conversation_id, runnable_id, runnable_kind, status, created_at, updated_at
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
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
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
                created_at,
                updated_at,
            });
        }
        Ok(out)
    }
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

/// Parse a JSON array of agent id strings from the `participants` column.
/// Returns an empty vec on null/empty/malformed input.
fn parse_participants_json(json: Option<&str>) -> Vec<String> {
    json.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Build a short conversation title from the first user message.
fn derive_title(content: &str) -> String {
    const MAX: usize = 60;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "New Chat".to_owned();
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.chars().count() <= MAX {
        return first_line.to_owned();
    }
    let truncated: String = first_line.chars().take(MAX).collect();
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
mod tests {
    use super::*;

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
    async fn search_messages_backfills_and_finds_existing() {
        // Wire an in-memory index, append messages, then search. Even if the
        // append-time spawned indexing hasn't run, the lazy backfill on the
        // first search embeds the stored (decrypted) messages and finds them.
        // Uses the local (network-free) embedder, so no embed sidecar is needed.
        let index = crate::search_host::in_memory_message_index().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_index(index);
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
    async fn fts_search_scopes_to_conversation_ids() {
        let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(index);
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
    async fn first_user_message_fires_auto_title_once() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let store = ConversationStore::open_in_memory()
            .unwrap()
            .with_auto_title(tx);

        // First user message fires the auto-rename signal.
        store
            .append_message("c1", "user", "first question", None, None, None)
            .await
            .unwrap();
        assert_eq!(rx.try_recv().ok(), Some("c1".to_owned()));

        // Assistant reply + a second user turn must NOT fire again.
        store
            .append_message("c1", "assistant", "an answer", None, None, None)
            .await
            .unwrap();
        store
            .append_message("c1", "user", "follow-up", None, None, None)
            .await
            .unwrap();
        assert!(rx.try_recv().is_err(), "auto-title should fire only once");

        // `get_first_user_message` returns the earliest user turn.
        assert_eq!(
            store.get_first_user_message("c1").await.unwrap().as_deref(),
            Some("first question")
        );
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

        let removed = store.clear_all_conversations().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count_conversations().await.unwrap(), 0);
        assert!(store.list_conversations().await.unwrap().is_empty());
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

    #[test]
    fn title_truncates_long_first_line() {
        let long = "a".repeat(100);
        let title = derive_title(&long);
        assert!(title.chars().count() <= 61); // 60 chars + ellipsis
        assert!(title.ends_with('…'));
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
}

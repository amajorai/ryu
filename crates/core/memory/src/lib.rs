//! Long-term memory primitive — the SQLite-backed [`MemoryStore`], the
//! multi-level scope model, and scoped recall/CRUD.
//!
//! Extracted from `apps/core/src/server/memory.rs` as an in-process capability
//! crate (mirrors `ryu-crypto`/`ryu-search`). The two Core couplings — the
//! `~/.ryu` default db path and the bind-time owner backfill's org/account
//! resolution — invert through plain constructor injection
//! ([`MemoryStore::open`] takes `node_bound` + `owner`), so this crate has ZERO
//! dependency on `apps/core`; the Core wiring lives in
//! `apps/core/src/memory_host.rs`.
//!
//! Two-tier memory for chat (spec unit U11), with multi-level scoping.
//!
//! Ryu assembles two kinds of context for each chat request:
//!
//! * **Short-term memory** — the recent turns of the *current* conversation.
//!   This is derived directly from U10's conversation store
//!   (`ConversationStore::get_recent_messages`) and assembled into a prompt
//!   prefix. It needs no separate storage.
//! * **Long-term memory** — durable facts carried *across* conversations. This is
//!   **opt-in** per the privacy-by-default principle: nothing is recorded or
//!   recalled unless the request explicitly enables it.
//!
//! Long-term facts carry a **scope level** — [`MemoryScope`] — describing how
//! broadly they apply:
//!
//! * `Agent`   — facts for one agent (`scope_id` = the agent id).
//! * `User`    — facts about the user, visible across agents (broadest personal level).
//! * `Node`    — facts scoped to this Core node / machine.
//! * `Project` — facts scoped to one working folder (`scope_id` = the folder path).
//! * `Org`     — facts shared across an organization (`scope_id` = the org id).
//!   Unlike the other three, an org fact is gated on the CALLER's org, so it is the
//!   one level whose visibility depends on who is asking. It is deliberately NOT in
//!   the default read set (see `effective_levels`): an agent must opt in.
//!
//! Which levels a given agent may read is governed by its `MemorySlot`
//! (`crate::agents::MemorySlot.read_levels`); the retrieval layer
//! (`crate::server::retrieval`) enforces the level + active-project filter at
//! recall time. Each fact is also classified by [`MemoryCategory`] and carries an
//! `importance`, optional `when_to_use` hint, and free-form `tags` — all editable
//! from the desktop Memory Library.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): memory is part of
//! *what runs* (orchestration / session state), not *what is allowed, shared,
//! measured, or paid for*, so it belongs in Core alongside the conversation
//! store from U10.
//!
//! Long-term entries are stored **encrypted-at-rest** with ChaCha20-Poly1305 via
//! the shared [`ryu_crypto`] master key (resolved from env → OS keychain →
//! file fallback, see `docs/encryption-at-rest.md`). The sensitive payload
//! (`content` + `when_to_use`) is bundled as JSON inside the ciphertext; the
//! filterable metadata (`scope`, `scope_id`, `category`, `importance`, `tags`)
//! lives in plaintext columns so it can be filtered in SQL.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_kernel_contracts::ResourceKey;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Default number of recent turns assembled as short-term context.
pub const DEFAULT_SHORT_TERM_LIMIT: usize = 10;
/// Default number of long-term entries recalled per request.
pub const DEFAULT_LONG_TERM_LIMIT: usize = 5;
/// Hard cap for source-store list/recall calls so a client cannot turn a memory
/// endpoint into an unbounded allocation request.
pub const MAX_MEMORY_QUERY_LIMIT: usize = 500;
/// Default importance for a fact when none is supplied (1..=5 scale).
pub const DEFAULT_IMPORTANCE: i32 = 3;
/// Sentinel user id used while Core is local-first/single-user.
///
/// `AuthState` only carries a device token, not a stable user id, so long-term
/// memory is scoped by `(LOCAL_USER, agent_id)`. When a real user identity is
/// introduced this constant becomes the request's user id.
pub const LOCAL_USER: &str = "local";

/// Derive memory's owning `user_id` from the shared [`ResourceKey`] composition
/// layer. Memory's `user_id` column is `NOT NULL` and shares by SCOPE (it has no
/// `org_id`), so the collapse here is user-only: an attributed key yields its
/// user; an unattributed one falls back to the [`LOCAL_USER`] sentinel — exactly
/// the value the write path used before `ResourceKey` existed, so no stored row
/// changes. This is the "constructors accept-or-derive a ResourceKey internally"
/// seam for the memory plane; [`MemoryStore::record`] still takes a `user_id: &str`.
///
/// FOLLOWUP (deferred this wave, per the task's DO-NOT list): a later wave folds
/// the key's `project`/`node` fields into [`MemoryScope::Project`]/[`MemoryScope::Node`]
/// (memory shares by scope, not by the `(user, org)` pair), so those compound
/// fields are intentionally NOT consulted here yet.
pub fn memory_user_from_key(key: &ResourceKey) -> &str {
    key.user.as_deref().unwrap_or(LOCAL_USER)
}

/// The SQL twin of the memory per-caller ACL — the ONE place memory read
/// visibility is expressed (mirrors `conversations.rs::TENANCY_VISIBLE_PREDICATE`,
/// but keyed on SCOPE, since memory sharing is scope-based, not org/visibility-based):
///   - `:bound = 0` (node UNBOUND / personal): no restriction. One principal; the
///     node token is the boundary — byte-identical to the pre-ACL behaviour.
///   - node ORG-BOUND: an `agent`/`user`-scope fact is PRIVATE — visible only to its owner
///     (`user_id = :uid`). `node`/`project`-scope facts are the shared "company
///     brain" — visible to every member. A `user`-scope row whose `user_id` is the
///     legacy `'local'` sentinel matches no real caller (fail closed) until the
///     bind-time backfill re-stamps it to the real owner.
///   - ORG scope: visible only to a caller in THAT org. Memory has no `org_id`
///     column, so the owning org id lives in `scope_id` — the same "the id that
///     qualifies this scope" contract `scope_id` already serves for `project` (a
///     folder path) and `node` (a node id). The comparison is against the caller's
///     org, so a NULL `scope_id`, a NULL caller org, or a mismatch all fail CLOSED.
///     Note the write path (`record_full`) refuses to store an org-scope fact
///     without a `scope_id`, so a row that would be invisible to everyone can never
///     be created in the first place.
const MEMORY_VISIBLE_PREDICATE: &str = "(
        :bound = 0
        OR scope = 'node'
        OR (scope = 'project' AND scope_id IS NOT NULL AND trim(scope_id) <> '')
        OR (:uid IS NOT NULL AND scope IN ('agent', 'user') AND user_id = :uid)
        OR (:org IS NOT NULL AND scope = 'org' AND scope_id = :org)
     )";

/// The caller context a tenancy-filtered memory query is evaluated against.
#[derive(Clone, Copy)]
pub struct MemoryVisibility<'a> {
    /// Whether THIS node is bound to an org. Unbound → no filtering.
    pub node_bound: bool,
    /// The verified caller's user id, or `None` for an anonymous caller.
    pub caller_user_id: Option<&'a str>,
    /// The caller's org id, or `None` when the caller has no org. `None` makes
    /// every `org`-scope fact invisible — the fail-closed direction.
    pub caller_org_id: Option<&'a str>,
}

impl<'a> MemoryVisibility<'a> {
    /// The in-process, full-trust filter (used internally / on an unbound node).
    pub fn unrestricted() -> Self {
        Self {
            node_bound: false,
            caller_user_id: None,
            caller_org_id: None,
        }
    }

    /// The filter for an HTTP caller on a possibly-bound node.
    pub fn for_caller(caller_user_id: Option<&'a str>, node_bound: bool) -> Self {
        Self::for_caller_in_org(caller_user_id, None, node_bound)
    }

    /// The filter for an HTTP caller on a possibly-bound node, including the
    /// caller's org so `org`-scope facts resolve. Prefer this over
    /// [`Self::for_caller`] on any path that can see org-scoped memory;
    /// `for_caller` passes `None` and therefore hides every org fact.
    pub fn for_caller_in_org(
        caller_user_id: Option<&'a str>,
        caller_org_id: Option<&'a str>,
        node_bound: bool,
    ) -> Self {
        Self {
            node_bound,
            caller_user_id,
            caller_org_id,
        }
    }

    /// Derive the read filter from the shared [`ResourceKey`] composition layer.
    /// Only the key's `user` participates (memory shares by scope, not org), so
    /// this is byte-identical to [`Self::for_caller`] fed `key.user`. `node_bound
    /// = false` collapses to [`Self::unrestricted`] regardless of the key — the
    /// UNBOUND-node no-op that keeps a personal node from ever filtering itself out.
    pub fn from_resource_key(key: &'a ResourceKey, node_bound: bool) -> Self {
        Self::for_caller_in_org(key.user.as_deref(), key.org.as_deref(), node_bound)
    }
}

/// How broadly a long-term fact applies. Serialized snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    /// Facts for one agent; `scope_id` holds the stable agent id.
    Agent,
    /// About the user; visible across every node and project.
    User,
    /// Scoped to this Core node / machine.
    Node,
    /// Scoped to one working folder; `scope_id` holds the folder path.
    Project,
    /// Shared across an organization; `scope_id` holds the org id, and only a
    /// caller in that org may read it.
    Org,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
            Self::Node => "node",
            Self::Project => "project",
            Self::Org => "org",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "agent" => Self::Agent,
            "node" => Self::Node,
            "project" => Self::Project,
            "org" => Self::Org,
            // An unrecognized scope decodes to the NARROWEST level, never a broader
            // one: a row written by a newer node must not become more widely visible
            // just because this binary does not understand its scope.
            _ => Self::User,
        }
    }
}

impl Default for MemoryScope {
    fn default() -> Self {
        Self::User
    }
}

/// A special-category topic that is kept out of memory unless the owning user
/// has explicitly enabled sensitive-topic memory for the current node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveTopic {
    HealthCondition,
    ReligiousBelief,
    PoliticalBelief,
    SexualOrientation,
    Financial,
    Legal,
    Biometric,
}

impl SensitiveTopic {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HealthCondition => "health_condition",
            Self::ReligiousBelief => "religious_belief",
            Self::PoliticalBelief => "political_belief",
            Self::SexualOrientation => "sexual_orientation",
            Self::Financial => "financial",
            Self::Legal => "legal",
            Self::Biometric => "biometric",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "health_condition" => Some(Self::HealthCondition),
            "religious_belief" => Some(Self::ReligiousBelief),
            "political_belief" => Some(Self::PoliticalBelief),
            "sexual_orientation" => Some(Self::SexualOrientation),
            "financial" => Some(Self::Financial),
            "legal" => Some(Self::Legal),
            "biometric" => Some(Self::Biometric),
            _ => None,
        }
    }
}

/// Deterministically identify the special-category topics covered by the
/// sensitive-memory consent. This is an admission guard, not a claim that the
/// text is medically, religiously, or legally classified with certainty.
pub fn detect_sensitive_topics(content: &str) -> Vec<SensitiveTopic> {
    let normalized = content.to_lowercase();
    let tokens: std::collections::HashSet<String> = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect();
    let contains_any = |phrases: &[&str]| {
        phrases.iter().any(|phrase| {
            if phrase.contains(' ') {
                normalized.contains(phrase)
            } else {
                tokens.contains(*phrase)
            }
        })
    };
    let mut topics = Vec::new();
    let checks = [
        (
            SensitiveTopic::HealthCondition,
            &[
                "health",
                "medical condition",
                "health condition",
                "diagnosis",
                "disease",
                "disability",
                "medication",
                "therapy",
                "hospital",
                "illness",
                "surgery",
                "allergy",
                "doctor",
            ][..],
        ),
        (
            SensitiveTopic::ReligiousBelief,
            &[
                "religion",
                "religious",
                "faith",
                "prayer",
                "church",
                "mosque",
                "synagogue",
                "temple",
                "christian",
                "muslim",
                "islam",
                "jewish",
                "judaism",
                "hindu",
                "buddhist",
                "atheist",
            ][..],
        ),
        (
            SensitiveTopic::PoliticalBelief,
            &[
                "politics",
                "political",
                "vote",
                "election",
                "political party",
                "democrat",
                "republican",
            ][..],
        ),
        (
            SensitiveTopic::SexualOrientation,
            &[
                "sexual orientation",
                "gay",
                "lesbian",
                "bisexual",
                "transgender",
            ][..],
        ),
        (
            SensitiveTopic::Financial,
            &[
                "bank account",
                "income",
                "salary",
                "debt",
                "credit card",
                "financial",
            ][..],
        ),
        (
            SensitiveTopic::Legal,
            &[
                "criminal record",
                "legal case",
                "lawsuit",
                "conviction",
                "immigration status",
            ][..],
        ),
        (
            SensitiveTopic::Biometric,
            &["fingerprint", "face scan", "retina scan", "biometric"][..],
        ),
    ];
    for (topic, phrases) in checks {
        if contains_any(phrases) {
            topics.push(topic);
        }
    }
    topics
}

/// What kind of fact a memory holds. Drives filtering and how the model is told
/// to use it. Serialized snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCategory {
    /// A stable fact about the user (name, role, location, environment).
    UserFact,
    /// How the user likes things done (style, tone, defaults, do/don't).
    Preference,
    /// Subject-matter knowledge the agent should ground on.
    DomainKnowledge,
    /// The user's company / team / org structure and processes.
    Organization,
    /// Facts about the current project / codebase (conventions, layout, decisions).
    ProjectContext,
    /// A specific person the user works with.
    Relationship,
    /// A standing instruction the agent must follow ("always X").
    Directive,
    /// A reusable how-to / workflow the agent learned.
    Procedure,
    /// A time-bound episodic fact ("decided X on date").
    Event,
    /// Anything that doesn't fit the categories above.
    Other,
}

/// Where a memory came from. This is provenance, not an access-control decision.
/// Source references live inside the encrypted payload because conversation and
/// message ids can reveal more than the fact's classification alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemorySource {
    /// A user or existing chat path wrote the fact directly.
    #[default]
    User,
    /// The fact was captured from a conversation turn.
    Conversation,
    /// The fact was imported from another memory store.
    Import,
    /// The fact was derived from explicit message feedback.
    Feedback,
    /// The fact was created by a reviewed dream/consolidation proposal.
    Consolidation,
}

impl MemorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Conversation => "conversation",
            Self::Import => "import",
            Self::Feedback => "feedback",
            Self::Consolidation => "consolidation",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "conversation" => Self::Conversation,
            "import" => Self::Import,
            "feedback" => Self::Feedback,
            "consolidation" => Self::Consolidation,
            _ => Self::User,
        }
    }
}

/// Lifecycle of a durable memory row. Recall only uses `Active` rows; the other
/// states retain an audit trail so a reviewed consolidation can be reversed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryLifecycle {
    #[default]
    Active,
    Superseded,
    Archived,
    Retracted,
}

impl MemoryLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Archived => "archived",
            Self::Retracted => "retracted",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "superseded" => Self::Superseded,
            "archived" => Self::Archived,
            "retracted" => Self::Retracted,
            _ => Self::Active,
        }
    }
}

/// Encrypted provenance attached to a memory row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MemoryProvenance {
    pub source: MemorySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

/// Metadata used when recording a memory without changing the legacy `NewMemory`
/// constructor shape used by existing chat and import paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MemoryMetadata {
    pub provenance: MemoryProvenance,
    #[serde(default)]
    pub lifecycle: MemoryLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
}

impl MemoryCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserFact => "user_fact",
            Self::Preference => "preference",
            Self::DomainKnowledge => "domain_knowledge",
            Self::Organization => "organization",
            Self::ProjectContext => "project_context",
            Self::Relationship => "relationship",
            Self::Directive => "directive",
            Self::Procedure => "procedure",
            Self::Event => "event",
            Self::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "preference" => Self::Preference,
            "domain_knowledge" => Self::DomainKnowledge,
            "organization" => Self::Organization,
            "project_context" => Self::ProjectContext,
            "relationship" => Self::Relationship,
            "directive" => Self::Directive,
            "procedure" => Self::Procedure,
            "event" => Self::Event,
            "other" => Self::Other,
            _ => Self::UserFact,
        }
    }
}

impl Default for MemoryCategory {
    fn default() -> Self {
        Self::UserFact
    }
}

/// A persisted long-term memory entry (decrypted form).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTermEntry {
    pub id: String,
    pub content: String,
    /// Breadth of applicability (agent / user / node / project / org).
    #[serde(default)]
    pub scope: MemoryScope,
    /// Project folder path when `scope == Project`; node id when `Node`; `None`
    /// for `User`; agent and org scope ids hold the selected agent or org.
    #[serde(default)]
    pub scope_id: Option<String>,
    /// Classification of the fact.
    #[serde(default)]
    pub category: MemoryCategory,
    /// 1..=5; higher is recalled first and boosted in ranking.
    #[serde(default = "default_importance")]
    pub importance: i32,
    /// Optional guidance on when this fact is relevant.
    #[serde(default)]
    pub when_to_use: Option<String>,
    /// Free-form tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The agent that recorded this fact (provenance only, not an access filter).
    #[serde(default)]
    pub author_agent_id: Option<String>,
    /// The verified human OWNER of this fact (the `memory_entries.user_id` column).
    /// This is the per-user tenancy key: on an org-bound node a `User`-scope fact is
    /// private to this owner (a `Node`/`Project`-scope fact is shared). `"local"` is
    /// the pre-attribution sentinel (unbound / single-user), which the bind-time
    /// backfill re-stamps to the real owner. Provenance for the ACL, not display.
    #[serde(default)]
    pub owner_user_id: Option<String>,
    /// Why this row exists and which encrypted source references support it.
    #[serde(default)]
    pub provenance: MemoryProvenance,
    /// Special-category topics detected in the encrypted content. These are an
    /// orthogonal privacy dimension, not a replacement for `category`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sensitive_topics: Vec<SensitiveTopic>,
    /// Active rows participate in recall. Other states remain reviewable for
    /// audit and rollback but are never silently injected into a prompt.
    #[serde(default)]
    pub lifecycle: MemoryLifecycle,
    /// The prior active row replaced by this revision, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds of the last edit (equals `created_at` when never edited).
    #[serde(default)]
    pub updated_at: i64,
}

fn default_importance() -> i32 {
    DEFAULT_IMPORTANCE
}

/// Input for recording a rich long-term fact (`record_full`).
#[derive(Debug, Clone)]
pub struct NewMemory {
    pub content: String,
    pub scope: MemoryScope,
    pub scope_id: Option<String>,
    pub category: MemoryCategory,
    pub importance: i32,
    pub when_to_use: Option<String>,
    pub tags: Vec<String>,
    pub author_agent_id: Option<String>,
}

impl NewMemory {
    /// A minimal user-level fact with default classification.
    pub fn user_fact(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            scope: MemoryScope::User,
            scope_id: None,
            category: MemoryCategory::UserFact,
            importance: DEFAULT_IMPORTANCE,
            when_to_use: None,
            tags: Vec::new(),
            author_agent_id: None,
        }
    }
}

/// A partial update to an existing memory (all fields optional).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoryPatch {
    pub content: Option<String>,
    pub scope: Option<MemoryScope>,
    pub scope_id: Option<Option<String>>,
    pub category: Option<MemoryCategory>,
    pub importance: Option<i32>,
    pub when_to_use: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
}

/// Filter for listing memories (all fields optional / AND-combined).
#[derive(Debug, Clone, Default)]
pub struct MemoryFilter {
    pub scope: Option<MemoryScope>,
    pub scope_id: Option<String>,
    pub category: Option<MemoryCategory>,
    pub limit: Option<usize>,
    pub lifecycle: Option<MemoryLifecycle>,
}

/// The only mutations a dream may propose. `Revise` is applied as a new row that
/// supersedes the target, never as an in-place edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalOperation {
    Create,
    Revise,
}

impl MemoryProposalOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Revise => "revise",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "revise" => Self::Revise,
            _ => Self::Create,
        }
    }
}

/// Review state for an encrypted revision proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalStatus {
    #[default]
    Pending,
    Applied,
    Rejected,
    RolledBack,
}

impl MemoryProposalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::RolledBack => "rolled_back",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "applied" => Self::Applied,
            "rejected" => Self::Rejected,
            "rolled_back" => Self::RolledBack,
            _ => Self::Pending,
        }
    }
}

/// The proposed memory body held inside an encrypted proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryProposalDraft {
    pub content: String,
    #[serde(default)]
    pub scope: MemoryScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default)]
    pub category: MemoryCategory,
    #[serde(default = "default_importance")]
    pub importance: i32,
    #[serde(default)]
    pub when_to_use: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub author_agent_id: Option<String>,
    #[serde(default)]
    pub metadata: MemoryMetadata,
}

impl MemoryProposalDraft {
    pub fn into_new_memory(self) -> NewMemory {
        NewMemory {
            content: self.content,
            scope: self.scope,
            scope_id: self.scope_id,
            category: self.category,
            importance: self.importance,
            when_to_use: self.when_to_use,
            tags: self.tags,
            author_agent_id: self.author_agent_id,
        }
    }
}

/// Input for creating a reviewable proposal.
#[derive(Debug, Clone)]
pub struct NewMemoryProposal {
    pub owner_user_id: String,
    pub agent_id: String,
    pub target_memory_id: Option<String>,
    pub operation: MemoryProposalOperation,
    pub draft: MemoryProposalDraft,
    pub rationale: String,
}

/// A decrypted, reviewable proposal returned by the Core API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRevisionProposal {
    pub id: String,
    pub owner_user_id: String,
    pub agent_id: String,
    pub target_memory_id: Option<String>,
    pub operation: MemoryProposalOperation,
    pub status: MemoryProposalStatus,
    pub draft: MemoryProposalDraft,
    pub rationale: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_memory_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MemoryProposalFilter {
    pub status: Option<MemoryProposalStatus>,
    pub limit: Option<usize>,
}

/// SQLite-backed long-term memory store. Cheap to clone (wraps `Arc`s).
///
/// Reuses the same on-disk database as the conversation store (a new table),
/// so there is a single `~/.ryu` database file.
#[derive(Clone)]
pub struct MemoryStore {
    conn: Arc<Mutex<Connection>>,
    cipher: ryu_crypto::FieldCipher,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryPayload {
    content: String,
    #[serde(default)]
    when_to_use: Option<String>,
    #[serde(default)]
    provenance: MemoryProvenance,
    #[serde(default)]
    sensitive_topics: Vec<SensitiveTopic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryProposalPayload {
    draft: MemoryProposalDraft,
    rationale: String,
}

/// Serialize sensitive content, source references, and sensitive-topic metadata
/// to JSON for encryption.
fn encode_payload(
    content: &str,
    when_to_use: Option<&str>,
    provenance: &MemoryProvenance,
    sensitive_topics: &[SensitiveTopic],
) -> Vec<u8> {
    serde_json::to_vec(&MemoryPayload {
        content: content.to_owned(),
        when_to_use: when_to_use.map(str::to_owned),
        provenance: provenance.clone(),
        sensitive_topics: sensitive_topics.to_vec(),
    })
    .unwrap_or_else(|_| content.as_bytes().to_vec())
}

/// Decode a decrypted payload back into `(content, when_to_use)`. Falls back to
/// treating the whole plaintext as `content` for legacy rows that stored the raw
/// string (pre-JSON payloads).
fn decode_payload(plain: &[u8]) -> MemoryPayload {
    let text = String::from_utf8_lossy(plain).into_owned();
    if let Ok(mut payload) = serde_json::from_str::<MemoryPayload>(&text) {
        if payload.sensitive_topics.is_empty() {
            // Legacy payloads had no classification. Re-run the local guard when
            // they are read so a pre-toggle health/religion fact is not widened
            // into recall merely because it predates the field.
            payload.sensitive_topics = detect_sensitive_topics(&payload.content);
        }
        return payload;
    }
    MemoryPayload {
        content: text,
        when_to_use: None,
        provenance: MemoryProvenance::default(),
        sensitive_topics: detect_sensitive_topics(&String::from_utf8_lossy(plain)),
    }
}

fn encode_tags(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn decode_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

impl MemoryStore {
    /// Open (or create) the store at a specific db path. Encryption uses the
    /// shared [`ryu_crypto`] master key.
    ///
    /// The bind-time owner backfill's two Core couplings are injected: `node_bound`
    /// is whether this node is registered to an org (resolved by the Core host from
    /// the control plane), and `owner` is the signed-in local account's user id (from
    /// the account vault). The default-path + resolution wiring lives in
    /// `apps/core/src/memory_host.rs`.
    pub fn open(db_path: PathBuf, node_bound: bool, owner: Option<&str>) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&db_path)
            .with_context(|| format!("opening memory db {}", db_path.display()))?;
        Self::init_schema(&conn)?;
        // One-shot owner backfill: pre-ACL memory rows carry `user_id = 'local'`.
        // Best-effort; never blocks opening the store. Deliberately NOT in
        // `init_schema` (the in-memory test store runs that and must never run the
        // backfill).
        if let Err(e) = Self::backfill_owner(&conn, node_bound, owner) {
            tracing::warn!("memory owner backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::global_cipher()?,
        })
    }

    /// Attribute pre-ACL `user_id = 'local'` memory rows to the local owner once the
    /// node binds — the memory twin of `ConversationStore::backfill_tenancy`. Note
    /// the transition is `'local' → owner` (memory's single-user sentinel), NOT
    /// `NULL → owner` (memory's `user_id` is NOT NULL).
    ///
    ///   - **Node UNBOUND**: return immediately (no marker). One principal; the node
    ///     token is the boundary — the `'local'` rows stay as they are, and
    ///     `MEMORY_VISIBLE_PREDICATE` (`:bound = 0`) shows them all. Reruns if the
    ///     node later joins an org.
    ///   - **Node ORG-BOUND**: `UPDATE memory_entries SET user_id = <owner> WHERE
    ///     user_id = 'local'`, so the owner keeps recalling their own facts (else a
    ///     `user`-scope `'local'` row matches no real caller → lockout). Idempotent
    ///     via a `memory_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: leave them + warn. Fail closed.
    ///
    /// `node_bound` (org-registration presence) and `owner` (the signed-in local
    /// account id) are resolved Core-side and injected — the control-plane and
    /// account-vault reads live in `apps/core/src/memory_host.rs`, keeping this
    /// crate free of any `apps/core` dependency.
    fn backfill_owner(conn: &Connection, node_bound: bool, owner: Option<&str>) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating memory_meta")?;
        let done: Option<String> = {
            let mut stmt =
                conn.prepare("SELECT value FROM memory_meta WHERE key = 'owner_backfill_v1'")?;
            let mut rows = stmt.query([])?;
            match rows.next()? {
                Some(r) => Some(r.get(0)?),
                None => None,
            }
        };
        if done.is_some() {
            return Ok(());
        }
        if !node_bound {
            // Node UNBOUND: one principal; the node token is the boundary. Leave the
            // 'local' rows as-is (reruns if the node later joins an org).
            return Ok(());
        }
        let Some(owner) = owner else {
            tracing::warn!(
                "memory owner backfill: org-bound node with no signed-in local account — \
                 leaving pre-ACL 'local' memory rows unattributed (fail closed)."
            );
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
                params![owner, LOCAL_USER],
            )
            .context("backfilling memory owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("memory owner backfill: attributed {claimed} pre-ACL memory row(s)");
        Ok(())
    }

    /// Open an in-memory store with an ephemeral key (used by tests and by Core's
    /// in-memory adapter tests). Never touches the real keychain or `~/.ryu`, and
    /// never runs the owner backfill.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::FieldCipher::new(&[0x22; 32]),
        })
    }

    /// Read the owning user's sensitive-topic consent for this node.
    ///
    /// The setting is deliberately stored beside the encrypted memory authority
    /// rather than in the node-global generic preferences table. A missing row is
    /// the safe default: sensitive memory is disabled.
    pub async fn include_sensitive_topics(&self, user_id: &str) -> Result<bool> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            return Ok(false);
        }
        let conn = self.conn.lock().await;
        let enabled: Option<i64> = conn
            .query_row(
                "SELECT include_sensitive_topics FROM memory_settings WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading sensitive memory setting")?;
        Ok(enabled == Some(1))
    }

    /// Persist the owning user's sensitive-topic consent for this node.
    pub async fn set_include_sensitive_topics(&self, user_id: &str, enabled: bool) -> Result<()> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            anyhow::bail!("a memory setting requires a user id");
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_settings (user_id, include_sensitive_topics, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET
                 include_sensitive_topics = excluded.include_sensitive_topics,
                 updated_at = excluded.updated_at",
            params![user_id, i64::from(enabled), now_millis()],
        )
        .context("writing sensitive memory setting")?;
        Ok(())
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS memory_entries (
                 id          TEXT PRIMARY KEY,
                 user_id     TEXT NOT NULL,
                 agent_id    TEXT NOT NULL,
                 nonce       BLOB NOT NULL,
                 ciphertext  BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 lifecycle   TEXT NOT NULL DEFAULT 'active',
                 supersedes_id TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_memory_scope
                 ON memory_entries(user_id, agent_id, created_at);
             CREATE TABLE IF NOT EXISTS memory_proposals (
                 id               TEXT PRIMARY KEY,
                 owner_user_id    TEXT NOT NULL,
                 agent_id         TEXT NOT NULL,
                 target_memory_id TEXT,
                 operation        TEXT NOT NULL,
                 status           TEXT NOT NULL DEFAULT 'pending',
                 nonce            BLOB NOT NULL,
                 ciphertext       BLOB NOT NULL,
                 created_at       INTEGER NOT NULL,
                 updated_at       INTEGER NOT NULL,
                 reviewed_at      INTEGER,
                 reviewed_by      TEXT,
                 applied_memory_id TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_memory_proposals_owner
                 ON memory_proposals(owner_user_id, status, created_at);
             CREATE TABLE IF NOT EXISTS memory_settings (
                 user_id                   TEXT PRIMARY KEY,
                 include_sensitive_topics INTEGER NOT NULL DEFAULT 0,
                 updated_at               INTEGER NOT NULL
             );",
        )
        .context("initializing memory schema")?;

        // Multi-level metadata columns (added incrementally; idempotent). Existing
        // rows default to user-level / user_fact / importance 3, keeping prior
        // facts readable and broadly visible.
        Self::add_column_if_missing(conn, "scope", "TEXT NOT NULL DEFAULT 'user'")?;
        Self::add_column_if_missing(conn, "scope_id", "TEXT")?;
        Self::add_column_if_missing(conn, "category", "TEXT NOT NULL DEFAULT 'user_fact'")?;
        Self::add_column_if_missing(conn, "importance", "INTEGER NOT NULL DEFAULT 3")?;
        Self::add_column_if_missing(conn, "tags", "TEXT NOT NULL DEFAULT '[]'")?;
        Self::add_column_if_missing(conn, "updated_at", "INTEGER NOT NULL DEFAULT 0")?;
        Self::add_column_if_missing(conn, "lifecycle", "TEXT NOT NULL DEFAULT 'active'")?;
        Self::add_column_if_missing(conn, "supersedes_id", "TEXT")?;

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memory_scope_level
                 ON memory_entries(scope, scope_id, category);
             CREATE INDEX IF NOT EXISTS idx_memory_lifecycle
                 ON memory_entries(lifecycle, updated_at);",
        )
        .context("creating memory level index")?;
        Ok(())
    }

    /// Add `memory_entries.<name>` when it is not already present. `PRAGMA
    /// table_info` is the in-repo migration pattern (see `agents::AgentStore`).
    fn add_column_if_missing(conn: &Connection, name: &str, decl: &str) -> Result<()> {
        let exists = {
            let mut stmt = conn.prepare("PRAGMA table_info(memory_entries)")?;
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for col in cols {
                if col? == name {
                    found = true;
                    break;
                }
            }
            found
        };
        if !exists {
            conn.execute(
                &format!("ALTER TABLE memory_entries ADD COLUMN {name} {decl}"),
                [],
            )
            .with_context(|| format!("adding memory column {name}"))?;
        }
        Ok(())
    }

    /// Record a plain long-term memory entry for `(user_id, agent_id)`, at
    /// user-level with default classification. Content is encrypted before it
    /// touches disk. Empty content is ignored. Back-compat entry point; richer
    /// captures use [`record_full`](Self::record_full).
    pub async fn record(
        &self,
        user_id: &str,
        agent_id: &str,
        content: &str,
    ) -> Result<Option<String>> {
        let mut mem = NewMemory::user_fact(content);
        mem.author_agent_id = Some(agent_id.to_string());
        self.record_full(user_id, agent_id, mem).await
    }

    /// Record a fully-classified long-term fact. Empty content is ignored.
    pub async fn record_full(
        &self,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
    ) -> Result<Option<String>> {
        self.record_full_with_metadata(user_id, agent_id, mem, MemoryMetadata::default())
            .await
    }

    /// Record a fully-classified fact with provenance/lifecycle metadata. This is
    /// the additive path used by reviewed consolidation; legacy callers continue
    /// through [`Self::record_full`] and receive active, user-sourced metadata.
    pub async fn record_full_with_metadata(
        &self,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
        metadata: MemoryMetadata,
    ) -> Result<Option<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        self.record_full_with_id_and_metadata(&id, user_id, agent_id, mem, metadata)
            .await
    }

    /// Record a fully-classified fact under a caller-provided stable id. This is
    /// used by compatibility APIs whose contract is idempotent re-indexing; the
    /// normal memory-authoring path should continue using [`Self::record_full`].
    pub async fn record_full_with_id(
        &self,
        id: &str,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
    ) -> Result<Option<String>> {
        self.record_full_with_id_and_metadata(id, user_id, agent_id, mem, MemoryMetadata::default())
            .await
    }

    async fn record_full_with_id_and_metadata(
        &self,
        id: &str,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
        metadata: MemoryMetadata,
    ) -> Result<Option<String>> {
        let id = id.trim();
        if id.is_empty() {
            anyhow::bail!("a memory id cannot be empty");
        }
        let trimmed = mem.content.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        // Agent/project/org-scoped facts are read back by matching `scope_id`
        // against the active qualifier. A missing qualifier would be a silent
        // black hole rather than an error, so refuse it at the write instead.
        if matches!(
            mem.scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && mem
            .scope_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            anyhow::bail!(
                "an agent-, project-, or org-scope memory requires a scope_id; without one \
                 the fact would be readable by nobody"
            );
        }
        let sensitive_topics = detect_sensitive_topics(trimmed);
        if !sensitive_topics.is_empty() && mem.scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        let when = mem
            .when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let (nonce, ciphertext) = self.encrypt(&encode_payload(
            trimmed,
            when,
            &metadata.provenance,
            &sensitive_topics,
        ))?;
        let now = now_millis();
        let importance = mem.importance.clamp(1, 5);
        let tags = encode_tags(&mem.tags);
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_entries
                (id, user_id, agent_id, nonce, ciphertext, created_at,
                 scope, scope_id, category, importance, tags, updated_at,
                 lifecycle, supersedes_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                user_id,
                agent_id,
                nonce,
                ciphertext,
                now,
                mem.scope.as_str(),
                mem.scope_id,
                mem.category.as_str(),
                importance,
                tags,
                now,
                metadata.lifecycle.as_str(),
                metadata.supersedes_id,
            ],
        )
        .context("inserting memory entry")?;
        Ok(Some(id.to_owned()))
    }

    /// Recall the most recent `limit` long-term entries for `(user_id, agent_id)`,
    /// newest first. Back-compat recency path (agent-scoped); the level-aware
    /// recall is [`recall_scoped`](Self::recall_scoped).
    pub async fn recall(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        self.recall_with_sensitive(user_id, agent_id, limit, true)
            .await
    }

    /// Recall recent entries while applying the sensitive-topic consent gate.
    /// The legacy `recall` method remains an unrestricted crate-level primitive;
    /// Core chat paths use this method with the caller's resolved consent.
    pub async fn recall_with_sensitive(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }

        // Sensitive classification lives inside the encrypted payload, so it
        // cannot be expressed in the SQL WHERE clause. Page through the source
        // rows until the caller has `limit` visible facts; a fixed multiplier
        // would return too few (or no) ordinary facts when many sensitive facts
        // happen to be newer.
        let page_size = if include_sensitive { limit } else { 128 };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        loop {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(
                    "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                            category, importance, tags, agent_id, updated_at, user_id,
                            lifecycle, supersedes_id
                     FROM memory_entries
                     WHERE user_id = ?1 AND agent_id = ?2 AND lifecycle = 'active'
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?3 OFFSET ?4",
                )?;
                Self::collect_rows(
                    &mut stmt,
                    params![user_id, agent_id, page_size as i64, offset as i64],
                )?
            };
            let row_count = rows.len();
            if row_count == 0 {
                break;
            }
            offset += row_count;
            let page = self.decrypt_rows(rows);
            if include_sensitive {
                entries = page;
                break;
            }
            entries.extend(
                page.into_iter()
                    .filter(|entry| entry.sensitive_topics.is_empty()),
            );
            if entries.len() >= limit {
                break;
            }
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// Recall recent entries visible to an agent granted `read_levels`, within the
    /// active `project_id`/`agent_id`. Ordered by importance then recency. When
    /// `read_levels` is empty all personal levels are visible.
    /// Project- and agent-scoped facts are only returned when their `scope_id`
    /// matches the active project or agent.
    pub async fn recall_scoped(
        &self,
        read_levels: &[MemoryScope],
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        self.recall_scoped_for_agent(read_levels, None, project_id, limit)
            .await
    }

    /// Recall recent entries across the requested levels, including the narrow
    /// `agent` level when `agent_id` matches its `scope_id`.
    pub async fn recall_scoped_for_agent(
        &self,
        read_levels: &[MemoryScope],
        agent_id: Option<&str>,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        let levels = Self::effective_levels(read_levels);
        // Inline the level set as quoted literals. Values come from
        // `MemoryScope::as_str()` (a closed set of `'agent'/'user'/'node'/'project'/'org'`), so
        // this is injection-safe and avoids depending on the json1 extension.
        let level_list = levels
            .iter()
            .map(|l| format!("'{}'", l.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id
             FROM memory_entries
             WHERE scope IN ({level_list}) AND lifecycle = 'active'
               AND (scope != 'agent' OR (?1 IS NOT NULL AND scope_id = ?1))
               AND (scope != 'project' OR (?2 IS NOT NULL AND scope_id = ?2))
             ORDER BY importance DESC, created_at DESC, rowid DESC
             LIMIT ?3"
        );
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(&sql)?;
            Self::collect_rows(&mut stmt, params![agent_id, project_id, limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// Recall recent entries across the requested levels while applying the
    /// caller's node-tenancy visibility and sensitive-topic consent. This is
    /// the source-store counterpart to the retrieval layer's memory filters:
    /// recency context must not bypass an agent's read levels, active project,
    /// owner, or organization boundary merely because it is assembled before
    /// vector/graph retrieval.
    pub async fn recall_visible_scoped_for_agent(
        &self,
        user_id: &str,
        read_levels: &[MemoryScope],
        agent_id: Option<&str>,
        project_id: Option<&str>,
        visibility: MemoryVisibility<'_>,
        limit: usize,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let levels = Self::effective_levels(read_levels);
        // Values come from the closed MemoryScope enum, so inlining the level
        // literals is injection-safe and keeps this query independent of json1.
        let level_list = levels
            .iter()
            .map(|level| format!("'{}'", level.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id
             FROM memory_entries
             WHERE scope IN ({level_list})
               AND lifecycle = 'active'
               AND (scope != 'agent' OR (:agent IS NOT NULL AND scope_id = :agent))
               AND (scope != 'project' OR (:project IS NOT NULL AND scope_id = :project))
               AND (:bound = 1 OR user_id = :owner)
               AND {MEMORY_VISIBLE_PREDICATE}
             ORDER BY created_at DESC, rowid DESC
             LIMIT :limit OFFSET :offset"
        );
        // Sensitive classification is encrypted, so page through source rows
        // until the caller has enough non-sensitive entries instead of allowing
        // newer sensitive rows to starve ordinary context.
        let page_size = if include_sensitive { limit } else { 128 };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        loop {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(&sql)?;
                Self::collect_rows(
                    &mut stmt,
                    rusqlite::named_params! {
                        ":owner": user_id,
                        ":agent": agent_id,
                        ":project": project_id,
                        ":bound": i64::from(visibility.node_bound),
                        ":uid": visibility.caller_user_id,
                        ":org": visibility.caller_org_id,
                        ":limit": page_size as i64,
                        ":offset": offset as i64,
                    },
                )?
            };
            let row_count = rows.len();
            if row_count == 0 {
                break;
            }
            offset += row_count;
            let page = self.decrypt_rows(rows);
            if include_sensitive {
                entries = page;
                break;
            }
            entries.extend(
                page.into_iter()
                    .filter(|entry| entry.sensitive_topics.is_empty()),
            );
            if entries.len() >= limit {
                break;
            }
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// Enumerate up to `limit` entries (all scopes) for backfilling the retrieval
    /// index; per-agent filtering happens at retrieve time.
    pub async fn all_for_backfill(&self, limit: usize) -> Result<Vec<LongTermEntry>> {
        self.all_for_backfill_page(limit, 0).await
    }

    /// Enumerate one stable page of active entries for a bounded backfill pass.
    /// The ordering matches [`Self::all_for_backfill`], so callers can walk past
    /// an already-indexed head and eventually reach older facts.
    pub async fn all_for_backfill_page(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at, user_id,
                        lifecycle, supersedes_id
                 FROM memory_entries
                 WHERE lifecycle = 'active'
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?1 OFFSET ?2",
            )?;
            Self::collect_rows(&mut stmt, params![limit as i64, offset as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// List entries for the management UI, filtered and newest-first. **Unfiltered
    /// by tenancy** — the in-process / unbound full listing. See
    /// [`list_visible`](Self::list_visible) for the per-caller form.
    pub async fn list(&self, filter: &MemoryFilter) -> Result<Vec<LongTermEntry>> {
        self.list_visible(filter, MemoryVisibility::unrestricted())
            .await
    }

    /// List entries the caller may READ, applying [`MEMORY_VISIBLE_PREDICATE`].
    /// On an UNBOUND node this is byte-identical to [`list`](Self::list) (`:bound = 0`
    /// disables the owner filter). On a BOUND node a `user`-scope fact is returned
    /// only to its owner; `node`/`project`-scope facts stay visible to every member
    /// (the shared "company brain"); an `org`-scope fact is visible only to a caller
    /// whose org matches the fact's `scope_id`.
    pub async fn list_visible(
        &self,
        filter: &MemoryFilter,
        vis: MemoryVisibility<'_>,
    ) -> Result<Vec<LongTermEntry>> {
        self.list_visible_with_sensitive(filter, vis, true).await
    }

    /// List visible entries while omitting special-category facts unless the
    /// caller's current consent allows them. The source rows stay encrypted; the
    /// filter runs after decryption so legacy rows are classified conservatively.
    pub async fn list_visible_with_sensitive(
        &self,
        filter: &MemoryFilter,
        vis: MemoryVisibility<'_>,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = filter
            .limit
            .unwrap_or(MAX_MEMORY_QUERY_LIMIT)
            .min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id
             FROM memory_entries
             WHERE (:scope IS NULL OR scope = :scope)
               AND (:scope_id IS NULL OR scope_id = :scope_id)
               AND (:category IS NULL OR category = :category)
               AND (:lifecycle IS NULL OR lifecycle = :lifecycle)
             AND {MEMORY_VISIBLE_PREDICATE}
             ORDER BY created_at DESC, rowid DESC
             LIMIT :limit OFFSET :offset"
        );
        let page_size = if include_sensitive { limit } else { 128 };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        loop {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(&sql)?;
                Self::collect_rows(
                    &mut stmt,
                    rusqlite::named_params! {
                        ":scope": filter.scope.map(|s| s.as_str()),
                        ":scope_id": filter.scope_id.as_deref(),
                        ":category": filter.category.map(|c| c.as_str()),
                        ":lifecycle": filter.lifecycle.map(|l| l.as_str()),
                        ":bound": i64::from(vis.node_bound),
                        ":uid": vis.caller_user_id,
                        ":org": vis.caller_org_id,
                        ":limit": page_size as i64,
                        ":offset": offset as i64,
                    },
                )?
            };
            let row_count = rows.len();
            if row_count == 0 {
                break;
            }
            offset += row_count;
            let page = self.decrypt_rows(rows);
            if include_sensitive {
                entries = page;
                break;
            }
            entries.extend(
                page.into_iter()
                    .filter(|entry| entry.sensitive_topics.is_empty()),
            );
            if entries.len() >= limit {
                break;
            }
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// Fetch a single entry by id.
    pub async fn get(&self, id: &str) -> Result<Option<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at, user_id,
                        lifecycle, supersedes_id
                 FROM memory_entries WHERE id = ?1",
            )?;
            Self::collect_rows(&mut stmt, params![id])?
        };
        Ok(self.decrypt_rows(rows).into_iter().next())
    }

    /// Apply a partial update to an entry. Returns the updated entry, or `None`
    /// when the id does not exist.
    pub async fn update(&self, id: &str, patch: MemoryPatch) -> Result<Option<LongTermEntry>> {
        let Some(existing) = self.get(id).await? else {
            return Ok(None);
        };
        if existing.lifecycle != MemoryLifecycle::Active {
            // Revisions and retractions are immutable audit records. Updating one
            // in place would let a stale retrieval/index request resurrect it or
            // mutate the history that rollback relies on.
            return Ok(None);
        }
        let content = patch.content.unwrap_or(existing.content);
        let when_to_use = match patch.when_to_use {
            Some(w) => w,
            None => existing.when_to_use,
        };
        let scope = patch.scope.unwrap_or(existing.scope);
        let scope_id = match patch.scope_id {
            Some(s) => s,
            None => existing.scope_id,
        };
        if matches!(
            scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && scope_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            anyhow::bail!("an agent-, project-, or org-scope memory requires a scope_id");
        }
        let category = patch.category.unwrap_or(existing.category);
        let importance = patch.importance.unwrap_or(existing.importance).clamp(1, 5);
        let tags = patch.tags.unwrap_or(existing.tags);

        let when = when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let sensitive_topics = detect_sensitive_topics(content.trim());
        if !sensitive_topics.is_empty() && scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        let (nonce, ciphertext) = self.encrypt(&encode_payload(
            content.trim(),
            when,
            &existing.provenance,
            &sensitive_topics,
        ))?;
        let now = now_millis();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE memory_entries
                 SET nonce = ?1, ciphertext = ?2, scope = ?3, scope_id = ?4,
                     category = ?5, importance = ?6, tags = ?7, updated_at = ?8
                 WHERE id = ?9",
                params![
                    nonce,
                    ciphertext,
                    scope.as_str(),
                    scope_id,
                    category.as_str(),
                    importance,
                    encode_tags(&tags),
                    now,
                    id,
                ],
            )
            .context("updating memory entry")?;
        }
        self.get(id).await
    }

    /// Persist a proposed create/revision without changing the active memory set.
    /// The draft and rationale are encrypted; only ownership, operation, and review
    /// state are queryable without opening the payload.
    pub async fn create_proposal(&self, proposal: NewMemoryProposal) -> Result<String> {
        if proposal.draft.content.trim().is_empty() {
            anyhow::bail!("a memory proposal requires non-empty content");
        }
        if proposal.operation == MemoryProposalOperation::Revise
            && proposal.target_memory_id.is_none()
        {
            anyhow::bail!("a revision proposal requires a target memory id");
        }
        if matches!(
            proposal.draft.scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && proposal
            .draft
            .scope_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            anyhow::bail!("an agent-, project-, or org-scope proposal requires a scope id");
        }
        if !detect_sensitive_topics(&proposal.draft.content).is_empty()
            && proposal.draft.scope != MemoryScope::User
        {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        let payload = serde_json::to_vec(&MemoryProposalPayload {
            draft: proposal.draft,
            rationale: proposal.rationale,
        })
        .context("serializing memory proposal")?;
        let (nonce, ciphertext) = self.encrypt(&payload)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_proposals
                (id, owner_user_id, agent_id, target_memory_id, operation, status,
                 nonce, ciphertext, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?8)",
            params![
                id,
                proposal.owner_user_id,
                proposal.agent_id,
                proposal.target_memory_id,
                proposal.operation.as_str(),
                nonce,
                ciphertext,
                now,
            ],
        )
        .context("inserting memory proposal")?;
        Ok(id)
    }

    /// List proposals for one owner. Pending is the default so callers do not
    /// accidentally expose the full historical proposal ledger.
    pub async fn list_proposals(
        &self,
        owner_user_id: &str,
        filter: &MemoryProposalFilter,
    ) -> Result<Vec<MemoryRevisionProposal>> {
        let limit = filter.limit.unwrap_or(100).min(500) as i64;
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, owner_user_id, agent_id, target_memory_id, operation,
                        status, nonce, ciphertext, created_at, updated_at,
                        reviewed_at, reviewed_by, applied_memory_id
                 FROM memory_proposals
                 WHERE owner_user_id = ?1
                   AND (?2 IS NULL OR status = ?2)
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )?;
            let status = filter.status.map(|s| s.as_str());
            let mapped = stmt.query_map(params![owner_user_id, status, limit], proposal_row)?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        };
        rows.into_iter()
            .map(|row| self.decrypt_proposal(row))
            .collect()
    }

    /// Fetch a proposal by id. The Core layer applies the owner/tenancy gate.
    pub async fn get_proposal(&self, id: &str) -> Result<Option<MemoryRevisionProposal>> {
        let row = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, owner_user_id, agent_id, target_memory_id, operation,
                        status, nonce, ciphertext, created_at, updated_at,
                        reviewed_at, reviewed_by, applied_memory_id
                 FROM memory_proposals WHERE id = ?1",
                params![id],
                proposal_row,
            )
            .optional()
            .context("reading memory proposal")?
        };
        row.map(|row| self.decrypt_proposal(row)).transpose()
    }

    /// Approve or reject a pending proposal. Approval is a transaction: a revision
    /// is inserted, the old row is superseded, and the proposal is marked applied
    /// together. Repeated review is idempotent and returns the current proposal.
    pub async fn review_proposal(
        &self,
        id: &str,
        approve: bool,
        reviewer: Option<&str>,
    ) -> Result<Option<MemoryRevisionProposal>> {
        let Some(proposal) = self.get_proposal(id).await? else {
            return Ok(None);
        };
        if proposal.status != MemoryProposalStatus::Pending {
            return Ok(Some(proposal));
        }
        let now = now_millis();
        if !approve {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE memory_proposals SET status = 'rejected', updated_at = ?1,
                    reviewed_at = ?1, reviewed_by = ?2
                 WHERE id = ?3 AND status = 'pending'",
                params![now, reviewer, id],
            )?;
            drop(conn);
            return self.get_proposal(id).await;
        }

        let target = if let Some(target_id) = proposal.target_memory_id.as_deref() {
            let Some(target) = self.get(target_id).await? else {
                anyhow::bail!("target memory no longer exists");
            };
            if target.lifecycle != MemoryLifecycle::Active {
                anyhow::bail!("target memory is no longer active");
            }
            Some(target)
        } else {
            None
        };
        let proposed_sensitive = detect_sensitive_topics(&proposal.draft.content);
        if matches!(
            proposal.draft.scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && proposal
            .draft
            .scope_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            anyhow::bail!("an agent-, project-, or org-scope proposal requires a scope id");
        }
        if !proposed_sensitive.is_empty() && proposal.draft.scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        if proposal.operation == MemoryProposalOperation::Revise && target.is_none() {
            anyhow::bail!("revision proposal target is missing");
        }

        // The proposal is re-checked under the transaction so two reviewers cannot
        // apply the same pending row concurrently. Keep the complete transaction
        // in this synchronous lexical block: `rusqlite::Transaction` borrows the
        // connection, which is not safe to carry across the async reread below.
        let needs_reload = {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction().context("starting proposal approval")?;
            let current_status: String = tx.query_row(
                "SELECT status FROM memory_proposals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            if MemoryProposalStatus::from_str(&current_status) != MemoryProposalStatus::Pending {
                tx.rollback()?;
                true
            } else {
                let new_id = uuid::Uuid::new_v4().to_string();
                let draft = &proposal.draft;
                let content = draft.content.trim();
                let when = draft
                    .when_to_use
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let sensitive_topics = detect_sensitive_topics(content);
                let (nonce, ciphertext) = self.encrypt(&encode_payload(
                    content,
                    when,
                    &draft.metadata.provenance,
                    &sensitive_topics,
                ))?;
                let supersedes_id = target.as_ref().map(|entry| entry.id.clone());
                tx.execute(
                    "INSERT INTO memory_entries
                        (id, user_id, agent_id, nonce, ciphertext, created_at,
                         scope, scope_id, category, importance, tags, updated_at,
                         lifecycle, supersedes_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?6, 'active', ?12)",
                    params![
                        new_id,
                        proposal.owner_user_id,
                        proposal.agent_id,
                        nonce,
                        ciphertext,
                        now,
                        draft.scope.as_str(),
                        draft.scope_id,
                        draft.category.as_str(),
                        draft.importance.clamp(1, 5),
                        encode_tags(&draft.tags),
                        supersedes_id,
                    ],
                )?;
                if let Some(target_id) = proposal.target_memory_id.as_deref() {
                    tx.execute(
                        "UPDATE memory_entries SET lifecycle = 'superseded', updated_at = ?1
                         WHERE id = ?2 AND lifecycle = 'active'",
                        params![now, target_id],
                    )?;
                }
                tx.execute(
                    "UPDATE memory_proposals SET status = 'applied', updated_at = ?1,
                        reviewed_at = ?1, reviewed_by = ?2, applied_memory_id = ?3
                     WHERE id = ?4 AND status = 'pending'",
                    params![now, reviewer, new_id, id],
                )?;
                tx.commit().context("committing proposal approval")?;
                false
            }
        };
        let _ = needs_reload;
        self.get_proposal(id).await
    }

    /// Reverse an applied proposal without deleting its audit records.
    pub async fn rollback_proposal(
        &self,
        id: &str,
        reviewer: Option<&str>,
    ) -> Result<Option<MemoryRevisionProposal>> {
        let Some(proposal) = self.get_proposal(id).await? else {
            return Ok(None);
        };
        if proposal.status != MemoryProposalStatus::Applied {
            return Ok(Some(proposal));
        }
        let Some(applied_id) = proposal.applied_memory_id.as_deref() else {
            anyhow::bail!("applied proposal has no revision id");
        };
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET lifecycle = 'retracted', updated_at = ?1
             WHERE id = ?2 AND lifecycle = 'active'",
            params![now, applied_id],
        )?;
        if let Some(target_id) = proposal.target_memory_id.as_deref() {
            conn.execute(
                "UPDATE memory_entries SET lifecycle = 'active', updated_at = ?1
                 WHERE id = ?2 AND lifecycle = 'superseded'",
                params![now, target_id],
            )?;
        }
        conn.execute(
            "UPDATE memory_proposals SET status = 'rolled_back', updated_at = ?1,
                reviewed_at = ?1, reviewed_by = ?2 WHERE id = ?3 AND status = 'applied'",
            params![now, reviewer, id],
        )?;
        drop(conn);
        self.get_proposal(id).await
    }

    /// Delete a single entry. Returns whether a row was removed.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM memory_entries WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// The ids of every entry carrying `tag` (an exact element of the plaintext
    /// `tags` JSON array). The array is stored as `["a","b"]`, so a quoted-substring
    /// match is exact per element. Used to find (and then delete + un-index) the
    /// prior feedback-derived facts for a message before re-recording, so a changed
    /// or cleared thumbs vote never leaves contradictory facts. `tags` is a
    /// non-encrypted column, so this needs no decryption.
    pub async fn ids_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        let needle = format!("%{}%", serde_json::Value::String(tag.to_string()));
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id FROM memory_entries WHERE tags LIKE ?1")?;
        let rows = stmt.query_map(params![needle], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Total number of stored long-term memory entries across every scope.
    /// Backs the danger-zone count preview.
    pub async fn count(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// Delete **every** long-term memory entry (all users/agents). Single-tenant
    /// today (`LOCAL_USER`), so this is the "forget everything" wipe. Returns the
    /// number of rows removed. The encryption key is untouched, so new memories
    /// recorded afterward stay readable.
    pub async fn clear_all(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM memory_entries", [])?;
        conn.execute("DELETE FROM memory_proposals", [])?;
        conn.execute("DELETE FROM memory_settings", [])?;
        Ok(removed as u64)
    }

    /// Empty `read_levels` means the four PERSONAL levels (unconfigured agent).
    ///
    /// [`MemoryScope::Org`] is deliberately excluded from this default. Every agent
    /// created before org scope existed has an empty slot, so including it would
    /// silently hand every one of them read access to organization-wide memory the
    /// moment the variant shipped — a privacy default change disguised as a schema
    /// addition. An agent must name `org` in its `read_levels` to see org facts.
    fn effective_levels(read_levels: &[MemoryScope]) -> Vec<MemoryScope> {
        if read_levels.is_empty() {
            vec![
                MemoryScope::Agent,
                MemoryScope::User,
                MemoryScope::Node,
                MemoryScope::Project,
            ]
        } else {
            read_levels.to_vec()
        }
    }

    /// Raw encrypted+metadata row as read from SQL, before decryption.
    fn collect_rows(
        stmt: &mut rusqlite::Statement<'_>,
        params: impl rusqlite::Params,
    ) -> Result<Vec<EncryptedRow>> {
        let mapped = stmt.query_map(params, |row| {
            Ok(EncryptedRow {
                id: row.get(0)?,
                nonce: row.get(1)?,
                ciphertext: row.get(2)?,
                created_at: row.get(3)?,
                scope: row.get(4)?,
                scope_id: row.get(5)?,
                category: row.get(6)?,
                importance: row.get(7)?,
                tags: row.get(8)?,
                author_agent_id: row.get(9)?,
                updated_at: row.get(10)?,
                owner_user_id: row.get(11)?,
                lifecycle: row.get(12)?,
                supersedes_id: row.get(13)?,
            })
        })?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row?);
        }
        Ok(out)
    }

    /// Decrypt a batch of rows, skipping any that fail to decrypt.
    fn decrypt_rows(&self, rows: Vec<EncryptedRow>) -> Vec<LongTermEntry> {
        let mut out = Vec::new();
        for r in rows {
            match self.decrypt(&r.nonce, &r.ciphertext) {
                Ok(plain) => {
                    let payload = decode_payload(&plain);
                    out.push(LongTermEntry {
                        id: r.id,
                        content: payload.content,
                        scope: MemoryScope::from_str(&r.scope),
                        scope_id: r.scope_id,
                        category: MemoryCategory::from_str(&r.category),
                        importance: r.importance,
                        when_to_use: payload.when_to_use,
                        tags: decode_tags(&r.tags),
                        author_agent_id: r.author_agent_id,
                        owner_user_id: r.owner_user_id,
                        provenance: payload.provenance,
                        sensitive_topics: payload.sensitive_topics,
                        lifecycle: MemoryLifecycle::from_str(&r.lifecycle),
                        supersedes_id: r.supersedes_id,
                        created_at: r.created_at,
                        updated_at: if r.updated_at == 0 {
                            r.created_at
                        } else {
                            r.updated_at
                        },
                    });
                }
                Err(e) => tracing::warn!("skipping undecryptable memory entry {}: {e}", r.id),
            }
        }
        out
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        self.cipher.encrypt(plaintext)
    }

    fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.cipher.decrypt(nonce, ciphertext)
    }

    fn decrypt_proposal(&self, row: ProposalRow) -> Result<MemoryRevisionProposal> {
        let plain = self.decrypt(&row.nonce, &row.ciphertext)?;
        let payload: MemoryProposalPayload =
            serde_json::from_slice(&plain).context("decoding memory proposal payload")?;
        Ok(MemoryRevisionProposal {
            id: row.id,
            owner_user_id: row.owner_user_id,
            agent_id: row.agent_id,
            target_memory_id: row.target_memory_id,
            operation: MemoryProposalOperation::from_str(&row.operation),
            status: MemoryProposalStatus::from_str(&row.status),
            draft: payload.draft,
            rationale: payload.rationale,
            created_at: row.created_at,
            updated_at: row.updated_at,
            reviewed_at: row.reviewed_at,
            reviewed_by: row.reviewed_by,
            applied_memory_id: row.applied_memory_id,
        })
    }
}

struct ProposalRow {
    id: String,
    owner_user_id: String,
    agent_id: String,
    target_memory_id: Option<String>,
    operation: String,
    status: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    created_at: i64,
    updated_at: i64,
    reviewed_at: Option<i64>,
    reviewed_by: Option<String>,
    applied_memory_id: Option<String>,
}

fn proposal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProposalRow> {
    Ok(ProposalRow {
        id: row.get(0)?,
        owner_user_id: row.get(1)?,
        agent_id: row.get(2)?,
        target_memory_id: row.get(3)?,
        operation: row.get(4)?,
        status: row.get(5)?,
        nonce: row.get(6)?,
        ciphertext: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        reviewed_at: row.get(10)?,
        reviewed_by: row.get(11)?,
        applied_memory_id: row.get(12)?,
    })
}

/// An encrypted row + its plaintext metadata, straight from SQL.
struct EncryptedRow {
    id: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    created_at: i64,
    scope: String,
    scope_id: Option<String>,
    category: String,
    importance: i32,
    tags: String,
    author_agent_id: Option<String>,
    updated_at: i64,
    owner_user_id: Option<String>,
    lifecycle: String,
    supersedes_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
    ///
    /// The memory plane derives its owning user from a `ResourceKey` and its read
    /// filter from one, both byte-identical to the pre-ResourceKey values —
    /// including the two load-bearing no-ops: an unattributed key maps to the
    /// `LOCAL_USER` sentinel (the exact value the write path used), and an UNBOUND
    /// node (`node_bound = false`) disables filtering regardless of the key.
    #[test]
    fn resource_key_memory_derivation_is_behavior_preserving() {
        // Owning user: attributed ⇒ the user; unattributed ⇒ the LOCAL_USER
        // sentinel, unchanged from the pre-ResourceKey write path.
        assert_eq!(
            memory_user_from_key(&ResourceKey::owned(Some("u1"), None)),
            "u1"
        );
        assert_eq!(
            memory_user_from_key(&ResourceKey::unattributed()),
            LOCAL_USER
        );
        // Memory has no org, so an org-only key still collapses to LOCAL_USER.
        assert_eq!(
            memory_user_from_key(&ResourceKey::owned(None, Some("acme"))),
            LOCAL_USER
        );

        // Read filter: on a BOUND node the caller user is carried through exactly
        // like `for_caller`.
        let bound_key = ResourceKey::owned(Some("u1"), None);
        let bound = MemoryVisibility::from_resource_key(&bound_key, true);
        assert!(bound.node_bound);
        assert_eq!(bound.caller_user_id, Some("u1"));

        // UNBOUND node: filtering is a total no-op regardless of the key — the
        // invariant that keeps a personal node from filtering itself out.
        let key = ResourceKey::owned(Some("u1"), Some("acme"));
        let unbound = MemoryVisibility::from_resource_key(&key, false);
        assert!(!unbound.node_bound);
        assert_eq!(
            unbound.node_bound,
            MemoryVisibility::unrestricted().node_bound
        );
    }

    #[tokio::test]
    async fn record_and_recall_round_trips() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "default", "User prefers dark mode")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "default", "User is based in Singapore")
            .await
            .unwrap();

        let recalled = store.recall(LOCAL_USER, "default", 10).await.unwrap();
        assert_eq!(recalled.len(), 2);
        // Newest first.
        assert_eq!(recalled[0].content, "User is based in Singapore");
        assert_eq!(recalled[1].content, "User prefers dark mode");
    }

    #[tokio::test]
    async fn recall_is_scoped_by_agent() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "agent-a", "fact for a")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "agent-b", "fact for b")
            .await
            .unwrap();

        let a = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].content, "fact for a");

        let none = store.recall(LOCAL_USER, "agent-c", 10).await.unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn clear_all_forgets_every_entry() {
        let store = MemoryStore::open_in_memory().unwrap();
        store.record(LOCAL_USER, "agent-a", "fact a").await.unwrap();
        store.record(LOCAL_USER, "agent-b", "fact b").await.unwrap();
        let proposal_id = store
            .create_proposal(NewMemoryProposal {
                owner_user_id: LOCAL_USER.to_owned(),
                agent_id: "agent-a".to_owned(),
                target_memory_id: None,
                operation: MemoryProposalOperation::Create,
                draft: MemoryProposalDraft {
                    content: "proposal to forget".to_owned(),
                    scope: MemoryScope::User,
                    scope_id: None,
                    category: MemoryCategory::UserFact,
                    importance: DEFAULT_IMPORTANCE,
                    when_to_use: None,
                    tags: Vec::new(),
                    author_agent_id: Some("agent-a".to_owned()),
                    metadata: MemoryMetadata::default(),
                },
                rationale: "test".to_owned(),
            })
            .await
            .unwrap();
        assert_eq!(store.count().await.unwrap(), 2);

        let removed = store.clear_all().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count().await.unwrap(), 0);
        assert!(store.get_proposal(&proposal_id).await.unwrap().is_none());
        // The key is intact, so new memories still record + recall afterward.
        store.record(LOCAL_USER, "agent-a", "fresh").await.unwrap();
        let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].content, "fresh");
    }

    #[tokio::test]
    async fn empty_content_is_not_recorded() {
        let store = MemoryStore::open_in_memory().unwrap();
        assert!(store
            .record(LOCAL_USER, "default", "   ")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .recall(LOCAL_USER, "default", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn record_full_persists_metadata() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record_full(
                LOCAL_USER,
                "agent-a",
                NewMemory {
                    content: "Uses pnpm not npm".into(),
                    scope: MemoryScope::Project,
                    scope_id: Some("/work/ryu".into()),
                    category: MemoryCategory::Preference,
                    importance: 5,
                    when_to_use: Some("when installing deps".into()),
                    tags: vec!["tooling".into()],
                    author_agent_id: Some("agent-a".into()),
                },
            )
            .await
            .unwrap()
            .unwrap();
        let got = store.get(&id).await.unwrap().unwrap();
        assert_eq!(got.content, "Uses pnpm not npm");
        assert_eq!(got.scope, MemoryScope::Project);
        assert_eq!(got.scope_id.as_deref(), Some("/work/ryu"));
        assert_eq!(got.category, MemoryCategory::Preference);
        assert_eq!(got.importance, 5);
        assert_eq!(got.when_to_use.as_deref(), Some("when installing deps"));
        assert_eq!(got.tags, vec!["tooling".to_string()]);
    }

    #[tokio::test]
    async fn record_full_with_id_preserves_a_stable_identifier() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record_full_with_id(
                "remembered-command",
                LOCAL_USER,
                "default",
                NewMemory::user_fact("Use the focused test command"),
            )
            .await
            .unwrap();
        assert_eq!(id.as_deref(), Some("remembered-command"));
        assert_eq!(
            store.get("remembered-command").await.unwrap().unwrap().id,
            "remembered-command"
        );
    }

    #[test]
    fn sensitive_topic_detection_covers_health_and_religion() {
        let health = detect_sensitive_topics("I have a peanut allergy and take medication");
        assert!(health.contains(&SensitiveTopic::HealthCondition));
        let religion = detect_sensitive_topics("I practice Buddhism and attend temple");
        assert!(religion.contains(&SensitiveTopic::ReligiousBelief));
        assert!(detect_sensitive_topics("I prefer concise release notes").is_empty());
        assert!(detect_sensitive_topics("Please review the terms and conditions").is_empty());
        assert!(detect_sensitive_topics("I went to a birthday party").is_empty());
        assert!(detect_sensitive_topics("I have a medical condition")
            .contains(&SensitiveTopic::HealthCondition));
    }

    #[tokio::test]
    async fn sensitive_memory_recall_is_off_until_user_consent() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "agent-a", "User prefers short answers")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "agent-a", "User has a diabetes diagnosis")
            .await
            .unwrap();

        assert!(!store.include_sensitive_topics(LOCAL_USER).await.unwrap());
        let hidden = store
            .recall_with_sensitive(LOCAL_USER, "agent-a", 10, false)
            .await
            .unwrap();
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].content, "User prefers short answers");

        store
            .set_include_sensitive_topics(LOCAL_USER, true)
            .await
            .unwrap();
        let visible = store
            .recall_with_sensitive(LOCAL_USER, "agent-a", 10, true)
            .await
            .unwrap();
        assert_eq!(visible.len(), 2);
        assert!(visible.iter().any(|entry| {
            entry
                .sensitive_topics
                .contains(&SensitiveTopic::HealthCondition)
        }));
    }

    #[tokio::test]
    async fn sensitive_filter_pages_until_it_finds_visible_facts() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "agent-a", "ordinary preference")
            .await
            .unwrap();
        for index in 0..129 {
            store
                .record(
                    LOCAL_USER,
                    "agent-a",
                    &format!("I have a diagnosis number {index}"),
                )
                .await
                .unwrap();
        }

        let visible = store
            .recall_with_sensitive(LOCAL_USER, "agent-a", 1, false)
            .await
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].content, "ordinary preference");

        let listed = store
            .list_visible_with_sensitive(
                &MemoryFilter {
                    limit: Some(1),
                    ..Default::default()
                },
                MemoryVisibility::unrestricted(),
                false,
            )
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content, "ordinary preference");
    }

    #[tokio::test]
    async fn agent_scope_requires_and_matches_its_agent_id() {
        let store = MemoryStore::open_in_memory().unwrap();
        let mut memory = NewMemory::user_fact("agent-only fact");
        memory.scope = MemoryScope::Agent;
        memory.scope_id = Some("agent-a".to_owned());
        store
            .record_full(LOCAL_USER, "agent-a", memory)
            .await
            .unwrap();

        let a = store
            .recall_scoped_for_agent(&[MemoryScope::Agent], Some("agent-a"), None, 10)
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        let b = store
            .recall_scoped_for_agent(&[MemoryScope::Agent], Some("agent-b"), None, 10)
            .await
            .unwrap();
        assert!(b.is_empty());
    }

    #[tokio::test]
    async fn recall_scoped_filters_by_level_and_project() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("global user fact");
                m.scope = MemoryScope::User;
                m
            })
            .await
            .unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("fact for project X");
                m.scope = MemoryScope::Project;
                m.scope_id = Some("/proj/x".into());
                m
            })
            .await
            .unwrap();
        store
            .record_full(LOCAL_USER, "a", {
                let mut m = NewMemory::user_fact("fact for project Y");
                m.scope = MemoryScope::Project;
                m.scope_id = Some("/proj/y".into());
                m
            })
            .await
            .unwrap();

        // User-only agent: sees just the global fact.
        let user_only = store
            .recall_scoped(&[MemoryScope::User], Some("/proj/x"), 10)
            .await
            .unwrap();
        assert_eq!(user_only.len(), 1);
        assert_eq!(user_only[0].content, "global user fact");

        // Project-enabled agent in project X: global + X, not Y.
        let in_x = store
            .recall_scoped(
                &[MemoryScope::User, MemoryScope::Project],
                Some("/proj/x"),
                10,
            )
            .await
            .unwrap();
        let contents: Vec<_> = in_x.iter().map(|e| e.content.as_str()).collect();
        assert!(contents.contains(&"global user fact"));
        assert!(contents.contains(&"fact for project X"));
        assert!(!contents.contains(&"fact for project Y"));
    }

    #[tokio::test]
    async fn visible_scoped_recall_applies_levels_project_and_owner() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full(
                "alice",
                "agent-a",
                NewMemory::user_fact("alice private fact"),
            )
            .await
            .unwrap();
        store
            .record_full("bob", "agent-a", NewMemory::user_fact("bob private fact"))
            .await
            .unwrap();
        store
            .record_full("alice", "agent-a", {
                let mut memory = NewMemory::user_fact("project X fact");
                memory.scope = MemoryScope::Project;
                memory.scope_id = Some("/proj/x".to_owned());
                memory
            })
            .await
            .unwrap();
        store
            .record_full("alice", "agent-a", {
                let mut memory = NewMemory::user_fact("project Y fact");
                memory.scope = MemoryScope::Project;
                memory.scope_id = Some("/proj/y".to_owned());
                memory
            })
            .await
            .unwrap();
        store
            .record_full("alice", "agent-a", {
                let mut memory = NewMemory::user_fact("shared node fact");
                memory.scope = MemoryScope::Node;
                memory
            })
            .await
            .unwrap();

        let entries = store
            .recall_visible_scoped_for_agent(
                "bob",
                &[MemoryScope::User, MemoryScope::Project],
                Some("agent-a"),
                Some("/proj/x"),
                MemoryVisibility::for_caller_in_org(Some("bob"), Some("acme"), true),
                10,
                false,
            )
            .await
            .unwrap();
        let contents: Vec<&str> = entries.iter().map(|entry| entry.content.as_str()).collect();
        assert!(contents.contains(&"bob private fact"));
        assert!(!contents.contains(&"alice private fact"));
        assert!(contents.contains(&"project X fact"));
        assert!(!contents.contains(&"project Y fact"));
        assert!(!contents.contains(&"shared node fact"));
    }

    #[tokio::test]
    async fn update_and_delete() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "original")
            .await
            .unwrap()
            .unwrap();
        let updated = store
            .update(
                &id,
                MemoryPatch {
                    content: Some("edited".into()),
                    importance: Some(5),
                    category: Some(MemoryCategory::Directive),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.content, "edited");
        assert_eq!(updated.importance, 5);
        assert_eq!(updated.category, MemoryCategory::Directive);

        assert!(store.delete(&id).await.unwrap());
        assert!(store.get(&id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn inactive_entries_cannot_be_updated_in_place() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "immutable revision")
            .await
            .unwrap()
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE memory_entries SET lifecycle = 'superseded' WHERE id = ?1",
                params![id],
            )
            .unwrap();
        }

        assert!(store
            .update(
                &id,
                MemoryPatch {
                    content: Some("must not change".to_owned()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.get(&id).await.unwrap().unwrap().content,
            "immutable revision"
        );
    }

    #[tokio::test]
    async fn update_refuses_sensitive_content_in_shared_scopes() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "ordinary preference")
            .await
            .unwrap()
            .unwrap();

        let error = store
            .update(
                &id,
                MemoryPatch {
                    content: Some("I have a diabetes diagnosis".into()),
                    scope: Some(MemoryScope::Node),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("user scope"));

        let existing_sensitive = store
            .record(LOCAL_USER, "a", "I have a peanut allergy")
            .await
            .unwrap()
            .unwrap();
        let error = store
            .update(
                &existing_sensitive,
                MemoryPatch {
                    scope: Some(MemoryScope::Project),
                    scope_id: Some(Some("/work/ryu".to_owned())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("user scope"));
    }

    /// Per-caller tenancy (the `MEMORY_VISIBLE_PREDICATE`): on a bound node a
    /// `user`-scope fact is private to its owner while `node`/`project` facts stay
    /// shared. Driven with `MemoryVisibility::for_caller(node_bound = true)` so no
    /// org registration is needed (the caller tenancy is passed IN).
    /// Build an org-scope fact belonging to org `org`.
    fn org_fact(org: &str, content: &str) -> NewMemory {
        let mut m = NewMemory::user_fact(content);
        m.scope = MemoryScope::Org;
        m.scope_id = Some(org.to_owned());
        m
    }

    #[tokio::test]
    async fn org_memory_is_visible_only_inside_its_own_org() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full("alice", "a", org_fact("acme", "acme roadmap"))
            .await
            .unwrap();
        store
            .record_full("zoe", "a", org_fact("initech", "initech roadmap"))
            .await
            .unwrap();
        let filter = MemoryFilter::default();

        // A member of acme sees acme's fact and NOT initech's — even though the
        // initech fact is owned by a different user entirely, the gate is the org.
        let acme = store
            .list_visible(
                &filter,
                MemoryVisibility::for_caller_in_org(Some("bob"), Some("acme"), true),
            )
            .await
            .unwrap();
        let contents: Vec<&str> = acme.iter().map(|e| e.content.as_str()).collect();
        assert!(contents.contains(&"acme roadmap"));
        assert!(
            !contents.contains(&"initech roadmap"),
            "org memory must not leak across orgs"
        );
    }

    #[tokio::test]
    async fn org_memory_fails_closed_without_a_caller_org() {
        // The regression that matters: a caller with no org on a BOUND node must see
        // no org facts at all, rather than falling through to a permissive branch.
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full("alice", "a", org_fact("acme", "acme roadmap"))
            .await
            .unwrap();

        let orgless = store
            .list_visible(
                &MemoryFilter::default(),
                MemoryVisibility::for_caller(Some("bob"), true),
            )
            .await
            .unwrap();
        assert!(
            orgless.iter().all(|e| e.content != "acme roadmap"),
            "a caller with no org must not read org memory"
        );
    }

    #[tokio::test]
    async fn org_memory_is_visible_on_an_unbound_personal_node() {
        // On an unbound node there is exactly one principal and the node token is the
        // boundary, so nothing is filtered — including org rows. Without this the
        // owner of a personal node could be locked out of their own data.
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record_full("alice", "a", org_fact("acme", "acme roadmap"))
            .await
            .unwrap();
        let all = store
            .list_visible(&MemoryFilter::default(), MemoryVisibility::unrestricted())
            .await
            .unwrap();
        assert!(all.iter().any(|e| e.content == "acme roadmap"));
    }

    #[tokio::test]
    async fn an_org_fact_without_a_scope_id_is_refused_at_write() {
        // Such a row would match no caller in the predicate, i.e. be readable by
        // nobody. Better to fail loudly at the write than to store a black hole.
        let store = MemoryStore::open_in_memory().unwrap();
        let mut m = NewMemory::user_fact("orphan org fact");
        m.scope = MemoryScope::Org;
        let err = store.record_full("alice", "a", m).await.unwrap_err();
        assert!(
            err.to_string().contains("scope_id"),
            "error should name the missing scope_id, got: {err}"
        );
    }

    #[tokio::test]
    async fn a_project_fact_without_a_scope_id_is_refused_at_write() {
        let store = MemoryStore::open_in_memory().unwrap();
        let mut memory = NewMemory::user_fact("orphan project fact");
        memory.scope = MemoryScope::Project;
        let error = store.record_full("alice", "a", memory).await.unwrap_err();
        assert!(error.to_string().contains("scope_id"));
    }

    #[test]
    fn org_is_not_in_the_default_read_levels() {
        // An unconfigured agent must NOT silently gain organization-wide reads.
        let levels = MemoryStore::effective_levels(&[]);
        assert!(!levels.contains(&MemoryScope::Org));
        assert_eq!(
            levels,
            vec![
                MemoryScope::Agent,
                MemoryScope::User,
                MemoryScope::Node,
                MemoryScope::Project,
            ]
        );
        // But an agent that explicitly asks for it gets it.
        assert!(MemoryStore::effective_levels(&[MemoryScope::Org]).contains(&MemoryScope::Org));
    }

    #[test]
    fn org_scope_round_trips_and_unknown_scopes_decode_to_the_narrowest() {
        assert_eq!(MemoryScope::from_str("org"), MemoryScope::Org);
        assert_eq!(MemoryScope::Org.as_str(), "org");
        // A scope written by a newer node must not decode to something broader.
        assert_eq!(MemoryScope::from_str("team"), MemoryScope::User);
        assert_eq!(MemoryScope::from_str("galaxy"), MemoryScope::User);
    }

    #[tokio::test]
    async fn list_visible_scopes_user_facts_per_owner_on_bound_node() {
        let store = MemoryStore::open_in_memory().unwrap();
        // Alice's private user fact.
        store
            .record_full("alice", "a", NewMemory::user_fact("alice private secret"))
            .await
            .unwrap();
        // Bob's private user fact.
        store
            .record_full("bob", "a", NewMemory::user_fact("bob private secret"))
            .await
            .unwrap();
        // A shared node-scope fact (the company brain).
        store
            .record_full("alice", "a", {
                let mut m = NewMemory::user_fact("shared org policy");
                m.scope = MemoryScope::Node;
                m
            })
            .await
            .unwrap();

        let filter = MemoryFilter::default();

        // Bob (bound node): sees his own user fact + the shared node fact, NOT Alice's.
        let bob = store
            .list_visible(&filter, MemoryVisibility::for_caller(Some("bob"), true))
            .await
            .unwrap();
        let bob_contents: Vec<&str> = bob.iter().map(|e| e.content.as_str()).collect();
        assert!(
            !bob_contents.contains(&"alice private secret"),
            "Bob must not read Alice's user memory"
        );
        assert!(bob_contents.contains(&"bob private secret"));
        assert!(
            bob_contents.contains(&"shared org policy"),
            "node-scope memory is shared"
        );

        // Alice (bound node): her own + shared, not Bob's — no lockout on her data.
        let alice = store
            .list_visible(&filter, MemoryVisibility::for_caller(Some("alice"), true))
            .await
            .unwrap();
        let alice_contents: Vec<&str> = alice.iter().map(|e| e.content.as_str()).collect();
        assert!(alice_contents.contains(&"alice private secret"));
        assert!(alice_contents.contains(&"shared org policy"));
        assert!(!alice_contents.contains(&"bob private secret"));

        // UNBOUND node: byte-identical — every fact visible regardless of owner.
        let unbound = store
            .list_visible(&filter, MemoryVisibility::unrestricted())
            .await
            .unwrap();
        assert_eq!(
            unbound.len(),
            3,
            "unbound node sees all facts (no filtering)"
        );
    }

    /// The bind-time `'local' → owner` backfill (the memory twin of the conversation
    /// backfill). Driven directly against the SQL so it needs no org registration:
    /// a pre-ACL `'local'` user row is invisible to a real caller until re-stamped.
    #[tokio::test]
    async fn local_rows_backfill_to_owner() {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .record(LOCAL_USER, "a", "legacy fact recorded before ACL")
            .await
            .unwrap()
            .unwrap();

        // Before backfill, a bound-node caller "alice" cannot see the 'local' row.
        let before = store
            .list_visible(
                &MemoryFilter::default(),
                MemoryVisibility::for_caller(Some("alice"), true),
            )
            .await
            .unwrap();
        assert!(
            before.is_empty(),
            "pre-backfill 'local' user row is invisible to a real caller (fail closed)"
        );

        // Simulate the backfill's UPDATE ('local' → the local owner) directly.
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
                params!["alice", LOCAL_USER],
            )
            .unwrap();
        }

        let after = store
            .list_visible(
                &MemoryFilter::default(),
                MemoryVisibility::for_caller(Some("alice"), true),
            )
            .await
            .unwrap();
        assert_eq!(
            after.len(),
            1,
            "after backfill the owner reaches their legacy fact"
        );
        assert_eq!(after[0].id, id);
        assert_eq!(after[0].owner_user_id.as_deref(), Some("alice"));
    }

    #[test]
    fn stored_ciphertext_is_not_plaintext() {
        // The encrypt step must not leave the content readable.
        let store = MemoryStore::open_in_memory().unwrap();
        let secret = b"super secret memory";
        let (nonce, ciphertext) = store.encrypt(secret).unwrap();
        assert_ne!(ciphertext.as_slice(), secret);
        let decrypted = store.decrypt(&nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, secret);
    }
}

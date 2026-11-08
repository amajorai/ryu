//! The long-term memory data model: scope, category, source, lifecycle and
//! provenance, the persisted entry, and the write/patch/filter inputs.

use serde::{Deserialize, Serialize};

use crate::{SensitiveTopic, DEFAULT_IMPORTANCE};

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

impl MemoryMetadata {
    /// Active metadata that records only where the fact came from.
    pub fn from_source(source: MemorySource) -> Self {
        Self {
            provenance: MemoryProvenance {
                source,
                ..MemoryProvenance::default()
            },
            ..Self::default()
        }
    }

    /// Active metadata for a fact captured from a chat turn, citing the
    /// conversation and the persisted message(s) it was captured from. Blank
    /// ids are dropped so a turn without a stored row cites nothing.
    pub fn conversation(
        conversation_id: Option<String>,
        message_ids: impl IntoIterator<Item = String>,
    ) -> Self {
        let mut metadata = Self::from_source(MemorySource::Conversation);
        metadata.provenance.conversation_id = conversation_id.filter(|id| !id.trim().is_empty());
        metadata.provenance.message_ids = message_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect();
        metadata
    }
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

pub(crate) fn default_importance() -> i32 {
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

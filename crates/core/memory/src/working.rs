//! Working memory: a structured, per-thread or per-resource scratchpad.
//!
//! Long-term memory ([`crate::MemoryStore::record_full`]) is a growing set of
//! discrete facts that are *recalled* by relevance. Working memory is the other
//! shape: ONE small document per `(owner, scope, id)` that the agent keeps
//! up to date and that is injected, whole, into its context on every turn — the
//! user's name, the goal of the current task, the decisions made so far.
//!
//! Two modes, chosen by how the scratchpad is described:
//!
//! * **Template** ([`WorkingMemoryMode::Template`]) — free-form Markdown seeded
//!   from a template. An update *replaces* the whole document, so the agent
//!   rewrites the template with the fields filled in.
//! * **Schema** ([`WorkingMemoryMode::Schema`]) — a JSON object described by a
//!   JSON Schema. An update is a JSON **merge patch** (RFC 7386: objects merge
//!   recursively, `null` deletes a key, everything else replaces), and the merged
//!   result is validated against the schema before it is stored.
//!
//! Scope:
//!
//! * [`WorkingMemoryScope::Thread`] — `id` is a conversation / thread id; the
//!   scratchpad lives and dies with one conversation.
//! * [`WorkingMemoryScope::Resource`] — `id` is a caller-chosen resource key
//!   (a user, a customer, a project); the scratchpad is shared by every thread
//!   that names the same resource.
//!
//! Tenancy: every row is partitioned by the owning user derived from the shared
//! [`ResourceKey`] ([`crate::memory_user_from_key`]). A caller can only ever
//! address its OWN partition, so a guessed thread or resource id never reaches
//! another user's scratchpad. Further gates (e.g. "the caller may see this
//! conversation") are the host's job and live in Core.
//!
//! Storage: the document (content / data / template / schema) is encrypted at
//! rest with the same [`ryu_crypto`] cipher as long-term memory; only the routing
//! key `(owner, scope, id)`, the mode, and timestamps are plaintext.

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod history;
mod render;
mod store;
mod validate;

pub use history::WORKING_MEMORY_HISTORY_LIMIT;
pub use render::render_working_memory_block;
pub use validate::merge_patch;
use validate::validate_schema_spec;

/// Largest serialized working-memory document (content or data) accepted, in
/// bytes. Working memory is injected into EVERY turn, so it must stay small.
pub const MAX_WORKING_MEMORY_BYTES: usize = 16 * 1024;
/// Largest template or schema accepted, in bytes.
pub const MAX_WORKING_MEMORY_SPEC_BYTES: usize = 16 * 1024;
/// Longest thread / resource id accepted.
pub const MAX_WORKING_MEMORY_ID_LEN: usize = 256;
/// Deepest JSON nesting a schema-mode merge or validation will walk.
const MAX_DEPTH: usize = 32;

/// The default Markdown template used when an agent enables template-mode
/// working memory without supplying its own (mirrors Mastra's default).
pub const DEFAULT_WORKING_MEMORY_TEMPLATE: &str = "# User Information\n\
- **First Name**:\n\
- **Last Name**:\n\
- **Location**:\n\
- **Occupation**:\n\
- **Interests**:\n\
- **Goals**:\n\
- **Events**:\n\
- **Facts**:\n\
- **Projects**:\n";

/// Which partition a working-memory document belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkingMemoryScope {
    /// One conversation / thread; `id` is the thread id.
    #[default]
    Thread,
    /// Shared by every thread about one resource; `id` is the resource key.
    Resource,
}

impl WorkingMemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Resource => "resource",
        }
    }

    /// Parse a wire value. Unknown values are rejected rather than defaulted:
    /// silently widening `"threadd"` to a resource-wide scratchpad would leak
    /// one thread's notes into every other.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "thread" => Some(Self::Thread),
            "resource" => Some(Self::Resource),
            _ => None,
        }
    }
}

/// How the scratchpad is shaped and how updates apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkingMemoryMode {
    /// Markdown document; updates replace it.
    #[default]
    Template,
    /// JSON object validated by a JSON Schema; updates are merge patches.
    Schema,
}

impl WorkingMemoryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Template => "template",
            Self::Schema => "schema",
        }
    }

    fn from_db(value: &str) -> Self {
        if value == "schema" {
            Self::Schema
        } else {
            Self::Template
        }
    }
}

/// The agent-level working-memory configuration (an agent's `MemorySlot` and
/// the SDK `Agent({ workingMemory })` option share this shape).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemoryConfig {
    /// Whether working memory is on. Defaults to `true` when the block is
    /// present, so `{ "scope": "thread" }` alone enables it.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// `thread` (default) or `resource`.
    #[serde(default = "default_scope")]
    pub scope: WorkingMemoryScope,
    /// Markdown template (template mode). Ignored when `schema` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// JSON Schema for the scratchpad object (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

fn default_true() -> bool {
    true
}

fn default_scope() -> WorkingMemoryScope {
    WorkingMemoryScope::Thread
}

impl WorkingMemoryConfig {
    /// The mode this configuration selects: a schema wins over a template.
    pub fn mode(&self) -> WorkingMemoryMode {
        if self.schema.is_some() {
            WorkingMemoryMode::Schema
        } else {
            WorkingMemoryMode::Template
        }
    }

    /// Check the configuration is usable before it is persisted on an agent.
    pub fn validate(&self) -> Result<()> {
        if let Some(template) = &self.template {
            if template.len() > MAX_WORKING_MEMORY_SPEC_BYTES {
                bail!("working memory template exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes");
            }
        }
        if let Some(schema) = &self.schema {
            validate_schema_spec(schema)?;
        }
        Ok(())
    }
}

/// One stored working-memory document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemory {
    pub scope: WorkingMemoryScope,
    pub id: String,
    pub mode: WorkingMemoryMode,
    /// Markdown document (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Structured object (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// The template the document was seeded from (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// The schema `data` is validated against (schema mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// Monotonic per-document revision, starting at 1.
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A write to a working-memory document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkingMemoryWrite {
    /// Explicit mode. When absent: an existing document keeps its mode; a new one
    /// is schema mode when `data` or `schema` is given, else template mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<WorkingMemoryMode>,
    /// Replacement Markdown (template mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Merge patch (schema mode). With `replace: true` it replaces the object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// Template to record (or change) for template mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Schema to record (or change) for schema mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    /// Schema mode only: replace the whole object instead of merging.
    #[serde(default)]
    pub replace: bool,
    /// Optimistic concurrency: when set, the write fails unless the stored
    /// version equals this value (`0` = "must not exist yet").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i64>,
}

/// Why a working-memory write was refused. Hosts map these to 4xx statuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkingMemoryError {
    /// The request itself is malformed or violates the schema (400).
    Invalid(String),
    /// `expected_version` did not match (409).
    Conflict { current: i64 },
}

impl std::fmt::Display for WorkingMemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Conflict { current } => {
                write!(f, "working memory changed (current version {current})")
            }
        }
    }
}

impl std::error::Error for WorkingMemoryError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkingPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    schema: Option<Value>,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_working (
             owner_user_id TEXT NOT NULL,
             scope         TEXT NOT NULL,
             scope_id      TEXT NOT NULL,
             mode          TEXT NOT NULL,
             nonce         BLOB NOT NULL,
             ciphertext    BLOB NOT NULL,
             version       INTEGER NOT NULL,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             PRIMARY KEY (owner_user_id, scope, scope_id)
         );",
    )
    .context("initializing working memory schema")?;
    history::init_history_schema(conn)
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(WorkingMemoryError::Invalid(message.into()))
}

fn normalize_id(id: &str) -> Result<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(invalid("a working memory id is required"));
    }
    if id.len() > MAX_WORKING_MEMORY_ID_LEN {
        return Err(invalid(format!(
            "a working memory id must be at most {MAX_WORKING_MEMORY_ID_LEN} characters"
        )));
    }
    if id.chars().any(char::is_control) {
        return Err(invalid(
            "a working memory id cannot contain control characters",
        ));
    }
    Ok(id)
}

#[cfg(test)]
mod history_tests;

#[cfg(test)]
mod render_tests;

#[cfg(test)]
mod store_tests;

#[cfg(test)]
mod validate_tests;

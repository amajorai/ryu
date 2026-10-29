//! Projects › Bots/Groups › Sessions — the generic hierarchy primitives.
//!
//! Users mostly talk to **main threads** (a project's coordinator thread, a bot's
//! own thread, or a group's coordinator thread). Work happens in **sessions**:
//! per-activity threads a main thread spawns through `threads.*`. Every level is
//! an ordinary [`ConversationStore`] conversation; this module only adds the
//! metadata that places a conversation in the hierarchy and the per-scope model
//! defaults Core resolves at turn time.
//!
//! Everything here is deliberately app-agnostic. `project_id` is an OPAQUE scope
//! id: the Projects app (`@ryu/projects`) owns project records and hands Core the
//! id when it starts turns, but Core never interprets it beyond filtering, memory
//! scoping and the defaults lookup — the same contract `MemoryScope::Project`
//! already has for its `scope_id`.
//!
//! Lives as a child module of `conversations` so it can use the store's private
//! connection without widening its visibility.

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{ConversationStore, Tenancy};

/// A user-facing coordinator thread (project, bot, or group).
pub const THREAD_ROLE_MAIN: &str = "main";
/// A per-activity thread. The default for every existing chat.
pub const THREAD_ROLE_SESSION: &str = "session";

/// Upper bound on how many child sessions / project threads one listing returns.
const MAX_HIERARCHY_LISTING: usize = 500;

/// Longest opaque id (project, owner, agent) accepted from a client.
const MAX_SCOPE_ID_CHARS: usize = 200;

/// The group coordination strategies a group's main thread may carry. Mirrors the
/// Groups (`@ryu/teams`) `Coordination` enum so a saved Group and an ad-hoc group
/// chat speak the same vocabulary.
pub const COORDINATION_VALUES: &[&str] =
    &["broadcast", "round-robin", "debate-synthesis", "router"];

/// Who a main thread belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerKind {
    Project,
    Agent,
    Group,
}

impl OwnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Agent => "agent",
            Self::Group => "group",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "project" => Some(Self::Project),
            "agent" => Some(Self::Agent),
            "group" => Some(Self::Group),
            _ => None,
        }
    }
}

/// Where a conversation sits in the Projects › Bots/Groups › Sessions hierarchy.
/// Flattened into [`ConversationSummary`], so list endpoints carry it for free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadHierarchy {
    /// Opaque project scope id, or null when the thread is outside any project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// `main` or `session`.
    #[serde(default = "default_thread_role")]
    pub thread_role: String,
    /// `project` / `agent` / `group` on a main thread; null on a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    /// The owning project, agent, or group id (a saved Group's team id, or the
    /// conversation's own id for an ad-hoc group chat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    /// Coordination strategy of an ad-hoc group's main thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordination: Option<String>,
    /// The thread whose turn spawned this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by_conversation_id: Option<String>,
    /// The turn (message) in that thread that spawned this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by_message_id: Option<String>,
}

fn default_thread_role() -> String {
    THREAD_ROLE_SESSION.to_owned()
}

impl Default for ThreadHierarchy {
    fn default() -> Self {
        Self {
            project_id: None,
            thread_role: default_thread_role(),
            owner_kind: None,
            owner_id: None,
            coordination: None,
            spawned_by_conversation_id: None,
            spawned_by_message_id: None,
        }
    }
}

impl ThreadHierarchy {
    pub fn is_main(&self) -> bool {
        self.thread_role == THREAD_ROLE_MAIN
    }
}

/// The hierarchy columns, in the order [`hierarchy_from_row`] reads them.
pub(super) const HIERARCHY_SELECT: &str = "c.project_id, c.thread_role, c.owner_kind, \
     c.owner_id, c.coordination, c.spawned_by_conversation_id, c.spawned_by_message_id";

/// Number of columns [`HIERARCHY_SELECT`] contributes.
pub(super) const HIERARCHY_COLUMN_COUNT: usize = 7;

/// Read the [`HIERARCHY_SELECT`] columns starting at `start`.
pub(super) fn hierarchy_from_row(
    row: &rusqlite::Row<'_>,
    start: usize,
) -> rusqlite::Result<ThreadHierarchy> {
    let role: Option<String> = row.get(start + 1)?;
    Ok(ThreadHierarchy {
        project_id: row.get(start)?,
        thread_role: role.unwrap_or_else(default_thread_role),
        owner_kind: row.get(start + 2)?,
        owner_id: row.get(start + 3)?,
        coordination: row.get(start + 4)?,
        spawned_by_conversation_id: row.get(start + 5)?,
        spawned_by_message_id: row.get(start + 6)?,
    })
}

/// Additive, idempotent migration for the hierarchy columns, the one-main-thread
/// index, and the scope-defaults table. Safe on every startup.
pub(super) fn migrate(
    conn: &Connection,
    existing_conv_columns: &std::collections::HashSet<String>,
) -> Result<()> {
    let classify_groups = !existing_conv_columns.contains("thread_role");
    for (col, ddl) in [
        (
            "project_id",
            "ALTER TABLE conversations ADD COLUMN project_id TEXT",
        ),
        (
            "thread_role",
            "ALTER TABLE conversations ADD COLUMN thread_role TEXT NOT NULL DEFAULT 'session'",
        ),
        (
            "owner_kind",
            "ALTER TABLE conversations ADD COLUMN owner_kind TEXT",
        ),
        (
            "owner_id",
            "ALTER TABLE conversations ADD COLUMN owner_id TEXT",
        ),
        (
            "coordination",
            "ALTER TABLE conversations ADD COLUMN coordination TEXT",
        ),
        (
            "spawned_by_conversation_id",
            "ALTER TABLE conversations ADD COLUMN spawned_by_conversation_id TEXT",
        ),
        (
            "spawned_by_message_id",
            "ALTER TABLE conversations ADD COLUMN spawned_by_message_id TEXT",
        ),
    ] {
        if !existing_conv_columns.contains(col) {
            conn.execute_batch(ddl)
                .with_context(|| format!("adding hierarchy column {col}"))?;
        }
    }
    migrate_personal_bot_main_index(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_conversations_project
             ON conversations(project_id) WHERE project_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_conversations_spawned_by
             ON conversations(spawned_by_conversation_id)
             WHERE spawned_by_conversation_id IS NOT NULL;
         CREATE TABLE IF NOT EXISTS scope_defaults (
             scope      TEXT PRIMARY KEY,
             provider   TEXT NOT NULL DEFAULT '',
             model      TEXT NOT NULL DEFAULT '',
             effort     TEXT NOT NULL DEFAULT '',
             updated_at INTEGER NOT NULL
         );",
    )
    .context("creating hierarchy indexes and scope defaults")?;
    migrate_coordinator_defaults(conn)?;
    if classify_groups {
        // A group chat IS its group's main (coordinator) thread. Existing
        // multi-agent chats, and chats shared with another human participant,
        // become ad-hoc group main threads owned by themselves, so the unique
        // index can never collide.
        conn.execute_batch(
            "UPDATE conversations
                SET thread_role = 'main', owner_kind = 'group', owner_id = id
              WHERE json_valid(participants) AND json_array_length(participants) > 1
                 OR id IN (SELECT conversation_id FROM conversation_collaborators
                            WHERE role = 'participant')",
        )
        .context("classifying existing group chats as group main threads")?;
    }
    Ok(())
}

/// One main thread per `(project, owner)`, except a bot's personal main thread
/// (no project), which is unique per principal: each verified user and the node
/// operator get their own. Builds before this kept one shared bot main thread,
/// so the old index is replaced once; existing rows already satisfy both new
/// indexes, and conversation ids, messages and lineage are untouched.
fn migrate_personal_bot_main_index(conn: &Connection) -> Result<()> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_main_owner'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some_and(|sql| !sql.contains("owner_kind <> 'agent'")) {
        conn.execute_batch("DROP INDEX idx_conversations_main_owner;")
            .context("replacing the shared bot main-thread index")?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_main_owner
             ON conversations(IFNULL(project_id, ''), owner_kind, owner_id)
             WHERE thread_role = 'main' AND (project_id IS NOT NULL OR owner_kind <> 'agent');
         CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_personal_bot_main_owner
             ON conversations(owner_kind, owner_id, IFNULL(owner_user_id, ''), IFNULL(org_id, ''))
             WHERE thread_role = 'main' AND project_id IS NULL AND owner_kind = 'agent';",
    )
    .context("creating main-thread owner indexes")
}

/// Add the coordinator (main-thread) columns to a `scope_defaults` table created
/// before they existed. Idempotent.
fn migrate_coordinator_defaults(conn: &Connection) -> Result<()> {
    let existing: std::collections::HashSet<String> = conn
        .prepare("PRAGMA table_info(scope_defaults)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    for col in [
        "coordinator_provider",
        "coordinator_model",
        "coordinator_effort",
    ] {
        if !existing.contains(col) {
            conn.execute_batch(&format!(
                "ALTER TABLE scope_defaults ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"
            ))
            .with_context(|| format!("adding scope default column {col}"))?;
        }
    }
    Ok(())
}

#[path = "conversations_hierarchy_defaults.rs"]
mod defaults;
pub use defaults::*;

#[path = "conversations_hierarchy_store.rs"]
mod store;

#[cfg(test)]
#[path = "conversations_hierarchy_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "conversations_hierarchy_owner_tests.rs"]
mod owner_tests;

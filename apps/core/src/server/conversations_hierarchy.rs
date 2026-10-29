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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{now_millis, ConversationStore, ConversationSummary, Tenancy};

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
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_main_owner
             ON conversations(IFNULL(project_id, ''), owner_kind, owner_id)
             WHERE thread_role = 'main';
         CREATE INDEX IF NOT EXISTS idx_conversations_project
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

/// A write of one scope's defaults. The thread pair is always written; each
/// coordinator field is optional so a client that only knows the thread pair
/// (an older Desktop, or an app) keeps the stored coordinator values instead of
/// wiping them. An explicit `""` still clears one.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScopeDefaultInput {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(
        default,
        rename = "coordinatorProvider",
        alias = "coordinator_provider"
    )]
    pub coordinator_provider: Option<String>,
    #[serde(default, rename = "coordinatorModel", alias = "coordinator_model")]
    pub coordinator_model: Option<String>,
    #[serde(default, rename = "coordinatorEffort", alias = "coordinator_effort")]
    pub coordinator_effort: Option<String>,
}

impl ScopeDefaultInput {
    /// The value to store: this write, with omitted coordinator fields taken
    /// from `stored`.
    pub fn merged_over(self, stored: ScopeDefault) -> ScopeDefault {
        ScopeDefault {
            provider: self.provider,
            model: self.model,
            effort: self.effort,
            coordinator_provider: self
                .coordinator_provider
                .unwrap_or(stored.coordinator_provider),
            coordinator_model: self.coordinator_model.unwrap_or(stored.coordinator_model),
            coordinator_effort: self.coordinator_effort.unwrap_or(stored.coordinator_effort),
        }
    }
}

/// The stored columns of one scope default, in [`scope_default_from_row`] order.
const SCOPE_DEFAULT_COLUMNS: &str = "provider, model, effort, coordinator_provider, \
     coordinator_model, coordinator_effort";

fn scope_default_from_row(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<ScopeDefault> {
    Ok(ScopeDefault {
        provider: row.get(start)?,
        model: row.get(start + 1)?,
        effort: row.get(start + 2)?,
        coordinator_provider: row.get(start + 3)?,
        coordinator_model: row.get(start + 4)?,
        coordinator_effort: row.get(start + 5)?,
    })
}

/// The node-wide scope a user sets in Settings › Models. It sits above the
/// node's lane selection (Gateway › Defaults) and below every project and bot.
pub const GLOBAL_SCOPE: &str = "global";

/// Which kind of thread a turn runs in, for the coordinator/thread split.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DefaultsRole {
    /// A main (coordinator) thread of a project, bot or group.
    Coordinator,
    /// A session, or any chat outside the hierarchy.
    #[default]
    Thread,
}

impl DefaultsRole {
    pub fn for_thread_role(thread_role: &str) -> Self {
        if thread_role == THREAD_ROLE_MAIN {
            Self::Coordinator
        } else {
            Self::Thread
        }
    }
}

/// One scope's defaults. Empty strings mean "not set here".
///
/// `provider`/`model`/`effort` are the **thread** defaults: they apply to every
/// thread in the scope. The `coordinator_*` fields override them for **main
/// threads** only, so a project can coordinate on a strong model while its
/// sessions run on a cheaper one. A main thread reads the coordinator values
/// through the whole cascade first and falls back to the thread values only
/// when no level sets one (see [`CascadeLevels::for_role`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeDefault {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    // New wire fields are camelCase (consistency standard §3); the snake_case
    // aliases accept either spelling on input.
    #[serde(
        default,
        rename = "coordinatorProvider",
        alias = "coordinator_provider"
    )]
    pub coordinator_provider: String,
    #[serde(default, rename = "coordinatorModel", alias = "coordinator_model")]
    pub coordinator_model: String,
    #[serde(default, rename = "coordinatorEffort", alias = "coordinator_effort")]
    pub coordinator_effort: String,
}

impl ScopeDefault {
    fn trimmed(self) -> Self {
        Self {
            provider: self.provider.trim().to_owned(),
            model: self.model.trim().to_owned(),
            effort: self.effort.trim().to_owned(),
            coordinator_provider: self.coordinator_provider.trim().to_owned(),
            coordinator_model: self.coordinator_model.trim().to_owned(),
            coordinator_effort: self.coordinator_effort.trim().to_owned(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.provider.is_empty()
            && self.model.is_empty()
            && self.effort.is_empty()
            && self.coordinator_provider.is_empty()
            && self.coordinator_model.is_empty()
            && self.coordinator_effort.is_empty()
    }

    fn has_coordinator_model(&self) -> bool {
        !self.coordinator_model.trim().is_empty()
    }

    fn has_coordinator_effort(&self) -> bool {
        !self.coordinator_effort.trim().is_empty()
    }

    /// This level reduced to the plain provider/model/effort one role reads.
    /// `coordinator_model` picks the coordinator pair (provider and model move
    /// together); `coordinator_effort` picks the coordinator effort on its own.
    fn reduced(&self, coordinator_model: bool, coordinator_effort: bool) -> Self {
        let (provider, model) = if coordinator_model {
            (&self.coordinator_provider, &self.coordinator_model)
        } else {
            (&self.provider, &self.model)
        };
        let effort = if coordinator_effort {
            &self.coordinator_effort
        } else {
            &self.effort
        };
        Self {
            provider: provider.clone(),
            model: model.clone(),
            effort: effort.clone(),
            ..Self::default()
        }
    }

    fn has_model(&self) -> bool {
        !self.model.trim().is_empty()
    }

    fn has_effort(&self) -> bool {
        !self.effort.trim().is_empty()
    }
}

/// The level a resolved value came from, most specific first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultSource {
    /// The conversation's own override (`agent_controls` / composer pin).
    Session,
    /// `project:<p>/agent:<a>` — this bot inside this project.
    ProjectAgent,
    /// `agent:<a>` — this bot everywhere.
    Agent,
    /// The agent card's own bound model.
    AgentBinding,
    /// `project:<p>` — everything in this project.
    Project,
    /// `global` — the node-wide default a user sets in Settings › Models.
    Settings,
    /// The node's lane selection (Gateway › Defaults).
    Global,
}

/// The effective defaults for one turn, with where each value came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedDefault {
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// Where the provider/model PAIR came from. `None` when no level set a model.
    pub model_source: Option<DefaultSource>,
    /// Where the effort came from (it falls through independently).
    pub effort_source: Option<DefaultSource>,
}

/// Every level of the cascade for one turn, most specific first.
#[derive(Debug, Clone, Default)]
pub struct CascadeLevels {
    pub session: Option<ScopeDefault>,
    pub project_agent: Option<ScopeDefault>,
    pub agent: Option<ScopeDefault>,
    /// The agent card's bound model (no provider/effort on the card itself).
    pub agent_binding_model: Option<String>,
    pub project: Option<ScopeDefault>,
    /// The stored `global` scope (Settings › Models).
    pub settings: Option<ScopeDefault>,
    /// The node's lane selection (Gateway › Defaults).
    pub global: Option<ScopeDefault>,
}

impl CascadeLevels {
    fn stored(&self) -> [Option<&ScopeDefault>; 4] {
        [
            self.project_agent.as_ref(),
            self.agent.as_ref(),
            self.project.as_ref(),
            self.settings.as_ref(),
        ]
    }

    /// Reduce the stored levels to the plain values a thread of `role` reads.
    ///
    /// A session reads the thread values. A main thread reads the coordinator
    /// values when ANY stored level sets one (model and effort decide
    /// separately), so a coordinator model set in Settings beats a project's
    /// thread model, while the levels' order still decides between coordinator
    /// values. With no coordinator value anywhere it reads the thread values,
    /// so scopes that only ever set one pair keep applying to every thread.
    /// The session, agent-binding and lane levels apply to both roles as-is.
    pub fn for_role(mut self, role: DefaultsRole) -> Self {
        let (coordinator_model, coordinator_effort) = match role {
            DefaultsRole::Thread => (false, false),
            DefaultsRole::Coordinator => {
                let stored = self.stored();
                (
                    stored.iter().flatten().any(|l| l.has_coordinator_model()),
                    stored.iter().flatten().any(|l| l.has_coordinator_effort()),
                )
            }
        };
        for level in [
            &mut self.project_agent,
            &mut self.agent,
            &mut self.project,
            &mut self.settings,
        ] {
            *level = level
                .take()
                .map(|l| l.reduced(coordinator_model, coordinator_effort))
                .filter(|l| !l.is_empty());
        }
        self
    }
}

/// Resolve the cascade:
///
/// `session > project:<p>/agent:<a> > agent:<a> > agent binding > project:<p> >
/// settings > global`
///
/// Call it on levels already reduced with [`CascadeLevels::for_role`]; the
/// coordinator fields are ignored here.
///
/// Provider and model resolve as a PAIR from the first level that names a model,
/// so a turn never mixes a model from one level with a provider from another it
/// cannot serve. Effort falls through on its own.
pub fn resolve_cascade(levels: &CascadeLevels) -> ResolvedDefault {
    let binding = levels
        .agent_binding_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(|model| ScopeDefault {
            provider: String::new(),
            model: model.to_owned(),
            ..ScopeDefault::default()
        });
    let ordered: [(DefaultSource, Option<&ScopeDefault>); 7] = [
        (DefaultSource::Session, levels.session.as_ref()),
        (DefaultSource::ProjectAgent, levels.project_agent.as_ref()),
        (DefaultSource::Agent, levels.agent.as_ref()),
        (DefaultSource::AgentBinding, binding.as_ref()),
        (DefaultSource::Project, levels.project.as_ref()),
        (DefaultSource::Settings, levels.settings.as_ref()),
        (DefaultSource::Global, levels.global.as_ref()),
    ];
    let model_level = ordered
        .iter()
        .find_map(|(source, level)| level.filter(|l| l.has_model()).map(|l| (*source, l)));
    let effort_level = ordered
        .iter()
        .find_map(|(source, level)| level.filter(|l| l.has_effort()).map(|l| (*source, l)));
    ResolvedDefault {
        provider: model_level
            .map(|(_, l)| l.provider.trim().to_owned())
            .unwrap_or_default(),
        model: model_level
            .map(|(_, l)| l.model.trim().to_owned())
            .unwrap_or_default(),
        effort: effort_level
            .map(|(_, l)| l.effort.trim().to_owned())
            .unwrap_or_default(),
        model_source: model_level.map(|(source, _)| source),
        effort_source: effort_level.map(|(source, _)| source),
    }
}

/// `project:<id>`.
pub fn project_scope(project_id: &str) -> String {
    format!("project:{}", project_id.trim())
}

/// `agent:<id>`.
pub fn agent_scope(agent_id: &str) -> String {
    format!("agent:{}", agent_id.trim())
}

/// `project:<p>/agent:<a>`.
pub fn project_agent_scope(project_id: &str, agent_id: &str) -> String {
    format!("project:{}/agent:{}", project_id.trim(), agent_id.trim())
}

fn valid_opaque_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().count() <= MAX_SCOPE_ID_CHARS
        && !value.contains('/')
        && !value.chars().any(char::is_control)
}

/// Validate an opaque id supplied by a client (project, owner, agent).
pub fn validate_opaque_id(value: &str) -> Result<()> {
    if valid_opaque_id(value) {
        Ok(())
    } else {
        anyhow::bail!(
            "ids must be 1-{MAX_SCOPE_ID_CHARS} characters with no '/' or control characters"
        )
    }
}

/// Whether `scope` is one of the stored scope shapes: `global` (Settings ›
/// Models), `project:<id>`, `agent:<id>` or `project:<id>/agent:<id>`.
pub fn is_valid_scope(scope: &str) -> bool {
    if scope == GLOBAL_SCOPE {
        return true;
    }
    if let Some(rest) = scope.strip_prefix("agent:") {
        return valid_opaque_id(rest);
    }
    let Some(rest) = scope.strip_prefix("project:") else {
        return false;
    };
    match rest.split_once("/agent:") {
        Some((project, agent)) => valid_opaque_id(project) && valid_opaque_id(agent),
        None => valid_opaque_id(rest),
    }
}

/// Validate an optional coordination value.
pub fn validate_coordination(value: Option<&str>) -> Result<()> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(()),
        Some(value) if COORDINATION_VALUES.contains(&value) => Ok(()),
        Some(value) => anyhow::bail!("unknown coordination '{value}'"),
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn set_thread_project_locked(
    conn: &Connection,
    conversation_id: &str,
    project_id: Option<&str>,
) -> Result<bool> {
    let changed = conn
        .execute(
            "UPDATE conversations SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_id, now_millis(), conversation_id],
        )
        .context("setting conversation project")?;
    Ok(changed == 1)
}

fn mark_spawned_by_locked(
    conn: &Connection,
    child_id: &str,
    parent_id: &str,
    parent_message_id: Option<&str>,
) -> Result<()> {
    if child_id == parent_id {
        return Ok(());
    }
    conn.execute(
        "UPDATE conversations
            SET spawned_by_conversation_id = ?2,
                spawned_by_message_id = ?3,
                project_id = COALESCE(project_id,
                    (SELECT p.project_id FROM conversations p WHERE p.id = ?2))
          WHERE id = ?1 AND spawned_by_conversation_id IS NULL AND thread_role = 'session'",
        params![child_id, parent_id, non_empty(parent_message_id)],
    )
    .context("recording session lineage")?;
    Ok(())
}

impl ConversationStore {
    /// The hierarchy metadata of one conversation, or `None` if it does not exist.
    pub async fn thread_hierarchy(&self, conversation_id: &str) -> Result<Option<ThreadHierarchy>> {
        let conn = self.conn.lock().await;
        let sql = format!("SELECT {HIERARCHY_SELECT} FROM conversations c WHERE c.id = ?1");
        Ok(conn
            .query_row(&sql, params![conversation_id], |row| {
                hierarchy_from_row(row, 0)
            })
            .optional()?)
    }

    /// Place a conversation in a project (or take it out with `None`). Returns
    /// `false` when the conversation does not exist.
    pub async fn set_thread_project(
        &self,
        conversation_id: &str,
        project_id: Option<&str>,
    ) -> Result<bool> {
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        let conn = self.conn.lock().await;
        set_thread_project_locked(&conn, conversation_id, project_id)
    }

    /// Atomically file a thread and optionally record its write-once lineage.
    /// Callers authorize the child and parent before entering this transaction.
    pub async fn place_thread_in_project(
        &self,
        conversation_id: &str,
        project_id: Option<&str>,
        parent_id: Option<&str>,
    ) -> Result<bool> {
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        let parent_id = non_empty(parent_id);
        let mut conn = self.conn.lock().await;
        let transaction = conn
            .transaction()
            .context("placing conversation in project")?;
        let changed = set_thread_project_locked(&transaction, conversation_id, project_id)
            .context("placing conversation in project")?;
        if changed {
            if let Some(parent_id) = parent_id {
                mark_spawned_by_locked(&transaction, conversation_id, parent_id, None)
                    .context("placing conversation in project")?;
            }
        }
        transaction
            .commit()
            .context("placing conversation in project")?;
        Ok(changed)
    }

    /// Set (or clear) the coordination strategy of a group's main thread.
    /// Returns `false` when the conversation does not exist or is not a group
    /// main thread.
    pub async fn set_group_coordination(
        &self,
        conversation_id: &str,
        coordination: Option<&str>,
    ) -> Result<bool> {
        validate_coordination(coordination)?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations SET coordination = ?1, updated_at = ?2
                  WHERE id = ?3 AND thread_role = 'main' AND owner_kind = 'group'",
                params![non_empty(coordination), now_millis(), conversation_id],
            )
            .context("setting group coordination")?;
        Ok(changed == 1)
    }

    /// Promote a conversation to an ad-hoc group main thread (owned by itself).
    /// Used when a second agent or human participant joins a plain chat. A thread
    /// that is already a main thread keeps its existing owner.
    pub async fn promote_to_group_main(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE conversations
                    SET thread_role = 'main', owner_kind = 'group', owner_id = id
                  WHERE id = ?1 AND thread_role <> 'main'",
                params![conversation_id],
            )
            .context("promoting conversation to a group main thread")?;
        Ok(changed == 1)
    }

    /// Record which thread (and turn) spawned a session. Write-once: a session
    /// keeps the lineage of the thread that first created it, so a later
    /// coordinator messaging the same worker cannot re-parent it. The child also
    /// inherits the parent's project when it has none.
    pub async fn mark_spawned_by(
        &self,
        child_id: &str,
        parent_id: &str,
        parent_message_id: Option<&str>,
    ) -> Result<()> {
        if child_id == parent_id {
            return Ok(());
        }
        let conn = self.conn.lock().await;
        mark_spawned_by_locked(&conn, child_id, parent_id, parent_message_id)
    }

    /// The main thread of `(project, owner)`, if one exists.
    pub async fn find_main_thread(
        &self,
        project_id: Option<&str>,
        owner_kind: OwnerKind,
        owner_id: &str,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        Ok(find_main_thread_locked(
            &conn,
            non_empty(project_id),
            owner_kind,
            owner_id,
        )?)
    }

    /// Return the main thread of `(project, owner)`, creating it on first use.
    ///
    /// Concurrent callers converge on one row: the partial unique index rejects a
    /// second main thread for the same scope and the loser re-reads the winner.
    pub async fn ensure_main_thread(
        &self,
        project_id: Option<&str>,
        owner_kind: OwnerKind,
        owner_id: &str,
        agent_id: Option<&str>,
        title: Option<&str>,
        tenancy: Tenancy,
    ) -> Result<String> {
        validate_opaque_id(owner_id)?;
        let project_id = non_empty(project_id);
        if let Some(project_id) = project_id {
            validate_opaque_id(project_id)?;
        }
        if let Some(existing) = self
            .find_main_thread(project_id, owner_kind, owner_id)
            .await?
        {
            return Ok(existing);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.ensure_conversation(&id, non_empty(agent_id), title, tenancy)
            .await?;
        let conn = self.conn.lock().await;
        let promoted = conn.execute(
            "UPDATE conversations
                SET project_id = ?2, thread_role = 'main', owner_kind = ?3, owner_id = ?4
              WHERE id = ?1",
            params![id, project_id, owner_kind.as_str(), owner_id.trim()],
        );
        match promoted {
            Ok(_) => Ok(id),
            Err(error) => {
                // Lost the race: drop our empty row and hand back the winner.
                conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
                    .ok();
                find_main_thread_locked(&conn, project_id, owner_kind, owner_id)?
                    .ok_or_else(|| anyhow::anyhow!("creating main thread: {error}"))
            }
        }
    }

    /// Summaries of the sessions a thread spawned, newest activity first.
    pub async fn list_spawned_sessions(&self, parent_id: &str) -> Result<Vec<ConversationSummary>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM conversations WHERE spawned_by_conversation_id = ?1
                  ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let ids = stmt
                .query_map(params![parent_id, MAX_HIERARCHY_LISTING as i64], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        self.summaries_for_ids(&ids).await
    }

    /// Summaries of every thread in a project, newest activity first.
    pub async fn list_project_threads(&self, project_id: &str) -> Result<Vec<ConversationSummary>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM conversations WHERE project_id = ?1
                  ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let ids = stmt
                .query_map(
                    params![project_id.trim(), MAX_HIERARCHY_LISTING as i64],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        self.summaries_for_ids(&ids).await
    }

    async fn summaries_for_ids(&self, ids: &[String]) -> Result<Vec<ConversationSummary>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(summary) = self.get_summary(id).await? {
                out.push(summary);
            }
        }
        Ok(out)
    }

    /// One stored scope default, if set.
    pub async fn scope_default(&self, scope: &str) -> Result<Option<ScopeDefault>> {
        let conn = self.conn.lock().await;
        Ok(conn
            .query_row(
                &format!("SELECT {SCOPE_DEFAULT_COLUMNS} FROM scope_defaults WHERE scope = ?1"),
                params![scope],
                |row| scope_default_from_row(row, 0),
            )
            .optional()?)
    }

    /// Every stored scope default, keyed by scope.
    pub async fn list_scope_defaults(&self) -> Result<Vec<(String, ScopeDefault)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT scope, {SCOPE_DEFAULT_COLUMNS} FROM scope_defaults ORDER BY scope"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, scope_default_from_row(row, 1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Write a scope default. An all-empty value clears the scope (reset to
    /// inherited).
    pub async fn set_scope_default(&self, scope: &str, value: ScopeDefault) -> Result<()> {
        if !is_valid_scope(scope) {
            anyhow::bail!("invalid scope '{scope}'");
        }
        let value = value.trimmed();
        let conn = self.conn.lock().await;
        if value.is_empty() {
            conn.execute(
                "DELETE FROM scope_defaults WHERE scope = ?1",
                params![scope],
            )?;
            return Ok(());
        }
        conn.execute(
            "INSERT INTO scope_defaults (scope, provider, model, effort, coordinator_provider,
                 coordinator_model, coordinator_effort, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(scope) DO UPDATE SET
                 provider = excluded.provider, model = excluded.model,
                 effort = excluded.effort,
                 coordinator_provider = excluded.coordinator_provider,
                 coordinator_model = excluded.coordinator_model,
                 coordinator_effort = excluded.coordinator_effort,
                 updated_at = excluded.updated_at",
            params![
                scope,
                value.provider,
                value.model,
                value.effort,
                value.coordinator_provider,
                value.coordinator_model,
                value.coordinator_effort,
                now_millis()
            ],
        )
        .context("writing scope default")?;
        Ok(())
    }

    /// The stored levels of the cascade for `(project, agent)`, reduced for a
    /// thread of `role`. Session, binding and lane levels belong to the caller
    /// (they live elsewhere).
    pub async fn stored_cascade_levels(
        &self,
        project_id: Option<&str>,
        agent_id: Option<&str>,
        role: DefaultsRole,
    ) -> Result<CascadeLevels> {
        let project_id = non_empty(project_id).filter(|p| valid_opaque_id(p));
        let agent_id = non_empty(agent_id).filter(|a| valid_opaque_id(a));
        let mut levels = CascadeLevels::default();
        if let (Some(project), Some(agent)) = (project_id, agent_id) {
            levels.project_agent = self
                .scope_default(&project_agent_scope(project, agent))
                .await?;
        }
        if let Some(agent) = agent_id {
            levels.agent = self.scope_default(&agent_scope(agent)).await?;
        }
        if let Some(project) = project_id {
            levels.project = self.scope_default(&project_scope(project)).await?;
        }
        levels.settings = self.scope_default(GLOBAL_SCOPE).await?;
        Ok(levels.for_role(role))
    }
}

fn find_main_thread_locked(
    conn: &Connection,
    project_id: Option<&str>,
    owner_kind: OwnerKind,
    owner_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM conversations
          WHERE thread_role = 'main' AND IFNULL(project_id, '') = IFNULL(?1, '')
            AND owner_kind = ?2 AND owner_id = ?3",
        params![project_id, owner_kind.as_str(), owner_id.trim()],
        |row| row.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(provider: &str, model: &str, effort: &str) -> Option<ScopeDefault> {
        Some(ScopeDefault {
            provider: provider.to_owned(),
            model: model.to_owned(),
            effort: effort.to_owned(),
            ..ScopeDefault::default()
        })
    }

    fn coordinator(model: &str, effort: &str) -> ScopeDefault {
        ScopeDefault {
            coordinator_provider: "anthropic".into(),
            coordinator_model: model.to_owned(),
            coordinator_effort: effort.to_owned(),
            ..ScopeDefault::default()
        }
    }

    #[test]
    fn sessions_ignore_coordinator_values() {
        let levels = CascadeLevels {
            project: Some(ScopeDefault {
                model: "thread-model".into(),
                ..coordinator("coord-model", "high")
            }),
            ..CascadeLevels::default()
        }
        .for_role(DefaultsRole::Thread);
        let resolved = resolve_cascade(&levels);
        assert_eq!(resolved.model, "thread-model");
        assert_eq!(resolved.effort, "");
    }

    #[test]
    fn a_coordinator_value_anywhere_beats_thread_values_for_main_threads() {
        // The project sets only a thread model; Settings › Models sets a
        // coordinator model. Main threads coordinate on the Settings model, and
        // their effort still falls back to the project's thread effort.
        let levels = CascadeLevels {
            project: level("openai", "thread-model", "low"),
            settings: Some(coordinator("coord-model", "")),
            ..CascadeLevels::default()
        }
        .for_role(DefaultsRole::Coordinator);
        let resolved = resolve_cascade(&levels);
        assert_eq!(resolved.provider, "anthropic");
        assert_eq!(resolved.model, "coord-model");
        assert_eq!(resolved.model_source, Some(DefaultSource::Settings));
        assert_eq!(resolved.effort, "low");
        assert_eq!(resolved.effort_source, Some(DefaultSource::Project));
    }

    #[test]
    fn coordinator_values_keep_the_level_order_and_the_agent_binding() {
        let levels = CascadeLevels {
            agent: Some(coordinator("bot-coord", "")),
            project: Some(coordinator("project-coord", "")),
            settings: Some(coordinator("settings-coord", "")),
            ..CascadeLevels::default()
        }
        .for_role(DefaultsRole::Coordinator);
        assert_eq!(resolve_cascade(&levels).model, "bot-coord");
        let bound = CascadeLevels {
            agent_binding_model: Some("bound".into()),
            settings: Some(coordinator("settings-coord", "")),
            ..CascadeLevels::default()
        }
        .for_role(DefaultsRole::Coordinator);
        assert_eq!(resolve_cascade(&bound).model, "bound");
    }

    #[test]
    fn main_threads_use_thread_values_when_no_coordinator_is_set() {
        let levels = CascadeLevels {
            project: level("openai", "thread-model", "medium"),
            ..CascadeLevels::default()
        }
        .for_role(DefaultsRole::Coordinator);
        let resolved = resolve_cascade(&levels);
        assert_eq!(resolved.model, "thread-model");
        assert_eq!(resolved.effort, "medium");
    }

    #[test]
    fn scope_default_writes_keep_omitted_coordinator_values() {
        let stored = ScopeDefault {
            model: "old-thread".into(),
            ..coordinator("coord-model", "high")
        };
        // An older client sends only the thread pair.
        let legacy: ScopeDefaultInput =
            serde_json::from_str(r#"{"provider":"openai","model":"new-thread"}"#).unwrap();
        let merged = legacy.merged_over(stored.clone());
        assert_eq!(merged.model, "new-thread");
        assert_eq!(merged.coordinator_model, "coord-model");
        assert_eq!(merged.coordinator_effort, "high");
        // An explicit empty value clears; both spellings are accepted.
        let reset: ScopeDefaultInput =
            serde_json::from_str(r#"{"coordinatorModel":"","coordinator_effort":"low"}"#).unwrap();
        let merged = reset.merged_over(stored);
        assert_eq!(merged.coordinator_model, "");
        assert_eq!(merged.coordinator_provider, "anthropic");
        assert_eq!(merged.coordinator_effort, "low");
    }

    #[test]
    fn coordinator_fields_serialize_in_camel_case() {
        let value = serde_json::to_value(coordinator("coord-model", "high")).unwrap();
        assert_eq!(value["coordinatorModel"], "coord-model");
        assert_eq!(value["coordinatorProvider"], "anthropic");
        assert_eq!(value["coordinatorEffort"], "high");
        assert!(value.get("coordinator_model").is_none());
    }

    #[test]
    fn settings_sit_between_project_and_lane() {
        let resolved = resolve_cascade(&CascadeLevels {
            settings: level("anthropic", "settings-model", ""),
            global: level("openai", "lane-model", "low"),
            ..CascadeLevels::default()
        });
        assert_eq!(resolved.model, "settings-model");
        assert_eq!(resolved.model_source, Some(DefaultSource::Settings));
        assert_eq!(resolved.effort_source, Some(DefaultSource::Global));
    }

    #[test]
    fn cascade_picks_the_most_specific_model_as_a_pair() {
        let resolved = resolve_cascade(&CascadeLevels {
            session: None,
            project_agent: level("", "", "high"),
            agent: None,
            agent_binding_model: None,
            project: level("anthropic", "claude-x", "low"),
            settings: None,
            global: level("openai", "gpt-x", "medium"),
        });
        assert_eq!(resolved.provider, "anthropic");
        assert_eq!(resolved.model, "claude-x");
        assert_eq!(resolved.model_source, Some(DefaultSource::Project));
        // Effort falls through independently: the bot-in-project level set only it.
        assert_eq!(resolved.effort, "high");
        assert_eq!(resolved.effort_source, Some(DefaultSource::ProjectAgent));
    }

    #[test]
    fn a_provider_without_a_model_never_pairs_with_another_levels_model() {
        let resolved = resolve_cascade(&CascadeLevels {
            project_agent: level("anthropic", "", ""),
            global: level("openai", "gpt-x", ""),
            ..CascadeLevels::default()
        });
        assert_eq!(resolved.provider, "openai");
        assert_eq!(resolved.model, "gpt-x");
        assert_eq!(resolved.model_source, Some(DefaultSource::Global));
    }

    #[test]
    fn session_override_beats_everything_and_binding_beats_project() {
        let all = CascadeLevels {
            session: level("p", "session-model", ""),
            project_agent: level("p", "pa-model", ""),
            agent: level("p", "agent-model", ""),
            agent_binding_model: Some("bound-model".into()),
            project: level("p", "project-model", ""),
            settings: level("p", "settings-model", ""),
            global: level("p", "global-model", ""),
        };
        assert_eq!(resolve_cascade(&all).model, "session-model");
        let no_overrides = CascadeLevels {
            session: None,
            project_agent: None,
            agent: None,
            ..all
        };
        let resolved = resolve_cascade(&no_overrides);
        assert_eq!(resolved.model, "bound-model");
        assert_eq!(resolved.model_source, Some(DefaultSource::AgentBinding));
    }

    #[test]
    fn nothing_set_resolves_empty() {
        let resolved = resolve_cascade(&CascadeLevels::default());
        assert!(resolved.model.is_empty());
        assert_eq!(resolved.model_source, None);
        assert_eq!(resolved.effort_source, None);
    }

    #[test]
    fn scope_shapes_validate() {
        assert!(is_valid_scope("project:atlas"));
        assert!(is_valid_scope("agent:ryu"));
        assert!(is_valid_scope("project:atlas/agent:ryu"));
        assert!(is_valid_scope("global"));
        assert!(!is_valid_scope("project:"));
        assert!(!is_valid_scope("project:a/b"));
        assert!(!is_valid_scope("team:x"));
        assert!(!is_valid_scope("project:atlas/agent:"));
    }

    #[tokio::test]
    async fn one_main_thread_per_project_owner_scope() {
        let store = ConversationStore::open_in_memory().unwrap();
        let global = store
            .ensure_main_thread(
                None,
                OwnerKind::Agent,
                "scout",
                Some("scout"),
                Some("Scout"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let again = store
            .ensure_main_thread(
                None,
                OwnerKind::Agent,
                "scout",
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        assert_eq!(global, again);
        let in_project = store
            .ensure_main_thread(
                Some("atlas"),
                OwnerKind::Agent,
                "scout",
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        assert_ne!(
            global, in_project,
            "a bot's project thread is separate from its global thread"
        );
        let group = store
            .ensure_main_thread(
                Some("atlas"),
                OwnerKind::Group,
                "reviewers",
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let hierarchy = store.thread_hierarchy(&group).await.unwrap().unwrap();
        assert!(hierarchy.is_main());
        assert_eq!(hierarchy.project_id.as_deref(), Some("atlas"));
        assert_eq!(hierarchy.owner_kind.as_deref(), Some("group"));
        assert_eq!(
            store
                .find_main_thread(Some("atlas"), OwnerKind::Group, "reviewers")
                .await
                .unwrap(),
            Some(group)
        );
        assert!(store
            .find_main_thread(None, OwnerKind::Group, "reviewers")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn lineage_is_write_once_and_inherits_the_project() {
        let store = ConversationStore::open_in_memory().unwrap();
        let main = store
            .ensure_main_thread(
                Some("atlas"),
                OwnerKind::Project,
                "atlas",
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        store
            .ensure_conversation("worker", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .mark_spawned_by("worker", &main, Some("m1"))
            .await
            .unwrap();
        store
            .ensure_conversation("other", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .mark_spawned_by("worker", "other", None)
            .await
            .unwrap();
        let worker = store.thread_hierarchy("worker").await.unwrap().unwrap();
        assert_eq!(
            worker.spawned_by_conversation_id.as_deref(),
            Some(main.as_str())
        );
        assert_eq!(worker.spawned_by_message_id.as_deref(), Some("m1"));
        assert_eq!(worker.project_id.as_deref(), Some("atlas"));
        let sessions = store.list_spawned_sessions(&main).await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "worker");
        assert_eq!(sessions[0].hierarchy.thread_role, THREAD_ROLE_SESSION);
        let project = store.list_project_threads("atlas").await.unwrap();
        assert_eq!(project.len(), 2);
        // A main thread is never re-parented as somebody's session.
        store.mark_spawned_by(&main, "other", None).await.unwrap();
        let main_row = store.thread_hierarchy(&main).await.unwrap().unwrap();
        assert!(main_row.spawned_by_conversation_id.is_none());
    }

    #[tokio::test]
    async fn scope_defaults_round_trip_and_clear() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .set_scope_default(
                &project_scope("atlas"),
                ScopeDefault {
                    provider: "anthropic".into(),
                    model: "claude-x".into(),
                    ..ScopeDefault::default()
                },
            )
            .await
            .unwrap();
        store
            .set_scope_default(
                &project_agent_scope("atlas", "scout"),
                ScopeDefault {
                    effort: "high".into(),
                    coordinator_model: "coord-x".into(),
                    ..ScopeDefault::default()
                },
            )
            .await
            .unwrap();
        let levels = store
            .stored_cascade_levels(Some("atlas"), Some("scout"), DefaultsRole::Thread)
            .await
            .unwrap();
        assert_eq!(levels.project.as_ref().unwrap().model, "claude-x");
        assert_eq!(levels.project_agent.as_ref().unwrap().effort, "high");
        assert!(levels.agent.is_none());
        assert!(levels.settings.is_none());
        // The coordinator column round-trips and only main threads read it.
        let main = store
            .stored_cascade_levels(Some("atlas"), Some("scout"), DefaultsRole::Coordinator)
            .await
            .unwrap();
        assert_eq!(main.project_agent.as_ref().unwrap().model, "coord-x");
        assert!(main.project.is_none());
        store
            .set_scope_default(
                GLOBAL_SCOPE,
                ScopeDefault {
                    model: "everywhere".into(),
                    ..ScopeDefault::default()
                },
            )
            .await
            .unwrap();
        let with_settings = store
            .stored_cascade_levels(None, None, DefaultsRole::Thread)
            .await
            .unwrap();
        assert_eq!(with_settings.settings.unwrap().model, "everywhere");
        store
            .set_scope_default(GLOBAL_SCOPE, ScopeDefault::default())
            .await
            .unwrap();
        store
            .set_scope_default(&project_scope("atlas"), ScopeDefault::default())
            .await
            .unwrap();
        assert!(store
            .scope_default(&project_scope("atlas"))
            .await
            .unwrap()
            .is_none());
        assert_eq!(store.list_scope_defaults().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn group_promotion_and_coordination() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .ensure_conversation("council", None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        assert!(!store
            .set_group_coordination("council", Some("router"))
            .await
            .unwrap());
        store
            .add_participant("council", "a", Tenancy::Unattributed)
            .await
            .unwrap();
        store
            .add_participant("council", "b", Tenancy::Unattributed)
            .await
            .unwrap();
        assert!(store.promote_to_group_main("council").await.unwrap());
        assert!(!store.promote_to_group_main("council").await.unwrap());
        assert!(store
            .set_group_coordination("council", Some("router"))
            .await
            .unwrap());
        assert!(store
            .set_group_coordination("council", Some("vote"))
            .await
            .is_err());
        let summary = store.get_summary("council").await.unwrap().unwrap();
        assert_eq!(summary.hierarchy.owner_kind.as_deref(), Some("group"));
        assert_eq!(summary.hierarchy.owner_id.as_deref(), Some("council"));
        assert_eq!(summary.hierarchy.coordination.as_deref(), Some("router"));
        let wire = serde_json::to_value(&summary).unwrap();
        assert_eq!(wire["thread_role"], "main");
    }

    #[test]
    fn existing_multi_agent_chats_backfill_as_group_main_threads() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, participants TEXT NOT NULL DEFAULT '[]');
             CREATE TABLE conversation_collaborators (conversation_id TEXT, user_id TEXT, role TEXT);
             INSERT INTO conversations VALUES ('dm', '[\"ryu\"]'), ('council', '[\"a\",\"b\"]'), ('shared', '[]');
             INSERT INTO conversation_collaborators VALUES ('shared', 'bob', 'participant');",
        )
        .unwrap();
        let columns = ["id", "participants"]
            .into_iter()
            .map(String::from)
            .collect();
        migrate(&conn, &columns).unwrap();
        let role = |id: &str| -> String {
            conn.query_row(
                "SELECT thread_role FROM conversations WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(role("dm"), "session");
        assert_eq!(role("council"), "main");
        assert_eq!(role("shared"), "main");
    }

    #[test]
    fn coordination_values_validate() {
        assert!(validate_coordination(None).is_ok());
        assert!(validate_coordination(Some("debate-synthesis")).is_ok());
        assert!(validate_coordination(Some("council")).is_err());
    }
}

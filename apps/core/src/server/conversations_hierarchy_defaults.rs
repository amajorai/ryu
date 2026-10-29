//! Per-scope model defaults, the cascade that resolves them, and the opaque
//! scope ids the hierarchy accepts. Split from [`super`] so each file stays
//! focused; every public item is re-exported from the hierarchy module.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::{COORDINATION_VALUES, MAX_SCOPE_ID_CHARS, THREAD_ROLE_MAIN};

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
pub(super) const SCOPE_DEFAULT_COLUMNS: &str = "provider, model, effort, coordinator_provider, \
     coordinator_model, coordinator_effort";

pub(super) fn scope_default_from_row(
    row: &rusqlite::Row<'_>,
    start: usize,
) -> rusqlite::Result<ScopeDefault> {
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
    pub(super) fn trimmed(self) -> Self {
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

pub(super) fn valid_opaque_id(value: &str) -> bool {
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

pub(super) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

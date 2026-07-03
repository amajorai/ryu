//! The **activity feed** — one unified, cross-module timeline of everything the
//! node did (monitor alerts, quest completions, approvals, meetings, runs, and
//! manual notes).
//!
//! Feature-module triple, cloned from the monitors shape:
//!   - this file — the [`ActivityItem`] record + [`ActivityLevel`] + re-exports.
//!   - [`store`]  — SQLite persistence (`~/.ryu/activity.db`) + a broadcast fan-out.
//!   - [`ingest`] — maps each producing engine's events into [`ActivityItem`]s and
//!     spawns the subscribe-loops that aggregate them.
//!
//! Placement note (Core vs Gateway): this records *what the node did* — a history
//! of what ran, not a policy decision about what is allowed — so it is Core.

pub mod ingest;
pub mod store;

pub use store::ActivityStore;

use serde::{Deserialize, Serialize};

/// Severity of an activity item (drives the feed's icon/colour).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ActivityLevel {
    /// Neutral, informational (the default).
    #[default]
    Info,
    /// A positive outcome (a task completed, notes generated, an approval granted).
    Success,
    /// Something that likely needs attention (a site went down, an approval rejected).
    Warning,
}

/// The default `manual` source used when the POST endpoint omits one.
pub fn default_source() -> String {
    "manual".to_string()
}

/// The default (empty object) for [`ActivityItem::metadata`].
pub fn default_metadata() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// One entry in the unified activity feed.
///
/// Serde field names are the **v1 contract** and are snake_case to match Core's
/// conventions. `body` / `agent_id` / `session_id` serialize as `null` when unset
/// (the contract types them `string | null`), never skipped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    /// UUID v4.
    pub id: String,
    /// The class of event, e.g. `monitor_alert` | `quest` | `approval` | `meeting`
    /// | `run` | `note`.
    pub kind: String,
    /// The producing module, e.g. `monitors` | `quests` | `approvals` | `meetings`
    /// | `runs` | `manual`.
    pub source: String,
    pub title: String,
    pub body: Option<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub level: ActivityLevel,
    /// Arbitrary JSON object; defaults to `{}`.
    #[serde(default = "default_metadata")]
    pub metadata: serde_json::Value,
    /// Unix epoch **seconds**.
    pub created_at: i64,
}

impl ActivityItem {
    /// Build a fresh item with a generated UUID and the current time, at the
    /// default (`Info`) level with empty metadata. Fill remaining fields via the
    /// `with_*` builders.
    pub fn new(
        kind: impl Into<String>,
        source: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            source: source.into(),
            title: title.into(),
            body: None,
            agent_id: None,
            session_id: None,
            level: ActivityLevel::Info,
            metadata: default_metadata(),
            created_at: chrono::Utc::now().timestamp(),
        }
    }

    pub fn with_body(mut self, body: Option<String>) -> Self {
        self.body = body;
        self
    }

    pub fn with_agent(mut self, agent_id: Option<String>) -> Self {
        self.agent_id = agent_id;
        self
    }

    pub fn with_session(mut self, session_id: Option<String>) -> Self {
        self.session_id = session_id;
        self
    }

    pub fn with_level(mut self, level: ActivityLevel) -> Self {
        self.level = level;
        self
    }

    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = metadata;
        self
    }

    /// Override `created_at` (epoch seconds) — used by ingest mappers to preserve
    /// the source event's own timestamp.
    pub fn with_created_at(mut self, created_at: i64) -> Self {
        self.created_at = created_at;
        self
    }
}

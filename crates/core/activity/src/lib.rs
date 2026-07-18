//! The **activity feed** — one unified, cross-module timeline of everything the
//! node did (monitor alerts, quest completions, approvals, meetings, runs, and
//! manual notes).
//!
//! The extracted `ryu-activity` primitive holds two halves:
//!   - this file — the [`ActivityItem`] record + [`ActivityLevel`] + re-exports.
//!   - [`store`]  — SQLite persistence + a broadcast fan-out. [`ActivityStore::open`]
//!     takes an explicit db path, so this crate has ZERO dependency on `apps/core`;
//!     the default-path choice (`~/.ryu/activity.db`) stays Core-side wiring.
//!
//! The per-engine event *mappers* (`from_monitor_alert`/`from_quest_event`/…) and
//! their subscribe-loops live in `apps/core` (`activity::ingest`), not here: they
//! consume Core types (monitors/approvals/meetings/quests) and would force a
//! dependency back onto `apps/core`.
//!
//! Placement note (Core vs Gateway): this records *what the node did* — a history
//! of what ran, not a policy decision about what is allowed — so it is Core.

mod store;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_defaults_and_builders() {
        let item = ActivityItem::new("quest", "quests", "done")
            .with_body(Some("detail".into()))
            .with_agent(Some("agent-1".into()))
            .with_session(Some("sess-1".into()))
            .with_level(ActivityLevel::Success)
            .with_created_at(42);
        assert_eq!(item.kind, "quest");
        assert_eq!(item.source, "quests");
        assert_eq!(item.title, "done");
        assert_eq!(item.body.as_deref(), Some("detail"));
        assert_eq!(item.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(item.session_id.as_deref(), Some("sess-1"));
        assert_eq!(item.level, ActivityLevel::Success);
        assert_eq!(item.created_at, 42);
        assert!(!item.id.is_empty());
        // Defaults: unset optionals are None, metadata is an empty object, level Info.
        let bare = ActivityItem::new("note", "manual", "hi");
        assert_eq!(bare.level, ActivityLevel::Info);
        assert_eq!(bare.metadata, default_metadata());
        assert_eq!(default_source(), "manual");
    }

    #[test]
    fn serde_roundtrip_preserves_v1_contract() {
        let item = ActivityItem::new("meeting", "meetings", "started")
            .with_level(ActivityLevel::Warning)
            .with_metadata(serde_json::json!({ "meeting_id": "m1" }));
        let json = serde_json::to_value(&item).unwrap();
        // null (not skipped) for unset optionals; snake_case level.
        assert!(json.get("body").unwrap().is_null());
        assert_eq!(json.get("level").unwrap(), "warning");
        let back: ActivityItem = serde_json::from_value(json).unwrap();
        assert_eq!(back.id, item.id);
        assert_eq!(back.level, ActivityLevel::Warning);
        assert_eq!(back.metadata, item.metadata);
    }
}

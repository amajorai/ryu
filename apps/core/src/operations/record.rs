//! The operation record: one durable row per long-running operation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

/// How many times a resumable operation may start before a restart stops
/// resuming it. The counter is written before the runner starts, so an
/// operation that crashes the node cannot loop forever.
pub const MAX_ATTEMPTS: u32 = 3;

/// Where an operation is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    /// Accepted; waiting for its turn (one operation of a kind runs at a time).
    Queued,
    /// The runner is working.
    Running,
    /// The runner finished.
    Succeeded,
    /// The runner reported an error, or stopped unexpectedly.
    Failed,
    /// Stopped on request. Work done before the stop is kept.
    Cancelled,
    /// The node restarted while it ran and it was not resumed. Retry starts it
    /// again.
    Interrupted,
}

impl OperationStatus {
    /// Whether the operation still has work to do.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }

    /// Whether Retry may start the operation again.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Failed | Self::Cancelled | Self::Interrupted)
    }
}

/// How far an operation is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    /// Steps finished.
    #[serde(default)]
    pub done: u64,
    /// Steps in total; zero when the runner does not know.
    #[serde(default)]
    pub total: u64,
    /// What the runner is working on now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl OperationProgress {
    /// `done` of `total` with no label.
    pub fn steps(done: u64, total: u64) -> Self {
        Self {
            done,
            total,
            label: None,
        }
    }

    /// The same progress with `label` as the current step.
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

/// One long-running operation, as stored and as served.
///
/// `input` is what the runner needs to run again and `cursor` is its
/// checkpoint. Neither may hold a secret: the record is kept on the node for
/// the retention window and is served to the operation's owner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: String,
    /// The runner that owns the operation, for example `import.setup`.
    pub kind: String,
    /// A short label from the feature, for example the folder being imported.
    pub title: String,
    /// The user who started it; absent for an anonymous local caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    pub status: OperationStatus,
    #[serde(default)]
    pub progress: OperationProgress,
    /// What the runner needs to run again. Left out of lists and the stream.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub input: Value,
    /// The runner's checkpoint. Left out of lists and the stream.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub cursor: Value,
    /// What the runner returned. Left out of lists and the stream.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub result: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Never served; a repeated start with the same key returns this record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// How many times the runner was started for the current run.
    #[serde(default)]
    pub attempt: u32,
    /// Whether the runner may continue from `cursor` after a restart.
    #[serde(default)]
    pub resumable: bool,
    /// Whether the current run continued after a node restart.
    #[serde(default)]
    pub resumed: bool,
    /// Whether a stop was requested and the runner has not stopped yet.
    #[serde(default)]
    pub cancel_requested: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

impl OperationRecord {
    /// The record as lists and the stream carry it: without the idempotency
    /// key and without the fields that grow with the work (`input`, `cursor`,
    /// `result`). `GET /api/operations/{id}` serves those.
    pub fn summary(&self) -> Self {
        Self {
            input: Value::Null,
            cursor: Value::Null,
            result: Value::Null,
            idempotency_key: None,
            ..self.clone()
        }
    }

    /// The full record as served by id: everything except the idempotency key.
    pub fn detail(&self) -> Self {
        Self {
            idempotency_key: None,
            ..self.clone()
        }
    }

    /// The time the record last mattered: when it finished, else when it last
    /// changed.
    pub fn settled_at(&self) -> &str {
        self.completed_at.as_deref().unwrap_or(&self.updated_at)
    }
}

/// What a feature passes to start an operation.
#[derive(Debug, Clone)]
pub struct NewOperation {
    pub kind: String,
    pub title: String,
    pub owner_user_id: Option<String>,
    pub input: Value,
    pub idempotency_key: Option<String>,
}

/// The current time as the records store it (RFC 3339, UTC, milliseconds).
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A new operation id: `op_` plus 32 hex digits, safe as a checkpoint id.
pub fn new_id() -> String {
    format!("op_{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::sample;
    use super::*;
    use serde_json::json;

    #[test]
    fn the_wire_form_is_camel_case_with_snake_case_statuses() {
        let wire = serde_json::to_value(sample("op_1", OperationStatus::Running)).unwrap();
        assert_eq!(wire["status"], "running");
        assert_eq!(wire["ownerUserId"], "user-1");
        assert_eq!(
            wire["progress"],
            json!({ "done": 1, "total": 3, "label": "second" })
        );
        assert_eq!(wire["cancelRequested"], false);
        assert_eq!(wire["createdAt"], "2026-11-18T10:00:00.000Z");
        assert!(wire.get("result").is_none(), "an empty result is left out");
        assert!(wire.get("completedAt").is_none());
    }

    #[test]
    fn a_record_round_trips_and_tolerates_missing_optional_fields() {
        let record = sample("op_1", OperationStatus::Interrupted);
        let wire = serde_json::to_string(&record).unwrap();
        assert_eq!(
            serde_json::from_str::<OperationRecord>(&wire).unwrap(),
            record
        );

        let minimal: OperationRecord = serde_json::from_value(json!({
            "id": "op_2",
            "kind": "test.count",
            "title": "Minimal",
            "status": "queued",
            "createdAt": "2026-11-18T10:00:00.000Z",
            "updatedAt": "2026-11-18T10:00:00.000Z"
        }))
        .unwrap();
        assert_eq!(minimal.attempt, 0);
        assert_eq!(minimal.progress, OperationProgress::default());
        assert!(minimal.input.is_null());
        assert!(!minimal.resumable);
    }

    #[test]
    fn a_summary_drops_the_growing_fields_and_the_key_but_keeps_progress() {
        let record = sample("op_1", OperationStatus::Running);
        let summary = record.summary();
        assert!(summary.input.is_null());
        assert!(summary.cursor.is_null());
        assert!(summary.result.is_null());
        assert_eq!(summary.idempotency_key, None);
        assert_eq!(summary.progress, record.progress);
        assert_eq!(summary.status, record.status);

        let detail = record.detail();
        assert_eq!(detail.cursor, record.cursor);
        assert_eq!(detail.idempotency_key, None);
    }

    #[test]
    fn statuses_know_whether_they_are_active_or_retryable() {
        for status in [OperationStatus::Queued, OperationStatus::Running] {
            assert!(status.is_active());
            assert!(!status.is_retryable());
        }
        for status in [
            OperationStatus::Failed,
            OperationStatus::Cancelled,
            OperationStatus::Interrupted,
        ] {
            assert!(!status.is_active());
            assert!(status.is_retryable());
        }
        assert!(!OperationStatus::Succeeded.is_active());
        assert!(!OperationStatus::Succeeded.is_retryable());
    }

    #[test]
    fn new_ids_are_valid_checkpoint_ids() {
        let id = new_id();
        assert!(id.starts_with("op_"));
        assert!(ryu_durable::validate_id(&id).is_ok());
        assert_ne!(id, new_id());
    }
}

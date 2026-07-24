//! Aggregation: subscribe to each producing engine's broadcast channel and map
//! its events into [`ActivityItem`]s recorded onto the shared [`ActivityStore`].
//!
//! The mapping is pure (`from_*` fns, easily unit-testable); [`spawn`] wires the
//! long-lived subscribe-loops. Called once at startup from `main.rs`.

use tokio::sync::broadcast::error::RecvError;

use ryu_activity::{ActivityItem, ActivityLevel, ActivityStore};

use crate::approvals::{ApprovalEvent, ApprovalStatus};

/// Parse an RFC3339 timestamp into epoch seconds, falling back to "now" so a
/// malformed source timestamp never drops an item.
fn epoch_secs(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}

// ---- mappers ------------------------------------------------------------------

// Monitors are now out-of-process (`ryu-monitors` sidecar); their alerts no longer
// arrive on an in-process broadcast. Core records them into the activity store in
// `monitors_client::host_monitor_alert` (the sidecar posts each fired alert back),
// where the JSON→`ActivityItem` mapping (the dep-free successor to the old
// `from_monitor_alert`) now lives.

// Quests are now out-of-process (`ryu-quests` sidecar); their activity events no
// longer arrive on an in-process broadcast. Core folds the sidecar's
// `/api/quests/events` SSE into the activity store in `quests_client`, where the
// JSON→`ActivityItem` mapping (the dep-free successor to the old `from_quest_event`)
// now lives.

// Meetings are now out-of-process (`ryu-meetings` sidecar); their lifecycle events no
// longer arrive on an in-process `MeetingEvent` broadcast. Core folds the sidecar's
// `/api/meetings/stream` SSE into the activity store in `meetings_client`, where the
// JSON→`ActivityItem` mapping (the dep-free successor to the old `from_meeting_event`)
// now lives.

/// An approval-inbox event (a request was raised or decided).
pub fn from_approval_event(event: &ApprovalEvent) -> ActivityItem {
    match event {
        ApprovalEvent::Created { request } => {
            ActivityItem::new("approval", "approvals", request.title.clone())
                .with_body(Some(request.summary.clone()))
                .with_agent(request.agent_id.clone())
                .with_session(request.conversation_id.clone())
                .with_level(ActivityLevel::Info)
                .with_metadata(serde_json::json!({
                    "approval_id": request.id,
                    "status": request.status,
                }))
                .with_created_at(epoch_secs(&request.created_at))
        }
        ApprovalEvent::Decided { request } => {
            let level = match request.status {
                ApprovalStatus::Approved => ActivityLevel::Success,
                ApprovalStatus::Rejected | ApprovalStatus::Expired | ApprovalStatus::Cancelled => {
                    ActivityLevel::Warning
                }
                ApprovalStatus::Pending => ActivityLevel::Info,
            };
            let created = request
                .decided_at
                .as_deref()
                .map(epoch_secs)
                .unwrap_or_else(|| chrono::Utc::now().timestamp());
            ActivityItem::new(
                "approval",
                "approvals",
                format!("Approval {}: {}", request.status.as_str(), request.title),
            )
            .with_body(Some(request.summary.clone()))
            .with_agent(request.agent_id.clone())
            .with_session(request.conversation_id.clone())
            .with_level(level)
            .with_metadata(serde_json::json!({
                "approval_id": request.id,
                "status": request.status,
            }))
            .with_created_at(created)
        }
    }
}

// ---- wiring -------------------------------------------------------------------

/// Spawn the long-lived subscribe-loops that fold in-process producing engines' events
/// into the activity feed. Each loop skips lagged frames and ends on channel close,
/// exactly like the SSE handlers. Out-of-process producers (monitors/quests/meetings)
/// are folded in their respective `*_client` modules over loopback, not here.
pub fn spawn(activity: ActivityStore, approvals: &crate::approvals::ApprovalEngine) {
    // Approvals → activity.
    {
        let mut rx = approvals.store.subscribe();
        let act = activity.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Err(e) = act.record(from_approval_event(&event)).await {
                            tracing::warn!("activity: failed to record approval event: {e:#}");
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
}

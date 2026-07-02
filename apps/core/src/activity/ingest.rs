//! Aggregation: subscribe to each producing engine's broadcast channel and map
//! its events into [`ActivityItem`]s recorded onto the shared [`ActivityStore`].
//!
//! The mapping is pure (`from_*` fns, easily unit-testable); [`spawn`] wires the
//! long-lived subscribe-loops. Called once at startup from `main.rs`.

use tokio::sync::broadcast::error::RecvError;

use super::{ActivityItem, ActivityLevel, ActivityStore};
use crate::approvals::{ApprovalEvent, ApprovalStatus};
use crate::meetings::MeetingEvent;
use crate::monitors::Alert;
use crate::quests::QuestEvent;

/// Parse an RFC3339 timestamp into epoch seconds, falling back to "now" so a
/// malformed source timestamp never drops an item.
fn epoch_secs(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp())
}

// ---- mappers ------------------------------------------------------------------

/// A monitor alert (a watched site changed / went down / matched a keyword).
pub fn from_monitor_alert(alert: &Alert) -> ActivityItem {
    // Uptime-down reads as a warning; everything else is informational.
    let level = if alert.kind == "uptime_down" {
        ActivityLevel::Warning
    } else {
        ActivityLevel::Info
    };
    ActivityItem::new("monitor_alert", "monitors", alert.title.clone())
        .with_body(Some(alert.message.clone()))
        .with_level(level)
        .with_metadata(serde_json::json!({
            "monitor_id": alert.monitor_id,
            "monitor_name": alert.monitor_name,
            "alert_kind": alert.kind,
        }))
        .with_created_at(epoch_secs(&alert.created_at))
}

/// A quest event. Deletions carry no feed value and are dropped (`None`).
pub fn from_quest_event(event: &QuestEvent) -> Option<ActivityItem> {
    let item = match event {
        QuestEvent::Completed { quest, auto } => {
            ActivityItem::new("quest", "quests", format!("Quest completed: {}", quest.title))
                .with_body(quest.detail.clone())
                .with_level(ActivityLevel::Success)
                .with_metadata(serde_json::json!({
                    "quest_id": quest.id,
                    "auto": auto,
                }))
        }
        QuestEvent::Suggested {
            quest,
            confidence,
            reason,
        } => ActivityItem::new(
            "quest",
            "quests",
            format!("Quest may be done: {}", quest.title),
        )
        .with_body(Some(reason.clone()))
        .with_level(ActivityLevel::Info)
        .with_metadata(serde_json::json!({
            "quest_id": quest.id,
            "confidence": confidence,
        })),
        QuestEvent::Updated { quest } => {
            ActivityItem::new("quest", "quests", format!("Quest updated: {}", quest.title))
                .with_body(quest.detail.clone())
                .with_metadata(serde_json::json!({ "quest_id": quest.id }))
        }
        QuestEvent::Deleted { .. } => return None,
    };
    Some(item)
}

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
                ApprovalStatus::Rejected
                | ApprovalStatus::Expired
                | ApprovalStatus::Cancelled => ActivityLevel::Warning,
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

/// A meeting event. Only lifecycle boundaries make the feed; per-segment/status
/// churn is dropped (`None`).
pub fn from_meeting_event(event: &MeetingEvent) -> Option<ActivityItem> {
    let item = match event {
        MeetingEvent::Detected {
            app,
            title,
            detected_at,
        } => ActivityItem::new("meeting", "meetings", format!("Meeting detected: {title}"))
            .with_metadata(serde_json::json!({ "app": app }))
            .with_created_at(epoch_secs(detected_at)),
        MeetingEvent::Started { meeting } => {
            ActivityItem::new("meeting", "meetings", format!("Meeting started: {}", meeting.title))
                .with_metadata(serde_json::json!({ "meeting_id": meeting.id }))
                .with_created_at(epoch_secs(&meeting.started_at))
        }
        MeetingEvent::Finalized { meeting } => ActivityItem::new(
            "meeting",
            "meetings",
            format!("Meeting notes ready: {}", meeting.title),
        )
        .with_level(ActivityLevel::Success)
        .with_metadata(serde_json::json!({
            "meeting_id": meeting.id,
            "space_id": meeting.space_id,
        }))
        .with_created_at(epoch_secs(&meeting.updated_at)),
        MeetingEvent::Segment { .. } | MeetingEvent::Status { .. } => return None,
    };
    Some(item)
}

// ---- wiring -------------------------------------------------------------------

/// Spawn the long-lived subscribe-loops that fold every producing engine's events
/// into the activity feed. Each loop skips lagged frames and ends on channel close,
/// exactly like the SSE handlers.
pub fn spawn(
    activity: ActivityStore,
    monitors: &crate::monitors::MonitorEngine,
    quests: &crate::quests::QuestEngine,
    approvals: &crate::approvals::ApprovalEngine,
    meetings: &crate::meetings::MeetingEngine,
) {
    // Monitors → activity.
    {
        let mut rx = monitors.store.subscribe();
        let act = activity.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(alert) => {
                        if let Err(e) = act.record(from_monitor_alert(&alert)).await {
                            tracing::warn!("activity: failed to record monitor alert: {e:#}");
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }

    // Quests → activity.
    {
        let mut rx = quests.store.subscribe();
        let act = activity.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Some(item) = from_quest_event(&event) {
                            if let Err(e) = act.record(item).await {
                                tracing::warn!("activity: failed to record quest event: {e:#}");
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }

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

    // Meetings → activity (best-effort lifecycle boundaries).
    {
        let mut rx = meetings.store.subscribe();
        let act = activity.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Some(item) = from_meeting_event(&event) {
                            if let Err(e) = act.record(item).await {
                                tracing::warn!("activity: failed to record meeting event: {e:#}");
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
}

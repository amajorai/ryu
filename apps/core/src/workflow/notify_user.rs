//! The [`super::NodeKind::NotifyUser`] node: ping org/workspace members (and
//! teams) across the app inbox, the desktop OS toast, and mobile push — with an
//! optional human-in-the-loop acknowledgement gate.
//!
//! Placement (Core vs Gateway): this decides *what runs* (who to ping, whether to
//! wait for an ack) → Core. *Who is a member* of the org/team is a control-plane
//! fact, resolved over the gateway key ([`crate::sidecar::control_plane`]).
//!
//! Delivery reuses the kernel notification store
//! ([`crate::notify::deliver_user_notification`]) so a single user-scoped
//! notification hits all three channels; the ack bookkeeping lives in the run's
//! own `state` map so it survives a restart like every other checkpoint.

use serde::{Deserialize, Serialize};

use super::store::WorkflowRun;
use super::{AckMode, NotifyTargetSpec};

/// Reserved `run.state` key holding a NotifyUser gate's ack bookkeeping.
fn ack_state_key(node_id: &str) -> String {
    format!("__notify_ack_{node_id}")
}

/// Persisted ack bookkeeping for one NotifyUser HITL gate. Serialized as a JSON
/// string into `run.state` so it is checkpointed with the run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AckState {
    /// `first` | `all` | `quorum`.
    pub mode: String,
    /// Number of acks required to resume the run.
    pub threshold: u32,
    /// Member user ids that were pinged.
    pub required: Vec<String>,
    /// Member user ids that have acked so far.
    pub acked: Vec<String>,
    /// Map of member user id → their inbox notification id (so an ack can mark the
    /// right inbox row read/acked).
    pub notifications: std::collections::HashMap<String, String>,
}

impl AckState {
    /// True once enough members have acked to resume the run.
    pub fn satisfied(&self) -> bool {
        self.acked.len() as u32 >= self.threshold
    }
}

/// Resolve a target spec to the set of member user ids to ping.
async fn resolve_recipients(target: &NotifyTargetSpec) -> Result<Vec<String>, String> {
    match target {
        // Explicit members need no roster lookup.
        NotifyTargetSpec::Members { user_ids } => Ok(user_ids.clone()),
        NotifyTargetSpec::Org | NotifyTargetSpec::Team { .. } => {
            let team_id = match target {
                NotifyTargetSpec::Team { team_id } => Some(team_id.as_str()),
                _ => None,
            };
            let client = reqwest::Client::new();
            let users = crate::sidecar::control_plane::resolve_notify_targets(&client, team_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(users.into_iter().map(|u| u.user_id).collect())
        }
    }
}

/// The ack threshold for a gate, given its mode and the recipient count.
fn threshold_for(mode: &AckMode, recipients: usize) -> u32 {
    let n = recipients as u32;
    match mode {
        AckMode::None => 0,
        AckMode::First => 1,
        AckMode::All => n,
        // Never require more acks than there are recipients (an over-large quorum
        // would hang the run forever).
        AckMode::Quorum { n: q } => (*q).min(n).max(1),
    }
}

/// Execute a NotifyUser node. Returns a JSON delivery receipt (fire-and-forget) or
/// [`super::executor::SUSPEND_SENTINEL`] when the ack gate must wait.
pub async fn run(
    target: &NotifyTargetSpec,
    title: &str,
    body: &str,
    ack_mode: &AckMode,
    node_id: &str,
    run: &mut WorkflowRun,
) -> Result<String, String> {
    let recipients = resolve_recipients(target).await?;
    if recipients.is_empty() {
        return Err("NotifyUser: target resolved to zero members".to_string());
    }
    let ack_required = !matches!(ack_mode, AckMode::None);

    let store =
        crate::notify::global_store().ok_or("NotifyUser: notification store unavailable")?;

    // Deliver to every recipient across all three surfaces. Collect each inbox id
    // so an ack gate can map an acking user back to their row.
    let mut notifications = std::collections::HashMap::new();
    let mut delivered = Vec::new();
    for user_id in &recipients {
        match crate::notify::deliver_user_notification(
            &store,
            user_id,
            title,
            body,
            "info",
            Some(&run.run_id),
            Some(node_id),
            ack_required,
        )
        .await
        {
            Ok(notif_id) => {
                notifications.insert(user_id.clone(), notif_id);
                delivered.push(user_id.clone());
            }
            Err(e) => tracing::warn!("NotifyUser: delivery to {user_id} failed: {e}"),
        }
    }
    if delivered.is_empty() {
        return Err("NotifyUser: delivery failed for all recipients".to_string());
    }

    if !ack_required {
        // Fire-and-forget: the receipt is the node output; the run continues.
        return Ok(serde_json::json!({
            "delivered": delivered.len(),
            "users": delivered,
            "ack": "none",
        })
        .to_string());
    }

    // HITL gate: record the ack policy against the run, then suspend.
    let threshold = threshold_for(ack_mode, delivered.len());
    let state = AckState {
        mode: match ack_mode {
            AckMode::First => "first",
            AckMode::All => "all",
            AckMode::Quorum { .. } => "quorum",
            AckMode::None => "none",
        }
        .to_string(),
        threshold,
        required: delivered,
        acked: Vec::new(),
        notifications,
    };
    let encoded = serde_json::to_string(&state)
        .map_err(|e| format!("NotifyUser: failed to encode ack state: {e}"))?;
    run.state.insert(ack_state_key(node_id), encoded);

    Err(super::executor::SUSPEND_SENTINEL.to_string())
}

/// Record an acknowledgement from `user_id` against a suspended NotifyUser gate.
///
/// Returns `Ok(true)` when the ack satisfies the gate's policy (the caller should
/// then resume the run), `Ok(false)` when more acks are still needed. Idempotent:
/// a repeat ack from the same member does not double-count. The gate node is
/// identified by the run's `awaiting_node`.
///
/// On a non-satisfying ack this persists the updated bookkeeping so progress
/// survives a restart; the caller owns the resume + final checkpoint when
/// satisfied.
pub async fn record_ack(run: &mut WorkflowRun, user_id: &str) -> Result<AckAckResult, String> {
    let node_id = run
        .awaiting_node
        .clone()
        .ok_or("run is not awaiting a NotifyUser ack")?;
    let key = ack_state_key(&node_id);
    let mut state: AckState = run
        .state
        .get(&key)
        .ok_or("run has no NotifyUser ack gate")
        .and_then(|s| serde_json::from_str(s).map_err(|_| "corrupt ack state"))
        .map_err(|e| e.to_string())?;

    // Only members that were pinged may ack.
    if !state.required.iter().any(|u| u == user_id) {
        return Err(format!(
            "user {user_id} was not a target of this notification"
        ));
    }
    let notif_id = state.notifications.get(user_id).cloned();
    if !state.acked.iter().any(|u| u == user_id) {
        state.acked.push(user_id.to_string());
    }
    let satisfied = state.satisfied();

    // Re-encode and persist the bookkeeping (whether or not satisfied — the caller
    // resumes on satisfied, which re-checkpoints anyway).
    let encoded =
        serde_json::to_string(&state).map_err(|e| format!("failed to encode ack state: {e}"))?;
    run.state.insert(key, encoded);

    Ok(AckAckResult {
        satisfied,
        notification_id: notif_id,
    })
}

#[cfg(test)]
mod tests {
    use super::super::store::{RunStatus, WorkflowRun};
    use super::super::AckMode;
    use super::*;
    use std::collections::HashMap;

    fn gate_run(node_id: &str, required: &[&str], mode: &AckMode) -> WorkflowRun {
        let mut run = WorkflowRun::new("run1".into(), "wf1".into(), HashMap::new());
        run.status = RunStatus::AwaitingInput;
        run.awaiting_node = Some(node_id.into());
        let required: Vec<String> = required.iter().map(|s| s.to_string()).collect();
        let notifications = required
            .iter()
            .map(|u| (u.clone(), format!("ntf_{u}")))
            .collect();
        let state = AckState {
            mode: "x".into(),
            threshold: threshold_for(mode, required.len()),
            required,
            acked: Vec::new(),
            notifications,
        };
        run.state.insert(
            ack_state_key(node_id),
            serde_json::to_string(&state).unwrap(),
        );
        run
    }

    #[test]
    fn threshold_matches_mode() {
        assert_eq!(threshold_for(&AckMode::None, 3), 0);
        assert_eq!(threshold_for(&AckMode::First, 3), 1);
        assert_eq!(threshold_for(&AckMode::All, 3), 3);
        assert_eq!(threshold_for(&AckMode::Quorum { n: 2 }, 3), 2);
        // A quorum larger than the recipient count is clamped so the gate can
        // actually be satisfied.
        assert_eq!(threshold_for(&AckMode::Quorum { n: 9 }, 3), 3);
        // A zero/one quorum floors at 1.
        assert_eq!(threshold_for(&AckMode::Quorum { n: 0 }, 3), 1);
    }

    #[tokio::test]
    async fn first_ack_satisfies_immediately() {
        let mut run = gate_run("n1", &["u1", "u2"], &AckMode::First);
        let r = record_ack(&mut run, "u1").await.unwrap();
        assert!(r.satisfied);
        assert_eq!(r.notification_id.as_deref(), Some("ntf_u1"));
    }

    #[tokio::test]
    async fn all_ack_waits_for_everyone() {
        let mut run = gate_run("n1", &["u1", "u2"], &AckMode::All);
        assert!(!record_ack(&mut run, "u1").await.unwrap().satisfied);
        // A repeat ack from the same member does not double-count.
        assert!(!record_ack(&mut run, "u1").await.unwrap().satisfied);
        assert!(record_ack(&mut run, "u2").await.unwrap().satisfied);
    }

    #[tokio::test]
    async fn non_target_cannot_ack() {
        let mut run = gate_run("n1", &["u1"], &AckMode::First);
        assert!(record_ack(&mut run, "intruder").await.is_err());
    }
}

/// Outcome of [`record_ack`].
pub struct AckAckResult {
    /// Whether the gate's ack policy is now met (caller should resume the run).
    pub satisfied: bool,
    /// The acking member's inbox row id, if known (to mark it acked).
    pub notification_id: Option<String>,
}

/// Acknowledge a suspended NotifyUser gate on behalf of `user_id`, persisting the
/// updated bookkeeping and resuming the run when the ack policy is met.
///
/// This is the reusable core behind the inbox Ack action / `POST
/// /api/notifications/:id/ack`. Returns the ack outcome (`satisfied` = the run was
/// resumed). Errors when the run is missing or not awaiting an ack.
pub async fn ack_gate(run_id: &str, user_id: &str) -> Result<AckAckResult, String> {
    use super::store;

    let mut run = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    if run.status != store::RunStatus::AwaitingInput {
        return Err("run is not awaiting a notification ack".to_string());
    }
    let result = record_ack(&mut run, user_id).await?;
    // Persist the ack progress before any resume so it survives a crash mid-resume.
    store::save_run(&run).map_err(|e| format!("failed to persist ack: {e}"))?;

    if result.satisfied {
        let payload = serde_json::json!({ "acked_by": user_id }).to_string();
        super::executor::resume_run(run_id, payload).await?;
    }
    Ok(result)
}

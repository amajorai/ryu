//! The shared gate sequence for every app-initiated chat turn.
//!
//! Two entry points post a turn on the user's behalf for an app:
//!
//! - `chat.startTurn`, the kernel capability a sidecar calls
//!   ([`super::host_chat_start_turn`]);
//! - `chat.send`, the host-bridge verb a Companion frame reaches through the
//!   desktop host (`server::app_chat_send`).
//!
//! Both must pass the SAME gates in the SAME order: the shared-node refusal, the
//! command-risk exec scan, the Gateway firewall ingress check, and the
//! [`ASK_BEFORE_APP_SEND_PREF`](super::ASK_BEFORE_APP_SEND_PREF) approval queue.
//! Keeping them in one function is what stops the two paths drifting apart (the
//! desktop path once skipped all of them by posting straight to `/api/chat/stream`).

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::super::kernel_op::KernelOpError;
use super::super::ServerState;
use crate::approvals::{ApprovalRequest, PendingAction};

/// The refusal message for a shared (org-bound or managed) node.
pub(crate) const SHARED_NODE_REFUSAL: &str = "app chat sends are unavailable on managed nodes until the host caller is bound to the destination conversation and agent";

/// One app-initiated turn, already authenticated to `plugin_id`.
#[derive(Debug, Clone)]
pub(crate) struct AppSendRequest {
    pub plugin_id: String,
    pub agent_id: Option<String>,
    pub conversation_id: String,
    pub cwd: Option<String>,
    pub text: String,
    pub model: Option<String>,
}

/// How the turn runs when the approval gate is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Execution {
    /// Wait for the turn to finish (`chat.startTurn`).
    Await,
    /// Start the turn and answer at once (`chat.send`, a broadcast to many chats).
    Detach,
}

/// What happened to an accepted send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppSendOutcome {
    /// Queued in the Approvals inbox; runs only if the user approves it.
    PendingApproval { approval_id: String },
    /// The turn ran to completion.
    Sent,
    /// The turn was started and keeps running in Core.
    Accepted,
}

impl AppSendOutcome {
    /// The JSON reply both entry points return.
    pub(crate) fn to_json(&self, conversation_id: &str) -> Value {
        match self {
            Self::PendingApproval { approval_id } => json!({
                "status": "pending_approval",
                "approval_id": approval_id,
                "conversation_id": conversation_id,
            }),
            Self::Sent => json!({ "status": "sent", "conversation_id": conversation_id }),
            Self::Accepted => json!({ "status": "accepted", "conversation_id": conversation_id }),
        }
    }
}

/// Refuse an app send on a shared node, where an app-authenticated call carries
/// no proof of which human owns the destination.
pub(crate) fn refuse_shared_node() -> Result<(), KernelOpError> {
    if crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node()
    {
        return Err(KernelOpError::new(
            StatusCode::FORBIDDEN,
            SHARED_NODE_REFUSAL,
        ));
    }
    Ok(())
}

/// Record a refused send in the exec audit log.
async fn audit_refusal(request: &AppSendRequest, reason: &str) {
    crate::sidecar::gateway::report_exec_audit_with_attribution(
        "app-send",
        "start_turn",
        0,
        1,
        Some(request.conversation_id.clone()),
        Some(reason.to_owned()),
        crate::sidecar::gateway::ExecAuditAttribution {
            agent_id: request.agent_id.clone(),
            feature: Some("agent".to_owned()),
            ..Default::default()
        },
    )
    .await;
}

/// Run the content gates, then queue the send for approval or run it.
///
/// The text must already be trimmed and non-empty.
pub(crate) async fn submit_app_send(
    state: &ServerState,
    request: AppSendRequest,
    execution: Execution,
) -> Result<AppSendOutcome, KernelOpError> {
    // Command-risk gate (hardline commands, deletion, supply chain), mirroring
    // the widget follow-up path. An app's prompt is no more trusted than a
    // widget's.
    let scan = crate::sidecar::gateway::check_exec_scan(
        "app-send",
        &request.text,
        Some(&request.conversation_id),
        request.agent_id.as_deref(),
    )
    .await;
    if let crate::sidecar::gateway::ExecScanOutcome::Deny(reason) = scan {
        audit_refusal(&request, &reason).await;
        return Err(KernelOpError::new(StatusCode::FORBIDDEN, reason));
    }

    // Content gate: the Gateway firewall's secret and prompt-injection
    // guardrails, fail-closed. Runs before the approval is queued, so a refused
    // send never reaches the inbox or a turn.
    if let Err(reason) = super::ingress::govern_ingress("app-send", &request.text).await {
        audit_refusal(&request, &reason).await;
        return Err(KernelOpError::new(StatusCode::FORBIDDEN, reason));
    }

    let plugin_id = request.plugin_id.clone();
    let text = request.text.clone();
    let action = PendingAction::AppSendTurn {
        plugin_id: request.plugin_id,
        agent_id: request.agent_id,
        conversation_id: request.conversation_id,
        cwd: request.cwd,
        text: request.text,
        model: request.model,
    };

    if super::ask_before_send(state).await {
        // Fail CLOSED: with the gate on and no inbox to raise it in, the send
        // does not happen.
        let Some(engine) = crate::approvals::global_engine() else {
            return Err(KernelOpError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "approval is required for app sends, but the approvals engine is unavailable",
            ));
        };
        let req = ApprovalRequest::for_app_send(&plugin_id, &text, action);
        return match engine.request(req).await {
            Ok(created) => Ok(AppSendOutcome::PendingApproval {
                approval_id: created.id,
            }),
            Err(e) => Err(KernelOpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not queue the approval: {e}"),
            )),
        };
    }

    // Gate off: run it through the SAME executor an approved send uses.
    match execution {
        Execution::Await => crate::approvals::execute_app_send_turn(&action)
            .await
            .map(|()| AppSendOutcome::Sent)
            .map_err(|e| KernelOpError::new(StatusCode::BAD_GATEWAY, e.to_string())),
        Execution::Detach => {
            if crate::sidecar::agent_runner::global_agent_runner().is_none() {
                return Err(KernelOpError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "no agent runner is published on this node; the message was not sent",
                ));
            }
            tokio::spawn(async move {
                if let Err(e) = crate::approvals::execute_app_send_turn(&action).await {
                    tracing::warn!(plugin = %plugin_id, "detached app send failed: {e:#}");
                }
            });
            Ok(AppSendOutcome::Accepted)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_outcome_names_its_status_and_destination() {
        let pending = AppSendOutcome::PendingApproval {
            approval_id: "ap_1".into(),
        };
        assert_eq!(
            pending.to_json("c1"),
            json!({ "status": "pending_approval", "approval_id": "ap_1", "conversation_id": "c1" })
        );
        assert_eq!(
            AppSendOutcome::Sent.to_json("c1"),
            json!({ "status": "sent", "conversation_id": "c1" })
        );
        assert_eq!(
            AppSendOutcome::Accepted.to_json("c1"),
            json!({ "status": "accepted", "conversation_id": "c1" })
        );
    }
}

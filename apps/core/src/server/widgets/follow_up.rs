//! `POST /api/widgets/follow-up`: the provenance, budget, exec-scan and content
//! gates a widget's follow-up prompt passes before it may enter a turn.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;

use super::{err_reply, store, WidgetInstance};
use crate::server::host_chat::ingress::govern_ingress;
use crate::server::ServerState;

/// The caller name the content gate puts in its refusal messages.
const INGRESS_SURFACE: &str = "widget-follow-up";

#[derive(Debug, Deserialize)]
pub struct WidgetFollowUpBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    #[serde(default, rename = "toolCallId", alias = "tool_call_id")]
    tool_call_id: Option<String>,
    prompt: String,
}

/// `POST /api/widgets/follow-up` — provenance gate + exec scan + firewall
/// content gate (secrets, prompt injection; fail-closed) + audit,
/// then return the provenance-tagged user turn (`source:"widget"`). The desktop
/// sends the returned turn through the normal chat transport; scanning it here
/// closes the prompt-injection vector before it enters model context (R4).
#[utoipa::path(
    post,
    path = "/api/widgets/follow-up",
    tag = "Widgets",
    summary = "provenance gate + firewall/DLP scan + audit,",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn widget_follow_up(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetFollowUpBody>,
) -> axum::response::Response {
    follow_up_response(body).await
}

/// The route body, apart from the extractors so tests can drive every gate.
pub(super) async fn follow_up_response(body: WidgetFollowUpBody) -> axum::response::Response {
    let Some(record) = store().get(&body.instance_id) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    };
    if body.prompt.trim().is_empty() {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "prompt is required",
        );
    }

    // Permission, BEFORE the scan: a widget that was never granted `ui:send_message`
    // may not put words in the user's conversation, and there is no reason to run
    // its prompt through the firewall to reach the same answer. The decision was
    // made at emit time (`may_send_follow_up`) from the owning plugin's grants; this
    // is where it is enforced, because the route is reachable without going through
    // the desktop host that performs the client-side capability check.
    if !record.may_send_follow_up {
        tracing::info!(
            instance = %record.instance_id,
            server = %record.origin_server,
            "widget follow-up refused: this widget was not granted `ui:send_message`"
        );
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "this widget is not allowed to send follow-up messages",
        );
    }

    // The Gateway owns the per-instance follow-up bucket. Check it before the
    // prompt scan and fail closed on a denied or unavailable governance call so
    // this route cannot bypass the configured limit.
    if let crate::sidecar::gateway::ExecBudgetOutcome::Deny(reason) =
        crate::sidecar::gateway::check_widget_followup(&record.instance_id, &record.origin_server)
            .await
    {
        let code = if reason.to_ascii_lowercase().contains("rate limit")
            || reason.to_ascii_lowercase().contains("budget")
        {
            "over_budget"
        } else {
            "server_error"
        };
        let status = if code == "over_budget" {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        // A denied follow-up must remain visible in the Gateway audit trail,
        // including rate-limit, budget, and fail-closed Gateway errors.
        audit_follow_up(&record, Some(reason.clone())).await;
        return err_reply(status, code, reason);
    }

    // Command-risk gate (hardline commands, deletion, supply chain). It has no
    // secret, prompt-injection or PII detectors, so it is not the content gate.
    let scan = crate::sidecar::gateway::check_exec_scan(
        "widget-followup",
        &body.prompt,
        Some(&record.conversation_id),
        Some(&record.agent_id),
    )
    .await;
    if let crate::sidecar::gateway::ExecScanOutcome::Deny(reason) = scan {
        audit_follow_up(&record, Some(reason.clone())).await;
        return err_reply(StatusCode::FORBIDDEN, "denied", reason);
    }

    // Content gate: the Gateway firewall's secret and prompt-injection
    // guardrails, the same fail-closed check an app send passes. A block, an
    // error, an unreadable verdict or an unreachable Gateway all refuse, so
    // attacker text inside a widget cannot reach model context unscanned.
    if let Err(reason) = govern_ingress(INGRESS_SURFACE, &body.prompt).await {
        audit_follow_up(&record, Some(reason.clone())).await;
        return err_reply(StatusCode::FORBIDDEN, "denied", reason);
    }

    // Audit the accepted follow-up (never the content).
    audit_follow_up(&record, None).await;

    let Some(ticket) = store().issue_follow_up_ticket(&record, &body.prompt) else {
        return err_reply(
            StatusCode::SERVICE_UNAVAILABLE,
            "server_error",
            "could not issue widget follow-up ticket",
        );
    };

    Json(json!({
        "ok": true,
        "ticket": ticket,
        "injected": {
            "role": "user",
            "source": "widget",
            "widget_instance_id": record.instance_id,
            "origin_server": record.origin_server,
            "conversation_id": record.conversation_id,
            "tool_call_id": body.tool_call_id,
            "prompt": body.prompt,
        }
    }))
    .into_response()
}

/// Report a follow-up decision to the Gateway exec audit: `error` is the refusal
/// reason, `None` an accepted prompt. Best-effort; the prompt is never sent.
async fn audit_follow_up(record: &WidgetInstance, error: Option<String>) {
    crate::sidecar::gateway::report_exec_audit_with_attribution(
        "widget-followup",
        "follow_up",
        0,
        i32::from(error.is_some()),
        Some(record.conversation_id.clone()),
        error,
        crate::sidecar::gateway::ExecAuditAttribution {
            agent_id: Some(record.agent_id.clone()),
            feature: Some("widget".to_owned()),
            ..Default::default()
        },
    )
    .await;
}

#[cfg(test)]
#[path = "follow_up_test.rs"]
mod follow_up_test;

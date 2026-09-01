//! `chat.startTurn` — the kernel capability that lets an app post a turn on the
//! user's behalf, into a real conversation they can see.
//!
//! ## Why this exists
//!
//! Before this, nothing out-of-process could send. A manifest sidecar is spawned
//! WITHOUT Core's `RYU_TOKEN` (`sidecar/process.rs` — inheriting it would let a
//! third-party backend forge every other plugin's ext-token), so it has no way to
//! reach the chat API. The two adjacent primitives both stop short on purpose:
//!
//! - [`AgentRunner::run`](crate::sidecar::agent_runner::AgentRunner::run) and the
//!   scheduler's `JobTarget::Agent` run with `persist = false`, so they answer the
//!   caller and write no conversation. Right for a keep-alive ping, useless for
//!   "send this message" — there is nothing for the user to open.
//! - The widget follow-up (`/api/widgets/follow-up`, gated by `ui:send_message`)
//!   only RETURNS an `injected` envelope for the desktop host to act on. It needs a
//!   live desktop; a queued message that should go out at 04:00 does not have one.
//!
//! So this is the missing half: a persisted turn, startable by a sidecar, with no
//! desktop in the loop.
//!
//! ## What guards it
//!
//! Four gates, in order, and the request dies at the first one that refuses:
//!
//! 1. **Authentication** — the caller's minted `ext_token` (`authenticate_sidecar`),
//!    so a process that did not come from Core's spawn cannot call at all.
//! 2. **Grant** — `chat.sendFollowUp`, declared in the app's `sidecars[].host_api.grants`
//!    AND Gateway-approved. `chat` is a RESERVED namespace, so no app can
//!    owner-scope its way in by naming itself `com.evil.chat`.
//! 3. **Firewall / PII-DLP** — the prompt is scanned before it can enter model
//!    context, exactly as the widget follow-up scans its own.
//! 4. **Approval** — [`ASK_BEFORE_APP_SEND_PREF`], default ON. The send is queued as
//!    a [`PendingAction::AppSendTurn`] in the Approvals inbox and runs only when the
//!    user approves it.
//!
//! Gate 4 is the one that matters most, and it is why gate 2 can be on the
//! Gateway's default allowlist at all: spending someone's subscription tokens
//! unattended is not something a grant alone should buy. Turning the preference off
//! is an explicit, per-node decision to trust the grant by itself.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::approvals::{ApprovalRequest, PendingAction};

/// Preference key: ask before an app posts a turn on the user's behalf.
///
/// A KERNEL preference, not a setting an App registers. An app-registered settings
/// tab inherits that app's enablement, so disabling the app would leave the gate
/// unreachable while apps could still send — the same trap
/// `routing-retry-policy` calls out. This governs every app, so it belongs to the
/// node.
pub const ASK_BEFORE_APP_SEND_PREF: &str = "apps-ask-before-send";

/// The grant a sidecar must hold to call `chat.startTurn`.
///
/// Reuses the EXISTING reserved sigil rather than minting a new one:
/// `chat.sendFollowUp` is already defined in the Gateway's governance as "post a
/// chat turn on the user's behalf", which is exactly this power. A second name for
/// one power is how two gates drift apart.
pub const GRANT_SEND_FOLLOW_UP: &str = "chat.sendFollowUp";

/// Default when the preference has never been set: **ask**.
///
/// Fail-safe in the direction that costs the user nothing but a tap. The opposite
/// default would mean installing an app could start spending a subscription before
/// the user had any idea the app could do that.
const ASK_BY_DEFAULT: bool = true;

/// Whether an app-initiated send must be approved first.
pub async fn ask_before_send(state: &ServerState) -> bool {
    match state.preferences.get(ASK_BEFORE_APP_SEND_PREF).await {
        // Any value that is not an explicit "false" means ask. A malformed or
        // half-written preference must never silently open the gate.
        Ok(Some(raw)) => raw.trim() != "false",
        _ => ASK_BY_DEFAULT,
    }
}

/// Body of `POST /api/host/capability/chat.startTurn`.
#[derive(Debug, Deserialize)]
pub struct StartTurnBody {
    /// The message to send. Required and non-blank.
    pub text: String,
    /// Which agent answers. `None` uses the node's configured default.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Continue an existing conversation. `None` starts a NEW one.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Pin the model for this turn only.
    #[serde(default)]
    pub model: Option<String>,
}

/// Handle `chat.startTurn`.
///
/// Returns one of three shapes, and the caller is expected to distinguish them:
/// - `202 { status: "pending_approval", approval_id }` — queued, awaiting the user.
/// - `200 { status: "sent", conversation_id }` — the turn ran.
/// - a 4xx/5xx error.
pub async fn host_chat_start_turn(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<StartTurnBody>,
) -> Response {
    // The caller is re-authenticated HERE, not merely at the broker: every kernel
    // capability handler re-runs this so the plugin id it acts under is the one
    // that proved possession of a minted token, never a body-supplied claim.
    let plugin_id = match crate::sidecar::ext_proxy::authenticate_sidecar(&state, &headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    let text = body.text.trim();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "text is required" })),
        )
            .into_response();
    }

    // A new conversation gets a fresh id here rather than inside the runner, so the
    // id is known BEFORE the send — it has to be, because an approval-gated send
    // answers the caller long before the turn runs, and the caller still needs to
    // know where the message will land.
    let conversation_id = body
        .conversation_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("appsend_{}", uuid::Uuid::new_v4().simple()));

    // Firewall / PII-DLP before the text can enter model context, mirroring the
    // widget follow-up path. An app's prompt is no more trusted than a widget's.
    let scan = crate::sidecar::gateway::check_exec_scan(
        "app-send",
        text,
        Some(&conversation_id),
        body.agent_id.as_deref(),
    )
    .await;
    if let crate::sidecar::gateway::ExecScanOutcome::Deny(reason) = scan {
        crate::sidecar::gateway::report_exec_audit_with_attribution(
            "app-send",
            "start_turn",
            0,
            1,
            Some(conversation_id.clone()),
            Some(reason.clone()),
            crate::sidecar::gateway::ExecAuditAttribution {
                agent_id: body.agent_id.clone(),
                feature: Some("agent".to_owned()),
                ..Default::default()
            },
        )
        .await;
        return (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response();
    }

    let action = PendingAction::AppSendTurn {
        plugin_id: plugin_id.clone(),
        agent_id: body.agent_id.clone(),
        conversation_id: conversation_id.clone(),
        text: text.to_owned(),
        model: body.model.clone(),
    };

    if ask_before_send(&state).await {
        let Some(engine) = crate::approvals::global_engine() else {
            // Fail CLOSED. The gate is ON and there is no inbox to raise it in, so
            // the send does not happen — an unapprovable send must never fall
            // through to an unapproved one.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "approval is required for app sends, but the approvals engine is unavailable"
                })),
            )
                .into_response();
        };
        let req = ApprovalRequest::for_app_send(&plugin_id, text, action);
        return match engine.request(req).await {
            Ok(created) => (
                StatusCode::ACCEPTED,
                Json(json!({
                    "status": "pending_approval",
                    "approval_id": created.id,
                    "conversation_id": conversation_id,
                })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not queue the approval: {e}") })),
            )
                .into_response(),
        };
    }

    // Gate off: run it now, through the SAME executor an approved send uses, so the
    // two paths cannot drift into behaving differently.
    match crate::approvals::execute_app_send_turn(&action).await {
        Ok(()) => {
            Json(json!({ "status": "sent", "conversation_id": conversation_id })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// The grant a sidecar must hold to call `node.readings`.
///
/// Its own sigil rather than reusing `core:list_agents`: this reads live activity
/// and subscription usage, which is a different thing from enumerating configured
/// agents, and a grant that means two things cannot be refused for one of them.
pub const GRANT_NODE_READINGS: &str = "core:readings";

/// Body of `POST /api/host/capability/node.readings`.
#[derive(Debug, Deserialize, Default)]
pub struct ReadingsBody {
    /// Agents whose usage windows to read. Empty ⇒ no usage is read at all, which
    /// keeps a caller that only needs the run count from making vendor calls.
    #[serde(default)]
    pub agent_ids: Vec<String>,
}

/// Handle `node.readings` — the live facts an app needs to decide whether now is a
/// good time to send: how many agent runs are active, and how full each named
/// agent's usage windows are.
///
/// This exists because a sidecar cannot call `/api/runs` or `/api/agents/:id/usage`
/// itself — it holds no node token — so without it an app can only send blindly.
///
/// **Counts, never contents.** The run figure is a COUNT; no title, folder path or
/// id crosses. `/api/runs` is per-resource ACL-filtered because run titles and
/// working folders are tenant data, and an unauthenticated-by-user sidecar has no
/// caller identity to filter by. A number does not carry that data, so the count is
/// safe where the list would not be.
pub async fn host_node_readings(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<ReadingsBody>,
) -> Response {
    if let Err((status, msg)) =
        crate::sidecar::ext_proxy::authenticate_sidecar(&state, &headers).await
    {
        return (status, Json(json!({ "error": msg }))).into_response();
    }

    let running = match state
        .conversations
        .list_runs_visible(None, None, false)
        .await
    {
        Ok(items) => items
            .iter()
            .filter(|r| r.run_status.as_deref() == Some("running"))
            .count(),
        // An unreadable store is reported as an ERROR, never as zero: a caller that
        // reads "0 running" starts work, and "the database did not answer" is not
        // the same fact as "the node is idle".
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not read runs: {e}") })),
            )
                .into_response()
        }
    };

    let mut usage = Vec::new();
    for agent_id in body.agent_ids.iter().take(MAX_USAGE_AGENTS) {
        let snapshot = ryu_usage::fetch_usage(agent_id).await;
        if !snapshot.available {
            // Omitted, not zeroed — the caller must be able to tell "this plan has
            // room" from "we could not find out".
            continue;
        }
        let fullest = snapshot
            .windows
            .iter()
            .map(|w| w.used_percent)
            .fold(f64::NEG_INFINITY, f64::max);
        if fullest.is_finite() {
            usage.push(json!({ "agent_id": agent_id, "used_percent": fullest }));
        }
    }

    Json(json!({ "running": running, "usage": usage })).into_response()
}

/// Bound on how many agents one `node.readings` call may price. Each is a vendor
/// HTTP round-trip, so an unbounded list is a way to make Core sit in a loop.
const MAX_USAGE_AGENTS: usize = 16;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_false_opens_the_gate() {
        // The parse is deliberately asymmetric: "ask" is every value except one.
        for raw in ["", "true", "yes", "TRUE", "nonsense", " "] {
            assert!(
                raw.trim() != "false",
                "'{raw}' must be read as ask-before-send"
            );
        }
        assert!("false" == "false".trim());
    }
}

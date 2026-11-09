//! The chat-stream half of the device lane: stamping the per-turn offer and
//! verifying device results on `POST /api/chat/client-tool-result`.

use std::sync::Arc;

use super::auth::{device_error, principal_for, require_store, status_for, verify_signed};
use super::routes::device_tools_enabled;
use crate::device_tools::agent_events::HistoryMarks;
use crate::device_tools::claims::{self, ResultSubmission};
use crate::device_tools::identity::DevicePrincipal;
use crate::device_tools::offer::{is_own_chat, DeviceOffer};
use crate::device_tools::{caps_resolver, now_ms, presence, routing, DeviceErrorCode};
use crate::server::*;
use axum::response::Response;

pub(in crate::server) const CHAT_STREAM_ROUTE: &str = "/api/chat/stream";
pub(in crate::server) const RESULT_ROUTE: &str = "/api/chat/client-tool-result";

/// Everything the stamping step reads from the chat request.
pub(in crate::server) struct OfferRequest<'a> {
    pub(in crate::server) headers: &'a axum::http::HeaderMap,
    pub(in crate::server) body: &'a [u8],
    pub(in crate::server) auth: Option<&'a ResolvedAuthorization>,
    pub(in crate::server) caller: Option<&'a crate::identity_verify::VerifiedCaller>,
    pub(in crate::server) user_jwt: Option<&'a str>,
}

/// Stamp `req.device.device_tools_offer` for an interactive own-chat turn, or leave
/// it `None`. Called only by `chat_stream`, after its conversation ACL and
/// just before the single-agent dispatch (team and workflow turns have
/// already returned). A flag that is off, a missing consent, a cloud or
/// temporary turn, an app capped `never` or a conversation that is not the
/// caller's own simply offers nothing. A declaration that
/// fails verification is refused.
pub(in crate::server) async fn stamp_device_offer(
    state: &ServerState,
    request: OfferRequest<'_>,
    req: &mut ChatStreamRequest,
) -> Result<(), Response> {
    req.device.device_tools_offer = None;
    let Some(mut decl) = req.device.client_device.take() else {
        return Ok(());
    };
    let eligible = req.device.device_tools_consent
        && req.persist
        && req.cloud_environment_id.is_none()
        && req.cloud_task_context.is_none()
        && req.team_id.is_none()
        && req.workflow_id.is_none()
        && !req.untrusted_caller;
    let Some(conversation_id) = req.conversation_id.clone().filter(|_| eligible) else {
        return Ok(());
    };
    let node_bound = node_org_id().is_some();
    let Some(principal) = request
        .auth
        .and_then(|auth| principal_for(&auth.context, request.caller, node_bound))
    else {
        return Ok(());
    };
    if !device_tools_enabled(state, &principal, request.user_jwt).await {
        return Ok(());
    }
    let header_device = super::auth::signed_headers(request.headers).map(|h| h.device_id);
    if decl.validate(header_device.as_deref()).is_err() {
        return Err(device_error(
            StatusCode::BAD_REQUEST,
            DeviceErrorCode::InvalidSignature,
        ));
    }
    let store = require_store()?;
    let device_id = verify_signed(
        request.headers,
        "POST",
        CHAT_STREAM_ROUTE,
        &principal,
        request.body,
        &store,
    )?;
    if device_id != decl.device_id {
        return Err(device_error(
            StatusCode::BAD_REQUEST,
            DeviceErrorCode::InvalidSignature,
        ));
    }
    let now = now_ms();
    presence::refresh_with_decl(&principal.id(), &device_id, &decl, now);
    store.touch(&principal.id(), &device_id, now);
    if !decl.foreground {
        return Ok(());
    }
    if !own_chat(state, &principal, &conversation_id, req.agent_id.as_deref()).await {
        return Ok(());
    }
    let mode_pref = state
        .preferences
        .get(crate::approvals::policy::APPROVAL_MODE_PREF)
        .await
        .ok()
        .flatten();
    let mode =
        crate::approvals::policy::ApprovalMode::from_pref(mode_pref.as_deref().unwrap_or(""));
    // Caps only restrict (P5): none on a personal node, the caller's own on an
    // org-bound node, "never" when those cannot be resolved. Apps other paired
    // phones declared are offered too and routed there (P3, always asks).
    let caps = caps_resolver::caps_for(&principal).await;
    let peer_apps = routing::other_device_apps(&store, &principal.id(), &device_id);
    // What the conversation already holds: untrusted external content makes
    // every device call ask; an earlier device read keeps an ACP agent's
    // later egress held (its history still has the raw result).
    let history = history_marks(state, &conversation_id, &req.messages).await;
    let offer = DeviceOffer::new(conversation_id, principal, decl, mode)
        .with_caps_and_peers(caps, &peer_apps)
        .with_history(history.untrusted, history.private_read);
    if !offer.offerable.is_empty() {
        req.device.device_tools_offer = Some(Arc::new(offer));
    }
    Ok(())
}

/// Scan the stored transcript and the submitted messages for untrusted tool
/// output and earlier device reads. A transcript that cannot be read counts as
/// untrusted (every device call asks).
async fn history_marks(
    state: &ServerState,
    conversation_id: &str,
    messages: &[crate::sidecar::adapters::UiMessage],
) -> HistoryMarks {
    let mut marks = HistoryMarks::default();
    for message in messages {
        let parts = message.render_parts();
        let parts = parts.as_ref().and_then(Value::as_array);
        marks.add_message(&message.role, parts.map(Vec::as_slice).unwrap_or_default());
    }
    match state.conversations.get_messages(conversation_id).await {
        Ok(stored) => {
            for message in &stored {
                let parts = message.parts.as_ref().and_then(Value::as_array);
                marks.add_message(&message.role, parts.map(Vec::as_slice).unwrap_or_default());
            }
        }
        Err(_) => marks.untrusted = true,
    }
    marks
}

/// The strict own-chat check, creating the row for a brand-new conversation
/// (owned by the verified user on a bound node) first so the check is never
/// vacuous.
async fn own_chat(
    state: &ServerState,
    principal: &DevicePrincipal,
    conversation_id: &str,
    agent_id: Option<&str>,
) -> bool {
    if matches!(
        state
            .conversations
            .is_channel_conversation(conversation_id)
            .await,
        Ok(true) | Err(_)
    ) {
        return false;
    }
    let mut meta = state.conversations.get_access_meta(conversation_id).await;
    if matches!(meta, Ok(None)) {
        // A brand-new conversation: create its row for this principal first,
        // so the check below is never vacuous.
        let tenancy = match principal {
            DevicePrincipal::LocalOwner => crate::server::conversations::Tenancy::Unattributed,
            DevicePrincipal::User(user_id) => crate::server::conversations::Tenancy::Owned {
                user_id: user_id.clone(),
                org_id: node_org_id(),
            },
        };
        let created = state
            .conversations
            .ensure_conversation(conversation_id, agent_id, None, tenancy)
            .await;
        if created.is_err() {
            return false;
        }
        meta = state.conversations.get_access_meta(conversation_id).await;
    }
    matches!(meta, Ok(Some(ref meta)) if is_own_chat(Some(meta), principal, node_org_id().is_some()))
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct DeviceResultBody {
    conversation_id: String,
    tool_call_id: String,
    claim_id: String,
    input_sha256: String,
    provenance: Value,
    result: Value,
}

/// The device lane of `POST /api/chat/client-tool-result`: chosen by the
/// pending call record, never by the client. Requires a valid signature from
/// the target device, the stored claim id, the frozen input hash and the
/// owner; single use.
pub(in crate::server) fn resolve_device_result(
    headers: &axum::http::HeaderMap,
    body: &[u8],
    auth: Option<&ResolvedAuthorization>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Response {
    let Some(principal) =
        auth.and_then(|auth| principal_for(&auth.context, caller, node_org_id().is_some()))
    else {
        return device_error(StatusCode::FORBIDDEN, DeviceErrorCode::DeviceNotPaired);
    };
    let store = match require_store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let device_id = match verify_signed(headers, "POST", RESULT_ROUTE, &principal, body, &store) {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let Ok(request) = serde_json::from_slice::<DeviceResultBody>(body) else {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidInput);
    };
    let provenance_ok = request.provenance.get("source").and_then(Value::as_str)
        == Some("ryu-device")
        && request.provenance.get("device_id").and_then(Value::as_str) == Some(device_id.as_str());
    if !provenance_ok {
        return device_error(StatusCode::BAD_REQUEST, DeviceErrorCode::InvalidSignature);
    }
    let principal_id = principal.id();
    match claims::submit_result(ResultSubmission {
        conversation_id: &request.conversation_id,
        tool_call_id: &request.tool_call_id,
        claim_id: &request.claim_id,
        principal_id: &principal_id,
        device_id: &device_id,
        input_sha256: &request.input_sha256,
        result: request.result,
        now_ms: now_ms(),
    }) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(code) => device_error(status_for(code), code),
    }
}

/// Whether this result targets a pending device call (the device lane).
pub(in crate::server) fn is_device_result(conversation_id: &str, tool_call_id: &str) -> bool {
    claims::is_device_call(conversation_id, tool_call_id)
}

/// `POST /api/chat/permission` for a `perm-dev-*` id: the conversation write
/// ACL, then the owner, then Core's offered-option check (an option it did not
/// offer is a deny). A prompt that needs on-device confirmation can only be
/// denied here; approving it is `POST /api/device-tools/confirm`.
pub(in crate::server) async fn resolve_device_prompt(
    state: &ServerState,
    auth: Option<&ResolvedAuthorization>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    request_id: &str,
    option_id: Option<&str>,
) -> Response {
    use crate::device_tools::prompts::{self, ResolveError};
    let Some(conversation_id) = prompts::peek_conversation(request_id) else {
        return Json(json!({ "resolved": false })).into_response();
    };
    if let Err(response) = require_resource_write(
        state.conversations.get_access_meta(&conversation_id).await,
        caller,
        &format!("permission request '{request_id}' not found"),
    ) {
        return response;
    }
    let Some(principal) =
        auth.and_then(|auth| principal_for(&auth.context, caller, node_org_id().is_some()))
    else {
        return device_error(StatusCode::FORBIDDEN, DeviceErrorCode::DeviceNotPaired);
    };
    match prompts::resolve(request_id, option_id, &principal.id()) {
        Ok(answer) => Json(json!({
            "resolved": true,
            "decision": match answer {
                prompts::PromptAnswer::AllowOnce => "allow_once",
                prompts::PromptAnswer::AllowAlways => "allow_always",
                prompts::PromptAnswer::Deny => "deny",
            },
        }))
        .into_response(),
        Err(ResolveError::Unknown) => Json(json!({ "resolved": false })).into_response(),
        Err(ResolveError::NotOwner) => json_error(
            StatusCode::FORBIDDEN,
            format!("permission request '{request_id}' not found"),
        ),
        Err(ResolveError::OnDeviceOnly) => {
            device_error(StatusCode::FORBIDDEN, DeviceErrorCode::ApprovalRequired)
        }
        Err(ResolveError::InputMismatch) => {
            device_error(StatusCode::CONFLICT, DeviceErrorCode::InputMismatch)
        }
    }
}

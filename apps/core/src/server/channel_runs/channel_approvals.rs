//! Approval buttons in chat apps: the prompts a channel turn returns, the
//! route a button press is decided through, and the per-connection setting.
//!
//! The rules live in [`crate::approvals::channel_decisions`] and
//! [`crate::approvals::channel_settings`]; this file is the HTTP shape.
//!
//! These routes are not in the OpenAPI document on purpose: the decision route
//! is Gateway to Core only, and neither route should become an assistant tool.

use crate::approvals::channel_decisions::{ChannelApprovalPrompt, ChannelPress};
use crate::server::*;

/// Longest opaque value a press may carry in any field.
const MAX_FIELD_LEN: usize = 256;

/// The prompts to post after a channel turn. `connection` is the channel
/// config id of the turn; a bot without one (configured by environment
/// variables) is offered nothing.
pub(in crate::server) async fn channel_turn_approval_prompts(
    state: &ServerState,
    connection: Option<&str>,
    conversation_id: &str,
) -> Vec<ChannelApprovalPrompt> {
    let Some(connection) = connection.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let locale = crate::i18n::locale::node_locale().await;
    state
        .approvals
        .channel_approval_prompts(connection, conversation_id, locale)
        .await
}

/// Request body for `POST /api/channels/approvals/decide`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct ChannelApprovalDecideRequest {
    /// The opaque token from the button's callback data.
    pub(in crate::server) token: String,
    /// `true` for Approve, `false` for Deny.
    pub(in crate::server) approve: bool,
    /// The channel connection the press arrived on.
    pub(in crate::server) connection: String,
    /// The Core conversation the button message was posted in.
    pub(in crate::server) conversation_id: String,
    /// `telegram`, `slack` or `discord`.
    pub(in crate::server) platform: String,
    /// The platform account that pressed, as the platform reported it.
    pub(in crate::server) sender_id: String,
}

fn usable(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_FIELD_LEN
}

/// `POST /api/channels/approvals/decide` - decide the approval behind a chat
/// button press.
///
/// Called by the Gateway's channel adapters after they have checked the
/// platform's own proof of who pressed. Core then checks that the token was
/// issued for this connection and conversation, that the connection's setting
/// is on, that the chat account is linked to a Ryu user who may decide
/// approvals on this node, and that the approval is not one that stays in the
/// app. The answer is `{ outcome, status?, reason }`; only `decided` changed
/// the approval.
pub(in crate::server) async fn channel_approval_decide(
    State(state): State<ServerState>,
    Json(req): Json<ChannelApprovalDecideRequest>,
) -> axum::response::Response {
    if crate::sidecar::node_binding::binding_unresolved() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "this node's organization binding is not resolved yet; retry shortly".to_owned(),
        );
    }
    let fields = [
        &req.token,
        &req.connection,
        &req.conversation_id,
        &req.platform,
        &req.sender_id,
    ];
    if !fields.iter().all(|value| usable(value)) {
        // A code, not a sentence: only the Gateway reads it, in its log.
        return json_error(StatusCode::BAD_REQUEST, "invalid_press".to_owned());
    }
    let press = ChannelPress {
        token: req.token.trim().to_owned(),
        approve: req.approve,
        connection: req.connection.trim().to_owned(),
        conversation_id: req.conversation_id,
        platform: req.platform.trim().to_ascii_lowercase(),
        sender_id: req.sender_id.trim().to_owned(),
    };
    let decision = state.approvals.decide_from_channel(&press).await;
    Json(json!(decision)).into_response()
}

/// Request body for `PUT /api/approvals/channel-deciders/:connection`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct ChannelDecidersBody {
    /// Whether approvals raised on this connection can be decided from chat.
    #[serde(default)]
    pub(in crate::server) enabled: bool,
    /// The full list of chat accounts that may decide.
    #[serde(default)]
    pub(in crate::server) deciders: Vec<ChannelDeciderInput>,
}

/// One chat account to name on a connection.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct ChannelDeciderInput {
    pub(in crate::server) platform: String,
    pub(in crate::server) sender_id: String,
}

/// A signed-in caller holding `permission`. A node token alone is refused,
/// exactly as on the inbox routes.
async fn signed_in_with(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<String, StatusCode> {
    let Some(verified) = caller else {
        return Err(StatusCode::FORBIDDEN);
    };
    enforce_permission(state, caller, permission).await?;
    Ok(verified.user_id.clone())
}

/// `GET /api/approvals/channel-deciders/:connection` - the chat approval
/// setting of one channel connection. Needs `approvals.view`.
pub(in crate::server) async fn get_channel_deciders(
    State(state): State<ServerState>,
    Path(connection): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = signed_in_with(&state, &caller, "approvals.view").await {
        return json_error(status, "forbidden".to_owned());
    }
    let settings = state.approvals.channel_approval_settings(&connection).await;
    Json(json!({ "connection": connection, "settings": settings })).into_response()
}

/// `PUT /api/approvals/channel-deciders/:connection` - turn chat approvals on
/// or off for one channel connection and name the chat accounts that may
/// decide. Needs `approvals.decide`. A newly named account is linked to the
/// caller, and decides only while the caller may decide.
pub(in crate::server) async fn put_channel_deciders(
    State(state): State<ServerState>,
    Path(connection): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ChannelDecidersBody>,
) -> axum::response::Response {
    let user_id = match signed_in_with(&state, &caller, "approvals.decide").await {
        Ok(user_id) => user_id,
        Err(status) => return json_error(status, "forbidden".to_owned()),
    };
    let wanted: Vec<(String, String)> = body
        .deciders
        .into_iter()
        .map(|decider| (decider.platform, decider.sender_id))
        .collect();
    match state
        .approvals
        .save_channel_approval_settings(&connection, body.enabled, &wanted, &user_id)
        .await
    {
        Ok(settings) => {
            Json(json!({ "connection": connection, "settings": settings })).into_response()
        }
        Err(message) => json_error(StatusCode::BAD_REQUEST, message),
    }
}

#[cfg(test)]
#[path = "channel_approvals_tests.rs"]
mod tests;

//! The HTTP shape of chat approval buttons: who may change the setting, and
//! that a machine caller reaches only the checked decision path.

use super::*;
use crate::approvals::{ApprovalRequest, ApprovalStatus, PendingAction};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::node_binding::with_test_enrollment;

const CONNECTION: &str = "chan_http";
const CONVERSATION: &str = "conv-http";

/// A test node whose approval engine reads the node's preferences, as the
/// booted engine does.
fn test_state(directory: &std::path::Path) -> ServerState {
    crate::crypto_host::install();
    let mut state = crate::server::isolated_plugin_hook_test_state(directory);
    state.approvals = crate::approvals::ApprovalEngine::new(
        crate::approvals::store::ApprovalStore::open_in_memory().unwrap(),
        reqwest::Client::new(),
    )
    .with_preferences(state.preferences.clone());
    state
}

/// Run on an unbound, unmanaged node with no pending enrollment.
async fn unbound<F: std::future::Future>(fut: F) -> F::Output {
    with_test_node_binding(false, None, with_test_enrollment(false, fut)).await
}

fn signed_in(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: OrgRole::Owner,
        teams: Vec::new(),
    })
}

fn body(enabled: bool, sender: &str) -> Json<ChannelDecidersBody> {
    Json(
        serde_json::from_value(json!({
            "enabled": enabled,
            "deciders": [{ "platform": "telegram", "senderId": sender }],
        }))
        .unwrap(),
    )
}

async fn put(state: &ServerState, caller: Option<VerifiedCaller>, sender: &str) -> StatusCode {
    put_channel_deciders(
        State(state.clone()),
        Path(CONNECTION.to_owned()),
        Extension(caller),
        body(true, sender),
    )
    .await
    .status()
}

async fn decide(state: &ServerState, token: &str, sender: &str) -> serde_json::Value {
    let request: ChannelApprovalDecideRequest = serde_json::from_value(json!({
        "token": token,
        "approve": true,
        "connection": CONNECTION,
        "conversationId": CONVERSATION,
        "platform": "Telegram",
        "senderId": sender,
    }))
    .unwrap();
    let response = channel_approval_decide(State(state.clone()), Json(request)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn raise(state: &ServerState) -> ApprovalRequest {
    let action = PendingAction::ToolCall {
        tool_id: "gmail.send_email".to_owned(),
        arguments: json!({ "to": "someone@example.com" }),
        agent_id: None,
        allowlist: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: Some(CONVERSATION.to_owned()),
        composio_connection_scope: None,
        conversation_scope: None,
        configure_approved: false,
    };
    state
        .approvals
        .request(ApprovalRequest::for_tool_call(
            "gmail.send_email",
            vec!["send".to_owned()],
            action,
        ))
        .await
        .unwrap()
}

#[tokio::test]
async fn only_a_signed_in_caller_can_change_the_setting() {
    let directory = tempfile::tempdir().unwrap();
    let state = test_state(directory.path());
    unbound(async {
        // The Gateway's node token carries no user: it cannot name deciders.
        assert_eq!(put(&state, None, "111").await, StatusCode::FORBIDDEN);
        assert!(!state
            .approvals
            .channel_approval_settings(CONNECTION)
            .await
            .offers_buttons());

        assert_eq!(
            put(&state, signed_in("user-1"), "111").await,
            StatusCode::OK
        );
        let settings = state.approvals.channel_approval_settings(CONNECTION).await;
        assert!(settings.offers_buttons());
        assert_eq!(
            settings
                .decider(CONNECTION, "telegram", "111")
                .unwrap()
                .user_id,
            "user-1"
        );
        assert_eq!(
            put(&state, signed_in("user-1"), "not valid").await,
            StatusCode::BAD_REQUEST
        );

        let read = get_channel_deciders(
            State(state.clone()),
            Path(CONNECTION.to_owned()),
            Extension(None),
        )
        .await;
        assert_eq!(read.status(), StatusCode::FORBIDDEN);
    })
    .await;
}

#[tokio::test]
async fn the_generic_preference_route_cannot_write_the_setting() {
    let denied =
        generic_preference_write_denial(crate::approvals::channel_settings::CHANNEL_DECIDERS_PREF);
    assert_eq!(
        denied.map(|response| response.status()),
        Some(StatusCode::FORBIDDEN)
    );
    assert!(generic_preference_write_denial("theme").is_none());
}

#[tokio::test]
async fn a_press_is_decided_only_for_the_named_account() {
    let directory = tempfile::tempdir().unwrap();
    let state = test_state(directory.path());
    unbound(async {
        assert_eq!(
            put(&state, signed_in("user-1"), "111").await,
            StatusCode::OK
        );
        let req = raise(&state).await;

        // Nothing is offered unless the Gateway names the connection.
        assert!(channel_turn_approval_prompts(&state, None, CONVERSATION)
            .await
            .is_empty());
        let prompts = channel_turn_approval_prompts(&state, Some(CONNECTION), CONVERSATION).await;
        assert_eq!(prompts.len(), 1);
        let token = prompts[0].token.clone();

        let stranger = decide(&state, &token, "999").await;
        assert_eq!(stranger["outcome"], "refused");
        assert!(stranger.get("status").is_none());
        let pending = state.approvals.store.get(&req.id).await.unwrap().unwrap();
        assert_eq!(pending.status, ApprovalStatus::Pending);

        let owner = decide(&state, &token, "111").await;
        assert_eq!(owner["outcome"], "decided");
        assert_eq!(owner["status"], "approved");
        let again = decide(&state, &token, "111").await;
        assert_eq!(again["outcome"], "already_decided");
        assert_eq!(again["status"], "approved");
    })
    .await;
}

#[test]
fn only_the_node_token_can_report_a_press() {
    use crate::authorization::RoutePolicy;
    // The press names the chat account, and Core takes that from the caller.
    // A paired device or a member with chat access must not be that caller.
    let post = axum::http::Method::POST;
    assert_eq!(
        crate::server::route_policy(&post, "/api/channels/approvals/decide"),
        RoutePolicy::OwnerOnly
    );
    assert_ne!(
        crate::server::route_policy(&post, "/api/channels/run"),
        RoutePolicy::OwnerOnly,
        "the turn route keeps its chat capability rule"
    );
    // The setting routes sit with the inbox routes.
    assert_eq!(
        crate::server::route_policy(
            &axum::http::Method::PUT,
            "/api/approvals/channel-deciders/c1"
        ),
        crate::server::route_policy(&post, "/api/approvals/appr_1/approve")
    );
}

#[tokio::test]
async fn a_press_with_a_missing_field_is_a_bad_request() {
    let directory = tempfile::tempdir().unwrap();
    let state = test_state(directory.path());
    let request: ChannelApprovalDecideRequest = serde_json::from_value(json!({
        "token": " ",
        "approve": true,
        "connection": CONNECTION,
        "conversationId": CONVERSATION,
        "platform": "telegram",
        "senderId": "111",
    }))
    .unwrap();
    let response = unbound(channel_approval_decide(State(state), Json(request))).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

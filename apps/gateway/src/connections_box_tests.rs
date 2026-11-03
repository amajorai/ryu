//! A Box key (`gwb1`) is signed with a node-held org key, not by the member it
//! names, so `POST /v1/providers/call` must never let it act through that
//! member's personal Composio entity: it gets only the org-shared one. Other
//! callers keep the identity authentication accepted.

use std::sync::{Arc, Mutex};

use axum::{body::Bytes, extract::State as MockState, http::Uri, response::IntoResponse, Json};
use serde_json::{json, Value};

use super::*;
use crate::composio::{ComposioClient, ComposioTenantScope};

const ORG: &str = "org-box-composio";
const MEMBER: &str = "user-member-a";

/// `(path, body)` of every request the Composio stand-in received.
type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// Answers every connected account as owned by the member's personal entity,
/// and records each request.
async fn stand_in(
    MockState(seen): MockState<Seen>,
    uri: Uri,
    body: Bytes,
) -> axum::response::Response {
    let path = uri.path().to_owned();
    seen.lock()
        .unwrap()
        .push((path.clone(), String::from_utf8_lossy(&body).into_owned()));
    let last = path.rsplit('/').next().unwrap_or_default().to_owned();
    if path.starts_with("/api/v3.1/connected_accounts/") {
        let owner = ComposioTenantScope::new(ORG).unwrap().user_id(MEMBER);
        return Json(json!({ "id": last, "user_id": owner })).into_response();
    }
    Json(json!({ "data": { "executed": true }, "log_id": "log-box-1" })).into_response()
}

async fn state_with_stand_in() -> (AppState, Seen, tokio::task::JoinHandle<()>) {
    let seen: Seen = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new()
        .fallback(stand_in)
        .with_state(Arc::clone(&seen));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut state = AppState::new_for_test_default();
    let mut config = crate::config::ComposioConfig::default();
    config.enabled = true;
    config.api_key = Some("composio-box-test-key".to_owned());
    state.composio = Some(ComposioClient::for_test(
        config,
        reqwest::Client::new(),
        format!("http://{address}/api/v3.1"),
    ));
    (state, seen, server)
}

/// A context for `MEMBER` in `ORG`, as a hosted Box key or an org caller.
fn ctx(box_key: bool) -> RequestContext {
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.org_id = Some(ORG.to_owned());
    ctx.user_id = Some(MEMBER.to_owned());
    if box_key {
        ctx.api_key = format!("box:{ORG}:box-1");
        ctx.feature = Some("box".to_owned());
    } else {
        ctx.api_key = "rgw_org:core".to_owned();
    }
    ctx
}

fn call(tool_id: &str, operation: &str, account_id: Option<&str>) -> ConnectionCall {
    serde_json::from_value(json!({
        "toolId": tool_id,
        "operation": operation,
        "accountId": account_id,
        "method": "POST",
        "requestId": "req-box-1",
    }))
    .expect("connection call")
}

/// The `user_id` the first `tools/execute` request named upstream.
fn executed_as(seen: &Seen) -> Option<String> {
    seen.lock()
        .unwrap()
        .iter()
        .find(|(path, _)| path.starts_with("/api/v3.1/tools/execute/"))
        .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .and_then(|body| body["user_id"].as_str().map(str::to_owned))
}

async fn run(
    state: &AppState,
    ctx: &RequestContext,
    call: &ConnectionCall,
) -> Result<ConnectionOutcome, GatewayError> {
    let scope = ConnectionScope {
        ctx,
        org_id: Some(ORG),
    };
    ComposioConnection.call(state, scope, call).await
}

#[tokio::test]
async fn a_box_key_executes_only_as_the_org_shared_entity() {
    let tenant = ComposioTenantScope::new(ORG).unwrap();
    let (state, seen, server) = state_with_stand_in().await;
    // The receipt lookup that follows may fail; only the identity sent matters.
    let _ = run(
        &state,
        &ctx(true),
        &call("GMAIL_SEND_EMAIL", "execute", None),
    )
    .await;
    assert_eq!(executed_as(&seen), Some(tenant.default_user_id()));

    // Control: an org caller naming the member still acts as that member.
    let (state, seen, other) = state_with_stand_in().await;
    let _ = run(
        &state,
        &ctx(false),
        &call("GMAIL_SEND_EMAIL", "execute", None),
    )
    .await;
    assert_eq!(executed_as(&seen), Some(tenant.user_id(MEMBER)));
    server.abort();
    other.abort();
}

#[tokio::test]
async fn a_box_key_cannot_pin_or_disconnect_a_members_personal_account() {
    let (state, seen, server) = state_with_stand_in().await;
    let execute = call("GMAIL_SEND_EMAIL", "execute", Some("ca_member_personal"));
    let outcome = run(&state, &ctx(true), &execute).await;
    assert!(matches!(outcome, Err(GatewayError::PolicyViolation(_))));
    let disconnect = call("ca_member_personal", "disconnect", None);
    let outcome = run(&state, &ctx(true), &disconnect).await;
    assert!(matches!(outcome, Err(GatewayError::PolicyViolation(_))));
    // Only the ownership lookups reached Composio: nothing executed or deleted.
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .all(|(path, _)| path.starts_with("/api/v3.1/connected_accounts/")));
    assert_eq!(executed_as(&seen), None);

    // Control: the member's own org caller may disconnect its account.
    let outcome = run(&state, &ctx(false), &disconnect).await;
    assert!(outcome.is_ok(), "{outcome:?}");
    server.abort();
}

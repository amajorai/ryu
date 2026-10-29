use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

async fn readiness_fixture(
    forged_address: bool,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests_with_bearer = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&requests_with_bearer);
    let app = Router::new().fallback(any(move |request: Request<Body>| {
        let observed = Arc::clone(&observed);
        async move {
            let bearer = request
                .headers()
                .get("authorization")
                .and_then(|header| header.to_str().ok())
                .unwrap_or("");
            if !bearer.is_empty() {
                observed.fetch_add(1, Ordering::SeqCst);
            }
            let json = |value: serde_json::Value| axum::Json(value).into_response();
            match request.uri().path() {
                "/v1/auth/readiness" => {
                    let nonce = request
                        .uri()
                        .query()
                        .unwrap_or("")
                        .strip_prefix("nonce=")
                        .unwrap_or("");
                    let mut proof_address = address;
                    if forged_address {
                        proof_address.set_port(address.port().saturating_add(1));
                    }
                    let proof = ryu_gw_credentials::ReadinessProof::sign(
                        ryu_gw_credentials::Readiness {
                            protocol: "ryu-gateway-readiness-v1".into(),
                            version: env!("CARGO_PKG_VERSION").into(),
                            nonce: nonce.into(),
                            listener: proof_address,
                            require_auth: true,
                            inference_keys: vec![ryu_gw_credentials::fingerprint("relay")],
                            core_keys: vec![ryu_gw_credentials::fingerprint("core")],
                        },
                        "admin",
                    )
                    .unwrap();
                    json(serde_json::to_value(proof).unwrap())
                }
                "/v1/config" if bearer == "Bearer admin" => {
                    json(serde_json::json!({"auth":{"require_auth":true}}))
                }
                "/v1/auth/status" if bearer == "Bearer relay" || bearer == "Bearer core" => json(
                    serde_json::json!({"admin":false,"trustedForwarder":bearer == "Bearer core"}),
                ),
                _ => StatusCode::UNAUTHORIZED.into_response(),
            }
        }
    }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), requests_with_bearer, task)
}

#[tokio::test]
async fn managed_readiness_accepts_expected_listener_and_roles() {
    let (url, bearers, task) = readiness_fixture(false).await;
    let result = verify_managed_gateway(&url, "admin", "relay", "core").await;
    task.abort();
    result.unwrap();
    assert_eq!(bearers.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn managed_readiness_rejects_forwarded_or_fake_proof_before_sending_bearers() {
    let (url, bearers, task) = readiness_fixture(true).await;
    assert!(verify_managed_gateway(&url, "admin", "relay", "core")
        .await
        .is_err());
    task.abort();
    assert_eq!(bearers.load(Ordering::SeqCst), 0);
    let (url, bearers, task) = readiness_fixture(false).await;
    assert!(
        verify_managed_gateway(&url, "different-admin", "relay", "core")
            .await
            .is_err()
    );
    task.abort();
    assert_eq!(bearers.load(Ordering::SeqCst), 0);
}

#[test]
fn managed_provider_call_carries_the_authenticated_app_not_one_it_names() {
    // An app may put identity fields in its JSON; they do not deserialize
    // into the call, and Core writes its own.
    let call: ryu_app_events::ManagedProviderCall = serde_json::from_value(serde_json::json!({
        "provider": "treg",
        "toolId": "x.post.create",
        "method": "POST",
        "requestId": "req-1",
        "idempotencyKey": "k-1",
        "callerId": "@victim/app",
        "orgId": "org-victim",
        "providerPin": "treg",
        "requireServable": false,
        "agentId": "agent-victim",
        "userId": "user-victim",
        "sessionId": "session-victim"
    }))
    .expect("call");
    let facts = CoreCallFacts {
        org_id: Some("org-node"),
        caller_id: "@ryu/social",
        ..CoreCallFacts::default()
    };
    let body = managed_provider_call_body(call.clone(), &facts).unwrap();
    assert_eq!(body["callerId"], "@ryu/social");
    assert_eq!(body["orgId"], "org-node");
    assert_eq!(body["idempotencyKey"], "k-1");
    // Routing facts are Core's alone: an app cannot pin itself to Treg.
    for field in [
        "providerPin",
        "requireServable",
        "agentId",
        "userId",
        "sessionId",
    ] {
        assert!(body.get(field).is_none(), "{field}");
    }

    let pinned = CoreCallFacts {
        provider_pin: Some(crate::provider_pins::ProviderPin::Composio),
        require_servable: true,
        agent_id: Some("agent-1"),
        user_id: Some("user-1"),
        session_id: Some("session-1"),
        ..facts
    };
    let body = managed_provider_call_body(call, &pinned).unwrap();
    assert_eq!(body["providerPin"], "composio");
    assert_eq!(body["requireServable"], true);
    assert_eq!(body["agentId"], "agent-1");
    assert_eq!(body["userId"], "user-1");
    assert_eq!(body["sessionId"], "session-1");
    assert_eq!(
        body["provider"], "treg",
        "the app's provider is forwarded as is"
    );
}

/// The caller's cost ceiling reaches Gateway as a header, so it never
/// stays in the JSON body.
#[test]
fn managed_provider_call_cost_ceiling_is_carried_by_header_not_body() {
    let call: ryu_app_events::ManagedProviderCall = serde_json::from_value(serde_json::json!({
        "provider": "treg",
        "toolId": "x.post.create",
        "method": "POST",
        "requestId": "req-1",
        "maxCostMicroUsd": 25_000
    }))
    .expect("call");
    assert_eq!(call.max_cost_micro_usd, Some(25_000));
    let facts = CoreCallFacts {
        org_id: Some("org-node"),
        caller_id: "@ryu/social",
        ..CoreCallFacts::default()
    };
    let body = managed_provider_call_body(call, &facts).unwrap();
    assert!(body.get("maxCostMicroUsd").is_none(), "{body}");
    assert_eq!(MAX_COST_HEADER, "x-ryu-max-cost-micro-usd");
}

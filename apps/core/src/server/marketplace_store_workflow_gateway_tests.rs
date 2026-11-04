//! Simulated Gateway for the shipped marketplace workflow lifecycle test: the
//! readiness/auth control plane and a deterministic chat-completions endpoint.
//! No provider is contacted.
use axum::{
    extract::{OriginalUri, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) struct GatewayFixture {
    pub(super) requests: Arc<Mutex<Vec<serde_json::Value>>>,
    pub(super) mode: Arc<Mutex<String>>,
    pub(super) core_bearer: String,
    pub(super) admin: String,
    pub(super) relay: String,
    pub(super) address: Option<std::net::SocketAddr>,
    pub(super) control_requests: Arc<Mutex<Vec<String>>>,
}

pub(super) async fn gateway_control(
    State(fixture): State<GatewayFixture>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    fixture
        .control_requests
        .lock()
        .unwrap()
        .push(uri.path().to_string());
    match uri.path() {
        "/health" => Json(serde_json::json!({"status":"ok"})).into_response(),
        "/v1/auth/readiness" => {
            assert!(bearer.is_empty(), "readiness must not expose a bearer");
            let nonce = query.get("nonce").expect("readiness nonce");
            let signature = headers
                .get("x-ryu-readiness-proof")
                .unwrap()
                .to_str()
                .unwrap();
            ryu_gw_credentials::verify_readiness_request(nonce, signature, &fixture.admin).unwrap();
            let proof = ryu_gw_credentials::ReadinessProof::sign(
                ryu_gw_credentials::Readiness {
                    protocol: "ryu-gateway-readiness-v1".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    nonce: nonce.clone(),
                    listener: fixture.address.unwrap(),
                    require_auth: true,
                    inference_keys: vec![ryu_gw_credentials::fingerprint(&fixture.relay)],
                    core_keys: vec![ryu_gw_credentials::fingerprint(
                        fixture.core_bearer.strip_prefix("Bearer ").unwrap(),
                    )],
                },
                &fixture.admin,
            )
            .unwrap();
            Json(proof).into_response()
        }
        "/v1/config" if bearer == format!("Bearer {}", fixture.admin) => {
            Json(serde_json::json!({"auth":{"require_auth":true}})).into_response()
        }
        "/v1/auth/status" if bearer == format!("Bearer {}", fixture.relay) => {
            Json(serde_json::json!({"admin":false,"trustedForwarder":false})).into_response()
        }
        "/v1/auth/status" if bearer == fixture.core_bearer => {
            Json(serde_json::json!({"admin":false,"trustedForwarder":true})).into_response()
        }
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

pub(super) async fn completion(
    State(fixture): State<GatewayFixture>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> axum::response::Response {
    let relay_bearer = format!("Bearer {}", fixture.relay);
    let expected_bearer = if payload["messages"].as_array().unwrap().len() == 2 {
        fixture.core_bearer.as_str()
    } else {
        // Workflow prompt/skill nodes must use inference-only authority.
        // Clean-context delegation uses the distinct Core relay above.
        assert_ne!(fixture.core_bearer, relay_bearer);
        relay_bearer.as_str()
    };
    assert_eq!(
        headers.get("authorization").unwrap().to_str().unwrap(),
        expected_bearer
    );
    fixture.requests.lock().unwrap().push(payload.clone());
    let mode = fixture.mode.lock().unwrap().clone();
    if mode == "forbidden" {
        return (StatusCode::FORBIDDEN, "fixture policy denied").into_response();
    }
    if mode == "malformed" {
        return (StatusCode::OK, "invalid JSON").into_response();
    }
    let prompt = payload["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(
        !prompt.contains("{{"),
        "unresolved template sent to Gateway: {prompt}"
    );
    let text = if prompt.starts_with("Classify this request") {
        if mode == "alternate" {
            "general"
        } else {
            "billing"
        }
    } else if prompt.starts_with("Classify this into") {
        if mode == "alternate" {
            "research"
        } else {
            "code"
        }
    } else if prompt.starts_with("Here are independent verifier") {
        if mode == "alternate" {
            "FAIL"
        } else {
            "PASS"
        }
    } else if prompt.starts_with("Create exactly one autoresearch") {
        "CONTINUE:{\"campaign_id\":\"local-fixture\",\"goal\":\"fixture goal\"}"
    } else if prompt.starts_with("You are running at most ONE attempt") {
        "DONE:{\"campaign_id\":\"local-fixture\",\"goal\":\"fixture goal\"}"
    } else {
        "fixture-result"
    };
    Json(serde_json::json!({"choices":[{"message":{"content":text}}], "usage":{"total_tokens":1}}))
        .into_response()
}

pub(super) struct GatewayEnvironment(Vec<(&'static str, Option<String>)>);
impl GatewayEnvironment {
    pub(super) fn capture(keys: &[&'static str]) -> Self {
        Self(
            keys.iter()
                .map(|key| (*key, std::env::var(key).ok()))
                .collect(),
        )
    }
}
impl Drop for GatewayEnvironment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

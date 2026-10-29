//! Shipped Firewall through the exact production policy arm helper.
//! Store HTTP lifecycle and Gateway evaluator effects remain separate.

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

use super::firewall_policy_runtime::{
    config_response, ran_in_isolated_child, read_config_request, EnvOverride,
};

const FIREWALL_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/firewall/manifest.json");
const CHILD_ENV: &str = "RYU_CORE_FIREWALL_DISPATCH_FIXTURE_CHILD";
const TEST_NAME: &str =
    "shipped_firewall_dispatch_preserves_live_state_and_fails_closed_until_retry";

#[derive(Clone)]
struct FixtureState(Arc<tokio::sync::Mutex<FixtureData>>);

struct FixtureData {
    config: Value,
    requests: Vec<Value>,
    fail_next_get: bool,
    fail_next_put: bool,
    admin: String,
    relay: String,
    core: String,
    listener: std::net::SocketAddr,
    control_requests: Vec<Value>,
}

#[tokio::test]
async fn shipped_firewall_dispatch_preserves_live_state_and_fails_closed_until_retry() {
    // This fixture also checks the relay and Core keys, so their ambient
    // sources are removed too.
    let extra_removed = [
        "RYU_GATEWAY_TOKEN",
        "RYU_GATEWAY_CORE_TOKEN",
        "RYU_LOCAL_LLM_URL",
    ];
    if ran_in_isolated_child(CHILD_ENV, TEST_NAME, &extra_removed) {
        return;
    }

    // The isolated child never runs `main`; the managed Gateway's inference
    // bearer is sealed with the master key, which needs the crypto host.
    crate::crypto_host::install();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let initial_config = json!({
        "auth": { "require_auth": true },
        "firewall": {
            "enabled": false,
            "policy": "block",
            "locked_fields": ["policy", "inspector"],
            "inspector": { "enabled": true, "model": "fixture-judge" },
            "custom_patterns": [
                { "name": "operator-owned", "pattern": "keep this", "action": "block" }
            ],
            "request_limit": 17
        },
        "routing": { "smart_routing": { "enabled": true } },
        "fixture_metadata": { "owner": "operator" }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral local Gateway fixture");
    let address = listener.local_addr().expect("fixture address");
    let admin = crate::sidecar::gateway::gateway_admin_key().expect("isolated admin key");
    let relay = crate::sidecar::gateway::gateway_bearer().expect("isolated inference key");
    let core = crate::sidecar::gateway::required_gateway_core_token().expect("isolated Core key");
    assert_ne!(admin, relay);
    assert_ne!(admin, core);
    assert_ne!(relay, core);
    let state = FixtureState(Arc::new(tokio::sync::Mutex::new(FixtureData {
        config: initial_config.clone(),
        requests: Vec::new(),
        fail_next_get: false,
        fail_next_put: false,
        admin,
        relay,
        core,
        listener: address,
        control_requests: Vec::new(),
    })));
    let app = Router::new()
        .route("/health", get(gateway_control_fixture))
        .route("/v1/auth/readiness", get(gateway_control_fixture))
        .route("/v1/auth/status", get(gateway_control_fixture))
        .route(
            "/v1/config",
            get(gateway_config_fixture).put(gateway_config_fixture),
        )
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Gateway fixture");
    });
    let gateway_url = format!("http://127.0.0.1:{}", address.port());
    let _gateway_url = EnvOverride::set("RYU_GATEWAY_URL", &gateway_url);

    let manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        FIREWALL_MANIFEST,
        |path| Err(format!("unexpected code: {path}")),
    )
    .unwrap();
    let policies = super::super::manifest_policies(&manifest);
    let definition = &policies[0].definition;
    let client = reqwest::Client::new();
    let apply = super::super::apply_firewall_policy;
    // The real managed endpoint begins quarantined. Policy reads cannot send
    // credentials until the listener proves possession and separated roles.
    assert!(crate::sidecar::gateway::local_gateway_quarantined());
    assert!(!apply(&client, definition, true).await);
    assert!(state.0.lock().await.requests.is_empty());
    assert!(state.0.lock().await.control_requests.is_empty());
    let manager = crate::sidecar::gateway::GatewayManager::new();
    assert!(manager.start().await.expect("adopt authenticated fixture"));
    assert!(
        !manager.is_running(),
        "adoption must not spawn a Gateway child"
    );
    assert!(!crate::sidecar::gateway::local_gateway_quarantined());
    {
        let mut fixture = state.0.lock().await;
        assert_eq!(
            fixture
                .control_requests
                .iter()
                .map(|r| r["path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "/health",
                "/v1/auth/readiness",
                "/v1/auth/status",
                "/v1/auth/status",
                "/v1/auth/status"
            ]
        );
        assert_eq!(fixture.requests.len(), 2);
        assert_eq!(
            fixture.requests[0]["authorization"],
            format!("Bearer {}", fixture.admin)
        );
        assert_eq!(
            fixture.requests[1]["authorization"],
            format!("Bearer {}", fixture.relay)
        );
        assert!(fixture
            .requests
            .iter()
            .all(|request| request["method"] == "GET"));
        assert_eq!(
            fixture.config, initial_config,
            "readiness must not mutate config"
        );
        fixture.requests.clear();
    }
    let mut expected = initial_config.clone();
    expected["firewall"]["enabled"] = json!(true);
    assert!(apply(&client, definition, true).await);
    assert!(crate::sidecar::gateway_policy::firewall_enabled());
    assert_eq!(
        crate::sidecar::gateway::fetch_config(&client)
            .await
            .unwrap(),
        expected
    );
    assert!(apply(&client, definition, false).await);
    assert!(!crate::sidecar::gateway_policy::firewall_enabled());
    assert_eq!(
        crate::sidecar::gateway::fetch_config(&client)
            .await
            .unwrap(),
        initial_config
    );
    let puts_before = state
        .0
        .lock()
        .await
        .requests
        .iter()
        .filter(|r| r["method"] == "PUT")
        .count();
    state.0.lock().await.fail_next_get = true;
    assert!(!apply(&client, definition, true).await);
    assert!(crate::sidecar::gateway_policy::firewall_enabled());
    assert_eq!(state.0.lock().await.config, initial_config);
    for missing in [Value::Null, json!("invalid live firewall shape")] {
        state.0.lock().await.config["firewall"] = missing.clone();
        assert!(!apply(&client, definition, true).await);
        assert_eq!(state.0.lock().await.config["firewall"], missing);
    }
    assert_eq!(
        state
            .0
            .lock()
            .await
            .requests
            .iter()
            .filter(|r| r["method"] == "PUT")
            .count(),
        puts_before
    );
    {
        let mut fixture = state.0.lock().await;
        fixture.config = initial_config.clone();
        fixture.fail_next_put = true;
    }
    // True means a transport attempt, preserving apply_policy's notice contract;
    // the failed PUT must leave remote state unchanged.
    assert!(apply(&client, definition, true).await);
    assert_eq!(state.0.lock().await.config, initial_config);
    assert!(apply(&client, definition, true).await);
    assert_eq!(
        crate::sidecar::gateway::fetch_config(&client)
            .await
            .unwrap(),
        expected
    );
    assert!(apply(&client, definition, false).await);
    assert_eq!(
        crate::sidecar::gateway::fetch_config(&client)
            .await
            .unwrap(),
        initial_config
    );
    let requests = state.0.lock().await.requests.clone();
    let auth = requests[0]["authorization"].as_str().unwrap();
    assert!(auth.starts_with("Bearer gwadm_"));
    for request in &requests {
        assert_eq!(request["path"], "/v1/config");
        assert_eq!(request["authorization"], auth);
        if request["method"] == "PUT" {
            let enabled = request["body"]["firewall"]["enabled"].as_bool().unwrap();
            let mut expected_body = initial_config["firewall"].clone();
            expected_body["enabled"] = json!(enabled);
            assert_eq!(request["body"], json!({"firewall":expected_body}));
        }
    }
    server.abort();
    let _ = server.await;
}

async fn gateway_config_fixture(
    State(state): State<FixtureState>,
    request: Request<Body>,
) -> Response {
    let (method, body, record) = read_config_request(request).await;
    let mut fixture = state.0.lock().await;
    let authorized = record["authorization"] == format!("Bearer {}", fixture.admin);
    fixture.requests.push(record);
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let FixtureData {
        config,
        fail_next_get,
        fail_next_put,
        ..
    } = &mut *fixture;
    config_response(method, &body, config, fail_next_get, fail_next_put)
}

async fn gateway_control_fixture(
    State(state): State<FixtureState>,
    request: Request<Body>,
) -> Response {
    let mut fixture = state.0.lock().await;
    let path = request.uri().path();
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    fixture
        .control_requests
        .push(json!({ "path": path, "authorization": bearer }));
    match path {
        "/health" => {
            assert!(bearer.is_none());
            Json(json!({ "status": "ok" })).into_response()
        }
        "/v1/auth/readiness" => {
            assert!(bearer.is_none(), "readiness must precede bearer disclosure");
            let nonce = request
                .uri()
                .query()
                .and_then(|query| query.strip_prefix("nonce="))
                .expect("readiness nonce");
            assert_eq!(
                request
                    .headers()
                    .get("x-ryu-readiness-proof")
                    .and_then(|value| value.to_str().ok()),
                Some(
                    ryu_gw_credentials::readiness_request_signature(nonce, &fixture.admin)
                        .unwrap()
                        .as_str()
                )
            );
            let proof = ryu_gw_credentials::ReadinessProof::sign(
                ryu_gw_credentials::Readiness {
                    protocol: "ryu-gateway-readiness-v1".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    nonce: nonce.into(),
                    listener: fixture.listener,
                    require_auth: true,
                    inference_keys: vec![ryu_gw_credentials::fingerprint(&fixture.relay)],
                    core_keys: vec![ryu_gw_credentials::fingerprint(&fixture.core)],
                },
                &fixture.admin,
            )
            .expect("sign isolated listener readiness");
            Json(serde_json::to_value(proof).unwrap()).into_response()
        }
        "/v1/auth/status" if bearer == Some(format!("Bearer {}", fixture.relay).as_str()) => {
            Json(json!({ "admin": false, "trustedForwarder": false })).into_response()
        }
        "/v1/auth/status" if bearer == Some(format!("Bearer {}", fixture.core).as_str()) => {
            Json(json!({ "admin": false, "trustedForwarder": true })).into_response()
        }
        "/v1/auth/status" => StatusCode::UNAUTHORIZED.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

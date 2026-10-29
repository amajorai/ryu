//! Loopback proof for the shipped Gateway Firewall policy's config contract.
//!
//! The test parses the package manifest, then exercises Core's production
//! `fetch_config`, `build_firewall_patch`, and `push_config` seams against a
//! synthetic local Gateway. It never contacts a Gateway fleet or sends model
//! traffic through a firewall evaluator. The higher-level plugin lifecycle
//! dispatcher still has a separate boundary; its test reuses this file's
//! isolated-child, env, and `/v1/config` fixture helpers.

use axum::{
    body::Body,
    extract::State,
    http::{header, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::{ffi::OsString, sync::Arc};

const FIREWALL_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/firewall/manifest.json");
const CHILD_ENV: &str = "RYU_CORE_FIREWALL_POLICY_FIXTURE_CHILD";
const TEST_NAME: &str =
    "shipped_firewall_policy_drives_loopback_gateway_patch_and_recovers_from_errors";

#[derive(Clone)]
struct FixtureState(Arc<tokio::sync::Mutex<FixtureData>>);

struct FixtureData {
    config: Value,
    requests: Vec<Value>,
    fail_next_get: bool,
    fail_next_put: bool,
}

pub(super) struct EnvOverride {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvOverride {
    pub(super) fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvOverride {
    fn drop(&mut self) {
        if let Some(value) = self.previous.take() {
            std::env::set_var(self.key, value);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

/// Ambient Gateway credential and proxy sources an isolated child never sees.
const AMBIENT_ENV: [&str; 11] = [
    "RYU_MANAGED_NODE",
    "RYU_GATEWAY_REMOTE",
    "GATEWAY_MASTER_KEY",
    "GATEWAY_CONFIG",
    "GATEWAY_ADMIN_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// Re-run `test_name` in a fresh headless child process marked by `child_env`,
/// with the ambient sources (plus `extra_removed`) removed, and assert it
/// passed. The Gateway admin key is process-cached, so only the child runs the
/// fixture (this returns `false` there): Core then generates a synthetic local
/// admin key which the fixture can observe without real credentials.
pub(super) fn ran_in_isolated_child(
    child_env: &str,
    test_name: &str,
    extra_removed: &[&str],
) -> bool {
    if std::env::var_os(child_env).is_some() {
        return false;
    }
    let data_dir = tempfile::tempdir().expect("Firewall fixture data directory");
    let executable = std::env::current_exe().expect("Core test executable path");
    let mut child = std::process::Command::new(executable);
    child
        .args([test_name, "--nocapture"])
        .env(child_env, "1")
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env("RYU_DIR", data_dir.path())
        .env("RYU_GATEWAY_MANAGED", "1");
    for key in AMBIENT_ENV.iter().chain(extra_removed) {
        child.env_remove(key);
    }
    let status = child
        .status()
        .expect("start isolated Firewall Core test process");
    assert!(status.success(), "isolated Firewall test failed: {status}");
    true
}

#[tokio::test]
async fn shipped_firewall_policy_drives_loopback_gateway_patch_and_recovers_from_errors() {
    if ran_in_isolated_child(CHILD_ENV, TEST_NAME, &[]) {
        return;
    }

    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let initial_config = json!({
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
    let state = FixtureState(Arc::new(tokio::sync::Mutex::new(FixtureData {
        config: initial_config.clone(),
        requests: Vec::new(),
        fail_next_get: false,
        fail_next_put: false,
    })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral local Gateway fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
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
    assert!(crate::sidecar::gateway::local_gateway_quarantined());
    assert_eq!(
        crate::sidecar::gateway::gateway_url(),
        "http://127.0.0.1:0",
        "a configured address alone must not establish Gateway readiness"
    );
    // The fixture now represents a bound, ready managed Gateway. Production
    // normally publishes this transition through GatewayManager; this scoped
    // guard restores quarantine when the isolated runtime proof completes.
    let _ready_gateway = crate::sidecar::gateway::quarantine_for_test(false);
    assert_eq!(crate::sidecar::gateway::gateway_url(), gateway_url);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        FIREWALL_MANIFEST,
        |path| Err(format!("unexpected Firewall code file: {path}")),
    )
    .expect("Core parses and validates the shipped Firewall manifest");
    let policies = super::super::manifest_policies(&typed_manifest);
    assert_eq!(policies.len(), 1);
    assert_eq!(policies[0].policy_type, "firewall");
    assert_eq!(policies[0].definition["service"], "gateway");
    assert_eq!(typed_manifest.permission_grants, Vec::<String>::new());
    let bundle = super::super::FirewallPolicyBundle::from_definition(&policies[0].definition);

    let client = reqwest::Client::new();
    let live_before_enable = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect("read the live Gateway config before enabling Firewall");
    assert_eq!(live_before_enable, initial_config);
    let enabled_firewall =
        super::super::build_firewall_patch(live_before_enable["firewall"].clone(), true, &bundle);
    let mut expected_enabled_firewall = initial_config["firewall"].clone();
    expected_enabled_firewall["enabled"] = json!(true);
    assert_eq!(enabled_firewall, expected_enabled_firewall);

    let (enable_status, enable_body) =
        crate::sidecar::gateway::push_config(&client, &json!({ "firewall": enabled_firewall }))
            .await
            .expect("push the Firewall enable patch through Core's shared config transport");
    assert_eq!(enable_status, StatusCode::OK);
    assert_eq!(enable_body, json!({ "applied": true }));
    let enabled_readback = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect("read back the enabled Firewall config");
    assert_eq!(enabled_readback["firewall"], expected_enabled_firewall);
    assert_eq!(enabled_readback["routing"], initial_config["routing"]);
    assert_eq!(
        enabled_readback["fixture_metadata"],
        initial_config["fixture_metadata"]
    );

    let disabled_firewall =
        super::super::build_firewall_patch(enabled_readback["firewall"].clone(), false, &bundle);
    let mut expected_disabled_firewall = initial_config["firewall"].clone();
    expected_disabled_firewall["enabled"] = json!(false);
    assert_eq!(disabled_firewall, expected_disabled_firewall);
    let (disable_status, _) =
        crate::sidecar::gateway::push_config(&client, &json!({ "firewall": disabled_firewall }))
            .await
            .expect("push the Firewall disable patch through Core's shared config transport");
    assert_eq!(disable_status, StatusCode::OK);
    let disabled_readback = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect("read back the disabled Firewall config");
    assert_eq!(disabled_readback["firewall"], expected_disabled_firewall);

    {
        let mut fixture = state.0.lock().await;
        fixture.fail_next_get = true;
    }
    let get_error = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect_err("Core surfaces a failed live config read");
    assert!(get_error.to_string().contains("returned 503"));
    {
        let fixture = state.0.lock().await;
        assert_eq!(fixture.requests.last().unwrap()["method"], "GET");
        assert_eq!(
            fixture
                .requests
                .iter()
                .filter(|request| request["method"] == "PUT")
                .count(),
            2,
            "a failed GET causes no config PUT"
        );
    }

    // The next read succeeds, and a failed PUT reports the Gateway status without
    // changing its state. A deliberate retry uses the exact same Core patch and
    // then reads back the committed enabled state.
    let live_before_retry = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect("Gateway config read recovers after one fixture failure");
    let retry_firewall =
        super::super::build_firewall_patch(live_before_retry["firewall"].clone(), true, &bundle);
    {
        let mut fixture = state.0.lock().await;
        fixture.fail_next_put = true;
    }
    let (failed_put_status, failed_put_body) =
        crate::sidecar::gateway::push_config(&client, &json!({ "firewall": retry_firewall }))
            .await
            .expect("non-2xx Gateway config writes preserve their response envelope");
    assert_eq!(failed_put_status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        failed_put_body,
        json!({ "error": "fixture PUT unavailable" })
    );
    assert_eq!(
        crate::sidecar::gateway::fetch_config(&client)
            .await
            .unwrap()["firewall"],
        expected_disabled_firewall,
        "failed PUT does not change persisted Gateway state"
    );

    let retry_firewall =
        super::super::build_firewall_patch(expected_disabled_firewall.clone(), true, &bundle);
    let (retry_status, _) =
        crate::sidecar::gateway::push_config(&client, &json!({ "firewall": retry_firewall }))
            .await
            .expect("a deliberate retry succeeds against the local fixture");
    assert_eq!(retry_status, StatusCode::OK);
    let retry_readback = crate::sidecar::gateway::fetch_config(&client)
        .await
        .expect("read back the successful retry");
    expected_enabled_firewall["enabled"] = json!(true);
    assert_eq!(retry_readback["firewall"], expected_enabled_firewall);

    let requests = state.0.lock().await.requests.clone();
    let expected_methods = [
        "GET", "PUT", "GET", "PUT", "GET", "GET", "GET", "PUT", "GET", "PUT", "GET",
    ];
    assert_eq!(requests.len(), expected_methods.len());
    let admin_header = requests[0]["authorization"]
        .as_str()
        .expect("Core sends the local Gateway admin credential");
    assert!(
        admin_header.starts_with("Bearer gwadm_"),
        "the isolated child uses only a synthetic ephemeral Gateway admin key"
    );
    for (request, method) in requests.iter().zip(expected_methods) {
        assert_eq!(request["method"], method);
        assert_eq!(request["path"], "/v1/config");
        assert_eq!(request["authorization"], admin_header);
    }
    assert_eq!(
        requests[1]["body"]["firewall"],
        enabled_readback["firewall"]
    );
    assert_eq!(requests[3]["body"]["firewall"], expected_disabled_firewall);
    assert_eq!(requests[7]["body"]["firewall"], expected_enabled_firewall);
    assert_eq!(requests[9]["body"]["firewall"], expected_enabled_firewall);

    server.abort();
    let _ = server.await;
}

async fn gateway_config_fixture(
    State(state): State<FixtureState>,
    request: Request<Body>,
) -> Response {
    let (method, body, record) = read_config_request(request).await;
    let mut fixture = state.0.lock().await;
    let FixtureData {
        config,
        requests,
        fail_next_get,
        fail_next_put,
    } = &mut *fixture;
    requests.push(record);
    config_response(method, &body, config, fail_next_get, fail_next_put)
}

/// Read a `/v1/config` request into its method, its JSON body (`null` when
/// empty), and the `{ method, path, authorization, body }` record a fixture
/// keeps.
pub(super) async fn read_config_request(request: Request<Body>) -> (Method, Value, Value) {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Gateway fixture request body");
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("Core sends a JSON config patch")
    };
    let record = json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    (parts.method, body, record)
}

/// Answer a `/v1/config` request from `config`: a GET reads it and a PUT
/// replaces its `firewall` section; each `fail_next_*` flag fails one call.
pub(super) fn config_response(
    method: Method,
    body: &Value,
    config: &mut Value,
    fail_next_get: &mut bool,
    fail_next_put: &mut bool,
) -> Response {
    match method {
        Method::GET => {
            if std::mem::take(fail_next_get) {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "fixture GET unavailable" })),
                )
                    .into_response()
            } else {
                Json(config.clone()).into_response()
            }
        }
        Method::PUT => {
            if std::mem::take(fail_next_put) {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "fixture PUT unavailable" })),
                )
                    .into_response();
            }
            if let Some(firewall) = body.get("firewall") {
                config["firewall"] = firewall.clone();
            }
            (StatusCode::OK, Json(json!({ "applied": true }))).into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

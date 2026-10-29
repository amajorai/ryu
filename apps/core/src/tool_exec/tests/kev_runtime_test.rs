//! Runtime contract proof for Kev's shipped System One HTTP tools.
//!
//! Core parses the actual Kev manifest and dispatches both runnables through
//! `run_http_tool` against an ephemeral loopback fixture. The fixture is not a Kev
//! server and no real API key is used.

use super::*;
use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const KEV_MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/kev/manifest.json");

#[tokio::test]
async fn shipped_kev_runnables_preserve_keyless_http_contract_and_errors() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        KEV_MANIFEST,
        |path| Err(format!("Kev declares unexpected code file: {path}")),
    )
    .expect("Core parses and validates Kev's shipped manifest");
    assert_eq!(typed_manifest.runnables.len(), 2);
    assert!(typed_manifest.code_file_refs().is_empty());

    let manifest: serde_json::Value =
        serde_json::from_str(KEV_MANIFEST).expect("valid Kev manifest JSON");
    assert_eq!(manifest["id"], "@ryu/kev");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:127.0.0.1"])
    );
    assert!(manifest.get("contributes").is_none());
    let models = runnable_config(&manifest, "kev.models");
    let predict = runnable_config(&manifest, "kev.predict");
    assert_http_config(models, "http://127.0.0.1:8009/v1/models", "GET");
    assert_http_config(predict, "http://127.0.0.1:8009/v1/systemone", "POST");
    assert!(models.get("secret_headers").is_none());
    assert!(predict.get("secret_headers").is_none());
    assert_eq!(
        predict["body_defaults"],
        serde_json::json!({ "model": "kev-latest" })
    );
    assert_eq!(
        predict["input_schema"]["required"],
        serde_json::json!(["state", "questions"])
    );

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Kev fixture");
    let address = listener.local_addr().expect("Kev fixture address");
    let app = Router::new()
        .route("/v1/models", get(kev_models_fixture))
        .route("/v1/systemone", post(kev_systemone_fixture))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve ephemeral Kev fixture");
    });

    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);
    let denied = run_kev_manifest_tool(
        &manifest,
        "kev.models",
        serde_json::json!({}),
        address.port(),
        &std::collections::HashSet::new(),
    )
    .await
    .expect_err("Core must deny an ungranted fixture before making a request");
    assert!(denied.contains("http egress to '127.0.0.1' is not granted"));
    assert!(
        observed.lock().await.is_empty(),
        "grant denial performs no I/O"
    );

    let models_result = run_kev_manifest_tool(
        &manifest,
        "kev.models",
        serde_json::json!({}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("the keyless models request reaches the fixture");
    assert_eq!(
        models_result,
        serde_json::json!({ "data": [{ "id": "kev-latest", "loaded": true }] }),
        "GET unwraps the successful System One models response"
    );

    let default_prediction = run_kev_manifest_tool(
        &manifest,
        "kev.predict",
        serde_json::json!({
            "state": "default model request",
            "questions": { "priority": { "type": "choice", "options": ["low", "high"] } }
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default Kev prediction reaches the fixture");
    assert_eq!(
        default_prediction,
        serde_json::json!({ "decisions": { "priority": { "high": 0.91, "low": 0.09 } } }),
        "POST unwraps a successful System One decision body"
    );

    let overridden_prediction = run_kev_manifest_tool(
        &manifest,
        "kev.predict",
        serde_json::json!({
            "state": "model override request",
            "questions": { "safe": { "type": "noul" } },
            "model": "kev-test-alias"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("model override prediction reaches the fixture");
    assert_eq!(
        overridden_prediction,
        serde_json::json!({ "decisions": { "safe": { "yes": 0.97, "no": 0.03 } } })
    );

    let auth_failure = run_kev_manifest_tool(
        &manifest,
        "kev.predict",
        serde_json::json!({
            "state": "fixture-auth-failure",
            "questions": { "safe": { "type": "noul" } }
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("non-2xx HTTP responses remain visible to the caller");
    assert_eq!(
        auth_failure,
        serde_json::json!({ "status": 401, "body": { "error": "fixture unauthorized" } })
    );

    let upstream_failure = run_kev_manifest_tool(
        &manifest,
        "kev.predict",
        serde_json::json!({
            "state": "fixture-upstream-failure",
            "questions": { "safe": { "type": "noul" } }
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("503 responses are not retried or converted to success");
    assert_eq!(
        upstream_failure,
        serde_json::json!({ "status": 503, "body": { "error": "fixture unavailable" } })
    );

    let requests = observed.lock().await.clone();
    assert_eq!(
        serde_json::to_value(&requests).expect("serialize captured request records"),
        serde_json::json!([
            {
                "method": "GET",
                "path": "/v1/models",
                "authorization": null,
                "body": null
            },
            {
                "method": "POST",
                "path": "/v1/systemone",
                "authorization": null,
                "body": {
                    "model": "kev-latest",
                    "state": "default model request",
                    "questions": { "priority": { "type": "choice", "options": ["low", "high"] } }
                }
            },
            {
                "method": "POST",
                "path": "/v1/systemone",
                "authorization": null,
                "body": {
                    "model": "kev-test-alias",
                    "state": "model override request",
                    "questions": { "safe": { "type": "noul" } }
                }
            },
            {
                "method": "POST",
                "path": "/v1/systemone",
                "authorization": null,
                "body": {
                    "model": "kev-latest",
                    "state": "fixture-auth-failure",
                    "questions": { "safe": { "type": "noul" } }
                }
            },
            {
                "method": "POST",
                "path": "/v1/systemone",
                "authorization": null,
                "body": {
                    "model": "kev-latest",
                    "state": "fixture-upstream-failure",
                    "questions": { "safe": { "type": "noul" } }
                }
            }
        ]),
        "each runnable sends one exact request and no 401/503 retry occurs"
    );

    let transport_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral transport-failure fixture");
    let transport_port = transport_listener.local_addr().unwrap().port();
    let transport_attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_server = transport_attempts.clone();
    let transport_server = tokio::spawn(async move {
        loop {
            let (socket, _) = transport_listener
                .accept()
                .await
                .expect("accept transport-failure probe");
            attempts_for_server.fetch_add(1, Ordering::SeqCst);
            drop(socket);
        }
    });
    let transport_error = run_kev_manifest_tool(
        &manifest,
        "kev.predict",
        serde_json::json!({
            "state": "fixture-transport-failure",
            "questions": { "safe": { "type": "noul" } }
        }),
        transport_port,
        &local_grants,
    )
    .await
    .expect_err("fail_open=false surfaces transport failures");
    assert!(transport_error.contains("http tool request failed:"));
    assert_eq!(
        transport_attempts.load(Ordering::SeqCst),
        1,
        "Core transport errors are not retried"
    );
    transport_server.abort();
    let _ = transport_server.await;

    server.abort();
    let _ = server.await;
}

async fn kev_models_fixture(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<serde_json::Value>>>>,
    headers: HeaderMap,
) -> Response {
    observed.lock().await.push(serde_json::json!({
        "method": "GET",
        "path": "/v1/models",
        "authorization": headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": null
    }));
    (
        StatusCode::OK,
        Json(serde_json::json!({ "data": [{ "id": "kev-latest", "loaded": true }] })),
    )
        .into_response()
}

async fn kev_systemone_fixture(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<serde_json::Value>>>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    observed.lock().await.push(serde_json::json!({
        "method": "POST",
        "path": "/v1/systemone",
        "authorization": headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    }));
    let (status, response) = match body["state"].as_str() {
        Some("fixture-auth-failure") => (
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "fixture unauthorized" }),
        ),
        Some("fixture-upstream-failure") => (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "fixture unavailable" }),
        ),
        Some("model override request") => (
            StatusCode::OK,
            serde_json::json!({ "decisions": { "safe": { "yes": 0.97, "no": 0.03 } } }),
        ),
        _ => (
            StatusCode::OK,
            serde_json::json!({ "decisions": { "priority": { "high": 0.91, "low": 0.09 } } }),
        ),
    };
    (status, Json(response)).into_response()
}

fn assert_http_config(config: &serde_json::Value, expected_url: &str, expected_method: &str) {
    assert_eq!(config["backend"], "http");
    assert_eq!(config["url"], expected_url);
    assert_eq!(config["method"], expected_method);
    assert_eq!(config["fail_open"], false);
    assert_eq!(config["unwrap_body"], true);
}

fn runnable_config<'a>(manifest: &'a serde_json::Value, slug: &str) -> &'a serde_json::Value {
    manifest["runnables"]
        .as_array()
        .and_then(|runnables| {
            runnables
                .iter()
                .find(|runnable| runnable["config"]["slug"] == slug)
        })
        .map(|runnable| &runnable["config"])
        .unwrap_or_else(|| panic!("Kev manifest is missing {slug}"))
}

async fn run_kev_manifest_tool(
    manifest: &serde_json::Value,
    slug: &str,
    args: serde_json::Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<serde_json::Value, String> {
    let config = runnable_config(manifest, slug);
    let tool_config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(config.clone()).map_err(|error| error.to_string())?;
    let crate::plugin_manifest::schema::ToolBackend::Http {
        url,
        method,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        ..
    } = tool_config
        .resolve_backend()
        .map_err(|error| format!("{slug} HTTP backend: {error}"))?
    else {
        return Err(format!("{slug} did not resolve to an HTTP backend"));
    };
    let mut local_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    assert_eq!(local_url.host_str(), Some("127.0.0.1"));
    local_url
        .set_port(Some(local_port))
        .map_err(|_| "Kev URL port could not be replaced".to_owned())?;

    super::super::run_http_tool(
        local_url.as_str(),
        &method,
        args,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        local_grants,
        &[],
        "@ryu/kev",
        None,
    )
    .await
}

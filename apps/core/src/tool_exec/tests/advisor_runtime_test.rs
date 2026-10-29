//! Runtime contract proof for Advisor's shipped declarative HTTP tool.
//!
//! Core parses the actual Advisor manifest and sends the tool's `core:` URL
//! through `run_http_tool`. The Core scheme is bound to an ephemeral 127.0.0.1
//! fixture for this test; no provider, Gateway, production token, or external
//! service is contacted.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{collections::HashSet, sync::Arc};

const ADVISOR_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/advisor/manifest.json");
const TEST_NODE_TOKEN: &str = "4e9d1a72b5c84f038c016d32a67ef0419d7bc426f1058e3a7d94c2f6018ab35e";
const ISOLATED_CHILD_ENV: &str = "RYU_CORE_ADVISOR_FIXTURE_CHILD";

#[tokio::test]
async fn shipped_advisor_tool_reaches_core_http_runtime_and_preserves_contracts() {
    if std::env::var_os(ISOLATED_CHILD_ENV).is_none() {
        let data_dir = tempfile::tempdir().expect("Advisor fixture data directory");
        let executable = std::env::current_exe().expect("Core test executable path");
        let status = std::process::Command::new(executable)
			.args([
				"--exact",
				"tool_exec::tests::advisor_runtime::shipped_advisor_tool_reaches_core_http_runtime_and_preserves_contracts",
				"--nocapture",
			])
			.env(ISOLATED_CHILD_ENV, "1")
			.env("RYU_PROFILE", "dev")
			.env("RYU_KEYCHAIN", "off")
			.env("RYU_DIR", data_dir.path())
			.env("RYU_TOKEN", TEST_NODE_TOKEN)
			.status()
			.expect("start isolated Advisor Core test process");
        assert!(status.success(), "isolated Advisor test failed: {status}");
        return;
    }

    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Advisor loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/api/advisor/consult", post(advisor_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Advisor fixture");
    });
    let bind = format!("127.0.0.1:{}", address.port());
    let _core_bind = super::EnvOverride::set("RYU_BIND", &bind);
    let _node_token = super::EnvOverride::set("RYU_TOKEN", TEST_NODE_TOKEN);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        ADVISOR_MANIFEST,
        |path| match path {
            "hooks/review.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/advisor/hooks/review.js"
            )
            .to_owned()),
            other => Err(format!("unexpected Advisor code file: {other}")),
        },
    )
    .expect("Core parses, hydrates, and validates the shipped Advisor manifest");
    assert_eq!(typed_manifest.runnables.len(), 1);
    assert!(typed_manifest.code_file_refs().is_empty());

    let manifest: Value = serde_json::from_str(ADVISOR_MANIFEST).expect("valid Advisor JSON");
    assert_eq!(manifest["id"], "@ryu/advisor");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["hook:side-model", "tool:http-egress:127.0.0.1"])
    );
    let config = runnable_config(&manifest, "advisor.consult");
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "POST");
    assert_eq!(config["url"], "core:/api/advisor/consult");
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_TOKEN"
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);

    let tool_config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(config.clone()).expect("Core parses Advisor ToolConfig");
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
        .expect("Core resolves Advisor HTTP backend")
    else {
        panic!("advisor.consult must resolve to Core's HTTP backend");
    };
    assert_eq!(url, "core:/api/advisor/consult");
    assert_eq!(method, "POST");
    assert!(header_params.is_empty());
    assert!(
        body_defaults.is_null(),
        "Advisor declares no tool-level defaults"
    );
    assert_eq!(
        secret_headers.get("Authorization").map(String::as_str),
        Some("Bearer env:RYU_TOKEN")
    );
    assert!(fail_open);
    assert!(unwrap_body);

    let local_grants = grants(&["tool:http-egress:127.0.0.1"]);
    let question = "Should the retry be bounded?";
    let success = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({
            "question": question,
            "context": "The caller supplied the relevant plan.",
            "model": "fixture-advisor"
        }),
    )
    .await
    .expect("explicit question, context, and model reach only the loopback fixture");
    assert_eq!(
        success,
        serde_json::json!({
            "ok": true,
            "model": "fixture-advisor",
            "advice": "Use bounded retries and keep the last error."
        })
    );

    let optional_omitted = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({"question": "What is the next step?"}),
    )
    .await
    .expect("the required question works without optional context or model");
    assert_eq!(
        optional_omitted,
        serde_json::json!({
            "ok": true,
            "model": "fixture-default",
            "advice": "Fixture advice."
        })
    );

    let soft_failure = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({"question": "fixture-no-advice"}),
    )
    .await
    .expect("an endpoint-level soft failure is unwrapped verbatim");
    assert_eq!(
        soft_failure,
        serde_json::json!({
            "ok": false,
            "model": "fixture-advisor",
            "error": "the advisor model returned no advice"
        })
    );

    let request_count_before_rejection = observed.lock().await.len();
    let denied_grants = HashSet::new();
    let denied = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &denied_grants,
        serde_json::json!({"question": "must not be sent"}),
    )
    .await
    .expect_err("Core refuses calls without the plugin's loopback egress grant");
    assert!(denied.contains("tool:http-egress:127.0.0.1"), "{denied}");
    assert_eq!(
        observed.lock().await.len(),
        request_count_before_rejection,
        "grant denial must happen before network I/O"
    );

    let unauthorized = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({"question": "fixture-unauthorized"}),
    )
    .await
    .expect("401 is converted by the manifest's fail-open contract");
    assert_eq!(
        unauthorized,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let unavailable = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({"question": "fixture-unavailable"}),
    )
    .await
    .expect("non-auth server failures preserve the status/body envelope");
    assert_eq!(
        unavailable,
        serde_json::json!({
            "status": 503,
            "body": {"error": "fixture service unavailable"}
        })
    );

    let requests = observed.lock().await.clone();
    let local_host = format!("127.0.0.1:{}", address.port());
    assert_eq!(
        requests.len(),
        5,
        "Core sends one request per allowed call, with no retry"
    );
    assert_eq!(
        requests[0],
        serde_json::json!({
            "method": "POST",
            "path": "/api/advisor/consult",
            "query": null,
            "host": local_host,
            "content_type": "application/json",
            "authorization": format!("Bearer {TEST_NODE_TOKEN}"),
            "body": {
                "question": question,
                "context": "The caller supplied the relevant plan.",
                "model": "fixture-advisor"
            }
        })
    );
    assert_eq!(
        requests[1]["body"],
        serde_json::json!({"question": "What is the next step?"}),
        "optional fields stay omitted and no tool-level body defaults are injected"
    );
    assert_eq!(
        requests[2]["body"],
        serde_json::json!({"question": "fixture-no-advice"})
    );
    assert_eq!(
        requests[3]["body"],
        serde_json::json!({"question": "fixture-unauthorized"})
    );
    assert_eq!(
        requests[4]["body"],
        serde_json::json!({"question": "fixture-unavailable"})
    );
    assert!(requests.iter().all(|request| {
        request["authorization"] == format!("Bearer {TEST_NODE_TOKEN}")
            && !request["body"].to_string().contains(TEST_NODE_TOKEN)
    }));

    server.abort();
    let _ = server.await;
    let transport_error = call_advisor_tool(
        &url,
        &method,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({"question": "fixture-transport-error"}),
    )
    .await
    .expect("transport failures remain fail-open for this tool");
    assert_eq!(transport_error["available"], false);
    assert!(transport_error["reason"]
        .as_str()
        .is_some_and(|reason| reason.starts_with("endpoint not reachable:")));
    assert_eq!(observed.lock().await.len(), requests.len());
}

fn runnable_config<'a>(manifest: &'a Value, slug: &str) -> &'a Value {
    manifest["runnables"]
        .as_array()
        .expect("manifest has a runnables array")
        .iter()
        .find(|runnable| runnable["config"]["slug"] == slug)
        .map(|runnable| &runnable["config"])
        .unwrap_or_else(|| panic!("manifest does not declare {slug}"))
}

#[allow(clippy::too_many_arguments)]
async fn call_advisor_tool(
    url: &str,
    method: &str,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &HashSet<String>,
    args: Value,
) -> Result<Value, String> {
    super::super::run_http_tool(
        url,
        method,
        args,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        &[],
        "@ryu/advisor",
        None,
    )
    .await
}

async fn advisor_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Advisor fixture request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Advisor sends JSON request bodies");
    let path = parts.uri.path().to_owned();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": path,
        "query": parts.uri.query(),
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "content_type": parts.headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    let response = match record["body"]["question"].as_str().unwrap_or_default() {
        "fixture-no-advice" => serde_json::json!({
            "ok": false,
            "model": "fixture-advisor",
            "error": "the advisor model returned no advice"
        }),
        "fixture-unauthorized" => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "fixture rejected token"})),
            )
                .into_response();
        }
        "fixture-unavailable" => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "fixture service unavailable"})),
            )
                .into_response();
        }
        "" => serde_json::json!({
            "ok": false,
            "error": "missing required field 'question'"
        }),
        question => serde_json::json!({
            "ok": true,
            "model": record["body"]["model"].as_str().unwrap_or("fixture-default"),
            "advice": if question == "Should the retry be bounded?" {
                "Use bounded retries and keep the last error."
            } else {
                "Fixture advice."
            }
        }),
    };
    (StatusCode::OK, Json(response)).into_response()
}

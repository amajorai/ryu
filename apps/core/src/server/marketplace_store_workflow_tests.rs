//! Real shipped ZIP installation, portable activation, and production DAG execution.
//! The simulated boundary is Gateway HTTP readiness/auth/model output; no provider is contacted.
use super::*;
use crate::workflow::store::{NodeStatus, RunStatus};
use axum::{
    extract::{OriginalUri, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct GatewayFixture {
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    mode: Arc<Mutex<String>>,
    core_bearer: String,
    admin: String,
    relay: String,
    address: Option<std::net::SocketAddr>,
    control_requests: Arc<Mutex<Vec<String>>>,
}

async fn gateway_control(
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

async fn completion(
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

fn shipped_archive(dir: &Path) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for name in ["ryu.package.json", "workflow.json"] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&std::fs::read(dir.join(name)).unwrap())
            .unwrap();
    }
    zip.finish().unwrap().into_inner()
}

struct GatewayEnvironment(Vec<(&'static str, Option<String>)>);
impl GatewayEnvironment {
    fn capture(keys: &[&'static str]) -> Self {
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

#[tokio::test]
async fn marketplace_store_workflow_all_shipped_zip_lifecycles_execute_and_read_back() {
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _environment = GatewayEnvironment::capture(&[
        "RYU_GATEWAY_URL",
        "RYU_GATEWAY_TOKEN",
        "RYU_GATEWAY_MANAGED",
        "RYU_GATEWAY_REMOTE",
        "RYU_MANAGED_NODE",
        "GATEWAY_MASTER_KEY",
        "RYU_ALLOW_GATEWAY_FALLBACK",
    ]);
    let _quarantine = crate::sidecar::gateway::quarantine_for_test(true);
    std::env::set_var("RYU_GATEWAY_MANAGED", "1");
    std::env::set_var("RYU_GATEWAY_REMOTE", "0");
    std::env::set_var("RYU_MANAGED_NODE", "0");
    std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "0");
    let admin = "gwadm_marketplace_fixture_0123456789abcdef".to_string();
    let relay = "gwrelay_0123456789abcdef0123456789abcdef".to_string();
    std::env::set_var("GATEWAY_MASTER_KEY", &admin);
    std::env::set_var("RYU_GATEWAY_TOKEN", &relay);
    assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
    assert!(
        crate::agents::global().is_none(),
        "run this scoped fixture in an isolated process"
    );
    assert!(crate::sidecar::agent_runner::global_agent_runner().is_none());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture = GatewayFixture {
        core_bearer: format!(
            "Bearer {}",
            crate::sidecar::gateway::required_gateway_core_token().unwrap()
        ),
        admin,
        relay,
        address: Some(address),
        ..GatewayFixture::default()
    };
    let router = Router::new()
        .route("/v1/chat/completions", post(completion))
        .route("/health", get(gateway_control))
        .route("/v1/auth/readiness", get(gateway_control))
        .route("/v1/config", get(gateway_control))
        .route("/v1/auth/status", get(gateway_control))
        .with_state(fixture.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    std::env::set_var("RYU_GATEWAY_URL", format!("http://{address}"));
    assert_eq!(crate::sidecar::gateway::gateway_url(), "http://127.0.0.1:0");
    let manager = crate::sidecar::gateway::GatewayManager::new();
    assert!(manager.start().await.unwrap());
    assert!(
        !manager.is_running(),
        "fixture adoption must not spawn a Gateway"
    );
    assert_eq!(
        crate::sidecar::gateway::gateway_url(),
        format!("http://{address}")
    );
    assert_eq!(
        *fixture.control_requests.lock().unwrap(),
        [
            "/health",
            "/v1/auth/readiness",
            "/v1/config",
            "/v1/auth/status",
            "/v1/auth/status",
            "/v1/auth/status",
            "/v1/config",
        ]
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../marketplace-store/workflows");
    let mut directories: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect();
    directories.sort();
    assert_eq!(directories.len(), 13);
    for dir in directories {
        let template: crate::workflow::templates::WorkflowTemplate =
            serde_json::from_slice(&std::fs::read(dir.join("workflow.json")).unwrap()).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("ryu.package.json")).unwrap()).unwrap();
        let id = manifest["id"].as_str().unwrap();
        let installed = crate::portable_packages::install(
            "workflow",
            id,
            &shipped_archive(&dir),
            None,
            None,
            manifest["version"].as_str(),
            false,
        )
        .unwrap();
        assert!(!installed.enabled);
        assert!(
            enable_workflow("workflow", id, &installed, &BTreeMap::new())
                .await
                .unwrap_err()
                .to_string()
                .contains("missing workflow.json")
        );
        assert!(
            !crate::portable_packages::get("workflow", id)
                .unwrap()
                .unwrap()
                .enabled
        );
        let files = crate::portable_packages::artifact_files("workflow", id).unwrap();
        assert_eq!(
            files["workflow.json"],
            std::fs::read(dir.join("workflow.json")).unwrap()
        );
        let active = enable_workflow("workflow", id, &installed, &files)
            .await
            .unwrap();
        assert_eq!(active.runtime_ids.len(), template.bodies.len() + 1, "{id}");
        assert_eq!(
            enable_workflow("workflow", id, &active, &files)
                .await
                .unwrap()
                .runtime_ids,
            active.runtime_ids
        );
        let workflow = crate::workflow::store::load_workflow(&active.runtime_ids[0]).unwrap();
        assert_eq!(workflow.name, template.primary.name);
        for node in &workflow.nodes {
            if let crate::workflow::NodeKind::While {
                body_workflow_id: Some(body),
                ..
            } = &node.kind
            {
                assert!(active.runtime_ids.contains(body));
                crate::workflow::store::load_workflow(body).unwrap();
            }
        }
        let modes: &[&str] = if matches!(
            template.meta.id.as_str(),
            "routing" | "classify-and-act" | "adversarial-verification"
        ) {
            &["normal", "alternate"]
        } else {
            &["normal"]
        };
        for mode in modes {
            *fixture.mode.lock().unwrap() = mode.to_string();
            fixture.requests.lock().unwrap().clear();
            let run_id = format!(
                "marketplace-{}-{}-{}",
                template.meta.id,
                mode,
                uuid::Uuid::new_v4()
            );
            let input = HashMap::from([("input".to_string(), "fixture goal".to_string())]);
            let run =
                crate::workflow::executor::run_workflow(&workflow, input.clone(), run_id.clone())
                    .await
                    .unwrap();
            assert_eq!(run.status, RunStatus::Completed, "{id}: {:?}", run.error);
            let expected = if template.meta.id == "adversarial-verification" && *mode == "normal" {
                "true"
            } else {
                "fixture-result"
            };
            assert_eq!(
                run.output.get("result").map(String::as_str),
                Some(expected),
                "{id}/{mode}"
            );
            let saved = crate::workflow::store::load_run(&run_id).unwrap();
            assert_eq!(saved.output, run.output);
            assert_eq!(saved.input, input);
            assert_eq!(saved.status, RunStatus::Completed);
            let calls = fixture.requests.lock().unwrap();
            let expected_calls = match template.meta.id.as_str() {
                "prompt-chaining" | "autoresearch" => 3,
                "routing" | "classify-and-act" => 2,
                "orchestrator-workers" | "tournament" => 5,
                "adversarial-verification" => {
                    if *mode == "normal" {
                        5
                    } else {
                        6
                    }
                }
                "autonomous-agent" => 8,
                "evaluator-optimizer" => 4,
                // 7 prompts + 2 writers'-room passes x 2 + 4 departments + production + editor.
                "video-drama-studio" => 17,
                _ => 4,
            };
            assert_eq!(calls.len(), expected_calls, "{id}/{mode}");
            for call in calls.iter() {
                assert_eq!(call["stream"], false);
                if call["messages"].as_array().unwrap().len() == 2 {
                    let system = call["messages"][0]["content"].as_str().unwrap();
                    assert!(system.contains("permission preset"));
                    assert!(system.contains("Allowed tools:"));
                }
            }
            if template.meta.id == "routing" {
                assert_eq!(
                    saved.nodes[if *mode == "normal" {
                        "other"
                    } else {
                        "billing"
                    }]
                    .status,
                    NodeStatus::Skipped
                );
            }
            if template.meta.id == "classify-and-act" {
                assert_eq!(
                    saved.nodes[if *mode == "normal" {
                        "researcher"
                    } else {
                        "coder"
                    }]
                    .status,
                    NodeStatus::Skipped
                );
            }
        }
        if template.meta.id == "prompt-chaining" {
            for mode in ["forbidden", "malformed"] {
                *fixture.mode.lock().unwrap() = mode.to_string();
                fixture.requests.lock().unwrap().clear();
                let run_id = format!("marketplace-error-{}", uuid::Uuid::new_v4());
                let outcome = crate::workflow::executor::run_workflow(
                    &workflow,
                    HashMap::from([("input".to_string(), "fixture goal".to_string())]),
                    run_id.clone(),
                )
                .await;
                let saved = crate::workflow::store::load_run(&run_id).unwrap();
                assert_eq!(saved.status, RunStatus::Failed);
                let error = saved
                    .error
                    .clone()
                    .or_else(|| outcome.err())
                    .unwrap_or_default();
                assert!(
                    error.contains(if mode == "forbidden" {
                        "403"
                    } else {
                        "invalid gateway response"
                    }),
                    "{error}"
                );
                assert_eq!(saved.nodes["outline"].status, NodeStatus::Failed);
                assert!(saved.output.is_empty());
                assert_eq!(
                    fixture.requests.lock().unwrap().len(),
                    1,
                    "{mode} must stop before any successor model call"
                );
            }
        }
        let disabled = disable_workflow("workflow", id).await.unwrap();
        assert!(!disabled.enabled);
        for runtime_id in &active.runtime_ids {
            assert!(crate::workflow::store::load_workflow(runtime_id).is_err());
        }
        let reenabled = enable_workflow("workflow", id, &disabled, &files)
            .await
            .unwrap();
        assert_ne!(reenabled.runtime_ids, active.runtime_ids);
        disable_workflow("workflow", id).await.unwrap();
        crate::portable_packages::uninstall("workflow", id).unwrap();
        assert!(crate::portable_packages::get("workflow", id)
            .unwrap()
            .is_none());
    }
    server.abort();
}

#[tokio::test]
async fn marketplace_store_workflow_raw_compatibility_and_invalid_templates_are_atomic() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../marketplace-store/workflows/prompt-chaining");
    let template: crate::workflow::templates::WorkflowTemplate =
        serde_json::from_slice(&std::fs::read(source.join("workflow.json")).unwrap()).unwrap();
    let mut original = template.primary.clone();
    original.id = format!("marketplace-existing-{}", uuid::Uuid::new_v4());
    let original = crate::workflow::persist_workflow(original).await.unwrap();
    let original_bytes = serde_json::to_value(&original).unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let id = "fixture/marketplace-workflow-compatibility";
    std::fs::write(
        fixture.path().join("ryu.package.json"),
        serde_json::to_vec(
            &serde_json::json!({"schemaVersion":1,"kind":"workflow","id":id,
        "name":"Fixture","version":"1.0.0","artifacts":["workflow.json"],"targets":["ryu-desktop"],"scopes":["workflow"]}),
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        fixture.path().join("workflow.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    let package = crate::portable_packages::install(
        "workflow",
        id,
        &shipped_archive(fixture.path()),
        None,
        None,
        Some("1.0.0"),
        false,
    )
    .unwrap();
    let files = crate::portable_packages::artifact_files("workflow", id).unwrap();
    let enabled = enable_workflow("workflow", id, &package, &files)
        .await
        .unwrap();
    assert_eq!(enabled.runtime_ids.len(), 1);
    assert_ne!(enabled.runtime_ids[0], original.id);
    assert_eq!(
        serde_json::to_value(crate::workflow::store::load_workflow(&original.id).unwrap()).unwrap(),
        original_bytes
    );
    disable_workflow("workflow", id).await.unwrap();
    crate::portable_packages::uninstall("workflow", id).unwrap();
    assert!(crate::workflow::store::load_workflow(&original.id).is_ok());

    let mut duplicate = template.clone();
    duplicate.bodies = vec![
        ("body".into(), original.clone()),
        ("body".into(), original.clone()),
    ];
    let mut invalid_graph = template.clone();
    invalid_graph.bodies = vec![("body".into(), original.clone())];
    invalid_graph
        .primary
        .nodes
        .push(invalid_graph.primary.nodes[0].clone());
    for (artifact, expected_error) in [
        (b"invalid json".to_vec(), "portable workflow is invalid"),
        (
            serde_json::to_vec(&duplicate).unwrap(),
            "duplicate workflow body 'body'",
        ),
        (
            serde_json::to_vec(&invalid_graph).unwrap(),
            "duplicate node id",
        ),
    ] {
        let baseline: std::collections::BTreeSet<_> = crate::workflow::store::list_workflows()
            .into_iter()
            .map(|workflow| workflow.id)
            .collect();
        std::fs::write(fixture.path().join("workflow.json"), artifact).unwrap();
        let package = crate::portable_packages::install(
            "workflow",
            id,
            &shipped_archive(fixture.path()),
            None,
            None,
            Some("1.0.0"),
            false,
        )
        .unwrap();
        let files = crate::portable_packages::artifact_files("workflow", id).unwrap();
        let error = enable_workflow("workflow", id, &package, &files)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected_error), "{error}");
        let package = crate::portable_packages::get("workflow", id)
            .unwrap()
            .unwrap();
        assert!(!package.enabled);
        assert!(package.runtime_ids.is_empty());
        let after: std::collections::BTreeSet<_> = crate::workflow::store::list_workflows()
            .into_iter()
            .map(|workflow| workflow.id)
            .collect();
        assert_eq!(
            after, baseline,
            "invalid template must not leave partial body definitions"
        );
        crate::portable_packages::uninstall("workflow", id).unwrap();
    }
    crate::workflow::store::delete_workflow(&original.id).unwrap();
}

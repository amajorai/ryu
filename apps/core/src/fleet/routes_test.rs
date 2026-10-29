//! Fleet routes over the shipping router: org-project mappings persist through
//! PUT/GET/DELETE and drive project selection, enrollment refuses a malformed
//! token or control-plane URL before touching disk or the network, and the
//! status and stack-export responses keep their shape.
//!
//! Mappings live in the process data dir's state file, so each test uses its
//! own organization id and temporary roots.

use super::*;
use axum::body::Body;
use tower::ServiceExt;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

async fn send(method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mut request = axum::http::Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes()
        .with_state(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn org_mappings(organization_id: &str) -> Vec<ProjectMapping> {
    load_from(&mappings_path())
        .unwrap()
        .into_iter()
        .filter(|mapping| mapping.organization_id == organization_id)
        .collect()
}

fn delete_uri(organization_id: &str, project_id: &str, root: &Path) -> String {
    format!(
        "/api/org-project-mappings?organizationId={organization_id}&projectId={project_id}&root={}",
        urlencoding::encode(&root.to_string_lossy())
    )
}

#[tokio::test]
async fn org_project_mappings_persist_take_effect_and_delete() {
    let organization = unique("org-");
    let workspace = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    std::fs::create_dir_all(root.join("sub/src")).unwrap();

    let (status, body) = send(
        "PUT",
        "/api/org-project-mappings",
        Some(json!({ "organizationId": organization, "projectId": "web", "root": root })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mapping"]["root"], json!(root));

    // Persisted to the state file and listed back.
    let stored = org_mappings(&organization);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].project_id, "web");
    let (status, listed) = send("GET", "/api/org-project-mappings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(listed["mappings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|mapping| mapping["organizationId"] == organization.as_str()
            && mapping["projectId"] == "web"));
    // And it takes effect: a working directory under the root resolves to it.
    assert_eq!(
        project_for_cwd(&stored, &organization, &root.join("sub/src")),
        Some("web")
    );

    // Re-putting the same mapping is idempotent; an overlapping root for a
    // different project conflicts and is not written.
    let same = json!({ "organizationId": organization, "projectId": "web", "root": root });
    let (status, _) = send("PUT", "/api/org-project-mappings", Some(same)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(org_mappings(&organization).len(), 1);
    let (status, body) = send(
        "PUT",
        "/api/org-project-mappings",
        Some(
            json!({ "organizationId": organization, "projectId": "api", "root": root.join("sub") }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(org_mappings(&organization).len(), 1);

    let (status, body) = send("DELETE", &delete_uri(&organization, "web", &root), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(org_mappings(&organization).is_empty());
    let (status, _) = send("DELETE", &delete_uri(&organization, "web", &root), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invalid_mappings_are_refused_and_not_written() {
    let organization = unique("org-");
    let workspace = tempfile::tempdir().unwrap();
    let file = workspace.path().join("file.txt");
    std::fs::write(&file, "not a directory").unwrap();
    for body in [
        json!({ "organizationId": " ", "projectId": "web", "root": workspace.path() }),
        json!({ "organizationId": organization, "projectId": "", "root": workspace.path() }),
        json!({ "organizationId": organization, "projectId": "web", "root": workspace.path().join("missing") }),
        json!({ "organizationId": organization, "projectId": "web", "root": file }),
    ] {
        let (status, response) = send("PUT", "/api/org-project-mappings", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
    }
    assert!(org_mappings(&organization).is_empty());
}

#[tokio::test]
async fn enrollment_refuses_a_malformed_token_or_url_without_persisting() {
    let pending_before = pending_enrollment_path().exists();
    let valid_token = format!("rfe_{}", "a".repeat(64));
    for (body, error) in [
        (
            json!({ "controlPlaneUrl": "https://cp.example.com", "token": "rfe_short" }),
            "invalid enrollment token",
        ),
        (
            json!({ "controlPlaneUrl": "https://cp.example.com", "token": format!("rfe_{}", "A".repeat(64)) }),
            "invalid enrollment token",
        ),
        (
            json!({ "controlPlaneUrl": "https://cp.example.com", "token": format!("rft_{}", "a".repeat(64)) }),
            "invalid enrollment token",
        ),
    ] {
        let (status, response) = send("POST", "/api/fleet/enroll", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(response["error"], error);
    }
    for url in ["not a url", "ftp://cp.example.com", "http://cp.example.com"] {
        let (status, response) = send(
            "POST",
            "/api/fleet/enroll",
            Some(json!({ "controlPlaneUrl": url, "token": valid_token })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{url}: {response}");
    }
    assert_eq!(pending_enrollment_path().exists(), pending_before);
}

#[tokio::test]
async fn status_reports_enrollment_consistently() {
    let (status, body) = send("GET", "/api/fleet/status", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let enrolled = body["enrolled"].as_bool().expect("enrolled is a boolean");
    assert_eq!(body["nodeId"].is_string(), enrolled);
    assert_eq!(body["organizationId"].is_string(), enrolled);
    assert!(body["managedInferenceReady"].is_boolean());
    if !enrolled {
        assert_eq!(body["managedInferenceReady"], false);
    }
    assert!(body["status"].is_object());
}

#[test]
fn stack_export_keeps_artifact_assignments_and_rules_only() {
    let snapshot = SignedSnapshot {
        payload: json!({
            "revision": 7,
            "assignments": [
                {
                    "activation": "auto",
                    "disposition": "required",
                    "config": { "region": "eu" },
                    "artifact": {
                        "artifactId": "art-1",
                        "digest": "sha256:abc",
                        "keyId": "key-1",
                        "kind": "plugin",
                        "source": "marketplace",
                        "version": "1.2.3",
                    },
                    "nodeSecret": "must not travel",
                },
                { "activation": "auto" },
            ],
            "rules": [
                { "id": "rule-1", "kind": "deny", "definition": { "tool": "shell" } },
                { "ruleId": "rule-2", "kind": "allow", "definition": {}, "locked": true },
                { "ruleId": "rule-3", "kind": "allow" },
            ],
        }),
        public_key: String::new(),
        signature: String::new(),
    };
    let template = stack_template(&snapshot);
    assert_eq!(template["apiVersion"], "ryu.dev/stack-template/v1");
    assert_eq!(template["metadata"]["sourceRevision"], 7);
    assert_eq!(template["projectAliases"], json!([]));
    let items = template["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        1,
        "an assignment without an artifact is dropped"
    );
    assert_eq!(items[0]["artifactId"], "art-1");
    assert_eq!(items[0]["digest"], "sha256:abc");
    assert_eq!(items[0]["config"], json!({ "region": "eu" }));
    assert_eq!(items[0]["setupSlots"], json!([]));
    assert!(!template.to_string().contains("must not travel"));
    let rules = template["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2, "a rule without a definition is dropped");
    assert_eq!(rules[0]["ruleId"], "rule-1");
    assert_eq!(rules[0]["locked"], false);
    assert_eq!(rules[1]["ruleId"], "rule-2");
    assert_eq!(rules[1]["locked"], true);
}

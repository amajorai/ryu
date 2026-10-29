//! `POST /api/spaces/:id/imports/{files,composio,connector}` over the shipping
//! router: request validation, Space existence and write access, and the import
//! history record a valid file import leaves behind.

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::body::Body;
use tower::ServiceExt;

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn member(user_id: &str, org_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(org_id.to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

async fn send(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes()
        .layer(axum::Extension(caller.clone()))
        .with_state(state.clone())
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

fn csv_body(title: &str, csv: &str) -> Value {
    json!({
        "title": title,
        "data_base64": base64::engine::general_purpose::STANDARD.encode(csv.as_bytes()),
    })
}

async fn alice_space(state: &ServerState) -> String {
    state
        .spaces
        .create_space(
            "Alice imports",
            None,
            &DocOwner::owned(Some("alice"), Some("org1")),
        )
        .await
        .unwrap()
}

/// Drive the spawned import job until its history row is terminal.
async fn settled(state: &ServerState, space_id: &str, import_id: &str) -> Value {
    for _ in 0..20_000 {
        let imports = state.spaces.list_imports(space_id, 100).await.unwrap();
        let record = imports
            .iter()
            .find(|record| record.id == import_id)
            .expect("import is recorded");
        if record.status == "completed" || record.status == "failed" {
            return serde_json::to_value(record).unwrap();
        }
        tokio::task::yield_now().await;
    }
    panic!("import {import_id} never settled");
}

#[tokio::test]
async fn a_file_import_is_recorded_listed_and_creates_the_database() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let space = alice_space(&state).await;
    let alice = member("alice", "org1");
    with_test_node_binding(true, Some(org_node()), async {
        let (status, body) = send(
            &state,
            &alice,
            "POST",
            &format!("/api/spaces/{space}/imports/files"),
            Some(csv_body("people.csv", "name,age\nAda,36\nGrace,45\n")),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body["import"]["source_type"], "file");
        assert_eq!(body["import"]["source_format"], "csv");
        assert_eq!(body["import"]["destination_kind"], "database");
        let import_id = body["import"]["id"].as_str().unwrap().to_owned();

        let record = settled(&state, &space, &import_id).await;
        assert_eq!(record["status"], "completed", "{record}");
        assert_eq!(record["item_count"], 2);
        let documents = record["result_documents"].as_array().unwrap();
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0]["kind"], "database");
        assert_eq!(documents[0]["title"], "people");
        let created = state
            .spaces
            .get_document(documents[0]["id"].as_str().unwrap())
            .await
            .unwrap()
            .expect("the imported database exists");
        assert_eq!(created.space_id, space);
        assert!(created.source.contains("Grace"), "{}", created.source);

        // The history route lists the import for a caller who may read the Space.
        let (status, listed) = send(
            &state,
            &alice,
            "GET",
            &format!("/api/spaces/{space}/imports"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed["imports"][0]["id"], import_id.as_str());
        assert_eq!(listed["imports"][0]["status"], "completed");
    })
    .await;
}

#[tokio::test]
async fn invalid_import_requests_are_refused_without_recording_anything() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let space = alice_space(&state).await;
    let alice = member("alice", "org1");
    with_test_node_binding(true, Some(org_node()), async {
        let files = format!("/api/spaces/{space}/imports/files");
        for (body, expected) in [
            (csv_body("   ", "a,b\n"), StatusCode::BAD_REQUEST),
            (
                csv_body("payload.exe", "MZ"),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                json!({ "title": "people.csv", "data_base64": "%%% not base64 %%%" }),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let (status, response) = send(&state, &alice, "POST", &files, Some(body)).await;
            assert_eq!(status, expected, "{response}");
        }

        let (status, response) = send(
            &state,
            &alice,
            "POST",
            &format!("/api/spaces/{space}/imports/composio"),
            Some(json!({ "toolkit": "  ", "action": "NOTION_GET_PAGE" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(response["error"], "toolkit and action are required");

        let connector = format!("/api/spaces/{space}/imports/connector");
        for (body, message) in [
            (
                json!({ "provider": "dropbox" }),
                "provider must be notion, google_drive, confluence, github, or web",
            ),
            (
                json!({ "provider": "web", "urls": ["https://example.com"], "credential": "secret:TOKEN" }),
                "web imports do not take a credential",
            ),
            (
                json!({ "provider": "notion", "credential": "NOTION_TOKEN", "page_ids": ["p"] }),
                "credential must be a vault reference such as secret:NOTION_TOKEN",
            ),
            (
                json!({ "provider": "web", "urls": [] }),
                "web imports need at least one URL in urls",
            ),
        ] {
            let (status, response) = send(&state, &alice, "POST", &connector, Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
            assert_eq!(response["error"], message);
        }

        assert!(state
            .spaces
            .list_imports(&space, 100)
            .await
            .unwrap()
            .is_empty());
    })
    .await;
}

#[tokio::test]
async fn imports_need_an_existing_space_the_caller_may_write() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let space = alice_space(&state).await;
    with_test_node_binding(true, Some(org_node()), async {
        let alice = member("alice", "org1");
        let csv = csv_body("people.csv", "name\nAda\n");
        let composio = json!({ "toolkit": "notion", "action": "NOTION_GET_PAGE" });
        let connector = json!({ "provider": "web", "urls": ["https://example.com"] });
        let kinds = [
            ("files", csv.clone()),
            ("composio", composio.clone()),
            ("connector", connector.clone()),
        ];

        for (kind, body) in kinds.clone() {
            let (status, response) = send(
                &state,
                &alice,
                "POST",
                &format!("/api/spaces/space-missing/imports/{kind}"),
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{kind}: {response}");
        }

        // Another org member, and a caller from another org, cannot import
        // into (or read the history of) Alice's private Space.
        for caller in [member("bob", "org1"), member("mallory", "org2")] {
            for (kind, body) in kinds.clone() {
                let (status, response) = send(
                    &state,
                    &caller,
                    "POST",
                    &format!("/api/spaces/{space}/imports/{kind}"),
                    Some(body),
                )
                .await;
                assert!(
                    status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
                    "{kind}: {status} {response}"
                );
            }
            let (status, _) = send(
                &state,
                &caller,
                "GET",
                &format!("/api/spaces/{space}/imports"),
                None,
            )
            .await;
            assert!(status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND);
        }
        assert!(state
            .spaces
            .list_imports(&space, 100)
            .await
            .unwrap()
            .is_empty());
    })
    .await;
}

//! `POST /api/rnp/v0/conversations/:id/{export,resume}` over the shipping
//! router: export produces a portable, consent-scoped bundle that resumes on a
//! second node, and a tampered or foreign resume is refused without changing
//! the target conversation.

use super::*;
use crate::server::conversations::Tenancy;
use crate::server::sync::apply_sync_payload;
use axum::body::Body;
use serde_json::Value;
use tower::ServiceExt;

fn member(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    })
}

async fn send(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    uri: &str,
    body: &Value,
) -> (StatusCode, Value) {
    let response = router()
        .layer(axum::Extension(caller.clone()))
        .with_state(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), MAX_WIRE_BYTES)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn message(id: &str, role: &str, content: &str, created_at: i64) -> SyncMessage {
    SyncMessage {
        id: id.to_owned(),
        role: role.to_owned(),
        content: content.to_owned(),
        created_at,
        parent_message_id: None,
        version_root: false,
    }
}

/// Alice's conversation on the source node: a user/assistant exchange plus a
/// node-local system message that must never travel.
async fn seed_source(state: &ServerState, id: &str) -> i64 {
    let payload = SyncPayload {
        conversation_id: id.to_owned(),
        title: Some("Deploy plan".to_owned()),
        agent_id: None,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: Some("alice".to_owned()),
        created_at: 10,
        updated_at: 40,
        messages: vec![
            message("m-system", "system", "node-local instructions", 10),
            message("m-user", "user", "Plan the rollout", 20),
            message("m-assistant", "assistant", "Roll out region by region", 30),
        ],
    };
    apply_sync_payload(
        &state.conversations,
        &payload,
        Tenancy::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org-1".to_owned()),
        },
    )
    .await
    .unwrap();
    state
        .conversations
        .get_summary(id)
        .await
        .unwrap()
        .unwrap()
        .updated_at
}

fn export_request(updated_at: Option<i64>) -> Value {
    json!({
        "version": 0,
        "ifUpdatedAt": updated_at,
        "transcript": { "mode": "all" },
        "context": {
            "version": 0,
            "items": [{
                "id": "note-1",
                "kind": "text",
                "label": "Operator note",
                "mediaType": "text/plain",
                "text": "Wait for approval.",
                "source": { "kind": "manual" }
            }]
        }
    })
}

#[tokio::test]
async fn export_produces_a_portable_bundle_that_resumes_once_on_another_node() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let source = crate::server::isolated_plugin_hook_test_state(&directory.path().join("s"));
    let destination = crate::server::isolated_plugin_hook_test_state(&directory.path().join("d"));
    let id = "rnp-export-1";
    let updated_at = seed_source(&source, id).await;
    let alice = member("alice");
    let export_uri = format!("/api/rnp/v0/conversations/{id}/export");

    let (status, bundle) = send(
        &source,
        &alice,
        &export_uri,
        &export_request(Some(updated_at)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bundle}");
    assert_eq!(bundle["protocol"], PROTOCOL);
    assert_eq!(bundle["source"]["conversationId"], id);
    assert_eq!(bundle["source"]["checkpointMessageId"], "m-assistant");
    assert_eq!(bundle["selection"]["omittedEarlierMessages"], false);
    // Only portable roles travel; the node-local system message stays behind.
    let roles: Vec<&str> = bundle["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["user", "assistant"]);
    assert!(!bundle.to_string().contains("node-local instructions"));
    assert_eq!(bundle["context"]["items"][0]["text"], "Wait for approval.");

    let resume_uri = format!("/api/rnp/v0/conversations/{id}/resume");
    let (status, resumed) = send(&destination, &alice, &resume_uri, &bundle).await;
    assert_eq!(status, StatusCode::OK, "{resumed}");
    assert_eq!(resumed["status"], "created");
    assert_eq!(resumed["imported"]["messages"], 2);
    assert_eq!(resumed["imported"]["contextItems"], 1);
    let stored = destination.conversations.get_messages(id).await.unwrap();
    assert_eq!(stored.len(), 3);
    assert!(stored.iter().any(
        |message| message.id == "m-assistant" && message.content == "Roll out region by region"
    ));
    assert!(stored
        .iter()
        .any(|message| message.content.contains("Wait for approval.")));
    let summary = destination
        .conversations
        .get_summary(id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.title.as_deref(), Some("Deploy plan"));

    // The same reviewed bundle is idempotent.
    let (status, replay) = send(&destination, &alice, &resume_uri, &bundle).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["status"], "unchanged");
    assert_eq!(replay["imported"]["messages"], 0);
    assert_eq!(
        destination
            .conversations
            .get_messages(id)
            .await
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn export_is_refused_for_other_users_stale_reviews_and_unknown_versions() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let source = crate::server::isolated_plugin_hook_test_state(directory.path());
    let id = "rnp-export-2";
    let updated_at = seed_source(&source, id).await;
    let uri = format!("/api/rnp/v0/conversations/{id}/export");

    let (status, body) = send(&source, &member("bob"), &uri, &export_request(None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.get("messages").is_none());

    let (status, _) = send(
        &source,
        &member("alice"),
        &uri,
        &export_request(Some(updated_at - 1)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let mut future = export_request(None);
    future["version"] = json!(1);
    let (status, _) = send(&source, &member("alice"), &uri, &future).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Per-user conversation ACLs apply only on an org-bound node (a personal node
/// has one principal), so the foreign-member refusal runs against a bound one.
#[tokio::test]
async fn tampered_and_foreign_resumes_are_refused_without_changing_the_target() {
    let node = crate::sidecar::control_plane::RegisteredNode {
        org: crate::sidecar::control_plane::RegisteredOrg {
            id: "org-1".to_owned(),
            name: "org-1".to_owned(),
            slug: None,
        },
        node_id: "node-rnp".to_owned(),
        scope: crate::sidecar::control_plane::NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    crate::sidecar::control_plane::with_test_node_binding(
        true,
        Some(node),
        tampered_and_foreign_resumes_on_a_bound_node(),
    )
    .await;
}

async fn tampered_and_foreign_resumes_on_a_bound_node() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let source = crate::server::isolated_plugin_hook_test_state(&directory.path().join("s"));
    let destination = crate::server::isolated_plugin_hook_test_state(&directory.path().join("d"));
    let id = "rnp-export-3";
    seed_source(&source, id).await;
    let alice = member("alice");
    let (status, bundle) = send(
        &source,
        &alice,
        &format!("/api/rnp/v0/conversations/{id}/export"),
        &export_request(None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resume_uri = format!("/api/rnp/v0/conversations/{id}/resume");
    let (status, _) = send(&destination, &alice, &resume_uri, &bundle).await;
    assert_eq!(status, StatusCode::OK);
    let before = destination.conversations.get_messages(id).await.unwrap();

    // A rewritten message that already exists on the target conflicts.
    let mut rewritten = bundle.clone();
    rewritten["messages"][1]["text"] = json!("Deploy everywhere at once");
    let (status, body) = send(&destination, &alice, &resume_uri, &rewritten).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // A bundle smuggling a privileged role is invalid.
    let mut privileged = bundle.clone();
    privileged["messages"][0]["role"] = json!("system");
    let (status, _) = send(&destination, &alice, &resume_uri, &privileged).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A bundle for another conversation cannot be replayed under this path.
    let (status, _) = send(
        &destination,
        &alice,
        "/api/rnp/v0/conversations/someone-elses/resume",
        &bundle,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(destination
        .conversations
        .get_summary("someone-elses")
        .await
        .unwrap()
        .is_none());

    // Another member cannot merge a bundle into Alice's conversation.
    let mut foreign = bundle.clone();
    foreign["bundleId"] = json!("foreign-bundle");
    foreign["messages"].as_array_mut().unwrap().push(
        json!({ "sourceId": "m-bob", "role": "user", "text": "bob was here", "createdAt": 50 }),
    );
    let (status, body) = send(&destination, &member("bob"), &resume_uri, &foreign).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let after = destination.conversations.get_messages(id).await.unwrap();
    assert_eq!(after.len(), before.len());
    assert!(after
        .iter()
        .all(|message| message.content != "Deploy everywhere at once"
            && message.content != "bob was here"));
}

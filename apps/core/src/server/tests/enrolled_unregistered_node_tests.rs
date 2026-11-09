//! An enrolled (v2 fleet) self-hosted node whose control-plane registration is
//! pending, failed or revoked is NOT an unbound personal node. A paired client
//! (no user JWT) or a JWT from another org must not be admitted as the single
//! local owner, and the per-member memory filters must stay on.

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::*;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::node_binding::with_test_enrollment;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Extension;
use serde_json::{json, Value};

fn foreign_caller() -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: "mallory".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("other-org".to_owned()),
        role: OrgRole::Owner,
        teams: Vec::new(),
    })
}

fn private_fact() -> memory::LongTermEntry {
    serde_json::from_value(json!({
        "id": "m1",
        "content": "user-a's private fact",
        "created_at": 0,
        "scope": "user",
        "owner_user_id": "user-a"
    }))
    .expect("entry deserializes")
}

/// Run `fut` on an unregistered, non-managed node, with or without a persisted
/// enrollment.
async fn on_unregistered_node<F: std::future::Future>(enrolled: bool, fut: F) -> F::Output {
    with_test_node_binding(false, None, with_test_enrollment(enrolled, fut)).await
}

#[tokio::test]
async fn enrolled_unregistered_node_refuses_paired_and_foreign_callers() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let read = crate::identity_verify::permissions::SPACE_READ;

    let (anonymous, foreign) = on_unregistered_node(true, async {
        (
            enforce_permission(&state, &None, read).await,
            enforce_permission(&state, &foreign_caller(), read).await,
        )
    })
    .await;
    assert_eq!(anonymous, Err(StatusCode::FORBIDDEN));
    assert_eq!(foreign, Err(StatusCode::FORBIDDEN));

    let (anonymous, foreign) = on_unregistered_node(false, async {
        (
            enforce_permission(&state, &None, read).await,
            enforce_permission(&state, &foreign_caller(), read).await,
        )
    })
    .await;
    assert_eq!(anonymous, Ok(()), "a plain personal node keeps its owner");
    assert_eq!(foreign, Ok(()));
}

#[tokio::test]
async fn enrolled_unregistered_node_refuses_resource_candidates() {
    let enrolled = on_unregistered_node(true, async {
        (
            resource_permission_candidate(&None),
            resource_permission_candidate(&foreign_caller()),
        )
    })
    .await;
    assert_eq!(enrolled.0, Err(StatusCode::FORBIDDEN));
    assert_eq!(enrolled.1, Err(StatusCode::FORBIDDEN));

    let personal =
        on_unregistered_node(false, async { resource_permission_candidate(&None) }).await;
    assert_eq!(personal, Ok(None));
}

#[tokio::test]
async fn enrolled_unregistered_node_hides_other_members_memory_by_id() {
    let entry = private_fact();
    let (anonymous, foreign) = on_unregistered_node(true, async {
        (
            memory_access_ok(&None, &entry),
            memory_access_ok(&foreign_caller(), &entry),
        )
    })
    .await;
    assert!(!anonymous);
    assert!(!foreign);

    let personal = on_unregistered_node(false, async { memory_access_ok(&None, &entry) }).await;
    assert!(personal, "a plain personal node has one principal");
}

#[tokio::test]
async fn enrolled_unregistered_node_does_not_list_member_memory_to_a_paired_client() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    state
        .memory
        .record("user-a", "default", "user-a's private fact")
        .await
        .unwrap()
        .expect("fact stored");
    let list = |state: ServerState| async move {
        let query: MemoryListQuery = serde_json::from_value(json!({})).unwrap();
        let response = list_memory(State(state), Extension(None), Query(query)).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    };

    let (status, body) = on_unregistered_node(true, list(state.clone())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!body.to_string().contains("user-a's private fact"));

    let (status, body) = on_unregistered_node(false, list(state)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.to_string().contains("user-a's private fact"));
}

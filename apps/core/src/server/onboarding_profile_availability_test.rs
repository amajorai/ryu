//! `GET /api/onboarding/profile/availability` over the shipping router: the
//! answer follows the node binding, the caller, the persisted node onboarding
//! mode, and whether a profile-bootstrap memory already exists.
//!
//! Entitlement flags are process-global and other tests flip them, so these
//! cases only assert outcomes that are decided before entitlement is read.

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::body::Body;
use tower::ServiceExt;

fn personal_node(owner: &str) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Personal,
        team_id: None,
        owner_user_id: Some(owner.to_owned()),
    }
}

fn org_caller(user_id: &str, role: OrgRole) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role,
        teams: Vec::new(),
    })
}

async fn availability(state: &ServerState, caller: &Option<VerifiedCaller>) -> Value {
    let response = routes()
        .layer(axum::Extension(caller.clone()))
        .with_state(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/onboarding/profile/availability")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn record_profile_memory(state: &ServerState) {
    let mut memory = crate::server::memory::NewMemory::user_fact("Prefers concise status updates");
    memory.tags = vec!["onboarding".to_owned(), "profile-bootstrap".to_owned()];
    state
        .memory
        .record_full(crate::server::memory::LOCAL_USER, "ryu", memory)
        .await
        .unwrap()
        .expect("memory recorded");
}

async fn set_onboarding(state: &ServerState, setup_kind: &str, company_knowledge_enabled: bool) {
    let value = json!({
        "completed": true,
        "completedAtMs": 1,
        "personalization": {
            "companyContext": "Acme builds rockets",
            "companyKnowledgeEnabled": company_knowledge_enabled,
        },
        "setupKind": setup_kind,
        "version": 1,
    });
    state
        .preferences
        .set(
            crate::server::onboarding_state::NODE_ONBOARDING_STATE_PREF_KEY,
            &value.to_string(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn completion_is_reported_only_where_profile_onboarding_is_allowed() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());

    with_test_node_binding(false, None, async {
        // The unbound node's operator may run onboarding, but a profile build
        // needs a signed-in organization admin.
        let before = availability(&state, &None).await;
        assert_eq!(
            before,
            json!({ "allowed": false, "completed": false, "reason": "profile_not_eligible" })
        );
        record_profile_memory(&state).await;
        let after = availability(&state, &None).await;
        assert_eq!(after["completed"], true, "{after}");
        assert_eq!(after["allowed"], false);
        // A member (not an admin) of the org is not eligible either.
        let member = availability(&state, &org_caller("member-1", OrgRole::Member)).await;
        assert_eq!(member["allowed"], false);
        assert_eq!(member["reason"], "profile_not_eligible");
    })
    .await;

    // The same node, once managed or bound to someone else, reports neither
    // availability nor the existing profile.
    with_test_node_binding(true, Some(personal_node("owner-1")), async {
        let managed = availability(&state, &org_caller("owner-1", OrgRole::Owner)).await;
        assert_eq!(
            managed,
            json!({ "allowed": false, "completed": false, "reason": "managed_node" })
        );
    })
    .await;
    with_test_node_binding(false, Some(personal_node("owner-1")), async {
        let stranger = availability(&state, &org_caller("member-1", OrgRole::Owner)).await;
        assert_eq!(
            stranger,
            json!({ "allowed": false, "completed": false, "reason": "not_node_owner" })
        );
    })
    .await;
}

#[tokio::test]
async fn a_team_node_with_company_knowledge_off_is_not_available() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let admin = org_caller("admin-1", OrgRole::Admin);

    with_test_node_binding(false, None, async {
        set_onboarding(&state, "team", false).await;
        let disabled = availability(&state, &admin).await;
        assert_eq!(
            disabled,
            json!({ "allowed": false, "completed": false, "reason": "company_knowledge_disabled" })
        );

        // Turning company knowledge on (or using personal mode, where the
        // flag does not apply) leaves only the eligibility checks.
        for (setup_kind, knowledge) in [("team", true), ("personal", false)] {
            set_onboarding(&state, setup_kind, knowledge).await;
            let body = availability(&state, &admin).await;
            let reason = body["reason"].as_str().unwrap();
            assert!(
                reason == "ready" || reason == "profile_not_eligible",
                "{setup_kind}: {body}"
            );
            assert_eq!(body["allowed"], reason == "ready", "{body}");
        }
    })
    .await;
}

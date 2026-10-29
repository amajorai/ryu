//! Route-level onboarding state and skill-selection invariants.
//!
//! Every case drives the shipping `/api/onboarding/*` router over the node's
//! real preferences SQLite file. The node binding (unbound, personal, managed)
//! is a per-task test binding, so no process-global registration is touched.
use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use axum::{body::Body, http::Request};
use serde_json::Value;
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    state: ServerState,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        Self {
            _directory: directory,
            state,
        }
    }

    async fn send(
        &self,
        caller: Option<VerifiedCaller>,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let router = routes()
            .layer(axum::Extension(caller))
            .with_state(self.state.clone());
        let mut request = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = router.oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, value)
    }

    async fn stored_state(&self) -> Option<String> {
        self.state
            .preferences
            .get(NODE_ONBOARDING_STATE_PREF_KEY)
            .await
            .unwrap()
    }
}

fn personal_node(owner: &str) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Personal,
        team_id: None,
        owner_user_id: Some(owner.to_owned()),
    }
}

fn caller(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: OrgRole::Admin,
        teams: Vec::new(),
    })
}

#[tokio::test]
async fn saved_state_round_trips_and_delete_resets_to_a_first_run() {
    with_test_node_binding(false, None, async {
        let harness = Harness::new();

        let (status, first_run) = harness
            .send(None, "GET", "/api/onboarding/state", None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first_run["completed"], false);
        assert_eq!(first_run["setupKind"], Value::Null);
        assert_eq!(first_run["canConfigure"], true);

        let (status, saved) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/state",
                Some(json!({
                    "setupKind": "team",
                    "completed": true,
                    "companyContext": "  Acme builds rockets  ",
                    "companyKnowledgeEnabled": true,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["completed"], true);
        assert!(saved["completedAtMs"].as_i64().unwrap() > 0);

        // The durable record, read back through a fresh GET, is what was saved.
        let (status, reread) = harness
            .send(None, "GET", "/api/onboarding/state", None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reread["setupKind"], "team");
        assert_eq!(reread["completed"], true);
        assert_eq!(reread["completedAtMs"], saved["completedAtMs"]);
        assert_eq!(
            reread["personalization"],
            json!({
                "companyContext": "Acme builds rockets",
                "companyKnowledgeEnabled": true,
            })
        );
        let stored: Value = serde_json::from_str(&harness.stored_state().await.unwrap()).unwrap();
        assert_eq!(stored["setupKind"], "team");
        assert_eq!(
            stored["personalization"]["companyContext"],
            "Acme builds rockets"
        );

        // A personal setup never keeps shared company context, even if sent.
        let (status, personal) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/state",
                Some(json!({
                    "setupKind": "personal",
                    "completed": true,
                    "companyContext": "leaked company context",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(personal["personalization"]["companyContext"], "");
        assert_eq!(
            personal["personalization"]["companyKnowledgeEnabled"],
            false
        );
        assert!(!harness
            .stored_state()
            .await
            .unwrap()
            .contains("leaked company context"));

        let (status, reset) = harness
            .send(None, "DELETE", "/api/onboarding/state", None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reset["completed"], false);
        assert_eq!(harness.stored_state().await, None);
        let (_, after_reset) = harness
            .send(None, "GET", "/api/onboarding/state", None)
            .await;
        assert_eq!(after_reset["completed"], false);
        assert_eq!(after_reset["setupKind"], Value::Null);
        assert_eq!(after_reset["completedAtMs"], Value::Null);
    })
    .await;
}

#[tokio::test]
async fn a_personal_node_refuses_every_write_from_anyone_but_its_owner() {
    with_test_node_binding(false, Some(personal_node("owner")), async {
        let harness = Harness::new();
        let team = json!({ "setupKind": "team", "completed": true, "companyContext": "x" });

        // A same-org administrator is not the owner of a personal node.
        let intruder = caller("org-admin");
        let (status, body) = harness
            .send(
                intruder.clone(),
                "PUT",
                "/api/onboarding/state",
                Some(team.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(harness.stored_state().await, None);
        let (status, _) = harness
            .send(
                intruder.clone(),
                "PUT",
                "/api/onboarding/skills",
                Some(json!({ "selectedPackIds": [] })),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (_, view) = harness
            .send(intruder.clone(), "GET", "/api/onboarding/state", None)
            .await;
        assert_eq!(view["canConfigure"], false);
        let (status, _) = harness
            .send(None, "PUT", "/api/onboarding/state", Some(team.clone()))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // The owner may save; the intruder then may not reset it.
        let (status, _) = harness
            .send(caller("owner"), "PUT", "/api/onboarding/state", Some(team))
            .await;
        assert_eq!(status, StatusCode::OK);
        let saved = harness.stored_state().await.unwrap();
        let (status, _) = harness
            .send(intruder, "DELETE", "/api/onboarding/state", None)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(harness.stored_state().await, Some(saved));
    })
    .await;
}

#[tokio::test]
async fn a_managed_node_awaiting_registration_refuses_configuration() {
    with_test_node_binding(true, None, async {
        let harness = Harness::new();
        let (status, _) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/state",
                Some(json!({ "setupKind": "personal", "completed": true })),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(harness.stored_state().await, None);
    })
    .await;
}

#[tokio::test]
async fn skill_selection_persists_from_a_camel_case_body_and_rejects_unknown_packs() {
    with_test_node_binding(false, None, async {
        let harness = Harness::new();
        let (_, before) = harness
            .send(None, "GET", "/api/onboarding/skills", None)
            .await;
        assert_eq!(before["configured"], false);
        assert!(!before["selectedPackIds"].as_array().unwrap().is_empty());

        // snake_case is not the wire contract; it must not be read as "none".
        let (status, _) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/skills",
                Some(json!({ "selected_pack_ids": [] })),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, body) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/skills",
                Some(json!({ "selectedPackIds": ["not-a-real/pack"] })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (_, unchanged) = harness
            .send(None, "GET", "/api/onboarding/skills", None)
            .await;
        assert_eq!(unchanged["configured"], false);

        // An explicit empty choice ("built-in skills only") is persisted.
        let (status, saved) = harness
            .send(
                None,
                "PUT",
                "/api/onboarding/skills",
                Some(json!({ "selectedPackIds": [] })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["configured"], true);
        assert_eq!(saved["selectedPackIds"], json!([]));
        let (_, reread) = harness
            .send(None, "GET", "/api/onboarding/skills", None)
            .await;
        assert_eq!(reread["configured"], true);
        assert_eq!(reread["selectedPackIds"], json!([]));

        // Resetting onboarding also forgets the skill choice.
        let (status, _) = harness
            .send(None, "DELETE", "/api/onboarding/state", None)
            .await;
        assert_eq!(status, StatusCode::OK);
        let (_, after_reset) = harness
            .send(None, "GET", "/api/onboarding/skills", None)
            .await;
        assert_eq!(after_reset["configured"], false);
    })
    .await;
}

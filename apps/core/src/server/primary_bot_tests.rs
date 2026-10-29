//! Primary bot wire contract, principal scoping, revisioned selection and the
//! per-principal bot main thread, through the mounted hierarchy router.

use super::*;
use crate::server::conversations::{ConversationStore, OwnerKind, Tenancy};
use crate::server::hierarchy_api::primary_bot_store::{with_test_store, SelectionStore};
use crate::server::ResolvedAuthorization;
use axum::{body::Body, http::Request, middleware};
use serde_json::Value;
use tower::ServiceExt;

fn caller(user: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user.into(),
        email: None,
        email_verified: false,
        org_id: None,
        role: crate::identity_verify::OrgRole::Member,
        teams: vec![],
    }
}

#[test]
fn selection_wire_shape_matches_shared_client_fixture() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../packages/core-client/fixtures/primary-bot-selection.json"
    ))
    .unwrap();
    let selection = Selection {
        agent_id: Some("scout".to_owned()),
        effective_agent_id: Some("scout".to_owned()),
        revision: 3,
        source: SelectionSource::Selected,
        unavailable_reason: None,
    };
    assert_eq!(serde_json::to_value(selection).unwrap(), expected);
}

#[test]
fn input_cannot_name_another_principal_or_project_and_requires_clear_to_be_explicit() {
    let parse = |value: Value| serde_json::from_value::<SelectionInput>(value);
    assert!(parse(json!({"expectedRevision": 0})).is_err());
    assert!(parse(json!({"agentId": "ryu", "expectedRevision": 0, "userId": "victim"})).is_err());
    assert!(
        parse(json!({"agentId": "ryu", "expectedRevision": 0, "projectId": "victim"})).is_err()
    );
    assert!(parse(json!({"agentId": "ryu", "expectedRevision": -1})).is_err());
    assert!(parse(json!({"agentId": null, "expectedRevision": 0}))
        .unwrap()
        .agent_id
        .is_none());
}

#[test]
fn principal_is_derived_only_from_verified_identity() {
    assert_eq!(principal(&Some(caller("alice"))), "user:alice");
    assert_eq!(principal(&None), "node-operator");
}

struct Harness {
    _directory: tempfile::TempDir,
    state: ServerState,
    router: Router,
    store: SelectionStore,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.conversations =
            ConversationStore::open_hook_test_file(directory.path().join("hierarchy.db")).unwrap();
        let store = SelectionStore::open_at(directory.path().join("primary-bot.db")).unwrap();
        let router = crate::server::hierarchy_api::routes()
            .with_state(state.clone())
            .layer(middleware::from_fn(crate::server::attach_verified_caller));
        Self {
            _directory: directory,
            state,
            router,
            store,
        }
    }

    /// Call as `user` (a verified caller) or, with `None`, as the node operator.
    async fn call(
        &self,
        user: Option<&str>,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let resolved = ResolvedAuthorization {
            context: crate::authorization::AuthorizationContext::owner(crate::pairing::now_secs()),
            bindings: crate::authorization::RequestBindings {
                subject_id: user.map(str::to_owned),
                ..Default::default()
            },
            caller: user.map(caller),
            verified_user_jwt: None,
        };
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request.extensions_mut().insert(resolved);
        let response = with_test_store(self.store.clone(), self.router.clone().oneshot(request))
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
}

#[tokio::test]
async fn http_selection_is_revisioned_per_principal_and_clear_keeps_a_tombstone() {
    let h = Harness::new();
    let fresh = h
        .call(Some("alice"), "GET", "/api/primary-bot", Value::Null)
        .await;
    assert_eq!(fresh.0, StatusCode::OK, "{:?}", fresh.1);
    assert_eq!(fresh.1["agentId"], Value::Null);
    assert_eq!(fresh.1["revision"], 0);
    assert_eq!(fresh.1["source"], "default");

    let select = json!({"agentId": "ryu", "expectedRevision": 0});
    let saved = h
        .call(Some("alice"), "PUT", "/api/primary-bot", select.clone())
        .await;
    assert_eq!(saved.0, StatusCode::OK, "{:?}", saved.1);
    assert_eq!(saved.1["agentId"], "ryu");
    assert_eq!(saved.1["effectiveAgentId"], "ryu");
    assert_eq!(saved.1["source"], "selected");
    assert_eq!(saved.1["revision"], 1);

    // A repeated write with the old revision conflicts instead of duplicating.
    let stale = h
        .call(Some("alice"), "PUT", "/api/primary-bot", select)
        .await;
    assert_eq!(stale.0, StatusCode::CONFLICT);
    assert_eq!(stale.1["code"], "primary_bot_revision_conflict");

    // Bob and the node operator keep their own, untouched selections.
    for user in [Some("bob"), None] {
        let other = h.call(user, "GET", "/api/primary-bot", Value::Null).await;
        assert_eq!(other.1["agentId"], Value::Null);
        assert_eq!(other.1["revision"], 0);
    }

    let cleared = h
        .call(
            Some("alice"),
            "PUT",
            "/api/primary-bot",
            json!({"agentId": null, "expectedRevision": 1}),
        )
        .await;
    assert_eq!(cleared.0, StatusCode::OK);
    assert_eq!(cleared.1["agentId"], Value::Null);
    assert_eq!(cleared.1["revision"], 2);
    let resurrect = h
        .call(
            Some("alice"),
            "PUT",
            "/api/primary-bot",
            json!({"agentId": "ryu", "expectedRevision": 1}),
        )
        .await;
    assert_eq!(resurrect.0, StatusCode::CONFLICT);
    assert_eq!(h.store.read("user:alice").await.unwrap(), (None, 2));
}

#[tokio::test]
async fn http_selection_rejects_unknown_bots_and_foreign_scope_fields_without_writing() {
    let h = Harness::new();
    let missing = h
        .call(
            None,
            "PUT",
            "/api/primary-bot",
            json!({"agentId": "no-such-bot", "expectedRevision": 0}),
        )
        .await;
    assert_eq!(missing.0, StatusCode::CONFLICT);
    assert_eq!(missing.1["code"], "primary_bot_unavailable");
    let scoped = h
        .call(
            None,
            "PUT",
            "/api/primary-bot",
            json!({"agentId": "ryu", "expectedRevision": 0, "userId": "victim"}),
        )
        .await;
    assert_eq!(scoped.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(scoped.1["code"], "invalid_primary_bot_selection");
    assert_eq!(h.store.read("node-operator").await.unwrap(), (None, 0));
    assert_eq!(h.store.read("user:victim").await.unwrap(), (None, 0));
}

#[tokio::test]
async fn http_personal_bot_main_isolates_verified_users_from_the_operator() {
    let h = Harness::new();
    let main_body = json!({"owner_kind": "agent", "owner_id": "ryu"});
    let lookup = "/api/hierarchy/main-threads?owner_kind=agent&owner_id=ryu";
    let operator = h
        .call(
            None,
            "POST",
            "/api/hierarchy/main-threads",
            main_body.clone(),
        )
        .await;
    assert_eq!(operator.0, StatusCode::OK, "{:?}", operator.1);
    let operator_id = operator.1["conversation_id"].as_str().unwrap().to_owned();
    let message = h
        .state
        .conversations
        .append_message_as(
            &operator_id,
            "user",
            "Keep operator history",
            None,
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    for user in ["alice", "bob"] {
        assert_eq!(
            h.call(Some(user), "GET", lookup, Value::Null).await,
            (StatusCode::OK, json!({"conversation_id": null}))
        );
    }
    let (alice, bob) = tokio::join!(
        h.call(
            Some("alice"),
            "POST",
            "/api/hierarchy/main-threads",
            main_body.clone()
        ),
        h.call(
            Some("bob"),
            "POST",
            "/api/hierarchy/main-threads",
            main_body.clone()
        )
    );
    assert_eq!(alice.0, StatusCode::OK);
    assert_eq!(bob.0, StatusCode::OK);
    assert_ne!(alice.1, bob.1);
    assert_ne!(alice.1, operator.1);
    assert_ne!(bob.1, operator.1);
    for (user, expected) in [
        (Some("alice"), &alice),
        (Some("bob"), &bob),
        (None, &operator),
    ] {
        assert_eq!(
            &h.call(
                user,
                "POST",
                "/api/hierarchy/main-threads",
                main_body.clone()
            )
            .await,
            expected
        );
        assert_eq!(&h.call(user, "GET", lookup, Value::Null).await, expected);
    }
    let history = h
        .state
        .conversations
        .get_messages(&operator_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, message);

    // A bot main thread must run its owning bot, and only an installed one.
    let mismatched = h
        .call(
            Some("alice"),
            "POST",
            "/api/hierarchy/main-threads",
            json!({"owner_kind": "agent", "owner_id": "ryu", "agent_id": "other"}),
        )
        .await;
    assert_eq!(mismatched.0, StatusCode::BAD_REQUEST);
    let missing = h
        .call(
            Some("alice"),
            "POST",
            "/api/hierarchy/main-threads",
            json!({"owner_kind": "agent", "owner_id": "no-such-bot"}),
        )
        .await;
    assert_eq!(missing.0, StatusCode::CONFLICT);
    assert!(h
        .state
        .conversations
        .find_main_thread(None, OwnerKind::Agent, "no-such-bot")
        .await
        .unwrap()
        .is_none());
}

#[test]
fn only_a_personal_bot_main_follows_the_verified_principal() {
    use crate::server::hierarchy_api::{main_thread_tenancy, main_thread_tenancy_from_existing};
    let alice = Some(caller("alice"));
    assert!(matches!(
        main_thread_tenancy(&alice, OwnerKind::Group, None),
        Tenancy::Unattributed
    ));
    assert!(matches!(
        main_thread_tenancy(&alice, OwnerKind::Agent, Some("atlas")),
        Tenancy::Unattributed
    ));
    assert!(matches!(
        main_thread_tenancy(&alice, OwnerKind::Agent, Some("  ")),
        Tenancy::Owned { user_id, org_id: None } if user_id == "alice"
    ));
    assert!(matches!(
        main_thread_tenancy(&None, OwnerKind::Agent, None),
        Tenancy::Unattributed
    ));
    let bound = Tenancy::Owned {
        user_id: "alice".into(),
        org_id: Some("bound-node-org".into()),
    };
    assert!(matches!(
        main_thread_tenancy_from_existing(&alice, OwnerKind::Agent, None, bound),
        Tenancy::Owned { user_id, org_id: Some(org_id) }
            if user_id == "alice" && org_id == "bound-node-org"
    ));
}

/// A supplied but invalid user identity must be refused before any handler can
/// fall back to the node-operator scope, through the real node admission gate.
#[tokio::test]
async fn supplied_invalid_user_jwt_never_falls_back_to_operator_primary_or_main() {
    let h = Harness::new();
    let idp = crate::server::multiplayer_journey_tests::TestIdentityProvider::start().await;
    let valid = idp.mint("scope-user", "org-scope", "member", &[]);
    let mut tampered = valid.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    let router = crate::server::hierarchy_api::routes()
        .with_state(h.state.clone())
        .layer(middleware::from_fn(crate::server::attach_verified_caller))
        .layer(middleware::from_fn(|request, next| async move {
            crate::server::require_auth_with_token(request, next, Some("scope-owner".into())).await
        }));
    let request = |method: &str, path: &str, jwt: Option<&str>, body: Value| {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", "Bearer scope-owner")
            .header("content-type", "application/json");
        if let Some(jwt) = jwt {
            builder = builder.header("x-ryu-user-jwt", jwt);
        }
        let request = builder.body(Body::from(body.to_string())).unwrap();
        let router = router.clone();
        let store = h.store.clone();
        async move {
            let response = with_test_store(store, router.oneshot(request))
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            )
        }
    };
    let main_body = json!({"owner_kind": "agent", "owner_id": "ryu"});
    let operator_main = request(
        "POST",
        "/api/hierarchy/main-threads",
        None,
        main_body.clone(),
    )
    .await;
    let user_main = request(
        "POST",
        "/api/hierarchy/main-threads",
        Some(&valid),
        main_body,
    )
    .await;
    assert_eq!(operator_main.0, StatusCode::OK, "{:?}", operator_main.1);
    assert_eq!(user_main.0, StatusCode::OK, "{:?}", user_main.1);
    assert_ne!(operator_main.1, user_main.1);
    let conversations = || {
        let conn = rusqlite::Connection::open(h._directory.path().join("hierarchy.db")).unwrap();
        conn.query_row("SELECT COUNT(*) FROM conversations", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    let before = conversations();
    for token in [tampered.as_str(), "not-a-jwt", " "] {
        for (method, path, body) in [
            ("GET", "/api/primary-bot", Value::Null),
            (
                "PUT",
                "/api/primary-bot",
                json!({"agentId": "ryu", "expectedRevision": 0}),
            ),
            (
                "GET",
                "/api/hierarchy/main-threads?owner_kind=agent&owner_id=ryu",
                Value::Null,
            ),
            (
                "POST",
                "/api/hierarchy/main-threads",
                json!({"owner_kind": "agent", "owner_id": "ryu", "title": "must-not-create"}),
            ),
        ] {
            assert_eq!(
                request(method, path, Some(token), body).await.0,
                StatusCode::UNAUTHORIZED,
                "{token:?} {method} {path}"
            );
        }
    }
    assert_eq!(conversations(), before);
    assert_eq!(h.store.read("node-operator").await.unwrap(), (None, 0));
    assert_eq!(h.store.read("user:scope-user").await.unwrap(), (None, 0));
    let lookup = "/api/hierarchy/main-threads?owner_kind=agent&owner_id=ryu";
    assert_eq!(
        request("GET", lookup, None, Value::Null).await,
        operator_main
    );
    assert_eq!(
        request("GET", lookup, Some(&valid), Value::Null).await,
        user_main
    );
    let saved = request(
        "PUT",
        "/api/primary-bot",
        Some(&valid),
        json!({"agentId": "ryu", "expectedRevision": 0}),
    )
    .await;
    assert_eq!(saved.0, StatusCode::OK, "{:?}", saved.1);
    assert_eq!(
        h.store.read("user:scope-user").await.unwrap(),
        (Some("ryu".into()), 1)
    );
    assert_eq!(h.store.read("node-operator").await.unwrap(), (None, 0));
}

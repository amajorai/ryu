//! Actual mounted hierarchy handlers, identity projection, and file SQLite readback.
//! Global node registration and JWT/delegation verification are not mocked here.
use super::*;
use crate::authorization::{
    AuthorizationContext, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RequestBindings,
};
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::server::{
    attach_verified_caller, isolated_plugin_hook_test_state, ResolvedAuthorization,
};
use axum::{body::Body, http::Request, middleware};
use serde_json::Value;
use tower::ServiceExt;

struct Harness {
    directory: tempfile::TempDir,
    database: std::path::PathBuf,
    state: ServerState,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_node().is_none());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("hierarchy.db");
        let mut state = isolated_plugin_hook_test_state(directory.path());
        state.conversations = ConversationStore::open_hook_test_file(database.clone()).unwrap();
        let router = routes()
            .with_state(state.clone())
            .layer(middleware::from_fn(attach_verified_caller))
            .layer(middleware::from_fn(authorize_resolved));
        Self {
            directory,
            database,
            state,
            router,
        }
    }

    fn reopen(&self) -> ConversationStore {
        assert!(self.directory.path().exists());
        ConversationStore::open_hook_test_file(self.database.clone()).unwrap()
    }

    async fn thread(&self, id: &str, owner: &str, project: &str) {
        self.state
            .conversations
            .ensure_conversation(
                id,
                None,
                Some(id),
                Tenancy::Owned {
                    user_id: owner.into(),
                    org_id: Some("org-hierarchy".into()),
                },
            )
            .await
            .unwrap();
        self.state
            .conversations
            .set_thread_project(id, Some(project))
            .await
            .unwrap();
    }

    async fn request(
        &self,
        user: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        self.request_context(
            user,
            method,
            path,
            body,
            AuthorizationContext::owner(crate::pairing::now_secs()),
        )
        .await
    }

    async fn request_context(
        &self,
        user: &str,
        method: &str,
        path: &str,
        body: Value,
        context: AuthorizationContext,
    ) -> (StatusCode, Value) {
        let caller = VerifiedCaller {
            user_id: user.into(),
            email: None,
            email_verified: false,
            org_id: Some("org-hierarchy".into()),
            role: crate::identity_verify::OrgRole::Member,
            teams: vec![],
        };
        // Start at the production post-credential-resolution boundary. The real
        // identity middleware projects this server-owned caller into the handler.
        let resolved = ResolvedAuthorization {
            context,
            bindings: RequestBindings {
                subject_id: Some(user.into()),
                org_id: caller.org_id.clone(),
                ..Default::default()
            },
            caller: Some(caller),
            verified_user_jwt: None,
        };
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        request.extensions_mut().insert(resolved);
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            },
        )
    }
}

#[tokio::test]
async fn hierarchy_http_main_identity_is_idempotent_owned_lookup_refuses_other_user_and_reopens() {
    let h = Harness::new();
    let owned = h
        .state
        .conversations
        .ensure_main_thread(
            Some("atlas"),
            OwnerKind::Project,
            "atlas",
            Some("ryu"),
            Some("Owner main"),
            Tenancy::Owned {
                user_id: "alice".into(),
                org_id: Some("org-hierarchy".into()),
            },
        )
        .await
        .unwrap();
    let input = json!({"project_id":"atlas","owner_kind":"project","owner_id":"atlas","agent_id":"ryu","title":"Ignored replacement"});
    let (a, b) = tokio::join!(
        h.request(
            "alice",
            "POST",
            "/api/hierarchy/main-threads",
            input.clone()
        ),
        h.request(
            "alice",
            "POST",
            "/api/hierarchy/main-threads",
            input.clone()
        )
    );
    assert_eq!(a, (StatusCode::OK, json!({"conversation_id":owned})));
    assert_eq!(b, a);
    let before = h
        .state
        .conversations
        .get_summary(&owned)
        .await
        .unwrap()
        .unwrap();
    let denied = h
        .request("bob", "POST", "/api/hierarchy/main-threads", input)
        .await;
    assert_eq!(
        denied,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden: you do not have access to this resource"})
        )
    );
    assert_eq!(
        h.request(
            "bob",
            "GET",
            "/api/hierarchy/main-threads?project_id=atlas&owner_kind=project&owner_id=atlas",
            Value::Null
        )
        .await,
        (StatusCode::OK, json!({"conversation_id":null}))
    );
    let after = h.reopen().get_summary(&owned).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    let fresh =
        json!({"project_id":"fresh","owner_kind":"agent","owner_id":"ryu","title":"Fresh main"});
    let (first, second) = tokio::join!(
        h.request(
            "alice",
            "POST",
            "/api/hierarchy/main-threads",
            fresh.clone()
        ),
        h.request("alice", "POST", "/api/hierarchy/main-threads", fresh)
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second, first);
    let id = first.1["conversation_id"].as_str().unwrap();
    assert!(!id.is_empty());
    assert_eq!(
        h.reopen()
            .find_main_thread(Some("fresh"), OwnerKind::Agent, "ryu")
            .await
            .unwrap()
            .as_deref(),
        Some(id)
    );
    let sql = rusqlite::Connection::open(&h.database).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT COUNT(*) FROM conversations WHERE project_id='fresh'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    // Unbound HTTP creation follows its real single-owner legacy behavior.
    let meta = h.reopen().get_access_meta(id).await.unwrap().unwrap();
    assert!(meta.owner_user_id.is_none());
    assert!(meta.org_id.is_none());
    assert_eq!(
        h.request(
            "alice",
            "POST",
            "/api/hierarchy/main-threads",
            json!({"owner_kind":"unknown","owner_id":"atlas"})
        )
        .await,
        (
            StatusCode::BAD_REQUEST,
            json!({"error":"owner_kind must be project, agent, or group"})
        )
    );
}

#[tokio::test]
async fn hierarchy_http_project_and_sessions_filter_private_rows_and_refused_retarget_preserves_child(
) {
    let h = Harness::new();
    for (id, owner) in [
        ("alice-parent", "alice"),
        ("alice-child", "alice"),
        ("bob-private", "bob"),
        ("bob-child", "bob"),
    ] {
        h.thread(id, owner, "atlas").await;
    }
    h.state
        .conversations
        .mark_spawned_by("bob-child", "alice-parent", None)
        .await
        .unwrap();
    let child_before = h
        .state
        .conversations
        .get_summary("alice-child")
        .await
        .unwrap()
        .unwrap();
    let unrelated_before = h
        .state
        .conversations
        .get_summary("bob-private")
        .await
        .unwrap()
        .unwrap();
    for (parent, status, error) in [
        (
            "bob-private",
            StatusCode::FORBIDDEN,
            "forbidden: you do not have access to this resource",
        ),
        (
            "missing-parent",
            StatusCode::NOT_FOUND,
            "conversation 'missing-parent' not found",
        ),
    ] {
        assert_eq!(
            h.request(
                "alice",
                "PUT",
                "/api/hierarchy/threads/alice-child/project",
                json!({"project_id":"changed","spawned_by_conversation_id":parent})
            )
            .await,
            (status, json!({"error":error}))
        );
        assert_eq!(
            serde_json::to_value(
                h.reopen()
                    .get_summary("alice-child")
                    .await
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&child_before).unwrap()
        );
    }
    assert_eq!(
        h.request(
            "bob",
            "PUT",
            "/api/hierarchy/threads/alice-child/project",
            json!({"project_id":"changed"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.request(
            "alice",
            "GET",
            "/api/hierarchy/threads/bob-private",
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, listing) = h
        .request(
            "alice",
            "GET",
            "/api/hierarchy/projects/atlas/threads",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut ids = listing["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(ids, ["alice-child", "alice-parent"]);
    assert_eq!(
        h.request(
            "alice",
            "PUT",
            "/api/hierarchy/threads/alice-child/project",
            json!({"project_id":"atlas","spawned_by_conversation_id":"alice-parent"})
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    let (status, sessions) = h
        .request(
            "alice",
            "GET",
            "/api/hierarchy/threads/alice-parent/sessions",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["alice-child"]
    );
    let reopened = h.reopen();
    assert_eq!(
        reopened
            .thread_hierarchy("alice-child")
            .await
            .unwrap()
            .unwrap()
            .spawned_by_conversation_id
            .as_deref(),
        Some("alice-parent")
    );
    assert_eq!(
        serde_json::to_value(reopened.get_summary("bob-private").await.unwrap().unwrap()).unwrap(),
        serde_json::to_value(unrelated_before).unwrap()
    );
}

#[tokio::test]
async fn hierarchy_http_scope_defaults_omitted_coordinator_refusal_retry_reset_and_reopen() {
    let h = Harness::new();
    let scope = "project:atlas/agent:ryu";
    let path = format!("/api/scope-defaults/{scope}");
    let full = json!({"provider":"p","model":"thread","effort":"low","coordinatorProvider":"cp","coordinatorModel":"main","coordinatorEffort":"high"});
    assert_eq!(
        h.request("alice", "PUT", &path, full.clone()).await,
        (StatusCode::OK, json!({"ok":true}))
    );
    let sql = rusqlite::Connection::open(&h.database).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_scope_update BEFORE UPDATE ON scope_defaults BEGIN SELECT RAISE(ABORT, 'hierarchy defaults refused'); END;").unwrap();
    let refused = h
        .request(
            "alice",
            "PUT",
            &path,
            json!({"provider":"new","model":"next","effort":"medium"}),
        )
        .await;
    assert_eq!(
        refused,
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"writing scope default"})
        )
    );
    assert_eq!(
        serde_json::to_value(h.reopen().scope_default(scope).await.unwrap().unwrap()).unwrap(),
        full
    );
    sql.execute_batch("DROP TRIGGER refuse_scope_update;")
        .unwrap();
    assert_eq!(
        h.request(
            "alice",
            "PUT",
            &path,
            json!({"provider":"new","model":"next","effort":"medium"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let expected = json!({"provider":"new","model":"next","effort":"medium","coordinatorProvider":"cp","coordinatorModel":"main","coordinatorEffort":"high"});
    assert_eq!(
        serde_json::to_value(h.reopen().scope_default(scope).await.unwrap().unwrap()).unwrap(),
        expected
    );
    let before = h
        .request("alice", "GET", "/api/scope-defaults", Value::Null)
        .await;
    for invalid in ["group:wrong", "project:", "project:atlas/unknown:ryu"] {
        assert_eq!(
            h.request(
                "alice",
                "PUT",
                &format!("/api/scope-defaults/{invalid}"),
                full.clone()
            )
            .await,
            (
                StatusCode::BAD_REQUEST,
                json!({"error":"scope must be global, project:<id>, agent:<id>, or project:<id>/agent:<id>"})
            )
        );
    }
    assert_eq!(
        h.request("alice", "GET", "/api/scope-defaults", Value::Null)
            .await,
        before
    );
    let (status, main) = h.request("alice", "GET", "/api/hierarchy/effective-defaults?project_id=atlas&agent_id=ryu&thread_role=main&inherited_only=true", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(main["resolved"]["model"], "main");
    let (status, session) = h
        .request(
            "alice",
            "GET",
            "/api/hierarchy/effective-defaults?project_id=atlas&agent_id=ryu&session_model=pinned",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["resolved"]["model"], "pinned");
    assert_eq!(
        h.request("alice", "DELETE", &path, Value::Null).await,
        (StatusCode::OK, json!({"ok":true}))
    );
    assert!(h.reopen().scope_default(scope).await.unwrap().is_none());
    assert_eq!(
        h.request("alice", "GET", "/api/scope-defaults", Value::Null)
            .await,
        (StatusCode::OK, json!({"defaults":{}}))
    );
}

async fn authorize_resolved(request: Request<Body>, next: middleware::Next) -> Response {
    let resolved = request.extensions().get::<ResolvedAuthorization>().unwrap();
    let policy = crate::server::route_policy(request.method(), request.uri().path());
    if let Some(status) = crate::server::denial_status(resolved.context.authorize(
        &policy,
        &resolved.bindings,
        crate::pairing::now_secs(),
    )) {
        return status.into_response();
    }
    next.run(request).await
}

fn delegated(
    capabilities: impl IntoIterator<Item = crate::authorization::Capability>,
) -> AuthorizationContext {
    let now = crate::pairing::now_secs();
    AuthorizationContext {
        credential: CredentialKind::ManagedDelegation,
        principal: Principal::User {
            subject_id: "alice".into(),
        },
        capabilities: CapabilitySet::new(capabilities),
        constraints: GrantConstraints::default(),
        issued_at: now,
        expires_at: Some(now + 60),
    }
}

#[tokio::test]
async fn hierarchy_http_exact_delegated_chat_capabilities_keep_row_acl_and_unknown_routes_denied() {
    use crate::authorization::{AuthorizationDecision, Capability, RoutePolicy};
    let h = Harness::new();
    h.thread("alice-thread", "alice", "atlas").await;
    h.thread("bob-thread", "bob", "atlas").await;
    let before = serde_json::to_value(
        h.reopen()
            .get_summary("alice-thread")
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    for method in ["GET", "HEAD"] {
        let (status, _) = h
            .request_context(
                "alice",
                method,
                "/api/hierarchy/threads/alice-thread",
                Value::Null,
                delegated([Capability::ChatRead]),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    let denied = h
        .request_context(
            "alice",
            "PUT",
            "/api/hierarchy/threads/alice-thread/project",
            json!({"project_id":"changed"}),
            delegated([Capability::ChatRead]),
        )
        .await;
    assert_eq!(denied, (StatusCode::FORBIDDEN, Value::Null));
    assert_eq!(
        serde_json::to_value(
            h.reopen()
                .get_summary("alice-thread")
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        before
    );
    assert_eq!(
        h.request_context(
            "alice",
            "GET",
            "/api/hierarchy/threads/alice-thread",
            Value::Null,
            delegated([Capability::ChatWrite])
        )
        .await,
        (StatusCode::FORBIDDEN, Value::Null)
    );
    assert_eq!(
        h.request_context(
            "alice",
            "PUT",
            "/api/hierarchy/threads/alice-thread/project",
            json!({"project_id":"changed"}),
            delegated([Capability::ChatWrite])
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    assert_eq!(
        h.reopen()
            .thread_hierarchy("alice-thread")
            .await
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some("changed")
    );
    assert_eq!(
        h.request_context(
            "alice",
            "GET",
            "/api/hierarchy/threads/bob-thread",
            Value::Null,
            delegated([Capability::ChatRead])
        )
        .await,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden: you do not have access to this resource"})
        )
    );
    assert_eq!(
        h.request_context(
            "alice",
            "PUT",
            "/api/hierarchy/threads/bob-thread/project",
            json!({"project_id":"changed"}),
            delegated([Capability::ChatWrite])
        )
        .await,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden: you do not have access to this resource"})
        )
    );
    assert_eq!(
        h.reopen()
            .thread_hierarchy("bob-thread")
            .await
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some("atlas")
    );
    let now = crate::pairing::now_secs();
    let bindings = RequestBindings {
        subject_id: Some("alice".into()),
        ..Default::default()
    };
    let all = delegated([
        Capability::ChatRead,
        Capability::ChatWrite,
        Capability::GatewayRoute,
        Capability::MemoryWrite,
    ]);
    for (method, path) in [
        ("GET", "/api/hierarchy/main-threads"),
        ("HEAD", "/api/hierarchy/projects/atlas/threads"),
        ("GET", "/api/hierarchy/threads/alice-thread/sessions"),
        ("PUT", "/api/hierarchy/threads/alice-thread/project"),
        ("PUT", "/api/hierarchy/threads/alice-thread/coordination"),
    ] {
        let method: axum::http::Method = method.parse().unwrap();
        let policy = crate::server::route_policy(&method, path);
        let required = if method == axum::http::Method::GET || method == axum::http::Method::HEAD {
            Capability::ChatRead
        } else {
            Capability::ChatWrite
        };
        assert_eq!(policy, RoutePolicy::requires([required]));
        assert_eq!(
            delegated([required]).authorize(&policy, &bindings, now),
            AuthorizationDecision::Allow
        );
        assert_ne!(
            delegated([]).authorize(&policy, &bindings, now),
            AuthorizationDecision::Allow
        );
        assert_eq!(
            AuthorizationContext::owner(now).authorize(&policy, &bindings, now),
            AuthorizationDecision::Allow
        );
    }
    for (method, path) in [
        ("POST", "/api/hierarchy/main-threads"),
        ("DELETE", "/api/hierarchy/main-threads"),
        ("POST", "/api/hierarchy/threads/alice-thread/project"),
        ("PUT", "/api/hierarchy/threads/alice-thread"),
        ("GET", "/api/hierarchy/main-threads-extra"),
        ("GET", "/api/hierarchy/threads/alice-thread/extra"),
        ("GET", "/api/hierarchy/threads//sessions"),
        ("GET", "/api/hierarchy/projects/atlas/threads/extra"),
        ("GET", "/api/scope-defaults"),
        ("GET", "/api/hierarchy/effective-defaults"),
        ("PUT", "/api/scope-defaults/project:atlas"),
        ("POST", "/api/hierarchy/memory/rekey-project"),
    ] {
        let policy = crate::server::route_policy(&method.parse().unwrap(), path);
        assert_eq!(policy, RoutePolicy::OwnerOnly);
        assert_ne!(
            all.authorize(&policy, &bindings, now),
            AuthorizationDecision::Allow
        );
        assert_eq!(
            h.request_context("alice", method, path, json!({}), all.clone())
                .await,
            (StatusCode::FORBIDDEN, Value::Null)
        );
    }
}

#[tokio::test]
async fn scoped_chat_refusal_does_not_reserve_a_main_thread_slot() {
    let h = Harness::new();
    let input = json!({"owner_kind":"agent","owner_id":"ryu"});
    assert_eq!(
        h.request_context(
            "alice",
            "POST",
            "/api/hierarchy/main-threads",
            input.clone(),
            delegated([crate::authorization::Capability::ChatWrite]),
        )
        .await,
        (StatusCode::FORBIDDEN, Value::Null)
    );
    assert!(h
        .reopen()
        .find_main_thread(None, OwnerKind::Agent, "ryu")
        .await
        .unwrap()
        .is_none());
    let created = h
        .request("alice", "POST", "/api/hierarchy/main-threads", input)
        .await;
    assert_eq!(created.0, StatusCode::OK);
    assert_eq!(
        h.reopen()
            .find_main_thread(None, OwnerKind::Agent, "ryu")
            .await
            .unwrap()
            .as_deref(),
        created.1["conversation_id"].as_str()
    );
}

fn full_conversation_row(database: &std::path::Path, id: &str) -> Vec<rusqlite::types::Value> {
    rusqlite::Connection::open(database)
        .unwrap()
        .query_row("SELECT * FROM conversations WHERE id = ?1", [id], |row| {
            (0..row.as_ref().column_count())
                .map(|index| row.get(index))
                .collect()
        })
        .unwrap()
}

#[tokio::test]
async fn hierarchy_http_second_placement_write_refusal_rolls_back_complete_row_then_exact_retry_reopens(
) {
    let h = Harness::new();
    h.thread("atomic-child", "alice", "prior-project").await;
    h.thread("atomic-parent", "alice", "next-project").await;
    h.thread("other-parent", "alice", "other-project").await;
    h.thread("atomic-unrelated", "bob", "private-project").await;
    let child_before = full_conversation_row(&h.database, "atomic-child");
    let parent_before = full_conversation_row(&h.database, "atomic-parent");
    let unrelated_before = full_conversation_row(&h.database, "atomic-unrelated");
    let summary_before = serde_json::to_value(
        h.reopen()
            .get_summary("atomic-child")
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let payload = json!({"project_id":"next-project","spawned_by_conversation_id":"atomic-parent"});
    let sql = rusqlite::Connection::open(&h.database).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_second_placement_write BEFORE UPDATE OF spawned_by_conversation_id ON conversations WHEN NEW.id='atomic-child' BEGIN SELECT RAISE(ABORT, 'lineage refused after project update'); END;").unwrap();
    let refused = h
        .request(
            "alice",
            "PUT",
            "/api/hierarchy/threads/atomic-child/project",
            payload.clone(),
        )
        .await;
    assert_eq!(
        refused,
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"placing conversation in project"})
        )
    );
    assert_eq!(
        full_conversation_row(&h.database, "atomic-child"),
        child_before
    );
    assert_eq!(
        full_conversation_row(&h.database, "atomic-parent"),
        parent_before
    );
    assert_eq!(
        full_conversation_row(&h.database, "atomic-unrelated"),
        unrelated_before
    );
    assert_eq!(
        serde_json::to_value(
            h.reopen()
                .get_summary("atomic-child")
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        summary_before
    );
    assert_eq!(
        h.request(
            "alice",
            "GET",
            "/api/hierarchy/threads/atomic-parent/sessions",
            Value::Null
        )
        .await,
        (StatusCode::OK, json!({"sessions":[]}))
    );
    sql.execute_batch("DROP TRIGGER refuse_second_placement_write;")
        .unwrap();
    assert_eq!(
        h.request(
            "alice",
            "PUT",
            "/api/hierarchy/threads/atomic-child/project",
            payload
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    let reopened = h.reopen();
    let acknowledged = reopened
        .thread_hierarchy("atomic-child")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(acknowledged.project_id.as_deref(), Some("next-project"));
    assert_eq!(
        acknowledged.spawned_by_conversation_id.as_deref(),
        Some("atomic-parent")
    );
    assert!(acknowledged.spawned_by_message_id.is_none());
    let (status, sessions) = h
        .request(
            "alice",
            "GET",
            "/api/hierarchy/threads/atomic-parent/sessions",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["atomic-child"]
    );
    // Filing under another project keeps the established write-once lineage.
    assert_eq!(
        h.request(
            "alice",
            "PUT",
            "/api/hierarchy/threads/atomic-child/project",
            json!({"project_id":"other-project","spawned_by_conversation_id":"other-parent"})
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    let final_hierarchy = h
        .reopen()
        .thread_hierarchy("atomic-child")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(final_hierarchy.project_id.as_deref(), Some("other-project"));
    assert_eq!(
        final_hierarchy.spawned_by_conversation_id.as_deref(),
        Some("atomic-parent")
    );
    assert_eq!(
        h.request(
            "alice",
            "GET",
            "/api/hierarchy/threads/other-parent/sessions",
            Value::Null
        )
        .await,
        (StatusCode::OK, json!({"sessions":[]}))
    );
    assert_eq!(
        full_conversation_row(&h.database, "atomic-parent"),
        parent_before
    );
    assert_eq!(
        full_conversation_row(&h.database, "atomic-unrelated"),
        unrelated_before
    );
}

#[tokio::test]
async fn hierarchy_http_encoded_legal_scope_ids_put_and_delete_exact_decoded_keys() {
    let h = Harness::new();
    let value = json!({"provider":"p","model":"m","effort":"low","coordinatorProvider":"cp","coordinatorModel":"cm","coordinatorEffort":"high"});
    for (scope, encoded) in [
        ("agent:bot?1", "agent%3Abot%3F1"),
        ("project:p#1", "project%3Ap%231"),
        (
            "project:項目#1/agent:機器?1",
            "project%3A%E9%A0%85%E7%9B%AE%231/agent%3A%E6%A9%9F%E5%99%A8%3F1",
        ),
    ] {
        assert!(is_valid_scope(scope));
        let path = format!("/api/scope-defaults/{encoded}");
        assert_eq!(
            h.request("alice", "PUT", &path, value.clone()).await,
            (StatusCode::OK, json!({"ok":true}))
        );
        assert_eq!(
            serde_json::to_value(h.reopen().scope_default(scope).await.unwrap().unwrap()).unwrap(),
            value
        );
        let (status, list) = h
            .request("alice", "GET", "/api/scope-defaults", Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["defaults"].as_object().unwrap().len(), 1);
        assert_eq!(list["defaults"][scope], value);
        assert_eq!(
            h.request("alice", "DELETE", &path, Value::Null).await,
            (StatusCode::OK, json!({"ok":true}))
        );
        assert!(h.reopen().scope_default(scope).await.unwrap().is_none());
        assert_eq!(
            h.request("alice", "GET", "/api/scope-defaults", Value::Null)
                .await,
            (StatusCode::OK, json!({"defaults":{}}))
        );
    }
}

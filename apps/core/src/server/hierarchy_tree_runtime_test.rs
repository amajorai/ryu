//! The mounted tree route against a file SQLite store, with the real identity
//! projection and route policy in front of it. Global node registration and
//! JWT or delegation verification are not mocked here.

use super::super::routes;
use super::*;
use crate::authorization::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RequestBindings,
};
use crate::identity_verify::VerifiedCaller;
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::server::{
    attach_verified_caller, isolated_plugin_hook_test_state, ResolvedAuthorization,
};
use axum::{body::Body, http::Request, middleware, Router};
use serde_json::Value;
use tower::ServiceExt;

const ORG: &str = "org-hierarchy-tree";

struct Harness {
    // Held so the store file outlives the test.
    _directory: tempfile::TempDir,
    state: ServerState,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_node().is_none());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("hierarchy-tree.db");
        let mut state = isolated_plugin_hook_test_state(directory.path());
        state.conversations = ConversationStore::open_hook_test_file(database).unwrap();
        let router = routes()
            .with_state(state.clone())
            .layer(middleware::from_fn(attach_verified_caller))
            .layer(middleware::from_fn(authorize_resolved));
        Self {
            _directory: directory,
            state,
            router,
        }
    }

    /// One thread owned by `owner`, titled `title`.
    async fn thread(&self, id: &str, owner: &str, title: &str) {
        self.state
            .conversations
            .ensure_conversation(
                id,
                None,
                Some(title),
                Tenancy::Owned {
                    user_id: owner.into(),
                    org_id: Some(ORG.into()),
                },
            )
            .await
            .unwrap();
    }

    async fn spawn(&self, parent: &str, child: &str) {
        self.state
            .conversations
            .mark_spawned_by(child, parent, None)
            .await
            .unwrap();
    }

    async fn get(&self, user: &str, path: &str) -> (StatusCode, Value) {
        self.send(
            user,
            "GET",
            path,
            AuthorizationContext::owner(crate::pairing::now_secs()),
        )
        .await
    }

    async fn send(
        &self,
        user: &str,
        method: &str,
        path: &str,
        context: AuthorizationContext,
    ) -> (StatusCode, Value) {
        let caller = VerifiedCaller {
            user_id: user.into(),
            email: None,
            email_verified: false,
            org_id: Some(ORG.into()),
            role: crate::identity_verify::OrgRole::Member,
            teams: vec![],
        };
        // Start where production is after the credential is resolved. The real
        // identity middleware projects this caller into the handler.
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
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(resolved);
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
    }
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

fn delegated(capabilities: impl IntoIterator<Item = Capability>) -> AuthorizationContext {
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

/// `(id, parent_id)` of every node, sorted.
fn links(body: &Value) -> Vec<(String, Option<String>)> {
    let mut rows: Vec<_> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            (
                node["conversation"]["id"].as_str().unwrap().to_owned(),
                node["parent_id"].as_str().map(str::to_owned),
            )
        })
        .collect();
    rows.sort();
    rows
}

fn link(id: &str, parent: Option<&str>) -> (String, Option<String>) {
    (id.to_owned(), parent.map(str::to_owned))
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys
}

#[tokio::test]
async fn tree_http_three_level_nest_is_the_same_tree_from_every_thread_in_it() {
    let h = Harness::new();
    for id in ["root", "a", "b", "a1", "a2", "elsewhere"] {
        h.thread(id, "alice", &format!("Title of {id}")).await;
    }
    h.spawn("root", "a").await;
    h.spawn("root", "b").await;
    h.spawn("a", "a1").await;
    h.spawn("a", "a2").await;
    let expected = vec![
        link("a", Some("root")),
        link("a1", Some("a")),
        link("a2", Some("a")),
        link("b", Some("root")),
        link("root", None),
    ];
    for start in ["root", "a", "b", "a1", "a2"] {
        let (status, body) = h
            .get("alice", &format!("/api/hierarchy/threads/{start}/tree"))
            .await;
        assert_eq!(status, StatusCode::OK, "from {start}");
        assert_eq!(links(&body), expected, "from {start}");
        assert_eq!(body["truncated"], json!(false), "from {start}");
        assert_eq!(keys(&body), ["nodes", "truncated"], "from {start}");
        let nodes = body["nodes"].as_array().unwrap();
        // The root comes first and a parent always comes before its children.
        assert_eq!(nodes[0]["conversation"]["id"], json!("root"));
        for (index, node) in nodes.iter().enumerate() {
            assert_eq!(keys(node), ["conversation", "parent_id"]);
            if let Some(parent) = node["parent_id"].as_str() {
                let at = nodes
                    .iter()
                    .position(|other| other["conversation"]["id"] == json!(parent));
                assert!(at.is_some_and(|at| at < index), "from {start}");
            }
        }
        // Every row is the same summary the sessions route returns.
        let a1 = nodes
            .iter()
            .find(|node| node["conversation"]["id"] == json!("a1"))
            .unwrap();
        assert_eq!(a1["conversation"]["title"], json!("Title of a1"));
    }
    let (status, sessions) = h.get("alice", "/api/hierarchy/threads/a/sessions").await;
    assert_eq!(status, StatusCode::OK);
    let (_, tree) = h.get("alice", "/api/hierarchy/threads/a/tree").await;
    for session in sessions["sessions"].as_array().unwrap() {
        let node = tree["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["conversation"]["id"] == session["id"])
            .unwrap();
        assert_eq!(&node["conversation"], session);
    }
}

#[tokio::test]
async fn tree_http_hidden_rows_leak_no_title_id_or_count_and_their_children_move_up() {
    let h = Harness::new();
    h.thread("alice-root", "alice", "Alice root").await;
    h.thread("bob-mid", "bob", "Bob secret plan").await;
    h.thread("alice-leaf", "alice", "Alice leaf").await;
    h.thread("bob-leaf", "bob", "Bob secret notes").await;
    h.thread("bob-deep", "bob", "Bob secret depth").await;
    h.spawn("alice-root", "bob-mid").await;
    h.spawn("bob-mid", "alice-leaf").await;
    h.spawn("bob-mid", "bob-leaf").await;
    h.spawn("bob-leaf", "bob-deep").await;

    // Alice sees her two threads; her leaf hangs under the nearest thread she
    // can see, which is the root.
    for start in ["alice-root", "alice-leaf"] {
        let (status, body) = h
            .get("alice", &format!("/api/hierarchy/threads/{start}/tree"))
            .await;
        assert_eq!(status, StatusCode::OK, "from {start}");
        assert_eq!(
            links(&body),
            vec![
                link("alice-leaf", Some("alice-root")),
                link("alice-root", None)
            ],
            "from {start}"
        );
        assert_eq!(keys(&body), ["nodes", "truncated"], "from {start}");
        assert_eq!(body["truncated"], json!(false), "from {start}");
        let text = body.to_string();
        for hidden in ["bob", "Bob", "secret"] {
            assert!(!text.contains(hidden), "{hidden} leaked from {start}");
        }
        for node in body["nodes"].as_array().unwrap() {
            assert_eq!(keys(node), ["conversation", "parent_id"]);
            // The row's own parent link names the visible parent as well.
            assert_eq!(
                node["conversation"].get("spawned_by_conversation_id"),
                node.get("parent_id").filter(|parent| !parent.is_null()),
                "from {start}"
            );
        }
    }

    // Bob may not read the root. His threads form the tree he can see, and
    // Alice's leaf does not show.
    let (status, body) = h.get("bob", "/api/hierarchy/threads/bob-deep/tree").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        links(&body),
        vec![
            link("bob-deep", Some("bob-leaf")),
            link("bob-leaf", Some("bob-mid")),
            link("bob-mid", None),
        ]
    );
    let text = body.to_string();
    for hidden in ["alice", "Alice"] {
        assert!(!text.contains(hidden), "{hidden} leaked");
    }
}

#[tokio::test]
async fn tree_http_refuses_a_thread_the_caller_may_not_read_and_a_missing_one() {
    let h = Harness::new();
    h.thread("alice-root", "alice", "Alice root").await;
    h.thread("bob-child", "bob", "Bob secret plan").await;
    h.spawn("alice-root", "bob-child").await;
    assert_eq!(
        h.get("alice", "/api/hierarchy/threads/bob-child/tree")
            .await,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"forbidden: you do not have access to this resource"})
        )
    );
    assert_eq!(
        h.get("alice", "/api/hierarchy/threads/nope/tree").await,
        (
            StatusCode::NOT_FOUND,
            json!({"error":"conversation 'nope' not found"})
        )
    );
}

#[tokio::test]
async fn tree_http_needs_exactly_the_chat_read_capability() {
    let h = Harness::new();
    h.thread("root", "alice", "Root").await;
    h.thread("child", "alice", "Child").await;
    h.thread("bob-child", "bob", "Bob secret plan").await;
    h.spawn("root", "child").await;
    h.spawn("root", "bob-child").await;
    let path = "/api/hierarchy/threads/child/tree";
    let (status, body) = h
        .send("alice", "GET", path, delegated([Capability::ChatRead]))
        .await;
    assert_eq!(status, StatusCode::OK);
    // The capability opens the route; the per-row check still applies.
    assert_eq!(
        links(&body),
        vec![link("child", Some("root")), link("root", None)]
    );
    assert_eq!(
        h.send("alice", "GET", path, delegated([Capability::ChatWrite]))
            .await,
        (StatusCode::FORBIDDEN, Value::Null)
    );
    assert_eq!(
        h.send("alice", "POST", path, delegated([Capability::ChatRead]))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

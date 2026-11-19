//! Tests for [`super`] (forwarding KV v2 routes for shared values): the pure
//! request builders, and what the handlers forward or refuse first.

use super::*;

fn org_coords() -> CoordsBody {
    serde_json::from_value(json!({
        "scope": "org",
        "environment": "prod",
        "path": "/db",
    }))
    .expect("coords")
}

#[test]
fn forwarded_bodies_carry_the_coordinates_and_drop_nulls() {
    let mut extra = Map::new();
    extra.insert("versions".into(), json!([1, 2]));
    extra.insert("expectedVersion".into(), Value::Null);
    let body = shared_body("org-1", &org_coords(), extra);
    assert_eq!(
        body,
        json!({
            "scope": "org",
            "scopeId": "org-1",
            "environment": "prod",
            "path": "/db",
            "versions": [1, 2],
        })
    );
    // An MCP binding narrows the value, so it is forwarded with it.
    let bound: CoordsBody = serde_json::from_value(json!({
        "scope": "team",
        "scopeId": "team-1",
        "binding": { "kind": "mcp", "id": "github" },
    }))
    .expect("coords");
    let body = data_patch("team-1", "TOKEN", &bound, json!({}), None).body;
    assert_eq!(
        body,
        Some(json!({
            "scope": "team",
            "scopeId": "team-1",
            "binding": { "kind": "mcp", "id": "github" },
            "patch": {},
        }))
    );
}

#[test]
fn a_metadata_patch_forward_uses_rfc3339_keeps_custom_keys_and_its_cas() {
    let forward = metadata_patch(
        "org-1",
        "DB",
        &org_coords(),
        json!({
            "expiresAt": 1_893_456_000_000_i64,
            "customMetadata": { "reviewedAt": 1, "owner": "ops" },
            "description": null,
        }),
        Some(3),
    );
    assert_eq!(forward.method, reqwest::Method::PATCH);
    assert_eq!(forward.subpath, "/secrets/DB/metadata");
    assert!(forward.query.is_empty());
    assert!(!forward.vouch);
    let body = forward.body.expect("a body");
    assert_eq!(body["scopeId"], json!("org-1"));
    assert_eq!(body["expectedMetadataVersion"], json!(3));
    assert!(body["metadata"]["expiresAt"]
        .as_str()
        .is_some_and(|at| at.starts_with("2030-01-01T00:00:00")));
    // A user-defined `…At` key is not a timestamp.
    assert_eq!(
        body["metadata"]["customMetadata"],
        json!({ "reviewedAt": 1, "owner": "ops" })
    );
    // `null` inside the patch resets a field, so it is kept.
    assert_eq!(body["metadata"]["description"], Value::Null);
    assert!(body["metadata"]
        .as_object()
        .unwrap()
        .contains_key("description"));
    // Without a counter the field is left out (no check-and-set).
    let unchecked = metadata_patch("org-1", "DB", &org_coords(), json!({}), None);
    assert!(unchecked
        .body
        .unwrap()
        .get("expectedMetadataVersion")
        .is_none());
}

#[test]
fn a_data_patch_forward_carries_the_patch_and_expected_version() {
    let forward = data_patch(
        "org-1",
        "DB",
        &org_coords(),
        json!({ "user": "app", "updatedAt": 5 }),
        Some(7),
    );
    assert_eq!(
        forward,
        Forward {
            method: reqwest::Method::PATCH,
            subpath: "/secrets/DB/data".to_owned(),
            query: Vec::new(),
            // Value keys are user data: `updatedAt` stays a number.
            body: Some(json!({
                "scope": "org",
                "scopeId": "org-1",
                "environment": "prod",
                "path": "/db",
                "patch": { "user": "app", "updatedAt": 5 },
                "expectedVersion": 7,
            })),
            vouch: false,
        }
    );
}

#[test]
fn a_subkeys_forward_queries_the_shared_scope_and_depth_and_asks_for_the_vouch() {
    let pairs = |depth: Option<&str>| {
        let mut pairs = vec![
            ("scope".to_owned(), "org".to_owned()),
            ("scopeId".to_owned(), "org-1".to_owned()),
            ("environment".to_owned(), "prod".to_owned()),
            ("path".to_owned(), "/db".to_owned()),
        ];
        if let Some(depth) = depth {
            pairs.push(("depth".to_owned(), depth.to_owned()));
        }
        pairs
    };
    // The coordinates name no scope id: the shared one (the node's org) is used.
    let forward = subkeys("org-1", "A B", &org_coords(), Some(2));
    assert_eq!(
        forward,
        Forward {
            method: reqwest::Method::GET,
            subpath: "/secrets/A%20B/subkeys".to_owned(),
            query: pairs(Some("2")),
            body: None,
            // Subkeys take the reveal's proof (decision `subkeysProof`).
            vouch: true,
        }
    );
    assert_eq!(
        subkeys("org-1", "DB", &org_coords(), None).query,
        pairs(None)
    );
}

#[test]
fn version_forwards_name_delete_and_undelete_apart() {
    let expected = |suffix: &str| Forward {
        method: reqwest::Method::POST,
        subpath: format!("/secrets/DB/{suffix}"),
        query: Vec::new(),
        body: Some(json!({
            "scope": "org",
            "scopeId": "org-1",
            "environment": "prod",
            "path": "/db",
            "versions": [1, 3],
        })),
        vouch: false,
    };
    let coords = org_coords();
    assert_eq!(
        versions("org-1", "DB", &coords, &[1, 3], true),
        expected("versions/delete")
    );
    assert_eq!(
        versions("org-1", "DB", &coords, &[1, 3], false),
        expected("versions/undelete")
    );
}

#[test]
fn every_forward_is_a_proxied_route_and_only_subkeys_vouch() {
    let coords = org_coords();
    let forwards = [
        metadata_patch("o", "API", &coords, json!({}), None),
        data_patch("o", "API", &coords, json!({}), None),
        subkeys("o", "API", &coords, None),
        versions("o", "API", &coords, &[1], true),
        versions("o", "API", &coords, &[1], false),
    ];
    for forward in &forwards {
        assert!(
            crate::vault::shared::is_proxied_subpath(&forward.method, &forward.subpath),
            "{} {} must be a proxied subpath",
            forward.method,
            forward.subpath
        );
    }
    let vouches: Vec<bool> = forwards.iter().map(|forward| forward.vouch).collect();
    assert_eq!(vouches, [false, false, true, false, false]);
}

// ── Handlers: what is forwarded, and what never is ──────────────────

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;

use crate::server::vault_api::TEST_SHARED;
use crate::server::vault_kv_api::tests::{call, router};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

/// Every KV v2 route for value `name` (already URL-encoded) with the
/// coordinates `coords` (a JSON object of strings), as (method, uri, body).
fn kv_routes(name: &str, coords: &Value) -> Vec<(&'static str, String, Option<Value>)> {
    let object = coords.as_object().unwrap();
    let query: Vec<String> = object
        .iter()
        .map(|(key, value)| format!("{key}={}", value.as_str().unwrap()))
        .collect();
    let query = query.join("&");
    let with = |extra: Value| {
        let mut body = object.clone();
        body.extend(extra.as_object().unwrap().clone());
        Some(Value::Object(body))
    };
    let base = format!("/api/vault/secrets/{name}");
    vec![
        ("GET", format!("{base}/metadata?{query}"), None),
        (
            "PATCH",
            format!("{base}/metadata"),
            with(json!({ "metadata": { "description": "x" }, "expectedMetadataVersion": 4 })),
        ),
        (
            "PATCH",
            format!("{base}/data"),
            with(json!({ "patch": { "user": "x" }, "expectedVersion": 2 })),
        ),
        ("GET", format!("{base}/subkeys?{query}&depth=3"), None),
        (
            "POST",
            format!("{base}/versions/delete"),
            with(json!({ "versions": [1] })),
        ),
        (
            "POST",
            format!("{base}/versions/undelete"),
            with(json!({ "versions": [2] })),
        ),
    ]
}

/// The value routes (not KV v2) that forward one shared value.
fn value_routes(name: &str) -> [(&'static str, String, Option<Value>); 4] {
    let base = format!("/api/vault/secrets/{name}");
    [
        (
            "PUT",
            base.clone(),
            Some(json!({ "scope": "org", "value": "v" })),
        ),
        ("DELETE", format!("{base}?scope=org"), None),
        ("GET", format!("{base}/versions?scope=org"), None),
        (
            "POST",
            format!("{base}/reveal"),
            Some(json!({ "scope": "org" })),
        ),
    ]
}

#[tokio::test]
async fn handlers_forward_shared_values_and_refuse_project_scope_and_bad_names_first() {
    let _managed = crate::sidecar::gateway::lock_managed_node_env();
    crate::plugin_secrets::set_global(
        crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
    );
    let directory = tempfile::tempdir().unwrap();
    let operator = router(None, directory.path());
    let recorded = Arc::new(Mutex::new(Vec::<Forward>::new()));
    let taken = || std::mem::take(&mut *recorded.lock().unwrap());
    let run = async {
        let org = json!({ "scope": "org", "environment": "prod" });

        // An org value on a managed node: every route but the detailed
        // metadata read is forwarded, under the node's org id.
        let mut answers = Vec::new();
        for (method, uri, body) in kv_routes("DB", &org) {
            answers.push(call(&operator, method, &uri, body).await);
        }
        assert_eq!(
            answers[0].0,
            StatusCode::NOT_IMPLEMENTED,
            "{}",
            answers[0].1
        );
        assert!(
            answers[0].1.contains("vault_unsupported"),
            "{}",
            answers[0].1
        );
        for (status, text) in &answers[1..] {
            assert_eq!(*status, StatusCode::ACCEPTED, "{text}");
        }
        let sent = taken();
        let routes: Vec<(String, &str)> = sent
            .iter()
            .map(|forward| (forward.method.to_string(), forward.subpath.as_str()))
            .collect();
        assert_eq!(
            routes,
            [
                ("PATCH".to_owned(), "/secrets/DB/metadata"),
                ("PATCH".to_owned(), "/secrets/DB/data"),
                ("GET".to_owned(), "/secrets/DB/subkeys"),
                ("POST".to_owned(), "/secrets/DB/versions/delete"),
                ("POST".to_owned(), "/secrets/DB/versions/undelete"),
            ]
        );
        let body = |index: usize| sent[index].body.clone().unwrap_or(Value::Null);
        assert_eq!(body(0)["expectedMetadataVersion"], json!(4));
        assert_eq!(body(0)["metadata"], json!({ "description": "x" }));
        assert_eq!(body(1)["expectedVersion"], json!(2));
        assert_eq!(body(1)["patch"], json!({ "user": "x" }));
        assert_eq!(body(3)["versions"], json!([1]));
        assert_eq!(body(4)["versions"], json!([2]));
        for index in [0, 1, 3, 4] {
            assert_eq!(body(index)["scopeId"], json!("org-1"), "{:?}", sent[index]);
        }
        let query = &sent[2].query;
        assert!(
            query.contains(&("scopeId".to_owned(), "org-1".to_owned())),
            "{query:?}"
        );
        assert!(
            query.contains(&("depth".to_owned(), "3".to_owned())),
            "{query:?}"
        );
        // Subkeys ask for the vouch (see the builder tests), but a request
        // with no JWT to forward (nor the owner token) never carries it.
        let vouches: Vec<bool> = sent.iter().map(|forward| forward.vouch).collect();
        assert_eq!(vouches, [false; 5]);

        // A request never names a project value (`SecretScope::Project` is not
        // deserialized), so it is refused with 400 and never forwarded.
        let project = json!({ "scope": "project", "scopeId": "proj-1" });
        for (method, uri, body) in kv_routes("DB", &project) {
            let (status, text) = call(&operator, method, &uri, body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}: {text}");
        }

        // A name that is not an identifier is refused before any forward, on
        // the KV routes and on the value routes that forward one value.
        for name in ["%2E%2E", "%2E"] {
            let routes = kv_routes(name, &org).into_iter().chain(value_routes(name));
            for (method, uri, body) in routes {
                let (status, text) = call(&operator, method, &uri, body).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}: {text}");
                assert!(text.contains("environment-compatible"), "{text}");
            }
        }
        assert!(taken().is_empty(), "nothing else may be forwarded");
        // The value routes with a valid name do reach their forward.
        for (method, uri, body) in value_routes("DB") {
            let (status, text) = call(&operator, method, &uri, body).await;
            assert_eq!(status, StatusCode::ACCEPTED, "{method} {uri}: {text}");
        }
        let routes: Vec<(String, String)> = taken()
            .into_iter()
            .map(|forward| (forward.method.to_string(), forward.subpath))
            .collect();
        let expected = [
            ("PUT", "/secrets/DB"),
            ("DELETE", "/secrets/DB"),
            ("GET", "/secrets/DB/versions"),
            ("POST", "/secrets/DB/reveal"),
        ]
        .map(|(method, subpath)| (method.to_owned(), subpath.to_owned()));
        assert_eq!(routes, expected);
    };
    with_test_node_binding(
        true,
        Some(org_node()),
        TEST_SHARED.scope((), RECORDED.scope(Arc::clone(&recorded), run)),
    )
    .await;
}

#[tokio::test]
async fn only_subkeys_carry_the_vouch_for_a_local_owner_with_a_verified_jwt() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let _managed = crate::sidecar::gateway::lock_managed_node_env();
    crate::plugin_secrets::set_global(
        crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
    );
    let directory = tempfile::tempdir().unwrap();
    let owner = crate::identity_verify::VerifiedCaller {
        user_id: "user-kv".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: crate::identity_verify::OrgRole::Owner,
        teams: Vec::new(),
    };
    let app = router(Some(owner), directory.path());
    let recorded = Arc::new(Mutex::new(Vec::<Forward>::new()));
    let run = async {
        // The forwarded JWT verifies to the same user and org as the caller.
        let claims = json!({
            "id": "user-kv",
            "sub": "user-kv",
            "orgs": [{ "id": "org-1", "role": "owner" }],
        });
        let jwt =
            crate::server::cloud_environments::tests::signed_user_jwt_with_claims(claims, 600)
                .await;
        let org = json!({ "scope": "org", "environment": "prod" });
        for (method, uri, body) in kv_routes("DB", &org).into_iter().skip(1) {
            let request = Request::builder()
                .method(method)
                .uri(&uri)
                .header("content-type", "application/json")
                .header("x-ryu-user-jwt", &jwt)
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap();
            // A request at this machine admitted with the owner token.
            let response = crate::server::REQUEST_PEER_IS_LOCAL
                .scope(
                    true,
                    crate::server::REQUEST_PRESENTS_OWNER_TOKEN
                        .scope(true, app.clone().oneshot(request)),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::ACCEPTED, "{method} {uri}");
        }
    };
    with_test_node_binding(
        true,
        Some(org_node()),
        TEST_SHARED.scope((), RECORDED.scope(Arc::clone(&recorded), run)),
    )
    .await;
    let sent = std::mem::take(&mut *recorded.lock().unwrap());
    let proofs: Vec<(&str, bool)> = sent
        .iter()
        .map(|forward| (forward.subpath.as_str(), forward.vouch))
        .collect();
    assert_eq!(
        proofs,
        [
            ("/secrets/DB/metadata", false),
            ("/secrets/DB/data", false),
            ("/secrets/DB/subkeys", true),
            ("/secrets/DB/versions/delete", false),
            ("/secrets/DB/versions/undelete", false),
        ]
    );
}

#[tokio::test]
async fn only_team_and_org_values_are_shared_while_sharing_is_enabled() {
    use crate::plugin_secrets::SecretScope;

    let store = Box::leak(Box::new(
        crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
    ));
    let ctx = Ctx::test_member(store, "alice", Vec::new());
    TEST_SHARED
        .scope((), async {
            assert!(crate::server::vault_api::shared_enabled());
            assert!(ctx.shared_remote(SecretScope::Team));
            assert!(ctx.shared_remote(SecretScope::Org));
            for scope in [SecretScope::Project, SecretScope::User, SecretScope::Node] {
                assert!(!ctx.shared_remote(scope), "{scope:?}");
            }
        })
        .await;
}

//! Token, lease, quota and wrapping routes over the shipping vault routers.
//!
//! Effects are read back from the vault store the handlers resolve (the
//! process global; an in-memory store is published, first set wins), so each
//! test names its identities, roles and quotas uniquely. Timestamps in route
//! bodies are RFC 3339 strings, so lifecycle assertions use the store.
use super::*;
use crate::identity_verify::OrgRole;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::vault::dynamic::ProviderConfig;
use crate::vault::machine::AuthMethod;
use axum::body::Body;
use tower::ServiceExt;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

fn vault() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

async fn send(
    caller: Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    vault();
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
        .merge(public_routes())
        .layer(axum::Extension(caller))
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

async fn identity() -> crate::vault::machine::MachineIdentity {
    vault()
        .machine_create(
            &unique("ci-"),
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            Vec::new(),
            None,
            &AuditActor::system(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn tokens_renew_within_their_max_and_revoke_orphan_keeps_children() {
    with_test_node_binding(false, None, async {
        let store = vault();
        let machine = identity().await;
        let (status, created) = send(
            None,
            "POST",
            "/api/vault/tokens",
            Some(json!({
                "identity": machine.name,
                "ttlSecs": 60,
                "explicitMaxTtlSecs": 600,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let raw_token = created["token"]["token"].as_str().unwrap().to_owned();
        let parent = created["token"]["accessor"].as_str().unwrap().to_owned();
        let child = store
            .token_create_child(
                &parent,
                &[],
                &machine.id,
                tokens::TokenRequest::default(),
                &AuditActor::system(),
            )
            .await
            .unwrap();

        // Lookup by accessor returns metadata, never the token itself.
        let (status, looked_up) =
            send(None, "GET", &format!("/api/vault/tokens/{parent}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(looked_up["token"]["accessor"], parent.as_str());
        assert!(!looked_up.to_string().contains(&raw_token));

        // Renewal extends the expiry, but never past the explicit max TTL.
        let before = store.token_info(&parent).await.unwrap();
        let (status, renewed) = send(
            None,
            "POST",
            &format!("/api/vault/tokens/{parent}/renew"),
            Some(json!({ "incrementSecs": 300 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{renewed}");
        let after = store.token_info(&parent).await.unwrap();
        assert!(after.expires_at > before.expires_at + 200_000, "{after:?}");
        let (status, _) = send(
            None,
            "POST",
            &format!("/api/vault/tokens/{parent}/renew"),
            Some(json!({ "incrementSecs": 100_000 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let capped = store.token_info(&parent).await.unwrap();
        assert_eq!(Some(capped.expires_at), capped.max_expires_at);

        // Revoke-orphan ends the parent but keeps its child alive, detached.
        let (status, report) = send(
            None,
            "POST",
            &format!("/api/vault/tokens/{parent}/revoke-orphan"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert_eq!(report["revoked"]["tokens"], 1);
        assert!(store
            .token_info(&parent)
            .await
            .unwrap()
            .revoked_at
            .is_some());
        let orphan = store.token_info(&child.accessor).await.unwrap();
        assert!(orphan.revoked_at.is_none());
        assert!(orphan.orphan);
        assert_eq!(orphan.parent_accessor, None);
        assert!(store.token_lookup(&child.token).await.unwrap().is_some());

        // A revoked token cannot be renewed back to life.
        let (status, _) = send(
            None,
            "POST",
            &format!("/api/vault/tokens/{parent}/renew"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = send(None, "GET", "/api/vault/tokens/rva_missing", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}

#[tokio::test]
async fn leases_look_up_revoke_by_prefix_and_tidy() {
    with_test_node_binding(false, None, async {
        let store = vault();
        let actor = AuditActor::system();
        let random = ProviderConfig::Random {
            length: 16,
            charset: crate::plugin_secrets::kv::Charset::Hex,
            field: None,
        };
        let (revoked_role, kept_role) = (unique("lpa"), unique("lpb"));
        for role in [&revoked_role, &kept_role] {
            store
                .dynamic_put_role(role, &random, Some(600), Some(600), &actor)
                .await
                .unwrap();
        }
        let issue = |role: String| async move {
            vault()
                .dynamic_issue(&role, None, Some("machine:x"), &AuditActor::system())
                .await
                .unwrap()
                .lease
                .id
        };
        let first = issue(revoked_role.clone()).await;
        let second = issue(revoked_role.clone()).await;
        let kept = issue(kept_role.clone()).await;

        let (status, lease) = send(
            None,
            "GET",
            &format!("/api/vault/sys/leases/lookup/{first}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{lease}");
        assert_eq!(lease["lease"]["role"], revoked_role.as_str());
        assert!(lease["ttlSecs"].as_i64().unwrap() > 500);
        let (status, _) = send(
            None,
            "GET",
            "/api/vault/sys/leases/lookup/lease_missing",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, report) = send(
            None,
            "POST",
            "/api/vault/sys/leases/revoke-prefix",
            Some(json!({ "prefix": format!("{revoked_role}/") })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert_eq!(report["report"]["revoked"], 2);
        assert_eq!(report["report"]["failed"], json!([]));
        for id in [&first, &second] {
            assert!(store.lease_get(id).await.unwrap().revoked_at.is_some());
        }
        assert!(store.lease_get(&kept).await.unwrap().revoked_at.is_none());
        let (status, _) = send(
            None,
            "POST",
            "/api/vault/sys/leases/revoke-prefix",
            Some(json!({ "prefix": " " })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Tidy deletes revoked rows past the cutoff and leaves live ones. Building
        // the request state alone outlasts the 1 ms timestamp granularity.
        let (status, tidy) = send(
            None,
            "POST",
            "/api/vault/sys/leases/tidy",
            Some(json!({ "olderThanSecs": 0 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{tidy}");
        assert!(tidy["report"]["deleted"].as_u64().unwrap() >= 2, "{tidy}");
        assert!(store.lease_get(&first).await.is_err());
        assert!(store.lease_get(&kept).await.unwrap().revoked_at.is_none());
    })
    .await;
}

#[tokio::test]
async fn quotas_are_created_listed_replaced_and_deleted() {
    with_test_node_binding(false, None, async {
        let name = unique("q-");
        let uri = format!("/api/vault/sys/quotas/{name}");
        let (status, created) = send(
            None,
            "PUT",
            &uri,
            Some(json!({ "kind": "lease-count", "role": "db-*", "maxLeases": 3 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let listed = |body: &Value| {
            body["quotas"]
                .as_array()
                .unwrap()
                .iter()
                .find(|quota| quota["name"] == name.as_str())
                .cloned()
        };
        let (_, all) = send(None, "GET", "/api/vault/sys/quotas", None).await;
        let quota = listed(&all).expect("the quota is listed");
        assert_eq!(quota["kind"], "lease-count", "{quota}");
        assert_eq!(quota["maxLeases"], 3, "{quota}");

        let (status, _) = send(
            None,
            "PUT",
            &uri,
            Some(json!({ "kind": "rate-limit", "path": "auth/", "rate": 5 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, all) = send(None, "GET", "/api/vault/sys/quotas", None).await;
        assert_eq!(listed(&all).unwrap()["kind"], "rate-limit");

        // An invalid rule is refused and the stored one is unchanged.
        let (status, _) = send(
            None,
            "PUT",
            &uri,
            Some(json!({ "kind": "lease-count", "role": "db", "maxLeases": -1 })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, all) = send(None, "GET", "/api/vault/sys/quotas", None).await;
        assert_eq!(listed(&all).unwrap()["kind"], "rate-limit");

        let (status, deleted) = send(None, "DELETE", &uri, None).await;
        assert_eq!(
            (status, deleted),
            (StatusCode::OK, json!({ "deleted": true }))
        );
        let (_, all) = send(None, "GET", "/api/vault/sys/quotas", None).await;
        assert!(listed(&all).is_none());
        let (_, again) = send(None, "DELETE", &uri, None).await;
        assert_eq!(again, json!({ "deleted": false }));
    })
    .await;
}

#[tokio::test]
async fn wrapped_data_unwraps_exactly_once() {
    with_test_node_binding(false, None, async {
        let (status, wrapped) = send(
            None,
            "POST",
            "/api/vault/sys/wrapping/wrap",
            Some(json!({ "password": "hunter2-wrapped" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{wrapped}");
        assert!(!wrapped.to_string().contains("hunter2-wrapped"));
        let token = wrapped["wrapInfo"]["token"].as_str().unwrap().to_owned();

        let (status, _) = send(
            None,
            "POST",
            "/api/vault/sys/wrapping/lookup",
            Some(json!({ "token": token })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, unwrapped) = send(
            None,
            "POST",
            "/api/vault/sys/wrapping/unwrap",
            Some(json!({ "token": token })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(unwrapped, json!({ "password": "hunter2-wrapped" }));
        let (status, _) = send(
            None,
            "POST",
            "/api/vault/sys/wrapping/unwrap",
            Some(json!({ "token": token })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            None,
            "POST",
            "/api/vault/sys/wrapping/wrap",
            Some(json!(["not", "an", "object"])),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    })
    .await;
}

#[tokio::test]
async fn a_member_without_vault_grants_is_refused_and_changes_nothing() {
    let machine = with_test_node_binding(false, None, identity()).await;
    let token = vault()
        .token_create_for_identity(
            &machine.id,
            tokens::TokenRequest::default(),
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org-vt".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-vt".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    let quota = unique("q-");
    with_test_node_binding(false, Some(node), async {
        let member = Some(VerifiedCaller {
            user_id: "member".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-vt".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        });
        for (method, uri, body) in [
            ("GET", "/api/vault/tokens".to_owned(), None),
            (
                "POST",
                format!("/api/vault/tokens/{}/revoke-orphan", token.accessor),
                None,
            ),
            (
                "POST",
                format!("/api/vault/tokens/{}/renew", token.accessor),
                None,
            ),
            ("GET", "/api/vault/sys/leases".to_owned(), None),
            (
                "POST",
                "/api/vault/sys/leases/revoke-prefix".to_owned(),
                Some(json!({ "prefix": "a" })),
            ),
            ("POST", "/api/vault/sys/leases/tidy".to_owned(), None),
            (
                "PUT",
                format!("/api/vault/sys/quotas/{quota}"),
                Some(json!({ "kind": "rate-limit", "rate": 1 })),
            ),
            (
                "POST",
                "/api/vault/sys/wrapping/wrap".to_owned(),
                Some(json!({ "a": 1 })),
            ),
        ] {
            let (status, body) = send(member.clone(), method, &uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    })
    .await;
    let store = vault();
    assert!(store
        .token_info(&token.accessor)
        .await
        .unwrap()
        .revoked_at
        .is_none());
    assert!(!store
        .quota_list()
        .await
        .unwrap()
        .iter()
        .any(|existing| existing.name == quota));
}

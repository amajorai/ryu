//! Tests for [`super`] (KV v2 metadata routes), kept beside it so the route
//! module stays within the file limits.

use super::*;

#[test]
fn custom_metadata_bypasses_timestamp_conversion() {
    let mut body = json!({
        "metadata": {
            "expiresAt": "2030-01-01T00:00:00Z",
            "customMetadata": { "reviewedAt": "last week" },
        },
    });
    let custom = take_custom_metadata(&mut body);
    let converted = super::super::vault_api::millis_fields(body).unwrap();
    assert!(converted["metadata"]["expiresAt"].is_i64());
    let mut metadata = converted.get("metadata").cloned();
    restore_custom_metadata(&mut metadata, custom);
    assert_eq!(
        metadata.unwrap()["customMetadata"]["reviewedAt"],
        json!("last week")
    );
    let mut none = None;
    restore_custom_metadata(&mut none, None);
    assert!(none.is_none());
}

#[test]
fn routes_merge_beside_the_existing_secret_action_routes() {
    // Router construction panics on an overlapping path or method.
    let _router = super::super::vault_routes();
}

// ── Handler-level authorization ──────────────────────────────────────

use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

use crate::identity_verify::OrgRole;
use crate::plugin_secrets::kv::Environment;
use crate::plugin_secrets::kv::WriteRequest;
use crate::plugin_secrets::{PluginSecretStore, SecretMetadataPatch, SecretScope, VersionSource};
use crate::vault::audit::AuditActor;
use crate::vault::policy::{Policy, PolicyRule};

pub(crate) fn member(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

pub(crate) fn router(caller: Option<VerifiedCaller>, directory: &std::path::Path) -> Router {
    super::super::vault_routes()
        .layer(Extension(caller))
        .with_state(super::super::isolated_plugin_hook_test_state(directory))
}

pub(crate) async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(match body {
            Some(body) => Body::from(serde_json::to_vec(&body).unwrap()),
            None => Body::empty(),
        })
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// Bind `user:<user>` to a policy denying `capabilities` under `environment`.
async fn deny(
    store: &PluginSecretStore,
    user: &str,
    environment: &str,
    capabilities: Vec<Capability>,
) {
    let conn = store.conn.lock().await;
    let name = format!("deny-{user}");
    crate::vault::policy::put_policy(
        &conn,
        &Policy {
            name: name.clone(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: format!("{environment}/**"),
                capabilities,
                deny: true,
                ..Default::default()
            }],
        },
    )
    .unwrap();
    crate::vault::policy::bind(&conn, &name, &format!("user:{user}"), None, None).unwrap();
}

async fn seed(store: &PluginSecretStore, environment: &str, protected: bool) {
    let actor = AuditActor::new("operator", None);
    store
        .put_environment(
            &Environment {
                slug: environment.to_owned(),
                name: environment.to_owned(),
                protected,
                required_approvals: 1,
                position: 50,
                cas_required: false,
            },
            &actor,
        )
        .await
        .unwrap();
    let coords = SecretCoords {
        scope: SecretScope::Node,
        scope_id: crate::server::agent_sync::local_node_id(),
        environment: environment.to_owned(),
        path: "/".to_owned(),
        binding: None,
        name: "DB".to_owned(),
    };
    for value in [r#"{"user":"app"}"#, r#"{"user":"app2"}"#] {
        store
            .write_secret(WriteRequest {
                coords: coords.clone(),
                value: Some(value),
                patch: SecretMetadataPatch::default(),
                actor: &actor,
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
    }
}

/// Every KV v2 route, as (method, path suffix, body) for value `DB`.
fn kv_requests(environment: &str) -> Vec<(&'static str, String, Option<Value>)> {
    let query = format!("?scope=node&environment={environment}");
    let coords = json!({ "scope": "node", "environment": environment });
    let with = |extra: Value| {
        let mut body = coords.clone();
        if let (Some(body), Value::Object(extra)) = (body.as_object_mut(), extra) {
            body.extend(extra);
        }
        Some(body)
    };
    vec![
        (
            "GET",
            format!("/api/vault/secrets/DB/metadata{query}"),
            None,
        ),
        ("GET", format!("/api/vault/secrets/DB/subkeys{query}"), None),
        (
            "PATCH",
            "/api/vault/secrets/DB/metadata".to_owned(),
            with(json!({ "metadata": { "description": "x" } })),
        ),
        (
            "PATCH",
            "/api/vault/secrets/DB/data".to_owned(),
            with(json!({ "patch": { "user": "x" }, "expectedVersion": 2 })),
        ),
        (
            "POST",
            "/api/vault/secrets/DB/versions/delete".to_owned(),
            with(json!({ "versions": [1] })),
        ),
        (
            "POST",
            "/api/vault/secrets/DB/versions/undelete".to_owned(),
            with(json!({ "versions": [1] })),
        ),
    ]
}

#[tokio::test]
async fn kv_routes_enforce_capabilities_protection_and_metadata_cas() {
    let _managed = crate::sidecar::gateway::lock_managed_node_env();
    assert!(crate::sidecar::control_plane::registered_node().is_none());
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    let store = crate::plugin_secrets::global().expect("a published store");
    let directory = tempfile::tempdir().unwrap();
    let tag = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let open_env = format!("kvr-{tag}");
    let protected_env = format!("kvp-{tag}");
    seed(store, &open_env, false).await;
    seed(store, &protected_env, true).await;

    // Each capability, denied alone, refuses exactly the routes that need it.
    let needs: [(Capability, &[usize]); 4] = [
        (Capability::List, &[0]),
        (Capability::Read, &[1]),
        (Capability::Write, &[2, 3, 5]),
        (Capability::Delete, &[4]),
    ];
    for (capability, routes) in needs {
        let user = format!("kv-{}-{tag}", capability.as_str());
        deny(store, &user, &open_env, vec![capability]).await;
        let router = router(Some(member(&user)), directory.path());
        for (index, (method, uri, body)) in kv_requests(&open_env).into_iter().enumerate() {
            let (status, text) = call(&router, method, &uri, body).await;
            if routes.contains(&index) {
                assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
                assert!(text.contains(capability.as_str()), "{text}");
            } else {
                assert_ne!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
            }
        }
    }

    // Write without admin in a protected environment: reads pass, every
    // mutation is refused.
    let writer = format!("kv-writer-{tag}");
    deny(store, &writer, &protected_env, vec![Capability::Admin]).await;
    let router_writer = router(Some(member(&writer)), directory.path());
    for (index, (method, uri, body)) in kv_requests(&protected_env).into_iter().enumerate() {
        let (status, text) = call(&router_writer, method, &uri, body).await;
        if index < 2 {
            assert_eq!(status, StatusCode::OK, "{method} {uri}: {text}");
        } else {
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
            assert!(text.contains("protected environment"), "{text}");
        }
    }

    // Metadata check-and-set: stale is 409, current succeeds. The routes
    // above may have changed the metadata, so read the counter first.
    let operator = router(None, directory.path());
    let (status, text) = call(
        &operator,
        "GET",
        &format!("/api/vault/secrets/DB/metadata?scope=node&environment={open_env}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let current = serde_json::from_str::<Value>(&text).unwrap()["secret"]["metadataVersion"]
        .as_i64()
        .expect("metadataVersion");
    let patch = |expected: i64| {
        Some(json!({
            "scope": "node",
            "environment": open_env,
            "metadata": { "description": "rotated monthly" },
            "expectedMetadataVersion": expected,
        }))
    };
    let (status, text) = call(
        &operator,
        "PATCH",
        "/api/vault/secrets/DB/metadata",
        patch(current + 5),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{text}");
    let (status, text) = call(
        &operator,
        "PATCH",
        "/api/vault/secrets/DB/metadata",
        patch(current),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");

    // Version summaries are only served for a bounded page.
    let (status, text) = call(&operator, "GET", "/api/vault/secrets?detailed=true", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
    let (status, text) = call(
        &operator,
        "GET",
        &format!("/api/vault/secrets?detailed=true&limit=10&environment={open_env}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let listed: Value = serde_json::from_str(&text).unwrap();
    let versions = listed["secrets"][0]["versions"]
        .as_array()
        .expect("versions");
    assert!(versions.len() >= 2, "{text}");
    assert_eq!(versions[0]["current"], json!(true));

    // Parameter constraints gate the merged value of a data patch, and a
    // control group on read gates subkeys.
    let constrained = format!("kv-params-{tag}");
    {
        let conn = store.conn.lock().await;
        let name = format!("params-{constrained}");
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: name.clone(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: format!("{open_env}/**"),
                    capabilities: vec![Capability::Read, Capability::Write],
                    deny: false,
                    allowed_parameters: Some(std::collections::BTreeMap::from([(
                        "user".to_owned(),
                        vec!["app*".to_owned()],
                    )])),
                    required_parameters: vec!["user".to_owned()],
                    control_group: Some(crate::vault::policy_ext::ControlGroupSpec {
                        ttl_secs: None,
                        factors: vec![crate::vault::policy_ext::ControlGroupFactor {
                            name: "security".into(),
                            approvers: vec!["user:bob".into()],
                            approvals: 1,
                        }],
                    }),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        crate::vault::policy::bind(&conn, &name, &format!("user:{constrained}"), None, None)
            .unwrap();
    }
    let router_constrained = router(Some(member(&constrained)), directory.path());
    let data_patch =
        |patch: Value| Some(json!({ "scope": "node", "environment": open_env, "patch": patch }));
    for refused in [json!({ "user": "root" }), json!({ "user": null })] {
        let (status, text) = call(
            &router_constrained,
            "PATCH",
            "/api/vault/secrets/DB/data",
            data_patch(refused.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}: {text}");
        assert!(text.contains("vault_denied"), "{text}");
    }
    let (status, text) = call(
        &router_constrained,
        "PATCH",
        "/api/vault/secrets/DB/data",
        data_patch(json!({ "user": "app9" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let (status, text) = call(
        &router_constrained,
        "GET",
        &format!("/api/vault/secrets/DB/subkeys?scope=node&environment={open_env}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert!(text.contains("vault_control_group_required"), "{text}");
}

#[test]
fn version_bodies_require_a_versions_list() {
    assert!(serde_json::from_value::<VersionsBody>(json!({ "versions": [1, 2] })).is_ok());
    assert!(serde_json::from_value::<VersionsBody>(json!({})).is_err());
    assert!(serde_json::from_value::<DataPatchBody>(json!({ "scope": "user" })).is_err());
}

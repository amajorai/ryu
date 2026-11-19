//! `GET /api/vault/capabilities-accessor`: an administrator sees a machine
//! token's capabilities, with no baseline, and nothing once it is revoked.

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::machine::AuthMethod;
use crate::vault::policy::{Policy, PolicyRule};

fn rule(path: &str, capabilities: &[Capability], deny: bool) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: capabilities.to_vec(),
        deny,
        ..Default::default()
    }
}

/// A person on an org node: an administrator only when `policy` makes them one.
fn person(store: &'static PluginSecretStore, policy: Option<Policy>) -> Ctx {
    Ctx {
        store,
        node: None,
        node_id: "node-1".to_owned(),
        caller: Some(VerifiedCaller {
            user_id: "alice".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }),
        manager: false,
        policies: policy.into_iter().collect(),
        jwt: None,
    }
}

/// A store with a `ci` policy and a live AppRole token holding it.
async fn token_holder() -> (&'static PluginSecretStore, String) {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let admin = AuditActor::new("user", Some("admin"));
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: "ci".into(),
                description: String::new(),
                rules: vec![
                    rule("staging/**", &[Capability::List, Capability::Read], false),
                    rule("staging/app/ROOT", &[Capability::Read], true),
                    rule("sys/transit/build", &[Capability::Use], false),
                ],
            },
        )
        .unwrap();
    }
    let identity = store
        .machine_create(
            "ci-runner",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["ci".into()],
            Some(600),
            &admin,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("an AppRole identity");
    };
    let (secret_id, _) = store
        .machine_issue_secret_id("ci-runner", None, None, &admin)
        .await
        .unwrap();
    let issued = store.approle_login(&role_id, &secret_id).await.unwrap();
    (store, issued.accessor)
}

fn machine_admin() -> Policy {
    Policy {
        name: "token-admin".into(),
        description: String::new(),
        rules: vec![rule("sys/machines", &[Capability::Admin], false)],
    }
}

async fn answer(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn an_administrator_sees_the_tokens_own_capabilities() {
    let (store, accessor) = token_holder().await;
    let admin = person(store, Some(machine_admin()));
    let (status, body) = answer(
        capabilities_accessor_with(
            &admin,
            &accessor,
            "staging/app/API_KEY, staging/app/ROOT,sys/transit/build,prod/app/API_KEY,sys/machines",
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accessor"], accessor);
    assert!(body["identityId"].as_str().is_some_and(|id| !id.is_empty()));
    let caps = |key: &str| body["paths"][key]["capabilities"].clone();
    assert_eq!(caps("staging/app/API_KEY"), json!(["list", "read"]));
    assert_eq!(caps("staging/app/ROOT"), json!(["list"]));
    assert_eq!(caps("sys/transit/build"), json!(["use"]));
    // No baseline: the token has nothing its policies do not grant, and
    // none of the administrator's own capabilities leak into the answer.
    assert_eq!(caps("prod/app/API_KEY"), json!([]));
    assert_eq!(caps("sys/machines"), json!([]));
    assert!(body.get("value").is_none());
}

#[tokio::test]
async fn non_administrators_unknown_and_revoked_tokens_and_bad_paths_are_refused() {
    let (store, accessor) = token_holder().await;
    let member = person(store, None);
    let (status, _) =
        answer(capabilities_accessor_with(&member, &accessor, "staging/app/X").await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let admin = person(store, Some(machine_admin()));
    let (status, _) =
        answer(capabilities_accessor_with(&admin, "acc_missing", "staging/app/X").await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for paths in ["", " , "] {
        let (status, _) = answer(capabilities_accessor_with(&admin, &accessor, paths).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{paths:?}");
    }
    let many = vec!["staging/app/A"; MAX_CAPABILITY_PATHS + 1].join(",");
    let (status, _) = answer(capabilities_accessor_with(&admin, &accessor, &many).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    store
        .token_revoke(&accessor, &AuditActor::new("user", Some("admin")))
        .await
        .unwrap();
    let (status, _) =
        answer(capabilities_accessor_with(&admin, &accessor, "staging/app/X").await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

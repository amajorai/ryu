use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::{PluginSecretStore, SecretScope};
use crate::vault::policy::{Policy, PolicyRule};
use crate::vault::policy_ext::ControlGroupFactor;

fn user(id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

fn gate(read: bool) -> Policy {
    Policy {
        name: "gate".into(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: "**".into(),
            capabilities: vec![Capability::Read],
            deny: !read,
            control_group: read.then(|| ControlGroupSpec {
                ttl_secs: None,
                factors: vec![ControlGroupFactor {
                    name: "security".into(),
                    approvers: vec!["user:bob".into()],
                    approvals: 1,
                }],
            }),
            ..Default::default()
        }],
    }
}

fn ctx_for(store: &'static PluginSecretStore, id: &str, policy: Policy) -> Ctx {
    Ctx {
        store,
        node: None,
        node_id: "node-1".to_owned(),
        caller: Some(user(id)),
        manager: true,
        policies: vec![policy],
        jwt: None,
    }
}

async fn body_json(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn gated_reveal_needs_an_approver_and_redeems_once() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    store
        .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
        .await
        .unwrap();
    let alice = ctx_for(store, "alice", gate(true));
    let bob = ctx_for(store, "bob", gate(true));
    let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
    assert!(!alice.can_read_directly(&coords), "exports must skip it");
    let spec = alice.read_control_group(&coords).expect("gated");

    let response = open_control_group(&alice, &coords, None, &spec).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let opened = body_json(response).await;
    assert!(opened.get("value").is_none());
    let id = opened["controlGroup"]["id"].as_str().unwrap().to_owned();
    let token = opened["token"].as_str().unwrap().to_owned();
    assert_eq!(opened["controlGroup"]["target"]["version"], 1);

    // Redeeming before approval fails and does not spend anything.
    let early = redeem_request(&alice, &id, &token).await;
    assert_eq!(early.status(), StatusCode::CONFLICT);
    // The requester can never approve their own request.
    let own = authorize_request(&alice, &id).await;
    assert_eq!(own.status(), StatusCode::FORBIDDEN);
    let approved = authorize_request(&bob, &id).await;
    assert_eq!(approved.status(), StatusCode::OK);
    assert_eq!(
        body_json(approved).await["controlGroup"]["status"],
        "approved"
    );

    // The value changes after the request: the pinned version is released.
    store
        .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v2")
        .await
        .unwrap();

    // Losing `read` blocks redemption without spending the token.
    let revoked = ctx_for(store, "alice", gate(false));
    let denied = redeem_request(&revoked, &id, &token).await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    // Only the requester can redeem.
    let stolen = redeem_request(&bob, &id, &token).await;
    assert_eq!(stolen.status(), StatusCode::NOT_FOUND);

    let redeemed = redeem_request(&alice, &id, &token).await;
    assert_eq!(redeemed.status(), StatusCode::OK);
    assert_eq!(body_json(redeemed).await["value"], "v1");
    let again = redeem_request(&alice, &id, &token).await;
    assert_eq!(again.status(), StatusCode::CONFLICT);
}

fn gate_with(factors: &[(&str, &[&str], u8)]) -> Policy {
    let mut policy = gate(true);
    policy.rules[0].control_group = Some(ControlGroupSpec {
        ttl_secs: None,
        factors: factors
            .iter()
            .map(|(name, approvers, approvals)| ControlGroupFactor {
                name: (*name).into(),
                approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
                approvals: *approvals,
            })
            .collect(),
    });
    policy
}

#[tokio::test]
async fn redeem_rechecks_the_current_control_group() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    store
        .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
        .await
        .unwrap();
    let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
    let alice = ctx_for(store, "alice", gate(true));
    let bob = ctx_for(store, "bob", gate(true));
    let spec = alice.read_control_group(&coords).unwrap();
    let opened = body_json(open_control_group(&alice, &coords, None, &spec).await).await;
    let id = opened["controlGroup"]["id"].as_str().unwrap().to_owned();
    let token = opened["token"].as_str().unwrap().to_owned();
    assert_eq!(authorize_request(&bob, &id).await.status(), StatusCode::OK);

    // Narrowed approvers and a raised count: bob's approval no longer counts.
    let narrowed = ctx_for(
        store,
        "alice",
        gate_with(&[("security", &["user:carol", "user:dave"], 2)]),
    );
    let denied = redeem_request(&narrowed, &id, &token).await;
    assert_eq!(denied.status(), StatusCode::CONFLICT);
    assert!(body_json(denied).await["error"]
        .as_str()
        .unwrap_or_default()
        .contains("control-group policy changed"));
    // An added factor is refused too.
    let added = ctx_for(
        store,
        "alice",
        gate_with(&[("security", &["user:bob"], 1), ("legal", &["user:erin"], 1)]),
    );
    let denied = redeem_request(&added, &id, &token).await;
    assert_eq!(denied.status(), StatusCode::CONFLICT);

    // The refusals spent nothing: under the unchanged group (approver
    // order aside) the requester still redeems once.
    let unchanged = ctx_for(store, "alice", gate_with(&[("security", &["user:bob"], 1)]));
    let redeemed = redeem_request(&unchanged, &id, &token).await;
    assert_eq!(redeemed.status(), StatusCode::OK);
    assert_eq!(body_json(redeemed).await["value"], "v1");
}

#[test]
fn matches_spec_ignores_order_but_not_content() {
    let factor = |name: &str, approvers: &[&str], approvals: u8| ControlGroupFactor {
        name: name.into(),
        approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
        approvals,
    };
    let request = ControlGroupRequest {
        id: "id".into(),
        requester: "user:alice".into(),
        policy_key: "k".into(),
        target: Value::Null,
        factors: vec![
            factor("p/0/a", &["user:bob", "team:ops"], 1),
            factor("p/0/b", &["user:carol"], 1),
        ],
        approvals: Vec::new(),
        status: policy_ext::ControlGroupStatus::Approved,
        created_at: 0,
        expires_at: 1,
        redeemed_at: None,
    };
    let spec = |factors| ControlGroupSpec {
        ttl_secs: None,
        factors,
    };
    assert!(request.matches_spec(&spec(vec![
        factor("p/0/b", &["user:carol"], 1),
        factor("p/0/a", &["team:ops", "user:bob"], 1),
    ])));
    assert!(!request.matches_spec(&spec(vec![
        factor("p/0/a", &["user:bob", "team:ops"], 2),
        factor("p/0/b", &["user:carol"], 1),
    ])));
    assert!(!request.matches_spec(&spec(vec![
        factor("p/0/a", &["user:bob"], 1),
        factor("p/0/b", &["user:carol"], 1),
    ])));
    assert!(!request.matches_spec(&spec(vec![factor("p/0/a", &["user:bob", "team:ops"], 1)])));
}

#[tokio::test]
async fn open_requests_are_capped_per_requester() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    store
        .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", "v1")
        .await
        .unwrap();
    let alice = ctx_for(store, "alice", gate(true));
    let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
    let spec = alice.read_control_group(&coords).unwrap();
    for _ in 0..policy_ext::MAX_OPEN_REQUESTS_PER_REQUESTER {
        let response = open_control_group(&alice, &coords, None, &spec).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
    let flooded = open_control_group(&alice, &coords, None, &spec).await;
    assert_eq!(flooded.status(), StatusCode::CONFLICT);
    // Another requester is unaffected.
    let carol = ctx_for(store, "carol", gate(true));
    let response = open_control_group(&carol, &coords, None, &spec).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
}

fn reader(manager: bool) -> Ctx {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let rule = |path: &str, capabilities: &[Capability], deny: bool| PolicyRule {
        path: path.into(),
        capabilities: capabilities.to_vec(),
        deny,
        ..Default::default()
    };
    let policy = Policy {
        name: "reader".into(),
        description: String::new(),
        rules: vec![
            rule(
                "staging/app/**",
                &[Capability::List, Capability::Read],
                false,
            ),
            rule("staging/app/ROOT_KEY", &[Capability::Read], true),
            rule(
                "sys/transit/{{identity.user.id}}",
                &[Capability::Use],
                false,
            ),
        ],
    };
    Ctx {
        manager,
        ..ctx_for(store, "alice", policy)
    }
}

async fn capabilities(ctx: &Ctx, paths: &str) -> (StatusCode, Value) {
    let response = capabilities_with(ctx, paths);
    let status = response.status();
    (status, body_json(response).await)
}

#[tokio::test]
async fn capabilities_self_reports_grants_denies_and_expanded_templates() {
    let ctx = reader(false);
    let (status, body) = capabilities(
        &ctx,
        " staging/app/API_KEY, staging/app/ROOT_KEY ,sys/transit/alice,sys/transit/bob,prod/app/API_KEY",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let caps = |key: &str| body["paths"][key]["capabilities"].clone();
    assert_eq!(caps("staging/app/API_KEY"), json!(["list", "read"]));
    // The deny removes `read` but leaves the glob's `list`.
    assert_eq!(caps("staging/app/ROOT_KEY"), json!(["list"]));
    // `{{identity.user.id}}` expands to the caller, and only the caller.
    assert_eq!(caps("sys/transit/alice"), json!(["use"]));
    assert_eq!(caps("sys/transit/bob"), json!([]));
    assert_eq!(caps("prod/app/API_KEY"), json!([]));
    assert_eq!(body["paths"]["staging/app/API_KEY"]["controlGroup"], false);
    assert_eq!(body["paths"].as_object().unwrap().len(), 5);
}

#[tokio::test]
async fn capabilities_self_flags_control_groups_and_starts_managers_from_every_capability() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let gated = ctx_for(store, "alice", gate(true));
    let (_, body) = capabilities(&gated, "staging/app/API_KEY").await;
    assert_eq!(body["paths"]["staging/app/API_KEY"]["controlGroup"], true);

    // A manager keeps every capability a policy does not deny.
    let (_, body) = capabilities(&reader(true), "sys/pki/web,staging/app/ROOT_KEY").await;
    assert_eq!(
        body["paths"]["sys/pki/web"]["capabilities"]
            .as_array()
            .unwrap()
            .len(),
        Capability::ALL.len()
    );
    assert!(!body["paths"]["staging/app/ROOT_KEY"]["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("read")));
}

#[tokio::test]
async fn capabilities_self_bounds_the_path_list() {
    let ctx = reader(false);
    for paths in ["", " , ,"] {
        let (status, _) = capabilities(&ctx, paths).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{paths:?}");
    }
    let many = vec!["staging/app/A"; MAX_CAPABILITY_PATHS + 1].join(",");
    let (status, _) = capabilities(&ctx, &many).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let most = (0..MAX_CAPABILITY_PATHS)
        .map(|index| format!("staging/app/K{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let (status, body) = capabilities(&ctx, &most).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["paths"].as_object().unwrap().len(),
        MAX_CAPABILITY_PATHS
    );
}

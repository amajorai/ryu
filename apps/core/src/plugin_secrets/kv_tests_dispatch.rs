//! Dispatch-time policy subjects, unverified principals, rewrap, audits, and
//! the resolution ladder. Split from `kv_tests.rs`.

use super::tests::{actor, coords, ctx, write};
use super::*;

fn block_default_use(store_conn: &rusqlite::Connection, subject: &str) {
    policy::put_policy(
        store_conn,
        &policy::Policy {
            name: "block".into(),
            description: String::new(),
            rules: vec![policy::PolicyRule {
                path: "default/**".into(),
                capabilities: vec![Capability::Use],
                deny: true,
                ..Default::default()
            }],
        },
    )
    .unwrap();
    policy::bind(store_conn, "block", subject, None, None).unwrap();
}

fn verified_context(teams: &[&str], team_id: Option<&str>) -> SecretResolutionContext {
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: "u1".into(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".into()),
        role: crate::identity_verify::OrgRole::Member,
        teams: teams
            .iter()
            .map(|id| crate::identity_verify::TeamMembership {
                id: (*id).into(),
                org_id: "org-1".into(),
                role: "member".into(),
            })
            .collect(),
    };
    SecretResolutionContext {
        user_id: Some("u1".into()),
        org_id: Some("org-1".into()),
        team_id: team_id.map(str::to_owned),
        team_authority: crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller(
            &caller,
        ),
        roles: vec!["member".into()],
        ..ctx()
    }
}

#[tokio::test]
async fn team_bound_deny_applies_at_dispatch_for_every_verified_team() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    {
        let conn = store.conn.lock().await;
        block_default_use(&conn, "team:contractors");
    }
    let resolve = |context: SecretResolutionContext| {
        let store = store.clone();
        async move {
            store
                .resolve_vault_secret("API_KEY", &context)
                .await
                .unwrap()
        }
    };
    // A member of the denied team, in a conversation with no team.
    assert_eq!(
        resolve(verified_context(&["contractors"], None)).await,
        None
    );
    // ...or in a conversation scoped to another of their teams.
    assert_eq!(
        resolve(verified_context(&["contractors", "eng"], Some("eng"))).await,
        None
    );
    // A non-member of the denied team still resolves.
    assert_eq!(
        resolve(verified_context(&["eng"], Some("eng")))
            .await
            .as_deref(),
        Some("v")
    );
    // A witness for another user or org contributes no team subjects.
    let mut other_user = verified_context(&["contractors"], None);
    other_user.user_id = Some("u2".into());
    assert_eq!(resolve(other_user).await.as_deref(), Some("v"));
    let mut other_org = verified_context(&["contractors"], None);
    other_org.org_id = Some("org-2".into());
    assert_eq!(resolve(other_org).await.as_deref(), Some("v"));
}

/// The dispatch context a bound node builds from the control plane's
/// deferred `/gateway/permissions` answer, as `secret_resolution_context`
/// does: `None` stands for a failed lookup.
async fn context_from_control_plane(
    scope: crate::sidecar::control_plane::NodeScope,
    node_team: Option<&str>,
    body: Option<serde_json::Value>,
) -> SecretResolutionContext {
    let node = crate::sidecar::control_plane::RegisteredNode {
        org: crate::sidecar::control_plane::RegisteredOrg {
            id: "org-1".into(),
            name: "Org".into(),
            slug: None,
        },
        node_id: "node-1".into(),
        scope,
        team_id: node_team.map(Into::into),
        owner_user_id: (scope == crate::sidecar::control_plane::NodeScope::Personal)
            .then(|| "u1".to_owned()),
    };
    crate::sidecar::control_plane::with_test_node_binding(true, Some(node), async move {
        let mut context = SecretResolutionContext {
            user_id: Some("u1".into()),
            org_id: Some("org-1".into()),
            team_id: node_team.map(str::to_owned),
            ..ctx()
        };
        let lookup = body.map(|body| {
            crate::sidecar::control_plane::current_authorization_from_body(
                "u1",
                serde_json::from_value(body).unwrap(),
            )
        });
        match lookup {
            Some(Ok(current)) => {
                context.apply_owner_principal(Some((&current.caller, current.policy_team_ids)))
            }
            _ => context.apply_owner_principal(None),
        }
        context
    })
    .await
}

fn deferred_response(
    scope: &str,
    node_team: Option<&str>,
    policy_team_ids: Option<&[&str]>,
) -> serde_json::Value {
    let mut principal = json!({
        "userId": "u1",
        "orgId": "org-1",
        "role": "member",
        // The control plane narrows these to the node's own team.
        "teams": node_team
            .map(|id| vec![json!({ "id": id, "orgId": "org-1", "role": "member" })])
            .unwrap_or_default(),
    });
    if let Some(ids) = policy_team_ids {
        principal["policyTeamIds"] = json!(ids);
    }
    json!({
        "permissions": [],
        "roleKeys": [],
        "principal": principal,
        "node": {
            "id": "node-1",
            "scope": scope,
            "ownerUserId": (scope == "personal").then_some("u1"),
            "teamId": node_team,
        },
    })
}

#[tokio::test]
async fn team_bound_deny_applies_on_team_and_personal_nodes() {
    use crate::sidecar::control_plane::NodeScope;
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    {
        let conn = store.conn.lock().await;
        block_default_use(&conn, "team:contractors");
    }
    let resolve = |context: SecretResolutionContext| {
        let store = store.clone();
        async move {
            store
                .resolve_vault_secret("API_KEY", &context)
                .await
                .unwrap()
        }
    };
    // A team node scoped to `eng`: the principal lists only `eng`, but
    // the deny bound to the owner's other team still applies.
    let team_node = context_from_control_plane(
        NodeScope::Team,
        Some("eng"),
        Some(deferred_response(
            "team",
            Some("eng"),
            Some(&["eng", "contractors"]),
        )),
    )
    .await;
    assert!(!team_node.principal_unverified);
    assert_eq!(resolve(team_node).await, None);
    // A personal node: the principal lists no team at all.
    let personal = context_from_control_plane(
        NodeScope::Personal,
        None,
        Some(deferred_response("personal", None, Some(&["contractors"]))),
    )
    .await;
    assert_eq!(resolve(personal).await, None);
    // An older control plane without the full list fails closed there.
    let incomplete = context_from_control_plane(
        NodeScope::Team,
        Some("eng"),
        Some(deferred_response("team", Some("eng"), None)),
    )
    .await;
    assert!(incomplete.principal_unverified);
    assert_eq!(resolve(incomplete).await, None);
    // A failed lookup fails closed.
    let failed = context_from_control_plane(NodeScope::Team, Some("eng"), None).await;
    assert!(failed.principal_unverified);
    assert!(failed.roles.is_empty() && failed.team_authority.is_none());
    assert_eq!(resolve(failed).await, None);
    // A member outside the denied team still resolves on the same node.
    let outsider = context_from_control_plane(
        NodeScope::Team,
        Some("eng"),
        Some(deferred_response("team", Some("eng"), Some(&["eng"]))),
    )
    .await;
    assert_eq!(resolve(outsider).await.as_deref(), Some("v"));
}

#[tokio::test]
async fn broker_minted_subjects_apply_role_and_team_denies() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    {
        let conn = store.conn.lock().await;
        block_default_use(&conn, "team:contractors");
    }
    let broker = |minted: &[&str]| SecretResolutionContext {
        user_id: Some("u1".into()),
        minted_subjects: minted.iter().map(|subject| (*subject).to_owned()).collect(),
        ..ctx()
    };
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &broker(&["user:u1", "team:contractors"]))
            .await
            .unwrap(),
        None
    );
    // Subjects recorded for another user never apply.
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &broker(&["user:u2", "team:contractors"]))
            .await
            .unwrap()
            .as_deref(),
        Some("v")
    );
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &broker(&["user:u1", "role:member"]))
            .await
            .unwrap()
            .as_deref(),
        Some("v")
    );
}

#[tokio::test]
async fn unverified_principal_fails_closed_at_dispatch() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    store
        .set_vault_secret(SecretScope::User, "u1", None, "USER_KEY", "mine")
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        block_default_use(&conn, "role:member");
    }
    // The verified member is denied by the role-bound policy.
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &verified_context(&[], None))
            .await
            .unwrap(),
        None
    );
    // A failed principal lookup leaves roles empty, which would drop the
    // role deny; nothing resolves at any scope instead.
    let unverified = SecretResolutionContext {
        user_id: Some("u1".into()),
        org_id: Some("org-1".into()),
        principal_unverified: true,
        ..ctx()
    };
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &unverified)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .resolve_vault_secret("USER_KEY", &unverified)
            .await
            .unwrap(),
        None
    );
    // A verified owner whose role is not denied resolves normally.
    let mut admin = verified_context(&[], None);
    admin.roles = vec!["admin".into()];
    assert_eq!(
        store
            .resolve_vault_secret("USER_KEY", &admin)
            .await
            .unwrap()
            .as_deref(),
        Some("mine")
    );
}

#[tokio::test]
async fn rewrap_moves_rows_to_the_active_key_version() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "value").await;
    store.set("exa", "RYU_EXA_API_KEY", "byok").await.unwrap();
    {
        let conn = store.conn.lock().await;
        store.keyring.rotate(&conn).unwrap();
    }
    let rewritten = store.rewrap_all(&actor()).await.unwrap();
    assert!(
        rewritten >= 3,
        "secret, version, and BYOK rows: {rewritten}"
    );
    let conn = store.conn.lock().await;
    let stale: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM vault_secrets WHERE key_version != 2)
                      + (SELECT COUNT(*) FROM plugin_secrets WHERE key_version != 2)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0);
    drop(conn);
    assert_eq!(
        store
            .get("exa", "RYU_EXA_API_KEY")
            .await
            .unwrap()
            .as_deref(),
        Some("byok")
    );
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("value")
    );
}

#[test]
fn metadata_patches_validate_and_clear_nullable_fields() {
    let patch: SecretMetadataPatch =
        serde_json::from_str(r#"{"expiresAt":null,"tags":["a","a"," b "]}"#).unwrap();
    let base = SecretMetadata {
        expires_at: Some(5),
        ..Default::default()
    };
    let applied = patch.apply(&base).unwrap();
    assert_eq!(applied.expires_at, None);
    assert_eq!(applied.tags, vec!["a".to_owned(), "b".to_owned()]);
    let unchanged: SecretMetadataPatch = serde_json::from_str("{}").unwrap();
    assert!(unchanged.is_empty());
    let bad: SecretMetadataPatch = serde_json::from_str(r#"{"rotationPeriodSecs":5}"#).unwrap();
    assert!(bad.apply(&base).is_err());
}

#[test]
fn vault_precedence_is_the_contract_ladder() {
    use ryu_channel_contracts::credential_scope::{CredentialLevel, LADDER};
    assert_eq!(
        SecretScope::precedence().collect::<Vec<_>>(),
        vec![
            SecretScope::User,
            SecretScope::Node,
            SecretScope::Project,
            SecretScope::Team,
            SecretScope::Org
        ]
    );
    for scope in [
        SecretScope::User,
        SecretScope::Node,
        SecretScope::Project,
        SecretScope::Team,
        SecretScope::Org,
    ] {
        // Each vault scope maps from exactly one contract level, and that
        // level carries the same wire name as the scope.
        let levels: Vec<CredentialLevel> = LADDER
            .into_iter()
            .filter(|level| SecretScope::from_credential_level(*level) == Some(scope))
            .collect();
        assert_eq!(levels.len(), 1, "{scope:?} must map from one level");
        assert_eq!(levels[0].as_str(), scope.as_str());
    }
    assert_eq!(
        LADDER
            .into_iter()
            .filter_map(SecretScope::from_credential_level)
            .count(),
        5
    );
}

#[test]
fn candidate_scopes_keep_order_and_shared_gating() {
    let mut caller = crate::identity_verify::VerifiedCaller {
        user_id: "u1".into(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".into()),
        role: crate::identity_verify::OrgRole::Member,
        teams: vec![crate::identity_verify::TeamMembership {
            id: "team-1".into(),
            org_id: "org-1".into(),
            role: "member".into(),
        }],
    };
    let mut context = SecretResolutionContext {
        user_id: Some("u1".into()),
        org_id: Some("org-1".into()),
        team_id: Some("team-1".into()),
        node_id: "node-1".into(),
        ..SecretResolutionContext::default()
    };
    context.team_authority =
        crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller(&caller);
    let pairs = |context: &SecretResolutionContext| {
        PluginSecretStore::candidate_scopes(context)
            .into_iter()
            .map(|(scope, id)| format!("{}:{id}", scope.as_str()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        pairs(&context),
        vec!["user:u1", "node:node-1", "team:team-1", "org:org-1"]
    );

    // Without a verified team witness the team level is skipped.
    caller.teams.clear();
    context.team_authority =
        crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller(&caller);
    assert_eq!(pairs(&context), vec!["user:u1", "node:node-1", "org:org-1"]);

    // Without a server-derived user no shared level is a candidate.
    context.user_id = None;
    assert_eq!(pairs(&context), vec!["node:node-1"]);
}

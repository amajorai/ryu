use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn coords(env: &str, path: &str, name: &str) -> SecretCoords {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: env.into(),
        path: path.into(),
        binding: None,
        name: name.into(),
    }
}

async fn write(store: &PluginSecretStore, coords: SecretCoords, value: &str) -> VaultSecretInfo {
    store
        .write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap()
}

fn ctx() -> SecretResolutionContext {
    SecretResolutionContext::node_only("node-1", Vec::new())
}

#[tokio::test]
async fn every_write_appends_a_version_and_rollback_restores_old_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    assert_eq!(write(&store, c.clone(), "one").await.version, 1);
    assert_eq!(write(&store, c.clone(), "two").await.version, 2);
    let versions = store.list_versions(&c).await.unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert!(versions[0].current);

    let rolled = store.rollback(c.clone(), 1, &actor()).await.unwrap();
    assert_eq!(rolled.version, 3);
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("one")
    );
    assert_eq!(store.reveal(&c, Some(2), &actor()).await.unwrap(), "two");
}

#[tokio::test]
async fn optimistic_concurrency_rejects_stale_writes() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    let stale = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("two"),
            patch: SecretMetadataPatch::default(),
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: Some(7),
        })
        .await
        .unwrap_err();
    assert!(stale.to_string().starts_with("vault_conflict"));
}

#[tokio::test]
async fn retention_keeps_only_max_versions() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("v1"),
            patch: SecretMetadataPatch {
                max_versions: Some(2),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    write(&store, c.clone(), "v2").await;
    write(&store, c.clone(), "v3").await;
    let versions = store.list_versions(&c).await.unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![3, 2]
    );
}

#[tokio::test]
async fn soft_delete_hides_and_restore_revives_with_history() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    assert!(store.soft_delete(c.clone(), &actor()).await.unwrap());
    assert_eq!(
        store.resolve_vault_secret("API_KEY", &ctx()).await.unwrap(),
        None
    );
    assert!(store.list_vault_secrets().await.unwrap().is_empty());
    let restored = store.restore(c.clone(), &actor()).await.unwrap();
    assert_eq!(restored.version, 1);
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("one")
    );
    // Writing after a delete revives the row with a new version.
    store.soft_delete(c.clone(), &actor()).await.unwrap();
    assert_eq!(write(&store, c.clone(), "two").await.version, 2);
}

#[tokio::test]
async fn destroy_removes_versions_permanently() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    write(&store, c.clone(), "two").await;
    assert!(store
        .destroy(c.clone(), Some(&[2]), &actor())
        .await
        .is_err());
    assert_eq!(
        store
            .destroy(c.clone(), Some(&[1]), &actor())
            .await
            .unwrap(),
        1
    );
    assert!(store.reveal(&c, Some(1), &actor()).await.is_err());
    assert!(store.rollback(c.clone(), 1, &actor()).await.is_err());
    store.destroy(c.clone(), None, &actor()).await.unwrap();
    assert_eq!(store.secret_info(&c).await.unwrap(), None);
}

#[tokio::test]
async fn environments_and_folders_scope_resolution() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "DB_URL"), "dev-db").await;
    write(&store, coords("prod", "/db", "DB_URL"), "prod-db").await;
    assert_eq!(
        store
            .resolve_vault_secret("DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("dev-db")
    );
    assert_eq!(
        store
            .resolve_vault_secret("prod:/db/DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("prod-db")
    );
    assert_eq!(
        store
            .resolve_vault_secret("prod:DB_URL", &ctx())
            .await
            .unwrap(),
        None
    );
    let mut prod = ctx();
    prod.environment = Some("prod".into());
    assert_eq!(
        store
            .resolve_vault_secret("/db/DB_URL", &prod)
            .await
            .unwrap()
            .as_deref(),
        Some("prod-db")
    );
    assert_eq!(
        store.list_folders("prod").await.unwrap(),
        vec!["/".to_owned(), "/db".to_owned()]
    );
}

#[tokio::test]
async fn imports_are_a_lower_precedence_fallback_within_each_scope() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords("default", "/shared", "TOKEN"),
        "shared-token",
    )
    .await;
    write(
        &store,
        coords("default", "/shared", "OTHER"),
        "shared-other",
    )
    .await;
    write(&store, coords("default", "/app", "OTHER"), "app-other").await;
    store
        .add_import(
            &FolderImport {
                id: String::new(),
                environment: "default".into(),
                path: "/app".into(),
                source_environment: "default".into(),
                source_path: "/shared".into(),
                position: 0,
            },
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("/app/TOKEN", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("shared-token")
    );
    assert_eq!(
        store
            .resolve_vault_secret("/app/OTHER", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("app-other")
    );
    let effective = store
        .effective_local_values(&ctx(), "default", "/app", |_| true)
        .await
        .unwrap();
    assert_eq!(effective.get("TOKEN").unwrap().1, "shared-token");
    assert_eq!(effective.get("OTHER").unwrap().1, "app-other");
}

#[tokio::test]
async fn references_expand_only_when_enabled_and_fail_closed() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "DB_USER"), "app").await;
    write(&store, coords("default", "/", "DB_PASS"), "s3cret").await;
    let url = coords("default", "/", "DB_URL");
    store
        .write_secret(WriteRequest {
            coords: url.clone(),
            value: Some("postgres://${DB_USER}:${DB_PASS}@db/app?x=$${literal}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("postgres://app:s3cret@db/app?x=${literal}")
    );
    store
        .soft_delete(coords("default", "/", "DB_PASS"), &actor())
        .await
        .unwrap();
    assert_eq!(
        store.resolve_vault_secret("DB_URL", &ctx()).await.unwrap(),
        None
    );

    // A self-reference cycle resolves to absent rather than looping.
    let a = coords("default", "/", "LOOP");
    store
        .write_secret(WriteRequest {
            coords: a,
            value: Some("x${LOOP}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store.resolve_vault_secret("LOOP", &ctx()).await.unwrap(),
        None
    );

    // The same reference used twice is not a cycle.
    store
        .write_secret(WriteRequest {
            coords: coords("default", "/", "PAIR"),
            value: Some("${DB_USER}:${DB_USER}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("PAIR", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("app:app")
    );
}

#[tokio::test]
async fn expired_values_do_not_resolve_and_report_their_status() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "TEMP");
    let info = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("short-lived"),
            patch: SecretMetadataPatch {
                expires_at: Some(Some(now_millis() - 1)),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(info.status(now_millis()), SecretStatus::Expired);
    assert_eq!(
        store.resolve_vault_secret("TEMP", &ctx()).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn generated_values_rotate_when_due() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "DB_PASSWORD");
    let created = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: None,
            patch: SecretMetadataPatch {
                generator: Some(Some(Generator::Random {
                    length: 24,
                    charset: Charset::Alphanumeric,
                })),
                rotation_period_secs: Some(Some(MIN_ROTATION_PERIOD_SECS)),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    let first = store.reveal(&c, None, &actor()).await.unwrap();
    assert_eq!(first.len(), 24);
    assert!(store.due_generated_rotations().await.unwrap().is_empty());
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_secrets SET rotated_at = 0", [])
            .unwrap();
    }
    assert_eq!(
        store.due_generated_rotations().await.unwrap(),
        vec![c.clone()]
    );
    let rotated = store
        .rotate_generated(c.clone(), &AuditActor::system())
        .await
        .unwrap();
    assert_eq!(rotated.version, created.version + 1);
    assert_ne!(store.reveal(&c, None, &actor()).await.unwrap(), first);
}

#[tokio::test]
async fn deny_policies_block_runtime_use() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    {
        let conn = store.conn.lock().await;
        policy::put_policy(
            &conn,
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
        policy::bind(&conn, "block", "user:u9", None, None).unwrap();
        policy::bind(&conn, "block", "role:viewer", None, None).unwrap();
    }
    let mut context = ctx();
    assert!(store
        .resolve_vault_secret("API_KEY", &context)
        .await
        .unwrap()
        .is_some());
    context.user_id = Some("u9".into());
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &context)
            .await
            .unwrap(),
        None
    );
    // A role-bound deny applies at dispatch too.
    let mut viewer = ctx();
    viewer.roles = vec!["viewer".into()];
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &viewer)
            .await
            .unwrap(),
        None
    );
}

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

#[tokio::test]
async fn mutations_and_resolutions_are_audited_without_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords("default", "/", "API_KEY"),
        "super-secret-value",
    )
    .await;
    store.resolve_vault_secret("API_KEY", &ctx()).await.unwrap();
    store.resolve_vault_secret("MISSING", &ctx()).await.unwrap();
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap();
    let actions: Vec<(&str, &str)> = rows
        .iter()
        .map(|row| (row.action.as_str(), row.outcome.as_str()))
        .collect();
    assert!(actions.contains(&("secret.create", "ok")));
    assert!(actions.contains(&("secret.use", "ok")));
    assert!(actions.contains(&("secret.use", "not_found")));
    let serialized = serde_json::to_string(&rows).unwrap();
    assert!(!serialized.contains("super-secret-value"));
    assert!(
        crate::vault::audit::verify(&conn, &store.audit_key)
            .unwrap()
            .ok
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
fn vault_precedence_is_the_contract_ladder_without_project() {
    use ryu_channel_contracts::credential_scope::{CredentialLevel, LADDER};
    // The shipped literal order before the vault adopted the contract.
    assert_eq!(
        SecretScope::precedence().collect::<Vec<_>>(),
        vec![
            SecretScope::User,
            SecretScope::Node,
            SecretScope::Team,
            SecretScope::Org
        ]
    );
    for scope in [
        SecretScope::User,
        SecretScope::Node,
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
        SecretScope::from_credential_level(CredentialLevel::Project),
        None
    );
    assert_eq!(
        LADDER
            .into_iter()
            .filter_map(SecretScope::from_credential_level)
            .count(),
        4
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

fn audit_unavailable<T: std::fmt::Debug>(result: Result<T>) -> bool {
    matches!(
        result
            .unwrap_err()
            .downcast_ref::<crate::vault::VaultError>(),
        Some(crate::vault::VaultError::AuditUnavailable)
    )
}

/// Restores the thread's fail-closed override even if an assert fails.
struct FailClosed;

impl FailClosed {
    fn on() -> Self {
        crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
        Self
    }
}

impl Drop for FailClosed {
    fn drop(&mut self) {
        crate::vault::audit_devices::set_fail_closed_for_test(None);
    }
}

#[tokio::test]
async fn fail_closed_blocks_value_handouts_until_a_device_accepts() {
    use crate::vault::identity_tokens::{IdentityConfig, IdentityRole, IdentitySubject};
    use crate::vault::items::{ItemCoords, ItemPut, PutAccess};
    use crate::vault::machine::AuthMethod;
    use crate::vault::password_policy::{CharsetRule, PasswordPolicySpec};
    use crate::vault::ssh::{CertType, SshRole};
    use crate::vault::tokens::TokenRequest;
    use crate::vault::totp::TotpCreateRequest;
    use crate::vault::transit::{TransitConfigUpdate, TransitExportKind, TransitKeyType};
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    store
        .transit_create("payments", TransitKeyType::Aes256Gcm96, &actor())
        .await
        .unwrap();
    let ciphertext = store
        .transit_encrypt("payments", "aGVsbG8=", None, &actor())
        .await
        .unwrap();
    store
        .transit_update_config(
            "payments",
            &TransitConfigUpdate {
                exportable: Some(true),
                allow_plaintext_backup: Some(true),
                ..TransitConfigUpdate::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    store
        .transit_create("signer", TransitKeyType::Ed25519, &actor())
        .await
        .unwrap();
    let item: ItemPut = serde_json::from_value(serde_json::json!({
        "kind": "login",
        "fields": [{ "name": "password", "type": "password", "required": true }],
        "values": { "password": "hunter2" },
    }))
    .unwrap();
    store
        .item_put("github", item, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let item_coords = ItemCoords::new(None, None, "github").unwrap();
    let totp_request = |name: &str| TotpCreateRequest {
        name: name.into(),
        generate: true,
        issuer: Some("GitHub".into()),
        account: Some("bot@example.com".into()),
        ..Default::default()
    };
    store
        .totp_create(&totp_request("existing"), &actor())
        .await
        .unwrap();
    let wrapped = store
        .wrap_response(b"{\"v\":1}", 120, "/p", &actor())
        .await
        .unwrap()
        .token
        .unwrap();
    store
        .identity_set_config(
            &IdentityConfig {
                issuer: Some("https://node.example.com/api/vault/identity".into()),
                ..IdentityConfig::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    store
        .identity_put_role(
            &IdentityRole {
                name: "aws".into(),
                audience: "sts.amazonaws.com".into(),
                ttl_secs: 900,
                template: None,
            },
            &actor(),
        )
        .await
        .unwrap();
    let subject = IdentitySubject {
        kind: "machine".into(),
        id: "mid_1".into(),
        name: "ci".into(),
        policies: vec![],
    };
    let machine = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec![],
            None,
            &actor(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = &machine.auth else {
        panic!("approle")
    };
    let (secret_id, _) = store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    let machine_token = store.approle_login(role_id, &secret_id).await.unwrap();
    store
        .cubbyhole_put(
            &machine_token.accessor,
            "note",
            &serde_json::json!("private"),
            &actor(),
        )
        .await
        .unwrap();
    let token_rows = || async {
        let conn = store.conn.lock().await;
        conn.query_row("SELECT COUNT(*) FROM vault_tokens", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    let secret_id_rows = || async {
        let conn = store.conn.lock().await;
        conn.query_row("SELECT COUNT(*) FROM vault_approle_secret_ids", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    // The CA's own public line doubles as a well-formed key to sign.
    let ssh_key = store.ssh_create_ca("ops", &actor()).await.unwrap();
    store
        .ssh_put_role(
            &SshRole {
                name: "dev".into(),
                ca: "ops".into(),
                cert_type: CertType::User,
                allowed_principals: vec!["deploy".into()],
                default_ttl_secs: 3600,
                max_ttl_secs: 7200,
                extensions: vec![],
            },
            &actor(),
        )
        .await
        .unwrap();
    let sign = || async {
        store
            .ssh_sign(
                "dev",
                &ssh_key,
                &["deploy".to_owned()],
                None,
                None,
                &actor(),
            )
            .await
    };
    store
        .password_policy_put(
            "db",
            &PasswordPolicySpec {
                description: String::new(),
                length: 16,
                rules: vec![CharsetRule {
                    charset: "abcdefghijklmnopqrstuvwxyz0123456789".into(),
                    min_chars: 1,
                }],
            },
            &actor(),
        )
        .await
        .unwrap();
    // Fail-closed off: everything is handed out without any device.
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "one");

    let guard = FailClosed::on();
    assert!(audit_unavailable(store.reveal(&c, None, &actor()).await));
    assert!(audit_unavailable(
        store.resolve_vault_secret("API_KEY", &ctx()).await
    ));
    assert!(audit_unavailable(
        store
            .transit_decrypt("payments", &ciphertext, None, &actor())
            .await
    ));
    assert!(audit_unavailable(
        store
            .snapshot_export(
                &ListFilter::default(),
                |_| true,
                "a long enough passphrase",
                &actor()
            )
            .await
    ));
    assert!(audit_unavailable(
        store.item_reveal(&item_coords, "password", &actor()).await
    ));
    assert!(audit_unavailable(
        store.totp_code("existing", &actor()).await
    ));
    // An exported create withholds the seed and leaves no key behind.
    assert!(audit_unavailable(
        store.totp_create(&totp_request("fresh"), &actor()).await
    ));
    assert!(store.totp_info("fresh").await.is_err());
    for kind in [TransitExportKind::EncryptionKey, TransitExportKind::HmacKey] {
        assert!(audit_unavailable(
            store.transit_export("payments", kind, None, &actor()).await
        ));
    }
    assert!(audit_unavailable(
        store.transit_backup("payments", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_datakey("payments", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_sign("signer", "aGVsbG8=", &actor()).await
    ));
    assert!(audit_unavailable(
        store.transit_hmac("payments", "aGVsbG8=", &actor()).await
    ));
    assert!(audit_unavailable(
        store
            .cubbyhole_get(&machine_token.accessor, "note", &actor())
            .await
    ));
    assert!(audit_unavailable(
        store.identity_token("aws", &subject, &actor()).await
    ));
    // Refused token issuance leaves no usable token row behind.
    let tokens_before = token_rows().await;
    assert!(audit_unavailable(
        store.approle_login(role_id, &secret_id).await
    ));
    assert!(audit_unavailable(
        store
            .token_create_for_identity("ci", TokenRequest::default(), &actor())
            .await
    ));
    assert_eq!(token_rows().await, tokens_before);
    // A refused AppRole secret id leaves no usable row behind.
    let secret_ids_before = secret_id_rows().await;
    assert!(audit_unavailable(
        store
            .machine_issue_secret_id("ci", None, None, &actor())
            .await
    ));
    assert_eq!(secret_id_rows().await, secret_ids_before);
    assert!(audit_unavailable(sign().await));
    assert!(audit_unavailable(
        store.password_policy_generate("db", &actor()).await
    ));
    // Unwrap audits after its commit, so the verdict is real; a refused
    // unwrap restores the wrapped response, so retries keep failing
    // closed instead of reporting the token as already used.
    assert!(audit_unavailable(store.wrap_unwrap(&wrapped).await));
    assert!(audit_unavailable(store.wrap_unwrap(&wrapped).await));
    // Encryption hands out nothing and still goes through.
    store
        .transit_encrypt("payments", "aGVsbG8=", None, &actor())
        .await
        .unwrap();
    // Writes, which hand out nothing, still go through.
    write(&store, c.clone(), "two").await;

    // A working synchronous device satisfies fail-closed.
    let dir = tempfile::tempdir().unwrap();
    crate::vault::audit_devices::allow_audit_dir_for_test(dir.path());
    {
        let conn = store.conn.lock().await;
        crate::vault::audit_devices::put(
            &conn,
            &crate::vault::audit_devices::AuditDevice {
                id: "local".into(),
                kind: crate::vault::audit_devices::DeviceKind::File,
                enabled: true,
                description: String::new(),
                hmac_fields: true,
                options: serde_json::json!({
                    "path": dir.path().join("audit.jsonl").to_string_lossy(),
                }),
                source: "api".into(),
            },
        )
        .unwrap();
    }
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "two");
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("two")
    );
    assert_eq!(
        store
            .transit_decrypt("payments", &ciphertext, None, &actor())
            .await
            .unwrap(),
        "aGVsbG8="
    );
    assert_eq!(
        store
            .item_reveal(&item_coords, "password", &actor())
            .await
            .unwrap(),
        "hunter2"
    );
    store.totp_code("existing", &actor()).await.unwrap();
    store.transit_backup("payments", &actor()).await.unwrap();
    store
        .transit_sign("signer", "aGVsbG8=", &actor())
        .await
        .unwrap();
    store.transit_datakey("payments", &actor()).await.unwrap();
    store
        .identity_token("aws", &subject, &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .cubbyhole_get(&machine_token.accessor, "note", &actor())
            .await
            .unwrap(),
        serde_json::json!("private")
    );
    store.approle_login(role_id, &secret_id).await.unwrap();
    store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    sign().await.unwrap();
    assert_eq!(
        store
            .password_policy_generate("db", &actor())
            .await
            .unwrap()
            .len(),
        16
    );
    // The wrapped response survived the outage and unwraps exactly once.
    assert_eq!(store.wrap_unwrap(&wrapped).await.unwrap(), b"{\"v\":1}");
    assert!(store.wrap_unwrap(&wrapped).await.is_err());
    let rewrapped = store
        .wrap_response(b"{\"v\":2}", 120, "/p", &actor())
        .await
        .unwrap()
        .token
        .unwrap();
    assert_eq!(store.wrap_unwrap(&rewrapped).await.unwrap(), b"{\"v\":2}");
    drop(guard);
}

#[tokio::test]
async fn rolled_back_audit_rows_never_reach_devices_or_subscribers() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut rx = crate::vault::events::subscribe();
    let entry = |name: &str| {
        AuditEntry::new(&actor(), "secret.update", "ok")
            .secret("node", "node-1", "default", "/", name)
    };
    {
        let conn = store.conn.lock().await;
        let tx = conn.unchecked_transaction().unwrap();
        assert!(store.audit_locked(&tx, &entry("ROLLED_BACK_ROW")));
        drop(tx);
        assert!(store.audit_locked(&conn, &entry("COMMITTED_ROW_A")));
        let tx = conn.unchecked_transaction().unwrap();
        assert!(store.audit_locked(&tx, &entry("COMMITTED_ROW_B")));
        tx.commit().unwrap();
        store.flush_audit(&conn);
    }
    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let Some(name) = event.name {
            if name.contains("_ROW") {
                seen.push(name);
            }
        }
    }
    assert_eq!(seen, vec!["COMMITTED_ROW_A", "COMMITTED_ROW_B"]);
}

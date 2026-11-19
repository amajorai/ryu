use super::*;
use crate::plugin_secrets::{SecretResolutionContext, WriteRequest};

fn store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

fn lock(scope: SecretScope, scope_id: &str) -> NamespaceLock {
    NamespaceLock {
        id: String::new(),
        scope,
        scope_id: scope_id.to_owned(),
        environment: None,
        path: None,
        reason: String::new(),
        locked_by: None,
        locked_at: 0,
    }
}

fn coords(scope: SecretScope, scope_id: &str, environment: &str, path: &str) -> SecretCoords {
    SecretCoords {
        scope,
        scope_id: scope_id.to_owned(),
        environment: environment.to_owned(),
        path: path.to_owned(),
        binding: None,
        name: "API_KEY".to_owned(),
    }
}

fn admin() -> AuditActor {
    AuditActor::new("user", Some("admin-1"))
}

async fn audit_actions(store: &PluginSecretStore) -> Vec<String> {
    let conn = store.conn.lock().await;
    crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap()
    .into_iter()
    .map(|row| row.action)
    .collect()
}

#[test]
fn a_lock_covers_its_scope_environment_and_folder_subtree() {
    let mut team = lock(SecretScope::Team, "team-1");
    assert!(team.covers(SecretScope::Team, "team-1", "prod", "/db", None));
    assert!(!team.covers(SecretScope::Team, "team-2", "prod", "/db", None));
    assert!(!team.covers(SecretScope::Org, "team-1", "prod", "/db", None));

    team.environment = Some("prod".into());
    team.path = Some("/db".into());
    assert!(team.covers(SecretScope::Team, "team-1", "prod", "/db", None));
    assert!(team.covers(SecretScope::Team, "team-1", "prod", "/db/main", None));
    assert!(!team.covers(SecretScope::Team, "team-1", "prod", "/dbx", None));
    assert!(!team.covers(SecretScope::Team, "team-1", "prod", "/", None));
    assert!(!team.covers(SecretScope::Team, "team-1", "dev", "/db", None));
    assert_eq!(team.label(), "team:team-1/prod/db");
}

#[test]
fn an_org_lock_reaches_team_and_project_values_of_the_node_org_only() {
    let org = lock(SecretScope::Org, "org-1");
    assert!(org.covers(SecretScope::Org, "org-1", "dev", "/", None));
    assert!(org.covers(SecretScope::Team, "team-9", "dev", "/", Some("org-1")));
    assert!(org.covers(SecretScope::Project, "p-1", "dev", "/", Some("org-1")));
    // Another org's node, an unregistered node, and personal or node values
    // stay outside the org subtree.
    assert!(!org.covers(SecretScope::Team, "team-9", "dev", "/", Some("org-2")));
    assert!(!org.covers(SecretScope::Team, "team-9", "dev", "/", None));
    assert!(!org.covers(SecretScope::User, "u-1", "dev", "/", Some("org-1")));
    assert!(!org.covers(SecretScope::Node, "node-1", "dev", "/", Some("org-1")));
}

#[tokio::test]
async fn lock_and_unlock_are_validated_cached_and_audited() {
    let store = store();
    assert!(cached(store).is_empty());
    let mut target = lock(SecretScope::Team, " team-1 ");
    target.path = Some("db/".into());
    target.reason = "incident 42".into();
    let held = store.lock_namespace(target.clone(), &admin()).await.unwrap();
    assert!(held.id.starts_with("vnl_"));
    assert_eq!(held.scope_id, "team-1");
    assert_eq!(held.path.as_deref(), Some("/db"));
    assert_eq!(held.locked_by.as_deref(), Some("admin-1"));
    assert_eq!(cached(store).as_slice(), std::slice::from_ref(&held));

    let again = store.lock_namespace(target, &admin()).await.unwrap_err();
    assert!(again.to_string().contains("already locked"), "{again}");
    let mut bad = lock(SecretScope::Team, "team-1");
    bad.environment = Some("not an env".into());
    assert!(store.lock_namespace(bad, &admin()).await.is_err());
    let mut project = lock(SecretScope::Org, "org-1");
    project.scope = SecretScope::Project;
    assert!(store.lock_namespace(project, &admin()).await.is_err());

    assert_eq!(store.namespace_locks().await.unwrap(), vec![held.clone()]);
    assert!(store.unlock_namespace(&held.id, &admin()).await.unwrap());
    assert!(!store.unlock_namespace(&held.id, &admin()).await.unwrap());
    assert!(cached(store).is_empty());
    let actions = audit_actions(store).await;
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.starts_with("namespace."))
            .count(),
        2,
        "{actions:?}"
    );
    assert!(actions.contains(&"namespace.lock".to_owned()));
    assert!(actions.contains(&"namespace.unlock".to_owned()));
}

#[tokio::test]
async fn a_locked_subtree_refuses_writes_deletes_reveals_and_resolution() {
    let store = store();
    let actor = admin();
    store
        .set_vault_secret(SecretScope::User, "u-1", None, "API_KEY", "v1")
        .await
        .unwrap();
    let target = coords(SecretScope::User, "u-1", "default", "/");
    let held = store
        .lock_namespace(lock(SecretScope::User, "u-1"), &actor)
        .await
        .unwrap();

    let write = store
        .write_secret(WriteRequest {
            coords: target.clone(),
            value: Some("v2"),
            patch: Default::default(),
            actor: &actor,
            source: crate::plugin_secrets::VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap_err();
    assert!(write.to_string().contains("is locked"), "{write}");
    let delete = store.soft_delete(target.clone(), &actor).await.unwrap_err();
    assert!(delete.to_string().contains("is locked"), "{delete}");
    let reveal = store.reveal(&target, None, &actor).await.unwrap_err();
    assert!(reveal.to_string().contains("is locked"), "{reveal}");
    let context = SecretResolutionContext {
        user_id: Some("u-1".into()),
        ..Default::default()
    };
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &context)
            .await
            .unwrap(),
        None
    );
    // Another user's subtree is untouched, and bulk reads (export, snapshot,
    // scan) skip only the locked value.
    store
        .set_vault_secret(SecretScope::User, "u-2", None, "API_KEY", "other")
        .await
        .unwrap();
    let bulk = store
        .current_values(&crate::plugin_secrets::kv::ListFilter::default())
        .await
        .unwrap();
    let owners: Vec<&str> = bulk.iter().map(|(info, _)| info.scope_id.as_str()).collect();
    assert_eq!(owners, vec!["u-2"]);

    store.unlock_namespace(&held.id, &actor).await.unwrap();
    assert_eq!(store.reveal(&target, None, &actor).await.unwrap(), "v1");
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("v1")
    );
}

//! Project-scoped values (roadmap P1-15): a run's project sits between the
//! node and team levels, resolves only through the control plane, and never
//! comes from or reaches the local store.

use super::super::*;
use ryu_channel_contracts::credential_scope::CredentialLevel;

fn org_context(project_id: Option<&str>) -> SecretResolutionContext {
    SecretResolutionContext {
        user_id: Some("u1".into()),
        org_id: Some("org-1".into()),
        project_id: project_id.map(str::to_owned),
        node_id: "node-1".into(),
        ..SecretResolutionContext::default()
    }
}

fn pairs(context: &SecretResolutionContext) -> Vec<String> {
    PluginSecretStore::candidate_scopes(context)
        .into_iter()
        .map(|(scope, id)| format!("{}:{id}", scope.as_str()))
        .collect()
}

#[test]
fn the_project_level_sits_between_node_and_team() {
    let order: Vec<SecretScope> = SecretScope::precedence().collect();
    assert_eq!(
        order,
        vec![
            SecretScope::User,
            SecretScope::Node,
            SecretScope::Project,
            SecretScope::Team,
            SecretScope::Org,
        ]
    );
    assert_eq!(
        pairs(&org_context(Some("proj-1"))),
        vec!["user:u1", "node:node-1", "project:proj-1", "org:org-1"]
    );
}

#[test]
fn a_project_needs_a_user_an_organization_and_a_valid_id() {
    assert_eq!(
        pairs(&org_context(None)),
        vec!["user:u1", "node:node-1", "org:org-1"]
    );
    let no_user = SecretResolutionContext {
        user_id: None,
        ..org_context(Some("proj-1"))
    };
    assert_eq!(pairs(&no_user), vec!["node:node-1"]);
    let no_org = SecretResolutionContext {
        org_id: None,
        ..org_context(Some("proj-1"))
    };
    assert_eq!(pairs(&no_org), vec!["user:u1", "node:node-1"]);
    assert_eq!(
        pairs(&org_context(Some("has space"))),
        vec!["user:u1", "node:node-1", "org:org-1"]
    );
}

#[test]
fn the_project_scope_is_never_parsed_from_a_request_or_a_row() {
    assert_eq!(SecretScope::Project.as_str(), "project");
    assert_eq!(SecretScope::from_str("project"), None);
    assert!(serde_json::from_str::<SecretScope>("\"project\"").is_err());
    assert_eq!(
        serde_json::to_string(&SecretScope::Project).unwrap(),
        "\"project\""
    );
    assert_eq!(
        SecretScope::from_credential_level(CredentialLevel::Project),
        Some(SecretScope::Project)
    );
}

#[tokio::test]
async fn without_the_control_plane_a_project_resolves_nothing_locally() {
    let store = PluginSecretStore::in_memory().unwrap();
    // A node value of the same name still resolves: the project level is
    // skipped, not a dead end.
    store
        .set_vault_secret(SecretScope::Node, "node-1", None, "DB_URL", "node-db")
        .await
        .unwrap();
    let context = org_context(Some("proj-1"));
    assert_eq!(
        store
            .resolve_vault_secret("DB_URL", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("node-db")
    );
    assert_eq!(
        store
            .resolve_vault_secret("ONLY_IN_PROJECT", &context)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn the_local_store_refuses_to_hold_a_project_value() {
    let store = PluginSecretStore::in_memory().unwrap();
    let refused = store
        .set_vault_secret(SecretScope::Project, "proj-1", None, "DB_URL", "proj-db")
        .await
        .unwrap_err();
    assert!(
        format!("{refused:#}").contains("control plane"),
        "{refused:#}"
    );
    let coords = SecretCoords {
        scope: SecretScope::Project,
        scope_id: "proj-1".into(),
        environment: "default".into(),
        path: "/".into(),
        binding: None,
        name: "DB_URL".into(),
    };
    assert!(coords.clone().normalize().is_err());
    assert!(store.secret_info(&coords).await.is_err());
    assert!(store.list_vault_secrets().await.unwrap().is_empty());
}

//! Personal overrides in both states: the ordering, the stored setting, runtime
//! resolution, export values, and the export overlay.

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::plugin_secrets::kv::ValueType;
use crate::plugin_secrets::{SecretMetadataPatch, VersionSource, WriteRequest};
use crate::vault::audit::AuditActor;

fn coords(scope: SecretScope, scope_id: &str, name: &str) -> SecretCoords {
    SecretCoords::root(scope, scope_id, None, name)
}

async fn write(store: &PluginSecretStore, coords: SecretCoords, value: &str, sealed: bool) {
    let actor = AuditActor::new("user", Some("u1"));
    store
        .write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch {
                value_type: sealed.then_some(ValueType::Sealed),
                ..Default::default()
            },
            actor: &actor,
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

/// A signed-in user on an organization node. Shared values are off in tests,
/// so the organization's values resolve from this store.
fn context(user: &str) -> SecretResolutionContext {
    SecretResolutionContext {
        user_id: Some(user.into()),
        org_id: Some("org-1".into()),
        node_id: "node-1".into(),
        ..SecretResolutionContext::default()
    }
}

fn labels(scopes: &[(SecretScope, String)]) -> Vec<String> {
    scopes
        .iter()
        .map(|(scope, id)| format!("{}:{id}", scope.as_str()))
        .collect()
}

#[test]
fn off_moves_only_the_user_scope_to_the_end() {
    let scopes = vec![
        (SecretScope::User, "u1".to_owned()),
        (SecretScope::Node, "node-1".to_owned()),
        (SecretScope::Project, "proj-1".to_owned()),
        (SecretScope::Team, "team-1".to_owned()),
        (SecretScope::Org, "org-1".to_owned()),
    ];
    assert_eq!(
        labels(&ordered(scopes.clone(), true)),
        [
            "user:u1",
            "node:node-1",
            "project:proj-1",
            "team:team-1",
            "org:org-1"
        ]
    );
    assert_eq!(
        labels(&ordered(scopes, false)),
        [
            "node:node-1",
            "project:proj-1",
            "team:team-1",
            "org:org-1",
            "user:u1"
        ]
    );
    let no_user = vec![(SecretScope::Node, "node-1".to_owned())];
    assert_eq!(labels(&ordered(no_user, false)), ["node:node-1"]);
}

#[tokio::test]
async fn the_setting_defaults_on_and_is_per_user() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(enabled(&store, "u1").await);
    set(&store, "u1", false).await.unwrap();
    assert!(!enabled(&store, "u1").await);
    assert!(
        enabled(&store, "u2").await,
        "another user keeps the default"
    );
    assert!(!enabled_for(&store, &context("u1")).await);
    let no_user = SecretResolutionContext::node_only("node-1", Vec::new());
    assert!(enabled_for(&store, &no_user).await);
    set(&store, "u1", true).await.unwrap();
    assert!(enabled(&store, "u1").await);
    assert_eq!(
        store.get(OWNER, "u1").await.unwrap(),
        None,
        "on stores no row"
    );
}

#[tokio::test]
async fn resolution_follows_the_users_setting() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords(SecretScope::Org, "org-1", "API_KEY"),
        "org-value",
        false,
    )
    .await;
    write(
        &store,
        coords(SecretScope::User, "u1", "API_KEY"),
        "u1-value",
        false,
    )
    .await;
    write(
        &store,
        coords(SecretScope::User, "u1", "ONLY_MINE"),
        "mine",
        false,
    )
    .await;
    write(
        &store,
        coords(SecretScope::User, "u2", "API_KEY"),
        "u2-value",
        false,
    )
    .await;
    let resolve = |user: &'static str, name: &'static str| {
        let store = &store;
        async move {
            store
                .resolve_vault_secret(name, &context(user))
                .await
                .unwrap()
        }
    };

    assert_eq!(resolve("u1", "API_KEY").await.as_deref(), Some("u1-value"));
    set(&store, "u1", false).await.unwrap();
    assert_eq!(resolve("u1", "API_KEY").await.as_deref(), Some("org-value"));
    // A personal value still fills a name nothing shared defines.
    assert_eq!(resolve("u1", "ONLY_MINE").await.as_deref(), Some("mine"));
    // Another user's setting is their own.
    assert_eq!(resolve("u2", "API_KEY").await.as_deref(), Some("u2-value"));
    set(&store, "u1", true).await.unwrap();
    assert_eq!(resolve("u1", "API_KEY").await.as_deref(), Some("u1-value"));
}

#[tokio::test]
async fn export_values_follow_the_users_setting() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords(SecretScope::Org, "org-1", "API_KEY"),
        "org-value",
        false,
    )
    .await;
    write(
        &store,
        coords(SecretScope::User, "u1", "API_KEY"),
        "u1-value",
        false,
    )
    .await;
    write(
        &store,
        coords(SecretScope::User, "u1", "SIGNING_KEY"),
        "sealed",
        true,
    )
    .await;
    let values = || async {
        store
            .effective_local_values_and_withheld(&context("u1"), "default", "/", |_| true)
            .await
            .unwrap()
    };

    let (on, withheld_on) = values().await;
    assert_eq!(on["API_KEY"].1, "u1-value");
    assert_eq!(on["API_KEY"].0.scope, SecretScope::User);
    assert!(withheld_on.contains("SIGNING_KEY"));

    set(&store, "u1", false).await.unwrap();
    let (off, withheld_off) = values().await;
    assert_eq!(off["API_KEY"].1, "org-value");
    assert_eq!(off["API_KEY"].0.scope, SecretScope::Org);
    // Off, a sealed personal value no longer hides a shared value.
    assert!(!withheld_off.contains("SIGNING_KEY"));
}

#[test]
fn the_export_overlay_lets_personal_values_win_only_when_on() {
    let shared = BTreeMap::from([
        ("API_KEY".to_owned(), "shared".to_owned()),
        ("SIGNING_KEY".to_owned(), "shared-signing".to_owned()),
    ]);
    let local = BTreeMap::from([
        (
            "API_KEY".to_owned(),
            (
                coords(SecretScope::User, "u1", "API_KEY"),
                "mine".to_owned(),
            ),
        ),
        (
            "ONLY_MINE".to_owned(),
            (
                coords(SecretScope::User, "u1", "ONLY_MINE"),
                "mine-only".to_owned(),
            ),
        ),
        (
            "LOG_LEVEL".to_owned(),
            (
                coords(SecretScope::Node, "node-1", "LOG_LEVEL"),
                "debug".to_owned(),
            ),
        ),
    ]);
    let withheld = BTreeSet::from(["SIGNING_KEY".to_owned()]);

    let on = overlay(shared.clone(), local.clone(), &withheld, true);
    assert_eq!(on["API_KEY"], "mine");
    assert!(!on.contains_key("SIGNING_KEY"));

    let off = overlay(shared, local, &withheld, false);
    assert_eq!(off["API_KEY"], "shared");
    assert_eq!(off["ONLY_MINE"], "mine-only");
    assert_eq!(off["LOG_LEVEL"], "debug", "node values still win");
    assert!(!off.contains_key("SIGNING_KEY"));
}

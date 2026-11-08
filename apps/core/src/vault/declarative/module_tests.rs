//! Focused tests for the declarative submodules' own rules.

use std::collections::BTreeMap;

use serde_json::json;

use super::fields::reject_unserialized_keys;
use super::secret_refs::Family;
use super::{base, folders, identity, parse, roles, secret_refs, services, ApplyReport, InitSpec};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::quotas::QuotaRule;

#[test]
fn fields_keep_empty_omitted_keys_and_name_the_unknown_path() {
    let output = json!({ "a": { "b": 1 } });
    assert!(reject_unserialized_keys(&json!({ "a": { "b": 1, "c": [] } }), &output, "x").is_ok());
    let error = reject_unserialized_keys(&json!({ "a": { "b": 1, "c": 2 } }), &output, "x")
        .unwrap_err()
        .to_string();
    assert_eq!(error, "x.a has unknown field `c`");
}

#[test]
fn secret_refs_read_files_trimmed_and_refuse_oversized_ones() {
    let dir = tempfile::tempdir().unwrap();
    let small = dir.path().join("url");
    std::fs::write(&small, "postgres://admin:pw@db/app\n").unwrap();
    let refs = BTreeMap::from([(
        "connectionUrl".to_owned(),
        format!("file:{}", small.display()),
    )]);
    let provider = json!({ "kind": "postgres", "creationStatements": ["SELECT 1"] });
    assert_eq!(
        secret_refs::check(Family::Dynamic, &provider, &refs).unwrap(),
        "postgres"
    );
    let resolved = secret_refs::resolve(&provider, &refs).unwrap();
    assert_eq!(resolved["connectionUrl"], "postgres://admin:pw@db/app");

    let large = dir.path().join("large");
    std::fs::write(&large, "x".repeat(70 * 1024)).unwrap();
    let refs = BTreeMap::from([(
        "connectionUrl".to_owned(),
        format!("file:{}", large.display()),
    )]);
    let error = secret_refs::resolve(&provider, &refs)
        .unwrap_err()
        .to_string();
    assert!(error.contains("exceeds"), "{error}");
    assert!(secret_refs::check(
        Family::Static,
        &json!({ "kind": "random" }),
        &BTreeMap::new()
    )
    .is_err());
}

#[test]
fn folders_and_imports_normalize_paths() {
    let mut folder = folders::DeclaredFolder {
        environment: "default".into(),
        path: "a/b/".into(),
    };
    folder.normalize().unwrap();
    assert_eq!(folder.path, "/a/b");
    let mut import = folders::DeclaredImport {
        environment: "default".into(),
        path: "a".into(),
        source_environment: "default".into(),
        source_path: "/a/".into(),
        position: 0,
    };
    assert!(import.normalize().is_err());
}

#[test]
fn quotas_get_absolute_paths_and_roles_get_default_targets() {
    let mut quota: identity::DeclaredQuota =
        serde_json::from_value(json!({ "name": "q", "kind": "rate-limit", "rate": 5 })).unwrap();
    quota.normalize().unwrap();
    let QuotaRule::RateLimit { path, .. } = &quota.rule else {
        panic!("rate limit expected");
    };
    assert_eq!(path, "/api/vault/");

    let mut role: roles::DeclaredStaticRole = serde_json::from_value(json!({
        "name": "svc",
        "provider": { "kind": "redis", "username": "svc" },
        "secretRefs": { "connectionUrl": "env:REDIS_ADMIN_URL" },
        "target": { "name": "SVC" },
        "rotationPeriodSecs": 3600
    }))
    .unwrap();
    role.check().unwrap();
    assert_eq!(role.target.environment.as_deref(), Some("default"));
    assert_eq!(role.target.path.as_deref(), Some("/"));
}

#[tokio::test]
async fn base_and_services_apply_their_own_sections() {
    let store = PluginSecretStore::in_memory().unwrap();
    let spec: InitSpec = parse::parse(
        &json!({
            "environments": [{ "slug": "prod", "name": "Production" }],
            "brokerServices": [{
                "name": "github", "environment": "prod", "host": "api.github.com",
                "auth": { "type": "bearer", "token": "secret:GITHUB_TOKEN" }
            }]
        })
        .to_string(),
    )
    .unwrap();
    let actor = super::actor();
    let mut report = ApplyReport::default();
    base::apply(&store, &spec, &actor, &mut report)
        .await
        .unwrap();
    services::apply(&store, &spec, &actor, &mut report)
        .await
        .unwrap();
    assert_eq!(
        report.created,
        vec![
            "environment:prod".to_owned(),
            "brokerService:github".to_owned()
        ]
    );
    let mut again = ApplyReport::default();
    services::apply(&store, &spec, &actor, &mut again)
        .await
        .unwrap();
    assert_eq!(again.unchanged, 1);
}

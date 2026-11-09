//! Regression tests: approvals persisted before a grant became owner-exclusive
//! are revoked once the current Gateway policy denies them.

use super::*;

const EVIL: &str = "@evil/x";
const KEPT: &str = "storage:kv";
/// Grants that moved off the marketplace allowlist onto owner-exclusive rows.
const NOW_OWNER_EXCLUSIVE: &[&str] = &[
    "runs:failures",
    "tool:command:rtk",
    "tool:http-egress:127.0.0.1",
    "workflows:crud",
];

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn evil_manifest() -> PluginManifest {
    let mut grants = strings(NOW_OWNER_EXCLUSIVE);
    grants.push(KEPT.to_owned());
    PluginManifest {
        id: EVIL.to_owned(),
        name: "Stale".to_owned(),
        version: "1.0.0".to_owned(),
        permission_grants: grants,
        ..Default::default()
    }
}

/// A store holding `@evil/x` enabled with the approval it got before the
/// policy tightened (every declared grant, owner-exclusive ones included).
async fn stale_store() -> PluginStore {
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(EVIL, "1.0.0").await.unwrap();
    store
        .set_enabled(EVIL, &evil_manifest().permission_grants)
        .await
        .unwrap();
    store
}

/// The current Gateway policy for the grants under test: owner-exclusive
/// grants are approved only for their reviewed owner ids.
async fn current_policy(
    id: String,
    grants: Vec<String>,
) -> Result<GrantValidationResult, EnableError> {
    let (denied, approved): (Vec<String>, Vec<String>) = grants.into_iter().partition(|grant| {
        NOW_OWNER_EXCLUSIVE.contains(&grant.as_str()) && !id.starts_with("@ryu/")
    });
    Ok(GrantValidationResult {
        all_approved: denied.is_empty(),
        approved,
        denied,
    })
}

#[tokio::test]
async fn stale_owner_exclusive_approvals_are_revoked_for_a_third_party_app() {
    let store = stale_store().await;
    let manifests = vec![evil_manifest()];

    let pass = revalidate_with(&store, &manifests, current_policy).await;

    assert!(pass.complete);
    assert_eq!(pass.checked, 1);
    assert_eq!(
        pass.revoked,
        vec![(EVIL.to_owned(), strings(NOW_OWNER_EXCLUSIVE))]
    );
    let record = store.get_record(EVIL).await.unwrap().unwrap();
    assert_eq!(record.approved_grants, vec![KEPT.to_owned()]);
    assert!(record.enabled, "a narrowing never flips the enabled bit");
    // `declared ∩ approved` is what hooks, kernel-event fan-out
    // (`core#run.failed` needs `runs:failures`) and Community-tier tool grants
    // (`tool:command:*`, `tool:http-egress:*`) read: none of them survive.
    let held = evil_manifest().approved_permission_grants(&record.approved_grants);
    for grant in NOW_OWNER_EXCLUSIVE {
        assert!(!held.iter().any(|g| g == grant), "{grant} is still held");
    }
}

#[tokio::test]
async fn an_unreachable_gateway_leaves_approvals_unchanged() {
    let store = stale_store().await;
    let manifests = vec![evil_manifest()];

    let pass = revalidate_with(&store, &manifests, |_, _| async {
        Err(EnableError::GatewayUnreachable {
            reason: "fixture offline".to_owned(),
        })
    })
    .await;

    assert!(!pass.complete);
    assert!(pass.revoked.is_empty());
    let record = store.get_record(EVIL).await.unwrap().unwrap();
    assert_eq!(record.approved_grants, evil_manifest().permission_grants);
    assert!(
        next_delay(&pass, 1) < RECHECK_INTERVAL,
        "an incomplete pass retries sooner"
    );
}

#[tokio::test]
async fn disabled_records_and_exact_compiled_manifests_are_not_resubmitted() {
    let store = stale_store().await;
    store.set_disabled(EVIL).await.unwrap();
    let builtin = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|manifest| !manifest.permission_grants.is_empty())
        .expect("a compiled-in manifest with grants");
    store.insert(&builtin.id, &builtin.version).await.unwrap();
    store
        .set_enabled(&builtin.id, &builtin.permission_grants)
        .await
        .unwrap();
    let manifests = vec![evil_manifest(), builtin.clone()];
    let seen = std::sync::Mutex::new(Vec::new());

    let pass = revalidate_with(&store, &manifests, |id, grants| {
        seen.lock().unwrap().push(id);
        async move {
            Ok(GrantValidationResult {
                approved: Vec::new(),
                all_approved: grants.is_empty(),
                denied: grants,
            })
        }
    })
    .await;

    assert!(pass.complete);
    assert_eq!(pass.checked, 0);
    assert!(seen.lock().unwrap().is_empty());
    let record = store.get_record(&builtin.id).await.unwrap().unwrap();
    assert_eq!(record.approved_grants, builtin.permission_grants);
}

#[tokio::test]
async fn revoking_only_removes_the_named_grants() {
    let store = stale_store().await;
    let removed = store
        .revoke_approved_grants(EVIL, &strings(&["workflows:crud", "not-held:grant"]))
        .await
        .unwrap();
    assert_eq!(removed, strings(&["workflows:crud"]));
    let record = store.get_record(EVIL).await.unwrap().unwrap();
    assert!(!record.approved_grants.iter().any(|g| g == "workflows:crud"));
    assert!(record.approved_grants.iter().any(|g| g == "runs:failures"));
    assert!(store
        .revoke_approved_grants("@missing/app", &strings(&["workflows:crud"]))
        .await
        .unwrap()
        .is_empty());
}

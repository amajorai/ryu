use super::*;

/// The v1 subject: a compiled-in built-in whose sidecar declares a `host_api`
/// grant that is also in its `permission_grants` — the exact shape
/// [`backfill_host_api_grants`] repairs. Its grant is `tools.invoke`.
///
/// This used to be `@ryu/recipes`, which is the app the v1 regression was
/// actually reported against. Recipes moved into [`DEMOTED_FROM_PREINSTALLED_V5`],
/// and v5 REMOVES those records outright — so every test here that inserts a
/// record and then reads it back through the full `run_one_time_migrations`
/// would be asserting against a row v5 had just deleted. Monitors is the nearest
/// equivalent that survives the whole chain: it is in the legacy disabled-seed set, but
/// v3 refuses to touch an ENABLED record and these tests install it enabled.
pub(super) const MONITORS: &str = crate::plugins::builtins::MONITORS_PLUGIN_ID;
/// The `host_api` grant [`MONITORS`] declares — what v1 must put back.
pub(super) const MONITORS_HOST_GRANT: &str = "tools.invoke";

/// The v1 step on its own (no version gate): it puts the declared host grant
/// back and is idempotent, never duplicating it on a second pass.
#[tokio::test]
async fn the_v1_step_alone_backfills_the_host_grant_once() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(MONITORS, "1.0.0").await.unwrap();
    store.set_enabled(MONITORS, &[]).await.unwrap();

    super::migration_steps::backfill_host_api_grants(&store, &manifests).await;
    super::migration_steps::backfill_host_api_grants(&store, &manifests).await;

    let record = store.get(MONITORS).await.unwrap().unwrap();
    let granted = record
        .approved_grants
        .iter()
        .filter(|grant| *grant == MONITORS_HOST_GRANT)
        .count();
    assert_eq!(granted, 1, "{:?}", record.approved_grants);
}

/// Reproduces the actual upgrade: a store seeded BEFORE the per-app
/// `/api/host/<app>/*` callbacks moved onto the capability seam. Its record is
/// enabled with NO grants, because those routes required none. After the move,
/// the host callbacks need the manifest's declared grant, so without this
/// migration every pre-existing install 403s until the user toggles the app off
/// and on.
#[tokio::test]
async fn backfills_a_host_api_grant_onto_a_pre_existing_record() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    // The pre-upgrade state: installed + enabled, empty approved_grants.
    store.insert(MONITORS, "1.0.0").await.unwrap();
    store.set_enabled(MONITORS, &[]).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    let record = store.get(MONITORS).await.unwrap().unwrap();
    assert!(
        record
            .approved_grants
            .iter()
            .any(|g| g == MONITORS_HOST_GRANT),
        "'{MONITORS}' must regain the grant its host callbacks now require, got {:?}",
        record.approved_grants
    );
    assert!(
        record.enabled,
        "the backfill must not disturb enabled state"
    );
}

/// The property that makes running this at boot safe: it happens ONCE. A user who
/// revokes a grant afterwards must keep it revoked across every later restart —
/// a reconcile that re-asserted the grant on every boot would silently override
/// them forever, which is why this is version-gated rather than unconditional.
#[tokio::test]
async fn a_later_revocation_is_never_undone_by_a_second_run() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(MONITORS, "1.0.0").await.unwrap();
    store.set_enabled(MONITORS, &[]).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;
    // The user revokes it.
    store.set_enabled(MONITORS, &[]).await.unwrap();
    // Every subsequent boot.
    run_one_time_migrations(&store, &manifests).await;
    run_one_time_migrations(&store, &manifests).await;

    let record = store.get(MONITORS).await.unwrap().unwrap();
    assert!(
        record.approved_grants.is_empty(),
        "a revoked grant must stay revoked, got {:?}",
        record.approved_grants
    );
}

/// A disk manifest must never self-approve — that is the entire point of the
/// Gateway grant gate, and a migration that ignored it would be a way to bypass
/// the capability grammar by shipping a manifest that declares its own host_api.
#[tokio::test]
async fn a_non_compiled_in_plugin_is_never_backfilled() {
    let store = PluginStore::open_in_memory().unwrap();
    let evil = "com.evil.app";
    assert!(
        !crate::plugins::builtins::is_compiled_in_manifest(evil),
        "'{evil}' must not be a built-in for this test to mean anything"
    );
    store.insert(evil, "1.0.0").await.unwrap();
    store.set_enabled(evil, &[]).await.unwrap();

    // A manifest that declares a sidecar host_api grant AND the matching
    // permission_grant — i.e. it has done everything a built-in does.
    let mut manifest = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|m| m.id == MONITORS)
        .expect("monitors fixture");
    manifest.id = evil.to_owned();

    run_one_time_migrations(&store, &[manifest]).await;

    let record = store.get(evil).await.unwrap().unwrap();
    assert!(
        record.approved_grants.is_empty(),
        "a disk manifest must never self-approve a host-api grant, got {:?}",
        record.approved_grants
    );
}

pub(super) const LEARNING: &str = crate::plugins::builtins::LEARNING_PLUGIN_ID;
/// A not pre-installed built-in that is outside the legacy disabled-seed set. It used to
/// be `quests`, which moved into that set; using it here would make v3 delete the
/// very record the test inserts to watch.
pub(super) const OPT_IN_BUILTIN: &str = crate::plugins::builtins::HEALING_PLUGIN_ID;

/// THE consent-surface regression (v2). Learning was not pre-installed until its two
/// consent switches moved onto its app-registered settings tab, so essentially
/// every pre-existing install has a `@ryu/learning` record at `enabled = false`
/// — and an app-registered tab only renders while its app is enabled. The seed
/// loop cannot fix it (`Ok(Some(_)) => continue`), so those users lose the
/// off-switch for a capture path the kernel keeps running regardless of the record.
#[tokio::test]
async fn the_learning_consent_surface_is_restored_on_a_pre_existing_disabled_record() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    // The pre-upgrade state: installed, and the user (or the old not pre-installed
    // posture) left it disabled.
    store.insert(LEARNING, "1.0.0").await.unwrap();
    store.set_disabled(LEARNING).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    let record = store.get(LEARNING).await.unwrap().unwrap();
    let ui = store
        .get_ui_code(LEARNING)
        .await
        .unwrap()
        .expect("a re-enabled record must carry its companion bundle, not mount empty");
    assert!(
        ui.len() > 10_000 && ui.contains('<'),
        "learning ui_code must be the real inlined companion bundle, got {} bytes",
        ui.len()
    );
    assert!(
        record.enabled,
        "learning must be re-enabled so its settings tab (and /api/learn/*) is \
         reachable again"
    );
    assert!(
        record.approved_grants.iter().any(|g| g == "learning:crud"),
        "a re-enabled record must carry the grants a fresh install would have, got {:?}",
        record.approved_grants
    );
}

/// The property that makes v2 safe, mirroring
/// `a_later_revocation_is_never_undone_by_a_second_run`: the version gate. A user
/// who disables Learning AFTER the migration must stay disabled across every later
/// restart — a boot reconcile would take the off-switch away permanently, the same
/// class of bug the migration repairs.
///
/// This FAILS if the version gating is removed — but note it takes BOTH gates to
/// turn it red, because they are redundant for v2: dropping only the
/// `current >= STORE_SCHEMA_VERSION` early return still leaves `current < 2` false
/// on the second run, and dropping only `current < 2` still hits the early return.
/// So this test pins the PROPERTY (run-once, never a reconcile), not either gate in
/// isolation. `a_v1_store_gets_only_the_v2_step` is what pins the per-step gate.
/// The first assert below is load-bearing in the other direction: it fails if the
/// v2 step is removed outright, which keeps the tail assert from passing vacuously.
#[tokio::test]
async fn a_later_learning_disable_is_never_undone_by_a_second_run() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(LEARNING, "1.0.0").await.unwrap();
    store.set_disabled(LEARNING).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;
    assert!(store.get(LEARNING).await.unwrap().unwrap().enabled);

    // The user turns Learning off again.
    store.set_disabled(LEARNING).await.unwrap();
    // Every subsequent boot.
    run_one_time_migrations(&store, &manifests).await;
    run_one_time_migrations(&store, &manifests).await;

    assert!(
        !store.get(LEARNING).await.unwrap().unwrap().enabled,
        "a deliberate disable must survive every later boot"
    );
}

/// v2 is exactly one id. It must not become a general "re-enable the pre-installed
/// set" reconcile: another app the user disabled stays disabled, and a not pre-installed
/// built-in is never enabled at all.
#[tokio::test]
async fn the_learning_migration_enables_no_other_app() {
    assert!(
        crate::plugins::builtins::CORE_PLUGINS.contains(&OPT_IN_BUILTIN)
            && !CORE_PREINSTALLED.contains(&OPT_IN_BUILTIN)
            && !LEGACY_DISABLED_SEED_IDS.contains(&OPT_IN_BUILTIN),
        "'{OPT_IN_BUILTIN}' must be a not pre-installed built-in outside the legacy seed set for \
         this test to mean anything"
    );
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    store.insert(LEARNING, "1.0.0").await.unwrap();
    store.set_disabled(LEARNING).await.unwrap();
    // A pre-installed app the user deliberately turned off. `skills` rather than
    // `recipes`: recipes is no longer pre-installed, and v5 deletes its record
    // outright, so it can no longer stand for "left alone by v2".
    let still_preinstalled = crate::plugins::builtins::SKILLS_PLUGIN_ID;
    assert!(
        CORE_PREINSTALLED.contains(&still_preinstalled)
            && !LEGACY_DISABLED_SEED_IDS.contains(&still_preinstalled),
        "'{still_preinstalled}' must be a pre-installed app outside the legacy seed set for this test to \
         mean anything"
    );
    store.insert(still_preinstalled, "1.0.0").await.unwrap();
    store.set_disabled(still_preinstalled).await.unwrap();
    // A not pre-installed built-in, never enabled.
    store.insert(OPT_IN_BUILTIN, "1.0.0").await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    assert!(store.get(LEARNING).await.unwrap().unwrap().enabled);
    assert!(
        !store
            .get(still_preinstalled)
            .await
            .unwrap()
            .unwrap()
            .enabled,
        "another pre-installed app the user disabled must stay disabled"
    );
    assert!(
        !store.get(OPT_IN_BUILTIN).await.unwrap().unwrap().enabled,
        "a not pre-installed built-in must never be enabled by this migration"
    );
}

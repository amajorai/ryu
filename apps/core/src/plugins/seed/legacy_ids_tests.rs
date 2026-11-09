use super::migrations_tests::{LEARNING, MONITORS};
use super::*;

/// Each step is gated on its OWN version, so bumping the schema for a later step
/// must NOT drag the v1 grant backfill along for a store that already ran it:
/// re-running it would re-grant the host-api grant to everyone who revoked it
/// since — the same "a reconcile silently overrides the user" bug the version
/// gate exists to prevent, invisible to the single-version revocation test above.
#[tokio::test]
async fn a_v1_store_gets_only_the_v2_step() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    store.set_schema_version(1).await.unwrap();

    // Enabled, and the user revoked the grant the v1 backfill had given it.
    store.insert(MONITORS, "1.0.0").await.unwrap();
    store.set_enabled(MONITORS, &[]).await.unwrap();
    store.insert(LEARNING, "1.0.0").await.unwrap();
    store.set_disabled(LEARNING).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    assert!(
        store
            .get(MONITORS)
            .await
            .unwrap()
            .unwrap()
            .approved_grants
            .is_empty(),
        "the v1 backfill must not re-run for a store already at v1"
    );
    assert!(
        store.get(LEARNING).await.unwrap().unwrap().enabled,
        "the v2 step must still run for a store at v1"
    );
}

/// An app the user never installed must not be conjured into existence.
#[tokio::test]
async fn an_absent_record_is_left_absent() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    run_one_time_migrations(&store, &manifests).await;

    assert!(store.get(MONITORS).await.unwrap().is_none());
}

/// **v3** — the upgrade case the seed change cannot reach on its own: every
/// existing install carries the disabled `@ryu/whiteboard` / `@ryu/canvas`
/// record the old legacy seed wrote, and `seed_preinstalled` leaves existing records
/// alone by design. Without this step the change ships as fresh-installs-only.
#[tokio::test]
async fn v3_removes_the_never_enabled_legacy_seed_records() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    // The pre-upgrade state the old companion seed produced: installed,
    // disabled, carrying the compiled-in bundle.
    for id in LEGACY_DISABLED_SEED_IDS {
        store.insert(id, "1.0.0").await.unwrap();
        store
            .set_ui_code(id, Some("<html>bundle</html>"))
            .await
            .unwrap();
    }

    run_one_time_migrations(&store, &manifests).await;

    for id in LEGACY_DISABLED_SEED_IDS {
        assert!(
            store.get(id).await.unwrap().is_none(),
            "'{id}' was a never-enabled legacy seed artifact — v3 must remove it"
        );
    }
}

/// The line v3 will not cross. `enabled` can only have come from a deliberate act
/// (nothing ever seeded these two enabled), so removing the record would delete a
/// working app out from under someone mid-use — the same "never override a later
/// user decision" rule v1 and v2 are built on.
#[tokio::test]
async fn v3_never_removes_an_enabled_record() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    let id = LEGACY_DISABLED_SEED_IDS[0];
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(id, &["spaces:docs".to_owned()])
        .await
        .unwrap();

    run_one_time_migrations(&store, &manifests).await;

    let record = store
        .get(id)
        .await
        .unwrap()
        .expect("an ENABLED record must survive v3");
    assert!(record.enabled, "and must stay enabled");
    assert_eq!(
        record.approved_grants,
        vec!["spaces:docs".to_owned()],
        "its grants must be untouched"
    );
}

/// Once per install, like every other step: a user who installs Whiteboard AFTER
/// the migration ran must keep it. A v3 that re-ran on every boot would make the
/// app un-installable-by-Store, which is strictly worse than the legacy record it
/// replaces.
#[tokio::test]
async fn v3_does_not_re_run_and_uninstall_a_later_install() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    run_one_time_migrations(&store, &manifests).await;

    // The user installs it afterwards, from the Store, and leaves it off.
    let id = LEGACY_DISABLED_SEED_IDS[0];
    store.insert(id, "1.0.0").await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    assert!(
        store.get(id).await.unwrap().is_some(),
        "'{id}' was installed AFTER v3 ran — the version gate must stop v3 from removing it"
    );
}

// ── v5: the five apps demoted out of CORE_PREINSTALLED ──────────────────────

/// THE reported bug, as a test: "I wiped all my state and Teams / Dashboards /
/// Clips are still installed."
///
/// They were, and v3 could not help, because it refuses to remove an ENABLED
/// record and `seed_preinstalled` had seeded all five ENABLED. This asserts the one
/// thing that makes v5 worth a schema bump: it removes them anyway.
#[tokio::test]
async fn v5_removes_the_demoted_apps_even_though_the_seed_left_them_enabled() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    // Exactly what the old pre-installed seed wrote on every existing install.
    for id in DEMOTED_FROM_PREINSTALLED_V5 {
        store.insert(id, "1.0.0").await.unwrap();
        store.set_enabled(id, &[]).await.unwrap();
        assert!(store.get(id).await.unwrap().unwrap().enabled);
    }

    run_one_time_migrations(&store, &manifests).await;

    for id in DEMOTED_FROM_PREINSTALLED_V5 {
        assert!(
            store.get(id).await.unwrap().is_none(),
            "'{id}' was auto-enabled by the old CORE_PREINSTALLED seed, not by the user — \
             v5 must remove the record so the app is genuinely absent"
        );
    }
}

/// v5's licence to delete an enabled record must not leak onto v3's ids. The two
/// steps disagree about what `enabled` MEANS — seeded, for the demoted five;
/// deliberate, for whiteboard/canvas — and that is the entire reason
/// [`DEMOTED_FROM_PREINSTALLED_V5`] is a frozen literal instead of a reference to
/// the legacy disabled-seed list. Wiring v5 to the live list would turn this red.
#[tokio::test]
async fn v5_leaves_the_v3_ids_alone() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    let whiteboard = crate::plugin_manifest::WHITEBOARD_PLUGIN_ID;
    assert!(
        LEGACY_DISABLED_SEED_IDS.contains(&whiteboard)
            && !DEMOTED_FROM_PREINSTALLED_V5.contains(&whiteboard),
        "'{whiteboard}' must be a v3-only id for this test to mean anything"
    );
    store.insert(whiteboard, "1.0.0").await.unwrap();
    store.set_enabled(whiteboard, &[]).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;

    assert!(
        store
            .get(whiteboard)
            .await
            .unwrap()
            .is_some_and(|r| r.enabled),
        "an ENABLED whiteboard record is a deliberate user act — only the seed ever \
         enabled the v5 ids, so v5 must not generalize its removal to v3's"
    );
}

/// Run-once, from the version gate alone: a user who re-installs Teams the day
/// after upgrading keeps it through every later boot. Without this the change
/// would be worse than the bug — an app the Store could install but never keep.
#[tokio::test]
async fn v5_does_not_re_run_and_uninstall_a_later_install() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    run_one_time_migrations(&store, &manifests).await;

    let id = crate::plugins::builtins::TEAMS_PLUGIN_ID;
    store.insert(id, "1.0.0").await.unwrap();
    store.set_enabled(id, &[]).await.unwrap();

    run_one_time_migrations(&store, &manifests).await;
    run_one_time_migrations(&store, &manifests).await;

    assert!(
        store.get(id).await.unwrap().is_some_and(|r| r.enabled),
        "'{id}' was installed AFTER v5 ran — the version gate must stop v5 from \
         removing it on every later boot"
    );
}

/// The fresh-install half, which is what a node reset actually exercises: seeding
/// an empty store must write NO record for any of the five. A pass here plus
/// `v5_removes_…` above is the full claim — "wipe your state and they are gone",
/// for new machines and upgraded ones alike.
#[tokio::test]
async fn a_fresh_seed_writes_no_record_for_the_demoted_apps() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    seed_preinstalled(&store, &manifests).await;
    for id in DEMOTED_FROM_PREINSTALLED_V5 {
        assert!(
            !CORE_PREINSTALLED.contains(id),
            "'{id}' must not be back in CORE_PREINSTALLED — that is what auto-installs it"
        );
        assert!(
            LEGACY_DISABLED_SEED_IDS.contains(id),
            "'{id}' must be covered by the legacy cleanup set"
        );
        assert!(
            store.get(id).await.unwrap().is_none(),
            "a fresh store must carry NO '{id}' record at all"
        );
    }
}

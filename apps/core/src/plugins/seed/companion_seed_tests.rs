use super::*;

/// THE A3 regression, re-pointed. ELEVEN not pre-installed built-in companions once
/// carried a real, size-guarded `ui_code` in `seed_overrides` that NOTHING ever
/// wrote, so enabling any of them from the Store mounted "this app has no
/// interface" (the contributions payload's `has_ui` reads `has_ui_code`).
///
/// The old fix was to create a DISABLED record carrying the bundle. That is no
/// longer the posture: every one of those ids is install-on-demand, so a fresh
/// store has no record for them and `lifecycle::install_app` carries the bundle
/// at Install time instead.
///
/// What must never come back is the limbo state in between — an app that is
/// automatically-created, disabled, and bundle-less. So this asserts the INVARIANT rather
/// than a list: every compiled-in companion bundle is reachable by exactly one of
/// the two live carriages (pre-installed seed, or install-time sourcing), and no
/// companion sits in a third state where neither runs.
#[tokio::test]
async fn every_companion_bundle_has_a_live_carriage() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    seed_preinstalled(&store, &manifests).await;

    // Non-vacuous: there are companion bundles to account for at all.
    let specs = companion_ui_specs();
    assert!(
        specs.len() >= 10,
        "expected the real companion bundle set, got {}",
        specs.len()
    );

    for spec in specs {
        let id = spec.id;
        let opt_in = !CORE_PREINSTALLED.contains(&id);
        assert!(
            !opt_in || store.get(id).await.unwrap().is_none(),
            "'{id}' must either be pre-installed or absent until explicit install"
        );

        // Whichever path owns it, the bundle itself must be real.
        let ui = compiled_in_ui_code(id)
            .unwrap_or_else(|| panic!("'{id}' must ship a compiled-in bundle"));
        assert!(
            ui.len() > 10_000 && ui.contains('<'),
            "'{id}' ui_code must be the real inlined companion bundle, got {} bytes",
            ui.len()
        );

        if opt_in {
            assert!(
                store.get(id).await.unwrap().is_none(),
                "'{id}' is opt-in, so a fresh store must carry no record"
            );
        } else {
            let record = store
                .get(id)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("pre-installed '{id}' must be seeded"));
            assert!(
                record.enabled,
                "pre-installed '{id}' must be seeded enabled"
            );
        }
    }
}

/// The end state for the former legacy-seeded apps, and the reason dropping the
/// old seed is safe rather than a regression: a fresh store has NO record for
/// them (so the Store lists them as available, not "Installed (off)"), and the
/// ordinary `install_app` carries the compiled-in bundle so a one-click Install
/// lands the exact record the old seed used to write.
///
/// Both halves matter. Asserting only the absence would pass just as well for the
/// broken version of this change — the one where the old seed is gone, nothing
/// replaces it, and enabling the app from the Store mounts "this app has no
/// interface" (the A3 regression the sibling test above exists for). The install
/// leg is what proves the carriage moved instead of disappearing.
#[tokio::test]
async fn opt_in_apps_get_no_record_but_stay_fully_installable() {
    use crate::plugin_manifest::{CANVAS_PLUGIN_ID, WHITEBOARD_PLUGIN_ID};

    // Non-vacuous, and pinned by name: this is a product decision, so a silent
    // emptying of the list must fail here rather than quietly recreate records.
    for id in [WHITEBOARD_PLUGIN_ID, CANVAS_PLUGIN_ID] {
        assert!(
            LEGACY_DISABLED_SEED_IDS.contains(&id),
            "'{id}' must be covered by the legacy cleanup set"
        );
        assert!(
            !CORE_PREINSTALLED.contains(&id),
            "'{id}' cannot be pre-installed and opt-in"
        );
    }

    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    seed_preinstalled(&store, &manifests).await;

    for id in LEGACY_DISABLED_SEED_IDS {
        assert!(
            store.get(id).await.unwrap().is_none(),
            "'{id}' must not receive a lifecycle record from the seed — a fresh install must carry no \
             record for it at all"
        );

        // …and the Store's Install must still deliver a mountable app.
        let manifest = manifests
            .iter()
            .find(|m| m.id == *id)
            .unwrap_or_else(|| panic!("'{id}' must be a compiled-in built-in manifest"));
        crate::plugins::lifecycle::install_app(&store, manifest)
            .await
            .unwrap();

        let record = store.get(id).await.unwrap().expect("installed");
        assert!(
            !record.enabled,
            "install must leave '{id}' DISABLED — Enable is a separate, Gateway-validated \
             step"
        );

        // The bundle leg applies only to COMPANION apps — the ones whose UI is a
        // compiled-in `ui_code` blob. The five sidecar apps demoted out of
        // `CORE_PREINSTALLED` are also install-on-demand but ship no such blob:
        // their UI is served by their own sidecar over the ext-proxy, so there is
        // no carriage to prove and `get_ui_code` is legitimately None. Keyed off
        // `compiled_in_ui_code` rather than an id list so it cannot rot, and
        // asserted in BOTH directions below so the branch can never become a
        // silent escape hatch for a companion that lost its bundle.
        let Some(_) = compiled_in_ui_code(id) else {
            assert!(
                DEMOTED_FROM_PREINSTALLED_V5.contains(id),
                "'{id}' has no compiled-in companion bundle, so its Install cannot attach \
                 one. That is only correct for a sidecar-served app; if '{id}' is a \
                 companion, this is the A3 regression — it will mount as \"this app has \
                 no interface\""
            );
            continue;
        };
        let ui = store.get_ui_code(id).await.unwrap().unwrap_or_else(|| {
            panic!(
                "installing '{id}' must attach its compiled-in companion bundle, or enabling \
                 it mounts \"this app has no interface\""
            )
        });
        assert!(
            ui.len() > 10_000 && ui.contains('<'),
            "'{id}' ui_code must be the real inlined companion bundle, got {} bytes",
            ui.len()
        );
    }
}

/// A second boot must not create opt-in records: the companion backfill runs on
/// EVERY boot, so the absence guarantee has to hold for an existing store too.
#[tokio::test]
async fn a_reboot_never_creates_an_opt_in_record() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    seed_preinstalled(&store, &manifests).await;
    seed_preinstalled(&store, &manifests).await;
    seed_preinstalled(&store, &manifests).await;

    for id in LEGACY_DISABLED_SEED_IDS {
        assert!(
            store.get(id).await.unwrap().is_none(),
            "'{id}' came back on a later boot — an uninstall must survive a restart"
        );
    }
}

/// The case-2 back-fill must keep working for a user who DID enable one of these:
/// the skip is only on the record-CREATION branch, so an existing record whose
/// bundle is missing is still repaired. Getting this wrong would strand exactly
/// the users who use the feature.
#[tokio::test]
async fn an_existing_opt_in_record_still_gets_its_bundle() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    let id = LEGACY_DISABLED_SEED_IDS[0];
    // A legacy record with no bundle (`store.insert` writes none).
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(id, &["spaces:docs".to_owned()])
        .await
        .unwrap();

    seed_preinstalled(&store, &manifests).await;

    assert!(
        store.has_ui_code(id).await.unwrap(),
        "'{id}' has an existing record, so the companion-ui back-fill must still fill its \
         missing bundle"
    );
    assert!(
        store.get(id).await.unwrap().unwrap().enabled,
        "the back-fill must never touch the enabled bit"
    );
}

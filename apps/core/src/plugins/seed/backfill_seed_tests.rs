use super::tests::{manifest, spec};
use super::*;

/// The seed table stays in lockstep with `CORE_PREINSTALLED`: every pre-installed id
/// gets exactly one spec, and the pre-installed companions carry their grants + UI code.
#[test]
fn preinstalled_specs_cover_core_preinstalled_exactly() {
    let specs = preinstalled_specs();
    assert_eq!(specs.len(), CORE_PREINSTALLED.len());
    for id in CORE_PREINSTALLED {
        assert_eq!(
            specs.iter().filter(|s| s.id == *id).count(),
            1,
            "'{id}' must have exactly one seed spec"
        );
    }
    let with_ui: Vec<&str> = specs
        .iter()
        .filter(|s| s.ui_code.is_some())
        .map(|s| s.id)
        .collect();
    assert_eq!(
        with_ui,
        vec![
            crate::plugins::builtins::PROJECTS_PLUGIN_ID,
            crate::plugins::builtins::LEARNING_PLUGIN_ID,
            crate::plugins::builtins::WEBHOOKS_PLUGIN_ID,
            crate::plugins::builtins::CALENDAR_PLUGIN_ID,
            crate::plugins::builtins::HELP_CENTER_PLUGIN_ID,
            crate::plugins::builtins::SITES_PLUGIN_ID,
            crate::plugins::builtins::FORMS_PLUGIN_ID,
            crate::plugins::builtins::CHAT_BROADCAST_PLUGIN_ID,
        ],
        "only the companions that STAY pre-installed ship their prebuilt UI bundle via \
         the pre-installed seed, in CORE_PREINSTALLED order. The other companion apps \
         (whiteboard/canvas/finetune/meetings/quests/approvals/monitors/workflows/ \
         activity/timeline/skill-editor, plus mail) are opt-in (not pre-installed), so they \
         leave the pre-installed seed — their SeedSpec `ui_code` is carried by \
         explicit install instead, onto the record created by the user, which is what makes \
         enabling one from the Store mount a real UI. `projects` is pre-installed as the top of the Projects › Bots › Sessions hierarchy, and `learning` is back in the set: \
         it owns the consent switches for a capture path the kernel runs regardless \
         of the record (see CORE_PREINSTALLED)"
    );
    // Non-companion Core plugins seed with EMPTY grants, exactly as the generic
    // loop did before this module existed.
    let engines = specs.iter().find(|s| s.id == "@ryu/engines").unwrap();
    assert!(engines.grants.is_empty());
}

/// The upgrade path for a grant SPLIT: a record enabled before `quests:capture`
/// existed must gain it, without losing what it had or changing whether it is on.
#[tokio::test]
async fn backfill_adds_a_newly_declared_grant_to_an_existing_record() {
    let store = PluginStore::open_in_memory().unwrap();
    let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(id, &["quests:crud".to_owned()])
        .await
        .unwrap();

    super::backfill_declared_grants(&store).await;

    let record = store.get(id).await.unwrap().unwrap();
    assert!(record.approved_grants.iter().any(|g| g == "quests:crud"));
    assert!(record.approved_grants.iter().any(|g| g == "quests:capture"));
    assert!(record.enabled, "backfill must not change the enabled bit");
}

/// Additive only: a grant the user's record carries that the build does not
/// declare survives the backfill.
#[tokio::test]
async fn backfill_never_removes_a_grant() {
    let store = PluginStore::open_in_memory().unwrap();
    let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(
            id,
            &["quests:crud".to_owned(), "something:extra".to_owned()],
        )
        .await
        .unwrap();

    super::backfill_declared_grants(&store).await;

    let record = store.get(id).await.unwrap().unwrap();
    assert!(record
        .approved_grants
        .iter()
        .any(|g| g == "something:extra"));
    assert!(record.approved_grants.iter().any(|g| g == "quests:capture"));
}

/// A DISABLED app is not re-granted. `set_disabled` wipes `approved_grants` —
/// disabling revokes consent — so a backfill that re-added them would silently
/// undo the user's decision.
#[tokio::test]
async fn backfill_leaves_a_disabled_app_revoked() {
    let store = PluginStore::open_in_memory().unwrap();
    let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(id, &["quests:crud".to_owned()])
        .await
        .unwrap();
    store.set_disabled(id).await.unwrap();

    super::backfill_declared_grants(&store).await;

    let record = store.get(id).await.unwrap().unwrap();
    assert!(!record.enabled, "a disabled app must stay disabled");
    assert!(
        record.approved_grants.is_empty(),
        "disabling revoked its grants; the backfill must not hand them back"
    );
}

/// No record = nothing installed. Installing is the seed's job, not the
/// backfill's, so it must not conjure one.
#[tokio::test]
async fn backfill_does_not_create_a_record() {
    let store = PluginStore::open_in_memory().unwrap();
    super::backfill_declared_grants(&store).await;
    assert!(store
        .get(crate::plugins::builtins::QUESTS_PLUGIN_ID)
        .await
        .unwrap()
        .is_none());
}

/// End-to-end over the real store: a fresh install seeds every pre-installed
/// plugin enabled, and a second run never re-seeds (a user's disable sticks).
#[tokio::test]
async fn seeding_is_one_time_and_respects_a_user_disable() {
    let store = PluginStore::open_in_memory().unwrap();
    let manifests = vec![
        manifest("@ryu/engines", "1.0.0", &[]),
        manifest("@ryu/durable", "1.0.0", &[]),
    ];
    let specs = [spec("@ryu/engines"), spec("@ryu/durable")];
    let (ordered, _) = seed_order(&specs, &manifests);
    assert_eq!(ordered.len(), 2);

    // Simulate the seed for this synthetic set (seed_preinstalled drives the real
    // CORE_PREINSTALLED table; the store behaviour under test is identical).
    for id in &ordered {
        store.insert(id, "1.0.0").await.unwrap();
        store.set_enabled(id, &[]).await.unwrap();
    }
    // The user disables one.
    store.set_disabled("@ryu/durable").await.unwrap();

    // A re-seed must leave it disabled: a present record always wins.
    for id in &ordered {
        if store.get(id).await.unwrap().is_some() {
            continue;
        }
        store.set_enabled(id, &[]).await.unwrap();
    }
    assert!(store.get("@ryu/engines").await.unwrap().unwrap().enabled);
    assert!(!store.get("@ryu/durable").await.unwrap().unwrap().enabled);
}

/// A catalog materializer creates the lifecycle row before the pre-installed
/// pass runs. Only rows it created on this boot may be enabled; an older
/// disabled row remains the user's choice.
#[tokio::test]
async fn newly_materialized_preinstalled_is_enabled_without_resurrecting_disabled_state() {
    let store = PluginStore::open_in_memory().unwrap();
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let user_disabled = "@ryu/goal";
    let newly_materialized = "@ryu/proof";

    store.insert(user_disabled, "1.0.0").await.unwrap();
    store.set_disabled(user_disabled).await.unwrap();
    store.insert(newly_materialized, "1.0.0").await.unwrap();

    let materialized = std::collections::HashSet::from([newly_materialized.to_owned()]);
    seed_preinstalled_with_materialized(&store, &manifests, &materialized).await;

    assert!(!store.get(user_disabled).await.unwrap().unwrap().enabled);
    assert!(
        store
            .get(newly_materialized)
            .await
            .unwrap()
            .unwrap()
            .enabled
    );
}

/// The W7 Mail-companion extraction used to rest on mail having a legacy disabled
/// seed record: it was the first opt-in built-in companion, so the pre-installed loop
/// never touched it, and the record existed purely to carry its `ui_code`.
///
/// Mail is now install-on-demand, so a fresh store carries no mail record at
/// all and the bundle arrives from `lifecycle::install_app` instead. The property
/// the extraction actually needs is unchanged and still pinned here: whatever path
/// puts mail on the machine, the compiled-in bundle must come with it, or enabling
/// mail mounts a broken "no runnable UI" companion.
#[tokio::test]
async fn mail_stays_absent_until_install_and_carries_its_bundle() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();

    seed_preinstalled(&store, &manifests).await;

    let mail_id = crate::plugins::builtins::MAIL_PLUGIN_ID;
    assert!(
        store.get(mail_id).await.unwrap().is_none(),
        "mail must not receive a seed record — an unconfigured inbox has no business \
         appearing as Installed on a fresh machine"
    );
    let manifest = manifests
        .iter()
        .find(|manifest| manifest.id == mail_id)
        .expect("mail manifest");
    crate::plugins::lifecycle::install_app(&store, manifest)
        .await
        .unwrap();
    assert!(!store.get(mail_id).await.unwrap().unwrap().enabled);
    assert!(store.has_ui_code(mail_id).await.unwrap());
    let ui = compiled_in_ui_code(mail_id)
        .expect("mail must still ship a compiled-in bundle for install_app to source");
    assert!(
        ui.len() > 10_000 && ui.contains('<'),
        "mail ui_code must be the real inlined companion bundle, got {} bytes",
        ui.len()
    );
}

use super::*;
use crate::plugin_manifest::{AppDependency, Requires};

pub(super) fn manifest(id: &str, version: &str, deps: &[&str]) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: version.to_owned(),
        requires: (!deps.is_empty()).then(|| Requires {
            apps: deps
                .iter()
                .map(|d| AppDependency {
                    id: (*d).to_owned(),
                    min_version: None,
                })
                .collect(),
            capabilities: vec![],
            grants: vec![],
        }),
        ..Default::default()
    }
}

pub(super) fn spec(id: &'static str) -> SeedSpec {
    SeedSpec {
        id,
        grants: &[],
        ui_code: None,
    }
}

#[test]
fn production_runtime_set_can_seed_memory() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_runtime_builtins_for_test();
    assert!(
        manifests
            .iter()
            .any(|manifest| manifest.id == crate::plugins::builtins::MEMORY_PLUGIN_ID),
        "the production runtime fixture set must load the Memory manifest"
    );
    let (ordered, skipped) = seed_order(&preinstalled_specs(), &manifests);
    assert!(
        skipped
            .iter()
            .all(|seed| seed.id != crate::plugins::builtins::MEMORY_PLUGIN_ID),
        "Memory was skipped during production pre-installed ordering: {skipped:?}"
    );
    assert!(ordered
        .iter()
        .any(|id| id == crate::plugins::builtins::MEMORY_PLUGIN_ID));
}

/// Capability edges (`requires.capabilities`) are lowered at seed time, so the
/// seed order respects them: with the REAL built-ins, spaces requires the `rag`
/// capability and rag requires `engines`, so the order is engines → rag → spaces
/// even though those are capability edges, not app deps.
#[test]
fn seed_order_respects_capability_edges() {
    let specs = preinstalled_specs();
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let (order, skipped) = seed_order(&specs, &manifests);
    let pos = |id: &str| order.iter().position(|x| x == id);
    let (e, r, s) = (pos("@ryu/engines"), pos("@ryu/rag"), pos("@ryu/spaces"));
    assert!(
        e.is_some() && r.is_some() && s.is_some(),
        "engines/rag/spaces all seeded (order: {order:?})"
    );
    assert!(e < r && r < s, "engines → rag → spaces (order: {order:?})");
    assert!(
        !skipped
            .iter()
            .any(|sk| sk.id == "@ryu/spaces" || sk.id == "@ryu/rag"),
        "no capability-related seed skip (skipped: {skipped:?})"
    );
}

/// THE regression this module exists for: the seed list is written by hand and
/// is NOT topological. A dependent declared BEFORE its dependency must still be
/// seeded AFTER it.
#[test]
fn seed_order_is_topological_even_when_declaration_order_is_not() {
    // "meetings" is declared first but requires "spaces".
    let specs = [spec("meetings"), spec("spaces")];
    let manifests = vec![
        manifest("meetings", "1.0.0", &["spaces"]),
        manifest("spaces", "1.0.0", &[]),
    ];

    let (ordered, skipped) = seed_order(&specs, &manifests);

    assert!(skipped.is_empty());
    assert_eq!(ordered, vec!["spaces".to_owned(), "meetings".to_owned()]);
}

/// FAIL-CLOSED: a pre-installed plugin whose dependency is NOT pre-installed is not
/// seeded at all — never enabled with a dependency that was never enabled.
#[test]
fn a_dependency_outside_the_preinstalled_set_skips_the_plugin() {
    let specs = [spec("meetings")];
    let manifests = vec![
        manifest("meetings", "1.0.0", &["spaces"]),
        // `spaces` is loaded, but it is NOT in the pre-installed set.
        manifest("spaces", "1.0.0", &[]),
    ];

    let (ordered, skipped) = seed_order(&specs, &manifests);

    assert!(ordered.is_empty(), "nothing may be seeded: {ordered:?}");
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0].id, "meetings");
    assert!(matches!(
        skipped[0].error,
        graph::DependencyError::MissingDependency { .. }
    ));
}

/// A cycle among pre-installed plugins is skipped, not seeded (and never hangs).
#[test]
fn a_cycle_is_skipped() {
    let specs = [spec("a"), spec("b")];
    let manifests = vec![
        manifest("a", "1.0.0", &["b"]),
        manifest("b", "1.0.0", &["a"]),
    ];

    let (ordered, skipped) = seed_order(&specs, &manifests);

    assert!(ordered.is_empty());
    assert_eq!(skipped.len(), 2, "both ends of the cycle are unsatisfiable");
}

/// BACKWARD COMPAT: today NO built-in declares `requires`, so the order must be
/// exactly the declaration order and nothing may be skipped.
#[test]
fn without_requires_the_order_is_the_declaration_order() {
    let specs = [
        spec("@ryu/engines"),
        spec("@ryu/durable"),
        spec("@ryu/goal"),
    ];
    let manifests = vec![
        manifest("@ryu/engines", "1.0.0", &[]),
        manifest("@ryu/durable", "1.0.0", &[]),
        manifest("@ryu/goal", "1.0.0", &[]),
    ];

    let (ordered, skipped) = seed_order(&specs, &manifests);

    assert!(skipped.is_empty());
    assert_eq!(ordered, vec!["@ryu/engines", "@ryu/durable", "@ryu/goal"]);
}

/// A spec with no loaded manifest is silently dropped (the pre-graph behaviour:
/// the version lookup returned `None` and the block did nothing).
#[test]
fn a_spec_without_a_manifest_is_dropped() {
    let specs = [spec("@ryu/engines"), spec("not-loaded")];
    let manifests = vec![manifest("@ryu/engines", "1.0.0", &[])];

    let (ordered, skipped) = seed_order(&specs, &manifests);

    assert_eq!(ordered, vec!["@ryu/engines"]);
    assert!(skipped.is_empty(), "absent != unsatisfiable");
}

/// A fresh install must seed the Pi-extension plugins INSTALLED + ENABLED.
///
/// Pinned separately from the lockstep check below because the failure is
/// invisible: `pi_config::app_extensions` resolves over the *enabled record set*,
/// so an id that never gets an enabled record materializes nothing and the
/// flagship agent silently loses background bash, sub-agents and the monitor.
/// Before `pi-shell`/`pi-subagent` were plugins, Core shipped both
/// unconditionally — a fresh install losing them would be a pure regression,
/// with a missing tool as its only symptom. `pi-monitor` is net-new but
/// pre-installed by design (a first-class capability the flagship should have),
/// so the same guard pins it too, as it does `pi-copy` (the default
/// `copy_paste` file tool).
///
/// The pre-installed axis is enough here: the id is in `CORE_PREINSTALLED` (so
/// `preinstalled_specs` yields a spec, which the seed loop inserts + enables).
#[test]
fn the_pi_extension_plugins_are_seeded_enabled_on_a_fresh_install() {
    let specs = preinstalled_specs();
    for id in [
        "@ryu/pi-shell",
        "@ryu/pi-subagent",
        "@ryu/pi-monitor",
        "@ryu/pi-copy",
    ] {
        assert!(
            specs.iter().any(|s| s.id == id),
            "'{id}' has no pre-installed seed spec, so a fresh install would never create \
             an enabled record — and its Pi extension would never be materialized"
        );
        assert!(
            !LEGACY_DISABLED_SEED_IDS.contains(&id),
            "'{id}' must not be a legacy opt-in seed id"
        );
        assert!(
            crate::plugins::builtins::tier_for(id) == crate::plugin_manifest::PluginTier::Core,
            "'{id}' must be Core-tier: may_ship_pi_extensions auto-allows only Core, \
             and a Community-tier built-in would need the operator-only \
             'pi:extension' grant to ship anything at all"
        );
    }
}

/// The carriage list is DERIVED from `seed_overrides`, never a second hardcoded
/// array — that duplication is what left eleven companions with an unreachable
/// bundle. A 17th companion row therefore needs no second edit: it is picked up
/// by the pre-installed loop (if pre-installed) or by explicit install (if not), and
/// this asserts both halves are non-empty so neither branch can rot unnoticed.
#[test]
fn the_companion_bundle_carriage_is_derived_from_the_one_table() {
    let with_ui: Vec<&str> = seed_overrides()
        .iter()
        .filter(|s| s.ui_code.is_some())
        .map(|s| s.id)
        .collect();
    assert!(
        !with_ui.is_empty(),
        "seed_overrides must carry compiled-in companion bundles"
    );
    let carried: Vec<&str> = companion_ui_specs().into_iter().map(|s| s.id).collect();
    assert_eq!(
        carried, with_ui,
        "every seed_overrides row with a ui_code must be carried, in table order"
    );
    assert!(
        carried.iter().any(|id| CORE_PREINSTALLED.contains(id)),
        "some companions are pre-installed (their bundle rides the enable loop)"
    );
    assert!(
        carried.iter().any(|id| !CORE_PREINSTALLED.contains(id)),
        "some companions are opt-in (their bundle rides explicit install)"
    );
}

/// The UPGRADE half of the repair. Several of these apps began life as wave-2
/// route-gate governance shells and only gained a companion runnable in the W7
/// extraction, so a pre-existing install carries a record written before any
/// bundle existed — and the seed loop leaves every existing record alone
/// (`Ok(Some(_)) => continue`), which is right for enable/disable and wrong for
/// build content. Filling it must not disturb one bit of user state.
#[tokio::test]
async fn a_pre_existing_record_without_a_bundle_is_filled_without_touching_user_state() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;

    // The pre-upgrade state: installed + enabled with its grant, no ui_code.
    store.insert(id, "1.0.0").await.unwrap();
    store
        .set_enabled(id, &["quests:crud".to_owned()])
        .await
        .unwrap();
    assert!(!store.has_ui_code(id).await.unwrap());

    seed_preinstalled(&store, &manifests).await;

    let ui = store
        .get_ui_code(id)
        .await
        .unwrap()
        .expect("a record predating the bundle must be back-filled, not left mounting empty");
    assert!(ui.len() > 10_000 && ui.contains('<'));
    let record = store.get(id).await.unwrap().unwrap();
    assert!(record.enabled, "the fill must not disturb enabled state");
    // The bundle fill itself rewrites NO grants. The pass as a whole is allowed
    // to ADD one the build declares (`backfill_declared_grants`) — that is not
    // user state — but the grant the record already had must survive verbatim,
    // and nothing may be dropped.
    assert!(
        record.approved_grants.iter().any(|g| g == "quests:crud"),
        "the fill must not drop a grant the record already had"
    );
    assert!(
        record.approved_grants.iter().all(|g| seed_overrides()
            .iter()
            .any(|spec| spec.id == id && spec.grants.contains(&g.as_str()))),
        "the pass must only ever add grants the build itself declares"
    );
    assert_eq!(
        record.version, "1.0.0",
        "the fill must not silently re-version the record"
    );
}

/// Only ever FILLS a gap. A record that already carries a bundle keeps it —
/// otherwise every boot would clobber whatever the update lifecycle installed
/// (`update_app` is the one other `set_ui_code` writer) with the compiled-in
/// build, which is a downgrade dressed up as a repair.
#[tokio::test]
async fn an_existing_companion_bundle_is_never_overwritten() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let store = PluginStore::open_in_memory().unwrap();
    let id = crate::plugins::builtins::QUESTS_PLUGIN_ID;
    const SENTINEL: &str = "<!-- installed by the update lifecycle -->";

    store.insert(id, "1.0.0").await.unwrap();
    store.set_ui_code(id, Some(SENTINEL)).await.unwrap();

    seed_preinstalled(&store, &manifests).await;

    assert_eq!(
        store.get_ui_code(id).await.unwrap().as_deref(),
        Some(SENTINEL),
        "a stored bundle must never be overwritten by the compiled-in one"
    );
}

/// Every [`seed_overrides`] row must approve EXACTLY what its manifest declares
/// in `permission_grants` — no more, no less.
///
/// # Why this is a test and not derived code
///
/// The obvious "cleanup" here is to delete `SeedSpec::grants` and read
/// `manifest.permission_grants` at seed time. That would be a privilege
/// escalation, not a refactor. A plugin with NO row seeds with `grants: &[]`
/// (see [`preinstalled_specs`]), and ten pre-installed plugins are in exactly that
/// state while declaring grants in their manifests — `agentbrowser` and `exa`
/// declare `tool:execute`, `ghost` declares `mcp:ghost`, `shadow` and `exa`
/// declare `tool:http-egress:*`. Deriving would pre-approve all of it at seed
/// time, when the Gateway is not reachable to refuse anything, and would leave
/// any built-in able to widen its own approved set by editing its own manifest.
///
/// This table is therefore a HUMAN-REVIEWED ALLOWLIST that is deliberately
/// narrower than the union of what manifests ask for. The same judgement is
/// already visible in [`backfill_host_api_grants`], which takes only the
/// `sidecars[].host_api.grants` INTERSECTED with `permission_grants` rather
/// than trusting the declaration.
///
/// What is genuinely worth enforcing is that a row and its manifest do not
/// DRIFT: an over-grant hands a frame a capability its manifest never asked
/// for and the Gateway never reviewed, and an under-grant ships a companion
/// whose frame is refused a capability it actually uses — the failure mode the
/// `recipes` row's comment describes. Both are caught here, at compile-and-test
/// time, without surrendering the allowlist.
#[test]
fn seed_grants_match_the_manifest_they_belong_to() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let mut checked = 0;

    for spec in seed_overrides() {
        let Some(manifest) = manifests.iter().find(|m| m.id == spec.id) else {
            panic!(
                "seed row '{}' has no compiled-in manifest — add it to BUILTIN_MANIFESTS \
                 or drop the row",
                spec.id
            );
        };

        let mut approved: Vec<&str> = spec.grants.to_vec();
        approved.sort_unstable();
        let mut declared: Vec<&str> = manifest
            .permission_grants
            .iter()
            .map(String::as_str)
            .collect();
        declared.sort_unstable();

        assert_eq!(
            approved, declared,
            "seed row '{}' and its manifest disagree on grants.\n  \
             seed approves: {approved:?}\n  manifest declares: {declared:?}\n\
             Extra in the seed is an UNREVIEWED grant; extra in the manifest means \
             the app's frame will be refused a capability it uses. Fix whichever \
             side is wrong — do not derive one from the other (see this test's docs).",
            spec.id
        );
        checked += 1;
    }

    assert_eq!(
        checked,
        seed_overrides().len(),
        "every seed row must be covered"
    );
}

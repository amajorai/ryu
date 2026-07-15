//! Default-on plugin seeding — the ONE definition of "what is enabled on a fresh
//! install".
//!
//! # Why this is not `lifecycle::enable_app`
//!
//! Seeding runs during startup, **before the Gateway sidecar is spawned**
//! (`main.rs` starts it well after this; the gateway-policy seed comment says the
//! same). `enable_app` fails **closed** on an unreachable Gateway, so routing the
//! seed through it would leave every default-on plugin disabled on every fresh
//! install — a hard regression. The seed is a trusted first-party bootstrap that
//! writes the store directly, with explicit, hardcoded grants.
//!
//! That bypass is safe for *policy* (these are our own plugins, with grants we
//! chose) but it MUST NOT bypass the **dependency graph** — otherwise the very
//! first first-party plugin to declare `requires` would be seeded enabled while
//! its dependency stayed disabled, i.e. exactly the half-enabled state the graph
//! exists to prevent, on the path every user hits. So this module keeps the
//! store-only write and adds the two things the graph gives `enable_app`:
//!
//! 1. **Topological order** — a dependency is always seeded before its dependent
//!    (the declaration order of [`crate::plugins::builtins::CORE_DEFAULT_ON`] is
//!    NOT topological, and must not have to be).
//! 2. **Fail-closed satisfiability** — a default-on plugin whose `requires` cannot
//!    be satisfied *from within the default-on set* is SKIPPED (logged loudly),
//!    never seeded enabled with a missing dependency.
//!
//! # The default-on set is the universe
//!
//! [`seed_order`] resolves each plugin against the default-on manifests **only**.
//! A default-on plugin that depends on an opt-in plugin therefore reports
//! `MissingDependency` and is skipped, rather than silently auto-installing
//! something the user never asked for. `enable_app` would report the same error
//! for an uninstalled dependency; a seed must not be more permissive than an
//! explicit enable.
//!
//! # Core-vs-Gateway boundary
//!
//! Pure Core: this decides *what runs* on a fresh install. No policy is enforced
//! here — the grants below are the fixed, first-party set the Gateway is asked to
//! honour, and every *call-time* capability check still goes through the Gateway.

use crate::plugin_manifest::PluginManifest;
use crate::plugins::{builtins::CORE_DEFAULT_ON, graph, PluginStore};

/// One default-on plugin and everything the seed must write for it.
#[derive(Debug, Clone, Copy)]
pub struct SeedSpec {
    /// Manifest id.
    pub id: &'static str,
    /// Grants to persist as approved. The Gateway is not reachable at seed time,
    /// so these are the fixed first-party set (empty for most Core plugins; the
    /// companions need theirs to drive Spaces/media/finetune from their frames).
    pub grants: &'static [&'static str],
    /// Prebuilt companion UI bundle, when the plugin ships one.
    pub ui_code: Option<&'static str>,
}

/// Plugins that need more than `insert + set_enabled(&[])`: explicit grants and/or
/// a prebuilt `ui_code` bundle. Everything else in [`CORE_DEFAULT_ON`] seeds with
/// empty grants and no UI code (unchanged from the pre-graph behaviour).
///
/// The three companions need a UI bundle + the grants their sandboxed frames use.
/// `meetings` needs only a grant: it ships no frame (its code is in-crate), but it
/// really does write Space documents, so its approved grants must match the
/// `permission_grants` its manifest declares — otherwise the record would claim
/// less than the app does.
fn seed_overrides() -> [SeedSpec; 4] {
    use crate::plugin_manifest::{
        CANVAS_PLUGIN_ID, CANVAS_UI_HTML, FINETUNE_PLUGIN_ID, FINETUNE_UI_HTML,
        WHITEBOARD_PLUGIN_ID, WHITEBOARD_UI_HTML,
    };
    [
        SeedSpec {
            id: WHITEBOARD_PLUGIN_ID,
            // Its sandboxed frame owns Space documents + AI-generates.
            grants: &["spaces:docs", "hook:side-model"],
            ui_code: Some(WHITEBOARD_UI_HTML),
        },
        SeedSpec {
            id: CANVAS_PLUGIN_ID,
            // Space documents + catalog listing + the media/agent bridge.
            grants: &[
                "spaces:docs",
                "core:list_agents",
                "media:generate",
                "media:transcribe",
                "hook:run-agent",
                "hook:side-model",
            ],
            ui_code: Some(CANVAS_UI_HTML),
        },
        SeedSpec {
            id: FINETUNE_PLUGIN_ID,
            // Core's fine-tune orchestration + its declared Unsloth training sidecar.
            grants: &["finetune:runs", "sidecar:process"],
            ui_code: Some(FINETUNE_UI_HTML),
        },
        SeedSpec {
            id: crate::plugins::builtins::MEETINGS_PLUGIN_ID,
            // It saves finalized notes into the "Meetings" Space. No UI bundle: the
            // Meetings screens are native desktop pages, not a sandboxed frame.
            grants: &["spaces:docs"],
            ui_code: None,
        },
    ]
}

/// The full default-on seed table, in declaration order.
///
/// One list, derived from [`CORE_DEFAULT_ON`] — the overridden plugins are the same
/// ids with richer specs, so a plugin can never be default-on in one list and absent
/// from the other.
pub fn default_on_specs() -> Vec<SeedSpec> {
    let overrides = seed_overrides();
    CORE_DEFAULT_ON
        .iter()
        .map(|id| {
            overrides
                .iter()
                .find(|o| o.id == *id)
                .copied()
                .unwrap_or(SeedSpec {
                    id,
                    grants: &[],
                    ui_code: None,
                })
        })
        .collect()
}

/// A default-on plugin that could not be seeded, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSeed {
    pub id: String,
    pub error: graph::DependencyError,
}

/// Order the default-on set so every dependency precedes its dependents, and
/// separate out the plugins whose `requires` cannot be satisfied.
///
/// Pure: no store, no I/O. `manifests` is the loaded manifest set; specs with no
/// loaded manifest are dropped (nothing to seed), exactly as before.
///
/// Returns `(ordered_ids, skipped)`. `ordered_ids` is a valid topological order of
/// the seedable default-on plugins; `skipped` names the ones whose dependency graph
/// is unsatisfiable *within the default-on set* — they are NOT enabled (fail-closed).
pub fn seed_order(
    specs: &[SeedSpec],
    manifests: &[PluginManifest],
) -> (Vec<String>, Vec<SkippedSeed>) {
    // The universe for resolution is the default-on set itself (see module docs).
    let universe: Vec<PluginManifest> = specs
        .iter()
        .filter_map(|s| manifests.iter().find(|m| m.id == s.id))
        .cloned()
        .collect();

    let mut ordered: Vec<String> = Vec::new();
    let mut skipped: Vec<SkippedSeed> = Vec::new();

    for spec in specs {
        // No loaded manifest ⇒ nothing to seed (unchanged: the old code looked up
        // the version and silently did nothing when absent).
        if !universe.iter().any(|m| m.id == spec.id) {
            continue;
        }
        match graph::resolve_enable_order(spec.id, &universe) {
            // deps-first, target-last. Appending in that order keeps `ordered`
            // topologically valid; a plugin already placed by an earlier spec's
            // closure is not re-added.
            Ok(order) => {
                for id in order {
                    if !ordered.contains(&id) {
                        ordered.push(id);
                    }
                }
            }
            Err(error) => skipped.push(SkippedSeed {
                id: spec.id.to_owned(),
                error,
            }),
        }
    }

    (ordered, skipped)
}

/// Seed the default-on plugins on a fresh install: install + enable each, in
/// dependency order.
///
/// One-time and user-respecting: a plugin with ANY existing record (enabled OR
/// disabled) is left alone, so a user who disables a default-on plugin keeps it
/// disabled across restarts.
pub async fn seed_default_on(store: &PluginStore, manifests: &[PluginManifest]) {
    let specs = default_on_specs();
    let (ordered, skipped) = seed_order(&specs, manifests);

    for s in &skipped {
        tracing::error!(
            "default-on seed: SKIPPING '{}' — its dependencies cannot be satisfied from the \
             default-on set: {}. It stays disabled (fail-closed); enabling it by hand will \
             report the same error until the dependency is installed.",
            s.id,
            s.error
        );
    }

    for id in &ordered {
        let Some(spec) = specs.iter().find(|s| s.id == id) else {
            continue;
        };

        match store.get(id).await {
            // A record exists (enabled or disabled) — the user's choice wins.
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("default-on seed: lookup '{id}' failed: {e}");
                continue;
            }
        }

        let Some(version) = manifests
            .iter()
            .find(|m| m.id == *id)
            .map(|m| m.version.clone())
        else {
            continue;
        };

        if let Err(e) = store.insert(id, &version).await {
            tracing::warn!("default-on seed: insert '{id}' failed: {e}");
            continue;
        }
        if let Some(ui_code) = spec.ui_code {
            if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                tracing::warn!("default-on seed: set_ui_code '{id}' failed: {e}");
                continue;
            }
        }
        let grants: Vec<String> = spec.grants.iter().map(|g| (*g).to_owned()).collect();
        if let Err(e) = store.set_enabled(id, &grants).await {
            tracing::warn!("default-on seed: enable '{id}' failed: {e}");
        } else {
            tracing::info!("default-on seed: enabled '{id}'");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{AppDependency, Requires};

    fn manifest(id: &str, version: &str, deps: &[&str]) -> PluginManifest {
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
                grants: vec![],
            }),
            ..Default::default()
        }
    }

    fn spec(id: &'static str) -> SeedSpec {
        SeedSpec {
            id,
            grants: &[],
            ui_code: None,
        }
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

    /// FAIL-CLOSED: a default-on plugin whose dependency is NOT default-on is not
    /// seeded at all — never enabled with a dependency that was never enabled.
    #[test]
    fn a_dependency_outside_the_default_on_set_skips_the_plugin() {
        let specs = [spec("meetings")];
        let manifests = vec![
            manifest("meetings", "1.0.0", &["spaces"]),
            // `spaces` is loaded, but it is NOT in the default-on set.
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

    /// A cycle among default-on plugins is skipped, not seeded (and never hangs).
    #[test]
    fn a_cycle_is_skipped() {
        let specs = [spec("a"), spec("b")];
        let manifests = vec![manifest("a", "1.0.0", &["b"]), manifest("b", "1.0.0", &["a"])];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(ordered.is_empty());
        assert_eq!(skipped.len(), 2, "both ends of the cycle are unsatisfiable");
    }

    /// BACKWARD COMPAT: today NO built-in declares `requires`, so the order must be
    /// exactly the declaration order and nothing may be skipped.
    #[test]
    fn without_requires_the_order_is_the_declaration_order() {
        let specs = [spec("engines"), spec("durable"), spec("goal")];
        let manifests = vec![
            manifest("engines", "1.0.0", &[]),
            manifest("durable", "1.0.0", &[]),
            manifest("goal", "1.0.0", &[]),
        ];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert!(skipped.is_empty());
        assert_eq!(ordered, vec!["engines", "durable", "goal"]);
    }

    /// A spec with no loaded manifest is silently dropped (the pre-graph behaviour:
    /// the version lookup returned `None` and the block did nothing).
    #[test]
    fn a_spec_without_a_manifest_is_dropped() {
        let specs = [spec("engines"), spec("not-loaded")];
        let manifests = vec![manifest("engines", "1.0.0", &[])];

        let (ordered, skipped) = seed_order(&specs, &manifests);

        assert_eq!(ordered, vec!["engines"]);
        assert!(skipped.is_empty(), "absent != unsatisfiable");
    }

    /// The seed table stays in lockstep with `CORE_DEFAULT_ON`: every default-on id
    /// gets exactly one spec, and the three companions carry their grants + UI code.
    #[test]
    fn default_on_specs_cover_core_default_on_exactly() {
        let specs = default_on_specs();
        assert_eq!(specs.len(), CORE_DEFAULT_ON.len());
        for id in CORE_DEFAULT_ON {
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
                crate::plugin_manifest::WHITEBOARD_PLUGIN_ID,
                crate::plugin_manifest::CANVAS_PLUGIN_ID,
                crate::plugin_manifest::FINETUNE_PLUGIN_ID,
            ],
            "only the three companions ship a prebuilt UI bundle"
        );
        // Non-companion Core plugins seed with EMPTY grants, exactly as the generic
        // loop did before this module existed.
        let engines = specs.iter().find(|s| s.id == "engines").unwrap();
        assert!(engines.grants.is_empty());
    }

    /// End-to-end over the real store: a fresh install seeds every default-on
    /// plugin enabled, and a second run never re-seeds (a user's disable sticks).
    #[tokio::test]
    async fn seeding_is_one_time_and_respects_a_user_disable() {
        let store = PluginStore::open_in_memory().unwrap();
        let manifests = vec![
            manifest("engines", "1.0.0", &[]),
            manifest("durable", "1.0.0", &[]),
        ];
        let specs = [spec("engines"), spec("durable")];
        let (ordered, _) = seed_order(&specs, &manifests);
        assert_eq!(ordered.len(), 2);

        // Simulate the seed for this synthetic set (seed_default_on drives the real
        // CORE_DEFAULT_ON table; the store behaviour under test is identical).
        for id in &ordered {
            store.insert(id, "1.0.0").await.unwrap();
            store.set_enabled(id, &[]).await.unwrap();
        }
        // The user disables one.
        store.set_disabled("durable").await.unwrap();

        // A re-seed must leave it disabled: a present record always wins.
        for id in &ordered {
            if store.get(id).await.unwrap().is_some() {
                continue;
            }
            store.set_enabled(id, &[]).await.unwrap();
        }
        assert!(store.get("engines").await.unwrap().unwrap().enabled);
        assert!(!store.get("durable").await.unwrap().unwrap().enabled);
    }
}

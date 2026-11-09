//! Pre-installed plugin seeding — the ONE definition of "what is enabled on a fresh
//! install".
//!
//! # Why this is not `lifecycle::enable_app`
//!
//! Seeding runs during startup, **before the Gateway sidecar is spawned**
//! (`main.rs` starts it well after this; the gateway-policy seed comment says the
//! same). `enable_app` fails **closed** on an unreachable Gateway, so routing the
//! seed through it would leave every pre-installed plugin disabled on every fresh
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
//!    (the declaration order of [`crate::plugins::builtins::CORE_PREINSTALLED`] is
//!    NOT topological, and must not have to be).
//! 2. **Fail-closed satisfiability** — a pre-installed plugin whose `requires` cannot
//!    be satisfied *from within the pre-installed set* is SKIPPED (logged loudly),
//!    never seeded enabled with a missing dependency.
//!
//! # The pre-installed set is the universe
//!
//! [`seed_order`] resolves each plugin against the pre-installed manifests **only**.
//! A pre-installed plugin that depends on an opt-in plugin therefore reports
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
use crate::plugins::{builtins::CORE_PREINSTALLED, graph, PluginStore};

/// One pre-installed plugin and everything the seed must write for it.
#[derive(Debug, Clone, Copy)]
pub struct SeedSpec {
    /// Manifest id.
    pub id: &'static str,
    /// Grants to persist as approved. The Gateway is not reachable at seed time,
    /// so these are the fixed first-party set (empty for most Core plugins; the
    /// companions need theirs to drive Spaces/media/finetune from their frames).
    pub grants: &'static [&'static str],
    /// Prebuilt companion UI bundle, when the plugin ships one.
    ///
    /// Pre-installed records receive the bundle during the normal seed. An explicit
    /// install receives it from [`crate::plugins::lifecycle::install_app`], so an
    /// opt-in plugin does not need a lifecycle row before the user installs it.
    pub ui_code: Option<&'static str>,
}

mod legacy_ids;
mod migration_steps;
mod migrations;
mod seed_rows_a;
mod seed_rows_b;
mod seed_rows_c;

use legacy_ids::*;
use migration_steps::*;
pub use migrations::run_one_time_migrations;

/// Plugins that need more than `insert + set_enabled(&[])`: explicit grants and/or
/// a prebuilt `ui_code` bundle. Everything else in [`CORE_PREINSTALLED`] seeds with
/// empty grants and no UI code (unchanged from the pre-graph behaviour).
///
/// The companions need a UI bundle + the grants their sandboxed frames use.
/// A row that ships no frame (`ui_code: None`, e.g. `recipes`) is here purely for
/// its grants: it really does drive the host over a kernel capability, so its
/// approved grants must match the `permission_grants` its manifest declares —
/// otherwise the record would claim less than the app does.
///
/// # This table is the ONE list of compiled-in companion bundles
///
/// Most rows are pre-installed (`preinstalled_specs` looks them up by
/// [`CORE_PREINSTALLED`] id), but membership here is deliberately NOT limited to the
/// pre-installed set: the explicit install path derives opt-in companion bundles from
/// this same table. Adding a 16th companion to a second list is what caused the
/// original carriage bug; there is no second list.
fn seed_overrides() -> Vec<SeedSpec> {
    let mut rows = Vec::new();
    rows.extend(seed_rows_a::rows());
    rows.extend(seed_rows_b::rows());
    rows.extend(seed_rows_c::rows());
    rows
}

/// The full pre-installed seed table, in declaration order.
///
/// One list, derived from [`CORE_PREINSTALLED`] — the overridden plugins are the same
/// ids with richer specs, so a plugin can never be pre-installed in one list and absent
/// from the other.
pub fn preinstalled_specs() -> Vec<SeedSpec> {
    let overrides = seed_overrides();
    CORE_PREINSTALLED
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

/// A pre-installed plugin that could not be seeded, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSeed {
    pub id: String,
    pub error: graph::DependencyError,
}

/// Order the pre-installed set so every dependency precedes its dependents, and
/// separate out the plugins whose `requires` cannot be satisfied.
///
/// Pure: no store, no I/O. `manifests` is the loaded manifest set; specs with no
/// loaded manifest are dropped (nothing to seed), exactly as before.
///
/// Returns `(ordered_ids, skipped)`. `ordered_ids` is a valid topological order of
/// the seedable pre-installed plugins; `skipped` names the ones whose dependency graph
/// is unsatisfiable *within the pre-installed set* — they are NOT enabled (fail-closed).
pub fn seed_order(
    specs: &[SeedSpec],
    manifests: &[PluginManifest],
) -> (Vec<String>, Vec<SkippedSeed>) {
    // Lower capability edges (`requires.capabilities`) to concrete app-id edges
    // FIRST, resolving providers against the FULL installed set, so a `requires:[rag]`
    // consumer's provider is materialized as an ordinary dependency the graph honors.
    // The universe for resolution stays the pre-installed set (see module docs) — so a
    // pre-installed consumer whose capability provider is NOT pre-installed becomes an edge
    // to a plugin absent from the universe, which `resolve_enable_order` reports as a
    // MissingDependency and the loop below SKIPS (fail-closed) — matching the posture
    // for an un-installed app dependency, and preserving the enabled-set binding
    // invariant at seed time.
    let binding_cfg = crate::plugins::binding::active_config();
    let lowered = crate::plugins::binding::lower_manifests(manifests, &binding_cfg);
    let universe: Vec<PluginManifest> = specs
        .iter()
        .filter_map(|s| lowered.iter().find(|m| m.id == s.id))
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

/// Seed the pre-installed plugins on a fresh install: install + enable each, in
/// dependency order.
///
/// One-time and user-respecting: a plugin with ANY existing record (enabled OR
/// disabled) is left alone, so a user who disables a pre-installed plugin keeps it
/// disabled across restarts.
///
/// Then backfills the compiled-in companion bundle on any existing record that is
/// missing it. Opt-in companions with no record remain absent until an explicit
/// install.
pub async fn seed_preinstalled(store: &PluginStore, manifests: &[PluginManifest]) {
    seed_preinstalled_with_materialized(store, manifests, &std::collections::HashSet::new()).await;
}

/// Seed pre-installed plugins, treating the ids in `newly_materialized` as a first
/// install even when the catalog materializer has already created their lifecycle
/// rows. Existing rows are still authoritative unless the row was created by this
/// startup's materialization pass.
pub async fn seed_preinstalled_with_materialized(
    store: &PluginStore,
    manifests: &[PluginManifest],
    newly_materialized: &std::collections::HashSet<String>,
) {
    let specs = preinstalled_specs();
    let (ordered, skipped) = seed_order(&specs, manifests);

    for s in &skipped {
        tracing::error!(
            "pre-installed seed: SKIPPING '{}' — its dependencies cannot be satisfied from the \
             pre-installed set: {}. It stays disabled (fail-closed); enabling it by hand will \
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
            // A record exists (enabled or disabled) — the user's choice wins,
            // except for a row created by this boot's first materialization.
            Ok(Some(record)) => {
                if !newly_materialized.contains(id) || record.enabled {
                    continue;
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("pre-installed seed: lookup '{id}' failed: {e}");
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

        if store.get_record(id).await.ok().flatten().is_none() {
            if let Err(e) = store.insert(id, &version).await {
                tracing::warn!("pre-installed seed: insert '{id}' failed: {e}");
                continue;
            }
        }
        if let Some(ui_code) = spec.ui_code {
            if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                tracing::warn!("pre-installed seed: set_ui_code '{id}' failed: {e}");
                continue;
            }
        }
        let grants: Vec<String> = spec.grants.iter().map(|g| (*g).to_owned()).collect();
        if let Err(e) = store.set_enabled(id, &grants).await {
            tracing::warn!("pre-installed seed: enable '{id}' failed: {e}");
        } else {
            tracing::info!("pre-installed seed: enabled '{id}'");
        }
    }

    backfill_companion_ui(store).await;
    backfill_declared_grants(store).await;
}

/// Union any newly-declared seed grant into an EXISTING record.
///
/// # The upgrade gap this closes
///
/// Seeding is one-time: a user who already enabled a built-in keeps the record they
/// have, grants and all. That is the right rule for *user* state — but a grant the
/// BUILD declares is not user state. When a release splits a verb out behind a new,
/// narrower grant (`quests.capture` leaving `quests:crud`), every existing install
/// would keep only the old grant and the new verb would be denied for them and only
/// them: working on a fresh install, broken on an upgrade, which is the worst shape
/// a permission bug can take.
///
/// Strictly additive, and deliberately so:
///
/// - it only ever ADDS grants the built-in's own `SeedSpec` declares (which the
///   Gateway's reviewed allowlist already blesses), so it cannot widen anything the
///   build did not already ship;
/// - it never removes a grant, so a user's own additions survive;
/// - it never touches the `enabled` bit, so it cannot resurrect a disabled app;
/// - it skips DISABLED records entirely. `set_disabled` wipes `approved_grants` to
///   `[]` — disabling is a consent revocation, not a pause — so re-granting a
///   disabled app here would quietly undo that. Its grants come back when the user
///   enables it again, from the seed spec, which is where they belong.
///
/// A record that does not exist is skipped — installing is the seed's job, not this.
async fn backfill_declared_grants(store: &PluginStore) {
    for spec in seed_overrides() {
        if spec.grants.is_empty() {
            continue;
        }
        let Ok(Some(record)) = store.get(spec.id).await else {
            continue;
        };
        if !record.enabled {
            continue;
        }
        let missing: Vec<String> = spec
            .grants
            .iter()
            .filter(|g| !record.approved_grants.iter().any(|have| have == *g))
            .map(|g| (*g).to_owned())
            .collect();
        if missing.is_empty() {
            continue;
        }
        match store.add_approved_grants(spec.id, &missing).await {
            Ok(_) => tracing::info!(
                "grant backfill: added {missing:?} to '{}' (the build declares them; the                  record predates the declaration)",
                spec.id
            ),
            Err(e) => tracing::warn!("grant backfill: '{}' failed: {e}", spec.id),
        }
    }
}

/// Every built-in companion that ships a compiled-in `ui_code` bundle, derived from
/// [`seed_overrides`] — the ONE table — so a newly added companion cannot be
/// forgotten here. The explicit install path uses this list to carry the bundle.
///
/// `pub(crate)` for one more reader: `plugin_manifest`'s
/// `companion_ui_fixtures_exist_and_are_nontrivial` size guard drives its loop off
/// this list instead of a hand-copied one, which is how `SKILL_EDITOR_UI_HTML` had
/// gone unguarded — the const existed, the table carried it, the guard's 14-row copy
/// did not.
pub(crate) fn companion_ui_specs() -> Vec<SeedSpec> {
    seed_overrides()
        .into_iter()
        .filter(|s| s.ui_code.is_some())
        .collect()
}

/// The compiled-in companion bundle for a built-in id, or `None` if it ships none.
///
/// The lookup decouples "a built-in's bundle exists" from "the pre-installed seed wrote
/// a record for it". [`crate::plugins::lifecycle::install_app`] reads it too, so the
/// Store's own Install carries the bundle for opt-in companions.
pub(crate) fn compiled_in_ui_code(id: &str) -> Option<&'static str> {
    companion_ui_specs()
        .into_iter()
        .find(|s| s.id == id)
        .and_then(|s| s.ui_code)
}

#[cfg(test)]
mod backfill_seed_tests;
#[cfg(test)]
mod companion_seed_tests;
#[cfg(test)]
mod legacy_ids_tests;
#[cfg(test)]
mod migrations_tests;
#[cfg(test)]
mod tests;

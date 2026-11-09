//! The individual grant and record migration steps run by `run_one_time_migrations`.

use super::*;

/// **v1** — see [`run_one_time_migrations`] for the why.
pub(super) async fn backfill_host_api_grants(store: &PluginStore, manifests: &[PluginManifest]) {
    for manifest in manifests {
        if !crate::plugins::builtins::is_compiled_in_manifest(&manifest.id) {
            continue;
        }
        // The grants a sidecar needs for its host callbacks, which is the set the
        // capability seam now enforces. `permission_grants` is the manifest-level
        // declaration the Gateway validates; the intersection is what a fresh
        // install would have ended up with.
        let needed: Vec<String> = manifest
            .sidecars
            .iter()
            .flat_map(|s| s.host_api.iter())
            .flat_map(|h| h.grants.iter())
            .filter(|g| manifest.permission_grants.iter().any(|p| p == *g))
            .cloned()
            .collect();
        if needed.is_empty() {
            continue;
        }
        match store.get(&manifest.id).await {
            // No record = nothing installed yet; the seed will do the right thing.
            Ok(None) | Err(_) => continue,
            Ok(Some(record)) => {
                let missing: Vec<String> = needed
                    .iter()
                    .filter(|g| !record.approved_grants.iter().any(|a| a == *g))
                    .cloned()
                    .collect();
                if missing.is_empty() {
                    continue;
                }
                match store.add_approved_grants(&manifest.id, &missing).await {
                    Ok(_) => tracing::info!(
                        "store migration v1: backfilled host-api grant(s) {missing:?} for \
                         built-in '{}' (its host callbacks became capability-gated; a \
                         pre-existing record predates the grant)",
                        manifest.id
                    ),
                    Err(e) => tracing::warn!(
                        "store migration: backfilling grants for '{}' failed: {e}",
                        manifest.id
                    ),
                }
            }
        }
    }
}

/// **v2** — restore the Learning app's record (enabled) on installs that already
/// had one, so its consent switches are reachable again.
///
/// # The regression this repairs
///
/// The two learning consent switches moved out of Privacy settings and into an
/// app-registered settings tab (`contributes.settings_tabs` in the `@ryu/learning`
/// manifest, rendered by the desktop's `LearningSettings.tsx`). An app-registered tab
/// only renders while its owning app is ENABLED. Adding the id to [`CORE_PREINSTALLED`]
/// fixes fresh installs only: [`seed_preinstalled`] short-circuits on
/// `Ok(Some(_)) => continue`, and Learning was not pre-installed until now, so essentially
/// every pre-existing install carries a `@ryu/learning` record at `enabled = false`.
/// Those users would see NO consent switches at all.
///
/// # Why enabling the record is safe — the whole justification
///
/// **The app record is not the consent.** The consent is the two preferences, and this
/// migration does not touch either: `learning.enabled` (the training/PRM opt-in) stays
/// OFF, and `learning.skills-enabled` keeps whatever the user set. Enabling the record
/// only makes the settings SURFACE and the `/api/learn/*` routes reachable again — it
/// restores a control the user lost, it does not turn anything on.
///
/// Nothing about what actually RUNS changes, because the capture and the cycle were
/// never gated on the record in the first place: the scheduler keeps running its
/// `JobTarget::LearningCycle` job and the in-process `ExperienceStore` keeps capturing
/// `(user, assistant)` turns whether the app is enabled or not (see the
/// `learning_routes` doc — "Only the HTTP surface is gated"). Nor does any boot path
/// seed global state from this record, the way `main.rs` seeds `dictation::set_enabled
/// (rec.enabled)` and `predict::set_enabled(rec.enabled)`; and the manifest declares no
/// sidecar and no `mcp_servers`, so flipping the bit spawns nothing. That asymmetry —
/// still running, but no longer switchable off — is precisely why the surface must be
/// restored.
///
/// # Scope
///
/// Exactly one id, looked up through [`preinstalled_specs`], which is derived from
/// [`CORE_PREINSTALLED`] ⊂ `CORE_PLUGINS` ⊂ the official package catalog — a tighter scope than
/// the v1 step's `is_compiled_in_manifest` guard, and self-limiting: if Learning ever
/// leaves the pre-installed set again, this step stops asserting anything. No other app
/// is touched, and a record that is already enabled (or absent — an install that never
/// had Learning is a fresh-seed case, not an upgrade case) is left alone.
///
/// # Why this does not re-derive the dependency graph
///
/// The module header promises the store-only write never bypasses the graph, and
/// Learning is the plugin that made that promise concrete — it `requires` the `skills`
/// app. This step still calls `set_enabled` directly, deliberately: a satisfiability
/// guard would turn a ONE-SHOT migration into a permanent no-op for anyone who has
/// `skills` disabled, stranding exactly the users the repair exists for, with no second
/// bump to save them. The exposure is small and recoverable in a way the alternative is
/// not: `skills` is pre-installed (so a disabled dependency is rare), enabling Learning is
/// one bit with no sidecar and no spawn, and a half-enabled pair is re-derived by the
/// ordinary enable/disable path the moment either app is toggled — whereas a silently
/// skipped one-shot migration is not recoverable at all.
///
/// # Why once, not every boot
///
/// The version gate is the entire safety property: a user who disables Learning AFTER
/// this migration must stay disabled across every subsequent restart. A reconcile that
/// re-enabled it on every boot would take the off-switch away permanently, which is the
/// same class of bug as the one being repaired.
pub(super) async fn restore_learning_consent_surface(store: &PluginStore) {
    let id = crate::plugins::builtins::LEARNING_PLUGIN_ID;
    let Some(spec) = preinstalled_specs().into_iter().find(|s| s.id == id) else {
        return;
    };

    let record = match store.get(id).await {
        // Already enabled, or never installed — nothing to repair. (The absent case
        // belongs to `seed_preinstalled`, which conjures no record it did not create.)
        Ok(Some(record)) if record.enabled => return,
        Ok(None) => return,
        Ok(Some(record)) => record,
        Err(e) => {
            tracing::warn!("store migration v2: lookup '{id}' failed: {e}");
            return;
        }
    };

    // A record written during the not pre-installed era has NO `ui_code`: nothing but
    // `seed_overrides` sources a built-in's companion bundle (neither `install_app`
    // nor `enable_app` does — that is why the backfill exists),
    // and the pre-installed seed loop skipped this record. Enabling without it would
    // trade a missing switch for a companion that mounts as "no runnable UI".
    // Only ever FILLS a gap; a record that already has a bundle is left alone.
    //
    // Kept even though `backfill_companion_ui` now fills every companion record on
    // every boot: `main.rs` runs the seed BEFORE the migrations, so in practice this
    // finds the bundle already there and no-ops — but the repair this migration owes
    // its user must not depend on the ORDER of two independent boot steps.
    if let Some(ui_code) = spec.ui_code {
        match store.has_ui_code(id).await {
            Ok(false) => {
                if let Err(e) = store.set_ui_code(id, Some(ui_code)).await {
                    tracing::warn!("store migration v2: set_ui_code '{id}' failed: {e}");
                }
            }
            Ok(true) => {}
            Err(e) => tracing::warn!("store migration v2: ui_code lookup '{id}' failed: {e}"),
        }
    }

    // Union, never replace: the v1 step above adds grants WITHOUT touching `enabled`,
    // so a record can reach here already carrying grants that a bare
    // `set_enabled(id, &spec.grants)` would silently drop.
    let mut grants = record.approved_grants.clone();
    for g in spec.grants {
        if !grants.iter().any(|have| have == *g) {
            grants.push((*g).to_owned());
        }
    }

    match store.set_enabled(id, &grants).await {
        Ok(_) => tracing::info!(
            "store migration v2: re-enabled '{id}' so its consent switches are reachable \
             again (the record is not the consent — `learning.enabled` stays OFF and \
             `learning.skills-enabled` is untouched; capture + the learning cycle were \
             never gated on this record)"
        ),
        Err(e) => tracing::warn!("store migration v2: enabling '{id}' failed: {e}"),
    }
}

/// **v3** — remove legacy disabled seed records from stores that already carry a row
/// created by the old unconditional companion-bundle seed.
///
/// # Why the seed change is not enough on its own
///
/// [`seed_preinstalled`] / [`backfill_companion_ui`] leave every EXISTING record alone —
/// that is the "user's choice wins" rule, and it is right. But it means dropping the
/// the legacy seed only ever fixes machines that have not booted yet: every current install
/// keeps a `@ryu/whiteboard` / `@ryu/canvas` row forever, and the Store keeps
/// listing them as installed. This step is what makes the change reach them.
///
/// # Why removing the record loses nothing
///
/// The record holds no user state: `ui_code` is build content (re-attached by
/// `lifecycle::install_app` from the compiled-in const), `approved_grants` is
/// re-derived by `enable_app` from the manifest, and the app's actual content — the
/// Space documents its board renders — lives in Spaces and is never touched here. So
/// the worst case for a user who WANTED it is one click in the Store, and the app
/// re-installs with an identical record.
///
/// # The one line it will not cross
///
/// **An ENABLED record is never removed.** Enabled is the one bit that can only have
/// come from a deliberate act (nothing ever seeded these two enabled — see
/// `the_real_seed_enables_spaces_and_leaves_its_space_owning_apps_optin`), and
/// removing it would delete a working app out from under someone mid-use. Same shape
/// as v1/v2's refusal to override a later user decision.
///
/// Once per install, like every step here: a user who installs Whiteboard AFTER this
/// migration keeps it, because the version gate has already passed.
pub(super) async fn remove_legacy_disabled_seed_records(store: &PluginStore) {
    for id in LEGACY_DISABLED_SEED_IDS {
        match store.get(id).await {
            // Never installed — the fresh-install case, already correct.
            Ok(None) => continue,
            // The user turned it on. Their choice, and the app is in use.
            Ok(Some(record)) if record.enabled => {
                tracing::info!(
                    "store migration v3: keeping '{id}' — it is ENABLED, so the record is a \
                     deliberate choice, not the legacy seed artifact this step removes"
                );
            }
            Ok(Some(_)) => match store.remove(id).await {
                Ok(_) => tracing::info!(
                    "store migration v3: removed the never-enabled legacy seed record for \
                     '{id}'; `lifecycle::install_app` now attaches any compiled-in bundle \
                     at explicit install time"
                ),
                Err(e) => tracing::warn!("store migration v3: removing '{id}' failed: {e}"),
            },
            Err(e) => tracing::warn!("store migration v3: lookup '{id}' failed: {e}"),
        }
    }
}

/// **v5** — remove the records the old pre-installed seed wrote for the five
/// leaf-feature sidecar apps in [`DEMOTED_FROM_PREINSTALLED_V5`], **enabled or not**.
///
/// # Why v3 cannot do this
///
/// [`remove_legacy_disabled_seed_records`] refuses to remove an ENABLED record, on the grounds
/// that `enabled` can only have come from a deliberate act. For whiteboard/canvas
/// that is exactly right — nothing ever seeded them enabled, so an enabled record is
/// proof of a user decision.
///
/// For these five it is exactly wrong, and for a mechanical reason: they were IN
/// `CORE_PREINSTALLED`, and [`seed_preinstalled`] writes `enabled = true` for every id in
/// that list on any store missing the row. So on every existing install all five are
/// enabled, and not one of those bits records a choice — it records the seed. Reusing
/// v3's rule here would make the step a no-op on 100% of the machines that have the
/// problem, which is the failure mode this whole change exists to end: a fix that
/// only ever reaches installs that do not need it.
///
/// # Why removing them loses nothing
///
/// Same argument as v3, and it is stronger here because these apps are fully
/// out-of-process. The record holds `enabled`, `approved_grants` (re-derived by
/// `enable_app` from the manifest at every enable) and, for Clips, the current
/// `ui_code` companion carriage. The other four sidecar apps do not use `ui_code`;
/// their UI is served by their own sidecar over the ext-proxy.
/// The user's actual data — teams in `teams.db`, dashboards in `dashboards.db`,
/// recorded clips in the Clips Space, recipes in Ghost's RecipeStore — lives in
/// stores this never touches, and is still there when the app is re-installed. So
/// the worst case for someone who wanted one is a single click in the Store, onto an
/// identical record and their existing data.
///
/// # The line it does hold
///
/// The id list is frozen (see [`DEMOTED_FROM_PREINSTALLED_V5`]) and the step is version
/// gated, so it runs exactly once. A user who installs Teams the day after upgrading
/// keeps it forever: the gate has already passed and nothing re-runs. That is the
/// same run-once property `a_later_revocation_is_never_undone_by_a_second_run` pins
/// for v1 — this step gets it from the gate alone, which is why the test below asserts
/// a re-install survives repeated boots.
pub(super) async fn unseed_demoted_preinstalled_apps(store: &PluginStore) {
    for id in DEMOTED_FROM_PREINSTALLED_V5 {
        match store.get(id).await {
            // Already absent — a fresh store, or a user who uninstalled it before
            // `is_uninstall_protected` started refusing (it keyed off `is_preinstalled`).
            Ok(None) => continue,
            Ok(Some(record)) => {
                let was_enabled = record.enabled;
                match store.remove(id).await {
                    Ok(_) => tracing::info!(
                        "store migration v5: removed the '{id}' record (enabled={was_enabled}) — \
                         it was written by the old CORE_PREINSTALLED seed, not by the user, and \
                         the app is now install-on-demand from the Store. Its data (teams.db / \
                         dashboards.db / the Clips Space / Ghost recipes) is untouched and is \
                         still there if it is re-installed."
                    ),
                    Err(e) => tracing::warn!("store migration v5: removing '{id}' failed: {e}"),
                }
            }
            Err(e) => tracing::warn!("store migration v5: lookup '{id}' failed: {e}"),
        }
    }
}

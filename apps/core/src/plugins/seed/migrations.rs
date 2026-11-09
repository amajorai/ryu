//! One-time data migrations for already-installed stores.

use super::*;

/// The store schema version this build expects. Bump when adding a migration below.
///
/// Each step below is gated on its OWN version (`current < N`), not just on this
/// total. Re-running an earlier step at a later bump would re-assert a value the
/// user is entitled to have changed since — e.g. bumping to 2 and letting v1 stores
/// re-run the v1 grant backfill would re-grant `ghost:record` to everyone who
/// revoked it between v1 and v2, which is exactly what
/// `a_later_revocation_is_never_undone_by_a_second_run` forbids (that test cannot
/// see it, because it only ever runs against one const value).
///
/// - v1: backfill host-api grants onto pre-existing records ([`backfill_host_api_grants`]).
/// - v2: re-enable the Learning app's record so its consent switches are reachable
///   again ([`restore_learning_consent_surface`]).
/// - v3: drop legacy disabled seed records, but only where they were never enabled
///   ([`remove_legacy_disabled_seed_records`]).
/// - v4: re-key records + plugin KV from legacy plugin ids to their scoped form
///   ([`rekey_legacy_plugin_ids`]).
/// - v5: drop the records the old pre-installed seed wrote for the five demoted
///   leaf-feature sidecar apps ([`unseed_demoted_preinstalled_apps`]).
/// - v6: move legacy unscoped plugin KV into the active user's tenant namespace
///   ([`migrate_legacy_plugin_storage`]).
pub(super) const STORE_SCHEMA_VERSION: i64 = 6;

/// One-time data migrations for ALREADY-INSTALLED stores.
///
/// # Why this exists (and why it is not part of the seed loop)
///
/// [`seed_preinstalled`] deliberately short-circuits on `Ok(Some(_)) => continue`: a
/// plugin with any existing record is left alone, because the user's choice wins.
/// That is right for enable/disable, but it means a built-in that starts REQUIRING a
/// grant it never needed before is broken on every pre-existing install — the record
/// was written when the grant did not exist, and nothing else rewrites
/// `approved_grants` (`set_enabled` is its only writer; `update_app` explicitly
/// leaves it untouched).
///
/// That is exactly what happened when the per-app `/api/host/<app>/*` reverse
/// callbacks moved onto the generic `/api/host/capability/<cap>` seam: those routes
/// previously required NO grant (the gate was the minted sidecar token plus a
/// hardcoded app-id pin), and the generic seam correctly requires the capability
/// grant the manifest declares. Fresh installs are fine. `recipes` — pre-installed, and
/// the only pre-installed caller — would 403 on `ghost.*` on every existing install
/// until the user manually disabled and re-enabled it.
///
/// # Why a one-time migration rather than a boot reconcile
///
/// A reconcile that ran on EVERY boot would re-grant a capability the user had
/// deliberately revoked, silently overriding them forever. Gating on the store's
/// `PRAGMA user_version` runs the backfill exactly once per install, so it repairs
/// the upgrade and then never fights the user again.
///
/// # Scope (deliberately narrow)
///
/// Only COMPILED-IN built-ins (`is_compiled_in_manifest`) — a disk manifest under
/// `~/.ryu/plugins` must never self-approve, which is the whole point of the Gateway
/// gate. Only grants the built-in's own fixture declares, and only ADDITIVE
/// (`add_approved_grants` can never revoke).
///
/// # Steps
///
/// One fn per schema version, each gated on `current < N` so a store that already ran
/// an earlier step never re-runs it (see [`STORE_SCHEMA_VERSION`]):
///
/// - v1 [`backfill_host_api_grants`] — the host-callback grant repair described above.
/// - v2 [`restore_learning_consent_surface`] — re-enable `@ryu/learning`, whose
///   record now owns the consent switches for a capture path the kernel runs anyway.
/// - v4 [`rekey_legacy_plugin_ids`] — move lifecycle records and plugin KV onto the
///   scoped ids (`@ryu/meetings` → `@ryu/meetings`).
/// - v3 [`remove_legacy_disabled_seed_records`] — remove the never-enabled records
///   that the old unconditional companion-ui seed wrote.
///   The seed change alone only fixes FRESH installs (the loop leaves every existing
///   record alone), so without this step every current machine keeps listing
///   Whiteboard/Canvas as installed forever.
/// - v5 [`unseed_demoted_preinstalled_apps`] — the same repair for the five apps
///   demoted OUT of `CORE_PREINSTALLED`, which v3 cannot do because it refuses to
///   touch an enabled record and these were all seeded enabled.
/// - v6 [`migrate_legacy_plugin_storage`] — preserve existing plugin state while
///   enabling tenant-scoped storage for the active local account.
pub async fn run_one_time_migrations(store: &PluginStore, manifests: &[PluginManifest]) {
    let current = match store.schema_version().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("store migration: reading schema version failed: {e}");
            return;
        }
    };
    if current >= STORE_SCHEMA_VERSION {
        return;
    }

    if current < 1 {
        backfill_host_api_grants(store, manifests).await;
    }
    if current < 2 {
        restore_learning_consent_surface(store).await;
    }
    if current < 3 {
        remove_legacy_disabled_seed_records(store).await;
    }
    if current < 4 {
        rekey_legacy_plugin_ids(store).await;
    }
    if current < 5 {
        unseed_demoted_preinstalled_apps(store).await;
    }
    if current < 6 {
        match migrate_legacy_plugin_storage().await {
            LegacyPluginStorageMigration::Complete => {}
            LegacyPluginStorageMigration::WaitingForAccount => {
                // The earlier migrations have completed. Record that prefix so a
                // later boot retries only the tenant move after an account exists;
                // otherwise every boot would re-assert v1-v5 user state.
                if let Err(error) = store.set_schema_version(STORE_SCHEMA_VERSION - 1).await {
                    tracing::warn!(
                        "store migration v6: could not record pending account state: {error}"
                    );
                }
                return;
            }
            LegacyPluginStorageMigration::Failed => {
                tracing::warn!("store migration v6: leaving schema version unchanged for retry");
                return;
            }
        }
    }

    if let Err(e) = store.set_schema_version(STORE_SCHEMA_VERSION).await {
        // Not fatal, but not free either: a failed version write means every step is
        // attempted again next boot, and re-running a step RE-ASSERTS its value. If
        // the user changed that value in between, the re-run silently overrides them
        // — v1 would re-grant a revoked `ghost:record`, v2 would re-enable a Learning
        // record the user just disabled. That is the same class of bug the version
        // gate exists to prevent, narrowed to the window between a failed PRAGMA
        // write and the next restart. Only a store that cannot be written to at all
        // reaches here, so the narrow exposure is accepted rather than retried.
        tracing::warn!("store migration: recording schema version failed: {e}");
    }
}

/// **v4** — move every install's lifecycle record and plugin KV from a legacy plugin
/// id onto its scoped form (`@ryu/meetings` → `@ryu/meetings`).
///
/// The manifest loader canonicalizes ids at parse, so after the rename Core looks up
/// `@ryu/meetings` — but the records on an existing machine are still filed under
/// `@ryu/meetings`. Without this step every installed app on every existing
/// install silently reverts to *not installed*: disabled, with an empty
/// `approved_grants`, and with its plugin KV (active goals, learning state,
/// per-conversation hook state) unreachable. Nothing errors; it just looks like the
/// user's setup evaporated.
///
/// Driven off [`crate::plugin_manifest::LEGACY_PLUGIN_ID_ALIASES`], the same table
/// `canonical_plugin_id` reads, so the migration and the runtime resolver can never
/// disagree about what maps to what.
///
/// Both halves are re-run-safe (a record or KV row already present under the new id
/// wins), which matters because the version write at the end of
/// [`run_one_time_migrations`] can itself fail and re-run every step next boot.
pub(super) async fn rekey_legacy_plugin_ids(store: &PluginStore) {
    let storage = crate::plugin_storage::global();
    let mut records = 0usize;
    let mut kv_rows = 0usize;

    for (legacy, canonical) in crate::plugin_manifest::LEGACY_PLUGIN_ID_ALIASES {
        match store.rekey(legacy, canonical).await {
            Ok(true) => records += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("store migration v4: rekey '{legacy}' record failed: {e}"),
        }
        // Best-effort and independent of the record move: an install can hold KV for
        // a plugin whose record was already removed, and losing that state silently
        // is the failure this step exists to prevent.
        if let Some(storage) = storage {
            match storage.rekey_plugin(legacy, canonical).await {
                Ok(n) => kv_rows += n,
                Err(e) => tracing::warn!("store migration v4: rekey '{legacy}' kv failed: {e}"),
            }
        }
    }

    if records > 0 || kv_rows > 0 {
        tracing::info!(
            records,
            kv_rows,
            "store migration v4: moved plugin state onto scoped ids"
        );
    }
}

/// **v6** — the host bridge now prefixes plugin KV with the authenticated user
/// id. Existing local installs have unscoped rows, so move them once for the
/// active account instead of making every hook appear to have lost its state.
/// When Core has no active local account (for example a freshly provisioned
/// shared node), leave the legacy rows untouched; the tenant bridge deliberately
/// does not expose them to an unrelated caller.
pub(super) enum LegacyPluginStorageMigration {
    Complete,
    Failed,
    WaitingForAccount,
}

pub(super) async fn migrate_legacy_plugin_storage() -> LegacyPluginStorageMigration {
    let Some(tenant) = crate::auth::load_accounts().active_user_id else {
        return LegacyPluginStorageMigration::WaitingForAccount;
    };
    let Some(storage) = crate::plugin_storage::global() else {
        tracing::warn!("store migration v6: plugin storage is unavailable");
        return LegacyPluginStorageMigration::Failed;
    };
    match storage.migrate_legacy_namespaces(&tenant).await {
        Ok(rows) if rows > 0 => {
            tracing::info!(rows, "store migration v6: tenant-scoped plugin KV")
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!("store migration v6: plugin KV migration failed: {error}");
            return LegacyPluginStorageMigration::Failed;
        }
    }
    LegacyPluginStorageMigration::Complete
}

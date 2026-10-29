//! Background license re-validation for enabled paid Marketplace items.
//!
//! The enable-time check (`require_marketplace_enable_license`) only runs when
//! an item is switched on, so a refund, chargeback, or lapse that happens while
//! the item is running would otherwise go unnoticed until the next enable. This
//! loop re-runs the same decision ([`crate::catalog_source::license`]) for every
//! enabled Marketplace item on a jittered cadence and enforces a revocation
//! through the normal disable path: sidecars stop, hooks and runnables
//! unregister, and the contributions-changed nudge goes out, exactly as if the
//! user had disabled the item. The reason is written to the activity feed and
//! the signed-in member's inbox.
//!
//! Network errors never disable anything on their own: the offline-grace rules
//! of the enable path apply unchanged, and a pass that could not reach the
//! control plane retries sooner so a reconnect is picked up promptly.

use std::time::Duration;

use rand::Rng;

use super::ServerState;
use crate::catalog_source::license::{LicenseRevocation, LicensedItem, RevalidationPass};

/// Delay before the first pass, so startup is not slowed by license probes.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(5 * 60);
/// Regular cadence between passes while the control plane is reachable.
const PASS_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// Cadence after a pass that could not reach the control plane, so the next
/// pass after a reconnect is minutes away rather than hours.
const OFFLINE_RETRY_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// At most this many license probes are in flight at once.
const PROBE_CONCURRENCY: usize = 4;
/// Catalog source id recorded in the provenance of a Marketplace plugin install.
const MARKETPLACE_SOURCE_ID: &str = "ryu-marketplace";
/// Activity-feed kind for a license-driven disable.
pub(crate) const LICENSE_REVOKED_ACTIVITY_KIND: &str = "marketplace_license_revoked";

/// Where an enabled Marketplace item lives, which decides its disable path.
#[derive(Debug, Clone, PartialEq, Eq)]
enum InstalledVia {
    /// A Marketplace plugin/app tracked by the plugin lifecycle store.
    PluginStore,
    /// A portable Marketplace package (skill, agent, workflow, theme, …).
    PortablePackage,
}

/// Spread `base` by up to ±12.5% so many nodes do not probe in lockstep.
fn jittered(base: Duration) -> Duration {
    let spread = base.as_secs() / 8;
    if spread == 0 {
        return base;
    }
    let offset = rand::thread_rng().gen_range(0..=spread * 2);
    Duration::from_secs(base.as_secs() - spread + offset)
}

/// The next sleep after a pass: short when the control plane was unreachable.
fn next_interval(pass: &RevalidationPass) -> Duration {
    if pass.unreachable {
        OFFLINE_RETRY_INTERVAL
    } else {
        PASS_INTERVAL
    }
}

/// Start the background re-validation loop. Called once at startup.
pub fn spawn(state: ServerState) {
    tokio::spawn(async move {
        tokio::time::sleep(jittered(FIRST_PASS_DELAY)).await;
        loop {
            let pass = run_pass(&state).await;
            tokio::time::sleep(jittered(next_interval(&pass))).await;
        }
    });
}

/// Every enabled Marketplace item with the path that disables it.
async fn enabled_marketplace_items(state: &ServerState) -> Vec<(LicensedItem, InstalledVia)> {
    let mut items = Vec::new();
    match state.app_store.list_all_records().await {
        Ok(records) => items.extend(
            records
                .into_iter()
                .filter(|record| record.enabled)
                .filter(|record| {
                    record
                        .provenance
                        .as_ref()
                        .and_then(|provenance| provenance.source_id.as_deref())
                        == Some(MARKETPLACE_SOURCE_ID)
                })
                .map(|record| {
                    (
                        LicensedItem {
                            kind: "plugin".to_owned(),
                            id: record.id,
                        },
                        InstalledVia::PluginStore,
                    )
                }),
        ),
        Err(error) => tracing::warn!("license watch: could not list plugins: {error:#}"),
    }
    match crate::portable_packages::list() {
        Ok(packages) => items.extend(packages.into_iter().filter(|package| package.enabled).map(
            |package| {
                (
                    LicensedItem {
                        kind: package.kind,
                        id: package.id,
                    },
                    InstalledVia::PortablePackage,
                )
            },
        )),
        Err(error) => {
            tracing::warn!("license watch: could not list Marketplace packages: {error:#}");
        }
    }
    items
}

/// One re-validation pass: probe, then enforce every revocation found.
pub(crate) async fn run_pass(state: &ServerState) -> RevalidationPass {
    let items = enabled_marketplace_items(state).await;
    if items.is_empty() {
        return RevalidationPass::default();
    }
    let session_token = state
        .auth
        .lock()
        .await
        .token
        .clone()
        .or_else(crate::auth::active_token);
    let pass = crate::catalog_source::license::revalidate_enabled_items(
        &state.client,
        session_token,
        items.iter().map(|(item, _)| item.clone()).collect(),
        PROBE_CONCURRENCY,
    )
    .await;
    for revocation in &pass.revoked {
        let via = items
            .iter()
            .find(|(item, _)| *item == revocation.item)
            .map(|(_, via)| via.clone());
        if let Some(via) = via {
            enforce_revocation(state, &via, revocation).await;
        }
    }
    pass
}

/// Disable one revoked item through its normal disable path and tell the user
/// why. A disable failure is reported on the activity feed too, so a revoked
/// item that is still running is never silent.
async fn enforce_revocation(
    state: &ServerState,
    via: &InstalledVia,
    revocation: &LicenseRevocation,
) {
    let LicensedItem { kind, id } = &revocation.item;
    let disabled = match via {
        InstalledVia::PluginStore => disable_plugin(state, id).await,
        InstalledVia::PortablePackage => super::portable_package_runtime::disable_with_owner(
            state,
            kind,
            id,
            &super::spaces::background_owner(),
        )
        .await
        .map(|_| ())
        .map_err(|error| format!("{error:#}")),
    };
    match &disabled {
        Ok(()) => tracing::warn!(
            kind = %kind,
            id = %id,
            reason = %revocation.reason,
            "license watch: disabled a Marketplace item whose license was revoked"
        ),
        Err(error) => tracing::error!(
            kind = %kind,
            id = %id,
            reason = %revocation.reason,
            "license watch: license revoked but the item could not be disabled: {error}"
        ),
    }
    record_revocation(state, revocation, disabled.as_ref().err()).await;
}

/// The plugin lifecycle disable used by the HTTP disable route, with cascade so
/// a dependent never keeps running against a revoked dependency.
async fn disable_plugin(state: &ServerState, id: &str) -> Result<(), String> {
    let all_manifests = state.app_manifests.read().await.clone();
    let outcome =
        crate::plugins::lifecycle::disable_app(&state.app_store, id, &all_manifests, true, false)
            .await
            .map_err(|error| error.to_string())?;
    for record in &outcome.disabled {
        if let Some(manifest) = all_manifests
            .iter()
            .find(|manifest| manifest.id == record.id)
        {
            let _ = super::deactivate_plugin(state, manifest).await;
        }
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        serde_json::json!({"type": "contributions_changed"}),
    );
    Ok(())
}

/// Record why the item stopped on the activity feed and in the signed-in
/// member's inbox (which also raises the desktop toast).
async fn record_revocation(
    state: &ServerState,
    revocation: &LicenseRevocation,
    disable_error: Option<&String>,
) {
    let LicensedItem { kind, id } = &revocation.item;
    let title = if disable_error.is_some() {
        format!("Marketplace license revoked for {id}")
    } else {
        format!("{id} was disabled: Marketplace license revoked")
    };
    let body = match disable_error {
        Some(error) => format!(
            "{} It could not be disabled automatically ({error}); disable it from Settings.",
            revocation.reason
        ),
        None => revocation.reason.clone(),
    };
    let item = ryu_activity::ActivityItem::new(
        LICENSE_REVOKED_ACTIVITY_KIND,
        "marketplace",
        title.clone(),
    )
    .with_body(Some(body.clone()))
    .with_level(ryu_activity::ActivityLevel::Warning)
    .with_metadata(serde_json::json!({
        "kind": kind,
        "id": id,
        "reason": revocation.reason,
        "disabled": disable_error.is_none(),
    }));
    if let Err(error) = state.activity.record(item).await {
        tracing::warn!("license watch: failed to record activity: {error:#}");
    }
    let Some(store) = crate::notify::global_store() else {
        return;
    };
    let Some(user_id) = crate::auth::load_accounts().active_user_id else {
        return;
    };
    if let Err(error) = crate::notify::deliver_user_notification(
        &store, &user_id, &title, &body, "warning", None, None, false, None,
    )
    .await
    {
        tracing::warn!("license watch: failed to notify: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadence_is_jittered_and_backs_off_to_a_short_retry_when_offline() {
        for _ in 0..64 {
            let next = jittered(PASS_INTERVAL);
            assert!(next >= PASS_INTERVAL - PASS_INTERVAL / 8);
            assert!(next <= PASS_INTERVAL + PASS_INTERVAL / 8);
        }
        let offline = RevalidationPass {
            unreachable: true,
            ..RevalidationPass::default()
        };
        assert_eq!(next_interval(&offline), OFFLINE_RETRY_INTERVAL);
        assert_eq!(next_interval(&RevalidationPass::default()), PASS_INTERVAL);
    }

    #[tokio::test]
    async fn a_revoked_marketplace_plugin_is_disabled_with_its_reason_recorded() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        let provenance = crate::plugins::isolation::PluginProvenance {
            source_id: Some(MARKETPLACE_SOURCE_ID.to_owned()),
            ..Default::default()
        };
        state
            .app_store
            .insert_with_provenance("acme.paid", "1.0.0", Some(&provenance))
            .await
            .unwrap();
        state.app_store.set_enabled("acme.paid", &[]).await.unwrap();
        state
            .app_store
            .insert("acme.sideloaded", "1.0.0")
            .await
            .unwrap();
        state
            .app_store
            .set_enabled("acme.sideloaded", &[])
            .await
            .unwrap();

        // Only the Marketplace install is subject to license re-validation.
        let watched: Vec<LicensedItem> = enabled_marketplace_items(&state)
            .await
            .into_iter()
            .filter(|(_, via)| *via == InstalledVia::PluginStore)
            .map(|(item, _)| item)
            .collect();
        assert_eq!(
            watched,
            vec![LicensedItem {
                kind: "plugin".to_owned(),
                id: "acme.paid".to_owned(),
            }]
        );

        let revocation = LicenseRevocation {
            item: watched[0].clone(),
            reason: "`plugin/acme.paid`: this Marketplace purchase was refunded".to_owned(),
        };
        enforce_revocation(&state, &InstalledVia::PluginStore, &revocation).await;

        let record = state.app_store.get_record("acme.paid").await.unwrap();
        assert!(
            !record.expect("record kept").enabled,
            "revoked item is disabled"
        );
        let untouched = state.app_store.get_record("acme.sideloaded").await.unwrap();
        assert!(untouched.expect("record kept").enabled);
        let feed = state.activity.list(10, None).await.unwrap();
        let entry = feed
            .iter()
            .find(|item| item.kind == LICENSE_REVOKED_ACTIVITY_KIND)
            .expect("revocation recorded on the activity feed");
        assert_eq!(entry.metadata["id"], "acme.paid");
        assert_eq!(entry.metadata["disabled"], true);
        assert!(entry
            .body
            .as_deref()
            .is_some_and(|body| body.contains("refunded")));
    }
}

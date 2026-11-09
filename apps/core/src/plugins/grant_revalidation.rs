//! Re-check persisted Community-tier grant approvals against the CURRENT Gateway
//! grant policy, and revoke whatever it now denies.
//!
//! `enable_app` asks the Gateway once and persists the approved set in
//! `approved_grants`; every runtime gate (hooks, kernel-event subscriptions such
//! as `runs:failures`, `effective_tool_grants` for `tool:command:<bin>` /
//! `tool:http-egress:*`, the host-API capability seam) then trusts that stored
//! set. When the Gateway tightens its policy (a grant moved off the marketplace
//! allowlist onto an owner-exclusive row, e.g. `workflows:crud` or
//! `runs:failures`), an app enabled before the upgrade would keep the old
//! approval forever. This pass closes that: on boot, and periodically after, it
//! re-submits each enabled Community-tier record's approved grants for its exact
//! app id and removes the denied ones from the record.
//!
//! The write only ever NARROWS (see [`PluginStore::revoke_approved_grants`]): a
//! grant the Gateway still approves is never touched, and a Gateway that cannot
//! be reached changes nothing (the pass stops and retries). Compiled-in,
//! byte-exact first-party manifests are skipped: their grants come from the
//! reviewed pre-install seed, which the Gateway's drift tripwire already pins.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use super::lifecycle::{validate_grants_via_gateway, EnableError};
use super::{GrantValidationResult, PluginStore};
use crate::plugin_manifest::{PluginManifest, PluginTier};

/// Delay before the first pass, so a locally spawned Gateway has time to bind.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(10);
/// Retry ceiling while the Gateway is unreachable.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(600);
/// Cadence after a complete pass, so a Gateway-only policy upgrade also lands.
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// What one pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RevalidationPass {
    /// Enabled Community-tier records whose grants were re-submitted.
    pub checked: usize,
    /// `(app id, grants removed)` for every record the pass narrowed.
    pub revoked: Vec<(String, Vec<String>)>,
    /// False when the Gateway (or the store) failed part-way; nothing after the
    /// failure was examined and the caller should retry.
    pub complete: bool,
}

impl PluginStore {
    /// Remove `revoke` from `id`'s persisted `approved_grants`, in one locked
    /// read-modify-write, and return the grants actually removed. Never adds a
    /// grant, so a concurrent enable or grant edit can only lose what the Gateway
    /// has just denied.
    pub async fn revoke_approved_grants(&self, id: &str, revoke: &[String]) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let Some(grants_json) = conn
            .query_row(
                "SELECT approved_grants FROM apps WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            return Ok(Vec::new());
        };
        let current: Vec<String> = serde_json::from_str(&grants_json).unwrap_or_default();
        let (removed, kept): (Vec<String>, Vec<String>) = current
            .into_iter()
            .partition(|grant| revoke.contains(grant));
        if removed.is_empty() {
            return Ok(removed);
        }
        conn.execute(
            "UPDATE apps SET approved_grants = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                id,
                serde_json::to_string(&kept)?,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(removed)
    }
}

/// Whether `id`'s stored approval must be re-checked: every record except a
/// byte-exact compiled-in or Core-tier manifest. A record whose manifest is not
/// loaded is re-checked too (nothing vouches for it).
fn needs_revalidation(id: &str, manifests: &[PluginManifest]) -> bool {
    manifests
        .iter()
        .find(|manifest| manifest.id == id)
        .is_none_or(|manifest| {
            crate::plugins::builtins::tier_for_manifest(manifest) == PluginTier::Community
                && !crate::plugins::builtins::is_exact_compiled_manifest(manifest)
        })
}

/// One pass over the enabled records, with the Gateway decision injected so the
/// narrowing contract is testable without a network.
pub async fn revalidate_with<V, Fut>(
    store: &PluginStore,
    manifests: &[PluginManifest],
    validate: V,
) -> RevalidationPass
where
    V: Fn(String, Vec<String>) -> Fut,
    Fut: Future<Output = Result<GrantValidationResult, EnableError>>,
{
    let mut pass = RevalidationPass::default();
    let records = match store.list_all_records().await {
        Ok(records) => records,
        Err(error) => {
            tracing::warn!(%error, "grant revalidation: could not list app records");
            return pass;
        }
    };
    for record in records {
        if !record.enabled
            || record.approved_grants.is_empty()
            || !needs_revalidation(&record.id, manifests)
        {
            continue;
        }
        pass.checked += 1;
        let decision = match validate(record.id.clone(), record.approved_grants.clone()).await {
            Ok(decision) => decision,
            Err(error) => {
                tracing::warn!(
                    app_id = %record.id,
                    %error,
                    "grant revalidation: Gateway unavailable; stored approvals left unchanged"
                );
                return pass;
            }
        };
        if decision.denied.is_empty() {
            continue;
        }
        match store
            .revoke_approved_grants(&record.id, &decision.denied)
            .await
        {
            Ok(removed) if removed.is_empty() => {}
            Ok(removed) => {
                tracing::warn!(
                    app_id = %record.id,
                    revoked = ?removed,
                    "grant revalidation: revoked grants the current Gateway policy denies"
                );
                pass.revoked.push((record.id, removed));
            }
            Err(error) => {
                tracing::warn!(app_id = %record.id, %error, "grant revalidation: revoke failed");
                return pass;
            }
        }
    }
    pass.complete = true;
    pass
}

/// One pass against the configured Gateway.
pub async fn revalidate_enabled_grants(
    store: &PluginStore,
    manifests: &[PluginManifest],
    client: &reqwest::Client,
) -> RevalidationPass {
    let gateway_url = crate::sidecar::gateway::gateway_url();
    let gateway_token = crate::sidecar::gateway::gateway_token();
    revalidate_with(store, manifests, |id, grants| {
        let gateway_url = gateway_url.clone();
        let gateway_token = gateway_token.clone();
        async move {
            validate_grants_via_gateway(
                &grants,
                &id,
                &gateway_url,
                gateway_token.as_deref(),
                client,
            )
            .await
        }
    })
    .await
}

/// The delay before the next pass: back off while incomplete, then settle on
/// [`RECHECK_INTERVAL`].
fn next_delay(pass: &RevalidationPass, failures: u32) -> Duration {
    if pass.complete {
        return RECHECK_INTERVAL;
    }
    FIRST_PASS_DELAY
        .saturating_mul(2u32.saturating_pow(failures.min(8)))
        .min(MAX_RETRY_DELAY)
}

/// Run the pass shortly after boot and keep re-running it. Never blocks boot.
pub fn spawn(store: PluginStore, manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut failures = 0u32;
        tokio::time::sleep(FIRST_PASS_DELAY).await;
        loop {
            let snapshot = manifests.read().await.clone();
            let pass = revalidate_enabled_grants(&store, &snapshot, &client).await;
            failures = if pass.complete { 0 } else { failures + 1 };
            tokio::time::sleep(next_delay(&pass, failures)).await;
        }
    });
}

#[cfg(test)]
#[path = "grant_revalidation_tests.rs"]
mod tests;

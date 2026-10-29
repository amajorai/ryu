//! Background maintenance for the vault.
//!
//! One loop, every [`TICK`]:
//!
//! * rotate generated values whose rotation period has elapsed, and static
//!   roles whose upstream credential is due;
//! * revoke expired dynamic-secret leases;
//! * drop expired temporary policy bindings;
//! * prune expired machine tokens and secret ids, expired wrapping tokens,
//!   and the cubbyholes of dead tokens;
//! * soft-delete value versions older than their `deleteVersionAfterSecs`;
//! * rotate transit keys past `autoRotatePeriodSecs` and purge soft-deleted
//!   transit keys past the recovery window;
//! * rotate the identity-token signing key past its rotation period and
//!   prune retired keys past the verification window;
//! * once a day, tidy PKI certificates expired for more than 72 hours;
//! * once a day, prune audit rows older than `RYU_VAULT_AUDIT_RETENTION_DAYS`
//!   (default 365; `0` keeps everything). Pruning records an anchor so
//!   verification of the remaining chain still succeeds.
//!
//! Each step logs and continues on failure; a sealed vault skips the steps
//! that need key material.

use std::time::Duration;

use super::audit::AuditActor;
use super::now_millis;
use crate::plugin_secrets::PluginSecretStore;

const TICK: Duration = Duration::from_secs(60);
const ENV_AUDIT_RETENTION_DAYS: &str = "RYU_VAULT_AUDIT_RETENTION_DAYS";
const DEFAULT_AUDIT_RETENTION_DAYS: i64 = 365;
const DAY_MILLIS: i64 = 24 * 3600 * 1000;

fn audit_retention_days() -> i64 {
    std::env::var(ENV_AUDIT_RETENTION_DAYS)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_AUDIT_RETENTION_DAYS)
}

/// Summary of one maintenance pass.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub rotated: usize,
    pub leases_revoked: usize,
    pub bindings_pruned: usize,
    pub tokens_pruned: usize,
    pub audit_pruned: usize,
    pub versions_deleted: usize,
    pub transit_rotated: usize,
    pub transit_purged: usize,
    pub identity_keys_rotated: usize,
    pub identity_keys_pruned: usize,
    pub pki_certs_tidied: usize,
}

/// Run one maintenance pass. `prune_audit` gates the daily audit step.
pub async fn tick(store: &PluginSecretStore, prune_audit: bool) -> TickReport {
    let mut report = TickReport::default();
    if !store.keyring.is_sealed() {
        match store.due_generated_rotations().await {
            Ok(due) => {
                for coords in due {
                    match store.rotate_generated(coords, &AuditActor::system()).await {
                        Ok(_) => report.rotated += 1,
                        Err(error) => tracing::warn!("vault rotation failed: {error:#}"),
                    }
                }
            }
            Err(error) => tracing::warn!("listing due rotations failed: {error:#}"),
        }
        match store.dynamic_reap().await {
            Ok(count) => report.leases_revoked = count,
            Err(error) => tracing::warn!("lease reaper failed: {error:#}"),
        }
        // Static roles: rotate existing upstream credentials that are due.
        match store.static_rotate_due().await {
            Ok(count) => report.rotated += count,
            Err(error) => tracing::warn!("static role rotation failed: {error:#}"),
        }
        match store.transit_due_rotations().await {
            Ok(due) => {
                for name in due {
                    match store.transit_rotate(&name, &AuditActor::system()).await {
                        Ok(_) => report.transit_rotated += 1,
                        Err(error) => tracing::warn!("transit auto-rotation failed: {error:#}"),
                    }
                }
            }
            Err(error) => tracing::warn!("listing due transit rotations failed: {error:#}"),
        }
        match store.identity_maintain().await {
            Ok((rotated, pruned)) => {
                report.identity_keys_rotated = usize::from(rotated);
                report.identity_keys_pruned = pruned;
            }
            Err(error) => tracing::warn!("identity key maintenance failed: {error:#}"),
        }
    }
    match store.transit_purge_expired().await {
        Ok(count) => report.transit_purged = count,
        Err(error) => tracing::warn!("purging deleted transit keys failed: {error:#}"),
    }
    if prune_audit {
        match store
            .pki_tidy(super::pki::DEFAULT_TIDY_BUFFER_SECS, &AuditActor::system())
            .await
        {
            Ok(count) => report.pki_certs_tidied = count,
            Err(error) => tracing::warn!("PKI tidy failed: {error:#}"),
        }
    }
    {
        let conn = store.conn.lock().await;
        match super::policy::prune_expired(&conn) {
            Ok(count) => report.bindings_pruned = count,
            Err(error) => tracing::warn!("pruning policy bindings failed: {error:#}"),
        }
        if prune_audit {
            let days = audit_retention_days();
            if days > 0 {
                match super::audit::prune(&conn, now_millis() - days * DAY_MILLIS) {
                    Ok(count) => report.audit_pruned = count,
                    Err(error) => tracing::warn!("pruning vault audit failed: {error:#}"),
                }
            }
        }
    }
    match store.machine_prune().await {
        Ok(count) => report.tokens_pruned = count,
        Err(error) => tracing::warn!("pruning vault tokens failed: {error:#}"),
    }
    match store.token_lifecycle_prune().await {
        Ok(count) => report.tokens_pruned += count,
        Err(error) => tracing::warn!("pruning wrapping tokens failed: {error:#}"),
    }
    match store.enforce_delete_version_after().await {
        Ok(count) => report.versions_deleted = count,
        Err(error) => tracing::warn!("deleting aged vault versions failed: {error:#}"),
    }
    report
}

/// Start the maintenance loop for the process-global store.
pub fn spawn(store: &'static PluginSecretStore) {
    tokio::spawn(async move {
        let mut last_audit_prune = 0i64;
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let now = now_millis();
            let prune_audit = now - last_audit_prune >= DAY_MILLIS;
            if prune_audit {
                last_audit_prune = now;
            }
            let report = tick(store, prune_audit).await;
            if report != TickReport::default() {
                tracing::info!(?report, "vault maintenance");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_idle_store_has_nothing_to_do() {
        let store = PluginSecretStore::in_memory().unwrap();
        assert_eq!(tick(&store, true).await, TickReport::default());
    }
}

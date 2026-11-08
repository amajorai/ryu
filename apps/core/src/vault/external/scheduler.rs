//! The external-store loop.
//!
//! test-exempt: split out of `external/mod.rs` unchanged in shape; exercised
//! end to end by `external/tests.rs` and `external/targets/tests.rs`.

use super::*;

impl PluginSecretStore {
    /// One loop pass: run due sync sources and dirty or due destinations.
    pub async fn external_tick(&self) -> TickReport {
        let mut report = TickReport::default();
        if self.keyring.is_sealed() {
            return report;
        }
        let now = now_millis();
        let (sources, destinations) = {
            let conn = self.conn.lock().await;
            let sources = collect(
                &conn,
                &format!("SELECT {SOURCE_COLUMNS} FROM vault_external_sources WHERE mode = 'sync'"),
                source_from_row,
            );
            let destinations = collect(
                &conn,
                &format!("SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations"),
                destination_from_row,
            );
            (
                sources.unwrap_or_default(),
                destinations.unwrap_or_default(),
            )
        };
        let actor = AuditActor::new("system", Some("external-store"));
        for source in sources.iter().filter(|source| {
            source
                .last_sync_at
                .is_none_or(|at| now - at >= source.sync_interval_secs * 1000)
        }) {
            match self.external_sync_source(&source.id, &actor).await {
                Ok(_) => report.synced += 1,
                Err(_) => report.failed += 1,
            }
        }
        for destination in destinations
            .iter()
            .filter(|destination| destination_due(destination, now))
        {
            match self.external_push(&destination.id, &actor).await {
                Ok(_) => report.pushed += 1,
                Err(_) => report.failed += 1,
            }
        }
        report
    }
}

/// Start the external-store loop for the process-global store. It wakes every
/// [`LOOP_TICK`] and immediately after a write into a pushed folder.
pub fn spawn(store: &'static PluginSecretStore) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(LOOP_TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                () = WAKE.notified() => {}
            }
            let report = store.external_tick().await;
            if report != TickReport::default() {
                tracing::info!(?report, "vault external stores");
            }
        }
    });
}

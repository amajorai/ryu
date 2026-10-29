//! Core's implementation of the extracted [`ryu_webhook_ingress::WebhookIngressHost`]
//! seam.
//!
//! The `ryu-webhook-ingress` crate owns the ingress engine — the four backends
//! (RyuRelay/Funnel/cloudflared/own-relay), the path-routed inbound dispatcher,
//! the fail-closed HMAC re-verification ladder, delivery dedup, and the
//! replay window. What it cannot own — because they are kernel subsystems that
//! stay in Core — are the leaf couplings: composio signature crypto over the
//! configured secret, the composio triggers store fan-out, starting a workflow
//! run, the raw workflow-webhook-secret lookup, the auth token, the `~/.ryu`
//! data dir, and the mesh Funnel. This shim implements exactly those; Core
//! installs it once at boot via [`ryu_webhook_ingress::set_global_host`].
//!
//! Precedent: `apps/core/src/recipes_host.rs` (`CoreRecipesHost`) and the
//! Quests/Clips host shims.

use std::path::PathBuf;

use anyhow::Result;
use async_trait::async_trait;
use rusqlite::params;
use serde_json::Value;

use ryu_webhook_ingress::{WebhookIngressHost, WorkflowWebhookSecret};

/// Core's `WebhookIngressHost` — the kernel side of the webhook-ingress seam.
pub struct CoreWebhookIngressHost;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn workflow_delivery_db() -> Result<rusqlite::Connection> {
    let path = crate::paths::db_path("workflow-webhook-deliveries.db");
    workflow_delivery_db_at(&path)
}

fn workflow_delivery_db_at(path: &std::path::Path) -> Result<rusqlite::Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = rusqlite::Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_deliveries (
            workflow_id TEXT NOT NULL,
            delivery_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (workflow_id, delivery_id)
        );",
    )?;
    Ok(conn)
}

fn reserve_delivery_at(
    path: &std::path::Path,
    workflow_id: &str,
    delivery_id: &str,
    expires_at: u64,
    now: u64,
) -> Result<bool> {
    let mut conn = workflow_delivery_db_at(path)?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM workflow_deliveries WHERE expires_at < ?1",
        params![now as i64],
    )?;
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO workflow_deliveries (workflow_id, delivery_id, expires_at)
         VALUES (?1, ?2, ?3)",
        params![workflow_id, delivery_id, expires_at as i64],
    )?;
    tx.commit()?;
    Ok(inserted == 1)
}

#[async_trait]
impl WebhookIngressHost for CoreWebhookIngressHost {
    fn composio_is_configured(&self) -> bool {
        crate::composio_auth::is_configured()
    }

    fn backend_url(&self) -> Option<String> {
        // The server the account signed in to, else the control plane this node
        // is enrolled with. Never a guessed local default.
        crate::auth::load_backend_url().or_else(crate::fleet::enrolled_control_plane_url)
    }

    fn has_webhook_trigger(&self) -> bool {
        crate::workflow::store::list_workflows().iter().any(|wf| {
            wf.triggers
                .iter()
                .any(|t| matches!(t, crate::workflow::WorkflowTrigger::Webhook { .. }))
        })
    }

    fn verify_webhook_signature(
        &self,
        raw_body: &[u8],
        headers: ryu_webhook_ingress::InboundWebhookHeaders<'_>,
    ) -> bool {
        crate::composio_triggers::verify_webhook_signature(
            raw_body,
            headers.webhook_id,
            headers.webhook_timestamp,
            headers.signature,
        )
    }

    fn verify_workflow_webhook_signature(
        &self,
        workflow_id: &str,
        secret: &str,
        raw_body: &[u8],
        headers: ryu_webhook_ingress::InboundWebhookHeaders<'_>,
    ) -> bool {
        crate::composio_triggers::verify_workflow_webhook_signature_v3(
            secret,
            workflow_id,
            raw_body,
            headers.signature,
            headers.webhook_timestamp,
            headers.webhook_id,
            now_secs(),
        )
    }

    fn reserve_workflow_delivery(
        &self,
        workflow_id: &str,
        delivery_id: &str,
        expires_at: u64,
    ) -> Result<bool> {
        let path = crate::paths::db_path("workflow-webhook-deliveries.db");
        reserve_delivery_at(&path, workflow_id, delivery_id, expires_at, now_secs())
    }

    fn release_workflow_delivery(&self, workflow_id: &str, delivery_id: &str) -> Result<()> {
        workflow_delivery_db()?.execute(
            "DELETE FROM workflow_deliveries WHERE workflow_id = ?1 AND delivery_id = ?2",
            params![workflow_id, delivery_id],
        )?;
        Ok(())
    }

    async fn composio_handle_webhook(&self, payload: &Value) -> Option<usize> {
        match crate::composio_triggers::global() {
            Some(store) => Some(store.handle_webhook(payload).await),
            None => None,
        }
    }

    async fn record_composio_trigger_delivery(&self, delivery_id: &str) -> Result<()> {
        crate::sidecar::gateway::record_composio_trigger_delivery(
            &reqwest::Client::new(),
            delivery_id,
        )
        .await
    }

    async fn relay_public_url_changed(&self, _public_url: &str) {
        crate::webhook_ingress::repoint_composio_subscription_after_relay_change().await;
    }

    async fn run_workflow_for_trigger(
        &self,
        workflow_id: &str,
        payload_json: &str,
    ) -> Result<String> {
        // Webhook deliveries keep their durable reservation once a run exists, so
        // return as soon as the run is seeded; its outcome lands on the run.
        crate::composio_host::start_workflow_for_trigger(workflow_id, payload_json)
    }

    fn workflow_webhook_secret(&self, workflow_id: &str) -> WorkflowWebhookSecret {
        let Ok(workflow) = crate::workflow::store::load_workflow(workflow_id) else {
            return WorkflowWebhookSecret::NotFound;
        };
        // Find the workflow's webhook trigger + its (optional) per-trigger secret.
        // The empty-secret → NoSecret decision stays in the crate; here we return
        // the raw field verbatim.
        let found = workflow.triggers.iter().find_map(|t| match t {
            crate::workflow::WorkflowTrigger::Webhook { secret } => Some(secret.clone()),
            _ => None,
        });
        match found {
            Some(secret) => WorkflowWebhookSecret::Secret(secret),
            None => WorkflowWebhookSecret::NoTrigger,
        }
    }

    fn auth_token(&self) -> Option<String> {
        crate::auth::load_token()
    }

    fn data_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }

    async fn ensure_funnel(&self, port: u16) -> Result<String> {
        ryu_mesh::ensure_funnel(port).await
    }

    async fn funnel_url(&self, port: u16) -> Option<String> {
        ryu_mesh::funnel_url(port).await
    }
}

#[cfg(test)]
mod tests {
    use super::reserve_delivery_at;
    use ryu_webhook_ingress::{COMPOSIO_DELIVERY_RETENTION_SECS, WEBHOOK_PATH};

    /// Composio claims share the workflow ledger under the webhook path, outlive
    /// the 300 s signature window (Svix re-signs each retry over about 28 h), and
    /// survive a restart (each call opens a fresh connection).
    #[test]
    fn composio_delivery_reservation_survives_restart_past_the_signature_window() {
        assert!(COMPOSIO_DELIVERY_RETENTION_SECS >= 28 * 60 * 60);
        let dir =
            std::env::temp_dir().join(format!("ryu-composio-replay-{}", uuid::Uuid::new_v4()));
        let path = dir.join("deliveries.db");
        let now = 1_000;
        let expires_at = now + COMPOSIO_DELIVERY_RETENTION_SECS;
        assert!(reserve_delivery_at(&path, WEBHOOK_PATH, "msg_1", expires_at, now).unwrap());
        // A re-signed retry five hours later, after a restart, is still a duplicate.
        assert!(
            !reserve_delivery_at(&path, WEBHOOK_PATH, "msg_1", expires_at, now + 5 * 3600).unwrap()
        );
        // The same id under a workflow scope is independent.
        assert!(reserve_delivery_at(&path, "workflow-a", "msg_1", now + 300, now).unwrap());
        // Bounded: past retention the claim is purged.
        assert!(reserve_delivery_at(
            &path,
            WEBHOOK_PATH,
            "msg_1",
            expires_at + COMPOSIO_DELIVERY_RETENTION_SECS,
            expires_at + 1
        )
        .unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn signed_workflow_delivery_survives_process_restart() {
        let dir =
            std::env::temp_dir().join(format!("ryu-workflow-replay-{}", uuid::Uuid::new_v4()));
        let path = dir.join("deliveries.db");
        assert!(reserve_delivery_at(&path, "workflow-a", "signed-id", 400, 100).unwrap());
        assert!(!reserve_delivery_at(&path, "workflow-a", "signed-id", 400, 101).unwrap());
        assert!(reserve_delivery_at(&path, "workflow-b", "signed-id", 400, 101).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }
}

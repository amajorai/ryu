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
use serde_json::Value;

use ryu_webhook_ingress::{WebhookIngressHost, WorkflowWebhookSecret};

/// Core's `WebhookIngressHost` — the kernel side of the webhook-ingress seam.
pub struct CoreWebhookIngressHost;

#[async_trait]
impl WebhookIngressHost for CoreWebhookIngressHost {
    fn composio_is_configured(&self) -> bool {
        crate::composio_auth::is_configured()
    }

    fn verify_webhook_signature(&self, raw_body: &[u8], signature: Option<&str>) -> bool {
        crate::composio_triggers::verify_webhook_signature(raw_body, signature)
    }

    fn verify_workflow_webhook_signature(
        &self,
        secret: &str,
        raw_body: &[u8],
        signature: Option<&str>,
    ) -> bool {
        crate::composio_triggers::verify_workflow_webhook_signature(secret, raw_body, signature)
    }

    async fn composio_handle_webhook(&self, payload: &Value) -> Option<usize> {
        match crate::composio_triggers::global() {
            Some(store) => Some(store.handle_webhook(payload).await),
            None => None,
        }
    }

    async fn run_workflow_for_trigger(
        &self,
        workflow_id: &str,
        payload_json: &str,
    ) -> Result<String> {
        crate::composio_host::run_workflow_for_trigger(workflow_id, payload_json).await
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

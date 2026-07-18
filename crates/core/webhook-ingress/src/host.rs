//! The `WebhookIngressHost` seam — the narrow inversion of every kernel coupling
//! this crate needs, so the crate has ZERO dependency on `apps/core`.
//!
//! Precedent: `RecipesHost`/`QuestsHost`/`ClipsHost` (`apps/core/src/*_host.rs`).
//! Core installs its implementation once at boot via [`set_global_host`];
//! `apps/core/src/webhook_ingress_host.rs` is the kernel side.
//!
//! **Acceptance line (why the trait is only leaf lookups + crypto):** all the
//! *decisions* stay in this crate — kind resolution, URL composition, SSE parse,
//! delivery dedup, the replay window, path routing, and the fail-closed
//! `WorkflowWebhookOutcome` ladder. The host only performs leaf operations that
//! genuinely live in the kernel: composio signature crypto over the configured
//! secret, the composio store fan-out, starting a workflow run, the raw
//! workflow-webhook-secret lookup, the auth token, the data dir, and the mesh
//! funnel. If a routing/fail-closed decision ever moved into a host method this
//! would be a facade, not an extraction.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};
use serde_json::Value;

/// The raw result of looking up a workflow's webhook trigger secret. The crate
/// (not the host) owns the empty-secret → `NoSecret` decision, so this returns
/// the trigger's `secret` field verbatim (`Secret(None)` when the trigger exists
/// but carries no secret at all).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowWebhookSecret {
    /// No workflow with this id exists.
    NotFound,
    /// The workflow exists but declares no `Webhook` trigger.
    NoTrigger,
    /// The workflow has a webhook trigger; carries its (optional) secret field.
    Secret(Option<String>),
}

/// Every kernel coupling the webhook-ingress engine needs, inverted. `dyn`-stored
/// (→ `async_trait`), installed once at boot. Implemented by Core; the crate's own
/// tests install a mock.
#[async_trait::async_trait]
pub trait WebhookIngressHost: Send + Sync {
    // ── Composio (the trust-relay + global-secret path) ──────────────────────
    /// Whether a Composio key is configured (the RyuRelay opt-in-by-use gate).
    fn composio_is_configured(&self) -> bool;
    /// Verify an inbound Composio webhook against the global Composio secret.
    fn verify_webhook_signature(&self, raw_body: &[u8], signature: Option<&str>) -> bool;
    /// Verify a per-workflow webhook against a trigger-specific secret.
    fn verify_workflow_webhook_signature(
        &self,
        secret: &str,
        raw_body: &[u8],
        signature: Option<&str>,
    ) -> bool;
    /// Fan a verified Composio payload out to the triggers store, returning the
    /// number of agent runs fired. `None` when the store is not initialised.
    async fn composio_handle_webhook(&self, payload: &Value) -> Option<usize>;
    /// Start a workflow run seeded with the trigger payload; returns the run id.
    async fn run_workflow_for_trigger(&self, workflow_id: &str, payload_json: &str)
        -> Result<String>;
    /// Raw lookup of a workflow's webhook-trigger secret (no decisions applied).
    fn workflow_webhook_secret(&self, workflow_id: &str) -> WorkflowWebhookSecret;

    // ── Auth + local infra ───────────────────────────────────────────────────
    /// This node's auth bearer token (`~/.ryu/auth.json`), if logged in.
    fn auth_token(&self) -> Option<String>;
    /// The `~/.ryu` data dir (where the relay token is persisted).
    fn data_dir(&self) -> PathBuf;

    // ── Mesh (Tailscale Funnel) ──────────────────────────────────────────────
    /// Ensure a Funnel is serving `port`, returning its public base URL.
    async fn ensure_funnel(&self, port: u16) -> Result<String>;
    /// The active Funnel base URL for `port`, if any.
    async fn funnel_url(&self, port: u16) -> Option<String>;
}

/// Process-global host, installed once at boot by `apps/core`.
fn host_slot() -> &'static OnceLock<Arc<dyn WebhookIngressHost>> {
    static HOST: OnceLock<Arc<dyn WebhookIngressHost>> = OnceLock::new();
    &HOST
}

/// Install the host implementation. Called once from `apps/core` at startup
/// (unconditionally — Core consumes this crate as a non-optional dependency and
/// the public webhook routes reach it in every build). Idempotent: a second call
/// is ignored.
pub fn set_global_host(host: Arc<dyn WebhookIngressHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host, erroring if [`set_global_host`] was never called.
pub(crate) fn host() -> Result<Arc<dyn WebhookIngressHost>> {
    host_slot()
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("webhook-ingress host not initialized"))
}

/// The installed host, or `None` when uninstalled (for the sync, best-effort
/// callers that must not panic — e.g. [`crate::relay_inbound_url`]).
pub(crate) fn host_opt() -> Option<Arc<dyn WebhookIngressHost>> {
    host_slot().get().cloned()
}

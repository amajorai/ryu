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

/// Signed headers carried with an inbound webhook. Composio covers all three
/// values in its current signature; workflow v2 webhooks also require all
/// three so a captured body/signature cannot be replayed under a fresh id.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InboundWebhookHeaders<'a> {
    pub signature: Option<&'a str>,
    pub webhook_id: Option<&'a str>,
    pub webhook_timestamp: Option<&'a str>,
}

impl<'a> InboundWebhookHeaders<'a> {
    pub fn signature(signature: Option<&'a str>) -> Self {
        Self {
            signature,
            ..Self::default()
        }
    }
}

/// Every kernel coupling the webhook-ingress engine needs, inverted. `dyn`-stored
/// (→ `async_trait`), installed once at boot. Implemented by Core; the crate's own
/// tests install a mock.
#[async_trait::async_trait]
pub trait WebhookIngressHost: Send + Sync {
    // ── Composio ─────────────────────────────────────────────────────────────
    /// Whether a Composio key is configured (the RyuRelay opt-in-by-use gate).
    fn composio_is_configured(&self) -> bool;
    /// Whether this node has at least one workflow declaring a `Webhook`
    /// trigger. The second explicit-use signal that opens the RyuRelay ingress:
    /// a user-created webhook trigger is reachable only when Core is registered
    /// with the relay, so the presence of one is enough to justify the outbound
    /// subscription (the composio key is not the only legitimate use).
    fn has_webhook_trigger(&self) -> bool;
    /// Verify an inbound Composio webhook against the global Composio secret.
    fn verify_webhook_signature(&self, raw_body: &[u8], headers: InboundWebhookHeaders<'_>)
        -> bool;
    /// Verify a per-workflow webhook against a trigger-specific secret.
    fn verify_workflow_webhook_signature(
        &self,
        workflow_id: &str,
        secret: &str,
        raw_body: &[u8],
        headers: InboundWebhookHeaders<'_>,
    ) -> bool;
    /// Persistently reserve a signed delivery id until `expires_at` (unix
    /// seconds). `workflow_id` scopes the claim: a workflow id, or the Composio
    /// webhook path for Composio deliveries. `false` means this authenticated id
    /// already ran.
    fn reserve_workflow_delivery(
        &self,
        workflow_id: &str,
        delivery_id: &str,
        expires_at: u64,
    ) -> Result<bool>;
    /// Release a reservation only when the run could not start, permitting a
    /// retry. A started run keeps its reservation even if it later fails.
    fn release_workflow_delivery(&self, workflow_id: &str, delivery_id: &str) -> Result<()>;
    /// Fan a verified Composio payload out to the triggers store, returning the
    /// number of agent runs fired. `None` when the store is not initialised.
    async fn composio_handle_webhook(&self, payload: &Value) -> Option<usize>;
    /// The host forwards billing facts to Gateway after signature verification.
    async fn record_composio_trigger_delivery(&self, _delivery_id: &str) -> Result<()> {
        Ok(())
    }
    /// The managed relay registered this node again under a new public URL (its
    /// relay token was rotated), and that URL is now the advertised one. Core
    /// re-points the destinations it registered with the old URL, such as the
    /// Composio project webhook subscription. Called on a spawned task; the
    /// default has nothing to update.
    async fn relay_public_url_changed(&self, _public_url: &str) {}
    /// Start a workflow run seeded with the trigger payload; returns the run id
    /// once the run is seeded. `Err` means no run exists, so the caller may
    /// release the delivery reservation; the run's own outcome is recorded on
    /// the run, not returned here.
    async fn run_workflow_for_trigger(
        &self,
        workflow_id: &str,
        payload_json: &str,
    ) -> Result<String>;
    /// Raw lookup of a workflow's webhook-trigger secret (no decisions applied).
    fn workflow_webhook_secret(&self, workflow_id: &str) -> WorkflowWebhookSecret;

    // ── Auth + local infra ───────────────────────────────────────────────────
    /// This node's auth bearer token (`~/.ryu/auth.json`), if logged in.
    fn auth_token(&self) -> Option<String>;
    /// The `~/.ryu` data dir (where the relay token is persisted).
    fn data_dir(&self) -> PathBuf;
    /// The Ryu server base URL this node signed in to (the account bearer was
    /// issued by it), or the control plane it is enrolled with. The managed
    /// relay falls back to it when `RYU_BACKEND_URL` is unset. Only a URL the
    /// operator or the sign-in flow named may be returned, never a default.
    fn backend_url(&self) -> Option<String> {
        None
    }

    // ── Mesh (Tailscale Funnel) ──────────────────────────────────────────────
    /// Ensure a Funnel publishes Core's webhook paths (`FUNNEL_PUBLIC_MOUNTS`, proxied to
    /// local `port`), returning its public base URL. Never the whole port.
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

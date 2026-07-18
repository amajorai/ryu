//! The `ComposioHost` seam — the narrow inversion of the only kernel couplings
//! this crate needs (the workflow/agent engines), so the crate has ZERO
//! dependency on `apps/core`.
//!
//! Precedent: `WebhookIngressHost` (`crates/ryu-webhook-ingress/src/host.rs`) and
//! `RecipesHost`/`QuestsHost`/`ClipsHost` (`apps/core/src/*_host.rs`). Core
//! installs its implementation once at boot via [`set_global_host`];
//! `apps/core/src/composio_host.rs` is the kernel side.
//!
//! **Acceptance line (why the trait is only two run-fan-out methods):** every
//! composio *decision* stays in this crate — key resolution, catalog/connect
//! HTTP, the subscription store, poll, HMAC verification, action execution, and
//! elicitation detection. The host performs only the two operations that are
//! genuinely the orchestration kernel: seeding + starting a workflow run, and
//! dispatching an agent run. Both take strings and return a run id — no workflow
//! or agent types cross the crate boundary. If a composio decision ever moved
//! into a host method this would be a facade, not an extraction.

use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};

/// The two workflow/agent-engine fan-outs the trigger store fires on a matched
/// event. `dyn`-stored (→ `async_trait`), installed once at boot by Core; the
/// crate's own tests install a mock.
#[async_trait::async_trait]
pub trait ComposioHost: Send + Sync {
    /// Start a persisted workflow run seeded with the raw trigger payload under
    /// the reserved `trigger` state key; returns the run id.
    async fn run_workflow_for_trigger(
        &self,
        workflow_id: &str,
        payload_json: &str,
    ) -> Result<String>;

    /// Run a single agent prompt for a fired trigger (routes through the
    /// configured agent's real chat path); returns the run id.
    async fn run_agent(&self, agent_id: &str, prompt: &str) -> Result<String>;
}

/// Process-global host, installed once at boot by `apps/core`.
fn host_slot() -> &'static OnceLock<Arc<dyn ComposioHost>> {
    static HOST: OnceLock<Arc<dyn ComposioHost>> = OnceLock::new();
    &HOST
}

/// Install the host implementation. Called once from `apps/core` at startup.
/// Idempotent: a second call is ignored.
pub fn set_global_host(host: Arc<dyn ComposioHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host, erroring if [`set_global_host`] was never called.
pub(crate) fn host() -> Result<Arc<dyn ComposioHost>> {
    host_slot()
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("composio host not initialized"))
}

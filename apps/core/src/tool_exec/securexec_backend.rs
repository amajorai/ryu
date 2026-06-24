//! The off-by-default **secure-exec** PTC code backend (gated behind the
//! `tool-exec-securexec` feature). Backed by rivet's `secure-exec`
//! (`rivet-dev/secure-exec`): JavaScript run inside a native **V8 isolate**
//! (the same primitive behind Cloudflare Workers / browser tabs) with
//! deny-by-default permissions over filesystem, network, child processes, and
//! env.
//!
//! ## Why a stub today (same posture as [`super::rquickjs_backend`])
//!
//! The v1 default PTC backend is the Deno subprocess ([`super::deno_backend`]).
//! secure-exec is a **Node/Bun library**, so wiring it as a real PTC backend
//! needs two things this repo does not ship yet:
//!   1. the `secure-exec` npm package present in a Node/Bun runtime on the host,
//!      and
//!   2. a port of the deno harness's **stdio tool-bridge** (the `tools.*` proxy
//!      that round-trips each tool call back to Core's [`McpRegistry`]) into a
//!      Node/secure-exec harness, since PTC's whole point is tool fan-out, not
//!      bare code execution.
//!
//! Until both land — and a smoke probe passes on the target platforms — this
//! module makes `tool-exec-securexec` gate a real [`CodeExecutor`] variant (the
//! "swappable backend" contract) rather than gating nothing, and reports
//! unavailability instead of running anything.

use super::{ExecOutcome, ResumeDecision, SandboxToolInvoker};
use serde_json::Value;
use std::sync::Arc;

/// The backend label used for audit (`backend()` on the enum).
pub const BACKEND_SECUREXEC: &str = "securexec";

/// Placeholder executor. Compiles under `tool-exec-securexec` and is selectable
/// as the PTC backend, but every run reports that the backend is not yet wired
/// (the npm runtime + stdio tool-bridge are deferred).
pub struct SecureExecExecutor;

impl SecureExecExecutor {
    pub fn new() -> Self {
        SecureExecExecutor
    }

    /// Always reports unavailability — the secure-exec V8-isolate backend is
    /// gated until the Node/Bun runtime + tool-bridge harness land.
    pub async fn execute(
        &self,
        _code: &str,
        _invoker: Arc<SandboxToolInvoker>,
        _agent_id: &str,
    ) -> ExecOutcome {
        ExecOutcome::error(
            "secure-exec (V8 isolate) PTC backend is not yet wired (needs the secure-exec npm \
             runtime + a Node-side tool-bridge harness); disable the `tool-exec-securexec` \
             feature to use the default Deno subprocess backend",
        )
    }
}

/// Whether the secure-exec backend is runnable. Always `false` until the runtime
/// + tool-bridge land (so the `execute`/`resume` defs are not wired into the
/// bridge for an unbuilt backend).
pub fn securexec_available() -> bool {
    false
}

/// Resume is not supported by the stub backend (it never parks anything).
pub async fn resume_parked(
    _execution_id: &str,
    _agent_id: &str,
    _decision: ResumeDecision,
    _content: Value,
) -> Option<ExecOutcome> {
    None
}

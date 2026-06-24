//! The off-by-default **just-bash** PTC code backend (gated behind the
//! `tool-exec-justbash` feature). Backed by `just-bash` (`justbash.dev`): a
//! virtual bash environment with an in-memory filesystem, written in TypeScript
//! and designed for AI agents — pluggable FS backends (in-memory / overlay /
//! read-write), URL-allowlist network, and configurable loop/recursion caps.
//!
//! ## Why a stub today (same posture as [`super::rquickjs_backend`])
//!
//! The v1 default PTC backend is the Deno subprocess ([`super::deno_backend`]).
//! just-bash is a **Node library** that runs *bash*, not the JS `tools.*`
//! orchestration program PTC expects, so wiring it as a real PTC backend needs:
//!   1. the `just-bash` npm package present in a Node runtime on the host, and
//!   2. a bridge that exposes Core's tools to the bash environment (e.g. as
//!      callable built-ins) and maps a script's final output to an
//!      [`ExecOutcome`].
//!
//! It is therefore the most divergent of the candidate backends (a shell, not a
//! JS engine). Until the runtime + bridge land this module makes
//! `tool-exec-justbash` gate a real [`CodeExecutor`] variant rather than gating
//! nothing, and reports unavailability instead of running anything.
//!
//! Note: just-bash itself runs *without* VM isolation (in-memory JS sandbox), so
//! if it is ever promoted, pair it with an OS-level boundary for untrusted code.

use super::{ExecOutcome, ResumeDecision, SandboxToolInvoker};
use serde_json::Value;
use std::sync::Arc;

/// The backend label used for audit (`backend()` on the enum).
pub const BACKEND_JUSTBASH: &str = "justbash";

/// Placeholder executor. Compiles under `tool-exec-justbash` and is selectable
/// as the PTC backend, but every run reports that the backend is not yet wired
/// (the npm runtime + tool bridge are deferred).
pub struct JustBashExecutor;

impl JustBashExecutor {
    pub fn new() -> Self {
        JustBashExecutor
    }

    /// Always reports unavailability — the just-bash backend is gated until the
    /// Node runtime + tool bridge land.
    pub async fn execute(
        &self,
        _code: &str,
        _invoker: Arc<SandboxToolInvoker>,
        _agent_id: &str,
    ) -> ExecOutcome {
        ExecOutcome::error(
            "just-bash PTC backend is not yet wired (needs the just-bash npm runtime + a \
             bash-side tool bridge); disable the `tool-exec-justbash` feature to use the \
             default Deno subprocess backend",
        )
    }
}

/// Whether the just-bash backend is runnable. Always `false` until the runtime +
/// bridge land.
pub fn justbash_available() -> bool {
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

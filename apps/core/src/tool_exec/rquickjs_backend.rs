//! The off-by-default in-process **rquickjs** code backend (gated behind the
//! `tool-exec-quickjs` feature).
//!
//! Per the spec (scope-review HIGH #2/#3) the v1 default is the Deno subprocess
//! ([`super::deno_backend`]); rquickjs forces a native MSVC QuickJS build, a
//! `!Send` future on a dedicated LocalSet thread, an `async-trait` dep, and
//! weaker in-process isolation. It is therefore **not landed** as a working
//! backend yet — only after a `quickjs_smoke` probe passes on Windows. This
//! module exists so the `tool-exec-quickjs` feature gates a real
//! [`CodeExecutor`] variant (the "swappable backend" contract) rather than
//! gating nothing; until the crate dep + smoke probe land it reports
//! unavailability instead of executing.
//!
//! There is intentionally **no `rquickjs` crate dependency** here — adding the
//! native build is deferred behind the smoke probe. Enabling `tool-exec-quickjs`
//! today compiles this stub and selects it as the backend, where it returns a
//! clear "not yet built" error.

use super::{ExecOutcome, ResumeDecision, SandboxToolInvoker};
use serde_json::Value;
use std::sync::Arc;

/// Placeholder in-process executor. Compiles under `tool-exec-quickjs`, but
/// every run reports that the backend is not yet built (the `rquickjs` crate +
/// `quickjs_smoke` probe are deferred per spec).
pub struct QuickjsExecutor;

impl QuickjsExecutor {
    pub fn new() -> Self {
        QuickjsExecutor
    }

    /// Always reports unavailability — the rquickjs backend is gated until the
    /// native build + Windows smoke probe land.
    pub async fn execute(
        &self,
        _code: &str,
        _invoker: Arc<SandboxToolInvoker>,
        _agent_id: &str,
    ) -> ExecOutcome {
        ExecOutcome::error(
            "rquickjs backend is not yet built (gated behind a Windows quickjs_smoke probe); disable the `tool-exec-quickjs` feature to use the default Deno subprocess backend",
        )
    }
}

/// Whether the rquickjs backend is runnable. Always `false` until the crate dep
/// + smoke probe land.
pub fn quickjs_available() -> bool {
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

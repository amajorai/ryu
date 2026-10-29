//! Decide where a Lean or Bend program runs: a live command-capable sandbox
//! backend, or (only when allowed) the bare host.
//!
//! Same posture as the Python code evaluator in `ryu-eval-code`: prefer the
//! configured sandbox when it can run commands and is reachable; otherwise
//! release builds refuse unless the operator opted in, and debug builds (tests,
//! local `dev` profiles) fall back to the host.

use ryu_sandbox::{build_command_backend, configured_backend, detect_backend, Sandbox};

/// Env var that lets Lean/Bend code steps run as a bare host subprocess when no
/// command-capable sandbox backend is live. Truthy values: `1`/`true`/`yes`/`on`.
///
/// Setting it means "workflow-authored Lean and Bend programs may execute on this
/// host with the host's filesystem and network". Configuring a command-capable
/// sandbox (docker/daytona/...) whose image ships the toolchain is the supported
/// path.
pub const ENV_ALLOW_UNSANDBOXED_CODE: &str = "RYU_WORKFLOW_ALLOW_UNSANDBOXED_CODE";

/// Where one program runs.
pub(crate) enum Placement {
    /// A live command-capable sandbox backend.
    Sandbox {
        sandbox: Box<dyn Sandbox>,
        backend: String,
    },
    /// The bare host (operator opt-in or debug build).
    Host,
    /// Neither is allowed; the reason fails the step.
    Refused(String),
}

/// Resolve the placement against the live sandbox configuration.
pub(crate) async fn choose(language: &str) -> Placement {
    let backend = configured_backend();
    if let Ok(sandbox) = build_command_backend(&backend) {
        // `build_command_backend` succeeds for a configured backend whose daemon
        // is down; probe before committing so the host rule still applies.
        if detect_backend(backend.as_str()).await {
            return Placement::Sandbox {
                sandbox,
                backend: backend.as_str().to_string(),
            };
        }
    }
    let opted_in = opt_in(std::env::var(ENV_ALLOW_UNSANDBOXED_CODE).ok().as_deref());
    host_rule(language, backend.as_str(), opted_in, cfg!(debug_assertions))
}

/// Parse the [`ENV_ALLOW_UNSANDBOXED_CODE`] opt-in.
pub(crate) fn opt_in(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// The refuse-or-host rule, split out so the release posture is testable even
/// though `cargo test` always builds with debug assertions.
pub(crate) fn host_rule(
    language: &str,
    backend: &str,
    opted_in: bool,
    debug_build: bool,
) -> Placement {
    if opted_in || debug_build {
        return Placement::Host;
    }
    Placement::Refused(format!(
        "{language} code steps need a command-capable sandbox backend (docker, daytona, ...) \
         whose image includes the toolchain; the configured backend '{backend}' cannot run \
         commands, so the step was refused rather than run unsandboxed on the host. Configure \
         a sandbox backend, or set {ENV_ALLOW_UNSANDBOXED_CODE}=1 to accept host execution."
    ))
}

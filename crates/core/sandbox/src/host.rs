//! Host seam: the four Core couplings this crate cannot own, injected once at
//! startup so the crate keeps ZERO dependency on `apps/core`.
//!
//! Unlike the per-call host trait some primitives use (`ImageHost`), the sandbox
//! metering lives in a global background ticker (`heartbeat`) with process-wide
//! run state, so its host couplings are installed globally via [`install_host`]
//! (the `ryu-tool-exec` `install_host_hooks` precedent). All four are simple
//! getters:
//!
//! - `gateway_bearer` / `gateway_url` — the Gateway `sandbox/tick` metering debit.
//! - `ryu_dir` — the persisted default-backend selection file
//!   (`<data dir>/state/sandbox-backend.json`) and the persistent-sandbox restart
//!   records (`<data dir>/state/sandbox-persistent-runs.json` plus per-process
//!   leases in `<data dir>/state/sandbox-persistent-leases/`).
//! - `registered_org_id` — the org attributed on a metered run.
//! - `default_run_budget_micro_usd` — the preferences-backed default per-run
//!   budget cap (async: reads Core's preferences store).
//!
//! When unset (crate-unit tests, where no Core is running) every getter falls
//! back to a safe, opt-out default — never fail-closed — matching the prior
//! in-Core behaviour of these paths.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::OnceLock;

/// Core-provided couplings threaded into the sandbox metering + backend-selection
/// paths. Installed once at Core startup via [`install_host`].
pub struct SandboxHost {
    /// The Gateway bearer for the metering debit (`Err` = no bearer, tail not
    /// billed, fail-open).
    pub gateway_bearer: fn() -> Result<String, String>,
    /// The Gateway base URL for the `sandbox/tick` metering endpoint.
    pub gateway_url: fn() -> String,
    /// Ryu's data directory, parent of the persisted default-backend selection.
    pub ryu_dir: fn() -> PathBuf,
    /// The registered org id attributed on a metered run, if any.
    pub registered_org_id: fn() -> Option<String>,
    /// The preferences-backed default per-run budget cap in micro-USD (`0` = no
    /// cap). Async because it reads Core's preferences store.
    pub default_run_budget_micro_usd: fn() -> Pin<Box<dyn Future<Output = u64> + Send>>,
}

static HOST: OnceLock<SandboxHost> = OnceLock::new();

/// Install the Core-provided couplings. Idempotent (first write wins); called
/// once from Core startup. Safe to omit in crate-unit tests (safe fallbacks).
///
/// The first install, when made inside a Tokio runtime, also starts
/// [`crate::session::reap_orphaned_sandboxes`] in the background: the ryu dir
/// is known from here on, and persistent workspaces left running by a previous
/// Core process are no longer metered. A host installed outside a runtime must
/// call that function itself.
pub fn install_host(host: SandboxHost) {
    if HOST.set(host).is_ok() {
        crate::session::spawn_orphan_reaper();
    }
}

/// Gateway bearer for the metering debit. `Err` fallback when Core has not
/// installed its host (crate-unit tests) so the debit fails open.
pub(crate) fn gateway_bearer() -> Result<String, String> {
    match HOST.get() {
        Some(h) => (h.gateway_bearer)(),
        None => Err("sandbox host not installed".to_owned()),
    }
}

/// Gateway base URL for the metering endpoint. Loopback fallback (unreachable,
/// so the debit fails open) when Core has not installed its host.
pub(crate) fn gateway_url() -> String {
    match HOST.get() {
        Some(h) => (h.gateway_url)(),
        None => "http://127.0.0.1:0".to_owned(),
    }
}

/// Ryu data directory (`state/sandbox-backend.json` lives under it). Falls back
/// to the resolved Ryu data dir when Core has not installed its host, and to a
/// temp dir in this crate's own unit tests (which never persist a real one).
pub(crate) fn ryu_dir() -> PathBuf {
    match HOST.get() {
        Some(h) => (h.ryu_dir)(),
        None if cfg!(test) => std::env::temp_dir().join("ryu"),
        None => ryu_sidecar_runtime::ryu_dir(),
    }
}

/// Registered org id attributed on a metered run. `None` fallback when Core has
/// not installed its host.
pub(crate) fn registered_org_id() -> Option<String> {
    HOST.get().and_then(|h| (h.registered_org_id)())
}

/// Preferences-backed default per-run budget (micro-USD). `0` (no cap) fallback
/// when Core has not installed its host — a budget cap is opt-in, never
/// fail-closed.
pub(crate) async fn default_run_budget_micro_usd() -> u64 {
    match HOST.get() {
        Some(h) => (h.default_run_budget_micro_usd)().await,
        None => 0,
    }
}

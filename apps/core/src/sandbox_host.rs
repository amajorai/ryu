//! Core's kernel side of the extracted [`ryu_sandbox`] seam.
//!
//! The `ryu-sandbox` crate owns the sandbox execution primitive — the `Sandbox`
//! trait + backends (wasmtime/docker/microsandbox/opensandbox/daytona), backend
//! selection, the long-lived-workspace session path, and the per-run metering
//! heartbeat. What it cannot own — because they read Core config/state — are four
//! couplings: the Gateway url + bearer (the `sandbox/tick` metering debit), the
//! ryu-dir (the persisted default-backend selection file), the registered org id
//! (attributed on a metered run), and the preferences-backed default run budget.
//!
//! This shim wires all four behind the crate's narrow global
//! [`ryu_sandbox::host::SandboxHost`] seam, installed once at startup. Because
//! the metering lives in a process-wide background ticker, the global-install
//! shape (the `ryu-tool-exec` `install_host_hooks` precedent) is used rather than
//! a per-call host trait.

/// Install the crate's Core-side sandbox host couplings. Called once from
/// `main.rs` at startup so the sandbox metering (Gateway url/bearer, org) and
/// backend-selection (ryu-dir) and default budget (preferences) stay
/// single-source with their Core homes. Idempotent (first write wins).
pub fn install_sandbox_host() {
    ryu_sandbox::host::install_host(ryu_sandbox::host::SandboxHost {
        gateway_bearer: || crate::sidecar::gateway::gateway_bearer().map_err(|e| format!("{e:#}")),
        gateway_url: crate::sidecar::gateway::gateway_url,
        ryu_dir: crate::paths::ryu_dir,
        registered_org_id: || crate::sidecar::control_plane::registered_org().map(|o| o.id),
        default_run_budget_micro_usd: || Box::pin(default_run_budget_micro_usd()),
    });
}

/// Read the default per-run budget (micro-USD) from Core's preferences store.
/// Returns `0` (no cap) when the pref is unset, unparseable, or the store cannot
/// be opened — a budget cap is opt-in, never fail-closed. The pref key stays
/// single-source in the crate (`heartbeat::PREF_DEFAULT_RUN_BUDGET`).
async fn default_run_budget_micro_usd() -> u64 {
    let Ok(store) = crate::server::preferences::PreferencesStore::open_default() else {
        return 0;
    };
    match store
        .get(ryu_sandbox::heartbeat::PREF_DEFAULT_RUN_BUDGET)
        .await
    {
        Ok(Some(raw)) => raw.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

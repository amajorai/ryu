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
        gateway_bearer: || {
            crate::sidecar::gateway::required_gateway_core_token().map_err(|e| format!("{e:#}"))
        },
        gateway_url: crate::sidecar::gateway::gateway_url,
        ryu_dir: crate::paths::ryu_dir,
        registered_org_id: || crate::sidecar::control_plane::registered_org().map(|o| o.id),
        default_run_budget_micro_usd: || Box::pin(default_run_budget_micro_usd()),
    });
    install_box_credential_source();
}

/// On a managed node, Box calls use the control plane's short-lived `rbx1`
/// tenant credential (`POST /api/box/node-credential`, keyed by the node's
/// durable control-plane key), not static env. `RYU_SANDBOX_BOX_TOKEN` still
/// wins when an operator sets it, and self-hosted nodes keep the env path.
fn install_box_credential_source() {
    if let Some(source) = managed_box_credential_source(
        crate::sidecar::gateway::managed_node(),
        crate::sidecar::control_plane::control_plane_url(),
    ) {
        ryu_sandbox::box_credential::install_source(std::sync::Arc::new(source));
    }
}

/// The control-plane source for a managed node, authenticated with the same
/// key Core sends on every control-plane call (env or enrolled), read at each
/// fetch so a rotated key applies.
fn managed_box_credential_source(
    managed: bool,
    control_plane_url: String,
) -> Option<ryu_sandbox::box_credential::ControlPlaneCredentialSource> {
    if !managed || control_plane_url.trim().is_empty() {
        return None;
    }
    Some(
        ryu_sandbox::box_credential::ControlPlaneCredentialSource::new(
            control_plane_url,
            std::sync::Arc::new(crate::sidecar::control_plane::gateway_key),
        ),
    )
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

#[cfg(test)]
mod tests {
    #[test]
    fn session_box_credential_source_is_installed_only_on_managed_nodes() {
        assert!(super::managed_box_credential_source(false, "https://cp.example".into()).is_none());
        assert!(super::managed_box_credential_source(true, "  ".into()).is_none());
        let source = super::managed_box_credential_source(true, "https://cp.example/api/".into())
            .expect("a managed node with a control plane gets the source");
        assert!(format!("{source:?}").contains("https://cp.example"));
    }
}

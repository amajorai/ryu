//! Persistent remote sandbox lifecycle manager.
//!
//! A *persistent* sandbox is a long-lived remote workspace: created once, driven
//! by many execs, and destroyed explicitly. It is metered per-second by the same
//! [`super::heartbeat`] ticker as the one-shot path — the difference is that a
//! persistent run [`register`](super::heartbeat::register)s with the **real**
//! [`WorkspaceId`] (never the empty placeholder the one-shot exec uses), so a
//! budget/balance kill verdict can actually `destroy_workspace` the live remote
//! sandbox.
//!
//! Placement (Core-vs-Gateway): creating, holding, exec-ing, and destroying a
//! workspace is "what runs" → Core. Whether the wallet may pay for the next tick
//! is "what is allowed/paid" → the Gateway returns the verdict; this module only
//! registers the run for metering and enforces destroy on stop.
//!
//! Persistent workspaces are supported by the remote `daytona` and `box`
//! backends. Local one-shot runtimes are never silently promoted into a durable
//! host.
//!
//! ## Durable state
//!
//! Provider clients are rebuilt from env for each trait call — there is no pooled
//! HTTP client to hold. The only durable handle to a live remote sandbox is its [`WorkspaceId`], so this module
//! owns the `run_id ↔ WorkspaceId ↔ org ↔ spec` mapping itself, mirroring
//! heartbeat's `OnceLock<Mutex<HashMap<..>>>` idiom.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use super::box_backend;
use super::daytona;
use super::heartbeat;
use super::spec::SandboxSpec;
use super::{build_command_backend, ExecSpec, SandboxBackend, SandboxCapabilities, WorkspaceId};

/// Backend override for the persistent workspace path. The ordinary
/// `RYU_SANDBOX_BACKEND` default is an ephemeral tool backend, so this separate
/// knob cannot accidentally turn `wasmtime` into a persistent provider.
pub const ENV_PERSISTENT_BACKEND: &str = "RYU_PERSISTENT_SANDBOX_BACKEND";

/// One live, persistent remote workspace tracked by this manager.
struct LiveSandbox {
    /// The run's unique id (the uuid minted at create time). Also the heartbeat
    /// registry key, so the two stay joined.
    run_id: String,
    /// The real provider sandbox id returned by `create_workspace` (never empty).
    /// The only durable handle to the remote sandbox; used to exec and destroy.
    workspace: WorkspaceId,
    /// Backend that owns the workspace. Rebuilt from this name for each later
    /// operation and for heartbeat budget kills.
    backend: SandboxBackend,
    /// Bill-to org, or `None` on an unmanaged/local node (register for
    /// visibility, skip the final debit).
    org_id: Option<String>,
    /// The billed/displayed resource shape.
    spec: SandboxSpec,
    /// Per-run execution cap in micro-USD; `0` = no cap.
    budget_micro_usd: u64,
    /// Wall-clock at create, owned here for the final-debit tail — heartbeat drops
    /// its own `started_at` on deregister, so this manager must measure elapsed.
    created_at: Instant,
    /// Whether this run is charged through Ryu's Gateway heartbeat. An upstream
    /// Box subscription is already settled by its provider and must not be
    /// charged again from the Ryu wallet.
    metered: bool,
}

fn live() -> &'static Mutex<HashMap<String, LiveSandbox>> {
    static LIVE: OnceLock<Mutex<HashMap<String, LiveSandbox>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Poison-tolerant lock accessor, matching heartbeat's idiom. The guard is held
/// only to insert/remove/clone-out — NEVER across an `.await`.
fn lock_live() -> MutexGuard<'static, HashMap<String, LiveSandbox>> {
    live().lock().unwrap_or_else(|e| e.into_inner())
}

/// A newly created persistent sandbox, returned to the caller (endpoint / MCP).
#[derive(Debug, Clone, serde::Serialize)]
pub struct CreatedSandbox {
    /// The run id used for all subsequent exec/destroy calls and metering.
    pub run_id: String,
    /// The underlying provider sandbox id (opaque; for display/debugging).
    pub workspace_id: String,
    /// The remote backend that owns this workspace.
    pub backend: String,
}

/// The captured output of one exec against a persistent sandbox.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SandboxExecResult {
    /// Process exit code (0 = success).
    pub exit_code: i32,
    /// Decoded stdout (lossy UTF-8).
    pub stdout: String,
    /// Decoded stderr (lossy UTF-8).
    pub stderr: String,
}

/// Create a persistent workspace using the configured remote backend, register
/// it for per-second metering, and track it in the live registry.
///
/// `spec` sets only the billed/displayed shape (providers provision from their own
/// env sizing knobs); `None` uses the configured
/// spec. `budget_micro_usd` is the per-run cap; `None` uses the node default.
///
/// The token-missing / provider-down failure surfaces here as `Err` (the
/// workspace could not be created); metering registration is fail-open.
pub async fn create_sandbox(
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
) -> anyhow::Result<CreatedSandbox> {
    let backend = configured_persistent_backend().await?;
    create_sandbox_with_backend(&backend, spec, budget_micro_usd).await
}

/// Create a persistent workspace on an explicit remote backend.
pub async fn create_sandbox_with_backend(
    backend: &SandboxBackend,
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
) -> anyhow::Result<CreatedSandbox> {
    if !matches!(backend, SandboxBackend::Box | SandboxBackend::Daytona) {
        anyhow::bail!(
            "persistent sandboxes require the 'box' or 'daytona' backend, got '{}'",
            backend.as_str()
        );
    }
    let billed = spec.unwrap_or_else(|| configured_spec(backend));
    let subscription_unmetered = matches!(backend, SandboxBackend::Box)
        && box_backend::subscription_passthrough_active().await;
    let sandbox = build_command_backend(backend)?;
    // Deny-all caps (network=false) for v1; a token-missing / provider-down error
    // surfaces here as Err. The returned id is the real provider sandbox id.
    let workspace = sandbox
        .create_workspace(SandboxCapabilities::default())
        .await?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let org_id = crate::host::registered_org_id();
    let budget = match budget_micro_usd {
        Some(b) => b,
        None => heartbeat::default_run_budget_micro_usd().await,
    };

    // Register with the REAL workspace id so a kill verdict can destroy it.
    let metered = !subscription_unmetered;
    if metered {
        heartbeat::register(
            run_id.clone(),
            org_id.clone(),
            backend.as_str(),
            workspace.clone(),
            billed.clone(),
            budget,
        );
    }

    lock_live().insert(
        run_id.clone(),
        LiveSandbox {
            run_id: run_id.clone(),
            workspace: workspace.clone(),
            backend: backend.clone(),
            org_id,
            spec: billed,
            budget_micro_usd: budget,
            created_at: Instant::now(),
            metered,
        },
    );

    Ok(CreatedSandbox {
        run_id,
        workspace_id: workspace.0,
        backend: backend.as_str().to_owned(),
    })
}

/// Resolve the persistent backend. An explicit persistent override wins;
/// otherwise an already-selected Box/Daytona backend is honored, then a
/// configured Box is preferred, with Daytona retained as the compatibility
/// default.
pub async fn configured_persistent_backend() -> anyhow::Result<SandboxBackend> {
    if let Some(name) = std::env::var(ENV_PERSISTENT_BACKEND)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        let backend = SandboxBackend::from_name(&name)?;
        if !matches!(backend, SandboxBackend::Box | SandboxBackend::Daytona) {
            anyhow::bail!(
                "persistent backend must be 'box' or 'daytona', got '{}'",
                backend.as_str()
            );
        }
        return Ok(backend);
    }

    let configured = super::configured_backend();
    if matches!(configured, SandboxBackend::Box | SandboxBackend::Daytona) {
        return Ok(configured);
    }
    if matches!(
        box_backend::detect().await,
        box_backend::DetectResult::Available
    ) {
        return Ok(SandboxBackend::Box);
    }
    Ok(SandboxBackend::Daytona)
}

fn configured_spec(backend: &SandboxBackend) -> SandboxSpec {
    match backend {
        SandboxBackend::Box => box_backend::configured_spec(),
        SandboxBackend::Daytona => daytona::configured_spec(),
        _ => SandboxSpec::default(),
    }
}

/// Run one command inside a live persistent sandbox and capture its output.
///
/// Errors when `run_id` is unknown (never created, or already destroyed).
pub async fn exec_in_sandbox(
    run_id: &str,
    command: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> anyhow::Result<SandboxExecResult> {
    // Clone the workspace id out under the guard, then drop it before the I/O.
    let live = {
        lock_live()
            .get(run_id)
            .map(|live| (live.workspace.clone(), live.backend.clone()))
    };
    let Some((ws, backend)) = live else {
        anyhow::bail!("no such sandbox run: {run_id}");
    };

    let mut spec = ExecSpec::new(command, args);
    spec.timeout_secs = timeout_secs;
    let out = build_command_backend(&backend)?
        .exec_in_workspace(&ws, spec)
        .await?;

    Ok(SandboxExecResult {
        exit_code: out.exit_code,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Destroy a persistent sandbox: deregister metering, issue the final tail debit,
/// and tear down the remote workspace.
///
/// Idempotent — an unknown `run_id` (already destroyed, or a budget/balance/
/// accounting kill already tore it down) returns `Ok(())`. The remote workspace
/// is always destroyed, but a billable final-debit failure is returned after the
/// destroy so callers cannot mistake an unaccounted execution for success.
pub async fn destroy_sandbox(run_id: &str) -> anyhow::Result<()> {
    // Remove from the live registry first (idempotent).
    let live = lock_live().remove(run_id);
    let Some(live) = live else {
        // Absent ⇒ already destroyed (e.g. a budget-kill removed the heartbeat
        // entry and tore down the workspace). Idempotent success.
        return Ok(());
    };

    // Deregister for the residual tail. `None` ⇒ the ticker already removed it via
    // a kill verdict (already charged/killed), so there is no tail to bill.
    let residual = if live.metered {
        heartbeat::deregister_for_final_debit(run_id)
    } else {
        None
    };

    // Final debit only when there is a residual AND an owning org (never bill a
    // wrong/empty org). A failure is retained until after the remote workspace
    // is destroyed, then returned to the caller.
    let mut metering_error = None;
    if let (Some(r), Some(org)) = (residual, live.org_id.clone()) {
        let measured = live.created_at.elapsed().as_secs().max(1);
        let remainder = measured.saturating_sub(r.ticked_seconds);
        if let Err(error) = heartbeat::debit_final(
            live.run_id.clone(),
            Some(org),
            live.spec.clone(),
            remainder,
            live.budget_micro_usd,
            r.next_tick_index,
        )
        .await
        {
            metering_error = Some(error);
        }
    }

    // Idempotent (remote provider 404s are treated as success by the backend).
    build_command_backend(&live.backend)?
        .destroy_workspace(&live.workspace)
        .await?;
    if let Some(error) = metering_error {
        anyhow::bail!("sandbox destroyed but final billing failed: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destroy_unknown_run_is_idempotent_ok() {
        // A run that was never created (or already destroyed) returns Ok without
        // touching the network. Uses the current-thread runtime so no ticker spawns.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build runtime");
        let run_id = format!("session_test_missing_{}", std::process::id());
        rt.block_on(async {
            assert!(destroy_sandbox(&run_id).await.is_ok());
        });
    }

    #[test]
    fn exec_unknown_run_errors() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build runtime");
        let run_id = format!("session_test_noexec_{}", std::process::id());
        rt.block_on(async {
            let err = exec_in_sandbox(&run_id, "echo".to_owned(), vec!["hi".to_owned()], None)
                .await
                .expect_err("unknown run must error");
            assert!(err.to_string().contains("no such sandbox run"));
        });
    }

    #[test]
    fn live_registry_insert_and_remove_roundtrip() {
        // The manager's own registry mirrors heartbeat's insert/remove semantics.
        let run_id = format!("session_test_reg_{}", std::process::id());
        lock_live().insert(
            run_id.clone(),
            LiveSandbox {
                run_id: run_id.clone(),
                workspace: WorkspaceId("ws_session_test".to_owned()),
                backend: SandboxBackend::Daytona,
                org_id: None,
                spec: SandboxSpec::default(),
                budget_micro_usd: 0,
                created_at: Instant::now(),
                metered: true,
            },
        );
        assert!(lock_live().contains_key(&run_id));
        let removed = lock_live().remove(&run_id);
        assert!(removed.is_some());
        assert!(!lock_live().contains_key(&run_id));
    }
}

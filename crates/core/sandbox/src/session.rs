//! Persistent Daytona sandbox lifecycle manager.
//!
//! A *persistent* sandbox is a long-lived Daytona workspace: created once, driven
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
//! Persistent is **Daytona-only** by design (the only remote, billable backend);
//! every other backend stays one-shot via `sandbox_exec`. This manager is
//! hardwired to [`DaytonaSandbox`].
//!
//! ## Durable state
//!
//! `DaytonaClient` is module-private to [`super::daytona`] and every trait call
//! rebuilds it from env — there is no pooled HTTP client to hold. The only
//! durable handle to a live remote sandbox is its [`WorkspaceId`], so this module
//! owns the `run_id ↔ WorkspaceId ↔ org ↔ spec` mapping itself, mirroring
//! heartbeat's `OnceLock<Mutex<HashMap<..>>>` idiom.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use super::daytona::{self, DaytonaSandbox};
use super::heartbeat;
use super::spec::SandboxSpec;
use super::{ExecSpec, Sandbox as _, SandboxCapabilities, WorkspaceId};

/// One live, persistent Daytona workspace tracked by this manager.
struct LiveSandbox {
    /// The run's unique id (the uuid minted at create time). Also the heartbeat
    /// registry key, so the two stay joined.
    run_id: String,
    /// The REAL Daytona sandbox id returned by `create_workspace` (never empty).
    /// The only durable handle to the remote sandbox; used to exec and destroy.
    workspace: WorkspaceId,
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
    /// The underlying Daytona sandbox id (opaque; for display/debugging).
    pub workspace_id: String,
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

/// Create a persistent Daytona workspace, register it for per-second metering,
/// and track it in the live registry.
///
/// `spec` sets only the billed/displayed shape (Daytona provisions from its own
/// env sizing knobs — see the FROZEN CONTRACT Gap-1); `None` uses the configured
/// spec. `budget_micro_usd` is the per-run cap; `None` uses the node default.
///
/// The token-missing / Daytona-down failure surfaces here as `Err` (the
/// workspace could not be created); metering registration is fail-open.
pub async fn create_sandbox(
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
) -> anyhow::Result<CreatedSandbox> {
    let billed = spec.unwrap_or_else(daytona::configured_spec);
    let sandbox = DaytonaSandbox::new();
    // Deny-all caps (network=false) for v1; a token-missing / provider-down error
    // surfaces here as Err. The returned id is the real Daytona sandbox id.
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
    heartbeat::register(
        run_id.clone(),
        org_id.clone(),
        "daytona",
        workspace.clone(),
        billed.clone(),
        budget,
    );

    lock_live().insert(
        run_id.clone(),
        LiveSandbox {
            run_id: run_id.clone(),
            workspace: workspace.clone(),
            org_id,
            spec: billed,
            budget_micro_usd: budget,
            created_at: Instant::now(),
        },
    );

    Ok(CreatedSandbox {
        run_id,
        workspace_id: workspace.0,
    })
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
    let ws = { lock_live().get(run_id).map(|l| l.workspace.clone()) };
    let Some(ws) = ws else {
        anyhow::bail!("no such sandbox run: {run_id}");
    };

    let mut spec = ExecSpec::new(command, args);
    spec.timeout_secs = timeout_secs;
    let out = DaytonaSandbox::new().exec_in_workspace(&ws, spec).await?;

    Ok(SandboxExecResult {
        exit_code: out.exit_code,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Destroy a persistent sandbox: deregister metering, issue the final tail debit,
/// and tear down the remote workspace.
///
/// Idempotent — an unknown `run_id` (already destroyed, or a budget-kill already
/// tore it down) returns `Ok(())`. Metering is fully fail-open: a billing error
/// never fails the destroy.
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
    let residual = heartbeat::deregister_for_final_debit(run_id);

    // Final debit only when there is a residual AND an owning org (never bill a
    // wrong/empty org). `debit_final` is fully fail-open.
    if let (Some(r), Some(org)) = (residual, live.org_id.clone()) {
        let measured = live.created_at.elapsed().as_secs().max(1);
        let remainder = measured.saturating_sub(r.ticked_seconds);
        heartbeat::debit_final(
            live.run_id.clone(),
            Some(org),
            live.spec.clone(),
            remainder,
            live.budget_micro_usd,
            r.next_tick_index,
        )
        .await;
    }

    // Idempotent (Daytona 404 = success).
    DaytonaSandbox::new()
        .destroy_workspace(&live.workspace)
        .await?;
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
                org_id: None,
                spec: SandboxSpec::default(),
                budget_micro_usd: 0,
                created_at: Instant::now(),
            },
        );
        assert!(lock_live().contains_key(&run_id));
        let removed = lock_live().remove(&run_id);
        assert!(removed.is_some());
        assert!(!lock_live().contains_key(&run_id));
    }
}

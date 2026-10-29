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
//!
//! That in-memory map dies with the process while the provider keeps billing,
//! so every live workspace is also recorded in `sandbox-persistent-runs.json`
//! under the host data dir's `state/` before it is handed out. Each record names the Core
//! process that owns it through a lease file this process keeps locked for its
//! whole life. [`reap_orphaned_sandboxes`] (spawned when Core installs the
//! host) destroys the records of processes whose lease is free, i.e. that have
//! exited or crashed. Orphans are destroyed, never re-adopted: their metering
//! stopped with the old process.

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions, TryLockError};
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex, MutexGuard, OnceLock,
};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::box_backend;
use super::daytona;
use super::heartbeat;
use super::spec::SandboxSpec;
use super::{build_command_backend, ExecSpec, SandboxBackend, SandboxCapabilities, WorkspaceId};

/// Backend override for the persistent workspace path. The ordinary
/// `RYU_SANDBOX_BACKEND` default is an ephemeral tool backend, so this separate
/// knob cannot accidentally turn `wasmtime` into a persistent provider.
pub const ENV_PERSISTENT_BACKEND: &str = "RYU_PERSISTENT_SANDBOX_BACKEND";
const MAX_LIVE_SANDBOXES: usize = 16;
static LIVE_COUNT: AtomicUsize = AtomicUsize::new(0);

fn reserve_live_slot() -> anyhow::Result<()> {
    let mut current = LIVE_COUNT.load(Ordering::Relaxed);
    loop {
        if current >= MAX_LIVE_SANDBOXES {
            anyhow::bail!("persistent sandbox admission limit reached");
        }
        match LIVE_COUNT.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Ok(()),
            Err(next) => current = next,
        }
    }
}

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
    /// When the provider destroys the workspace on its own (a Box TTL), or
    /// `None` when it reported no deadline. Metering never runs past it.
    expires_at: Option<Instant>,
    /// Whether this run is charged through Ryu's Gateway heartbeat. An upstream
    /// Box subscription is already settled by its provider and must not be
    /// charged again from the Ryu wallet.
    metered: bool,
    /// The agent/session that created the run. Persistent MCP operations must
    /// present the same binding; HTTP owner-only routes use the legacy unbound
    /// wrapper and never share that handle with the MCP plane.
    owner: Option<SandboxOwner>,
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

/// Restart record file, under `<data dir>/state`.
const PERSISTED_RUNS_FILE: &str = "sandbox-persistent-runs.json";
/// Per-process lease files, under `<data dir>/state`. A record belongs to a live
/// Core exactly while that process holds the lock on `<instance>.lock`.
const LEASES_DIR: &str = "sandbox-persistent-leases";
/// Waits between reaper passes while records stay pending (a previous Core
/// still shutting down, or a provider delete that failed).
const REAP_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(15),
    Duration::from_secs(60),
    Duration::from_secs(300),
];
/// A lease file with no records is only cleaned up once it is at least this
/// old. A Core creating its first workspace creates the file a moment before
/// it locks it; claiming or removing the file in that gap would leave that
/// Core holding a lock on an unlinked file, so its records would later look
/// orphaned to every reaper.
const STALE_LEASE_MIN_AGE: Duration = Duration::from_secs(60);

/// The restart record of one live persistent workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PersistedSandbox {
    workspace_id: String,
    backend: String,
    /// The Core process (lease) that owns the workspace.
    instance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_session_id: Option<String>,
}

impl PersistedSandbox {
    fn owner(&self) -> Option<SandboxOwner> {
        if self.owner_agent_id.is_none() && self.owner_session_id.is_none() {
            return None;
        }
        Some(SandboxOwner {
            agent_id: self.owner_agent_id.clone(),
            session_id: self.owner_session_id.clone(),
        })
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedSandboxes {
    #[serde(default)]
    runs: BTreeMap<String, PersistedSandbox>,
}

fn persisted_runs_path() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::host::ryu_dir(), PERSISTED_RUNS_FILE)
}

fn leases_dir() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::host::ryu_dir(), LEASES_DIR)
}

/// This process's lease id, minted once.
fn instance_id() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// Lease ids become file names, so only accept the shape [`instance_id`] mints.
fn is_valid_instance(instance: &str) -> bool {
    !instance.is_empty()
        && instance.len() <= 64
        && instance
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn lease_path(leases: &Path, instance: &str) -> PathBuf {
    leases.join(format!("{instance}.lock"))
}

/// Whether a lease file may still be in its owner's create-then-lock gap (see
/// [`STALE_LEASE_MIN_AGE`]). An unreadable age counts as recent.
fn lease_recently_created(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_none_or(|age| age < STALE_LEASE_MIN_AGE)
}

/// Try to lock `instance`'s lease. `Ok(None)` means a live process holds it.
fn try_claim_lease(leases: &Path, instance: &str) -> std::io::Result<Option<File>> {
    std::fs::create_dir_all(leases)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lease_path(leases, instance))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// Lock this process's lease for the rest of its life. The OS releases it on
/// exit or crash, which is what marks this process's records as orphans.
fn hold_instance_lease(leases: &Path) -> anyhow::Result<()> {
    static LEASE: Mutex<Option<File>> = Mutex::new(None);
    let mut lease = LEASE.lock().unwrap_or_else(|error| error.into_inner());
    if lease.is_some() {
        return Ok(());
    }
    let file = try_claim_lease(leases, instance_id())
        .with_context(|| format!("locking persistent sandbox lease in {}", leases.display()))?
        .ok_or_else(|| {
            anyhow::anyhow!("persistent sandbox lease {} is already held", instance_id())
        })?;
    *lease = Some(file);
    Ok(())
}

/// Read the restart records. A missing file is empty; a corrupt one is an
/// error, so a later write can never replace it with an empty document.
fn read_records(path: &Path) -> anyhow::Result<PersistedSandboxes> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .with_context(|| format!("parsing persistent sandbox records {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(PersistedSandboxes::default()),
        Err(error) => Err(error)
            .with_context(|| format!("reading persistent sandbox records {}", path.display())),
    }
}

/// Serialized read-modify-write of the restart records, replaced atomically.
/// The lock is a sidecar file so it also excludes another Core process (an old
/// one still shutting down while the new one reaps) and other threads here.
fn mutate_records(path: &Path, change: impl FnOnce(&mut PersistedSandboxes)) -> anyhow::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let mut lock_name = path.file_name().unwrap_or_default().to_os_string();
    lock_name.push(".lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join(lock_name))
        .with_context(|| format!("opening the lock for {}", path.display()))?;
    lock.lock()
        .with_context(|| format!("locking {}", path.display()))?;
    let mut records = read_records(path)?;
    change(&mut records);
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating a temporary file beside {}", path.display()))?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), &records)
        .context("serializing persistent sandbox records")?;
    temporary
        .as_file_mut()
        .sync_all()
        .context("syncing persistent sandbox records")?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

fn forget_record(path: &Path, run_id: &str) -> anyhow::Result<()> {
    mutate_records(path, |records| {
        records.runs.remove(run_id);
    })
}

/// Record a just-created workspace under this process's lease. Must succeed
/// before the workspace is handed out.
fn track_persistent_workspace(
    run_id: &str,
    workspace: &WorkspaceId,
    backend: &SandboxBackend,
    owner: Option<&SandboxOwner>,
) -> anyhow::Result<()> {
    hold_instance_lease(&leases_dir())?;
    let record = PersistedSandbox {
        workspace_id: workspace.0.clone(),
        backend: backend.as_str().to_owned(),
        instance: instance_id().to_owned(),
        owner_agent_id: owner.and_then(|owner| owner.agent_id.clone()),
        owner_session_id: owner.and_then(|owner| owner.session_id.clone()),
    };
    mutate_records(&persisted_runs_path(), |records| {
        records.runs.insert(run_id.to_owned(), record);
    })
}

/// Drop the restart record of a workspace that was just destroyed. A failure
/// only leaves an idempotent delete for the next reaper pass.
fn forget_destroyed(run_id: &str) {
    if let Err(error) = forget_record(&persisted_runs_path(), run_id) {
        tracing::warn!(
            run_id = %run_id,
            error = %error,
            "persistent sandbox destroyed but its restart record could not be cleared"
        );
    }
}

/// Destroy the provider workspace a restart record points at. Providers treat
/// an already-deleted workspace as success.
async fn destroy_persisted_workspace(record: PersistedSandbox) -> anyhow::Result<()> {
    let backend = SandboxBackend::from_name(&record.backend)?;
    build_command_backend(&backend)?
        .destroy_workspace(&WorkspaceId(record.workspace_id))
        .await
}

/// Start [`reap_orphaned_sandboxes`] in the background when called inside a
/// Tokio runtime. Called once when Core installs the sandbox host.
pub(crate) fn spawn_orphan_reaper() {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(reap_orphaned_sandboxes());
    }
}

/// Destroy persistent workspaces recorded by Core processes that are no longer
/// running. Records whose owner is still alive, or whose delete fails, are kept
/// and retried a few times, then again on the next start. Safe to run while
/// another Core shares the ryu dir: a live owner's lease is never claimed.
pub async fn reap_orphaned_sandboxes() {
    let records = persisted_runs_path();
    let leases = leases_dir();
    let mut retry_delays = REAP_RETRY_DELAYS.iter();
    loop {
        let pending = reap_pass(
            &records,
            &leases,
            instance_id(),
            destroy_persisted_workspace,
        )
        .await;
        if pending == 0 {
            return;
        }
        let Some(delay) = retry_delays.next() else {
            tracing::warn!(
                pending,
                "persistent sandbox reaper: records still pending; retrying on the next Core start"
            );
            return;
        };
        tokio::time::sleep(*delay).await;
    }
}

/// Lease ids that have a lease file but may no longer have records.
fn lease_file_instances(leases: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(leases) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("lock") {
                return None;
            }
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .collect()
}

/// One reaper pass. Returns how many records are still pending.
async fn reap_pass<F, Fut>(records_path: &Path, leases: &Path, current: &str, destroy: F) -> usize
where
    F: Fn(PersistedSandbox) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let records = match read_records(records_path) {
        Ok(records) => records,
        Err(error) => {
            tracing::warn!(error = %error, "persistent sandbox reaper: cannot read records");
            return 0;
        }
    };
    let mut by_instance: BTreeMap<String, Vec<(String, PersistedSandbox)>> = BTreeMap::new();
    for (run_id, record) in records.runs {
        // This process's own records are live (or mid-create): never reaped here.
        if record.instance != current {
            by_instance
                .entry(record.instance.clone())
                .or_default()
                .push((run_id, record));
        }
    }
    for instance in lease_file_instances(leases) {
        if instance != current {
            by_instance.entry(instance).or_default();
        }
    }

    let mut pending = 0;
    for (instance, runs) in by_instance {
        if !is_valid_instance(&instance) {
            tracing::warn!(instance = %instance, "persistent sandbox reaper: skipping records with an invalid owner");
            continue;
        }
        // Records are written only once their owner holds its lease, so only a
        // record-less lease file can be mid-acquisition.
        if runs.is_empty() && lease_recently_created(&lease_path(leases, &instance)) {
            continue;
        }
        let lease = match try_claim_lease(leases, &instance) {
            Ok(Some(lease)) => lease,
            Ok(None) => {
                // The owning Core is still running.
                pending += runs.len();
                continue;
            }
            Err(error) => {
                tracing::warn!(instance = %instance, error = %error, "persistent sandbox reaper: cannot check owner lease");
                pending += runs.len();
                continue;
            }
        };
        let mut remaining = 0;
        for (run_id, record) in runs {
            let workspace_id = record.workspace_id.clone();
            match destroy(record).await {
                Ok(()) => match forget_record(records_path, &run_id) {
                    Ok(()) => tracing::info!(
                        run_id = %run_id,
                        workspace = %workspace_id,
                        "persistent sandbox reaper: destroyed workspace left by a previous Core"
                    ),
                    Err(error) => {
                        tracing::warn!(run_id = %run_id, error = %error, "persistent sandbox reaper: destroyed but could not clear record");
                        remaining += 1;
                    }
                },
                Err(error) => {
                    tracing::warn!(
                        run_id = %run_id,
                        workspace = %workspace_id,
                        error = %error,
                        "persistent sandbox reaper: delete failed; keeping record to retry"
                    );
                    remaining += 1;
                }
            }
        }
        if remaining == 0 {
            // Every record of the dead owner is gone; its lease file can go too.
            let _ = std::fs::remove_file(lease_path(leases, &instance));
        }
        drop(lease);
        pending += remaining;
    }
    pending
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

/// Binding carried by the Core MCP dispatcher for one persistent sandbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxOwner {
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
}

impl SandboxOwner {
    pub fn from_context(agent_id: Option<&str>, session_id: Option<&str>) -> anyhow::Result<Self> {
        let agent_id = agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let session_id = session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if agent_id.is_none() && session_id.is_none() {
            anyhow::bail!(
                "persistent sandbox operations require a bound agent or conversation session"
            );
        }
        Ok(Self {
            agent_id,
            session_id,
        })
    }
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
/// The run is billed for the shape the backend provisions from its operator
/// configuration. `spec` may restate that shape; any other shape is refused,
/// because providers provision from their own env sizing knobs and a caller
/// must not choose a billed shape that differs from the machine it gets.
/// `budget_micro_usd` is the per-run cap; `None` uses the node default.
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

/// Create a persistent workspace bound to the agent/session that will operate
/// it through the MCP plane.
pub async fn create_sandbox_owned(
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
    owner: SandboxOwner,
) -> anyhow::Result<CreatedSandbox> {
    let backend = configured_persistent_backend().await?;
    create_sandbox_with_backend_owned(&backend, spec, budget_micro_usd, Some(owner)).await
}

/// Create a persistent workspace on an explicit remote backend.
pub async fn create_sandbox_with_backend(
    backend: &SandboxBackend,
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
) -> anyhow::Result<CreatedSandbox> {
    create_sandbox_with_backend_owned(backend, spec, budget_micro_usd, None).await
}

async fn create_sandbox_with_backend_owned(
    backend: &SandboxBackend,
    spec: Option<SandboxSpec>,
    budget_micro_usd: Option<u64>,
    owner: Option<SandboxOwner>,
) -> anyhow::Result<CreatedSandbox> {
    if !matches!(backend, SandboxBackend::Box | SandboxBackend::Daytona) {
        anyhow::bail!(
            "persistent sandboxes require the 'box' or 'daytona' backend, got '{}'",
            backend.as_str()
        );
    }
    let billed = billed_spec(backend, spec)?;
    let subscription_unmetered = matches!(backend, SandboxBackend::Box)
        && box_backend::subscription_passthrough_active().await;
    let sandbox = build_command_backend(backend)?;
    reserve_live_slot()?;
    // Taken before the create request, so a provider TTL measured from its own
    // creation time never ends before the deadline computed here.
    let requested_at = Instant::now();
    // Deny-all caps (network=false) for v1; a token-missing / provider-down error
    // surfaces here as Err. The returned id is the real provider sandbox id.
    let created = if matches!(backend, SandboxBackend::Box) {
        box_backend::BoxSandbox::new()
            .create_workspace_with_lifetime(SandboxCapabilities::default())
            .await
            .map(|created| (created.workspace, created.lifetime))
    } else {
        sandbox
            .create_workspace(SandboxCapabilities::default())
            .await
            .map(|workspace| (workspace, None))
    };
    let (workspace, lifetime) = match created {
        Ok(created) => created,
        Err(error) => {
            LIVE_COUNT.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
    };
    let expires_at = lifetime.and_then(|lifetime| requested_at.checked_add(lifetime));
    let run_id = uuid::Uuid::new_v4().to_string();
    // Record the workspace before handing it out: a Core restart otherwise
    // forgets it while the provider keeps billing. An untracked workspace is
    // never returned.
    if let Err(error) = track_persistent_workspace(&run_id, &workspace, backend, owner.as_ref()) {
        if let Err(cleanup) = sandbox.destroy_workspace(&workspace).await {
            tracing::warn!(
                workspace = %workspace.0,
                error = %cleanup,
                "persistent sandbox cleanup after failed tracking failed"
            );
        }
        LIVE_COUNT.fetch_sub(1, Ordering::AcqRel);
        return Err(error.context("could not record the persistent sandbox; workspace destroyed"));
    }
    let org_id = crate::host::registered_org_id();
    let node_budget = heartbeat::default_run_budget_micro_usd().await;
    let budget = effective_budget(node_budget, budget_micro_usd);

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
            expires_at,
            metered,
            owner,
        },
    );
    if let Some(deadline) = expires_at {
        schedule_expiry(run_id.clone(), workspace.clone(), deadline);
    }

    Ok(CreatedSandbox {
        run_id,
        workspace_id: workspace.0,
        backend: backend.as_str().to_owned(),
    })
}

/// The shape a run is charged for: always the shape the backend provisions.
fn billed_spec(
    backend: &SandboxBackend,
    requested: Option<SandboxSpec>,
) -> anyhow::Result<SandboxSpec> {
    let provisioned = configured_spec(backend);
    match requested {
        Some(requested) if requested != provisioned => anyhow::bail!(
            "the '{}' backend provisions {} vCPU / {} GiB memory / {} GiB storage from operator \
             configuration; omit spec or send that shape",
            backend.as_str(),
            provisioned.vcpu,
            provisioned.mem_gib,
            provisioned.storage_gib
        ),
        _ => Ok(provisioned),
    }
}

/// Seconds a run may be charged for: from creation until `now`, but never past
/// the moment the provider destroyed its workspace.
fn billable_seconds(created_at: Instant, expires_at: Option<Instant>, now: Instant) -> u64 {
    let end = expires_at.map_or(now, |deadline| deadline.min(now));
    end.saturating_duration_since(created_at).as_secs().max(1)
}

/// Settle and forget a run when its provider TTL ends. The Box service destroys
/// an expired Box itself; without this, the heartbeat would keep charging for a
/// workspace that no longer exists until someone called destroy.
fn schedule_expiry(run_id: String, workspace: WorkspaceId, deadline: Instant) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        if let Err(error) = expire_sandbox(&run_id, &workspace).await {
            tracing::warn!(run_id = %run_id, error = %error, "expired sandbox settlement failed");
        }
    });
}

/// Remove an expired run, issue its final debit (capped at the deadline), and
/// make sure the workspace is gone. A run already destroyed is left alone.
async fn expire_sandbox(run_id: &str, workspace: &WorkspaceId) -> anyhow::Result<()> {
    let live = {
        let mut registry = lock_live();
        if registry
            .get(run_id)
            .is_some_and(|entry| &entry.workspace == workspace)
        {
            registry.remove(run_id)
        } else {
            None
        }
    };
    let Some(live) = live else {
        return Ok(());
    };
    tracing::info!(run_id = %run_id, workspace = %workspace.0, "persistent sandbox reached its provider TTL");
    settle_and_destroy(live).await
}

// Callers may tighten, but cannot disable or raise the operator cap.
fn effective_budget(node: u64, requested: Option<u64>) -> u64 {
    match (node, requested) {
        (0, requested) => requested.unwrap_or(0),
        (node, Some(requested)) if requested > 0 => node.min(requested),
        (node, _) => node,
    }
}
#[cfg(test)]
mod budget_security_tests {
    use super::effective_budget;
    #[test]
    fn caller_cannot_disable_or_raise_operator_cap() {
        assert_eq!(effective_budget(100, Some(0)), 100);
        assert_eq!(effective_budget(100, Some(1000)), 100);
        assert_eq!(effective_budget(100, Some(50)), 50);
        assert_eq!(effective_budget(100, None), 100);
        assert_eq!(effective_budget(0, Some(50)), 50);
        assert_eq!(effective_budget(0, None), 0);
    }
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
    exec_in_sandbox_internal(run_id, command, args, timeout_secs, None).await
}

/// Execute a persistent sandbox command only for the creator binding.
pub async fn exec_in_sandbox_owned(
    run_id: &str,
    command: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
    owner: &SandboxOwner,
) -> anyhow::Result<SandboxExecResult> {
    exec_in_sandbox_internal(run_id, command, args, timeout_secs, Some(owner)).await
}

async fn exec_in_sandbox_internal(
    run_id: &str,
    command: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
    owner: Option<&SandboxOwner>,
) -> anyhow::Result<SandboxExecResult> {
    // Clone the workspace id out under the guard, then drop it before the I/O.
    let live = {
        lock_live().get(run_id).and_then(|live| {
            if live.owner.as_ref() == owner {
                Some((live.workspace.clone(), live.backend.clone()))
            } else {
                None
            }
        })
    };
    let Some((ws, backend)) = live else {
        anyhow::bail!("sandbox run is unknown or owned by another agent/session: {run_id}");
    };
    // A budget, balance, or accounting kill is terminal even while its provider
    // stop is still being retried: nothing more runs on the caller's behalf.
    if heartbeat::run_is_terminal(run_id) {
        anyhow::bail!("sandbox run was stopped by metering: {run_id}");
    }

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
/// Idempotent — a `run_id` with neither a live entry nor a restart record
/// (already destroyed) returns `Ok(())`. A run a previous Core process created
/// is destroyed from its restart record, without a final debit. The remote
/// workspace is always destroyed, but a billable final-debit failure is
/// returned after the destroy so callers cannot mistake an unaccounted
/// execution for success.
pub async fn destroy_sandbox(run_id: &str) -> anyhow::Result<()> {
    destroy_sandbox_internal(run_id, None).await
}

/// Destroy a persistent sandbox only for the creator binding.
pub async fn destroy_sandbox_owned(run_id: &str, owner: &SandboxOwner) -> anyhow::Result<()> {
    destroy_sandbox_internal(run_id, Some(owner)).await
}

async fn destroy_sandbox_internal(
    run_id: &str,
    owner: Option<&SandboxOwner>,
) -> anyhow::Result<()> {
    // Remove from the live registry first (idempotent).
    let live = {
        let mut registry = lock_live();
        if registry
            .get(run_id)
            .is_some_and(|entry| entry.owner.as_ref() != owner)
        {
            anyhow::bail!("sandbox run is owned by another agent/session: {run_id}");
        }
        registry.remove(run_id)
    };
    let Some(live) = live else {
        // Not live here: already destroyed, or created by a previous Core whose
        // workspace may still be billing. Only a missing record is success.
        return destroy_persisted_sandbox(run_id, owner).await;
    };
    settle_and_destroy(live).await
}

/// Release a run already removed from the live registry: issue its final tail
/// debit and destroy the remote workspace.
async fn settle_and_destroy(live: LiveSandbox) -> anyhow::Result<()> {
    let run_id = live.run_id.as_str();
    LIVE_COUNT.fetch_sub(1, Ordering::AcqRel);

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
    let mut debit_sent = false;
    if let (Some(r), Some(org)) = (residual, live.org_id.clone()) {
        debit_sent = true;
        let measured = billable_seconds(live.created_at, live.expires_at, Instant::now());
        let remainder = measured.saturating_sub(r.ticked_seconds);
        if let Err(error) = heartbeat::debit_final(
            live.run_id.clone(),
            Some(org),
            live.spec.clone(),
            remainder,
            live.budget_micro_usd,
            r,
        )
        .await
        {
            metering_error = Some(error);
        }
    }

    // Idempotent (remote provider 404s are treated as success by the backend).
    // On failure the restart record stays, so a retried destroy still finds it.
    build_command_backend(&live.backend)?
        .destroy_workspace(&live.workspace)
        .await?;
    forget_destroyed(run_id);
    if live.metered && !debit_sent {
        // `debit_final` already sent the Gateway completion; otherwise (no
        // owning org, or a run already killed by metering) send it now that the
        // workspace is confirmed gone.
        heartbeat::complete_run(run_id).await;
    }
    if let Some(error) = metering_error {
        anyhow::bail!("sandbox destroyed but final billing failed: {error}");
    }
    Ok(())
}

/// Destroy a run that is not live in this process from its restart record.
/// Metering for it ended with the process that created it, so there is no
/// final debit here.
async fn destroy_persisted_sandbox(
    run_id: &str,
    owner: Option<&SandboxOwner>,
) -> anyhow::Result<()> {
    let records = read_records(&persisted_runs_path())?;
    let Some(record) = records.runs.get(run_id) else {
        return Ok(());
    };
    if record.owner().as_ref() != owner {
        anyhow::bail!("sandbox run is owned by another agent/session: {run_id}");
    }
    destroy_persisted_workspace(record.clone()).await?;
    forget_destroyed(run_id);
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
    fn exec_is_refused_once_metering_killed_the_run_even_if_the_stop_failed() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build runtime");
        let run_id = format!("session_test_killed_{}", uuid::Uuid::new_v4().simple());
        let workspace = WorkspaceId("still-live-provider-workspace".to_owned());
        let spec = configured_spec(&SandboxBackend::Daytona);
        heartbeat::register(
            run_id.clone(),
            Some("org_1".to_owned()),
            "daytona",
            workspace.clone(),
            spec.clone(),
            100,
        );
        lock_live().insert(
            run_id.clone(),
            LiveSandbox {
                run_id: run_id.clone(),
                workspace,
                backend: SandboxBackend::Daytona,
                org_id: Some("org_1".to_owned()),
                spec,
                budget_micro_usd: 100,
                created_at: Instant::now(),
                expires_at: None,
                metered: true,
                owner: None,
            },
        );
        // kill_budget was returned and the first provider DELETE failed.
        heartbeat::mark_kill_pending_for_test(&run_id, heartbeat::KillReason::Budget, 120);
        rt.block_on(async {
            let err = exec_in_sandbox(&run_id, "echo".to_owned(), vec!["hi".to_owned()], None)
                .await
                .expect_err("a run past its cap must not execute");
            assert!(err.to_string().contains("stopped by metering"), "{err}");
        });
        lock_live().remove(&run_id);
        assert!(heartbeat::deregister_for_final_debit(&run_id).is_none());
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
            let message = err.to_string();
            assert!(message.contains("sandbox run is unknown"), "{message}");
            assert!(message.contains(&run_id), "{message}");
        });
    }

    #[test]
    fn persistent_mcp_owner_requires_agent_or_session_binding() {
        assert!(SandboxOwner::from_context(None, None).is_err());
        let owner =
            SandboxOwner::from_context(Some("agent-a"), Some("session-1")).expect("bound owner");
        assert_ne!(
            owner,
            SandboxOwner::from_context(Some("agent-b"), Some("session-1")).unwrap()
        );
    }

    fn record(workspace_id: &str, backend: &str, instance: &str) -> PersistedSandbox {
        PersistedSandbox {
            workspace_id: workspace_id.to_owned(),
            backend: backend.to_owned(),
            instance: instance.to_owned(),
            owner_agent_id: None,
            owner_session_id: None,
        }
    }

    #[test]
    fn destroy_after_restart_acts_on_the_persisted_record() {
        // A record written by a previous process, with nothing in the live
        // registry: exactly the state a restarted Core sees.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build runtime");
        let run_id = format!("session_test_restart_{}", uuid::Uuid::new_v4().simple());
        let path = persisted_runs_path();
        let mut orphan = record("ws_restart", "not-a-backend", "deadprocess");
        orphan.owner_agent_id = Some("agent-a".to_owned());
        mutate_records(&path, |records| {
            records.runs.insert(run_id.clone(), orphan);
        })
        .expect("write restart record");
        assert!(!lock_live().contains_key(&run_id));

        rt.block_on(async {
            let other = SandboxOwner::from_context(Some("agent-b"), None).unwrap();
            let error = destroy_sandbox_owned(&run_id, &other)
                .await
                .expect_err("another owner cannot destroy the run");
            assert!(error.to_string().contains("owned by another"), "{error}");

            let owner = SandboxOwner::from_context(Some("agent-a"), None).unwrap();
            assert!(
                destroy_sandbox_owned(&run_id, &owner).await.is_err(),
                "a workspace that could not be deleted is not reported destroyed"
            );
        });
        assert!(
            read_records(&path).unwrap().runs.contains_key(&run_id),
            "a failed delete keeps the record for a retry"
        );

        forget_record(&path, &run_id).expect("clear record");
        rt.block_on(async {
            assert!(destroy_sandbox(&run_id).await.is_ok());
        });
    }

    #[test]
    fn corrupt_records_are_never_overwritten() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(PERSISTED_RUNS_FILE);
        std::fs::write(&path, "{not-json").unwrap();
        let result = mutate_records(&path, |records| {
            records
                .runs
                .insert("run".to_owned(), record("ws", "box", "me"));
        });
        assert!(
            result.is_err(),
            "a create must fail rather than go untracked"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not-json");
    }

    #[tokio::test]
    async fn reaper_destroys_only_dead_owners_and_keeps_failed_deletes() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().expect("temp dir");
        let records_path = dir.path().join(PERSISTED_RUNS_FILE);
        let leases = dir.path().join(LEASES_DIR);
        mutate_records(&records_path, |records| {
            records
                .runs
                .insert("dead-ok".to_owned(), record("ws-dead-ok", "box", "dead1"));
            records.runs.insert(
                "dead-fail".to_owned(),
                record("ws-dead-fail", "box", "dead1"),
            );
            records
                .runs
                .insert("alive".to_owned(), record("ws-alive", "box", "alive1"));
            records
                .runs
                .insert("mine".to_owned(), record("ws-mine", "box", "me"));
        })
        .expect("seed records");
        // A running Core holds its lease; a stale lease file with no records is
        // left by a Core that exited cleanly. A fresh record-less lease file may
        // belong to a Core about to lock it for its first workspace.
        let alive_lease = try_claim_lease(&leases, "alive1")
            .unwrap()
            .expect("claim live lease");
        let stale = try_claim_lease(&leases, "stale1")
            .unwrap()
            .expect("claim stale lease");
        stale
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
            .expect("backdate stale lease");
        drop(stale);
        drop(try_claim_lease(&leases, "fresh1").unwrap());

        let destroyed = Arc::new(Mutex::new(Vec::new()));
        let fail_workspace = Arc::new(Mutex::new(Some("ws-dead-fail".to_owned())));
        let destroy = |record: PersistedSandbox| {
            let destroyed = Arc::clone(&destroyed);
            let fail_workspace = Arc::clone(&fail_workspace);
            async move {
                let fail = fail_workspace.lock().unwrap().as_deref() == Some(&record.workspace_id);
                destroyed.lock().unwrap().push(record.workspace_id.clone());
                if fail {
                    anyhow::bail!("provider unavailable");
                }
                Ok(())
            }
        };

        let pending = reap_pass(&records_path, &leases, "me", destroy).await;
        assert_eq!(pending, 2, "the failed delete and the live owner's record");
        let mut attempted = destroyed.lock().unwrap().clone();
        attempted.sort();
        assert_eq!(attempted, vec!["ws-dead-fail", "ws-dead-ok"]);
        let remaining: Vec<String> = read_records(&records_path)
            .unwrap()
            .runs
            .into_keys()
            .collect();
        assert_eq!(remaining, vec!["alive", "dead-fail", "mine"]);
        assert!(
            lease_path(&leases, "dead1").exists(),
            "kept while records remain"
        );
        assert!(!lease_path(&leases, "stale1").exists());
        assert!(
            lease_path(&leases, "fresh1").exists(),
            "a lease file that may be mid-acquisition is left alone"
        );

        // The provider recovers and the other Core exits.
        *fail_workspace.lock().unwrap() = None;
        drop(alive_lease);
        destroyed.lock().unwrap().clear();
        let pending = reap_pass(&records_path, &leases, "me", destroy).await;
        assert_eq!(pending, 0);
        let remaining: Vec<String> = read_records(&records_path)
            .unwrap()
            .runs
            .into_keys()
            .collect();
        assert_eq!(
            remaining,
            vec!["mine"],
            "this process's records are never reaped"
        );
        assert!(!lease_path(&leases, "dead1").exists());
        assert!(!lease_path(&leases, "alive1").exists());
        assert!(lease_path(&leases, "fresh1").exists());
    }

    #[test]
    fn billing_uses_the_provisioned_shape_not_a_caller_spec() {
        let provisioned = configured_spec(&SandboxBackend::Daytona);
        assert_eq!(
            billed_spec(&SandboxBackend::Daytona, None).expect("default shape"),
            provisioned
        );
        assert_eq!(
            billed_spec(&SandboxBackend::Daytona, Some(provisioned.clone()))
                .expect("restated shape"),
            provisioned
        );
        let free = SandboxSpec {
            vcpu: 0,
            mem_gib: 0,
            storage_gib: 0,
            ..provisioned.clone()
        };
        let error = billed_spec(&SandboxBackend::Daytona, Some(free))
            .expect_err("a zero-cost spec must not replace the provisioned shape");
        assert!(error.to_string().contains("omit spec"), "{error}");
        let larger = SandboxSpec {
            vcpu: provisioned.vcpu + 8,
            ..provisioned
        };
        assert!(billed_spec(&SandboxBackend::Daytona, Some(larger)).is_err());
    }

    #[test]
    fn billable_seconds_stop_at_the_provider_deadline() {
        let created = Instant::now();
        let later = created + std::time::Duration::from_secs(72 * 3600);
        let ttl = created + std::time::Duration::from_secs(24 * 3600);
        assert_eq!(billable_seconds(created, None, later), 72 * 3600);
        assert_eq!(billable_seconds(created, Some(ttl), later), 24 * 3600);
        let early = created + std::time::Duration::from_secs(30);
        assert_eq!(billable_seconds(created, Some(ttl), early), 30);
        assert_eq!(billable_seconds(created, Some(ttl), created), 1);
    }

    #[test]
    fn expiry_releases_only_the_run_that_owns_the_workspace() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build runtime");
        let run_id = format!("session_test_expiry_{}", std::process::id());
        let workspace = WorkspaceId("ws_expiry_test".to_owned());
        reserve_live_slot().expect("live slot");
        lock_live().insert(
            run_id.clone(),
            LiveSandbox {
                run_id: run_id.clone(),
                workspace: workspace.clone(),
                // The local backend never calls a remote provider, so the test
                // stays hermetic even where provider credentials are set.
                backend: SandboxBackend::Local,
                org_id: None,
                spec: SandboxSpec::default(),
                budget_micro_usd: 0,
                created_at: Instant::now(),
                expires_at: Some(Instant::now()),
                metered: false,
                owner: None,
            },
        );
        rt.block_on(async {
            let other = WorkspaceId("ws_other".to_owned());
            assert!(expire_sandbox(&run_id, &other).await.is_ok());
            assert!(lock_live().contains_key(&run_id));
            // The local backend refuses this id, so the destroy fails; the run
            // must still leave the registry so it is never metered again.
            assert!(expire_sandbox(&run_id, &workspace).await.is_err());
            assert!(!lock_live().contains_key(&run_id));
            assert!(expire_sandbox(&run_id, &workspace).await.is_ok());
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
                expires_at: None,
                metered: true,
                owner: None,
            },
        );
        assert!(lock_live().contains_key(&run_id));
        let removed = lock_live().remove(&run_id);
        assert!(removed.is_some());
        assert!(!lock_live().contains_key(&run_id));
    }
}

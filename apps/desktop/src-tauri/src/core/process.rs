//! Managed child process for the Ryu Core sidecar.
//!
//! Handles spawning, stdio forwarding, graceful shutdown (SIGTERM → SIGKILL),
//! and a PID file for orphan recovery across restarts.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid as SysinfoPid, ProcessStatus, System};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::win_process::NoWindow;

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(_command: &mut Command) {}

// ── Paths ──────────────────────────────────────────────────────────────────────

fn pid_path() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::profile::ryu_home_dir(), "ryu-core.pid")
}

const PID_RECORD_VERSION: u8 = 1;
const CORE_LOG_PATH_ENV: &str = "RYU_CORE_LOG_PATH";

fn preserve_core_on_exit(debug_build: bool, profile: &str) -> bool {
    debug_build && profile == "dev"
}

pub(crate) fn preserve_desktop_core_on_exit() -> bool {
    preserve_core_on_exit(cfg!(debug_assertions), &crate::profile::name())
}

fn persistent_core_log_path(home: &std::path::Path) -> PathBuf {
    ryu_sidecar_runtime::layout::logs_dir(home).join("core-dev-runtime.log")
}

/// `<data dir>/runtimes/dev-execution` — Core's independent development
/// execution host (its binary copy and `worker.json` receipt).
pub(crate) fn dev_execution_dir(home: &std::path::Path) -> PathBuf {
    ryu_sidecar_runtime::layout::runtime_dir(home, "dev-execution")
}

/// PID files must bind a PID to the process that Desktop actually started. A
/// bare integer is unsafe after a crash because operating systems reuse PIDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ManagedPidRecord {
    version: u8,
    pid: u32,
    executable: String,
    start_time: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_group: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    executable: String,
    start_time: u64,
}

/// Wire contract written by Core's independent development execution host.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExecutionWorkerRecord {
    version: u32,
    pid: u32,
    executable: PathBuf,
    start_time: u64,
    private_bind: std::net::SocketAddr,
    data_dir: PathBuf,
    public_bind: std::net::SocketAddr,
}

struct ExecutionHostStop {
    command: std::process::Command,
    record: ExecutionWorkerRecord,
}

const MAX_EXECUTION_RECORD_BYTES: u64 = 16 * 1024;

fn execution_host_identity(record: &ExecutionWorkerRecord) -> Result<Option<ProcessIdentity>> {
    let system = System::new_all();
    let Some(process) = system.process(SysinfoPid::from_u32(record.pid)) else {
        return Ok(None);
    };
    anyhow::ensure!(
        process.start_time() != 0,
        "Cannot verify execution host start time"
    );
    if process.start_time() != record.start_time {
        // PID reuse is a stale receipt, not permission to signal its new owner.
        return Ok(None);
    }
    let executable = process
        .exe()
        .ok_or_else(|| anyhow!("Cannot inspect live execution host executable"))?;
    let actual = std::fs::canonicalize(executable)?;
    let expected = std::fs::canonicalize(&record.executable)?;
    if actual != expected {
        return Ok(None);
    }
    Ok(Some(ProcessIdentity {
        pid: record.pid,
        executable: actual.to_string_lossy().into_owned(),
        start_time: process.start_time(),
    }))
}

fn execution_host_stop_command(
    home: &std::path::Path,
    profile: &str,
) -> Result<Option<ExecutionHostStop>> {
    use std::io::Read;
    let path = dev_execution_dir(home).join("worker.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        metadata.file_type().is_file() && metadata.len() <= MAX_EXECUTION_RECORD_BYTES,
        "Execution host receipt must be a bounded regular file"
    );
    let file = std::fs::File::open(&path)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "Execution host receipt is not a regular file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_EXECUTION_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_EXECUTION_RECORD_BYTES,
        "Execution host receipt is too large"
    );
    let record: ExecutionWorkerRecord = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        record.version == 1
            && record.pid != 0
            && record.start_time != 0
            && record.private_bind.ip().is_loopback()
            && record.private_bind.port() != 0
            && record.public_bind.ip().is_loopback()
            && record.public_bind.port() != 0,
        "Invalid execution host receipt"
    );
    let canonical_home = std::fs::canonicalize(home)?;
    anyhow::ensure!(
        std::fs::canonicalize(&record.data_dir)? == canonical_home,
        "Execution host receipt belongs to another data directory"
    );
    // Check whether this PID is still its recorded owner before requiring the
    // immutable executable to exist. Dead hosts can leave removed binaries.
    let Some(identity) = execution_host_identity(&record)? else {
        return Ok(None);
    };
    let executable = PathBuf::from(identity.executable);
    anyhow::ensure!(
        executable.starts_with(dev_execution_dir(&canonical_home)),
        "Execution host executable is outside its data directory"
    );
    let mut command = std::process::Command::new(executable);
    command
        .arg("--stop-dev-execution")
        .arg(format!("--bind={}", record.public_bind))
        .env("RYU_DIR", canonical_home)
        .env(crate::profile::RYU_PROFILE_ENV, profile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window();
    Ok(Some(ExecutionHostStop { command, record }))
}

fn execute_host_stop(mut stop: ExecutionHostStop, timeout: Duration) -> Result<()> {
    let mut child = stop.command.spawn()?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("Development execution host shutdown timed out"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    anyhow::ensure!(
        status.success(),
        "Could not stop development execution host: {status}"
    );
    anyhow::ensure!(
        execution_host_identity(&stop.record)?.is_none(),
        "Development execution host is still alive after shutdown"
    );
    Ok(())
}

impl ManagedPidRecord {
    fn from_identity(identity: ProcessIdentity) -> Self {
        Self {
            version: PID_RECORD_VERSION,
            pid: identity.pid,
            executable: identity.executable,
            start_time: identity.start_time,
            #[cfg(unix)]
            process_group: i32::try_from(identity.pid).ok(),
            #[cfg(not(unix))]
            process_group: None,
        }
    }

    fn matches(&self, identity: &ProcessIdentity) -> bool {
        self.version == PID_RECORD_VERSION
            && self.pid == identity.pid
            && self.executable == identity.executable
            && self.start_time == identity.start_time
    }
}

fn inspect_process(pid: u32) -> Option<ProcessIdentity> {
    let system = System::new_all();
    let process = system.process(SysinfoPid::from_u32(pid))?;
    let executable = process.exe()?.to_string_lossy().into_owned();
    if executable.is_empty() || process.start_time() == 0 {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        executable,
        start_time: process.start_time(),
    })
}

fn kill_facade_process(record: &ManagedPidRecord) -> Result<()> {
    let system = System::new_all();
    let Some(process) = system.process(SysinfoPid::from_u32(record.pid)) else {
        return Ok(());
    };
    if process.status() == ProcessStatus::Zombie {
        return Ok(());
    }
    let executable = process
        .exe()
        .ok_or_else(|| anyhow!("Cannot inspect development facade before stop"))?;
    if !record.matches(&ProcessIdentity {
        pid: record.pid,
        executable: executable.to_string_lossy().into_owned(),
        start_time: process.start_time(),
    }) {
        return Ok(());
    }
    // Windows taskkill /T follows parentage even for a detached worker. Stop
    // only the facade; its immutable host owns the verified tree shutdown.
    anyhow::ensure!(process.kill(), "Could not stop verified development facade");
    Ok(())
}

async fn inspect_spawned_process(pid: u32) -> Option<ProcessIdentity> {
    // A freshly-spawned process can take a scheduler tick to appear in the OS
    // process table. Bound the wait; inability to establish identity fails closed
    // and the caller terminates the child rather than writing an unsafe PID file.
    for _ in 0..20 {
        if let Some(identity) = inspect_process(pid) {
            return Some(identity);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None
}

/// Resolve the Sentry DSN to hand the Core sidecar: an explicit runtime
/// `SENTRY_DSN` wins (dev shells, self-hosters), else the value baked into this
/// build via `option_env!` (packaged releases set `SENTRY_DSN` at `cargo build`
/// time). `None` leaves Core's crash tier a graceful no-op.
fn sentry_dsn() -> Option<String> {
    std::env::var("SENTRY_DSN")
        .ok()
        .or_else(|| option_env!("SENTRY_DSN").map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── ProcessState ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessState {
    Starting,
    Running,
    Stopping,
    Stopped,
}

// ── RyuCoreProcess ─────────────────────────────────────────────────────────────

pub struct RyuCoreProcess {
    child: Option<Child>,
    binary_path: PathBuf,
    pid_path: PathBuf,
    state: ProcessState,
    /// Handles for stdout/stderr forwarding tasks.
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
    preserve_on_exit: bool,
    recovery_admission: Option<ryu_runtime_install::startup::StartupAdmission>,
}

impl RyuCoreProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            child: None,
            binary_path,
            pid_path: pid_path(),
            state: ProcessState::Stopped,
            log_tasks: Vec::new(),
            preserve_on_exit: preserve_desktop_core_on_exit(),
            recovery_admission: None,
        }
    }

    pub fn new_for_app(app: &tauri::AppHandle, binary_path: PathBuf) -> Self {
        use tauri::Manager;
        let mut process = Self::new(binary_path);
        process.recovery_admission = app
            .try_state::<crate::update_recovery::UpdateStartupState>()
            .and_then(|state| state.admission.clone());
        process
    }

    /// Check if Ryu Core is already running by hitting the health endpoint.
    pub async fn is_already_running(&self) -> bool {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        match client
            .get(format!("{}/api/health", crate::profile::core_base_url()))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => true,
            _ => false,
        }
    }

    /// Spawn the Ryu Core binary and begin forwarding its stdio to tracing.
    /// First checks if an instance is already running on THIS PROFILE's Core port
    /// (`profile::core_port()` — 7980 release, 9980 canary). Never a literal: a
    /// canary desktop that probed 7980 would find the stable Core, adopt it, and
    /// drive `~/.ryu` while believing it was isolated.
    pub async fn start(&mut self) -> Result<()> {
        // Check if already running
        if self.is_already_running().await {
            tracing::info!("Ryu Core already running, connecting to existing instance");
            self.state = ProcessState::Running;
            return Ok(());
        }

        // A retained local dev runtime may be warming up or temporarily busy.
        // Failed health is not permission to interrupt its active turns.
        if self.attach_preserved_core() {
            return Ok(());
        }

        self.cleanup_orphan().await;
        self.state = ProcessState::Starting;

        let mut command = Command::new(&self.binary_path);
        // Core and everything it launches get the user's own GPU environment,
        // not the switches the desktop set for its webviews.
        for (name, original) in crate::hardware_acceleration::restore_child_env() {
            match original {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            // Core is a console binary; without CREATE_NO_WINDOW it opens a
            // command-prompt window that stays up for the whole app session.
            // Piping stdio does NOT suppress it — only the creation flag does.
            .no_window();
        configure_process_group(&mut command);
        if let Some(admission) = &self.recovery_admission {
            let checkpoint = ryu_runtime_install::recovery::RecoveryCheckpoint::observe(
                admission.checkpoint.clone(),
            )?;
            match checkpoint.read()?.phase {
                ryu_runtime_install::recovery::RecoveryPhase::AwaitingHealth => {
                    command.env("RYU_UPDATE_RUNTIME_NONCE", &admission.nonce);
                }
                ryu_runtime_install::recovery::RecoveryPhase::Committed
                | ryu_runtime_install::recovery::RecoveryPhase::Restored => {
                    self.recovery_admission = None;
                }
                _ => return Err(anyhow!("update recovery has not admitted runtime startup")),
            }
        }
        // Pin both processes to the same published release generation. Explicit
        // operator overrides remain authoritative.
        if std::env::var_os("RYU_GATEWAY_BIN").is_none() {
            if let Some(gateway) = crate::core::install::managed_gateway_path() {
                command.env("RYU_GATEWAY_BIN", gateway);
            }
        }
        if let Some(directory) = self.binary_path.parent() {
            let paths = std::iter::once(directory.to_path_buf()).chain(
                std::env::var_os("PATH")
                    .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                    .unwrap_or_default(),
            );
            command.env("PATH", std::env::join_paths(paths)?);
        }
        // A local dev Desktop is replaceable while Core keeps executing turns.
        // Its child must not retain pipes whose readers disappear on reload.
        if self.preserve_on_exit {
            // The PID record lives in `state/`, so derive the log from the
            // data dir itself rather than from the PID file's parent.
            let home = crate::profile::ryu_home_dir();
            command
                .env(CORE_LOG_PATH_ENV, persistent_core_log_path(&home))
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        // Isolate the dev variant's backend: hand the Core child our profile so it
        // binds the shifted port (8980) and uses the shifted data dir (~/.ryu-dev)
        // via its own `profile::apply_env_defaults`. Release passes nothing new
        // ("release" is byte-identical to unset), so the release path is untouched.
        if crate::profile::is_dev() {
            command.env(crate::profile::RYU_PROFILE_ENV, crate::profile::name());
        }
        // Crash reporting: hand the Sentry DSN to the Core sidecar so its (and the
        // gateway's, via Core's spawn-env forwarding) panic tier has a destination.
        // Core reads SENTRY_DSN from env and stays a graceful no-op without it; the
        // desktop `crash-reports-enabled` consent still gates capture inside Core.
        if let Some(dsn) = sentry_dsn() {
            command.env("SENTRY_DSN", dsn);
        }
        let child = command.spawn()?;
        self.own_spawned_child(child).await
    }

    fn attach_preserved_core(&mut self) -> bool {
        if !self.preserve_on_exit {
            return false;
        }
        let record = std::fs::read_to_string(&self.pid_path)
            .ok()
            .and_then(|content| serde_json::from_str::<ManagedPidRecord>(&content).ok());
        let Some(record) = record else {
            return false;
        };
        if !inspect_process(record.pid).is_some_and(|identity| record.matches(&identity)) {
            return false;
        }
        self.state = ProcessState::Running;
        tracing::warn!(
            pid = record.pid,
            "Retained dev Core is alive but temporarily unhealthy; preserving its active turns"
        );
        true
    }

    /// Persist the child's verified identity before publishing it as managed.
    /// Every failure path terminates the just-spawned process group.
    async fn own_spawned_child(&mut self, mut child: Child) -> Result<()> {
        let persisted = async {
            let pid = child
                .id()
                .ok_or_else(|| anyhow!("ryu-core spawned without a process id"))?;
            let identity = inspect_spawned_process(pid)
                .await
                .ok_or_else(|| anyhow!("could not verify the spawned ryu-core process identity"))?;
            self.persist_pid_record(ManagedPidRecord::from_identity(identity))
                .await
        }
        .await;
        if let Err(error) = persisted {
            terminate_child_async(&mut child, Duration::from_millis(500)).await;
            self.state = ProcessState::Stopped;
            return Err(error);
        }

        // Forward stdout → tracing::info
        if let Some(stdout) = child.stdout.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "ryu-core", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        // Forward stderr → tracing::warn
        if let Some(stderr) = child.stderr.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "ryu-core", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        self.child = Some(child);
        self.state = ProcessState::Running;
        Ok(())
    }

    async fn persist_pid_record(&self, record: ManagedPidRecord) -> Result<()> {
        let parent = self
            .pid_path
            .parent()
            .ok_or_else(|| anyhow!("ryu-core PID path has no parent"))?;
        tokio::fs::create_dir_all(parent).await?;
        let bytes = serde_json::to_vec(&record)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        use std::io::Write as _;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.pid_path)
            .map_err(|error| error.error)?;
        Ok(())
    }

    /// Gracefully stop the process: SIGTERM → 5 s wait → SIGKILL.
    pub async fn stop(&mut self) -> Result<()> {
        if self.preserve_on_exit {
            // Quiesce our verified launcher before the final receipt read: it
            // must not publish a new detached worker after an absent read.
            if let Some(child) = self.child.as_mut() {
                child.start_kill()?;
                tokio::time::timeout(Duration::from_secs(2), child.wait()).await??;
            } else if let Some(record) = self.verified_facade_record()? {
                kill_facade_process(&record)?;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                while self.verified_facade_record()?.is_some()
                    && tokio::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                anyhow::ensure!(
                    self.verified_facade_record()?.is_none(),
                    "Verified development facade did not stop"
                );
            }
        }
        self.stop_dev_execution_host().await?;
        self.state = ProcessState::Stopping;

        // Abort log forwarding tasks first.
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }

        if let Some(child) = self.child.as_mut() {
            terminate_child_async(child, Duration::from_secs(5)).await;
        }

        // Always sweep orphans: PID file (if we ever wrote one) AND whoever is
        // still listening on this profile's Core/gateway ports. Turbo-owned Core
        // in dev never gets a PID file from us, so port kill is what makes
        // restart/reset actually stop the process that holds the data-dir locks.
        self.cleanup_orphan().await;
        if !self.preserve_on_exit {
            kill_profile_listeners().await;
        }

        let _ = tokio::fs::remove_file(&self.pid_path).await;
        self.state = ProcessState::Stopped;
        self.child = None;
        Ok(())
    }

    /// Synchronous stop for use in non-async contexts (window destroy, app exit).
    /// Gives the whole managed process group a bounded graceful shutdown before a
    /// final kill, so Gateway/plugin children cannot outlive Desktop Quit.
    pub fn try_stop(&mut self) -> Result<()> {
        if self.preserve_on_exit {
            if let Some(child) = self.child.as_mut() {
                child.start_kill()?;
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while child.try_wait()?.is_none() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                anyhow::ensure!(
                    child.try_wait()?.is_some(),
                    "Owned development facade did not stop"
                );
            } else if let Some(record) = self.verified_facade_record()? {
                kill_facade_process(&record)?;
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while self.verified_facade_record()?.is_some()
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                anyhow::ensure!(
                    self.verified_facade_record()?.is_none(),
                    "Verified development facade did not stop"
                );
            }
        }
        self.stop_dev_execution_host_sync()?;
        // Abort log forwarding tasks
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }

        // Stop the process group if we have a handle.
        if let Some(ref mut child) = self.child {
            terminate_child_sync(child, Duration::from_secs(2));
        } else {
            // A prior crash may have dropped the in-memory handle. Only terminate
            // the PID-file process when executable + start time still match.
            self.cleanup_orphan_sync();
        }

        // Clean up PID file synchronously
        let _ = std::fs::remove_file(&self.pid_path);

        self.state = ProcessState::Stopped;
        self.child = None;
        Ok(())
    }

    fn verified_facade_record(&self) -> Result<Option<ManagedPidRecord>> {
        let content = match std::fs::read(&self.pid_path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let Ok(record) = serde_json::from_slice::<ManagedPidRecord>(&content) else {
            return Ok(None);
        };
        let system = System::new_all();
        let Some(process) = system.process(SysinfoPid::from_u32(record.pid)) else {
            return Ok(None);
        };
        // A killed but unreaped facade is a zombie: it has exited, and Linux no
        // longer exposes its executable, so it cannot be (and need not be) verified.
        if process.status() == ProcessStatus::Zombie {
            return Ok(None);
        }
        anyhow::ensure!(
            process.start_time() != 0,
            "Cannot verify development facade start time"
        );
        if process.start_time() != record.start_time {
            return Ok(None);
        }
        let executable = process
            .exe()
            .ok_or_else(|| anyhow!("Cannot inspect live development facade executable"))?;
        Ok(record
            .matches(&ProcessIdentity {
                pid: record.pid,
                executable: executable.to_string_lossy().into_owned(),
                start_time: process.start_time(),
            })
            .then_some(record))
    }

    fn dev_execution_stop_command(&self) -> Result<Option<ExecutionHostStop>> {
        if !self.preserve_on_exit {
            return Ok(None);
        }
        // Resolve Core relocation using the shared path contract. Discovery must
        // never execute an older Core that ignores unknown CLI arguments.
        let profile = crate::profile::name();
        let paths = ryu_runtime_install::data_paths::DataPaths::for_profile(
            &profile,
            dirs::home_dir(),
            dirs::config_dir(),
        )?;
        let home = paths.resolve_data_dir(std::env::var_os("RYU_DIR"))?;
        execution_host_stop_command(&home, &profile)
    }

    async fn stop_dev_execution_host(&self) -> Result<()> {
        let Some(stop) = self.dev_execution_stop_command()? else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || execute_host_stop(stop, Duration::from_secs(30)))
            .await?
    }

    fn stop_dev_execution_host_sync(&self) -> Result<()> {
        let Some(stop) = self.dev_execution_stop_command()? else {
            return Ok(());
        };
        execute_host_stop(stop, Duration::from_secs(30))
    }

    /// Local development reloads replace Desktop, not the running Core. Keep
    /// the verified PID record so the next Desktop can attach and explicit
    /// restart/reset can still terminate the runtime. Packaged builds retain
    /// their normal shutdown behavior, including packaged Ryu Dev.
    pub fn exit_desktop(&mut self) -> Result<()> {
        if !self.preserve_on_exit {
            return self.try_stop();
        }
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }
        self.child = None;
        self.state = ProcessState::Stopped;
        tracing::info!("Desktop dev reload detached; Ryu Core continues running");
        Ok(())
    }

    pub async fn restart(&mut self) -> Result<()> {
        self.stop().await?;
        self.start().await
    }

    /// Returns true if the child process is still alive.
    pub fn is_running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                self.state = ProcessState::Stopped;
                self.child = None;
                false
            }
        }
    }

    /// Non-blocking exit check.
    pub fn poll_exit(&mut self) -> Option<std::process::ExitStatus> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                self.state = ProcessState::Stopped;
                self.child = None;
                Some(status)
            }
            _ => None,
        }
    }

    /// Returns `true` if a live child process handle is currently held.
    pub fn has_child(&self) -> bool {
        self.child.is_some()
    }

    pub(crate) fn owns_process(&self) -> bool {
        if self.has_child() {
            return true;
        }
        let record = std::fs::read_to_string(&self.pid_path)
            .ok()
            .and_then(|content| serde_json::from_str::<ManagedPidRecord>(&content).ok());
        record.is_some_and(|record| {
            inspect_process(record.pid).is_some_and(|identity| record.matches(&identity))
        })
    }

    /// Kill an owned leftover process whose full identity is recorded in the PID
    /// file. Invalid/legacy records and PID-reuse mismatches are removed without
    /// signaling anything.
    pub async fn cleanup_orphan(&self) {
        let Ok(content) = tokio::fs::read_to_string(&self.pid_path).await else {
            return;
        };
        let Ok(record) = serde_json::from_str::<ManagedPidRecord>(&content) else {
            tracing::warn!(
                path = %self.pid_path.display(),
                "ignoring unsafe legacy or corrupt ryu-core PID record"
            );
            let _ = tokio::fs::remove_file(&self.pid_path).await;
            return;
        };
        let Some(identity) = inspect_process(record.pid) else {
            let _ = tokio::fs::remove_file(&self.pid_path).await;
            return;
        };
        if !record.matches(&identity) {
            tracing::warn!(
                pid = record.pid,
                expected_executable = %record.executable,
                actual_executable = %identity.executable,
                "refusing to terminate a reused ryu-core PID"
            );
            let _ = tokio::fs::remove_file(&self.pid_path).await;
            return;
        }
        kill_pid_tree(record.pid, record.process_group).await;
        let _ = tokio::fs::remove_file(&self.pid_path).await;
    }

    fn cleanup_orphan_sync(&self) {
        let Ok(content) = std::fs::read_to_string(&self.pid_path) else {
            return;
        };
        let Ok(record) = serde_json::from_str::<ManagedPidRecord>(&content) else {
            let _ = std::fs::remove_file(&self.pid_path);
            return;
        };
        if inspect_process(record.pid).is_some_and(|identity| record.matches(&identity)) {
            kill_pid_tree_sync(record.pid, record.process_group, Duration::from_secs(1));
        }
        let _ = std::fs::remove_file(&self.pid_path);
    }
}

/// Force-kill whatever is still bound to this profile's Core + gateway ports.
///
/// Needed because in dev turbo owns Core (no desktop PID file), and a node reset
/// previously only wrote `.reset-pending` then no-op'd the restart — leaving the
/// old process holding every SQLite lock so the wipe could never delete agents /
/// plugins / apps DBs.
async fn kill_profile_listeners() {
    let core = crate::profile::core_port();
    // Gateway base is Core+1 (7981 release / 8981 dev) — matches Core's profile.
    let gateway = core.saturating_add(1);
    for (port, expected_binary) in [(core, "ryu-core"), (gateway, "ryu-gateway")] {
        for pid in pids_listening_on(port) {
            if !process_has_binary_name(pid as u32, expected_binary) {
                tracing::warn!(
                    "refusing to kill pid {pid} on port {port}: it is not {expected_binary}"
                );
                continue;
            }
            tracing::warn!("killing pid {pid} still listening on port {port}");
            kill_pid_tree(pid as u32, None).await;
        }
    }
}

#[cfg(any(unix, test))]
fn recorded_process_group(pid: u32, group: Option<i32>) -> Option<i32> {
    let leader = i32::try_from(pid).ok().filter(|value| *value > 0)?;
    group.filter(|value| *value == leader)
}

#[cfg(unix)]
fn verified_process_group(pid: u32, group: Option<i32>) -> Option<i32> {
    use nix::unistd::{getpgid, Pid};
    let leader = recorded_process_group(pid, group)?;
    (getpgid(Some(Pid::from_raw(leader))).ok()?.as_raw() == leader).then_some(leader)
}

async fn kill_pid_tree(pid: u32, process_group: Option<i32>) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let target = verified_process_group(pid, process_group)
            .map_or_else(|| Pid::from_raw(pid as i32), |group| Pid::from_raw(-group));
        let _ = kill(target, Signal::SIGTERM);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = kill(target, Signal::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .no_window()
            .output();
    }
}

async fn terminate_child_async(child: &mut Child, grace: Duration) {
    let Some(pid) = child.id() else {
        return;
    };
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let group = Pid::from_raw(-(pid as i32));
        let _ = kill(group, Signal::SIGTERM);
        let deadline = tokio::time::Instant::now() + grace;
        while tokio::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let _ = kill(group, Signal::SIGKILL);
        let _ = child.wait().await;
    }
    #[cfg(windows)]
    {
        let pid_string = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/T", "/PID", &pid_string])
            .no_window()
            .output()
            .await;
        let deadline = tokio::time::Instant::now() + grace;
        while tokio::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid_string])
            .no_window()
            .output()
            .await;
        let _ = child.wait().await;
    }
}

fn terminate_child_sync(child: &mut Child, grace: Duration) {
    let Some(pid) = child.id() else {
        return;
    };
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let group = Pid::from_raw(-(pid as i32));
        let _ = kill(group, Signal::SIGTERM);
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = kill(group, Signal::SIGKILL);
    }
    #[cfg(windows)]
    {
        kill_pid_tree_sync(pid, None, grace);
    }
}

fn kill_pid_tree_sync(pid: u32, process_group: Option<i32>, grace: Duration) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let target = verified_process_group(pid, process_group)
            .map_or_else(|| Pid::from_raw(pid as i32), |group| Pid::from_raw(-group));
        let _ = kill(target, Signal::SIGTERM);
        std::thread::sleep(grace);
        let _ = kill(target, Signal::SIGKILL);
    }
    #[cfg(windows)]
    {
        let pid_string = pid.to_string();
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/PID", &pid_string])
            .no_window()
            .output();
        std::thread::sleep(grace);
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid_string])
            .no_window()
            .output();
    }
}

fn process_has_binary_name(pid: u32, expected: &str) -> bool {
    inspect_process(pid).is_some_and(|identity| {
        std::path::Path::new(&identity.executable)
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
    })
}

/// PIDs in LISTEN state on `port` (IPv4/IPv6). Best-effort; empty on parse failure.
fn pids_listening_on(port: u16) -> Vec<i32> {
    #[cfg(windows)]
    {
        let Ok(output) = std::process::Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .no_window()
            .output()
        else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let needle = format!(":{port}");
        let mut pids = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            // e.g. "TCP    127.0.0.1:8980    0.0.0.0:0    LISTENING    51588"
            if !(line.contains("LISTENING") && line.contains(&needle)) {
                continue;
            }
            let Some(pid_str) = line.split_whitespace().last() else {
                continue;
            };
            let Ok(pid) = pid_str.parse::<i32>() else {
                continue;
            };
            // Ensure the port token is a local bind (`:8980` as address end), not a
            // remote ephemeral that happens to contain the digits.
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 4 {
                continue;
            }
            let local = parts[1];
            if !local.ends_with(&needle) {
                continue;
            }
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
        pids
    }
    #[cfg(unix)]
    {
        let Ok(output) = std::process::Command::new("lsof")
            .args(["-ti", &format!("TCP:{port}"), "-sTCP:LISTEN"])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .filter_map(|s| s.parse::<i32>().ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn recorded_group_cannot_target_another_process_group() {
        assert_eq!(super::recorded_process_group(123, Some(123)), Some(123));
        for group in [None, Some(0), Some(-123), Some(456)] {
            assert_eq!(super::recorded_process_group(123, group), None);
        }
        assert_eq!(super::recorded_process_group(0, Some(0)), None);
        assert_eq!(super::recorded_process_group(u32::MAX, Some(-1)), None);
    }

    use super::*;

    fn execution_receipt(home: &std::path::Path) -> ExecutionWorkerRecord {
        ExecutionWorkerRecord {
            version: 1,
            pid: u32::MAX,
            executable: dev_execution_dir(home).join("missing-host"),
            start_time: 1,
            private_bind: "127.0.0.1:12345".parse().unwrap(),
            data_dir: std::fs::canonicalize(home).unwrap(),
            public_bind: "127.0.0.1:12346".parse().unwrap(),
        }
    }

    fn write_execution_receipt(home: &std::path::Path, record: &ExecutionWorkerRecord) -> PathBuf {
        let directory = dev_execution_dir(home);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("worker.json");
        std::fs::write(&path, serde_json::to_vec(record).unwrap()).unwrap();
        path
    }

    #[test]
    fn dead_execution_host_with_removed_binary_allows_facade_cleanup() {
        let home = tempfile::tempdir().unwrap();
        let record = execution_receipt(home.path());
        let path = write_execution_receipt(home.path(), &record);
        assert!(execution_host_stop_command(home.path(), "dev")
            .unwrap()
            .is_none());
        assert!(path.exists(), "stale receipt is not deleted by Desktop");
    }

    #[test]
    fn reused_execution_pid_never_requires_or_executes_its_removed_binary() {
        let home = tempfile::tempdir().unwrap();
        let mut record = execution_receipt(home.path());
        record.pid = std::process::id();
        record.start_time = inspect_process(record.pid).unwrap().start_time + 1;
        let path = write_execution_receipt(home.path(), &record);
        assert!(execution_host_stop_command(home.path(), "dev")
            .unwrap()
            .is_none());
        assert!(path.exists());
        record.start_time -= 1;
        write_execution_receipt(home.path(), &record);
        assert!(
            execution_host_stop_command(home.path(), "dev").is_err(),
            "live process with unavailable executable fails closed"
        );
    }

    #[test]
    fn invalid_execution_receipts_fail_before_process_launch() {
        let home = tempfile::tempdir().unwrap();
        let record = execution_receipt(home.path());
        let path = write_execution_receipt(home.path(), &record);
        let valid = serde_json::to_value(&record).unwrap();
        let mut cases = vec![serde_json::json!({}), serde_json::json!(null)];
        for (key, value) in [
            ("version", serde_json::json!(2)),
            ("pid", serde_json::json!(0)),
            ("pid", serde_json::json!(4294967296_u64)),
            ("start_time", serde_json::json!(0)),
            ("private_bind", serde_json::json!("0.0.0.0:12345")),
            ("private_bind", serde_json::json!("127.0.0.1:0")),
            ("public_bind", serde_json::json!("localhost:8980")),
            ("public_bind", serde_json::json!("0.0.0.0:8980")),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            cases.push(invalid);
        }
        for invalid in cases {
            std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(
                execution_host_stop_command(home.path(), "dev").is_err(),
                "accepted invalid receipt: {invalid}"
            );
        }
        std::fs::write(&path, vec![b' '; MAX_EXECUTION_RECORD_BYTES as usize + 1]).unwrap();
        assert!(execution_host_stop_command(home.path(), "dev").is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(execution_host_stop_command(home.path(), "dev").is_err());
    }

    #[test]
    #[ignore = "subprocess fixture for identity and bounded shutdown tests"]
    fn execution_host_fixture() {
        if let Some(path) = std::env::var_os("RYU_TEST_FACADE_CHILD_RECEIPT") {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["execution_host_fixture", "--ignored"])
                .env_remove("RYU_TEST_FACADE_CHILD_RECEIPT")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .no_window();
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000 | 0x00000200);
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            let child = command.spawn().unwrap();
            std::fs::write(path, child.id().to_string()).unwrap();
            drop(child);
        }
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn facade_quiesce_does_not_kill_its_detached_execution_child() {
        let home = tempfile::tempdir().unwrap();
        let child_receipt = home.path().join("child-pid");
        let mut facade = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["execution_host_fixture", "--ignored"])
            .env("RYU_TEST_FACADE_CHILD_RECEIPT", &child_receipt)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !child_receipt.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let child_pid: u32 = std::fs::read_to_string(&child_receipt)
            .unwrap()
            .parse()
            .unwrap();
        let result = (|| -> Result<()> {
            let record = ManagedPidRecord::from_identity(
                inspect_process(facade.id()).ok_or_else(|| anyhow!("facade fixture identity"))?,
            );
            kill_facade_process(&record)?;
            facade.wait()?;
            anyhow::ensure!(
                inspect_process(child_pid).is_some(),
                "facade quiesce killed its detached execution child"
            );
            Ok(())
        })();
        let _ = facade.kill();
        let _ = facade.wait();
        if let Some(child) = System::new_all().process(SysinfoPid::from_u32(child_pid)) {
            child.kill();
        }
        result.unwrap();
    }

    #[test]
    fn verified_host_uses_immutable_executable_and_recorded_public_bind() {
        let home = tempfile::tempdir().unwrap();
        let directory = dev_execution_dir(home.path());
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(if cfg!(windows) { "host.exe" } else { "host" });
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let executable = std::fs::canonicalize(executable).unwrap();
        let mut child = std::process::Command::new(&executable)
            .args(["execution_host_fixture", "--ignored", "--nocapture"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .spawn()
            .unwrap();
        let result = (|| -> Result<()> {
            let identity =
                inspect_process(child.id()).ok_or_else(|| anyhow!("fixture process identity"))?;
            let mut record = execution_receipt(home.path());
            record.pid = identity.pid;
            record.start_time = identity.start_time;
            record.executable = executable.clone();
            let path = write_execution_receipt(home.path(), &record);
            let stop = execution_host_stop_command(home.path(), "dev")?.unwrap();
            assert_eq!(stop.command.get_program(), executable.as_os_str());
            let args: Vec<_> = stop.command.get_args().collect();
            assert_eq!(args, ["--stop-dev-execution", "--bind=127.0.0.1:12346"]);
            // A successful helper which leaves the verified host running must
            // fail and keep its receipt available for a later real shutdown.
            let mut success = std::process::Command::new(&executable);
            success
                .arg("--list")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .no_window();
            assert!(execute_host_stop(
                ExecutionHostStop {
                    command: success,
                    record: record.clone()
                },
                Duration::from_secs(5)
            )
            .is_err());
            assert!(path.exists());
            let mut hanging = std::process::Command::new(&executable);
            hanging
                .args(["execution_host_fixture", "--ignored"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .no_window();
            let started = std::time::Instant::now();
            assert!(execute_host_stop(
                ExecutionHostStop {
                    command: hanging,
                    record
                },
                Duration::from_millis(100)
            )
            .is_err());
            assert!(started.elapsed() < Duration::from_secs(3));
            assert!(path.exists());
            Ok(())
        })();
        let _ = child.kill();
        let _ = child.wait();
        result.unwrap();
    }

    #[test]
    fn absent_host_never_sends_a_stop_flag_to_a_legacy_core() {
        let base = tempfile::tempdir().unwrap();
        let marker = base.path().join("unexpected-stop");
        #[cfg(windows)]
        let cli = base.path().join("legacy.cmd");
        #[cfg(windows)]
        std::fs::write(
            &cli,
            format!("@echo launched>\"{}\"\r\n@exit /b 0\r\n", marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        let cli = base.path().join("legacy.sh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&cli, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut process = RyuCoreProcess::new(cli);
        process.pid_path = base.path().join("ryu-core.pid");
        process.preserve_on_exit = true;
        assert!(process.dev_execution_stop_command().unwrap().is_none());
        assert!(execution_host_stop_command(base.path(), "dev")
            .unwrap()
            .is_none());
        // The production resolver must not invoke the replacement binary either.
        let paths = ryu_runtime_install::data_paths::DataPaths::for_profile(
            "dev",
            Some(base.path().to_owned()),
            Some(base.path().join("config")),
        )
        .unwrap();
        let home = paths.resolve_data_dir(None).unwrap();
        assert!(execution_host_stop_command(&home, "dev").unwrap().is_none());
        assert!(
            !marker.exists(),
            "legacy Core was executed during shutdown discovery"
        );
    }

    #[test]
    fn only_local_debug_dev_preserves_core() {
        assert!(preserve_core_on_exit(true, "dev"));
        for profile in ["release", "canary", "nightly", "beta", "unknown"] {
            assert!(!preserve_core_on_exit(true, profile));
        }
        assert!(!preserve_core_on_exit(false, "dev"));
    }

    #[test]
    fn preserved_dev_core_log_uses_the_profile_log_directory() {
        let home = tempfile::tempdir().expect("temporary runtime home");
        assert_eq!(
            persistent_core_log_path(home.path()),
            home.path().join("logs").join("core-dev-runtime.log"),
            "the dev runtime log is logs/core-dev-runtime.log"
        );
    }

    #[tokio::test]
    async fn dev_exit_preserves_owned_and_reattached_process_until_explicit_stop() {
        let home = tempfile::tempdir().expect("temporary runtime home");
        let pid_path = home.path().join("ryu-core.pid");
        // The retained process is a sleeper, while its CLI implements the real
        // no-host shutdown contract. Do not point lifecycle calls at a missing
        // executable just because this fixture has no independent host.
        #[cfg(windows)]
        let runtime_binary = home.path().join("runtime-cli.cmd");
        #[cfg(windows)]
        std::fs::write(
            &runtime_binary,
            "@if \"%~1\"==\"--stop-dev-execution\" exit /b 0\r\n@exit /b 2\r\n",
        )
        .unwrap();
        #[cfg(unix)]
        let runtime_binary = home.path().join("runtime-cli.sh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(
                &runtime_binary,
                "#!/bin/sh\n[ \"$1\" = \"--stop-dev-execution\" ]\n",
            )
            .unwrap();
            std::fs::set_permissions(&runtime_binary, std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        #[cfg(windows)]
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.args([
            "-NoProfile",
            "-Command",
            "Write-Output 'runtime alive'; Start-Sleep -Seconds 60",
        ]);
        #[cfg(unix)]
        let mut command = Command::new("sh");
        #[cfg(unix)]
        command.args(["-c", "echo 'runtime alive'; sleep 60"]);
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .no_window();
        configure_process_group(&mut command);
        let child = command.spawn().expect("spawn test runtime");
        let pid = child.id().expect("runtime PID");
        let mut process = RyuCoreProcess::new(runtime_binary.clone());
        process.pid_path = pid_path.clone();
        process.preserve_on_exit = true;
        process
            .own_spawned_child(child)
            .await
            .expect("record owned runtime");
        process.exit_desktop().expect("detach owned runtime");
        assert!(
            inspect_process(pid).is_some(),
            "owned runtime survives exit"
        );
        assert!(pid_path.exists(), "identity survives for explicit shutdown");

        let mut attached = RyuCoreProcess::new(runtime_binary);
        attached.pid_path = pid_path.clone();
        attached.preserve_on_exit = true;
        assert!(
            attached.attach_preserved_core(),
            "failed health preserves a verified live dev runtime"
        );
        assert_eq!(attached.state, ProcessState::Running);
        attached.exit_desktop().expect("detach attached runtime");
        assert!(
            inspect_process(pid).is_some(),
            "attached runtime survives exit"
        );
        assert!(pid_path.exists());
        // Explicit shutdown retains identity-verified orphan termination.
        attached.try_stop().expect("explicit shutdown");
        // Windows may retain the process entry briefly after taskkill returns.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while inspect_process(pid).is_some() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            inspect_process(pid).is_none(),
            "explicit shutdown stops runtime"
        );
        assert!(!pid_path.exists());
    }
}

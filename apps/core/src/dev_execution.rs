//! A replaceable local dev listener forwards to a detached immutable execution host.
//! The host remains the sole store, agent, approval, tool and Gateway owner.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use sysinfo::{Pid, System};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
const WORKER_ENV: &str = "RYU_EXECUTION_WORKER";
const RECORD_VERSION: u32 = 3;
const PROOF_ENV: &str = "RYU_EXECUTION_PROOF_KEY";
const BOOTSTRAP_ENV: &str = "RYU_EXECUTION_BOOTSTRAP_ADDR";
const BOOTSTRAP_NONCE_ENV: &str = "RYU_EXECUTION_BOOTSTRAP_NONCE";
const PUBLIC_BIND_ENV: &str = "RYU_EXECUTION_PUBLIC_BIND";
const STOP_FLAG: &str = "--stop-dev-execution";
const RESTART_FLAG: &str = "--restart-dev-execution";
/// With `--restart-dev-execution`: replace the host now instead of when idle.
const RESTART_NOW_FLAG: &str = "--now";
/// Launcher-only arguments a new host must never inherit.
const LIFECYCLE_FLAGS: [&str; 3] = [STOP_FLAG, RESTART_FLAG, RESTART_NOW_FLAG];
/// How long a restart waits for running turns before replacing the host anyway.
/// Boot recovery then re-runs whatever the replacement interrupted.
const RESTART_IDLE_WAIT_ENV: &str = "RYU_DEV_RESTART_MAX_WAIT_SECS";
const DEFAULT_RESTART_IDLE_WAIT: Duration = Duration::from_secs(30 * 60);
static EXECUTION_IDENTITY: std::sync::OnceLock<WorkerRecord> = std::sync::OnceLock::new();
#[derive(Debug, Clone)]
pub struct ExecutionConfig {
    pub data_dir: PathBuf,
    pub public_bind: SocketAddr,
    pub executable: PathBuf,
    pub args: Vec<OsString>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerRecord {
    pub version: u32,
    pub pid: u32,
    pub executable: PathBuf,
    pub start_time: u64,
    pub private_bind: SocketAddr,
    pub data_dir: PathBuf,
    pub public_bind: SocketAddr,
    #[serde(default)]
    pub proof_key: String,
}
/// `<data dir>/runtimes/dev-execution` — the dev execution host's own root.
fn execution_root(data_dir: &Path) -> PathBuf {
    ryu_sidecar_runtime::layout::runtime_dir(data_dir, "dev-execution")
}

fn record_path(data_dir: &Path) -> PathBuf {
    execution_root(data_dir).join("worker.json")
}
fn identity(pid: u32) -> Option<(PathBuf, u64)> {
    let system = System::new_all();
    let process = system.process(Pid::from_u32(pid))?;
    Some((process.exe()?.to_path_buf(), process.start_time()))
}
// Linux start ticks are readable without ptrace permission, unlike exe/environ.
// A version-three receipt uses this kernel generation rather than epoch seconds.
#[cfg(target_os = "linux")]
fn process_generation(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    if matches!(*fields.first()?, "Z" | "X") {
        return None;
    }
    fields.get(19)?.parse().ok()
}
#[cfg(not(target_os = "linux"))]
fn process_generation(pid: u32) -> Option<u64> {
    let system = System::new_all();
    Some(system.process(Pid::from_u32(pid))?.start_time())
}
fn signed_identity(record: &WorkerRecord, domain: &str, nonce: &str) -> String {
    let mut public = record.clone();
    public.proof_key.clear();
    let mut payload = format!("ryu-dev-execution-{domain}-v3:{nonce}:").into_bytes();
    payload.extend(serde_json::to_vec(&public).expect("execution identity serialization"));
    ryu_crypto::hmac_sha256_hex(record.proof_key.as_bytes(), &payload)
}
fn proof_matches(actual: &str, expected: &str) -> bool {
    actual.len() == expected.len()
        && actual
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
#[derive(Serialize, Deserialize)]
struct BootstrapReceipt {
    identity: WorkerRecord,
    proof: String,
}
struct StartupChild {
    child: tokio::process::Child,
    detached: bool,
}
impl std::ops::Deref for StartupChild {
    type Target = tokio::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for StartupChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Drop for StartupChild {
    fn drop(&mut self) {
        if !self.detached {
            let _ = self.child.start_kill();
        }
    }
}
async fn publish_worker_identity(data_dir: &Path) -> Result<WorkerRecord> {
    use tokio::io::AsyncWriteExt;
    let pid = std::process::id();
    let record = WorkerRecord {
        version: RECORD_VERSION,
        pid,
        executable: std::fs::canonicalize(std::env::current_exe()?)?,
        start_time: process_generation(pid).context("read protected worker generation")?,
        private_bind: std::env::var("RYU_BIND")?.parse()?,
        public_bind: std::env::var(PUBLIC_BIND_ENV)?.parse()?,
        data_dir: data_dir.to_owned(),
        proof_key: std::env::var(PROOF_ENV)?,
    };
    let nonce = std::env::var(BOOTSTRAP_NONCE_ENV)?;
    let mut receipt = BootstrapReceipt {
        proof: signed_identity(&record, "bootstrap", &nonce),
        identity: record.clone(),
    };
    receipt.identity.proof_key.clear();
    let address: SocketAddr = std::env::var(BOOTSTRAP_ENV)?.parse()?;
    if !address.ip().is_loopback() || record.proof_key.len() != 64 || nonce.len() != 64 {
        bail!("invalid execution bootstrap coordinates");
    }
    let mut stream = TcpStream::connect(address).await?;
    stream.write_all(&serde_json::to_vec(&receipt)?).await?;
    stream.shutdown().await?;
    Ok(record)
}
async fn accept_worker_identity(
    listener: &TcpListener,
    expected: &WorkerRecord,
    nonce: &str,
) -> Result<()> {
    use tokio::io::AsyncReadExt;
    let (stream, peer) = listener.accept().await?;
    if !peer.ip().is_loopback() {
        bail!("execution bootstrap requires loopback");
    }
    let mut bytes = Vec::new();
    stream.take(8193).read_to_end(&mut bytes).await?;
    if bytes.len() > 8192 {
        bail!("execution bootstrap receipt is too large");
    }
    let receipt: BootstrapReceipt = serde_json::from_slice(&bytes)?;
    let mut public = expected.clone();
    public.proof_key.clear();
    if receipt.identity != public
        || !proof_matches(
            &receipt.proof,
            &signed_identity(expected, "bootstrap", nonce),
        )
    {
        bail!("execution bootstrap identity authentication failed");
    }
    if process_generation(expected.pid) != Some(expected.start_time) {
        bail!("execution host changed during bootstrap");
    }
    Ok(())
}
fn normalized_path(path: &Path) -> PathBuf {
    // Windows process inspection and canonicalize can use different extended
    // path spellings for the same file. Compare the resolved filesystem path.
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
// Keep the lock outside the data tree: a worker can consume a pending reset
// immediately after its receipt is published. Deleting a locked file would let
// another launcher lock a different inode and acquire the same ownership.
async fn lifecycle_lease(data_dir: &Path, timeout: Duration) -> Result<File> {
    let root = dirs::cache_dir()
        .context("execution lifecycle cache directory")?
        .join("ryu-dev-execution");
    std::fs::create_dir_all(&root)?;
    let key = Sha256::digest(normalized_path(data_dir).as_os_str().as_encoded_bytes());
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(format!("{}.lock", hex::encode(key))))?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(TryLockError::WouldBlock) => {
                bail!("execution lifecycle is busy; timed out waiting for ownership")
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}
pub fn worker_is_alive(record: &WorkerRecord) -> bool {
    if record.version == RECORD_VERSION {
        return process_generation(record.pid) == Some(record.start_time);
    }
    matches!(record.version, 1 | 2)
        && identity(record.pid).is_some_and(|(exe, start)| {
            normalized_path(&exe) == normalized_path(&record.executable)
                && start == record.start_time
        })
}
fn read_record(data_dir: &Path) -> Result<Option<WorkerRecord>> {
    match std::fs::read(record_path(data_dir)) {
        Ok(bytes) => {
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).context("invalid execution identity record")?;
            if value.get("identity").is_some() {
                let receipt: BootstrapReceipt = serde_json::from_value(value)?;
                if receipt.identity.version != RECORD_VERSION
                    || !proof_matches(
                        &receipt.proof,
                        &signed_identity(&receipt.identity, "ownership", ""),
                    )
                {
                    bail!("execution ownership receipt authentication failed; ownership retained");
                }
                Ok(Some(receipt.identity))
            } else {
                let record: WorkerRecord = serde_json::from_value(value)?;
                if !matches!(record.version, 1 | 2) {
                    bail!("execution ownership receipt is unsigned; refusing startup");
                }
                Ok(Some(record))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn validate_record(record: &WorkerRecord, config: &ExecutionConfig) -> Result<()> {
    if !matches!(record.version, 1 | 2 | RECORD_VERSION)
        || record.data_dir != config.data_dir
        || record.public_bind != config.public_bind
        || !record.private_bind.ip().is_loopback()
        || record.private_bind.port() == 0
        || !normalized_path(&record.executable)
            .starts_with(normalized_path(&execution_root(&config.data_dir)))
    {
        bail!("execution identity does not match this dev node; refusing a competing store owner");
    }
    Ok(())
}
fn persist_record(record: &WorkerRecord) -> Result<()> {
    let path = record_path(&record.data_dir);
    let mut file = tempfile::NamedTempFile::new_in(path.parent().context("identity directory")?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path.parent().unwrap(),
            std::fs::Permissions::from_mode(0o700),
        )?;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    let bytes = if record.version == RECORD_VERSION {
        serde_json::to_vec(&BootstrapReceipt {
            identity: record.clone(),
            proof: signed_identity(record, "ownership", ""),
        })?
    } else {
        serde_json::to_vec(record)?
    };
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}
/// Caller binds the public listener first; the lease also serializes shutdown.
pub async fn ensure_worker(config: &ExecutionConfig) -> Result<WorkerRecord> {
    attach_or_spawn(config, Respawn::Always, Duration::from_secs(15)).await
}
/// When a facade whose host is gone may start a new one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Respawn {
    /// Launch: no receipt, or a dead one, starts a host.
    Always,
    /// A dead host whose receipt remains crashed and is replaced. An explicit
    /// stop removed the receipt and stays stopped: a data-folder move or reset
    /// must not race a host the facade started on its own.
    AfterCrash,
    /// Only adopt a newer live host; never start one.
    Never,
}
/// A running facade whose host is gone. A newer live host (from
/// `--restart-dev-execution`) is adopted; see [`Respawn`] for the rest.
async fn reattach_worker(config: &ExecutionConfig, respawn: Respawn) -> Result<WorkerRecord> {
    attach_or_spawn(config, respawn, Duration::from_secs(2)).await
}
async fn attach_or_spawn(
    config: &ExecutionConfig,
    respawn: Respawn,
    lease_timeout: Duration,
) -> Result<WorkerRecord> {
    let _lease = lifecycle_lease(&config.data_dir, lease_timeout).await?;
    let record = read_record(&config.data_dir)?;
    if record.is_none() && respawn != Respawn::Always {
        bail!("execution host was stopped explicitly; restart Core to start a new one");
    }
    if let Some(record) = record {
        validate_record(&record, config)?;
        if record.version != RECORD_VERSION && process_generation(record.pid).is_some() {
            bail!("legacy execution host is still running; stop it with the matching previous Core build before upgrading; ownership retained");
        }
        #[cfg(target_os = "linux")]
        if !worker_is_alive(&record) && process_group_has_live_members(record.pid)? {
            bail!("execution leader exited but its process group remains; stop the specific development child tools using operating-system process controls; ownership retained");
        }
        if worker_is_alive(&record) {
            if record.version != RECORD_VERSION {
                bail!(
                    "legacy execution host requires an explicit --stop-dev-execution before upgrading peer authentication"
                );
            }
            // A failed health check never authorizes replacing a busy live host.
            authenticate_worker(&record).await?;
            return Ok(record);
        }
        if respawn == Respawn::Never {
            bail!("execution host stopped; waiting before starting a replacement");
        }
    }
    let root = execution_root(&config.data_dir);
    std::fs::create_dir_all(&root)?;
    let version_dir = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&version_dir)?;
    // Every early return below removes the copy: a start that never publishes
    // ownership must not leave a full executable behind for each crash respawn.
    let mut version_guard = VersionDirGuard(Some(version_dir.clone()));
    let binary = version_dir.join(if cfg!(windows) {
        "ryu-execution-host.exe"
    } else {
        "ryu-execution-host"
    });
    std::fs::copy(&config.executable, &binary).context("copy immutable execution binary")?;
    let binary = std::fs::canonicalize(binary)?;
    let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let private_bind = reservation.local_addr()?;
    drop(reservation);
    let proof_key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let bootstrap = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let bootstrap_nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    // The worker logs through Core's rotating, redacting writer
    // (`RYU_CORE_LOG_PATH`); its raw stderr (panics, early failures) appends to
    // the same owner-only file. Nothing else reaches the file unredacted.
    let log_path = root.join("execution.log");
    let stderr_log = crate::log_rotation::open_private_log(&log_path)?;
    let mut command = Command::new(&binary);
    command
        .args(config.args.iter().filter(|argument| {
            let argument = argument.to_string_lossy();
            !argument.starts_with("--bind=") && !LIFECYCLE_FLAGS.contains(&argument.as_ref())
        }))
        .env(WORKER_ENV, "1")
        .env(PROOF_ENV, &proof_key)
        .env(BOOTSTRAP_ENV, bootstrap.local_addr()?.to_string())
        .env(BOOTSTRAP_NONCE_ENV, &bootstrap_nonce)
        .env(PUBLIC_BIND_ENV, config.public_bind.to_string())
        .env("RYU_DIR", &config.data_dir)
        .env("RYU_BIND", private_bind.to_string())
        .env("RYU_CORE_URL", format!("http://{private_bind}"))
        .env("RYU_CORE_LOG_PATH", &log_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_log))
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x08000000 | 0x00000200);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = StartupChild {
        child: command
            .spawn()
            .context("spawn independent execution host")?,
        detached: false,
    };
    let pid = child.id().context("execution PID")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let start_time = loop {
        if let Some(generation) = process_generation(pid) {
            break generation;
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill().await;
            bail!("could not verify execution host identity");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let record = WorkerRecord {
        version: RECORD_VERSION,
        pid,
        executable: binary,
        start_time,
        private_bind,
        data_dir: config.data_dir.clone(),
        public_bind: config.public_bind,
        proof_key,
    };
    let verified = tokio::time::timeout(
        Duration::from_secs(5),
        accept_worker_identity(&bootstrap, &record, &bootstrap_nonce),
    )
    .await;
    match verified {
        Ok(Ok(())) => {}
        result => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return match result {
                Ok(Err(error)) => Err(error),
                Err(error) => Err(error).context("execution bootstrap timed out"),
                Ok(Ok(())) => unreachable!(),
            };
        }
    }
    if let Err(error) = persist_record(&record) {
        let _ = child.kill().await;
        return Err(error);
    }
    version_guard.0 = None;
    prune_stale_versions(&root, &version_dir);
    // Bootstrap has completed; no socket/pipe ties execution to this facade.
    child.detached = true;
    drop(child);
    Ok(record)
}
/// Removes a version directory unless disarmed (`.0 = None`) once its host owns
/// the receipt.
struct VersionDirGuard(Option<PathBuf>);

impl Drop for VersionDirGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// Every host start copies the whole executable, so delete the copies of
/// earlier hosts once a new one owns the receipt. A host is only started when
/// the recorded one is gone (and on Linux its process group is empty), so no
/// other copy is running; one that is still locked is left for the next start.
fn prune_stale_versions(root: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_version = entry.file_type().is_ok_and(|kind| kind.is_dir())
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok());
        if is_version && path != keep {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}
/// Only explicit restart/reset should invoke this identity-verified shutdown.
pub async fn stop_worker(config: &ExecutionConfig) -> Result<()> {
    let _lease = lifecycle_lease(&config.data_dir, Duration::from_secs(15)).await?;
    let Some(record) = read_record(&config.data_dir)? else {
        return Ok(());
    };
    validate_record(&record, config)?;
    if record.version != RECORD_VERSION && process_generation(record.pid).is_some() {
        bail!("legacy execution host cannot authenticate immutable identity; stop the previous development app or its specific execution process using operating-system process controls; ownership retained");
    }
    #[cfg(target_os = "linux")]
    if !worker_is_alive(&record) && process_group_has_live_members(record.pid)? {
        bail!("execution leader exited but its process group remains; refusing unverified child shutdown; ownership retained");
    }
    if worker_is_alive(&record) {
        #[cfg(target_os = "linux")]
        let process_handle = open_worker_handle(&record)?;
        authenticate_worker(&record).await?;
        #[cfg(target_os = "linux")]
        if let Err(error) = signal_worker_group(&process_handle, 0) {
            if error
                .downcast_ref::<std::io::Error>()
                .and_then(|e| e.raw_os_error())
                != Some(libc::EINVAL)
            {
                return Err(error);
            }
            stop_worker_group_legacy(&process_handle, &record).await?;
            remove_stopped_record(&record)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("taskkill");
            command.args(["/F", "/T", "/PID", &record.pid.to_string()]);
            command.creation_flags(0x08000000);
            command.kill_on_drop(true);
            let result = tokio::time::timeout(Duration::from_secs(5), command.output())
                .await
                .context("execution host taskkill timed out; ownership retained")??;
            if !result.status.success() && worker_is_alive(&record) {
                bail!(
                    "verified execution host stop failed: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
        #[cfg(target_os = "linux")]
        signal_worker_group(&process_handle, libc::SIGTERM)?;
        #[cfg(all(unix, not(target_os = "linux")))]
        unsafe {
            libc::kill(-(record.pid as i32), libc::SIGTERM);
        }
        let is_alive = || -> Result<bool> {
            #[cfg(target_os = "linux")]
            {
                worker_group_is_alive(&process_handle, record.pid)
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(worker_is_alive(&record))
            }
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while is_alive()? && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if is_alive()? {
            #[cfg(target_os = "linux")]
            signal_worker_group(&process_handle, libc::SIGKILL)?;
            #[cfg(all(unix, not(target_os = "linux")))]
            unsafe {
                if libc::kill(-(record.pid as i32), libc::SIGKILL) != 0 && worker_is_alive(&record)
                {
                    return Err(std::io::Error::last_os_error())
                        .context("execution host kill failed; ownership retained");
                }
            }
            #[cfg(windows)]
            bail!("execution host is still alive after stop");
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while is_alive()? && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if is_alive()? {
            bail!("execution host is still alive after escalation; ownership retained");
        }
    }
    remove_stopped_record(&record)?;
    Ok(())
}
fn restart_idle_wait() -> Duration {
    std::env::var(RESTART_IDLE_WAIT_ENV)
        .ok()
        .and_then(|seconds| seconds.trim().parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_RESTART_IDLE_WAIT)
}
const IDLE_POLL: Duration = Duration::from_secs(2);
const IDLE_REPORT_EVERY: Duration = Duration::from_secs(30);
/// Replace the host with one built from this executable, so Core code changes
/// apply without a full stack restart. Running turns finish first: the wait
/// polls the host until it reports no live turn twice in a row, or until
/// `idle_wait` runs out. The facade attaches to the new host on its next
/// connection, and clients reattach through `/api/chat/stream/resume`.
pub async fn restart_worker(config: &ExecutionConfig, idle_wait: Duration) -> Result<()> {
    let observed = read_record(&config.data_dir)?;
    if let Some(record) = observed.as_ref() {
        validate_record(record, config)?;
        if record.version == RECORD_VERSION && worker_is_alive(record) {
            wait_until_idle(record, idle_wait).await;
        }
    }
    // Another restart may have replaced the host while this one waited; that
    // replacement already runs the newest build, so restarting again would only
    // interrupt the turns that started on it.
    let current = read_record(&config.data_dir)?;
    if current != observed && current.as_ref().is_some_and(worker_is_alive) {
        eprintln!("[dev] execution host was already replaced; nothing to restart");
        return Ok(());
    }
    stop_worker(config).await?;
    let record = ensure_worker(config).await?;
    crate::log_rotation::write_diagnostic(format!(
        "[dev] execution host restarted as PID {} at {}",
        record.pid, record.private_bind
    ));
    eprintln!(
        "[dev] execution host restarted as PID {}; open chats reattach on their own",
        record.pid
    );
    Ok(())
}
async fn wait_until_idle(record: &WorkerRecord, idle_wait: Duration) {
    if idle_wait.is_zero() {
        return;
    }
    let deadline = tokio::time::Instant::now() + idle_wait;
    let mut next_report = tokio::time::Instant::now();
    let mut idle_polls = 0;
    while tokio::time::Instant::now() < deadline {
        if !worker_is_alive(record) {
            return;
        }
        match query_activity(record).await {
            Ok(0) => {
                idle_polls += 1;
                if idle_polls >= 2 {
                    return;
                }
            }
            Ok(active) => {
                idle_polls = 0;
                if tokio::time::Instant::now() >= next_report {
                    eprintln!(
                        "[dev] waiting for {active} running turn(s) to finish before restarting Core"
                    );
                    next_report = tokio::time::Instant::now() + IDLE_REPORT_EVERY;
                }
            }
            // A host too old to answer cannot report its turns; the wait still
            // bounds the restart, so treat it as busy rather than idle.
            Err(error) => {
                idle_polls = 0;
                if tokio::time::Instant::now() >= next_report {
                    eprintln!("[dev] execution host activity unavailable ({error:#}); waiting");
                    next_report = tokio::time::Instant::now() + IDLE_REPORT_EVERY;
                }
            }
        }
        tokio::time::sleep(IDLE_POLL).await;
    }
    eprintln!(
        "[dev] restarting Core with turns still running; boot recovery resumes interrupted threads"
    );
}
#[derive(Serialize, Deserialize)]
struct ActivityReport {
    active_turns: usize,
}
/// Ask the authenticated host how many turns are live, on the socket that
/// passed the peer challenge.
async fn query_activity(record: &WorkerRecord) -> Result<usize> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = TcpStream::connect(record.private_bind).await?;
        verify_peer_identity(&mut stream, &record.proof_key, Some(record)).await?;
        let nonce = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let proof = signed_identity(record, "activity", &nonce);
        stream
            .write_all(format!("GET {ACTIVITY_PATH}?nonce={nonce}&proof={proof} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
            .await?;
        let mut response = Vec::new();
        (&mut stream).take(8192).read_to_end(&mut response).await?;
        let text = std::str::from_utf8(&response)?;
        let (head, body) = text
            .split_once("\r\n\r\n")
            .context("invalid execution activity response")?;
        if !head.starts_with("HTTP/1.1 200 ") {
            bail!("execution host refused the activity query");
        }
        let report: ActivityReport =
            serde_json::from_str(body.trim()).context("invalid execution activity report")?;
        Ok(report.active_turns)
    })
    .await
    .context("execution activity query timed out")?
}
pub const ACTIVITY_PATH: &str = "/internal/dev-execution/activity";
/// The host's answer to [`query_activity`]. Only the holder of the ownership
/// receipt can produce the proof, and the answer is a bare count.
pub fn activity_response(
    query: &std::collections::HashMap<String, String>,
    active_turns: usize,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Some(record) = EXECUTION_IDENTITY.get() else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    if std::env::var(WORKER_ENV).as_deref() != Ok("1") {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let (Some(nonce), Some(proof)) = (query.get("nonce"), query.get("proof")) else {
        return axum::http::StatusCode::BAD_REQUEST.into_response();
    };
    if nonce.len() != 64
        || proof.len() != 64
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !proof.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return axum::http::StatusCode::BAD_REQUEST.into_response();
    }
    if !proof_matches(proof, &signed_identity(record, "activity", nonce)) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(ActivityReport { active_turns }),
    )
        .into_response()
}
#[cfg(target_os = "linux")]
fn open_worker_handle(record: &WorkerRecord) -> Result<File> {
    use std::os::fd::FromRawFd;
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, record.pid, 0) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error())
            .context("open execution process handle; ownership retained");
    }
    let handle = unsafe { File::from_raw_fd(descriptor as i32) };
    if !worker_is_alive(record) || unsafe { libc::getpgid(record.pid as i32) } != record.pid as i32
    {
        bail!("execution process generation changed; refusing shutdown");
    }
    Ok(handle)
}
#[cfg(target_os = "linux")]
fn signal_process(handle: &File, signal: i32) -> Result<bool> {
    use std::os::fd::AsRawFd;
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            handle.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error).context("execution process signal failed; ownership retained")
}
#[cfg(target_os = "linux")]
async fn stop_worker_group_legacy(_leader: &File, record: &WorkerRecord) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Older kernels cannot signal a group through a pidfd. Only the live,
    // authenticated worker can safely address its own current process group.
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = TcpStream::connect(record.private_bind).await?;
        verify_peer_identity(&mut stream, &record.proof_key, Some(record)).await?;
        let nonce = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let proof = signed_identity(record, "stop", &nonce);
        stream.write_all(format!("POST /internal/dev-execution/stop?nonce={nonce}&proof={proof} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").as_bytes()).await?;
        let mut response = [0u8; 1];
        // A successful synchronous group kill closes the socket without a
        // response. A refusal is an HTTP response and never authorizes cleanup.
        match stream.read(&mut response).await {
            Ok(0) => {},
            Ok(_) => bail!("execution host refused identity-bound shutdown; ownership retained"),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof) => {},
            Err(error) => return Err(error.into()),
        }
        Ok::<_, anyhow::Error>(())
    }).await.context("execution host shutdown request timed out; ownership retained")??;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while worker_is_alive(record) || process_group_has_live_members(record.pid)? {
        if tokio::time::Instant::now() >= deadline {
            bail!("execution group survived authenticated shutdown; ownership retained");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

pub async fn stop_handler(
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    #[cfg(target_os = "linux")]
    {
        let Some(record) = EXECUTION_IDENTITY.get() else {
            return axum::http::StatusCode::NOT_FOUND.into_response();
        };
        let (Some(nonce), Some(proof)) = (query.get("nonce"), query.get("proof")) else {
            return axum::http::StatusCode::BAD_REQUEST.into_response();
        };
        if nonce.len() != 64
            || proof.len() != 64
            || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !proof.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return axum::http::StatusCode::BAD_REQUEST.into_response();
        }
        if std::env::var(WORKER_ENV).as_deref() != Ok("1")
            || record.pid != std::process::id()
            || process_generation(record.pid) != Some(record.start_time)
            || std::env::current_exe()
                .ok()
                .map(|path| normalized_path(&path))
                != Some(record.executable.clone())
            || unsafe { libc::getpgrp() } != record.pid as i32
            || !proof_matches(proof, &signed_identity(record, "stop", nonce))
        {
            return axum::http::StatusCode::FORBIDDEN.into_response();
        }
        // The stop domain is distinct from the readable peer-proof oracle.
        // A valid request is single-use: synchronous SIGKILL terminates this
        // identity and all current group members before any handler can reply.
        // A later worker has a fresh key, generation, executable and identity.
        let result = unsafe { libc::kill(-(std::process::id() as i32), libc::SIGKILL) };
        if result != 0 {
            return axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        unreachable!("successful execution group SIGKILL cannot return to the handler");
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = query;
        axum::http::StatusCode::NOT_FOUND.into_response()
    }
}
#[cfg(target_os = "linux")]
fn signal_worker_group(handle: &File, signal: i32) -> Result<bool> {
    use std::os::fd::AsRawFd;
    // A pidfd pins the authenticated process, so PID reuse cannot redirect an
    // escalation to another process group after the original worker exits.
    const PIDFD_SIGNAL_PROCESS_GROUP: libc::c_uint = 1 << 2;
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            handle.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            PIDFD_SIGNAL_PROCESS_GROUP,
        )
    };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error).context("identity-bound execution group shutdown unavailable; ownership retained")
}
#[cfg(target_os = "linux")]
fn worker_group_is_alive(handle: &File, group: u32) -> Result<bool> {
    // Signal zero first asks the pinned kernel group, not a potentially reused
    // numeric PGID. If only zombies remain, no execution survives to stop.
    if !signal_worker_group(handle, 0)? {
        return Ok(false);
    }
    process_group_has_live_members(group)
}
#[cfg(target_os = "linux")]
fn process_group_has_live_members(group: u32) -> Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, fields)) = stat.rsplit_once(')') else {
            continue;
        };
        let fields = fields.split_whitespace().collect::<Vec<_>>();
        if !matches!(fields.first(), Some(&"Z" | &"X"))
            && fields.get(2).and_then(|s| s.parse::<u32>().ok()) == Some(group)
        {
            return Ok(true);
        }
    }
    Ok(false)
}
// Called under the lifecycle lease. Checking the full receipt additionally
// protects a replacement written by an older launcher without this lease.
fn remove_stopped_record(record: &WorkerRecord) -> Result<()> {
    match read_record(&record.data_dir)? {
        None => return Ok(()),
        Some(current) if current == *record => {}
        Some(_) => bail!("execution ownership changed during stop; replacement retained"),
    }
    match std::fs::remove_file(record_path(&record.data_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn peer_proof(key: &str, nonce: &str) -> String {
    ryu_crypto::hmac_sha256_hex(
        key.as_bytes(),
        format!("ryu-dev-execution-peer-v2:{nonce}").as_bytes(),
    )
}

/// A fresh proof is verified on the very socket that will receive user bytes.
async fn verify_peer(stream: &mut TcpStream, key: &str) -> Result<()> {
    verify_peer_identity(stream, key, None).await
}
async fn verify_peer_identity(
    stream: &mut TcpStream,
    key: &str,
    identity: Option<&WorkerRecord>,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    stream.write_all(format!("GET /internal/dev-execution/peer-proof?nonce={nonce} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n").as_bytes()).await?;
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= 4096 {
            bail!("invalid execution peer response");
        }
        headers.push(stream.read_u8().await?);
    }
    let headers = std::str::from_utf8(&headers)?;
    if !headers.starts_with("HTTP/1.1 200 ")
        || !headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case("content-length: 64"))
        || headers
            .lines()
            .any(|line| line.to_ascii_lowercase().starts_with("transfer-encoding:"))
    {
        bail!("execution peer authentication failed");
    }
    let mut received = [0u8; 64];
    stream.read_exact(&mut received).await?;
    let expected = identity
        .map(|record| signed_identity(record, "peer", &nonce))
        .unwrap_or_else(|| peer_proof(key, &nonce));
    if !proof_matches(std::str::from_utf8(&received)?, &expected) {
        bail!("execution peer authentication failed");
    }
    Ok(())
}
async fn authenticate_worker(record: &WorkerRecord) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        if !worker_is_alive(record) {
            bail!("execution host stopped");
        }
        let mut stream = TcpStream::connect(record.private_bind).await?;
        verify_peer_identity(
            &mut stream,
            &record.proof_key,
            (record.version == RECORD_VERSION).then_some(record),
        )
        .await?;
        if !worker_is_alive(record) {
            bail!("execution host changed during authentication");
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("execution host authentication timed out; ownership retained")?
}

pub async fn peer_proof_handler(
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Some(nonce) = query
        .get("nonce")
        .filter(|nonce| nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return axum::http::StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(key) = std::env::var(PROOF_ENV) else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    if std::env::var(WORKER_ENV).as_deref() != Ok("1") || key.len() != 64 {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        EXECUTION_IDENTITY
            .get()
            .map(|record| signed_identity(record, "peer", nonce))
            .unwrap_or_else(|| peer_proof(&key, nonce)),
    )
        .into_response()
}

/// The host this facade forwards to. It changes only when the current host is
/// gone: replaced by `--restart-dev-execution`, or crashed and respawned.
struct ForwardTarget {
    config: ExecutionConfig,
    current: tokio::sync::Mutex<WorkerRecord>,
    respawn: std::sync::Mutex<RespawnBackoff>,
}
/// Starting a host copies the whole debug binary, so a build that crashes at
/// boot must not be restarted for every health poll. Adopting a host that a
/// restart already started is never delayed.
#[derive(Default)]
struct RespawnBackoff {
    not_before: Option<tokio::time::Instant>,
    /// Replacements that failed or died soon after starting, in a row.
    failures: u32,
    last_started: Option<tokio::time::Instant>,
}
const RESPAWN_BACKOFF: Duration = Duration::from_secs(3);
const MAX_RESPAWN_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// A replacement that lives at least this long counts as healthy.
const RESPAWN_HEALTHY_AFTER: Duration = Duration::from_secs(60);
impl RespawnBackoff {
    fn allows(&self, now: tokio::time::Instant) -> bool {
        self.not_before.is_none_or(|not_before| now >= not_before)
    }
    /// Called before a replacement attempt: the previous replacement, if any,
    /// has just been found dead.
    fn record_attempt(&mut self, now: tokio::time::Instant) {
        if self
            .last_started
            .is_some_and(|started| now.duration_since(started) < RESPAWN_HEALTHY_AFTER)
        {
            self.failures = self.failures.saturating_add(1);
        } else {
            self.failures = 0;
        }
        self.last_started = Some(now);
        let delay = RESPAWN_BACKOFF
            .saturating_mul(2u32.saturating_pow(self.failures.min(16)))
            .min(MAX_RESPAWN_BACKOFF);
        self.not_before = Some(now + delay);
    }
}
impl ForwardTarget {
    async fn live_worker(self: &std::sync::Arc<Self>) -> Result<WorkerRecord> {
        {
            let current = self.current.lock().await;
            if worker_is_alive(&current) {
                return Ok(current.clone());
            }
        }
        // Its own task: the caller's connect timeout must not drop a respawn
        // halfway, which would kill the new host before it publishes ownership.
        let target = std::sync::Arc::clone(self);
        tokio::spawn(async move { target.replace_stopped_worker().await })
            .await
            .context("execution reattach task")?
    }
    async fn replace_stopped_worker(&self) -> Result<WorkerRecord> {
        let mut current = self.current.lock().await;
        if worker_is_alive(&current) {
            return Ok(current.clone());
        }
        let now = tokio::time::Instant::now();
        let respawn = match self.respawn.lock() {
            Ok(mut backoff) if backoff.allows(now) => {
                backoff.record_attempt(now);
                Respawn::AfterCrash
            }
            _ => Respawn::Never,
        };
        let record = reattach_worker(&self.config, respawn).await?;
        crate::log_rotation::write_diagnostic(format!(
            "[dev] Core listener {} reattached to execution PID {} at {}",
            self.config.public_bind, record.pid, record.private_bind
        ));
        *current = record.clone();
        Ok(record)
    }
}

/// Header the facade adds to a relayed identity challenge: the canonical local
/// address of the client connection it accepted (`core_identity.rs`).
pub const RELAYED_LOCAL_ADDR_HEADER: &str = "x-ryu-dev-execution-local-addr";
/// MAC over [`RELAYED_LOCAL_ADDR_HEADER`] and the challenge nonce, keyed by the
/// facade/worker proof key.
pub const RELAYED_LOCAL_PROOF_HEADER: &str = "x-ryu-dev-execution-local-proof";
const IDENTITY_TARGET_PREFIX: &str = "/api/health/identity?";
const IDENTITY_REQUEST_PREFIX: &[u8] = b"GET /api/health/identity?";
const RELAY_HEAD_LIMIT: usize = 8192;

fn relayed_local_mac(key: &str, local: &str, nonce: &str) -> String {
    ryu_crypto::hmac_sha256_hex(
        key.as_bytes(),
        format!("ryu-dev-execution-core-identity-v1:{local}:{nonce}").as_bytes(),
    )
}

/// What a dev execution worker makes of the facade's identity tag.
#[derive(Debug, PartialEq, Eq)]
pub enum RelayedLocal {
    /// No tag: prove the connection's own local address.
    Absent,
    /// The facade accepted the client on this address.
    Verified(SocketAddr),
    /// A tag that is duplicated, malformed, unkeyed or forged.
    Rejected,
}

/// Verify the facade's tag on an identity challenge. Only the facade and its
/// worker hold `key`, so nothing else can make the worker prove an address
/// other than the private one its connection was accepted on.
pub fn relayed_local_addr(
    headers: &axum::http::HeaderMap,
    nonce: Option<&str>,
    key: Option<&str>,
) -> RelayedLocal {
    let addrs: Vec<_> = headers.get_all(RELAYED_LOCAL_ADDR_HEADER).iter().collect();
    let proofs: Vec<_> = headers.get_all(RELAYED_LOCAL_PROOF_HEADER).iter().collect();
    if addrs.is_empty() && proofs.is_empty() {
        return RelayedLocal::Absent;
    }
    let ([addr], [proof], Some(key), Some(nonce)) =
        (addrs.as_slice(), proofs.as_slice(), key, nonce)
    else {
        return RelayedLocal::Rejected;
    };
    let (Ok(addr), Ok(proof)) = (addr.to_str(), proof.to_str()) else {
        return RelayedLocal::Rejected;
    };
    let Ok(local) = addr.parse::<SocketAddr>() else {
        return RelayedLocal::Rejected;
    };
    let canonical = crate::server::core_identity::canonical_local_addr(local);
    if canonical != addr
        || !local.ip().to_canonical().is_loopback()
        || !proof_matches(proof, &relayed_local_mac(key, &canonical, nonce))
    {
        return RelayedLocal::Rejected;
    }
    RelayedLocal::Verified(local)
}

/// The facade's key, only inside a dev execution worker.
pub fn worker_relay_key() -> Option<String> {
    let key = std::env::var(PROOF_ENV).ok()?;
    (std::env::var(WORKER_ENV).as_deref() == Ok("1") && key.len() == 64).then_some(key)
}

fn head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// The nonce of an origin-form `GET /api/health/identity?nonce=<64 hex>`.
fn identity_nonce(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split(' ');
    let (Some("GET"), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let query = target.strip_prefix(IDENTITY_TARGET_PREFIX)?;
    let mut nonces = query
        .split('&')
        .filter_map(|pair| pair.strip_prefix("nonce="));
    let nonce = nonces.next()?;
    (nonces.next().is_none()
        && nonce.len() == 64
        && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(nonce)
}

/// Tag a buffered identity challenge with the address the facade accepted it
/// on. Any tag the client sent is dropped first. Anything else is returned
/// byte for byte.
fn tag_identity_challenge(buffered: Vec<u8>, local: SocketAddr, key: &str) -> Vec<u8> {
    let Some(end) = head_end(&buffered) else {
        return buffered;
    };
    let Ok(head) = std::str::from_utf8(&buffered[..end]) else {
        return buffered;
    };
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let Some(nonce) = identity_nonce(request_line) else {
        return buffered;
    };
    let local_text = crate::server::core_identity::canonical_local_addr(local);
    let mut tagged = format!("{request_line}\r\n");
    for line in lines {
        let name = line.split_once(':').map_or("", |(name, _)| name.trim());
        if name.eq_ignore_ascii_case(RELAYED_LOCAL_ADDR_HEADER)
            || name.eq_ignore_ascii_case(RELAYED_LOCAL_PROOF_HEADER)
        {
            continue;
        }
        tagged.push_str(line);
        tagged.push_str("\r\n");
    }
    tagged.push_str(&format!(
        "{RELAYED_LOCAL_ADDR_HEADER}: {local_text}\r\n{RELAYED_LOCAL_PROOF_HEADER}: {}\r\n\r\n",
        relayed_local_mac(key, &local_text, nonce)
    ));
    let mut bytes = tagged.into_bytes();
    bytes.extend_from_slice(&buffered[end + 4..]);
    bytes
}

/// Read the start of a client's first request: as soon as it cannot be Core's
/// identity challenge, or once its head is complete, return what was read
/// (tagged when it is the challenge) so it is relayed ahead of the rest.
async fn first_request(
    client: &mut TcpStream,
    local: Option<SocketAddr>,
    key: &str,
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut buffered = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let compared = buffered.len().min(IDENTITY_REQUEST_PREFIX.len());
        if buffered[..compared] != IDENTITY_REQUEST_PREFIX[..compared] {
            return Ok(buffered);
        }
        if head_end(&buffered).is_some() {
            return Ok(match local {
                Some(local) => tag_identity_challenge(buffered, local, key),
                None => buffered,
            });
        }
        // A bare-LF head (which hyper also accepts) is relayed untagged rather
        // than waited on, and so proves only the worker's private address.
        if buffered.len() >= RELAY_HEAD_LIMIT || buffered.windows(2).any(|pair| pair == b"\n\n") {
            return Ok(buffered);
        }
        let read = client.read(&mut chunk).await?;
        if read == 0 {
            return Ok(buffered);
        }
        buffered.extend_from_slice(&chunk[..read]);
    }
}

/// Byte-transparent, backpressured transport for HTTP, streaming and WebSockets.
/// The normal host middleware continues to authenticate every request. The one
/// exception is a leading `/api/health/identity` challenge, which is tagged
/// with the address this listener accepted the client on so the worker proves
/// the address the client dialed (`core_identity.rs`), not its private one.
pub async fn serve(
    listener: TcpListener,
    worker: WorkerRecord,
    config: ExecutionConfig,
) -> Result<()> {
    if !worker.private_bind.ip().is_loopback() || worker.proof_key.len() != 64 {
        bail!("execution forwarding requires loopback");
    }
    let target = std::sync::Arc::new(ForwardTarget {
        config,
        current: tokio::sync::Mutex::new(worker),
        respawn: std::sync::Mutex::new(RespawnBackoff::default()),
    });
    loop {
        let (mut client, _) = listener.accept().await?;
        let target = std::sync::Arc::clone(&target);
        tokio::spawn(async move {
            let connect = async {
                let worker = target.live_worker().await?;
                if !worker.private_bind.ip().is_loopback() || worker.proof_key.len() != 64 {
                    bail!("execution forwarding requires loopback");
                }
                let mut stream = TcpStream::connect(worker.private_bind).await?;
                verify_peer_identity(&mut stream, &worker.proof_key, Some(&worker)).await?;
                Ok::<_, anyhow::Error>((stream, worker.proof_key))
            };
            match tokio::time::timeout(Duration::from_secs(2), connect).await {
                Ok(Ok((mut execution, proof_key))) => {
                    use tokio::io::AsyncWriteExt;
                    let _ = client.set_nodelay(true);
                    let _ = execution.set_nodelay(true);
                    let local = client.local_addr().ok();
                    let Ok(first) = first_request(&mut client, local, &proof_key).await else {
                        return;
                    };
                    if execution.write_all(&first).await.is_err() {
                        return;
                    }
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut execution).await;
                }
                _ => {
                    use tokio::io::AsyncWriteExt;
                    let _ = client.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                }
            }
        });
    }
}
pub async fn run_if_enabled() -> Result<bool> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let stop_requested = args.iter().any(|argument| argument == STOP_FLAG);
    let restart_requested = !stop_requested && args.iter().any(|argument| argument == RESTART_FLAG);
    if !stop_requested && (!cfg!(debug_assertions) || crate::profile::profile() != "dev") {
        if restart_requested {
            bail!("{RESTART_FLAG} needs a debug build on the dev profile");
        }
        return Ok(false);
    }
    let data_dir = crate::paths::ryu_dir();
    if stop_requested && !data_dir.exists() {
        return Ok(true);
    }
    std::fs::create_dir_all(&data_dir)?;
    let data_dir = std::fs::canonicalize(data_dir)?;
    if !stop_requested && !restart_requested && std::env::var(WORKER_ENV).as_deref() == Ok("1") {
        let identity =
            tokio::time::timeout(Duration::from_secs(5), publish_worker_identity(&data_dir))
                .await
                .context("execution bootstrap publication timed out")??;
        // If the spawning facade dies before publication, exit before opening stores.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if read_record(&data_dir)?
                .is_some_and(|record| record == identity && worker_is_alive(&record))
            {
                EXECUTION_IDENTITY
                    .set(identity)
                    .map_err(|_| anyhow::anyhow!("execution identity already initialized"))?;
                std::env::remove_var(BOOTSTRAP_ENV);
                std::env::remove_var(BOOTSTRAP_NONCE_ENV);
                std::env::remove_var(PUBLIC_BIND_ENV);
                return Ok(false);
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("execution ownership was not published");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let bind = args
        .iter()
        .find_map(|argument| {
            argument
                .to_str()?
                .strip_prefix("--bind=")
                .map(str::to_owned)
        })
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_else(|| format!("127.0.0.1:{}", crate::profile::port(7980)));
    let public_bind: SocketAddr = bind
        .parse()
        .context("dev listener requires an IP address and port")?;
    if !public_bind.ip().is_loopback() {
        bail!("independent dev execution requires a loopback listener");
    }
    let config = ExecutionConfig {
        data_dir,
        public_bind,
        executable: std::env::current_exe()?,
        args,
    };
    if stop_requested {
        stop_worker(&config).await?;
        return Ok(true);
    }
    if restart_requested {
        let idle_wait = if config.args.iter().any(|arg| arg == RESTART_NOW_FLAG) {
            Duration::ZERO
        } else {
            restart_idle_wait()
        };
        restart_worker(&config, idle_wait).await?;
        return Ok(true);
    }
    let listener = TcpListener::bind(public_bind)
        .await
        .context("bind replaceable dev listener")?;
    let record = ensure_worker(&config).await?;
    crate::log_rotation::write_diagnostic(format!(
        "[dev] Core listener {public_bind} attached to execution PID {} at {}; listener reload preserves turns",
        record.pid, record.private_bind
    ));
    serve(listener, record, config).await?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn peer_challenge_rejects_impostor_before_any_credentials_are_sent() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            assert!(!String::from_utf8_lossy(&request).contains("Authorization"));
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{}",
                        "0".repeat(64)
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut next = [0u8; 1];
            assert_eq!(stream.read(&mut next).await.unwrap(), 0);
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        assert!(verify_peer(&mut stream, &"secret".repeat(12))
            .await
            .is_err());
        drop(stream);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn authenticated_socket_remains_available_for_http_and_websocket_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = "fixture-execution-key";
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let text = String::from_utf8(request).unwrap();
            let nonce = text
                .split("nonce=")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap();
            let proof = peer_proof(key, nonce);
            stream
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{proof}").as_bytes(),
                )
                .await
                .unwrap();
            let mut data = [0u8; 4];
            stream.read_exact(&mut data).await.unwrap();
            stream.write_all(&data).await.unwrap();
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        verify_peer(&mut stream, key).await.unwrap();
        stream.write_all(b"data").await.unwrap();
        let mut echoed = [0u8; 4];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"data");
        task.await.unwrap();
    }

    fn stopped_worker_fixture() -> (tempfile::TempDir, ExecutionConfig, WorkerRecord) {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = std::fs::canonicalize(temporary.path()).unwrap();
        let root = execution_root(&data_dir);
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("host.exe");
        std::fs::write(&executable, b"stopped host fixture").unwrap();
        let config = ExecutionConfig {
            data_dir: data_dir.clone(),
            public_bind: "127.0.0.1:8980".parse().unwrap(),
            executable: executable.clone(),
            args: vec![],
        };
        let record = WorkerRecord {
            version: RECORD_VERSION,
            pid: u32::MAX,
            executable,
            start_time: 1,
            private_bind: "127.0.0.1:12345".parse().unwrap(),
            data_dir,
            public_bind: config.public_bind,
            proof_key: "0".repeat(64),
        };
        (temporary, config, record)
    }

    #[tokio::test]
    async fn lifecycle_lease_excludes_competing_launchers_and_releases_on_drop() {
        let (_temporary, config, _) = stopped_worker_fixture();
        let lease = lifecycle_lease(&config.data_dir, Duration::from_secs(1))
            .await
            .unwrap();
        let competing = lifecycle_lease(&config.data_dir, Duration::from_millis(40)).await;
        assert!(
            competing.is_err(),
            "a second launcher cannot acquire ownership"
        );
        drop(lease);
        assert!(lifecycle_lease(&config.data_dir, Duration::from_secs(1))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn stop_waits_for_receipt_publication_and_duplicate_stop_succeeds() {
        let (_temporary, config, record) = stopped_worker_fixture();
        // A launcher owns the lease before it publishes worker.json. Stop must
        // wait rather than treat this publication window as "no worker".
        let launching = lifecycle_lease(&config.data_dir, Duration::from_secs(1))
            .await
            .unwrap();
        let stop_config = config.clone();
        let first = tokio::spawn(async move { stop_worker(&stop_config).await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !first.is_finished(),
            "stop must wait for the launcher lease"
        );
        persist_record(&record).unwrap();
        drop(launching);
        let second = stop_worker(&config);
        let (first, second) = tokio::join!(first, second);
        first.unwrap().unwrap();
        second.unwrap();
        assert!(read_record(&config.data_dir).unwrap().is_none());
    }

    #[test]
    fn stale_stopper_keeps_replacement_receipt() {
        let (_temporary, config, original) = stopped_worker_fixture();
        let mut replacement = original.clone();
        replacement.start_time += 1;
        persist_record(&replacement).unwrap();
        assert!(remove_stopped_record(&original).is_err());
        assert_eq!(
            read_record(&config.data_dir).unwrap(),
            Some(replacement.clone())
        );
        remove_stopped_record(&replacement).unwrap();
        remove_stopped_record(&replacement).unwrap();
        assert!(read_record(&config.data_dir).unwrap().is_none());
    }

    #[test]
    #[ignore = "real protected execution subprocess fixture"]
    fn execution_host_fixture() {
        protected_execution_fixture(false);
    }

    #[test]
    #[ignore = "real protected execution subprocess with a TERM-resistant child"]
    fn execution_host_with_resistant_child_fixture() {
        protected_execution_fixture(true);
    }

    #[test]
    #[ignore = "protected child sends a receipt for a different bootstrap nonce"]
    fn execution_host_invalid_nonce_fixture() {
        invalid_bootstrap_fixture(true);
    }

    #[test]
    #[ignore = "protected child sends a receipt for a different data directory"]
    fn execution_host_invalid_directory_fixture() {
        invalid_bootstrap_fixture(false);
    }

    fn invalid_bootstrap_fixture(nonce: bool) {
        ryu_gw_credentials::protect_process_environment().unwrap();
        let data_dir = crate::paths::ryu_dir();
        std::fs::write(
            data_dir.join("invalid-bootstrap.pid"),
            std::process::id().to_string(),
        )
        .unwrap();
        if nonce {
            std::env::set_var(BOOTSTRAP_NONCE_ENV, "0".repeat(64));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            publish_worker_identity(&if nonce {
                data_dir
            } else {
                data_dir.join("wrong-directory")
            })
            .await
            .unwrap();
            // Remain alive so the parent must actually reap rejected startup.
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
    }

    fn protected_execution_fixture(resistant_child: bool) {
        ryu_gw_credentials::protect_process_environment().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert!(!run_if_enabled().await.unwrap());
            #[cfg(target_os = "linux")]
            assert_eq!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE) }, 0);
            if resistant_child {
                let marker = crate::paths::state_path("resistant-child.pid");
                let mut command = Command::new("sh");
                command
                    .args([
                        "-c",
                        "trap '' TERM; printf '%s' \"$$\" > \"$1\"; exec sleep 30",
                        "fixture",
                    ])
                    .arg(marker)
                    .env_remove(PROOF_ENV)
                    .env_remove(BOOTSTRAP_NONCE_ENV)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let _child = command.spawn().unwrap();
            }
            let listener = TcpListener::bind(std::env::var("RYU_BIND").unwrap())
                .await
                .unwrap();
            let router = axum::Router::new()
                .route(
                    "/internal/dev-execution/peer-proof",
                    axum::routing::get(peer_proof_handler),
                )
                .route(
                    "/internal/dev-execution/stop",
                    axum::routing::post(stop_handler),
                )
                .route(
                    ACTIVITY_PATH,
                    axum::routing::get(
                        |axum::extract::Query(query): axum::extract::Query<
                            std::collections::HashMap<String, String>,
                        >| async move {
                            activity_response(&query, FIXTURE_RUNNING_TURNS)
                        },
                    ),
                );
            axum::serve(listener, router).await.unwrap();
        });
    }

    struct ProtectedFixtureDirectory {
        _directory: tempfile::TempDir,
        #[cfg(target_os = "linux")]
        host: File,
    }
    impl Drop for ProtectedFixtureDirectory {
        fn drop(&mut self) {
            // Preserve the already authenticated, original kernel handle so an
            // assertion panic cannot leak a protected host or target a reused PID.
            #[cfg(target_os = "linux")]
            {
                let _ = signal_worker_group(&self.host, libc::SIGKILL);
            }
        }
    }

    async fn protected_fixture(
        name: &str,
    ) -> (ProtectedFixtureDirectory, ExecutionConfig, WorkerRecord) {
        let (temporary, mut config, _) = stopped_worker_fixture();
        config.executable = std::env::current_exe().unwrap();
        config.args = vec![
            "--exact".into(),
            format!("dev_execution::tests::{name}").into(),
            "--ignored".into(),
            "--nocapture".into(),
        ];
        let record = ensure_worker(&config).await.unwrap();
        wait_until_ready(&record).await;
        let directory = ProtectedFixtureDirectory {
            _directory: temporary,
            #[cfg(target_os = "linux")]
            host: open_worker_handle(&record).unwrap(),
        };
        (directory, config, record)
    }

    async fn wait_until_ready(record: &WorkerRecord) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if authenticate_worker(record).await.is_ok() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "protected host failed to become ready"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn host_start_prunes_only_earlier_version_copies() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let keep = root.join(uuid::Uuid::new_v4().to_string());
        let stale = root.join(uuid::Uuid::new_v4().to_string());
        for directory in [&keep, &stale, &root.join("not-a-version")] {
            std::fs::create_dir(directory).unwrap();
            std::fs::write(directory.join("ryu-execution-host"), b"copy").unwrap();
        }
        std::fs::write(root.join("execution.log"), b"log").unwrap();
        prune_stale_versions(root, &keep);
        assert!(keep.join("ryu-execution-host").exists());
        assert!(!stale.exists());
        assert!(root.join("not-a-version").exists());
        assert!(root.join("execution.log").exists());
    }

    #[tokio::test]
    async fn a_failed_host_start_leaves_no_version_copy_behind() {
        let temporary = tempfile::tempdir().unwrap();
        let config = ExecutionConfig {
            data_dir: temporary.path().to_path_buf(),
            public_bind: "127.0.0.1:8980".parse().unwrap(),
            // The copy of a missing executable fails after the directory exists.
            executable: temporary.path().join("missing-core"),
            args: vec![],
        };
        let error = attach_or_spawn(&config, Respawn::Always, Duration::from_secs(5)).await;
        assert!(error.is_err());
        let leftovers = std::fs::read_dir(execution_root(&config.data_dir))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .count();
        assert_eq!(leftovers, 0, "the version directory must be removed");
    }

    #[test]
    fn respawn_backoff_grows_only_while_replacements_die_quickly() {
        let start = tokio::time::Instant::now();
        let mut backoff = RespawnBackoff::default();
        assert!(backoff.allows(start));
        backoff.record_attempt(start);
        assert_eq!(backoff.failures, 0);
        assert!(!backoff.allows(start + Duration::from_secs(2)));
        assert!(backoff.allows(start + RESPAWN_BACKOFF));
        // The replacement died within a minute: the next wait doubles.
        let second = start + Duration::from_secs(10);
        backoff.record_attempt(second);
        assert_eq!(backoff.failures, 1);
        assert!(!backoff.allows(second + RESPAWN_BACKOFF));
        assert!(backoff.allows(second + RESPAWN_BACKOFF * 2));
        for step in 0..20 {
            backoff.record_attempt(second + Duration::from_secs(step));
        }
        assert!(backoff.allows(second + Duration::from_secs(19) + MAX_RESPAWN_BACKOFF));
        // A replacement that stayed up resets the count.
        let later = second + Duration::from_secs(19) + RESPAWN_HEALTHY_AFTER;
        backoff.record_attempt(later);
        assert_eq!(backoff.failures, 0);
    }

    /// The protected fixture host always reports this many live turns.
    const FIXTURE_RUNNING_TURNS: usize = 3;

    #[tokio::test]
    async fn activity_is_reported_only_to_the_receipt_holder() {
        let (_temporary, config, record) = protected_fixture("execution_host_fixture").await;
        assert_eq!(
            query_activity(&record).await.unwrap(),
            FIXTURE_RUNNING_TURNS
        );
        let mut forged = record.clone();
        forged.proof_key = "f".repeat(64);
        assert!(query_activity(&forged).await.is_err());
        stop_worker(&config).await.unwrap();
    }

    #[tokio::test]
    async fn restart_waits_for_bounded_idle_then_facade_reattaches_to_new_host() {
        let (_temporary, config, record) = protected_fixture("execution_host_fixture").await;
        let target = std::sync::Arc::new(ForwardTarget {
            config: config.clone(),
            current: tokio::sync::Mutex::new(record.clone()),
            respawn: std::sync::Mutex::new(RespawnBackoff::default()),
        });
        // The fixture never goes idle, so the restart proceeds at the bound.
        let started = tokio::time::Instant::now();
        restart_worker(&config, Duration::from_secs(3))
            .await
            .unwrap();
        assert!(started.elapsed() >= Duration::from_secs(3));
        assert!(!worker_is_alive(&record));
        let replacement = read_record(&config.data_dir).unwrap().unwrap();
        assert_ne!(replacement, record);
        assert!(worker_is_alive(&replacement));
        // The facade adopts the replacement only once it passes authentication.
        wait_until_ready(&replacement).await;
        assert_eq!(target.live_worker().await.unwrap(), replacement);
        assert_eq!(
            query_activity(&replacement).await.unwrap(),
            FIXTURE_RUNNING_TURNS
        );
        stop_worker(&config).await.unwrap();
        assert!(!worker_is_alive(&replacement));
    }

    #[tokio::test]
    async fn facade_stays_down_after_an_explicit_stop() {
        let (_temporary, config, record) = protected_fixture("execution_host_fixture").await;
        stop_worker(&config).await.unwrap();
        let error = reattach_worker(&config, Respawn::AfterCrash)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("stopped explicitly"),
            "{error:#}"
        );
        assert!(read_record(&config.data_dir).unwrap().is_none());
        assert!(!worker_is_alive(&record));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn facade_respawns_a_crashed_host() {
        let (directory, config, record) = protected_fixture("execution_host_fixture").await;
        signal_worker_group(&directory.host, libc::SIGKILL).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while worker_group_is_alive(&directory.host, record.pid).unwrap() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "host survived SIGKILL"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // While backing off, a crashed host is not replaced.
        assert!(reattach_worker(&config, Respawn::Never).await.is_err());
        assert_eq!(read_record(&config.data_dir).unwrap(), Some(record.clone()));
        let target = std::sync::Arc::new(ForwardTarget {
            config: config.clone(),
            current: tokio::sync::Mutex::new(record.clone()),
            respawn: std::sync::Mutex::new(RespawnBackoff::default()),
        });
        let replacement = target.live_worker().await.unwrap();
        assert_ne!(replacement, record);
        assert!(worker_is_alive(&replacement));
        assert_eq!(
            read_record(&config.data_dir).unwrap(),
            Some(replacement.clone())
        );
        wait_until_ready(&replacement).await;
        stop_worker(&config).await.unwrap();
        assert!(!worker_is_alive(&replacement));
    }

    #[tokio::test]
    async fn protected_host_bootstrap_reconnect_and_verified_shutdown() {
        let (_temporary, config, record) = protected_fixture("execution_host_fixture").await;
        assert_eq!(process_generation(record.pid), Some(record.start_time));
        #[cfg(target_os = "linux")]
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(
                std::fs::read_link(format!("/proc/{}/exe", record.pid))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        assert_eq!(ensure_worker(&config).await.unwrap(), record);
        stop_worker(&config).await.unwrap();
        assert!(!worker_is_alive(&record));
        assert!(read_record(&config.data_dir).unwrap().is_none());
        stop_worker(&config).await.unwrap();
    }

    #[tokio::test]
    async fn rejected_bootstrap_reaps_real_protected_child_without_publishing_owner() {
        for name in [
            "execution_host_invalid_nonce_fixture",
            "execution_host_invalid_directory_fixture",
        ] {
            let (_temporary, mut config, _) = stopped_worker_fixture();
            config.executable = std::env::current_exe().unwrap();
            config.args = vec![
                "--exact".into(),
                format!("dev_execution::tests::{name}").into(),
                "--ignored".into(),
                "--nocapture".into(),
            ];
            let error = ensure_worker(&config).await.unwrap_err();
            assert!(error.to_string().contains("bootstrap"), "{error:#}");
            assert!(read_record(&config.data_dir).unwrap().is_none());
            let pid = std::fs::read_to_string(config.data_dir.join("invalid-bootstrap.pid"))
                .unwrap()
                .parse::<u32>()
                .unwrap();
            assert!(
                process_generation(pid).is_none(),
                "rejected protected child survived startup"
            );
        }
    }

    #[tokio::test]
    async fn protected_host_rejects_mixed_identity_and_retains_ownership() {
        let (_temporary, config, original) = protected_fixture("execution_host_fixture").await;
        let original_bytes = std::fs::read(record_path(&config.data_dir)).unwrap();
        for field in [
            "executable",
            "public_bind",
            "private_bind",
            "data_dir",
            "start_time",
            "proof_key",
        ] {
            let mut altered = original.clone();
            match field {
                "executable" => {
                    altered.executable = original.executable.parent().unwrap().join("other-core")
                }
                "public_bind" => altered
                    .public_bind
                    .set_port(original.public_bind.port() + 1),
                "private_bind" => altered.private_bind.set_port(0),
                "data_dir" => altered.data_dir = config.data_dir.join("other-data"),
                "start_time" => altered.start_time += 1,
                "proof_key" => altered.proof_key = "f".repeat(64),
                _ => unreachable!(),
            }
            let mut stream = TcpStream::connect(original.private_bind).await.unwrap();
            assert!(
                verify_peer_identity(&mut stream, &altered.proof_key, Some(&altered))
                    .await
                    .is_err(),
                "real protected host authenticated mixed {field}"
            );
            // Corrupted bytes cannot authorize either replacement or shutdown.
            let mut value: serde_json::Value = serde_json::from_slice(&original_bytes).unwrap();
            value["identity"] = serde_json::to_value(&altered).unwrap();
            let bytes = serde_json::to_vec(&value).unwrap();
            std::fs::write(record_path(&config.data_dir), &bytes).unwrap();
            assert!(
                ensure_worker(&config).await.is_err(),
                "accepted corrupted {field}"
            );
            assert!(
                stop_worker(&config).await.is_err(),
                "stopped with corrupted {field}"
            );
            assert_eq!(std::fs::read(record_path(&config.data_dir)).unwrap(), bytes);
            assert!(worker_is_alive(&original));
            // Even a correctly encoded local receipt cannot make the real host
            // authenticate a different executable or key.
            if matches!(field, "executable" | "proof_key") {
                persist_record(&altered).unwrap();
                assert!(ensure_worker(&config).await.is_err());
                assert!(stop_worker(&config).await.is_err());
                assert!(worker_is_alive(&original));
            }
        }
        std::fs::write(record_path(&config.data_dir), &original_bytes).unwrap();
        stop_worker(&config).await.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn protected_legacy_receipt_cannot_replace_or_forget_live_host() {
        let (_temporary, config, original) = protected_fixture("execution_host_fixture").await;
        let mut legacy = original.clone();
        legacy.version = 2;
        persist_record(&legacy).unwrap();
        assert!(ensure_worker(&config)
            .await
            .unwrap_err()
            .to_string()
            .contains("legacy"));
        assert!(stop_worker(&config)
            .await
            .unwrap_err()
            .to_string()
            .contains("legacy"));
        assert_eq!(read_record(&config.data_dir).unwrap(), Some(legacy));
        assert!(worker_is_alive(&original));
        persist_record(&original).unwrap();
        stop_worker(&config).await.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn reused_generation_cannot_open_shutdown_handle() {
        let (_temporary, config, original) = protected_fixture("execution_host_fixture").await;
        let mut reused = original.clone();
        reused.start_time += 1;
        assert!(open_worker_handle(&reused).is_err());
        assert!(worker_is_alive(&original));
        stop_worker(&config).await.unwrap();
    }

    #[cfg(target_os = "linux")]
    async fn resistant_child_fixture() -> (
        ProtectedFixtureDirectory,
        ExecutionConfig,
        WorkerRecord,
        u32,
    ) {
        let (temporary, config, record) =
            protected_fixture("execution_host_with_resistant_child_fixture").await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(text) = std::fs::read_to_string(ryu_sidecar_runtime::layout::state_path(
                &config.data_dir,
                "resistant-child.pid",
            )) {
                if let Ok(pid) = text.parse::<u32>() {
                    if process_generation(pid).is_some() {
                        return (temporary, config, record, pid);
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "resistant child never became ready"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn stop_escalates_resistant_child_after_leader_exits() {
        let (_temporary, config, record, child) = resistant_child_fixture().await;
        stop_worker(&config).await.unwrap();
        assert!(
            process_generation(child).is_none(),
            "TERM-resistant execution survived leader exit"
        );
        assert!(!worker_is_alive(&record));
        assert!(read_record(&config.data_dir).unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn crashed_leader_with_live_tools_cannot_be_replaced_or_forgotten() {
        let (_temporary, config, record, child) = resistant_child_fixture().await;
        let handle = open_worker_handle(&record).unwrap();
        use std::os::fd::FromRawFd;
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, child, 0) };
        assert!(descriptor >= 0);
        let child_handle = unsafe { File::from_raw_fd(descriptor as i32) };
        assert_eq!(unsafe { libc::getpgid(child as i32) }, record.pid as i32);
        signal_process(&handle, libc::SIGKILL).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while worker_is_alive(&record) {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(process_generation(child).is_some());
        assert!(ensure_worker(&config).await.is_err());
        assert!(stop_worker(&config).await.is_err());
        assert_eq!(read_record(&config.data_dir).unwrap(), Some(record.clone()));
        // The test retained its original child handle before the crash.
        signal_process(&child_handle, libc::SIGKILL).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while process_generation(child).is_some() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        stop_worker(&config).await.unwrap();
        assert!(read_record(&config.data_dir).unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn protected_stop_rejects_peer_oracle_and_mixed_identity_then_replay() {
        let (_temporary, config, original, child) = resistant_child_fixture().await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let nonce = "a".repeat(64);
        let base = format!("http://{}", original.private_bind);
        let peer = client
            .get(format!(
                "{base}/internal/dev-execution/peer-proof?nonce={nonce}"
            ))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!(
                        "{base}/internal/dev-execution/stop?nonce={nonce}&proof={peer}"
                    ))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                reqwest::StatusCode::FORBIDDEN
            );
            assert!(worker_is_alive(&original));
            assert!(process_generation(child).is_some());
        }
        for field in [
            "pid",
            "executable",
            "private_bind",
            "public_bind",
            "data_dir",
            "start_time",
            "proof_key",
        ] {
            let mut wrong = original.clone();
            match field {
                "pid" => wrong.pid += 1,
                "executable" => wrong.executable = wrong.executable.with_extension("other"),
                "private_bind" => wrong.private_bind.set_port(0),
                "public_bind" => wrong.public_bind.set_port(0),
                "data_dir" => wrong.data_dir = wrong.data_dir.join("other"),
                "start_time" => wrong.start_time += 1,
                "proof_key" => wrong.proof_key = "0".repeat(64),
                _ => unreachable!(),
            }
            let proof = signed_identity(&wrong, "stop", &nonce);
            assert_eq!(
                client
                    .post(format!(
                        "{base}/internal/dev-execution/stop?nonce={nonce}&proof={proof}"
                    ))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                reqwest::StatusCode::FORBIDDEN,
                "accepted mixed {field}"
            );
            assert!(worker_is_alive(&original));
        }
        let proof = signed_identity(&original, "stop", &nonce);
        assert!(
            client
                .post(format!(
                    "{base}/internal/dev-execution/stop?nonce={nonce}&proof={proof}"
                ))
                .send()
                .await
                .is_err(),
            "synchronous group kill should close without an HTTP response"
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while worker_is_alive(&original) || process_generation(child).is_some() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let replacement = ensure_worker(&config).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while authenticate_worker(&replacement).await.is_err() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_ne!(replacement.proof_key, original.proof_key);
        assert_eq!(
            client
                .post(format!(
                    "http://{}/internal/dev-execution/stop?nonce={nonce}&proof={proof}",
                    replacement.private_bind
                ))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
        assert!(worker_is_alive(&replacement));
        stop_worker(&config).await.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn older_kernel_pinned_members_shutdown_kills_resistant_child() {
        let (_temporary, config, record, child) = resistant_child_fixture().await;
        let handle = open_worker_handle(&record).unwrap();
        authenticate_worker(&record).await.unwrap();
        stop_worker_group_legacy(&handle, &record).await.unwrap();
        assert!(process_generation(child).is_none());
        assert!(!worker_is_alive(&record));
        remove_stopped_record(&record).unwrap();
        assert!(read_record(&config.data_dir).unwrap().is_none());
    }

    #[test]
    fn process_display_path_matches_its_canonical_execution_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let host_dir = execution_root(temporary.path());
        std::fs::create_dir_all(&host_dir).unwrap();
        let host = host_dir.join("host.exe");
        std::fs::write(&host, b"synthetic executable").unwrap();
        let config = ExecutionConfig {
            data_dir: std::fs::canonicalize(temporary.path()).unwrap(),
            public_bind: "127.0.0.1:8980".parse().unwrap(),
            executable: PathBuf::from("core"),
            args: vec![],
        };
        let record = WorkerRecord {
            version: RECORD_VERSION,
            pid: std::process::id(),
            executable: host,
            start_time: 1,
            private_bind: "127.0.0.1:12345".parse().unwrap(),
            data_dir: config.data_dir.clone(),
            public_bind: config.public_bind,
            proof_key: "0".repeat(64),
        };
        assert!(validate_record(&record, &config).is_ok());
        assert_eq!(
            normalized_path(&record.executable),
            std::fs::canonicalize(&record.executable).unwrap()
        );
        let mut outside = record.clone();
        outside.executable = host_dir.join("../outside.exe");
        std::fs::write(&outside.executable, b"outside execution directory").unwrap();
        assert!(validate_record(&outside, &config).is_err());
    }
    #[test]
    fn mismatched_node_or_public_worker_fails_closed() {
        let config = ExecutionConfig {
            data_dir: PathBuf::from("node-a"),
            public_bind: "127.0.0.1:8980".parse().unwrap(),
            executable: PathBuf::from("core"),
            args: vec![],
        };
        let mut record = WorkerRecord {
            version: RECORD_VERSION,
            pid: std::process::id(),
            executable: execution_root(&config.data_dir).join("host"),
            start_time: 1,
            private_bind: "127.0.0.1:12345".parse().unwrap(),
            data_dir: config.data_dir.clone(),
            public_bind: config.public_bind,
            proof_key: "0".repeat(64),
        };
        assert!(validate_record(&record, &config).is_ok());
        record.private_bind = "0.0.0.0:12345".parse().unwrap();
        assert!(validate_record(&record, &config).is_err());
        record.private_bind = "127.0.0.1:12345".parse().unwrap();
        record.data_dir = PathBuf::from("node-b");
        assert!(validate_record(&record, &config).is_err());
        assert!(!worker_is_alive(&record));
    }

    // ── Core identity through the dev facade ─────────────────────────────────

    const IDENTITY_TOKEN: &str = "fixture-node-token";
    const RELAY_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const NONCE_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NONCE_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// A worker router with Core's real identity wiring (`identity_response`,
    /// `expose_connection_addrs`, `ConnectionAddrs`) and a fixed token and key
    /// in place of the process-wide ones.
    async fn spawn_identity_worker(public_bind: SocketAddr) -> WorkerRecord {
        use crate::server::core_identity::{
            expose_connection_addrs, identity_response, ConnectionAddrs, LocalAddr,
        };
        use axum::extract::Query;
        use axum::http::HeaderMap;
        use axum::Extension;
        use std::collections::HashMap;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pid = std::process::id();
        let record = WorkerRecord {
            version: RECORD_VERSION,
            pid,
            executable: std::env::current_exe().unwrap(),
            start_time: process_generation(pid).unwrap(),
            private_bind: listener.local_addr().unwrap(),
            data_dir: PathBuf::from("identity-fixture"),
            public_bind,
            proof_key: RELAY_KEY.into(),
        };
        let peer_record = record.clone();
        let router = axum::Router::new()
            .route(
                "/internal/dev-execution/peer-proof",
                axum::routing::get(move |Query(query): Query<HashMap<String, String>>| {
                    let record = peer_record.clone();
                    async move {
                        signed_identity(
                            &record,
                            "peer",
                            query.get("nonce").map_or("", String::as_str),
                        )
                    }
                }),
            )
            .route(
                "/api/health/identity",
                axum::routing::get(
                    |local: Option<Extension<LocalAddr>>,
                     headers: HeaderMap,
                     Query(query): Query<HashMap<String, String>>| async move {
                        identity_response(
                            Some(IDENTITY_TOKEN.into()),
                            local.map(|Extension(LocalAddr(addr))| addr),
                            &headers,
                            query.get("nonce").map(String::as_str),
                            Some(RELAY_KEY),
                        )
                    },
                ),
            )
            .route(
                "/api/agents",
                axum::routing::get(|headers: HeaderMap| async move {
                    headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string()
                }),
            )
            .layer(axum::middleware::from_fn(expose_connection_addrs));
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<ConnectionAddrs>(),
            )
            .await
            .unwrap();
        });
        record
    }

    async fn read_response(stream: &mut TcpStream) -> (String, String) {
        use tokio::io::AsyncReadExt;
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        let head = String::from_utf8(head).unwrap();
        let length = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body).await.unwrap();
        let status = head.lines().next().unwrap_or_default().to_string();
        (status, String::from_utf8(body).unwrap())
    }

    /// Send an identity challenge on `stream`; the proof, or `None` when the
    /// listener refused to prove anything.
    async fn challenge(stream: &mut TcpStream, nonce: &str, extra: &str) -> Option<String> {
        use tokio::io::AsyncWriteExt;
        stream
            .write_all(
                format!(
                    "GET /api/health/identity?nonce={nonce} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let (status, body) = read_response(stream).await;
        if !status.starts_with("HTTP/1.1 200 ") {
            return None;
        }
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        Some(body["proof"].as_str().unwrap().to_string())
    }

    fn proof_for(address: SocketAddr, nonce: &str) -> String {
        crate::server::core_identity::identity_proof(IDENTITY_TOKEN, address, nonce)
    }

    /// The config a facade under test is handed. The fixture worker is alive and
    /// never respawned, so only the worker's own identity matters here.
    fn facade_config(worker: &WorkerRecord) -> ExecutionConfig {
        ExecutionConfig {
            data_dir: worker.data_dir.clone(),
            public_bind: worker.public_bind,
            executable: worker.executable.clone(),
            args: vec![],
        }
    }

    async fn spawn_relay(listener: TcpListener, upstream: SocketAddr) {
        tokio::spawn(async move {
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut upstream = TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });
    }

    /// A CLI holding the node token for the dev facade's public address gets a
    /// proof for that address (not the worker's private one), and its
    /// credentialed request then rides on the same relayed connection.
    #[tokio::test]
    async fn facade_proves_the_public_address_and_keeps_the_verified_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let public_bind = public.local_addr().unwrap();
        let worker = spawn_identity_worker(public_bind).await;
        assert!(worker_is_alive(&worker));
        tokio::spawn(serve(public, worker.clone(), facade_config(&worker)));

        let mut stream = TcpStream::connect(public_bind).await.unwrap();
        let proof = challenge(&mut stream, NONCE_A, "").await.unwrap();
        assert_eq!(proof, proof_for(public_bind, NONCE_A));
        assert_ne!(proof, proof_for(worker.private_bind, NONCE_A));
        stream
            .write_all(
                b"GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer node\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let (status, body) = read_response(&mut stream).await;
        assert!(status.starts_with("HTTP/1.1 200 "), "{status}");
        assert_eq!(body, "Bearer node");
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).await.unwrap();

        // A tag the client forges is replaced by the facade's own.
        let mut stream = TcpStream::connect(public_bind).await.unwrap();
        let forged = format!(
            "{RELAYED_LOCAL_ADDR_HEADER}: 127.0.0.2:{port}\r\n{RELAYED_LOCAL_PROOF_HEADER}: {}\r\n",
            "0".repeat(64),
            port = public_bind.port()
        );
        assert_eq!(
            challenge(&mut stream, NONCE_B, &forged).await.unwrap(),
            proof_for(public_bind, NONCE_B)
        );
    }

    /// A squatter on another loopback address at the facade's port, or one
    /// that reaches the worker directly (as after the facade stops), never
    /// obtains a proof for the address its own victim dialed.
    #[tokio::test]
    async fn squatters_cannot_borrow_the_facade_or_worker_proof() {
        let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let public_bind = public.local_addr().unwrap();
        let worker = spawn_identity_worker(public_bind).await;
        tokio::spawn(serve(public, worker.clone(), facade_config(&worker)));

        // Same port, another loopback address, relaying through the facade.
        let squat = TcpListener::bind(("127.0.0.2", public_bind.port()))
            .await
            .unwrap();
        let squat_bind = squat.local_addr().unwrap();
        spawn_relay(squat, public_bind).await;
        let mut stream = TcpStream::connect(squat_bind).await.unwrap();
        let proof = challenge(&mut stream, NONCE_A, "").await.unwrap();
        assert_ne!(proof, proof_for(squat_bind, NONCE_A));
        assert_eq!(proof, proof_for(public_bind, NONCE_A));

        // Straight to the worker: untagged it proves only its private address.
        let mut direct = TcpStream::connect(worker.private_bind).await.unwrap();
        let proof = challenge(&mut direct, NONCE_A, "").await.unwrap();
        assert_eq!(proof, proof_for(worker.private_bind, NONCE_A));
        assert_ne!(proof, proof_for(public_bind, NONCE_A));

        let public_text = crate::server::core_identity::canonical_local_addr(public_bind);
        let tag = |mac: String| {
            format!("{RELAYED_LOCAL_ADDR_HEADER}: {public_text}\r\n{RELAYED_LOCAL_PROOF_HEADER}: {mac}\r\n")
        };
        let refused = [
            // Wrong key.
            tag(relayed_local_mac(&"f".repeat(64), &public_text, NONCE_A)),
            // A tag for another nonce (replay).
            tag(relayed_local_mac(RELAY_KEY, &public_text, NONCE_B)),
            // No MAC.
            format!("{RELAYED_LOCAL_ADDR_HEADER}: {public_text}\r\n"),
            // Duplicated, even when one copy is valid.
            format!(
                "{}{}",
                tag(relayed_local_mac(RELAY_KEY, &public_text, NONCE_A)),
                tag(relayed_local_mac(RELAY_KEY, &public_text, NONCE_A))
            ),
        ];
        for extra in refused {
            let mut direct = TcpStream::connect(worker.private_bind).await.unwrap();
            assert_eq!(
                challenge(&mut direct, NONCE_A, &extra).await,
                None,
                "{extra}"
            );
        }
        // Only the key holder (the facade) can tag.
        let mut direct = TcpStream::connect(worker.private_bind).await.unwrap();
        assert_eq!(
            challenge(
                &mut direct,
                NONCE_A,
                &tag(relayed_local_mac(RELAY_KEY, &public_text, NONCE_A))
            )
            .await
            .unwrap(),
            proof_for(public_bind, NONCE_A)
        );
    }

    #[test]
    fn facade_tags_only_a_well_formed_identity_challenge() {
        let local: SocketAddr = "127.0.0.1:8980".parse().unwrap();
        for untouched in [
            b"GET /api/agents HTTP/1.1\r\nHost: x\r\n\r\n".to_vec(),
            format!("POST /api/health/identity?nonce={NONCE_A} HTTP/1.1\r\n\r\n").into_bytes(),
            b"GET /api/health/identity?nonce=short HTTP/1.1\r\n\r\n".to_vec(),
            format!("GET /api/health/identity?nonce={NONCE_A}&nonce={NONCE_B} HTTP/1.1\r\n\r\n")
                .into_bytes(),
            format!("GET /api/health/identity?nonce={NONCE_A} HTTP/1.1\r\nHost: x\r\n")
                .into_bytes(),
        ] {
            assert_eq!(
                tag_identity_challenge(untouched.clone(), local, RELAY_KEY),
                untouched
            );
        }
        // The facade does not wait for a CRLF head that a bare-LF head never ends.
        let bare_lf = format!("GET /api/health/identity?nonce={NONCE_A} HTTP/1.1\nHost: x\n\n");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let relayed = runtime.block_on(async {
            use tokio::io::AsyncWriteExt;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (mut accepted, _) = listener.accept().await.unwrap();
            client.write_all(bare_lf.as_bytes()).await.unwrap();
            tokio::time::timeout(
                Duration::from_secs(5),
                first_request(&mut accepted, Some(local), RELAY_KEY),
            )
            .await
            .expect("bare-LF head must not stall the relay")
            .unwrap()
        });
        assert_eq!(relayed, bare_lf.into_bytes());
        let tagged = tag_identity_challenge(
            format!(
                "GET /api/health/identity?nonce={NONCE_A} HTTP/1.1\r\nHost: x\r\nX-Ryu-Dev-Execution-Local-Addr: 127.0.0.9:1\r\n\r\nGET /next HTTP/1.1\r\n\r\n"
            )
            .into_bytes(),
            local,
            RELAY_KEY,
        );
        let tagged = String::from_utf8(tagged).unwrap();
        assert!(!tagged.contains("127.0.0.9"));
        assert!(tagged.ends_with("\r\n\r\nGET /next HTTP/1.1\r\n\r\n"));
        assert!(tagged.contains(&format!(
            "{RELAYED_LOCAL_ADDR_HEADER}: 127.0.0.1:8980\r\n{RELAYED_LOCAL_PROOF_HEADER}: {}\r\n",
            relayed_local_mac(RELAY_KEY, "127.0.0.1:8980", NONCE_A)
        )));
    }
}

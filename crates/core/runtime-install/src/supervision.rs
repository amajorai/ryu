//! Installation and startup supervision, run by a detached recovery executable.
use crate::recovery::{RecoveryCheckpoint, RecoveryPhase};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
#[cfg(unix)]
use sysinfo::ProcessStatus;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessCommand {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

impl ProcessCommand {
    pub(crate) fn spawn(&self) -> Result<SupervisedChild> {
        self.spawn_with_containment(true)
    }
    pub(crate) fn spawn_detached(&self) -> Result<SupervisedChild> {
        self.spawn_with_containment(false)
    }
    fn spawn_with_containment(&self, contained: bool) -> Result<SupervisedChild> {
        ensure!(
            self.executable.is_absolute(),
            "supervised executables must use absolute paths"
        );
        let mut command = Command::new(&self.executable);
        command
            .args(&self.arguments)
            .envs(&self.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000 | if contained { 0x00000004 } else { 0 });
        }
        #[cfg(unix)]
        if contained {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let initial_identity = identity(child.id());
        #[cfg(windows)]
        if contained && initial_identity.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("cannot identify suspended recovery child");
        }
        #[cfg(windows)]
        let job = if contained {
            match crate::process_job::ProcessJob::attach_and_resume(&child) {
                Ok(job) => Some(job),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        } else {
            None
        };
        #[cfg(unix)]
        let job = if contained {
            Some(crate::process_job::ProcessJob::new(child.id())?)
        } else {
            None
        };
        Ok(SupervisedChild {
            child,
            #[cfg(windows)]
            initial_identity,
            #[cfg(unix)]
            executable: fs::canonicalize(&self.executable).ok(),
            #[cfg(any(windows, unix))]
            job,
        })
    }
}

pub(crate) struct SupervisedChild {
    child: Child,
    #[cfg(windows)]
    initial_identity: Option<Identity>,
    #[cfg(unix)]
    executable: Option<PathBuf>,
    #[cfg(any(windows, unix))]
    job: Option<crate::process_job::ProcessJob>,
}
impl SupervisedChild {
    fn process_identity(&self) -> Option<Identity> {
        #[cfg(windows)]
        {
            return self.initial_identity.clone();
        }
        #[cfg(unix)]
        {
            // While exiting, a child has already released its executable but
            // is not yet a zombie. It stays unreaped, so its PID remains ours:
            // wait briefly for it to settle into either observable state.
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let found = identity(self.id()).or_else(|| self.exited_identity());
                if found.is_some() || Instant::now() >= deadline {
                    return found;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            identity(self.id())
        }
    }
    /// A child that exits before inspection stays an unreaped zombie: its PID
    /// cannot be reused until this guard reaps it, but it no longer exposes an
    /// executable. Identify it by the executable this guard spawned.
    #[cfg(unix)]
    fn exited_identity(&self) -> Option<Identity> {
        let pid = Pid::from_u32(self.id());
        let system = processes(ProcessesToUpdate::Some(&[pid]));
        let process = system.process(pid)?;
        if process.status() != ProcessStatus::Zombie || process.start_time() == 0 {
            return None;
        }
        Some(Identity {
            pid: self.id(),
            executable: self.executable.clone()?,
            start_time: process.start_time(),
        })
    }
    /// Unix: `Some(true)` once the leader exited but is not yet reaped. Its
    /// zombie still anchors the process group; once reaped, contained workers
    /// can no longer be signalled, so callers stop them before `try_wait`.
    /// `Some(false)` while it runs. `None` when the platform does not expose the
    /// zombie (or on Windows, whose job survives reaping): `try_wait` decides.
    fn exited_unreaped(&self) -> Option<bool> {
        #[cfg(unix)]
        {
            let pid = Pid::from_u32(self.id());
            processes(ProcessesToUpdate::Some(&[pid]))
                .process(pid)
                .map(|process| process.status() == ProcessStatus::Zombie)
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
    fn stop_contained(&self) -> Result<()> {
        #[cfg(any(windows, unix))]
        if let Some(job) = &self.job {
            job.terminate_and_wait()?;
        }
        Ok(())
    }
    fn drain_contained(&self) -> Result<bool> {
        #[cfg(any(windows, unix))]
        if let Some(job) = &self.job {
            let deadline = Instant::now() + Duration::from_secs(1);
            while job.active_processes()? > 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
            if job.active_processes()? > 0 {
                job.terminate_and_wait()?;
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(not(windows))]
    fn id(&self) -> u32 {
        self.child.id()
    }
    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child.wait()?;
        #[cfg(unix)]
        if let Some(job) = &mut self.job {
            job.leader_reaped();
        }
        Ok(status)
    }
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.child.try_wait()?;
        #[cfg(unix)]
        if status.is_some() {
            if let Some(job) = &mut self.job {
                job.leader_reaped();
            }
        }
        Ok(status)
    }
    fn release(&mut self) -> Result<()> {
        #[cfg(any(windows, unix))]
        if let Some(job) = &mut self.job {
            job.release()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisionPlan {
    #[serde(default)]
    pub data_lease_cache: Option<PathBuf>,
    pub installer: ProcessCommand,
    #[serde(default)]
    pub rollback_installer: Option<ProcessCommand>,
    pub application: ProcessCommand,
    pub previous_application: ProcessCommand,
    pub nonce: String,
    pub startup_timeout_seconds: u64,
    pub installer_timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupAcknowledgement {
    pub version: String,
    pub nonce: String,
    pub pid: u32,
    pub start_time: u64,
    pub renderer_ready: bool,
    pub runtime_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupervisionOutcome {
    Committed,
    Restored { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub executable: PathBuf,
    pub start_time: u64,
}
type Identity = ProcessIdentity;

pub fn identify_process(pid: u32) -> Option<ProcessIdentity> {
    identity(pid)
}

fn identity(pid: u32) -> Option<Identity> {
    let pid = Pid::from_u32(pid);
    let system = processes(ProcessesToUpdate::Some(&[pid]));
    let process = system.process(pid)?;
    if process.start_time() == 0 {
        return None;
    }
    Some(Identity {
        pid: pid.as_u32(),
        executable: fs::canonicalize(process.exe()?).ok()?,
        start_time: process.start_time(),
    })
}

fn processes(selection: ProcessesToUpdate<'_>) -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        selection,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    system
}

pub(crate) fn alive(expected: &Identity) -> bool {
    identity(expected.pid).is_some_and(|actual| {
        actual.executable == expected.executable && actual.start_time == expected.start_time
    })
}

pub(crate) fn track_descendants(
    root: &Identity,
    tracked: &mut BTreeMap<u32, Identity>,
    system: &mut System,
) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    // Continue following verified children after their original parent exits.
    // Otherwise an orphaned worker could spawn another writer during rollback.
    let mut pending: Vec<_> = std::iter::once(root)
        .chain(tracked.values())
        .filter(|expected| {
            system
                .process(Pid::from_u32(expected.pid))
                .is_some_and(|actual| {
                    actual.start_time() == expected.start_time
                        && actual
                            .exe()
                            .and_then(|path| fs::canonicalize(path).ok())
                            .as_ref()
                            == Some(&expected.executable)
                })
        })
        .map(|expected| Pid::from_u32(expected.pid))
        .collect();
    let mut visited = BTreeSet::new();
    while let Some(parent) = pending.pop() {
        if !visited.insert(parent) {
            continue;
        }
        for (pid, process) in system.processes() {
            let parent_start = system
                .process(parent)
                .map(|parent| parent.start_time())
                .unwrap_or(u64::MAX);
            if process.parent() == Some(parent)
                && process.start_time() >= parent_start
                && process.start_time() > 0
            {
                pending.push(*pid);
                if let Some(executable) = process.exe().and_then(|path| fs::canonicalize(path).ok())
                {
                    tracked.insert(
                        pid.as_u32(),
                        Identity {
                            pid: pid.as_u32(),
                            executable,
                            start_time: process.start_time(),
                        },
                    );
                }
            }
        }
    }
}

pub(crate) fn stop_owned(
    root: &Identity,
    tracked: &mut BTreeMap<u32, Identity>,
    system: &mut System,
) -> Result<()> {
    track_descendants(root, tracked, system);
    tracked.insert(root.pid, root.clone());
    for expected in tracked.values().rev() {
        if alive(expected) {
            if let Some(process) = system.process(Pid::from_u32(expected.pid)) {
                process.kill();
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while tracked.values().any(alive) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    ensure!(
        !tracked.values().any(alive),
        "failed update still has live writers; refusing data restore"
    );
    Ok(())
}

pub fn write_acknowledgement(
    checkpoint: &RecoveryCheckpoint,
    acknowledgement: &StartupAcknowledgement,
) -> Result<()> {
    ensure!(
        checkpoint.read()?.phase == RecoveryPhase::AwaitingHealth,
        "transaction is not awaiting startup health"
    );
    let mut file = tempfile::NamedTempFile::new_in(checkpoint.root())?;
    file.write_all(&serde_json::to_vec(acknowledgement)?)?;
    file.as_file().sync_all()?;
    file.persist(checkpoint.root().join("startup-health.json"))
        .map_err(|error| error.error)?;
    Ok(())
}

fn persist_owned(
    checkpoint: &RecoveryCheckpoint,
    root: &Identity,
    tracked: &BTreeMap<u32, Identity>,
    last: &mut Vec<u8>,
) -> Result<()> {
    let mut owned = tracked.clone();
    owned.insert(root.pid, root.clone());
    let bytes = serde_json::to_vec(&owned.values().collect::<Vec<_>>())?;
    if &bytes == last {
        return Ok(());
    }
    let mut file = tempfile::NamedTempFile::new_in(checkpoint.root())?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(checkpoint.root().join("owned-processes.json"))
        .map_err(|error| error.error)?;
    *last = bytes;
    Ok(())
}

/// A crashed guard aborts the uncommitted update. Windows jobs terminate its
/// contained children on death; persisted identities cover observed writers and
/// permit a new guard to stop only the same processes before restoring data.
pub fn recover_interrupted(
    checkpoint: &RecoveryCheckpoint,
    plan: &SupervisionPlan,
) -> Result<SupervisionOutcome> {
    let phase = checkpoint.read()?.phase;
    if phase == RecoveryPhase::Committed {
        return Ok(SupervisionOutcome::Committed);
    }
    if phase == RecoveryPhase::Restored {
        plan.previous_application.spawn_detached()?;
        return Ok(SupervisionOutcome::Restored {
            reason: "previous recovery already restored the checkpoint".into(),
        });
    }
    if phase == RecoveryPhase::Prepared {
        checkpoint.abort_prepared()?;
        plan.previous_application.spawn_detached()?;
        return Ok(SupervisionOutcome::Restored {
            reason: "guard interrupted before native installation".into(),
        });
    }
    let bytes = match crate::bounded_file::read(
        &checkpoint.root().join("owned-processes.json"),
        2 * 1024 * 1024,
    ) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    #[cfg(not(windows))]
    ensure!(
        bytes.is_some()
            || phase == RecoveryPhase::Prepared
            || matches!(phase, RecoveryPhase::Restoring { .. }),
        "interrupted update has no process ownership receipt; refusing unsafe restore"
    );
    if let Some(bytes) = bytes {
        let identities: Vec<Identity> = serde_json::from_slice(&bytes)?;
        ensure!(
            !identities.is_empty()
                && identities.iter().all(|identity| {
                    identity.pid > 0 && identity.start_time > 0 && identity.executable.is_absolute()
                }),
            "invalid interrupted process ownership receipt; refusing unsafe restore"
        );
        let mut tracked = identities
            .iter()
            .map(|process| (process.pid, process.clone()))
            .collect();
        let mut system = System::new();
        for process in &identities {
            if alive(process) {
                stop_owned(process, &mut tracked, &mut system)?;
            }
        }
        ensure!(
            !tracked.values().any(alive),
            "interrupted update still has live writers"
        );
    }
    restore_previous(
        checkpoint,
        plan,
        "recovery guard interrupted before commit".into(),
    )
}

/// The installer must finish before the application is launched. In particular,
/// its command must suppress a platform installer's own automatic app launch.
pub fn supervise(
    checkpoint: &RecoveryCheckpoint,
    plan: &SupervisionPlan,
) -> Result<SupervisionOutcome> {
    let data_lease = recovery_data_lease(checkpoint, plan)?;
    ensure!(
        plan.startup_timeout_seconds > 0 && plan.startup_timeout_seconds <= 1800,
        "invalid startup timeout"
    );
    ensure!(
        plan.installer_timeout_seconds > 0 && plan.installer_timeout_seconds <= 7200,
        "invalid installer timeout"
    );
    ensure!(
        !plan.nonce.is_empty(),
        "startup acknowledgement requires a nonce"
    );
    if let Err(error) = checkpoint.begin_installation() {
        // No installer has been launched. Reservation failures must not require
        // another full copy just to reopen the untouched previous application.
        checkpoint.abort_prepared()?;
        drop(data_lease);
        plan.previous_application.spawn_detached()?;
        return Ok(SupervisionOutcome::Restored {
            reason: format!("installation preparation failed: {error:#}"),
        });
    }
    let failure = match plan.installer.spawn() {
        Err(error) => Some(format!("installer could not start: {error}")),
        Ok(mut child) => {
            let root = Some(
                child
                    .process_identity()
                    .context("cannot verify installer process identity; refusing restore")?,
            );
            let mut tracked = BTreeMap::new();
            let mut system = System::new();
            let mut last_owned = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(plan.installer_timeout_seconds);
            loop {
                if let Some(root) = &root {
                    track_descendants(root, &mut tracked, &mut system);
                    if let Err(error) = persist_owned(checkpoint, root, &tracked, &mut last_owned) {
                        stop_owned(root, &mut tracked, &mut system)?;
                        child.stop_contained()?;
                        break Some(format!("installer ownership receipt failed: {error:#}"));
                    }
                }
                let exited = child.exited_unreaped();
                let left_workers = exited == Some(true) && child.drain_contained()?;
                let polled = if exited == Some(false) {
                    Ok(None)
                } else {
                    child.try_wait()
                };
                let status = match polled {
                    Ok(status) => status,
                    Err(error) => {
                        stop_owned(
                            root.as_ref().context("cannot verify installer ownership")?,
                            &mut tracked,
                            &mut system,
                        )?;
                        child.stop_contained()?;
                        break Some(format!("installer status inspection failed: {error}"));
                    }
                };
                if let Some(status) = status {
                    if left_workers || child.drain_contained()? {
                        break Some("installer exited with live contained workers".into());
                    }
                    // Windows console helpers can outlive the worker briefly.
                    // Allow bounded natural exit before treating them as leaks.
                    let drain = Instant::now() + Duration::from_secs(1);
                    while tracked.values().any(alive) && Instant::now() < drain {
                        std::thread::sleep(Duration::from_millis(50));
                        if let Some(root) = &root {
                            track_descendants(root, &mut tracked, &mut system);
                            if let Err(error) =
                                persist_owned(checkpoint, root, &tracked, &mut last_owned)
                            {
                                stop_owned(root, &mut tracked, &mut system)?;
                                child.stop_contained()?;
                                drop(data_lease);
                                return restore_previous(
                                    checkpoint,
                                    plan,
                                    format!("installer worker receipt failed: {error:#}"),
                                );
                            }
                        }
                    }
                    if tracked.values().any(alive) {
                        // A platform installer must wait for its own workers too.
                        // Stop verified leftovers before touching checkpoint roots.
                        stop_owned(
                            root.as_ref().context("cannot verify installer workers")?,
                            &mut tracked,
                            &mut system,
                        )?;
                        break Some(format!(
                            "installer exited with live workers: {:?}",
                            tracked
                                .values()
                                .map(|child| (&child.executable, child.pid, child.start_time))
                                .collect::<Vec<_>>()
                        ));
                    }
                    break (!status.success()).then(|| format!("installer exited with {status}"));
                }
                if Instant::now() >= deadline {
                    let root =
                        root.context("cannot verify hung installer ownership; refusing restore")?;
                    stop_owned(&root, &mut tracked, &mut system)?;
                    child.stop_contained()?;
                    child.wait()?;
                    break Some("installer timed out".to_owned());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    if let Some(reason) = failure {
        drop(data_lease);
        return restore_previous(checkpoint, plan, reason);
    }
    if let Err(error) = checkpoint.await_health() {
        drop(data_lease);
        return restore_previous(
            checkpoint,
            plan,
            format!("could not record awaiting-health phase: {error:#}"),
        );
    }
    drop(data_lease);
    let expected_version = checkpoint.read()?.expected_version;
    let mut application = match plan.application.spawn() {
        Ok(child) => child,
        Err(error) => {
            return restore_previous(
                checkpoint,
                plan,
                format!("updated app could not start: {error}"),
            );
        }
    };
    // One identity window shared with the Unix lookup's own internal polling.
    let identity_deadline = Instant::now() + Duration::from_secs(2);
    let mut root = loop {
        let found = application.process_identity();
        if found.is_some() || Instant::now() >= identity_deadline {
            break found;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    .context("cannot verify the updated app process identity")?;
    let mut tracked = BTreeMap::new();
    let mut system = System::new();
    let mut last_owned = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(plan.startup_timeout_seconds);
    let failure = loop {
        // AppImage's launcher execs the mounted application in the same process.
        // Its creation time stays fixed, while its executable path changes.
        if plan
            .application
            .executable
            .extension()
            .is_some_and(|extension| extension == "AppImage")
        {
            if let Some(actual) = identity(root.pid) {
                if actual.start_time == root.start_time {
                    root = actual;
                }
            }
        }
        track_descendants(&root, &mut tracked, &mut system);
        if let Err(error) = persist_owned(checkpoint, &root, &tracked, &mut last_owned) {
            break format!("updated app ownership receipt failed: {error:#}");
        }
        if let Ok(bytes) =
            crate::bounded_file::read(&checkpoint.root().join("startup-health.json"), 65536)
        {
            if let Ok(ack) = serde_json::from_slice::<StartupAcknowledgement>(&bytes) {
                if ack.version == expected_version
                    && ack.nonce == plan.nonce
                    && ack.pid == root.pid
                    && ack.start_time == root.start_time
                    && ack.renderer_ready
                    && ack.runtime_ready
                    && alive(&root)
                {
                    if let Err(error) = checkpoint.commit(&ack.version) {
                        // A directory-sync error can follow a successful atomic
                        // journal replacement. Never compensate a committed app.
                        if checkpoint.read()?.phase == RecoveryPhase::Committed {
                            application.release()?;
                            return Ok(SupervisionOutcome::Committed);
                        }
                        break format!("could not commit healthy startup: {error:#}");
                    }
                    application.release()?;
                    return Ok(SupervisionOutcome::Committed);
                }
            }
        }
        let exited = application.exited_unreaped();
        if exited == Some(true) {
            application.stop_contained()?;
        }
        let polled = if exited == Some(false) {
            Ok(None)
        } else {
            application.try_wait()
        };
        match polled {
            Ok(Some(status)) => {
                break format!("updated app exited before health acknowledgement: {status}")
            }
            Err(error) => break format!("updated app status inspection failed: {error}"),
            Ok(None) => (),
        }
        if Instant::now() >= deadline {
            break "updated app did not acknowledge healthy startup".to_owned();
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    stop_owned(&root, &mut tracked, &mut system)?;
    application.stop_contained()?;
    restore_previous(checkpoint, plan, failure)
}

fn restore_previous(
    checkpoint: &RecoveryCheckpoint,
    plan: &SupervisionPlan,
    reason: String,
) -> Result<SupervisionOutcome> {
    let data_lease = recovery_data_lease(checkpoint, plan)?;
    ensure!(
        checkpoint.read()?.phase != RecoveryPhase::Committed,
        "a committed update cannot run package compensation"
    );
    // Native installers can mutate package registration outside the captured
    // trees. Reapply the verified previous package before restoring its data.
    // The installer already finished before the first root swap. Replaying it
    // on resume could mutate roots whose restore index is already committed.
    if !matches!(checkpoint.read()?.phase, RecoveryPhase::Restoring { .. }) {
        if let Some(command) = &plan.rollback_installer {
            run_rollback_installer(checkpoint, command, plan.installer_timeout_seconds)?;
        }
    }
    checkpoint.restore()?;
    drop(data_lease);
    plan.previous_application.spawn_detached()?;
    ensure!(
        checkpoint.read()?.phase == RecoveryPhase::Restored,
        "rollback did not finish"
    );
    Ok(SupervisionOutcome::Restored { reason })
}

fn recovery_data_lease(
    checkpoint: &RecoveryCheckpoint,
    plan: &SupervisionPlan,
) -> Result<Option<crate::data_lease::DataLease>> {
    plan.data_lease_cache
        .as_ref()
        .map(|cache| {
            let roots = checkpoint
                .read()?
                .roots
                .into_iter()
                .map(|root| root.target)
                .collect::<Vec<_>>();
            crate::data_lease::DataLease::recovery(cache, &roots)
        })
        .transpose()
}

fn run_rollback_installer(
    checkpoint: &RecoveryCheckpoint,
    command: &ProcessCommand,
    timeout_seconds: u64,
) -> Result<()> {
    ensure!(
        timeout_seconds > 0 && timeout_seconds <= 7200,
        "invalid rollback installer timeout"
    );
    let mut child = command.spawn()?;
    let root = child
        .process_identity()
        .context("cannot verify previous installer process identity")?;
    let mut tracked = BTreeMap::new();
    let mut system = System::new();
    let mut last_owned = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    loop {
        track_descendants(&root, &mut tracked, &mut system);
        if let Err(error) = persist_owned(checkpoint, &root, &tracked, &mut last_owned) {
            stop_owned(&root, &mut tracked, &mut system)?;
            return Err(
                error.context("previous installer ownership receipt failed; checkpoint retained")
            );
        }
        // As in `supervise`: stop workers while the exited leader's zombie still
        // anchors its process group, because untracked workers cannot be
        // signalled once it is reaped.
        let exited = child.exited_unreaped();
        let left_workers = if exited == Some(true) {
            stop_owned(&root, &mut tracked, &mut system)?;
            child.drain_contained()?
        } else {
            false
        };
        let polled = if exited == Some(false) {
            Ok(None)
        } else {
            child.try_wait()
        };
        match polled {
            Ok(Some(status)) => {
                stop_owned(&root, &mut tracked, &mut system)?;
                ensure!(
                    !left_workers && !child.drain_contained()?,
                    "previous installer exited with live contained workers; checkpoint retained"
                );
                ensure!(
                    status.success(),
                    "previous package installer failed: {status}; checkpoint retained"
                );
                return Ok(());
            }
            Err(error) => {
                stop_owned(&root, &mut tracked, &mut system)?;
                return Err(error.into());
            }
            Ok(None) => (),
        }
        if Instant::now() >= deadline {
            stop_owned(&root, &mut tracked, &mut system)?;
            child.stop_contained()?;
            child.wait()?;
            anyhow::bail!("previous package installer timed out; checkpoint retained");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_transaction_cannot_launch_previous_installer() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            base.path().join("checkpoint"),
            &[app.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        checkpoint.begin_installation().unwrap();
        fs::write(&app, "committed-new").unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let missing = ProcessCommand {
            executable: base.path().join("missing"),
            arguments: vec![],
            environment: BTreeMap::new(),
        };
        let plan = SupervisionPlan {
            data_lease_cache: None,
            installer: missing.clone(),
            rollback_installer: Some(missing.clone()),
            application: missing.clone(),
            previous_application: missing,
            nonce: "test".into(),
            startup_timeout_seconds: 1,
            installer_timeout_seconds: 1,
        };
        let error = restore_previous(&checkpoint, &plan, "late write error".into()).unwrap_err();
        assert!(error
            .to_string()
            .contains("committed update cannot run package compensation"));
        assert_eq!(fs::read_to_string(app).unwrap(), "committed-new");
    }

    #[test]
    fn empty_ownership_receipt_cannot_authorize_restore() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            base.path().join("checkpoint"),
            &[app.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        checkpoint.begin_installation().unwrap();
        fs::write(&app, "new").unwrap();
        fs::write(checkpoint.root().join("owned-processes.json"), "[]").unwrap();
        let missing = ProcessCommand {
            executable: base.path().join("missing"),
            arguments: vec![],
            environment: BTreeMap::new(),
        };
        let plan = SupervisionPlan {
            data_lease_cache: None,
            installer: missing.clone(),
            rollback_installer: None,
            application: missing.clone(),
            previous_application: missing,
            nonce: "test".into(),
            startup_timeout_seconds: 1,
            installer_timeout_seconds: 1,
        };
        assert!(recover_interrupted(&checkpoint, &plan)
            .unwrap_err()
            .to_string()
            .contains("invalid interrupted process ownership"));
        assert_eq!(fs::read_to_string(app).unwrap(), "new");
        assert_eq!(checkpoint.read().unwrap().phase, RecoveryPhase::Installing);
    }

    #[test]
    fn interrupted_root_restore_does_not_replay_previous_installer() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            base.path().join("checkpoint"),
            &[app.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        checkpoint.begin_installation().unwrap();
        let mut journal = checkpoint.read().unwrap();
        journal.phase = RecoveryPhase::Restoring { next_root: 1 };
        fs::write(
            checkpoint.root().join("recovery.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        let missing = ProcessCommand {
            executable: base.path().join("missing-installer"),
            arguments: vec![],
            environment: BTreeMap::new(),
        };
        let mut previous = missing.clone();
        previous.executable = std::env::current_exe().unwrap();
        previous.arguments = vec!["--list".into()];
        let plan = SupervisionPlan {
            data_lease_cache: None,
            installer: missing.clone(),
            rollback_installer: Some(missing),
            application: previous.clone(),
            previous_application: previous,
            nonce: "test".into(),
            startup_timeout_seconds: 1,
            installer_timeout_seconds: 1,
        };
        assert!(matches!(
            recover_interrupted(&checkpoint, &plan).unwrap(),
            SupervisionOutcome::Restored { .. }
        ));
        assert_eq!(fs::read_to_string(app).unwrap(), "old");
    }
}

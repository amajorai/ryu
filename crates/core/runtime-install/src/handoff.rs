//! Accept the desktop handoff, wait for writer exit, then create the checkpoint.
use crate::{
    recovery::RecoveryCheckpoint,
    startup::{fence_lease, marker_path, publish_pending, safe_name, PendingRecovery},
    supervision::{self, ProcessIdentity, SupervisionOutcome, SupervisionPlan},
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffRequest {
    pub schema: u32,
    pub namespace: PathBuf,
    pub profiles: Vec<String>,
    pub parent: ProcessIdentity,
    pub targets: Vec<PathBuf>,
    pub previous_version: String,
    pub expected_version: String,
    pub target_profile: String,
    pub pending: PendingRecovery,
    pub plan: SupervisionPlan,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HandoffReady {
    pub guard: ProcessIdentity,
    pub nonce: String,
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("handoff record has no parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn cancel_handoff(request: &HandoffRequest) -> Result<()> {
    let _lease = fence_lease(&request.namespace)?;
    for profile in &request.profiles {
        let path = marker_path(&request.namespace, profile)?;
        match crate::bounded_file::read(&path, 65536) {
            Ok(bytes) => {
                let pending: PendingRecovery = serde_json::from_slice(&bytes)?;
                ensure!(
                    pending.transaction == request.pending.transaction
                        && pending.nonce == request.pending.nonce,
                    "a different update now owns the pending marker"
                );
                fs::remove_file(path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn persist_old_writers(
    directory: &Path,
    parent: &ProcessIdentity,
    tracked: &BTreeMap<u32, ProcessIdentity>,
    previous: &mut Vec<u8>,
) -> Result<()> {
    let mut writers = tracked.clone();
    writers.insert(parent.pid, parent.clone());
    let writers: Vec<_> = writers.into_values().collect();
    let bytes = serde_json::to_vec(&writers)?;
    if *previous != bytes {
        write_json(&directory.join("old-writers.json"), &writers)?;
        *previous = bytes;
    }
    Ok(())
}

fn stop_old_writers(directory: &Path, parent: &ProcessIdentity) -> Result<()> {
    let writers: Vec<ProcessIdentity> = serde_json::from_slice(
        &crate::bounded_file::read(&directory.join("old-writers.json"), 2 * 1024 * 1024).context(
            "interrupted handoff has no durable old-writer receipt; refusing to reopen data",
        )?,
    )?;
    ensure!(
        writers.iter().any(|writer| writer.pid == parent.pid
            && writer.start_time == parent.start_time
            && writer.executable == parent.executable),
        "old-writer receipt does not identify the initiating application"
    );
    ensure!(
        writers.iter().all(|writer| writer.pid > 0
            && writer.start_time > 0
            && writer.executable.is_absolute()),
        "invalid old-writer receipt"
    );
    let mut tracked = writers
        .iter()
        .map(|writer| (writer.pid, writer.clone()))
        .collect();
    let mut system = sysinfo::System::new();
    for writer in &writers {
        if supervision::alive(writer) {
            supervision::stop_owned(writer, &mut tracked, &mut system)?;
        }
    }
    Ok(())
}

fn record_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn verify_installation_never_started(directory: &Path, checkpoint: &Path) -> Result<()> {
    ensure!(
        !record_exists(&directory.join("checkpoint-ready.json"))?
            && !record_exists(&checkpoint.join("owned-processes.json"))?,
        "interrupted installation lost its journal; checkpoint retained"
    );
    Ok(())
}

pub fn run_handoff(directory: PathBuf) -> Result<SupervisionOutcome> {
    let directory = fs::canonicalize(directory)?;
    let request: HandoffRequest = serde_json::from_slice(&crate::bounded_file::read(
        &directory.join("request.json"),
        1024 * 1024,
    )?)?;
    ensure!(
        request.schema == 1
            && !request.targets.is_empty()
            && request.targets.len() <= 32
            && !request.profiles.is_empty()
            && request.profiles.len() <= 8,
        "invalid update handoff"
    );
    ensure!(
        request.pending.schema == 1
            && safe_name(&request.pending.transaction)
            && request.pending.application.is_absolute()
            && request.pending.nonce == request.plan.nonce
            && !request.plan.nonce.is_empty(),
        "handoff nonce mismatch"
    );
    let namespace = fs::canonicalize(&request.namespace)?;
    // All profiles share the installed application, even when their data roots
    // differ. Serialize complete transactions at the application namespace.
    let update_lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(namespace.join("update.lock"))?;
    fs4::FileExt::try_lock_exclusive(&update_lease)
        .context("another update already owns this application")?;
    ensure!(
        directory
            == namespace
                .join("handoffs")
                .join(&request.pending.transaction),
        "handoff escaped its namespace"
    );
    ensure!(
        request.namespace.is_absolute()
            && request.parent.executable.is_absolute()
            && request.targets.iter().all(|target| target.is_absolute()),
        "handoff paths must be absolute"
    );
    ensure!(
        request.profiles.contains(&request.target_profile),
        "target profile is not fenced"
    );
    let handoff_lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("handoff.lock"))?;
    fs4::FileExt::try_lock_exclusive(&handoff_lease)
        .context("another guard already owns this handoff")?;
    if !supervision::alive(&request.parent) {
        let guard = supervision::identify_process(std::process::id())
            .context("cannot identify replacement recovery guard")?;
        write_json(
            &directory.join("ready.json"),
            &HandoffReady {
                guard,
                nonce: request.plan.nonce.clone(),
            },
        )?;
        let checkpoint_path = namespace
            .join("transactions")
            .join(&request.pending.transaction);
        let outcome = if record_exists(&checkpoint_path.join("recovery.json"))? {
            let checkpoint = RecoveryCheckpoint::open(checkpoint_path)?;
            supervision::recover_interrupted(&checkpoint, &request.plan)?
        } else {
            verify_installation_never_started(&directory, &checkpoint_path)?;
            stop_old_writers(&directory, &request.parent)?;
            cancel_handoff(&request)?;
            request.plan.previous_application.spawn_detached()?;
            SupervisionOutcome::Restored {
                reason: "guard interrupted before checkpoint creation".into(),
            }
        };
        cancel_handoff(&request)?;
        write_json(&directory.join("outcome.json"), &outcome)?;
        return Ok(outcome);
    }
    for profile in &request.profiles {
        publish_pending(&namespace, profile, &request.pending)?;
    }
    let mut tracked = BTreeMap::new();
    let mut system = sysinfo::System::new();
    let mut previous_writers = Vec::new();
    supervision::track_descendants(&request.parent, &mut tracked, &mut system);
    tracked.remove(&std::process::id());
    // Publish readiness only after the first writer receipt is durable.
    persist_old_writers(&directory, &request.parent, &tracked, &mut previous_writers)?;
    let guard = supervision::identify_process(std::process::id())
        .context("cannot identify the recovery guard")?;
    write_json(
        &directory.join("ready.json"),
        &HandoffReady {
            guard,
            nonce: request.plan.nonce.clone(),
        },
    )?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while supervision::alive(&request.parent) {
        supervision::track_descendants(&request.parent, &mut tracked, &mut system);
        // The guard is itself a child of the desktop. Never include this branch
        // in the writers that must be stopped before copying the desktop data.
        tracked.remove(&std::process::id());
        persist_old_writers(&directory, &request.parent, &tracked, &mut previous_writers)?;
        if Instant::now() >= deadline {
            cancel_handoff(&request)?;
            anyhow::bail!("desktop did not exit after accepting the update handoff");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // No installer or provisional app exists yet, so this process has no children
    // for the old desktop's tracker to accidentally include.
    tracked.remove(&std::process::id());
    supervision::stop_owned(&request.parent, &mut tracked, &mut system)?;
    let capture_lease = match request
        .plan
        .data_lease_cache
        .as_ref()
        .map(|cache| crate::data_lease::DataLease::recovery(cache, &request.targets))
        .transpose()
    {
        Ok(lease) => lease,
        Err(error) => {
            cancel_handoff(&request)?;
            request.plan.previous_application.spawn_detached()?;
            let outcome = SupervisionOutcome::Restored {
                reason: format!(
                    "captured data could not be quiesced before installation: {error:#}"
                ),
            };
            write_json(&directory.join("outcome.json"), &outcome)?;
            return Ok(outcome);
        }
    };
    fs::create_dir_all(namespace.join("transactions"))?;
    let checkpoint = match RecoveryCheckpoint::create(
        namespace
            .join("transactions")
            .join(&request.pending.transaction),
        &request.targets,
        request.previous_version.clone(),
        request.expected_version.clone(),
        request.target_profile.clone(),
    ) {
        Ok(checkpoint) => checkpoint,
        Err(error) => {
            cancel_handoff(&request)?;
            request.plan.previous_application.spawn_detached()?;
            let outcome = SupervisionOutcome::Restored {
                reason: format!("checkpoint preparation failed before installation: {error:#}"),
            };
            write_json(&directory.join("outcome.json"), &outcome)?;
            return Ok(outcome);
        }
    };
    write_json(
        &directory.join("checkpoint-ready.json"),
        &request.plan.nonce,
    )?;
    drop(capture_lease);
    let outcome = supervision::supervise(&checkpoint, &request.plan)?;
    cancel_handoff(&request)?;
    write_json(&directory.join("outcome.json"), &outcome)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lost_journal_after_checkpoint_readiness_cannot_reopen_the_old_app() {
        let base = tempfile::tempdir().unwrap();
        let directory = base.path().join("handoff");
        let checkpoint = base.path().join("checkpoint");
        fs::create_dir(&directory).unwrap();
        fs::create_dir(&checkpoint).unwrap();
        assert!(verify_installation_never_started(&directory, &checkpoint).is_ok());
        fs::write(directory.join("checkpoint-ready.json"), "nonce").unwrap();
        assert!(verify_installation_never_started(&directory, &checkpoint).is_err());
        fs::remove_file(directory.join("checkpoint-ready.json")).unwrap();
        fs::write(checkpoint.join("owned-processes.json"), "[]").unwrap();
        assert!(verify_installation_never_started(&directory, &checkpoint).is_err());
    }
}

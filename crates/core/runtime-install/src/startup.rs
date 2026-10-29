//! A startup fence read before opening any application or runtime stores.
use crate::recovery::{RecoveryCheckpoint, RecoveryPhase};
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRecovery {
    pub schema: u32,
    pub transaction: String,
    pub nonce: String,
    pub runtime_required: bool,
    pub application: PathBuf,
}

#[derive(Debug, Clone)]
pub struct StartupAdmission {
    pub checkpoint: PathBuf,
    pub nonce: String,
    pub expected_version: String,
    pub runtime_required: bool,
}

pub(crate) fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn marker_path(root: &Path, profile: &str) -> Result<PathBuf> {
    ensure!(
        root.is_absolute() && safe_name(profile),
        "invalid recovery namespace"
    );
    Ok(root.join(format!("pending-{profile}.json")))
}

pub(crate) fn fence_lease(root: &Path) -> Result<fs::File> {
    fs::create_dir_all(root)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("fences.lock"))?;
    fs4::FileExt::lock_exclusive(&file)?;
    Ok(file)
}

pub fn publish_pending(root: &Path, profile: &str, pending: &PendingRecovery) -> Result<()> {
    ensure!(
        pending.schema == 1
            && safe_name(&pending.transaction)
            && !pending.nonce.is_empty()
            && pending.application.is_absolute(),
        "invalid pending recovery marker"
    );
    let _lease = fence_lease(root)?;
    if let Some(bytes) = crate::bounded_file::read_optional(&marker_path(root, profile)?, 65536)? {
        let existing: PendingRecovery = serde_json::from_slice(&bytes)?;
        if existing.transaction != pending.transaction || existing.nonce != pending.nonce {
            ensure!(
                safe_name(&existing.transaction),
                "existing recovery marker is invalid"
            );
            let observer =
                RecoveryCheckpoint::observe(root.join("transactions").join(&existing.transaction))?;
            ensure!(
                matches!(
                    observer.read()?.phase,
                    RecoveryPhase::Committed | RecoveryPhase::Restored
                ),
                "another update still owns this profile's startup fence"
            );
        }
    }
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    file.write_all(&serde_json::to_vec(pending)?)?;
    file.as_file().sync_all()?;
    file.persist(marker_path(root, profile)?)
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(root)?.sync_all()?;
    Ok(())
}

/// Ordinary startup is allowed only when no transaction is pending or recovery
/// reached a terminal phase. A provisional release needs the guard's nonce.
pub fn admit_startup(
    root: &Path,
    profile: &str,
    version: &str,
    executable: &Path,
    nonce: Option<&str>,
) -> Result<Option<StartupAdmission>> {
    let marker = marker_path(root, profile)?;
    // Keep read/terminal cleanup in the same critical section as publication.
    let _lease = fence_lease(root)?;
    let bytes = match crate::bounded_file::read(&marker, 65536) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure!(
                nonce.is_none(),
                "guard-launched startup has no pending transaction for this application/profile"
            );
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let pending: PendingRecovery = serde_json::from_slice(&bytes)?;
    ensure!(
        pending.schema == 1 && safe_name(&pending.transaction) && !pending.nonce.is_empty(),
        "invalid pending recovery marker"
    );
    let transactions = fs::canonicalize(root.join("transactions"))?;
    ensure!(
        transactions == fs::canonicalize(root)?.join("transactions"),
        "recovery transaction namespace changed identity"
    );
    let checkpoint = fs::canonicalize(transactions.join(&pending.transaction))?;
    ensure!(
        checkpoint == transactions.join(&pending.transaction),
        "recovery checkpoint escapes its namespace"
    );
    let observer = RecoveryCheckpoint::observe(checkpoint.clone())?;
    let journal = observer.read()?;
    match journal.phase {
        RecoveryPhase::Committed | RecoveryPhase::Restored => {
            // A completed transaction must not pin later manual reinstalls to
            // its old application path or version. Only this profile's marker
            // is removed; the verified checkpoint remains available.
            match fs::remove_file(marker_path(root, profile)?) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
            Ok(None)
        }
        RecoveryPhase::AwaitingHealth => {
            ensure!(
                fs::canonicalize(&pending.application)? == fs::canonicalize(executable)?,
                "recovery marker belongs to another application"
            );
            ensure!(
                journal.profile == profile && journal.expected_version == version,
                "provisional startup is from a different profile or release"
            );
            ensure!(
                nonce == Some(pending.nonce.as_str()),
                "provisional startup was not launched by the recovery guard"
            );
            ensure!(
                journal.roots.iter().any(|root| {
                    if root.directory {
                        pending.application.starts_with(&root.target)
                    } else {
                        pending.application == root.target
                    }
                }),
                "application is not captured by this recovery transaction"
            );
            Ok(Some(StartupAdmission {
                checkpoint,
                nonce: pending.nonce,
                expected_version: journal.expected_version,
                runtime_required: pending.runtime_required,
            }))
        }
        RecoveryPhase::Prepared | RecoveryPhase::Installing | RecoveryPhase::Restoring { .. } => {
            bail!("update recovery has not released startup; refusing to open application data")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simultaneous_publishers_cannot_both_claim_a_profile() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("recovery");
        fs::create_dir_all(&root).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let pending = PendingRecovery {
                        schema: 1,
                        transaction: format!("update-{index}"),
                        nonce: format!("nonce-{index}"),
                        runtime_required: false,
                        application: root.join("app"),
                    };
                    barrier.wait();
                    publish_pending(&root, "dev", &pending).is_ok()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| usize::from(handle.join().unwrap()))
                .sum::<usize>(),
            1
        );
    }
    fn fixture() -> (
        tempfile::TempDir,
        RecoveryCheckpoint,
        PathBuf,
        PendingRecovery,
    ) {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let root = base.path().join("recovery");
        fs::create_dir_all(root.join("transactions")).unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            root.join("transactions/update-test"),
            &[app.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        let pending = PendingRecovery {
            schema: 1,
            transaction: "update-test".into(),
            nonce: "nonce".into(),
            runtime_required: true,
            application: fs::canonicalize(&app).unwrap(),
        };
        publish_pending(&root, "dev", &pending).unwrap();
        (base, checkpoint, root, pending)
    }
    #[test]
    fn preinstallation_and_installing_phases_block_data_startup() {
        let (_base, checkpoint, root, pending) = fixture();
        assert!(admit_startup(&root, "dev", "1", &pending.application, None).is_err());
        checkpoint.begin_installation().unwrap();
        assert!(admit_startup(&root, "dev", "2", &pending.application, Some("nonce")).is_err());
    }
    #[test]
    fn only_the_guard_launched_matching_release_and_profile_are_admitted() {
        let (_base, checkpoint, root, pending) = fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        assert!(admit_startup(&root, "dev", "2", &pending.application, None).is_err());
        assert!(admit_startup(&root, "dev", "1", &pending.application, Some("nonce")).is_err());
        publish_pending(&root, "release", &pending).unwrap();
        assert!(admit_startup(&root, "release", "2", &pending.application, Some("nonce")).is_err());
        assert!(
            admit_startup(&root, "dev", "2", &pending.application, Some("nonce"))
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn completed_restore_allows_normal_old_app_startup() {
        let (_base, checkpoint, root, pending) = fixture();
        checkpoint.restore().unwrap();
        assert!(admit_startup(&root, "dev", "1", &pending.application, None)
            .unwrap()
            .is_none());
        assert!(!marker_path(&root, "dev").unwrap().exists());
    }
    #[test]
    fn invalid_markers_fail_closed_and_unaffected_profiles_start_normally() {
        let (_base, _checkpoint, root, mut pending) = fixture();
        assert!(
            admit_startup(&root, "release", "1", &pending.application, None)
                .unwrap()
                .is_none()
        );
        pending.transaction = "../foreign".into();
        fs::write(
            marker_path(&root, "dev").unwrap(),
            serde_json::to_vec(&pending).unwrap(),
        )
        .unwrap();
        assert!(admit_startup(&root, "dev", "2", &pending.application, Some("nonce")).is_err());
    }

    #[test]
    fn interrupted_restoration_keeps_startup_fenced() {
        let (_base, checkpoint, root, pending) = fixture();
        let mut journal = checkpoint.read().unwrap();
        journal.phase = RecoveryPhase::Restoring { next_root: 0 };
        fs::write(
            checkpoint.root().join("recovery.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert!(admit_startup(&root, "dev", "1", &pending.application, Some("nonce")).is_err());
    }

    #[test]
    fn a_completed_transaction_does_not_pin_later_manual_reinstalls() {
        let (base, checkpoint, root, pending) = fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let moved_app = base.path().join("moved-app");
        fs::rename(&pending.application, &moved_app).unwrap();
        assert!(admit_startup(&root, "dev", "3", &moved_app, None)
            .unwrap()
            .is_none());
        assert!(!marker_path(&root, "dev").unwrap().exists());
        assert!(checkpoint.root().join("recovery.json").exists());
    }

    #[test]
    fn a_guard_launch_cannot_fall_back_to_an_unaffected_profile() {
        let (_base, _checkpoint, root, pending) = fixture();
        assert!(admit_startup(&root, "release", "2", &pending.application, Some("nonce")).is_err());
        assert!(
            admit_startup(&root, "release", "1", &pending.application, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_active_profile_fence_cannot_be_overwritten_by_another_update() {
        let (_base, _checkpoint, root, pending) = fixture();
        let mut competing = pending.clone();
        competing.transaction = "update-other".into();
        competing.nonce = "different-nonce".into();
        assert!(publish_pending(&root, "dev", &competing).is_err());
        let original: PendingRecovery =
            serde_json::from_slice(&fs::read(marker_path(&root, "dev").unwrap()).unwrap()).unwrap();
        assert_eq!(original.transaction, pending.transaction);
        assert_eq!(original.nonce, pending.nonce);
    }
}

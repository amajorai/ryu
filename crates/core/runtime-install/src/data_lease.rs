//! Cross-process exclusion for captured data, independent of a desktop identity.
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

pub struct DataLease {
    _files: Vec<fs::File>,
}

/// Resolve existing ancestors without creating a missing runtime folder.
/// Capture discovery and leases must compare the same physical path identity.
pub fn normalized(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    ensure!(
        !absolute
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "data lease path traverses a parent"
    );
    let mut existing = absolute.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        if fs::symlink_metadata(existing).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            anyhow::bail!("data lease path contains a dangling link");
        }
        suffix.push(
            existing
                .file_name()
                .context("data lease path has no existing ancestor")?
                .to_owned(),
        );
        existing = existing.parent().context("data lease path has no parent")?;
    }
    let mut result = fs::canonicalize(existing)?;
    for part in suffix.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}

fn lock_path(cache: &Path, target: &Path) -> PathBuf {
    let text = target.to_string_lossy();
    #[cfg(windows)]
    let text = text.to_lowercase();
    cache
        .join(".runtime-leases")
        .join(format!("{:x}.lock", Sha256::digest(text.as_bytes())))
}

impl DataLease {
    pub fn writer(cache: &Path, roots: &[PathBuf]) -> Result<Self> {
        Self::acquire(cache, roots, false)
    }
    pub fn recovery(cache: &Path, roots: &[PathBuf]) -> Result<Self> {
        Self::acquire(cache, roots, true)
    }
    fn acquire(cache: &Path, roots: &[PathBuf], exclusive: bool) -> Result<Self> {
        ensure!(!roots.is_empty(), "data lease requires a protected root");
        fs::create_dir_all(cache.join(".runtime-leases"))?;
        let mut paths = BTreeSet::new();
        for root in roots {
            let root = normalized(root)?;
            if exclusive {
                paths.insert(lock_path(cache, &root));
                // Subtree locks detect an existing writer of a containing root.
                // They serialize recovery operations, without stopping writers
                // on sibling profile roots.
                for ancestor in root.ancestors() {
                    paths.insert(lock_path(cache, ancestor).with_extension("subtree.lock"));
                }
            } else {
                paths.insert(lock_path(cache, &root).with_extension("subtree.lock"));
                for ancestor in root.ancestors() {
                    paths.insert(lock_path(cache, ancestor));
                }
            }
        }
        let mut files = Vec::new();
        for path in paths {
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)?;
            if exclusive {
                fs4::FileExt::try_lock_exclusive(&file)
                    .context("captured data still has a live runtime writer")?;
            } else {
                fs4::FileExt::try_lock_shared(&file)
                    .context("update recovery owns this data path; runtime startup refused")?;
            }
            files.push(file);
        }
        Ok(Self { _files: files })
    }
}

/// Hold the returned lease until the runtime exits. Admission is checked after
/// acquiring it, closing the check/start race with an independent recovery guard.
pub fn admit_runtime(
    cache: &Path,
    roots: &[PathBuf],
    profile: &str,
    version: &str,
    nonce: Option<&str>,
) -> Result<DataLease> {
    let lease = DataLease::writer(cache, roots)?;
    let current = roots
        .iter()
        .map(|root| normalized(root))
        .collect::<Result<Vec<_>>>()?;
    let mut provisional_admitted = nonce.is_none();
    if !cache.exists() {
        ensure!(
            provisional_admitted,
            "provisional runtime has no recovery checkpoint"
        );
        return Ok(lease);
    }
    for (index, entry) in fs::read_dir(cache)?.enumerate().take(1025) {
        ensure!(
            index < 1024,
            "too many recovery namespaces; refusing unsafe runtime startup"
        );
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_name() == ".runtime-leases" {
            continue;
        }
        let namespace = entry.path();
        let mut marker_count = 0;
        for marker in fs::read_dir(&namespace)? {
            let marker = marker?;
            let name = marker.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !(name.starts_with("pending-") && name.ends_with(".json")) {
                continue;
            }
            marker_count += 1;
            ensure!(marker_count <= 64, "too many runtime recovery fences");
            ensure!(
                marker.file_type()?.is_file(),
                "runtime recovery fence is not a regular file"
            );
            let bytes = match crate::bounded_file::read(&marker.path(), 65536) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let pending: crate::startup::PendingRecovery = serde_json::from_slice(&bytes)?;
            ensure!(
                pending.schema == 1
                    && crate::startup::safe_name(&pending.transaction)
                    && !pending.nonce.is_empty(),
                "invalid runtime recovery fence"
            );
            let checkpoint_path = namespace.join("transactions").join(&pending.transaction);
            let checkpoint = match crate::recovery::RecoveryCheckpoint::observe(checkpoint_path) {
                Ok(checkpoint) => checkpoint,
                Err(error) => {
                    let request: crate::handoff::HandoffRequest =
                        serde_json::from_slice(&crate::bounded_file::read(
                            &namespace
                                .join("handoffs")
                                .join(&pending.transaction)
                                .join("request.json"),
                            1024 * 1024,
                        )?)?;
                    ensure!(
                        request.pending.nonce == pending.nonce
                            && request.pending.transaction == pending.transaction,
                        "runtime handoff fence changed identity"
                    );
                    let captured = request
                        .targets
                        .iter()
                        .map(|root| normalized(root))
                        .collect::<Result<Vec<_>>>()?;
                    if current.iter().any(|root| {
                        captured
                            .iter()
                            .any(|target| root.starts_with(target) || target.starts_with(root))
                    }) {
                        return Err(
                            error.context("runtime data has an incomplete recovery checkpoint")
                        );
                    }
                    continue;
                }
            };
            let journal = checkpoint.read()?;
            // An unreadable or dangling captured path must refuse admission,
            // rather than silently treating it as an unrelated transaction.
            let captured = journal
                .roots
                .iter()
                .map(|root| normalized(&root.target))
                .collect::<Result<Vec<_>>>()?;
            let overlaps = current.iter().any(|root| {
                captured
                    .iter()
                    .any(|target| root.starts_with(target) || target.starts_with(root))
            });
            if !overlaps {
                continue;
            }
            match journal.phase {
                crate::recovery::RecoveryPhase::Committed
                | crate::recovery::RecoveryPhase::Restored => (),
                crate::recovery::RecoveryPhase::AwaitingHealth => {
                    ensure!(
                        journal.profile == profile
                            && journal.expected_version == version
                            && nonce == Some(pending.nonce.as_str())
                            && current
                                .iter()
                                .all(|root| captured.iter().any(|target| root.starts_with(target))),
                        "runtime was not admitted by the update guard"
                    );
                    provisional_admitted = true;
                }
                _ => anyhow::bail!("update recovery has not released runtime data"),
            }
        }
    }
    ensure!(
        provisional_admitted,
        "provisional runtime has no matching live recovery checkpoint"
    );
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provisional_nonce_requires_a_live_matching_checkpoint() {
        let base = tempfile::tempdir().unwrap();
        assert!(admit_runtime(
            &base.path().join("cache"),
            &[base.path().join("data")],
            "dev",
            "2",
            Some("unknown-update")
        )
        .is_err());
    }
    #[test]
    fn only_matching_provisional_runtime_can_open_captured_data() {
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("database"), "old").unwrap();
        let cache = base.path().join("cache");
        let namespace = cache.join("app");
        fs::create_dir_all(namespace.join("transactions")).unwrap();
        let checkpoint = crate::recovery::RecoveryCheckpoint::create(
            namespace.join("transactions/update-test"),
            &[data.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        crate::startup::publish_pending(
            &namespace,
            "dev",
            &crate::startup::PendingRecovery {
                schema: 1,
                transaction: "update-test".into(),
                nonce: "secret".into(),
                runtime_required: true,
                application: data.join("app"),
            },
        )
        .unwrap();
        assert!(admit_runtime(&cache, &[data.clone()], "dev", "2", Some("secret")).is_err());
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        assert!(admit_runtime(&cache, &[data.clone()], "dev", "2", None).is_err());
        assert!(admit_runtime(&cache, &[data.clone()], "dev", "1", Some("secret")).is_err());
        assert!(admit_runtime(&cache, &[data.clone()], "beta", "2", Some("secret")).is_err());
        assert!(
            admit_runtime(
                &cache,
                &[data.clone(), base.path().join("uncaptured-pi")],
                "dev",
                "2",
                Some("secret")
            )
            .is_err(),
            "nonce admitted writable Pi state outside the checkpoint"
        );
        assert!(
            admit_runtime(
                &cache,
                &[base.path().to_path_buf()],
                "dev",
                "2",
                Some("secret")
            )
            .is_err(),
            "nonce admitted an ancestor broader than the checkpoint"
        );
        let admitted = admit_runtime(&cache, &[data.clone()], "dev", "2", Some("secret")).unwrap();
        assert!(DataLease::recovery(&cache, &[data.clone()]).is_err());
        drop(admitted);
        checkpoint.commit("2").unwrap();
        assert!(admit_runtime(&cache, &[data], "dev", "2", None).is_ok());
    }
    #[test]
    fn recovery_excludes_writers_in_nested_captured_roots() {
        let base = tempfile::tempdir().unwrap();
        let cache = base.path().join("cache");
        let parent = base.path().join("data");
        fs::create_dir_all(parent.join("nested")).unwrap();
        let writer = DataLease::writer(&cache, &[parent.join("nested")]).unwrap();
        assert!(DataLease::recovery(&cache, &[parent.clone()]).is_err());
        drop(writer);
        let recovery = DataLease::recovery(&cache, &[parent.clone()]).unwrap();
        assert!(DataLease::writer(&cache, &[parent.join("nested")]).is_err());
        drop(recovery);
        assert!(DataLease::writer(&cache, &[parent]).is_ok());
    }
    #[test]
    fn independent_profile_data_keeps_running() {
        let base = tempfile::tempdir().unwrap();
        let cache = base.path().join("cache");
        let _writer = DataLease::writer(&cache, &[base.path().join("dev")]).unwrap();
        assert!(DataLease::recovery(&cache, &[base.path().join("stable")]).is_ok());
    }

    #[test]
    fn nested_maintenance_cannot_enter_a_live_parent_data_root() {
        let base = tempfile::tempdir().unwrap();
        let cache = base.path().join("cache");
        let parent = base.path().join("data");
        fs::create_dir_all(parent.join("nested")).unwrap();
        let writer = DataLease::writer(&cache, &[parent.clone()]).unwrap();
        assert!(DataLease::recovery(&cache, &[parent.join("nested")]).is_err());
        drop(writer);
        let recovery = DataLease::recovery(&cache, &[parent.join("nested")]).unwrap();
        assert!(DataLease::writer(&cache, &[parent]).is_err());
        drop(recovery);
    }
}

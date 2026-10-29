//! Ownership of unpublished checkpoint copies. Receipts never authorize cleanup
//! after journal publication has become possible.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Capturing,
    Publishing,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: u32,
    transaction: String,
    profile: String,
    phase: Phase,
    identity: crate::tree_identity::TreeIdentity,
}

fn receipt_path(root: &Path) -> Result<PathBuf> {
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .context("preparation root has no UTF-8 name")?;
    ensure!(
        crate::startup::safe_name(name),
        "invalid preparation transaction name"
    );
    Ok(root
        .parent()
        .context("preparation root has no parent")?
        .join(format!(".preparation-{name}.json")))
}

fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn unpublished(root: &Path) -> Result<bool> {
    if !absent(&root.join("recovery.json"))? || !absent(&root.join("owned-processes.json"))? {
        return Ok(false);
    }
    if let Some(transactions) = root.parent().filter(|parent| {
        parent
            .file_name()
            .is_some_and(|name| name == "transactions")
    }) {
        let namespace = transactions
            .parent()
            .context("transaction namespace has no parent")?;
        let transaction = root.file_name().context("transaction has no name")?;
        if !absent(
            &namespace
                .join("handoffs")
                .join(transaction)
                .join("checkpoint-ready.json"),
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) struct Capture {
    root: PathBuf,
    receipt: Receipt,
    active: bool,
    receipt_written: bool,
}

impl Capture {
    pub(crate) fn start(root: &Path, profile: &str) -> Result<Option<Self>> {
        let path = receipt_path(root)?;
        let Some(identity) = crate::tree_identity::TreeIdentity::read(root)? else {
            // Filesystems without birth times can still capture updates. They
            // cannot prove ownership after a crash, so preserve partial copies.
            return Ok(None);
        };
        let mut capture = Self {
            root: root.to_owned(),
            receipt: Receipt {
                schema: 1,
                transaction: root.file_name().unwrap().to_str().unwrap().to_owned(),
                profile: profile.to_owned(),
                phase: Phase::Capturing,
                identity,
            },
            active: true,
            receipt_written: false,
        };
        ensure!(absent(&path)?, "preparation receipt already exists");
        capture.write()?;
        capture.receipt_written = true;
        Ok(Some(capture))
    }

    fn write(&self) -> Result<()> {
        let parent = self
            .root
            .parent()
            .context("preparation root has no parent")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&serde_json::to_vec(&self.receipt)?)?;
        file.as_file().sync_all()?;
        file.persist(receipt_path(&self.root)?)
            .map_err(|error| error.error)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }

    pub(crate) fn publishing(&mut self) -> Result<()> {
        // Durable before journal publication. A crash from this point onward
        // preserves the tree even if its journal later becomes unreadable.
        self.receipt.phase = Phase::Publishing;
        self.write()
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        fs::remove_file(receipt_path(&self.root)?)?;
        self.active = false;
        #[cfg(unix)]
        fs::File::open(
            self.root
                .parent()
                .context("preparation root has no parent")?,
        )?
        .sync_all()?;
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // Only this live creator knows journal publication was never completed.
        // Its checkpoint handle must be dropped before this guard on failure.
        if self.active
            && unpublished(&self.root).unwrap_or(false)
            && crate::tree_identity::TreeIdentity::read(&self.root)
                .ok()
                .flatten()
                .as_ref()
                == Some(&self.receipt.identity)
            && fs::remove_dir_all(&self.root).is_ok()
            && self.receipt_written
        {
            let _ = fs::remove_file(receipt_path(&self.root).unwrap());
        }
    }
}

/// The caller must hold its namespace fence while selecting a receipt for
/// cleanup. This function holds checkpoint and data leases through validation;
/// the data lease remains held through deletion and receipt removal.
pub(crate) fn cleanup(
    root: &Path,
    cache: &Path,
    profile: &str,
    protected_roots: &[PathBuf],
) -> Result<bool> {
    ensure!(
        root.is_absolute() && crate::startup::safe_name(profile),
        "invalid preparation cleanup root/profile"
    );
    let expected = fs::canonicalize(root.parent().context("preparation root has no parent")?)?
        .join(root.file_name().context("preparation root has no name")?);
    let physical = crate::data_lease::normalized(root)?;
    ensure!(physical == expected, "preparation tree moved or linked");
    let root = physical.as_path();
    let path = receipt_path(root)?;
    let metadata = fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "invalid preparation receipt file"
    );
    let receipt: Receipt = serde_json::from_slice(&crate::bounded_file::read(&path, 4096)?)?;
    ensure!(
        receipt.schema == 1
            && receipt.transaction == root.file_name().unwrap().to_str().unwrap()
            && crate::startup::safe_name(&receipt.profile),
        "invalid preparation receipt"
    );
    if receipt.phase != Phase::Capturing || receipt.profile != profile {
        return Ok(false);
    }
    for protected in protected_roots {
        let protected = crate::data_lease::normalized(protected)?;
        if physical.starts_with(&protected) || protected.starts_with(&physical) {
            return Ok(false);
        }
    }
    if crate::tree_identity::TreeIdentity::read(root)?.as_ref() != Some(&receipt.identity)
        || !unpublished(root)?
    {
        return Ok(false);
    }
    let checkpoint_lease = crate::recovery::acquire_lease(root)?;
    let _data_lease = crate::data_lease::DataLease::recovery(cache, &[physical.clone()])?;
    if crate::tree_identity::TreeIdentity::read(root)?.as_ref() != Some(&receipt.identity)
        || !unpublished(root)?
    {
        return Ok(false);
    }
    // Windows cannot delete a directory containing an open lock handle. No
    // journal exists for a new supervisor to open; the runtime lease remains.
    drop(checkpoint_lease);
    fs::remove_dir_all(root)?;
    fs::remove_file(path)?;
    #[cfg(unix)]
    fs::File::open(root.parent().context("preparation root has no parent")?)?.sync_all()?;
    Ok(true)
}

pub(crate) fn validate(root: &Path, profile: &str) -> Result<()> {
    receipt_path(root)?;
    ensure!(
        crate::startup::safe_name(profile),
        "invalid preparation profile"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interrupted() -> (tempfile::TempDir, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("checkpoint");
        fs::create_dir(&root).unwrap();
        let capture = Capture::start(&root, "dev").unwrap().unwrap();
        fs::create_dir(root.join("snapshot-0")).unwrap();
        fs::write(root.join("snapshot-0/value"), "partial").unwrap();
        std::mem::forget(capture);
        (home, root)
    }

    #[test]
    fn capturing_receipt_replays_partial_checkpoint_deletion() {
        let (home, root) = interrupted();
        fs::remove_file(root.join("snapshot-0/value")).unwrap();
        assert!(cleanup(&root, home.path(), "dev", &[]).unwrap());
        assert!(!root.exists());
        assert!(!receipt_path(&root).unwrap().exists());
    }

    #[test]
    fn publishing_receipt_never_authorizes_crash_cleanup_without_a_journal() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("checkpoint");
        fs::create_dir(&root).unwrap();
        let mut capture = Capture::start(&root, "dev").unwrap().unwrap();
        capture.publishing().unwrap();
        std::mem::forget(capture);
        assert!(!cleanup(&root, home.path(), "dev", &[]).unwrap());
        assert!(root.exists());
    }

    #[test]
    fn journal_or_installer_ownership_blocks_preparation_cleanup() {
        for name in ["recovery.json", "owned-processes.json"] {
            let (home, root) = interrupted();
            fs::write(root.join(name), "malformed-but-authoritative-existence").unwrap();
            assert!(!cleanup(&root, home.path(), "dev", &[]).unwrap());
            assert!(root.join("snapshot-0/value").exists());
        }
    }

    #[test]
    fn handoff_checkpoint_ready_receipt_blocks_preparation_cleanup() {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let root = namespace.join("transactions/checkpoint");
        fs::create_dir_all(&root).unwrap();
        let capture = Capture::start(&root, "dev").unwrap().unwrap();
        std::mem::forget(capture);
        fs::create_dir_all(namespace.join("handoffs/checkpoint")).unwrap();
        fs::write(
            namespace.join("handoffs/checkpoint/checkpoint-ready.json"),
            "ready",
        )
        .unwrap();
        assert!(!cleanup(&root, home.path(), "dev", &[]).unwrap());
        assert!(root.exists());
    }

    #[test]
    fn replacement_profile_selected_and_live_roots_are_preserved() {
        let (home, root) = interrupted();
        assert!(!cleanup(&root, home.path(), "beta", &[]).unwrap());
        assert!(!cleanup(&root, home.path(), "dev", &[root.join("snapshot-0")]).unwrap());
        let writer =
            crate::data_lease::DataLease::writer(home.path(), &[root.join("snapshot-0")]).unwrap();
        assert!(cleanup(&root, home.path(), "dev", &[]).is_err());
        assert!(root.join("snapshot-0/value").exists());
        drop(writer);
        fs::rename(&root, home.path().join("original")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("user-data"), "keep").unwrap();
        assert!(!cleanup(&root, home.path(), "dev", &[]).unwrap());
        assert_eq!(fs::read_to_string(root.join("user-data")).unwrap(), "keep");
    }

    #[test]
    fn malformed_oversized_and_mismatched_receipts_fail_closed() {
        for bytes in [b"{".to_vec(), vec![b' '; 4097]] {
            let (home, root) = interrupted();
            fs::write(receipt_path(&root).unwrap(), bytes).unwrap();
            assert!(cleanup(&root, home.path(), "dev", &[]).is_err());
            assert!(root.join("snapshot-0/value").exists());
        }
        let (home, root) = interrupted();
        let path = receipt_path(&root).unwrap();
        let mut receipt: Receipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        receipt.transaction = "different".into();
        fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(cleanup(&root, home.path(), "dev", &[]).is_err());
        assert!(root.join("snapshot-0/value").exists());
    }
}

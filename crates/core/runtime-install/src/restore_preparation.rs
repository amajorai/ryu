//! Receipts identify unpublished restore copies without scanning sibling trees.
use crate::{
    recovery::{RecoveryCheckpoint, RecoveryPhase},
    tree_identity::TreeIdentity,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

const RECEIPT: &str = "restoring-temporaries.json";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemporaryTree {
    root_index: usize,
    path: PathBuf,
    identity: TreeIdentity,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: u32,
    transaction: String,
    profile: String,
    trees: Vec<TemporaryTree>,
}

fn read(checkpoint: &RecoveryCheckpoint) -> Result<Receipt> {
    let journal = checkpoint.read()?;
    let transaction = checkpoint
        .root()
        .file_name()
        .and_then(|name| name.to_str())
        .context("restore preparation transaction has no name")?;
    let path = checkpoint.root().join(RECEIPT);
    let mut receipt = Receipt {
        schema: 1,
        transaction: transaction.to_owned(),
        profile: journal.profile.clone(),
        trees: Vec::new(),
    };
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "restore preparation receipt is not a regular file"
            );
            receipt = serde_json::from_slice(&crate::bounded_file::read(&path, MAX_BYTES)?)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    ensure!(
        receipt.schema == 1
            && receipt.transaction == transaction
            && receipt.profile == journal.profile
            && crate::startup::safe_name(&receipt.transaction)
            && crate::startup::safe_name(&receipt.profile)
            && receipt.trees.len() <= 1024,
        "invalid restore preparation receipt"
    );
    for tree in &receipt.trees {
        let target = journal
            .roots
            .get(tree.root_index)
            .context("invalid restore preparation root index")?;
        let name = tree
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .context("restore preparation tree has no name")?;
        ensure!(
            tree.path.is_absolute()
                && tree.path.parent() == target.target.parent()
                && !tree
                    .path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
                && name
                    .strip_prefix(".ryu-restore-")
                    .is_some_and(crate::startup::safe_name),
            "restore preparation tree escapes its target parent"
        );
    }
    Ok(receipt)
}

pub(crate) fn record(
    checkpoint: &RecoveryCheckpoint,
    root_index: usize,
    path: &Path,
) -> Result<()> {
    ensure!(
        matches!(
            checkpoint.read()?.phase,
            RecoveryPhase::Prepared | RecoveryPhase::Restoring { .. }
        ),
        "restore preparation receipt requires preinstallation or restoration phase"
    );
    let Some(identity) = TreeIdentity::read(path)? else {
        return Ok(());
    };
    let mut receipt = read(checkpoint)?;
    let mut surviving = Vec::new();
    for tree in receipt.trees {
        if TreeIdentity::read(&tree.path)?.as_ref() == Some(&tree.identity) {
            surviving.push(tree);
        }
    }
    ensure!(surviving.len() < 1024, "too many restore preparation trees");
    surviving.push(TemporaryTree {
        root_index,
        path: path.to_owned(),
        identity,
    });
    receipt.trees = surviving;
    let bytes = serde_json::to_vec(&receipt)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "restore preparation receipt is oversized"
    );
    let mut file = tempfile::NamedTempFile::new_in(checkpoint.root())?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(checkpoint.root().join(RECEIPT))
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(checkpoint.root())?.sync_all()?;
    Ok(())
}

pub(crate) fn owned_paths(
    checkpoint: &RecoveryCheckpoint,
    protected_roots: &[PathBuf],
) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for tree in read(checkpoint)?.trees {
        let physical = crate::data_lease::normalized(&tree.path)?;
        if protected_roots
            .iter()
            .any(|root| physical.starts_with(root) || root.starts_with(&physical))
        {
            continue;
        }
        ensure!(
            physical == tree.path,
            "restore preparation tree moved or linked"
        );
        if TreeIdentity::read(&tree.path)?.as_ref() == Some(&tree.identity) {
            paths.push(tree.path);
        }
    }
    Ok(paths)
}

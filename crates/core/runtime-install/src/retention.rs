//! Bound completed history without deleting a pending or unverified rollback point.
use crate::{
    recovery::{RecoveryCheckpoint, RecoveryPhase},
    startup::{fence_lease, safe_name},
};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

const KEEP: usize = 2;
const RETIRED: &str = ".retired-";
const INTENT: &str = ".retirement-";

#[derive(Default)]
pub struct HistoryPruneReport {
    pub newly_retired: usize,
    pub retired_transactions: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetirementIntent {
    schema: u32,
    transaction: String,
    profile: String,
    identity: crate::tree_identity::TreeIdentity,
}

fn intent_path(transactions: &Path, transaction: &str) -> PathBuf {
    transactions.join(format!("{INTENT}{transaction}.json"))
}

fn write_retirement_intent(
    transactions: &Path,
    transaction: &str,
    profile: &str,
    source: &Path,
) -> Result<()> {
    ensure!(
        safe_name(transaction) && safe_name(profile),
        "invalid retirement intent"
    );
    let identity = crate::tree_identity::TreeIdentity::read(source)?
        .ok_or_else(|| anyhow::anyhow!("retirement tree identity is unavailable"))?;
    let intent = RetirementIntent {
        schema: 1,
        transaction: transaction.to_owned(),
        profile: profile.to_owned(),
        identity,
    };
    let mut file = tempfile::NamedTempFile::new_in(transactions)?;
    file.write_all(&serde_json::to_vec(&intent)?)?;
    file.as_file().sync_all()?;
    file.persist(intent_path(transactions, transaction))
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(transactions)?.sync_all()?;
    Ok(())
}

fn pending(namespace: &Path) -> Result<bool> {
    for entry in fs::read_dir(namespace)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("pending-") && name.ends_with(".json") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn retirement_intent(path: &Path, profile: &str) -> Result<Option<RetirementIntent>> {
    let transactions = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("retired tree has no parent"))?;
    let transaction = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(RETIRED))
        .filter(|name| safe_name(name))
        .ok_or_else(|| anyhow::anyhow!("invalid retired tree name"))?;
    let receipt = intent_path(transactions, transaction);
    let metadata = match fs::symlink_metadata(&receipt) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 4096,
        "invalid retirement receipt file"
    );
    let mut bytes = Vec::new();
    fs::File::open(receipt)?
        .take(4097)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "retirement receipt is oversized");
    let intent: RetirementIntent = serde_json::from_slice(&bytes)?;
    ensure!(
        intent.schema == 1 && intent.transaction == transaction && safe_name(&intent.profile),
        "invalid retirement receipt"
    );
    if intent.profile != profile
        || crate::tree_identity::TreeIdentity::read(path)?.as_ref() != Some(&intent.identity)
    {
        return Ok(None);
    }
    Ok(Some(intent))
}

fn remove_retired(path: PathBuf, profile: &str) -> Result<bool> {
    // This receipt remains outside the recursive deletion. Losing the journal
    // during a partial deletion cannot erase authorization for its retry.
    let Some(intent) = retirement_intent(&path, profile)? else {
        return Ok(false);
    };
    fs::remove_dir_all(&path)?;
    let transactions = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("retired tree has no parent"))?;
    fs::remove_file(intent_path(transactions, &intent.transaction))?;
    #[cfg(unix)]
    fs::File::open(transactions)?.sync_all()?;
    Ok(true)
}

/// Keep two recent, verified checkpoints for this profile. Busy, incomplete,
/// malformed, linked, and other-profile entries are preserved. Deletion runs
/// outside the startup-fence critical section and never touches live targets.
pub fn prune_terminal_history(
    namespace: &Path,
    profile: &str,
    protected_roots: &[PathBuf],
) -> Result<usize> {
    prune_terminal_history_report(namespace, profile, protected_roots)
        .map(|report| report.newly_retired)
}

pub fn prune_terminal_history_report(
    namespace: &Path,
    profile: &str,
    protected_roots: &[PathBuf],
) -> Result<HistoryPruneReport> {
    ensure!(
        namespace.is_absolute() && safe_name(profile),
        "invalid retention namespace/profile"
    );
    let expected = fs::canonicalize(
        namespace
            .parent()
            .ok_or_else(|| anyhow::anyhow!("retention namespace has no parent"))?,
    )?
    .join(
        namespace
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("retention namespace has no name"))?,
    );
    let namespace = fs::canonicalize(namespace)?;
    ensure!(
        namespace == expected,
        "retention namespace changed identity"
    );
    let protected_roots = protected_roots
        .iter()
        .map(|path| crate::data_lease::normalized(path))
        .collect::<Result<Vec<_>>>()?;
    let transactions = namespace.join("transactions");
    if !transactions.exists() {
        return Ok(HistoryPruneReport::default());
    }
    ensure!(
        fs::canonicalize(&transactions)? == transactions,
        "retention transaction directory changed identity"
    );
    let fence = fence_lease(&namespace)?;
    if pending(&namespace)? {
        return Ok(HistoryPruneReport::default());
    }
    let mut checkpoints: Vec<(SystemTime, String, RecoveryCheckpoint)> = Vec::new();
    let mut retired = Vec::new();
    let mut preparations = Vec::new();
    for entry in fs::read_dir(&transactions)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let file_type = entry.file_type()?;
        if let Some(transaction) = name
            .strip_prefix(".preparation-")
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|name| safe_name(name))
        {
            if file_type.is_file() && entry.metadata()?.len() <= 4096 {
                ensure!(preparations.len() < 1024, "too many preparation receipts");
                // Names select a candidate only; the cleanup API separately
                // validates bounded phase/profile/identity ownership proof.
                preparations.push(transactions.join(transaction));
            }
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }
        if protected_roots
            .iter()
            .any(|root| entry.path().starts_with(root) || root.starts_with(entry.path()))
        {
            continue;
        }
        let is_retired = name.strip_prefix(RETIRED).is_some_and(safe_name);
        if !is_retired && !safe_name(name) {
            continue;
        }
        if fs::canonicalize(entry.path())? != entry.path() {
            continue;
        }
        if is_retired {
            // Legacy or damaged receipts are preserved, even when a journal
            // remains. Only the intent written after survivor verification
            // authorizes deleting a tree whose journal might be gone.
            if matches!(retirement_intent(&entry.path(), profile), Ok(Some(_))) {
                retired.push(entry.path());
            }
            continue;
        }
        let checkpoint = match RecoveryCheckpoint::open(entry.path()) {
            Ok(checkpoint) => checkpoint,
            Err(_) => continue, // Locked or unreadable history is not disposable.
        };
        let journal = checkpoint.read()?;
        if journal.profile != profile
            || !matches!(
                journal.phase,
                RecoveryPhase::Committed | RecoveryPhase::Restored
            )
        {
            continue;
        }
        checkpoints.push((
            fs::metadata(entry.path().join("recovery.json"))?.modified()?,
            name.to_owned(),
            checkpoint,
        ));
    }
    drop(fence);
    // No pending marker existed at selection. A live capture holds its
    // checkpoint lock; the cleanup API takes that lock and a recovery data
    // lease before rechecking publication evidence. Unique transaction names
    // and those leases exclude update/runtime writers during recursive deletion,
    // so startup admission need not wait behind a large incomplete copy.
    for root in preparations {
        // Malformed receipts, busy trees, and inaccessible copies are preserved.
        let _ = crate::recovery::cleanup_incomplete_preparation(
            &root,
            namespace
                .parent()
                .ok_or_else(|| anyhow::anyhow!("retention cache has no parent"))?,
            profile,
            &protected_roots,
        );
    }
    checkpoints.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    if checkpoints.is_empty() {
        return Ok(HistoryPruneReport::default());
    }
    let mut leased_paths = retired.clone();
    for (_, name, checkpoint) in &checkpoints {
        leased_paths.push(checkpoint.root().to_owned());
        leased_paths.push(transactions.join(format!("{RETIRED}{name}")));
        leased_paths.extend(checkpoint.owned_terminal_paths(&protected_roots)?);
    }
    // One batch deduplicates shared ancestor locks. Hold it through retirement
    // and deletion, including prospective names, to prevent late runtime starts.
    let data_lease = match crate::data_lease::DataLease::recovery(
        namespace
            .parent()
            .ok_or_else(|| anyhow::anyhow!("retention cache has no parent"))?,
        &leased_paths,
    ) {
        Ok(lease) => lease,
        Err(_) => return Ok(HistoryPruneReport::default()),
    };
    // Verify the backups which survive before discarding any other copy.
    for (_, _, checkpoint) in checkpoints.iter().take(KEEP) {
        checkpoint.verify_snapshots()?;
    }
    // These paths have unique transaction names and stable recorded identities.
    // A new update uses a new transaction; it cannot inherit these trees.
    for (_, _, checkpoint) in &checkpoints {
        checkpoint.cleanup_owned_terminal_trees(&protected_roots, &data_lease)?;
    }
    let to_retire: Vec<_> = checkpoints
        .iter()
        .skip(KEEP)
        .map(|(_, name, checkpoint)| (name.clone(), checkpoint.root().to_owned()))
        .collect();
    // Receipt serialization and fsync run outside the short namespace fence.
    // The checkpoint and batch data leases remain held until publication.
    for (name, source) in &to_retire {
        write_retirement_intent(&transactions, name, profile, source)?;
    }
    let fence = fence_lease(&namespace)?;
    if pending(&namespace)? {
        return Ok(HistoryPruneReport::default());
    }
    // NTFS cannot rename a directory while its journal lock is open. Terminal
    // phases are immutable; the namespace fence prevents publishing a recovery
    // claim while those writer handles are released and names are retired.
    drop(checkpoints);
    let mut removed = 0;
    for (name, source) in to_retire {
        let destination = transactions.join(format!("{RETIRED}{name}"));
        ensure!(
            !destination.exists(),
            "retirement destination already exists"
        );
        fs::rename(source, &destination)?;
        retired.push(destination);
        removed += 1;
    }
    #[cfg(unix)]
    fs::File::open(&transactions)?.sync_all()?;
    drop(fence);
    let mut retired_transactions = Vec::new();
    for path in retired {
        let transaction = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(RETIRED))
            .ok_or_else(|| anyhow::anyhow!("invalid retired transaction"))?
            .to_owned();
        if remove_retired(path, profile)? {
            retired_transactions.push(transaction);
        }
    }
    drop(data_lease);
    Ok(HistoryPruneReport {
        newly_retired: removed,
        retired_transactions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(namespace: &Path, id: &str, profile: &str) -> PathBuf {
        fs::create_dir_all(namespace.join("transactions")).unwrap();
        let data = namespace.parent().unwrap().join(format!("data-{id}"));
        fs::create_dir(&data).unwrap();
        fs::write(data.join("value"), id).unwrap();
        let root = namespace.join("transactions").join(id);
        let checkpoint = RecoveryCheckpoint::create(
            root.clone(),
            &[data],
            "1".into(),
            "2".into(),
            profile.into(),
        )
        .unwrap();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        drop(checkpoint);
        root
    }

    fn interrupted_preparation() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let root = namespace.join("transactions/checkpoint");
        fs::create_dir_all(&root).unwrap();
        let capture = crate::preparation::Capture::start(&root, "dev")
            .unwrap()
            .unwrap();
        fs::create_dir(root.join("snapshot-0")).unwrap();
        fs::write(root.join("snapshot-0/value"), "partial").unwrap();
        std::mem::forget(capture);
        (home, namespace, root)
    }

    #[test]
    fn preparation_only_namespace_replays_owned_capture_cleanup() {
        let (_home, namespace, root) = interrupted_preparation();
        let report = prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(!root.exists());
        assert!(!namespace
            .join("transactions/.preparation-checkpoint.json")
            .exists());
        assert_eq!(report.newly_retired, 0);
        assert!(report.retired_transactions.is_empty());
    }

    #[test]
    fn pending_marker_defers_preparation_cleanup() {
        let (_home, namespace, root) = interrupted_preparation();
        let marker = namespace.join("pending-dev.json");
        fs::write(&marker, "pending").unwrap();
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(root.join("snapshot-0/value").exists());
        fs::remove_file(marker).unwrap();
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn active_capture_checkpoint_lease_defers_preparation_cleanup() {
        let (_home, namespace, root) = interrupted_preparation();
        let capture_lease = crate::recovery::acquire_lease(&root).unwrap();
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(root.join("snapshot-0/value").exists());
        drop(capture_lease);
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn preparation_cleanup_preserves_other_profiles_selected_paths_and_live_writers() {
        let (home, namespace, root) = interrupted_preparation();
        prune_terminal_history_report(&namespace, "beta", &[]).unwrap();
        assert!(root.join("snapshot-0/value").exists());
        prune_terminal_history_report(&namespace, "dev", &[root.join("snapshot-0")]).unwrap();
        assert!(root.join("snapshot-0/value").exists());
        let writer =
            crate::data_lease::DataLease::writer(home.path(), &[root.join("snapshot-0")]).unwrap();
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(root.join("snapshot-0/value").exists());
        drop(writer);
        prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn publishing_and_installer_evidence_preserve_preparation_copies() {
        for evidence in [
            "publishing",
            "recovery.json",
            "owned-processes.json",
            "checkpoint-ready.json",
        ] {
            let (_home, namespace, root) = interrupted_preparation();
            if evidence == "publishing" {
                let receipt = namespace.join("transactions/.preparation-checkpoint.json");
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
                value["phase"] = serde_json::json!("publishing");
                fs::write(receipt, serde_json::to_vec(&value).unwrap()).unwrap();
            } else if evidence == "checkpoint-ready.json" {
                fs::create_dir_all(namespace.join("handoffs/checkpoint")).unwrap();
                fs::write(
                    namespace.join("handoffs/checkpoint/checkpoint-ready.json"),
                    "ready",
                )
                .unwrap();
            } else {
                fs::write(root.join(evidence), "ownership-evidence").unwrap();
            }
            prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
            assert!(root.join("snapshot-0/value").exists(), "deleted {evidence}");
        }
    }

    #[test]
    fn damaged_receipts_and_unowned_directories_are_never_guessed_disposable() {
        for bytes in [b"{".to_vec(), vec![b' '; 4097]] {
            let (_home, namespace, root) = interrupted_preparation();
            fs::write(
                namespace.join("transactions/.preparation-checkpoint.json"),
                bytes,
            )
            .unwrap();
            let unowned = namespace.join("transactions/unowned");
            fs::create_dir(&unowned).unwrap();
            fs::write(unowned.join("user-data"), "keep").unwrap();
            prune_terminal_history_report(&namespace, "dev", &[]).unwrap();
            assert!(root.join("snapshot-0/value").exists());
            assert_eq!(
                fs::read_to_string(unowned.join("user-data")).unwrap(),
                "keep"
            );
        }
    }

    fn interrupted_retirement() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let first = history(&namespace, "first", "dev");
        history(&namespace, "second", "dev");
        history(&namespace, "third", "dev");
        let transactions = namespace.join("transactions");
        write_retirement_intent(&transactions, "first", "dev", &first).unwrap();
        let retired = transactions.join(".retired-first");
        fs::rename(first, &retired).unwrap();
        fs::remove_file(retired.join("recovery.json")).unwrap();
        assert!(retired.join("snapshot-0/value").exists());
        (home, namespace, retired)
    }

    #[test]
    fn retirement_replays_after_partial_deletion_loses_journal() {
        let (_home, namespace, retired) = interrupted_retirement();
        prune_terminal_history(&namespace, "dev", &[]).unwrap();
        assert!(!retired.exists());
        assert!(!intent_path(&namespace.join("transactions"), "first").exists());
        assert!(namespace
            .join("transactions/second/snapshot-0/value")
            .exists());
        assert!(namespace
            .join("transactions/third/snapshot-0/value")
            .exists());
    }

    #[test]
    fn retirement_receipts_fail_closed_when_missing_malformed_or_oversized() {
        for bytes in [None, Some(b"{".to_vec()), Some(vec![b' '; 4097])] {
            let (_home, namespace, retired) = interrupted_retirement();
            let receipt = intent_path(&namespace.join("transactions"), "first");
            if let Some(bytes) = bytes {
                fs::write(receipt, bytes).unwrap();
            } else {
                fs::remove_file(receipt).unwrap();
            }
            prune_terminal_history(&namespace, "dev", &[]).unwrap();
            assert!(retired.join("snapshot-0/value").exists());
        }
    }

    #[test]
    fn retirement_receipts_reject_wrong_profile_transaction_and_schema() {
        for field in ["profile", "transaction", "schema"] {
            let (_home, namespace, retired) = interrupted_retirement();
            let receipt = intent_path(&namespace.join("transactions"), "first");
            let mut intent: serde_json::Value =
                serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
            intent[field] = match field {
                "schema" => serde_json::json!(2),
                "profile" => serde_json::json!("beta"),
                _ => serde_json::json!("../first"),
            };
            fs::write(receipt, serde_json::to_vec(&intent).unwrap()).unwrap();
            prune_terminal_history(&namespace, "dev", &[]).unwrap();
            assert!(retired.join("snapshot-0/value").exists());
        }
    }

    #[test]
    fn retirement_receipt_does_not_authorize_a_replacement_tree() {
        let (home, namespace, retired) = interrupted_retirement();
        fs::rename(&retired, home.path().join("original-retired")).unwrap();
        fs::create_dir(&retired).unwrap();
        fs::write(retired.join("user-data"), "keep").unwrap();
        prune_terminal_history(&namespace, "dev", &[]).unwrap();
        assert_eq!(
            fs::read_to_string(retired.join("user-data")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn retirement_replay_preserves_selected_and_live_snapshot_paths() {
        let (home, namespace, retired) = interrupted_retirement();
        let snapshot = retired.join("snapshot-0");
        prune_terminal_history(&namespace, "dev", &[snapshot.clone()]).unwrap();
        assert!(snapshot.join("value").exists());
        let writer =
            crate::data_lease::DataLease::writer(home.path(), &[snapshot.clone()]).unwrap();
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 0);
        assert!(snapshot.join("value").exists());
        drop(writer);
        prune_terminal_history(&namespace, "dev", &[]).unwrap();
        assert!(!retired.exists());
    }

    #[test]
    fn retirement_replay_preserves_trees_when_surviving_backups_are_damaged() {
        let (_home, namespace, retired) = interrupted_retirement();
        fs::write(
            namespace.join("transactions/third/snapshot-0/value"),
            "damaged",
        )
        .unwrap();
        assert!(prune_terminal_history(&namespace, "dev", &[]).is_err());
        assert!(retired.join("snapshot-0/value").exists());
    }

    #[test]
    fn keeps_two_verified_checkpoints_and_other_profiles() {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let first = history(&namespace, "first", "dev");
        history(&namespace, "second", "dev");
        history(&namespace, "third", "dev");
        let beta = history(&namespace, "beta", "beta");
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 1);
        assert!(!first.exists());
        assert!(beta.exists());
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 0);
    }

    #[test]
    fn corrupt_recent_snapshot_prevents_pruning_good_history() {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let first = history(&namespace, "first", "dev");
        history(&namespace, "second", "dev");
        let third = history(&namespace, "third", "dev");
        fs::write(third.join("snapshot-0/value"), "damaged").unwrap();
        assert!(prune_terminal_history(&namespace, "dev", &[]).is_err());
        assert!(first.exists());
    }

    #[test]
    fn pending_or_locked_transaction_is_not_pruned() {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let first = history(&namespace, "first", "dev");
        history(&namespace, "second", "dev");
        history(&namespace, "third", "dev");
        fs::write(namespace.join("pending-dev.json"), "pending").unwrap();
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 0);
        fs::remove_file(namespace.join("pending-dev.json")).unwrap();
        let held = RecoveryCheckpoint::open(first.clone()).unwrap();
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 0);
        assert!(first.exists());
        drop(held);
    }

    #[test]
    fn live_runtime_using_an_old_snapshot_preserves_its_checkpoint() {
        let home = tempfile::tempdir().unwrap();
        let namespace = home.path().join("recovery");
        let first = history(&namespace, "first", "dev");
        history(&namespace, "second", "dev");
        history(&namespace, "third", "dev");
        let writer =
            crate::data_lease::DataLease::writer(home.path(), &[first.join("snapshot-0")]).unwrap();
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 0);
        assert!(first.exists());
        drop(writer);
        assert_eq!(prune_terminal_history(&namespace, "dev", &[]).unwrap(), 1);
    }
}

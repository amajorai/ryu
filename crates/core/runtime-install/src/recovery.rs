//! Durable, resumable checkpoints for a supervised application update.
//! Callers must quiesce every writer before checkpointing or restoring roots.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const JOURNAL: &str = "recovery.json";
const OWNED_TREES: &str = "owned-trees.json";
const MAX_ROOTS: usize = 128;
// Bound recursive stack use and cumulative directory-entry allocation before
// installation. File contents remain streamed, with no byte-size limit.
const MAX_TREE_DEPTH: usize = 64;
const MAX_TREE_ENTRIES: usize = 100_000;
const MAX_TREE_PATH_BYTES: usize = 64 * 1024 * 1024;

struct TraversalBudget {
    entries_left: usize,
    path_bytes_left: usize,
}

impl TraversalBudget {
    fn new() -> Self {
        Self {
            entries_left: MAX_TREE_ENTRIES,
            path_bytes_left: MAX_TREE_PATH_BYTES,
        }
    }

    fn visit(&mut self, path: &Path, depth: usize) -> Result<()> {
        ensure!(
            depth <= MAX_TREE_DEPTH,
            "checkpoint tree exceeds depth limit"
        );
        self.entries_left = self
            .entries_left
            .checked_sub(1)
            .context("checkpoint tree exceeds entry limit")?;
        self.path_bytes_left = self
            .path_bytes_left
            .checked_sub(path.as_os_str().as_encoded_bytes().len())
            .context("checkpoint tree exceeds path allocation limit")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OwnedTreeKind {
    Failed,
    Restore,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedTree {
    root_index: usize,
    kind: OwnedTreeKind,
    identity: crate::tree_identity::TreeIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum RecoveryPhase {
    Prepared,
    Installing,
    AwaitingHealth,
    Committed,
    Restoring { next_root: usize },
    Restored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointRoot {
    pub target: PathBuf,
    pub existed: bool,
    pub directory: bool,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryJournal {
    pub schema: u32,
    pub previous_version: String,
    pub expected_version: String,
    pub profile: String,
    pub phase: RecoveryPhase,
    pub roots: Vec<CheckpointRoot>,
}

pub struct RecoveryCheckpoint {
    root: PathBuf,
    lease: Option<fs::File>,
}

pub(crate) fn acquire_lease(root: &Path) -> Result<fs::File> {
    let path = root.join("recovery.lock");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "invalid recovery lock file"
        );
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    fs4::FileExt::try_lock_exclusive(&file).context(LEASE_HELD)?;
    Ok(file)
}

const LEASE_HELD: &str = "another recovery supervisor owns this transaction";

fn normalize(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "checkpoint paths must be absolute");
    ensure!(
        !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)),
        "checkpoint path traverses a parent"
    );
    if path.exists() {
        return Ok(fs::canonicalize(path)?);
    }
    let parent = path.parent().context("checkpoint path has no parent")?;
    Ok(fs::canonicalize(parent)?.join(path.file_name().context("checkpoint path has no name")?))
}

fn copy_entry(source: &Path, destination: &Path, boundary: &Path) -> Result<()> {
    copy_entry_bounded(
        source,
        destination,
        boundary,
        0,
        &mut TraversalBudget::new(),
    )
}

fn copy_entry_bounded(
    source: &Path,
    destination: &Path,
    boundary: &Path,
    depth: usize,
    budget: &mut TraversalBudget,
) -> Result<()> {
    budget.visit(source, depth)?;
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        let link = fs::read_link(source)?;
        ensure!(
            !link.is_absolute() && fs::canonicalize(source)?.starts_with(boundary),
            "checkpoint link escapes its root"
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, destination)?;
        #[cfg(windows)]
        if source.is_dir() {
            std::os::windows::fs::symlink_dir(link, destination)?;
        } else {
            std::os::windows::fs::symlink_file(link, destination)?;
        }
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry_bounded(
                &entry.path(),
                &destination.join(entry.file_name()),
                boundary,
                depth + 1,
                budget,
            )?;
        }
        #[cfg(unix)]
        fs::File::open(destination)?.sync_all()?;
    } else {
        ensure!(metadata.is_file(), "checkpoint contains a special file");
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    }
    fs::set_permissions(destination, metadata.permissions())?;
    Ok(())
}

// Include structure and permissions, not just file contents. Length framing
// prevents different filenames or links from producing an ambiguous stream.
fn entry_digest(root: &Path) -> Result<String> {
    entry_digest_bounded(root, &mut TraversalBudget::new())
}

fn entry_digest_bounded(root: &Path, budget: &mut TraversalBudget) -> Result<String> {
    fn entries(
        path: &Path,
        depth: usize,
        budget: &mut TraversalBudget,
    ) -> Result<Vec<fs::DirEntry>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            // Charge before retaining the entry. Ancestor vectors remain
            // live during recursion, so this budget spans the whole tree.
            budget.visit(&entry.path(), depth + 1)?;
            entries.push(entry);
        }
        entries.sort_by_key(|entry| entry.file_name());
        Ok(entries)
    }

    fn field(hash: &mut Sha256, bytes: &[u8]) {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    fn walk(
        path: &Path,
        hash: &mut Sha256,
        buffer: &mut [u8],
        depth: usize,
        budget: &mut TraversalBudget,
    ) -> Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            field(hash, b"link");
            field(hash, fs::read_link(path)?.as_os_str().as_encoded_bytes());
            return Ok(());
        }
        hash.update([u8::from(metadata.permissions().readonly())]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            hash.update(metadata.permissions().mode().to_le_bytes());
        }
        if metadata.is_dir() {
            field(hash, b"directory");
            let entries = entries(path, depth, budget)?;
            hash.update((entries.len() as u64).to_le_bytes());
            for entry in entries {
                field(hash, entry.file_name().as_encoded_bytes());
                walk(&entry.path(), hash, buffer, depth + 1, budget)?;
            }
        } else {
            ensure!(metadata.is_file(), "checkpoint contains a special file");
            field(hash, b"file");
            hash.update(metadata.len().to_le_bytes());
            let mut input = fs::File::open(path)?;
            loop {
                let length = std::io::Read::read(&mut input, buffer)?;
                if length == 0 {
                    break;
                }
                hash.update(&buffer[..length]);
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 65536];
    budget.visit(root, 0)?;
    walk(root, &mut hash, &mut buffer, 0, budget)?;
    Ok(format!("{:x}", hash.finalize()))
}

/// Remove only an identified checkpoint whose durable preparation receipt
/// proves journal publication had not begun. Hold the namespace fence when
/// selecting it; configured/live data paths remain protected by batch leases.
pub fn cleanup_incomplete_preparation(
    root: &Path,
    cache: &Path,
    profile: &str,
    protected_roots: &[PathBuf],
) -> Result<bool> {
    crate::preparation::cleanup(root, cache, profile, protected_roots)
}

impl RecoveryCheckpoint {
    fn owned_trees(&self) -> Result<Vec<OwnedTree>> {
        let bytes = match crate::bounded_file::read(&self.root.join(OWNED_TREES), 65536) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let trees: Vec<OwnedTree> = serde_json::from_slice(&bytes)?;
        let roots = self.read()?.roots.len();
        ensure!(
            trees.len() <= roots * 2 && trees.iter().all(|tree| tree.root_index < roots),
            "invalid cleanup ownership receipt"
        );
        Ok(trees)
    }

    fn record_owned_tree(&self, index: usize, kind: OwnedTreeKind, path: &Path) -> Result<()> {
        ensure!(
            self.lease.is_some(),
            "cleanup ownership requires a writer lease"
        );
        let Some(identity) = crate::tree_identity::TreeIdentity::read(path)? else {
            return Ok(());
        };
        let mut trees = self.owned_trees()?;
        trees.retain(|tree| tree.root_index != index || tree.kind != kind);
        trees.push(OwnedTree {
            root_index: index,
            kind,
            identity,
        });
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(&serde_json::to_vec(&trees)?)?;
        file.as_file().sync_all()?;
        file.persist(self.root.join(OWNED_TREES))
            .map_err(|error| error.error)?;
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    /// Delete only redundant trees whose original filesystem identity survives.
    /// The complete, integrity-checked checkpoint itself remains available.
    pub fn cleanup_terminal_trees(
        &self,
        cache: &Path,
        protected_roots: &[PathBuf],
    ) -> Result<usize> {
        let protected_roots = protected_roots
            .iter()
            .map(|path| crate::data_lease::normalized(path))
            .collect::<Result<Vec<_>>>()?;
        let mut paths = self.owned_terminal_paths(&protected_roots)?;
        if paths.is_empty() {
            return Ok(0);
        }
        paths.push(self.root.clone());
        let lease = crate::data_lease::DataLease::recovery(cache, &paths)?;
        self.verify_snapshots()?;
        self.cleanup_owned_terminal_trees(&protected_roots, &lease)
    }

    pub(crate) fn owned_terminal_paths(&self, protected_roots: &[PathBuf]) -> Result<Vec<PathBuf>> {
        ensure!(self.lease.is_some(), "cleanup requires a writer lease");
        let journal = self.read()?;
        ensure!(
            matches!(
                journal.phase,
                RecoveryPhase::Committed | RecoveryPhase::Restored
            ),
            "cannot clean a nonterminal recovery transaction"
        );
        let mut paths = Vec::new();
        for owned in self.owned_trees()? {
            let target = &journal.roots[owned.root_index].target;
            let (failed, restore) = self.restore_paths(target)?;
            let path = match owned.kind {
                OwnedTreeKind::Failed => failed,
                OwnedTreeKind::Restore => restore,
            };
            let physical = crate::data_lease::normalized(&path)?;
            if protected_roots
                .iter()
                .any(|root| physical.starts_with(root) || root.starts_with(&physical))
            {
                continue;
            }
            if crate::tree_identity::TreeIdentity::read(&path)?.as_ref() != Some(&owned.identity) {
                continue;
            }
            let parent = target.parent().context("cleanup target has no parent")?;
            // Never resolve a moved parent into some other user's folder.
            ensure!(
                fs::canonicalize(parent)? == parent,
                "cleanup parent changed identity"
            );
            paths.push(path);
        }
        paths.extend(crate::restore_preparation::owned_paths(
            self,
            protected_roots,
        )?);
        Ok(paths)
    }

    pub(crate) fn cleanup_owned_terminal_trees(
        &self,
        protected_roots: &[PathBuf],
        _lease: &crate::data_lease::DataLease,
    ) -> Result<usize> {
        let mut removed = 0;
        for path in self.owned_terminal_paths(protected_roots)? {
            if fs::symlink_metadata(&path)?.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
            removed += 1;
        }
        Ok(removed)
    }

    fn restore_paths(&self, target: &Path) -> Result<(PathBuf, PathBuf)> {
        let parent = target.parent().context("recovery target has no parent")?;
        let name = target
            .file_name()
            .context("recovery target has no name")?
            .to_string_lossy();
        let id = self
            .root
            .file_name()
            .context("checkpoint name")?
            .to_string_lossy();
        Ok((
            parent.join(format!(".{name}.{id}.failed")),
            parent.join(format!(".{name}.{id}.restore")),
        ))
    }

    fn prepare_restore_tree(&self, index: usize, target: &CheckpointRoot) -> Result<()> {
        let parent = target
            .target
            .parent()
            .context("recovery target has no parent")?;
        ensure!(
            fs::canonicalize(parent)? == parent,
            "recovery parent changed identity"
        );
        let (_, ready) = self.restore_paths(&target.target)?;
        if !ready.exists() {
            let preparing = tempfile::Builder::new()
                .prefix(".ryu-restore-")
                .tempdir_in(parent)?;
            ensure!(
                self.lease.is_some(),
                "restore preparation requires a writer lease"
            );
            // Persist ownership of the exact temporary directory before any
            // potentially large copy, so terminal maintenance can replay a crash.
            crate::restore_preparation::record(self, index, preparing.path())?;
            let complete = preparing.path().join("complete");
            let snapshot = self.root.join(format!("snapshot-{index}"));
            copy_entry(&snapshot, &complete, &snapshot)?;
            ensure!(
                target.digest.as_ref() == Some(&entry_digest(&complete)?),
                "reserved recovery tree failed integrity verification"
            );
            // Receipt precedes publication; a crash between these writes still
            // leaves either no tree or the exact identified tree at `ready`.
            self.record_owned_tree(index, OwnedTreeKind::Restore, &complete)?;
            fs::rename(complete, &ready)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
        }
        ensure!(
            target.digest.as_ref() == Some(&entry_digest(&ready)?),
            "prepared recovery tree failed integrity verification"
        );
        Ok(())
    }
    pub fn create(
        root: PathBuf,
        targets: &[PathBuf],
        previous_version: String,
        expected_version: String,
        profile: String,
    ) -> Result<Self> {
        ensure!(
            !targets.is_empty() && targets.len() <= MAX_ROOTS,
            "invalid checkpoint root count"
        );
        let root = normalize(&root)?;
        crate::preparation::validate(&root, &profile)?;
        fs::create_dir(&root)?;
        let mut capture = crate::preparation::Capture::start(&root, &profile)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let root = fs::canonicalize(root)?;
        let lease = Some(acquire_lease(&root)?);
        let checkpoint = Self { root, lease };
        let mut roots: Vec<CheckpointRoot> = Vec::new();
        for target in targets {
            let target = normalize(target)?;
            ensure!(
                !checkpoint.root.starts_with(&target) && !target.starts_with(&checkpoint.root),
                "checkpoint and target overlap"
            );
            ensure!(
                !roots
                    .iter()
                    .any(|existing| target.starts_with(&existing.target)
                        || existing.target.starts_with(&target)),
                "checkpoint roots overlap"
            );
            let metadata = match fs::symlink_metadata(&target) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            let digest = if metadata.is_some() {
                let snapshot = checkpoint.root.join(format!("snapshot-{}", roots.len()));
                copy_entry(&target, &snapshot, &target)?;
                let digest = entry_digest(&snapshot)?;
                ensure!(
                    entry_digest(&target)? == digest,
                    "checkpoint source changed while copying"
                );
                Some(digest)
            } else {
                None
            };
            roots.push(CheckpointRoot {
                target,
                existed: metadata.is_some(),
                directory: metadata.as_ref().is_some_and(|meta| meta.is_dir()),
                digest,
            });
        }
        if let Some(capture) = &mut capture {
            capture.publishing()?;
        }
        checkpoint.write(&RecoveryJournal {
            schema: 2,
            previous_version,
            expected_version,
            profile,
            phase: RecoveryPhase::Prepared,
            roots,
        })?;
        if let Some(capture) = capture {
            capture.finish()?;
        }
        Ok(checkpoint)
    }

    pub fn open(root: PathBuf) -> Result<Self> {
        let root = fs::canonicalize(root)?;
        let lease = Some(acquire_lease(&root)?);
        let checkpoint = Self { root, lease };
        checkpoint.read()?;
        Ok(checkpoint)
    }

    /// [`Self::open`] for the supervisor that takes the transaction over. A
    /// process forked by another of Core's threads holds a copy of Core's lease
    /// until it execs, so a lock released within `patience` is not another
    /// supervisor; one still held after it is, and is refused as before.
    pub fn open_taking_over(root: PathBuf, patience: std::time::Duration) -> Result<Self> {
        let deadline = std::time::Instant::now() + patience;
        loop {
            match Self::open(root.clone()) {
                Err(error)
                    if std::time::Instant::now() < deadline && error.to_string() == LEASE_HELD =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                outcome => return outcome,
            }
        }
    }

    /// Startup may inspect the journal and publish health while the independent
    /// supervisor holds the writer lease. Observers cannot change transaction state.
    pub fn observe(root: PathBuf) -> Result<Self> {
        let checkpoint = Self {
            root: fs::canonicalize(root)?,
            lease: None,
        };
        checkpoint.read()?;
        Ok(checkpoint)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn read(&self) -> Result<RecoveryJournal> {
        let journal: RecoveryJournal = serde_json::from_slice(&crate::bounded_file::read(
            &self.root.join(JOURNAL),
            1024 * 1024,
        )?)?;
        ensure!(
            journal.schema == 2 && !journal.roots.is_empty() && journal.roots.len() <= MAX_ROOTS,
            "invalid recovery journal schema"
        );
        for (index, root) in journal.roots.iter().enumerate() {
            ensure!(
                root.existed == root.digest.is_some(),
                "invalid recovery snapshot metadata"
            );
            ensure!(
                root.target.is_absolute() && root.target.parent().is_some(),
                "invalid recovery target"
            );
            ensure!(
                !root
                    .target
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir)),
                "recovery target traverses a parent"
            );
            ensure!(
                !self.root.starts_with(&root.target) && !root.target.starts_with(&self.root),
                "recovery target overlaps its checkpoint"
            );
            ensure!(
                !journal.roots[..index]
                    .iter()
                    .any(|other| root.target.starts_with(&other.target)
                        || other.target.starts_with(&root.target)),
                "recovery roots overlap"
            );
        }
        Ok(journal)
    }

    fn write(&self, journal: &RecoveryJournal) -> Result<()> {
        ensure!(
            self.lease.is_some(),
            "a recovery observer cannot change transaction state"
        );
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(&serde_json::to_vec(journal)?)?;
        file.as_file().sync_all()?;
        file.persist(self.root.join(JOURNAL))
            .map_err(|error| error.error)?;
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    pub fn verify_snapshots(&self) -> Result<()> {
        for (index, root) in self.read()?.roots.iter().enumerate() {
            if let Some(expected) = &root.digest {
                ensure!(
                    entry_digest(&self.root.join(format!("snapshot-{index}")))? == *expected,
                    "recovery snapshot {index} failed integrity verification"
                );
            }
        }
        Ok(())
    }

    /// Abort before installer launch without allocating another data copy.
    /// Every selected root must still match the checkpoint before releasing it.
    pub fn abort_prepared(&self) -> Result<()> {
        let mut journal = self.read()?;
        ensure!(
            journal.phase == RecoveryPhase::Prepared,
            "installation already began"
        );
        self.verify_snapshots()?;
        for target in &journal.roots {
            if let Some(expected) = &target.digest {
                ensure!(
                    entry_digest(&target.target)? == *expected,
                    "previous root changed before installation"
                );
            } else {
                ensure!(
                    fs::symlink_metadata(&target.target)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
                    "previously absent root changed before installation"
                );
            }
        }
        journal.phase = RecoveryPhase::Restored;
        self.write(&journal)
    }

    pub fn begin_installation(&self) -> Result<()> {
        self.verify_snapshots()?;
        let mut journal = self.read()?;
        ensure!(
            journal.phase == RecoveryPhase::Prepared,
            "recovery transaction is not prepared"
        );
        // Allocate and validate the complete rollback trees on each target's
        // own volume before the native installer changes anything. Failure or
        // low disk space here leaves the selected old app/data untouched.
        for (index, target) in journal.roots.iter().enumerate() {
            if target.existed {
                self.prepare_restore_tree(index, target)?;
            }
        }
        journal.phase = RecoveryPhase::Installing;
        self.write(&journal)
    }

    pub fn await_health(&self) -> Result<()> {
        let mut journal = self.read()?;
        ensure!(
            journal.phase == RecoveryPhase::Installing,
            "installation is not in progress"
        );
        journal.phase = RecoveryPhase::AwaitingHealth;
        self.write(&journal)
    }

    pub fn commit(&self, healthy_version: &str) -> Result<()> {
        let mut journal = self.read()?;
        ensure!(
            journal.phase == RecoveryPhase::AwaitingHealth,
            "update is not awaiting health"
        );
        ensure!(
            journal.expected_version == healthy_version,
            "startup acknowledgement is from a different release"
        );
        journal.phase = RecoveryPhase::Committed;
        self.write(&journal)
    }

    /// Call only after the failed app and all affected runtime writers stop.
    /// Repeating this after an interrupted restore converges to the old state.
    pub fn restore(&self) -> Result<()> {
        let mut journal = self.read()?;
        let installation_not_started = journal.phase == RecoveryPhase::Prepared;
        let start = match journal.phase {
            RecoveryPhase::Committed => bail!("a committed update cannot be restored"),
            RecoveryPhase::Restored => return Ok(()),
            RecoveryPhase::Restoring { next_root } => next_root,
            _ => 0,
        };
        ensure!(
            start <= journal.roots.len(),
            "invalid recovery restore index"
        );
        // Validate the entire checkpoint before swapping even the first root.
        self.verify_snapshots()?;
        // Progress is a claim about already-published roots, not permission to
        // skip verifying them after an interrupted recovery.
        for target in journal.roots.iter().take(start) {
            match fs::symlink_metadata(&target.target) {
                Ok(_) => ensure!(
                    target.existed
                        && target.digest.as_ref() == Some(&entry_digest(&target.target)?),
                    "completed recovery target does not match its checkpoint"
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure!(!target.existed, "completed recovery target is missing")
                }
                Err(error) => return Err(error.into()),
            }
        }
        for (index, target) in journal.roots.iter().enumerate().skip(start) {
            if !target.existed {
                continue;
            }
            let (failed, ready) = self.restore_paths(&target.target)?;
            if target.target.exists()
                && (failed.exists() || (!installation_not_started && !ready.exists()))
            {
                ensure!(
                    target.digest.as_ref() == Some(&entry_digest(&target.target)?),
                    "interrupted recovery target does not match the checkpoint"
                );
            } else {
                if installation_not_started {
                    self.prepare_restore_tree(index, target)?;
                }
                ensure!(
                    ready.exists() && target.digest.as_ref() == Some(&entry_digest(&ready)?),
                    "reserved restore tree is missing or damaged; refusing partial recovery"
                );
            }
        }
        for index in start..journal.roots.len() {
            journal.phase = RecoveryPhase::Restoring { next_root: index };
            self.write(&journal)?;
            let target = &journal.roots[index];
            let parent = target
                .target
                .parent()
                .context("recovery target has no parent")?;
            ensure!(
                fs::canonicalize(parent)? == parent,
                "recovery parent changed identity"
            );
            // Both swaps stay on the target's volume, even if the checkpoint was
            // stored on another drive. Keep the failed tree for diagnostics.
            let (failed, ready) = self.restore_paths(&target.target)?;
            if target.target.exists()
                && (failed.exists()
                    || (target.existed && !installation_not_started && !ready.exists()))
            {
                ensure!(
                    target.existed
                        && target.digest.as_ref() == Some(&entry_digest(&target.target)?),
                    "interrupted recovery target does not match the checkpoint"
                );
                journal.phase = RecoveryPhase::Restoring {
                    next_root: index + 1,
                };
                self.write(&journal)?;
                continue;
            }
            if target.existed && !ready.exists() {
                ensure!(
                    installation_not_started,
                    "reserved restore tree is missing; refusing partial recovery"
                );
                self.prepare_restore_tree(index, target)?;
            }
            if target.existed && ready.exists() {
                ensure!(
                    target.digest.as_ref() == Some(&entry_digest(&ready)?),
                    "prepared recovery tree failed integrity verification"
                );
            }
            if target.target.exists() && !failed.exists() {
                self.record_owned_tree(index, OwnedTreeKind::Failed, &target.target)?;
                fs::rename(&target.target, &failed)?;
            }
            if target.existed && !target.target.exists() {
                fs::rename(&ready, &target.target)?;
            }
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            journal.phase = RecoveryPhase::Restoring {
                next_root: index + 1,
            };
            self.write(&journal)?;
        }
        journal.phase = RecoveryPhase::Restored;
        self.write(&journal)
    }
}

#[cfg(test)]
mod tests {
    fn terminal_cleanup_fixture() -> (tempfile::TempDir, PathBuf, RecoveryCheckpoint) {
        let home = tempfile::tempdir().unwrap();
        let data = home.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("value"), "old").unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            home.path().join("transaction"),
            &[data.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        (home, data, checkpoint)
    }

    fn crashed_restore_temporary(checkpoint: &RecoveryCheckpoint) -> PathBuf {
        let journal = checkpoint.read().unwrap();
        let parent = journal.roots[0].target.parent().unwrap();
        let temporary = tempfile::Builder::new()
            .prefix(".ryu-restore-")
            .tempdir_in(parent)
            .unwrap()
            .keep();
        let identity = crate::tree_identity::TreeIdentity::read(&temporary)
            .unwrap()
            .unwrap();
        fs::write(
            checkpoint.root().join("restoring-temporaries.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": 1,
                "transaction": checkpoint.root().file_name().unwrap().to_str().unwrap(),
                "profile": journal.profile,
                "trees": [{ "root_index": 0, "path": temporary, "identity": identity }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(temporary.join("partial-model"), "partial-copy").unwrap();
        temporary
    }

    #[test]
    fn owned_crashed_restore_temporary_is_cleaned_after_terminal_commit() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .unwrap();
        assert!(
            !temporary.exists(),
            "owned partial restore copy was stranded"
        );
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "old");
    }

    #[test]
    fn restore_temporary_cleanup_preserves_preinstallation_and_legacy_trees() {
        let (_home, _data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        assert!(checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .is_err());
        assert!(temporary.join("partial-model").exists());
        fs::remove_file(checkpoint.root().join("restoring-temporaries.json")).unwrap();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .unwrap();
        assert!(
            temporary.join("partial-model").exists(),
            "legacy unnamed copy was guessed disposable"
        );
    }

    #[test]
    fn restore_temporary_cleanup_preserves_replacements_selected_and_live_paths() {
        let (home, _data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        checkpoint
            .cleanup_terminal_trees(home.path(), &[temporary.clone()])
            .unwrap();
        assert!(temporary.join("partial-model").exists());
        let writer =
            crate::data_lease::DataLease::writer(home.path(), &[temporary.clone()]).unwrap();
        assert!(checkpoint.cleanup_terminal_trees(home.path(), &[]).is_err());
        assert!(temporary.join("partial-model").exists());
        drop(writer);
        fs::rename(&temporary, home.path().join("original-temporary")).unwrap();
        fs::create_dir(&temporary).unwrap();
        fs::write(temporary.join("user-data"), "keep").unwrap();
        checkpoint.cleanup_terminal_trees(home.path(), &[]).unwrap();
        assert_eq!(
            fs::read_to_string(temporary.join("user-data")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn restore_temporary_receipts_preserve_wrong_profile_transaction_and_escaped_paths() {
        for field in ["profile", "transaction", "path"] {
            let (_home, _data, checkpoint) = terminal_cleanup_fixture();
            let temporary = crashed_restore_temporary(&checkpoint);
            checkpoint.begin_installation().unwrap();
            checkpoint.await_health().unwrap();
            checkpoint.commit("2").unwrap();
            let path = checkpoint.root().join("restoring-temporaries.json");
            let mut receipt: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            if field == "path" {
                receipt["trees"][0]["path"] =
                    serde_json::json!(checkpoint.root().join("../unowned"));
            } else {
                receipt[field] = serde_json::json!("beta");
            }
            fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
            assert!(checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .is_err());
            assert!(temporary.join("partial-model").exists());
        }
    }

    #[test]
    fn oversized_restore_temporary_receipt_preserves_all_copies() {
        let (_home, _data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        fs::write(
            checkpoint.root().join("restoring-temporaries.json"),
            vec![b' '; 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .is_err());
        assert!(temporary.join("partial-model").exists());
    }

    #[test]
    fn restore_temporary_cleanup_verifies_snapshots_and_repeats_after_absence() {
        let (_home, _data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let snapshot = checkpoint.root().join("snapshot-0/value");
        fs::write(&snapshot, "damaged").unwrap();
        assert!(checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .is_err());
        assert!(temporary.join("partial-model").exists());
        fs::write(snapshot, "old").unwrap();
        checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .unwrap();
        assert!(!temporary.exists());
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            0
        );
    }

    #[test]
    fn restore_temporary_reparse_replacement_never_deletes_its_target() {
        let (home, _data, checkpoint) = terminal_cleanup_fixture();
        let temporary = crashed_restore_temporary(&checkpoint);
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let moved = home.path().join("original-temporary");
        fs::rename(&temporary, &moved).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&moved, &temporary).unwrap();
        #[cfg(windows)]
        {
            // Junction creation requires no symlink privilege. Both arguments
            // are fixed/generated safe basenames inside this private fixture.
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(temporary.file_name().unwrap())
                .arg("original-temporary")
                .current_dir(home.path())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(
                status.success(),
                "could not create private junction fixture"
            );
        }
        assert!(checkpoint.cleanup_terminal_trees(home.path(), &[]).is_err());
        assert_eq!(
            fs::read_to_string(moved.join("partial-model")).unwrap(),
            "partial-copy"
        );
    }

    #[test]
    fn failed_capture_removes_only_its_new_checkpoint() {
        let home = tempfile::tempdir().unwrap();
        let data = home.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("value"), "old").unwrap();
        let root = home.path().join("checkpoint");
        assert!(RecoveryCheckpoint::create(
            root.clone(),
            &[data.clone(), data.clone()],
            "1".into(),
            "2".into(),
            "dev".into()
        )
        .is_err());
        assert!(
            !root.exists(),
            "failed capture stranded its first complete snapshot"
        );
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "old");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("user-data"), "keep").unwrap();
        assert!(RecoveryCheckpoint::create(
            root.clone(),
            &[data],
            "1".into(),
            "2".into(),
            "dev".into()
        )
        .is_err());
        assert_eq!(fs::read_to_string(root.join("user-data")).unwrap(), "keep");
    }

    #[test]
    fn restore_resumes_published_root_when_installer_deleted_original_target() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        let target = fs::canonicalize(&data).unwrap();
        let (failed, ready) = checkpoint.restore_paths(&target).unwrap();
        fs::remove_dir_all(&data).unwrap();
        let mut journal = checkpoint.read().unwrap();
        journal.phase = RecoveryPhase::Restoring { next_root: 0 };
        checkpoint.write(&journal).unwrap();
        fs::rename(ready, &data).unwrap(); // Crash before advancing the journal.
        assert!(!failed.exists());
        checkpoint.restore().unwrap();
        assert_eq!(checkpoint.read().unwrap().phase, RecoveryPhase::Restored);
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "old");
    }

    #[test]
    fn stale_completed_index_cannot_release_failed_update_data() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        fs::write(data.join("value"), "broken").unwrap();
        let mut journal = checkpoint.read().unwrap();
        journal.phase = RecoveryPhase::Restoring {
            next_root: journal.roots.len(),
        };
        checkpoint.write(&journal).unwrap();
        assert!(checkpoint.restore().is_err());
        assert_ne!(checkpoint.read().unwrap().phase, RecoveryPhase::Restored);
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "broken");
    }

    #[test]
    fn committed_cleanup_keeps_verified_checkpoint_and_live_data() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        assert!(checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .is_err());
        fs::write(data.join("value"), "new").unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            1
        );
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            0
        );
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "new");
        checkpoint.verify_snapshots().unwrap();
    }

    #[test]
    fn restored_cleanup_removes_failed_tree_but_preserves_restored_data() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        fs::write(data.join("value"), "broken").unwrap();
        checkpoint.restore().unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            1
        );
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "old");
        checkpoint.verify_snapshots().unwrap();
    }

    #[test]
    fn replacement_at_owned_path_is_never_deleted() {
        let (home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let (_, ready) = checkpoint
            .restore_paths(&fs::canonicalize(data).unwrap())
            .unwrap();
        fs::rename(&ready, home.path().join("moved-backup")).unwrap();
        fs::create_dir(&ready).unwrap();
        fs::write(ready.join("user-file"), "keep").unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            0
        );
        assert_eq!(fs::read_to_string(ready.join("user-file")).unwrap(), "keep");
    }

    #[test]
    fn damaged_checkpoint_prevents_cleanup_of_last_valid_reserved_tree() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        fs::write(checkpoint.root.join("snapshot-0/value"), "damaged").unwrap();
        assert!(checkpoint
            .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
            .is_err());
        let (_, ready) = checkpoint
            .restore_paths(&fs::canonicalize(data).unwrap())
            .unwrap();
        assert_eq!(fs::read_to_string(ready.join("value")).unwrap(), "old");
    }

    #[test]
    fn legacy_trees_without_ownership_receipts_are_preserved() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        fs::remove_file(checkpoint.root.join(OWNED_TREES)).unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            0
        );
        let (_, ready) = checkpoint
            .restore_paths(&fs::canonicalize(data).unwrap())
            .unwrap();
        assert!(ready.exists());
    }

    #[test]
    fn cleanup_handles_readonly_model_files() {
        let home = tempfile::tempdir().unwrap();
        let data = home.path().join("data");
        fs::create_dir(&data).unwrap();
        let model = data.join("model");
        fs::write(&model, "model").unwrap();
        let mut permissions = fs::metadata(&model).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&model, permissions).unwrap();
        let checkpoint = RecoveryCheckpoint::create(
            home.path().join("transaction"),
            &[data.clone()],
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[])
                .unwrap(),
            1
        );
        assert_eq!(fs::read_to_string(model).unwrap(), "model");
    }

    #[test]
    fn cleanup_preserves_a_backup_promoted_to_selected_profile_data() {
        let (_home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let (_, ready) = checkpoint
            .restore_paths(&fs::canonicalize(data).unwrap())
            .unwrap();
        let selected = crate::data_lease::normalized(&ready).unwrap();
        assert_eq!(
            checkpoint
                .cleanup_terminal_trees(checkpoint.root().parent().unwrap(), &[selected])
                .unwrap(),
            0
        );
        assert!(ready.exists());
    }

    #[test]
    fn a_runtime_writer_inside_a_backup_prevents_cleanup() {
        let (home, data, checkpoint) = terminal_cleanup_fixture();
        checkpoint.begin_installation().unwrap();
        checkpoint.await_health().unwrap();
        checkpoint.commit("2").unwrap();
        let (_, ready) = checkpoint
            .restore_paths(&fs::canonicalize(data).unwrap())
            .unwrap();
        let cache = home.path().join("cache");
        let writer = crate::data_lease::DataLease::writer(&cache, &[ready.clone()]).unwrap();
        assert!(checkpoint.cleanup_terminal_trees(&cache, &[]).is_err());
        assert!(ready.exists());
        drop(writer);
        assert_eq!(checkpoint.cleanup_terminal_trees(&cache, &[]).unwrap(), 1);
    }

    #[test]
    fn checkpoint_entry_and_path_budgets_cover_copy_and_hash() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("data");
        fs::create_dir(&root).unwrap();
        for name in ["a", "b", "c"] {
            fs::write(root.join(name), "old").unwrap();
        }
        let digest = entry_digest(&root).unwrap();
        for (index, budget, expected) in [
            (
                0,
                TraversalBudget {
                    entries_left: 2,
                    path_bytes_left: MAX_TREE_PATH_BYTES,
                },
                "checkpoint tree exceeds entry limit",
            ),
            (
                1,
                TraversalBudget {
                    entries_left: MAX_TREE_ENTRIES,
                    path_bytes_left: root.as_os_str().as_encoded_bytes().len(),
                },
                "checkpoint tree exceeds path allocation limit",
            ),
        ] {
            let mut hash_budget = TraversalBudget {
                entries_left: budget.entries_left,
                path_bytes_left: budget.path_bytes_left,
            };
            assert_eq!(
                entry_digest_bounded(&root, &mut hash_budget)
                    .unwrap_err()
                    .to_string(),
                expected
            );
            let mut copy_budget = budget;
            assert_eq!(
                copy_entry_bounded(
                    &root,
                    &base.path().join(format!("copy-{index}")),
                    &root,
                    0,
                    &mut copy_budget,
                )
                .unwrap_err()
                .to_string(),
                expected
            );
        }
        assert_eq!(entry_digest(&root).unwrap(), digest);
    }

    #[test]
    fn excessive_checkpoint_nesting_fails_closed_in_copy_and_hash() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("data");
        let mut nested = root.clone();
        for _ in 0..65 {
            nested.push("d");
        }
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("value"), "old").unwrap();
        assert_eq!(
            entry_digest(&root).unwrap_err().to_string(),
            "checkpoint tree exceeds depth limit"
        );
        assert_eq!(
            copy_entry(&root, &base.path().join("copy"), &root)
                .unwrap_err()
                .to_string(),
            "checkpoint tree exceeds depth limit"
        );
        assert_eq!(fs::read_to_string(nested.join("value")).unwrap(), "old");
    }

    #[test]
    fn nested_checkpoint_hashing_fits_a_small_thread_stack() {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let base = tempfile::tempdir().unwrap();
                let root = base.path().join("data");
                let mut nested = root.clone();
                for _ in 0..24 {
                    nested.push("d");
                }
                std::fs::create_dir_all(&nested).unwrap();
                std::fs::write(nested.join("value"), "checkpoint content").unwrap();
                let first = super::entry_digest(&root).unwrap();
                assert_eq!(first, super::entry_digest(&root).unwrap());
                std::fs::write(nested.join("value"), "changed content").unwrap();
                assert_ne!(first, super::entry_digest(&root).unwrap());
            })
            .unwrap()
            .join()
            .unwrap();
    }
    use super::*;

    fn checkpoint(base: &Path, roots: &[PathBuf]) -> RecoveryCheckpoint {
        RecoveryCheckpoint::create(
            base.join("checkpoint"),
            roots,
            "1".into(),
            "2".into(),
            "dev".into(),
        )
        .unwrap()
    }

    #[test]
    fn preinstall_abort_releases_untouched_roots_without_restore_reservations() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        let (_, ready) = tx.restore_paths(&app).unwrap();
        fs::write(&ready, "collision blocks allocation").unwrap();
        assert!(tx.begin_installation().is_err());
        tx.abort_prepared().unwrap();
        assert_eq!(tx.read().unwrap().phase, RecoveryPhase::Restored);
        assert_eq!(fs::read_to_string(&app).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(ready).unwrap(),
            "collision blocks allocation"
        );
    }

    #[test]
    fn preinstall_abort_refuses_changed_original_roots() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        fs::write(&app, "unexpected writer").unwrap();
        assert!(tx.abort_prepared().is_err());
        assert_eq!(tx.read().unwrap().phase, RecoveryPhase::Prepared);
    }

    #[test]
    fn failed_first_boot_restores_app_and_migrated_data_together() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app.exe");
        let data = base.path().join("data");
        fs::write(&app, "app-1").unwrap();
        fs::create_dir(&data).unwrap();
        fs::write(data.join("database"), "schema-1").unwrap();
        let tx = checkpoint(base.path(), &[app.clone(), data.clone()]);
        tx.begin_installation().unwrap();
        fs::write(&app, "app-2").unwrap();
        fs::write(data.join("database"), "schema-2").unwrap();
        fs::write(data.join("new-file"), "new").unwrap();
        tx.await_health().unwrap();
        tx.restore().unwrap();
        tx.restore().unwrap();
        assert_eq!(fs::read_to_string(app).unwrap(), "app-1");
        assert_eq!(
            fs::read_to_string(data.join("database")).unwrap(),
            "schema-1"
        );
        assert!(!data.join("new-file").exists());
        assert_eq!(tx.read().unwrap().phase, RecoveryPhase::Restored);
    }

    #[test]
    fn only_the_expected_healthy_release_can_commit() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app]);
        assert!(tx.commit("2").is_err());
        tx.begin_installation().unwrap();
        tx.await_health().unwrap();
        assert!(tx.commit("1").is_err());
        tx.commit("2").unwrap();
        assert!(tx.restore().is_err());
    }

    #[test]
    fn checkpoints_reject_overlapping_roots() {
        let base = tempfile::tempdir().unwrap();
        let outer = base.path().join("data");
        let inner = outer.join("nested");
        fs::create_dir_all(&inner).unwrap();
        assert!(RecoveryCheckpoint::create(
            base.path().join("checkpoint"),
            &[outer, inner],
            "1".into(),
            "2".into(),
            "dev".into()
        )
        .is_err());
    }

    #[test]
    fn a_root_created_by_a_failed_update_is_removed_from_selection() {
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("new-profile");
        let tx = checkpoint(base.path(), &[data.clone()]);
        fs::create_dir(&data).unwrap();
        fs::write(data.join("new"), "failed").unwrap();
        tx.restore().unwrap();
        assert!(!data.exists());
    }

    #[test]
    fn interrupted_restore_resumes_after_the_first_root_swap() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        let data = base.path().join("data");
        fs::write(&app, "app-1").unwrap();
        fs::write(&data, "data-1").unwrap();
        let tx = checkpoint(base.path(), &[app.clone(), data.clone()]);
        tx.begin_installation().unwrap();
        fs::write(&app, "app-2").unwrap();
        fs::write(&data, "data-2").unwrap();
        let failed = base.path().join(".app.checkpoint.failed");
        fs::rename(&app, failed).unwrap();
        fs::rename(tx.restore_paths(&app).unwrap().1, &app).unwrap();
        let mut journal = tx.read().unwrap();
        journal.phase = RecoveryPhase::Restoring { next_root: 0 };
        tx.write(&journal).unwrap();
        let root = tx.root().to_path_buf();
        drop(tx);
        let reopened = RecoveryCheckpoint::open(root).unwrap();
        reopened.restore().unwrap();
        assert_eq!(fs::read_to_string(app).unwrap(), "app-1");
        assert_eq!(fs::read_to_string(data).unwrap(), "data-1");
    }

    #[test]
    fn damaged_checkpoint_refuses_installation() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        fs::write(tx.root().join("snapshot-0"), "damaged").unwrap();
        assert!(tx.begin_installation().is_err());
        assert_eq!(tx.read().unwrap().phase, RecoveryPhase::Prepared);
        assert_eq!(fs::read_to_string(app).unwrap(), "old");
    }

    #[test]
    fn only_one_supervisor_can_mutate_a_checkpoint() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app]);
        assert!(RecoveryCheckpoint::open(tx.root().to_path_buf()).is_err());
        let observer = RecoveryCheckpoint::observe(tx.root().to_path_buf()).unwrap();
        assert!(observer.begin_installation().is_err());
        assert!(observer.restore().is_err());
        let root = tx.root().to_path_buf();
        drop(tx);
        let reopened = RecoveryCheckpoint::open(root).unwrap();
        reopened.begin_installation().unwrap();
    }

    #[test]
    fn damaged_second_snapshot_leaves_both_current_roots_untouched() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        let data = base.path().join("data");
        fs::write(&app, "old-app").unwrap();
        fs::write(&data, "old-data").unwrap();
        let tx = checkpoint(base.path(), &[app.clone(), data.clone()]);
        tx.begin_installation().unwrap();
        fs::write(&app, "new-app").unwrap();
        fs::write(&data, "new-data").unwrap();
        fs::write(tx.root().join("snapshot-1"), "damaged").unwrap();
        assert!(tx.restore().is_err());
        assert_eq!(fs::read_to_string(app).unwrap(), "new-app");
        assert_eq!(fs::read_to_string(data).unwrap(), "new-data");
    }

    #[test]
    fn interrupted_restore_refuses_unverified_existing_target() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        fs::rename(&app, base.path().join(".app.checkpoint.failed")).unwrap();
        fs::write(&app, "unverified replacement").unwrap();
        assert!(tx.restore().is_err());
        assert_eq!(fs::read_to_string(app).unwrap(), "unverified replacement");
    }

    #[test]
    fn prepared_restore_tree_is_verified_before_current_tree_is_moved() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        fs::write(&app, "new").unwrap();
        fs::write(base.path().join(".app.checkpoint.restore"), "damaged").unwrap();
        assert!(tx.restore().is_err());
        assert_eq!(fs::read_to_string(app).unwrap(), "new");
        assert!(!base.path().join(".app.checkpoint.failed").exists());
    }

    #[test]
    fn complete_restore_space_is_reserved_before_installation() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        tx.begin_installation().unwrap();
        let (_, ready) = tx.restore_paths(&app).unwrap();
        assert_eq!(fs::read_to_string(&ready).unwrap(), "old");
        fs::write(&app, "new").unwrap();
        tx.restore().unwrap();
        assert_eq!(fs::read_to_string(app).unwrap(), "old");
        assert!(!ready.exists());
    }

    #[test]
    fn failed_reservation_does_not_begin_installation() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        let (_, ready) = tx.restore_paths(&app).unwrap();
        fs::write(&ready, "untrusted collision").unwrap();
        assert!(tx.begin_installation().is_err());
        assert_eq!(tx.read().unwrap().phase, RecoveryPhase::Prepared);
        assert_eq!(fs::read_to_string(app).unwrap(), "old");
    }

    #[test]
    fn a_missing_reservation_after_installation_is_not_recopied() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        tx.begin_installation().unwrap();
        fs::write(&app, "new").unwrap();
        fs::remove_file(tx.restore_paths(&app).unwrap().1).unwrap();
        assert!(tx.restore().is_err());
        assert_eq!(fs::read_to_string(app).unwrap(), "new");
    }

    #[test]
    fn damaged_last_reservation_leaves_every_selected_root_untouched() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        let data = base.path().join("data");
        fs::write(&app, "old-app").unwrap();
        fs::write(&data, "old-data").unwrap();
        let tx = checkpoint(base.path(), &[app.clone(), data.clone()]);
        tx.begin_installation().unwrap();
        fs::write(&app, "new-app").unwrap();
        fs::write(&data, "new-data").unwrap();
        fs::write(tx.restore_paths(&data).unwrap().1, "damaged").unwrap();
        assert!(tx.restore().is_err());
        assert_eq!(fs::read_to_string(app).unwrap(), "new-app");
        assert_eq!(fs::read_to_string(data).unwrap(), "new-data");
    }

    #[test]
    fn readonly_files_can_be_checkpointed() {
        let base = tempfile::tempdir().unwrap();
        let app = base.path().join("app");
        fs::write(&app, "old").unwrap();
        let mut permissions = fs::metadata(&app).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&app, permissions).unwrap();
        let tx = checkpoint(base.path(), &[app.clone()]);
        assert_eq!(
            fs::read_to_string(tx.root().join("snapshot-0")).unwrap(),
            "old"
        );
        // Restore write access to this disposable fixture for normal cleanup.
        let mut permissions = fs::metadata(&app).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&app, permissions).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn internal_links_are_preserved_and_external_links_fail_closed() {
        use std::os::unix::fs::symlink;
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("real"), "old").unwrap();
        symlink("real", data.join("alias")).unwrap();
        let tx = checkpoint(base.path(), &[data.clone()]);
        assert_eq!(
            fs::read_link(tx.root().join("snapshot-0/alias")).unwrap(),
            PathBuf::from("real")
        );
        fs::write(base.path().join("outside"), "private").unwrap();
        symlink("../outside", data.join("external")).unwrap();
        assert!(RecoveryCheckpoint::create(
            base.path().join("other"),
            &[data],
            "1".into(),
            "2".into(),
            "dev".into()
        )
        .is_err());
    }
}

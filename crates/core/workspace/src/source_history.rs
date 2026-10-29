//! A small, local history primitive for source artifacts.
//!
//! The store is owned by the caller (Core points it at
//! `<data dir>/files/source-history`). Callers decide which source file
//! represents a resource; this module only provides checkpoint, list and read.
//! It deliberately does not know about Spaces, agents, skills, or workflows, so
//! the existing generic VersionHistory UI can use one history contract across all
//! of them.
//!
//! ## Storage
//!
//! Versions live in a sealed SQLite store, `<root>/history.db` (content store
//! `source-history`): each row holds the source path and creation time in the
//! clear, the label as `encb:v1:` and the content as `RYU-CB01` of
//! `zstd(plaintext)`, both bound to `(id, path)`. `content_bi` is a blind token
//! of the plaintext, used only to make an unchanged unlabeled checkpoint return
//! the latest version. Retention keeps the newest [`Retention::keep_newest`]
//! versions per path and drops versions older than [`Retention::max_age_days`]
//! except the newest [`Retention::keep_after_age`] per path.
//!
//! ## Migration from the Git repository
//!
//! Earlier builds kept the history as a plaintext Git repository in the same
//! root. On first use the repository is imported: every commit is read without
//! holding the lock (ids stay the commit SHAs, so stored version ids keep
//! working), the rows are verified, then the in-process lock and an exclusive
//! file lock on `<root>/.lock` are taken, commits made after the snapshot are
//! imported, and the store is marked migrated. Only then are `.git` and the
//! working-tree files deleted. Without enough free space (twice the repository)
//! the Git repository keeps serving and the import is retried at the next start.

use std::collections::HashSet;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{BlindIndex, ContentCipher, ContentContext};

use crate::win_process::NoWindow;

mod git_history;
mod sealed;
mod storage;

use git_history::*;
use sealed::*;
use storage::*;

const MAX_HISTORY_PATH_BYTES: usize = 1024;
const MAX_HISTORY_LABEL_BYTES: usize = 240;
const DEFAULT_HISTORY_LIMIT: usize = 200;
const SOURCE_PATH_TRAILER: &str = "Ryu-Source-Path:";
const HISTORY_FORMAT_ARG: &str = "--format=%H%x1f%ct%x1f%s%x1f%b%x1e";

/// Registered content-store name (KDF input: never rename).
pub const SOURCE_HISTORY_STORE: &str = "source-history";
/// The SQLite file inside the history root.
pub const HISTORY_DB_FILE: &str = "history.db";
const LOCK_FILE: &str = ".lock";
const ZSTD_LEVEL: i32 = 3;
const MIGRATED_KEY: &str = "migrated";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

static SOURCE_HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
/// Roots whose Git import this process already attempted (retried next start).
static MIGRATION_ATTEMPTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

/// One immutable checkpoint, shaped for the existing version-history UIs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceHistoryVersion {
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
}

/// How many versions a path keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    /// Versions kept per path regardless of age.
    pub keep_newest: usize,
    /// Versions older than this many days are pruned...
    pub max_age_days: i64,
    /// ...except the newest this many per path.
    pub keep_after_age: usize,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            keep_newest: 200,
            max_age_days: 365,
            keep_after_age: 20,
        }
    }
}

/// Where a history root currently stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceHistoryState {
    /// Sealed SQLite store (or nothing recorded yet).
    Sealed,
    /// Still the legacy plaintext Git repository; the reason the import has not
    /// completed yet (for a health warning).
    LegacyGit(String),
}

/// Source history rooted at one local directory.
#[derive(Debug, Clone)]
pub struct SourceHistory {
    root: PathBuf,
    retention: Retention,
}

impl SourceHistory {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            retention: Retention::default(),
        }
    }

    /// Override the retention policy (a settings hook).
    pub fn with_retention(mut self, retention: Retention) -> Self {
        self.retention = Retention {
            keep_newest: retention.keep_newest.max(1),
            max_age_days: retention.max_age_days.max(1),
            keep_after_age: retention.keep_after_age.max(1),
        };
        self
    }

    /// Store one source version.
    ///
    /// An unlabeled checkpoint with unchanged bytes is idempotent: it returns the
    /// existing latest version. An explicit label creates a named checkpoint even
    /// when the source bytes are unchanged, preserving the existing snapshot API
    /// without pretending that a named action was a new content revision.
    pub fn checkpoint(
        &self,
        relative_path: &str,
        content: &str,
        label: Option<&str>,
    ) -> std::io::Result<SourceHistoryVersion> {
        validate_relative_path(relative_path)?;
        self.migrate_if_needed();
        std::fs::create_dir_all(&self.root)?;
        restrict_dir_to_owner(&self.root);
        let _lock = self.lock(false)?;
        match self.backend(true)? {
            Backend::Sealed(store) => store.checkpoint(relative_path, content, label),
            Backend::Git => GitHistory::new(&self.root).checkpoint(relative_path, content, label),
            Backend::Empty => Err(io_error("source history could not be created")),
        }
    }

    /// Import one version a caller kept in its own legacy format, keeping its
    /// creation time and label. `id` is reused when it is a valid version id
    /// (hyphens dropped, lowercased), otherwise a new id is minted. Importing
    /// the same `(id, path)` again is idempotent when the bytes match.
    ///
    /// Only the sealed store accepts imports: while the root still serves the
    /// plaintext Git history (its own import is pending) this returns an error
    /// so the caller keeps its legacy copy and retries later. The row is read
    /// back and compared before this returns `Ok`, so the caller may delete its
    /// legacy copy on success.
    pub fn import_version(
        &self,
        relative_path: &str,
        id: Option<&str>,
        created_at: i64,
        label: Option<&str>,
        content: &str,
    ) -> std::io::Result<SourceHistoryVersion> {
        validate_relative_path(relative_path)?;
        self.migrate_if_needed();
        std::fs::create_dir_all(&self.root)?;
        restrict_dir_to_owner(&self.root);
        let _lock = self.lock(false)?;
        match self.backend(true)? {
            Backend::Sealed(store) => store.import(relative_path, id, created_at, label, content),
            Backend::Git => Err(io_error(
                "source history still holds its legacy Git repository; import later",
            )),
            Backend::Empty => Err(io_error("source history could not be created")),
        }
    }

    /// List recent checkpoints for one source path, newest first.
    pub fn list(
        &self,
        relative_path: &str,
        limit: Option<usize>,
    ) -> std::io::Result<Vec<SourceHistoryVersion>> {
        validate_relative_path(relative_path)?;
        self.migrate_if_needed();
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }
        let count = limit.unwrap_or(DEFAULT_HISTORY_LIMIT).clamp(1, 1000);
        let _lock = self.lock(false)?;
        match self.backend(false)? {
            Backend::Sealed(store) => store.list(relative_path, count),
            Backend::Git => GitHistory::new(&self.root).list_unlocked(relative_path, count),
            Backend::Empty => Ok(Vec::new()),
        }
    }

    /// Read one source file at a historical version (an id or a unique prefix of
    /// at least 7 hex digits). A missing version/path is returned as `None`,
    /// matching the existing version-store behavior; a stored version that does
    /// not open is an error.
    pub fn read(&self, relative_path: &str, version_id: &str) -> std::io::Result<Option<String>> {
        validate_relative_path(relative_path)?;
        validate_version_id(version_id)?;
        self.migrate_if_needed();
        if !self.root.is_dir() {
            return Ok(None);
        }
        let _lock = self.lock(false)?;
        match self.backend(false)? {
            Backend::Sealed(store) => store.read(relative_path, version_id),
            Backend::Git => GitHistory::new(&self.root).read_unlocked(relative_path, version_id),
            Backend::Empty => Ok(None),
        }
    }

    /// Return the history root, useful for diagnostics.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Run the legacy Git import if it is still due (once per process, like the
    /// first list/read/checkpoint call would), then report [`Self::state`].
    /// Core calls this at startup and from its encryption status so a store
    /// left on plaintext Git (too little free space, or an import that did not
    /// verify) is reported with its reason instead of only logged.
    pub fn migrate_and_report(&self) -> SourceHistoryState {
        self.migrate_if_needed();
        self.state()
    }

    /// Whether this root is sealed or still holds legacy plaintext history.
    ///
    /// The `migrated` flag alone is not enough: a `.git` that came back after
    /// the import (a restored export or a downgrade) and failed to re-import,
    /// or working-tree copies whose removal failed, are plaintext on disk, so
    /// they are reported as `LegacyGit` with the reason until they are gone.
    pub fn state(&self) -> SourceHistoryState {
        let has_git = self.root.join(".git").exists();
        let migrated = matches!(
            open_db(&self.root.join(HISTORY_DB_FILE), false),
            Ok(Some(conn)) if is_migrated(&conn).unwrap_or(false)
        );
        if !has_git && !(migrated && has_leftover_entries(&self.root)) {
            return SourceHistoryState::Sealed;
        }
        let fallback = if migrated {
            "legacy plaintext history files are still present; removal is retried at the next start"
        } else {
            "the Git history has not been imported yet"
        };
        SourceHistoryState::LegacyGit(
            last_migration_error(&self.root).unwrap_or_else(|| fallback.to_owned()),
        )
    }

    fn lock(&self, exclusive: bool) -> std::io::Result<HistoryLock> {
        let guard = source_history_lock()?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join(LOCK_FILE))?;
        if exclusive {
            file.lock()?;
        } else {
            file.lock_shared()?;
        }
        Ok(HistoryLock {
            _file: file,
            _guard: guard,
        })
    }

    /// Choose the backend for one call. Runs under the lock.
    fn backend(&self, create: bool) -> std::io::Result<Backend> {
        let db_path = self.root.join(HISTORY_DB_FILE);
        let has_git = self.root.join(".git").is_dir();
        let conn = match open_db(&db_path, create && !has_git)? {
            Some(conn) => conn,
            None if has_git => return Ok(Backend::Git),
            None => return Ok(Backend::Empty),
        };
        if !is_migrated(&conn)? {
            if has_git {
                return Ok(Backend::Git);
            }
            set_migrated(&conn)?;
        }
        Ok(Backend::Sealed(SealedHistory::open(conn, self.retention)?))
    }

    /// Import a legacy Git repository, or finish removing what an earlier
    /// import left behind, once per process (retried at each start).
    fn migrate_if_needed(&self) {
        if !self.root.join(".git").exists() && !self.has_migrated_leftovers() {
            return;
        }
        {
            let mut attempted = MIGRATION_ATTEMPTED
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !attempted.insert(self.root.clone()) {
                return;
            }
        }
        match self.migrate_from_git(|| {}) {
            // Done: a `.git` that comes back later in this process (a restored
            // export) is imported again on the next call.
            Ok(()) => {
                clear_migration_error(&self.root);
                MIGRATION_ATTEMPTED
                    .get_or_init(|| Mutex::new(HashSet::new()))
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&self.root);
            }
            Err(error) => {
                tracing::warn!(
                    root = %self.root.display(),
                    "source history keeps plaintext legacy files for now: {error}"
                );
                record_migration_error(&self.root, error.to_string());
            }
        }
    }

    /// A migrated store that still has plaintext files beside `history.db`
    /// (a delete that failed or was interrupted).
    fn has_migrated_leftovers(&self) -> bool {
        if !has_leftover_entries(&self.root) {
            return false;
        }
        matches!(
            open_db(&self.root.join(HISTORY_DB_FILE), false),
            Ok(Some(conn)) if is_migrated(&conn).unwrap_or(false)
        )
    }

    /// The import itself. `after_snapshot` runs between the unlocked snapshot
    /// and the locked catch-up (a test seam for concurrent writers).
    fn migrate_from_git(&self, after_snapshot: impl FnOnce()) -> std::io::Result<()> {
        let db_path = self.root.join(HISTORY_DB_FILE);
        if let Some(conn) = open_db(&db_path, false)? {
            if is_migrated(&conn)? {
                return self.reconcile_after_migration(conn);
            }
        }
        if !self.root.join(".git").exists() {
            return Ok(());
        }
        let repository_bytes = dir_size(&self.root);
        ryu_crypto::ensure_free_space(&self.root, repository_bytes.saturating_mul(2))
            .map_err(|error| io_error(format!("{error:#}")))?;
        let git = GitHistory::new(&self.root);

        // Snapshot without the lock: writers keep using Git meanwhile.
        let snapshot_head = git.head()?;
        let conn = open_db(&db_path, true)?.ok_or_else(|| io_error("history.db missing"))?;
        let store = SealedHistory::open(conn, self.retention)?;
        let mut imported = Vec::new();
        if let Some(head) = &snapshot_head {
            imported.extend(store.import_commits(&git, None, head)?);
        }
        store.verify(&imported)?;
        after_snapshot();

        // Catch up and flip under the in-process lock plus an exclusive file
        // lock (which also covers a second process).
        {
            let _lock = self.lock(true)?;
            let head = git.head()?;
            if head != snapshot_head {
                if let Some(head) = &head {
                    let caught_up = store.import_commits(&git, snapshot_head.as_deref(), head)?;
                    store.verify(&caught_up)?;
                    imported.extend(caught_up);
                }
            }
            store.prune_all()?;
            set_migrated(&store.conn)?;
            remove_git_leftovers(&self.root)?;
        }
        tracing::info!(
            root = %self.root.display(),
            versions = imported.len(),
            "source history imported from Git into the sealed store"
        );
        Ok(())
    }
}

impl SourceHistory {
    /// The store was migrated earlier. A `.git` that is back (a data-folder
    /// export from an older build restored over this folder, or a downgrade
    /// that wrote new versions) is imported again before anything is deleted:
    /// the import is idempotent, so versions already in the store are kept.
    /// On any error `.git` stays and the import is retried at the next start.
    fn reconcile_after_migration(&self, conn: Connection) -> std::io::Result<()> {
        let _lock = self.lock(true)?;
        if self.root.join(".git").exists() {
            let git = GitHistory::new(&self.root);
            if let Some(head) = git.head()? {
                ryu_crypto::ensure_free_space(&self.root, dir_size(&self.root))
                    .map_err(|error| io_error(format!("{error:#}")))?;
                let store = SealedHistory::open(conn, self.retention)?;
                let imported = store.import_commits(&git, None, &head)?;
                store.verify(&imported)?;
                store.prune_all()?;
                tracing::info!(
                    root = %self.root.display(),
                    versions = imported.len(),
                    "source history re-imported a restored Git repository"
                );
            }
        }
        remove_git_leftovers(&self.root)
    }
}

/// Whether anything other than the sealed database and the lock file is in
/// the history root.
fn has_leftover_entries(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name != LOCK_FILE && !name.starts_with(HISTORY_DB_FILE)
        })
    })
}

struct HistoryLock {
    _file: File,
    _guard: MutexGuard<'static, ()>,
}

enum Backend {
    Sealed(SealedHistory),
    Git,
    Empty,
}

#[cfg(test)]
mod tests;

/// Bounded listing of the legacy Git history (read while importing it).
#[cfg(test)]
mod git_history_tests;

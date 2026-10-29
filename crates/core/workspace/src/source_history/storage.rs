//! Migration-error bookkeeping, the history database handle, and the file
//! helpers the sealed store and the Git import share.

use super::*;

pub(super) fn migration_errors() -> &'static Mutex<std::collections::HashMap<PathBuf, String>> {
    static ERRORS: OnceLock<Mutex<std::collections::HashMap<PathBuf, String>>> = OnceLock::new();
    ERRORS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(super) fn record_migration_error(root: &Path, error: String) {
    migration_errors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(root.to_path_buf(), error);
}

pub(super) fn clear_migration_error(root: &Path) {
    migration_errors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(root);
}

pub(super) fn last_migration_error(root: &Path) -> Option<String> {
    migration_errors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(root)
        .cloned()
}

// ── Sealed SQLite store ──────────────────────────────────────────────────────

/// Open (or with `create`, create) the history database. `None` when it does
/// not exist and `create` is false.
pub(super) fn open_db(path: &Path, create: bool) -> std::io::Result<Option<Connection>> {
    if !create && !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open(path).map_err(sql_error)?;
    restrict_to_owner(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(sql_error)?;
    ryu_crypto::content_sqlite::enable_secure_delete(&conn)
        .map_err(|error| io_error(format!("{error:#}")))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS versions (
            seq        INTEGER PRIMARY KEY AUTOINCREMENT,
            id         TEXT NOT NULL,
            path       TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            label      TEXT,
            content    BLOB NOT NULL,
            content_bi TEXT NOT NULL,
            UNIQUE(id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_versions_path_created
            ON versions(path, created_at);
        CREATE TABLE IF NOT EXISTS history_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(sql_error)?;
    Ok(Some(conn))
}

pub(super) fn is_migrated(conn: &Connection) -> std::io::Result<bool> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM history_meta WHERE key = ?1",
            [MIGRATED_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(value.as_deref() == Some("1"))
}

pub(super) fn set_migrated(conn: &Connection) -> std::io::Result<()> {
    conn.execute(
        "INSERT INTO history_meta (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'",
        [MIGRATED_KEY],
    )
    .map_err(sql_error)?;
    Ok(())
}

pub(super) fn new_version_id() -> String {
    // 40 lowercase hex digits, the shape Git commit ids had.
    let first = uuid::Uuid::new_v4().simple().to_string();
    let second = uuid::Uuid::new_v4().simple().to_string();
    format!("{first}{}", &second[..8])
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(super) fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Delete the plaintext working-tree files, then `.git`, keeping the sealed
/// database and the lock file. Runs only after the store is marked migrated.
/// `.git` goes last and only when every other delete succeeded, so a surviving
/// `.git` (or any surviving file) makes the next start try again.
pub(super) fn remove_git_leftovers(root: &Path) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Ok(());
    };
    let mut failed = 0usize;
    let mut git_dir = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == LOCK_FILE || name.starts_with(HISTORY_DB_FILE) {
            continue;
        }
        let path = entry.path();
        if name == ".git" {
            git_dir = Some(path);
            continue;
        }
        if let Err(error) = remove_entry(&entry, &path) {
            failed += 1;
            tracing::warn!(path = %path.display(), "could not remove a legacy source-history file: {error}");
        }
    }
    if failed > 0 {
        return Err(io_error(format!(
            "{failed} legacy source-history file(s) could not be removed; retrying at the next start"
        )));
    }
    if let Some(git_dir) = git_dir {
        std::fs::remove_dir_all(&git_dir)?;
    }
    Ok(())
}

pub(super) fn remove_entry(entry: &std::fs::DirEntry, path: &Path) -> std::io::Result<()> {
    if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

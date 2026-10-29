//! API-key storage migration and the one-time raw-key scrub.

use sha2::{Digest, Sha256};

use super::*;

/// Keep sentinel identities readable because they are not credentials. Every
/// other API key is represented on disk by a deterministic SHA-256 lookup key;
/// the raw value remains available only in the request process.
pub(crate) fn api_key_storage_key(key: &str) -> String {
    if key == "anonymous" || key == "master" {
        return key.to_owned();
    }
    let mut digest = Sha256::new();
    digest.update(key.as_bytes());
    hex::encode(digest.finalize())
}

/// Correlate operational events without exposing any bearer bytes or prefix.
pub fn credential_log_id(key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(key.as_bytes());
    format!("key_{}", hex::encode(digest.finalize()))
}

/// Whether a stored `api_key` column value is already in its on-disk form: a
/// sentinel identity or a SHA-256 lookup key. Anything else is a raw client key
/// left by a build that predates hashing.
pub(crate) fn is_stored_api_key_form(stored: &str) -> bool {
    stored == "anonymous"
        || stored == "master"
        || (stored.len() == 64
            && stored
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

/// Create the audit database owner-only (0600) and tighten an existing one.
/// SQLite creates the `-wal`/`-shm` side files with the database's mode, so
/// they inherit it.
pub(crate) fn restrict_db_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        for suffix in ["-wal", "-shm"] {
            let mut side = path.as_os_str().to_owned();
            side.push(suffix);
            let side = std::path::PathBuf::from(side);
            if side.exists() {
                std::fs::set_permissions(&side, std::fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Whether a `key_token_totals` key shaped like a SHA-256 lookup key is really a
/// raw client key. Operators commonly mint client keys with `openssl rand -hex
/// 32`, which is exactly that shape, so the shape alone cannot tell them apart.
/// `audit_log.api_key` can: by the time this runs it holds only hashed lookup
/// keys, so a row whose value equals `sha256(key)` proves `key` was presented as
/// a credential. (A raw key whose audit rows were all pruned cannot be told
/// apart and is left as is.)
pub(crate) fn is_hex_shaped_raw_key(conn: &Connection, key: &str) -> bool {
    key.len() == 64
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM audit_log WHERE api_key = ?1)",
                params![api_key_storage_key(key)],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false)
}

/// Replace raw client keys left in `key_token_totals` by a pre-hash build with
/// their SHA-256 lookup key, merging their totals into the hashed row so budget
/// accounting (which looks rows up by the hash) sees them again. Returns how
/// many raw rows were removed.
///
/// Must run after [`migrate_api_key_storage`], so `audit_log.api_key` is already
/// hashed when a hex-shaped key is checked against it.
pub(crate) fn migrate_key_token_totals(conn: &mut Connection) -> anyhow::Result<usize> {
    let raw: Vec<(String, i64)> = {
        let mut statement = conn.prepare("SELECT api_key, tokens FROM key_token_totals")?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, i64)>>>()?;
        rows.into_iter()
            .filter(|(key, _)| !is_stored_api_key_form(key) || is_hex_shaped_raw_key(conn, key))
            .collect()
    };
    if raw.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    for (key, tokens) in &raw {
        tx.execute(
            "INSERT INTO key_token_totals (api_key, tokens) VALUES (?1, ?2)
             ON CONFLICT(api_key) DO UPDATE SET tokens = tokens + excluded.tokens",
            params![api_key_storage_key(key), tokens],
        )?;
        tx.execute(
            "DELETE FROM key_token_totals WHERE api_key = ?1",
            params![key],
        )?;
    }
    tx.commit()?;
    Ok(raw.len())
}

/// Migrate pre-hash audit rows in place. The display prefix preserves the UI's
/// existing redacted view while the original credential is removed from disk.
/// Returns how many rows held a raw key.
pub(crate) fn migrate_api_key_storage(conn: &Connection) -> anyhow::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, api_key FROM audit_log
         WHERE api_key_prefix IS NULL OR api_key_prefix = ''",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut migrated = 0;
    for (id, raw_key) in rows {
        conn.execute(
            "UPDATE audit_log SET api_key = ?1, api_key_prefix = ?2 WHERE id = ?3",
            params![api_key_storage_key(&raw_key), redact_key(&raw_key), id],
        )?;
        if !is_stored_api_key_form(&raw_key) {
            migrated += 1;
        }
    }
    Ok(migrated)
}

/// Marker for the one-time rebuild that removes raw client-key bytes left in
/// free space by builds that hashed them without `secure_delete`.
pub(crate) const RAW_KEY_SCRUB_MARKER: &str = "raw_api_key_scrub_v1";

pub(crate) fn raw_key_scrub_done(conn: &Connection) -> anyhow::Result<bool> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_meta (
             name  TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )?;
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM audit_meta WHERE name = ?1",
        params![RAW_KEY_SCRUB_MARKER],
        |row| row.get(0),
    )?;
    Ok(done > 0)
}

pub(crate) fn mark_raw_key_scrub_done(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO audit_meta (name, value) VALUES (?1, datetime('now'))",
        params![RAW_KEY_SCRUB_MARKER],
    )?;
    Ok(())
}

pub(crate) fn clear_raw_key_scrub_marker(conn: &Connection) -> anyhow::Result<()> {
    raw_key_scrub_done(conn)?;
    conn.execute(
        "DELETE FROM audit_meta WHERE name = ?1",
        params![RAW_KEY_SCRUB_MARKER],
    )?;
    Ok(())
}

/// Outcome of the one-time raw-key rebuild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum RawKeyScrub {
    /// Not attempted yet.
    Pending = 0,
    /// Not needed: the marker was already set (or the logger is disabled).
    Skipped = 1,
    /// The rebuild ran and the marker is set.
    Done = 2,
    /// The rebuild did not run or failed; the marker stays unset so the next
    /// open retries it.
    Deferred = 3,
}

impl RawKeyScrub {
    #[cfg(test)]
    pub(crate) fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Skipped,
            2 => Self::Done,
            3 => Self::Deferred,
            _ => Self::Pending,
        }
    }
}

/// Headroom kept free on top of the rebuild's own estimate.
pub(crate) const SCRUB_SPACE_MARGIN: u64 = 64 * 1024 * 1024;

pub(crate) fn fs_available_space(path: &Path) -> Option<u64> {
    fs4::available_space(path).ok()
}

/// Whether a VACUUM of `live_bytes` of data fits in the free space reported for
/// the database volume and the temp volume. VACUUM writes a temporary copy of
/// the live data (to the temp directory) and then the rebuilt pages to the WAL
/// beside the database before checkpointing them, so the database volume needs
/// roughly twice the live size when both share it. An unknown figure is not a
/// reason to skip: a failed rebuild is rolled back and retried later.
pub(crate) fn scrub_fits(
    live_bytes: u64,
    db_volume_free: Option<u64>,
    temp_volume_free: Option<u64>,
    same_volume: bool,
) -> bool {
    let db_needed = if same_volume {
        live_bytes.saturating_mul(2)
    } else {
        live_bytes
    }
    .saturating_add(SCRUB_SPACE_MARGIN);
    let temp_needed = live_bytes.saturating_add(SCRUB_SPACE_MARGIN);
    db_volume_free.is_none_or(|free| free >= db_needed)
        && temp_volume_free.is_none_or(|free| free >= temp_needed)
}

/// Run the one-time rebuild that drops raw client-key bytes from free space.
///
/// Best effort and never fatal: it is skipped (and logged) when the volume
/// lacks room for the rebuild, and any SQLite error is logged and rolled back.
/// Either way the marker stays unset, so the next open retries it.
pub(crate) fn run_raw_key_scrub(
    conn: &Connection,
    db_path: &Path,
    available_space: &dyn Fn(&Path) -> Option<u64>,
) -> RawKeyScrub {
    match raw_key_scrub_done(conn) {
        Ok(true) => return RawKeyScrub::Skipped,
        Ok(false) => {}
        Err(error) => {
            warn!(%error, "audit: could not read the raw-key scrub marker; retrying on next start");
            return RawKeyScrub::Deferred;
        }
    }
    let live_bytes = conn
        .query_row(
            "SELECT (SELECT page_count FROM pragma_page_count())
                  - (SELECT freelist_count FROM pragma_freelist_count()),
                    (SELECT page_size FROM pragma_page_size())",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map(|(pages, size)| u64::try_from(pages.max(0) * size.max(0)).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let db_dir = db_path.parent().unwrap_or_else(|| Path::new("."));
    let temp_dir = std::env::temp_dir();
    let db_free = available_space(db_dir);
    let temp_free = available_space(&temp_dir);
    let same_volume = same_volume(db_dir, &temp_dir);
    if !scrub_fits(live_bytes, db_free, temp_free, same_volume) {
        warn!(
            live_bytes,
            db_volume_free = db_free,
            temp_volume_free = temp_free,
            "audit: not enough free disk to rebuild the audit store and purge stale raw client-key bytes; retrying on next start"
        );
        return RawKeyScrub::Deferred;
    }
    let started = std::time::Instant::now();
    // The earlier UPDATE/DELETE leave old pages in the WAL until a checkpoint;
    // fold them in and rebuild the file so no raw key bytes survive in free
    // pages. VACUUM is atomic: on failure the database is left as it was.
    let rebuilt = conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
        .map_err(anyhow::Error::from)
        .and_then(|()| mark_raw_key_scrub_done(conn))
        .and_then(|()| {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(anyhow::Error::from)
        });
    match rebuilt {
        Ok(()) => {
            info!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "audit: rebuilt the audit store to purge stale raw client-key bytes"
            );
            RawKeyScrub::Done
        }
        Err(error) => {
            warn!(
                %error,
                "audit: rebuilding the audit store to purge stale raw client-key bytes failed; retrying on next start"
            );
            RawKeyScrub::Deferred
        }
    }
}

#[cfg(unix)]
pub(crate) fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => true,
    }
}

#[cfg(not(unix))]
pub(crate) fn same_volume(_a: &Path, _b: &Path) -> bool {
    // Assume the worst case (both copies on the database volume).
    true
}

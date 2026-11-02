//! Key/value write hooks and the per-source live-lookup cache.
//!
//! Split out of [`super`], which re-exports the public items at their
//! original paths.
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by sources_test.rs (live lookups and the TTL cache) and tests.rs.

use super::*;

// ── Write hooks (called from the key/value engine) ─────────────────────────

/// Refuse a local node-scope change in a folder that an external store owns.
/// Called inside the write transaction; sync writes pass `External` and skip it.
pub(crate) fn guard_local_write(conn: &Connection, coords: &SecretCoords) -> Result<()> {
    if coords.scope != SecretScope::Node {
        return Ok(());
    }
    let store: Option<String> = conn
        .query_row(
            "SELECT s.name FROM vault_external_sources src
             JOIN vault_external_stores s ON s.id = src.store_id
             WHERE src.environment = ?1 AND src.path = ?2 AND src.scope_id = ?3",
            params![coords.environment, coords.path, coords.scope_id],
            |row| row.get(0),
        )
        .optional()?;
    match store {
        Some(name) => Err(VaultError::Conflict(format!(
            "folder `{}:{}` is sourced from external store `{name}`; change the value there",
            coords.environment, coords.path
        ))
        .into()),
        None => Ok(()),
    }
}

/// Flag destinations that push `coords`' folder so the loop re-pushes it.
pub(crate) fn mark_dirty(conn: &Connection, coords: &SecretCoords) -> Result<()> {
    if coords.scope != SecretScope::Node || coords.binding.is_some() {
        return Ok(());
    }
    let changed = conn.execute(
        "UPDATE vault_external_destinations SET dirty = 1
         WHERE environment = ?1 AND path = ?2 AND scope_id = ?3",
        params![coords.environment, coords.path, coords.scope_id],
    )?;
    if changed > 0 {
        WAKE.notify_one();
    }
    Ok(())
}

// ── Live cache ────────────────────────────────────────────────────────────

pub(super) struct CacheEntry {
    fetched: Instant,
    folder: RemoteFolder,
}

pub(super) static LIVE_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(super) static WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
/// One lock per source id, held for a whole sync (remote read through the
/// last local write), so a scheduled and a manual sync of the same source
/// apply their snapshots one after the other instead of interleaving writes
/// from two different remote reads.
pub(super) static SOURCE_SYNC_LOCKS: LazyLock<Mutex<HashMap<String, SourceSyncLock>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) type SourceSyncLock = std::sync::Arc<tokio::sync::Mutex<()>>;

pub(super) fn source_sync_lock(id: &str) -> SourceSyncLock {
    let mut locks = SOURCE_SYNC_LOCKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Drop locks nobody holds or waits on, so the map tracks only live syncs.
    locks.retain(|_, lock| std::sync::Arc::strong_count(lock) > 1);
    locks.entry(id.to_owned()).or_default().clone()
}

pub(super) fn cache_get(source_id: &str, max_age: Duration) -> Option<RemoteFolder> {
    let guard = LIVE_CACHE.lock().ok()?;
    let entry = guard.get(source_id)?;
    (entry.fetched.elapsed() <= max_age).then(|| entry.folder.clone())
}

pub(super) fn cache_put(source_id: &str, folder: RemoteFolder) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        guard.insert(
            source_id.to_owned(),
            CacheEntry {
                fetched: Instant::now(),
                folder,
            },
        );
    }
}

/// Make a cached answer look `by` older (TTL and stale-window tests).
#[cfg(test)]
pub(crate) fn age_cache(source_id: &str, by: Duration) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        if let Some(entry) = guard.get_mut(source_id) {
            entry.fetched = entry.fetched.checked_sub(by).unwrap_or(entry.fetched);
        }
    }
}

pub(super) fn cache_drop(source_id: &str) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        guard.remove(source_id);
    }
}

pub(super) fn secs(value: i64) -> Duration {
    Duration::from_secs(value.max(0) as u64)
}

pub(super) fn lookup(folder: &RemoteFolder, name: &str) -> LiveLookup {
    match folder.values.get(name) {
        Some(value) if !value.trim().is_empty() => LiveLookup::Found {
            value: value.clone(),
            version: folder.version.unwrap_or(0),
        },
        _ => LiveLookup::Missing,
    }
}

/// Longest source or destination error kept on a record, in bytes.
const MAX_ERROR_LEN: usize = 300;

/// `error` cut to [`MAX_ERROR_LEN`] bytes on a char boundary. A byte cut with
/// `String::truncate` panics inside a multi-byte character, crashing Core with
/// the error text (and any secret path or value it quotes) in the panic report.
pub(super) fn short_error(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    text[..text.floor_char_boundary(MAX_ERROR_LEN)].to_owned()
}

#[cfg(test)]
#[path = "live_cache_test.rs"]
mod live_cache_test;

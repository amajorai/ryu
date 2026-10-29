//! Shadow's at-rest sealing.
//!
//! Shadow holds one key: its component subkey (`component:shadow`), an HKDF of
//! the Ryu master key that Core delivers at spawn (`RYU_SEAL_KEY`), or that a
//! standalone `shadow start` derives from `RYU_MASTER_KEY`. Without either,
//! Shadow reports `sealing: no-key` and refuses every capture write, with one
//! exception: **compat mode** ([`SealingState::Compat`]). A Shadow that Ryu
//! Core started without a key (a Core older than Shadow's sealing, which
//! downloads the latest Shadow but never delivers a key) on a store that was
//! never sealed keeps the pre-sealing plaintext behaviour and reports
//! `sealing: "waiting for a Ryu update"`; the first start with a key seals
//! what it wrote. A store that already holds sealed data is never written in
//! plaintext.
//!
//! Every store derives its own content key from the component subkey:
//!
//! | Store | What |
//! |---|---|
//! | [`EVENTS_STORE`] | the hourly event log (`RYU-SL01` while open, `RYU-SF01` once rotated), one subkey per segment |
//! | [`TIMELINE_STORE`] | text columns of `timeline.db` (`encb:v1:`) |
//! | [`SEARCH_STORE`] | the search index: sealed document payloads and blind term tokens |
//! | [`MEDIA_STORE`] | screen video, audio and keyframes (`RYU-SF01`), one subkey per file |
//!
//! The key check value of the component key is recorded per store in
//! `timeline.db` (`ryu_content_seal`), so a store sealed under another key is
//! reported (`sealing: mismatch`) instead of being re-sealed or reset.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use ryu_crypto::{BlindIndex, ComponentCipher, ContentCipher, ContentContext};

use crate::ShadowError;

/// The component name Shadow's key is derived for.
pub const COMPONENT: &str = ryu_crypto::components::SHADOW;
/// The hourly capture event log.
pub const EVENTS_STORE: &str = "shadow-events";
/// Text columns of `indices/timeline.db`.
pub const TIMELINE_STORE: &str = "shadow-timeline";
/// The full-text search index.
pub const SEARCH_STORE: &str = "shadow-search";
/// Captured media (video, audio, keyframes).
pub const MEDIA_STORE: &str = "shadow-media";
/// Every file-backed store whose key check value is recorded in `timeline.db`.
pub const FILE_STORES: [&str; 3] = [EVENTS_STORE, SEARCH_STORE, MEDIA_STORE];

/// Whether Shadow can seal what it writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealingState {
    /// A key is held and every store matches it.
    Ok,
    /// No key: capture writes are refused.
    NoKey,
    /// A store was sealed under a key this process does not hold: writes refused.
    Mismatch,
    /// No key, started by a Core that does not deliver one, store never
    /// sealed: written in plaintext as before sealing, sealed at the first
    /// start with a key.
    Compat,
}

impl SealingState {
    /// The `/health` wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NoKey => "no-key",
            Self::Mismatch => "mismatch",
            Self::Compat => "waiting for a Ryu update",
        }
    }
}

struct KeyState {
    state: SealingState,
    cipher: Option<Arc<ComponentCipher>>,
    detail: Option<String>,
}

static KEY: RwLock<KeyState> = RwLock::new(KeyState {
    state: SealingState::NoKey,
    cipher: None,
    detail: None,
});

/// Whether Ryu Core started this process without delivering a key (see
/// [`set_started_by_core`]).
static STARTED_BY_CORE: AtomicBool = AtomicBool::new(false);

static CONTENT_CACHE: Mutex<Option<HashMap<String, ContentCipher>>> = Mutex::new(None);
static PROGRESS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static UNREADABLE: AtomicU64 = AtomicU64::new(0);

/// Resolve this process's key: the subkey Core delivered, else one derived from
/// `RYU_MASTER_KEY`. Call [`ryu_crypto::capture_process_seal_key`] in `main`
/// before any thread starts; this only reads what it captured.
pub fn resolve_process_key() -> SealingState {
    match ryu_crypto::component_cipher_for_process(COMPONENT) {
        Ok(cipher) => {
            install_key(cipher);
            SealingState::Ok
        }
        Err(error) => {
            log::warn!("shadow: no sealing key ({error}); capture writes are refused");
            set_state(SealingState::NoKey, Some(error.to_string()));
            SealingState::NoKey
        }
    }
}

/// Whether the environment carries what every Ryu Core sets on the Shadow it
/// starts (`RYU_DIR`, `SHADOW_DATA_DIR`, `SHADOW_MODELS_DIR`).
pub fn core_launch_env_present() -> bool {
    ["RYU_DIR", "SHADOW_DATA_DIR", "SHADOW_MODELS_DIR"]
        .iter()
        .all(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// Record that Ryu Core started this process and delivered no key (`main`
/// calls it before [`crate::init_storage`]): compat mode is allowed for a
/// store that was never sealed.
pub fn set_started_by_core(started: bool) {
    STARTED_BY_CORE.store(started, Ordering::Relaxed);
}

/// See [`set_started_by_core`].
pub fn started_by_core() -> bool {
    STARTED_BY_CORE.load(Ordering::Relaxed)
}

/// Whether nothing under this data directory was ever sealed: no key check
/// value is recorded for a Shadow store in `timeline.db` (a Shadow with a key
/// records it before its first write) and the search index is not the sealed
/// format. Any doubt (an unreadable state table) counts as sealed.
pub fn store_never_sealed(conn: &rusqlite::Connection, search_index_dir: &std::path::Path) -> bool {
    use ryu_crypto::content_sqlite::STATE_TABLE;
    let recorded = (|| -> rusqlite::Result<bool> {
        let has_table: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [STATE_TABLE],
            |row| row.get(0),
        )?;
        if !has_table {
            return Ok(false);
        }
        conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {STATE_TABLE}
                 WHERE store IN (?1, ?2, ?3, ?4) AND kcv IS NOT NULL)"
            ),
            [TIMELINE_STORE, EVENTS_STORE, SEARCH_STORE, MEDIA_STORE],
            |row| row.get(0),
        )
    })();
    if !matches!(recorded, Ok(false)) {
        return false;
    }
    let search_version = std::fs::read_to_string(search_index_dir.join("schema_version"))
        .ok()
        .and_then(|version| version.trim().parse::<u32>().ok());
    !matches!(search_version, Some(version) if version >= crate::search::SCHEMA_VERSION)
}

/// Enter compat mode (only from `no-key`; see the module docs).
pub fn enter_compat() {
    if state() != SealingState::NoKey {
        return;
    }
    log::warn!(
        "shadow: started by a Ryu that does not deliver a sealing key; capture is stored \
         unsealed, as before, until Ryu is updated"
    );
    set_state(
        SealingState::Compat,
        Some(
            "this version of Ryu does not deliver Shadow's sealing key; capture is stored \
             unsealed until Ryu is updated, then sealed"
                .into(),
        ),
    );
}

/// Whether writes are sealed (a key is held and every store matches it).
pub fn is_sealing() -> bool {
    state() == SealingState::Ok && component_for_read().is_ok()
}

/// Whether this process writes in plaintext (compat mode).
pub fn is_compat() -> bool {
    state() == SealingState::Compat
}

/// Install `cipher` as Shadow's key (resets the per-store cache).
pub fn install_key(cipher: ComponentCipher) {
    let mut guard = KEY
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.cipher = Some(Arc::new(cipher));
    guard.state = SealingState::Ok;
    guard.detail = None;
    drop(guard);
    *CONTENT_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Install a fixed key for tests (idempotent: the first call wins, so parallel
/// tests in one process share one key).
#[doc(hidden)]
pub fn install_fixed_key_for_tests() {
    let has_key = KEY
        .read()
        .map(|guard| guard.cipher.is_some())
        .unwrap_or(false);
    if !has_key {
        let cipher = ComponentCipher::from_subkey_b64(
            COMPONENT,
            "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
        )
        .expect("fixed test key");
        install_key(cipher);
    }
}

fn set_state(state: SealingState, detail: Option<String>) {
    let mut guard = KEY
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.state = state;
    guard.detail = detail;
}

/// Mark a store as sealed under another key: Shadow refuses writes from now on.
pub fn mark_mismatch(store: &str) {
    log::error!(
        "shadow: {store} was sealed under a different key; capture writes are refused \
         (run `ryu-core keys status`)"
    );
    set_state(
        SealingState::Mismatch,
        Some(format!("{store} was sealed under a different key")),
    );
}

/// The current sealing state.
pub fn state() -> SealingState {
    KEY.read()
        .map(|guard| guard.state)
        .unwrap_or(SealingState::NoKey)
}

/// Why sealing is not `ok` (no key material, safe to show).
pub fn detail() -> Option<String> {
    KEY.read().ok().and_then(|guard| guard.detail.clone())
}

/// Record the progress of a background sealing task (`timeline`, `media`, ...).
pub fn set_progress(task: &str, value: &str) {
    let mut progress = PROGRESS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match progress.iter_mut().find(|(name, _)| name == task) {
        Some(entry) => entry.1 = value.to_owned(),
        None => progress.push((task.to_owned(), value.to_owned())),
    }
}

/// The health view of sealing: state, why it is not ok, background task
/// progress and the number of values that did not open since start.
pub fn health() -> serde_json::Value {
    let progress: serde_json::Map<String, serde_json::Value> = PROGRESS
        .lock()
        .map(|progress| {
            progress
                .iter()
                .map(|(task, value)| (task.clone(), serde_json::Value::from(value.clone())))
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({
        "sealing": state().as_str(),
        "detail": detail(),
        "progress": progress,
        "unreadable_rows": unreadable_count(),
    })
}

/// Values that did not open since start (skipped in lists and searches).
pub fn unreadable_count() -> u64 {
    UNREADABLE.load(Ordering::Relaxed)
}

pub(crate) fn note_unreadable(what: &str) {
    let total = UNREADABLE.fetch_add(1, Ordering::Relaxed) + 1;
    if total == 1 || total.is_power_of_two() {
        log::warn!("shadow: a sealed {what} did not open (skipped); {total} so far");
    }
}

fn no_key() -> ShadowError {
    ShadowError::StorageError {
        msg: match state() {
            SealingState::Mismatch => {
                "Shadow storage was sealed under a different key; capture writes are refused".into()
            }
            _ => "Shadow has no sealing key; capture writes are refused (start Shadow from Ryu, \
                  or set RYU_MASTER_KEY)"
                .into(),
        },
    }
}

/// The component cipher, for READS (also allowed while a store mismatches, so
/// stores that do match stay readable).
fn component_for_read() -> Result<Arc<ComponentCipher>, ShadowError> {
    KEY.read()
        .ok()
        .and_then(|guard| guard.cipher.clone())
        .ok_or_else(no_key)
}

/// Refuse a write unless sealing is `ok` or Shadow is in compat mode (where
/// the writer stores plaintext; check [`is_sealing`]).
pub fn require_writable() -> Result<(), ShadowError> {
    if is_sealing() || is_compat() {
        Ok(())
    } else {
        Err(no_key())
    }
}

/// The content cipher of `store` for reading.
pub fn content(store: &str) -> Result<ContentCipher, ShadowError> {
    let component = component_for_read()?;
    let mut cache = CONTENT_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cache = cache.get_or_insert_with(HashMap::new);
    Ok(cache
        .entry(store.to_owned())
        .or_insert_with(|| component.content_cipher(store))
        .clone())
}

/// The content cipher of `store` for writing (refused unless sealing is `ok`).
pub fn content_for_write(store: &str) -> Result<ContentCipher, ShadowError> {
    if !is_sealing() {
        return Err(no_key());
    }
    content(store)
}

/// The blind index of `(store, field)`.
pub fn blind(store: &str, field: &str) -> Result<BlindIndex, ShadowError> {
    Ok(component_for_read()?.blind_index(store, field))
}

/// The key check value of the held key.
pub fn kcv() -> Option<String> {
    component_for_read().ok().map(|cipher| cipher.kcv())
}

/// Check (and on first use record) the key of every Shadow store in
/// `timeline.db`'s `ryu_content_seal` table. A mismatch flips the process to
/// [`SealingState::Mismatch`]. Returns whether every store matches.
pub fn check_store_keys(conn: &rusqlite::Connection) -> Result<bool, ShadowError> {
    use ryu_crypto::content_sqlite::{check_store_key, StoreKeyState};
    let mut all_match = true;
    for store in std::iter::once(TIMELINE_STORE).chain(FILE_STORES) {
        let cipher = content(store)?;
        let checked =
            check_store_key(conn, &cipher).map_err(|error| ShadowError::StorageError {
                msg: format!("checking the {store} key: {error}"),
            })?;
        if let StoreKeyState::Mismatch { .. } = checked {
            mark_mismatch(store);
            all_match = false;
        }
    }
    Ok(all_match)
}

/// Seal one TEXT column value bound to `(purpose, label = id)`. In compat
/// mode the value is returned as is (sealed by the first start with a key).
pub fn seal_value(
    store: &str,
    purpose: &str,
    label: &'static str,
    id: &str,
    value: &str,
) -> Result<String, ShadowError> {
    if is_compat() {
        return Ok(value.to_owned());
    }
    let cipher = content_for_write(store)?;
    cipher
        .seal_text(value, &ContentContext::new(purpose).with(label, id))
        .map_err(|error| ShadowError::StorageError {
            msg: format!("sealing {purpose}: {error}"),
        })
}

/// [`seal_value`] for an optional column, as a rusqlite error for SQL paths.
pub fn seal_opt(
    store: &str,
    purpose: &str,
    label: &'static str,
    id: &str,
    value: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    value
        .map(|value| seal_value(store, purpose, label, id, value))
        .transpose()
        .map_err(to_sql_error)
}

/// Open one TEXT column value. Legacy plaintext is returned as is. A value that
/// does not open is counted and returned as `None` (lists and searches skip
/// it rather than fail).
pub fn open_opt(
    store: &str,
    purpose: &str,
    label: &'static str,
    id: &str,
    stored: Option<String>,
) -> Option<String> {
    let stored = stored?;
    match open_strict(store, purpose, label, id, &stored) {
        Ok(value) => Some(value),
        Err(_) => {
            note_unreadable(purpose);
            None
        }
    }
}

/// Open one TEXT column value; an error when it does not open (get-by-id).
pub fn open_strict(
    store: &str,
    purpose: &str,
    label: &'static str,
    id: &str,
    stored: &str,
) -> Result<String, ShadowError> {
    if !ContentCipher::is_sealed_text(stored) && !ryu_crypto::looks_sealed(stored) {
        // Legacy plaintext (the startup migration seals it).
        return Ok(stored.to_owned());
    }
    let cipher = content(store)?;
    cipher
        .open_text(stored, &ContentContext::new(purpose).with(label, id))
        .map(|opened| opened.value)
        .map_err(|error| ShadowError::StorageError {
            msg: format!("{purpose} does not open: {error}"),
        })
}

pub fn to_sql_error(error: ShadowError) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

/// Create `dir` (and parents) with owner-only permissions on Unix.
pub fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_and_open_round_trip_and_bind_the_id() {
        install_fixed_key_for_tests();
        let sealed = seal_value(TIMELINE_STORE, "t.c", "id", "1", "secret title").unwrap();
        assert!(sealed.starts_with("encb:v1:"));
        assert!(!sealed.contains("secret"));
        assert_eq!(
            open_strict(TIMELINE_STORE, "t.c", "id", "1", &sealed).unwrap(),
            "secret title"
        );
        // Copied to another row, it does not open.
        assert!(open_strict(TIMELINE_STORE, "t.c", "id", "2", &sealed).is_err());
        assert_eq!(
            open_opt(TIMELINE_STORE, "t.c", "id", "2", Some(sealed)),
            None
        );
        // Legacy plaintext still reads.
        assert_eq!(
            open_strict(TIMELINE_STORE, "t.c", "id", "1", "plain").unwrap(),
            "plain"
        );
    }
}

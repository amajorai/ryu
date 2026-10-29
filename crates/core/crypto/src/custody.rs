//! Master-key availability, key check values (KCV), retired keys, recovery and
//! the data-format marker.
//!
//! Phase 2 seals whole profiles of user content under keys derived from the
//! master key, so a silent master-key switch would destroy them: a migration
//! would seal plaintext under a transient key and scrub the plaintext away,
//! while everything sealed under the real key stopped opening. This module
//! makes the custody ladder refuse that:
//!
//! 1. **Key check value.** `state/master-key.kcv` (`{v, kcv, custody,
//!    written_at}`) records `hex(HMAC-SHA256(key, "ryu-kcv-v1")[..16])` of the key
//!    that seals the data folder. Core writes it the first time it resolves the
//!    key and a probe (opening up to three sealed message bodies) passes.
//! 2. **No silent generation.** A new key is generated only when no KCV is
//!    recorded and no sealed data is found; otherwise resolution refuses ("the
//!    key that sealed this data folder is not in the keychain").
//! 3. **Mismatch handling.** When the resolved key's KCV differs from the
//!    recorded one, the other candidates (keychain, `secrets/master.key`,
//!    `secrets/memory.key`, retired keys) are tried. A match becomes the current
//!    key for this run (health `recovered_from_<custody>`) and the mismatched
//!    persistent key is retired. No match: resolution fails closed (health
//!    `mismatch`), so no store writes and no migration starts.
//! 4. **Retired keys** (at most 4) live under `secrets/retired/<kcv>.key`
//!    (file custody) or keychain account `master-key{suffix}:retired:<kcv>`,
//!    indexed by `state/retired-keys.json` (KCVs and custody only). Every opener
//!    tries them after the current key and reports `needs_reseal`.
//! 5. **Data-format marker.** `state/data-format.json` (`{format, min_reader}`)
//!    is written before the first phase-2 migration; a build refuses a data
//!    folder whose `min_reader` it does not support.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::content::key_check_value;
use crate::{
    b64, decode_key, layout, read_key_file, restrict_permissions, write_key_file, CryptoHost,
    DisabledKeychain, FieldCipher, KeyPaths, Keychain, KeychainState, MasterKeySource, OsKeychain,
    ENV_KEYCHAIN, ENV_MASTER_KEY, KEYRING_ACCOUNT, KEY_LEN,
};

/// The data format this build writes.
pub const DATA_FORMAT: i64 = 2;
/// The highest `min_reader` this build can read.
pub const SUPPORTED_MIN_READER: i64 = 2;
/// At most this many retired master keys are kept.
pub const MAX_RETIRED_KEYS: usize = 4;
const KCV_FILE: &str = "master-key.kcv";
const RETIRED_INDEX_FILE: &str = "retired-keys.json";
const DATA_FORMAT_FILE: &str = "data-format.json";
const RETIRED_DIR: &str = "retired";

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Where a candidate master key comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeySourceKind {
    /// `RYU_MASTER_KEY`.
    Env,
    /// The OS keychain slot `master-key{suffix}`.
    Keychain,
    /// `secrets/master.key`.
    File,
    /// The legacy `secrets/memory.key`.
    LegacyMemory,
    /// A retired key, by KCV.
    Retired(String),
}

impl KeySourceKind {
    /// Stable name for logs, health and the CLI.
    pub fn name(&self) -> String {
        match self {
            Self::Env => "env".to_owned(),
            Self::Keychain => "keychain".to_owned(),
            Self::File => "file".to_owned(),
            Self::LegacyMemory => "memory".to_owned(),
            Self::Retired(kcv) => format!("retired:{kcv}"),
        }
    }

    fn custody(&self) -> MasterKeySource {
        match self {
            Self::Env => MasterKeySource::Env,
            Self::Keychain => MasterKeySource::Keychain,
            _ => MasterKeySource::File,
        }
    }
}

/// Health of master-key custody, for status surfaces.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MasterKeyHealth {
    /// Not resolved yet in this process.
    Unresolved,
    /// The resolved key is the recorded key (or none is recorded yet).
    Ok,
    /// The persistent key did not match the recorded KCV; another candidate did
    /// and is used for this run (`recovered_from_<custody>`).
    RecoveredFrom(String),
    /// No candidate matches the recorded KCV: writes fail closed.
    Mismatch,
}

impl MasterKeyHealth {
    /// Stable wire value (`ok`, `recovered_from_file`, `mismatch`, ...).
    pub fn as_str(&self) -> String {
        match self {
            Self::Unresolved => "unresolved".to_owned(),
            Self::Ok => "ok".to_owned(),
            Self::RecoveredFrom(from) => format!("recovered_from_{from}"),
            Self::Mismatch => "mismatch".to_owned(),
        }
    }
}

/// Resolution refused because no candidate key matches the data folder's
/// recorded key (or opens its sealed data). Downcast an error to it to report
/// `master_key: mismatch`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyMismatch(pub String);

impl std::fmt::Display for KeyMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyMismatch {}

static HEALTH: Mutex<MasterKeyHealth> = Mutex::new(MasterKeyHealth::Unresolved);

pub(crate) fn set_health(health: MasterKeyHealth) {
    if let Ok(mut slot) = HEALTH.lock() {
        *slot = health;
    }
}

/// The current master-key health of this process.
pub fn master_key_health() -> MasterKeyHealth {
    HEALTH
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or(MasterKeyHealth::Unresolved)
}

// ── Records on disk ──────────────────────────────────────────────────────────

/// `state/master-key.kcv`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KcvRecord {
    /// Record version (1).
    pub v: u32,
    /// Key check value of the key that seals this data folder.
    pub kcv: String,
    /// Custody it was resolved from when recorded (`keychain`, `file`, `env`).
    pub custody: String,
    /// Unix seconds.
    pub written_at: i64,
}

/// One entry of `state/retired-keys.json` (never key material).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetiredEntry {
    /// Key check value of the retired key.
    pub kcv: String,
    /// `file` or `keychain`.
    pub custody: String,
    /// Unix seconds.
    pub retired_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct RetiredIndex {
    v: u32,
    keys: Vec<RetiredEntry>,
}

/// `state/data-format.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataFormat {
    /// Format of the newest writer.
    pub format: i64,
    /// Lowest reader that can open the data folder.
    pub min_reader: i64,
}

fn kcv_path(dir: &Path) -> PathBuf {
    layout::state_path(dir, KCV_FILE)
}

fn retired_index_path(dir: &Path) -> PathBuf {
    layout::state_path(dir, RETIRED_INDEX_FILE)
}

fn data_format_path(dir: &Path) -> PathBuf {
    layout::state_path(dir, DATA_FORMAT_FILE)
}

fn retired_key_path(dir: &Path, kcv: &str) -> PathBuf {
    layout::secrets_dir(dir)
        .join(RETIRED_DIR)
        .join(format!("{kcv}.key"))
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .with_context(|| format!("parsing {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

/// Write `bytes` to `path` atomically (temp file in the same dir, fsync, rename).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent", path.display()))?;
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temp.as_file_mut().write_all(bytes)?;
    temp.as_file_mut().sync_all()?;
    temp.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("writing {}", path.display()))?;
    if private {
        restrict_permissions(&path.to_path_buf());
    }
    crate::sealed_file::sync_parent_dir(path);
    Ok(())
}

/// The recorded key check value of the data folder at `dir`, if any.
pub fn read_kcv_record(dir: &Path) -> Result<Option<KcvRecord>> {
    read_json(&kcv_path(dir))
}

fn write_kcv_record(dir: &Path, kcv: &str, custody: &str) -> Result<()> {
    let record = KcvRecord {
        v: 1,
        kcv: kcv.to_owned(),
        custody: custody.to_owned(),
        written_at: now_secs(),
    };
    write_atomic(&kcv_path(dir), &serde_json::to_vec_pretty(&record)?, false)
}

/// The retired-key index of the data folder at `dir`.
pub fn read_retired_index(dir: &Path) -> Result<Vec<RetiredEntry>> {
    Ok(read_json::<RetiredIndex>(&retired_index_path(dir))?
        .map(|index| index.keys)
        .unwrap_or_default())
}

fn write_retired_index(dir: &Path, keys: &[RetiredEntry]) -> Result<()> {
    let index = RetiredIndex {
        v: 1,
        keys: keys.to_vec(),
    };
    write_atomic(
        &retired_index_path(dir),
        &serde_json::to_vec_pretty(&index)?,
        false,
    )
}

/// The data-format marker of the data folder at `dir`, if any.
pub fn read_data_format(dir: &Path) -> Result<Option<DataFormat>> {
    read_json(&data_format_path(dir))
}

/// Refuse a data folder written by a newer Ryu (`min_reader` above what this
/// build supports). A missing marker is fine.
pub fn check_data_format(dir: &Path) -> Result<()> {
    if let Some(marker) = read_data_format(dir)? {
        if marker.min_reader > SUPPORTED_MIN_READER {
            bail!(
                "this data folder was used by a newer Ryu (it needs reader format {}, this build \
                 reads {SUPPORTED_MIN_READER}); update Ryu, or export from the newer version \
                 before downgrading",
                marker.min_reader
            );
        }
    }
    Ok(())
}

/// Record that this data folder holds phase-2 data (`{format: 2, min_reader:
/// 2}`), never lowering an existing marker. Call before the first migration.
pub fn write_data_format(dir: &Path) -> Result<()> {
    check_data_format(dir)?;
    let current = read_data_format(dir)?;
    if matches!(current, Some(marker) if marker.format >= DATA_FORMAT && marker.min_reader >= SUPPORTED_MIN_READER)
    {
        return Ok(());
    }
    let marker = DataFormat {
        format: DATA_FORMAT,
        min_reader: SUPPORTED_MIN_READER,
    };
    write_atomic(
        &data_format_path(dir),
        &serde_json::to_vec_pretty(&marker)?,
        false,
    )
}

/// Called by every content-cipher constructor: in a host that owns the data
/// folder (Core), write the data-format marker once, before the first
/// migration can run.
pub(crate) fn note_content_use() {
    static DONE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    DONE.get_or_init(|| {
        let Some(host) = crate::host_slot().get() else {
            return;
        };
        if !host.records_kcv() {
            return;
        }
        if let Err(error) = write_data_format(&host.ryu_dir()) {
            tracing::error!("could not write the data-format marker: {error:#}");
        }
    });
}

// ── Probe ────────────────────────────────────────────────────────────────────

/// Result of a host's probe of a candidate master key against existing sealed
/// data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyProbe {
    /// At least one sealed value opened.
    Passed,
    /// No sealed value was found to test.
    NoSealedData,
    /// Sealed values exist and none opened: the key is wrong.
    Failed,
}

// ── Retired-key vault ────────────────────────────────────────────────────────

/// Where retired key material lives. The production vault uses files under
/// `secrets/retired/` and keychain accounts `master-key{suffix}:retired:<kcv>`;
/// tests inject keychains.
/// Builds the keychain slot for one retired-key account.
type KeychainFactory<'a> = Box<dyn Fn(&str) -> Box<dyn Keychain> + 'a>;

pub(crate) struct RetiredVault<'a> {
    dir: PathBuf,
    account_base: String,
    keychain_enabled: bool,
    keychain_for: KeychainFactory<'a>,
}

impl<'a> RetiredVault<'a> {
    fn production(dir: PathBuf, account_base: String, keychain_enabled: bool) -> Self {
        Self {
            dir,
            account_base,
            keychain_enabled,
            keychain_for: Box::new(|account: &str| -> Box<dyn Keychain> {
                Box::new(OsKeychain {
                    account: account.to_owned(),
                })
            }),
        }
    }

    fn account(&self, kcv: &str) -> String {
        format!("{}:retired:{kcv}", self.account_base)
    }

    fn load(&self, entry: &RetiredEntry) -> Result<[u8; KEY_LEN]> {
        let key = match entry.custody.as_str() {
            "keychain" => {
                // `RYU_KEYCHAIN=off` must never touch the OS keychain, not even
                // to read a key an earlier run retired there.
                if !self.keychain_enabled {
                    bail!(
                        "retired key {} is held in the keychain, which is disabled \
                         (RYU_KEYCHAIN=off)",
                        entry.kcv
                    );
                }
                match (self.keychain_for)(&self.account(&entry.kcv)).get() {
                    KeychainState::Key(key) => key,
                    _ => bail!(
                        "retired key {} is not readable from the keychain",
                        entry.kcv
                    ),
                }
            }
            _ => read_key_file(&retired_key_path(&self.dir, &entry.kcv))?
                .ok_or_else(|| anyhow!("retired key file {} is missing", entry.kcv))?,
        };
        if key_check_value(&key) != entry.kcv {
            bail!(
                "retired key {} does not match its key check value",
                entry.kcv
            );
        }
        Ok(key)
    }

    /// Store a key in the retired set (idempotent by KCV). Keychain custody when
    /// `prefer_keychain` and a read-back confirms it, else a `0600` file.
    fn retire(&self, key: &[u8; KEY_LEN], prefer_keychain: bool) -> Result<RetiredEntry> {
        let kcv = key_check_value(key);
        let mut index = read_retired_index(&self.dir)?;
        if let Some(existing) = index.iter().find(|entry| entry.kcv == kcv) {
            return Ok(existing.clone());
        }
        if index.len() >= MAX_RETIRED_KEYS {
            bail!(
                "the retired-key set is full ({MAX_RETIRED_KEYS} keys); run `ryu-core keys status` \
                 and import into a new profile instead"
            );
        }
        let mut custody = "file";
        if prefer_keychain && self.keychain_enabled {
            let slot = (self.keychain_for)(&self.account(&kcv));
            if slot.store(key) && matches!(slot.get(), KeychainState::Key(back) if back == *key) {
                custody = "keychain";
            }
        }
        if custody == "file" {
            let path = retired_key_path(&self.dir, &kcv);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
                restrict_dir(parent);
            }
            if read_key_file(&path)?.is_none() {
                write_key_file(&path, key)?;
            }
        }
        let entry = RetiredEntry {
            kcv,
            custody: custody.to_owned(),
            retired_at: now_secs(),
        };
        index.push(entry.clone());
        write_retired_index(&self.dir, &index)?;
        tracing::warn!(kcv = %entry.kcv, custody = %entry.custody, "master key moved to the retired set");
        Ok(entry)
    }

    fn load_all(&self) -> Vec<(RetiredEntry, [u8; KEY_LEN])> {
        let entries = match read_retired_index(&self.dir) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::error!("retired-key index unreadable: {error:#}");
                return Vec::new();
            }
        };
        entries
            .into_iter()
            .filter_map(|entry| match self.load(&entry) {
                Ok(key) => Some((entry, key)),
                Err(error) => {
                    tracing::error!("retired key unavailable: {error:#}");
                    None
                }
            })
            .collect()
    }
}

#[cfg(unix)]
fn restrict_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) {}

// ── Resolution ───────────────────────────────────────────────────────────────

/// Everything resolution reads, injected so every transition is testable.
pub(crate) struct CustodyInputs<'a> {
    pub(crate) dir: PathBuf,
    pub(crate) env_value: Option<String>,
    pub(crate) keychain: &'a dyn Keychain,
    pub(crate) keychain_enabled: bool,
    pub(crate) paths: KeyPaths,
    pub(crate) allow_file: bool,
    pub(crate) records_kcv: bool,
    pub(crate) vault: RetiredVault<'a>,
    pub(crate) probe: &'a dyn Fn(&FieldCipher) -> KeyProbe,
    pub(crate) sealed_evidence: &'a dyn Fn() -> Option<String>,
}

/// The resolved key, its custody, and the retired keys to open with.
pub(crate) struct Resolution {
    pub(crate) key: [u8; KEY_LEN],
    pub(crate) source: MasterKeySource,
    pub(crate) retired: Vec<[u8; KEY_LEN]>,
    pub(crate) health: MasterKeyHealth,
}

/// A lazily evaluated "is sealed data present" guard for key generation.
pub(crate) struct GenerationGuard<'a> {
    evidence: Option<&'a dyn Fn() -> Option<String>>,
}

impl<'a> GenerationGuard<'a> {
    /// No guard (legacy ladder tests).
    #[cfg(test)]
    pub(crate) fn permissive() -> Self {
        Self { evidence: None }
    }

    /// Refuse generation when `evidence` names sealed data.
    pub(crate) fn new(evidence: &'a dyn Fn() -> Option<String>) -> Self {
        Self {
            evidence: Some(evidence),
        }
    }

    /// `Ok` when a fresh key may be generated; else the reason.
    pub(crate) fn may_generate(&self) -> std::result::Result<(), String> {
        match self.evidence.and_then(|evidence| evidence()) {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }
}

fn kcv_hex(key: &[u8; KEY_LEN]) -> String {
    key_check_value(key)
}

/// Every candidate key this data folder can see, in recovery order.
fn candidates(inputs: &CustodyInputs<'_>) -> Vec<(KeySourceKind, [u8; KEY_LEN])> {
    let mut out = Vec::new();
    if let Some(key) = inputs.env_value.as_deref().and_then(decode_key) {
        out.push((KeySourceKind::Env, key));
    }
    if let KeychainState::Key(key) = inputs.keychain.get() {
        out.push((KeySourceKind::Keychain, key));
    }
    if let Ok(Some(key)) = read_key_file(&inputs.paths.master) {
        out.push((KeySourceKind::File, key));
    }
    if inputs.paths.legacy_memory != inputs.paths.master {
        if let Ok(Some(key)) = read_key_file(&inputs.paths.legacy_memory) {
            out.push((KeySourceKind::LegacyMemory, key));
        }
    }
    for (entry, key) in inputs.vault.load_all() {
        out.push((KeySourceKind::Retired(entry.kcv), key));
    }
    out
}

/// Resolve the master key with the KCV checks (see the module docs).
pub(crate) fn resolve(inputs: &CustodyInputs<'_>) -> Result<Resolution> {
    check_data_format(&inputs.dir)?;
    let recorded = read_kcv_record(&inputs.dir)?;
    let guard_evidence = || -> Option<String> {
        if let Some(record) = &recorded {
            return Some(format!("a key check value is recorded ({})", record.kcv));
        }
        (inputs.sealed_evidence)()
    };
    let guard = GenerationGuard::new(&guard_evidence);
    let ladder = crate::load_master_key_guarded(
        inputs.env_value.clone(),
        inputs.keychain,
        &inputs.paths,
        inputs.allow_file,
        &guard,
    );
    let retired_all = inputs.vault.load_all();
    let retired_keys = |exclude: &[u8; KEY_LEN]| -> Vec<[u8; KEY_LEN]> {
        retired_all
            .iter()
            .map(|(_, key)| *key)
            .filter(|key| key != exclude)
            .collect()
    };
    let (primary, source) = match ladder {
        Ok(found) => found,
        Err(error) => {
            // The ladder refused (for example the keychain lost its entry while
            // sealed data exists). A candidate that matches the recorded KCV
            // still recovers the data folder.
            if let Some(record) = &recorded {
                if let Some((kind, key)) = candidates(inputs)
                    .into_iter()
                    .find(|(_, key)| kcv_hex(key) == record.kcv)
                {
                    tracing::warn!(
                        from = %kind.name(),
                        "master key recovered from another candidate after the custody ladder \
                         refused: {error:#}"
                    );
                    return Ok(Resolution {
                        health: MasterKeyHealth::RecoveredFrom(kind.name()),
                        key,
                        source: kind.custody(),
                        retired: retired_keys(&key),
                    });
                }
            }
            return Err(error);
        }
    };
    let primary_kcv = kcv_hex(&primary);

    match &recorded {
        Some(record) if record.kcv == primary_kcv => Ok(Resolution {
            health: MasterKeyHealth::Ok,
            key: primary,
            source,
            retired: retired_keys(&primary),
        }),
        Some(record) => {
            let primary_is_retired = retired_all
                .iter()
                .any(|(entry, _)| entry.kcv == primary_kcv);
            if source == MasterKeySource::Env && !primary_is_retired {
                return Err(KeyMismatch(format!(
                    "{ENV_MASTER_KEY} does not match the key that sealed this data folder \
                     (recorded key check value {}); refusing to use it. Unset it or provide the \
                     right key; `ryu-core keys status` lists the candidates",
                    record.kcv
                ))
                .into());
            }
            let found = candidates(inputs)
                .into_iter()
                .find(|(_, key)| kcv_hex(key) == record.kcv);
            let Some((kind, key)) = found else {
                return Err(KeyMismatch(format!(
                    "the master key from {} does not match the key that sealed this data folder \
                     (recorded key check value {}), and no other candidate does; writes are \
                     refused to protect the data. Run `ryu-core keys status`",
                    source.as_str(),
                    record.kcv
                ))
                .into());
            };
            if source != MasterKeySource::Env {
                // Keep anything sealed under the mismatched key during a
                // mixed-key incident readable.
                if let Err(error) = inputs
                    .vault
                    .retire(&primary, source == MasterKeySource::Keychain)
                {
                    tracing::error!("could not retire the mismatched master key: {error:#}");
                }
            }
            tracing::warn!(
                from = %kind.name(),
                mismatched = %source.as_str(),
                "master key: the persistent key does not match the recorded key check value; \
                 using the matching candidate for this run"
            );
            let health = MasterKeyHealth::RecoveredFrom(kind.name());
            let mut retired = retired_keys(&key);
            if !retired.contains(&primary) {
                retired.push(primary);
            }
            Ok(Resolution {
                key,
                source: kind.custody(),
                retired,
                health,
            })
        }
        None => {
            if !inputs.records_kcv {
                return Ok(Resolution {
                    health: MasterKeyHealth::Ok,
                    key: primary,
                    source,
                    retired: retired_keys(&primary),
                });
            }
            match (inputs.probe)(&FieldCipher::new(&primary)) {
                KeyProbe::Passed | KeyProbe::NoSealedData => {
                    write_kcv_record(
                        &inputs.dir,
                        &primary_kcv,
                        crate::effective_source(source, &primary, &inputs.paths).as_str(),
                    )?;
                    Ok(Resolution {
                        health: MasterKeyHealth::Ok,
                        key: primary,
                        source,
                        retired: retired_keys(&primary),
                    })
                }
                KeyProbe::Failed => {
                    let recovered = candidates(inputs).into_iter().find(|(_, key)| {
                        *key != primary
                            && (inputs.probe)(&FieldCipher::new(key)) == KeyProbe::Passed
                    });
                    let Some((kind, key)) = recovered else {
                        return Err(KeyMismatch(format!(
                            "the master key from {} does not open this data folder's sealed \
                             messages, and no other candidate does; writes are refused to \
                             protect the data. Run `ryu-core keys status`",
                            source.as_str()
                        ))
                        .into());
                    };
                    if source != MasterKeySource::Env {
                        if let Err(error) = inputs
                            .vault
                            .retire(&primary, source == MasterKeySource::Keychain)
                        {
                            tracing::error!(
                                "could not retire the mismatched master key: {error:#}"
                            );
                        }
                    }
                    write_kcv_record(&inputs.dir, &kcv_hex(&key), &kind.name())?;
                    let health = MasterKeyHealth::RecoveredFrom(kind.name());
                    let mut retired = retired_keys(&key);
                    if !retired.contains(&primary) {
                        retired.push(primary);
                    }
                    Ok(Resolution {
                        key,
                        source: kind.custody(),
                        retired,
                        health,
                    })
                }
            }
        }
    }
}

// ── Host-backed entry points ─────────────────────────────────────────────────

fn keychain_disabled() -> bool {
    matches!(
        std::env::var(ENV_KEYCHAIN),
        Ok(value) if value.trim().eq_ignore_ascii_case("off")
    )
}

/// Run `f` with the production inputs for `host`.
fn with_host_inputs<T>(
    host: &dyn CryptoHost,
    f: impl FnOnce(&CustodyInputs<'_>) -> Result<T>,
) -> Result<T> {
    let dir = host.ryu_dir();
    let account = format!("{KEYRING_ACCOUNT}{}", host.keyring_account_suffix());
    let env_value = std::env::var(ENV_MASTER_KEY)
        .ok()
        .filter(|v| !v.trim().is_empty());
    let disabled = keychain_disabled();
    if !cfg!(feature = "os-keychain") {
        crate::require_explicit_custody_without_keychain(env_value.is_some(), disabled)?;
    }
    let os_keychain = OsKeychain {
        account: account.clone(),
    };
    let disabled_keychain = DisabledKeychain;
    let keychain: &dyn Keychain = if disabled {
        &disabled_keychain
    } else {
        &os_keychain
    };
    let keychain_enabled = !disabled && cfg!(feature = "os-keychain");
    let probe = |cipher: &FieldCipher| host.probe_master_key(cipher);
    let evidence = || host_sealed_evidence(host, &dir);
    let inputs = CustodyInputs {
        dir: dir.clone(),
        env_value,
        keychain,
        keychain_enabled,
        paths: crate::default_key_paths(host),
        allow_file: host.allow_file_key(),
        records_kcv: host.records_kcv(),
        vault: RetiredVault::production(dir.clone(), account, keychain_enabled),
        probe: &probe,
        sealed_evidence: &evidence,
    };
    f(&inputs)
}

fn host_sealed_evidence(host: &dyn CryptoHost, dir: &Path) -> Option<String> {
    if let Some(reason) = host.sealed_data_evidence() {
        return Some(reason);
    }
    if !read_retired_index(dir).unwrap_or_default().is_empty() {
        return Some("retired master keys are recorded".to_owned());
    }
    #[cfg(feature = "sqlite")]
    {
        let stores = crate::content_sqlite::recorded_store_kcvs(&layout::db_dir(dir));
        if let Some((store, _)) = stores.first() {
            return Some(format!("{store} records a sealing key"));
        }
    }
    None
}

static RESOLVE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve the master key for the installed host (used by `global_cipher`).
pub(crate) fn resolve_for_host(host: &dyn CryptoHost) -> Result<Resolution> {
    let _guard = RESOLVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    with_host_inputs(host, resolve)
}

/// One candidate as `keys status` shows it (never key material).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateReport {
    /// Where it comes from.
    pub source: KeySourceKind,
    /// Its key check value.
    pub kcv: String,
    /// Whether it matches the recorded key check value.
    pub matches_recorded: bool,
}

/// Read-only description of master-key custody for `ryu-core keys status`.
#[derive(Clone, Debug)]
pub struct MasterKeyReport {
    /// The data folder.
    pub data_dir: PathBuf,
    /// The recorded key check value, if any.
    pub recorded: Option<KcvRecord>,
    /// Every candidate key the data folder can see.
    pub candidates: Vec<CandidateReport>,
    /// The retired-key index.
    pub retired: Vec<RetiredEntry>,
    /// The data-format marker, if any.
    pub data_format: Option<DataFormat>,
    /// Whether the keychain is reachable in this process.
    pub keychain_enabled: bool,
    /// Health of this process's resolution (if it resolved).
    pub health: MasterKeyHealth,
}

/// Describe custody without resolving or changing anything.
pub fn master_key_report() -> Result<MasterKeyReport> {
    let host = crate::host()?;
    master_key_report_for(&*host)
}

/// [`master_key_report`] for an explicit host (its data folder and keychain
/// account) instead of the installed one. Read-only.
pub fn master_key_report_for(host: &dyn CryptoHost) -> Result<MasterKeyReport> {
    with_host_inputs(host, |inputs| {
        let recorded = read_kcv_record(&inputs.dir)?;
        let candidates = candidates(inputs)
            .into_iter()
            .map(|(source, key)| {
                let kcv = kcv_hex(&key);
                CandidateReport {
                    matches_recorded: recorded.as_ref().is_some_and(|r| r.kcv == kcv),
                    source,
                    kcv,
                }
            })
            .collect();
        Ok(MasterKeyReport {
            data_dir: inputs.dir.clone(),
            recorded,
            candidates,
            retired: read_retired_index(&inputs.dir)?,
            data_format: read_data_format(&inputs.dir)?,
            keychain_enabled: inputs.keychain_enabled,
            health: master_key_health(),
        })
    })
}

/// Which candidate `keys adopt` makes current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdoptFrom {
    /// `RYU_MASTER_KEY` of this process.
    Env,
    /// The keychain slot.
    Keychain,
    /// `secrets/master.key`.
    File,
    /// A retired key, by KCV.
    Retired(String),
}

/// What an adopt or import did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptOutcome {
    /// Key check value now recorded as current.
    pub kcv: String,
    /// Custody it was stored in (`keychain` or `file`).
    pub custody: String,
    /// Key check value of the previous key, now retired (if it changed).
    pub retired: Option<String>,
}

fn candidate_key(inputs: &CustodyInputs<'_>, from: &AdoptFrom) -> Result<[u8; KEY_LEN]> {
    let wanted = match from {
        AdoptFrom::Env => KeySourceKind::Env,
        AdoptFrom::Keychain => KeySourceKind::Keychain,
        AdoptFrom::File => KeySourceKind::File,
        AdoptFrom::Retired(kcv) => KeySourceKind::Retired(kcv.clone()),
    };
    candidates(inputs)
        .into_iter()
        .find(|(kind, _)| *kind == wanted)
        .map(|(_, key)| key)
        .ok_or_else(|| anyhow!("no {} key is available", wanted.name()))
}

/// The key currently in persistent custody (keychain first, then file).
fn persistent_key(inputs: &CustodyInputs<'_>) -> Option<([u8; KEY_LEN], MasterKeySource)> {
    if let KeychainState::Key(key) = inputs.keychain.get() {
        return Some((key, MasterKeySource::Keychain));
    }
    read_key_file(&inputs.paths.master)
        .ok()
        .flatten()
        .map(|key| (key, MasterKeySource::File))
}

/// The key whose KCV this folder records as current, from any live candidate
/// slot (env included). `None` when nothing is recorded or no slot holds it.
fn recorded_current_key(inputs: &CustodyInputs<'_>) -> Result<Option<[u8; KEY_LEN]>> {
    let Some(record) = read_kcv_record(&inputs.dir)? else {
        return Ok(None);
    };
    Ok(candidates(inputs)
        .into_iter()
        .find(|(kind, key)| {
            !matches!(kind, KeySourceKind::Retired(_)) && kcv_hex(key) == record.kcv
        })
        .map(|(_, key)| key))
}

/// Make `key` the persistent current key: retire the previous persistent key
/// (and add `extra_retired`) first, then store `key` (keychain with read-back
/// when reachable, else the `0600` file), then record its KCV.
fn install_current(
    inputs: &CustodyInputs<'_>,
    key: &[u8; KEY_LEN],
    extra_retired: &[[u8; KEY_LEN]],
) -> Result<AdoptOutcome> {
    let kcv = kcv_hex(key);
    let previous = persistent_key(inputs);
    let recorded_key = recorded_current_key(inputs)?;
    let existing = read_retired_index(&inputs.dir)?;
    let mut to_retire: Vec<[u8; KEY_LEN]> = Vec::new();
    if let Some((old, _)) = &previous {
        if old != key {
            to_retire.push(*old);
        }
    }
    // The folder's recorded current key may live somewhere `persistent_key` does
    // not look (`RYU_MASTER_KEY`, or the file while the keychain holds a stale
    // key). Retire it too, so what it sealed stays readable. The vault keeps its
    // own copy, so retiring an env-sourced key is fine.
    if let Some(recorded) = &recorded_key {
        if recorded != key && !to_retire.contains(recorded) {
            to_retire.push(*recorded);
        }
    }
    for extra in extra_retired {
        if extra != key && !to_retire.contains(extra) {
            to_retire.push(*extra);
        }
    }
    let new_entries = to_retire
        .iter()
        .filter(|candidate| !existing.iter().any(|entry| entry.kcv == kcv_hex(candidate)))
        .count();
    if existing.len() + new_entries > MAX_RETIRED_KEYS {
        bail!(
            "adopting this key would retire more than {MAX_RETIRED_KEYS} keys; import into a new \
             profile instead"
        );
    }
    let prefer_keychain = inputs.keychain_enabled;
    for old in &to_retire {
        inputs.vault.retire(old, prefer_keychain)?;
    }
    let mut custody = "file";
    if inputs.keychain_enabled
        && inputs.keychain.store(key)
        && matches!(inputs.keychain.get(), KeychainState::Key(back) if back == *key)
    {
        custody = "keychain";
    }
    if custody == "file" {
        if !inputs.allow_file {
            bail!("the keychain is unavailable and this host does not allow a key file");
        }
        let path = &inputs.paths.master;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_atomic(path, b64().encode(key).as_bytes(), true)?;
    }
    write_kcv_record(&inputs.dir, &kcv, custody)?;
    Ok(AdoptOutcome {
        kcv,
        custody: custody.to_owned(),
        retired: recorded_key
            .filter(|recorded| recorded != key)
            .or_else(|| previous.map(|(old, _)| old).filter(|old| old != key))
            .map(|old| kcv_hex(&old)),
    })
}

fn adopt_with(
    inputs: &CustodyInputs<'_>,
    from: &AdoptFrom,
    accept_unreadable: bool,
) -> Result<AdoptOutcome> {
    let key = candidate_key(inputs, from)?;
    let recorded = read_kcv_record(&inputs.dir)?;
    if recorded.as_ref().map(|r| r.kcv.as_str()) != Some(kcv_hex(&key).as_str())
        && (inputs.probe)(&FieldCipher::new(&key)) == KeyProbe::Failed
    {
        if !accept_unreadable {
            bail!(
                "the {} key does not open this data folder's sealed messages; refusing to adopt \
                 it (add --accept-unreadable to adopt it anyway and leave the messages it cannot \
                 open unreadable)",
                from_name(from)
            );
        }
        tracing::warn!(
            "adopting the {} key although it opens none of the sampled sealed messages \
             (--accept-unreadable)",
            from_name(from)
        );
    }
    install_current(inputs, &key, &[])
}

fn from_name(from: &AdoptFrom) -> String {
    match from {
        AdoptFrom::Env => "env".to_owned(),
        AdoptFrom::Keychain => "keychain".to_owned(),
        AdoptFrom::File => "file".to_owned(),
        AdoptFrom::Retired(kcv) => format!("retired {kcv}"),
    }
}

/// `ryu-core keys adopt --from <source>`: make a candidate the current key after
/// a KCV/probe check, retiring the previous one. Run with Core stopped. With
/// `accept_unreadable` (`--accept-unreadable`) a key the probe rejects is
/// adopted anyway: the way back for a folder whose sampled messages are sealed
/// under a key that is gone; those messages stay unreadable.
pub fn adopt_master_key(from: &AdoptFrom, accept_unreadable: bool) -> Result<AdoptOutcome> {
    let host = crate::host()?;
    let _guard = RESOLVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    with_host_inputs(&*host, |inputs| adopt_with(inputs, from, accept_unreadable))
}

fn retire_with(inputs: &CustodyInputs<'_>, kcv: &str) -> Result<RetiredEntry> {
    let recorded = read_kcv_record(&inputs.dir)?;
    if recorded.as_ref().is_some_and(|record| record.kcv == kcv) {
        bail!("{kcv} is the current key of this data folder; adopt another key first");
    }
    let (kind, key) = candidates(inputs)
        .into_iter()
        .find(|(kind, key)| kcv_hex(key) == kcv && !matches!(kind, KeySourceKind::Retired(_)))
        .ok_or_else(|| anyhow!("no candidate key has key check value {kcv}"))?;
    if kind == KeySourceKind::Keychain {
        bail!("the keychain slot holds {kcv}; use `keys adopt` to replace it");
    }
    let entry = inputs.vault.retire(&key, inputs.keychain_enabled)?;
    // A retired file or legacy key no longer sits in a candidate slot.
    let slot = match kind {
        KeySourceKind::File => Some(&inputs.paths.master),
        KeySourceKind::LegacyMemory => Some(&inputs.paths.legacy_memory),
        _ => None,
    };
    if let Some(path) = slot {
        if inputs.vault.load(&entry).map(|k| k == key).unwrap_or(false) {
            std::fs::remove_file(path)
                .with_context(|| format!("removing the retired key file {}", path.display()))?;
        }
    }
    Ok(entry)
}

/// `ryu-core keys retire <kcv>`: move a non-current candidate key into the
/// retired set. Refuses the current key.
pub fn retire_master_key(kcv: &str) -> Result<RetiredEntry> {
    let host = crate::host()?;
    let _guard = RESOLVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    with_host_inputs(&*host, |inputs| retire_with(inputs, kcv))
}

// ── Key bundle for data-folder export/import ─────────────────────────────────

#[derive(Serialize, Deserialize)]
struct KeyBundle {
    v: u32,
    kcv: String,
    current: String,
    retired: Vec<String>,
}

/// Seal the current master key, the retired keys and the KCV into one value
/// for a passphrase-encrypted data-folder export. Host-only: never expose it
/// through plugin crypto, HTTP or logs.
pub fn seal_key_bundle(wrapping_cipher: &FieldCipher) -> Result<String> {
    let _ = crate::global_cipher()?;
    let (current, retired) = crate::resolved_master_and_retired()?;
    let bundle = KeyBundle {
        v: 1,
        kcv: kcv_hex(&current),
        current: b64().encode(current),
        retired: retired.iter().map(|key| b64().encode(key)).collect(),
    };
    wrapping_cipher.seal(&serde_json::to_string(&bundle)?)
}

fn open_bundle(
    wrapping_cipher: &FieldCipher,
    sealed: &str,
) -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    let bundle: KeyBundle = serde_json::from_str(&wrapping_cipher.open(sealed)?)
        .context("parsing the exported key bundle")?;
    let current = decode_key(&bundle.current).ok_or_else(|| anyhow!("bundle key is malformed"))?;
    if kcv_hex(&current) != bundle.kcv {
        bail!("bundle key does not match its key check value");
    }
    let retired = bundle
        .retired
        .iter()
        .map(|key| decode_key(key).ok_or_else(|| anyhow!("bundle retired key is malformed")))
        .collect::<Result<Vec<_>>>()?;
    Ok((current, retired))
}

fn import_with(
    inputs: &CustodyInputs<'_>,
    current: [u8; KEY_LEN],
    retired: &[[u8; KEY_LEN]],
) -> Result<AdoptOutcome> {
    // A key from `RYU_MASTER_KEY` is never written to disk, so adopting another
    // key would strand the data the target sealed under it: Core would refuse to
    // boot with the env key, and unsetting it would lose that key for good. Refuse
    // before anything is written, unless the bundle itself retires the env key.
    if let Some(env_key) = inputs.env_value.as_deref().and_then(decode_key) {
        if env_key != current && !retired.contains(&env_key) {
            bail!(
                "{ENV_MASTER_KEY} is set to a different key than the backup's; set it to the \
                 backup key (key check value {}) or import into a new data folder",
                kcv_hex(&current)
            );
        }
    }
    let recorded = read_kcv_record(&inputs.dir)?;
    // Already current: the record names this key and a live slot (env included)
    // holds it. Nothing is written, so an env-supplied key never reaches the
    // keychain or a key file.
    if recorded
        .as_ref()
        .is_some_and(|r| r.kcv == kcv_hex(&current))
        && candidates(inputs).iter().any(|(kind, key)| {
            matches!(
                kind,
                KeySourceKind::Env | KeySourceKind::Keychain | KeySourceKind::File
            ) && *key == current
        })
    {
        let custody = recorded.map(|r| r.custody).unwrap_or_default();
        for key in retired {
            if *key != current {
                inputs.vault.retire(key, inputs.keychain_enabled)?;
            }
        }
        return Ok(AdoptOutcome {
            kcv: kcv_hex(&current),
            custody,
            retired: None,
        });
    }
    install_current(inputs, &current, retired)
}

/// Import an exported key bundle into this data folder (Core stopped): when the
/// archive key differs from the target's, it becomes the current key and the
/// target's previous key is retired, so data the target sealed stays readable.
/// Refuses only when the retired set would overflow or a key is unreadable.
pub fn import_key_bundle(wrapping_cipher: &FieldCipher, sealed: &str) -> Result<AdoptOutcome> {
    let (current, retired) = open_bundle(wrapping_cipher, sealed)?;
    let host = crate::host()?;
    let _guard = RESOLVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    with_host_inputs(&*host, |inputs| import_with(inputs, current, &retired))
}

/// Decode the contents of a key file (`secrets/master.key`,
/// `secrets/memory.key`): base64 of 32 bytes. `None` when malformed.
pub fn decode_key_file(contents: &str) -> Option<[u8; KEY_LEN]> {
    crate::decode_key(contents)
}

/// Seal `current` and `retired` as a key bundle (the value
/// [`import_key_bundle`] and [`open_key_bundle`] read). Used where the keys
/// come from somewhere other than this process's custody, such as the raw key
/// files of an older data backup. Host-only, like [`seal_key_bundle`].
pub fn seal_raw_key_bundle(
    wrapping_cipher: &FieldCipher,
    current: &[u8; KEY_LEN],
    retired: &[[u8; KEY_LEN]],
) -> Result<String> {
    let bundle = KeyBundle {
        v: 1,
        kcv: kcv_hex(current),
        current: b64().encode(current),
        retired: retired
            .iter()
            .filter(|key| *key != current)
            .map(|key| b64().encode(key))
            .collect(),
    };
    wrapping_cipher.seal(&serde_json::to_string(&bundle)?)
}

/// Open a sealed key bundle: the current key and the retired keys.
pub fn open_key_bundle(
    wrapping_cipher: &FieldCipher,
    sealed: &str,
) -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    open_bundle(wrapping_cipher, sealed)
}

/// Write `current` and `retired` into the FILE custody of the data folder at
/// `dir`, which this process does not run on (a recovered node backup, booted
/// with `RYU_KEYCHAIN=off`): `secrets/master.key`, one
/// `secrets/retired/<kcv>.key` per retired key (`0600` in `0700` dirs), a
/// retired-key index listing exactly those keys in file custody (keeping each
/// one's original retirement time), and the key check value record.
pub fn install_file_custody(
    dir: &Path,
    current: &[u8; KEY_LEN],
    retired: &[[u8; KEY_LEN]],
) -> Result<()> {
    let secrets = layout::secrets_dir(dir);
    std::fs::create_dir_all(&secrets).with_context(|| format!("creating {}", secrets.display()))?;
    restrict_dir(&secrets);
    let previous = read_retired_index(dir).unwrap_or_default();
    let mut entries: Vec<RetiredEntry> = Vec::new();
    for key in retired {
        let kcv = kcv_hex(key);
        if key == current || entries.iter().any(|entry| entry.kcv == kcv) {
            continue;
        }
        if entries.len() >= MAX_RETIRED_KEYS {
            bail!("the backup carries more than {MAX_RETIRED_KEYS} retired keys");
        }
        let path = retired_key_path(dir, &kcv);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
            restrict_dir(parent);
        }
        write_atomic(&path, b64().encode(key).as_bytes(), true)?;
        let retired_at = previous
            .iter()
            .find(|entry| entry.kcv == kcv)
            .map_or_else(now_secs, |entry| entry.retired_at);
        entries.push(RetiredEntry {
            kcv,
            custody: "file".to_owned(),
            retired_at,
        });
    }
    write_retired_index(dir, &entries)?;
    write_atomic(
        &layout::secret_path(dir, "master.key"),
        b64().encode(current).as_bytes(),
        true,
    )?;
    write_kcv_record(dir, &kcv_hex(current), "file")
}

/// Carry the keychain-custody retired keys of the data folder `from_dir` from
/// profile `from_suffix` to profile `to_suffix` (account
/// `master-key{suffix}:retired:<kcv>`), so a profile copy keeps opening values
/// sealed under keys the source had retired. File-custody retired keys travel
/// with the folder under `secrets/retired/`. Returns how many keys were copied.
///
/// Fails without changing anything else when the keychain cannot be read or
/// written, or the target profile already holds a different key at one of
/// those slots. A retired entry whose key the source keychain no longer holds is
/// skipped: the source cannot open it either, so the copy loses nothing.
/// Idempotent: a slot that already holds the same key is left as it is.
pub fn copy_retired_keys_between_profiles(
    from_dir: &Path,
    from_suffix: &str,
    to_suffix: &str,
) -> Result<usize> {
    let slot = |account: &str| -> Box<dyn Keychain> {
        Box::new(OsKeychain {
            account: account.to_owned(),
        })
    };
    copy_retired_keys_with(
        from_dir,
        &format!("{KEYRING_ACCOUNT}{from_suffix}"),
        &format!("{KEYRING_ACCOUNT}{to_suffix}"),
        &slot,
    )
}

fn copy_retired_keys_with(
    from_dir: &Path,
    from_base: &str,
    to_base: &str,
    slot: &dyn Fn(&str) -> Box<dyn Keychain>,
) -> Result<usize> {
    let mut copied = 0;
    for entry in read_retired_index(from_dir)? {
        if entry.custody != "keychain" {
            continue;
        }
        let key = match slot(&format!("{from_base}:retired:{}", entry.kcv)).get() {
            KeychainState::Key(key) if key_check_value(&key) == entry.kcv => key,
            KeychainState::Key(_) | KeychainState::Empty => {
                tracing::warn!(
                    kcv = %entry.kcv,
                    "retired key is not in the source profile's keychain; not copied"
                );
                continue;
            }
            KeychainState::Corrupt | KeychainState::Unavailable => bail!(
                "could not read retired key {} from the source profile's keychain",
                entry.kcv
            ),
        };
        let target = slot(&format!("{to_base}:retired:{}", entry.kcv));
        match target.get() {
            KeychainState::Key(held) if held == key => continue,
            KeychainState::Key(_) => bail!(
                "the target profile already holds a different key for retired key {}",
                entry.kcv
            ),
            KeychainState::Corrupt | KeychainState::Unavailable => bail!(
                "could not read the target profile's keychain for retired key {}",
                entry.kcv
            ),
            KeychainState::Empty => {}
        }
        if !target.store(&key) || !matches!(target.get(), KeychainState::Key(back) if back == key) {
            bail!(
                "could not write retired key {} to the target profile's keychain",
                entry.kcv
            );
        }
        copied += 1;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    /// A mutable in-memory keychain.
    #[derive(Clone)]
    struct MemKeychain {
        slot: Rc<RefCell<Option<[u8; KEY_LEN]>>>,
        reachable: Rc<RefCell<bool>>,
    }

    impl MemKeychain {
        fn new(key: Option<[u8; KEY_LEN]>, reachable: bool) -> Self {
            Self {
                slot: Rc::new(RefCell::new(key)),
                reachable: Rc::new(RefCell::new(reachable)),
            }
        }
        fn held(&self) -> Option<[u8; KEY_LEN]> {
            *self.slot.borrow()
        }
    }

    impl Keychain for MemKeychain {
        fn get(&self) -> KeychainState {
            if !*self.reachable.borrow() {
                return KeychainState::Unavailable;
            }
            match *self.slot.borrow() {
                Some(key) => KeychainState::Key(key),
                None => KeychainState::Empty,
            }
        }
        fn store(&self, key: &[u8; KEY_LEN]) -> bool {
            if !*self.reachable.borrow() {
                return false;
            }
            *self.slot.borrow_mut() = Some(*key);
            true
        }
    }

    struct World {
        dir: tempfile::TempDir,
        keychain: MemKeychain,
        retired_slots: Rc<RefCell<HashMap<String, MemKeychain>>>,
        env: Option<String>,
        records_kcv: bool,
        probe_key: Option<[u8; KEY_LEN]>,
        /// Probe a real `conversations.db` instead of `probe_key`.
        #[cfg(feature = "sqlite")]
        probe_db: Option<PathBuf>,
        evidence: Option<String>,
    }

    impl World {
        fn new(keychain: MemKeychain) -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
                keychain,
                retired_slots: Rc::new(RefCell::new(HashMap::new())),
                env: None,
                records_kcv: true,
                probe_key: None,
                #[cfg(feature = "sqlite")]
                probe_db: None,
                evidence: None,
            }
        }

        fn paths(&self) -> KeyPaths {
            KeyPaths {
                master: layout::secret_path(self.dir.path(), "master.key"),
                legacy_memory: layout::secret_path(self.dir.path(), "memory.key"),
            }
        }

        fn write_file_key(&self, key: [u8; KEY_LEN]) {
            write_key_file(&self.paths().master, &key).unwrap();
        }

        fn run<T>(&self, f: impl FnOnce(&CustodyInputs<'_>) -> T) -> T {
            let probe_key = self.probe_key;
            #[cfg(feature = "sqlite")]
            let probe_db = self.probe_db.clone();
            let probe = move |cipher: &FieldCipher| {
                #[cfg(feature = "sqlite")]
                if let Some(db) = &probe_db {
                    return crate::content_sqlite::probe_sealed_messages(db, cipher);
                }
                probe_with_key(probe_key, cipher)
            };
            let evidence_value = self.evidence.clone();
            let evidence = move || evidence_value.clone();
            let slots = self.retired_slots.clone();
            let reachable = self.keychain.reachable.clone();
            let vault = RetiredVault {
                dir: self.dir.path().to_path_buf(),
                account_base: "master-key-test".to_owned(),
                keychain_enabled: *self.keychain.reachable.borrow(),
                keychain_for: Box::new(move |account: &str| -> Box<dyn Keychain> {
                    let mut slots = slots.borrow_mut();
                    let slot = slots
                        .entry(account.to_owned())
                        .or_insert_with(|| MemKeychain {
                            slot: Rc::new(RefCell::new(None)),
                            reachable: reachable.clone(),
                        })
                        .clone();
                    Box::new(slot)
                }),
            };
            let inputs = CustodyInputs {
                dir: self.dir.path().to_path_buf(),
                env_value: self.env.clone(),
                keychain: &self.keychain,
                keychain_enabled: *self.keychain.reachable.borrow(),
                paths: self.paths(),
                allow_file: true,
                records_kcv: self.records_kcv,
                vault,
                probe: &probe,
                sealed_evidence: &evidence,
            };
            f(&inputs)
        }

        fn resolve(&self) -> Result<Resolution> {
            self.run(resolve)
        }

        fn recorded(&self) -> Option<String> {
            read_kcv_record(self.dir.path()).unwrap().map(|r| r.kcv)
        }
    }

    fn probe_with_key(probe_key: Option<[u8; KEY_LEN]>, cipher: &FieldCipher) -> KeyProbe {
        match probe_key {
            None => KeyProbe::NoSealedData,
            Some(right) => {
                let sealed = FieldCipher::new(&right).seal("probe").unwrap();
                if cipher.open(&sealed).is_ok() {
                    KeyProbe::Passed
                } else {
                    KeyProbe::Failed
                }
            }
        }
    }

    const A: [u8; KEY_LEN] = [0xA; KEY_LEN];
    const B: [u8; KEY_LEN] = [0xB; KEY_LEN];
    const C: [u8; KEY_LEN] = [0xC; KEY_LEN];

    #[test]
    fn profile_copy_carries_keychain_retired_keys_to_the_target_profile() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.run(|inputs| inputs.vault.retire(&B, true).unwrap());
        let slots = world.retired_slots.clone();
        let slot = |account: &str| -> Box<dyn Keychain> {
            let mut slots = slots.borrow_mut();
            Box::new(
                slots
                    .entry(account.to_owned())
                    .or_insert_with(|| MemKeychain::new(None, true))
                    .clone(),
            )
        };
        // Before the copy the target profile cannot load the retired key its
        // copied index names.
        let target_vault = |slots: Rc<RefCell<HashMap<String, MemKeychain>>>| RetiredVault {
            dir: world.dir.path().to_path_buf(),
            account_base: "master-key-copy".to_owned(),
            keychain_enabled: true,
            keychain_for: Box::new(move |account: &str| -> Box<dyn Keychain> {
                let mut slots = slots.borrow_mut();
                Box::new(
                    slots
                        .entry(account.to_owned())
                        .or_insert_with(|| MemKeychain::new(None, true))
                        .clone(),
                )
            }),
        };
        assert!(target_vault(world.retired_slots.clone())
            .load_all()
            .is_empty());

        let copied = copy_retired_keys_with(
            world.dir.path(),
            "master-key-test",
            "master-key-copy",
            &slot,
        )
        .unwrap();
        assert_eq!(copied, 1);
        let loaded = target_vault(world.retired_slots.clone()).load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1, B);
        // Idempotent.
        assert_eq!(
            copy_retired_keys_with(
                world.dir.path(),
                "master-key-test",
                "master-key-copy",
                &slot
            )
            .unwrap(),
            0
        );

        // A different key already at the target slot, or a target keychain that
        // cannot be written, refuses the copy.
        let kcv = key_check_value(&B);
        world.retired_slots.borrow_mut().insert(
            format!("master-key-other:retired:{kcv}"),
            MemKeychain::new(Some(C), true),
        );
        assert!(copy_retired_keys_with(
            world.dir.path(),
            "master-key-test",
            "master-key-other",
            &slot
        )
        .is_err());
        world.retired_slots.borrow_mut().insert(
            format!("master-key-down:retired:{kcv}"),
            MemKeychain::new(None, false),
        );
        assert!(copy_retired_keys_with(
            world.dir.path(),
            "master-key-test",
            "master-key-down",
            &slot
        )
        .is_err());
    }

    #[test]
    fn kcv_matches_the_vector_layout() {
        assert_eq!(key_check_value(&[7; KEY_LEN]).len(), 32);
        assert_ne!(key_check_value(&A), key_check_value(&B));
    }

    #[test]
    fn a_fresh_folder_generates_once_and_records_the_kcv() {
        let world = World::new(MemKeychain::new(None, true));
        let first = world.resolve().unwrap();
        assert_eq!(first.source, MasterKeySource::Keychain);
        assert_eq!(world.recorded(), Some(key_check_value(&first.key)));
        let second = world.resolve().unwrap();
        assert_eq!(first.key, second.key);
    }

    #[test]
    fn unavailable_then_empty_adopts_the_file_key() {
        // Headless period: keychain unavailable, a file key is created.
        let world = World::new(MemKeychain::new(None, false));
        let headless = world.resolve().unwrap();
        assert_eq!(headless.source, MasterKeySource::File);
        // The keychain becomes reachable but empty: the file key is adopted,
        // never replaced by a fresh one.
        *world.keychain.reachable.borrow_mut() = true;
        let adopted = world.resolve().unwrap();
        assert_eq!(adopted.key, headless.key);
        assert_eq!(adopted.source, MasterKeySource::Keychain);
        assert_eq!(world.keychain.held(), Some(headless.key));
        assert!(world.paths().master.exists(), "the file is kept");
    }

    #[test]
    fn a_kcv_recorded_after_adopting_a_key_file_names_file_custody() {
        let world = World::new(MemKeychain::new(None, true));
        world.write_file_key(A);
        let adopted = world.resolve().unwrap();
        assert_eq!(adopted.key, A);
        assert_eq!(world.keychain.held(), Some(A));
        assert!(world.paths().master.exists(), "the file copy is kept");
        let record = read_kcv_record(world.dir.path()).unwrap().unwrap();
        assert_eq!(record.kcv, key_check_value(&A));
        assert_eq!(
            record.custody, "file",
            "a key that still sits in secrets/ is not keychain custody"
        );
    }

    #[test]
    fn unavailable_with_a_kcv_and_no_file_refuses() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        *world.keychain.reachable.borrow_mut() = false;
        let error = world.resolve().err().expect("must refuse");
        assert!(error.to_string().contains("keychain"), "{error:#}");
        assert!(!world.paths().master.exists(), "no key file generated");
    }

    #[test]
    fn empty_with_a_kcv_refuses_to_generate() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        *world.keychain.slot.borrow_mut() = None;
        let error = world.resolve().err().expect("must refuse");
        assert!(
            error.to_string().contains("not in the keychain"),
            "{error:#}"
        );
        assert_eq!(world.keychain.held(), None, "nothing generated");
    }

    #[test]
    fn sealed_store_evidence_alone_blocks_generation() {
        let mut world = World::new(MemKeychain::new(None, true));
        world.evidence = Some("conversations.db holds sealed messages".to_owned());
        let error = world.resolve().err().expect("must refuse");
        assert!(error.to_string().contains("sealed messages"), "{error:#}");
        assert_eq!(world.keychain.held(), None);
    }

    #[test]
    fn an_env_key_that_differs_from_the_recorded_kcv_is_refused() {
        let mut world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        world.env = Some(b64().encode(B));
        let error = world.resolve().err().expect("must refuse");
        assert!(error.to_string().contains(ENV_MASTER_KEY), "{error:#}");
        assert!(error.downcast_ref::<KeyMismatch>().is_some());
        // The matching env key is accepted.
        world.env = Some(b64().encode(A));
        assert_eq!(world.resolve().unwrap().key, A);
    }

    #[test]
    fn a_mismatch_picks_the_matching_candidate_and_retires_the_other() {
        // Data sealed under A, A lives in the file; the keychain was reseeded
        // with B (the old whole-profile-loss path).
        let world = World::new(MemKeychain::new(None, false));
        world.write_file_key(A);
        world.resolve().unwrap();
        assert_eq!(world.recorded(), Some(key_check_value(&A)));
        *world.keychain.reachable.borrow_mut() = true;
        *world.keychain.slot.borrow_mut() = Some(B);
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert!(resolution.retired.contains(&B));
        let retired = read_retired_index(world.dir.path()).unwrap();
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].kcv, key_check_value(&B));
        assert_eq!(
            resolution.health,
            MasterKeyHealth::RecoveredFrom("file".to_owned())
        );
        // Anything sealed under B during the incident still opens (retired).
        let sealed_b = FieldCipher::new(&B).seal("mixed").unwrap();
        let cipher = FieldCipher::new(&resolution.key).with_retired(&resolution.retired);
        let opened = cipher.open_detailed(&sealed_b).unwrap();
        assert_eq!(opened.value, "mixed");
        assert!(opened.needs_reseal);
        // A later run with only the retired copy and the file still works.
        assert_eq!(world.resolve().unwrap().key, A);
    }

    #[test]
    fn no_matching_candidate_fails_closed() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        *world.keychain.slot.borrow_mut() = Some(B);
        let error = world.resolve().err().expect("must refuse");
        assert!(error.to_string().contains("does not match"), "{error:#}");
        assert!(error.downcast_ref::<KeyMismatch>().is_some());
    }

    #[test]
    fn the_probe_blocks_a_wrong_key_from_writing_a_kcv() {
        let mut world = World::new(MemKeychain::new(Some(B), true));
        world.probe_key = Some(A);
        let error = world.resolve().err().expect("must refuse");
        assert!(error.to_string().contains("does not open"), "{error:#}");
        assert_eq!(world.recorded(), None);
        // With the right key on disk too, the probe recovers it.
        world.write_file_key(A);
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert_eq!(world.recorded(), Some(key_check_value(&A)));
        assert!(resolution.retired.contains(&B));
    }

    #[test]
    fn retired_keys_open_enc_v1_and_encb_v1_with_needs_reseal() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        world.run(|inputs| inputs.vault.retire(&C, true)).unwrap();
        let resolution = world.resolve().unwrap();
        assert!(resolution.retired.contains(&C));
        let field = FieldCipher::new(&resolution.key).with_retired(&resolution.retired);
        let opened = field
            .open_detailed(&FieldCipher::new(&C).seal("old field").unwrap())
            .unwrap();
        assert!(opened.needs_reseal);
        assert_eq!(
            field
                .open(&FieldCipher::new(&C).seal("x").unwrap())
                .unwrap(),
            "x"
        );
        let content = crate::ContentCipher::from_root(&resolution.key, "t.db")
            .with_retired_roots(&resolution.retired);
        let ctx = crate::ContentContext::for_id("t.c", 1);
        let sealed = crate::ContentCipher::from_root(&C, "t.db")
            .seal_text("old content", &ctx)
            .unwrap();
        let opened = content.open_text(&sealed, &ctx).unwrap();
        assert_eq!(opened.value, "old content");
        assert!(opened.needs_reseal);
        // Retired keys under keychain custody live in their own accounts.
        assert!(world
            .retired_slots
            .borrow()
            .keys()
            .any(|account| account.ends_with(&key_check_value(&C))));
    }

    #[test]
    fn the_retired_set_is_capped() {
        let world = World::new(MemKeychain::new(Some(A), false));
        for n in 1..=MAX_RETIRED_KEYS as u8 {
            world
                .run(|inputs| inputs.vault.retire(&[n; KEY_LEN], false))
                .unwrap();
        }
        let error = world
            .run(|inputs| inputs.vault.retire(&[99; KEY_LEN], false))
            .unwrap_err();
        assert!(error.to_string().contains("full"));
        // Re-retiring a known key is idempotent.
        world
            .run(|inputs| inputs.vault.retire(&[1; KEY_LEN], false))
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = retired_key_path(world.dir.path(), &key_check_value(&[1; KEY_LEN]));
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn adopt_switches_custody_and_retires_the_previous_key() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        world.write_file_key(B);
        let outcome = world
            .run(|inputs| adopt_with(inputs, &AdoptFrom::File, false))
            .unwrap();
        assert_eq!(outcome.kcv, key_check_value(&B));
        assert_eq!(outcome.custody, "keychain");
        assert_eq!(outcome.retired, Some(key_check_value(&A)));
        assert_eq!(world.keychain.held(), Some(B));
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, B);
        assert!(resolution.retired.contains(&A));
    }

    #[test]
    fn adopt_refuses_a_key_the_probe_rejects() {
        let mut world = World::new(MemKeychain::new(Some(A), true));
        world.probe_key = Some(A);
        world.resolve().unwrap();
        world.write_file_key(B);
        assert!(world
            .run(|inputs| adopt_with(inputs, &AdoptFrom::File, false))
            .is_err());
        assert_eq!(world.keychain.held(), Some(A));
    }

    #[test]
    fn adopt_accepts_a_rejected_key_only_when_asked() {
        let mut world = World::new(MemKeychain::new(Some(A), true));
        world.probe_key = Some(A);
        world.resolve().unwrap();
        world.write_file_key(B);
        let error = world
            .run(|inputs| adopt_with(inputs, &AdoptFrom::File, false))
            .unwrap_err();
        assert!(error.to_string().contains("--accept-unreadable"), "{error}");
        let outcome = world
            .run(|inputs| adopt_with(inputs, &AdoptFrom::File, true))
            .unwrap();
        assert_eq!(outcome.kcv, key_check_value(&B));
        assert_eq!(world.recorded(), Some(key_check_value(&B)));
        assert_eq!(world.keychain.held(), Some(B));
    }

    /// `conversations.db` with `bodies` in insertion (rowid) order.
    #[cfg(feature = "sqlite")]
    fn conversations_db(dir: &Path, bodies: &[String]) -> PathBuf {
        let path = dir.join("conversations.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)")
            .unwrap();
        for (i, body) in bodies.iter().enumerate() {
            conn.execute(
                "INSERT INTO messages (id, content) VALUES (?1, ?2)",
                rusqlite::params![format!("m{i:03}"), body],
            )
            .unwrap();
        }
        path
    }

    /// An older build replaced a lost keychain key silently: the oldest
    /// messages are sealed under a key that is gone, the newer ones under the
    /// keychain key. The first resolve with key check values must keep the
    /// keychain key (the probe reads the newest bodies first), not lock the
    /// folder out.
    #[cfg(feature = "sqlite")]
    #[test]
    fn a_folder_whose_oldest_messages_use_a_lost_key_resolves_to_the_current_key() {
        let lost = FieldCipher::new(&C);
        let current = FieldCipher::new(&A);
        let mut bodies: Vec<String> = (0..5)
            .map(|i| lost.seal(&format!("old {i}")).unwrap())
            .collect();
        bodies.extend((0..4).map(|i| current.seal(&format!("new {i}")).unwrap()));
        let mut world = World::new(MemKeychain::new(Some(A), true));
        world.probe_db = Some(conversations_db(world.dir.path(), &bodies));
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert_eq!(resolution.health, MasterKeyHealth::Ok);
        assert_eq!(world.recorded(), Some(key_check_value(&A)));

        // The lost key itself would not pass on its own either way: a folder
        // whose newest messages it cannot open does not adopt it silently.
        assert_eq!(
            crate::content_sqlite::probe_sealed_messages(
                world.probe_db.as_ref().unwrap(),
                &FieldCipher::new(&B)
            ),
            KeyProbe::Failed
        );
    }

    #[test]
    fn retire_moves_a_stray_file_key_and_refuses_the_current_key() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        world.write_file_key(B);
        assert!(world
            .run(|inputs| retire_with(inputs, &key_check_value(&A)))
            .is_err());
        let entry = world
            .run(|inputs| retire_with(inputs, &key_check_value(&B)))
            .unwrap();
        assert_eq!(entry.kcv, key_check_value(&B));
        assert!(!world.paths().master.exists());
        assert!(world.resolve().unwrap().retired.contains(&B));
    }

    #[test]
    fn importing_a_bundle_into_a_fresh_install_keeps_both_keys_readable() {
        // The target generated its own key and sealed something with it.
        let world = World::new(MemKeychain::new(None, true));
        let own = world.resolve().unwrap().key;
        let outcome = world.run(|inputs| import_with(inputs, A, &[C])).unwrap();
        assert_eq!(outcome.kcv, key_check_value(&A));
        assert_eq!(outcome.retired, Some(key_check_value(&own)));
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert!(resolution.retired.contains(&own));
        assert!(resolution.retired.contains(&C));
        // Importing the same bundle again changes nothing.
        let again = world.run(|inputs| import_with(inputs, A, &[C])).unwrap();
        assert_eq!(again.retired, None);
    }

    #[test]
    fn importing_a_bundle_refuses_when_the_env_key_would_be_stranded() {
        let mut world = World::new(MemKeychain::new(None, false));
        world.env = Some(b64().encode(B));
        // The env key differs from the bundle key and is not retired by it.
        let error = world
            .run(|inputs| import_with(inputs, A, &[C]))
            .unwrap_err()
            .to_string();
        assert!(error.contains(ENV_MASTER_KEY), "{error}");
        assert_eq!(world.recorded(), None, "nothing was adopted");
        assert!(!world.paths().master.exists());
        // The bundle's own key, or a key it retires, is fine.
        world.run(|inputs| import_with(inputs, B, &[C])).unwrap();
        let mut retiring = World::new(MemKeychain::new(None, false));
        retiring.env = Some(b64().encode(B));
        retiring.run(|inputs| import_with(inputs, A, &[B])).unwrap();
    }

    #[test]
    fn importing_over_an_env_custody_folder_retires_the_env_key() {
        // The folder runs on `RYU_MASTER_KEY=B` and records B; nothing persists.
        let mut world = World::new(MemKeychain::new(None, true));
        world.env = Some(b64().encode(B));
        assert_eq!(world.resolve().unwrap().key, B);
        assert_eq!(world.recorded(), Some(key_check_value(&B)));
        // A bundle that retires B and brings A: B must land in the vault.
        let outcome = world.run(|inputs| import_with(inputs, A, &[B])).unwrap();
        assert_eq!(outcome.kcv, key_check_value(&A));
        assert_eq!(outcome.retired, Some(key_check_value(&B)));
        let retired = read_retired_index(world.dir.path()).unwrap();
        assert!(retired.iter().any(|entry| entry.kcv == key_check_value(&B)));
        // With the env var gone, the folder opens under A and still reads B.
        world.env = None;
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert!(resolution.retired.contains(&B));
    }

    #[test]
    fn re_importing_an_env_custody_folder_never_writes_the_env_key_to_disk() {
        let mut world = World::new(MemKeychain::new(None, true));
        world.env = Some(b64().encode(B));
        world.resolve().unwrap();
        let outcome = world.run(|inputs| import_with(inputs, B, &[C])).unwrap();
        assert_eq!(outcome.retired, None);
        assert!(
            !world.paths().master.exists(),
            "env key stays out of the file"
        );
        assert_eq!(
            world.keychain.held(),
            None,
            "env key stays out of the keychain"
        );
        assert_eq!(world.recorded(), Some(key_check_value(&B)));
        // The bundle's extra retired key is still kept.
        let retired = read_retired_index(world.dir.path()).unwrap();
        assert!(retired.iter().any(|entry| entry.kcv == key_check_value(&C)));
    }

    #[test]
    fn adopting_the_keychain_key_retires_the_recorded_file_key() {
        // Recovered state: the record and the file hold F, the keychain a stale A.
        let world = World::new(MemKeychain::new(None, false));
        world.write_file_key(B);
        world.resolve().unwrap();
        assert_eq!(world.recorded(), Some(key_check_value(&B)));
        *world.keychain.reachable.borrow_mut() = true;
        *world.keychain.slot.borrow_mut() = Some(A);
        let outcome = world
            .run(|inputs| adopt_with(inputs, &AdoptFrom::Keychain, false))
            .unwrap();
        assert_eq!(outcome.kcv, key_check_value(&A));
        assert_eq!(outcome.retired, Some(key_check_value(&B)));
        let retired = read_retired_index(world.dir.path()).unwrap();
        assert!(retired.iter().any(|entry| entry.kcv == key_check_value(&B)));
        assert_eq!(world.resolve().unwrap().key, A);
    }

    #[test]
    fn a_disabled_keychain_never_reads_keychain_custody_retired_keys() {
        let dir = tempfile::tempdir().unwrap();
        write_retired_index(
            dir.path(),
            &[RetiredEntry {
                kcv: key_check_value(&B),
                custody: "keychain".to_owned(),
                retired_at: 0,
            }],
        )
        .unwrap();
        let vault = RetiredVault {
            dir: dir.path().to_path_buf(),
            account_base: "master-key-test".to_owned(),
            keychain_enabled: false,
            keychain_for: Box::new(|_: &str| -> Box<dyn Keychain> {
                panic!("the keychain must not be touched when it is disabled")
            }),
        };
        assert!(vault.load_all().is_empty());
    }

    #[test]
    fn bundles_round_trip_and_refuse_tampering() {
        let wrapping = FieldCipher::new(&[1; KEY_LEN]);
        let bundle = KeyBundle {
            v: 1,
            kcv: key_check_value(&A),
            current: b64().encode(A),
            retired: vec![b64().encode(C)],
        };
        let sealed = wrapping
            .seal(&serde_json::to_string(&bundle).unwrap())
            .unwrap();
        let (current, retired) = open_bundle(&wrapping, &sealed).unwrap();
        assert_eq!(current, A);
        assert_eq!(retired, vec![C]);
        let bad = KeyBundle {
            kcv: key_check_value(&B),
            ..bundle
        };
        let sealed = wrapping
            .seal(&serde_json::to_string(&bad).unwrap())
            .unwrap();
        assert!(open_bundle(&wrapping, &sealed).is_err());
    }

    #[test]
    fn the_data_format_marker_refuses_newer_folders() {
        let dir = tempfile::tempdir().unwrap();
        check_data_format(dir.path()).unwrap();
        write_data_format(dir.path()).unwrap();
        assert_eq!(
            read_data_format(dir.path()).unwrap(),
            Some(DataFormat {
                format: DATA_FORMAT,
                min_reader: SUPPORTED_MIN_READER
            })
        );
        write_atomic(
            &data_format_path(dir.path()),
            br#"{"format":3,"min_reader":3}"#,
            false,
        )
        .unwrap();
        let error = check_data_format(dir.path()).unwrap_err();
        assert!(error.to_string().contains("newer Ryu"));
        // A newer marker is never lowered.
        assert!(write_data_format(dir.path()).is_err());
        let world = World::new(MemKeychain::new(Some(A), true));
        write_atomic(
            &data_format_path(world.dir.path()),
            br#"{"format":3,"min_reader":3}"#,
            false,
        )
        .unwrap();
        assert!(world.resolve().is_err());
    }

    #[test]
    fn hosts_that_do_not_record_kcvs_never_write_one() {
        let mut world = World::new(MemKeychain::new(Some(A), true));
        world.records_kcv = false;
        world.resolve().unwrap();
        assert_eq!(world.recorded(), None);
    }

    #[test]
    fn a_ladder_refusal_still_recovers_from_a_matching_retired_key() {
        let world = World::new(MemKeychain::new(Some(A), true));
        world.resolve().unwrap();
        world.run(|inputs| inputs.vault.retire(&A, false)).unwrap();
        *world.keychain.slot.borrow_mut() = None;
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert_eq!(
            world.keychain.held(),
            None,
            "recovery never writes the keychain"
        );
        assert_eq!(
            resolution.health,
            MasterKeyHealth::RecoveredFrom(format!("retired:{}", key_check_value(&A)))
        );
    }
    #[test]
    fn raw_backup_keys_are_adopted_into_a_file_custody_folder_with_its_own_kcv() {
        // A headless target (no keychain) that sealed data under its own key.
        let world = World::new(MemKeychain::new(None, false));
        world.write_file_key(B);
        assert_eq!(world.resolve().unwrap().key, B);
        assert_eq!(world.recorded(), Some(key_check_value(&B)));
        // A backup from before key bundles: only its raw key file.
        let file = b64().encode(A);
        let current = decode_key_file(&file).unwrap();
        let wrapping = FieldCipher::new(&[9; KEY_LEN]);
        let sealed = seal_raw_key_bundle(&wrapping, &current, &[]).unwrap();
        let (current, retired) = open_key_bundle(&wrapping, &sealed).unwrap();
        let outcome = world
            .run(|inputs| import_with(inputs, current, &retired))
            .unwrap();
        assert_eq!(outcome.kcv, key_check_value(&A));
        assert_eq!(outcome.custody, "file");
        assert_eq!(outcome.retired, Some(key_check_value(&B)));
        // Core resolves the backup's key, and the target's key still opens.
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert_eq!(resolution.health, MasterKeyHealth::Ok);
        assert!(resolution.retired.contains(&B));
        assert!(decode_key_file("not a key").is_none());
    }

    #[test]
    fn file_custody_install_carries_retired_keys_into_a_recovered_folder() {
        let world = World::new(MemKeychain::new(None, false));
        // The snapshot's index named a keychain-held retired key.
        write_retired_index(
            world.dir.path(),
            &[RetiredEntry {
                kcv: key_check_value(&B),
                custody: "keychain".to_owned(),
                retired_at: 11,
            }],
        )
        .unwrap();
        install_file_custody(world.dir.path(), &A, &[B, C, A]).unwrap();
        let index = read_retired_index(world.dir.path()).unwrap();
        assert_eq!(index.len(), 2);
        assert!(index.iter().all(|entry| entry.custody == "file"));
        assert_eq!(index[0].retired_at, 11);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(retired_key_path(world.dir.path(), &key_check_value(&B)))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
        let resolution = world.resolve().unwrap();
        assert_eq!(resolution.key, A);
        assert_eq!(resolution.health, MasterKeyHealth::Ok);
        assert!(resolution.retired.contains(&B));
        assert!(resolution.retired.contains(&C));
    }
}

//! Authored configuration transactions shared by Core and Gateway.
//! Call synchronous acquisition from a blocking executor. Never hold this guard
//! across network, audit, or subprocess waits. The persistent lock is separate
//! from the configuration file, whose inode changes on atomic replacement.

use std::fmt;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(3);

/// Opaque revision of authored bytes, including a distinct missing-file state.
#[derive(Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ConfigRevision(String);

impl ConfigRevision {
    pub fn parse(value: &str) -> Option<Self> {
        (value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then(|| Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ConfigRevision {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value).ok_or("invalid configuration revision")
    }
}

impl From<ConfigRevision> for String {
    fn from(revision: ConfigRevision) -> Self {
        revision.0
    }
}

impl fmt::Debug for ConfigRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ConfigRevision")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for ConfigRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Raw bytes must be parsed without environment, fleet, or startup overlays.
pub struct ConfigSnapshot {
    bytes: Vec<u8>,
    exists: bool,
    revision: ConfigRevision,
}

impl ConfigSnapshot {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn exists(&self) -> bool {
        self.exists
    }
    pub fn revision(&self) -> &ConfigRevision {
        &self.revision
    }
}

impl fmt::Debug for ConfigSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigSnapshot")
            .field("exists", &self.exists)
            .field("byte_count", &self.bytes.len())
            .field("revision", &self.revision)
            .finish()
    }
}

#[derive(Debug)]
pub enum ConfigCommitError {
    Conflict {
        current_revision: ConfigRevision,
    },
    LockTimeout,
    InvalidPath,
    InvalidFile,
    TooLarge,
    /// A secret leaf could not be sealed for disk (no Gateway sealing key in
    /// this process, or a value sealed under another scheme). Nothing is written.
    Sealing,
    /// The host's write gate refused to seal a new secret (for example Core
    /// editing the file of an externally managed Gateway that may not hold the
    /// key). Carries the operator-facing reason. Nothing is written.
    SealingBlocked(String),
    Io(std::io::ErrorKind),
}

impl fmt::Display for ConfigCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SealingBlocked(reason) => reason,
            Self::Conflict { .. } => "configuration revision conflict",
            Self::LockTimeout => "configuration lock timed out",
            Self::InvalidPath => "invalid configuration path",
            Self::InvalidFile => "configuration must be a regular file without links",
            Self::TooLarge => "configuration exceeds the size limit",
            Self::Sealing => {
                "configuration secrets could not be sealed; the Gateway sealing key is unavailable"
            }
            Self::Io(_) => "configuration file operation failed",
        })
    }
}

impl std::error::Error for ConfigCommitError {}
impl From<std::io::Error> for ConfigCommitError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.kind())
    }
}

pub struct ConfigFileTransaction {
    _lock: File,
    path: PathBuf,
    snapshot: ConfigSnapshot,
}

impl fmt::Debug for ConfigFileTransaction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigFileTransaction")
            .field("snapshot", &self.snapshot)
            .finish_non_exhaustive()
    }
}

impl ConfigFileTransaction {
    pub fn acquire(path: &Path) -> Result<Self, ConfigCommitError> {
        Self::acquire_with_timeout(path, DEFAULT_LOCK_TIMEOUT)
    }

    pub fn acquire_with_timeout(path: &Path, timeout: Duration) -> Result<Self, ConfigCommitError> {
        let filename = path.file_name().ok_or(ConfigCommitError::InvalidPath)?;
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        let parent = parent.canonicalize()?;
        let path = parent.join(filename);
        let mut lock_name = std::ffi::OsString::from(".");
        lock_name.push(filename);
        lock_name.push(".lock");
        let lock_path = parent.join(lock_name);
        let lock = open_lock(&lock_path)?;
        let started = Instant::now();
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) => {
                    if started.elapsed() >= timeout {
                        return Err(ConfigCommitError::LockTimeout);
                    }
                    std::thread::sleep(
                        Duration::from_millis(10).min(timeout.saturating_sub(started.elapsed())),
                    );
                }
                Err(TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        let snapshot = read_snapshot(&path)?;
        Ok(Self {
            _lock: lock,
            path,
            snapshot,
        })
    }

    pub fn snapshot(&self) -> &ConfigSnapshot {
        &self.snapshot
    }

    /// Retains the guard after commit so callers can apply synchronous live state.
    /// A final read also detects editors that did not participate in the lock.
    ///
    /// `bytes` is the authored TOML as the caller edited it, secrets opened or
    /// still sealed. Every plaintext secret leaf is sealed with the Gateway
    /// sealing key before the bytes reach disk (see [`crate::sealed_config`]);
    /// without a key, a new plaintext secret fails with
    /// [`ConfigCommitError::Sealing`] and nothing is written.
    pub fn commit(
        &mut self,
        expected: &ConfigRevision,
        bytes: &[u8],
    ) -> Result<ConfigRevision, ConfigCommitError> {
        let gate = crate::sealed_config::installed_write_gate();
        let current = self.snapshot.exists.then(|| self.snapshot.bytes.clone());
        let sealer = crate::sealed_config::gated_sealer(
            gate,
            current.as_deref(),
            &crate::sealed_config::config_sealer,
        );
        self.commit_with_sealer(expected, bytes, &sealer)
    }

    /// [`Self::commit`] with an explicit sealer source (tests use a fixed key).
    pub fn commit_with_sealer(
        &mut self,
        expected: &ConfigRevision,
        bytes: &[u8],
        sealer: &dyn Fn() -> Result<
            std::sync::Arc<dyn ryu_crypto::SecretSealer>,
            crate::sealed_config::SealedConfigError,
        >,
    ) -> Result<ConfigRevision, ConfigCommitError> {
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(ConfigCommitError::TooLarge);
        }
        let current = read_snapshot(&self.path)?;
        if expected != self.snapshot.revision() || current.revision() != self.snapshot.revision() {
            return Err(ConfigCommitError::Conflict {
                current_revision: current.revision().clone(),
            });
        }
        let on_disk = current.exists.then_some(current.bytes.as_slice());
        let Some(bytes) =
            crate::sealed_config::prepare_for_disk(on_disk, bytes, sealer).map_err(|error| {
                match error {
                    crate::sealed_config::SealedConfigError::WriteBlocked(reason) => {
                        ConfigCommitError::SealingBlocked(reason)
                    }
                    _ => ConfigCommitError::Sealing,
                }
            })?
        else {
            return Ok(current.revision);
        };
        let bytes: &[u8] = &bytes;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(ConfigCommitError::TooLarge);
        }
        if current.exists && current.bytes == bytes {
            return Ok(current.revision);
        }
        let parent = self.path.parent().ok_or(ConfigCommitError::InvalidPath)?;
        let temporary_path = parent.join(format!(
            ".gateway-config-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let mut options = private_options();
        options.write(true).create_new(true);
        let mut file = options.open(&temporary_path)?;
        let temporary = TemporaryFile(temporary_path);
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let latest = read_snapshot(&self.path)?;
        if latest.revision() != current.revision() {
            return Err(ConfigCommitError::Conflict {
                current_revision: latest.revision().clone(),
            });
        }
        std::fs::rename(&temporary.0, &self.path)?;
        self.snapshot = snapshot(bytes.to_vec(), true);
        Ok(self.snapshot.revision().clone())
    }
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options
}

fn regular_file(metadata: &std::fs::Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

fn open_lock(path: &Path) -> Result<File, ConfigCommitError> {
    let mut options = private_options();
    options.read(true).write(true).create(true);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !regular_file(&metadata) {
        return Err(ConfigCommitError::InvalidFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(ConfigCommitError::InvalidFile);
        }
    }
    Ok(file)
}

fn read_snapshot(path: &Path) -> Result<ConfigSnapshot, ConfigCommitError> {
    let mut options = private_options();
    options.read(true);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(snapshot(Vec::new(), false))
        }
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !regular_file(&metadata) {
        return Err(ConfigCommitError::InvalidFile);
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(ConfigCommitError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ConfigCommitError::TooLarge);
    }
    Ok(snapshot(bytes, true))
}

fn snapshot(bytes: Vec<u8>, exists: bool) -> ConfigSnapshot {
    let mut hash = Sha256::new();
    hash.update(b"ryu-authored-config-revision-v1\0");
    hash.update([u8::from(exists)]);
    hash.update(&bytes);
    ConfigSnapshot {
        revision: ConfigRevision(format!("{:x}", hash.finalize())),
        bytes,
        exists,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ryu-config-transaction-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn config(&self) -> PathBuf {
            self.0.join("gateway.toml")
        }
        fn child(&self, mode: &str) -> Child {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "config_file::tests::process_probe",
                    "--nocapture",
                ])
                .env("RYU_CONFIG_TRANSACTION_TEST_DIR", &self.0)
                .env("RYU_CONFIG_TRANSACTION_TEST_MODE", mode)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ready(path: &Path) {
        let started = Instant::now();
        while !path.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "child transaction did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn process_probe() {
        let Some(directory) = std::env::var_os("RYU_CONFIG_TRANSACTION_TEST_DIR") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let mode = std::env::var("RYU_CONFIG_TRANSACTION_TEST_MODE").unwrap();
        if mode == "append" {
            std::fs::write(directory.join("attempted"), []).unwrap();
        }
        let mut transaction =
            ConfigFileTransaction::acquire(&directory.join("gateway.toml")).unwrap();
        if mode == "hold" {
            std::fs::write(directory.join("ready"), []).unwrap();
            std::thread::sleep(Duration::from_secs(30));
        } else {
            let mut bytes = transaction.snapshot().bytes().to_vec();
            bytes.extend_from_slice(b"child\n");
            let revision = transaction.snapshot().revision().clone();
            transaction.commit(&revision, &bytes).unwrap();
        }
    }

    #[test]
    fn missing_file_creation_and_noop_preserve_revision() {
        let fixture = Fixture::new();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        assert!(!transaction.snapshot().exists());
        let missing = transaction.snapshot().revision().clone();
        let created = transaction.commit(&missing, b"").unwrap();
        assert_ne!(missing, created);
        assert!(transaction.snapshot().exists());
        assert_eq!(transaction.commit(&created, b"").unwrap(), created);
        assert_eq!(
            ConfigRevision::parse(created.as_str()),
            Some(created.clone())
        );
        assert_eq!(
            serde_json::from_str::<ConfigRevision>(&serde_json::to_string(&created).unwrap())
                .unwrap(),
            created
        );
    }

    #[test]
    fn stale_revision_and_external_edit_do_not_overwrite() {
        let fixture = Fixture::new();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let missing = transaction.snapshot().revision().clone();
        let revision = transaction.commit(&missing, b"initial").unwrap();
        assert!(matches!(
            transaction.commit(&missing, b"stale"),
            Err(ConfigCommitError::Conflict { .. })
        ));
        std::fs::write(fixture.config(), b"external").unwrap();
        assert!(matches!(
            transaction.commit(&revision, b"overwrite"),
            Err(ConfigCommitError::Conflict { .. })
        ));
        assert_eq!(std::fs::read(fixture.config()).unwrap(), b"external");
        assert!(!std::fs::read_dir(&fixture.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn cooperating_process_reads_only_after_prior_commit() {
        let fixture = Fixture::new();
        let mut parent = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let mut child = fixture.child("append");
        ready(&fixture.0.join("attempted"));
        assert!(child.try_wait().unwrap().is_none());
        let revision = parent.snapshot().revision().clone();
        parent.commit(&revision, b"parent\n").unwrap();
        drop(parent);
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read(fixture.config()).unwrap(), b"parent\nchild\n");
    }

    #[test]
    fn timeout_and_process_death_release_the_persistent_lock() {
        let fixture = Fixture::new();
        let mut child = fixture.child("hold");
        ready(&fixture.0.join("ready"));
        assert!(matches!(
            ConfigFileTransaction::acquire_with_timeout(
                &fixture.config(),
                Duration::from_millis(30)
            ),
            Err(ConfigCommitError::LockTimeout)
        ));
        child.kill().unwrap();
        child.wait().unwrap();
        let guard = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        drop(guard);
        assert!(fixture.0.join(".gateway.toml.lock").exists());
        assert!(ConfigFileTransaction::acquire(&fixture.config()).is_ok());
    }

    #[test]
    fn debug_and_errors_never_display_contents_or_paths() {
        let fixture = Fixture::new();
        std::fs::write(fixture.config(), b"sensitive-material").unwrap();
        let transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let debug = format!("{transaction:?}");
        assert!(!debug.contains("sensitive-material"));
        assert!(!debug.contains(&fixture.0.to_string_lossy().to_string()));
        assert_eq!(
            ConfigCommitError::Io(std::io::ErrorKind::PermissionDenied).to_string(),
            "configuration file operation failed"
        );
        assert!(ConfigRevision::parse("sensitive-material").is_none());
    }

    #[test]
    fn canonical_parent_aliases_share_one_lock_and_size_limits_fail_closed() {
        let fixture = Fixture::new();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let alias = fixture.0.join(".").join("gateway.toml");
        assert!(matches!(
            ConfigFileTransaction::acquire_with_timeout(&alias, Duration::from_millis(20)),
            Err(ConfigCommitError::LockTimeout)
        ));
        let revision = transaction.snapshot().revision().clone();
        assert!(matches!(
            transaction.commit(&revision, &vec![0; MAX_CONFIG_BYTES as usize + 1]),
            Err(ConfigCommitError::TooLarge)
        ));
        assert!(!fixture.config().exists());
        drop(transaction);
        let file = File::create(fixture.config()).unwrap();
        file.set_len(MAX_CONFIG_BYTES + 1).unwrap();
        drop(file);
        assert!(matches!(
            ConfigFileTransaction::acquire(&fixture.config()),
            Err(ConfigCommitError::TooLarge)
        ));
    }

    #[test]
    fn commit_seals_secrets_on_disk_and_keeps_unchanged_saves_stable() {
        use crate::sealed_config::{self, tests::test_sealer};
        let fixture = Fixture::new();
        let with_key = || Ok(test_sealer());
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let missing = transaction.snapshot().revision().clone();
        let authored = "[providers.openai]\napi_key = \"sk-live-on-disk\"\n";
        let revision = transaction
            .commit_with_sealer(&missing, authored.as_bytes(), &with_key)
            .unwrap();
        let on_disk = std::fs::read(fixture.config()).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("sk-live-on-disk"));
        assert!(String::from_utf8_lossy(&on_disk).contains("encc:v1:"));
        assert_eq!(transaction.snapshot().bytes(), on_disk.as_slice());
        // Re-saving the same opened document neither rewrites nor re-revisions.
        assert_eq!(
            transaction
                .commit_with_sealer(&revision, authored.as_bytes(), &with_key)
                .unwrap(),
            revision
        );
        let opened = sealed_config::open_text_with(
            std::str::from_utf8(&on_disk).unwrap(),
            test_sealer().as_ref(),
        )
        .unwrap();
        assert!(opened.contains("sk-live-on-disk"));
        // Without a key a new secret is refused and nothing is written.
        let no_key = || {
            Err(sealed_config::SealedConfigError::KeyUnavailable(
                "test".into(),
            ))
        };
        assert!(matches!(
            transaction.commit_with_sealer(
                &revision,
                b"[providers.openai]\napi_key = \"sk-other\"\n",
                &no_key
            ),
            Err(ConfigCommitError::Sealing)
        ));
        assert_eq!(std::fs::read(fixture.config()).unwrap(), on_disk);
    }

    #[test]
    fn write_gate_blocks_new_secrets_only_for_files_without_sealed_leaves() {
        use crate::sealed_config::{self, tests::test_sealer};
        fn refuse() -> Result<(), String> {
            Err("hand the Gateway its sealing key first".into())
        }
        let fixture = Fixture::new();
        let with_key = || Ok(test_sealer());
        let hand_authored = "[providers.openai]\napi_key = \"sk-hand-authored\"\n";
        std::fs::write(fixture.config(), hand_authored).unwrap();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let revision = transaction.snapshot().revision().clone();

        // A new secret is refused with the gate's reason; nothing is written.
        let current = transaction.snapshot().bytes().to_vec();
        let gated = sealed_config::gated_sealer(Some(refuse), Some(&current), &with_key);
        let with_new = format!("{hand_authored}[providers.groq]\napi_key = \"sk-new\"\n");
        match transaction.commit_with_sealer(&revision, with_new.as_bytes(), &gated) {
            Err(ConfigCommitError::SealingBlocked(reason)) => {
                assert!(reason.contains("sealing key"));
            }
            other => panic!("expected a blocked write, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(fixture.config()).unwrap(),
            hand_authored
        );

        // A non-secret edit keeps the existing plaintext secret as it is, so a
        // Gateway without the key still reads the file.
        let edited = format!("{hand_authored}[routing]\ndefault_provider = \"openai\"\n");
        transaction
            .commit_with_sealer(&revision, edited.as_bytes(), &gated)
            .unwrap();
        let on_disk = std::fs::read_to_string(fixture.config()).unwrap();
        assert!(on_disk.contains("sk-hand-authored"));
        assert_eq!(sealed_config::open_text(&on_disk).unwrap(), on_disk);
        let census = sealed_config::census(&on_disk).unwrap();
        assert_eq!(census.sealed, 0);

        // Once the file holds a sealed leaf (the reader has the key), the gate
        // is not consulted and new secrets are sealed.
        let sealed = sealed_config::seal_text_with(&on_disk, test_sealer().as_ref()).unwrap();
        std::fs::write(fixture.config(), &sealed).unwrap();
        drop(transaction);
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let revision = transaction.snapshot().revision().clone();
        let current = transaction.snapshot().bytes().to_vec();
        let gated = sealed_config::gated_sealer(Some(refuse), Some(&current), &with_key);
        let opened = sealed_config::open_text_with(&sealed, test_sealer().as_ref()).unwrap();
        let next = format!("{opened}[providers.groq]\napi_key = \"sk-new\"\n");
        transaction
            .commit_with_sealer(&revision, next.as_bytes(), &gated)
            .unwrap();
        let on_disk = std::fs::read_to_string(fixture.config()).unwrap();
        assert!(!on_disk.contains("sk-new"));
        assert!(!on_disk.contains("sk-hand-authored"));
    }

    #[test]
    fn reseal_file_migrates_legacy_plaintext_in_place() {
        use crate::sealed_config::{self, tests::test_sealer};
        let fixture = Fixture::new();
        std::fs::write(
            fixture.config(),
            "# kept\n[auth]\nmaster_key = \"gwadm_legacy\"\n[routing]\ndefault_provider = \"x\"\n",
        )
        .unwrap();
        let no_key = || {
            Err(sealed_config::SealedConfigError::KeyUnavailable(
                "test".into(),
            ))
        };
        assert!(!sealed_config::reseal_file_with(&fixture.config(), &no_key).unwrap());
        assert!(String::from_utf8(std::fs::read(fixture.config()).unwrap())
            .unwrap()
            .contains("gwadm_legacy"));
        let with_key = || Ok(test_sealer());
        assert!(sealed_config::reseal_file_with(&fixture.config(), &with_key).unwrap());
        let migrated = std::fs::read_to_string(fixture.config()).unwrap();
        assert!(!migrated.contains("gwadm_legacy"));
        assert!(migrated.contains("# kept"));
        assert!(migrated.contains("default_provider = \"x\""));
        // Idempotent.
        assert!(!sealed_config::reseal_file_with(&fixture.config(), &with_key).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn failed_atomic_replacement_preserves_original_and_cleans_owned_temporary() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        std::fs::write(fixture.config(), b"original").unwrap();
        let blocker = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(fixture.config())
            .unwrap();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let revision = transaction.snapshot().revision().clone();
        assert!(transaction.commit(&revision, b"replacement").is_err());
        assert_eq!(std::fs::read(fixture.config()).unwrap(), b"original");
        assert!(!std::fs::read_dir(&fixture.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        drop(blocker);
        assert!(transaction.commit(&revision, b"replacement").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn link_targets_are_rejected_and_published_files_are_private() {
        use std::os::unix::fs::{symlink, MetadataExt};
        let fixture = Fixture::new();
        let other = fixture.0.join("other");
        std::fs::write(&other, b"original").unwrap();
        symlink(&other, fixture.config()).unwrap();
        assert!(ConfigFileTransaction::acquire(&fixture.config()).is_err());
        std::fs::remove_file(fixture.config()).unwrap();
        let mut transaction = ConfigFileTransaction::acquire(&fixture.config()).unwrap();
        let revision = transaction.snapshot().revision().clone();
        transaction.commit(&revision, b"private").unwrap();
        assert_eq!(
            std::fs::metadata(fixture.config()).unwrap().mode() & 0o077,
            0
        );
        assert_eq!(std::fs::read(other).unwrap(), b"original");
    }
}

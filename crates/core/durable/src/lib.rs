//! Durable-execution primitive: the `DurableEngine` swap-seam plus the
//! atomically-durable [`FileCheckpointStore`] that backs crash-recoverable
//! resume.
//!
//! # What this crate owns
//!
//! - **[`DurableEngine`]** — the backend seam a durable run flows through. It is
//!   generic over the caller's workflow (`W`) and run-state (`R`) types so the
//!   crate never depends on any concrete workflow model. There is one in-process
//!   implementation today — Core's `FallbackEngine` (the petgraph topological
//!   executor, which stays Core-side because it *is* the workflow-app) — and the
//!   seam is kept so a future durable backend (Temporal / Restate / DBOS sidecar)
//!   can slot in with no server-handler churn.
//! - **[`FileCheckpointStore`]** — the directory-backed, atomically-durable
//!   run-state store. Each record is one `<dir>/<id>.json` file written via
//!   temp-file + `fsync` + atomic rename, so a crash mid-write can never leave a
//!   torn/half-written file: a reader always sees either the previous complete
//!   state or the new complete state. This is the guarantee that makes the
//!   durable-timer / resume semantics real rather than best-effort. It is generic
//!   over any `serde`-serializable record keyed by a path-safe string id.
//! - **[`CheckpointStore`]** — the pluggable, namespaced store seam behind
//!   checkpoint / resume, with four implementations sharing one contract
//!   (checked by `tests/checkpoint_conformance.rs`): the file store above, an
//!   in-process [`MemoryCheckpointStore`], `postgres::PostgresCheckpointStore`
//!   (feature `postgres`), and `redis::RedisCheckpointStore` (feature `redis`).
//!   [`CheckpointStoreConfig`] (`RYU_DURABLE_*` environment variables) selects
//!   one and [`CheckpointBackend`] hands out a store per namespace.
//!
//! # What stays with the consumer (Core)
//!
//! The execution *semantics* — topological order, per-node/`While`-iteration
//! checkpointing, the `Awakeable` (HITL) suspend/resume — live in Core's workflow
//! `executor` (the workflow-app), which invokes this crate's checkpoint store
//! after every node. The concrete `WorkflowRun` data model, its run directory,
//! and the `FallbackEngine`/`select_engine` host wiring stay Core-side
//! (`apps/core/src/workflow/{store,durable}.rs`). Sessions and workflows remain
//! cheap, centrally-legible rows that gain checkpoint/resume semantics — **not**
//! resident, hibernating actor processes.
//!
//! # Core-vs-Gateway
//!
//! Durability decides **what runs** (which step, resumed from where) — it is
//! Core. It enforces no policy; any model call within a step is routed through
//! the Gateway by the consumer.

pub mod config;
#[cfg(feature = "postgres")]
pub mod postgres;
#[cfg(feature = "redis")]
pub mod redis;
pub mod store;

pub use config::{CheckpointBackend, CheckpointBackendKind, CheckpointStoreConfig};
pub use store::{load, save, CheckpointError, CheckpointStore, MemoryCheckpointStore};

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use ryu_crypto::{ContentCipher, ContentContext};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Boxed, `Send` future returned by the object-safe [`DurableEngine`] methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── Engine seam ──────────────────────────────────────────────────────────────

/// Abstraction over durable-execution backends for a run.
///
/// Generic over the caller's workflow type `W` and run-state type `R` so the
/// crate has zero dependency on any concrete workflow model. Object-safe: methods
/// return `Pin<Box<dyn Future + Send + '_>>` (see [`BoxFuture`]) rather than
/// `impl Future`, so the trait can be used as
/// `Box<dyn DurableEngine<W, R>>` without `async_trait`.
///
/// The default in-process backend delegates `execute` to the consumer's own
/// executor (that executor *is* the workflow-app) and backs `checkpoint`/`resume`
/// with a [`FileCheckpointStore`]. The seam re-admits an external backend
/// (Temporal / Restate / DBOS) that implements all three verbs itself.
pub trait DurableEngine<W, R>: Send + Sync {
    /// Execute (or resume) a run to completion.
    fn execute<'a>(
        &'a self,
        workflow: &'a W,
        input: HashMap<String, String>,
        run_id: String,
    ) -> BoxFuture<'a, Result<R, String>>;

    /// Record a run checkpoint durably.
    fn checkpoint<'a>(&'a self, run: &'a R) -> BoxFuture<'a, Result<(), String>>;

    /// Resume a run by loading its persisted state, returning the saved run if one
    /// exists for `run_id` under `workflow_id`, else `None`.
    ///
    /// This is also the replay entry point: the in-process engine has no separate
    /// replay journal beyond the checkpointed run state, so replay == reload. An
    /// event-sourced backend (Temporal/Restate) that needs a distinct journal
    /// replay adds that verb when a consumer requires it — it is intentionally not
    /// pre-declared here without a caller.
    fn resume<'a>(&'a self, run_id: &'a str, workflow_id: &'a str) -> BoxFuture<'a, Option<R>>;
}

/// Whether `name` is a temporary file left by an atomic write: the
/// `<name>.tmp` sibling [`atomic_write_private`] uses, or a `.tmp*` file from
/// `tempfile` (the other atomic writers' naming).
pub fn is_atomic_write_temp(name: &str) -> bool {
    name.starts_with(".tmp") || name.ends_with(".tmp")
}

/// Remove the temporary files atomic writes left directly in `dir` (see
/// [`is_atomic_write_temp`]) whose last modification is at least `min_age` old.
/// A crash between writing such a file and renaming it leaves a full copy of
/// the record behind; a live write lasts milliseconds, so `min_age` keeps the
/// sweep away from writes in flight. Returns how many files were removed; a
/// missing directory removes nothing.
pub fn remove_orphaned_temp_files(dir: &Path, min_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_atomic_write_temp(&name.to_string_lossy()) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let age = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .unwrap_or_default();
        if age >= min_age && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ── Checkpoint store ─────────────────────────────────────────────────────────

/// Reject ids that could escape the storage directory before they are
/// interpolated into a file path. Only the charset used for generated ids is
/// allowed (ASCII alphanumeric, `_`, `-`); this excludes path separators and
/// `.`, so `../` traversal and absolute paths are impossible.
pub fn validate_id(id: &str) -> std::io::Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid id (must match [A-Za-z0-9_-], 1..=128 chars): {id:?}"),
        ))
    }
}

// ── Codecs ───────────────────────────────────────────────────────────────────

/// Turns a record's serialized JSON into the bytes stored on disk and back.
///
/// The store itself never decides how records are protected: the default
/// [`IdentityCodec`] stores the JSON as-is; a consumer that keeps user content in
/// its records (Core's workflow runs) passes a [`SealingCodec`]. Every reader of
/// a store's files must go through the same codec.
pub trait CheckpointCodec: Send + Sync + std::fmt::Debug {
    /// Encode the JSON of record `id` for disk. Must fail (never fall back to
    /// plaintext) when the record cannot be protected.
    fn encode(&self, id: &str, json: &[u8]) -> std::io::Result<Vec<u8>>;
    /// Decode the stored bytes of record `id` back to JSON. Accepts legacy
    /// plaintext records.
    fn decode(&self, id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>>;
}

/// Stores records as plain JSON (the default).
#[derive(Clone, Copy, Debug, Default)]
pub struct IdentityCodec;

impl CheckpointCodec for IdentityCodec {
    fn encode(&self, _id: &str, json: &[u8]) -> std::io::Result<Vec<u8>> {
        Ok(json.to_vec())
    }

    fn decode(&self, _id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>> {
        Ok(stored.to_vec())
    }
}

/// Seals each record's whole body as one `encb:v1:` value under a content
/// cipher, bound to `(kind, id)`: a record copied to another id, or to another
/// kind of record sealed by the same cipher, does not open. Legacy plaintext
/// records (anything without the envelope) are read as-is and sealed by the
/// next save.
#[derive(Clone, Debug)]
pub struct SealingCodec {
    cipher: ContentCipher,
    kind: String,
}

impl SealingCodec {
    /// A codec sealing records of `kind` (an AAD purpose such as
    /// `workflow-run`) under `cipher`.
    pub fn new(cipher: ContentCipher, kind: impl Into<String>) -> Self {
        Self {
            cipher,
            kind: kind.into(),
        }
    }

    fn context(&self, id: &str) -> ContentContext {
        ContentContext::for_id(self.kind.clone(), id)
    }

    /// Whether `stored` carries the content envelope (any version).
    pub fn is_sealed(stored: &[u8]) -> bool {
        stored.starts_with(b"encb:")
    }
}

fn invalid_data(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
}

impl CheckpointCodec for SealingCodec {
    fn encode(&self, id: &str, json: &[u8]) -> std::io::Result<Vec<u8>> {
        let text = std::str::from_utf8(json).map_err(invalid_data)?;
        self.cipher
            .seal_text(text, &self.context(id))
            .map(String::into_bytes)
            .map_err(|error| std::io::Error::other(format!("sealing {} {id}: {error}", self.kind)))
    }

    fn decode(&self, id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>> {
        if !Self::is_sealed(stored) {
            return Ok(stored.to_vec());
        }
        let text = std::str::from_utf8(stored).map_err(invalid_data)?;
        self.cipher
            .open_text(text.trim_end(), &self.context(id))
            .map(|opened| opened.value.into_bytes())
            .map_err(|error| invalid_data(format!("{} {id} does not open: {error:#}", self.kind)))
    }
}

/// Write `bytes` to `path` atomically and durably: a per-file 0600 temp in the
/// same directory, `fsync`, then an atomic rename over the destination.
pub fn atomic_write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        // Flush to the OS and force the bytes to disk before the rename so a
        // hard crash right after this returns still has the data on platter.
        f.sync_all()?;
    }
    // Atomic replace. If the rename fails, clean up the temp so it doesn't leak.
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

// ── Checkpoint store ─────────────────────────────────────────────────────────

/// A directory-backed, atomically-durable checkpoint store keyed by a path-safe
/// string id. Each record is one `<dir>/<id>.json` file, encoded by the store's
/// [`CheckpointCodec`] (plain JSON by default).
///
/// The store is a thin handle over a directory path; construct one per operation
/// (it holds no open resources). The write path — temp file + `fsync` + atomic
/// rename — is what upgrades "wrote to disk" into "durable and crash-safe".
#[derive(Debug, Clone)]
pub struct FileCheckpointStore {
    dir: PathBuf,
    codec: Arc<dyn CheckpointCodec>,
}

impl FileCheckpointStore {
    /// Create a store rooted at `dir` storing plain JSON. The directory is
    /// created on the first [`save`](Self::save); it need not exist yet.
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self::with_codec(dir, Arc::new(IdentityCodec))
    }

    /// Create a store rooted at `dir` whose records go through `codec`.
    pub fn with_codec(dir: impl AsRef<Path>, codec: Arc<dyn CheckpointCodec>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            codec,
        }
    }

    /// The path of record `id` (validated).
    pub fn path_of(&self, id: &str) -> std::io::Result<PathBuf> {
        validate_id(id)?;
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// Persist (create or overwrite) a record's state under `id`.
    ///
    /// The write is **atomic and durable**: the encoded record is written to a
    /// per-record 0600 temp file, flushed + `fsync`'d, then renamed over the
    /// destination (an atomic replace on both Windows and Unix). A crash
    /// mid-write can never leave a torn/half-written file — a reader always sees
    /// either the previous complete state or the new complete state. An encoding
    /// failure (no key) fails the save; nothing is written.
    pub fn save<T: Serialize>(&self, id: &str, value: &T) -> std::io::Result<()> {
        let path = self.path_of(id)?;
        let json = serde_json::to_vec_pretty(value).map_err(invalid_data)?;
        let encoded = self.codec.encode(id, &json)?;
        std::fs::create_dir_all(&self.dir)?;
        atomic_write_private(&path, &encoded)
    }

    /// Load a record's state by `id`.
    pub fn load<T: DeserializeOwned>(&self, id: &str) -> std::io::Result<T> {
        let bytes = std::fs::read(self.path_of(id)?)?;
        self.decode(id, &bytes)
    }

    /// Decode stored bytes of record `id` (for callers that read the directory
    /// themselves, e.g. a listing).
    pub fn decode<T: DeserializeOwned>(&self, id: &str, stored: &[u8]) -> std::io::Result<T> {
        let json = self.codec.decode(id, stored)?;
        serde_json::from_slice(&json).map_err(invalid_data)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Rec {
        id: String,
        n: u32,
    }

    /// A saved record round-trips through the atomic write/read path unchanged.
    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileCheckpointStore::new(dir.path());
        let rec = Rec {
            id: "run_abc".into(),
            n: 7,
        };
        store.save("run_abc", &rec).expect("save ok");
        let loaded: Rec = store.load("run_abc").expect("load ok");
        assert_eq!(loaded, rec);
    }

    /// Overwriting a record replaces it atomically (last write wins).
    #[test]
    fn save_overwrites() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileCheckpointStore::new(dir.path());
        store
            .save(
                "run_x",
                &Rec {
                    id: "run_x".into(),
                    n: 1,
                },
            )
            .expect("save v1");
        store
            .save(
                "run_x",
                &Rec {
                    id: "run_x".into(),
                    n: 2,
                },
            )
            .expect("save v2");
        let loaded: Rec = store.load("run_x").expect("load ok");
        assert_eq!(loaded.n, 2);
        // No temp file is left behind after a successful atomic replace.
        assert!(!dir.path().join("run_x.json.tmp").exists());
    }

    /// Loading an absent record surfaces a NotFound io error (the caller maps this
    /// to "run is new" in its resume path).
    #[test]
    fn load_missing_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileCheckpointStore::new(dir.path());
        let err = store.load::<Rec>("run_absent").expect_err("must error");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    /// A path-traversal id is rejected before it can escape the store directory,
    /// on both the save and load paths.
    #[test]
    fn traversal_ids_are_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileCheckpointStore::new(dir.path());
        for bad in ["../escape", "a/b", "a.b", "", &"x".repeat(129)] {
            assert!(validate_id(bad).is_err(), "expected {bad:?} rejected");
            assert!(
                store
                    .save(
                        bad,
                        &Rec {
                            id: "x".into(),
                            n: 0
                        }
                    )
                    .is_err(),
                "save must reject {bad:?}"
            );
            assert!(store.load::<Rec>(bad).is_err(), "load must reject {bad:?}");
        }
        // A well-formed generated-style id passes.
        assert!(validate_id("run_0af3_-9").is_ok());
    }

    fn sealing_at(dir: &Path, root: u8, kind: &str) -> FileCheckpointStore {
        let cipher = ContentCipher::from_root(&[root; 32], "workflow-state");
        FileCheckpointStore::with_codec(dir, Arc::new(SealingCodec::new(cipher, kind)))
    }

    /// A sealed record never reaches disk (or its temp file) in plaintext, and
    /// reads back unchanged.
    /// Orphaned atomic-write temps are removed once old enough; records,
    /// other files and fresh temps are kept.
    #[test]
    fn orphaned_temp_files_are_removed_by_age() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["run_a.json", "run_a.json.tmp", ".tmpXy12.json", "notes.txt"] {
            std::fs::write(dir.path().join(name), b"{}").unwrap();
        }
        assert_eq!(
            remove_orphaned_temp_files(dir.path(), std::time::Duration::from_secs(3600)),
            0,
            "fresh temps may belong to a write in flight"
        );
        assert_eq!(
            remove_orphaned_temp_files(dir.path(), std::time::Duration::ZERO),
            2
        );
        assert!(dir.path().join("run_a.json").exists());
        assert!(dir.path().join("notes.txt").exists());
        assert!(!dir.path().join("run_a.json.tmp").exists());
        assert!(!dir.path().join(".tmpXy12.json").exists());
        assert_eq!(
            remove_orphaned_temp_files(&dir.path().join("missing"), std::time::Duration::ZERO),
            0
        );
    }

    #[test]
    fn sealing_codec_keeps_plaintext_off_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = sealing_at(dir.path(), 7, "workflow-run");
        let rec = Rec {
            id: "quillfeather-run-output".into(),
            n: 3,
        };
        store.save("run_s", &rec).expect("save");
        let bytes = std::fs::read(dir.path().join("run_s.json")).unwrap();
        assert!(bytes.starts_with(b"encb:v1:"));
        assert!(!String::from_utf8_lossy(&bytes).contains("quillfeather"));
        assert_eq!(store.load::<Rec>("run_s").unwrap(), rec);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.path().join("run_s.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// A legacy plaintext record reads, and the next save seals it.
    #[test]
    fn sealing_codec_reads_legacy_plaintext_and_reseals_on_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = Rec {
            id: "legacy".into(),
            n: 1,
        };
        FileCheckpointStore::new(dir.path())
            .save("run_l", &legacy)
            .unwrap();
        let store = sealing_at(dir.path(), 7, "workflow-run");
        let loaded: Rec = store.load("run_l").unwrap();
        assert_eq!(loaded, legacy);
        store.save("run_l", &loaded).unwrap();
        assert!(std::fs::read(dir.path().join("run_l.json"))
            .unwrap()
            .starts_with(b"encb:v1:"));
    }

    /// A record moved to another id, or opened as another kind, does not open.
    #[test]
    fn sealed_records_are_bound_to_their_id_and_kind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = sealing_at(dir.path(), 7, "workflow-run");
        let rec = Rec {
            id: "a".into(),
            n: 1,
        };
        store.save("run_a", &rec).unwrap();
        std::fs::copy(dir.path().join("run_a.json"), dir.path().join("run_b.json")).unwrap();
        assert!(store.load::<Rec>("run_b").is_err());
        assert!(sealing_at(dir.path(), 7, "scheduled-job")
            .load::<Rec>("run_a")
            .is_err());
        assert!(sealing_at(dir.path(), 9, "workflow-run")
            .load::<Rec>("run_a")
            .is_err());
    }
}

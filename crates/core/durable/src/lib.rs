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

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

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

/// A directory-backed, atomically-durable checkpoint store keyed by a path-safe
/// string id. Each record is one `<dir>/<id>.json` file.
///
/// The store is a thin handle over a directory path; construct one per operation
/// (it holds no open resources). The write path — temp file + `fsync` + atomic
/// rename — is what upgrades "wrote to disk" into "durable and crash-safe".
pub struct FileCheckpointStore {
    dir: PathBuf,
}

impl FileCheckpointStore {
    /// Create a store rooted at `dir`. The directory is created on the first
    /// [`save`](Self::save); it need not exist yet.
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
        }
    }

    /// Persist (create or overwrite) a record's state under `id`.
    ///
    /// The write is **atomic and durable**: the JSON is written to a per-record
    /// temp file, flushed + `fsync`'d, then renamed over the destination (an
    /// atomic replace on both Windows and Unix). A crash mid-write can never leave
    /// a torn/half-written file — a reader always sees either the previous
    /// complete state or the new complete state.
    pub fn save<T: Serialize>(&self, id: &str, value: &T) -> std::io::Result<()> {
        validate_id(id)?;
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(format!("{id}.json"));
        let json = serde_json::to_string_pretty(value)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // Unique temp name so two concurrent saves of different records never
        // collide; the id is already path-safe (validated above).
        let tmp = self.dir.join(format!("{id}.json.tmp"));
        {
            use std::io::Write as _;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(json.as_bytes())?;
            // Flush to the OS and force the bytes to disk before the rename so a
            // hard crash right after this returns still has the data on platter.
            f.sync_all()?;
        }
        // Atomic replace. If the rename fails, clean up the temp so it doesn't
        // leak.
        match std::fs::rename(&tmp, &path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    /// Load a record's state by `id`.
    pub fn load<T: DeserializeOwned>(&self, id: &str) -> std::io::Result<T> {
        validate_id(id)?;
        let path = self.dir.join(format!("{id}.json"));
        let bytes = std::fs::read(path)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
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
}

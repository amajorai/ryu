//! Publish a complete dependency tree with one atomic pointer change.
//! Old generations remain available to processes that already resolved them.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub mod bounded_file;
#[cfg(feature = "tokio-process")]
pub mod contained_process;
pub mod data_lease;
pub mod data_paths;
pub mod handoff;
mod preparation;
mod process_job;
pub mod recovery;
mod restore_preparation;
pub mod retention;
pub mod startup;
pub mod supervision;
pub mod tree_identity;

#[derive(Serialize, Deserialize)]
struct ActiveGeneration {
    current: String,
    previous: Option<String>,
}

/// Marks a generation that may still be in use by an unverified descendant.
const RETAINED_MARKER: &str = ".retained-unverified";

pub struct RuntimeGenerations {
    root: PathBuf,
}

impl RuntimeGenerations {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn record(&self) -> Result<Option<ActiveGeneration>> {
        match fs::read(self.root.join("active.json")) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice(&bytes).context("invalid runtime generation record")?,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn generation(&self, name: &str) -> Result<PathBuf> {
        if name.is_empty() {
            return Ok(self.root.clone());
        } // The legacy prefix.
        ensure!(
            name.starts_with("generation-")
                && name.len() <= 80
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
            "invalid runtime generation name"
        );
        let directory = self.root.join("generations").join(name);
        let metadata = fs::symlink_metadata(&directory)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "runtime generation must be a real directory"
        );
        Ok(directory)
    }

    pub fn active_dir(&self) -> Result<PathBuf> {
        match self.record()? {
            Some(record) => self.generation(&record.current),
            None => Ok(self.root.clone()),
        }
    }

    pub fn stage(&self) -> Result<tempfile::TempDir> {
        let generations = self.root.join("generations");
        fs::create_dir_all(&generations)?;
        Ok(tempfile::Builder::new()
            .prefix("generation-")
            .tempdir_in(generations)?)
    }

    /// Validate ownership before using a prepared runtime or publishing it.
    pub fn prepared_dir(&self, directory: &Path) -> Result<PathBuf> {
        let name = directory
            .file_name()
            .context("generation directory name")?
            .to_str()
            .context("generation name encoding")?;
        let owned = self.generation(name)?;
        ensure!(
            fs::canonicalize(directory)? == fs::canonicalize(&owned)?,
            "prepared runtime belongs to another node"
        );
        Ok(owned)
    }

    /// Call only after all dependencies and launch checks succeed. A failed
    /// pointer write leaves the previous generation intact.
    pub fn activate(&self, staged: tempfile::TempDir) -> Result<PathBuf> {
        let directory = self.prepared_dir(staged.path())?;
        let _ = staged.keep();
        self.activate_prepared(&directory)
    }

    pub fn activate_prepared(&self, directory: &Path) -> Result<PathBuf> {
        let owned = self.prepared_dir(directory)?;
        let name = owned
            .file_name()
            .context("generation name")?
            .to_str()
            .context("generation name encoding")?
            .to_owned();
        let old = self.record()?;
        if old.as_ref().is_some_and(|record| record.current == name) {
            return Ok(owned);
        }
        let record = ActiveGeneration {
            current: name,
            previous: Some(old.map(|record| record.current).unwrap_or_default()),
        };
        self.publish(&record)?;
        Ok(owned)
    }

    fn publish(&self, record: &ActiveGeneration) -> Result<()> {
        let mut pointer = tempfile::NamedTempFile::new_in(&self.root)?;
        pointer.write_all(&serde_json::to_vec(record)?)?;
        pointer.as_file().sync_all()?;
        pointer
            .persist(self.root.join("active.json"))
            .map_err(|error| error.error)?;
        Ok(())
    }

    /// Keep a staged generation whose process drainage could not be verified.
    /// A descendant may still run from it, so [`Self::prune_inactive`] never
    /// deletes it. Returns the retained directory.
    pub fn retain_unverified(&self, staged: tempfile::TempDir) -> Result<PathBuf> {
        let directory = staged.keep();
        fs::write(directory.join(RETAINED_MARKER), b"")?;
        Ok(directory)
    }

    /// Delete every generation that is neither active nor the rollback target,
    /// including abandoned staging directories. Generations retained by
    /// [`Self::retain_unverified`] are kept. Callers must ensure no process
    /// still runs from a retired generation. Returns how many were removed.
    pub fn prune_inactive(&self) -> Result<usize> {
        let Some(record) = self.record()? else {
            return Ok(0);
        };
        let keep = [Some(record.current), record.previous];
        let entries = match fs::read_dir(self.root.join("generations")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("generation-")
                || keep.iter().flatten().any(|kept| kept == name)
                || !entry.file_type()?.is_dir()
                || entry.path().join(RETAINED_MARKER).exists()
            {
                continue;
            }
            fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn rollback(&self) -> Result<PathBuf> {
        let record = self
            .record()?
            .context("no runtime generation to roll back")?;
        let previous = record.previous.context("no previous runtime generation")?;
        let directory = self.generation(&previous)?;
        self.publish(&ActiveGeneration {
            current: previous,
            previous: Some(record.current),
        })?;
        Ok(directory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_preparation_leaves_legacy_and_active_install_untouched() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("legacy"), "old").unwrap();
        let store = RuntimeGenerations::new(root.path().to_path_buf());
        {
            let stage = store.stage().unwrap();
            fs::write(stage.path().join("partial"), "broken").unwrap();
        }
        assert_eq!(store.active_dir().unwrap(), root.path());
        let stage = store.stage().unwrap();
        fs::write(stage.path().join("version"), "1").unwrap();
        let first = store.activate(stage).unwrap();
        {
            let stage = store.stage().unwrap();
            fs::write(stage.path().join("partial"), "broken").unwrap();
        }
        assert_eq!(store.active_dir().unwrap(), first);
        assert_eq!(fs::read_to_string(first.join("version")).unwrap(), "1");
        assert_eq!(store.rollback().unwrap(), root.path());
    }

    #[test]
    fn switching_and_rollback_retain_complete_old_dependency_trees() {
        let root = tempfile::tempdir().unwrap();
        let store = RuntimeGenerations::new(root.path().to_path_buf());
        let first = store.stage().unwrap();
        fs::write(first.path().join("version"), "1").unwrap();
        let first = store.activate(first).unwrap();
        let second = store.stage().unwrap();
        fs::write(second.path().join("version"), "2").unwrap();
        let second = store.activate(second).unwrap();
        assert_eq!(store.active_dir().unwrap(), second);
        assert_eq!(fs::read_to_string(first.join("version")).unwrap(), "1");
        assert_eq!(store.rollback().unwrap(), first);
        assert_eq!(store.active_dir().unwrap(), first);
        assert_eq!(fs::read_to_string(second.join("version")).unwrap(), "2");
    }

    #[test]
    fn pruning_keeps_only_active_and_rollback_generations() {
        let root = tempfile::tempdir().unwrap();
        let store = RuntimeGenerations::new(root.path().to_path_buf());
        assert_eq!(store.prune_inactive().unwrap(), 0);
        let mut active = Vec::new();
        for version in ["1", "2", "3"] {
            let stage = store.stage().unwrap();
            fs::write(stage.path().join("version"), version).unwrap();
            active.push(store.activate(stage).unwrap());
        }
        let abandoned = store.stage().unwrap().keep();
        let retained = store.retain_unverified(store.stage().unwrap()).unwrap();
        fs::write(root.path().join("generations/generation-note"), "file").unwrap();
        assert_eq!(store.prune_inactive().unwrap(), 2);
        assert!(!active[0].exists() && !abandoned.exists());
        assert!(
            retained.is_dir(),
            "an unverified generation must survive pruning"
        );
        assert!(root.path().join("generations/generation-note").is_file());
        assert_eq!(store.active_dir().unwrap(), active[2]);
        assert_eq!(store.rollback().unwrap(), active[1]);
    }

    #[test]
    fn corrupt_or_traversing_pointer_never_falls_back_to_another_runtime() {
        let root = tempfile::tempdir().unwrap();
        let store = RuntimeGenerations::new(root.path().to_path_buf());
        for pointer in [
            "invalid",
            r#"{"current":"../../foreign","previous":null}"#,
            r#"{"current":"generation-missing","previous":null}"#,
        ] {
            fs::write(root.path().join("active.json"), pointer).unwrap();
            assert!(store.active_dir().is_err());
        }
    }

    #[test]
    fn a_foreign_node_generation_cannot_be_published() {
        let local = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let store = RuntimeGenerations::new(local.path().to_path_buf());
        let other = RuntimeGenerations::new(foreign.path().to_path_buf());
        let staged = other.stage().unwrap();
        assert!(store.activate(staged).is_err());
        assert_eq!(store.active_dir().unwrap(), local.path());
    }
}

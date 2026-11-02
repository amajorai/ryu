//! `versions.json`: which engine/tool version (and checksum) each install recorded.

use anyhow::Result;
use semver::Version;
use serde::{Deserialize, Serialize};

use super::versions_path;

// ── Version store ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionStore {
    #[serde(default)]
    pub versions: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub checksums: std::collections::HashMap<String, String>,
}

/// Process-wide lock guarding the read-modify-write cycle on `versions.json`.
///
/// Installs run concurrently (each `install_sidecar` request spawns a task), and
/// every downloader does `VersionStore::load()` → mutate → `save()`. Without this
/// lock two overlapping installs would each load the same snapshot and the last
/// `save()` would clobber the other engine's freshly written entry — meaning
/// installing a second local engine could drop the first from `versions.json`.
/// Serialize the whole cycle so multiple engines can be installed side by side.
static VERSIONS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl VersionStore {
    pub fn load() -> Self {
        let path = versions_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = versions_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        // Atomic: lock-free readers (`load`) must never see a half-written file,
        // which parses as an empty store and reports every engine uninstalled. A
        // crash mid-write must not leave a truncated `versions.json` either, and
        // each save uses its own temp file, so two concurrent saves never share one.
        crate::atomic_file::write_atomic(&path, json.as_bytes())?;
        Ok(())
    }

    /// Atomically record one engine's version + checksum into `versions.json`.
    ///
    /// Reloads the latest on-disk store under [`VERSIONS_LOCK`], applies just this
    /// one key, and saves — so a concurrent install of another engine is never
    /// clobbered. Prefer this over `load()` → `record()` → `save()` in install paths.
    pub fn record_persisted(name: &str, version: &str, checksum: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.record(name, version, checksum);
        store.save()
    }

    /// Atomically set one engine's version (no checksum) in `versions.json`.
    ///
    /// Same concurrency guarantee as [`record_persisted`]; use for engines that
    /// only track a version string.
    pub fn set_version_persisted(name: &str, version: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.versions.insert(name.to_string(), version.to_string());
        store.save()
    }

    /// Atomically remove one engine's version + checksum from `versions.json`.
    ///
    /// Same lock as the install helpers, so uninstalling one engine never drops
    /// another engine being installed concurrently.
    pub fn remove_persisted(name: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.versions.remove(name);
        store.checksums.remove(name);
        store.save()
    }

    pub fn installed_version(&self, name: &str) -> Option<Version> {
        self.versions.get(name)?.parse().ok()
    }

    pub fn installed_checksum(&self, name: &str) -> Option<&str> {
        self.checksums.get(name).map(String::as_str)
    }

    pub fn record(&mut self, name: &str, version: &str, checksum: &str) {
        self.versions.insert(name.to_string(), version.to_string());
        self.checksums
            .insert(name.to_string(), checksum.to_string());
    }
}

#[cfg(test)]
#[path = "version_store_tests.rs"]
mod tests;

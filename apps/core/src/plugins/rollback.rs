//! The one-step rollback snapshot kept across a plugin update.
//!
//! An update replaces exactly two installed artifacts: the on-disk manifest and
//! the bundled `ui_code` in the store (plus the channel pin and the captured
//! provenance). Before the update writes either, the handler saves the previous
//! set here; `POST /api/plugins/:id/rollback` restores it. Only the most recent
//! previous version is kept — a rollback swaps the snapshot with the version it
//! replaced, so a second rollback re-applies the update.
//!
//! The snapshot holds a manifest that was already verified when it was
//! installed, at the same trust level as the installed manifest file it
//! mirrors (both live in the Ryu data directory). It is removed on uninstall.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::plugin_manifest::PluginManifest;
use crate::plugins::isolation::PluginProvenance;

/// The previous installed state of one plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackSnapshot {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub ui_code: Option<String>,
    pub channel: String,
    #[serde(default)]
    pub provenance: Option<PluginProvenance>,
    pub captured_at: String,
}

impl RollbackSnapshot {
    pub fn version(&self) -> &str {
        &self.manifest.version
    }
}

/// The default snapshot directory: `<data dir>/state/plugin-rollback`. Snapshots
/// are durable Core state (the previous version cannot be regenerated), not cache.
pub fn default_dir() -> PathBuf {
    crate::paths::state_path("plugin-rollback")
}

fn snapshot_path(dir: &Path, plugin_id: &str) -> PathBuf {
    dir.join(format!(
        "{}.json",
        crate::plugin_manifest::plugin_dir_name(plugin_id)
    ))
}

/// Persist `snapshot` for its plugin, replacing any previous one. Written to a
/// temporary file and renamed so a crash never leaves a half-written snapshot.
pub async fn save(dir: &Path, snapshot: &RollbackSnapshot) -> Result<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating {}", dir.display()))?;
    let path = snapshot_path(dir, &snapshot.manifest.id);
    let temporary = path.with_extension("json.tmp");
    let json = serde_json::to_vec(snapshot).context("serializing rollback snapshot")?;
    tokio::fs::write(&temporary, json)
        .await
        .with_context(|| format!("writing {}", temporary.display()))?;
    tokio::fs::rename(&temporary, &path)
        .await
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

/// Load the snapshot for `plugin_id`. `Ok(None)` when none exists; a snapshot
/// whose manifest id does not match is treated as absent.
pub async fn load(dir: &Path, plugin_id: &str) -> Result<Option<RollbackSnapshot>> {
    let path = snapshot_path(dir, plugin_id);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("reading {}", path.display()));
        }
    };
    let snapshot: RollbackSnapshot =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    Ok((snapshot.manifest.id == plugin_id).then_some(snapshot))
}

/// Remove the snapshot for `plugin_id` (no-op when absent).
pub async fn remove(dir: &Path, plugin_id: &str) -> Result<()> {
    match tokio::fs::remove_file(snapshot_path(dir, plugin_id)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("removing rollback snapshot"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(id: &str, version: &str) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: "Rollback Fixture".to_owned(),
            version: version.to_owned(),
            ..PluginManifest::default()
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ryu-plugin-rollback-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[tokio::test]
    async fn save_load_replace_and_remove_round_trip() {
        let dir = temp_dir("round-trip");
        assert!(load(&dir, "com.example.app").await.unwrap().is_none());

        let first = RollbackSnapshot {
            manifest: manifest("com.example.app", "1.0.0"),
            ui_code: Some("export const v = 1;".into()),
            channel: "stable".into(),
            provenance: None,
            captured_at: "2026-10-09T00:00:00Z".into(),
        };
        save(&dir, &first).await.unwrap();
        let loaded = load(&dir, "com.example.app").await.unwrap().unwrap();
        assert_eq!(loaded.version(), "1.0.0");
        assert_eq!(loaded.ui_code.as_deref(), Some("export const v = 1;"));

        let second = RollbackSnapshot {
            manifest: manifest("com.example.app", "2.0.0"),
            ui_code: None,
            ..first
        };
        save(&dir, &second).await.unwrap();
        let loaded = load(&dir, "com.example.app").await.unwrap().unwrap();
        assert_eq!(loaded.version(), "2.0.0");
        assert!(loaded.ui_code.is_none());

        assert!(load(&dir, "com.example.other").await.unwrap().is_none());
        remove(&dir, "com.example.app").await.unwrap();
        remove(&dir, "com.example.app").await.unwrap();
        assert!(load(&dir, "com.example.app").await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

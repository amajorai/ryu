// apps/core/src/catalog/mod.rs

pub mod cache;
pub mod github;
pub mod npm;
pub mod registry;

use crate::sidecar::download_manager::VersionStore;
use crate::sidecar::install_state::{InstallState, InstallStatusStore};
use cache::VersionCache;
use registry::{required_platforms, static_registry, supported_on_node, SidecarSource};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Serialize)]
pub struct CatalogItem {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub deprecated: bool,
    pub recommended: bool,
    pub latest_version: Option<String>,
    pub installed_version: Option<String>,
    pub install_state: String,
    /// OS families this entry can run on (e.g. `["macos"]`). Empty = every
    /// platform. Display hint for clients (e.g. a "macOS only" badge).
    pub platforms: Vec<String>,
    /// Whether THIS Core node can actually run/install the entry given its own OS
    /// and CPU arch. Authoritative: a client (which may be a remote desktop) must
    /// disable install/enable when this is `false`, regardless of its own OS.
    pub supported: bool,
}

pub struct CatalogManager {
    client: reqwest::Client,
    cache: Arc<Mutex<VersionCache>>,
}

impl CatalogManager {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            cache: Arc::new(Mutex::new(VersionCache::load())),
        }
    }

    pub async fn get_catalog(&self, install_status: &InstallStatusStore) -> Vec<CatalogItem> {
        let versions = self.resolve_versions().await;
        let install_states = install_status.get_all().await;
        let version_store = VersionStore::load();

        static_registry()
            .into_iter()
            .map(|entry| {
                let latest_version = versions.get(entry.name).cloned();
                let raw_state = install_states
                    .get(entry.name)
                    .cloned()
                    .unwrap_or(InstallState::NotInstalled);

                let (install_state, installed_version) = match &raw_state {
                    InstallState::Installing { .. } => ("installing".to_string(), None),
                    InstallState::Failed { .. } => ("failed".to_string(), None),
                    InstallState::Installed { version, .. } => {
                        ("installed".to_string(), Some(version.clone()))
                    }
                    InstallState::NotInstalled => {
                        // Installed in a previous core session — check versions.json
                        if let Some(v) = version_store.versions.get(entry.name) {
                            ("installed".to_string(), Some(v.clone()))
                        } else {
                            ("not_installed".to_string(), None)
                        }
                    }
                };

                CatalogItem {
                    name: entry.name.to_string(),
                    display_name: entry.display_name.to_string(),
                    description: entry.description.to_string(),
                    category: entry.category.as_str().to_string(),
                    deprecated: entry.deprecated,
                    recommended: entry.recommended,
                    latest_version,
                    installed_version,
                    install_state,
                    platforms: required_platforms(entry.name)
                        .iter()
                        .map(|p| (*p).to_string())
                        .collect(),
                    supported: supported_on_node(entry.name),
                }
            })
            .collect()
    }

    /// Returns latest versions from cache, fetching from remote if stale.
    async fn resolve_versions(&self) -> HashMap<String, String> {
        let mut cache = self.cache.lock().await;
        if cache.is_fresh() {
            return cache.versions.clone();
        }

        // Fetch versions for github and npm sources concurrently
        let entries = static_registry();
        let mut tasks = Vec::new();

        for entry in &entries {
            let client = self.client.clone();
            let name = entry.name.to_string();
            let source = entry.source.clone();
            tasks.push(tokio::spawn(async move {
                let version = match source {
                    SidecarSource::Github { repo } => {
                        github::fetch_latest_version(&client, repo).await.ok()
                    }
                    SidecarSource::Npm { package } => {
                        npm::fetch_latest_version(&client, package).await.ok()
                    }
                    // Docker and Pip version resolution not yet implemented
                    _ => None,
                };
                (name, version)
            }));
        }

        let mut versions = cache.versions.clone();
        for task in tasks {
            if let Ok((name, Some(version))) = task.await {
                versions.insert(name, version);
            }
        }

        cache.versions = versions.clone();
        cache.mark_fresh();
        let _ = cache.save();

        versions
    }
}

impl Default for CatalogManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::install_state::InstallStatusStore;

    #[tokio::test]
    async fn get_catalog_returns_all_entries() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        let items = manager.get_catalog(&store).await;
        // get_catalog is a 1:1 map of the static registry (no filtering), so the
        // counts must stay in lock-step — assert against the registry length
        // rather than a magic number that drifts when entries are added.
        assert_eq!(items.len(), super::registry::static_registry().len());
    }

    #[tokio::test]
    async fn mlx_is_platform_gated() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        let items = manager.get_catalog(&store).await;
        let mlx = items.iter().find(|i| i.name == "mlx").unwrap();
        // Display hint always present; the node-computed `supported` flag matches
        // whether this build targets Apple Silicon.
        assert_eq!(mlx.platforms, vec!["macos".to_string()]);
        let apple_silicon = cfg!(target_os = "macos") && cfg!(target_arch = "aarch64");
        assert_eq!(mlx.supported, apple_silicon);

        // Unconstrained engines are supported on every node.
        let llamacpp = items.iter().find(|i| i.name == "llamacpp").unwrap();
        assert!(llamacpp.platforms.is_empty());
        assert!(llamacpp.supported);
    }

    #[tokio::test]
    async fn not_installed_sidecar_has_correct_state() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        let items = manager.get_catalog(&store).await;
        let zeroclaw = items.iter().find(|i| i.name == "zeroclaw").unwrap();
        // In test environment, nothing is installed via InstallStatusStore
        assert!(zeroclaw.install_state == "not_installed" || zeroclaw.install_state == "installed");
    }

    #[tokio::test]
    async fn installing_state_propagates() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        store.set_installing("ghost").await;
        let items = manager.get_catalog(&store).await;
        let ghost = items.iter().find(|i| i.name == "ghost").unwrap();
        assert_eq!(ghost.install_state, "installing");
    }

    #[tokio::test]
    async fn installed_state_propagates_with_version() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        store.set_installed("ghost", "1.5.0".to_string()).await;
        let items = manager.get_catalog(&store).await;
        let ghost = items.iter().find(|i| i.name == "ghost").unwrap();
        assert_eq!(ghost.install_state, "installed");
        assert_eq!(ghost.installed_version, Some("1.5.0".to_string()));
    }
}

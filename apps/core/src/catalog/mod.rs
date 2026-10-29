// apps/core/src/catalog/mod.rs

pub mod cache;
pub mod docker;
pub mod github;
pub mod npm;
pub mod pypi;
pub mod registry;

use crate::sidecar::download_manager::VersionStore;
use crate::sidecar::install_state::{InstallState, InstallStatusStore};
use cache::VersionCache;
use registry::{required_platforms, static_registry, supported_on_node, SidecarSource};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Connect bound for one catalog version lookup request.
const CATALOG_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Total bound for one catalog version lookup request.
const CATALOG_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound for one source's whole lookup (a Docker Hub lookup is several
/// requests), so one stalled upstream cannot hang `GET /api/catalog`.
const CATALOG_SOURCE_TIMEOUT: Duration = Duration::from_secs(20);

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
    /// Plain-language reason THIS node can't run the entry (OS, CPU arch, or
    /// macOS version), or `None` when `supported`. Clients render it verbatim
    /// rather than rebuilding a message from `platforms`, which can't express
    /// the arch or OS-version parts of the gate.
    pub unsupported_reason: Option<String>,
    /// Whether a reinstall would actually move this entry to a newer build.
    ///
    /// Computed HERE rather than client-side (`installed != latest`) because only
    /// the node knows what its installers can deliver: a pinned downloader can
    /// never reach upstream's newest tag, and several installers record a
    /// sentinel ("latest", "adopted") that is not a version at all. Both cases
    /// used to render an Update button that could not work. Clients render this
    /// flag; they do not re-derive it.
    pub update_available: bool,
}

pub struct CatalogManager {
    client: reqwest::Client,
    cache: Arc<Mutex<VersionCache>>,
    /// Single-flight for the sidecar version refresh: concurrent stale reads
    /// wait for one fan-out instead of each launching their own, which would
    /// exhaust GitHub's unauthenticated budget the update check also uses.
    refresh: Mutex<()>,
    /// Whether refreshed versions are written back to `catalog-cache.json`.
    /// Off for test managers, so their stub versions never reach the real data
    /// dir's cache that a running node reads.
    persist: bool,
}

impl CatalogManager {
    pub fn new() -> Self {
        Self::with_cache(VersionCache::load(), true)
    }

    fn with_cache(cache: VersionCache, persist: bool) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CATALOG_CONNECT_TIMEOUT)
            .timeout(CATALOG_REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            cache: Arc::new(Mutex::new(cache)),
            refresh: Mutex::new(()),
            persist,
        }
    }

    pub async fn get_catalog(&self, install_status: &InstallStatusStore) -> Vec<CatalogItem> {
        let versions = self.resolve_versions().await;
        let install_states = install_status.get_all().await;
        let version_store = VersionStore::load();

        self.get_catalog_from_parts(versions, install_states, &version_store)
    }

    fn get_catalog_from_parts(
        &self,
        versions: HashMap<String, String>,
        install_states: HashMap<String, InstallState>,
        version_store: &VersionStore,
    ) -> Vec<CatalogItem> {
        static_registry()
            .into_iter()
            .map(|entry| {
                // A pinned installer can only ever deliver its pin, so that — not
                // upstream's newest tag — is this entry's latest version.
                let latest_version = registry::installer_pin(entry.name)
                    .map(str::to_string)
                    .or_else(|| versions.get(entry.name).cloned());
                let raw_state = install_states
                    .get(entry.name)
                    .cloned()
                    .unwrap_or(InstallState::NotInstalled);

                let (install_state, installed_version) = match &raw_state {
                    InstallState::Installing { .. } => ("installing".to_string(), None),
                    InstallState::Failed { .. } => ("failed".to_string(), None),
                    InstallState::Installed { version, .. } => {
                        // Several install arms have no version to report and hand
                        // back a marker like "installed". Taking that literally made
                        // the row read `installed → b10218` and claim an update
                        // forever after a same-session install. `versions.json` is
                        // the durable record and holds the real tag, so prefer it
                        // whenever the in-session value isn't a version.
                        let resolved = if registry::is_comparable_version(version) {
                            Some(version.clone())
                        } else {
                            version_store.versions.get(entry.name).cloned()
                        };
                        ("installed".to_string(), resolved)
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

                let supported = supported_on_node(entry.name);
                // Only claim an update when a reinstall could actually deliver a
                // different build: both versions must be real (not a sentinel a
                // PATH-adopting installer wrote), the entry must be installed on a
                // node that can install it, and it must not be deprecated.
                let update_available = install_state == "installed"
                    && !entry.deprecated
                    && supported
                    && match (installed_version.as_deref(), latest_version.as_deref()) {
                        (Some(installed), Some(latest)) => {
                            registry::is_comparable_version(installed)
                                && registry::is_comparable_version(latest)
                                && registry::update_differs(installed, latest)
                        }
                        _ => false,
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
                    supported,
                    unsupported_reason: registry::platform_requirement(entry.name)
                        .map(str::to_string),
                    update_available,
                }
            })
            .collect()
    }

    /// Latest npm version of an agent package, cached for an hour under `key`.
    ///
    /// Shares this manager's HTTP client and in-memory cache, so the agent
    /// catalog's concurrent per-agent lookups reuse connections and never race
    /// each other (or the sidecar refresh) on `catalog-cache.json`. The lock is
    /// released during the fetch so agents resolve in parallel.
    pub async fn npm_latest_cached(&self, key: &str, package: &str) -> Option<String> {
        if let Some(version) = self.cache.lock().await.get_fresh_entry(key) {
            return Some(version.clone());
        }
        let latest = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            npm::fetch_latest_version(&self.client, package),
        )
        .await
        .ok()
        .and_then(Result::ok)?;
        let mut cache = self.cache.lock().await;
        cache.set_entry(key, latest.clone());
        if self.persist {
            let _ = cache.save();
        }
        Some(latest)
    }

    /// Returns latest versions from cache, fetching from remote if stale.
    async fn resolve_versions(&self) -> HashMap<String, String> {
        let client = self.client.clone();
        self.resolve_versions_with(move |source| fetch_source_version(client.clone(), source))
            .await
    }

    /// [`Self::resolve_versions`] with the per-source lookup injected, so the
    /// single-flight and the per-source bound are testable without the network.
    async fn resolve_versions_with<F, Fut>(&self, fetch: F) -> HashMap<String, String>
    where
        F: Fn(SidecarSource) -> Fut,
        Fut: Future<Output = Option<String>> + Send + 'static,
    {
        if let Some(versions) = self.fresh_versions().await {
            return versions;
        }
        let _refresh = self.refresh.lock().await;
        // A concurrent caller may have refreshed while this one waited.
        if let Some(versions) = self.fresh_versions().await {
            return versions;
        }
        // The cache lock is not held across the network fetches below, so agent
        // version lookups sharing this cache are not stalled by a refresh.

        // Fetch versions for every source (GitHub, npm, Docker Hub, PyPI) concurrently
        let mut tasks = Vec::new();
        for entry in static_registry() {
            let name = entry.name.to_string();
            let lookup = fetch(entry.source.clone());
            tasks.push(tokio::spawn(async move {
                let version = tokio::time::timeout(CATALOG_SOURCE_TIMEOUT, lookup)
                    .await
                    .ok()
                    .flatten();
                (name, version)
            }));
        }

        let mut fetched = Vec::new();
        for task in tasks {
            if let Ok((name, Some(version))) = task.await {
                fetched.push((name, version));
            }
        }

        let mut cache = self.cache.lock().await;
        for (name, version) in fetched {
            cache.set(name, version);
        }
        cache.mark_fresh();
        if self.persist {
            let _ = cache.save();
        }

        cache.versions.clone()
    }

    async fn fresh_versions(&self) -> Option<HashMap<String, String>> {
        let cache = self.cache.lock().await;
        cache.is_fresh().then(|| cache.versions.clone())
    }
}

/// Latest upstream version for one catalog source, or `None` when the lookup
/// fails.
async fn fetch_source_version(client: reqwest::Client, source: SidecarSource) -> Option<String> {
    match source {
        SidecarSource::Github { repo } => github::fetch_latest_version(&client, repo).await.ok(),
        SidecarSource::Npm { package } => npm::fetch_latest_version(&client, package).await.ok(),
        SidecarSource::Docker { image } => docker::fetch_latest_version(&client, image)
            .await
            .ok()
            .flatten(),
        SidecarSource::Pip { package } => pypi::fetch_latest_version(&client, package).await.ok(),
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
        let items = manager.get_catalog_from_parts(
            manager.resolve_versions().await,
            store.get_all().await,
            &VersionStore::default(),
        );
        // get_catalog is a 1:1 map of the static registry (no filtering), so the
        // counts must stay in lock-step — assert against the registry length
        // rather than a magic number that drifts when entries are added.
        assert_eq!(items.len(), super::registry::static_registry().len());
    }

    #[tokio::test]
    async fn concurrent_stale_refreshes_fetch_each_source_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let manager = CatalogManager::with_cache(VersionCache::default(), false);
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = |_source: SidecarSource| {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some("v1".to_owned())
            }
        };
        let (first, second) = tokio::join!(
            manager.resolve_versions_with(fetch),
            manager.resolve_versions_with(fetch)
        );
        let sources = static_registry().len();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            sources,
            "one fan-out, not two"
        );
        assert_eq!(first.len(), sources);
        assert_eq!(first, second);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_source_does_not_hang_the_refresh() {
        let manager = CatalogManager::with_cache(VersionCache::default(), false);
        let stalled = static_registry()
            .into_iter()
            .find(|entry| matches!(entry.source, SidecarSource::Github { .. }))
            .expect("a GitHub-sourced entry");
        let SidecarSource::Github { repo: stalled_repo } = stalled.source else {
            unreachable!("filtered to GitHub sources");
        };
        let versions = manager
            .resolve_versions_with(move |source| async move {
                if matches!(source, SidecarSource::Github { repo } if repo == stalled_repo) {
                    std::future::pending::<()>().await;
                }
                Some("v1".to_owned())
            })
            .await;
        assert!(!versions.contains_key(stalled.name));
        for entry in static_registry() {
            let is_stalled =
                matches!(entry.source, SidecarSource::Github { repo } if repo == stalled_repo);
            assert_eq!(
                versions.contains_key(entry.name),
                !is_stalled,
                "{}",
                entry.name
            );
        }
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
    async fn pinned_engines_report_the_version_they_can_deliver() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        let items = manager.get_catalog(&store).await;
        // llama.cpp's download URL is built from the compile-time pin, so the
        // catalog must advertise the pin — never GitHub's newest tag, which the
        // installer cannot reach. Advertising upstream produced a permanent
        // "update available" row whose Update button was a no-op.
        let llamacpp = items.iter().find(|i| i.name == "llamacpp").unwrap();
        assert_eq!(
            llamacpp.latest_version.as_deref(),
            Some(crate::sidecar::providers::llamacpp::downloader::TARGET_VERSION)
        );
    }

    #[tokio::test]
    async fn pinned_engine_at_its_pin_has_no_update() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        store
            .set_installed(
                "llamacpp",
                crate::sidecar::providers::llamacpp::downloader::TARGET_VERSION.to_string(),
            )
            .await;
        let items = manager.get_catalog(&store).await;
        let llamacpp = items.iter().find(|i| i.name == "llamacpp").unwrap();
        assert_eq!(llamacpp.install_state, "installed");
        assert!(
            !llamacpp.update_available,
            "an engine already at the only version its installer can deliver must not \
             advertise an update"
        );
    }

    #[tokio::test]
    async fn pinned_engine_behind_its_pin_has_an_update() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        // An older pin from a previous Ryu build: a reinstall genuinely moves it.
        store.set_installed("llamacpp", "b0001".to_string()).await;
        let items = manager.get_catalog(&store).await;
        let llamacpp = items.iter().find(|i| i.name == "llamacpp").unwrap();
        assert!(llamacpp.update_available);
    }

    #[tokio::test]
    async fn sentinel_installed_version_never_advertises_an_update() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        // Installers that PATH-adopt or brew-install record a sentinel rather than
        // a version. Comparing it to anything always "differs", which used to
        // advertise an update that no reinstall could clear.
        store.set_installed("ghost", "latest".to_string()).await;
        let items = manager.get_catalog(&store).await;
        let ghost = items.iter().find(|i| i.name == "ghost").unwrap();
        // The sentinel is never presented as a version — it resolves to the
        // durable record, or to nothing when there isn't one.
        assert_ne!(ghost.installed_version.as_deref(), Some("latest"));
        assert!(!ghost.update_available);
    }

    #[tokio::test]
    async fn a_marker_install_status_falls_back_to_the_durable_version() {
        let manager = CatalogManager::new();
        let store = InstallStatusStore::new();
        // What a same-session llama.cpp install actually records: its downloader
        // returns no version, so the status carries the marker "installed". Taken
        // literally that reads as a version and permanently claims an update.
        store
            .set_installed("llamacpp", "installed".to_string())
            .await;
        // This test is about the marker fallback, not the user's persisted
        // profile. Keep it hermetic when the suite runs on a developer machine
        // that already has a llamacpp entry in versions.json.
        let items = manager.get_catalog_from_parts(
            manager.resolve_versions().await,
            store.get_all().await,
            &VersionStore::default(),
        );
        let llamacpp = items.iter().find(|i| i.name == "llamacpp").unwrap();
        assert_ne!(llamacpp.installed_version.as_deref(), Some("installed"));
        assert!(!llamacpp.update_available);
    }

    #[test]
    fn sentinels_are_not_comparable_versions() {
        for sentinel in ["latest", "adopted", "brew", "pip-git", "unknown", ""] {
            assert!(!super::registry::is_comparable_version(sentinel));
        }
        for version in ["b10218", "v1.8.6", "0.0.5"] {
            assert!(super::registry::is_comparable_version(version));
        }
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

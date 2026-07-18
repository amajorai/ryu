//! App catalog client: browse installable apps from a remote registry JSON.
//!
//! ## Core-vs-Gateway boundary
//!
//! Browsing the catalog is a *discovery* concern (what apps *exist* to install),
//! which is Core's "what runs" side. The registry JSON is a static manifest list
//! fetched over HTTPS and TTL-cached in-process; no policy decision happens here.
//! Grant *enforcement* (what an installed app is *allowed* to do) stays in the
//! Gateway, applied at enable time by [`crate::plugins::lifecycle::enable_app`].
//!
//! ## Resilience
//!
//! The remote fetch is best-effort: on network failure or a parse error the
//! client falls back to a stale cache if present, else an empty list. The
//! built-in apps are always discoverable via `GET /api/apps` regardless of
//! catalog availability, so an offline machine still sees Ghost/Shadow/etc.
//!
//! ## Dependency-aware install (the closure planner)
//!
//! A catalog install is not one plugin: it is the plugin **plus every dependency
//! it declares** ([`crate::plugin_manifest::Requires`]). Installing the target
//! alone leaves the user stuck — `enable_app` then fails closed with
//! `MissingDependency` on a plugin they cannot fix from the UI.
//!
//! [`plan_install_closure`] turns "install X" into the ordered list of plugins to
//! actually install, and [`install_closure`] performs it with rollback. Neither
//! re-derives dependency logic: the ordering, cycle detection, and `min_version`
//! comparison all come from [`crate::plugins::graph::resolve_enable_order`], which
//! is the ONE resolver (it in turn uses the ONE semver parser,
//! [`crate::plugin_manifest::parse_min_version`], where a bare `"1.2.0"` means
//! `>=1.2.0`). The planner's only job is to hand that resolver the right manifest
//! set — installed ∪ catalog-fetched — and then subtract what is already present.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::plugin_manifest::{PluginManifest, Requires, Surface};
use crate::plugins::graph::{resolve_enable_order, DependencyError};

/// Hard cap on how many plugins one catalog install may pull in (target +
/// transitive dependencies). A hostile or misauthored catalog cannot make Core
/// walk an unbounded chain of remote fetches. Cycles are already terminated by
/// the discovery walk's visited-set and reported by [`resolve_enable_order`];
/// this is the belt to that braces.
pub const MAX_INSTALL_CLOSURE: usize = 64;

const DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/amajorai/ryu/main/registry/registry.json";
const CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// A single installable-app entry in the remote registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Either `"builtin"` or an `https://` URL to the app's `ryu.json`.
    pub source: String,
    pub kinds: Vec<String>,
    #[serde(default)]
    pub permission_grants: Vec<String>,
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub tags: Vec<String>,

    /// The plugins this one depends on, mirrored from the manifest's `requires`.
    /// Absent = no dependencies (the case for every entry that predates this
    /// field). Carrying it on the entry is what lets a browse surface say "also
    /// installs: X, Y" *before* the install, and what makes the entry a faithful
    /// projection of the manifest rather than a lossy summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requires>,

    /// The host surfaces this plugin declares support for, mirrored from the
    /// manifest's `targets`.
    ///
    /// **Empty means EVERY surface**, never "none" — the same load-bearing
    /// backward-compatible default as
    /// [`PluginManifest::supports_surface`](crate::plugin_manifest::PluginManifest::supports_surface),
    /// whose definition remains the only one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<Surface>,
}

/// Top-level shape of the remote `registry.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryResponse {
    #[allow(dead_code)]
    version: String,
    entries: Vec<CatalogEntry>,
}

/// Response returned by `GET /api/apps/catalog`. `source` is one of
/// `"remote"`, `"cache"`, `"stale-cache"`, or `"fallback"` so clients can
/// surface freshness.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogResponse {
    pub entries: Vec<CatalogEntry>,
    pub cached: bool,
    pub source: String,
}

struct CacheEntry {
    entries: Vec<CatalogEntry>,
    fetched_at: Instant,
}

/// Fetches and TTL-caches the remote app registry. Cheap to clone (`Arc` inside).
pub struct PluginCatalogClient {
    registry_url: String,
    cache: Arc<Mutex<Option<CacheEntry>>>,
    http: reqwest::Client,
}

impl PluginCatalogClient {
    /// Construct a client. The registry URL is overridable via
    /// `RYU_APP_REGISTRY_URL` (used by tests and self-hosters).
    pub fn new() -> Self {
        let registry_url = std::env::var("RYU_APP_REGISTRY_URL")
            .unwrap_or_else(|_| DEFAULT_REGISTRY_URL.to_string());
        Self {
            registry_url,
            cache: Arc::new(Mutex::new(None)),
            http: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .build()
                .unwrap_or_default(),
        }
    }

    /// Return the catalog, serving a fresh in-process cache when available and
    /// falling back to stale cache or an empty list when the remote is down.
    pub async fn fetch_catalog(&self) -> CatalogResponse {
        let mut cache = self.cache.lock().await;

        // Serve a fresh cached result.
        if let Some(ref entry) = *cache {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return CatalogResponse {
                    entries: entry.entries.clone(),
                    cached: true,
                    source: "cache".to_string(),
                };
            }
        }

        // Attempt a remote refresh.
        match self.http.get(&self.registry_url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<RegistryResponse>().await {
                Ok(registry) => {
                    *cache = Some(CacheEntry {
                        entries: registry.entries.clone(),
                        fetched_at: Instant::now(),
                    });
                    CatalogResponse {
                        entries: registry.entries,
                        cached: false,
                        source: "remote".to_string(),
                    }
                }
                Err(e) => {
                    tracing::warn!("failed to parse app registry response: {e}");
                    Self::fallback_catalog(cache)
                }
            },
            Ok(resp) => {
                tracing::warn!("app registry returned status {}", resp.status());
                Self::fallback_catalog(cache)
            }
            Err(e) => {
                tracing::warn!(
                    "failed to fetch app registry from {}: {e}",
                    self.registry_url
                );
                Self::fallback_catalog(cache)
            }
        }
    }

    fn fallback_catalog(cache: tokio::sync::MutexGuard<'_, Option<CacheEntry>>) -> CatalogResponse {
        if let Some(ref entry) = *cache {
            return CatalogResponse {
                entries: entry.entries.clone(),
                cached: true,
                source: "stale-cache".to_string(),
            };
        }
        CatalogResponse {
            entries: vec![],
            cached: false,
            source: "fallback".to_string(),
        }
    }
}

impl Default for PluginCatalogClient {
    fn default() -> Self {
        Self::new()
    }
}

// ── Dependency-aware install: plan, then perform with rollback ────────────────

/// Plan the **install closure** for `target_id`: every plugin that must be
/// installed for it to be enableable, in topological order (dependencies first,
/// target last), with the ones already installed subtracted.
///
/// - `installed` — the manifests Core has loaded (built-ins included).
/// - `fetched` — the candidate manifests the caller resolved from the catalog
///   (the target plus, transitively, its declared dependencies).
///
/// The two sets are merged (an INSTALLED manifest always wins over a fetched one
/// of the same id, so a resolved closure can never silently reinstall or
/// downgrade what is already on the machine) and handed to
/// [`resolve_enable_order`], which is the single resolver: it produces the
/// topological order and raises the typed failures —
/// [`DependencyError::MissingDependency`] for a dependency no catalog source could
/// serve (the caller leaves it out of `fetched`, so it is simply absent from the
/// graph), [`DependencyError::VersionMismatch`] for one whose available version is
/// below the declared `min_version`, and [`DependencyError::Cycle`] for a loop in
/// catalog data.
///
/// Returns the manifests to install, in the order to install them. A plugin with
/// no dependencies yields exactly `[target]` — byte-for-byte the pre-dependency
/// behaviour.
pub fn plan_install_closure(
    target_id: &str,
    installed: &[PluginManifest],
    fetched: &[PluginManifest],
) -> Result<Vec<PluginManifest>, DependencyError> {
    let installed_ids: HashSet<&str> = installed.iter().map(|m| m.id.as_str()).collect();

    // The graph the resolver sees: what is installed, plus what the catalog can
    // supply for what is not.
    let mut combined: Vec<PluginManifest> = installed.to_vec();
    for m in fetched {
        if !installed_ids.contains(m.id.as_str()) {
            combined.push(m.clone());
        }
    }

    // Lower capability edges so a required capability's provider is pulled into the
    // install closure too (fetched + installed like any transitive app dep).
    let combined =
        crate::plugins::binding::lower_manifests(&combined, &crate::plugins::binding::active_config());

    // One resolver, one semver comparison, one cycle detector — graph.rs.
    let order = resolve_enable_order(target_id, &combined)?;

    // Subtract the already-installed: they are in the order (the graph is a
    // statement about the whole closure) but installing them again would be a
    // duplicate install, and `persist_installed_plugin` would 409.
    Ok(order
        .into_iter()
        .filter(|id| !installed_ids.contains(id.as_str()))
        .filter_map(|id| fetched.iter().find(|m| m.id == id).cloned())
        .collect())
}

/// A closure install that failed part-way and was rolled back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosureInstallFailure<E> {
    /// The plugin whose install failed.
    pub failed: String,
    /// The underlying failure, verbatim from the installer.
    pub error: E,
    /// The plugins this call had ALREADY installed and has now undone, in the
    /// order they were undone (reverse of install order). Empty when the very
    /// first install failed.
    pub rolled_back: Vec<String>,
}

/// Install a planned closure in order, **rolling back everything this call
/// installed** if any member fails.
///
/// This is the install-time twin of the two-phase discipline
/// [`crate::plugins::lifecycle::enable_app`] applies at enable time: the user must
/// never be left holding a half-closure — a plugin whose dependency is missing is
/// exactly the dead end this work exists to eliminate, and a *partial* install
/// manufactures one.
///
/// Generic over the installer so the ordering/rollback contract is testable
/// without a filesystem, a store, or a network (see the tests below); the server
/// passes the real persist + undo sinks.
pub async fn install_closure<T, E, I, IFut, R, RFut>(
    order: Vec<PluginManifest>,
    install: I,
    rollback: R,
) -> Result<Vec<(String, T)>, ClosureInstallFailure<E>>
where
    I: Fn(PluginManifest) -> IFut,
    IFut: Future<Output = Result<T, E>>,
    R: Fn(String) -> RFut,
    RFut: Future<Output = ()>,
{
    let mut done: Vec<(String, T)> = Vec::new();
    for manifest in order {
        let id = manifest.id.clone();
        match install(manifest).await {
            Ok(value) => done.push((id, value)),
            Err(error) => {
                // Undo in reverse install order: a dependent is always removed
                // before the dependency it was installed on top of.
                let mut rolled_back = Vec::new();
                for (prev, _) in done.iter().rev() {
                    rollback(prev.clone()).await;
                    rolled_back.push(prev.clone());
                }
                return Err(ClosureInstallFailure {
                    failed: id,
                    error,
                    rolled_back,
                });
            }
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_response_deserializes() {
        let json = r#"{
            "version": "1",
            "entries": [
                {
                    "id": "ghost",
                    "name": "Ghost",
                    "version": "1.0.0",
                    "description": "Desktop automation.",
                    "source": "builtin",
                    "kinds": ["tool"],
                    "permission_grants": [],
                    "built_in": true,
                    "tags": ["automation"]
                }
            ]
        }"#;
        let parsed: RegistryResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].id, "ghost");
        assert!(parsed.entries[0].built_in);
    }

    #[test]
    fn entry_defaults_optional_fields() {
        // permission_grants, built_in, and tags are all optional.
        let json = r#"{
            "id": "minimal",
            "name": "Minimal",
            "version": "0.1.0",
            "description": "x",
            "source": "https://example.com/ryu.json",
            "kinds": ["tool"]
        }"#;
        let entry: CatalogEntry = serde_json::from_str(json).unwrap();
        assert!(entry.permission_grants.is_empty());
        assert!(!entry.built_in);
        assert!(entry.tags.is_empty());
    }

    #[tokio::test]
    async fn fallback_returns_empty_when_no_cache() {
        // Point at an unroutable URL so the fetch fails fast and we exercise the
        // empty-fallback branch deterministically (no network dependency).
        std::env::set_var("RYU_APP_REGISTRY_URL", "https://127.0.0.1:1/registry.json");
        let client = PluginCatalogClient::new();
        std::env::remove_var("RYU_APP_REGISTRY_URL");
        let resp = client.fetch_catalog().await;
        assert!(resp.entries.is_empty());
        assert_eq!(resp.source, "fallback");
    }

    // ── requires / targets on the entry ───────────────────────────────────────

    #[test]
    fn entry_carries_requires_and_targets() {
        let json = r#"{
            "id": "meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "description": "x",
            "source": "builtin",
            "kinds": ["tool"],
            "requires": { "apps": [{ "id": "spaces", "min_version": "1.2.0" }] },
            "targets": ["desktop", "island"]
        }"#;
        let entry: CatalogEntry = serde_json::from_str(json).unwrap();
        let requires = entry.requires.expect("requires round-trips onto the entry");
        assert_eq!(requires.apps.len(), 1);
        assert_eq!(requires.apps[0].id, "spaces");
        assert_eq!(requires.apps[0].min_version.as_deref(), Some("1.2.0"));
        assert_eq!(entry.targets, vec![Surface::Desktop, Surface::Island]);
    }

    #[test]
    fn entry_without_requires_or_targets_defaults_to_none_and_all_surfaces() {
        // Back-compat: a pre-dependency registry entry still parses, declares no
        // dependencies, and (empty targets) runs on EVERY surface.
        let json = r#"{
            "id": "legacy",
            "name": "Legacy",
            "version": "0.1.0",
            "description": "x",
            "source": "builtin",
            "kinds": ["tool"]
        }"#;
        let entry: CatalogEntry = serde_json::from_str(json).unwrap();
        assert!(entry.requires.is_none());
        assert!(
            entry.targets.is_empty(),
            "absent targets must stay empty (= all surfaces), never a closed list"
        );
        // ...and an entry with neither serializes without the keys at all.
        let round = serde_json::to_value(&entry).unwrap();
        assert!(round.get("requires").is_none());
        assert!(round.get("targets").is_none());
    }

    // ── plan_install_closure ──────────────────────────────────────────────────

    /// Build a manifest with the given plugin-to-plugin dependency edges.
    /// `deps` entries are `(id, min_version)`.
    fn m(id: &str, version: &str, deps: &[(&str, Option<&str>)]) -> PluginManifest {
        use crate::plugin_manifest::AppDependency;
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            requires: if deps.is_empty() {
                None
            } else {
                Some(Requires {
                    apps: deps
                        .iter()
                        .map(|(d, mv)| AppDependency {
                            id: (*d).to_owned(),
                            min_version: mv.map(str::to_owned),
                        })
                        .collect(),
                    capabilities: vec![],
                    grants: vec![],
                })
            },
            ..Default::default()
        }
    }

    fn ids(plan: &[PluginManifest]) -> Vec<&str> {
        plan.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn plugin_with_no_dependencies_installs_only_itself() {
        // The backward-compat case: identical to the pre-dependency behaviour.
        let fetched = vec![m("solo", "1.0.0", &[])];
        let plan = plan_install_closure("solo", &[], &fetched).unwrap();
        assert_eq!(ids(&plan), vec!["solo"]);
    }

    #[test]
    fn satisfied_dependency_is_installed_before_the_target() {
        // meetings -> spaces -> storage. Nothing installed; the catalog serves all
        // three. Every dependency must land before whoever needs it.
        let fetched = vec![
            m("meetings", "1.0.0", &[("spaces", Some("1.0.0"))]),
            m("spaces", "1.5.0", &[("storage", None)]),
            m("storage", "2.0.0", &[]),
        ];
        let plan = plan_install_closure("meetings", &[], &fetched).unwrap();
        assert_eq!(ids(&plan), vec!["storage", "spaces", "meetings"]);
    }

    #[test]
    fn missing_dependency_refuses_the_whole_install() {
        // `spaces` is in NO catalog source, so the caller could not fetch it and it
        // is absent from the graph. Nothing may be installed — not even the target.
        let fetched = vec![m("meetings", "1.0.0", &[("spaces", Some("1.2.0"))])];
        let err = plan_install_closure("meetings", &[], &fetched).unwrap_err();
        assert_eq!(
            err,
            DependencyError::MissingDependency {
                plugin: "meetings".to_owned(),
                dependency: "spaces".to_owned(),
                required: Some("1.2.0".to_owned()),
            }
        );
        assert_eq!(err.code(), "missing_dependency");
    }

    #[test]
    fn version_unsatisfiable_dependency_refuses_the_whole_install() {
        // The catalog can serve `spaces`, but only at 1.0.0 — below the declared
        // minimum. Installing it anyway would produce a closure that can never
        // enable, so refuse before touching disk.
        let fetched = vec![
            m("meetings", "1.0.0", &[("spaces", Some("2.0.0"))]),
            m("spaces", "1.0.0", &[]),
        ];
        let err = plan_install_closure("meetings", &[], &fetched).unwrap_err();
        assert_eq!(
            err,
            DependencyError::VersionMismatch {
                plugin: "meetings".to_owned(),
                dependency: "spaces".to_owned(),
                required: "2.0.0".to_owned(),
                installed: "1.0.0".to_owned(),
            }
        );
    }

    #[test]
    fn bare_min_version_is_a_minimum_not_a_caret() {
        // A bare "1.2.0" means >=1.2.0, so a MAJOR-newer 2.0.0 satisfies it. This is
        // `parse_min_version`'s rule, reached through graph.rs — asserted here so a
        // second, caret-defaulting comparison can never creep into the install path.
        let fetched = vec![
            m("meetings", "1.0.0", &[("spaces", Some("1.2.0"))]),
            m("spaces", "2.0.0", &[]),
        ];
        let plan = plan_install_closure("meetings", &[], &fetched).unwrap();
        assert_eq!(ids(&plan), vec!["spaces", "meetings"]);
    }

    #[test]
    fn already_installed_dependency_is_not_installed_twice() {
        // `spaces` is already on the machine at a satisfying version: the plan is
        // the target alone. (The catalog also offers it; the installed manifest
        // wins, so no reinstall and no downgrade.)
        let installed = vec![m("spaces", "1.5.0", &[])];
        let fetched = vec![
            m("meetings", "1.0.0", &[("spaces", Some("1.0.0"))]),
            m("spaces", "1.9.0", &[]),
        ];
        let plan = plan_install_closure("meetings", &installed, &fetched).unwrap();
        assert_eq!(ids(&plan), vec!["meetings"]);
    }

    #[test]
    fn installed_dependency_below_the_minimum_still_refuses() {
        // An installed-but-too-old dependency is a VersionMismatch, not a silent
        // upgrade: Core never replaces an installed plugin behind the user's back.
        let installed = vec![m("spaces", "1.0.0", &[])];
        let fetched = vec![m("meetings", "1.0.0", &[("spaces", Some("2.0.0"))])];
        let err = plan_install_closure("meetings", &installed, &fetched).unwrap_err();
        assert!(matches!(err, DependencyError::VersionMismatch { .. }));
    }

    #[test]
    fn a_cycle_in_catalog_data_is_refused_and_terminates() {
        // Hostile/misauthored catalog: a -> b -> a. Must refuse, must not hang.
        let fetched = vec![
            m("a", "1.0.0", &[("b", None)]),
            m("b", "1.0.0", &[("a", None)]),
        ];
        let err = plan_install_closure("a", &[], &fetched).unwrap_err();
        assert_eq!(err.code(), "cycle");
    }

    #[test]
    fn a_diamond_installs_each_plugin_exactly_once() {
        // top -> {left, right} -> base. `base` must appear once, before both.
        let fetched = vec![
            m("top", "1.0.0", &[("left", None), ("right", None)]),
            m("left", "1.0.0", &[("base", None)]),
            m("right", "1.0.0", &[("base", None)]),
            m("base", "1.0.0", &[]),
        ];
        let plan = plan_install_closure("top", &[], &fetched).unwrap();
        let order = ids(&plan);
        assert_eq!(order.len(), 4, "no plugin installed twice: {order:?}");
        assert_eq!(order[0], "base");
        assert_eq!(order[3], "top");
    }

    // ── install_closure (rollback) ────────────────────────────────────────────

    /// A fake install sink: records what was installed/removed, and fails on the
    /// id given in `fail_on`.
    #[derive(Default)]
    struct FakeInstaller {
        installed: std::sync::Mutex<Vec<String>>,
        removed: std::sync::Mutex<Vec<String>>,
    }

    #[tokio::test]
    async fn a_full_closure_installs_every_member_in_order() {
        let sink = FakeInstaller::default();
        let order = vec![m("base", "1.0.0", &[]), m("top", "1.0.0", &[])];
        let done = install_closure(
            order,
            |manifest| async {
                sink.installed.lock().unwrap().push(manifest.id.clone());
                Ok::<_, String>(manifest.id)
            },
            |id| async {
                sink.removed.lock().unwrap().push(id);
            },
        )
        .await
        .unwrap();

        assert_eq!(
            done.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["base", "top"]
        );
        assert_eq!(*sink.installed.lock().unwrap(), vec!["base", "top"]);
        assert!(sink.removed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_mid_closure_failure_rolls_back_everything_this_call_installed() {
        // base installs, spaces installs, meetings FAILS -> both prior installs are
        // undone, in reverse order, and the caller learns which plugin failed.
        let sink = FakeInstaller::default();
        let order = vec![
            m("base", "1.0.0", &[]),
            m("spaces", "1.0.0", &[]),
            m("meetings", "1.0.0", &[]),
        ];
        let failure = install_closure(
            order,
            |manifest| async {
                if manifest.id == "meetings" {
                    return Err("disk full".to_owned());
                }
                sink.installed.lock().unwrap().push(manifest.id.clone());
                Ok(manifest.id)
            },
            |id| async {
                sink.removed.lock().unwrap().push(id);
            },
        )
        .await
        .unwrap_err();

        assert_eq!(failure.failed, "meetings");
        assert_eq!(failure.error, "disk full");
        // Reverse of install order: the dependent comes off before its dependency.
        assert_eq!(failure.rolled_back, vec!["spaces", "base"]);
        assert_eq!(*sink.removed.lock().unwrap(), vec!["spaces", "base"]);
    }

    #[tokio::test]
    async fn a_first_member_failure_leaves_nothing_to_roll_back() {
        let sink = FakeInstaller::default();
        let order = vec![m("base", "1.0.0", &[])];
        let failure = install_closure(
            order,
            |_m| async { Err::<String, _>("nope".to_owned()) },
            |id| async {
                sink.removed.lock().unwrap().push(id);
            },
        )
        .await
        .unwrap_err();

        assert_eq!(failure.failed, "base");
        assert!(failure.rolled_back.is_empty());
        assert!(sink.removed.lock().unwrap().is_empty());
    }
}

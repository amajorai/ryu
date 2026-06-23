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

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_response_deserializes() {
        let json = r#"{
            "version": "1",
            "entries": [
                {
                    "id": "io.ryu.ghost",
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
        assert_eq!(parsed.entries[0].id, "io.ryu.ghost");
        assert!(parsed.entries[0].built_in);
    }

    #[test]
    fn entry_defaults_optional_fields() {
        // permission_grants, built_in, and tags are all optional.
        let json = r#"{
            "id": "io.ryu.minimal",
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
}

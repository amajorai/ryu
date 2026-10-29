// apps/core/src/catalog/cache.rs

use anyhow::Context;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const CACHE_TTL_SECONDS: i64 = 3600; // 1 hour

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionCache {
    pub fetched_at: Option<DateTime<Utc>>,
    pub versions: HashMap<String, String>,
    /// Per-key fetch times for entries refreshed one at a time (agent npm
    /// packages). `fetched_at` covers the sidecar batch; these keys must not
    /// touch it, or an agent lookup would mark the whole sidecar list fresh.
    #[serde(default)]
    pub entry_fetched_at: HashMap<String, DateTime<Utc>>,
}

impl VersionCache {
    pub fn is_fresh(&self) -> bool {
        self.fetched_at
            .map(|t| Utc::now() - t < Duration::seconds(CACHE_TTL_SECONDS))
            .unwrap_or(false)
    }

    pub fn get(&self, name: &str) -> Option<&String> {
        self.versions.get(name)
    }

    pub fn set(&mut self, name: impl Into<String>, version: impl Into<String>) {
        self.versions.insert(name.into(), version.into());
    }

    pub fn mark_fresh(&mut self) {
        self.fetched_at = Some(Utc::now());
    }

    /// A single-key entry that was fetched within the TTL.
    pub fn get_fresh_entry(&self, name: &str) -> Option<&String> {
        let fetched = self.entry_fetched_at.get(name)?;
        if Utc::now() - *fetched < Duration::seconds(CACHE_TTL_SECONDS) {
            self.versions.get(name)
        } else {
            None
        }
    }

    /// Record a single-key entry with its own fetch time.
    pub fn set_entry(&mut self, name: impl Into<String>, version: impl Into<String>) {
        let name = name.into();
        self.entry_fetched_at.insert(name.clone(), Utc::now());
        self.versions.insert(name, version.into());
    }

    pub fn load() -> Self {
        let path = cache_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = cache_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("create ~/.ryu")?;
        }
        let json = serde_json::to_string_pretty(self).context("serialize cache")?;
        std::fs::write(&path, json).context("write catalog-cache.json")?;
        Ok(())
    }
}

fn cache_path() -> std::path::PathBuf {
    crate::paths::cache_path("catalog-cache.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_cache_reports_fresh() {
        let mut cache = VersionCache::default();
        cache.mark_fresh();
        assert!(cache.is_fresh());
    }

    #[test]
    fn empty_cache_is_not_fresh() {
        let cache = VersionCache::default();
        assert!(!cache.is_fresh());
    }

    #[test]
    fn set_and_get_roundtrip() {
        let mut cache = VersionCache::default();
        cache.set("zeroclaw", "v0.2.0");
        assert_eq!(cache.get("zeroclaw"), Some(&"v0.2.0".to_string()));
        assert_eq!(cache.get("ghost"), None);
    }

    #[test]
    fn single_entries_keep_their_own_freshness() {
        let mut cache = VersionCache::default();
        cache.set_entry("agent:npm:x", "1.2.3");
        assert_eq!(
            cache.get_fresh_entry("agent:npm:x"),
            Some(&"1.2.3".to_string())
        );
        assert!(
            !cache.is_fresh(),
            "an entry must not mark the sidecar batch fresh"
        );
        cache.entry_fetched_at.insert(
            "agent:npm:x".to_string(),
            Utc::now() - Duration::seconds(CACHE_TTL_SECONDS + 1),
        );
        assert_eq!(cache.get_fresh_entry("agent:npm:x"), None);
    }

    #[test]
    fn serializes_and_deserializes() {
        let mut cache = VersionCache::default();
        cache.mark_fresh();
        cache.set("zeroclaw", "v0.2.0");
        let json = serde_json::to_string(&cache).unwrap();
        let back: VersionCache = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("zeroclaw"), Some(&"v0.2.0".to_string()));
        assert!(back.is_fresh());
    }
}

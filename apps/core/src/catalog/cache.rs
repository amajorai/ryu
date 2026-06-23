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
    crate::paths::ryu_dir().join("catalog-cache.json")
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

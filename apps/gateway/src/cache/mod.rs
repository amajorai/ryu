use std::time::{Duration, Instant};

use dashmap::DashMap;
use hex::encode as hex_encode;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::debug;

use crate::config::CacheConfig;

struct CachedEntry {
    response: Value,
    inserted_at: Instant,
}

pub struct Cache {
    entries: DashMap<String, CachedEntry>,
    config: CacheConfig,
}

impl Cache {
    pub fn new(config: CacheConfig) -> Self {
        Self {
            entries: DashMap::new(),
            config,
        }
    }

    /// Build a deterministic cache key from the tenant, model and messages array.
    ///
    /// `org_id` scopes the key per tenant so one org can never be served
    /// another org's cached response. A discriminant byte keeps `None` (no org,
    /// e.g. single-tenant or master key) in its own bucket: it can never collide
    /// with a real org, and two distinct orgs never share a key.
    pub fn make_key(org_id: Option<&str>, model: &str, messages: &Value) -> String {
        let mut hasher = Sha256::new();
        match org_id {
            Some(org) => {
                hasher.update([1u8]);
                hasher.update(org.as_bytes());
            }
            None => hasher.update([0u8]),
        }
        hasher.update(b"\n");
        hasher.update(model.as_bytes());
        hasher.update(b"\n");
        // Use compact serialisation so key is stable regardless of JSON whitespace
        hasher.update(
            serde_json::to_string(messages)
                .unwrap_or_default()
                .as_bytes(),
        );
        hex_encode(hasher.finalize())
    }

    /// Return a cached response if one exists and has not expired.
    pub fn get(&self, key: &str) -> Option<Value> {
        if !self.config.enabled {
            return None;
        }
        let ttl = Duration::from_secs(self.config.ttl_secs);
        self.entries.get(key).and_then(|e| {
            if e.inserted_at.elapsed() < ttl {
                debug!(key, "cache hit");
                Some(e.response.clone())
            } else {
                None
            }
        })
    }

    /// Store a response. Enforces max_entries by evicting the oldest entries when full.
    pub fn insert(&self, key: String, response: Value) {
        if !self.config.enabled {
            return;
        }
        // Simple cap: if at limit, remove ~10 % of entries (oldest by insertion time)
        if self.entries.len() >= self.config.max_entries {
            self.evict_oldest(self.config.max_entries / 10);
        }
        self.entries.insert(
            key,
            CachedEntry {
                response,
                inserted_at: Instant::now(),
            },
        );
    }

    /// Remove all entries whose TTL has elapsed. Called from a background task.
    pub fn evict_expired(&self) {
        if !self.config.enabled {
            return;
        }
        let ttl = Duration::from_secs(self.config.ttl_secs);
        self.entries.retain(|_, e| e.inserted_at.elapsed() < ttl);
    }

    fn evict_oldest(&self, n: usize) {
        // Collect keys with their ages, sort by oldest first, remove the first n
        let mut pairs: Vec<(String, Instant)> = self
            .entries
            .iter()
            .map(|e| (e.key().clone(), e.value().inserted_at))
            .collect();
        pairs.sort_by_key(|(_, t)| *t);
        for (key, _) in pairs.into_iter().take(n) {
            self.entries.remove(&key);
        }
    }
}

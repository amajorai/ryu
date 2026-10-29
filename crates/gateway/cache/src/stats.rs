//! Per-backend cache counters, reported under `cache_backends` in Gateway metrics.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// Relaxed atomic counters a cache backend updates on its hot path.
#[derive(Debug, Default)]
pub struct CacheStats {
    hits: AtomicU64,
    misses: AtomicU64,
    stores: AtomicU64,
    evictions: AtomicU64,
    errors: AtomicU64,
}

/// A point-in-time copy of [`CacheStats`], plus the backend id and (when the
/// backend can report it cheaply) its current size.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CacheStatsSnapshot {
    pub backend: String,
    pub hits: u64,
    pub misses: u64,
    pub stores: u64,
    pub evictions: u64,
    /// Backend failures (for example an unreachable Redis). A failed lookup is
    /// served as a miss and a failed store is dropped; requests never fail.
    pub errors: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

impl CacheStats {
    pub fn hit(&self) {
        self.hits.fetch_add(1, Ordering::Relaxed);
    }
    pub fn miss(&self) {
        self.misses.fetch_add(1, Ordering::Relaxed);
    }
    pub fn stored(&self, n: u64) {
        self.stores.fetch_add(n, Ordering::Relaxed);
    }
    pub fn evicted(&self, n: u64) {
        self.evictions.fetch_add(n, Ordering::Relaxed);
    }
    pub fn error(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Copy the counters out, tagged with `backend`.
    pub fn snapshot(&self, backend: &str) -> CacheStatsSnapshot {
        CacheStatsSnapshot {
            backend: backend.to_owned(),
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            stores: self.stores.load(Ordering::Relaxed),
            evictions: self.evictions.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            entries: None,
            bytes: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_snapshot_and_serialize() {
        let stats = CacheStats::default();
        stats.hit();
        stats.hit();
        stats.miss();
        stats.stored(3);
        stats.evicted(1);
        stats.error();
        let snap = stats.snapshot("redis");
        assert_eq!(
            (
                snap.hits,
                snap.misses,
                snap.stores,
                snap.evictions,
                snap.errors
            ),
            (2, 1, 3, 1, 1)
        );
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["backend"], "redis");
        assert!(json.get("entries").is_none());
    }
}

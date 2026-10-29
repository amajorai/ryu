//! `[embedding_cache]` configuration and store ids.

use serde::{Deserialize, Serialize};

/// Store id for the in-process store.
pub const MEMORY_BACKEND: &str = "memory";
/// Store id for the Redis store.
pub const REDIS_BACKEND: &str = "redis";

fn default_backend() -> String {
    MEMORY_BACKEND.to_owned()
}
fn default_ttl() -> u64 {
    86_400
}
fn default_max_entries() -> usize {
    50_000
}
fn default_max_bytes() -> usize {
    256 * 1024 * 1024
}

/// `[embedding_cache]`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct EmbeddingCacheConfig {
    /// Off by default.
    #[serde(default)]
    pub enabled: bool,
    /// `"memory"` (default) or `"redis"` (needs `RYU_GATEWAY_REDIS_URL`).
    #[serde(default = "default_backend")]
    pub backend: String,
    /// Seconds a cached vector is served. Default: 86400 (one day).
    #[serde(default = "default_ttl")]
    pub ttl_secs: u64,
    /// Memory store: maximum cached vectors. Default: 50000.
    #[serde(default = "default_max_entries")]
    pub max_entries: usize,
    /// Memory store: maximum approximate bytes held. Default: 256 MiB.
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
}

impl Default for EmbeddingCacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backend: default_backend(),
            ttl_secs: default_ttl(),
            max_entries: default_max_entries(),
            max_bytes: default_max_bytes(),
        }
    }
}

impl EmbeddingCacheConfig {
    /// Reject unknown backends and unusable bounds.
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.backend.as_str(), MEMORY_BACKEND | REDIS_BACKEND) {
            return Err(format!(
                "embedding_cache.backend must be \"memory\" or \"redis\", not {:?}",
                self.backend
            ));
        }
        if self.enabled && (self.ttl_secs == 0 || self.max_entries == 0 || self.max_bytes == 0) {
            return Err(
                "embedding_cache.ttl_secs, max_entries, and max_bytes must be positive".to_owned(),
            );
        }
        Ok(())
    }
}

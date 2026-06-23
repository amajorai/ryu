use std::collections::HashMap;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// Single-session in-memory cache for agent tool results.
/// Keyed by `tool_name + sha256(args)` with per-tool TTLs.
pub struct ToolResultCache {
    entries: HashMap<String, CacheEntry>,
}

struct CacheEntry {
    value: serde_json::Value,
    expires_at: Instant,
}

impl ToolResultCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Look up a cached result, evicting stale entries in the process.
    pub fn get(&mut self, tool: &str, args: &serde_json::Value) -> Option<serde_json::Value> {
        self.evict_expired();
        let key = cache_key(tool, args);
        self.entries.get(&key).map(|e| e.value.clone())
    }

    /// Store a result. Silently skips tools that should never be cached
    /// (e.g. screenshots, live AX captures).
    pub fn set(&mut self, tool: &str, args: &serde_json::Value, value: serde_json::Value) {
        let ttl = ttl_for_tool(tool);
        if ttl.is_zero() {
            return; // never cache
        }
        let key = cache_key(tool, args);
        self.entries.insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + ttl,
            },
        );
    }

    /// Remove all expired entries.
    pub fn evict_expired(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, e| e.expires_at > now);
    }

    /// Clear all entries (called at end of agent run).
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl Default for ToolResultCache {
    fn default() -> Self {
        Self::new()
    }
}

fn ttl_for_tool(tool: &str) -> Duration {
    match tool {
        // Never cache live visual outputs
        "capture_live_screenshot" | "ax_screenshot" => Duration::ZERO,
        // AX tree is volatile
        "ax_tree_query" | "ax_inspect" | "ax_element_at" => Duration::from_secs(15),
        // Memory/knowledge lookups are stable within a session
        "get_knowledge" | "get_directives" | "search_summaries" => Duration::from_secs(300),
        "search_hybrid" | "search_visual_memories" => Duration::from_secs(60),
        _ => Duration::from_secs(30),
    }
}

fn cache_key(tool: &str, args: &serde_json::Value) -> String {
    let args_str = serde_json::to_string(args).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update(b":");
    hasher.update(args_str.as_bytes());
    let hash = hasher.finalize();
    format!("{:x}", hash)
}

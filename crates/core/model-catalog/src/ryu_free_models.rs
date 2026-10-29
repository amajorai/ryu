//! The Ryu Router "Free" model ids: which Ryu Router (OpenRouter-catalog)
//! models a user's free credit currently pays for.
//!
//! The control plane publishes them at `GET /api/own-supply/free-models` as
//! `{version, ids[]}` — ids only, never the supplier behind a model. Core
//! refreshes this every 10 minutes and keeps the last good list on disk, so the
//! picker tag survives a restart while offline.
//!
//! UNDER-PROMISES: before the first successful fetch (and with no disk cache)
//! the list is EMPTY — no model is tagged Free rather than tagging one the
//! routing would not serve for free.

use std::path::Path;
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How often Core refreshes the list.
pub const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// The cache file name, relative to the data dir's `cache/` directory (Core
/// resolves it with `paths::cache_path`, i.e. `<data dir>/cache/<CACHE_FILE>`).
pub const CACHE_FILE: &str = "ryu-router-free.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Cached {
    fetched_at: u64,
    version: u64,
    ids: Vec<String>,
}

static CURRENT: RwLock<Option<Cached>> = RwLock::new(None);

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A Ryu Router id has the shape `vendor/model` with no whitespace. Anything
/// else (a bare slot name, a nested upstream id) is dropped, so the cache can
/// never carry a supplier name.
fn is_router_id(id: &str) -> bool {
    let id = id.trim();
    id.len() <= 200
        && id.split_once('/').is_some_and(|(vendor, model)| {
            !vendor.is_empty() && !model.is_empty() && !model.contains('/')
        })
        && !id.chars().any(char::is_whitespace)
}

/// Parse the public projection; `None` when the body is not one.
pub fn parse_free_models(body: &Value) -> Option<(u64, Vec<String>)> {
    let version = body.get("version")?.as_u64()?;
    let mut ids: Vec<String> = body
        .get("ids")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| is_router_id(id))
        .map(|id| id.trim().to_ascii_lowercase())
        .collect();
    ids.sort();
    ids.dedup();
    Some((version, ids))
}

/// The current Free ids (memory, else the disk cache at `cache_path`, else
/// empty). Synchronous: the catalog builder calls it while assembling rows.
pub fn current_ids(cache_path: &Path) -> Vec<String> {
    if let Ok(guard) = CURRENT.read() {
        if let Some(cached) = guard.as_ref() {
            return cached.ids.clone();
        }
    }
    let Some(cached) = std::fs::read(cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cached>(&bytes).ok())
    else {
        return Vec::new();
    };
    let ids: Vec<String> = cached
        .ids
        .iter()
        .filter(|id| is_router_id(id))
        .cloned()
        .collect();
    if let Ok(mut guard) = CURRENT.write() {
        *guard = Some(Cached {
            ids: ids.clone(),
            ..cached
        });
    }
    ids
}

fn store(cache_path: &Path, version: u64, ids: Vec<String>) {
    let cached = Cached {
        fetched_at: now_unix(),
        version,
        ids,
    };
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec(&cached) {
        let tmp = cache_path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, cache_path);
        }
    }
    if let Ok(mut guard) = CURRENT.write() {
        *guard = Some(cached);
    }
}

/// Fetch `{control_plane}/api/own-supply/free-models` and update the cache.
/// Fail-open: an unreachable plane keeps the last good list.
pub async fn refresh(client: &reqwest::Client, control_plane_url: &str, cache_path: &Path) -> bool {
    let url = format!(
        "{}/api/own-supply/free-models",
        control_plane_url.trim_end_matches('/')
    );
    let Ok(response) = client.get(&url).timeout(FETCH_TIMEOUT).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.json::<Value>().await else {
        return false;
    };
    let Some((version, ids)) = parse_free_models(&body) else {
        return false;
    };
    store(cache_path, version, ids);
    true
}

/// Test seam: forget the in-memory list.
#[cfg(test)]
fn reset() {
    if let Ok(mut guard) = CURRENT.write() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_projection_keeps_router_ids_only() {
        let (version, ids) = parse_free_models(&json!({
            "version": 7,
            "ids": [
                "openai/o3", "Anthropic/Claude-Sonnet-4.5", "openai/o3",
                "bedrock", "anthropic-credits", "@cf/meta/llama-3.1-8b-instruct",
                "has space/x", 5
            ]
        }))
        .unwrap();
        assert_eq!(version, 7);
        assert_eq!(ids, ["anthropic/claude-sonnet-4.5", "openai/o3"]);
        assert!(parse_free_models(&json!({"ids": []})).is_none());
    }

    #[test]
    fn empty_before_the_first_fetch_then_cached_on_disk() {
        reset();
        let dir = std::env::temp_dir().join(format!("ryu-free-models-{}", now_unix()));
        let path = dir.join(CACHE_FILE);
        assert!(current_ids(&path).is_empty());
        store(&path, 3, vec!["openai/o3".to_owned()]);
        assert_eq!(current_ids(&path), ["openai/o3"]);
        // A restart (memory gone) reads the disk cache.
        reset();
        assert_eq!(current_ids(&path), ["openai/o3"]);
        let raw = std::fs::read_to_string(&path).unwrap();
        for supplier in ["bedrock", "vertex", "cloudflare", "-credits"] {
            assert!(!raw.contains(supplier), "{raw}");
        }
        std::fs::remove_dir_all(&dir).ok();
        reset();
    }
}

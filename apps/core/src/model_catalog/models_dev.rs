//! models.dev context-window lookup — resolves a model's context window from
//! the public <https://models.dev/api.json> catalog.
//!
//! Placement rationale (Core vs Gateway): this is read-only model metadata used
//! to render a model attribute (the context window, the denominator of the
//! composer's context-usage meter). It is discovery/display data — "what runs" —
//! so it lives in Core with the rest of the catalog, not in the Gateway.
//!
//! Why it exists: local models get their window from the launch config
//! (advanced inference settings), and ACP agents report it live over the
//! protocol. Remote/cloud OpenAI-compatible models have neither, so their
//! context window is unknown and the usage ring can't render. models.dev fills
//! exactly that gap. It is best-effort and fail-open: on any fetch/parse miss we
//! return `None` and the caller simply hides the ring (unchanged behaviour).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
/// Context windows change rarely; a day-long TTL keeps the 3 MB catalog out of
/// the hot path while still picking up new models within a day.
const TTL_SECS: u64 = 24 * 60 * 60;

/// A fetched model-id → context-window map plus the unix-seconds timestamp it
/// was fetched at. Shared by the in-process cache and the on-disk JSON so
/// freshness is decided identically in both places.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedWindows {
    fetched_at: u64,
    /// Lowercased model id (bare and `provider/id`) → context window in tokens.
    windows: HashMap<String, u32>,
}

/// In-process cache. `None` = not loaded this process yet; a present-but-stale
/// entry is refetched on the next lookup.
static CACHE: Mutex<Option<CachedWindows>> = Mutex::const_new(None);

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) < TTL_SECS
}

fn disk_cache_path() -> PathBuf {
    crate::paths::ryu_dir().join("models-dev-cache.json")
}

fn read_disk_cache() -> Option<CachedWindows> {
    let raw = std::fs::read_to_string(disk_cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the on-disk cache atomically (temp + rename). Best-effort; never errors.
fn write_disk_cache(entry: &CachedWindows) {
    let path = disk_cache_path();
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let Ok(json) = serde_json::to_string(entry) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Flatten the models.dev catalog into a lowercased id → context-window map.
/// The catalog is `{ <providerId>: { models: { <modelId>: { limit: { context } } } } }`.
/// We index each model under both its bare id (`gpt-4o`) and a provider-qualified
/// key (`openai/gpt-4o`) so lookups match whether the caller passes a bare or a
/// `provider/model` string (OpenRouter-style). Pure so it is unit-testable.
fn parse_windows(catalog: &Value) -> HashMap<String, u32> {
    let mut out: HashMap<String, u32> = HashMap::new();
    let Some(providers) = catalog.as_object() else {
        return out;
    };
    for (provider_id, provider) in providers {
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model_id, model) in models {
            let Some(context) = model
                .get("limit")
                .and_then(|l| l.get("context"))
                .and_then(Value::as_u64)
            else {
                continue;
            };
            let ctx = context as u32;
            let bare = model_id.to_ascii_lowercase();
            out.insert(
                format!("{}/{}", provider_id.to_ascii_lowercase(), bare),
                ctx,
            );
            // Bare id: keep the largest window on collision across providers
            // (same model, same or larger context — never shrink a known one).
            out.entry(bare)
                .and_modify(|c| *c = (*c).max(ctx))
                .or_insert(ctx);
        }
    }
    out
}

/// Resolve a model string to its context window against a flattened map. Tries,
/// in order: the exact (lowercased) string, then the segment after the last `/`
/// (so `anthropic/claude-opus-4-5` falls back to `claude-opus-4-5`). Pure.
fn match_context(windows: &HashMap<String, u32>, model: &str) -> Option<u32> {
    let key = model.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    if let Some(&c) = windows.get(&key) {
        return Some(c);
    }
    if let Some((_, tail)) = key.rsplit_once('/') {
        if let Some(&c) = windows.get(tail) {
            return Some(c);
        }
    }
    None
}

/// Ensure the window map is loaded (in-process → disk → network), returning a
/// clone. Fail-open: an empty map on any error.
async fn load_windows() -> HashMap<String, u32> {
    let now = now_unix();
    let mut cache = CACHE.lock().await;

    if let Some(entry) = cache.as_ref() {
        if is_fresh(entry.fetched_at, now) {
            return entry.windows.clone();
        }
    }
    if let Some(entry) = read_disk_cache() {
        if is_fresh(entry.fetched_at, now) {
            let windows = entry.windows.clone();
            *cache = Some(entry);
            return windows;
        }
    }

    // Network fetch. Any failure leaves the (possibly stale) cache in place and
    // returns whatever we last had, so a transient outage never blanks the ring.
    let fetched = fetch_catalog().await;
    match fetched {
        Some(windows) if !windows.is_empty() => {
            let entry = CachedWindows {
                fetched_at: now,
                windows: windows.clone(),
            };
            write_disk_cache(&entry);
            *cache = Some(entry);
            windows
        }
        _ => cache
            .as_ref()
            .map(|e| e.windows.clone())
            .unwrap_or_default(),
    }
}

async fn fetch_catalog() -> Option<HashMap<String, u32>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let resp = client.get(MODELS_DEV_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let catalog: Value = resp.json().await.ok()?;
    Some(parse_windows(&catalog))
}

/// Best-effort context window (in tokens) for a model string, or `None` when
/// models.dev doesn't know it (or is unreachable). Safe to call on every model
/// change: results are cached in-process and on disk for a day.
pub async fn context_window(model: &str) -> Option<u32> {
    let windows = load_windows().await;
    match_context(&windows, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_catalog() -> Value {
        serde_json::json!({
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-4o": { "id": "gpt-4o", "limit": { "context": 128000, "output": 16384 } },
                    "gpt-5": { "id": "gpt-5", "limit": { "context": 400000 } }
                }
            },
            "anthropic": {
                "id": "anthropic",
                "models": {
                    "claude-opus-4-5": { "id": "claude-opus-4-5", "limit": { "context": 200000, "output": 64000 } }
                }
            },
            "no-limit-provider": {
                "id": "no-limit-provider",
                "models": {
                    "mystery": { "id": "mystery" }
                }
            }
        })
    }

    #[test]
    fn parses_bare_and_qualified_keys() {
        let w = parse_windows(&sample_catalog());
        assert_eq!(w.get("gpt-4o"), Some(&128_000));
        assert_eq!(w.get("openai/gpt-4o"), Some(&128_000));
        assert_eq!(w.get("anthropic/claude-opus-4-5"), Some(&200_000));
        // A model with no `limit.context` is skipped entirely.
        assert!(w.get("mystery").is_none());
    }

    #[test]
    fn matches_exact_and_provider_stripped() {
        let w = parse_windows(&sample_catalog());
        // Bare exact.
        assert_eq!(match_context(&w, "gpt-4o"), Some(128_000));
        // Case-insensitive.
        assert_eq!(match_context(&w, "GPT-4o"), Some(128_000));
        // provider/model exact key.
        assert_eq!(match_context(&w, "openai/gpt-4o"), Some(128_000));
        // Unknown provider prefix falls back to the bare tail.
        assert_eq!(
            match_context(&w, "openrouter/claude-opus-4-5"),
            Some(200_000)
        );
        // Genuinely unknown → None (ring stays hidden).
        assert_eq!(match_context(&w, "some-local-gguf"), None);
        assert_eq!(match_context(&w, ""), None);
    }

    #[test]
    fn ttl_freshness() {
        assert!(is_fresh(1000, 1000 + TTL_SECS - 1));
        assert!(!is_fresh(1000, 1000 + TTL_SECS));
    }
}

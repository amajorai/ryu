//! Artificial Analysis stats client — enriches a model card with independent
//! benchmark numbers (intelligence index, output speed, latency, price) from
//! <https://artificialanalysis.ai/api-reference>.
//!
//! Placement rationale (Core vs Gateway): this is read-only capability metadata
//! used to *choose* a model ("what runs"), so it lives in Core alongside the
//! rest of the catalog. The Gateway governs spend/routing, not discovery.
//!
//! Zero-setup friendly: the API requires a key, but the whole catalog works
//! without one — when no key is configured we simply return `None` and the UI
//! shows the model without stats. Key resolution (highest → lowest):
//!   1. preferences ([`AA_API_KEY_PREF_KEY`], set in desktop Settings →
//!      Integrations and persisted to `~/.ryu/preferences.db`)
//!   2. `ARTIFICIAL_ANALYSIS_API_KEY` (the provider's documented env var)
//!   3. `RYU_AA_API_KEY`
//!
//! Artificial Analysis tracks hosted frontier models, not arbitrary community
//! GGUF repos, so most matches will be partial — we fuzzy-match on a normalized
//! model name and only attach stats when something plausibly lines up.

use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

const AA_MODELS_URL: &str = "https://artificialanalysis.ai/api/v2/data/llms/models";

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const AA_API_KEY_PREF_KEY: &str = "aa-api-key";

/// Preferences key for the fetch mode (`"cached"` | `"realtime"`); cached default.
pub const AA_MODE_PREF_KEY: &str = "aa-mode";

/// How long a disk/in-process cache entry is served before a refetch, in seconds.
/// In `Cached` mode the model list is treated as fresh for a day (the AA API is
/// daily-rate-limited and benchmark numbers move slowly). In `Realtime` mode we
/// still de-duplicate a browsing burst with a short window so opening several
/// model details in a row doesn't fire one full-list fetch each.
const CACHED_TTL_SECS: u64 = 24 * 60 * 60;
const REALTIME_TTL_SECS: u64 = 45;

/// Fetch mode, chosen in desktop Settings → Integrations. Defaults to `Cached`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AaMode {
    /// Serve the daily on-disk cache; only refetch when it is older than a day.
    #[default]
    Cached,
    /// Bypass the daily cache; refetch on demand (short dedupe window only).
    Realtime,
}

impl AaMode {
    fn ttl_secs(self) -> u64 {
        match self {
            Self::Cached => CACHED_TTL_SECS,
            Self::Realtime => REALTIME_TTL_SECS,
        }
    }

    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "realtime" | "live" => Self::Realtime,
            _ => Self::Cached,
        }
    }
}

/// In-process key cache, populated from preferences. `None` falls back to env.
static AA_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Current fetch mode, populated from preferences on startup and on change.
static AA_MODE: RwLock<AaMode> = RwLock::new(AaMode::Cached);

/// Independent benchmark stats for a single model, all optional so partial data
/// still renders. Numbers are passed through verbatim from Artificial Analysis.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AaStats {
    /// Matched model name as Artificial Analysis labels it.
    pub matched_name: String,
    /// Composite "Intelligence Index" (higher is smarter).
    pub intelligence_index: Option<f64>,
    /// Median output tokens/second (higher is faster).
    pub output_tokens_per_second: Option<f64>,
    /// Median time-to-first-token in seconds (lower is snappier).
    pub time_to_first_token_s: Option<f64>,
    /// Blended price in USD per 1M tokens, when published.
    pub price_usd_per_1m: Option<f64>,
}

/// A fetched AA model list plus the unix-seconds timestamp it was fetched at.
/// Shared by the in-process cache and the on-disk JSON so freshness is decided
/// the same way in both places.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedModels {
    fetched_at: u64,
    models: Vec<Value>,
}

/// In-process cache of the fetched AA model list. `None` = not loaded this
/// process yet; a present-but-stale entry is refetched per the active mode's TTL.
static CACHE: Mutex<Option<CachedModels>> = Mutex::const_new(None);

/// Set (or clear, when empty) the in-process key from a preferences value, and
/// drop the cached model list so the next fetch re-runs with the new key.
pub async fn set_key(key: &str) {
    let trimmed = key.trim();
    if let Ok(mut guard) = AA_KEY.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    // Invalidate the in-process cache so a newly-added key takes effect
    // immediately (and a cleared key stops returning previously-fetched stats).
    // The disk cache is key-independent and is left alone — `fetch_models`
    // skips it entirely when no key is configured.
    let mut cache = CACHE.lock().await;
    *cache = None;
}

/// Set the fetch mode from a preferences value (`"cached"` | `"realtime"`).
/// Takes effect on the next read: freshness is re-evaluated against the new
/// mode's TTL, so no cache invalidation is needed.
pub fn set_mode(mode: &str) {
    if let Ok(mut guard) = AA_MODE.write() {
        *guard = AaMode::parse(mode);
    }
}

fn current_mode() -> AaMode {
    AA_MODE.read().map(|g| *g).unwrap_or_default()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True when a cache entry fetched at `fetched_at` is still fresh under `mode`.
/// Pure function of its inputs so the TTL decision is unit-testable.
fn is_fresh(fetched_at: u64, now: u64, mode: AaMode) -> bool {
    now.saturating_sub(fetched_at) < mode.ttl_secs()
}

fn disk_cache_path() -> PathBuf {
    crate::ryu_dir().join("aa-models-cache.json")
}

/// Read the on-disk cache. A missing or corrupt/old-schema file is treated as a
/// miss (returns `None`) rather than an error, so the next call refetches.
fn read_disk_cache() -> Option<CachedModels> {
    let raw = std::fs::read_to_string(disk_cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the on-disk cache atomically (temp + rename), matching `installed.rs`.
/// Best-effort: a failure is logged and never propagated.
fn write_disk_cache(entry: &CachedModels) {
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

fn api_key() -> Option<String> {
    if let Ok(guard) = AA_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    std::env::var("ARTIFICIAL_ANALYSIS_API_KEY")
        .ok()
        .or_else(|| std::env::var("RYU_AA_API_KEY").ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// Returns true when an API key is configured (so the UI can prompt to add one).
pub fn has_api_key() -> bool {
    api_key().is_some()
}

/// Fetch (and cache) the full Artificial Analysis model list. Returns an empty
/// vec when no key is set or the request fails — never errors.
///
/// Freshness is read-time and mode-driven: a cache entry (in-process first, then
/// the daily on-disk JSON) is served when it is younger than the active mode's
/// TTL (a day in `Cached`, a short dedupe window in `Realtime`). Only a genuine
/// non-empty fetch is persisted — failed/empty results are never written to disk,
/// so adding a key later isn't masked by a stale empty record.
async fn fetch_models(client: &reqwest::Client) -> Vec<Value> {
    // No key → no stats at all (and don't touch the disk cache). Preserves
    // "remove the key = no stats" and keeps the API untouched.
    let Some(key) = api_key() else {
        return Vec::new();
    };

    let mode = current_mode();
    let now = now_unix();

    let mut cache = CACHE.lock().await;

    // In-process hit (fresh under the current mode).
    if let Some(entry) = cache.as_ref() {
        if is_fresh(entry.fetched_at, now, mode) {
            return entry.models.clone();
        }
    }

    // Disk hit (fresh under the current mode) — adopt it into the in-process
    // cache so sibling detail opens this process don't re-read the file.
    if let Some(entry) = read_disk_cache() {
        if is_fresh(entry.fetched_at, now, mode) {
            let models = entry.models.clone();
            *cache = Some(entry);
            return models;
        }
    }

    // Stale or absent → refetch. On a non-empty result, persist to memory + disk;
    // on failure, leave existing caches untouched and return what we can.
    match fetch_remote(client, &key).await {
        Some(models) if !models.is_empty() => {
            let entry = CachedModels {
                fetched_at: now,
                models: models.clone(),
            };
            write_disk_cache(&entry);
            *cache = Some(entry);
            models
        }
        _ => cache.as_ref().map(|e| e.models.clone()).unwrap_or_default(),
    }
}

async fn fetch_remote(client: &reqwest::Client, key: &str) -> Option<Vec<Value>> {
    let resp = client
        .get(AA_MODELS_URL)
        .header("x-api-key", key)
        .header("User-Agent", "ryu-core/0.1")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        tracing::warn!("artificialanalysis: HTTP {}", resp.status());
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    // The API wraps the list in a `data` array; tolerate a bare array too.
    let arr = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.as_array())
        .cloned()?;
    Some(arr)
}

/// Normalize a model name for fuzzy matching: lowercase, keep alphanumerics.
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Look up stats for a model by its human name and/or HF repo id. Returns `None`
/// when no key is configured or nothing matches.
pub async fn stats_for(
    client: &reqwest::Client,
    model_name: &str,
    repo_id: &str,
) -> Option<AaStats> {
    let models = fetch_models(client).await;
    if models.is_empty() {
        return None;
    }

    // Build candidate needles from the repo's model name (drop the org prefix
    // and common GGUF/quant suffixes that AA never includes).
    let short = repo_id.rsplit('/').next().unwrap_or(repo_id);
    let needles = [normalize(model_name), normalize(short)];

    let mut best: Option<(usize, &Value)> = None;
    for entry in &models {
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        let hay = normalize(name);
        if hay.is_empty() {
            continue;
        }
        for needle in &needles {
            if needle.is_empty() {
                continue;
            }
            let matches = hay.contains(needle) || needle.contains(&hay);
            if matches {
                // Prefer the longest matching AA name (most specific match).
                let score = hay.len();
                if best.map(|(s, _)| score > s).unwrap_or(true) {
                    best = Some((score, entry));
                }
            }
        }
    }

    let (_, entry) = best?;
    Some(parse_entry(entry))
}

/// Extract the stat fields we surface, tolerating the API's nested shapes.
fn parse_entry(entry: &Value) -> AaStats {
    let matched_name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Intelligence index lives under `evaluations.artificial_analysis_intelligence_index`
    // in the v2 schema; fall back to a few alternate keys defensively.
    let intelligence_index = num_at(
        entry,
        &["evaluations", "artificial_analysis_intelligence_index"],
    )
    .or_else(|| num_at(entry, &["evaluations", "intelligence_index"]))
    .or_else(|| num_at(entry, &["artificial_analysis_intelligence_index"]));

    let output_tokens_per_second = num_at(entry, &["median_output_tokens_per_second"])
        .or_else(|| num_at(entry, &["performance", "median_output_tokens_per_second"]));

    let time_to_first_token_s =
        num_at(entry, &["median_time_to_first_token_seconds"]).or_else(|| {
            num_at(
                entry,
                &["performance", "median_time_to_first_token_seconds"],
            )
        });

    let price_usd_per_1m = num_at(entry, &["pricing", "price_1m_blended_3_to_1"])
        .or_else(|| num_at(entry, &["pricing", "price_1m_blended"]))
        .or_else(|| num_at(entry, &["price_1m_blended_3_to_1"]));

    AaStats {
        matched_name,
        intelligence_index,
        output_tokens_per_second,
        time_to_first_token_s,
        price_usd_per_1m,
    }
}

/// Walk a nested path of object keys and read the leaf as an f64.
fn num_at(value: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = value;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse_defaults_to_cached() {
        assert_eq!(AaMode::parse("realtime"), AaMode::Realtime);
        assert_eq!(AaMode::parse("LIVE"), AaMode::Realtime);
        assert_eq!(AaMode::parse("cached"), AaMode::Cached);
        assert_eq!(AaMode::parse(""), AaMode::Cached);
        assert_eq!(AaMode::parse("garbage"), AaMode::Cached);
    }

    #[test]
    fn freshness_respects_mode_ttl() {
        let now = 1_000_000;
        // Cached: a 12h-old entry is fresh, a 25h-old one is stale.
        assert!(is_fresh(now - 12 * 3600, now, AaMode::Cached));
        assert!(!is_fresh(now - 25 * 3600, now, AaMode::Cached));
        // Realtime: only the short dedupe window is fresh.
        assert!(is_fresh(now - 10, now, AaMode::Realtime));
        assert!(!is_fresh(now - 120, now, AaMode::Realtime));
        // The same day-old timestamp flips fresh→stale when the mode tightens.
        let day_old = now - 12 * 3600;
        assert!(is_fresh(day_old, now, AaMode::Cached));
        assert!(!is_fresh(day_old, now, AaMode::Realtime));
    }

    #[test]
    fn normalize_strips_punctuation() {
        assert_eq!(normalize("Gemma-3 1B (it)"), "gemma31bit");
        assert_eq!(normalize("Llama 3.1 70B"), "llama3170b");
    }

    #[test]
    fn parse_entry_reads_nested_v2_shape() {
        let v: Value = serde_json::json!({
            "name": "GPT-4o mini",
            "evaluations": { "artificial_analysis_intelligence_index": 60.5 },
            "median_output_tokens_per_second": 120.0,
            "median_time_to_first_token_seconds": 0.4,
            "pricing": { "price_1m_blended_3_to_1": 0.26 }
        });
        let s = parse_entry(&v);
        assert_eq!(s.matched_name, "GPT-4o mini");
        assert_eq!(s.intelligence_index, Some(60.5));
        assert_eq!(s.output_tokens_per_second, Some(120.0));
        assert_eq!(s.time_to_first_token_s, Some(0.4));
        assert_eq!(s.price_usd_per_1m, Some(0.26));
    }
}

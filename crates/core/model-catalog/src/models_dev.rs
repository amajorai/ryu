//! models.dev catalog — context windows **and** rich model metadata (cost,
//! modalities, limits, capabilities) from the public <https://models.dev/api.json>.
//!
//! Placement rationale (Core vs Gateway): this is read-only model metadata used
//! to render model attributes (context-usage meter, agent-picker hover cards).
//! It is discovery/display data — "what runs" — so it lives in Core with the rest
//! of the catalog, not in the Gateway.
//!
//! Fail-open: on any fetch/parse miss we return `None` / empty and callers hide
//! the UI affordance. Cached in-process + on disk for 24h.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
/// Context windows / pricing change rarely; a day-long TTL keeps the ~3 MB
/// catalog out of the hot path while still picking up new models within a day.
const TTL_SECS: u64 = 24 * 60 * 60;

/// Rich metadata for one models.dev (or OpenRouter-normalized) model entry.
/// All optional fields stay optional so partial upstream data still renders.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Provider id as models.dev / OpenRouter labels it (`anthropic`, `openai`, …).
    #[serde(default)]
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output: Option<u32>,
    /// USD per 1M input tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_input_per_1m: Option<f64>,
    /// USD per 1M output tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_output_per_1m: Option<f64>,
    /// USD per 1M cache-read input tokens, when published by the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_cache_read_per_1m: Option<f64>,
    /// USD per 1M cache-write input tokens, when published by the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_cache_write_per_1m: Option<f64>,
    #[serde(default)]
    pub modalities_input: Vec<String>,
    #[serde(default)]
    pub modalities_output: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    /// Provenance tag: `"models.dev"` or `"openrouter"`.
    #[serde(default)]
    pub source: String,
}

/// On-disk / in-process cache. `metas` is optional so older window-only cache
/// files still deserialize; a missing metas map triggers a refresh on insight
/// lookups while `context_window` can still serve from `windows`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedCatalog {
    fetched_at: u64,
    /// Lowercased model id (bare and `provider/id`) → context window in tokens.
    windows: HashMap<String, u32>,
    /// Lowercased model id (bare and `provider/id`) → rich meta.
    #[serde(default)]
    metas: HashMap<String, ModelMeta>,
}

static CACHE: Mutex<Option<CachedCatalog>> = Mutex::const_new(None);

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
    ryu_sidecar_runtime::layout::cache_path(&crate::ryu_dir(), "models-dev-cache.json")
}

fn read_disk_cache() -> Option<CachedCatalog> {
    let raw = std::fs::read_to_string(disk_cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the on-disk cache atomically (temp + rename). Best-effort; never errors.
fn write_disk_cache(entry: &CachedCatalog) {
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

/// Map a Ryu/Pi provider id to the models.dev provider key when they differ.
fn models_dev_provider_key(provider_id: &str) -> &str {
    match provider_id {
        "openai-codex" => "openai",
        "claude-pro-max" => "anthropic",
        "zai" | "zai-coding-cn" => "z-ai",
        "moonshotai-cn" => "moonshotai",
        "minimax-cn" => "minimax",
        other => other,
    }
}

/// Flatten the models.dev catalog into window + meta maps.
/// The catalog is `{ <providerId>: { models: { <modelId>: { … } } } }`.
/// Each model is indexed under both its bare id and a provider-qualified key.
fn parse_catalog(catalog: &Value) -> (HashMap<String, u32>, HashMap<String, ModelMeta>) {
    let mut windows: HashMap<String, u32> = HashMap::new();
    let mut metas: HashMap<String, ModelMeta> = HashMap::new();
    let Some(providers) = catalog.as_object() else {
        return (windows, metas);
    };
    for (provider_id, provider) in providers {
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model_id, model) in models {
            let context = model
                .get("limit")
                .and_then(|l| l.get("context"))
                .and_then(Value::as_u64)
                .map(|n| n as u32);
            let max_output = model
                .get("limit")
                .and_then(|l| l.get("output"))
                .and_then(Value::as_u64)
                .map(|n| n as u32);

            let name = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(model_id)
                .to_owned();
            let description = model
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let cost = model.get("cost");
            let cost_input = cost.and_then(|c| c.get("input")).and_then(Value::as_f64);
            let cost_output = cost.and_then(|c| c.get("output")).and_then(Value::as_f64);
            let modalities = model.get("modalities");
            let modalities_input = string_list(modalities.and_then(|m| m.get("input")));
            let modalities_output = string_list(modalities.and_then(|m| m.get("output")));
            let knowledge = model
                .get("knowledge")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let reasoning = model.get("reasoning").and_then(Value::as_bool);
            let tool_call = model.get("tool_call").and_then(Value::as_bool);

            let meta = ModelMeta {
                id: model_id.clone(),
                name,
                description,
                provider: provider_id.clone(),
                context,
                max_output,
                cost_input_per_1m: cost_input,
                cost_output_per_1m: cost_output,
                cost_cache_read_per_1m: cost
                    .and_then(|c| c.get("cache_read"))
                    .and_then(Value::as_f64),
                cost_cache_write_per_1m: cost
                    .and_then(|c| c.get("cache_write"))
                    .and_then(Value::as_f64),
                modalities_input,
                modalities_output,
                knowledge,
                reasoning,
                tool_call,
                source: "models.dev".to_owned(),
            };

            let bare = model_id.to_ascii_lowercase();
            let qualified = format!("{}/{}", provider_id.to_ascii_lowercase(), bare);

            if let Some(ctx) = context {
                windows.insert(qualified.clone(), ctx);
                windows
                    .entry(bare.clone())
                    .and_modify(|c| *c = (*c).max(ctx))
                    .or_insert(ctx);
            }

            metas.insert(qualified, meta.clone());
            // Bare id: prefer the entry with richer cost data on collision.
            metas
                .entry(bare)
                .and_modify(|existing| {
                    if existing.cost_input_per_1m.is_none() && meta.cost_input_per_1m.is_some() {
                        *existing = meta.clone();
                    }
                })
                .or_insert(meta);
        }
    }
    (windows, metas)
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a model string against a flattened map. Tries exact key, then the
/// segment after the last `/`. Pure.
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

fn match_meta(metas: &HashMap<String, ModelMeta>, model: &str) -> Option<ModelMeta> {
    let key = model.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    if let Some(m) = metas.get(&key) {
        return Some(m.clone());
    }
    if let Some((_, tail)) = key.rsplit_once('/') {
        if let Some(m) = metas.get(tail) {
            return Some(m.clone());
        }
    }
    None
}

/// Ensure the catalog is loaded (in-process → disk → network). Fail-open.
async fn load_catalog(require_metas: bool) -> CachedCatalog {
    let now = now_unix();
    let mut cache = CACHE.lock().await;

    if let Some(entry) = cache.as_ref() {
        let ok = is_fresh(entry.fetched_at, now) && (!require_metas || !entry.metas.is_empty());
        if ok {
            return entry.clone();
        }
    }
    if let Some(entry) = read_disk_cache() {
        let ok = is_fresh(entry.fetched_at, now) && (!require_metas || !entry.metas.is_empty());
        if ok {
            *cache = Some(entry.clone());
            return entry;
        }
    }

    match fetch_catalog().await {
        Some((windows, metas)) if !windows.is_empty() || !metas.is_empty() => {
            let entry = CachedCatalog {
                fetched_at: now,
                windows,
                metas,
            };
            write_disk_cache(&entry);
            *cache = Some(entry.clone());
            entry
        }
        _ => cache.clone().unwrap_or(CachedCatalog {
            fetched_at: 0,
            windows: HashMap::new(),
            metas: HashMap::new(),
        }),
    }
}

async fn fetch_catalog() -> Option<(HashMap<String, u32>, HashMap<String, ModelMeta>)> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let resp = client.get(MODELS_DEV_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let catalog: Value = resp.json().await.ok()?;
    Some(parse_catalog(&catalog))
}

/// Best-effort context window (in tokens) for a model string, or `None` when
/// models.dev doesn't know it (or is unreachable). Safe to call on every model
/// change: results are cached in-process and on disk for a day.
pub async fn context_window(model: &str) -> Option<u32> {
    let catalog = load_catalog(false).await;
    match_context(&catalog.windows, model)
}

/// Best-effort rich metadata for a model. When `provider` is set, tries the
/// qualified `provider/model` key first (after mapping Ryu provider aliases).
pub async fn meta_for(model: &str, provider: Option<&str>) -> Option<ModelMeta> {
    let catalog = load_catalog(true).await;
    if let Some(p) = provider.map(str::trim).filter(|s| !s.is_empty()) {
        let key = models_dev_provider_key(p);
        let qualified = format!(
            "{}/{}",
            key.to_ascii_lowercase(),
            model.trim().to_ascii_lowercase()
        );
        if let Some(m) = match_meta(&catalog.metas, &qualified) {
            return Some(m);
        }
        // Also try stripping a provider prefix already on the model id.
        if let Some((_, tail)) = model.rsplit_once('/') {
            let q2 = format!("{}/{}", key.to_ascii_lowercase(), tail.to_ascii_lowercase());
            if let Some(m) = match_meta(&catalog.metas, &q2) {
                return Some(m);
            }
        }
    }
    match_meta(&catalog.metas, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_catalog() -> Value {
        serde_json::json!({
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-4o": {
                        "id": "gpt-4o",
                        "name": "GPT-4o",
                        "limit": { "context": 128000, "output": 16384 },
                        "cost": { "input": 2.5, "output": 10.0 },
                        "modalities": { "input": ["text", "image"], "output": ["text"] },
                        "reasoning": false,
                        "tool_call": true
                    },
                    "gpt-5": { "id": "gpt-5", "limit": { "context": 400000 } }
                }
            },
            "anthropic": {
                "id": "anthropic",
                "models": {
                    "claude-opus-4-5": {
                        "id": "claude-opus-4-5",
                        "name": "Claude Opus 4.5",
                        "description": "High-end Claude",
                        "limit": { "context": 200000, "output": 64000 },
                        "cost": { "input": 5.0, "output": 25.0, "cache_read": 0.5, "cache_write": 6.25 },
                        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
                        "reasoning": true,
                        "tool_call": true,
                        "knowledge": "2025-05"
                    }
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
        let (w, _) = parse_catalog(&sample_catalog());
        assert_eq!(w.get("gpt-4o"), Some(&128_000));
        assert_eq!(w.get("openai/gpt-4o"), Some(&128_000));
        assert_eq!(w.get("anthropic/claude-opus-4-5"), Some(&200_000));
        assert!(w.get("mystery").is_none());
    }

    #[test]
    fn parses_rich_meta() {
        let (_, metas) = parse_catalog(&sample_catalog());
        let m = metas.get("anthropic/claude-opus-4-5").expect("meta");
        assert_eq!(m.name, "Claude Opus 4.5");
        assert_eq!(m.context, Some(200_000));
        assert_eq!(m.max_output, Some(64_000));
        assert_eq!(m.cost_input_per_1m, Some(5.0));
        assert_eq!(m.cost_output_per_1m, Some(25.0));
        assert_eq!(m.cost_cache_read_per_1m, Some(0.5));
        assert_eq!(m.cost_cache_write_per_1m, Some(6.25));
        assert_eq!(m.modalities_input, vec!["text", "image", "pdf"]);
        assert_eq!(m.reasoning, Some(true));
        assert_eq!(m.source, "models.dev");
    }

    #[test]
    fn matches_exact_and_provider_stripped() {
        let (w, _) = parse_catalog(&sample_catalog());
        assert_eq!(match_context(&w, "gpt-4o"), Some(128_000));
        assert_eq!(match_context(&w, "GPT-4o"), Some(128_000));
        assert_eq!(match_context(&w, "openai/gpt-4o"), Some(128_000));
        assert_eq!(
            match_context(&w, "openrouter/claude-opus-4-5"),
            Some(200_000)
        );
        assert_eq!(match_context(&w, "some-local-gguf"), None);
        assert_eq!(match_context(&w, ""), None);
    }

    #[test]
    fn ttl_freshness() {
        assert!(is_fresh(1000, 1000 + TTL_SECS - 1));
        assert!(!is_fresh(1000, 1000 + TTL_SECS));
    }

    #[test]
    fn parse_windows_keeps_largest_bare_window_on_collision() {
        let catalog = serde_json::json!({
            "provider-a": { "models": { "shared": { "limit": { "context": 8000 } } } },
            "provider-b": { "models": { "shared": { "limit": { "context": 32000 } } } }
        });
        let (w, _) = parse_catalog(&catalog);
        assert_eq!(w.get("shared"), Some(&32_000));
        assert_eq!(w.get("provider-a/shared"), Some(&8_000));
        assert_eq!(w.get("provider-b/shared"), Some(&32_000));
    }

    #[test]
    fn parse_windows_ignores_non_object_and_missing_models() {
        let (w, m) = parse_catalog(&serde_json::json!("not an object"));
        assert!(w.is_empty() && m.is_empty());
        let (w2, m2) = parse_catalog(&serde_json::json!({ "p": { "no_models": {} } }));
        assert!(w2.is_empty() && m2.is_empty());
    }

    #[test]
    fn provider_alias_maps_subscription_ids() {
        assert_eq!(models_dev_provider_key("openai-codex"), "openai");
        assert_eq!(models_dev_provider_key("claude-pro-max"), "anthropic");
        assert_eq!(models_dev_provider_key("anthropic"), "anthropic");
    }

    #[tokio::test]
    async fn context_window_uses_in_process_then_disk_cache() {
        crate::ensure_test_host();

        {
            let mut c = CACHE.lock().await;
            let mut w = HashMap::new();
            w.insert("gpt-4o".to_string(), 128_000u32);
            w.insert("openai/gpt-4o".to_string(), 128_000u32);
            *c = Some(CachedCatalog {
                fetched_at: now_unix(),
                windows: w,
                metas: HashMap::new(),
            });
        }
        assert_eq!(context_window("gpt-4o").await, Some(128_000));
        assert_eq!(context_window("openrouter/gpt-4o").await, Some(128_000));
        assert_eq!(context_window("nonexistent-local-xyz").await, None);

        {
            let mut c = CACHE.lock().await;
            *c = None;
        }
        let mut w2 = HashMap::new();
        w2.insert("claude-disk-xyz".to_string(), 200_000u32);
        let entry = CachedCatalog {
            fetched_at: now_unix(),
            windows: w2,
            metas: HashMap::new(),
        };
        write_disk_cache(&entry);
        assert!(read_disk_cache().is_some(), "disk cache round-trips");
        assert_eq!(context_window("claude-disk-xyz").await, Some(200_000));
    }
}

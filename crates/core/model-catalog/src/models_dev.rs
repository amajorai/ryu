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
use std::sync::Arc;
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

static CACHE: Mutex<Option<Arc<CachedCatalog>>> = Mutex::const_new(None);

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
async fn load_catalog(require_metas: bool) -> Arc<CachedCatalog> {
    let now = now_unix();
    let mut cache = CACHE.lock().await;

    if let Some(entry) = cache.as_ref() {
        let ok = is_fresh(entry.fetched_at, now) && (!require_metas || !entry.metas.is_empty());
        if ok {
            return Arc::clone(entry);
        }
    }
    if let Some(entry) = read_disk_cache() {
        let ok = is_fresh(entry.fetched_at, now) && (!require_metas || !entry.metas.is_empty());
        if ok {
            let entry = Arc::new(entry);
            *cache = Some(Arc::clone(&entry));
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
            let entry = Arc::new(entry);
            *cache = Some(Arc::clone(&entry));
            entry
        }
        _ => cache.clone().unwrap_or_else(|| {
            Arc::new(CachedCatalog {
                fetched_at: 0,
                windows: HashMap::new(),
                metas: HashMap::new(),
            })
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
#[path = "models_dev_tests.rs"]
mod tests;

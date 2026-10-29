//! OpenRouter model metadata cache — pricing, context, and modalities for models
//! that models.dev doesn't cover (or when the caller is on the OpenRouter provider).
//!
//! Fail-open: an unreachable OpenRouter leaves the cache empty and callers fall
//! through to whatever other sources they have. Prices can change with short
//! provider promotions, so this cache is intentionally shorter than models.dev.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::models_dev::ModelMeta;

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const TTL_SECS: u64 = 15 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedMetas {
    fetched_at: u64,
    /// Lowercased model id (`anthropic/claude-opus-4-6` and bare tail) → meta.
    metas: HashMap<String, ModelMeta>,
}

static CACHE: Mutex<Option<CachedMetas>> = Mutex::const_new(None);

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
    ryu_sidecar_runtime::layout::cache_path(&crate::ryu_dir(), "openrouter-models-cache.json")
}

fn read_disk_cache() -> Option<CachedMetas> {
    let raw = std::fs::read_to_string(disk_cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_disk_cache(entry: &CachedMetas) {
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

/// Parse OpenRouter's `/api/v1/models` payload into a meta map. OpenRouter prices
/// are USD **per token**; we convert to USD per 1M tokens to match models.dev.
fn parse_metas(payload: &Value) -> HashMap<String, ModelMeta> {
    let mut out: HashMap<String, ModelMeta> = HashMap::new();
    let Some(models) = payload.get("data").and_then(Value::as_array) else {
        return out;
    };
    for entry in models {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned();
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let context = entry
            .get("context_length")
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .or_else(|| {
                entry
                    .get("top_provider")
                    .and_then(|t| t.get("context_length"))
                    .and_then(Value::as_u64)
                    .map(|n| n as u32)
            });
        let max_output = entry
            .get("top_provider")
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(Value::as_u64)
            .map(|n| n as u32);

        let pricing = entry.get("pricing");
        let cost_input = pricing
            .and_then(|p| p.get("prompt"))
            .and_then(per_token_to_per_1m);
        let cost_output = pricing
            .and_then(|p| p.get("completion"))
            .and_then(per_token_to_per_1m);

        let arch = entry.get("architecture");
        let modalities_input = string_list(arch.and_then(|a| a.get("input_modalities")));
        let modalities_output = string_list(arch.and_then(|a| a.get("output_modalities")));

        let reasoning = entry
            .get("reasoning")
            .map(|r| r.is_object() || r.as_bool() == Some(true));
        let tool_call = entry
            .get("supported_parameters")
            .and_then(Value::as_array)
            .map(|params| {
                params
                    .iter()
                    .any(|p| matches!(p.as_str(), Some("tools") | Some("tool_choice")))
            });
        let knowledge = entry
            .get("knowledge_cutoff")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let meta = ModelMeta {
            id: id.to_owned(),
            name,
            description,
            provider: id
                .split_once('/')
                .map(|(p, _)| p.to_owned())
                .unwrap_or_default(),
            context,
            max_output,
            cost_input_per_1m: cost_input,
            cost_output_per_1m: cost_output,
            cost_cache_read_per_1m: pricing
                .and_then(|p| p.get("input_cache_read"))
                .and_then(per_token_to_per_1m),
            cost_cache_write_per_1m: pricing
                .and_then(|p| p.get("input_cache_write"))
                .and_then(per_token_to_per_1m),
            modalities_input,
            modalities_output,
            knowledge,
            reasoning,
            tool_call,
            source: "openrouter".to_owned(),
        };

        let lower = id.to_ascii_lowercase();
        out.insert(lower.clone(), meta.clone());
        if let Some((_, tail)) = lower.rsplit_once('/') {
            // Bare id: keep the first-seen; OpenRouter ids are usually unique.
            out.entry(tail.to_owned()).or_insert(meta);
        }
    }
    out
}

fn per_token_to_per_1m(v: &Value) -> Option<f64> {
    let per_token = match v {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    Some(per_token * 1_000_000.0)
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_ascii_lowercase())
                // OpenRouter uses "file" for PDFs; normalize to our modality set.
                .map(|s| if s == "file" { "pdf".to_owned() } else { s })
                .collect()
        })
        .unwrap_or_default()
}

async fn load_metas() -> HashMap<String, ModelMeta> {
    let now = now_unix();
    let mut cache = CACHE.lock().await;

    if let Some(entry) = cache.as_ref() {
        if is_fresh(entry.fetched_at, now) {
            return entry.metas.clone();
        }
    }
    if let Some(entry) = read_disk_cache() {
        if is_fresh(entry.fetched_at, now) {
            let metas = entry.metas.clone();
            *cache = Some(entry);
            return metas;
        }
    }

    match fetch_metas().await {
        Some(metas) if !metas.is_empty() => {
            let entry = CachedMetas {
                fetched_at: now,
                metas: metas.clone(),
            };
            write_disk_cache(&entry);
            *cache = Some(entry);
            metas
        }
        _ => cache.as_ref().map(|e| e.metas.clone()).unwrap_or_default(),
    }
}

async fn fetch_metas() -> Option<HashMap<String, ModelMeta>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let resp = client.get(OPENROUTER_MODELS_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let payload: Value = resp.json().await.ok()?;
    Some(parse_metas(&payload))
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

/// Best-effort OpenRouter metadata for a model id, or `None` when unknown.
pub async fn meta_for(model: &str) -> Option<ModelMeta> {
    let metas = load_metas().await;
    match_meta(&metas, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openrouter_pricing_and_modalities() {
        let payload = serde_json::json!({
            "data": [{
                "id": "anthropic/claude-opus-4-6",
                "name": "Claude Opus 4.6",
                "description": "High-end Claude",
                "context_length": 1000000,
                "architecture": {
                    "input_modalities": ["text", "image", "file"],
                    "output_modalities": ["text"]
                },
                "pricing": {
                    "prompt": "0.000005",
                    "completion": "0.000025",
                    "input_cache_read": "0.0000005",
                    "input_cache_write": "0.00000625"
                },
                "top_provider": { "max_completion_tokens": 128000 },
                "supported_parameters": ["tools", "tool_choice", "reasoning"],
                "reasoning": { "default_enabled": true }
            }]
        });
        let metas = parse_metas(&payload);
        let m = metas.get("anthropic/claude-opus-4-6").expect("qualified");
        assert_eq!(m.name, "Claude Opus 4.6");
        assert_eq!(m.context, Some(1_000_000));
        assert_eq!(m.max_output, Some(128_000));
        assert!((m.cost_input_per_1m.unwrap() - 5.0).abs() < 1e-9);
        assert!((m.cost_output_per_1m.unwrap() - 25.0).abs() < 1e-9);
        assert!((m.cost_cache_read_per_1m.unwrap() - 0.5).abs() < 1e-9);
        assert!((m.cost_cache_write_per_1m.unwrap() - 6.25).abs() < 1e-9);
        assert_eq!(m.modalities_input, vec!["text", "image", "pdf"]);
        assert_eq!(m.reasoning, Some(true));
        assert_eq!(m.tool_call, Some(true));
        assert_eq!(m.source, "openrouter");
        assert!(metas.get("claude-opus-4-6").is_some());
    }

    #[test]
    fn preserves_zero_pricing_from_a_provider_promotion() {
        let payload = serde_json::json!({
            "data": [{
                "id": "openai/gpt-5.6-sol",
                "pricing": { "prompt": "0", "completion": "0.000015", "input_cache_read": "0" }
            }]
        });
        let metas = parse_metas(&payload);
        let meta = metas.get("openai/gpt-5.6-sol").expect("qualified");
        assert_eq!(meta.cost_input_per_1m, Some(0.0));
        assert_eq!(meta.cost_output_per_1m, Some(15.0));
        assert_eq!(meta.cost_cache_read_per_1m, Some(0.0));
    }
}

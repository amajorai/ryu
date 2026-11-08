//! Tests for the models.dev catalog cache.

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

/// Serializes the tests that seed the process-global `CACHE`.
static CACHE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn context_window_uses_in_process_then_disk_cache() {
    crate::ensure_test_host();
    let _guard = CACHE_TEST_LOCK.lock().await;

    {
        let mut c = CACHE.lock().await;
        let mut w = HashMap::new();
        w.insert("gpt-4o".to_string(), 128_000u32);
        w.insert("openai/gpt-4o".to_string(), 128_000u32);
        *c = Some(Arc::new(CachedCatalog {
            fetched_at: now_unix(),
            windows: w,
            metas: HashMap::new(),
        }));
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

#[tokio::test]
async fn cached_catalog_lookups_share_one_allocation() {
    crate::ensure_test_host();
    let _guard = CACHE_TEST_LOCK.lock().await;
    let (windows, metas) = parse_catalog(&sample_catalog());
    {
        let mut c = CACHE.lock().await;
        *c = Some(Arc::new(CachedCatalog {
            fetched_at: now_unix(),
            windows,
            metas,
        }));
    }

    let meta = meta_for("gpt-4o", Some("openai")).await.expect("meta");
    assert_eq!(meta.context, Some(128_000));
    assert_eq!(meta.cost_input_per_1m, Some(2.5));
    assert_eq!(meta.cost_output_per_1m, Some(10.0));
    assert_eq!(context_window("gpt-4o").await, Some(128_000));

    let first = load_catalog(true).await;
    let second = load_catalog(true).await;
    assert!(
        Arc::ptr_eq(&first, &second),
        "fresh lookups must share the cached catalog instead of deep-cloning it"
    );
}

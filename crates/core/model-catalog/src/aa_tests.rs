//! Unit tests for [`super`] (the Artificial Analysis stats client).

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

#[test]
fn parse_entry_uses_fallback_key_paths() {
    // The alternate (non-v2) shapes the parser tolerates.
    let v: Value = serde_json::json!({
        "name": "Alt Model",
        "artificial_analysis_intelligence_index": 42.0,
        "performance": {
            "median_output_tokens_per_second": 33.0,
            "median_time_to_first_token_seconds": 1.2
        },
        "price_1m_blended_3_to_1": 5.0
    });
    let s = parse_entry(&v);
    assert_eq!(s.intelligence_index, Some(42.0));
    assert_eq!(s.output_tokens_per_second, Some(33.0));
    assert_eq!(s.time_to_first_token_s, Some(1.2));
    assert_eq!(s.price_usd_per_1m, Some(5.0));
}

#[test]
fn num_at_walks_nested_paths() {
    let v = serde_json::json!({ "a": { "b": 3.5 }, "c": "not-a-number" });
    assert_eq!(num_at(&v, &["a", "b"]), Some(3.5));
    assert_eq!(num_at(&v, &["a", "missing"]), None);
    assert_eq!(num_at(&v, &["c"]), None);
}

#[tokio::test]
async fn stats_for_matches_cached_models_and_helpers() {
    crate::ensure_test_host();

    // Seed a FRESH cache BEFORE setting a key (invariant: key-present never
    // coexists with a non-fresh cache, so no test ever hits the network).
    let models = vec![serde_json::json!({
        "name": "Llama 3.1 70B Instruct",
        "evaluations": { "artificial_analysis_intelligence_index": 55.0 },
        "median_output_tokens_per_second": 90.0,
        "median_time_to_first_token_seconds": 0.5,
        "pricing": { "price_1m_blended_3_to_1": 0.8 }
    })];
    test_seed_fresh_cache(models).await;
    test_set_key(Some("test-key"));
    assert!(has_api_key());

    let client = reqwest::Client::new();
    let s = stats_for(
        &client,
        "Llama 3.1 70B Instruct",
        "meta/Llama-3.1-70B-Instruct",
    )
    .await
    .expect("a cached model fuzzy-matches");
    assert_eq!(s.matched_name, "Llama 3.1 70B Instruct");
    assert_eq!(s.intelligence_index, Some(55.0));
    assert_eq!(s.price_usd_per_1m, Some(0.8));

    // A name resembling nothing in the cache yields no stats.
    assert!(
        stats_for(&client, "zzz-unrelated-widget", "acme/zzz-unrelated-widget")
            .await
            .is_none()
    );

    // Mode read/write path.
    set_mode("realtime");
    assert_eq!(current_mode(), AaMode::Realtime);
    set_mode("cached");
    assert_eq!(current_mode(), AaMode::Cached);
    // Re-seed fresh so the cache stays fresh regardless of the brief toggle.
    test_seed_fresh_cache(vec![]).await;

    // On-disk cache round-trips (leaves the in-process cache untouched).
    let entry = CachedModels {
        fetched_at: now_unix(),
        models: vec![serde_json::json!({ "name": "x" })],
    };
    write_disk_cache(&entry);
    assert!(read_disk_cache().is_some());

    // Clear the key last; the fresh cache is intentionally left in place.
    test_set_key(None);
    if std::env::var("ARTIFICIAL_ANALYSIS_API_KEY").is_err() {
        assert!(!has_api_key());
    }
}

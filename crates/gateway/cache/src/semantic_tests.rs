use super::*;
use serde_json::json;

// ─── SemanticCacheConfig defaults / serde ────────────────────────────────

#[test]
fn default_config_is_disabled() {
    let c = SemanticCacheConfig::default();
    assert!(!c.enabled, "semantic cache is opt-in / off by default");
    assert!((c.similarity_threshold - 0.92).abs() < 1e-6);
    assert_eq!(c.embedding_model, "text-embedding-3-small");
}

#[test]
fn serde_fills_defaults() {
    let c: SemanticCacheConfig = serde_json::from_value(json!({})).unwrap();
    assert!(!c.enabled);
    assert!((c.similarity_threshold - 0.92).abs() < 1e-6);
    assert_eq!(c.embedding_model, "text-embedding-3-small");

    let c: SemanticCacheConfig =
        serde_json::from_value(json!({ "enabled": true, "similarity_threshold": 0.5 })).unwrap();
    assert!(c.enabled);
    assert!((c.similarity_threshold - 0.5).abs() < 1e-6);
    assert_eq!(c.embedding_model, "text-embedding-3-small");
}

// ─── cosine_similarity ───────────────────────────────────────────────────

#[test]
fn cosine_identical_vectors_is_one() {
    assert!((cosine_similarity(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) - 1.0).abs() < 1e-6);
}

#[test]
fn cosine_orthogonal_vectors_is_zero() {
    assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
}

#[test]
fn cosine_opposite_vectors_is_negative_one() {
    assert!((cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
}

#[test]
fn cosine_scaled_vectors_are_still_similar() {
    // Cosine is scale-invariant: v and 5v point the same way.
    assert!((cosine_similarity(&[1.0, 2.0], &[5.0, 10.0]) - 1.0).abs() < 1e-6);
}

#[test]
fn cosine_length_mismatch_is_sentinel() {
    assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0]), -1.0);
}

#[test]
fn cosine_empty_is_sentinel() {
    assert_eq!(cosine_similarity(&[], &[]), -1.0);
}

#[test]
fn cosine_zero_vector_is_sentinel() {
    // Zero norm would divide by zero; guarded to the -1.0 sentinel.
    assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), -1.0);
    assert_eq!(cosine_similarity(&[1.0, 1.0], &[0.0, 0.0]), -1.0);
}

// ─── messages_to_text ────────────────────────────────────────────────────

#[test]
fn messages_to_text_flattens_roles_and_content() {
    let msgs = json!([
        { "role": "user", "content": "hi" },
        { "role": "assistant", "content": "hello" },
    ]);
    assert_eq!(
        SemanticCache::messages_to_text(&msgs),
        "user: hi\nassistant: hello"
    );
}

#[test]
fn messages_to_text_skips_empty_content() {
    let msgs = json!([
        { "role": "system", "content": "" },
        { "role": "user", "content": "keep" },
    ]);
    assert_eq!(SemanticCache::messages_to_text(&msgs), "user: keep");
}

#[test]
fn messages_to_text_treats_missing_role_as_empty() {
    let msgs = json!([{ "content": "orphan" }]);
    assert_eq!(SemanticCache::messages_to_text(&msgs), ": orphan");
}

#[test]
fn messages_to_text_non_string_content_is_skipped() {
    // content that isn't a plain string flattens to empty and is dropped.
    let msgs = json!([{ "role": "user", "content": { "type": "image" } }]);
    assert_eq!(SemanticCache::messages_to_text(&msgs), "");
}

#[test]
fn messages_to_text_non_array_is_empty() {
    assert_eq!(SemanticCache::messages_to_text(&json!(null)), "");
    assert_eq!(
        SemanticCache::messages_to_text(&json!({ "role": "user" })),
        ""
    );
}

// ─── lookup / insert ─────────────────────────────────────────────────────

fn cache(threshold: f32, ttl_secs: u64) -> SemanticCache {
    capped_cache(threshold, ttl_secs, 1000)
}

fn capped_cache(threshold: f32, ttl_secs: u64, max_entries: usize) -> SemanticCache {
    SemanticCache::new(
        SemanticCacheConfig {
            enabled: true,
            similarity_threshold: threshold,
            embedding_model: "m".into(),
        },
        ttl_secs,
        max_entries,
    )
}

#[test]
fn insert_caps_at_max_entries_and_evicts_the_oldest() {
    let c = capped_cache(0.92, 3600, 20);
    for i in 0..25 {
        c.insert(Some("org".into()), vec![1.0, i as f32], json!({ "r": i }));
        // Distinct `inserted_at` so "oldest" is well defined.
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(c.store.len() <= 20, "len = {}", c.store.len());
    let kept: Vec<u64> = c.store.iter().map(|entry| *entry.key()).collect();
    assert!(!kept.contains(&0), "the oldest entry must be evicted first");
    assert!(kept.contains(&24), "the newest entry must be kept");
}

#[test]
fn small_max_entries_still_bounds_the_cache() {
    // max_entries < 10: the 10 % eviction share would floor to 0 without
    // the `.max(1)` guard and the store would grow without bound.
    let c = capped_cache(0.92, 3600, 3);
    for i in 0..50 {
        c.insert(Some("org".into()), vec![1.0, i as f32], json!({ "r": i }));
    }
    assert!(c.store.len() <= 3, "len = {}", c.store.len());
}

#[test]
fn lookup_empty_store_is_none() {
    let c = cache(0.92, 3600);
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
}

#[test]
fn lookup_returns_hit_above_threshold() {
    let c = cache(0.92, 3600);
    c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), Some(json!({ "r": 1 })));
}

#[test]
fn lookup_below_threshold_is_miss() {
    let c = cache(0.92, 3600);
    // Orthogonal query => cosine 0.0, well below 0.92.
    c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
    assert_eq!(c.lookup(Some("org"), &[0.0, 1.0]), None);
}

#[test]
fn lookup_is_tenant_scoped() {
    let c = cache(0.92, 3600);
    c.insert(Some("orgA".into()), vec![1.0, 0.0], json!({ "who": "A" }));
    c.insert(Some("orgB".into()), vec![1.0, 0.0], json!({ "who": "B" }));
    // Same embedding, different tenant => each org sees only its own row.
    assert_eq!(
        c.lookup(Some("orgA"), &[1.0, 0.0]),
        Some(json!({ "who": "A" }))
    );
    assert_eq!(
        c.lookup(Some("orgB"), &[1.0, 0.0]),
        Some(json!({ "who": "B" }))
    );
    // The no-org bucket never matches a real org's entry.
    assert_eq!(c.lookup(None, &[1.0, 0.0]), None);
}

#[test]
fn lookup_none_bucket_matches_only_none() {
    let c = cache(0.92, 3600);
    c.insert(None, vec![1.0, 0.0], json!({ "shared": true }));
    assert_eq!(c.lookup(None, &[1.0, 0.0]), Some(json!({ "shared": true })));
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
}

#[test]
fn lookup_returns_nearest_neighbor() {
    let c = cache(0.5, 3600);
    // Two candidates; the query is much closer to `near` than to `far`.
    c.insert(
        Some("org".into()),
        vec![1.0, 0.0],
        json!({ "which": "near" }),
    );
    c.insert(
        Some("org".into()),
        vec![0.7, 0.7],
        json!({ "which": "far" }),
    );
    assert_eq!(
        c.lookup(Some("org"), &[1.0, 0.05]),
        Some(json!({ "which": "near" }))
    );
}

#[test]
fn lookup_returns_most_similar_of_increasingly_similar_entries() {
    let c = cache(0.5, 3600);
    // Inserted in increasing similarity to the query, so the running best
    // improves on every candidate; only the final best may be returned.
    c.insert(Some("org".into()), vec![0.6, 0.8], json!({ "rank": 3 }));
    c.insert(Some("org".into()), vec![0.8, 0.6], json!({ "rank": 2 }));
    c.insert(Some("org".into()), vec![0.99, 0.1], json!({ "rank": 1 }));
    assert_eq!(
        c.lookup(Some("org"), &[1.0, 0.0]),
        Some(json!({ "rank": 1 }))
    );
    // The best match also wins when it is not the last candidate scanned.
    c.insert(Some("org".into()), vec![0.7, 0.7], json!({ "rank": 4 }));
    assert_eq!(
        c.lookup(Some("org"), &[1.0, 0.0]),
        Some(json!({ "rank": 1 }))
    );
}

#[test]
fn lookup_with_every_candidate_below_threshold_is_miss() {
    let c = cache(0.99, 3600);
    c.insert(Some("org".into()), vec![0.6, 0.8], json!({ "r": 1 }));
    c.insert(Some("org".into()), vec![0.8, 0.6], json!({ "r": 2 }));
    c.insert(Some("org".into()), vec![0.9, 0.44], json!({ "r": 3 }));
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
}

#[test]
fn insert_uses_monotonic_keys() {
    // Distinct rows with the same tenant + embedding must not overwrite each
    // other — the monotonic counter keys them apart.
    let c = cache(0.99, 3600);
    c.insert(Some("org".into()), vec![1.0, 0.0], json!(1));
    c.insert(Some("org".into()), vec![1.0, 0.0], json!(2));
    assert_eq!(c.store.len(), 2);
}

// ─── TTL expiry (seconds granularity => one real sleep) ──────────────────

#[test]
fn expired_entries_are_skipped_and_swept() {
    // as_secs() truncates sub-second ages, so a zero-TTL entry only reads as
    // expired once a full second has elapsed. One ~1.1s sleep covers both the
    // lookup skip and the evict_expired removal.
    let c = cache(0.92, 0);
    c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
    // Fresh: age truncates to 0, and 0 > 0 is false, so still visible.
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), Some(json!({ "r": 1 })));

    std::thread::sleep(std::time::Duration::from_millis(1100));

    // Now age >= 1 > ttl_secs(0): lookup skips it...
    assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
    assert_eq!(c.store.len(), 1, "still physically present before sweep");
    // ...and the sweep removes it.
    c.evict_expired();
    assert_eq!(c.store.len(), 0);
}

#[test]
fn evict_expired_keeps_fresh_entries() {
    let c = cache(0.92, 3600);
    c.insert(Some("org".into()), vec![1.0, 0.0], json!(1));
    c.evict_expired();
    assert_eq!(c.store.len(), 1);
}

// ─── SemanticCacheRegistry ───────────────────────────────────────────────

struct StubBackend;
impl SemanticCacheBackend for StubBackend {
    fn get_embedding<'a>(
        &'a self,
        _text: &'a str,
        _http: &'a Client,
        _base_url: &'a str,
        _api_key: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<f32>>> + Send + 'a>> {
        Box::pin(async { Ok(vec![0.0]) })
    }
    fn lookup(&self, _org_id: Option<&str>, _query: &[f32]) -> Option<Value> {
        Some(json!({ "stub": true }))
    }
    fn insert(&self, _org_id: Option<String>, _embedding: Vec<f32>, _response: Value) {}
    fn evict_expired(&self) {}
}

#[test]
fn disabled_registry_has_no_active_backend() {
    let reg = SemanticCacheRegistry::disabled();
    assert!(reg.active().is_none());
    assert!(reg.available().is_empty());
}

#[test]
fn from_cache_registers_builtin_as_active() {
    let reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
    assert!(reg.active().is_some());
    assert_eq!(
        reg.available(),
        vec![SemanticCacheRegistry::BUILTIN.to_string()]
    );
    // The active built-in answers a real lookup (empty store => None).
    assert_eq!(reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]), None);
}

#[test]
fn set_active_unknown_id_is_rejected() {
    let mut reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
    assert!(!reg.set_active("nope"));
    // Active backend unchanged (still the built-in).
    assert!(reg.active().is_some());
}

#[test]
fn register_then_set_active_swaps_backend() {
    let mut reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
    reg.register(
        "stub",
        Arc::new(StubBackend) as Arc<dyn SemanticCacheBackend>,
    );
    // Registered but not yet active: built-in still answers (None on empty).
    assert_eq!(reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]), None);

    assert!(reg.set_active("stub"));
    // Now the stub's sentinel answers for any lookup.
    assert_eq!(
        reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]),
        Some(json!({ "stub": true }))
    );
    assert_eq!(
        reg.available(),
        vec![
            SemanticCacheRegistry::BUILTIN.to_string(),
            "stub".to_string()
        ]
    );
}

#[test]
fn register_replacing_active_refreshes_live_handle() {
    // Re-registering the active id must swap the live handle in place.
    let mut reg = SemanticCacheRegistry::disabled();
    reg.register(
        SemanticCacheRegistry::BUILTIN,
        Arc::new(cache(0.92, 3600)) as Arc<dyn SemanticCacheBackend>,
    );
    assert!(reg.set_active(SemanticCacheRegistry::BUILTIN));
    // Replace builtin with the stub under the same id while it is active.
    reg.register(
        SemanticCacheRegistry::BUILTIN,
        Arc::new(StubBackend) as Arc<dyn SemanticCacheBackend>,
    );
    assert_eq!(
        reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]),
        Some(json!({ "stub": true })),
        "live handle should reflect the replacement"
    );
    // Re-registering the same id must not duplicate it in the order list.
    assert_eq!(
        reg.available(),
        vec![SemanticCacheRegistry::BUILTIN.to_string()]
    );
}

//! Live round-trips against a real Redis/Valkey server.
//!
//! - `RYU_TEST_REDIS_URL` (e.g. `redis://127.0.0.1:6379/15`) runs the exact,
//!   brute-force semantic, and embedding caches;
//! - `RYU_TEST_REDISEARCH_URL` (a Redis Stack server) runs the RediSearch KNN path.
//!
//! Each test prints `SKIPPED` and passes when its variable is unset. Keys use a
//! unique prefix and a short TTL, so runs never collide and clean themselves up.

use std::time::{SystemTime, UNIX_EPOCH};

use ryu_gw_cache::{
    CacheBackend, CacheConfig, EmbeddingCache, EmbeddingCacheConfig, EmbeddingRequest,
    RedisCacheConfig, RedisExactCache, RedisSemanticCache, SemanticCacheBackend,
    SemanticCacheConfig, SemanticSearch,
};
use serde_json::json;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("ryu-test:{}:{nanos}", std::process::id())
}

fn redis_config(search: SemanticSearch) -> RedisCacheConfig {
    RedisCacheConfig {
        key_prefix: prefix(),
        semantic_search: search,
        io_timeout_ms: 2_000,
        ..RedisCacheConfig::default()
    }
}

fn semantic(url: &str, search: SemanticSearch) -> RedisSemanticCache {
    let redis = redis_config(search);
    RedisSemanticCache::new(
        redis.client(url).expect("client"),
        &redis,
        SemanticCacheConfig {
            enabled: true,
            similarity_threshold: 0.9,
            embedding_model: "m".into(),
        },
        60,
        2,
    )
}

async fn semantic_contract(cache: &RedisSemanticCache) {
    cache
        .insert_async(Some("org".into()), vec![1.0, 0.0, 0.0], json!("east"))
        .await;
    cache
        .insert_async(Some("org".into()), vec![0.0, 1.0, 0.0], json!("north"))
        .await;
    assert_eq!(
        cache.lookup_async(Some("org"), &[0.99, 0.05, 0.0]).await,
        Some(json!("east"))
    );
    assert_eq!(
        cache.lookup_async(Some("org"), &[0.0, 0.0, 1.0]).await,
        None
    );
    assert_eq!(
        cache.lookup_async(Some("other"), &[1.0, 0.0, 0.0]).await,
        None
    );
    // A third entry evicts the oldest ("east") from the per-scope cap of 2.
    cache
        .insert_async(Some("org".into()), vec![0.0, 0.0, 1.0], json!("up"))
        .await;
    assert_eq!(
        cache.lookup_async(Some("org"), &[1.0, 0.0, 0.0]).await,
        None
    );
    assert_eq!(
        cache.lookup_async(Some("org"), &[0.0, 0.0, 1.0]).await,
        Some(json!("up"))
    );
    let stats = cache.stats().expect("stats");
    assert_eq!(stats.errors, 0, "{stats:?}");
    assert_eq!(stats.evictions, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_semantic_and_embedding_caches_live() {
    let Some(url) = env("RYU_TEST_REDIS_URL") else {
        eprintln!("SKIPPED exact_semantic_and_embedding_caches_live: set RYU_TEST_REDIS_URL");
        return;
    };
    let redis = redis_config(SemanticSearch::BruteForce);
    let exact = RedisExactCache::new(
        redis.client(&url).expect("client"),
        &redis,
        &CacheConfig {
            enabled: true,
            ttl_secs: 60,
            max_entries: 10,
        },
    );
    assert_eq!(exact.get_async("k").await, None);
    exact
        .insert_async("k".into(), json!({"choices": [1]}))
        .await;
    assert_eq!(exact.get_async("k").await, Some(json!({"choices": [1]})));
    assert_eq!(exact.stats().expect("stats").errors, 0);

    semantic_contract(&semantic(&url, SemanticSearch::BruteForce)).await;

    let embeddings = EmbeddingCache::from_config(
        &EmbeddingCacheConfig {
            enabled: true,
            backend: "redis".into(),
            ttl_secs: 60,
            ..EmbeddingCacheConfig::default()
        },
        Some((
            redis.client(&url).expect("client"),
            redis.key_prefix.as_str(),
        )),
    )
    .expect("config")
    .expect("enabled");
    let request = EmbeddingRequest::from_body(&json!({"input": ["a", "b"]})).expect("cacheable");
    assert!(embeddings.lookup("scope", "m", &request).await.is_none());
    embeddings
        .store(
            "scope",
            &request,
            &json!({"data": [{"index": 0, "embedding": [0.1]}, {"index": 1, "embedding": [0.2]}]}),
        )
        .await;
    let hit = embeddings
        .lookup("scope", "m", &request)
        .await
        .expect("hit");
    assert_eq!(hit["data"][1]["embedding"], json!([0.2]));
    assert_eq!(embeddings.stats().errors, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redisearch_semantic_cache_live() {
    let Some(url) = env("RYU_TEST_REDISEARCH_URL") else {
        eprintln!(
            "SKIPPED redisearch_semantic_cache_live: set RYU_TEST_REDISEARCH_URL (Redis Stack)"
        );
        return;
    };
    semantic_contract(&semantic(&url, SemanticSearch::Redisearch)).await;
}

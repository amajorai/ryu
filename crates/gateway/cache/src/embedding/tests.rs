use super::*;
use ryu_redis_wire::testing::FakeRedis;

fn config() -> EmbeddingCacheConfig {
    EmbeddingCacheConfig {
        enabled: true,
        ..EmbeddingCacheConfig::default()
    }
}

fn request(inputs: &[&str]) -> EmbeddingRequest {
    EmbeddingRequest {
        inputs: inputs.iter().map(|s| (*s).to_owned()).collect(),
        dimensions: None,
        encoding_format: "float".into(),
    }
}

fn provider_response(vectors: &[(usize, Value)]) -> Value {
    json!({
        "object": "list",
        "data": vectors.iter().map(|(index, v)| json!({"object":"embedding","index":index,"embedding":v})).collect::<Vec<_>>(),
        "model": "m",
        "usage": {"prompt_tokens": 4, "total_tokens": 4},
    })
}

#[test]
fn config_defaults_and_validation() {
    let parsed: EmbeddingCacheConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(parsed, EmbeddingCacheConfig::default());
    assert!(!parsed.enabled);
    assert_eq!(parsed.backend, "memory");
    assert!(EmbeddingCacheConfig {
        backend: "disk".into(),
        ..config()
    }
    .validate()
    .is_err());
    assert!(EmbeddingCacheConfig {
        ttl_secs: 0,
        ..config()
    }
    .validate()
    .is_err());
    assert!(
        EmbeddingCache::from_config(&EmbeddingCacheConfig::default(), None)
            .unwrap()
            .is_none()
    );
    let redis_without_url = EmbeddingCacheConfig {
        backend: "redis".into(),
        ..config()
    };
    assert!(EmbeddingCache::from_config(&redis_without_url, None).is_err());
}

#[test]
fn request_shapes_that_bypass_the_cache() {
    assert!(EmbeddingRequest::from_body(&json!({"input": "a"})).is_some());
    assert!(
        EmbeddingRequest::from_body(&json!({"input": ["a", "b"], "dimensions": 256})).is_some()
    );
    for body in [
        json!({"input": [[1, 2, 3]]}),
        json!({"input": []}),
        json!({"input": 5}),
        json!({"input": "a", "user": "u1"}),
        json!({"input": "a", "encoding_format": "int8"}),
        json!({"input": "a", "dimensions": "big"}),
        json!({}),
    ] {
        assert!(EmbeddingRequest::from_body(&body).is_none(), "{body}");
    }
}

#[test]
fn keys_normalize_line_endings_and_edges_but_nothing_else() {
    let base = request(&["x"]);
    let key = |input: &str| embedding_key("scope", &base, input);
    assert_eq!(key("hello\r\nworld"), key("  hello\nworld\n"));
    assert_ne!(key("Hello"), key("hello"));
    assert_ne!(key("a  b"), key("a b"));
    assert_ne!(
        embedding_key("scope-a", &base, "x"),
        embedding_key("scope-b", &base, "x")
    );
    let dims = EmbeddingRequest {
        dimensions: Some(256),
        ..base.clone()
    };
    assert_ne!(
        embedding_key("s", &dims, "x"),
        embedding_key("s", &base, "x")
    );
    let b64 = EmbeddingRequest {
        encoding_format: "base64".into(),
        ..base.clone()
    };
    assert_ne!(
        embedding_key("s", &b64, "x"),
        embedding_key("s", &base, "x")
    );
}

#[tokio::test]
async fn batches_are_served_only_when_every_input_hits() {
    let cache = EmbeddingCache::from_config(&config(), None)
        .unwrap()
        .unwrap();
    let req = request(&["a", "b"]);
    assert_eq!(cache.lookup("s", "m", &req).await, None);
    // Out-of-order indices are matched by `index`.
    cache
        .store(
            "s",
            &req,
            &provider_response(&[(1, json!([0.2])), (0, json!([0.1]))]),
        )
        .await;
    let hit = cache.lookup("s", "m", &req).await.unwrap();
    assert_eq!(hit["data"][0]["embedding"], json!([0.1]));
    assert_eq!(hit["data"][1]["embedding"], json!([0.2]));
    assert_eq!(hit["data"][1]["index"], 1);
    assert_eq!(hit["usage"]["total_tokens"], 0);
    assert_eq!(hit["model"], "m");
    // A single input reuses a vector stored from the batch.
    assert!(cache.lookup("s", "m", &request(&["b"])).await.is_some());
    // A batch with one unseen input is a miss.
    assert!(cache
        .lookup("s", "m", &request(&["a", "c"]))
        .await
        .is_none());
    // Another scope never sees the vectors.
    assert!(cache.lookup("other", "m", &req).await.is_none());
    let stats = cache.stats();
    assert_eq!((stats.hits, stats.misses, stats.stores), (2, 3, 2));
    assert_eq!(stats.entries, Some(2));
}

#[tokio::test]
async fn malformed_provider_responses_store_nothing() {
    let cache = EmbeddingCache::from_config(&config(), None)
        .unwrap()
        .unwrap();
    let req = request(&["a", "b"]);
    for response in [
        provider_response(&[(0, json!([0.1]))]),
        provider_response(&[(0, json!([0.1])), (0, json!([0.2]))]),
        provider_response(&[(0, json!([0.1])), (5, json!([0.2]))]),
        provider_response(&[(0, json!([])), (1, json!([0.2]))]),
        provider_response(&[(0, json!({"x": 1})), (1, json!([0.2]))]),
        json!({"error": "nope"}),
    ] {
        cache.store("s", &req, &response).await;
    }
    assert_eq!(cache.stats().entries, Some(0));
}

#[tokio::test]
async fn memory_store_evicts_least_recently_used_by_count_and_bytes() {
    let cache = EmbeddingCache::from_config(
        &EmbeddingCacheConfig {
            max_entries: 2,
            ..config()
        },
        None,
    )
    .unwrap()
    .unwrap();
    for input in ["a", "b"] {
        cache
            .store(
                "s",
                &request(&[input]),
                &provider_response(&[(0, json!([1.0]))]),
            )
            .await;
    }
    // Touch "a" so "b" becomes least recently used.
    assert!(cache.lookup("s", "m", &request(&["a"])).await.is_some());
    cache
        .store(
            "s",
            &request(&["c"]),
            &provider_response(&[(0, json!([1.0]))]),
        )
        .await;
    assert!(cache.lookup("s", "m", &request(&["a"])).await.is_some());
    assert!(cache.lookup("s", "m", &request(&["b"])).await.is_none());
    assert_eq!(cache.stats().evictions, 1);

    let tiny = EmbeddingCache::from_config(
        &EmbeddingCacheConfig {
            max_bytes: 200,
            ..config()
        },
        None,
    )
    .unwrap()
    .unwrap();
    let vector = json!([0.123_456_7, 0.234_567_8, 0.345_678_9]);
    for input in ["a", "b", "c"] {
        tiny.store(
            "s",
            &request(&[input]),
            &provider_response(&[(0, vector.clone())]),
        )
        .await;
    }
    let stats = tiny.stats();
    assert!(stats.bytes.unwrap() <= 200, "{stats:?}");
    assert!(stats.evictions >= 1);
}

#[tokio::test]
async fn expired_vectors_are_not_served_and_are_swept() {
    let ttl = Duration::from_secs(1);
    let short_ttl = EmbeddingCacheConfig {
        ttl_secs: ttl.as_secs(),
        ..config()
    };
    let cache = EmbeddingCache::from_config(&short_ttl, None)
        .unwrap()
        .unwrap();
    let memory = cache.memory.clone().unwrap();
    cache
        .store(
            "s",
            &request(&["a", "b"]),
            &provider_response(&[(0, json!([1.0])), (1, json!([2.0]))]),
        )
        .await;
    // Back-date by just past the TTL. `Instant` may count from boot (Windows),
    // so subtracting a long span such as the one-day default TTL underflows on
    // a machine that has been up for less than that.
    let expired_at = Instant::now()
        .checked_sub(ttl + Duration::from_secs(1))
        .expect("monotonic clock has run for more than two seconds");
    {
        let mut lru = memory.lock();
        for slot in lru.slots.values_mut() {
            slot.inserted = expired_at;
        }
    }
    assert!(cache.lookup("s", "m", &request(&["a"])).await.is_none());
    assert_eq!(cache.stats().entries, Some(1));
    cache.evict_expired();
    assert_eq!(cache.stats().entries, Some(0));
}

#[tokio::test]
async fn redis_store_round_trips_with_ttl() {
    let server = FakeRedis::start().await;
    let client = Arc::new(RedisClient::from_url(&server.url()).unwrap());
    let config = EmbeddingCacheConfig {
        backend: "redis".into(),
        ttl_secs: 120,
        ..config()
    };
    let cache = EmbeddingCache::from_config(&config, Some((client, "t")))
        .unwrap()
        .unwrap();
    let req = request(&["a", "b"]);
    assert!(cache.lookup("s", "m", &req).await.is_none());
    cache
        .store(
            "s",
            &req,
            &provider_response(&[(0, json!("AAAA")), (1, json!("BBBB"))]),
        )
        .await;
    let hit = cache.lookup("s", "m", &req).await.unwrap();
    assert_eq!(hit["data"][1]["embedding"], "BBBB");
    let key = format!("t:emb:{}", embedding_key("s", &req, "a"));
    let ttl = server.ttl(&key).unwrap();
    assert!(ttl > Duration::from_secs(100) && ttl <= Duration::from_secs(120));
    let stats = cache.stats();
    assert_eq!(stats.backend, "redis");
    assert_eq!((stats.hits, stats.misses, stats.stores), (1, 1, 2));
}

#[tokio::test]
async fn redis_outages_are_counted_misses() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("redis://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = crate::redis::RedisCacheConfig {
        connect_timeout_ms: 200,
        ..crate::redis::RedisCacheConfig::default()
    }
    .client(&url)
    .unwrap();
    let cache = EmbeddingCache::from_config(
        &EmbeddingCacheConfig {
            backend: "redis".into(),
            ..config()
        },
        Some((client, "t")),
    )
    .unwrap()
    .unwrap();
    let req = request(&["a"]);
    cache
        .store("s", &req, &provider_response(&[(0, json!([1.0]))]))
        .await;
    assert!(cache.lookup("s", "m", &req).await.is_none());
    assert_eq!(cache.stats().errors, 2);
}

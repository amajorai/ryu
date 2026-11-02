use super::*;

#[test]
fn gated_normalizes_variants() {
    assert!(gated_to_bool(&serde_json::json!("manual")));
    assert!(gated_to_bool(&serde_json::json!(true)));
    assert!(!gated_to_bool(&serde_json::json!(false)));
    assert!(!gated_to_bool(&serde_json::json!("false")));
    assert!(!gated_to_bool(&serde_json::Value::Null));
}

#[test]
fn hf_endpoint_variants_and_cache_tag() {
    let hf = HfEndpoint::huggingface();
    assert_eq!(hf.api_base, "https://huggingface.co/api");
    assert_eq!(hf.host, "https://huggingface.co");
    assert_eq!(hf.cache_tag(), "huggingface.co");

    let ms = HfEndpoint::modelscope();
    assert!(ms.api_base.contains("modelscope"));
    assert_eq!(ms.cache_tag(), "modelscope.cn");

    // A base ending in `/api/v2/` keeps the api root and strips to the host.
    let custom = HfEndpoint::from_base_url("https://mirror.example.com/api/v2/");
    assert_eq!(custom.api_base, "https://mirror.example.com/api/v2");
    assert_eq!(custom.host, "https://mirror.example.com");

    // A base with no `/api` segment reuses itself as the content host.
    let plain = HfEndpoint::from_base_url("https://plain.example.com");
    assert_eq!(plain.api_base, "https://plain.example.com");
    assert_eq!(plain.host, "https://plain.example.com");

    assert_eq!(HfEndpoint::default(), HfEndpoint::huggingface());
}

#[test]
fn catalog_sort_parse_and_hf_key() {
    assert!(matches!(
        CatalogSort::parse("downloads"),
        CatalogSort::Downloads
    ));
    assert!(matches!(CatalogSort::parse("likes"), CatalogSort::Likes));
    assert!(matches!(CatalogSort::parse("recent"), CatalogSort::Recent));
    assert!(matches!(
        CatalogSort::parse("lastModified"),
        CatalogSort::Recent
    ));
    assert!(matches!(
        CatalogSort::parse("anything"),
        CatalogSort::Trending
    ));
    assert_eq!(CatalogSort::Trending.hf_key(), "trendingScore");
    assert_eq!(CatalogSort::Downloads.hf_key(), "downloads");
    assert_eq!(CatalogSort::Likes.hf_key(), "likes");
    assert_eq!(CatalogSort::Recent.hf_key(), "lastModified");
}

#[test]
fn diffusion_pipeline_tag_detection() {
    assert!(is_diffusion_pipeline_tag("text-to-image"));
    assert!(is_diffusion_pipeline_tag("image-to-image"));
    assert!(is_diffusion_pipeline_tag("text-to-video"));
    assert!(!is_diffusion_pipeline_tag("text-generation"));
}

#[test]
fn gguf_fields_extracts_or_defaults() {
    let block = Some(HfGguf {
        context_length: Some(8192),
        architecture: Some("llama".into()),
        total: Some(7_000_000_000),
    });
    assert_eq!(
        gguf_fields(&block),
        (Some(8192), Some("llama".to_string()), Some(7_000_000_000))
    );
    assert_eq!(gguf_fields(&None), (None, None, None));
}

#[test]
fn cache_put_get_invalidate() {
    let key = "list:unit-test-cache-unique-1".to_string();
    assert!(cache_get(&key, LIST_TTL).is_none());
    cache_put(key.clone(), serde_json::json!({ "a": 1 }));
    assert_eq!(
        cache_get(&key, LIST_TTL),
        Some(serde_json::json!({ "a": 1 }))
    );
    cache_invalidate("unit-test-cache-unique-1");
    assert!(cache_get(&key, LIST_TTL).is_none());
}

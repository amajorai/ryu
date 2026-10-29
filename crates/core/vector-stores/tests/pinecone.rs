//! Pinecone control/data-plane wire tests against scripted HTTP servers.

mod support;

use std::sync::Arc;

use ryu_vector_stores::{
    build, pinecone, CollectionSpec, DistanceMetric, MetadataFilter, VectorQuery, VectorRecord,
    VectorStoreConfig, VectorStoreProvider,
};
use serde_json::json;
use support::MockServer;

fn config(control: &str) -> VectorStoreConfig {
    VectorStoreConfig {
        provider: Some(VectorStoreProvider::Pinecone),
        url: Some(control.into()),
        api_key: Some("pc-key".into()),
        index: Some("ryu".into()),
        text_key: Some("text".into()),
        cloud: Some("aws".into()),
        region: Some("us-east-1".into()),
        ..VectorStoreConfig::default()
    }
}

async fn data_plane() -> MockServer {
    MockServer::start(|request| match request.path.as_str() {
        "/query" => (
            200,
            json!({"matches": [
                {"id": "a", "score": 0.8, "metadata": {"text": "alpha", "lang": "en"}},
                {"id": "b", "score": 0.4}
            ], "namespace": "docs"}),
        ),
        _ => (200, json!({})),
    })
    .await
}

#[tokio::test]
async fn creates_a_missing_index_then_writes_and_queries_the_namespace() {
    let data = Arc::new(data_plane().await);
    let host = data.url.clone();
    let created = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = Arc::clone(&created);
    let control = MockServer::start(move |request| {
        let describe = json!({
            "name": "ryu", "dimension": 2, "metric": "cosine",
            "host": host, "status": {"ready": true, "state": "Ready"}
        });
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/indexes/ryu") if !flag.load(std::sync::atomic::Ordering::SeqCst) => {
                (404, json!({"error": {"code": "NOT_FOUND"}}))
            }
            ("GET", "/indexes/ryu") => (200, describe),
            ("POST", "/indexes") => {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                (201, describe)
            }
            _ => (500, json!({})),
        }
    })
    .await;
    let store = build(&config(&control.url)).unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap();
    let create = control.find("POST", "/indexes");
    assert_eq!(
        create.body,
        json!({
            "name": "ryu", "dimension": 2, "metric": "cosine",
            "spec": {"serverless": {"cloud": "aws", "region": "us-east-1"}}
        })
    );
    assert_eq!(create.header("api-key"), Some("pc-key"));
    assert_eq!(
        create.header("x-pinecone-api-version"),
        Some(pinecone::API_VERSION)
    );

    store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "a".into(),
                vector: vec![1.0, 0.0],
                document: Some("alpha".into()),
                metadata: json!({"lang": "en", "skip": null}).as_object().cloned().unwrap(),
            }],
        )
        .await
        .unwrap();
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0, 0.0],
                top_k: 2,
                filter: Some(MetadataFilter::Or(vec![
                    MetadataFilter::eq("lang", "en"),
                    MetadataFilter::In {
                        field: "tier".into(),
                        values: vec![json!(1), json!(2)],
                    },
                ])),
            },
        )
        .await
        .unwrap();
    store.delete("docs", &["a".into()]).await.unwrap();

    let upsert = data.find("POST", "/vectors/upsert");
    assert_eq!(
        upsert.body,
        json!({"vectors": [{"id": "a", "values": [1.0, 0.0], "metadata": {"lang": "en", "text": "alpha"}}], "namespace": "docs"})
    );
    assert_eq!(upsert.header("api-key"), Some("pc-key"));
    let query = data.find("POST", "/query");
    assert_eq!(
        query.body,
        json!({
            "vector": [1.0, 0.0], "topK": 2, "namespace": "docs",
            "includeMetadata": true, "includeValues": false,
            "filter": {"$or": [{"lang": {"$eq": "en"}}, {"tier": {"$in": [1, 2]}}]}
        })
    );
    assert_eq!(hits[0].id, "a");
    assert_eq!(hits[0].document.as_deref(), Some("alpha"));
    assert_eq!(hits[0].metadata, *json!({"lang": "en"}).as_object().unwrap());
    assert!((hits[0].score - 0.8).abs() < 1e-6);
    assert!(hits[1].document.is_none());
    let delete = data.find("POST", "/vectors/delete");
    assert_eq!(delete.body, json!({"ids": ["a"], "namespace": "docs"}));
}

#[tokio::test]
async fn data_plane_is_resolved_lazily_and_dimension_mismatch_fails() {
    let data = data_plane().await;
    let host = data.url.clone();
    let control = MockServer::start(move |_| {
        (
            200,
            json!({"name": "ryu", "dimension": 8, "metric": "euclidean", "host": host, "status": {"ready": true}}),
        )
    })
    .await;
    let store = build(&config(&control.url)).unwrap();
    // No ensure: the first query describes the index once.
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0],
                top_k: 1,
                filter: None,
            },
        )
        .await
        .unwrap();
    // Euclidean scores are negated distances.
    assert!((hits[0].score + 0.8).abs() < 1e-6);
    let error = store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("8 dimensions"), "{error}");
}

#[tokio::test]
async fn missing_index_without_cloud_and_region_is_an_error() {
    let control = MockServer::start(|_| (404, json!({}))).await;
    let mut cfg = config(&control.url);
    cfg.cloud = None;
    let store = build(&cfg).unwrap();
    let error = store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cloud"), "{error}");
}

#[test]
fn pinecone_requires_an_index_and_a_key() {
    let mut cfg = config("http://127.0.0.1:1");
    cfg.index = None;
    assert!(build(&cfg).is_err());
    let mut cfg = config("http://127.0.0.1:1");
    cfg.api_key = None;
    assert!(build(&cfg).is_err());
}

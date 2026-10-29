//! Chroma v2 wire-protocol tests against a scripted HTTP server.

mod support;

use ryu_vector_stores::{
    build, CollectionSpec, DistanceMetric, MetadataFilter, VectorQuery, VectorRecord,
    VectorStoreConfig, VectorStoreProvider,
};
use serde_json::json;
use support::MockServer;

const PREFIX: &str = "/api/v2/tenants/acme/databases/kb/collections";

fn config(url: &str) -> VectorStoreConfig {
    VectorStoreConfig {
        provider: Some(VectorStoreProvider::Chroma),
        url: Some(url.into()),
        api_key: Some("chroma-token".into()),
        tenant: Some("acme".into()),
        database: Some("kb".into()),
        ..VectorStoreConfig::default()
    }
}

#[tokio::test]
async fn ensure_upsert_query_delete_address_the_collection_id() {
    let server = MockServer::start(|request| {
        let path = request.path.as_str();
        if path == PREFIX {
            return (
                200,
                json!({"id": "c0ffee", "name": "docs", "configuration_json": {"hnsw": {"space": "l2"}}}),
            );
        }
        if path.ends_with("/query") {
            return (
                200,
                json!({
                    "ids": [["a", "b"]],
                    "distances": [[0.25, 1.5]],
                    "documents": [["alpha", null]],
                    "metadatas": [[{"lang": "en"}, null]]
                }),
            );
        }
        (200, json!({}))
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap();
    store
        .upsert(
            "docs",
            &[
                VectorRecord {
                    id: "a".into(),
                    vector: vec![1.0, 0.0],
                    document: Some("alpha".into()),
                    metadata: json!({"lang": "en", "tags": ["x", "y"]})
                        .as_object()
                        .cloned()
                        .unwrap(),
                },
                VectorRecord {
                    id: "b".into(),
                    vector: vec![0.0, 1.0],
                    document: None,
                    metadata: serde_json::Map::new(),
                },
            ],
        )
        .await
        .unwrap();
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0, 0.0],
                top_k: 2,
                filter: Some(MetadataFilter::And(vec![
                    MetadataFilter::eq("lang", "en"),
                    MetadataFilter::In {
                        field: "tier".into(),
                        values: vec![json!(1)],
                    },
                ])),
            },
        )
        .await
        .unwrap();
    store.delete("docs", &["b".into()]).await.unwrap();

    let create = server.find("POST", PREFIX);
    assert_eq!(create.path, PREFIX);
    assert_eq!(
        create.body,
        json!({"name": "docs", "get_or_create": true, "configuration": {"hnsw": {"space": "cosine"}}})
    );
    assert_eq!(create.header("x-chroma-token"), Some("chroma-token"));

    let upsert = server.find("POST", &format!("{PREFIX}/c0ffee/upsert"));
    assert_eq!(
        upsert.body,
        json!({
            "ids": ["a", "b"],
            "embeddings": [[1.0, 0.0], [0.0, 1.0]],
            "documents": ["alpha", null],
            "metadatas": [{"lang": "en", "tags": "[\"x\",\"y\"]"}, null]
        })
    );

    let query = server.find("POST", &format!("{PREFIX}/c0ffee/query"));
    assert_eq!(
        query.body["where"],
        json!({"$and": [{"lang": {"$eq": "en"}}, {"tier": {"$in": [1]}}]})
    );
    assert_eq!(query.body["n_results"], 2);
    assert_eq!(query.body["query_embeddings"], json!([[1.0, 0.0]]));

    // The existing collection is l2: distances become negated scores.
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, "a");
    assert!((hits[0].score + 0.25).abs() < 1e-6);
    assert_eq!(hits[0].document.as_deref(), Some("alpha"));
    assert_eq!(hits[0].metadata["lang"], "en");
    assert!(hits[1].document.is_none());

    let delete = server.find("POST", &format!("{PREFIX}/c0ffee/delete"));
    assert_eq!(delete.body, json!({"ids": ["b"]}));
}

#[tokio::test]
async fn an_unensured_collection_is_resolved_by_name_once() {
    let server = MockServer::start(|request| {
        if request.method == "GET" {
            return (200, json!({"id": "1234", "name": "docs"}));
        }
        (
            200,
            json!({"ids": [["a"]], "distances": [[0.1]], "documents": [["x"]], "metadatas": [[{}]]}),
        )
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let query = VectorQuery {
        vector: vec![1.0],
        top_k: 1,
        filter: Some(MetadataFilter::Or(vec![MetadataFilter::eq("lang", "en")])),
    };
    let hits = store.query("docs", &query).await.unwrap();
    store.query("docs", &query).await.unwrap();
    server.find("GET", &format!("{PREFIX}/docs"));
    // Cosine default: score = 1 - distance.
    assert!((hits[0].score - 0.9).abs() < 1e-6);
    // A single-child `or` is unwrapped (Chroma needs two operands).
    let requests = server.requests();
    assert_eq!(requests[1].body["where"], json!({"lang": {"$eq": "en"}}));
}

#[tokio::test]
async fn missing_collection_is_a_clear_error() {
    let server = MockServer::start(|_| (404, json!({"error": "NotFoundError"}))).await;
    let store = build(&config(&server.url)).unwrap();
    let error = store.delete("docs", &["a".into()]).await.unwrap_err();
    assert!(error.to_string().contains("does not exist"), "{error}");
}

#[tokio::test]
async fn a_recreated_collection_is_re_resolved_after_a_404() {
    // The collection was ensured as `old-id`, then deleted and recreated as
    // `new-id`: the stale id 404s once and the query retries on the new id.
    let server = MockServer::start(|request| match request.path.as_str() {
        PREFIX => (200, json!({"id": "old-id", "name": "docs"})),
        path if path == format!("{PREFIX}/docs") => (200, json!({"id": "new-id", "name": "docs"})),
        path if path == format!("{PREFIX}/old-id/query") => (404, json!({"error": "NotFound"})),
        path if path == format!("{PREFIX}/new-id/query") => (
            200,
            json!({"ids": [["a"]], "distances": [[0.1]], "documents": [["alpha"]], "metadatas": [[null]]}),
        ),
        _ => (500, json!({})),
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap();
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0, 0.0],
                top_k: 1,
                filter: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(hits[0].id, "a");
    server.find("POST", &format!("{PREFIX}/old-id/query"));
    server.find("POST", &format!("{PREFIX}/new-id/query"));
}

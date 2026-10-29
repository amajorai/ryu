//! Milvus RESTful v2 wire tests against a scripted HTTP server.

mod support;

use ryu_vector_stores::milvus::filter_expression;
use ryu_vector_stores::{
    build, CollectionSpec, DistanceMetric, MetadataFilter, VectorQuery, VectorRecord,
    VectorStoreConfig, VectorStoreProvider,
};
use serde_json::json;
use support::MockServer;

fn config(url: &str) -> VectorStoreConfig {
    VectorStoreConfig {
        provider: Some(VectorStoreProvider::Milvus),
        url: Some(url.into()),
        api_key: Some("root:Milvus".into()),
        ..VectorStoreConfig::default()
    }
}

#[test]
fn filter_expressions_quote_and_escape() {
    let filter = MetadataFilter::Or(vec![
        MetadataFilter::eq("lang", "e\"n"),
        MetadataFilter::And(vec![
            MetadataFilter::In {
                field: "tier".into(),
                values: vec![json!(1), json!(2)],
            },
            MetadataFilter::eq("pinned", false),
        ]),
    ]);
    assert_eq!(
        filter_expression(&filter),
        "((lang == \"e\\\"n\") or (((tier in [1, 2]) and (pinned == false))))"
    );
}

#[tokio::test]
async fn creates_upserts_searches_and_deletes() {
    let server = MockServer::start(|request| match request.path.as_str() {
        "/v2/vectordb/collections/has" => (200, json!({"code": 0, "data": {"has": false}})),
        "/v2/vectordb/entities/search" => (
            200,
            json!({"code": 0, "data": [
                {"id": "a", "distance": 0.91, "document": "alpha", "lang": "en"},
                {"id": "b", "distance": 0.2}
            ]}),
        ),
        _ => (200, json!({"code": 0, "data": {}})),
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Dot,
        })
        .await
        .unwrap();
    store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "a".into(),
                vector: vec![1.0, 0.0],
                document: Some("alpha".into()),
                metadata: json!({"lang": "en"}).as_object().cloned().unwrap(),
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
                filter: Some(MetadataFilter::eq("lang", "en")),
            },
        )
        .await
        .unwrap();
    store
        .delete("docs", &["a".into(), "b\"c".into()])
        .await
        .unwrap();

    let create = server.find("POST", "/v2/vectordb/collections/create");
    assert_eq!(
        create.body,
        json!({
            "collectionName": "docs", "dimension": 2, "metricType": "IP",
            "idType": "VarChar", "primaryFieldName": "id", "vectorFieldName": "vector",
            "params": {"max_length": 512, "enableDynamicField": true}
        })
    );
    assert_eq!(create.header("authorization"), Some("Bearer root:Milvus"));
    let upsert = server.find("POST", "/v2/vectordb/entities/upsert");
    assert_eq!(
        upsert.body,
        json!({"collectionName": "docs", "data": [{"lang": "en", "id": "a", "vector": [1.0, 0.0], "document": "alpha"}]})
    );
    let search = server.find("POST", "/v2/vectordb/entities/search");
    assert_eq!(
        search.body,
        json!({
            "collectionName": "docs", "data": [[1.0, 0.0]], "annsField": "vector",
            "limit": 2, "outputFields": ["*"], "filter": "lang == \"en\""
        })
    );
    assert_eq!(hits[0].id, "a");
    assert!((hits[0].score - 0.91).abs() < 1e-6);
    assert_eq!(hits[0].document.as_deref(), Some("alpha"));
    assert_eq!(hits[0].metadata, *json!({"lang": "en"}).as_object().unwrap());
    let delete = server.find("POST", "/v2/vectordb/entities/delete");
    assert_eq!(
        delete.body,
        json!({"collectionName": "docs", "filter": "id in [\"a\", \"b\\\"c\"]"})
    );
}

#[tokio::test]
async fn existing_collection_is_described_and_envelope_errors_surface() {
    let server = MockServer::start(|request| match request.path.as_str() {
        "/v2/vectordb/collections/has" => (200, json!({"code": 0, "data": {"has": true}})),
        "/v2/vectordb/collections/describe" => (
            200,
            json!({"code": 0, "data": {
                "fields": [{"name": "vector", "params": [{"key": "dim", "value": "4"}]}],
                "indexes": [{"metricType": "L2"}]
            }}),
        ),
        _ => (200, json!({"code": 1100, "message": "collection not loaded"})),
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("4 dimensions"), "{error}");
    let error = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0],
                top_k: 1,
                filter: None,
            },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("collection not loaded"), "{error}");
}

#[tokio::test]
async fn metadata_may_not_shadow_reserved_fields() {
    let server = MockServer::start(|_| (200, json!({"code": 0}))).await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "a".into(),
                vector: vec![1.0],
                document: None,
                metadata: json!({"vector": 1}).as_object().cloned().unwrap(),
            }],
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("collides"), "{error}");
    assert!(server.requests().is_empty());
}

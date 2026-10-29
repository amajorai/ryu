//! Qdrant wire-protocol tests against a scripted HTTP server.

mod support;

use ryu_vector_stores::{
    build, derive_uuid, CollectionSpec, DistanceMetric, MetadataFilter, VectorQuery, VectorRecord,
    VectorStoreConfig, VectorStoreProvider,
};
use serde_json::json;
use support::MockServer;

fn config(url: &str) -> VectorStoreConfig {
    VectorStoreConfig {
        provider: Some(VectorStoreProvider::Qdrant),
        url: Some(format!("{url}/")),
        api_key: Some("qd-key".into()),
        text_key: Some("page_content".into()),
        ..VectorStoreConfig::default()
    }
}

#[tokio::test]
async fn creates_a_missing_collection_and_upserts_with_derived_ids() {
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/collections/docs") => (404, json!({"status": {"error": "Not found"}})),
                ("PUT", _) => (200, json!({"result": true, "status": "ok"})),
                _ => (500, json!({})),
            },
        )
        .await;
    let store = build(&config(&server.url)).unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 3,
            metric: DistanceMetric::Euclidean,
        })
        .await
        .unwrap();
    store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "memory:1".into(),
                vector: vec![0.5, 0.25, 0.125],
                document: Some("hello".into()),
                metadata: json!({"lang": "en"}).as_object().cloned().unwrap(),
            }],
        )
        .await
        .unwrap();

    let create = server.find("PUT", "/collections/docs");
    assert_eq!(create.path, "/collections/docs");
    assert_eq!(
        create.body,
        json!({"vectors": {"size": 3, "distance": "Euclid"}})
    );
    assert_eq!(create.header("api-key"), Some("qd-key"));

    let upsert = server.find("PUT", "/collections/docs/points");
    assert_eq!(upsert.path, "/collections/docs/points?wait=true");
    let point = &upsert.body["points"][0];
    assert_eq!(point["id"], derive_uuid("memory:1"));
    assert_eq!(point["vector"], json!([0.5, 0.25, 0.125]));
    assert_eq!(
        point["payload"],
        json!({"ryu_id": "memory:1", "page_content": "hello", "metadata": {"lang": "en"}})
    );
}

#[tokio::test]
async fn existing_collection_dimension_mismatch_is_an_error() {
    let server = MockServer::start(|_| {
        (
            200,
            json!({"result": {"config": {"params": {"vectors": {"size": 8, "distance": "Cosine"}}}}}),
        )
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .ensure_collection(&CollectionSpec {
            name: "docs".into(),
            dimensions: 3,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("8 dimensions"), "{error}");
}

#[tokio::test]
async fn query_sends_a_must_should_filter_and_maps_hits() {
    let server = MockServer::start(|request| {
        assert_eq!(request.path, "/collections/docs/points/search");
        (
            200,
            json!({"result": [
                {"id": derive_uuid("a"), "score": 0.93, "payload": {"ryu_id": "a", "page_content": "alpha", "metadata": {"lang": "en"}}},
                {"id": "6f9619ff-8b86-d011-b42d-00c04fc964ff", "score": 0.5, "payload": {"page_content": "foreign"}}
            ]}),
        )
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0, 0.0, 0.0],
                top_k: 2,
                filter: Some(MetadataFilter::And(vec![
                    MetadataFilter::eq("lang", "en"),
                    MetadataFilter::Or(vec![
                        MetadataFilter::In {
                            field: "tier".into(),
                            values: vec![json!(1), json!(2)],
                        },
                        MetadataFilter::eq("pinned", true),
                    ]),
                ])),
            },
        )
        .await
        .unwrap();
    let request = server.find("POST", "/collections/docs/points/search");
    assert_eq!(
        request.body,
        json!({
            "vector": [1.0, 0.0, 0.0],
            "limit": 2,
            "with_payload": true,
            "filter": {"must": [
                {"must": [{"key": "metadata.lang", "match": {"value": "en"}}]},
                {"should": [
                    {"must": [{"key": "metadata.tier", "match": {"any": [1, 2]}}]},
                    {"must": [{"key": "metadata.pinned", "match": {"value": true}}]}
                ]}
            ]}
        })
    );
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, "a");
    assert_eq!(hits[0].document.as_deref(), Some("alpha"));
    assert_eq!(hits[0].metadata["lang"], "en");
    assert!((hits[0].score - 0.93).abs() < 1e-6);
    // A point written by another tool keeps its own id.
    assert_eq!(hits[1].id, "6f9619ff-8b86-d011-b42d-00c04fc964ff");
}

#[tokio::test]
async fn delete_maps_ids_and_errors_surface_the_status() {
    let server = MockServer::start(|request| {
        if request.path.starts_with("/collections/docs/points/delete") {
            (200, json!({"result": {"status": "completed"}}))
        } else {
            (400, json!({"status": {"error": "Wrong input: bad vector"}}))
        }
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    store.delete("docs", &["a".into()]).await.unwrap();
    let delete = server.find("POST", "/collections/docs/points/delete");
    assert_eq!(delete.body, json!({"points": [derive_uuid("a")]}));

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
    let message = format!("{error:#}");
    assert!(
        message.contains("400") && message.contains("bad vector"),
        "{message}"
    );
}

#[tokio::test]
async fn redirects_are_not_followed_so_the_api_key_stays_on_the_configured_host() {
    let elsewhere = MockServer::start(|_| (200, json!({"result": []}))).await;
    let target = format!("{}/collections/docs/points/search", elsewhere.url);
    let server = MockServer::start(move |_| (307, json!({ "$location": target }))).await;
    let store = build(&config(&server.url)).unwrap();
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
    assert!(error.to_string().contains("307"), "{error}");
    assert!(
        elsewhere.requests().is_empty(),
        "the redirect target was contacted"
    );
}

#[tokio::test]
async fn non_finite_query_vectors_are_rejected_before_any_request() {
    let server = MockServer::start(|_| (200, json!({"result": []}))).await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![f32::NAN],
                top_k: 1,
                filter: None,
            },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("non-finite"), "{error}");
    assert!(server.requests().is_empty());
}

//! Weaviate REST + GraphQL wire tests against a scripted HTTP server.

mod support;

use ryu_vector_stores::weaviate::{class_name, near_vector_query, where_graphql};
use ryu_vector_stores::{
    build, derive_uuid, CollectionSpec, DistanceMetric, MetadataFilter, VectorQuery, VectorRecord,
    VectorStoreConfig, VectorStoreProvider,
};
use serde_json::json;
use support::MockServer;

fn config(url: &str) -> VectorStoreConfig {
    VectorStoreConfig {
        provider: Some(VectorStoreProvider::Weaviate),
        url: Some(url.into()),
        api_key: Some("wv-key".into()),
        ..VectorStoreConfig::default()
    }
}

#[test]
fn class_names_are_capitalized_and_dash_free() {
    assert_eq!(class_name("ryu_knowledge").unwrap(), "Ryu_knowledge");
    assert_eq!(class_name("docs-v2").unwrap(), "Docs_v2");
    assert!(class_name("../x").is_err());
}

#[test]
fn where_clause_escapes_values_and_types_them() {
    let filter = MetadataFilter::And(vec![
        MetadataFilter::eq("lang", "en\" } evil"),
        MetadataFilter::In {
            field: "tier".into(),
            values: vec![json!(1), json!(2.5)],
        },
        MetadataFilter::eq("pinned", true),
    ]);
    assert_eq!(
        where_graphql(&filter),
        "{operator: And, operands: [\
         {path: [\"lang\"], operator: Equal, valueText: \"en\\\" } evil\"}, \
         {operator: Or, operands: [{path: [\"tier\"], operator: Equal, valueNumber: 1}, \
         {path: [\"tier\"], operator: Equal, valueNumber: 2.5}]}, \
         {path: [\"pinned\"], operator: Equal, valueBoolean: true}]}"
    );
}

#[test]
fn near_vector_query_shape() {
    let query = VectorQuery {
        vector: vec![0.5, -1.0],
        top_k: 4,
        filter: None,
    };
    assert_eq!(
        near_vector_query("Docs", "document", &query),
        "{ Get { Docs(nearVector: {vector: [0.5, -1.0]}, limit: 4) \
         { ryuId document ryuMetadata _additional { id distance } } } }"
    );
}

#[tokio::test]
async fn schema_batch_graphql_and_delete_round_trip() {
    let server = MockServer::start(|request| match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/schema/Docs") => (404, json!({})),
        ("POST", "/v1/schema") => (200, json!({"class": "Docs"})),
        ("POST", "/v1/batch/objects") => (200, json!([{"id": "x", "result": {}}])),
        ("POST", "/v1/graphql") => (
            200,
            json!({"data": {"Get": {"Docs": [
                {"ryuId": "a", "document": "alpha", "ryuMetadata": "{\"lang\":\"en\",\"tags\":[1]}",
                 "_additional": {"id": derive_uuid("a"), "distance": 0.2}}
            ]}}}),
        ),
        ("DELETE", _) => (404, json!({})),
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
    store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "a".into(),
                vector: vec![1.0, 0.0],
                document: Some("alpha".into()),
                metadata: json!({"lang": "en", "tags": [1]})
                    .as_object()
                    .cloned()
                    .unwrap(),
            }],
        )
        .await
        .unwrap();
    let hits = store
        .query(
            "docs",
            &VectorQuery {
                vector: vec![1.0, 0.0],
                top_k: 3,
                filter: Some(MetadataFilter::eq("lang", "en")),
            },
        )
        .await
        .unwrap();
    // A 404 on delete means "already gone".
    store.delete("docs", &["a".into()]).await.unwrap();

    let schema = server.find("POST", "/v1/schema");
    assert_eq!(schema.body["class"], "Docs");
    assert_eq!(schema.body["vectorizer"], "none");
    assert_eq!(
        schema.body["vectorIndexConfig"],
        json!({"distance": "cosine"})
    );
    assert_eq!(schema.header("authorization"), Some("Bearer wv-key"));

    let batch = server.find("POST", "/v1/batch/objects");
    let object = &batch.body["objects"][0];
    assert_eq!(object["class"], "Docs");
    assert_eq!(object["id"], derive_uuid("a"));
    assert_eq!(
        object["properties"],
        json!({"lang": "en", "ryuId": "a", "ryuMetadata": "{\"lang\":\"en\",\"tags\":[1]}", "document": "alpha"})
    );

    let graphql = server.find("POST", "/v1/graphql");
    let text = graphql.body["query"].as_str().unwrap();
    assert!(
        text.contains("Docs(nearVector: {vector: [1.0, 0.0]}, limit: 3, where: {path: [\"lang\"]")
    );

    assert_eq!(hits[0].id, "a");
    assert!((hits[0].score - 0.8).abs() < 1e-6);
    assert_eq!(hits[0].metadata["tags"], json!([1]));
    assert_eq!(hits[0].document.as_deref(), Some("alpha"));

    server.find("DELETE", &format!("/v1/objects/Docs/{}", derive_uuid("a")));
}

#[tokio::test]
async fn batch_object_errors_and_graphql_errors_fail() {
    let server = MockServer::start(|request| match request.path.as_str() {
        "/v1/batch/objects" => (
            200,
            json!([{"id": "x", "result": {"errors": {"error": [{"message": "vector lengths don't match"}]}}}]),
        ),
        _ => (200, json!({"errors": [{"message": "Cannot query field \"Nope\""}]})),
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .upsert(
            "docs",
            &[VectorRecord {
                id: "a".into(),
                vector: vec![1.0],
                document: None,
                metadata: serde_json::Map::new(),
            }],
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("vector lengths"), "{error}");
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
    assert!(error.to_string().contains("Cannot query field"), "{error}");
}

#[tokio::test]
async fn a_class_ryu_did_not_create_is_queried_by_its_own_properties() {
    let server = MockServer::start(|request| match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/schema/Handbook") => (
            200,
            json!({
                "class": "Handbook",
                "vectorIndexConfig": {"distance": "cosine"},
                "properties": [{"name": "text", "dataType": ["text"]}, {"name": "source"}],
            }),
        ),
        ("POST", "/v1/graphql") => (
            200,
            json!({"data": {"Get": {"Handbook": [
                {"text": "Leave policy", "_additional": {"id": "0b6c2c1e-0000-4000-8000-000000000001", "distance": 0.1}}
            ]}}}),
        ),
        _ => (500, json!({})),
    })
    .await;
    let store = build(&VectorStoreConfig {
        text_key: Some("text".into()),
        ..config(&server.url)
    })
    .unwrap();
    store
        .ensure_collection(&CollectionSpec {
            name: "handbook".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap();
    let hits = store
        .query(
            "handbook",
            &VectorQuery {
                vector: vec![1.0, 0.0],
                top_k: 2,
                filter: None,
            },
        )
        .await
        .unwrap();
    let graphql = server.find("POST", "/v1/graphql");
    let text = graphql.body["query"].as_str().unwrap();
    assert!(
        text.contains("{ text _additional { id distance } }"),
        "{text}"
    );
    assert!(
        !text.contains("ryuId") && !text.contains("ryuMetadata"),
        "{text}"
    );
    assert_eq!(hits[0].id, "0b6c2c1e-0000-4000-8000-000000000001");
    assert_eq!(hits[0].document.as_deref(), Some("Leave policy"));
    assert!(hits[0].metadata.is_empty());
    // No schema was created for an existing class.
    assert!(server.requests().iter().all(|r| r.path != "/v1/schema"));
}

#[tokio::test]
async fn an_existing_class_without_the_text_property_is_a_clear_error() {
    let server = MockServer::start(|_| {
        (
            200,
            json!({"class": "Handbook", "properties": [{"name": "body"}]}),
        )
    })
    .await;
    let store = build(&config(&server.url)).unwrap();
    let error = store
        .ensure_collection(&CollectionSpec {
            name: "handbook".into(),
            dimensions: 2,
            metric: DistanceMetric::Cosine,
        })
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("no 'document' property"),
        "{error}"
    );
}

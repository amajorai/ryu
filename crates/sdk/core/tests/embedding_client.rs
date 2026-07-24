//! End-to-end tests for the gateway-mandatory `EmbeddingClient` against a mock
//! server, plus the pure convenience methods on `EmbeddingResult`.

mod common;

use ryu_sdk::embedding::{EmbeddingClient, EmbeddingClientOptions, EmbeddingError};

fn client_for(base_url: &str, token: Option<&str>) -> EmbeddingClient {
    EmbeddingClient::new(
        "nomic-embed-text-v1.5",
        EmbeddingClientOptions {
            base_url: Some(base_url.to_string()),
            token: token.map(str::to_string),
        },
    )
    .expect("client")
}

#[tokio::test]
async fn embed_posts_input_array_and_returns_ordered_vectors() {
    let server = common::spawn(
        200,
        "application/json",
        r#"{"data":[
              {"embedding":[0.3,0.4],"index":1},
              {"embedding":[0.1,0.2],"index":0}
           ],
           "usage":{"prompt_tokens":4,"total_tokens":4}}"#,
    );
    let client = client_for(&server.base_url, Some("tok"));
    let result = client
        .embed(&["a".to_string(), "b".to_string()])
        .await
        .expect("embed");

    // Out-of-order response indices are sorted back to input order.
    assert_eq!(result.vectors(), vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
    assert_eq!(result.first_vector(), Some([0.1, 0.2].as_slice()));
    let usage = result.usage.expect("usage");
    assert_eq!(usage.prompt_tokens, 4);
    assert_eq!(usage.total_tokens, 4);

    let req = server.captured.await.expect("captured");
    assert_eq!(req.request_line(), "POST /v1/embeddings HTTP/1.1");
    assert_eq!(req.header("authorization").as_deref(), Some("Bearer tok"));
    let body: serde_json::Value = serde_json::from_str(&req.body).expect("json");
    assert_eq!(body["model"], "nomic-embed-text-v1.5");
    assert_eq!(body["input"], serde_json::json!(["a", "b"]));
}

#[tokio::test]
async fn embed_uses_response_position_when_index_missing() {
    // No `index` fields → fall back to enumeration order (0, 1).
    let server = common::spawn(
        200,
        "application/json",
        r#"{"data":[{"embedding":[9.0]},{"embedding":[8.0]}]}"#,
    );
    let client = client_for(&server.base_url, None);
    let result = client
        .embed(&["x".to_string(), "y".to_string()])
        .await
        .expect("embed");
    assert_eq!(result.vectors(), vec![vec![9.0], vec![8.0]]);
    assert!(result.usage.is_none());
}

#[tokio::test]
async fn embed_one_returns_first_vector() {
    let server = common::spawn(
        200,
        "application/json",
        r#"{"data":[{"embedding":[1.0,2.0,3.0],"index":0}]}"#,
    );
    let client = client_for(&server.base_url, None);
    let vector = client.embed_one("hello").await.expect("embed_one");
    assert_eq!(vector, vec![1.0, 2.0, 3.0]);
}

#[tokio::test]
async fn embed_one_on_empty_data_is_empty_vec() {
    let server = common::spawn(200, "application/json", r#"{"data":[]}"#);
    let client = client_for(&server.base_url, None);
    let vector = client.embed_one("hello").await.expect("embed_one");
    assert!(vector.is_empty());
}

#[tokio::test]
async fn embed_maps_non_2xx_to_http_error() {
    let server = common::spawn(400, "text/plain", "bad request");
    let client = client_for(&server.base_url, None);
    let err = client.embed(&["x".to_string()]).await.unwrap_err();
    match err {
        EmbeddingError::Http { status, body, url } => {
            assert_eq!(status, 400);
            assert_eq!(body, "bad request");
            assert!(url.ends_with("/v1/embeddings"), "url was {url}");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}

#[test]
fn rejects_direct_provider_at_construction() {
    let err = EmbeddingClient::new(
        "text-embedding-3-small",
        EmbeddingClientOptions {
            base_url: Some("https://api.openai.com/v1".into()),
            token: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, EmbeddingError::Egress(_)));
}

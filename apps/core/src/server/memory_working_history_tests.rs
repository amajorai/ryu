//! The working-memory history route: newest first, bounded, owner-isolated,
//! and gone with its document.

use super::*;
use axum::http::StatusCode;
use axum::Router;
use ryu_kernel_contracts::ResourceKey;
use serde_json::Value;

use crate::server::memory::{WorkingMemoryScope, WorkingMemoryWrite, LOCAL_USER};

fn router(state: ServerState) -> Router {
    super::super::routes()
        .layer(axum::Extension(
            None::<crate::identity_verify::VerifiedCaller>,
        ))
        .with_state(state)
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    use tower::ServiceExt as _;
    let request = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(match body {
            Some(body) => axum::body::Body::from(body.to_string()),
            None => axum::body::Body::empty(),
        })
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn versions(body: &Value) -> Vec<(i64, String)> {
    body["versions"]
        .as_array()
        .expect("versions array")
        .iter()
        .map(|entry| {
            (
                entry["version"].as_i64().unwrap(),
                entry["content"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn lists_versions_newest_first_and_honours_limit() {
    let data = tempfile::tempdir().expect("data");
    let router = router(crate::server::isolated_plugin_hook_test_state(data.path()));
    let doc = "/api/memory/working?scope=thread&id=conv-h";
    let history = "/api/memory/working/history?scope=thread&id=conv-h";

    let (status, body) = call(&router, "GET", history, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["scope"], "thread");
    assert_eq!(body["id"], "conv-h");
    assert_eq!(body["versions"], serde_json::json!([]));

    for content in ["first", "second", "third"] {
        let (status, body) = call(
            &router,
            "PUT",
            doc,
            Some(serde_json::json!({ "content": content })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let (status, body) = call(&router, "GET", history, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        versions(&body),
        vec![
            (3, "third".to_owned()),
            (2, "second".to_owned()),
            (1, "first".to_owned())
        ]
    );
    let newest = &body["versions"][0];
    assert_eq!(newest["mode"], "template");
    assert!(newest["updated_at"].as_i64().unwrap() > 0);
    // Template-mode versions carry no `data`, and no stored template/schema.
    assert!(newest.get("data").is_none());
    assert!(newest.get("template").is_none());

    let (_, body) = call(&router, "GET", &format!("{history}&limit=2"), None).await;
    assert_eq!(
        versions(&body),
        vec![(3, "third".to_owned()), (2, "second".to_owned())]
    );
    let (_, body) = call(&router, "GET", &format!("{history}&limit=0"), None).await;
    assert_eq!(versions(&body), vec![(3, "third".to_owned())]);
    let (_, body) = call(&router, "GET", &format!("{history}&limit=500"), None).await;
    assert_eq!(versions(&body).len(), 3);

    let (status, _) = call(&router, "DELETE", doc, None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = call(&router, "GET", history, None).await;
    assert_eq!(body["versions"], serde_json::json!([]));
}

#[tokio::test]
async fn returns_only_the_callers_own_versions() {
    let data = tempfile::tempdir().expect("data");
    let state = crate::server::isolated_plugin_hook_test_state(data.path());
    let memory = state.memory.clone();
    let router = router(state);
    let write = |content: &str| WorkingMemoryWrite {
        data: Some(serde_json::json!({ "note": content })),
        ..Default::default()
    };
    // Another user's document under the same resource id.
    memory
        .put_working_memory(
            &ResourceKey::owned(Some("bob"), None),
            WorkingMemoryScope::Resource,
            "shared-id",
            write("bob's"),
        )
        .await
        .unwrap();
    let history = "/api/memory/working/history?scope=resource&id=shared-id";
    let (status, body) = call(&router, "GET", history, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["versions"], serde_json::json!([]));

    // The caller (the local principal on an unbound node) sees its own.
    memory
        .put_working_memory(
            &ResourceKey::owned(Some(LOCAL_USER), None),
            WorkingMemoryScope::Resource,
            "shared-id",
            write("mine"),
        )
        .await
        .unwrap();
    let (_, body) = call(&router, "GET", history, None).await;
    let entries = body["versions"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["mode"], "schema");
    assert_eq!(entries[0]["data"], serde_json::json!({ "note": "mine" }));
    assert!(entries[0].get("content").is_none());
}

#[tokio::test]
async fn rejects_a_bad_scope_or_blank_id() {
    let data = tempfile::tempdir().expect("data");
    let router = router(crate::server::isolated_plugin_hook_test_state(data.path()));
    let (status, _) = call(
        &router,
        "GET",
        "/api/memory/working/history?scope=team&id=x",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &router,
        "GET",
        "/api/memory/working/history?scope=resource&id=%20",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[test]
fn limit_is_clamped_to_the_cap() {
    let cap = usize::try_from(WORKING_MEMORY_HISTORY_LIMIT).unwrap();
    assert_eq!(clamp_limit(None), cap);
    assert_eq!(clamp_limit(Some(-4)), 1);
    assert_eq!(clamp_limit(Some(3)), 3);
    assert_eq!(clamp_limit(Some(10_000)), cap);
}

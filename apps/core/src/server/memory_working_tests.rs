//! Working memory host wiring: agent updates, injection gating, and the HTTP
//! routes.

use super::*;
use crate::server::memory::MemoryStore;

fn template_config(scope: WorkingMemoryScope) -> WorkingMemoryConfig {
    WorkingMemoryConfig {
        enabled: true,
        scope,
        template: Some("# Task\n- goal:".to_owned()),
        schema: None,
    }
}

#[test]
fn target_id_follows_scope() {
    let thread = template_config(WorkingMemoryScope::Thread);
    assert_eq!(target_id(&thread, Some("conv-1"), "alice"), Some("conv-1"));
    assert_eq!(target_id(&thread, None, "alice"), None);
    assert_eq!(target_id(&thread, Some("  "), "alice"), None);
    let resource = template_config(WorkingMemoryScope::Resource);
    assert_eq!(target_id(&resource, Some("conv-1"), "alice"), Some("alice"));
}

#[tokio::test]
async fn agent_update_writes_template_and_schema_documents() {
    let store = MemoryStore::open_in_memory().unwrap();
    let thread = template_config(WorkingMemoryScope::Thread);
    let result = apply_agent_update(
        &store,
        &thread,
        Some("conv-1"),
        "alice",
        &json!({ "content": "# Task\n- goal: ship" }),
    )
    .await
    .unwrap();
    assert_eq!(result["version"], 1);
    let doc = store
        .get_working_memory(
            &ResourceKey::owned(Some("alice"), None),
            WorkingMemoryScope::Thread,
            "conv-1",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc.content.as_deref(), Some("# Task\n- goal: ship"));
    assert_eq!(doc.template.as_deref(), Some("# Task\n- goal:"));

    let missing = apply_agent_update(&store, &thread, Some("conv-1"), "alice", &json!({}))
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("content"));

    let schema = WorkingMemoryConfig {
        enabled: true,
        scope: WorkingMemoryScope::Resource,
        template: None,
        schema: Some(json!({
            "type": "object",
            "properties": { "name": { "type": "string" }, "city": { "type": "string" } }
        })),
    };
    apply_agent_update(
        &store,
        &schema,
        None,
        "alice",
        &json!({ "data": { "name": "Ada" } }),
    )
    .await
    .unwrap();
    // A model that sends the patch as a JSON string is accepted too.
    apply_agent_update(
        &store,
        &schema,
        None,
        "alice",
        &json!({ "data": "{\"city\":\"London\"}" }),
    )
    .await
    .unwrap();
    let doc = store
        .get_working_memory(
            &ResourceKey::owned(Some("alice"), None),
            WorkingMemoryScope::Resource,
            "alice",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc.data, Some(json!({ "name": "Ada", "city": "London" })));
    let invalid = apply_agent_update(
        &store,
        &schema,
        None,
        "alice",
        &json!({ "data": { "name": 7 } }),
    )
    .await
    .unwrap_err();
    assert!(invalid.to_string().contains("$.name"));
}

#[test]
fn injection_requires_the_tool_to_write_the_reader_partition() {
    use crate::sidecar::mcp::ToolPrincipal;
    assert!(principal_matches_owner(
        &ToolPrincipal::Unrestricted,
        ryu_memory::LOCAL_USER
    ));
    let owned = ToolPrincipal::Owned {
        user_id: "alice".to_owned(),
        org_id: Some("org".to_owned()),
    };
    assert!(principal_matches_owner(&owned, "alice"));
    // Bob chatting in Alice's shared conversation: the tool would write
    // Alice's partition, so Bob's turn gets no working memory.
    assert!(!principal_matches_owner(&owned, "bob"));
    assert!(!principal_matches_owner(
        &ToolPrincipal::Unresolved,
        "alice"
    ));
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

/// The real handlers on an unbound node: read-empty, schema create, merge,
/// stale-version conflict, schema violation, bad scope, and delete.
#[tokio::test]
async fn http_routes_round_trip() {
    let data = tempfile::tempdir().expect("data");
    let state = crate::server::isolated_plugin_hook_test_state(data.path());
    let router = routes()
        .layer(axum::Extension(
            None::<crate::identity_verify::VerifiedCaller>,
        ))
        .with_state(state);
    let uri = "/api/memory/working?scope=resource&id=user-1";

    let (status, body) = call(&router, "GET", uri, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["working_memory"].is_null());
    assert_eq!(body["scope"], "resource");

    let schema = json!({
        "type": "object",
        "properties": { "plan": { "enum": ["free", "pro"] }, "name": { "type": "string" } },
        "additionalProperties": false
    });
    let (status, body) = call(
        &router,
        "PUT",
        uri,
        Some(json!({ "data": { "plan": "pro" }, "schema": schema, "expected_version": 0 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["working_memory"]["mode"], "schema");
    assert_eq!(body["working_memory"]["version"], 1);

    let (status, body) = call(
        &router,
        "PUT",
        uri,
        Some(json!({ "data": { "name": "Ada" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["working_memory"]["data"],
        json!({ "plan": "pro", "name": "Ada" })
    );

    let (status, body) = call(
        &router,
        "PUT",
        uri,
        Some(json!({ "data": { "name": "Grace" }, "expected_version": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["current_version"], 2);

    let (status, body) = call(
        &router,
        "PUT",
        uri,
        Some(json!({ "data": { "plan": "gold" } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"]
        .as_str()
        .unwrap_or_default()
        .contains("$.plan"));

    let (status, _) = call(
        &router,
        "GET",
        "/api/memory/working?scope=team&id=user-1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &router,
        "GET",
        "/api/memory/working?scope=thread&id=%20",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, body) = call(&router, "DELETE", uri, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["deleted"], true);
    let (_, body) = call(&router, "GET", uri, None).await;
    assert!(body["working_memory"].is_null());
}

#[tokio::test]
async fn thread_update_without_conversation_is_refused() {
    let store = MemoryStore::open_in_memory().unwrap();
    let error = apply_agent_update(
        &store,
        &template_config(WorkingMemoryScope::Thread),
        None,
        "alice",
        &json!({ "content": "x" }),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("host conversation"));
}

#[tokio::test]
async fn agent_update_honours_expected_version() {
    let store = MemoryStore::open_in_memory().unwrap();
    let thread = template_config(WorkingMemoryScope::Thread);
    let update = |arguments: Value| {
        let store = store.clone();
        let thread = thread.clone();
        async move { apply_agent_update(&store, &thread, Some("conv-1"), "alice", &arguments).await }
    };
    let first = update(json!({ "content": "v1", "expected_version": 0 }))
        .await
        .unwrap();
    assert_eq!(first["version"], 1);
    // Some models quote numbers.
    let second = update(json!({ "content": "v2", "expected_version": "1" }))
        .await
        .unwrap();
    assert_eq!(second["version"], 2);

    let stale = update(json!({ "content": "lost", "expected_version": 1 }))
        .await
        .unwrap_err()
        .to_string();
    assert!(stale.contains("version conflict"), "{stale}");
    assert!(stale.contains("NOT saved"), "{stale}");
    assert!(stale.contains("merge your change"), "{stale}");
    assert!(stale.contains("expected_version: 2"), "{stale}");
    assert!(
        stale.contains("Current document (version 2):\nv2"),
        "{stale}"
    );
    let key = ResourceKey::owned(Some("alice"), None);
    let kept = store
        .get_working_memory(&key, WorkingMemoryScope::Thread, "conv-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((kept.version, kept.content.as_deref()), (2, Some("v2")));

    // Without expected_version the write stays unconditional, as before.
    let unconditional = update(json!({ "content": "v3" })).await.unwrap();
    assert_eq!(unconditional["version"], 3);
    let null_version = update(json!({ "content": "v4", "expected_version": null }))
        .await
        .unwrap();
    assert_eq!(null_version["version"], 4);

    for bad in [json!(-1), json!("soon"), json!(1.5), json!([4])] {
        let error = update(json!({ "content": "x", "expected_version": bad }))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("non-negative integer"),
            "{error}"
        );
    }
    let history = store
        .working_memory_history(&key, WorkingMemoryScope::Thread, "conv-1")
        .await
        .unwrap();
    assert_eq!(history.len(), 4);
}

#[tokio::test]
async fn schema_conflict_shows_the_current_object() {
    let store = MemoryStore::open_in_memory().unwrap();
    let config = WorkingMemoryConfig {
        enabled: true,
        scope: WorkingMemoryScope::Resource,
        template: None,
        schema: Some(json!({ "type": "object" })),
    };
    apply_agent_update(
        &store,
        &config,
        None,
        "alice",
        &json!({ "data": { "plan": "pro" }, "expected_version": 0 }),
    )
    .await
    .unwrap();
    let stale = apply_agent_update(
        &store,
        &config,
        None,
        "alice",
        &json!({ "data": { "plan": "free" }, "expected_version": 0 }),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(stale.contains("expected_version: 1"), "{stale}");
    assert!(stale.contains("\"plan\": \"pro\""), "{stale}");
}

#[test]
fn conflict_error_without_a_document_has_no_body() {
    let message = conflict_error(3, 0, None).to_string();
    assert!(message.contains("expected_version 3"));
    assert!(message.contains("expected_version: 0"));
    assert!(!message.contains("Current document"));
}

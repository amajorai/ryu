//! Tests moved out of `sidecar/mcp/mod.rs`.

use crate::sidecar::mcp::tests::{registry_with_plugin, tool_entry};

#[tokio::test]
async fn verified_implementation_hash_changes_with_same_schema_backend_replacement() {
    let reg = registry_with_plugin(
        "com.test.binding",
        vec!["tool:execute"],
        vec![tool_entry(
            "weather",
            serde_json::json!({
                "slug": "weather",
                "backend": "inline_js",
                "code": "return { ok: true };",
                "input_schema": { "type": "object", "additionalProperties": false },
            }),
        )],
    )
    .await;
    reg.register_app_tool("app.weather".into(), "weather".into(), None);
    let tool = reg
        .list_all_tools()
        .await
        .into_iter()
        .find(|item| item.id == "app.weather")
        .expect("registered app tool");
    let chain = reg.verified_dispatch_chain(&tool.id).await.unwrap();
    let before = reg
        .verified_implementation_hash(&tool, &chain)
        .await
        .unwrap();

    let manifests = reg.self_build_manifests.as_ref().unwrap();
    let mut guard = manifests.write().await;
    guard[0].runnables[0].config = Some(serde_json::json!({
        "slug": "weather",
        "backend": "inline_js",
        "code": "return { ok: false };",
        "input_schema": { "type": "object", "additionalProperties": false },
    }));
    drop(guard);

    let after = reg
        .verified_implementation_hash(&tool, &chain)
        .await
        .unwrap();
    assert_ne!(before, after, "backend code must be certificate-bound");
}

//! Tests moved out of `sidecar/mcp/mod.rs`.

use crate::plugin_manifest::schema::ToolBackend;
use crate::sidecar::mcp::tests::{registry_with_plugin, tool_entry};
use serde_json::json;

#[tokio::test]
async fn plugin_inline_js_tool_is_discoverable_and_resolves_not_alias() {
    // A plugin ships an inline_js tool (NEW behavior, not an alias).
    let reg = registry_with_plugin(
        "com.test.tools",
        vec!["tool:execute"],
        vec![tool_entry(
            "weather",
            serde_json::json!({
                "slug": "weather",
                "backend": "inline_js",
                "code": "return await ((input, host) => ({ city: input.city, ok: true }))(input, host);",
                "description": "Look up weather",
            }),
        )],
    )
    .await;
    // Discovery: register it the way the server Tool handler does, then confirm
    // it shows up in the flat tool listing that backs `/api/tools/search`.
    reg.register_app_tool(
        "app.weather".into(),
        "weather".into(),
        Some("Look up weather".into()),
    );
    let all = reg.list_all_tools().await;
    assert!(
        all.iter().any(|t| t.id == "app.weather"),
        "inline_js tool must be discoverable via the tool listing"
    );

    // It resolves to the inline_js backend — NOT an alias.
    let resolved = reg
        .resolve_app_tool_backend("app.weather")
        .await
        .expect("enabled plugin owns app.weather");
    assert!(
        matches!(resolved.backend, ToolBackend::InlineJs { .. }),
        "must resolve to inline_js, not alias"
    );
    assert!(resolved.grants.contains("tool:execute"));

    // Calling it takes the inline sandbox path, never the alias re-enter. With
    // no global ServerState in the test harness it fails on the runtime, but the message proves it is NOT the alias path (which would
    // say "unknown MCP server: weather").
    let err = reg
        .call_tool("app.weather", serde_json::json!({ "city": "SG" }), None)
        .await
        .err();
    if let Some(e) = err {
        let msg = e.to_string();
        assert!(
            !msg.contains("unknown MCP server"),
            "inline tool must NOT fall through the alias path, got: {msg}"
        );
        assert!(
            msg.contains("inline tool"),
            "expected an inline-runtime error, got: {msg}"
        );
    }
    // With a ServerState present the call would succeed; that path is covered
    // by the plugin-host runtime tests.
}

#[tokio::test]
async fn action_metadata_is_exposed_in_tool_discovery_and_resolution() {
    let reg = registry_with_plugin(
        "com.test.actions",
        vec!["tool:execute"],
        vec![tool_entry(
            "action-save",
            serde_json::json!({
                "slug": "action-save",
                "backend": "inline_js",
                "code": "return { ok: true };",
                "action": true,
                "output_schema": {
                    "type": "object",
                    "properties": { "ok": { "type": "boolean" } }
                },
                "annotations": {
                    "readOnlyHint": false,
                    "destructiveHint": true
                },
                "needs_approval": true
            }),
        )],
    )
    .await;
    reg.register_app_tool("app.action-save".into(), "action-save".into(), None);

    let tool = reg
        .list_all_tools()
        .await
        .into_iter()
        .find(|item| item.id == "app.action-save")
        .expect("action tool is discoverable");
    assert_eq!(
        tool.output_schema.as_ref().map(|v| &v["type"]),
        Some(&json!("object"))
    );
    assert_eq!(
        tool.annotations.as_ref().map(|v| &v["destructiveHint"]),
        Some(&json!(true))
    );

    let resolved = reg
        .resolve_app_tool_backend("app.action-save")
        .await
        .expect("action backend resolves");
    assert!(resolved.needs_approval);
}

#[tokio::test]
async fn action_tool_resolution_accepts_only_action_marked_tools() {
    let reg = registry_with_plugin(
        "com.test.actions",
        vec!["tool:execute"],
        vec![
            tool_entry(
                "action-save",
                serde_json::json!({
                    "slug": "action-save",
                    "backend": "inline_js",
                    "code": "return { ok: true };",
                    "action": true,
                }),
            ),
            tool_entry(
                "ordinary-tool",
                serde_json::json!({
                    "slug": "ordinary-tool",
                    "backend": "inline_js",
                    "code": "return { ok: true };",
                }),
            ),
        ],
    )
    .await;
    reg.register_app_tool("app.action-save".into(), "action-save".into(), None);
    reg.register_app_tool("app.ordinary-tool".into(), "ordinary-tool".into(), None);

    assert_eq!(
        reg.resolve_action_tool_id("action-save").await,
        Some("app.action-save".to_owned())
    );
    assert_eq!(
        reg.resolve_action_tool_id("app.action-save").await,
        Some("app.action-save".to_owned())
    );
    assert_eq!(reg.resolve_action_tool_id("ordinary-tool").await, None);
    let descriptors = reg.action_descriptors().await;
    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].plugin_id, "com.test.actions");
    assert_eq!(descriptors[0].effect, "mutate");
}

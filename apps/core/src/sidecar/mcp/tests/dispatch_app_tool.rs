//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{registry_with_plugin, tool_entry};

#[tokio::test]
async fn app_tool_dispatch_resolves_target_not_app_server() {
    // Registering `app.foo.bar` then calling it must alias to `foo.bar`
    // (re-entering call_tool), NOT error with "unknown MCP server: app".
    let reg = McpRegistry::empty();
    reg.register_app_tool("app.foo.bar".into(), "foo.bar".into(), None);

    let err = reg
        .call_tool("app.foo.bar", serde_json::json!({}), None)
        .await
        .expect_err("foo is not a configured server, so dispatch must fail at the target");
    let msg = err.to_string();
    assert!(
        msg.contains("unknown MCP server: foo"),
        "alias must re-dispatch to the target server 'foo', got: {msg}"
    );
    assert!(
        !msg.contains("unknown MCP server: app"),
        "must NOT fall through to the generic 'app' server lookup: {msg}"
    );
}

#[tokio::test]
async fn app_tool_unknown_id_is_rejected() {
    // An `app.`-prefixed id that no enabled app registered must be rejected,
    // not silently re-dispatched.
    let reg = McpRegistry::empty();
    let err = reg
        .call_tool("app.never.registered", serde_json::json!({}), None)
        .await
        .expect_err("unregistered app tool must be rejected");
    assert!(err.to_string().contains("unknown app tool"), "got: {err}");
}

#[tokio::test]
async fn app_tool_enforces_allowlist_at_the_app_layer() {
    let reg = McpRegistry::empty();
    reg.register_app_tool("app.foo.bar".into(), "foo.bar".into(), None);

    // Not in the allowlist → rejected before any target dispatch.
    let denied = reg
        .call_tool(
            "app.foo.bar",
            serde_json::json!({}),
            Some(&["something_else".to_owned()]),
        )
        .await
        .expect_err("app tool absent from allowlist must be denied");
    assert!(
        denied.to_string().contains("not in this agent's allowlist"),
        "got: {denied}"
    );

    // Allowlisting the `app` server passes the app-layer gate; the call then
    // re-dispatches to the target (which fails at the unknown target server,
    // proving the gate was passed).
    let passed = reg
        .call_tool(
            "app.foo.bar",
            serde_json::json!({}),
            Some(&["app".to_owned()]),
        )
        .await
        .expect_err("target server 'foo' is unknown");
    assert!(
        passed.to_string().contains("unknown MCP server: foo"),
        "allowlisting 'app' must let the alias re-dispatch to its target: {passed}"
    );
}

#[tokio::test]
async fn app_tool_rejects_aliasing_another_app_tool() {
    // Guard against an app tool whose target is itself an `app.` id
    // (privilege chain / loop).
    let reg = McpRegistry::empty();
    reg.register_app_tool("app.app.x".into(), "app.x".into(), None);
    let err = reg
        .call_tool("app.app.x", serde_json::json!({}), None)
        .await
        .expect_err("app→app aliasing must be rejected");
    assert!(err.to_string().contains("invalid target"), "got: {err}");
}

// ── Derived ext-API tool dispatch (`crate::ext_api`) ───────────────────────

#[tokio::test]
async fn plugin_http_tool_ungranted_domain_is_refused() {
    // A plugin ships an http tool but holds NO egress grant for its domain.
    let reg = registry_with_plugin(
        "com.test.http",
        vec!["tool:execute"], // note: no tool:http-egress:api.example.com
        vec![tool_entry(
            "quote",
            serde_json::json!({
                "slug": "quote",
                "backend": "http",
                "url": "https://api.example.com/quote",
            }),
        )],
    )
    .await;
    reg.register_app_tool("app.quote".into(), "quote".into(), None);

    let err = reg
        .call_tool("app.quote", serde_json::json!({ "q": "hi" }), None)
        .await
        .expect_err("ungranted http egress domain must be refused");
    let msg = err.to_string();
    assert!(
        msg.contains("not granted") && msg.contains("api.example.com"),
        "expected a deterministic egress-grant refusal, got: {msg}"
    );
    assert!(
        msg.contains("tool:http-egress:api.example.com"),
        "refusal must name the required grant, got: {msg}"
    );
}

#[tokio::test]
async fn plugin_inline_js_tool_requires_tool_execute_grant() {
    // Same inline tool, but the plugin lacks `tool:execute` → refused before
    // any sandbox run (deterministic).
    let reg = registry_with_plugin(
        "com.test.nogrant",
        vec![], // no grants
        vec![tool_entry(
            "weather",
            serde_json::json!({
                "slug": "weather",
                "backend": "inline_js",
                "code": "return await ((input, host) => ({ ok: true }))(input, host);",
            }),
        )],
    )
    .await;
    reg.register_app_tool("app.weather".into(), "weather".into(), None);

    let err = reg
        .call_tool("app.weather", serde_json::json!({}), None)
        .await
        .expect_err("inline tool without tool:execute must be refused");
    assert!(
        err.to_string().contains("tool:execute"),
        "refusal must name the required grant, got: {err}"
    );
}

#[tokio::test]
async fn plugin_command_tool_ungranted_bin_is_refused() {
    // A plugin ships a `command` tool but holds NO `tool:command:echo` grant →
    // refused deterministically through the real dispatch path (proves the
    // Command arm is wired and the gate applies to the outer `app.` id).
    let reg = registry_with_plugin(
        "com.test.cmd",
        vec![], // no tool:command:echo
        vec![tool_entry(
            "echoer",
            serde_json::json!({
                "slug": "echoer",
                "backend": "command",
                "bin": "echo",
                "command_args": ["{msg}"],
            }),
        )],
    )
    .await;
    reg.register_app_tool_tagged(
        "app.echoer".into(),
        "echoer".into(),
        None,
        Some(AppToolBackendTag::Command),
    );

    // It resolves to the Command backend — NOT an alias.
    let resolved = reg
        .resolve_app_tool_backend("app.echoer")
        .await
        .expect("enabled plugin owns app.echoer");
    assert!(
        matches!(
            resolved.backend,
            crate::plugin_manifest::schema::ToolBackend::Command { .. }
        ),
        "must resolve to command, not alias"
    );

    let err = reg
        .call_tool("app.echoer", serde_json::json!({ "msg": "hi" }), None)
        .await
        .expect_err("ungranted command exec must be refused");
    let msg = err.to_string();
    assert!(
        msg.contains("not granted") && msg.contains("tool:command:echo"),
        "expected a deterministic grant refusal, got: {msg}"
    );
}

#[tokio::test]
async fn plugin_command_tool_unknown_bin_refused_via_allowlist() {
    // Grant present, but the bin is not in the (empty) allowlist → refused at
    // the allowlist resolution step (before any spawn), through real dispatch.
    // Shares the gateway env lock with the tool_exec command tests (both touch
    // RYU_COMMAND_TOOL_ALLOWLIST); they must serialize on ONE lock.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::remove_var(crate::tool_exec::ENV_COMMAND_TOOL_ALLOWLIST);
    let reg = registry_with_plugin(
        "com.test.cmd2",
        vec!["tool:command:echo"],
        vec![tool_entry(
            "echoer",
            serde_json::json!({
                "slug": "echoer",
                "backend": "command",
                "bin": "echo",
                "command_args": ["{msg}"],
            }),
        )],
    )
    .await;
    reg.register_app_tool_tagged(
        "app.echoer".into(),
        "echoer".into(),
        None,
        Some(AppToolBackendTag::Command),
    );

    let err = reg
        .call_tool("app.echoer", serde_json::json!({ "msg": "hi" }), None)
        .await
        .expect_err("unknown bin must be refused");
    assert!(
        err.to_string().contains("command allowlist"),
        "expected a fail-closed allowlist refusal, got: {err}"
    );
}

// ── Native tool-id preservation (declarative tool plugins keep their id) ─────

//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

/// The `device` dispatch arm (design §6.4 dispatch steps 1-2) enforces the
/// agent allowlist and refuses a caller whose principal cannot be resolved,
/// both before the device provider is reached.
#[tokio::test]
async fn device_dispatch_enforces_the_allowlist_and_a_verified_caller() {
    let reg = McpRegistry::empty();
    let tool_id = ryu_hardware::capability::tool_id("rhw_registry_test", "device.status");
    assert!(tool_id.starts_with(&format!("{}.", device_tool::SERVER_NAME)));

    let denied = reg
        .call_tool(
            &tool_id,
            serde_json::json!({}),
            Some(&["something_else".to_owned()]),
        )
        .await
        .expect_err("a device tool absent from the allowlist must be denied");
    assert!(
        denied.to_string().contains("not in this agent's allowlist"),
        "got: {denied}"
    );

    let allow = [device_tool::SERVER_NAME.to_owned()];
    let unresolved = authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Unresolved,
        reg.call_tool(&tool_id, serde_json::json!({}), Some(&allow)),
    )
    .await
    .expect_err("an unresolved principal must be refused");
    assert!(
        unresolved
            .to_string()
            .contains("device tools require a verified caller"),
        "got: {unresolved}"
    );

    // A resolved principal with the server allowlisted passes both gates and
    // reaches the device provider, which then fails: no device is live here.
    let passed = reg
        .call_tool(&tool_id, serde_json::json!({}), Some(&allow))
        .await
        .expect_err("no live device answers this tool")
        .to_string();
    assert!(
        !passed.contains("allowlist") && !passed.contains("verified caller"),
        "both gates must pass for a resolved, allowlisted caller: {passed}"
    );
}

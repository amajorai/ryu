//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn calling_agent_query_is_generic_and_server_owned() {
    assert_eq!(
        url_for_calling_agent(
            "core:/api/ext/com.example/tool",
            Some("agent_id"),
            Some("agent/a"),
        )
        .unwrap(),
        "core:/api/ext/com.example/tool?agent_id=agent%2Fa"
    );
    assert!(url_for_calling_agent(
        "core:/api/ext/com.example/tool?agent_id=model",
        Some("agent_id"),
        Some("agent/a"),
    )
    .is_err());
    assert_eq!(
        url_for_calling_agent("core:/api/ext/com.example/tool", None, Some("agent/a"),).unwrap(),
        "core:/api/ext/com.example/tool"
    );
}

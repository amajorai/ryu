//! Runtime proof for the bridge's device-read guards outside a live device
//! turn: a read that is only in the conversation's stored history holds a
//! later turn's egress call, and the egress of an `execute` program that turn
//! starts, in Core's real registry.
//!
//! This test binary has no global approval engine, so a held call takes the
//! fail-closed branch and is refused (see
//! `tool_exec/tests/exfiltration_guard_runtime_test.rs`).

use super::*;
use crate::agents::AgentStore;
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::sidecar::adapters::AcpAgentRegistry;

/// The guard's refusal names the read that holds the call.
const HELD: &str = "already read private data with `device.location.current`";

/// An egress call the built-in `ryu` agent may make by name.
const EGRESS: &str = "web.search";

/// A bridge of the `ryu` agent for a new conversation whose stored history
/// holds one assistant message with `parts`. No device turn is live.
async fn later_turn(parts: Value) -> RyuMcpHandler {
    let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message_as_with_render_data(
            &conversation,
            "assistant",
            "",
            None,
            None,
            None,
            Tenancy::Unattributed,
            None,
            None,
            Some(&parts),
            None,
        )
        .await
        .unwrap();
    let agents = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let registry = McpRegistry::empty()
        .with_agent_store(agents)
        .with_conversations(store);
    let handler = RyuMcpHandler {
        mcp: Arc::new(registry),
        allowlist: None,
        composio_actions: Vec::new(),
        agent_id: "ryu".to_owned(),
        identity_profile_ids: Vec::new(),
        composio_connection_scope: None,
        conversation_scope: None,
        caps: crate::sidecar::mcp::AgentCapabilities::default(),
        permission_tx: None,
        permission_scope_id: Some(conversation),
    };
    assert!(handler.device_turn_offer().is_none());
    handler
}

fn location_read() -> Value {
    json!([{
        "type": "tool-device_location_current", "toolCallId": "t",
        "state": "output-available", "output": { "lat": 37.33, "lon": -122.03 }
    }])
}

fn no_read() -> Value {
    json!([{ "type": "text", "text": "hi" }])
}

/// What the agent sees for a direct egress call through the bridge.
async fn direct_call(handler: &RyuMcpHandler) -> String {
    match handler
        .dispatch_guarded(EGRESS, json!({ "query": "x" }))
        .await
    {
        Ok(text) => text,
        Err(error) => error.message.to_string(),
    }
}

/// What a program started through the bridge now sees for an egress call.
async fn program_call(handler: &RyuMcpHandler) -> String {
    let invoker = handler
        .with_private_read_scope("execute", None, handler.program_invoker())
        .await
        .unwrap();
    let program = format!(
        "try {{ await tools.{EGRESS}({{ query: 'x' }}); return 'ok'; }} \
         catch (e) {{ return String(e && e.message || e); }}"
    );
    match tool_exec::run_sandboxed(program, invoker, "ryu").await {
        tool_exec::ExecOutcome::Completed {
            result: Some(Value::String(seen)),
            is_error: false,
            ..
        } => seen,
        other => panic!("program failed: {other:?}"),
    }
}

#[tokio::test]
async fn a_stored_device_read_holds_a_later_turns_egress_call() {
    let seen = direct_call(&later_turn(location_read()).await).await;
    assert!(seen.contains("`web.search` was not run"), "{seen}");
    assert!(seen.contains(HELD), "{seen}");
    // The same call in a conversation with no device read is not held.
    let seen = direct_call(&later_turn(no_read()).await).await;
    assert!(!seen.contains("already read private data"), "{seen}");
}

#[tokio::test]
async fn a_program_started_after_a_stored_device_read_has_its_egress_held() {
    let seen = program_call(&later_turn(location_read()).await).await;
    assert!(seen.contains("`web.search` was not run"), "{seen}");
    assert!(seen.contains(HELD), "{seen}");
    // The same program in a conversation with no device read is not held.
    let seen = program_call(&later_turn(no_read()).await).await;
    assert!(!seen.contains("already read private data"), "{seen}");
}

//! A device read holds what a program sends out later in the same turn.
//!
//! The ACP bridge runs every bridge call of a turn that read device data
//! inside `with_device_read_scope`, and `execute` starts a program inside that
//! call. Each test reproduces that shape: a real program in the JavaScript
//! sandbox (or one call through the production `ToolCaller` impl) against
//! Core's real `McpRegistry`, inside the scope. This test binary has no global
//! approval engine, so a held call takes the fail-closed branch and is refused
//! instead of queued.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{mark_device_read, private_read_source, with_device_read_scope};
use crate::agents::AgentStore;
use crate::device_tools::identity::DevicePrincipal;
use crate::device_tools::offer::DeviceOffer;
use crate::server::conversations::ConversationStore;
use crate::sidecar::adapters::AcpAgentRegistry;
use crate::sidecar::mcp::McpRegistry;
use crate::tool_exec::{ExecOutcome, RunDataFlow, SandboxToolInvoker, ToolCaller};

/// The guard's refusal names the read that made the turn private.
const HELD: &str = "already read private data";
const DEVICE_READ: &str = "device.location.current";

fn registry() -> Arc<McpRegistry> {
    let agents = AgentStore::open_in_memory(&AcpAgentRegistry::new()).expect("in-memory agents");
    Arc::new(
        McpRegistry::empty()
            .with_agent_store(agents)
            .with_conversations(
                ConversationStore::open_in_memory().expect("in-memory conversation store"),
            ),
    )
}

/// A turn's device offer with nothing read yet.
fn turn_offer() -> Arc<DeviceOffer> {
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1, "tools": [{ "app": "location", "permission": "granted" }],
    }))
    .unwrap();
    Arc::new(DeviceOffer::new(
        format!("conv-taint-{}", uuid::Uuid::new_v4().simple()),
        DevicePrincipal::LocalOwner,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    ))
}

/// A turn that already read device data.
fn turn_after_device_read() -> Arc<DeviceOffer> {
    let offer = turn_offer();
    mark_device_read(&offer, DEVICE_READ);
    offer
}

/// Call `tool` once and return `"ok"` or the error message the program sees.
fn attempt(tool: &str, args: &str) -> String {
    format!(
        "try {{ await tools.{tool}({args}); return 'ok'; }} \
         catch (e) {{ return String(e && e.message || e); }}"
    )
}

/// Run `program` the way `execute` does in a bridge call of this turn: a new
/// invoker (so a new run state) inside the turn's device-read scope.
async fn execute_in_turn(offer: Option<&Arc<DeviceOffer>>, agent_id: &str, program: &str) -> Value {
    let invoker = Arc::new(SandboxToolInvoker::registry_with_identity_and_conversation(
        registry(),
        agent_id.into(),
        None,
        None,
        Vec::new(),
        None,
    ));
    let run = crate::tool_exec::run_sandboxed(program.to_owned(), invoker, "ryu");
    match with_device_read_scope(offer, None, run).await {
        ExecOutcome::Completed {
            result: Some(result),
            is_error: false,
            ..
        } => result,
        other => panic!("program failed: {other:?}"),
    }
}

#[tokio::test]
async fn execute_after_a_device_read_holds_web_fetch() {
    let offer = turn_after_device_read();
    // The address is local, so a run without the fix reaches no outside host.
    let program = attempt("web_fetch.get", "{ url: 'https://127.0.0.1:9/?d=where' }");
    let result = execute_in_turn(Some(&offer), "ryu", &program).await;
    let message = result.as_str().unwrap_or_default();
    assert!(
        message.contains("`web_fetch.get` was not run"),
        "the program's fetch must be held after the device read: {result}"
    );
    assert!(message.contains(HELD), "{message}");
    assert!(
        message.contains(&format!("`{DEVICE_READ}`")),
        "the hold names the device read: {message}"
    );
}

#[tokio::test]
async fn execute_after_a_device_read_holds_other_egress_too() {
    let offer = turn_after_device_read();
    // No calling agent, as in the PTC guard's own runtime tests: this bare
    // registry has no provider that declares `web.extract`'s effect.
    let program = attempt("web.extract", "{ url: 'https://example.com/?d=where' }");
    let result = execute_in_turn(Some(&offer), "", &program).await;
    let message = result.as_str().unwrap_or_default();
    assert!(message.contains("`web.extract` was not run"), "{result}");
    assert!(message.contains(HELD), "{message}");
}

#[tokio::test]
async fn a_program_run_continued_after_a_device_read_is_held() {
    // `resume` continues a parked program whose run state was created before
    // the device read; its next call runs in a bridge call of the private turn.
    let offer = turn_after_device_read();
    let registry = registry();
    let parked = Arc::new(RunDataFlow::default());
    let error = with_device_read_scope(
        Some(&offer),
        None,
        ToolCaller::call_tool_with_identity(
            registry.as_ref(),
            None,
            "web.extract",
            json!({ "url": "https://example.com" }),
            None,
            None,
            &[],
            None,
            None,
            &parked,
        ),
    )
    .await
    .expect_err("held after the device read");
    assert!(error.contains(HELD), "{error}");
    assert_eq!(parked.private_read_source(), Some(DEVICE_READ));
}

#[tokio::test]
async fn execute_in_a_turn_with_no_device_read_is_not_held() {
    // With no extraction provider installed a dispatched `web.extract` answers
    // "unavailable", so "ok" means the call was dispatched, not held.
    let program = attempt("web.extract", "{ url: 'https://example.com' }");
    let unread = turn_offer();
    let result = execute_in_turn(Some(&unread), "", &program).await;
    assert_eq!(result, json!("ok"), "a device turn that read nothing");
    assert!(private_read_source(&unread).is_none());
    let result = execute_in_turn(None, "", &program).await;
    assert_eq!(result, json!("ok"), "a turn with no device offer");
}

#[tokio::test]
async fn a_program_read_does_not_make_the_turn_private() {
    // Only a device read marks the turn: a program's own private read holds
    // the rest of that program and nothing else.
    let unread = turn_offer();
    let program = format!(
        "await tools.search_conversations.search({{ query: 'x' }}); {}",
        attempt("web.extract", "{ url: 'https://example.com' }")
    );
    let result = execute_in_turn(Some(&unread), "", &program).await;
    assert!(
        result.as_str().unwrap_or_default().contains(HELD),
        "held inside the program as before: {result}"
    );
    assert!(private_read_source(&unread).is_none());
    let next = attempt("web.extract", "{ url: 'https://example.com' }");
    let result = execute_in_turn(Some(&unread), "", &next).await;
    assert_eq!(result, json!("ok"), "the next program starts clean");
}

#[tokio::test]
async fn a_direct_registry_call_after_a_device_read_stays_held() {
    let offer = turn_after_device_read();
    let registry = registry();
    let error = with_device_read_scope(
        Some(&offer),
        None,
        McpRegistry::call_tool_with_identity(
            &registry,
            None,
            "web.extract",
            json!({ "url": "https://example.com" }),
            None,
            None,
            &[],
            None,
            None,
        ),
    )
    .await
    .expect_err("held after the device read")
    .to_string();
    assert!(error.contains(HELD), "{error}");
    assert!(error.contains(&format!("`{DEVICE_READ}`")), "{error}");
}

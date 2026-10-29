//! In-chat consent for actions that drive Ryu itself.
//!
//! The approval gate ([`super::gate_tool_call_with_engine`]) queues a gated call
//! in the Approvals inbox. That is the right answer for unattended runs, but in a
//! live chat the user is right there: an agent asking to change a model's launch
//! settings or switch the interface should ask in the conversation, not park the
//! call in an inbox the user has to go find.
//!
//! The MCP bridge raises the in-chat permission card when it holds an interactive
//! channel ([`chat_confirmable`] + [`would_gate`]). When the user allows the call,
//! the bridge records a grant here, and the approval gate consumes it instead of
//! queueing. Everything else in the gate still runs first, so an organization
//! policy denial is never overridden by an in-chat "Allow".
//!
//! Grants are keyed by the host conversation that raised the prompt:
//! - **once**: this tool, with these exact arguments, for the next call only
//!   (expires after [`ONCE_TTL`] if the call never reaches the gate). An argument
//!   mismatch means no grant, so the call falls back to the inbox.
//! - **conversation**: this tool, any arguments, for the rest of the conversation
//!   (in memory, cleared on restart).
//!
//! A transport without a permission channel (the network MCP route, PTC code,
//! routines) never records a grant, so it keeps the inbox behaviour unchanged.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How long a one-shot grant waits for the call it approved.
const ONCE_TTL: Duration = Duration::from_secs(120);

/// Upper bound on remembered grants of either kind. Reaching it drops the oldest
/// state wholesale; the worst case is that the user is asked again.
const MAX_GRANTS: usize = 4096;

/// The workspace action that switches the user's interface.
pub const SWITCH_INTERFACE_TOOL_ID: &str = "workspace.switch_interface";

type OnceKey = (String, String, String);

static ONCE: LazyLock<Mutex<HashMap<OnceKey, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CONVERSATION: LazyLock<Mutex<HashSet<(String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn canonical(tool_id: &str) -> String {
    crate::sidecar::mcp::canonical_tool_id(tool_id)
}

/// Whether a tool's approval can be given in chat instead of the inbox: the
/// actions that change Ryu's own state through its HTTP API (`ryu_api.*` and an
/// app's `ryu_ext.*` mutations) and the interface switch. Other gated tools keep
/// their dedicated flows (agent configuration has its own card; research and
/// challenge submissions stay in the inbox).
pub fn chat_confirmable(tool_id: &str) -> bool {
    let id = canonical(tool_id);
    crate::self_api::is_mutating(&id)
        || crate::ext_api::is_mutating(&id)
        || id == SWITCH_INTERFACE_TOOL_ID
}

/// Whether the approval policy would gate `tool_id` right now (Layers A/B),
/// without queueing anything. `agent_approval_tools` is the calling agent's
/// explicit approval list. No approval engine means nothing is gated.
pub async fn would_gate(tool_id: &str, agent_approval_tools: &[String]) -> bool {
    let Some(engine) = super::global_engine() else {
        return false;
    };
    let raw = engine.approval_mode_pref().await;
    let mode = super::policy::ApprovalMode::from_pref(raw.as_deref().unwrap_or_default());
    super::policy::should_require_approval_local(
        agent_approval_tools,
        &canonical(tool_id),
        mode,
        raw.as_deref(),
    )
    .is_some()
}

fn fingerprint(arguments: &Value) -> String {
    // serde_json maps are ordered, so equal argument objects serialize equally.
    arguments.to_string()
}

/// Record the user's in-chat "Allow once" for exactly this call.
pub fn grant_once(conversation_id: &str, tool_id: &str, arguments: &Value) {
    if !chat_confirmable(tool_id) {
        return;
    }
    if let Ok(mut grants) = ONCE.lock() {
        let now = Instant::now();
        grants.retain(|_, granted| now.duration_since(*granted) < ONCE_TTL);
        if grants.len() >= MAX_GRANTS {
            grants.clear();
        }
        grants.insert(
            (
                conversation_id.to_owned(),
                canonical(tool_id),
                fingerprint(arguments),
            ),
            now,
        );
    }
}

/// Record the user's in-chat "Allow for this chat" for this tool.
pub fn grant_for_conversation(conversation_id: &str, tool_id: &str) {
    if !chat_confirmable(tool_id) {
        return;
    }
    if let Ok(mut grants) = CONVERSATION.lock() {
        if grants.len() >= MAX_GRANTS {
            grants.clear();
        }
        grants.insert((conversation_id.to_owned(), canonical(tool_id)));
    }
}

/// Whether the user already allowed this tool for the whole conversation.
pub fn allowed_for_conversation(conversation_id: &str, tool_id: &str) -> bool {
    chat_confirmable(tool_id)
        && CONVERSATION
            .lock()
            .map(|grants| grants.contains(&(conversation_id.to_owned(), canonical(tool_id))))
            .unwrap_or(false)
}

/// Consume a grant for this call, if the user gave one in chat. A one-shot grant
/// is removed; a conversation grant stays. Called by the approval gate after the
/// organization policy check.
pub fn take(conversation_id: &str, tool_id: &str, arguments: &Value) -> bool {
    if !chat_confirmable(tool_id) {
        return false;
    }
    if allowed_for_conversation(conversation_id, tool_id) {
        return true;
    }
    let key = (
        conversation_id.to_owned(),
        canonical(tool_id),
        fingerprint(arguments),
    );
    ONCE.lock()
        .ok()
        .and_then(|mut grants| grants.remove(&key))
        .is_some_and(|granted| granted.elapsed() < ONCE_TTL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LAUNCH: &str = "ryu_api.put_api_models_id_launch_config";

    #[test]
    fn only_ryu_mutations_and_interface_switches_are_confirmable_in_chat() {
        assert!(chat_confirmable(LAUNCH));
        assert!(chat_confirmable(SWITCH_INTERFACE_TOOL_ID));
        assert!(!chat_confirmable("ryu_api.get_api_models_id_launch_config"));
        assert!(!chat_confirmable("agent_builder.configure_agent"));
        assert!(!chat_confirmable("research.run"));
        assert!(!chat_confirmable("workspace.open_tab"));
    }

    #[test]
    fn a_once_grant_covers_one_identical_call() {
        let args = json!({ "id": "llama", "body": { "ctx_size": 8192 } });
        grant_once("conv-once", LAUNCH, &args);
        assert!(!take("conv-other", LAUNCH, &args));
        assert!(!take(
            "conv-once",
            LAUNCH,
            &json!({ "id": "llama", "body": { "ctx_size": 4096 } })
        ));
        assert!(take("conv-once", LAUNCH, &args));
        assert!(
            !take("conv-once", LAUNCH, &args),
            "a once grant is consumed"
        );
    }

    #[test]
    fn a_conversation_grant_covers_any_arguments_for_that_tool_only() {
        grant_for_conversation("conv-chat", LAUNCH);
        assert!(take("conv-chat", LAUNCH, &json!({ "id": "a" })));
        assert!(take("conv-chat", LAUNCH, &json!({ "id": "b" })));
        assert!(!take(
            "conv-chat",
            "ryu_api.put_api_preferences_key",
            &json!({ "key": "approval-mode" })
        ));
        assert!(!take("conv-elsewhere", LAUNCH, &json!({ "id": "a" })));
    }

    #[test]
    fn grants_for_unconfirmable_tools_are_ignored() {
        let args = json!({ "agent_id": "a" });
        grant_once("conv-x", "agent_builder.configure_agent", &args);
        grant_for_conversation("conv-x", "research.run");
        assert!(!take("conv-x", "agent_builder.configure_agent", &args));
        assert!(!take("conv-x", "research.run", &json!({})));
    }
}

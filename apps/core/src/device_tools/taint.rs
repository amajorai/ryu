//! Device data as private reads (design §2.4 step 9).
//!
//! A successful device read marks the turn (`DeviceOffer::private_read`, the
//! same `RunDataFlow` the PTC exfiltration guard uses). In the ACP bridge the
//! next registry call then runs inside that run scope, so the existing guard
//! holds any egress-capable call for Layer A approval, which in-chat grants do
//! not satisfy. A program started with `execute` or continued with `resume` in
//! that turn inherits the mark (`exfiltration_guard::scope_sandbox_run`), so
//! the calls it makes are held the same way. In the OpenAI plane a device turn
//! runs no registry tool at all (`openai_tool_lane` refuses every name that is
//! not a device or browser tool), and the only other tools are browser tools,
//! which are egress-capable and have no approval engine path, so they are
//! refused outright once the turn read device data.
//!
//! An ACP agent's OWN tools (its fetch, shell, file edits) never pass through
//! the bridge, so the guard cannot hold them. After a device read in a
//! conversation, their permission requests are therefore always put to the
//! user, and "always" options are withheld so no rule is persisted in the
//! agent's own settings ([`agent_egress_hold`]). A conversation whose history
//! already holds a device read starts its ACP turns private, because the agent
//! keeps that raw result in its own history (`turn_context`); with no live
//! device turn the bridge and these holds read the same fact from
//! [`super::conversation_taint`]. What
//! remains outside Core's reach: a native tool the agent runs without asking
//! (its own allow rules); see `docs/device-tools.md`.
//!
//! The other direction: a turn that already holds untrusted external content
//! (`mark_tainted_input`, set from the stored history, from browser results
//! and from any non-device tool an ACP agent reports) asks for every device
//! call.

use std::future::Future;
use std::sync::Arc;

use super::offer::DeviceOffer;
use crate::server::conversations::ConversationStore;

/// Record a successful device read on the turn.
pub(crate) fn mark_device_read(offer: &DeviceOffer, canonical_id: &str) {
    offer.private_read.mark_private_read(canonical_id);
}

/// The device tool that made this turn private, if any.
pub(crate) fn private_read_source(offer: &DeviceOffer) -> Option<String> {
    offer.private_read.private_read_source().map(str::to_owned)
}

/// The first private device read in a conversation's stored history. A
/// bridge call made with no live device turn (a later turn the phone is not
/// part of, or after the turn ended) uses it: the agent may still hold that
/// raw result. `Err` when the history, or any stored part, cannot be read, so
/// callers fail closed.
pub(crate) async fn history_private_read(
    store: &ConversationStore,
    conversation_id: &str,
) -> anyhow::Result<Option<String>> {
    let mut marks = super::agent_events::HistoryMarks::default();
    // Strict: a part that cannot be decrypted or parsed cannot be vouched
    // for, so it is an error (the caller refuses) rather than skipped.
    for (role, parts) in store.message_parts_strict(conversation_id).await? {
        let parts = parts.as_ref().and_then(serde_json::Value::as_array);
        marks.add_message(&role, parts.map(Vec::as_slice).unwrap_or_default());
    }
    Ok(marks.private_read)
}

/// The refusal a browser tool gets after a device read in the same turn.
pub(crate) fn browser_egress_refusal(offer: Option<&DeviceOffer>) -> Option<String> {
    let source = private_read_source(offer?)?;
    Some(format!(
        "This page action was not run: this turn already read private data from the phone with `{source}`, and sending data out after that needs your approval."
    ))
}

/// Run a bridge registry call under a private-read scope when no PTC run
/// scope is already set, so the exfiltration guard holds later egress: the
/// turn's own scope after a device read in it, otherwise a fresh one marked
/// with the read that `conversation` (a store and id) holds outside this
/// turn ([`super::conversation_taint`]; an unreadable history holds too).
pub(crate) async fn with_device_read_scope<F: Future>(
    offer: Option<&Arc<DeviceOffer>>,
    conversation: Option<(Option<&ConversationStore>, &str)>,
    future: F,
) -> F::Output {
    use crate::approvals::exfiltration_guard::{current_sandbox_run, scope_sandbox_run};
    if current_sandbox_run().is_some() {
        return future.await;
    }
    if let Some(offer) = offer.filter(|offer| private_read_source(offer).is_some()) {
        return scope_sandbox_run(Arc::clone(&offer.private_read), future).await;
    }
    let held = match conversation {
        Some((store, conversation_id)) => {
            super::conversation_taint::conversation_hold(store, conversation_id).await
        }
        None => None,
    };
    match held {
        Some(source) => {
            let run = Arc::new(crate::tool_exec::RunDataFlow::default());
            run.mark_private_read(&source);
            scope_sandbox_run(run, future).await
        }
        None => future.await,
    }
}

/// ACP tool kinds that cannot carry data out of the machine.
const NON_EGRESS_KINDS: &[&str] = &["read", "think", "switch_mode"];

/// Whether an agent tool of this ACP kind can send data out (fetch, execute,
/// edit, search and unknown kinds all can).
pub(crate) fn agent_kind_can_egress(kind: &str) -> bool {
    !NON_EGRESS_KINDS.contains(&kind)
}

/// The device read that holds an agent tool of `kind` in `conversation_id`,
/// found on its live ACP turn, as a read recorded when an earlier turn ended,
/// or in its stored history ([`super::conversation_taint`]; an unreadable
/// history holds too). The request is then put to the user without an
/// "always" option.
pub(crate) async fn agent_egress_hold(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    kind: &str,
) -> Option<String> {
    if !agent_kind_can_egress(kind) {
        return None;
    }
    super::conversation_taint::conversation_hold(store, conversation_id).await
}

#[cfg(test)]
#[path = "taint_tests.rs"]
mod tests;

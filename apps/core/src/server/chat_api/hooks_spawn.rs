//! Cloud-account auth handlers and the chat turn pipeline with its plugin hooks: `spawn_action_hooks` through `run_chat_with_hooks`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Run action observers without putting their side-model latency on the primary
/// stream. Each completed observer appends a cumulative note to the response,
/// which keeps desktop/island's existing note surfaces from showing only the
/// last action in a turn.
pub(in crate::server) fn spawn_action_hooks(
    state: &ServerState,
    hooks: &[crate::plugin_host::HookPlugin],
    conversation_id: &str,
    agent_id: Option<&str>,
    caller_user_id: Option<&str>,
    verified_caller: Option<&crate::identity_verify::VerifiedCaller>,
    flags: &std::collections::HashMap<String, bool>,
    action: crate::plugin_host::HookAction,
    notes: &tokio::sync::mpsc::UnboundedSender<ActionSummaryNote>,
) {
    let state = state.clone();
    let hooks = hooks.to_vec();
    let notes = notes.clone();
    let ctx = crate::plugin_host::HookContext {
        conversation_id: Some(conversation_id.to_owned()),
        agent_id: agent_id.map(str::to_owned),
        caller_user_id: caller_user_id.map(str::to_owned),
        verified_caller: verified_caller.cloned(),
        flags: flags.clone(),
        action: Some(action.clone()),
        ..Default::default()
    };
    // The hooks' tool calls are sub-turns of this turn: keep its attribution.
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let directives =
                crate::plugin_host::run_hooks(&state, &ctx, &hooks, crate::plugin_host::ON_ACTION)
                    .await;
            for directive in directives {
                let (question, text) = match directive {
                    crate::plugin_host::HookDirective::Note { text } => (None, text),
                    crate::plugin_host::HookDirective::ToolApproval { question, summary } => {
                        (Some(question), summary)
                    }
                    _ => continue,
                };
                let text = text.trim();
                if !text.is_empty() {
                    let question = question
                        .map(|value| value.trim().to_owned())
                        .filter(|value| !value.is_empty());
                    let _ = notes.send(ActionSummaryNote {
                        question,
                        sequence: action.sequence,
                        text: text.to_owned(),
                    });
                }
            }
        },
    ));
}

/// Wrap a chat turn with the plugin turn-hook runtime (M5). After the assistant
/// turn streams + persists, enabled `post_assistant_turn` hooks run: a `note`
/// directive is surfaced as a `data-plugin_note` UI part (e.g. double-check's
/// review), and a `continue` directive injects a follow-up user turn and streams
/// another turn into the SAME response (the server-side goal loop), capped at
/// [`crate::plugin_host::MAX_CONTINUE_TURNS`]. When no hook plugins are enabled
/// (or the sandbox backend is absent, or this is a background / non-persisted /
/// no-conversation turn) the inner stream is returned unwrapped — zero overhead
/// on the hot path.
/// The conversation a turn should be driven durably for — see
/// [`crate::sidecar::adapters::durable_turn`]. Only persisted turns qualify: an
/// ephemeral turn has nothing to resume or recover, so it stays bound to the
/// connection that asked for it.
pub(in crate::server) fn durable_turn_id(
    req: &crate::sidecar::adapters::ChatStreamRequest,
) -> Option<String> {
    req.persist.then(|| req.conversation_id.clone()).flatten()
}

/// Run a chat turn (with its plugin turn hooks) detached from the requesting
/// connection, so navigating away or reloading neither cancels generation nor
/// skips persistence, and the resume endpoint can replay it.
pub(in crate::server) async fn run_chat_with_hooks(
    state: ServerState,
    req: crate::sidecar::adapters::ChatStreamRequest,
) -> axum::response::Response {
    let durable_id = durable_turn_id(&req);
    crate::sidecar::adapters::durable_turn(durable_id, run_chat_with_hooks_attached(state, req))
        .await
}

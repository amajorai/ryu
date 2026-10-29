use super::*;

// ── Turn-boundary hooks on the OFF-HTTP chat paths ────────────────────────────
//
// `server::run_chat_with_hooks` wraps the HTTP chat entry, and until now that was
// the ONLY site firing the turn-BOUNDARY phases (`pre_user_turn`,
// `post_assistant_turn`/`stop`). Every other caller of `route_chat_stream` — the
// voice loop, the channel-bot reply, the team orchestrator — went straight to the
// model, so a plugin's prompt rewrite, its injected context, and its outright
// refusal silently did not apply to those turns.
//
// What is NOT missing on those paths, and is therefore deliberately not
// re-dispatched here: every message-plane phase above (`context`, `message_end`,
// `model_select`) and every tool phase (`pre_tool_use`, `tool_result`,
// `post_tool_use`) fires INSIDE `route_chat_stream` / the shared tool-dispatch
// core, which each bypassing caller does go through. Context engineering and
// tool-result redaction already govern those turns. Only the turn boundary needed
// a site — which is why the "no" decisions below cost a plugin its loop, never its
// redaction.
//
// `session_start` stays HTTP-only on purpose. It is defined as the first turn of a
// conversation, and these transports pin one long-lived conversation id per
// channel/WS session (a Telegram chat id outlives every process), so "the store
// has no prior messages" would fire once in the lifetime of a channel and never
// again — a boundary that does not correspond to a session on these surfaces.

/// The transcript window an off-HTTP turn hook sees. The same 20 as the HTTP
/// wrapper's `build_hook_context`, so a hook reads the same amount of history no
/// matter which transport opened the turn.
pub(crate) const OFF_HTTP_HOOK_TRANSCRIPT: usize = 20;

/// How long the turn-boundary hooks may run before the turn proceeds unchanged.
/// The same fail-open budget as [`CONTEXT_HOOK_TIMEOUT`], for a sharper reason:
/// voice is a realtime surface and a channel bot has a delivery deadline, so a
/// stuck hook must cost a directive, never the turn.
pub(crate) const TURN_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// What the `pre_user_turn` hooks decided about an off-HTTP turn's prompt.
pub(crate) enum PreUserTurn {
    /// Send this to the model. Byte-identical to the caller's prompt unless a hook
    /// returned `Replace` (rewrite) or `Inject` (append context).
    Prompt(String),
    /// A hook answered the turn itself (`Handled`): make NO model call and treat
    /// this text as the assistant's reply.
    ///
    /// The caller then owns persistence. `route_chat_stream` is what normally
    /// writes BOTH the user row and the assistant row, so a caller that skips it
    /// must write both itself — persisting only the reply would drop the user's
    /// own message from history and a reload would show an answer to nothing.
    Handled {
        reply: String,
        interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
    },
}

/// Run the `pre_user_turn` hooks for a turn that did not enter through the HTTP
/// chat handler (voice, channel bot, team fan-out).
///
/// Honours the same directives as the HTTP wrapper, in the same order: the first
/// non-empty `Replace` wins and stops the walk (a second rewrite would fight over
/// the same message), every `Inject` is appended as additional context, and
/// `Handled` ends the turn without a model call. Fail-open everywhere — already
/// inside a hook, on timeout, on a hook error — by returning the caller's prompt
/// untouched.
///
/// The prompt is passed as BOTH `ctx.input` (what a hook rewrites) and a
/// one-message transcript, because a hook's declarative `run_when.commands` gate
/// is evaluated against the last user message of `ctx.transcript`: leaving that
/// empty would silently mis-gate every slash-command hook to "never run" on these
/// transports. `ctx.flags` stays empty on purpose — flags are a per-request
/// composer toggle that no off-HTTP transport has, so a flag-gated hook correctly
/// does not fire here.
pub(crate) async fn run_pre_user_turn_hooks(
    prompt: String,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
) -> PreUserTurn {
    run_pre_user_turn_hooks_with_channel_action(prompt, conversation_id, agent_id, None).await
}

pub(crate) async fn run_pre_user_turn_hooks_with_channel_action(
    prompt: String,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
    channel_action: Option<ryu_channel_contracts::ChannelActionEvent>,
) -> PreUserTurn {
    if in_chat_hook() {
        return PreUserTurn::Prompt(prompt);
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: conversation_id.map(str::to_string),
        agent_id: agent_id.map(str::to_string),
        transcript: vec![crate::plugin_host::HookMessage {
            role: "user".to_owned(),
            content: prompt.clone(),
        }],
        input: Some(prompt.clone()),
        channel_action,
        ..Default::default()
    };
    let fut = IN_CHAT_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_PRE_USER_TURN, ctx),
    );
    let directives = match tokio::time::timeout(TURN_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!(
                "plugin_host: pre_user_turn hook timed out; sending the original prompt"
            );
            return PreUserTurn::Prompt(prompt);
        }
    };
    let mut out = prompt;
    for directive in directives {
        match directive {
            crate::plugin_host::HookDirective::Replace { text, .. } => {
                let t = text.trim();
                if !t.is_empty() {
                    out = t.to_owned();
                    break;
                }
            }
            crate::plugin_host::HookDirective::Inject { text } => {
                let t = text.trim();
                if !t.is_empty() {
                    // Same join as `append_last_user_text`, which is what the HTTP
                    // wrapper uses — an injected block must read the same way on
                    // every transport or a hook's prompt engineering drifts.
                    if out.is_empty() {
                        out = t.to_owned();
                    } else {
                        out.push_str("\n\n");
                        out.push_str(t);
                    }
                }
            }
            crate::plugin_host::HookDirective::Handled {
                text,
                interactive_markup,
            } => {
                let t = text.trim();
                if !t.is_empty() {
                    // First writer wins: once a hook owns the turn no later hook may
                    // claim it, or rewrite a prompt for a model call that is no
                    // longer going to happen.
                    let interactive_markup = interactive_markup.filter(|markup| {
                        if let Err(error) = markup.validate() {
                            tracing::warn!(%error, "plugin_host: ignoring invalid handled-turn channel markup");
                            false
                        } else {
                            true
                        }
                    });
                    return PreUserTurn::Handled {
                        reply: t.to_owned(),
                        interactive_markup,
                    };
                }
            }
            _ => {}
        }
    }
    PreUserTurn::Prompt(out)
}

/// Persist a turn a `pre_user_turn` hook answered itself ([`PreUserTurn::Handled`])
/// — the user's message and the hook's reply, in that order.
///
/// Off-HTTP callers must do this explicitly because `route_chat_stream` is the
/// only site that writes the user row (see its `skip_user_append` block) and a
/// handled turn never reaches it. Persisting just the reply would reload the
/// thread as an answer to nothing.
///
/// Best-effort, like every other persistence site on these paths: a write error
/// costs a transcript row, never the reply the caller is about to deliver.
pub(crate) async fn persist_handled_turn(
    conversations: &ConversationStore,
    conversation_id: &str,
    user_text: &str,
    reply: &str,
    agent_id: Option<&str>,
    author_user_id: Option<&str>,
    author_name: Option<&str>,
) -> Option<String> {
    if !user_text.trim().is_empty() {
        if let Err(e) = conversations
            .append_message_as(
                conversation_id,
                "user",
                user_text,
                agent_id,
                // The verified human author when the transport has one (a
                // member's voice session); channel callers are unauthenticated.
                // `author_name` is the connector-supplied display name.
                author_user_id,
                author_name,
                // The row exists and its owner was stamped upstream; the choke
                // point COALESCEs, so this preserves it.
                Tenancy::Unattributed,
            )
            .await
        {
            tracing::warn!("plugin_host: could not persist the user turn a hook handled: {e:#}");
        }
    }
    match conversations
        .append_message_as(
            conversation_id,
            "assistant",
            reply,
            agent_id,
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
    {
        Ok(message_id) => Some(message_id),
        Err(e) => {
            tracing::warn!("plugin_host: could not persist a hook-handled reply: {e:#}");
            None
        }
    }
}

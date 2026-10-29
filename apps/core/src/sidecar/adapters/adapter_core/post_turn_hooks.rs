use super::*;

/// Whether a post-turn dispatch is worth the transcript read it needs.
///
/// The dispatcher's own DB-free `any_manifest_declares` gate sits BEHIND the
/// trait, so by the time it can say "no plugin declares this phase" the caller has
/// already paid `get_active_messages` (which decrypts the whole thread). This is
/// the state-free half of that gate we can check from out here: with no code-exec
/// backend no hook can run at all, so a node without the sandbox never pays a read
/// per channel/voice turn. The HTTP wrapper gets the same protection from its own
/// `collect_enabled_hooks` gate before it builds any context.
fn post_turn_hooks_possible() -> bool {
    crate::tool_exec::is_available()
}

/// Build the `post_assistant_turn` context for an off-HTTP turn from the
/// PERSISTED transcript, exactly like the HTTP wrapper's `build_hook_context`.
/// Reading the store (rather than the request) is what lets a hook review the
/// reply that just landed. Fail-open: a store error yields an empty transcript, so
/// hooks still run and simply see nothing to act on.
async fn build_post_turn_hook_context(
    conversations: &ConversationStore,
    conversation_id: &str,
    agent_id: Option<&str>,
) -> crate::plugin_host::HookContext {
    let transcript = match conversations.get_active_messages(conversation_id).await {
        Ok(msgs) => {
            let skip = msgs.len().saturating_sub(OFF_HTTP_HOOK_TRANSCRIPT);
            msgs.into_iter()
                .skip(skip)
                .map(|m| crate::plugin_host::HookMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect()
        }
        Err(e) => {
            tracing::warn!("plugin_host: could not load transcript for turn hooks: {e:#}");
            Vec::new()
        }
    };
    crate::plugin_host::HookContext {
        conversation_id: Some(conversation_id.to_owned()),
        agent_id: agent_id.map(str::to_string),
        transcript,
        ..Default::default()
    }
}

/// Run the `post_assistant_turn` hooks for a completed off-HTTP turn and return
/// the first `Continue` text, or `None` when the turn is finished.
///
/// The caller owns the loop AND its cap ([`crate::plugin_host::MAX_CONTINUE_TURNS`]);
/// this helper deliberately does not loop, because "how a follow-up turn is run"
/// differs per transport and a helper that ran the turn itself would have to
/// guess. Fail-open on timeout/error → `None` (the turn ends), which is the safe
/// direction: a hook that cannot answer must never be able to wedge a bot into an
/// unbounded loop.
///
/// `Note` is dropped with a log. These transports have no out-of-band channel — a
/// channel bot delivers exactly one message and the voice protocol has no note
/// frame — so surfacing a note would mean folding it into the reply itself, which
/// is precisely what a note must not do (it is "not in chat history"). A plugin
/// that needs to say something on these surfaces uses `continue` or `replace`.
pub(crate) async fn run_post_assistant_turn_hooks(
    conversations: &ConversationStore,
    conversation_id: &str,
    agent_id: Option<&str>,
) -> PostAssistantTurnResult {
    if in_chat_hook() || !post_turn_hooks_possible() {
        return PostAssistantTurnResult::default();
    }
    let ctx = build_post_turn_hook_context(conversations, conversation_id, agent_id).await;
    let fut = IN_CHAT_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_POST_ASSISTANT_TURN, ctx),
    );
    let directives = match tokio::time::timeout(TURN_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!("plugin_host: post_assistant_turn hook timed out; ending the turn");
            return PostAssistantTurnResult::default();
        }
    };
    let mut outcome = PostAssistantTurnResult::default();
    for directive in directives {
        match directive {
            crate::plugin_host::HookDirective::Continue { text }
                if outcome.continue_text.is_none() =>
            {
                outcome.continue_text = Some(text);
            }
            crate::plugin_host::HookDirective::InteractiveMessage { markup }
                if outcome.interactive_markup.is_none() =>
            {
                match markup.validate() {
                    Ok(()) => outcome.interactive_markup = Some(markup),
                    Err(error) => {
                        tracing::warn!(%error, "plugin_host: ignoring invalid channel markup");
                    }
                }
            }
            crate::plugin_host::HookDirective::Note { text } => {
                tracing::debug!(
                    conversation_id = %conversation_id,
                    "plugin_host: dropping a post-turn note on a transport with no out-of-band channel: {text}"
                );
            }
            _ => {}
        }
    }
    outcome
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PostAssistantTurnResult {
    pub(crate) continue_text: Option<String>,
    pub(crate) interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
}

/// Fire the `post_assistant_turn` hooks DETACHED for a completed voice turn —
/// observation only, so a `stop`-phase observer (session logging, the learning
/// loop, a goal plugin's state keeping) sees voice turns like any other.
///
/// Detached, and directives dropped, because voice is the one surface that can
/// honour none of them. `Note` has no frame in the voice protocol, and `Continue`
/// would have to re-enter the realtime loop that owns barge-in, the sentence
/// accumulator and the TTS state machine — restarting a spoken turn from inside
/// that loop is the unbounded-talking hazard the cap exists to bound, and it is
/// the one directive the surface gains least from. So the turn ends when the
/// speaking ends, and the hooks observe it without the user waiting up to
/// [`TURN_HOOK_TIMEOUT`] for `state:idle`.
pub(crate) fn fire_voice_post_turn_hooks(
    conversations: ConversationStore,
    conversation_id: String,
    agent_id: Option<String>,
) {
    if in_chat_hook() || !post_turn_hooks_possible() {
        return;
    }
    tokio::spawn(async move {
        let ctx =
            build_post_turn_hook_context(&conversations, &conversation_id, agent_id.as_deref())
                .await;
        let directives = IN_CHAT_HOOK
            .scope(
                (),
                crate::plugin_host::dispatch_global(
                    crate::plugin_host::ON_POST_ASSISTANT_TURN,
                    ctx,
                ),
            )
            .await;
        if !directives.is_empty() {
            tracing::debug!(
                conversation_id = %conversation_id,
                count = directives.len(),
                "plugin_host: post_assistant_turn directives are observation-only on the voice path"
            );
        }
    });
}

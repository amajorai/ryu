use super::*;

/// One streamed OpenAI-compat `tool_calls[]` entry, reassembled from its deltas:
/// `id` and `function.name` arrive once; `function.arguments` streams in pieces.
#[derive(Default)]
pub(crate) struct AccToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

/// A shared, connection-pooled HTTP client for the governed chat tool loop's
/// Gateway dispatch calls. Cloning a `reqwest::Client` is cheap (an `Arc` inside).
pub(crate) fn shared_http_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

// ── Plugin turn hooks on the chat path (`context` / `message_end`) ─────────────
//
// Both phases fire from Ryu's OWN outbound sites rather than being proxied out of
// Pi. A Pi-side proxy would only ever fire for Pi-routed turns and would silently
// do nothing for Claude, Codex, or any other ACP agent; dispatching here means one
// installed plugin governs every agent.
//
// Neither `route_openai_stream` nor `route_acp_stream` is handed a `ServerState`
// (both are free functions that receive only the pieces of the request they need),
// so these go through the process-global dispatcher. It returns an empty vec when
// no dispatcher is installed (unit tests / headless), and its DB-free
// `any_manifest_declares` gate returns instantly when no loaded manifest declares
// the phase — so a node with no context/message_end plugin pays nothing, and every
// helper below is a no-op that leaves the turn byte-identical.

tokio::task_local! {
    /// Set while a chat-path hook runs, so a hook that itself starts a turn (via
    /// `host.runAgent`) does not re-enter the same phase and recurse forever.
    ///
    /// Same-task only, exactly like the `IN_TOOL_HOOK` guard in
    /// `crate::sidecar::mcp`: task-locals do not propagate into spawned tasks, so
    /// a hook whose turn lands in the DETACHED ACP completion task is not caught
    /// here. That path is bounded instead by the delegation wall-time and depth
    /// caps — the same trade the tool hooks make, rather than building cross-task
    /// machinery whose only job is to re-derive a bound that already exists.
    pub(crate) static IN_CHAT_HOOK: ();
}

pub(crate) fn in_chat_hook() -> bool {
    IN_CHAT_HOOK.try_with(|()| ()).is_ok()
}

/// How long the `context` hooks may run before the ORIGINAL context is sent
/// anyway. Fail-open, mirroring the tool-hook budgets in `crate::sidecar::mcp`:
/// a stuck context-engineering plugin must never wedge a turn, and must never lose
/// the prompt Ryu actually assembled.
const CONTEXT_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// How long the `message_end` hooks may run before the ORIGINAL reply is persisted
/// anyway. Same budget and the same fail-open rule as [`CONTEXT_HOOK_TIMEOUT`] —
/// a slow hook must never cost the user a finished answer.
const MESSAGE_END_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run the `context` hooks over the outbound OpenAI-compat message array and
/// return a replacement array if a hook asked for one.
///
/// `None` means "send the array we built" — on no subscriber, on timeout, on
/// error, while already inside a hook, and when every rewrite touched the frozen
/// prefix (see [`accept_context_rewrite`]). The array crosses the boundary as raw
/// provider JSON and never as `HookMessage`s: it carries multimodal `image_url`
/// parts and tool rows that a `{role, content}` struct would silently drop, so a
/// lossy round-trip would delete every image in the window.
pub(crate) async fn run_context_hooks_messages(
    messages: &[Value],
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
    flags: &std::collections::HashMap<String, bool>,
    project_instructions: Option<&str>,
    project_rules: Option<&[Value]>,
) -> Option<Vec<Value>> {
    if in_chat_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: conversation_id.map(str::to_string),
        agent_id: agent_id.map(str::to_string),
        flags: flags.clone(),
        messages: Some(messages.to_vec()),
        project_instructions: project_instructions.map(str::to_owned),
        project_rules: project_rules.map(<[Value]>::to_vec),
        ..Default::default()
    };
    let fut = IN_CHAT_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_CONTEXT, ctx),
    );
    let directives = match tokio::time::timeout(CONTEXT_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!(
                "plugin_host: context hook timed out; sending the original message array"
            );
            return None;
        }
    };
    // First writer wins: a rewrite is never fed back through the remaining hooks,
    // so what every hook inspects is the context Ryu actually assembled and no
    // plugin can be silently defeated by another one that happens to be installed
    // ahead of it. `Replace` is the ACP plane's directive and is ignored here.
    directives.into_iter().find_map(|d| match d {
        crate::plugin_host::HookDirective::Rewrite {
            messages: rewritten,
        } => accept_context_rewrite(messages, rewritten),
        _ => None,
    })
}

/// Index of the newest `user` row: where the mutable tail of an outbound window
/// begins. `None` when the window has no user row.
fn latest_user_index(messages: &[Value]) -> Option<usize> {
    messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
}

/// Accept a `context` rewrite only when it leaves the cacheable prefix intact.
///
/// Provider prompt caches (and the gateway's prefix reuse) key on the exact bytes
/// of the system prompt and every earlier turn. A plugin that edits those after a
/// chat has started — stripping a block from the system message, cleaning an old
/// user row — invalidates the cache on every turn, and a plugin whose edit varies
/// turn to turn (a turn budget, a toggled preference) does so even when each
/// single edit looks harmless. So the system prompt and every row before the
/// newest user message are frozen: a rewrite must reproduce them byte-for-byte and
/// may only change the newest user message and what follows it. That is the same
/// seam Core uses for its own per-turn context ([`append_ephemeral_turn_context`]).
///
/// A rewrite that touches the frozen prefix is dropped whole (fail-open to the
/// array Ryu built) rather than partially spliced, because a hook that reordered
/// or deleted earlier rows has no well-defined tail to keep.
pub(crate) fn accept_context_rewrite(
    original: &[Value],
    rewritten: Vec<Value>,
) -> Option<Vec<Value>> {
    let frozen = latest_user_index(original).unwrap_or(original.len());
    if rewritten.len() >= frozen && rewritten[..frozen] == original[..frozen] {
        return Some(rewritten);
    }
    tracing::warn!(
        frozen_rows = frozen,
        "plugin_host: context hook rewrote the system prompt or earlier history; \
         ignoring it to keep the prompt cache prefix stable (only the latest user \
         message may change)"
    );
    None
}

/// Run the `context` hooks over the flattened ACP prompt and return the text a
/// hook appended to it. `None` means "send the prompt we built".
///
/// The ACP plane has no array to rewrite: [`build_acp_prompt`] collapses the whole
/// window into ONE string that `acp.rs` sends as a single text block. So the prompt
/// rides in `ctx.input` and a hook answers with [`HookDirective::Replace`]; a
/// `Rewrite` aimed at the other plane is ignored rather than guessed at.
///
/// The replacement must keep the prompt Core built as its exact prefix, for the
/// same prompt-cache reason as [`accept_context_rewrite`]: the preamble and
/// replayed history are frozen and a hook may only add to the latest message.
/// Only the appended suffix is returned, so the caller can add it to both the full
/// prompt and the pooled session's turn delta — the warm ACP session (and its
/// cached prefix) is kept. The directive's `fresh_session` flag is ignored here:
/// discarding the pooled session every turn would throw that cache away.
///
/// Dispatching from the call site instead of making `build_acp_prompt` async is
/// deliberate — that helper stays a pure, directly-unit-tested string builder, and
/// the fail-open/timeout policy stays next to its message-array sibling above.
///
/// [`HookDirective::Replace`]: crate::plugin_host::HookDirective::Replace
pub(crate) async fn run_context_hooks_prompt(
    prompt: &str,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
    flags: &std::collections::HashMap<String, bool>,
    project_instructions: Option<&str>,
    project_rules: Option<&[Value]>,
) -> Option<String> {
    if in_chat_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: conversation_id.map(str::to_string),
        agent_id: agent_id.map(str::to_string),
        flags: flags.clone(),
        input: Some(prompt.to_owned()),
        project_instructions: project_instructions.map(str::to_owned),
        project_rules: project_rules.map(<[Value]>::to_vec),
        ..Default::default()
    };
    let fut = IN_CHAT_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_CONTEXT, ctx),
    );
    let directives = match tokio::time::timeout(CONTEXT_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!("plugin_host: context hook timed out; sending the original ACP prompt");
            return None;
        }
    };
    // First writer wins, for the same reason as the message-array plane.
    directives.into_iter().find_map(|d| match d {
        crate::plugin_host::HookDirective::Replace { text, .. } => {
            context_prompt_suffix(prompt, &text)
        }
        _ => None,
    })
}

/// The text an ACP `context` replacement appended to `original`, or `None` when it
/// appended nothing or edited the frozen prompt Core built.
pub(crate) fn context_prompt_suffix(original: &str, rewritten: &str) -> Option<String> {
    let Some(suffix) = rewritten.strip_prefix(original) else {
        tracing::warn!(
            "plugin_host: context hook edited the ACP preamble or history; ignoring it \
             to keep the prompt cache prefix stable (only appending is allowed)"
        );
        return None;
    };
    (!suffix.is_empty()).then(|| suffix.to_owned())
}

/// Run the `message_end` hooks over a finalized assistant reply and return the
/// replacement text if a hook asked for one. `None` means "persist what the model
/// produced" — on no subscriber, on timeout, on error, and inside a hook.
///
/// Fires at the finalize point on BOTH planes, before any persistence, so a
/// `Replace` reaches every write the turn is about to make. It cannot un-stream
/// the deltas the client already rendered: a message is only "finalized" after its
/// text has streamed, which is exactly why Pi puts this phase at `message_end`
/// rather than on each delta. A plugin that must gate text before the user ever
/// sees it belongs on `context`, not here.
pub(crate) async fn run_message_end_hooks(
    reply: &str,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
    flags: &std::collections::HashMap<String, bool>,
) -> Option<String> {
    if in_chat_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: conversation_id.map(str::to_string),
        agent_id: agent_id.map(str::to_string),
        flags: flags.clone(),
        output: Some(reply.to_owned()),
        ..Default::default()
    };
    let fut = IN_CHAT_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_MESSAGE_END, ctx),
    );
    let directives = match tokio::time::timeout(MESSAGE_END_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!(
                "plugin_host: message_end hook timed out; persisting the original reply"
            );
            return None;
        }
    };
    // First writer wins: two plugins cannot both claim the final answer, and the
    // rewrite is not re-fed to the remaining hooks, so each one sees the reply the
    // model actually produced.
    directives.into_iter().find_map(|d| match d {
        crate::plugin_host::HookDirective::Replace { text, .. } => Some(text),
        _ => None,
    })
}

/// Fire the `model_select` hooks DETACHED for a per-turn model pick.
///
/// Observation-only by definition — no directive can change a model — so the
/// returned directives are dropped and nothing downstream waits on the result.
/// That is also why there is no timeout here: a timeout exists to bound a caller
/// that is blocked, and this caller never blocks.
pub(crate) fn fire_model_select_hooks(
    model: String,
    conversation_id: Option<String>,
    agent_id: String,
) {
    if in_chat_hook() {
        return;
    }
    tokio::spawn(async move {
        let ctx = crate::plugin_host::HookContext {
            conversation_id,
            agent_id: Some(agent_id),
            event: Some(serde_json::json!({ "model": model, "source": "turn" })),
            ..Default::default()
        };
        let _ = IN_CHAT_HOOK
            .scope(
                (),
                crate::plugin_host::dispatch_global(crate::plugin_host::ON_MODEL_SELECT, ctx),
            )
            .await;
    });
}

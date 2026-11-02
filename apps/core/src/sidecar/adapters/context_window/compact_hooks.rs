//! Plugin compaction hooks for [`super`]: `session_before_compact` observers and
//! the awaited `session_compact` rewrite.

use crate::plugin_host::{self, HookContext, HookDirective, HookMessage};

// ── Plugin compaction hooks (`session_before_compact` / `session_compact`) ────
//
// Both planes below (the OpenAI-compat array and the ACP short-term replay) drop
// the same shape of turns, so both fire the same two phases through the
// process-global dispatcher — these functions have no `ServerState` handle, and
// deliberately don't take one (that is why summarization talks to the gateway
// directly instead of going through `server::call_side_model`).

tokio::task_local! {
    /// Set while a compaction hook runs, so a hook whose own side effects reach
    /// back into the chat path — `host.runAgent` spawns a real sub-agent turn,
    /// which assembles its own context window — cannot re-enter compaction in the
    /// SAME task and recurse. Mirrors `sidecar::mcp`'s `IN_TOOL_HOOK`.
    ///
    /// Task-locals do not propagate across `tokio::spawn`, so a delegated
    /// sub-agent's own compaction IS still governed: that is intentional (the
    /// sub-agent is a real turn a plugin should see), and the recursion it allows
    /// is bounded by the delegation wall-time/depth caps rather than by this flag.
    pub(super) static IN_COMPACT_HOOK: ();
}

fn in_compact_hook() -> bool {
    IN_COMPACT_HOOK.try_with(|()| ()).is_ok()
}

/// How long the `session_compact` hooks may run before the ORIGINAL summary is
/// used anyway. Mirrors the 8s tool-hook budget in `sidecar::mcp`
/// (`PRE_TOOL_HOOK_TIMEOUT` / `TOOL_RESULT_HOOK_TIMEOUT`): a stuck rewriting hook
/// must never wedge a turn, and must never lose the real summary.
const COMPACT_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// The dropped turns in the hook wire shape. Built from the same flattened
/// `(role, text)` view the summarizer sends to the side model, so a hook inspects
/// exactly what compaction acted on rather than a second, differently-derived one.
pub(super) fn hook_messages(convo: &[(String, String)]) -> Vec<HookMessage> {
    convo
        .iter()
        .map(|(role, content)| HookMessage {
            role: role.clone(),
            content: content.clone(),
        })
        .collect()
}

/// Fire `session_before_compact` DETACHED, once the set of turns to drop is known.
///
/// Observation-only, so it must add exactly zero latency to the turn that
/// triggered the compaction; directives are ignored here. A plugin that wants to
/// *change* the outcome declares `session_compact` instead, which is awaited.
///
/// Fired for BOTH modes — trim drops the turns outright — because the phase is
/// "Ryu is about to drop these turns", not "Ryu is about to summarize them".
/// Gating it on `auto_compact` would mean an observer plugin silently never fires
/// for the majority (trim) case.
///
/// Because it is detached, this can land *after* the awaited `session_compact`
/// dispatch below has already completed. That ordering skew is deliberate and
/// harmless: nothing downstream reads the observers' result.
pub(super) fn fire_before_compact_hooks(
    conversation_id: Option<String>,
    convo: &[(String, String)],
) {
    if in_compact_hook() {
        return;
    }
    let dropped = hook_messages(convo);
    tokio::spawn(async move {
        let ctx = HookContext {
            conversation_id,
            dropped: Some(dropped),
            ..Default::default()
        };
        let _ = IN_COMPACT_HOOK
            .scope(
                (),
                plugin_host::dispatch_global(plugin_host::ON_SESSION_BEFORE_COMPACT, ctx),
            )
            .await;
    });
}

/// Run the awaited `session_compact` hooks over a produced `summary` and return the
/// text to actually merge back into the window. Returns `summary` unchanged when no
/// plugin subscribes, on timeout, on a hook error, and when the code-exec backend is
/// absent — every failure mode leaves compaction byte-identical to the un-hooked path.
///
/// `ctx.output` is the summary *as it will be merged*, i.e. the already-labelled
/// `[Earlier conversation summary]` block, so a hook that returns
/// [`HookDirective::Replace`] owns the label too. A blank replacement is ignored
/// rather than allowed to erase the summary, mirroring the blank-summary guard in
/// [`summarize`].
///
/// First writer wins: only the FIRST `Replace` is applied and the rewrite is not
/// re-fed through the remaining hooks, so what every hook inspects is the real
/// model summary and plugin install order cannot silently defeat another plugin.
///
/// **Cache interaction (deliberate, do not move this inside [`summarize`]).** This
/// runs strictly *after* `summarize` has memoized, so `summary_cache` always holds
/// the untouched side-model summary and never a plugin's rewrite. The cache key
/// hashes only `(model, dropped turns)` — not the installed plugin set — so a cached
/// rewrite would keep being served after that plugin was disabled or replaced, and
/// re-feeding a rewrite into the hook on the next identical compaction would let a
/// non-idempotent hook compound its own output. Keeping the memo a pure record of
/// what the model said, and re-applying the hook to it every time, is stable under
/// both.
pub(super) async fn apply_compact_hooks(
    conversation_id: Option<String>,
    convo: &[(String, String)],
    summary: String,
) -> String {
    if in_compact_hook() {
        return summary;
    }
    let ctx = HookContext {
        conversation_id,
        dropped: Some(hook_messages(convo)),
        output: Some(summary.clone()),
        ..Default::default()
    };
    let fut = IN_COMPACT_HOOK.scope(
        (),
        plugin_host::dispatch_global(plugin_host::ON_SESSION_COMPACT, ctx),
    );
    let directives = match tokio::time::timeout(COMPACT_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!(
                "plugin_host: session_compact hook timed out; using the original summary"
            );
            return summary;
        }
    };
    directives
        .into_iter()
        .find_map(|d| match d {
            HookDirective::Replace { text, .. } if !text.trim().is_empty() => Some(text),
            _ => None,
        })
        .unwrap_or(summary)
}

//! Plugin pre-tool, tool-result and post-tool hook dispatch.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use super::*;

tokio::task_local! {
    /// Set while a tool-use hook runs, so a hook that itself triggers a tool call
    /// (via `host.runAgent`) in the SAME task does not re-enter the tool-hook
    /// phase. Note: task-locals do not propagate to spawned sub-agent tasks, so a
    /// delegated sub-agent's tool calls ARE still governed (by design); runaway
    /// recursion is bounded by the delegation wall-time/depth caps.
    static IN_TOOL_HOOK: ();
}

pub(super) fn in_tool_hook() -> bool {
    IN_TOOL_HOOK.try_with(|()| ()).is_ok()
}

/// Mark the current PTC program run (if any) as having read private data through
/// an authenticated fetch (see [`crate::approvals::exfiltration_guard`]). Only the
/// dispatch knows a credential was attached, so it marks the run itself. A tool
/// hook's own calls never reach the program, so they are not counted.
pub(crate) fn note_authenticated_read(tool_id: &str) {
    if in_tool_hook() {
        return;
    }
    if let Some(run) = crate::approvals::exfiltration_guard::current_sandbox_run() {
        run.mark_private_read(tool_id);
    }
}

/// How long a `pre_tool_use` hook may run before the call is allowed through
/// anyway. Fail-open: a stuck or slow hook must never wedge tool dispatch.
const PRE_TOOL_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run `pre_tool_use` hooks for a tool call. Returns `Some(reason)` if a hook
/// blocked it (Claude's PreToolUse deny), else `None`. Fail-open on every error /
/// timeout / unavailable-sandbox path (returns `None` = allow). Reentrancy-guarded.
pub(super) async fn run_pre_tool_hooks(
    tool_id: &str,
    arguments: &Value,
    session_id: Option<&str>,
) -> Option<String> {
    if in_tool_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: session_id.map(str::to_string),
        tool_name: Some(tool_id.to_string()),
        tool_input: Some(arguments.clone()),
        ..Default::default()
    };
    let fut = IN_TOOL_HOOK.scope(
        (),
        crate::plugin_host::dispatch_global(crate::plugin_host::ON_PRE_TOOL_USE, ctx),
    );
    let directives = match tokio::time::timeout(PRE_TOOL_HOOK_TIMEOUT, fut).await {
        Ok(d) => d,
        Err(_) => {
            tracing::warn!("plugin_host: pre_tool_use hook timed out for '{tool_id}'; allowing");
            return None;
        }
    };
    directives.into_iter().find_map(|d| match d {
        crate::plugin_host::HookDirective::Deny { reason } => Some(reason),
        _ => None,
    })
}

/// How long the `tool_result` hooks may run before the ORIGINAL result is used
/// anyway. Fail-open, mirroring [`PRE_TOOL_HOOK_TIMEOUT`]: a stuck rewriting hook
/// must never wedge tool dispatch, and must never lose the real result.
const TOOL_RESULT_HOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Run `tool_result` hooks for a completed tool call and return a rewritten result
/// if a hook asked for one (Pi's `tool_result`, Eve's `toolResultFrom`).
///
/// Returns `None` to mean "use the original output" — on no subscriber, on
/// timeout, on error, and on an absent code-exec backend. The DB-free
/// `any_manifest_declares` gate inside `dispatch_phase` makes the no-plugin case
/// free, so tool dispatch is unchanged for anyone without a rewriting plugin.
pub(super) async fn run_tool_result_hooks(
    tool_id: &str,
    arguments: &Value,
    output: &Value,
    session_id: Option<&str>,
) -> Option<Value> {
    if in_tool_hook() {
        return None;
    }
    let ctx = crate::plugin_host::HookContext {
        conversation_id: session_id.map(str::to_string),
        tool_name: Some(tool_id.to_string()),
        tool_input: Some(arguments.clone()),
        tool_output: Some(output.clone()),
        ..Default::default()
    };
    let fut = IN_TOOL_HOOK.scope((), crate::plugin_host::dispatch_global_tool_result(ctx));
    match tokio::time::timeout(TOOL_RESULT_HOOK_TIMEOUT, fut).await {
        Ok(output) => output,
        Err(_) => {
            tracing::warn!(
                "plugin_host: tool_result hook timed out for '{tool_id}'; using the original result"
            );
            return None;
        }
    }
}

/// Fire `post_tool_use` hooks (Claude's PostToolUse) DETACHED — observation-only,
/// so it never adds latency or blocks the caller, and cannot fail the tool call.
/// Directives are ignored: a plugin that needs to change the result declares
/// `tool_result` ([`run_tool_result_hooks`]) instead.
pub(super) fn fire_post_tool_hooks(tool_id: String, arguments: Value, output: Value) {
    if in_tool_hook() {
        return;
    }
    tokio::spawn(async move {
        let ctx = crate::plugin_host::HookContext {
            tool_name: Some(tool_id),
            tool_input: Some(arguments),
            tool_output: Some(output),
            ..Default::default()
        };
        let _ = IN_TOOL_HOOK
            .scope(
                (),
                crate::plugin_host::dispatch_global(crate::plugin_host::ON_POST_TOOL_USE, ctx),
            )
            .await;
    });
}

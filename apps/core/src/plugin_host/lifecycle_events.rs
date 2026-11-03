//! Plugin-update and workflow-run lifecycle events.

use super::*;

/// Build the `ctx.event` payload for a [`ON_PLUGIN_UPDATE`] hook. Every field is
/// set by Core, so a hook can trust it.
pub fn plugin_update_event(
    plugin_id: &str,
    from_version: &str,
    to_version: &str,
    reason: &str,
) -> serde_json::Value {
    serde_json::json!({
        "source": ON_PLUGIN_UPDATE,
        "plugin_id": plugin_id,
        "from_version": from_version,
        "to_version": to_version,
        "reason": reason,
    })
}

/// The `plugin_update` hooks `plugin_id` owns, in dispatch order. Pure so the
/// own-plugin-only guarantee is unit-testable.
pub fn plugin_update_hooks_for(hooks: Vec<HookPlugin>, plugin_id: &str) -> Vec<HookPlugin> {
    hooks
        .into_iter()
        .filter(|hook| hook.plugin_id == plugin_id && phase_matches(&hook.on, ON_PLUGIN_UPDATE))
        .collect()
}

/// Run `plugin_id`'s own [`ON_PLUGIN_UPDATE`] hooks after its version changed.
/// Fail-open (a failing migration hook is logged, never undoes the update) and
/// filtered to the app-event directive policy. Returns the surviving directives.
pub async fn dispatch_plugin_update(
    state: &ServerState,
    plugin_id: &str,
    from_version: &str,
    to_version: &str,
    reason: &str,
) -> Vec<HookDirective> {
    if !tool_exec::is_available() || !any_manifest_declares(state, ON_PLUGIN_UPDATE).await {
        return Vec::new();
    }
    let hooks = plugin_update_hooks_for(collect_enabled_hooks(state).await, plugin_id);
    if hooks.is_empty() {
        return Vec::new();
    }
    let ctx = HookContext {
        event: Some(plugin_update_event(
            plugin_id,
            from_version,
            to_version,
            reason,
        )),
        ..Default::default()
    };
    run_hooks(state, &ctx, &hooks, ON_PLUGIN_UPDATE)
        .await
        .into_iter()
        .filter(app_event_directive_allowed)
        .collect()
}

/// Fire a workflow-run lifecycle hook DETACHED, with `payload` in
/// [`HookContext::event`].
///
/// Detached for the same reason [`ON_POST_TOOL_USE`] is: the executor is the hot
/// path for every automation on the node, and a hook must not be able to slow a run
/// down — let alone fail one. Callers are sync-friendly (this spawns rather than
/// awaiting), which is what lets it be called from the executor without
/// restructuring it.
pub fn fire_workflow_run_event(phase: &'static str, payload: serde_json::Value) {
    let payload = redact_script_run_event(payload);
    // A hook's tool calls are sub-turns of the run's turn: carry its streak
    // attribution across the spawn.
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let ctx = HookContext {
                event: Some(payload),
                ..Default::default()
            };
            let _ = dispatch_global(phase, ctx).await;
        },
    ));
}

/// Strip the result and error text from a lifecycle payload for an ad-hoc
/// script run (`sr-…`). Those runs belong to the plugin + agent + conversation
/// that started them and are read back only through a scoped
/// `host.workflowRunStatus`; a global observer hook still learns that the run
/// started and ended, but not what it produced.
pub(super) fn redact_script_run_event(mut payload: serde_json::Value) -> serde_json::Value {
    let is_script_run = payload
        .get("run_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id.starts_with(crate::workflow::script::SCRIPT_RUN_PREFIX));
    if is_script_run {
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("output");
            fields.remove("error");
        }
    }
    payload
}

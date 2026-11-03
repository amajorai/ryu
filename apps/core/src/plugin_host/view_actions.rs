//! View actions (the `view_action` phase).

use super::*;

// ── View actions (the `view_action` phase) ──────────────────────────────────

/// What relaying one `view.action` intent to the owning plugin produced.
#[derive(Debug, Clone, PartialEq)]
pub enum ViewActionOutcome {
    /// The plugin declares no enabled `view_action` hook.
    NoHandler,
    /// The sandbox backend that runs hooks is not available on this node.
    Unavailable,
    /// Every matching hook ran and returned [`HookDirective::None`].
    Declined { hook_ids: Vec<String> },
    /// At least one hook acted; `messages` are its `Note` texts (possibly empty).
    Handled {
        hook_ids: Vec<String>,
        messages: Vec<String>,
    },
}

/// The `view_action` hooks `plugin_id` owns, in dispatch order. Pure so the
/// own-plugin-only guarantee is unit-testable: another plugin's hook on the same
/// phase is never selected.
pub fn view_action_hooks_for(hooks: Vec<HookPlugin>, plugin_id: &str) -> Vec<HookPlugin> {
    hooks
        .into_iter()
        .filter(|hook| hook.plugin_id == plugin_id && phase_matches(&hook.on, ON_VIEW_ACTION))
        .collect()
}

/// Build the `ctx.event` payload for a `view_action` hook from the relayed
/// `view.action` args. Only the documented fields are forwarded, and `source` is
/// always set by Core so a hook can trust it.
pub fn view_action_event(args: &serde_json::Value) -> serde_json::Value {
    let field = |key: &str| args.get(key).cloned().unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "source": ON_VIEW_ACTION,
        "view_id": field("view_id"),
        "action_id": field("action_id"),
        "intent": field("intent"),
        "payload": field("payload"),
        "values": field("values"),
        "item": field("item"),
    })
}

/// Fold the directives returned by `view_action` hooks into an outcome. Only
/// `None`/`Note` are meaningful off the chat path (the app-event policy); any
/// other directive still counts as "acted" but contributes no message.
pub fn view_action_outcome(
    hook_ids: Vec<String>,
    directives: &[HookDirective],
) -> ViewActionOutcome {
    if hook_ids.is_empty() {
        return ViewActionOutcome::NoHandler;
    }
    let acted: Vec<&HookDirective> = directives
        .iter()
        .filter(|directive| !matches!(directive, HookDirective::None))
        .collect();
    if acted.is_empty() {
        return ViewActionOutcome::Declined { hook_ids };
    }
    let messages = acted
        .into_iter()
        .filter_map(|directive| match directive {
            HookDirective::Note { text } if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
        .collect();
    ViewActionOutcome::Handled { hook_ids, messages }
}

/// Relay a `view.action` intent to `plugin_id`'s own `view_action` hooks.
///
/// * **Own hooks only** — `plugin_id` comes from the HTTP path, never the body.
/// * **No privilege gain** — each hook runs with the intersection of its manifest
///   grants and the Gateway-approved grants the caller already validated.
/// * The verified caller is carried so the hook's storage/notifications stay
///   tenant-scoped exactly as on the chat path.
pub async fn dispatch_view_action(
    state: &ServerState,
    plugin_id: &str,
    approved_grants: &HashSet<String>,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    args: &serde_json::Value,
) -> ViewActionOutcome {
    let mut hooks = view_action_hooks_for(collect_enabled_hooks(state).await, plugin_id);
    if hooks.is_empty() {
        return ViewActionOutcome::NoHandler;
    }
    if !tool_exec::is_available() {
        return ViewActionOutcome::Unavailable;
    }
    for hook in &mut hooks {
        hook.grants.retain(|grant| approved_grants.contains(grant));
    }
    let ctx = HookContext {
        caller_user_id: caller.as_ref().map(|c| c.user_id.clone()),
        verified_caller: caller,
        event: Some(view_action_event(args)),
        ..Default::default()
    };
    let hook_ids = hooks.iter().map(|hook| hook.hook_id.clone()).collect();
    let directives = run_hooks(state, &ctx, &hooks, ON_VIEW_ACTION).await;
    view_action_outcome(hook_ids, &directives)
}

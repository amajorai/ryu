//! Hook collection, policy, and phase dispatch.

use super::*;

/// Whether a hook declared for `hook_on` should run in `phase`. Exact match,
/// except [`ON_STOP`] is treated as an alias of [`ON_POST_ASSISTANT_TURN`].
///
/// App-event phases need no clause here: they are exact-matched like everything
/// else, and their mandatory `/` keeps them from ever colliding with a Core phase
/// name.
pub fn phase_matches(hook_on: &str, phase: &str) -> bool {
    hook_on == phase || (phase == ON_POST_ASSISTANT_TURN && hook_on == ON_STOP)
}

/// A hard cap on how many `continue` directives a single chat request may apply
/// (the server-side analog of the old client `MAX_GOAL_TURNS`). The chat path
/// enforces this; exported here so the cap lives in one place.
pub const MAX_CONTINUE_TURNS: u32 = 25;

pub(crate) fn hook_policy_allows(
    policy: Option<&crate::governance::HookPolicyOverride>,
    trusted_by_default: bool,
) -> bool {
    let enabled = policy.and_then(|value| value.enabled).unwrap_or(true);
    let trusted = policy
        .and_then(|value| value.trusted)
        .unwrap_or(trusted_by_default);
    enabled && trusted
}

/// A saved approval cannot outlive the app's current declaration ceiling.
pub(crate) async fn current_approved_grants(
    state: &ServerState,
    plugin_id: &str,
    approved: &[String],
) -> HashSet<String> {
    let manifests = state.app_manifests.read().await;
    manifests
        .iter()
        .find(|manifest| manifest.id == plugin_id)
        .map(|manifest| {
            manifest
                .approved_permission_grants(approved)
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

/// Collect hooks with live approvals intersected with their current declarations.
pub async fn collect_enabled_hooks(state: &ServerState) -> Vec<HookPlugin> {
    let enabled_ids: std::collections::HashMap<String, Vec<String>> =
        match state.app_store.list().await {
            Ok(records) => records
                .into_iter()
                .filter(|r| r.enabled)
                .map(|r| (r.id, r.approved_grants))
                .collect(),
            Err(e) => {
                tracing::warn!("plugin_host: could not list plugins: {e}");
                return Vec::new();
            }
        };
    if enabled_ids.is_empty() {
        return Vec::new();
    }
    let hook_overrides = match state.app_store.effective_hook_overrides().await {
        Ok(overrides) => overrides,
        Err(error) => {
            tracing::warn!("plugin_host: could not read hook policy: {error}");
            return Vec::new();
        }
    };

    // Read from the already-loaded, hot-updated manifest set (no disk re-read).
    let manifests = state.app_manifests.read().await;
    collect_hooks_from_manifests(&manifests, &enabled_ids, &hook_overrides)
}

pub(super) fn collect_hooks_from_manifests(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_ids: &std::collections::HashMap<String, Vec<String>>,
    hook_overrides: &std::collections::BTreeMap<String, crate::governance::HookPolicyOverride>,
) -> Vec<HookPlugin> {
    let mut hooks = Vec::new();
    for manifest in manifests.iter() {
        let Some(approved_grants) = enabled_ids.get(&manifest.id) else {
            continue;
        };
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        if contributes.turn_hooks.is_empty() {
            continue;
        }
        let grants: HashSet<String> = manifest
            .approved_permission_grants(approved_grants)
            .into_iter()
            .collect();
        for hook in &contributes.turn_hooks {
            let hook_key = format!("{}::{}", manifest.id, hook.id);
            let trusted_by_default = crate::plugins::builtins::is_exact_compiled_manifest(manifest);
            if !hook_policy_allows(hook_overrides.get(&hook_key), trusted_by_default) {
                continue;
            }
            hooks.push(HookPlugin {
                plugin_id: manifest.id.clone(),
                hook_id: hook.id.clone(),
                on: hook.on.clone(),
                mode: hook.mode.unwrap_or_default(),
                priority: hook.priority,
                code: hook.code.clone(),
                grants: grants.clone(),
                run_when: hook.run_when.clone(),
            });
        }
    }
    hooks.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
            .then_with(|| left.hook_id.cmp(&right.hook_id))
    });
    hooks
}

/// Run every enabled `post_assistant_turn` hook against `ctx` and collect their
/// non-`None` directives (in plugin order). Fail-open: a hook that errors or
/// times out is skipped, never blocking the turn.
pub async fn dispatch_turn_hooks(state: &ServerState, ctx: &HookContext) -> Vec<HookDirective> {
    if !tool_exec::is_available() {
        tracing::debug!("plugin_host: code-exec backend unavailable; skipping turn hooks");
        return Vec::new();
    }
    let hooks = collect_enabled_hooks(state).await;
    run_hooks(state, ctx, &hooks, ON_POST_ASSISTANT_TURN).await
}

/// Does any **loaded** manifest declare a hook for `phase`? Cheap and DB-free
/// (reads only the in-memory manifest set). The off-path dispatchers call this to
/// return instantly when no plugin could possibly handle a phase — so e.g. a tool
/// call pays nothing on the hot path unless a tool-hook plugin is actually loaded.
pub async fn any_manifest_declares(state: &ServerState, phase: &str) -> bool {
    let manifests = state.app_manifests.read().await;
    manifests.iter().any(|m| {
        m.contributes
            .as_ref()
            .is_some_and(|c| c.turn_hooks.iter().any(|h| phase_matches(&h.on, phase)))
    })
}

/// Collect enabled hooks and run those for `phase`. The one entry point the
/// process-global dispatcher uses. Fail-open + DB-free fast path: returns empty
/// without touching the plugin store when no loaded manifest declares `phase`.
pub async fn dispatch_phase(
    state: &ServerState,
    phase: &str,
    ctx: &HookContext,
) -> Vec<HookDirective> {
    if !tool_exec::is_available() {
        return Vec::new();
    }
    if !any_manifest_declares(state, phase).await {
        return Vec::new();
    }
    let hooks = collect_enabled_hooks(state).await;
    run_hooks(state, ctx, &hooks, phase).await
}

/// Run `tool_result` hooks as a sequential transform pipeline. The first hook
/// may inspect the real result; every later hook sees the output produced so far.
/// This is separate from [`dispatch_phase`], whose observation semantics return a
/// collection of independent directives.
pub async fn dispatch_tool_result_phase(
    state: &ServerState,
    ctx: &HookContext,
) -> Option<serde_json::Value> {
    if !tool_exec::is_available() || !any_manifest_declares(state, ON_TOOL_RESULT).await {
        return None;
    }
    let hooks = collect_enabled_hooks(state).await;
    let mut current = ctx.tool_output.clone()?;
    let mut transformed = false;

    let mut middleware_ctx = ctx.clone();
    middleware_ctx.tool_output = Some(current.clone());
    if let HookDirective::Transform { output } =
        run_middleware_chain(state, &hooks, ON_TOOL_RESULT, &middleware_ctx).await
    {
        current = output;
        transformed = true;
    }

    for hook in hooks {
        if hook.mode != crate::plugin_manifest::HookMode::Directive
            || !phase_matches(&hook.on, ON_TOOL_RESULT)
        {
            continue;
        }
        let mut hook_ctx = ctx.clone();
        hook_ctx.tool_output = Some(current.clone());
        if !hook_should_run(state, &hook, &hook_ctx).await {
            continue;
        }
        if let HookDirective::Transform { output } = run_hook(state, &hook, &hook_ctx).await {
            current = output;
            transformed = true;
        }
    }
    transformed.then_some(current)
}

/// Process-global hook dispatcher. Installed once at boot (`main.rs`) so code
/// paths that have no [`ServerState`] in scope — the shared tool-dispatch core,
/// the delegation engine, the notification fan-out — can still fire hooks.
/// Mirrors [`crate::plugin_storage::global`].
pub trait HookDispatch: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        phase: &'a str,
        ctx: HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<HookDirective>> + Send + 'a>>;

    fn dispatch_tool_result<'a>(
        &'a self,
        ctx: HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<serde_json::Value>> + Send + 'a>>
    {
        Box::pin(async move {
            self.dispatch(ON_TOOL_RESULT, ctx)
                .await
                .into_iter()
                .find_map(|directive| match directive {
                    HookDirective::Transform { output } => Some(output),
                    _ => None,
                })
        })
    }
}

pub(super) static GLOBAL: std::sync::OnceLock<Arc<dyn HookDispatch>> = std::sync::OnceLock::new();

/// Install the global dispatcher (idempotent; first writer wins).
pub fn set_global(dispatcher: Arc<dyn HookDispatch>) -> bool {
    GLOBAL.set(dispatcher).is_ok()
}

/// Fire the hooks for `phase` through the global dispatcher. Returns an empty vec
/// when no dispatcher is installed (e.g. unit tests) so callers stay fail-open.
/// Awaited callers (`pre_tool_use`) act on the returned directives; detached
/// callers ignore them.
pub async fn dispatch_global(phase: &str, ctx: HookContext) -> Vec<HookDirective> {
    match GLOBAL.get() {
        Some(d) => d.dispatch(phase, ctx).await,
        None => Vec::new(),
    }
}

/// Run the global tool-result transform pipeline. No dispatcher means no
/// rewrite, preserving the fail-open behavior used by every hook phase.
pub async fn dispatch_global_tool_result(ctx: HookContext) -> Option<serde_json::Value> {
    match GLOBAL.get() {
        Some(dispatcher) => dispatcher.dispatch_tool_result(ctx).await,
        None => None,
    }
}

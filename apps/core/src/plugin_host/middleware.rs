//! Middleware hooks and the Core-owned `next` continuation.

use super::*;

/// The continuation exposed to a middleware hook. It stays inside Core: the
/// sandbox can ask to continue, but it never receives another plugin's bridge or
/// source code.
pub(super) type MiddlewareNext =
    Arc<dyn Fn(HookContext) -> Pin<Box<dyn Future<Output = HookDirective> + Send>> + Send + Sync>;

/// Request-owned fields that a middleware hook may observe but must not rewrite
/// for the next plugin. In particular, `caller_user_id` is the tenant boundary
/// used by the host bridge's namespaced storage.
#[derive(Clone)]
pub(super) struct MiddlewareIdentity {
    pub(super) agent_id: Option<String>,
    pub(super) caller_user_id: Option<String>,
    pub(super) conversation_id: Option<String>,
    pub(super) flags: std::collections::HashMap<String, bool>,
    pub(super) verified_caller: Option<crate::identity_verify::VerifiedCaller>,
}

impl From<&HookContext> for MiddlewareIdentity {
    fn from(ctx: &HookContext) -> Self {
        Self {
            agent_id: ctx.agent_id.clone(),
            caller_user_id: ctx.caller_user_id.clone(),
            conversation_id: ctx.conversation_id.clone(),
            flags: ctx.flags.clone(),
            verified_caller: ctx.verified_caller.clone(),
        }
    }
}

pub(super) fn preserve_middleware_identity(
    identity: &MiddlewareIdentity,
    mut ctx: HookContext,
) -> HookContext {
    ctx.agent_id = identity.agent_id.clone();
    ctx.caller_user_id = identity.caller_user_id.clone();
    ctx.conversation_id = identity.conversation_id.clone();
    ctx.flags = identity.flags.clone();
    ctx.verified_caller = identity.verified_caller.clone();
    ctx
}

pub(super) enum MiddlewareRun {
    Returned(HookDirective),
    Failed,
}

/// Run the middleware hooks for one phase as an onion. The first hook in the
/// deterministic priority order is the outermost layer. A skipped gate and a
/// failed hook route around that layer; an explicit return without `next` owns
/// the result, matching the Koa-style semantics the function-hook pattern is
/// designed for.
pub(super) async fn run_middleware_chain(
    state: &ServerState,
    hooks: &[HookPlugin],
    phase: &str,
    ctx: &HookContext,
) -> HookDirective {
    if !hooks.iter().any(|hook| {
        hook.mode == crate::plugin_manifest::HookMode::Middleware && phase_matches(&hook.on, phase)
    }) {
        return HookDirective::None;
    }
    let hooks = Arc::new(hooks.to_vec());
    run_middleware_at(
        state.clone(),
        hooks,
        phase.to_owned(),
        0,
        Arc::new(MiddlewareIdentity::from(ctx)),
        ctx.clone(),
    )
    .await
}

pub(super) fn run_middleware_at(
    state: ServerState,
    hooks: Arc<Vec<HookPlugin>>,
    phase: String,
    start: usize,
    identity: Arc<MiddlewareIdentity>,
    ctx: HookContext,
) -> Pin<Box<dyn Future<Output = HookDirective> + Send>> {
    Box::pin(async move {
        let Some(index) = (start..hooks.len()).find(|index| {
            let hook = &hooks[*index];
            hook.mode == crate::plugin_manifest::HookMode::Middleware
                && phase_matches(&hook.on, &phase)
        }) else {
            return HookDirective::None;
        };
        let hook = hooks[index].clone();
        if !hook_should_run(&state, &hook, &ctx).await {
            return run_middleware_at(state, hooks, phase, index + 1, identity, ctx).await;
        }

        let next_state = state.clone();
        let next_hooks = hooks.clone();
        let next_phase = phase.clone();
        let next_identity = identity.clone();
        let next: MiddlewareNext = Arc::new(move |next_ctx| {
            let next_ctx = preserve_middleware_identity(&next_identity, next_ctx);
            run_middleware_at(
                next_state.clone(),
                next_hooks.clone(),
                next_phase.clone(),
                index + 1,
                next_identity.clone(),
                next_ctx,
            )
        });

        match run_middleware_hook(&state, &hook, &ctx, next).await {
            MiddlewareRun::Returned(directive) => directive,
            // A broken middleware link must not silence the hooks below it. This is
            // the fail-open equivalent of the normal directive-hook runner.
            MiddlewareRun::Failed => {
                run_middleware_at(state, hooks, phase, index + 1, identity, ctx).await
            }
        }
    })
}

pub(super) fn restrict_hook_grants(
    declared: &HashSet<String>,
    approved: &[String],
) -> HashSet<String> {
    declared
        .iter()
        .filter(|grant| approved.contains(grant))
        .cloned()
        .collect()
}

pub(super) async fn current_hook_grants(
    state: &ServerState,
    hook: &HookPlugin,
) -> Option<HashSet<String>> {
    match state.app_store.get_record(&hook.plugin_id).await {
        Ok(Some(record)) if record.enabled => {
            Some(restrict_hook_grants(&hook.grants, &record.approved_grants))
        }
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(plugin = %hook.plugin_id, %error, "plugin_host: could not verify current hook grants");
            None
        }
    }
}

pub(super) async fn run_middleware_hook(
    state: &ServerState,
    hook: &HookPlugin,
    ctx: &HookContext,
    next: MiddlewareNext,
) -> MiddlewareRun {
    let Some(_runtime_lease) = state.plugin_runtime.acquire(&hook.plugin_id).await else {
        return MiddlewareRun::Failed;
    };
    let Some(grants) = current_hook_grants(state, hook).await else {
        return MiddlewareRun::Failed;
    };
    let Some(breaker_permit) = breaker::allow(&hook.plugin_id, &hook.hook_id) else {
        return MiddlewareRun::Failed;
    };
    let locale = crate::i18n::locale::node_locale().await;
    let program = build_middleware_hook_program_in(ctx, &hook.code, locale);
    let bridge = Arc::new(
        PluginHookBridge::new_for_request(
            hook.plugin_id.clone(),
            grants,
            state.clone(),
            ctx.verified_caller.clone(),
            ctx.conversation_id.clone(),
        )
        .with_calling_agent(ctx.agent_id.clone())
        .with_middleware_next(next),
    );
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    let agent_id = ctx
        .agent_id
        .clone()
        .unwrap_or_else(|| "plugin-host".to_string());

    match tool_exec::run_sandboxed_warm(program, invoker, &agent_id, &hook.plugin_id).await {
        ExecOutcome::Completed {
            result: _,
            logs,
            is_error,
            error,
        } if is_error => {
            emit_hook_logs(hook, &logs);
            let error = error.unwrap_or_default();
            tracing::warn!(
                "plugin_host: middleware hook {}::{} errored: {}",
                hook.plugin_id,
                hook.hook_id,
                error
            );
            breaker_permit.record_failure(&error);
            MiddlewareRun::Failed
        }
        ExecOutcome::Completed { result, logs, .. } => {
            emit_hook_logs(hook, &logs);
            breaker_permit.record_success();
            MiddlewareRun::Returned(parse_directive(result.as_ref()))
        }
        ExecOutcome::Paused { .. } => {
            tracing::warn!(
                "plugin_host: middleware hook {}::{} paused (unsupported for hooks); ignoring",
                hook.plugin_id,
                hook.hook_id
            );
            breaker_permit.record_failure("paused (unsupported)");
            MiddlewareRun::Failed
        }
    }
}

/// Run a pre-collected set of hooks for one phase against `ctx`. Lets the
/// chat-path wrapper collect hooks once (cheap gate) and reuse the set across the
/// pre-turn transform and the post-turn continue loop. `phase` is one of
/// [`ON_PRE_USER_TURN`] / [`ON_POST_ASSISTANT_TURN`]; hooks on other boundaries
/// are skipped.
pub async fn run_hooks(
    state: &ServerState,
    ctx: &HookContext,
    hooks: &[HookPlugin],
    phase: &str,
) -> Vec<HookDirective> {
    let mut directives = Vec::new();
    let middleware = run_middleware_chain(state, hooks, phase, ctx).await;
    if !matches!(middleware, HookDirective::None) {
        directives.push(middleware);
    }
    // Directive hooks of one phase are independent plugins, and each run is a
    // separate sandbox process, so they run concurrently: the turn waits for the
    // slowest hook instead of the sum of all of them. `join_all` keeps hook order,
    // so the directives come back exactly as a sequential loop would return them.
    let runs = hooks
        .iter()
        .filter(|hook| {
            hook.mode == crate::plugin_manifest::HookMode::Directive
                && phase_matches(&hook.on, phase)
        })
        .map(|hook| async move {
            // Cheap pre-gate: skip the sandbox spawn when the hook provably can't
            // act this turn. This is what makes pre-installed hooks free on the
            // hot path.
            if hook_should_run(state, hook, ctx).await {
                run_hook(state, hook, ctx).await
            } else {
                HookDirective::None
            }
        });
    directives.extend(
        futures_util::future::join_all(runs)
            .await
            .into_iter()
            .filter(|directive| !matches!(directive, HookDirective::None)),
    );
    directives
}

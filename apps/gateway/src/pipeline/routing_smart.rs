use super::*;

/// Run smart routing for a chat request, rewriting `body["model"]` in place when
/// the configured router picks a different target. Returns `true` if the model
/// was rewritten (so the caller can tell `pre_process` to skip eval/A-B routing
/// and honor the smart choice).
///
/// No-ops (returns `false`) when smart routing is inactive, when a per-agent
/// chat slot override is present (explicit pinning wins over routing), or when
/// the router keeps the original model. Provider failures preserve the original
/// model; security and accounting denials propagate before further dispatch.
pub(super) async fn apply_smart_routing(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<bool, GatewayError> {
    // A pinned per-agent chat slot is an explicit user choice — never override
    // it; an own-supply attempt already resolved its route.
    if ctx.slot_provider.is_some() || ctx.slot_model.is_some() || ctx.own_supply_route.is_some() {
        if let Some(object) = body.as_object_mut() {
            object.remove("ryu_smart_route");
        }
        return Ok(false);
    }

    // Per-agent override (the "both" config scope): Core injects the agent's own
    // `SmartRoutingConfig` as the private `ryu_smart_route` body field. When
    // present it replaces the global router for this request; each distinct
    // config gets one cached ephemeral `SmartRouter` (keyed by a hash of its JSON)
    // so its rule-embedding + per-session caches persist across the agent's turns.
    // The private field is always stripped before the body reaches the provider.
    let per_agent = per_request_smart_router(state, ctx, body)?;
    // Clone the global smart router Arc out of the hot-swap lock so it survives the
    // router `.await` below (PUT /v1/config can swap it concurrently); a per-agent
    // override still wins over the global default.
    let global = state.smart_router();
    // Without Core's request field, fall back to the override the global config
    // stores for this agent (`smart_routing.agent_routes`). That one reaches every
    // gateway-routed agent, ACP agents included, because it is keyed by the
    // trust-bound `ctx.agent_id` rather than injected by Core.
    let per_agent = match per_agent {
        Some(router) => Some(router),
        None => configured_agent_router(state, ctx, global.as_ref())?,
    };
    let base: &dyn crate::router::smart::SmartRouterBackend = match per_agent.as_deref() {
        Some(r) => r,
        None => global.as_ref(),
    };
    // A pool can only narrow a router, so an inactive one stays inactive; skip
    // the restriction work (and its cache entry) entirely.
    if !base.is_active() {
        return Ok(false);
    }

    // Every pool that applies: the running config's own, the global pool as the
    // ceiling when a per-agent override is running instead of it, and the
    // calling agent's pool from the global config. `ctx.agent_id` is already
    // trust-bound (a trusted forwarder's header or a Core-proven agent route),
    // so a caller cannot pick another agent's pool. A target must sit inside
    // all of them.
    let mut pools: Vec<crate::config::RoutePool> = Vec::new();
    pools.extend(base.config().map(crate::config::SmartRoutingConfig::pool));
    if per_agent.is_some() {
        pools.extend(global.config().map(crate::config::SmartRoutingConfig::pool));
    }
    if let (Some(agent_id), Some(config)) = (ctx.agent_id.as_deref(), global.config()) {
        pools.extend(config.agent_pools.get(agent_id).cloned());
    }
    pools.retain(|pool| !pool.is_unrestricted());
    let snapshot = provider_snapshot(state, ctx);
    let in_pool = |model: &str| {
        let provider = snapshot.router.route(model).provider;
        pools
            .iter()
            .all(|pool| pool.allows(model, provider.as_str()))
    };

    let restricted = match base.config() {
        Some(config) if !pools.is_empty() => Some(pool_restricted_router(
            state,
            ctx,
            &config.restricted_to(&in_pool),
        )?),
        _ => None,
    };
    let router: &dyn crate::router::smart::SmartRouterBackend = match restricted.as_deref() {
        Some(r) => r,
        None => base,
    };

    if !router.is_active() {
        return Ok(false);
    }

    let inference =
        auxiliary::GovernedInference::new(Arc::clone(state), ctx.clone(), "smart-routing");
    let chosen = router
        .resolve(&body["messages"], ctx.session_id.as_deref(), &inference)
        .await?;

    let Some(model) = chosen else {
        return Ok(false);
    };

    let current = body["model"].as_str().unwrap_or("");
    if model == current {
        return Ok(false);
    }
    // The restricted config already keeps choices inside the pool; this re-check
    // covers backends without a config and keeps the guarantee local.
    if !pools.is_empty() && !in_pool(&model) {
        debug!(
            request_id = %ctx.request_id,
            to = %model,
            "smart routing: selected model is outside the routing pool; keeping requested model"
        );
        return Ok(false);
    }

    debug!(
        request_id = %ctx.request_id,
        from = current,
        to = %model,
        "smart routing: re-routed request to selected model"
    );
    body["model"] = Value::String(model);
    Ok(true)
}

/// Extract and strip the private `ryu_smart_route` per-agent override from the
/// request body, returning a cached ephemeral [`SmartRouter`] for it.
///
/// The field is ALWAYS removed from `body` (so it never reaches a provider), even
/// for callers without Core's trusted-forwarder authority. Authorized overrides
/// are size-limited and cached in a bounded LRU, scoped to the effective caller policy.
pub(super) fn per_request_smart_router(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<Option<Arc<crate::router::smart::SmartRouter>>, GatewayError> {
    let Some(raw) = body
        .as_object_mut()
        .and_then(|body| body.remove("ryu_smart_route"))
    else {
        return Ok(None);
    };
    // This internal configuration channel belongs to Core, never ordinary inference callers.
    if !ctx.is_master_key
        && !ctx
            .key_config
            .as_ref()
            .is_some_and(|key| key.trusted_forwarder)
    {
        return Ok(None);
    }
    let json =
        serde_json::to_vec(&raw).map_err(|error| GatewayError::BadRequest(error.to_string()))?;
    if json.len() > 65_536 {
        return Err(GatewayError::BadRequest(
            "routing override exceeds 64 KiB".into(),
        ));
    }
    let cfg: crate::config::SmartRoutingConfig =
        serde_json::from_value(raw).map_err(|error| GatewayError::BadRequest(error.to_string()))?;
    auxiliary::validate_config(&cfg)?;
    if !cfg.is_active() {
        return Ok(Some(Arc::new(crate::router::smart::SmartRouter::new(cfg))));
    }
    use sha2::Digest;
    let key = format!(
        "{}:{:x}",
        auxiliary::scope(state, ctx),
        Sha256::digest(&json)
    );
    Ok(Some(
        state.per_agent_routers.get_or_insert_with(key, || {
            Arc::new(crate::router::smart::SmartRouter::new(cfg))
        }),
    ))
}

/// The cached router for the calling agent's stored override in the global
/// config (`smart_routing.agent_routes[ctx.agent_id]`), if it has one. Shares
/// the per-agent router cache, keyed by the override's hash, so its rule
/// embeddings and per-session decisions persist across the agent's turns.
pub(super) fn configured_agent_router(
    state: &AppState,
    ctx: &RequestContext,
    global: &dyn crate::router::smart::SmartRouterBackend,
) -> Result<Option<Arc<crate::router::smart::SmartRouter>>, GatewayError> {
    let Some(agent_id) = ctx.agent_id.as_deref() else {
        return Ok(None);
    };
    let Some(config) = global
        .config()
        .and_then(|config| config.agent_routes.get(agent_id))
    else {
        return Ok(None);
    };
    let mut config = config.clone();
    config.agent_pools.clear();
    config.agent_routes.clear();
    use sha2::Digest;
    let json =
        serde_json::to_vec(&config).map_err(|error| GatewayError::BadRequest(error.to_string()))?;
    let key = format!(
        "agent:{}:{:x}",
        auxiliary::scope(state, ctx),
        Sha256::digest(&json)
    );
    Ok(Some(
        state.per_agent_routers.get_or_insert_with(key, || {
            Arc::new(crate::router::smart::SmartRouter::new(config))
        }),
    ))
}

/// A cached router for a pool-restricted config. Shares the per-agent router
/// cache (keyed by the restricted config's hash in the caller-policy scope), so
/// rule embeddings and per-session decisions persist across an agent's turns
/// and a hot-swapped global config naturally gets a fresh entry.
pub(super) fn pool_restricted_router(
    state: &AppState,
    ctx: &RequestContext,
    config: &crate::config::SmartRoutingConfig,
) -> Result<Arc<crate::router::smart::SmartRouter>, GatewayError> {
    use sha2::Digest;
    let json =
        serde_json::to_vec(config).map_err(|error| GatewayError::BadRequest(error.to_string()))?;
    let key = format!(
        "pool:{}:{:x}",
        auxiliary::scope(state, ctx),
        Sha256::digest(&json)
    );
    Ok(state.per_agent_routers.get_or_insert_with(key, || {
        Arc::new(crate::router::smart::SmartRouter::new(config.clone()))
    }))
}

// ─── Anthropic betas (the private `ryu_anthropic_beta` body field) ────────────

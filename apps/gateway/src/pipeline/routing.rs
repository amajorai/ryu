//! Request routing helpers: admission, the provider snapshot a request is
//! bound to, cache scopes, provider pools and the chat fallback chain.

use super::*;

/// Account bindings are scoped to the tenant and verified caller. A session id
/// alone must not collide or consume another caller's conversation capacity.
/// Owner binding for a Core-scoped inference bearer: a fingerprint of the
/// length-prefixed scope identity, so no two distinct scopes collide and none
/// collides with a fingerprint of a raw key.
pub(super) fn scoped_inference_owner_binding(scope: &ryu_gw_credentials::InferenceScope) -> String {
    let field = |value: Option<&str>| {
        value.map_or_else(
            || "-".to_owned(),
            |value| format!("{}:{value}", value.len()),
        )
    };
    // The signed provider list is part of the scope: a limited and an unlimited
    // bearer for one agent never share stored responses or cache entries. The
    // list is sorted and each id length-prefixed; `-` is "no limit", which is
    // different from an empty list ("no provider").
    let provider_access = scope.provider_access.as_ref().map_or_else(
        || "-".to_owned(),
        |ids| {
            let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            ids.sort_unstable();
            ids.dedup();
            let ids: String = ids.iter().map(|id| format!("{}:{id},", id.len())).collect();
            format!("[{ids}]")
        },
    );
    ryu_gw_credentials::fingerprint(&format!(
        "gws1-scope\0{}\0{}\0{}\0{provider_access}",
        field(Some(&scope.agent_id)),
        field(scope.user_id.as_deref()),
        field(scope.session_id.as_deref()),
    ))
}

pub(super) fn account_affinity(ctx: &RequestContext, body: &Value) -> Option<String> {
    let session = ctx
        .session_id
        .as_deref()
        .or_else(|| body.get("prompt_cache_key").and_then(Value::as_str))
        .or_else(|| body.get("conversation_id").and_then(Value::as_str))
        .or_else(|| body.get("sessionId").and_then(Value::as_str))
        .filter(|id| !id.is_empty() && id.len() <= 256)?;
    let org = ctx.org_id.as_deref().unwrap_or_default();
    let caller = ctx.user_id.as_deref().unwrap_or(&ctx.owner_binding);
    let scope = format!("{}:{org}{}:{caller}", org.len(), caller.len());
    Some(format!("{}:{scope}{session}", scope.len()))
}

pub(super) fn provider_snapshot(
    state: &AppState,
    ctx: &RequestContext,
) -> Arc<crate::providers::ProviderSnapshot> {
    ctx.provider_snapshot
        .clone()
        .unwrap_or_else(|| state.provider_runtime.snapshot())
}

/// Request admission (pipeline steps 1 + 2), shared by every inference route:
/// the per-key requests-per-minute ceiling, then the org request ceiling, then
/// the per-key burst bucket, each consumed only when the previous one admitted
/// the request. A per-key refusal names its policy (`Retry-After` plus the IETF
/// `RateLimit` / `RateLimit-Policy` headers); an org refusal stays bare.
pub(crate) fn admit_request(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    let key_config = ctx.key_config.as_ref();
    if !state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, key_config)
    {
        return Err(GatewayError::rate_limited(
            state.rate_limiter.request_limit_policy(key_config),
        ));
    }
    crate::org_limits::check_request(state, ctx)?;
    if !state.rate_limiter.check_burst(&ctx.api_key) {
        return Err(GatewayError::rate_limited(
            state.rate_limiter.burst_limit_policy(),
        ));
    }
    Ok(())
}

/// The refusing policy's name for a rate-limit log line (`org` when bare).
pub(super) fn rate_limit_policy_name(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::RateLimitedBy(limit) => limit.policy,
        _ => "org",
    }
}

pub(super) fn capture_provider_snapshot(state: &AppState, ctx: &mut RequestContext) {
    if ctx.provider_snapshot.is_none() {
        ctx.provider_snapshot = Some(state.provider_runtime.snapshot());
    }
}

/// The cache tenant: the org, narrowed to the caller's user when one is known.
/// Members of one org must not receive each other's cached responses, and the
/// user id here is only ever a verified or trusted-forwarder identity (dynamic
/// tenants accept it only from a verified JWT). JSON framing keeps an org-only
/// tenant distinct from every `(org, user)` pair.
pub(super) fn cache_tenant(ctx: &RequestContext) -> Option<String> {
    match (ctx.org_id.as_deref(), ctx.user_id.as_deref()) {
        (org, Some(user)) => Some(serde_json::json!(["user", org, user]).to_string()),
        (Some(org), None) => Some(org.to_owned()),
        (None, None) => None,
    }
}

pub(super) fn provider_cache_scope<'a>(
    state: &AppState,
    ctx: &'a RequestContext,
    tenant: Option<&'a str>,
    provider: &'a str,
    model: &'a str,
) -> crate::cache::CacheScope<'a> {
    let snapshot = provider_snapshot(state, ctx);
    let epoch =
        crate::cache::CacheEpoch::new(*snapshot.epoch.boot.as_bytes(), snapshot.epoch.sequence);
    // Partition by credential as well as tenant: two static keys with no org (or
    // two credentials of one org) must not confirm or read each other's prompts
    // and answers through a shared entry.
    crate::cache::CacheScope::new(epoch, tenant, provider, model).with_caller(&ctx.owner_binding)
}

/// The embedding-cache scope and cacheable request shape for an embeddings
/// call, or `None` when it must bypass the cache: the cache is off, the
/// operation is a rerank, node routing pins the upstream, the bound route
/// forbids response caching, or the body is not cacheable (token-array inputs,
/// `user`, unknown `encoding_format`). The scope is the same tenant + caller +
/// provider + model + provider-epoch namespace the response caches use.
pub(super) fn embedding_cache_slot(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
    body: &Value,
    operation: EmbeddingOperation,
) -> Option<(String, ryu_gw_cache::EmbeddingRequest)> {
    if !matches!(operation, EmbeddingOperation::Embed)
        || state.embedding_cache.is_none()
        || ctx.node_routing.is_some()
    {
        return None;
    }
    let route = bind_route(state, ctx, decision).ok()?;
    if !route.cache_allowed {
        return None;
    }
    let request = ryu_gw_cache::EmbeddingRequest::from_body(body)?;
    let tenant = cache_tenant(ctx);
    let scope = provider_cache_scope(
        state,
        ctx,
        tenant.as_deref(),
        route.provider_id.as_str(),
        &route.model,
    )
    .semantic_scope();
    Some((scope, request))
}

pub(super) fn provider_circuit_key(
    state: &AppState,
    ctx: &RequestContext,
    provider: &str,
) -> String {
    provider_snapshot(state, ctx).epoch.circuit_key(provider)
}

/// Bind one routed decision to the request's captured provider generation.
/// Callers keep the returned provider, region, cache eligibility, and epoch
/// together through governance and dispatch rather than independently reading
/// the mutable runtime state.
pub(super) fn bind_route(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
) -> Result<crate::providers::BoundRoute, GatewayError> {
    provider_snapshot(state, ctx).bind(decision)
}

pub(super) fn bound_circuit_key(route: &crate::providers::BoundRoute) -> String {
    route.epoch.circuit_key(route.provider_id.as_str())
}

pub(super) fn canonical_sdk_provider(
    state: &AppState,
    ctx: &RequestContext,
    provider: &ProviderId,
    model: &str,
) -> Result<ProviderId, GatewayError> {
    if ryu_gw_credentials::sdk_provider_by_id(provider.as_str()).is_none() {
        return Ok(provider.clone());
    }
    provider_snapshot(&state, &ctx)
        .providers
        .canonicalize_sdk_route(provider.as_str(), model)
        .map(ProviderId::from)
        .ok_or_else(|| {
            GatewayError::BadRequest(
                "SDK connection is inactive or the model belongs to a different provider".into(),
            )
        })
}
pub(super) fn canonicalize_sdk_decision(
    state: &AppState,
    ctx: &RequestContext,
    decision: &mut RouteDecision,
) -> Result<(), GatewayError> {
    decision.provider = canonical_sdk_provider(state, ctx, &decision.provider, &decision.model)?;
    Ok(())
}
pub(super) async fn resolve_provider_pool(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    decision: &mut RouteDecision,
) -> Result<Option<crate::provider_pools::SelectedPoolRoute>, GatewayError> {
    let affinity = account_affinity(ctx, body);
    let facts = pool_signals::scoped_request_facts(state, ctx, body);
    let signals = pool_signals::member_facts(state, ctx, &facts);
    let mut route = provider_snapshot(&state, &ctx)
        .provider_pools
        .select_wait_with_facts(
            decision.provider.as_str(),
            affinity.as_deref(),
            &facts,
            |id, model| {
                let Ok(provider) = canonical_sdk_provider(state, ctx, &ProviderId::from(id), model)
                else {
                    return false;
                };
                provider_snapshot(&state, &ctx)
                    .providers
                    .get_owned(provider.as_str())
                    .is_some()
                    && !state.circuit_breaker.is_open(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.as_str(),
                    ))
                    && inference_governance::authorize_provider_region(state, ctx, &provider)
                        .is_ok()
            },
            |member| {
                signals
                    .get(&(member.provider.clone(), member.model.clone()))
                    .cloned()
                    .unwrap_or_default()
            },
        )
        .await
        .map_err(GatewayError::AllProvidersUnavailable)?;
    if let Some(selected) = route.as_mut() {
        selected.provider =
            canonical_sdk_provider(state, ctx, &selected.provider, &selected.model)?;
        for candidate in &mut selected.fallback_candidates {
            candidate.provider =
                canonical_sdk_provider(state, ctx, &candidate.provider, &candidate.model)?;
        }
        decision.provider = selected.provider.clone();
        decision.model.clone_from(&selected.model);
    }
    Ok(route)
}

pub(super) fn reconcile_pool_after_budget(
    decision: &RouteDecision,
    route: &mut Option<crate::provider_pools::SelectedPoolRoute>,
) -> Result<(), GatewayError> {
    if route.as_ref().is_some_and(|selected| {
        selected.provider != decision.provider || selected.model != decision.model
    }) {
        *route = None;
    }
    if decision.provider.as_str().starts_with("pool:") {
        return Err(GatewayError::AllProvidersUnavailable(
            "budget downgrade resolved to a provider pool after admission".to_owned(),
        ));
    }
    Ok(())
}

pub(super) struct ChatAttemptRoute {
    pub(super) decision: RouteDecision,
    pub(super) pool: Option<crate::provider_pools::SelectedPoolRoute>,
}

/// Append a context-relay pool's handoff to `messages`, after screening it
/// (P0-4). The handoff carries the previous target's answer, which no inbound
/// screen has read.
pub(super) fn apply_pool_relay(
    state: &AppState,
    ctx: &RequestContext,
    route: Option<&crate::provider_pools::SelectedPoolRoute>,
    body: &mut Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let Some(route) = route else {
        return Ok(None);
    };
    let Some(session) = account_affinity(ctx, body) else {
        return Ok(None);
    };
    let scope_session = format!("{}:{}", auxiliary::scope(state, ctx), session);
    let handoff = provider_snapshot(state, ctx)
        .provider_pools
        .relay_messages(route, &scope_session);
    if handoff.is_empty() {
        return Ok(None);
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let handoff = Value::Array(handoff);
    let alert = edit_rescan::screen_edit_audited(
        state,
        ctx,
        edit_rescan::EditSite::PoolRelay,
        &handoff,
        model,
        start,
    )?;
    if let Value::Array(handoff) = handoff {
        messages.extend(handoff);
    }
    Ok(alert)
}

pub(super) fn chat_attempt_routes(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
    selected_pool: Option<&crate::provider_pools::SelectedPoolRoute>,
) -> Vec<ChatAttemptRoute> {
    if let Some(selected) = selected_pool {
        let mut attempts = Vec::with_capacity(1 + selected.fallback_candidates.len());
        attempts.push(ChatAttemptRoute {
            decision: decision.clone(),
            pool: Some(selected.clone()),
        });
        for candidate in &selected.fallback_candidates {
            attempts.push(ChatAttemptRoute {
                decision: RouteDecision {
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                },
                pool: Some(crate::provider_pools::SelectedPoolRoute {
                    pool_name: selected.pool_name.clone(),
                    member_index: candidate.member_index,
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                    fallback_candidates: Vec::new(),
                    execution: None,
                }),
            });
        }
        return attempts;
    }
    clamped_fallback_chain(state, ctx, decision)
        .into_iter()
        .map(|provider| ChatAttemptRoute {
            decision: RouteDecision {
                provider,
                model: decision.model.clone(),
            },
            pool: None,
        })
        .collect()
}

pub(super) fn restore_token_ceiling(body: &mut Value, key: &str, original: Option<&Value>) {
    let Some(map) = body.as_object_mut() else {
        return;
    };
    if let Some(value) = original {
        map.insert(key.to_owned(), value.clone());
    } else {
        map.remove(key);
    }
}

//! Own-supply routing for Ryu Router picks, route authorization, and the
//! masks that keep Ryu-operated slots out of what a managed caller sees.

use super::*;

/// [`own_supply::SupplyView`] over this request's captured provider generation
/// and policy.
pub(super) struct RequestSupply<'a> {
    state: &'a AppState,
    snapshot: Arc<crate::providers::ProviderSnapshot>,
    policy: Option<crate::policy::EffectivePolicy>,
}

impl<'a> RequestSupply<'a> {
    fn new(state: &'a AppState, ctx: &RequestContext) -> Self {
        let policy = (!ctx.is_master_key).then(|| {
            ctx.resolved_policy
                .clone()
                .unwrap_or_else(|| state.policy_snapshot())
        });
        Self {
            state,
            snapshot: provider_snapshot(state, ctx),
            policy,
        }
    }

    fn routes_to_ryu_router(&self, model: &str) -> bool {
        self.snapshot.router.route(model).provider.as_str() == own_supply::RYU_ROUTER_SLOT
    }
}

impl own_supply::SupplyView for RequestSupply<'_> {
    fn table(&self) -> Arc<ryu_gw_router::own_supply::OwnSupplyTable> {
        self.state.own_supply.table()
    }

    fn serves(&self, slot: &str, shown_model: &str) -> bool {
        self.snapshot.providers.get(slot).is_some()
            && self.policy.as_ref().is_none_or(|policy| {
                policy.allows_model(shown_model) && policy.allows_provider(slot)
            })
    }

    fn is_routable(&self, row: &ryu_gw_router::own_supply::OwnSupplyRow) -> bool {
        self.state.own_supply.is_routable(row)
    }

    fn allowance(&self, pool: &str) -> Option<crate::credit_pools::PoolAllowance> {
        self.state.pool_allowances.get(pool)
    }
}

/// The own-supply plan for this request, if it qualifies (see [`own_supply`]).
pub(super) fn own_supply_plan(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
) -> Option<own_supply::OwnSupplyPlan> {
    let requested = body["model"].as_str()?;
    // Ladder L3 takes own-supply vendor slots away (spec 04.8.1): the
    // request stays on the Ryu Router route.
    if crate::enforcement::is_restricted(ctx) {
        return None;
    }
    let supply = RequestSupply::new(state, ctx);
    // Only a managed caller can be planned; skip walking the prompt otherwise.
    let estimated_prompt_tokens = if ctx.managed_inference {
        estimate_prompt_tokens(body)
    } else {
        0
    };
    let plan = own_supply::plan(
        requested,
        supply.routes_to_ryu_router(requested),
        estimated_prompt_tokens,
        ctx,
        &supply,
        chrono::Utc::now(),
    )?;
    info!(
        request_id = %ctx.request_id,
        org_id = ?ctx.org_id,
        slot = %plan.slot,
        basis = plan.basis.as_str(),
        "credits: serving a Ryu Router pick from own supply"
    );
    Some(plan)
}

/// The own-supply attempt: the same body under the id the user sees (for
/// `openrouter/auto`, the pool default's id), dispatched to exactly the plan's
/// `(slot, upstream)` through the gateway-internal route pin.
pub(super) fn own_supply_attempt(
    ctx: &RequestContext,
    body: &Value,
    plan: &own_supply::OwnSupplyPlan,
) -> (RequestContext, Value) {
    let mut attempt_ctx = ctx.clone();
    attempt_ctx.own_supply_route =
        Some((ProviderId::from(plan.slot.as_str()), plan.upstream.clone()));
    let mut routed = body.clone();
    routed["model"] = Value::String(plan.shown_model.clone());
    (attempt_ctx, routed)
}

/// After a failed own-supply attempt: an upstream 404 (model gone) or 401
/// (credential refused) takes the row off this gateway for an hour
/// (`own_supply_table::QUARANTINE_FOR`). A 403 or a safety outcome never does.
pub(super) fn note_own_supply_failure(
    state: &AppState,
    plan: &own_supply::OwnSupplyPlan,
    error: &GatewayError,
) {
    if own_supply::is_row_unavailable(error) {
        state.own_supply.quarantine(&plan.slot, &plan.upstream);
    }
}

/// Authorize the model a route will DISPATCH. When the route is exactly the
/// Ryu alias / pool namespace the client requested (`ryu-code/max` →
/// `anthropic-credits` + `claude-opus-4-5`), the requested id is what the
/// org's allowlist approved at the Policy stage, so the upstream id is not
/// re-checked: approving the alias must be enough, and the upstream id is not
/// something an admin is ever shown. Any other route (a budget downgrade, a
/// fallback to another model) is checked as before.
pub(super) fn authorize_routed_model(
    state: &AppState,
    ctx: &RequestContext,
    requested_model: &str,
    decision: &RouteDecision,
) -> Result<(), GatewayError> {
    // Ladder L3 first: an alias or own-supply route the org approved is
    // still refused when it lands on an own-supply vendor slot or a model
    // off the floor's restricted list.
    crate::enforcement::authorize_route(
        state,
        ctx,
        decision.provider.as_str(),
        decision.model.as_str(),
    )?;
    let routed = (decision.provider.as_str(), decision.model.as_str());
    let is_requested_pool_route = ryu_gw_router::pool_model_alias_route(requested_model)
        == Some(routed)
        || ryu_gw_router::pool_namespace_route(requested_model) == Some(routed)
        // The own-supply plan's route serves exactly the id the user picked.
        || ctx
            .own_supply_route
            .as_ref()
            .is_some_and(|(slot, upstream)| (slot.as_str(), upstream.as_str()) == routed);
    if is_requested_pool_route {
        return Ok(());
    }
    auxiliary::authorize_model(state, ctx, &decision.model)
}

/// `x-degraded: fallback:<slot>` must not name a Ryu-operated slot to a
/// managed caller; it reads `fallback:ryu` instead. Operators keep the slot.
pub(super) fn mask_degraded(degraded: &mut Option<DegradedMode>, managed: bool) {
    if !managed {
        return;
    }
    if let Some(DegradedMode::Fallback(provider)) = degraded {
        if crate::credit_pools::is_ryu_router_slot(provider) {
            *provider = model_alias::ALIAS_PROVIDER_LABEL.to_owned();
        }
    }
}

/// `x-provider` for a managed caller: work any Ryu-operated slot served (own
/// supply or the OpenRouter pass-through) reads as Ryu Router (`ryu`).
pub(super) fn mask_provider_used(provider_used: &mut &'static str, managed: bool) {
    if managed && crate::credit_pools::is_ryu_router_slot(provider_used) {
        *provider_used = model_alias::ALIAS_PROVIDER_LABEL;
    }
}

/// Show the user's own id on an own-supply error that will not fall back.
pub(super) fn mask_own_supply_error(
    error: GatewayError,
    plan: &own_supply::OwnSupplyPlan,
    managed: bool,
) -> GatewayError {
    let error = model_alias::mask_model(error, &plan.upstream, &plan.shown_model);
    model_alias::mask_pool_slots(error, managed)
}

//! Governed direct web services: request/document units, never chat model prices.

use std::sync::Arc;
use std::time::Instant;

use ryu_gw_credentials::web::{WebContentFormat, WebOperation, WebProviderKind};
use ryu_gw_providers::web::{WebFetchRequest, WebSearchRequest, WebServiceUsage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{DegradedMode, RequestContext};
use crate::audit::AuditServiceCostSource;
use crate::budget::BudgetDecision;
use crate::config::ApiKeyOperation;
use crate::error::GatewayError;
use crate::policy_alert::PolicyAlert;
use crate::providers::BoundWebRoute;
use crate::state::AppState;
use crate::web_config::{operation_name, WebBinding};

mod billing;
mod inspect;

use billing::{audit, measured_cost, reserve, settle};
pub(crate) use billing::{budget, managed_ready};
use inspect::{fetch_url_forms, inspect_output};

pub enum WebRequest {
    Search(WebSearchRequest),
    Fetch(WebFetchRequest),
}
impl WebRequest {
    pub fn operation(&self) -> WebOperation {
        match self {
            Self::Search(_) => WebOperation::Search,
            Self::Fetch(_) => WebOperation::Fetch,
        }
    }
    fn format(&self) -> Option<WebContentFormat> {
        match self {
            Self::Search(_) => None,
            Self::Fetch(request) => Some(request.format()),
        }
    }
    /// The texts the inbound screens read: the search query, or the fetch URL
    /// as written and percent-decoded (see [`fetch_url_forms`]).
    fn screened_texts(&self) -> Vec<String> {
        match self {
            Self::Search(request) => vec![request.query().to_owned()],
            Self::Fetch(request) => fetch_url_forms(request.url().as_str()),
        }
    }
}

pub struct WebPipelineOutput {
    pub response: Value,
    pub context: RequestContext,
    pub provider: &'static str,
    pub degraded: Option<DegradedMode>,
    pub policy_alert: Option<PolicyAlert>,
    pub budget: Option<BudgetDecision>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}

fn affinity(ctx: &RequestContext, operation: WebOperation) -> String {
    let fields = [
        ctx.owner_binding.as_str(),
        ctx.org_id.as_deref().unwrap_or_default(),
        ctx.agent_id.as_deref().unwrap_or_default(),
        ctx.session_id.as_deref().unwrap_or_default(),
        operation_name(operation),
    ];
    let mut hash = Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("web:{:x}", hash.finalize())
}

fn authorize(
    state: &AppState,
    ctx: &RequestContext,
    route: &BoundWebRoute,
) -> Result<(), GatewayError> {
    if ctx.is_master_key {
        return Ok(());
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    if !policy.allows_provider(route.kind.descriptor().provider_id) {
        return Err(GatewayError::PolicyViolation(
            "Web provider is not approved".into(),
        ));
    }
    if !policy.allows_region(route.region.as_deref()) {
        return Err(GatewayError::PolicyViolation(
            "Web provider region is not approved".into(),
        ));
    }
    Ok(())
}

/// Wallet-billed searches honor the org's `products.web_search` feature control.
/// BYOK, static-key and master-key traffic is never billed, so it is unaffected.
fn hosted_search_allowed(
    ctx: &RequestContext,
    operation: WebOperation,
) -> Result<(), GatewayError> {
    if operation != WebOperation::Search || ctx.is_master_key || !ctx.managed_inference {
        return Ok(());
    }
    if ctx
        .resolved_policy
        .as_ref()
        .is_some_and(|policy| !policy.hosted_web_search_enabled)
    {
        return Err(GatewayError::PolicyViolation(
            "Hosted web search is disabled for this organization".into(),
        ));
    }
    Ok(())
}

pub async fn run(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut request: WebRequest,
    explicit: Option<WebProviderKind>,
) -> Result<WebPipelineOutput, GatewayError> {
    let operation = request.operation();
    let required = match operation {
        WebOperation::Search => ApiKeyOperation::WebSearch,
        WebOperation::Fetch => ApiKeyOperation::WebFetch,
    };
    if ctx.authorized_operation != required {
        return Err(GatewayError::Unauthorized(
            "Web operation is not authorized".into(),
        ));
    }
    hosted_search_allowed(&ctx, operation)?;
    super::capture_provider_snapshot(&state, &mut ctx);
    super::admit_request(&state, &ctx)?;
    let budget = budget(&state, &ctx)?;
    let policy_alert = request.inspect(&state, &ctx)?.or_else(|| {
        budget.as_ref().map(|decision| {
            PolicyAlert::from_budget_decision(
                decision,
                decision.alert,
                ctx.org_id.as_deref().unwrap_or_default(),
            )
        })
    });
    let snapshot = super::provider_snapshot(&state, &ctx);
    let binding = explicit
        .map(|provider| WebBinding::Provider { provider })
        .or_else(|| snapshot.routing.web.binding(operation).cloned())
        .ok_or_else(|| {
            GatewayError::AllProvidersUnavailable("Web service binding is not configured".into())
        })?;
    let session = affinity(&ctx, operation);
    let clock = now();
    let format = request.format();
    snapshot
        .web_pools
        .validate_binding(&binding, operation)
        .map_err(GatewayError::BadRequest)?;
    if let WebBinding::Provider { provider } = &binding {
        let route = snapshot.bind_web(*provider, operation, format, clock)?;
        authorize(&state, &ctx, &route)?;
    }
    let selected = snapshot
        .web_pools
        .candidates(&binding, operation, Some(&session), |kind| {
            snapshot
                .bind_web(kind, operation, format, clock)
                .ok()
                .is_some_and(|route| {
                    authorize(&state, &ctx, &route).is_ok()
                        && (!ctx.managed_inference || ctx.is_master_key || route.price.is_some())
                        && !state
                            .circuit_breaker
                            .is_open(&route.epoch.circuit_key(kind.descriptor().provider_id))
                })
        })
        .map_err(GatewayError::BadRequest)?;
    let bound = selected
        .iter()
        .map(|selected| snapshot.bind_web(selected.provider, operation, format, clock))
        .collect::<Result<Vec<_>, _>>()?;
    if bound.is_empty() {
        return Err(GatewayError::AllProvidersUnavailable(
            "No eligible web service provider".into(),
        ));
    }
    let permit = reserve(&state, &ctx, &bound)?;
    let mut permit = permit;
    let start = Instant::now();
    let mut last = None;
    for (index, (selected, route)) in selected.iter().zip(bound.iter()).enumerate() {
        authorize(&state, &ctx, route)?;
        let _admission = state
            .admission
            .acquire_for(
                route.kind.descriptor().provider_id,
                ctx.priority,
                ctx.org_id.as_deref(),
            )
            .await
            .map_err(|_| GatewayError::Overloaded("Web service is busy".into()))?;
        state
            .metrics
            .inc_provider_request(route.kind.descriptor().provider_id);
        let result=match &request {
            WebRequest::Search(request)=>route.provider.web_search_for_session(request,Some(&session)).await.map(|response|(json!({"object":"web.search","provider":route.kind.descriptor().provider_id,"results":response.results}),response.usage)),
            WebRequest::Fetch(request)=>route.provider.web_fetch_for_session(request,Some(&session)).await.map(|response|(json!({"object":"web.fetch","provider":route.kind.descriptor().provider_id,"results":response.results}),response.usage)),
        };
        match result {
            Ok((mut response, usage)) => {
                if usage.requests != 1
                    || usage.documents > 1
                    || (operation == WebOperation::Search && usage.documents != 0)
                {
                    if ctx.managed_inference {
                        if let Some(org) = &ctx.org_id {
                            state.wallet.set_org_accounting_unavailable(org, true);
                        }
                    }
                    audit(
                        &state,
                        &ctx,
                        route,
                        &WebServiceUsage::default(),
                        AuditServiceCostSource::Unsettled,
                        true,
                        Some("unknown_cost"),
                        start,
                    )?;
                    return Err(GatewayError::AccountingUnavailable);
                }
                let cost = match measured_cost(route, &usage) {
                    Ok(cost) => cost,
                    Err(error) => {
                        if ctx.managed_inference {
                            if let Some(org) = &ctx.org_id {
                                state.wallet.set_org_accounting_unavailable(org, true);
                            }
                        }
                        audit(
                            &state,
                            &ctx,
                            route,
                            &usage,
                            AuditServiceCostSource::Unsettled,
                            true,
                            Some("unknown_cost"),
                            start,
                        )?;
                        return Err(error);
                    }
                };
                let inspection = inspect_output(&state, &ctx, &mut response);
                let audited = audit(
                    &state,
                    &ctx,
                    route,
                    &usage,
                    cost.source,
                    cost.estimated,
                    inspection.as_ref().err().map(|_| "service_request_failed"),
                    start,
                );
                settle(&state, &ctx, route, &cost, permit.take(), start);
                if audited.is_err() {
                    if ctx.managed_inference {
                        if let Some(org) = &ctx.org_id {
                            state.wallet.set_org_accounting_unavailable(org, true);
                        }
                    }
                    audited?;
                }
                inspection?;
                response["usage"] = json!({"requests":usage.requests,"documents":usage.documents,"provider_credits":usage.provider_credits,"cost_micro_usd":cost.raw,"estimated":cost.estimated});
                state
                    .circuit_breaker
                    .record_success(&route.epoch.circuit_key(route.kind.descriptor().provider_id));
                snapshot.web_pools.record_success(selected, Some(&session));
                return Ok(WebPipelineOutput {
                    response,
                    context: ctx,
                    provider: route.kind.descriptor().provider_id,
                    degraded: (index > 0).then(|| {
                        DegradedMode::Fallback(route.kind.descriptor().provider_id.to_owned())
                    }),
                    policy_alert,
                    budget,
                });
            }
            Err(error) => {
                let retry = matches!(
                    error,
                    ryu_gw_providers::ProviderError::RateLimited { .. }
                        | ryu_gw_providers::ProviderError::PaymentRequired { .. }
                        | ryu_gw_providers::ProviderError::Transport(_)
                );
                let code = match &error {
                    ryu_gw_providers::ProviderError::RateLimited { retry_after, .. } => {
                        snapshot.web_pools.record_rate_limit(selected, *retry_after);
                        "rate_limited"
                    }
                    ryu_gw_providers::ProviderError::PaymentRequired { .. } => {
                        snapshot.web_pools.record_rate_limit(selected, Some(300));
                        "payment_required"
                    }
                    ryu_gw_providers::ProviderError::DeliveryUncertain(_) => {
                        if ctx.managed_inference {
                            if let Some(org) = &ctx.org_id {
                                state.wallet.set_org_accounting_unavailable(org, true);
                            }
                        }
                        "delivery_uncertain"
                    }
                    ryu_gw_providers::ProviderError::Transport(_) => "transport_unavailable",
                    _ => "upstream_unavailable",
                };
                audit(
                    &state,
                    &ctx,
                    route,
                    &WebServiceUsage::default(),
                    if code == "delivery_uncertain" {
                        AuditServiceCostSource::Unsettled
                    } else {
                        AuditServiceCostSource::Unpriced
                    },
                    true,
                    Some(code),
                    start,
                )?;
                let mapped = GatewayError::from(error);
                if !retry {
                    return Err(mapped);
                }
                last = Some(mapped);
            }
        }
    }
    Err(last.unwrap_or_else(|| {
        GatewayError::AllProvidersUnavailable("No eligible web service provider".into())
    }))
}

#[cfg(test)]
mod survivor_tests;
#[cfg(test)]
mod tests;

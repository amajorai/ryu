//! Spend gates, wallet reservation, cost measurement, audit and settlement for
//! governed web requests.

use std::sync::Arc;
use std::time::Instant;

use ryu_gw_contracts::credit_debit::CreditDebitReason;
use ryu_gw_credentials::web::WebOperation;
use ryu_gw_providers::web::WebServiceUsage;

use super::super::RequestContext;
use crate::audit::{AuditRecord, AuditServiceCostSource, AuditServiceUsage, EventType};
use crate::budget::{BudgetAction, BudgetChargeKind, BudgetDecision, CreditReservation};
use crate::error::GatewayError;
use crate::policy_alert::PolicyAlert;
use crate::providers::BoundWebRoute;
use crate::state::AppState;
use crate::web_config::operation_name;

/// The Tools-kind spend gate: user/agent and session budgets plus the org, team
/// and member limits. A non-`Notify` decision refuses the call; a `Notify` one is
/// returned for the caller to surface. Shared with managed provider calls
/// (`POST /v1/providers/call`), which run the same gate before any vendor I/O.
pub(crate) fn budget(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<Option<BudgetDecision>, GatewayError> {
    if ctx.is_master_key {
        return Ok(None);
    }
    if state.shared_budget.is_shared_exceeded() {
        return Err(GatewayError::BudgetExceeded(None));
    }
    if let Some(error) = super::super::spend_store_gate(state, ctx) {
        return Err(error);
    }
    let decisions = state.with_budget(|budget| {
        [
            budget.evaluate_charge(
                ctx.user_id.as_deref(),
                ctx.agent_id.as_deref(),
                BudgetChargeKind::Tools,
            ),
            budget.evaluate_session_charge(ctx.session_id.as_deref(), BudgetChargeKind::Tools),
        ]
    });
    let [user, session] = decisions;
    let limits = crate::org_limits::evaluate_for(state, ctx).decision;
    let decision = super::super::most_severe(super::super::most_severe(user, session), limits);
    if decision
        .as_ref()
        .is_some_and(|decision| decision.action != BudgetAction::Notify)
    {
        return Err(GatewayError::BudgetExceeded(decision.as_ref().map(
            |decision| {
                PolicyAlert::from_budget_decision(
                    decision,
                    decision.alert,
                    ctx.org_id.as_deref().unwrap_or_default(),
                )
            },
        )));
    }
    Ok(decision)
}

pub(super) fn reserve(
    state: &AppState,
    ctx: &RequestContext,
    routes: &[BoundWebRoute],
) -> Result<Option<CreditReservation>, GatewayError> {
    if ctx.is_master_key || !ctx.managed_inference {
        return Ok(None);
    }
    if !state.config.credits.is_active() || !state.config.credits.reserve_enabled {
        return Err(GatewayError::AccountingUnavailable);
    }
    let org = ctx
        .org_id
        .as_deref()
        .filter(|org| !org.is_empty())
        .ok_or(GatewayError::AccountingUnavailable)?;
    if ctx.credit_accounting_unavailable || state.wallet.is_org_accounting_unavailable(org) {
        return Err(GatewayError::AccountingUnavailable);
    }
    let maximum = routes
        .iter()
        .map(|route| {
            route
                .price
                .and_then(|price| price.reservation())
                .ok_or(GatewayError::AccountingUnavailable)
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .ok_or(GatewayError::AccountingUnavailable)?;
    let headroom = ctx
        .unrestricted_budget_micro_usd
        .ok_or(GatewayError::AccountingUnavailable)?;
    state
        .wallet
        .try_reserve(org, maximum, headroom)
        .map(Some)
        .ok_or(GatewayError::InsufficientCredits)
}

pub(crate) fn managed_ready(state: &AppState, ctx: &RequestContext, route: &BoundWebRoute) -> bool {
    if ctx.is_master_key || !ctx.managed_inference {
        return true;
    }
    let (Some(org), Some(amount), Some(headroom)) = (
        ctx.org_id.as_deref().filter(|org| !org.is_empty()),
        route.price.and_then(|price| price.reservation()),
        ctx.unrestricted_budget_micro_usd,
    ) else {
        return false;
    };
    state.config.credits.is_active()
        && state.config.credits.reserve_enabled
        && !state.wallet.is_org_accounting_unavailable(org)
        && headroom >= amount
}

pub(super) struct Cost {
    pub(super) raw: Option<u64>,
    pub(super) charged: Option<u64>,
    pub(super) source: AuditServiceCostSource,
    pub(super) estimated: bool,
}
pub(super) fn measured_cost(
    route: &BoundWebRoute,
    usage: &WebServiceUsage,
) -> Result<Cost, GatewayError> {
    let Some(price) = route.price else {
        return Ok(Cost {
            raw: None,
            charged: None,
            source: AuditServiceCostSource::Unpriced,
            estimated: true,
        });
    };
    if let Some(raw) = usage.reported_cost_micro_usd {
        let charged = price
            .charged_reported(raw)
            .and_then(|amount| u64::try_from(amount).ok())
            .ok_or(GatewayError::AccountingUnavailable)?;
        Ok(Cost {
            raw: Some(raw),
            charged: Some(charged),
            source: AuditServiceCostSource::ProviderReported,
            estimated: usage.cost_is_estimate,
        })
    } else {
        let raw = price.price.fallback_micro_usd_per_call;
        let charged = price
            .price
            .charged(raw, price.markup_bps)
            .and_then(|amount| u64::try_from(amount).ok())
            .ok_or(GatewayError::AccountingUnavailable)?;
        Ok(Cost {
            raw: Some(raw),
            charged: Some(charged),
            source: AuditServiceCostSource::ConfiguredEstimate,
            estimated: true,
        })
    }
}

pub(super) fn audit(
    state: &AppState,
    ctx: &RequestContext,
    route: &BoundWebRoute,
    usage: &WebServiceUsage,
    source: AuditServiceCostSource,
    estimated: bool,
    error: Option<&str>,
    start: Instant,
) -> Result<(), GatewayError> {
    state
        .log_audit_service(
            AuditRecord {
                request_id: ctx.request_id.clone(),
                api_key: ctx.api_key.clone(),
                user_name: ctx.user_name.clone(),
                org_id: ctx.org_id.clone(),
                team_id: ctx.team_id.clone(),
                team_ids: ctx.audit_team_ids(),
                key_id: ctx.key_id(),
                project_id: ctx.project_id.clone(),
                provider: route.kind.descriptor().provider_id.to_owned(),
                model: String::new(),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: None,
                cache_write_tokens: None,
                prompt_cache_outcome: None,
                prompt_cache_read_tokens: None,
                prompt_cache_write_tokens: None,
                cache_write_1h_tokens: None,
                cache_hit: false,
                latency_ms: start.elapsed().as_millis() as u64,
                eval_score: None,
                error: error.map(str::to_owned),
                skill_ids: None,
                session_id: ctx.session_id.clone(),
                user_id: ctx.user_id.clone(),
                agent_id: ctx.agent_id.clone(),
                feature: Some("web".into()),
                purpose: None,
                managed_inference: ctx.managed_inference,
                provider_cost_micro_usd: if source == AuditServiceCostSource::ProviderReported {
                    usage.reported_cost_micro_usd
                } else {
                    None
                },
                event_type: EventType::ServiceCall,
                backend: None,
                command: Some(format!("web.{}", operation_name(route.operation))),
                duration_ms: None,
                exit_code: None,
                widget_instance_id: None,
            },
            AuditServiceUsage {
                requests: usage.requests,
                documents: usage.documents,
                provider_credits: usage.provider_credits,
                cost_source: source,
                cost_is_estimate: estimated,
            },
        )
        .map_err(|_| GatewayError::AccountingUnavailable)
}

/// The ledger reason and task label for a settled web request. Searches carry
/// their own `web_search` reason so hosted web search shows as a separate usage
/// line, but only when the resolve response says the control plane accepts it:
/// an older control plane rejects an unknown reason, and a rejected debit marks
/// the org's accounting unavailable. Fetches stay with the rest of gateway usage.
pub(super) fn debit_reason(
    ctx: &RequestContext,
    operation: WebOperation,
) -> (CreditDebitReason, &'static str) {
    match operation {
        WebOperation::Search
            if ctx
                .resolved_policy
                .as_ref()
                .is_some_and(|policy| policy.web_search_debit_reason) =>
        {
            (CreditDebitReason::WebSearch, "web_search")
        }
        WebOperation::Search => (CreditDebitReason::GatewayUsage, "web_search"),
        WebOperation::Fetch => (CreditDebitReason::GatewayUsage, "web_fetch"),
    }
}

pub(super) fn settle(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    route: &BoundWebRoute,
    cost: &Cost,
    permit: Option<CreditReservation>,
    start: Instant,
) {
    if let Some(charged) = cost.charged {
        super::super::record_charged_budget_for_ids(
            state,
            ctx.owner_binding.as_str(),
            ctx.org_id.as_deref(),
            ctx.user_id.as_deref(),
            ctx.agent_id.as_deref(),
            ctx.session_id.as_deref(),
            BudgetChargeKind::Tools,
            charged,
            crate::org_limits::subject_for(ctx).as_ref(),
        );
    }
    if ctx.is_master_key || !ctx.managed_inference {
        drop(permit);
        return;
    }
    let (Some(org), Some(raw)) = (ctx.org_id.clone(), cost.raw) else {
        drop(permit);
        return;
    };
    let state = Arc::clone(state);
    let request_id = format!("{}:web:{}", ctx.request_id, operation_name(route.operation));
    let provider = route.kind.descriptor().provider_id.to_owned();
    let estimated = cost.estimated;
    let user = ctx.user_id.clone();
    let tags = crate::org_limits::tags_for(ctx);
    let scope = crate::org_limits::LedgerScope::for_request(ctx);
    let elapsed = start.elapsed().as_millis() as u64;
    let (reason, task_label) = debit_reason(ctx, route.operation);
    tokio::spawn(async move {
        let _permit = permit;
        super::super::debit_wallet_for_request(
            state,
            org,
            request_id,
            reason,
            raw,
            true,
            None,
            None,
            super::super::DebitAttribution {
                provider: Some(provider),
                model: None,
                user_id: user,
                duration_ms: Some(elapsed),
                estimated: Some(estimated),
                task_label: Some(task_label.to_owned()),
                tags,
                scope,
                ..Default::default()
            },
        )
        .await;
    });
}

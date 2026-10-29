//! Governed direct web services: request/document units, never chat model prices.

use std::sync::Arc;
use std::time::Instant;

use ryu_gw_contracts::credit_debit::CreditDebitReason;
use ryu_gw_credentials::web::{WebContentFormat, WebOperation, WebProviderKind};
use ryu_gw_providers::web::{WebFetchRequest, WebSearchRequest, WebServiceUsage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{DegradedMode, RequestContext};
use crate::audit::{AuditRecord, AuditServiceCostSource, AuditServiceUsage, EventType};
use crate::budget::{BudgetAction, BudgetChargeKind, BudgetDecision, CreditReservation};
use crate::config::{ApiKeyOperation, FirewallPolicy};
use crate::error::GatewayError;
use crate::policy_alert::PolicyAlert;
use crate::providers::BoundWebRoute;
use crate::state::AppState;
use crate::web_config::{operation_name, WebBinding};

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
    fn inspect(
        &mut self,
        state: &AppState,
        ctx: &RequestContext,
    ) -> Result<Option<PolicyAlert>, GatewayError> {
        for text in self.screened_texts() {
            super::inference_governance::enforce_locked_guardrails(state, ctx, &text)?;
        }
        let scanner = state.resolved_scanner(ctx);
        if ctx.companion_source {
            match self {
                Self::Search(request) => {
                    let (redacted, _) = scanner.redact_companion_egress(request.query());
                    *request = WebSearchRequest::new(redacted, request.limit()).map_err(|_| {
                        GatewayError::BadRequest(
                            "Web query is invalid after privacy inspection".into(),
                        )
                    })?;
                }
                Self::Fetch(request) => {
                    let private = fetch_url_forms(request.url().as_str()).iter().any(|form| {
                        let (redacted, _) = scanner.redact_companion_egress(form);
                        redacted != *form
                    });
                    if private {
                        return Err(GatewayError::FirewallBlocked(
                            "Web URL contains private context".into(),
                            None,
                        ));
                    }
                }
            }
        }
        let hit = self
            .screened_texts()
            .iter()
            .find_map(|text| scanner.scan_inbound(text));
        if let Some(hit) = hit {
            match scanner.policy() {
                FirewallPolicy::Block => {
                    return Err(GatewayError::FirewallBlocked(
                        format!("Web input blocked: {}", hit.pattern_name),
                        super::firewall_policy_alert(scanner.config(), ctx, "block"),
                    ))
                }
                FirewallPolicy::Sanitize => match self {
                    Self::Search(request) => {
                        *request = WebSearchRequest::new(
                            scanner.sanitize(request.query()),
                            request.limit(),
                        )
                        .map_err(|_| {
                            GatewayError::BadRequest(
                                "Web query is invalid after input inspection".into(),
                            )
                        })?
                    }
                    Self::Fetch(_) => {
                        return Err(GatewayError::FirewallBlocked(
                            "Web URL contains restricted input".into(),
                            super::firewall_policy_alert(scanner.config(), ctx, "block"),
                        ))
                    }
                },
                FirewallPolicy::WarnAndContinue => {
                    return Ok(super::firewall_policy_alert(
                        scanner.config(),
                        ctx,
                        "notify",
                    ))
                }
            }
        }
        Ok(None)
    }
}

/// Rounds of `%XX` decoding applied to a fetch URL, so a double-encoded
/// escape (`%2552`) is screened decoded as well.
const URL_DECODE_ROUNDS: usize = 3;

/// A fetch URL as written, then each distinct percent-decoded form. The target
/// site decodes its URL, so an escaped marker (`%52YU...`) or credential must
/// be screened as the site reads it, not only as written.
fn fetch_url_forms(url: &str) -> Vec<String> {
    let mut forms = vec![url.to_owned()];
    for _ in 0..URL_DECODE_ROUNDS {
        let last = forms.last().map_or(url, String::as_str);
        match super::outbound_text::percent_decoded(last) {
            Some(decoded) if decoded != last => forms.push(decoded),
            _ => break,
        }
    }
    forms
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
    if let Some(error) = super::spend_store_gate(state, ctx) {
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
    let decision = super::most_severe(super::most_severe(user, session), limits);
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

fn reserve(
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

struct Cost {
    raw: Option<u64>,
    charged: Option<u64>,
    source: AuditServiceCostSource,
    estimated: bool,
}
fn measured_cost(route: &BoundWebRoute, usage: &WebServiceUsage) -> Result<Cost, GatewayError> {
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

fn audit(
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
fn debit_reason(
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

fn settle(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    route: &BoundWebRoute,
    cost: &Cost,
    permit: Option<CreditReservation>,
    start: Instant,
) {
    if let Some(charged) = cost.charged {
        super::record_charged_budget_for_ids(
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
    let elapsed = start.elapsed().as_millis() as u64;
    let (reason, task_label) = debit_reason(ctx, route.operation);
    tokio::spawn(async move {
        let _permit = permit;
        super::debit_wallet_for_request(
            state,
            org,
            request_id,
            reason,
            raw,
            true,
            None,
            None,
            super::DebitAttribution {
                provider: Some(provider),
                model: None,
                user_id: user,
                duration_ms: Some(elapsed),
                estimated: Some(estimated),
                task_label: Some(task_label.to_owned()),
                tags,
                ..Default::default()
            },
        )
        .await;
    });
}

fn inspect_output(
    state: &AppState,
    ctx: &RequestContext,
    output: &mut Value,
) -> Result<(), GatewayError> {
    let scanner = state.resolved_scanner(ctx);
    let Some(results) = output.get_mut("results").and_then(Value::as_array_mut) else {
        return Err(GatewayError::ProviderDeliveryUncertain(
            "Invalid normalized web response".into(),
        ));
    };
    for result in results {
        for field in ["title", "snippet", "content", "url"] {
            let Some(text) = result.get(field).and_then(Value::as_str) else {
                continue;
            };
            if let Some(hit) = scanner.scan_outbound(text) {
                match scanner.policy() {
                    FirewallPolicy::Block => {
                        return Err(GatewayError::FirewallBlocked(
                            format!("Web output blocked: {}", hit.pattern_name),
                            super::firewall_policy_alert(scanner.config(), ctx, "block"),
                        ))
                    }
                    FirewallPolicy::Sanitize => {
                        if field == "url" {
                            return Err(GatewayError::FirewallBlocked(
                                "Web result URL contains restricted output".into(),
                                super::firewall_policy_alert(scanner.config(), ctx, "block"),
                            ));
                        }
                        result[field] = Value::String(scanner.sanitize(text));
                    }
                    FirewallPolicy::WarnAndContinue => {}
                }
            }
        }
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
mod tests {
    use super::*;
    use ryu_gw_providers::web::{WebSearchOutput, WebSearchResult};
    use ryu_gw_providers::{Provider, ProviderError};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn fetch_url_forms_decode_each_escape_round_once() {
        assert_eq!(
            fetch_url_forms("https://example.com/docs?q=rust"),
            ["https://example.com/docs?q=rust"]
        );
        assert_eq!(
            fetch_url_forms("https://example.com/?k=AKIA%2549OSFODNN7EXAMPLE"),
            [
                "https://example.com/?k=AKIA%2549OSFODNN7EXAMPLE",
                "https://example.com/?k=AKIA%49OSFODNN7EXAMPLE",
                "https://example.com/?k=AKIAIOSFODNN7EXAMPLE",
            ]
        );
        assert_eq!(
            fetch_url_forms("https://example.com/?p=100%"),
            ["https://example.com/?p=100%"]
        );
    }

    struct Fixture {
        kind: WebProviderKind,
        calls: Arc<AtomicUsize>,
        reported: u64,
        blocked: bool,
        uncertain: bool,
    }
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            self.kind.descriptor().provider_id
        }
        fn web_descriptor(
            &self,
        ) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
            Some(self.kind.descriptor())
        }
        fn complete<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>>
        {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn complete_stream<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn web_search_for_session<'a>(
            &'a self,
            _: &'a WebSearchRequest,
            _: Option<&'a str>,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<WebSearchOutput, ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if self.uncertain {
                    return Err(ProviderError::DeliveryUncertain(
                        "accepted delivery unknown".into(),
                    ));
                }
                Ok(WebSearchOutput {
                    results: vec![WebSearchResult {
                        title: None,
                        url: "https://example.com/article".into(),
                        snippet: if self.blocked {
                            "AKIAIOSFODNN7EXAMPLE".into()
                        } else {
                            "readable".into()
                        },
                        score: None,
                    }],
                    usage: WebServiceUsage {
                        requests: 1,
                        reported_cost_micro_usd: Some(self.reported),
                        ..Default::default()
                    },
                })
            })
        }
    }

    fn state(
        base: String,
        reported: u64,
        blocked: bool,
        uncertain: bool,
    ) -> (Arc<AppState>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let mut config = crate::config::GatewayConfig::default();
        config.credits.enabled = true;
        config.credits.base_url = base;
        config.credits.internal_secret = Some("test-ledger-secret".into());
        config.credits.reserve_enabled = true;
        config.providers.web=serde_json::from_value(json!({"tavily":{"mode":"accounts","accounts":[{"api_key":"hidden-key"}]},"brave":{"mode":"accounts","accounts":[{"api_key":"hidden-backup"}]}})).unwrap();
        config.credits.web_service_prices.insert(
            WebProviderKind::Tavily,
            std::collections::HashMap::from([(
                WebOperation::Search,
                crate::web_config::WebServicePrice {
                    reservation_micro_usd_per_call: 10,
                    max_reported_micro_usd_per_call: 8,
                    fallback_micro_usd_per_call: 5,
                },
            )]),
        );
        config.credits.web_service_prices.insert(
            WebProviderKind::Brave,
            std::collections::HashMap::from([(
                WebOperation::Search,
                crate::web_config::WebServicePrice {
                    reservation_micro_usd_per_call: 10,
                    max_reported_micro_usd_per_call: 8,
                    fallback_micro_usd_per_call: 5,
                },
            )]),
        );
        config.routing.web.search = Some(WebBinding::Pool {
            name: "service".into(),
        });
        config.routing.web_pools.insert(
            "service".into(),
            crate::web_config::WebPoolConfig {
                operation: WebOperation::Search,
                strategy: crate::config::ProviderPoolStrategy::Priority,
                members: vec![
                    crate::web_config::WebPoolMemberConfig {
                        provider: WebProviderKind::Tavily,
                        priority: 0,
                        weight: 1,
                        enabled: true,
                    },
                    crate::web_config::WebPoolMemberConfig {
                        provider: WebProviderKind::Brave,
                        priority: 1,
                        weight: 1,
                        enabled: true,
                    },
                ],
            },
        );
        config.firewall.enabled = blocked;
        config.firewall.policy = FirewallPolicy::Block;
        let mut state = AppState::new_for_test(
            config,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let backup = Arc::new(AtomicUsize::new(0));
        state.provider_runtime.register_for_test(Arc::new(Fixture {
            kind: WebProviderKind::Tavily,
            calls: Arc::clone(&calls),
            reported,
            blocked,
            uncertain,
        }));
        state.provider_runtime.register_for_test(Arc::new(Fixture {
            kind: WebProviderKind::Brave,
            calls: Arc::clone(&backup),
            reported: 5,
            blocked: false,
            uncertain: false,
        }));
        (Arc::new(state), calls, backup)
    }
    fn context(state: &AppState) -> RequestContext {
        let mut ctx = super::super::test_support::plain_request_context();
        ctx.authorized_operation = ApiKeyOperation::WebSearch;
        ctx.provider_snapshot = Some(state.provider_runtime.snapshot());
        ctx.managed_inference = true;
        ctx.org_id = Some("org-web".into());
        ctx.remaining_budget_micro_usd = Some(10);
        ctx.unrestricted_budget_micro_usd = Some(10);
        ctx.request_id = "web-financial-test".into();
        ctx
    }
    fn request() -> WebRequest {
        WebRequest::Search(WebSearchRequest::new("ordinary query".into(), 1).unwrap())
    }

    #[tokio::test]
    async fn accepted_blocked_output_settles_once_without_fallback_or_model_attribution() {
        use axum::{routing::post, Json, Router};
        let calls = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let observed = Arc::clone(&calls);
        let app = Router::new().route(
            "/api/credits/debit",
            post(move |Json(body): Json<Value>| {
                let observed = Arc::clone(&observed);
                async move {
                    let valid = body["reason"] == "web_search"
                        && body["amountMicroUsd"].as_u64().is_some_and(|amount| {
                            amount > 0
                                && amount <= crate::web_config::WEB_DEBIT_WIRE_LIMIT_MICRO_USD
                        });
                    observed.lock().await.push(body);
                    let status = if valid {
                        axum::http::StatusCode::OK
                    } else {
                        axum::http::StatusCode::BAD_REQUEST
                    };
                    (status, Json(json!({"balanceMicroUsd":4})))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (state, primary, backup) = state(base, 6, true, false);
        let mut ctx = context(&state);
        // This control plane advertises the dedicated `web_search` debit reason.
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            web_search_debit_reason: true,
            ..Default::default()
        });
        assert!(matches!(
            run(Arc::clone(&state), ctx, request(), None).await,
            Err(GatewayError::FirewallBlocked(..))
        ));
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if !calls.lock().await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let body = calls.lock().await;
        assert_eq!(body.len(), 1);
        assert_eq!(body[0]["amountMicroUsd"], 6);
        assert_eq!(body[0]["reason"], "web_search");
        assert_eq!(body[0]["taskLabel"], "web_search");
        assert_eq!(body[0]["provider"], "tavily");
        assert!(body[0].get("model").is_none());
        assert!(body[0].get("pool").is_none());
        assert_eq!(body[0]["refId"], "web-financial-test:web:search");
        assert_eq!(primary.load(Ordering::SeqCst), 1);
        assert_eq!(backup.load(Ordering::SeqCst), 0);
        drop(body);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if state.wallet.try_reserve("org-web", 10, 10).is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn excess_reported_cost_and_uncertain_delivery_do_not_replay_or_invent_charge() {
        for (reported, uncertain) in [(9, false), (6, true)] {
            let (state, primary, backup) =
                state("http://127.0.0.1:1".into(), reported, false, uncertain);
            let ctx = context(&state);
            let result = run(Arc::clone(&state), ctx, request(), None).await;
            if uncertain {
                assert!(matches!(
                    result,
                    Err(GatewayError::ProviderDeliveryUncertain(_))
                ));
                assert!(state.wallet.is_org_accounting_unavailable("org-web"));
            } else {
                assert!(matches!(result, Err(GatewayError::AccountingUnavailable)));
                assert!(state.wallet.is_org_accounting_unavailable("org-web"));
            }
            assert_eq!(primary.load(Ordering::SeqCst), 1);
            assert_eq!(backup.load(Ordering::SeqCst), 0);
            assert!(state.wallet.try_reserve("org-web", 10, 10).is_some());
            assert!(matches!(
                run(Arc::clone(&state), context(&state), request(), None).await,
                Err(GatewayError::AccountingUnavailable)
            ));
            assert_eq!(primary.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn org_disabled_hosted_search_denies_managed_traffic_before_vendor_io() {
        let (state, primary, backup) = state("http://127.0.0.1:1".into(), 6, false, false);
        let mut ctx = context(&state);
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            hosted_web_search_enabled: false,
            ..Default::default()
        });
        assert!(matches!(
            run(Arc::clone(&state), ctx, request(), None).await,
            Err(GatewayError::PolicyViolation(_))
        ));
        assert_eq!(primary.load(Ordering::SeqCst), 0);
        assert_eq!(backup.load(Ordering::SeqCst), 0);
        assert!(state.wallet.try_reserve("org-web", 10, 10).is_some());

        // The same toggle never blocks unbilled BYOK traffic.
        let mut byok = context(&state);
        byok.managed_inference = false;
        byok.resolved_policy = Some(crate::policy::EffectivePolicy {
            hosted_web_search_enabled: false,
            ..Default::default()
        });
        assert!(hosted_search_allowed(&byok, WebOperation::Search).is_ok());
    }

    #[test]
    fn web_search_debit_reason_is_sent_only_to_a_control_plane_that_accepts_it() {
        let (state, _, _) = state("http://127.0.0.1:1".into(), 6, false, false);
        let mut ctx = context(&state);
        // No resolved policy, or one from a control plane that predates the
        // reason: debit as `gateway_usage` so the debit is never rejected.
        ctx.resolved_policy = None;
        assert_eq!(
            debit_reason(&ctx, WebOperation::Search),
            (CreditDebitReason::GatewayUsage, "web_search")
        );
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy::default());
        assert_eq!(
            debit_reason(&ctx, WebOperation::Search),
            (CreditDebitReason::GatewayUsage, "web_search")
        );
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            web_search_debit_reason: true,
            ..Default::default()
        });
        assert_eq!(
            debit_reason(&ctx, WebOperation::Search),
            (CreditDebitReason::WebSearch, "web_search")
        );
        assert_eq!(
            debit_reason(&ctx, WebOperation::Fetch),
            (CreditDebitReason::GatewayUsage, "web_fetch")
        );
    }

    #[test]
    fn maximum_pool_reservation_not_sum_and_byok_never_claims_wallet() {
        let (state, _, _) = state("http://127.0.0.1:1".into(), 6, false, false);
        let mut ctx = context(&state);
        let snapshot = state.provider_runtime.snapshot();
        let routes = vec![
            snapshot
                .bind_web(WebProviderKind::Tavily, WebOperation::Search, None, 0)
                .unwrap(),
            snapshot
                .bind_web(WebProviderKind::Brave, WebOperation::Search, None, 0)
                .unwrap(),
        ];
        let mut legacy = ctx.clone();
        legacy.unrestricted_budget_micro_usd = None;
        assert!(matches!(
            reserve(&state, &legacy, &routes),
            Err(GatewayError::AccountingUnavailable)
        ));
        assert!(!managed_ready(&state, &legacy, &routes[0]));
        let held = reserve(&state, &ctx, &routes).unwrap().unwrap();
        assert_eq!(held.amount_micro_usd(), 10);
        assert!(state.wallet.try_reserve("org-web", 1, 10).is_none());
        drop(held);
        ctx.managed_inference = false;
        assert!(reserve(&state, &ctx, &routes).unwrap().is_none());
        assert!(state.wallet.try_reserve("org-web", 10, 10).is_some());
    }

    #[test]
    fn sensitive_result_url_is_blocked_without_creating_a_broken_success_url() {
        let (state, _, _) = state("http://127.0.0.1:1".into(), 6, true, false);
        let ctx = context(&state);
        let url = "https://example.com/path/AKIAIOSFODNN7EXAMPLE";
        let mut output = json!({"results":[{"title":"safe","snippet":"safe","url":url}]});
        assert!(matches!(
            inspect_output(&state, &ctx, &mut output),
            Err(GatewayError::FirewallBlocked(..))
        ));
        let mut firewall = state.config.firewall.clone();
        firewall.policy = FirewallPolicy::Sanitize;
        state.update_firewall_config(firewall);
        assert!(matches!(
            inspect_output(&state, &ctx, &mut output),
            Err(GatewayError::FirewallBlocked(..))
        ));
        assert_eq!(output["results"][0]["url"], url);
    }
}

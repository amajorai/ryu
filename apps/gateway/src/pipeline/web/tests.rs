//! Financial and firewall tests for governed web requests.

use super::billing::debit_reason;
use super::*;
use crate::config::FirewallPolicy;
use ryu_gw_contracts::credit_debit::CreditDebitReason;
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
    fn web_descriptor(&self) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
        Some(self.kind.descriptor())
    }
    fn complete<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
    }
    fn complete_stream<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
    }
    fn web_search_for_session<'a>(
        &'a self,
        _: &'a WebSearchRequest,
        _: Option<&'a str>,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<WebSearchOutput, ProviderError>> + Send + 'a>,
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

pub(super) fn state(
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
pub(super) fn context(state: &AppState) -> RequestContext {
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
                        amount > 0 && amount <= crate::web_config::WEB_DEBIT_WIRE_LIMIT_MICRO_USD
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

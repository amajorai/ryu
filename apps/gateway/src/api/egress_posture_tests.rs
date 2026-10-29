//! Egress posture detection (F1 to F8). Detection only: every case also
//! checks that nothing is refused because of it.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::{
    audit::AuditLogger,
    config::{
        ApiKeyConfig, AuditConfig, CoreProviderConfig, EgressProxyEndpointConfig,
        EgressProxyPoolConfig, GatewayConfig, OpenAiProviderConfig, OpenRouterProviderConfig,
        ProviderId,
    },
    evals::EvalsRunner,
};

const MASTER: &str = "posture-master-secret";
const TENANT: &str = "posture-tenant-key";
const OPENAI_KEY_A: &str = "sk-test-posture-openai-a";
const OPENAI_KEY_B: &str = "sk-test-posture-openai-b";
const OPENROUTER_KEY: &str = "sk-or-test-posture";
/// A proxy endpoint that is configured but never contacted by these tests.
const PROXY_URL: &str = "http://127.0.0.1:9";
const POOL: &str = "rotating";

fn state_with(custody: GatewayCustody, configure: impl FnOnce(&mut GatewayConfig)) -> AppState {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.auth.api_keys = vec![ApiKeyConfig {
        key: TENANT.to_owned(),
        name: "tenant".to_owned(),
        org_id: None,
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: false,
        allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
    }];
    config.cache.enabled = false;
    configure(&mut config);
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = custody;
    state
}

fn two_openai_keys(config: &mut GatewayConfig, base_url: &str) {
    config.providers.openai = Some(OpenAiProviderConfig {
        api_key: OPENAI_KEY_A.to_owned(),
        api_keys: vec![OPENAI_KEY_A.to_owned(), OPENAI_KEY_B.to_owned()],
        base_url: base_url.to_owned(),
    });
}

fn proxy_pool(
    include_direct: bool,
    endpoints: Vec<EgressProxyEndpointConfig>,
) -> EgressProxyPoolConfig {
    EgressProxyPoolConfig {
        include_direct,
        direct_fallback_only: false,
        endpoints,
    }
}

fn proxy_endpoint(id: &str, enabled: bool) -> EgressProxyEndpointConfig {
    EgressProxyEndpointConfig {
        id: id.to_owned(),
        url: PROXY_URL.to_owned(),
        enabled,
        priority: 0,
        username_env: None,
        password_env: None,
    }
}

/// Section 01.11 AT-32: two `openai.api_keys` and an egress pool on
/// `openrouter`.
fn at32_config(config: &mut GatewayConfig, openai_base_url: &str) {
    two_openai_keys(config, openai_base_url);
    config.providers.openrouter = Some(OpenRouterProviderConfig {
        api_key: OPENROUTER_KEY.to_owned(),
        api_keys: Vec::new(),
        base_url: "https://openrouter.invalid/api/v1".to_owned(),
        site_url: "https://ryu.example".to_owned(),
        site_name: "Ryu".to_owned(),
        data_collection: String::new(),
        zdr: false,
        sort: String::new(),
        response_healing: false,
        usage_accounting: true,
        org_api_keys: Default::default(),
    });
    config.egress.pools.insert(
        POOL.to_owned(),
        proxy_pool(false, vec![proxy_endpoint("proxy-a", true)]),
    );
    config
        .egress
        .assignments
        .insert("openrouter".to_owned(), POOL.to_owned());
}

fn item<'a>(report: &'a PostureReport, id: &str) -> &'a PostureItem {
    report
        .items
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id} is listed"))
}

#[test]
fn at32_fleet_lists_f1_and_f3_unreviewed_with_two_flags() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        at32_config(config, "https://openai.invalid/v1");
    });
    let report = report_for(&state);

    assert_eq!(report.active_ids(), vec!["F1", "F3"]);
    assert!(report.flags_enabled);

    let f1 = item(&report, "F1");
    assert_eq!(f1.decision, Some(PostureDecision::Unreviewed));
    assert_eq!(f1.slots.len(), 1);
    assert_eq!(f1.slots[0].provider, "openai");
    assert_eq!(f1.slots[0].accounts, Some(2));

    let f3 = item(&report, "F3");
    assert_eq!(f3.decision, Some(PostureDecision::Unreviewed));
    assert_eq!(f3.slots.len(), 1);
    assert_eq!(f3.slots[0].provider, "openrouter");
    assert_eq!(f3.slots[0].pool.as_deref(), Some(POOL));
    assert_eq!(f3.slots[0].proxy_endpoints, Some(1));

    let flagged: Vec<(&str, &str)> = report
        .flags
        .iter()
        .map(|flag| (flag.id, flag.provider.as_str()))
        .collect();
    assert_eq!(flagged, vec![("F1", "openai"), ("F3", "openrouter")]);
    for flag in &report.flags {
        assert_eq!(flag.event, "egress.posture_flag");
        assert_eq!(flag.category, "abuse.platform");
        assert_eq!(flag.severity, "low");
        assert_eq!(flag.spend, "ryu");
        assert_eq!(flag.decision, PostureDecision::Unreviewed);
        assert!(!flag.strike);
    }

    // The boot log emits exactly the same two events.
    assert_eq!(log_boot_posture(&state), report.flags);
}

#[test]
fn control_off_fleet_lists_the_same_items_without_flags() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let state = state_with(custody, |config| {
            at32_config(config, "https://openai.invalid/v1");
        });
        let report = report_for(&state);
        assert_eq!(report.active_ids(), vec!["F1", "F3"], "{custody:?}");
        assert!(!report.flags_enabled, "{custody:?}");
        assert!(report.flags.is_empty(), "{custody:?}");
        assert!(log_boot_posture(&state).is_empty(), "{custody:?}");
    }
}

#[test]
fn default_gateway_has_nothing_active_and_lists_all_eight_items() {
    for custody in [
        GatewayCustody::Fleet,
        GatewayCustody::ManagedNode,
        GatewayCustody::SelfHosted,
    ] {
        let state = state_with(custody, |_| {});
        let report = report_for(&state);
        let ids: Vec<&str> = report.items.iter().map(|item| item.id).collect();
        assert_eq!(ids, ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"]);
        assert!(report.active_ids().is_empty(), "{custody:?}");
        assert!(report.flags.is_empty(), "{custody:?}");
        for item in &report.items {
            assert_eq!(item.decision, None, "{custody:?} {}", item.id);
            assert!(item.slots.is_empty(), "{custody:?} {}", item.id);
        }
        assert_eq!(item(&report, "F5").status, PostureStatus::OutsideGateway);
        assert_eq!(item(&report, "F7").status, PostureStatus::Deferred);
        assert_eq!(item(&report, "F8").status, PostureStatus::OutsideGateway);
        let fallback = if custody == GatewayCustody::SelfHosted {
            PostureStatus::Inactive
        } else {
            PostureStatus::Resolved
        };
        assert_eq!(item(&report, "F6").status, fallback, "{custody:?}");
    }
}

#[test]
fn single_key_and_direct_only_pool_are_not_flagged() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(OpenAiProviderConfig {
            api_key: OPENAI_KEY_A.to_owned(),
            api_keys: Vec::new(),
            base_url: "https://openai.invalid/v1".to_owned(),
        });
        config
            .egress
            .pools
            .insert(POOL.to_owned(), proxy_pool(true, Vec::new()));
        config
            .egress
            .assignments
            .insert("openai".to_owned(), POOL.to_owned());
    });
    let report = report_for(&state);
    assert!(report.active_ids().is_empty());
    assert!(report.flags.is_empty());
}

#[test]
fn disabled_proxy_endpoints_do_not_count() {
    let state = state_with(GatewayCustody::Fleet, |_| {});
    let snapshot = state.provider_runtime.snapshot();
    let mut egress = EgressConfig::default();
    egress.pools.insert(
        POOL.to_owned(),
        proxy_pool(true, vec![proxy_endpoint("proxy-off", false)]),
    );
    egress
        .assignments
        .insert("openrouter".to_owned(), POOL.to_owned());
    let report = assess(
        GatewayCustody::Fleet,
        &snapshot.providers,
        &snapshot.config,
        &egress,
    );
    assert_eq!(item(&report, "F3").status, PostureStatus::Inactive);

    egress.pools.insert(
        POOL.to_owned(),
        proxy_pool(
            true,
            vec![
                proxy_endpoint("proxy-off", false),
                proxy_endpoint("proxy-on", true),
            ],
        ),
    );
    let report = assess(
        GatewayCustody::Fleet,
        &snapshot.providers,
        &snapshot.config,
        &egress,
    );
    let f3 = item(&report, "F3");
    assert_eq!(f3.status, PostureStatus::Active);
    assert_eq!(f3.slots[0].proxy_endpoints, Some(1));
}

#[test]
fn quota_aware_strategy_on_a_multi_key_provider_is_f2() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        two_openai_keys(config, "https://openai.invalid/v1");
        config
            .providers
            .account_strategies
            .insert("openai".to_owned(), AccountSelectionStrategy::QuotaFirst);
    });
    let report = report_for(&state);
    assert_eq!(report.active_ids(), vec!["F1", "F2"]);
    let f2 = item(&report, "F2");
    assert_eq!(f2.slots[0].provider, "openai");
    assert_eq!(
        f2.slots[0].strategy,
        Some(AccountSelectionStrategy::QuotaFirst)
    );
    assert_eq!(f2.slots[0].accounts, Some(2));
    assert_eq!(report.flags.len(), 2);

    // Round robin is plain rotation (F1), not a quota-aware pool.
    let state = state_with(GatewayCustody::Fleet, |config| {
        two_openai_keys(config, "https://openai.invalid/v1");
        config
            .providers
            .account_strategies
            .insert("openai".to_owned(), AccountSelectionStrategy::RoundRobin);
    });
    assert_eq!(report_for(&state).active_ids(), vec!["F1"]);

    // A quota-aware strategy on a single-account provider moves nothing.
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(OpenAiProviderConfig {
            api_key: OPENAI_KEY_A.to_owned(),
            api_keys: Vec::new(),
            base_url: "https://openai.invalid/v1".to_owned(),
        });
        config
            .providers
            .account_strategies
            .insert("openai".to_owned(), AccountSelectionStrategy::FillFirst);
    });
    assert!(report_for(&state).active_ids().is_empty());
}

#[test]
fn registered_kiro_relay_is_f4() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.core = Some(CoreProviderConfig {
            base_url: "http://127.0.0.1:2049".to_owned(),
            token: Some("core-relay-test-token".to_owned()),
        });
    });
    let report = report_for(&state);
    let f4 = item(&report, "F4");
    assert_eq!(f4.status, PostureStatus::Active);
    let providers: Vec<&str> = f4.slots.iter().map(|slot| slot.provider.as_str()).collect();
    assert_eq!(providers, vec!["kiro"]);
    assert!(report
        .flags
        .iter()
        .any(|flag| flag.id == "F4" && flag.provider == "kiro"));
}

// ── GET /v1/egress/posture ──────────────────────────────────────────────────

fn peer(loopback: bool) -> ConnectInfo<std::net::SocketAddr> {
    let ip = if loopback {
        [127, 0, 0, 1]
    } else {
        [203, 0, 113, 7]
    };
    ConnectInfo(std::net::SocketAddr::from((ip, 40_000)))
}

async fn get_posture(app: &Router, bearer: Option<&str>, loopback: bool) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(Method::GET)
        .uri("/v1/egress/posture")
        .extension(peer(loopback));
    if let Some(key) = bearer {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).expect("request builds"))
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn posture_route_is_admin_only_and_redacts_credentials() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        at32_config(config, "https://openai.invalid/v1");
    });
    let app = crate::api::router(Arc::new(state));

    let (status, text) = get_posture(&app, Some(MASTER), false).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let body: Value = serde_json::from_str(&text).expect("report is JSON");
    assert_eq!(body["custody"], "fleet");
    assert_eq!(body["flags_enabled"], true);
    assert_eq!(body["items"].as_array().map(Vec::len), Some(8));
    assert_eq!(body["items"][0]["id"], "F1");
    assert_eq!(body["items"][0]["status"], "active");
    assert_eq!(body["items"][0]["decision"], "unreviewed");
    assert_eq!(body["items"][4]["status"], "outside_gateway");
    assert_eq!(body["flags"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["flags"][0]["event"], "egress.posture_flag");

    // Counts and names only: no key, account id, proxy URL or host.
    let mut secrets = vec![
        OPENAI_KEY_A.to_owned(),
        OPENAI_KEY_B.to_owned(),
        OPENROUTER_KEY.to_owned(),
        PROXY_URL.to_owned(),
        "127.0.0.1".to_owned(),
    ];
    for (provider, key) in [
        ("openai", OPENAI_KEY_A),
        ("openai", OPENAI_KEY_B),
        ("openrouter", OPENROUTER_KEY),
    ] {
        secrets.push(ryu_gw_credentials::provider_account_id(provider, key));
    }
    for secret in &secrets {
        assert!(!text.contains(secret.as_str()), "report leaks {secret}");
    }

    // A tenant key is not an admin, on loopback or not.
    for loopback in [true, false] {
        let (status, text) = get_posture(&app, Some(TENANT), loopback).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "loopback={loopback} {text}"
        );
        assert!(!text.contains("F1"), "{text}");
    }
    // No credential at all.
    for loopback in [true, false] {
        let (status, text) = get_posture(&app, None, loopback).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "loopback={loopback} {text}"
        );
        assert!(!text.contains("F1"), "{text}");
    }
}

// ── Behaviour unchanged ─────────────────────────────────────────────────────

struct OpenAiUpstream {
    base: String,
    hits: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for OpenAiUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_openai_upstream() -> OpenAiUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock OpenAI binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&hits);
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                Json(json!({
                    "id": "chatcmpl-posture",
                    "object": "chat.completion",
                    "model": "gpt-4o-mini",
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": "ok" },
                        "finish_reason": "stop"
                    }],
                    "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
                }))
            }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("mock OpenAI serves");
    });
    OpenAiUpstream { base, hits, task }
}

#[tokio::test]
async fn at32_flagged_fleet_still_dispatches_chat() {
    let upstream = spawn_openai_upstream().await;
    let base_url = format!("{}/v1", upstream.base);
    let state = state_with(GatewayCustody::Fleet, |config| {
        at32_config(config, &base_url);
        config.routing.default_provider = ProviderId::from("openai");
        config.routing.fallback_chain = vec![];
    });
    assert_eq!(log_boot_posture(&state).len(), 2);
    let app = crate::api::router(Arc::new(state));

    let request = Request::builder()
        .method(Method::POST)
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(true))
        .body(Body::from(
            json!({
                "model": "gpt-4o-mini",
                "messages": [{ "role": "user", "content": "Hi" }]
            })
            .to_string(),
        ))
        .expect("request builds");
    let response = app.oneshot(request).await.expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
}

#[test]
fn report_serializes_without_unused_slot_fields() {
    let slot = PostureSlot::provider("kiro");
    assert_eq!(
        serde_json::to_value(&slot).expect("slot serializes"),
        json!({ "provider": "kiro" })
    );
}

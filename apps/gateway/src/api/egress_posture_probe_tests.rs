//! Coverage probes for the egress posture report (P0-9). These place the
//! flagged features in configuration shapes the first test set did not use:
//! other account scopes, SDK and web accounts, credit slots, mixed proxy
//! pools, a live provider swap, unusual admin request shapes, and the retry,
//! streaming and proxy dispatch paths that must stay unchanged.
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, State},
    http::{HeaderMap as RequestHeaders, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::{
    audit::AuditLogger,
    config::{
        AnthropicProviderConfig, ApiKeyConfig, AuditConfig, CompatibleProviderConfig,
        CoreProviderConfig, EgressProxyEndpointConfig, EgressProxyPoolConfig, GatewayConfig,
        OpenAiProviderConfig, OpenRouterProviderConfig, ProviderId,
    },
    evals::EvalsRunner,
};

const MASTER: &str = "probe-posture-master-secret";
const TENANT: &str = "probe-posture-tenant-key";
const KEY_A: &str = "sk-test-probe-posture-a";
const KEY_B: &str = "sk-test-probe-posture-b";
const POOL: &str = "rotating";

fn base_config() -> GatewayConfig {
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
    config
}

fn state_with(custody: GatewayCustody, configure: impl FnOnce(&mut GatewayConfig)) -> AppState {
    let mut config = base_config();
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

/// The zero-config developer posture: no base auth, no master key, no keys.
fn zero_config(config: &mut GatewayConfig) {
    config.auth.require_auth = false;
    config.auth.master_key = None;
    config.auth.api_keys = Vec::new();
}

fn openai(keys: &[&str], base_url: &str) -> OpenAiProviderConfig {
    OpenAiProviderConfig {
        api_key: keys.first().copied().unwrap_or_default().to_owned(),
        api_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        base_url: base_url.to_owned(),
    }
}

fn anthropic(keys: &[&str]) -> AnthropicProviderConfig {
    AnthropicProviderConfig {
        api_key: keys[0].to_owned(),
        api_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        base_url: "https://anthropic.invalid".to_owned(),
    }
}

fn openrouter(keys: &[&str]) -> OpenRouterProviderConfig {
    OpenRouterProviderConfig {
        api_key: keys[0].to_owned(),
        api_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        base_url: "https://openrouter.invalid/api/v1".to_owned(),
        site_url: "https://ryu.example".to_owned(),
        site_name: "Ryu".to_owned(),
        data_collection: String::new(),
        zdr: false,
        sort: String::new(),
        response_healing: false,
        usage_accounting: true,
        org_api_keys: Default::default(),
    }
}

fn endpoint(id: &str, url: &str, enabled: bool) -> EgressProxyEndpointConfig {
    EgressProxyEndpointConfig {
        id: id.to_owned(),
        url: url.to_owned(),
        enabled,
        priority: 0,
        username_env: None,
        password_env: None,
    }
}

fn pool(
    include_direct: bool,
    direct_fallback_only: bool,
    endpoints: Vec<EgressProxyEndpointConfig>,
) -> EgressProxyPoolConfig {
    EgressProxyPoolConfig {
        include_direct,
        direct_fallback_only,
        endpoints,
    }
}

fn item<'a>(report: &'a PostureReport, id: &str) -> &'a PostureItem {
    report
        .items
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id} is listed"))
}

fn slot<'a>(item: &'a PostureItem, provider: &str) -> &'a PostureSlot {
    item.slots
        .iter()
        .find(|slot| slot.provider == provider)
        .unwrap_or_else(|| panic!("{} has a slot for {provider}: {:?}", item.id, item.slots))
}

fn flagged(report: &PostureReport) -> Vec<(&'static str, String)> {
    report
        .flags
        .iter()
        .map(|flag| (flag.id, flag.provider.clone()))
        .collect()
}

// ── F1 in account scopes the first tests did not reach ─────────────────────

#[test]
fn probe_f1_sdk_gemini_two_keys_is_flagged_under_its_account_scope() {
    // Registered as `genai`, accounted as `gemini`: the descriptor mapping in
    // `account_counts` must still match it.
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.genai = Some(
            serde_json::from_value(json!({"accounts": {"gemini": {
                "api_key": "probe-gemini-a",
                "api_keys": ["probe-gemini-b"]
            }}}))
            .expect("genai config"),
        );
    });
    let report = report_for(&state);
    let f1 = item(&report, "F1");
    assert_eq!(f1.status, PostureStatus::Active, "{report:?}");
    assert_eq!(slot(f1, "gemini").accounts, Some(2));
    assert!(flagged(&report).contains(&("F1", "gemini".to_owned())));
}

#[test]
fn probe_f1_sdk_groq_two_keys_is_flagged() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.genai = Some(
            serde_json::from_value(json!({"accounts": {"groq": {
                "api_key": "probe-groq-a",
                "api_keys": ["probe-groq-b", "probe-groq-c"]
            }}}))
            .expect("genai config"),
        );
    });
    let report = report_for(&state);
    let f1 = item(&report, "F1");
    assert_eq!(f1.status, PostureStatus::Active, "{report:?}");
    assert_eq!(slot(f1, "genai-groq").accounts, Some(3));
}

#[test]
fn probe_f1_web_connection_with_two_accounts_is_flagged() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.web = serde_json::from_value(json!({"tavily": {
            "mode": "accounts",
            "accounts": [{"api_key": "probe-web-a"}, {"api_key": "probe-web-b"}]
        }}))
        .expect("web config");
    });
    let report = report_for(&state);
    let f1 = item(&report, "F1");
    assert_eq!(f1.status, PostureStatus::Active, "{report:?}");
    assert_eq!(slot(f1, "tavily").accounts, Some(2));
    assert!(flagged(&report).contains(&("F1", "tavily".to_owned())));
}

#[test]
fn probe_f1_compatible_provider_with_two_keys_is_flagged() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.compatible.insert(
            "mistral".to_owned(),
            CompatibleProviderConfig {
                api_key: KEY_A.to_owned(),
                api_keys: vec![KEY_B.to_owned()],
                base_url: "https://mistral.invalid/v1".to_owned(),
            },
        );
    });
    let report = report_for(&state);
    let f1 = item(&report, "F1");
    assert_eq!(f1.status, PostureStatus::Active, "{report:?}");
    assert_eq!(slot(f1, "mistral").accounts, Some(2));
}

#[test]
fn probe_f1_native_and_ryu_credit_slots_each_flag_once() {
    // Ryu's own credit slots are the accounts the fleet actually spends.
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.anthropic = Some(anthropic(&[KEY_A, KEY_B]));
        config.providers.openrouter = Some(openrouter(&[KEY_A, KEY_B]));
        config.providers.openai_credits =
            Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
        config.providers.anthropic_credits = Some(anthropic(&[KEY_A, KEY_B]));
    });
    let report = report_for(&state);
    let f1 = item(&report, "F1");
    for provider in [
        "anthropic",
        "openrouter",
        "openai-credits",
        "anthropic-credits",
    ] {
        assert_eq!(slot(f1, provider).accounts, Some(2), "{provider}");
        assert!(
            flagged(&report).contains(&("F1", provider.to_owned())),
            "{provider} flags"
        );
    }
    assert_eq!(report.flags.len(), 4, "{:?}", report.flags);
}

#[test]
fn probe_f1_repeated_key_is_one_account_and_many_keys_are_counted() {
    // Control: the same key listed three times is one account.
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A, KEY_A, KEY_A], "https://openai.invalid/v1"));
    });
    let report = report_for(&state);
    assert!(report.active_ids().is_empty(), "{report:?}");
    assert!(report.flags.is_empty());

    // A long list is counted in full and still yields one flag.
    let keys: Vec<String> = (0..64)
        .map(|index| format!("sk-test-probe-{index}"))
        .collect();
    let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&refs, "https://openai.invalid/v1"));
    });
    let report = report_for(&state);
    assert_eq!(slot(item(&report, "F1"), "openai").accounts, Some(64));
    assert_eq!(flagged(&report), vec![("F1", "openai".to_owned())]);
}

// ── F2 in other scopes and strategies ──────────────────────────────────────

#[test]
fn probe_f2_sdk_scope_and_every_non_round_robin_strategy() {
    for strategy in [
        AccountSelectionStrategy::QuotaFirst,
        AccountSelectionStrategy::FillFirst,
        AccountSelectionStrategy::ResetFirst,
    ] {
        let state = state_with(GatewayCustody::Fleet, |config| {
            config.providers.genai = Some(
                serde_json::from_value(json!({"accounts": {"gemini": {
                    "api_key": "probe-gemini-a",
                    "api_keys": ["probe-gemini-b"]
                }}}))
                .expect("genai config"),
            );
            config
                .providers
                .account_strategies
                .insert("gemini".to_owned(), strategy);
        });
        let report = report_for(&state);
        let f2 = item(&report, "F2");
        assert_eq!(f2.status, PostureStatus::Active, "{strategy:?}");
        assert_eq!(slot(f2, "gemini").strategy, Some(strategy));
        assert!(flagged(&report).contains(&("F2", "gemini".to_owned())));
    }
}

#[test]
fn probe_f2_on_anthropic_with_drain_threshold() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.anthropic = Some(anthropic(&[KEY_A, KEY_B]));
        config
            .providers
            .account_strategies
            .insert("anthropic".to_owned(), AccountSelectionStrategy::FillFirst);
        config
            .providers
            .account_drain_thresholds
            .insert("anthropic".to_owned(), 50);
    });
    let report = report_for(&state);
    assert_eq!(report.active_ids(), vec!["F1", "F2"]);
    assert_eq!(
        slot(item(&report, "F2"), "anthropic").strategy,
        Some(AccountSelectionStrategy::FillFirst)
    );
}

// ── F3 pool shapes ─────────────────────────────────────────────────────────

#[test]
fn probe_f3_mixed_direct_and_proxy_pools_count_only_enabled_proxies() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A], "https://openai.invalid/v1"));
        config.providers.anthropic = Some(anthropic(&[KEY_A]));
        config.egress.pools.insert(
            POOL.to_owned(),
            pool(
                true,
                false,
                vec![
                    endpoint("probe-on-1", "http://proxy-probe.invalid:3128", true),
                    endpoint("probe-off", "http://proxy-probe.invalid:3129", false),
                    endpoint("probe-on-2", "http://proxy-probe.invalid:3130", true),
                ],
            ),
        );
        config.egress.pools.insert(
            "fallback-only".to_owned(),
            pool(
                true,
                true,
                vec![endpoint(
                    "probe-fallback",
                    "http://proxy-probe.invalid:3131",
                    true,
                )],
            ),
        );
        config
            .egress
            .assignments
            .insert("openai".to_owned(), POOL.to_owned());
        config
            .egress
            .assignments
            .insert("anthropic".to_owned(), "fallback-only".to_owned());
    });
    let report = report_for(&state);
    let f3 = item(&report, "F3");
    assert_eq!(f3.status, PostureStatus::Active, "{report:?}");
    let providers: Vec<&str> = f3.slots.iter().map(|slot| slot.provider.as_str()).collect();
    assert_eq!(providers, vec!["anthropic", "openai"]);
    assert_eq!(slot(f3, "openai").proxy_endpoints, Some(2));
    assert_eq!(slot(f3, "anthropic").proxy_endpoints, Some(1));
    assert_eq!(slot(f3, "anthropic").pool.as_deref(), Some("fallback-only"));
    assert_eq!(
        flagged(&report),
        vec![("F3", "anthropic".to_owned()), ("F3", "openai".to_owned())]
    );
}

// ── F4 shapes ──────────────────────────────────────────────────────────────

#[test]
fn probe_f4_qoder_registered_under_its_id_is_listed() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A], "https://openai.invalid/v1"));
    });
    let snapshot = state.provider_runtime.snapshot();
    let mut registry = snapshot.providers.clone_for_test();
    let stand_in = registry.get_owned("openai").expect("openai registered");
    registry.register_as("qoder", stand_in);
    let report = assess(
        GatewayCustody::Fleet,
        &registry,
        &snapshot.config,
        snapshot.egress_config(),
    );
    let f4 = item(&report, "F4");
    assert_eq!(f4.status, PostureStatus::Active);
    assert_eq!(slot(f4, "qoder").provider, "qoder");
    assert!(flagged(&report).contains(&("F4", "qoder".to_owned())));
}

#[test]
fn probe_f4_kiro_on_a_managed_node_is_listed_but_never_flagged() {
    let state = state_with(GatewayCustody::ManagedNode, |config| {
        config.providers.core = Some(CoreProviderConfig {
            base_url: "http://127.0.0.1:2049".to_owned(),
            token: Some("core-relay-probe-token".to_owned()),
        });
    });
    let report = report_for(&state);
    assert_eq!(item(&report, "F4").status, PostureStatus::Active);
    assert!(report.flags.is_empty());
    assert!(log_boot_posture(&state).is_empty());
}

// ── Live provider swap ─────────────────────────────────────────────────────

const PROBE_USER_ENV: &str = "RYU_PROBE_POSTURE_PROXY_USER";
const PROBE_PASS_ENV: &str = "RYU_PROBE_POSTURE_PROXY_PASS";
const PROBE_USER_VALUE: &str = "probe-proxy-user-value";
const PROBE_PASS_VALUE: &str = "probe-proxy-pass-value";

#[tokio::test]
async fn probe_live_swap_shows_new_keys_and_pool_on_get_without_leaking() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A], "https://openai.invalid/v1"));
    });
    assert!(report_for(&state).active_ids().is_empty());

    let previous = state.provider_runtime.snapshot();
    let mut providers = previous.config.clone();
    providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    providers.genai = Some(
        serde_json::from_value(json!({"accounts": {"gemini": {
            "api_key": "probe-swap-gemini-a",
            "api_keys": ["probe-swap-gemini-b"]
        }}}))
        .expect("genai config"),
    );
    providers.web = serde_json::from_value(json!({"tavily": {
        "mode": "accounts",
        "accounts": [{"api_key": "probe-swap-web-a"}, {"api_key": "probe-swap-web-b"}]
    }}))
    .expect("web config");
    let mut egress = EgressConfig::default();
    let mut credentialed = endpoint(
        "probe-credentialed-endpoint",
        "http://proxy-probe.invalid:3128",
        true,
    );
    credentialed.username_env = Some(PROBE_USER_ENV.to_owned());
    credentialed.password_env = Some(PROBE_PASS_ENV.to_owned());
    egress
        .pools
        .insert(POOL.to_owned(), pool(false, false, vec![credentialed]));
    egress
        .assignments
        .insert("openai".to_owned(), POOL.to_owned());
    let environment = BTreeMap::from([
        (PROBE_USER_ENV.to_owned(), PROBE_USER_VALUE.to_owned()),
        (PROBE_PASS_ENV.to_owned(), PROBE_PASS_VALUE.to_owned()),
    ]);
    let candidate = state
        .provider_runtime
        .build_candidate(
            providers,
            previous.routing.clone(),
            egress,
            environment,
            None,
        )
        .expect("candidate builds");
    drop(previous);
    state
        .provider_runtime
        .publish(candidate)
        .expect("candidate publishes");

    let report = report_for(&state);
    assert_eq!(report.active_ids(), vec!["F1", "F3"], "{report:?}");
    let f1 = item(&report, "F1");
    assert_eq!(slot(f1, "openai").accounts, Some(2));
    assert_eq!(slot(f1, "gemini").accounts, Some(2));
    assert_eq!(slot(f1, "tavily").accounts, Some(2));

    let app = crate::api::router(Arc::new(state));
    let (status, text) = get(&app, "/v1/egress/posture", Some(MASTER), false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let body: Value = serde_json::from_str(&text).expect("report is JSON");
    assert_eq!(body["items"][0]["status"], "active");
    assert_eq!(body["items"][2]["status"], "active");

    let mut secrets: Vec<String> = [
        KEY_A,
        KEY_B,
        "probe-swap-gemini-a",
        "probe-swap-gemini-b",
        "probe-swap-web-a",
        "probe-swap-web-b",
        "probe-credentialed-endpoint",
        "proxy-probe.invalid",
        "3128",
        PROBE_USER_ENV,
        PROBE_PASS_ENV,
        PROBE_USER_VALUE,
        PROBE_PASS_VALUE,
    ]
    .iter()
    .map(|value| (*value).to_owned())
    .collect();
    for (scope, key) in [
        ("openai", KEY_A),
        ("openai", KEY_B),
        ("gemini", "probe-swap-gemini-a"),
        ("gemini", "probe-swap-gemini-b"),
    ] {
        secrets.push(ryu_gw_credentials::provider_account_id(scope, key));
    }
    for secret in &secrets {
        assert!(!text.contains(secret.as_str()), "report leaks {secret}");
    }
}

// ── Admin gate request shapes ──────────────────────────────────────────────

fn peer(loopback: bool) -> ConnectInfo<std::net::SocketAddr> {
    let ip = if loopback {
        [127, 0, 0, 1]
    } else {
        [203, 0, 113, 7]
    };
    ConnectInfo(std::net::SocketAddr::from((ip, 40_000)))
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    authorization: Option<&str>,
    loopback: bool,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .extension(peer(loopback));
    if let Some(value) = authorization {
        builder = builder.header("authorization", value);
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::empty()).expect("request builds"))
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn get(
    app: &Router,
    uri: &str,
    bearer: Option<&str>,
    loopback: bool,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let authorization = bearer.map(|key| format!("Bearer {key}"));
    request(
        app,
        Method::GET,
        uri,
        authorization.as_deref(),
        loopback,
        headers,
    )
    .await
}

fn assert_refused(status: StatusCode, text: &str, case: &str) {
    assert_ne!(status, StatusCode::OK, "{case}: {text}");
    assert!(
        !text.contains("\"F1\"") && !text.contains("posture_flag"),
        "{case} leaks the report: {text}"
    );
}

#[tokio::test]
async fn probe_master_key_outside_the_authorization_header_is_refused() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));

    // Control: the master key in the Authorization header is admitted.
    let (status, text) = get(&app, "/v1/egress/posture", Some(MASTER), false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{text}");

    let query_cases = [
        format!("/v1/egress/posture?api_key={MASTER}"),
        format!("/v1/egress/posture?key={MASTER}"),
        format!("/v1/egress/posture?authorization=Bearer%20{MASTER}"),
    ];
    for uri in &query_cases {
        for loopback in [true, false] {
            let (status, text) = get(&app, uri, None, loopback, &[]).await;
            assert_refused(status, &text, &format!("query {uri} loopback={loopback}"));
        }
    }
    for header in [
        "x-api-key",
        "api-key",
        "x-ryu-api-key",
        "proxy-authorization",
    ] {
        for loopback in [true, false] {
            let (status, text) = get(
                &app,
                "/v1/egress/posture",
                None,
                loopback,
                &[(header, MASTER)],
            )
            .await;
            assert_refused(
                status,
                &text,
                &format!("header {header} loopback={loopback}"),
            );
        }
    }
    // A tenant key cannot borrow loopback trust through forwarding headers.
    let forwarded = [
        ("x-forwarded-for", "127.0.0.1"),
        ("x-real-ip", "127.0.0.1"),
        ("forwarded", "for=127.0.0.1"),
        ("host", "localhost"),
    ];
    for (name, value) in forwarded {
        let (status, text) = get(
            &app,
            "/v1/egress/posture",
            Some(TENANT),
            false,
            &[(name, value)],
        )
        .await;
        assert_refused(status, &text, &format!("tenant with {name}"));
    }
}

#[tokio::test]
async fn probe_other_methods_and_paths_do_not_serve_the_report() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));
    for method in [Method::POST, Method::PUT, Method::DELETE] {
        let (status, text) = request(
            &app,
            method.clone(),
            "/v1/egress/posture",
            Some(&format!("Bearer {TENANT}")),
            true,
            &[],
        )
        .await;
        assert_refused(status, &text, &format!("{method}"));
    }
    for uri in [
        "/v1/egress/posture/",
        "/v1/egress/posture?verbose=1",
        "/v1/egress//posture",
        "/v1/EGRESS/posture",
    ] {
        for bearer in [Some(TENANT), None] {
            let (status, text) = get(&app, uri, bearer, false, &[]).await;
            assert_refused(status, &text, &format!("{uri} bearer={bearer:?}"));
        }
    }
}

#[tokio::test]
async fn probe_zero_config_loopback_admin_is_narrow() {
    let state = state_with(GatewayCustody::SelfHosted, |config| {
        zero_config(config);
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));

    // Control: the local developer posture is the one keyless admin.
    let (status, text) = get(&app, "/v1/egress/posture", None, true, &[]).await;
    assert_eq!(status, StatusCode::OK, "{text}");

    let (status, text) = get(&app, "/v1/egress/posture", None, false, &[]).await;
    assert_refused(status, &text, "remote peer");
    let (status, text) = get(
        &app,
        "/v1/egress/posture",
        None,
        false,
        &[("x-forwarded-for", "127.0.0.1")],
    )
    .await;
    assert_refused(status, &text, "remote peer claiming loopback");
    let (status, text) = get(
        &app,
        "/v1/egress/posture",
        None,
        true,
        &[("host", "rebound.example:8080")],
    )
    .await;
    assert_refused(status, &text, "rebound host");
    for site in ["cross-site", "same-site", "same-origin"] {
        let (status, text) = get(
            &app,
            "/v1/egress/posture",
            None,
            true,
            &[("sec-fetch-site", site)],
        )
        .await;
        assert_refused(status, &text, &format!("sec-fetch-site {site}"));
    }
}

#[tokio::test]
async fn probe_zero_config_loopback_is_closed_on_a_fleet_flag_config() {
    let state = state_with(GatewayCustody::Fleet, |config| {
        zero_config(config);
        config.fleet = true;
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));
    let (status, text) = get(&app, "/v1/egress/posture", None, true, &[]).await;
    assert_refused(status, &text, "fleet flag zero-config loopback");
}

/// The self-host compose shape: `RYU_GATEWAY_FLEET=1` with no vault signal
/// loads the fleet flag on a SelfHosted custody. The flag alone still drops
/// loopback admin trust.
#[tokio::test]
async fn probe_zero_config_loopback_is_closed_on_a_self_hosted_fleet_flag() {
    let state = state_with(GatewayCustody::SelfHosted, |config| {
        zero_config(config);
        config.fleet = true;
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));
    let (status, text) = get(&app, "/v1/egress/posture", None, true, &[]).await;
    assert_refused(status, &text, "self-hosted fleet flag zero-config loopback");
}

#[tokio::test]
async fn probe_zero_config_loopback_is_closed_on_env_detected_fleet_custody() {
    // Fleet custody detected from the vault pair or RYU_PROVIDER_VAULT_REQUIRED
    // while `fleet` in gateway.toml stays false.
    let state = state_with(GatewayCustody::Fleet, |config| {
        zero_config(config);
        config.fleet = false;
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], "https://openai.invalid/v1"));
    });
    let app = crate::api::router(Arc::new(state));
    let (status, text) = get(&app, "/v1/egress/posture", None, true, &[]).await;
    assert_refused(
        status,
        &text,
        "env-detected fleet custody zero-config loopback",
    );
}

// ── Behaviour unchanged on retry, streaming, padding and proxy paths ───────

#[derive(Default)]
struct UpstreamLog {
    hits: AtomicUsize,
    rate_limit_first: bool,
    bearers: Mutex<Vec<String>>,
}

struct MockServer {
    base: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn completion() -> Value {
    json!({
        "id": "chatcmpl-probe",
        "object": "chat.completion",
        "model": "gpt-4o-mini",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "ok" },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
    })
}

fn stream_body() -> String {
    let first = json!({
        "id": "chatcmpl-probe",
        "object": "chat.completion.chunk",
        "model": "gpt-4o-mini",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "ok" }, "finish_reason": null }]
    });
    let last = json!({
        "id": "chatcmpl-probe",
        "object": "chat.completion.chunk",
        "model": "gpt-4o-mini",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
    });
    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n")
}

async fn upstream_handler(
    State(log): State<Arc<UpstreamLog>>,
    headers: RequestHeaders,
    Json(body): Json<Value>,
) -> Response {
    let call = log.hits.fetch_add(1, Ordering::SeqCst);
    if let Some(value) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    {
        log.bearers
            .lock()
            .expect("bearer log")
            .push(value.to_owned());
    }
    if log.rate_limit_first && call == 0 {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": { "message": "quota", "type": "rate_limit" } })),
        )
            .into_response();
    }
    if body["stream"] == json!(true) {
        return (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            stream_body(),
        )
            .into_response();
    }
    Json(completion()).into_response()
}

async fn spawn(router: Router) -> MockServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    MockServer { base, task }
}

async fn spawn_upstream(log: Arc<UpstreamLog>) -> MockServer {
    spawn(
        Router::new()
            .route("/v1/chat/completions", post(upstream_handler))
            .with_state(log),
    )
    .await
}

async fn chat(state: AppState, body: Value) -> (StatusCode, String) {
    let app = crate::api::router(Arc::new(state));
    let request = Request::builder()
        .method(Method::POST)
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(true))
        .body(Body::from(body.to_string()))
        .expect("request builds");
    let response = app.oneshot(request).await.expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn flagged_fleet(base_url: &str) -> AppState {
    state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A, KEY_B], base_url));
        config
            .providers
            .account_strategies
            .insert("openai".to_owned(), AccountSelectionStrategy::QuotaFirst);
        config.routing.default_provider = ProviderId::from("openai");
        config.routing.fallback_chain = vec![];
    })
}

#[tokio::test]
async fn probe_flagged_fleet_still_rotates_to_the_second_key_after_a_429() {
    let log = Arc::new(UpstreamLog {
        rate_limit_first: true,
        ..UpstreamLog::default()
    });
    let upstream = spawn_upstream(Arc::clone(&log)).await;
    let state = flagged_fleet(&format!("{}/v1", upstream.base));
    assert_eq!(report_for(&state).active_ids(), vec!["F1", "F2"]);

    let (status, text) = chat(
        state,
        json!({ "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "Hi" }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(log.hits.load(Ordering::SeqCst), 2);
    let bearers = log.bearers.lock().expect("bearer log").clone();
    assert_eq!(bearers.len(), 2);
    assert_ne!(bearers[0], bearers[1], "the retry used the other account");
}

#[tokio::test]
async fn probe_flagged_fleet_streams_once() {
    let log = Arc::new(UpstreamLog::default());
    let upstream = spawn_upstream(Arc::clone(&log)).await;
    let state = flagged_fleet(&format!("{}/v1", upstream.base));
    let (status, text) = chat(
        state,
        json!({
            "model": "gpt-4o-mini",
            "stream": true,
            "messages": [{ "role": "user", "content": "Hi" }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains("data:"), "{text}");
    assert_eq!(log.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn probe_flagged_fleet_dispatches_long_benign_padding_once() {
    let log = Arc::new(UpstreamLog::default());
    let upstream = spawn_upstream(Arc::clone(&log)).await;
    let state = flagged_fleet(&format!("{}/v1", upstream.base));
    let padding = "lorem ipsum dolor sit amet ".repeat(4_000);
    let (status, text) = chat(
        state,
        json!({
            "model": "gpt-4o-mini",
            "messages": [
                { "role": "system", "content": padding },
                { "role": "user", "content": [{ "type": "text", "text": "Hi" }] }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(log.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn probe_flagged_proxy_pool_on_fleet_still_carries_the_request() {
    let proxy_log = Arc::new(UpstreamLog::default());
    let counted = Arc::clone(&proxy_log);
    let proxy = spawn(Router::new().fallback(post(move || {
        let counted = Arc::clone(&counted);
        async move {
            counted.hits.fetch_add(1, Ordering::SeqCst);
            Json(completion())
        }
    })))
    .await;
    let state = state_with(GatewayCustody::Fleet, |config| {
        config.providers.openai = Some(openai(&[KEY_A], "http://unreachable.invalid/v1"));
        config.egress.pools.insert(
            POOL.to_owned(),
            pool(
                false,
                false,
                vec![endpoint("probe-proxy", &proxy.base, true)],
            ),
        );
        config
            .egress
            .assignments
            .insert("openai".to_owned(), POOL.to_owned());
        config.routing.default_provider = ProviderId::from("openai");
        config.routing.fallback_chain = vec![];
    });
    let report = report_for(&state);
    assert_eq!(report.active_ids(), vec!["F3"]);
    assert_eq!(flagged(&report), vec![("F3", "openai".to_owned())]);

    let (status, text) = chat(
        state,
        json!({ "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "Hi" }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(proxy_log.hits.load(Ordering::SeqCst), 1);
}

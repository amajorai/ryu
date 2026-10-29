//! Platform standing: parsing, refusal mapping, the enforcement push and
//! in-flight rechecks (spec 05.5).
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use tower::ServiceExt;

use super::*;
use crate::custody::GatewayCustody;
use crate::policy::ResolveCache;

const SECRET: &str = "push-test-secret";

fn parse(value: Value) -> PlatformStanding {
    PlatformStanding::from_wire(Some(&value))
}

fn standing(state: &str, refuses: &str) -> Value {
    json!({
        "state": state,
        "refuses": refuses,
        "reasonClass": "fraud",
        "until": "2026-11-01T00:00:00.000Z",
        "appealUrl": "https://ryu.example/appeal",
        "enforcementVersion": 0
    })
}

async fn render(error: GatewayError) -> (StatusCode, Value, Option<String>) {
    let response = error.into_response();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), retry_after)
}

// ─── Parsing and mapping ───────────────────────────────────────────────────

#[tokio::test]
async fn every_refusing_state_maps_to_its_catalogue_code_with_the_appeal_link() {
    for (state, refuses, code) in [
        ("org_suspended", "all", "org_suspended"),
        ("org_suspended", "floor_bound", "org_suspended"),
        ("user_banned", "all", "user_banned"),
        ("key_suspended", "all", "key_suspended_abuse"),
    ] {
        let parsed = parse(standing(state, refuses));
        let error = parsed
            .refusal(GatewayCustody::Fleet)
            .unwrap_or_else(|| panic!("{state} must refuse on the fleet"));
        assert!(error.is_safety_outcome(), "{state}");
        assert!(error.ends_hosted_attempt(), "{state}");
        let (status, body, _) = render(error).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{state}");
        assert_eq!(body["error"]["type"], "policy_violation", "{state}");
        assert_eq!(body["error"]["code"], code, "{state}");
        assert_eq!(body["error"]["layer"], "platform", "{state}");
        assert_eq!(body["error"]["remedy"], "appeal", "{state}");
        assert_eq!(
            body["error"]["appeal_url"], "https://ryu.example/appeal",
            "{state}"
        );
        assert_eq!(body["error"]["reason_class"], "fraud", "{state}");
        assert_eq!(
            body["error"]["until"], "2026-11-01T00:00:00.000Z",
            "{state}"
        );
    }
}

#[test]
fn active_and_restricted_serve_on_every_custody() {
    for state in ["active", "restricted"] {
        let parsed = parse(standing(state, "none"));
        assert!(parsed.serves_everything(), "{state}");
        for custody in [
            GatewayCustody::Fleet,
            GatewayCustody::ManagedNode,
            GatewayCustody::SelfHosted,
        ] {
            assert!(parsed.refusal(custody).is_none(), "{state} on {custody:?}");
        }
    }
    // A restricted state is org ladder L3 (see `crate::enforcement`).
    assert_eq!(parse(standing("restricted", "none")).ladder.len(), 1);
    assert!(parse(standing("active", "none")).ladder.is_empty());
}

#[test]
fn a_floor_bound_suspension_refuses_only_on_the_fleet() {
    let parsed = parse(standing("org_suspended", "floor_bound"));
    assert_eq!(parsed.refuses, StandingRefusal::FloorBound);
    assert!(parsed.refusal(GatewayCustody::Fleet).is_some());
    // Managed nodes hold no Ryu keys and self-hosted nodes spend their
    // operator's keys, so BYOK traffic there keeps running.
    assert!(parsed.refusal(GatewayCustody::ManagedNode).is_none());
    assert!(parsed.refusal(GatewayCustody::SelfHosted).is_none());
    // A full suspension refuses everywhere.
    let full = parse(standing("org_suspended", "all"));
    assert!(full.refusal(GatewayCustody::SelfHosted).is_some());
}

#[tokio::test]
async fn standing_unavailable_is_a_retryable_503_on_every_custody() {
    let parsed = parse(standing("standing_unavailable", "all"));
    for custody in [
        GatewayCustody::Fleet,
        GatewayCustody::ManagedNode,
        GatewayCustody::SelfHosted,
    ] {
        let error = parsed.refusal(custody).expect("unavailable refuses");
        assert!(matches!(error, GatewayError::StandingUnavailable));
        assert!(error.is_safety_outcome());
        let (status, body, retry_after) = render(error).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["type"], "service_unavailable");
        assert_eq!(body["error"]["code"], "standing_unavailable");
        assert_eq!(body["error"]["layer"], "platform");
        assert_eq!(retry_after.as_deref(), Some("10"));
    }
}

#[test]
fn a_missing_or_malformed_standing_fails_closed() {
    let unavailable = |standing: &PlatformStanding| {
        standing.refuses == StandingRefusal::All
            && matches!(
                standing.refusal(GatewayCustody::SelfHosted),
                Some(GatewayError::StandingUnavailable)
            )
    };
    assert!(unavailable(&PlatformStanding::from_wire(None)));
    assert!(unavailable(&PlatformStanding::default()));
    for value in [
        Value::Null,
        json!("active"),
        json!([]),
        json!({}),
        json!({ "refuses": "none" }),
        json!({ "state": "suspended_forever", "refuses": "none" }),
        json!({ "state": 3, "refuses": "none" }),
        json!({ "state": "active", "refuses": "none", "enforcementVersion": "7" }),
        json!({ "state": "active", "refuses": "none", "enforcementVersion": -1 }),
        json!({ "state": "active", "refuses": "none", "appealUrl": 4 }),
    ] {
        assert!(unavailable(&parse(value.clone())), "{value}");
    }
    // A known state with an unknown or missing refusal reads as the
    // strictest refusal, which an active standing cannot explain.
    for value in [
        json!({ "state": "active", "refuses": "some" }),
        json!({ "state": "active" }),
        json!({ "state": "active", "refuses": "all" }),
    ] {
        assert!(unavailable(&parse(value.clone())), "{value}");
    }
}

#[test]
fn the_effective_refusal_is_the_stricter_of_state_and_refuses() {
    // A ban that claims to refuse nothing still refuses everything.
    let banned = parse(standing("user_banned", "none"));
    assert_eq!(banned.refuses, StandingRefusal::All);
    assert!(banned.refusal(GatewayCustody::SelfHosted).is_some());
    // An org suspension always refuses at least floor-bound attempts.
    let suspended = parse(standing("org_suspended", "none"));
    assert_eq!(suspended.refuses, StandingRefusal::FloorBound);
    assert!(suspended.refusal(GatewayCustody::Fleet).is_some());
}

#[tokio::test]
async fn optional_fields_default_and_unsafe_links_are_dropped() {
    let parsed = parse(json!({
        "state": "key_suspended",
        "refuses": "all",
        "appealUrl": "javascript:alert(1)",
        "reasonClass": "line\nbreak"
    }));
    assert_eq!(parsed.enforcement_version, 0);
    assert_eq!(parsed.appeal_url, None);
    assert_eq!(parsed.reason_class, None);
    assert_eq!(parsed.until, None);
    let (_, body, _) = render(parsed.refusal(GatewayCustody::Fleet).unwrap()).await;
    assert_eq!(body["error"]["code"], "key_suspended_abuse");
    assert!(body["error"].get("appeal_url").is_none());
}

// ─── Mock control plane ────────────────────────────────────────────────────

/// A control plane that answers `/gateway/resolve` for a fixed set of tokens
/// with whatever standing the test last set, counting every resolve. A token
/// containing `wait` blocks until the gate gets a permit.
#[derive(Clone)]
struct ControlPlane {
    standings: Arc<Mutex<HashMap<&'static str, Value>>>,
    managed_tier_unavailable: Arc<Mutex<bool>>,
    calls: Arc<AtomicUsize>,
    gate: Arc<Semaphore>,
    saw_capability: Arc<AtomicUsize>,
}

/// Token, org, credential id, owner user id.
const TOKENS: &[(&str, &str, &str, &str)] = &[
    ("rgw_alpha", "org_alpha", "cred_alpha", "usr_alpha"),
    ("rgw_alpha_two", "org_alpha", "cred_alpha_two", "usr_other"),
    ("rgw_beta", "org_beta", "cred_beta", "usr_beta"),
    ("rgw_wait_alpha", "org_alpha", "cred_wait", "usr_wait"),
];

impl ControlPlane {
    fn new() -> Self {
        let standings = TOKENS
            .iter()
            .map(|(token, ..)| (*token, standing("active", "none")))
            .collect();
        Self {
            standings: Arc::new(Mutex::new(standings)),
            managed_tier_unavailable: Arc::new(Mutex::new(false)),
            calls: Arc::new(AtomicUsize::new(0)),
            gate: Arc::new(Semaphore::new(0)),
            saw_capability: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn set(&self, token: &'static str, value: Value) {
        self.standings.lock().unwrap().insert(token, value);
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    async fn serve(&self) -> (String, tokio::task::JoinHandle<()>) {
        let plane = self.clone();
        let app = axum::Router::new().route(
            "/api/control-plane/gateway/resolve",
            axum::routing::get(move |headers: axum::http::HeaderMap| {
                let plane = plane.clone();
                async move {
                    plane.calls.fetch_add(1, Ordering::SeqCst);
                    if headers
                        .get(RESOLVE_CAPABILITIES_HEADER)
                        .and_then(|value| value.to_str().ok())
                        == Some(RESOLVE_CAPABILITIES)
                    {
                        plane.saw_capability.fetch_add(1, Ordering::SeqCst);
                    }
                    let key = headers
                        .get("x-gateway-key")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    let Some((token, org, credential, owner)) =
                        TOKENS.iter().find(|(token, ..)| *token == key)
                    else {
                        return StatusCode::UNAUTHORIZED.into_response();
                    };
                    // Read the standing before waiting, like a control plane
                    // whose answer is already in flight.
                    let standing = plane.standings.lock().unwrap()[token].clone();
                    if key.contains("wait") {
                        plane.gate.acquire().await.unwrap().forget();
                    }
                    let managed_tier_unavailable = *plane.managed_tier_unavailable.lock().unwrap();
                    axum::Json(json!({
                        "organization": { "id": org },
                        "credential": {
                            "id": credential,
                            "ownerUserId": owner,
                            "purpose": "gateway_relay",
                            "allowedOperations": ["gateway.inference"]
                        },
                        "managedInference": true,
                        "managedTierUnavailable": managed_tier_unavailable,
                        "remainingBudgetMicroUsd": 1_000_000,
                        "standing": standing
                    }))
                    .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }
}

fn gateway_state(url: String, custody: GatewayCustody) -> Arc<AppState> {
    let mut config = crate::config::GatewayConfig::default();
    config.auth.require_auth = true;
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state.custody = custody;
    state.resolve_cache = Some(ResolveCache::for_test(url, reqwest::Client::new()));
    state.enforcement_push_secret = Some(SECRET.to_owned());
    Arc::new(state)
}

fn cache(state: &AppState) -> &ResolveCache {
    state.resolve_cache.as_ref().unwrap()
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

fn peer() -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 9)))
}

fn push_request(secret: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/enforcement/invalidate")
        .header("content-type", "application/json")
        .extension(peer());
    if let Some(secret) = secret {
        builder = builder.header(INTERNAL_SECRET_HEADER, secret);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

fn chat_request(token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .extension(peer())
        .body(Body::from(
            json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": "hi" }] })
                .to_string(),
        ))
        .unwrap()
}

fn push(org: Option<&str>, user: Option<&str>, version: u64) -> EnforcementPush {
    EnforcementPush {
        org_id: org.map(str::to_owned),
        credential_id: None,
        user_id: user.map(str::to_owned),
        version,
    }
}

// ─── Resolve and admission ─────────────────────────────────────────────────

#[tokio::test]
async fn every_resolve_advertises_the_standing_capability() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    assert_eq!(plane.saw_capability.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn a_refusing_standing_is_refused_at_auth_with_its_code() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    for (state_name, refuses, code) in [
        ("org_suspended", "floor_bound", "org_suspended"),
        ("org_suspended", "all", "org_suspended"),
        ("user_banned", "all", "user_banned"),
        ("key_suspended", "all", "key_suspended_abuse"),
    ] {
        plane.set("rgw_alpha", standing(state_name, refuses));
        let state = gateway_state(url.clone(), GatewayCustody::Fleet);
        let app = crate::api::router(Arc::clone(&state));
        let (status, body) = send(&app, chat_request("rgw_alpha")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{state_name}: {body}");
        assert_eq!(body["error"]["code"], code, "{state_name}");
        assert_eq!(body["error"]["type"], "policy_violation", "{state_name}");
        assert_eq!(
            body["error"]["appeal_url"], "https://ryu.example/appeal",
            "{state_name}"
        );
    }
    // Unreadable standing: a retryable 503, never a 401.
    plane.set(
        "rgw_alpha",
        json!({ "state": "standing_unavailable", "refuses": "all" }),
    );
    let state = gateway_state(url.clone(), GatewayCustody::Fleet);
    let app = crate::api::router(Arc::clone(&state));
    let (status, body) = send(&app, chat_request("rgw_alpha")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "standing_unavailable");
    server.abort();
}

#[tokio::test]
async fn a_floor_bound_suspension_passes_auth_off_the_fleet() {
    let plane = ControlPlane::new();
    plane.set("rgw_alpha", standing("org_suspended", "floor_bound"));
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::SelfHosted);
    let app = crate::api::router(Arc::clone(&state));
    let (status, body) = send(&app, chat_request("rgw_alpha")).await;
    // The request goes on to routing (no provider is configured here), so it
    // is not refused for standing.
    assert_ne!(body["error"]["code"], "org_suspended", "{status}: {body}");
    assert_ne!(status, StatusCode::FORBIDDEN, "{body}");
    server.abort();
}

#[tokio::test]
async fn an_unreadable_managed_tier_fails_closed_on_the_fleet_only() {
    let plane = ControlPlane::new();
    *plane.managed_tier_unavailable.lock().unwrap() = true;
    let (url, server) = plane.serve().await;
    let fleet = gateway_state(url.clone(), GatewayCustody::Fleet);
    let resolved = cache(&fleet).resolve_cached("rgw_alpha").await.unwrap();
    assert!(matches!(
        admit_resolved(&resolved, GatewayCustody::Fleet),
        Err(GatewayError::AccountingUnavailable)
    ));
    assert!(admit_resolved(&resolved, GatewayCustody::SelfHosted).is_ok());
    // The fleet replica refuses at auth even when it does not bill tenants.
    assert!(!fleet.config.credits.is_active());
    let app = crate::api::router(Arc::clone(&fleet));
    let (status, body) = send(&app, chat_request("rgw_alpha")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "credit_accounting_unavailable");
    // Standing is decided first: a banned key sees its ban, not the outage.
    plane.set("rgw_beta", standing("user_banned", "all"));
    let banned = cache(&fleet).resolve_cached("rgw_beta").await.unwrap();
    let refusal = admit_resolved(&banned, GatewayCustody::Fleet).unwrap_err();
    assert!(
        matches!(refusal, GatewayError::StandingRefused(ref detail) if detail.code == "user_banned")
    );
    server.abort();
}

#[tokio::test]
async fn a_refuse_all_body_never_loads_a_permissive_policy() {
    let plane = ControlPlane::new();
    plane.set("rgw_alpha", standing("key_suspended", "all"));
    plane.set("rgw_beta", standing("org_suspended", "floor_bound"));
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::SelfHosted);
    let refused = cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    assert!(!refused.policy.available);
    assert!(!refused.policy.allows_model("any-model"));
    let floor_only = cache(&state).resolve_cached("rgw_beta").await.unwrap();
    assert!(floor_only.policy.available);
    // The gateway's own key: a refusing standing installs a deny policy.
    let mut own = (*refused).clone();
    own.policy.available = true;
    state.apply_resolved_policy(own);
    assert!(!state.policy.read().unwrap().available);
    server.abort();
}

#[tokio::test]
async fn a_refusing_standing_is_cached_only_as_long_as_a_negative_entry() {
    let plane = ControlPlane::new();
    plane.set("rgw_alpha", standing("org_suspended", "floor_bound"));
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    cache(&state).resolve_cached("rgw_beta").await.unwrap();
    // Past the negative TTL, well within the positive one.
    cache(&state).age_entries_for_test(Duration::from_secs(11));
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    cache(&state).resolve_cached("rgw_beta").await.unwrap();
    assert_eq!(plane.calls(), 3, "only the refusing entry was re-asked");
    server.abort();
}

// ─── Enforcement push ──────────────────────────────────────────────────────

#[tokio::test]
async fn a_push_busts_matching_entries_immediately() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let app = crate::api::router(Arc::clone(&state));
    for token in ["rgw_alpha", "rgw_alpha_two", "rgw_beta"] {
        cache(&state).resolve_cached(token).await.unwrap();
    }
    assert_eq!(plane.calls(), 3);
    // Cached: no further resolve.
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    assert_eq!(plane.calls(), 3);

    plane.set("rgw_alpha", standing("org_suspended", "all"));
    plane.set("rgw_alpha_two", standing("org_suspended", "all"));
    let (status, body) = send(
        &app,
        push_request(
            Some(SECRET),
            json!({ "orgId": "org_alpha", "enforcementVersion": 5 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["applied"], true);
    assert_eq!(body["dropped"], 2);
    assert_eq!(body["appliedEnforcementVersion"], 5);

    // The very next request re-resolves and is refused: no TTL wait.
    let (status, body) = send(&app, chat_request("rgw_alpha")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "org_suspended");
    assert_eq!(plane.calls(), 4);
    // Another org's entry was untouched.
    cache(&state).resolve_cached("rgw_beta").await.unwrap();
    assert_eq!(plane.calls(), 4);
    server.abort();
}

#[tokio::test]
async fn pushes_match_by_credential_and_by_owner_user() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    for token in ["rgw_alpha", "rgw_alpha_two", "rgw_beta"] {
        cache(&state).resolve_cached(token).await.unwrap();
    }
    let by_credential = cache(&state).apply_enforcement_push(&EnforcementPush {
        credential_id: Some("cred_alpha_two".into()),
        version: 1,
        ..Default::default()
    });
    assert_eq!((by_credential.applied, by_credential.dropped), (true, 1));
    let by_user = cache(&state).apply_enforcement_push(&push(None, Some("usr_beta"), 2));
    assert_eq!((by_user.applied, by_user.dropped), (true, 1));
    // `rgw_alpha` is still cached; the other two re-resolve.
    let before = plane.calls();
    for token in ["rgw_alpha", "rgw_alpha_two", "rgw_beta"] {
        cache(&state).resolve_cached(token).await.unwrap();
    }
    assert_eq!(plane.calls(), before + 2);
    // A push naming no subject drops everything.
    let all = cache(&state).apply_enforcement_push(&push(None, None, 3));
    assert_eq!((all.applied, all.dropped), (true, 3));
    server.abort();
}

#[tokio::test]
async fn a_replayed_older_push_is_ignored_but_a_reordered_one_for_another_subject_applies() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let app = crate::api::router(Arc::clone(&state));
    let org_push = |org: &str, version: u64| {
        push_request(
            Some(SECRET),
            json!({ "orgId": org, "enforcementVersion": version }),
        )
    };
    let (_, body) = send(&app, org_push("org_alpha", 6)).await;
    assert_eq!(body["applied"], true);
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    let calls = plane.calls();
    for version in [6, 4] {
        let (status, body) = send(&app, org_push("org_alpha", version)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["applied"], false, "v{version}");
        assert_eq!(body["dropped"], 0, "v{version}");
        assert_eq!(body["appliedEnforcementVersion"], 6);
    }
    // The replays dropped nothing.
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    assert_eq!(plane.calls(), calls);
    // A delayed v5 for a different org still applies: marks are per subject.
    cache(&state).resolve_cached("rgw_beta").await.unwrap();
    let (_, body) = send(&app, org_push("org_beta", 5)).await;
    assert_eq!(body["applied"], true);
    assert_eq!(body["dropped"], 1);
    assert_eq!(body["appliedEnforcementVersion"], 6);
    server.abort();
}

#[tokio::test]
async fn a_push_with_a_bad_or_missing_secret_is_refused() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url.clone(), GatewayCustody::Fleet);
    let app = crate::api::router(Arc::clone(&state));
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    let body = json!({ "orgId": "org_alpha", "enforcementVersion": 9 });
    for secret in [
        None,
        Some(""),
        Some("push-test-secreT"),
        Some("push-test-secret-longer"),
    ] {
        let (status, reply) = send(&app, push_request(secret, body.clone())).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{secret:?}: {reply}");
    }
    // A bearer is not the push credential either.
    let request = Request::builder()
        .method("POST")
        .uri("/internal/enforcement/invalidate")
        .header("content-type", "application/json")
        .header("authorization", "Bearer rgw_alpha")
        .extension(peer())
        .body(Body::from(body.to_string()))
        .unwrap();
    assert_eq!(send(&app, request).await.0, StatusCode::UNAUTHORIZED);
    // Nothing was applied: the entry is still cached.
    assert_eq!(cache(&state).enforcement_ledger().latest(), 0);
    cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    assert_eq!(plane.calls(), 1);

    // A replica with no secret configured refuses every push, even one that
    // presents an empty secret.
    let mut unset = AppState::new_for_test_default();
    unset.resolve_cache = Some(ResolveCache::for_test(url, reqwest::Client::new()));
    let app = crate::api::router(Arc::new(unset));
    for secret in [None, Some(""), Some(SECRET)] {
        let (status, _) = send(&app, push_request(secret, body.clone())).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{secret:?}");
    }
    server.abort();
}

#[tokio::test]
async fn a_push_body_must_carry_a_positive_version_and_valid_ids() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let app = crate::api::router(Arc::clone(&state));
    for body in [
        json!({ "orgId": "org_alpha" }),
        json!({ "orgId": "org_alpha", "enforcementVersion": 0 }),
        json!({ "orgId": "org_alpha", "enforcementVersion": -2 }),
        json!({ "orgId": "org_alpha", "enforcementVersion": "3" }),
        json!({ "orgId": " org_alpha", "enforcementVersion": 3 }),
        json!({ "orgId": "", "enforcementVersion": 3 }),
        json!({ "userId": "a\u{0007}b", "enforcementVersion": 3 }),
    ] {
        let (status, reply) = send(&app, push_request(Some(SECRET), body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {reply}");
    }
    assert_eq!(cache(&state).enforcement_ledger().latest(), 0);
    server.abort();
}

#[tokio::test]
async fn a_push_during_an_in_flight_resolve_supersedes_what_it_returns() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let resolving = {
        let state = Arc::clone(&state);
        tokio::spawn(async move { cache(&state).resolve_cached("rgw_wait_alpha").await })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        while plane.calls() < 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // The control plane already read the old standing; the push lands before
    // its response does.
    let outcome = cache(&state).apply_enforcement_push(&push(Some("org_alpha"), None, 1));
    assert!(outcome.applied);
    plane.set("rgw_wait_alpha", standing("org_suspended", "all"));
    plane.gate.add_permits(1);
    let stale = resolving.await.unwrap().unwrap();
    assert!(stale.standing.serves_everything());
    // The next lookup does not trust the entry the race inserted.
    plane.gate.add_permits(1);
    let fresh = cache(&state)
        .resolve_cached("rgw_wait_alpha")
        .await
        .unwrap();
    assert_eq!(plane.calls(), 2);
    assert_eq!(fresh.standing.state, StandingState::OrgSuspended);
    server.abort();
}

// ─── In-flight rechecks ────────────────────────────────────────────────────

#[tokio::test]
async fn a_guard_rechecks_only_after_a_push_names_its_subject() {
    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let resolved = cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    let guard = StandingGuard::new("rgw_alpha".into(), CredentialUse::GatewayRelay, &resolved);
    assert!(
        !format!("{guard:?}").contains("rgw_alpha"),
        "the bearer never prints"
    );
    // Nothing pushed: no resolve at all.
    assert!(!guard.is_stale(&state));
    guard.recheck(&state).await.unwrap();
    assert_eq!(plane.calls(), 1);
    // A push for another org does not touch this request.
    cache(&state).apply_enforcement_push(&push(Some("org_beta"), None, 1));
    assert!(!guard.is_stale(&state));
    // A push that leaves it active re-resolves once, then is current again.
    cache(&state).apply_enforcement_push(&push(Some("org_alpha"), None, 2));
    assert!(guard.is_stale(&state));
    guard.recheck(&state).await.unwrap();
    assert_eq!(plane.calls(), 2);
    assert!(!guard.is_stale(&state));
    // A ban pushed mid-request refuses at the next check.
    plane.set("rgw_alpha", standing("user_banned", "all"));
    cache(&state).apply_enforcement_push(&push(None, Some("usr_alpha"), 3));
    let refusal = guard.recheck(&state).await.unwrap_err();
    assert!(
        matches!(refusal, GatewayError::StandingRefused(ref detail) if detail.code == "user_banned")
    );
    server.abort();
}

/// A provider body fed one chunk at a time by the test.
fn channel_body() -> (
    tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>,
    Body,
) {
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    (sender, Body::from_stream(stream))
}

#[tokio::test]
async fn a_stream_ends_with_the_refusal_at_the_next_window() {
    use futures_util::StreamExt;

    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let resolved = cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    let guard = Arc::new(StandingGuard::new(
        "rgw_alpha".into(),
        CredentialUse::GatewayRelay,
        &resolved,
    ));
    let (sender, provider) = channel_body();
    let mut stream = guard_stream(provider, Arc::clone(&state), Some(guard)).into_data_stream();

    sender
        .send(Ok(bytes::Bytes::from_static(b"data: {\"n\":1}\n\n")))
        .await
        .unwrap();
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(&first[..], b"data: {\"n\":1}\n\n");

    plane.set("rgw_alpha", standing("org_suspended", "all"));
    cache(&state).apply_enforcement_push(&push(Some("org_alpha"), None, 1));
    sender
        .send(Ok(bytes::Bytes::from_static(b"data: {\"n\":2}\n\n")))
        .await
        .unwrap();
    let cut = stream.next().await.unwrap().unwrap();
    let text = String::from_utf8(cut.to_vec()).unwrap();
    assert!(text.starts_with("data: "), "{text}");
    let envelope: Value = serde_json::from_str(text.trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(envelope["error"]["code"], "org_suspended");
    assert_eq!(
        envelope["error"]["appeal_url"],
        "https://ryu.example/appeal"
    );
    assert!(!text.contains("\"n\":2"), "the refused window is withheld");
    // The stream then ends normally, so the observer above it settles.
    assert!(stream.next().await.is_none());
    server.abort();
}

#[tokio::test]
async fn a_stream_without_a_push_passes_through_untouched() {
    use futures_util::StreamExt;

    let plane = ControlPlane::new();
    let (url, server) = plane.serve().await;
    let state = gateway_state(url, GatewayCustody::Fleet);
    let resolved = cache(&state).resolve_cached("rgw_alpha").await.unwrap();
    let guard = Arc::new(StandingGuard::new(
        "rgw_alpha".into(),
        CredentialUse::GatewayRelay,
        &resolved,
    ));
    let provider = Body::from("data: one\n\ndata: [DONE]\n\n");
    let collected: Vec<_> = guard_stream(provider, Arc::clone(&state), Some(guard))
        .into_data_stream()
        .collect()
        .await;
    let joined: Vec<u8> = collected
        .into_iter()
        .flat_map(|chunk| chunk.unwrap().to_vec())
        .collect();
    assert_eq!(joined, b"data: one\n\ndata: [DONE]\n\n");
    assert_eq!(plane.calls(), 1);
    server.abort();
}

// ─── Ledger ────────────────────────────────────────────────────────────────

#[test]
fn the_ledger_keeps_a_high_water_mark_per_subject() {
    let ledger = EnforcementLedger::default();
    assert!(ledger.apply(&push(Some("a"), None, 3)));
    assert!(!ledger.apply(&push(Some("a"), None, 3)));
    assert!(!ledger.apply(&push(Some("a"), None, 2)));
    assert!(ledger.apply(&push(Some("b"), None, 2)));
    assert_eq!(ledger.latest(), 3);
    let subjects = |org: &str, user: Option<&str>| StandingSubjects {
        org_id: org.into(),
        credential_id: None,
        owner_user_id: user.map(str::to_owned),
        created_by: None,
    };
    assert_eq!(ledger.newest_for(&subjects("a", None)), 3);
    assert_eq!(ledger.newest_for(&subjects("b", None)), 2);
    assert_eq!(ledger.newest_for(&subjects("c", None)), 0);
    // A push naming two subjects applies when it advances either.
    assert!(ledger.apply(&push(Some("a"), Some("u"), 3)));
    assert_eq!(ledger.newest_for(&subjects("c", Some("u"))), 3);
}

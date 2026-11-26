//! Tests of the token resolve cache (`super`): TTLs, eviction, operation
//! scoping, admission bounds and cancellation, plus the Gateway HTTP mapping of
//! a busy resolve to 429 and an unresolved one to 401.

use super::*;
use crate::policy::EffectivePolicy;

#[tokio::test]
async fn operation_scoped_inflight_markers_release_independently_on_cancellation() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    let cache = Arc::new(cache);
    let search_cache = Arc::clone(&cache);
    let search = tokio::spawn(async move {
        search_cache
            .resolve_cached_for("rgw_web_wait_ops", CredentialUse::GatewayWebSearch)
            .await
    });
    let fetch_cache = Arc::clone(&cache);
    let fetch = tokio::spawn(async move {
        fetch_cache
            .resolve_cached_for("rgw_web_wait_ops", CredentialUse::GatewayWebFetch)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(cache.state.lock().unwrap().in_flight.len(), 2);
    search.abort();
    let _ = search.await;
    assert_eq!(cache.state.lock().unwrap().in_flight.len(), 1);
    fetch.abort();
    let _ = fetch.await;
    assert!(cache.state.lock().unwrap().in_flight.is_empty());
    assert_eq!(cache.admission.available_permits(), MAX_CONCURRENT_RESOLVES);
    server.abort();
}
#[tokio::test]
async fn explicit_web_resolve_header_preserves_provider_authority_without_inference_grant() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    let resolved = cache
        .resolve_cached_for("rgw_web_client", CredentialUse::GatewayWebSearch)
        .await
        .unwrap();
    assert!(resolved.policy.allows_provider("tavily"));
    assert!(!resolved.policy.allows_provider("exa"));
    assert!(cache.resolve_cached("rgw_web_client").await.is_err());
    assert!(cache
        .resolve_cached_for("rgw_web_client", CredentialUse::GatewayWebFetch)
        .await
        .is_err());
    assert!(cache
        .resolve_cached_for("rgw_web_client", CredentialUse::GatewayWebSearch)
        .await
        .is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    server.abort();
}
#[tokio::test]
async fn inference_positive_and_web_negative_cache_entries_are_operation_isolated() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    assert!(cache.resolve_cached("rgw_good_operations").await.is_ok());
    assert!(cache
        .resolve_cached_for("rgw_good_operations", CredentialUse::GatewayWebSearch)
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(cache.resolve_cached("rgw_good_operations").await.is_ok());
    assert!(cache
        .resolve_cached_for("rgw_good_operations", CredentialUse::GatewayWebSearch)
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(cache
        .resolve_cached_for("rgw_good_operations", CredentialUse::GatewayWebFetch)
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    server.abort();
}

pub(super) fn sample_org() -> Arc<ResolvedOrg> {
    Arc::new(ResolvedOrg {
        org_id: "o1".to_string(),
        managed_inference: true,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: Some(1000),
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        pool_allowances: std::collections::HashMap::new(),
        policy: EffectivePolicy::default(),
        credential_id: None,
        service_account_id: None,
        project_id: None,
        funding_draw_source: None,
        credential: None,
        identity_salt_epoch: 1,
        team_id: None,
        owner_user_id: None,
        owner_team_ids: None,
        limits: Arc::default(),
        billed_limits: Arc::default(),
        managed_tier_unavailable: false,
        limits_spend: None,
        active_gateways: None,
        policy_version: None,
        fetched_at: Instant::now(),
        standing: crate::standing::PlatformStanding::active(),
        platform_floor: None,
        enforcement_seen: 0,
        credential_created_at: None,
    })
}

#[test]
fn an_unavailable_managed_tier_is_cached_only_briefly() {
    let fetched_at = Instant::now();
    let mut unavailable = (*sample_org()).clone();
    unavailable.managed_tier_unavailable = true;
    let entry = |org: ResolvedOrg| CachedResolve {
        resolved: Ok(Arc::new(org)),
        fetched_at,
    };
    let later = fetched_at + NEGATIVE_TTL + Duration::from_secs(1);
    assert!(entry((*sample_org()).clone()).is_fresh(later));
    assert!(!entry(unavailable).is_fresh(later));
}

#[test]
fn a_fresh_tenant_version_drops_that_tenants_stale_sibling_tokens() {
    let versioned = |org: &str, version: Option<&str>| {
        let mut resolved = (*sample_org()).clone();
        resolved.org_id = org.to_owned();
        resolved.policy_version = version.map(str::to_owned);
        Arc::new(resolved)
    };
    let now = Instant::now();
    let mut entries = HashMap::new();
    for (key, org, version) in [
        ("stale", "tenant", Some("pv1")),
        ("current", "tenant", Some("pv2")),
        ("other-tenant", "elsewhere", Some("pv1")),
    ] {
        entries.insert(
            key.to_owned(),
            CachedResolve {
                resolved: Ok(versioned(org, version)),
                fetched_at: now,
            },
        );
    }
    entries.insert(
        "negative".to_owned(),
        CachedResolve {
            resolved: Err(()),
            fetched_at: now,
        },
    );

    drop_superseded_versions(&mut entries, &versioned("tenant", None));
    assert_eq!(entries.len(), 4, "an unversioned resolve carries no signal");

    drop_superseded_versions(&mut entries, &versioned("tenant", Some("pv2")));
    let mut kept: Vec<_> = entries.keys().map(String::as_str).collect();
    kept.sort_unstable();
    assert_eq!(kept, ["current", "negative", "other-tenant"]);
}

#[test]
fn invalidate_org_drops_only_that_orgs_positive_entries() {
    let cache = ResolveCache::for_test("http://127.0.0.1:9".into(), reqwest::Client::new());
    {
        let mut state = cache.state.lock().unwrap();
        let now = Instant::now();
        state.entries.insert(
            "a".into(),
            CachedResolve {
                resolved: Ok(sample_org()),
                fetched_at: now,
            },
        );
        state.entries.insert(
            "b".into(),
            CachedResolve {
                resolved: Err(()),
                fetched_at: now,
            },
        );
    }
    assert_eq!(cache.invalidate_org("other"), 0);
    assert_eq!(cache.invalidate_org("o1"), 1);
    assert_eq!(cache.state.lock().unwrap().entries.len(), 1);
}

#[test]
fn positive_entry_is_fresh_within_ttl_and_stale_after() {
    let base = Instant::now();
    let entry = CachedResolve {
        resolved: Ok(sample_org()),
        fetched_at: base,
    };
    // Fresh well within 60s.
    assert!(entry.is_fresh(base + Duration::from_secs(30)));
    // Stale past 60s.
    assert!(!entry.is_fresh(base + Duration::from_secs(90)));
}

#[test]
fn negative_entry_has_shorter_ttl() {
    let base = Instant::now();
    let entry = CachedResolve {
        resolved: Err(()),
        fetched_at: base,
    };
    // Fresh within 10s.
    assert!(entry.is_fresh(base + Duration::from_secs(5)));
    // Stale past 10s — much sooner than a positive entry, which is still
    // fresh at the same instant.
    assert!(!entry.is_fresh(base + Duration::from_secs(15)));
    let positive = CachedResolve {
        resolved: Ok(sample_org()),
        fetched_at: base,
    };
    assert!(positive.is_fresh(base + Duration::from_secs(15)));
}

pub(super) async fn mock_control_plane() -> (
    ResolveCache,
    Arc<std::sync::atomic::AtomicUsize>,
    Arc<Semaphore>,
    tokio::task::JoinHandle<()>,
) {
    use axum::{http::HeaderMap, response::IntoResponse, routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Semaphore::new(0));
    let handler_calls = calls.clone();
    let handler_gate = gate.clone();
    let app = Router::new().route("/api/control-plane/gateway/resolve", get(move |headers: HeaderMap| {
        let calls = handler_calls.clone();
        let gate = handler_gate.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let key = headers.get("x-gateway-key").unwrap().to_str().unwrap();
            if key.contains("wait") {
                gate.acquire().await.unwrap().forget();
            }
            if key.starts_with("rgw_good") {
                axum::Json(serde_json::json!({"organization":{"id":"org_test"}, "credential":{"purpose":"gateway_relay", "allowedOperations":["gateway.inference"]}, "standing":{"state":"active","refuses":"none"}})).into_response()
            } else if key.starts_with("rgw_web") && headers.get("x-ryu-gateway-operation").and_then(|value|value.to_str().ok()) == Some("gateway.web.search") {
                axum::Json(serde_json::json!({"organization":{"id":"org_test"},"credential":{"purpose":"gateway_relay","allowedOperations":["gateway.web.search"]},"policy":{"rules":{"approvedProviders":["tavily"]}},"standing":{"state":"active","refuses":"none"}})).into_response()
            } else {
                axum::http::StatusCode::UNAUTHORIZED.into_response()
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        ResolveCache::for_test(format!("http://{address}"), reqwest::Client::new()),
        calls,
        gate,
        server,
    )
}

#[tokio::test]
async fn actual_http_unique_failures_and_successes_stay_bounded() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    for i in 0..MAX_ENTRIES + 8 {
        assert!(cache.resolve_cached(&format!("rgw_bad_{i}")).await.is_err());
        assert!(cache.state.lock().unwrap().entries.len() <= MAX_ENTRIES);
    }
    for i in 0..8 {
        assert_eq!(
            cache
                .resolve_cached(&format!("rgw_good_{i}"))
                .await
                .unwrap()
                .org_id,
            "org_test"
        );
        assert!(cache.state.lock().unwrap().entries.len() <= MAX_ENTRIES);
    }
    let before = calls.load(Ordering::SeqCst);
    assert!(cache
        .resolve_cached(&format!("rgw_bad_{}", MAX_ENTRIES + 7))
        .await
        .is_err());
    assert!(cache.resolve_cached("rgw_good_7").await.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), before);
    server.abort();
}

#[tokio::test]
async fn expired_entries_are_removed_and_oversize_tokens_do_no_work() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    assert!(cache
        .resolve_cached(&"x".repeat(MAX_TOKEN_BYTES + 1))
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(cache.state.lock().unwrap().entries.is_empty());
    assert!(cache.resolve_cached("rgw_good_expired").await.is_ok());
    assert!(cache.resolve_cached("rgw_bad_expired").await.is_err());
    for entry in cache.state.lock().unwrap().entries.values_mut() {
        entry.fetched_at = Instant::now() - POSITIVE_TTL;
    }
    assert!(cache.resolve_cached("rgw_good_fresh").await.is_ok());
    assert_eq!(cache.state.lock().unwrap().entries.len(), 1);
    server.abort();
}

#[tokio::test]
async fn concurrent_misses_are_bounded_deduplicated_and_cancel_safe() {
    use std::sync::atomic::Ordering;
    let (cache, calls, gate, server) = mock_control_plane().await;
    let cache = Arc::new(cache);
    // Prime a hit to prove saturated misses do not block cached clients.
    assert!(cache.resolve_cached("rgw_good_cached").await.is_ok());
    let first_cache = cache.clone();
    let first = tokio::spawn(async move { first_cache.resolve_cached("rgw_wait_duplicate").await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while calls.load(Ordering::SeqCst) != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(cache.resolve_cached("rgw_wait_duplicate").await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    first.abort();
    let _ = first.await;
    let baseline = calls.load(Ordering::SeqCst);
    let mut pending = Vec::new();
    for i in 0..MAX_CONCURRENT_RESOLVES {
        let cache = cache.clone();
        pending.push(tokio::spawn(async move {
            cache.resolve_cached(&format!("rgw_wait_{i}")).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while calls.load(Ordering::SeqCst) != MAX_CONCURRENT_RESOLVES + baseline {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(cache.resolve_cached("rgw_wait_overflow").await.is_err());
    assert!(cache.resolve_cached("rgw_wait_0").await.is_err());
    assert!(cache.resolve_cached("rgw_good_cached").await.is_ok());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        MAX_CONCURRENT_RESOLVES + baseline
    );
    assert_eq!(
        cache.state.lock().unwrap().in_flight.len(),
        MAX_CONCURRENT_RESOLVES
    );
    for task in pending {
        task.abort();
        let _ = task.await;
    }
    assert!(cache.state.lock().unwrap().in_flight.is_empty());
    assert_eq!(cache.admission.available_permits(), MAX_CONCURRENT_RESOLVES);
    gate.add_permits(MAX_CONCURRENT_RESOLVES + 1);
    assert!(cache.resolve_cached("rgw_good_after_cancel").await.is_ok());
    server.abort();
}

#[tokio::test]
async fn gateway_http_refresh_is_retryable_and_invalid_bearers_stay_unauthorized() {
    use std::sync::atomic::Ordering;
    let (cache, calls, gate, control_server) = mock_control_plane().await;
    let config = crate::config::GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: None,
            api_keys: vec![],
        },
        ..Default::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.resolve_cache = Some(cache);
    let state = Arc::new(state);
    let app = crate::api::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let gateway = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let url = format!("http://{address}/v1/budget/spend");
    let client = reqwest::Client::new();
    let first_url = url.clone();
    let first_client = client.clone();
    let first = tokio::spawn(async move {
        first_client
            .get(first_url)
            .bearer_auth("rgw_good_wait")
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while calls.load(Ordering::SeqCst) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let busy = client
        .get(&url)
        .bearer_auth("rgw_good_wait")
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    gate.add_permits(1);
    // Valid org credentials still cannot read owner-only spend; importantly,
    // normal resolution completes rather than caching refresh pressure as 401.
    assert_eq!(
        first.await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("rgw_good_wait")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(state
        .resolve_cache
        .as_ref()
        .unwrap()
        .state
        .lock()
        .unwrap()
        .entries
        .get("gateway.inference:rgw_good_wait")
        .unwrap()
        .resolved
        .is_ok());
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("rgw_invalid")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(format!("rgw_{}", "x".repeat(MAX_TOKEN_BYTES)))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    println!("Gateway HTTP proof: concurrent valid refresh=429, valid non-admin=401 (master-key gate), invalid=401, oversized=401; upstream resolves=2; no provider requests");
    gateway.abort();
    control_server.abort();
}

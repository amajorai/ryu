//! Token → org resolve cache (multi-tenant data plane).
//!
//! The hosted gateway serves many organizations; each client presents its minted
//! `rgw_` gateway token as `Authorization: Bearer`. Resolving that token to an
//! org + budget + policy is a control-plane round-trip, so we cache the result
//! keyed by the token.
//!
//! Two TTLs, mirroring a DNS-style positive/negative cache:
//!   - **Positive** (~60s): a resolved org is reused so the hot path never hits
//!     the control plane on every request. 60s also bounds how stale a budget can
//!     be — a topped-up org auto-recovers within one window (the pre-flight gate
//!     reads the freshly-fetched `remaining_budget`).
//!   - **Negative** (~10s): an invalid/revoked/unreachable token is cached briefly
//!     so a flood of bad bearers cannot turn into a resolve-DoS against the control
//!     plane. Short so a just-minted token isn't locked out for long.
//!
//! A resolution whose platform standing refuses anything is cached only as
//! long as a negative entry. An enforcement push from the control plane
//! (`crate::standing`) drops every matching entry at once, and an entry
//! fetched while a push was arriving is treated as stale at lookup, so a
//! suspension never waits out the positive TTL.
//!
//! Enabled only when a control-plane URL is configured (`CONTROL_PLANE_URL`); when
//! absent the dynamic path is a no-op and single-org behavior is unchanged. The
//! raw token is used only as the in-memory map key — it is never logged.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

use super::{resolve_token, CredentialUse, ResolvedOrg};
use crate::standing::{EnforcementLedger, EnforcementPush, StandingSubjects};

/// Env var with the control-plane base URL (no trailing `/api`). Same source as
/// [`super::PolicySource`] so the startup and dynamic paths reach one endpoint.
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";

/// Positive cache TTL: how long a successful resolve is reused.
const POSITIVE_TTL: Duration = Duration::from_secs(60);
/// Negative cache TTL: how long a failed resolve (invalid/revoked/unreachable) is
/// cached to blunt a resolve-DoS from a flood of bad bearers.
const NEGATIVE_TTL: Duration = Duration::from_secs(10);
const MAX_ENTRIES: usize = 4096;
const MAX_TOKEN_BYTES: usize = 256;
const MAX_CONCURRENT_RESOLVES: usize = 32;

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CachedResolve>,
    in_flight: HashSet<String>,
}

// Remove the marker on success, timeout, or cancellation. No synchronous guard
// survives an await, and duplicate misses fail closed instead of queuing work.
struct InFlight<'a> {
    state: &'a Mutex<CacheState>,
    token: &'a str,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .in_flight
            .remove(self.token);
    }
}

/// Resolution failure or temporary admission pressure. Neither grants access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveErr {
    /// The token did not resolve to an org: invalid, revoked, or the control
    /// plane was unreachable. Caller returns 401.
    Unresolved,
    /// Retryable admission pressure; caller returns 429, never invalid credentials.
    Busy,
}

/// One cache entry: the resolve outcome and when it was stored.
struct CachedResolve {
    /// `Ok` holds the resolved org (shared, cheap to clone out); `Err(())` is a
    /// negative entry (the token did not resolve).
    resolved: Result<Arc<ResolvedOrg>, ()>,
    fetched_at: Instant,
}

impl CachedResolve {
    /// Whether this entry is still fresh at `now` under its TTL (positive entries
    /// live longer than negative ones).
    fn is_fresh(&self, now: Instant) -> bool {
        // A resolve whose managed tier was unreadable (a billing-provider
        // outage) refuses managed spend with a retryable 503, so re-ask as
        // soon as a negative entry would: a recovered control plane must not
        // keep a funded tenant refused for the whole positive window.
        //
        // A standing that refuses anything (or could not be read) is re-asked
        // as soon as a negative entry would be, so a lifted suspension serves
        // again quickly and an unreadable standing never sticks.
        let ttl = match &self.resolved {
            Ok(org) if !org.managed_tier_unavailable && org.standing.serves_everything() => {
                POSITIVE_TTL
            }
            _ => NEGATIVE_TTL,
        };
        now.duration_since(self.fetched_at) < ttl
    }

    /// Whether an enforcement push newer than this entry's fetch names its
    /// subjects. Negative entries name no subject and are never superseded.
    fn is_superseded(&self, ledger: &EnforcementLedger) -> bool {
        match &self.resolved {
            Ok(org) => ledger.newest_for(&StandingSubjects::of(org)) > org.enforcement_seen,
            Err(()) => false,
        }
    }
}

/// What one enforcement push did to the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushOutcome {
    /// False when the push was a replay at or below every subject's mark.
    pub applied: bool,
    /// Cached resolutions dropped.
    pub dropped: usize,
}

/// Caches token → org resolutions for the multi-tenant data plane.
pub struct ResolveCache {
    /// Control-plane base URL (no `/api` suffix).
    control_plane_url: String,
    http: reqwest::Client,
    state: Mutex<CacheState>,
    admission: Semaphore,
    /// Applied enforcement pushes, per subject.
    ledger: EnforcementLedger,
}

impl ResolveCache {
    #[cfg(test)]
    pub(crate) fn for_test(control_plane_url: String, http: reqwest::Client) -> Self {
        Self {
            control_plane_url,
            http,
            state: Mutex::new(CacheState::default()),
            admission: Semaphore::new(MAX_CONCURRENT_RESOLVES),
            ledger: EnforcementLedger::default(),
        }
    }

    /// Build from environment, sharing the gateway's HTTP client. Returns `None`
    /// when `CONTROL_PLANE_URL` is unset/empty — the dynamic path stays a no-op.
    pub fn from_env(http: reqwest::Client) -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL)
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(Self {
            control_plane_url: url.trim_end_matches('/').to_string(),
            http,
            state: Mutex::new(CacheState::default()),
            admission: Semaphore::new(MAX_CONCURRENT_RESOLVES),
            ledger: EnforcementLedger::default(),
        })
    }

    /// Resolve a token, serving a fresh cached value if present else calling the
    /// control plane and storing the outcome (positive or negative). The raw
    /// token is used only as the map key; it is never logged.
    pub async fn resolve_cached(&self, token: &str) -> Result<Arc<ResolvedOrg>, ResolveErr> {
        self.resolve_cached_for(token, CredentialUse::GatewayRelay)
            .await
    }

    pub async fn resolve_cached_for(
        &self,
        token: &str,
        credential_use: CredentialUse,
    ) -> Result<Arc<ResolvedOrg>, ResolveErr> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(ResolveErr::Unresolved);
        }
        let cache_key = format!("{}:{token}", credential_use.operation());
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            let ledger = &self.ledger;
            state
                .entries
                .retain(|_, entry| entry.is_fresh(now) && !entry.is_superseded(ledger));
            if let Some(entry) = state.entries.get(&cache_key) {
                return entry.resolved.clone().map_err(|()| ResolveErr::Unresolved);
            }
        }
        // Never queue unauthenticated work. Fresh cache hits remain available
        // while misses are saturated, and permits release when futures cancel.
        let _permit = self.admission.try_acquire().map_err(|_| ResolveErr::Busy)?;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Another request may have completed between lookup and admission.
            if let Some(entry) = state.entries.get(&cache_key) {
                if entry.is_fresh(Instant::now()) && !entry.is_superseded(&self.ledger) {
                    return entry.resolved.clone().map_err(|()| ResolveErr::Unresolved);
                }
            }
            if !state.in_flight.insert(cache_key.clone()) {
                return Err(ResolveErr::Busy);
            }
        }
        let _in_flight = InFlight {
            state: &self.state,
            token: &cache_key,
        };
        // Snapshot the ledger before the fetch: the control plane state this
        // fetch reads reflects at least every push applied so far, and a push
        // that lands while it is in flight supersedes it at the next lookup.
        let enforcement_seen = self.ledger.latest();
        let resolved = resolve_token(&self.control_plane_url, &self.http, token, credential_use)
            .await
            .map(|mut org| {
                org.enforcement_seen = enforcement_seen;
                Arc::new(org)
            })
            .map_err(|_| ());
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            state.entries.retain(|_, entry| entry.is_fresh(now));
            if state.entries.len() >= MAX_ENTRIES {
                // Evict under the same lock as insertion: parallel completions
                // cannot exceed the capacity after independently checking it.
                if let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.fetched_at)
                    .map(|(key, _)| key.clone())
                {
                    state.entries.remove(&oldest);
                }
            }
            if let Ok(fresh) = resolved.as_ref() {
                drop_superseded_versions(&mut state.entries, fresh);
            }
            state.entries.insert(
                cache_key.clone(),
                CachedResolve {
                    resolved: resolved.clone(),
                    fetched_at: now,
                },
            );
        }
        resolved.map_err(|()| ResolveErr::Unresolved)
    }

    /// Drop every cached positive resolution for `org_id`, so the next request
    /// on any of its tokens re-resolves. Called when the org's `policyVersion`
    /// changes, which makes a policy or limits edit apply without waiting out
    /// the positive TTL. Returns how many entries were dropped.
    pub fn invalidate_org(&self, org_id: &str) -> usize {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = state.entries.len();
        state
            .entries
            .retain(|_, entry| !matches!(&entry.resolved, Ok(org) if org.org_id == org_id));
        before - state.entries.len()
    }

    /// Move every entry's fetch time `by` into the past.
    #[cfg(test)]
    pub(crate) fn age_entries_for_test(&self, by: Duration) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in state.entries.values_mut() {
            entry.fetched_at = entry.fetched_at.checked_sub(by).unwrap_or(entry.fetched_at);
        }
    }

    /// The applied enforcement pushes (`crate::standing`).
    pub fn enforcement_ledger(&self) -> &EnforcementLedger {
        &self.ledger
    }

    /// Apply one enforcement push: record its version per subject and drop
    /// every cached resolution it names, so the next request on any of those
    /// tokens re-resolves its standing. A replay at or below every subject's
    /// recorded version changes nothing.
    pub fn apply_enforcement_push(&self, push: &EnforcementPush) -> PushOutcome {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Advance the ledger under the entry lock, so no lookup can read an
        // entry the push names between the two steps.
        if !self.ledger.apply(push) {
            return PushOutcome {
                applied: false,
                dropped: 0,
            };
        }
        let before = state.entries.len();
        state
            .entries
            .retain(|_, entry| !matches!(&entry.resolved, Ok(org) if push.matches(org)));
        PushOutcome {
            applied: true,
            dropped: before - state.entries.len(),
        }
    }
}

/// A fresh resolve for an org carries its current `policyVersion`. Any other
/// cached token of the same org that saw a different version holds a stale
/// policy/limits snapshot, so drop it: the tenant's next request on that token
/// re-resolves instead of waiting out the positive TTL. This covers every
/// tenant, not only the gateway's own org (which [`ResolveCache::invalidate_org`]
/// handles from the background refresh). Unversioned resolutions carry no
/// signal and leave siblings alone.
fn drop_superseded_versions(entries: &mut HashMap<String, CachedResolve>, fresh: &ResolvedOrg) {
    let Some(version) = fresh.policy_version.as_deref() else {
        return;
    };
    entries.retain(|_, entry| match &entry.resolved {
        Ok(org) if org.org_id == fresh.org_id => org.policy_version.as_deref() == Some(version),
        _ => true,
    });
}

#[cfg(test)]
mod tests {
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
    use super::*;
    use crate::policy::EffectivePolicy;

    fn sample_org() -> Arc<ResolvedOrg> {
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

    async fn mock_control_plane() -> (
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
            ResolveCache {
                control_plane_url: format!("http://{address}"),
                http: reqwest::Client::new(),
                state: Mutex::new(CacheState::default()),
                admission: Semaphore::new(MAX_CONCURRENT_RESOLVES),
                ledger: EnforcementLedger::default(),
            },
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
        let first =
            tokio::spawn(async move { first_cache.resolve_cached("rgw_wait_duplicate").await });
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
}

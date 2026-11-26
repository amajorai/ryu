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
/// Extra resolve permits only a key that resolved before on this instance may
/// take once the shared ones are full. Anyone can fill the shared permits with
/// made-up `rgw_` tokens (no credential needed), so without this reserve such
/// a flood turns every tenant whose cache entry expired into a 429.
const RESERVED_RESOLVES: usize = 8;
/// How long a successful resolve keeps a key eligible for the reserve.
const KNOWN_GOOD_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CachedResolve>,
    in_flight: HashSet<String>,
    /// Keys that resolved to an org, with the time of the latest success. A
    /// failed resolve leaves the mark in place, so one upstream error or
    /// timeout during a flood does not push a tenant back into the shared pool.
    known_good: HashMap<String, Instant>,
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
    /// Taken only by keys in `known_good`, after `admission` is full.
    reserved: Semaphore,
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
            reserved: Semaphore::new(RESERVED_RESOLVES),
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
            reserved: Semaphore::new(RESERVED_RESOLVES),
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
        let known_good = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            // A hit tests only the requested entry. Sweeping every entry here
            // held this process-wide lock for the whole map on each request;
            // entries nobody asks for cannot grant access, and they are dropped
            // on insert and by `evict_expired`.
            if let Some(entry) = state.entries.get(&cache_key) {
                if entry.is_fresh(now) && !entry.is_superseded(&self.ledger) {
                    return entry.resolved.clone().map_err(|()| ResolveErr::Unresolved);
                }
                state.entries.remove(&cache_key);
            }
            let known_good = state
                .known_good
                .get(&cache_key)
                .is_some_and(|seen| now.duration_since(*seen) < KNOWN_GOOD_TTL);
            known_good
        };
        // Never queue unauthenticated work. Fresh cache hits remain available
        // while misses are saturated, and permits release when futures cancel.
        // A key that resolved before may fall back to the reserve, which a
        // flood of made-up tokens cannot reach.
        let _permit = match self.admission.try_acquire() {
            Ok(permit) => permit,
            Err(_) if known_good => self.reserved.try_acquire().map_err(|_| ResolveErr::Busy)?,
            Err(_) => return Err(ResolveErr::Busy),
        };
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
                // Negative entries go first, so made-up tokens cannot push a
                // tenant's valid entry out.
                if let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| (entry.resolved.is_ok(), entry.fetched_at))
                    .map(|(key, _)| key.clone())
                {
                    state.entries.remove(&oldest);
                }
            }
            if let Ok(fresh) = resolved.as_ref() {
                drop_superseded_versions(&mut state.entries, fresh);
                remember_known_good(&mut state.known_good, &cache_key, now);
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

    /// Drop every entry that a lookup would refuse: past its TTL, or named by
    /// an enforcement push newer than its fetch. Lookups test only their own
    /// key, so the housekeeping loop calls this to release idle entries.
    /// Returns how many entries were dropped.
    pub fn evict_expired(&self) -> usize {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        let ledger = &self.ledger;
        let before = state.entries.len();
        state
            .entries
            .retain(|_, entry| entry.is_fresh(now) && !entry.is_superseded(ledger));
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

/// Mark `key` as resolved at `now`. At the size cap the oldest mark goes, so
/// the set stays bounded however many tenants pass through.
fn remember_known_good(known_good: &mut HashMap<String, Instant>, key: &str, now: Instant) {
    if !known_good.contains_key(key) && known_good.len() >= MAX_ENTRIES {
        if let Some(oldest) = known_good
            .iter()
            .min_by_key(|(_, seen)| **seen)
            .map(|(key, _)| key.clone())
        {
            known_good.remove(&oldest);
        }
    }
    known_good.insert(key.to_owned(), now);
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "cache_lookup_tests.rs"]
mod lookup_tests;

#[cfg(test)]
#[path = "cache_flood_tests.rs"]
mod flood_tests;

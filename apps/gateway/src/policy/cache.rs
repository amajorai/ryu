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
//! Enabled only when a control-plane URL is configured (`CONTROL_PLANE_URL`); when
//! absent the dynamic path is a no-op and single-org behavior is unchanged. The
//! raw token is used only as the in-memory map key — it is never logged.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use super::{resolve_token, ResolvedOrg};

/// Env var with the control-plane base URL (no trailing `/api`). Same source as
/// [`super::PolicySource`] so the startup and dynamic paths reach one endpoint.
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";

/// Positive cache TTL: how long a successful resolve is reused.
const POSITIVE_TTL: Duration = Duration::from_secs(60);
/// Negative cache TTL: how long a failed resolve (invalid/revoked/unreachable) is
/// cached to blunt a resolve-DoS from a flood of bad bearers.
const NEGATIVE_TTL: Duration = Duration::from_secs(10);

/// Why a token failed to resolve. All variants map to a hard 401 at the caller —
/// an `rgw_`-shaped token that does not resolve is never let through as anonymous.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveErr {
    /// The token did not resolve to an org: invalid, revoked, or the control
    /// plane was unreachable. Caller returns 401.
    Unresolved,
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
        let ttl = if self.resolved.is_ok() {
            POSITIVE_TTL
        } else {
            NEGATIVE_TTL
        };
        now.duration_since(self.fetched_at) < ttl
    }
}

/// Caches token → org resolutions for the multi-tenant data plane.
pub struct ResolveCache {
    /// Control-plane base URL (no `/api` suffix).
    control_plane_url: String,
    http: reqwest::Client,
    entries: DashMap<String, CachedResolve>,
}

impl ResolveCache {
    /// Build from environment, sharing the gateway's HTTP client. Returns `None`
    /// when `CONTROL_PLANE_URL` is unset/empty — the dynamic path stays a no-op.
    pub fn from_env(http: reqwest::Client) -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL)
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(Self {
            control_plane_url: url.trim_end_matches('/').to_string(),
            http,
            entries: DashMap::new(),
        })
    }

    /// Resolve a token, serving a fresh cached value if present else calling the
    /// control plane and storing the outcome (positive or negative). The raw
    /// token is used only as the map key; it is never logged.
    pub async fn resolve_cached(&self, token: &str) -> Result<Arc<ResolvedOrg>, ResolveErr> {
        let now = Instant::now();
        if let Some(entry) = self.entries.get(token) {
            if entry.is_fresh(now) {
                return match &entry.resolved {
                    Ok(org) => Ok(Arc::clone(org)),
                    Err(()) => Err(ResolveErr::Unresolved),
                };
            }
        }

        // Miss or stale: hit the control plane. On failure, store a short-lived
        // negative entry so a flood of the same bad bearer doesn't hammer it.
        match resolve_token(&self.control_plane_url, &self.http, token).await {
            Ok(org) => {
                let arc = Arc::new(org);
                self.entries.insert(
                    token.to_string(),
                    CachedResolve {
                        resolved: Ok(Arc::clone(&arc)),
                        fetched_at: Instant::now(),
                    },
                );
                Ok(arc)
            }
            Err(_) => {
                self.entries.insert(
                    token.to_string(),
                    CachedResolve {
                        resolved: Err(()),
                        fetched_at: Instant::now(),
                    },
                );
                Err(ResolveErr::Unresolved)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::EffectivePolicy;

    fn sample_org() -> Arc<ResolvedOrg> {
        Arc::new(ResolvedOrg {
            org_id: "o1".to_string(),
            managed_inference: true,
            remaining_budget_micro_usd: Some(1000),
            policy: EffectivePolicy::default(),
        })
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
}

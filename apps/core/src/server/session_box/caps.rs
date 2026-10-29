//! Session Box admission (design §7.3), in order:
//!
//! 1. the per-owner running cap from the signed `ryu_limits.boxConcurrency`
//!    claim (a local owner with no claim falls through);
//! 2. a credit pre-flight: the wallet must hold at least the per-start
//!    minimum (5 minutes) of the size's rate, and must not be reported empty. The rate always comes from
//!    the Gateway (a live run's tick rate, else `POST /sandbox/quote`); when
//!    the Gateway cannot name it the Box is refused with
//!    `session_box_rate_unavailable` (503);
//! 3. the Box service's own `GET /v1/limits` for the node's tenant.
//!
//! Refusals are typed: `session_box_limit_reached` (429) and
//! `session_box_insufficient_credits` (402). The Box service enforces the same
//! caps from the tenant token, so these checks are early refusal and UX, not
//! the only line of defence.
use super::{
    api_error, box_client, cloud_tasks, live_session_boxes, ApiError, ResolvedAuthorization,
    SessionBoxKey, PREFLIGHT_SECONDS,
};
use axum::http::StatusCode;
use ryu_sandbox::{
    box_credential::BillingOwner,
    box_types::{BoxApiError, BoxLimits, BoxSize},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// How long the Box service's limits are reused for status reads.
const LIMITS_CACHE_TTL: Duration = Duration::from_secs(30);

/// Running Boxes and the cap that applies, for the session UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoxCaps {
    pub running: u32,
    /// The plan cap (signed claim) or, without one, the Box service's limit.
    pub max: Option<u32>,
}

/// The last caps seen per owner (claim cap and Box limits), for status reads
/// that carry no request authorization.
struct CachedCaps {
    claim: Option<u32>,
    limits: Option<(Instant, BoxLimits)>,
}

fn cache() -> &'static Mutex<HashMap<String, CachedCaps>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedCaps>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<String, CachedCaps>> {
    cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Running Boxes Core holds for `owner`: session and sub-agent Boxes plus
/// cloud task Boxes, leaving out `exclude` (the Box being admitted).
pub(super) fn running_for(owner: &str, exclude: Option<&SessionBoxKey>) -> u32 {
    live_session_boxes(owner, exclude).saturating_add(cloud_tasks::live_box_count(owner))
}

/// The signed running-Box cap of the caller, when its JWT carries one for this
/// node's org. A claim evaluated for another org is ignored (the Box service
/// still enforces the tenant's own caps).
pub(super) async fn claim_cap(auth: &ResolvedAuthorization) -> Option<u32> {
    let token = auth.verified_user_jwt.as_deref()?;
    let limits = crate::identity_verify::verified_limits(token).await?;
    let node_org = crate::server::node_org_id();
    if let (Some(node_org), Some(claim_org)) = (node_org.as_deref(), limits.org.as_deref()) {
        if node_org != claim_org {
            return None;
        }
    }
    Some(limits.limits.box_concurrency)
}

fn limit_reached() -> ApiError {
    api_error(
        StatusCode::TOO_MANY_REQUESTS,
        "session_box_limit_reached",
        "Your plan's limit of running Boxes is reached. Stop another session's Box first.",
    )
}

fn insufficient_credits() -> ApiError {
    api_error(
        StatusCode::PAYMENT_REQUIRED,
        "session_box_insufficient_credits",
        "There are not enough credits to start a Box. Top up to continue.",
    )
}

/// The Gateway's wallet answer: `{balance_micro_usd, empty}`. `None` when the
/// Gateway cannot answer, which leaves the decision to the first tick.
async fn wallet() -> Option<Value> {
    #[cfg(test)]
    if let Some(answer) = super::tests::test_wallet() {
        return answer;
    }
    let org = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let base = crate::sidecar::gateway::gateway_url();
    let mut request = crate::sidecar::gateway::gateway_http_client()
        .get(format!("{}/v1/wallet", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(3));
    if let Some(org) = org {
        request = request.query(&[("org_id", org)]);
    }
    if let Some(key) = crate::sidecar::gateway::gateway_admin_key() {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

/// The rate a new Box is held to by the credit pre-flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PreflightRate {
    /// Another owner bills this Box (settlement, subscription): Core does not
    /// hold it to a credit horizon.
    NotCoreMetered,
    /// The Gateway's live rate for the size, micro-USD per hour.
    Known(u64),
    /// Core meters the Box but the Gateway could not name a rate.
    Unknown,
}

/// How long a Gateway quote for a size is reused.
const QUOTE_TTL: Duration = Duration::from_secs(60);

/// The Gateway's hourly rate for `size`, as reported on the latest tick of a
/// live run of that size. The Gateway prices from its own table.
fn live_tick_rate(size: BoxSize) -> Option<u64> {
    ryu_sandbox::heartbeat::list_active_runs()
        .into_iter()
        .filter(|run| run.size == Some(size))
        .find_map(|run| run.rate_micro_usd_per_hour)
}

fn quote_cache() -> &'static Mutex<HashMap<BoxSize, (Instant, u64)>> {
    static QUOTES: OnceLock<Mutex<HashMap<BoxSize, (Instant, u64)>>> = OnceLock::new();
    QUOTES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget cached quotes (tests change the Gateway's answer between cases).
#[cfg(test)]
pub(super) fn clear_quotes() {
    quote_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}

/// The Gateway's quote for a Box of `size` (`POST /sandbox/quote`): its size
/// table when one is configured, else its per-resource rates plus markup for
/// the size's shape. A success is reused for [`QUOTE_TTL`]; a failure is not
/// remembered.
async fn quoted_rate(size: BoxSize) -> Option<u64> {
    let cached = quote_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&size)
        .copied();
    if let Some((at, rate)) = cached {
        if at.elapsed() < QUOTE_TTL {
            return Some(rate);
        }
    }
    #[cfg(test)]
    let answer = match super::tests::test_quote() {
        Some(answer) => answer,
        None => {
            ryu_sandbox::heartbeat::quote_rate(&ryu_sandbox::box_types::spec_for(size), Some(size))
                .await
        }
    };
    #[cfg(not(test))]
    let answer =
        ryu_sandbox::heartbeat::quote_rate(&ryu_sandbox::box_types::spec_for(size), Some(size))
            .await;
    match answer {
        Ok(rate) => {
            quote_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(size, (Instant::now(), rate));
            Some(rate)
        }
        Err(error) => {
            tracing::warn!(size = size.as_str(), %error, "the Gateway could not quote a Box rate");
            None
        }
    }
}

/// The rate the credit pre-flight checks a new Box of `size` against, always
/// from the Gateway: a live run's tick rate for that size, else the Gateway's
/// quote. Core keeps no price table of its own, so a Box Core meters whose
/// rate the Gateway cannot name is [`PreflightRate::Unknown`] (refused).
pub(super) async fn preflight_rate(size: BoxSize, core_meters: bool) -> PreflightRate {
    if !core_meters {
        return PreflightRate::NotCoreMetered;
    }
    if let Some(rate) = live_tick_rate(size) {
        return PreflightRate::Known(rate);
    }
    quoted_rate(size)
        .await
        .map_or(PreflightRate::Unknown, PreflightRate::Known)
}

/// The Gateway's live hourly rate for a Box of `size` (a live run's tick rate,
/// else its quote), whoever bills the Box. The one-time computer-use cost
/// notice shows it. `None` when the Gateway cannot name it.
pub(super) async fn hourly_rate(size: BoxSize) -> Option<u64> {
    if let Some(rate) = live_tick_rate(size) {
        return Some(rate);
    }
    quoted_rate(size).await
}

pub(super) fn rate_unavailable() -> ApiError {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "session_box_rate_unavailable",
        "Ryu could not read the Box rate to check your credits. Try again shortly.",
    )
}

/// The wallet answer leaves the decision to the rate: it reports a positive
/// balance that the rate must cover.
pub(super) fn wallet_needs_rate(wallet: Option<&Value>) -> bool {
    wallet.is_some_and(|wallet| {
        wallet.get("empty").and_then(Value::as_bool) != Some(true)
            && wallet
                .get("balance_micro_usd")
                .and_then(Value::as_i64)
                .is_some_and(|balance| balance > 0)
    })
}

/// The credit pre-flight decision for a wallet answer and the size's rate.
/// An unknown wallet leaves the decision to the first tick; a known positive
/// balance must cover the five-minute per-start minimum at the Gateway's rate
/// (what the run's first tick charges), and fails safe when that rate is
/// unknown.
pub(super) fn preflight_decision(
    wallet: Option<&Value>,
    rate: PreflightRate,
) -> Result<(), ApiError> {
    let Some(wallet) = wallet else {
        return Ok(());
    };
    if wallet.get("empty").and_then(Value::as_bool) == Some(true) {
        return Err(insufficient_credits());
    }
    let Some(balance) = wallet.get("balance_micro_usd").and_then(Value::as_i64) else {
        return Ok(());
    };
    if balance <= 0 {
        return Err(insufficient_credits());
    }
    match rate {
        PreflightRate::NotCoreMetered => Ok(()),
        PreflightRate::Unknown => Err(rate_unavailable()),
        PreflightRate::Known(rate) => {
            let needed = rate.saturating_mul(PREFLIGHT_SECONDS) / 3600;
            if u64::try_from(balance).unwrap_or(0) < needed {
                return Err(insufficient_credits());
            }
            Ok(())
        }
    }
}

/// The Box limits decision: refused when the tenant's running Boxes are at
/// its cap. An unknown answer (an older Box service) falls through.
pub(super) fn limits_decision(limits: Result<&BoxLimits, &BoxApiError>) -> Result<(), ApiError> {
    match limits {
        Ok(limits) if limits.running >= limits.max_running => Err(limit_reached()),
        Err(BoxApiError::InsufficientCredits) => Err(insufficient_credits()),
        Ok(_) | Err(_) => Ok(()),
    }
}

/// Admit one more running Box of `size` for `owner`. `exclude` is the session
/// Box being admitted (whose slot the caller holds), so it is not counted as
/// running yet.
pub(super) async fn admit(
    auth: &ResolvedAuthorization,
    owner: &str,
    exclude: Option<&SessionBoxKey>,
    size: BoxSize,
) -> Result<(), ApiError> {
    let claim = claim_cap(auth).await;
    remember_claim(owner, claim);
    if let Some(cap) = claim {
        if running_for(owner, exclude) >= cap {
            return Err(limit_reached());
        }
    }
    let client = box_client()
        .await
        .map_err(|_| super::unavailable("Ryu Box is not configured on this node."))?;
    let core_meters = !matches!(
        client.billing_owner(),
        BillingOwner::Settlement | BillingOwner::Subscription
    ) && !ryu_sandbox::box_backend::subscription_passthrough_active().await;
    let wallet = wallet().await;
    let rate = if wallet_needs_rate(wallet.as_ref()) {
        preflight_rate(size, core_meters).await
    } else {
        PreflightRate::NotCoreMetered
    };
    preflight_decision(wallet.as_ref(), rate)?;
    let limits = client.limits().await;
    if let Ok(limits) = &limits {
        remember_limits(owner, *limits);
    }
    limits_decision(limits.as_ref())
}

fn remember_claim(owner: &str, claim: Option<u32>) {
    lock_cache()
        .entry(owner.to_owned())
        .or_insert(CachedCaps {
            claim: None,
            limits: None,
        })
        .claim = claim;
}

fn remember_limits(owner: &str, limits: BoxLimits) {
    lock_cache()
        .entry(owner.to_owned())
        .or_insert(CachedCaps {
            claim: None,
            limits: None,
        })
        .limits = Some((Instant::now(), limits));
}

/// Refresh `owner`'s caps for a status read: the claim always, the Box limits
/// at most every 30 s.
pub(super) async fn refresh(auth: &ResolvedAuthorization, owner: &str) {
    let claim = claim_cap(auth).await;
    remember_claim(owner, claim);
    if claim.is_some() {
        return;
    }
    let fresh = lock_cache()
        .get(owner)
        .and_then(|cached| cached.limits.as_ref())
        .is_some_and(|(fetched, _)| fetched.elapsed() < LIMITS_CACHE_TTL);
    if fresh {
        return;
    }
    let limits = tokio::time::timeout(Duration::from_secs(3), async {
        box_client().await.ok()?.limits().await.ok()
    })
    .await
    .ok()
    .flatten();
    if let Some(limits) = limits {
        remember_limits(owner, limits);
    }
}

/// The caps last seen for `owner`: the claim cap with Core's running count,
/// or the Box service's tenant limits. `None` when neither is known.
pub(crate) fn cached_caps(owner: &str) -> Option<BoxCaps> {
    let cache = lock_cache();
    let cached = cache.get(owner)?;
    if let Some(max) = cached.claim {
        return Some(BoxCaps {
            running: running_for(owner, None),
            max: Some(max),
        });
    }
    cached.limits.as_ref().map(|(_, limits)| BoxCaps {
        running: limits.running,
        max: Some(limits.max_running),
    })
}

/// Forget every cached cap (tests).
#[cfg(test)]
pub(super) fn clear_cache() {
    lock_cache().clear();
}

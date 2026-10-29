//! Ladder levels L2 (Throttle) and L3 (Restrict) on the hosted fleet
//! (managed guardrails spec 04.8.1 and 04.9.1), and the tighter rate limit
//! for gateway keys younger than a day.
//!
//! Where it binds. Everything here applies on `Fleet` custody only, the same
//! stand-in for "floor-bound" that `standing`'s `floor_bound` refusal and the
//! platform floor use: every `rgw_` resolve on the fleet spends Ryu's
//! credentials (decision D9). A managed node holds no Ryu keys and a
//! self-hosted node spends its operator's keys, so their traffic is never
//! throttled or restricted by Ryu's ladder.
//!
//! Inputs. The ladder arrives on the resolve's `standing` (wire contract in
//! [`crate::standing`]); a `restricted` state is org-scope L3. The key's age
//! comes from `credential.createdAt` on the same resolve. An enforcement push
//! drops the cached resolution, so the next request applies the new levels.
//! A request already running keeps the levels it was admitted under; only a
//! refusing standing stops it mid-flight ([`crate::standing::StandingGuard`]).
//!
//! What each level does on the fleet:
//!
//! | Level | Effect |
//! |---|---|
//! | L0, L1 | nothing here (Warn is a notice the control plane sends) |
//! | L2 Throttle | a per-subject request rate and in-flight cap, refused with 429 `abuse_throttled` |
//! | L3 Restrict | L2, plus: every flagged hazard code blocks, no media generation, no own-supply vendor slots, and only models on the floor's `restrictedModels` list; refused with 403 `account_restricted` |
//!
//! A throttle entry without numbers takes [`DEFAULT_THROTTLE_RPM`] and
//! [`DEFAULT_THROTTLE_CONCURRENCY`], never "no throttle". An empty or absent
//! `restrictedModels` list admits no model at L3. Both refusals are platform
//! account actions, so they carry `remedy: "appeal"` and the standing's
//! appeal link.
//!
//! New keys. A key whose `createdAt` is less than [`NEW_KEY_AGE_SECS`] old is
//! held to [`NEW_KEY_RPM`] requests a minute and [`NEW_KEY_CONCURRENCY`] in
//! flight, refused with 429 `new_key_rate_limited`. This is a default, not
//! an action on the account, so it offers no appeal. A resolve without
//! `createdAt` leaves the limit off: the Gateway has no other trustworthy
//! age for a key, and a local first-seen time would make every key new
//! again after each restart.
//!
//! Every rate and in-flight cap is this replica's share of a fleet-wide
//! figure ([`crate::org_limits::rate_share`] over the resolve's
//! `activeGateways`).

use std::sync::Arc;

use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::policy::ResolvedOrg;
use crate::state::AppState;

/// Requests a minute for a throttled subject the control plane sent no rate
/// for. Matches the platform floor's degraded-mode minimum (spec 02.3.1).
pub const DEFAULT_THROTTLE_RPM: u64 = 10;
/// In-flight requests for a throttled subject the control plane sent no cap
/// for. Matches the degraded-mode concurrency per org (spec 02.3.1).
pub const DEFAULT_THROTTLE_CONCURRENCY: u32 = 4;
/// A key younger than this is a new key.
pub const NEW_KEY_AGE_SECS: i64 = 24 * 60 * 60;
/// Requests a minute for a new key.
pub const NEW_KEY_RPM: u64 = 30;
/// In-flight requests for a new key.
pub const NEW_KEY_CONCURRENCY: u32 = 4;
/// Seconds a client waits after an in-flight refusal.
const CONCURRENCY_RETRY_AFTER_SECS: u64 = 2;
/// The most ladder entries one standing may carry.
const MAX_LADDER_ENTRIES: usize = 16;
/// The most models the floor's restricted list may carry.
pub const MAX_RESTRICTED_MODELS: usize = 512;

// ─── Wire ──────────────────────────────────────────────────────────────────

/// Which subject a ladder entry names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LadderScope {
    Org,
    Credential,
    User,
    /// A tenant's end user (spec 04.3). Parsed so one flagged end user never
    /// fails the whole key, but not enforced from resolve: the resolve names
    /// the key, not the end user a request carries.
    EndUser,
    /// A trusted forwarder's user. Parsed and not enforced from resolve, as
    /// for [`Self::EndUser`].
    ForwardedUser,
}

impl LadderScope {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Org => "org",
            Self::Credential => "credential",
            Self::User => "user",
            Self::EndUser => "end_user",
            Self::ForwardedUser => "forwarded_user",
        }
    }

    /// Whether this Gateway applies entries of this scope from resolve.
    const fn enforced_from_resolve(self) -> bool {
        matches!(self, Self::Org | Self::Credential | Self::User)
    }
}

/// One subject's ladder level as the control plane sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LadderEntry {
    pub scope: LadderScope,
    /// The subject's id. `None` names the resolved org or credential.
    pub subject_id: Option<String>,
    /// 0 to 3. Levels 4 and 5 are refusals and travel as a `state`.
    pub level: u8,
    pub rpm: Option<u64>,
    pub concurrency: Option<u32>,
    pub reason_class: Option<String>,
    pub until: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireEntry {
    scope: LadderScope,
    #[serde(default)]
    subject_id: Option<String>,
    level: u8,
    #[serde(default)]
    rpm: Option<u64>,
    #[serde(default)]
    concurrency: Option<u32>,
    #[serde(default)]
    reason_class: Option<String>,
    #[serde(default)]
    until: Option<String>,
}

/// Why a ladder could not be read. The caller refuses the whole standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedLadder;

impl LadderEntry {
    /// Parse the standing's `ladder`. Absent or `null` is empty. Anything
    /// else must be an array of well-formed entries, or the standing fails
    /// closed.
    pub fn list_from_wire(value: Option<&Value>) -> Result<Vec<Self>, MalformedLadder> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(Vec::new());
        };
        let items = value.as_array().ok_or(MalformedLadder)?;
        if items.len() > MAX_LADDER_ENTRIES {
            return Err(MalformedLadder);
        }
        items.iter().map(Self::from_wire).collect()
    }

    fn from_wire(value: &Value) -> Result<Self, MalformedLadder> {
        let wire = WireEntry::deserialize(value).map_err(|_| MalformedLadder)?;
        if wire.level > 3 || wire.rpm == Some(0) || wire.concurrency == Some(0) {
            return Err(MalformedLadder);
        }
        let subject_id = match wire.subject_id {
            None => None,
            Some(id) if valid_id(&id) => Some(id),
            Some(_) => return Err(MalformedLadder),
        };
        let names_itself = matches!(wire.scope, LadderScope::Org | LadderScope::Credential);
        if !names_itself && subject_id.is_none() {
            // A user or end user is not named anywhere else on the resolve.
            return Err(MalformedLadder);
        }
        let label = |value: Option<String>| {
            value.and_then(|value| crate::standing::label(value, crate::standing::MAX_LABEL_BYTES))
        };
        Ok(Self {
            scope: wire.scope,
            subject_id,
            level: wire.level,
            rpm: wire.rpm,
            concurrency: wire.concurrency,
            reason_class: label(wire.reason_class),
            until: label(wire.until),
        })
    }

    /// The org-scope L3 a `restricted` standing state means.
    pub fn org_restricted(reason_class: Option<String>, until: Option<String>) -> Self {
        Self {
            scope: LadderScope::Org,
            subject_id: None,
            level: 3,
            rpm: None,
            concurrency: None,
            reason_class,
            until,
        }
    }
}

/// A non-empty, trimmed, control-free id of at most 256 bytes.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
}

// ─── Posture ───────────────────────────────────────────────────────────────

/// One throttled subject on this request.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Throttle {
    /// Rate-bucket and in-flight key: `abuse:<scope>:<subject>`.
    key: String,
    rpm: u64,
    concurrency: u32,
}

/// What an account refusal tells the tenant.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LadderRefusal {
    pub appeal_url: Option<String>,
    pub reason_class: Option<String>,
    pub until: Option<String>,
    /// Seconds before a throttled request may be retried.
    pub retry_after_secs: Option<u64>,
}

impl LadderRefusal {
    /// The 00.7 error object for `code`.
    pub fn error_object(&self, code: &str, error_type: &str, message: &str) -> Value {
        let mut error = json!({
            "message": message,
            "type": error_type,
            "code": code,
            "layer": "platform",
            "remedy": "appeal",
        });
        if let Some(url) = self.appeal_url.as_deref() {
            error["appeal_url"] = json!(url);
        }
        if let Some(reason) = self.reason_class.as_deref() {
            error["reason_class"] = json!(reason);
        }
        if let Some(until) = self.until.as_deref() {
            error["until"] = json!(until);
        }
        if let Some(seconds) = self.retry_after_secs {
            error["retry_after"] = json!(seconds);
        }
        error
    }
}

/// The ladder and new-key posture of one request on the fleet.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Posture {
    throttles: Vec<Throttle>,
    /// The longest-lasting L3 entry, when one applies.
    restricted: Option<LadderRefusal>,
    /// The throttle refusal detail: the first entry at the highest level.
    throttled: Option<LadderRefusal>,
    /// The new-key bucket, when the key is under a day old.
    new_key: Option<String>,
}

/// The bucket subject `entry` names on this request, or `None` when it names
/// no principal the request carries. Only a matching entry binds:
///
/// - `org`: no `subjectId`, or the resolved org's id;
/// - `credential`: no `subjectId` (the presenting key), or the presenting
///   key's id. A key-less resolve has no id to match, so only an id-less
///   entry binds, and the org bucket stands in for the key, which is
///   stricter, never looser;
/// - `user`: the request's JWT-verified user only. A request with no
///   verified user, or another one, is not that user's traffic, even on a
///   shared org key;
/// - `end_user`, `forwarded_user`: never from resolve.
fn ladder_subject(
    entry: &LadderEntry,
    resolved: &ResolvedOrg,
    user_id: Option<&str>,
) -> Option<String> {
    let named = entry.subject_id.as_deref();
    match entry.scope {
        LadderScope::Org => named
            .is_none_or(|id| id == resolved.org_id)
            .then(|| resolved.org_id.clone()),
        LadderScope::Credential => match (named, resolved.credential_id.as_deref()) {
            (None, Some(credential)) => Some(credential.to_owned()),
            (None, None) => Some(resolved.org_id.clone()),
            (Some(id), Some(credential)) if id == credential => Some(credential.to_owned()),
            (Some(_), _) => None,
        },
        LadderScope::User => match (named, user_id) {
            (Some(id), Some(user)) if id == user => Some(user.to_owned()),
            _ => None,
        },
        LadderScope::EndUser | LadderScope::ForwardedUser => None,
    }
}

/// Whether an action ending at `candidate` outlasts one ending at `held`.
/// No end (open-ended) outlasts any end; two ends compare as instants, or as
/// text when either does not parse.
fn outlasts(candidate: Option<&str>, held: Option<&str>) -> bool {
    match (candidate, held) {
        (None, Some(_)) => true,
        (Some(candidate), Some(held)) => {
            match (
                chrono::DateTime::parse_from_rfc3339(candidate),
                chrono::DateTime::parse_from_rfc3339(held),
            ) {
                (Ok(candidate), Ok(held)) => candidate > held,
                _ => candidate > held,
            }
        }
        (_, None) => false,
    }
}

impl Posture {
    /// The posture `resolved`'s ladder gives a request from `user_id`, the
    /// request's JWT-verified user (never a forwarded header).
    ///
    /// Entries for one bucket merge: the bucket keeps the lowest rate and
    /// in-flight cap any of them sets (an entry without a number counts as
    /// the default), and any level 3 entry restricts, whatever the order.
    fn of(
        resolved: &ResolvedOrg,
        user_id: Option<&str>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        let standing = &resolved.standing;
        let mut posture = Self::default();
        // The level of the entry `throttled` was taken from.
        let mut throttled_level = 0;
        for entry in standing
            .ladder
            .iter()
            .filter(|entry| entry.level >= 2 && entry.scope.enforced_from_resolve())
        {
            let Some(subject) = ladder_subject(entry, resolved, user_id) else {
                continue;
            };
            let key = format!("abuse:{}:{subject}", entry.scope.as_str());
            let rpm = entry.rpm.unwrap_or(DEFAULT_THROTTLE_RPM);
            let concurrency = entry.concurrency.unwrap_or(DEFAULT_THROTTLE_CONCURRENCY);
            match posture
                .throttles
                .iter_mut()
                .find(|throttle| throttle.key == key)
            {
                Some(throttle) => {
                    throttle.rpm = throttle.rpm.min(rpm);
                    throttle.concurrency = throttle.concurrency.min(concurrency);
                }
                None => posture.throttles.push(Throttle {
                    key,
                    rpm,
                    concurrency,
                }),
            }
            let refusal = LadderRefusal {
                appeal_url: standing.appeal_url.clone(),
                reason_class: entry.reason_class.clone(),
                until: entry.until.clone(),
                retry_after_secs: None,
            };
            if entry.level > throttled_level {
                throttled_level = entry.level;
                posture.throttled = Some(refusal.clone());
            }
            if entry.level >= 3 {
                let replaces = posture
                    .restricted
                    .as_ref()
                    .is_none_or(|held| outlasts(refusal.until.as_deref(), held.until.as_deref()));
                if replaces {
                    posture.restricted = Some(refusal);
                }
            }
        }
        if let (Some(credential), Some(created_at)) = (
            resolved.credential_id.as_deref(),
            resolved.credential_created_at,
        ) {
            let age = now.signed_duration_since(created_at).num_seconds();
            if age < NEW_KEY_AGE_SECS {
                posture.new_key = Some(format!("newkey:{credential}"));
            }
        }
        posture
    }

    fn is_empty(&self) -> bool {
        self.throttles.is_empty() && self.new_key.is_none()
    }
}

// ─── In-flight caps ────────────────────────────────────────────────────────

/// Per-subject in-flight counters, one per process.
#[derive(Debug, Default)]
pub struct InFlight {
    counts: DashMap<String, u32>,
}

impl InFlight {
    /// Take one slot of `cap` under `key`, or `None` when all are taken.
    fn acquire(self: &Arc<Self>, key: &str, cap: u32) -> Option<Slot> {
        let mut count = self.counts.entry(key.to_owned()).or_insert(0);
        if *count >= cap {
            return None;
        }
        *count += 1;
        drop(count);
        Some(Slot {
            counts: Arc::clone(self),
            key: key.to_owned(),
        })
    }

    /// Requests in flight under `key`.
    #[cfg(test)]
    pub fn count(&self, key: &str) -> u32 {
        self.counts.get(key).map_or(0, |count| *count)
    }
}

/// One held in-flight slot, given back on drop.
#[derive(Debug)]
struct Slot {
    counts: Arc<InFlight>,
    key: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let emptied = match self.counts.counts.get_mut(&self.key) {
            Some(mut count) => {
                *count = count.saturating_sub(1);
                *count == 0
            }
            None => false,
        };
        if emptied {
            self.counts
                .counts
                .remove_if(&self.key, |_, count| *count == 0);
        }
    }
}

// ─── Per-request enforcement ───────────────────────────────────────────────

/// A fleet request's ladder posture and the in-flight slots it holds. It
/// rides on the [`RequestContext`] behind an `Arc`, so the slots are given
/// back when the last clone of the request (a stream body included) drops.
#[derive(Debug)]
pub struct Enforcement {
    posture: Posture,
    active_gateways: Option<u64>,
    _slots: Vec<Slot>,
}

impl Enforcement {
    /// Admit a resolved `rgw_` request: build its posture and take its
    /// in-flight slots. `Ok(None)` off the fleet or when nothing applies.
    /// `user_id` is the request's JWT-verified user, which `user` ladder
    /// entries are matched against.
    pub fn admit(
        state: &AppState,
        resolved: &ResolvedOrg,
        user_id: Option<&str>,
    ) -> Result<Option<Arc<Self>>, GatewayError> {
        Self::admit_at(
            state.custody,
            &state.abuse_in_flight,
            resolved,
            user_id,
            chrono::Utc::now(),
        )
    }

    fn admit_at(
        custody: GatewayCustody,
        in_flight: &Arc<InFlight>,
        resolved: &ResolvedOrg,
        user_id: Option<&str>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Option<Arc<Self>>, GatewayError> {
        if !custody.is_fleet() {
            return Ok(None);
        }
        let posture = Posture::of(resolved, user_id, now);
        if posture.is_empty() {
            return Ok(None);
        }
        let share = |cap: u32| {
            let share = crate::org_limits::rate_share(u64::from(cap), resolved.active_gateways);
            u32::try_from(share).unwrap_or(u32::MAX)
        };
        let mut slots = Vec::new();
        for throttle in &posture.throttles {
            match in_flight.acquire(&throttle.key, share(throttle.concurrency)) {
                Some(slot) => slots.push(slot),
                None => {
                    let mut refusal = posture.throttled.clone().unwrap_or_default();
                    refusal.retry_after_secs = Some(CONCURRENCY_RETRY_AFTER_SECS);
                    return Err(GatewayError::AbuseThrottled(Box::new(refusal)));
                }
            }
        }
        if let Some(key) = posture.new_key.as_deref() {
            match in_flight.acquire(key, share(NEW_KEY_CONCURRENCY)) {
                Some(slot) => slots.push(slot),
                None => {
                    return Err(GatewayError::NewKeyRateLimited {
                        retry_after_secs: CONCURRENCY_RETRY_AFTER_SECS,
                    })
                }
            }
        }
        Ok(Some(Arc::new(Self {
            posture,
            active_gateways: resolved.active_gateways,
            _slots: slots,
        })))
    }

    /// Whether ladder L3 applies to this request.
    pub fn restricted(&self) -> bool {
        self.posture.restricted.is_some()
    }

    fn restriction(&self) -> GatewayError {
        GatewayError::AccountRestricted(Box::new(
            self.posture.restricted.clone().unwrap_or_default(),
        ))
    }
}

/// Whether ladder L3 applies to `ctx`.
pub fn is_restricted(ctx: &RequestContext) -> bool {
    ctx.enforcement
        .as_deref()
        .is_some_and(Enforcement::restricted)
}

/// Whether `ctx` is above ladder Warn (throttled or restricted). The
/// screener's degraded mode refuses such a request outright instead of
/// serving it at the degraded rate (spec 02.9).
pub fn is_above_warn(ctx: &RequestContext) -> bool {
    ctx.enforcement
        .as_deref()
        .is_some_and(|enforcement| !enforcement.posture.throttles.is_empty())
}

/// Admit one request against its throttled subjects' rates, then the
/// new-key rate. Each bucket is this replica's share of the fleet rate.
/// Called beside every org-limit request check, so chat, compat, media,
/// embeddings, web and provider calls all count.
pub fn admit_rate(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    let Some(enforcement) = ctx.enforcement.as_deref() else {
        return Ok(());
    };
    let posture = &enforcement.posture;
    let share = |rpm: u64| crate::org_limits::rate_share(rpm, enforcement.active_gateways);
    if !posture.throttles.is_empty() {
        let ceilings: Vec<(String, u64)> = posture
            .throttles
            .iter()
            .map(|throttle| (throttle.key.clone(), share(throttle.rpm)))
            .collect();
        if !state.org_rate.check_requests_all(&ceilings) {
            let slowest = ceilings.iter().map(|(_, rpm)| *rpm).min().unwrap_or(1);
            let mut refusal = posture.throttled.clone().unwrap_or_default();
            refusal.retry_after_secs = Some(retry_after(slowest));
            return Err(GatewayError::AbuseThrottled(Box::new(refusal)));
        }
    }
    if let Some(key) = posture.new_key.as_deref() {
        let rpm = share(NEW_KEY_RPM);
        if !state.org_rate.check_request(key, rpm) {
            return Err(GatewayError::NewKeyRateLimited {
                retry_after_secs: retry_after(rpm),
            });
        }
    }
    Ok(())
}

/// Seconds until a bucket of `rpm` refills one request.
fn retry_after(rpm: u64) -> u64 {
    60u64.div_ceil(rpm.max(1)).max(1)
}

/// Refuse a media generation or transcription request at L3.
pub fn refuse_media(ctx: &RequestContext) -> Result<(), GatewayError> {
    match ctx.enforcement.as_deref() {
        Some(enforcement) if enforcement.restricted() => Err(enforcement.restriction()),
        _ => Ok(()),
    }
}

/// Whether `model` may be dispatched at L3: listed on the floor's
/// `restrictedModels`, and not a route that lets the upstream choose the
/// model (`openrouter/auto` and other `auto` ids).
fn restricted_model_allowed(state: &AppState, model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    if lower == "auto" || lower.ends_with("/auto") {
        return false;
    }
    crate::platform_floor::binding_floor(state.custody, &state.platform_floor).is_some_and(
        |floor| {
            floor
                .restricted_models
                .iter()
                .any(|allowed| allowed == model)
        },
    )
}

/// Refuse a route a restricted request may not dispatch: an own-supply
/// vendor slot, or a model off the floor's restricted list. Checked on the
/// model and slot each attempt will actually dispatch, after aliases, smart
/// routing, budget downgrades and fallback.
pub fn authorize_route(
    state: &AppState,
    ctx: &RequestContext,
    provider: &str,
    model: &str,
) -> Result<(), GatewayError> {
    let Some(enforcement) = ctx.enforcement.as_deref().filter(|e| e.restricted()) else {
        return Ok(());
    };
    let own_supply = crate::credit_pools::pool_for_gateway_provider(provider)
        .is_some_and(crate::credit_pools::is_own_supply_pool);
    if own_supply || !restricted_model_allowed(state, model) {
        return Err(enforcement.restriction());
    }
    Ok(())
}

/// Whether a model in a forwarded OpenRouter `models` fallback list may stay
/// in it. Off L3 every model may.
pub fn keeps_fallback_model(state: &AppState, ctx: &RequestContext, model: &str) -> bool {
    !is_restricted(ctx) || restricted_model_allowed(state, model)
}

/// A screener decision under ladder L3: every flagged code blocks.
pub fn strict(
    action: crate::screening::policy::CodeAction,
    restricted: bool,
) -> crate::screening::policy::CodeAction {
    use crate::screening::policy::CodeAction;
    match action {
        CodeAction::Flag if restricted => CodeAction::Block,
        other => other,
    }
}

#[cfg(test)]
#[path = "enforcement_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "enforcement_probe_tests.rs"]
mod probe_tests;

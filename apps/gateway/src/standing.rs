//! Platform standing (managed guardrails spec 05.5) and enforcement pushes.
//!
//! Every `/gateway/resolve` call advertises `x-ryu-resolve-capabilities:
//! standing,platform_floor`, so the control plane answers a suspended or banned credential
//! with a 200 that carries a `standing` object instead of a non-2xx (which
//! would surface as a generic 401). The wire contract is documented in
//! `packages/api/src/lib/gateway-standing.ts`:
//!
//! ```jsonc
//! "standing": {
//!   "state": "active" | "restricted" | "org_suspended" | "user_banned"
//!          | "key_suspended" | "standing_unavailable",
//!   "refuses": "none" | "floor_bound" | "all",
//!   "reasonClass": "fraud" | null,
//!   "until": "2026-11-01T00:00:00.000Z" | null,
//!   "appealUrl": "https://.../appeal" | null,
//!   "enforcementVersion": 0,
//!   // Optional. Ladder levels below a refusal (spec 04.8.1), one entry per
//!   // subject. Absent or null is an empty ladder.
//!   "ladder": [
//!     { "scope": "org" | "credential" | "user" | "end_user" | "forwarded_user",
//!       "subjectId": "..." | null,   // defaults to the resolved org or credential
//!       "level": 0 | 1 | 2 | 3,      // 2 throttle, 3 restrict (and throttle)
//!       "rpm": 6 | null,             // the narrowed rate; null takes the default
//!       "concurrency": 2 | null,     // in-flight requests; null takes the default
//!       "reasonClass": "..." | null,
//!       "until": "2026-11-01T00:00:00.000Z" | null }
//!   ]
//! }
//! ```
//!
//! A `ladder` that is not an array, or an entry with an unknown scope, a
//! level above 3, a zero rate, a field of the wrong type, or a `user`,
//! `end_user` or `forwarded_user` entry without a `subjectId`, makes the
//! whole standing unavailable (503 `standing_unavailable`), the same as any
//! other malformed standing. `end_user` and `forwarded_user` entries parse
//! but are not enforced from resolve yet. A `restricted` state is ladder L3 for the org. What
//! each level does is in [`crate::enforcement`].
//!
//! An entry binds only to a principal the request carries:
//!
//! - `org`: no `subjectId`, or the resolved org's id;
//! - `credential`: no `subjectId`, or the presenting key's id;
//! - `user`: the user a forwarded user JWT verified for this request. The
//!   forwarded `x-ryu-user-id` header never counts, and a request without a
//!   verified user matches no `user` entry, so most `rgw_` API traffic
//!   carries none. An action on everything a key sends must travel as a
//!   `credential` entry.
//!
//! Entries that name the same bucket merge: the lowest `rpm` and
//! `concurrency` win (a null counts as the default), and any level 3 entry
//! restricts, in whatever order the entries arrive.
//!
//! Parsing fails closed: a missing or malformed object, an unknown `state` or
//! an unknown `refuses` value all refuse every request with a retryable 503
//! `standing_unavailable`. The effective refusal is the stricter of what the
//! state implies and what `refuses` says, so a `user_banned` that claims to
//! refuse nothing still refuses everything.
//!
//! A `floor_bound` refusal applies on `Fleet` custody only. Every `rgw_`
//! resolve on the fleet spends Ryu credentials (decision D9); a managed node
//! is a client of the fleet and holds no Ryu keys, and a self-hosted node
//! spends its operator's keys, so their BYOK traffic keeps running.
//!
//! Enforcement pushes. The control plane calls
//! `POST /internal/enforcement/invalidate` with `{ orgId?, credentialId?,
//! userId?, enforcementVersion }` when it changes a standing. The request is
//! authenticated with `x-ryu-internal-secret` (the fleet's
//! `RYU_VAULT_INTERNAL_SECRET`, compared in constant time). It busts every
//! matching [`crate::policy::ResolveCache`] entry at once and records the
//! version per subject, so a replayed or reordered older push is ignored.
//! Requests already running carry a [`StandingGuard`]: tool loops check it
//! before each round and streams before each output window, and when a newer
//! push names their subject they re-resolve and stop on a refusing standing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{extract::State, http::HeaderMap, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::policy::{CredentialUse, ResolveErr, ResolvedOrg};
use crate::state::{AppState, SharedState};

/// Request header a resolve consumer uses to advertise what it reads.
pub const RESOLVE_CAPABILITIES_HEADER: &str = "x-ryu-resolve-capabilities";
/// The capability tokens this gateway reads, comma separated. Each one turns
/// a control-plane read failure from a non-2xx resolve into a 200 that names
/// it, so only capabilities the gateway enforces belong here: `standing`
/// (refused at auth) and `platform_floor` (an unavailable floor keeps the one
/// held, and the fleet refuses when it holds none, see
/// [`crate::platform_floor`]).
pub const RESOLVE_CAPABILITIES: &str = "standing,platform_floor";
/// Header carrying the fleet's internal secret on an enforcement push.
pub const INTERNAL_SECRET_HEADER: &str = "x-ryu-internal-secret";
/// The environment variable holding that secret on a fleet replica.
const ENV_INTERNAL_SECRET: &str = "RYU_VAULT_INTERNAL_SECRET";
/// Seconds a client waits before retrying `standing_unavailable`. Matches the
/// resolve cache's negative TTL, which is how long such an answer is reused.
pub const STANDING_RETRY_AFTER_SECS: u64 = 10;
/// The largest enforcement push body accepted.
pub const MAX_PUSH_BYTES: usize = 4096;
/// Subject high-water marks kept before the lowest is evicted. Evicting one
/// can only make a later replay of that subject bust its entries again,
/// which is harmless.
const MAX_LEDGER_SUBJECTS: usize = 65_536;
/// How long an in-flight recheck waits for a concurrent resolve of the same
/// token before it fails closed.
const RECHECK_BUSY_ATTEMPTS: u32 = 40;
const RECHECK_BUSY_WAIT: Duration = Duration::from_millis(25);
/// Longest `reasonClass` and `until` value carried into an error body.
pub(crate) const MAX_LABEL_BYTES: usize = 128;
/// Longest `appealUrl` carried into an error body.
const MAX_URL_BYTES: usize = 2048;

/// The standing states the control plane sends. Anything else is `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandingState {
    Active,
    Restricted,
    OrgSuspended,
    UserBanned,
    KeySuspended,
    StandingUnavailable,
    #[serde(other)]
    Unknown,
}

/// What a standing refuses. Ordered from least to most strict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandingRefusal {
    None,
    FloorBound,
    All,
}

/// The `refuses` field as sent: one of [`StandingRefusal`] or unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WireRefusal {
    None,
    FloorBound,
    All,
    #[serde(other)]
    Unknown,
}

/// The `standing` object as sent. Every field defaults, so a missing field
/// becomes `None` here and the conversion below decides what it means.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStanding {
    #[serde(default)]
    state: Option<StandingState>,
    #[serde(default)]
    refuses: Option<WireRefusal>,
    #[serde(default)]
    reason_class: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    appeal_url: Option<String>,
    #[serde(default)]
    enforcement_version: Option<u64>,
    /// Ladder levels below a refusal (spec 04.8.1), parsed by
    /// [`crate::enforcement::LadderEntry::from_wire`]. Absent or `null` is
    /// an empty ladder; anything else that does not parse makes the whole
    /// standing unavailable.
    #[serde(default)]
    ladder: Option<Value>,
}

/// One credential's platform standing, as the gateway enforces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformStanding {
    pub state: StandingState,
    /// The stricter of what `state` implies and what the wire `refuses` said.
    pub refuses: StandingRefusal,
    /// Platform reason class shown to the tenant, when one applies.
    pub reason_class: Option<String>,
    /// ISO 8601 end of a temporary action, when it has one.
    pub until: Option<String>,
    /// The public appeal page, when an appeal applies.
    pub appeal_url: Option<String>,
    /// The control plane's enforcement channel version (0 until it exists).
    pub enforcement_version: u64,
    /// Throttle (L2) and restrict (L3) levels on this credential's subjects,
    /// applied on the hosted fleet by [`crate::enforcement`]. A `restricted`
    /// state adds an org-scope L3 entry here.
    pub ladder: Vec<crate::enforcement::LadderEntry>,
}

impl Default for PlatformStanding {
    /// No standing was read: refuse everything.
    fn default() -> Self {
        Self::unavailable()
    }
}

impl PlatformStanding {
    /// The standing that refuses everything because none could be read.
    pub fn unavailable() -> Self {
        Self {
            state: StandingState::StandingUnavailable,
            refuses: StandingRefusal::All,
            reason_class: None,
            until: None,
            appeal_url: None,
            enforcement_version: 0,
            ladder: Vec::new(),
        }
    }

    /// A standing that refuses nothing, for tests and resolve literals.
    #[cfg(test)]
    pub fn active() -> Self {
        Self {
            state: StandingState::Active,
            refuses: StandingRefusal::None,
            reason_class: None,
            until: None,
            appeal_url: None,
            enforcement_version: 0,
            ladder: Vec::new(),
        }
    }

    /// Parse the resolve response's `standing` value. Absent, `null`, not an
    /// object, or any field of the wrong type: unavailable (fail closed).
    pub fn from_wire(value: Option<&Value>) -> Self {
        let Some(value) = value.filter(|value| value.is_object()) else {
            return Self::unavailable();
        };
        let Ok(wire) = WireStanding::deserialize(value) else {
            return Self::unavailable();
        };
        let state = wire.state.unwrap_or(StandingState::Unknown);
        let declared = match wire.refuses {
            Some(WireRefusal::None) => StandingRefusal::None,
            Some(WireRefusal::FloorBound) => StandingRefusal::FloorBound,
            Some(WireRefusal::All) => StandingRefusal::All,
            // A missing or unknown refusal reads as the strictest one.
            Some(WireRefusal::Unknown) | None => StandingRefusal::All,
        };
        let Ok(mut ladder) = crate::enforcement::LadderEntry::list_from_wire(wire.ladder.as_ref())
        else {
            return Self::unavailable();
        };
        let reason_class = wire
            .reason_class
            .and_then(|value| label(value, MAX_LABEL_BYTES));
        let until = wire.until.and_then(|value| label(value, MAX_LABEL_BYTES));
        if state == StandingState::Restricted {
            // The control plane's org restriction (spec 05.5) is ladder L3
            // for the whole org.
            ladder.push(crate::enforcement::LadderEntry::org_restricted(
                reason_class.clone(),
                until.clone(),
            ));
        }
        Self {
            state,
            refuses: declared.max(implied_refusal(state)),
            reason_class,
            until,
            appeal_url: wire.appeal_url.and_then(appeal_url),
            enforcement_version: wire.enforcement_version.unwrap_or(0),
            ladder,
        }
    }

    /// Whether this standing serves every request (no refusal of any kind).
    pub fn serves_everything(&self) -> bool {
        self.refuses == StandingRefusal::None
    }

    /// The refusal this standing makes on a gateway of `custody`, if any.
    pub fn refusal(&self, custody: GatewayCustody) -> Option<GatewayError> {
        let refused = match self.refuses {
            StandingRefusal::None => false,
            StandingRefusal::FloorBound => custody.is_fleet(),
            StandingRefusal::All => true,
        };
        refused.then(|| self.error())
    }

    /// The 00.7 catalogue error for a refusing standing.
    fn error(&self) -> GatewayError {
        let (code, message) = match self.state {
            StandingState::OrgSuspended => ("org_suspended", "This organization is suspended."),
            StandingState::UserBanned => (
                "user_banned",
                "The account that owns this gateway key is banned.",
            ),
            StandingState::KeySuspended => {
                ("key_suspended_abuse", "This gateway key is suspended.")
            }
            // Unreadable, unknown, or a refusal the state cannot explain
            // (an `active` standing that refuses): retryable, never a ban.
            StandingState::StandingUnavailable
            | StandingState::Unknown
            | StandingState::Active
            | StandingState::Restricted => return GatewayError::StandingUnavailable,
        };
        GatewayError::StandingRefused(Box::new(StandingRefusalDetail {
            code,
            message,
            appeal_url: self.appeal_url.clone(),
            reason_class: self.reason_class.clone(),
            until: self.until.clone(),
        }))
    }
}

/// The least a state refuses, whatever `refuses` says.
fn implied_refusal(state: StandingState) -> StandingRefusal {
    match state {
        StandingState::Active | StandingState::Restricted => StandingRefusal::None,
        StandingState::OrgSuspended => StandingRefusal::FloorBound,
        StandingState::UserBanned
        | StandingState::KeySuspended
        | StandingState::StandingUnavailable
        | StandingState::Unknown => StandingRefusal::All,
    }
}

/// A short printable label, or `None` when it is empty, too long, or holds a
/// control character. Labels only decorate an error body, so a bad one is
/// dropped rather than failing the standing.
pub(crate) fn label(value: String, max: usize) -> Option<String> {
    (!value.is_empty() && value.len() <= max && !value.chars().any(char::is_control))
        .then_some(value)
}

/// An `http(s)` appeal link, or `None`. Any other scheme is dropped so the
/// error body never carries a script or data URL.
fn appeal_url(value: String) -> Option<String> {
    let value = label(value, MAX_URL_BYTES)?;
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then_some(value)
}

/// The body of a 403 standing refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingRefusalDetail {
    /// Catalogue code: `org_suspended`, `user_banned` or `key_suspended_abuse`.
    pub code: &'static str,
    pub message: &'static str,
    pub appeal_url: Option<String>,
    pub reason_class: Option<String>,
    pub until: Option<String>,
}

impl StandingRefusalDetail {
    /// The 00.7 error envelope for this refusal.
    pub fn envelope(&self) -> Value {
        let mut error = json!({
            "message": self.message,
            "type": "policy_violation",
            "code": self.code,
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
        json!({ "error": error })
    }
}

/// The error envelope for `standing_unavailable` (503, retryable).
pub fn unavailable_envelope() -> Value {
    json!({ "error": {
        "message": "Account standing is temporarily unavailable. Please retry shortly.",
        "type": "service_unavailable",
        "code": "standing_unavailable",
        "layer": "platform",
        "remedy": "none",
        "retry_after": STANDING_RETRY_AFTER_SECS,
    }})
}

/// Refuse a resolved tenant before anything else runs: its standing first
/// (so a banned key sees `user_banned` with its appeal link, not a billing
/// error), then, on the fleet, an unreadable managed tier. The fleet serves
/// every resolved tenant from Ryu's own provider keys, so a resolve that
/// could not read the tenant's entitlement or wallet is refused with a
/// retryable 503 whether or not this replica is configured to bill.
pub fn admit_resolved(resolved: &ResolvedOrg, custody: GatewayCustody) -> Result<(), GatewayError> {
    if let Some(refusal) = resolved.standing.refusal(custody) {
        return Err(refusal);
    }
    if custody.is_fleet() && resolved.managed_tier_unavailable {
        return Err(GatewayError::AccountingUnavailable);
    }
    Ok(())
}

// ─── Enforcement pushes ────────────────────────────────────────────────────

/// One enforcement push from the control plane. Fields combine with OR: an
/// entry matching any of them is invalidated. A push with none of them
/// invalidates every entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnforcementPush {
    pub org_id: Option<String>,
    pub credential_id: Option<String>,
    pub user_id: Option<String>,
    pub version: u64,
}

impl EnforcementPush {
    /// The ledger keys this push advances.
    fn subject_keys(&self) -> Vec<String> {
        let mut keys = Vec::with_capacity(3);
        if let Some(org) = self.org_id.as_deref() {
            keys.push(org_key(org));
        }
        if let Some(credential) = self.credential_id.as_deref() {
            keys.push(credential_key(credential));
        }
        if let Some(user) = self.user_id.as_deref() {
            keys.push(user_key(user));
        }
        if keys.is_empty() {
            keys.push(ALL_KEY.to_owned());
        }
        keys
    }

    /// Whether a cached resolution belongs to a subject this push names.
    pub fn matches(&self, resolved: &ResolvedOrg) -> bool {
        if self.org_id.is_none() && self.credential_id.is_none() && self.user_id.is_none() {
            return true;
        }
        let subjects = StandingSubjects::of(resolved);
        self.org_id.as_deref() == Some(subjects.org_id.as_str())
            || (self.credential_id.is_some() && self.credential_id == subjects.credential_id)
            || (self.user_id.is_some()
                && (self.user_id == subjects.owner_user_id || self.user_id == subjects.created_by))
    }
}

const ALL_KEY: &str = "*";

fn org_key(org: &str) -> String {
    format!("org:{org}")
}

fn credential_key(credential: &str) -> String {
    format!("cred:{credential}")
}

fn user_key(user: &str) -> String {
    format!("user:{user}")
}

/// The subjects a resolution's standing depends on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingSubjects {
    pub org_id: String,
    pub credential_id: Option<String>,
    pub owner_user_id: Option<String>,
    pub created_by: Option<String>,
}

impl StandingSubjects {
    pub fn of(resolved: &ResolvedOrg) -> Self {
        let credential = resolved.credential.as_deref();
        Self {
            org_id: resolved.org_id.clone(),
            credential_id: resolved.credential_id.clone(),
            owner_user_id: credential.and_then(|credential| credential.owner_user_id.clone()),
            created_by: credential.and_then(|credential| credential.created_by.clone()),
        }
    }
}

/// Per-subject high-water marks of applied enforcement pushes.
#[derive(Debug, Default)]
pub struct EnforcementLedger {
    marks: Mutex<HashMap<String, u64>>,
    /// The highest version applied for any subject.
    latest: AtomicU64,
}

impl EnforcementLedger {
    /// Record `push`. Returns whether it advanced any of its subjects; a push
    /// at or below every subject's mark is a replay and changes nothing.
    pub fn apply(&self, push: &EnforcementPush) -> bool {
        let mut marks = self
            .marks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut advanced = false;
        for key in push.subject_keys() {
            let mark = marks.get(&key).copied().unwrap_or(0);
            if push.version > mark {
                advanced = true;
                if !marks.contains_key(&key) && marks.len() >= MAX_LEDGER_SUBJECTS {
                    if let Some(lowest) = marks
                        .iter()
                        .min_by_key(|(_, version)| **version)
                        .map(|(key, _)| key.clone())
                    {
                        marks.remove(&lowest);
                    }
                }
                marks.insert(key, push.version);
            }
        }
        if advanced {
            self.latest.fetch_max(push.version, Ordering::SeqCst);
        }
        advanced
    }

    /// The highest version applied for any subject. A resolve snapshots this
    /// before it fetches: what it then reads reflects every push up to it.
    pub fn latest(&self) -> u64 {
        self.latest.load(Ordering::SeqCst)
    }

    /// The newest push that names any of `subjects`.
    pub fn newest_for(&self, subjects: &StandingSubjects) -> u64 {
        // Lock-free fast path: nothing was ever pushed.
        if self.latest() == 0 {
            return 0;
        }
        let marks = self
            .marks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mark = |key: &str| marks.get(key).copied().unwrap_or(0);
        let mut newest = mark(ALL_KEY).max(mark(&org_key(&subjects.org_id)));
        if let Some(credential) = subjects.credential_id.as_deref() {
            newest = newest.max(mark(&credential_key(credential)));
        }
        for user in [&subjects.owner_user_id, &subjects.created_by]
            .into_iter()
            .flatten()
        {
            newest = newest.max(mark(&user_key(user)));
        }
        newest
    }
}

/// Wire body of an enforcement push.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushBody {
    #[serde(default)]
    org_id: Option<String>,
    #[serde(default)]
    credential_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    enforcement_version: u64,
}

/// A non-empty, trimmed, control-free id of at most 256 bytes.
fn push_id(value: Option<String>) -> Result<Option<String>, GatewayError> {
    match value {
        None => Ok(None),
        Some(id)
            if !id.is_empty()
                && id.len() <= 256
                && id.trim() == id
                && !id.chars().any(char::is_control) =>
        {
            Ok(Some(id))
        }
        Some(_) => Err(GatewayError::InvalidRequest {
            code: "invalid_enforcement_push",
            message: "enforcement push ids must be non-empty trimmed strings",
        }),
    }
}

/// The fleet's internal secret, when this process holds one.
pub fn internal_secret_from_env() -> Option<String> {
    std::env::var(ENV_INTERNAL_SECRET)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Whether `headers` carry this process's internal secret. Unset or empty on
/// either side never matches.
fn push_authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state
        .enforcement_push_secret
        .as_deref()
        .filter(|secret| !secret.is_empty())
    else {
        return false;
    };
    let presented = headers
        .get(INTERNAL_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    !presented.is_empty() && crate::pipeline::ct_eq(presented, expected)
}

/// `POST /internal/enforcement/invalidate`: apply one enforcement push.
///
/// Answers `{ applied, dropped, appliedEnforcementVersion }`. A replayed or
/// reordered older push answers 200 with `applied: false` so a retrying
/// control plane does not loop.
pub async fn invalidate(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, GatewayError> {
    if !push_authorized(&state, &headers) {
        return Err(GatewayError::Unauthorized(
            "enforcement push requires the internal secret".to_owned(),
        ));
    }
    let parsed: PushBody =
        serde_json::from_slice(&body).map_err(|_| GatewayError::InvalidRequest {
            code: "invalid_enforcement_push",
            message: "enforcement push body must carry an integer enforcementVersion",
        })?;
    if parsed.enforcement_version == 0 {
        return Err(GatewayError::InvalidRequest {
            code: "invalid_enforcement_push",
            message: "enforcementVersion must be at least 1",
        });
    }
    let push = EnforcementPush {
        org_id: push_id(parsed.org_id)?,
        credential_id: push_id(parsed.credential_id)?,
        user_id: push_id(parsed.user_id)?,
        version: parsed.enforcement_version,
    };
    let Some(cache) = state.resolve_cache.as_ref() else {
        // No control plane, so nothing is cached and nothing can be stale.
        return Ok(Json(json!({
            "applied": false,
            "dropped": 0,
            "appliedEnforcementVersion": 0,
        })));
    };
    let outcome = cache.apply_enforcement_push(&push);
    tracing::info!(
        version = push.version,
        applied = outcome.applied,
        dropped = outcome.dropped,
        "enforcement: push received"
    );
    Ok(Json(json!({
        "applied": outcome.applied,
        "dropped": outcome.dropped,
        "appliedEnforcementVersion": cache.enforcement_ledger().latest(),
    })))
}

// ─── In-flight checks ──────────────────────────────────────────────────────

/// What a running request needs to check its standing again: the bearer it
/// resolved with and the subjects its standing depends on. The bearer is
/// held only in memory to re-resolve; it is never logged or serialized.
pub struct StandingGuard {
    token: String,
    credential_use: CredentialUse,
    subjects: StandingSubjects,
    /// The ledger version the authorizing resolution reflects.
    seen: AtomicU64,
}

impl std::fmt::Debug for StandingGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StandingGuard")
            .field("subjects", &self.subjects)
            .field("seen", &self.seen.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl StandingGuard {
    pub fn new(token: String, credential_use: CredentialUse, resolved: &ResolvedOrg) -> Self {
        Self {
            token,
            credential_use,
            subjects: StandingSubjects::of(resolved),
            seen: AtomicU64::new(resolved.enforcement_seen),
        }
    }

    /// Whether a push newer than the authorizing resolution names this
    /// request's subjects. One atomic load when nothing was pushed.
    pub fn is_stale(&self, state: &AppState) -> bool {
        state.resolve_cache.as_ref().is_some_and(|cache| {
            cache.enforcement_ledger().newest_for(&self.subjects) > self.seen.load(Ordering::SeqCst)
        })
    }

    /// Check standing again when a newer push names this request. Re-resolves
    /// through the cache (the push already dropped the stale entry) and
    /// refuses with the 00.7 code when the new standing refuses. A concurrent
    /// resolve of the same token is waited for briefly, then fails closed.
    pub async fn recheck(&self, state: &AppState) -> Result<(), GatewayError> {
        if !self.is_stale(state) {
            return Ok(());
        }
        let Some(cache) = state.resolve_cache.as_ref() else {
            return Ok(());
        };
        for _ in 0..RECHECK_BUSY_ATTEMPTS {
            match cache
                .resolve_cached_for(&self.token, self.credential_use)
                .await
            {
                Ok(resolved) => {
                    if let Some(refusal) = resolved.standing.refusal(state.custody) {
                        return Err(refusal);
                    }
                    self.seen
                        .fetch_max(resolved.enforcement_seen, Ordering::SeqCst);
                    return Ok(());
                }
                Err(ResolveErr::Unresolved) => {
                    return Err(GatewayError::Unauthorized(
                        "Invalid or revoked gateway token.".to_owned(),
                    ));
                }
                Err(ResolveErr::Busy) => tokio::time::sleep(RECHECK_BUSY_WAIT).await,
            }
        }
        Err(GatewayError::StandingUnavailable)
    }
}

/// Check the request's standing again before it dispatches another provider
/// call: a fallback attempt, a hosted round, or an own-supply retry. A no-op
/// for a request with no [`StandingGuard`] (local keys, the master key).
pub async fn recheck(
    state: &AppState,
    ctx: &crate::pipeline::RequestContext,
) -> Result<(), GatewayError> {
    match ctx.standing.as_deref() {
        Some(guard) => guard.recheck(state).await,
        None => Ok(()),
    }
}

/// The codes this gateway's own mid-stream refusal frames carry: a standing
/// refusal ([`refusal_frame`]) or a screener cut (`crate::screening`). A
/// stream translator that meets an `error` frame with one of these codes is
/// reading this gateway's own refusal, not an upstream error, and keeps its
/// code and detail.
const REFUSAL_FRAME_CODES: &[&str] = &[
    "org_suspended",
    "user_banned",
    "key_suspended_abuse",
    "standing_unavailable",
    "invalid_api_key",
    "platform_floor_output_blocked",
    "tenant_policy_blocked",
];

/// The error object of a mid-stream standing refusal frame, when `chunk` is
/// one. Upstream error frames (any other code, or none) answer `None`.
pub fn refusal_frame_error(chunk: &Value) -> Option<&serde_json::Map<String, Value>> {
    let error = chunk.get("error")?.as_object()?;
    let code = error.get("code")?.as_str()?;
    REFUSAL_FRAME_CODES.contains(&code).then_some(error)
}

/// The SSE frame that ends a stream whose standing was refused mid-flight.
fn refusal_frame(error: &GatewayError) -> bytes::Bytes {
    let envelope = match error {
        GatewayError::StandingRefused(detail) => detail.envelope(),
        GatewayError::StandingUnavailable => unavailable_envelope(),
        GatewayError::Unauthorized(_) => json!({ "error": {
            "message": "Invalid or revoked gateway token.",
            "type": "invalid_api_key",
            "code": "invalid_api_key",
        }}),
        _ => unavailable_envelope(),
    };
    bytes::Bytes::from(format!("data: {envelope}\n\n"))
}

/// Check standing before every output window (each chunk the provider
/// sends) of a streamed response. When a newer push names the request and
/// the re-resolved standing refuses, the chunk is withheld, one SSE error
/// frame with the 00.7 envelope is sent, and the stream ends normally so the
/// stream observer still settles what was delivered. Inert without a guard.
pub fn guard_stream(
    body: axum::body::Body,
    state: Arc<AppState>,
    guard: Option<Arc<StandingGuard>>,
) -> axum::body::Body {
    use futures_util::StreamExt;

    let Some(guard) = guard else {
        return body;
    };
    if state.resolve_cache.is_none() {
        return body;
    }
    struct Guarded {
        inner: axum::body::BodyDataStream,
        state: Arc<AppState>,
        guard: Arc<StandingGuard>,
        ended: bool,
    }
    let init = Guarded {
        inner: body.into_data_stream(),
        state,
        guard,
        ended: false,
    };
    let stream = futures_util::stream::unfold(init, |mut s| async move {
        if s.ended {
            return None;
        }
        let item = s.inner.next().await?;
        if s.guard.is_stale(&s.state) {
            if let Err(error) = s.guard.recheck(&s.state).await {
                tracing::warn!(
                    org_id = %s.guard.subjects.org_id,
                    "standing: refused mid-stream; ending the stream"
                );
                s.ended = true;
                return Some((Ok(refusal_frame(&error)), s));
            }
        }
        Some((item, s))
    });
    axum::body::Body::from_stream(stream)
}

#[cfg(test)]
#[path = "standing_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "standing_probe_tests.rs"]
mod probe_tests;

//! Control-plane org limits (contract C1) enforced on hosted `rgw_` traffic.
//!
//! `GET /api/control-plane/gateway/resolve` carries a `limits` object with an
//! org-wide cap, a member default, and per-member / per-team / per-key /
//! per-service-account caps.
//! Each cap is a charged-spend budget over a UTC calendar window plus optional
//! requests-per-minute and tokens-per-minute ceilings.
//!
//! Every applicable cap is checked — member AND each of the caller's teams AND
//! the key AND the key's service account AND the org — and the most severe
//! outcome wins, so a request is
//! blocked when ANY applicable `stop` cap is exhausted. A member with no
//! explicit entry falls back to `memberDefault`. Spend lands in the shared
//! [`SpendStore`] (durable next to `audit.db`) under the scopes `org`,
//! `member`, `team`, `key`, and `service_account`; rate buckets are in memory and keyed per
//! subject rather than one shared org bucket.
//!
//! Several gateways can serve one organization, and each counts only its own
//! traffic. The same resolve also carries `limitsSpend`, the spend every
//! gateway has already reported for each capped scope in its current window
//! ([`RemoteSpend`]). A cap admits against the larger of the local counter and
//! that aggregate plus the local spend since the snapshot arrived, so the caps
//! are not multiplied by fleet size and a new instance starts from the
//! aggregate. Enforcement is eventually consistent: the overshoot is bounded by
//! the fleet's spend that is not yet in a snapshot (about one report interval
//! plus one resolve-cache lifetime of traffic on the other gateways).
//!
//! RPM and TPM buckets live in each gateway process. The same resolve carries
//! `activeGateways`, how many gateways resolved for the org in the last few
//! minutes (this one included), and each gateway enforces its share of every
//! rate ceiling, `max(1, floor(limit / activeGateways))` ([`rate_share`]), so
//! the fleet total cannot exceed the configured limit. Unevenly loaded gateways
//! throttle before the fleet reaches the limit, and the other gateways see a
//! newly started one only on their own next resolve. Without the count (an
//! older control plane) each gateway enforces the full limit.
//!
//! The locally configured [`crate::config::BudgetConfig`] still applies on top:
//! both are evaluated and the more severe decision wins.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Deserializer};

use crate::budget::{BudgetAction, BudgetDecision, BudgetScope, BudgetWindow, SpendStore};
use crate::config::AlertTier;
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::policy_alert::PolicyAlert;
use crate::state::AppState;

/// Restrict-fallback output cap, matching the local budget rule default.
const RESTRICT_MAX_TOKENS: u64 = 256;
/// Thresholds at or above this percent are the cap itself, not an early alert.
const FULL_PCT: u32 = 100;

/// Deserialize `null` the same as a missing key: the type's default.
pub fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A JSON number as a positive whole quantity. `null`, zero, negative, or
/// non-finite values mean "no limit", matching the local budget rule's
/// `0 = unlimited`.
fn positive_quantity<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<f64>::deserialize(deserializer)?;
    Ok(value
        .filter(|number| number.is_finite() && *number >= 1.0)
        .map(|number| number as u64))
}

/// A spend cap in micro-USD. Unlike rates, `0` is a real cap ("no spend
/// allowed"), matching the control plane, which accepts `0` as a hard block.
/// Negative or non-finite values are treated as absent.
fn budget_quantity<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<f64>::deserialize(deserializer)?;
    Ok(value
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number as u64))
}

/// Alert thresholds as whole percents, dropping anything outside `1..=100`.
fn threshold_list<'de, D>(deserializer: D) -> Result<Vec<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Option::<Vec<f64>>::deserialize(deserializer)?.unwrap_or_default();
    let mut thresholds: Vec<u32> = values
        .into_iter()
        .filter(|pct| pct.is_finite() && *pct >= 1.0 && *pct <= 100.0)
        .map(|pct| pct as u32)
        .collect();
    thresholds.sort_unstable();
    thresholds.dedup();
    Ok(thresholds)
}

/// An unknown window string reads as `monthly`, the control plane's default,
/// rather than failing the whole resolve (which would 401 the tenant).
fn lenient_window<'de, D>(deserializer: D) -> Result<BudgetWindow, D::Error>
where
    D: Deserializer<'de>,
{
    let label = Option::<String>::deserialize(deserializer)?;
    Ok(label
        .as_deref()
        .and_then(BudgetWindow::from_storage)
        .unwrap_or(BudgetWindow::Monthly))
}

/// What happens when a cap's budget is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LimitAction {
    /// Reject with `402 budget_exceeded`. Also the reading of an unknown value.
    #[default]
    Stop,
    /// Route to `downgradeModel` (restrict when none is set).
    Downgrade,
    /// Allow and stamp an alert.
    Notify,
}

impl<'de> Deserialize<'de> for LimitAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let label = Option::<String>::deserialize(deserializer)?;
        Ok(match label.as_deref() {
            Some("downgrade") => LimitAction::Downgrade,
            Some("notify") => LimitAction::Notify,
            // Fail closed: a typo or a future action must not open spend.
            _ => LimitAction::Stop,
        })
    }
}

/// One cap (contract C1 `LimitSpec`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSpec {
    /// Charged-spend cap in micro-USD over `budget_window`. `None` = no cap;
    /// `Some(0)` blocks all charged spend under a `stop` action.
    #[serde(default, deserialize_with = "budget_quantity")]
    pub budget_micro_usd: Option<u64>,
    #[serde(default = "monthly", deserialize_with = "lenient_window")]
    pub budget_window: BudgetWindow,
    #[serde(default)]
    pub budget_action: LimitAction,
    #[serde(default)]
    pub downgrade_model: Option<String>,
    #[serde(default, deserialize_with = "threshold_list")]
    pub alert_thresholds_pct: Vec<u32>,
    /// Requests per minute. `None` = no limit.
    #[serde(default, deserialize_with = "positive_quantity")]
    pub rpm: Option<u64>,
    /// Tokens (input + output) per minute. `None` = no limit.
    #[serde(default, deserialize_with = "positive_quantity")]
    pub tpm: Option<u64>,
}

fn monthly() -> BudgetWindow {
    BudgetWindow::Monthly
}

/// The resolve response's `limits` object (contract C1).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgLimits {
    #[serde(default)]
    pub org: Option<LimitSpec>,
    #[serde(default)]
    pub member_default: Option<LimitSpec>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub members: HashMap<String, LimitSpec>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub teams: HashMap<String, LimitSpec>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub keys: HashMap<String, LimitSpec>,
    /// Caps shared by every gateway key of one service account, keyed by the
    /// account id the resolve reports as `credential.serviceAccountId`.
    #[serde(default, deserialize_with = "null_as_default")]
    pub service_accounts: HashMap<String, LimitSpec>,
    /// Builder tag budgets (Treg parity C6), keyed by budget id. A budget
    /// applies to a request whose `x-ryu-tags` carries its tag.
    #[serde(default, deserialize_with = "null_as_default")]
    pub tags: HashMap<String, TagLimit>,
}

/// One builder tag budget: the tag it counts and its cap (budget fields only;
/// the control plane sends no rates for tags).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLimit {
    pub tag: String,
    #[serde(flatten)]
    pub spec: LimitSpec,
}

impl OrgLimits {
    /// Whether no cap of any kind is configured.
    pub fn is_empty(&self) -> bool {
        self.org.is_none()
            && self.member_default.is_none()
            && self.members.is_empty()
            && self.teams.is_empty()
            && self.keys.is_empty()
            && self.service_accounts.is_empty()
            && self.tags.is_empty()
    }

    /// These limits with a plan's `ceiling` folded into the org-wide cap: its
    /// `rpm` and `tpm` become the smaller of the authored value and the
    /// ceiling, and an org without an org-wide cap gets one that carries only
    /// the ceiling (no budget). An authored cap can narrow a ceiling, never
    /// raise it.
    pub fn with_rate_ceiling(&self, ceiling: RateCeiling) -> OrgLimits {
        fn narrower(authored: Option<u64>, ceiling: Option<u64>) -> Option<u64> {
            match (authored, ceiling) {
                (Some(authored), Some(ceiling)) => Some(authored.min(ceiling)),
                (authored, ceiling) => authored.or(ceiling),
            }
        }
        let mut limits = self.clone();
        if ceiling.rpm.is_none() && ceiling.tpm.is_none() {
            return limits;
        }
        let org = limits.org.get_or_insert_with(LimitSpec::default);
        org.rpm = narrower(org.rpm, ceiling.rpm);
        org.tpm = narrower(org.tpm, ceiling.tpm);
        limits
    }
}

/// A plan's org-wide per-minute ceiling (resolve `planRateCeiling`). Many
/// organizations share the hosted Gateway's provider capacity, so only a
/// gateway that bills tenants applies it (see
/// [`crate::policy::ResolvedOrg::enforced_limits`]); a self-hosted gateway or
/// an organization's own node enforces only the caps its admins authored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateCeiling {
    /// Requests per minute. `None` = no ceiling.
    #[serde(default, deserialize_with = "positive_quantity")]
    pub rpm: Option<u64>,
    /// Tokens per minute. `None` = no ceiling.
    #[serde(default, deserialize_with = "positive_quantity")]
    pub tpm: Option<u64>,
}

/// A snapshot older than this is ignored, so a badly skewed clock or a stuck
/// snapshot can never pin enforcement to an old aggregate.
const MAX_REMOTE_AGE_SECS: i64 = 3_600;

/// One scope's organization-wide spend, as the control plane last recorded it.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpendEntry {
    /// Charged micro-USD every gateway of the org has reported in the window.
    #[serde(default, deserialize_with = "budget_quantity")]
    pub spent_micro_usd: Option<u64>,
    /// Start of the UTC window the figure covers, in Unix seconds (`0` for
    /// lifetime), matching [`BudgetWindow::start`].
    #[serde(default)]
    pub window_start: i64,
}

/// Per-scope upper bound on the spend of subjects a truncated snapshot left
/// out (wire `limitsSpend.omitted`).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmittedSpend {
    #[serde(default, deserialize_with = "budget_quantity")]
    pub members: Option<u64>,
    #[serde(default, deserialize_with = "budget_quantity")]
    pub teams: Option<u64>,
    #[serde(default, deserialize_with = "budget_quantity")]
    pub keys: Option<u64>,
    #[serde(default, deserialize_with = "budget_quantity")]
    pub service_accounts: Option<u64>,
}

/// The resolve response's `limitsSpend` object: the fleet-wide spend already
/// reported for each capped scope in its current window.
///
/// Every gateway admits against `max(local, remote + local spend since this
/// snapshot was first applied)`. The local term covers this process's own
/// unreported spend; the remote term carries every other gateway's reported
/// spend, so N gateways cannot each spend the whole cap and a new instance
/// starts from the aggregate instead of zero. Spend that no snapshot has seen
/// yet (other gateways' traffic since their last report, plus the resolve
/// cache's lifetime) is the remaining, eventually consistent overshoot.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpend {
    /// When the control plane measured the snapshot, in Unix seconds.
    #[serde(default)]
    pub as_of: i64,
    #[serde(default)]
    pub org: Option<RemoteSpendEntry>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub members: HashMap<String, RemoteSpendEntry>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub teams: HashMap<String, RemoteSpendEntry>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub keys: HashMap<String, RemoteSpendEntry>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub service_accounts: HashMap<String, RemoteSpendEntry>,
    /// Each tag budget's spend in its window, keyed by budget id, measured
    /// from the control plane's tag spend rollup (which also counts Connect's
    /// settled tagged spend). Never truncated.
    #[serde(default, deserialize_with = "null_as_default")]
    pub tags: HashMap<String, RemoteSpendEntry>,
    /// Set when the control plane left subjects out to bound the payload.
    /// A member, team, or key then missing from its map may be one of them.
    #[serde(default)]
    pub truncated: bool,
    /// With `truncated`, the largest window spend of any subject left out,
    /// per scope. A missing subject is admitted against this figure (it can
    /// have spent no more), so leaving it out never lifts its cap.
    #[serde(default, deserialize_with = "null_as_default")]
    pub omitted: OmittedSpend,
    /// Local counter value per `(scope, store id, window start)` when this
    /// snapshot was first applied to it. Local spend beyond it is spend the
    /// snapshot cannot contain yet. Bounded by the snapshot's entry count.
    #[serde(skip)]
    baselines: Mutex<HashMap<String, u64>>,
}

impl RemoteSpend {
    fn entry(&self, scope: BudgetScope, subject: &str) -> Option<&RemoteSpendEntry> {
        match scope {
            BudgetScope::Org => self.org.as_ref(),
            BudgetScope::Member => self.members.get(subject),
            BudgetScope::Team => self.teams.get(subject),
            BudgetScope::Key => self.keys.get(subject),
            BudgetScope::ServiceAccount => self.service_accounts.get(subject),
            BudgetScope::Tag => self.tags.get(subject),
            _ => None,
        }
    }

    /// The bound on an omitted subject's spend, when the snapshot is truncated.
    fn omitted_ceiling(&self, scope: BudgetScope) -> Option<u64> {
        if !self.truncated {
            return None;
        }
        match scope {
            BudgetScope::Member => self.omitted.members,
            BudgetScope::Team => self.omitted.teams,
            BudgetScope::Key => self.omitted.keys,
            BudgetScope::ServiceAccount => self.omitted.service_accounts,
            _ => None,
        }
    }

    /// The spend to admit against for one cap, given the `local` counter.
    /// Without a usable remote figure this is exactly `local`.
    fn effective(
        &self,
        scope: BudgetScope,
        subject: &str,
        store_id: &str,
        window: BudgetWindow,
        local: u64,
        now: i64,
    ) -> u64 {
        if self.as_of <= 0 || now.saturating_sub(self.as_of) > MAX_REMOTE_AGE_SECS {
            return local;
        }
        let window_start = window.start(now);
        let remote = match self.entry(scope, subject) {
            Some(entry) => {
                let Some(remote) = entry.spent_micro_usd else {
                    return local;
                };
                if entry.window_start != window_start {
                    // The snapshot describes another window (it rolled over,
                    // or the cap's window changed): it says nothing about
                    // this one.
                    return local;
                }
                remote
            }
            None => {
                // Not listed: either nothing was spent, or a truncated
                // snapshot left the subject out. In the second case admit
                // against the largest spend that was left out, as long as the
                // snapshot was taken inside this window.
                let Some(ceiling) = self.omitted_ceiling(scope) else {
                    return local;
                };
                if self.as_of < window_start {
                    return local;
                }
                ceiling
            }
        };
        let key = format!("{}:{store_id}:{window_start}", scope.as_str());
        let baseline = *self
            .baselines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key)
            .or_insert(local);
        local.max(remote.saturating_add(local.saturating_sub(baseline)))
    }
}

/// The per-request limit subject, attached to a resolved `rgw_` context.
#[derive(Debug, Clone)]
pub struct OrgLimitContext {
    pub org_id: String,
    pub limits: Arc<OrgLimits>,
    /// Control-plane id of the presenting `rgw_` credential.
    pub credential_id: Option<String>,
    /// Org service account that owns the presenting credential, if any.
    pub service_account_id: Option<String>,
    /// The member the presenting credential is bound to (a personal node's
    /// owner). When set, the member cap and member spend use this id instead
    /// of the request's caller, so leaving the user JWT out cannot skip the
    /// owner's cap. It only scopes limits: it never becomes the request's
    /// `user_id`, which stays a verified identity.
    pub bound_user_id: Option<String>,
    /// Team scopes of this request inside `org_id`: the credential's bound
    /// team (or a personal-node owner's teams) plus the verified caller's.
    pub team_ids: Vec<String>,
    /// Fleet-wide spend from the same resolve (wire `limitsSpend`). `None` on
    /// a control plane that does not send it: caps then read only the local
    /// counters, exactly as before.
    pub remote_spend: Option<Arc<RemoteSpend>>,
    /// Gateways that resolved for the org in the last few minutes, this one
    /// included (wire `activeGateways`). Each rate ceiling is divided by it
    /// ([`rate_share`]).
    /// `None` on a control plane that does not send it: full ceilings apply.
    pub active_gateways: Option<u64>,
    /// The caller's builder tags (`x-ryu-tags`, Treg parity C6), sorted.
    pub tags: Vec<String>,
}

/// This gateway's share of a fleet-wide rate ceiling: `max(1, floor(limit /
/// active))`. With `active` gateways each admitting at most their share, the
/// fleet admits at most `limit` (except a limit below the gateway count, where
/// every gateway keeps a floor of 1). A missing or zero count is the full limit.
pub fn rate_share(limit: u64, active_gateways: Option<u64>) -> u64 {
    match active_gateways {
        Some(active) if active > 1 => (limit / active).max(1),
        _ => limit,
    }
}

/// One cap that applies to this request.
struct Applicable<'a> {
    scope: BudgetScope,
    /// Spend-store / rate-bucket id: org-qualified where ids are org-local.
    store_id: String,
    /// The id surfaced in decisions and alerts.
    subject: &'a str,
    spec: &'a LimitSpec,
}

impl OrgLimitContext {
    /// The member whose cap and spend bucket apply: the credential's bound
    /// owner when there is one, else the request's verified caller.
    fn member<'a>(&'a self, user_id: Option<&'a str>) -> Option<&'a str> {
        self.bound_user_id
            .as_deref()
            .or(user_id)
            .filter(|id| !id.is_empty())
    }

    fn applicable<'a>(&'a self, user_id: Option<&'a str>) -> Vec<Applicable<'a>> {
        let limits = self.limits.as_ref();
        let mut caps = Vec::new();
        if let Some(spec) = limits.org.as_ref() {
            caps.push(Applicable {
                scope: BudgetScope::Org,
                store_id: self.org_id.clone(),
                subject: &self.org_id,
                spec,
            });
        }
        if let Some(user) = self.member(user_id) {
            if let Some(spec) = limits.members.get(user).or(limits.member_default.as_ref()) {
                caps.push(Applicable {
                    scope: BudgetScope::Member,
                    store_id: format!("{}:{user}", self.org_id),
                    subject: user,
                    spec,
                });
            }
        }
        for team in &self.team_ids {
            if let Some(spec) = limits.teams.get(team) {
                caps.push(Applicable {
                    scope: BudgetScope::Team,
                    store_id: format!("{}:{team}", self.org_id),
                    subject: team,
                    spec,
                });
            }
        }
        if let Some(key) = self.credential_id.as_deref() {
            if let Some(spec) = limits.keys.get(key) {
                caps.push(Applicable {
                    scope: BudgetScope::Key,
                    store_id: key.to_owned(),
                    subject: key,
                    spec,
                });
            }
        }
        if let Some(account) = self.service_account_id.as_deref() {
            if let Some(spec) = limits.service_accounts.get(account) {
                caps.push(Applicable {
                    scope: BudgetScope::ServiceAccount,
                    store_id: format!("{}:{account}", self.org_id),
                    subject: account,
                    spec,
                });
            }
        }
        // Builder tag budgets: the subject is the budget id (the snapshot's
        // key); the counter is the org's tag, shared by its windows.
        let mut tag_budgets: Vec<(&String, &TagLimit)> = limits
            .tags
            .iter()
            .filter(|(_, limit)| self.tags.iter().any(|tag| tag == &limit.tag))
            .collect();
        tag_budgets.sort_by(|left, right| left.0.cmp(right.0));
        for (id, limit) in tag_budgets {
            caps.push(Applicable {
                scope: BudgetScope::Tag,
                store_id: format!("{}:{}", self.org_id, limit.tag),
                subject: id,
                spec: &limit.spec,
            });
        }
        caps
    }
}

/// The budget side of the org limits for one request.
#[derive(Debug, Default)]
pub struct LimitsOutcome {
    /// The most severe exhausted cap, if any. Its alert tier is `warn`, so the
    /// shared budget plumbing stamps `x-ryu-policy-alert`.
    pub decision: Option<BudgetDecision>,
    /// The highest crossed early-warning threshold of a cap that is not yet
    /// exhausted, as a `notify` alert.
    pub alert: Option<PolicyAlert>,
}

fn severity(action: BudgetAction) -> u8 {
    match action {
        BudgetAction::Notify => 0,
        BudgetAction::Restrict | BudgetAction::Downgrade => 1,
        BudgetAction::Stop => 2,
    }
}

/// Evaluate every applicable budget cap against the spend recorded in its
/// current window.
pub fn evaluate(
    store: &dyn SpendStore,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
    now: i64,
) -> LimitsOutcome {
    let mut outcome = LimitsOutcome::default();
    // Highest crossed threshold as (pct, alert), so the most urgent one wins.
    let mut threshold: Option<(u32, PolicyAlert)> = None;
    for cap in limit_ctx.applicable(user_id) {
        let Some(budget) = cap.spec.budget_micro_usd else {
            continue;
        };
        let window = cap.spec.budget_window;
        let local = store.spent(cap.scope.as_str(), &cap.store_id, window, now);
        let used = limit_ctx.remote_spend.as_deref().map_or(local, |remote| {
            remote.effective(cap.scope, cap.subject, &cap.store_id, window, local, now)
        });
        if used >= budget {
            let action = match cap.spec.budget_action {
                LimitAction::Stop => BudgetAction::Stop,
                LimitAction::Notify => BudgetAction::Notify,
                LimitAction::Downgrade if cap.spec.downgrade_model.is_some() => {
                    BudgetAction::Downgrade
                }
                LimitAction::Downgrade => BudgetAction::Restrict,
            };
            let candidate = BudgetDecision {
                scope: cap.scope,
                key: cap.subject.to_owned(),
                action,
                used,
                limit: budget,
                downgrade_to: cap.spec.downgrade_model.clone(),
                restrict_max_tokens: RESTRICT_MAX_TOKENS,
                alert: AlertTier::Warn,
            };
            let replace = outcome
                .decision
                .as_ref()
                .is_none_or(|current| severity(candidate.action) > severity(current.action));
            if replace {
                outcome.decision = Some(candidate);
            }
            continue;
        }
        let crossed = cap
            .spec
            .alert_thresholds_pct
            .iter()
            .copied()
            .filter(|pct| *pct < FULL_PCT)
            .filter(|pct| u128::from(used) * 100 >= u128::from(*pct) * u128::from(budget))
            .max();
        if let Some(pct) = crossed {
            if threshold.as_ref().is_none_or(|(best, _)| pct > *best) {
                threshold = Some((
                    pct,
                    PolicyAlert::limit_threshold(
                        cap.scope.as_str(),
                        cap.subject,
                        AlertTier::Warn,
                        used,
                        budget,
                        pct,
                        window.start(now),
                        &limit_ctx.org_id,
                    ),
                ));
            }
        }
    }
    outcome.alert = threshold.map(|(_, alert)| alert);
    outcome
}

/// Who a charge is attributed to for org limits: the org, the member (the
/// credential's bound owner, else the verified caller), each team scope, the presenting `rgw_` credential, and
/// the service account that owns it.
/// Carried on records that settle after the request context is gone (async
/// media jobs, external tool receipts) so those charges advance org caps too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgLimitSubject {
    pub org_id: String,
    pub user_id: Option<String>,
    pub team_ids: Vec<String>,
    pub credential_id: Option<String>,
    pub service_account_id: Option<String>,
    /// The caller's builder tags, carried onto the debit's attribution (the
    /// control plane's tag rollup reads them there).
    pub tags: Vec<String>,
    /// The tags among `tags` the org has a budget for; only these get a
    /// `tag` spend counter here. Counting every caller-chosen tag would let a
    /// caller grow the shared spend store without bound, and spend from
    /// before a budget existed comes from the control plane's rollup.
    pub budgeted_tags: Vec<String>,
}

impl OrgLimitSubject {
    /// The subject of a request under `limit_ctx`, attributed to `user_id`.
    pub fn new(limit_ctx: &OrgLimitContext, user_id: Option<&str>) -> Self {
        Self {
            org_id: limit_ctx.org_id.clone(),
            user_id: limit_ctx.member(user_id).map(str::to_owned),
            team_ids: limit_ctx.team_ids.clone(),
            credential_id: limit_ctx.credential_id.clone(),
            service_account_id: limit_ctx.service_account_id.clone(),
            tags: limit_ctx.tags.clone(),
            budgeted_tags: limit_ctx
                .tags
                .iter()
                .filter(|tag| {
                    limit_ctx
                        .limits
                        .tags
                        .values()
                        .any(|limit| &limit.tag == *tag)
                })
                .cloned()
                .collect(),
        }
    }

    /// Every `(scope, store id)` this subject's spend is counted under. The
    /// store ids match [`OrgLimitContext::applicable`], so a cap configured
    /// later reads the same counters.
    fn scopes(&self) -> Vec<(BudgetScope, String)> {
        let mut scopes = vec![(BudgetScope::Org, self.org_id.clone())];
        if let Some(user) = self.user_id.as_deref() {
            scopes.push((BudgetScope::Member, format!("{}:{user}", self.org_id)));
        }
        for team in &self.team_ids {
            scopes.push((BudgetScope::Team, format!("{}:{team}", self.org_id)));
        }
        if let Some(key) = self.credential_id.as_deref() {
            scopes.push((BudgetScope::Key, key.to_owned()));
        }
        if let Some(account) = self.service_account_id.as_deref() {
            scopes.push((
                BudgetScope::ServiceAccount,
                format!("{}:{account}", self.org_id),
            ));
        }
        for tag in &self.budgeted_tags {
            scopes.push((BudgetScope::Tag, format!("{}:{tag}", self.org_id)));
        }
        scopes
    }
}

/// Add a charged amount to every attributable scope (org, member, each team,
/// key, service account) in every window, whether or not a cap exists for it yet. Counting
/// continuously means a cap added mid-window sees the usage already spent in
/// that window instead of starting from zero.
pub fn record(
    store: &dyn SpendStore,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
    amount: u64,
    now: i64,
) {
    record_subject(
        store,
        &OrgLimitSubject::new(limit_ctx, user_id),
        amount,
        now,
    );
}

/// [`record`] for a stored [`OrgLimitSubject`].
pub fn record_subject(store: &dyn SpendStore, subject: &OrgLimitSubject, amount: u64, now: i64) {
    if amount == 0 || subject.org_id.is_empty() {
        return;
    }
    for (scope, store_id) in subject.scopes() {
        store.add(scope.as_str(), &store_id, amount, now);
    }
}

/// Rate-bucket key for a cap: scope-qualified so an org bucket can never
/// collide with a member or key bucket.
fn bucket_key(cap: &Applicable<'_>) -> String {
    format!("{}:{}", cap.scope.as_str(), cap.store_id)
}

// ─── Builder tags (Treg parity C6) ────────────────────────────────────────────

tokio::task_local! {
    /// The tags of the request being served, parsed once by
    /// [`scope_spend_tags`] so authentication can attach them to the org
    /// limit context without every handler threading the header through.
    static SPEND_TAGS: Vec<String>;
}

/// The current request's builder tags; empty outside a tagged request.
pub fn current_spend_tags() -> Vec<String> {
    SPEND_TAGS.try_with(Clone::clone).unwrap_or_default()
}

/// Router middleware: parse `x-ryu-tags` (contract
/// `ryu_gw_contracts::spend_tags`) and serve the request inside it. A
/// malformed header is refused with `400` before anything runs, because a
/// silently dropped tag would escape its budget.
pub async fn scope_spend_tags(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, crate::error::GatewayError> {
    use ryu_gw_contracts::spend_tags::{parse_spend_tags, SPEND_TAGS_HEADER};
    let raw = match request.headers().get(SPEND_TAGS_HEADER) {
        None => None,
        Some(value) => Some(value.to_str().map_err(|_| {
            crate::error::GatewayError::BadRequest(format!("{SPEND_TAGS_HEADER} must be ASCII"))
        })?),
    };
    let tags = parse_spend_tags(raw).map_err(|problem| {
        crate::error::GatewayError::BadRequest(format!(
            "{SPEND_TAGS_HEADER} is not valid ({}): up to eight comma-separated tags of lowercase letters, digits and . _ : -",
            problem.as_str()
        ))
    })?;
    Ok(SPEND_TAGS.scope(tags, next.run(request)).await)
}

/// The builder tags of a request's org-limit context (what its debits carry).
pub fn tags_for(ctx: &RequestContext) -> Vec<String> {
    ctx.org_limits
        .as_deref()
        .map(|limit_ctx| limit_ctx.tags.clone())
        .unwrap_or_default()
}

// ─── Request-path helpers ────────────────────────────────────────────────────

/// Budget evaluation for a request context (no limits ⇒ empty outcome).
pub fn evaluate_for(state: &AppState, ctx: &RequestContext) -> LimitsOutcome {
    match ctx.org_limits.as_deref() {
        Some(limit_ctx) if !ctx.is_master_key => evaluate(
            state.spend_store.as_ref(),
            limit_ctx,
            ctx.user_id.as_deref(),
            crate::budget::unix_now(),
        ),
        _ => LimitsOutcome::default(),
    }
}

/// The org-limit subject of a request, for settlement paths that outlive it.
pub fn subject_for(ctx: &RequestContext) -> Option<OrgLimitSubject> {
    ctx.org_limits
        .as_deref()
        .map(|limit_ctx| OrgLimitSubject::new(limit_ctx, ctx.user_id.as_deref()))
}

/// Record charged spend for a stored subject (async settlement paths).
pub fn record_subject_for(state: &AppState, subject: Option<&OrgLimitSubject>, amount: u64) {
    if let Some(subject) = subject {
        record_subject(
            state.spend_store.as_ref(),
            subject,
            amount,
            crate::budget::unix_now(),
        );
    }
}

/// Record charged spend for a request context.
pub fn record_for(state: &AppState, ctx: &RequestContext, amount: u64) {
    if let Some(limit_ctx) = ctx.org_limits.as_deref() {
        record(
            state.spend_store.as_ref(),
            limit_ctx,
            ctx.user_id.as_deref(),
            amount,
            crate::budget::unix_now(),
        );
    }
}

/// Admit one request against the abuse ladder's throttle and new-key rates
/// ([`crate::enforcement::admit_rate`], which answer with their own codes),
/// then against every applicable RPM ceiling (`RateLimited`).
pub fn check_request(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    crate::enforcement::admit_rate(state, ctx)?;
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return Ok(());
    };
    if admit_request(&state.org_rate, limit_ctx, ctx.user_id.as_deref()) {
        Ok(())
    } else {
        Err(GatewayError::RateLimited)
    }
}

/// All-or-nothing RPM admission: a request a member/team/key cap rejects must
/// not drain the org (or any other) bucket it was checked against first.
fn admit_request(
    rate: &crate::rate_limit::ScopedRateLimiter,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
) -> bool {
    let ceilings: Vec<(String, u64)> = limit_ctx
        .applicable(user_id)
        .iter()
        .filter_map(|cap| {
            cap.spec
                .rpm
                .map(|rpm| (bucket_key(cap), rate_share(rpm, limit_ctx.active_gateways)))
        })
        .collect();
    rate.check_requests_all(&ceilings)
}

/// Admit `tokens` against every applicable TPM ceiling. `true` = allowed.
pub fn check_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) -> bool {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return true;
    };
    if tokens == 0 {
        return true;
    }
    admit_tokens(&state.org_rate, limit_ctx, ctx.user_id.as_deref(), tokens)
}

/// All-or-nothing TPM admission (see [`admit_request`]).
fn admit_tokens(
    rate: &crate::rate_limit::ScopedRateLimiter,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
    tokens: u64,
) -> bool {
    let ceilings: Vec<(String, u64)> = limit_ctx
        .applicable(user_id)
        .iter()
        .filter_map(|cap| {
            cap.spec
                .tpm
                .map(|tpm| (bucket_key(cap), rate_share(tpm, limit_ctx.active_gateways)))
        })
        .collect();
    rate.check_tokens_all(&ceilings, tokens)
}

/// Charge already-served tokens to every applicable TPM bucket (may carry
/// debt). Returns `true` when any bucket was already over its ceiling, so the
/// non-streaming path can report the overrun like the per-key limiter does.
pub fn settle_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) -> bool {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return false;
    };
    if tokens == 0 {
        return false;
    }
    let mut over = false;
    for cap in limit_ctx.applicable(ctx.user_id.as_deref()) {
        if let Some(tpm) = cap.spec.tpm {
            let share = rate_share(tpm, limit_ctx.active_gateways);
            over |= state
                .org_rate
                .settle_tokens(&bucket_key(&cap), tokens, share);
        }
    }
    over
}

/// [`settle_tokens`] for tokens counted for accounting rather than admission
/// (a tool loop's earlier provider rounds). Each bucket is charged at most its
/// own one-minute share, so one request cannot put it more than a minute into
/// debt, and an overrun is never reported.
pub fn record_tokens_within_window(state: &AppState, ctx: &RequestContext, tokens: u64) {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return;
    };
    if tokens == 0 {
        return;
    }
    for cap in limit_ctx.applicable(ctx.user_id.as_deref()) {
        if let Some(tpm) = cap.spec.tpm {
            let share = rate_share(tpm, limit_ctx.active_gateways);
            state
                .org_rate
                .settle_tokens(&bucket_key(&cap), tokens.min(share), share);
        }
    }
}

#[cfg(test)]
#[path = "org_limits_tests.rs"]
mod tests;

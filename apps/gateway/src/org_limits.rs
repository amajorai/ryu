//! Control-plane org limits (contract C1) enforced on hosted `rgw_` traffic.
//!
//! `GET /api/control-plane/gateway/resolve` carries a `limits` object with an
//! org-wide cap, a member default, and per-member / per-team / per-key /
//! per-service-account / per-project / per-bot caps.
//! Each cap is a charged-spend budget over a UTC calendar window plus optional
//! requests-per-minute and tokens-per-minute ceilings.
//!
//! Every applicable cap is checked — member AND each of the caller's teams AND
//! the key AND the key's service account AND the project AND the verified bot
//! AND the org — and the most severe
//! outcome wins, so a request is
//! blocked when ANY applicable `stop` cap is exhausted. A member with no
//! explicit entry falls back to `memberDefault`. Spend lands in the shared
//! [`SpendStore`] (durable next to `audit.db`) under the scopes `org`,
//! `member`, `team`, `key`, `service_account`, `project` and `bot`; rate buckets are in memory and keyed per
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
//! Each cap may also carry funding budgets (`fundingBudgets`): caps on the
//! part of its spend paid from subscription credit and from API credit, under
//! the cap's own window and action. They admit against the ledger split the
//! snapshot reports plus this gateway's spend since the snapshot, attributed
//! to the source the wallet draws from next (both when unknown); see
//! [`funding`].
//!
//! The locally configured [`crate::config::BudgetConfig`] still applies on top:
//! both are evaluated and the more severe decision wins.

mod funding;
mod remote;
mod request;
mod resolved;
mod spend_tags;
mod subject;
mod wire;

use std::sync::Arc;

use crate::budget::{BudgetAction, BudgetDecision, BudgetScope, SpendStore};
use crate::config::AlertTier;
use crate::policy_alert::PolicyAlert;

pub use remote::RemoteSpend;
#[cfg(test)]
use remote::{FundingSpend, OmittedSpend, RemoteSpendEntry};
#[cfg(test)]
use request::{admit_request, admit_tokens};
pub use request::{
    check_request, check_tokens, evaluate_for, record_for, record_subject_for,
    record_tokens_within_window, settle_tokens, subject_for,
};
pub use resolved::ResolvedSubject;
pub use spend_tags::{current_spend_tags, scope_spend_tags, tags_for};
pub use subject::{record, record_subject, LedgerScope, OrgLimitSubject};
#[cfg(test)]
use wire::FundingBudgets;
pub use wire::{
    lenient_funding_source, null_as_default, FundingSource, LimitAction, LimitSpec, OrgLimits,
    RateCeiling, TagLimit,
};

/// Restrict-fallback output cap, matching the local budget rule default.
const RESTRICT_MAX_TOKENS: u64 = 256;
/// Thresholds at or above this percent are the cap itself, not an early alert.
const FULL_PCT: u32 = 100;

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
    /// The control-plane project this request runs under: the project the
    /// resolve validated for the credential (wire `credential.projectId`),
    /// else a static key's configured project. Keys `limits.projects`.
    pub project_id: Option<String>,
    /// The bot (agent) this request runs for, only when its id was verified
    /// (a Core HMAC proof on a dynamic credential, or a static / trusted
    /// forwarder key). Never an unverified `x-ryu-agent-id`. Keys `limits.bots`.
    pub bot_id: Option<String>,
    /// Which credit source the org wallet's next debit draws from (wire
    /// `fundingDrawSource`). Local spend since the snapshot counts toward that
    /// source's funding budgets; `None` (unknown) counts it toward both.
    pub funding_draw_source: Option<FundingSource>,
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
        if let Some(project) = self.project_id.as_deref().filter(|id| !id.is_empty()) {
            if let Some(spec) = limits.projects.get(project) {
                caps.push(Applicable {
                    scope: BudgetScope::Project,
                    store_id: format!("{}:{project}", self.org_id),
                    subject: project,
                    spec,
                });
            }
        }
        if let Some(bot) = self.bot_id.as_deref().filter(|id| !id.is_empty()) {
            if let Some(spec) = limits.bots.get(bot) {
                caps.push(Applicable {
                    scope: BudgetScope::Bot,
                    store_id: format!("{}:{bot}", self.org_id),
                    subject: bot,
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

/// Evaluate every applicable budget cap (the total budget and each funding
/// budget) against the spend recorded in its current window.
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
        let window = cap.spec.budget_window;
        for (budget, used) in funding::budget_checks(store, limit_ctx, &cap, now) {
            if used >= budget {
                let candidate = exhausted(&cap, budget, used);
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
    }
    outcome.alert = threshold.map(|(_, alert)| alert);
    outcome
}

/// The decision for one exhausted budget of `cap`, under the cap's action.
fn exhausted(cap: &Applicable<'_>, budget: u64, used: u64) -> BudgetDecision {
    let action = match cap.spec.budget_action {
        LimitAction::Stop => BudgetAction::Stop,
        LimitAction::Notify => BudgetAction::Notify,
        LimitAction::Downgrade if cap.spec.downgrade_model.is_some() => BudgetAction::Downgrade,
        LimitAction::Downgrade => BudgetAction::Restrict,
    };
    BudgetDecision {
        scope: cap.scope,
        key: cap.subject.to_owned(),
        action,
        used,
        limit: budget,
        downgrade_to: cap.spec.downgrade_model.clone(),
        restrict_max_tokens: RESTRICT_MAX_TOKENS,
        alert: AlertTier::Warn,
    }
}

/// Rate-bucket key for a cap: scope-qualified so an org bucket can never
/// collide with a member or key bucket.
fn bucket_key(cap: &Applicable<'_>) -> String {
    format!("{}:{}", cap.scope.as_str(), cap.store_id)
}

#[cfg(test)]
#[path = "org_limits_auth_tests.rs"]
mod auth_tests;
#[cfg(test)]
#[path = "org_limits_rate_tests.rs"]
mod rate_tests;
#[cfg(test)]
#[path = "org_limits_remote_tests.rs"]
mod remote_tests;
#[cfg(test)]
#[path = "org_limits_scoped_tests.rs"]
mod scoped_tests;
#[cfg(test)]
#[path = "org_limits_tests.rs"]
mod tests;

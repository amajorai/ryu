//! Wire shapes of the resolve's `limits` object (contract C1) and the
//! lenient number, window and action readers they share with
//! [`super::RemoteSpend`].

use std::collections::HashMap;

use serde::{Deserialize, Deserializer};

use crate::budget::BudgetWindow;

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
pub(super) fn positive_quantity<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
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
pub(super) fn budget_quantity<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
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
    /// Caps on the part of the spend each credit source paid (wire
    /// `fundingBudgets`), under the same window, action and thresholds as
    /// `budget_micro_usd`. Missing or `null` (an older control plane or a
    /// stored spec that predates it) means no funding cap.
    #[serde(default, deserialize_with = "null_as_default")]
    pub funding_budgets: FundingBudgets,
}

/// Per-credit-source caps of one [`LimitSpec`] (wire `fundingBudgets`).
/// `None` = no cap for that source; `Some(0)` blocks spend from it under a
/// `stop` action, exactly like `budgetMicroUsd`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingBudgets {
    /// Cap on spend paid from subscription (plan-included) credit.
    #[serde(default, deserialize_with = "budget_quantity")]
    pub subscription_micro_usd: Option<u64>,
    /// Cap on spend paid from API (top-up / pay-as-you-go) credit.
    #[serde(default, deserialize_with = "budget_quantity")]
    pub api_micro_usd: Option<u64>,
}

impl FundingBudgets {
    /// Each configured funding cap with its source.
    pub fn caps(&self) -> impl Iterator<Item = (FundingSource, u64)> {
        [
            (FundingSource::Subscription, self.subscription_micro_usd),
            (FundingSource::Api, self.api_micro_usd),
        ]
        .into_iter()
        .filter_map(|(source, cap)| cap.map(|cap| (source, cap)))
    }
}

/// The credit source a charge is paid from (contract §2): the subscription
/// bucket, or paid API credit (top-up plus standalone). Gift and promotional
/// credit count toward neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FundingSource {
    Subscription,
    Api,
}

/// Resolve `fundingDrawSource`: which source the org wallet's next ordinary
/// debit draws from. `null`, a missing key, or an unknown value read as
/// `None` (unknown), which attributes local spend to both sources.
pub fn lenient_funding_source<'de, D>(deserializer: D) -> Result<Option<FundingSource>, D::Error>
where
    D: Deserializer<'de>,
{
    let label = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match label.as_ref().and_then(serde_json::Value::as_str) {
        Some("subscription") => Some(FundingSource::Subscription),
        Some("api") => Some(FundingSource::Api),
        _ => None,
    })
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
    /// Caps per control-plane project, keyed by the project id the resolve
    /// validated for the credential (wire `credential.projectId`).
    #[serde(default, deserialize_with = "null_as_default")]
    pub projects: HashMap<String, LimitSpec>,
    /// Caps per bot, keyed by a verified agent id (never an unverified
    /// `x-ryu-agent-id`).
    #[serde(default, deserialize_with = "null_as_default")]
    pub bots: HashMap<String, LimitSpec>,
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
            && self.projects.is_empty()
            && self.bots.is_empty()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn funding_budgets_default_and_list_only_configured_caps() {
        let spec: LimitSpec =
            serde_json::from_value(serde_json::json!({ "fundingBudgets": null })).unwrap();
        assert_eq!(spec.funding_budgets, FundingBudgets::default());
        assert_eq!(spec.funding_budgets.caps().count(), 0);
        let spec: LimitSpec = serde_json::from_value(serde_json::json!({
            "fundingBudgets": { "subscriptionMicroUsd": null, "apiMicroUsd": 1000 }
        }))
        .unwrap();
        assert_eq!(
            spec.funding_budgets.caps().collect::<Vec<_>>(),
            [(FundingSource::Api, 1000)]
        );
    }

    #[test]
    fn project_and_bot_maps_count_toward_non_empty_limits() {
        let limits: OrgLimits = serde_json::from_value(serde_json::json!({
            "projects": null,
            "bots": { "ma:a1": { "budgetMicroUsd": 5 } }
        }))
        .unwrap();
        assert!(limits.projects.is_empty());
        assert_eq!(limits.bots["ma:a1"].budget_micro_usd, Some(5));
        assert!(!limits.is_empty());
    }
}

//! Fleet-wide spend snapshots (resolve `limitsSpend`) and how a cap admits
//! against them.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

use super::wire::{budget_quantity, null_as_default, FundingSource};
use crate::budget::{BudgetScope, BudgetWindow};

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
    /// The part of that spend each credit source paid, from the ledger
    /// (wire `fundingSpendMicroUsd`). Missing or `null` reads as zero.
    #[serde(default, deserialize_with = "null_as_default")]
    pub funding_spend_micro_usd: FundingSpend,
}

/// Window spend per credit source (wire `{ subscription, api }` in
/// micro-USD). A missing, negative or non-numeric figure reads as zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct FundingSpend {
    #[serde(default, deserialize_with = "zero_floor")]
    pub subscription: u64,
    #[serde(default, deserialize_with = "zero_floor")]
    pub api: u64,
}

impl FundingSpend {
    /// The spend paid from `source`.
    pub fn of(&self, source: FundingSource) -> u64 {
        match source {
            FundingSource::Subscription => self.subscription,
            FundingSource::Api => self.api,
        }
    }
}

fn zero_floor<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Lenient on purpose: a malformed figure must not fail the whole resolve.
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(serde_json::Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map_or(0, |number| number as u64))
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
    #[serde(default, deserialize_with = "budget_quantity")]
    pub projects: Option<u64>,
    #[serde(default, deserialize_with = "budget_quantity")]
    pub bots: Option<u64>,
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
    #[serde(default, deserialize_with = "null_as_default")]
    pub projects: HashMap<String, RemoteSpendEntry>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub bots: HashMap<String, RemoteSpendEntry>,
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
    pub(super) baselines: Mutex<HashMap<String, u64>>,
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
            BudgetScope::Project => self.projects.get(subject),
            BudgetScope::Bot => self.bots.get(subject),
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
            BudgetScope::Project => self.omitted.projects,
            BudgetScope::Bot => self.omitted.bots,
            _ => None,
        }
    }

    /// The spend to admit against for one cap, given the `local` counter.
    /// Without a usable remote figure this is exactly `local`.
    pub(super) fn effective(
        &self,
        scope: BudgetScope,
        subject: &str,
        store_id: &str,
        window: BudgetWindow,
        local: u64,
        now: i64,
    ) -> u64 {
        match self.snapshot(scope, subject, store_id, window, local, now) {
            Some(seen) => local.max(seen.total.saturating_add(seen.unreported)),
            None => local,
        }
    }

    /// The spend paid from `source` to admit against for one cap's funding
    /// budget. The remote ledger split plus this gateway's spend since the
    /// snapshot when it was drawn from `source`; with no draw source known
    /// (`None`) that spend counts toward both sources (fail closed). Without
    /// a usable snapshot the whole `local` counter is the unreported part.
    pub(super) fn funding_used(
        &self,
        source: FundingSource,
        draw: Option<FundingSource>,
        cap: (BudgetScope, &str, &str),
        window: BudgetWindow,
        local: u64,
        now: i64,
    ) -> u64 {
        let (scope, subject, store_id) = cap;
        let (remote, unreported) = match self.snapshot(scope, subject, store_id, window, local, now)
        {
            Some(seen) => (seen.funding.of(source), seen.unreported),
            None => (0, local),
        };
        let attributed = draw.is_none_or(|drawn| drawn == source);
        remote.saturating_add(if attributed { unreported } else { 0 })
    }

    /// The usable part of this snapshot for one cap: its remote spend and
    /// the local spend since the snapshot was first applied. `None` when the
    /// snapshot is stale, describes another window, or says nothing.
    fn snapshot(
        &self,
        scope: BudgetScope,
        subject: &str,
        store_id: &str,
        window: BudgetWindow,
        local: u64,
        now: i64,
    ) -> Option<Seen> {
        if self.as_of <= 0 || now.saturating_sub(self.as_of) > MAX_REMOTE_AGE_SECS {
            return None;
        }
        let window_start = window.start(now);
        let (total, funding) = match self.entry(scope, subject) {
            Some(entry) => {
                let remote = entry.spent_micro_usd?;
                if entry.window_start != window_start {
                    // The snapshot describes another window (it rolled over,
                    // or the cap's window changed): it says nothing about
                    // this one.
                    return None;
                }
                (remote, entry.funding_spend_micro_usd)
            }
            None => {
                // Not listed: either nothing was spent, or a truncated
                // snapshot left the subject out. In the second case admit
                // against the largest spend that was left out, as long as the
                // snapshot was taken inside this window. Any one source paid
                // at most that much.
                let ceiling = self.omitted_ceiling(scope)?;
                if self.as_of < window_start {
                    return None;
                }
                let funding = FundingSpend {
                    subscription: ceiling,
                    api: ceiling,
                };
                (ceiling, funding)
            }
        };
        let key = format!("{}:{store_id}:{window_start}", scope.as_str());
        let baseline = *self
            .baselines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key)
            .or_insert(local);
        Some(Seen {
            total,
            funding,
            unreported: local.saturating_sub(baseline),
        })
    }
}

/// What a usable snapshot says about one cap.
struct Seen {
    /// Fleet-wide spend in the window.
    total: u64,
    /// Its split by credit source.
    funding: FundingSpend,
    /// This gateway's spend since the snapshot was first applied.
    unreported: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_and_bot_entries_carry_their_credit_source_split() {
        let spend: RemoteSpend = serde_json::from_value(serde_json::json!({
            "asOf": 1,
            "projects": { "p1": { "spentMicroUsd": 9, "windowStart": 0,
                "fundingSpendMicroUsd": { "subscription": 6, "api": 3 } } },
            "bots": { "ma:a1": { "spentMicroUsd": 2, "windowStart": 0 } },
            "omitted": { "projects": 7, "bots": null }
        }))
        .unwrap();
        let project = &spend.projects["p1"].funding_spend_micro_usd;
        assert_eq!(project.of(FundingSource::Subscription), 6);
        assert_eq!(project.of(FundingSource::Api), 3);
        // An entry without a split reads as nothing paid from either source.
        assert_eq!(
            spend.bots["ma:a1"].funding_spend_micro_usd,
            FundingSpend::default()
        );
        assert_eq!(spend.omitted.projects, Some(7));
        assert_eq!(spend.omitted.bots, None);
    }
}

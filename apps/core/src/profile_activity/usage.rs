//! The local device usage snapshot: what is counted and when it is sent.

use super::*;

// ── Local device usage snapshot ─────────────────────────────────────────────────

/// One UTC day's absolute usage totals on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSnapshot {
    pub(super) day: NaiveDate,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) request_count: u64,
    pub(super) session_count: u64,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) by_model: BTreeMap<String, u64>,
}

impl UsageSnapshot {
    pub(super) fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.request_count == 0
            && self.session_count == 0
    }
}

/// One 15-minute bucket of the local Gateway's `/v1/audit/usage` rollup.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayUsageEvent {
    #[serde(default)]
    pub(super) model: String,
    /// The verified user id Core forwarded for the call, if any.
    #[serde(default)]
    pub(super) member_id: Option<String>,
    #[serde(default)]
    pub(super) input_tokens: u64,
    #[serde(default)]
    pub(super) output_tokens: u64,
    #[serde(default)]
    pub(super) request_count: u64,
    /// Model calls in `request_count` that errored or were denied; they are
    /// not requests on the profile, matching the Gateway reporter.
    #[serde(default)]
    pub(super) error_count: u64,
}

#[derive(Debug, Deserialize)]
pub(super) struct GatewayUsageRollup {
    #[serde(default)]
    pub(super) events: Vec<GatewayUsageEvent>,
}

/// Fold one day's Gateway rollup into the snapshot for the signed-in account.
/// Calls attributed to another verified member of a shared node are skipped;
/// calls with no member, or with `user_id` as the member, count. `byModel` keeps
/// the [`MAX_BY_MODEL`] busiest models with ids the control plane accepts.
pub(crate) fn aggregate_usage(
    day: NaiveDate,
    events: &[GatewayUsageEvent],
    user_id: Option<&str>,
    session_count: u64,
) -> UsageSnapshot {
    let mut snapshot = UsageSnapshot {
        day,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
        session_count: session_count.min(MAX_SAFE_COUNTER),
        by_model: BTreeMap::new(),
    };
    let mut models: HashMap<&str, u64> = HashMap::new();
    for event in events {
        let member = event
            .member_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if member.is_some_and(|member| Some(member) != user_id) {
            continue;
        }
        snapshot.input_tokens = snapshot.input_tokens.saturating_add(event.input_tokens);
        snapshot.output_tokens = snapshot.output_tokens.saturating_add(event.output_tokens);
        let requests = event.request_count.saturating_sub(event.error_count);
        snapshot.request_count = snapshot.request_count.saturating_add(requests);
        let model = event.model.trim();
        if requests > 0
            && !model.is_empty()
            && !model.starts_with('$')
            && model.encode_utf16().count() <= MAX_MODEL_KEY_UNITS
        {
            let count = models.entry(model).or_default();
            *count = count.saturating_add(requests);
        }
    }
    snapshot.input_tokens = snapshot.input_tokens.min(MAX_SAFE_COUNTER);
    snapshot.output_tokens = snapshot.output_tokens.min(MAX_SAFE_COUNTER);
    snapshot.request_count = snapshot.request_count.min(MAX_SAFE_COUNTER);
    let mut ranked: Vec<(&str, u64)> = models.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    ranked.truncate(MAX_BY_MODEL);
    snapshot.by_model = ranked
        .into_iter()
        .map(|(model, count)| (model.to_owned(), count.min(MAX_SAFE_COUNTER)))
        .collect();
    snapshot
}

/// Whether the account signed in since `account_since` may report `day`'s
/// usage: Core was running that day (`process_start` before its end) and the
/// account has been signed in, without a switch, since the day began or since
/// Core started, whichever is later.
pub(crate) fn usage_day_eligible(
    day: NaiveDate,
    account_since: DateTime<Utc>,
    process_start: DateTime<Utc>,
) -> bool {
    let Some(start) = day.and_hms_opt(0, 0, 0).map(|time| time.and_utc()) else {
        return false;
    };
    let end = start + chrono::Duration::days(1);
    process_start < end && account_since <= start.max(process_start)
}

/// Which usage snapshot the task should read this round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsagePlan {
    Skip,
    Today,
    /// The settled snapshot of the UTC day that just ended.
    YesterdayFinal,
}

/// Inputs to [`plan_usage`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct UsagePlanInputs<'a> {
    /// Core's Gateway is the local sidecar that does not report usage.
    pub(super) local_gateway: bool,
    /// Today already qualifies for (or is getting) the activity ping.
    pub(super) today_qualifies: bool,
    pub(super) account: &'a str,
    pub(super) today: NaiveDate,
    pub(super) eligible_today: bool,
    pub(super) eligible_yesterday: bool,
    /// [`USAGE_INTERVAL`] has passed since today's snapshot was last read.
    pub(super) today_check_due: bool,
    /// Snapshots the control plane accepted, per account.
    pub(super) sent: &'a [(String, UsageSnapshot)],
    /// `(account, day)` pairs that get no further snapshot: yesterday's final
    /// one went out, or the control plane rejected that day's snapshot.
    pub(super) settled: &'a [(String, NaiveDate)],
}

/// Decide which snapshot to read. Usage only rides on a day that qualifies for
/// the activity ping (the server marks the day it receives a post active, so a
/// snapshot alone must not create an active day, and Patrol's model calls
/// alone must not either). Yesterday's final snapshot goes first, once, and
/// only when a snapshot for yesterday was accepted while it was today, so it
/// never creates an active day of its own.
pub(crate) fn plan_usage(inputs: UsagePlanInputs<'_>) -> UsagePlan {
    if !inputs.local_gateway || !inputs.today_qualifies {
        return UsagePlan::Skip;
    }
    let settled = |day: NaiveDate| {
        inputs
            .settled
            .iter()
            .any(|(account, settled)| account == inputs.account && *settled == day)
    };
    if let Some(yesterday) = inputs.today.pred_opt() {
        let sent_yesterday = inputs
            .sent
            .iter()
            .any(|(account, sent)| account == inputs.account && sent.day == yesterday);
        if inputs.eligible_yesterday && sent_yesterday && !settled(yesterday) {
            return UsagePlan::YesterdayFinal;
        }
    }
    if inputs.eligible_today && inputs.today_check_due && !settled(inputs.today) {
        return UsagePlan::Today;
    }
    UsagePlan::Skip
}

pub(super) fn usage_check_due(last_check: Option<Instant>, now: Instant) -> bool {
    last_check.is_none_or(|at| now.saturating_duration_since(at) >= USAGE_INTERVAL)
}

/// Whether `snapshot` carries something the control plane has not yet accepted
/// for this account.
pub(crate) fn snapshot_changed(
    sent: &[(String, UsageSnapshot)],
    account: &str,
    snapshot: &UsageSnapshot,
) -> bool {
    !snapshot.is_empty()
        && !sent
            .iter()
            .any(|(sent_account, sent)| sent_account == account && sent == snapshot)
}

/// Snapshots the control plane accepted, and the read cadence.
#[derive(Debug, Default)]
pub(super) struct UsageState {
    /// The latest accepted snapshot per `(account, day)`, today and yesterday only.
    pub(super) sent: Vec<(String, UsageSnapshot)>,
    pub(super) last_check: Option<Instant>,
    /// `(account, day)` pairs that get no further snapshot, today and yesterday only.
    pub(super) settled: Vec<(String, NaiveDate)>,
}

impl UsageState {
    pub(super) fn accepted(&mut self, account: &str, snapshot: UsageSnapshot, today: NaiveDate) {
        let oldest = today.pred_opt().unwrap_or(today);
        self.sent.retain(|(sent_account, sent)| {
            sent.day >= oldest && !(sent_account == account && sent.day == snapshot.day)
        });
        if snapshot.day < today {
            self.settle(account, snapshot.day, today);
        }
        self.sent.push((account.to_owned(), snapshot));
    }

    /// Send nothing more for `account`'s `day`.
    pub(super) fn settle(&mut self, account: &str, day: NaiveDate, today: NaiveDate) {
        let oldest = today.pred_opt().unwrap_or(today);
        self.settled.retain(|(settled_account, settled)| {
            *settled >= oldest && !(settled_account == account && *settled == day)
        });
        self.settled.push((account.to_owned(), day));
    }
}

//! The signed-in account the task observes, and what it carries over a restart.

use super::*;

/// The signed-in `(token, user id)`. A legacy single-token sign-in has no user
/// id, so only unattributed turns can count for it.
pub(super) fn signed_in() -> Option<(String, Option<String>)> {
    let vault = crate::auth::load_accounts();
    if let Some(active) = vault.active() {
        return Some((active.token.clone(), Some(active.user_id.clone())));
    }
    crate::auth::load_token().map(|token| (token, None))
}

/// Tracks which account the task last observed, the counter at that moment, and
/// since when it has been the signed-in account without a switch.
#[derive(Debug, Default)]
pub(super) struct AccountWatch {
    /// `None` until the first observation; `Some(None)` = observed signed out.
    pub(super) observed: Option<Option<String>>,
    pub(super) baseline: u64,
    /// When the current account was first observed (task start, or the switch).
    pub(super) since: Option<DateTime<Utc>>,
    /// The first observation: when this process started watching.
    pub(super) started: Option<DateTime<Utc>>,
    /// The account and continuity start persisted by the previous process,
    /// consumed by the first observation.
    pub(super) carried: Option<(Option<String>, DateTime<Utc>)>,
    /// The first observation resumed the carried account.
    pub(super) resumed: bool,
}

impl AccountWatch {
    /// Note the account seen now and return its baseline. The very first
    /// observation (at task start) uses baseline 0: turns since the process
    /// started ran under that account. Any later change re-bases to `counter`.
    /// The first observation keeps the previous process's continuity start
    /// only when it saw the same account; anything else counts from now.
    pub(super) fn observe(
        &mut self,
        account: Option<&str>,
        counter: u64,
        now: DateTime<Utc>,
    ) -> u64 {
        let account = account.map(str::to_owned);
        match &self.observed {
            None => {
                self.baseline = 0;
                self.started = Some(now);
                let carried = self
                    .carried
                    .take()
                    .filter(|(carried, since)| *carried == account && *since <= now);
                self.resumed = account.is_some() && carried.is_some();
                self.since = Some(carried.map_or(now, |(_, since)| since));
            }
            Some(previous) if *previous != account => {
                self.baseline = counter;
                self.since = Some(now);
            }
            Some(_) => {}
        }
        self.observed = Some(account);
        self.baseline
    }

    /// Whether the current account may report `day`'s usage snapshot.
    pub(super) fn usage_eligible(&self, day: NaiveDate) -> bool {
        match (self.since, self.started) {
            (Some(since), Some(started)) => usage_day_eligible(day, since, started),
            _ => false,
        }
    }

    /// Where `day`'s usage read starts: the day's start, or the moment the
    /// current account became signed in, whichever is later, so usage from
    /// before a switch (or before an unverified restart) is never included.
    pub(super) fn usage_window_start(&self, day: NaiveDate) -> Option<DateTime<Utc>> {
        let start = day.and_hms_opt(0, 0, 0)?.and_utc();
        Some(self.since.map_or(start, |since| since.max(start)))
    }
}

/// What [`USAGE_CARRY_FILE`] holds.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UsageCarry {
    /// Account key observed; `None` when signed out.
    pub(super) account: Option<String>,
    pub(super) since: Option<DateTime<Utc>>,
    #[serde(default)]
    pub(super) sessions: BTreeMap<NaiveDate, DaySessions>,
}

pub(super) fn load_usage_carry() -> Option<UsageCarry> {
    let bytes = std::fs::read(crate::paths::state_path(USAGE_CARRY_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn save_usage_carry(carry: &UsageCarry) {
    let path = crate::paths::state_path(USAGE_CARRY_FILE);
    let result = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let bytes = serde_json::to_vec(carry).map_err(std::io::Error::other)?;
            std::fs::write(&path, bytes)
        });
    if let Err(error) = result {
        tracing::debug!("profile-activity: could not persist the usage carry: {error}");
    }
}

/// Persist the watched account's continuity start with the current sessions.
pub(super) async fn persist_usage_carry(watch: &AccountWatch) {
    let carry = UsageCarry {
        account: watch.observed.clone().flatten(),
        since: watch.since,
        sessions: session_days(),
    };
    let _ = tokio::task::spawn_blocking(move || save_usage_carry(&carry)).await;
}

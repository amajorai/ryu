//! Signed-in daily-activity ping that keeps the profile streak honest.
//!
//! The profile streak counts consecutive UTC days on which the user used Ryu,
//! and that includes agents running for them on a schedule (routines, cron,
//! workflows, channel bots). The Gateway usage reporter only runs on reporting
//! Gateways and background Core turns carry no user identity, so without this a
//! desktop user who only runs scheduled agents would never earn a streak day.
//!
//! **What is sent:** `POST {control plane}/api/profile/me/activity` with the body
//! `{"source":"core"}` and the signed-in account's bearer token: "this signed-in
//! account used Ryu today". The server stamps the UTC day itself; no content,
//! agent, or conversation is sent. When Core's Gateway is the local sidecar that
//! never reports usage to the control plane, the body may also carry a random
//! per-install `deviceId` (`state/profile-activity-device-id`) and a `usage`
//! snapshot: that UTC day's absolute token, request, and session counts on this
//! device plus request counts per model, read from the local Gateway's
//! `/v1/audit/usage` rollup. The server folds snapshots in with a per-counter
//! maximum, so a resend is harmless, and device usage earns no points.
//!
//! **Posture: opt-out, signed-in only, fail-open.**
//! - *Opt-out*: ON by default; `profile-activity-enabled` (or
//!   `RYU_PROFILE_ACTIVITY_ENABLED`) turns it off, usage snapshots included. The
//!   pref is re-read before every post, so a desktop toggle takes effect without
//!   a restart.
//! - *Signed-in only*: with no stored token it does nothing.
//! - *At most once per UTC day per account* for the ping itself: the last post is
//!   remembered as `(day, sha256(account) prefix)` in `state/profile-activity.json`
//!   (the account is the signed-in user id, or the token for a legacy
//!   single-token sign-in), so a restart does not re-post and an account switch
//!   does. The token is never logged or persisted.
//! - *Usage snapshots* ride only on a day that already qualifies for the ping, at
//!   most every [`USAGE_INTERVAL`] while the numbers change, plus one final
//!   snapshot of yesterday after UTC midnight when yesterday already sent one.
//!   They are sent only for an account that has been signed in, without a
//!   switch, since the start of that UTC day (or since Core started that day),
//!   and they count only Gateway calls made since that account was signed in,
//!   with no verified member or with the signed-in user as the member; errored
//!   or denied calls add tokens but are not requests. The account's continuity
//!   start and the day's conversations are carried across restarts in
//!   `state/profile-activity-usage.json`; a restart under a different (or no
//!   recorded) account counts only from the restart. A hosted or reporting
//!   Gateway already reports usage, so it never gets a snapshot here.
//! - *Only the account that was active*: activity is credited to an account only
//!   for turns admitted while it was the signed-in account. The background task
//!   records a baseline of the turn counter whenever it observes a different
//!   account, so switching accounts never hands the previous account's day to
//!   the new one.
//! - *Fail-open*: [`note_turn`] is a synchronous in-memory update with no I/O, so
//!   it never blocks or slows a turn. The post happens on a background task with
//!   a short timeout and exponential backoff; any error is logged at `debug`.
//!
//! **What counts:** every turn admitted through `route_chat_stream` (interactive
//! chat, run-text turns, scheduled agents, team members, channels, voice, A2A)
//! and every live workflow run, except the built-in Patrol health bot (otherwise
//! the streak would only mean "Ryu was running") and turns spoken by an
//! unverified outside caller. On a multi-user node a turn with a verified human
//! author counts only when that author is the signed-in account; turns with no
//! verified author (local loopback chat, scheduled agents, automation) count
//! for the signed-in account.
//!
//! **Sub-turns inherit their parent's attribution.** A turn's
//! [`ActivityAttribution`] is scoped over its execution as a task-local and
//! remembered for its conversation, so a delegate, coordinator worker, workflow
//! run, or app run that a tool starts during the turn is credited to the
//! parent's author (or excluded with it) instead of defaulting to the signed-in
//! account. Tool dispatch re-scopes the attribution from the host conversation,
//! and the fan-out sites that `tokio::spawn` carry it across the spawn. Work
//! with no parent turn (a scheduled run) still counts for the signed-in account.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDate, Utc};
use futures_util::future::Either;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use tokio::task::futures::TaskLocalFuture;

/// Per-request timeout for the control-plane POST and the Gateway usage read.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the task re-checks without a new turn (catches an account switch
/// or a sign-in after the day's first turn).
const RECHECK_INTERVAL: Duration = Duration::from_secs(600);
/// First retry delay after a failed post; doubles up to [`MAX_BACKOFF`].
const INITIAL_BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(3600);
/// Bytes of the token digest kept as the account key (hex-encoded).
const ACCOUNT_KEY_BYTES: usize = 16;
/// Remembers the last successful post across restarts.
const STATE_FILE: &str = "profile-activity.json";
/// Random install id that keys this device's usage snapshots (not the
/// community-stats install id).
const DEVICE_ID_FILE: &str = "profile-activity-device-id";
/// Carries the signed-in account's continuity start and the day's credited
/// conversations across restarts, so a restart neither resets the session count
/// nor credits a previous account's usage to the next one.
const USAGE_CARRY_FILE: &str = "profile-activity-usage.json";
/// Minimum spacing between two reads of today's usage snapshot.
const USAGE_INTERVAL: Duration = Duration::from_secs(1800);
/// The control plane accepts at most this many `byModel` keys.
const MAX_BY_MODEL: usize = 50;
/// Longest model id (in UTF-16 units, as the control plane measures it) it
/// accepts as a `byModel` key.
const MAX_MODEL_KEY_UNITS: usize = 256;
/// Counters stay exact in the control plane's JSON numbers.
const MAX_SAFE_COUNTER: u64 = (1 << 53) - 1;
/// Distinct conversations remembered per day and attribution bucket.
const MAX_SESSIONS_PER_DAY: usize = 5000;
/// Conversations whose turn attribution is remembered for tool dispatch.
const MAX_REMEMBERED_CONVERSATIONS: usize = 4096;
/// The Gateway's control-plane reporter credential.
const CONTROL_PLANE_KEY_ENV: &str = "CONTROL_PLANE_KEY";

/// One `(UTC day, account)` pair that was posted (or refused for that account).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ActivityMarker {
    day: NaiveDate,
    account: String,
}

/// Inputs to the post decision, gathered by the background task.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PostInputs<'a> {
    /// The resolved `profile-activity-enabled` preference.
    enabled: bool,
    /// Account key of the signed-in token, `None` when signed out.
    account: Option<&'a str>,
    /// The latest UTC day on which a qualifying turn ran.
    active_day: Option<NaiveDate>,
    /// Counter value of today's latest turn with no verified human author.
    last_unattributed_turn: u64,
    /// Counter value when the task first observed the current account.
    baseline: u64,
    /// Whether the signed-in account's user id authored a turn today.
    authored_turn_today: bool,
    /// Today's UTC date.
    today: NaiveDate,
    /// The last successful post.
    posted: Option<&'a ActivityMarker>,
    /// The last post the control plane refused for auth reasons.
    refused: Option<&'a ActivityMarker>,
}

/// Whether a turn counts as the user using Ryu. Patrol, the built-in hourly
/// health bot, is excluded so the streak does not merely mean "Ryu was running",
/// and so is a turn spoken by an unverified outside caller.
pub(crate) fn turn_counts_toward_activity(agent_id: Option<&str>, untrusted_caller: bool) -> bool {
    !untrusted_caller && agent_id.map(str::trim) != Some(crate::agents::patrol::AGENT_ID)
}

/// Whether the background task should post now. Only today's activity is ever
/// posted: the server stamps the day on receipt, so a turn from a previous day
/// that could not be posted in time must not credit today. An unattributed turn
/// counts only when it ran after the task observed this account (so a switch
/// does not inherit the previous account's activity); a turn verified as this
/// account's own user always counts.
pub(crate) fn should_post(inputs: PostInputs<'_>) -> bool {
    let Some(account) = inputs.account else {
        return false;
    };
    if !inputs.enabled || inputs.active_day != Some(inputs.today) {
        return false;
    }
    if !inputs.authored_turn_today && inputs.last_unattributed_turn <= inputs.baseline {
        return false;
    }
    let done = |marker: Option<&ActivityMarker>| {
        marker.is_some_and(|marker| marker.day == inputs.today && marker.account == account)
    };
    !done(inputs.posted) && !done(inputs.refused)
}

/// The non-reversible account key for a user id (or a legacy bearer token).
fn account_key(identity: &str) -> String {
    hex::encode(&Sha256::digest(identity.as_bytes())[..ACCOUNT_KEY_BYTES])
}

/// `{base}/api/profile/me/activity`, without doubling an operator-supplied `/api`.
fn activity_endpoint(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/api") {
        format!("{base}/profile/me/activity")
    } else {
        format!("{base}/api/profile/me/activity")
    }
}

fn utc_today() -> NaiveDate {
    Utc::now().date_naive()
}

// ── Attribution of a turn and the sub-turns it starts ───────────────────────────

/// Who a turn's activity is credited to. Sub-turns a turn starts inherit it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActivityAttribution {
    /// A verified human author; counts only when that user is signed in.
    Author(String),
    /// No verified author (loopback chat, scheduled runs): the signed-in account.
    Unattributed,
    /// Not user activity (Patrol, an unverified outside caller).
    Excluded,
}

tokio::task_local! {
    /// The attribution of the turn whose work runs on this task.
    static INHERITED_ATTRIBUTION: ActivityAttribution;
}

/// The attribution of a turn: its own exclusion or verified author first, else
/// the parent turn's (`inherited`), else the signed-in account. A sub-turn is
/// stamped with no author of its own, so without the inherited value a verified
/// user's delegated work would be credited to the signed-in account.
pub(crate) fn turn_attribution(
    agent_id: Option<&str>,
    untrusted_caller: bool,
    author_user_id: Option<&str>,
    inherited: Option<&ActivityAttribution>,
) -> ActivityAttribution {
    if !turn_counts_toward_activity(agent_id, untrusted_caller) {
        return ActivityAttribution::Excluded;
    }
    if let Some(author) = author_user_id.map(str::trim).filter(|id| !id.is_empty()) {
        return ActivityAttribution::Author(author.to_owned());
    }
    inherited
        .cloned()
        .unwrap_or(ActivityAttribution::Unattributed)
}

/// The attribution scoped over the current task, if a turn is running on it.
pub(crate) fn current_attribution() -> Option<ActivityAttribution> {
    INHERITED_ATTRIBUTION.try_with(Clone::clone).ok()
}

/// The attribution a tool call inherits: the task's own, else the one last
/// recorded for the host conversation (tool calls that arrive over the ACP
/// bridge or the Gateway exec plane run outside the turn's task).
pub(crate) fn dispatch_attribution(
    host_conversation_id: Option<&str>,
) -> Option<ActivityAttribution> {
    current_attribution().or_else(|| host_conversation_id.and_then(conversation_attribution))
}

/// Run `future` with `attribution` as the inherited attribution (unchanged
/// when `None`). Use it to carry a turn's attribution across a `tokio::spawn`.
/// Not an `async fn`, so a large turn future is not held twice in its state.
pub(crate) fn with_attribution<F: Future>(
    attribution: Option<ActivityAttribution>,
    future: F,
) -> Either<TaskLocalFuture<ActivityAttribution, F>, F> {
    match attribution {
        Some(attribution) => Either::Left(INHERITED_ATTRIBUTION.scope(attribution, future)),
        None => Either::Right(future),
    }
}

fn remembered_conversations() -> &'static Mutex<HashMap<String, ActivityAttribution>> {
    static CONVERSATIONS: OnceLock<Mutex<HashMap<String, ActivityAttribution>>> = OnceLock::new();
    CONVERSATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_conversation(conversation_id: &str, attribution: &ActivityAttribution) {
    let Ok(mut conversations) = remembered_conversations().lock() else {
        return;
    };
    if conversations.len() >= MAX_REMEMBERED_CONVERSATIONS
        && !conversations.contains_key(conversation_id)
    {
        conversations.clear();
    }
    conversations.insert(conversation_id.to_owned(), attribution.clone());
}

fn conversation_attribution(conversation_id: &str) -> Option<ActivityAttribution> {
    remembered_conversations()
        .lock()
        .ok()?
        .get(conversation_id.trim())
        .cloned()
}

// ── Today's activity log ────────────────────────────────────────────────────────

/// Distinct conversations with credited turns on one UTC day.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaySessions {
    #[serde(default)]
    unattributed: HashSet<String>,
    #[serde(default)]
    by_author: HashMap<String, HashSet<String>>,
}

impl DaySessions {
    fn insert(&mut self, author: Option<&str>, conversation_id: &str) {
        let sessions = match author {
            Some(author) => self.by_author.entry(author.to_owned()).or_default(),
            None => &mut self.unattributed,
        };
        if sessions.len() < MAX_SESSIONS_PER_DAY {
            sessions.insert(conversation_id.to_owned());
        }
    }

    /// Fold in conversations remembered before a restart, within the cap.
    fn merge(&mut self, other: DaySessions) {
        for conversation_id in other.unattributed {
            self.insert(None, &conversation_id);
        }
        for (author, conversations) in other.by_author {
            for conversation_id in conversations {
                self.insert(Some(&author), &conversation_id);
            }
        }
    }

    /// Conversations credited to the signed-in account: unattributed ones plus
    /// those its own user id authored.
    fn count_for(&self, user_id: Option<&str>) -> u64 {
        let own = user_id
            .and_then(|id| self.by_author.get(id))
            .map_or(0, |own| own.difference(&self.unattributed).count());
        (self.unattributed.len() + own) as u64
    }
}

/// Today's qualifying activity, shared with the background task. Reset on the
/// first turn of a new UTC day.
#[derive(Debug, Default)]
struct ActivityLog {
    /// The latest UTC day with a qualifying turn.
    day: Option<NaiveDate>,
    /// Monotonic turn counter; never reset, so baselines stay comparable.
    counter: u64,
    /// `counter` at today's latest turn without a verified human author (0 = none).
    last_unattributed_turn: u64,
    /// Verified human authors who ran a turn today.
    authors: HashSet<String>,
    /// Conversations with a credited turn, for today and yesterday (kept for
    /// yesterday's final snapshot).
    sessions: BTreeMap<NaiveDate, DaySessions>,
}

impl ActivityLog {
    /// Record one qualifying turn; returns whether the background task should
    /// be woken (first turn of the day, or a new author today).
    fn record(
        &mut self,
        today: NaiveDate,
        author_user_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> bool {
        let mut wake = false;
        if self.day != Some(today) {
            prune_session_days(&mut self.sessions, today);
            self.day = Some(today);
            self.last_unattributed_turn = 0;
            self.authors.clear();
            wake = true;
        }
        self.counter += 1;
        let author = author_user_id.map(str::trim).filter(|id| !id.is_empty());
        match author {
            Some(author) => {
                if !self.authors.contains(author) {
                    self.authors.insert(author.to_owned());
                    wake = true;
                }
            }
            None => self.last_unattributed_turn = self.counter,
        }
        if let Some(conversation_id) = conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
            self.sessions
                .entry(today)
                .or_default()
                .insert(author, conversation_id);
        }
        wake
    }

    /// Conversations credited to `user_id`'s account on `day`.
    fn sessions_on(&self, day: NaiveDate, user_id: Option<&str>) -> u64 {
        self.sessions
            .get(&day)
            .map_or(0, |sessions| sessions.count_for(user_id))
    }

    /// Fold in the conversations carried over a restart.
    fn restore_sessions(&mut self, carried: BTreeMap<NaiveDate, DaySessions>, today: NaiveDate) {
        for (day, sessions) in carried {
            self.sessions.entry(day).or_default().merge(sessions);
        }
        prune_session_days(&mut self.sessions, today);
    }
}

/// Keep only today's and yesterday's conversations.
fn prune_session_days(sessions: &mut BTreeMap<NaiveDate, DaySessions>, today: NaiveDate) {
    let oldest = today.pred_opt().unwrap_or(today);
    sessions.retain(|day, _| *day >= oldest && *day <= today);
}

fn activity_log() -> &'static Mutex<ActivityLog> {
    static LOG: OnceLock<Mutex<ActivityLog>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(ActivityLog::default()))
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Record that a turn was admitted with `attribution` (from
/// [`turn_attribution`]). Cheap and synchronous: no I/O, no network, and the
/// background task is woken only on the first qualifying turn of a day or a new
/// verified author. The attribution is remembered for `conversation_id` so the
/// turn's tool calls hand it to the sub-turns they start; `credit` is false for
/// a fan-out turn whose parent already recorded the activity. Whether a
/// verified author matches the signed-in account is decided by the task.
pub(crate) fn note_turn(
    attribution: &ActivityAttribution,
    conversation_id: Option<&str>,
    credit: bool,
) {
    let conversation_id = conversation_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(conversation_id) = conversation_id {
        remember_conversation(conversation_id, attribution);
    }
    if credit {
        credit_activity(attribution, conversation_id);
    }
}

/// Record activity that is not a chat turn (a live workflow run), under the
/// attribution of the turn that started it, if any.
pub(crate) fn note_activity() {
    let attribution = current_attribution().unwrap_or(ActivityAttribution::Unattributed);
    credit_activity(&attribution, None);
}

fn credit_activity(attribution: &ActivityAttribution, conversation_id: Option<&str>) {
    let author = match attribution {
        ActivityAttribution::Excluded => return,
        ActivityAttribution::Author(author) => Some(author.as_str()),
        ActivityAttribution::Unattributed => None,
    };
    let today = utc_today();
    let Ok(mut log) = activity_log().lock() else {
        return;
    };
    if log.record(today, author, conversation_id) {
        wake().notify_one();
    }
}

/// `(active day, counter, last unattributed turn, user authored today)`.
fn snapshot(user_id: Option<&str>) -> (Option<NaiveDate>, u64, u64, bool) {
    let Ok(log) = activity_log().lock() else {
        return (None, 0, 0, false);
    };
    let authored = user_id.is_some_and(|id| log.authors.contains(id));
    (log.day, log.counter, log.last_unattributed_turn, authored)
}

fn sessions_on(day: NaiveDate, user_id: Option<&str>) -> u64 {
    activity_log()
        .lock()
        .map_or(0, |log| log.sessions_on(day, user_id))
}

fn session_days() -> BTreeMap<NaiveDate, DaySessions> {
    activity_log()
        .lock()
        .map(|log| log.sessions.clone())
        .unwrap_or_default()
}

fn restore_sessions(carried: BTreeMap<NaiveDate, DaySessions>) {
    if let Ok(mut log) = activity_log().lock() {
        log.restore_sessions(carried, utc_today());
    }
}

/// The signed-in `(token, user id)`. A legacy single-token sign-in has no user
/// id, so only unattributed turns can count for it.
fn signed_in() -> Option<(String, Option<String>)> {
    let vault = crate::auth::load_accounts();
    if let Some(active) = vault.active() {
        return Some((active.token.clone(), Some(active.user_id.clone())));
    }
    crate::auth::load_token().map(|token| (token, None))
}

/// Tracks which account the task last observed, the counter at that moment, and
/// since when it has been the signed-in account without a switch.
#[derive(Debug, Default)]
struct AccountWatch {
    /// `None` until the first observation; `Some(None)` = observed signed out.
    observed: Option<Option<String>>,
    baseline: u64,
    /// When the current account was first observed (task start, or the switch).
    since: Option<DateTime<Utc>>,
    /// The first observation: when this process started watching.
    started: Option<DateTime<Utc>>,
    /// The account and continuity start persisted by the previous process,
    /// consumed by the first observation.
    carried: Option<(Option<String>, DateTime<Utc>)>,
    /// The first observation resumed the carried account.
    resumed: bool,
}

impl AccountWatch {
    /// Note the account seen now and return its baseline. The very first
    /// observation (at task start) uses baseline 0: turns since the process
    /// started ran under that account. Any later change re-bases to `counter`.
    /// The first observation keeps the previous process's continuity start
    /// only when it saw the same account; anything else counts from now.
    fn observe(&mut self, account: Option<&str>, counter: u64, now: DateTime<Utc>) -> u64 {
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
    fn usage_eligible(&self, day: NaiveDate) -> bool {
        match (self.since, self.started) {
            (Some(since), Some(started)) => usage_day_eligible(day, since, started),
            _ => false,
        }
    }

    /// Where `day`'s usage read starts: the day's start, or the moment the
    /// current account became signed in, whichever is later, so usage from
    /// before a switch (or before an unverified restart) is never included.
    fn usage_window_start(&self, day: NaiveDate) -> Option<DateTime<Utc>> {
        let start = day.and_hms_opt(0, 0, 0)?.and_utc();
        Some(self.since.map_or(start, |since| since.max(start)))
    }
}

/// What [`USAGE_CARRY_FILE`] holds.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageCarry {
    /// Account key observed; `None` when signed out.
    account: Option<String>,
    since: Option<DateTime<Utc>>,
    #[serde(default)]
    sessions: BTreeMap<NaiveDate, DaySessions>,
}

fn load_usage_carry() -> Option<UsageCarry> {
    let bytes = std::fs::read(crate::paths::state_path(USAGE_CARRY_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_usage_carry(carry: &UsageCarry) {
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
async fn persist_usage_carry(watch: &AccountWatch) {
    let carry = UsageCarry {
        account: watch.observed.clone().flatten(),
        since: watch.since,
        sessions: session_days(),
    };
    let _ = tokio::task::spawn_blocking(move || save_usage_carry(&carry)).await;
}

// ── Local device usage snapshot ─────────────────────────────────────────────────

/// One UTC day's absolute usage totals on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSnapshot {
    day: NaiveDate,
    input_tokens: u64,
    output_tokens: u64,
    request_count: u64,
    session_count: u64,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    by_model: BTreeMap<String, u64>,
}

impl UsageSnapshot {
    fn is_empty(&self) -> bool {
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
    model: String,
    /// The verified user id Core forwarded for the call, if any.
    #[serde(default)]
    member_id: Option<String>,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    request_count: u64,
    /// Model calls in `request_count` that errored or were denied; they are
    /// not requests on the profile, matching the Gateway reporter.
    #[serde(default)]
    error_count: u64,
}

#[derive(Debug, Deserialize)]
struct GatewayUsageRollup {
    #[serde(default)]
    events: Vec<GatewayUsageEvent>,
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
    local_gateway: bool,
    /// Today already qualifies for (or is getting) the activity ping.
    today_qualifies: bool,
    account: &'a str,
    today: NaiveDate,
    eligible_today: bool,
    eligible_yesterday: bool,
    /// [`USAGE_INTERVAL`] has passed since today's snapshot was last read.
    today_check_due: bool,
    /// Snapshots the control plane accepted, per account.
    sent: &'a [(String, UsageSnapshot)],
    /// `(account, day)` pairs that get no further snapshot: yesterday's final
    /// one went out, or the control plane rejected that day's snapshot.
    settled: &'a [(String, NaiveDate)],
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

fn usage_check_due(last_check: Option<Instant>, now: Instant) -> bool {
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
struct UsageState {
    /// The latest accepted snapshot per `(account, day)`, today and yesterday only.
    sent: Vec<(String, UsageSnapshot)>,
    last_check: Option<Instant>,
    /// `(account, day)` pairs that get no further snapshot, today and yesterday only.
    settled: Vec<(String, NaiveDate)>,
}

impl UsageState {
    fn accepted(&mut self, account: &str, snapshot: UsageSnapshot, today: NaiveDate) {
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
    fn settle(&mut self, account: &str, day: NaiveDate, today: NaiveDate) {
        let oldest = today.pred_opt().unwrap_or(today);
        self.settled.retain(|(settled_account, settled)| {
            *settled >= oldest && !(settled_account == account && *settled == day)
        });
        self.settled.push((account.to_owned(), day));
    }
}

/// The POST body: always `source`; `deviceId` and `usage` only together.
fn activity_body(device_id: Option<&str>, usage: Option<&UsageSnapshot>) -> serde_json::Value {
    match (device_id, usage) {
        (Some(device_id), Some(usage)) => serde_json::json!({
            "source": "core",
            "deviceId": device_id,
            "usage": usage,
        }),
        _ => serde_json::json!({ "source": "core" }),
    }
}

fn valid_device_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// This install's usage device id, created on first use. `None` when it cannot
/// be persisted: a fresh id after every restart would count a day twice.
fn load_or_create_device_id() -> Option<String> {
    let path = crate::paths::state_path(DEVICE_ID_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if valid_device_id(existing) {
            return Some(existing.to_owned());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, &id));
    match written {
        Ok(()) => Some(id),
        Err(error) => {
            tracing::debug!("profile-activity: could not persist the device id: {error}");
            None
        }
    }
}

/// Whether a Gateway config enables control-plane reporting. An unreadable or
/// unparsable config counts as reporting, so usage is never double counted.
pub(crate) fn gateway_config_reports_usage(config: Option<&str>) -> bool {
    let Some(config) = config else {
        return false;
    };
    let Ok(config) = toml::from_str::<toml::Value>(config) else {
        return true;
    };
    config
        .get("control_plane")
        .and_then(|control_plane| control_plane.get("enabled"))
        .and_then(toml::Value::as_bool)
        .unwrap_or(false)
}

/// Whether Core's Gateway is the local sidecar whose usage reaches the control
/// plane only through this snapshot: Core spawned it (no remote data plane, no
/// managed node, no operator Gateway) and neither its env nor its config turns
/// on the control-plane reporter. Blocking: reads the Gateway config file.
fn local_gateway_is_non_reporting() -> bool {
    if !crate::sidecar::gateway::core_spawned_local_gateway() {
        return false;
    }
    if std::env::var(CONTROL_PLANE_KEY_ENV).is_ok_and(|key| !key.trim().is_empty()) {
        return false;
    }
    // The same path the Gateway loads: `GATEWAY_CONFIG`, else the profile's
    // default `gateway.toml`.
    let config = match crate::server::gateway_config_path() {
        None => None,
        Some(path) => match std::fs::read_to_string(path) {
            Ok(config) => Some(config),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return false,
        },
    };
    !gateway_config_reports_usage(config.as_deref())
}

/// Read one UTC day's rollup, from `from` to the day's end, from the local
/// Gateway with its admin credential.
async fn fetch_usage_events(
    client: &reqwest::Client,
    day: NaiveDate,
    from: DateTime<Utc>,
) -> Option<Vec<GatewayUsageEvent>> {
    let end = day.and_hms_opt(0, 0, 0)?.and_utc() + chrono::Duration::days(1);
    if from >= end {
        return Some(Vec::new());
    }
    let key = tokio::task::spawn_blocking(crate::sidecar::gateway::gateway_admin_key)
        .await
        .ok()
        .flatten()?;
    let base = crate::sidecar::gateway::gateway_url();
    let url = format!(
        "{}/v1/audit/usage?from={}&until={}",
        base.trim_end_matches('/'),
        from.format("%Y-%m-%dT%H:%M:%SZ"),
        end.format("%Y-%m-%dT%H:%M:%SZ"),
    );
    let response = match client.get(&url).bearer_auth(key).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::debug!(
                "profile-activity: Gateway usage read returned {}",
                response.status()
            );
            return None;
        }
        Err(error) => {
            tracing::debug!("profile-activity: Gateway usage read failed: {error}");
            return None;
        }
    };
    match response.json::<GatewayUsageRollup>().await {
        Ok(rollup) => Some(rollup.events),
        Err(error) => {
            tracing::debug!("profile-activity: Gateway usage rollup unreadable: {error}");
            None
        }
    }
}

// ── Posting ─────────────────────────────────────────────────────────────────────

fn load_posted() -> Option<ActivityMarker> {
    let bytes = std::fs::read(crate::paths::state_path(STATE_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_posted(marker: &ActivityMarker) {
    let path = crate::paths::state_path(STATE_FILE);
    let result = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let bytes = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
            std::fs::write(&path, bytes)
        });
    if let Err(error) = result {
        tracing::debug!("profile-activity: could not persist the last post: {error}");
    }
}

enum PostOutcome {
    Recorded,
    /// The control plane refused this token (401/403); wait for a new token.
    Refused,
    /// The control plane rejected the body (a 4xx other than auth, timeout, or
    /// rate limit); resending the same body cannot succeed.
    Rejected,
    /// Network error or a retryable status; back off and try again.
    Retry,
}

async fn post_activity(
    client: &reqwest::Client,
    token: &str,
    body: &serde_json::Value,
) -> PostOutcome {
    let endpoint = activity_endpoint(&crate::sidecar::mcp::challenges_tool::control_plane_base());
    match client
        .post(&endpoint)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => PostOutcome::Recorded,
        Ok(response)
            if matches!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
            ) =>
        {
            tracing::debug!(
                "profile-activity: control plane refused the signed-in token ({})",
                response.status()
            );
            PostOutcome::Refused
        }
        Ok(response)
            if response.status().is_client_error()
                && !matches!(
                    response.status(),
                    reqwest::StatusCode::REQUEST_TIMEOUT | reqwest::StatusCode::TOO_MANY_REQUESTS
                ) =>
        {
            tracing::debug!(
                "profile-activity: control plane rejected the activity POST ({})",
                response.status()
            );
            PostOutcome::Rejected
        }
        Ok(response) => {
            tracing::debug!(
                "profile-activity: activity POST returned {} (will retry)",
                response.status()
            );
            PostOutcome::Retry
        }
        Err(error) => {
            tracing::debug!("profile-activity: activity POST failed (will retry): {error}");
            PostOutcome::Retry
        }
    }
}

/// Read the usage snapshot `plan` names, if it has news for this account.
async fn pending_usage(
    client: &reqwest::Client,
    plan: UsagePlan,
    today: NaiveDate,
    account: &str,
    user_id: Option<&str>,
    watch: &AccountWatch,
    usage: &mut UsageState,
) -> Option<UsageSnapshot> {
    let day = match plan {
        UsagePlan::Skip => return None,
        UsagePlan::Today => {
            usage.last_check = Some(Instant::now());
            today
        }
        UsagePlan::YesterdayFinal => today.pred_opt()?,
    };
    let from = watch.usage_window_start(day)?;
    let events = fetch_usage_events(client, day, from).await?;
    // Carry the day's conversations before the count leaves the device, so a
    // restart never sends a smaller session count than one already accepted.
    persist_usage_carry(watch).await;
    let snapshot = aggregate_usage(day, &events, user_id, sessions_on(day, user_id));
    if snapshot_changed(&usage.sent, account, &snapshot) {
        return Some(snapshot);
    }
    if plan == UsagePlan::YesterdayFinal {
        usage.settle(account, day, today);
    }
    None
}

/// Spawn the background poster. Returns immediately; never panics or blocks.
pub fn spawn_profile_activity(prefs: crate::server::preferences::PreferencesStore) {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        let mut posted = tokio::task::spawn_blocking(load_posted)
            .await
            .ok()
            .flatten();
        let mut refused: Option<ActivityMarker> = None;
        let mut watch = AccountWatch::default();
        let mut carried_sessions = None;
        if let Some(carry) = tokio::task::spawn_blocking(load_usage_carry)
            .await
            .ok()
            .flatten()
        {
            watch.carried = carry.since.map(|since| (carry.account, since));
            carried_sessions = Some(carry.sessions);
        }
        let mut usage = UsageState::default();
        let mut device_id: Option<String> = None;
        let mut first = true;

        loop {
            if !std::mem::take(&mut first) {
                // A turn wakes the task at once; the timeout re-checks for a later
                // sign-in or account switch on a day that already had activity,
                // and for a changed usage snapshot.
                let _ = tokio::time::timeout(RECHECK_INTERVAL, wake().notified()).await;
            }

            let mut backoff = INITIAL_BACKOFF;
            loop {
                // Isolated offline fixtures never reach the control plane.
                let enabled = !crate::offline_test_bootstrap::is_active()
                    && crate::privacy::profile_activity_enabled(&prefs).await;
                // The account is always resolved (even when disabled) so the
                // baseline and the usage stability window follow every switch.
                let signed_in = tokio::task::spawn_blocking(signed_in)
                    .await
                    .ok()
                    .flatten()
                    .filter(|(token, _)| !token.trim().is_empty());
                let (token, user_id) = signed_in.unzip();
                let user_id = user_id.flatten();
                let account = user_id.as_deref().or(token.as_deref()).map(account_key);
                let (active_day, counter, last_unattributed_turn, authored_turn_today) =
                    snapshot(user_id.as_deref());
                let now = Utc::now();
                let since_before = watch.since;
                let baseline = watch.observe(account.as_deref(), counter, now);
                if let Some(carried) = carried_sessions.take() {
                    if watch.resumed {
                        restore_sessions(carried);
                    }
                }
                if watch.since != since_before {
                    persist_usage_carry(&watch).await;
                }
                let today = now.date_naive();
                let post = should_post(PostInputs {
                    enabled,
                    account: account.as_deref(),
                    active_day,
                    last_unattributed_turn,
                    baseline,
                    authored_turn_today,
                    today,
                    posted: posted.as_ref(),
                    refused: refused.as_ref(),
                });
                let (Some(token), Some(account)) = (token, account) else {
                    break;
                };
                let posted_today = posted
                    .as_ref()
                    .is_some_and(|marker| marker.day == today && marker.account == account);
                let refused_today = refused
                    .as_ref()
                    .is_some_and(|marker| marker.day == today && marker.account == account);

                let mut plan = UsagePlan::Skip;
                if enabled && !refused_today && (post || posted_today) {
                    let local_gateway = tokio::task::spawn_blocking(local_gateway_is_non_reporting)
                        .await
                        .unwrap_or(false);
                    plan = plan_usage(UsagePlanInputs {
                        local_gateway,
                        today_qualifies: post || posted_today,
                        account: &account,
                        today,
                        eligible_today: watch.usage_eligible(today),
                        eligible_yesterday: today
                            .pred_opt()
                            .is_some_and(|yesterday| watch.usage_eligible(yesterday)),
                        today_check_due: usage_check_due(usage.last_check, Instant::now()),
                        sent: &usage.sent,
                        settled: &usage.settled,
                    });
                    if plan != UsagePlan::Skip && device_id.is_none() {
                        device_id = tokio::task::spawn_blocking(load_or_create_device_id)
                            .await
                            .ok()
                            .flatten();
                    }
                    if device_id.is_none() {
                        plan = UsagePlan::Skip;
                    }
                }
                let snapshot = pending_usage(
                    &client,
                    plan,
                    today,
                    &account,
                    user_id.as_deref(),
                    &watch,
                    &mut usage,
                )
                .await;
                if !post && snapshot.is_none() {
                    break;
                }

                let body = activity_body(device_id.as_deref(), snapshot.as_ref());
                let marker = ActivityMarker {
                    day: today,
                    account: account.clone(),
                };
                match post_activity(&client, &token, &body).await {
                    PostOutcome::Recorded => {
                        if !posted_today {
                            let saved = marker.clone();
                            let _ = tokio::task::spawn_blocking(move || save_posted(&saved)).await;
                            posted = Some(marker);
                        }
                        if let Some(snapshot) = snapshot {
                            usage.accepted(&account, snapshot, today);
                        }
                        // Re-evaluate at once: yesterday's final snapshot may
                        // leave today's to send. Each plan advances its own
                        // cadence, so this settles in a round or two.
                    }
                    PostOutcome::Refused => {
                        refused = Some(marker);
                        break;
                    }
                    // A rejected snapshot (an older control plane's body
                    // limit, a key it refuses) is never resent for that day;
                    // the next round posts the ping without it.
                    PostOutcome::Rejected if snapshot.is_some() => {
                        if let Some(snapshot) = snapshot {
                            usage.settle(&account, snapshot.day, today);
                        }
                    }
                    PostOutcome::Rejected | PostOutcome::Retry => {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn marker(on: &str, account: &str) -> ActivityMarker {
        ActivityMarker {
            day: day(on),
            account: account.to_owned(),
        }
    }

    fn inputs<'a>(
        account: Option<&'a str>,
        posted: Option<&'a ActivityMarker>,
        refused: Option<&'a ActivityMarker>,
    ) -> PostInputs<'a> {
        PostInputs {
            enabled: true,
            account,
            active_day: Some(day("2026-10-18")),
            last_unattributed_turn: 1,
            baseline: 0,
            authored_turn_today: false,
            today: day("2026-10-18"),
            posted,
            refused,
        }
    }

    #[test]
    fn patrol_and_untrusted_callers_do_not_count() {
        assert!(turn_counts_toward_activity(None, false));
        assert!(turn_counts_toward_activity(Some("ryu"), false));
        assert!(turn_counts_toward_activity(Some("my-cron-agent"), false));
        assert!(!turn_counts_toward_activity(
            Some(crate::agents::patrol::AGENT_ID),
            false
        ));
        assert!(!turn_counts_toward_activity(Some(" patrol "), false));
        assert!(!turn_counts_toward_activity(None, true));
        assert!(!turn_counts_toward_activity(Some("ryu"), true));
    }

    #[test]
    fn posts_once_per_day_per_account() {
        assert!(should_post(inputs(Some("a"), None, None)));
        let today_a = marker("2026-10-18", "a");
        assert!(!should_post(inputs(Some("a"), Some(&today_a), None)));
        // An account switch re-posts the same day.
        assert!(should_post(inputs(Some("b"), Some(&today_a), None)));
        // Yesterday's post does not cover today.
        let yesterday_a = marker("2026-10-17", "a");
        assert!(should_post(inputs(Some("a"), Some(&yesterday_a), None)));
        // A refused token is not retried the same day, but a new token is.
        assert!(!should_post(inputs(Some("a"), None, Some(&today_a))));
        assert!(should_post(inputs(Some("b"), None, Some(&today_a))));
    }

    #[test]
    fn skips_when_disabled_signed_out_or_idle_today() {
        assert!(!should_post(PostInputs {
            enabled: false,
            ..inputs(Some("a"), None, None)
        }));
        assert!(!should_post(inputs(None, None, None)));
        assert!(!should_post(PostInputs {
            active_day: None,
            ..inputs(Some("a"), None, None)
        }));
        // Activity from yesterday must never be credited to today.
        assert!(!should_post(PostInputs {
            active_day: Some(day("2026-10-17")),
            ..inputs(Some("a"), None, None)
        }));
    }

    #[test]
    fn account_switch_does_not_inherit_the_previous_accounts_activity() {
        let mut log = ActivityLog::default();
        let mut watch = AccountWatch::default();
        let today = day("2026-10-18");
        let observe = |watch: &mut AccountWatch, log: &ActivityLog, account: &str| PostInputs {
            last_unattributed_turn: log.last_unattributed_turn,
            baseline: watch.observe(Some(account), log.counter, at("2026-10-18T09:00:00Z")),
            ..inputs(None, None, None)
        };

        // Signed in as A at start; a turn under A posts for A.
        assert_eq!(
            watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
            0
        );
        log.record(today, None, None);
        let a = observe(&mut watch, &log, "a");
        assert!(should_post(PostInputs {
            account: Some("a"),
            ..a
        }));

        // Switch to B with no new turn: nothing to post for B.
        let b = observe(&mut watch, &log, "b");
        assert!(!should_post(PostInputs {
            account: Some("b"),
            ..b
        }));

        // A turn after the switch credits B.
        log.record(today, None, None);
        let b = observe(&mut watch, &log, "b");
        assert!(should_post(PostInputs {
            account: Some("b"),
            ..b
        }));

        // Switching back to A re-bases A too.
        let a = observe(&mut watch, &log, "a");
        assert!(!should_post(PostInputs {
            account: Some("a"),
            ..a
        }));
    }

    #[test]
    fn first_observation_counts_turns_since_start() {
        let mut log = ActivityLog::default();
        log.record(day("2026-10-18"), None, None);
        let mut watch = AccountWatch::default();
        assert_eq!(
            watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
            0
        );
        // Signing in later re-bases: signed-out turns do not count.
        let mut watch = AccountWatch::default();
        watch.observe(None, 0, at("2026-10-18T09:00:00Z"));
        assert_eq!(
            watch.observe(Some("a"), log.counter, at("2026-10-18T09:00:00Z")),
            1
        );
    }

    #[test]
    fn verified_authors_count_only_for_their_own_account() {
        let mut log = ActivityLog::default();
        let today = day("2026-10-18");
        // Another verified user on a shared node.
        log.record(today, Some("user-x"), None);
        assert_eq!(log.last_unattributed_turn, 0);
        assert!(log.authors.contains("user-x"));
        let base = PostInputs {
            last_unattributed_turn: log.last_unattributed_turn,
            ..inputs(Some("owner"), None, None)
        };
        // The signed-in owner is not user-x: no post.
        assert!(!should_post(base));
        // When the signed-in account is user-x, its own turn counts even
        // when it ran before the task observed the account.
        assert!(should_post(PostInputs {
            authored_turn_today: true,
            baseline: 5,
            ..base
        }));
        // An unattributed (loopback / scheduled) turn counts for the owner.
        log.record(today, None, None);
        assert!(should_post(PostInputs {
            last_unattributed_turn: log.last_unattributed_turn,
            ..base
        }));
    }

    #[test]
    fn a_new_day_resets_attribution() {
        let mut log = ActivityLog::default();
        assert!(log.record(day("2026-10-17"), None, None));
        assert!(!log.record(day("2026-10-17"), None, None));
        assert!(log.record(day("2026-10-17"), Some("x"), None));
        // First turn of the next day is by another user: yesterday's
        // unattributed turn must not credit the owner today.
        assert!(log.record(day("2026-10-18"), Some("x"), None));
        assert_eq!(log.last_unattributed_turn, 0);
        assert_eq!(log.counter, 4);
    }

    #[test]
    fn patrol_never_counts_even_with_a_matching_author() {
        // Patrol is excluded by agent id alone, so a forwarded identity cannot
        // turn a health-bot run into streak activity.
        assert!(!turn_counts_toward_activity(
            Some(crate::agents::patrol::AGENT_ID),
            false
        ));
        let mut log = ActivityLog::default();
        // note_turn returns before recording; mirror that here.
        if turn_counts_toward_activity(Some(crate::agents::patrol::AGENT_ID), false) {
            log.record(day("2026-10-18"), Some("owner"), None);
        }
        assert_eq!(log.counter, 0);
    }

    #[test]
    fn account_key_is_stable_and_does_not_contain_the_token() {
        let key = account_key("secret-token");
        assert_eq!(key, account_key("secret-token"));
        assert_ne!(key, account_key("other-token"));
        assert_eq!(key.len(), ACCOUNT_KEY_BYTES * 2);
        assert!(!key.contains("secret"));
    }

    #[test]
    fn endpoint_does_not_double_the_api_mount() {
        assert_eq!(
            activity_endpoint("https://api.example/"),
            "https://api.example/api/profile/me/activity"
        );
        assert_eq!(
            activity_endpoint("https://api.example/api"),
            "https://api.example/api/profile/me/activity"
        );
    }

    #[test]
    fn marker_round_trips_through_json() {
        let original = marker("2026-10-18", "abc");
        let bytes = serde_json::to_vec(&original).unwrap();
        assert_eq!(
            serde_json::from_slice::<ActivityMarker>(&bytes).unwrap(),
            original
        );
    }

    fn event(
        model: &str,
        member: Option<&str>,
        input: u64,
        output: u64,
        requests: u64,
    ) -> GatewayUsageEvent {
        GatewayUsageEvent {
            model: model.to_owned(),
            member_id: member.map(str::to_owned),
            input_tokens: input,
            output_tokens: output,
            request_count: requests,
            error_count: 0,
        }
    }

    fn usage_inputs<'a>(
        sent: &'a [(String, UsageSnapshot)],
        settled: &'a [(String, NaiveDate)],
    ) -> UsagePlanInputs<'a> {
        UsagePlanInputs {
            local_gateway: true,
            today_qualifies: true,
            account: "a",
            today: day("2026-10-18"),
            eligible_today: true,
            eligible_yesterday: false,
            today_check_due: true,
            sent,
            settled,
        }
    }

    #[test]
    fn sub_turns_inherit_the_parent_turns_attribution() {
        let author = ActivityAttribution::Author("user-b".to_owned());
        // A delegated sub-turn carries no author of its own.
        assert_eq!(
            turn_attribution(Some("ryu"), false, None, Some(&author)),
            author
        );
        // Its own verified author still wins.
        assert_eq!(
            turn_attribution(Some("ryu"), false, Some("user-c"), Some(&author)),
            ActivityAttribution::Author("user-c".to_owned())
        );
        // An excluded parent (Patrol, an outside caller) keeps its fan-out excluded.
        assert_eq!(
            turn_attribution(
                Some("ryu"),
                false,
                None,
                Some(&ActivityAttribution::Excluded)
            ),
            ActivityAttribution::Excluded
        );
        // A scheduled run has no parent: it counts for the signed-in account.
        assert_eq!(
            turn_attribution(Some("my-cron-agent"), false, None, None),
            ActivityAttribution::Unattributed
        );
        // Patrol and untrusted callers are excluded whatever they inherit.
        assert_eq!(
            turn_attribution(
                Some(crate::agents::patrol::AGENT_ID),
                false,
                None,
                Some(&author)
            ),
            ActivityAttribution::Excluded
        );
        assert_eq!(
            turn_attribution(None, true, Some("user-b"), None),
            ActivityAttribution::Excluded
        );
    }

    #[tokio::test]
    async fn attribution_flows_through_the_task_and_the_host_conversation() {
        assert_eq!(current_attribution(), None);
        let author = ActivityAttribution::Author("user-b".to_owned());
        let inside = with_attribution(Some(author.clone()), async {
            // A nested sub-turn resolves against the scoped parent.
            turn_attribution(Some("ryu"), false, None, current_attribution().as_ref())
        })
        .await;
        assert_eq!(inside, author);
        // `None` leaves the task unscoped.
        assert_eq!(
            with_attribution(None, async { current_attribution() }).await,
            None
        );

        // A tool call arriving off-task resolves from its host conversation.
        note_turn(&author, Some("conv-attribution-test"), false);
        assert_eq!(
            dispatch_attribution(Some("conv-attribution-test")),
            Some(author.clone())
        );
        assert_eq!(dispatch_attribution(Some("conv-never-seen")), None);
        // The task's own scope wins over the remembered conversation.
        let scoped = with_attribution(Some(ActivityAttribution::Excluded), async {
            dispatch_attribution(Some("conv-attribution-test"))
        })
        .await;
        assert_eq!(scoped, Some(ActivityAttribution::Excluded));
    }

    #[test]
    fn sessions_count_only_the_signed_in_accounts_conversations() {
        let mut log = ActivityLog::default();
        let today = day("2026-10-18");
        log.record(today, None, Some("c1"));
        log.record(today, None, Some("c1"));
        log.record(today, Some("owner"), Some("c2"));
        log.record(today, Some("owner"), Some("c1"));
        log.record(today, Some("user-x"), Some("c3"));
        assert_eq!(log.sessions_on(today, Some("owner")), 2);
        assert_eq!(log.sessions_on(today, Some("user-x")), 2);
        assert_eq!(log.sessions_on(today, None), 1);
        // Yesterday's sessions survive the rollover for the final snapshot.
        log.record(day("2026-10-19"), None, Some("c9"));
        assert_eq!(log.sessions_on(today, Some("owner")), 2);
        assert_eq!(log.sessions_on(day("2026-10-19"), Some("owner")), 1);
        // A gap of more than a day drops them.
        log.record(day("2026-10-21"), None, None);
        assert_eq!(log.sessions_on(day("2026-10-19"), None), 0);
    }

    #[test]
    fn usage_aggregates_own_and_unattributed_calls_only() {
        let events = [
            event("gpt-x", None, 100, 10, 2),
            event("gpt-x", Some("owner"), 50, 5, 1),
            event("claude-y", Some(" "), 7, 3, 1),
            event("gpt-x", Some("user-x"), 999, 999, 9),
            // An exec-only bucket carries no model call.
            event("exec", None, 0, 0, 0),
        ];
        let snapshot = aggregate_usage(day("2026-10-18"), &events, Some("owner"), 4);
        assert_eq!(snapshot.input_tokens, 157);
        assert_eq!(snapshot.output_tokens, 18);
        assert_eq!(snapshot.request_count, 4);
        assert_eq!(snapshot.session_count, 4);
        assert_eq!(
            snapshot.by_model,
            BTreeMap::from([("claude-y".to_owned(), 1), ("gpt-x".to_owned(), 3)])
        );
        // A legacy token sign-in has no user id: only member-less calls count.
        let legacy = aggregate_usage(day("2026-10-18"), &events, None, 0);
        assert_eq!(legacy.request_count, 3);
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::json!({
                "day": "2026-10-18",
                "inputTokens": 107,
                "outputTokens": 13,
                "requestCount": 3,
                "sessionCount": 0,
                "byModel": { "claude-y": 1, "gpt-x": 2 },
            })
        );
    }

    #[test]
    fn usage_by_model_is_capped_and_mongo_safe() {
        let mut events: Vec<GatewayUsageEvent> = (0..60)
            .map(|index| event(&format!("model-{index:02}"), None, 1, 1, index + 1))
            .collect();
        events.push(event("$where", None, 1, 1, 500));
        events.push(event(&"m".repeat(MAX_MODEL_KEY_UNITS + 1), None, 1, 1, 500));
        // 129 chars but 258 UTF-16 units: over the control plane's limit.
        events.push(event(&"\u{1F600}".repeat(129), None, 1, 1, 500));
        let snapshot = aggregate_usage(day("2026-10-18"), &events, None, 0);
        assert_eq!(snapshot.by_model.len(), MAX_BY_MODEL);
        // The busiest models are kept.
        assert_eq!(snapshot.by_model.get("model-59"), Some(&60));
        assert!(!snapshot.by_model.contains_key("model-00"));
        assert!(!snapshot.by_model.contains_key("$where"));
        // Their calls still count toward the totals.
        assert_eq!(snapshot.request_count, (1..=60).sum::<u64>() + 1500);
        // An empty snapshot omits byModel.
        let empty = aggregate_usage(day("2026-10-18"), &[], None, 0);
        assert!(empty.is_empty());
        assert!(serde_json::to_value(&empty)
            .unwrap()
            .get("byModel")
            .is_none());
    }

    #[test]
    fn usage_needs_an_account_stable_since_the_day_began_or_core_started() {
        let today = day("2026-10-18");
        let yesterday = day("2026-10-17");
        // Core started today and the account never switched.
        let started = at("2026-10-18T08:00:00Z");
        assert!(usage_day_eligible(today, started, started));
        // Core was not running yesterday: nothing to vouch for.
        assert!(!usage_day_eligible(yesterday, started, started));
        // A switch today bars today, but not tomorrow.
        assert!(!usage_day_eligible(
            today,
            at("2026-10-18T09:00:00Z"),
            started
        ));
        assert!(usage_day_eligible(
            day("2026-10-19"),
            at("2026-10-18T09:00:00Z"),
            started
        ));
        // Core running since before yesterday with no switch covers both days.
        let long_ago = at("2026-10-16T12:00:00Z");
        assert!(usage_day_eligible(yesterday, long_ago, long_ago));
        assert!(usage_day_eligible(today, long_ago, long_ago));
        // A switch during yesterday bars yesterday's final snapshot.
        assert!(!usage_day_eligible(
            yesterday,
            at("2026-10-17T15:00:00Z"),
            long_ago
        ));

        let mut watch = AccountWatch::default();
        watch.observe(Some("a"), 0, started);
        assert!(watch.usage_eligible(today));
        watch.observe(Some("b"), 0, at("2026-10-18T10:00:00Z"));
        assert!(!watch.usage_eligible(today));
        watch.observe(Some("b"), 0, at("2026-10-18T11:00:00Z"));
        assert!(!watch.usage_eligible(today));
        assert!(watch.usage_eligible(day("2026-10-19")));
    }

    #[test]
    fn usage_rides_only_on_a_qualifying_day_from_a_local_gateway() {
        assert_eq!(plan_usage(usage_inputs(&[], &[])), UsagePlan::Today);
        assert_eq!(
            plan_usage(UsagePlanInputs {
                local_gateway: false,
                ..usage_inputs(&[], &[])
            }),
            UsagePlan::Skip
        );
        assert_eq!(
            plan_usage(UsagePlanInputs {
                today_qualifies: false,
                ..usage_inputs(&[], &[])
            }),
            UsagePlan::Skip
        );
        assert_eq!(
            plan_usage(UsagePlanInputs {
                today_check_due: false,
                ..usage_inputs(&[], &[])
            }),
            UsagePlan::Skip
        );
        assert_eq!(
            plan_usage(UsagePlanInputs {
                eligible_today: false,
                ..usage_inputs(&[], &[])
            }),
            UsagePlan::Skip
        );
        let now = Instant::now();
        assert!(usage_check_due(None, now));
        assert!(!usage_check_due(Some(now), now + Duration::from_secs(60)));
        assert!(usage_check_due(Some(now), now + USAGE_INTERVAL));
    }

    #[test]
    fn yesterdays_final_snapshot_goes_first_and_once() {
        let today = day("2026-10-18");
        let yesterday = day("2026-10-17");
        let partial = aggregate_usage(yesterday, &[event("m", None, 1, 1, 1)], None, 0);
        let sent = vec![("a".to_owned(), partial.clone())];
        let eligible = |sent, settled| UsagePlanInputs {
            eligible_yesterday: true,
            ..usage_inputs(sent, settled)
        };
        assert_eq!(plan_usage(eligible(&sent, &[])), UsagePlan::YesterdayFinal);
        // Without a snapshot accepted while yesterday was today, there is no
        // final one: it would make yesterday an active day on its own.
        assert_eq!(plan_usage(eligible(&[], &[])), UsagePlan::Today);
        let other_sent = vec![("b".to_owned(), partial.clone())];
        assert_eq!(plan_usage(eligible(&other_sent, &[])), UsagePlan::Today);
        let settled = vec![("a".to_owned(), yesterday)];
        assert_eq!(plan_usage(eligible(&sent, &settled)), UsagePlan::Today);
        // Settled for another account, or for an older day, does not count.
        let other = vec![("b".to_owned(), yesterday)];
        assert_eq!(
            plan_usage(eligible(&sent, &other)),
            UsagePlan::YesterdayFinal
        );
        let older = vec![("a".to_owned(), day("2026-10-16"))];
        assert_eq!(
            plan_usage(eligible(&sent, &older)),
            UsagePlan::YesterdayFinal
        );

        // Accepting yesterday's snapshot settles it.
        let mut state = UsageState::default();
        state.accepted("a", partial, today);
        assert_eq!(state.settled, settled);
    }

    #[test]
    fn a_rejected_snapshot_is_not_resent_for_that_day() {
        let today = day("2026-10-18");
        let mut state = UsageState::default();
        state.settle("a", today, today);
        assert_eq!(
            plan_usage(usage_inputs(&state.sent, &state.settled)),
            UsagePlan::Skip
        );
        // Settling again does not duplicate, and older days are pruned.
        state.settle("a", today, today);
        state.settle("a", day("2026-10-15"), today);
        state.settle("a", day("2026-10-19"), day("2026-10-19"));
        assert_eq!(
            state.settled,
            vec![("a".to_owned(), today), ("a".to_owned(), day("2026-10-19"))]
        );
    }

    #[test]
    fn errored_and_denied_calls_add_tokens_but_not_requests() {
        let mut failed = event("gpt-x", None, 40, 0, 3);
        failed.error_count = 2;
        let mut denied = event("blocked", None, 0, 0, 1);
        denied.error_count = 1;
        let snapshot = aggregate_usage(day("2026-10-18"), &[failed, denied], None, 0);
        assert_eq!(snapshot.input_tokens, 40);
        assert_eq!(snapshot.request_count, 1);
        assert_eq!(snapshot.by_model, BTreeMap::from([("gpt-x".to_owned(), 1)]));
        let rollup: GatewayUsageRollup = serde_json::from_value(serde_json::json!({
            "events": [{ "model": "m", "requestCount": 4, "errorCount": 1 }]
        }))
        .unwrap();
        assert_eq!(rollup.events[0].error_count, 1);
    }

    #[test]
    fn a_restart_resumes_only_the_same_account_and_reads_from_its_sign_in() {
        let today = day("2026-10-18");
        let restart = at("2026-10-18T12:00:00Z");
        // The same account since before today: the whole day is readable.
        let mut watch = AccountWatch {
            carried: Some((Some("a".to_owned()), at("2026-10-16T09:00:00Z"))),
            ..AccountWatch::default()
        };
        watch.observe(Some("a"), 0, restart);
        assert!(watch.resumed);
        assert!(watch.usage_eligible(today));
        assert_eq!(
            watch.usage_window_start(today),
            Some(at("2026-10-18T00:00:00Z"))
        );
        // A different account was signed in before the restart: only usage
        // since the restart is read, so the earlier account's is never credited.
        let mut switched = AccountWatch {
            carried: Some((Some("a".to_owned()), at("2026-10-16T09:00:00Z"))),
            ..AccountWatch::default()
        };
        switched.observe(Some("b"), 0, restart);
        assert!(!switched.resumed);
        assert_eq!(switched.usage_window_start(today), Some(restart));
        // Signed out before the restart counts the same way.
        let mut signed_out = AccountWatch {
            carried: Some((None, at("2026-10-16T09:00:00Z"))),
            ..AccountWatch::default()
        };
        signed_out.observe(Some("a"), 0, restart);
        assert_eq!(signed_out.usage_window_start(today), Some(restart));
        // Nothing carried (first run): from the restart.
        let mut fresh = AccountWatch::default();
        fresh.observe(Some("a"), 0, restart);
        assert_eq!(fresh.usage_window_start(today), Some(restart));
    }

    #[test]
    fn carried_sessions_survive_a_restart() {
        let today = day("2026-10-18");
        let mut before = ActivityLog::default();
        before.record(day("2026-10-17"), None, Some("old"));
        for conversation in ["c1", "c2", "c3"] {
            before.record(today, None, Some(conversation));
        }
        assert_eq!(before.sessions.len(), 2);
        let carry = UsageCarry {
            account: Some("a".to_owned()),
            since: Some(at("2026-10-16T09:00:00Z")),
            sessions: before.sessions.clone(),
        };
        let json = serde_json::to_vec(&carry).unwrap();
        let carry: UsageCarry = serde_json::from_slice(&json).unwrap();

        let mut after = ActivityLog::default();
        after.record(today, None, Some("c3"));
        after.record(today, None, Some("c4"));
        after.restore_sessions(carry.sessions, today);
        // The union, not just the conversations since the restart.
        assert_eq!(after.sessions_on(today, None), 4);
        // Days older than yesterday are dropped.
        let mut stale = ActivityLog::default();
        stale.restore_sessions(before.sessions, day("2026-10-20"));
        assert!(stale.sessions.is_empty());
    }

    #[test]
    fn snapshots_are_resent_only_when_they_change() {
        let today = day("2026-10-18");
        let first = aggregate_usage(today, &[event("m", None, 1, 1, 1)], None, 1);
        let mut state = UsageState::default();
        assert!(snapshot_changed(&state.sent, "a", &first));
        state.accepted("a", first.clone(), today);
        assert!(!snapshot_changed(&state.sent, "a", &first));
        // Another account has not received it.
        assert!(snapshot_changed(&state.sent, "b", &first));
        let grown = aggregate_usage(today, &[event("m", None, 2, 1, 2)], None, 1);
        assert!(snapshot_changed(&state.sent, "a", &grown));
        state.accepted("a", grown.clone(), today);
        assert_eq!(state.sent.len(), 1);
        // An empty day is never sent.
        let empty = aggregate_usage(today, &[], None, 0);
        assert!(!snapshot_changed(&[], "a", &empty));
        // Snapshots older than yesterday are pruned.
        state.accepted("a", grown, day("2026-10-20"));
        assert_eq!(state.sent.len(), 1);
    }

    #[test]
    fn body_carries_device_usage_only_with_a_device_id() {
        let usage = aggregate_usage(day("2026-10-18"), &[event("m", None, 3, 2, 1)], None, 1);
        assert_eq!(
            activity_body(None, None),
            serde_json::json!({ "source": "core" })
        );
        assert_eq!(
            activity_body(None, Some(&usage)),
            serde_json::json!({ "source": "core" })
        );
        let body = activity_body(Some("0f8b2c6e-1d2a-4b7e-9c3d-5e6f7a8b9c0d"), Some(&usage));
        assert_eq!(body["deviceId"], "0f8b2c6e-1d2a-4b7e-9c3d-5e6f7a8b9c0d");
        assert_eq!(body["usage"]["requestCount"], 1);
        assert_eq!(body["usage"]["day"], "2026-10-18");
    }

    #[test]
    fn device_ids_match_the_control_plane_contract() {
        assert!(valid_device_id(&uuid::Uuid::new_v4().to_string()));
        assert!(!valid_device_id("short"));
        assert!(!valid_device_id(&"a".repeat(65)));
        assert!(!valid_device_id("not a valid id!"));
    }

    #[test]
    fn a_reporting_gateway_config_never_gets_a_snapshot() {
        assert!(!gateway_config_reports_usage(None));
        assert!(!gateway_config_reports_usage(Some(
            "[server]\nport = 7981\n"
        )));
        assert!(!gateway_config_reports_usage(Some(
            "[control_plane]\nenabled = false\n"
        )));
        assert!(gateway_config_reports_usage(Some(
            "[control_plane]\nenabled = true\ngateway_key = \"gw\"\n"
        )));
        // Unparsable config is treated as reporting.
        assert!(gateway_config_reports_usage(Some("not = [valid")));
    }
}

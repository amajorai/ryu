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
//! - *Only to the account backend*: the control plane is an explicit
//!   `RYU_CONTROL_PLANE_URL`, then `RYU_SERVER_URL`, then the backend the last
//!   device sign-in succeeded against (https only). With none of them nothing is
//!   sent, and the reason is logged once; there is no default address.
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

mod account_watch;
mod activity_log;
mod attribution;
mod posting;
mod usage;

use account_watch::*;
pub(crate) use activity_log::*;
pub(crate) use attribution::*;
pub use posting::*;
pub(crate) use usage::*;

#[cfg(test)]
mod tests;

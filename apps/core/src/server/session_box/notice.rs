//! The one-time computer-use cost notice (design §18 decision 5, 2026-10-20:
//! the computer target defaults to `auto`).
//!
//! With `auto`, a conversation's first `computer.*` or `browser.*` call, or a
//! sub-agent's first heavy call, starts a paid session Box of its own. The
//! first time for each owner, once admission (the plan cap and the credit
//! pre-flight) has passed, Core holds that call and shows the notice: the
//! conversation's status carries `costNotice` with the Box's size, the
//! Gateway's live hourly rate and the per-start minimum, and `waiting` while a
//! call is held. The desktop and web session UIs show it. When the owner
//! allows it (`POST …/cost-notice`, echoing the rate it was shown) the held
//! call goes on and starts the Box, so the turn continues without a new
//! message. A call nobody answers within [`WAIT_FOR_ACKNOWLEDGEMENT`] is
//! refused with `428 session_box_cost_notice_required`, whose message tells the
//! model to ask the owner.
//!
//! A run nobody watches (a routine or a channel bot on a conversation) can
//! never answer in time, so the owner can also acknowledge ahead of any
//! conversation (`GET`/`POST /api/session-boxes/cost-notice`, the desktop's
//! Settings > Computer use). The acknowledgement is stored per owner under
//! `state/session-box-cost-notice.json`; every later Box of that owner starts
//! without asking. A parked Box resumes without asking: it was created after
//! an acknowledgement or before this notice existed.
use super::{api_error, caps, unix_now, ApiError, SessionBoxKey};
use axum::{http::StatusCode, Json};
use ryu_sandbox::box_types::BoxSize;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

/// The refusal code the session UIs turn into the notice.
pub(crate) const NOTICE_REQUIRED_CODE: &str = "session_box_cost_notice_required";
const STORE_FILE: &str = "session-box-cost-notice.json";
const STORE_FILE_LIMIT: u64 = 4 * 1024 * 1024;
/// Most owners the store keeps; the oldest acknowledgement goes first.
const MAX_OWNERS: usize = 20_000;
/// How long a refused conversation keeps showing the notice.
const PENDING_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_PENDING: usize = 4096;
/// How long a session Box call waits for the owner to allow the cost before
/// it is refused. The desktop and web UIs poll the status at most every 10 s
/// while nothing runs, so the notice is on screen for most of this window;
/// it stays under the 120 s an MCP client commonly allows a tool call.
pub(crate) const WAIT_FOR_ACKNOWLEDGEMENT: Duration = Duration::from_secs(90);
/// The per-start minimum the notice names, in seconds: the shared fixture's
/// `minimumSecondsPerStart`, which the credit pre-flight also covers.
pub(crate) const MINIMUM_SECONDS_PER_START: u64 = super::PREFLIGHT_SECONDS;

/// One owner's acknowledgement of the computer-use Box cost.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Acknowledgement {
    /// Unix seconds.
    pub acknowledged_at: u64,
    /// The hourly rate the owner was shown, micro-USD.
    pub rate_per_hour_micro_usd: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreFile {
    schema_version: u32,
    owners: BTreeMap<String, Acknowledgement>,
}

/// The notice a conversation's status carries while a Box waits for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[schema(as = SessionBoxCostNotice)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostNotice {
    /// Always true: a Box of this conversation waits for the acknowledgement.
    pub required: bool,
    /// The size of the Box that would start: `small`, `default` or `large`.
    pub size: String,
    /// The Gateway's live hourly rate for that size, micro-USD; null when the
    /// Gateway could not name it.
    pub rate_per_hour_micro_usd: Option<u64>,
    /// Each start (and each resume of a parked Box) is billed at least this
    /// many seconds; after it, whole minutes.
    pub minimum_seconds_per_start: u64,
    /// A computer-use or sub-agent call is held for the answer: allowing it
    /// starts the Box and the turn continues. False once that call has given
    /// up; the agent then needs a new message.
    pub waiting: bool,
}

/// `GET /api/session-boxes/cost-notice`: the caller's own acknowledgement
/// state, for a settings screen that allows the cost ahead of any
/// conversation (a routine's or channel bot's run has nobody to ask).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[schema(as = SessionBoxCostNoticeState)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerNotice {
    /// The caller has allowed the session Box cost.
    pub acknowledged: bool,
    /// RFC 3339; set when acknowledged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acknowledged_at: Option<String>,
    /// The size a computer-use session Box starts at.
    pub size: String,
    /// The Gateway's live hourly rate for that size, micro-USD; null when the
    /// Gateway could not name it.
    pub rate_per_hour_micro_usd: Option<u64>,
    /// The per-start minimum, in seconds.
    pub minimum_seconds_per_start: u64,
}

struct Pending {
    size: BoxSize,
    rate: Option<u64>,
    at: Instant,
    /// Calls currently held for the answer.
    waiting: usize,
}

/// Wakes every held call when any owner acknowledges.
fn acknowledged_signal() -> &'static Notify {
    static SIGNAL: OnceLock<Notify> = OnceLock::new();
    SIGNAL.get_or_init(Notify::new)
}

fn store_path() -> std::path::PathBuf {
    crate::paths::state_path(STORE_FILE)
}

/// The acknowledgements, loaded once per process and written through.
fn store() -> MutexGuard<'static, Option<StoreFile>> {
    static STORE: OnceLock<Mutex<Option<StoreFile>>> = OnceLock::new();
    STORE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn load() -> StoreFile {
    let path = store_path();
    let readable = std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.is_file() && meta.len() <= STORE_FILE_LIMIT);
    if !readable {
        return StoreFile::default();
    }
    match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoreFile>(&bytes).ok())
    {
        Some(file) if file.schema_version == 1 => file,
        _ => {
            tracing::warn!(
                "The computer-use cost notice store is unreadable; owners are asked again"
            );
            StoreFile::default()
        }
    }
}

fn save(file: &StoreFile) -> anyhow::Result<()> {
    use std::io::Write;
    let path = store_path();
    let directory = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("the state directory is missing"))?;
    std::fs::create_dir_all(directory)?;
    let mut temp = tempfile::NamedTempFile::new_in(directory)?;
    temp.write_all(&serde_json::to_vec(file)?)?;
    temp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temp.persist(&path)
        .map_err(|_| anyhow::anyhow!("the cost notice store could not be written"))?;
    Ok(())
}

/// `owner`'s acknowledgement, if it gave one.
pub(crate) fn acknowledgement(owner: &str) -> Option<Acknowledgement> {
    let mut guard = store();
    guard.get_or_insert_with(load).owners.get(owner).copied()
}

fn record(owner: &str, acknowledgement: Acknowledgement) -> Result<(), ApiError> {
    let mut guard = store();
    let file = guard.get_or_insert_with(load);
    let previous = file.owners.insert(owner.to_owned(), acknowledgement);
    while file.owners.len() > MAX_OWNERS {
        let Some(oldest) = file
            .owners
            .iter()
            .min_by_key(|(_, ack)| ack.acknowledged_at)
            .map(|(owner, _)| owner.clone())
        else {
            break;
        };
        file.owners.remove(&oldest);
    }
    file.schema_version = 1;
    if let Err(error) = save(file) {
        tracing::warn!(%error, "The computer-use cost notice could not be stored");
        match previous {
            Some(previous) => file.owners.insert(owner.to_owned(), previous),
            None => file.owners.remove(owner),
        };
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session_box_unavailable",
            "The acknowledgement could not be saved. Try again.",
        ));
    }
    Ok(())
}

fn pending() -> MutexGuard<'static, HashMap<(String, String), Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<(String, String), Pending>>> = OnceLock::new();
    PENDING
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn remember_pending(key: &SessionBoxKey, size: BoxSize, rate: Option<u64>) {
    let mut table = pending();
    table.retain(|_, entry| entry.at.elapsed() < PENDING_TTL);
    while table.len() >= MAX_PENDING {
        let Some(oldest) = table
            .iter()
            .min_by_key(|(_, entry)| entry.at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        table.remove(&oldest);
    }
    let id = (key.owner.clone(), key.conversation_id.clone());
    let waiting = table.get(&id).map_or(0, |entry| entry.waiting);
    table.insert(
        id,
        Pending {
            size,
            rate,
            at: Instant::now(),
            waiting,
        },
    );
}

/// Counts one held call on a conversation's pending notice while it lives.
struct Held {
    id: (String, String),
}

impl Held {
    fn new(key: &SessionBoxKey) -> Self {
        let id = (key.owner.clone(), key.conversation_id.clone());
        if let Some(entry) = pending().get_mut(&id) {
            entry.waiting += 1;
        }
        Self { id }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(entry) = pending().get_mut(&self.id) {
            entry.waiting = entry.waiting.saturating_sub(1);
        }
    }
}

/// The notice `conversation_id`'s status shows for `owner`: a Box of it was
/// refused for want of the acknowledgement, and none has been given since.
pub(crate) fn pending_notice(owner: &str, conversation_id: &str) -> Option<CostNotice> {
    if acknowledgement(owner).is_some() {
        return None;
    }
    let table = pending();
    let entry = table.get(&(owner.to_owned(), conversation_id.to_owned()))?;
    (entry.at.elapsed() < PENDING_TTL).then(|| CostNotice {
        required: true,
        size: entry.size.as_str().to_owned(),
        rate_per_hour_micro_usd: entry.rate,
        minimum_seconds_per_start: MINIMUM_SECONDS_PER_START,
        waiting: entry.waiting > 0,
    })
}

/// `owner`'s acknowledgement state with the live rate it would be asked for.
pub(crate) async fn owner_notice(owner: &str) -> OwnerNotice {
    let size = BoxSize::default();
    let acknowledged = acknowledgement(owner);
    OwnerNotice {
        acknowledged: acknowledged.is_some(),
        acknowledged_at: acknowledged.and_then(|ack| super::rfc3339(ack.acknowledged_at)),
        size: size.as_str().to_owned(),
        rate_per_hour_micro_usd: caps::hourly_rate(size).await,
        minimum_seconds_per_start: MINIMUM_SECONDS_PER_START,
    }
}

/// `5-minute`, `90-second`: a duration as a compound adjective.
fn duration_words(seconds: u64) -> String {
    match (seconds / 60, seconds % 60) {
        (minutes, 0) if minutes > 0 => format!("{minutes}-minute"),
        _ => format!("{seconds}-second"),
    }
}

/// `$0.025`, `$0.04`, `$1.50`: micro-USD as dollars, with at least cents.
pub(crate) fn dollars(micro_usd: u64) -> String {
    let whole = micro_usd / 1_000_000;
    let fraction = format!("{:06}", micro_usd % 1_000_000);
    let trimmed = fraction.trim_end_matches('0');
    let fraction = if trimmed.len() < 2 {
        &fraction[..2]
    } else {
        trimmed
    };
    format!("${whole}.{fraction}")
}

fn required_error(size: BoxSize, rate: Option<u64>) -> ApiError {
    let cost = rate.map_or_else(
        || "which is billed by the hour while it runs".to_owned(),
        |rate| format!("which costs {} an hour while it runs", dollars(rate)),
    );
    let message = format!(
        "Computer use runs on a cloud Box of its own ({} size), {cost}, in whole minutes with a {} minimum each time it starts (a resume within the hour already paid owes no new one). The owner has not allowed that cost yet: they allow it once, in the notice shown in this conversation or in Settings > Computer use. Ask them to allow it, then try again.",
        size.as_str(),
        duration_words(MINIMUM_SECONDS_PER_START)
    );
    (
        StatusCode::PRECONDITION_REQUIRED,
        Json(json!({"error":{
            "code": NOTICE_REQUIRED_CODE,
            "message": message,
            "size": size.as_str(),
            "ratePerHourMicroUsd": rate,
            "minimumSecondsPerStart": MINIMUM_SECONDS_PER_START,
        }})),
    )
}

#[cfg(test)]
fn bypassed() -> bool {
    super::tests::test_notice_bypass()
}

#[cfg(not(test))]
fn bypassed() -> bool {
    false
}

#[cfg(test)]
fn wait_budget() -> Duration {
    super::tests::test_notice_wait().unwrap_or(Duration::ZERO)
}

#[cfg(not(test))]
fn wait_budget() -> Duration {
    WAIT_FOR_ACKNOWLEDGEMENT
}

/// Whether `owner` may start a session Box without the notice.
pub(crate) fn acknowledged(owner: &str) -> bool {
    bypassed() || acknowledgement(owner).is_some()
}

/// Hold the first session Box call of `key.owner` until the owner has
/// acknowledged the hourly cost: the conversation's status shows the notice
/// (size, the Gateway's live rate, the per-start minimum, `waiting`) while the
/// call waits up to [`WAIT_FOR_ACKNOWLEDGEMENT`]. `Ok` once allowed, so the
/// caller goes on to start the Box; otherwise `428` naming the size and rate.
/// The caller has already admitted the Box (plan cap, credits), so nobody is
/// asked about a cost and then refused anyway.
pub(crate) async fn wait_for_acknowledgement(
    key: &SessionBoxKey,
    size: BoxSize,
) -> Result<(), ApiError> {
    if acknowledged(&key.owner) {
        return Ok(());
    }
    let rate = caps::hourly_rate(size).await;
    remember_pending(key, size, rate);
    let _held = Held::new(key);
    let deadline = tokio::time::Instant::now() + wait_budget();
    loop {
        let notified = acknowledged_signal().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if acknowledged(&key.owner) {
            return Ok(());
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            break;
        }
    }
    if acknowledged(&key.owner) {
        return Ok(());
    }
    Err(required_error(size, rate))
}

/// Record `owner`'s acknowledgement of the rate it was shown. The rate must
/// still be the Gateway's live rate for a session Box: a stale one answers
/// `409 session_box_rate_changed` with the current rate, so the notice is
/// shown again before anything starts.
pub(crate) async fn acknowledge(owner: &str, shown_rate: u64) -> Result<Acknowledgement, ApiError> {
    let size = BoxSize::default();
    let Some(rate) = caps::hourly_rate(size).await else {
        return Err(caps::rate_unavailable());
    };
    if rate != shown_rate {
        // The notice the conversation shows moves to the current rate.
        for ((pending_owner, _), entry) in pending().iter_mut() {
            if pending_owner == owner {
                entry.rate = Some(rate);
            }
        }
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":{
                "code": "session_box_rate_changed",
                "message": format!(
                    "The Box rate is now {} an hour. Review the new rate and confirm again.",
                    dollars(rate)
                ),
                "size": size.as_str(),
                "ratePerHourMicroUsd": rate,
            }})),
        ));
    }
    let acknowledgement = Acknowledgement {
        acknowledged_at: unix_now(),
        rate_per_hour_micro_usd: rate,
    };
    record(owner, acknowledgement)?;
    pending().retain(|(pending_owner, _), _| pending_owner != owner);
    acknowledged_signal().notify_waiters();
    Ok(acknowledgement)
}

/// Forget the loaded store and every pending notice (tests remove the file
/// between cases and reload it to prove persistence).
#[cfg(test)]
pub(super) fn reset_for_test(remove_file: bool) {
    *store() = None;
    pending().clear();
    if remove_file {
        let _ = std::fs::remove_file(store_path());
    }
}

//! One Box per session, each with its own screen (design
//! `docs/box-per-session-desktop.md` §7).
//!
//! The registry is keyed by [`SessionBoxKey`]: `(owner, conversation_id)` for a
//! conversation, or `(owner, "<conversation_id>#sub:<n>")` for a parallel
//! sub-agent child. The child number comes from a Core counter
//! ([`next_child_index`]); a model argument never sets it.
//!
//! Heavy work acquires a Box ([`desktop_target`]): a cloud task already bound
//! to the conversation is attached to (never a second create), and otherwise a
//! session Box is created with its own desktop. The idle sweep, exhaustion
//! (`kill_balance`), the lifetime and an explicit Stop **park** it (state is
//! saved, compute released); the next heavy call resumes it. Deleting the
//! conversation deletes the parent and every child Box.
//!
//! Session Boxes never change `cloud_tasks::has_bound_task`: only a cloud task
//! flips a conversation into "cloud tools only".
//!
//! Every Box call uses the node's Box credential
//! ([`ryu_sandbox::box_credential::current`]); that bearer never leaves Core.
//! A lease file under `state/session-box-leases` is written before every
//! create, so a crash between the lease and the create is still recoverable by
//! the Box's deterministic name.
#[path = "session_box/api.rs"]
mod api;
#[path = "session_box/caps.rs"]
mod caps;
#[path = "session_box/idle.rs"]
mod idle;
#[path = "session_box/inference.rs"]
mod inference;
#[path = "session_box/notice.rs"]
pub(crate) mod notice;
#[path = "session_box/relay.rs"]
mod relay;
#[cfg(test)]
#[path = "session_box/tests.rs"]
pub(crate) mod tests;

pub(crate) use caps::BoxCaps;

use super::{cloud_environments as environments, cloud_tasks, ResolvedAuthorization};
use anyhow::{anyhow, ensure, Result};
use axum::{http::StatusCode, Json};
use ryu_sandbox::{
    box_credential::{BillingOwner, BoxCredential},
    box_session::{BoxNetwork, BoxSessionClient, DisposableBoxSpec},
    box_types::{BoxApiError, BoxSize, BoxStatus, BoxView, ParkReason},
    heartbeat::{self, KillAction, KillReason, ParkFn, RunOptions},
    spec::SandboxSpec,
    WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub(crate) type ApiError = (StatusCode, Json<Value>);

/// The Box service's own time to live for a session Box (its maximum,
/// `MAX_BOX_TTL_SECONDS`). A parked Box older than this is reaped by the
/// service; Core forgets its lease then.
const BOX_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
/// How long a session Box may run before it is parked (design §7.3). The UI
/// can extend it.
const RUN_LIFETIME_SECONDS: u64 = 4 * 60 * 60;
/// Longest a single extension may push the run deadline ahead of now.
const MAX_RUN_AHEAD_SECONDS: u64 = 24 * 60 * 60;
/// The per-start credit pre-flight horizon (design §7.3): the five-minute
/// minimum every Box start is billed for (`minimumSecondsPerStart` in the
/// shared fixture `crates/gateway/contracts/fixtures/box-rates.json`, which the
/// Gateway's ticks charge on a run's first tick).
const PREFLIGHT_SECONDS: u64 = 300;
/// Most sub-agent children per conversation.
const MAX_CHILDREN: u32 = 64;
/// How long a fetched Box view is reused for status reads.
const VIEW_CACHE_TTL: Duration = Duration::from_secs(5);
const LEASE_FILE_LIMIT: u64 = 16 * 1024;
const MAX_LEASES: usize = 1000;
const NAME_PREFIX: &str = "ryu-sb-";
/// The owner preference that sends `computer.*` and `browser.*` to the node
/// (`node`) instead of a session Box (`auto`, the default).
pub(crate) const PREF_COMPUTER_TARGET: &str = "session-box-computer-target";

/// Who and what a session Box belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct SessionBoxKey {
    pub owner: String,
    pub conversation_id: String,
    /// `Some(n)` for the `n`th sub-agent child of the conversation.
    pub child: Option<u32>,
}

impl SessionBoxKey {
    pub(crate) fn session(owner: &str, conversation_id: &str) -> Self {
        Self {
            owner: owner.to_owned(),
            conversation_id: conversation_id.to_owned(),
            child: None,
        }
    }

    pub(crate) fn child(owner: &str, conversation_id: &str, index: u32) -> Self {
        Self {
            child: Some(index),
            ..Self::session(owner, conversation_id)
        }
    }

    /// The conversation's own key.
    pub(crate) fn parent(&self) -> Self {
        Self::session(&self.owner, &self.conversation_id)
    }

    /// `conversation_id`, or `conversation_id#sub:n` for a child. Used as the
    /// Box inference session id and in routes.
    pub(crate) fn session_id(&self) -> String {
        match self.child {
            Some(index) => format!("{}#sub:{index}", self.conversation_id),
            None => self.conversation_id.clone(),
        }
    }

    /// Parse a route segment (`conversation_id` or `conversation_id#sub:n`).
    pub(crate) fn parse(owner: &str, segment: &str) -> Option<Self> {
        let (conversation, child) = match segment.split_once("#sub:") {
            Some((conversation, raw)) => {
                let index: u32 = raw.parse().ok()?;
                if index == 0 || index > MAX_CHILDREN || raw != index.to_string() {
                    return None;
                }
                (conversation, Some(index))
            }
            None => (segment, None),
        };
        if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation) {
            return None;
        }
        Some(Self {
            owner: owner.to_owned(),
            conversation_id: conversation.to_owned(),
            child,
        })
    }
}

/// Why a Box is being acquired (design §7.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcquireReason {
    /// The conversation's cloud task: attach to its Box, never create one.
    /// Cloud tasks create their own Box (`cloud_tasks::ensure_task_workspace`),
    /// so this reason only ever attaches.
    #[allow(dead_code)]
    CloudTask,
    /// The first `computer.*` or `browser.*` call in the conversation.
    ComputerUse,
    /// The first heavy call of a `delegate.fanout` or `threads.*` child.
    SubAgent,
}

/// Where a [`BoxTarget`] came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TargetSource {
    CloudTask,
    Session,
    SubAgent,
}

impl TargetSource {
    fn label(self) -> &'static str {
        match self {
            Self::CloudTask => "cloud_task",
            Self::Session => "session",
            Self::SubAgent => "sub_agent",
        }
    }
}

/// The Box a conversation's heavy work runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BoxTarget {
    pub box_id: WorkspaceId,
    pub lease_id: String,
    /// The heartbeat run id of the Box's current run. A session Box gets a
    /// new one for every live phase ([`Entry::run_id`]); a cloud task Box
    /// uses its lease id.
    pub run_id: String,
    pub size: BoxSize,
    pub desktop: bool,
    pub source: TargetSource,
}

/// Lifecycle of one registry entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Created or resumed; compute is running.
    Live,
    /// Parked: state saved, compute released. The next heavy call resumes.
    Parked,
}

/// Billing attribution of a metered Box run.
pub(crate) struct BoxMetering {
    org_id: Option<String>,
    spec: SandboxSpec,
    budget_micro_usd: u64,
    started: Instant,
}

/// One session Box.
struct Entry {
    key: SessionBoxKey,
    lease_id: String,
    box_id: WorkspaceId,
    size: BoxSize,
    phase: Phase,
    /// Bumped on every create and resume; part of the Box's `gwb1` scope.
    lease_epoch: u64,
    last_activity: Instant,
    /// Unix seconds at which a live Box is parked for its lifetime.
    run_until: u64,
    /// Unix seconds at which the Box service reaps the Box.
    box_expires_at: u64,
    metering: Option<BoxMetering>,
    /// Why the Box was last parked (`user`, `idle`, `ttl`, `balance`, …).
    stop_reason: Option<String>,
    /// The `gwb1` credential refresher; aborted when the Box parks.
    refresher: Option<tokio::task::JoinHandle<()>>,
}

impl Entry {
    /// The heartbeat run id of the current live phase: the lease id plus the
    /// lease epoch. Each create or resume is a new run, so a stale kill retry
    /// of an earlier phase never names it, and the Gateway's per-run tick
    /// watermark and ledger references start fresh.
    fn run_id(&self) -> String {
        run_id_for(&self.lease_id, self.lease_epoch)
    }

    fn target(&self) -> BoxTarget {
        BoxTarget {
            box_id: self.box_id.clone(),
            lease_id: self.lease_id.clone(),
            run_id: self.run_id(),
            size: self.size,
            desktop: true,
            source: if self.key.child.is_some() {
                TargetSource::SubAgent
            } else {
                TargetSource::Session
            },
        }
    }

    fn stop_refresher(&mut self) {
        if let Some(handle) = self.refresher.take() {
            handle.abort();
        }
    }
}

fn run_id_for(lease_id: &str, lease_epoch: u64) -> String {
    format!("{lease_id}-e{lease_epoch}")
}

type Slot = Arc<Mutex<Option<Entry>>>;

fn registry() -> &'static StdMutex<HashMap<SessionBoxKey, Slot>> {
    static REGISTRY: OnceLock<StdMutex<HashMap<SessionBoxKey, Slot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<SessionBoxKey, Slot>> {
    registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The slot for `key`, created empty when missing.
fn slot_for(key: &SessionBoxKey) -> Slot {
    lock_registry()
        .entry(key.clone())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

fn existing_slot(key: &SessionBoxKey) -> Option<Slot> {
    lock_registry().get(key).cloned()
}

/// Every registered key of one conversation, parent first, any owner.
fn conversation_keys(conversation_id: &str) -> Vec<SessionBoxKey> {
    let mut keys: Vec<SessionBoxKey> = lock_registry()
        .keys()
        .filter(|key| key.conversation_id == conversation_id)
        .cloned()
        .collect();
    keys.sort();
    keys
}

/// Children that share their parent's Box because the cap refused their own.
fn shared_children() -> &'static StdMutex<HashSet<SessionBoxKey>> {
    static SHARED: OnceLock<StdMutex<HashSet<SessionBoxKey>>> = OnceLock::new();
    SHARED.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn lock_shared() -> std::sync::MutexGuard<'static, HashSet<SessionBoxKey>> {
    shared_children()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The sub-agent child numbers in use, per `(owner, conversation)`.
fn child_counters() -> &'static StdMutex<HashMap<(String, String), std::collections::BTreeSet<u32>>>
{
    static COUNTERS: OnceLock<
        StdMutex<HashMap<(String, String), std::collections::BTreeSet<u32>>>,
    > = OnceLock::new();
    COUNTERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn lock_child_counters(
) -> std::sync::MutexGuard<'static, HashMap<(String, String), std::collections::BTreeSet<u32>>> {
    child_counters()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Most deleted conversations remembered; a delete races only with turns
/// still running in it, so an old tombstone is never needed.
const MAX_TOMBSTONES: usize = 4096;

#[derive(Default)]
struct Tombstones {
    ids: HashSet<String>,
    order: std::collections::VecDeque<String>,
}

/// Conversations deleted in this process. No session Box is acquired for
/// one again (a turn still running after the delete must not recreate it).
fn tombstones() -> std::sync::MutexGuard<'static, Tombstones> {
    static TOMBSTONES: OnceLock<StdMutex<Tombstones>> = OnceLock::new();
    TOMBSTONES
        .get_or_init(|| StdMutex::new(Tombstones::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn tombstone(conversation_id: &str) {
    let mut tombstones = tombstones();
    if !tombstones.ids.insert(conversation_id.to_owned()) {
        return;
    }
    tombstones.order.push_back(conversation_id.to_owned());
    while tombstones.order.len() > MAX_TOMBSTONES {
        if let Some(oldest) = tombstones.order.pop_front() {
            tombstones.ids.remove(&oldest);
        }
    }
}

fn is_deleted(conversation_id: &str) -> bool {
    tombstones().ids.contains(conversation_id)
}

fn deleted_error() -> ApiError {
    api_error(
        StatusCode::GONE,
        "session_box_conversation_deleted",
        "This conversation was deleted; its session Box is gone.",
    )
}

/// Leases whose create is in flight in this process. Recovery leaves them
/// alone: their `boxId` is not recorded yet, but they are not leftovers.
fn creating_leases() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static CREATING: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    CREATING
        .get_or_init(|| StdMutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Marks a lease as being created until it is dropped.
struct CreatingLease(String);

impl CreatingLease {
    fn new(lease_id: &str) -> Self {
        creating_leases().insert(lease_id.to_owned());
        Self(lease_id.to_owned())
    }
}

impl Drop for CreatingLease {
    fn drop(&mut self) {
        creating_leases().remove(&self.0);
    }
}

/// Viewers Core relays itself (self-hosted), per Box id.
fn relay_viewers() -> &'static StdMutex<HashMap<String, u32>> {
    static VIEWERS: OnceLock<StdMutex<HashMap<String, u32>>> = OnceLock::new();
    VIEWERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn relay_viewer_count(box_id: &str) -> u32 {
    relay_viewers()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(box_id)
        .copied()
        .unwrap_or(0)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn rfc3339(seconds: u64) -> Option<String> {
    chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, 0)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

pub(crate) fn api_error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({"error":{"code":code,"message":message}})),
    )
}

fn not_found() -> ApiError {
    api_error(
        StatusCode::NOT_FOUND,
        "session_box_not_found",
        "This conversation has no session Box.",
    )
}

fn unavailable(message: &str) -> ApiError {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "session_box_unavailable",
        message,
    )
}

/// The typed refusal for a Box API failure. Capacity carries `retryAfter`
/// (seconds) in its body; the routes also send it as `Retry-After`.
pub(crate) fn box_api_error(error: &BoxApiError) -> ApiError {
    match error {
        BoxApiError::Capacity { retry_after } => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":{
                "code":"session_box_capacity",
                "message":"No Box capacity is available right now. Try again shortly.",
                "retryAfter": retry_after,
            }})),
        ),
        BoxApiError::Quota => api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "session_box_limit_reached",
            "Your plan's limit of running Boxes is reached. Stop another session's Box first.",
        ),
        BoxApiError::InsufficientCredits => api_error(
            StatusCode::PAYMENT_REQUIRED,
            "session_box_insufficient_credits",
            "There are not enough credits to run a Box. Top up to continue.",
        ),
        BoxApiError::NotFound => not_found(),
        BoxApiError::BillingOwnerMismatch | BoxApiError::Http { .. } => {
            unavailable("The Box service could not complete the request.")
        }
    }
}

// ── Box credential and client ────────────────────────────────────────────────

/// The Box credential Core calls the service with: the env configuration or
/// the installed control-plane source.
async fn box_credential() -> Result<BoxCredential> {
    #[cfg(test)]
    if let Some(credential) = tests::test_credential() {
        return Ok(credential);
    }
    ryu_sandbox::box_credential::current().await
}

/// A Box client for the node's current credential.
pub(crate) async fn box_client() -> Result<BoxSessionClient> {
    Ok(BoxSessionClient::from_credential(&box_credential().await?))
}

// ── Lease persistence ────────────────────────────────────────────────────────

/// A credential-free record of one session Box, written before its create.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionLease {
    schema_version: u8,
    id: String,
    owner: String,
    conversation_id: String,
    #[serde(default)]
    child: Option<u32>,
    #[serde(default)]
    box_id: Option<String>,
    size: BoxSize,
    #[serde(default)]
    parked: bool,
    /// The conversation was deleted; the Box is destroyed and the lease
    /// removed as soon as the Box service confirms.
    #[serde(default)]
    deleted: bool,
    box_expires_at: u64,
    /// The last lease epoch a `gwb1` key was signed for. Recovery continues
    /// above it, so a key signed before a restart never matches again.
    #[serde(default)]
    lease_epoch: u64,
}

impl SessionLease {
    fn key(&self) -> SessionBoxKey {
        SessionBoxKey {
            owner: self.owner.clone(),
            conversation_id: self.conversation_id.clone(),
            child: self.child,
        }
    }

    fn name(&self) -> String {
        box_name(&self.id)
    }
}

fn box_name(lease_id: &str) -> String {
    format!("{NAME_PREFIX}{lease_id}")
}

fn lease_directory() -> std::path::PathBuf {
    crate::paths::state_path("session-box-leases")
}

fn checked_lease_directory() -> Result<std::path::PathBuf> {
    let directory = lease_directory();
    std::fs::create_dir_all(&directory)?;
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Session Box lease directory must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory)
}

fn write_lease(lease: &SessionLease) -> Result<()> {
    use std::io::Write;
    let directory = checked_lease_directory()?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&serde_json::to_vec(lease)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(format!("{}.json", lease.id)))
        .map_err(|_| anyhow!("Session Box lease persistence failed"))?;
    Ok(())
}

fn remove_lease(lease_id: &str) -> Result<()> {
    match std::fs::remove_file(lease_directory().join(format!("{lease_id}.json"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn read_lease(path: &std::path::Path) -> Result<Option<SessionLease>> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Ok(None);
    }
    ensure!(
        meta.len() <= LEASE_FILE_LIMIT,
        "Session Box lease exceeded limit"
    );
    let lease: SessionLease = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        lease.schema_version == 1
            && uuid::Uuid::parse_str(&lease.id)?.to_string() == lease.id
            && path.file_name().and_then(|name| name.to_str())
                == Some(format!("{}.json", lease.id).as_str()),
        "Invalid session Box lease"
    );
    Ok(Some(lease))
}

/// Every readable lease; unreadable files are reported and skipped.
fn leases() -> Vec<SessionLease> {
    let Ok(entries) = std::fs::read_dir(lease_directory()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.take(MAX_LEASES).flatten() {
        match read_lease(&entry.path()) {
            Ok(Some(lease)) => found.push(lease),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(error = %error, "Session Box lease is unreadable; skipping it");
            }
        }
    }
    found
}

fn lease_of(entry: &Entry) -> SessionLease {
    SessionLease {
        schema_version: 1,
        id: entry.lease_id.clone(),
        owner: entry.key.owner.clone(),
        conversation_id: entry.key.conversation_id.clone(),
        child: entry.key.child,
        box_id: Some(entry.box_id.0.clone()),
        size: entry.size,
        parked: entry.phase == Phase::Parked,
        deleted: false,
        box_expires_at: entry.box_expires_at,
        lease_epoch: entry.lease_epoch,
    }
}

// ── Metering ─────────────────────────────────────────────────────────────────

/// Register heartbeat metering for a Box run unless another owner bills it.
///
/// - `settlement` and `subscription` credentials are never metered by Core
///   (one billing owner per tenant, design §8.3).
/// - The run ticks [`ryu_sandbox::box_types::spec_for`] of the Box's own size,
///   sends `size` and `box_id`, and parks (never destroys) on a kill verdict.
/// - A `core_tick` tenant renews the Box service's liveness lease after every
///   accepted tick.
/// - `minimum_waiver` is the Box service's signed verdict for this start
///   (`PublicBox.billing.waiver`): a resume onto the Box's own parked VM
///   inside the provider hour already paid for. The run's ticks forward it,
///   and the Gateway verifies it before charging no new five-minute minimum.
pub(crate) async fn start_metering(
    run_id: &str,
    box_id: &WorkspaceId,
    size: BoxSize,
    billing_owner: BillingOwner,
    on_kill: ParkFn,
    minimum_waiver: Option<String>,
) -> Option<BoxMetering> {
    if matches!(
        billing_owner,
        BillingOwner::Settlement | BillingOwner::Subscription
    ) || ryu_sandbox::box_backend::subscription_passthrough_active().await
    {
        return None;
    }
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let spec = ryu_sandbox::box_types::spec_for(size);
    let budget_micro_usd = heartbeat::default_run_budget_micro_usd().await;
    heartbeat::register_run(
        run_id.to_owned(),
        org_id.clone(),
        "box",
        box_id.clone(),
        spec.clone(),
        budget_micro_usd,
        RunOptions {
            kill_action: KillAction::Park(on_kill),
            size: Some(size),
            box_id: Some(box_id.0.clone()),
            minimum_waiver,
        },
    );
    if billing_owner == BillingOwner::CoreTick {
        let box_id = box_id.clone();
        heartbeat::on_tick_accepted(
            run_id.to_owned(),
            Arc::new(move |tick: heartbeat::TickAccepted| {
                let box_id = box_id.clone();
                Box::pin(async move {
                    let sent = match box_client().await {
                        Ok(client) => client
                            .keepalive(&box_id, tick.tick_index, tick.accrued_micro_usd)
                            .await
                            .map_err(|error| error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    if let Err(error) = sent {
                        tracing::warn!(error = %error, "Box keepalive failed; the liveness lease may park the Box");
                    }
                })
            }),
        );
    }
    Some(BoxMetering {
        org_id,
        spec,
        budget_micro_usd,
        started: Instant::now(),
    })
}

/// Deregister a run and debit its un-ticked tail, as `session::destroy_sandbox`
/// does. A run the heartbeat already removed (a kill) has nothing left.
pub(crate) async fn finish_metering(run_id: &str, metering: Option<&BoxMetering>) {
    let Some(metering) = metering else {
        return;
    };
    let Some(residual) = heartbeat::deregister_for_final_debit(run_id) else {
        return;
    };
    let Some(org_id) = metering.org_id.clone() else {
        return;
    };
    let measured = metering.started.elapsed().as_secs().max(1);
    if let Err(error) = heartbeat::debit_final(
        run_id.to_owned(),
        Some(org_id),
        metering.spec.clone(),
        measured.saturating_sub(residual.ticked_seconds),
        metering.budget_micro_usd,
        residual,
    )
    .await
    {
        tracing::warn!(error = %error, "Session Box final billing could not be confirmed");
    }
}

/// Delays between park attempts after a billing park interrupted a busy Box.
const BUSY_PARK_RETRIES: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

fn is_box_busy(error: &BoxApiError) -> bool {
    matches!(error, BoxApiError::Http { status: 409, code, .. } if code == "box_busy")
}

/// Park a Box for a billing verdict (balance, budget or accounting). The Box
/// service refuses a stop with `409 box_busy` while a foreground command
/// holds the Box; a Box that is out of credit must not keep running until
/// that command ends, so its processes are interrupted (as the service's own
/// sweeps do) and the park retried. A Box that is already gone counts as
/// parked.
pub(crate) async fn park_for_billing(
    client: &BoxSessionClient,
    box_id: &WorkspaceId,
    reason: ParkReason,
) -> Result<(), BoxApiError> {
    let error = match client.park(box_id, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => return Ok(()),
        Err(error) if is_box_busy(&error) => error,
        Err(error) => return Err(error),
    };
    if let Err(interrupt) = client.interrupt(box_id).await {
        tracing::warn!(error = %interrupt, "Busy Box could not be interrupted for a billing park");
        return Err(error);
    }
    let mut last = error;
    for delay in BUSY_PARK_RETRIES {
        tokio::time::sleep(delay).await;
        match client.park(box_id, reason).await {
            Ok(()) | Err(BoxApiError::NotFound) => return Ok(()),
            Err(error) if is_box_busy(&error) => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// The kill action of one live phase of a session Box: park with the
/// verdict's reason, then record the stop so the UI shows it.
fn session_kill_action(key: SessionBoxKey, box_id: WorkspaceId, lease_epoch: u64) -> ParkFn {
    Arc::new(move |reason: KillReason| {
        let key = key.clone();
        let box_id = box_id.clone();
        Box::pin(async move {
            let client = box_client().await?;
            park_for_billing(&client, &box_id, reason.park_reason())
                .await
                .map_err(anyhow::Error::new)?;
            tokio::spawn(mark_killed(key, lease_epoch, reason));
            Ok(())
        })
    })
}

/// After a kill verdict parked the Box: the heartbeat already removed the run,
/// so only the registry and the lease change. Only the live phase the verdict
/// was for is marked; a Box resumed since then is a new phase.
async fn mark_killed(key: SessionBoxKey, lease_epoch: u64, reason: KillReason) {
    let Some(slot) = existing_slot(&key) else {
        return;
    };
    let mut guard = slot.lock().await;
    let Some(entry) = guard.as_mut() else {
        return;
    };
    if entry.phase != Phase::Live || entry.lease_epoch != lease_epoch {
        return;
    }
    entry.stop_refresher();
    entry.metering = None;
    entry.phase = Phase::Parked;
    entry.stop_reason = Some(reason.as_str().to_owned());
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the park");
    }
}

// ── Acquire, resume, park, release ───────────────────────────────────────────

/// The owner a request speaks for (`user:<id>` or `node-owner`).
pub(crate) fn owner_of(auth: &ResolvedAuthorization) -> Result<String, ApiError> {
    environments::owner(auth)
}

/// Whether a caller may create or resume a session Box.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Acquisition {
    Allowed,
    /// Machine verbs stay on the node by configuration: the owner's `node`
    /// preference, or a Box service that cannot run a desktop.
    KeepNode,
    /// This caller may not acquire one now: no rollout flag (or a turn
    /// authority whose token has expired) or no usable Box credential.
    Refused,
}

/// Whether `reason` may create or resume a session Box for this caller: the
/// rollout flag (a local owner without a cloud identity is gated only by the
/// node's Box configuration), a configured Box endpoint that can run a
/// desktop, and for computer use (including a sub-agent's) the owner's target
/// preference.
async fn acquisition(auth: &ResolvedAuthorization, reason: AcquireReason) -> Acquisition {
    if environments::require_box_backend_feature(auth)
        .await
        .is_err()
    {
        return Acquisition::Refused;
    }
    let Ok(credential) = box_credential().await else {
        return Acquisition::Refused;
    };
    if matches!(reason, AcquireReason::ComputerUse | AcquireReason::SubAgent)
        && !computer_target_is_auto().await
    {
        return Acquisition::KeepNode;
    }
    if !desktop_supported(&credential).await {
        return Acquisition::KeepNode;
    }
    Acquisition::Allowed
}

/// Whether this node's Box credential resolves (env, or the installed
/// control-plane source on a managed node).
///
/// Reads the process-wide credential only (never a test override), so route
/// gates see exactly what the node is configured with.
pub(crate) async fn box_configured() -> bool {
    ryu_sandbox::box_credential::current().await.is_ok()
}

/// Whether this node serves `computer.*` and `browser.*` from session Boxes
/// at all: a Box credential, a Box service that can run a desktop, and the
/// `auto` computer target. The per-caller rollout flag is checked per call.
pub(crate) async fn serves_machine_verbs() -> bool {
    let Ok(credential) = ryu_sandbox::box_credential::current().await else {
        return false;
    };
    computer_target_is_auto().await && desktop_supported(&credential).await
}

/// Whether this node puts a conversation's computer use on session Boxes: a
/// usable Box credential, a Box service that can run a desktop, and the
/// `auto` computer target. A run that may not start a Box then fails closed
/// instead of driving the node's display (`box_desktop`).
pub(crate) async fn computer_use_goes_to_boxes() -> bool {
    let Ok(credential) = box_credential().await else {
        return false;
    };
    computer_target_is_auto().await && desktop_supported(&credential).await
}

/// How long a desktop capability answer is reused: a positive one for 10
/// minutes, a negative or failed one for 1 minute.
const DESKTOP_PROBE_TTL: Duration = Duration::from_secs(600);
const DESKTOP_PROBE_RETRY: Duration = Duration::from_secs(60);

/// Whether the Box service behind `credential` can run a desktop Box: it
/// lists `desktop` in its `/health` features only when it has a desktop image
/// (an older service never lists it). Without it a session Box would have no
/// screen, so computer use stays on the node.
async fn desktop_supported(credential: &BoxCredential) -> bool {
    static PROBES: OnceLock<StdMutex<HashMap<String, (Instant, bool)>>> = OnceLock::new();
    let probes = PROBES.get_or_init(|| StdMutex::new(HashMap::new()));
    let base = credential.base.as_str().to_owned();
    if let Some((at, supported)) = probes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&base)
        .copied()
    {
        let ttl = if supported {
            DESKTOP_PROBE_TTL
        } else {
            DESKTOP_PROBE_RETRY
        };
        if at.elapsed() < ttl {
            return supported;
        }
    }
    let supported = match BoxSessionClient::from_credential(credential)
        .features()
        .await
    {
        Ok(features) => features.iter().any(|feature| feature == "desktop"),
        Err(error) => {
            tracing::warn!(error = %error, "Box service features could not be read; computer use stays on the node");
            false
        }
    };
    probes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(base, (Instant::now(), supported));
    supported
}

/// `session-box-computer-target`: `auto` (the default) or `node`.
pub(crate) async fn computer_target_is_auto() -> bool {
    let Ok(store) = crate::server::preferences::PreferencesStore::open_default() else {
        return true;
    };
    !matches!(
        store.get(PREF_COMPUTER_TARGET).await,
        Ok(Some(value)) if value.trim().eq_ignore_ascii_case("node")
    )
}

/// The Box a conversation's machine verbs run on.
///
/// - A conversation with a cloud task Box attaches to it (no second create).
/// - A live session Box is returned and marked active.
/// - With `acquire`, a parked Box is resumed and a missing one created, after
///   the rollout gate and admission (§7.3). Without it, nothing is created.
/// - A child the cap refuses shares its parent's Box.
///
/// `Ok(None)` means "run on the node": no Box exists and none may be acquired
/// for this caller (flag off, no Box endpoint, or the `node` preference).
pub(crate) async fn desktop_target(
    auth: &ResolvedAuthorization,
    key: &SessionBoxKey,
    acquire: Option<AcquireReason>,
) -> Result<Option<BoxTarget>, ApiError> {
    if owner_of(auth)? != key.owner {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "session_box_forbidden",
            "This session Box belongs to a different caller.",
        ));
    }
    if is_deleted(&key.conversation_id) {
        return Err(deleted_error());
    }
    // A conversation on the user's own plan has no session Box (no live screen, no Box
    // charge, no first-Box cost notice); its agent runs in the provider's cloud.
    if super::subscription_cloud::fences_box(&key.conversation_id) {
        return match acquire {
            Some(AcquireReason::ComputerUse | AcquireReason::SubAgent) => Err(api_error(
                StatusCode::CONFLICT,
                "session_box_unavailable_on_subscription",
                "This conversation runs on your own Claude or ChatGPT plan, which has no Ryu Box or live screen. Start a new conversation to use one.",
            )),
            _ => Ok(None),
        };
    }
    if key.child.is_none() {
        if let Some(target) = cloud_tasks::bound_box(&key.owner, &key.conversation_id).await {
            return Ok(Some(target));
        }
    } else if lock_shared().contains(key) {
        return Box::pin(desktop_target(auth, &key.parent(), acquire)).await;
    }
    let creating = matches!(
        acquire,
        Some(AcquireReason::ComputerUse | AcquireReason::SubAgent)
    );
    let slot = if creating {
        slot_for(key)
    } else {
        match existing_slot(key) {
            Some(slot) => slot,
            None => return Ok(None),
        }
    };
    let mut guard = slot.lock().await;
    // The slot may have left the registry while this call waited for it (a
    // conversation delete releases it; an empty slot is forgotten). An entry
    // stored in such an orphan would be invisible to the sweep, park, status
    // and release, so never act on one.
    let registered = existing_slot(key).is_some_and(|current| Arc::ptr_eq(&current, &slot));
    if !registered || is_deleted(&key.conversation_id) {
        drop(guard);
        if is_deleted(&key.conversation_id) {
            return Err(deleted_error());
        }
        return Box::pin(desktop_target(auth, key, acquire)).await;
    }
    match guard.as_mut() {
        Some(entry) if entry.phase == Phase::Live => {
            entry.last_activity = Instant::now();
            return Ok(Some(entry.target()));
        }
        Some(_) | None if !creating => return Ok(None),
        _ => {}
    }
    let reason = acquire.unwrap_or(AcquireReason::ComputerUse);
    match acquisition(auth, reason).await {
        Acquisition::Allowed => {}
        Acquisition::KeepNode if guard.is_none() => {
            drop(guard);
            forget_empty(key, &slot);
            return Ok(None);
        }
        Acquisition::KeepNode => return Ok(None),
        Acquisition::Refused if guard.is_none() => {
            drop(guard);
            forget_empty(key, &slot);
            return Ok(None);
        }
        // A parked Box exists: its machine verbs must never fall back to
        // the node's display. The turn's authority has lapsed (its token
        // expired) or the Box credential failed; a new message refreshes it.
        Acquisition::Refused => {
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_box_authority_expired",
                "This conversation's session Box is parked and cannot be resumed for this turn. Send the message again from the conversation to resume it.",
            ))
        }
    }
    let admitted = caps::admit(auth, &key.owner, Some(key), BoxSize::default()).await;
    if let Err(refusal) = admitted {
        let empty = guard.is_none();
        drop(guard);
        if empty {
            forget_empty(key, &slot);
        }
        if key.child.is_some() && refusal.0 == StatusCode::TOO_MANY_REQUESTS {
            // Cap pressure is not an error for a sub-agent: it shares the
            // parent's Box (design §7.5).
            lock_shared().insert(key.clone());
            return Box::pin(desktop_target(auth, &key.parent(), acquire)).await;
        }
        return Err(refusal);
    }
    // The first Box of an owner waits for the one-time cost notice
    // (`notice`), asked only once admission passed so nobody allows a cost
    // and is then refused. The slot is released while the call waits; once
    // allowed, the call starts over (admission is checked again) and the turn
    // goes on. A parked Box resumes without the notice.
    if guard.is_none() && !notice::acknowledged(&key.owner) {
        drop(guard);
        forget_empty(key, &slot);
        notice::wait_for_acknowledgement(key, BoxSize::default()).await?;
        return Box::pin(desktop_target(auth, key, acquire)).await;
    }
    match guard.as_mut() {
        Some(entry) => {
            resume_entry(entry).await?;
            Ok(Some(entry.target()))
        }
        None => match create_entry(key).await {
            Ok(entry) => {
                let target = entry.target();
                *guard = Some(entry);
                Ok(Some(target))
            }
            Err(error) => {
                drop(guard);
                forget_empty(key, &slot);
                Err(error)
            }
        },
    }
}

/// Drop a slot that never got an entry.
fn forget_empty(key: &SessionBoxKey, slot: &Slot) {
    let mut registry = lock_registry();
    if registry.get(key).is_some_and(|current| {
        Arc::ptr_eq(current, slot) && current.try_lock().is_ok_and(|entry| entry.is_none())
    }) {
        registry.remove(key);
    }
}

/// Create a new session Box for `key`: lease first, then create with its own
/// desktop, then meter and deliver its inference credential.
async fn create_entry(key: &SessionBoxKey) -> Result<Entry, ApiError> {
    let credential = box_credential()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    let client = BoxSessionClient::from_credential(&credential);
    let lease_id = uuid::Uuid::new_v4().to_string();
    let _creating = CreatingLease::new(&lease_id);
    let name = box_name(&lease_id);
    let size = BoxSize::default();
    let now = unix_now();
    let mut lease = SessionLease {
        schema_version: 1,
        id: lease_id.clone(),
        owner: key.owner.clone(),
        conversation_id: key.conversation_id.clone(),
        child: key.child,
        box_id: None,
        size,
        parked: false,
        deleted: false,
        box_expires_at: now + BOX_TTL_SECONDS,
        lease_epoch: 1,
    };
    write_lease(&lease).map_err(|_| unavailable("Session Box lease persistence failed."))?;
    let mut labels = BTreeMap::new();
    labels.insert(
        "ryu-kind".to_owned(),
        if key.child.is_some() {
            "sub-agent"
        } else {
            "session"
        }
        .to_owned(),
    );
    labels.insert("ryu-lease".to_owned(), lease_id.clone());
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: BoxNetwork::Egress,
        ttl_seconds: BOX_TTL_SECONDS,
        setup: Vec::new(),
        size,
        desktop: true,
        labels,
    };
    let box_id = match client.create_disposable(&spec, &name).await {
        Ok(box_id) => box_id,
        Err(error) => {
            // An idempotent create can leave a Box behind; keep the lease
            // unless cleanup is confirmed.
            if destroy_named(&client, &name).await.is_ok() {
                let _ = remove_lease(&lease_id);
            }
            return Err(box_api_error(&error));
        }
    };
    lease.box_id = Some(box_id.0.clone());
    if write_lease(&lease).is_err() {
        let _ = client.destroy(&box_id).await;
        let _ = remove_lease(&lease_id);
        return Err(unavailable("Session Box lease persistence failed."));
    }
    let mut entry = Entry {
        key: key.clone(),
        lease_id,
        box_id,
        size,
        phase: Phase::Live,
        lease_epoch: 1,
        last_activity: Instant::now(),
        run_until: now + RUN_LIFETIME_SECONDS,
        box_expires_at: lease.box_expires_at,
        metering: None,
        stop_reason: None,
        refresher: None,
    };
    // A created Box always pays its per-start minimum.
    go_live(&mut entry, credential.billing_owner, None).await;
    Ok(entry)
}

/// Metering and the inference credential of a Box that just became live.
/// `minimum_waiver` is the Box service's signed verdict for this start.
async fn go_live(entry: &mut Entry, billing_owner: BillingOwner, minimum_waiver: Option<String>) {
    entry.metering = start_metering(
        &entry.run_id(),
        &entry.box_id,
        entry.size,
        billing_owner,
        session_kill_action(entry.key.clone(), entry.box_id.clone(), entry.lease_epoch),
        minimum_waiver,
    )
    .await;
    entry.refresher =
        inference::start_refresher(entry.key.clone(), entry.box_id.clone(), entry.lease_epoch);
}

/// Resume a parked entry (admission already ran).
async fn resume_entry(entry: &mut Entry) -> Result<(), ApiError> {
    if entry.phase == Phase::Live {
        entry.last_activity = Instant::now();
        return Ok(());
    }
    let credential = box_credential()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    let client = BoxSessionClient::from_credential(&credential);
    let resumed = client
        .resume(&entry.box_id)
        .await
        .map_err(|error| box_api_error(&error))?;
    entry.phase = Phase::Live;
    entry.lease_epoch = entry.lease_epoch.saturating_add(1);
    entry.last_activity = Instant::now();
    entry.run_until = unix_now() + RUN_LIFETIME_SECONDS;
    entry.stop_reason = None;
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the resume");
    }
    // The Box service decides whether this resume owes a new minimum (only a
    // resume onto the Box's own parked VM inside the hour already paid for)
    // and signs that for the Gateway, which verifies it.
    go_live(entry, credential.billing_owner, resumed.minimum_waiver()).await;
    Ok(())
}

/// Park one live entry: save state and release compute, then stop metering
/// and the credential refresher.
async fn park_entry(entry: &mut Entry, reason: ParkReason) -> Result<(), ApiError> {
    if entry.phase != Phase::Live {
        return Ok(());
    }
    let client = box_client()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    match client.park(&entry.box_id, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => {}
        Err(error) => return Err(box_api_error(&error)),
    }
    entry.stop_refresher();
    finish_metering(&entry.run_id(), entry.metering.as_ref()).await;
    entry.metering = None;
    entry.phase = Phase::Parked;
    entry.stop_reason = Some(reason.as_str().to_owned());
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the park");
    }
    Ok(())
}

/// Mark a session Box active (a tool call ran on it).
pub(crate) async fn touch(key: &SessionBoxKey) {
    let key = if key.child.is_some() && lock_shared().contains(key) {
        key.parent()
    } else {
        key.clone()
    };
    if let Some(slot) = existing_slot(&key) {
        if let Some(entry) = slot.lock().await.as_mut() {
            entry.last_activity = Instant::now();
        }
    }
}

/// Park the Box of `key`; parking a conversation's own Box parks its
/// children too.
pub(crate) async fn park(key: &SessionBoxKey, reason: ParkReason) -> Result<(), ApiError> {
    let mut keys = vec![key.clone()];
    if key.child.is_none() {
        keys.extend(
            conversation_keys(&key.conversation_id)
                .into_iter()
                .filter(|other| other.owner == key.owner && other.child.is_some()),
        );
    }
    let mut first_error = None;
    for key in keys {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_mut() {
            if let Err(error) = park_entry(entry, reason).await {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Whether the machine verbs of `key` go to a Box: the conversation has a
/// cloud task Box or a session Box (live or parked), or, for a sub-agent
/// child, the child has its own Box.
pub(crate) async fn routes_to_box(key: &SessionBoxKey) -> bool {
    if cloud_tasks::bound_box(&key.owner, &key.conversation_id)
        .await
        .is_some()
    {
        return true;
    }
    let mut keys = vec![key.parent()];
    if key.child.is_some() {
        keys.push(key.clone());
    }
    keys.iter().any(|key| {
        existing_slot(key).is_some_and(|slot| {
            // An entry being created holds the lock; it routes to the Box it
            // will be.
            slot.try_lock().map_or(true, |entry| entry.is_some())
        })
    })
}

/// The lowest free sub-agent child number of a conversation (1, 2, …), or
/// `None` when all [`MAX_CHILDREN`] are held by sub-agents still running.
/// A finished sub-agent returns its number with [`release_child`].
pub(crate) fn next_child_index(owner: &str, conversation_id: &str) -> Option<u32> {
    let mut counters = lock_child_counters();
    let used = counters
        .entry((owner.to_owned(), conversation_id.to_owned()))
        .or_default();
    let index = (1..=MAX_CHILDREN).find(|index| !used.contains(index))?;
    used.insert(index);
    Some(index)
}

/// A sub-agent finished: park its child Box (state kept for the next child
/// that takes the number) and free its number.
pub(crate) async fn release_child(key: &SessionBoxKey) {
    let Some(index) = key.child else {
        return;
    };
    lock_shared().remove(key);
    if let Err(error) = park(key, ParkReason::Idle).await {
        tracing::warn!(error = ?error.1 .0, "Finished sub-agent's Box could not be parked; the idle sweep retries");
    }
    let mut counters = lock_child_counters();
    let conversation = (key.owner.clone(), key.conversation_id.clone());
    if let Some(used) = counters.get_mut(&conversation) {
        used.remove(&index);
        if used.is_empty() {
            counters.remove(&conversation);
        }
    }
}

async fn destroy_named(client: &BoxSessionClient, name: &str) -> Result<()> {
    if let Some(workspace) = client.find_by_name(name).await? {
        destroy_box(client, &workspace).await?;
    }
    Ok(())
}

/// Delete a Box; one that is already gone counts as deleted.
async fn destroy_box(client: &BoxSessionClient, box_id: &WorkspaceId) -> Result<()> {
    match client.destroy(box_id).await {
        Ok(()) => Ok(()),
        Err(error)
            if error
                .downcast_ref::<BoxApiError>()
                .is_some_and(|error| *error == BoxApiError::NotFound) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// Delete one lease's Box (by id, or by its deterministic name) and the lease.
async fn destroy_lease(client: &BoxSessionClient, lease: &SessionLease) -> Result<()> {
    match &lease.box_id {
        Some(id) => destroy_box(client, &WorkspaceId(id.clone())).await?,
        None => destroy_named(client, &lease.name()).await?,
    }
    remove_lease(&lease.id)
}

/// The conversation was deleted: delete its Box and every child Box, for
/// `owner`. A Box that cannot be deleted yet keeps a `deleted` lease, which
/// the idle sweep retries.
pub(crate) async fn release_conversation(owner: &str, conversation_id: &str) {
    // First, so no acquisition waiting on one of these slots (or starting
    // after this point) creates a Box for the deleted conversation.
    tombstone(conversation_id);
    let keys: Vec<SessionBoxKey> = conversation_keys(conversation_id)
        .into_iter()
        .filter(|key| key.owner == owner)
        .collect();
    let client = box_client().await.ok();
    for key in keys {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_mut() {
            entry.stop_refresher();
            finish_metering(&entry.run_id(), entry.metering.as_ref()).await;
            entry.metering = None;
            let mut lease = lease_of(entry);
            lease.deleted = true;
            let _ = write_lease(&lease);
        }
        *guard = None;
        drop(guard);
        let mut registry = lock_registry();
        if registry
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            registry.remove(&key);
        }
    }
    lock_shared().retain(|key| !(key.owner == owner && key.conversation_id == conversation_id));
    lock_child_counters().remove(&(owner.to_owned(), conversation_id.to_owned()));
    for mut lease in leases()
        .into_iter()
        .filter(|lease| lease.owner == owner && lease.conversation_id == conversation_id)
    {
        let destroyed = match &client {
            Some(client) => destroy_lease(client, &lease).await,
            None => Err(anyhow!("Ryu Box is not configured on this node")),
        };
        if let Err(error) = destroyed {
            tracing::warn!(lease = %lease.id, error = %error, "Session Box of a deleted conversation could not be deleted yet; retrying later");
            if !lease.deleted {
                lease.deleted = true;
                let _ = write_lease(&lease);
            }
        }
    }
}

/// [`release_conversation`] for every owner holding a Box in the deleted
/// conversation. The delete route already checked the caller's write access.
pub(crate) async fn release_deleted_conversation(conversation_id: &str) {
    tombstone(conversation_id);
    crate::sidecar::mcp::box_desktop::forget_children_of(conversation_id);
    // Ryu's record of a run on the user's plan; the run itself lives on the provider.
    super::subscription_cloud::store::forget_conversation(conversation_id);
    let mut owners: Vec<String> = conversation_keys(conversation_id)
        .into_iter()
        .map(|key| key.owner)
        .chain(
            leases()
                .into_iter()
                .filter(|lease| lease.conversation_id == conversation_id)
                .map(|lease| lease.owner),
        )
        .collect();
    owners.sort();
    owners.dedup();
    for owner in owners {
        release_conversation(&owner, conversation_id).await;
    }
}

/// Whether another owner holds a Box (session or cloud task) in this
/// conversation.
async fn held_by_another_owner(owner: &str, conversation_id: &str) -> bool {
    conversation_keys(conversation_id)
        .iter()
        .any(|key| key.owner != owner)
        || leases()
            .iter()
            .any(|lease| lease.conversation_id == conversation_id && lease.owner != owner)
        || cloud_tasks::bound_box_owner(conversation_id)
            .await
            .is_some_and(|holder| holder != owner)
}

/// Recover leases left by an earlier Core process: park their Boxes and
/// register them as parked, so the next heavy call resumes them; delete the
/// ones whose conversation was deleted or whose Box the service has reaped.
pub(crate) async fn recover_leases() {
    let Ok(client) = box_client().await else {
        return;
    };
    let now = unix_now();
    for mut lease in leases() {
        let key = lease.key();
        if existing_slot(&key).is_some() || creating_leases().contains(&lease.id) {
            continue;
        }
        // A Box whose run is still metered here has no registry entry left
        // to park it (an earlier orphaned entry); end that metering first.
        stop_orphan_metering(&lease.id).await;
        if lease.deleted || lease.box_expires_at <= now || lease.box_id.is_none() {
            if let Err(error) = destroy_lease(&client, &lease).await {
                tracing::warn!(lease = %lease.id, error = %error, "Session Box lease cleanup failed; retrying later");
            }
            continue;
        }
        let Some(box_id) = lease.box_id.clone().map(WorkspaceId) else {
            continue;
        };
        if !lease.parked {
            match client.park(&box_id, ParkReason::User).await {
                Ok(()) => {}
                Err(BoxApiError::NotFound) => {
                    let _ = remove_lease(&lease.id);
                    continue;
                }
                Err(error) => {
                    tracing::warn!(lease = %lease.id, error = %error, "Recovered session Box could not be parked yet; retrying later");
                    continue;
                }
            }
            lease.parked = true;
        }
        // Continue above every epoch a key was signed for before the restart.
        lease.lease_epoch = lease.lease_epoch.saturating_add(1).max(1);
        let _ = write_lease(&lease);
        let entry = Entry {
            key: key.clone(),
            lease_id: lease.id.clone(),
            box_id,
            size: lease.size,
            phase: Phase::Parked,
            lease_epoch: lease.lease_epoch,
            last_activity: Instant::now(),
            run_until: now,
            box_expires_at: lease.box_expires_at,
            metering: None,
            stop_reason: Some("restart".to_owned()),
            refresher: None,
        };
        let slot = slot_for(&key);
        let mut guard = slot.lock().await;
        if guard.is_none() {
            *guard = Some(entry);
        }
    }
}

/// Deregister, with the final debit of its un-ticked tail, every heartbeat
/// run of `lease_id` (`<lease_id>-e<epoch>`).
async fn stop_orphan_metering(lease_id: &str) {
    let prefix = format!("{lease_id}-e");
    for run in heartbeat::list_active_runs()
        .into_iter()
        .filter(|run| run.run_id.starts_with(&prefix))
    {
        tracing::warn!(run = %run.run_id, "Session Box run had no registry entry; ending its metering");
        let metering = BoxMetering {
            org_id: run.org_id.clone(),
            spec: run.spec.clone(),
            budget_micro_usd: run.per_run_budget_micro_usd,
            started: Instant::now()
                .checked_sub(Duration::from_secs(run.elapsed_seconds))
                .unwrap_or_else(Instant::now),
        };
        finish_metering(&run.run_id, Some(&metering)).await;
    }
}

// ── Status ───────────────────────────────────────────────────────────────────

/// `PublicBox.placement` as the UI shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxPlacement {
    /// `hetzner`, `vultr`, `digitalocean`, `overflow` or `local`.
    pub provider: Option<String>,
    pub location: Option<String>,
    /// `parked`, `hetzner`, `pool`, `overflow`, `fallback` or `local`.
    pub tier: Option<String>,
    pub isolation: Option<String>,
}

/// The Box screen's state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxDesktop {
    pub ready: bool,
    pub viewers: u32,
}

/// One Box as the session UI shows it (design §9). Shared by
/// `SessionBoxStatus` and `CloudTaskStatus`; every field but `state` is
/// optional for older clients and records.
#[derive(Clone, Debug, Default, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxView {
    pub id: Option<String>,
    /// `small`, `default` or `large`.
    pub size: Option<String>,
    /// `provisioning`, `ready`, `parked`, `stopped` or `error`.
    pub state: String,
    /// `cloud_task`, `session` or `sub_agent`.
    pub source: Option<String>,
    /// The sub-agent child number, for a child Box.
    pub child: Option<u32>,
    pub placement: Option<SessionBoxPlacement>,
    pub desktop: Option<SessionBoxDesktop>,
    pub running_since: Option<String>,
    /// Seconds metered in the current run.
    pub running_seconds: u64,
    /// Cost so far in this run, from the Gateway's tick (micro-USD).
    pub accrued_micro_usd: u64,
    /// The Gateway's hourly rate for this Box (micro-USD per hour).
    pub rate_per_hour_micro_usd: Option<u64>,
    pub balance_micro_usd: Option<i64>,
    pub minutes_remaining: Option<u64>,
    /// `none`, `low` or `critical`.
    pub warning: String,
    /// Why the Box stopped: `user`, `idle`, `ttl`, `balance`, `budget`,
    /// `accounting`, `liveness`, `suspended` or `restart`.
    pub stop_reason: Option<String>,
    /// When a live Box is parked for its lifetime.
    pub expires_at: Option<String>,
}

/// `GET /api/session-boxes/{conversationId}`.
#[derive(Clone, Debug, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBoxStatus {
    pub conversation_id: String,
    #[serde(rename = "box")]
    #[schema(rename = "box")]
    pub session_box: Option<SessionBoxView>,
    /// Sub-agent child Boxes, by child number.
    pub children: Vec<SessionBoxView>,
    pub caps: Option<BoxCaps>,
    /// Present while a Box of this conversation waits for the owner's
    /// one-time acknowledgement of its hourly cost
    /// (`POST /api/session-boxes/{conversationId}/cost-notice`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_notice: Option<notice::CostNotice>,
}

/// Low-credit level for a run: `critical` under 5 minutes of balance or a
/// non-positive balance, `low` on the Gateway's `warn` verdict or under 15
/// minutes, else `none`.
pub(crate) fn warning_level(
    verdict: Option<heartbeat::Verdict>,
    minutes_remaining: Option<u64>,
    balance_micro_usd: Option<i64>,
) -> &'static str {
    if balance_micro_usd.is_some_and(|balance| balance <= 0)
        || minutes_remaining.is_some_and(|minutes| minutes < 5)
    {
        "critical"
    } else if verdict == Some(heartbeat::Verdict::Warn)
        || minutes_remaining.is_some_and(|minutes| minutes < 15)
    {
        "low"
    } else {
        "none"
    }
}

/// Minutes of balance left at `rate` micro-USD per hour.
pub(crate) fn minutes_remaining(balance_micro_usd: Option<i64>, rate: Option<u64>) -> Option<u64> {
    let balance = u64::try_from(balance_micro_usd?).unwrap_or(0);
    let rate = rate.filter(|rate| *rate > 0)?;
    Some(balance.saturating_mul(60) / rate)
}

/// The hourly rate at which the wallet `run` reports is drained: the rates
/// of every live run billed to the same org (this run's own when it has no
/// org). `None` until this run has a rate.
pub(crate) fn combined_rate(
    run: &heartbeat::SandboxRunSnapshot,
    active: &[heartbeat::SandboxRunSnapshot],
) -> Option<u64> {
    let own = run.rate_micro_usd_per_hour?;
    let Some(org) = run.org_id.as_deref() else {
        return Some(own);
    };
    let others: u64 = active
        .iter()
        .filter(|other| other.run_id != run.run_id && other.org_id.as_deref() == Some(org))
        .filter_map(|other| other.rate_micro_usd_per_hour)
        .fold(0, u64::saturating_add);
    Some(own.saturating_add(others))
}

fn view_cache() -> &'static StdMutex<HashMap<String, (Instant, BoxView)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (Instant, BoxView)>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// The Box service's view of one Box, reused for [`VIEW_CACHE_TTL`].
async fn fetch_view(box_id: &WorkspaceId) -> Option<BoxView> {
    {
        let cache = view_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((fetched, view)) = cache.get(&box_id.0) {
            if fetched.elapsed() < VIEW_CACHE_TTL {
                return Some(view.clone());
            }
        }
    }
    let view = tokio::time::timeout(Duration::from_secs(3), async {
        box_client().await.ok()?.status(box_id).await.ok()
    })
    .await
    .ok()
    .flatten()?;
    let mut cache = view_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|_, (fetched, _)| fetched.elapsed() < VIEW_CACHE_TTL);
    cache.insert(box_id.0.clone(), (Instant::now(), view.clone()));
    Some(view)
}

fn placement_of(value: Option<&Value>) -> Option<SessionBoxPlacement> {
    let value = value?.as_object()?;
    let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(SessionBoxPlacement {
        provider: text("provider"),
        location: text("location"),
        tier: text("tier"),
        isolation: text("isolation"),
    })
}

/// Build the UI view of one Box from the heartbeat run and, while it is
/// live, the Box service's own view.
pub(crate) async fn box_view(
    target: &BoxTarget,
    live: bool,
    stop_reason: Option<String>,
    run_until: Option<u64>,
    child: Option<u32>,
) -> SessionBoxView {
    let snapshot = heartbeat::run_snapshot(&target.run_id);
    let remote = if live {
        fetch_view(&target.box_id).await
    } else {
        None
    };
    let rate = snapshot
        .as_ref()
        .and_then(|run| run.rate_micro_usd_per_hour);
    let balance = snapshot.as_ref().and_then(|run| run.balance_micro_usd);
    // The wallet is shared: every running Box of the org draws on it.
    let minutes = minutes_remaining(
        balance,
        snapshot
            .as_ref()
            .and_then(|run| combined_rate(run, &heartbeat::list_active_runs())),
    );
    let state = match (live, remote.as_ref().map(|view| view.status)) {
        (false, _) => "parked",
        (true, Some(BoxStatus::Provisioning)) => "provisioning",
        (true, Some(BoxStatus::Stopping | BoxStatus::Stopped)) => "parked",
        (true, Some(BoxStatus::Error)) => "error",
        (true, Some(BoxStatus::Deleted)) => "stopped",
        (true, _) => "ready",
    };
    let viewers = relay_viewer_count(&target.box_id.0);
    SessionBoxView {
        id: Some(target.box_id.0.clone()),
        size: Some(target.size.as_str().to_owned()),
        state: state.to_owned(),
        source: Some(target.source.label().to_owned()),
        child,
        placement: remote
            .as_ref()
            .and_then(|view| placement_of(view.placement.as_ref())),
        desktop: remote.as_ref().and_then(|view| {
            view.desktop.map(|desktop| SessionBoxDesktop {
                ready: desktop.ready,
                viewers: desktop.viewers.max(viewers),
            })
        }),
        running_since: remote.as_ref().and_then(|view| view.running_since.clone()),
        running_seconds: snapshot.as_ref().map_or(0, |run| run.elapsed_seconds),
        accrued_micro_usd: snapshot.as_ref().map_or(0, |run| run.accrued_micro_usd),
        rate_per_hour_micro_usd: rate,
        balance_micro_usd: balance,
        minutes_remaining: minutes,
        warning: warning_level(
            snapshot.as_ref().and_then(|run| run.last_verdict),
            minutes,
            balance,
        )
        .to_owned(),
        stop_reason,
        expires_at: if live {
            run_until.and_then(rfc3339)
        } else {
            None
        },
    }
}

/// The view of one registry entry.
async fn entry_view(key: &SessionBoxKey) -> Option<SessionBoxView> {
    let slot = existing_slot(key)?;
    let (target, live, stop_reason, run_until) = {
        let guard = slot.try_lock().ok()?;
        let entry = guard.as_ref()?;
        (
            entry.target(),
            entry.phase == Phase::Live,
            entry.stop_reason.clone(),
            entry.run_until,
        )
    };
    Some(box_view(&target, live, stop_reason, Some(run_until), key.child).await)
}

/// The session Box status of one conversation, or `None` when it has no Box.
pub(crate) async fn status(owner: &str, conversation_id: &str) -> Option<SessionBoxStatus> {
    let parent = SessionBoxKey::session(owner, conversation_id);
    let mut session_box = match cloud_tasks::bound_box(owner, conversation_id).await {
        Some(target) => Some(box_view(&target, true, None, None, None).await),
        None => entry_view(&parent).await,
    };
    if session_box.is_none() {
        // An entry being created holds its lock.
        if let Some(slot) = existing_slot(&parent) {
            if slot.try_lock().is_err() {
                session_box = Some(SessionBoxView {
                    state: "provisioning".to_owned(),
                    warning: "none".to_owned(),
                    source: Some(TargetSource::Session.label().to_owned()),
                    ..SessionBoxView::default()
                });
            }
        }
    }
    let mut children = Vec::new();
    for key in conversation_keys(conversation_id)
        .into_iter()
        .filter(|key| key.owner == owner && key.child.is_some())
    {
        if let Some(view) = entry_view(&key).await {
            children.push(view);
        }
    }
    let cost_notice = notice::pending_notice(owner, conversation_id);
    if session_box.is_none() && children.is_empty() && cost_notice.is_none() {
        return None;
    }
    Some(SessionBoxStatus {
        conversation_id: conversation_id.to_owned(),
        session_box,
        children,
        caps: caps::cached_caps(owner),
        cost_notice,
    })
}

/// A cloud task Box admission refusal (429 or 402), carried through the
/// task preparation's error so the route answers with it.
#[derive(Debug)]
pub(crate) struct AdmissionRefusal(pub ApiError);

impl std::fmt::Display for AdmissionRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = self.0 .1 .0["error"]["message"]
            .as_str()
            .unwrap_or("The Box was not admitted.");
        formatter.write_str(message)
    }
}

impl std::error::Error for AdmissionRefusal {}

/// Admit a cloud task's Box of `size` for `owner` before it is created: the
/// same signed running cap, credit pre-flight and Box limits as a session Box
/// (design §7.2, §7.3).
pub(crate) async fn admit_cloud_task(
    auth: &ResolvedAuthorization,
    owner: &str,
    size: BoxSize,
) -> Result<(), AdmissionRefusal> {
    caps::admit(auth, owner, None, size)
        .await
        .map_err(AdmissionRefusal)
}

/// The caller's running Boxes and cap, refreshed for this request.
pub(crate) async fn owner_caps(auth: &ResolvedAuthorization, owner: &str) -> Option<BoxCaps> {
    caps::refresh(auth, owner).await;
    caps::cached_caps(owner)
}

/// Live session Boxes (not cloud task Boxes) of one owner, leaving out
/// `exclude` (the Box being admitted, whose slot the caller holds).
fn live_session_boxes(owner: &str, exclude: Option<&SessionBoxKey>) -> u32 {
    let slots: Vec<Slot> = lock_registry()
        .iter()
        .filter(|(key, _)| key.owner == owner && Some(*key) != exclude)
        .map(|(_, slot)| slot.clone())
        .collect();
    let live = slots
        .iter()
        .filter(|slot| {
            // A held lock is an entry being created or resumed: count it.
            slot.try_lock().map_or(true, |entry| {
                entry
                    .as_ref()
                    .is_some_and(|entry| entry.phase == Phase::Live)
            })
        })
        .count();
    u32::try_from(live).unwrap_or(u32::MAX)
}

// ── Router ───────────────────────────────────────────────────────────────────

/// The node-authenticated routes (`GatewayRoute`).
pub(crate) fn routes() -> axum::Router<super::ServerState> {
    api::routes()
}

/// Routes on the public router: the relay WebSocket (a browser cannot set an
/// authorization header; it presents a one-use Core ticket) and the Box
/// inference relay (authenticated by the Box's `gwb1` key).
pub(crate) fn public_routes() -> axum::Router<super::ServerState> {
    api::public_routes()
}

/// Start the 30 s idle sweep (and the lease recovery on its first tick).
pub(crate) fn start_idle_sweep() {
    idle::start();
}

pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    api::openapi()
}

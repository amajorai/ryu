//! Registry entries, the process-wide tables and error helpers.
// test-exempt: moved verbatim out of server/session_box.rs; covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;

/// Lifecycle of one registry entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    /// Created or resumed; compute is running.
    Live,
    /// Parked: state saved, compute released. The next heavy call resumes.
    Parked,
}

/// Billing attribution of a metered Box run.
pub(crate) struct BoxMetering {
    pub(super) org_id: Option<String>,
    pub(super) spec: SandboxSpec,
    pub(super) budget_micro_usd: u64,
    pub(super) started: Instant,
}

/// One session Box.
pub(super) struct Entry {
    pub(super) key: SessionBoxKey,
    pub(super) lease_id: String,
    pub(super) box_id: WorkspaceId,
    pub(super) size: BoxSize,
    pub(super) phase: Phase,
    /// Bumped on every create and resume; part of the Box's `gwb1` scope.
    pub(super) lease_epoch: u64,
    pub(super) last_activity: Instant,
    /// Unix seconds at which a live Box is parked for its lifetime.
    pub(super) run_until: u64,
    /// Unix seconds at which the Box service reaps the Box.
    pub(super) box_expires_at: u64,
    pub(super) metering: Option<BoxMetering>,
    /// Why the Box was last parked (`user`, `idle`, `ttl`, `balance`, …).
    pub(super) stop_reason: Option<String>,
    /// The `gwb1` credential refresher; aborted when the Box parks.
    pub(super) refresher: Option<tokio::task::JoinHandle<()>>,
}

impl Entry {
    /// The heartbeat run id of the current live phase: the lease id plus the
    /// lease epoch. Each create or resume is a new run, so a stale kill retry
    /// of an earlier phase never names it, and the Gateway's per-run tick
    /// watermark and ledger references start fresh.
    pub(super) fn run_id(&self) -> String {
        run_id_for(&self.lease_id, self.lease_epoch)
    }

    pub(super) fn target(&self) -> BoxTarget {
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

    pub(super) fn stop_refresher(&mut self) {
        if let Some(handle) = self.refresher.take() {
            handle.abort();
        }
    }
}

pub(super) fn run_id_for(lease_id: &str, lease_epoch: u64) -> String {
    format!("{lease_id}-e{lease_epoch}")
}

pub(super) type Slot = Arc<Mutex<Option<Entry>>>;

pub(super) fn registry() -> &'static StdMutex<HashMap<SessionBoxKey, Slot>> {
    static REGISTRY: OnceLock<StdMutex<HashMap<SessionBoxKey, Slot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(super) fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<SessionBoxKey, Slot>> {
    registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The slot for `key`, created empty when missing.
pub(super) fn slot_for(key: &SessionBoxKey) -> Slot {
    lock_registry()
        .entry(key.clone())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

pub(super) fn existing_slot(key: &SessionBoxKey) -> Option<Slot> {
    lock_registry().get(key).cloned()
}

/// Every registered key of one conversation, parent first, any owner.
pub(super) fn conversation_keys(conversation_id: &str) -> Vec<SessionBoxKey> {
    let mut keys: Vec<SessionBoxKey> = lock_registry()
        .keys()
        .filter(|key| key.conversation_id == conversation_id)
        .cloned()
        .collect();
    keys.sort();
    keys
}

/// Children that share their parent's Box because the cap refused their own.
pub(super) fn shared_children() -> &'static StdMutex<HashSet<SessionBoxKey>> {
    static SHARED: OnceLock<StdMutex<HashSet<SessionBoxKey>>> = OnceLock::new();
    SHARED.get_or_init(|| StdMutex::new(HashSet::new()))
}

pub(super) fn lock_shared() -> std::sync::MutexGuard<'static, HashSet<SessionBoxKey>> {
    shared_children()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The sub-agent child numbers in use, per `(owner, conversation)`.
pub(super) fn child_counters(
) -> &'static StdMutex<HashMap<(String, String), std::collections::BTreeSet<u32>>> {
    static COUNTERS: OnceLock<
        StdMutex<HashMap<(String, String), std::collections::BTreeSet<u32>>>,
    > = OnceLock::new();
    COUNTERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(super) fn lock_child_counters(
) -> std::sync::MutexGuard<'static, HashMap<(String, String), std::collections::BTreeSet<u32>>> {
    child_counters()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Most deleted conversations remembered; a delete races only with turns
/// still running in it, so an old tombstone is never needed.
pub(super) const MAX_TOMBSTONES: usize = 4096;

#[derive(Default)]
pub(super) struct Tombstones {
    pub(super) ids: HashSet<String>,
    pub(super) order: std::collections::VecDeque<String>,
}

/// Conversations deleted in this process. No session Box is acquired for
/// one again (a turn still running after the delete must not recreate it).
pub(super) fn tombstones() -> std::sync::MutexGuard<'static, Tombstones> {
    static TOMBSTONES: OnceLock<StdMutex<Tombstones>> = OnceLock::new();
    TOMBSTONES
        .get_or_init(|| StdMutex::new(Tombstones::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) fn tombstone(conversation_id: &str) {
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

pub(super) fn is_deleted(conversation_id: &str) -> bool {
    tombstones().ids.contains(conversation_id)
}

pub(super) fn deleted_error() -> ApiError {
    api_error(
        StatusCode::GONE,
        "session_box_conversation_deleted",
        "This conversation was deleted; its session Box is gone.",
    )
}

/// Leases whose create is in flight in this process. Recovery leaves them
/// alone: their `boxId` is not recorded yet, but they are not leftovers.
pub(super) fn creating_leases() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static CREATING: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    CREATING
        .get_or_init(|| StdMutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Marks a lease as being created until it is dropped.
pub(super) struct CreatingLease(String);

impl CreatingLease {
    pub(super) fn new(lease_id: &str) -> Self {
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
pub(super) fn relay_viewers() -> &'static StdMutex<HashMap<String, u32>> {
    static VIEWERS: OnceLock<StdMutex<HashMap<String, u32>>> = OnceLock::new();
    VIEWERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(super) fn relay_viewer_count(box_id: &str) -> u32 {
    relay_viewers()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(box_id)
        .copied()
        .unwrap_or(0)
}

pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(super) fn rfc3339(seconds: u64) -> Option<String> {
    chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, 0)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

pub(crate) fn api_error(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({"error":{"code":code,"message":message}})),
    )
}

pub(super) fn not_found() -> ApiError {
    api_error(
        StatusCode::NOT_FOUND,
        "session_box_not_found",
        "This conversation has no session Box.",
    )
}

pub(super) fn unavailable(message: &str) -> ApiError {
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

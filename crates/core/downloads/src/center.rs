//! The [`DownloadCenter`]: registry, broadcast, concurrency gate, and the one
//! stream-to-`.part` primitive every downloader routes through.
//!
//! Concurrency model: each download is driven by one long-lived tokio task that
//! lives for the whole *non-terminal* lifetime of the task. Pause/resume/cancel
//! are just messages on a `watch<Control>` channel that the driver observes
//! between chunks — so a parked (paused/failed) download always has a live
//! driver for the route handlers to talk to, and after a restart `load()`
//! re-spawns a parked driver per reloaded task. Only `Completed`/`Cancelled`
//! retire the driver.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use ryu_sidecar_runtime::layout;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, watch, Mutex, RwLock};

use super::{
    default_http_client, host, AutoTuner, ConcurrencyMode, DownloadEvent, DownloadKind,
    DownloadRole, DownloadSettings, DownloadSettingsView, DownloadSpec, DownloadState,
    DownloadTask, ThroughputSample, DEFAULT_SLOTS, MAX_SLOTS, MIN_SLOTS,
};

/// Write completely before replacing the accepted preference. A write/rename
/// failure leaves the previous file intact and removes only our own staging file.
fn persist_settings(path: &Path, settings: DownloadSettings) -> Result<()> {
    let json = serde_json::to_vec_pretty(&settings)?;
    write_file_atomically(path, &json)
}

/// Stage `bytes` in a sibling file, fsync, then rename over `path`. A crash or
/// write failure leaves the previous file intact (never a truncated JSON that a
/// later `load()` would silently discard), and removes only our staging file.
fn write_file_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    static NEXT_SAVE: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("download state file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let stem = path
        .file_name()
        .map_or_else(|| "state".into(), |name| name.to_string_lossy());
    let (staging, mut file) = loop {
        let sequence = NEXT_SAVE.fetch_add(1, Ordering::Relaxed);
        let staging = parent.join(format!(".{stem}-{}-{sequence}.tmp", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
        {
            Ok(file) => break (staging, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&staging, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result.map_err(Into::into)
}

/// The filesystem steps that install a verified `.part` at its destination.
/// Production uses [`StdInstallFs`]; the crate's tests wrap it to observe the
/// order of the steps and to inject failures.
pub(crate) trait InstallFs: Send + Sync {
    /// Flush a file's data and metadata to stable storage.
    fn sync_file(&self, path: &Path) -> std::io::Result<()>;
    /// Give the file at `original` a second name, `link`.
    fn hard_link(&self, original: &Path, link: &Path) -> std::io::Result<()>;
    /// Atomically replace `to` with `from`.
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    /// Flush a directory's entries, so a rename inside it survives power loss.
    fn sync_dir(&self, path: &Path) -> std::io::Result<()>;
    /// Remove a file name.
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
}

pub(crate) struct StdInstallFs;

impl InstallFs for StdInstallFs {
    fn sync_file(&self, path: &Path) -> std::io::Result<()> {
        // Write access, because Windows refuses to flush a read-only handle.
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)?
            .sync_all()
    }

    fn hard_link(&self, original: &Path, link: &Path) -> std::io::Result<()> {
        std::fs::hard_link(original, link)
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn sync_dir(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::fs::File::open(path)?.sync_all()
        }
        // Windows cannot open a directory for flushing without backup
        // semantics; NTFS journals the rename's metadata itself.
        #[cfg(not(unix))]
        {
            let _ = path;
            Ok(())
        }
    }
}

/// Max HTTP attempts per active streaming pass before a task is marked
/// `Failed{retryable}`. The `.part` is kept so a Retry resumes from offset.
const MAX_ATTEMPTS: u32 = 4;
const MAX_TRANSFER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Min interval between progress broadcasts per task (bytes still accrue every
/// chunk; we just don't flood SSE/persist on every read).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);
/// Bound on the TCP/TLS connect for each download hop. Neither client had any
/// deadline, so a black-holed host held a concurrency slot (and every
/// `download_blocking` caller) forever. Matches [`crate::default_http_client`].
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-read idle bound: the longest the response headers or the next body chunk
/// may take to arrive. This is NOT a total-transfer cap (a multi-GB model that
/// keeps streaming is never cut off). It catches a peer that accepts the
/// connection and then goes silent while keeping it alive, which TCP keepalive
/// cannot detect. A stall surfaces as a network error, so the bounded retry
/// resumes the `.part` with a Range request instead of pinning a concurrency
/// slot (and every `download_blocking` installer behind it) forever.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Control message sent to a driver. The displayed [`DownloadState`] is separate
/// (the driver re-arms this to `Pause` after a failed pass so it parks instead
/// of hot-looping).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Control {
    Run,
    Pause,
    Cancel,
}

/// Terminal result published for `download_blocking` awaiters.
type Term = Option<std::result::Result<PathBuf, String>>;

/// Per-task control handles held by the center for the task's whole life.
struct TaskCtl {
    control: watch::Sender<Control>,
    done: watch::Sender<Term>,
    /// The spec a byte-transfer driver runs its NEXT pass with (`None` for an
    /// indeterminate registration). Shared so a later caller that dedups onto a
    /// parked or failed task can hand it fresh integrity data — a task reloaded
    /// from `downloads.json` carries no checksum, and the caller's own spec must
    /// not be silently discarded in favour of that stripped one.
    spec: Option<Arc<std::sync::Mutex<DownloadSpec>>>,
    /// Parked because Core restarted mid-transfer (restored by `load()`), not
    /// because the user paused it. Only such a task is woken by a plain
    /// `download_blocking` caller; a user's Pause is never overridden.
    restored: bool,
    /// Monotonic registration stamp. Byte transfers dedup by id in [`DownloadCenter::spawn`],
    /// but an indeterminate registration cannot (its future's output type is the
    /// caller's, so a second caller can't be handed the first one's result) — it
    /// replaces the map entry instead. Without a stamp the FIRST of two same-id
    /// registrations to finish would then delete the SECOND one's live control
    /// handle, leaving a running install that Cancel silently no-ops on. Removal
    /// is therefore conditional on the stamp still being the caller's own.
    seq: u64,
}

/// A resizable concurrency gate.
///
/// `tokio::sync::Semaphore` can grow freely (`add_permits`) but can only shrink by
/// *reclaiming permits that are currently free* (`forget_permits`), so a request to
/// drop from 6 slots to 2 while 6 transfers are running can only take back what is
/// idle right now. Rather than block, the limiter records the target and reconciles
/// on every acquire and every tuner tick — permits are handed back as running
/// transfers finish, and the gate converges without ever stalling one.
struct Limiter {
    sem: Arc<tokio::sync::Semaphore>,
    /// Permits the semaphore is currently sized to.
    sized: AtomicUsize,
    /// Permits we want it sized to.
    desired: AtomicUsize,
}

impl Limiter {
    fn new(slots: usize) -> Self {
        let slots = slots.clamp(MIN_SLOTS, MAX_SLOTS);
        Self {
            sem: Arc::new(tokio::sync::Semaphore::new(slots)),
            sized: AtomicUsize::new(slots),
            desired: AtomicUsize::new(slots),
        }
    }

    fn set(&self, slots: usize) {
        self.desired
            .store(slots.clamp(MIN_SLOTS, MAX_SLOTS), Ordering::Relaxed);
        self.reconcile();
    }

    /// Slots in force right now (what the gate has actually reached).
    fn effective(&self) -> usize {
        self.sized.load(Ordering::Relaxed)
    }

    /// Move `sized` toward `desired` as far as the semaphore allows right now.
    fn reconcile(&self) {
        let want = self.desired.load(Ordering::Relaxed);
        let have = self.sized.load(Ordering::Relaxed);
        if want > have {
            self.sem.add_permits(want - have);
            self.sized.store(want, Ordering::Relaxed);
        } else if want < have {
            // Only the permits that are free right now come back; the rest are
            // reclaimed by a later reconcile once their transfer releases them.
            let reclaimed = self.sem.forget_permits(have - want);
            self.sized.fetch_sub(reclaimed, Ordering::Relaxed);
        }
    }

    async fn acquire(&self) -> tokio::sync::SemaphorePermit<'_> {
        self.reconcile();
        self.sem
            .acquire()
            .await
            .expect("download semaphore is never closed")
    }
}

struct Inner {
    tasks: RwLock<HashMap<String, DownloadTask>>,
    handles: Mutex<HashMap<String, TaskCtl>>,
    events: broadcast::Sender<DownloadEvent>,
    limiter: Limiter,
    /// The persisted preference plus the live tuner behind [`ConcurrencyMode::Auto`].
    settings: Mutex<SettingsState>,
    /// Whether the sampling loop has been started (lazily, on the first download,
    /// so constructing a center outside a Tokio runtime never panics).
    tuner_started: AtomicBool,
    /// The caller's client. Only the loopback tests send through it: production
    /// builds a guarded, DNS-pinned client for every hop in `stream_once`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "production fetches through a per-hop guarded client"
        )
    )]
    client: reqwest::Client,
    /// Per-read idle bound for transfers ([`STALL_TIMEOUT`]; tests shorten it).
    stall_timeout: Duration,
    /// Durable log of finished downloads (newest first), so "previous downloads"
    /// survives a restart even though live terminal tasks are dropped from the
    /// active registry. Persisted to `<data dir>/state/downloads-history.json`.
    history: Mutex<Vec<DownloadTask>>,
    /// Source of the [`TaskCtl::seq`] stamps.
    next_seq: AtomicU64,
    /// Serializes snapshot+write of `downloads.json` / `downloads-history.json`.
    /// Several drivers can change state at once; without this, concurrent
    /// writers could interleave, or an older snapshot could land after a newer
    /// one and resurrect stale state on the next restart.
    persist_lock: Mutex<()>,
    /// How a verified `.part` is made durable and moved into place.
    install_fs: Arc<dyn InstallFs>,
    /// Free bytes on the volume holding a path ([`crate::available_space_for`];
    /// tests inject a fixed value) for the pre-write disk-space preflight.
    disk_free: fn(&Path) -> Option<u64>,
    /// Test-only: park the next registry commit that matches, after its write
    /// guard is released, so a test can interleave a competing operation.
    #[cfg(test)]
    commit_park: std::sync::Mutex<Option<Arc<CommitPark>>>,
    /// Test-only: park the next [`DownloadCenter::snapshot_and_subscribe`]
    /// between its subscription and its snapshot, so a test can commit there.
    #[cfg(test)]
    snapshot_park: std::sync::Mutex<Option<Arc<CommitPark>>>,
}

/// Test-only: runs inside [`DownloadCenter::snapshot_and_subscribe`], after it
/// subscribes and before its snapshot is taken.
#[cfg(test)]
async fn snapshot_parked(inner: &Inner) {
    let park = inner.snapshot_park.lock().unwrap().take();
    if let Some(park) = park {
        let _ = park.reached.send(true);
        park.release
            .acquire()
            .await
            .expect("snapshot park semaphore is never closed")
            .forget();
    }
}

/// A one-shot test barrier on registry commits (see [`Inner::commit_park`]).
#[cfg(test)]
struct CommitPark {
    matches: Box<dyn Fn(&DownloadEvent) -> bool + Send + Sync>,
    reached: watch::Sender<bool>,
    release: tokio::sync::Semaphore,
}

/// Test-only: runs right after a registry commit's write guard is released.
#[cfg(test)]
async fn after_commit(inner: &Inner, event: &DownloadEvent) {
    let park = {
        let mut slot = inner.commit_park.lock().unwrap();
        match slot.as_ref() {
            Some(park) if (park.matches)(event) => slot.take(),
            _ => None,
        }
    };
    if let Some(park) = park {
        let _ = park.reached.send(true);
        park.release
            .acquire()
            .await
            .expect("commit park semaphore is never closed")
            .forget();
    }
}

/// Process-wide download registry. Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct DownloadCenter {
    inner: Arc<Inner>,
}

fn downloads_path() -> PathBuf {
    std::env::var("RYU_DOWNLOADS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| layout::state_path(&host().ryu_dir(), "downloads.json"))
}

/// Where the durable "previous downloads" log lives.
fn history_path() -> PathBuf {
    std::env::var("RYU_DOWNLOADS_HISTORY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| layout::state_path(&host().ryu_dir(), "downloads-history.json"))
}

/// Cap on retained history entries (newest kept). Bounds the file + response.
const HISTORY_CAP: usize = 200;

/// Where the concurrency preference lives.
fn settings_path() -> PathBuf {
    std::env::var("RYU_DOWNLOADS_SETTINGS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| layout::state_path(&host().ryu_dir(), "downloads-settings.json"))
}

/// How often the auto-tuner samples throughput. Long enough that a sample spans
/// several per-task speed updates (which refresh every 250 ms), short enough that
/// a slot change still lands inside a multi-minute model download.
const TUNE_INTERVAL: Duration = Duration::from_secs(5);

/// The operator pin, if `RYU_MAX_CONCURRENT_DOWNLOADS` is set. When present it
/// wins over the stored preference and the API refuses to overwrite it — an
/// operator who pinned the value in the environment should not have it silently
/// changed from a settings screen.
fn env_pinned_slots() -> Option<usize> {
    std::env::var("RYU_MAX_CONCURRENT_DOWNLOADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.clamp(MIN_SLOTS, MAX_SLOTS))
}

/// The preference plus the tuner state that serves [`ConcurrencyMode::Auto`].
struct SettingsState {
    settings: DownloadSettings,
    tuner: AutoTuner,
    /// Whether the on-disk preference has been folded in yet (see `new`).
    loaded: bool,
}

/// Read the stored preference, falling back to the default. An env pin overrides
/// it entirely (and presents as Manual).
fn load_settings() -> DownloadSettings {
    if let Some(pinned) = env_pinned_slots() {
        return DownloadSettings {
            mode: ConcurrencyMode::Manual,
            manual_slots: pinned,
        };
    }
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<DownloadSettings>(&raw).ok())
        .map(|s| DownloadSettings {
            mode: s.mode,
            manual_slots: s.manual_slots.clamp(MIN_SLOTS, MAX_SLOTS),
        })
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Stable id derived from the destination path — re-enqueueing the same artifact
/// dedups onto the in-flight task.
/// Fold a deduping caller's spec into the one a parked/queued driver will use
/// next. The caller is the authority on what it is installing (URL, label,
/// checksum, version record); an absent checksum or version record never erases
/// one the task already has.
fn adopt_spec(current: &mut DownloadSpec, incoming: DownloadSpec) {
    let DownloadSpec {
        kind,
        role,
        label,
        url,
        dest: _,
        sha256,
        version_record,
    } = incoming;
    current.kind = kind;
    current.role = role;
    current.label = label;
    current.url = url;
    if sha256.as_deref().is_some_and(|value| !value.is_empty()) {
        current.sha256 = sha256;
    }
    if version_record.is_some() {
        current.version_record = version_record;
    }
}

fn derive_id(dest: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(dest.to_string_lossy().as_bytes());
    format!("dl_{}", &hex::encode(hasher.finalize())[..16])
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// The second name an update gives the previous install until the new one is
/// durable.
fn previous_install_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".previous");
    PathBuf::from(s)
}

/// Drop the second name [`install_durably`] keeps for a previous install when a
/// crash left it behind. Beside an installed file it is only a stale extra link
/// that pins the old file's disk space; beside a missing install it may be the
/// only copy, so it is kept. Run at startup, before any install can be in
/// flight.
fn remove_stale_previous_installs<'a>(dests: impl IntoIterator<Item = &'a str>) {
    for dest in dests {
        let dest = Path::new(dest);
        let previous = previous_install_path(dest);
        if dest.is_file() && previous.is_file() {
            let _ = std::fs::remove_file(previous);
        }
    }
}

impl DownloadCenter {
    pub fn new(client: reqwest::Client) -> Self {
        let (events, _rx) = broadcast::channel(256);
        // Start from the env pin (which needs nothing) or the plain default. The
        // stored preference is read lazily on first use — `settings_path()` goes
        // through the host, and a center can legitimately be constructed before
        // one is installed.
        let initial = env_pinned_slots().unwrap_or(DEFAULT_SLOTS);
        let settings = DownloadSettings {
            mode: match env_pinned_slots() {
                Some(_) => ConcurrencyMode::Manual,
                None => ConcurrencyMode::Auto,
            },
            manual_slots: initial,
        };
        Self {
            inner: Arc::new(Inner {
                tasks: RwLock::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
                events,
                limiter: Limiter::new(initial),
                settings: Mutex::new(SettingsState {
                    settings,
                    tuner: AutoTuner::new(initial),
                    loaded: false,
                }),
                tuner_started: AtomicBool::new(false),
                client,
                stall_timeout: STALL_TIMEOUT,
                history: Mutex::new(Vec::new()),
                next_seq: AtomicU64::new(1),
                persist_lock: Mutex::new(()),
                install_fs: Arc::new(StdInstallFs),
                disk_free: crate::disk::available_space_for,
                #[cfg(test)]
                commit_park: std::sync::Mutex::new(None),
                #[cfg(test)]
                snapshot_park: std::sync::Mutex::new(None),
            }),
        }
    }

    /// A center whose install step runs through `install_fs` (tests only).
    #[cfg(test)]
    fn with_install_fs(client: reqwest::Client, install_fs: Arc<dyn InstallFs>) -> Self {
        let mut center = Self::new(client);
        Arc::get_mut(&mut center.inner)
            .expect("a fresh center is not shared")
            .install_fs = install_fs;
        center
    }

    /// Park the next registry commit whose event matches, after its write guard
    /// is released, until the returned handle is released (tests only).
    #[cfg(test)]
    fn park_after_commit(
        &self,
        matches: impl Fn(&DownloadEvent) -> bool + Send + Sync + 'static,
    ) -> Arc<CommitPark> {
        let park = Arc::new(CommitPark {
            matches: Box::new(matches),
            reached: watch::channel(false).0,
            release: tokio::sync::Semaphore::new(0),
        });
        *self.inner.commit_park.lock().unwrap() = Some(Arc::clone(&park));
        park
    }

    /// Park the next [`Self::snapshot_and_subscribe`] between its subscription
    /// and its snapshot until the returned handle is released (tests only).
    #[cfg(test)]
    fn park_next_snapshot(&self) -> Arc<CommitPark> {
        let park = Arc::new(CommitPark {
            matches: Box::new(|_| true),
            reached: watch::channel(false).0,
            release: tokio::sync::Semaphore::new(0),
        });
        *self.inner.snapshot_park.lock().unwrap() = Some(Arc::clone(&park));
        park
    }

    /// Convenience constructor using the standard ryu HTTP client.
    pub fn with_default_client() -> Self {
        Self::new(default_http_client())
    }

    /// Shorten the per-read stall bound so a test can exercise it quickly.
    #[cfg(test)]
    fn with_stall_timeout(mut self, stall_timeout: Duration) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("set the stall bound before the center is shared")
            .stall_timeout = stall_timeout;
        self
    }

    /// Report a fixed free-space figure to the disk preflight (tests only).
    #[cfg(test)]
    fn with_disk_probe(mut self, disk_free: fn(&Path) -> Option<u64>) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("set the disk probe before the center is shared")
            .disk_free = disk_free;
        self
    }

    /// Subscribe to live download deltas (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<DownloadEvent> {
        self.inner.events.subscribe()
    }

    /// The registry as of one commit, plus a receiver that delivers exactly
    /// the commits after it. A stream that starts with this snapshot and then
    /// forwards the receiver neither replays a commit the snapshot already
    /// holds nor misses one (the SSE routes).
    pub async fn snapshot_and_subscribe(
        &self,
    ) -> (Vec<DownloadTask>, broadcast::Receiver<DownloadEvent>) {
        // Every commit publishes while it holds the registry write lock, so
        // under the read lock no commit can land between the two steps.
        let tasks = self.inner.tasks.read().await;
        let rx = self.subscribe();
        #[cfg(test)]
        snapshot_parked(&self.inner).await;
        let mut out: Vec<DownloadTask> = tasks.values().cloned().collect();
        drop(tasks);
        out.sort_by_key(|t| t.created_at);
        (out, rx)
    }

    // ── Concurrency settings ──────────────────────────────────────────────────

    /// Fold the on-disk preference in the first time it is needed, and apply it.
    async fn ensure_settings_loaded(&self) {
        let mut state = self.inner.settings.lock().await;
        if state.loaded {
            return;
        }
        state.loaded = true;
        state.settings = load_settings();
        if state.settings.mode == ConcurrencyMode::Manual {
            self.inner.limiter.set(state.settings.manual_slots);
            state.tuner = AutoTuner::new(state.settings.manual_slots);
        }
    }

    /// The current preference plus what it resolves to right now.
    pub async fn settings(&self) -> DownloadSettingsView {
        self.ensure_settings_loaded().await;
        let state = self.inner.settings.lock().await;
        DownloadSettingsView {
            mode: state.settings.mode,
            manual_slots: state.settings.manual_slots,
            effective_slots: self.inner.limiter.effective(),
            min_slots: MIN_SLOTS,
            max_slots: MAX_SLOTS,
            measured_bps: state.tuner.measured_bps(),
            env_locked: env_pinned_slots().is_some(),
        }
    }

    /// Change how many downloads run at once. `slots` is ignored (and retained
    /// unchanged) in [`ConcurrencyMode::Auto`]. Returns the resulting view, or an
    /// error when the value is pinned by the environment.
    pub async fn set_settings(
        &self,
        mode: ConcurrencyMode,
        slots: Option<usize>,
    ) -> Result<DownloadSettingsView> {
        if env_pinned_slots().is_some() {
            anyhow::bail!(
                "download concurrency is pinned by RYU_MAX_CONCURRENT_DOWNLOADS; \
                 unset it to change this from the app"
            );
        }
        self.ensure_settings_loaded().await;
        // Serialize durable acceptance and live publication under the same
        // settings lock. A refused save must not resize the running gate.
        let mut state = self.inner.settings.lock().await;
        let mut next = state.settings;
        next.mode = mode;
        if let Some(n) = slots {
            next.manual_slots = n.clamp(MIN_SLOTS, MAX_SLOTS);
        }
        let path = settings_path();
        tokio::task::spawn_blocking(move || persist_settings(&path, next)).await??;
        state.settings = next;
        match mode {
            ConcurrencyMode::Manual => {
                self.inner.limiter.set(next.manual_slots);
                state.tuner = AutoTuner::new(next.manual_slots);
            }
            ConcurrencyMode::Auto => self.inner.limiter.set(state.tuner.slots()),
        }
        drop(state);
        Ok(self.settings().await)
    }

    /// Start the throughput sampling loop once, on the first download. Deferred
    /// (rather than done in `new`) so building a center outside a Tokio runtime —
    /// which several callers do — never panics on `tokio::spawn`.
    fn ensure_tuner_running(&self) {
        if self.inner.tuner_started.swap(true, Ordering::Relaxed) {
            return;
        }
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(TUNE_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                // Arc::strong_count == 1 ⇒ only this loop holds the center; the
                // owner is gone, so stop rather than tick forever.
                if Arc::strong_count(&inner) == 1 {
                    return;
                }
                let sample = {
                    let tasks = inner.tasks.read().await;
                    let mut aggregate_bps = 0u64;
                    let mut active = 0usize;
                    let mut queued = 0usize;
                    for t in tasks.values() {
                        match t.state {
                            DownloadState::Active => {
                                active += 1;
                                aggregate_bps += t.speed_bps.unwrap_or(0);
                            }
                            DownloadState::Queued => queued += 1,
                            _ => {}
                        }
                    }
                    ThroughputSample {
                        aggregate_bps,
                        active,
                        queued,
                    }
                };
                let mut state = inner.settings.lock().await;
                if state.settings.mode == ConcurrencyMode::Auto {
                    let slots = state.tuner.observe(sample);
                    inner.limiter.set(slots);
                } else {
                    inner.limiter.reconcile();
                }
            }
        });
    }

    /// Snapshot of all tasks, ordered by creation (stable for the UI).
    pub async fn snapshot(&self) -> Vec<DownloadTask> {
        let tasks = self.inner.tasks.read().await;
        let mut out: Vec<DownloadTask> = tasks.values().cloned().collect();
        out.sort_by_key(|t| t.created_at);
        out
    }

    /// Start (or dedup onto) a download. Returns the task id immediately; the
    /// transfer runs on a background driver. Progress/terminal state is observed
    /// via `subscribe()` or `download_blocking`.
    pub async fn enqueue(&self, spec: DownloadSpec) -> String {
        self.spawn(spec, false, false).await.0
    }

    /// Start a download and await its terminal state, returning the installed
    /// path. Equivalent to the old synchronous downloader call, but with live
    /// progress + pause/resume/cancel while the caller awaits. The transfer runs
    /// on a background driver, so it survives the caller's request being dropped.
    ///
    /// A task restored as `Paused` after a Core restart is woken: the caller is
    /// waiting on this file now, and subscribing to that parked driver would
    /// never resolve. A task the USER paused stays paused — a background caller
    /// must not silently resume a download the user stopped.
    pub async fn download_blocking(&self, spec: DownloadSpec) -> Result<PathBuf> {
        let (_id, mut done_rx) = self.spawn(spec, false, false).await;
        loop {
            if let Some(result) = done_rx.borrow_and_update().clone() {
                return result.map_err(|e| anyhow::anyhow!(e));
            }
            if done_rx.changed().await.is_err() {
                anyhow::bail!("download driver dropped before completing");
            }
        }
    }

    /// Start or explicitly resume a download and await its terminal state.
    ///
    /// This is the install-path variant of [`Self::download_blocking`]. A task
    /// restored from `downloads.json` is intentionally parked after a Core
    /// restart; an explicit Install action must wake that parked task instead
    /// of deduplicating onto a receiver that can never complete.
    pub async fn resume_and_download_blocking(&self, spec: DownloadSpec) -> Result<PathBuf> {
        // `spawn` wakes the parked task itself, clearing its previous result
        // BEFORE subscribing. Resuming afterwards raced the driver: the caller
        // usually read the old failure before the driver cleared it.
        let (_id, mut done_rx) = self.spawn(spec, false, true).await;
        loop {
            if let Some(result) = done_rx.borrow_and_update().clone() {
                return result.map_err(|e| anyhow::anyhow!(e));
            }
            if done_rx.changed().await.is_err() {
                anyhow::bail!("download driver dropped before completing");
            }
        }
    }

    pub async fn pause(&self, id: &str) -> bool {
        // An explicit Pause makes the parked state the user's, so a later
        // `download_blocking` caller no longer wakes it.
        if let Some(handle) = self.inner.handles.lock().await.get_mut(id) {
            handle.restored = false;
        }
        self.signal(id, Control::Pause).await
    }

    pub async fn resume(&self, id: &str) -> bool {
        self.signal(id, Control::Run).await
    }

    /// Retry a failed download — resumes from the kept `.part` (same as resume).
    pub async fn retry(&self, id: &str) -> bool {
        self.signal(id, Control::Run).await
    }

    pub async fn cancel(&self, id: &str) -> bool {
        self.signal(id, Control::Cancel).await
    }

    /// Remove a terminal task entry from the registry (a "dismiss" in the UI).
    /// No-op for non-terminal tasks (cancel those first).
    pub async fn clear(&self, id: &str) -> bool {
        // Hold the handles lock across the whole dismissal. A reinstall of the
        // same artifact registers its handle and row under this lock too, so it
        // runs strictly before (and the row is no longer dismissable) or after
        // (and its handle and Queued row follow the Removed event).
        let mut handles = self.inner.handles.lock().await;
        let removed = {
            let mut tasks = self.inner.tasks.write().await;
            match tasks.get(id) {
                Some(t) if t.state.is_terminal() || t.state == DownloadState::Failed => {
                    tasks.remove(id);
                    let _ = self
                        .inner
                        .events
                        .send(DownloadEvent::Removed { id: id.to_string() });
                    true
                }
                _ => false,
            }
        };
        if removed {
            #[cfg(test)]
            after_commit(&self.inner, &DownloadEvent::Removed { id: id.to_string() }).await;
            handles.remove(id);
            drop(handles);
            self.persist().await;
        }
        removed
    }

    /// Track a download that produces NO byte progress (a subprocess install:
    /// npm/pip/cargo/shell, or a multi-file fetch like skills). The task appears
    /// in the overlay as indeterminate (`total_bytes: None`) in the `Active` state
    /// while `fut` runs, then `Completed`/`Failed`. A `cancel` aborts `fut` (drop
    /// kills a `kill_on_drop` child) and returns an error — callers MUST record any
    /// version/installed marker strictly AFTER `fut` succeeds so a mid-install
    /// cancel leaves no false-installed state.
    ///
    /// Runs `fut` on the caller's task (no spawn), so `fut` need not be `Send`.
    ///
    /// The role defaults from `kind`; use [`Self::register_indeterminate_as`] when
    /// the call site knows something more specific (an unpack step, an image model).
    pub async fn register_indeterminate<F, T>(
        &self,
        id: String,
        kind: DownloadKind,
        label: String,
        fut: F,
    ) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        self.register_indeterminate_as(id, kind, DownloadRole::from_kind(kind), label, fut)
            .await
    }

    /// [`Self::register_indeterminate`] with an explicit [`DownloadRole`].
    pub async fn register_indeterminate_as<F, T>(
        &self,
        id: String,
        kind: DownloadKind,
        role: DownloadRole,
        label: String,
        fut: F,
    ) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        let now = now_ms();
        let task = DownloadTask {
            id: id.clone(),
            kind,
            role,
            label,
            url: None,
            dest_path: None,
            total_bytes: None,
            received_bytes: 0,
            state: DownloadState::Active,
            error: None,
            retryable: false,
            speed_bps: None,
            created_at: now,
            updated_at: now,
            etag: None,
            sha256: None,
        };
        let (control_tx, mut control_rx) = watch::channel(Control::Run);
        let (done_tx, _done_rx) = watch::channel::<Term>(None);
        let seq = self.inner.next_seq.fetch_add(1, Ordering::Relaxed);
        {
            // Handle and row land together, so a finishing same-id registration
            // sees this one as the owner of both.
            let mut handles = self.inner.handles.lock().await;
            handles.insert(
                id.clone(),
                TaskCtl {
                    control: control_tx,
                    done: done_tx,
                    spec: None,
                    restored: false,
                    seq,
                },
            );
            put_task_inner(&self.inner, task).await;
        }

        // Race the install future against a cancel signal. On cancel `fut` is
        // dropped (killing any kill_on_drop child).
        let cancelled = async {
            loop {
                if *control_rx.borrow_and_update() == Control::Cancel {
                    return;
                }
                if control_rx.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::pin!(fut);
        let outcome = tokio::select! {
            biased;
            _ = cancelled => None,
            r = &mut fut => Some(r),
        };

        // Only retire OUR registration — a later same-id registration owns the map
        // entry and the row now: dropping its handle would strand a running
        // install with no Cancel, and finishing its row would report a running
        // install as done.
        let (state, error) = match &outcome {
            Some(Ok(_)) => (DownloadState::Completed, None),
            Some(Err(e)) => (DownloadState::Failed, Some(format!("{e:#}"))),
            None => (DownloadState::Cancelled, None),
        };
        let owned = {
            let mut handles = self.inner.handles.lock().await;
            let owned = handles.get(&id).is_some_and(|h| h.seq == seq);
            if owned {
                handles.remove(&id);
                patch(&self.inner, &id, false, |t| {
                    t.state = state;
                    if let Some(message) = error {
                        t.error = Some(message);
                        t.retryable = true;
                    }
                })
                .await;
            }
            owned
        };
        if owned {
            persist_inner(&self.inner).await;
        }
        match outcome {
            Some(result) => result,
            None => anyhow::bail!("cancelled"),
        }
    }

    async fn signal(&self, id: &str, ctl: Control) -> bool {
        let handles = self.inner.handles.lock().await;
        match handles.get(id) {
            Some(h) => h.control.send(ctl).is_ok(),
            None => false,
        }
    }

    /// Register + drive a download. `start_paused` is used by `load()` to bring a
    /// reloaded task up in the parked `Paused` state (awaiting an explicit resume).
    /// Dedups: a re-enqueue of a non-terminal task returns the existing done-handle.
    ///
    /// Deduping onto a FAILED task restarts it with the caller's spec: the driver
    /// parks after a failure, so subscribing to it as-is replayed the old error to
    /// every later install until someone pressed Retry in the UI. `wake_parked`
    /// also restarts a `Paused` task (an explicit install of a reloaded one).
    async fn spawn(
        &self,
        spec: DownloadSpec,
        start_paused: bool,
        wake_parked: bool,
    ) -> (String, watch::Receiver<Term>) {
        let id = derive_id(&spec.dest);
        self.ensure_settings_loaded().await;
        self.ensure_tuner_running();

        {
            let mut handles = self.inner.handles.lock().await;
            if let Some(existing) = handles.get(&id) {
                let state = self.inner.tasks.read().await.get(&id).map(|t| t.state);
                // A Cancelled task's driver may still be retiring; a reinstall
                // must start afresh rather than inherit its cancellation.
                if !state.is_some_and(|state| state.is_terminal()) {
                    // Already in flight (or parked) — dedup onto it.
                    if let Some(shared) = &existing.spec {
                        adopt_spec(&mut shared.lock().unwrap_or_else(|e| e.into_inner()), spec);
                        let restart = state == Some(DownloadState::Failed)
                            || (state == Some(DownloadState::Paused)
                                && (wake_parked || existing.restored));
                        if restart {
                            // Clear the old result before subscribing so this
                            // caller can only observe the restarted pass.
                            existing.done.send_replace(None);
                            let _ = existing.control.send(Control::Run);
                        }
                    }
                    return (id, existing.done.subscribe());
                }
            }

            let initial_state = if start_paused {
                DownloadState::Paused
            } else {
                DownloadState::Queued
            };
            let initial_control = if start_paused {
                Control::Pause
            } else {
                Control::Run
            };

            let (control_tx, control_rx) = watch::channel(initial_control);
            let (done_tx, done_rx) = watch::channel::<Term>(None);
            let shared_spec = Arc::new(std::sync::Mutex::new(spec.clone()));

            // Carry forward any received bytes already on disk (.part) so the UI
            // shows the resumable offset before the driver re-attaches.
            let received = tokio::fs::metadata(part_path(&spec.dest))
                .await
                .map(|m| m.len())
                .unwrap_or(0);

            let task = DownloadTask {
                id: id.clone(),
                kind: spec.kind,
                role: spec.role,
                label: spec.label.clone(),
                url: Some(spec.url.clone()),
                dest_path: Some(spec.dest.to_string_lossy().to_string()),
                total_bytes: None,
                received_bytes: received,
                state: initial_state,
                error: None,
                retryable: false,
                speed_bps: None,
                created_at: now_ms(),
                updated_at: now_ms(),
                etag: None,
                sha256: spec.sha256.clone().filter(|value| !value.is_empty()),
            };

            let seq = self.inner.next_seq.fetch_add(1, Ordering::Relaxed);
            handles.insert(
                id.clone(),
                TaskCtl {
                    control: control_tx.clone(),
                    done: done_tx.clone(),
                    spec: Some(Arc::clone(&shared_spec)),
                    restored: start_paused,
                    seq,
                },
            );
            // The handle and its row land together under the handles lock, so a
            // concurrent `clear` sees either both or neither.
            self.put_task(task).await;
            drop(handles);
            self.persist().await;

            let inner = Arc::clone(&self.inner);
            let drv_id = id.clone();
            tokio::spawn(async move {
                drive(
                    inner,
                    drv_id,
                    seq,
                    shared_spec,
                    control_tx,
                    control_rx,
                    done_tx,
                )
                .await;
            });

            (id, done_rx)
        }
    }

    // ── registry mutation helpers ──────────────────────────────────────────

    async fn put_task(&self, task: DownloadTask) {
        put_task_inner(&self.inner, task).await;
    }

    /// Snapshot persistable tasks to `<data dir>/state/downloads.json`. Called on state
    /// transitions only — never per progress chunk.
    async fn persist(&self) {
        persist_inner(&self.inner).await;
    }

    /// Reload persisted tasks at startup and reconcile against orphan `.part`
    /// files: a task that was `Active` when the process died comes back `Paused`
    /// (interrupted) so the user/desktop can resume from offset. Auto-resumes when
    /// `RYU_DOWNLOADS_AUTORESUME=1`.
    /// The durable "previous downloads" log, newest first.
    pub async fn history(&self) -> Vec<DownloadTask> {
        self.inner.history.lock().await.clone()
    }

    /// Empty the durable history log, and the file behind it. Returns how many
    /// entries were dropped.
    ///
    /// Clearing a finished download with [`Self::clear`] only removes it from the
    /// ACTIVE registry — the copy `record_history` already wrote survives, and is
    /// what the downloads page's History section reads. Without this, "clear
    /// finished" could empty the tray popover and leave the page's list exactly as
    /// it was, so the history was permanently un-clearable by any UI.
    pub async fn clear_history(&self) -> usize {
        let _persisting = self.inner.persist_lock.lock().await;
        let dropped = {
            let mut hist = self.inner.history.lock().await;
            let n = hist.len();
            hist.clear();
            n
        };
        let path = history_path();
        let _ = tokio::task::spawn_blocking(move || write_file_atomically(&path, b"[]")).await;
        dropped
    }

    pub async fn load(&self) {
        // Restore the durable history log first (independent of the resumable
        // active tasks below).
        if let Ok(raw) = std::fs::read_to_string(history_path()) {
            let hist: Vec<DownloadTask> = serde_json::from_str(&raw).unwrap_or_default();
            remove_stale_previous_installs(hist.iter().filter_map(|t| t.dest_path.as_deref()));
            *self.inner.history.lock().await = hist;
        }

        let raw = match std::fs::read_to_string(downloads_path()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let persisted: Vec<DownloadTask> = serde_json::from_str(&raw).unwrap_or_default();
        remove_stale_previous_installs(persisted.iter().filter_map(|t| t.dest_path.as_deref()));
        let autoresume = std::env::var("RYU_DOWNLOADS_AUTORESUME").as_deref() == Ok("1");

        for task in persisted {
            let Some(url) = task.url.clone() else {
                continue;
            };
            let Some(dest_str) = task.dest_path.clone() else {
                continue;
            };
            let dest = PathBuf::from(dest_str);
            // Drop entries whose `.part` is gone — nothing to resume.
            if tokio::fs::metadata(part_path(&dest)).await.is_err() && !dest.exists() {
                continue;
            }
            let spec = DownloadSpec {
                kind: task.kind,
                role: task.role,
                label: task.label.clone(),
                url,
                dest,
                sha256: task.sha256.clone(),
                version_record: None,
            };
            let (id, _rx) = self.spawn(spec, true, false).await;
            // Keep the validator so the resumed Range request still sends
            // `If-Range`: without it a changed upstream file is spliced onto the
            // old `.part` instead of restarting cleanly.
            if task.etag.is_some() {
                let etag = task.etag.clone();
                patch(&self.inner, &id, false, |t| t.etag = etag).await;
            }
            if autoresume {
                self.resume(&id).await;
            }
        }
    }
}

mod persist;
mod stream;
mod transfer;

use persist::*;
use stream::*;
use transfer::*;

#[cfg(test)]
mod tests;

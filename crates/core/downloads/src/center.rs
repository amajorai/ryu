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
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, watch, Mutex, RwLock};

use super::{
    default_http_client, host, DownloadEvent, DownloadKind, DownloadSpec, DownloadState,
    DownloadTask,
};

/// Max HTTP attempts per active streaming pass before a task is marked
/// `Failed{retryable}`. The `.part` is kept so a Retry resumes from offset.
const MAX_ATTEMPTS: u32 = 4;
/// Min interval between progress broadcasts per task (bytes still accrue every
/// chunk; we just don't flood SSE/persist on every read).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);

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
}

struct Inner {
    tasks: RwLock<HashMap<String, DownloadTask>>,
    handles: Mutex<HashMap<String, TaskCtl>>,
    events: broadcast::Sender<DownloadEvent>,
    sem: Arc<tokio::sync::Semaphore>,
    client: reqwest::Client,
    /// Durable log of finished downloads (newest first), so "previous downloads"
    /// survives a restart even though live terminal tasks are dropped from the
    /// active registry. Persisted to `~/.ryu/downloads-history.json`.
    history: Mutex<Vec<DownloadTask>>,
}

/// Process-wide download registry. Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct DownloadCenter {
    inner: Arc<Inner>,
}

fn downloads_path() -> PathBuf {
    std::env::var("RYU_DOWNLOADS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| host().ryu_dir().join("downloads.json"))
}

/// Where the durable "previous downloads" log lives.
fn history_path() -> PathBuf {
    std::env::var("RYU_DOWNLOADS_HISTORY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| host().ryu_dir().join("downloads-history.json"))
}

/// Cap on retained history entries (newest kept). Bounds the file + response.
const HISTORY_CAP: usize = 200;

fn max_concurrency() -> usize {
    std::env::var("RYU_MAX_CONCURRENT_DOWNLOADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(3)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Stable id derived from the destination path — re-enqueueing the same artifact
/// dedups onto the in-flight task.
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

impl DownloadCenter {
    pub fn new(client: reqwest::Client) -> Self {
        let (events, _rx) = broadcast::channel(256);
        Self {
            inner: Arc::new(Inner {
                tasks: RwLock::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
                events,
                sem: Arc::new(tokio::sync::Semaphore::new(max_concurrency())),
                client,
                history: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Convenience constructor using the standard ryu HTTP client.
    pub fn with_default_client() -> Self {
        Self::new(default_http_client())
    }

    /// Subscribe to live download deltas (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<DownloadEvent> {
        self.inner.events.subscribe()
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
        self.spawn(spec, false).await.0
    }

    /// Start a download and await its terminal state, returning the installed
    /// path. Equivalent to the old synchronous downloader call, but with live
    /// progress + pause/resume/cancel while the caller awaits. The transfer runs
    /// on a background driver, so it survives the caller's request being dropped.
    pub async fn download_blocking(&self, spec: DownloadSpec) -> Result<PathBuf> {
        let (_id, mut done_rx) = self.spawn(spec, false).await;
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
        let removed = {
            let mut tasks = self.inner.tasks.write().await;
            match tasks.get(id) {
                Some(t) if t.state.is_terminal() || t.state == DownloadState::Failed => {
                    tasks.remove(id);
                    true
                }
                _ => false,
            }
        };
        if removed {
            self.inner.handles.lock().await.remove(id);
            self.persist().await;
            let _ = self
                .inner
                .events
                .send(DownloadEvent::Removed { id: id.to_string() });
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
        let now = now_ms();
        let task = DownloadTask {
            id: id.clone(),
            kind,
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
        };
        let (control_tx, mut control_rx) = watch::channel(Control::Run);
        let (done_tx, _done_rx) = watch::channel::<Term>(None);
        {
            let mut handles = self.inner.handles.lock().await;
            handles.insert(
                id.clone(),
                TaskCtl {
                    control: control_tx,
                    done: done_tx,
                },
            );
        }
        put_task_inner(&self.inner, task).await;

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

        self.inner.handles.lock().await.remove(&id);
        match outcome {
            Some(Ok(value)) => {
                patch(&self.inner, &id, false, |t| {
                    t.state = DownloadState::Completed;
                })
                .await;
                persist_inner(&self.inner).await;
                Ok(value)
            }
            Some(Err(e)) => {
                let msg = format!("{e:#}");
                patch(&self.inner, &id, false, |t| {
                    t.state = DownloadState::Failed;
                    t.error = Some(msg);
                    t.retryable = true;
                })
                .await;
                persist_inner(&self.inner).await;
                Err(e)
            }
            None => {
                patch(&self.inner, &id, false, |t| {
                    t.state = DownloadState::Cancelled;
                })
                .await;
                persist_inner(&self.inner).await;
                anyhow::bail!("cancelled")
            }
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
    async fn spawn(
        &self,
        spec: DownloadSpec,
        start_paused: bool,
    ) -> (String, watch::Receiver<Term>) {
        let id = derive_id(&spec.dest);

        {
            let mut handles = self.inner.handles.lock().await;
            if let Some(existing) = handles.get(&id) {
                let tasks = self.inner.tasks.read().await;
                let terminal = tasks
                    .get(&id)
                    .map(|t| t.state == DownloadState::Completed)
                    .unwrap_or(false);
                if !terminal {
                    // Already in flight (or parked) — dedup onto it.
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

            // Carry forward any received bytes already on disk (.part) so the UI
            // shows the resumable offset before the driver re-attaches.
            let received = tokio::fs::metadata(part_path(&spec.dest))
                .await
                .map(|m| m.len())
                .unwrap_or(0);

            let task = DownloadTask {
                id: id.clone(),
                kind: spec.kind,
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
            };

            handles.insert(
                id.clone(),
                TaskCtl {
                    control: control_tx.clone(),
                    done: done_tx.clone(),
                },
            );
            drop(handles);

            self.put_task(task).await;
            self.persist().await;

            let inner = Arc::clone(&self.inner);
            let drv_id = id.clone();
            tokio::spawn(async move {
                drive(inner, drv_id, spec, control_tx, control_rx, done_tx).await;
            });

            return (id, done_rx);
        }
    }

    // ── registry mutation helpers ──────────────────────────────────────────

    async fn put_task(&self, task: DownloadTask) {
        put_task_inner(&self.inner, task).await;
    }

    /// Snapshot persistable tasks to `~/.ryu/downloads.json`. Called on state
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

    pub async fn load(&self) {
        // Restore the durable history log first (independent of the resumable
        // active tasks below).
        if let Ok(raw) = std::fs::read_to_string(history_path()) {
            let hist: Vec<DownloadTask> = serde_json::from_str(&raw).unwrap_or_default();
            *self.inner.history.lock().await = hist;
        }

        let raw = match std::fs::read_to_string(downloads_path()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let persisted: Vec<DownloadTask> = serde_json::from_str(&raw).unwrap_or_default();
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
                label: task.label.clone(),
                url,
                dest,
                sha256: None,
                version_record: None,
            };
            let (id, _rx) = self.spawn(spec, true).await;
            if autoresume {
                self.resume(&id).await;
            }
        }
    }
}

// ── free helpers operating on Inner (so the driver task can call them) ──────

async fn put_task_inner(inner: &Inner, task: DownloadTask) {
    {
        let mut tasks = inner.tasks.write().await;
        tasks.insert(task.id.clone(), task.clone());
    }
    let _ = inner.events.send(DownloadEvent::Update { task });
}

/// Mutate one task, bump `updated_at`, broadcast the delta, and (optionally)
/// persist. Per-chunk progress passes `persist = false`.
async fn patch(inner: &Inner, id: &str, persist: bool, f: impl FnOnce(&mut DownloadTask)) {
    let updated = {
        let mut tasks = inner.tasks.write().await;
        let Some(task) = tasks.get_mut(id) else {
            return;
        };
        f(task);
        task.updated_at = now_ms();
        task.clone()
    };
    let _ = inner.events.send(DownloadEvent::Update { task: updated });
    if persist {
        persist_inner(inner).await;
    }
}

async fn persist_inner(inner: &Inner) {
    let to_save: Vec<DownloadTask> = {
        let tasks = inner.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.state.is_persistable())
            .cloned()
            .collect()
    };
    let path = downloads_path();
    // Tiny file; a blocking write off the async path keeps it simple.
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&to_save) {
            let _ = std::fs::write(&path, json);
        }
    })
    .await;
}

/// Append a finished download to the durable history log (newest first),
/// de-duping by id so a re-download replaces its prior entry, then persist the
/// capped list. Called when a task reaches a terminal state (Completed /
/// Cancelled) — the only ones that leave the active registry.
async fn record_history(inner: &Inner, task: &DownloadTask) {
    let to_save = {
        let mut hist = inner.history.lock().await;
        hist.retain(|t| t.id != task.id);
        hist.insert(0, task.clone());
        hist.truncate(HISTORY_CAP);
        hist.clone()
    };
    let path = history_path();
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&to_save) {
            let _ = std::fs::write(&path, json);
        }
    })
    .await;
}

// ── the driver ──────────────────────────────────────────────────────────────

enum AttemptOutcome {
    Done(PathBuf),
    Paused,
    Cancelled,
    Failed { error: String, retryable: bool },
}

enum StreamResult {
    Done,
    Paused,
    Cancelled,
}

enum StreamErr {
    /// Transient (network) — keep the `.part` and retry with Range.
    Network(String),
    /// Fatal (disk full, bad path) — not resumable.
    Io(String),
}

async fn drive(
    inner: Arc<Inner>,
    id: String,
    spec: DownloadSpec,
    control_tx: watch::Sender<Control>,
    mut control_rx: watch::Receiver<Control>,
    done_tx: watch::Sender<Term>,
) {
    loop {
        // PARK: wait until Run; exit on Cancel. Copy the value out so the
        // (non-Send) watch guard never lives across the awaits below.
        loop {
            let ctl = *control_rx.borrow_and_update();
            match ctl {
                Control::Run => break,
                Control::Cancel => {
                    cleanup_cancelled(&inner, &id, &spec, &done_tx).await;
                    return;
                }
                Control::Pause => {}
            }
            if control_rx.changed().await.is_err() {
                return; // center dropped — process shutting down
            }
        }

        // FAST PATH: already installed with a matching checksum → Completed.
        if let Some(path) = fast_path(&spec).await {
            finish_completed(&inner, &id, &spec, &done_tx, path).await;
            return;
        }

        // Acquire a concurrency slot only while actively streaming.
        patch(&inner, &id, true, |t| {
            t.state = DownloadState::Active;
            t.error = None;
        })
        .await;
        let _permit = inner.sem.acquire().await;

        match attempt(&inner, &id, &spec, &mut control_rx).await {
            AttemptOutcome::Done(path) => {
                drop(_permit);
                finish_completed(&inner, &id, &spec, &done_tx, path).await;
                return;
            }
            AttemptOutcome::Cancelled => {
                drop(_permit);
                cleanup_cancelled(&inner, &id, &spec, &done_tx).await;
                return;
            }
            AttemptOutcome::Paused => {
                drop(_permit);
                patch(&inner, &id, true, |t| {
                    t.state = DownloadState::Paused;
                    t.speed_bps = None;
                })
                .await;
                // control is already Pause (the user set it) → PARK re-parks.
                continue;
            }
            AttemptOutcome::Failed { error, retryable } => {
                drop(_permit);
                patch(&inner, &id, true, |t| {
                    t.state = DownloadState::Failed;
                    t.error = Some(error);
                    t.retryable = retryable;
                    t.speed_bps = None;
                })
                .await;
                // Re-arm to parked so we don't hot-loop; a Retry sets Run.
                let _ = control_tx.send(Control::Pause);
                continue;
            }
        }
    }
}

/// If `dest` exists and matches the expected checksum (or a recorded one), skip
/// the download entirely. Mirrors the downloaders' existing fast-path.
async fn fast_path(spec: &DownloadSpec) -> Option<PathBuf> {
    if !spec.dest.exists() {
        return None;
    }
    let expected = spec.sha256.clone().filter(|s| !s.is_empty()).or_else(|| {
        spec.version_record
            .as_ref()
            .and_then(|v| host().installed_checksum(&v.store_key))
    })?;
    let actual = sha256_file(&spec.dest).await.ok()?;
    (actual == expected).then(|| spec.dest.clone())
}

/// Stream with bounded retry. Network errors keep the `.part` and retry with a
/// Range request; fatal IO errors and checksum mismatches fail terminally.
async fn attempt(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    control_rx: &mut watch::Receiver<Control>,
) -> AttemptOutcome {
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match stream_once(inner, id, spec, control_rx).await {
            Ok(StreamResult::Done) => match finalize(inner, id, spec).await {
                Ok(path) => return AttemptOutcome::Done(path),
                Err(e) => {
                    // Bad checksum or rename failure — delete the corrupt .part.
                    let _ = tokio::fs::remove_file(part_path(&spec.dest)).await;
                    return AttemptOutcome::Failed {
                        error: e,
                        retryable: false,
                    };
                }
            },
            Ok(StreamResult::Paused) => return AttemptOutcome::Paused,
            Ok(StreamResult::Cancelled) => return AttemptOutcome::Cancelled,
            Err(StreamErr::Network(e)) => {
                if attempts >= MAX_ATTEMPTS {
                    return AttemptOutcome::Failed {
                        error: e,
                        retryable: true,
                    };
                }
                let backoff = Duration::from_secs(1u64 << (attempts - 1));
                tracing::warn!(
                    "download {id}: attempt {attempts} failed ({e}); retry in {backoff:?}"
                );
                // Honour cancel/pause during the backoff wait.
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    changed = control_rx.changed() => {
                        if changed.is_err() { return AttemptOutcome::Cancelled; }
                        let ctl = *control_rx.borrow();
                        match ctl {
                            Control::Cancel => return AttemptOutcome::Cancelled,
                            Control::Pause => return AttemptOutcome::Paused,
                            Control::Run => {}
                        }
                    }
                }
            }
            Err(StreamErr::Io(e)) => {
                return AttemptOutcome::Failed {
                    error: e,
                    retryable: false,
                }
            }
        }
    }
}

/// One streaming pass: open `.part`, send Range+If-Range when resuming, write
/// chunks to disk while polling the control channel.
async fn stream_once(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    control_rx: &mut watch::Receiver<Control>,
) -> std::result::Result<StreamResult, StreamErr> {
    let part = part_path(&spec.dest);
    if let Some(parent) = spec.dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| StreamErr::Io(format!("creating {}: {e}", parent.display())))?;
    }

    let existing = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let etag = {
        let tasks = inner.tasks.read().await;
        tasks.get(id).and_then(|t| t.etag.clone())
    };

    // Build the request (Range + If-Range when resuming a non-empty .part).
    // Host attaches any auth for this URL (Core folds the HF-host check + bearer
    // token in here; a non-HF host is a pass-through).
    let mut req = host().authorize(&spec.url, inner.client.get(&spec.url));
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        if let Some(tag) = &etag {
            req = req.header(reqwest::header::IF_RANGE, tag.clone());
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| StreamErr::Network(format!("GET {}: {e}", spec.url)))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // Gated (e.g. HF) — not resolvable by retrying.
        return Err(StreamErr::Io(format!(
            "remote refused the download (HTTP {}). If this is a gated model, set a \
             Hugging Face token in Settings → Integrations and accept the model terms.",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(StreamErr::Network(format!(
            "HTTP {} for {}",
            status, spec.url
        )));
    }

    // 206 ⇒ resume from offset; 200 ⇒ server ignored Range / file changed ⇒ restart.
    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && existing > 0;
    let mut received = if resuming { existing } else { 0 };

    let new_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .or_else(|| resp.headers().get(reqwest::header::LAST_MODIFIED))
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_len = resp.content_length();
    let total = match (resuming, content_len) {
        (true, Some(len)) => Some(existing + len),
        (false, Some(len)) => Some(len),
        _ => None,
    };

    let file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(&part).await
    } else {
        tokio::fs::File::create(&part).await
    };
    let mut file = file.map_err(|e| StreamErr::Io(format!("opening {}: {e}", part.display())))?;

    patch(inner, id, true, |t| {
        t.total_bytes = total;
        t.received_bytes = received;
        if new_etag.is_some() {
            t.etag = new_etag.clone();
        }
    })
    .await;

    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut sample_anchor = (Instant::now(), received);

    loop {
        tokio::select! {
            biased;
            changed = control_rx.changed() => {
                if changed.is_err() { return Ok(StreamResult::Cancelled); }
                let ctl = *control_rx.borrow();
                match ctl {
                    Control::Cancel => return Ok(StreamResult::Cancelled),
                    Control::Pause => {
                        let _ = file.flush().await;
                        return Ok(StreamResult::Paused);
                    }
                    Control::Run => {}
                }
            }
            chunk = stream.next() => {
                match chunk {
                    None => {
                        file.flush().await.map_err(|e| StreamErr::Io(e.to_string()))?;
                        return Ok(StreamResult::Done);
                    }
                    Some(Err(e)) => return Err(StreamErr::Network(format!("stream error: {e}"))),
                    Some(Ok(bytes)) => {
                        file.write_all(&bytes)
                            .await
                            .map_err(|e| StreamErr::Io(format!("writing {}: {e}", part.display())))?;
                        received += bytes.len() as u64;

                        if last_emit.elapsed() >= PROGRESS_THROTTLE {
                            let (anchor_t, anchor_b) = sample_anchor;
                            let secs = anchor_t.elapsed().as_secs_f64();
                            let speed = if secs > 0.0 {
                                Some(((received - anchor_b) as f64 / secs) as u64)
                            } else {
                                None
                            };
                            patch(inner, id, false, |t| {
                                t.received_bytes = received;
                                t.speed_bps = speed;
                            })
                            .await;
                            last_emit = Instant::now();
                            sample_anchor = (Instant::now(), received);
                        }
                    }
                }
            }
        }
    }
}

/// Re-hash the completed `.part` from disk, verify, then atomically rename into
/// place and record the version/checksum.
async fn finalize(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
) -> std::result::Result<PathBuf, String> {
    patch(inner, id, true, |t| {
        t.state = DownloadState::Verifying;
        t.speed_bps = None;
    })
    .await;

    let part = part_path(&spec.dest);
    let actual = sha256_file(&part).await.map_err(|e| e.to_string())?;

    if let Some(expected) = spec.sha256.as_ref().filter(|s| !s.is_empty()) {
        if &actual != expected {
            return Err(format!(
                "checksum mismatch: expected {expected}, got {actual}"
            ));
        }
    }

    tokio::fs::rename(&part, &spec.dest)
        .await
        .map_err(|e| format!("rename {} -> {}: {e}", part.display(), spec.dest.display()))?;

    if let Some(rec) = &spec.version_record {
        host().record_version(&rec.store_key, &rec.version, &actual);
    }

    Ok(spec.dest.clone())
}

async fn finish_completed(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    done_tx: &watch::Sender<Term>,
    path: PathBuf,
) {
    patch(inner, id, false, |t| {
        t.state = DownloadState::Completed;
        t.error = None;
        t.speed_bps = None;
        if let Some(total) = t.total_bytes {
            t.received_bytes = total;
        }
    })
    .await;
    persist_inner(inner).await;
    if let Some(t) = inner.tasks.read().await.get(id).cloned() {
        record_history(inner, &t).await;
    }
    inner.handles.lock().await.remove(id);
    let _ = done_tx.send(Some(Ok(path)));
    let _ = spec; // dest already captured in path
}

async fn cleanup_cancelled(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    done_tx: &watch::Sender<Term>,
) {
    let _ = tokio::fs::remove_file(part_path(&spec.dest)).await;
    patch(inner, id, false, |t| {
        t.state = DownloadState::Cancelled;
        t.speed_bps = None;
    })
    .await;
    persist_inner(inner).await;
    if let Some(t) = inner.tasks.read().await.get(id).cloned() {
        record_history(inner, &t).await;
    }
    inner.handles.lock().await.remove(id);
    let _ = done_tx.send(Some(Err("cancelled".to_string())));
}

async fn sha256_file(path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{set_global_host, DownloadKind, DownloadsHost};

    /// A no-state host for the crate's own tests: a per-process temp data dir (so
    /// `downloads.json` / history never touch a real `~/.ryu`), no version-store
    /// checksums, and no auth (the tests hit loopback, never Hugging Face).
    struct TestHost {
        dir: PathBuf,
    }

    impl DownloadsHost for TestHost {
        fn ryu_dir(&self) -> PathBuf {
            self.dir.clone()
        }
        fn installed_checksum(&self, _store_key: &str) -> Option<String> {
            None
        }
        fn record_version(&self, _store_key: &str, _version: &str, _checksum: &str) {}
        fn authorize(&self, _url: &str, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
            req
        }
    }

    /// Install the temp-dir [`TestHost`] once for the whole test binary.
    /// `set_global_host` is idempotent, so every test can call this cheaply.
    fn ensure_host() {
        let dir = std::env::temp_dir().join(format!("ryu-dl-host-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        set_global_host(std::sync::Arc::new(TestHost { dir }));
    }

    fn spec(dest: PathBuf) -> DownloadSpec {
        DownloadSpec {
            kind: DownloadKind::Model,
            label: "test".to_string(),
            url: "http://127.0.0.1:0/never".to_string(),
            dest,
            sha256: None,
            version_record: None,
        }
    }

    #[test]
    fn id_is_stable_and_dest_derived() {
        let a = derive_id(Path::new("/x/y/model.gguf"));
        let b = derive_id(Path::new("/x/y/model.gguf"));
        let c = derive_id(Path::new("/x/y/other.gguf"));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("dl_"));
    }

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(
            part_path(Path::new("/m/x.gguf")),
            PathBuf::from("/m/x.gguf.part")
        );
    }

    #[tokio::test]
    async fn fast_path_skips_when_checksum_matches() {
        ensure_host();
        let dir = std::env::temp_dir().join(format!("ryu-dl-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let dest = dir.join("present.bin");
        tokio::fs::write(&dest, b"hello world").await.unwrap();
        let sum = sha256_file(&dest).await.unwrap();

        let mut s = spec(dest.clone());
        s.sha256 = Some(sum);
        assert_eq!(fast_path(&s).await, Some(dest.clone()));

        // Wrong checksum ⇒ no skip.
        let mut bad = spec(dest.clone());
        bad.sha256 = Some("deadbeef".to_string());
        assert_eq!(fast_path(&bad).await, None);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// End-to-end on loopback: a half-written `.part` resumes via a Range request
    /// and the final file equals the full body (no concatenation corruption). This
    /// is the advisor's #3 concern exercised deterministically — no timing races.
    #[tokio::test]
    async fn resumes_from_part_via_range() {
        ensure_host();
        use axum::extract::Request;
        use axum::http::{header, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::get;
        use axum::Router;

        let body: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let served = body.clone();
        let app = Router::new().route(
            "/file",
            get(move |req: Request| {
                let body = served.clone();
                async move {
                    let range = req
                        .headers()
                        .get(header::RANGE)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    match range {
                        Some(r) => {
                            let start: usize = r
                                .trim_start_matches("bytes=")
                                .trim_end_matches('-')
                                .parse()
                                .unwrap_or(0);
                            let slice = body[start..].to_vec();
                            let mut resp = (StatusCode::PARTIAL_CONTENT, slice).into_response();
                            resp.headers_mut()
                                .insert(header::ETAG, "\"v1\"".parse().unwrap());
                            resp
                        }
                        None => {
                            let mut resp = (StatusCode::OK, body.clone()).into_response();
                            resp.headers_mut()
                                .insert(header::ETAG, "\"v1\"".parse().unwrap());
                            resp
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = std::env::temp_dir().join(format!("ryu-dl-resume-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let dest = dir.join("file.bin");
        // Simulate an interrupted download: first 4000 bytes already on disk.
        tokio::fs::write(part_path(&dest), &body[..4000])
            .await
            .unwrap();

        let center = DownloadCenter::with_default_client();
        let mut s = spec(dest.clone());
        s.url = format!("http://{addr}/file");
        s.sha256 = Some({
            let mut h = Sha256::new();
            h.update(&body);
            hex::encode(h.finalize())
        });

        let path = center.download_blocking(s).await.unwrap();
        let got = tokio::fs::read(&path).await.unwrap();
        assert_eq!(got, body, "resumed file must equal the full body");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn register_indeterminate_tracks_completion_and_failure() {
        ensure_host();
        let center = DownloadCenter::with_default_client();

        let ok: Result<i32> = center
            .register_indeterminate("ind:ok".into(), DownloadKind::Skill, "ok".into(), async {
                Ok(42)
            })
            .await;
        assert_eq!(ok.unwrap(), 42);
        let t = center
            .snapshot()
            .await
            .into_iter()
            .find(|t| t.id == "ind:ok")
            .unwrap();
        assert_eq!(t.state, DownloadState::Completed);
        assert!(t.total_bytes.is_none(), "indeterminate task has no total");

        let err: Result<i32> = center
            .register_indeterminate("ind:err".into(), DownloadKind::Skill, "err".into(), async {
                anyhow::bail!("boom")
            })
            .await;
        assert!(err.is_err());
        let t = center
            .snapshot()
            .await
            .into_iter()
            .find(|t| t.id == "ind:err")
            .unwrap();
        assert_eq!(t.state, DownloadState::Failed);
        assert!(t.retryable);
    }

    #[tokio::test]
    async fn enqueue_dedups_onto_same_id() {
        ensure_host();
        let center = DownloadCenter::with_default_client();
        let dest = std::env::temp_dir().join("ryu-dedup-test.bin");
        let id1 = center.enqueue(spec(dest.clone())).await;
        let id2 = center.enqueue(spec(dest.clone())).await;
        assert_eq!(id1, id2);
        let snap = center.snapshot().await;
        assert_eq!(snap.iter().filter(|t| t.id == id1).count(), 1);
        // Clean up the driver (it's stuck retrying an unroutable URL).
        center.cancel(&id1).await;
    }
}

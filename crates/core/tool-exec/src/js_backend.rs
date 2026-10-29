//! The **JavaScript sandbox**: QuickJS (the Bytecode Alliance's Javy runtime)
//! compiled to WebAssembly and run **in-process** by Wasmtime.
//!
//! Why this shape: the guest is a WebAssembly instance, so it can touch nothing
//! the host does not hand it — no filesystem, network, environment or process
//! table. Its only door out is the `ryu` import module, which this file
//! implements. Nothing is downloaded or spawned to run a program, and the same
//! code runs on every OS Wasmtime supports.
//!
//! ## The guest
//!
//! `assets/ryu_js_guest.wasm` (built by `tools/build-js-guest.sh` from
//! `guest/src/main.rs`, and pinned by `assets/ryu_js_guest.wasm.sha256`) is a
//! generic script runner. The host builds the whole
//! script — a bootstrap that defines `tools`, `console`, `setTimeout`,
//! `childProcess`, plus the user program in an async IIFE — and the guest
//! evaluates it, settling promises as the host answers its operations.
//!
//! ## Operations
//!
//! Every promise the guest awaits on the host is an *operation*
//! (`{"kind": "tool" | "sleep" | "spawn", ...}`):
//! - `tool` — `tools.<server>.<tool>(args)`, routed through the
//!   [`SandboxToolInvoker`] exactly as the old Deno bridge did.
//! - `sleep` — `setTimeout`, bounded by the run's deadline.
//! - `spawn` — `childProcess.run(name, {args, stdin})`, refused unless the
//!   manifest granted `child_process` AND the host named that program in
//!   [`crate::SandboxAugment::run_allow`].
//!
//! Operations run concurrently, so `await Promise.all([...])` fans out, within
//! per-run bounds: at most [`MAX_CONCURRENT_TOOL_CALLS`] tool calls,
//! [`MAX_CONCURRENT_CHILDREN`] child processes and [`MAX_PENDING_TIMERS`] timers
//! at once. An operation holds its slot until the program has READ its result,
//! so finished-but-unread results are bounded by the same caps (a loop that
//! never awaits cannot make the host buffer results without limit). Further
//! operations wait in a queue of at most [`MAX_QUEUED_OPS`] /
//! [`MAX_QUEUED_OP_BYTES`]; a run that overflows it fails with an error asking
//! for smaller batches. This replaces the backpressure the old
//! one-call-at-a-time stdout protocol gave for free.
//!
//! ## Deadline, pause and resume
//!
//! The guest yields to the driver every epoch tick ([`EPOCH_TICK`]), so a CPU
//! loop cannot starve it: when the active-compute deadline passes, the driver
//! drops the run and the instance is gone. A tool call that elicits a human step
//! parks the whole [`Execution`] — guest future, in-flight operations and all —
//! in the bounded store. A parked future is simply not polled, which freezes the
//! guest exactly where it was; `resume` answers the suspended call and polls it
//! again.

use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use wasmtime::{
    Caller, Engine, InstancePre, Linker, Module, Store, StoreLimits, StoreLimitsBuilder,
};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

use super::framing::{MAX_LOG_LINES, MAX_PROTOCOL_FRAME_BYTES};
use super::parked::ParkedStore;
use super::sanitize::{push_log, sanitize_error, sanitize_tool_value, FlattenNull};
use super::{
    Elicitation, ExecOutcome, InvokeOutcome, ResumeDecision, SandboxAugment, SandboxToolInvoker,
    ToolInvocation, DEFAULT_DEADLINE_SECS, DEFAULT_MEMORY_MB, MAX_PARKED, PARKED_TTL,
};
use crate::win_process::NoWindow;

/// The backend label reported for audit.
pub const BACKEND_JS: &str = "quickjs-wasm";

/// The compiled guest. Committed so ordinary builds need no WASI toolchain.
///
/// It lives in `assets/`, not next to its source in `guest/`: `guest/` is its own
/// Cargo package, and `cargo package` leaves nested packages out of the `.crate`,
/// which would drop the blob and break the published crate's build.
static GUEST_WASM: &[u8] = include_bytes!("../assets/ryu_js_guest.wasm");

/// How often the guest yields to the driver (and so how late a deadline can
/// fire at most).
const EPOCH_TICK: Duration = Duration::from_millis(10);

/// Cap on each of a child process's stdout and stderr.
const MAX_CHILD_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;

/// Most tool calls one run may have in flight at once. Fan-out stays useful,
/// but a `Promise.all` over thousands of items cannot turn into thousands of
/// simultaneous MCP / Composio / side-model calls.
pub(crate) const MAX_CONCURRENT_TOOL_CALLS: usize = 8;

/// Most `childProcess.run` children one run may have alive at once. Each can
/// buffer up to 2 x [`MAX_CHILD_OUTPUT_BYTES`] in Core's heap.
pub(crate) const MAX_CONCURRENT_CHILDREN: usize = 2;

/// Most `setTimeout` / `setInterval` waits one run may have pending at once.
pub(crate) const MAX_PENDING_TIMERS: usize = 1024;

/// Most operations one run may have waiting for a slot. A slot is held until
/// the program reads the operation's result, and a program reads results only
/// once it awaits, so a `Promise.all` over N items queues the rest of the N
/// here while the first slots' results wait to be read. Past this the run fails
/// with an error asking for smaller batches, instead of the host buffering
/// requests without limit.
pub(crate) const MAX_QUEUED_OPS: usize = 10_000;

/// Most request bytes (each request is up to 64 KiB) those queued operations
/// may hold in Core's memory. Past this the run fails like [`MAX_QUEUED_OPS`].
pub(crate) const MAX_QUEUED_OP_BYTES: usize = 4 * 1024 * 1024;

/// Capacity of the guest-to-host operation channel (requests sent by the guest
/// that the host has not read yet). The driver always drains it, so this only
/// paces the guest between driver turns.
const OPS_CHANNEL_CAPACITY: usize = 16;

// ── Shared runtime ──────────────────────────────────────────────────────────

struct JsRuntime {
    engine: Engine,
    pre: InstancePre<GuestState>,
}

/// The engine + pre-linked guest, compiled once per process. `Err` carries why
/// the sandbox cannot run here (reported verbatim by every run).
fn js_runtime() -> Result<&'static JsRuntime, &'static str> {
    static RUNTIME: OnceLock<Result<JsRuntime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(build_runtime)
        .as_ref()
        .map_err(String::as_str)
}

/// Where the compiled guest is kept across restarts (see [`warm_up`]). Unset,
/// every process compiles the guest in memory.
static MODULE_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Build the runtime on a background thread now, so the first run does not pay
/// for compiling the guest. With `cache_dir`, the compiled guest is also kept
/// there and reused by later processes (unix only; see `DISK_CACHE_TRUSTED`).
/// Only the first call's `cache_dir` counts, and only if the sandbox has not
/// run yet.
pub fn warm_up(cache_dir: Option<PathBuf>) {
    if let Some(dir) = cache_dir {
        let _ = MODULE_CACHE_DIR.set(dir);
    }
    // A failed spawn only means the first run builds the runtime itself.
    let _ = std::thread::Builder::new()
        .name("ryu-js-warm".into())
        .spawn(|| {
            let _ = js_runtime();
        });
}

fn build_runtime() -> Result<JsRuntime, String> {
    let mut config = wasmtime::Config::new();
    config.epoch_interruption(true);
    let engine = Engine::new(&config).map_err(|e| format!("sandbox engine: {e}"))?;
    let module = guest_module(
        &engine,
        GUEST_WASM,
        MODULE_CACHE_DIR.get().map(PathBuf::as_path),
    )?;
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p1::add_to_linker_async(&mut linker, |state: &mut GuestState| &mut state.wasi)
        .map_err(|e| format!("sandbox WASI imports: {e}"))?;
    link_bridge(&mut linker).map_err(|e| format!("sandbox bridge imports: {e}"))?;
    let pre = linker
        .instantiate_pre(&module)
        .map_err(|e| format!("sandbox guest link: {e}"))?;

    let ticker = engine.weak();
    std::thread::Builder::new()
        .name("ryu-js-epoch".into())
        .spawn(move || {
            while let Some(engine) = ticker.upgrade() {
                engine.increment_epoch();
                drop(engine);
                std::thread::sleep(EPOCH_TICK);
            }
        })
        .map_err(|e| format!("sandbox epoch thread: {e}"))?;

    Ok(JsRuntime { engine, pre })
}

/// Whether the sandbox can run on this machine (the guest compiled and linked).
pub fn js_available() -> bool {
    js_runtime().is_ok()
}

// ── Compiled-guest cache ────────────────────────────────────────────────────
//
// Compiling the guest with Cranelift takes most of a second. The result is
// native code, so a cache file is only trusted when this user wrote it: it
// must be owned by the current user and writable by nobody else, and carry a
// checksum that catches a torn write. Its name binds it to this engine's
// compile settings and the exact embedded guest bytes, and Wasmtime still
// refuses an artifact from another version or config. Any miss or failure
// falls back to compiling in memory.
//
// Only unix can prove the "this user wrote it" part (owner uid and mode bits).
// Elsewhere there is no cheap equivalent, and the checksum is unkeyed, so
// anyone able to write the file could forge it. The disk cache is therefore
// off on non-unix platforms: the guest is compiled once per process and kept
// in memory, and any leftover cached compile is deleted, never loaded.

const CACHE_PREFIX: &str = "ryu-js-guest-";
const CACHE_SUFFIX: &str = ".cwasm";

/// Whether a compiled guest may be written to and loaded from disk. Only unix
/// can check that the file was written by this user and nobody else can
/// change it (see [`written_by_this_user`]).
const DISK_CACHE_TRUSTED: bool = cfg!(unix);

/// `wasm` compiled for `engine`: a matching compile cached in `cache_dir` when
/// there is one, else a fresh compile that is then cached for the next process.
/// Where the disk cache is not trusted, `cache_dir` is only purged of old
/// compiles and the guest is always compiled in memory.
fn guest_module(engine: &Engine, wasm: &[u8], cache_dir: Option<&Path>) -> Result<Module, String> {
    let compile = || Module::new(engine, wasm).map_err(|e| format!("sandbox guest module: {e}"));
    let Some(dir) = cache_dir else {
        return compile();
    };
    if !DISK_CACHE_TRUSTED {
        // Best effort: drop compiles an earlier build left behind, keeping none.
        remove_stale_cache_files(dir, Path::new(""));
        return compile();
    }
    let path = dir.join(cache_file_name(engine, wasm));
    if let Some(module) = load_cached_guest(engine, &path) {
        return Ok(module);
    }
    let module = compile()?;
    if let Ok(artifact) = module.serialize() {
        if write_cached_guest(dir, &path, &artifact).is_ok() {
            remove_stale_cache_files(dir, &path);
        }
    }
    Ok(module)
}

fn cache_file_name(engine: &Engine, wasm: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    engine.precompile_compatibility_hash().hash(&mut hasher);
    wasm.hash(&mut hasher);
    format!("{CACHE_PREFIX}{:016x}{CACHE_SUFFIX}", hasher.finish())
}

/// Detects a torn or corrupted cache file, not a forged one (file ownership
/// guards against that).
fn cache_checksum(artifact: &[u8]) -> [u8; 8] {
    let mut hasher = DefaultHasher::new();
    artifact.hash(&mut hasher);
    hasher.finish().to_le_bytes()
}

fn load_cached_guest(engine: &Engine, path: &Path) -> Option<Module> {
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || !written_by_this_user(&meta) {
        return None;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).ok()?);
    file.read_to_end(&mut bytes).ok()?;
    let (artifact, checksum) = bytes.split_at(bytes.len().checked_sub(8)?);
    if checksum != cache_checksum(artifact) {
        return None;
    }
    // SAFETY: `artifact` is the serialized compile this code wrote for this
    // engine and guest (file ownership, checksum and name checked above), and
    // `deserialize` copies it, so later changes to the file cannot reach the
    // loaded module.
    unsafe { Module::deserialize(engine, artifact) }.ok()
}

#[cfg(unix)]
fn written_by_this_user(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    meta.uid() == uid && meta.mode() & 0o022 == 0
}

/// Elsewhere authorship cannot be checked from file metadata, so no cache file
/// is trusted. `guest_module` never reaches the disk there (see
/// [`DISK_CACHE_TRUSTED`]); this is the second line of defense.
#[cfg(not(unix))]
fn written_by_this_user(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Write `artifact` + checksum to a private temp file and rename it into place,
/// so a reader never sees a partial file.
fn write_cached_guest(dir: &Path, path: &Path, artifact: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{CACHE_PREFIX}{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&tmp).and_then(|mut file| {
        file.write_all(artifact)?;
        file.write_all(&cache_checksum(artifact))?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// A temp file older than this was left by a process that exited mid-write; a
/// live writer finishes in well under a second.
const ORPHANED_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

/// Drop compiles for other guests or Wasmtime builds, and temp files orphaned
/// by a process that exited mid-write (best-effort).
fn remove_stale_cache_files(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stale_compile =
            name.starts_with(CACHE_PREFIX) && name.ends_with(CACHE_SUFFIX) && entry.path() != keep;
        let orphaned_temp = name.starts_with(&format!(".{CACHE_PREFIX}"))
            && name.ends_with(".tmp")
            && entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > ORPHANED_TEMP_AGE);
        if stale_compile || orphaned_temp {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ── Guest state + the `ryu` import module ───────────────────────────────────

enum GuestEvent {
    Log(String),
    Done { value: String, is_error: bool },
}

/// One operation the guest started (`call`), not yet read by the driver.
struct GuestOp {
    id: u32,
    request: String,
}

/// A settled operation's reply frame, waiting for the guest's `wait`.
struct Reply {
    frame: String,
    /// The slot the operation still holds. It is released only once the guest
    /// reads this reply, so a program that starts operations without awaiting
    /// them cannot make the host buffer an unbounded pile of finished results.
    slot: Option<OpKind>,
}

struct GuestState {
    /// An empty WASI context: no preopened dirs, no env, no args, no sockets.
    wasi: WasiP1Ctx,
    limits: StoreLimits,
    script: Vec<u8>,
    next_id: u32,
    /// Operations, over a BOUNDED channel: a full channel blocks `call` until the
    /// driver drains it.
    ops: mpsc::Sender<GuestOp>,
    /// Log lines and the final result.
    events: mpsc::UnboundedSender<GuestEvent>,
    replies: mpsc::UnboundedReceiver<Reply>,
    /// Tells the driver a reply was read, freeing its operation's slot.
    released: mpsc::UnboundedSender<OpKind>,
    /// A reply too large for the guest's buffer, held for its retry.
    staged: Option<Vec<u8>>,
    /// Log lines sent so far; past [`MAX_LOG_LINES`] every line is dropped.
    log_lines: usize,
    /// Set by the driver once the log byte budget is spent.
    logs_full: Arc<AtomicBool>,
}

fn guest_memory(caller: &mut Caller<'_, GuestState>) -> wasmtime::Result<wasmtime::Memory> {
    caller
        .get_export("memory")
        .and_then(wasmtime::Extern::into_memory)
        .ok_or_else(|| wasmtime::Error::msg("sandbox guest exports no memory"))
}

/// Copy `len` bytes at `ptr` out of the guest. Frames above `cap` either trap
/// (`truncate == false`) or are cut to `cap` (log lines).
fn read_guest(
    caller: &mut Caller<'_, GuestState>,
    ptr: u32,
    len: u32,
    cap: usize,
    truncate: bool,
) -> wasmtime::Result<String> {
    let len = len as usize;
    if len > cap && !truncate {
        return Err(wasmtime::Error::msg(format!(
            "sandbox frame of {len} bytes exceeds the {cap}-byte limit"
        )));
    }
    let mut buf = vec![0u8; len.min(cap)];
    guest_memory(caller)?.read(&*caller, ptr as usize, &mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn link_bridge(linker: &mut Linker<GuestState>) -> wasmtime::Result<()> {
    linker.func_wrap("ryu", "script_len", |caller: Caller<'_, GuestState>| {
        caller.data().script.len() as u32
    })?;
    linker.func_wrap(
        "ryu",
        "script_read",
        |mut caller: Caller<'_, GuestState>, ptr: u32| -> wasmtime::Result<()> {
            let script = std::mem::take(&mut caller.data_mut().script);
            guest_memory(&mut caller)?.write(&mut caller, ptr as usize, &script)?;
            Ok(())
        },
    )?;
    linker.func_wrap_async(
        "ryu",
        "call",
        |mut caller: Caller<'_, GuestState>, (ptr, len): (u32, u32)| {
            Box::new(async move {
                let request = read_guest(&mut caller, ptr, len, MAX_PROTOCOL_FRAME_BYTES, false)?;
                let state = caller.data_mut();
                state.next_id += 1;
                let id = state.next_id;
                // Waits while the channel is full, until the driver drains it
                // (backpressure). A closed channel means the driver is gone; the
                // run is being dropped.
                let _ = state.ops.send(GuestOp { id, request }).await;
                Ok(id)
            })
        },
    )?;
    linker.func_wrap_async(
        "ryu",
        "wait",
        |mut caller: Caller<'_, GuestState>, (ptr, cap): (u32, u32)| {
            Box::new(async move {
                let state = caller.data_mut();
                let frame = match state.staged.take() {
                    Some(frame) => frame,
                    None => match state.replies.recv().await {
                        Some(Reply { frame, slot }) => {
                            // The reply now lives in the guest (or `staged` for its
                            // retry), so its operation's slot can go to the next one.
                            if let Some(kind) = slot {
                                let _ = state.released.send(kind);
                            }
                            frame.into_bytes()
                        }
                        None => return Ok(0),
                    },
                };
                if frame.len() > cap as usize {
                    let needed = i32::try_from(frame.len())
                        .map_err(|_| wasmtime::Error::msg("sandbox reply too large"))?;
                    caller.data_mut().staged = Some(frame);
                    return Ok(-needed);
                }
                guest_memory(&mut caller)?.write(&mut caller, ptr as usize, &frame)?;
                Ok(frame.len() as i32)
            })
        },
    )?;
    linker.func_wrap(
        "ryu",
        "log",
        |mut caller: Caller<'_, GuestState>, ptr: u32, len: u32| -> wasmtime::Result<()> {
            // Once the run's log budget is spent `push_log` drops every further
            // line, so do not copy it out of the guest or queue it at all.
            let state = caller.data_mut();
            if state.log_lines >= MAX_LOG_LINES || state.logs_full.load(Ordering::Relaxed) {
                return Ok(());
            }
            state.log_lines += 1;
            let line = read_guest(&mut caller, ptr, len, MAX_PROTOCOL_FRAME_BYTES, true)?;
            let _ = caller.data().events.send(GuestEvent::Log(line));
            Ok(())
        },
    )?;
    linker.func_wrap(
        "ryu",
        "done",
        |mut caller: Caller<'_, GuestState>,
         ptr: u32,
         len: u32,
         is_error: u32|
         -> wasmtime::Result<()> {
            let value = read_guest(&mut caller, ptr, len, MAX_PROTOCOL_FRAME_BYTES, false)?;
            let _ = caller.data().events.send(GuestEvent::Done {
                value,
                is_error: is_error != 0,
            });
            Ok(())
        },
    )?;
    Ok(())
}

// ── One execution ───────────────────────────────────────────────────────────

type GuestRun = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type OpRun = Pin<Box<dyn Future<Output = (u32, OpKind, OpResult)> + Send>>;

enum OpResult {
    Reply(Value),
    Suspend(Elicitation),
}

/// What an operation asks the host to do; each kind has its own concurrency cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpKind {
    Tool,
    Spawn,
    Sleep,
}

impl OpKind {
    fn of(request: &Value) -> Option<Self> {
        match request.get("kind").and_then(Value::as_str) {
            Some("tool") => Some(Self::Tool),
            Some("spawn") => Some(Self::Spawn),
            Some("sleep") => Some(Self::Sleep),
            _ => None,
        }
    }

    /// How many operations of this kind one run may have running at once.
    fn limit(self) -> usize {
        match self {
            Self::Tool => MAX_CONCURRENT_TOOL_CALLS,
            Self::Spawn => MAX_CONCURRENT_CHILDREN,
            Self::Sleep => MAX_PENDING_TIMERS,
        }
    }
}

/// A parsed operation waiting for a free slot of its kind.
struct PendingOp {
    id: u32,
    kind: OpKind,
    request: Value,
    /// The raw request's size, counted against [`MAX_QUEUED_OP_BYTES`].
    bytes: usize,
}

/// Operations waiting for a slot: one FIFO per kind (so a kind at its cap never
/// holds back another), plus the totals the queue's bounds are checked against.
#[derive(Default)]
struct WaitingOps {
    tool: VecDeque<PendingOp>,
    spawn: VecDeque<PendingOp>,
    sleep: VecDeque<PendingOp>,
    len: usize,
    bytes: usize,
}

impl WaitingOps {
    fn queue(&mut self, kind: OpKind) -> &mut VecDeque<PendingOp> {
        match kind {
            OpKind::Tool => &mut self.tool,
            OpKind::Spawn => &mut self.spawn,
            OpKind::Sleep => &mut self.sleep,
        }
    }

    /// Queue `op`, or `false` (leaving the queue unchanged) when that would pass
    /// [`MAX_QUEUED_OPS`] or [`MAX_QUEUED_OP_BYTES`].
    fn push(&mut self, op: PendingOp) -> bool {
        if self.len >= MAX_QUEUED_OPS || self.bytes.saturating_add(op.bytes) > MAX_QUEUED_OP_BYTES {
            return false;
        }
        self.len += 1;
        self.bytes += op.bytes;
        self.queue(op.kind).push_back(op);
        true
    }

    /// The oldest waiting operation of `kind`.
    fn pop(&mut self, kind: OpKind) -> Option<PendingOp> {
        let op = self.queue(kind).pop_front()?;
        self.len -= 1;
        self.bytes -= op.bytes;
        Some(op)
    }
}

/// Operations of each kind currently running for one run.
#[derive(Default)]
struct RunningOps {
    tool: usize,
    spawn: usize,
    sleep: usize,
}

impl RunningOps {
    fn count(&mut self, kind: OpKind) -> &mut usize {
        match kind {
            OpKind::Tool => &mut self.tool,
            OpKind::Spawn => &mut self.spawn,
            OpKind::Sleep => &mut self.sleep,
        }
    }

    /// Claim a slot for `kind`, or `false` when that kind is at its cap.
    fn try_claim(&mut self, kind: OpKind) -> bool {
        let count = self.count(kind);
        if *count >= kind.limit() {
            return false;
        }
        *count += 1;
        true
    }

    fn release(&mut self, kind: OpKind) {
        let count = self.count(kind);
        *count = count.saturating_sub(1);
    }
}

/// Which programs `childProcess.run` may start, and the env they get.
#[derive(Clone, Default)]
struct SpawnPolicy {
    allow: Vec<String>,
    extra_env: Vec<(String, String)>,
}

/// A live run: the guest future plus everything the driver needs. Parking moves
/// the whole struct into the store; dropping it drops the guest instance.
struct Execution {
    guest: GuestRun,
    ops: mpsc::Receiver<GuestOp>,
    events: mpsc::UnboundedReceiver<GuestEvent>,
    replies: mpsc::UnboundedSender<Reply>,
    /// Slots freed by the guest reading a reply.
    released: mpsc::UnboundedReceiver<OpKind>,
    /// Operations running now. Each holds a slot in `running`, and keeps it
    /// after it settles until the guest reads its reply.
    inflight: FuturesUnordered<OpRun>,
    /// Operations read from the guest, waiting for a slot of their kind.
    waiting: WaitingOps,
    running: RunningOps,
    invoker: Arc<SandboxToolInvoker>,
    spawn: Arc<SpawnPolicy>,
    logs: Vec<String>,
    /// Shared with the guest's `log` import: set once `logs` is full.
    logs_full: Arc<AtomicBool>,
    /// The agent that created the run; only it may resume (security M2).
    agent_id: String,
    /// The operation id whose tool call suspended the run.
    suspended_call_id: u32,
    /// The slot that suspended call holds until the guest reads its answer.
    suspended_kind: OpKind,
}

/// How a drive segment ended.
enum DriveEnd {
    Done { value: String, is_error: bool },
    Failed(String),
    Paused(Elicitation),
}

fn parked_store() -> &'static Mutex<ParkedStore<Execution>> {
    static STORE: OnceLock<Mutex<ParkedStore<Execution>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(ParkedStore::new(MAX_PARKED, PARKED_TTL)))
}

fn memory_limit_bytes() -> usize {
    let mb = std::env::var("RYU_TOOL_EXEC_MEMORY_MB")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MEMORY_MB as usize);
    mb.saturating_mul(1024 * 1024)
}

fn start(
    script: String,
    invoker: Arc<SandboxToolInvoker>,
    agent_id: &str,
    spawn: SpawnPolicy,
) -> Result<Execution, String> {
    let runtime =
        js_runtime().map_err(|e| format!("the JavaScript sandbox is unavailable: {e}"))?;
    let (ops_tx, ops) = mpsc::channel(OPS_CHANNEL_CAPACITY);
    let (event_tx, events) = mpsc::unbounded_channel();
    let (replies, reply_rx) = mpsc::unbounded_channel();
    let (released_tx, released) = mpsc::unbounded_channel();
    let logs_full = Arc::new(AtomicBool::new(false));
    let state = GuestState {
        wasi: WasiCtxBuilder::new().build_p1(),
        limits: StoreLimitsBuilder::new()
            .memory_size(memory_limit_bytes())
            .instances(1)
            .build(),
        script: script.into_bytes(),
        next_id: 0,
        ops: ops_tx,
        events: event_tx,
        replies: reply_rx,
        released: released_tx,
        staged: None,
        log_lines: 0,
        logs_full: Arc::clone(&logs_full),
    };
    let guest: GuestRun = Box::pin(async move {
        let mut store = Store::new(&runtime.engine, state);
        store.limiter(|state| &mut state.limits);
        store.epoch_deadline_async_yield_and_update(1);
        let instance = runtime
            .pre
            .instantiate_async(&mut store)
            .await
            .map_err(|e| format!("sandbox failed to start: {e}"))?;
        let entry = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| format!("sandbox has no entry point: {e}"))?;
        match entry.call_async(&mut store, ()).await {
            Ok(()) => Ok(()),
            Err(e) => match e.downcast_ref::<wasmtime_wasi::I32Exit>() {
                Some(exit) if exit.0 == 0 => Ok(()),
                _ => Err(trap_message(&e)),
            },
        }
    });
    Ok(Execution {
        guest,
        ops,
        events,
        replies,
        released,
        inflight: FuturesUnordered::new(),
        waiting: WaitingOps::default(),
        running: RunningOps::default(),
        invoker,
        spawn: Arc::new(spawn),
        logs: Vec::new(),
        logs_full,
        agent_id: agent_id.to_owned(),
        suspended_call_id: 0,
        suspended_kind: OpKind::Tool,
    })
}

fn trap_message(error: &wasmtime::Error) -> String {
    if let Some(wasmtime::Trap::MemoryOutOfBounds | wasmtime::Trap::UnreachableCodeReached) =
        error.downcast_ref::<wasmtime::Trap>()
    {
        return "sandbox crashed (it may have run out of memory)".to_owned();
    }
    format!("sandbox crashed: {}", error.root_cause())
}

/// Pump the run until it finishes, pauses, or `deadline` passes.
async fn drive(ex: &mut Execution, deadline: Instant) -> DriveEnd {
    let mut guest_exited = None;
    loop {
        tokio::select! {
            biased;
            event = ex.events.recv() => match event {
                Some(GuestEvent::Log(line)) => {
                    if push_log(&mut ex.logs, &line) {
                        ex.logs_full.store(true, Ordering::Relaxed);
                    }
                }
                Some(GuestEvent::Done { value, is_error }) => return DriveEnd::Done { value, is_error },
                // Every sender lives in the guest state; it is gone only once the
                // guest returned, which the arm below reports.
                None => {
                    return DriveEnd::Failed(
                        guest_exited.take().unwrap_or_else(|| "sandbox exited unexpectedly".to_owned()),
                    );
                }
            },
            // The guest read a reply: its operation's slot goes to the next one.
            Some(kind) = ex.released.recv() => {
                ex.running.release(kind);
                dispatch(ex, deadline);
            }
            // Always drain the channel (the guest only waits in `call` until this
            // arm runs); the queue's own bound fails a runaway program instead.
            Some(op) = ex.ops.recv() => {
                if let Err(message) = accept_op(ex, op, deadline) {
                    return DriveEnd::Failed(message);
                }
            }
            // A settled operation keeps its slot until the guest reads the reply.
            Some((id, kind, result)) = ex.inflight.next(), if !ex.inflight.is_empty() => match result {
                OpResult::Reply(frame) => {
                    let _ = ex.replies.send(Reply {
                        frame: frame.to_string(),
                        slot: Some(kind),
                    });
                }
                OpResult::Suspend(elicitation) => {
                    ex.suspended_call_id = id;
                    ex.suspended_kind = kind;
                    return DriveEnd::Paused(elicitation);
                }
            },
            exit = &mut ex.guest, if guest_exited.is_none() => {
                // Drain what the guest sent before returning; its Done (if any)
                // is still queued. With the channel closed, `recv` ends the loop.
                guest_exited = Some(match exit {
                    Ok(()) => "sandbox exited without a result".to_owned(),
                    Err(message) => message,
                });
            }
            () = tokio::time::sleep_until(deadline) => {
                return DriveEnd::Failed(
                    "execution exceeded the wall-clock deadline and was killed".to_owned(),
                );
            }
        }
    }
}

fn reply_frame(id: u32, outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "id": id, "ok": true, "value": value, "error": null }),
        Err(error) => json!({ "id": id, "ok": false, "value": null, "error": error }),
    }
}

fn reply(id: u32, outcome: Result<Value, String>) -> OpResult {
    OpResult::Reply(reply_frame(id, outcome))
}

/// Parse an operation the guest started and queue it for a slot. A malformed or
/// unknown operation is answered at once; it never takes a slot.
///
/// Errors (ending the run) once the waiting queue would pass [`MAX_QUEUED_OPS`]
/// or [`MAX_QUEUED_OP_BYTES`]: a program that keeps starting operations without
/// awaiting them never reads a result, so no slot would ever free for them.
fn accept_op(ex: &mut Execution, op: GuestOp, deadline: Instant) -> Result<(), String> {
    let GuestOp { id, request } = op;
    let bytes = request.len();
    let parsed = serde_json::from_str::<Value>(&request)
        .map_err(|e| format!("malformed sandbox operation: {e}"))
        .and_then(|request| match OpKind::of(&request) {
            Some(kind) => Ok(PendingOp {
                id,
                kind,
                request,
                bytes,
            }),
            None => Err("unknown sandbox operation".to_owned()),
        });
    match parsed {
        Ok(pending) => {
            if !ex.waiting.push(pending) {
                return Err(format!(
                    "the program started more operations than the sandbox can hold \
                     without awaiting them (at most {MAX_QUEUED_OPS} waiting, \
                     {MAX_QUEUED_OP_BYTES} bytes of requests); await results in \
                     smaller batches"
                ));
            }
            dispatch(ex, deadline);
        }
        Err(error) => {
            let _ = ex.replies.send(Reply {
                frame: reply_frame(id, Err(error)).to_string(),
                slot: None,
            });
        }
    }
    Ok(())
}

/// Start waiting operations while their kind has a free slot, oldest first
/// within each kind. A kind at its cap does not hold back the others.
fn dispatch(ex: &mut Execution, deadline: Instant) {
    for kind in [OpKind::Tool, OpKind::Spawn, OpKind::Sleep] {
        while !ex.waiting.queue(kind).is_empty() && ex.running.try_claim(kind) {
            let Some(pending) = ex.waiting.pop(kind) else {
                break;
            };
            let op = start_op(ex, pending, deadline);
            ex.inflight.push(op);
        }
    }
}

fn start_op(ex: &Execution, op: PendingOp, deadline: Instant) -> OpRun {
    let PendingOp {
        id, kind, request, ..
    } = op;
    match kind {
        OpKind::Tool => {
            let invoker = Arc::clone(&ex.invoker);
            let path = request
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = request.get("args").cloned().unwrap_or(Value::Null);
            Box::pin(async move {
                let result = match invoker.invoke(ToolInvocation { path, args }).await {
                    InvokeOutcome::Result(r) if r.is_error => reply(
                        id,
                        Err(r.error.unwrap_or_else(|| "tool call failed".to_owned())),
                    ),
                    // Tool output re-enters the program (and possibly the model):
                    // cap + strip it on the way in (security MED).
                    InvokeOutcome::Result(r) => reply(id, Ok(sanitize_tool_value(&r.value))),
                    InvokeOutcome::Suspend(elicitation) => OpResult::Suspend(elicitation),
                };
                (id, kind, result)
            })
        }
        OpKind::Sleep => {
            let ms = request
                .get("ms")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let wake = (Instant::now() + Duration::from_millis(ms as u64)).min(deadline);
            Box::pin(async move {
                tokio::time::sleep_until(wake).await;
                (id, kind, reply(id, Ok(Value::Null)))
            })
        }
        OpKind::Spawn => {
            let policy = Arc::clone(&ex.spawn);
            Box::pin(async move { (id, kind, reply(id, run_child(&policy, &request).await)) })
        }
    }
}

/// `childProcess.run`: start one host-approved program with the scrubbed env
/// plus the host's purpose-minted extras, and collect its bounded output.
async fn run_child(policy: &SpawnPolicy, request: &Value) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let program = request
        .get("program")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Names only (the host allow-lists capability shims by name); a path could
    // name any binary on the machine.
    let named = !program.is_empty() && !program.contains(['/', '\\']);
    if !named || !policy.allow.iter().any(|allowed| allowed == program) {
        return Err(format!(
            "child process '{program}' is not permitted for this sandbox"
        ));
    }
    let args: Vec<String> = request
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let stdin = request.get("stdin").and_then(Value::as_str);

    let mut env = crate::scrub_env(std::env::vars().collect());
    env.extend(policy.extra_env.iter().cloned());
    let mut command = tokio::process::Command::new(spawn_target(program, &env));
    command
        .args(&args)
        .env_clear()
        .envs(env)
        .stdin(if stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start '{program}': {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let input = input.to_owned();
        tokio::spawn(async move {
            let _ = pipe.write_all(input.as_bytes()).await;
        });
    }
    let mut stdout = child.stdout.take().map(|s| s.take(MAX_CHILD_OUTPUT_BYTES));
    let mut stderr = child.stderr.take().map(|s| s.take(MAX_CHILD_OUTPUT_BYTES));
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let read_out = async {
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_end(&mut out).await;
        }
    };
    let read_err = async {
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_end(&mut err).await;
        }
    };
    tokio::join!(read_out, read_err);
    let status = child
        .wait()
        .await
        .map_err(|e| format!("failed to wait for '{program}': {e}"))?;
    Ok(json!({
        "code": status.code(),
        "success": status.success(),
        "stdout": String::from_utf8_lossy(&out),
        "stderr": String::from_utf8_lossy(&err),
    }))
}

/// What to hand `Command::new` for an allow-listed bare `program` name.
///
/// On Windows, Rust's process spawning only appends `.exe` to an extension-less
/// name; it ignores `PATHEXT`. The capability shims the host allow-lists are
/// `.cmd` files invoked by base name (`ryu-cap` → `ryu-cap.cmd`), so resolve the
/// name against the child's own `PATH` + `PATHEXT` first. Elsewhere, and when
/// nothing matches, the bare name is spawned as before.
///
/// The program's arguments come from the sandboxed script. Spawning a resolved
/// `.cmd`/`.bat` runs it through `cmd.exe`, and std escapes those arguments (or
/// refuses ones it cannot quote safely) since Rust 1.77.2, well below the
/// toolchain wasmtime already requires.
fn spawn_target(program: &str, env: &[(String, String)]) -> std::path::PathBuf {
    if cfg!(windows) {
        let lookup = |key: &str| {
            env.iter()
                .rev()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.as_str())
        };
        if let Some(path) = lookup("PATH") {
            let extensions = lookup("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
            if let Some(found) = find_on_path(program, path, extensions) {
                return found;
            }
        }
    }
    std::path::PathBuf::from(program)
}

/// The first `<dir>/<program><ext>` on `path` (split the platform's way) that is
/// a file, trying each `extensions` entry (a `PATHEXT`-style `;` list). A name
/// that already carries an extension is tried as written first.
fn find_on_path(program: &str, path: &str, extensions: &str) -> Option<std::path::PathBuf> {
    let has_extension = std::path::Path::new(program).extension().is_some();
    let extensions: Vec<&str> = extensions
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if has_extension {
            let exact = dir.join(program);
            if exact.is_file() {
                return Some(exact);
            }
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Program shapes ──────────────────────────────────────────────────────────

/// The bootstrap every script starts with: it captures the guest's raw imports,
/// then defines the program-facing globals on top of them.
const BOOTSTRAP: &str = r#""use strict";
const __ryu = (() => {
    const call = globalThis.__ryu_call;
    const log = globalThis.__ryu_log;
    const done = globalThis.__ryu_done;
    delete globalThis.__ryu_call;
    delete globalThis.__ryu_log;
    delete globalThis.__ryu_done;
    // Pending operations keyed by id; the guest hands each host reply here.
    const pending = new Map();
    globalThis.__ryu_settle = (line) => {
        const reply = JSON.parse(line);
        const p = pending.get(reply.id);
        if (!p) return;
        pending.delete(reply.id);
        if (reply.ok) p.resolve(reply.value);
        else p.reject(new Error(reply.error || "operation failed"));
    };
    const op = (request) => new Promise((resolve, reject) => {
        pending.set(call(JSON.stringify(request)), { resolve, reject });
    });
    return { op, log, done };
})();
{
    const format = (args) => args
        .map((x) => typeof x === "string" ? x : String(JSON.stringify(x)))
        .join(" ");
    const write = (...args) => __ryu.log(format(args));
    globalThis.console = { log: write, info: write, warn: write, error: write, debug: write };
    let timerSeq = 0;
    const cleared = new Set();
    globalThis.setTimeout = (fn, ms, ...args) => {
        const timer = ++timerSeq;
        __ryu.op({ kind: "sleep", ms: Number(ms) || 0 }).then(() => {
            if (!cleared.delete(timer)) fn(...args);
        });
        return timer;
    };
    globalThis.clearTimeout = (timer) => { cleared.add(timer); };
    globalThis.setInterval = (fn, ms, ...args) => {
        const timer = ++timerSeq;
        const tick = () => __ryu.op({ kind: "sleep", ms: Number(ms) || 0 }).then(() => {
            if (cleared.delete(timer)) return;
            fn(...args);
            tick();
        });
        tick();
        return timer;
    };
    globalThis.clearInterval = globalThis.clearTimeout;
    globalThis.queueMicrotask ??= (fn) => { Promise.resolve().then(fn); };
    globalThis.childProcess = {
        run: (program, options = {}) => __ryu.op({
            kind: "spawn",
            program: String(program),
            args: (options.args ?? []).map(String),
            stdin: options.stdin == null ? null : String(options.stdin),
        }),
    };
}
{
    // WHATWG URL / URLSearchParams over the guest's `url` crate helpers.
    const parse = globalThis.__ryu_url_parse;
    const setField = globalThis.__ryu_url_set;
    const parseQuery = globalThis.__ryu_query_parse;
    const serializeQuery = globalThis.__ryu_query_serialize;
    delete globalThis.__ryu_url_parse;
    delete globalThis.__ryu_url_set;
    delete globalThis.__ryu_query_parse;
    delete globalThis.__ryu_query_serialize;
    const LINK = Symbol("url");
    const parseWith = (input, base) => (base === undefined ? parse(String(input)) : parse(String(input), String(base)));
    const pairsOf = (query) => {
        const flat = JSON.parse(parseQuery(query));
        const pairs = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
        return pairs;
    };
    class URLSearchParams {
        #pairs;
        constructor(init = "") {
            if (init instanceof URLSearchParams) this.#pairs = [...init].map(([k, v]) => [k, v]);
            else if (typeof init === "string") this.#pairs = pairsOf(init.startsWith("?") ? init.slice(1) : init);
            else if (init != null && typeof init[Symbol.iterator] === "function") this.#pairs = Array.from(init, ([k, v]) => [String(k), String(v)]);
            else if (init != null && typeof init === "object") this.#pairs = Object.entries(init).map(([k, v]) => [String(k), String(v)]);
            else this.#pairs = [];
        }
        #changed() { this[LINK]?.(this.toString()); }
        get size() { return this.#pairs.length; }
        append(k, v) { this.#pairs.push([String(k), String(v)]); this.#changed(); }
        delete(k, v) {
            k = String(k);
            this.#pairs = this.#pairs.filter(([pk, pv]) => pk !== k || (v !== undefined && pv !== String(v)));
            this.#changed();
        }
        get(k) { k = String(k); return this.#pairs.find(([pk]) => pk === k)?.[1] ?? null; }
        getAll(k) { k = String(k); return this.#pairs.filter(([pk]) => pk === k).map(([, v]) => v); }
        has(k, v) { k = String(k); return this.#pairs.some(([pk, pv]) => pk === k && (v === undefined || pv === String(v))); }
        set(k, v) {
            k = String(k);
            const i = this.#pairs.findIndex(([pk]) => pk === k);
            if (i < 0) this.#pairs.push([k, String(v)]);
            else this.#pairs = this.#pairs.filter(([pk], j) => j <= i || pk !== k).map((p, j) => (j === i ? [k, String(v)] : p));
            this.#changed();
        }
        sort() { this.#pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); this.#changed(); }
        forEach(fn, thisArg) { for (const [k, v] of this.#pairs) fn.call(thisArg, v, k, this); }
        keys() { return this.#pairs.map(([k]) => k)[Symbol.iterator](); }
        values() { return this.#pairs.map(([, v]) => v)[Symbol.iterator](); }
        entries() { return this.#pairs.map(([k, v]) => [k, v])[Symbol.iterator](); }
        [Symbol.iterator]() { return this.entries(); }
        toString() { return serializeQuery(...this.#pairs.flat()); }
    }
    class URL {
        #parts;
        #params;
        constructor(input, base) {
            const record = parseWith(input, base);
            if (record == null) throw new TypeError(`Invalid URL: ${String(input)}`);
            this.#parts = JSON.parse(record);
        }
        static canParse(input, base) {
            return parseWith(input, base) != null;
        }
        #set(field, value) {
            const record = setField(this.#parts[0], field, String(value));
            if (record == null) {
                if (field === "href") throw new TypeError(`Invalid URL: ${String(value)}`);
                return;
            }
            this.#parts = JSON.parse(record);
            // A params object handed out earlier stays live: rebuild it from the
            // new query unless the change came from the params themselves.
            if (this.#params && !this.#syncing) this.#params = this.#linkParams();
        }
        #syncing = false;
        #linkParams() {
            const params = new URLSearchParams(this.#parts[9]);
            params[LINK] = (query) => {
                this.#syncing = true;
                try { this.#set("search", query); } finally { this.#syncing = false; }
            };
            return params;
        }
        get searchParams() {
            this.#params ??= this.#linkParams();
            return this.#params;
        }
        get href() { return this.#parts[0]; }
        set href(value) { this.#set("href", value); }
        get origin() { return this.#parts[1]; }
        get protocol() { return this.#parts[2]; }
        set protocol(value) { this.#set("protocol", value); }
        get username() { return this.#parts[3]; }
        set username(value) { this.#set("username", value); }
        get password() { return this.#parts[4]; }
        set password(value) { this.#set("password", value); }
        get host() { return this.#parts[5]; }
        set host(value) { this.#set("host", value); }
        get hostname() { return this.#parts[6]; }
        set hostname(value) { this.#set("hostname", value); }
        get port() { return this.#parts[7]; }
        set port(value) { this.#set("port", value); }
        get pathname() { return this.#parts[8]; }
        set pathname(value) { this.#set("pathname", value); }
        get search() { return this.#parts[9]; }
        set search(value) { this.#set("search", value); }
        get hash() { return this.#parts[10]; }
        set hash(value) { this.#set("hash", value); }
        toString() { return this.#parts[0]; }
        toJSON() { return this.#parts[0]; }
    }
    globalThis.URL = URL;
    globalThis.URLSearchParams = URLSearchParams;
}
const tools = new Proxy({}, {
    get: (_t, server) => new Proxy({}, {
        get: (_u, tool) => (args) => __ryu.op({
            kind: "tool",
            path: String(server) + "." + String(tool),
            args: args ?? {},
        }),
    }),
});
"#;

/// The tool-bridge program: bootstrap + `user_code` as an async function body
/// whose return value is the result. A throw is a terminal error, never a
/// silent success.
fn build_program(user_code: &str) -> String {
    format!(
        r#"{BOOTSTRAP}
(async () => {{
    let __result = null;
    try {{
        __result = await (async () => {{
{user_code}
        }})();
    }} catch (e) {{
        __ryu.done(e && e.message ? e.message : String(e), true);
        return;
    }}
    let __json;
    try {{
        __json = JSON.stringify(__result ?? null);
    }} catch (e) {{
        __ryu.done("program returned a non-serializable value: " + (e && e.message ? e.message : String(e)), true);
        return;
    }}
    __ryu.done(__json ?? "null", false);
}})();
"#
    )
}

/// The eval-function program: `ctx` bound to the payload; `source` runs as a
/// function body, falling back to an expression (Promptfoo's inline form) when
/// the body returned `undefined`.
fn build_eval_program(user_source: &str, payload: &Value) -> String {
    let ctx_json = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_owned());
    let source_json = serde_json::to_string(user_source).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        r#"{BOOTSTRAP}
const __ctx = {ctx_json};
(async () => {{
    let __out;
    try {{
        __out = await (async (ctx) => {{
const input = ctx?.input;
const output = ctx?.output;
const expected = ctx?.expected;
const vars = ctx?.vars ?? {{}};
const context = ctx ?? {{}};
const metadata = ctx?.metadata ?? {{}};
{user_source}
        }})(__ctx);
        if (__out === undefined) {{
            try {{
                __out = await (async (ctx) => {{
const input = ctx?.input;
const output = ctx?.output;
const expected = ctx?.expected;
const vars = ctx?.vars ?? {{}};
const context = ctx ?? {{}};
const metadata = ctx?.metadata ?? {{}};
return eval({source_json});
                }})(__ctx);
            }} catch (_) {{
                // Statement-form source with no return remains an invalid result.
            }}
        }}
    }} catch (e) {{
        __ryu.done(e && e.message ? e.message : String(e), true);
        return;
    }}
    try {{
        __ryu.done(JSON.stringify(__out ?? null) ?? "null", false);
    }} catch (e) {{
        __ryu.done("evaluator returned a non-serializable value: " + (e && e.message ? e.message : String(e)), true);
    }}
}})();
"#
    )
}

// ── Public entry points ─────────────────────────────────────────────────────

/// A permission the sandbox cannot grant: it has no filesystem or network to
/// open. Refusing is the honest answer — silently running deny-all would let a
/// tool that depends on the grant fail in a confusing way.
fn unsupported_permission(
    permissions: Option<&ryu_kernel_contracts::manifest::PermissionSet>,
) -> Option<&'static str> {
    use ryu_kernel_contracts::manifest::NetworkPermission;
    let p = permissions?;
    if !p.fs.read.is_empty() || !p.fs.write.is_empty() {
        return Some("filesystem");
    }
    match &p.network {
        NetworkPermission::All(true) => Some("network"),
        NetworkPermission::Hosts(hosts) if !hosts.is_empty() => Some("network"),
        _ => None,
    }
}

/// Run `code` (an async function body using `tools.*`) to completion or to a
/// pause. See [`crate::run_sandboxed_with_augment_and_deadline`].
pub async fn execute(
    code: &str,
    invoker: Arc<SandboxToolInvoker>,
    agent_id: &str,
    permissions: Option<&ryu_kernel_contracts::manifest::PermissionSet>,
    augment: &SandboxAugment,
    deadline: Duration,
) -> ExecOutcome {
    if let Some(kind) = unsupported_permission(permissions) {
        return ExecOutcome::error(format!(
            "the JavaScript sandbox has no {kind} access; move work that needs it into a sidecar \
             or MCP server and call it as a tool"
        ));
    }
    let spawn = match permissions {
        Some(p) if p.child_process => SpawnPolicy {
            allow: augment.run_allow.clone(),
            extra_env: augment.extra_env.clone(),
        },
        _ => SpawnPolicy::default(),
    };
    let mut ex = match start(build_program(code), invoker, agent_id, spawn) {
        Ok(ex) => ex,
        Err(e) => return ExecOutcome::error(e),
    };
    let end = drive(&mut ex, Instant::now() + deadline).await;
    finish(ex, end)
}

fn finish(mut ex: Execution, end: DriveEnd) -> ExecOutcome {
    let logs = std::mem::take(&mut ex.logs);
    match end {
        DriveEnd::Done {
            value,
            is_error: false,
        } => ExecOutcome::Completed {
            result: serde_json::from_str::<Value>(&value)
                .ok()
                .flatten_null()
                .map(|v| sanitize_tool_value(&v)),
            logs,
            is_error: false,
            error: None,
        },
        DriveEnd::Done { value: message, .. } | DriveEnd::Failed(message) => {
            ExecOutcome::Completed {
                result: None,
                logs,
                is_error: true,
                // An uncaught throw or a hostile tool's error text: strip + cap
                // it before it re-enters the model (security L1).
                error: Some(sanitize_error(&message)),
            }
        }
        DriveEnd::Paused(elicitation) => {
            ex.logs = logs;
            park(ex, elicitation)
        }
    }
}

fn park(ex: Execution, elicitation: Elicitation) -> ExecOutcome {
    let execution_id = format!("exec_{}", uuid::Uuid::new_v4());
    let message = elicitation.message.clone();
    let evicted = parked_store()
        .lock()
        .expect("parked store poisoned")
        .insert(execution_id.clone(), ex);
    // Over-cap / expired runs drop here, and their guests with them.
    drop(evicted);
    ExecOutcome::Paused {
        execution_id,
        message,
        elicitation,
    }
}

/// Resume a parked run. `Accept` resolves the suspended call with `content`,
/// `Decline` rejects it (the program may catch that), `Cancel` drops the run.
/// An unknown id, or one owned by another agent, is `None` (→ 404).
pub async fn resume_parked(
    execution_id: &str,
    agent_id: &str,
    decision: ResumeDecision,
    content: Value,
) -> Option<ExecOutcome> {
    let mut ex = {
        let mut store = parked_store().lock().expect("parked store poisoned");
        let ex = store.take(execution_id)?;
        // Ownership (security M2): a foreign agent must not drive, or learn the
        // existence of, another agent's run — re-park and answer like unknown.
        if ex.agent_id != agent_id {
            drop(store.insert(execution_id.to_owned(), ex));
            return None;
        }
        ex
    };
    if decision == ResumeDecision::Cancel {
        return Some(ExecOutcome::Completed {
            result: None,
            logs: std::mem::take(&mut ex.logs),
            is_error: true,
            error: Some("execution cancelled".to_owned()),
        });
    }
    let id = ex.suspended_call_id;
    let answer = if decision == ResumeDecision::Accept {
        reply_frame(id, Ok(sanitize_tool_value(&content)))
    } else {
        reply_frame(id, Err("the user declined the requested step".to_owned()))
    };
    // The suspended call kept its slot through the pause; reading this answer
    // frees it.
    let _ = ex.replies.send(Reply {
        frame: answer.to_string(),
        slot: Some(ex.suspended_kind),
    });
    // The human wait does not count: active compute gets a fresh budget.
    let deadline = Instant::now() + Duration::from_secs(DEFAULT_DEADLINE_SECS);
    let end = drive(&mut ex, deadline).await;
    Some(finish(ex, end))
}

/// The bridge an eval function gets: every tool call fails.
struct NoTools;

impl super::SandboxBridge for NoTools {
    fn handle(
        &self,
        _path: String,
        _args: Value,
    ) -> Pin<Box<dyn Future<Output = InvokeOutcome> + Send + '_>> {
        Box::pin(async {
            InvokeOutcome::Result(super::ToolInvokeResult {
                value: Value::Null,
                is_error: true,
                error: Some("eval functions cannot call tools".to_owned()),
            })
        })
    }
}

/// Outcome of running a pure JS eval-evaluator function.
pub enum EvalJsOutcome {
    /// The function returned a JSON value (its `{score,pass?,detail?}`).
    Value(Value),
    /// The function threw, or the sandbox failed. Carries the message.
    Error(String),
}

/// Run a pure eval-evaluator `source` (a function body over `ctx`) with no
/// tools, no permissions and a `deadline`. The value is returned unsanitized:
/// it feeds the eval scorer, not the model.
pub async fn run_eval_js(source: &str, payload: &Value, deadline: Duration) -> EvalJsOutcome {
    let no_tools = Arc::new(SandboxToolInvoker::bridge(Arc::new(NoTools)));
    let program = build_eval_program(source, payload);
    let mut ex = match start(program, no_tools, "eval", SpawnPolicy::default()) {
        Ok(ex) => ex,
        Err(e) => return EvalJsOutcome::Error(e),
    };
    match drive(&mut ex, Instant::now() + deadline).await {
        DriveEnd::Done {
            value,
            is_error: false,
        } => match serde_json::from_str(&value) {
            Ok(v) => EvalJsOutcome::Value(v),
            Err(e) => EvalJsOutcome::Error(format!("unparseable eval output: {e}")),
        },
        DriveEnd::Done { value: message, .. } | DriveEnd::Failed(message) => {
            EvalJsOutcome::Error(message)
        }
        DriveEnd::Paused(_) => EvalJsOutcome::Error("eval functions cannot pause".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolInvokeResult;
    use ryu_kernel_contracts::manifest::{NetworkPermission, PermissionSet};

    fn echo_path_invoker() -> Arc<SandboxToolInvoker> {
        Arc::new(SandboxToolInvoker::mock(Box::new(|call| {
            InvokeOutcome::Result(ToolInvokeResult {
                value: json!({ "path": call.path, "args": call.args }),
                is_error: false,
                error: None,
            })
        })))
    }

    fn suspending_invoker() -> Arc<SandboxToolInvoker> {
        Arc::new(SandboxToolInvoker::mock(Box::new(|_| {
            InvokeOutcome::Suspend(Elicitation {
                kind: "url".into(),
                message: "connect".into(),
                url: Some("https://x".into()),
                requested_schema: None,
            })
        })))
    }

    /// Compile the guest before a timing assertion starts its clock (a one-off
    /// cost per process that an unoptimized test build makes slow).
    fn warm_up() {
        js_runtime().expect("sandbox runtime");
    }

    async fn run(code: &str) -> ExecOutcome {
        run_with(
            code,
            echo_path_invoker(),
            "ryu",
            None,
            Duration::from_secs(10),
        )
        .await
    }

    async fn run_with(
        code: &str,
        invoker: Arc<SandboxToolInvoker>,
        agent: &str,
        permissions: Option<&PermissionSet>,
        deadline: Duration,
    ) -> ExecOutcome {
        execute(
            code,
            invoker,
            agent,
            permissions,
            &SandboxAugment::default(),
            deadline,
        )
        .await
    }

    fn completed(outcome: ExecOutcome) -> (Option<Value>, Vec<String>, bool, Option<String>) {
        match outcome {
            ExecOutcome::Completed {
                result,
                logs,
                is_error,
                error,
            } => (result, logs, is_error, error),
            ExecOutcome::Paused { .. } => panic!("unexpected pause"),
        }
    }

    fn paused_id(outcome: ExecOutcome) -> String {
        match outcome {
            ExecOutcome::Paused { execution_id, .. } => execution_id,
            other => panic!("expected pause, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_value_and_logs() {
        let (result, logs, is_error, _) =
            completed(run("console.log('hi', {a: 1}); return 1 + 2;").await);
        assert!(!is_error);
        assert_eq!(result, Some(json!(3)));
        assert_eq!(logs, vec![r#"hi {"a":1}"#]);
    }

    // Isolation comes from the instance having nothing to reach, not from
    // runtime permission checks: none of the host-reaching globals exist.
    #[tokio::test]
    async fn has_no_host_globals() {
        let (result, ..) = completed(
            run("return [typeof fetch, typeof require, typeof process, typeof Deno, typeof XMLHttpRequest, typeof WebSocket];")
                .await,
        );
        assert_eq!(result, Some(json!(vec!["undefined"; 6])));
    }

    #[tokio::test]
    async fn bridge_imports_are_not_reachable_from_the_program() {
        let (result, ..) = completed(
            run("return [typeof __ryu_call, typeof __ryu_done, typeof __ryu_log];").await,
        );
        assert_eq!(result, Some(json!(["undefined", "undefined", "undefined"])));
    }

    #[tokio::test]
    async fn uncaught_throw_is_error_with_message() {
        let (result, _, is_error, error) = completed(run("throw new Error('boom');").await);
        assert!(is_error);
        assert_eq!(result, None);
        assert_eq!(error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn syntax_error_is_error() {
        let (_, _, is_error, error) = completed(run("return (;").await);
        assert!(is_error);
        assert!(error.unwrap_or_default().to_lowercase().contains("syntax"));
    }

    #[tokio::test]
    async fn tool_roundtrip_preserves_utf8() {
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|c| {
            InvokeOutcome::Result(ToolInvokeResult {
                value: json!({ "path": c.path, "text": "你好 🌍" }),
                is_error: false,
                error: None,
            })
        })));
        let (result, logs, is_error, _) = completed(
            run_with(
                "const v = await tools.s.echo({}); console.log(v.text); return v;",
                invoker,
                "ryu",
                None,
                Duration::from_secs(10),
            )
            .await,
        );
        assert!(!is_error);
        assert_eq!(result, Some(json!({ "path": "s.echo", "text": "你好 🌍" })));
        assert!(logs.iter().any(|line| line == "你好 🌍"));
    }

    #[tokio::test]
    async fn failed_tool_call_rejects_and_is_catchable() {
        let invoker = Arc::new(SandboxToolInvoker::mock(Box::new(|_| {
            InvokeOutcome::Result(ToolInvokeResult {
                value: Value::Null,
                is_error: true,
                error: Some("tool exploded".into()),
            })
        })));
        let (result, ..) = completed(
            run_with(
                "try { await tools.s.x({}); } catch (e) { return 'caught: ' + e.message; }",
                invoker,
                "ryu",
                None,
                Duration::from_secs(10),
            )
            .await,
        );
        assert_eq!(result, Some(json!("caught: tool exploded")));
    }

    // Replies are matched to calls by id, so concurrent calls cannot cross.
    #[tokio::test]
    async fn concurrent_fanout_matches_replies_by_id() {
        let (result, ..) = completed(
            run("const [a, b, c] = await Promise.all([tools.s.alpha({}), tools.s.beta({}), tools.s.gamma({})]); return [a.path, b.path, c.path];")
                .await,
        );
        assert_eq!(result, Some(json!(["s.alpha", "s.beta", "s.gamma"])));
    }

    // Operations run concurrently: three 300ms waits finish in ~300ms, not 900.
    #[tokio::test]
    async fn operations_run_concurrently() {
        warm_up();
        let started = std::time::Instant::now();
        let (result, ..) = completed(
            run("const wait = () => new Promise(r => setTimeout(r, 300)); await Promise.all([wait(), wait(), wait()]); return 'ok';")
                .await,
        );
        assert_eq!(result, Some(json!("ok")));
        assert!(
            started.elapsed() < Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn cpu_runaway_is_dropped_at_the_deadline() {
        warm_up();
        let started = std::time::Instant::now();
        let (_, _, is_error, error) = completed(
            run_with(
                "while (true) {}",
                echo_path_invoker(),
                "ryu",
                None,
                Duration::from_millis(300),
            )
            .await,
        );
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("deadline"));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    // A result is final even while guest timers are still pending.
    #[tokio::test]
    async fn terminal_result_does_not_wait_for_lingering_timers() {
        let (result, ..) = completed(
            run_with(
                "setInterval(() => {}, 60_000); return 7;",
                echo_path_invoker(),
                "ryu",
                None,
                Duration::from_secs(2),
            )
            .await,
        );
        assert_eq!(result, Some(json!(7)));
        let (_, _, is_error, error) = completed(
            run_with(
                "setInterval(() => {}, 60_000); throw new Error('timer-boom');",
                echo_path_invoker(),
                "ryu",
                None,
                Duration::from_secs(2),
            )
            .await,
        );
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("timer-boom"));
    }

    #[tokio::test]
    async fn timers_fire_in_order_and_can_be_cleared() {
        let (result, ..) = completed(
            run("const out = []; const t = setTimeout(() => out.push('cleared'), 10); clearTimeout(t); \
                 await new Promise(r => { setTimeout(() => { out.push('b'); r(); }, 40); setTimeout(() => out.push('a'), 5); }); return out;")
                .await,
        );
        assert_eq!(result, Some(json!(["a", "b"])));
    }

    #[tokio::test]
    async fn awaiting_nothing_fails_fast_instead_of_hanging() {
        warm_up();
        let started = std::time::Instant::now();
        let (_, _, is_error, error) = completed(run("await new Promise(() => {});").await);
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("nothing will settle"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn memory_cap_fails_the_run_not_the_host() {
        let (_, _, is_error, _) = completed(
            run("const parts = []; while (true) parts.push('x'.repeat(1 << 20) + parts.length);")
                .await,
        );
        assert!(is_error);
        // The host is fine: the next run works.
        let (result, ..) = completed(run("return 'still alive';").await);
        assert_eq!(result, Some(json!("still alive")));
    }

    #[tokio::test]
    async fn oversized_frames_are_bounded() {
        // A huge log line is truncated, not fatal.
        let (result, logs, is_error, _) =
            completed(run("console.log('x'.repeat(200000)); return 1;").await);
        assert!(!is_error);
        assert_eq!(result, Some(json!(1)));
        assert!(logs[0].len() <= MAX_PROTOCOL_FRAME_BYTES);
        // A huge operation is refused.
        let (_, _, is_error, error) =
            completed(run("await tools.s.x({ blob: 'x'.repeat(200000) });").await);
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("limit"));
    }

    #[tokio::test]
    async fn filesystem_and_network_grants_are_refused() {
        let mut fs = PermissionSet::default();
        fs.fs.read.push("/tmp".into());
        let (_, _, is_error, error) = completed(
            run_with(
                "return 1;",
                echo_path_invoker(),
                "ryu",
                Some(&fs),
                Duration::from_secs(5),
            )
            .await,
        );
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("filesystem"));

        let net = PermissionSet {
            network: NetworkPermission::Hosts(vec!["api.example.com".into()]),
            ..PermissionSet::default()
        };
        let (_, _, is_error, error) = completed(
            run_with(
                "return 1;",
                echo_path_invoker(),
                "ryu",
                Some(&net),
                Duration::from_secs(5),
            )
            .await,
        );
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("network"));

        // An empty set is the deny-all default and runs.
        let (result, ..) = completed(
            run_with(
                "return 1;",
                echo_path_invoker(),
                "ryu",
                Some(&PermissionSet::default()),
                Duration::from_secs(5),
            )
            .await,
        );
        assert_eq!(result, Some(json!(1)));
    }

    #[tokio::test]
    async fn child_process_needs_grant_and_allow_list() {
        let code = "try { await childProcess.run('echo', { args: ['hi'] }); return 'ran'; } catch (e) { return e.message; }";
        // No grant.
        let (result, ..) = completed(run(code).await);
        assert!(result.unwrap().as_str().unwrap().contains("not permitted"));
        // Granted but the host listed nothing.
        let granted = PermissionSet {
            child_process: true,
            ..PermissionSet::default()
        };
        let (result, ..) = completed(
            run_with(
                code,
                echo_path_invoker(),
                "ryu",
                Some(&granted),
                Duration::from_secs(5),
            )
            .await,
        );
        assert!(result.unwrap().as_str().unwrap().contains("not permitted"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_process_runs_allow_listed_names_only() {
        let granted = PermissionSet {
            child_process: true,
            ..PermissionSet::default()
        };
        let augment = SandboxAugment {
            run_allow: vec!["echo".into()],
            extra_env: vec![("RYU_PROBE".into(), "1".into())],
        };
        let outcome = execute(
            "const r = await childProcess.run('echo', { args: ['hi', 'there'] }); \
             let byPath = ''; try { await childProcess.run('/bin/echo', {}); } catch (e) { byPath = e.message; } \
             let other = ''; try { await childProcess.run('ls', {}); } catch (e) { other = e.message; } \
             return { r, byPath, other };",
            echo_path_invoker(),
            "ryu",
            Some(&granted),
            &augment,
            Duration::from_secs(10),
        )
        .await;
        let (result, _, is_error, error) = completed(outcome);
        assert!(!is_error, "{error:?}");
        let result = result.unwrap();
        assert_eq!(result["r"]["stdout"], "hi there\n");
        assert_eq!(result["r"]["success"], true);
        assert!(result["byPath"].as_str().unwrap().contains("not permitted"));
        assert!(result["other"].as_str().unwrap().contains("not permitted"));
    }

    #[tokio::test]
    async fn pause_then_accept_completes_with_fresh_deadline() {
        let exec_id = paused_id(
            run_with(
                "const r = await tools.composio.NEEDS_AUTH({}); return r.ok;",
                suspending_invoker(),
                "ryu",
                None,
                Duration::from_millis(200),
            )
            .await,
        );
        // The human wait outlasts the active-compute deadline; it must not count.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let resumed = resume_parked(
            &exec_id,
            "ryu",
            ResumeDecision::Accept,
            json!({ "ok": true }),
        )
        .await
        .expect("known execution id");
        let (result, _, is_error, _) = completed(resumed);
        assert!(!is_error);
        assert_eq!(result, Some(json!(true)));
    }

    #[tokio::test]
    async fn resume_decline_rejects_the_call() {
        let exec_id = paused_id(
            run_with(
                "return await tools.composio.NEEDS_AUTH({});",
                suspending_invoker(),
                "ryu",
                None,
                Duration::from_secs(5),
            )
            .await,
        );
        let resumed = resume_parked(&exec_id, "ryu", ResumeDecision::Decline, json!({}))
            .await
            .expect("known execution id");
        let (_, _, is_error, error) = completed(resumed);
        assert!(is_error);
        assert!(error.unwrap_or_default().contains("declined"));
    }

    // A busy guest that fired an eliciting call without awaiting it must still
    // pause promptly; while parked its future is not polled, so it cannot run.
    #[tokio::test]
    async fn busy_guest_pauses_promptly_and_cancels() {
        warm_up();
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            run_with(
                "void tools.composio.NEEDS_AUTH({}); while (true) {}",
                suspending_invoker(),
                "ryu",
                None,
                Duration::from_secs(10),
            ),
        )
        .await
        .expect("elicitation must pause promptly");
        let exec_id = paused_id(outcome);
        let cancelled = resume_parked(&exec_id, "ryu", ResumeDecision::Cancel, json!({}))
            .await
            .expect("known execution");
        let (_, _, is_error, error) = completed(cancelled);
        assert!(is_error);
        assert_eq!(error.as_deref(), Some("execution cancelled"));
        // Cancel consumed it.
        assert!(
            resume_parked(&exec_id, "ryu", ResumeDecision::Accept, json!({}))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn resume_unknown_id_is_none() {
        assert!(resume_parked(
            "exec_does_not_exist",
            "ryu",
            ResumeDecision::Accept,
            json!({})
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn resume_rejects_foreign_agent() {
        let exec_id = paused_id(
            run_with(
                "const r = await tools.composio.NEEDS_AUTH({}); return r.ok;",
                suspending_invoker(),
                "owner-agent",
                None,
                Duration::from_secs(5),
            )
            .await,
        );
        assert!(resume_parked(
            &exec_id,
            "attacker-agent",
            ResumeDecision::Accept,
            json!({ "ok": true })
        )
        .await
        .is_none());
        let owned = resume_parked(
            &exec_id,
            "owner-agent",
            ResumeDecision::Accept,
            json!({ "ok": true }),
        )
        .await
        .expect("owner can resume");
        assert_eq!(completed(owned).0, Some(json!(true)));
    }

    /// Records the run state every bridged call sees. Its first call reads
    /// private data and then needs a connect step, which pauses the program.
    #[derive(Default)]
    struct FlowRecordingCaller {
        seen: std::sync::Mutex<Vec<(String, usize, Option<String>)>>,
    }

    #[async_trait::async_trait]
    impl crate::ToolCaller for FlowRecordingCaller {
        async fn call_tool_with_identity(
            &self,
            _agent_id: Option<&str>,
            tool_id: &str,
            _arguments: Value,
            _allowlist: Option<&[String]>,
            _user_id: Option<&str>,
            _profile_ids: &[String],
            _session_id: Option<String>,
            _host_conversation_id: Option<&str>,
            data_flow: &Arc<crate::RunDataFlow>,
        ) -> Result<Value, String> {
            let first = self.seen.lock().unwrap().is_empty();
            if first {
                data_flow.mark_private_read(tool_id);
            }
            self.seen.lock().unwrap().push((
                tool_id.to_owned(),
                Arc::as_ptr(data_flow) as usize,
                data_flow.private_read_source().map(str::to_owned),
            ));
            if first {
                return Ok(json!({ "__ryu_elicitation__": { "message": "connect" } }));
            }
            Ok(json!({ "ok": true }))
        }
    }

    // The exfiltration guard's per-run state must outlive a pause: a program that
    // read private data, paused for a connect step and resumed is still the same
    // run, so its later egress call must still see the earlier read.
    #[tokio::test]
    async fn run_data_flow_survives_pause_and_resume() {
        let caller = Arc::new(FlowRecordingCaller::default());
        let invoker = Arc::new(SandboxToolInvoker::registry(
            caller.clone(),
            "ryu".into(),
            None,
            None,
        ));
        let exec_id = paused_id(
            run_with(
                "await tools.search_conversations.search({ q: 'x' }); \
                 const r = await tools.web.extract({ url: 'https://example.com' }); \
                 return r.ok;",
                invoker,
                "ryu",
                None,
                Duration::from_secs(10),
            )
            .await,
        );
        let resumed = resume_parked(&exec_id, "ryu", ResumeDecision::Accept, json!({}))
            .await
            .expect("known execution id");
        let (result, _, is_error, error) = completed(resumed);
        assert!(!is_error, "{error:?}");
        assert_eq!(result, Some(json!(true)));

        let seen = caller.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1].0, "web.extract");
        assert_eq!(seen[0].1, seen[1].1, "the resumed run keeps its state");
        assert_eq!(seen[1].2.as_deref(), Some("search_conversations.search"));
    }

    // `URL` is spec-exact (the `url` crate), because adapters use it for SSRF
    // checks: the hostname a check reads must be the one a fetch would hit.
    #[tokio::test]
    async fn url_parses_like_the_whatwg_spec() {
        let (result, _, is_error, error) = completed(
            run(r#"
                const pick = (u) => { const x = new URL(u); return [x.protocol, x.hostname, x.port, x.username, x.pathname, x.search, x.hash]; };
                let invalid = '';
                try { new URL('not a url'); } catch (e) { invalid = e.constructor.name; }
                return {
                    plain: pick('https://Example.COM:8443/a/../b?q=1#h'),
                    loopback: new URL('http://0x7f.1/').hostname,
                    ipv6: new URL('http://[::1]:80/').host,
                    creds: pick('https://user:pw@example.com/'),
                    backslash: new URL('http://evil.com\\@good.com/').hostname,
                    relative: new URL('../c', 'https://h.test/a/b/').href,
                    origin: new URL('https://h.test:443/x').origin,
                    invalid,
                    canParse: [URL.canParse('https://x'), URL.canParse('::')],
                };
            "#)
            .await,
        );
        assert!(!is_error, "{error:?}");
        assert_eq!(
            result,
            Some(json!({
                "plain": ["https:", "example.com", "8443", "", "/b", "?q=1", "#h"],
                "loopback": "127.0.0.1",
                "ipv6": "[::1]",
                "creds": ["https:", "example.com", "", "user", "/", "", ""],
                "backslash": "evil.com",
                "relative": "https://h.test/a/c",
                "origin": "https://h.test",
                "invalid": "TypeError",
                "canParse": [true, false],
            }))
        );
    }

    #[tokio::test]
    async fn url_setters_and_search_params_stay_in_sync() {
        let (result, _, is_error, error) = completed(
            run(r#"
                const u = new URL('https://h.test/p?a=1&b=2&a=3');
                const all = u.searchParams.getAll('a');
                u.searchParams.set('a', 'x y');
                u.searchParams.append('c', '&');
                u.pathname = '/new path';
                u.hash = 'frag';
                const params = new URLSearchParams({ k: 'v', z: '1' });
                params.sort();
                return { all, href: u.href, b: u.searchParams.get('b'), params: params.toString(),
                         entries: [...new URLSearchParams('?x=1&y=%20')] };
            "#)
            .await,
        );
        assert!(!is_error, "{error:?}");
        assert_eq!(
            result,
            Some(json!({
                "all": ["1", "3"],
                "href": "https://h.test/new%20path?a=x+y&b=2&c=%26#frag",
                "b": "2",
                "params": "k=v&z=1",
                "entries": [["x", "1"], ["y", " "]],
            }))
        );
    }

    /// A host bridge that records how many calls run at once, holding each call
    /// for `hold` so calls that may overlap really do.
    struct ConcurrencyProbe {
        running: std::sync::atomic::AtomicUsize,
        peak: std::sync::atomic::AtomicUsize,
        /// Every call the host actually started.
        started: std::sync::atomic::AtomicUsize,
        hold: Duration,
    }

    impl ConcurrencyProbe {
        fn holding(hold: Duration) -> Arc<Self> {
            Arc::new(Self {
                running: 0.into(),
                peak: 0.into(),
                started: 0.into(),
                hold,
            })
        }
    }

    impl crate::SandboxBridge for ConcurrencyProbe {
        fn handle(
            &self,
            path: String,
            _args: Value,
        ) -> Pin<Box<dyn Future<Output = InvokeOutcome> + Send + '_>> {
            Box::pin(async move {
                self.started.fetch_add(1, Ordering::SeqCst);
                let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
                self.peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(self.hold).await;
                self.running.fetch_sub(1, Ordering::SeqCst);
                InvokeOutcome::Result(ToolInvokeResult {
                    value: json!(path),
                    is_error: false,
                    error: None,
                })
            })
        }
    }

    // A fan-out far wider than the cap still completes with every reply on its
    // own call, but never runs more than MAX_CONCURRENT_TOOL_CALLS at once. The
    // guest issues all 300 calls before it awaits (so before it reads any
    // result), which also fills the operation channel: its `call` import blocks
    // until the driver drains it, and the rest wait for slots that free only as
    // the program reads results.
    #[tokio::test]
    async fn tool_fanout_is_capped_per_run_and_still_completes() {
        let probe = ConcurrencyProbe::holding(Duration::from_millis(5));
        let bridge: Arc<dyn crate::SandboxBridge> = probe.clone();
        let (result, _, is_error, error) = completed(
            run_with(
                "const out = await Promise.all(Array.from({ length: 300 }, (_, i) => tools.s['t' + i]({}))); \
                 return out.every((path, i) => path === 's.t' + i) ? out.length : 'mismatch';",
                Arc::new(SandboxToolInvoker::bridge(bridge)),
                "ryu",
                None,
                Duration::from_secs(20),
            )
            .await,
        );
        assert!(!is_error, "{error:?}");
        assert_eq!(result, Some(json!(300)));
        let peak = probe.peak.load(Ordering::SeqCst);
        assert!(peak <= MAX_CONCURRENT_TOOL_CALLS, "peak {peak}");
        assert!(peak > 1, "calls must still overlap (peak {peak})");
        assert_eq!(probe.started.load(Ordering::SeqCst), 300);
    }

    // A program that keeps starting calls and never awaits never reads a
    // result. Each finished call keeps its slot until its result is read, so
    // the host starts only MAX_CONCURRENT_TOOL_CALLS of them (rather than
    // running thousands and buffering every result), and once the waiting
    // queue overflows the run fails fast with an actionable error instead of
    // hanging to the deadline.
    #[tokio::test]
    async fn a_fanout_that_never_awaits_is_bounded_and_fails_fast() {
        warm_up();
        let probe = ConcurrencyProbe::holding(Duration::ZERO);
        let bridge: Arc<dyn crate::SandboxBridge> = probe.clone();
        let started = std::time::Instant::now();
        let (result, _, is_error, error) = completed(
            run_with(
                "for (let i = 0; i < 1000000; i++) tools.s.x({}); return 'unreachable';",
                Arc::new(SandboxToolInvoker::bridge(bridge)),
                "ryu",
                None,
                Duration::from_secs(30),
            )
            .await,
        );
        assert!(is_error);
        assert_eq!(result, None);
        let error = error.unwrap_or_default();
        assert!(error.contains("smaller batches"), "{error}");
        assert_eq!(
            probe.started.load(Ordering::SeqCst),
            MAX_CONCURRENT_TOOL_CALLS
        );
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn waiting_ops_bound_both_count_and_bytes() {
        let op = |kind: OpKind, bytes: usize| PendingOp {
            id: 0,
            kind,
            request: Value::Null,
            bytes,
        };
        let mut waiting = WaitingOps::default();
        for _ in 0..MAX_QUEUED_OPS {
            assert!(waiting.push(op(OpKind::Tool, 1)));
        }
        assert!(!waiting.push(op(OpKind::Sleep, 1)), "the count bound");
        assert_eq!(waiting.len, MAX_QUEUED_OPS);
        assert!(waiting.pop(OpKind::Tool).is_some());
        assert!(waiting.pop(OpKind::Spawn).is_none());
        assert!(waiting.push(op(OpKind::Sleep, 1)));

        let mut waiting = WaitingOps::default();
        assert!(waiting.push(op(OpKind::Spawn, MAX_QUEUED_OP_BYTES - 1)));
        assert!(!waiting.push(op(OpKind::Tool, 2)), "the byte bound");
        assert!(waiting.push(op(OpKind::Tool, 1)));
        assert_eq!(waiting.bytes, MAX_QUEUED_OP_BYTES);
        assert_eq!(
            waiting.pop(OpKind::Spawn).map(|op| op.bytes),
            Some(MAX_QUEUED_OP_BYTES - 1)
        );
        assert_eq!(waiting.bytes, 1);
    }

    #[test]
    fn running_ops_caps_each_kind_independently() {
        let mut running = RunningOps::default();
        for _ in 0..MAX_CONCURRENT_TOOL_CALLS {
            assert!(running.try_claim(OpKind::Tool));
        }
        assert!(!running.try_claim(OpKind::Tool));
        // A full kind does not hold back the others.
        for _ in 0..MAX_CONCURRENT_CHILDREN {
            assert!(running.try_claim(OpKind::Spawn));
        }
        assert!(!running.try_claim(OpKind::Spawn));
        assert!(running.try_claim(OpKind::Sleep));
        running.release(OpKind::Tool);
        assert!(running.try_claim(OpKind::Tool));
    }

    // Children are capped too: four 300ms children with at most two alive at a
    // time cannot finish faster than two rounds.
    #[cfg(unix)]
    #[tokio::test]
    async fn child_processes_are_capped_per_run() {
        warm_up();
        let granted = PermissionSet {
            child_process: true,
            ..PermissionSet::default()
        };
        let augment = SandboxAugment {
            run_allow: vec!["sleep".into()],
            extra_env: Vec::new(),
        };
        let started = std::time::Instant::now();
        let outcome = execute(
            "const run = () => childProcess.run('sleep', { args: ['0.3'] }); \
             const all = await Promise.all([run(), run(), run(), run()]); \
             return all.every((r) => r.success);",
            echo_path_invoker(),
            "ryu",
            Some(&granted),
            &augment,
            Duration::from_secs(10),
        )
        .await;
        let (result, _, is_error, error) = completed(outcome);
        assert!(!is_error, "{error:?}");
        assert_eq!(result, Some(json!(true)));
        assert!(
            started.elapsed() >= Duration::from_millis(550),
            "{:?}",
            started.elapsed()
        );
    }

    // Past the log budget, lines are dropped before they are copied out of the
    // guest, and a chatty program still finishes normally with bounded logs.
    #[tokio::test]
    async fn logs_past_the_budget_are_dropped_without_failing_the_run() {
        let (result, logs, is_error, error) = completed(
            run("for (let i = 0; i < 20000; i++) console.log('line ' + i); return 'done';").await,
        );
        assert!(!is_error, "{error:?}");
        assert_eq!(result, Some(json!("done")));
        assert_eq!(logs.first().map(String::as_str), Some("line 0"));
        assert!(logs.len() <= MAX_LOG_LINES);
        assert!(logs.iter().map(String::len).sum::<usize>() <= crate::MAX_PREVIEW_CHARS);
    }

    // On Windows the capability shims are `.cmd` files invoked by base name, and
    // `Command::new` alone would not find them: it ignores PATHEXT.
    #[test]
    fn find_on_path_resolves_a_base_name_through_pathext() {
        let dir = std::env::temp_dir().join(format!("ryu-js-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ryu-cap.cmd"), "@echo off\r\n").unwrap();
        let missing = std::env::temp_dir().join(format!("ryu-js-none-{}", uuid::Uuid::new_v4()));
        let joined = std::env::join_paths([missing.as_path(), dir.as_path()]).unwrap();
        let path = joined.to_str().unwrap();
        let shim = Some(dir.join("ryu-cap.cmd"));
        assert_eq!(find_on_path("ryu-cap", path, ".exe;.cmd"), shim);
        assert_eq!(find_on_path("ryu-cap.cmd", path, ".exe"), shim);
        assert_eq!(find_on_path("ryu-cap", path, ".exe"), None);
        assert_eq!(find_on_path("absent", path, ".exe;.cmd"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The same, end to end: an allow-listed base name starts its `.cmd` shim.
    #[cfg(windows)]
    #[tokio::test]
    async fn child_process_starts_a_cmd_shim_by_base_name() {
        let dir = std::env::temp_dir().join(format!("ryu-js-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ryu-probe.cmd"), "@echo shim-ok\r\n").unwrap();
        let granted = PermissionSet {
            child_process: true,
            ..PermissionSet::default()
        };
        let augment = SandboxAugment {
            run_allow: vec!["ryu-probe".into()],
            extra_env: vec![("PATH".into(), dir.to_string_lossy().into_owned())],
        };
        let outcome = execute(
            "return await childProcess.run('ryu-probe', {});",
            echo_path_invoker(),
            "ryu",
            Some(&granted),
            &augment,
            Duration::from_secs(10),
        )
        .await;
        let (result, _, is_error, error) = completed(outcome);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!is_error, "{error:?}");
        let result = result.unwrap();
        assert_eq!(result["success"], true, "{result}");
        assert!(result["stdout"].as_str().unwrap().contains("shim-ok"));
    }

    // The committed guest is an opaque binary: pin it to the hash recorded next
    // to it, so it cannot change without that change showing up in review.
    // `tools/build-js-guest.sh` rewrites both files together.
    #[test]
    fn embedded_guest_matches_its_recorded_sha256() {
        use sha2::{Digest, Sha256};
        let recorded = include_str!("../assets/ryu_js_guest.wasm.sha256");
        let expected = recorded.split_whitespace().next().expect("a recorded hash");
        let actual: String = Sha256::digest(GUEST_WASM)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            actual, expected,
            "assets/ryu_js_guest.wasm does not match assets/ryu_js_guest.wasm.sha256; \
             rebuild both with tools/build-js-guest.sh"
        );
    }

    #[test]
    fn build_program_embeds_user_code_and_reports_errors() {
        let p = build_program("return 1 + 1;");
        assert!(p.contains("return 1 + 1;"));
        assert!(p.contains("const tools = new Proxy"));
        assert!(p.contains("__ryu.done(e && e.message ? e.message : String(e), true)"));
    }

    #[tokio::test]
    async fn eval_function_and_expression_forms() {
        let payload = json!({ "output": "hello world", "expected": "world" });
        let body = run_eval_js(
            "return { score: output.includes(expected) ? 1 : 0 };",
            &payload,
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(body, EvalJsOutcome::Value(v) if v == json!({ "score": 1 })));
        let expr = run_eval_js("output.includes('hello')", &payload, Duration::from_secs(5)).await;
        assert!(matches!(expr, EvalJsOutcome::Value(v) if v == json!(true)));
        let thrown = run_eval_js("throw new Error('bad')", &payload, Duration::from_secs(5)).await;
        assert!(matches!(thrown, EvalJsOutcome::Error(e) if e == "bad"));
    }

    #[tokio::test]
    async fn eval_cannot_call_tools_and_respects_deadline() {
        let tool = run_eval_js(
            "return await tools.s.x({});",
            &json!({}),
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(tool, EvalJsOutcome::Error(e) if e.contains("cannot call tools")));
        warm_up();
        let started = std::time::Instant::now();
        let spin = run_eval_js("while (true) {}", &json!({}), Duration::from_millis(300)).await;
        assert!(matches!(spin, EvalJsOutcome::Error(e) if e.contains("deadline")));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    // ── Compiled-guest cache ──
    // A tiny module stands in for the guest so these tests do not pay for
    // compiling QuickJS again.

    const TINY_WASM: &[u8] = br#"(module (func (export "f") (result i32) i32.const 7))"#;

    fn fresh_cache_dir() -> PathBuf {
        std::env::temp_dir().join(format!("ryu-js-cache-{}", uuid::Uuid::new_v4().simple()))
    }

    fn cache_files(dir: &Path) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("cache dir")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "cwasm"))
            .collect();
        files.sort();
        files
    }

    fn call_f(engine: &Engine, module: &Module) -> i32 {
        let mut store = Store::new(engine, ());
        let instance = wasmtime::Instance::new(&mut store, module, &[]).expect("instantiate");
        let f = instance
            .get_typed_func::<(), i32>(&mut store, "f")
            .expect("export f");
        f.call(&mut store, ()).expect("call f")
    }

    #[cfg(unix)]
    #[test]
    fn compiled_guest_is_cached_privately_and_reloads() {
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        let compiled = guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        assert_eq!(call_f(&engine, &compiled), 7);

        let files = cache_files(&dir);
        assert_eq!(files.len(), 1, "one cached compile: {files:?}");
        assert_eq!(files[0], dir.join(cache_file_name(&engine, TINY_WASM)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&files[0])
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let loaded = load_cached_guest(&engine, &files[0]).expect("cached compile loads");
        assert_eq!(call_f(&engine, &loaded), 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn damaged_cached_guest_is_ignored_and_rewritten() {
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        let path = dir.join(cache_file_name(&engine, TINY_WASM));
        let mut bytes = std::fs::read(&path).expect("read");
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        std::fs::write(&path, &bytes).expect("damage");
        assert!(
            load_cached_guest(&engine, &path).is_none(),
            "checksum must reject"
        );
        std::fs::write(&path, &bytes[..bytes.len() - 3]).expect("truncate");
        assert!(
            load_cached_guest(&engine, &path).is_none(),
            "truncation must reject"
        );

        let module = guest_module(&engine, TINY_WASM, Some(&dir)).expect("recompile");
        assert_eq!(call_f(&engine, &module), 7);
        assert!(load_cached_guest(&engine, &path).is_some(), "rewritten");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn cached_guest_writable_by_others_is_ignored() {
        use std::os::unix::fs::PermissionsExt;
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        let path = dir.join(cache_file_name(&engine, TINY_WASM));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).expect("chmod");
        assert!(load_cached_guest(&engine, &path).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn caching_a_guest_drops_other_guests_compiles_only() {
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        std::fs::create_dir_all(&dir).expect("dir");
        let stale = dir.join(format!("{CACHE_PREFIX}0000000000000000{CACHE_SUFFIX}"));
        let unrelated = dir.join("notes.txt");
        std::fs::write(&stale, b"old").expect("stale");
        std::fs::write(&unrelated, b"keep").expect("unrelated");

        guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        assert!(!stale.exists());
        assert!(unrelated.exists());
        assert_eq!(
            cache_files(&dir),
            vec![dir.join(cache_file_name(&engine, TINY_WASM))]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn caching_a_guest_drops_orphaned_temp_files_only() {
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        std::fs::create_dir_all(&dir).expect("dir");
        let orphaned = dir.join(format!(".{CACHE_PREFIX}1-dead.tmp"));
        let in_flight = dir.join(format!(".{CACHE_PREFIX}2-live.tmp"));
        std::fs::write(&orphaned, b"partial").expect("orphaned");
        std::fs::write(&in_flight, b"partial").expect("in flight");
        let long_ago = std::time::SystemTime::now() - ORPHANED_TEMP_AGE * 2;
        std::fs::File::options()
            .write(true)
            .open(&orphaned)
            .and_then(|file| file.set_modified(long_ago))
            .expect("age orphaned temp file");

        guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        assert!(
            !orphaned.exists(),
            "a temp file left by a dead writer is swept"
        );
        assert!(
            in_flight.exists(),
            "a recent temp file may belong to a live writer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_cache_trust_matches_platform() {
        assert_eq!(DISK_CACHE_TRUSTED, cfg!(unix));
    }

    #[cfg(not(unix))]
    #[test]
    fn non_unix_never_writes_or_loads_a_disk_guest() {
        let engine = Engine::default();
        let dir = fresh_cache_dir();
        std::fs::create_dir_all(&dir).expect("dir");
        let module = guest_module(&engine, TINY_WASM, Some(&dir)).expect("compile");
        assert_eq!(call_f(&engine, &module), 7);
        assert!(cache_files(&dir).is_empty(), "nothing cached on disk");

        // A planted compile with a valid checksum is neither loaded nor kept.
        let path = dir.join(cache_file_name(&engine, TINY_WASM));
        let artifact = module.serialize().expect("serialize");
        let mut bytes = artifact.clone();
        bytes.extend_from_slice(&cache_checksum(&artifact));
        std::fs::write(&path, &bytes).expect("plant");
        assert!(load_cached_guest(&engine, &path).is_none(), "never trusted");
        let module = guest_module(&engine, TINY_WASM, Some(&dir)).expect("recompile");
        assert_eq!(call_f(&engine, &module), 7);
        assert!(!path.exists(), "planted compile is purged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_name_tracks_guest_bytes_and_engine_settings() {
        let engine = Engine::default();
        let other_guest = br#"(module (func (export "f") (result i32) i32.const 8))"#;
        assert_ne!(
            cache_file_name(&engine, TINY_WASM),
            cache_file_name(&engine, other_guest)
        );
        let mut config = wasmtime::Config::new();
        config.epoch_interruption(true);
        let epoch_engine = Engine::new(&config).expect("engine");
        assert_ne!(
            cache_file_name(&engine, TINY_WASM),
            cache_file_name(&epoch_engine, TINY_WASM)
        );
    }
}

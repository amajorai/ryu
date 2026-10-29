//! Runtime guardrails for Core-owned ACP subprocesses.
//!
//! The Gateway owns the persisted `[acp]` settings because they are node-level
//! policy. Core owns this module because it is the process supervisor: it is the
//! only place that can bound every ACP spawn, reap idle sessions, and report the
//! node's effective hardware-based limit.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sysinfo::System;
use tokio::sync::Notify;

/// Stopped Claude chats resume their own session, so an idle agent can be
/// released sooner than when stopping it lost the conversation.
const DEFAULT_IDLE_TIMEOUT_MINUTES: u64 = 5;
const MIN_IDLE_TIMEOUT_MINUTES: u64 = 1;
const MAX_IDLE_TIMEOUT_MINUTES: u64 = 24 * 60;
const MAX_PARALLEL_AGENTS: u32 = 32;
const MIN_PARALLEL_AGENTS: u32 = 1;
const GIB: u64 = 1024 * 1024 * 1024;
/// Memory budget per running agent: a managed Pi agent (`pi-acp` plus `pi`)
/// peaked near 139 MB RSS in load tests; the rest is headroom for tool children.
const ACP_RAM_PER_AGENT_BYTES: u64 = 192 * 1024 * 1024;
/// Memory kept back for the OS, Core and the Gateway: a quarter of RAM, and
/// never less than 1 GiB.
const ACP_RAM_RESERVE_MIN_BYTES: u64 = GIB;
/// Agents mostly wait on the model (roughly 2.5 CPU-seconds per turn); sixteen
/// concurrent turns on 2 vCPUs kept p95 latency under twice the single-turn
/// baseline, so eight per logical core leaves margin.
const ACP_AGENTS_PER_CPU: u32 = 8;
/// A missed wakeup must never park a queued turn for an instance's whole idle
/// TTL; waiters re-check admission at least this often. Short enough that a
/// waiter notices an idle instance aging past its eviction grace.
const ADMISSION_RECHECK_INTERVAL: Duration = Duration::from_secs(1);
/// An instance that went idle recently is not evicted for a queued turn: its own
/// chat usually sends the next message soon (an agent loop, a workflow, a quick
/// follow-up, plus Core's own work between two turns), and evicting it would
/// only trade one cold start for another. Above the cap that trade repeats on
/// every turn. The grace is this much per admission slot, up to
/// [`EVICTION_IDLE_GRACE_MAX`]: a node with many slots serves many busy chats,
/// while on a one-slot desktop the queued turn is usually the same person
/// switching chats, who should not wait long.
const EVICTION_IDLE_GRACE_PER_SLOT: Duration = Duration::from_secs(1);
/// Measured gaps between an active chat's turns ran to about 10 s on a loaded
/// 2 vCPU node.
const EVICTION_IDLE_GRACE_MAX: Duration = Duration::from_secs(15);
const GATEWAY_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const GATEWAY_REFRESH_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy)]
struct RuntimeConfig {
    idle_timeout_minutes: u64,
    max_parallel_agents: Option<u32>,
    keep_computer_awake: bool,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
            max_parallel_agents: None,
            keep_computer_awake: true,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AcpRuntimeSettings {
    pub idle_timeout: Duration,
    pub idle_timeout_minutes: u64,
    pub max_parallel_agents: Option<u32>,
    pub effective_max_parallel_agents: u32,
    pub auto_max_parallel_agents: u32,
    pub keep_computer_awake: bool,
    pub active_agents: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct HardwareSummary {
    cpu_cores: u32,
    physical_cores: u32,
    total_ram_bytes: u64,
}

struct RuntimeState {
    config: Mutex<RuntimeConfig>,
    admission: AcpAdmission,
    last_gateway_refresh: Mutex<Instant>,
}

struct AcpAdmission {
    state: Mutex<AdmissionState>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct AdmissionState {
    active: u32,
    /// Instances told to exit to free their slot whose permit is not back yet.
    /// Kept under the same lock as `active`, so a waiter never sees an eviction
    /// finished while its slot is still held.
    evictions_in_flight: u32,
    /// Evictions whose slot has come back, ever. A waiter that evicted waits
    /// only for the evictions in flight when it did, not for later ones.
    evictions_completed: u64,
    /// Tickets of queued turns, oldest first; only the head may take a slot.
    queue: VecDeque<u64>,
    next_ticket: u64,
}

/// A permit represents one ACP subprocess that has passed the global admission
/// gate. Dropping it is the single release path, including task cancellation and
/// subprocess startup errors.
pub struct AcpPermit {
    admission: &'static AcpAdmission,
    /// The instance's eviction state; its release ends an eviction in flight
    /// atomically with returning the slot.
    eviction: Option<EvictionFlag>,
}

impl AcpPermit {
    /// Tie this permit to its instance's eviction state.
    pub fn track_eviction(&mut self, eviction: EvictionFlag) {
        self.eviction = Some(eviction);
    }
}

impl Drop for AcpPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.admission.state.lock() {
            state.active = state.active.saturating_sub(1);
            if self
                .eviction
                .as_ref()
                .is_some_and(|eviction| eviction.0.swap(RELEASED, Ordering::AcqRel) == EVICTED)
            {
                state.evictions_in_flight = state.evictions_in_flight.saturating_sub(1);
                state.evictions_completed += 1;
            }
        }
        self.admission.notify.notify_waiters();
    }
}

const LIVE: u8 = 0;
const EVICTED: u8 = 1;
const RELEASED: u8 = 2;

/// Whether an admitted instance has been told to give up its slot, and whether
/// that slot is back. Both transitions happen under the admission lock, so an
/// eviction is counted in flight exactly while its slot is still held.
#[derive(Clone, Default)]
pub struct EvictionFlag(Arc<AtomicU8>);

impl EvictionFlag {
    #[cfg(test)]
    pub fn is_evicted(&self) -> bool {
        self.0.load(Ordering::Acquire) == EVICTED
    }
}

/// Mark an admitted instance evicted and count its slot as on its way back.
/// Call before the instance can observe the eviction. Returns `false`, counting
/// nothing, when the instance already returned its slot (or was already
/// evicted), so no waiter waits for a slot that will not come.
pub fn start_eviction(eviction: &EvictionFlag) -> bool {
    let Ok(mut state) = runtime_state().admission.state.lock() else {
        return false;
    };
    let started = eviction
        .0
        .compare_exchange(LIVE, EVICTED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if started {
        state.evictions_in_flight += 1;
    }
    started
}

/// A queued turn's place in line. Dropping it (admitted or cancelled) leaves
/// the queue and lets the next turn re-check.
struct QueuedTurn {
    admission: &'static AcpAdmission,
    ticket: u64,
}

impl Drop for QueuedTurn {
    fn drop(&mut self) {
        if let Ok(mut state) = self.admission.state.lock() {
            state.queue.retain(|ticket| *ticket != self.ticket);
        }
        self.admission.notify.notify_waiters();
    }
}

fn runtime_state() -> &'static RuntimeState {
    static STATE: OnceLock<RuntimeState> = OnceLock::new();
    STATE.get_or_init(|| RuntimeState {
        config: Mutex::new(RuntimeConfig::default()),
        admission: AcpAdmission {
            state: Mutex::new(AdmissionState::default()),
            notify: Notify::new(),
        },
        last_gateway_refresh: Mutex::new(Instant::now() - Duration::from_secs(60)),
    })
}

fn hardware() -> &'static HardwareSummary {
    static HARDWARE: OnceLock<HardwareSummary> = OnceLock::new();
    HARDWARE.get_or_init(|| {
        let cpu_cores = std::thread::available_parallelism()
            .map(|count| count.get() as u32)
            .unwrap_or(1)
            .max(1);
        let physical_cores = System::physical_core_count()
            .map(|count| count as u32)
            .unwrap_or(cpu_cores)
            .max(1);
        let mut system = System::new();
        system.refresh_memory();
        let (total_ram_bytes, _) = memory_snapshot(&system);
        HardwareSummary {
            cpu_cores,
            physical_cores,
            total_ram_bytes,
        }
    })
}

/// Total and available memory as Core experiences them: the host's numbers,
/// tightened by the memory limit of the cgroup Core runs in. sysinfo reports
/// the host's RAM, so a container limited to 4 GiB on a 64 GiB host would
/// otherwise size the ACP cap for 64 GiB and never see memory pressure before
/// the kernel's OOM killer does.
fn memory_snapshot(system: &System) -> (u64, u64) {
    effective_memory(
        system.total_memory(),
        system.available_memory(),
        cgroup_memory(),
    )
}

/// `cgroup` is `(limit, headroom)`: the tightest memory limit on Core's cgroup
/// or its ancestors, and the least memory left under any of those limits.
fn effective_memory(
    host_total: u64,
    host_available: u64,
    cgroup: Option<(u64, u64)>,
) -> (u64, u64) {
    match cgroup {
        Some((limit, headroom)) if limit > 0 && limit < host_total => {
            (limit, headroom.min(host_available))
        }
        _ => (host_total, host_available),
    }
}

#[cfg(target_os = "linux")]
fn cgroup_memory() -> Option<(u64, u64)> {
    let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let read = |path: &std::path::Path| std::fs::read_to_string(path).ok();
    cgroup_memory_from(&membership, &read)
}

#[cfg(not(target_os = "linux"))]
fn cgroup_memory() -> Option<(u64, u64)> {
    None
}

/// Walks Core's memory cgroup (v1 `memory` controller or v2 unified) up to the
/// mount root and returns `(tightest limit, least headroom)` over every limited
/// cgroup on the way. Headroom is the limit minus usage, not counting inactive
/// file cache, which the kernel reclaims before it OOM-kills; an ancestor shared
/// with siblings can have less of it than Core's own cgroup. Missing directories
/// are skipped, which covers a container that sees only its own cgroup mounted
/// at the root.
#[cfg(any(target_os = "linux", test))]
fn cgroup_memory_from(
    membership: &str,
    read: &dyn Fn(&std::path::Path) -> Option<String>,
) -> Option<(u64, u64)> {
    let mut best: Option<(u64, u64)> = None;
    for line in membership.lines() {
        let mut fields = line.splitn(3, ':');
        let (Some(hierarchy), Some(controllers), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (root, limit_file, usage_file, inactive_key) =
            if hierarchy == "0" && controllers.is_empty() {
                (
                    "/sys/fs/cgroup",
                    "memory.max",
                    "memory.current",
                    "inactive_file",
                )
            } else if controllers.split(',').any(|name| name == "memory") {
                (
                    "/sys/fs/cgroup/memory",
                    "memory.limit_in_bytes",
                    "memory.usage_in_bytes",
                    "total_inactive_file",
                )
            } else {
                continue;
            };
        let mut dir = std::path::Path::new(root).join(path.trim_start_matches('/'));
        loop {
            let limit = read(&dir.join(limit_file)).and_then(|raw| raw.trim().parse::<u64>().ok());
            if let Some(limit) = limit {
                let usage = read(&dir.join(usage_file))
                    .and_then(|raw| raw.trim().parse::<u64>().ok())
                    .unwrap_or(0);
                let inactive = read(&dir.join("memory.stat"))
                    .and_then(|stat| {
                        stat.lines().find_map(|line| {
                            line.strip_prefix(inactive_key)?
                                .strip_prefix(' ')?
                                .trim()
                                .parse::<u64>()
                                .ok()
                        })
                    })
                    .unwrap_or(0);
                let headroom = limit.saturating_sub(usage.saturating_sub(inactive));
                best = Some(best.map_or((limit, headroom), |(tightest, least)| {
                    (tightest.min(limit), least.min(headroom))
                }));
            }
            if dir.as_path() == std::path::Path::new(root) || !dir.pop() {
                break;
            }
        }
    }
    best
}

/// Automatic parallelism sized for agents that spend most of a turn waiting on
/// the model. Memory is the real bound: after reserving a quarter of RAM (at
/// least 1 GiB) for the OS, Core and the Gateway, each running agent gets
/// [`ACP_RAM_PER_AGENT_BYTES`]. CPU allows [`ACP_AGENTS_PER_CPU`] agents per
/// logical core. The result is clamped to `1..=MAX_PARALLEL_AGENTS`, so a
/// 2 vCPU / 4 GiB node (which reports about 3.8 GiB) runs 14 agents at once.
fn calculate_auto_max_parallel_agents(
    cpu_cores: u32,
    physical_cores: u32,
    total_ram_bytes: u64,
) -> u32 {
    let logical_cores = if cpu_cores == 0 {
        physical_cores
    } else {
        cpu_cores
    };
    let cpu_budget = logical_cores.max(1).saturating_mul(ACP_AGENTS_PER_CPU);
    let ram_budget = if total_ram_bytes == 0 {
        1
    } else {
        let reserve = (total_ram_bytes / 4).max(ACP_RAM_RESERVE_MIN_BYTES);
        let slots = total_ram_bytes.saturating_sub(reserve) / ACP_RAM_PER_AGENT_BYTES;
        u32::try_from(slots).unwrap_or(u32::MAX)
    };
    cpu_budget
        .min(ram_budget)
        .clamp(MIN_PARALLEL_AGENTS, MAX_PARALLEL_AGENTS)
}

fn auto_max_parallel_agents() -> u32 {
    let info = hardware();
    calculate_auto_max_parallel_agents(info.cpu_cores, info.physical_cores, info.total_ram_bytes)
}

fn sanitize_config(value: &Value) -> RuntimeConfig {
    let object = value.as_object();
    let idle_timeout_minutes = object
        .and_then(|value| value.get("idle_timeout_minutes"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_MINUTES)
        .clamp(MIN_IDLE_TIMEOUT_MINUTES, MAX_IDLE_TIMEOUT_MINUTES);
    let max_parallel_agents = object
        .and_then(|value| value.get("max_parallel_agents"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (MIN_PARALLEL_AGENTS..=MAX_PARALLEL_AGENTS).contains(value));
    let keep_computer_awake = object
        .and_then(|value| value.get("keep_computer_awake"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    RuntimeConfig {
        idle_timeout_minutes,
        max_parallel_agents,
        keep_computer_awake,
    }
}

fn apply_config(value: &Value) {
    if let Ok(mut config) = runtime_state().config.lock() {
        *config = sanitize_config(value);
    }
    runtime_state().admission.notify.notify_waiters();
}

fn is_local_gateway() -> bool {
    let raw = crate::sidecar::gateway::gateway_url();
    url::Url::parse(&raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "::1")
}

/// Refresh the local file before a new message is routed. This is intentionally
/// limited to loopback gateways; a remote node's local file is not authoritative.
pub fn refresh_from_local_file() {
    if !is_local_gateway() {
        return;
    }
    let path = std::env::var("GATEWAY_CONFIG")
        .map(std::path::PathBuf::from)
        // Same profile-suffixed `<config>/ryu{suffix}/gateway.toml` the Gateway
        // falls back to, so a dev stack never reads the release node's policy.
        .unwrap_or_else(|_| crate::paths::config_dir().join("gateway.toml"));
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = toml::from_str::<toml::Value>(&raw) else {
        return;
    };
    let section = root
        .get("acp")
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| json!({}));
    apply_config(&section);
}

/// Read the Gateway section when Core is serving a remote node or when a config
/// changed outside the desktop. The short cache prevents a burst of new chats
/// from turning the guardrail into a per-message config request.
pub async fn refresh_from_gateway(client: &reqwest::Client) {
    let should_refresh = runtime_state()
        .last_gateway_refresh
        .lock()
        .map(|mut last| {
            if last.elapsed() < GATEWAY_REFRESH_INTERVAL {
                false
            } else {
                *last = Instant::now();
                true
            }
        })
        .unwrap_or(false);
    if !should_refresh {
        return;
    }
    let result = tokio::time::timeout(
        GATEWAY_REFRESH_TIMEOUT,
        crate::sidecar::gateway::fetch_config(client),
    )
    .await;
    if let Ok(Ok(value)) = result {
        if let Some(section) = value.get("acp") {
            apply_config(section);
        }
    }
}

pub fn observe_gateway_config(value: &mut Value) {
    if let Some(section) = value.get("acp").cloned() {
        apply_config(&section);
    }
    let settings = settings();
    let Some(root) = value.as_object_mut() else {
        return;
    };
    let acp = root.entry("acp").or_insert_with(|| json!({}));
    if !acp.is_object() {
        *acp = json!({});
    }
    let object = acp
        .as_object_mut()
        .expect("ACP runtime section is an object");
    object.insert(
        "effective_max_parallel_agents".to_owned(),
        json!(settings.effective_max_parallel_agents),
    );
    object.insert(
        "auto_max_parallel_agents".to_owned(),
        json!(settings.auto_max_parallel_agents),
    );
    object.insert("active_agents".to_owned(), json!(settings.active_agents));
    object.insert(
        "hardware".to_owned(),
        serde_json::to_value(hardware()).unwrap_or_else(|_| json!({})),
    );
}

pub fn observe_gateway_patch(patch: &Value) {
    if let Some(section) = patch.get("acp") {
        apply_config(section);
    }
}

pub fn settings() -> AcpRuntimeSettings {
    let config = runtime_state()
        .config
        .lock()
        .map(|config| *config)
        .unwrap_or_default();
    let auto_max_parallel_agents = auto_max_parallel_agents();
    let effective_max_parallel_agents = config
        .max_parallel_agents
        .unwrap_or(auto_max_parallel_agents)
        .clamp(MIN_PARALLEL_AGENTS, MAX_PARALLEL_AGENTS);
    let active_agents = runtime_state()
        .admission
        .state
        .lock()
        .map(|state| state.active)
        .unwrap_or(0);
    AcpRuntimeSettings {
        idle_timeout: Duration::from_secs(config.idle_timeout_minutes * 60),
        idle_timeout_minutes: config.idle_timeout_minutes,
        max_parallel_agents: config.max_parallel_agents,
        effective_max_parallel_agents,
        auto_max_parallel_agents,
        keep_computer_awake: config.keep_computer_awake,
        active_agents,
    }
}

/// Take a slot for `ticket` if one is free and it is first in line.
fn try_acquire(ticket: u64) -> Option<AcpPermit> {
    let admission = &runtime_state().admission;
    let limit = settings().effective_max_parallel_agents;
    let mut state = admission.state.lock().ok()?;
    if state.active < limit && state.queue.front() == Some(&ticket) {
        state.queue.pop_front();
        state.active += 1;
        return Some(AcpPermit {
            admission,
            eviction: None,
        });
    }
    None
}

fn enqueue(front: bool) -> QueuedTurn {
    let admission = &runtime_state().admission;
    let mut state = admission
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let ticket = state.next_ticket;
    state.next_ticket = state.next_ticket.wrapping_add(1);
    if front {
        state.queue.push_front(ticket);
    } else {
        state.queue.push_back(ticket);
    }
    QueuedTurn { admission, ticket }
}

#[cfg(test)]
fn evictions_in_flight() -> u32 {
    runtime_state()
        .admission
        .state
        .lock()
        .map_or(0, |state| state.evictions_in_flight)
}

/// The completed-evictions count at which every eviction in flight now will
/// have returned its slot.
fn evictions_settled_at() -> u64 {
    runtime_state().admission.state.lock().map_or(0, |state| {
        state.evictions_completed + u64::from(state.evictions_in_flight)
    })
}

fn evictions_completed() -> u64 {
    runtime_state()
        .admission
        .state
        .lock()
        .map_or(0, |state| state.evictions_completed)
}

/// How long an instance must have been idle before a queued turn may evict it,
/// for a node with `limit` admission slots.
pub fn eviction_grace(limit: u32) -> Duration {
    EVICTION_IDLE_GRACE_PER_SLOT
        .saturating_mul(limit.max(1))
        .min(EVICTION_IDLE_GRACE_MAX)
}

/// The idle age a turn that has waited `waited` requires of an instance it
/// evicts. After twice the grace it may evict any idle instance, however
/// recently it went idle, so busy chats that never pause cannot starve it; only
/// sustained overload by chats with no pause between turns gets that far, and
/// each such eviction costs a cold start.
fn eviction_min_idle(waited: Duration, limit: u32) -> Duration {
    let grace = eviction_grace(limit);
    if waited >= grace.saturating_mul(2) {
        Duration::ZERO
    } else {
        grace
    }
}

/// Wait until the current global parallel limit has room, then return a permit.
/// Waiting turns remain in Core rather than spawning their ACP child, which is the
/// important memory bound for old threads waking at the same time. Turns are
/// admitted first come, first served.
///
/// A resident instance holds its permit through its idle TTL, so without help a
/// new chat would queue behind chats nobody is using. When the gate is full,
/// `evict_idle(min_idle)` is asked to close the least-recently-used instance
/// that has been idle at least `min_idle`; its permit returns once that
/// subprocess exits, which wakes this waiter. `min_idle` is the node's
/// [`eviction_grace`] until the turn has waited twice that, so a chat between
/// two quick turns keeps its agent while a queued turn still gets a slot within
/// seconds. Each caller needs one slot, so it evicts once;
/// another waiter can take that freed slot first, so a waiter evicts again once
/// every eviction that was in flight when it evicted has returned its slot.
/// Above the cap, with chats that never pause, twice the grace is the period at
/// which a queued chat takes a slot from a busy one.
///
/// A holder that was still busy at the first check wakes waiters through
/// [`instance_idle`] when it goes idle; the bounded wait is a backstop so a
/// missed notification costs a second, not the holder's idle TTL.
pub async fn acquire(evict_idle: impl FnMut(Duration) -> bool) -> AcpPermit {
    acquire_inner(evict_idle, false).await
}

/// [`acquire`] for a caller that has just retired one of its own resident
/// instances (recorded with [`start_eviction`]). That instance's permit is
/// this caller's slot, so it goes to the front of the line and waits for it like
/// a caller whose eviction is in flight instead of stopping an unrelated chat's
/// idle agent.
pub async fn acquire_after_retiring(evict_idle: impl FnMut(Duration) -> bool) -> AcpPermit {
    acquire_inner(evict_idle, true).await
}

async fn acquire_inner(mut evict_idle: impl FnMut(Duration) -> bool, retired: bool) -> AcpPermit {
    let admission = &runtime_state().admission;
    let queued = enqueue(retired);
    let started = tokio::time::Instant::now();
    // While set, this caller has a slot on its way back (its eviction, or its
    // own retired instance) once the completed count reaches it.
    let mut awaiting = retired.then(evictions_settled_at);
    let mut reported_queued = false;
    loop {
        let notified = admission.notify.notified();
        if let Some(permit) = try_acquire(queued.ticket) {
            drop(queued);
            return permit;
        }
        let may_evict = awaiting.is_none_or(|settled| evictions_completed() >= settled);
        if may_evict {
            let limit = settings().effective_max_parallel_agents;
            if evict_idle(eviction_min_idle(started.elapsed(), limit)) {
                awaiting = Some(evictions_settled_at());
            } else if awaiting.is_none() && !reported_queued {
                reported_queued = true;
                tracing::info!(
                    limit = settings().effective_max_parallel_agents,
                    "ACP admission full with no evictable idle instance; turn is queued"
                );
            }
        }
        let _ = tokio::time::timeout(ADMISSION_RECHECK_INTERVAL, notified).await;
    }
}

/// A pooled instance became idle and may now be evicted for a queued turn.
pub fn instance_idle() {
    runtime_state().admission.notify.notify_waiters();
}

const MEMORY_PRESSURE_INTERVAL: Duration = Duration::from_secs(30);
const MEMORY_PRESSURE_MIN_FREE_BYTES: u64 = 2 * GIB;

/// Free memory is low when less than a tenth of RAM is available, with a floor
/// of 2 GiB capped at a quarter of RAM. The cap matters on small nodes: a flat
/// 2 GiB floor on a 4 GiB node would count normal use by a dozen running agents
/// as pressure and evict warm idle agents every interval.
fn under_memory_pressure(available_bytes: u64, total_bytes: u64) -> bool {
    let floor = MEMORY_PRESSURE_MIN_FREE_BYTES.min(total_bytes / 4);
    total_bytes > 0 && available_bytes < (total_bytes / 10).max(floor)
}

/// Start (once) a background check that stops the least-recently-used idle
/// ACP instance while the machine is short on memory, one per interval, so
/// agents parked on idle chats give way before the system starts paging.
/// Stopped chats resume on their next message.
pub fn ensure_memory_pressure_reaper(evict_idle: fn(Duration) -> bool) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        let mut system = System::new();
        let mut interval = tokio::time::interval(MEMORY_PRESSURE_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            system.refresh_memory();
            let (total, available) = memory_snapshot(&system);
            // A just-idled agent's chat usually comes straight back, which would
            // respawn it and free nothing, so pressure spares it too.
            let grace = eviction_grace(settings().effective_max_parallel_agents);
            if under_memory_pressure(available, total) && evict_idle(grace) {
                tracing::info!(
                    available_mib = available / (1024 * 1024),
                    "low memory; stopped the longest-idle ACP agent"
                );
            }
        }
    });
}

/// Count an eviction in flight without a tracked permit (tests stand in for an
/// instance with these).
#[cfg(test)]
pub fn eviction_started() {
    if let Ok(mut state) = runtime_state().admission.state.lock() {
        state.evictions_in_flight += 1;
    }
}

#[cfg(test)]
pub fn eviction_finished() {
    if let Ok(mut state) = runtime_state().admission.state.lock() {
        state.evictions_in_flight = state.evictions_in_flight.saturating_sub(1);
        state.evictions_completed += 1;
    }
    runtime_state().admission.notify.notify_waiters();
}

/// Environment variable stamped on every ACP subprocess. Descendants inherit it,
/// which is how Core finds the whole tree again: the ACP crate's drop guard only
/// kills the direct child, and on Windows that child is `cmd.exe`, whose `npx`,
/// agent bridge and CLI grandchildren survive a `TerminateProcess` of it.
pub const ACP_INSTANCE_ENV: &str = "RYU_ACP_INSTANCE_ID";
/// Identifies the Core process that owns a marked tree, as `<pid>:<start_time>`,
/// so a later Core can tell its predecessor's orphans from a sibling profile's
/// live agents.
pub const ACP_OWNER_ENV: &str = "RYU_ACP_OWNER";

fn core_owner_token() -> &'static str {
    static OWNER: OnceLock<String> = OnceLock::new();
    OWNER.get_or_init(|| {
        let pid = sysinfo::get_current_pid().ok();
        let start_time = pid
            .and_then(|pid| {
                let mut system = System::new();
                system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
                system.process(pid).map(sysinfo::Process::start_time)
            })
            .unwrap_or(0);
        format!(
            "{}:{start_time}",
            pid.map(|pid| pid.as_u32()).unwrap_or(std::process::id())
        )
    })
}

/// Owns one ACP instance's process tree. Dropping it (instance exit, idle reap,
/// eviction, crash, or task cancellation) kills every process still carrying the
/// instance marker, off the async runtime.
pub struct AcpProcessTree {
    marker: String,
}

impl AcpProcessTree {
    pub fn new() -> Self {
        Self {
            marker: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Variables to add to the ACP subprocess environment.
    pub fn environment(&self) -> [(String, String); 2] {
        [
            (ACP_INSTANCE_ENV.to_owned(), self.marker.clone()),
            (ACP_OWNER_ENV.to_owned(), core_owner_token().to_owned()),
        ]
    }
}

impl Drop for AcpProcessTree {
    fn drop(&mut self) {
        let marker = std::mem::take(&mut self.marker);
        let spawned = std::thread::Builder::new()
            .name("acp-tree-reap".to_owned())
            .spawn(move || {
                // Two passes: a grandchild can still be starting when the first
                // snapshot is taken, and a bridge may take a moment to notice EOF.
                let mut killed = 0;
                for delay in [Duration::from_millis(250), Duration::from_secs(2)] {
                    std::thread::sleep(delay);
                    killed += kill_marked_processes(|value| value == marker);
                }
                if killed > 0 {
                    tracing::info!(killed, "reaped ACP subprocess tree");
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not start ACP process-tree reaper");
        }
    }
}

fn marker_value<'a>(environ: &'a [std::ffi::OsString], name: &str) -> Option<&'a str> {
    environ.iter().find_map(|entry| {
        let entry = entry.to_str()?;
        let (key, value) = entry.split_once('=')?;
        key.eq_ignore_ascii_case(name).then_some(value)
    })
}

/// Kill every process (except Core itself) whose [`ACP_INSTANCE_ENV`] value
/// satisfies `matches`, plus their later-started descendants in case an agent
/// spawned a child with a scrubbed environment. Returns how many were killed.
fn kill_marked_processes(matches: impl Fn(&str) -> bool) -> usize {
    kill_processes_where(|environ| marker_value(environ, ACP_INSTANCE_ENV).is_some_and(&matches))
}

fn kill_processes_where(select: impl Fn(&[std::ffi::OsString]) -> bool) -> usize {
    use std::collections::{HashMap, HashSet};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
    );
    let own = sysinfo::get_current_pid().ok();
    let mut selected: HashSet<Pid> = system
        .processes()
        .iter()
        .filter(|(pid, process)| Some(**pid) != own && select(process.environ()))
        .map(|(pid, _)| *pid)
        .collect();

    // Windows keeps a dead parent's pid in `parent()`, and pids are reused, so
    // only follow an edge when the child started no earlier than its parent.
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut stack: Vec<Pid> = selected.iter().copied().collect();
    while let Some(parent) = stack.pop() {
        let parent_start = system
            .process(parent)
            .map_or(0, sysinfo::Process::start_time);
        for child in children.get(&parent).into_iter().flatten() {
            let started_after = system
                .process(*child)
                .is_some_and(|process| process.start_time() >= parent_start);
            if Some(*child) != own && started_after && selected.insert(*child) {
                stack.push(*child);
            }
        }
    }

    selected
        .iter()
        .filter(|pid| system.process(**pid).is_some_and(sysinfo::Process::kill))
        .count()
}

/// Kill ACP trees left behind by a previous Core that crashed or was killed
/// before its reapers ran. A tree is an orphan when its owner token names a Core
/// that is no longer running; a live sibling Core (another profile) keeps its own.
pub fn reap_orphaned_trees() {
    let spawned = std::thread::Builder::new()
        .name("acp-orphan-reap".to_owned())
        .spawn(|| {
            let mut system = System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let owner_alive = |token: &str| {
                let Some((pid, start)) = token.split_once(':') else {
                    return false;
                };
                let (Ok(pid), Ok(start)) = (pid.parse::<u32>(), start.parse::<u64>()) else {
                    return false;
                };
                system
                    .process(sysinfo::Pid::from_u32(pid))
                    .is_some_and(|process| process.start_time() == start)
            };
            let killed = kill_processes_where(|environ| {
                marker_value(environ, ACP_INSTANCE_ENV).is_some()
                    && !marker_value(environ, ACP_OWNER_ENV).is_some_and(owner_alive)
            });
            if killed > 0 {
                tracing::info!(
                    killed,
                    "reaped orphaned ACP subprocesses from a previous Core"
                );
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start orphaned ACP reaper");
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{
        calculate_auto_max_parallel_agents, cgroup_memory_from, effective_memory, sanitize_config,
    };
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn automatic_limit_is_cpu_and_memory_bounded() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // A nominal 4 GiB VM reports about 3.8 GiB.
        assert_eq!(calculate_auto_max_parallel_agents(2, 1, GIB * 38 / 10), 14);
        assert_eq!(calculate_auto_max_parallel_agents(2, 1, 4 * GIB), 16);
        assert_eq!(calculate_auto_max_parallel_agents(8, 4, 16 * GIB), 32);
        // CPU-bound: plenty of memory, one core.
        assert_eq!(calculate_auto_max_parallel_agents(1, 1, 32 * GIB), 8);
        // Everything reserved still admits one agent.
        assert_eq!(calculate_auto_max_parallel_agents(1, 1, GIB), 1);
        assert_eq!(calculate_auto_max_parallel_agents(1, 1, 0), 1);
        // Logical cores missing falls back to physical ones.
        assert_eq!(calculate_auto_max_parallel_agents(0, 1, 32 * GIB), 8);
    }

    #[test]
    fn malformed_runtime_values_fail_safe_to_defaults_or_bounds() {
        let config = sanitize_config(&json!({
            "idle_timeout_minutes": 0,
            "max_parallel_agents": 500,
            "keep_computer_awake": false
        }));
        assert_eq!(config.idle_timeout_minutes, 1);
        assert_eq!(config.max_parallel_agents, None);
        assert!(!config.keep_computer_awake);
    }

    fn marked_pids(marker: &str) -> Vec<sysinfo::Pid> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
        );
        system
            .processes()
            .iter()
            .filter(|(_, process)| {
                super::marker_value(process.environ(), super::ACP_INSTANCE_ENV) == Some(marker)
            })
            .map(|(pid, _)| *pid)
            .collect()
    }

    /// Mirrors the ACP spawn shape: a shell wrapper whose grandchild survives a
    /// kill of the direct child. The marker sweep must take the grandchild too.
    #[test]
    fn marker_sweep_kills_grandchildren_that_outlive_the_direct_child() {
        let marker = uuid::Uuid::new_v4().to_string();
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd");
            command.args(["/d", "/s", "/c", "ping -n 60 127.0.0.1 >nul"]);
            command
        } else {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 60; true"]);
            command
        };
        let mut child = command
            .env(super::ACP_INSTANCE_ENV, &marker)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn wrapper");
        assert!(
            wait_for_marked_pids(&marker, |count| count >= 2),
            "wrapper and grandchild both carry the marker"
        );

        // What the ACP crate's drop guard does: kill only the direct child.
        // `wait` reaps it, so anything still marked is the orphaned grandchild.
        child.kill().expect("kill direct child");
        let _ = child.wait();
        assert!(
            !marked_pids(&marker).is_empty(),
            "grandchild outlives its killed parent"
        );

        let killed = super::kill_marked_processes(|value| value == marker);
        assert!(killed >= 1);
        assert!(
            wait_for_marked_pids(&marker, |count| count == 0),
            "tree fully reaped"
        );
    }

    /// Polls [`marked_pids`] until `done` accepts the count or a generous
    /// deadline passes, so process start-up and reaping are not timed by fixed
    /// sleeps on a loaded machine.
    fn wait_for_marked_pids(marker: &str, done: impl Fn(usize) -> bool) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if done(marked_pids(marker).len()) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn a_cgroup_limit_below_host_ram_bounds_total_and_available_memory() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // No cgroup, or one without a real limit: the host's numbers.
        assert_eq!(
            effective_memory(16 * GIB, 12 * GIB, None),
            (16 * GIB, 12 * GIB)
        );
        assert_eq!(
            effective_memory(16 * GIB, 12 * GIB, Some((u64::MAX / 2, GIB))),
            (16 * GIB, 12 * GIB)
        );
        // A 4 GiB container with 1 GiB in use.
        assert_eq!(
            effective_memory(16 * GIB, 12 * GIB, Some((4 * GIB, 3 * GIB))),
            (4 * GIB, 3 * GIB)
        );
        // The host can still be the tighter of the two for availability.
        assert_eq!(
            effective_memory(16 * GIB, 2 * GIB, Some((4 * GIB, 3 * GIB))),
            (4 * GIB, 2 * GIB)
        );
        // On a 64 GiB host with 4 vCPUs, the container limit sizes the cap.
        let (total, _) = effective_memory(64 * GIB, 60 * GIB, Some((4 * GIB, 4 * GIB)));
        assert_eq!(calculate_auto_max_parallel_agents(4, 2, total), 16);
    }

    #[test]
    fn cgroup_memory_reads_the_tightest_limit_and_least_headroom_on_the_path() {
        use std::collections::HashMap;
        use std::path::Path;
        const GIB: u64 = 1024 * 1024 * 1024;
        let files: HashMap<&str, String> = HashMap::from([
            (
                "/sys/fs/cgroup/memory/memory.limit_in_bytes",
                "9223372036854771712\n".to_owned(),
            ),
            (
                "/sys/fs/cgroup/memory/box/memory.limit_in_bytes",
                format!("{}\n", 4 * GIB),
            ),
            (
                "/sys/fs/cgroup/memory/box/memory.usage_in_bytes",
                format!("{}\n", GIB),
            ),
            (
                "/sys/fs/cgroup/memory/box/memory.stat",
                format!("total_cache 9\ntotal_inactive_file {}\n", GIB / 4),
            ),
            (
                "/sys/fs/cgroup/memory/box/agent/memory.limit_in_bytes",
                format!("{}\n", 8 * GIB),
            ),
        ]);
        let read = |path: &Path| files.get(path.to_str()?).cloned();
        assert_eq!(
            cgroup_memory_from("4:memory:/box/agent\n1:cpu:/\n", &read),
            Some((4 * GIB, 4 * GIB - (GIB - GIB / 4)))
        );

        // A roomier parent shared with siblings can leave less headroom than
        // Core's own, tighter cgroup.
        let files: HashMap<&str, String> = HashMap::from([
            ("/sys/fs/cgroup/slice/memory.max", format!("{}\n", 8 * GIB)),
            (
                "/sys/fs/cgroup/slice/memory.current",
                format!("{}\n", 8 * GIB - GIB / 2),
            ),
            (
                "/sys/fs/cgroup/slice/core/memory.max",
                format!("{}\n", 6 * GIB),
            ),
            (
                "/sys/fs/cgroup/slice/core/memory.current",
                format!("{}\n", GIB),
            ),
        ]);
        let read = |path: &Path| files.get(path.to_str()?).cloned();
        assert_eq!(
            cgroup_memory_from("0::/slice/core\n", &read),
            Some((6 * GIB, GIB / 2))
        );

        // cgroup v2: `max` means no limit; a missing leaf directory is skipped.
        let files: HashMap<&str, String> = HashMap::from([
            ("/sys/fs/cgroup/memory.max", format!("{}\n", 2 * GIB)),
            ("/sys/fs/cgroup/memory.current", format!("{}\n", GIB / 2)),
            (
                "/sys/fs/cgroup/memory.stat",
                "anon 1\ninactive_file 0\n".to_owned(),
            ),
            ("/sys/fs/cgroup/svc/memory.max", "max\n".to_owned()),
        ]);
        let read = |path: &Path| files.get(path.to_str()?).cloned();
        assert_eq!(
            cgroup_memory_from("0::/svc/missing\n", &read),
            Some((2 * GIB, 2 * GIB - GIB / 2))
        );
        assert_eq!(cgroup_memory_from("0::/\n", &|_: &Path| None), None);
    }

    #[test]
    fn memory_pressure_uses_a_tenth_of_ram_with_a_floor_capped_at_a_quarter() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(super::under_memory_pressure(6 * GIB, 64 * GIB));
        assert!(!super::under_memory_pressure(7 * GIB, 64 * GIB));
        assert!(super::under_memory_pressure(3 * GIB, 32 * GIB));
        assert!(!super::under_memory_pressure(3 * GIB + GIB / 2, 32 * GIB));
        assert!(super::under_memory_pressure(GIB + GIB / 2, 8 * GIB));
        assert!(!super::under_memory_pressure(3 * GIB, 8 * GIB));
        // 4 GiB node: the floor is 1 GiB, not 2 GiB.
        assert!(!super::under_memory_pressure(GIB + GIB / 2, 4 * GIB));
        assert!(super::under_memory_pressure(GIB - 1, 4 * GIB));
        assert!(!super::under_memory_pressure(0, 0));
    }

    /// Admission is process-global; tests that fill it must not overlap.
    pub(crate) static ADMISSION_TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    /// Set the `[acp]` section for an admission test holding [`ADMISSION_TEST_LOCK`].
    pub(crate) fn apply_test_config(value: &serde_json::Value) {
        super::apply_config(value);
    }

    #[tokio::test]
    async fn full_admission_evicts_one_idle_instance_instead_of_waiting_for_its_ttl() {
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let idle_holder = super::acquire(|_| false).await;

        let holder = std::sync::Mutex::new(Some(idle_holder));
        let evictions = std::sync::atomic::AtomicU32::new(0);
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            super::acquire(|_| {
                evictions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Stand-in for an evicted instance exiting and releasing its slot.
                holder.lock().unwrap().take().is_some()
            }),
        )
        .await
        .expect("waiter admitted after eviction");

        assert_eq!(evictions.load(std::sync::atomic::Ordering::SeqCst), 1);
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// Another waiter can take the slot an eviction freed. Once that eviction is
    /// no longer in flight, the waiter that lost the race must evict again rather
    /// than sit until some instance's idle TTL.
    #[tokio::test]
    async fn a_waiter_whose_freed_slot_was_taken_evicts_again() {
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let busy_holder = super::acquire(|_| false).await;

        let holder = std::sync::Mutex::new(Some(busy_holder));
        let calls = std::sync::atomic::AtomicU32::new(0);
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            super::acquire(|_| {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    // First eviction's slot goes to a thief: the evicted instance
                    // finishes, but no permit is freed for this waiter.
                    super::eviction_started();
                    tokio::spawn(async {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        super::eviction_finished();
                    });
                    true
                } else {
                    holder.lock().unwrap().take().is_some()
                }
            }),
        )
        .await
        .expect("waiter admitted after a second eviction");

        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// The only slot's holder is still busy when a turn queues, so nothing can
    /// be evicted yet. When the holder goes idle, `instance_idle` must wake the
    /// waiter to evict it, well before the backstop re-check or the idle TTL.
    #[tokio::test]
    async fn a_holder_going_idle_wakes_a_queued_turn_to_evict_it() {
        use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
        use std::sync::Arc;

        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let busy_holder = super::acquire(|_| false).await;

        // Stand-in for the holder's instance task: once evicted it reports the
        // finish and then releases its permit, in production order.
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let holder_task = tokio::spawn(async move {
            let _ = release_rx.await;
            super::eviction_finished();
            drop(busy_holder);
        });

        let holder_idle = Arc::new(AtomicBool::new(false));
        let evictions = Arc::new(AtomicU32::new(0));
        let waiter = tokio::spawn({
            let holder_idle = Arc::clone(&holder_idle);
            let evictions = Arc::clone(&evictions);
            let mut release_tx = Some(release_tx);
            async move {
                super::acquire(move |_| {
                    if !holder_idle.load(Ordering::SeqCst) {
                        return false;
                    }
                    let Some(release) = release_tx.take() else {
                        return false;
                    };
                    evictions.fetch_add(1, Ordering::SeqCst);
                    super::eviction_started();
                    let _ = release.send(());
                    true
                })
                .await
            }
        });

        // Let the waiter find the slot busy and park.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!waiter.is_finished(), "waiter queued behind a busy holder");

        holder_idle.store(true, Ordering::SeqCst);
        super::instance_idle();
        let permit = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("idle holder wakes the queued turn")
            .expect("waiter task");

        assert_eq!(evictions.load(Ordering::SeqCst), 1);
        holder_task.await.expect("holder task");
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// Turns are admitted in arrival order: a slot that frees goes to the
    /// longest-waiting turn, never to one that arrived later.
    #[tokio::test]
    async fn queued_turns_are_admitted_first_come_first_served() {
        use std::sync::{Arc, Mutex as StdMutex};
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let holder = super::acquire(|_| false).await;

        let order = Arc::new(StdMutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for name in ["first", "second", "third"] {
            let order = Arc::clone(&order);
            waiters.push(tokio::spawn(async move {
                let permit = super::acquire(|_| false).await;
                order.lock().unwrap().push(name);
                // Hold the slot briefly so the next turn must wait for it.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                drop(permit);
            }));
            // Let each waiter take its place in line before the next arrives.
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        drop(holder);
        for waiter in waiters {
            tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
                .await
                .expect("every queued turn is admitted")
                .expect("waiter task");
        }
        assert_eq!(*order.lock().unwrap(), vec!["first", "second", "third"]);
        super::apply_config(&json!({}));
    }

    /// A chat replacing its own retired instance waits at the front of the line
    /// for that instance's slot, ahead of turns that queued earlier.
    #[tokio::test]
    async fn a_retiring_chat_takes_its_own_slot_ahead_of_the_queue() {
        use std::sync::{Arc, Mutex as StdMutex};
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let mut holder = super::acquire(|_| false).await;
        let evicted = super::EvictionFlag::default();
        holder.track_eviction(evicted.clone());

        let order = Arc::new(StdMutex::new(Vec::new()));
        let earlier = tokio::spawn({
            let order = Arc::clone(&order);
            async move {
                let permit = super::acquire(|_| false).await;
                order.lock().unwrap().push("earlier");
                drop(permit);
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(super::start_eviction(&evicted));
        let replacement = tokio::spawn({
            let order = Arc::clone(&order);
            async move {
                let permit = super::acquire_after_retiring(|_| {
                    panic!("a retiring chat waits for its own slot")
                })
                .await;
                order.lock().unwrap().push("replacement");
                drop(permit);
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(holder);
        for task in [replacement, earlier] {
            tokio::time::timeout(std::time::Duration::from_secs(2), task)
                .await
                .expect("both turns are admitted")
                .expect("task");
        }
        assert_eq!(*order.lock().unwrap(), vec!["replacement", "earlier"]);
        assert_eq!(super::evictions_in_flight(), 0);
        super::apply_config(&json!({}));
    }

    /// A queued turn first asks only for instances idle past the grace, and
    /// after waiting long enough for any idle instance.
    #[tokio::test(start_paused = true)]
    async fn a_queued_turn_spares_just_idled_instances_until_it_has_waited() {
        use std::sync::{Arc, Mutex as StdMutex};
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let holder = Arc::new(StdMutex::new(Some(super::acquire(|_| false).await)));
        let asked = Arc::new(StdMutex::new(Vec::new()));
        let waiter = tokio::spawn({
            let holder = Arc::clone(&holder);
            let asked = Arc::clone(&asked);
            async move {
                super::acquire(move |min_idle| {
                    asked.lock().unwrap().push(min_idle);
                    // The only idle instance went idle just now: evictable only
                    // once the caller stops requiring the grace.
                    min_idle.is_zero() && holder.lock().unwrap().take().is_some()
                })
                .await
            }
        });
        // One slot: a one-second grace, any idle instance after two seconds.
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let permit = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("the turn is admitted after waiting")
            .expect("waiter task");
        let asked = asked.lock().unwrap().clone();
        assert_eq!(asked.first(), Some(&std::time::Duration::from_secs(1)));
        assert_eq!(asked.last(), Some(&std::time::Duration::ZERO));
        assert!(asked.len() >= 2, "{asked:?}");
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// A turn that gives up while queued leaves the line, so the turn behind it
    /// is not blocked.
    #[tokio::test]
    async fn a_cancelled_queued_turn_does_not_block_the_next() {
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let holder = super::acquire(|_| false).await;
        let cancelled = tokio::spawn(super::acquire(|_| false));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let next = tokio::spawn(super::acquire(|_| false));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancelled.abort();
        let _ = cancelled.await;
        drop(holder);
        let permit = tokio::time::timeout(std::time::Duration::from_secs(2), next)
            .await
            .expect("the next turn is admitted")
            .expect("waiter task");
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// An evicted instance returns its slot and ends its eviction together, so
    /// the waiter it was evicted for never sees the eviction over while the slot
    /// is still held, and never evicts a second instance.
    #[tokio::test]
    async fn an_evicted_slot_and_its_eviction_end_together() {
        use std::sync::atomic::AtomicU32;
        use std::sync::Arc;
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let mut holder = super::acquire(|_| false).await;
        let evicted = super::EvictionFlag::default();
        holder.track_eviction(evicted.clone());
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let instance = tokio::spawn(async move {
            let _ = release_rx.await;
            // Teardown takes a moment after the eviction is observed.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(holder);
        });
        let calls = Arc::new(AtomicU32::new(0));
        let mut release_tx = Some(release_tx);
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            super::acquire({
                let calls = Arc::clone(&calls);
                move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let Some(release) = release_tx.take() else {
                        return false;
                    };
                    assert!(super::start_eviction(&evicted));
                    let _ = release.send(());
                    true
                }
            }),
        )
        .await
        .expect("the waiter takes the evicted slot");
        instance.await.expect("instance task");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no second eviction");
        assert_eq!(super::evictions_in_flight(), 0);
        drop(permit);
        super::apply_config(&json!({}));
    }

    /// An instance that returned its slot on its own (idle TTL, crash) between
    /// being picked and being evicted is not counted in flight, so no waiter
    /// waits for a slot that will not come.
    #[tokio::test]
    async fn evicting_an_instance_whose_slot_is_back_counts_nothing() {
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 1 }));
        let mut holder = super::acquire(|_| false).await;
        let eviction = super::EvictionFlag::default();
        holder.track_eviction(eviction.clone());
        drop(holder);
        assert!(!super::start_eviction(&eviction));
        assert!(!eviction.is_evicted());
        assert_eq!(super::evictions_in_flight(), 0);
        // And a second eviction of a live instance is not counted twice.
        let mut holder = super::acquire(|_| false).await;
        let eviction = super::EvictionFlag::default();
        holder.track_eviction(eviction.clone());
        assert!(super::start_eviction(&eviction));
        assert!(!super::start_eviction(&eviction));
        assert_eq!(super::evictions_in_flight(), 1);
        drop(holder);
        assert_eq!(super::evictions_in_flight(), 0);
        super::apply_config(&json!({}));
    }

    /// A waiter whose freed slot was taken by a retiring chat ahead of it evicts
    /// again as soon as its own eviction is over, without waiting for that
    /// chat's retired instance to finish a long turn.
    #[tokio::test]
    async fn a_waiter_does_not_wait_on_evictions_that_started_after_its_own() {
        use std::sync::atomic::AtomicU32;
        use std::sync::{Arc, Mutex as StdMutex};
        let _serial = ADMISSION_TEST_LOCK.lock().await;
        super::apply_config(&json!({ "max_parallel_agents": 3 }));
        // `busy` is mid-turn in a chat that will retire it; `idle` is evicted
        // first; `spare` is another idle instance the waiter may take next.
        let mut busy = super::acquire(|_| false).await;
        let busy_eviction = super::EvictionFlag::default();
        busy.track_eviction(busy_eviction.clone());
        let mut idle = super::acquire(|_| false).await;
        let idle_eviction = super::EvictionFlag::default();
        idle.track_eviction(idle_eviction.clone());
        let spare = Arc::new(StdMutex::new(Some(super::acquire(|_| false).await)));

        let calls = Arc::new(AtomicU32::new(0));
        let waiter = tokio::spawn({
            let calls = Arc::clone(&calls);
            let spare = Arc::clone(&spare);
            async move {
                super::acquire(move |_| match calls.fetch_add(1, Ordering::SeqCst) {
                    0 => super::start_eviction(&idle_eviction),
                    _ => spare.lock().unwrap().take().is_some(),
                })
                .await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The busy chat retires its instance; the replacement queues in front.
        assert!(super::start_eviction(&busy_eviction));
        let replacement = tokio::spawn(super::acquire_after_retiring(|_| false));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // The evicted instance exits. Whichever of the two takes its slot, the
        // other gets one too: the waiter evicts the spare without waiting for
        // the busy instance's turn to end.
        drop(idle);
        let replacement = tokio::time::timeout(std::time::Duration::from_secs(3), replacement)
            .await
            .expect("the replacement is admitted")
            .expect("replacement task");
        let permit = tokio::time::timeout(std::time::Duration::from_secs(3), waiter)
            .await
            .expect("the waiter evicts again while the retirement is in flight")
            .expect("waiter task");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        drop(permit);
        drop(replacement);
        drop(busy);
        super::apply_config(&json!({}));
    }

    #[test]
    fn the_eviction_grace_grows_with_the_slots_up_to_a_ceiling() {
        use std::time::Duration;
        assert_eq!(super::eviction_grace(0), Duration::from_secs(1));
        assert_eq!(super::eviction_grace(1), Duration::from_secs(1));
        assert_eq!(super::eviction_grace(4), Duration::from_secs(4));
        assert_eq!(super::eviction_grace(16), Duration::from_secs(15));
        assert_eq!(super::eviction_grace(32), Duration::from_secs(15));
        // A queued turn spares recently idle instances for twice the grace.
        assert_eq!(
            super::eviction_min_idle(Duration::from_secs(29), 16),
            Duration::from_secs(15)
        );
        assert_eq!(
            super::eviction_min_idle(Duration::from_secs(30), 16),
            Duration::ZERO
        );
        assert_eq!(
            super::eviction_min_idle(Duration::from_secs(2), 1),
            Duration::ZERO
        );
    }
}

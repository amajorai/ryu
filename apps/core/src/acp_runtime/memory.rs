//! Hardware sizing: the memory Core may use (host RAM tightened by its cgroup),
//! the automatic parallel-agent limit, and the low-memory reaper.

use std::sync::OnceLock;
use std::time::Duration;

use sysinfo::System;

use super::admission::eviction_grace;
use super::config::settings;
use super::{HardwareSummary, MAX_PARALLEL_AGENTS, MIN_PARALLEL_AGENTS};
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

pub(super) fn hardware() -> &'static HardwareSummary {
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
pub(super) fn effective_memory(
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
pub(super) fn cgroup_memory_from(
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
pub(super) fn calculate_auto_max_parallel_agents(
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

pub(super) fn auto_max_parallel_agents() -> u32 {
    let info = hardware();
    calculate_auto_max_parallel_agents(info.cpu_cores, info.physical_cores, info.total_ram_bytes)
}

const MEMORY_PRESSURE_INTERVAL: Duration = Duration::from_secs(30);
const MEMORY_PRESSURE_MIN_FREE_BYTES: u64 = 2 * GIB;

/// Free memory is low when less than a tenth of RAM is available, with a floor
/// of 2 GiB capped at a quarter of RAM. The cap matters on small nodes: a flat
/// 2 GiB floor on a 4 GiB node would count normal use by a dozen running agents
/// as pressure and evict warm idle agents every interval.
pub(super) fn under_memory_pressure(available_bytes: u64, total_bytes: u64) -> bool {
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

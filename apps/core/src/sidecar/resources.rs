//! Per-engine resource usage sampling for the node selector.
//!
//! The node-wide hardware snapshot lives in [`crate::system_info`]; this is the
//! *per-sidecar* breakdown behind "how much is this engine using". Placement
//! (Core vs Gateway, CLAUDE.md §1): like the hardware snapshot, describing the
//! processes an agent runs on is an orchestration-side ("what runs") concern, so
//! it lives in Core, never the Gateway.
//!
//! Two numbers, sampled differently (the trap is CPU):
//!   - **Memory (RSS)** is instantaneous — a single refresh reads it.
//!   - **CPU%** is a *delta*: `sysinfo` reports usage since the previous refresh
//!     of that PID, so a one-shot refresh reads `0.0` for every process. The
//!     [`SidecarManager`](crate::sidecar::SidecarManager) sampler therefore holds
//!     one long-lived [`System`] and refreshes on a ticker, so the second tick
//!     onward yields real CPU numbers.
//!
//! Only the *known* sidecar PIDs are refreshed (never a full process scan), so
//! the ticker stays cheap on machines with hundreds of processes.

use std::collections::HashMap;

use sysinfo::{Pid, ProcessesToUpdate, System};

/// A point-in-time resource reading for one sidecar's resident process.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct ResourceSample {
    /// The sampled OS process id.
    pub pid: u32,
    /// Resident-set memory in bytes.
    pub memory_bytes: u64,
    /// CPU usage as a percentage of a single core (may exceed 100 across cores).
    pub cpu_percent: f32,
}

/// Refresh `sys` for exactly `pids` and return a `name → sample` map.
///
/// `named_pids` carries `(sidecar_name, pid)`; the same `sys` must be reused
/// across calls for CPU deltas to be meaningful (see the module docs). PIDs that
/// have since exited simply drop out of the result.
pub fn sample(sys: &mut System, named_pids: &[(String, u32)]) -> HashMap<String, ResourceSample> {
    if named_pids.is_empty() {
        return HashMap::new();
    }
    let pid_list: Vec<Pid> = named_pids
        .iter()
        .map(|(_, pid)| Pid::from_u32(*pid))
        .collect();
    sys.refresh_processes(ProcessesToUpdate::Some(&pid_list), true);

    let mut out = HashMap::with_capacity(named_pids.len());
    for (name, pid) in named_pids {
        if let Some(proc_) = sys.process(Pid::from_u32(*pid)) {
            out.insert(
                name.clone(),
                ResourceSample {
                    pid: *pid,
                    memory_bytes: proc_.memory(),
                    cpu_percent: proc_.cpu_usage(),
                },
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pids_yields_empty_map() {
        let mut sys = System::new();
        assert!(sample(&mut sys, &[]).is_empty());
    }

    #[test]
    fn cpu_percent_is_nonzero_after_second_sample_under_load() {
        // Guards the CPU=0 trap: a single refresh always reads 0% (CPU is a
        // delta), so the sampler reuses one `System` across ticks. This proves a
        // second sample under load yields a real number — and that
        // `refresh_processes` alone (no separate `refresh_cpu`) suffices.
        let mut sys = System::new();
        let pid = std::process::id();
        let _baseline = sample(&mut sys, &[("self".to_string(), pid)]);
        // Burn CPU past sysinfo's minimum refresh interval so the delta is real.
        let spin_until = std::time::Instant::now()
            + sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
            + std::time::Duration::from_millis(100);
        let mut acc: u64 = 0;
        while std::time::Instant::now() < spin_until {
            acc = acc.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        }
        std::hint::black_box(acc);
        let samples = sample(&mut sys, &[("self".to_string(), pid)]);
        let me = samples.get("self").expect("current process sampled");
        assert!(
            me.cpu_percent > 0.0,
            "cpu should be >0 under load, got {}",
            me.cpu_percent
        );
    }

    #[test]
    fn samples_real_memory_for_current_process() {
        // The test process itself is guaranteed alive, so sampling its own PID
        // exercises the real sysinfo path and must report non-zero RSS. (CPU% is
        // a cross-refresh delta and legitimately reads 0 on a single sample, so
        // memory is the assertion that proves the API wiring.)
        let mut sys = System::new();
        let pid = std::process::id();
        let samples = sample(&mut sys, &[("self".to_string(), pid)]);
        let me = samples.get("self").expect("current process sampled");
        assert_eq!(me.pid, pid);
        assert!(
            me.memory_bytes > 0,
            "RSS should be non-zero for a live process"
        );
    }
}

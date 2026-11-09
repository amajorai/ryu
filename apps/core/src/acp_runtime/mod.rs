//! Runtime guardrails for Core-owned ACP subprocesses.
//!
//! The Gateway owns the persisted `[acp]` settings because they are node-level
//! policy. Core owns this module because it is the process supervisor: it is the
//! only place that can bound every ACP spawn, reap idle sessions, and report the
//! node's effective hardware-based limit.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;

mod admission;
mod config;
mod memory;
mod process_tree;
#[cfg(test)]
pub(crate) mod tests;

pub use admission::{acquire, acquire_after_retiring, instance_idle, start_eviction, EvictionFlag};
pub use config::{
    observe_gateway_config, observe_gateway_patch, refresh_from_gateway, refresh_from_local_file,
    settings,
};
pub use memory::ensure_memory_pressure_reaper;
pub use process_tree::{reap_orphaned_trees, AcpProcessTree};

// The unit tests reach every helper as `super::<name>`.
#[cfg(test)]
use {admission::*, config::*, memory::*, process_tree::*};

/// Stopped Claude chats resume their own session, so an idle agent can be
/// released sooner than when stopping it lost the conversation.
const DEFAULT_IDLE_TIMEOUT_MINUTES: u64 = 5;
const MAX_PARALLEL_AGENTS: u32 = 32;
const MIN_PARALLEL_AGENTS: u32 = 1;

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

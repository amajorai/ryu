//! Holds an update restart until no agent run is active.
//!
//! [`crate::update::request_restart`] used to start Core's shutdown at once.
//! The shutdown gives open connections a short drain and then stops every
//! agent process, so a run that outlasted the drain was killed by an update the
//! node installed on its own at the quiet hour.
//!
//! The shutdown paths now wait on [`restart_ready`] instead. It resolves once a
//! restart was requested AND one of these holds:
//!
//! - no agent run has been active for [`IDLE_POLLS`] polls in a row,
//! - someone with node management asked for the restart now ([`restart_now`]),
//! - the restart has waited [`MAX_WAIT`].
//!
//! While it waits, Core keeps serving: running work goes on and new work can
//! start. The new binary is already on disk, so a restart for any other reason
//! (a supervisor restart, a reboot) also brings the update up.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;

/// How often the active run count is read while a restart waits.
const POLL: Duration = Duration::from_secs(5);

/// Idle polls in a row before the restart goes ahead. One idle reading can be
/// the gap between two turns of the same agent loop.
const IDLE_POLLS: u32 = 2;

/// Longest a restart waits for agent runs. A turn parked on an approval nobody
/// answers must not keep an unattended node on the old build forever. A day
/// lands the forced restart on the next quiet hour, the hour the update was
/// scheduled for in the first place.
const MAX_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

/// Why a waiting restart went ahead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Release {
    /// No agent run was active.
    Idle,
    /// [`restart_now`] was called.
    RestartNow,
    /// The restart waited [`MAX_WAIT`].
    TimedOut,
}

/// The shared wait state. One process-wide instance ([`GATE`]); tests build
/// their own so they never touch it.
pub(crate) struct Gate {
    waiting: AtomicBool,
    restart_now: AtomicBool,
    wake: tokio::sync::Notify,
}

impl Gate {
    pub(crate) const fn new() -> Self {
        Self {
            waiting: AtomicBool::new(false),
            restart_now: AtomicBool::new(false),
            wake: tokio::sync::Notify::const_new(),
        }
    }

    /// Whether a requested restart is waiting for agent runs right now.
    pub(crate) fn is_waiting(&self) -> bool {
        self.waiting.load(Ordering::SeqCst)
    }

    /// Skip the wait. `false` when no restart is waiting, so a stray call can
    /// never arm a restart that a later update would then take without waiting.
    pub(crate) fn restart_now(&self) -> bool {
        if !self.is_waiting() {
            return false;
        }
        self.restart_now.store(true, Ordering::SeqCst);
        // `notify_one` keeps a permit, so a waiter that is between two polls
        // still wakes on its next `notified()`.
        self.wake.notify_one();
        true
    }

    /// Wait until `active_runs` reads zero for [`IDLE_POLLS`] polls in a row,
    /// [`Gate::restart_now`] is called, or `max_wait` passes.
    pub(crate) async fn wait_until_idle(
        &self,
        active_runs: impl Fn() -> usize,
        poll: Duration,
        max_wait: Duration,
    ) -> Release {
        self.waiting.store(true, Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + max_wait;
        let mut idle_polls = 0;
        let mut reported = None;
        let release = loop {
            if self.restart_now.load(Ordering::SeqCst) {
                break Release::RestartNow;
            }
            let active = active_runs();
            if active == 0 {
                idle_polls += 1;
                if idle_polls >= IDLE_POLLS {
                    break Release::Idle;
                }
            } else {
                idle_polls = 0;
                if reported != Some(active) {
                    tracing::info!(
                        active,
                        "update restart: waiting for running agent work to finish"
                    );
                    reported = Some(active);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                break Release::TimedOut;
            }
            tokio::select! {
                () = tokio::time::sleep(poll) => {}
                () = self.wake.notified() => {}
            }
        };
        self.waiting.store(false, Ordering::SeqCst);
        release
    }
}

static GATE: Gate = Gate::new();
static READY: tokio::sync::OnceCell<Release> = tokio::sync::OnceCell::const_new();

/// Agent runs active on this Core: conversations with a turn running, the count
/// a dev Core restart already waits on.
pub fn active_agent_runs() -> usize {
    crate::sidecar::adapters::live_turn::running_turns()
}

/// Resolves once an update restart was requested and may go ahead.
///
/// Every caller shares one wait, so the shutdown signal and the drain timer in
/// `boot/serve.rs` release at the same moment.
pub async fn restart_ready() {
    READY
        .get_or_init(|| async {
            crate::update::restart_requested().await;
            let release = GATE
                .wait_until_idle(active_agent_runs, POLL, MAX_WAIT)
                .await;
            match release {
                Release::Idle => {
                    tracing::info!("update restart: no agent run is active; restarting");
                }
                Release::RestartNow => {
                    tracing::warn!(
                        active = active_agent_runs(),
                        "update restart: restarting now on request"
                    );
                }
                Release::TimedOut => {
                    tracing::warn!(
                        active = active_agent_runs(),
                        "update restart: agent work is still running after the longest wait; restarting anyway"
                    );
                }
            }
            release
        })
        .await;
}

/// Restart onto the installed update now instead of waiting for agent runs.
/// `false` when no update restart is waiting.
pub fn restart_now() -> bool {
    GATE.restart_now()
}

/// What a client shows next to an installed update.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct RestartStatus {
    /// An update restart was requested and is waiting for agent runs to finish.
    pub waiting: bool,
    /// Agent runs active right now.
    pub active_runs: usize,
}

/// The current wait state, for `GET /api/update/schedule`.
pub fn status() -> RestartStatus {
    RestartStatus {
        waiting: GATE.is_waiting(),
        active_runs: active_agent_runs(),
    }
}

#[cfg(test)]
#[path = "restart_gate_tests.rs"]
mod tests;

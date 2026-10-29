//! Per-(plugin, hook) circuit breaker for sandboxed turn/tool hooks.
//!
//! Hooks are fail-open: an erroring or timing-out hook degrades to "no
//! directive" and the turn continues. That keeps a broken plugin from blocking
//! a turn, but on its own it lets the same broken hook add its full sandbox
//! timeout (up to the warm-pool wall clock) to EVERY tool call or turn forever,
//! because `tool_result` and middleware hooks run sequentially.
//!
//! The breaker counts consecutive failures per `(plugin_id, hook_id)`. After
//! [`FAILURE_THRESHOLD`] consecutive failures the hook is skipped for
//! [`COOL_DOWN`]; the first call after the cool-down is a single half-open
//! trial — success closes the breaker, another failure re-opens it for a fresh
//! cool-down. A trial whose run is cancelled (its [`Permit`] dropped without an
//! outcome) only frees the trial slot for the next caller. A success at any
//! time resets the counter. Tripping logs exactly
//! once per open transition, and the current state is exposed cheaply through
//! [`snapshot`] (surfaced on `GET /api/plugins/isolation`).
//!
//! State is process-local and in-memory by design: a restart is a natural
//! retry, and nothing here is security-relevant (a skipped hook is the same
//! fail-open outcome as a failed one, just without the latency).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Consecutive failures (errors, pauses or sandbox timeouts) before a hook is
/// skipped.
pub const FAILURE_THRESHOLD: u32 = 3;
/// How long an open breaker skips its hook before allowing one trial run.
pub const COOL_DOWN: Duration = Duration::from_secs(5 * 60);
/// Upper bound on tracked entries so a pathological plugin set cannot grow
/// the map without limit. Healthy entries are evicted first.
const MAX_ENTRIES: usize = 4096;

#[derive(Debug, Clone, Default)]
struct Entry {
    consecutive_failures: u32,
    /// `Some` while the breaker is open (skipping) or half-open (trial issued).
    open_until: Option<Instant>,
    /// A half-open trial is in flight; concurrent callers keep skipping.
    trial_in_flight: bool,
    last_error: Option<String>,
    times_tripped: u64,
}

/// Breaker bookkeeping with an injectable clock (`now`) so it is unit-testable.
#[derive(Debug, Default)]
pub struct HookBreaker {
    entries: HashMap<(String, String), Entry>,
}

/// One row of [`snapshot`]: a hook that has failed at least once since its last
/// success.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BreakerState {
    pub plugin_id: String,
    pub hook_id: String,
    pub consecutive_failures: u32,
    /// `true` while the hook is being skipped.
    pub open: bool,
    /// Seconds until the next trial run, when open.
    pub retry_in_secs: Option<u64>,
    pub times_tripped: u64,
    pub last_error: Option<String>,
}

impl HookBreaker {
    /// Whether the hook may run now. Returns `false` while the breaker is open;
    /// after the cool-down exactly one caller gets `true` (the half-open trial).
    #[cfg(test)]
    pub fn allow(&mut self, plugin_id: &str, hook_id: &str, now: Instant) -> bool {
        self.admit(plugin_id, hook_id, now).is_some()
    }

    /// [`Self::allow`], also reporting whether the admission is the half-open
    /// trial: `None` = skip, `Some(true)` = trial, `Some(false)` = closed.
    fn admit(&mut self, plugin_id: &str, hook_id: &str, now: Instant) -> Option<bool> {
        let Some(entry) = self
            .entries
            .get_mut(&(plugin_id.to_owned(), hook_id.to_owned()))
        else {
            return Some(false);
        };
        match entry.open_until {
            None => Some(false),
            Some(until) if now < until => None,
            Some(_) if entry.trial_in_flight => None,
            Some(_) => {
                entry.trial_in_flight = true;
                Some(true)
            }
        }
    }

    /// A half-open trial ended without an outcome (its run was cancelled).
    /// Release the trial slot so the next caller gets a fresh trial; record
    /// nothing, because a cancellation says nothing about the hook's health.
    fn abandon_trial(&mut self, plugin_id: &str, hook_id: &str) {
        if let Some(entry) = self
            .entries
            .get_mut(&(plugin_id.to_owned(), hook_id.to_owned()))
        {
            entry.trial_in_flight = false;
        }
    }

    /// Record a successful run: closes the breaker and forgets the entry.
    pub fn record_success(&mut self, plugin_id: &str, hook_id: &str) {
        let key = (plugin_id.to_owned(), hook_id.to_owned());
        if let Some(entry) = self.entries.remove(&key) {
            if entry.open_until.is_some() {
                tracing::info!(
                    plugin = plugin_id,
                    hook = hook_id,
                    "plugin_host: hook recovered; circuit breaker closed"
                );
            }
        }
    }

    /// Record a failed run. Returns `true` when this failure tripped (or
    /// re-tripped) the breaker, so the caller can log once.
    pub fn record_failure(
        &mut self,
        plugin_id: &str,
        hook_id: &str,
        error: &str,
        now: Instant,
    ) -> bool {
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.retain(|_, entry| entry.open_until.is_some());
        }
        let entry = self
            .entries
            .entry((plugin_id.to_owned(), hook_id.to_owned()))
            .or_default();
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        entry.last_error = Some(error.chars().take(256).collect());
        let was_trial = entry.trial_in_flight;
        entry.trial_in_flight = false;
        if was_trial || entry.consecutive_failures == FAILURE_THRESHOLD {
            entry.open_until = Some(now + COOL_DOWN);
            entry.times_tripped = entry.times_tripped.saturating_add(1);
            return true;
        }
        false
    }

    fn snapshot(&self, now: Instant) -> Vec<BreakerState> {
        let mut rows: Vec<BreakerState> = self
            .entries
            .iter()
            .map(|((plugin_id, hook_id), entry)| {
                let remaining = entry
                    .open_until
                    .map(|until| until.saturating_duration_since(now));
                BreakerState {
                    plugin_id: plugin_id.clone(),
                    hook_id: hook_id.clone(),
                    consecutive_failures: entry.consecutive_failures,
                    open: remaining.is_some_and(|left| !left.is_zero()),
                    retry_in_secs: remaining.map(|left| left.as_secs()),
                    times_tripped: entry.times_tripped,
                    last_error: entry.last_error.clone(),
                }
            })
            .collect();
        rows.sort_by(|a, b| (&a.plugin_id, &a.hook_id).cmp(&(&b.plugin_id, &b.hook_id)));
        rows
    }
}

fn global() -> &'static Mutex<HookBreaker> {
    static BREAKER: OnceLock<Mutex<HookBreaker>> = OnceLock::new();
    BREAKER.get_or_init(|| Mutex::new(HookBreaker::default()))
}

fn with_global<T>(f: impl FnOnce(&mut HookBreaker) -> T) -> T {
    // A poisoned lock only means another thread panicked mid-update; the map is
    // still structurally valid bookkeeping, so keep using it.
    let mut guard = global()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut guard)
}

/// Permission to run one hook, returned by [`allow`]. Settle it with
/// [`Permit::record_success`] or [`Permit::record_failure`]. If it is dropped
/// unsettled (the run's future was cancelled, e.g. a client disconnect dropped
/// a `host.runHook` handler) and it held the half-open trial, the trial slot is
/// released so the hook is not skipped for the rest of the process.
#[must_use = "settle the permit with record_success or record_failure"]
pub struct Permit {
    plugin_id: String,
    hook_id: String,
    trial: bool,
    settled: bool,
}

impl Permit {
    /// Record a successful hook run (process-global breaker).
    pub fn record_success(mut self) {
        self.settled = true;
        record_success(&self.plugin_id, &self.hook_id);
    }

    /// Record a failed hook run, logging once when the breaker trips.
    pub fn record_failure(mut self, error: &str) {
        self.settled = true;
        record_failure(&self.plugin_id, &self.hook_id, error);
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if self.trial && !self.settled {
            with_global(|breaker| breaker.abandon_trial(&self.plugin_id, &self.hook_id));
        }
    }
}

/// Whether `plugin_id::hook_id` may run now (process-global breaker). `None`
/// means skip it; otherwise settle the returned [`Permit`] with the outcome.
pub fn allow(plugin_id: &str, hook_id: &str) -> Option<Permit> {
    let trial = with_global(|breaker| breaker.admit(plugin_id, hook_id, Instant::now()))?;
    Some(Permit {
        plugin_id: plugin_id.to_owned(),
        hook_id: hook_id.to_owned(),
        trial,
        settled: false,
    })
}

fn record_success(plugin_id: &str, hook_id: &str) {
    with_global(|breaker| breaker.record_success(plugin_id, hook_id));
}

fn record_failure(plugin_id: &str, hook_id: &str, error: &str) {
    let tripped =
        with_global(|breaker| breaker.record_failure(plugin_id, hook_id, error, Instant::now()));
    if tripped {
        tracing::warn!(
            plugin = plugin_id,
            hook = hook_id,
            threshold = FAILURE_THRESHOLD,
            cool_down_secs = COOL_DOWN.as_secs(),
            "plugin_host: hook failed repeatedly; circuit breaker open, skipping it until the \
             cool-down elapses"
        );
    }
}

/// Every hook that has failed since its last success, with its breaker state.
pub fn snapshot() -> Vec<BreakerState> {
    with_global(|breaker| breaker.snapshot(Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_after_threshold_and_skips_during_cool_down() {
        let mut breaker = HookBreaker::default();
        let t0 = Instant::now();
        for attempt in 1..FAILURE_THRESHOLD {
            assert!(breaker.allow("p", "h", t0));
            assert!(!breaker.record_failure("p", "h", "boom", t0), "{attempt}");
        }
        assert!(breaker.allow("p", "h", t0));
        assert!(breaker.record_failure("p", "h", "boom", t0), "trips once");
        assert!(!breaker.allow("p", "h", t0));
        assert!(!breaker.allow("p", "h", t0 + COOL_DOWN - Duration::from_secs(1)));
        // Other hooks of the same plugin are unaffected.
        assert!(breaker.allow("p", "other", t0));
        let rows = breaker.snapshot(t0);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].open);
        assert_eq!(rows[0].times_tripped, 1);
    }

    #[test]
    fn half_open_trial_is_single_and_success_resets() {
        let mut breaker = HookBreaker::default();
        let t0 = Instant::now();
        for _ in 0..FAILURE_THRESHOLD {
            breaker.record_failure("p", "h", "boom", t0);
        }
        let later = t0 + COOL_DOWN;
        assert!(breaker.allow("p", "h", later), "first trial runs");
        assert!(!breaker.allow("p", "h", later), "concurrent callers skip");
        breaker.record_success("p", "h");
        assert!(breaker.allow("p", "h", later));
        assert!(breaker.snapshot(later).is_empty());
        // Counter restarted from zero after the success.
        assert!(!breaker.record_failure("p", "h", "boom", later));
    }

    #[test]
    fn failed_trial_reopens_for_a_fresh_cool_down() {
        let mut breaker = HookBreaker::default();
        let t0 = Instant::now();
        for _ in 0..FAILURE_THRESHOLD {
            breaker.record_failure("p", "h", "boom", t0);
        }
        let later = t0 + COOL_DOWN;
        assert!(breaker.allow("p", "h", later));
        assert!(breaker.record_failure("p", "h", "still broken", later));
        assert!(!breaker.allow("p", "h", later + Duration::from_secs(1)));
        let rows = breaker.snapshot(later);
        assert_eq!(rows[0].times_tripped, 2);
        assert_eq!(rows[0].last_error.as_deref(), Some("still broken"));
    }

    #[test]
    fn cancelled_trial_releases_the_slot_without_recording_a_failure() {
        let mut breaker = HookBreaker::default();
        let t0 = Instant::now();
        for _ in 0..FAILURE_THRESHOLD {
            breaker.record_failure("p", "h", "boom", t0);
        }
        let later = t0 + COOL_DOWN;
        assert_eq!(breaker.admit("p", "h", later), Some(true), "trial granted");
        assert!(!breaker.allow("p", "h", later), "trial is single");
        // The trial's run was cancelled (its Permit dropped unsettled).
        breaker.abandon_trial("p", "h");
        assert_eq!(breaker.admit("p", "h", later), Some(true), "fresh trial");
        let rows = breaker.snapshot(later);
        assert_eq!(rows[0].times_tripped, 1, "cancellation is not a failure");
        assert_eq!(rows[0].consecutive_failures, FAILURE_THRESHOLD);
    }

    #[test]
    fn global_permit_dropped_unsettled_releases_the_trial() {
        let (plugin, hook) = ("breaker-test-plugin", "cancelled-trial");
        // The global breaker reads the real clock, so trip it in the past.
        let Some(t0) = Instant::now().checked_sub(COOL_DOWN + Duration::from_secs(1)) else {
            return;
        };
        with_global(|breaker| {
            for _ in 0..FAILURE_THRESHOLD {
                breaker.record_failure(plugin, hook, "boom", t0);
            }
        });
        let permit = allow(plugin, hook).expect("half-open trial");
        assert!(allow(plugin, hook).is_none(), "trial is single");
        drop(permit);
        let permit = allow(plugin, hook).expect("cancelled trial is re-granted");
        permit.record_success();
        assert!(
            with_global(|breaker| breaker.snapshot(Instant::now()))
                .iter()
                .all(|row| row.plugin_id != plugin),
            "the re-granted trial's success closed the breaker"
        );
    }

    #[test]
    fn success_before_threshold_resets_the_counter() {
        let mut breaker = HookBreaker::default();
        let t0 = Instant::now();
        for _ in 0..FAILURE_THRESHOLD - 1 {
            breaker.record_failure("p", "h", "boom", t0);
        }
        breaker.record_success("p", "h");
        for _ in 0..FAILURE_THRESHOLD - 1 {
            assert!(!breaker.record_failure("p", "h", "boom", t0));
        }
        assert!(breaker.allow("p", "h", t0));
    }
}

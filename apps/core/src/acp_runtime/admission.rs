//! The global admission gate: permits, the first-come-first-served queue, and
//! evicting idle instances to make room for queued turns.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::config::settings;
use super::{runtime_state, AcpAdmission};
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
pub(super) fn evictions_in_flight() -> u32 {
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
pub(super) fn eviction_min_idle(waited: Duration, limit: u32) -> Duration {
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

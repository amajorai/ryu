//! Concurrency admission control for the scarce **local** inference engine.
//!
//! The local engine (one resident llama.cpp / ollama / … server) batches a
//! fixed number of requests per decode loop (`--parallel N` slots). Sending more
//! than N concurrent requests just makes llama-server queue them internally in
//! FIFO order — which means a burst of **background** fan-out (delegate / threads
//! / scheduler / monitors) submitted before an **interactive** chat turn would
//! make the user wait behind the batch jobs.
//!
//! This module is the fix: a per-provider priority admission gate. It admits at
//! most `max_in_flight` requests to the local provider at once (size it to the
//! engine's slot count so every slot is busy and llama-server's own FIFO stays
//! empty), queues the rest up to `max_queued`, and **serves interactive waiters
//! ahead of background ones**. When the queue is full, new requests are rejected
//! with `engine_overloaded` rather than piling up unbounded.
//!
//! It mirrors the structure of [`crate::rate_limit`] / [`crate::circuit_breaker`]
//! (a state holder keyed by provider name, swapped-on-restart config) but is a
//! *concurrency* primitive, not a token bucket or failure counter. Remote
//! providers are never gated — they scale elastically upstream.
//!
//! Placement: this governs a *shared* resource, which is a Gateway concern
//! (§ Core-vs-Gateway). Core only stamps the `x-ryu-priority` header and sets the
//! engine's slot count.

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};

use dashmap::DashMap;
use tokio::sync::oneshot;

use crate::config::ConcurrencyConfig;

/// Request priority, parsed from the `x-ryu-priority` header Core stamps.
///
/// Interactive is the default: a user is waiting on the other end, so an
/// unlabelled request (old clients, remote providers, direct callers) is treated
/// as interactive and never penalised. Background must be opted into explicitly
/// by Core for fan-out work that no human is blocking on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Priority {
    /// A user-facing turn — someone is waiting. Jumps ahead of background.
    #[default]
    Interactive,
    /// Fan-out / scheduled / monitor work — no human blocked on it.
    Background,
}

impl Priority {
    /// Parse the `x-ryu-priority` header value. Anything that isn't an explicit
    /// background marker is interactive (fail-safe toward the waiting user).
    pub fn from_header(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("background") | Some("low") | Some("batch") => Self::Background,
            _ => Self::Interactive,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Background => "background",
        }
    }
}

/// A held admission slot. The occupied slot is released when this is dropped
/// (end of the request for non-streaming, end of the SSE stream for streaming —
/// the caller is responsible for keeping it alive that long). An *ungated*
/// permit (remote provider, or gating disabled) does nothing on drop.
pub struct AdmissionPermit {
    gate: Option<Arc<ProviderGate>>,
}

impl AdmissionPermit {
    /// An ungated permit — drop is a no-op. Use for remote providers, disabled
    /// gating, or when the caller deliberately skips admission (e.g. the
    /// re-entrant tool-loop path, which must not hold a slot while a child
    /// request needs one).
    pub fn none() -> Self {
        Self { gate: None }
    }

    fn held(gate: Arc<ProviderGate>) -> Self {
        Self { gate: Some(gate) }
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.release();
        }
    }
}

/// Returned when the admission queue for a provider is full.
#[derive(Debug, Clone)]
pub struct QueueFull {
    pub provider: String,
    pub queued: u32,
}

struct GateState {
    in_flight: u32,
    /// FIFO of interactive waiters, served first.
    interactive: VecDeque<oneshot::Sender<()>>,
    /// FIFO of background waiters, served only when no interactive waiter waits.
    background: VecDeque<oneshot::Sender<()>>,
}

/// Per-provider admission gate: a priority-aware async semaphore. A slot is
/// "handed off" directly from a finishing request to the next waiter (in_flight
/// stays constant on hand-off), so the in-flight count never exceeds
/// `max_in_flight` and there is no thundering herd.
struct ProviderGate {
    name: String,
    max_in_flight: u32,
    max_queued: u32,
    state: Mutex<GateState>,
    /// Live queue depth, exposed for observability without taking the lock.
    queued_total: AtomicU32,
}

impl ProviderGate {
    fn new(name: String, max_in_flight: u32, max_queued: u32) -> Self {
        Self {
            name,
            max_in_flight,
            max_queued,
            state: Mutex::new(GateState {
                in_flight: 0,
                interactive: VecDeque::new(),
                background: VecDeque::new(),
            }),
            queued_total: AtomicU32::new(0),
        }
    }

    /// Either reserve a slot immediately (`Ok(None)`), enqueue and return a
    /// receiver to await our turn (`Ok(Some(rx))`), or reject (`Err`).
    fn try_acquire_or_enqueue(
        &self,
        prio: Priority,
    ) -> Result<Option<oneshot::Receiver<()>>, QueueFull> {
        let mut g = self.state.lock().expect("admission gate lock poisoned");
        if g.in_flight < self.max_in_flight {
            g.in_flight += 1;
            return Ok(None);
        }
        let queued = (g.interactive.len() + g.background.len()) as u32;
        if queued >= self.max_queued {
            return Err(QueueFull {
                provider: self.name.clone(),
                queued,
            });
        }
        let (tx, rx) = oneshot::channel();
        match prio {
            Priority::Interactive => g.interactive.push_back(tx),
            Priority::Background => g.background.push_back(tx),
        }
        self.queued_total.store(
            (g.interactive.len() + g.background.len()) as u32,
            Ordering::Relaxed,
        );
        Ok(Some(rx))
    }

    /// Release a held slot: hand it to the highest-priority live waiter, or
    /// decrement in_flight if none are waiting. Skips waiters whose receiver was
    /// dropped (request cancelled while queued).
    fn release(&self) {
        let mut g = self.state.lock().expect("admission gate lock poisoned");
        loop {
            let next = g
                .interactive
                .pop_front()
                .or_else(|| g.background.pop_front());
            match next {
                Some(tx) => {
                    // Successful hand-off keeps in_flight constant (one left, one
                    // entered). A dead receiver (cancelled) frees nothing — keep
                    // looking for a live waiter.
                    if tx.send(()).is_ok() {
                        self.queued_total.store(
                            (g.interactive.len() + g.background.len()) as u32,
                            Ordering::Relaxed,
                        );
                        return;
                    }
                }
                None => {
                    g.in_flight = g.in_flight.saturating_sub(1);
                    self.queued_total.store(0, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    fn snapshot(&self) -> GateSnapshot {
        let g = self.state.lock().expect("admission gate lock poisoned");
        GateSnapshot {
            provider: self.name.clone(),
            in_flight: g.in_flight,
            max_in_flight: self.max_in_flight,
            queued: (g.interactive.len() + g.background.len()) as u32,
            queued_interactive: g.interactive.len() as u32,
            queued_background: g.background.len() as u32,
            max_queued: self.max_queued,
        }
    }
}

/// A point-in-time view of one provider's admission gate, for the status surface.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GateSnapshot {
    pub provider: String,
    pub in_flight: u32,
    pub max_in_flight: u32,
    pub queued: u32,
    pub queued_interactive: u32,
    pub queued_background: u32,
    pub max_queued: u32,
}

/// The admission limiter. Holds one [`ProviderGate`] per gated provider, created
/// lazily on first use. Today only the `local` provider is gated; the structure
/// generalises to a per-provider config map later.
pub struct ConcurrencyLimiter {
    enabled: bool,
    local_max_in_flight: u32,
    local_max_queued: u32,
    gates: DashMap<String, Arc<ProviderGate>>,
}

/// The provider name that is admission-gated (the resident local engine).
const LOCAL_PROVIDER: &str = "local";

impl ConcurrencyLimiter {
    pub fn new(config: &ConcurrencyConfig) -> Self {
        Self {
            enabled: config.enabled,
            local_max_in_flight: config.local_max_in_flight,
            local_max_queued: config.local_max_queued,
            gates: DashMap::new(),
        }
    }

    /// The gate for `provider`, or `None` when the provider isn't gated (remote
    /// providers, gating disabled, or `max_in_flight == 0`).
    fn gate_for(&self, provider: &str) -> Option<Arc<ProviderGate>> {
        if !self.enabled || provider != LOCAL_PROVIDER || self.local_max_in_flight == 0 {
            return None;
        }
        if let Some(g) = self.gates.get(provider) {
            return Some(Arc::clone(g.value()));
        }
        let gate = Arc::new(ProviderGate::new(
            provider.to_string(),
            self.local_max_in_flight,
            self.local_max_queued,
        ));
        self.gates
            .entry(provider.to_string())
            .or_insert(gate)
            .value()
            .clone()
            .into()
    }

    /// Acquire admission for a request to `provider` at `prio`. For an ungated
    /// provider this returns immediately. For the gated local provider it either
    /// reserves a slot, or waits (interactive ahead of background) until one
    /// frees, or returns [`QueueFull`] if too many already wait.
    ///
    /// The returned permit must be held for the *whole* request — through stream
    /// end on the streaming path — so a generation in progress still counts
    /// against the slot budget.
    pub async fn acquire(
        &self,
        provider: &str,
        prio: Priority,
    ) -> Result<AdmissionPermit, QueueFull> {
        let Some(gate) = self.gate_for(provider) else {
            return Ok(AdmissionPermit::none());
        };
        // Verifiable on-path signal: this fires iff a real request reached the
        // gated local provider. `RUST_LOG=ryu_gateway::concurrency=debug` to watch
        // the queue engage under load.
        tracing::debug!(
            provider = %gate.name,
            priority = prio.as_str(),
            "admission: gated acquire"
        );
        match gate.try_acquire_or_enqueue(prio)? {
            None => Ok(AdmissionPermit::held(gate)),
            Some(rx) => {
                // Wait for a finishing request to hand us a slot. A send error
                // would mean the gate was torn down (never happens while a
                // request is live); treat it as acquired to avoid a deadlock.
                let _ = rx.await;
                tracing::debug!(
                    provider = %gate.name,
                    priority = prio.as_str(),
                    "admission: slot acquired after wait"
                );
                Ok(AdmissionPermit::held(gate))
            }
        }
    }

    /// Live snapshots of every active gate, for the observability surface.
    pub fn snapshots(&self) -> Vec<GateSnapshot> {
        self.gates.iter().map(|g| g.value().snapshot()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(max_in_flight: u32, max_queued: u32) -> ConcurrencyConfig {
        ConcurrencyConfig {
            enabled: true,
            local_max_in_flight: max_in_flight,
            local_max_queued: max_queued,
        }
    }

    #[test]
    fn priority_header_parses_background_else_interactive() {
        assert_eq!(
            Priority::from_header(Some("background")),
            Priority::Background
        );
        assert_eq!(Priority::from_header(Some(" LOW ")), Priority::Background);
        assert_eq!(
            Priority::from_header(Some("interactive")),
            Priority::Interactive
        );
        assert_eq!(
            Priority::from_header(Some("anything")),
            Priority::Interactive
        );
        // Unlabelled ⇒ interactive (never penalise a request we can't classify).
        assert_eq!(Priority::from_header(None), Priority::Interactive);
    }

    #[tokio::test]
    async fn remote_provider_is_never_gated() {
        let lim = ConcurrencyLimiter::new(&cfg(1, 0));
        // Many concurrent acquires on a non-local provider all succeed instantly.
        for _ in 0..10 {
            let p = lim
                .acquire("openrouter", Priority::Background)
                .await
                .unwrap();
            drop(p);
        }
        assert!(lim.snapshots().is_empty(), "no gate created for remote");
    }

    #[tokio::test]
    async fn admits_up_to_slot_count_then_queues() {
        let lim = Arc::new(ConcurrencyLimiter::new(&cfg(2, 8)));
        let p1 = lim
            .acquire(LOCAL_PROVIDER, Priority::Interactive)
            .await
            .unwrap();
        let p2 = lim
            .acquire(LOCAL_PROVIDER, Priority::Interactive)
            .await
            .unwrap();
        // Two slots full; a third acquire must block until one frees.
        let lim2 = Arc::clone(&lim);
        let waiter = tokio::spawn(async move {
            lim2.acquire(LOCAL_PROVIDER, Priority::Interactive)
                .await
                .unwrap()
        });
        // Give the waiter a chance to enqueue.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!waiter.is_finished(), "third request must wait for a slot");
        drop(p1); // frees a slot → waiter proceeds
        let p3 = waiter.await.unwrap();
        drop(p2);
        drop(p3);
    }

    #[tokio::test]
    async fn interactive_jumps_ahead_of_background() {
        let lim = Arc::new(ConcurrencyLimiter::new(&cfg(1, 8)));
        // Occupy the single slot.
        let held = lim
            .acquire(LOCAL_PROVIDER, Priority::Interactive)
            .await
            .unwrap();

        // Enqueue a background waiter first, then an interactive one.
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (lb, oi) = (Arc::clone(&lim), Arc::clone(&order));
        let bg = tokio::spawn(async move {
            let _p = lb
                .acquire(LOCAL_PROVIDER, Priority::Background)
                .await
                .unwrap();
            oi.lock().unwrap().push("background");
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let (li, oj) = (Arc::clone(&lim), Arc::clone(&order));
        let inter = tokio::spawn(async move {
            let _p = li
                .acquire(LOCAL_PROVIDER, Priority::Interactive)
                .await
                .unwrap();
            oj.lock().unwrap().push("interactive");
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Release the slot once: the interactive waiter (enqueued *after* the
        // background one) must be served first.
        drop(held);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(order.lock().unwrap().first().copied(), Some("interactive"));
        let _ = tokio::join!(bg, inter);
    }

    #[tokio::test]
    async fn rejects_when_queue_is_full() {
        let lim = Arc::new(ConcurrencyLimiter::new(&cfg(1, 1)));
        let _held = lim
            .acquire(LOCAL_PROVIDER, Priority::Interactive)
            .await
            .unwrap();
        // One waiter fills the single queue slot.
        let lim2 = Arc::clone(&lim);
        let _waiter =
            tokio::spawn(async move { lim2.acquire(LOCAL_PROVIDER, Priority::Background).await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // Next acquire overflows the queue → rejected.
        let err = lim.acquire(LOCAL_PROVIDER, Priority::Interactive).await;
        assert!(err.is_err(), "overflow must reject with QueueFull");
    }

    #[tokio::test]
    async fn snapshot_reports_in_flight_and_queue() {
        let lim = ConcurrencyLimiter::new(&cfg(1, 8));
        let _p = lim
            .acquire(LOCAL_PROVIDER, Priority::Interactive)
            .await
            .unwrap();
        let snap = lim.snapshots();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].in_flight, 1);
        assert_eq!(snap[0].max_in_flight, 1);
        assert_eq!(snap[0].queued, 0);
    }
}

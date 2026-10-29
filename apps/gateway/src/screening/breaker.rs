//! Per-backend circuit breaker (screener addendum section 6): more than 20%
//! failures over 30 s opens the breaker for 30 s, per backend per replica.
//!
//! [`Breakered`] wraps a backend so an open breaker answers at once with
//! `Unavailable("breaker_open")` and sends nothing. The breaker is a
//! screening state only: it never touches a provider circuit, and a failed
//! screen is never a provider health signal (spec 00.11).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use ryu_gw_screening::{
    BackendDescriptor, BackendError, BackendHealth, BackendVerdict, ScreenRequest, ScreenTier,
    ScreenerBackend,
};

/// The failure-rate window.
pub const WINDOW: Duration = Duration::from_secs(30);
/// How long an opened breaker stays open before a trial call.
pub const OPEN_FOR: Duration = Duration::from_secs(30);
/// The failure share above which the breaker opens.
pub const FAILURE_SHARE: f64 = 0.2;
/// Calls the window needs before the share is judged, so one slow request
/// on an idle replica does not open the breaker.
pub const MIN_SAMPLES: usize = 5;

/// What the breaker reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    Closed,
    Open,
    /// The open period passed; the next call is a trial.
    HalfOpen,
}

impl BreakerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::HalfOpen => "half_open",
        }
    }
}

/// The last readiness probe.
#[derive(Debug, Clone)]
pub struct ProbeRecord {
    pub at: std::time::SystemTime,
    pub health: BackendHealth,
}

#[derive(Debug, Default)]
struct Inner {
    samples: VecDeque<(Instant, bool)>,
    opened_at: Option<Instant>,
    last_probe: Option<ProbeRecord>,
    /// Transitions not yet published as `screening_degraded` events.
    pending: Vec<BreakerState>,
}

/// One backend's breaker.
#[derive(Debug, Default)]
pub struct Breaker {
    inner: Mutex<Inner>,
}

impl Breaker {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn state(&self) -> BreakerState {
        let inner = self.lock();
        match inner.opened_at {
            None => BreakerState::Closed,
            Some(at) if at.elapsed() < OPEN_FOR => BreakerState::Open,
            Some(_) => BreakerState::HalfOpen,
        }
    }

    /// Whether a call may go out now (closed, or a half-open trial).
    pub fn allows(&self) -> bool {
        self.state() != BreakerState::Open
    }

    /// Record a call's outcome. A failure in the half-open state reopens at
    /// once; a success closes.
    pub fn record(&self, ok: bool) {
        let now = Instant::now();
        let mut inner = self.lock();
        while inner
            .samples
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > WINDOW)
        {
            inner.samples.pop_front();
        }
        inner.samples.push_back((now, ok));
        match inner.opened_at {
            Some(at) if at.elapsed() >= OPEN_FOR => {
                if ok {
                    inner.opened_at = None;
                    inner.samples.clear();
                    inner.pending.push(BreakerState::Closed);
                } else {
                    inner.opened_at = Some(now);
                    inner.pending.push(BreakerState::Open);
                }
            }
            Some(_) => {}
            None => {
                let total = inner.samples.len();
                let failed = inner.samples.iter().filter(|(_, ok)| !ok).count();
                if total >= MIN_SAMPLES && failed as f64 / total as f64 > FAILURE_SHARE {
                    inner.opened_at = Some(now);
                    inner.pending.push(BreakerState::Open);
                }
            }
        }
    }

    /// Open now (an engine down at boot, a failed readiness probe).
    pub fn force_open(&self) {
        let mut inner = self.lock();
        if inner.opened_at.is_none() {
            inner.pending.push(BreakerState::Open);
        }
        inner.opened_at = Some(Instant::now());
    }

    pub fn record_probe(&self, health: BackendHealth) {
        let ready = health == BackendHealth::Ready;
        {
            let mut inner = self.lock();
            inner.last_probe = Some(ProbeRecord {
                at: std::time::SystemTime::now(),
                health,
            });
        }
        if ready {
            // A ready probe is a trial success only once the open period has
            // passed; it never shortens the open period.
            if self.state() == BreakerState::HalfOpen {
                self.record(true);
            }
        } else {
            self.force_open();
        }
    }

    pub fn last_probe(&self) -> Option<ProbeRecord> {
        self.lock().last_probe.clone()
    }

    /// Transitions since the last call, oldest first.
    pub fn take_transitions(&self) -> Vec<BreakerState> {
        std::mem::take(&mut self.lock().pending)
    }
}

/// A backend behind its breaker.
pub struct Breakered {
    inner: Arc<dyn ScreenerBackend>,
    pub breaker: Breaker,
}

impl Breakered {
    pub fn new(inner: Arc<dyn ScreenerBackend>) -> Self {
        Self {
            inner,
            breaker: Breaker::default(),
        }
    }
}

#[async_trait::async_trait]
impl ScreenerBackend for Breakered {
    fn descriptor(&self) -> &BackendDescriptor {
        self.inner.descriptor()
    }

    fn permits(&self, tier: ScreenTier) -> bool {
        self.inner.permits(tier)
    }

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError> {
        if !self.breaker.allows() {
            return Err(BackendError::Unavailable("breaker_open"));
        }
        let result = self.inner.screen(req).await;
        match &result {
            Ok(_) => self.breaker.record(true),
            Err(BackendError::Timeout | BackendError::Unavailable(_) | BackendError::Malformed) => {
                self.breaker.record(false)
            }
            // Not a statement about the engine's health.
            Err(BackendError::NotPermitted | BackendError::OverCapacity) => {}
        }
        result
    }

    async fn probe(&self) -> BackendHealth {
        self.inner.probe().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_above_the_failure_share_and_not_on_one_failure() {
        let breaker = Breaker::default();
        breaker.record(false);
        assert_eq!(breaker.state(), BreakerState::Closed);
        for _ in 0..3 {
            breaker.record(true);
        }
        assert_eq!(breaker.state(), BreakerState::Closed);
        breaker.record(false);
        assert_eq!(breaker.state(), BreakerState::Open);
        assert_eq!(breaker.take_transitions(), vec![BreakerState::Open]);
        assert!(breaker.take_transitions().is_empty());
    }

    #[test]
    fn a_failed_probe_opens_and_a_ready_probe_does_not_shorten_it() {
        let breaker = Breaker::default();
        breaker.record_probe(BackendHealth::Down("refused"));
        assert_eq!(breaker.state(), BreakerState::Open);
        breaker.record_probe(BackendHealth::Ready);
        assert_eq!(breaker.state(), BreakerState::Open);
        assert!(breaker.last_probe().is_some());
    }
}
